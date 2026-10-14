import { ContentType, Header, OAuthError } from './constants.js';
import { oauthError } from './errors.js';

export type Form = Record<string, string>;

export async function readForm(request: Request): Promise<Form> {
  const ct = request.headers.get(Header.ContentType) ?? '';
  if (!ct.toLowerCase().startsWith(ContentType.Form)) throw oauthError(OAuthError.InvalidRequest, `Content-Type must be ${ContentType.Form}`);
  const text = await request.text();
  const params = new URLSearchParams(text);
  const out: Form = {};
  for (const [k, v] of params) {
    if (k in out) throw oauthError(OAuthError.InvalidRequest, `duplicate parameter ${k}`);
    out[k] = v;
  }
  return out;
}

export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 1024 * 1024): Promise<T> {
  const ct = request.headers.get(Header.ContentType) ?? '';
  if (!ct.toLowerCase().startsWith(ContentType.Json)) throw oauthError(OAuthError.InvalidRequest, `Content-Type must be ${ContentType.Json}`);
  const text = await request.text();
  if (text.length > maxBytes) throw oauthError(OAuthError.InvalidRequest, 'body is too large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw oauthError(OAuthError.InvalidRequest, 'body is not valid JSON');
  }
}

export function required(form: Form, name: string): string {
  const v = form[name];
  if (v === undefined || v === '') throw oauthError(OAuthError.InvalidRequest, `${name} is required`);
  return v;
}
