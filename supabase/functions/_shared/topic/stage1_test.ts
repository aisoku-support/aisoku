import { deepStrictEqual, strictEqual } from "node:assert";
import {
  type QuotaConfig,
  quotaConfig,
  quotaFetch,
  QuotaReservationError,
} from "../ai_rate_limit.ts";
import { MemoryQuotaRedis } from "../ai_rate_limit_test_helpers.ts";
import { classifyStage1, stage1ModelsAt } from "./stage1.ts";
import { TOPIC_CATEGORIES } from "./gemma_parser.ts";
import type { TopicArticle } from "./types.ts";

const article: TopicArticle = {
  article_id: "article-1",
  title: "source title",
  description: "source description",
  url: "https://example.com/article",
  normalized_url: null,
  source_name: null,
  published_at: null,
  newsdata_categories: [],
  app_categories: [],
  fetched_at: null,
};

function groqResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          articles: [{
            index: 0,
            subject: "subject",
            event: "event",
            category: TOPIC_CATEGORIES[0],
          }],
        }),
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 18 },
    ...overrides,
  }));
}

function reservedCosts(redis: MemoryQuotaRedis, key: string) {
  const entries = redis.entries()[key] as Record<string, number> | undefined;
  return Object.keys(entries ?? {}).map((member) =>
    (JSON.parse(member) as { cost: number }).cost
  );
}

Deno.test("Stage 1 chooses model order by JST hour", () => {
  strictEqual(
    stage1ModelsAt(new Date("2026-09-26T02:59:00Z")).join(","),
    "qwen/qwen3.8-27b,openai/gpt-oss-20b",
  );
  strictEqual(
    stage1ModelsAt(new Date("2026-09-26T03:00:00Z")).join(","),
    "openai/gpt-oss-20b,qwen/qwen3.8-27b",
  );
});

Deno.test("Stage 1 quota rejection is not a network failure or a timeout retry", async () => {
  let calls = 0;
  try {
    await classifyStage1([article], "test-key", async () => {
      calls++;
      throw new QuotaReservationError("quota_limit");
    });
    throw new Error("expected rejection");
  } catch (error) {
    const attempts = (error as Error & {
      attempts: Array<{ errorType: string; timeoutRetry: boolean }>;
    }).attempts;
    strictEqual(calls, 2);
    deepStrictEqual(attempts.map((x) => x.errorType), [
      "quota_limit",
      "quota_limit",
    ]);
    strictEqual(attempts.some((x) => x.timeoutRetry), false);
  }
});

Deno.test("Stage 1 uses only the primary when validation succeeds", async () => {
  const models: string[] = [];
  const result = await classifyStage1(
    [article],
    "test-key",
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      models.push(payload.model);
      strictEqual(payload.temperature, 0);
      strictEqual(payload.max_completion_tokens, 512);
      strictEqual(payload.response_format.json_schema.strict, true);
      return groqResponse();
    },
    new Date("2026-09-26T02:00:00Z"),
  );
  strictEqual(models.join(","), "qwen/qwen3.8-27b");
  strictEqual(result.results[0]?.topic_text, "subject | event");
  strictEqual(result.results[0]?.facts?.length, 0);
  strictEqual(result.attempts.length, 1);
  strictEqual(result.attempts[0]?.outcome, "success");
  strictEqual(result.attempts[0]?.role, "primary");
});

