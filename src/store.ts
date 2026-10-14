import type {
  AccountTokenRecord,
  AuthorizationCodeRecord,
  AuthorizationRequestRecord,
  BrowserCookieRecord,
  ConversationEvent,
  ConversationRecord,
  DeviceCodeRecord,
  MediatedSignInRecord,
  MessageIdRecord,
  SessionRecord,
} from './types.js';

/**
 * Persistence boundary. Every method is async so a Redis or SQL implementation
 * can replace MemoryStore without touching the protocol code. Records are
 * returned as copies; callers must write them back with the matching put.
 */
export interface Store {
  getSession(id: string): Promise<SessionRecord | undefined>;
  putSession(record: SessionRecord): Promise<void>;
  /** Sign out every session signed in with this account token (by account and client). */
  signOutSessions(clientId: string, account: string): Promise<void>;

  getAccountToken(hash: string): Promise<AccountTokenRecord | undefined>;
  putAccountToken(record: AccountTokenRecord): Promise<void>;
  revokeAccountTokens(filter: { clientId?: string; account: string }): Promise<string[]>;

  getAuthorizationRequest(id: string): Promise<AuthorizationRequestRecord | undefined>;
  putAuthorizationRequest(record: AuthorizationRequestRecord): Promise<void>;
  deleteAuthorizationRequest(id: string): Promise<void>;

  getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined>;
  putAuthorizationCode(record: AuthorizationCodeRecord): Promise<void>;

  getDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | undefined>;
  getDeviceCodeByUserCode(userCode: string): Promise<DeviceCodeRecord | undefined>;
  putDeviceCode(record: DeviceCodeRecord): Promise<void>;
  deleteDeviceCode(deviceCode: string): Promise<void>;

  getMediatedSignIn(id: string): Promise<MediatedSignInRecord | undefined>;
  putMediatedSignIn(record: MediatedSignInRecord): Promise<void>;
  deleteMediatedSignIn(id: string): Promise<void>;

  getBrowserCookie(value: string): Promise<BrowserCookieRecord | undefined>;
  putBrowserCookie(record: BrowserCookieRecord): Promise<void>;

  /** Returns true if the key was not seen before and records it until ttl passes. */
  claimOnce(key: string, ttlSeconds: number): Promise<boolean>;
  /** Returns true if a claimed key is still live. */
  peek(key: string): Promise<boolean>;
  /** Sliding counter used for rate limits. Returns the count after increment. */
  increment(key: string, ttlSeconds: number): Promise<number>;

  getConversation(id: string): Promise<ConversationRecord | undefined>;
  putConversation(record: ConversationRecord): Promise<void>;
  appendEvent(conversationId: string, event: ConversationEvent): Promise<void>;
  /** Events strictly after the cursor. Returns undefined if the cursor is unknown. */
  listEvents(conversationId: string, afterCursor?: string, limit?: number): Promise<ConversationEvent[] | undefined>;
  /** Resolves when a new event is appended or the timeout passes. */
  waitForEvent(conversationId: string, timeoutMs: number): Promise<void>;

  getMessageId(userKey: string, messageId: string): Promise<MessageIdRecord | undefined>;
  putMessageId(userKey: string, messageId: string, record: MessageIdRecord, ttlSeconds: number): Promise<void>;
}

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

