import { createRemoteJWKSet, customFetch, type FetchImplementation, type JWTVerifyGetKey } from 'jose';
import { Defaults, OAuthError } from './constants.js';
import { isHttpsUrl } from './discovery.js';
import { oauthError } from './errors.js';
import type { ClientMetadata } from './types.js';

export type ClientPolicyDecision = 'allow' | 'block';

export interface ClientRegistryOptions {
  /** Called before any network fetch. Return 'block' to reject the client_id (invalid_client). */
  policy?: (clientId: string, metadata?: ClientMetadata) => ClientPolicyDecision | Promise<ClientPolicyDecision>;
  /** Exact client_id values that are always accepted or always rejected. */
  allowlist?: readonly string[];
  blocklist?: readonly string[];
  /** When true, only allowlisted client_ids are accepted (spec 4.1 registration). */
  requireRegistration?: boolean;
  /** Permit loopback and private hosts, and plain http URLs. Only for local development and tests. */
  allowPrivateHosts?: boolean;
  fetch?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  cacheMinSeconds?: number;
  cacheMaxSeconds?: number;
  now?: () => number;
}

interface CachedMetadata {
  metadata: ClientMetadata;
  expiresAt: number;
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\]|::1$|\[fc|\[fd|\[fe80)/i;

export function isPrivateHost(hostname: string): boolean {
  if (PRIVATE_HOST.test(hostname)) return true;
  const m = /^172\.(\d+)\./.exec(hostname);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local');
}

/**
 * Fetches, validates, and caches personal agent client metadata documents and
 * their key sets (spec 4.1, guides "Verifying personal agents" and "Fetching metadata safely").
 */
export class ClientRegistry {
  private readonly cache = new Map<string, CachedMetadata>();
  private readonly keySets = new Map<string, JWTVerifyGetKey>();
  private readonly opts: Required<Pick<ClientRegistryOptions, 'maxBytes' | 'timeoutMs' | 'cacheMinSeconds' | 'cacheMaxSeconds' | 'allowPrivateHosts' | 'requireRegistration'>> & ClientRegistryOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: ClientRegistryOptions = {}) {
    this.opts = {
      maxBytes: Defaults.MetadataMaxBytes,
      timeoutMs: Defaults.MetadataTimeoutMs,
      cacheMinSeconds: Defaults.MetadataCacheMinSeconds,
      cacheMaxSeconds: Defaults.MetadataCacheMaxSeconds,
      allowPrivateHosts: false,
      requireRegistration: false,
      ...options,
    };
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
  }

  /** Validates the client_id shape and applies allow/block policy. Throws invalid_client. */
  async checkPolicy(clientId: string, metadata?: ClientMetadata): Promise<void> {
    if (!isHttpsUrl(clientId, this.opts.allowPrivateHosts)) throw oauthError(OAuthError.InvalidClient, 'client_id must be an HTTPS URL');
    const url = new URL(clientId);
    if (url.hash) throw oauthError(OAuthError.InvalidClient, 'client_id must not have a fragment');
    if (!this.opts.allowPrivateHosts && isPrivateHost(url.hostname)) throw oauthError(OAuthError.InvalidClient, 'client_id host is not reachable');
    if (this.opts.blocklist?.includes(clientId)) throw oauthError(OAuthError.InvalidClient, 'client_id is blocked');
    const listed = this.opts.allowlist?.includes(clientId) ?? false;
    if (this.opts.requireRegistration && !listed) throw oauthError(OAuthError.InvalidClient, 'client_id is not registered');
    if (this.opts.policy) {
      const decision = await this.opts.policy(clientId, metadata);
      if (decision === 'block') throw oauthError(OAuthError.InvalidClient, 'client_id is not accepted');
    }
  }

  async getMetadata(clientId: string): Promise<ClientMetadata> {
    await this.checkPolicy(clientId);
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > this.now()) return cached.metadata;
    const { body, cacheSeconds } = await this.safeFetch(clientId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw oauthError(OAuthError.InvalidClient, 'client metadata is not JSON');
    }
    const metadata = validateClientMetadata(parsed, clientId, this.opts.allowPrivateHosts);
    await this.checkPolicy(clientId, metadata);
    this.cache.set(clientId, { metadata, expiresAt: this.now() + cacheSeconds * 1000 });
    return metadata;
  }

  async getKeySet(clientId: string): Promise<JWTVerifyGetKey> {
    const metadata = await this.getMetadata(clientId);
    const existing = this.keySets.get(metadata.jwks_uri);
    if (existing) return existing;
    const guarded: FetchImplementation = async (url, options) => {
      this.assertFetchable(url);
      return this.fetchImpl(url, { ...options, credentials: 'omit' } as RequestInit);
    };
    const keySet = createRemoteJWKSet(new URL(metadata.jwks_uri), {
      cooldownDuration: 30_000,
      cacheMaxAge: this.opts.cacheMaxSeconds * 1000,
      timeoutDuration: this.opts.timeoutMs,
      [customFetch]: guarded,
    });
    this.keySets.set(metadata.jwks_uri, keySet);
    return keySet;
  }

  /** Drop cached metadata and keys for a client, for example after a block decision. */
  evict(clientId: string): void {
    const cached = this.cache.get(clientId);
    if (cached) this.keySets.delete(cached.metadata.jwks_uri);
    this.cache.delete(clientId);
  }

  private assertFetchable(url: string): void {
    if (!isHttpsUrl(url, this.opts.allowPrivateHosts)) throw oauthError(OAuthError.InvalidClient, 'metadata URLs must be HTTPS');
    if (!this.opts.allowPrivateHosts && isPrivateHost(new URL(url).hostname)) throw oauthError(OAuthError.InvalidClient, 'metadata host is not reachable');
  }

  private async safeFetch(url: string): Promise<{ body: string; cacheSeconds: number }> {
    this.assertFetchable(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        redirect: 'manual',
        credentials: 'omit',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      } as RequestInit);
    } catch {
      clearTimeout(timer);
      throw oauthError(OAuthError.InvalidClient, 'client metadata could not be fetched');
    }
    clearTimeout(timer);
    if (res.status !== 200) throw oauthError(OAuthError.InvalidClient, `client metadata returned HTTP ${res.status}`);
    const lengthHeader = res.headers.get('content-length');
    if (lengthHeader && Number(lengthHeader) > this.opts.maxBytes) throw oauthError(OAuthError.InvalidClient, 'client metadata is too large');
    const body = await readLimited(res, this.opts.maxBytes);
    return { body, cacheSeconds: this.cacheSecondsFrom(res.headers.get('cache-control')) };
  }

  private cacheSecondsFrom(cacheControl: string | null): number {
    let seconds = this.opts.cacheMinSeconds;
    if (cacheControl) {
      const m = /max-age=(\d+)/i.exec(cacheControl);
      if (m) seconds = Number(m[1]);
      if (/no-store|no-cache/i.test(cacheControl)) seconds = this.opts.cacheMinSeconds;
    }
    return Math.min(Math.max(seconds, this.opts.cacheMinSeconds), this.opts.cacheMaxSeconds);
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw oauthError(OAuthError.InvalidClient, 'client metadata is too large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function sameHost(a: string, b: string): boolean {
  return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
}

/** Applies the spec 4.1 rules to a fetched client metadata document. */
export function validateClientMetadata(input: unknown, fetchedFrom: string, allowHttp = false): ClientMetadata {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw oauthError(OAuthError.InvalidClient, 'client metadata must be an object');
  const doc = input as Record<string, unknown>;
  if (doc.client_id !== fetchedFrom) throw oauthError(OAuthError.InvalidClient, 'client_id in metadata must equal the URL it was fetched from');
  if (!isHttpsUrl(doc.jwks_uri, allowHttp) || !sameHost(doc.jwks_uri, fetchedFrom)) throw oauthError(OAuthError.InvalidClient, 'jwks_uri must be an HTTPS URL on the client_id domain');
  if (doc.redirect_uris !== undefined) {
    if (!Array.isArray(doc.redirect_uris)) throw oauthError(OAuthError.InvalidClient, 'redirect_uris must be a list');
    for (const r of doc.redirect_uris) {
      if (!isHttpsUrl(r, allowHttp) || !sameHost(r, fetchedFrom)) throw oauthError(OAuthError.InvalidClient, 'redirect_uris must be HTTPS URLs on the client_id domain');
    }
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'private_key_jwt') {
    throw oauthError(OAuthError.InvalidClient, 'token_endpoint_auth_method must be private_key_jwt');
  }
  if (doc.client_name !== undefined && typeof doc.client_name !== 'string') throw oauthError(OAuthError.InvalidClient, 'client_name must be a string');
  if (doc.logo_uri !== undefined && !isHttpsUrl(doc.logo_uri, allowHttp)) throw oauthError(OAuthError.InvalidClient, 'logo_uri must be an HTTPS URL');
  if (doc.extensions !== undefined) {
    if (typeof doc.extensions !== 'object' || doc.extensions === null) throw oauthError(OAuthError.InvalidClient, 'extensions must be an object');
    for (const [name, entry] of Object.entries(doc.extensions as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).version !== 'string') {
        throw oauthError(OAuthError.InvalidClient, `extension ${name} needs a string version`);
      }
    }
  }
  return doc as unknown as ClientMetadata;
}
