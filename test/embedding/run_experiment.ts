const ROOT = `${Deno.cwd()}/test/embedding`;
const RESULT_DIR = `${ROOT}/results`;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY");
const VECTOR_URL = Deno.env.get("UPSTASH_VECTOR_REST_URL")?.replace(/\/$/, "");
const VECTOR_TOKEN = Deno.env.get("UPSTASH_VECTOR_REST_TOKEN");
if (!GEMINI_KEY || !VECTOR_URL || !VECTOR_TOKEN) {
  throw new Error("required_environment_missing");
}

type Article = {
  id: string;
  embedding_input: string;
  ground_truth_topic: string;
};
type Pair = { a: string; b: string; same_event: boolean; kind: string };
type ApiStats = { requests: number; failures: number; elapsed_ms: number[]; usage: unknown[] };
const articles = (JSON.parse(Deno.readTextFileSync(`${ROOT}/dataset.json`)) as { articles: Article[] }).articles;
const pairs = Deno.readTextFileSync(`${ROOT}/evaluation_pairs.csv`).trim().split(/\r?\n/).slice(1).map((line) => {
  const [a, b, same, kind] = line.split(",");
  return { a, b, same_event: same === "True", kind } satisfies Pair;
});
const byId = new Map(articles.map((article) => [article.id, article]));
const probes: string[] = [];
const models = [
  { id: "gemini-embedding-001", kind: "google" as const, dimensions: 384 },
  { id: "gemini-embedding-2", kind: "google" as const, dimensions: 384 },
  { id: "upstash-text-embedding-3-small", kind: "upstash" as const, dimensions: 1536 },
];
const NAMESPACE = "embedding-exp-20260926";

function cosine(a: number[], b: number[]) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function requestJson(url: string, init: RequestInit, stats: ApiStats) {
  stats.requests++;
  const start = performance.now();
  try {
    const response = await fetch(url, init);
    stats.elapsed_ms.push(performance.now() - start);
    if (!response.ok) {
      stats.failures++;
      const error = new Error(`http_${response.status}`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (!(error instanceof Error && "status" in error)) {
      stats.failures++;
      stats.elapsed_ms.push(performance.now() - start);
    }
    throw error;
  }
}

async function embedGoogle(model: string, texts: string[], stats: ApiStats) {
  const result = await requestJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY! },
      body: JSON.stringify({ requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        outputDimensionality: 384,
      })) }),
    },
    stats,
  ) as { embeddings?: Array<{ values?: number[] }>; usageMetadata?: unknown };
  stats.usage.push(result.usageMetadata ?? null);
  const vectors = result.embeddings?.map((item) => item.values ?? []) ?? [];
  if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== 384)) {
    throw new Error("embedding_shape_invalid");
  }
  return vectors;
}

