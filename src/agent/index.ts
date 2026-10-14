/**
 * A minimal Personal Agent client for Poppy draft 0.1. Used by the conformance tests and the demo,
 * and usable as the starting point for a real personal agent.
 */
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK, type CryptoKey as JoseCryptoKey } from 'jose';
import { ClientAssertionType, GrantType, Header, JwtTyp, OAuthError, SigningAlg, TokenType } from '../constants.js';
import { validateOAuthServerMetadata, validatePoppyDocument } from '../discovery.js';
import type { AgentMessage, ClientMetadata, ConversationEvent, OAuthServerMetadata, PoppyDocument } from '../types.js';

export interface AgentKeys {
  privateKey: JoseCryptoKey;
  publicJwk: JWK;
  kid: string;
}

export async function generateAgentKeys(): Promise<AgentKeys> {
  const { privateKey, publicKey } = await generateKeyPair(SigningAlg.ES256, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = SigningAlg.ES256;
  publicJwk.use = 'sig';
  return { privateKey: privateKey as JoseCryptoKey, publicJwk, kid };
}

export interface PoppyAgentOptions {
  clientId: string;
  clientName: string;
  redirectUris?: string[];
  logoUri?: string;
  keys: AgentKeys;
  extensions?: Record<string, { version: string }>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Company {
  domain: string;
  document: PoppyDocument;
  oauth: OAuthServerMetadata;
}

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
  sessionId: string;
  signedIn: boolean;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
}

export class PoppyAgentError extends Error {
  constructor(readonly status: number, readonly code: string, readonly body: Record<string, unknown>, readonly headers: Headers) {
    super(`${code} (HTTP ${status})`);
    this.name = 'PoppyAgentError';
  }
}

export class PoppyAgent {
  readonly clientId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: PoppyAgentOptions) {
    this.clientId = opts.clientId;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? (() => Date.now());
  }

  /** The client metadata document to publish at client_id (spec 4.1). */
  metadataDocument(): ClientMetadata {
    const base = new URL(this.clientId);
    const doc: ClientMetadata = {
      client_id: this.clientId,
      client_name: this.opts.clientName,
      jwks_uri: new URL('/jwks.json', base).toString(),
      redirect_uris: this.opts.redirectUris ?? [new URL('/oauth/callback', base).toString()],
      token_endpoint_auth_method: 'private_key_jwt',
    };
    if (this.opts.logoUri) doc.logo_uri = this.opts.logoUri;
    if (this.opts.extensions) doc.extensions = this.opts.extensions;
    return doc;
  }

  jwks(): { keys: JWK[] } {
    return { keys: [this.opts.keys.publicJwk] };
  }

  /** Discovery (spec 3 and 3.2): fetch poppy.json, then the issuer's metadata, and cross-check both. */
  async discover(domain: string, options: { allowHttp?: boolean } = {}): Promise<Company> {
    const scheme = options.allowHttp ? 'http' : 'https';
    const url = `${scheme}://${domain}/.well-known/poppy.json`;
    const res = await this.fetchImpl(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`poppy.json returned HTTP ${res.status}`);
    const doc = validatePoppyDocument(await res.json(), domain, options);
    if (!doc.ok) throw new Error('invalid poppy.json: ' + doc.errors.join('; '));
    if (!doc.value.auth) throw new Error('company offers no sessions (no auth)');
    const mdRes = await this.fetchImpl(new URL('/.well-known/oauth-authorization-server', doc.value.auth.issuer).toString());
    if (!mdRes.ok) throw new Error(`oauth metadata returned HTTP ${mdRes.status}`);
    const md = validateOAuthServerMetadata(await mdRes.json(), doc.value.auth.issuer, domain, options);
    if (!md.ok) throw new Error('invalid oauth metadata: ' + md.errors.join('; '));
    return { domain, document: doc.value, oauth: md.value };
  }

  /** One user's activity at one company. Holds the DPoP key for that pair. */
  async session(company: Company, userId: string): Promise<AgentSession> {
    const { privateKey, publicKey } = await generateKeyPair(SigningAlg.ES256, { extractable: true });
    const dpopJwk = await exportJWK(publicKey);
    return new AgentSession(this, company, userId, { privateKey: privateKey as JoseCryptoKey, publicJwk: dpopJwk }, this.fetchImpl, this.now);
  }

  /** @internal */
  async signAssertion(claims: { sub: string; aud: string; typ?: string; extra?: Record<string, unknown>; lifetime?: number }): Promise<string> {
    const nowSec = Math.floor(this.now() / 1000);
    const b = new SignJWT({ ...claims.extra })
      .setProtectedHeader({ alg: SigningAlg.ES256, kid: this.opts.keys.kid, ...(claims.typ ? { typ: claims.typ } : {}) })
      .setIssuer(this.clientId)
      .setSubject(claims.sub)
      .setAudience(claims.aud)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + (claims.lifetime ?? 60))
      .setJti(randomBytes(16).toString('base64url'));
    return b.sign(this.opts.keys.privateKey);
  }

  clientAssertion(tokenEndpoint: string): Promise<string> {
    return this.signAssertion({ sub: this.clientId, aud: tokenEndpoint });
  }
}

