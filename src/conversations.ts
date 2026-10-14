import { ContentType, ConversationStatus, Defaults, EventType, Header, IdPrefix, MessageRole, OAuthError, Responder, Sender } from './constants.js';
import type { GatewayContext } from './context.js';
import { joinScopes } from './discovery.js';
import { errorToResponse, jsonResponse, oauthError, PoppyError, resourceError } from './errors.js';
import { readJson } from './form.js';
import { ID_PATTERN, randomId, sha256b64url, stableStringify } from './ids.js';
import { authenticate, type Principal } from './protect.js';
import type { AgentMessage, ConversationEvent, ConversationRecord, MessageContext, StoredMessage } from './types.js';

export interface ReplyInput {
  text?: string;
  data?: Record<string, unknown>;
  /** Defaults to agent. Use human for messages written by a person at the company. */
  sender?: Sender;
}

export interface ConversationContext {
  conversation: ConversationRecord;
  principal: Principal;
  /** Send a message from the company side. */
  reply(input: ReplyInput): Promise<StoredMessage>;
  /** Ask the agent to sign in or get more scopes (spec 7.11). */
  requestAuthorization(scopes?: string[]): Promise<void>;
  /** Ask to talk with the user directly (spec 7.10). */
  requestUser(reason: string): Promise<void>;
  /** Put the conversation in the queue for a person (spec 7.9). */
  queueForHuman(): Promise<void>;
  /** Close the conversation from the company side (spec 7.12). */
  close(): Promise<void>;
}

export interface CompanyAgentHandler {
  /** Called for every message the personal agent sends. Reply through ctx. Errors are logged and leave the conversation idle. */
  onMessage(message: StoredMessage, ctx: ConversationContext): Promise<void> | void;
  /** Called when the agent asks for a person. Return 'queued' to wait for one, or 'unavailable'. */
  onHandoff?(ctx: ConversationContext): Promise<'queued' | 'unavailable'> | 'queued' | 'unavailable';
  onError?(error: unknown, conversationId: string): void;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<ConversationEvent, 'id' | 'created_at'>;

function iso(ctx: GatewayContext): string {
  return new Date(ctx.now()).toISOString();
}

function userKey(principal: Principal): string {
  return `${principal.clientId}|${principal.userId}`;
}

function ownerMatches(c: ConversationRecord, p: Principal): boolean {
  if (c.clientId !== p.clientId || c.userId !== p.userId) return false;
  return true;
}

function requiresAccount(c: ConversationRecord, p: Principal): void {
  if (c.account && (!p.signedIn || p.account !== c.account)) throw resourceError(OAuthError.SignInRequired, 'this conversation uses the account; sign in to continue');
}

function validateMessage(input: unknown): AgentMessage {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw oauthError(OAuthError.InvalidRequest, 'message must be an object');
  const m = input as Record<string, unknown>;
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) throw oauthError(OAuthError.InvalidRequest, 'message.id must be 1 to 256 URL-safe base64 characters');
  if (m.sender !== Sender.Agent && m.sender !== Sender.Human) throw oauthError(OAuthError.InvalidRequest, 'message.sender must be agent or human');
  const hasText = typeof m.text === 'string' && m.text.length > 0;
  const hasData = typeof m.data === 'object' && m.data !== null && !Array.isArray(m.data);
  const hasContext = typeof m.context === 'object' && m.context !== null && !Array.isArray(m.context);
  if (!hasText && !hasData && !hasContext) throw oauthError(OAuthError.InvalidRequest, 'message needs text, data, or context');
  const out: AgentMessage = { id: m.id, sender: m.sender };
  if (hasText) out.text = m.text as string;
  if (hasData) out.data = m.data as Record<string, unknown>;
  if (hasContext) out.context = m.context as MessageContext;
  return out;
}

export class ConversationService {
  constructor(private readonly ctx: GatewayContext) {}

  private get handler(): CompanyAgentHandler {
    const h = this.ctx.config.agent?.handler;
    if (!h) throw oauthError(OAuthError.InvalidRequest, 'conversations are not offered');
    return h;
  }

