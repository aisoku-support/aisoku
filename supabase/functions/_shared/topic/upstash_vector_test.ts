import { strictEqual } from "node:assert/strict";
import {
  queryTopicVector,
  queryTopicVectorWithLog,
  syncTopicVectorOutbox,
  TOPIC_VECTOR_NAMESPACE,
  upsertTopicVectorBatch,
} from "./upstash_vector.ts";

Deno.test("Upstash Topic vector uses raw subject | event data and dedicated namespace", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  await upsertTopicVectorBatch("https://vector.invalid", "test-token", [{
    topic_id: "topic-1",
    topic_text: "subject | event",
    subject: "subject",
    event: "event",
    category: "IT・ガジェット",
    last_seen_at: "2026-09-26T00:00:00.000Z",
  }], async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ result: "Success" });
  });
  strictEqual(calls.length, 1);
  strictEqual(
    calls[0].url,
    `https://vector.invalid/upsert-data/${TOPIC_VECTOR_NAMESPACE}`,
  );
  strictEqual(
    (calls[0].body as Array<{ data: string }>)[0].data,
    "subject | event",
  );
});

Deno.test("Upstash Topic query is one topK query filtered by lookback and category", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const candidate = await queryTopicVector(
    "https://vector.invalid",
    "test-token",
    "subject | event",
    1000,
    async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({
        result: [{
          id: "topic-1",
          score: 0.89,
          metadata: {
            topic_id: "topic-1",
            category: "IT・ガジェット",
            last_seen_at_ms: 2000,
          },
        }],
      });
    },
    "IT・ガジェット",
  );
  strictEqual(calls.length, 1);
  strictEqual(calls[0].body.topK, 1);
  strictEqual(
    calls[0].body.filter,
    "last_seen_at_ms >= 1000 AND category = 'IT・ガジェット'",
  );
  strictEqual(candidate?.similarity, 0.89);
});

Deno.test("Upstash search success logs duration, version and whether topK returned a candidate", async () => {
  const calls: string[] = [];
  let saved: Record<string, unknown>[] = [];
  const candidate = await queryTopicVectorWithLog(
    { url: "https://db.invalid", serviceRoleKey: "test-key" },
    "https://vector.invalid",
    "test-token",
    "subject | event",
    1000,
    "IT・ガジェット",
    "batch-1",
    "article-1",
    "openai/text-embedding-3-small:1536:v1",
    async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/query-data/")) return Response.json({ result: [] });
      if (url.endsWith("/topic_observability_logs")) {
        saved = JSON.parse(String(init?.body ?? "[]"));
        return new Response(null, { status: 201 });
      }
      throw new Error("unexpected request");
    },
  );
  strictEqual(candidate, null);
  strictEqual(calls.length, 2);
  strictEqual(saved[0]?.operation, "vector_search");
  strictEqual(saved[0]?.status, "success");
  strictEqual(saved[0]?.item_count, 0);
  strictEqual(saved[0]?.embedding_version, "openai/text-embedding-3-small:1536:v1");
  strictEqual(typeof saved[0]?.duration_ms, "number");
});

Deno.test("Upstash search failure logs only a safe reason and HTTP status", async () => {
  let saved: Record<string, unknown>[] = [];
  let threw = false;
  try {
    await queryTopicVectorWithLog(
      { url: "https://db.invalid", serviceRoleKey: "test-key" },
      "https://vector.invalid",
      "test-token",
      "subject | event",
      1000,
      "IT・ガジェット",
      "batch-1",
      "article-1",
      "openai/text-embedding-3-small:1536:v1",
      async (input, init) => {
        if (String(input).includes("/query-data/")) return new Response("", { status: 401 });
        saved = JSON.parse(String(init?.body ?? "[]"));
        return new Response(null, { status: 201 });
      },
    );
  } catch {
    threw = true;
  }
  strictEqual(threw, true);
  strictEqual(saved[0]?.status, "failure");
  strictEqual(saved[0]?.error_type, "http_401");
  strictEqual(saved[0]?.http_status, 401);
  strictEqual(JSON.stringify(saved).includes("test-token"), false);
});

Deno.test("outbox sync batches vectors and acknowledges only after successful upsert", async () => {
  const calls: string[] = [];
  const result = await syncTopicVectorOutbox(
    { url: "https://db.invalid", serviceRoleKey: "test-key" },
    "https://vector.invalid",
    "test-token",
    async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/rpc/claim_topic_vector_outbox")) {
        return Response.json([{
          topic_id: "topic-1",
          topic_text: "subject | event",
          subject: "subject",
          event: "event",
          category: "IT・ガジェット",
          last_seen_at: "2026-09-26T00:00:00.000Z",
          claim_token: "claim-1",
        }]);
      }
      if (url.includes("/upsert-data/")) {
        return Response.json({ result: "Success" });
      }
      if (url.endsWith("/rpc/ack_topic_vector_outbox")) return Response.json(1);
      if (url.endsWith("/topic_observability_logs")) return new Response(null, { status: 201 });
      throw new Error("unexpected request");
    },
  );
  strictEqual(result, 1);
  strictEqual(calls.length, 4);
  strictEqual(
    calls[1],
    `https://vector.invalid/upsert-data/${TOPIC_VECTOR_NAMESPACE}`,
  );
  strictEqual(calls[2].endsWith("/rpc/ack_topic_vector_outbox"), true);
  strictEqual(calls[3].endsWith("/topic_observability_logs"), true);
});

Deno.test("outbox sync failures are recorded once without retrying the Upstash write", async () => {
  const calls: string[] = [];
  let saved: Record<string, unknown>[] = [];
  let threw = false;
  try {
    await syncTopicVectorOutbox(
      { url: "https://db.invalid", serviceRoleKey: "test-key" },
      "https://vector.invalid",
      "test-token",
      async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/rpc/claim_topic_vector_outbox")) return Response.json([{
          topic_id: "topic-1", topic_text: "subject | event", subject: "subject", event: "event",
          category: "IT・ガジェット", last_seen_at: "2026-09-26T00:00:00.000Z", claim_token: "claim-1",
        }]);
        if (url.includes("/upsert-data/")) return new Response("", { status: 503 });
        if (url.endsWith("/rpc/release_topic_vector_outbox")) return Response.json(1);
        if (url.endsWith("/topic_observability_logs")) {
          saved = JSON.parse(String(init?.body ?? "[]"));
          return new Response(null, { status: 201 });
        }
        throw new Error("unexpected request");
      },
    );
  } catch {
    threw = true;
  }
  strictEqual(threw, true);
  strictEqual(calls.filter((url) => url.includes("/upsert-data/")).length, 1);
  strictEqual(saved[0]?.operation, "outbox_sync");
  strictEqual(saved[0]?.status, "failure");
  strictEqual(saved[0]?.item_count, 1);
  strictEqual(saved[0]?.error_type, "http_503");
});
