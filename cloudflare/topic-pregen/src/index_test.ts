import { strictEqual } from "node:assert";
import worker, {
  nextAttemptTime,
  retryAtFor429,
  sanitizeProviderErrorMessage,
  TopicPregenCoordinator,
} from "./index.ts";

Deno.test("the 60 second sliding window never schedules before its first attempt expires", () => {
  const starts = Array.from({ length: 10 }, (_, i) => 100_000 - i * 1_000).sort(
    (a, b) => a - b,
  );
  strictEqual(
    nextAttemptTime(starts, 100_000, null, () => 0),
    starts[0] + 60_000,
  );
});

Deno.test("429 retry-after is respected without immediate retry", () => {
  const at = nextAttemptTime([10_000], 10_100, 70_000, () => 0);
  strictEqual(at, 70_000);
  strictEqual(at > 10_100, true);
});

Deno.test("429 Google RetryInfo is honored when the header is absent", async () => {
  const response = Response.json({
    error: {
      details: [{
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        retryDelay: "12.5s",
      }],
    },
  }, { status: 429 });
  strictEqual(await retryAtFor429(response, 10_000), 22_500);
});

Deno.test("provider diagnostics redact secrets and request content and cap message length", () => {
  const safe = sanitizeProviderErrorMessage(
    `Invalid request: title and fact; key=AIza12345678901234567890 Bearer abc123 ${
      "x".repeat(500)
    }`,
    ["title", "fact"],
  );
  strictEqual(safe?.includes("title"), false);
  strictEqual(safe?.includes("fact"), false);
  strictEqual(safe?.includes("AIza"), false);
  strictEqual(safe?.includes("abc123"), false);
  strictEqual(safe?.length, 400);
  strictEqual(
    sanitizeProviderErrorMessage(
      "Invalid request: private article excerpt",
      ["This is a private article excerpt that must remain hidden"],
    ),
    "Provider error message omitted because it contained request content.",
  );
});

Deno.test("notification authentication failure never calls the Durable Object", async () => {
  let calls = 0;
  const response = await worker.fetch(
    new Request("https://worker.invalid", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: "{}",
    }),
    {
      NOTIFICATION_SECRET: "correct",
      TOPIC_PREGEN: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => {
            calls++;
            return new Response();
          },
        }),
      },
    } as never,
  );
  strictEqual(response.status, 401);
  strictEqual(calls, 0);
});

Deno.test("invalid notifications do not invoke the Durable Object", async () => {
  let calls = 0;
  const response = await worker.fetch(
    new Request("https://worker.invalid", {
      method: "POST",
      headers: { Authorization: "Bearer correct" },
      body: JSON.stringify({
        topic_id: "not-a-uuid",
        title: "title",
        facts: ["f"],
      }),
    }),
    {
      NOTIFICATION_SECRET: "correct",
      TOPIC_PREGEN: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => {
            calls++;
            return new Response();
          },
        }),
      },
    } as never,
  );
  strictEqual(response.status, 400);
  strictEqual(calls, 0);
});

Deno.test("status endpoint requires auth and returns only sanitized singleton status", async () => {
  let calls = 0;
  const env = {
    TOPIC_PREGEN_DIAGNOSTIC_SECRET: "secret-value",
    TOPIC_PREGEN: {
      idFromName: () => "id",
      get: () => ({
        fetch: async () => {
          calls++;
          return Response.json({
            topic_id: "topic-id",
            generation: 1,
            attempts: 2,
            status: "retry_wait",
            alarm_scheduled: true,
            last_http_status: 400,
            provider_http_status: 200,
            save_http_status: 503,
            last_diagnostic_phase: "save",
            sse_read_completed: true,
            sse_completion_confirmed: false,
            sse_end_marker_seen: false,
            model_finish_reason: null,
            comment_count: 10,
            comment_validation_reason: null,
            last_error_message: "Unsupported generation setting",
          });
        },
      }),
    },
  };
  const denied = await worker.fetch(
    new Request("https://worker.invalid/internal/status"),
    env as never,
  );
  strictEqual(denied.status, 401);
  strictEqual(calls, 0);
  const allowed = await worker.fetch(
    new Request("https://worker.invalid/internal/status", {
      headers: { Authorization: "Bearer secret-value" },
    }),
    env as never,
  );
  const body = await allowed.json();
  strictEqual(allowed.status, 200);
  strictEqual(body.attempts, 2);
  strictEqual(body.last_http_status, 400);
  strictEqual(body.provider_http_status, 200);
  strictEqual(body.save_http_status, 503);
  strictEqual(body.last_diagnostic_phase, "save");
  strictEqual(body.sse_completion_confirmed, false);
  strictEqual(body.comment_count, 10);
  strictEqual(body.last_error_message, "Unsupported generation setting");
  strictEqual(JSON.stringify(body).includes("secret-value"), false);
  strictEqual(JSON.stringify(body).includes("GEMINI_API_KEY"), false);
});

