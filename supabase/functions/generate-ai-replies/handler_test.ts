import { strictEqual } from "node:assert";
import { ProviderError } from "./ai_replies.ts";
import { createGenerateAiRepliesHandler } from "./handler.ts";
import { GenerationBudget } from "./generation_budget.ts";

const testKey = "test-only-publishable-key";
const env = {
  url: "https://test-project.supabase.co",
  publishableKeys: { default: testKey },
};

Deno.test("internal deadline returns existing 502 with ID and rejects late success", async () => {
  let resolve!: (value: string[]) => void;
  const late = new Promise<string[]>((r) => {
    resolve = r;
  });
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));
  const id = "00000000-0000-4000-8000-000000000001";
  try {
    const handler = createGenerateAiRepliesHandler({
      env,
      sharedBudget: () => new GenerationBudget(10),
      generate: () => late,
    });
    const response = await handler(
      new Request("https://example.invalid", {
        method: "POST",
        headers: {
          apikey: testKey,
          "Content-Type": "application/json",
          "x-ai-diagnostic-id": id,
        },
        body: JSON.stringify({
          mode: "sharedAi",
          newsTitle: "title",
          articleBody: "body",
          count: 10,
          context: [],
          replyRelations: [],
        }),
      }),
    );
    strictEqual(response.status, 502);
    strictEqual(response.headers.get("X-AI-Diagnostic-ID"), id);
    const body = await response.json();
    strictEqual(body.error, "ai_generation_failed");
    strictEqual(body.diagnosticId, id);
    resolve(["late"]);
    await new Promise((r) => setTimeout(r, 0));
    strictEqual(
      logs.some((s) => s.includes('"error_class":"request_deadline"')),
      true,
    );
    strictEqual(
      logs.some((s) => s.includes('"event":"request_completed"')),
      false,
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("targeted shared chunks use server save contract and return canonical index", async () => {
  let received: Record<string, unknown> | undefined;
  let waits = 0;
  const handler = createGenerateAiRepliesHandler({
    env,
    waitUntil: () => waits++,
    generateSharedChunk: async (_input, target, id, waitUntil) => {
      received = { ...target, id };
      waitUntil(Promise.resolve());
      return {
        replies: Array.from({ length: 10 }, (_, i) => `reply ${i + 1}`),
        chunkIndex: 2,
      };
    },
  });
  const response = await handler(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { apikey: testKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sharedAi",
        newsTitle: "title",
        articleBody: "body",
        count: 10,
        context: ["past"],
        replyRelations: [{ from: 2, to: 1 }],
        articleUrl: "https://example.invalid/article",
        chunkIndex: 2,
        conversationPattern: "singleReply",
      }),
    }),
  );
  strictEqual(response.status, 200);
  strictEqual((await response.json()).chunkIndex, 2);
  strictEqual(received?.newsUrl, "https://example.invalid/article");
  strictEqual(received?.chunkIndex, 2);
  strictEqual(waits, 1);
});

Deno.test("targeted shared chunk rejects incomplete persistence contract", async () => {
  const handler = createGenerateAiRepliesHandler({ env });
  const response = await handler(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { apikey: testKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sharedAi",
        newsTitle: "title",
        articleBody: "body",
        count: 10,
        context: [],
        replyRelations: [],
        articleUrl: "https://example.invalid/a",
      }),
    }),
  );
  strictEqual(response.status, 400);
});

Deno.test("sharedInitial accepts only Topic ID and returns a background receipt", async () => {
  let waits = 0;
  let legacy = 0;
  const handler = createGenerateAiRepliesHandler({
    env,
    sharedRouterRollout: JSON.stringify({ enabled: true }),
    waitUntil: () => {
      waits++;
    },
    generate: async () => {
      legacy++;
      return [];
    },
    startInitial: async (topicId, waitUntil) => {
      strictEqual(topicId, "00000000-0000-0000-0000-000000000001");
      waitUntil(Promise.resolve());
      return { status: "running" };
    },
  });
  const response = await handler(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { apikey: testKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sharedInitial",
        topicId: "00000000-0000-0000-0000-000000000001",
        model: "paid-model",
        userComment: "must not enter prompt",
      }),
    }),
  );
  strictEqual(response.status, 202);
  strictEqual(waits, 1);
  strictEqual(legacy, 0);
  strictEqual((await response.json()).status, "running");
});

