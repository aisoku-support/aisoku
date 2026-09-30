import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert";
import {
  generateFreeModel,
  type Model,
  MODEL_ORDER,
  parseTen,
  providerAvailable,
  type RouterDeps,
  RouterStore,
  runSharedRouter,
  UnknownProviderResult,
} from "./shared_router.ts";
import { AiRateLimiter } from "../_shared/ai_rate_limit.ts";

const texts = Array.from({ length: 10 }, (_, i) => `comment ${i}`);
function fixture(
  outcomes: Record<string, { at: number; ok: boolean }>,
  readyAt = Infinity,
  unavailable: string[] = [],
) {
  let now = 0;
  const starts: { model: Model; at: number }[] = [];
  const saves: string[] = [];
  const pending: {
    at: number;
    resolve: (v: string[]) => void;
    reject: () => void;
    ok: boolean;
  }[] = [];
  const deps: RouterDeps = {
    now: () => now,
    pause: async (ms) => {
      now += ms;
      for (const p of pending.filter((p) => p.at <= now)) {
        pending.splice(pending.indexOf(p), 1);
        p.ok ? p.resolve(texts) : p.reject();
      }
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
    ready: async () => now >= readyAt,
    reserve: async (m) => !unavailable.includes(m),
    begin: async () => true,
    generate: (m) => {
      starts.push({ model: m, at: now });
      const o = outcomes[m] ?? { at: now, ok: false };
      if (o.at <= now) {
        return o.ok ? Promise.resolve(texts) : Promise.reject(Error());
      }
      return new Promise((resolve, reject) =>
        pending.push({ ...o, resolve, reject: () => reject(Error()) })
      );
    },
    save: async (id) => {
      saves.push(id);
    },
    fail: async () => {},
  };
  return { deps, starts, saves, pending, advance: deps.pause };
}
Deno.test("initial two start together; save stops further launches and in-flight success is preserved", async () => {
  const f = fixture({
    "groq-120b": { at: 100, ok: true },
    "google-gemma": { at: 200, ok: true },
  });
  const task = runSharedRouter(f.deps);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await f.advance(200);
  await task;
  deepStrictEqual(f.starts, [{ model: "groq-120b", at: 0 }, {
    model: "google-gemma",
    at: 0,
  }]);
  strictEqual(f.saves.length, 2);
});
Deno.test("3 second condition waits for youngest surviving request and all failure advances immediately", async () => {
  const f = fixture({
    "groq-120b": { at: 100, ok: false },
    "google-gemma": { at: 3100, ok: false },
    "cloudflare-gemma": { at: 3500, ok: false },
    "gemini-3.1": { at: 3500, ok: true },
  });
  await runSharedRouter(f.deps);
  deepStrictEqual(f.starts.map((s) => [s.model, s.at]), [
    ["groq-120b", 0],
    ["google-gemma", 0],
    ["cloudflare-gemma", 3000],
    ["gemini-3.1", 3500],
  ]);
});
Deno.test("31B ready prevents extra launch; already sent models still save", async () => {
  const f = fixture({
    "groq-120b": { at: 4000, ok: true },
    "google-gemma": { at: 4000, ok: true },
  }, 1500);
  const task = runSharedRouter(f.deps);
  for (let i = 0; i < 2000; i++) await Promise.resolve();
  await f.advance(4000);
  await task;
  strictEqual(f.starts.length, 2);
  strictEqual(f.saves.length, 2);
});
Deno.test("quota skips, recovery excludes sent models, ready Topic does not reserve", async () => {
  const f = fixture({}, Infinity, ["google-gemma"]);
  await runSharedRouter(f.deps, ["groq-120b"]);
  deepStrictEqual(f.starts.map((s) => s.model), [
    "cloudflare-gemma",
    "gemini-3.1",
    "openrouter-nemotron",
  ]);
  const ready = fixture({}, 0);
  await runSharedRouter(ready.deps);
  strictEqual(ready.starts.length, 0);
});

Deno.test("single-model diagnostic run starts no fallback provider", async () => {
  const f = fixture({ "groq-120b": { at: 0, ok: false } });
  await runSharedRouter({ ...f.deps, models: ["groq-120b"] });
  deepStrictEqual(f.starts.map((start) => start.model), ["groq-120b"]);
});
Deno.test("strict ten parser rejects extra, missing and invalid entries; retains repair behavior", () => {
  deepStrictEqual(parseTen(JSON.stringify(texts)), texts);
  for (
    const bad of [
      texts.slice(1),
      [...texts, "extra"],
      [...texts, 1],
      texts.map((t, i) => i ? t : ""),
    ]
  ) throws(() => parseTen(JSON.stringify(bad)));
  const raw = JSON.stringify(texts).replace("comment 0", "line\nline");
  strictEqual(parseTen(raw)[0], "line\nline");
});
Deno.test("provider adapter uses only fixed free model and honors 429 without retry", async () => {
  const limiter = new AiRateLimiter(
    {
      "openrouter-nemotron": {
        free: true,
        provider: "openrouter",
        quotas: [{
          scope: "test",
          rpm: 20,
          day: "UTC",
        }],
      },
    },
    fetch,
    () => "test",
  );
  let calls = 0;
  let cooled = 0;
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> =
    [];
  limiter.cooldown = async () => {
    cooled++;
  };
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    strictEqual(body.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
    strictEqual(body.provider.allow_fallbacks, false);
    return Response.json({}, {
      status: 429,
      headers: { "retry-after": "23" },
    });
  };
  await rejects(() =>
    generateFreeModel("openrouter-nemotron", "prompt", limiter, fetcher, {
      topicId: "topic-test",
      attemptId: "attempt-test",
    }, (event, fields) => diagnostics.push({ event, fields }))
  );
  strictEqual(calls, 1);
  strictEqual(cooled, 1);
  strictEqual(
    diagnostics.some((d) =>
      d.event === "provider_http_error" && d.fields.http_status === 429 &&
      d.fields.retry_after_seconds === 23 &&
      d.fields.topic_id === "topic-test" &&
      d.fields.attempt_id === "attempt-test"
    ),
    true,
  );
});

Deno.test("provider diagnostics distinguish network and timeout without exception text", async () => {
  const limiter = new AiRateLimiter(
    {
      "openrouter-nemotron": {
        free: true,
        provider: "openrouter",
        quotas: [{ scope: "test", rpm: 20, day: "UTC" }],
      },
    },
    fetch,
    () => "test-key",
  );
  for (
    const [error, expected] of [
      [new TypeError("Authorization: do-not-log"), "network_error"],
      [new DOMException("private detail", "TimeoutError"), "timeout_or_abort"],
    ] as const
  ) {
    const diagnostics: Array<
      { event: string; fields: Record<string, unknown> }
    > = [];
    await rejects(() =>
      generateFreeModel(
        "openrouter-nemotron",
        "private prompt",
        limiter,
        async () => {
          throw error;
        },
        { topicId: "topic-test", attemptId: "attempt-test" },
        (event, fields) => diagnostics.push({ event, fields }),
      ), UnknownProviderResult);
    strictEqual(
      diagnostics.some((d) =>
        d.event === "provider_request_failed" &&
        d.fields.error_class === expected &&
        d.fields.stage === "provider_transport"
      ),
      true,
    );
    strictEqual(JSON.stringify(diagnostics).includes("do-not-log"), false);
    strictEqual(JSON.stringify(diagnostics).includes("private detail"), false);
  }
});

Deno.test("provider diagnostics distinguish response JSON and comment format failures", async () => {
  const limiter = new AiRateLimiter(
    {
      "openrouter-nemotron": {
        free: true,
        provider: "openrouter",
        quotas: [{ scope: "test", rpm: 20, day: "UTC" }],
      },
    },
    fetch,
    () => "test-key",
  );
  for (
    const [response, expected] of [
      [new Response("not-json"), "provider_response_parse_failed"],
      [
        Response.json({
          choices: [{ message: { content: "not-ten-comments" } }],
        }),
        "provider_output_invalid",
      ],
    ] as const
  ) {
    const diagnostics: Array<
      { event: string; fields: Record<string, unknown> }
    > = [];
    await rejects(() =>
      generateFreeModel(
        "openrouter-nemotron",
        "prompt",
        limiter,
        async () => response,
        { topicId: "topic-test", attemptId: "attempt-test" },
        (event, fields) => diagnostics.push({ event, fields }),
      )
    );
    strictEqual(diagnostics.some((d) => d.event === expected), true);
  }
});

Deno.test("provider diagnostics record a pre-request availability failure", async () => {
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> =
    [];
  const limiter = new AiRateLimiter(
    {
      "openrouter-nemotron": {
        free: true,
        provider: "openrouter",
        quotas: [{ scope: "test", rpm: 20, day: "UTC" }],
      },
    },
    fetch,
    () => undefined,
  );
  let calls = 0;
  await rejects(() =>
    generateFreeModel(
      "openrouter-nemotron",
      "prompt",
      limiter,
      async () => {
        calls++;
        return Response.json({});
      },
      { topicId: "topic-test", attemptId: "attempt-test" },
      (event, fields) => diagnostics.push({ event, fields }),
    )
  );
  strictEqual(calls, 0);
  strictEqual(
    diagnostics.some((d) =>
      d.event === "provider_request_skipped" &&
      d.fields.stage === "pre_request_validation" &&
      d.fields.error_class === "provider_unavailable"
    ),
    true,
  );
});

Deno.test("shutdown diagnostics identify in-flight function interruption", async () => {
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> =
    [];
  let signalStarted!: () => void;
  let finish!: (replies: string[]) => void;
  const started = new Promise<void>((resolve) => signalStarted = resolve);
  const routerTask = runSharedRouter({
    topicId: "topic-test",
    now: () => 10,
    pause: async () => {},
    ready: async () => false,
    reserve: async () => true,
    begin: async () => true,
    generate: async () => {
      signalStarted();
      return await new Promise<string[]>((resolve) => finish = resolve);
    },
    save: async () => {},
    fail: async () => {},
    diagnostic: (event, fields) => diagnostics.push({ event, fields }),
  }, MODEL_ORDER.slice(1));
  await started;
  dispatchEvent(new Event("beforeunload"));
  strictEqual(
    diagnostics.some((d) =>
      d.event === "function_processing_interrupted" &&
      d.fields.topic_id === "topic-test" && d.fields.model === "groq-120b" &&
      d.fields.stage === "provider_processing"
    ),
    true,
  );
  finish(texts);
  await routerTask;
});

Deno.test("router diagnostics distinguish a database save failure", async () => {
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> =
    [];
  let generated = 0;
  const attempted = MODEL_ORDER.slice(1);
  await runSharedRouter({
    topicId: "topic-test",
    now: () => 0,
    pause: async () => {},
    ready: async () => false,
    reserve: async () => true,
    begin: async () => true,
    generate: async () => {
      generated++;
      return texts;
    },
    save: async () => {
      throw Error("sensitive database response");
    },
    fail: async () => {},
    diagnostic: (event, fields) => diagnostics.push({ event, fields }),
  }, attempted);
  strictEqual(generated, 1);
  strictEqual(
    diagnostics.some((d) =>
      d.event === "save_failed" &&
      d.fields.stage === "database_rpc" &&
      d.fields.error_class === "database_rpc_failure"
    ),
    true,
  );
  strictEqual(
    JSON.stringify(diagnostics).includes("sensitive database response"),
    false,
  );
});

Deno.test("database RPC save diagnostics include status but never response body", async () => {
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> =
    [];
  const store = new RouterStore(
    (name) =>
      name === "SUPABASE_URL"
        ? "https://test-project.supabase.co"
        : name === "SUPABASE_SERVICE_ROLE_KEY"
        ? "test-key"
        : undefined,
    async () => new Response("private database detail", { status: 503 }),
    (event, fields) => diagnostics.push({ event, fields }),
  );
  await rejects(() =>
    store.rpc("complete_shared_ai_attempt", {
      p_topic_id: "topic-test",
      p_attempt_id: "attempt-test",
      p_replies: ["must-not-log"],
    })
  );
  strictEqual(
    diagnostics.some((d) =>
      d.event === "database_rpc_failed" &&
      d.fields.stage === "database_rpc_save" &&
      d.fields.error_class === "database_http_error" &&
      d.fields.http_status === 503 &&
      d.fields.topic_id === "topic-test" &&
      d.fields.attempt_id === "attempt-test"
    ),
    true,
  );
  const serialized = JSON.stringify(diagnostics);
  strictEqual(serialized.includes("private database detail"), false);
  strictEqual(serialized.includes("must-not-log"), false);
});

Deno.test("provider-specific candidates stay disabled when quota settings are missing or invalid", () => {
  const env = (name: string) =>
    name === "CLOUDFLARE_ACCOUNT_ID" ||
      name === "CLOUDFLARE_AI_API_TOKEN" || name === "OPENROUTER_API_KEY"
      ? "configured"
      : undefined;
  const validCloudflare = new AiRateLimiter(
    {
      "cloudflare-gemma": {
        free: true,
        provider: "cloudflare",
        quotas: [{
          scope: "cloudflare-workers-ai-neurons",
          rpm: 300,
          neuronsPerDay: 10000,
          inputNeuronsPerMillionTokens: 9091,
          outputNeuronsPerMillionTokens: 27273,
          day: "UTC",
        }],
      },
    },
    fetch,
    env,
  );
  strictEqual(providerAvailable("cloudflare-gemma", validCloudflare), true);
  const badCloudflare = new AiRateLimiter(
    {
      "cloudflare-gemma": {
        free: true,
        provider: "cloudflare",
        quotas: [{
          scope: "cloudflare-workers-ai-neurons",
          rpm: 300,
          neuronsPerDay: 10000,
          inputNeuronsPerMillionTokens: 1,
          outputNeuronsPerMillionTokens: 2,
          day: "UTC",
        }],
      },
    },
    fetch,
    env,
  );
  strictEqual(providerAvailable("cloudflare-gemma", badCloudflare), false);
  const legacyOpenRouter = new AiRateLimiter(
    {
      "openrouter-nemotron": {
        free: true,
        quotas: [{ scope: "legacy", rpm: 20, day: "rolling" }],
      },
    },
    fetch,
    env,
  );
  strictEqual(
    providerAvailable("openrouter-nemotron", legacyOpenRouter),
    false,
  );
});