async function embedUpstashData(id: string, text: string, stats: ApiStats) {
  const result = await requestJson(`${VECTOR_URL}/upsert-data/${NAMESPACE}`, {
    method: "POST",
    headers: { authorization: `Bearer ${VECTOR_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ id, data: text, metadata: { experiment: "ai-speed-embedding-30" } }),
  }, stats);
  return result;
}

async function vectorCommand(path: string, body: unknown, stats: ApiStats, namespace = NAMESPACE) {
  return await requestJson(`${VECTOR_URL}/${path}/${namespace}`, {
    method: "POST",
    headers: { authorization: `Bearer ${VECTOR_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }, stats);
}

function evaluate(vectors: Map<string, number[]>, threshold: number, externalScores?: Map<string, Map<string, number>>) {
  const anchors = articles.filter((article) => Number(article.id.slice(1)) % 2 === 1);
  const queries = articles.filter((article) => Number(article.id.slice(1)) % 2 === 0);
  const ranked = queries.map((query) => ({
    query: query.id,
    truth: query.ground_truth_topic,
    matches: anchors.map((anchor) => ({
      id: anchor.id,
      topic: anchor.ground_truth_topic,
      score: externalScore(externalScores, query.id, anchor.id, vectors),
    })).sort((a, b) => b.score - a.score),
  }));
  const topK = (k: number) => ranked.filter((row) => row.matches.slice(0, k).some((match) => match.topic === row.truth)).length / ranked.length;
  const thresholds = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.88, 0.9, 0.92, 0.95];
  const thresholdSweep = thresholds.map((value) => {
    let tp = 0, fp = 0, fn = 0;
    for (const row of ranked) {
      const best = row.matches[0];
      if (best.score >= value && best.topic === row.truth) tp++;
      else if (best.score >= value) fp++;
      else fn++;
    }
    return { threshold: value, true_merge: tp, false_merge: fp, missed_merge: fn };
  });
  const pairScores = pairs.map((pair) => ({
    ...pair,
    score: externalScore(externalScores, pair.a, pair.b, vectors),
  }));
  if (pairScores.some((pair) => !Number.isFinite(pair.score))) {
    throw new Error("evaluation_pair_score_missing");
  }
  const pairStats = Object.fromEntries(["positive", "hard_negative", "easy_negative"].map((kind) => {
    const group = pairScores.filter((pair) => pair.kind === kind);
    return [kind, { count: group.length, mean_cosine: group.reduce((sum, pair) => sum + pair.score, 0) / group.length, min_cosine: Math.min(...group.map((pair) => pair.score)), max_cosine: Math.max(...group.map((pair) => pair.score)) }];
  }));
  const currentThreshold = threshold === 0.88 ? 0.88 : null;
  const current = currentThreshold == null ? null : thresholdSweep.find((item) => item.threshold === currentThreshold)!;
  return {
    top1_accuracy: topK(1), top3_accuracy: topK(3), top5_accuracy: topK(5),
    false_merge_rate_at_0_88: current ? current.false_merge / ranked.length : null,
    missed_merge_rate_at_0_88: current ? current.missed_merge / ranked.length : null,
    cosine_distribution_by_pair_kind: pairStats,
    threshold_sweep: thresholdSweep,
    recommended_threshold: thresholdSweep.slice().sort((a, b) => (b.true_merge - b.false_merge) - (a.true_merge - a.false_merge))[0].threshold,
    ranked_results: ranked,
    pair_scores: pairScores,
  };
}

function externalScore(
  externalScores: Map<string, Map<string, number>> | undefined,
  a: string,
  b: string,
  vectors: Map<string, number[]>,
) {
  if (externalScores) {
    const score = externalScores.get(a)?.get(b) ?? externalScores.get(b)?.get(a);
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error(`external_score_missing_${a}_${b}`);
    }
    return score;
  }
  return cosine(vectors.get(a)!, vectors.get(b)!);
}

