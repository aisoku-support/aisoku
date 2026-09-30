import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const datasetPath = path.join(dir, 'thread_title_ab_20260927_dataset.json');
const highResultsPath = path.join(dir, 'thread_title_prompt_bc_20260927_results.json');
const sourceRunnerPath = path.join(dir, 'run_thread_title_prompt_bc_20260927.mjs');
const resultPath = path.join(dir, 'thread_title_c_medium_20260927_results.json');
const reportPath = path.join(dir, 'thread_title_c_medium_20260927_report.md');
const model = 'gemini-3.5-flash-lite';

async function readKey() {
  for (const name of ['.env.server', '.env']) {
    try {
      const contents = await fs.readFile(path.join(root, name), 'utf8');
      const line = contents.split(/\r?\n/).find((x) => /^GEMINI_API_KEY=/.test(x));
      if (line) return line.slice(line.indexOf('=') + 1).replace(/^(['"])(.*)\1$/, '$2');
    } catch { /* try the next local env file */ }
  }
  throw new Error('GEMINI_API_KEY not found (value omitted).');
}

function extractPromptC(source) {
  const match = source.match(/\bC:\s*`([\s\S]*?)`,\s*\n\};/);
  if (!match) throw new Error('Unable to extract the previous C prompt.');
  return match[1];
}

function parseOutput(text, topics) {
  let obj;
  try { obj = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { return { json_valid: false, schema_valid: false, titles: topics.map((t) => ({ id: t.id, title: null, length: 0, status: 'invalid_json' })) }; }
  if (!Array.isArray(obj?.titles)) return { json_valid: true, schema_valid: false, titles: topics.map((t) => ({ id: t.id, title: null, length: 0, status: 'schema_invalid' })) };
  const allowed = new Set(topics.map((t) => t.id));
  const rows = new Map();
  let schemaValid = true;
  for (const row of obj.titles) {
    if (typeof row?.id !== 'string' || !allowed.has(row.id) || rows.has(row.id) || typeof row.thread_title !== 'string') {
      schemaValid = false;
      continue;
    }
    const title = row.thread_title.trim();
    const length = Array.from(title).length;
    rows.set(row.id, { id: row.id, title: title || null, length, status: !title ? 'empty' : length > 47 ? 'too_long' : 'success' });
  }
  const titles = topics.map((t) => rows.get(t.id) ?? { id: t.id, title: null, length: 0, status: 'missing_id' });
  if (titles.some((t) => t.status === 'missing_id')) schemaValid = false;
  return { json_valid: true, schema_valid: schemaValid, titles };
}

const state = {
  started_at: new Date().toISOString(), dataset: path.basename(datasetPath), model,
  prompt: 'C (reused verbatim from run_thread_title_prompt_bc_20260927.mjs)',
  protocol: { batchSize: 4, temperature: 0, thinkingLevel: 'medium', maxOutputTokens: 8192, timeoutMs: 30000, retries: 0, titleMaxCodepoints: 47, minModelRequestIntervalMs: 4100 },
  requests: [], api_calls: 0,
};

function summarize() {
  const reqs = state.requests;
  const outputs = reqs.flatMap((r) => r.titles ?? []);
  const times = reqs.map((r) => r.elapsed_ms).sort((a, b) => a - b);
  const usage = reqs.map((r) => r.usage).filter(Boolean);
  const quantile = (p) => times.length ? times[Math.max(0, Math.ceil(times.length * p) - 1)] : null;
  return {
    requests: reqs.length,
    httpSuccess: reqs.filter((r) => r.http_status === 200).length,
    jsonSchemaSuccess: reqs.filter((r) => r.json_valid && r.schema_valid).length,
    titleSuccess: outputs.filter((t) => t.status === 'success').length,
    titleOutputs: outputs.length,
    lengthCompliant: outputs.filter((t) => t.status !== 'too_long').length,
    failureReasons: Object.fromEntries([...new Set(outputs.filter((t) => t.status !== 'success').map((t) => t.status))].map((k) => [k, outputs.filter((t) => t.status === k).length])),
    timeoutCount: reqs.filter((r) => r.status === 'timeout').length,
    latencyMs: { mean: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length * 10) / 10 : null, median: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.ceil((times.length - 1) / 2)]) / 2 : null, p95: quantile(0.95) },
    inputTokens: usage.reduce((a, x) => a + (x.promptTokenCount ?? 0), 0),
    outputTokens: usage.reduce((a, x) => a + (x.candidatesTokenCount ?? 0), 0),
    thinkingTokens: usage.reduce((a, x) => a + (x.thoughtsTokenCount ?? 0), 0),
  };
}

