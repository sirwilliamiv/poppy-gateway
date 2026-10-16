import { describe, expect, it } from 'vitest';
import { ConversationStatus, Defaults, GuardRefusal, GuardVerdict, MemoryStore, OAuthError, createGuard, type CompanyAgentHandler } from '../src/index.js';
import { PoppyAgent, generateAgentKeys } from '../src/agent/index.js';
import { makeWorld, API_ORIGIN, AGENT_CLIENT_ID, type World } from './harness.js';

/** Serves a replacement agent's metadata and JWKS at the given client_id URL inside the virtual network. */
function host(world: World, agent: PoppyAgent): void {
  const id = new URL(agent.clientId);
  world.handlers.set(id.host + id.pathname, () => Response.json(agent.metadataDocument(), { headers: { 'cache-control': 'max-age=600' } }));
  world.handlers.set(id.host + '/jwks.json', () => Response.json(agent.jwks()));
}

describe('security view: library controls', () => {
  it('impersonator: an assertion signed by a key outside the published JWKS is rejected', async () => {
    const w = await makeWorld();
    const impostor = new PoppyAgent({ clientId: AGENT_CLIENT_ID, clientName: 'Test Agent', keys: await generateAgentKeys(), fetch: w.fetch });
    const session = await impostor.session(w.company, 'usr_alice');
    await expect(session.start()).rejects.toMatchObject({ status: 401, code: OAuthError.InvalidClient });
    const genuine = await w.agent.session(w.company, 'usr_alice');
    await expect(genuine.start()).resolves.toMatchObject({ signedIn: false });
    expect(w.audit.filter((e) => e.type === 'session.started')).toHaveLength(1);
  });

  it('token thief: a replayed DPoP proof is rejected the second time', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.start();
    const url = `${API_ORIGIN}/public/stock`;
    const headers = { authorization: `DPoP ${s.accessToken}`, dpop: await s.dpopProof('GET', url, s.accessToken) };
    expect((await w.fetch(url, { headers })).status).toBe(200);
    const replay = await w.fetch(url, { headers });
    expect(replay.status).toBe(400);
    expect(replay.headers.get('www-authenticate')).toContain(OAuthError.InvalidDpopProof);
  });

  it('stale token holder: a session token is rejected once its lifetime passes', async () => {
    let clock = Date.now();
    const now = (): number => clock;
    const w = await makeWorld({ gateway: { now } });
    const agent = new PoppyAgent({ clientId: AGENT_CLIENT_ID, clientName: 'Test Agent', keys: await generateAgentKeys(), fetch: w.fetch, now });
    host(w, agent);
    const s = await agent.session(w.company, 'usr_alice');
    await s.start();
    const url = `${API_ORIGIN}/public/stock`;
    const call = async (): Promise<Response> => w.fetch(url, { headers: { authorization: `DPoP ${s.accessToken}`, dpop: await s.dpopProof('GET', url, s.accessToken) } });
    expect((await call()).status).toBe(200);
    clock += (Defaults.SessionTokenTtlSeconds - Defaults.ClockSkewSeconds - 5) * 1000;
    expect((await call()).status).toBe(200);
    clock += (2 * Defaults.ClockSkewSeconds + 10) * 1000;
    const stale = await call();
    expect(stale.status).toBe(401);
    expect(stale.headers.get('www-authenticate')).toContain(OAuthError.InvalidToken);
  });

  it.each(['https://127.0.0.1/agent.json', 'https://localhost/agent.json', 'https://10.0.0.5/agent.json', 'https://192.168.1.20/agent.json', 'https://169.254.169.254/agent.json'])(
    'SSRF prober: client_id %s on a private host is refused without fetching it',
    async (clientId) => {
      const probe = async (allowPrivateHosts: boolean): Promise<{ start: Promise<unknown>; fetched: () => number }> => {
        const w = await makeWorld({ gateway: { clients: { allowPrivateHosts } } });
        const agent = new PoppyAgent({ clientId, clientName: 'Prober', keys: await generateAgentKeys(), fetch: w.fetch });
        let fetched = 0;
        const id = new URL(clientId);
        w.handlers.set(id.host + id.pathname, () => {
          fetched += 1;
          return Response.json(agent.metadataDocument());
        });
        w.handlers.set(id.host + '/jwks.json', () => Response.json(agent.jwks()));
        const s = await agent.session(w.company, 'usr_alice');
        return { start: s.start(), fetched: () => fetched };
      };
      const strict = await probe(false);
      await expect(strict.start).rejects.toMatchObject({ status: 401, code: OAuthError.InvalidClient });
      expect(strict.fetched()).toBe(0);
      // Control: the same client is reachable once private hosts are allowed, so the refusal above comes from the host check.
      const permissive = await probe(true);
      await expect(permissive.start).resolves.toMatchObject({ signedIn: false });
      expect(permissive.fetched()).toBe(1);
    },
  );

  it('snoop: a conversation id owned by another user or another client reads as 404', async () => {
    const w = await makeWorld();
    const alice = await w.agent.session(w.company, 'usr_alice');
    const started = await alice.startConversation({ sender: 'agent', text: 'Private quote request' }, { wait: 5 });
    const id = started.conversation_id as string;
    await expect(alice.readEvents(id)).resolves.toMatchObject({ conversation_id: id });

    const bob = await w.agent.session(w.company, 'usr_bob');
    await expect(bob.readEvents(id)).rejects.toMatchObject({ status: 404, code: OAuthError.ConversationNotFound });
    await expect(bob.sendMessage(id, { sender: 'agent', text: 'let me in' })).rejects.toMatchObject({ status: 404, code: OAuthError.ConversationNotFound });

    const other = new PoppyAgent({ clientId: 'https://other-agent.example/agent.json', clientName: 'Other Agent', keys: await generateAgentKeys(), fetch: w.fetch });
    host(w, other);
    const sameUserOtherClient = await other.session(w.company, 'usr_alice');
    await expect(sameUserOtherClient.readEvents(id)).rejects.toMatchObject({ status: 404, code: OAuthError.ConversationNotFound });
  });

  it('long-poll hog: wait=600 is held for at most Defaults.MaxWaitSeconds', async () => {
    let clock = Date.now();
    const now = (): number => clock;
    const waits: number[] = [];
    class FastClockStore extends MemoryStore {
      override async waitForEvent(_conversationId: string, timeoutMs: number): Promise<void> {
        waits.push(timeoutMs);
        clock += timeoutMs;
      }
    }
    const neverReplies: CompanyAgentHandler = { onMessage: () => new Promise<void>(() => undefined) };
    const w = await makeWorld({ companyAgent: neverReplies, gateway: { now, store: new FastClockStore() } });
    const agent = new PoppyAgent({ clientId: AGENT_CLIENT_ID, clientName: 'Test Agent', keys: await generateAgentKeys(), fetch: w.fetch, now });
    host(w, agent);
    const s = await agent.session(w.company, 'usr_alice');
    const started = await s.startConversation({ sender: 'agent', text: 'Hold the line' });
    const id = started.conversation_id as string;

    const caughtUp = await s.readEvents(id);
    expect(waits).toHaveLength(0);
    const before = clock;
    const cursor = caughtUp.cursor;
    if (!cursor) throw new Error('expected a cursor after catching up');
    const read = await s.readEvents(id, { cursor, wait: 600 });
    expect(read.status).toBe('working');
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(Defaults.MaxWaitSeconds * 1000);
    expect(clock - before).toBe(Defaults.MaxWaitSeconds * 1000);
  });

  it('conversation flood: a conversation refused at the per-client cap is closed and never reaches the handler', async () => {
    let calls = 0;
    const inner: CompanyAgentHandler = {
      async onMessage(_message, ctx) {
        calls += 1;
        await ctx.reply({ text: 'inner handler ran' });
      },
    };
    const store = new MemoryStore();
    const guard = createGuard({ store, messagesPerSessionPerHour: 100, conversationsPerClientPerDay: 1, modelCallsPerDay: 100, maxMessageChars: 4000 });
    const w = await makeWorld({ companyAgent: guard.wrap(inner), gateway: { store } });
    const s = await w.agent.session(w.company, 'usr_alice');
    await s.startConversation({ sender: 'agent', text: 'conversation A' }, { wait: 5 });
    expect(calls).toBe(1);
    const b = await s.startConversation({ sender: 'agent', text: 'conversation B' }, { wait: 5 });
    const bId = b.conversation_id as string;
    const bTexts = (b.events as Array<{ type: string; message?: { text?: string } }>).map((e) => e.message?.text);
    expect(bTexts).toContain(GuardRefusal[GuardVerdict.ConversationsPerClient]);
    await expect(s.sendMessage(bId, { sender: 'agent', text: 'second message on B' }, { wait: 5 })).rejects.toMatchObject({ status: 409, code: OAuthError.ConversationClosed });
    expect(calls).toBe(1);
    expect((await w.gateway.conversations.get(bId))?.status).toBe(ConversationStatus.Closed);
  });
});
