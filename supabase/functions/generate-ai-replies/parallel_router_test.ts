import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { type AiRepliesRequest } from "./ai_replies.ts";
import {
  generateSharedChunkParallel,
  type ParallelRouterDependencies,
} from "./parallel_router.ts";
import { AiRateLimiter } from "../_shared/ai_rate_limit.ts";
import { SharedAiChunkStore } from "./shared_ai_store.ts";

const replyTexts = Array.from({ length: 10 }, (_, i) => `reply ${i + 1}`);
const input: AiRepliesRequest = {
  mode: "sharedAi",
  newsTitle: "title",
  articleBody: "body",
  count: 10,
  context: ["past context"],
  replyRelations: [{ from: 2, to: 1 }],
};
const config = {
  "groq-120b": {
    free: true,
    quotas: [{
      scope: "groq",
      rpm: 30,
      tpm: 100000,
      rpd: 1000,
      day: "UTC" as const,
    }],
  },
  "cloudflare-gemma": {
    free: true,
    provider: "cloudflare" as const,
    quotas: [{
      scope: "cloudflare-workers-ai-neurons",
      rpm: 300,
      neuronsPerDay: 10000,
      inputNeuronsPerMillionTokens: 9091,
      outputNeuronsPerMillionTokens: 27273,
      day: "UTC" as const,
    }],
  },
  "gemini-3.1": {
    free: true,
    quotas: [{
      scope: "google",
      rpm: 30,
      tpm: 100000,
      rpd: 1000,
      day: "UTC" as const,
    }],
  },
  "google-gemma": {
    free: true,
    quotas: [{
      scope: "google",
      rpm: 30,
      tpm: 100000,
      rpd: 1000,
      day: "UTC" as const,
    }],
  },
  "openrouter-nemotron": {
    free: true,
    provider: "openrouter" as const,
    quotas: [{
      scope: "openrouter-free-models",
      rpm: 20,
      day: "rolling" as const,
    }],
  },
};
const envValues: Record<string, string> = {
  UPSTASH_REDIS_REST_URL: "https://redis.invalid",
  UPSTASH_REDIS_REST_TOKEN: "mock",
  GROQ_API_KEY: "mock",
  CLOUDFLARE_AI_API_TOKEN: "mock",
  CLOUDFLARE_ACCOUNT_ID: "mock-account",
  GEMINI_API_KEY: "mock",
  OPENROUTER_API_KEY: "mock",
};

type PersistedChunk = { chunkIndex: number; replies: string[] };

function mockStore(calls: string[], persisted: PersistedChunk[]) {
  const store = {
    async rpc<T>(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (name === "claim_shared_ai_chunk_generation") {
        return { status: "claimed", articleId: 41 } as T;
      }
      if (name === "complete_shared_ai_chunk_primary") {
        const replies = args.p_replies as string[];
        persisted.push({ chunkIndex: 2, replies });
        return {
          status: "saved",
          chunkIndex: 2,
          replies: replies.map((text) => ({ text })),
        } as T;
      }
      if (name === "append_shared_ai_late_result") {
        const replies = args.p_replies as string[];
        const chunkIndex = Math.max(2, ...persisted.map((c) => c.chunkIndex)) +
          1;
        persisted.push({ chunkIndex, replies });
        return { status: "saved", chunkIndex } as T;
      }
      return true as T;
    },
  };
  return store as unknown as SharedAiChunkStore;
}

function deps(
  apiFetch: typeof fetch,
  storeCalls: string[],
  extra: Partial<ParallelRouterDependencies> = {},
  gemmaQuotaAvailable = true,
  persisted: PersistedChunk[] = [],
): ParallelRouterDependencies {
  const limiter = new AiRateLimiter(
    config,
    async (_url, init) => {
      const command = JSON.parse(String(init?.body)) as unknown[];
      const rules = JSON.parse(String(command[4])) as Array<{ key: string }>;
      const isGemmaCommentReserve = rules.some((rule) =>
        rule.key.includes(":comments:")
      );
      return new Response(
        JSON.stringify({
          result: !gemmaQuotaAvailable && isGemmaCommentReserve ? 0 : 1,
        }),
        { status: 200 },
      );
    },
    (key) => envValues[key],
  );
  return {
    fetcher: apiFetch,
    limiter,
    store: mockStore(storeCalls, persisted),
    parallelThresholdMs: 100,
    emit: () => {},
    ...extra,
  };
}

