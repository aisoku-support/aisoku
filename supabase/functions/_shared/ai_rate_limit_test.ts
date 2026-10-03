import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import {
  AiRateLimiter,
  cooldownUntil,
  estimateInputTokens,
  nextQuotaDayStart,
  type QuotaConfig,
  quotaConfig,
  quotaFetch,
  rulesFor,
} from "./ai_rate_limit.ts";
import { MemoryQuotaRedis } from "./ai_rate_limit_test_helpers.ts";
const config: QuotaConfig = {
  "google-gemma": {
    free: true,
    quotas: [{
      scope: "project-gemma",
      rpm: 3,
      tpm: 16000,
      rpd: 14400,
      day: "PT",
      factsReserveRpm: 1,
      factsReserveTpm: 4000,
    }],
  },
  other: {
    free: true,
    quotas: [{
      scope: "project-gemma",
      rpm: 3,
      tpm: 16000,
      rpd: 14400,
      day: "PT",
    }],
  },
};

Deno.test("actual Lua: shared concurrent quota reservations cannot exceed RPM; Facts keeps headroom", async () => {
  const redis = new MemoryQuotaRedis(config);
  try {
    deepStrictEqual(
      await Promise.all(
        Array.from(
          { length: 5 },
          () => redis.reserve("google-gemma", 1000, 100),
        ),
      ),
      [true, true, false, false, false],
    );
    strictEqual(await redis.reserve("other", 1000, 100, "facts"), true);
    strictEqual(await redis.reserve("other", 1000, 100, "facts"), false);
  } finally {
    redis.close();
  }
});
Deno.test("actual Lua: cooldown shared across keys/models; longer cooldown never shortened", async () => {
  const redis = new MemoryQuotaRedis(config);
  try {
    await redis.cooldown(
      "other",
      Response.json({}, { status: 429, headers: { "retry-after": "120" } }),
    );
    await redis.cooldown(
      "other",
      Response.json({}, { status: 429, headers: { "retry-after": "1" } }),
    );
    strictEqual(await redis.reserve("google-gemma", 100, 100), false);
    const blocked = await redis.reserveDecision(
      "google-gemma",
      100,
      100,
      "facts",
    );
    strictEqual(blocked.failure, "quota_limit");
    strictEqual(blocked.diagnostic?.reason, "cooldown");
    strictEqual(blocked.diagnostic?.scope, "ai:v1:project-gemma");
    strictEqual(typeof blocked.diagnostic?.nextAvailableAt, "number");
  } finally {
    redis.close();
  }
});
Deno.test("429 supports Google RetryInfo, Groq reset durations, HTTP date and unknown fallback", async () => {
  const now = Date.parse("2026-09-27T00:00:00Z");
  strictEqual(
    await cooldownUntil(
      Response.json({ error: { details: [{ retryDelay: "12.5s" }] } }, {
        status: 429,
      }),
      now,
    ),
    now + 12500,
  );
  strictEqual(
    await cooldownUntil(
      Response.json({}, {
        status: 429,
        headers: {
          "x-ratelimit-remaining-tokens": "0",
          "x-ratelimit-reset-tokens": "1m2s",
        },
      }),
      now,
    ),
    now + 62000,
  );
  strictEqual(
    await cooldownUntil(
      Response.json({}, {
        status: 429,
        headers: { "retry-after": new Date(now + 120000).toUTCString() },
      }),
      now,
    ),
    now + 120000,
  );
  strictEqual(
    await cooldownUntil(Response.json({}, { status: 429 }), now),
    now + 60000,
  );
});
Deno.test("Google daily internal limit is 10000/PT, Facts retains 4400; Cloudflare neurons charged", () => {
  const rules = rulesFor(
    config["google-gemma"].quotas,
    1000,
    100,
    true,
    true,
    Date.parse("2026-09-27T06:00:00Z"),
  );
  const day = rules.find((r) => r.key.includes(":comments:"))!;
  strictEqual(day.limit, 10000);
  strictEqual(day.key.endsWith("2026-09-26"), true);
  strictEqual(
    rulesFor(
      [{
        scope: "cf",
        rpm: 300,
        tpm: 100000,
        rpd: 10000,
        day: "UTC",
        neuronsPerDay: 10000,
        inputNeuronsPerMillionTokens: 9091,
        outputNeuronsPerMillionTokens: 27273,
      }],
      1000000,
      1000000,
      true,
      false,
      Date.now(),
    ).find((r) => r.key.includes("neurons"))!.cost,
    36364,
  );
});
Deno.test("quota rejection is distinct from Redis unavailability", async () => {
  const redis = new MemoryQuotaRedis(config);
  try {
    strictEqual(
      await redis.reserveFailure("google-gemma", 1_000_000, 512, "facts"),
      "quota_limit",
    );
  } finally {
    redis.close();
  }
});

