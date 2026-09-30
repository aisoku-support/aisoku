/** Shared by Topic Facts and the initial shared-AI router. No API keys in Redis keys. */
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
  /** Omitted for the existing Groq and Google configuration shape. */
  provider?: "cloudflare" | "openrouter";
  /** OpenRouter purchase status is operator supplied and never inferred. */
  dailyTier?: "base" | "credit_qualified";
  quotas: Quota[];
};
export type QuotaConfig = Record<string, ModelQuota>;
export const GOOGLE_GEMMA = "google-gemma";
export const CLOUDFLARE_NEURONS_SCOPE = "cloudflare-workers-ai-neurons";
export const OPENROUTER_FREE_SCOPE = "openrouter-free-models";

export function quotaConfig(
  env = (key: string) => Deno.env.get(key),
): QuotaConfig {
  try {
    const config = JSON.parse(env("AI_QUOTA_CONFIG") ?? "{}");
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw Error();
    }
    const scopes = new Map<string, string>();
    for (const [model, rawEntry] of Object.entries(config)) {
      const entry = rawEntry as ModelQuota;
      if (typeof entry.free !== "boolean") throw Error();
      if (
        entry.provider !== undefined && entry.provider !== "cloudflare" &&
        entry.provider !== "openrouter"
      ) throw Error();
      if (
        entry.provider === "openrouter" && entry.dailyTier !== undefined &&
        entry.dailyTier !== "base" && entry.dailyTier !== "credit_qualified"
      ) {
        throw Error();
      }
      if (entry.provider !== "openrouter" && entry.dailyTier !== undefined) {
        throw Error();
      }
      if (!Array.isArray(entry.quotas) || !entry.quotas.length) throw Error();
      if (
        new Set(entry.quotas.map((q) => q.scope)).size !== entry.quotas.length
      ) throw Error();
      for (const q of entry.quotas) {
        if (!q || typeof q !== "object") throw Error();
        if (entry.provider === "openrouter") {
          if (
            q.scope !== OPENROUTER_FREE_SCOPE ||
            q.rpm !== 20 || q.tpm !== undefined || q.rpd !== undefined ||
            q.tpd !== undefined || q.itpm !== undefined ||
            q.otpm !== undefined || q.neuronsPerDay !== undefined ||
            q.inputNeuronsPerMillionTokens !== undefined ||
            q.outputNeuronsPerMillionTokens !== undefined
          ) throw Error();
          q.rpd = entry.dailyTier === "credit_qualified" ? 1000 : 50;
        } else if (entry.provider === "cloudflare") {
          if (
            q.tpm !== undefined || q.rpd !== undefined || q.tpd !== undefined ||
            q.itpm !== undefined || q.otpm !== undefined ||
            q.factsReserveRpm !== undefined || q.factsReserveTpm !== undefined
          ) throw Error();
          if (q.day !== "UTC") throw Error();
          if (
            q.neuronsPerDay !== undefined &&
            q.scope !== CLOUDFLARE_NEURONS_SCOPE
          ) throw Error();
          if (
            model === "cloudflare-gemma" &&
            (q.rpm !== undefined && q.rpm !== 300 ||
              q.neuronsPerDay !== undefined &&
                (q.inputNeuronsPerMillionTokens !== 9091 ||
                  q.outputNeuronsPerMillionTokens !== 27273))
          ) throw Error();
        } else if (
          q.rpm === undefined || q.tpm === undefined || q.rpd === undefined
        ) {
          throw Error();
        }
        const dimensions = [
          q.rpm,
          q.tpm,
          q.rpd,
          q.tpd,
          q.itpm,
          q.otpm,
          q.neuronsPerDay,
          q.factsReserveRpm,
          q.factsReserveTpm,
        ].filter((v) => v !== undefined);
        if (
          !/^[a-zA-Z0-9:_-]{1,100}$/.test(q.scope) ||
          !["UTC", "PT", "rolling"].includes(q.day) ||
          !dimensions.length ||
          dimensions.some((v) => !Number.isFinite(v) || (v as number) <= 0) ||
          (q.neuronsPerDay !== undefined &&
            (!Number.isFinite(q.inputNeuronsPerMillionTokens) ||
              !Number.isFinite(q.outputNeuronsPerMillionTokens) ||
              q.inputNeuronsPerMillionTokens! <= 0 ||
              q.outputNeuronsPerMillionTokens! <= 0)) ||
          (q.neuronsPerDay === undefined &&
            (q.inputNeuronsPerMillionTokens !== undefined ||
              q.outputNeuronsPerMillionTokens !== undefined))
        ) throw Error();
        const fingerprint = JSON.stringify([
          q.rpm,
          q.tpm,
          q.rpd,
          q.tpd,
          q.itpm,
          q.otpm,
          q.neuronsPerDay,
          q.day,
          q.inputOnly,
          q.factsReserveRpm,
          q.factsReserveTpm,
        ]);
        if (scopes.has(q.scope) && scopes.get(q.scope) !== fingerprint) {
          throw Error();
        }
        scopes.set(q.scope, fingerprint);
      }
    }
    return config;
  } catch {
    return {};
  }
}

