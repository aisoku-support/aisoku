import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { AiRateLimiter, type QuotaConfig } from "../_shared/ai_rate_limit.ts";
import { MemoryQuotaRedis } from "../_shared/ai_rate_limit_test_helpers.ts";
import {
  generateReplies,
  ProviderError,
  validateRequest,
} from "./ai_replies.ts";
import {
  GenerationBudget,
  SHARED_INTERNAL_TIMEOUT_MS,
  SHARED_QUOTA_BUDGET_MS,
} from "./generation_budget.ts";
import {
  GEMMA_PROVIDER_TIMEOUT_MS,
  NORMAL_MODEL_ORDER,
  NORMAL_PROVIDER_TIMEOUT_MS,
  type NormalRouterOptions,
} from "./normal_router.ts";
import { type Model, PROVIDERS } from "./shared_provider.ts";
import { generateFreeModel } from "./shared_router.ts";

const order: Model[] = [...NORMAL_MODEL_ORDER, "google-gemma"];
const config: QuotaConfig = Object.fromEntries(order.map((model) => [model, {
  free: true,
  ...(model === "cloudflare-gemma"
    ? { provider: "cloudflare" as const }
    : model === "openrouter-nemotron"
    ? { provider: "openrouter" as const }
    : {}),
  quotas: [{
    scope: model,
    rpm: 300,
    day: "UTC" as const,
    ...(model === "cloudflare-gemma"
      ? {
        neuronsPerDay: 10000,
        inputNeuronsPerMillionTokens: 9091,
        outputNeuronsPerMillionTokens: 27273,
        day: "UTC" as const,
      }
      : {}),
  }],
}]));
const shared = () =>
  validateRequest({
    mode: "sharedAi",
    newsTitle: "private-news",
    articleBody: "private-body",
    count: 10,
    context: ["private-context"],
    replyRelations: [{ from: 2, to: 1 }],
  });
const texts = (label = "reply") =>
  Array.from({ length: 10 }, (_, i) => `${label}-${i}`);
