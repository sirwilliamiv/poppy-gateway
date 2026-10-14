import { Defaults, IdPrefix, OAuthError } from './constants.js';
import { scopeCatalog, type GatewayContext } from './context.js';
import { isSubset, parseScopeString } from './discovery.js';
import { authenticateClient } from './client-auth.js';
import { oauthError, tokenResponse, jsonResponse } from './errors.js';
import { readForm } from './form.js';
import { randomToken, userCode as makeUserCode } from './ids.js';
import type { DeviceCodeRecord } from './types.js';

/** POST device authorization endpoint (spec 4.6 step 1, RFC 8628 section 3.1). */
export async function handleDeviceAuthorization(ctx: GatewayContext, request: Request): Promise<Response> {
  const device = ctx.config.signIn?.device;
  if (!device) return jsonResponse({ error: OAuthError.InvalidRequest, error_description: 'device sign-in is not offered' }, 404);
  const form = await readForm(request);
  const client = await authenticateClient(ctx, form);
  const scopes = parseScopeString(form.scope);
  if (!scopes.length || !isSubset(scopes, device.scopes)) throw oauthError(OAuthError.InvalidScope, 'requested scopes are not available for device sign-in');
  const nowSec = Math.floor(ctx.now() / 1000);
  const interval = device.intervalSeconds ?? Defaults.DeviceIntervalSeconds;
  const record: DeviceCodeRecord = {
    deviceCode: randomToken(IdPrefix.DeviceCode, 32),
    userCode: makeUserCode(),
    clientId: client.clientId,
    requestedScopes: scopes,
    status: 'pending',
    interval,
    lastPolledAt: 0,
    createdAt: nowSec,
    expiresAt: nowSec + Defaults.DeviceCodeTtlSeconds,
  };
  await ctx.store.putDeviceCode(record);
  const verification = new URL(ctx.urls.deviceVerification);
  const complete = new URL(ctx.urls.deviceVerification);
  complete.searchParams.set('user_code', record.userCode);
  return tokenResponse({
    device_code: record.deviceCode,
    user_code: record.userCode,
    verification_uri: verification.toString(),
    verification_uri_complete: complete.toString(),
    expires_in: Defaults.DeviceCodeTtlSeconds,
    interval,
  });
}

/** GET verification page: the company renders sign-in and approval for the code (spec 4.6 step 2). */
export async function handleDeviceVerificationPage(ctx: GatewayContext, request: Request): Promise<Response> {
  const device = ctx.config.signIn?.device;
  if (!device) return jsonResponse({ error: OAuthError.InvalidRequest, error_description: 'device sign-in is not offered' }, 404);
  const userCode = new URL(request.url).searchParams.get('user_code') ?? undefined;
  const record = userCode ? await ctx.store.getDeviceCodeByUserCode(normalizeUserCode(userCode)) : undefined;
  const catalog = scopeCatalog(ctx.config);
  const scopeDescriptions: Record<string, string> = {};
  for (const s of record?.requestedScopes ?? []) scopeDescriptions[s] = catalog[s] ?? s;
  let clientName: string | undefined;
  let logoUri: string | undefined;
  if (record) {
    try {
      const md = await ctx.clients.getMetadata(record.clientId);
      clientName = md.client_name ?? new URL(record.clientId).host;
      logoUri = md.logo_uri;
    } catch {
      clientName = new URL(record.clientId).host;
    }
  }
  return device.onVerify({
    ...(userCode ? { userCode: normalizeUserCode(userCode) } : {}),
    ...(record ? { clientId: record.clientId } : {}),
    ...(clientName ? { clientName } : {}),
    ...(logoUri ? { logoUri } : {}),
    requestedScopes: record?.requestedScopes ?? [],
    scopeDescriptions,
    request,
  });
}

export function normalizeUserCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : code.toUpperCase();
}

/** Company calls this after the user signs in and approves on the verification page. */
export async function approveDevice(ctx: GatewayContext, userCode: string, input: { account: string; scopes: string[] }): Promise<void> {
  const record = await ctx.store.getDeviceCodeByUserCode(normalizeUserCode(userCode));
  const nowSec = Math.floor(ctx.now() / 1000);
  if (!record || record.status !== 'pending' || record.expiresAt <= nowSec) throw oauthError(OAuthError.InvalidRequest, 'user code is unknown, used, or expired');
  if (!input.scopes.length || !isSubset(input.scopes, record.requestedScopes)) throw oauthError(OAuthError.InvalidScope, 'approved scopes must be a non-empty subset of the requested scopes');
  await ctx.store.putDeviceCode({ ...record, status: 'approved', account: input.account, grantedScopes: [...input.scopes] });
}

export async function denyDevice(ctx: GatewayContext, userCode: string): Promise<void> {
  const record = await ctx.store.getDeviceCodeByUserCode(normalizeUserCode(userCode));
  if (!record || record.status !== 'pending') throw oauthError(OAuthError.InvalidRequest, 'user code is unknown or used');
  await ctx.store.putDeviceCode({ ...record, status: 'denied' });
}
