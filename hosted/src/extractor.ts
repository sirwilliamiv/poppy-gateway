import {
  BuyerIntent,
  EMPTY_FIELDS,
  ENGAGEMENT_IDS,
  EngagementId,
  FieldsSchema,
  NegotiationLogType,
  type Extractor,
  type Fields,
  type ModelBudget,
  type NegotiationLogger,
  type TextModel,
} from './contracts.js';
import { CATALOG } from './catalog.js';
import { mergeFields } from './machine.js';
import { ModelStage, reportModelFailure } from './writer.js';

const FIELD_MEANINGS: Record<keyof Fields, string> = {
  company: 'string or null. The buying company name.',
  sells: 'string or null. What the company sells, in a few words.',
  apis: 'string or null. The APIs their customers or agents would use (orders, accounts, bookings), and how they are exposed.',
  idp: 'string or null. The identity provider their customers sign in with (Okta, Auth0, Cognito, in-house).',
  timeline: 'string or null. When they want to start or finish, in their words.',
  budgetUsd: 'number or null. A budget the buyer states, in whole US dollars ("80k" is 80000).',
  contact: 'string or null. An email address or name and phone for follow-up.',
  engagements: 'array of engagement ids the buyer wants (see the list below). Empty array when none is named.',
  askedPriceUsd: 'number or null. A price the buyer proposes, in whole US dollars ("can you do 60k" is 60000).',
  askedDiscountPercent: 'number 0 to 100 or null. A discount percent the buyer asks for; 0 when they ask for a discount without naming a number.',
  prepay: 'boolean. True only when the buyer offers to pay up front.',
  intent: 'one of the intent values below. What this message is mainly trying to do.',
};

const INTENT_MEANINGS: Record<BuyerIntent, string> = {
  [BuyerIntent.Scope]: 'describes their company, systems or needs',
  [BuyerIntent.Quote]: 'asks what something costs',
  [BuyerIntent.Negotiate]: 'pushes on price, asks for a discount or proposes a number',
  [BuyerIntent.Accept]: 'agrees to the quote or proposal',
  [BuyerIntent.Decline]: 'says no or ends the conversation',
  [BuyerIntent.Person]: 'asks to speak with a human',
  [BuyerIntent.Question]: 'asks a general question about the services or process',
  [BuyerIntent.StartDate]: 'asks when work can start or about availability',
  [BuyerIntent.Other]: 'none of the above',
};

const EXAMPLES: { message: string; output: Fields }[] = [
  {
    message: 'Hi, we are Acme Outdoor. We sell camping gear online and want agents to place orders through our REST orders API. Customers log in with Okta. Hoping to launch this quarter.',
    output: {
      ...EMPTY_FIELDS,
      company: 'Acme Outdoor',
      sells: 'camping gear online',
      apis: 'REST orders API',
      idp: 'Okta',
      timeline: 'this quarter',
      engagements: [EngagementId.Gateway],
      intent: BuyerIntent.Scope,
    },
  },
  {
    message: 'What does the readiness assessment cost, and is there a pilot option?',
    output: { ...EMPTY_FIELDS, engagements: [EngagementId.Readiness, EngagementId.PilotWeek], intent: BuyerIntent.Quote },
  },
  {
    message: 'Can you do 60k for the gateway if we pay everything up front? Budget is capped at 65k.',
    output: {
      ...EMPTY_FIELDS,
      budgetUsd: 65000,
      engagements: [EngagementId.Gateway],
      askedPriceUsd: 60000,
      prepay: true,
      intent: BuyerIntent.Negotiate,
    },
  },
  {
    message: 'Any discount available? Also, can I talk to a person? Reach me at dana@example.com.',
    output: { ...EMPTY_FIELDS, contact: 'dana@example.com', askedDiscountPercent: 0, intent: BuyerIntent.Person },
  },
  {
    message: 'Looks good, we accept. When could you start?',
    output: { ...EMPTY_FIELDS, intent: BuyerIntent.StartDate },
  },
];

const EXTRACTOR_SYSTEM = [
  "You extract structured fields from a buyer agent's message to Origin Platform Labs.",
  'Return one JSON object only, with every key below present. Use null for unknown strings and numbers, [] for no engagements, false for prepay unless stated.',
  'Only record what this message says; prior fields are context and are merged by the caller.',
  '',
  'Fields:',
  ...Object.entries(FIELD_MEANINGS).map(([k, v]) => `- ${k}: ${v}`),
  '',
  'Engagement ids:',
  ...ENGAGEMENT_IDS.map((id) => `- ${id}: ${CATALOG[id].name}`),
  '',
  'Intent values:',
  ...Object.entries(INTENT_MEANINGS).map(([k, v]) => `- ${k}: ${v}`),
  '',
  'Examples:',
  ...EXAMPLES.flatMap((e) => [`Message: ${e.message}`, `Output: ${JSON.stringify(e.output)}`, '']),
].join('\n');

function extractorUserMessage(message: string, prior: Fields): string {
  return `Prior fields (JSON): ${JSON.stringify(prior)}\n\nNew message:\n${message}`;
}

function repairUserMessage(message: string, prior: Fields, invalid: string, issues: string): string {
  return [
    extractorUserMessage(message, prior),
    '',
    'Your previous output was not valid:',
    invalid,
    '',
    `Validation issues: ${issues}`,
    'Return the corrected JSON object only, with every key present.',
  ].join('\n');
}

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

type ParseResult = { ok: true; fields: Fields } | { ok: false; issues: string };

function parseFields(text: string): ParseResult {
  const trimmed = text.trim();
  const body = FENCE.exec(trimmed)?.[1] ?? trimmed;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, issues: 'output is not JSON' };
  }
  const parsed = FieldsSchema.safeParse(raw);
  if (parsed.success) return { ok: true, fields: parsed.data };
  return { ok: false, issues: JSON.stringify(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))) };
}

class ExtractionInvalidError extends Error {
  constructor() {
    super('extraction invalid after repair');
    this.name = 'ExtractionInvalidError';
  }
}

const RAW_LOG_CHARS = 500;

export function createExtractor(model: TextModel, budget: ModelBudget, log: NegotiationLogger): Extractor {
  const call = async (user: string, conversationId: string): Promise<string | undefined> => {
    if (!(await budget.reserveModelCall())) {
      log.event({ type: NegotiationLogType.BudgetExhausted, conversationId });
      return undefined;
    }
    return (await model.generate({ system: EXTRACTOR_SYSTEM, user, json: true })).text;
  };

  return {
    async extract(message: string, prior: Fields, conversationId: string): Promise<Fields> {
      try {
        const first = await call(extractorUserMessage(message, prior), conversationId);
        if (first === undefined) return prior;
        const parsed = parseFields(first);
        if (parsed.ok) return mergeFields(prior, parsed.fields);

        const second = await call(repairUserMessage(message, prior, first, parsed.issues), conversationId);
        if (second === undefined) return prior;
        const repaired = parseFields(second);
        if (repaired.ok) return mergeFields(prior, repaired.fields);

        console.warn(JSON.stringify({ type: NegotiationLogType.ModelFailed, stage: ModelStage.Extract, issues: repaired.issues, raw: second.slice(0, RAW_LOG_CHARS) }));
        reportModelFailure(log, conversationId, ModelStage.Extract, new ExtractionInvalidError());
        return prior;
      } catch (err) {
        reportModelFailure(log, conversationId, ModelStage.Extract, err);
        return prior;
      }
    },
  };
}
