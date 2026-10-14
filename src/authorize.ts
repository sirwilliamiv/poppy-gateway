import { Defaults, IdPrefix, OAuthError } from './constants.js';
import { scopeCatalog, type GatewayContext } from './context.js';
import { isSubset, joinScopes, parseScopeString } from './discovery.js';
import { oauthError, PoppyError, jsonResponse } from './errors.js';
import { randomId, randomToken } from './ids.js';
import type { AuthorizationRequestRecord } from './types.js';

function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** GET authorization endpoint: validates the request and hands off to the company's consent page (spec 4.5 step 2). */
export async function handleAuthorizeRequest(ctx: GatewayContext, request: Request): Promise<Response> {
  const direct = ctx.config.signIn?.direct;
  if (!direct) return jsonResponse({ error: OAuthError.InvalidRequest, error_description: 'direct sign-in is not offered' }, 404);
  const params = new URL(request.url).searchParams;
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  let metadata;
  try {
    metadata = await ctx.clients.getMetadata(clientId);
  } catch (e) {
    const msg = e instanceof PoppyError ? e.message : 'client is not accepted';
    return jsonResponse({ error: OAuthError.InvalidClient, error_description: msg }, 400);
  }
  if (!metadata.redirect_uris?.includes(redirectUri)) {
    return jsonResponse({ error: OAuthError.InvalidRequest, error_description: 'redirect_uri is not registered for this client' }, 400);
  }
  const state = params.get('state') ?? '';
  const fail = (error: string, description: string): Response =>
    Response.redirect(redirectWith(redirectUri, { error, error_description: description, ...(state ? { state } : {}), iss: ctx.urls.issuer }), 302);

  if (params.get('response_type') !== 'code') return fail(OAuthError.InvalidRequest, 'response_type must be code');
  if (!state) return fail(OAuthError.InvalidRequest, 'state is required');
  const challenge = params.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || params.get('code_challenge_method') !== 'S256') return fail(OAuthError.InvalidRequest, 'PKCE with S256 is required');
  const scopes = parseScopeString(params.get('scope'));
  if (!scopes.length || !isSubset(scopes, direct.scopes)) return fail(OAuthError.InvalidScope, 'requested scopes are not available for direct sign-in');

  const nowSec = Math.floor(ctx.now() / 1000);
  const record: AuthorizationRequestRecord = {
    id: randomId(IdPrefix.AuthRequest),
    clientId,
    redirectUri,
    scopes,
    state,
    codeChallenge: challenge,
    createdAt: nowSec,
    expiresAt: nowSec + Defaults.AuthRequestTtlSeconds,
  };
  await ctx.store.putAuthorizationRequest(record);
  const catalog = scopeCatalog(ctx.config);
  const scopeDescriptions: Record<string, string> = {};
  for (const s of scopes) scopeDescriptions[s] = catalog[s] ?? s;
  return direct.onAuthorize({
    requestId: record.id,
    clientId,
    clientName: metadata.client_name ?? new URL(clientId).host,
    ...(metadata.logo_uri ? { logoUri: metadata.logo_uri } : {}),
    requestedScopes: scopes,
    scopeDescriptions,
    request,
  });
}

export interface CompleteAuthorizationInput {
  /** The company's account identifier for the signed-in user. */
  account: string;
  /** Scopes the user approved. Must be a subset of the requested scopes. */
  scopes: string[];
}

/** Called by the company's consent page after the user signs in and approves (spec 4.5 step 3). Returns the redirect URL. */
export async function completeAuthorization(ctx: GatewayContext, requestId: string, input: CompleteAuthorizationInput): Promise<{ redirectUrl: string }> {
  const record = await ctx.store.getAuthorizationRequest(requestId);
  const nowSec = Math.floor(ctx.now() / 1000);
  if (!record || record.expiresAt <= nowSec) throw oauthError(OAuthError.InvalidRequest, 'authorization request is unknown or expired');
  if (!input.scopes.length || !isSubset(input.scopes, record.scopes)) throw oauthError(OAuthError.InvalidScope, 'approved scopes must be a non-empty subset of the requested scopes');
  await ctx.store.deleteAuthorizationRequest(requestId);
  const code = randomToken(IdPrefix.AuthCode, 24);
  await ctx.store.putAuthorizationCode({
    code,
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    codeChallenge: record.codeChallenge,
    account: input.account,
    scopes: [...input.scopes],
    createdAt: nowSec,
    expiresAt: nowSec + Defaults.AuthCodeTtlSeconds,
    used: false,
  });
  return { redirectUrl: redirectWith(record.redirectUri, { code, state: record.state, iss: ctx.urls.issuer }) };
}

/** Called when the user declines. Returns the redirect URL carrying access_denied. */
export async function denyAuthorization(ctx: GatewayContext, requestId: string): Promise<{ redirectUrl: string }> {
  const record = await ctx.store.getAuthorizationRequest(requestId);
  if (!record) throw oauthError(OAuthError.InvalidRequest, 'authorization request is unknown or expired');
  await ctx.store.deleteAuthorizationRequest(requestId);
  return { redirectUrl: redirectWith(record.redirectUri, { error: OAuthError.AccessDenied, state: record.state, iss: ctx.urls.issuer }) };
}

export function scopeSummary(scopes: string[]): string {
  return joinScopes(scopes);
}