Deno.test("Stage 1 sends Qwen and GPT-OSS 20B after model-specific shared quota reservations", async () => {
  const config: QuotaConfig = {
    "qwen/qwen3.8-27b": {
      free: true,
      quotas: [{
        scope: "groq-qwen-27b",
        rpm: 30,
        tpm: 8000,
        rpd: 1000,
        tpd: 200000,
        otpm: 1000,
        day: "rolling",
      }],
    },
    "openai/gpt-oss-20b": {
      free: true,
      quotas: [{
        scope: "groq-gpt-oss-20b",
        rpm: 30,
        tpm: 8000,
        rpd: 1000,
        tpd: 200000,
        day: "rolling",
      }],
    },
  };
  const validatedConfig = quotaConfig(() => JSON.stringify(config));
  deepStrictEqual(Object.keys(validatedConfig).sort(), [
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
  ]);
  strictEqual(validatedConfig["openai/gpt-oss-20b"].quotas[0].itpm, undefined);
  strictEqual(validatedConfig["openai/gpt-oss-20b"].quotas[0].otpm, undefined);
  const redis = new MemoryQuotaRedis(validatedConfig);
  try {
    const sentModels: string[] = [];
    const guarded = quotaFetch(
      "groq-stage1",
      "facts",
      redis,
      async (_input, init) => {
        sentModels.push(JSON.parse(String(init?.body)).model);
        return groqResponse();
      },
    );
    for (
      const [date, model] of [
        [new Date("2026-09-26T02:00:00Z"), "qwen/qwen3.8-27b"],
        [new Date("2026-09-26T03:00:00Z"), "openai/gpt-oss-20b"],
      ] as const
    ) {
      const result = await classifyStage1([article], "test-key", guarded, date);
      strictEqual(result.attempts[0]?.model, model);
      strictEqual(result.attempts[0]?.outcome, "success");
      strictEqual(result.results[0]?.topic_text, "subject | event");
    }
    deepStrictEqual(sentModels, ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"]);
    deepStrictEqual(
      Object.keys(redis.entries()).filter((key) => key.endsWith(":rpm")).sort(),
      ["ai:v1:groq-gpt-oss-20b:rpm", "ai:v1:groq-qwen-27b:rpm"],
    );
  } finally {
    redis.close();
  }
});

Deno.test("Stage 1 reconciles successful token reservations to Groq usage", async () => {
  const config: QuotaConfig = {
    "qwen/qwen3.8-27b": {
      free: true,
      quotas: [{
        scope: "groq-qwen-27b",
        rpm: 30,
        tpm: 8000,
        rpd: 1000,
        tpd: 200000,
        otpm: 1000,
        day: "rolling",
      }],
    },
    "openai/gpt-oss-20b": {
      free: true,
      quotas: [{
        scope: "groq-gpt-oss-20b",
        rpm: 30,
        tpm: 8000,
        rpd: 1000,
        tpd: 200000,
        day: "rolling",
      }],
    },
  };
  const redis = new MemoryQuotaRedis(quotaConfig(() => JSON.stringify(config)));
  try {
    await classifyStage1(
      [article],
      "test-key",
      quotaFetch("groq-stage1", "facts", redis, async () => groqResponse()),
      new Date("2026-09-26T02:00:00Z"),
    );
    strictEqual(reservedCosts(redis, "ai:v1:groq-qwen-27b:tpm")[0], 30);
    strictEqual(reservedCosts(redis, "ai:v1:groq-qwen-27b:tpd")[0], 30);
    strictEqual(reservedCosts(redis, "ai:v1:groq-qwen-27b:otpm")[0], 18);
    strictEqual(reservedCosts(redis, "ai:v1:groq-qwen-27b:rpd")[0], 1);
    strictEqual(reservedCosts(redis, "ai:v1:groq-qwen-27b:rpm")[0], 1);
  } finally {
    redis.close();
  }
});

Deno.test("Stage 1 falls back when only the primary model is internally quota-blocked", async () => {
  const config = quotaConfig(() =>
    JSON.stringify({
      "qwen/qwen3.8-27b": {
        free: true,
        quotas: [{
          scope: "groq-qwen-27b",
          rpm: 30,
          tpm: 8000,
          rpd: 1,
          day: "rolling",
        }],
      },
      "openai/gpt-oss-20b": {
        free: true,
        quotas: [{
          scope: "groq-gpt-oss-20b",
          rpm: 30,
          tpm: 8000,
          rpd: 1000,
          day: "rolling",
        }],
      },
    })
  );
  const redis = new MemoryQuotaRedis(config);
  try {
    strictEqual(await redis.reserve("qwen/qwen3.8-27b", 1, 1, "facts"), true);
    const sentModels: string[] = [];
    const result = await classifyStage1(
      [article],
      "test-key",
      quotaFetch("groq-stage1", "facts", redis, async (_input, init) => {
        const model = JSON.parse(String(init?.body)).model;
        sentModels.push(model);
        return groqResponse();
      }),
      new Date("2026-09-26T02:00:00Z"),
    );
    deepStrictEqual(sentModels, ["openai/gpt-oss-20b"]);
    strictEqual(result.attempts[0]?.errorType, "quota_limit");
    strictEqual(result.attempts[0]?.apiSendState, "blocked_before_send");
    strictEqual(result.attempts[1]?.role, "fallback");
    strictEqual(result.attempts[1]?.outcome, "success");
  } finally {
    redis.close();
  }
});

Deno.test("Stage 1 keeps ambiguous timeout reservations and reconciles fallback usage", async () => {
  const config = quotaConfig(() =>
    JSON.stringify({
      "qwen/qwen3.8-27b": {
        free: true,
        quotas: [{
          scope: "groq-qwen-27b",
          rpm: 30,
          tpm: 8000,
          rpd: 1000,
          tpd: 200000,
          otpm: 1000,
          day: "rolling",
        }],
      },
      "openai/gpt-oss-20b": {
        free: true,
        quotas: [{
          scope: "groq-gpt-oss-20b",
          rpm: 30,
          tpm: 8000,
          rpd: 1000,
          tpd: 200000,
          day: "rolling",
        }],
      },
    })
  );
  const redis = new MemoryQuotaRedis(config);
  try {
    const sentModels: string[] = [];
    const result = await classifyStage1(
      [article],
      "test-key",
      quotaFetch("groq-stage1", "facts", redis, async (_input, init) => {
        const model = JSON.parse(String(init?.body)).model;
        sentModels.push(model);
        if (model === "qwen/qwen3.8-27b") {
          throw new DOMException("timed out", "TimeoutError");
        }
        return groqResponse();
      }),
      new Date("2026-09-26T02:00:00Z"),
    );
    deepStrictEqual(sentModels, [
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
    ]);
    strictEqual(result.attempts[0]?.errorType, "timeout");
    strictEqual(result.attempts[1]?.errorType, "quota_limit");
    strictEqual(result.attempts[1]?.apiSendState, "blocked_before_send");
    strictEqual(result.attempts[2]?.role, "fallback");
    strictEqual(
      reservedCosts(redis, "ai:v1:groq-qwen-27b:tpm").length,
      1,
    );
    strictEqual(reservedCosts(redis, "ai:v1:groq-gpt-oss-20b:tpm")[0], 30);
  } finally {
    redis.close();
  }
});

Deno.test("Stage 1 uses extracted body as description only when description is absent", async () => {
  const noDescription = {
    ...article,
    description: null,
    cleaned_body: "readability fixture body",
  };
  await classifyStage1(
    [noDescription],
    "test-key",
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      const input = JSON.parse(payload.messages[1].content);
      strictEqual(input[0].description, "readability fixture body");
      return groqResponse();
    },
    new Date("2026-09-26T02:00:00Z"),
  );
});