function output(model: Model, text = JSON.stringify(texts())) {
  return Response.json(
    PROVIDERS[model].kind === "google"
      ? { candidates: [{ content: { parts: [{ text }] } }] }
      : PROVIDERS[model].kind === "cloudflare"
      ? { result: { response: text } }
      : { choices: [{ message: { content: text } }] },
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Call = { model: Model; body: any; signal: AbortSignal; headers: Headers };
function harness(
  respond: (model: Model, call: Call) => Promise<Response> = async (model) =>
    output(model),
  quotaResult: (
    model: Model,
    cooldown: boolean,
    signal: AbortSignal,
  ) => Promise<boolean> = async () => true,
  options: NormalRouterOptions = {},
) {
  const calls: Call[] = [];
  const reservations: Model[] = [];
  const cooldowns: Model[] = [];
  const limiter = new AiRateLimiter(config, async (_url, init) => {
    const args = JSON.parse(String(init?.body));
    const cooldown = !String(args[1]).includes("INCRBY");
    const scopes = JSON.parse(args[cooldown ? 3 : 7]);
    const model = scopes[0].replace("ai:v1:", "") as Model;
    (cooldown ? cooldowns : reservations).push(model);
    return Response.json({
      result: await quotaResult(model, cooldown, init?.signal as AbortSignal)
        ? 1
        : 0,
    });
  }, () => "test-secret");
  const run = (diagnosticId?: string) =>
    generateReplies(
      shared(),
      "test-secret",
      async (url, init) => {
        const body = JSON.parse(String(init?.body));
        const model = order.find((m) =>
          String(url).includes(PROVIDERS[m].model) ||
          body.model === PROVIDERS[m].model
        )!;
        strictEqual(Boolean(model), true);
        const call = {
          model,
          body,
          signal: init?.signal as AbortSignal,
          headers: new Headers(init?.headers),
        };
        calls.push(call);
        return await respond(model, call);
      },
      diagnosticId,
      { ...options, limiter: options.limiter ?? limiter },
    );
  return { run, calls, reservations, cooldowns };
}

Deno.test("production timeout constants are 7s / 6s / cumulative 5s / 40s", () => {
  deepStrictEqual([
    NORMAL_PROVIDER_TIMEOUT_MS,
    GEMMA_PROVIDER_TIMEOUT_MS,
    SHARED_QUOTA_BUDGET_MS,
    SHARED_INTERNAL_TIMEOUT_MS,
  ], [7000, 6000, 5000, 40000]);
});
for (let winner = 0; winner < order.length; winner++) {
  Deno.test(`priority chain stops at ${order[winner]} after confirmed HTTP errors`, async () => {
    const h = harness(async (model) =>
      model === order[winner] ? output(model) : new Response("private-error", {
        status: model === "groq-120b" ? 429 : 503,
      })
    );
    deepStrictEqual(await h.run(), texts());
    deepStrictEqual(h.calls.map((c) => c.model), order.slice(0, winner + 1));
    deepStrictEqual(h.reservations, order.slice(0, winner + 1));
    deepStrictEqual(h.cooldowns, winner > 0 ? ["groq-120b"] : []);
  });
}
for (
  const invalid of [
    "not-json",
    '["short"]',
    JSON.stringify([...texts().slice(0, 9), 1]),
    '["raw\nnewline"]',
  ]
) {
  Deno.test(`invalid output moves to next normal model: ${invalid.slice(0, 15)}`, async () => {
    const h = harness(async (model) =>
      output(model, model === "groq-120b" ? invalid : JSON.stringify(texts()))
    );
    deepStrictEqual(await h.run(), texts());
    deepStrictEqual(h.calls.map((c) => c.model), order.slice(0, 2));
  });
}
Deno.test("invalid HTTP JSON and transport failure proceed without retry", async () => {
  const h = harness(async (model) => {
    if (model === "groq-120b") throw Error("private transport error");
    if (model === "cloudflare-gemma") return new Response("not-json");
    return output(model);
  });
  await h.run();
  deepStrictEqual(h.calls.map((c) => c.model), order.slice(0, 3));
});
Deno.test("quota shortage skips models without API calls", async () => {
  const h = harness(undefined, async (model) => model !== "groq-120b");
  await h.run();
  deepStrictEqual(h.calls.map((c) => c.model), ["cloudflare-gemma"]);
});
Deno.test("provider unavailable is skipped before reservation", async () => {
  const limiter = new AiRateLimiter(
    config,
    async () => Response.json({ result: 1 }),
    (key) => key === "GROQ_API_KEY" ? undefined : "test",
  );
  const h = harness(undefined, undefined, { limiter });
  await h.run();
  deepStrictEqual(h.calls.map((c) => c.model), ["cloudflare-gemma"]);
});
Deno.test("7s timeout aborts normal model, goes straight to Gemma, ignores late result", async () => {
  const late = deferred<Response>();
  const h = harness(
    async (model, call) => {
      if (model === "groq-120b") return await late.promise;
      strictEqual(h.calls[0].signal.aborted, true);
      strictEqual(call.model, "google-gemma");
      return output(model, JSON.stringify(texts("fallback")));
    },
    undefined,
    { normalTimeoutMs: 10 },
  );
  deepStrictEqual(await h.run(), texts("fallback"));
  late.resolve(output("groq-120b", JSON.stringify(texts("late"))));
  await new Promise((r) => setTimeout(r, 0));
  deepStrictEqual(h.calls.map((c) => c.model), ["groq-120b", "google-gemma"]);
});
Deno.test("response body timeout also jumps straight to Gemma", async () => {
  const late = deferred<any>();
  const h = harness(
    async (model) => {
      if (model !== "groq-120b") return output(model);
      const response = output(model);
      response.json = () => late.promise;
      return response;
    },
    undefined,
    { normalTimeoutMs: 10 },
  );
  await h.run();
  late.resolve({});
  await new Promise((r) => setTimeout(r, 0));
  deepStrictEqual(h.calls.map((c) => c.model), ["groq-120b", "google-gemma"]);
});
Deno.test("Gemma reservation failure never sends its request", async () => {
  const h = harness(
    async () => new Response("private", { status: 503 }),
    async (model) => model !== "google-gemma",
  );
  await rejects(h.run(), ProviderError);
  deepStrictEqual(h.calls.map((c) => c.model), NORMAL_MODEL_ORDER);
});
Deno.test("Gemma 6s timeout is final and never returns to normal models", async () => {
  const h = harness(
    async (model, call) => {
      if (model !== "google-gemma") return new Response(null, { status: 503 });
      return await new Promise<Response>((_, reject) =>
        call.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        )
      );
    },
    undefined,
    { gemmaTimeoutMs: 10 },
  );
  await rejects(
    h.run(),
    (error: any) =>
      error instanceof ProviderError && error.diagnostic.timeout === true &&
      error.diagnostic.model === PROVIDERS["google-gemma"].model,
  );
  deepStrictEqual(h.calls.map((c) => c.model), order);
});
Deno.test("same prompt/context/relations and provider-specific parameters reach all models", async () => {
  const h = harness(async (model) =>
    model === "google-gemma"
      ? output(model)
      : new Response(null, { status: 503 })
  );
  await h.run();
  const prompts = h.calls.map((c) =>
    c.body.contents?.[0].parts[0].text ?? c.body.messages[0].content
  );
  strictEqual(new Set(prompts).size, 1);
  strictEqual(prompts[0].includes("private-context"), true);
  strictEqual(prompts[0].includes("2=1の具体的内容を拾って反応"), true);
  strictEqual(h.calls[0].body.reasoning_effort, "low");
  strictEqual(h.calls[1].body.model, undefined);
  strictEqual(
    h.calls[2].body.generationConfig.responseMimeType,
    "application/json",
  );
  deepStrictEqual(h.calls[3].body.provider, {
    allow_fallbacks: false,
    max_price: { prompt: 0, completion: 0 },
  });
  strictEqual(
    h.calls[4].body.generationConfig.thinkingConfig.thinkingLevel,
    "MINIMAL",
  );
});
Deno.test("6.5-second failure advances immediately, cumulative quota budget is shared", async () => {
  let clock = 0;
  const budget = new GenerationBudget(40000, () => clock);
  const h = harness(async (model) => {
    clock += 6500;
    return model === "google-gemma"
      ? output(model)
      : new Response(null, { status: 503 });
  }, async () => {
    clock += 1100;
    return true;
  }, { budget });
  await rejects(h.run(), ProviderError);
  // Four normal calls consume 4.4s quota; the fifth result arrives after 5s total.
  deepStrictEqual(h.calls.map((c) => c.model), NORMAL_MODEL_ORDER);
  strictEqual(h.reservations.length, 5);
});
Deno.test("quota expiry aborts transport; late success never sends AI or refunds", async () => {
  const late = deferred<boolean>();
  let signal: AbortSignal | undefined;
  const h = harness(undefined, async (_model, _cooldown, s) => {
    signal = s;
    return await late.promise;
  }, { quotaBudgetMs: 10 });
  await rejects(h.run(), ProviderError);
  strictEqual(signal!.aborted, true);
  strictEqual(h.reservations.length, 1);
  late.resolve(true);
  await new Promise((r) => setTimeout(r, 0));
  strictEqual(h.calls.length, 0);
  strictEqual(h.reservations.length, 1);
  strictEqual(h.cooldowns.length, 0);
});
Deno.test("cooldown and reservations share one cumulative budget", async () => {
  let clock = 0;
  const h = harness(
    async () => new Response(null, { status: 429 }),
    async (_model, cooldown) => {
      clock += cooldown ? 3100 : 2000;
      return true;
    },
    { budget: new GenerationBudget(40000, () => clock) },
  );
  await rejects(h.run(), ProviderError);
  strictEqual(h.calls.length, 1);
  strictEqual(h.reservations.length, 1);
  strictEqual(h.cooldowns.length, 1);
});
Deno.test("insufficient remaining time never starts a normal model or reserves quota", async () => {
  const h = harness(undefined, undefined, {
    budget: new GenerationBudget(6000),
  });
  await rejects(
    h.run(),
    (e: any) => e.diagnostic.exception === "request_deadline",
  );
  strictEqual(h.calls.length, 0);
  strictEqual(h.reservations.length, 0);
});
Deno.test("internal deadline can prevent Gemma after a normal timeout", async () => {
  let clock = 0;
  const h = harness(
    async () => {
      clock += 7000;
      throw new DOMException("timeout", "TimeoutError");
    },
    undefined,
    { budget: new GenerationBudget(12000, () => clock) },
  );
  await rejects(
    h.run(),
    (e: any) => e.diagnostic.exception === "request_deadline",
  );
  deepStrictEqual(h.calls.map((c) => c.model), ["groq-120b"]);
  deepStrictEqual(h.reservations, ["groq-120b"]);
});
Deno.test("40s deadline rejects late provider success and stops all further work", async () => {
  let clock = 0;
  const h = harness(
    async (model) => {
      clock = 40001;
      return output(model);
    },
    undefined,
    { budget: new GenerationBudget(40000, () => clock) },
  );
  await rejects(
    h.run(),
    (e: any) => e.diagnostic.exception === "request_deadline",
  );
  strictEqual(h.calls.length, 1);
});

Deno.test("reservation delay cannot start provider without its full timeout remaining", async () => {
  let clock = 0;
  const h = harness(undefined, async () => {
    clock += 2000;
    return true;
  }, { budget: new GenerationBudget(8000, () => clock) });
  await rejects(
    h.run(),
    (e: any) => e.diagnostic.exception === "request_deadline",
  );
  strictEqual(h.reservations.length, 1);
  strictEqual(h.calls.length, 0);
});

Deno.test("40s deadline interrupts quota I/O before 5s quota budget", async () => {
  const late = deferred<boolean>();
  let signal: AbortSignal | undefined;
  const h = harness(undefined, async (_m, _c, s) => {
    signal = s;
    return late.promise;
  }, {
    budget: new GenerationBudget(15),
    normalTimeoutMs: 1,
    gemmaTimeoutMs: 1,
  });
  await rejects(
    h.run(),
    (e: any) => e.diagnostic.exception === "request_deadline",
  );
  strictEqual(signal!.aborted, true);
  late.resolve(true);
  await new Promise((r) => setTimeout(r, 0));
  strictEqual(h.calls.length, 0);
  strictEqual(h.reservations.length, 1);
});

Deno.test("strict shared validation retains raw-newline JSON repair", async () => {
  const raw = JSON.stringify(texts()).replace("reply-0", "raw\nnewline");
  const h = harness(async (model) => output(model, raw));
  const replies = await h.run();
  strictEqual(replies[0], "raw\nnewline");
  strictEqual(replies.length, 10);
  strictEqual(h.calls.length, 1);
});

Deno.test("ambiguous Redis success stays charged after its late response", async () => {
  const cfg: QuotaConfig = {
    "groq-120b": {
      free: true,
      quotas: [{ scope: "ambiguous-test", rpm: 1, day: "UTC" }],
    },
  };
  const redis = new MemoryQuotaRedis(cfg);
  const late = deferred<void>();
  let commands = 0;
  const limiter = new AiRateLimiter(cfg, async (_url, init) => {
    commands++;
    const result = await redis.command(JSON.parse(String(init?.body)));
    await late.promise;
    return Response.json({ result });
  }, () => "test");
  try {
    const h = harness(undefined, undefined, { limiter, quotaBudgetMs: 10 });
    await rejects(h.run(), ProviderError);
    late.resolve();
    await new Promise((r) => setTimeout(r, 0));
    strictEqual(h.calls.length, 0);
    strictEqual(commands, 1);
    strictEqual(await redis.reserve("groq-120b", 1, 1), false);
  } finally {
    redis.close();
  }
});
Deno.test("all model failures are safe and correlated, without payload logs", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const h = harness(async () =>
      new Response("private-error", { status: 503 })
    );
    await rejects(h.run("test-diagnostic-id"), ProviderError);
  } finally {
    console.log = original;
  }
  const events = lines.map((s) => JSON.parse(s.slice("[AiReplies] ".length)));
  strictEqual(
    events.every((e) => e.diagnostic_id === "test-diagnostic-id"),
    true,
  );
  strictEqual(
    events.filter((e) => e.event === "provider_request_failed").length,
    5,
  );
  strictEqual(events.some((e) => e.reason === "normal_models_exhausted"), true);
  strictEqual(lines.some((s) => /private-|test-secret/.test(s)), false);
});

