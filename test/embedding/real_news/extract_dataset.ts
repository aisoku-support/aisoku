const OUTPUT = `${Deno.cwd()}/test/embedding/real_news`;
const LIMIT = 200;

function readKey(name: string): string | null {
  const current = Deno.env.get(name)?.trim();
  if (current) return current;
  for (const file of [".env.server", ".env"]) {
    let text: string;
    try {
      text = Deno.readTextFileSync(`${Deno.cwd()}/${file}`);
    } catch {
      continue;
    }
    const line = text.split(/\r?\n/).find((row) => row.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return null;
}

const redisUrl = readKey("UPSTASH_REDIS_REST_URL");
const redisToken = readKey("UPSTASH_REDIS_REST_READ_ONLY_TOKEN");
const supabaseUrl = readKey("SUPABASE_URL");
const supabaseKey = readKey("SUPABASE_SERVICE_ROLE_KEY");
if (!redisUrl || !redisToken || !supabaseUrl || !supabaseKey) {
  throw new Error("required_read_credentials_missing");
}

async function redisCommand(command: unknown[]): Promise<any> {
  const response = await fetch(redisUrl!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${redisToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`redis_http_${response.status}`);
  const body = await response.json() as { result?: unknown; error?: unknown };
  if (body.error) throw new Error("redis_read_command_failed");
  return body.result;
}

async function supabaseGet<T>(table: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl!);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey!,
      authorization: `Bearer ${supabaseKey}`,
      accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`supabase_read_http_${response.status}`);
  return await response.json() as T;
}

function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Public article copy is retained, while direct contact details and URLs are removed.
  const text = value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, "[REDACTED_PHONE]")
    .trim();
  return text || null;
}

type SavedArticle = {
  article_id?: string;
  title?: string;
  description?: string | null;
  published_at?: string;
  fetched_at?: string;
};
type TopicArticle = {
  article_id: string;
  topic_id: string;
  match_method: string;
  similarity: number | null;
  published_at: string | null;
  created_at: string | null;
  source_category: string[] | null;
  classified_category: string | null;
};
type Topic = {
  id: string;
  subject: string | null;
  event: string | null;
  topic_text: string | null;
  category: string | null;
  article_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

// Read only the sorted-set index, newest saved first. Article bodies are fetched by canonical ID.
const indexRows = await redisCommand(["ZREVRANGE", "newsdata:articles", 0, LIMIT - 1, "WITHSCORES"]) as string[];
if (!Array.isArray(indexRows)) throw new Error("redis_article_index_shape_invalid");
const savedAtByCanonicalId = new Map<string, number>();
for (let i = 0; i + 1 < indexRows.length; i += 2) {
  const savedAt = Number(indexRows[i + 1]);
  savedAtByCanonicalId.set(indexRows[i], Number.isFinite(savedAt) ? savedAt : NaN);
}
const canonicalIds = [...savedAtByCanonicalId.keys()];
const rawByCanonicalId = new Map<string, string | null>();
for (let start = 0; start < canonicalIds.length; start += 50) {
  const ids = canonicalIds.slice(start, start + 50);
  const values = await redisCommand(["MGET", ...ids.map((id) => `newsdata:article:${id}`)]) as Array<string | null>;
  if (!Array.isArray(values) || values.length !== ids.length) throw new Error("redis_article_batch_shape_invalid");
  ids.forEach((id, index) => rawByCanonicalId.set(id, values[index] ?? null));
}

const rows: Array<{ canonicalId: string; savedAt: number; article: SavedArticle }> = [];
let invalidRedisJson = 0;
for (const [canonicalId, raw] of rawByCanonicalId) {
  if (!raw) continue;
  try {
    const article = JSON.parse(raw) as SavedArticle;
    if (typeof article.article_id !== "string" || !article.article_id || typeof article.title !== "string") {
      invalidRedisJson++;
      continue;
    }
    rows.push({ canonicalId, savedAt: savedAtByCanonicalId.get(canonicalId) ?? NaN, article });
  } catch {
    invalidRedisJson++;
  }
}

const articleIds = rows.map((row) => row.article.article_id!);
const topicArticleRows: TopicArticle[] = [];
for (let start = 0; start < articleIds.length; start += 50) {
  const chunk = articleIds.slice(start, start + 50);
  const result = await supabaseGet<TopicArticle[]>("topic_articles", {
    select: "article_id,topic_id,match_method,similarity,published_at,created_at,source_category,classified_category",
    article_id: `in.(${chunk.join(",")})`,
    limit: "200",
  });
  topicArticleRows.push(...result);
}
const topicIds = [...new Set(topicArticleRows.map((row) => row.topic_id))];
const topics: Topic[] = [];
for (let start = 0; start < topicIds.length; start += 50) {
  const chunk = topicIds.slice(start, start + 50);
  const result = await supabaseGet<Topic[]>("topics", {
    select: "id,subject,event,topic_text,category,article_count,first_seen_at,last_seen_at",
    id: `in.(${chunk.join(",")})`,
    limit: "200",
  });
  topics.push(...result);
}

const articleById = new Map(rows.map((row) => [row.article.article_id!, row]));
const relationByArticleId = new Map(topicArticleRows.map((row) => [row.article_id, row]));
const topicById = new Map(topics.map((topic) => [topic.id, topic]));
const articleRecords = rows.map(({ canonicalId, savedAt, article }) => {
  const relation = relationByArticleId.get(article.article_id!);
  const topic = relation ? topicById.get(relation.topic_id) : undefined;
  const subject = safeText(topic?.subject);
  const event = safeText(topic?.event);
  return {
    article_id: article.article_id,
    topic_id: relation?.topic_id ?? null,
    title: safeText(article.title),
    description: safeText(article.description),
    subject,
    event,
    embedding_input: subject && event ? `${subject} | ${event}` : null,
    published_at: article.published_at ?? relation?.published_at ?? null,
    saved_at: Number.isFinite(savedAt) ? new Date(savedAt).toISOString() : null,
    fetched_at: article.fetched_at ?? null,
    topic_match_method: relation?.match_method ?? null,
    merge_similarity: relation?.similarity ?? null,
    topic_article_recorded_at: relation?.created_at ?? null,
    topic_category: topic?.category ?? null,
    topic_article_count: topic?.article_count ?? null,
    topic_first_seen_at: topic?.first_seen_at ?? null,
    topic_last_seen_at: topic?.last_seen_at ?? null,
    topic_text_current: safeText(topic?.topic_text),
    topic_subject_event_scope: topic ? "current_topic_level" : null,
  };
});

const topicCounts = new Map<string, number>();
for (const article of articleRecords) if (article.topic_id) topicCounts.set(article.topic_id, (topicCounts.get(article.topic_id) ?? 0) + 1);
const topicDistribution = [...topicCounts.entries()].map(([topic_id, sample_article_count]) => ({
  topic_id,
  sample_article_count,
  total_topic_article_count: topicById.get(topic_id)?.article_count ?? null,
})).sort((a, b) => b.sample_article_count - a.sample_article_count || a.topic_id.localeCompare(b.topic_id));

const byMatchMethod = Object.fromEntries(["similarity_merge", "new_topic", "fallback_singleton", "unprocessed_or_missing_link"].map((method) => [
  method,
  articleRecords.filter((article) => (article.topic_match_method ?? "unprocessed_or_missing_link") === method).length,
]));
const candidatePairs: Array<Record<string, unknown>> = [];
for (const [topicId, count] of topicCounts) {
  if (count < 2) continue;
  const group = articleRecords.filter((article) => article.topic_id === topicId);
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      candidatePairs.push({
        article_id_a: group[i].article_id,
        article_id_b: group[j].article_id,
        topic_id: topicId,
        pair_type: "same_topic_from_existing_merge_history",
        label_status: "historical_merge_candidate_not_manually_verified",
        merge_similarity: group[j].merge_similarity,
      });
    }
  }
}

