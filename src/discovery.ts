import { ApiType, ConversationProtocol, PROTOCOL_VERSION, RESERVED_SCOPE_PREFIX } from './constants.js';
import type { OAuthServerMetadata, PoppyDocument } from './types.js';

export type ValidationResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isHttpsUrlBase(v: unknown, allowHttp: boolean): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || (allowHttp && u.protocol === 'http:');
  } catch {
    return false;
  }
}

export function isHttpsUrl(v: unknown, allowHttp = false): v is string {
  return isHttpsUrlBase(v, allowHttp);
}

export function normalizeDomain(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function isScopeList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s));
}

const EXTENSION_NAME = /^([a-z][a-z0-9_-]*|[a-z0-9.-]+\.[a-z]{2,}\/[a-z0-9][a-z0-9_/-]*)$/i;

/**
 * Validates a poppy.json document against draft 0.1 section 3.
 * `requestedDomain` is the host the document was fetched for; when given,
 * organization.domain must match it (ignoring a leading www.).
 */
export function validatePoppyDocument(input: unknown, requestedDomain?: string, options: { allowHttp?: boolean } = {}): ValidationResult<PoppyDocument> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowHttp = options.allowHttp ?? false;
  const isHttpsUrl = (v: unknown): v is string => isHttpsUrlBase(v, allowHttp);
  if (!isRecord(input)) return { ok: false, errors: ['document must be a JSON object'], warnings };

  const pv = input.protocol_version;
  if (typeof pv !== 'string' || !/^\d+\.\d+$/.test(pv)) errors.push('protocol_version must be "major.minor"');
  else if (pv.split('.')[0] !== PROTOCOL_VERSION.split('.')[0]) errors.push(`protocol_version major ${pv.split('.')[0]} is not supported (expected ${PROTOCOL_VERSION})`);

  const org = input.organization;
  if (!isRecord(org) || typeof org.name !== 'string' || !org.name || typeof org.domain !== 'string' || !org.domain) {
    errors.push('organization.name and organization.domain are required');
  } else if (requestedDomain && normalizeDomain(org.domain) !== normalizeDomain(requestedDomain)) {
    errors.push(`organization.domain ${org.domain} does not match requested host ${requestedDomain}`);
  }

  const hasAgent = input.agent !== undefined;
  const hasApis = input.apis !== undefined;
  const hasWeb = input.web !== undefined;
  if (!hasAgent && !hasApis && !hasWeb) errors.push('one of agent, apis, or web is required');

  const web = input.web;
  let browserEndpoint = false;
  if (hasWeb) {
    if (!isRecord(web)) errors.push('web must be an object');
    else if (web.browser_session_endpoint !== undefined) {
      if (!isHttpsUrl(web.browser_session_endpoint)) errors.push('web.browser_session_endpoint must be an HTTPS URL');
      browserEndpoint = true;
    }
  }

  const auth = input.auth;
  if (hasAgent || hasApis || browserEndpoint) {
    if (!isRecord(auth)) errors.push('auth is required when agent, apis, or web.browser_session_endpoint is present');
  }
  if (auth !== undefined) {
    if (!isRecord(auth)) errors.push('auth must be an object');
    else {
      if (!isHttpsUrl(auth.issuer)) errors.push('auth.issuer must be an HTTPS URL');
      else if (new URL(auth.issuer).search || new URL(auth.issuer).hash) errors.push('auth.issuer must not have a query or fragment');
      for (const t of ['direct', 'device'] as const) {
        const v = auth[t];
        if (v !== undefined && (!isRecord(v) || !isScopeList(v.scopes))) errors.push(`auth.${t}.scopes must be a list of scopes`);
      }
      const med = auth.mediated;
      if (med !== undefined) {
        if (!isRecord(med)) errors.push('auth.mediated must be an object');
        else {
          if (!isHttpsUrl(med.endpoint)) errors.push('auth.mediated.endpoint must be an HTTPS URL');
          if (!isScopeList(med.scopes)) errors.push('auth.mediated.scopes must be a list of scopes');
          if (!Array.isArray(med.fields) || med.fields.length === 0) errors.push('auth.mediated.fields must be a non-empty list');
          else {
            for (const f of med.fields) {
              if (!isRecord(f) || typeof f.name !== 'string' || typeof f.label !== 'string' || typeof f.secret !== 'boolean') {
                errors.push('each auth.mediated.fields entry needs name, label, and secret');
                break;
              }
            }
          }
        }
      }
      const custom = auth.custom_scopes;
      if (custom !== undefined) {
        if (!isRecord(custom)) errors.push('auth.custom_scopes must be an object');
        else {
          for (const [name, desc] of Object.entries(custom)) {
            if (name.startsWith(RESERVED_SCOPE_PREFIX)) errors.push(`custom scope ${name} uses the reserved poppy: prefix`);
            if (typeof desc !== 'string') errors.push(`custom scope ${name} needs a string description`);
          }
        }
      }
      const listed = new Set<string>(Object.keys(isRecord(custom) ? custom : {}));
      for (const t of ['direct', 'device', 'mediated'] as const) {
        const v = auth[t];
        if (isRecord(v) && isScopeList(v.scopes)) {
          for (const s of v.scopes) {
            if (!s.startsWith(RESERVED_SCOPE_PREFIX) && !listed.has(s)) warnings.push(`auth.${t} grants scope ${s} that is not described in auth.custom_scopes`);
          }
        }
      }
    }
  }

  if (hasAgent) {
    const agent = input.agent;
    if (!isRecord(agent) || !Array.isArray(agent.protocols) || agent.protocols.length === 0) errors.push('agent.protocols must be a non-empty list');
    else {
      for (const p of agent.protocols) {
        if (!isRecord(p) || typeof p.type !== 'string' || !isHttpsUrl(p.endpoint)) errors.push('each agent.protocols entry needs a type and an HTTPS endpoint');
        else if (p.type !== ConversationProtocol.Poppy) warnings.push(`unknown conversation protocol type ${p.type}`);
        if (isRecord(p) && p.resource !== undefined && !isHttpsUrl(p.resource)) errors.push('agent.protocols[].resource must be an HTTPS URL');
      }
    }
  }

  if (hasApis) {
    const apis = input.apis;
    if (!Array.isArray(apis)) errors.push('apis must be a list');
    else {
      for (const a of apis) {
        if (!isRecord(a) || typeof a.type !== 'string' || !isHttpsUrl(a.url) || typeof a.description !== 'string') {
          errors.push('each apis entry needs type, an HTTPS url, and description');
          continue;
        }
        if (a.type !== ApiType.OpenApi && a.type !== ApiType.Mcp) warnings.push(`unknown api type ${a.type}`);
        if (a.resource !== undefined && !isHttpsUrl(a.resource)) errors.push('apis[].resource must be an HTTPS URL');
      }
    }
  }

  const ext = input.extensions;
  if (ext !== undefined) {
    if (!isRecord(ext)) errors.push('extensions must be an object');
    else {
      for (const [name, entry] of Object.entries(ext)) {
        if (!EXTENSION_NAME.test(name)) errors.push(`extension name ${name} must be plain or prefixed with a domain`);
        if (!isRecord(entry) || typeof entry.version !== 'string') errors.push(`extension ${name} needs a string version`);
      }
    }
  }

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, value: input as unknown as PoppyDocument, warnings };
}

