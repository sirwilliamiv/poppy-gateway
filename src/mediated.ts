import { Defaults, IdPrefix, MediatedStatus, OAuthError, SignInType } from './constants.js';
import type { GatewayContext } from './context.js';
import { isSubset, joinScopes, parseScopeString } from './discovery.js';
import { oauthError, tokenResponse, jsonResponse } from './errors.js';
import { readJson } from './form.js';
import { oneTimeCode, randomId, sha256b64url } from './ids.js';
import { authenticate, type Principal } from './protect.js';
import { issueAccountToken, issueSessionToken, signSessionIn } from './tokens.js';
import type { MediatedSignInRecord, SessionRecord } from './types.js';

function expiresAtIso(ctx: GatewayContext, seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

async function completeResponse(ctx: GatewayContext, principal: Principal, session: SessionRecord, account: string, scopes: string[]): Promise<Response> {
  const signedIn = await signSessionIn(ctx, session, account, scopes, SignInType.Mediated);
  const issuedAccount = await issueAccountToken(ctx, { clientId: principal.clientId, userId: principal.userId, account, scopes, signInType: SignInType.Mediated });
  const issued = await issueSessionToken(ctx, { session: signedIn, scopes, ...(principal.thumbprint ? { thumbprint: principal.thumbprint } : {}) });
  ctx.audit({ type: 'mediated.attempt', sessionId: session.id, outcome: MediatedStatus.Complete });
  return tokenResponse({
    status: MediatedStatus.Complete,
    access_token: issued.token,
    token_type: issued.tokenType,
    expires_in: issued.expiresIn,
    refresh_token: issuedAccount.token,
    refresh_token_expires_in: issuedAccount.expiresIn,
    scope: joinScopes(scopes),
    session_id: session.id,
    signed_in: true,
  });
}

function codeRequiredResponse(ctx: GatewayContext, record: MediatedSignInRecord): Response {
  return tokenResponse({
    status: MediatedStatus.CodeRequired,
    sign_in_id: record.id,
    code: { sent_to: record.sentTo },
    expires_at: expiresAtIso(ctx, record.expiresAt),
  });
}

async function rateLimit(ctx: GatewayContext, principal: Principal): Promise<void> {
  const max = ctx.config.rateLimits?.mediatedAttemptsPerSession ?? Defaults.MediatedAttemptsPerSession;
  const n = await ctx.store.increment(`rl:mediated:${principal.sessionId}`, Defaults.MediatedAttemptWindowSeconds);
  const perClient = await ctx.store.increment(`rl:mediated-client:${principal.clientId}`, Defaults.MediatedAttemptWindowSeconds);
  if (n > max || perClient > max * 50) throw oauthError(OAuthError.RateLimited, 'too many sign-in attempts', { retryAfterSeconds: Defaults.MediatedAttemptWindowSeconds });
}

/** POST mediated sign-in endpoint (spec 4.7): credentials in, tokens or a one-time code step out. */
export async function handleMediatedSignIn(ctx: GatewayContext, request: Request): Promise<Response> {
  const mediated = ctx.config.signIn?.mediated;
  if (!mediated) return jsonResponse({ error: OAuthError.InvalidRequest, error_description: 'mediated sign-in is not offered' }, 404);
  const principal = await authenticate(ctx, request, { publicUrl: ctx.urls.mediatedSignIn });
  await rateLimit(ctx, principal);
  const body = await readJson<{ scope?: unknown; credentials?: unknown }>(request);
  const scopes = parseScopeString(typeof body.scope === 'string' ? body.scope : undefined);
  if (!scopes.length || !isSubset(scopes, mediated.scopes)) throw oauthError(OAuthError.InvalidScope, 'requested scopes are not available for mediated sign-in');
  const creds = body.credentials;
  if (typeof creds !== 'object' || creds === null || Array.isArray(creds)) throw oauthError(OAuthError.InvalidRequest, 'credentials must be an object');
  const credentials: Record<string, string> = {};
  for (const f of mediated.fields) {
    const v = (creds as Record<string, unknown>)[f.name];
    if (typeof v !== 'string' || !v) throw oauthError(OAuthError.InvalidRequest, `credential ${f.name} is required`);
    credentials[f.name] = v;
  }
  if (principal.session.account) throw oauthError(OAuthError.AccountMismatch, 'session is already signed in');
  const result = await mediated.verify(credentials, { sessionId: principal.sessionId, clientId: principal.clientId, userId: principal.userId, requestedScopes: scopes });
  if (result.outcome === 'failed') {
    ctx.audit({ type: 'mediated.attempt', sessionId: principal.sessionId, outcome: MediatedStatus.Failed });
    return tokenResponse({ status: MediatedStatus.Failed });
  }
  if (result.outcome === 'complete') return completeResponse(ctx, principal, principal.session, result.account, scopes);
  const nowSec = Math.floor(ctx.now() / 1000);
  const record: MediatedSignInRecord = {
    id: randomId(IdPrefix.SignIn, 12),
    sessionId: principal.sessionId,
    clientId: principal.clientId,
    account: result.account,
    scopes,
    codeHash: sha256b64url(result.code),
    attempts: 0,
    sentTo: result.sentTo,
    createdAt: nowSec,
    expiresAt: nowSec + Defaults.MediatedSignInTtlSeconds,
  };
  await ctx.store.putMediatedSignIn(record);
  ctx.audit({ type: 'mediated.attempt', sessionId: principal.sessionId, outcome: MediatedStatus.CodeRequired });
  return codeRequiredResponse(ctx, record);
}

/** POST mediated sign-in code step (spec 4.7 "One-time codes"). */
export async function handleMediatedCode(ctx: GatewayContext, request: Request, signInId: string): Promise<Response> {
  const mediated = ctx.config.signIn?.mediated;
  if (!mediated) return jsonResponse({ error: OAuthError.InvalidRequest, error_description: 'mediated sign-in is not offered' }, 404);
  const principal = await authenticate(ctx, request, { publicUrl: `${ctx.urls.mediatedSignIn}/${signInId}` });
  await rateLimit(ctx, principal);
  const record = await ctx.store.getMediatedSignIn(signInId);
  if (!record || record.sessionId !== principal.sessionId) throw oauthError(OAuthError.InvalidRequest, 'sign-in is unknown or belongs to another session');
  const nowSec = Math.floor(ctx.now() / 1000);
  if (record.expiresAt <= nowSec) {
    await ctx.store.deleteMediatedSignIn(record.id);
    return tokenResponse({ status: MediatedStatus.Expired });
  }
  const body = await readJson<{ code?: unknown }>(request);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (code && sha256b64url(code) === record.codeHash) {
    await ctx.store.deleteMediatedSignIn(record.id);
    return completeResponse(ctx, principal, principal.session, record.account, record.scopes);
  }
  const attempts = record.attempts + 1;
  const max = mediated.maxCodeAttempts ?? Defaults.MediatedMaxCodeAttempts;
  if (attempts >= max) {
    await ctx.store.deleteMediatedSignIn(record.id);
    ctx.audit({ type: 'mediated.attempt', sessionId: principal.sessionId, outcome: MediatedStatus.Failed });
    return tokenResponse({ status: MediatedStatus.Failed });
  }
  await ctx.store.putMediatedSignIn({ ...record, attempts });
  return codeRequiredResponse(ctx, record);
}

export { oneTimeCode };