function googleResponse(replies = replyTexts) {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: { parts: [{ text: JSON.stringify(replies) }] },
      }],
    }),
    { status: 200 },
  );
}
function openAiResponse(replies = replyTexts) {
  return new Response(
    JSON.stringify({
      choices: [{
        message: { content: JSON.stringify(replies) },
      }],
    }),
    { status: 200 },
  );
}
function cloudflareResponse() {
  return new Response(
    JSON.stringify({ result: { response: JSON.stringify(replyTexts) } }),
    { status: 200 },
  );
}

Deno.test("confirmed failure before threshold advances to the next normal provider", async () => {
  const models: string[] = [];
  const result = await generateSharedChunkParallel(
    input,
    {
      newsUrl: "https://example.invalid/a",
      chunkIndex: 2,
      conversationPattern: "singleReply",
    },
    "00000000-0000-4000-8000-000000000003",
    () => {},
    deps(async (url) => {
      models.push(String(url));
      return String(url).includes("api.groq.com")
        ? new Response("unavailable", { status: 503 })
        : cloudflareResponse();
    }, []),
  );
  strictEqual(result.chunkIndex, 2);
  strictEqual(models.length, 2);
  strictEqual(models[0].includes("api.groq.com"), true);
  strictEqual(models[1].includes("api.cloudflare.com"), true);
  strictEqual(
    models.some((url) =>
      url.includes(
        "generativelanguage.googleapis.com/v1beta/models/gemma-4-26b",
      )
    ),
    false,
  );
});

Deno.test("early normal success is saved and does not start Gemma", async () => {
  const models: string[] = [];
  const storeCalls: string[] = [];
  const result = await generateSharedChunkParallel(
    input,
    {
      newsUrl: "https://example.invalid/a",
      chunkIndex: 2,
      conversationPattern: "singleReply",
    },
    "00000000-0000-4000-8000-000000000001",
    () => {},
    deps(async (url) => {
      models.push(String(url));
      return openAiResponse();
    }, storeCalls),
  );
  deepStrictEqual(result.replies, replyTexts);
  strictEqual(result.chunkIndex, 2);
  strictEqual(models.length, 1);
  strictEqual(models[0].includes("api.groq.com"), true);
  strictEqual(models.some((url) => url.includes("gemma-4-26b")), false);
  strictEqual(storeCalls.includes("complete_shared_ai_chunk_primary"), true);
});

Deno.test("at threshold normal request continues and late success is saved after Gemma wins", async () => {
  const models: string[] = [];
  const storeCalls: string[] = [];
  const persisted: PersistedChunk[] = [];
  const normalReplies = replyTexts.map((text) => `normal ${text}`);
  const gemmaReplies = replyTexts.map((text) => `gemma ${text}`);
  const background: Promise<unknown>[] = [];
  let resolveNormal!: (response: Response) => void;
  const result = await generateSharedChunkParallel(
    input,
    {
      newsUrl: "https://example.invalid/a",
      chunkIndex: 2,
      conversationPattern: "singleReply",
    },
    "00000000-0000-4000-8000-000000000002",
    (task) => background.push(task),
    deps(
      (url) => {
        const value = String(url);
        models.push(value);
        if (value.includes("api.groq.com")) {
          return new Promise<Response>((resolve) => {
            resolveNormal = resolve;
          });
        }
        if (value.includes("gemma-4-26b")) {
          return Promise.resolve(googleResponse(gemmaReplies));
        }
        throw Error(`unexpected provider ${value}`);
      },
      storeCalls,
      {},
      true,
      persisted,
    ),
  );
  strictEqual(result.chunkIndex, 2);
  deepStrictEqual(result.replies, gemmaReplies);
  strictEqual(models.some((url) => url.includes("gemma-4-26b")), true);
  strictEqual(models.some((url) => url.includes("api.groq.com")), true);
  strictEqual(background.length, 1);
  strictEqual(storeCalls.includes("append_shared_ai_late_result"), false);
  resolveNormal(openAiResponse(normalReplies));
  await background[0];
  strictEqual(storeCalls.includes("append_shared_ai_late_result"), true);
  deepStrictEqual(persisted, [
    { chunkIndex: 2, replies: gemmaReplies },
    { chunkIndex: 3, replies: normalReplies },
  ]);
});