// One atomic decision across every quota dimension and every shared scope.
// Usage is reserved conservatively and never refunded on ambiguous network failure.
export const RESERVE_LUA = `
local now=tonumber(ARGV[1]); local rules=cjson.decode(ARGV[2]); local id=ARGV[3]
local priority=ARGV[4]; local scopes=cjson.decode(ARGV[5]); local dryRun=ARGV[6]=='1'
for _,s in ipairs(scopes) do
  local cooldown=tonumber(redis.call('GET',s..':cooldown') or '0')
  if cooldown>now then return {0,'cooldown',s,cooldown} end
  redis.call('ZREMRANGEBYSCORE',s..':facts','-inf',now)
  if priority=='comment' and redis.call('ZCARD',s..':facts')>0 then return {0,'facts_pending',s,now+150000} end
end
for _,r in ipairs(rules) do
  local used=0
  if r.fixed then used=tonumber(redis.call('GET',r.key) or '0')
  else
    redis.call('ZREMRANGEBYSCORE',r.key,'-inf',r.cutoff)
    for _,v in ipairs(redis.call('ZRANGE',r.key,0,-1)) do used=used+cjson.decode(v).cost end
  end
  if used+r.cost+r.reserve>r.limit then
    local wait=0
    if r.windowMs then
      local needed=used+r.cost+r.reserve-r.limit
      local released=0
      local entries=redis.call('ZRANGE',r.key,0,-1,'WITHSCORES')
      for i=1,#entries,2 do
        released=released+cjson.decode(entries[i]).cost
        if released>=needed then wait=tonumber(entries[i+1])+r.windowMs; break end
      end
    end
    return {0,'quota_limit',r.scope,r.dimension,r.limit,used,r.cost,r.reserve,wait,r.resetAt or 0,r.window}
  end
end
if not dryRun then
  for _,r in ipairs(rules) do
    if r.fixed then redis.call('INCRBY',r.key,r.cost)
    else redis.call('ZADD',r.key,now,cjson.encode({id=id,cost=r.cost})) end
    redis.call('PEXPIRE',r.key,r.ttl)
  end
end
return 1`;

const RECONCILE_LUA = `
local adjustments=cjson.decode(ARGV[1]); local id=ARGV[2]
for _,a in ipairs(adjustments) do
  local rows=redis.call('ZRANGE',a.key,0,-1,'WITHSCORES')
  for i=1,#rows,2 do
    local current=cjson.decode(rows[i])
    if current.id==id then
      if not current.settled then
        redis.call('ZREM',a.key,rows[i])
        redis.call('ZADD',a.key,tonumber(rows[i+1]),cjson.encode({id=id,cost=a.cost,settled=true}))
      end
      break
    end
  end
end
return 1`;

const RELEASE_LUA = `
local rules=cjson.decode(ARGV[1]); local id=ARGV[2]
for _,r in ipairs(rules) do
  if r.fixed then
    local used=tonumber(redis.call('GET',r.key) or '0')
    if used>0 then
      if used<=r.cost then redis.call('DEL',r.key)
      else redis.call('DECRBY',r.key,r.cost) end
    end
  else
    local rows=redis.call('ZRANGE',r.key,0,-1)
    for _,member in ipairs(rows) do
      if cjson.decode(member).id==id then redis.call('ZREM',r.key,member); break end
    end
  end
end
return 1`;

