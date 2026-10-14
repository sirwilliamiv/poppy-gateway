import type { JWK } from 'jose';
import { ApiType, ConversationProtocol, GrantType, PROTOCOL_VERSION, Route, SigningAlg } from './constants.js';
import { completeAuthorization, denyAuthorization, handleAuthorizeRequest, type CompleteAuthorizationInput } from './authorize.js';
import { handleBrowserSession, sessionFromCookie, type BrowserPrincipal } from './browser-session.js';
import { allGrantableScopes, resolveContext, type GatewayContext, type PoppyGatewayConfig } from './context.js';
import { ConversationService } from './conversations.js';
import { approveDevice, denyDevice, handleDeviceAuthorization, handleDeviceVerificationPage } from './device.js';
import { validatePoppyDocument } from './discovery.js';
import { errorToResponse, jsonResponse } from './errors.js';
import { handleMediatedCode, handleMediatedSignIn } from './mediated.js';
import { authenticate, type AuthenticateOptions, type Principal } from './protect.js';
import { disconnectAgent, handleRevocation } from './revoke.js';
import { MemoryStore, type Store } from './store.js';
import { handleTokenRequest } from './token-endpoint.js';
import type { OAuthServerMetadata, PoppyDocument } from './types.js';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported: string[];
}

export class PoppyGateway {
  readonly context: GatewayContext;
  readonly store: Store;
  readonly conversations: ConversationService;

  constructor(config: PoppyGatewayConfig) {
    this.store = config.store ?? new MemoryStore();
    this.context = resolveContext(config, this.store);
    this.conversations = new ConversationService(this.context);
    const check = validatePoppyDocument(this.document(), config.organization.domain, { allowHttp: this.context.urls.issuer.startsWith('http://') });
    if (!check.ok) throw new Error('gateway configuration produces an invalid poppy.json: ' + check.errors.join('; '));
  }

  /* ---------- Discovery documents ---------- */

  /** The poppy.json document to publish at https://{organization.domain}/.well-known/poppy.json (spec section 3). */
  document(): PoppyDocument {
    const cfg = this.context.config;
    const urls = this.context.urls;
    const doc: PoppyDocument = {
      protocol_version: PROTOCOL_VERSION,
      organization: { name: cfg.organization.name, domain: cfg.organization.domain },
    };
    const auth: PoppyDocument['auth'] = { issuer: urls.issuer };
    if (cfg.signIn?.direct) auth.direct = { scopes: [...cfg.signIn.direct.scopes] };
    if (cfg.signIn?.device) auth.device = { scopes: [...cfg.signIn.device.scopes] };
    if (cfg.signIn?.mediated) auth.mediated = { endpoint: urls.mediatedSignIn, fields: cfg.signIn.mediated.fields.map((f) => ({ ...f })), scopes: [...cfg.signIn.mediated.scopes] };
    if (cfg.customScopes && Object.keys(cfg.customScopes).length) auth.custom_scopes = { ...cfg.customScopes };
    doc.auth = auth;
    if (cfg.agent) {
      doc.agent = { protocols: [{ type: ConversationProtocol.Poppy, endpoint: urls.conversations, ...(cfg.agent.resource ? { resource: cfg.agent.resource } : {}) }] };
    }
    if (cfg.web) {
      doc.web = cfg.web.browserSession ? { browser_session_endpoint: urls.browserSession } : {};
    }
    if (cfg.apis?.length) doc.apis = cfg.apis.map((a) => ({ ...a }));
    if (cfg.extensions && Object.keys(cfg.extensions).length) doc.extensions = { ...cfg.extensions };
    return doc;
  }

  /** RFC 8414 metadata with poppy_domains (spec 3.2). Publish at {issuer}/.well-known/oauth-authorization-server. */
  oauthMetadata(): OAuthServerMetadata {
    const cfg = this.context.config;
    const urls = this.context.urls;
    const md: OAuthServerMetadata = {
      issuer: urls.issuer,
      token_endpoint: urls.token,
      revocation_endpoint: urls.revoke,
      jwks_uri: urls.jwks,
      poppy_domains: [...(cfg.poppyDomains ?? [cfg.organization.domain])],
      grant_types_supported: [GrantType.JwtBearer, GrantType.RefreshToken, ...(cfg.signIn?.direct ? [GrantType.AuthorizationCode] : []), ...(cfg.signIn?.device ? [GrantType.DeviceCode] : [])],
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: [SigningAlg.ES256, SigningAlg.RS256],
      dpop_signing_alg_values_supported: [SigningAlg.ES256, SigningAlg.RS256],
      revocation_endpoint_auth_methods_supported: ['private_key_jwt'],
      response_types_supported: cfg.signIn?.direct ? ['code'] : [],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: allGrantableScopes(cfg),
    };
    if (cfg.signIn?.direct) md.authorization_endpoint = urls.authorize;
    if (cfg.signIn?.device) md.device_authorization_endpoint = urls.device;
    return md;
  }