  private authOptions(subpath: string): Parameters<typeof authenticate>[2] {
    const resource = this.ctx.config.agent?.resource;
    const publicUrl = this.ctx.urls.conversations + subpath;
    return resource ? { resource, publicUrl } : { publicUrl };
  }

  /* ---------- HTTP ---------- */

  async handle(request: Request, subpath: string): Promise<Response> {
    try {
      if (!this.ctx.config.agent) return jsonResponse({ error: OAuthError.InvalidRequest, error_description: 'conversations are not offered' }, 404);
      const principal = await authenticate(this.ctx, request, this.authOptions(subpath));
      const parts = subpath.split('/').filter(Boolean);
      if (parts.length === 0) {
        if (request.method !== 'POST') return jsonResponse({ error: OAuthError.InvalidRequest }, 405);
        return await this.start(request, principal);
      }
      const id = parts[0] ?? '';
      const action = parts[1];
      if (parts.length === 2 && action === 'messages' && request.method === 'POST') return await this.message(request, principal, id);
      if (parts.length === 2 && action === 'events' && request.method === 'GET') return await this.events(request, principal, id);
      if (parts.length === 2 && action === 'handoff' && request.method === 'POST') return await this.handoff(request, principal, id);
      if (parts.length === 2 && action === 'close' && request.method === 'POST') return await this.closeByAgent(request, principal, id);
      return jsonResponse({ error: OAuthError.ConversationNotFound }, 404);
    } catch (e) {
      return errorToResponse(e);
    }
  }

  private async load(principal: Principal, id: string): Promise<ConversationRecord> {
    const c = await this.ctx.store.getConversation(id);
    if (!c || !ownerMatches(c, principal)) throw oauthError(OAuthError.ConversationNotFound, 'conversation not found');
    return c;
  }

  private async start(request: Request, principal: Principal): Promise<Response> {
    const body = await readJson<{ message?: unknown; parent_conversation_id?: unknown }>(request);
    const message = validateMessage(body.message);
    const parentId = body.parent_conversation_id;
    if (parentId !== undefined && (typeof parentId !== 'string' || !ID_PATTERN.test(parentId))) throw oauthError(OAuthError.InvalidRequest, 'parent_conversation_id is invalid');
    const url = new URL(request.url);
    const wait = this.parseWait(url);
    const cursor = url.searchParams.get('cursor') ?? undefined;

    const key = userKey(principal);
    const contentHash = sha256b64url(stableStringify(message));
    const seen = await this.ctx.store.getMessageId(key, message.id);
    if (seen) {
      if (seen.contentHash !== contentHash) throw oauthError(OAuthError.MessageIdConflict, 'message id was used with different content');
      const existing = await this.ctx.store.getConversation(seen.conversationId);
      if (existing) return this.respond(existing, 201, principal, wait, cursor);
    }

    let parent: ConversationRecord | undefined;
    if (typeof parentId === 'string') {
      parent = await this.load(principal, parentId);
      if (parent.status === ConversationStatus.Closed) throw oauthError(OAuthError.ConversationClosed, 'parent conversation is closed');
      if (parent.parentConversationId) throw oauthError(OAuthError.InvalidRequest, 'a direct conversation cannot be a parent');
      if (parent.openDirectConversationId) throw oauthError(OAuthError.DirectConversationOpen, 'parent already has an open direct conversation', { conversation_id: parent.openDirectConversationId });
      requiresAccount(parent, principal);
    }

    const nowSec = Math.floor(this.ctx.now() / 1000);
    const conversation: ConversationRecord = {
      id: randomId(IdPrefix.Conversation, 12),
      clientId: principal.clientId,
      userId: principal.userId,
      ...(principal.signedIn && principal.account ? { account: principal.account } : {}),
      status: ConversationStatus.Working,
      responder: Responder.Agent,
      context: { ...(message.context ?? {}) },
      ...(parent ? { parentConversationId: parent.id } : {}),
      handoffPending: false,
      createdAt: nowSec,
      updatedAt: nowSec,
    };
    await this.ctx.store.putConversation(conversation);
    await this.ctx.store.putMessageId(key, message.id, { conversationId: conversation.id, contentHash, createdAt: nowSec }, Defaults.MessageIdRetentionSeconds);
    if (parent) {
      await this.ctx.store.putConversation({ ...parent, openDirectConversationId: conversation.id, updatedAt: nowSec });
      await this.append(parent.id, { type: EventType.DirectOpened, conversation_id: conversation.id });
    }
    this.ctx.audit({ type: 'conversation.started', conversationId: conversation.id, clientId: principal.clientId, userId: principal.userId });
    const stored = await this.appendAgentMessage(conversation.id, message);
    await this.dispatch(conversation.id, stored, principal);
    return this.respond(conversation, 201, principal, wait, cursor);
  }

