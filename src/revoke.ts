
import type { GatewayContext } from './context.js';
import { authenticateClient } from './client-auth.js';
import { readForm, required } from './form.js';
import { sha256b64url } from './ids.js';
import { PoppyError, tokenResponse } from './errors.js';

/** POST revocation endpoint (spec 4.9, RFC 7009). Always 200 for a well-formed authenticated request. */
export async function handleRevocation(ctx: GatewayContext, request: Request): Promise<Response> {
  const form = await readForm(request);
  const client = await authenticateClient(ctx, form);
  const token = required(form, 'token');
  const record = await ctx.store.getAccountToken(sha256b64url(token));
  if (record && record.clientId === client.clientId && !record.revoked) {
    await ctx.store.putAccountToken({ ...record, revoked: true });
    await ctx.store.signOutSessions(record.clientId, record.account);
    ctx.audit({ type: 'account_token.revoked', clientId: record.clientId, account: record.account });
  }
  return tokenResponse({});
}

/** Company-side: disconnect a personal agent from an account (account settings "disconnect"). */
export async function disconnectAgent(ctx: GatewayContext, input: { account: string; clientId?: string }): Promise<number> {
  const revoked = await ctx.store.revokeAccountTokens(input.clientId ? { clientId: input.clientId, account: input.account } : { account: input.account });
  if (input.clientId) {
    await ctx.store.signOutSessions(input.clientId, input.account);
    ctx.audit({ type: 'account_token.revoked', clientId: input.clientId, account: input.account });
  } else {
    // Without a client filter, sign out every session on the account across agents.
    // Store implementations handle this by iterating; MemoryStore matches on account per client.
    for (const hash of revoked) {
      const r = await ctx.store.getAccountToken(hash);
      if (r) await ctx.store.signOutSessions(r.clientId, r.account);
    }
  }
  return revoked.length;
}

export function isPoppyError(e: unknown): e is PoppyError {
  return e instanceof PoppyError;
}