  jwks(): { keys: JWK[] } {
    return { keys: [this.context.signing.publicJwk] };
  }

  /** RFC 9728 metadata for a listed MCP server, so standard MCP clients find the issuer (spec section 6). */
  protectedResourceMetadata(resource: string): ProtectedResourceMetadata {
    const scopes = allGrantableScopes(this.context.config);
    return {
      resource,
      authorization_servers: [this.context.urls.issuer],
      ...(scopes.length ? { scopes_supported: scopes } : {}),
      bearer_methods_supported: ['header'],
    };
  }

  /* ---------- HTTP routing ---------- */

  /**
   * Handles a request to one of the gateway's own routes. Returns undefined when the path is not a gateway route,
   * so the host app can fall through to its own handlers.
   */
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname;
    const routes = this.context.routes;
    try {
      if (path === Route.WellKnownPoppy && request.method === 'GET') return jsonResponse(this.document(), 200, { 'Cache-Control': 'public, max-age=300' });
      if (path === Route.WellKnownOAuth && request.method === 'GET') return jsonResponse(this.oauthMetadata(), 200, { 'Cache-Control': 'public, max-age=300' });
      if (path === routes.jwks && request.method === 'GET') return jsonResponse(this.jwks(), 200, { 'Cache-Control': 'public, max-age=300' });
      if (path === Route.WellKnownProtectedResource && request.method === 'GET') {
        const mcp = (this.context.config.apis ?? []).find((a) => a.type === ApiType.Mcp);
        if (!mcp) return jsonResponse({ error: 'not_found' }, 404);
        return jsonResponse(this.protectedResourceMetadata(mcp.resource ?? mcp.url), 200, { 'Cache-Control': 'public, max-age=300' });
      }
      if (path === routes.token) return request.method === 'POST' ? await handleTokenRequest(this.context, request) : methodNotAllowed();
      if (path === routes.revoke) return request.method === 'POST' ? await handleRevocation(this.context, request) : methodNotAllowed();
      if (path === routes.authorize) return request.method === 'GET' ? await handleAuthorizeRequest(this.context, request) : methodNotAllowed();
      if (path === routes.device) return request.method === 'POST' ? await handleDeviceAuthorization(this.context, request) : methodNotAllowed();
      if (path === routes.deviceVerification) return request.method === 'GET' ? await handleDeviceVerificationPage(this.context, request) : undefined;
      if (path === routes.mediatedSignIn) return request.method === 'POST' ? await handleMediatedSignIn(this.context, request) : methodNotAllowed();
      if (path.startsWith(routes.mediatedSignIn + '/')) {
        const id = path.slice(routes.mediatedSignIn.length + 1);
        return request.method === 'POST' ? await handleMediatedCode(this.context, request, id) : methodNotAllowed();
      }
      if (path === routes.browserSession) return request.method === 'POST' ? await handleBrowserSession(this.context, request) : methodNotAllowed();
      if (path === routes.conversations || path.startsWith(routes.conversations + '/')) {
        return await this.conversations.handle(request, path.slice(routes.conversations.length));
      }
      return undefined;
    } catch (e) {
      return errorToResponse(e);
    }
  }

  /* ---------- Protecting the company's own APIs ---------- */

  authenticate(request: Request, opts?: AuthenticateOptions): Promise<Principal> {
    return authenticate(this.context, request, opts ?? {});
  }

  /** Wraps a fetch-style handler so token errors become spec-shaped responses. */
  protect(opts: AuthenticateOptions, handler: (request: Request, principal: Principal) => Promise<Response> | Response): (request: Request) => Promise<Response> {
    return async (request) => {
      try {
        const principal = await authenticate(this.context, request, opts);
        return await handler(request, principal);
      } catch (e) {
        return errorToResponse(e);
      }
    };
  }

  sessionFromCookie(request: Request): Promise<BrowserPrincipal | undefined> {
    return sessionFromCookie(this.context, request);
  }

  /* ---------- Company-side sign-in hooks ---------- */

  completeAuthorization(requestId: string, input: CompleteAuthorizationInput): Promise<{ redirectUrl: string }> {
    return completeAuthorization(this.context, requestId, input);
  }
  denyAuthorization(requestId: string): Promise<{ redirectUrl: string }> {
    return denyAuthorization(this.context, requestId);
  }
  approveDevice(userCode: string, input: { account: string; scopes: string[] }): Promise<void> {
    return approveDevice(this.context, userCode, input);
  }
  denyDevice(userCode: string): Promise<void> {
    return denyDevice(this.context, userCode);
  }
  /** Revoke a personal agent's access from the account settings page. Returns how many account tokens were revoked. */
  disconnectAgent(input: { account: string; clientId?: string }): Promise<number> {
    return disconnectAgent(this.context, input);
  }
}

function methodNotAllowed(): Response {
  return jsonResponse({ error: 'invalid_request', error_description: 'method not allowed' }, 405, { Allow: 'POST' });
}

export function createPoppyGateway(config: PoppyGatewayConfig): PoppyGateway {
  return new PoppyGateway(config);
}
