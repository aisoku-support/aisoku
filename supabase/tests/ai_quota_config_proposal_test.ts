import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import {
  AiRateLimiter,
  estimateInputTokens,
  GOOGLE_GEMMA,
  quotaConfig,
  quotaFetch,
  QuotaReservationError,
  rulesFor,
} from "../functions/_shared/ai_rate_limit.ts";
import { MemoryQuotaRedis } from "../functions/_shared/ai_rate_limit_test_helpers.ts";
import {
  providerAvailable,
} from "../functions/generate-ai-replies/shared_router.ts";
import { classifyStage1 } from "../functions/_shared/topic/stage1.ts";
import { TOPIC_CATEGORIES } from "../functions/_shared/topic/gemma_parser.ts";
import type { TopicArticle } from "../functions/_shared/topic/types.ts";

const proposalUrl = new URL(
  "../../docs/AI_QUOTA_CONFIG.proposal.json",
  import.meta.url,
);
const proposalJson = await Deno.readTextFile(proposalUrl);
const config = quotaConfig(() => proposalJson);
const expectedModels = [
  "cloudflare-gemma",
  "gemini-3.1",
  "google-gemma",
  "groq-120b",
  "openai/gpt-oss-20b",
  "openrouter-nemotron",
  "qwen/qwen3.8-27b",
];
const routerModels = [
  "groq-120b",
  "google-gemma",
  "cloudflare-gemma",
  "gemini-3.1",
  "openrouter-nemotron",
] as const;

const article: TopicArticle = {
  article_id: "proposal-test-article",
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

function groqResponse() {
  return Response.json({
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
  });
}

Deno.test("proposal parses all Stage 1/router models with intended quotas and scopes", () => {
  deepStrictEqual(Object.keys(config).sort(), expectedModels);
  strictEqual(config["groq-120b"].quotas[0].scope, "groq-gpt-oss-120b");
  strictEqual(config["groq-120b"].quotas[0].tpm, 8000);
  strictEqual(config["groq-120b"].quotas[0].rpd, 1000);
  strictEqual(config["openai/gpt-oss-20b"].quotas[0].tpd, 200000);
  strictEqual(config["qwen/qwen3.8-27b"].quotas[0].otpm, 1000);
  strictEqual(config["qwen/qwen3.8-27b"].quotas[0].scope, "groq-qwen-27b");

  const gemma = config["google-gemma"].quotas[0];
  strictEqual(gemma.scope, "project-gemma");
  strictEqual(gemma.rpm, 30);
  strictEqual(gemma.tpm, 16000);
  strictEqual(gemma.rpd, 14400);
  strictEqual(gemma.factsReserveRpm, 1);
  strictEqual(gemma.factsReserveTpm, 4096);
  strictEqual(config["gemini-3.1"].quotas[0].rpd, 500);

  const cloudflare = config["cloudflare-gemma"];
  strictEqual(cloudflare.provider, "cloudflare");
  strictEqual(cloudflare.quotas[0].scope, "cloudflare-workers-ai-neurons");
  strictEqual(cloudflare.quotas[0].neuronsPerDay, 10000);
  strictEqual(cloudflare.quotas[0].inputNeuronsPerMillionTokens, 9091);
  strictEqual(cloudflare.quotas[0].outputNeuronsPerMillionTokens, 27273);

  const openrouter = config["openrouter-nemotron"];
  strictEqual(openrouter.provider, "openrouter");
  strictEqual(openrouter.dailyTier, "base");
  strictEqual(openrouter.quotas[0].scope, "openrouter-free-models");
  strictEqual(openrouter.quotas[0].rpd, 50);
  strictEqual(openrouter.quotas[0].tpm, undefined);

  // The 31B challenger intentionally remains on its independent management path.
  strictEqual(Object.keys(config).some((key) => key.includes("31b")), false);
});

Deno.test("proposal keeps Stage 1 Qwen and GPT-OSS 20B operational with mock responses", async () => {
  const redis = new MemoryQuotaRedis(config);
  try {
    const sentModels: string[] = [];
    const guarded = quotaFetch(
      "groq-stage1",
      "facts",
      redis,
      async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        strictEqual(body.max_completion_tokens, 512);
        sentModels.push(body.model);
        return groqResponse();
      },
    );
    for (
      const [date, expectedModel] of [
        [new Date("2026-09-26T02:00:00Z"), "qwen/qwen3.8-27b"],
        [new Date("2026-09-26T03:00:00Z"), "openai/gpt-oss-20b"],
      ] as const
    ) {
      const result = await classifyStage1([article], "mock-key", guarded, date);
      strictEqual(result.attempts[0]?.model, expectedModel);
      strictEqual(result.attempts[0]?.outcome, "success");
    }
    deepStrictEqual(sentModels, [
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
    ]);
  } finally {
    redis.close();
  }
});