interface DpopKey {
  privateKey: JoseCryptoKey;
  publicJwk: JWK;
}

export interface ConversationRead {
  conversation_id: string;
  events: ConversationEvent[];
  cursor: string | null;
  has_more: boolean;
  status: string;
  responder: string;
}

export class AgentSession {
  sessionId?: string;
  accessToken?: string;
  tokenType: string = TokenType.DPoP;
  scope = '';
  signedIn = false;
  accountToken?: string;
  private nonces = new Map<string, string>();

  constructor(
    readonly agent: PoppyAgent,
    readonly company: Company,
    readonly userId: string,
    private readonly dpop: DpopKey,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number,
  ) {}

  private get issuer(): string {
    return this.company.oauth.issuer;
  }

  async dpopProof(method: string, url: string, accessToken?: string, nonce?: string): Promise<string> {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    const claims: Record<string, unknown> = { htm: method.toUpperCase(), htu: u.toString() };
    if (accessToken) claims.ath = createHash('sha256').update(accessToken).digest('base64url');
    if (nonce) claims.nonce = nonce;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: SigningAlg.ES256, typ: JwtTyp.DPoP, jwk: this.dpop.publicJwk })
      .setIssuedAt(Math.floor(this.now() / 1000))
      .setJti(randomBytes(16).toString('base64url'))
      .sign(this.dpop.privateKey);
  }

  private async tokenRequest(params: Record<string, string>, opts: { dpop?: boolean } = {}): Promise<TokenSet> {
    const endpoint = this.company.oauth.token_endpoint;
    const body = new URLSearchParams({
      ...params,
      client_id: this.agent.clientId,
      client_assertion_type: ClientAssertionType,
      client_assertion: await this.agent.clientAssertion(endpoint),
    });
    const useDpop = opts.dpop ?? true;
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (useDpop) headers.DPoP = await this.dpopProof('POST', endpoint, undefined, this.nonces.get(endpoint));
    let res = await this.fetchImpl(endpoint, { method: 'POST', headers, body });
    if (res.status === 400 && useDpop) {
      const clone = res.clone();
      const err = (await clone.json().catch(() => ({}))) as { error?: string };
      const nonce = res.headers.get(Header.DPoPNonce);
      if (err.error === OAuthError.UseDpopNonce && nonce) {
        this.nonces.set(endpoint, nonce);
        const retry = new URLSearchParams({ ...params, client_id: this.agent.clientId, client_assertion_type: ClientAssertionType, client_assertion: await this.agent.clientAssertion(endpoint) });
        headers.DPoP = await this.dpopProof('POST', endpoint, undefined, nonce);
        res = await this.fetchImpl(endpoint, { method: 'POST', headers, body: retry });
      }
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new PoppyAgentError(res.status, String(json.error ?? 'error'), json, res.headers);
    const set: TokenSet = {
      accessToken: String(json.access_token),
      tokenType: String(json.token_type),
      expiresIn: Number(json.expires_in),
      scope: String(json.scope ?? ''),
      sessionId: String(json.session_id),
      signedIn: Boolean(json.signed_in),
    };
    if (typeof json.refresh_token === 'string') set.refreshToken = json.refresh_token;
    if (typeof json.refresh_token_expires_in === 'number') set.refreshTokenExpiresIn = json.refresh_token_expires_in;
    return set;
  }

  private adopt(set: TokenSet): TokenSet {
    this.sessionId = set.sessionId;
    this.accessToken = set.accessToken;
    this.tokenType = set.tokenType;
    this.scope = set.scope;
    this.signedIn = set.signedIn;
    if (set.refreshToken) this.accountToken = set.refreshToken;
    return set;
  }

  /** Start a session, or renew the signed-out token for the current one (spec 4.2). */
  async start(): Promise<TokenSet> {
    const assertion = await this.agent.signAssertion({ sub: this.userId, aud: this.company.oauth.token_endpoint });
    const params: Record<string, string> = { grant_type: GrantType.JwtBearer, assertion };
    if (this.sessionId) params.session_id = this.sessionId;
    return this.adopt(await this.tokenRequest(params));
  }

  /** Use the account token to get a signed-in token for this session, or a new signed-in session (spec 4.8). */
  async refresh(opts: { scopes?: string[]; newSession?: boolean; resource?: string; bearer?: boolean } = {}): Promise<TokenSet> {
    if (!this.accountToken) throw new Error('no account token');
    const params: Record<string, string> = { grant_type: GrantType.RefreshToken, refresh_token: this.accountToken };
    if (this.sessionId && !opts.newSession) params.session_id = this.sessionId;
    if (opts.scopes) params.scope = opts.scopes.join(' ');
    if (opts.resource) params.resource = opts.resource;
    const set = await this.tokenRequest(params, { dpop: !opts.bearer });
    if (opts.bearer) return set;
    return this.adopt(set);
  }

  /** Bearer token for one MCP server (spec 4.3 "Bearer tokens"). */
  async bearerTokenFor(resource: string, scopes?: string[]): Promise<TokenSet> {
    if (this.accountToken) return this.refresh({ resource, bearer: true, ...(scopes ? { scopes } : {}) });
    const assertion = await this.agent.signAssertion({ sub: this.userId, aud: this.company.oauth.token_endpoint });
    const params: Record<string, string> = { grant_type: GrantType.JwtBearer, assertion, resource };
    if (this.sessionId) params.session_id = this.sessionId;
    return this.tokenRequest(params, { dpop: false });
  }

  /* ---------- Direct sign-in (spec 4.5) ---------- */

  directSignIn(scopes: string[], redirectUri?: string): { url: string; state: string; verifier: string; redirectUri: string } {
    const endpoint = this.company.oauth.authorization_endpoint;
    if (!endpoint) throw new Error('company does not offer direct sign-in');
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirect = redirectUri ?? this.agent.metadataDocument().redirect_uris?.[0] ?? '';
    const u = new URL(endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.agent.clientId);
    u.searchParams.set('redirect_uri', redirect);
    u.searchParams.set('scope', scopes.join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return { url: u.toString(), state, verifier, redirectUri: redirect };
  }

  async exchangeCode(callbackUrl: string, pending: { state: string; verifier: string; redirectUri: string }): Promise<TokenSet> {
    const u = new URL(callbackUrl);
    if (u.searchParams.get('state') !== pending.state) throw new Error('state mismatch');
    if (u.searchParams.get('iss') !== this.issuer) throw new Error('iss mismatch');
    const error = u.searchParams.get('error');
    if (error) throw new PoppyAgentError(400, error, { error }, new Headers());
    const code = u.searchParams.get('code') ?? '';
    if (!this.sessionId) await this.start();
    return this.adopt(
      await this.tokenRequest({
        grant_type: GrantType.AuthorizationCode,
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
        session_id: this.sessionId ?? '',
      }),
    );
  }

  /* ---------- Device sign-in (spec 4.6) ---------- */

  async deviceStart(scopes: string[]): Promise<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }> {
    const endpoint = this.company.oauth.device_authorization_endpoint;
    if (!endpoint) throw new Error('company does not offer device sign-in');
    const body = new URLSearchParams({
      scope: scopes.join(' '),
      client_id: this.agent.clientId,
      client_assertion_type: ClientAssertionType,
      client_assertion: await this.agent.clientAssertion(endpoint),
    });
    const res = await this.fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new PoppyAgentError(res.status, String(json.error), json, res.headers);
    return json as never;
  }

  /** One poll of the token endpoint. Throws PoppyAgentError authorization_pending or slow_down until done. */
  async devicePoll(deviceCode: string): Promise<TokenSet> {
    if (!this.sessionId) await this.start();
    return this.adopt(await this.tokenRequest({ grant_type: GrantType.DeviceCode, device_code: deviceCode, session_id: this.sessionId ?? '' }));
  }

  /* ---------- Mediated sign-in (spec 4.7) ---------- */

  async mediatedSignIn(scopes: string[], credentials: Record<string, string>): Promise<Record<string, unknown>> {
    const endpoint = this.company.document.auth?.mediated?.endpoint;
    if (!endpoint) throw new Error('company does not offer mediated sign-in');
    const res = await this.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: scopes.join(' '), credentials }) });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new PoppyAgentError(res.status, String(json.error), json, res.headers);
    if (json.status === 'complete') this.adoptMediated(json);
    return json;
  }

  async mediatedCode(signInId: string, code: string): Promise<Record<string, unknown>> {
    const endpoint = this.company.document.auth?.mediated?.endpoint;
    if (!endpoint) throw new Error('company does not offer mediated sign-in');
    const res = await this.fetch(`${endpoint}/${signInId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new PoppyAgentError(res.status, String(json.error), json, res.headers);
    if (json.status === 'complete') this.adoptMediated(json);
    return json;
  }

  private adoptMediated(json: Record<string, unknown>): void {
    const set: TokenSet = {
      accessToken: String(json.access_token),
      tokenType: String(json.token_type),
      expiresIn: Number(json.expires_in),
      scope: String(json.scope ?? ''),
      sessionId: String(json.session_id),
      signedIn: true,
    };
    if (typeof json.refresh_token === 'string') set.refreshToken = json.refresh_token;
    this.adopt(set);
  }

  /* ---------- Sign out (spec 4.9) ---------- */

  async signOut(): Promise<void> {
    if (!this.accountToken) return;
    const endpoint = this.company.oauth.revocation_endpoint;
    const body = new URLSearchParams({
      token: this.accountToken,
      token_type_hint: 'refresh_token',
      client_id: this.agent.clientId,
      client_assertion_type: ClientAssertionType,
      client_assertion: await this.agent.clientAssertion(endpoint),
    });
    const res = await this.fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new PoppyAgentError(res.status, 'revocation_failed', {}, res.headers);
    delete this.accountToken;
    this.signedIn = false;
  }

  /* ---------- Requests with the session token (spec 4.3) ---------- */

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (!this.accessToken) await this.start();
    const method = (init.method ?? 'GET').toUpperCase();
    const send = async (nonce?: string): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `${this.tokenType} ${this.accessToken}`);
      if (this.tokenType === TokenType.DPoP) headers.set('dpop', await this.dpopProof(method, url, this.accessToken, nonce));
      return this.fetchImpl(url, { ...init, method, headers });
    };
    const origin = new URL(url).origin;
    let res = await send(this.nonces.get(origin));
    const nonce = res.headers.get(Header.DPoPNonce);
    if (nonce && (res.status === 401 || res.status === 400) && /use_dpop_nonce/.test(res.headers.get(Header.WWWAuthenticate) ?? '')) {
      this.nonces.set(origin, nonce);
      res = await send(nonce);
    }
    return res;
  }

  /* ---------- Browser session (spec section 5) ---------- */

  async browserAssertion(returnTo: string): Promise<string> {
    const endpoint = this.company.document.web?.browser_session_endpoint;
    if (!endpoint) throw new Error('company does not offer browser sessions');
    if (!this.sessionId) await this.start();
    return this.agent.signAssertion({ sub: this.userId, aud: endpoint, typ: JwtTyp.BrowserAssertion, extra: { session_id: this.sessionId, return_to: returnTo }, lifetime: 60 });
  }

  /* ---------- Conversations (spec section 7) ---------- */

  private get conversationsEndpoint(): string {
    const entry = this.company.document.agent?.protocols.find((p) => p.type === 'poppy');
    if (!entry) throw new Error('company does not offer poppy conversations');
    return entry.endpoint;
  }

  private async json(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
    const res = await this.fetch(url, init);
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new PoppyAgentError(res.status, String(body.error ?? 'error'), body, res.headers);
    return { status: res.status, body, headers: res.headers };
  }

  newMessageId(): string {
    return 'msg_' + randomBytes(16).toString('base64url');
  }

  async startConversation(message: Omit<AgentMessage, 'id'> & { id?: string }, opts: { parentConversationId?: string; wait?: number; cursor?: string } = {}): Promise<Record<string, unknown>> {
    const u = new URL(this.conversationsEndpoint);
    if (opts.wait !== undefined) u.searchParams.set('wait', String(opts.wait));
    if (opts.cursor !== undefined) u.searchParams.set('cursor', opts.cursor);
    const body: Record<string, unknown> = { message: { id: message.id ?? this.newMessageId(), ...message } };
    if (opts.parentConversationId) body.parent_conversation_id = opts.parentConversationId;
    return (await this.json(u.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).body;
  }

  async sendMessage(conversationId: string, message: Omit<AgentMessage, 'id'> & { id?: string }, opts: { wait?: number; cursor?: string } = {}): Promise<Record<string, unknown>> {
    const u = new URL(`${this.conversationsEndpoint}/${conversationId}/messages`);
    if (opts.wait !== undefined) u.searchParams.set('wait', String(opts.wait));
    if (opts.cursor !== undefined) u.searchParams.set('cursor', opts.cursor);
    const body = { message: { id: message.id ?? this.newMessageId(), ...message } };
    return (await this.json(u.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).body;
  }

  async readEvents(conversationId: string, opts: { cursor?: string; wait?: number } = {}): Promise<ConversationRead> {
    const u = new URL(`${this.conversationsEndpoint}/${conversationId}/events`);
    if (opts.cursor !== undefined) u.searchParams.set('cursor', opts.cursor);
    if (opts.wait !== undefined) u.searchParams.set('wait', String(opts.wait));
    return (await this.json(u.toString(), { method: 'GET' })).body as unknown as ConversationRead;
  }

  /** Stream events over SSE. Yields each event; ends when the server closes the stream. */
  async *streamEvents(conversationId: string, cursor?: string): AsyncGenerator<ConversationEvent> {
    const u = new URL(`${this.conversationsEndpoint}/${conversationId}/events`);
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (cursor) headers['last-event-id'] = cursor;
    const res = await this.fetch(u.toString(), { method: 'GET', headers });
    if (!res.ok || !res.body) throw new PoppyAgentError(res.status, 'stream_failed', {}, res.headers);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
        const eventLine = chunk.split('\n').find((l) => l.startsWith('event:'));
        if (!dataLine || (eventLine && eventLine.slice(6).trim() === 'text-delta')) continue;
        yield JSON.parse(dataLine.slice(5).trim()) as ConversationEvent;
      }
    }
  }

  async handoff(conversationId: string): Promise<Record<string, unknown>> {
    return (await this.json(`${this.conversationsEndpoint}/${conversationId}/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).body;
  }

  async closeConversation(conversationId: string): Promise<Record<string, unknown>> {
    return (await this.json(`${this.conversationsEndpoint}/${conversationId}/close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).body;
  }
}
