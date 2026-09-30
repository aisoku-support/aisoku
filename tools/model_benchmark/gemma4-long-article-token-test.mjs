import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const root = process.cwd();
const input = JSON.parse(fs.readFileSync(path.join(root, 'tools/model_benchmark/dataset/newsdata-raw-1credit.json'), 'utf8'));
const source = input.results.find((a) => a.source_name === 'N&uuml;rnberger' && a.link.includes('prozess-gegen-ex-minister-scheuer-nach-maut-debakel-begonnen'));
if (!source) throw new Error('Target article not found');

const envText = fs.readFileSync(path.join(root, '.env'), 'utf8');
const apiKey = envText.match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('GEMINI_API_KEY missing');

const response = await fetch(source.link, {
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', accept: 'text/html,application/xhtml+xml' },
  redirect: 'follow',
});
const html = await response.text();
const dom = new JSDOM(html, { url: response.url });
const article = new Readability(dom.window.document).parse();
if (!article?.textContent) throw new Error('Readability extraction failed');

const model = 'gemma-4-26b-a4b-it';
const prompt = 'Extract only concrete facts explicitly stated in the title or description. Do not infer or add information. Output one fact per line. Do not output numbering, bullets, labels, JSON, Markdown, or explanations. Keep each fact concise, around 50 Japanese characters.';
const title = source.title;
const text = article.textContent.trim();
const fullInput = JSON.stringify([{ index: 0, title, description: text }]);
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`;

async function count(contents, systemInstruction) {
  const body = { contents };
  if (systemInstruction !== undefined) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) });
  const json = await r.json();
  if (!r.ok) throw new Error(`countTokens HTTP ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return { http_status: r.status, tokens: json.totalTokens };
}

const bodyOnly = await count([{ parts: [{ text }] }]);
const promptOnly = await count([{ parts: [{ text: prompt }] }]);
const complete = await count([{ parts: [{ text: `${prompt}\n${fullInput}` }] }]);
const completeTokens = complete.tokens;
const output = {
  measured_at: new Date().toISOString(),
  purpose: 'Gemma 4 26B Stage 2-equivalent countTokens measurement; no generation',
  source: source.source_name,
  article_url: source.link,
  final_url: response.url,
  readability_text_chars: text.length,
  body_only_tokens: bodyOnly.tokens,
  stage2_prompt_only_tokens: promptOnly.tokens,
  stage2_complete_input_tokens: completeTokens,
  model_id: model,
  count_tokens_http_status: [bodyOnly.http_status, promptOnly.http_status, complete.http_status],
  count_tokens_call_count: 3,
  tpm_limit: 16000,
  tpm_percentage: completeTokens / 16000 * 100,
  theoretical_articles_per_minute: Math.floor(16000 / completeTokens),
  body_chars_per_token: text.length / bodyOnly.tokens,
  chars_per_token: bodyOnly.tokens / text.length,
  estimated_tokens_for_8000_chars: Math.round(8000 * bodyOnly.tokens / text.length),
  stage2_input_shape: { system_instruction: 'facts extraction prompt', contents: '[{"index":0,"title":source.title,"description":Readability textContent}]', thinking_level: 'MINIMAL', generation_endpoint_not_called: true },
  article_body_saved: false,
};
const out = path.join(root, 'tools/model_benchmark/results/gemma4-long-article-token-test.json');
fs.writeFileSync(out, JSON.stringify(output, null, 2) + '\n', { encoding: 'utf8' });
console.log(JSON.stringify(output, null, 2));
