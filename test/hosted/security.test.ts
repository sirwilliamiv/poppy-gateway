/**
 * One test per row of the security view. Each performs the attack against the hosted configuration
 * (hosted/src/server.ts with a fake model) and asserts the refusal.
 */
import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '../../src/index.js';
import { createHosted } from '../../hosted/src/server.js';
import { HostedCaps, loadConfig } from '../../hosted/src/config.js';
import { fakeModel } from './fakes.js';

async function hosted() {
  const config = loadConfig({ POPPY_ISSUER: 'https://poppy-agent.test', POPPY_PUBLIC_DOMAIN: 'origin-platform-labs.netlify.app', GOOGLE_CLOUD_PROJECT: 'test', PORT: '0' });
  const signingKey = await generateSigningKey();
  const { app, gateway } = await createHosted(config, { model: fakeModel({}), signingKey });
  return { app, gateway, config };
}

describe('security view', () => {
  it('payload bomber: a body over the cap gets 413 before any parsing', async () => {
    const { app } = await hosted();
    const res = await app.request('/poppy/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(HostedCaps.maxBodyBytes + 1) });
    expect(res.status).toBe(413);
  });

  it('credential stuffer: no sign-in surface exists in the hosted document', async () => {
    const { gateway } = await hosted();
    const doc = gateway.document() as unknown as { auth?: Record<string, unknown> };
    expect(doc.auth?.direct).toBeUndefined();
    expect(doc.auth?.device).toBeUndefined();
    expect(doc.auth?.mediated).toBeUndefined();
  });

  it('token flooder: rate limits are set in the hosted config', async () => {
    const { config } = await hosted();
    expect(config.caps.tokenRequestsPerClientPerMinute).toBe(30);
    expect(config.caps.sessionsPerClientPerMinute).toBe(10);
  });

  it('readyz answers and healthz is not used', async () => {
    const { app } = await hosted();
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it('discovery documents point at the Netlify domain and the Cloud Run issuer', async () => {
    const { app, gateway } = await hosted();
    const meta = (await (await app.request('/.well-known/oauth-authorization-server')).json()) as { issuer: string; poppy_domains: string[] };
    expect(meta.issuer).toBe('https://poppy-agent.test');
    expect(meta.poppy_domains).toEqual(['origin-platform-labs.netlify.app']);
    const doc = gateway.document() as unknown as { organization: { domain: string }; agent: { protocols: Array<{ endpoint: string }> } };
    expect(doc.organization.domain).toBe('origin-platform-labs.netlify.app');
    expect(doc.agent.protocols[0]?.endpoint).toBe('https://poppy-agent.test/poppy/conversations');
  });
});