function lexicalTokens(value: string | null) {
  const normalized = (value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const chars = Array.from(normalized);
  const set = new Set<string>();
  if (chars.length <= 2) set.add(chars.join(""));
  else for (let i = 0; i < chars.length - 1; i++) set.add(chars.slice(i, i + 2).join(""));
  return set;
}
function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap++;
  return overlap / (a.size + b.size - overlap);
}
const differentTopicPairs: Array<Record<string, unknown>> = [];
const eligible = articleRecords.filter((article) => article.topic_id && article.embedding_input);
for (let i = 0; i < eligible.length; i++) {
  for (let j = i + 1; j < eligible.length; j++) {
    const a = eligible[i], b = eligible[j];
    if (a.topic_id === b.topic_id || !a.topic_category || a.topic_category !== b.topic_category) continue;
    const titleSimilarity = jaccard(lexicalTokens(a.title), lexicalTokens(b.title));
    const eventSimilarity = jaccard(lexicalTokens(a.event), lexicalTokens(b.event));
    const similarity = Math.max(titleSimilarity, eventSimilarity);
    if (similarity >= 0.25) {
      differentTopicPairs.push({
        article_id_a: a.article_id,
        article_id_b: b.article_id,
        topic_id_a: a.topic_id,
        topic_id_b: b.topic_id,
        pair_type: "different_topic_lexical_similarity_candidate",
        label_status: "manual_review_required_not_ground_truth",
        same_category: true,
        title_bigram_jaccard: titleSimilarity,
        event_bigram_jaccard: eventSimilarity,
      });
    }
  }
}
differentTopicPairs.sort((a, b) => Number(b.title_bigram_jaccard) - Number(a.title_bigram_jaccard));

