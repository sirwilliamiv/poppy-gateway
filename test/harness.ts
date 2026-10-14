import { ApiType, Scope, type SignInType } from '../src/constants.js';
import { createPoppyGateway, generateSigningKey, type CompanyAgentHandler, type PoppyGateway, type PoppyGatewayConfig, type AuditEvent } from '../src/index.js';
import { PoppyAgent, generateAgentKeys, type AgentSession, type Company, type TokenSet } from '../src/agent/index.js';
import { jsonResponse } from '../src/errors.js';

export const COMPANY_DOMAIN = 'northwind.example';
export const ISSUER = 'https://auth.northwind.example';
export const API_ORIGIN = 'https://api.northwind.example';
export const MCP_URL = 'https://mcp.northwind.example/mcp';
export const AGENT_ORIGIN = 'https://agent.example';
export const AGENT_CLIENT_ID = `${AGENT_ORIGIN}/agent.json`;

export interface World {
  gateway: PoppyGateway;
  agent: PoppyAgent;
  company: Company;
  fetch: typeof fetch;
  audit: AuditEvent[];
  /** The last consent page request id captured from onAuthorize. */
  lastAuthorizeRequestId?: string;
  orders: Array<{ id: string; account: string; item: string }>;
  mediatedCode?: string;
  handlers: Map<string, (req: Request) => Promise<Response> | Response>;
}

export interface WorldOptions {
  gateway?: Partial<PoppyGatewayConfig>;
  companyAgent?: CompanyAgentHandler;
  mediatedTwoStep?: boolean;
}

export async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const audit: AuditEvent[] = [];
  const world: Partial<World> = { audit, orders: [{ id: 'ord_1', account: 'acct_alice', item: 'Stormline jacket' }], handlers: new Map() };

  const virtualFetch: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(typeof input === 'string' ? input : input.toString(), init);
    const url = new URL(req.url);
    const key = url.host + url.pathname;
    const custom = world.handlers?.get(key);
    if (custom) return custom(req);
    if (url.host === 'agent.example') {
      if (url.pathname === '/agent.json') return jsonResponse(world.agent!.metadataDocument(), 200, { 'cache-control': 'max-age=600' });
      if (url.pathname === '/jwks.json') return jsonResponse(world.agent!.jwks());
      return new Response('not found', { status: 404 });
    }
    if (url.host === COMPANY_DOMAIN && url.pathname === '/.well-known/poppy.json') return jsonResponse(world.gateway!.document());
    if (url.host === new URL(ISSUER).host) {
      const res = await world.gateway!.handle(req);
      return res ?? new Response('not found', { status: 404 });
    }
    if (url.host === new URL(API_ORIGIN).host) return apiHandler(world as World, req);
    if (url.host === new URL(MCP_URL).host) return mcpHandler(world as World, req);
    return new Response(`no route for ${req.url}`, { status: 502 });
  };
  world.fetch = virtualFetch;

  const signingKey = await generateSigningKey();
  const keys = await generateAgentKeys();
  world.agent = new PoppyAgent({ clientId: AGENT_CLIENT_ID, clientName: 'Test Agent', keys, fetch: virtualFetch, extensions: { operations: { version: '1' } } });

  const config: PoppyGatewayConfig = {
    organization: { name: 'Northwind Outfitters', domain: COMPANY_DOMAIN },
    issuer: ISSUER,
    signingKey,
    customScopes: { addresses: 'Manage saved shipping addresses' },
    signIn: {
      direct: {
        scopes: [Scope.Read, Scope.Write, 'addresses'],
        onAuthorize: (ctx) => {
          world.lastAuthorizeRequestId = ctx.requestId;
          return new Response(`<form>consent for ${ctx.clientName}: ${ctx.requestedScopes.join(' ')}</form>`, { status: 200, headers: { 'content-type': 'text/html' } });
        },
      },
      device: {
        scopes: [Scope.Read, Scope.Write],
        onVerify: (ctx) => new Response(`enter code ${ctx.userCode ?? ''} for ${ctx.clientName ?? ''}`, { status: 200, headers: { 'content-type': 'text/html' } }),
      },
      mediated: {
        scopes: [Scope.Read],
        fields: [
          { name: 'email', label: 'Email', secret: false },
          { name: 'password', label: 'Password', secret: true },
        ],
        verify: (creds) => {
          if (creds.email === 'alice@example.com' && creds.password === 'correct horse') {
            if (options.mediatedTwoStep) {
              world.mediatedCode = '246810';
              return { outcome: 'code_required', account: 'acct_alice', code: '246810', sentTo: 'Text to the phone number ending in 71' };
            }
            return { outcome: 'complete', account: 'acct_alice' };
          }
          return { outcome: 'failed' };
        },
      },
    },
    apis: [
      { type: ApiType.OpenApi, url: `${API_ORIGIN}/openapi.json`, description: 'Orders and returns' },
      { type: ApiType.Mcp, url: MCP_URL, description: 'Product search' },
    ],
    agent: { handler: options.companyAgent ?? echoAgent() },
    web: { browserSession: true },
    extensions: { operations: { version: '1', endpoint: `${API_ORIGIN}/poppy/operations` } },
    audit: (e) => audit.push(e),
    ...options.gateway,
    clients: { fetch: virtualFetch, ...options.gateway?.clients },
  };
  world.gateway = createPoppyGateway(config);
  world.company = await world.agent.discover(COMPANY_DOMAIN);
  return world as World;
}

