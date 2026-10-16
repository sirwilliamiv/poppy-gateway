import { MessageRole, type ConversationContext, type ReplyInput, type StoredMessage } from '../../src/index.js';
import { CATALOG, FAQ, FaqId, quote } from './catalog.js';
import {
  BuyerIntent,
  CloseReason,
  DISCOUNT_FLOOR_PERCENT,
  ENGAGEMENT_IDS,
  FixedReply,
  HandoffTrigger,
  LeadOutcome,
  NegotiationAction,
  NegotiationEvent,
  NegotiationLogType,
  NegotiationState,
  type ActionEvidence,
  type FieldName,
  type Lead,
  type Negotiator,
  type NegotiatorDeps,
  type NegotiationRecord,
  type Quote,
  type WriterInput,
} from './contracts.js';
import { createExtractor } from './extractor.js';
import { ActionNotAllowedError, assertAllowed, missingFields, newRecord, transition } from './machine.js';
import { buildProposal, proposalData } from './proposal.js';
import { createWriter, errorRef, quoteLines } from './writer.js';

/** Answer sources that are not FAQ entries. */
export const AnswerSource = {
  DiscountPolicy: 'discount_policy',
  Catalog: 'catalog',
} as const;
export type AnswerSource = (typeof AnswerSource)[keyof typeof AnswerSource];

/** Deterministic replies the handler writes itself. None contains a price that is not in the quote. */
export const HandlerReply = {
  DiscountPolicy: 'The catalog allows a discount only when you prepay or combine two or more engagements. Your quote stands as follows.',
  ChooseEngagement: 'Thanks, I have what I need to scope this. Which engagement would you like a quote for? The catalog has: ',
} as const;

const HandoffReply = {
  [HandoffTrigger.FloorBreached]: FixedReply.BelowFloor,
  [HandoffTrigger.StartDateAsked]: FixedReply.StartDate,
  [HandoffTrigger.BuyerAskedForPerson]: FixedReply.Queued,
  [HandoffTrigger.CustomScope]: FixedReply.Queued,
  [HandoffTrigger.Accepted]: FixedReply.Queued,
} as const satisfies Record<HandoffTrigger, FixedReply>;

const FAQ_KEYWORDS: ReadonlyArray<{ id: FaqId; pattern: RegExp }> = [
  { id: FaqId.IsFinal, pattern: /\b(final|draft|stable|1\.0|version|change)\b/i },
  { id: FaqId.ReplaceIdp, pattern: /\b(identity provider|idp|okta|auth0|cognito|replace|sso)\b/i },
  { id: FaqId.Mcp, pattern: /\bmcp\b/i },
  { id: FaqId.ReadOnlyStart, pattern: /\b(read[- ]?only|writes?|poppy:write)\b/i },
  { id: FaqId.DataLocation, pattern: /\b(data|host|hosting|cloud|where)\b/i },
];

const ENGAGEMENT_NAMES = ENGAGEMENT_IDS.map((id) => CATALOG[id].name).join(', ');

/** What onHandoff returns to the gateway. */
export const HandoffDecision = {
  Queued: 'queued',
} as const;

export const HandlerLogType = {
  HandlerError: 'negotiation.handler_error',
} as const;

const DEFAULT_FAQ: FaqId = FaqId.IsFinal;
const BUNDLE_MIN_ENGAGEMENTS = 2;

function faqFor(text: string): FaqId {
  return FAQ_KEYWORDS.find((k) => k.pattern.test(text))?.id ?? DEFAULT_FAQ;
}

/** What one turn decided: the company reply, plus an optional handoff or close after it is sent. */
interface Turn {
  reply: ReplyInput;
  handoff?: HandoffTrigger;
  close?: CloseReason;
}

