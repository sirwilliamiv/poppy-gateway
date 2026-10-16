import type { Fields, Lead, LeadSink, ModelInput, ModelOutput, TextModel } from '../../hosted/src/contracts.js';
import { EMPTY_FIELDS, LeadSinkKind } from '../../hosted/src/contracts.js';

export interface FakeModel extends TextModel {
  calls: ModelInput[];
}

/** A model that answers extraction prompts (json: true) with the given fields and writing prompts with the given text. */
export function fakeModel(opts: { fields?: (input: ModelInput) => Partial<Fields>; text?: (input: ModelInput) => string; fail?: boolean }): FakeModel {
  const calls: ModelInput[] = [];
  return {
    calls,
    async generate(input: ModelInput): Promise<ModelOutput> {
      calls.push(input);
      if (opts.fail) throw new Error('model down');
      if (input.json) return { text: JSON.stringify({ ...EMPTY_FIELDS, ...(opts.fields?.(input) ?? {}) }) };
      return { text: opts.text?.(input) ?? 'Thanks. Tell me more about your company.' };
    },
  };
}

export function alwaysAllowBudget(): { reserveModelCall(): Promise<boolean>; reserved: number } {
  const b = { reserved: 0, async reserveModelCall() { b.reserved += 1; return true; } };
  return b;
}

export function neverAllowBudget(): { reserveModelCall(): Promise<boolean> } {
  return { async reserveModelCall() { return false; } };
}

export function fakeSink(kind: LeadSinkKind = LeadSinkKind.Resend, fail = false): LeadSink & { delivered: Lead[] } {
  const delivered: Lead[] = [];
  return {
    kind,
    delivered,
    async deliver(lead) {
      if (fail) throw new Error('resend 500');
      delivered.push(lead);
    },
  };
}

/** Fields a buyer would have given by the end of scoping. */
export const SCOPED_FIELDS: Fields = {
  ...EMPTY_FIELDS,
  company: 'Acme Outdoor',
  sells: 'outdoor gear online',
  apis: 'REST orders API behind Okta',
  idp: 'Okta',
  timeline: 'this quarter',
};