export function echoAgent(): CompanyAgentHandler {
  return {
    async onMessage(message, ctx) {
      if (message.text?.includes('order')) {
        if (!ctx.principal.signedIn) {
          await ctx.requestAuthorization([Scope.Read]);
          await ctx.reply({ text: 'Please sign in so I can look up the order.' });
          return;
        }
        await ctx.reply({ text: `I found the order for ${ctx.principal.account}.`, data: { order_id: 'ord_1' } });
        return;
      }
      await ctx.reply({ text: `Echo: ${message.text ?? JSON.stringify(message.data ?? {})}` });
    },
    onHandoff() {
      return 'queued';
    },
  };
}

async function apiHandler(world: World, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const gateway = world.gateway;
  if (url.pathname === '/openapi.json') return jsonResponse({ openapi: '3.1.0', info: { title: 'Northwind', version: '1' }, paths: {} });
  if (url.pathname === '/public/stock') {
    return gateway.protect({}, (_r, p) => jsonResponse({ in_stock: true, session: p.sessionId, signed_in: p.signedIn }))(req);
  }
  if (url.pathname === '/orders' && req.method === 'GET') {
    return gateway.protect({ scopes: [Scope.Read], publicUrl: API_ORIGIN + url.pathname }, (_r, p) => jsonResponse({ orders: world.orders.filter((o) => o.account === p.account) }))(req);
  }
  if (url.pathname.startsWith('/orders/') && req.method === 'POST') {
    return gateway.protect({ scopes: [Scope.Read, Scope.Write], publicUrl: API_ORIGIN + url.pathname }, async (_r, p) => jsonResponse({ exchanged: true, account: p.account }))(req);
  }
  return new Response('not found', { status: 404 });
}

async function mcpHandler(world: World, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/.well-known/oauth-protected-resource') return jsonResponse(world.gateway.protectedResourceMetadata(MCP_URL));
  if (url.pathname === '/mcp') {
    return world.gateway.protect({ tokenTypes: ['Bearer'], resource: MCP_URL, publicUrl: MCP_URL }, (_r, p) => jsonResponse({ jsonrpc: '2.0', result: { ok: true, signed_in: p.signedIn, scopes: p.scopes } }))(req);
  }
  return new Response('not found', { status: 404 });
}

export async function signInDirect(world: World, scopes: string[], account = 'acct_alice'): Promise<TokenSet & { session: AgentSession }> {
  const session = await world.agent.session(world.company, 'usr_alice');
  await session.start();
  const pending = session.directSignIn(scopes);
  const consent = await world.fetch(pending.url);
  if (consent.status !== 200) throw new Error(`authorize returned ${consent.status}: ${await consent.text()}`);
  const { redirectUrl } = await world.gateway.completeAuthorization(world.lastAuthorizeRequestId!, { account, scopes });
  const tokens = await session.exchangeCode(redirectUrl, pending);
  return Object.assign(tokens, { session });
}

export const signInTypes: SignInType[] = ['direct', 'device', 'mediated'];
