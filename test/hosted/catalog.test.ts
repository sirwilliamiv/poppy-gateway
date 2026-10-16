import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CATALOG, FAQ, quote, quoteNumbers } from '../../hosted/src/catalog.js';
import { Billing, DISCOUNT_FLOOR_PERCENT, DiscountReason, ENGAGEMENT_IDS, EngagementId } from '../../hosted/src/contracts.js';

describe('catalog', () => {
  it('matches the five list prices on the landing page', () => {
    expect(CATALOG[EngagementId.PilotWeek].listUsd).toBe(4500);
    expect(CATALOG[EngagementId.Readiness].listUsd).toBe(12500);
    expect(CATALOG[EngagementId.Gateway].listUsd).toBe(75000);
    expect(CATALOG[EngagementId.Gateway].billing).toBe(Billing.From);
    expect(CATALOG[EngagementId.CompanyAgent].listUsd).toBe(60000);
    expect(CATALOG[EngagementId.Retainer].listUsd).toBe(8000);
    expect(CATALOG[EngagementId.Retainer].billing).toBe(Billing.Monthly);
    expect(Object.keys(FAQ).length).toBeGreaterThanOrEqual(3);
  });

  it('gives no discount for a single engagement without prepay', () => {
    const q = quote({ engagements: [EngagementId.Gateway], prepay: false });
    expect(q.discountPercent).toBe(0);
    expect(q.discountReason).toBe(DiscountReason.None);
    expect(q.totalUsd).toBe(75000);
    expect(q.floorUsd).toBe(67500);
  });

  it('gives exactly the floor for prepay or a bundle of two', () => {
    expect(quote({ engagements: [EngagementId.Gateway], prepay: true }).discountPercent).toBe(DISCOUNT_FLOOR_PERCENT);
    const bundle = quote({ engagements: [EngagementId.Gateway, EngagementId.CompanyAgent], prepay: false });
    expect(bundle.discountPercent).toBe(DISCOUNT_FLOOR_PERCENT);
    expect(bundle.discountReason).toBe(DiscountReason.Bundle);
    expect(bundle.totalUsd).toBe(121500);
  });

  it('never discounts below the floor for any combination (property)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom(...ENGAGEMENT_IDS), { minLength: 1 }), fc.boolean(), (engagements, prepay) => {
        const q = quote({ engagements, prepay });
        expect(q.discountPercent).toBeLessThanOrEqual(DISCOUNT_FLOOR_PERCENT);
        expect(q.totalUsd).toBeGreaterThanOrEqual(q.floorUsd);
        expect(q.listTotalUsd).toBe(engagements.reduce((s, e) => s + CATALOG[e].listUsd, 0));
      }),
    );
  });

  it('quoteNumbers lists every dollar figure a reply may legitimately contain', () => {
    const q = quote({ engagements: [EngagementId.PilotWeek], prepay: true });
    const nums = quoteNumbers(q);
    expect(nums.has(4500)).toBe(true);
    expect(nums.has(q.totalUsd)).toBe(true);
    expect(nums.has(10)).toBe(true);
  });
});
