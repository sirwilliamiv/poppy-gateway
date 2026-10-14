import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { ALLOWED_ALGS, Defaults, JwtTyp, OAuthError } from './constants.js';
import { sha256b64url } from './ids.js';
import { oauthError, type PoppyError } from './errors.js';
import type { ClaimJti } from './jwt.js';

export interface DpopVerifyOptions {
  method: string;
  /** The public URL the agent used, without query or fragment. Build it from the configured public origin. */
  url: string;
  /** The session token sent with this proof, for the ath check. Omit at the token endpoint. */
  accessToken?: string;
  /** When set, the proof's key thumbprint must equal this value (the key the token is bound to). */
  expectedThumbprint?: string;
  /** When set, the proof must carry this nonce. */
  requiredNonce?: string;
  /** Called with a candidate nonce value to check it was issued by this server. */
  nonceValid?: (nonce: string) => Promise<boolean>;
  windowSeconds?: number;
  clockSkewSeconds?: number;
  claimJti: ClaimJti;
  now?: () => number;
}

export interface DpopResult {
  jwk: JWK;
  thumbprint: string;
}

export function stripUrl(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Verifies a DPoP proof per RFC 9449 and spec 4.3. Throws PoppyError invalid_dpop_proof or use_dpop_nonce. */
export async function verifyDpopProof(proof: string, opts: DpopVerifyOptions): Promise<DpopResult> {
  const fail = (msg: string): PoppyError => oauthError(OAuthError.InvalidDpopProof, msg);
  let header;
  try {
    header = decodeProtectedHeader(proof);
  } catch {
    throw fail('DPoP proof is not a JWT');
  }
  if (header.typ !== JwtTyp.DPoP) throw fail('typ must be dpop+jwt');
  if (!header.alg || !ALLOWED_ALGS.includes(header.alg)) throw fail(`alg ${String(header.alg)} is not allowed`);
  const jwk = header.jwk;
  if (!jwk || typeof jwk !== 'object') throw fail('jwk header is required');
  if ('d' in jwk || 'p' in jwk || 'q' in jwk || 'k' in jwk) throw fail('jwk must hold only a public key');
  let key;
  try {
    key = await importJWK(jwk as JWK, header.alg);
  } catch {
    throw fail('jwk could not be imported');
  }
  const skew = opts.clockSkewSeconds ?? Defaults.ClockSkewSeconds;
  let payload;
  try {
    payload = (await jwtVerify(proof, key, { algorithms: [header.alg], clockTolerance: skew, requiredClaims: ['jti', 'htm', 'htu', 'iat'] })).payload;
  } catch {
    throw fail('DPoP proof signature or claims are invalid');
  }
  if (payload.htm !== opts.method.toUpperCase()) throw fail('htm does not match the request method');
  if (typeof payload.htu !== 'string' || stripUrl(payload.htu) !== stripUrl(opts.url)) throw fail('htu does not match the request URL');
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const window = opts.windowSeconds ?? Defaults.DpopWindowSeconds;
  const iat = payload.iat ?? 0;
  if (Math.abs(now - iat) > window + skew) throw fail('iat is outside the acceptance window');
  const jti = payload.jti;
  if (typeof jti !== 'string' || jti.length < 8) throw fail('jti is required');
  const thumbprint = await calculateJwkThumbprint(jwk as JWK);
  if (opts.expectedThumbprint && thumbprint !== opts.expectedThumbprint) throw fail('proof key does not match the key the token is bound to');
  if (opts.accessToken) {
    if (payload.ath !== sha256b64url(opts.accessToken)) throw fail('ath does not match the session token');
  } else if (payload.ath !== undefined) {
    throw fail('ath is not expected at the token endpoint');
  }
  if (opts.requiredNonce !== undefined || opts.nonceValid) {
    const nonce = payload.nonce;
    if (typeof nonce !== 'string') throw oauthError(OAuthError.UseDpopNonce, 'nonce is required', opts.requiredNonce !== undefined ? { dpopNonce: opts.requiredNonce } : {});
    const ok = opts.nonceValid ? await opts.nonceValid(nonce) : nonce === opts.requiredNonce;
    if (!ok) throw oauthError(OAuthError.UseDpopNonce, 'nonce is not valid', opts.requiredNonce !== undefined ? { dpopNonce: opts.requiredNonce } : {});
  }
  const fresh = await opts.claimJti(`dpop:${thumbprint}:${jti}`, window + skew);
  if (!fresh) throw fail('DPoP jti was already used');
  return { jwk: jwk as JWK, thumbprint };
}