Deno.test("sharedInitial validates Topic ID before starting work", async () => {
  let calls = 0;
  const handler = createGenerateAiRepliesHandler({
    env,
    sharedRouterRollout: JSON.stringify({ enabled: true }),
    startInitial: async () => {
      calls++;
      return { status: "ready", chunkIndex: 1 };
    },
  });
  const response = await handler(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { apikey: testKey, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "sharedInitial", topicId: "invalid" }),
    }),
  );
  strictEqual(response.status, 400);
  strictEqual(calls, 0);
});

Deno.test("sharedInitial stays deferred for unlisted Topics without starting work", async () => {
  let starts = 0;
  const handler = createGenerateAiRepliesHandler({
    env,
    sharedRouterRollout: JSON.stringify({
      enabled: false,
      allowedTopicIds: ["00000000-0000-0000-0000-000000000002"],
    }),
    waitUntil: () => {
      throw Error("must not start background work");
    },
    startInitial: async () => {
      starts++;
      return { status: "running" };
    },
  });
  const response = await handler(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { apikey: testKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sharedInitial",
        topicId: "00000000-0000-0000-0000-000000000001",
      }),
    }),
  );
  strictEqual(response.status, 202);
  strictEqual((await response.json()).status, "deferred");
  strictEqual(starts, 0);
});

Deno.test("sharedInitial starts only an allowlisted test Topic", async () => {
  let starts = 0;
  const handler = createGenerateAiRepliesHandler({
    env,
    sharedRouterRollout: JSON.stringify({
      enabled: false,
      allowedTopicIds: ["00000000-0000-0000-0000-000000000001"],
    }),
    waitUntil: () => {},
    startInitial: async () => {
      starts++;
      return { status: "running" };
    },
  });
  const response = await handler(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { apikey: testKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sharedInitial",
        topicId: "00000000-0000-0000-0000-000000000001",
      }),
    }),
  );
  strictEqual(response.status, 202);
  strictEqual((await response.json()).status, "running");
  strictEqual(starts, 1);
});

Deno.test("singleModel rollout is scoped to one test Topic and passes one model", async () => {
  let selected: string | undefined;
  const handler = createGenerateAiRepliesHandler({
    env,
    sharedRouterRollout: JSON.stringify({
      enabled: false,
      allowedTopicIds: ["00000000-0000-0000-0000-000000000001"],
      singleModel: "groq-120b",
    }),
    waitUntil: () => {},
    startInitial: async (_topicId, _waitUntil, model) => {
      selected = model;
      return { status: "running" };
    },
  });
  const allowed = await handler(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { apikey: testKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sharedInitial",
        topicId: "00000000-0000-0000-0000-000000000001",
      }),
    }),
  );
  strictEqual(allowed.status, 202);
  strictEqual(selected, "groq-120b");
  const denied = await handler(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { apikey: testKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sharedInitial",
        topicId: "00000000-0000-0000-0000-000000000002",
      }),
    }),
  );
  strictEqual(denied.status, 202);
  strictEqual((await denied.json()).status, "deferred");
});

