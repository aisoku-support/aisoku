import { deepStrictEqual, strictEqual } from "node:assert";
import {
  fallbackCategory,
  forEachSequential,
  commitSingleton,
  shouldMerge,
} from "./topic_store.ts";
import type { TopicArticle } from "./types.ts";
import { normalizeFacts } from "./topic_store.ts";

const candidate = (similarity: number) => ({
  topic_id: "topic",
  similarity,
  subject: "s",
  event: "e",
  category: "トレンド",
  last_seen_at: new Date().toISOString(),
});
Deno.test("Upstash threshold remains inclusive at 0.88", () => {
  strictEqual(
    shouldMerge({
      ...candidate(0.879),
      embedding_model: "openai/text-embedding-3-small:1536:v1",
    }),
    false,
  );
  strictEqual(
    shouldMerge({
      ...candidate(0.88),
      embedding_model: "openai/text-embedding-3-small:1536:v1",
    }),
    true,
  );
});
Deno.test("threshold is inclusive at 0.88", () => {
  strictEqual(shouldMerge(null), false);
  strictEqual(shouldMerge(candidate(0.87)), false);
  strictEqual(shouldMerge(candidate(0.88)), true);
  strictEqual(shouldMerge(candidate(0.95)), true);
});
Deno.test("vector stage is strictly sequential", async () => {
  const events: string[] = [];
  await forEachSequential(["A", "B"], async (id) => {
    events.push(`${id}:search`);
    await Promise.resolve();
    events.push(`${id}:commit`);
  });
  deepStrictEqual(events, ["A:search", "A:commit", "B:search", "B:commit"]);
});
Deno.test("Gemma fallback reuses first existing app category", () => {
  const article = {
    article_id: "a",
    title: "t",
    description: null,
    url: "https://example.com",
    normalized_url: null,
    source_name: null,
    published_at: null,
    newsdata_categories: ["technology"],
    app_categories: ["IT・ガジェット"],
    fetched_at: null,
  } satisfies TopicArticle;
  strictEqual(fallbackCategory(article), "IT・ガジェット");
});
Deno.test("facts merge trims, drops empty values, and removes exact duplicates only", () => {
  deepStrictEqual(normalizeFacts([" A ", "", "A", "a", "  ", "B "]), [
    "A",
    "a",
    "B",
  ]);
});

Deno.test("failed Upstash search singleton logs the attempted Upstash version without storing a vector", async () => {
  const oldFetch = globalThis.fetch;
  const rpcBodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input, init) => {
    rpcBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json([{ topic_id: "topic", outcome: "failed_search" }]);
  }) as typeof fetch;
  const article = {
    article_id: "article-1",
    title: "title",
    description: "description",
    url: "https://example.com/article",
    normalized_url: null,
    source_name: null,
    published_at: null,
    newsdata_categories: [],
    app_categories: [],
    fetched_at: null,
  } satisfies TopicArticle;
  try {
    await commitSingleton(
      { url: "https://test.supabase.co", serviceRoleKey: "test-key" },
      article,
      {
        article_id: article.article_id,
        subject: "subject",
        event: "event",
        category: "トレンド",
        topic_text: "subject | event",
        facts: [],
      },
      "トレンド",
      "vector_search_failed",
      "batch-id",
      "vector_rpc_failed",
      null,
      "openai/text-embedding-3-small:1536:v1",
    );
    strictEqual(
      rpcBodies[0]?.p_embedding_version,
      "openai/text-embedding-3-small:1536:v1",
    );
    strictEqual(rpcBodies[0]?.p_embedding, null);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