Deno.test("Redis transport timeout remains visible after reserve fails closed", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    const h = harness(undefined, async (model) => {
      if (model === "groq-120b") {
        throw new DOMException("private redis detail", "TimeoutError");
      }
      return true;
    });
    await h.run("quota-diagnostic");
    const events = logs.map((s) => JSON.parse(s.slice("[AiReplies] ".length)));
    strictEqual(
      events.some((e) =>
        e.event === "quota_failed" && e.timeout === true &&
        e.error_class === "quota_timeout"
      ),
      true,
    );
    strictEqual(
      events.some((e) =>
        e.event === "provider_output_validation" && e.valid === true
      ),
      true,
    );
    strictEqual(
      events.every((e) => e.diagnostic_id === "quota-diagnostic"),
      true,
    );
    deepStrictEqual(h.calls.map((c) => c.model), ["cloudflare-gemma"]);
    strictEqual(logs.some((s) => s.includes("private redis")), false);
  } finally {
    console.log = original;
  }
});

Deno.test("late cooldown body cannot start Redis after cumulative budget expiration", async () => {
  const late = deferred<any>();
  const h = harness(
    async () => {
      const response = new Response(null, { status: 429 });
      response.clone = () => {
        const clone = new Response(null);
        clone.json = () => late.promise;
        return clone;
      };
      return response;
    },
    undefined,
    { quotaBudgetMs: 15 },
  );
  await rejects(h.run(), ProviderError);
  late.resolve({});
  await new Promise((r) => setTimeout(r, 0));
  strictEqual(h.calls.length, 1);
  strictEqual(h.cooldowns.length, 0);
  strictEqual(h.reservations.length, 1);
});

