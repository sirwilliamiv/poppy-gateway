import { Billing, DISCOUNT_FLOOR_PERCENT, DiscountReason, EngagementId } from './contracts.js';
import type { Engagement, Quote, QuoteLine, QuoteTerms } from './contracts.js';

export const CATALOG: Record<EngagementId, Engagement> = {
  [EngagementId.PilotWeek]: {
    id: EngagementId.PilotWeek,
    name: 'Pilot week',
    listUsd: 4500,
    billing: Billing.Fixed,
    summary:
      'Five business days, one API, read-only. We publish your /.well-known/poppy.json and OAuth server metadata, stand up signed-out sessions and direct sign-in against your existing login, enforce poppy:read on one existing API, and hand you a conformance report plus a recorded demo of a personal agent completing a real task against staging.',
    scope: [
      'poppy.json and RFC 8414 metadata live on staging',
      'Token endpoint issuing DPoP-bound session tokens',
      'Direct sign-in (OAuth code + PKCE) wired to your login page',
      'One API behind scope enforcement',
      'Conformance report',
      'Demo recording',
    ],
  },
  [EngagementId.Readiness]: {
    id: EngagementId.Readiness,
    name: 'Readiness assessment',
    listUsd: 12500,
    billing: Billing.Fixed,
    summary:
      'Two weeks. The plan before the build: we inventory every customer task an agent could do, map each to a scope and a channel, design the identity integration against your IdP, define abuse and rate-limit policy for agent traffic, and run the conformance suite against your current staging to show the gap.',
    scope: [
      'Task-to-scope matrix',
      'Channel decision per task',
      'Identity integration design',
      'Agent policy (allowlist, rate limits, revocation, audit)',
      'Draft poppy.json',
      'Gap report',
      'Executive brief and a fixed-price proposal for implementation',
    ],
  },
  [EngagementId.Gateway]: {
    id: EngagementId.Gateway,
    name: 'Gateway implementation',
    listUsd: 75000,
    billing: Billing.From,
    summary:
      'Six to ten weeks. Production Poppy in front of what you already run: a gateway that serves discovery, issues and verifies session and account tokens, handles direct, device, and mediated sign-in, enforces scopes on every route, rate-limits and allowlists agents, and writes an audit trail. Shipped with a conformance suite in your CI, a runbook, and a handoff to your team.',
    scope: [
      'Gateway service deployed to your cloud (GCP, AWS, Cloudflare, or on-prem)',
      'Token endpoint with all four grants',
      'Revocation endpoint',
      'Scope middleware for your API stack',
      'Agent registry and policy',
      'Audit logging and dashboards',
      'Browser session endpoint (optional)',
      'Conformance suite in CI',
      'Runbook',
      'Two weeks of hypercare',
    ],
  },
  [EngagementId.CompanyAgent]: {
    id: EngagementId.CompanyAgent,
    name: 'Company agent and conversations',
    listUsd: 60000,
    billing: Billing.From,
    summary:
      'Four to eight weeks, add-on. The conversations endpoint from section 7 of the spec: your support agent reachable by personal agents, with event streaming, handoff to a human in your existing desk, direct conversations with the customer, sign-in mid-conversation, and the operations extension for approve-then-execute actions.',
    scope: [
      'Conversations endpoint with SSE streaming',
      'Company agent wired to your knowledge and tools',
      'Human handoff integration',
      'Direct conversation flow',
      'Operations extension',
      'Evals and transcripts review',
    ],
  },
  [EngagementId.Retainer]: {
    id: EngagementId.Retainer,
    name: 'Poppy retainer',
    listUsd: 8000,
    billing: Billing.Monthly,
    summary:
      'Ongoing, per month. We track the draft to 1.0, upgrade your gateway as the spec changes, review new agents requesting access, and re-run conformance every quarter.',
    scope: [
      'Track the Poppy draft to 1.0',
      'Gateway upgrades as the spec changes',
      'Review of new agents requesting access',
      'Quarterly conformance re-run',
    ],
  },
};

export const FaqId = {
  IsFinal: 'is_final',
  ReplaceIdp: 'replace_idp',
  Mcp: 'mcp',
  ReadOnlyStart: 'read_only_start',
  DataLocation: 'data_location',
} as const;
export type FaqId = (typeof FaqId)[keyof typeof FaqId];

export const FAQ: Record<FaqId, { question: string; answer: string }> = {
  [FaqId.IsFinal]: {
    question: 'Is Poppy final?',
    answer:
      'No. It is draft 0.1, published October 9, 2026, and it can change before 1.0. We build on the open implementation so upgrades are a version bump, and the retainer covers it.',
  },
  [FaqId.ReplaceIdp]: {
    question: 'Do we have to replace our identity provider?',
    answer:
      'No. Session and account tokens are standard OAuth access and refresh tokens. The gateway sits in front of your IdP and your APIs.',
  },
  [FaqId.Mcp]: {
    question: 'What about MCP?',
    answer:
      'Listed MCP servers accept Bearer session tokens scoped to that server. We implement the protected resource metadata so standard MCP clients work too.',
  },
  [FaqId.ReadOnlyStart]: {
    question: 'Can we start without exposing writes?',
    answer: 'Yes. Most clients start read-only with poppy:read and add poppy:write per task after the assessment.',
  },
  [FaqId.DataLocation]: {
    question: 'Where does customer data go?',
    answer: 'It stays in your cloud. The gateway runs in your account; we do not host your traffic.',
  },
};

export const CatalogErrorReason = {
  NoEngagements: 'no_engagements',
} as const;
export type CatalogErrorReason = (typeof CatalogErrorReason)[keyof typeof CatalogErrorReason];

export class CatalogError extends Error {
  readonly reason: CatalogErrorReason;
  constructor(reason: CatalogErrorReason) {
    super(`catalog: ${reason}`);
    this.name = 'CatalogError';
    this.reason = reason;
  }
}

const BUNDLE_MIN_ENGAGEMENTS = 2;

export function quote(terms: QuoteTerms): Quote {
  const ids = [...new Set(terms.engagements)];
  if (ids.length === 0) throw new CatalogError(CatalogErrorReason.NoEngagements);
  const lines: QuoteLine[] = ids.map((id) => {
    const e = CATALOG[id];
    return { engagement: e.id, name: e.name, listUsd: e.listUsd, billing: e.billing };
  });
  const listTotalUsd = lines.reduce((sum, l) => sum + l.listUsd, 0);
  let discountPercent = 0;
  let discountReason: DiscountReason = DiscountReason.None;
  if (terms.prepay) {
    discountPercent = DISCOUNT_FLOOR_PERCENT;
    discountReason = DiscountReason.Prepay;
  } else if (ids.length >= BUNDLE_MIN_ENGAGEMENTS) {
    discountPercent = DISCOUNT_FLOOR_PERCENT;
    discountReason = DiscountReason.Bundle;
  }
  return {
    lines,
    listTotalUsd,
    discountPercent,
    discountReason,
    totalUsd: Math.round((listTotalUsd * (100 - discountPercent)) / 100),
    floorUsd: Math.round((listTotalUsd * (100 - DISCOUNT_FLOOR_PERCENT)) / 100),
  };
}

/** Every dollar or percent figure a reply may legitimately contain. The floor is deliberately absent. */
export function quoteNumbers(q: Quote): Set<number> {
  const nums = new Set<number>([0, q.listTotalUsd, q.totalUsd, q.discountPercent]);
  for (const l of q.lines) nums.add(l.listUsd);
  return nums;
}
