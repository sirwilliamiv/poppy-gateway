import { describe, expect, it } from 'vitest';
import { OAuthError, Scope } from '../src/index.js';
import { makeWorld, API_ORIGIN, ISSUER } from './harness.js';

describe('device sign-in (spec 4.6)', () => {
  it('shows a code, waits, then issues tokens once approved', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const dev = await s.deviceStart([Scope.Read, Scope.Write]);
    expect(dev.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(dev.verification_uri).toBe(`${ISSUER}/device`);
    expect(dev.verification_uri_complete).toContain(`user_code=${dev.user_code}`);
    const page = await w.fetch(dev.verification_uri_complete);
    expect(await page.text()).toContain('Test Agent');
    await expect(s.devicePoll(dev.device_code)).rejects.toMatchObject({ code: OAuthError.AuthorizationPending });
    await expect(s.devicePoll(dev.device_code)).rejects.toMatchObject({ code: OAuthError.SlowDown });
    await w.gateway.approveDevice(dev.user_code.toLowerCase().replace('-', ''), { account: 'acct_alice', scopes: [Scope.Read] });
    const t = await s.devicePoll(dev.device_code);
    expect(t.signedIn).toBe(true);
    expect(t.scope).toBe('poppy:read');
    expect(t.refreshToken).toBeDefined();
    await expect(s.devicePoll(dev.device_code)).rejects.toMatchObject({ code: OAuthError.InvalidGrant });
    const orders = await s.fetch(`${API_ORIGIN}/orders`);
    expect(orders.status).toBe(200);
  });

  it('declining returns access_denied', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const dev = await s.deviceStart([Scope.Read]);
    await w.gateway.denyDevice(dev.user_code);
    await expect(s.devicePoll(dev.device_code)).rejects.toMatchObject({ code: OAuthError.AccessDenied });
  });

  it('rejects scopes the device flow cannot grant', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await expect(s.deviceStart(['addresses'])).rejects.toMatchObject({ code: OAuthError.InvalidScope });
  });
});

describe('mediated sign-in (spec 4.7)', () => {
  it('signs in with correct credentials and fails with wrong ones', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const bad = await s.mediatedSignIn([Scope.Read], { email: 'alice@example.com', password: 'nope' });
    expect(bad.status).toBe('failed');
    expect(JSON.stringify(bad)).not.toContain('nope');
    const good = await s.mediatedSignIn([Scope.Read], { email: 'alice@example.com', password: 'correct horse' });
    expect(good.status).toBe('complete');
    expect(s.signedIn).toBe(true);
    expect(s.accountToken).toMatch(/^pat_/);
    const orders = await s.fetch(`${API_ORIGIN}/orders`);
    expect(orders.status).toBe(200);
  });

  it('only grants the scopes mediated sign-in allows', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await expect(s.mediatedSignIn([Scope.Read, Scope.Write], { email: 'alice@example.com', password: 'correct horse' })).rejects.toMatchObject({ code: OAuthError.InvalidScope });
  });

  it('handles the one-time code step, wrong codes, and the attempt limit', async () => {
    const w = await makeWorld({ mediatedTwoStep: true });
    const s = await w.agent.session(w.company, 'usr_alice');
    const step = await s.mediatedSignIn([Scope.Read], { email: 'alice@example.com', password: 'correct horse' });
    expect(step.status).toBe('code_required');
    expect((step.code as { sent_to: string }).sent_to).toContain('71');
    const id = step.sign_in_id as string;
    const wrong = await s.mediatedCode(id, '000000');
    expect(wrong.status).toBe('code_required');
    const right = await s.mediatedCode(id, w.mediatedCode!);
    expect(right.status).toBe('complete');
    expect(s.signedIn).toBe(true);

    const s2 = await w.agent.session(w.company, 'usr_bob');
    const step2 = await s2.mediatedSignIn([Scope.Read], { email: 'alice@example.com', password: 'correct horse' });
    const id2 = step2.sign_in_id as string;
    expect((await s2.mediatedCode(id2, '1')).status).toBe('code_required');
    expect((await s2.mediatedCode(id2, '2')).status).toBe('code_required');
    expect((await s2.mediatedCode(id2, '3')).status).toBe('failed');
    await expect(s2.mediatedCode(id2, w.mediatedCode!)).rejects.toMatchObject({ code: OAuthError.InvalidRequest });
  });

  it('rate limits attempts per session', async () => {
    const w = await makeWorld({ gateway: { rateLimits: { mediatedAttemptsPerSession: 2 } } });
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.mediatedSignIn([Scope.Read], { email: 'alice@example.com', password: 'x' });
    await s.mediatedSignIn([Scope.Read], { email: 'alice@example.com', password: 'y' });
    await expect(s.mediatedSignIn([Scope.Read], { email: 'alice@example.com', password: 'z' })).rejects.toMatchObject({ status: 429 });
  });
});