Deno.test("quota denial reports the exact exhausted dimension and usage", async () => {
  const redis = new MemoryQuotaRedis({
    limited: {
      free: true,
      quotas: [{
        scope: "limited-model",
        rpm: 30,
        tpm: 1000,
        rpd: 1,
        day: "rolling",
      }],
    },
  });
  try {
    strictEqual(await redis.reserveFailure("limited", 100, 100, "facts"), null);
    const result = await redis.reserveDecision("limited", 100, 100, "facts");
    strictEqual(result.failure, "quota_limit");
    strictEqual(result.diagnostic?.reason, "quota_limit");
    strictEqual(result.diagnostic?.dimension, "rpd");
    strictEqual(result.diagnostic?.window, "24h rolling");
    strictEqual(result.diagnostic?.scope, "limited-model");
    strictEqual(result.diagnostic?.limit, 1);
    strictEqual(result.diagnostic?.used, 1);
    strictEqual(result.diagnostic?.requested, 1);
    strictEqual(result.diagnostic?.reserved, 0);
    strictEqual(typeof result.diagnostic?.nextAvailableAt, "number");
  } finally {
    redis.close();
  }
});

Deno.test("rolling quota diagnostic reports the earliest sufficient expiry", async () => {
  const redis = new MemoryQuotaRedis({
    limited: {
      free: true,
      quotas: [{
        scope: "limited-model",
        rpm: 30,
        tpm: 1000,
        rpd: 10,
        day: "rolling",
      }],
    },
  });
  try {
    const started = Date.now();
    strictEqual(await redis.reserveFailure("limited", 600, 0, "facts"), null);
    const result = await redis.reserveDecision("limited", 500, 0, "facts");
    strictEqual(result.diagnostic?.dimension, "tpm");
    strictEqual(result.diagnostic?.used, 600);
    strictEqual(result.diagnostic?.requested, 500);
    strictEqual(
      (result.diagnostic?.nextAvailableAt ?? 0) >= started + 60_000,
      true,
    );
    strictEqual(
      (result.diagnostic?.nextAvailableAt ?? 0) <= Date.now() + 60_000,
      true,
    );
  } finally {
    redis.close();
  }
});

Deno.test("read-only quota inspection reports availability without reserving usage", async () => {
  const redis = new MemoryQuotaRedis({
    limited: {
      free: true,
      quotas: [{
        scope: "inspect-model",
        rpm: 30,
        tpm: 1000,
        rpd: 1,
        day: "PT",
      }],
    },
  });
  try {
    strictEqual(
      (await redis.inspectDecision("limited", 100, 100, "facts")).failure,
      null,
    );
    strictEqual(await redis.reserve("limited", 100, 100, "facts"), true);
    const blocked = await redis.inspectDecision("limited", 100, 100, "facts");
    strictEqual(blocked.failure, "quota_limit");
    strictEqual(blocked.diagnostic?.dimension, "rpd");
    strictEqual(typeof blocked.diagnostic?.nextAvailableAt, "number");
  } finally {
    redis.close();
  }
});

