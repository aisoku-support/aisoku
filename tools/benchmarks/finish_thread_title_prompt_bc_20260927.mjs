import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const resultFile = path.join(dir, 'thread_title_prompt_bc_20260927_results.json');
const datasetFile = path.join(dir, 'thread_title_ab_20260927_dataset.json');
const reportFile = path.join(dir, 'thread_title_prompt_bc_20260927_report.md');
const result = JSON.parse((await fs.readFile(resultFile, 'utf8')).replace(/^\uFEFF/, ''));
const dataset = JSON.parse((await fs.readFile(datasetFile, 'utf8')).replace(/^\uFEFF/, ''));
const condition = result.conditions.find(c => c.model === 'gemini-3.5-flash-lite' && c.prompt === 'C');
if (!condition || condition.requests.some(r => r.batch === 9)) throw new Error('Final distinct batch already recorded; refusing duplicate request.');
if (condition.requests.at(-1)?.status !== 'timeout') throw new Error('Expected prior batch 8 timeout; refusing unexpected continuation.');
const topics = dataset.topics.slice(36, 40);
const apiKeyLine = (await fs.readFile(path.resolve(dir, '../../.env.server'), 'utf8')).split(/\r?\n/).find(x => /^GEMINI_API_KEY=/.test(x));
if (!apiKeyLine) throw new Error('GEMINI_API_KEY missing; value omitted.');
const apiKey = apiKeyLine.slice(apiKeyLine.indexOf('=') + 1).replace(/^(['"])(.*)\1$/, '$2');
const prompt = `あなたは5ch風の匿名ニュース掲示板で、ニューススレッドを立てる編集者です。

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
- 指定されたJSON形式だけを返す。`;
const schema = { type: 'object', properties: { titles: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'object', properties: { id: { type: 'string' }, thread_title: { type: 'string' } }, required: ['id', 'thread_title'] } } }, required: ['titles'] };
const request = { batch: 9, topic_ids: topics.map(t => t.id), started_at: new Date().toISOString(), retry_of_timeout: false, http_status: null, retry_after: null, usage: null, titles: [], errors: [] };
const timer = performance.now();
try {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: prompt }] }, contents: [{ parts: [{ text: JSON.stringify({ topics: topics.map(({ id, subject, event }) => ({ id, subject, event })) }) }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, thinkingConfig: { thinkingLevel: 'high' }, temperature: 0, maxOutputTokens: 8192 } }),
    signal: AbortSignal.timeout(30000),
  });
  request.http_status = response.status; request.retry_after = response.headers.get('retry-after');
  const body = await response.json().catch(() => null); request.usage = body?.usageMetadata ?? null;
  if (!response.ok) { request.status = response.status === 429 ? 'rate_limit' : `http_${response.status}`; request.api_error = { code: body?.error?.code ?? null, status: body?.error?.status ?? null, message: body?.error?.message ?? null }; }
  else {
    const raw = (body?.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('').trim(); let parsed;
    try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { parsed = null; }
    request.json_valid = Boolean(parsed); request.schema_valid = Array.isArray(parsed?.titles); request.finish_reason = body?.candidates?.[0]?.finishReason ?? null;
    const rows = new Map();
    for (const row of parsed?.titles ?? []) if (topics.some(t => t.id === row.id) && !rows.has(row.id) && typeof row.thread_title === 'string') { const title = row.thread_title.trim(); const length = Array.from(title).length; rows.set(row.id, { id: row.id, title: title || null, length, status: !title ? 'empty' : length > 47 ? 'too_long' : 'success' }); }
    request.titles = topics.map(t => rows.get(t.id) ?? { id: t.id, title: null, length: 0, status: 'missing_id' });
    request.schema_valid &&= request.titles.every(t => t.status !== 'missing_id');
    request.status = request.schema_valid && request.titles.every(t => t.status === 'success') ? 'success' : 'partial_failure';
  }
} catch (error) { request.status = error.name === 'TimeoutError' ? 'timeout' : 'network_error'; request.errors.push({ name: error.name, code: error.cause?.code ?? null }); }
request.elapsed_ms = Math.round((performance.now() - timer) * 10) / 10; request.completed_at = new Date().toISOString();
condition.requests.push(request); condition.status = request.status === 'rate_limit' ? 'stopped_429' : 'completed_after_timeout_without_retry';
result.api_calls++; result.finished_at = new Date().toISOString(); result.stop_reason = request.status === 'rate_limit' ? 'HTTP_429_model_3.5' : null;