await Deno.mkdir(RESULT_DIR, { recursive: true });
const results: Record<string, unknown> = {};
for (const model of models) {
  const stats: ApiStats = { requests: 0, failures: 0, elapsed_ms: [], usage: [] };
  const vectors = new Map<string, number[]>();
  const anchorIds = articles.filter((article) => Number(article.id.slice(1)) % 2 === 1).map((article) => article.id);
  if (model.kind === "google") {
    const values = await embedGoogle(model.id, articles.map((article) => article.embedding_input), stats);
    articles.forEach((article, index) => vectors.set(article.id, values[index]));
  } else {
    const vectorIds = new Map(articles.map((article) => [article.id, `embedding-exp-${article.id.toLowerCase()}`]));
    probes.push(...vectorIds.values());
    // The configured Vector index embeds and stores data by its selected OpenAI model.
    for (const article of articles.filter((item) => Number(item.id.slice(1)) % 2 === 1)) {
      await embedUpstashData(vectorIds.get(article.id)!, article.embedding_input, stats);
    }
    // Query all held-out inputs plus pair endpoints needed to score anchor-anchor pairs.
    const upstashScores = new Map<string, Map<string, number>>();
    const queryIds = [...new Set([
      ...articles.filter((item) => Number(item.id.slice(1)) % 2 === 0).map((item) => item.id),
      ...pairs.flatMap((pair) => [pair.a, pair.b]),
    ])];
    const vectorIdToArticle = new Map(Array.from(vectorIds, ([articleId, vectorId]) => [vectorId.toLowerCase(), articleId]));
    for (const queryId of queryIds) {
      const article = byId.get(queryId)!;
      let rows: Array<{ id: string; score: number; metadata?: { article_id?: string } }> = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await vectorCommand("query-data", { data: article.embedding_input, topK: 15, includeMetadata: true }, stats) as { result?: typeof rows };
        rows = response.result ?? [];
        if (rows.length === 15 && rows.every((row) => typeof row.score === "number" && Number.isFinite(row.score))) break;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 700));
      }
      if (rows.length !== 15 || rows.some((row) => typeof row.score !== "number" || !Number.isFinite(row.score))) {
        throw new Error(`upstash_incomplete_scores_${queryId}`);
      }
      const scoreMap = new Map<string, number>();
      for (const row of rows) {
        const candidateId = row.metadata?.article_id ?? vectorIdToArticle.get(row.id.toLowerCase());
        if (candidateId) scoreMap.set(candidateId, row.score);
      }
      if (scoreMap.size !== 15) throw new Error(`upstash_candidate_id_mapping_${queryId}`);
      upstashScores.set(queryId, scoreMap);
    }
    // Replace local cosine scores with the server-side scores from the same configured model.
    const scoreVectors = new Map<string, number[]>();
    for (const article of articles) scoreVectors.set(article.id, [0]);
    const evalScores = upstashScores;
    results[model.id] = {
      dimensions: model.dimensions,
      embedding_requests: 30,
      api_request_count: stats.requests,
      api_failures: stats.failures,
      mean_request_latency_ms: stats.elapsed_ms.reduce((sum, value) => sum + value, 0) / stats.elapsed_ms.length,
      per_article_embedding_latency_ms: stats.elapsed_ms.slice(0, anchorIds.length).reduce((sum, value) => sum + value, 0) / anchorIds.length,
      query_data_request_count: stats.requests - anchorIds.length,
      measured_google_usage_metadata: [],
      score_coverage: {
        queries: articles.filter((item) => Number(item.id.slice(1)) % 2 === 0).length,
        expected_candidates_per_query: anchorIds.length,
        queries_with_all_scores: articles.filter((item) => Number(item.id.slice(1)) % 2 === 0).length,
        queries_with_correct_and_other_topic_candidates: articles.filter((item) => Number(item.id.slice(1)) % 2 === 0).length,
        pairs_scored: pairs.length,
        missing_score_sentinel_used: false,
      },
      evaluation: evaluate(scoreVectors, 0.88, evalScores),
    };
    console.log(JSON.stringify({ model: model.id, status: "completed", requests: stats.requests, failures: stats.failures }));
    continue;
  }
  results[model.id] = {
    dimensions: model.dimensions,
    embedding_requests: stats.requests,
    api_request_count: stats.requests,
    api_failures: stats.failures,
    mean_request_latency_ms: stats.elapsed_ms.reduce((sum, value) => sum + value, 0) / stats.elapsed_ms.length,
    per_article_embedding_latency_ms: model.kind === "google" ? stats.elapsed_ms[0] / articles.length : stats.elapsed_ms.slice(0, articles.length).reduce((sum, value) => sum + value, 0) / articles.length,
    measured_google_usage_metadata: stats.usage,
    evaluation: evaluate(vectors, 0.88),
  };
  console.log(JSON.stringify({ model: model.id, status: "completed", requests: stats.requests, failures: stats.failures }));
}

