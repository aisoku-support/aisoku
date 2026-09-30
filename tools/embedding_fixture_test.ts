import { embedTopicResults } from "../supabase/functions/_shared/topic/embedding.ts";
import type { GemmaResult } from "../supabase/functions/_shared/topic/gemma_parser.ts";
const make = (n: number): GemmaResult[] => Array.from({ length: n }, (_, i) => ({ article_id: `embedding-fixture-${i + 1}`, subject: `対象${i + 1}`, event: "発表された", category: i % 2 ? "IT・ガジェット" : "トレンド", topic_text: `対象${i + 1} | 発表された` }));
for (const count of [3, 10]) {
  const result = await embedTopicResults(make(count));
  console.log(JSON.stringify({ input: count, output: result.results.length, failures: result.failures.length, dimensions: [...new Set(result.results.map((r) => r.embedding.length))], elapsedMs: result.elapsedMs, usage: result.usage ?? null }));
}
