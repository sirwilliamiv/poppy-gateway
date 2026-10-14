import { jwtVerify, decodeProtectedHeader, errors as joseErrors, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { ALLOWED_ALGS, Defaults, JwtTyp, OAuthError, type OAuthErrorCode } from './constants.js';
import { oauthError } from './errors.js';

export type ClaimJti = (jti: string, ttlSeconds: number) => Promise<boolean>;

interface AssertionOptions {
  keySet: JWTVerifyGetKey;
  clientId: string;
  /** Accepted audiences. The spec requires a single string in the assertion; any of these values is accepted. */
  audiences: string[];
  maxLifetimeSeconds?: number;
  clockSkewSeconds?: number;
  claimJti: ClaimJti;
  errorCode?: OAuthErrorCode;
  requiredTyp?: string;
  forbiddenTyp?: string;
}

function rejectUnsafeAlg(token: string, errorCode: OAuthErrorCode): void {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw oauthError(errorCode, 'assertion is not a JWT');
  }
  if (!header.alg || !ALLOWED_ALGS.includes(header.alg)) throw oauthError(errorCode, `alg ${String(header.alg)} is not allowed`);
  if (header.jku || header.x5u || header.jwk) throw oauthError(errorCode, 'embedded key references are ignored');
}

/**
 * Verifies a JWT signed by a personal agent with a key from its jwks_uri.
 * Shared by client assertions (RFC 7523 client auth), session assertions (spec 4.2),
 * and browser assertions (spec section 5).
 */
export async function verifyAgentJwt(token: string, opts: AssertionOptions): Promise<JWTPayload> {
  const errorCode = opts.errorCode ?? OAuthError.InvalidGrant;
  rejectUnsafeAlg(token, errorCode);
  const header = decodeProtectedHeader(token);
  if (opts.requiredTyp && header.typ !== opts.requiredTyp) throw oauthError(errorCode, `typ must be ${opts.requiredTyp}`);
  if (opts.forbiddenTyp && header.typ === opts.forbiddenTyp) throw oauthError(errorCode, `typ ${opts.forbiddenTyp} is not accepted here`);
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, opts.keySet, {
      issuer: opts.clientId,
      audience: opts.audiences,
      algorithms: [...ALLOWED_ALGS],
      clockTolerance: opts.clockSkewSeconds ?? Defaults.ClockSkewSeconds,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'jti'],
    });
    payload = result.payload;
  } catch (e) {
    if (e instanceof joseErrors.JOSEError) throw oauthError(errorCode, `assertion rejected: ${e.code}`);
    throw oauthError(errorCode, 'assertion rejected');
  }
  if (Array.isArray(payload.aud) && payload.aud.length !== 1) throw oauthError(errorCode, 'aud must be a single value');
  const lifetime = (payload.exp ?? 0) - (payload.iat ?? 0);
  const max = opts.maxLifetimeSeconds ?? Defaults.AssertionMaxLifetimeSeconds;
  if (lifetime <= 0 || lifetime > max) throw oauthError(errorCode, `assertion lifetime must be between 1 and ${max} seconds`);
  const jti = payload.jti;
  if (typeof jti !== 'string' || jti.length < 16) throw oauthError(errorCode, 'jti must have at least 128 random bits');
  const fresh = await opts.claimJti(`jti:${opts.clientId}:${jti}`, lifetime + (opts.clockSkewSeconds ?? Defaults.ClockSkewSeconds));
  if (!fresh) throw oauthError(errorCode, 'assertion jti was already used');
  return payload;
}

/** RFC 7523 client assertion: iss = sub = client_id, aud = token endpoint or issuer. */
export async function verifyClientAssertion(token: string, opts: Omit<AssertionOptions, 'errorCode' | 'requiredTyp' | 'forbiddenTyp'>): Promise<JWTPayload> {
  const payload = await verifyAgentJwt(token, { ...opts, errorCode: OAuthError.InvalidClient, forbiddenTyp: JwtTyp.BrowserAssertion });
  if (payload.sub !== opts.clientId) throw oauthError(OAuthError.InvalidClient, 'client assertion sub must equal client_id');
  return payload;
}

/** Spec 4.2 session assertion: iss = client_id, sub = user id, aud = token endpoint. */
export async function verifySessionAssertion(token: string, opts: Omit<AssertionOptions, 'errorCode' | 'requiredTyp' | 'forbiddenTyp'>): Promise<{ userId: string }> {
  const payload = await verifyAgentJwt(token, { ...opts, errorCode: OAuthError.InvalidGrant, forbiddenTyp: JwtTyp.BrowserAssertion });
  const sub = payload.sub;
  if (typeof sub !== 'string' || !sub || sub.length > 256) throw oauthError(OAuthError.InvalidGrant, 'assertion sub must be the user id');
  if (sub.includes('@')) throw oauthError(OAuthError.InvalidGrant, 'user id must not be personal information');
  return { userId: sub };
}

export interface BrowserAssertionClaims {
  userId: string;
  sessionId: string;
  returnTo: string;
}

/** Spec section 5 browser assertion: typ poppy-browser+jwt, aud = browser session endpoint, exp within 60 s of iat. */
export async function verifyBrowserAssertion(token: string, opts: Omit<AssertionOptions, 'errorCode' | 'requiredTyp' | 'forbiddenTyp' | 'maxLifetimeSeconds'>): Promise<BrowserAssertionClaims> {
  const payload = await verifyAgentJwt(token, {
    ...opts,
    errorCode: OAuthError.InvalidGrant,
    requiredTyp: JwtTyp.BrowserAssertion,
    maxLifetimeSeconds: Defaults.BrowserAssertionMaxLifetimeSeconds,
  });
  const sub = payload.sub;
  const sessionId = payload.session_id;
  const returnTo = payload.return_to;
  if (typeof sub !== 'string' || !sub) throw oauthError(OAuthError.InvalidGrant, 'browser assertion sub must be the user id');
  if (typeof sessionId !== 'string' || !sessionId) throw oauthError(OAuthError.InvalidGrant, 'browser assertion needs session_id');
  if (typeof returnTo !== 'string' || !returnTo) throw oauthError(OAuthError.InvalidGrant, 'browser assertion needs return_to');
  return { userId: sub, sessionId, returnTo };
}