/** Validates OAuth server metadata as a personal agent must before trusting a poppy.json (spec 3.2). */
export function validateOAuthServerMetadata(input: unknown, expectedIssuer: string, organizationDomain: string, options: { allowHttp?: boolean } = {}): ValidationResult<OAuthServerMetadata> {
  const errors: string[] = [];
  const isHttpsUrl = (v: unknown): v is string => isHttpsUrlBase(v, options.allowHttp ?? false);
  if (!isRecord(input)) return { ok: false, errors: ['metadata must be a JSON object'], warnings: [] };
  if (input.issuer !== expectedIssuer) errors.push(`issuer ${String(input.issuer)} does not exactly match auth.issuer ${expectedIssuer}`);
  if (!isHttpsUrl(input.token_endpoint)) errors.push('token_endpoint is required');
  if (!isHttpsUrl(input.revocation_endpoint)) errors.push('revocation_endpoint is required');
  if (input.authorization_endpoint !== undefined && !isHttpsUrl(input.authorization_endpoint)) errors.push('authorization_endpoint must be an HTTPS URL');
  if (input.device_authorization_endpoint !== undefined && !isHttpsUrl(input.device_authorization_endpoint)) errors.push('device_authorization_endpoint must be an HTTPS URL');
  const domains = input.poppy_domains;
  if (!Array.isArray(domains) || !domains.every((d) => typeof d === 'string')) errors.push('poppy_domains must be a list of domains');
  else if (!domains.map(normalizeDomain).includes(normalizeDomain(organizationDomain))) errors.push(`poppy_domains does not include ${organizationDomain}`);
  if (errors.length) return { ok: false, errors, warnings: [] };
  return { ok: true, value: input as unknown as OAuthServerMetadata, warnings: [] };
}

export function parseScopeString(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return scope.split(' ').filter(Boolean);
}

export function joinScopes(scopes: readonly string[]): string {
  return [...new Set(scopes)].join(' ');
}

export function isSubset(requested: readonly string[], allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return requested.every((s) => set.has(s));
}
