import { createHash } from 'node:crypto';
import { ApiType, GrantType, Header, OAuthError, SignInType } from './constants.js';
import type { GatewayContext } from './context.js';
import { isSubset, joinScopes, parseScopeString } from './discovery.js';
import { verifyDpopProof } from './dpop.js';
import { oauthError, PoppyError, tokenResponse } from './errors.js';
import { authenticateClient } from './client-auth.js';
import { readForm, required, type Form } from './form.js';
import { verifySessionAssertion } from './jwt.js';
import { issueNonce, nonceValid } from './protect.js';
import { createSession, issueAccountToken, issueSessionToken, loadSession, lookupAccountToken, signSessionIn } from './tokens.js';
import type { AccountTokenRecord, SessionRecord } from './types.js';

interface TokenRequestContext {
  clientId: string;
  thumbprint?: string;
  resource?: string;
  requestedScopes?: string[];
}

function knownResources(ctx: GatewayContext): string[] {
  const list: string[] = [];
  for (const a of ctx.config.apis ?? []) {
    list.push(a.url);
    if (a.resource) list.push(a.resource);
  }
  if (ctx.config.agent?.resource) list.push(ctx.config.agent.resource);
  return list;
}

function isMcpResource(ctx: GatewayContext, resource: string): boolean {
  return (ctx.config.apis ?? []).some((a) => a.type === ApiType.Mcp && (a.url === resource || a.resource === resource));
}

async function sessionTokenBody(ctx: GatewayContext, session: SessionRecord, scopes: string[], req: TokenRequestContext): Promise<Record<string, unknown>> {
  const issued = await issueSessionToken(ctx, {
    session,
    scopes,
    ...(req.thumbprint ? { thumbprint: req.thumbprint } : {}),
    ...(req.resource ? { resource: req.resource } : {}),
  });
  return {
    access_token: issued.token,
    token_type: issued.tokenType,
    expires_in: issued.expiresIn,
    scope: joinScopes(scopes),
    session_id: session.id,
    signed_in: scopes.length > 0 && session.account !== undefined,
  };
}

function narrow(requested: string[] | undefined, granted: string[]): string[] {
  if (!requested) return granted;
  if (!isSubset(requested, granted)) throw oauthError(OAuthError.InvalidScope, 'requested scopes exceed what was granted');
  return requested;
}

/** POST token endpoint (spec 4.2, 4.3, 4.5, 4.6, 4.8). */
export async function handleTokenRequest(ctx: GatewayContext, request: Request): Promise<Response> {
  const form = await readForm(request);
  const client = await authenticateClient(ctx, form);
  const req: TokenRequestContext = { clientId: client.clientId };

  const scopeParam = form.scope;
  if (scopeParam !== undefined) req.requestedScopes = parseScopeString(scopeParam);
  if (form.resource !== undefined) {
    if (!knownResources(ctx).includes(form.resource)) throw oauthError(OAuthError.InvalidRequest, 'resource is not one this company offers');
    req.resource = form.resource;
  }

  const proof = request.headers.get(Header.DPoP);
  if (proof) {
    try {
      const result = await verifyDpopProof(proof, {
        method: request.method,
        url: ctx.urls.token,
        ...(ctx.dpop.requireNonce ? { nonceValid: (n: string) => nonceValid(ctx, n) } : {}),
        windowSeconds: ctx.dpop.windowSeconds,
        claimJti: ctx.claimJti,
        now: ctx.now,
      });
      req.thumbprint = result.thumbprint;
    } catch (e) {
      if (e instanceof PoppyError && e.code === OAuthError.UseDpopNonce) throw oauthError(e.code, e.message, { dpopNonce: await issueNonce(ctx) });
      throw e;
    }
  } else {
    if (!req.resource || !isMcpResource(ctx, req.resource)) {
      throw oauthError(OAuthError.InvalidDpopProof, 'a DPoP proof is required; Bearer tokens are issued only for MCP resources');
    }
  }

  const grant = required(form, 'grant_type');
  switch (grant) {
    case GrantType.JwtBearer:
      return handleJwtBearer(ctx, form, client, req);
    case GrantType.AuthorizationCode:
      return handleAuthorizationCode(ctx, form, req);
    case GrantType.DeviceCode:
      return handleDeviceCode(ctx, form, req);
    case GrantType.RefreshToken:
      return handleRefreshToken(ctx, form, req);
    default:
      throw oauthError(OAuthError.UnsupportedGrantType, `grant_type ${grant} is not supported`);
  }
}

