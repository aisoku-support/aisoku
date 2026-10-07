function assertEquals<T>(actual: T, expected: T) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertEquals failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
import { parseCategory, summarize } from "./clef_flash_eval.ts";

Deno.test("parseCategory accepts exact category JSON and plain text only", () => {
  assertEquals(parseCategory('{"category":"除外"}'), "除外");
  assertEquals(parseCategory("```json\n{\"category\":\"IT・ガジェット\"}\n```"), "IT・ガジェット");
  assertEquals(parseCategory("エンタメ"), "エンタメ");
  assertEquals(parseCategory('{"category":"その他"}'), null);
  assertEquals(parseCategory("エンタメです"), null);
  assertEquals(parseCategory(null), null);
});

Deno.test("summary reports distributions and nearest-rank latency without inventing label scores", () => {
  const summary = summarize([
    { article_id: "a", category: "除外", latency_ms: 20, input_tokens: 10, output_tokens: 2, error: null },
    { article_id: "b", category: "マネー", latency_ms: 50, input_tokens: 12, output_tokens: 3, error: null },
    { article_id: "c", category: null, latency_ms: 90, input_tokens: null, output_tokens: null, error: "http_500" },
  ]);
  assertEquals(summary.successful, 2);
  assertEquals(summary.failed, 1);
  assertEquals(summary.excluded_count, 1);
  assertEquals(summary.exclusion_precision, null);
  assertEquals(summary.exclusion_recall, null);
  assertEquals(summary.latency_p50_ms, 20);
  assertEquals(summary.latency_p95_ms, 50);
  assertEquals(summary.input_tokens, null);
});
