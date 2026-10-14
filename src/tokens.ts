import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { IdPrefix, OAuthError, TokenType } from './constants.js';
import type { GatewayContext } from './context.js';
import { oauthError, resourceError } from './errors.js';
import { randomId, randomToken, sha256b64url } from './ids.js';
import type { AccountTokenRecord, SessionRecord } from './types.js';
import type { SignInType } from './constants.js';

export const SESSION_TOKEN_TYP = 'poppy-session+jwt';

export interface SessionTokenClaims {
  sessionId: string;
  clientId: string;
  userId: string;
  account?: string;
  scopes: string[];
  tokenType: typeof TokenType.DPoP | typeof TokenType.Bearer;
  /** JWK thumbprint the token is bound to (DPoP only). */
  thumbprint?: string;
  /** Resource (RFC 8707) the token was issued for, if any. */
  resource?: string;
  expiresAt: number;
}

export interface IssueSessionTokenInput {
  session: SessionRecord;
  scopes: string[];
  thumbprint?: string;
  resource?: string;
}

export interface IssuedSessionToken {
  token: string;
  expiresIn: number;
  tokenType: typeof TokenType.DPoP | typeof TokenType.Bearer;
}

/** Issues a session token (spec 4.2). DPoP-bound when a thumbprint is given, otherwise Bearer (MCP only). */
export async function issueSessionToken(ctx: GatewayContext, input: IssueSessionTokenInput): Promise<IssuedSessionToken> {
  const nowSec = Math.floor(ctx.now() / 1000);
  const ttl = ctx.tokens.sessionTokenTtlSeconds;
  const sessionRemaining = Math.max(1, input.session.expiresAt - nowSec);
  const expiresIn = Math.min(ttl, sessionRemaining);
  const tokenType = input.thumbprint ? TokenType.DPoP : TokenType.Bearer;
  const builder = new SignJWT({
    client_id: input.session.clientId,
    sid: input.session.id,
    scope: input.scopes.join(' '),
    ...(input.session.account && input.scopes.length ? { acct: input.session.account } : {}),
    ...(input.thumbprint ? { cnf: { jkt: input.thumbprint } } : {}),
    token_use: tokenType,
  })
    .setProtectedHeader({ alg: ctx.signing.alg, kid: ctx.signing.kid, typ: SESSION_TOKEN_TYP })
    .setIssuer(ctx.urls.issuer)
    .setSubject(input.session.userId)
    .setAudience(input.resource ?? ctx.urls.issuer)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + expiresIn)
    .setJti(randomId('', 16));
  const token = await builder.sign(ctx.signing.privateKey);
  return { token, expiresIn, tokenType };
}

/** Verifies a session token's signature and claims. Does not consult the store; see protect.ts for the live check. */
export async function verifySessionToken(ctx: GatewayContext, token: string, expectedAudience?: string): Promise<SessionTokenClaims> {
  let payload;
  try {
    const verified = await jwtVerify(token, ctx.signing.publicKey, {
      issuer: ctx.urls.issuer,
      algorithms: [ctx.signing.alg],
      audience: expectedAudience ?? ctx.urls.issuer,
      typ: SESSION_TOKEN_TYP,
      clockTolerance: 30,
      currentDate: new Date(ctx.now()),
    });
    payload = verified.payload;
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw resourceError(OAuthError.InvalidToken, 'session token expired');
    throw resourceError(OAuthError.InvalidToken, 'session token is invalid');
  }
  const sid = payload.sid;
  const clientId = payload.client_id;
  const scope = payload.scope;
  const tokenUse = payload.token_use;
  if (typeof sid !== 'string' || typeof clientId !== 'string' || typeof payload.sub !== 'string' || typeof scope !== 'string') {
    throw resourceError(OAuthError.InvalidToken, 'session token is malformed');
  }
  const cnf = payload.cnf as { jkt?: string } | undefined;
  const claims: SessionTokenClaims = {
    sessionId: sid,
    clientId,
    userId: payload.sub,
    scopes: scope ? scope.split(' ') : [],
    tokenType: tokenUse === TokenType.Bearer ? TokenType.Bearer : TokenType.DPoP,
    expiresAt: payload.exp ?? 0,
  };
  if (typeof payload.acct === 'string') claims.account = payload.acct;
  if (cnf?.jkt) claims.thumbprint = cnf.jkt;
  if (typeof payload.aud === 'string' && payload.aud !== ctx.urls.issuer) claims.resource = payload.aud;
  return claims;
}