Deno.test("Stage 1 falls back once after primary output validation fails", async () => {
  const models: string[] = [];
  const result = await classifyStage1(
    [article],
    "test-key",
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      models.push(payload.model);
      if (models.length === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{}" } }],
        }));
      }
      return groqResponse();
    },
    new Date("2026-09-26T02:00:00Z"),
  );
  strictEqual(models.join(","), "qwen/qwen3.8-27b,openai/gpt-oss-20b");
  strictEqual(result.results.length, 1);
  strictEqual(result.attempts[0]?.errorType, "output_validation_failed");
  strictEqual(result.attempts[1]?.fallbackReason, "output_validation_failed");
  strictEqual(result.attempts[1]?.role, "fallback");
});

Deno.test("Stage 1 falls back after a primary HTTP failure without retrying it", async () => {
  const models: string[] = [];
  const result = await classifyStage1(
    [article],
    "test-key",
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      models.push(payload.model);
      return models.length === 1
        ? new Response("{}", { status: 429 })
        : groqResponse();
    },
    new Date("2026-09-26T02:00:00Z"),
  );
  strictEqual(models.join(","), "qwen/qwen3.8-27b,openai/gpt-oss-20b");
  strictEqual(result.results.length, 1);
  strictEqual(result.attempts[0]?.errorType, "http_429");
  strictEqual(result.attempts[1]?.fallbackReason, "http_429");
});

Deno.test("Stage 1 retries a primary timeout once before using fallback", async () => {
  const models: string[] = [];
  const result = await classifyStage1(
    [article],
    "test-key",
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      models.push(payload.model);
      if (models.length < 3) {
        throw new DOMException(
          "timed out",
          "TimeoutError",
        );
      }
      return groqResponse();
    },
    new Date("2026-09-26T02:00:00Z"),
  );
  strictEqual(
    models.join(","),
    "qwen/qwen3.8-27b,qwen/qwen3.8-27b,openai/gpt-oss-20b",
  );
  strictEqual(result.results.length, 1);
  strictEqual(result.attempts.length, 3);
  strictEqual(result.attempts[0]?.errorType, "timeout");
  strictEqual(result.attempts[1]?.timeoutRetry, true);
  strictEqual(result.attempts[1]?.outcome, "failure");
  strictEqual(result.attempts[2]?.role, "fallback");
});