type Rule = {
  key: string;
  scope: string;
  dimension: string;
  cutoff: number;
  cost: number;
  reserve: number;
  limit: number;
  ttl: number;
  windowMs: number | null;
  window: string;
  fixed: boolean;
  resetAt: number | null;
};

export function nextQuotaDayStart(now: number, day: "UTC" | "PT") {
  const timezone = day === "PT" ? "America/Los_Angeles" : "UTC";
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const dateParts = (instant: number) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(instant)).map((
        part,
      ) => [part.type, part.value]),
    );
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
    };
  };
  const current = dateParts(now);
  const nextLocalDateUtc = Date.UTC(
    current.year,
    current.month - 1,
    current.day + 1,
  );
  let candidate = nextLocalDateUtc;
  for (let iteration = 0; iteration < 2; iteration++) {
    const local = dateParts(candidate);
    const offsetMs = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    ) - candidate;
    candidate = nextLocalDateUtc - offsetMs;
  }
  return candidate;
}
export function rulesFor(
  quotas: Quota[],
  input: number,
  output: number,
  comment: boolean,
  google: boolean,
  now: number,
): Rule[] {
  const rules: Rule[] = [];
  for (const q of quotas) {
    const prefix = `ai:v1:${q.scope}`;
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: q.day === "PT" ? "America/Los_Angeles" : "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
    const add = (
      name: string,
      limit: number | undefined,
      cost: number,
      minute = false,
      reserve = 0,
    ) => {
      if (limit === undefined) return;
      rules.push({
        key: `${prefix}:${name}${
          minute || q.day === "rolling" ? "" : ":" + date
        }`,
        scope: q.scope,
        dimension: name,
        cutoff: minute
          ? now - 60_000
          : q.day === "rolling"
          ? now - 86_400_000
          : 0,
        cost,
        reserve,
        limit,
        ttl: minute ? 60_001 : 172_800_000,
        windowMs: minute ? 60_000 : q.day === "rolling" ? 86_400_000 : null,
        window: minute
          ? "60s rolling"
          : q.day === "rolling"
          ? "24h rolling"
          : `${q.day} fixed day`,
        fixed: !minute && q.day !== "rolling",
        resetAt: !minute && q.day !== "rolling"
          ? nextQuotaDayStart(now, q.day)
          : null,
      });
    };
    add("rpm", q.rpm, 1, true, comment && google ? q.factsReserveRpm ?? 1 : 0);
    add(
      "tpm",
      q.tpm,
      input + (q.inputOnly ? 0 : output),
      true,
      comment && google ? q.factsReserveTpm ?? 4096 : 0,
    );
    add("itpm", q.itpm, input, true);
    add("otpm", q.otpm, output, true);
    add("rpd", q.rpd, 1);
    add("tpd", q.tpd, input + output);
    add(
      "neurons",
      q.neuronsPerDay,
      Math.ceil(
        input * (q.inputNeuronsPerMillionTokens ?? 0) / 1e6 +
          output * (q.outputNeuronsPerMillionTokens ?? 0) / 1e6,
      ),
    );
  }
  if (comment && google) {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
    rules.push({
      key: `ai:v1:${quotas[0].scope}:comments:${day}`,
      scope: quotas[0].scope,
      dimension: "comments_daily",
      cutoff: 0,
      cost: 1,
      reserve: 0,
      limit: Math.min(10000, Math.max(0, (quotas[0].rpd ?? 0) - 4400)),
      ttl: 172_800_000,
      windowMs: null,
      window: "PT fixed day",
      fixed: true,
      resetAt: nextQuotaDayStart(now, "PT"),
    });
  }
  return rules;
}

export type QuotaFailure =
  | "quota_limit"
  | "quota_unconfigured"
  | "quota_unavailable";
