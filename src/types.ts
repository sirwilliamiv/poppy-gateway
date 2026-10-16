import type { ApiType, ConversationStatus, EventType, MessageRole, Responder, Sender, SignInType } from './constants.js';

/* ---------- Discovery (spec section 3) ---------- */

export interface MediatedField {
  name: string;
  label: string;
  secret: boolean;
}

export interface PoppyAuth {
  issuer: string;
  direct?: { scopes: string[] };
  device?: { scopes: string[] };
  mediated?: { endpoint: string; fields: MediatedField[]; scopes: string[] };
  custom_scopes?: Record<string, string>;
}

export interface ConversationProtocolEntry {
  type: string;
  endpoint: string;
  resource?: string;
}

export interface ApiEntry {
  type: ApiType | string;
  url: string;
  description: string;
  resource?: string;
}

export interface ExtensionEntry {
  version: string;
  [key: string]: unknown;
}

export interface PoppyDocument {
  protocol_version: string;
  organization: { name: string; domain: string };
  auth?: PoppyAuth;
  agent?: { protocols: ConversationProtocolEntry[] };
  web?: { browser_session_endpoint?: string };
  apis?: ApiEntry[];
  extensions?: Record<string, ExtensionEntry>;
}

export interface OAuthServerMetadata {
  issuer: string;
  token_endpoint: string;
  revocation_endpoint: string;
  authorization_endpoint?: string;
  device_authorization_endpoint?: string;
  jwks_uri?: string;
  poppy_domains: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  dpop_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  [key: string]: unknown;
}

/* ---------- Agent identity (spec 4.1) ---------- */

export interface ClientMetadata {
  client_id: string;
  client_name?: string;
  logo_uri?: string;
  jwks_uri: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  extensions?: Record<string, ExtensionEntry>;
  [key: string]: unknown;
}

/* ---------- Stored records ---------- */

export interface SessionRecord {
  id: string;
  clientId: string;
  userId: string;
  /** Company account the session is signed in to, if any. */
  account?: string;
  /** Scopes of the account token used to sign this session in. */
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  /** Set when the session has been ended by policy; renewal returns invalid_session. */
  ended: boolean;
}

export interface AccountTokenRecord {
  /** SHA-256 of the token value, base64url. The plain token is never stored. */
  hash: string;
  clientId: string;
  userId: string;
  account: string;
  scopes: string[];
  signInType: SignInType;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number;
  revoked: boolean;
}

export interface AuthorizationRequestRecord {
  id: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  account: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export interface DeviceCodeRecord {
  deviceCode: string;
  userCode: string;
  clientId: string;
  requestedScopes: string[];
  status: 'pending' | 'approved' | 'denied';
  account?: string;
  grantedScopes?: string[];
  interval: number;
  lastPolledAt: number;
  createdAt: number;
  expiresAt: number;
}

export interface MediatedSignInRecord {
  id: string;
  sessionId: string;
  clientId: string;
  account: string;
  scopes: string[];
  codeHash: string;
  attempts: number;
  sentTo: string;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserCookieRecord {
  value: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

/* ---------- Conversations (spec section 7) ---------- */

export interface MessageContext {
  locale?: string;
  time_zone?: string;
  user_available?: boolean;
  [key: string]: unknown;
}

export interface AgentMessage {
  id: string;
  sender: Sender;
  text?: string;
  data?: Record<string, unknown>;
  context?: MessageContext;
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  sender: Sender;
  text?: string;
  data?: Record<string, unknown>;
  context?: MessageContext;
  [key: string]: unknown;
}

export type ConversationEvent =
  | { id: string; type: typeof EventType.Message; created_at: string; message: StoredMessage }
  | { id: string; type: typeof EventType.State; created_at: string; status: ConversationStatus; responder: Responder }
  | { id: string; type: typeof EventType.Authorization; created_at: string; error: string; scope?: string }
  | { id: string; type: typeof EventType.UserRequested; created_at: string; reason: string }
  | { id: string; type: typeof EventType.DirectOpened; created_at: string; conversation_id: string }
  | { id: string; type: typeof EventType.DirectClosed; created_at: string; conversation_id: string };

export interface ConversationRecord {
  id: string;
  clientId: string;
  userId: string;
  /** Once the conversation has used the account, it belongs to the account. */
  account?: string;
  status: ConversationStatus;
  responder: Responder;
  context: MessageContext;
  parentConversationId?: string;
  openDirectConversationId?: string;
  handoffPending: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MessageIdRecord {
  conversationId: string;
  contentHash: string;
  createdAt: number;
}

/* ---------- Audit ---------- */

export type AuditEvent =
  | { type: 'session.started'; sessionId: string; clientId: string; userId: string }
  | { type: 'session.renewed'; sessionId: string; clientId: string }
  | { type: 'session.signed_in'; sessionId: string; clientId: string; account: string; scopes: string[]; signInType: SignInType }
  | { type: 'account_token.issued'; clientId: string; account: string; scopes: string[]; signInType: SignInType }
  | { type: 'account_token.revoked'; clientId: string; account: string }
  | { type: 'token.rejected'; reason: string; clientId?: string }
  | { type: 'request.rejected'; reason: string; sessionId?: string; path: string }
  | { type: 'browser.joined'; sessionId: string; clientId: string }
  | { type: 'conversation.started'; conversationId: string; clientId: string; userId: string }
  | { type: 'conversation.closed'; conversationId: string }
  | { type: 'conversation.handoff'; conversationId: string }
  | { type: 'mediated.attempt'; sessionId: string; outcome: string }
  | { type: 'guard.refused'; conversationId: string; clientId: string; verdict: string; flags: string[] }
  | { type: 'guard.flagged'; conversationId: string; clientId: string; flags: string[] };
