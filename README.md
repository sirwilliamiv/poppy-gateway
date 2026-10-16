# poppy-gateway

Company-side implementation of the [Personal Agent Protocol](https://personalagentprotocol.org) (Poppy) draft 0.1, in TypeScript, with a conformance suite and a personal agent client.

Poppy is the open protocol from Sierra and Meta that lets a customer's personal AI agent discover a company, sign in with the customer's approval, act within granted scopes across the company's website, APIs, and support agent, and identify itself on every request. This package is the piece a company deploys to speak it.

Built and maintained by [Origin Platform Labs](https://origin-platform-labs.netlify.app/poppy/), which also offers fixed-price Poppy readiness and implementation engagements.

## What it implements

| Spec section | Feature | Status |
| --- | --- | --- |
| 3 Discovery | `poppy.json` builder and validator, RFC 8414 metadata with `poppy_domains`, JWKS | done |
| 4.1 Agent identity | Client metadata fetch with SSRF guard, size and time limits, cache; `private_key_jwt` client assertions; allowlist, blocklist, registration | done |
| 4.2 Sessions | JWT bearer grant, session creation and renewal, opaque per-company user IDs, `jti` replay cache | done |
| 4.3 Session tokens | DPoP-bound session tokens (RFC 9449) with `htm`, `htu`, `ath`, `jti`, optional nonce; Bearer tokens for MCP only; `resource` narrowing (RFC 8707); rate limits with `Retry-After` | done |
| 4.4 Scopes | `poppy:read`, `poppy:write`, custom scopes, per-sign-in-type scope lists, scope narrowing on refresh | done |
| 4.5 Direct sign-in | Authorization code with PKCE and `session_id`, `iss` on the redirect, consent page hook | done |
| 4.6 Device sign-in | RFC 8628 device grant with `slow_down`, verification page hook | done |
| 4.7 Mediated sign-in | Credentials endpoint, one-time code step, attempt limits, rate limits | done |
| 4.8 Account tokens | Opaque refresh tokens stored hashed, optional rotation, `account_mismatch`, `invalid_session` | done |
| 4.9 Sign-out | RFC 7009 revocation, immediate effect on live sessions, account-settings disconnect | done |
| 5 Web browsing | Browser session endpoint, cookie issuance, `sessionFromCookie` for the website | done |
| 6 APIs | `authenticate` and `protect` middleware with `invalid_token`, `sign_in_required`, `insufficient_scope` in `WWW-Authenticate`; RFC 9728 protected resource metadata for MCP | done |
| 7 Conversations | Start, messages, events with cursors and `wait`, SSE streaming, status and responder, handoff, direct conversations, sign-in mid-conversation, idempotent message IDs, close | done |
| Operations extension | Advertised in `poppy.json`; propose, confirm, and track endpoints | planned |

Runtime dependency: [`jose`](https://github.com/panva/jose). Everything is written against the WHATWG `Request` and `Response` types, so it runs on Node 20+, Cloudflare Workers, Deno, Bun, Hono, Next.js route handlers, and anything else that speaks fetch.

## Install

```sh
npm install poppy-gateway
```

## Quick start

```ts
import { createPoppyGateway, generateSigningKey, Scope } from 'poppy-gateway';

const signingKey = await generateSigningKey(); // persist signingKey.privateJwk and reuse it with importSigningKey

const gateway = createPoppyGateway({
  organization: { name: 'Example Company', domain: 'example.com' },
  issuer: 'https://auth.example.com',
  signingKey,
  signIn: {
    direct: {
      scopes: [Scope.Read, Scope.Write],
      onAuthorize: ({ requestId, clientName, requestedScopes }) =>
        // Render your own sign-in and consent page. When the user approves, call
        // gateway.completeAuthorization(requestId, { account, scopes }) and redirect.
        renderConsentPage({ requestId, clientName, requestedScopes }),
    },
  },
  apis: [{ type: 'openapi', url: 'https://api.example.com/openapi.json', description: 'Orders and returns' }],
  agent: { handler: companyAgent },
  web: { browserSession: true },
});

// 1. Publish discovery.
//    https://example.com/.well-known/poppy.json              -> gateway.document()
//    https://auth.example.com/.well-known/oauth-authorization-server -> gateway.oauthMetadata()
//    Or let gateway.handle serve them on the issuer origin.

// 2. Route the gateway's own endpoints (token, revoke, authorize, device, sign-in, browser session, conversations).
export default { fetch: async (request: Request) => (await gateway.handle(request)) ?? new Response('not found', { status: 404 }) };

// 3. Protect your own APIs.
app.get('/orders', gateway.protect({ scopes: [Scope.Read] }, async (request, principal) => {
  return Response.json(await listOrders(principal.account));
}));
```

`principal` carries `clientId` (which personal agent), `userId` (the agent's stable opaque ID for the user), `sessionId`, `account` and `scopes` when signed in, and `signedIn`. Every request a personal agent makes is attributable.

## Run the demo

```sh
npm install
npm run demo          # Northwind Outfitters on http://localhost:8787
npm run demo:agent    # in another terminal: a personal agent walks through discovery, sessions, sign-in, APIs, and a conversation
```

The demo company exposes all three sign-in types, a consent page, a device verification page, an orders API, a website page that honors the browser session cookie, and a company agent. Open the direct sign-in URL the agent prints to try the consent flow in a browser.

## Talk to our agent

Origin Platform Labs runs this gateway in production as its own front door. Point a Poppy agent at `origin-platform-labs.netlify.app` and a company agent will scope an engagement, quote from the public catalog, and hand a proposal to a person. No sign-in is needed to negotiate.

```ts
import { PoppyAgent, generateAgentKeys } from 'poppy-gateway/agent';

const agent = new PoppyAgent({ clientId: 'https://you.example/agent.json', clientName: 'Your agent', keys: await generateAgentKeys() });
const company = await agent.discover('origin-platform-labs.netlify.app');
const session = await agent.session(company, 'user_123');
await session.start();
const started = await session.startConversation({ sender: 'agent', text: 'We need Poppy for our customers. Budget around $80k.' }, { wait: 10 });
```

Conversations endpoint: `https://poppy-agent-951611905723.us-central1.run.app/poppy/conversations`. The hosted service is `hosted/` in this repo: the gateway with rate limits on, an abuse guard (`createGuard`), and a negotiating handler whose prices come from code, never from the model. Every control in the security view has a test in `test/security-library.test.ts` and `test/hosted/security.test.ts`.

## Wiring it into an existing stack

- **Identity provider:** session tokens are OAuth access tokens and account tokens are refresh tokens. The gateway issues them itself and verifies the user with your existing login inside `onAuthorize`, `onVerify`, or `verify`. Your IdP never needs to learn DPoP.
- **Storage:** `MemoryStore` ships for development and single-instance deployments. Implement the `Store` interface (sessions, account tokens, codes, replay cache, conversations) on Redis or SQL for production. All methods are async and documented in `src/store.ts`.
- **Behind a proxy:** pass `publicOrigin` when the issuer is not the origin agents reach, and pass `publicUrl` to `authenticate` or `protect` when your framework rewrites `request.url`. DPoP proofs are checked against the public URL the agent used.
- **MCP servers:** list them in `apis` with `type: 'mcp'`. The gateway issues Bearer tokens only for those URLs, accepts them only there, and serves RFC 9728 metadata so standard MCP clients find your issuer.
- **Audit:** every session start, sign-in, token issue, revocation, and conversation event reaches the `audit` callback. Secrets are never included.
- **Agent policy:** `clients.allowlist`, `clients.blocklist`, `clients.requireRegistration`, and `clients.policy` decide which personal agents you accept. `rateLimits` caps sessions and token requests per `client_id`.

## Personal agent client

`poppy-gateway/agent` contains `PoppyAgent`, a small client that implements the agent side: discovery with issuer cross-checks, session assertions, DPoP proofs with nonce recovery, all three sign-in flows, account tokens, browser assertions, and conversations with long polling and SSE. The conformance tests and the demo use it; it is a reasonable starting point for a real personal agent.

## Conformance tests

```sh
npm test
```

Forty-five tests drive a virtual network (agent, company, API, and MCP hosts) through every flow in the spec, including the negative cases: replayed proofs, wrong `htu`, stolen tokens, reused codes, bad PKCE, cross-account sessions, blocked clients, rate limits, nonces, cursor errors, and ownership checks on conversations. Run them against your own deployment by pointing the harness at your hosts.

## Security notes

- Assertions are verified only against keys from the agent's `jwks_uri`. `alg: none`, HS256, `jku`, `x5u`, and embedded keys are rejected. DPoP proofs are the one case where the key comes from the proof header, as the spec requires.
- Account tokens are stored as SHA-256 hashes. Mediated sign-in credentials are passed to your `verify` callback and never stored or echoed.
- Metadata fetches refuse redirects, private and loopback hosts (unless `allowPrivateHosts` is set for development), bodies over 100 KB, and take longer than 5 seconds.
- Responses carrying tokens or codes send `Cache-Control: no-store`.
- Tokens in URLs are rejected on every protected route.

## Status

Draft 0.1 can change before 1.0, including incompatibly. This package tracks the draft and will version with it. Breaking spec changes become minor version bumps until 1.0.

## License

Apache 2.0. See [LICENSE](./LICENSE).