export function createNegotiator(deps: NegotiatorDeps): Negotiator {
  const { store, leads, log } = deps;
  const now = (): number => deps.now?.() ?? Date.now();
  const iso = (): string => new Date(now()).toISOString();
  const extractor = createExtractor(deps.model, deps.budget, deps.log);
  const writer = createWriter(deps.model, deps.budget, deps.log);

  const move = (record: NegotiationRecord, event: NegotiationEvent): boolean => {
    const from = record.state;
    const to = transition(from, event);
    if (to === undefined) return false;
    record.state = to;
    log.event({ type: NegotiationLogType.Transition, conversationId: record.conversationId, from, to, event });
    return true;
  };

  const allowed = (record: NegotiationRecord, evidence: ActionEvidence, state: NegotiationState = record.state): boolean => {
    try {
      assertAllowed(evidence, state);
      return true;
    } catch (e) {
      if (!(e instanceof ActionNotAllowedError)) throw e;
      log.event({ type: NegotiationLogType.ActionDenied, conversationId: record.conversationId, action: e.action, state: e.state, reason: e.reason });
      return false;
    }
  };

  const write = (record: NegotiationRecord, action: NegotiationAction, missing: FieldName[], lastMessage: string): Promise<string> => {
    const input: WriterInput = { conversationId: record.conversationId, state: record.state, action, fields: record.fields, missing, lastMessage };
    if (record.quote) input.quote = record.quote;
    return writer.write(input);
  };

  /** Used when the action a turn wanted is denied: Ask where it is allowed, else a fixed reply. */
  const fallback = async (record: NegotiationRecord, text: string): Promise<Turn> => {
    if (allowed(record, { action: NegotiationAction.Ask })) return { reply: { text: await write(record, NegotiationAction.Ask, missingFields(record.fields), text) } };
    if (record.quote) return { reply: { text: FixedReply.GroundingFailed + '\n' + quoteLines(record.quote) } };
    return { reply: { text: FixedReply.ModelUnavailable } };
  };

  const answerFaq = (record: NegotiationRecord, text: string): Turn | undefined => {
    const id = faqFor(text);
    if (!allowed(record, { action: NegotiationAction.Answer, sourceId: id })) return undefined;
    return { reply: { text: FAQ[id].answer } };
  };

  const handoff = (record: NegotiationRecord, trigger: HandoffTrigger, event: NegotiationEvent): Turn | undefined => {
    if (!allowed(record, { action: NegotiationAction.Handoff, trigger })) return undefined;
    if (!move(record, event)) return undefined;
    record.handoffTrigger = trigger;
    return { reply: { text: HandoffReply[trigger] }, handoff: trigger };
  };

  const requote = async (record: NegotiationRecord, text: string): Promise<Turn | undefined> => {
    const engagements = record.fields.engagements;
    if (!allowed(record, { action: NegotiationAction.Quote, engagements })) return undefined;
    record.quote = quote({ engagements, prepay: record.fields.prepay });
    return { reply: { text: await write(record, NegotiationAction.Quote, [], text) } };
  };

  const scoping = async (record: NegotiationRecord, text: string): Promise<Turn | undefined> => {
    const { fields } = record;
    const missing = missingFields(fields);
    if (missing.length === 0 && fields.engagements.length > 0) {
      if (!allowed(record, { action: NegotiationAction.Quote, engagements: fields.engagements })) return undefined;
      move(record, NegotiationEvent.FieldsComplete);
      record.quote = quote({ engagements: fields.engagements, prepay: fields.prepay });
      return { reply: { text: await write(record, NegotiationAction.Quote, [], text) } };
    }
    move(record, NegotiationEvent.FieldsMissing);
    if (fields.intent === BuyerIntent.Question) return answerFaq(record, text);
    if (!allowed(record, { action: NegotiationAction.Ask })) return undefined;
    if (missing.length === 0) return { reply: { text: HandlerReply.ChooseEngagement + ENGAGEMENT_NAMES + '.' } };
    return { reply: { text: await write(record, NegotiationAction.Ask, missing, text) } };
  };

  const quoted = async (record: NegotiationRecord, text: string, q: Quote): Promise<Turn | undefined> => {
    const { fields } = record;
    switch (fields.intent) {
      case BuyerIntent.Accept: {
        if (!allowed(record, { action: NegotiationAction.Propose, fields, quote: q })) return undefined;
        move(record, NegotiationEvent.BuyerAccepted);
        const proposal = buildProposal(fields, q, now());
        return { reply: { text: await write(record, NegotiationAction.Propose, [], text), data: proposalData(proposal) } };
      }
      case BuyerIntent.Negotiate: {
        const belowFloor =
          (fields.askedDiscountPercent !== null && fields.askedDiscountPercent > DISCOUNT_FLOOR_PERCENT) ||
          (fields.askedPriceUsd !== null && fields.askedPriceUsd < q.floorUsd);
        if (belowFloor) return handoff(record, HandoffTrigger.FloorBreached, NegotiationEvent.BelowFloor);
        if (fields.prepay || fields.engagements.length >= BUNDLE_MIN_ENGAGEMENTS) return requote(record, text);
        if (!allowed(record, { action: NegotiationAction.Answer, sourceId: AnswerSource.DiscountPolicy })) return undefined;
        return { reply: { text: HandlerReply.DiscountPolicy + '\n' + quoteLines(q) } };
      }
      case BuyerIntent.StartDate:
        return handoff(record, HandoffTrigger.StartDateAsked, NegotiationEvent.StartDateAsked);
      case BuyerIntent.Question:
        return answerFaq(record, text);
      case BuyerIntent.Quote:
        if (fields.engagements.length > 0) return requote(record, text);
        break;
    }
    if (!allowed(record, { action: NegotiationAction.Answer, sourceId: AnswerSource.Catalog })) return undefined;
    return { reply: { text: await write(record, NegotiationAction.Answer, [], text) } };
  };

  const proposed = async (record: NegotiationRecord, text: string): Promise<Turn | undefined> => {
    switch (record.fields.intent) {
      case BuyerIntent.StartDate:
        return handoff(record, HandoffTrigger.StartDateAsked, NegotiationEvent.StartDateAsked);
      case BuyerIntent.Decline: {
        if (!allowed(record, { action: NegotiationAction.Close, reason: CloseReason.BuyerDeclined })) return undefined;
        if (!move(record, NegotiationEvent.BuyerDeclined)) return undefined;
        record.closeReason = CloseReason.BuyerDeclined;
        return { reply: { text: FixedReply.Closed }, close: CloseReason.BuyerDeclined };
      }
      case BuyerIntent.Question:
        return answerFaq(record, text);
    }
    if (!allowed(record, { action: NegotiationAction.Answer, sourceId: AnswerSource.Catalog })) return undefined;
    return { reply: { text: await write(record, NegotiationAction.Answer, [], text) } };
  };

  const decide = async (record: NegotiationRecord, text: string): Promise<Turn | undefined> => {
    if (record.fields.intent === BuyerIntent.Person) return handoff(record, HandoffTrigger.BuyerAskedForPerson, NegotiationEvent.BuyerAskedForPerson);
    if (record.state === NegotiationState.Intake) move(record, NegotiationEvent.FirstMessageParsed);
    switch (record.state) {
      case NegotiationState.Scoping:
        return scoping(record, text);
      case NegotiationState.Quote:
        return record.quote ? quoted(record, text, record.quote) : scoping(record, text);
      case NegotiationState.Proposal:
        return proposed(record, text);
      default:
        return undefined;
    }
  };

  const toLead = (record: NegotiationRecord, trigger: HandoffTrigger): Lead => {
    const lead: Lead = {
      conversationId: record.conversationId,
      clientId: record.clientId,
      trigger,
      fields: record.fields,
      transcript: record.transcript,
      createdAt: new Date(record.createdAt).toISOString(),
    };
    if (record.quote) lead.quote = record.quote;
    return lead;
  };

  const sendLead = async (record: NegotiationRecord, trigger: HandoffTrigger): Promise<void> => {
    await store.put(record);
    const outcome = await leads.send(toLead(record, trigger), record);
    if (outcome === LeadOutcome.Sent || outcome === LeadOutcome.Fallback) record.leadSent = true;
    record.updatedAt = now();
    await store.put(record);
  };

  const loadRecord = async (ctx: ConversationContext): Promise<NegotiationRecord> => {
    const id = ctx.conversation.id;
    return (await store.get(id)) ?? newRecord(id, ctx.principal.clientId, ctx.principal.userId, now());
  };

  return {
    async onMessage(message: StoredMessage, ctx: ConversationContext): Promise<void> {
      const record = await loadRecord(ctx);
      if (record.state === NegotiationState.Closed) return;
      const text = message.text ?? (message.data ? JSON.stringify(message.data) : '');
      record.transcript.push({ role: message.role, text, at: iso() });

      let turn: Turn;
      if (record.state === NegotiationState.Handoff) {
        turn = { reply: { text: FixedReply.Queued } };
      } else {
        record.fields = await extractor.extract(text, record.fields, record.conversationId);
        turn = (await decide(record, text)) ?? (await fallback(record, text));
      }

      record.transcript.push({ role: MessageRole.Company, text: turn.reply.text ?? '', at: iso() });
      record.updatedAt = now();
      await store.put(record);
      await ctx.reply(turn.reply);

      if (turn.handoff !== undefined) {
        await sendLead(record, turn.handoff);
        await ctx.queueForHuman();
      }
      if (turn.close !== undefined) await ctx.close();
    },

    async onHandoff(ctx: ConversationContext): Promise<typeof HandoffDecision.Queued> {
      const record = await loadRecord(ctx);
      if (record.state === NegotiationState.Closed) return HandoffDecision.Queued;
      const trigger = HandoffTrigger.BuyerAskedForPerson;
      if (move(record, NegotiationEvent.BuyerAskedForPerson)) record.handoffTrigger = trigger;
      record.updatedAt = now();
      await sendLead(record, record.handoffTrigger ?? trigger);
      return HandoffDecision.Queued;
    },

    onError(error: unknown, conversationId: string): void {
      const errorClass = error instanceof Error ? error.constructor.name : typeof error;
      console.error(JSON.stringify({ type: HandlerLogType.HandlerError, conversationId, ref: errorRef(), errorClass }));
    },
  };
}
