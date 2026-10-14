export const PROTOCOL_VERSION = '0.1';

export const GrantType = {
  JwtBearer: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
  AuthorizationCode: 'authorization_code',
  DeviceCode: 'urn:ietf:params:oauth:grant-type:device_code',
  RefreshToken: 'refresh_token',
} as const;
export type GrantType = (typeof GrantType)[keyof typeof GrantType];

export const ClientAssertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export const TokenType = {
  DPoP: 'DPoP',
  Bearer: 'Bearer',
} as const;
export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export const Scope = {
  Read: 'poppy:read',
  Write: 'poppy:write',
} as const;
export const RESERVED_SCOPE_PREFIX = 'poppy:';

export const SignInType = {
  Direct: 'direct',
  Device: 'device',
  Mediated: 'mediated',
} as const;
export type SignInType = (typeof SignInType)[keyof typeof SignInType];

export const ApiType = {
  OpenApi: 'openapi',
  Mcp: 'mcp',
} as const;
export type ApiType = (typeof ApiType)[keyof typeof ApiType];

export const ConversationProtocol = {
  Poppy: 'poppy',
} as const;

export const JwtTyp = {
  DPoP: 'dpop+jwt',
  BrowserAssertion: 'poppy-browser+jwt',
} as const;

export const SigningAlg = {
  ES256: 'ES256',
  RS256: 'RS256',
} as const;
export const ALLOWED_ALGS: readonly string[] = [SigningAlg.ES256, SigningAlg.RS256];

/** OAuth and protocol error codes (spec 4.2, 4.6, 6, 7.13, 3.3). */
export const OAuthError = {
  InvalidRequest: 'invalid_request',
  InvalidClient: 'invalid_client',
  InvalidGrant: 'invalid_grant',
  InvalidScope: 'invalid_scope',
  InvalidSession: 'invalid_session',
  AccountMismatch: 'account_mismatch',
  InvalidDpopProof: 'invalid_dpop_proof',
  UseDpopNonce: 'use_dpop_nonce',
  RateLimited: 'rate_limited',
  UnsupportedGrantType: 'unsupported_grant_type',
  AuthorizationPending: 'authorization_pending',
  SlowDown: 'slow_down',
  AccessDenied: 'access_denied',
  ExpiredToken: 'expired_token',
  InvalidToken: 'invalid_token',
  SignInRequired: 'sign_in_required',
  InsufficientScope: 'insufficient_scope',
  ExtensionRequired: 'extension_required',
  ConversationNotFound: 'conversation_not_found',
  ConversationClosed: 'conversation_closed',
  DirectConversationOpen: 'direct_conversation_open',
  MessageIdConflict: 'message_id_conflict',
  InvalidCursor: 'invalid_cursor',
  CursorExpired: 'cursor_expired',
  ServerError: 'server_error',
} as const;
export type OAuthErrorCode = (typeof OAuthError)[keyof typeof OAuthError];

export const MediatedStatus = {
  Complete: 'complete',
  CodeRequired: 'code_required',
  Failed: 'failed',
  Expired: 'expired',
} as const;
export type MediatedStatus = (typeof MediatedStatus)[keyof typeof MediatedStatus];

export const ConversationStatus = {
  Working: 'working',
  Idle: 'idle',
  Queued: 'queued',
  Closed: 'closed',
} as const;
export type ConversationStatus = (typeof ConversationStatus)[keyof typeof ConversationStatus];

export const Responder = {
  Agent: 'agent',
  Human: 'human',
} as const;
export type Responder = (typeof Responder)[keyof typeof Responder];

export const Sender = {
  Agent: 'agent',
  Human: 'human',
} as const;
export type Sender = (typeof Sender)[keyof typeof Sender];

export const MessageRole = {
  User: 'user',
  Company: 'company',
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

export const EventType = {
  Message: 'message',
  State: 'state',
  Authorization: 'authorization',
  UserRequested: 'user_requested',
  DirectOpened: 'direct_opened',
  DirectClosed: 'direct_closed',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export const IdPrefix = {
  Session: 'ses_',
  AccountToken: 'pat_',
  AuthRequest: 'areq_',
  AuthCode: 'code_',
  DeviceCode: 'dev_',
  SignIn: 'sgn_',
  Conversation: 'cnv_',
  Message: 'msg_',
  Event: 'evt_',
  BrowserCookie: 'bsc_',
  Nonce: 'non_',
} as const;

export const Header = {
  Authorization: 'authorization',
  DPoP: 'dpop',
  DPoPNonce: 'DPoP-Nonce',
  WWWAuthenticate: 'WWW-Authenticate',
  RetryAfter: 'Retry-After',
  CacheControl: 'Cache-Control',
  ContentType: 'Content-Type',
  Accept: 'accept',
  LastEventId: 'last-event-id',
  SetCookie: 'Set-Cookie',
  Location: 'Location',
} as const;

export const ContentType = {
  Json: 'application/json',
  Form: 'application/x-www-form-urlencoded',
  EventStream: 'text/event-stream',
  Html: 'text/html; charset=utf-8',
} as const;

export const Route = {
  WellKnownPoppy: '/.well-known/poppy.json',
  WellKnownOAuth: '/.well-known/oauth-authorization-server',
  WellKnownProtectedResource: '/.well-known/oauth-protected-resource',
  Jwks: '/.well-known/jwks.json',
  Token: '/oauth/token',
  Revoke: '/oauth/revoke',
  Authorize: '/oauth/authorize',
  Device: '/oauth/device',
  DeviceVerification: '/device',
  MediatedSignIn: '/poppy/sign-in',
  BrowserSession: '/poppy/browser-session',
  Conversations: '/poppy/conversations',
} as const;

export const Defaults = {
  SessionTokenTtlSeconds: 3600,
  SessionLifetimeSeconds: 24 * 3600,
  AccountTokenTtlSeconds: 90 * 24 * 3600,
  AssertionMaxLifetimeSeconds: 300,
  BrowserAssertionMaxLifetimeSeconds: 60,
  ClockSkewSeconds: 30,
  DpopWindowSeconds: 60,
  AuthCodeTtlSeconds: 300,
  AuthRequestTtlSeconds: 600,
  DeviceCodeTtlSeconds: 600,
  DeviceIntervalSeconds: 5,
  MediatedSignInTtlSeconds: 600,
  MediatedMaxCodeAttempts: 3,
  MediatedAttemptsPerSession: 5,
  MediatedAttemptWindowSeconds: 600,
  MaxWaitSeconds: 30,
  MetadataMaxBytes: 100 * 1024,
  MetadataTimeoutMs: 5000,
  MetadataCacheMinSeconds: 60,
  MetadataCacheMaxSeconds: 24 * 3600,
  NonceTtlSeconds: 300,
  MessageIdRetentionSeconds: 30 * 24 * 3600,
} as const;
