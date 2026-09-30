import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const datasetPath = path.join(dir, 'thread_title_ab_20260927_dataset.json');
const previousPath = path.join(dir, 'thread_title_ab_20260927_results.json');
const resultPath = path.join(dir, 'thread_title_prompt_bc_20260927_results.json');
const reportPath = path.join(dir, 'thread_title_prompt_bc_20260927_report.md');
const stableModels = [
  { key: '3.1', id: 'gemini-3.1-flash-lite' },
  { key: '3.5', id: 'gemini-3.5-flash-lite' },
];
const prompts = {
  B: `あなたは匿名ニュース掲示板のスレッドタイトル編集者です。

各ニュースのsubjectとeventを読み、読者が思わず内容を確認したくなるスレッドタイトルを1つ作成してください。

【作成手順】

1. ニュースの中で最も興味を引く要素を1つ選ぶ。
   - 意外な事実
   - 驚くような数字や規模
   - 常識とのギャップ
   - 身近な生活への影響
   - 読者が疑問を持ちそうな点

2. 選んだ要素をタイトルの中心にする。

3. 単なるニュースの要約ではなく、ニュースの面白い部分が伝わるタイトルにする。

【出力】
- 47文字以内。
- 各ニュースにつきタイトルを1つ生成する。
- 指定されたJSON形式だけを返す。`,
  C: `あなたは5ch風の匿名ニュース掲示板で、ニューススレッドを立てる編集者です。

報道機関のニュース見出しではなく、掲示板ユーザーが思わず開きたくなるスレタイを作成してください。

【タイトルの構成】

ニュースの内容に合わせて、次の表現方法から最も面白くなるものを選んでください。

A. 意外な事実を短く言い切る
B. ニュースの内容に対して疑問を投げかける
C. 特徴的な数字や出来事を強調する
D. ニュースにツッコミを入れる
E. 普通のニュース見出しにする
F. その他、読者の興味を引く自由な表現

ニュースごとに自由に構成を選び、匿名掲示板らしいスレタイを作成してください。

【出力】
- 47文字以内。
- 各ニュースにつきタイトルは1つ。
- 指定されたJSON形式だけを返す。`,
};
const currentPrompt = `このニュースで2ch/5chのスレタイを1つ作ってください。

47文字以内。
JSONだけ返してください。

禁止:
- 個人や企業への誹謗中傷
- 差別表現
- 根拠のない犯罪・不正の断定
- 病気・死亡・重大事故を悪質に茶化す表現`;
const schema = {
  type: 'object', properties: { titles: {
    type: 'array', minItems: 4, maxItems: 4, items: {
      type: 'object', properties: { id: { type: 'string' }, thread_title: { type: 'string' } }, required: ['id', 'thread_title'],
    },
  } }, required: ['titles'],
};
function argsMap(argv) {
  const out = {};
  for (const arg of argv) { const m = arg.match(/^--([^=]+)=(.*)$/); if (m) out[m[1]] = m[2]; }
  return out;
}
async function envKey() {
  for (const name of ['.env.server', '.env']) {
    try {
      const contents = await fs.readFile(path.join(root, name), 'utf8');
      const line = contents.split(/\r?\n/).find(x => /^GEMINI_API_KEY=/.test(x));
      if (line) return line.slice(line.indexOf('=') + 1).replace(/^(['"])(.*)\1$/, '$2');
    } catch { /* try next file */ }
  }
  throw new Error('GEMINI_API_KEY not found (value omitted).');
}
const state = {
  started_at: new Date().toISOString(), dataset: path.basename(datasetPath),
  conditions: stableModels.flatMap(m => ['B', 'C'].map(p => ({ model: m.id, prompt: p, status: 'not_run', requests: [] }))),
  protocol: { batchSize: 4, temperature: 0, thinkingLevel: 'high', maxOutputTokens: 8192, timeoutMs: 30000, retries: 0, titleMaxCodepoints: 47, minModelRequestIntervalMs: 4100 },
  api_calls: 0, stop_reason: null,
};
async function save() { await fs.writeFile(resultPath, JSON.stringify(state, null, 2) + '\n', 'utf8'); }
function buildReport(dataset, previous) {
  const out = ['# Thread title prompt B/C benchmark', '', `Started: ${state.started_at}`, '', '## Preflight decision', '', state.stop_reason ?? 'API run completed.', '',
    'Four new conditions (3.1×B, 3.1×C, 3.5×B, 3.5×C) require 40 GenerateContent requests: 20 per model. No current project-specific free-tier headroom was available from the public quota documentation or local artifacts, so this run stopped before GenerateContent.', '',
    'Google pricing lists free-of-charge input/output token pricing for both models, but rate limits vary by project and current active limits must be viewed in AI Studio. Free pricing does not prove remaining request quota. The public rate-limits page does not provide this project’s remaining usage or free-tier eligibility.', '',
    '## Planned usage reference (not a guarantee)', '',
    '| Model | prior 10-request input | output | thinking | projected 20-request reference |', '|---|---:|---:|---:|---:|'];
  for (const [k, model] of [['A', stableModels[0]], ['B', stableModels[1]]]) {
    const s = previous.summary[k];
    const ref = s.input_tokens + s.output_tokens + s.thinking_tokens;
    out.push(`| ${model.id} | ${s.input_tokens} | ${s.output_tokens} | ${s.thinking_tokens} | ${2 * ref} total tokens (linear prior-run reference only) |`);
  }
  out.push('', 'These prior measurements used the shorter current production prompt. Prompts B/C are longer, and generation/thinking use may change, so this is not an upper bound or an exact token estimate. Exact usage is available only after requests; calling an API token counter would itself require API access and would not establish free-tier remaining quota.', '',
    '## Previous current-prompt baseline', '', '| Model | HTTP success | JSON/schema | title success | <=47 chars | mean ms | median ms | p95 ms | input | output | thinking |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [k, name] of [['A', stableModels[0].id], ['B', stableModels[1].id]]) {
    const s = previous.summary[k];
    out.push(`| ${name} × current | ${s.http_200}/10 | ${s.json_schema_valid_batches}/10 | ${s.title_success}/40 | ${s.title_length_compliant}/40 | ${s.latency_ms.mean} | ${s.latency_ms.median} | ${s.latency_ms.p95} | ${s.input_tokens} | ${s.output_tokens} | ${s.thinking_tokens} |`);
  }
  out.push('', '## Six-way per-topic comparison', '', '| # | subject | event | 3.1 current | 3.1 B | 3.1 C | 3.5 current | 3.5 B | 3.5 C |', '|---:|---|---|---|---|---|---|---|---|');
  const prevOut = (modelKey, id) => {
    for (const req of previous.requests.filter(r => r.model_key === modelKey)) { const t = req.titles.find(x => x.id === id); if (t) return t.title ?? `[${t.status}]`; }
    return '—';
  };
  for (let i = 0; i < dataset.topics.length; i++) {
    const t = dataset.topics[i];
    const promptOut = (modelId, prompt) => {
      const condition = state.conditions.find(c => c.model === modelId && c.prompt === prompt);
      for (const req of condition.requests) { const row = req.titles?.find(x => x.id === t.id); if (row) return row.title ?? `[${row.status}]`; }
      return '未実行';
    };
    out.push(`| ${i + 1} | ${t.subject} | ${t.event} | ${prevOut('A', t.id)} | ${promptOut(stableModels[0].id, 'B')} | ${promptOut(stableModels[0].id, 'C')} | ${prevOut('B', t.id)} | ${promptOut(stableModels[1].id, 'B')} | ${promptOut(stableModels[1].id, 'C')} |`);
  }
  out.push('', 'No automatic score determines quality. This report preserves all titles and leaves subjective judgments to human comparison.', '', 'API calls in this run: ' + state.api_calls, '');
  return out.join('\n');
}
function parseOutput(text, topics) {
  let obj;
  try { obj = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { return { jsonValid: false, schemaValid: false, titles: topics.map(t => ({ id: t.id, title: null, status: 'invalid_json', length: 0 })) }; }
  if (!Array.isArray(obj?.titles)) return { jsonValid: true, schemaValid: false, titles: topics.map(t => ({ id: t.id, title: null, status: 'schema_invalid', length: 0 })) };
  const known = new Set(topics.map(t => t.id)); const rows = new Map(); let schemaValid = true;
  for (const row of obj.titles) {
    if (typeof row?.id !== 'string' || !known.has(row.id) || rows.has(row.id) || typeof row.thread_title !== 'string') { schemaValid = false; continue; }
    const title = row.thread_title.trim(); const length = Array.from(title).length;
    rows.set(row.id, { id: row.id, title: title || null, length, status: !title ? 'empty' : length > 47 ? 'too_long' : 'success' });
  }
  const titles = topics.map(t => rows.get(t.id) ?? { id: t.id, title: null, length: 0, status: 'missing_id' });
  if (titles.some(x => x.status === 'missing_id')) schemaValid = false;
  return { jsonValid: true, schemaValid, titles };
}
async function run() {
  const dataset = JSON.parse((await fs.readFile(datasetPath, 'utf8')).replace(/^\uFEFF/, ''));
  const previous = JSON.parse((await fs.readFile(previousPath, 'utf8')).replace(/^\uFEFF/, ''));
  if (dataset.topics.length !== 40 || new Set(dataset.topics.map(x => x.id)).size !== 40) throw new Error('Dataset must have 40 unique topics.');
  const args = argsMap(process.argv.slice(2));
  const q31 = Number(args['remaining-rpd-31']); const q35 = Number(args['remaining-rpd-35']);
  const verified = args['free-tier-verified'] === 'true' && Number.isInteger(q31) && q31 >= 20 && Number.isInteger(q35) && q35 >= 20;
  if (!verified) {
    state.stop_reason = 'Preflight stop: verify current Free Tier access and at least 20 remaining daily requests for each model in AI Studio; public docs do not expose project-specific remaining quota. No API calls made.';
    state.previous_summary = previous.summary;
    state.expected = { generateContentRequests: 40, requestsPerModel: 20, promptInputTokensExact: null, tokenProjection: 'See report; historical linear reference is not an upper bound.' };
    state.finished_at = new Date().toISOString(); await save();
    await fs.writeFile(reportPath, buildReport(dataset, previous), 'utf8');
    console.log('STOP: project Free Tier headroom was not verified; zero API calls.');
    console.log(`RESULT=${resultPath}`); console.log(`REPORT=${reportPath}`);
    return;
  }
  const key = await envKey();
  const batches = Array.from({ length: 10 }, (_, i) => dataset.topics.slice(i * 4, i * 4 + 4));
  let lastStarted = new Map();
  for (const model of stableModels) {
    for (const promptKey of ['B', 'C']) {
      const condition = state.conditions.find(c => c.model === model.id && c.prompt === promptKey);
      for (let bi = 0; bi < batches.length; bi++) {
        const last = lastStarted.get(model.id) ?? 0;
        const wait = Math.max(0, 4100 - (Date.now() - last));
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        const topics = batches[bi]; const started = new Date().toISOString(); lastStarted.set(model.id, Date.now());
        const body = {
          systemInstruction: { parts: [{ text: prompts[promptKey] }] },
          contents: [{ parts: [{ text: JSON.stringify({ topics: topics.map(({ id, subject, event }) => ({ id, subject, event })) }) }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, thinkingConfig: { thinkingLevel: 'high' }, temperature: 0, maxOutputTokens: 8192 },
        };
        const result = { batch: bi, started_at: started, topic_ids: topics.map(x => x.id), http_status: null, retry_after: null, usage: null, elapsed_ms: null, titles: [], errors: [] };
        const timer = performance.now();
        try {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
          result.http_status = response.status; result.retry_after = response.headers.get('retry-after');
          const responseBody = await response.json().catch(() => null);
          result.usage = responseBody?.usageMetadata ?? null;
          if (!response.ok) {
            result.status = response.status === 429 ? 'rate_limit' : `http_${response.status}`;
            result.api_error = { code: responseBody?.error?.code ?? null, status: responseBody?.error?.status ?? null, message: responseBody?.error?.message ?? null };
          } else {
            const text = (responseBody?.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('');
            const parsed = parseOutput(text, topics); result.json_valid = parsed.jsonValid; result.schema_valid = parsed.schemaValid; result.titles = parsed.titles;
            result.finish_reason = responseBody?.candidates?.[0]?.finishReason ?? null;
            result.status = parsed.titles.every(x => x.status === 'success') && parsed.schemaValid ? 'success' : 'partial_failure';
          }
        } catch (e) { result.status = e.name === 'TimeoutError' ? 'timeout' : 'network_error'; result.errors.push({ name: e.name, code: e.cause?.code ?? null }); }
        result.elapsed_ms = Math.round((performance.now() - timer) * 10) / 10;
        condition.requests.push(result); state.api_calls++; await save();
        console.log(`${model.key}×${promptKey} batch ${bi + 1}/10: ${result.status} HTTP ${result.http_status ?? 'none'}`);
        if (result.status === 'rate_limit') { condition.status = 'stopped_429'; break; }
        if (result.status !== 'success' && result.status !== 'partial_failure') { condition.status = `stopped_${result.status}`; break; }
      }
      if (condition.status === 'not_run') condition.status = 'completed';
    }
  }
  state.previous_summary = previous.summary; state.finished_at = new Date().toISOString();
  state.conditions = state.conditions.map(c => ({ ...c, summary: summarize(c) }));
  await save(); await fs.writeFile(reportPath, buildReport(dataset, previous), 'utf8');
  console.log(`DONE api_calls=${state.api_calls}`);
}
function summarize(c) {
  const reqs = c.requests; const outputs = reqs.flatMap(r => r.titles ?? []); const times = reqs.map(r => r.elapsed_ms).sort((a,b)=>a-b); const usage = reqs.map(r=>r.usage).filter(Boolean);
  const quantile = p => times.length ? times[Math.max(0, Math.ceil(times.length*p)-1)] : null;
  return { requests: reqs.length, httpSuccess: reqs.filter(r=>r.http_status===200).length, jsonSchemaSuccess: reqs.filter(r=>r.json_valid&&r.schema_valid).length, titleSuccess: outputs.filter(t=>t.status==='success').length, titleOutputs: outputs.length, lengthCompliant: outputs.filter(t=>t.status!=='too_long').length, failureReasons: Object.fromEntries([...new Set(outputs.filter(t=>t.status!=='success').map(t=>t.status))].map(k=>[k,outputs.filter(t=>t.status===k).length])), latencyMs: { mean: times.length ? Math.round(times.reduce((s,x)=>s+x,0)/times.length*10)/10 : null, median: times.length ? (times[Math.floor((times.length-1)/2)]+times[Math.ceil((times.length-1)/2)])/2 : null, p95: quantile(.95) }, inputTokens: usage.reduce((s,x)=>s+(x.promptTokenCount??0),0), outputTokens: usage.reduce((s,x)=>s+(x.candidatesTokenCount??0),0), thinkingTokens: usage.reduce((s,x)=>s+(x.thoughtsTokenCount??0),0) };
}
run().catch(async e => { state.stop_reason = 'runner_error'; state.runner_error = { name: e.name, message: String(e.message).slice(0,200) }; await save(); console.error(`STOP: ${e.name}: ${String(e.message).slice(0,200)}`); process.exitCode=1; });
