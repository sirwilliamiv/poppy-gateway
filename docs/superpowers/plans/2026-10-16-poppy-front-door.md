# Poppy front door implementation plan

> **For agentic workers:** contracts and failing tests are already written by the controller. Each task fills one or two files until its named tests pass. No task edits `hosted/src/contracts.ts` or a test file; if a test is provably wrong, report it instead.

**Goal:** Ship the hosted poppy-gateway with a negotiating company agent, abuse guard, lead delivery, Cloud Run deploy, and the public "Send your agent" surfaces.

**Architecture:** The library gains `src/guard.ts`. The hosted service in `hosted/src/` wires `createPoppyGateway` with the negotiator as the handler, Vertex Gemini behind a `TextModel` interface, and a `LeadSink` that is Resend or Cloud Logging. Everything shared is frozen in `hosted/src/contracts.ts`.

**Tech stack:** Node 22, TypeScript ESM (NodeNext, `.js` import suffixes), Hono, jose, zod 4, @google/genai (Vertex, location global), vitest, fast-check.

**Spec:** `docs/superpowers/specs/2026-10-15-poppy-front-door-design.md`

## Global constraints

- No em dashes anywhere: code, comments, copy, commits, docs.
- Const maps or enums for every new domain string (states, events, verdicts, env var names, log types, error codes). No string literal comparisons.
- `exactOptionalPropertyTypes` is on: never spread optional params; build a typed intermediate and assign optional fields conditionally.
- ESLint: `@typescript-eslint/no-unused-vars` with `_` prefix allowed. Run `npx eslint <files>` and `npx tsc --noEmit` on your files.
- Vendor errors never reach replies or logs: wrap as `err_<12 hex>` correlation refs.
- Customer text goes to Vertex AI only (`vertexai: true`, project from env, location `global`), never `generativelanguage.googleapis.com`.
- No git commits by task workers. The controller commits once after the full suite passes.
- No `npm install`. Dependencies are already present: zod, @google/genai, fast-check, hono, @hono/node-server.

## Review focus

1. A buyer who gives every field in the first message: Intake must pass through Scoping to Quote in one turn (pinned in `test/hosted/handler.test.ts` "hands off below the floor").
2. A model reply that mentions a number in words or with a `k` suffix ("67.5k"): `priceNumbers` must catch it (pinned in `test/hosted/writer.test.ts`).
3. A restart mid-conversation: the negotiation record is gone while the gateway conversation may be too; the handler must create a fresh record rather than throw (add to Task 4 tests: `createNegotiator` receiving a message for an unknown conversation id answers with an Ask).
4. An agent that opens a conversation then sends nothing for a day: `IDLE_CLOSE_SECONDS` is a constant only; no sweeper runs in v1 and the spec accepts this. Documented, not tested.
5. Resend returning 429: the dispatcher falls back to logging and never retries in-request (pinned in `test/hosted/lead.test.ts`).

---

## Task 0: contracts (done by the controller)

Files: `hosted/src/contracts.ts`, `src/guard.ts` (types, const maps, `injectionFlags`, `createGuard` stub), `src/types.ts` (two audit events), `src/index.ts` exports, `hosted/tsconfig.json`, `package.json` scripts, test skeletons under `test/guard.test.ts` and `test/hosted/*.test.ts`, fakes in `test/hosted/fakes.ts`.

## Wave 1 (parallel, Opus)

### Task 1: abuse guard

Files: `src/guard.ts` (fill `createGuard`), new `test/security-library.test.ts`.
Tests: `npx vitest run test/guard.test.ts test/security-library.test.ts`.