Deno.test("malformed or absent rollout settings fail closed", async () => {
  for (
    const rollout of [
      undefined,
      "{bad",
      JSON.stringify({ enabled: "true" }),
      JSON.stringify({
        enabled: true,
        allowedTopicIds: ["00000000-0000-0000-0000-000000000001"],
        singleModel: "groq-120b",
      }),
      JSON.stringify({
        enabled: false,
        allowedTopicIds: ["00000000-0000-0000-0000-000000000001"],
        singleModel: "paid-model",
      }),
    ]
  ) {
    let starts = 0;
    const handler = createGenerateAiRepliesHandler({
      env,
      ...(rollout === undefined ? {} : { sharedRouterRollout: rollout }),
      startInitial: async () => {
        starts++;
        return { status: "running" };
      },
    });
    const response = await handler(
      new Request("https://example.invalid", {
        method: "POST",
        headers: { apikey: testKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "sharedInitial",
          topicId: "00000000-0000-0000-0000-000000000001",
        }),
      }),
    );
    strictEqual(response.status, 202);
    strictEqual((await response.json()).status, "deferred");
    strictEqual(starts, 0);
  }
});

Deno.test("legacy generation requests keep their existing route while router is off", async () => {
  let generated = 0;
  const handler = createGenerateAiRepliesHandler({
    env,
    sharedRouterRollout: JSON.stringify({ enabled: false }),
    generate: async () => {
      generated++;
      return ["legacy reply"];
    },
  });
  const response = await handler(
    new Request("https://example.invalid", {
      method: "POST",
      headers: { apikey: testKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "sharedAi",
        newsTitle: "title",
        articleBody: "body",
        count: 10,
        context: [],
        replyRelations: [],
      }),
    }),
  );
  strictEqual(response.status, 200);
  strictEqual(generated, 1);
});

Deno.test("sharedAi errors return a diagnostic ID and safe provider status", async () => {
  const diagnosticId = "00000000-0000-4000-8000-000000000001";
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => logs.push(String(message));
  try {
    const handler = createGenerateAiRepliesHandler({
      env,
      generate: async () => {
        throw new ProviderError("provider_unavailable", {
          stage: "provider_response",
          status: 429,
          exception: "http_error",
          timeout: false,
          duration_ms: 120,
        });
      },
    });
    const response = await handler(
      new Request("https://example.invalid", {
        method: "POST",
        headers: {
          apikey: testKey,
          "Content-Type": "application/json",
          "x-ai-diagnostic-id": diagnosticId,
        },
        body: JSON.stringify({
          mode: "sharedAi",
          newsTitle: "title",
          articleBody: "body",
          count: 10,
          context: [],
          replyRelations: [],
        }),
      }),
    );
    strictEqual(response.status, 502);
    strictEqual(response.headers.get("X-AI-Diagnostic-ID"), diagnosticId);
    const body = await response.json();
    strictEqual(body.error, "ai_generation_failed");
    strictEqual(body.diagnosticId, diagnosticId);
    const diagnosticLog = logs.find((line) =>
      line.includes('"event":"request_failed"')
    );
    strictEqual(typeof diagnosticLog, "string");
    strictEqual(diagnosticLog!.includes('"provider_status":429'), true);
    strictEqual(diagnosticLog!.includes('"function_status":502'), true);
    strictEqual(diagnosticLog!.includes("provider_unavailable"), false);
    strictEqual(diagnosticLog!.includes("articleBody"), false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("rejects a request without an API key", async () => {
  const handler = createGenerateAiRepliesHandler({ env });
  const response = await handler(
    new Request(
      "https://test-project.supabase.co/functions/v1/generate-ai-replies",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    ),
  );

  strictEqual(response.status, 401);
});

Deno.test("rejects an invalid API key", async () => {
  const handler = createGenerateAiRepliesHandler({ env });
  const response = await handler(
    new Request(
      "https://test-project.supabase.co/functions/v1/generate-ai-replies",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: "invalid-test-key",
        },
        body: "{}",
      },
    ),
  );

  strictEqual(response.status, 401);
});

Deno.test("accepts a valid publishable key before request validation", async () => {
  let generateCalls = 0;
  const handler = createGenerateAiRepliesHandler({
    env,
    generate: async () => {
      generateCalls++;
      return [];
    },
  });
  const response = await handler(
    new Request(
      "https://test-project.supabase.co/functions/v1/generate-ai-replies",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: testKey,
        },
        body: "{}",
      },
    ),
  );

  strictEqual(response.status, 400);
  strictEqual(generateCalls, 0);
});
