import { CATALOG } from './catalog.js';
import { EMPTY_FIELDS, FieldName, NegotiationAction, NegotiationEvent, NegotiationState } from './contracts.js';
import type { ActionEvidence, Fields, NegotiationRecord, NegotiationStore } from './contracts.js';

const S = NegotiationState;
const E = NegotiationEvent;

export const Transitions: Partial<Record<NegotiationState, Partial<Record<NegotiationEvent, NegotiationState>>>> = {
  [S.Intake]: {
    [E.FirstMessageParsed]: S.Scoping,
    [E.BuyerAskedForPerson]: S.Handoff,
  },
  [S.Scoping]: {
    [E.FieldsMissing]: S.Scoping,
    [E.FieldsComplete]: S.Quote,
    [E.BuyerAskedForPerson]: S.Handoff,
  },
  [S.Quote]: {
    [E.BuyerAccepted]: S.Proposal,
    [E.BelowFloor]: S.Handoff,
    [E.CustomScope]: S.Handoff,
    [E.StartDateAsked]: S.Handoff,
    [E.BuyerAskedForPerson]: S.Handoff,
  },
  [S.Proposal]: {
    [E.StartDateAsked]: S.Handoff,
    [E.BuyerDeclined]: S.Closed,
    [E.BuyerAskedForPerson]: S.Handoff,
    [E.IdleExpired]: S.Closed,
  },
  [S.Handoff]: {
    [E.HumanClosed]: S.Closed,
    [E.IdleExpired]: S.Closed,
  },
};

export function transition(state: NegotiationState, event: NegotiationEvent): NegotiationState | undefined {
  return Transitions[state]?.[event];
}

export const DenyReason = {
  WrongState: 'wrong_state',
  MissingSource: 'missing_source',
  UnknownEngagement: 'unknown_engagement',
  MissingFields: 'missing_fields',
  BelowFloor: 'below_floor',
} as const;
export type DenyReason = (typeof DenyReason)[keyof typeof DenyReason];

export class ActionNotAllowedError extends Error {
  readonly reason: DenyReason;
  readonly action: NegotiationAction;
  readonly state: NegotiationState;
  constructor(reason: DenyReason, action: NegotiationAction, state: NegotiationState) {
    super(`action ${action} not allowed in ${state}: ${reason}`);
    this.name = 'ActionNotAllowedError';
    this.reason = reason;
    this.action = action;
    this.state = state;
  }
}

const OPEN_STATES: readonly NegotiationState[] = [S.Intake, S.Scoping, S.Quote, S.Proposal, S.Handoff];

const ALLOWED_IN: Record<NegotiationAction, readonly NegotiationState[]> = {
  [NegotiationAction.Ask]: [S.Intake, S.Scoping],
  [NegotiationAction.Answer]: OPEN_STATES,
  [NegotiationAction.Quote]: [S.Scoping, S.Quote],
  [NegotiationAction.Propose]: [S.Quote],
  [NegotiationAction.Handoff]: OPEN_STATES,
  [NegotiationAction.Close]: [S.Proposal, S.Handoff],
};

export function assertAllowed(evidence: ActionEvidence, state: NegotiationState): void {
  const deny = (reason: DenyReason): never => {
    throw new ActionNotAllowedError(reason, evidence.action, state);
  };
  if (!ALLOWED_IN[evidence.action].includes(state)) deny(DenyReason.WrongState);
  switch (evidence.action) {
    case NegotiationAction.Answer:
      if (evidence.sourceId.trim().length === 0) deny(DenyReason.MissingSource);
      return;
    case NegotiationAction.Quote:
      if (!evidence.engagements.some((e) => Object.hasOwn(CATALOG, e))) deny(DenyReason.UnknownEngagement);
      return;
    case NegotiationAction.Propose:
      if (missingFields(evidence.fields).length > 0) deny(DenyReason.MissingFields);
      if (evidence.quote.totalUsd < evidence.quote.floorUsd) deny(DenyReason.BelowFloor);
      return;
    case NegotiationAction.Ask:
    case NegotiationAction.Handoff:
    case NegotiationAction.Close:
      return;
  }
}

export function missingFields(fields: Fields): FieldName[] {
  const missing: FieldName[] = [];
  if (fields.company === null) missing.push(FieldName.Company);
  if (fields.sells === null) missing.push(FieldName.Sells);
  if (fields.apis === null && fields.idp === null && fields.timeline === null) {
    missing.push(FieldName.Apis, FieldName.Idp, FieldName.Timeline);
  }
  return missing;
}

export function mergeFields(prior: Fields, next: Fields): Fields {
  return {
    company: next.company ?? prior.company,
    sells: next.sells ?? prior.sells,
    apis: next.apis ?? prior.apis,
    idp: next.idp ?? prior.idp,
    timeline: next.timeline ?? prior.timeline,
    budgetUsd: next.budgetUsd ?? prior.budgetUsd,
    contact: next.contact ?? prior.contact,
    engagements: next.engagements.length > 0 ? [...next.engagements] : [...prior.engagements],
    askedPriceUsd: next.askedPriceUsd,
    askedDiscountPercent: next.askedDiscountPercent,
    prepay: prior.prepay || next.prepay,
    intent: next.intent,
  };
}

export function newRecord(conversationId: string, clientId: string, userId: string, now: number): NegotiationRecord {
  return {
    conversationId,
    clientId,
    userId,
    state: S.Intake,
    fields: { ...EMPTY_FIELDS, engagements: [...EMPTY_FIELDS.engagements] },
    leadSent: false,
    transcript: [],
    createdAt: now,
    updatedAt: now,
  };
}

export class MemoryNegotiationStore implements NegotiationStore {
  private readonly records = new Map<string, NegotiationRecord>();

  async get(conversationId: string): Promise<NegotiationRecord | undefined> {
    const r = this.records.get(conversationId);
    return r === undefined ? undefined : structuredClone(r);
  }

  async put(record: NegotiationRecord): Promise<void> {
    this.records.set(record.conversationId, structuredClone(record));
  }
}