/** In-memory store for development, tests, and single-instance deployments. */
export class MemoryStore implements Store {
  private sessions = new Map<string, SessionRecord>();
  private accountTokens = new Map<string, AccountTokenRecord>();
  private authRequests = new Map<string, AuthorizationRequestRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private deviceCodes = new Map<string, DeviceCodeRecord>();
  private mediated = new Map<string, MediatedSignInRecord>();
  private cookies = new Map<string, BrowserCookieRecord>();
  private once = new Map<string, number>();
  private counters = new Map<string, Expiring<number>>();
  private conversations = new Map<string, ConversationRecord>();
  private events = new Map<string, ConversationEvent[]>();
  private waiters = new Map<string, Set<() => void>>();
  private messageIds = new Map<string, Expiring<MessageIdRecord>>();

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const r = this.sessions.get(id);
    return r ? { ...r, scopes: [...r.scopes] } : undefined;
  }
  async putSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.id, { ...record, scopes: [...record.scopes] });
  }
  async signOutSessions(clientId: string, account: string): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.clientId === clientId && s.account === account) {
        delete s.account;
        s.scopes = [];
      }
    }
  }

  async getAccountToken(hash: string): Promise<AccountTokenRecord | undefined> {
    const r = this.accountTokens.get(hash);
    return r ? { ...r, scopes: [...r.scopes] } : undefined;
  }
  async putAccountToken(record: AccountTokenRecord): Promise<void> {
    this.accountTokens.set(record.hash, { ...record, scopes: [...record.scopes] });
  }
  async revokeAccountTokens(filter: { clientId?: string; account: string }): Promise<string[]> {
    const revoked: string[] = [];
    for (const t of this.accountTokens.values()) {
      if (t.account === filter.account && (!filter.clientId || t.clientId === filter.clientId) && !t.revoked) {
        t.revoked = true;
        revoked.push(t.hash);
      }
    }
    return revoked;
  }

  async getAuthorizationRequest(id: string): Promise<AuthorizationRequestRecord | undefined> {
    const r = this.authRequests.get(id);
    return r ? { ...r } : undefined;
  }
  async putAuthorizationRequest(record: AuthorizationRequestRecord): Promise<void> {
    this.authRequests.set(record.id, { ...record });
  }
  async deleteAuthorizationRequest(id: string): Promise<void> {
    this.authRequests.delete(id);
  }

  async getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const r = this.authCodes.get(code);
    return r ? { ...r } : undefined;
  }
  async putAuthorizationCode(record: AuthorizationCodeRecord): Promise<void> {
    this.authCodes.set(record.code, { ...record });
  }

  async getDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | undefined> {
    const r = this.deviceCodes.get(deviceCode);
    return r ? { ...r } : undefined;
  }
  async getDeviceCodeByUserCode(userCode: string): Promise<DeviceCodeRecord | undefined> {
    for (const r of this.deviceCodes.values()) if (r.userCode === userCode) return { ...r };
    return undefined;
  }
  async putDeviceCode(record: DeviceCodeRecord): Promise<void> {
    this.deviceCodes.set(record.deviceCode, { ...record });
  }
  async deleteDeviceCode(deviceCode: string): Promise<void> {
    this.deviceCodes.delete(deviceCode);
  }

  async getMediatedSignIn(id: string): Promise<MediatedSignInRecord | undefined> {
    const r = this.mediated.get(id);
    return r ? { ...r } : undefined;
  }
  async putMediatedSignIn(record: MediatedSignInRecord): Promise<void> {
    this.mediated.set(record.id, { ...record });
  }
  async deleteMediatedSignIn(id: string): Promise<void> {
    this.mediated.delete(id);
  }

  async getBrowserCookie(value: string): Promise<BrowserCookieRecord | undefined> {
    const r = this.cookies.get(value);
    if (!r) return undefined;
    if (r.expiresAt < Date.now()) {
      this.cookies.delete(value);
      return undefined;
    }
    return { ...r };
  }
  async putBrowserCookie(record: BrowserCookieRecord): Promise<void> {
    this.cookies.set(record.value, { ...record });
  }

  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    this.sweepOnce(now);
    if (this.once.has(key)) return false;
    this.once.set(key, now + ttlSeconds * 1000);
    return true;
  }
  async peek(key: string): Promise<boolean> {
    const exp = this.once.get(key);
    return exp !== undefined && exp >= Date.now();
  }
  private sweepOnce(now: number): void {
    if (this.once.size < 10000) return;
    for (const [k, exp] of this.once) if (exp < now) this.once.delete(k);
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const cur = this.counters.get(key);
    if (!cur || cur.expiresAt < now) {
      this.counters.set(key, { value: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    cur.value += 1;
    return cur.value;
  }

  async getConversation(id: string): Promise<ConversationRecord | undefined> {
    const r = this.conversations.get(id);
    return r ? { ...r, context: { ...r.context } } : undefined;
  }
  async putConversation(record: ConversationRecord): Promise<void> {
    this.conversations.set(record.id, { ...record, context: { ...record.context } });
  }
  async appendEvent(conversationId: string, event: ConversationEvent): Promise<void> {
    const list = this.events.get(conversationId) ?? [];
    list.push(event);
    this.events.set(conversationId, list);
    const ws = this.waiters.get(conversationId);
    if (ws) {
      for (const w of ws) w();
      ws.clear();
    }
  }
  async listEvents(conversationId: string, afterCursor?: string, limit = 100): Promise<ConversationEvent[] | undefined> {
    const list = this.events.get(conversationId) ?? [];
    let start = 0;
    if (afterCursor !== undefined) {
      const idx = list.findIndex((e) => e.id === afterCursor);
      if (idx === -1) return undefined;
      start = idx + 1;
    }
    return list.slice(start, start + limit);
  }
  async waitForEvent(conversationId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiters.get(conversationId) ?? new Set();
      this.waiters.set(conversationId, set);
      const timer = setTimeout(() => {
        set.delete(wake);
        resolve();
      }, timeoutMs);
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      set.add(wake);
    });
  }

  async getMessageId(userKey: string, messageId: string): Promise<MessageIdRecord | undefined> {
    const r = this.messageIds.get(userKey + '\u0000' + messageId);
    if (!r) return undefined;
    if (r.expiresAt < Date.now()) return undefined;
    return { ...r.value };
  }
  async putMessageId(userKey: string, messageId: string, record: MessageIdRecord, ttlSeconds: number): Promise<void> {
    this.messageIds.set(userKey + '\u0000' + messageId, { value: { ...record }, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}
