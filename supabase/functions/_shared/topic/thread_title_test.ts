import { deepStrictEqual, strictEqual } from "node:assert";
import { generateThreadTitles, parseRetryAfterMs } from "./thread_title.ts";
import {
  notifySuccessfulTopicTitles,
  processThreadTitleBatch,
  successfulTitleTopicIds,
} from "./thread_title_queue.ts";

Deno.test("only successful title results are sent to notification lookup", () => {
  deepStrictEqual(
    successfulTitleTopicIds([
      { id: "a", status: "success" },
      { id: "b", status: "invalid_title" },
      { id: "c", status: "success" },
    ]),
    ["a", "c"],
  );
});

Deno.test("successful title notification awaits candidate lookup and sends minimal payload", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await notifySuccessfulTopicTitles(
    { url: "https://project.example", serviceRoleKey: "test-service-role" },
    [
      { id: "old-topic", status: "success" },
      { id: "failed-topic", status: "http_5xx" },
      { id: "latest-topic", status: "success" },
    ],
    "https://worker.example/notify",
    "test-notification-secret",
    async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("get_topic_pregen_inputs")) {
        const body = JSON.parse(String(init?.body));
        deepStrictEqual(body.p_topic_ids, ["old-topic", "latest-topic"]);
        return Response.json([{
          topic_id: "latest-topic",
          title: "thread title",
          facts: ["fact"],
          news_url: "https://article.example",
        }]);
      }
      deepStrictEqual(JSON.parse(String(init?.body)), {
        topic_id: "latest-topic",
        title: "thread title",
        facts: ["fact"],
      });
      strictEqual(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-notification-secret",
      );
      return new Response("accepted", { status: 202 });
    },
  );
  deepStrictEqual(result, { status: "notified", httpStatus: 202 });
  strictEqual(calls.length, 2);
});

Deno.test("empty finalize RPC response does not skip the Topic Pregen notification", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = Deno.env.get("TOPIC_PREGEN_URL");
  const originalSecret = Deno.env.get("TOPIC_PREGEN_NOTIFICATION_SECRET");
  const ids = ["topic-1", "topic-2", "topic-3", "topic-4"];
  const calls: string[] = [];
  const batchAudit: Record<string, unknown> = {};
  const finalizePayload: Record<string, unknown> = {};
  Deno.env.set("TOPIC_PREGEN_URL", "https://worker.example/notify");
  Deno.env.set("TOPIC_PREGEN_NOTIFICATION_SECRET", "test-notification-secret");
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("claim_topic_thread_title_batch")) {
      return Response.json(ids.map((id) => ({
        topic_id: id,
        subject: "subject",
        event: "event",
        probe: false,
        quota_day_pt: "2026-09-25",
        used_today: 1,
      })));
    }
    if (url.includes("topic_thread_title_quota_state")) {
      return Response.json([]);
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      return Response.json({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                titles: ids.map((id, i) => ({
                  id,
                  thread_title: i === 0 ? "x".repeat(48) : "valid title",
                })),
              }),
            }],
          },
        }],
      });
    }
    if (url.includes("topic_thread_title_batches")) {
      Object.assign(batchAudit, JSON.parse(String(init?.body)));
      return new Response(null, { status: 201 });
    }
    if (url.includes("finalize_topic_thread_title_batch")) {
      Object.assign(finalizePayload, JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    if (url.includes("get_topic_pregen_inputs")) {
      return Response.json([{
        topic_id: ids[0],
        title: "valid title",
        facts: ["fact"],
        news_url: "https://article.example",
      }]);
    }
    if (url === "https://worker.example/notify") {
      return new Response("accepted", { status: 202 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    strictEqual(
      await processThreadTitleBatch({
        url: "https://project.example",
        serviceRoleKey: "test-service-role",
      }, "test-api-key"),
      true,
    );
    strictEqual(
      calls.some((url) => url.includes("get_topic_pregen_inputs")),
      true,
    );
    strictEqual(calls.includes("https://worker.example/notify"), true);
    strictEqual(
      calls.filter((url) => url.includes("generativelanguage.googleapis.com"))
        .length,
      1,
    );
    strictEqual(batchAudit.model, "gemini-3.5-flash-lite");
    strictEqual(batchAudit.thinking_level, "medium");
    strictEqual(batchAudit.success_count, 4);
    strictEqual(batchAudit.failure_count, 0);
    deepStrictEqual(batchAudit.failure_types, { title_length_exceeded: 1 });
    const finalized = finalizePayload.p_results as Array<
      Record<string, unknown>
    >;
    strictEqual(finalized[0].status, "success");
    strictEqual(finalized[0].title, "x".repeat(48));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) Deno.env.delete("TOPIC_PREGEN_URL");
    else Deno.env.set("TOPIC_PREGEN_URL", originalUrl);
    if (originalSecret === undefined) {
      Deno.env.delete("TOPIC_PREGEN_NOTIFICATION_SECRET");
    } else Deno.env.set("TOPIC_PREGEN_NOTIFICATION_SECRET", originalSecret);
  }
});

Deno.test("no successful thread titles cause no notification request", async () => {
  let calls = 0;
  const result = await notifySuccessfulTopicTitles(
    { url: "https://project.example", serviceRoleKey: "test-service-role" },
    [{ id: "failed-topic", status: "http_5xx" }],
    "https://worker.example/notify",
    "test-notification-secret",
    async () => {
      calls++;
      return new Response("unexpected");
    },
  );
  deepStrictEqual(result, { status: "no_candidate" });
  strictEqual(calls, 0);
});

const input = [1, 2, 3, 4].map((n) => ({
  id: `topic-${n}`,
  subject: `s${n}`,
  event: `e${n}`,
}));
const response = (titles: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [{
        content: { parts: [{ text: JSON.stringify({ titles }) }] },
      }],
    }),
  );

