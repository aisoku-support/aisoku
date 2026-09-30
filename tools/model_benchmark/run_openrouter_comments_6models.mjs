import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const out = path.join(root, 'tools/model_benchmark/results/openrouter-comments-6models');
const datasetPath = path.join(root, 'tools/model_benchmark/dataset/newsdata-ja-10-articles.json');
const models = [
  'google/gemma-4-31b-it:free', 'thinkingmachines/inkling:free', 'qwen/qwen3.8-27b:free',
  'z-ai/glm-5.2:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-26b-a4b-it:free',
];
const articleIds = ['e6cba3c5d91a11482d04ede08a17c8e1', '3619bcbbccef285d6675f4df7cfe9a86', '7e9a212d10d7a388c54e3361efc13f63'];
const prompt = `あなたは日本の匿名ネット掲示板（5ちゃんねる等）の住民たちです。
以下の記事について、住民たちが様々な視点から語り合うスレッドの最初の10個のレスを生成してください。
・記事内容に基づき、記事にない具体的事実を勝手に追加しないでください。
・各レスは適度に文体・視点を変え、不自然に全員が同じ意見にならないようにしてください。
・必要に応じて >>1 等のレス表現を使用できます。
・出力は必ずJSON配列形式で、10個の文字列レス本文のみを出力してください。
・レス番号や投稿者名、IDは付けないでください。`;

function envKey() {
  const text = requireEnvFile();
  const m = text.match(/^OPENROUTER_API_KEY\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\r\n]*))/m);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}
function requireEnvFile() { return requireEnvFile.text; }
requireEnvFile.text = await fs.readFile(path.join(root, '.env'), 'utf8');
const apiKey = envKey();
if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
const modelsResponse = await fetch('https://openrouter.ai/api/v1/models', { headers });
const modelCatalog = modelsResponse.ok ? await modelsResponse.json() : { data: [] };
const catalog = new Map((modelCatalog.data ?? []).map(x => [x.id, x]));
const data = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
const byId = new Map((data.articles ?? []).map(x => [x.article_id, x]));
const articles = articleIds.map(id => {
  const a = byId.get(id); if (!a) throw new Error(`missing article ${id}`);
  const bodyField = ['extracted_body', 'readability_text', 'body', 'full_text'].find(k => typeof a[k] === 'string' && a[k].length > 0);
  if (!bodyField) throw new Error(`article has no body ${id}`);
  return { id, title: a.title ?? '', description: a.description ?? '', source: a.source_name ?? a.source ?? a.source_id ?? '', body: a[bodyField], bodyField };
});
await fs.mkdir(path.join(out, 'raw'), { recursive: true }); await fs.mkdir(path.join(out, 'prompts'), { recursive: true });
await fs.writeFile(path.join(out, 'articles.json'), JSON.stringify(articles.map(a => ({...a, body: undefined, body_chars: a.body.length})), null, 2));
const results = []; let requestIndex = 0;
function parseComments(raw) { try { const v = JSON.parse(String(raw).trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()); const comments = Array.isArray(v) ? v : v.comments; return { ok: Array.isArray(comments), comments: Array.isArray(comments) ? comments.map(x => typeof x === 'string' ? x : x?.text).filter(x => typeof x === 'string') : [] }; } catch { return { ok: false, comments: [] }; } }
for (const article of articles) {
  const finalPrompt = `${prompt}\n\nNEWS_TITLE: ${article.title}\nNEWS_DESCRIPTION: ${article.description}\nNEWS_BODY: ${article.body}`;
  await fs.writeFile(path.join(out, 'prompts', `${article.id}.txt`), finalPrompt);
  for (const model of models) {
    requestIndex++; const startedAt = new Date().toISOString(); const t = performance.now();
    const info = catalog.get(model); const supported = info?.supported_parameters ?? [];
    const useFormat = supported.includes('response_format') || supported.includes('structured_outputs');
    const body = { model, messages: [{ role: 'user', content: finalPrompt }], temperature: 0.95, max_tokens: 1200 };
    if (useFormat) body.response_format = { type: 'json_object' };
    let status = null, rawBody = null, error = null, rawText = '', responseFormatUsed = useFormat;
    try { const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }); status = r.status; rawText = await r.text(); try { rawBody = JSON.parse(rawText); } catch { rawBody = { raw_text: rawText }; } } catch (e) { error = `${e.name}: ${e.message}`; }
    const latency = Math.round(performance.now() - t); const choice = rawBody?.choices?.[0]; const raw = choice?.message?.content ?? ''; const parsed = parseComments(raw); const comments = parsed.comments;
    if (status === null) error ??= 'network_or_timeout'; else if (status < 200 || status >= 300) error = rawBody?.error?.message ?? `HTTP ${status}`;
    if (!parsed.ok && !error) error = 'JSON parse error';
    const result = { article_id: article.id, model, request_index: requestIndex, started_at: startedAt, latency_ms: latency, http_status: status, success: status >= 200 && status < 300 && parsed.ok, finish_reason: choice?.finish_reason ?? null, usage: rawBody?.usage ?? {}, response_format_used: responseFormatUsed, structured_outputs_supported: useFormat, parse_success: parsed.ok, comment_count: comments.length, comments: parsed.ok ? comments : [], error };
    results.push(result);
    await fs.writeFile(path.join(out, 'raw', `${article.id}__${model.replaceAll('/', '__').replace(':free','')}.json`), JSON.stringify({ http_status: status, body: rawBody, error }, null, 2));
  }
}
await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ request_count: results.length, articles: articles.map(a => ({article_id:a.id,title:a.title,description:a.description,source:a.source,body_chars:a.body.length,input_field:a.bodyField})), models, results }, null, 2));
const md = ['# OpenRouter 6モデル AI速コメント比較', '', `- request_count: ${results.length}`, '- retry: 0', '', '## Articles'];
for (const a of articles) md.push(`- ${a.id} | ${a.title} | source=${a.source} | body_chars=${a.body.length} | input=${a.bodyField}`);
for (const a of articles) { md.push('', `## ${a.id} ${a.title}`); for (const r of results.filter(x => x.article_id === a.id)) { md.push('', `### ${r.model}`, `- HTTP: ${r.http_status} | ${r.success ? 'success' : 'error'} | latency_ms: ${r.latency_ms} | finish_reason: ${r.finish_reason}`, `- usage: ${JSON.stringify(r.usage)} | parse_success: ${r.parse_success} | comment_count: ${r.comment_count}`, `- response_format_used: ${r.response_format_used} | structured_outputs_supported: ${r.structured_outputs_supported}`); if (r.error) md.push(`- error: ${r.error}`); r.comments.forEach((c,i) => md.push(`${i+1}. ${c}`)); } }
await fs.writeFile(path.join(out, 'summary.md'), md.join('\n') + '\n');
console.log(JSON.stringify({preflight:{articles:articles.map(a=>({id:a.id,title:a.title,description:a.description,source:a.source,body_chars:a.body.length,input_field:a.bodyField})),models,total_requests:18,retry:0,key_present:true,output:out}, model_catalog:models.map(m=>({model:m,exists:catalog.has(m),structured_outputs:(catalog.get(m)?.supported_parameters??[]).includes('response_format')||(catalog.get(m)?.supported_parameters??[]).includes('structured_outputs')})), completed:results.length}));