  private async message(request: Request, principal: Principal, id: string): Promise<Response> {
    const conversation = await this.load(principal, id);
    const body = await readJson<{ message?: unknown }>(request);
    const message = validateMessage(body.message);
    const url = new URL(request.url);
    const wait = this.parseWait(url);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const key = userKey(principal);
    const contentHash = sha256b64url(stableStringify(message));
    const seen = await this.ctx.store.getMessageId(key, message.id);
    if (seen) {
      if (seen.contentHash !== contentHash || seen.conversationId !== conversation.id) throw oauthError(OAuthError.MessageIdConflict, 'message id was used with different content');
      return this.respond(conversation, 202, principal, wait, cursor);
    }
    if (conversation.status === ConversationStatus.Closed) throw oauthError(OAuthError.ConversationClosed, 'conversation is closed');
    if (conversation.openDirectConversationId) throw oauthError(OAuthError.DirectConversationOpen, 'a direct conversation is open', { conversation_id: conversation.openDirectConversationId });
    requiresAccount(conversation, principal);
    const nowSec = Math.floor(this.ctx.now() / 1000);
    const updated: ConversationRecord = { ...conversation, context: { ...conversation.context, ...(message.context ?? {}) }, updatedAt: nowSec };
    if (!updated.account && principal.signedIn && principal.account) updated.account = principal.account;
    await this.ctx.store.putConversation(updated);
    await this.ctx.store.putMessageId(key, message.id, { conversationId: conversation.id, contentHash, createdAt: nowSec }, Defaults.MessageIdRetentionSeconds);
    const stored = await this.appendAgentMessage(conversation.id, message);
    await this.dispatch(conversation.id, stored, principal);
    const fresh = (await this.ctx.store.getConversation(conversation.id)) ?? updated;
    return this.respond(fresh, 202, principal, wait, cursor);
  }

  private async events(request: Request, principal: Principal, id: string): Promise<Response> {
    const conversation = await this.load(principal, id);
    const url = new URL(request.url);
    const wait = this.parseWait(url);
    const accept = request.headers.get(Header.Accept) ?? '';
    const lastEventId = request.headers.get(Header.LastEventId);
    const cursor = url.searchParams.get('cursor') ?? lastEventId ?? undefined;
    if (accept.includes(ContentType.EventStream)) return this.stream(request, conversation.id, cursor);
    return this.readResponse(conversation, 200, wait, cursor);
  }