Deno.test("diagnostic replay endpoint requires its dedicated auth secret", async () => {
  let calls = 0;
  const env = {
    TOPIC_PREGEN_DIAGNOSTIC_SECRET: "diagnostic-secret",
    TOPIC_PREGEN: {
      idFromName: () => "id",
      get: () => ({
        fetch: async () => {
          calls++;
          return Response.json({ accepted: true });
        },
      }),
    },
  };
  const denied = await worker.fetch(
    new Request("https://worker.invalid/internal/retry", { method: "POST" }),
    env as never,
  );
  strictEqual(denied.status, 401);
  strictEqual(calls, 0);
  const allowed = await worker.fetch(
    new Request("https://worker.invalid/internal/retry", {
      method: "POST",
      headers: { Authorization: "Bearer diagnostic-secret" },
    }),
    env as never,
  );
  strictEqual(allowed.status, 200);
  strictEqual(calls, 1);
});

class FakeStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.values.set(key, value);
  }
  async setAlarm(time: number | Date) {
    this.alarm = Number(time);
  }
  async getAlarm() {
    return this.alarm;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}
const targetRequest = (topicId: string) =>
  new Request("https://coordinator/target", {
    method: "POST",
    body: JSON.stringify({
      topic_id: topicId,
      title: `Title ${topicId}`,
      facts: ["fact"],
    }),
  });
const fakeEnv = {
  GEMINI_API_KEY: "test-key",
  SUPABASE_URL: "https://supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
};

Deno.test("a newer Topic replaces the old target", async () => {
  const storage = new FakeStorage();
  const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id = body.p_topic_id as string;
    const generation = id.endsWith("b") ? 2 : 1;
    return Response.json([{
      generation,
      topic_id: id,
      title: `Title ${id}`,
      facts: ["fact"],
      news_url: `https://news.invalid/${id}`,
    }]);
  }) as typeof fetch;
  try {
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000a"),
    );
    const blockedUntil = Date.now() + 20_000;
    const priorState = storage.values.get("state") as {
      retryNotBefore: number;
    };
    priorState.retryNotBefore = blockedUntil;
    storage.values.set("state", priorState);
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000b"),
    );
    const saved = storage.values.get("state") as {
      target: { topicId: string };
    };
    strictEqual(saved.target.topicId, "00000000-0000-0000-0000-00000000000b");
    strictEqual(storage.alarm! >= blockedUntil, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("missing Google API key fails visibly without calling a provider", async () => {
  const storage = new FakeStorage();
  const coordinator = new TopicPregenCoordinator(
    { storage },
    { ...fakeEnv, GEMINI_API_KEY: "" } as never,
  );
  const original = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("register_topic_pregen_target")) {
      return Response.json([{
        generation: 1,
        topic_id: "00000000-0000-0000-0000-00000000000a",
        title: "title",
        facts: ["fact"],
        news_url: "https://news.invalid/a",
      }]);
    }
    providerCalls++;
    return Response.json({});
  }) as typeof fetch;
  try {
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000a"),
    );
    storage.alarm = null;
    await coordinator.alarm();
    const state = storage.values.get("state") as {
      status: string;
      lastErrorType: string | null;
      completedGeneration: number;
      attemptCount: number;
    };
    strictEqual(providerCalls, 0);
    strictEqual(state.status, "failed");
    strictEqual(state.lastErrorType, "missing_api_key");
    strictEqual(state.completedGeneration, 1);
    strictEqual(state.attemptCount, 0);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("the legacy completed target can be replayed once at the same generation", async () => {
  const storage = new FakeStorage();
  storage.values.set("state", {
    target: {
      generation: 1,
      topicId: "topic",
      title: "title",
      facts: ["fact"],
      newsUrl: "url",
    },
    attemptStarts: [],
    cooldownUntil: 0,
    retryNotBefore: 0,
    completedGeneration: 1,
  });
  const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
  const request = () =>
    coordinator.fetch(
      new Request("https://coordinator/retry", { method: "POST" }),
    );
  const first = await request();
  strictEqual(first.status, 200);
  strictEqual((await first.json()).generation, 1);
  strictEqual(storage.alarm !== null, true);
  const second = await request();
  strictEqual(second.status, 409);
});

