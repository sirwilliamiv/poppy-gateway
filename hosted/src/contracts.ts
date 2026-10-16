/**
 * Frozen contracts for the Origin Platform Labs negotiating agent.
 * Types, const maps and interfaces only. No logic lives here.
 */
import { z } from 'zod';
import type { CompanyAgentHandler, StoredMessage, Store } from '../../src/index.js';

/* ---------- Catalog ---------- */

export const EngagementId = {
  PilotWeek: 'pilot_week',
  Readiness: 'readiness_assessment',
  Gateway: 'gateway_implementation',
  CompanyAgent: 'company_agent',
  Retainer: 'retainer',
} as const;
export type EngagementId = (typeof EngagementId)[keyof typeof EngagementId];
export const ENGAGEMENT_IDS = Object.values(EngagementId) as [EngagementId, ...EngagementId[]];

export const Billing = {
  /** One fixed price. */
  Fixed: 'fixed',
  /** List price is the starting point; scope decides the final number, so a quote above list is a handoff. */
  From: 'from',
  /** Per month. */
  Monthly: 'monthly',
} as const;
export type Billing = (typeof Billing)[keyof typeof Billing];

export interface Engagement {
  id: EngagementId;
  name: string;
  listUsd: number;
  billing: Billing;
  summary: string;
  /** What is included, as the landing page states it. */
  scope: string[];
}

/** Largest discount the agent may ever grant, in percent off list. Below this is a handoff. */
export const DISCOUNT_FLOOR_PERCENT = 10;

export const DiscountReason = {
  None: 'none',
  Prepay: 'prepay',
  Bundle: 'bundle',
} as const;
export type DiscountReason = (typeof DiscountReason)[keyof typeof DiscountReason];

export interface QuoteTerms {
  engagements: EngagementId[];
  prepay: boolean;
}

export interface QuoteLine {
  engagement: EngagementId;
  name: string;
  listUsd: number;
  billing: Billing;
}

export interface Quote {
  lines: QuoteLine[];
  listTotalUsd: number;
  discountPercent: number;
  discountReason: DiscountReason;
  totalUsd: number;
  /** listTotalUsd less DISCOUNT_FLOOR_PERCENT, rounded to whole dollars. */
  floorUsd: number;
}

/* ---------- Extraction ---------- */

export const BuyerIntent = {
  Scope: 'scope',
  Quote: 'quote',
  Negotiate: 'negotiate',
  Accept: 'accept',
  Decline: 'decline',
  Person: 'person',
  Question: 'question',
  StartDate: 'start_date',
  Other: 'other',
} as const;
export type BuyerIntent = (typeof BuyerIntent)[keyof typeof BuyerIntent];
export const BUYER_INTENTS = Object.values(BuyerIntent) as [BuyerIntent, ...BuyerIntent[]];

export const FieldsSchema = z.object({
  company: z.string().min(1).nullable(),
  sells: z.string().min(1).nullable(),
  apis: z.string().min(1).nullable(),
  idp: z.string().min(1).nullable(),
  timeline: z.string().min(1).nullable(),
  budgetUsd: z.number().nonnegative().nullable(),
  contact: z.string().min(1).nullable(),
  engagements: z.array(z.enum(ENGAGEMENT_IDS)),
  /** A number the buyer proposed, for example "can you do 60k". */
  askedPriceUsd: z.number().nonnegative().nullable(),
  /** Set when the buyer asks for a discount without naming a number. */
  askedDiscountPercent: z.number().min(0).max(100).nullable(),
  prepay: z.boolean(),
  intent: z.enum(BUYER_INTENTS),
});
export type Fields = z.infer<typeof FieldsSchema>;

export const FieldName = {
  Company: 'company',
  Sells: 'sells',
  Apis: 'apis',
  Idp: 'idp',
  Timeline: 'timeline',
  BudgetUsd: 'budgetUsd',
  Contact: 'contact',
} as const;
export type FieldName = (typeof FieldName)[keyof typeof FieldName];

export const EMPTY_FIELDS: Fields = {
  company: null,
  sells: null,
  apis: null,
  idp: null,
  timeline: null,
  budgetUsd: null,
  contact: null,
  engagements: [],
  askedPriceUsd: null,
  askedDiscountPercent: null,
  prepay: false,
  intent: BuyerIntent.Other,
};

/* ---------- State machine ---------- */

