import { decodeJwt } from 'jose';
import { ContentType, Header, IdPrefix, OAuthError } from './constants.js';
import type { GatewayContext } from './context.js';
import { normalizeDomain } from './discovery.js';
import { oauthError, PoppyError } from './errors.js';
import { randomToken } from './ids.js';
import { verifyBrowserAssertion } from './jwt.js';
import type { SessionRecord } from './types.js';

const DEFAULT_COOKIE = 'poppy_session';

function onCompanyDomain(ctx: GatewayContext, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ctx.urls.issuer.startsWith('http://'))) return false;
  const host = normalizeDomain(u.hostname);
  const domain = normalizeDomain(ctx.config.organization.domain);
  return host === domain || host.endsWith('.' + domain);
}

function errorPage(message: string): Response {
  const safe = message.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
  return new Response(`<!doctype html><title>Browser session rejected</title><h1>Browser session rejected</h1><p>${safe}</p>`, {
    status: 400,
    headers: { [Header.ContentType]: ContentType.Html, [Header.CacheControl]: 'no-store' },
  });
}

/** POST browser session endpoint (spec section 5): verifies the browser assertion, sets the company's cookie, 303 to return_to. */
export async function handleBrowserSession(ctx: GatewayContext, request: Request): Promise<Response> {
  const web = ctx.config.web;
  if (!web?.browserSession) return errorPage('browser sessions are not offered');

  try {
    const ct = request.headers.get(Header.ContentType) ?? '';
    if (!ct.toLowerCase().startsWith(ContentType.Form)) return errorPage('assertion must be a form POST');
    const assertion = new URLSearchParams(await request.text()).get('assertion') ?? '';
    if (!assertion) return errorPage('assertion is required');
    if (new URL(request.url).searchParams.has('assertion')) return errorPage('assertion must not be in the URL');
    let clientId: string;
    try {
      const iss = decodeJwt(assertion).iss;
      if (typeof iss !== 'string') throw new Error('no iss');
      clientId = iss;
    } catch {
      return errorPage('assertion is not a JWT');
    }
    const keySet = await ctx.clients.getKeySet(clientId);
    const claims = await verifyBrowserAssertion(assertion, { keySet, clientId, audiences: [ctx.urls.browserSession], claimJti: ctx.claimJti });
    const session = await ctx.store.getSession(claims.sessionId);
    const nowSec = Math.floor(ctx.now() / 1000);
    if (!session || session.ended || session.expiresAt <= nowSec || session.clientId !== clientId || session.userId !== claims.userId) {
      throw oauthError(OAuthError.InvalidSession, 'session is not active for this agent and user');
    }
    if (!onCompanyDomain(ctx, claims.returnTo)) throw oauthError(OAuthError.InvalidRequest, 'return_to must be an HTTPS URL on the company domain');
    const value = randomToken(IdPrefix.BrowserCookie, 32);
    const ttl = Math.min(web.cookieTtlSeconds ?? ctx.tokens.sessionLifetimeSeconds, Math.max(1, session.expiresAt - nowSec));
    await ctx.store.putBrowserCookie({ value, sessionId: session.id, createdAt: nowSec, expiresAt: (nowSec + ttl) * 1000 });
    const name = web.cookieName ?? DEFAULT_COOKIE;
    const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', `Max-Age=${ttl}`];
    if (web.cookieDomain) parts.push(`Domain=${web.cookieDomain}`);
    ctx.audit({ type: 'browser.joined', sessionId: session.id, clientId });
    return new Response(null, {
      status: 303,
      headers: { [Header.Location]: claims.returnTo, [Header.SetCookie]: parts.join('; '), [Header.CacheControl]: 'no-store' },
    });
  } catch (e) {
    if (e instanceof PoppyError) return errorPage(e.message);
    return errorPage('assertion could not be verified');
  }
}

export interface BrowserPrincipal {
  session: SessionRecord;
  signedIn: boolean;
  account?: string;
  scopes: string[];
}

/** For the company's website: resolve the Poppy session from the request's cookies, if any. */
export async function sessionFromCookie(ctx: GatewayContext, request: Request): Promise<BrowserPrincipal | undefined> {
  const web = ctx.config.web;
  if (!web?.browserSession) return undefined;
  const name = web.cookieName ?? DEFAULT_COOKIE;
  const header = request.headers.get('cookie') ?? '';
  const match = header.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  if (!match) return undefined;
  const value = match.slice(name.length + 1);
  const record = await ctx.store.getBrowserCookie(value);
  if (!record) return undefined;
  const session = await ctx.store.getSession(record.sessionId);
  const nowSec = Math.floor(ctx.now() / 1000);
  if (!session || session.ended || session.expiresAt <= nowSec) return undefined;
  const signedIn = session.account !== undefined;
  return { session, signedIn, ...(session.account ? { account: session.account } : {}), scopes: signedIn ? session.scopes : [] };
}
