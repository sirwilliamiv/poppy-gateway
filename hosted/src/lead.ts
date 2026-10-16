import {
  LEADS_PER_CLIENT_PER_DAY,
  LeadOutcome,
  LeadSinkKind,
  NegotiationLogType,
  type CounterStore,
  type Lead,
  type LeadDispatcher,
  type LeadSink,
  type NegotiationLogger,
  type NegotiationRecord,
} from './contracts.js';
import { errorRef, quoteLines } from './writer.js';

export const LeadKey = {
  Client: 'lead:client:',
} as const;
export type LeadKey = (typeof LeadKey)[keyof typeof LeadKey];

export const LeadLogKind = {
  Lead: 'lead',
} as const;
export type LeadLogKind = (typeof LeadLogKind)[keyof typeof LeadLogKind];

export const LeadDeliveryReason = {
  HttpStatus: 'http_status',
} as const;
export type LeadDeliveryReason = (typeof LeadDeliveryReason)[keyof typeof LeadDeliveryReason];

export class LeadDeliveryError extends Error {
  readonly reason: LeadDeliveryReason;
  readonly status: number;
  constructor(reason: LeadDeliveryReason, status: number) {
    super(`lead delivery failed: ${reason} ${status}`);
    this.name = 'LeadDeliveryError';
    this.reason = reason;
    this.status = status;
  }
}

const RESEND_URL = 'https://api.resend.com/emails';
const DAY_SECONDS = 86400;
const ISO_DATE_LENGTH = 10;

/** A lead needs a company name plus at least one other thing the buyer told us. */
export function leadHasEvidence(lead: Lead): boolean {
  const f = lead.fields;
  if (f.company === null) return false;
  return [f.sells, f.apis, f.idp, f.timeline, f.budgetUsd, f.contact].some((v) => v !== null);
}

export function createLoggingSink(write: (line: string) => void): LeadSink {
  return {
    kind: LeadSinkKind.Logging,
    async deliver(lead) {
      write(JSON.stringify({ kind: LeadLogKind.Lead, ...lead }));
    },
  };
}

function leadText(lead: Lead): string {
  const f = lead.fields;
  const rows: Array<[string, string | number | null]> = [
    ['Company', f.company],
    ['Sells', f.sells],
    ['APIs', f.apis],
    ['Identity provider', f.idp],
    ['Timeline', f.timeline],
    ['Budget (USD)', f.budgetUsd],
    ['Contact', f.contact],
    ['Engagements', f.engagements.length > 0 ? f.engagements.join(', ') : null],
    ['Prepay', f.prepay ? 'yes' : 'no'],
  ];
  const parts = [
    `Trigger: ${lead.trigger}`,
    `Conversation: ${lead.conversationId}`,
    `Client: ${lead.clientId}`,
    `Created: ${lead.createdAt}`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v ?? '(not given)'}`),
  ];
  if (lead.quote) parts.push('', 'Quote:', quoteLines(lead.quote));
  parts.push('', 'Transcript:', ...lead.transcript.map((t) => `[${t.at}] ${t.role}: ${t.text}`));
  return parts.join('\n');
}

export function createResendSink(opts: { apiKey: string; to: string; from: string; fetch?: typeof fetch }): LeadSink {
  const doFetch = opts.fetch ?? fetch;
  return {
    kind: LeadSinkKind.Resend,
    async deliver(lead) {
      const res = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: opts.from,
          to: [opts.to],
          subject: `Poppy lead: ${lead.fields.company ?? 'unknown company'} (${lead.trigger})`,
          text: leadText(lead),
        }),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new LeadDeliveryError(LeadDeliveryReason.HttpStatus, res.status);
      }
    },
  };
}

export function createLeadDispatcher(opts: { sink: LeadSink; fallback: LeadSink; counters: CounterStore; log: NegotiationLogger; now: () => number }): LeadDispatcher {
  const { sink, fallback, counters, log, now } = opts;
  const suppressed = (conversationId: string, outcome: LeadOutcome): LeadOutcome => {
    log.event({ type: NegotiationLogType.LeadSuppressed, conversationId, outcome });
    return outcome;
  };

  return {
    async send(lead: Lead, record: NegotiationRecord): Promise<LeadOutcome> {
      const conversationId = lead.conversationId;
      if (record.leadSent) return suppressed(conversationId, LeadOutcome.SuppressedConversation);
      if (!leadHasEvidence(lead)) return suppressed(conversationId, LeadOutcome.MissingEvidence);
      const day = new Date(now()).toISOString().slice(0, ISO_DATE_LENGTH);
      const count = await counters.increment(LeadKey.Client + lead.clientId + ':' + day, DAY_SECONDS);
      if (count > LEADS_PER_CLIENT_PER_DAY) return suppressed(conversationId, LeadOutcome.SuppressedClient);
      try {
        await sink.deliver(lead);
        log.event({ type: NegotiationLogType.LeadSent, conversationId, sink: sink.kind, trigger: lead.trigger });
        return LeadOutcome.Sent;
      } catch {
        const ref = errorRef();
        log.event({ type: NegotiationLogType.LeadFallback, conversationId, ref });
        await fallback.deliver(lead);
        return LeadOutcome.Fallback;
      }
    },
  };
}
