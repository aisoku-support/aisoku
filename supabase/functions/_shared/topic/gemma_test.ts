import { rejects, strictEqual } from "node:assert";
import {
  classifyWithGemma,
  decideStage2Retry,
  generateFactsWithGemma,
  generateThreadTitle,
  stage2RateLimitAvailableAt,
} from "./gemma.ts";
import {
  AiRateLimiter,
  estimateInputTokens,
  GOOGLE_GEMMA,
  type QuotaConfig,
  quotaFetch,
  QuotaReservationError,
} from "../ai_rate_limit.ts";
import { MemoryQuotaRedis } from "../ai_rate_limit_test_helpers.ts";
import { topicConfig } from "./config.ts";
import { TOPIC_CATEGORIES } from "./gemma_parser.ts";
import type { TopicArticle } from "./types.ts";

const article: TopicArticle = {
  article_id: "article-1",
  title: "source title",
  description: null,
  url: "https://example.com/article",
  normalized_url: null,
  source_name: null,
  published_at: null,
  newsdata_categories: [],
  app_categories: [],
  fetched_at: null,
};
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
    }),
  );
const sseResponse = (values: unknown[], splitAt?: number) => {
  const source = values.map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("");
  const chunks = splitAt === undefined
    ? [source]
    : [source.slice(0, splitAt), source.slice(splitAt)];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
};
const streamEvent = (text: string, finishReason?: string) => ({
  candidates: [{
    ...(finishReason ? { finishReason } : {}),
    content: { parts: [{ text }] },
  }],
});

const stage2Article = {
  ...article,
  subject: "subject",
  event: "event",
  category: TOPIC_CATEGORIES[0],
};

