import { classifyWithGemma } from "../supabase/functions/_shared/topic/gemma.ts";
import { embedTopicResults } from "../supabase/functions/_shared/topic/embedding.ts";
import type { TopicArticle } from "../supabase/functions/_shared/topic/types.ts";

const base = (id: string, title: string, description: string | null): TopicArticle => ({ article_id: id, title, description, url: null, normalized_url: null, source_name: "fixture", published_at: null, newsdata_categories: [], app_categories: [], fetched_at: null });
const short = [
  base("fixture-1", "政府、災害対策の新制度を発表", "政府は大規模災害への備えを強化する新制度を発表した。"),
  base("fixture-2", "新型スマートフォンを発表", "メーカーが新しいスマートフォンの仕様と発売日を発表した。"),
  base("fixture-3", "人気ゲームの大型アップデート", "ゲーム開発会社が人気タイトルの大型アップデートを公開した。"),
];
const ten = [...short, ...Array.from({ length: 7 }, (_, i) => base(`fixture-${i + 4}`, `日本語ニュースfixture ${i + 4}`, i === 6 ? null : `これは比較的長い説明文を含むニュースfixtureです。社会や技術に関する具体的な出来事を簡潔に説明しています。追加の背景情報と発表内容を含みます。`))];
const batches: Array<[string, TopicArticle[]]> = Deno.args[0] === "ten" ? [["ten", ten]] : [["short", short], ["ten", ten]];
for (const [name, articles] of batches) {
  const result = await classifyWithGemma(articles);
  const embeddable = result.results.filter((r) => r.category !== "除外");
  const embedding = await embedTopicResults(embeddable);
  const categories = Object.fromEntries([...new Set(result.results.map((r) => r.category))].map((c) => [c, result.results.filter((r) => r.category === c).length]));
  console.log(JSON.stringify({ batch: name, input: articles.length, gemmaOutput: result.results.length, embeddable: embeddable.length, embeddingOutput: embedding.results.length, embeddingDimensions: [...new Set(embedding.results.map((r) => r.embedding.length))], parserFailures: result.failures.length, embeddingFailures: embedding.failures.length, failureTypes: result.failures.map((f) => f.errorType), gemmaElapsedMs: result.elapsedMs, embeddingElapsedMs: embedding.elapsedMs, gemmaUsage: result.usage ?? null, embeddingUsage: embedding.usage ?? null, categories, topicTextGenerated: result.results.every((r) => r.topic_text === `${r.subject} | ${r.event}`) }));
}
