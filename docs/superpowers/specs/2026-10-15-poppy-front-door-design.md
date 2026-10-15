# Poppy front door for Origin Platform Labs

Date: 2026-10-15. Status: draft for Billy's review. Diagram: https://claude.ai/artifact/EnKJEDNS43b5um3SpRc1HY

## Goal

A buyer's personal agent can discover Origin Platform Labs by domain, open a Poppy conversation without signing in, scope an engagement, get a quote from the public catalog, and leave a qualified lead with Billy. The landing page and the README publish the URL to point an agent at. The hosted service is this repo's own gateway, running in production, which is also the proof that the library works.

Success: an agent built on `PoppyAgent` (or any draft 0.1 client) finishes discovery, token issuance and a four-turn negotiation against the live service; a lead with transcript and proposal summary reaches Billy; every cap in the security view holds under the test suite.

## Decisions taken without a yes (say so if wrong)

- Discount floor is 10 percent off list, only for prepay or bundling two engagements. Below the floor is a handoff, never a counter.
- Lead delivery is a `LeadSink` interface with two implementations: Resend email and Cloud Logging. The deploy uses Resend when `RESEND_API_KEY` is set and falls back to logging otherwise, so the service ships before the key exists.
- The hosted service lives in this repo under `hosted/` so the public repo shows a real deployment. Only the catalog prices already on the landing page are in it; no secrets.
- The Abuse guard is library code (`src/guard.ts`), not hosted code, because every company handler needs it.

## Architecture

Two deployables, unchanged from the diagram.

1. Static site at origin-platform-labs.netlify.app (source `/Users/b/Desktop/code/origin-platform-labs-site/public`). Serves `/.well-known/poppy.json` with `auth.issuer` and `agent.protocols[0].endpoint` pointing at the Cloud Run service, plus the "Send your agent" block on `/poppy/`.
2. Cloud Run service `poppy-agent` in project `cast-commerce-prod`, region us-central1, Node 22, Hono, `min-instances=1`, `max-instances=2`, `concurrency=80`, cpu throttling on. It mounts `createPoppyGateway` with the negotiator as `agent.handler`, `MemoryStore`, and rate limits set. Issuer is the Cloud Run URL; `poppyDomains` is `['origin-platform-labs.netlify.app']`.

State is in memory for v1. A deploy drops open conversations; agents receive 404 and start a new one. The `Store` interface allows a Firestore swap later without touching the negotiator.

Secrets: ES256 signing key (`POPPY_SIGNING_KEY_JWK`) and `RESEND_API_KEY` in Secret Manager, mounted as env. Vertex AI through the service account with ADC; location `global`; model `gemini-3.6-flash`; never the consumer endpoint.

## Control plane (typed)

All of these are const maps or enums, no string literals at call sites.

```ts
export const NegotiationState = { Intake, Scoping, Quote, Proposal, Handoff, Closed } as const;
export const NegotiationAction = { Ask, Answer, Quote, Propose, Handoff, Close } as const;
export const HandoffTrigger = { FloorBreached, CustomScope, StartDateAsked, BuyerAskedForPerson, Accepted } as const;
export const EngagementId = { PilotWeek, Readiness, Gateway, CompanyAgent, Retainer } as const;
export const GuardVerdict = { Allow, MessagesPerSession, ConversationsPerClient, SpendCeiling, MessageTooLong, LeadsPerClient } as const;
export const LeadSinkKind = { Resend, Logging } as const;
```

Action manifest (enforced in code by `assertAllowed(action, state, evidence)`):

| Action | Kind | Allowed in | Evidence required |
|---|---|---|---|
| Ask | read | Intake, Scoping | none |
| Answer | read | any open state | catalog or FAQ text id |
| Quote | read | Scoping, Quote | engagement id in catalog |
| Propose | write | Quote | required fields present, price at or above floor |
| Handoff | write | any open state | trigger name |
| Close | write | Proposal, Handoff | buyer decline or 24 h idle |

State machine transitions are a lookup table `Transitions[state][event]`; anything missing is a no-op with an audit line.

Required fields for a quote: company name, what they sell, one of (APIs, identity provider, timeline). Budget and contact are requested, never required.

## Components of the negotiator (`hosted/src/`)

