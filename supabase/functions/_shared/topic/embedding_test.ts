import {
  deepStrictEqual,
  ok as assert,
  strictEqual as assertEquals,
} from "node:assert";
import { embedTopicResults } from "./embedding.ts";
import type { GemmaResult } from "./gemma_parser.ts";

const item = (id: string): GemmaResult => ({
  article_id: id,
  thread_title: null,
  subject: "対象",
  event: "出来事",
  category: "トレンド",
  topic_text: "対象 | 出来事",
});
const response = (values: unknown[]) =>
  new Response(
    JSON.stringify({ embeddings: values.map((v) => ({ values: v })) }),
    { status: 200 },
  );
const fetcher = (values: unknown[]) => async () => response(values);

Deno.test("embedding batch maps three results and validates 384 dimensions", async () => {
  const values = Array.from(
    { length: 3 },
    () => Array.from({ length: 384 }, (_, i) => i / 384),
  );
  const result = await embedTopicResults(
    [item("a"), item("b"), item("c")],
    "key",
    fetcher(values),
  );
  deepStrictEqual(result.results.map((r) => r.article_id), ["a", "b", "c"]);
  assertEquals(result.results[0].embedding.length, 384);
  assertEquals(
    result.results[0].embedding_version,
    "gemini-embedding-2:384:v1",
  );
});
Deno.test("empty input makes no request", async () => {
  let called = false;
  const result = await embedTopicResults([], "key", async () => {
    called = true;
    return response([]);
  });
  assertEquals(result.results.length, 0);
  assertEquals(called, false);
});
Deno.test("dimension mismatch is article-level failure", async () => {
  const result = await embedTopicResults(
    [item("a"), item("b")],
    "key",
    fetcher([Array.from({ length: 384 }, () => 0), [0, 1]]),
  );
  assertEquals(result.results.length, 1);
  deepStrictEqual(result.failures, [{
    articleId: "b",
    errorType: "dimension_mismatch",
  }]);
});
Deno.test("request failure is surfaced without retry", async () => {
  let calls = 0;
  try {
    await embedTopicResults([item("a")], "key", async () => {
      calls++;
      return new Response("", { status: 429 });
    });
  } catch { /* expected */ }
  assertEquals(calls, 1);
});