Deno.test("thread title uses one fixed four-Topic request with Gemini structured output", async () => {
  let body: any;
  let url = "";
  const result = await generateThreadTitles(
    input,
    "key",
    async (requestUrl, init) => {
      url = String(requestUrl);
      body = JSON.parse(String(init?.body));
      return response(input.map((x) => ({ id: x.id, thread_title: x.id })));
    },
  );
  strictEqual(result.results.filter((x) => x.status === "success").length, 4);
  strictEqual(
    url.includes("/models/gemini-3.5-flash-lite:generateContent"),
    true,
  );
  strictEqual(body.generationConfig.maxOutputTokens, 8192);
  strictEqual(body.generationConfig.thinkingConfig.thinkingLevel, "medium");
  strictEqual(body.generationConfig.temperature, 0);
  const prompt = body.systemInstruction.parts[0].text as string;
  strictEqual(prompt.startsWith("あなたは5ch風の匿名ニュース掲示板で"), true);
  strictEqual(prompt.includes("47文字以内。"), true);
  strictEqual(prompt.includes("D. ニュースにツッコミを入れる"), true);
  strictEqual(prompt.includes("このニュースで2ch/5chのスレタイ"), false);
  deepStrictEqual(
    Object.keys(JSON.parse(body.contents[0].parts[0].text).topics[0]),
    ["id", "subject", "event"],
  );
});

Deno.test("47文字以内と超過タイトルはどちらも成功として保持し、超過を識別する", async () => {
  let calls = 0;
  const titles = [
    { id: "topic-1", thread_title: "a".repeat(47) },
    { id: "topic-2", thread_title: "b".repeat(48) },
    { id: "topic-3", thread_title: "c".repeat(52) },
    { id: "topic-4", thread_title: "ok" },
  ];
  const result = await generateThreadTitles(input, "key", async () => {
    calls++;
    return response(titles);
  });
  strictEqual(calls, 1);
  deepStrictEqual(result.results.map((x) => x.status), [
    "success",
    "success",
    "success",
    "success",
  ]);
  deepStrictEqual(result.results.map((x) => x.title), [
    "a".repeat(47),
    "b".repeat(48),
    "c".repeat(52),
    "ok",
  ]);
  deepStrictEqual(result.results.map((x) => x.lengthExceeded ?? false), [
    false,
    true,
    true,
    false,
  ]);
});

