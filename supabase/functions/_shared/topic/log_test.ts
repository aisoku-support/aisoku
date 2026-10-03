import { deepStrictEqual, strictEqual } from "node:assert";
import {
  safeTransportErrorType,
  saveArticleBodyObservability,
  saveGemmaInvalidJsonDiagnostics,
  saveGemmaLog,
  savePreFilterLog,
  saveStage1AttemptLogs,
  saveStage2AttemptObservability,
  saveStage2FailureObservability,
} from "./log.ts";

Deno.test("article body observability stores only extraction metadata, never body text", async () => {
  const originalFetch = globalThis.fetch;
  let payload: unknown = null;
  globalThis.fetch = async (_input, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(null, { status: 201 });
  };
  try {
    await saveArticleBodyObservability(
      { url: "https://example.invalid", serviceRoleKey: "test-key" },
      "00000000-0000-0000-0000-000000000001",
      "article-1",
      {
        ok: true,
        body: "PRIVATE_BODY_SENTINEL",
        chars: 22,
        redirected: true,
        extractionMethod: "readability",
        durationMs: 812,
        httpStatus: 200,
        diagnostics: {
          domain: "news.invalid",
          finalDomain: "mirror.invalid",
          domParse: "success",
          readabilityFailure: null,
          exceptionType: null,
          retryCount: 1,
        },
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const captured = payload as Array<Record<string, unknown>>;
  strictEqual(captured.length, 1);
  strictEqual(captured[0].operation, "article_body");
  strictEqual(captured[0].status, "success");
  strictEqual(captured[0].article_body_method, "readability");
  strictEqual(captured[0].article_body_chars, 22);
  strictEqual(captured[0].duration_ms, 812);
  strictEqual(captured[0].article_body_redirected, true);
  strictEqual(
    (captured[0].diagnostic_details as Record<string, unknown>).finalDomain,
    "mirror.invalid",
  );
  strictEqual(
    (captured[0].diagnostic_details as Record<string, unknown>).retryCount,
    1,
  );
  strictEqual(
    JSON.stringify(captured).includes("PRIVATE_BODY_SENTINEL"),
    false,
  );
  strictEqual(JSON.stringify(captured).includes("https://"), false);
  strictEqual(JSON.stringify(captured).includes("test-key"), false);
});

Deno.test("Stage 1 quota details and Stage 2 failure details are allowlisted and separate send states", async () => {
  const originalFetch = globalThis.fetch;
  const payloads: Array<Record<string, unknown>[]> = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  };
  try {
    await saveStage1AttemptLogs(
      { url: "https://example.invalid", serviceRoleKey: "test-key" },
      "00000000-0000-0000-0000-000000000001",
      [{
        attemptNo: 1,
        model: "qwen/qwen3.8-27b",
        role: "primary",
        outcome: "failure",
        timeoutRetry: false,
        fallbackReason: null,
        errorType: "quota_limit",
        httpStatus: null,
        durationMs: 0,
        apiSendState: "blocked_before_send",
        quotaDiagnostic: {
          reason: "quota_limit",
          scope: "groq-facts",
          dimension: "rpm",
          window: "60s rolling",
          limit: 20,
          used: 20,
          requested: 1,
          reserved: 0,
          nextAvailableAt: 1790000000000,
        },
        transportErrorType: null,
      }],
    );
    const error = Object.assign(new TypeError("private transport text"), {
      code: "EAI_AGAIN",
    });
    await saveStage2FailureObservability(
      { url: "https://example.invalid", serviceRoleKey: "test-key" },
      "00000000-0000-0000-0000-000000000002",
      3,
      error,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const stage1 = payloads[0][0];
  const stage1Details = stage1.diagnostic_details as Record<string, unknown>;
  strictEqual(stage1.operation, "stage1_attempt");
  strictEqual(stage1Details.provider, "groq");
  strictEqual(stage1Details.apiSendState, "blocked_before_send");
  strictEqual(
    (stage1Details.quota as Record<string, unknown>).dimension,
    "rpm",
  );
  strictEqual((stage1Details.quota as Record<string, unknown>).axis, "rpm");
  strictEqual(
    (stage1Details.quota as Record<string, unknown>).window,
    "60s rolling",
  );
  strictEqual((stage1Details.quota as Record<string, unknown>).limit, 20);
  const stage2 = payloads[1][0];
  const stage2Details = stage2.diagnostic_details as Record<string, unknown>;
  strictEqual(stage2.operation, "stage2_attempt");
  strictEqual(stage2.model, "gemma-4-26b-a4b-it");
  strictEqual(stage2Details.provider, "google");
  strictEqual(stage2Details.apiSendState, "send_attempted_no_response");
  strictEqual(stage2Details.transportErrorType, "dns_resolution_failed");
  strictEqual(stage2Details.affectedArticleCount, 3);
  strictEqual(
    JSON.stringify(payloads).includes("private transport text"),
    false,
  );
  strictEqual(JSON.stringify(payloads).includes("test-key"), false);
});

Deno.test("cooldown quota observation exposes cooldown as its dimension", async () => {
  const originalFetch = globalThis.fetch;
  const payloads: Array<Record<string, unknown>[]> = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  };
  try {
    await saveStage1AttemptLogs(
      { url: "https://example.invalid", serviceRoleKey: "test-key" },
      "00000000-0000-0000-0000-000000000003",
      [{
        attemptNo: 1,
        model: "openai/gpt-oss-20b",
        role: "primary",
        outcome: "failure",
        timeoutRetry: false,
        fallbackReason: null,
        errorType: "quota_limit",
        httpStatus: null,
        durationMs: 0,
        apiSendState: "blocked_before_send",
        quotaDiagnostic: {
          reason: "cooldown",
          scope: "groq-gpt-oss-20b",
          nextAvailableAt: 1790000000000,
        },
      }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const quota = (payloads[0][0].diagnostic_details as Record<string, unknown>)
    .quota as Record<string, unknown>;
  strictEqual(quota.dimension, "cooldown");
  strictEqual(quota.axis, "cooldown");
  strictEqual(quota.scope, "groq-gpt-oss-20b");
});

Deno.test("Stage 2 attempt logs retain recovered errors, retry result, and deferred schedule safely", async () => {
  const originalFetch = globalThis.fetch;
  const payloads: Array<Record<string, unknown>[]> = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  };
  try {
    await saveStage2AttemptObservability(
      { url: "https://example.invalid", serviceRoleKey: "test-key" },
      "batch-1",
      "article-1",
      [
        {
          attemptNo: 1,
          httpStatus: 500,
          errorType: "http_500",
          retryAfterMs: null,
          waitMs: 500,
          quotaBlocked: false,
        },
        {
          attemptNo: 2,
          httpStatus: 200,
          errorType: null,
          retryAfterMs: null,
          waitMs: 0,
          quotaBlocked: false,
        },
      ],
      { finalResult: "success", retryCount: 1, finalHttpStatus: 200 },
    );
    await saveStage2AttemptObservability(
      { url: "https://example.invalid", serviceRoleKey: "test-key" },
      "batch-2",
      "article-2",
      [{
        attemptNo: 1,
        httpStatus: 429,
        errorType: "http_429",
        retryAfterMs: 45_000,
        waitMs: 0,
        quotaBlocked: false,
        rateLimitType: "rpd",
      }],
      {
        finalResult: "deferred",
        retryCount: 0,
        finalHttpStatus: 429,
        scheduledAt: "2026-09-30T07:00:00.000Z",
        rateLimitType: "rpd",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  strictEqual(payloads[0].length, 2);
  strictEqual(payloads[0][0].status, "failure");
  strictEqual(payloads[0][0].http_status, 500);
  strictEqual(
    (payloads[0][0].diagnostic_details as Record<string, unknown>).finalResult,
    "success",
  );
  strictEqual(
    (payloads[0][0].diagnostic_details as Record<string, unknown>).retryCount,
    1,
  );
  strictEqual(payloads[0][1].status, "success");
  const deferredDetails = payloads[1][0].diagnostic_details as Record<
    string,
    unknown
  >;
  strictEqual(deferredDetails.finalResult, "deferred");
  strictEqual(deferredDetails.scheduledAt, "2026-09-30T07:00:00.000Z");
  strictEqual(deferredDetails.rateLimitType, "rpd");
  strictEqual(JSON.stringify(payloads).includes("test-key"), false);
  strictEqual(JSON.stringify(payloads).includes("article body"), false);
});

Deno.test("safe transport classification preserves only known network classes", () => {
  strictEqual(
    safeTransportErrorType(new DOMException("timeout", "TimeoutError")),
    "timeout",
  );
  strictEqual(
    safeTransportErrorType(
      Object.assign(new TypeError("network"), { code: "ENOTFOUND" }),
    ),
    "dns_resolution_failed",
  );
  strictEqual(
    safeTransportErrorType(
      Object.assign(new TypeError("network"), { code: "ECONNRESET" }),
    ),
    "connection_interrupted",
  );
  strictEqual(
    safeTransportErrorType(new TypeError("network")),
    "network_error",
  );
  strictEqual(safeTransportErrorType(new Error("unclassified")), null);
});

Deno.test("comment structure exclusion logs only safe counts", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(null, { status: 201 });
  };
  try {
    await savePreFilterLog(
      { url: "https://example.invalid", serviceRoleKey: "test-key" },
      {
        articleId: "article-053",
        batchId: "00000000-0000-0000-0000-000000000001",
        status: "excluded",
        stage: "comment_structure",
        errorType: "repeated_post_headers",
        errorMessage: "repeated_post_headers=82; post_candidates=82",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const captured = body as unknown as Record<string, unknown>;
  strictEqual(captured.status, "excluded");
  strictEqual(captured.stage, "comment_structure");
  strictEqual(captured.error_type, "repeated_post_headers");
  strictEqual(
    captured.error_message,
    "repeated_post_headers=82; post_candidates=82",
  );
});

Deno.test("invalid JSON Gemma diagnostics are persisted as bounded log fields", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(null, { status: 201 });
  };
  try {
    await saveGemmaLog(
      { url: "https://example.invalid", serviceRoleKey: "test-key" },
      {
        articleId: "article-1",
        batchId: "00000000-0000-0000-0000-000000000001",
        status: "failed_gemma",
        errorType: "invalid_json",
        sourceCategory: "technology",
        diagnostics: {
          httpStatus: 200,
          finishReason: "MAX_TOKENS",
          blockReason: null,
          apiCompleted: true,
          responseChars: 301,
          responseTailPreview: "x".repeat(160),
          outputTokens: 128,
          promptTokens: 11,
          thinkingTokens: 7,
          apiDurationMs: 123,
        },
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const captured = body as unknown as Record<string, unknown>;
  strictEqual(captured.error_type, "invalid_json");
  deepStrictEqual(captured.source_category, ["technology"]);
  strictEqual(captured.gemma_http_status, 200);
  strictEqual(captured.gemma_finish_reason, "MAX_TOKENS");
  strictEqual(captured.gemma_api_completed, true);
  strictEqual(captured.gemma_response_chars, 301);
  strictEqual(captured.gemma_response_tail_preview, null);
  strictEqual(captured.gemma_output_tokens, 128);
  strictEqual(captured.gemma_prompt_tokens, 11);
  strictEqual(captured.gemma_thinking_tokens, 7);
  strictEqual(captured.gemma_api_duration_ms, 123);
});

Deno.test("invalid JSON diagnostics update exactly the RPC log row", async () => {
  const originalFetch = globalThis.fetch;
  let url = "";
  let body: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify([{ id: "log-1" }]), { status: 200 });
  };
  try {
    await saveGemmaInvalidJsonDiagnostics(
      { url: "https://example.invalid", serviceRoleKey: "test-key" },
      "article-1",
      "00000000-0000-0000-0000-000000000001",
      {
        httpStatus: 200,
        finishReason: "MAX_TOKENS",
        blockReason: null,
        apiCompleted: true,
        responseChars: 301,
        responseTailPreview: "x".repeat(160),
        outputTokens: 128,
        promptTokens: 11,
        thinkingTokens: 7,
        apiDurationMs: 123,
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  strictEqual(url.includes("status=eq.failed_gemma"), true);
  strictEqual(url.includes("stage=eq.topic_commit"), true);
  strictEqual(url.includes("error_type=eq.invalid_json"), true);
  const captured = body as unknown as Record<string, unknown>;
  strictEqual(captured.gemma_response_chars, 301);
  strictEqual(captured.gemma_output_tokens, 128);
});