Deno.test("Stage 2 long CJK input is not charged byte-for-byte against TPM", () => {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: "Extract only explicit facts." }] },
    contents: [{ parts: [{ text: "あ".repeat(8603) }] }],
    generationConfig: { maxOutputTokens: 512 },
  });
  const bytes = new TextEncoder().encode(body).length;
  const estimated = estimateInputTokens(body);
  const tpm = rulesFor(
    config["google-gemma"].quotas,
    estimated,
    512,
    false,
    true,
    Date.now(),
  ).find((rule) => rule.dimension === "tpm")!;
  strictEqual(tpm.limit, 16000);
  strictEqual(tpm.cost, estimated);
  strictEqual(tpm.cost < tpm.limit, true);
  strictEqual(bytes + 128 > tpm.limit, true);
});

Deno.test("Gemma Stage 2 63,100-token request is denied as one input-only TPM reservation", async () => {
  const makeRequestBody = (body: string) =>
    JSON.stringify({
      systemInstruction: {
        parts: [{ text: "Extract only concrete facts explicitly stated." }],
      },
      contents: [{
        parts: [{
          text: JSON.stringify([{
            index: 0,
            title: "fixture title",
            description: null,
            body,
          }]),
        }],
      }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: "MINIMAL" },
        temperature: 0.8,
        maxOutputTokens: 512,
      },
    });
  let low = 0;
  let high = 300_000;
  let requestBody = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = makeRequestBody("x".repeat(middle));
    const estimate = estimateInputTokens(candidate);
    if (estimate === 63100) {
      requestBody = candidate;
      break;
    }
    if (estimate < 63100) low = middle + 1;
    else high = middle - 1;
  }
  strictEqual(requestBody.length > 0, true);
  strictEqual(estimateInputTokens(requestBody), 63100);
  strictEqual(JSON.parse(requestBody).generationConfig.maxOutputTokens, 512);

  const redis = new MemoryQuotaRedis(config);
  let providerCalls = 0;
  try {
    const guarded = quotaFetch(
      GOOGLE_GEMMA,
      "facts",
      redis,
      async () => {
        providerCalls++;
        return Response.json({});
      },
    );
    try {
      await guarded("https://gemini.mock", {
        method: "POST",
        body: requestBody,
      });
      throw new Error("expected internal quota denial");
    } catch (error) {
      const quotaError = error as QuotaReservationError;
      strictEqual(quotaError.code, "quota_limit");
      strictEqual(quotaError.diagnostic?.dimension, "tpm");
      strictEqual(quotaError.diagnostic?.window, "60s rolling");
      strictEqual(quotaError.diagnostic?.limit, 16000);
      strictEqual(quotaError.diagnostic?.used, 0);
      strictEqual(quotaError.diagnostic?.requested, 63100);
      strictEqual(quotaError.diagnostic?.reserved, 0);
      strictEqual(quotaError.diagnostic?.nextAvailableAt, null);
    }
    strictEqual(providerCalls, 0);
  } finally {
    redis.close();
  }
});