Deno.test("fixed daily quota availability uses UTC or Pacific midnight", () => {
  strictEqual(
    new Date(nextQuotaDayStart(Date.parse("2026-01-15T12:00:00Z"), "PT"))
      .toISOString(),
    "2026-01-16T08:00:00.000Z",
  );
  strictEqual(
    new Date(nextQuotaDayStart(Date.parse("2026-03-08T12:00:00Z"), "PT"))
      .toISOString(),
    "2026-03-09T07:00:00.000Z",
  );
});

Deno.test("serialized request bytes are conservatively estimated as tokens", () => {
  const request = JSON.stringify({
    model: "qwen/qwen3.8-27b",
    max_completion_tokens: 512,
    content: "x".repeat(2400),
  });
  const bytes = new TextEncoder().encode(request).length;
  const estimatedTokens = estimateInputTokens(request);
  strictEqual(estimatedTokens, Math.ceil(bytes / 4));

  const rule = rulesFor(
    [{
      scope: "groq-qwen-27b",
      rpm: 30,
      tpm: 8000,
      rpd: 1000,
      tpd: 200000,
      day: "rolling",
    }],
    estimatedTokens,
    512,
    false,
    false,
    Date.now(),
  ).find((candidate) => candidate.dimension === "tpd")!;
  const normalRequests = 150;
  strictEqual(normalRequests * rule.cost < rule.limit, true);
  // The former bytes-as-tokens estimate stopped the same 75 requests early.
  strictEqual(normalRequests * (bytes + 128 + 512) > rule.limit, true);
});

Deno.test("cancellation before provider send releases the entire quota reservation", async () => {
  const controller = new AbortController();
  const cancelReason = new DOMException(
    "cancelled after quota reservation",
    "AbortError",
  );
  class CancelAfterReserveRedis extends MemoryQuotaRedis {
    override async command(command: unknown[]) {
      const result = await super.command(command);
      if (
        String(command[1]).includes("local now=tonumber(ARGV[1])")
      ) controller.abort(cancelReason);
      return result;
    }
  }
  const redis = new CancelAfterReserveRedis({
    "google-gemma": {
      free: true,
      quotas: [{
        scope: "cancel-test",
        rpm: 1,
        tpm: 16000,
        rpd: 1,
        day: "PT",
      }],
    },
  });
  try {
    let providerCalls = 0;
    const guarded = quotaFetch(
      "google-gemma",
      "facts",
      redis,
      async () => {
        providerCalls++;
        return Response.json({});
      },
    );
    await rejects(() =>
      guarded("https://quota.mock", {
        method: "POST",
        body: JSON.stringify({ model: "google-gemma" }),
        signal: controller.signal,
      }), /cancelled after quota reservation/);
    strictEqual(providerCalls, 0);

    const retry = quotaFetch(
      "google-gemma",
      "facts",
      redis,
      async () => {
        providerCalls++;
        return Response.json({});
      },
    );
    const response = await retry("https://quota.mock", {
      method: "POST",
      body: JSON.stringify({ model: "google-gemma" }),
    });
    strictEqual(response.ok, true);
    strictEqual(providerCalls, 1);
  } finally {
    redis.close();
  }
});

Deno.test("Redis errors fail closed and Facts provider is never called without reservation", async () => {
  const limiter = new AiRateLimiter(config, async () => {
    throw Error("offline");
  }, () => "configured");
  strictEqual(await limiter.reserve("google-gemma", 100, 100), false);
  strictEqual(
    await limiter.reserveFailure("google-gemma", 100, 100),
    "quota_unavailable",
  );
  strictEqual(
    await limiter.reserveFailure("missing-model", 100, 100),
    "quota_unconfigured",
  );
  let calls = 0;
  const guarded = quotaFetch("google-gemma", "facts", limiter, async () => {
    calls++;
    return Response.json({});
  });
  await rejects(() => guarded("https://example.invalid", { body: "{}" }));
  strictEqual(calls, 0);
  deepStrictEqual(quotaConfig(() => "{bad"), {});
});