async function handleJwtBearer(ctx: GatewayContext, form: Form, client: Awaited<ReturnType<typeof authenticateClient>>, req: TokenRequestContext): Promise<Response> {
  const assertion = required(form, 'assertion');
  const { userId } = await verifySessionAssertion(assertion, {
    keySet: client.keySet,
    clientId: client.clientId,
    audiences: [ctx.urls.token],
    claimJti: ctx.claimJti,
  });
  let session: SessionRecord;
  if (form.session_id) {
    session = await loadSession(ctx, form.session_id, client.clientId, userId);
    ctx.audit({ type: 'session.renewed', sessionId: session.id, clientId: client.clientId });
  } else {
    const perMinute = ctx.config.rateLimits?.sessionsPerClientPerMinute;
    if (perMinute) {
      const n = await ctx.store.increment(`rl:sessions:${client.clientId}`, 60);
      if (n > perMinute) throw oauthError(OAuthError.RateLimited, 'too many new sessions', { retryAfterSeconds: 60 });
    }
    session = await createSession(ctx, { clientId: client.clientId, userId });
  }
  if (req.requestedScopes && req.requestedScopes.length) throw oauthError(OAuthError.InvalidScope, 'a session assertion yields a signed-out token; use the account token for scopes');
  return tokenResponse(await sessionTokenBody(ctx, session, [], req));
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

async function signedInResponse(ctx: GatewayContext, session: SessionRecord, scopes: string[], req: TokenRequestContext, account: AccountTokenRecord | undefined, newToken?: { token: string; expiresIn: number }): Promise<Response> {
  const body = await sessionTokenBody(ctx, session, scopes, req);
  if (newToken) {
    body.refresh_token = newToken.token;
    body.refresh_token_expires_in = newToken.expiresIn;
  } else if (account) {
    // No new token: the agent keeps using the one it sent.
  }
  return tokenResponse(body);
}

async function handleAuthorizationCode(ctx: GatewayContext, form: Form, req: TokenRequestContext): Promise<Response> {
  const code = required(form, 'code');
  const redirectUri = required(form, 'redirect_uri');
  const verifier = required(form, 'code_verifier');
  const sessionId = required(form, 'session_id');
  const record = await ctx.store.getAuthorizationCode(code);
  const nowSec = Math.floor(ctx.now() / 1000);
  if (!record || record.clientId !== req.clientId || record.expiresAt <= nowSec) throw oauthError(OAuthError.InvalidGrant, 'authorization code is invalid or expired');
  if (record.used) {
    await ctx.store.revokeAccountTokens({ clientId: req.clientId, account: record.account });
    throw oauthError(OAuthError.InvalidGrant, 'authorization code was already used');
  }
  if (record.redirectUri !== redirectUri) throw oauthError(OAuthError.InvalidGrant, 'redirect_uri does not match');
  if (!pkceMatches(verifier, record.codeChallenge)) throw oauthError(OAuthError.InvalidGrant, 'code_verifier does not match');
  await ctx.store.putAuthorizationCode({ ...record, used: true });
  const session = await loadSession(ctx, sessionId, req.clientId);
  const signedIn = await signSessionIn(ctx, session, record.account, record.scopes, SignInType.Direct);
  const account = await issueAccountToken(ctx, { clientId: req.clientId, userId: session.userId, account: record.account, scopes: record.scopes, signInType: SignInType.Direct });
  const scopes = narrow(req.requestedScopes, record.scopes);
  return signedInResponse(ctx, signedIn, scopes, req, account.record, { token: account.token, expiresIn: account.expiresIn });
}

async function handleDeviceCode(ctx: GatewayContext, form: Form, req: TokenRequestContext): Promise<Response> {
  const deviceCode = required(form, 'device_code');
  const sessionId = required(form, 'session_id');
  const record = await ctx.store.getDeviceCode(deviceCode);
  const nowSec = Math.floor(ctx.now() / 1000);
  if (!record || record.clientId !== req.clientId) throw oauthError(OAuthError.InvalidGrant, 'device_code is invalid');
  if (record.expiresAt <= nowSec) {
    await ctx.store.deleteDeviceCode(deviceCode);
    throw oauthError(OAuthError.ExpiredToken, 'device_code has expired');
  }
  if (record.status === 'pending') {
    const since = nowSec - record.lastPolledAt;
    if (since < record.interval) {
      await ctx.store.putDeviceCode({ ...record, lastPolledAt: nowSec, interval: record.interval + 5 });
      throw oauthError(OAuthError.SlowDown, 'polling too fast');
    }
    await ctx.store.putDeviceCode({ ...record, lastPolledAt: nowSec });
    throw oauthError(OAuthError.AuthorizationPending, 'the user has not finished signing in');
  }
  if (record.status === 'denied') {
    await ctx.store.deleteDeviceCode(deviceCode);
    throw oauthError(OAuthError.AccessDenied, 'the user declined');
  }
  const account = record.account;
  const granted = record.grantedScopes ?? [];
  if (!account) throw oauthError(OAuthError.InvalidGrant, 'device approval is incomplete');
  await ctx.store.deleteDeviceCode(deviceCode);
  const session = await loadSession(ctx, sessionId, req.clientId);
  const signedIn = await signSessionIn(ctx, session, account, granted, SignInType.Device);
  const issued = await issueAccountToken(ctx, { clientId: req.clientId, userId: session.userId, account, scopes: granted, signInType: SignInType.Device });
  const scopes = narrow(req.requestedScopes, granted);
  return signedInResponse(ctx, signedIn, scopes, req, issued.record, { token: issued.token, expiresIn: issued.expiresIn });
}

async function handleRefreshToken(ctx: GatewayContext, form: Form, req: TokenRequestContext): Promise<Response> {
  const refreshToken = required(form, 'refresh_token');
  const record = await lookupAccountToken(ctx, refreshToken, req.clientId);
  const nowSec = Math.floor(ctx.now() / 1000);
  let session: SessionRecord;
  if (form.session_id) {
    session = await loadSession(ctx, form.session_id, req.clientId, record.userId);
  } else {
    session = await createSession(ctx, { clientId: req.clientId, userId: record.userId });
  }
  const signedIn = await signSessionIn(ctx, session, record.account, record.scopes, record.signInType);
  const scopes = narrow(req.requestedScopes, record.scopes);
  await ctx.store.putAccountToken({ ...record, lastUsedAt: nowSec });
  let rotated: { token: string; expiresIn: number } | undefined;
  if (ctx.tokens.rotateAccountTokens) {
    const issued = await issueAccountToken(ctx, { clientId: req.clientId, userId: record.userId, account: record.account, scopes: record.scopes, signInType: record.signInType });
    await ctx.store.putAccountToken({ ...record, revoked: true });
    rotated = { token: issued.token, expiresIn: issued.expiresIn };
  }
  return signedInResponse(ctx, signedIn, scopes, req, record, rotated);
}