Deno.test("Gemma Stage 2 retries HTTP 500 once and stops after success", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await generateFactsWithGemma(
    [stage2Article],
    "test-key",
    async () => {
      calls++;
      return calls === 1
        ? Response.json({ error: "temporary" }, { status: 500 })
        : sseResponse([streamEvent("recovered fact", "STOP")]);
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  strictEqual(calls, 2);
  strictEqual(waits.length, 1);
  strictEqual(waits[0], 500);
  strictEqual(result.results[0]?.facts?.[0], "recovered fact");
  strictEqual(result.attempts?.map((x) => x.httpStatus).join(","), "500,200");
});

Deno.test("Gemma Stage 2 retries HTTP 503 at most three times", async () => {
  let calls = 0;
  const waits: number[] = [];
  try {
    await generateFactsWithGemma(
      [stage2Article],
      "test-key",
      async () => {
        calls++;
        return Response.json({ error: "temporary" }, { status: 503 });
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    throw new Error("expected Stage 2 failure");
  } catch (error) {
    const value = error as Error & {
      attempts?: Array<{ httpStatus: number | null }>;
      retryCount?: number;
      httpStatus?: number;
    };
    strictEqual(value.httpStatus, 503);
    strictEqual(value.retryCount, 3);
    strictEqual(value.attempts?.length, 4);
  }
  strictEqual(calls, 4);
  strictEqual(waits.join(","), "500,1000,2000");
});

Deno.test("Gemma Stage 2 honors Retry-After for retryable HTTP failures", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await generateFactsWithGemma(
    [stage2Article],
    "test-key",
    async () => {
      calls++;
      return calls === 1
        ? new Response("temporary", {
          status: 502,
          headers: { "Retry-After": "3" },
        })
        : sseResponse([streamEvent("after wait", "STOP")]);
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  strictEqual(calls, 2);
  strictEqual(waits[0], 3000);
  strictEqual(result.results[0]?.facts?.[0], "after wait");
});

Deno.test("long Stage 2 Retry-After is deferred instead of holding the worker", async () => {
  let calls = 0;
  const waits: number[] = [];
  try {
    await generateFactsWithGemma(
      [stage2Article],
      "test-key",
      async () => {
        calls++;
        return new Response("temporary", {
          status: 500,
          headers: { "Retry-After": "30" },
        });
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    throw new Error("expected deferred retry");
  } catch (error) {
    strictEqual((error as { deferRequired?: boolean }).deferRequired, true);
    strictEqual((error as { requestCount?: number }).requestCount, 1);
  }
  strictEqual(calls, 1);
  strictEqual(waits.length, 0);
});

Deno.test("429 defers using provider and quota availability and caps scheduled requests", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const quotaAt = now + 3 * 60 * 60 * 1000;
  const deferred = decideStage2Retry(
    {
      name: "Error",
      message: "HTTP failure",
      elapsedMs: 0,
      inputLength: 0,
      status: 429,
      httpStatus: 429,
      retryAfterMs: 30_000,
      rateLimitType: "rpm",
      requestCount: 1,
      quotaDiagnostic: {
        reason: "cooldown",
        scope: "gemma",
        nextAvailableAt: quotaAt,
      },
    },
    1,
    now,
  );
  strictEqual(deferred.action, "defer");
  if (deferred.action === "defer") {
    strictEqual(deferred.availableAt, quotaAt);
    strictEqual(deferred.nextRequestCount, 2);
  }
  const capped = decideStage2Retry(
    {
      name: "Error",
      message: "HTTP failure",
      elapsedMs: 0,
      inputLength: 0,
      status: 429,
      requestCount: 1,
    },
    3,
    now,
  );
  strictEqual(capped.action, "fail");
  strictEqual(capped.nextRequestCount, 4);
  const quotaWait = decideStage2Retry(
    {
      name: "Error",
      message: "quota blocked",
      elapsedMs: 0,
      inputLength: 0,
      requestCount: 0,
      attemptCount: 1,
      apiSendState: "blocked_before_send",
      quotaDiagnostic: {
        reason: "cooldown",
        scope: "google-gemma",
        nextAvailableAt: now + 90_000,
      },
    },
    1,
    now,
  );
  strictEqual(quotaWait.action, "defer");
  if (quotaWait.action === "defer") {
    strictEqual(quotaWait.availableAt, now + 90_000);
    strictEqual(quotaWait.nextRequestCount, 2);
  }
  const quotaCapped = decideStage2Retry(
    {
      name: "Error",
      message: "quota blocked",
      elapsedMs: 0,
      inputLength: 0,
      requestCount: 0,
      attemptCount: 1,
      apiSendState: "blocked_before_send",
      quotaDiagnostic: {
        reason: "cooldown",
        scope: "google-gemma",
        nextAvailableAt: now + 90_000,
      },
    },
    3,
    now,
  );
  strictEqual(quotaCapped.action, "fail");
  strictEqual(quotaCapped.nextRequestCount, 4);
  strictEqual(
    stage2RateLimitAvailableAt({ rateLimitType: "unknown" }, now),
    Date.parse("2026-09-30T07:00:00Z"),
  );
});

Deno.test("429 response identifies daily quota and defers to the slower reset", async () => {
  try {
    await generateFactsWithGemma(
      [stage2Article],
      "test-key",
      async () =>
        Response.json({
          error: {
            details: [{
              retryDelay: "45s",
              violations: [{ description: "Requests per day quota exceeded" }],
            }],
          },
        }, { status: 429 }),
      async () => {},
      {
        inspectQuota: async () => ({
          reason: "quota_limit",
          scope: "google-gemma",
          nextAvailableAt: Date.now() + 120_000,
        }),
      },
    );
    throw new Error("expected Stage 2 429");
  } catch (error) {
    const value = error as {
      rateLimitType?: string;
      retryAfterMs?: number;
      quotaDiagnostic?: { nextAvailableAt?: number };
    };
    strictEqual(value.rateLimitType, "rpd");
    strictEqual(value.retryAfterMs, 45_000);
    strictEqual(typeof value.quotaDiagnostic?.nextAvailableAt, "number");
  }
});

Deno.test("Gemma Stage 2 does not retry HTTP 429 or 400-series errors", async () => {
  for (const status of [429, 400, 401, 403]) {
    let calls = 0;
    try {
      await generateFactsWithGemma(
        [stage2Article],
        "test-key",
        async () => {
          calls++;
          return new Response("error", {
            status,
            headers: status === 429 ? { "Retry-After": "30" } : undefined,
          });
        },
        async () => {},
      );
      throw new Error("expected Stage 2 failure");
    } catch (error) {
      const value = error as Error & {
        httpStatus?: number;
        retryAfterMs?: number | null;
        attempts?: unknown[];
      };
      strictEqual(value.httpStatus, status);
      strictEqual(value.attempts?.length, 1);
      if (status === 429) strictEqual(value.retryAfterMs, 30_000);
    }
    strictEqual(calls, 1);
  }
});

Deno.test("Gemma Stage 2 does not retry when quota blocks a retry", async () => {
  let reservations = 0;
  let sends = 0;
  const limiter = {
    env: () => true,
    reserveDecision: async () => {
      reservations++;
      return reservations === 1 ? { failure: null } : {
        failure: "quota_limit",
        diagnostic: {
          reason: "quota_limit",
          scope: "google-gemma",
          nextAvailableAt: Date.now() + 60_000,
        },
      };
    },
  } as unknown as AiRateLimiter;
  const guardedFetch = quotaFetch(
    GOOGLE_GEMMA,
    "facts",
    limiter,
    async () => {
      sends++;
      return Response.json({ error: "temporary" }, { status: 500 });
    },
  );
  try {
    await generateFactsWithGemma(
      [stage2Article],
      "test-key",
      guardedFetch,
      async () => {},
    );
    throw new Error("expected quota stop");
  } catch (error) {
    strictEqual(
      (error as { quotaRetryStopped?: boolean }).quotaRetryStopped,
      true,
    );
    strictEqual((error as { retryCount?: number }).retryCount, 1);
    strictEqual((error as { httpStatus?: number }).httpStatus, 500);
  }
  strictEqual(reservations, 2);
  strictEqual(sends, 1);
});

Deno.test("Stage 2 rejects an SSE EOF without a completion marker", async () => {
  await rejects(() =>
    generateFactsWithGemma(
      [{
        ...article,
        subject: "subject",
        event: "event",
        category: TOPIC_CATEGORIES[0],
      }],
      "test-key",
      async () => sseResponse([streamEvent("partial fact")]),
    ), /stream incomplete/);
});

Deno.test("Gemma classification request has no thread_title", async () => {
  let request: Record<string, any> | null = null;
  const result = await classifyWithGemma(
    [article],
    "test-key",
    async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return response({
        articles: [{
          index: 0,
          subject: "subject",
          event: "event",
          category: TOPIC_CATEGORIES[0],
          facts: ["明示された事実"],
        }],
      });
    },
  );
  const generation = request!.generationConfig;
  strictEqual(
    request!.systemInstruction.parts[0].text.includes("thread_title"),
    false,
  );
  strictEqual(
    "thread_title" in
      generation.responseSchema.properties.articles.items.properties,
    false,
  );
  strictEqual(generation.maxOutputTokens, 512);
  strictEqual(result.results[0].topic_text, "subject | event");
  strictEqual(result.diagnostics.httpStatus, 200);
});

Deno.test("Gemma Stage 2 request excludes subject and event", async () => {
  let request: Record<string, any> | null = null;
  let requestUrl = "";
  await generateFactsWithGemma(
    [{
      ...article,
      subject: "subject",
      event: "event",
      category: TOPIC_CATEGORIES[0],
    }],
    "test-key",
    async (input, init) => {
      requestUrl = String(input);
      request = JSON.parse(String(init?.body));
      return sseResponse([streamEvent("fact", "STOP")]);
    },
  );
  const payload = JSON.parse(request!.contents[0].parts[0].text);
  strictEqual(
    Object.keys(payload[0]).sort().join(","),
    "description,index,title",
  );
  strictEqual(payload[0].body, undefined);
  strictEqual("subject" in payload[0], false);
  strictEqual("event" in payload[0], false);
  strictEqual(request!.generationConfig.temperature, 0.8);
  strictEqual(
    request!.generationConfig.thinkingConfig.thinkingLevel,
    "MINIMAL",
  );
  strictEqual(requestUrl.includes(":streamGenerateContent?alt=sse"), true);
});

Deno.test("Gemma Stage 2 includes cleaned article body in Facts input", async () => {
  let request: Record<string, any> | null = null;
  await generateFactsWithGemma(
    [{
      ...article,
      cleaned_body: "fixture cleaned body",
      subject: "subject",
      event: "event",
      category: TOPIC_CATEGORIES[0],
    }],
    "test-key",
    async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return sseResponse([streamEvent("fixture fact", "STOP")]);
    },
  );
  const payload = JSON.parse(request!.contents[0].parts[0].text);
  strictEqual(payload[0].body, "fixture cleaned body");
});

Deno.test("Gemma Stage 2 keeps an absent description null instead of duplicating the body", async () => {
  let request: Record<string, any> | null = null;
  await generateFactsWithGemma(
    [{
      ...article,
      description: null,
      cleaned_body: "description fallback body",
      subject: "subject",
      event: "event",
      category: TOPIC_CATEGORIES[0],
    }],
    "test-key",
    async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return sseResponse([streamEvent("fixture fact", "STOP")]);
    },
  );
  const payload = JSON.parse(request!.contents[0].parts[0].text);
  strictEqual(payload[0].description, null);
  strictEqual(payload[0].body, "description fallback body");
});

Deno.test("Gemma Stage 2 reconciles a successful reservation to provider usage", async () => {
  const config: QuotaConfig = {
    [GOOGLE_GEMMA]: {
      free: true,
      quotas: [{
        scope: "gemma-facts",
        rpm: 30,
        tpm: 16000,
        rpd: 14400,
        tpd: 100000,
        otpm: 1000,
        day: "rolling",
        inputOnly: true,
      }],
    },
  };
  const redis = new MemoryQuotaRedis(config);
  const tokenCosts = (dimension: string) => {
    const entries = redis.entries()[`ai:v1:gemma-facts:${dimension}`] as
      | Record<string, number>
      | undefined;
    return Object.keys(entries ?? {}).map((member) =>
      (JSON.parse(member) as { cost: number }).cost
    );
  };
  try {
    await generateFactsWithGemma(
      [stage2Article],
      "test-key",
      quotaFetch(GOOGLE_GEMMA, "facts", redis, async () =>
        sseResponse([{
          ...streamEvent("fixture fact", "STOP"),
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 18,
            thoughtsTokenCount: 2,
            totalTokenCount: 31,
          },
        }])),
    );
    strictEqual(tokenCosts("tpm")[0], 11);
    strictEqual(tokenCosts("tpd")[0], 31);
    strictEqual(tokenCosts("otpm")[0], 20);
    strictEqual(tokenCosts("rpm")[0], 1);
  } finally {
    redis.close();
  }
});

Deno.test("Gemma Stage 2 avoids a duplicate-body TPM stop and keeps one article request", async () => {
  const config: QuotaConfig = {
    [GOOGLE_GEMMA]: {
      free: true,
      quotas: [{
        scope: "project-gemma",
        rpm: 30,
        tpm: 16000,
        rpd: 14400,
        day: "PT",
        inputOnly: true,
      }],
    },
  };
  const redis = new MemoryQuotaRedis(config);
  const cleanedBody = "あ".repeat(14000);
  let request: Record<string, any> | null = null;
  let providerCalls = 0;
  try {
    await generateFactsWithGemma(
      [{
        ...article,
        description: null,
        cleaned_body: cleanedBody,
        subject: "subject",
        event: "event",
        category: TOPIC_CATEGORIES[0],
      }],
      "test-key",
      quotaFetch(GOOGLE_GEMMA, "facts", redis, async (_input, init) => {
        providerCalls++;
        request = JSON.parse(String(init?.body));
        return sseResponse([streamEvent("fixture fact", "STOP")]);
      }),
      async () => {},
    );
    const capturedRequest = request!;
    const payload = JSON.parse(capturedRequest.contents[0].parts[0].text);
    strictEqual(payload.length, 1);
    strictEqual(payload[0].description, null);
    strictEqual(payload[0].body, cleanedBody);
    strictEqual(
      capturedRequest.generationConfig.maxOutputTokens,
      topicConfig.gemmaFactsMaxOutputTokens,
    );
    const actualEstimate = estimateInputTokens(JSON.stringify(capturedRequest));
    const priorDuplicatedRequest = {
      ...capturedRequest,
      contents: [{
        parts: [{
          text: JSON.stringify([{
            ...payload[0],
            description: cleanedBody,
          }]),
        }],
      }],
    };
    const duplicatedEstimate = estimateInputTokens(
      JSON.stringify(priorDuplicatedRequest),
    );
    strictEqual(actualEstimate < 16000, true);
    strictEqual(duplicatedEstimate > 16000, true);
    strictEqual(providerCalls, 1);
    const tpmEntries = redis.entries()["ai:v1:project-gemma:tpm"] as Record<
      string,
      number
    >;
    const reserved = Object.keys(tpmEntries).map((member) =>
      (JSON.parse(member) as { cost: number }).cost
    );
    strictEqual(reserved[0], actualEstimate);
  } finally {
    redis.close();
  }
});

Deno.test("Gemma Stage 2 reports quota_limit separately from quota_unavailable", async () => {
  for (const code of ["quota_limit", "quota_unavailable"] as const) {
    try {
      await generateFactsWithGemma(
        [{
          ...article,
          cleaned_body: "fixture body",
          subject: "subject",
          event: "event",
          category: TOPIC_CATEGORIES[0],
        }],
        "test-key",
        async () => {
          throw new QuotaReservationError(
            code,
            code === "quota_limit"
              ? {
                reason: "quota_limit",
                scope: "project-gemma",
                dimension: "tpm",
                window: "60s rolling",
                limit: 16000,
                used: 0,
                requested: 63100,
                reserved: 0,
                nextAvailableAt: null,
              }
              : undefined,
          );
        },
      );
      throw new Error("expected quota reservation failure");
    } catch (error) {
      const attempts = (error as Error & {
        attempts?: Array<{ errorType: string; quotaBlocked: boolean }>;
      }).attempts;
      strictEqual(attempts?.[0]?.errorType, code);
      strictEqual(attempts?.[0]?.quotaBlocked, true);
    }
  }
});

Deno.test("Gemma Stage 2 does not defer quota_unavailable without a reset time", () => {
  const decision = decideStage2Retry(
    {
      name: "QuotaReservationError",
      message: "quota_unavailable",
      elapsedMs: 0,
      inputLength: 0,
      apiSendState: "blocked_before_send",
      requestCount: 0,
      attemptCount: 1,
      attempts: [{
        attemptNo: 1,
        httpStatus: null,
        errorType: "quota_unavailable",
        retryAfterMs: null,
        waitMs: 0,
        quotaBlocked: true,
        rateLimitType: null,
      }],
    },
    0,
    Date.parse("2026-09-29T12:00:00Z"),
  );
  strictEqual(decision.action, "fail");
  if (decision.action === "fail") strictEqual(decision.nextRequestCount, 1);
});

Deno.test("Gemma Stage 2 joins split SSE chunks before parsing", async () => {
  const result = await generateFactsWithGemma(
    [{
      ...article,
      subject: "subject",
      event: "event",
      category: TOPIC_CATEGORIES[0],
    }],
    "test-key",
    async () => sseResponse([streamEvent("fact\nsecond fact", "STOP")], 19),
  );
  strictEqual(result.results[0]?.facts?.[0], "fact");
  strictEqual(result.results[0]?.facts?.[1], "second fact");
  strictEqual(result.diagnostics.apiCompleted, true);
});

Deno.test("Gemma Stage 2 aborts repeated streaming text without partial facts", async () => {
  let aborted = false;
  const repeated = "loop_value_".repeat(20);
  const result = await generateFactsWithGemma(
    [{
      ...article,
      subject: "subject",
      event: "event",
      category: TOPIC_CATEGORIES[0],
    }],
    "test-key",
    async (_input, init) => {
      init?.signal?.addEventListener("abort", () => aborted = true);
      return sseResponse([streamEvent(repeated)]);
    },
  );
  strictEqual(aborted, true);
  strictEqual(result.results.length, 0);
  strictEqual(result.failures[0].errorType, "repetition_loop");
  strictEqual(result.diagnostics.apiCompleted, false);
  strictEqual(result.diagnostics.responseChars, repeated.length);
});

Deno.test("Gemma Stage 2 does not flag normal long streaming text as repetition", async () => {
  const fact =
    "東京都で関係者が新たな事業方針を発表し、今後の対応について説明した。"
      .repeat(4);
  const result = await generateFactsWithGemma(
    [{
      ...article,
      subject: "subject",
      event: "event",
      category: TOPIC_CATEGORIES[0],
    }],
    "test-key",
    async () => sseResponse([streamEvent(fact, "STOP")]),
  );
  strictEqual(result.failures.length, 0);
  strictEqual(result.results[0]?.facts?.[0], fact);
});

Deno.test("Gemma Stage 2 keeps timeout and network errors distinct from repetition", async () => {
  for (
    const error of [
      new DOMException("timed out", "TimeoutError"),
      new Error("network failed"),
    ]
  ) {
    let calls = 0;
    try {
      await generateFactsWithGemma(
        [{
          ...article,
          subject: "subject",
          event: "event",
          category: TOPIC_CATEGORIES[0],
        }],
        "test-key",
        async () => {
          calls++;
          throw error;
        },
      );
      throw new Error("expected request failure");
    } catch (caught) {
      strictEqual(caught, error);
      strictEqual(
        (caught as Error).name === "TimeoutError",
        error instanceof DOMException,
      );
      strictEqual(calls, 1);
    }
  }
});

Deno.test("classification invalid JSON retains bounded response diagnostics", async () => {
  const result = await classifyWithGemma(
    [article],
    "test-key",
    async () =>
      new Response(JSON.stringify({
        candidates: [{
          finishReason: "MAX_TOKENS",
          content: { parts: [{ text: "{unterminated json payload" }] },
        }],
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 128,
          thoughtsTokenCount: 7,
        },
      })),
  );
  strictEqual(result.failures[0].errorType, "invalid_json");
  strictEqual(result.diagnostics.finishReason, "MAX_TOKENS");
  strictEqual(result.diagnostics.apiCompleted, true);
  strictEqual(result.diagnostics.responseChars, 26);
  strictEqual(result.diagnostics.responseTailPreview, null);
  strictEqual(result.diagnostics.outputTokens, 128);
  strictEqual(result.diagnostics.promptTokens, 11);
  strictEqual(result.diagnostics.thinkingTokens, 7);
});