export type QuotaDiagnostic = {
  reason: "cooldown" | "facts_pending" | "quota_limit";
  scope: string;
  dimension?: string;
  window?: string;
  limit?: number;
  used?: number;
  requested?: number;
  reserved?: number;
  nextAvailableAt?: number | null;
};

export type QuotaDecision = {
  failure: QuotaFailure | null;
  diagnostic?: QuotaDiagnostic;
  reservation?: QuotaReservation;
};

export type QuotaReservation = {
  id: string;
  rules: Array<{ key: string; cost: number; fixed: boolean }>;
  tokenRules: Array<{
    key: string;
    dimension: "tpm" | "tpd" | "otpm";
    inputOnly: boolean;
  }>;
};

export class QuotaReservationError extends Error {
  constructor(
    readonly code: QuotaFailure,
    readonly diagnostic?: QuotaDiagnostic,
  ) {
    super("quota_unavailable");
  }
}

export class AiRateLimiter {
  constructor(
    readonly config: QuotaConfig = quotaConfig(),
    readonly fetcher: typeof fetch = fetch,
    readonly env = (key: string) => Deno.env.get(key),
  ) {}
  async command(args: unknown[]) {
    const url = this.env("UPSTASH_REDIS_REST_URL");
    const token = this.env("UPSTASH_REDIS_REST_TOKEN");
    if (!url || !token) throw Error("quota_unavailable");
    const response = await this.fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw Error("quota_unavailable");
    const body = await response.json();
    if (body.error) throw Error("quota_unavailable");
    return body.result;
  }
  async reserve(
    model: string,
    input: number,
    output: number,
    kind: "facts" | "comment" = "comment",
  ): Promise<boolean> {
    return await this.reserveFailure(model, input, output, kind) === null;
  }
  async reserveFailure(
    model: string,
    input: number,
    output: number,
    kind: "facts" | "comment" = "comment",
  ): Promise<QuotaFailure | null> {
    return (await this.reserveDecision(model, input, output, kind)).failure;
  }
  async reserveDecision(
    model: string,
    input: number,
    output: number,
    kind: "facts" | "comment" = "comment",
  ): Promise<QuotaDecision> {
    return await this.quotaDecision(model, input, output, kind, false);
  }
  async inspectDecision(
    model: string,
    input: number,
    output: number,
    kind: "facts" | "comment" = "comment",
  ): Promise<QuotaDecision> {
    return await this.quotaDecision(model, input, output, kind, true);
  }
  private async quotaDecision(
    model: string,
    input: number,
    output: number,
    kind: "facts" | "comment",
    dryRun: boolean,
  ): Promise<QuotaDecision> {
    const entry = this.config[model];
    if (!entry?.quotas.length) return { failure: "quota_unconfigured" };
    try {
      const now = Date.now();
      const reservationId = crypto.randomUUID();
      const rules = rulesFor(
        entry.quotas,
        input,
        output,
        kind === "comment",
        model === GOOGLE_GEMMA,
        now,
      );
      const decision = await this.command([
        "EVAL",
        RESERVE_LUA,
        0,
        now,
        JSON.stringify(rules),
        reservationId,
        kind,
        JSON.stringify(entry.quotas.map((q) => `ai:v1:${q.scope}`)),
        dryRun ? "1" : "0",
      ]);
      if (decision === 1) {
        return {
          failure: null,
          ...(!dryRun
            ? {
              reservation: {
                id: reservationId,
                rules: rules.map((rule) => ({
                  key: rule.key,
                  cost: rule.cost,
                  fixed: rule.fixed,
                })),
                tokenRules: rules.filter((rule) =>
                  !rule.fixed &&
                  (rule.dimension === "tpm" || rule.dimension === "tpd" ||
                    rule.dimension === "otpm")
                ).map((rule) => ({
                  key: rule.key,
                  dimension: rule.dimension as "tpm" | "tpd" | "otpm",
                  inputOnly: entry.quotas.find((q) => q.scope === rule.scope)
                    ?.inputOnly === true,
                })),
              },
            }
            : {}),
        };
      }
      if (Array.isArray(decision) && decision[0] === 0) {
        const reason = String(decision[1]);
        return {
          failure: "quota_limit",
          diagnostic: {
            reason: reason === "cooldown" || reason === "facts_pending"
              ? reason
              : "quota_limit",
            scope: String(decision[2]),
            ...(reason === "quota_limit"
              ? {
                dimension: String(decision[3]),
                limit: Number(decision[4]),
                used: Number(decision[5]),
                requested: Number(decision[6]),
                reserved: Number(decision[7]),
                nextAvailableAt: Number(decision[8]) > 0
                  ? Number(decision[8])
                  : Number(decision[9]) > 0
                  ? Number(decision[9])
                  : null,
                window: typeof decision[10] === "string"
                  ? String(decision[10])
                  : undefined,
              }
              : {
                nextAvailableAt: Number(decision[3]) > 0
                  ? Number(decision[3])
                  : null,
              }),
          },
        };
      }
      return { failure: "quota_unavailable" };
    } catch {
      return { failure: "quota_unavailable" };
    }
  }
  async factsPending(id: string, active: boolean) {
    const quotas = this.config[GOOGLE_GEMMA]?.quotas;
    if (!quotas?.length) throw Error("quota_unconfigured");
    await this.command([
      "EVAL",
      `local scopes=cjson.decode(ARGV[1]); for _,s in ipairs(scopes) do if ARGV[3]=='1' then redis.call('ZADD',s..':facts',ARGV[4],ARGV[2]); redis.call('PEXPIRE',s..':facts',150000) else redis.call('ZREM',s..':facts',ARGV[2]) end end return 1`,
      0,
      JSON.stringify(quotas.map((q) => `ai:v1:${q.scope}`)),
      id,
      active ? "1" : "0",
      Date.now() + 150000,
    ]);
  }
  async cooldown(model: string, response: Response) {
    const until = await cooldownUntil(response);
    const scopes = this.config[model]?.quotas.map((q) => `ai:v1:${q.scope}`) ??
      [];
    await this.command([
      "EVAL",
      `for _,s in ipairs(cjson.decode(ARGV[1])) do local key=s..':cooldown'; local n=math.max(tonumber(redis.call('GET',key) or '0'),tonumber(ARGV[2])); redis.call('SET',key,n,'PX',math.max(1,n-tonumber(ARGV[3]))) end return 1`,
      0,
      JSON.stringify(scopes),
      until,
      Date.now(),
    ]);
  }
  async reconcileReservationUsage(
    reservation: QuotaReservation,
    inputTokens: number,
    outputTokens?: number,
  ) {
    const adjustments = reservation.tokenRules.flatMap((rule) => {
      if (rule.dimension === "tpm" && rule.inputOnly) {
        return [{ key: rule.key, cost: inputTokens }];
      }
      if (outputTokens === undefined) return [];
      return [{
        key: rule.key,
        cost: rule.dimension === "otpm"
          ? outputTokens
          : inputTokens + outputTokens,
      }];
    });
    if (!adjustments.length) return;
    await this.command([
      "EVAL",
      RECONCILE_LUA,
      0,
      JSON.stringify(adjustments),
      reservation.id,
    ]);
  }
  async releaseReservation(reservation: QuotaReservation) {
    await this.command([
      "EVAL",
      RELEASE_LUA,
      0,
      JSON.stringify(reservation.rules),
      reservation.id,
    ]);
  }
}