await Deno.mkdir(OUTPUT, { recursive: true });
Deno.writeTextFileSync(`${OUTPUT}/articles.json`, JSON.stringify({
  schema_version: "1.0",
  extracted_at: new Date().toISOString(),
  source: {
    news_articles: "Upstash Redis ZREVRANGE newsdata:articles WITHSCORES + MGET newsdata:article:<canonical-id>",
    topic_history: "Supabase REST read of public.topic_articles joined to public.topics",
    order: "newsdata:articles descending saved-at score",
    maximum_requested: LIMIT,
    embedding_input_rule: "existing Topic subject + ' | ' + event; null if either field is missing",
    topic_fields_scope: "subject/event are current Topic-level values; per-article historical Stage 1 output is not persisted in these tables",
  },
  counts: {
    index_ids_read: canonicalIds.length,
    valid_article_records: articleRecords.length,
    invalid_or_missing_article_payloads: canonicalIds.length - articleRecords.length,
    invalid_json_or_article_shape: invalidRedisJson,
    topic_linked_articles: articleRecords.filter((article) => article.topic_id).length,
    subject_missing: articleRecords.filter((article) => !article.subject).length,
    event_missing: articleRecords.filter((article) => !article.event).length,
    embedding_input_missing: articleRecords.filter((article) => !article.embedding_input).length,
    topic_match_method: byMatchMethod,
    sampled_topics: topicCounts.size,
    repeated_topic_groups: [...topicCounts.values()].filter((count) => count >= 2).length,
    same_topic_pair_candidates: candidatePairs.length,
    different_topic_lexical_candidates: differentTopicPairs.length,
  },
  topic_distribution: topicDistribution,
  articles: articleRecords,
}, null, 2));
Deno.writeTextFileSync(`${OUTPUT}/pair_candidates.json`, JSON.stringify({
  schema_version: "1.0",
  same_topic_pairs: candidatePairs,
  different_topic_similar_candidates: differentTopicPairs,
}, null, 2));

const report = [
  "# 実ニュースEmbedding比較用データセット 抽出レポート",
  "",
  `抽出日時: ${new Date().toISOString()}`,
  "",
  "## 取得元と方法",
  "",
  "- 記事: Upstash Redisの `newsdata:articles` Sorted Setを保存時刻の降順で最大200件取得し、canonical IDから `newsdata:article:<ID>` をMGETで読み取り。",
  "- Topic・統合履歴: Supabase `topic_articles` をarticle_idで読み、`topics` のsubject/event/category等をTopic IDで結合。",
  "- すべて読み取り専用。NewsData API、Gemini Embedding、Upstash Vectorは呼び出していない。",
  "- 公開URL、画像URL、source_name、カテゴリ配列、利用者情報は保存対象外。本文内のURL・メール・電話番号らしき値は伏字化。",
  "",
  "## 件数・欠損",
  "",
  `- Redis index ID: ${canonicalIds.length}; 取得記事: ${articleRecords.length}; 不正JSON/shape: ${invalidRedisJson}; payload欠損: ${canonicalIds.length - articleRecords.length}`,
  `- Topic紐付け: ${articleRecords.filter((article) => article.topic_id).length}; subject欠損: ${articleRecords.filter((article) => !article.subject).length}; event欠損: ${articleRecords.filter((article) => !article.event).length}; embedding_input欠損: ${articleRecords.filter((article) => !article.embedding_input).length}`,
  `- Topic match method: ${JSON.stringify(byMatchMethod)}`,
  `- Topic数: ${topicCounts.size}; 同一Topic複数記事グループ: ${[...topicCounts.values()].filter((count) => count >= 2).length}; 同一Topic pair候補: ${candidatePairs.length}`,
  `- 異Topic・同カテゴリの語彙類似候補: ${differentTopicPairs.length}（bigram Jaccardによる抽出。正解ラベルではなく、手動確認候補）`,
  "",
  "## Topic別サンプル分布",
  "",
  "| Topic ID | 今回の記事数 | Topic全記事数 |",
  "|---|---:|---:|",
  ...topicDistribution.map((row) => `| ${row.topic_id} | ${row.sample_article_count} | ${row.total_topic_article_count ?? "不明"} |`),
  "",
  "## 解釈上の注意",
  "",
  "- CURRENT_SPECではEmbedding入力はGemma生成の `subject | event`。Redisには記事情報、Supabase topicsには現在のTopic単位subject/eventが保存されるため、記事ごとの過去Stage 1 subject/eventは復元できない。今回は既存Topicの現在値を利用し、Topic未処理・リンクなし・subject/event欠損は推測で補わずnullとした。",
  "- `similarity_merge` は既存統合履歴の候補であり、過去の統合が正しいとは限らない。正例候補も無条件な正解データとはしない。",
  "- 異なるTopicの語彙類似候補はハードネガティブ候補として抽出し、手動確認前は評価正解ラベルにしない。",
  "- 保存時刻Sorted Setは現行仕様の保持期間により通常直近7日分。Upstash Redisのread-only credentialで読めた範囲を使用。",
].join("\n");
Deno.writeTextFileSync(`${OUTPUT}/report.md`, report);

// Do not print URLs, API values, article text, or credentials.
console.log(JSON.stringify({
  status: "complete",
  articles: articleRecords.length,
  topicLinked: articleRecords.filter((article) => article.topic_id).length,
  subjectMissing: articleRecords.filter((article) => !article.subject).length,
  eventMissing: articleRecords.filter((article) => !article.event).length,
  sameTopicPairs: candidatePairs.length,
  differentTopicCandidates: differentTopicPairs.length,
}));
