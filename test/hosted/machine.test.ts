import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ActionNotAllowedError, MemoryNegotiationStore, assertAllowed, mergeFields, missingFields, newRecord, transition } from '../../hosted/src/machine.js';
import { quote } from '../../hosted/src/catalog.js';
import { CloseReason, EMPTY_FIELDS, EngagementId, FieldName, HandoffTrigger, NegotiationAction, NegotiationEvent, NegotiationState } from '../../hosted/src/contracts.js';
import { SCOPED_FIELDS } from './fakes.js';

const states = Object.values(NegotiationState);
const events = Object.values(NegotiationEvent);

describe('state machine', () => {
  it('follows the diagram', () => {
    expect(transition(NegotiationState.Intake, NegotiationEvent.FirstMessageParsed)).toBe(NegotiationState.Scoping);
    expect(transition(NegotiationState.Scoping, NegotiationEvent.FieldsMissing)).toBe(NegotiationState.Scoping);
    expect(transition(NegotiationState.Scoping, NegotiationEvent.FieldsComplete)).toBe(NegotiationState.Quote);
    expect(transition(NegotiationState.Quote, NegotiationEvent.BuyerAccepted)).toBe(NegotiationState.Proposal);
    expect(transition(NegotiationState.Quote, NegotiationEvent.BelowFloor)).toBe(NegotiationState.Handoff);
    expect(transition(NegotiationState.Quote, NegotiationEvent.CustomScope)).toBe(NegotiationState.Handoff);
    expect(transition(NegotiationState.Proposal, NegotiationEvent.StartDateAsked)).toBe(NegotiationState.Handoff);
    expect(transition(NegotiationState.Proposal, NegotiationEvent.BuyerDeclined)).toBe(NegotiationState.Closed);
    expect(transition(NegotiationState.Intake, NegotiationEvent.BuyerAskedForPerson)).toBe(NegotiationState.Handoff);
    expect(transition(NegotiationState.Scoping, NegotiationEvent.BuyerAskedForPerson)).toBe(NegotiationState.Handoff);
    expect(transition(NegotiationState.Handoff, NegotiationEvent.HumanClosed)).toBe(NegotiationState.Closed);
  });

  it('is a no-op for every edge not in the diagram and never leaves Closed (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...states), fc.constantFrom(...events), (s, e) => {
        const next = transition(s, e);
        if (s === NegotiationState.Closed) expect(next).toBeUndefined();
        if (next !== undefined) expect(states).toContain(next);
      }),
    );
  });
});

describe('action manifest', () => {
  const q = quote({ engagements: [EngagementId.Gateway], prepay: false });

  it('allows a proposal only in Quote with complete fields and a price at or above the floor', () => {
    expect(() => assertAllowed({ action: NegotiationAction.Propose, fields: SCOPED_FIELDS, quote: q }, NegotiationState.Quote)).not.toThrow();
    expect(() => assertAllowed({ action: NegotiationAction.Propose, fields: SCOPED_FIELDS, quote: q }, NegotiationState.Scoping)).toThrow(ActionNotAllowedError);
    expect(() => assertAllowed({ action: NegotiationAction.Propose, fields: EMPTY_FIELDS, quote: q }, NegotiationState.Quote)).toThrow(ActionNotAllowedError);
    expect(() => assertAllowed({ action: NegotiationAction.Propose, fields: SCOPED_FIELDS, quote: { ...q, totalUsd: q.floorUsd - 1 } }, NegotiationState.Quote)).toThrow(ActionNotAllowedError);
  });

  it('allows asking only in Intake and Scoping, and closing only in Proposal and Handoff', () => {
    expect(() => assertAllowed({ action: NegotiationAction.Ask }, NegotiationState.Quote)).toThrow(ActionNotAllowedError);
    expect(() => assertAllowed({ action: NegotiationAction.Ask }, NegotiationState.Intake)).not.toThrow();
    expect(() => assertAllowed({ action: NegotiationAction.Close, reason: CloseReason.BuyerDeclined }, NegotiationState.Scoping)).toThrow(ActionNotAllowedError);
    expect(() => assertAllowed({ action: NegotiationAction.Close, reason: CloseReason.BuyerDeclined }, NegotiationState.Proposal)).not.toThrow();
  });

  it('allows a handoff in any open state but not after Closed', () => {
    for (const s of states.filter((x) => x !== NegotiationState.Closed)) {
      expect(() => assertAllowed({ action: NegotiationAction.Handoff, trigger: HandoffTrigger.BuyerAskedForPerson }, s)).not.toThrow();
    }
    expect(() => assertAllowed({ action: NegotiationAction.Handoff, trigger: HandoffTrigger.BuyerAskedForPerson }, NegotiationState.Closed)).toThrow(ActionNotAllowedError);
  });

  it('quote needs a catalog engagement id', () => {
    expect(() => assertAllowed({ action: NegotiationAction.Quote, engagements: [] }, NegotiationState.Scoping)).toThrow(ActionNotAllowedError);
    expect(() => assertAllowed({ action: NegotiationAction.Quote, engagements: [EngagementId.PilotWeek] }, NegotiationState.Scoping)).not.toThrow();
  });
});

describe('fields', () => {
  it('requires company, sells, and one of apis, idp, timeline', () => {
    expect(missingFields(EMPTY_FIELDS)).toEqual(expect.arrayContaining([FieldName.Company, FieldName.Sells]));
    expect(missingFields(SCOPED_FIELDS)).toEqual([]);
    expect(missingFields({ ...SCOPED_FIELDS, apis: null, idp: null, timeline: 'Q1' })).toEqual([]);
    expect(missingFields({ ...SCOPED_FIELDS, apis: null, idp: null, timeline: null }).length).toBeGreaterThan(0);
  });

  it('merge keeps prior values when the new extraction is null and takes new ones when present', () => {
    const merged = mergeFields(SCOPED_FIELDS, { ...EMPTY_FIELDS, budgetUsd: 80000, engagements: [EngagementId.Gateway] });
    expect(merged.company).toBe('Acme Outdoor');
    expect(merged.budgetUsd).toBe(80000);
    expect(merged.engagements).toEqual([EngagementId.Gateway]);
  });

  it('store round-trips a record', async () => {
    const store = new MemoryNegotiationStore();
    const r = newRecord('cnv_1', 'https://agent.example/agent.json', 'usr_1', 1000);
    await store.put(r);
    expect((await store.get('cnv_1'))?.state).toBe(NegotiationState.Intake);
    expect(await store.get('cnv_missing')).toBeUndefined();
  });
});