const pendingProviderReservations = new WeakMap<
  Response,
  { limiter: AiRateLimiter; reservation: QuotaReservation }
>();

/** Replace conservative token reservations with provider-reported usage. */
export async function reconcileQuotaUsage(
  response: Response,
  promptTokens: unknown,
  completionTokens: unknown,
) {
  const pending = pendingProviderReservations.get(response);
  if (!pending) return;
  pendingProviderReservations.delete(response);
  if (!Number.isSafeInteger(promptTokens) || (promptTokens as number) < 0) {
    return;
  }
  const hasCompletionTokens = Number.isSafeInteger(completionTokens) &&
    (completionTokens as number) >= 0;
  try {
    await pending.limiter.reconcileReservationUsage(
      pending.reservation,
      promptTokens as number,
      hasCompletionTokens ? completionTokens as number : undefined,
    );
  } catch {
    // Keep the initial conservative reservation when reconciliation is unavailable.
  }
}

/** Used at the actual provider send point so existing retries also reserve quota. */
export function quotaFetch(
  model: string,
  kind: "facts" | "comment",
  limiter = new AiRateLimiter(),
  fetcher = fetch,
): typeof fetch {
  return async (input, init) => {
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    // Staged rollout: absent config keeps the old worker running, while the router is disabled.
    if (!limiter.env("AI_QUOTA_CONFIG")) return fetcher(input, init);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const actualModel = model === "groq-stage1" ? String(body.model) : model;
    const output = body.max_completion_tokens ??
      body.generationConfig?.maxOutputTokens ?? 512;
    const tokens = estimateInputTokens(String(init?.body ?? ""));
    const decision = await limiter.reserveDecision(
      actualModel,
      tokens,
      output,
      kind,
    );
    if (decision.failure) {
      if (decision.diagnostic) {
        console.warn("[AIQuota] request blocked before provider send", {
          provider: actualModel === GOOGLE_GEMMA
            ? "google"
            : actualModel.startsWith("groq-") ||
                actualModel.startsWith("qwen/") ||
                actualModel.startsWith("openai/gpt-oss-")
            ? "groq"
            : "other",
          model: actualModel,
          kind,
          ...decision.diagnostic,
        });
      }
      throw new QuotaReservationError(decision.failure, decision.diagnostic);
    }
    if (init?.signal?.aborted) {
      if (decision.reservation) {
        try {
          await limiter.releaseReservation(decision.reservation);
        } catch {
          // The provider was not called; keep a conservative reservation if release fails.
        }
      }
      throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const response = await fetcher(input, init);
    if (response.status === 429) await limiter.cooldown(actualModel, response);
    else if (response.ok && decision.reservation) {
      pendingProviderReservations.set(response, {
        limiter,
        reservation: decision.reservation,
      });
    }
    return response;
  };
}

/** Conservative token estimate for a serialized JSON request, not byte count. */
export function estimateInputTokens(body: string): number {
  // UTF-8 bytes materially exceed model tokens for JSON, Latin text and CJK.
  // One quarter remains conservative against observed provider prompt-token
  // counts while avoiding charging each serialized byte as a model token.
  return Math.ceil(new TextEncoder().encode(body).length / 4);
}

export async function markFactsPending(
  id: string,
  active: boolean,
  limiter = new AiRateLimiter(),
) {
  if (!limiter.env("AI_QUOTA_CONFIG")) return;
  await limiter.factsPending(id, active);
}

/** Read-only quota check used to schedule a deferred Stage 2 request. */
export async function inspectQuotaAvailability(
  model: string,
  input: number,
  output: number,
  kind: "facts" | "comment" = "facts",
  limiter = new AiRateLimiter(),
): Promise<QuotaDecision> {
  return await limiter.inspectDecision(model, input, output, kind);
}

export async function cooldownUntil(
  response: Response,
  now = Date.now(),
): Promise<number> {
  const delays: number[] = [];
  const duration = (value: string | null) => {
    if (typeof value !== "string" || !value) return;
    if (/^\d+(\.\d+)?$/.test(value)) {
      delays.push(Number(value) * 1000);
      return;
    }
    const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
    if (parts.length) {
      delays.push(parts.reduce(
        (sum, m) =>
          sum +
          Number(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]!),
        0,
      ));
    } else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) delays.push(date - now);
    }
  };
  duration(response.headers.get("retry-after"));
  for (const dimension of ["requests", "tokens"]) {
    if (response.headers.get(`x-ratelimit-remaining-${dimension}`) === "0") {
      duration(response.headers.get(`x-ratelimit-reset-${dimension}`));
    }
  }
  const body = await response.clone().json().catch(() => null);
  for (
    const detail of Array.isArray(body?.error?.details)
      ? body.error.details
      : []
  ) duration(detail?.retryDelay);
  return now + Math.max(1000, ...(delays.length ? delays : [60000]));
}