Deno.test("provider-specific Cloudflare Neurons budget is atomic across models", async () => {
  const raw = {
    "cloudflare-gemma": {
      free: true,
      provider: "cloudflare",
      quotas: [{
        scope: "cf-text-generation-rpm",
        rpm: 300,
        day: "UTC",
      }, {
        scope: "cloudflare-workers-ai-neurons",
        neuronsPerDay: 10000,
        inputNeuronsPerMillionTokens: 9091,
        outputNeuronsPerMillionTokens: 27273,
        day: "UTC",
      }],
    },
    "cloudflare-other": {
      free: true,
      provider: "cloudflare",
      quotas: [{
        scope: "cf-other-model-rpm",
        rpm: 300,
        day: "UTC",
      }, {
        scope: "cloudflare-workers-ai-neurons",
        neuronsPerDay: 10000,
        inputNeuronsPerMillionTokens: 9000,
        outputNeuronsPerMillionTokens: 27000,
        day: "UTC",
      }],
    },
  };
  const validated = quotaConfig(() => JSON.stringify(raw));
  strictEqual(validated["cloudflare-gemma"].provider, "cloudflare");
  const redis = new MemoryQuotaRedis(validated);
  try {
    const now = Date.now();
    // The official conversion rounds the combined estimated charge upward.
    strictEqual(
      rulesFor(
        validated["cloudflare-gemma"].quotas,
        1_000_000,
        1_000_000,
        true,
        false,
        Date.now(),
      )
        .find((r) => r.key.includes(":neurons:"))!.cost,
      36364,
    );
    const dailyRule = rulesFor(
      validated["cloudflare-gemma"].quotas,
      1_000_000,
      1_000_000,
      true,
      false,
      now,
    ).find((r) => r.key.includes(":neurons:"))!;
    await redis.command(["SET", dailyRule.key, 9999]);
    strictEqual(
      await redis.reserve("cloudflare-gemma", 1_000_000, 1_000_000),
      false,
    );
    strictEqual(
      await redis.reserve("cloudflare-other", 1_000_000, 1_000_000),
      false,
    );
    const beforeMidnight = rulesFor(
      validated["cloudflare-gemma"].quotas,
      1,
      1,
      true,
      false,
      Date.parse("2026-09-27T23:59:00Z"),
    ).find((r) => r.key.includes(":neurons:"))!.key;
    const afterMidnight = rulesFor(
      validated["cloudflare-gemma"].quotas,
      1,
      1,
      true,
      false,
      Date.parse("2026-09-28T00:01:00Z"),
    ).find((r) => r.key.includes(":neurons:"))!.key;
    strictEqual(beforeMidnight.endsWith(":2026-09-27"), true);
    strictEqual(afterMidnight.endsWith(":2026-09-28"), true);
    strictEqual(
      quotaConfig(() =>
        JSON.stringify({
          "cloudflare-gemma": {
            free: true,
            provider: "cloudflare",
            quotas: [{
              scope: "cf-invalid",
              neuronsPerDay: 10000,
              inputNeuronsPerMillionTokens: 1,
              outputNeuronsPerMillionTokens: 2,
              day: "UTC",
            }],
          },
        })
      )["cloudflare-gemma"],
      undefined,
    );
  } finally {
    redis.close();
  }
  const concurrent = new MemoryQuotaRedis(validated);
  try {
    const accepted = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        concurrent.reserve(
          i % 2 ? "cloudflare-gemma" : "cloudflare-other",
          150_000,
          0,
        )),
    );
    strictEqual(accepted.filter(Boolean).length, 7);
  } finally {
    concurrent.close();
  }
});

