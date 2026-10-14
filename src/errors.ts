import { ContentType, Header, OAuthError, TokenType, type OAuthErrorCode } from './constants.js';

export interface ErrorExtras {
  scope?: string;
  extension?: string;
  conversation_id?: string;
  retryAfterSeconds?: number;
  dpopNonce?: string;
}

/** A protocol error that maps to one HTTP response. */
export class PoppyError extends Error {
  readonly code: OAuthErrorCode;
  readonly status: number;
  readonly extras: ErrorExtras;
  constructor(code: OAuthErrorCode, status: number, description?: string, extras: ErrorExtras = {}) {
    super(description ?? code);
    this.name = 'PoppyError';
    this.code = code;
    this.status = status;
    this.extras = extras;
  }
}

const STATUS_FOR: Partial<Record<OAuthErrorCode, number>> = {
  [OAuthError.InvalidRequest]: 400,
  [OAuthError.InvalidClient]: 401,
  [OAuthError.InvalidGrant]: 400,
  [OAuthError.InvalidScope]: 400,
  [OAuthError.InvalidSession]: 400,
  [OAuthError.AccountMismatch]: 400,
  [OAuthError.InvalidDpopProof]: 400,
  [OAuthError.UseDpopNonce]: 400,
  [OAuthError.RateLimited]: 429,
  [OAuthError.UnsupportedGrantType]: 400,
  [OAuthError.AuthorizationPending]: 400,
  [OAuthError.SlowDown]: 400,
  [OAuthError.AccessDenied]: 400,
  [OAuthError.ExpiredToken]: 400,
  [OAuthError.InvalidToken]: 401,
  [OAuthError.SignInRequired]: 403,
  [OAuthError.InsufficientScope]: 403,
  [OAuthError.ExtensionRequired]: 403,
  [OAuthError.ConversationNotFound]: 404,
  [OAuthError.ConversationClosed]: 409,
  [OAuthError.DirectConversationOpen]: 409,
  [OAuthError.MessageIdConflict]: 409,
  [OAuthError.InvalidCursor]: 400,
  [OAuthError.CursorExpired]: 410,
  [OAuthError.ServerError]: 500,
};

export function oauthError(code: OAuthErrorCode, description?: string, extras: ErrorExtras = {}): PoppyError {
  return new PoppyError(code, STATUS_FOR[code] ?? 400, description, extras);
}

/** Errors on protected resources go in WWW-Authenticate (spec section 6, RFC 9449 / RFC 6750). */
export class ResourceError extends PoppyError {
  readonly scheme: string;
  constructor(code: OAuthErrorCode, description?: string, extras: ErrorExtras = {}, scheme: string = TokenType.DPoP) {
    super(code, STATUS_FOR[code] ?? 401, description, extras);
    this.name = 'ResourceError';
    this.scheme = scheme;
  }
}

export function resourceError(code: OAuthErrorCode, description?: string, extras: ErrorExtras = {}, scheme: string = TokenType.DPoP): ResourceError {
  return new ResourceError(code, description, extras, scheme);
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { [Header.ContentType]: ContentType.Json, ...headers },
  });
}

/** Responses carrying tokens or codes must not be cached (guides, handling secrets). */
export function tokenResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return jsonResponse(body, status, { [Header.CacheControl]: 'no-store', Pragma: 'no-cache', ...headers });
}

function quote(v: string): string {
  return '"' + v.replace(/["\\]/g, '') + '"';
}

export function errorToResponse(err: unknown): Response {
  if (err instanceof ResourceError) {
    const parts = [`error=${quote(err.code)}`];
    if (err.message && err.message !== err.code) parts.push(`error_description=${quote(err.message)}`);
    if (err.extras.scope) parts.push(`scope=${quote(err.extras.scope)}`);
    const headers: Record<string, string> = {
      [Header.WWWAuthenticate]: `${err.scheme} ${parts.join(', ')}`,
      [Header.CacheControl]: 'no-store',
    };
    if (err.extras.dpopNonce) headers[Header.DPoPNonce] = err.extras.dpopNonce;
    if (err.extras.retryAfterSeconds !== undefined) headers[Header.RetryAfter] = String(err.extras.retryAfterSeconds);
    const body: Record<string, unknown> = { error: err.code };
    if (err.message && err.message !== err.code) body.error_description = err.message;
    if (err.extras.scope) body.scope = err.extras.scope;
    if (err.extras.extension) body.extension = err.extras.extension;
    if (err.extras.conversation_id) body.conversation_id = err.extras.conversation_id;
    return jsonResponse(body, err.status, headers);
  }
  if (err instanceof PoppyError) {
    const body: Record<string, unknown> = { error: err.code };
    if (err.message && err.message !== err.code) body.error_description = err.message;
    if (err.extras.scope) body.scope = err.extras.scope;
    if (err.extras.extension) body.extension = err.extras.extension;
    if (err.extras.conversation_id) body.conversation_id = err.extras.conversation_id;
    const headers: Record<string, string> = { [Header.CacheControl]: 'no-store' };
    if (err.extras.retryAfterSeconds !== undefined) headers[Header.RetryAfter] = String(err.extras.retryAfterSeconds);
    if (err.extras.dpopNonce) headers[Header.DPoPNonce] = err.extras.dpopNonce;
    if (err.code === OAuthError.UseDpopNonce || err.code === OAuthError.InvalidDpopProof) {
      headers[Header.WWWAuthenticate] = `${TokenType.DPoP} error=${quote(err.code)}`;
    }
    return jsonResponse(body, err.status, headers);
  }
  return jsonResponse({ error: OAuthError.ServerError }, 500, { [Header.CacheControl]: 'no-store' });
}
