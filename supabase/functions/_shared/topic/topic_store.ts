import {
  type EmbeddingModel,
  embeddingModelForCategory,
  embeddingVersionForModel,
  topicConfig,
} from "./config.ts";
import type { TopicEmbeddingResult } from "./embedding.ts";
import { TOPIC_VECTOR_VERSION } from "./upstash_vector.ts";
import type { GemmaResult, TopicCategory } from "./gemma_parser.ts";
import { safeReadJson, type SupabaseConfig } from "./queue.ts";
import type { TopicArticle } from "./types.ts";
export type TopicCandidate = {
  topic_id: string;
  similarity: number;
  subject: string;
  event: string;
  category: string;
  embedding_model?: EmbeddingModel | "openai/text-embedding-3-small:1536:v1";
  last_seen_at: string;
};
export type CommitResult = {
  topic_id: string;
  outcome:
    | "new_topic"
    | "merged"
    | "duplicate_skipped"
    | "failed_gemma"
    | "failed_embedding"
    | "failed_search";
};
export type SingletonMode =
  | "gemma_failed"
  | "embedding_failed"
  | "vector_search_failed";
const headers = (c: SupabaseConfig) => ({
  Authorization: `Bearer ${c.serviceRoleKey}`,
  apikey: c.serviceRoleKey,
  "Content-Type": "application/json",
});
export async function isAlreadyProcessed(c: SupabaseConfig, articleId: string) {
  const response = await fetch(
    `${c.url}/rest/v1/topic_articles?article_id=eq.${
      encodeURIComponent(articleId)
    }&select=article_id&limit=1`,
    { headers: headers(c) },
  );
  const rows = await safeReadJson<Array<{ article_id: string }>>(
    response,
    "Topic processed lookup",
  );
  return rows.length > 0;
}
async function rpc<T>(
  c: SupabaseConfig,
  name: string,
  body: Record<string, unknown>,
  options: { requireBody?: boolean } = {},
) {
  const r = await fetch(`${c.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers(c),
    body: JSON.stringify(body),
  });
  return await safeReadJson<T>(r, `Topic RPC ${name}`, options);
}
export async function matchRecentTopic(
  c: SupabaseConfig,
  embedding: number[],
  model: EmbeddingModel,
  category: string,
) {
  const rows = await rpc<TopicCandidate[]>(c, "match_recent_topics_384", {
    p_query_embedding: embedding,
    p_lookback_hours: topicConfig.lookbackHours,
    p_candidate_limit: topicConfig.candidateLimit,
    p_embedding_version: embeddingVersionForModel(model),
    p_category: category,
  });
  return rows[0] ?? null;
}
export async function matchRecentTopicUpstash(
  url: string,
  token: string,
  topicText: string,
  category: string,
) {
  const { queryTopicVector } = await import("./upstash_vector.ts");
  return await queryTopicVector(
    url,
    token,
    topicText,
    Date.now() - topicConfig.lookbackHours * 60 * 60 * 1000,
    fetch,
    category,
  );
}
function articleParams(a: TopicArticle) {
  return {
    p_article_id: a.article_id,
    p_representative_title: a.title,
    p_representative_description: a.description,
    p_representative_url: a.url ?? a.normalized_url,
    p_representative_source: a.source_name,
    p_representative_published_at: a.published_at,
    p_source_category: a.newsdata_categories,
  };
}
export async function commitNewTopic(
  c: SupabaseConfig,
  a: TopicArticle,
  r: TopicEmbeddingResult,
  batchId: string,
  candidate: TopicCandidate | null,
  threadTitle: string | null,
) {
  const rows = await rpc<CommitResult[]>(c, "commit_new_topic_384", {
    ...articleParams(a),
    p_subject: r.subject,
    p_event: r.event,
    p_topic_text: r.topic_text,
    p_category: r.category,
    p_thread_title: threadTitle,
    p_facts: r.facts,
    p_creation_mode: "normal",
    p_match_method: "new_topic",
    p_embedding: r.embedding_version === TOPIC_VECTOR_VERSION
      ? null
      : r.embedding,
    p_embedding_version: r.embedding_version,
    p_batch_id: batchId,
    p_log_status: "new_topic",
    p_error_type: null,
    p_candidate_topic_id: candidate?.topic_id ?? null,
    p_candidate_similarity: candidate?.similarity ?? null,
  });
  return rows[0];
}
export async function commitMerge(
  c: SupabaseConfig,
  a: TopicArticle,
  r: TopicEmbeddingResult,
  candidate: TopicCandidate,
  batchId: string,
) {
  const rows = await rpc<CommitResult[]>(c, "commit_topic_merge", {
    p_article_id: a.article_id,
    p_topic_id: candidate.topic_id,
    p_source: a.source_name,
    p_published_at: a.published_at,
    p_similarity: candidate.similarity,
    p_source_category: a.newsdata_categories,
    p_classified_category: r.category,
    p_embedding_version: r.embedding_version,
    p_batch_id: batchId,
    p_facts: r.facts,
  });
  return rows[0];
}
export async function commitSingleton(
  c: SupabaseConfig,
  a: TopicArticle,
  r: GemmaResult | null,
  category: TopicCategory,
  mode: SingletonMode,
  batchId: string,
  errorType: string,
  threadTitle: string | null = null,
  embeddingVersion?: string,
) {
  const subject = r?.subject ?? a.title;
  const event = r?.event ?? "\u5bfe\u8c61\u8a18\u4e8b";
  const rows = await rpc<CommitResult[]>(c, "commit_new_topic_384", {
    ...articleParams(a),
    p_subject: subject,
    p_event: event,
    p_topic_text: r?.topic_text ?? `${subject} | ${event}`,
    p_category: category,
    p_thread_title: threadTitle,
    p_facts: r?.facts ?? [],
    p_creation_mode: mode,
    p_match_method: "fallback_singleton",
    p_embedding: null,
    p_embedding_version: embeddingVersion ?? (r
      ? embeddingVersionForModel(
        embeddingModelForCategory(category) ?? "gemini-embedding-2",
      )
      : null),
    p_batch_id: batchId,
    p_log_status: mode === "gemma_failed"
      ? "failed_gemma"
      : mode === "embedding_failed"
      ? "failed_embedding"
      : "failed_search",
    p_error_type: errorType,
    p_candidate_topic_id: null,
    p_candidate_similarity: null,
  });
  return rows[0];
}
export async function finalizeExcluded(
  c: SupabaseConfig,
  articleId: string,
  batchId: string,
) {
  await rpc<unknown>(c, "finalize_topic_excluded", {
    p_article_id: articleId,
    p_batch_id: batchId,
  }, { requireBody: false });
}
export function shouldMerge(c: TopicCandidate | null) {
  return c !== null && c.similarity >=
      (c.embedding_model === "openai/text-embedding-3-small:1536:v1"
        ? 0.88
        : topicConfig
          .similarityThresholds[c.embedding_model ?? "gemini-embedding-2"]);
}
export function normalizeFacts(facts: string[]) {
  const seen = new Set<string>();
  return facts.map((fact) => fact.trim()).filter((fact) =>
    fact !== "" && !seen.has(fact) && (seen.add(fact), true)
  );
}
export function fallbackCategory(a: TopicArticle): TopicCategory | null {
  const c = a.app_categories[0];
  return c === "\u30c8\u30ec\u30f3\u30c9" || c === "\u30a8\u30f3\u30bf\u30e1" ||
      c === "\u30b5\u30d6\u30ab\u30eb" || c === "\u30de\u30cd\u30fc" ||
      c === "IT\u30fb\u30ac\u30b8\u30a7\u30c3\u30c8"
    ? c
    : null;
}
export async function forEachSequential<T>(
  items: T[],
  handler: (item: T) => Promise<void>,
) {
  for (const item of items) await handler(item);
}