Deno.test("503 schedules a delayed retry without another Supabase request", async () => {
  const storage = new FakeStorage();
  const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
  const original = globalThis.fetch;
  let supabaseCalls = 0, googleCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("supabase.invalid")) {
      supabaseCalls++;
      return Response.json([{
        generation: 1,
        topic_id: "00000000-0000-0000-0000-00000000000a",
        title: "title",
        facts: ["fact"],
        news_url: "https://news.invalid/a",
      }]);
    }
    googleCalls++;
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  try {
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000a"),
    );
    const started = Date.now();
    await coordinator.alarm();
    const saved = storage.values.get("state") as { attemptStarts: number[] };
    strictEqual(supabaseCalls, 1);
    strictEqual(googleCalls, 1);
    strictEqual(saved.attemptStarts.length, 1);
    strictEqual(storage.alarm! >= started + 500, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("ten attempts in a rolling minute prevent an eleventh provider call", async () => {
  const storage = new FakeStorage();
  const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
  const original = globalThis.fetch;
  let googleCalls = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("supabase.invalid")) {
      return Response.json([{
        generation: 1,
        topic_id: "00000000-0000-0000-0000-00000000000a",
        title: "title",
        facts: ["fact"],
        news_url: "https://news.invalid/a",
      }]);
    }
    googleCalls++;
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  try {
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000a"),
    );
    const now = Date.now();
    storage.values.set("state", {
      target: {
        generation: 1,
        topicId: "00000000-0000-0000-0000-00000000000a",
        title: "title",
        facts: ["fact"],
        newsUrl: "https://news.invalid/a",
      },
      attemptStarts: Array.from({ length: 10 }, (_, i) => now - i * 1_000),
      cooldownUntil: 0,
      retryNotBefore: 0,
      completedGeneration: 0,
    });
    await coordinator.alarm();
    strictEqual(googleCalls, 0);
    strictEqual(storage.alarm! >= now + 51_000, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a permanent 400 response completes the target without retry", async () => {
  const storage = new FakeStorage();
  const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
  const original = globalThis.fetch;
  let googleCalls = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("supabase.invalid")) {
      return Response.json([{
        generation: 1,
        topic_id: "00000000-0000-0000-0000-00000000000a",
        title: "title",
        facts: ["fact"],
        news_url: "https://news.invalid/a",
      }]);
    }
    googleCalls++;
    return Response.json({
      error: {
        message:
          "Invalid request for title; fact; key=AIza12345678901234567890 Bearer secret-token",
      },
      debug_body: "must-not-be-stored",
    }, { status: 400 });
  }) as typeof fetch;
  try {
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000a"),
    );
    storage.alarm = null;
    await coordinator.alarm();
    const state = storage.values.get("state") as {
      completedGeneration: number;
      lastHttpStatus: number | null;
      lastErrorMessage: string | null;
      lastErrorType: string | null;
    };
    strictEqual(googleCalls, 1);
    strictEqual(state.completedGeneration, 1);
    strictEqual(state.lastHttpStatus, 400);
    strictEqual(state.lastErrorType, "http_error");
    strictEqual(state.lastErrorMessage?.includes("title"), false);
    strictEqual(state.lastErrorMessage?.includes("fact"), false);
    strictEqual(state.lastErrorMessage?.includes("AIza"), false);
    strictEqual(state.lastErrorMessage?.includes("secret-token"), false);
    strictEqual(JSON.stringify(state).includes("must-not-be-stored"), false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("generation success starts the 60 second cooldown and writes one shared chunk", async () => {
  const storage = new FakeStorage();
  const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
  const original = globalThis.fetch;
  let googleCalls = 0, saveCalls = 0;
  const replies = JSON.stringify(
    Array.from({ length: 10 }, (_, i) => `reply-${i}`),
  );
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("register_topic_pregen_target")) {
      return Response.json([{
        generation: 1,
        topic_id: "00000000-0000-0000-0000-00000000000a",
        title: "title",
        facts: ["fact"],
        news_url: "https://news.invalid/a",
      }]);
    }
    if (url.includes("save_topic_pregen_chunk")) {
      saveCalls++;
      return Response.json(true);
    }
    googleCalls++;
    const frame = `data: ${
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: replies }] } }],
      })
    }\n\n`;
    return new Response(frame, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000a"),
    );
    const started = Date.now();
    await coordinator.alarm();
    const saved = storage.values.get("state") as {
      cooldownUntil: number;
      completedGeneration: number;
      lastHttpStatus: number | null;
      lastSseReadCompleted: boolean | null;
      lastSseCompletionConfirmed: boolean | null;
      lastModelFinishReason: string | null;
      lastCommentCount: number | null;
    };
    strictEqual(googleCalls, 1);
    strictEqual(saveCalls, 1);
    strictEqual(saved.completedGeneration, 1);
    strictEqual(saved.lastHttpStatus, 200);
    strictEqual(saved.lastSseReadCompleted, true);
    strictEqual(saved.lastSseCompletionConfirmed, false);
    strictEqual(saved.lastModelFinishReason, null);
    strictEqual(saved.lastCommentCount, 10);
    strictEqual((saved as { saveSucceeded?: boolean }).saveSucceeded, true);
    strictEqual(saved.cooldownUntil >= started + 60_000, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("parser failures retain the successful provider HTTP status without saving", async () => {
  const storage = new FakeStorage();
  const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
  const original = globalThis.fetch;
  let saveCalls = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("register_topic_pregen_target")) {
      return Response.json([{
        generation: 1,
        topic_id: "00000000-0000-0000-0000-00000000000a",
        title: "title",
        facts: ["fact"],
        news_url: "https://news.invalid/a",
      }]);
    }
    if (url.includes("save_topic_pregen_chunk")) {
      saveCalls++;
      return Response.json(true);
    }
    return new Response('data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"not-json"}]}}]}' + "\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000a"),
    );
    storage.alarm = null;
    await coordinator.alarm();
    const state = storage.values.get("state") as {
      status: string;
      lastHttpStatus: number | null;
      lastErrorType: string | null;
      lastDiagnosticPhase: string | null;
      lastSseReadCompleted: boolean | null;
      lastSseCompletionConfirmed: boolean | null;
      lastModelFinishReason: string | null;
      parserSucceeded: boolean | null;
      saveAttempted: boolean;
      completedGeneration: number;
    };
    strictEqual(state.status, "failed");
    strictEqual(state.lastHttpStatus, 200);
    strictEqual(state.lastErrorType, "json_parse_failed");
    strictEqual(state.lastDiagnosticPhase, "json_parse");
    strictEqual(state.lastSseReadCompleted, true);
    strictEqual(state.lastSseCompletionConfirmed, true);
    strictEqual(state.lastModelFinishReason, "STOP");
    strictEqual(state.parserSucceeded, false);
    strictEqual(state.saveAttempted, false);
    strictEqual(state.completedGeneration, 1);
    strictEqual(saveCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("SSE read failure and comment count are distinguished without changing validation", async () => {
  const run = async (response: Response) => {
    const storage = new FakeStorage();
    const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
    const original = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("register_topic_pregen_target")) {
        return Response.json([{
          generation: 1,
          topic_id: "00000000-0000-0000-0000-00000000000a",
          title: "title",
          facts: ["fact"],
          news_url: "https://news.invalid/a",
        }]);
      }
      return response;
    }) as typeof fetch;
    try {
      await coordinator.fetch(targetRequest("00000000-0000-0000-0000-00000000000a"));
      storage.alarm = null;
      await coordinator.alarm();
      return storage.values.get("state") as {
        lastErrorType: string | null;
        lastDiagnosticPhase: string | null;
        lastSseReadCompleted: boolean | null;
        lastSseCompletionConfirmed: boolean | null;
        lastCommentCount: number | null;
      };
    } finally {
      globalThis.fetch = original;
    }
  };

  const brokenBody = new Response(new ReadableStream({
    start(controller) { controller.error(new Error("transport closed")); },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const readFailure = await run(brokenBody);
  strictEqual(readFailure.lastErrorType, "sse_read_failed");
  strictEqual(readFailure.lastDiagnosticPhase, "sse_read");
  strictEqual(readFailure.lastSseReadCompleted, false);
  strictEqual(readFailure.lastSseCompletionConfirmed, false);

  const nineReplies = JSON.stringify(Array.from({ length: 9 }, (_, i) => `reply-${i}`));
  const countFailure = await run(new Response(`data: ${JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: nineReplies }] } }],
  })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
  strictEqual(countFailure.lastErrorType, "comment_count_too_few");
  strictEqual(countFailure.lastDiagnosticPhase, "comment_count");
  strictEqual(countFailure.lastCommentCount, 9);
});

Deno.test("atomic save failure remains visible and schedules a bounded retry", async () => {
  const storage = new FakeStorage();
  const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("register_topic_pregen_target")) {
      return Response.json([{
        generation: 1,
        topic_id: "00000000-0000-0000-0000-00000000000a",
        title: "title",
        facts: ["fact"],
        news_url: "https://news.invalid/a",
      }]);
    }
    if (url.includes("save_topic_pregen_chunk")) {
      throw Object.assign(new Error("save unavailable"), { httpStatus: 503 });
    }
    const frame = `data: ${
      JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify(
                Array.from({ length: 10 }, (_, i) => `reply-${i}`),
              ),
            }],
          },
        }],
      })
    }\n\n`;
    return new Response(frame, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000a"),
    );
    await coordinator.alarm();
    const saved = storage.values.get("state") as {
      status: string;
      saveAttempted: boolean;
      saveSucceeded: boolean | null;
      completedGeneration: number;
      lastErrorType: string | null;
      lastHttpStatus: number | null;
      lastProviderHttpStatus: number | null;
      lastSaveHttpStatus: number | null;
    };
    strictEqual(saved.status, "retry_wait");
    strictEqual(saved.saveAttempted, true);
    strictEqual(saved.saveSucceeded, null);
    strictEqual(saved.completedGeneration, 0);
    strictEqual(saved.lastErrorType, "atomic_save_error");
    strictEqual(saved.lastHttpStatus, 503);
    strictEqual(saved.lastProviderHttpStatus, 200);
    strictEqual(saved.lastSaveHttpStatus, 503);
    strictEqual(storage.alarm !== null, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("permanent atomic save HTTP failures stop without another alarm", async () => {
  const storage = new FakeStorage();
  const coordinator = new TopicPregenCoordinator({ storage }, fakeEnv as never);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("register_topic_pregen_target")) {
      return Response.json([{
        generation: 1,
        topic_id: "00000000-0000-0000-0000-00000000000a",
        title: "title",
        facts: ["fact"],
        news_url: "https://news.invalid/a",
      }]);
    }
    if (url.includes("save_topic_pregen_chunk")) {
      return new Response("", { status: 403 });
    }
    const text = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => `reply-${i}`),
    );
    return new Response(
      `data: ${
        JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })
      }\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }) as typeof fetch;
  try {
    await coordinator.fetch(
      targetRequest("00000000-0000-0000-0000-00000000000a"),
    );
    storage.alarm = null;
    await coordinator.alarm();
    const saved = storage.values.get("state") as {
      status: string;
      lastHttpStatus: number | null;
      lastErrorType: string | null;
      completedGeneration: number;
    };
    strictEqual(saved.status, "failed");
    strictEqual(saved.lastHttpStatus, 403);
    strictEqual(saved.lastErrorType, "atomic_save_http_error");
    strictEqual(saved.completedGeneration, 1);
    strictEqual(storage.alarm, null);
  } finally {
    globalThis.fetch = original;
  }
});