// Shared adapter extraction affects both callers: compare their actual wire requests.
for (const model of order) {
  Deno.test(`chunk1 and normal router preserve equivalent wire format for ${model}`, async () => {
    const only = new AiRateLimiter(
      { [model]: config[model] },
      async () => Response.json({ result: 1 }),
      () => "test",
    );
    let request: { url: string; headers: Headers; body: string } | undefined;
    const replies = await generateReplies(
      shared(),
      "test",
      async (url, init) => {
        request = {
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        };
        return output(model);
      },
      undefined,
      { limiter: only },
    );
    strictEqual(replies.length, 10);
    const body = JSON.parse(request!.body);
    const prompt = body.contents?.[0].parts[0].text ?? body.messages[0].content;
    await generateFreeModel(
      model,
      prompt,
      only,
      async (url, init) => {
        strictEqual(String(url), request!.url);
        strictEqual(String(init?.body), request!.body);
        deepStrictEqual([...new Headers(init?.headers)], [...request!.headers]);
        return output(model);
      },
      undefined,
      () => {},
    );
  });
}
Deno.test("real atomic Lua shares cooldown and reservations with chunk1 callers", async () => {
  const sharedConfig: QuotaConfig = {
    "groq-120b": {
      free: true,
      quotas: [{ scope: "shared-test", rpm: 1, day: "UTC" }],
    },
  };
  const redis = new MemoryQuotaRedis(sharedConfig);
  const limiter = new AiRateLimiter(
    sharedConfig,
    async (_url, init) =>
      Response.json({
        result: await redis.command(JSON.parse(String(init?.body))),
      }),
    () => "test",
  );
  try {
    const h = harness(undefined, undefined, { limiter });
    const results = await Promise.allSettled([
      h.run(),
      redis.reserve("groq-120b", 1, 1),
    ]);
    strictEqual(
      Number(results[0].status === "fulfilled") +
        Number(results[1].status === "fulfilled" && results[1].value === true),
      1,
    );
    await redis.cooldown("groq-120b", Response.json({}, { status: 429 }));
    const next = harness(undefined, undefined, { limiter });
    await rejects(next.run(), ProviderError);
    strictEqual(next.calls.length, 0);
  } finally {
    redis.close();
  }
});
