import { ClientAssertionType, OAuthError } from './constants.js';
import type { GatewayContext } from './context.js';
import { oauthError } from './errors.js';
import type { Form } from './form.js';
import { required } from './form.js';
import { verifyClientAssertion } from './jwt.js';
import type { ClientMetadata } from './types.js';

export interface AuthenticatedClient {
  clientId: string;
  metadata: ClientMetadata;
  keySet: Awaited<ReturnType<GatewayContext['clients']['getKeySet']>>;
}

/** Authenticates the personal agent on a token, device, or revocation request (spec 4.1, private_key_jwt). */
export async function authenticateClient(ctx: GatewayContext, form: Form): Promise<AuthenticatedClient> {
  const clientId = required(form, 'client_id');
  if (form.client_assertion_type !== ClientAssertionType) throw oauthError(OAuthError.InvalidClient, 'client_assertion_type must be the JWT bearer type');
  const assertion = form.client_assertion;
  if (!assertion) throw oauthError(OAuthError.InvalidClient, 'client_assertion is required');
  const perMinute = ctx.config.rateLimits?.tokenRequestsPerClientPerMinute;
  if (perMinute) {
    const n = await ctx.store.increment(`rl:token:${clientId}`, 60);
    if (n > perMinute) throw oauthError(OAuthError.RateLimited, 'too many token requests', { retryAfterSeconds: 60 });
  }
  const metadata = await ctx.clients.getMetadata(clientId);
  const keySet = await ctx.clients.getKeySet(clientId);
  await verifyClientAssertion(assertion, {
    keySet,
    clientId,
    audiences: [ctx.urls.token, ctx.urls.issuer, ctx.urls.revoke, ctx.urls.device],
    claimJti: ctx.claimJti,
  });
  return { clientId, metadata, keySet };
}