Deno.test("Qwen OTPM reserves the completion cap atomically and keeps 429 cooldown", async () => {
  const qwenQuota = config["qwen/qwen3.8-27b"].quotas;
  const outputRule = rulesFor(
    qwenQuota,
    100,
    512,
    false,
    false,
    Date.now(),
  ).find((rule) => rule.key.endsWith(":otpm"))!;
  strictEqual(outputRule.limit, 1000);
  strictEqual(outputRule.cost, 512);

  const concurrentRedis = new MemoryQuotaRedis(config);
  try {
    let sent = 0;
    const guarded = quotaFetch(
      "groq-stage1",
      "facts",
      concurrentRedis,
      async () => {
        sent++;
        return Response.json({ ok: true });
      },
    );
    const request = () =>
      guarded("https://groq.mock/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "qwen/qwen3.8-27b",
          max_completion_tokens: 512,
          reasoning_effort: "none",
        }),
      });
    const results = await Promise.allSettled([request(), request()]);
    strictEqual(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    strictEqual(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    strictEqual(sent, 1);
  } finally {
    concurrentRedis.close();
  }

  const cooldownRedis = new MemoryQuotaRedis(config);
  try {
    let sent = 0;
    const guarded = quotaFetch(
      "groq-stage1",
      "facts",
      cooldownRedis,
      async () => {
        sent++;
        return new Response("{}", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      },
    );
    const request = () =>
      guarded("https://groq.mock/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "qwen/qwen3.8-27b",
          max_completion_tokens: 512,
        }),
      });
    strictEqual((await request()).status, 429);
    await rejects(request, /quota_unavailable/);
    strictEqual(sent, 1);
  } finally {
    cooldownRedis.close();
  }
});

Deno.test("proposal reserves Google Facts headroom and preserves provider shared scopes", async () => {
  const redis = new MemoryQuotaRedis(config);
  try {
    await redis.factsPending("proposal-facts", true);
    strictEqual(await redis.reserve("google-gemma", 1000, 100), false);
    strictEqual(await redis.reserve("google-gemma", 1000, 100, "facts"), true);
    await redis.factsPending("proposal-facts", false);

    const cfRules = rulesFor(
      config["cloudflare-gemma"].quotas,
      1_000_000,
      1_000_000,
      true,
      false,
      Date.parse("2026-09-27T12:00:00Z"),
    );
    const neurons = cfRules.find((rule) => rule.key.includes(":neurons:"))!;
    strictEqual(neurons.key.includes("cloudflare-workers-ai-neurons"), true);
    strictEqual(neurons.cost, 36364);
    strictEqual(await redis.reserve("cloudflare-gemma", 1_000_000, 0), true);
    strictEqual(await redis.reserve("cloudflare-gemma", 100_000, 0), false);

    const openRouterDaily = rulesFor(
      config["openrouter-nemotron"].quotas,
      1,
      1,
      true,
      false,
      Date.parse("2026-09-27T12:00:00Z"),
    ).find((rule) => rule.key.includes(":rpd"))!;
    await redis.command([
      "ZADD",
      openRouterDaily.key,
      Date.now(),
      JSON.stringify({ id: "existing-free-model-usage", cost: 49 }),
    ]);
    strictEqual(await redis.reserve("openrouter-nemotron", 1, 1), true);
    strictEqual(await redis.reserve("openrouter-nemotron", 1, 1), false);

    const env = (name: string) =>
      name.endsWith("_KEY") || name.includes("CLOUDFLARE")
        ? "mock-configured"
        : undefined;
    for (const model of routerModels) {
      strictEqual(
        providerAvailable(
          model,
          new AiRateLimiter(config, fetch, env),
        ),
        true,
      );
    }
  } finally {
    redis.close();
  }
});

Deno.test("proposal remains fail closed on malformed config and Redis outage", async () => {
  deepStrictEqual(quotaConfig(() => "{invalid"), {});
  let providerCalls = 0;
  const offline = new AiRateLimiter(config, async () => {
    throw Error("offline");
  }, () => "mock-configured");
  strictEqual(await offline.reserve("google-gemma", 100, 100, "facts"), false);
  const guarded = quotaFetch("google-gemma", "facts", offline, async () => {
    providerCalls++;
    return Response.json({});
  });
  await rejects(() => guarded("https://example.invalid", { body: "{}" }));
  strictEqual(providerCalls, 0);

  const throttled = new MemoryQuotaRedis(config);
  try {
    await throttled.cooldown(
      "openrouter-nemotron",
      Response.json({}, { status: 429, headers: { "retry-after": "120" } }),
    );
    strictEqual(await throttled.reserve("openrouter-nemotron", 1, 1), false);
  } finally {
    throttled.close();
  }
});