  private async handoff(request: Request, principal: Principal, id: string): Promise<Response> {
    const conversation = await this.load(principal, id);
    await readJson(request).catch(() => ({}));
    if (conversation.status === ConversationStatus.Closed) throw oauthError(OAuthError.ConversationClosed, 'conversation is closed');
    if (conversation.openDirectConversationId) throw oauthError(OAuthError.DirectConversationOpen, 'a direct conversation is open', { conversation_id: conversation.openDirectConversationId });
    requiresAccount(conversation, principal);
    this.ctx.audit({ type: 'conversation.handoff', conversationId: conversation.id });
    const ctx = this.contextFor(conversation, principal);
    let decision: 'queued' | 'unavailable' = 'unavailable';
    try {
      decision = (await this.handler.onHandoff?.(ctx)) ?? 'unavailable';
    } catch (e) {
      this.handler.onError?.(e, conversation.id);
    }
    const current = (await this.ctx.store.getConversation(conversation.id)) ?? conversation;
    if (decision === 'queued') {
      await this.setState(current.id, ConversationStatus.Queued, current.responder, true);
    } else if (current.responder === Responder.Agent) {
      await this.appendCompanyMessage(current.id, { text: 'No one is available to join right now. The automated agent will continue.', sender: Sender.Agent });
      if (current.status !== ConversationStatus.Idle) await this.setState(current.id, ConversationStatus.Idle, current.responder, false);
    }
    const fresh = (await this.ctx.store.getConversation(conversation.id)) ?? current;
    return jsonResponse({ status: fresh.status, responder: fresh.responder }, 202);
  }

  private async closeByAgent(request: Request, principal: Principal, id: string): Promise<Response> {
    const conversation = await this.load(principal, id);
    await readJson(request).catch(() => ({}));
    const fresh = await this.close(conversation.id);
    return jsonResponse({ status: fresh.status, responder: fresh.responder }, 200);
  }

  /* ---------- Company-side API ---------- */

  /** Send a message from the company, for example from a human agent desk. */
  async sendFromCompany(conversationId: string, input: ReplyInput): Promise<StoredMessage> {
    const c = await this.ctx.store.getConversation(conversationId);
    if (!c) throw oauthError(OAuthError.ConversationNotFound, 'conversation not found');
    if (c.status === ConversationStatus.Closed) throw oauthError(OAuthError.ConversationClosed, 'conversation is closed');
    return this.appendCompanyMessage(conversationId, input);
  }

  /** A person at the company takes over (spec 7.7, 7.9). */
  async joinHuman(conversationId: string): Promise<void> {
    const c = await this.ctx.store.getConversation(conversationId);
    if (!c || c.status === ConversationStatus.Closed) throw oauthError(OAuthError.ConversationNotFound, 'conversation not found or closed');
    await this.setState(conversationId, ConversationStatus.Idle, Responder.Human, false);
  }

  /** The person leaves and the automated agent takes back over. */
  async leaveHuman(conversationId: string): Promise<void> {
    const c = await this.ctx.store.getConversation(conversationId);
    if (!c || c.status === ConversationStatus.Closed) throw oauthError(OAuthError.ConversationNotFound, 'conversation not found or closed');
    await this.setState(conversationId, ConversationStatus.Idle, Responder.Agent, false);
  }

  async requestUser(conversationId: string, reason: string): Promise<void> {
    await this.append(conversationId, { type: EventType.UserRequested, reason });
  }

  async requestAuthorization(conversationId: string, scopes?: string[]): Promise<void> {
    if (scopes && scopes.length) await this.append(conversationId, { type: EventType.Authorization, error: OAuthError.InsufficientScope, scope: joinScopes(scopes) });
    else await this.append(conversationId, { type: EventType.Authorization, error: OAuthError.SignInRequired });
  }

  async get(conversationId: string): Promise<ConversationRecord | undefined> {
    return this.ctx.store.getConversation(conversationId);
  }

  async listEvents(conversationId: string, afterCursor?: string): Promise<ConversationEvent[]> {
    return (await this.ctx.store.listEvents(conversationId, afterCursor, 1000)) ?? [];
  }

  /** Close from either side (spec 7.12). Closes an open direct conversation too and notifies the parent. */
  async close(conversationId: string): Promise<ConversationRecord> {
    const c = await this.ctx.store.getConversation(conversationId);
    if (!c) throw oauthError(OAuthError.ConversationNotFound, 'conversation not found');
    if (c.status === ConversationStatus.Closed) return c;
    if (c.openDirectConversationId) await this.close(c.openDirectConversationId);
    const nowSec = Math.floor(this.ctx.now() / 1000);
    const closed: ConversationRecord = { ...c, status: ConversationStatus.Closed, handoffPending: false, updatedAt: nowSec };
    delete closed.openDirectConversationId;
    await this.ctx.store.putConversation(closed);
    await this.append(c.id, { type: EventType.State, status: ConversationStatus.Closed, responder: c.responder });
    if (c.parentConversationId) {
      const parent = await this.ctx.store.getConversation(c.parentConversationId);
      if (parent && parent.openDirectConversationId === c.id) {
        const p: ConversationRecord = { ...parent, updatedAt: nowSec };
        delete p.openDirectConversationId;
        await this.ctx.store.putConversation(p);
        await this.append(parent.id, { type: EventType.DirectClosed, conversation_id: c.id });
      }
    }
    this.ctx.audit({ type: 'conversation.closed', conversationId: c.id });
    return closed;
  }

