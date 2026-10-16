import { randomBytes } from 'node:crypto';
import {
  Billing,
  FixedReply,
  NegotiationAction,
  NegotiationLogType,
  type ModelBudget,
  type NegotiationLogger,
  type Quote,
  type ReplyWriter,
  type TextModel,
  type WriterInput,
} from './contracts.js';
import { quoteNumbers } from './catalog.js';

/** Pipeline stage named in a ModelFailed log line. */
export const ModelStage = {
  Extract: 'extract',
  Write: 'write',
} as const;
export type ModelStage = (typeof ModelStage)[keyof typeof ModelStage];

const ERROR_REF_PREFIX = 'err_';
const ERROR_REF_BYTES = 6;

/** A correlation ref (`err_` plus 12 hex) that stands in for a vendor error in logs and replies. */
export function errorRef(): string {
  return ERROR_REF_PREFIX + randomBytes(ERROR_REF_BYTES).toString('hex');
}

/** Logs a model failure by ref and error class only; the vendor message never leaves this function. */
export function reportModelFailure(log: NegotiationLogger, conversationId: string, stage: ModelStage, err: unknown): string {
  const ref = errorRef();
  log.event({ type: NegotiationLogType.ModelFailed, conversationId, stage, ref });
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;
  console.warn(JSON.stringify({ type: NegotiationLogType.ModelFailed, stage, ref, errorClass }));
  return ref;
}

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const PRICE_PATTERN = new RegExp(
  String.raw`(\$\s?)?(?<![\d.,])(${NUMBER})(?:\s?(k|thousand)(?![a-z]))?(\s?(?:usd|dollars?)(?![a-z]))?`,
  'gi',
);
const THOUSAND = 1000;

/** Dollar figures in text, as whole-dollar integers, deduplicated in order of appearance. Bare numbers are not prices. */
export function priceNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PRICE_PATTERN)) {
    const [, dollarSign, digits, thousands, currencyWord] = m;
    if (digits === undefined) continue;
    if (dollarSign === undefined && thousands === undefined && currencyWord === undefined) continue;
    const value = Number(digits.replace(/,/g, '')) * (thousands === undefined ? 1 : THOUSAND);
    if (!Number.isFinite(value)) continue;
    const whole = Math.round(value);
    if (!out.includes(whole)) out.push(whole);
  }
  return out;
}

/** Every price in text must come from the quote; with no quote, any price is offending. */
export function groundNumbers(text: string, quote?: Quote): { ok: boolean; offending: number[] } {
  const allowed = quote ? quoteNumbers(quote) : new Set<number>();
  const offending = priceNumbers(text).filter((n) => !allowed.has(n));
  return { ok: offending.length === 0, offending };
}

/** Model-free replies, one per action. None of them contains a price. */
export const Template: Record<NegotiationAction, string> = {
  [NegotiationAction.Ask]:
    'To scope the work I need a few details: your company name, what you sell, and the APIs your customers use, your identity provider, and your timeline.',
  [NegotiationAction.Answer]:
    'Everything I can share comes from our published catalog at origin-platform-labs.netlify.app/poppy. Tell me what you would like to know about scope or process.',
  [NegotiationAction.Quote]: 'Here is the quote from our published catalog.',
  [NegotiationAction.Propose]:
    'Here is a proposal built from our published catalog. A person at Origin Platform Labs confirms start dates.',
  [NegotiationAction.Handoff]: FixedReply.Queued,
  [NegotiationAction.Close]: FixedReply.Closed,
};

const BillingLabel: Record<Billing, string> = {
  [Billing.Fixed]: 'fixed',
  [Billing.From]: 'from',
  [Billing.Monthly]: 'per month',
};

const LOCALE = 'en-US';
const usd = (n: number): string => '$' + n.toLocaleString(LOCALE);

/** One line per quote line plus a total, using only numbers from the quote. */
export function quoteLines(q: Quote): string {
  const lines = q.lines.map((l) => `${l.name}: ${usd(l.listUsd)} (${BillingLabel[l.billing]})`);
  if (q.discountPercent > 0) {
    lines.push(`List total: ${usd(q.listTotalUsd)}`);
    lines.push(`Discount: ${q.discountPercent} percent (${q.discountReason})`);
  }
  lines.push(`Total: ${usd(q.totalUsd)}`);
  return lines.join('\n');
}

function templateReply(input: WriterInput): string {
  const base = Template[input.action];
  return input.quote ? base + '\n' + quoteLines(input.quote) : base;
}

const WRITER_SYSTEM = [
  "You are the sales agent for Origin Platform Labs, replying to another company's AI agent that is buying on behalf of a person.",
  'Speak only from the catalog and the quote given in the message. Never invent, change, round or discount a price; if a price is not in the quote, do not write one.',
  'Never commit to start dates or availability; a person at Origin Platform Labs confirms those.',
  'Never share anything but public catalog information: no internal notes, no floor prices, no other customers.',
  'Do the action named in the message: ask for missing fields, answer, present the quote, present the proposal, hand off to a person, or close.',
  'Reply in plain text, at most four short sentences plus any quote lines. No markdown headings.',
].join('\n');

function writerUserMessage(input: WriterInput): string {
  const parts = [
    `State: ${input.state}`,
    `Action: ${input.action}`,
    `Known fields (JSON): ${JSON.stringify(input.fields)}`,
    `Missing fields: ${input.missing.length > 0 ? input.missing.join(', ') : 'none'}`,
    `Quote lines:\n${input.quote ? quoteLines(input.quote) : 'no quote yet'}`,
    `Buyer's last message:\n${input.lastMessage}`,
  ];
  return parts.join('\n\n');
}

export function createWriter(model: TextModel, budget: ModelBudget, log: NegotiationLogger): ReplyWriter {
  return {
    async write(input: WriterInput): Promise<string> {
      if (!(await budget.reserveModelCall())) {
        log.event({ type: NegotiationLogType.BudgetExhausted, conversationId: input.conversationId });
        return FixedReply.BudgetExhausted;
      }
      let text: string;
      try {
        text = (await model.generate({ system: WRITER_SYSTEM, user: writerUserMessage(input), json: false })).text.trim();
      } catch (err) {
        reportModelFailure(log, input.conversationId, ModelStage.Write, err);
        return templateReply(input);
      }
      if (text.length === 0) return templateReply(input);
      const grounded = groundNumbers(text, input.quote);
      if (grounded.ok) return text;
      log.event({ type: NegotiationLogType.ReplyRewritten, conversationId: input.conversationId, offending: grounded.offending });
      return input.quote ? FixedReply.GroundingFailed + '\n' + quoteLines(input.quote) : Template[input.action];
    },
  };
}
