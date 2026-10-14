import { describe, expect, it } from 'vitest';
import { ClientAssertionType, GrantType, JwtTyp, Scope } from '../src/index.js';
import { makeWorld, AGENT_CLIENT_ID, ISSUER, signInDirect } from './harness.js';

async function post(w: Awaited<ReturnType<typeof makeWorld>>, assertion: string): Promise<Response> {
  return w.fetch(`${ISSUER}/poppy/browser-session`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ assertion }), redirect: 'manual' });
}

describe('web browsing (spec section 5)', () => {
  it('joins the browser to the session and the website sees the signed-in state', async () => {
    const w = await makeWorld();
    const t = await signInDirect(w, [Scope.Read]);
    const assertion = await t.session.browserAssertion('https://www.northwind.example/orders');
    const res = await post(w, assertion);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://www.northwind.example/orders');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^poppy_session=bsc_/);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    const site = await w.gateway.sessionFromCookie(new Request('https://www.northwind.example/orders', { headers: { cookie: cookie.split(';')[0] ?? '' } }));
    expect(site?.signedIn).toBe(true);
    expect(site?.account).toBe('acct_alice');
    expect(site?.scopes).toEqual(['poppy:read']);
    await t.session.signOut();
    const after = await w.gateway.sessionFromCookie(new Request('https://www.northwind.example/orders', { headers: { cookie: cookie.split(';')[0] ?? '' } }));
    expect(after?.signedIn).toBe(false);
  });

  it('rejects a replayed assertion, an off-domain return_to, and the wrong typ', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const assertion = await s.browserAssertion('https://northwind.example/');
    expect((await post(w, assertion)).status).toBe(303);
    expect((await post(w, assertion)).status).toBe(400);
    const offDomain = await s.browserAssertion('https://evil.example/');
    expect((await post(w, offDomain)).status).toBe(400);
    const sessionAssertion = await w.agent.signAssertion({ sub: 'usr_alice', aud: `${ISSUER}/poppy/browser-session`, extra: { session_id: s.sessionId, return_to: 'https://northwind.example/' } });
    expect((await post(w, sessionAssertion)).status).toBe(400);
  });

  it('a browser assertion is not accepted at the token endpoint', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const endpoint = w.company.oauth.token_endpoint;
    const browserTyped = await w.agent.signAssertion({ sub: 'usr_alice', aud: endpoint, typ: JwtTyp.BrowserAssertion });
    const res = await w.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: await s.dpopProof('POST', endpoint) },
      body: new URLSearchParams({ grant_type: GrantType.JwtBearer, assertion: browserTyped, client_id: AGENT_CLIENT_ID, client_assertion_type: ClientAssertionType, client_assertion: await w.agent.clientAssertion(endpoint) }),
    });
    expect(res.status).toBe(400);
  });
});