  /* ---------- internals ---------- */

  private parseWait(url: URL): number {
    const raw = url.searchParams.get('wait');
    if (raw === null) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw oauthError(OAuthError.InvalidRequest, 'wait must be a non-negative number of seconds');
    return Math.min(n, Defaults.MaxWaitSeconds);
  }

  private contextFor(conversation: ConversationRecord, principal: Principal): ConversationContext {
    const id = conversation.id;
    return {
      conversation,
      principal,
      reply: (input) => this.appendCompanyMessage(id, input),
      requestAuthorization: (scopes) => this.requestAuthorization(id, scopes),
      requestUser: (reason) => this.requestUser(id, reason),
      queueForHuman: async () => {
        await this.setState(id, ConversationStatus.Queued, Responder.Agent, true);
      },
      close: async () => {
        await this.close(id);
      },
    };
  }

  /** Marks the conversation working (so a `wait` holds) and runs the company agent in the background. */
  private async dispatch(conversationId: string, message: StoredMessage, principal: Principal): Promise<void> {
    const current = await this.ctx.store.getConversation(conversationId);
    if (!current || current.status === ConversationStatus.Closed) return;
    if (current.responder === Responder.Human) {
      // A person is handling it; nothing automated runs.
      if (current.status !== ConversationStatus.Idle && current.status !== ConversationStatus.Queued) await this.setState(conversationId, ConversationStatus.Idle, Responder.Human, false);
      return;
    }
    if (current.status !== ConversationStatus.Working) await this.setState(conversationId, ConversationStatus.Working, current.responder, false);
    void (async () => {
      try {
        await this.handler.onMessage(message, this.contextFor(current, principal));
      } catch (e) {
        this.handler.onError?.(e, conversationId);
      }
      const after = await this.ctx.store.getConversation(conversationId);
      if (after && after.status === ConversationStatus.Working) await this.setState(conversationId, ConversationStatus.Idle, after.responder, false);
    })();
  }

  /** Holds up to `wait` seconds while the company is still working on a reply (spec 7.3 "Replies in the response"). */
  private async awaitReply(conversationId: string, wait: number): Promise<void> {
    const deadline = this.ctx.now() + wait * 1000;
    for (;;) {
      const c = await this.ctx.store.getConversation(conversationId);
      if (!c || c.status !== ConversationStatus.Working) return;
      const remaining = deadline - this.ctx.now();
      if (remaining <= 0) return;
      await this.ctx.store.waitForEvent(conversationId, remaining);
    }
  }

  private async setState(conversationId: string, status: typeof ConversationStatus[keyof typeof ConversationStatus], responder: Responder, handoffPending: boolean): Promise<void> {
    const c = await this.ctx.store.getConversation(conversationId);
    if (!c || c.status === ConversationStatus.Closed) return;
    const changed = c.status !== status || c.responder !== responder;
    await this.ctx.store.putConversation({ ...c, status, responder, handoffPending, updatedAt: Math.floor(this.ctx.now() / 1000) });
    if (changed) await this.append(conversationId, { type: EventType.State, status, responder });
  }

  private async append(conversationId: string, body: EventBody): Promise<ConversationEvent> {
    const event = { id: randomId(IdPrefix.Event, 9), created_at: iso(this.ctx), ...body } as ConversationEvent;
    await this.ctx.store.appendEvent(conversationId, event);
    return event;
  }

