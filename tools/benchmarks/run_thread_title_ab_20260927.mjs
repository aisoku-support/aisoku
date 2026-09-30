import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const datasetPath = path.join(dir, 'thread_title_ab_20260927_dataset.json');
const resultPath = path.join(dir, 'thread_title_ab_20260927_results.json');
const reportPath = path.join(dir, 'thread_title_ab_20260927_report.md');
const models = [
  { key: 'A', id: 'gemini-3.1-flash-lite' },
  { key: 'B', id: 'gemini-3.5-flash-lite' },
];
const instruction = `このニュースで2ch/5chのスレタイを1つ作ってください。

47文字以内。
JSONだけ返してください。

禁止:
- 個人や企業への誹謗中傷
- 差別表現
- 根拠のない犯罪・不正の断定
- 病気・死亡・重大事故を悪質に茶化す表現`;
const responseSchema = {
  type: 'object',
  properties: {
    titles: {
      type: 'array', minItems: 4, maxItems: 4,
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, thread_title: { type: 'string' } },
        required: ['id', 'thread_title'],
      },
    },
  },
  required: ['titles'],
};

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    result[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}
async function getApiKey() {
  for (const file of ['.env.server', '.env']) {
    try {
      const vars = parseEnv(await fs.readFile(path.join(root, file), 'utf8'));
      if (vars.GEMINI_API_KEY) return vars.GEMINI_API_KEY;
    } catch { /* try next configured local env file */ }
  }
  throw new Error('GEMINI_API_KEY not found; value omitted.');
}
function codepointLength(text) { return Array.from(text).length; }
function validate(text, topics) {
  let data;
  try { data = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { return { status: 'invalid_json', titles: topics.map(t => ({ id: t.id, title: null, status: 'invalid_json', length: 0 })) }; }
  if (!Array.isArray(data?.titles)) return { status: 'schema_invalid', titles: topics.map(t => ({ id: t.id, title: null, status: 'schema_invalid', length: 0 })) };
  const expected = new Set(topics.map(t => t.id));
  const seen = new Set();
  const map = new Map();
  let schemaError = false;
  for (const row of data.titles) {
    if (typeof row?.id !== 'string') { schemaError = true; continue; }
    if (!expected.has(row.id)) { schemaError = true; continue; }
    if (seen.has(row.id)) { map.set(row.id, { id: row.id, title: null, status: 'duplicate_id', length: 0 }); schemaError = true; continue; }
    seen.add(row.id);
    if (typeof row.thread_title !== 'string') { map.set(row.id, { id: row.id, title: null, status: 'schema_invalid', length: 0 }); schemaError = true; continue; }
    const title = row.thread_title.trim();
    const length = codepointLength(title);
    map.set(row.id, { id: row.id, title: title || null, status: !title ? 'empty' : length > 47 ? 'too_long' : 'success', length });
  }
  for (const topic of topics) if (!map.has(topic.id)) { map.set(topic.id, { id: topic.id, title: null, status: 'missing_id', length: 0 }); schemaError = true; }
  const titles = topics.map(t => map.get(t.id));
  const status = titles.every(x => x.status === 'success') && !schemaError ? 'success' : 'partial_failure';
  return { status, titles, schemaError };
}
const state = {
  started_at: new Date().toISOString(),
  source_file: path.basename(datasetPath),
  model_a_id: models[0].id,
  model_a_substitution: 'Production preview ID gemini-3.1-flash-lite-preview was officially shut down 2026-05-25; stable 3.1 used without spending a request on the stopped ID.',
  model_b_id: models[1].id,
  protocol: { temperature: 0, thinkingLevel: 'high', maxOutputTokens: 8192, timeoutSeconds: 30, retries: 0, batchSize: 4, titleMaxCodepoints: 47 },
  request_plan: 'Initial one batch per model; proceed only after both first responses return HTTP 200, usageMetadata, valid JSON and valid schema. 4.1s minimum between request starts. Stop only the model receiving 429; no retries.',
  requests: [],
  stop_reason: null,
};
async function save() { await fs.writeFile(resultPath, JSON.stringify(state, null, 2) + '\n', 'utf8'); }
function topicBatches(topics) { return Array.from({ length: topics.length / 4 }, (_, i) => topics.slice(i * 4, i * 4 + 4)); }
async function callBatch(apiKey, model, batchIndex, topics) {
  const request = {
    model_key: model.key, model_id: model.id, batch_index: batchIndex,
    topic_ids: topics.map(t => t.id), started_at: new Date().toISOString(),
    elapsed_ms: null, http_status: null, retry_after: null, usage: null,
    finish_reason: null, status: 'pending', errors: [], titles: [],
  };
  const payload = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [{ parts: [{ text: JSON.stringify({ topics: topics.map(({ id, subject, event }) => ({ id, subject, event })) }) }] }],
    generationConfig: {
      responseMimeType: 'application/json', responseSchema,
      thinkingConfig: { thinkingLevel: 'high' }, temperature: 0, maxOutputTokens: 8192,
    },
  };
  const started = performance.now();
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
    });
    request.http_status = response.status;
    request.retry_after = response.headers.get('retry-after');
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      request.status = response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'http_5xx' : 'http_error';
      request.api_error_status = body?.error?.status ?? null;
      request.api_error_code = body?.error?.code ?? null;
      request.api_error_message = body?.error?.message ?? null;
      request.headers = { retryAfter: request.retry_after };
      return request;
    }
    request.usage = body?.usageMetadata ?? null;
    const candidate = body?.candidates?.[0];
    request.finish_reason = candidate?.finishReason ?? null;
    const text = (candidate?.content?.parts ?? []).map(p => p.text ?? '').join('');
    const parsed = validate(text, topics);
    request.status = parsed.status;
    request.schema_error = parsed.schemaError ?? false;
    request.titles = parsed.titles;
    if (!request.usage) request.errors.push('usage_metadata_missing');
  } catch (error) {
    request.status = error?.name === 'TimeoutError' ? 'timeout' : 'network_error';
    request.errors.push({ name: error?.name ?? 'Error', code: error?.cause?.code ?? null, message: String(error?.message ?? error).slice(0, 240) });
  } finally {
    request.elapsed_ms = Math.round((performance.now() - started) * 10) / 10;
    request.completed_at = new Date().toISOString();
    state.requests.push(request);
    await save();
  }
  return request;
}
function getTitle(requests, key, id) { for (const req of requests) if (req.model_key === key) { const found = req.titles.find(x => x.id === id); if (found) return found; } return null; }
function stats(values) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return { count: 0, mean: null, median: null, p95: null };
  return { count: a.length, mean: Math.round(a.reduce((s, x) => s + x, 0) / a.length * 10) / 10, median: Math.round((a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2 * 10) / 10, p95: a[Math.max(0, Math.ceil(a.length * 0.95) - 1)] };
}
function summarize(key) {
  const reqs = state.requests.filter(r => r.model_key === key);
  const titles = reqs.flatMap(r => r.titles);
  const usage = reqs.map(r => r.usage).filter(Boolean);
  const errors = {};
  for (const t of titles.filter(x => x.status !== 'success')) errors[t.status] = (errors[t.status] ?? 0) + 1;
  for (const r of reqs.filter(x => !['success', 'partial_failure'].includes(x.status))) errors[r.status] = (errors[r.status] ?? 0) + 1;
  return {
    batch_attempts: reqs.length, http_200: reqs.filter(r => r.http_status === 200).length,
    topic_output_count: titles.length, title_success: titles.filter(t => t.status === 'success').length,
    title_failure_reasons: errors,
    json_schema_valid_batches: reqs.filter(r => ['success', 'partial_failure'].includes(r.status) && !r.schema_error).length,
    title_length_compliant: titles.filter(t => t.status !== 'too_long').length,
    latency_ms: stats(reqs.filter(r => r.elapsed_ms != null).map(r => r.elapsed_ms)),
    input_tokens: usage.reduce((s, x) => s + (x.promptTokenCount ?? 0), 0),
    output_tokens: usage.reduce((s, x) => s + (x.candidatesTokenCount ?? 0), 0),
    thinking_tokens: usage.reduce((s, x) => s + (x.thoughtsTokenCount ?? 0), 0),
  };
}
function makeBlind(topics) {
  return topics.map(topic => {
    const flip = (crypto.createHash('sha256').update(topic.id).digest()[0] & 1) === 1;
    const a = getTitle(state.requests, 'A', topic.id); const b = getTitle(state.requests, 'B', topic.id);
    return { id: topic.id, category: topic.category, subject: topic.subject, event: topic.event,
      X: (flip ? a : b)?.title ?? null, X_status: (flip ? a : b)?.status ?? 'not_run',
      Y: (flip ? b : a)?.title ?? null, Y_status: (flip ? b : a)?.status ?? 'not_run' };
  });
}
function markdown(topics) {
  const lines = ['# AI速 Thread title A/B比較', '', `実行: ${state.started_at} ～ ${state.finished_at}`, '', '## 条件', '',
    `Topic ${topics.length}件。A=${state.model_a_id}（preview停止のためstableへ代替）、B=${state.model_b_id}。temperature=0、thinking=high、maxOutputTokens=8192、timeout=30秒、retry=0、4件固定batch。`,
    '本番と同じprompt/input/schema/ID・空文字・47文字検証を使用。', '', '## 機械評価', '',
    '| Model | batches | HTTP 200 | title success / outputs | JSON/schema valid batches | <=47 chars | mean ms | median ms | p95 ms | input tokens | output tokens | thinking tokens |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const key of ['A', 'B']) { const s = state.summary[key]; lines.push(`| ${key} (${key === 'A' ? state.model_a_id : state.model_b_id}) | ${s.batch_attempts} | ${s.http_200} | ${s.title_success}/${s.topic_output_count} | ${s.json_schema_valid_batches}/${s.batch_attempts} | ${s.title_length_compliant}/${s.topic_output_count} | ${s.latency_ms.mean ?? '—'} | ${s.latency_ms.median ?? '—'} | ${s.latency_ms.p95 ?? '—'} | ${s.input_tokens} | ${s.output_tokens} | ${s.thinking_tokens} |`); }
  lines.push('', '未実行Topicは成功率の分母に含めない。', '', '## Topic別タイトル', '', '| ID | Category | subject / event | A title (status) | B title (status) |', '|---|---|---|---|---|');
  for (const topic of topics) { const a = getTitle(state.requests, 'A', topic.id); const b = getTitle(state.requests, 'B', topic.id); lines.push(`| ${topic.id} | ${topic.category} | ${topic.subject} / ${topic.event} | ${a ? `${a.title ?? ''} (${a.status})` : '未実行'} | ${b ? `${b.title ?? ''} (${b.status})` : '未実行'} |`); }
  lines.push('', '## Blind comparison', '', '| ID | Category | subject / event | X | Y | Humor X/Y | 5ch style X/Y | Naturalness X/Y | Variety X/Y | News consistency X/Y | Inappropriate/invention notes |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const item of state.blind) lines.push(`| ${item.id} | ${item.category} | ${item.subject} / ${item.event} | ${item.X ?? ''} (${item.X_status}) | ${item.Y ?? ''} (${item.Y_status}) |  |  |  |  |  |  |`);
  lines.push('', '主観欄はブラインドレビュー用。未評価の主観点数を生成・捏造しない。', '', `停止理由: ${state.stop_reason ?? 'なし'}`, `全request応答・usage・エラー: ${path.basename(resultPath)}`, '');
  return lines.join('\n');
}

async function main() {
  const dataset = JSON.parse((await fs.readFile(datasetPath, 'utf8')).replace(/^\uFEFF/, ''));
  if (dataset.topics.length !== 40 || new Set(dataset.topics.map(t => t.id)).size !== 40) throw new Error('Fixed dataset must contain exactly 40 unique topics.');
  const apiKey = await getApiKey();
  const batches = topicBatches(dataset.topics);
  const first = [];
  for (const model of models) {
    const req = await callBatch(apiKey, model, 0, batches[0]);
    first.push(req);
    console.log(`Initial ${model.key}: status=${req.status} HTTP=${req.http_status ?? 'none'} usage=${Boolean(req.usage)}`);
    await new Promise(resolve => setTimeout(resolve, 4100));
  }
  const initialOk = first.every(r => r.http_status === 200 && r.usage && ['success', 'partial_failure'].includes(r.status));
  if (!initialOk) state.stop_reason = 'initial_batch_failed_or_missing_usage';
  const stopped = new Set(first.filter(r => r.status === 'rate_limit').map(r => r.model_key));
  if (initialOk) {
    for (const model of models) {
      if (stopped.has(model.key)) continue;
      for (let batchIndex = 1; batchIndex < batches.length; batchIndex++) {
        await new Promise(resolve => setTimeout(resolve, 4100));
        const req = await callBatch(apiKey, model, batchIndex, batches[batchIndex]);
        console.log(`Batch ${model.key} ${batchIndex + 1}/10: status=${req.status} HTTP=${req.http_status ?? 'none'} elapsed=${req.elapsed_ms}ms`);
        if (req.status === 'rate_limit') { stopped.add(model.key); state.stop_reason = `HTTP_429_model_${model.key}`; break; }
        if (req.status === 'network_error' || req.status === 'timeout' || req.status === 'http_5xx' || req.status === 'http_error') { stopped.add(model.key); state.stop_reason = `${req.status}_model_${model.key}`; break; }
      }
    }
  }
  state.finished_at = new Date().toISOString();
  state.total_api_calls = state.requests.length;
  state.summary = { A: summarize('A'), B: summarize('B') };
  state.blind = makeBlind(dataset.topics);
  await save();
  await fs.writeFile(reportPath, markdown(dataset.topics), 'utf8');
  console.log(`DONE calls=${state.total_api_calls} stop=${state.stop_reason ?? 'none'}`);
  console.log(`RESULTS=${resultPath}`);
  console.log(`REPORT=${reportPath}`);
}
main().catch(async error => {
  state.stop_reason = 'runner_error'; state.runner_error = { name: error.name, message: String(error.message).slice(0, 300) }; state.finished_at = new Date().toISOString();
  await save(); console.error(`STOP: ${error.name}: ${String(error.message).slice(0, 300)}`); process.exitCode = 1;
});