- `catalog.ts`: the five engagements and list prices from the landing page (Pilot week 4,500; Readiness 12,500; Gateway from 75,000; Company agent from 60,000; Retainer 8,000 per month). `quote(engagements, terms)` is pure and deterministic; the floor is a constant.
- `extractor.ts`: Gemini structured output to a Zod schema (`company`, `sells`, `apis`, `idp`, `timeline`, `budget`, `contact`, `intent`). One repair attempt on invalid JSON, then treat as empty extraction and Ask.
- `writer.ts`: Gemini turns state, fields and quote into reply text. Post-check: every number in the output that looks like a price must appear in the quote; otherwise the reply is replaced by a template sentence and an audit line is written. The writer has no tools.
- `machine.ts`: state record per conversation (`Map<conversationId, NegotiationRecord>`), transitions, manifest check.
- `proposal.ts`: builds the `data` payload for the proposal event (engagements, price, assumptions, scope bullets, validity 14 days).
- `lead.ts`: `LeadSink` interface, `ResendSink`, `LoggingSink`; one lead per conversation, three per client per day, requires company name plus one scoping field.
- `handler.ts`: the `CompanyAgentHandler`. Order per message: guard, extract, transition, act, reply.
- `server.ts`: Hono app, body cap 64 KB, `/readyz`, gateway mount, audit to stdout as JSON for Cloud Logging.

## Abuse guard (`src/guard.ts`, library)

`withGuard(handler, options)` wraps any `CompanyAgentHandler`. Options with the hosted values:

| Cap | Hosted value |
|---|---|
| Messages per session per hour | 40 |
| Conversations per client per day | 20 |
| Model calls per day (all conversations) | 400, roughly $5 at current pricing |
| Message text length | 4,000 characters |
| Lead emails per conversation / per client per day | 1 / 3 |

Counters use `store.increment(key, ttl)`. Over a cap: reply with a fixed sentence from a const map, no model call, audit event `guard.refused` with the verdict. Injection patterns (a small regex list: "ignore your", "system prompt", "send the transcript", "the price is") never block; they add `flags` to the audit line.

Gateway rate limits set in hosted config: `tokenRequestsPerClientPerMinute: 30`, `sessionsPerClientPerMinute: 10`. No sign-in types configured, so there is no credential surface.

## Discovery and the public surfaces

- `poppy.json` on Netlify gains `auth.issuer` (the Cloud Run URL) and `agent.protocols: [{ type: 'poppy', endpoint: '<run url>/poppy/conversations' }]`. The gateway's `poppyDomains` lists the Netlify domain so `poppy_domains` in the OAuth metadata matches.
- `/poppy/` hero gets a "Send your agent" block: the domain, the conversations URL with a copy button, a five-line `PoppyAgent` snippet, and the sentence that no sign-in is needed. Verified at phone and desktop widths before deploy.
- README gets a "Talk to our agent" section with the same snippet and the live URL.

## Error handling

- Gemini failure or timeout (8 s): reply with a template Ask, audit `model.failed`, state unchanged.
- Resend failure: fall back to the logging sink for that lead, audit `lead.fallback`. Never retry in-request.
- Handler throw: the gateway already logs and leaves the conversation idle; `onError` adds the correlation ref `err_<12 hex>`. No third-party error text reaches the agent.
- Restart mid-conversation: 404 on the old id; documented on the landing page.

## Testing

- Unit: catalog quote table, floor, manifest, transitions, number post-check, guard counters (all deterministic, no model).
- Conformance: the existing 45 tests pass against the hosted config via `makeWorld`.
- Security evals: one test per row of the security view in the diagram, each performing the attack through the harness and asserting the refusal; 500 random injection strings never move a quote off the catalog (property test with fast-check); the 41st message in an hour makes zero model calls (counting stub).
- Conversation evals: 200 scripted negotiations with a stubbed extractor never breach the floor, never propose before Scoping, and fire each handoff trigger exactly once with one lead.
- Smoke after deploy: `examples/northwind/agent.ts` style script against the live URL, printed in the PR.

## Deployment

`hosted/Dockerfile`, `hosted/deploy.sh` (`CLOUDSDK_CORE_PROJECT=cast-commerce-prod`, `gcloud builds submit`, `gcloud run deploy poppy-agent --min-instances=1 --cpu-throttling`), secrets created once with `gcloud secrets create`. New env vars land in `hosted/.env.example` and `deploy.sh` in the same commit. Smoke test with curl on `/.well-known/oauth-authorization-server` and `/readyz`, then the agent script.

## Out of scope

Firestore store, sign-in of any kind, payments, calendar booking, multiple catalogs, a dashboard. Operations extension stays advertised only.
