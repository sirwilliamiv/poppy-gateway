import { ClientRegistry, type ClientRegistryOptions } from './clients.js';
import { Defaults, Route } from './constants.js';
import type { SigningKey } from './keys.js';
import type { ClaimJti } from './jwt.js';
import type { Store } from './store.js';
import type { ApiEntry, AuditEvent, ExtensionEntry, MediatedField } from './types.js';
import type { CompanyAgentHandler } from './conversations.js';

export interface AuthorizeContext {
  /** Opaque id for this pending authorization. Pass it back to gateway.completeAuthorization. */
  requestId: string;
  clientId: string;
  clientName: string;
  logoUri?: string;
  requestedScopes: string[];
  /** Human readable description for each requested scope. */
  scopeDescriptions: Record<string, string>;
  request: Request;
}

export interface DeviceVerifyContext {
  /** User code from the query string, if any. */
  userCode?: string;
  clientId?: string;
  clientName?: string;
  logoUri?: string;
  requestedScopes: string[];
  scopeDescriptions: Record<string, string>;
  request: Request;
}

export type MediatedVerifyResult =
  | { outcome: 'complete'; account: string }
  | { outcome: 'code_required'; account: string; code: string; sentTo: string }
  | { outcome: 'failed' };

export interface MediatedVerifyContext {
  sessionId: string;
  clientId: string;
  userId: string;
  requestedScopes: string[];
}

export interface DirectSignInConfig {
  scopes: string[];
  /** Render the company's sign-in and consent page. The page later calls completeAuthorization or denyAuthorization. */
  onAuthorize: (ctx: AuthorizeContext) => Promise<Response> | Response;
}

export interface DeviceSignInConfig {
  scopes: string[];
  /** Render the page at the verification URI where the user enters the code and approves. */
  onVerify: (ctx: DeviceVerifyContext) => Promise<Response> | Response;
  intervalSeconds?: number;
}

export interface MediatedSignInConfig {
  scopes: string[];
  fields: MediatedField[];
  verify: (credentials: Record<string, string>, ctx: MediatedVerifyContext) => Promise<MediatedVerifyResult> | MediatedVerifyResult;
  maxCodeAttempts?: number;
}

export interface TokenConfig {
  sessionTokenTtlSeconds?: number;
  sessionLifetimeSeconds?: number;
  accountTokenTtlSeconds?: number;
  /** Return a new account token on every refresh (RFC 6749 rotation). */
  rotateAccountTokens?: boolean;
}

export interface DpopConfig {
  requireNonce?: boolean;
  windowSeconds?: number;
}

export interface RateLimitConfig {
  sessionsPerClientPerMinute?: number;
  tokenRequestsPerClientPerMinute?: number;
  mediatedAttemptsPerSession?: number;
}

export interface WebConfig {
  browserSession: boolean;
  cookieName?: string;
  cookieDomain?: string;
  cookieTtlSeconds?: number;
}

export interface Routes {
  token: string;
  revoke: string;
  authorize: string;
  device: string;
  deviceVerification: string;
  mediatedSignIn: string;
  browserSession: string;
  conversations: string;
  jwks: string;
}

export interface PoppyGatewayConfig {
  organization: { name: string; domain: string };
  /** OAuth issuer identifier and the origin the gateway's routes are served from, for example https://auth.example.com */
  issuer: string;
  /** Public origin agents use to reach the gateway, if different from the issuer (behind a proxy). */
  publicOrigin?: string;
  /** Every domain whose poppy.json names this issuer. Defaults to [organization.domain]. */
  poppyDomains?: string[];
  signingKey: SigningKey;
  store?: Store;
  clients?: ClientRegistryOptions;
  signIn?: {
    direct?: DirectSignInConfig;
    device?: DeviceSignInConfig;
    mediated?: MediatedSignInConfig;
  };
  customScopes?: Record<string, string>;
  apis?: ApiEntry[];
  agent?: { handler: CompanyAgentHandler; resource?: string };
  web?: WebConfig;
  extensions?: Record<string, ExtensionEntry>;
  tokens?: TokenConfig;
  dpop?: DpopConfig;
  rateLimits?: RateLimitConfig;
  routes?: Partial<Routes>;
  audit?: (event: AuditEvent) => void;
  now?: () => number;
}

