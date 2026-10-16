export const HostedCaps = {
  tokenRequestsPerClientPerMinute: 30,
  sessionsPerClientPerMinute: 10,
  messagesPerSessionPerHour: 40,
  conversationsPerClientPerDay: 20,
  modelCallsPerDay: 400,
  maxMessageChars: 4000,
  maxBodyBytes: 65536,
} as const;

export const EnvVar = {
  Port: 'PORT',
  Issuer: 'POPPY_ISSUER',
  PublicDomain: 'POPPY_PUBLIC_DOMAIN',
  SigningKeyJwk: 'POPPY_SIGNING_KEY_JWK',
  Project: 'GOOGLE_CLOUD_PROJECT',
  GeminiLocation: 'GEMINI_LOCATION',
  GeminiModel: 'GEMINI_MODEL',
  ResendApiKey: 'RESEND_API_KEY',
  LeadTo: 'LEAD_TO',
  LeadFrom: 'LEAD_FROM',
} as const;
export type EnvVar = (typeof EnvVar)[keyof typeof EnvVar];

export const ConfigDefault = {
  Port: 8080,
  GeminiLocation: 'global',
  GeminiModel: 'gemini-3.6-flash',
  OrganizationName: 'Origin Platform Labs',
  LeadTo: 'billy@proedu.me',
  LeadFrom: 'poppy@origin-platform-labs.netlify.app',
} as const;

export interface HostedConfig {
  port: number;
  issuer: string;
  publicDomain: string;
  organizationName: string;
  signingKeyJwk?: string;
  project: string;
  geminiLocation: string;
  geminiModel: string;
  resendApiKey?: string;
  leadTo: string;
  leadFrom: string;
  caps: typeof HostedCaps;
}

export const ConfigErrorReason = {
  Missing: 'missing',
  Invalid: 'invalid',
} as const;
export type ConfigErrorReason = (typeof ConfigErrorReason)[keyof typeof ConfigErrorReason];

export class ConfigError extends Error {
  readonly reason: ConfigErrorReason;
  readonly variable: EnvVar;
  constructor(reason: ConfigErrorReason, variable: EnvVar) {
    super(`config: ${variable} is ${reason}`);
    this.name = 'ConfigError';
    this.reason = reason;
    this.variable = variable;
  }
}

export function loadConfig(env: Record<string, string | undefined>): HostedConfig {
  const read = (name: EnvVar): string | undefined => {
    const v = env[name]?.trim();
    return v === undefined || v.length === 0 ? undefined : v;
  };
  const required = (name: EnvVar): string => {
    const v = read(name);
    if (v === undefined) throw new ConfigError(ConfigErrorReason.Missing, name);
    return v;
  };

  const rawPort = read(EnvVar.Port);
  const port = rawPort === undefined ? ConfigDefault.Port : Number(rawPort);
  if (!Number.isInteger(port) || port < 0) throw new ConfigError(ConfigErrorReason.Invalid, EnvVar.Port);

  const config: HostedConfig = {
    port,
    issuer: required(EnvVar.Issuer),
    publicDomain: required(EnvVar.PublicDomain),
    organizationName: ConfigDefault.OrganizationName,
    project: required(EnvVar.Project),
    geminiLocation: read(EnvVar.GeminiLocation) ?? ConfigDefault.GeminiLocation,
    geminiModel: read(EnvVar.GeminiModel) ?? ConfigDefault.GeminiModel,
    leadTo: read(EnvVar.LeadTo) ?? ConfigDefault.LeadTo,
    leadFrom: read(EnvVar.LeadFrom) ?? ConfigDefault.LeadFrom,
    caps: HostedCaps,
  };
  const signingKeyJwk = read(EnvVar.SigningKeyJwk);
  if (signingKeyJwk !== undefined) config.signingKeyJwk = signingKeyJwk;
  const resendApiKey = read(EnvVar.ResendApiKey);
  if (resendApiKey !== undefined) config.resendApiKey = resendApiKey;
  return config;
}
