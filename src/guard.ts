/**
 * Abuse guard for company agent handlers. Wraps any CompanyAgentHandler and refuses, before any model runs,
 * messages that exceed per-session, per-client or daily caps. Contract is frozen; implementation fills the functions.
 */
import type { CompanyAgentHandler, ConversationContext } from './conversations.js';
import type { Store } from './store.js';
import type { AuditEvent, StoredMessage } from './types.js';

export const GuardVerdict = {
  Allow: 'allow',
  MessagesPerSession: 'messages_per_session',
  ConversationsPerClient: 'conversations_per_client',
  MessageTooLong: 'message_too_long',
} as const;
export type GuardVerdict = (typeof GuardVerdict)[keyof typeof GuardVerdict];
export type GuardRefusalVerdict = Exclude<GuardVerdict, typeof GuardVerdict.Allow>;

export const GuardRefusal: Record<GuardRefusalVerdict, string> = {
  [GuardVerdict.MessagesPerSession]: 'This conversation has reached its hourly message limit. Please continue in an hour.',
  [GuardVerdict.ConversationsPerClient]: 'This agent has opened its daily limit of conversations with us. Please try again tomorrow.',
  [GuardVerdict.MessageTooLong]: 'That message is too long for me to read. Please keep messages under 4,000 characters.',
};

export const InjectionFlag = {
  IgnoreRules: 'ignore_rules',
  SystemPrompt: 'system_prompt',
  Exfiltrate: 'exfiltrate',
  SetPrice: 'set_price',
  RoleSwap: 'role_swap',
} as const;
export type InjectionFlag = (typeof InjectionFlag)[keyof typeof InjectionFlag];

/** Patterns that never block a message; they add flags to the audit line so abuse is visible. */
export const InjectionPattern: ReadonlyArray<{ flag: InjectionFlag; pattern: RegExp }> = [
  { flag: InjectionFlag.IgnoreRules, pattern: /\b(ignore|disregard|forget)\b[^.]{0,40}\b(rules|instructions|guidelines|previous)\b/i },
  { flag: InjectionFlag.SystemPrompt, pattern: /\b(system prompt|developer message|your instructions|hidden prompt)\b/i },
  { flag: InjectionFlag.Exfiltrate, pattern: /\b(send|email|forward|post|leak)\b[^.]{0,60}\b(transcript|conversation|api key|secret|password|other (buyers?|customers?|quotes?))\b/i },
  { flag: InjectionFlag.SetPrice, pattern: /\b(the )?price (is|will be|should be|=)\s*\$?\s*\d/i },
  { flag: InjectionFlag.RoleSwap, pattern: /\b(you are now|act as|pretend (to be|you are)|new persona)\b/i },
];

export interface GuardOptions {
  store: Pick<Store, 'increment'>;
  messagesPerSessionPerHour: number;
  conversationsPerClientPerDay: number;
  /** Model calls across every conversation per UTC day. reserveModelCall returns false past this. */
  modelCallsPerDay: number;
  maxMessageChars: number;
  audit?: (event: AuditEvent) => void;
  now?: () => number;
}

export interface ConversationGuard {
  /** Runs check on every message; on a refusal replies with the fixed sentence and never calls the inner handler. */
  wrap(handler: CompanyAgentHandler): CompanyAgentHandler;
  /** Pure decision for one message: counts it against the caps and returns the verdict. */
  check(message: StoredMessage, ctx: ConversationContext): Promise<GuardVerdict>;
  /** Counts one model call against the daily budget. False means the cap is reached and no call may be made. */
  reserveModelCall(): Promise<boolean>;
}

/** Returns the injection flags present in a message text. Never throws. */
export function injectionFlags(text: string): InjectionFlag[] {
  const flags: InjectionFlag[] = [];
  for (const { flag, pattern } of InjectionPattern) if (pattern.test(text)) flags.push(flag);
  return flags;
}

export const GuardKey = {
  Conversation: 'guard:conv:',
  Client: 'guard:client:',
  Messages: 'guard:msgs:',
  ConversationMessages: 'guard:convmsgs:',
  Model: 'guard:model:',
} as const;
export type GuardKey = (typeof GuardKey)[keyof typeof GuardKey];

const DAY_SECONDS = 86400;
const HOUR_SECONDS = 3600;
const AuditType = { Refused: 'guard.refused', Flagged: 'guard.flagged' } as const;

export function createGuard(options: GuardOptions): ConversationGuard {
  const { store } = options;
  const nowMs = (): number => options.now?.() ?? Date.now();
  const utcDay = (): string => new Date(nowMs()).toISOString().slice(0, 10);
  const utcHour = (): string => new Date(nowMs()).toISOString().slice(0, 13);
  const audit = (event: AuditEvent): void => options.audit?.(event);

  async function check(message: StoredMessage, ctx: ConversationContext): Promise<GuardVerdict> {
    if ((message.text ?? '').length > options.maxMessageChars) return GuardVerdict.MessageTooLong;
    const { clientId, sessionId } = ctx.principal;
    const seen = await store.increment(GuardKey.Conversation + clientId + ':' + ctx.conversation.id, DAY_SECONDS);
    if (seen === 1) {
      const opened = await store.increment(GuardKey.Client + clientId + ':' + utcDay(), DAY_SECONDS);
      if (opened > options.conversationsPerClientPerDay) return GuardVerdict.ConversationsPerClient;
    }
    const hour = utcHour();
    const bySession = await store.increment(GuardKey.Messages + sessionId + ':' + hour, HOUR_SECONDS);
    // A conversation outlives any one session token, so the hourly cap also follows the conversation; otherwise minting a fresh session per message resets it.
    const byConversation = await store.increment(GuardKey.ConversationMessages + clientId + ':' + ctx.conversation.id + ':' + hour, HOUR_SECONDS);
    if (bySession > options.messagesPerSessionPerHour || byConversation > options.messagesPerSessionPerHour) return GuardVerdict.MessagesPerSession;
    return GuardVerdict.Allow;
  }

  function wrap(handler: CompanyAgentHandler): CompanyAgentHandler {
    const wrapped: CompanyAgentHandler = {
      async onMessage(message, ctx) {
        const flags = injectionFlags(message.text ?? '');
        const verdict = await check(message, ctx);
        const conversationId = ctx.conversation.id;
        const clientId = ctx.principal.clientId;
        if (verdict !== GuardVerdict.Allow) {
          await ctx.reply({ text: GuardRefusal[verdict] });
          audit({ type: AuditType.Refused, conversationId, clientId, verdict, flags });
          // The refused conversation is already counted as seen, so later messages on it would not be new; close it so the gateway rejects them.
          if (verdict === GuardVerdict.ConversationsPerClient) await ctx.close();
          return;
        }
        if (flags.length > 0) audit({ type: AuditType.Flagged, conversationId, clientId, flags });
        await handler.onMessage(message, ctx);
      },
    };
    const { onHandoff, onError } = handler;
    if (onHandoff) wrapped.onHandoff = (ctx) => onHandoff.call(handler, ctx);
    if (onError) wrapped.onError = (error, conversationId) => onError.call(handler, error, conversationId);
    return wrapped;
  }

  async function reserveModelCall(): Promise<boolean> {
    return (await store.increment(GuardKey.Model + utcDay(), DAY_SECONDS)) <= options.modelCallsPerDay;
  }

  return { wrap, check, reserveModelCall };
}
