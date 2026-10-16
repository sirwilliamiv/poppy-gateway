import { ApiError, GoogleGenAI } from '@google/genai';
import { MODEL_TIMEOUT_MS, type ModelInput, type ModelOutput, type TextModel } from './contracts.js';

export interface VertexModelOptions {
  project: string;
  location: string;
  model: string;
}

export const ModelErrorReason = {
  Timeout: 'timeout',
  RateLimited: 'rate_limited',
  Upstream: 'upstream',
  Network: 'network',
  Rejected: 'rejected',
  Unknown: 'unknown',
} as const;
export type ModelErrorReason = (typeof ModelErrorReason)[keyof typeof ModelErrorReason];

/** Model failure with a reason and HTTP status only; the vendor message and body are dropped. */
export class ModelError extends Error {
  readonly reason: ModelErrorReason;
  readonly status: number | undefined;
  constructor(reason: ModelErrorReason, status?: number) {
    super(`model call failed: ${reason}${status === undefined ? '' : ` (${status})`}`);
    this.name = 'ModelError';
    this.reason = reason;
    this.status = status;
  }
}

const MimeType = {
  Json: 'application/json',
  Text: 'text/plain',
} as const;

const HttpStatus = {
  TooManyRequests: 429,
  InternalError: 500,
  BadGateway: 502,
  Unavailable: 503,
  GatewayTimeout: 504,
} as const;

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  HttpStatus.TooManyRequests,
  HttpStatus.InternalError,
  HttpStatus.BadGateway,
  HttpStatus.Unavailable,
  HttpStatus.GatewayTimeout,
]);

const NETWORK_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(['TimeoutError', 'AbortError']);
const RETRY_AFTER_HEADER = 'retry-after';

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4000;
const TEMPERATURE = 0.2;

function classify(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  if (err instanceof ApiError) {
    if (err.status === HttpStatus.TooManyRequests) return new ModelError(ModelErrorReason.RateLimited, err.status);
    if (RETRYABLE_STATUS.has(err.status)) return new ModelError(ModelErrorReason.Upstream, err.status);
    return new ModelError(ModelErrorReason.Rejected, err.status);
  }
  if (err instanceof Error && ABORT_ERROR_NAMES.has(err.name)) return new ModelError(ModelErrorReason.Timeout);
  if (isNetworkError(err)) return new ModelError(ModelErrorReason.Network);
  return new ModelError(ModelErrorReason.Unknown);
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  return err instanceof TypeError && err.cause !== undefined;
}

function isRetryable(e: ModelError): boolean {
  return e.reason === ModelErrorReason.RateLimited || e.reason === ModelErrorReason.Upstream || e.reason === ModelErrorReason.Network;
}

/** Retry-After in ms when the error carries response headers, else undefined. */
function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown } | null)?.headers;
  let value: string | null | undefined;
  if (headers instanceof Headers) value = headers.get(RETRY_AFTER_HEADER);
  else if (headers && typeof headers === 'object') {
    const v = (headers as Record<string, unknown>)[RETRY_AFTER_HEADER];
    if (typeof v === 'string') value = v;
  }
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function backoffMs(attempt: number): number {
  return Math.random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createVertexModel(opts: VertexModelOptions): TextModel {
  const ai = new GoogleGenAI({ vertexai: true, project: opts.project, location: opts.location });

  return {
    async generate(input: ModelInput): Promise<ModelOutput> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const response = await ai.models.generateContent({
            model: opts.model,
            contents: input.user,
            config: {
              systemInstruction: input.system,
              responseMimeType: input.json ? MimeType.Json : MimeType.Text,
              temperature: TEMPERATURE,
              abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
            },
          });
          return { text: response.text ?? '' };
        } catch (err) {
          const failure = classify(err);
          if (!isRetryable(failure) || attempt + 1 >= MAX_ATTEMPTS) throw failure;
          await sleep(Math.min(MAX_DELAY_MS, retryAfterMs(err) ?? backoffMs(attempt)));
        }
      }
    },
  };
}