Deno.test("OpenRouter free-model RPM and RPD are shared; tier requires explicit setting", async () => {
  const raw = {
    "openrouter-nemotron": {
      free: true,
      provider: "openrouter",
      quotas: [{ scope: "openrouter-free-models", rpm: 20, day: "rolling" }],
    },
    "openrouter-another-free-model": {
      free: true,
      provider: "openrouter",
      quotas: [{ scope: "openrouter-free-models", rpm: 20, day: "rolling" }],
    },
  };
  const validated = quotaConfig(() => JSON.stringify(raw));
  strictEqual(validated["openrouter-nemotron"].quotas[0].rpd, 50);
  const redis = new MemoryQuotaRedis(validated);
  try {
    const dayLimit = rulesFor(
      validated["openrouter-nemotron"].quotas,
      1,
      1,
      true,
      false,
      Date.parse("2026-09-27T23:59:00Z"),
    ).find((r) => r.key.includes(":rpd"))!;
    await redis.command([
      "ZADD",
      dayLimit.key,
      Date.now(),
      JSON.stringify({ id: "prior-free-model-usage", cost: 49 }),
    ]);
    strictEqual(await redis.reserve("openrouter-nemotron", 1, 1), true);
    strictEqual(
      await redis.reserve("openrouter-another-free-model", 1, 1),
      false,
    );
    const nextDay = rulesFor(
      validated["openrouter-nemotron"].quotas,
      1,
      1,
      true,
      false,
      Date.parse("2026-09-28T00:01:00Z"),
    ).find((r) => r.key.includes(":rpd"))!;
    strictEqual(nextDay.key, dayLimit.key);
    strictEqual(nextDay.cutoff > dayLimit.cutoff, true);
    strictEqual(
      quotaConfig(() =>
        JSON.stringify({
          "openrouter-nemotron": {
            free: true,
            provider: "openrouter",
            dailyTier: "credit_qualified",
            quotas: [{
              scope: "openrouter-free-models",
              rpm: 20,
              day: "rolling",
            }],
          },
        })
      )["openrouter-nemotron"].quotas[0].rpd,
      1000,
    );
    strictEqual(
      quotaConfig(() =>
        JSON.stringify({
          "openrouter-nemotron": {
            free: true,
            provider: "openrouter",
            quotas: [{
              scope: "openrouter-free-models",
              rpm: 20,
              tpm: 1000,
              day: "UTC",
            }],
          },
        })
      )["openrouter-nemotron"],
      undefined,
    );
  } finally {
    redis.close();
  }
  const rpmRedis = new MemoryQuotaRedis(validated);
  try {
    const accepted = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        rpmRedis.reserve(
          i % 2 ? "openrouter-nemotron" : "openrouter-another-free-model",
          1,
          1,
        )),
    );
    strictEqual(accepted.filter(Boolean).length, 20);
  } finally {
    rpmRedis.close();
  }
});

Deno.test("provider 429 cooldown is shared and Redis failures fail closed", async () => {
  const validated = quotaConfig(() =>
    JSON.stringify({
      "openrouter-nemotron": {
        free: true,
        provider: "openrouter",
        quotas: [{ scope: "openrouter-free-models", rpm: 20, day: "rolling" }],
      },
      "openrouter-another-free-model": {
        free: true,
        provider: "openrouter",
        quotas: [{ scope: "openrouter-free-models", rpm: 20, day: "rolling" }],
      },
    })
  );
  const offline = new AiRateLimiter(validated, async () => {
    throw Error("offline");
  }, () => "configured");
  strictEqual(await offline.reserve("openrouter-nemotron", 1, 1), false);
  const redis = new MemoryQuotaRedis(validated);
  try {
    await redis.cooldown(
      "openrouter-nemotron",
      Response.json({}, { status: 429, headers: { "retry-after": "120" } }),
    );
    strictEqual(
      await redis.reserve("openrouter-another-free-model", 1, 1),
      false,
    );
  } finally {
    redis.close();
  }
});

Deno.test("actual Lua: Google comment daily cap stops comments while Facts can continue", async () => {
  const redis = new MemoryQuotaRedis(config);
  try {
    const rule = rulesFor(
      config["google-gemma"].quotas,
      100,
      100,
      true,
      true,
      Date.now(),
    ).find((r) => r.key.includes(":comments:"))!;
    await redis.command(["SET", rule.key, 9999]);
    strictEqual(await redis.reserve("google-gemma", 100, 100), true);
    strictEqual(await redis.reserve("google-gemma", 100, 100), false);
    strictEqual(await redis.reserve("google-gemma", 100, 100, "facts"), true);
  } finally {
    redis.close();
  }
});