let cleanupOk = true;
let cleanupError: string | null = null;
if (probes.length) {
  const cleanupStats: ApiStats = { requests: 0, failures: 0, elapsed_ms: [], usage: [] };
  try {
    await vectorCommand("delete", { ids: probes }, cleanupStats);
    const remaining = await vectorCommand("fetch", { prefix: "embedding-exp-" }, cleanupStats) as { result?: unknown[] };
    cleanupOk = Array.isArray(remaining.result) && remaining.result.length === 0;
  } catch (error) {
    cleanupOk = false;
    cleanupError = error instanceof Error && "status" in error ? `http_${(error as Error & {status:number}).status}` : "request_failed";
  }
}

const report = {
  schema_version: "1.0",
  generated_at: new Date().toISOString(),
  dataset: { article_count: articles.length, anchor_count: 15, query_count: 15, pair_count: pairs.length, synthetic: true, input_field: "embedding_input" },
  methodology: { top_k_anchor_rule: "odd numbered articles as anchors; even numbered articles as queries", ranking: "cosine similarity descending", google_dimensions: 384, upstash_dimensions: 1536, positive_definition: "same ground_truth_topic", false_merge_at_threshold: "top1 from a different ground_truth_topic exceeds threshold", upstash_namespace: NAMESPACE, note: "Google vectors scored by local cosine. Upstash native query-data scores used; Upstash endpoint returns cosine scores for this index." },
  results,
  upstash_cleanup: { attempted_ids: probes.length, success: cleanupOk, error: cleanupError },
  limitations: ["30 articles are synthetic smoke-test data, not production news.", "Google usageMetadata is returned by the API when available; no billing amount is exposed by the API response.", "Upstash request pricing depends on account plan; actual per-request latency is recorded.", "Threshold sweep is exploratory on this small dataset and is not a held-out validation."],
};
Deno.writeTextFileSync(`${RESULT_DIR}/embedding_comparison.json`, JSON.stringify(report, null, 2));
const md = [
  "# Embedding 30記事比較結果",
  "",
  `生成日時: ${report.generated_at}`,
  "",
  "架空データ30記事（15アンカー・15クエリ）で比較。入力は `embedding_input` のみ。類似度は各モデル内のcosine。",
  "",
  "| モデル | 次元 | Top1 | Top3 | Top5 | 閾値0.88誤統合率 | 閾値0.88統合漏れ率 | 平均Embedding時間/記事 (ms) | API要求数 | 失敗数 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...models.map((model) => {
    const item = results[model.id] as any;
    const ev = item.evaluation;
    return `| ${model.id} | ${item.dimensions} | ${(ev.top1_accuracy * 100).toFixed(1)}% | ${(ev.top3_accuracy * 100).toFixed(1)}% | ${(ev.top5_accuracy * 100).toFixed(1)}% | ${ev.false_merge_rate_at_0_88 == null ? "対象外" : (ev.false_merge_rate_at_0_88 * 100).toFixed(1) + "%"} | ${ev.missed_merge_rate_at_0_88 == null ? "対象外" : (ev.missed_merge_rate_at_0_88 * 100).toFixed(1) + "%"} | ${item.per_article_embedding_latency_ms.toFixed(1)} | ${item.api_request_count} | ${item.api_failures} |`;
  }),
  "",
  "## 注意事項",
  "",
  "- Google API応答のusageMetadataはJSON成果物に保存。APIから料金額は取得できないため、請求金額は未確認。",
  "- Upstashの料金は契約プランに依存するため未算出。API要求数と実測時間を記録。",
  "- Upstash候補が15件・数値scoreで揃わない場合、欠損値で補完せずrunnerを停止する。",
  "- 閾値一覧は同じ30記事上の探索値であり、独立評価データでの妥当性確認が必要。",
  `- Upstash一時レコード削除確認: ${cleanupOk ? "成功" : "失敗（要確認）"}。`,
].join("\n");
Deno.writeTextFileSync(`${RESULT_DIR}/embedding_comparison.md`, md);
if (!cleanupOk) throw new Error("upstash_cleanup_unconfirmed");
