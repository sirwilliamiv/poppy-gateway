import { Defaults, Header, IdPrefix, OAuthError, TokenType } from './constants.js';
import { randomId } from './ids.js';
import type { GatewayContext } from './context.js';
import { verifyDpopProof, stripUrl } from './dpop.js';
import { PoppyError, resourceError, type ResourceError } from './errors.js';
import { joinScopes } from './discovery.js';
import { verifySessionToken } from './tokens.js';
import type { SessionRecord } from './types.js';

export interface AuthenticateOptions {
  /** Scopes the request needs. Missing ones produce insufficient_scope with the full list. */
  scopes?: string[];
  /** Require a signed-in session even when no scopes are needed. */
  requireSignedIn?: boolean;
  /** Accept only tokens issued for this resource (spec 4.3 narrower tokens, and MCP). */
  resource?: string;
  /** Which token schemes to accept. Defaults to DPoP only; MCP endpoints pass Bearer. */
  tokenTypes?: Array<typeof TokenType.DPoP | typeof TokenType.Bearer>;
  /**
   * The public URL of this request, for the DPoP htu check. Defaults to request.url without query or fragment.
   * Behind a proxy that rewrites URLs, pass the URL the agent used, built from your configured public origin.
   */
  publicUrl?: string;
}

export interface Principal {
  sessionId: string;
  clientId: string;
  userId: string;
  /** Present only when the session is currently signed in and the token was issued signed in. */
  account?: string;
  scopes: string[];
  signedIn: boolean;
  tokenType: typeof TokenType.DPoP | typeof TokenType.Bearer;
  /** JWK thumbprint the presented DPoP token is bound to. */
  thumbprint?: string;
  session: SessionRecord;
}

function parseAuthorization(header: string | null): { scheme: string; token: string } | undefined {
  if (!header) return undefined;
  const idx = header.indexOf(' ');
  if (idx === -1) return undefined;
  return { scheme: header.slice(0, idx), token: header.slice(idx + 1).trim() };
}

/**
 * Authenticates a request to a company API or conversation endpoint (spec 4.3 and section 6).
 * Throws ResourceError so the caller can map it with errorToResponse, or use `protect`.
 */
export async function authenticate(ctx: GatewayContext, request: Request, opts: AuthenticateOptions = {}): Promise<Principal> {
  const accepted = opts.tokenTypes ?? [TokenType.DPoP];
  const defaultScheme = accepted[0] ?? TokenType.DPoP;
  const auth = parseAuthorization(request.headers.get(Header.Authorization));
  if (!auth) throw resourceError(OAuthError.InvalidToken, 'missing session token', {}, defaultScheme);
  const scheme = auth.scheme.toLowerCase() === 'dpop' ? TokenType.DPoP : auth.scheme.toLowerCase() === 'bearer' ? TokenType.Bearer : undefined;
  if (!scheme || !accepted.includes(scheme)) throw resourceError(OAuthError.InvalidToken, `token scheme ${auth.scheme} is not accepted here`, {}, defaultScheme);
  if (new URL(request.url).searchParams.has('access_token')) throw resourceError(OAuthError.InvalidRequest, 'tokens are not accepted in URLs', {}, scheme);

  let claims;
  try {
    claims = await verifySessionToken(ctx, auth.token, opts.resource);
  } catch (e) {
    if (e instanceof PoppyError) throw resourceError(e.code, e.message, e.extras, scheme);
    throw e;
  }
  if (claims.tokenType !== scheme) throw resourceError(OAuthError.InvalidToken, 'token type does not match the Authorization scheme', {}, scheme);
  if (opts.resource && claims.resource !== opts.resource) throw resourceError(OAuthError.InvalidToken, 'token was not issued for this resource', {}, scheme);
  if (!opts.resource && claims.resource && scheme === TokenType.DPoP) throw resourceError(OAuthError.InvalidToken, 'token was issued for another resource', {}, scheme);

  if (scheme === TokenType.DPoP) {
    const proof = request.headers.get(Header.DPoP);
    if (!proof) throw resourceError(OAuthError.InvalidDpopProof, 'DPoP proof is required', {}, scheme);
    const publicUrl = opts.publicUrl ?? request.url;
    try {
      await verifyDpopProof(proof, {
        method: request.method,
        url: stripUrl(publicUrl),
        accessToken: auth.token,
        ...(claims.thumbprint ? { expectedThumbprint: claims.thumbprint } : {}),
        ...(ctx.dpop.requireNonce ? { nonceValid: (n: string) => nonceValid(ctx, n) } : {}),
        windowSeconds: ctx.dpop.windowSeconds,
        claimJti: ctx.claimJti,
        now: ctx.now,
      });
    } catch (e) {
      if (e instanceof PoppyError) {
        const extras = { ...e.extras };
        if (e.code === OAuthError.UseDpopNonce) extras.dpopNonce = await issueNonce(ctx);
        throw resourceError(e.code, e.message, extras, scheme);
      }
      throw e;
    }
  }

  const session = await ctx.store.getSession(claims.sessionId);
  const nowSec = Math.floor(ctx.now() / 1000);
  if (!session || session.ended || session.expiresAt <= nowSec) throw resourceError(OAuthError.InvalidToken, 'session has ended', {}, scheme);
  if (session.clientId !== claims.clientId || session.userId !== claims.userId) throw resourceError(OAuthError.InvalidToken, 'session does not match token', {}, scheme);

  // Live sign-in check (spec 4.9): the token reflects the session when issued; the session is the truth now.
  const signedIn = claims.account !== undefined && session.account === claims.account;
  const sessionScopes = new Set(session.scopes);
  const scopes = signedIn ? claims.scopes.filter((s) => sessionScopes.has(s)) : [];

  if ((opts.requireSignedIn || (opts.scopes && opts.scopes.length > 0)) && !signedIn) {
    throw resourceError(OAuthError.SignInRequired, 'this request needs a signed-in session', opts.scopes?.length ? { scope: joinScopes(opts.scopes) } : {}, scheme);
  }
  if (opts.scopes && opts.scopes.length > 0) {
    const have = new Set(scopes);
    const missing = opts.scopes.filter((s) => !have.has(s));
    if (missing.length) throw resourceError(OAuthError.InsufficientScope, 'token lacks required scopes', { scope: joinScopes(opts.scopes) }, scheme);
  }

  const principal: Principal = {
    sessionId: session.id,
    clientId: session.clientId,
    userId: session.userId,
    scopes,
    signedIn,
    tokenType: scheme,
    session,
  };
  if (signedIn && claims.account) principal.account = claims.account;
  if (claims.thumbprint) principal.thumbprint = claims.thumbprint;
  return principal;
}

/** Issues a DPoP nonce (RFC 9449 section 8). Valid for Defaults.NonceTtlSeconds. */
export async function issueNonce(ctx: GatewayContext): Promise<string> {
  const nonce = randomId(IdPrefix.Nonce, 16);
  await ctx.store.claimOnce(`nonce-issued:${nonce}`, Defaults.NonceTtlSeconds);
  return nonce;
}

export async function nonceValid(ctx: GatewayContext, nonce: string): Promise<boolean> {
  return ctx.store.peek(`nonce-issued:${nonce}`);
}

export type ResourceErrorLike = ResourceError;
