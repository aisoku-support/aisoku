import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const root = process.cwd();
const input = JSON.parse(fs.readFileSync(path.join(root, 'tools/model_benchmark/dataset/newsdata-raw-1credit.json'), 'utf8'));
const articles = input.results.slice(0, 10);
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chars(value) { return typeof value === 'string' ? value.trim().length : 0; }
function classify(n) { return n >= 2000 ? 'excellent' : n >= 1000 ? 'good' : n >= 500 ? 'usable' : n > 0 ? 'poor' : 'failed'; }
function schemaBody(html) {
  const dom = new JSDOM(html);
  const candidates = [];
  for (const node of dom.window.document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(node.textContent || '');
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const walk = (v) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) return v.forEach(walk);
        const type = Array.isArray(v['@type']) ? v['@type'] : [v['@type']];
        if (type.some((t) => typeof t === 'string' && /article|posting/i.test(t)) && chars(v.articleBody)) candidates.push({ chars: chars(v.articleBody), type: type.join(',') });
        if (v['@graph']) walk(v['@graph']);
      };
      values.forEach(walk);
    } catch {}
  }
  candidates.sort((a, b) => b.chars - a.chars);
  return candidates[0] ?? null;
}
function notesFor(article, readability) {
  const notes = [];
  if (readability?.textContent && /related|関連記事|recommended|おすすめ|navigation|menu|footer/i.test(readability.textContent)) notes.push('Readability本文にナビゲーション・関連記事等の語が含まれるため、長さだけでは本文純度を保証しない');
  if (article.status >= 300 && article.status < 400) notes.push('リダイレクト後URLを記録');
  if (article.error) notes.push('HTTP取得失敗');
  return notes;
}

const results = [];
for (const source of articles) {
  const started = performance.now();
  const row = { article_id: source.article_id ?? null, source_name: source.source_name ?? null, link: source.link ?? null, description_chars: chars(source.description), http: {}, jsonld: {}, readability: {}, best_extracted_chars: 0, verdict: 'failed', notes: [] };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try { response = await fetch(source.link, { headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: controller.signal }); }
    finally { clearTimeout(timer); }
    const html = await response.text();
    row.http = { status: response.status, final_url: response.url, content_type: response.headers.get('content-type'), html_chars: html.length, elapsed_ms: Math.round(performance.now() - started), timeout: false, error: null };
    const body = schemaBody(html);
    row.jsonld = { success: Boolean(body), article_body_chars: body?.chars ?? 0, selected_type: body?.type ?? null };
    const dom = new JSDOM(html, { url: response.url });
    const parsed = new Readability(dom.window.document).parse();
    row.readability = parsed ? { success: true, title: parsed.title ?? null, byline: parsed.byline ?? null, excerpt: parsed.excerpt ?? null, site_name: parsed.siteSiteName ?? parsed.siteName ?? null, text_content_chars: chars(parsed.textContent) } : { success: false, title: null, byline: null, excerpt: null, site_name: null, text_content_chars: 0 };
    row.best_extracted_chars = Math.max(row.jsonld.article_body_chars, row.readability.text_content_chars);
    row.verdict = classify(row.best_extracted_chars);
    row.notes = notesFor(row, parsed);
  } catch (error) {
    row.http = { status: null, final_url: null, content_type: null, html_chars: 0, elapsed_ms: Math.round(performance.now() - started), timeout: error?.name === 'AbortError', error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'request failed').replace(/https?:\/\/\S+/g, '[redacted-url]') };
    row.jsonld = { success: false, article_body_chars: 0, selected_type: null };
    row.readability = { success: false, title: null, byline: null, excerpt: null, site_name: null, text_content_chars: 0 };
    row.notes = notesFor(row, null);
  }
  results.push(row);
  await sleep(25);
}

const ok = results.filter((r) => r.http.status >= 200 && r.http.status < 400);
const best = results.map((r) => r.best_extracted_chars);
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sorted = results.map((r) => r.http.elapsed_ms).sort((a, b) => a - b);
const median = sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2 : 0;
const descriptions = results.map((r) => r.description_chars);
const avgDescription = mean(descriptions);
const avgBest = mean(best);
const output = {
  generated_at: new Date().toISOString(),
  input_file: 'tools/model_benchmark/dataset/newsdata-raw-1credit.json',
  method: { http_get_only: true, request_count: results.length, user_agent: ua, redirects: 'follow', timeout_ms: 15000, retries: 0, javascript_execution: false, external_subresources: false, jsonld_selection: 'Article系schemaのarticleBody候補から文字数最大のものを選択', readability: '@mozilla/readability with jsdom' },
  summary: { articles: results.length, http_get_success: ok.length, jsonld_article_body_success: results.filter((r) => r.jsonld.success).length, readability_success: results.filter((r) => r.readability.success && r.readability.text_content_chars > 0).length, at_least_500: best.filter((n) => n >= 500).length, at_least_1000: best.filter((n) => n >= 1000).length, at_least_2000: best.filter((n) => n >= 2000).length, practically_unusable: best.filter((n) => n < 500).length, description_average_chars: avgDescription, best_extracted_average_chars: avgBest, information_multiplier_vs_description: avgDescription ? avgBest / avgDescription : null, http_elapsed_ms_average: mean(results.map((r) => r.http.elapsed_ms)), http_elapsed_ms_median: median, http_elapsed_ms_max: Math.max(0, ...results.map((r) => r.http.elapsed_ms)) },
  articles: results,
};
const base = path.join(root, 'tools/model_benchmark/results/direct-article-extraction-test.json');
let target = base;
if (fs.existsSync(target)) { const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); let i = 0; do { target = path.join(root, 'tools/model_benchmark/results', `direct-article-extraction-test-${stamp}${i ? `-${i}` : ''}.json`); i++; } while (fs.existsSync(target)); }
fs.writeFileSync(target, JSON.stringify(output, null, 2), { flag: 'wx' });
console.log(target);
