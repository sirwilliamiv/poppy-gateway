import { describe, expect, it } from 'vitest';
import { validatePoppyDocument, validateOAuthServerMetadata } from '../src/index.js';
import { makeWorld, COMPANY_DOMAIN, ISSUER } from './harness.js';

describe('discovery (spec section 3)', () => {
  it('gateway publishes a valid poppy.json and oauth metadata', async () => {
    const w = await makeWorld();
    const doc = w.gateway.document();
    const check = validatePoppyDocument(doc, COMPANY_DOMAIN);
    expect(check.ok).toBe(true);
    expect(doc.auth?.issuer).toBe(ISSUER);
    expect(doc.auth?.mediated?.endpoint).toBe(`${ISSUER}/poppy/sign-in`);
    expect(doc.agent?.protocols[0]?.endpoint).toBe(`${ISSUER}/poppy/conversations`);
    expect(doc.web?.browser_session_endpoint).toBe(`${ISSUER}/poppy/browser-session`);
    expect(doc.extensions?.operations?.version).toBe('1');
    const md = w.gateway.oauthMetadata();
    expect(validateOAuthServerMetadata(md, ISSUER, COMPANY_DOMAIN).ok).toBe(true);
    expect(md.poppy_domains).toEqual([COMPANY_DOMAIN]);
    expect(md.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(md.device_authorization_endpoint).toBe(`${ISSUER}/oauth/device`);
  });

  it('serves the well-known documents over HTTP', async () => {
    const w = await makeWorld();
    const res = await w.fetch(`${ISSUER}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string };
    expect(body.issuer).toBe(ISSUER);
    const jwks = await (await w.fetch(`${ISSUER}/.well-known/jwks.json`)).json() as { keys: unknown[] };
    expect(jwks.keys).toHaveLength(1);
    const prm = await (await w.fetch(`${ISSUER}/.well-known/oauth-protected-resource`)).json() as { authorization_servers: string[] };
    expect(prm.authorization_servers).toEqual([ISSUER]);
  });

  it('rejects documents that break the rules', () => {
    expect(validatePoppyDocument({ protocol_version: '0.1', organization: { name: 'X', domain: 'x.example' } }).ok).toBe(false);
    expect(validatePoppyDocument({ protocol_version: '2.0', organization: { name: 'X', domain: 'x.example' }, web: {} }).ok).toBe(false);
    expect(validatePoppyDocument({ protocol_version: '0.1', organization: { name: 'X', domain: 'x.example' }, web: {} }).ok).toBe(true);
    expect(validatePoppyDocument({ protocol_version: '0.1', organization: { name: 'X', domain: 'x.example' }, web: {} }, 'www.x.example').ok).toBe(true);
    expect(validatePoppyDocument({ protocol_version: '0.1', organization: { name: 'X', domain: 'x.example' }, web: {} }, 'y.example').ok).toBe(false);
    expect(validatePoppyDocument({ protocol_version: '0.1', organization: { name: 'X', domain: 'x.example' }, apis: [{ type: 'openapi', url: 'https://x.example/o.json', description: 'd' }] }).ok).toBe(false);
    const custom = validatePoppyDocument({
      protocol_version: '0.1',
      organization: { name: 'X', domain: 'x.example' },
      auth: { issuer: 'https://auth.x.example', custom_scopes: { 'poppy:admin': 'nope' } },
      apis: [{ type: 'openapi', url: 'https://x.example/o.json', description: 'd' }],
    });
    expect(custom.ok).toBe(false);
    const ext = validatePoppyDocument({ protocol_version: '0.1', organization: { name: 'X', domain: 'x.example' }, web: {}, extensions: { 'Bad Name!': { version: '1' } } });
    expect(ext.ok).toBe(false);
  });

  it('agent rejects an issuer that does not list the domain', () => {
    const md = { issuer: ISSUER, token_endpoint: `${ISSUER}/t`, revocation_endpoint: `${ISSUER}/r`, poppy_domains: ['other.example'] };
    expect(validateOAuthServerMetadata(md, ISSUER, COMPANY_DOMAIN).ok).toBe(false);
    expect(validateOAuthServerMetadata({ ...md, poppy_domains: [COMPANY_DOMAIN] }, ISSUER + '/', COMPANY_DOMAIN).ok).toBe(false);
  });
});