function summarize(c) {
  const reqs = c.requests; const outputs = reqs.flatMap(r => r.titles ?? []); const times = reqs.map(r => r.elapsed_ms).sort((a,b)=>a-b); const usage = reqs.map(r=>r.usage).filter(Boolean);
  const pct = (x, n) => n ? `${(100*x/n).toFixed(1)}%` : '—';
  return { requests:reqs.length, httpSuccess:reqs.filter(r=>r.http_status===200).length, httpRate:pct(reqs.filter(r=>r.http_status===200).length,reqs.length), jsonSchemaSuccess:reqs.filter(r=>r.json_valid&&r.schema_valid).length, jsonSchemaRate:pct(reqs.filter(r=>r.json_valid&&r.schema_valid).length,reqs.length), titleSuccess:outputs.filter(t=>t.status==='success').length, titleOutputs:outputs.length, titleRate:pct(outputs.filter(t=>t.status==='success').length,outputs.length), lengthCompliant:outputs.filter(t=>t.status!=='too_long').length, lengthRate:pct(outputs.filter(t=>t.status!=='too_long').length,outputs.length), failureReasons:Object.fromEntries([...new Set([...outputs.filter(t=>t.status!=='success').map(t=>t.status),...reqs.filter(r=>!['success','partial_failure'].includes(r.status)).map(r=>r.status)])].map(k=>[k,outputs.filter(t=>t.status===k).length+reqs.filter(r=>r.status===k).length])), latencyMs:{mean:times.length?Math.round(times.reduce((a,b)=>a+b,0)/times.length*10)/10:null,median:times.length?(times[Math.floor((times.length-1)/2)]+times[Math.ceil((times.length-1)/2)])/2:null,p95:times.length?times[Math.max(0,Math.ceil(times.length*.95)-1)]:null},inputTokens:usage.reduce((s,x)=>s+(x.promptTokenCount??0),0),outputTokens:usage.reduce((s,x)=>s+(x.candidatesTokenCount??0),0),thinkingTokens:usage.reduce((s,x)=>s+(x.thoughtsTokenCount??0),0) };
}
for (const c of result.conditions) c.summary = summarize(c);
await fs.writeFile(resultFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
let report = await fs.readFile(reportFile, 'utf8');
const lines = report.split('\n');
for (const line of lines) {
  const match = line.match(/^\| (\d+) \|/); if (!match) continue;
  const i = Number(match[1]) - 1; const t = dataset.topics[i]; if (i < 36 || i > 39) continue;
  const row = request.titles.find(x => x.id === t.id); const cells = line.split('|');
  cells[9] = ` ${row?.title ?? '未実行'} (${row?.status ?? 'not_run'}) `;
  lines[lines.indexOf(line)] = cells.join('|');
}
report = lines.join('\n');
const metricLines = ['', '## B/C machine metrics', '', '| Condition | HTTP success | JSON/schema success | Title success | <=47 chars | mean ms | median ms | p95 ms | input | output | thinking | status |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|'];
for (const c of result.conditions) { const s=c.summary; metricLines.push(`| ${c.model} × ${c.prompt} | ${s.httpSuccess}/${s.requests} (${s.httpRate}) | ${s.jsonSchemaSuccess}/${s.requests} (${s.jsonSchemaRate}) | ${s.titleSuccess}/${s.titleOutputs} (${s.titleRate}) | ${s.lengthCompliant}/${s.titleOutputs} (${s.lengthRate}) | ${s.latencyMs.mean??'—'} | ${s.latencyMs.median??'—'} | ${s.latencyMs.p95??'—'} | ${s.inputTokens} | ${s.outputTokens} | ${s.thinkingTokens} | ${c.status} |`); }
metricLines.push('', 'Failed or unrun batches are not retried. The 3.5×C batch 9 timeout remains a failed request; batch 10 is a distinct new batch, not a retry.', '');
await fs.writeFile(reportFile, report + '\n' + metricLines.join('\n'), 'utf8');
console.log(JSON.stringify({ status: request.status, http_status: request.http_status, elapsed_ms: request.elapsed_ms, usage: request.usage, titles: request.titles, api_calls: result.api_calls }));
