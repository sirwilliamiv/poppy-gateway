/**
 * A buyer's personal agent negotiating with Origin Platform Labs' hosted Poppy front door.
 *
 * The agent's public metadata lives on the Origin Platform Labs site (/agent.json and /jwks.json) so the
 * company can verify it; the private key lives outside the site in demo-agent/keys.json.
 *
 *   AGENT_KEYS=/path/to/keys.json npx tsx examples/opl-agent.ts
 *   COMPANY=localhost:8080 ALLOW_HTTP=1 AGENT_KEYS=... npx tsx examples/opl-agent.ts   (against a local hosted server)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { PoppyAgent, type AgentKeys } from '../src/agent/index.js';
import { SigningAlg } from '../src/constants.js';

const COMPANY = process.env.COMPANY ?? 'origin-platform-labs.netlify.app';
const ALLOW_HTTP = process.env.ALLOW_HTTP === '1';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'https://origin-platform-labs.netlify.app';
const KEYS_PATH = process.env.AGENT_KEYS ?? '/Users/b/Desktop/code/origin-platform-labs-site/demo-agent/keys.json';
const PUBLIC_DIR = process.env.AGENT_PUBLIC_DIR;

interface StoredKeys {
  privateJwk: JWK;
  publicJwk: JWK;
  kid: string;
}

async function loadOrCreateKeys(): Promise<AgentKeys> {
  let stored: StoredKeys;
  try {
    stored = JSON.parse(await readFile(KEYS_PATH, 'utf8')) as StoredKeys;
  } catch {
    const { privateKey, publicKey } = await generateKeyPair(SigningAlg.ES256, { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(publicJwk);
    publicJwk.kid = kid;
    publicJwk.alg = SigningAlg.ES256;
    publicJwk.use = 'sig';
    stored = { privateJwk: await exportJWK(privateKey), publicJwk, kid };
    await writeFile(KEYS_PATH, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
    console.log(`wrote new agent keys to ${KEYS_PATH}`);
  }
  const privateKey = (await importJWK(stored.privateJwk, SigningAlg.ES256)) as AgentKeys['privateKey'];
  return { privateKey, publicJwk: stored.publicJwk, kid: stored.kid };
}

type Ev = { type: string; status?: string; message?: { role: string; text?: string; data?: Record<string, unknown> } };

function print(events: Ev[]): void {
  for (const e of events) {
    if (e.type === 'message') {
      console.log(`   [${e.message?.role}] ${e.message?.text ?? ''}`);
      if (e.message?.data?.proposal) console.log('   proposal:', JSON.stringify(e.message.data.proposal, null, 2).split('\n').join('\n   '));
      if (e.message?.data?.quote) console.log('   quote:', JSON.stringify(e.message.data.quote));
    } else console.log(`   (${e.type}${e.status ? ' ' + e.status : ''})`);
  }
}

async function main(): Promise<void> {
  const keys = await loadOrCreateKeys();
  const agent = new PoppyAgent({ clientId: `${CLIENT_ORIGIN}/agent.json`, clientName: 'Origin Platform Labs test agent', keys });

  if (PUBLIC_DIR) {
    await writeFile(`${PUBLIC_DIR}/agent.json`, JSON.stringify(agent.metadataDocument(), null, 2) + '\n');
    await writeFile(`${PUBLIC_DIR}/jwks.json`, JSON.stringify(agent.jwks(), null, 2) + '\n');
    console.log(`wrote ${PUBLIC_DIR}/agent.json and jwks.json; deploy the site, then run again without AGENT_PUBLIC_DIR`);
    return;
  }

  console.log(`\n1. Discover ${COMPANY}`);
  const company = await agent.discover(COMPANY, { allowHttp: ALLOW_HTTP });
  console.log('   issuer:', company.oauth.issuer);
  console.log('   conversations:', company.document.agent?.protocols?.[0]?.endpoint);

  console.log('\n2. Session (signed out, DPoP)');
  const session = await agent.session(company, 'usr_test_buyer');
  const t = await session.start();
  console.log('   session', t.sessionId, 'token_type', t.tokenType);

  const turns = [
    'We are Acme Outdoor, we sell outdoor gear online. We want our customers’ agents to be able to check orders. Budget around $80k.',
    'Our orders API is REST behind Okta. We want it live this quarter. The gateway implementation is what we need.',
    'Can you do 20% less?',
  ];
  let id = '';
  for (const [i, text] of turns.entries()) {
    console.log(`\n${3 + i}. Buyer: ${text}`);
    const res = id ? await session.sendMessage(id, { sender: 'agent', text }, { wait: 20 }) : await session.startConversation({ sender: 'agent', text }, { wait: 20 });
    id = id || (res.conversation_id as string);
    print(res.events as Ev[]);
  }

  console.log('\n6. Sign out');
  await session.signOut();
  console.log('   done; conversation', id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