Deno.test("parser invalid JSON keeps STOP distinct from MAX_TOKENS", async () => {
  const result = await classifyWithGemma(
    [article],
    "test-key",
    async () =>
      new Response(JSON.stringify({
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ text: "not json" }] },
        }],
      })),
  );
  strictEqual(result.failures[0].errorType, "invalid_json");
  strictEqual(result.diagnostics.finishReason, "STOP");
  strictEqual(result.diagnostics.apiCompleted, true);
});

Deno.test("thread title does not retry after timeout", async () => {
  let calls = 0;
  const value = await generateThreadTitle(article, "test-key", async () => {
    calls++;
    throw new DOMException("timed out", "TimeoutError");
    return response({ thread_title: "掲示板風タイトル" });
  });
  strictEqual(calls, 1);
  strictEqual(value.status, "timeout");
  strictEqual(value.attempts, 1);
  strictEqual(value.threadTitle, null);
});

Deno.test("thread title diagnostics are bounded and distinguish attempts", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await generateThreadTitle(article, "test-key", async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
  } finally {
    console.log = original;
  }
  strictEqual(lines.length, 1);
  strictEqual(lines[0].includes('"attempt":1'), true);
  strictEqual(lines[0].includes('"attempt":1'), true);
  strictEqual(lines.join(" ").includes("description"), false);
});