Deno.test("normal model can win after threshold and Gemma is saved as the late chunk", async () => {
  const storeCalls: string[] = [];
  const persisted: PersistedChunk[] = [];
  const normalReplies = replyTexts.map((text) => `normal ${text}`);
  const gemmaReplies = replyTexts.map((text) => `gemma ${text}`);
  const background: Promise<unknown>[] = [];
  let resolveNormal!: (response: Response) => void;
  let resolveGemma!: (response: Response) => void;
  let normalStarted = false;
  const pending = generateSharedChunkParallel(
    input,
    {
      newsUrl: "https://example.invalid/a",
      chunkIndex: 2,
      conversationPattern: "singleReply",
    },
    "00000000-0000-4000-8000-000000000004",
    (task) => background.push(task),
    deps(
      (url) => {
        const value = String(url);
        if (value.includes("api.groq.com")) {
          normalStarted = true;
          return new Promise<Response>((resolve) => {
            resolveNormal = resolve;
          });
        }
        if (value.includes("gemma-4-26b")) {
          return new Promise<Response>((resolve) => {
            resolveGemma = resolve;
          });
        }
        throw Error(`unexpected provider ${value}`);
      },
      storeCalls,
      {},
      true,
      persisted,
    ),
  );
  while (!normalStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  for (let i = 0; i < 100 && !resolveGemma; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  strictEqual(typeof resolveGemma, "function");
  await new Promise((resolve) => setTimeout(resolve, 115));
  resolveNormal(openAiResponse(normalReplies));
  const result = await pending;
  strictEqual(result.chunkIndex, 2);
  deepStrictEqual(result.replies, normalReplies);
  strictEqual(background.length, 1);
  resolveGemma(googleResponse(gemmaReplies));
  await background[0];
  strictEqual(storeCalls.includes("append_shared_ai_late_result"), true);
  deepStrictEqual(persisted, [
    { chunkIndex: 2, replies: normalReplies },
    { chunkIndex: 3, replies: gemmaReplies },
  ]);
});

Deno.test("either parallel provider can fail while the other result is saved", async () => {
  const normalReplies = replyTexts.map((text) => `normal ${text}`);
  const gemmaReplies = replyTexts.map((text) => `gemma ${text}`);

  // Gemma succeeds first; the continuing normal request then fails.
  {
    const calls: string[] = [];
    const persisted: PersistedChunk[] = [];
    const background: Promise<unknown>[] = [];
    let resolveNormal!: (response: Response) => void;
    const pending = generateSharedChunkParallel(
      input,
      {
        newsUrl: "https://example.invalid/a",
        chunkIndex: 2,
        conversationPattern: "singleReply",
      },
      "00000000-0000-4000-8000-000000000006",
      (task) => background.push(task),
      deps(
        (url) =>
          String(url).includes("gemma-4-26b")
            ? Promise.resolve(googleResponse(gemmaReplies))
            : new Promise<Response>((resolve) => resolveNormal = resolve),
        calls,
        {},
        true,
        persisted,
      ),
    );
    for (let i = 0; i < 100 && !resolveNormal; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 115));
    const result = await pending;
    resolveNormal(new Response("unavailable", { status: 503 }));
    await background[0];
    deepStrictEqual(result.replies, gemmaReplies);
    deepStrictEqual(persisted, [{ chunkIndex: 2, replies: gemmaReplies }]);
  }

  // Normal succeeds first; the continuing Gemma request then fails.
  {
    const calls: string[] = [];
    const persisted: PersistedChunk[] = [];
    const background: Promise<unknown>[] = [];
    let resolveGemma!: (response: Response) => void;
    let resolveNormal!: (response: Response) => void;
    let normalStarted = false;
    const pending = generateSharedChunkParallel(
      input,
      {
        newsUrl: "https://example.invalid/a",
        chunkIndex: 2,
        conversationPattern: "singleReply",
      },
      "00000000-0000-4000-8000-000000000007",
      (task) => background.push(task),
      deps(
        (url) => {
          if (String(url).includes("gemma-4-26b")) {
            return new Promise<Response>((resolve) => resolveGemma = resolve);
          }
          normalStarted = true;
          return new Promise<Response>((resolve) => resolveNormal = resolve);
        },
        calls,
        {},
        true,
        persisted,
      ),
    );
    while (!normalStarted) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let i = 0; i < 100 && !resolveGemma; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    strictEqual(typeof resolveGemma, "function");
    resolveNormal(openAiResponse(normalReplies));
    const result = await pending;
    resolveGemma(new Response("unavailable", { status: 503 }));
    await background[0];
    deepStrictEqual(result.replies, normalReplies);
    deepStrictEqual(persisted, [{ chunkIndex: 2, replies: normalReplies }]);
  }
});

Deno.test("both parallel providers failing marks the generation failed", async () => {
  const calls: string[] = [];
  const persisted: PersistedChunk[] = [];
  const background: Promise<unknown>[] = [];
  let resolveNormal!: (response: Response) => void;
  const pending = generateSharedChunkParallel(
    input,
    {
      newsUrl: "https://example.invalid/a",
      chunkIndex: 2,
      conversationPattern: "singleReply",
    },
    "00000000-0000-4000-8000-000000000008",
    (task) => background.push(task),
    deps(
      (url) =>
        String(url).includes("gemma-4-26b")
          ? Promise.resolve(new Response("unavailable", { status: 503 }))
          : new Promise<Response>((resolve) => resolveNormal = resolve),
      calls,
      {},
      true,
      persisted,
    ),
  );
  for (let i = 0; i < 100 && !resolveNormal; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await new Promise((resolve) => setTimeout(resolve, 115));
  resolveNormal(new Response("unavailable", { status: 503 }));
  await rejects(pending, /shared_ai_generation_failed/);
  strictEqual(calls.includes("fail_shared_ai_chunk_generation"), true);
  deepStrictEqual(persisted, []);
});

Deno.test("Gemma quota failure leaves the pending normal request running", async () => {
  let resolveNormal!: (response: Response) => void;
  let normalStarted = false;
  const models: string[] = [];
  const pending = generateSharedChunkParallel(
    input,
    {
      newsUrl: "https://example.invalid/a",
      chunkIndex: 2,
      conversationPattern: "singleReply",
    },
    "00000000-0000-4000-8000-000000000005",
    () => {},
    deps(
      (url) => {
        const value = String(url);
        models.push(value);
        if (value.includes("api.groq.com")) {
          normalStarted = true;
          return new Promise<Response>((resolve) => {
            resolveNormal = resolve;
          });
        }
        throw Error(`unexpected Provider API ${value}`);
      },
      [],
      {},
      false,
    ),
  );
  while (!normalStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 115));
  strictEqual(
    models.some((url) =>
      url.includes(
        "generativelanguage.googleapis.com/v1beta/models/gemma-4-26b",
      )
    ),
    false,
  );
  resolveNormal(openAiResponse());
  const result = await pending;
  strictEqual(result.chunkIndex, 2);
  strictEqual(models.some((url) => url.includes("api.groq.com")), true);
});
