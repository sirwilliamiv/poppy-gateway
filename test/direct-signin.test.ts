import { describe, expect, it } from 'vitest';
import { OAuthError, Scope } from '../src/index.js';
import { makeWorld, API_ORIGIN, signInDirect } from './harness.js';

describe('direct sign-in (spec 4.4, 4.5, 4.8, 4.9)', () => {
  it('completes the authorization code flow with PKCE and session_id', async () => {
    const w = await makeWorld();
    const t = await signInDirect(w, [Scope.Read, Scope.Write]);
    expect(t.signedIn).toBe(true);
    expect(t.scope).toBe('poppy:read poppy:write');
    expect(t.refreshToken).toMatch(/^pat_/);
    expect(t.refreshTokenExpiresIn).toBeGreaterThan(0);
    const orders = await t.session.fetch(`${API_ORIGIN}/orders`);
    expect(orders.status).toBe(200);
    expect((await orders.json()) as object).toEqual({ orders: [{ id: 'ord_1', account: 'acct_alice', item: 'Stormline jacket' }] });
    const exchange = await t.session.fetch(`${API_ORIGIN}/orders/ord_1/exchanges`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(exchange.status).toBe(200);
  });

  it('enforces scopes and names the missing ones', async () => {
    const w = await makeWorld();
    const t = await signInDirect(w, [Scope.Read]);
    const exchange = await t.session.fetch(`${API_ORIGIN}/orders/ord_1/exchanges`, { method: 'POST' });
    expect(exchange.status).toBe(403);
    expect(exchange.headers.get('www-authenticate')).toBe('DPoP error="insufficient_scope", error_description="token lacks required scopes", scope="poppy:read poppy:write"');
  });

  it('the user may approve fewer scopes than requested', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const pending = s.directSignIn([Scope.Read, Scope.Write, 'addresses']);
    await w.fetch(pending.url);
    const { redirectUrl } = await w.gateway.completeAuthorization(w.lastAuthorizeRequestId!, { account: 'acct_alice', scopes: [Scope.Read] });
    const t = await s.exchangeCode(redirectUrl, pending);
    expect(t.scope).toBe('poppy:read');
  });

  it('declining returns access_denied with state and iss', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const pending = s.directSignIn([Scope.Read]);
    await w.fetch(pending.url);
    const { redirectUrl } = await w.gateway.denyAuthorization(w.lastAuthorizeRequestId!);
    const u = new URL(redirectUrl);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('state')).toBe(pending.state);
    expect(u.searchParams.get('iss')).toBe(w.company.oauth.issuer);
    await expect(s.exchangeCode(redirectUrl, pending)).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('rejects bad authorization requests without redirecting when the client or redirect_uri is unknown', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const pending = s.directSignIn([Scope.Read], 'https://agent.example/not-registered');
    const res = await w.fetch(pending.url);
    expect(res.status).toBe(400);
    const badScope = s.directSignIn(['poppy:admin']);
    const r2 = await w.fetch(badScope.url, { redirect: 'manual' });
    expect(r2.status).toBe(302);
    expect(new URL(r2.headers.get('location') ?? '').searchParams.get('error')).toBe(OAuthError.InvalidScope);
  });

  it('rejects a reused code, a wrong verifier, and a wrong redirect_uri', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const pending = s.directSignIn([Scope.Read]);
    await w.fetch(pending.url);
    const { redirectUrl } = await w.gateway.completeAuthorization(w.lastAuthorizeRequestId!, { account: 'acct_alice', scopes: [Scope.Read] });
    await expect(s.exchangeCode(redirectUrl, { ...pending, verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-wrong' })).rejects.toMatchObject({ code: OAuthError.InvalidGrant });
    await s.exchangeCode(redirectUrl, pending);
    await expect(s.exchangeCode(redirectUrl, pending)).rejects.toMatchObject({ code: OAuthError.InvalidGrant });
  });

  it('account tokens start signed-in sessions, narrow scopes, and cannot widen them', async () => {
    const w = await makeWorld();
    const t = await signInDirect(w, [Scope.Read, Scope.Write]);
    const fresh = await w.agent.session(w.company, 'usr_alice');
    fresh.accountToken = t.refreshToken!;
    const set = await fresh.refresh({ newSession: true, scopes: [Scope.Read] });
    expect(set.signedIn).toBe(true);
    expect(set.scope).toBe('poppy:read');
    expect(set.sessionId).not.toBe(t.sessionId);
    const exchange = await fresh.fetch(`${API_ORIGIN}/orders/ord_1/exchanges`, { method: 'POST' });
    expect(exchange.status).toBe(403);
    await expect(fresh.refresh({ scopes: [Scope.Read, Scope.Write, 'addresses'] })).rejects.toMatchObject({ code: OAuthError.InvalidScope });
    const widened = await fresh.refresh({ scopes: [Scope.Read, Scope.Write] });
    expect(widened.scope).toBe('poppy:read poppy:write');
  });

  it('a session signed in to one account cannot switch to another', async () => {
    const w = await makeWorld();
    const t = await signInDirect(w, [Scope.Read]);
    const other = await signInDirect(w, [Scope.Read], 'acct_bob');
    t.session.accountToken = other.refreshToken!;
    await expect(t.session.refresh()).rejects.toMatchObject({ code: OAuthError.AccountMismatch });
  });

  it('a session assertion renews signed out even while the session is signed in', async () => {
    const w = await makeWorld();
    const t = await signInDirect(w, [Scope.Read]);
    const renewed = await t.session.start();
    expect(renewed.signedIn).toBe(false);
    expect(renewed.scope).toBe('');
    const orders = await t.session.fetch(`${API_ORIGIN}/orders`);
    expect(orders.status).toBe(403);
    const back = await t.session.refresh();
    expect(back.signedIn).toBe(true);
  });

  it('sign-out revokes the account token and takes effect on the next request', async () => {
    const w = await makeWorld();
    const t = await signInDirect(w, [Scope.Read]);
    const token = t.refreshToken!;
    await t.session.signOut();
    const orders = await t.session.fetch(`${API_ORIGIN}/orders`);
    expect(orders.status).toBe(403);
    expect(orders.headers.get('www-authenticate')).toContain(OAuthError.SignInRequired);
    t.session.accountToken = token;
    await expect(t.session.refresh()).rejects.toMatchObject({ code: OAuthError.InvalidGrant });
    const pub = await t.session.fetch(`${API_ORIGIN}/public/stock`);
    expect(pub.status).toBe(200);
  });

  it('the user can disconnect an agent from account settings', async () => {
    const w = await makeWorld();
    const t = await signInDirect(w, [Scope.Read]);
    expect(await w.gateway.disconnectAgent({ account: 'acct_alice' })).toBe(1);
    const orders = await t.session.fetch(`${API_ORIGIN}/orders`);
    expect(orders.status).toBe(403);
    await expect(t.session.refresh()).rejects.toMatchObject({ code: OAuthError.InvalidGrant });
  });

  it('rotates account tokens when configured', async () => {
    const w = await makeWorld({ gateway: { tokens: { rotateAccountTokens: true } } });
    const t = await signInDirect(w, [Scope.Read]);
    const old = t.refreshToken!;
    const set = await t.session.refresh();
    expect(set.refreshToken).toBeDefined();
    expect(set.refreshToken).not.toBe(old);
    t.session.accountToken = old;
    await expect(t.session.refresh()).rejects.toMatchObject({ code: OAuthError.InvalidGrant });
  });
});
