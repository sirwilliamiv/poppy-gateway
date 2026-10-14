import { describe, expect, it } from 'vitest';
import { OAuthError, Scope, type ConversationEvent } from '../src/index.js';
import { makeWorld, signInDirect } from './harness.js';

function messages(events: ConversationEvent[]): string[] {
  return events.filter((e) => e.type === 'message').map((e) => (e as { message: { text?: string } }).message.text ?? '');
}

describe('conversations (spec section 7)', () => {
  it('starts a conversation, waits for the reply, and reads with cursors', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const started = await s.startConversation({ sender: 'agent', text: 'Hello there', context: { locale: 'en-US', user_available: true } }, { wait: 5 });
    expect(started.conversation_id).toMatch(/^cnv_/);
    const events = started.events as ConversationEvent[];
    expect(messages(events)).toContain('Hello there');
    expect(messages(events)).toContain('Echo: Hello there');
    const idle = await s.readEvents(started.conversation_id as string, { cursor: started.cursor as string, wait: 2 });
    expect(idle.status).toBe('idle');
    expect(idle.responder).toBe('agent');
    expect(idle.cursor).toBe(started.cursor);
    const conv = await w.gateway.conversations.get(started.conversation_id as string);
    expect(conv?.context.locale).toBe('en-US');
    await expect(s.readEvents(started.conversation_id as string, { cursor: 'evt_nope' })).rejects.toMatchObject({ code: OAuthError.InvalidCursor });
  });

  it('message ids are idempotent per user and conflict on different content', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const id = s.newMessageId();
    const first = await s.startConversation({ id, sender: 'agent', text: 'Hi' });
    const retry = await s.startConversation({ id, sender: 'agent', text: 'Hi' });
    expect(retry.conversation_id).toBe(first.conversation_id);
    await expect(s.startConversation({ id, sender: 'agent', text: 'Different' })).rejects.toMatchObject({ code: OAuthError.MessageIdConflict, status: 409 });
    const cid = first.conversation_id as string;
    const mid = s.newMessageId();
    await s.sendMessage(cid, { id: mid, sender: 'human', text: 'Medium, please.' });
    await s.sendMessage(cid, { id: mid, sender: 'human', text: 'Medium, please.' });
    const read = await s.readEvents(cid, { wait: 3 });
    expect(messages(read.events).filter((m) => m === 'Medium, please.')).toHaveLength(1);
  });

  it('another user or agent cannot see the conversation', async () => {
    const w = await makeWorld();
    const alice = await w.agent.session(w.company, 'usr_alice');
    const started = await alice.startConversation({ sender: 'agent', text: 'Hi' });
    const bob = await w.agent.session(w.company, 'usr_bob');
    await expect(bob.readEvents(started.conversation_id as string)).rejects.toMatchObject({ code: OAuthError.ConversationNotFound, status: 404 });
  });

  it('asks for sign-in mid-conversation and continues with the new token', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const started = await s.startConversation({ sender: 'agent', text: 'Where is my order?' }, { wait: 5 });
    const events = started.events as ConversationEvent[];
    const authEvent = events.find((e) => e.type === 'authorization') as { error: string; scope?: string } | undefined;
    expect(authEvent?.error).toBe(OAuthError.InsufficientScope);
    expect(authEvent?.scope).toBe('poppy:read');
    const t = await signInDirect(w, [Scope.Read]);
    const read = await t.session.readEvents(started.conversation_id as string, { cursor: started.cursor as string });
    expect(read.status).toBe('idle');
    const reply = await t.session.sendMessage(started.conversation_id as string, { sender: 'agent', text: 'Here is the order question again' }, { wait: 5, cursor: read.cursor as string });
    expect(messages(reply.events as ConversationEvent[])).toContain('I found the order for acct_alice.');
    const signedOut = await w.agent.session(w.company, 'usr_alice');
    await expect(signedOut.sendMessage(started.conversation_id as string, { sender: 'agent', text: 'again' })).rejects.toMatchObject({ code: OAuthError.SignInRequired });
  });

  it('hands off to a person, who replies as human, then closes', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const started = await s.startConversation({ sender: 'agent', text: 'Hi' }, { wait: 3 });
    const cid = started.conversation_id as string;
    const handoff = await s.handoff(cid);
    expect(handoff.status).toBe('queued');
    expect(handoff.responder).toBe('agent');
    await w.gateway.conversations.joinHuman(cid);
    await w.gateway.conversations.sendFromCompany(cid, { text: 'Hi, this is Sam.', sender: 'human' });
    const read = await s.readEvents(cid, { cursor: started.cursor as string, wait: 2 });
    expect(read.responder).toBe('human');
    expect(read.status).toBe('idle');
    const human = read.events.find((e) => e.type === 'message' && (e as { message: { sender: string } }).message.sender === 'human');
    expect(human).toBeDefined();
    await s.sendMessage(cid, { sender: 'human', text: 'Thanks Sam' });
    const after = await s.readEvents(cid, { cursor: read.cursor as string });
    expect(messages(after.events)).toEqual(['Thanks Sam']);
    const closed = await s.closeConversation(cid);
    expect(closed.status).toBe('closed');
    await expect(s.sendMessage(cid, { sender: 'agent', text: 'more' })).rejects.toMatchObject({ code: OAuthError.ConversationClosed, status: 409 });
    const final = await s.readEvents(cid, { cursor: after.cursor as string });
    expect(final.events.map((e) => e.type)).toEqual(['state']);
  });

  it('handoff with no one available falls back to the agent', async () => {
    const w = await makeWorld({ companyAgent: { onMessage: async (_m, ctx) => { await ctx.reply({ text: 'ok' }); }, onHandoff: () => 'unavailable' } });
    const s = await w.agent.session(w.company, 'usr_alice');
    const started = await s.startConversation({ sender: 'agent', text: 'Hi' }, { wait: 3 });
    const handoff = await s.handoff(started.conversation_id as string);
    expect(handoff.status).toBe('idle');
    const read = await s.readEvents(started.conversation_id as string, { cursor: started.cursor as string });
    expect(messages(read.events)[0]).toContain('No one is available');
  });

  it('direct conversations link to the parent and block it while open', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const parent = await s.startConversation({ sender: 'agent', text: 'Hi' }, { wait: 3 });
    const pid = parent.conversation_id as string;
    const direct = await s.startConversation({ sender: 'human', text: 'Hello, I have a question.' }, { parentConversationId: pid, wait: 3 });
    const did = direct.conversation_id as string;
    expect(did).not.toBe(pid);
    await expect(s.sendMessage(pid, { sender: 'agent', text: 'blocked' })).rejects.toMatchObject({ code: OAuthError.DirectConversationOpen, body: { conversation_id: did } });
    await expect(s.startConversation({ sender: 'human', text: 'second' }, { parentConversationId: pid })).rejects.toMatchObject({ code: OAuthError.DirectConversationOpen });
    const parentRead = await s.readEvents(pid, { cursor: parent.cursor as string });
    expect(parentRead.events.map((e) => e.type)).toEqual(['direct_opened']);
    await s.closeConversation(did);
    const afterClose = await s.readEvents(pid, { cursor: parentRead.cursor as string });
    expect(afterClose.events.map((e) => e.type)).toEqual(['direct_closed']);
    const ok = await s.sendMessage(pid, { sender: 'agent', text: 'unblocked' });
    expect(ok.status).toBe('working');
    await expect(s.startConversation({ sender: 'human', text: 'x' }, { parentConversationId: did })).rejects.toMatchObject({ status: 409 });
  });

  it('streams events over SSE until the conversation closes', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    const started = await s.startConversation({ sender: 'agent', text: 'Hi' }, { wait: 3 });
    const cid = started.conversation_id as string;
    const seen: string[] = [];
    const streaming = (async () => {
      for await (const e of s.streamEvents(cid, started.cursor as string)) seen.push(e.type);
    })();
    await new Promise((r) => setTimeout(r, 50));
    await w.gateway.conversations.requestUser(cid, 'A specialist needs to confirm');
    await new Promise((r) => setTimeout(r, 50));
    await w.gateway.conversations.close(cid);
    await streaming;
    expect(seen).toEqual(['user_requested', 'state']);
  });

  it('validates message shape', async () => {
    const w = await makeWorld();
    const s = await w.agent.session(w.company, 'usr_alice');
    await expect(s.startConversation({ sender: 'agent' })).rejects.toMatchObject({ code: OAuthError.InvalidRequest });
    await expect(s.startConversation({ id: 'bad id!', sender: 'agent', text: 'x' })).rejects.toMatchObject({ code: OAuthError.InvalidRequest });
    await expect(s.startConversation({ sender: 'robot' as never, text: 'x' })).rejects.toMatchObject({ code: OAuthError.InvalidRequest });
  });
});
