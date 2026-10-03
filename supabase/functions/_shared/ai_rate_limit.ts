/** Shared AI helpers. */
export type Quota = {
  scope: string;
  rpm?: number;
  tpm?: number;
  rpd?: number;
  tpd?: number;
  itpm?: number;
  otpm?: number;
  neuronsPerDay?: number;
  inputNeuronsPerMillionTokens?: number;
  outputNeuronsPerMillionTokens?: number;
  day: "UTC" | "PT" | "rolling";
  inputOnly?: boolean;
  factsReserveRpm?: number;
  factsReserveTpm?: number;
};
export type ModelQuota = {
  free: boolean;
  provider?: "cloudflare" | "openrouter";
  dailyTier?: "base" | "credit_qualified";
  quotas: Quota[];
};
export type QuotaConfig = Record<string, ModelQuota>;
export const GOOGLE_GEMMA = "google-gemma";
export function estimateInputTokens(value: unknown) {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(value)).length / 4);
}
export function nextQuotaDayStart(now: number, _day: "UTC" | "PT") {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime();
}
export type QuotaFailure =
  | "quota_limit"
  | "quota_unavailable"
  | "quota_unconfigured";
export type QuotaDiagnostic = {
  reason?: string;
  scope?: string;
  dimension?: string;
  limit?: number;
  used?: number;
  requested?: number;
  reserved?: number;
  nextAvailableAt?: number | null;
  window?: string;
};
export type QuotaDecision = { failure: null; diagnostic?: undefined };
export class QuotaReservationError extends Error {
  constructor(
    readonly code: QuotaFailure,
    readonly diagnostic?: QuotaDiagnostic,
  ) {
    super("quota_unavailable");
  }
}
export function quotaConfig(
  env = (key: string) => Deno.env.get(key),
): QuotaConfig {
  try {
    const value = JSON.parse(env("AI_QUOTA_CONFIG") ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as QuotaConfig
      : {};
  } catch {
    return {};
  }
}

export class AiRateLimiter {
  constructor(
    readonly config: QuotaConfig = quotaConfig(),
    readonly fetcher: typeof fetch = fetch,
    readonly env = (key: string) => Deno.env.get(key),
  ) {}
  async command(_command: unknown[]) {
    throw Error("quota_removed");
  }
  async reserve(
    _model: string,
    _input: number,
    _output: number,
    _kind: "facts" | "comment" = "comment",
  ) {
    return true;
  }
  async cooldown(_model: string, _response: Response) {}
}
/** Compatibility wrapper: no quota or cooldown Redis access. */
export function quotaFetch(
  _model: string,
  _kind: "facts" | "comment",
  _limiter = new AiRateLimiter(),
  fetcher: typeof fetch = fetch,
) {
  return (input: RequestInfo | URL, init?: RequestInit) => fetcher(input, init);
}
export async function reconcileQuotaUsage(
  _response: Response,
  _promptTokens: unknown,
  _completionTokens: unknown,
) {}
export async function inspectQuotaAvailability(
  _model: string,
  _input: number,
  _output: number,
  _kind: "facts" | "comment" = "comment",
): Promise<QuotaDecision> {
  return { failure: null };
}