  private async appendAgentMessage(conversationId: string, message: AgentMessage): Promise<StoredMessage> {
    const stored: StoredMessage = { id: message.id, role: MessageRole.User, sender: message.sender };
    if (message.text !== undefined) stored.text = message.text;
    if (message.data !== undefined) stored.data = message.data;
    if (message.context !== undefined) stored.context = message.context;
    await this.append(conversationId, { type: EventType.Message, message: stored });
    return stored;
  }

  private async appendCompanyMessage(conversationId: string, input: ReplyInput): Promise<StoredMessage> {
    const stored: StoredMessage = { id: randomId(IdPrefix.Message, 12), role: MessageRole.Company, sender: input.sender ?? Sender.Agent };
    if (input.text !== undefined) stored.text = input.text;
    if (input.data !== undefined) stored.data = input.data;
    await this.append(conversationId, { type: EventType.Message, message: stored });
    return stored;
  }

  private async respond(conversation: ConversationRecord, status: number, _principal: Principal, wait: number, cursor: string | undefined): Promise<Response> {
    if (wait > 0) {
      await this.awaitReply(conversation.id, wait);
      return this.readResponse(conversation, status, 0, cursor);
    }
    if (cursor !== undefined) return this.readResponse(conversation, status, 0, cursor);
    const fresh = (await this.ctx.store.getConversation(conversation.id)) ?? conversation;
    return jsonResponse({ conversation_id: conversation.id, status: fresh.status, responder: fresh.responder }, status);
  }

  private async readResponse(conversation: ConversationRecord, status: number, wait: number, cursor: string | undefined): Promise<Response> {
    const limit = 100;
    let events = await this.ctx.store.listEvents(conversation.id, cursor, limit + 1);
    if (events === undefined) throw oauthError(OAuthError.InvalidCursor, 'cursor is unknown for this conversation');
    if (events.length === 0 && wait > 0) {
      await this.ctx.store.waitForEvent(conversation.id, wait * 1000);
      events = (await this.ctx.store.listEvents(conversation.id, cursor, limit + 1)) ?? [];
    }
    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;
    const last = page[page.length - 1];
    const fresh = (await this.ctx.store.getConversation(conversation.id)) ?? conversation;
    const body: Record<string, unknown> = {
      conversation_id: conversation.id,
      events: page,
      cursor: last ? last.id : (cursor ?? null),
      has_more: hasMore,
      status: fresh.status,
      responder: fresh.responder,
    };
    return jsonResponse(body, status);
  }

  private stream(request: Request, conversationId: string, cursor: string | undefined): Response {
    const ctx = this.ctx;
    const encoder = new TextEncoder();
    const maxDurationMs = 5 * 60 * 1000;
    const started = ctx.now();
    let last = cursor;
    const streamBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (e: ConversationEvent): void => {
          controller.enqueue(encoder.encode(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`));
          last = e.id;
        };
        try {
          const initial = await ctx.store.listEvents(conversationId, cursor, 1000);
          if (initial === undefined) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: OAuthError.InvalidCursor })}\n\n`));
            controller.close();
            return;
          }
          for (const e of initial) send(e);
          for (;;) {
            if (request.signal.aborted) break;
            const c = await ctx.store.getConversation(conversationId);
            if (!c || c.status === ConversationStatus.Closed) break;
            if (ctx.now() - started > maxDurationMs) break;
            await ctx.store.waitForEvent(conversationId, 15_000);
            const fresh = (await ctx.store.listEvents(conversationId, last, 1000)) ?? [];
            if (fresh.length === 0) controller.enqueue(encoder.encode(': keep-alive\n\n'));
            for (const e of fresh) send(e);
          }
        } catch (e) {
          if (!(e instanceof PoppyError)) ctx.config.agent?.handler.onError?.(e, conversationId);
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      },
    });
    return new Response(streamBody, {
      status: 200,
      headers: { [Header.ContentType]: ContentType.EventStream, [Header.CacheControl]: 'no-store', Connection: 'keep-alive' },
    });
  }
}