Produces `createGuard(options): ConversationGuard` with:
- `check`: message length first (no counting), then conversation newness via `store.increment('guard:conv:' + clientId + ':' + conversationId, 86400) === 1` which increments `guard:client:` + clientId + ':' + utcDay with ttl 86400 and refuses past `conversationsPerClientPerDay`, then `guard:msgs:` + sessionId + ':' + utcHour with ttl 3600 refusing past `messagesPerSessionPerHour`.
- `wrap`: on refusal reply `GuardRefusal[verdict]` and audit `guard.refused` with `injectionFlags(text)`; on allow with flags audit `guard.flagged`; then call the inner handler. `onHandoff` and `onError` pass through.
- `reserveModelCall`: `guard:model:` + utcDay, ttl 86400, false past `modelCallsPerDay`.
- Key prefixes are a const map `GuardKey`.
`test/security-library.test.ts` adds one harness test per "exists" row of the security view: impersonator (assertion signed by a key not in the client's JWKS is rejected), token thief (DPoP proof replay rejected), stale token (expired session token rejected using `now`), SSRF prober (client_id on a private host refused), snoop (foreign conversation id returns 404), long-poll hog (`wait=600` is clamped to `Defaults.MaxWaitSeconds`).

### Task 2: catalog, machine, proposal

Files: `hosted/src/catalog.ts`, `hosted/src/machine.ts`, `hosted/src/proposal.ts`.
Tests: `npx vitest run test/hosted/catalog.test.ts test/hosted/machine.test.ts`.

Produces:
- `CATALOG: Record<EngagementId, Engagement>`; `FaqId` const map and `FAQ: Record<FaqId, { question: string; answer: string }>` (at least three entries from the landing page FAQ); `quote(terms: QuoteTerms): Quote` (discount is `DISCOUNT_FLOOR_PERCENT` when `prepay` or two or more engagements, else 0; `floorUsd = round(listTotal * 0.9)`); `quoteNumbers(q: Quote): Set<number>` with each line's list price, the list total, the total, the discount percent, and 0; never the floor.
- `transition(state, event): NegotiationState | undefined` from a `Transitions` table; `class ActionNotAllowedError extends Error` with a `reason` from a `DenyReason` const map; `assertAllowed(evidence: ActionEvidence, state): void` per the manifest table in the spec; `missingFields(fields): FieldName[]` (company, sells, and at least one of apis, idp, timeline); `mergeFields(prior, next): Fields` (null keeps prior, non-empty arrays replace, `prepay` is prior or next, `intent`, `askedPriceUsd`, `askedDiscountPercent` always come from next); `newRecord(conversationId, clientId, userId, now): NegotiationRecord`; `class MemoryNegotiationStore implements NegotiationStore`.
- `buildProposal(fields, quote, now): Proposal` (scope from catalog lines, assumptions list, `validUntil` now plus `PROPOSAL_VALID_DAYS`); `proposalData(p): Record<string, unknown>` returning `{ proposal: p }`.

### Task 3: extractor, writer, Vertex model

Files: `hosted/src/extractor.ts`, `hosted/src/writer.ts`, `hosted/src/vertex.ts`.
Tests: `npx vitest run test/hosted/writer.test.ts`.

Produces:
- `createExtractor(model, budget, log): Extractor`. Prompt holds the field list, three to five JSON examples and the intent enum. `json: true`. Parse with `FieldsSchema.safeParse`; on failure one repair call that includes the invalid text; then return prior. Model throw: log `ModelFailed` with `ref`, return prior. Budget false: log `BudgetExhausted`, return prior. Result is `mergeFields(prior, parsed)`.
- `priceNumbers(text): number[]` (`$75,000`, `75,000 USD`, `67.5k`, `$80k`); `groundNumbers(text, quote?)`; `createWriter(model, budget, log): ReplyWriter` which returns model text when grounded, else `FixedReply.GroundingFailed` plus one line per quote line ("Gateway implementation: $75,000") and logs `ReplyRewritten`; budget false returns `FixedReply.BudgetExhausted` with no model call; model throw returns a template from a `Template` const map keyed by action and logs `ModelFailed`. 8 s timeout via `AbortSignal.timeout(MODEL_TIMEOUT_MS)` is the Vertex client's job.
- `createVertexModel({ project, location, model }): TextModel` using `new GoogleGenAI({ vertexai: true, project, location })`, `responseMimeType: 'application/json'` when `json`, retries on 429/5xx with full-jitter backoff (max 3), timeout `MODEL_TIMEOUT_MS`.

### Task 4: lead, config, server, handler, deploy files

Files: `hosted/src/lead.ts`, `hosted/src/config.ts`, `hosted/src/server.ts`, `hosted/src/handler.ts`, `hosted/Dockerfile`, `hosted/deploy.sh`, `hosted/.env.example`.
Tests: `npx vitest run test/hosted/lead.test.ts`, then after Tasks 2 and 3 land: `npx vitest run test/hosted/handler.test.ts test/hosted/security.test.ts`.

Produces:
- `createLeadDispatcher({ sink, fallback, counters, log, now }): LeadDispatcher`; `createLoggingSink(write): LeadSink`; `createResendSink({ apiKey, to, from, fetch? }): LeadSink`; `leadHasEvidence(lead): boolean`.
- `HostedCaps` const (30, 10, 40, 20, 400, 4000, 65536), `EnvVar` const map (`PORT`, `POPPY_ISSUER`, `POPPY_PUBLIC_DOMAIN`, `POPPY_SIGNING_KEY_JWK`, `GOOGLE_CLOUD_PROJECT`, `GEMINI_LOCATION`, `GEMINI_MODEL`, `RESEND_API_KEY`, `LEAD_TO`, `LEAD_FROM`), `HostedConfig`, `loadConfig(env)`.
- `createHosted(config, deps): Promise<{ app: Hono; gateway: PoppyGateway }>`: `bodyLimit` 64 KB returning 413, `/readyz`, gateway with no `signIn`, `poppyDomains: [publicDomain]`, `rateLimits` from caps, guard wrapping the negotiator, audit to stdout JSON (no headers ever logged). Main block starts the server with the Vertex model and the Resend or logging sink.
- `createNegotiator(deps): Negotiator` per the handler behavior section of the brief.
- Dockerfile builds `dist-hosted` with `npm run build:hosted` and runs `node dist-hosted/hosted/src/server.js`; `deploy.sh` mirrors `/Users/b/Desktop/code/aisle/deploy.sh` (project `cast-commerce-prod`, service `poppy-agent`, `--min-instances 1 --max-instances 2 --concurrency 80 --cpu-throttling`, secrets `poppy-agent-signing-key` and `poppy-agent-resend-key` read with `secret_or_empty`).

## Wave 2 (controller)

- Full verify: `npm run lint && npm run typecheck && npm test`.
- Commit, push.
- Create secrets, deploy, smoke test, run a live negotiation with a `PoppyAgent` script.
- Update Netlify `poppy.json`, the `/poppy/` hero block, README "Talk to our agent"; verify phone and desktop; deploy Netlify.
