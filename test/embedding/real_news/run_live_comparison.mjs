import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/^([A-Za-z]):/, '$1:'));
const resultDir = path.join(root, 'results');
const excludedId = 'c96c4c82261d885d1c7b37fb5690a4ea';
const models = [
  { key: 'gemini-embedding-001', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents' },
  { key: 'gemini-embedding-2', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents' },
];
const thresholds = Array.from({ length: 16 }, (_, i) => +(0.8 + i * 0.01).toFixed(2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finiteVector = v => Array.isArray(v) && v.length > 0 && v.every(Number.isFinite);

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[m[1]] = value;
  }
  return env;
}

async function writeJson(file, value) {
  await fs.writeFile(path.join(resultDir, file), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function safeFetch(url, options = {}, timeoutMs = 120000) {
  const started = performance.now();
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const elapsedMs = performance.now() - started;
  let body = null;
  try { body = await response.json(); } catch { /* response body is not logged */ }
  return { response, body, elapsedMs };
}

function errorRecord(stage, error, status = null) {
  return { stage, status, name: error?.name || 'Error', message: String(error?.message || error).slice(0, 240), at: new Date().toISOString() };
}

function cosine(a, b) {
  if (!finiteVector(a) || !finiteVector(b) || a.length !== b.length) throw new Error('Invalid or mismatched embedding vector');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function stats(values) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return { count: 0, min: null, q1: null, median: null, mean: null, q3: null, max: null };
  const quantile = p => a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
  return { count: a.length, min: a[0], q1: quantile(.25), median: quantile(.5), mean: a.reduce((s, x) => s + x, 0) / a.length, q3: quantile(.75), max: a.at(-1) };
}

function metricRows(pairScores) {
  return thresholds.map(threshold => {
    const labeled = pairScores.filter(p => p.label !== 'uncertain');
    const merge = labeled.filter(p => p.label === 'merge');
    const separate = labeled.filter(p => p.label === 'separate');
    const misses = merge.filter(p => p.cosine < threshold).length;
    const falseMerges = separate.filter(p => p.cosine >= threshold).length;
    return { threshold, merge_count: merge.length, separate_count: separate.length, uncertain_excluded: pairScores.filter(p => p.label === 'uncertain').length,
      false_merge_count: falseMerges, false_merge_rate: falseMerges / separate.length,
      missed_merge_count: misses, missed_merge_rate: misses / merge.length,
      accuracy: (merge.length - misses + separate.length - falseMerges) / labeled.length };
  });
}

function markdown(result) {
  const out = ['# 実ニュース Embedding 比較実験', '', `実行日時: ${result.started_at} ～ ${result.finished_at}`, '',
    '## 条件', '', `対象記事: ${result.dataset.included_articles}件（除外 ${excludedId}）`, `評価ペア: ${result.dataset.pairs}件（merge ${result.dataset.labels.merge}, separate ${result.dataset.labels.separate}, uncertain ${result.dataset.labels.uncertain}; uncertainは正解率から除外）`,
    `Google入力: 同一内容を各記事1回。合計 ${result.google_expected.input_tokens_per_model} tokens/モデル。各モデル20バッチ、最大10件/リクエスト、6秒間隔。`,
    '記事固有入力（title + description）を変更せず使用。Upstashはこの実験の固有namespaceだけに一時登録し、終了時に今回のIDを削除。', '',
    '## モデル比較', '', '| モデル | 次元 | 入力/クエリ件数 | API呼び出し | 平均時間/記事 | 類似度（全ペア） | merge | separate | uncertain |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [name, m] of Object.entries(result.models)) {
    const s = m.distributions.all;
    out.push(`| ${name} | ${m.dimensions} | ${m.usage.input_articles ?? m.usage.query_articles ?? 0} | ${m.usage.api_requests} | ${(m.timing.mean_ms_per_article ?? 0).toFixed(1)} ms | ${(s?.min ?? 0).toFixed(3)} / ${(s?.median ?? 0).toFixed(3)} / ${(s?.mean ?? 0).toFixed(3)} / ${(s?.max ?? 0).toFixed(3)} | ${(m.distributions.merge?.mean ?? 0).toFixed(3)} | ${(m.distributions.separate?.mean ?? 0).toFixed(3)} | ${(m.distributions.uncertain?.mean ?? 0).toFixed(3)} |`);
  }
  out.push('', '類似度欄は min / median / mean / max。各ペアの判定閾値表はJSONに全値を保存。', '', '## 閾値別評価', '');
  for (const [name, m] of Object.entries(result.models)) {
    out.push(`### ${name}`, '', '| 閾値 | 誤統合 (separate/20) | 統合漏れ (merge/10) | accuracy |', '|---:|---:|---:|---:|');
    for (const r of m.threshold_metrics) out.push(`| ${r.threshold.toFixed(2)} | ${r.false_merge_count} (${(r.false_merge_rate * 100).toFixed(1)}%) | ${r.missed_merge_count} (${(r.missed_merge_rate * 100).toFixed(1)}%) | ${(r.accuracy * 100).toFixed(1)}% |`);
    out.push('');
  }
  out.push('## 199記事・24時間時系列シミュレーション', '', '各時点で直前24時間の記事との記事ベクトル類似度を調べる近傍候補シミュレーション。既存Topicの統合処理そのものを再現したものではない。34評価ペアに含まれる候補はラベル別に集計し、それ以外は未判定として要確認に分離。未判定候補を正誤率に含めない。', '');
  for (const [name, sim] of Object.entries(result.simulations)) {
    out.push(`### ${name}`, '', '| 閾値 | 候補あり記事 | ラベルmerge | ラベルseparate | uncertain | 未判定（要確認） |', '|---:|---:|---:|---:|---:|---:|');
    for (const r of sim.threshold_summary) out.push(`| ${r.threshold.toFixed(2)} | ${r.proposed_articles} | ${r.merge} | ${r.separate} | ${r.uncertain} | ${r.unlabeled_requires_review} |`);
    out.push('');
  }
  out.push('## 異なる出来事で類似度が高い具体例', '', 'separateラベルのうち、各モデルで上位のスコアを記録したペア。タイトルを入力データからそのまま引用。', '');
  const perModel = Object.entries(result.models);
  const ids = new Set(perModel.flatMap(([, m]) => [...m.pair_scores].filter(p => p.label === 'separate').sort((a, b) => b.cosine - a.cosine).slice(0, 5).map(p => p.pair_key)));
  out.push('| ペア | 判定理由 | ' + perModel.map(([name]) => name).join(' | ') + ' |');
  out.push('|---|---|' + perModel.map(() => '---:').join('|') + '|');
  for (const key of ids) {
    const p = perModel[0][1].pair_scores.find(x => x.pair_key === key);
    out.push(`| ${p.title_a} ↔ ${p.title_b} | ${p.reason} | ${perModel.map(([, m]) => { const match = m.pair_scores.find(x => x.pair_key === key); return Number.isFinite(match?.cosine) ? match.cosine.toFixed(3) : 'N/A'; }).join(' | ')} |`);
  }
  out.push('', '## 実行量・失敗・後片付け', '', `Google: ${JSON.stringify(result.google_usage_summary)}`, `Upstash: ${JSON.stringify(result.models.upstash_text_embedding_3_small.usage)}`, `失敗: ${result.errors.length ? JSON.stringify(result.errors) : 'なし'}`, `Upstash cleanup: ${JSON.stringify(result.cleanup)}`, '', 'コストはGoogle API応答に料金情報が含まれないため、実課金額は観測できない。使用量とAPI呼び出しをJSONへ記録。実験用Upstash namespace内の今回作成IDは削除・検証済み。', '');
  return out.join('\n');
}

await fs.mkdir(resultDir, { recursive: true });
const envText = await fs.readFile(path.join(root, '..', '..', '..', '.env.server'), 'utf8');
const env = parseEnv(envText);
const googleKey = env.GEMINI_API_KEY;
const vectorUrl = env.UPSTASH_VECTOR_REST_URL;
const vectorToken = env.UPSTASH_VECTOR_REST_TOKEN;
if (!googleKey || !vectorUrl || !vectorToken) throw new Error('Required connection keys are missing; values are not printed.');

const articleDoc = JSON.parse(await fs.readFile(path.join(root, 'articles.json'), 'utf8'));
const inputDoc = JSON.parse(await fs.readFile(path.join(root, 'article_specific_inputs.json'), 'utf8'));
const reviewDoc = JSON.parse(await fs.readFile(path.join(root, 'pair_review_expanded.json'), 'utf8'));
const pairDocs = [...reviewDoc.existing_pair_reviews, ...reviewDoc.additional_pairs];
const rawArticles = articleDoc.articles;
const inputById = new Map(inputDoc.articles.map(a => [a.article_id, a]));
const articleById = new Map(rawArticles.map(a => [a.article_id, a]));
const included = rawArticles.filter(a => a.article_id !== excludedId).map(a => {
  const input = inputById.get(a.article_id);
  if (!input || typeof input.article_input !== 'string') throw new Error(`Missing article-specific input for ${a.article_id}`);
  return { ...a, article_input: input.article_input };
});
const includedIds = new Set(included.map(a => a.article_id));
const labelCounts = Object.fromEntries(['merge', 'separate', 'uncertain'].map(k => [k, pairDocs.filter(p => p.label === k).length]));
if (included.length !== 199 || pairDocs.length !== 34 || labelCounts.merge !== 10 || labelCounts.separate !== 20 || labelCounts.uncertain !== 4 || pairDocs.some(p => !includedIds.has(p.article_id_a) || !includedIds.has(p.article_id_b))) {
  throw new Error('Preflight failed: article or pair coverage/label counts do not match requirements.');
}
const inputTokensPerModel = 22086;
const upstashNamespace = `real-news-exp-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
const baseUrl = vectorUrl.replace(/\/$/, '');
const vectorHeaders = { Authorization: `Bearer ${vectorToken}`, 'Content-Type': 'application/json' };
let resumedModels = {};
try {
  const previous = JSON.parse(await fs.readFile(path.join(resultDir, 'real_news_embedding_comparison.json'), 'utf8'));
  if (previous.dataset?.excluded_article_id === excludedId && previous.dataset?.included_articles === 199) resumedModels = previous.models || {};
} catch { /* first run */ }
const result = {
  schema_version: '1.0', started_at: new Date().toISOString(), finished_at: null,
  dataset: { source: 'articles.json + article_specific_inputs.json + pair_review_expanded.json', total_original_articles: rawArticles.length, included_articles: included.length, excluded_article_id: excludedId, unique_inputs: new Set(included.map(a => a.article_input)).size, pairs: pairDocs.length, labels: labelCounts },
  google_expected: { input_tokens_per_model: inputTokensPerModel, requests_per_model: 20, articles_per_request_max: 10, min_delay_between_requests_ms: 6000, limits_documented: { rpm: 100, tpm: 30000, rpd: 1000 }, rationale: 'Batch calls are paced far below documented RPM/TPM; expected requests remain below documented daily cap. Project remaining usage is not exposed by the API and is unknown.' },
  upstash: { namespace: upstashNamespace, dimensions: 1536, similarity_function: 'COSINE', cosine_conversion: 'raw cosine = 2 * Upstash normalized score - 1' },
  models: resumedModels, simulations: {}, errors: [], cleanup: { attempted: false, deleted_ids: 0, verified_absent: false, error: null }, google_usage_summary: {},
};
await writeJson('real_news_embedding_comparison.json', result);

let vectorNamespaceReady = false;
try {
  // Google embedding batch calls. One attempt per batch; any API failure stops that model.
  for (const model of models) {
    if (result.models[model.key]?.article_vectors && Object.keys(result.models[model.key].article_vectors).length === 199) continue;
    const vectors = new Map(), calls = [], usage = { input_articles: included.length, api_requests: 0, api_calls_completed: 0, total_input_tokens: 0, usage_metadata: [], failure_processed_articles: null };
    const modelStart = performance.now();
    let failed = false;
    for (let offset = 0; offset < included.length; offset += 10) {
      if (offset > 0) await sleep(6000);
      const batch = included.slice(offset, offset + 10);
      const payload = { requests: batch.map(a => ({ model: `models/${model.key}`, content: { parts: [{ text: a.article_input }] }, outputDimensionality: 384 })) };
      usage.api_requests++;
      try {
        const { response, body, elapsedMs } = await safeFetch(`${model.endpoint}?key=${encodeURIComponent(googleKey)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        calls.push(elapsedMs);
        if (!response.ok) {
          const e = new Error(`Google API HTTP ${response.status}`);
          result.errors.push(errorRecord(model.key, e, response.status));
          usage.failure_processed_articles = vectors.size;
          failed = true;
          break;
        }
        const embeddings = body?.embeddings;
        if (!Array.isArray(embeddings) || embeddings.length !== batch.length || embeddings.some(e => !finiteVector(e.values) || e.values.length !== 384)) {
          result.errors.push(errorRecord(model.key, new Error('Invalid embedding response shape or dimension')));
          usage.failure_processed_articles = vectors.size;
          failed = true;
          break;
        }
        embeddings.forEach((e, i) => vectors.set(batch[i].article_id, e.values));
        usage.api_calls_completed++;
        const meta = body?.usageMetadata || null;
        if (meta) { usage.usage_metadata.push(meta); usage.total_input_tokens += Number(meta.promptTokenCount || 0); }
      } catch (error) {
        result.errors.push(errorRecord(model.key, error));
        usage.failure_processed_articles = vectors.size;
        failed = true;
        break;
      }
    }
    if (!failed) usage.failure_processed_articles = null;
    const pairScores = [];
    if (!failed) for (const p of pairDocs) pairScores.push({ ...p, pair_key: [p.article_id_a, p.article_id_b].sort().join(':'), title_a: articleById.get(p.article_id_a).title, title_b: articleById.get(p.article_id_b).title, cosine: cosine(vectors.get(p.article_id_a), vectors.get(p.article_id_b)) });
    result.models[model.key] = { dimensions: 384, usage, timing: { total_ms: performance.now() - modelStart, mean_batch_ms: calls.length ? calls.reduce((s, x) => s + x, 0) / calls.length : null, mean_ms_per_article: vectors.size ? calls.reduce((s, x) => s + x, 0) / vectors.size : null, batch_latencies_ms: calls }, article_vectors: Object.fromEntries(vectors), pair_scores: pairScores, distributions: {}, threshold_metrics: failed ? [] : metricRows(pairScores) };
    if (failed) break;
    await writeJson('real_news_embedding_comparison.json', result);
  }

  if (result.models[models[0].key]?.article_vectors && Object.keys(result.models[models[0].key].article_vectors).length === 199 && result.models[models[1].key]?.article_vectors && Object.keys(result.models[models[1].key].article_vectors).length === 199) {
    // Validate a fresh namespace before any write.
    const info = await safeFetch(`${baseUrl}/info`, { headers: vectorHeaders }, 30000);
    if (!info.response.ok) throw Object.assign(new Error(`Upstash info HTTP ${info.response.status}`), { stage: 'upstash_info', status: info.response.status });
    const infoText = JSON.stringify(info.body || {});
    if (!/1536/.test(infoText) || !/COSINE/i.test(infoText) || /text-embedding-3-small/i.test(infoText) === false) throw Object.assign(new Error('Upstash index does not match expected model, dimension, or cosine configuration'), { stage: 'upstash_config' });
    if (infoText.includes(upstashNamespace)) throw Object.assign(new Error('Generated Upstash namespace unexpectedly already exists'), { stage: 'upstash_namespace_precheck' });
    const ids = included.map(a => `rn-${a.article_id}`);
    vectorNamespaceReady = true;
    const t0 = performance.now();
    let upsertMs = null, fetchMs = null, fetchRequests = 0, queryArticles = 0;
    try {
      const upsert = await safeFetch(`${baseUrl}/upsert-data/${encodeURIComponent(upstashNamespace)}`, { method: 'POST', headers: vectorHeaders, body: JSON.stringify(included.map((a, i) => ({ id: ids[i], data: a.article_input, metadata: { article_id: a.article_id } }))) }, 180000);
      upsertMs = upsert.elapsedMs;
      if (!upsert.response.ok) throw Object.assign(new Error(`Upstash upsert HTTP ${upsert.response.status}`), { stage: 'upstash_upsert', status: upsert.response.status });
      await sleep(1200);
      const fetched = await safeFetch(`${baseUrl}/fetch/${encodeURIComponent(upstashNamespace)}`, { method: 'POST', headers: vectorHeaders, body: JSON.stringify({ ids, includeVectors: true, includeMetadata: true }) }, 180000);
      fetchRequests++;
      fetchMs = fetched.elapsedMs;
      if (!fetched.response.ok) throw Object.assign(new Error(`Upstash fetch HTTP ${fetched.response.status}`), { stage: 'upstash_fetch', status: fetched.response.status });
      const rows = Array.isArray(fetched.body) ? fetched.body : fetched.body?.result;
      if (!Array.isArray(rows) || rows.length !== included.length) throw Object.assign(new Error('Upstash fetch response count mismatch'), { stage: 'upstash_fetch_shape' });
      const vectors = new Map();
      rows.forEach((row, i) => {
        if (row?.id !== ids[i] || !finiteVector(row?.vector) || row.vector.length !== 1536) throw Object.assign(new Error(`Upstash vector missing or dimension mismatch at index ${i}`), { stage: 'upstash_fetch_vector' });
        vectors.set(included[i].article_id, row.vector);
      });
      queryArticles = vectors.size;
      const scores = new Map(included.map(a => [a.article_id, new Map(included.map(b => [b.article_id, cosine(vectors.get(a.article_id), vectors.get(b.article_id))]))]));
      const pairScores = pairDocs.map(p => ({ ...p, pair_key: [p.article_id_a, p.article_id_b].sort().join(':'), title_a: articleById.get(p.article_id_a).title, title_b: articleById.get(p.article_id_b).title, cosine: scores.get(p.article_id_a).get(p.article_id_b) }));
      if (pairScores.some(p => !Number.isFinite(p.cosine))) throw new Error('Pair score missing or non-finite');
      result.models.upstash_text_embedding_3_small = { dimensions: 1536, usage: { query_articles: queryArticles, upsert_articles: included.length, api_requests: 1 + fetchRequests + 1, upsert_http_requests: 1, query_http_requests: 0, fetch_http_requests: fetchRequests, cleanup_http_requests: 1, command_units_estimated: included.length * 2 + fetchRequests, namespace: upstashNamespace, similarity_calculation: 'client-side cosine from vectors returned by Upstash fetch' }, timing: { total_ms: performance.now() - t0, upsert_ms: upsertMs, fetch_ms: fetchMs, mean_ms_per_article: (upsertMs + fetchMs) / queryArticles }, article_vectors: Object.fromEntries(vectors), article_score_rows: Object.fromEntries([...scores].map(([id, m]) => [id, Object.fromEntries(m)])), pair_scores: pairScores, distributions: {}, threshold_metrics: metricRows(pairScores) };
    } catch (error) {
      result.errors.push(errorRecord(error.stage || 'upstash_operation', error, error.status || null));
      result.models.upstash_text_embedding_3_small = { dimensions: 1536, usage: { query_articles: queryArticles, upsert_articles: included.length, api_requests: 1 + fetchRequests, upsert_http_requests: upsertMs === null ? 0 : 1, query_http_requests: 0, fetch_http_requests: fetchRequests, command_units_estimated: included.length + queryArticles, namespace: upstashNamespace }, timing: { upsert_ms: upsertMs, fetch_ms: fetchMs }, pair_scores: [], distributions: {}, threshold_metrics: [] };
    }
  }
} catch (error) {
  result.errors.push(errorRecord(error.stage || 'experiment', error, error.status || null));
}

// Delete only this run's deterministic IDs, and verify they are absent.
if (vectorNamespaceReady) {
  result.cleanup.attempted = true;
  try {
    const ids = included.map(a => `rn-${a.article_id}`);
    const del = await safeFetch(`${baseUrl}/delete/${encodeURIComponent(upstashNamespace)}`, { method: 'POST', headers: vectorHeaders, body: JSON.stringify({ ids }) }, 60000);
    if (!del.response.ok) throw new Error(`Upstash delete HTTP ${del.response.status}`);
    result.cleanup.deleted_ids = ids.length;
    const verify = await safeFetch(`${baseUrl}/fetch/${encodeURIComponent(upstashNamespace)}`, { method: 'POST', headers: vectorHeaders, body: JSON.stringify({ ids }) }, 60000);
    if (!verify.response.ok) throw new Error(`Upstash cleanup verification HTTP ${verify.response.status}`);
    const entries = Array.isArray(verify.body) ? verify.body : verify.body?.vectors || verify.body?.result || [];
    result.cleanup.verified_absent = ids.every(id => !entries.some(v => v?.id === id && (v?.vector || v?.data)));
    if (!result.cleanup.verified_absent) throw new Error('Some run-owned IDs remain after delete');
  } catch (error) {
    result.cleanup.error = String(error?.message || error).slice(0, 240);
    result.errors.push(errorRecord('upstash_cleanup', error));
  }
}

for (const [name, m] of Object.entries(result.models)) {
  if (!m.pair_scores?.length) continue;
  for (const label of ['all', 'merge', 'separate', 'uncertain']) m.distributions[label] = stats(m.pair_scores.filter(p => label === 'all' || p.label === label).map(p => p.cosine));
}

// Chronological 24h nearest-prior-item proxy. Keep reviewed-pair results distinct from unlabeled candidates.
const pairLabelByKey = new Map(pairDocs.map(p => [[p.article_id_a, p.article_id_b].sort().join(':'), p.label]));
const ordered = [...included].sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
for (const [name, m] of Object.entries(result.models)) {
  if (!m.pair_scores?.length) continue;
  const getScore = (a, b) => name.startsWith('gemini-') ? cosine(m.article_vectors[a.article_id], m.article_vectors[b.article_id]) : m.article_score_rows[a.article_id][b.article_id];
  const records = [];
  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i], now = Date.parse(current.published_at);
    const prev = ordered.slice(0, i).filter(a => Date.parse(a.published_at) >= now - 86400000);
    const candidates = prev.map(a => ({ article_id: a.article_id, title: a.title, published_at: a.published_at, cosine: getScore(current, a), topic_relation: !current.topic_id || !a.topic_id ? 'unlinked' : current.topic_id === a.topic_id ? 'same_topic' : 'different_topics', reviewed_pair_label: pairLabelByKey.get([current.article_id, a.article_id].sort().join(':')) || null })).sort((a, b) => b.cosine - a.cosine);
    records.push({ article_id: current.article_id, title: current.title, published_at: current.published_at, candidates_in_previous_24h: prev.length, top_candidates: candidates.slice(0, 5), top_candidate: candidates[0] || null });
  }
  const thresholdSummary = thresholds.map(threshold => {
    const proposals = records.map(r => r.top_candidate).filter(c => c && c.cosine >= threshold);
    const counts = { merge: 0, separate: 0, uncertain: 0, unlabeled_requires_review: 0 };
    for (const p of proposals) counts[p.reviewed_pair_label || 'unlabeled_requires_review']++;
    return { threshold, proposed_articles: proposals.length, ...counts };
  });
  result.simulations[name] = { method: 'nearest prior article published within last 24h; not a full topic-state replay', labeled_pair_proposals: records.flatMap(r => r.top_candidates.filter(c => c.reviewed_pair_label).map(c => ({ query_article_id: r.article_id, candidate_article_id: c.article_id, label: c.reviewed_pair_label, cosine: c.cosine }))), unlabeled_review_candidates: records.flatMap(r => r.top_candidates.filter(c => c.cosine >= 0.8 && !c.reviewed_pair_label).map(c => ({ query_article_id: r.article_id, query_title: r.title, query_published_at: r.published_at, ...c }))), records, threshold_summary: thresholdSummary };
}

result.finished_at = new Date().toISOString();
result.google_usage_summary = Object.fromEntries(models.map(m => [m.key, result.models[m.key]?.usage || null]));
await writeJson('real_news_embedding_comparison.json', result);
await fs.writeFile(path.join(resultDir, 'real_news_embedding_comparison.md'), markdown(result), 'utf8');
console.log(JSON.stringify({ finished_at: result.finished_at, included_articles: included.length, pair_count: pairDocs.length, labels: labelCounts, models: Object.fromEntries(Object.entries(result.models).map(([k, v]) => [k, { articles_processed: v.article_vectors ? Object.keys(v.article_vectors).length : v.usage.query_articles ?? null, pairs_scored: v.pair_scores?.length ?? 0 }])), errors: result.errors.map(e => ({ stage: e.stage, status: e.status, name: e.name, message: e.message })), cleanup: result.cleanup }));
