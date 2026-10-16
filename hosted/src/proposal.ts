import { CATALOG } from './catalog.js';
import { PROPOSAL_VALID_DAYS } from './contracts.js';
import type { Fields, Proposal, Quote } from './contracts.js';

export const PROPOSAL_ASSUMPTIONS = [
  'Your existing APIs are reachable over HTTPS from the gateway.',
  'You run an identity provider that supports OIDC or SAML.',
  'You name one point of contact for the engagement.',
  'Fixed-price engagements start on a date a person at Origin Platform Labs confirms.',
] as const;

export const ProposalErrorReason = {
  MissingCompany: 'missing_company',
} as const;
export type ProposalErrorReason = (typeof ProposalErrorReason)[keyof typeof ProposalErrorReason];

export class ProposalError extends Error {
  readonly reason: ProposalErrorReason;
  constructor(reason: ProposalErrorReason) {
    super(`proposal: ${reason}`);
    this.name = 'ProposalError';
    this.reason = reason;
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ISO_DATE_LENGTH = 10;

export function buildProposal(fields: Fields, quote: Quote, now: number): Proposal {
  if (fields.company === null) throw new ProposalError(ProposalErrorReason.MissingCompany);
  const scope = [...new Set(quote.lines.flatMap((l) => CATALOG[l.engagement].scope))];
  return {
    company: fields.company,
    quote,
    scope,
    assumptions: [...PROPOSAL_ASSUMPTIONS],
    validUntil: new Date(now + PROPOSAL_VALID_DAYS * MS_PER_DAY).toISOString().slice(0, ISO_DATE_LENGTH),
  };
}

export function proposalData(p: Proposal): Record<string, unknown> {
  return { proposal: p };
}
