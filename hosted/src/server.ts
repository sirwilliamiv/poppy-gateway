import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  MemoryStore,
  createGuard,
  createPoppyGateway,
  generateSigningKey,
  importSigningKey,
  type AuditEvent,
  type PoppyGateway,
  type PoppyGatewayConfig,
  type SigningKey,
} from '../../src/index.js';
import { EnvVar, loadConfig, type HostedConfig } from './config.js';
import type { LeadSink, NegotiationLogger, TextModel } from './contracts.js';
import { createNegotiator } from './handler.js';
import { createLeadDispatcher, createLoggingSink, createResendSink } from './lead.js';
import { MemoryNegotiationStore } from './machine.js';
import { createVertexModel } from './vertex.js';

export interface HostedDeps {
  model: TextModel;
  signingKey: SigningKey;
  sink?: LeadSink;
  audit?: (e: AuditEvent) => void;
  log?: NegotiationLogger;
  now?: () => number;
}

export const ServerLogType = {
  Request: 'http.request',
  Started: 'server.started',
} as const;

export const ServerError = {
  PayloadTooLarge: 'payload_too_large',
} as const;

const HTTP_PAYLOAD_TOO_LARGE = 413;
const LANDING_URL = 'https://origin-platform-labs.netlify.app/poppy/';

const HOME_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Origin Platform Labs Poppy agent</title>' +
  '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}</style></head>' +
  `<body><p>This is the Origin Platform Labs Poppy agent. Personal agents reach it through the Poppy protocol to scope an engagement and get a quote from the published catalog. Humans will find the details, prices and the URL to point an agent at on <a href="${LANDING_URL}">${LANDING_URL}</a>.</p></body></html>`;

const stdoutJson = (e: unknown): void => console.log(JSON.stringify(e));

export async function createHosted(config: HostedConfig, deps: HostedDeps): Promise<{ app: Hono; gateway: PoppyGateway }> {
  const { caps } = config;
  const audit = deps.audit ?? stdoutJson;
  const log: NegotiationLogger = deps.log ?? { event: stdoutJson };
  const now = deps.now ?? Date.now;
  const store = new MemoryStore();

  const guard = createGuard({
    store,
    messagesPerSessionPerHour: caps.messagesPerSessionPerHour,
    conversationsPerClientPerDay: caps.conversationsPerClientPerDay,
    modelCallsPerDay: caps.modelCallsPerDay,
    maxMessageChars: caps.maxMessageChars,
    audit,
    now,
  });
  const loggingSink = createLoggingSink((line) => console.log(line));
  const leads = createLeadDispatcher({ sink: deps.sink ?? loggingSink, fallback: loggingSink, counters: store, log, now });
  const negotiator = createNegotiator({ model: deps.model, budget: guard, store: new MemoryNegotiationStore(), leads, log, now });

  const gatewayConfig: PoppyGatewayConfig = {
    organization: { name: config.organizationName, domain: config.publicDomain },
    issuer: config.issuer,
    poppyDomains: [config.publicDomain],
    signingKey: deps.signingKey,
    store,
    agent: { handler: guard.wrap(negotiator) },
    rateLimits: {
      tokenRequestsPerClientPerMinute: caps.tokenRequestsPerClientPerMinute,
      sessionsPerClientPerMinute: caps.sessionsPerClientPerMinute,
    },
    audit,
  };
  if (deps.now) gatewayConfig.now = deps.now;
  const gateway = createPoppyGateway(gatewayConfig);

  const app = new Hono();
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    stdoutJson({ type: ServerLogType.Request, method: c.req.method, path: c.req.path, status: c.res.status, durationMs: Math.round(performance.now() - started) });
  });
  app.use('*', bodyLimit({ maxSize: caps.maxBodyBytes, onError: (c) => c.json({ error: ServerError.PayloadTooLarge }, HTTP_PAYLOAD_TOO_LARGE) }));
  app.get('/readyz', (c) => c.json({ ok: true }));
  app.get('/', (c) => c.html(HOME_PAGE));
  app.all('*', async (c) => (await gateway.handle(c.req.raw)) ?? c.notFound());

  return { app, gateway };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  let signingKey: SigningKey;
  if (config.signingKeyJwk !== undefined) {
    signingKey = await importSigningKey(JSON.parse(config.signingKeyJwk));
  } else {
    console.warn(`${EnvVar.SigningKeyJwk} is not set; using a generated signing key, so tokens will not survive restarts.`);
    signingKey = await generateSigningKey();
  }
  const model = createVertexModel({ project: config.project, location: config.geminiLocation, model: config.geminiModel });
  const deps: HostedDeps = { model, signingKey };
  if (config.resendApiKey !== undefined) deps.sink = createResendSink({ apiKey: config.resendApiKey, to: config.leadTo, from: config.leadFrom });
  const { app } = await createHosted(config, deps);
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    stdoutJson({ type: ServerLogType.Started, port: info.port, issuer: config.issuer, leadSink: deps.sink?.kind ?? null });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
