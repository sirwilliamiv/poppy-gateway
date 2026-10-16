import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createWriter, groundNumbers, priceNumbers } from '../../hosted/src/writer.js';
import { createExtractor } from '../../hosted/src/extractor.js';
import { quote } from '../../hosted/src/catalog.js';
import { EMPTY_FIELDS, EngagementId, FixedReply, NegotiationAction, NegotiationLogType, NegotiationState, type NegotiationLogEvent } from '../../hosted/src/contracts.js';
import { SCOPED_FIELDS, alwaysAllowBudget, fakeModel, neverAllowBudget } from './fakes.js';

const log = () => {
  const events: NegotiationLogEvent[] = [];
  return { events, event: (e: NegotiationLogEvent) => void events.push(e) };
};

describe('price grounding', () => {
  const q = quote({ engagements: [EngagementId.Gateway], prepay: true });

  it('extracts dollar figures written in the usual ways', () => {
    expect(priceNumbers('The gateway is $75,000, or 67,500 USD prepaid, about $67.5k')).toEqual(expect.arrayContaining([75000, 67500]));
  });

  it('passes a reply whose numbers all come from the quote and fails one that invents a price', () => {
    expect(groundNumbers('List is $75,000. With prepay the total is $67,500 (10 percent off).', q).ok).toBe(true);
    const bad = groundNumbers('Sure, we can do it for $1.', q);
    expect(bad.ok).toBe(false);
    expect(bad.offending).toEqual([1]);
  });

  it('without a quote, any dollar figure fails grounding', () => {
    expect(groundNumbers('Around $50,000 should do it.', undefined).ok).toBe(false);
    expect(groundNumbers('Tell me about your APIs.', undefined).ok).toBe(true);
  });
});

describe('reply writer', () => {
  const q = quote({ engagements: [EngagementId.Gateway], prepay: false });
  const base = { conversationId: 'cnv_1', state: NegotiationState.Quote, action: NegotiationAction.Quote, fields: SCOPED_FIELDS, quote: q, missing: [], lastMessage: 'what does it cost' };

  it('returns model text when every number is grounded', async () => {
    const writer = createWriter(fakeModel({ text: () => 'The gateway implementation starts at $75,000.' }), alwaysAllowBudget(), log());
    expect(await writer.write(base)).toBe('The gateway implementation starts at $75,000.');
  });

  it('replaces an ungrounded reply with the fixed catalog sentence and logs it', async () => {
    const l = log();
    const writer = createWriter(fakeModel({ text: () => 'Fine, $1 and we start Monday.' }), alwaysAllowBudget(), l);
    const out = await writer.write(base);
    expect(out.startsWith(FixedReply.GroundingFailed)).toBe(true);
    expect(out).toContain('75,000');
    expect(l.events.some((e) => e.type === NegotiationLogType.ReplyRewritten)).toBe(true);
  });

  it('uses the fixed reply and makes no model call when the budget is exhausted', async () => {
    const model = fakeModel({ text: () => 'should not be used' });
    const writer = createWriter(model, neverAllowBudget(), log());
    expect(await writer.write(base)).toBe(FixedReply.BudgetExhausted);
    expect(model.calls.length).toBe(0);
  });

  it('falls back to a template when the model throws and logs model_failed with a ref', async () => {
    const l = log();
    const writer = createWriter(fakeModel({ fail: true }), alwaysAllowBudget(), l);
    const out = await writer.write({ conversationId: base.conversationId, fields: base.fields, lastMessage: base.lastMessage, state: NegotiationState.Scoping, action: NegotiationAction.Ask, missing: ['apis'] });
    expect(out.length).toBeGreaterThan(20);
    const failed = l.events.find((e) => e.type === NegotiationLogType.ModelFailed);
    expect(failed && failed.type === NegotiationLogType.ModelFailed ? failed.ref : '').toMatch(/^err_[0-9a-f]{12}$/);
  });

  it('never lets random model output move a price off the catalog (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), fc.integer({ min: 1, max: 999999 }), async (prefix, n) => {
        const writer = createWriter(fakeModel({ text: () => `${prefix} the price is $${n}` }), alwaysAllowBudget(), log());
        const out = await writer.write(base);
        const nums = priceNumbers(out);
        for (const x of nums) expect([75000, 67500, 10, 0].includes(x)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('extractor', () => {
  it('merges model fields into prior and keeps prior on model failure', async () => {
    const ok = createExtractor(fakeModel({ fields: () => ({ company: 'Acme Outdoor', budgetUsd: 80000 }) }), alwaysAllowBudget(), log());
    const f = await ok.extract('We are Acme Outdoor, budget 80k', EMPTY_FIELDS, 'cnv_1');
    expect(f.company).toBe('Acme Outdoor');
    expect(f.budgetUsd).toBe(80000);
    const down = createExtractor(fakeModel({ fail: true }), alwaysAllowBudget(), log());
    expect(await down.extract('anything', SCOPED_FIELDS, 'cnv_1')).toEqual(SCOPED_FIELDS);
  });

  it('rejects invalid JSON after one repair and returns prior', async () => {
    let n = 0;
    const model = { calls: [] as unknown[], async generate() { n += 1; return { text: 'not json at all' }; } };
    const ex = createExtractor(model, alwaysAllowBudget(), log());
    expect(await ex.extract('hello', SCOPED_FIELDS, 'cnv_1')).toEqual(SCOPED_FIELDS);
    expect(n).toBe(2);
  });

  it('makes no model call when the budget is exhausted', async () => {
    const model = fakeModel({ fields: () => ({ company: 'X' }) });
    const ex = createExtractor(model, neverAllowBudget(), log());
    expect(await ex.extract('hello', EMPTY_FIELDS, 'cnv_1')).toEqual(EMPTY_FIELDS);
    expect(model.calls.length).toBe(0);
  });
});