export interface ResolvedUrls {
  issuer: string;
  publicOrigin: string;
  token: string;
  revoke: string;
  authorize: string;
  device: string;
  deviceVerification: string;
  mediatedSignIn: string;
  browserSession: string;
  conversations: string;
  jwks: string;
}

export interface GatewayContext {
  config: PoppyGatewayConfig;
  store: Store;
  clients: ClientRegistry;
  signing: SigningKey;
  routes: Routes;
  urls: ResolvedUrls;
  tokens: Required<TokenConfig>;
  dpop: Required<DpopConfig>;
  audit: (event: AuditEvent) => void;
  now: () => number;
  claimJti: ClaimJti;
}

export function resolveContext(config: PoppyGatewayConfig, store: Store): GatewayContext {
  const issuer = config.issuer.replace(/\/$/, '');
  if (!/^https?:\/\//.test(issuer)) throw new Error('issuer must be an absolute URL');
  const publicOrigin = (config.publicOrigin ?? new URL(issuer).origin).replace(/\/$/, '');
  const routes: Routes = {
    token: Route.Token,
    revoke: Route.Revoke,
    authorize: Route.Authorize,
    device: Route.Device,
    deviceVerification: Route.DeviceVerification,
    mediatedSignIn: Route.MediatedSignIn,
    browserSession: Route.BrowserSession,
    conversations: Route.Conversations,
    jwks: Route.Jwks,
    ...config.routes,
  };
  const abs = (p: string): string => publicOrigin + p;
  const urls: ResolvedUrls = {
    issuer,
    publicOrigin,
    token: abs(routes.token),
    revoke: abs(routes.revoke),
    authorize: abs(routes.authorize),
    device: abs(routes.device),
    deviceVerification: abs(routes.deviceVerification),
    mediatedSignIn: abs(routes.mediatedSignIn),
    browserSession: abs(routes.browserSession),
    conversations: abs(routes.conversations),
    jwks: abs(routes.jwks),
  };
  const now = config.now ?? (() => Date.now());
  const registryOptions: ClientRegistryOptions = { ...config.clients };
  if (!registryOptions.now) registryOptions.now = now;
  const clients = new ClientRegistry(registryOptions);
  return {
    config,
    store,
    clients,
    signing: config.signingKey,
    routes,
    urls,
    tokens: {
      sessionTokenTtlSeconds: config.tokens?.sessionTokenTtlSeconds ?? Defaults.SessionTokenTtlSeconds,
      sessionLifetimeSeconds: config.tokens?.sessionLifetimeSeconds ?? Defaults.SessionLifetimeSeconds,
      accountTokenTtlSeconds: config.tokens?.accountTokenTtlSeconds ?? Defaults.AccountTokenTtlSeconds,
      rotateAccountTokens: config.tokens?.rotateAccountTokens ?? false,
    },
    dpop: {
      requireNonce: config.dpop?.requireNonce ?? false,
      windowSeconds: config.dpop?.windowSeconds ?? Defaults.DpopWindowSeconds,
    },
    audit: config.audit ?? (() => undefined),
    now,
    claimJti: (key, ttl) => store.claimOnce(key, ttl),
  };
}

/** All scopes the company can grant across sign-in types, with descriptions for consent pages. */
export function scopeCatalog(config: PoppyGatewayConfig): Record<string, string> {
  const catalog: Record<string, string> = {
    'poppy:read': 'View account information, such as orders and bookings',
    'poppy:write': 'Make changes, such as exchanging an item or updating a booking',
    ...config.customScopes,
  };
  return catalog;
}

export function allGrantableScopes(config: PoppyGatewayConfig): string[] {
  const s = new Set<string>();
  for (const t of [config.signIn?.direct, config.signIn?.device, config.signIn?.mediated]) for (const sc of t?.scopes ?? []) s.add(sc);
  return [...s];
}