export const NegotiationState = {
  Intake: 'intake',
  Scoping: 'scoping',
  Quote: 'quote',
  Proposal: 'proposal',
  Handoff: 'handoff',
  Closed: 'closed',
} as const;
export type NegotiationState = (typeof NegotiationState)[keyof typeof NegotiationState];

export const NegotiationEvent = {
  FirstMessageParsed: 'first_message_parsed',
  FieldsMissing: 'fields_missing',
  FieldsComplete: 'fields_complete',
  BuyerAccepted: 'buyer_accepted',
  BelowFloor: 'below_floor',
  CustomScope: 'custom_scope',
  StartDateAsked: 'start_date_asked',
  BuyerDeclined: 'buyer_declined',
  BuyerAskedForPerson: 'buyer_asked_for_person',
  HumanClosed: 'human_closed',
  IdleExpired: 'idle_expired',
} as const;
export type NegotiationEvent = (typeof NegotiationEvent)[keyof typeof NegotiationEvent];

export const NegotiationAction = {
  Ask: 'ask',
  Answer: 'answer',
  Quote: 'quote',
  Propose: 'propose',
  Handoff: 'handoff',
  Close: 'close',
} as const;
export type NegotiationAction = (typeof NegotiationAction)[keyof typeof NegotiationAction];

export const ActionKind = {
  Read: 'read',
  Write: 'write',
} as const;
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];

export const HandoffTrigger = {
  FloorBreached: 'floor_breached',
  CustomScope: 'custom_scope',
  StartDateAsked: 'start_date_asked',
  BuyerAskedForPerson: 'buyer_asked_for_person',
  Accepted: 'accepted',
} as const;
export type HandoffTrigger = (typeof HandoffTrigger)[keyof typeof HandoffTrigger];

export const CloseReason = {
  BuyerDeclined: 'buyer_declined',
  IdleExpired: 'idle_expired',
} as const;
export type CloseReason = (typeof CloseReason)[keyof typeof CloseReason];

/** Evidence the manifest demands before an action runs. Exactly one shape per action. */
export type ActionEvidence =
  | { action: typeof NegotiationAction.Ask }
  | { action: typeof NegotiationAction.Answer; sourceId: string }
  | { action: typeof NegotiationAction.Quote; engagements: EngagementId[] }
  | { action: typeof NegotiationAction.Propose; fields: Fields; quote: Quote }
  | { action: typeof NegotiationAction.Handoff; trigger: HandoffTrigger }
  | { action: typeof NegotiationAction.Close; reason: CloseReason };

export const IDLE_CLOSE_SECONDS = 24 * 60 * 60;
export const PROPOSAL_VALID_DAYS = 14;

export interface TranscriptLine {
  role: StoredMessage['role'];
  text: string;
  at: string;
}

export interface NegotiationRecord {
  conversationId: string;
  clientId: string;
  userId: string;
  state: NegotiationState;
  fields: Fields;
  quote?: Quote;
  handoffTrigger?: HandoffTrigger;
  closeReason?: CloseReason;
  leadSent: boolean;
  transcript: TranscriptLine[];
  createdAt: number;
  updatedAt: number;
}

export interface NegotiationStore {
  get(conversationId: string): Promise<NegotiationRecord | undefined>;
  put(record: NegotiationRecord): Promise<void>;
}

/* ---------- Proposal and lead ---------- */

export interface Proposal {
  company: string;
  quote: Quote;
  scope: string[];
  assumptions: string[];
  validUntil: string;
}

export interface Lead {
  conversationId: string;
  clientId: string;
  trigger: HandoffTrigger;
  fields: Fields;
  quote?: Quote;
  transcript: TranscriptLine[];
  createdAt: string;
}

export const LeadSinkKind = {
  Resend: 'resend',
  Logging: 'logging',
} as const;
export type LeadSinkKind = (typeof LeadSinkKind)[keyof typeof LeadSinkKind];

export interface LeadSink {
  kind: LeadSinkKind;
  deliver(lead: Lead): Promise<void>;
}

export const LeadOutcome = {
  Sent: 'sent',
  Fallback: 'fallback',
  SuppressedConversation: 'suppressed_conversation',
  SuppressedClient: 'suppressed_client',
  MissingEvidence: 'missing_evidence',
} as const;
export type LeadOutcome = (typeof LeadOutcome)[keyof typeof LeadOutcome];

export const LEADS_PER_CLIENT_PER_DAY = 3;

