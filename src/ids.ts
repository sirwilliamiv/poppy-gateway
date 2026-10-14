import { randomBytes, createHash } from 'node:crypto';

export function randomId(prefix: string, bytes = 16): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

export function randomToken(prefix: string, bytes = 32): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

export function sha256b64url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

/** RFC 8628 style user code: 8 uppercase letters split by a dash, no ambiguous characters. */
export function userCode(): string {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXZ';
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += alphabet[(b[i] ?? 0) % alphabet.length];
    if (i === 3) s += '-';
  }
  return s;
}

/** One-time code for mediated sign-in second step. */
export function oneTimeCode(): string {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}