function makeReport(dataset, high, summary) {
  const highCondition = high.conditions.find((c) => c.model === model && c.prompt === 'C');
  const highSummary = highCondition.summary;
  const highTitle = (id) => {
    for (const request of highCondition.requests) {
      const row = request.titles?.find((t) => t.id === id);
      if (row) return row.title ?? `[${row.status}]`;
    }
    return '[High: timeout / no title returned]';
  };
  const mediumTitle = (id) => {
    for (const request of state.requests) {
      const row = request.titles?.find((t) => t.id === id);
      if (row) return row.title ?? `[${row.status}]`;
    }
    return '[未取得]';
  };
  const metricRows = [
    ['HTTP成功', `${highSummary.httpSuccess}/10`, `${summary.httpSuccess}/${summary.requests}`],
    ['JSON Schema成功バッチ', `${highSummary.jsonSchemaSuccess}/10`, `${summary.jsonSchemaSuccess}/${summary.requests}`],
    ['タイトル生成成功', `${highSummary.titleSuccess}/40`, `${summary.titleSuccess}/40`],
    ['47文字以内（取得タイトルを分母）', `${highSummary.lengthCompliant}/${highSummary.titleOutputs}`, `${summary.lengthCompliant}/${summary.titleOutputs}`],
    ['平均 / 中央値 / p95 (ms)', `${highSummary.latencyMs.mean} / ${highSummary.latencyMs.median} / ${highSummary.latencyMs.p95}`, `${summary.latencyMs.mean} / ${summary.latencyMs.median} / ${summary.latencyMs.p95}`],
    ['Input tokens', String(highSummary.inputTokens), String(summary.inputTokens)],
    ['Output tokens', String(highSummary.outputTokens), String(summary.outputTokens)],
    ['Thinking tokens', String(highSummary.thinkingTokens), String(summary.thinkingTokens)],
    ['タイムアウト', `${highSummary.failureReasons.timeout ?? 0}`, `${summary.timeoutCount}`],
  ];
  const lines = [
    '# Gemini 3.5 Flash-Lite Prompt C: High vs Medium', '',
    `実行日時: ${state.started_at}`, '',
    '## 条件と結果', '',
    '同一の40 Topic、前回Prompt C、4件固定バッチ、temperature 0、maxOutputTokens 8192、timeout 30秒、retryなし、モデル別の最小リクエスト間隔4.1秒を使用。変えた条件はThinkingだけです。Mediumは公式APIの `thinkingConfig.thinkingLevel: "medium"` で明示しました。', '',
    '| 指標 | High（前回） | Medium（今回） |', '|---|---:|---:|',
    ...metricRows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`), '',
    'High側はタイムアウトしたバッチの4記事を生成成功に数えていません。Medium側もAPIリクエスト数（実行済みバッチ）と全40 Topicを分母に分けて記載しています。タイムアウトは無制限再試行せず、そのバッチの未取得タイトルとして残しました。', '',
    '## 40 Topic 全件比較', '',
    '| # | subject | event | High | Medium |', '|---:|---|---|---|---|',
  ];
  dataset.topics.forEach((t, i) => lines.push(`| ${i + 1} | ${t.subject} | ${t.event} | ${highTitle(t.id)} | ${mediumTitle(t.id)} |`));
  const highTimeoutIds = new Set(highCondition.requests.filter((r) => r.status === 'timeout').flatMap((r) => r.topic_ids));
  lines.push('', '## 実例と定性的な観察', '',
    '次の差分は出力例に基づく観察であり、盲検の人手採点ではありません。面白さ・5chらしさ・多様性・具体性の優劣を確定するものではありません。', '');
  const examples = dataset.topics.filter((t) => highTimeoutIds.has(t.id)).slice(0, 4);
  for (const t of examples) lines.push(`- **${t.subject}** — event: ${t.event} / High: ${highTitle(t.id)} / Medium: ${mediumTitle(t.id)}`);
  const representativeIds = [
    '81eb9a9d-b04c-48a6-b8c4-1527be15879a',
    '41d99bb3-493c-4156-9597-8e531583bdcf',
    '0d436a98-fce2-4a74-a8e2-7c2115432fff',
    '6247f89c-4d5f-4c2a-9405-7e722a84048f',
  ];
  lines.push('', '### 完了したバッチの出力例', '');
  for (const id of representativeIds) {
    const t = dataset.topics.find((topic) => topic.id === id);
    if (t) lines.push(`- **${t.subject}** — event: ${t.event} / High: ${highTitle(t.id)} / Medium: ${mediumTitle(t.id)}`);
  }
  lines.push('',
    '観察: ドローン計画ではHighの「チョイスが渋すぎる件」が軽いツッコミを加え、Mediumは供給元選定という事実の説明に寄っています。WRX STIの例ではMediumの「お前らの財布」が掲示板調を足す一方、Highの方が短く、Mediumは47文字上限違反でした。団地の例では両方とも「秒で」「大勝利」などeventにない速度・評価を加えており、Medium化だけでは誇張リスクは解消しません。GPU担保の例ではMediumは短く読みやすいものの、Highは融資手法の複雑化まで触れており情報の具体性が高いです。', '',
    'Timeout対象だったHighの4記事はHighタイトルが存在しないため、比較可能なのはMediumの回収結果と元subject/eventです。Mediumで具体的な固有名詞・数字が保たれているか、煽り表現が事実を足していないかを人手で確認してください。', '',
    '例の読み方: 「草」「悲報」「ワロタ」等の掲示板語彙は5chらしさを強める一方、ニュース内容にない評価や誇張を加える可能性があります。数字・固有名詞が残れば具体性の手がかりですが、面白さの自動判定には使っていません。', '',
    '## API応答と制限', '',
    `今回のAPI呼び出し: ${state.api_calls}。429で停止: ${state.requests.some((r) => r.http_status === 429) ? 'はい' : 'いいえ'}。Retry: 0。結果JSONにはバッチごとのHTTP状態、エラー理由、usage、時間、タイトルを保存しています。`, '',
    '## 判断材料', '',
    'Medium採用を候補にする根拠は、HTTP/スキーマ/47文字遵守の維持、成功率の差、応答時間短縮、thinking token減少です。品質の判断は全件表を人が確認して行ってください。サンプル40件・各条件1回のため、品質差や安定性を一般化するには追加の独立試行が必要です。', '');
  return lines.join('\n');
}

async function save() {
  state.summary = summarize();
  await fs.writeFile(resultPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function main() {
  const dataset = JSON.parse((await fs.readFile(datasetPath, 'utf8')).replace(/^\uFEFF/, ''));
  const high = JSON.parse((await fs.readFile(highResultsPath, 'utf8')).replace(/^\uFEFF/, ''));
  const sourceRunner = await fs.readFile(sourceRunnerPath, 'utf8');
  const prompt = extractPromptC(sourceRunner);
  const highCondition = high.conditions.find((c) => c.model === model && c.prompt === 'C');
  if (dataset.topics.length !== 40 || new Set(dataset.topics.map((t) => t.id)).size !== 40) throw new Error('Expected 40 unique fixed topics.');
  if (!highCondition || highCondition.requests.length !== 10) throw new Error('Previous 3.5 × C High results are incomplete.');
  if (state.protocol.thinkingLevel !== 'medium' || state.protocol.batchSize !== 4 || state.protocol.retries !== 0) throw new Error('Protocol validation failed.');
  const promptFilePath = path.join(dir, 'thread_title_prompt_c_20260927.txt');
  await fs.writeFile(promptFilePath, prompt, 'utf8');
  const schema = { type: 'object', properties: { titles: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'object', properties: { id: { type: 'string' }, thread_title: { type: 'string' } }, required: ['id', 'thread_title'] } } }, required: ['titles'] };
  const key = await readKey();
  const batches = Array.from({ length: 10 }, (_, i) => dataset.topics.slice(i * 4, i * 4 + 4));
  let lastStart = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const wait = Math.max(0, 4100 - (Date.now() - lastStart));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const topics = batches[bi];
    const row = { batch: bi, started_at: new Date().toISOString(), topic_ids: topics.map((t) => t.id), http_status: null, retry_after: null, usage: null, elapsed_ms: null, titles: [], errors: [] };
    lastStart = Date.now();
    const start = performance.now();
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents: [{ parts: [{ text: JSON.stringify({ topics: topics.map(({ id, subject, event }) => ({ id, subject, event })) }) }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, thinkingConfig: { thinkingLevel: 'medium' }, temperature: 0, maxOutputTokens: 8192 },
        }), signal: AbortSignal.timeout(30000),
      });
      row.http_status = response.status;
      row.retry_after = response.headers.get('retry-after');
      const body = await response.json().catch(() => null);
      row.usage = body?.usageMetadata ?? null;
      if (!response.ok) {
        row.status = response.status === 429 ? 'rate_limit' : `http_${response.status}`;
        row.api_error = { code: body?.error?.code ?? null, status: body?.error?.status ?? null, message: body?.error?.message ?? null };
      } else {
        const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
        Object.assign(row, parseOutput(text, topics));
        row.finish_reason = body?.candidates?.[0]?.finishReason ?? null;
        row.status = row.json_valid && row.schema_valid && row.titles.every((t) => t.status === 'success') ? 'success' : 'partial_failure';
      }
    } catch (error) {
      row.status = error.name === 'TimeoutError' ? 'timeout' : 'network_error';
      row.errors.push({ name: error.name, code: error.cause?.code ?? null });
    }
    row.elapsed_ms = Math.round((performance.now() - start) * 10) / 10;
    state.requests.push(row);
    state.api_calls++;
    await save();
    console.log(`batch ${bi + 1}/10: ${row.status}, HTTP ${row.http_status ?? 'none'}`);
    if (row.status === 'rate_limit') { state.stop_reason = '429'; break; }
  }
  state.finished_at = new Date().toISOString();
  await save();
  const summary = summarize();
  await fs.writeFile(reportPath, makeReport(dataset, high, summary), 'utf8');
  console.log(`DONE api_calls=${state.api_calls}`);
  console.log(`RESULT=${resultPath}`);
  console.log(`REPORT=${reportPath}`);
  console.log(`PROMPT=${promptFilePath}`);
}

main().catch(async (error) => {
  state.runner_error = { name: error.name, message: String(error.message).slice(0, 200) };
  state.finished_at = new Date().toISOString();
  await save();
  console.error(`STOP: ${error.name}: ${String(error.message).slice(0, 200)}`);
  process.exitCode = 1;
});