export interface LeadDispatcher {
  /** Applies the one-per-conversation and per-client-per-day caps and the evidence rule, then delivers. */
  send(lead: Lead, record: NegotiationRecord): Promise<LeadOutcome>;
}

/* ---------- Model ---------- */

export interface ModelInput {
  system: string;
  user: string;
  /** Ask the model for a JSON object only. */
  json: boolean;
}

export interface ModelOutput {
  text: string;
}

export interface TextModel {
  generate(input: ModelInput): Promise<ModelOutput>;
}

/** The guard's daily model budget. The negotiator must call reserve before every model call. */
export interface ModelBudget {
  reserveModelCall(): Promise<boolean>;
}

export interface Extractor {
  /** Merges what the message says into prior. On model failure or invalid JSON after one repair, returns prior unchanged. */
  extract(message: string, prior: Fields, conversationId: string): Promise<Fields>;
}

export interface WriterInput {
  conversationId: string;
  state: NegotiationState;
  action: NegotiationAction;
  fields: Fields;
  quote?: Quote;
  missing: FieldName[];
  lastMessage: string;
}

export interface ReplyWriter {
  /** Returns reply text whose every price appears in the quote, or a template when the model fails that check. */
  write(input: WriterInput): Promise<string>;
}

export const MODEL_TIMEOUT_MS = 8000;

/* ---------- Logging ---------- */

export const NegotiationLogType = {
  Transition: 'negotiation.transition',
  ActionDenied: 'negotiation.action_denied',
  ModelFailed: 'negotiation.model_failed',
  ReplyRewritten: 'negotiation.reply_rewritten',
  LeadSent: 'negotiation.lead_sent',
  LeadFallback: 'negotiation.lead_fallback',
  LeadSuppressed: 'negotiation.lead_suppressed',
  BudgetExhausted: 'negotiation.budget_exhausted',
} as const;
export type NegotiationLogType = (typeof NegotiationLogType)[keyof typeof NegotiationLogType];

export type NegotiationLogEvent =
  | { type: typeof NegotiationLogType.Transition; conversationId: string; from: NegotiationState; to: NegotiationState; event: NegotiationEvent }
  | { type: typeof NegotiationLogType.ActionDenied; conversationId: string; action: NegotiationAction; state: NegotiationState; reason: string }
  | { type: typeof NegotiationLogType.ModelFailed; conversationId: string; stage: 'extract' | 'write'; ref: string }
  | { type: typeof NegotiationLogType.ReplyRewritten; conversationId: string; offending: number[] }
  | { type: typeof NegotiationLogType.LeadSent; conversationId: string; sink: LeadSinkKind; trigger: HandoffTrigger }
  | { type: typeof NegotiationLogType.LeadFallback; conversationId: string; ref: string }
  | { type: typeof NegotiationLogType.LeadSuppressed; conversationId: string; outcome: LeadOutcome }
  | { type: typeof NegotiationLogType.BudgetExhausted; conversationId: string };

export interface NegotiationLogger {
  event(e: NegotiationLogEvent): void;
}

/* ---------- Fixed replies (never produced by the model) ---------- */

export const FixedReply = {
  ModelUnavailable: 'I could not process that just now. Tell me about your company, what you sell, and the APIs or identity provider your customers use, and I will scope the work.',
  BudgetExhausted: 'Our agent has reached its daily limit. Leave your company name and a contact and a person will follow up within one business day.',
  GroundingFailed: 'Here is the quote from our published catalog. Every price is list price from origin-platform-labs.netlify.app/poppy.',
  BelowFloor: 'That is below what I can agree to. I have passed the conversation to a person at Origin Platform Labs who can look at scope with you.',
  StartDate: 'Start dates are confirmed by a person. I have passed this conversation along with the proposal.',
  Queued: 'A person at Origin Platform Labs has the conversation now and will reply here.',
  Closed: 'Understood. The conversation is closed. Thank you for considering Origin Platform Labs.',
} as const;
export type FixedReply = (typeof FixedReply)[keyof typeof FixedReply];

/* ---------- Wiring ---------- */

export interface NegotiatorDeps {
  model: TextModel;
  budget: ModelBudget;
  store: NegotiationStore;
  leads: LeadDispatcher;
  log: NegotiationLogger;
  now?: () => number;
}

export type Negotiator = CompanyAgentHandler;

/** Store the lead dispatcher and guard count against. The gateway's own store is reused so counters share a backend. */
export type CounterStore = Pick<Store, 'increment' | 'claimOnce'>;