Deno.test("partial failure is finalized per Topic and no retry classifications are hidden", async () => {
  const result = await generateThreadTitles(input, "key", async () =>
    response([
      { id: "topic-1", thread_title: "ok" },
      { id: "topic-2", thread_title: "" },
      { id: "topic-3", thread_title: "ok" },
      { id: "unknown", thread_title: "bad" },
    ]));
  deepStrictEqual(result.results.map((x) => x.status), [
    "success",
    "empty",
    "success",
    "missing_id",
  ]);
});

for (
  const [name, make, expected] of [
    ["429", () => new Response("{}", { status: 429 }), "rate_limit"],
    ["500", () => new Response("{}", { status: 500 }), "http_5xx"],
    ["401", () => new Response("{}", { status: 401 }), "http_4xx"],
    ["invalid JSON", () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "no" }] } }],
        }),
      ), "invalid_json"],
  ] as const
) {
  Deno.test(`thread title ${name} has no retry`, async () => {
    let calls = 0;
    const result = await generateThreadTitles(input, "key", async () => {
      calls++;
      return make();
    });
    strictEqual(calls, 1);
    strictEqual(result.results[0].status, expected);
  });
}

Deno.test("thread title preserves Retry-After seconds and HTTP dates for 503", async () => {
  const result = await generateThreadTitles(input, "key", async () =>
    new Response("{}", { status: 503, headers: { "Retry-After": "2" } }));
  strictEqual(result.results[0].status, "http_5xx");
  strictEqual(result.httpStatus, 503);
  strictEqual(result.retryAfterMs, 2_000);
  strictEqual(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:12 GMT", 10_000), 2_000);
  strictEqual(parseRetryAfterMs("n/a", 10_000), null);
});

Deno.test("thread title timeout has no retry", async () => {
  let calls = 0;
  const result = await generateThreadTitles(input, "key", async () => {
    calls++;
    throw new DOMException("timeout", "TimeoutError");
  });
  strictEqual(calls, 1);
  strictEqual(result.results[0].status, "timeout");
});

Deno.test("503 retries one time only after quota reservation and records actual attempts", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const sleepCalls: number[] = [];
  const audit: Record<string, unknown> = {};
  const ids = input.map((x) => x.id);
  let generationCalls = 0;
  globalThis.fetch = async (inputUrl, init) => {
    const url = String(inputUrl);
    calls.push(url);
    if (url.includes("claim_topic_thread_title_batch")) {
      return Response.json(ids.map((id) => ({
        topic_id: id,
        subject: "subject",
        event: "event",
        probe: false,
        quota_day_pt: "2026-09-28",
        used_today: 1,
      })));
    }
    if (url.includes("topic_thread_title_quota_state")) return Response.json([]);
    if (url.includes("reserve_topic_thread_title_retry")) {
      return Response.json([{ allowed: true, reason: "reserved", used_today: 2, wait_ms: 0 }]);
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      generationCalls++;
      return generationCalls === 1
        ? new Response("unavailable", { status: 503, headers: { "Retry-After": "0" } })
        : response(ids.map((id) => ({ id, thread_title: `title-${id}` })));
    }
    if (url.includes("topic_thread_title_batches")) {
      Object.assign(audit, JSON.parse(String(init?.body)));
      return new Response(null, { status: 201 });
    }
    if (url.includes("finalize_topic_thread_title_batch")) {
      const payload = JSON.parse(String(init?.body));
      strictEqual(payload.p_http_status, 200);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    strictEqual(await processThreadTitleBatch(
      { url: "https://project.example", serviceRoleKey: "test-service-role" },
      "test-api-key",
      { notifyPregen: false, sleep: async (ms) => { sleepCalls.push(ms); }, random: () => 0 },
    ), true);
    strictEqual(generationCalls, 2);
    strictEqual(audit.attempts, 2);
    strictEqual(audit.http_status, 200);
    strictEqual(audit.used_today_at_request, 2);
    deepStrictEqual(audit.failure_types, { http_503_retries: 1 });
    deepStrictEqual(sleepCalls, [4_100, 4_100]);
    strictEqual(calls.some((url) => url.includes("get_topic_pregen_inputs")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("503 retry stops when the request quota reservation refuses it", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let generationCalls = 0;
  let audit: Record<string, unknown> = {};
  globalThis.fetch = async (inputUrl, init) => {
    const url = String(inputUrl);
    calls.push(url);
    if (url.includes("claim_topic_thread_title_batch")) {
      return Response.json(input.map((x) => ({
        topic_id: x.id,
        subject: "subject",
        event: "event",
        probe: false,
        quota_day_pt: "2026-09-28",
        used_today: 489,
      })));
    }
    if (url.includes("topic_thread_title_quota_state")) return Response.json([]);
    if (url.includes("reserve_topic_thread_title_retry")) {
      return Response.json([{ allowed: false, reason: "quota_limit", used_today: 490, wait_ms: 0 }]);
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      generationCalls++;
      return new Response("unavailable", { status: 503 });
    }
    if (url.includes("topic_thread_title_batches")) {
      audit = JSON.parse(String(init?.body));
      return new Response(null, { status: 201 });
    }
    if (url.includes("finalize_topic_thread_title_batch")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await processThreadTitleBatch(
      { url: "https://project.example", serviceRoleKey: "test-service-role" },
      "test-api-key",
      { notifyPregen: false, sleep: async () => {}, random: () => 0 },
    );
    strictEqual(generationCalls, 1);
    strictEqual(audit.attempts, 1);
    strictEqual((audit.failure_types as Record<string, number>).http_503_quota_limit, 1);
    strictEqual(calls.filter((url) => url.includes("reserve_topic_thread_title_retry")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("503 retry does not exceed the bounded Retry-After delay", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const sleepCalls: number[] = [];
  let audit: Record<string, unknown> = {};
  globalThis.fetch = async (inputUrl, init) => {
    const url = String(inputUrl);
    calls.push(url);
    if (url.includes("claim_topic_thread_title_batch")) {
      return Response.json(input.map((x) => ({
        topic_id: x.id,
        subject: "subject",
        event: "event",
        probe: false,
        quota_day_pt: "2026-09-28",
        used_today: 1,
      })));
    }
    if (url.includes("topic_thread_title_quota_state")) return Response.json([]);
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response("unavailable", {
        status: 503,
        headers: { "Retry-After": "61" },
      });
    }
    if (url.includes("topic_thread_title_batches")) {
      audit = JSON.parse(String(init?.body));
      return new Response(null, { status: 201 });
    }
    if (url.includes("finalize_topic_thread_title_batch")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await processThreadTitleBatch(
      { url: "https://project.example", serviceRoleKey: "test-service-role" },
      "test-api-key",
      { notifyPregen: false, sleep: async (ms) => { sleepCalls.push(ms); } },
    );
    strictEqual(calls.filter((url) => url.includes("generativelanguage.googleapis.com")).length, 1);
    strictEqual(calls.some((url) => url.includes("reserve_topic_thread_title_retry")), false);
    deepStrictEqual(sleepCalls, []);
    strictEqual(audit.attempts, 1);
    strictEqual((audit.failure_types as Record<string, number>).http_503_retry_after_exceeds_budget, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
