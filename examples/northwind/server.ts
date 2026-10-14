/**
 * Northwind Outfitters: a fictional retailer running poppy-gateway locally.
 *
 *   npm run demo          starts the company on http://localhost:8787
 *   npm run demo:agent    runs a personal agent against it (in another terminal)
 *
 * Everything is in one process for the demo: the gateway routes, a tiny orders API,
 * a consent page for direct sign-in, a device verification page, and a company agent.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ApiType, Scope, createPoppyGateway, generateSigningKey, type CompanyAgentHandler } from '../../src/index.js';

const PORT = Number(process.env.PORT ?? 8787);
const ORIGIN = `http://localhost:${PORT}`;
const DOMAIN = `localhost:${PORT}`;

const accounts: Record<string, { password: string; account: string }> = {
  'alice@example.com': { password: 'correct horse', account: 'acct_alice' },
};
const orders = [
  { id: 'ord_1042', account: 'acct_alice', item: 'Stormline jacket, medium', status: 'delivered' },
  { id: 'ord_1043', account: 'acct_alice', item: 'Trail socks, 3 pack', status: 'shipped' },
];

const companyAgent: CompanyAgentHandler = {
  async onMessage(message, ctx) {
    const text = (message.text ?? '').toLowerCase();
    if (text.includes('order')) {
      if (!ctx.principal.signedIn) {
        await ctx.requestAuthorization([Scope.Read]);
        await ctx.reply({ text: 'I can look that up once the customer signs in.' });
        return;
      }
      const mine = orders.filter((o) => o.account === ctx.principal.account);
      await ctx.reply({ text: `I see ${mine.length} orders on the account.`, data: { orders: mine } });
      return;
    }
    if (text.includes('person') || text.includes('human')) {
      await ctx.reply({ text: 'Let me find someone for you.' });
      await ctx.queueForHuman();
      return;
    }
    await ctx.reply({ text: `Northwind here. You said: ${message.text ?? JSON.stringify(message.data)}` });
  },
  onHandoff: () => 'queued',
  onError: (e, id) => console.error('company agent error', id, e),
};

const page = (title: string, body: string): string =>
  `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:.5rem 0}button{padding:.5rem 1rem}</style><h1>${title}</h1>${body}`;

async function main(): Promise<void> {
  const signingKey = await generateSigningKey();
  const gateway = createPoppyGateway({
    organization: { name: 'Northwind Outfitters', domain: DOMAIN },
    issuer: ORIGIN,
    signingKey,
    clients: { allowPrivateHosts: true },
    customScopes: { addresses: 'Manage saved shipping addresses' },
    signIn: {
      direct: {
        scopes: [Scope.Read, Scope.Write, 'addresses'],
        onAuthorize: ({ requestId, clientName, requestedScopes, scopeDescriptions }) =>
          new Response(
            page(
              `${clientName} wants access`,
              `<form method="post" action="/consent"><input type="hidden" name="request_id" value="${requestId}">` +
                `<label>Email <input name="email" value="alice@example.com"></label><label>Password <input name="password" type="password" value="correct horse"></label>` +
                requestedScopes.map((s) => `<label><input type="checkbox" name="scope" value="${s}" checked> ${s}: ${scopeDescriptions[s]}</label>`).join('') +
                `<button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Decline</button></form>`,
            ),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          ),
      },
      device: {
        scopes: [Scope.Read, Scope.Write],
        onVerify: ({ userCode, clientName, requestedScopes }) =>
          new Response(
            page(
              'Sign in to approve a device',
              `<form method="post" action="/device"><label>Code <input name="user_code" value="${userCode ?? ''}"></label>` +
                (clientName ? `<p>${clientName} asks for: ${requestedScopes.join(', ')}</p>` : '') +
                `<label>Email <input name="email" value="alice@example.com"></label><label>Password <input name="password" type="password" value="correct horse"></label>` +
                `<button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Decline</button></form>`,
            ),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          ),
      },
      mediated: {
        scopes: [Scope.Read],
        fields: [
          { name: 'email', label: 'Email', secret: false },
          { name: 'password', label: 'Password', secret: true },
        ],
        verify: ({ email, password }) => {
          const a = accounts[email ?? ''];
          return a && a.password === password ? { outcome: 'complete', account: a.account } : { outcome: 'failed' };
        },
      },
    },
    apis: [{ type: ApiType.OpenApi, url: `${ORIGIN}/openapi.json`, description: 'Orders, returns, and exchanges' }],
    agent: { handler: companyAgent },
    web: { browserSession: true },
    audit: (e) => console.log('[audit]', JSON.stringify(e)),
  });

  const app = new Hono();

  app.get('/', (c) => c.html(page('Northwind Outfitters', `<p>A demo company that speaks Poppy. See <a href="/.well-known/poppy.json">/.well-known/poppy.json</a>.</p>`)));
  app.get('/openapi.json', (c) =>
    c.json({
      openapi: '3.1.0',
      info: { title: 'Northwind Orders', version: '1.0.0' },
      servers: [{ url: ORIGIN }],
      paths: {
        '/api/stock': { get: { summary: 'Check stock (signed out is fine)' } },
        '/api/orders': { get: { summary: 'List the account orders (poppy:read)' } },
        '/api/orders/{id}/exchanges': { post: { summary: 'Exchange an item (poppy:write)' } },
      },
    }),
  );

  // The company's own APIs, protected with the gateway.
  app.get('/api/stock', (c) => gateway.protect({}, (_r, p) => Response.json({ in_stock: true, session: p.sessionId, signed_in: p.signedIn }))(c.req.raw));
  app.get('/api/orders', (c) => gateway.protect({ scopes: [Scope.Read] }, (_r, p) => Response.json({ orders: orders.filter((o) => o.account === p.account) }))(c.req.raw));
  app.post('/api/orders/:id/exchanges', (c) =>
    gateway.protect({ scopes: [Scope.Read, Scope.Write] }, async (_r, p) => Response.json({ exchanged: true, order: c.req.param('id'), account: p.account }))(c.req.raw),
  );

  // Consent page submit (direct sign-in).
  app.post('/consent', async (c) => {
    const form = await c.req.formData();
    const requestId = String(form.get('request_id') ?? '');
    const a = accounts[String(form.get('email') ?? '')];
    if (form.get('decision') !== 'approve' || !a || a.password !== String(form.get('password') ?? '')) {
      const { redirectUrl } = await gateway.denyAuthorization(requestId);
      return c.redirect(redirectUrl, 302);
    }
    const scopes = form.getAll('scope').map(String);
    const { redirectUrl } = await gateway.completeAuthorization(requestId, { account: a.account, scopes });
    return c.redirect(redirectUrl, 302);
  });

  // Device verification submit.
  app.post('/device', async (c) => {
    const form = await c.req.formData();
    const userCode = String(form.get('user_code') ?? '');
    const a = accounts[String(form.get('email') ?? '')];
    if (form.get('decision') !== 'approve' || !a || a.password !== String(form.get('password') ?? '')) {
      await gateway.denyDevice(userCode);
      return c.html(page('Declined', '<p>The device was not approved.</p>'));
    }
    const record = await gateway.store.getDeviceCodeByUserCode(userCode.toUpperCase());
    await gateway.approveDevice(userCode, { account: a.account, scopes: record?.requestedScopes ?? [Scope.Read] });
    return c.html(page('Approved', '<p>You can close this page.</p>'));
  });

  // A website page that honors the browser session cookie.
  app.get('/orders', async (c) => {
    const site = await gateway.sessionFromCookie(c.req.raw);
    if (!site) return c.html(page('Orders', '<p>No Poppy session on this browser.</p>'));
    if (!site.signedIn) return c.html(page('Orders', `<p>Session ${site.session.id} is signed out.</p>`));
    return c.html(page('Orders', `<p>Signed in as ${site.account} with scopes ${site.scopes.join(', ')}.</p><ul>${orders.filter((o) => o.account === site.account).map((o) => `<li>${o.id}: ${o.item} (${o.status})</li>`).join('')}</ul>`));
  });

  // Everything Poppy: discovery, token, revoke, authorize, device, mediated, browser session, conversations.
  app.all('*', async (c) => (await gateway.handle(c.req.raw)) ?? c.notFound());

  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`Northwind Outfitters listening on ${ORIGIN}`);
    console.log(`poppy.json: ${ORIGIN}/.well-known/poppy.json`);
  });
}

void main();
