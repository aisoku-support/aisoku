#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY = path.resolve(ROOT, '../model_comparison');
const DATASET = path.join(ROOT, 'dataset');
const RESULTS = path.join(ROOT, 'results');
const DETAILS = path.join(RESULTS, 'details');
const csvEscape = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
const safe = (v) => v ?? null;

function failureType(r) {
  if (r.error_type === 'json_parse_error') return 'parse_error';
  if (r.error_type === 'network_error') return 'network_error';
  if (r.error_type === 'empty_output') return 'empty_output';
  if (r.error_type === 'http_error') return r.http_status === 429 ? 'rate_limit' : 'http_error';
  if (r.json_parse_succeeded === false && r.raw_model_output != null) return 'parse_error';
  if (r.finish_reason === 'length') return 'max_tokens';
  return null;
}

function modelId(model) {
  return model === 'openai/gpt-oss-120b' ? 'gpt-oss-120b' : model === 'qwen/qwen3.8-27b' ? 'qwen3.8-27b' : model === '@cf/google/gemma-4-26b-a4b-it' ? 'gemma-4-26b' : model;
}

await fs.mkdir(path.join(DATASET, 'articles'), { recursive: true });
await fs.mkdir(path.join(ROOT, 'models'), { recursive: true });
await fs.mkdir(DETAILS, { recursive: true });
const source = JSON.parse(await fs.readFile(path.join(LEGACY, 'articles.json'), 'utf8'));
const articles = source.articles;
const index = new Map(articles.map((a, i) => [a.id, `article-${String(i + 1).padStart(3, '0')}`]));
const addedAt = source.created_at ?? null;
const rows = [['article_id', 'title', 'origin', 'source_id', 'added_at']];
for (const [i, a] of articles.entries()) {
  const articleId = `article-${String(i + 1).padStart(3, '0')}`;
  const doc = { article_id: articleId, origin: 'initial-23', added_at: addedAt, title: a.title, description: a.description, source: { type: 'newsdata', source_id: a.id, source_name: a.source ?? null, published_at: a.published_at ?? null, url: a.url ?? null, normalized_url: a.normalized_url ?? null, newsdata_categories: a.newsdata_categories ?? null }, legacy: { app_categories: a.app_categories ?? null } };
  await fs.writeFile(path.join(DATASET, 'articles', `${articleId}.json`), JSON.stringify(doc, null, 2) + '\n');
  rows.push([articleId, a.title, 'initial-23', a.id, addedAt]);
}
await fs.writeFile(path.join(DATASET, 'articles.csv'), rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n');
await fs.writeFile(path.join(ROOT, 'models', 'models.json'), JSON.stringify({ models: [
  { model_id: 'gpt-oss-120b', display_name: 'GPT-OSS 120B', provider: 'Groq', source_model: 'openai/gpt-oss-120b' },
  { model_id: 'qwen3.8-27b', display_name: 'Qwen 3.8 27B', provider: 'Groq', source_model: 'qwen/qwen3.8-27b' },
  { model_id: 'gemma-4-26b', display_name: 'Gemma 4 26B', provider: 'Cloudflare', source_model: '@cf/google/gemma-4-26b-a4b-it' },
] }, null, 2) + '\n');

const headers = ['run_id','article_id','model_id','model_display_name','provider','task','status','failure_type','latency_ms','http_status','finish_reason','input_tokens','output_tokens','reasoning_tokens','prompt_version','detail_file'];
const csv = [headers]; let converted = 0; const sourceFiles = (await fs.readdir(path.join(LEGACY, 'results'))).filter(f => f.endsWith('.json'));
for (const file of sourceFiles) {
  const runId = path.basename(file, '.json'); const batch = JSON.parse(await fs.readFile(path.join(LEGACY, 'results', file), 'utf8'));
  for (const r of batch.results ?? []) {
    const articleId = index.get(r.article_id); if (!articleId) continue;
    const model_id = modelId(r.model); const failure_type = failureType(r); const status = r.json_parse_succeeded && r.parsed_comments ? 'success' : failure_type ? 'failed' : 'incomplete';
    const detailName = `${runId}__${articleId}__${model_id}.json`; const detail = { result_version: 1, run_id: runId, article_id: articleId, model: { model_id, display_name: model_id, provider: r.provider ?? null, source_model: r.model ?? null }, task: 'comments', status, answer: { comments: r.parsed_comments ?? null }, checks: { http_success: r.http_status >= 200 && r.http_status < 300, parse_success: r.json_parse_succeeded ?? null, expected_count: r.generation?.count ?? null, actual_count: Array.isArray(r.parsed_comments) ? r.parsed_comments.length : null }, failure: failure_type ? { type: failure_type, message: r.error_message ?? null } : null, metrics: { latency_ms: safe(r.latency_ms), http_status: safe(r.http_status), finish_reason: safe(r.finish_reason), input_tokens: safe(r.usage?.input_tokens), output_tokens: safe(r.usage?.output_tokens), reasoning_tokens: safe(r.usage?.reasoning_tokens) }, prompt: { version: safe(r.prompt_version), sha256: safe(r.prompt_sha256) }, raw: { output: safe(r.raw_model_output), provider_response_debug: safe(r.provider_response_debug) }, legacy_source: path.join('tools', 'model_comparison', 'results', file) };
    await fs.writeFile(path.join(DETAILS, detailName), JSON.stringify(detail, null, 2) + '\n');
    csv.push([runId, articleId, model_id, model_id, r.provider ?? '', 'comments', status, failure_type ?? '', r.latency_ms, r.http_status, r.finish_reason, r.usage?.input_tokens, r.usage?.output_tokens, r.usage?.reasoning_tokens, r.prompt_version, `details/${detailName}`]); converted++;
  }
}
await fs.writeFile(path.join(RESULTS, 'results.csv'), csv.map(r => r.map(csvEscape).join(',')).join('\n') + '\n');
console.log(JSON.stringify({ articles: articles.length, source_files: sourceFiles.length, converted, dataset_ids: [...index.values()] }, null, 2));
