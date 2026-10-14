/**
 * A personal agent walking through Northwind: discovery, a signed-out session, an API call,
 * mediated sign-in, a signed-in API call, a browser assertion, and a conversation.
 *
 * It hosts its own client metadata on http://localhost:8788 so the company can verify it.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { PoppyAgent, generateAgentKeys } from '../../src/agent/index.js';

const AGENT_PORT = Number(process.env.AGENT_PORT ?? 8788);
const AGENT_ORIGIN = `http://localhost:${AGENT_PORT}`;
const COMPANY = process.env.COMPANY ?? 'localhost:8787';

async function main(): Promise<void> {
  const keys = await generateAgentKeys();
  const agent = new PoppyAgent({ clientId: `${AGENT_ORIGIN}/agent.json`, clientName: 'Demo Personal Agent', keys });

  const app = new Hono();
  app.get('/agent.json', (c) => c.json(agent.metadataDocument()));
  app.get('/jwks.json', (c) => c.json(agent.jwks()));
  app.get('/oauth/callback', (c) => c.text(`Callback received: ${c.req.url}`));
  const server = serve({ fetch: app.fetch, port: AGENT_PORT });

  try {
    console.log(`\n1. Discover ${COMPANY}`);
    const company = await agent.discover(COMPANY, { allowHttp: true });
    console.log('   issuer:', company.oauth.issuer);
    console.log('   sign-in types:', Object.keys(company.document.auth ?? {}).filter((k) => ['direct', 'device', 'mediated'].includes(k)).join(', '));

    console.log('\n2. Start a signed-out session');
    const session = await agent.session(company, 'usr_demo_alice');
    const t = await session.start();
    console.log('   session', t.sessionId, 'signed_in', t.signedIn, 'token_type', t.tokenType);

    const base = `http://${COMPANY}`;
    console.log('\n3. Call a public API with the session token');
    console.log('   ', await (await session.fetch(`${base}/api/stock`)).json());

    console.log('\n4. Try account data signed out');
    const denied = await session.fetch(`${base}/api/orders`);
    console.log('   ', denied.status, denied.headers.get('www-authenticate'));

    console.log('\n5. Mediated sign-in (the demo account)');
    const signIn = await session.mediatedSignIn(['poppy:read'], { email: 'alice@example.com', password: 'correct horse' });
    console.log('   status', signIn.status, 'scope', session.scope);

    console.log('\n6. Account data signed in');
    console.log('   ', await (await session.fetch(`${base}/api/orders`)).json());

    console.log('\n7. A write without poppy:write');
    const ex = await session.fetch(`${base}/api/orders/ord_1042/exchanges`, { method: 'POST' });
    console.log('   ', ex.status, ex.headers.get('www-authenticate'));

    console.log('\n8. Direct sign-in URL you can open in a browser to grant poppy:write');
    console.log('   ', session.directSignIn(['poppy:read', 'poppy:write']).url);

    console.log('\n9. Browser assertion (post this from a browser you control)');
    const assertion = await session.browserAssertion(`${base}/orders`);
    console.log('   ', assertion.slice(0, 40) + '...');

    console.log('\n10. Conversation');
    const started = await session.startConversation({ sender: 'agent', text: 'Where is my latest order?', context: { locale: 'en-US', user_available: true } }, { wait: 5 });
    for (const e of started.events as Array<{ type: string; message?: { role: string; text?: string } }>) {
      if (e.type === 'message') console.log(`   [${e.message?.role}] ${e.message?.text ?? ''}`);
      else console.log(`   (${e.type})`);
    }
    await session.closeConversation(started.conversation_id as string);

    console.log('\n11. Sign out');
    await session.signOut();
    console.log('   ', (await session.fetch(`${base}/api/orders`)).status, 'after sign-out');
  } finally {
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