export interface IssuedAccountToken {
  token: string;
  record: AccountTokenRecord;
  expiresIn: number;
}

/** Issues an opaque account token (OAuth refresh token, spec 4.8). Only its hash is stored. */
export async function issueAccountToken(ctx: GatewayContext, input: { clientId: string; userId: string; account: string; scopes: string[]; signInType: SignInType }): Promise<IssuedAccountToken> {
  const token = randomToken(IdPrefix.AccountToken);
  const nowSec = Math.floor(ctx.now() / 1000);
  const record: AccountTokenRecord = {
    hash: sha256b64url(token),
    clientId: input.clientId,
    userId: input.userId,
    account: input.account,
    scopes: [...input.scopes],
    signInType: input.signInType,
    createdAt: nowSec,
    expiresAt: nowSec + ctx.tokens.accountTokenTtlSeconds,
    lastUsedAt: nowSec,
    revoked: false,
  };
  await ctx.store.putAccountToken(record);
  ctx.audit({ type: 'account_token.issued', clientId: input.clientId, account: input.account, scopes: record.scopes, signInType: input.signInType });
  return { token, record, expiresIn: ctx.tokens.accountTokenTtlSeconds };
}

/** Looks up an account token presented by a client. Throws invalid_grant when unknown, revoked, expired, or issued to another client. */
export async function lookupAccountToken(ctx: GatewayContext, token: string, clientId: string): Promise<AccountTokenRecord> {
  const record = await ctx.store.getAccountToken(sha256b64url(token));
  const nowSec = Math.floor(ctx.now() / 1000);
  if (!record || record.revoked || record.expiresAt <= nowSec || record.clientId !== clientId) {
    throw oauthError(OAuthError.InvalidGrant, 'account token is invalid');
  }
  return record;
}

export async function createSession(ctx: GatewayContext, input: { clientId: string; userId: string }): Promise<SessionRecord> {
  const nowSec = Math.floor(ctx.now() / 1000);
  const session: SessionRecord = {
    id: randomId(IdPrefix.Session, 12),
    clientId: input.clientId,
    userId: input.userId,
    scopes: [],
    createdAt: nowSec,
    expiresAt: nowSec + ctx.tokens.sessionLifetimeSeconds,
    ended: false,
  };
  await ctx.store.putSession(session);
  ctx.audit({ type: 'session.started', sessionId: session.id, clientId: session.clientId, userId: session.userId });
  return session;
}

/** Loads a live session that belongs to the given client and user. Throws invalid_session otherwise. */
export async function loadSession(ctx: GatewayContext, sessionId: string, clientId: string, userId?: string): Promise<SessionRecord> {
  const session = await ctx.store.getSession(sessionId);
  const nowSec = Math.floor(ctx.now() / 1000);
  if (!session || session.ended || session.expiresAt <= nowSec || session.clientId !== clientId || (userId !== undefined && session.userId !== userId)) {
    throw oauthError(OAuthError.InvalidSession, 'session has ended or belongs to another agent or user');
  }
  return session;
}

/** Signs a session in to an account with the given scopes (spec 4.4 "How sign-in is remembered"). */
export async function signSessionIn(ctx: GatewayContext, session: SessionRecord, account: string, scopes: string[], signInType: SignInType): Promise<SessionRecord> {
  if (session.account && session.account !== account) throw oauthError(OAuthError.AccountMismatch, 'session is signed in to a different account');
  const updated: SessionRecord = { ...session, account, scopes: [...scopes] };
  await ctx.store.putSession(updated);
  ctx.audit({ type: 'session.signed_in', sessionId: session.id, clientId: session.clientId, account, scopes: updated.scopes, signInType });
  return updated;
}