Deno.test("invalid JSON diagnostics use escaped bounded preview", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await generateThreadTitle(
      article,
      "test-key",
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{
              content: {
                parts: [{ text: "{\\nsecret-looking" + "x".repeat(300) }],
              },
            }],
          }),
        ),
    );
  } finally {
    console.log = original;
  }
  strictEqual(lines[0].includes('"status":"invalid_json"'), true);
  strictEqual(lines[0].includes('"preview":"'), true);
  strictEqual(lines[0].length < 600, true);
});

Deno.test("thread title does not retry non-timeout errors", async () => {
  let calls = 0;
  const value = await generateThreadTitle(article, "test-key", async () => {
    calls++;
    return new Response("{}", { status: 429 });
  });
  strictEqual(calls, 1);
  strictEqual(value.status, "rate_limit");
  strictEqual(value.attempts, 1);
  strictEqual(value.threadTitle, null);
});

Deno.test("invalid or too-long thread title does not retry and falls back to null", async () => {
  let calls = 0;
  const invalid = await generateThreadTitle(article, "test-key", async () => {
    calls++;
    return response({ thread_title: "x".repeat(48) });
  });
  strictEqual(calls, 1);
  strictEqual(invalid.status, "too_long");
  strictEqual(invalid.threadTitle, null);
  const malformed = await generateThreadTitle(article, "test-key", async () => {
    calls++;
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "not json" }] } }],
      }),
    );
  });
  strictEqual(calls, 2);
  strictEqual(malformed.status, "invalid_json");
  strictEqual(malformed.attempts, 1);
});

Deno.test("thread title timeout failure returns null without retry", async () => {
  let calls = 0;
  const value = await generateThreadTitle(article, "test-key", async () => {
    calls++;
    throw new DOMException("timed out", "TimeoutError");
  });
  strictEqual(calls, 1);
  strictEqual(value.status, "timeout");
  strictEqual(value.attempts, 1);
  strictEqual(value.threadTitle, null);
});
