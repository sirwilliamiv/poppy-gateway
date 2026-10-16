import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/index.js';
import { createLeadDispatcher, createLoggingSink, createResendSink, leadHasEvidence } from '../../hosted/src/lead.js';
import { newRecord } from '../../hosted/src/machine.js';
import { EMPTY_FIELDS, HandoffTrigger, LEADS_PER_CLIENT_PER_DAY, LeadOutcome, LeadSinkKind, NegotiationLogType, type Lead, type NegotiationLogEvent } from '../../hosted/src/contracts.js';
import { SCOPED_FIELDS, fakeSink } from './fakes.js';

const lead = (conversationId: string, clientId = 'https://agent.example/agent.json'): Lead => ({
  conversationId,
  clientId,
  trigger: HandoffTrigger.BuyerAskedForPerson,
  fields: SCOPED_FIELDS,
  transcript: [{ role: 'user', text: 'hi', at: new Date(0).toISOString() }],
  createdAt: new Date(0).toISOString(),
});

function dispatcher(sink = fakeSink(), fallback = fakeSink(LeadSinkKind.Logging)) {
  const events: NegotiationLogEvent[] = [];
  const d = createLeadDispatcher({ sink, fallback, counters: new MemoryStore(), log: { event: (e) => void events.push(e) }, now: () => 0 });
  return { d, sink, fallback, events };
}

describe('lead dispatcher', () => {
  it('sends one lead per conversation', async () => {
    const { d, sink } = dispatcher();
    const record = newRecord('cnv_1', 'https://agent.example/agent.json', 'usr_1', 0);
    expect(await d.send(lead('cnv_1'), record)).toBe(LeadOutcome.Sent);
    expect(await d.send(lead('cnv_1'), { ...record, leadSent: true })).toBe(LeadOutcome.SuppressedConversation);
    expect(sink.delivered.length).toBe(1);
  });

  it('caps leads per client per day', async () => {
    const { d, sink } = dispatcher();
    for (let i = 0; i < LEADS_PER_CLIENT_PER_DAY; i++) {
      expect(await d.send(lead(`cnv_${i}`), newRecord(`cnv_${i}`, 'https://agent.example/agent.json', 'usr_1', 0))).toBe(LeadOutcome.Sent);
    }
    expect(await d.send(lead('cnv_extra'), newRecord('cnv_extra', 'https://agent.example/agent.json', 'usr_1', 0))).toBe(LeadOutcome.SuppressedClient);
    expect(sink.delivered.length).toBe(LEADS_PER_CLIENT_PER_DAY);
  });

  it('refuses a lead without a company name plus one scoping field', async () => {
    const { d, sink } = dispatcher();
    const thin = { ...lead('cnv_thin'), fields: { ...EMPTY_FIELDS, company: 'Acme' } };
    expect(await d.send(thin, newRecord('cnv_thin', 'https://agent.example/agent.json', 'usr_1', 0))).toBe(LeadOutcome.MissingEvidence);
    expect(leadHasEvidence(thin)).toBe(false);
    expect(leadHasEvidence(lead('x'))).toBe(true);
    expect(sink.delivered.length).toBe(0);
  });

  it('falls back to the logging sink when the primary fails and logs a ref, never the vendor error', async () => {
    const { d, fallback, events } = dispatcher(fakeSink(LeadSinkKind.Resend, true));
    expect(await d.send(lead('cnv_f'), newRecord('cnv_f', 'https://agent.example/agent.json', 'usr_1', 0))).toBe(LeadOutcome.Fallback);
    expect(fallback.delivered.length).toBe(1);
    const fb = events.find((e) => e.type === NegotiationLogType.LeadFallback);
    expect(fb && fb.type === NegotiationLogType.LeadFallback ? fb.ref : '').toMatch(/^err_[0-9a-f]{12}$/);
    expect(JSON.stringify(events)).not.toContain('resend 500');
  });
});

describe('sinks', () => {
  it('logging sink writes one JSON line with the lead and no header-like fields', async () => {
    const lines: string[] = [];
    const sink = createLoggingSink((l) => lines.push(l));
    await sink.deliver(lead('cnv_log'));
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? '{}');
    expect(parsed.conversationId).toBe('cnv_log');
    expect(parsed.fields.company).toBe('Acme Outdoor');
  });

  it('resend sink posts to the Resend API with the key in the Authorization header and the transcript in the body', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFake: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    };
    const sink = createResendSink({ apiKey: 're_test', to: 'billy@proedu.me', from: 'poppy@origin-platform-labs.netlify.app', fetch: fetchFake });
    await sink.deliver(lead('cnv_r'));
    expect(seen[0]?.url).toBe('https://api.resend.com/emails');
    expect(new Headers(seen[0]?.init.headers).get('authorization')).toBe('Bearer re_test');
    const body = JSON.parse(String(seen[0]?.init.body));
    expect(body.to).toEqual(['billy@proedu.me']);
    expect(body.text).toContain('Acme Outdoor');
  });

  it('resend sink throws on a non-2xx so the dispatcher can fall back', async () => {
    const sink = createResendSink({ apiKey: 're_test', to: 'a@b.c', from: 'x@y.z', fetch: async () => new Response('nope', { status: 500 }) });
    await expect(sink.deliver(lead('cnv_r2'))).rejects.toThrow();
  });
});
