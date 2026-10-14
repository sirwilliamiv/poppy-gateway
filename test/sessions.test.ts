import { describe, expect, it } from 'vitest';
import { ClientAssertionType, GrantType, OAuthError } from '../src/index.js';
import { PoppyAgentError } from '../src/agent/index.js';
import { makeWorld, API_ORIGIN, ISSUER, MCP_URL, AGENT_CLIENT_ID, signInDirect } from './harness.js';

describe('sessions and tokens (spec 4.1 to 4.3)', () => {
  it('starts a signed-out session with a DPoP-bound token and renews it', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const first = await s.start();
    expect(first.tokenType).toBe('DPoP');
    expect(first.signedIn).toBe(false);
    expect(first.scope).toBe('');
    expect(first.sessionId).toMatch(/^ses_/);
    const renewed = await s.start();
    expect(renewed.sessionId).toBe(first.sessionId);
    expect(renewed.accessToken).not.toBe(first.accessToken);
    expect(w.audit.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(w.audit.filter((e) => e.type === 'session.renewed')).toHaveLength(1);
  });

  it('calls a public API signed out and gets sign_in_required on account data', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const pub = await s.fetch(`${API_ORIGIN}/public/stock`);
    expect(pub.status).toBe(200);
    const orders = await s.fetch(`${API_ORIGIN}/orders`);
    expect(orders.status).toBe(403);
    expect(orders.headers.get('www-authenticate')).toContain(`error="${OAuthError.SignInRequired}"`);
  });

  it('rejects a replayed DPoP proof, a wrong htu, and a token in the URL', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const url = `${API_ORIGIN}/public/stock`;
    const proof = await s.dpopProof('GET', url, s.accessToken);
    const headers = { authorization: `DPoP ${s.accessToken}`, dpop: proof };
    expect((await w.fetch(url, { headers })).status).toBe(200);
    const replay = await w.fetch(url, { headers });
    expect(replay.status).toBe(400);
    expect(replay.headers.get('www-authenticate')).toContain(OAuthError.InvalidDpopProof);
    const wrongUrl = await w.fetch(url, { headers: { authorization: `DPoP ${s.accessToken}`, dpop: await s.dpopProof('GET', `${API_ORIGIN}/other`, s.accessToken) } });
    expect(wrongUrl.status).toBe(400);
    const noProof = await w.fetch(url, { headers: { authorization: `DPoP ${s.accessToken}` } });
    expect(noProof.status).toBe(400);
    const inUrl = await w.fetch(`${url}?access_token=${s.accessToken}`, { headers: { authorization: `DPoP ${s.accessToken}`, dpop: await s.dpopProof('GET', url, s.accessToken) } });
    expect(inUrl.status).toBe(400);
  });

  it('a token copied to another key is useless', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const thief = await w.agent.session(w.company, 'usr_alice');
    const url = `${API_ORIGIN}/public/stock`;
    const res = await w.fetch(url, { headers: { authorization: `DPoP ${s.accessToken}`, dpop: await thief.dpopProof('GET', url, s.accessToken) } });
    expect(res.status).toBe(400);
    expect(res.headers.get('www-authenticate')).toContain(OAuthError.InvalidDpopProof);
  });

  it('issues Bearer tokens only for MCP resources and accepts them only there', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const bearer = await s.bearerTokenFor(MCP_URL);
    expect(bearer.tokenType).toBe('Bearer');
    expect(bearer.sessionId).toBe(s.sessionId);
    const mcp = await w.fetch(MCP_URL, { method: 'POST', headers: { authorization: `Bearer ${bearer.accessToken}` } });
    expect(mcp.status).toBe(200);
    const misuse = await w.fetch(`${API_ORIGIN}/public/stock`, { headers: { authorization: `Bearer ${bearer.accessToken}` } });
    expect(misuse.status).toBe(401);
    await expect(s.bearerTokenFor(`${API_ORIGIN}/openapi.json`)).rejects.toMatchObject({ code: OAuthError.InvalidDpopProof });
    const noResource = await w.fetch(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: GrantType.JwtBearer, assertion: 'x', client_id: AGENT_CLIENT_ID, client_assertion_type: ClientAssertionType, client_assertion: await w.agent.clientAssertion(`${ISSUER}/oauth/token`) }),
    });
    expect(noResource.status).toBe(400);
  });

  it('rejects an unknown, blocked, or malformed client', async () => {
    const w = await makeWorld({ gateway: { clients: { blocklist: [AGENT_CLIENT_ID] } } });
    const s = await w.agent.session(w.company, 'usr_alice');
    await expect(s.start()).rejects.toMatchObject({ status: 401, code: OAuthError.InvalidClient });

    const w2 = await makeWorld();
    w2.handlers.set('agent.example/agent.json', () => new Response(JSON.stringify({ client_id: 'https://agent.example/other.json', jwks_uri: 'https://agent.example/jwks.json' }), { headers: { 'content-type': 'application/json' } }));
    const s2 = await w2.agent.session(w2.company, 'usr_alice');
    await expect(s2.start()).rejects.toMatchObject({ status: 401, code: OAuthError.InvalidClient });

    const w3 = await makeWorld();
    w3.handlers.set('agent.example/agent.json', () => new Response(JSON.stringify({ client_id: 'https://agent.example/agent.json', jwks_uri: 'https://evil.example/jwks.json' }), { headers: { 'content-type': 'application/json' } }));
    const s3 = await w3.agent.session(w3.company, 'usr_alice');
    await expect(s3.start()).rejects.toMatchObject({ code: OAuthError.InvalidClient });
  });

  it('requires registration when configured', async () => {
    const w = await makeWorld({ gateway: { clients: { requireRegistration: true, allowlist: [] } } });
    const s = await w.agent.session(w.company, 'usr_alice');
    await expect(s.start()).rejects.toBeInstanceOf(PoppyAgentError);
    const w2 = await makeWorld({ gateway: { clients: { requireRegistration: true, allowlist: [AGENT_CLIENT_ID] } } });
    const s2 = await w2.agent.session(w2.company, 'usr_alice');
    await expect(s2.start()).resolves.toMatchObject({ signedIn: false });
  });

  it('rejects a reused session assertion and a session from another user', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const endpoint = w.company.oauth.token_endpoint;
    const assertion = await w.agent.signAssertion({ sub: 'usr_alice', aud: endpoint });
    const send = async (): Promise<Response> =>
      w.fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: await s.dpopProof('POST', endpoint) },
        body: new URLSearchParams({ grant_type: GrantType.JwtBearer, assertion, client_id: AGENT_CLIENT_ID, client_assertion_type: ClientAssertionType, client_assertion: await w.agent.clientAssertion(endpoint) }),
      });
    expect((await send()).status).toBe(200);
    const again = await send();
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe(OAuthError.InvalidGrant);

    const bob = await w.agent.session(w.company, 'usr_bob');
    bob.sessionId = s.sessionId!;
    await expect(bob.start()).rejects.toMatchObject({ code: OAuthError.InvalidSession });
  });

  it('applies rate limits with Retry-After', async () => {
    const w = await makeWorld({ gateway: { rateLimits: { sessionsPerClientPerMinute: 2 } } });
    await (await w.agent.session(w.company, 'usr_1')).start();
    await (await w.agent.session(w.company, 'usr_2')).start();
    const third = await w.agent.session(w.company, 'usr_3');
    let err: PoppyAgentError | undefined;
    try {
      await third.start();
    } catch (e) {
      err = e as PoppyAgentError;
    }
    expect(err?.status).toBe(429);
    expect(err?.headers.get('retry-after')).toBe('60');
  });

  it('requires a DPoP nonce when configured and the agent recovers', async () => {
    const w = await makeWorld({ gateway: { dpop: { requireNonce: true } } });
    const s = await w.agent.session(w.company, 'usr_alice');
    const set = await s.start();
    expect(set.signedIn).toBe(false);
    const res = await s.fetch(`${API_ORIGIN}/public/stock`);
    expect(res.status).toBe(200);
    const signed = await signInDirect(w, ['poppy:read']);
    const orders = await signed.session.fetch(`${API_ORIGIN}/orders`);
    expect(orders.status).toBe(200);
  });
});
