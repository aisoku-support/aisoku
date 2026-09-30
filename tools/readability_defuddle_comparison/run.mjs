import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Defuddle } from 'defuddle/node';

const root = path.resolve(process.cwd());
const inputPath = path.resolve(root, '..', 'model_benchmark', 'dataset', 'newsdata-ja-10-articles.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'runs', stamp);
const detailsDir = path.join(outDir, 'details');
const htmlDir = path.join(outDir, 'html');
await fs.mkdir(detailsDir, { recursive: true });
await fs.mkdir(htmlDir, { recursive: true });
const cacheDir = process.env.CACHE_HTML_DIR ? path.resolve(process.env.CACHE_HTML_DIR) : null;
const cacheSummaryPath = cacheDir ? path.join(path.dirname(cacheDir), 'summary.json') : null;
const cachedSummary = cacheSummaryPath ? JSON.parse(await fs.readFile(cacheSummaryPath, 'utf8')) : null;

const dataset = JSON.parse(await fs.readFile(inputPath, 'utf8'));
if (!Array.isArray(dataset.articles) || dataset.articles.length !== 10) throw new Error('Expected exactly 10 articles');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeName = (s) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
const decodeBody = (buffer) => {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return zlib.gunzipSync(buffer).toString('utf8');
  if (buffer.length >= 2 && buffer[0] === 0x78 && (buffer[1] === 0x9c || buffer[1] === 0xda || buffer[1] === 0x01)) {
    try { return zlib.inflateSync(buffer).toString('utf8'); } catch {}
  }
  try { return zlib.brotliDecompressSync(buffer).toString('utf8'); } catch {}
  return buffer.toString('utf8');
};
const textOf = (value) => typeof value === 'string' ? value : (value == null ? '' : String(value));
const chars = (value) => textOf(value).replace(/\s+/g, '').length;
const snippets = {
  related: ['関連記事', 'こちらもおすすめ', '関連キーワード'],
  productAd: ['PS5版 SILENT HILL', 'ドラゴンクエストモンスターズ4', 'FINAL FANTASY VII', 'メトロイド'],
  membership: ['会員限定', '有料登録', '記事利用サービス', 'ログインしてください'],
  ui: ['シェア', 'コメント', 'フォロー', 'SNS']
};
function flags(text) {
  return Object.fromEntries(Object.entries(snippets).map(([k, vals]) => [k, vals.filter((v) => text.includes(v))]));
}
function metadataFromDefuddle(result) {
  const keys = ['title', 'description', 'author', 'authors', 'site', 'siteName', 'published', 'publishedTime', 'date', 'url', 'image', 'type'];
  return Object.fromEntries(keys.filter((k) => result?.[k] != null).map((k) => [k, result[k]]));
}

const summary = [];
for (const [index, article] of dataset.articles.entries()) {
  const id = article.article_id || `article-${String(index + 1).padStart(2, '0')}`;
  const base = { article_id: id, title: article.title, source: article.source_name, url: article.link };
  const record = { ...base, source_metadata: article, fetched: {}, readability: {}, defuddle: {}, assessment: {} };
  let html = '';
  try {
    const cachedPath = cacheDir && path.join(cacheDir, `${safeName(id)}.html`);
    if (cachedPath) {
      html = decodeBody(await fs.readFile(cachedPath));
      const prior = cachedSummary.articles.find((x) => x.article_id === id);
      record.fetched = { status: prior.http_status, statusText: null, final_url: prior.final_url, redirect: prior.redirect, html_bytes: Buffer.byteLength(html), fetch_ms: prior.fetch_ms, content_type: null, error: null, failure_reason: prior.http_status >= 400 ? (prior.http_status === 403 ? 'http_403' : 'http_error') : (!html.trim() ? 'empty_html' : null), cached_from: cacheDir };
      await fs.writeFile(path.join(htmlDir, `${safeName(id)}.html`), html);
    } else {
    const started = performance.now();
    const response = await fetch(article.link, { redirect: 'follow' });
    html = decodeBody(Buffer.from(await response.arrayBuffer()));
    const fetchMs = Math.round(performance.now() - started);
    const finalUrl = response.url || article.link;
    record.fetched = {
      status: response.status,
      statusText: response.statusText,
      final_url: finalUrl,
      redirect: finalUrl !== article.link,
      html_bytes: Buffer.byteLength(html),
      fetch_ms: fetchMs,
      content_type: response.headers.get('content-type'),
      error: null,
      failure_reason: response.status >= 400 ? (response.status === 403 ? 'http_403' : 'http_error') : (!html.trim() ? 'empty_html' : null)
    };
    await fs.writeFile(path.join(htmlDir, `${safeName(id)}.html`), html);
    }
  } catch (error) {
    record.fetched = { status: null, final_url: null, redirect: false, html_bytes: 0, fetch_ms: null, content_type: null, error: String(error), failure_reason: 'fetch_failed' };
  }

  if (html && record.fetched.status < 400) {
    const domStarted = performance.now();
    try {
      const readabilityDom = new JSDOM(html, { url: record.fetched.final_url || article.link });
      const result = new Readability(readabilityDom.window.document, { debug: false }).parse();
      record.readability = result ? {
        success: true, chars: chars(result.textContent), ms: Math.round(performance.now() - domStarted),
        textContent: result.textContent || '', title: result.title || null, excerpt: result.excerpt || null,
        byline: result.byline || null, siteName: result.siteName || null, publishedTime: result.publishedTime || null,
        content_html: result.content || '', flags: flags(result.textContent || '')
      } : { success: false, chars: 0, ms: Math.round(performance.now() - domStarted), error: 'parse returned null', flags: {} };
    } catch (error) {
      record.readability = { success: false, chars: 0, ms: Math.round(performance.now() - domStarted), error: String(error), flags: {} };
    }

    const defuddleStarted = performance.now();
    try {
      const defuddleDom = new JSDOM(html, { url: record.fetched.final_url || article.link });
      const savedLog = console.log;
      console.log = () => {};
      let result;
      try {
        result = await Defuddle(defuddleDom.window.document, record.fetched.final_url || article.link, { debug: true, separateMarkdown: true });
      } finally {
        console.log = savedLog;
      }
      const content = textOf(result?.content ?? result?.textContent ?? result?.text);
      const contentText = result?.content ? new JSDOM(result.content).window.document.body.textContent || '' : content;
      record.defuddle = {
        success: Boolean(result && contentText.trim()), chars: chars(contentText), ms: Math.round(performance.now() - defuddleStarted),
        content: content, text: contentText, title: result?.title || null, metadata: metadataFromDefuddle(result),
        content_html: result?.content || '', markdown: result?.contentMarkdown || null, debug: result?.debug ?? result?.debugInfo ?? null, flags: flags(contentText),
        error: result && contentText.trim() ? null : 'parse returned empty content'
      };
    } catch (error) {
      record.defuddle = { success: false, chars: 0, ms: Math.round(performance.now() - defuddleStarted), content: '', metadata: {}, debug: null, flags: {}, error: String(error) };
    }
  } else {
    record.readability = { success: false, chars: 0, ms: 0, skipped: true, flags: {}, error: 'HTTP fetch unavailable' };
    record.defuddle = { success: false, chars: 0, ms: 0, skipped: true, content: '', flags: {}, error: 'HTTP fetch unavailable' };
  }
  record.assessment = { readability_flags: record.readability.flags, defuddle_flags: record.defuddle.flags, human_review_required: true };
  await fs.writeFile(path.join(detailsDir, `${safeName(id)}.json`), JSON.stringify(record, null, 2));
  summary.push({ article_id: id, title: article.title, source: article.source_name, url: article.link, http_status: record.fetched.status, fetch_ms: record.fetched.fetch_ms, html_bytes: record.fetched.html_bytes, final_url: record.fetched.final_url, redirect: record.fetched.redirect, readability_success: record.readability.success, readability_chars: record.readability.chars, readability_ms: record.readability.ms, defuddle_success: record.defuddle.success, defuddle_chars: record.defuddle.chars, defuddle_ms: record.defuddle.ms, failure_reason: record.fetched.failure_reason || record.readability.error || record.defuddle.error || null, readability_flags: record.readability.flags, defuddle_flags: record.defuddle.flags });
  console.log(`${index + 1}/10 ${article.source_name} status=${record.fetched.status ?? 'fetch-failed'} R=${record.readability.chars} D=${record.defuddle.chars}`);
  await sleep(50);
}

const countFlag = (name) => summary.filter((x) => x.readability_flags?.[name]?.length || x.defuddle_flags?.[name]?.length).length;
const aggregate = { total: 10, http_success: summary.filter((x) => x.http_status >= 200 && x.http_status < 400).length, readability_success: summary.filter((x) => x.readability_success).length, defuddle_success: summary.filter((x) => x.defuddle_success).length, readability_only_success: summary.filter((x) => x.readability_success && !x.defuddle_success).length, defuddle_only_success: summary.filter((x) => !x.readability_success && x.defuddle_success).length, both_success: summary.filter((x) => x.readability_success && x.defuddle_success).length, both_failed: summary.filter((x) => !x.readability_success && !x.defuddle_success).length, related_noise_articles: countFlag('related'), product_ad_noise_articles: countFlag('productAd'), membership_ui_noise_articles: countFlag('membership') };
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const packageVersions = { readability: lock.packages['node_modules/@mozilla/readability'].version, defuddle: lock.packages['node_modules/defuddle'].version, jsdom: lock.packages['node_modules/jsdom'].version };
await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify({ generated_at: new Date().toISOString(), input: inputPath, package_versions: packageVersions, articles: summary, aggregate }, null, 2));

let md = `# Mozilla Readability / Defuddle 同一HTML比較\n\n- 実行日時: ${new Date().toISOString()}\n- 入力: ${inputPath}\n- 取得: 各URL 1回、redirect follow、retry 0、特殊なブラウザ偽装なし\n- DOM: JSDOM。各抽出器には同じ取得済みHTMLを別DOMとして入力\n- 注意: 抽出全文とHTMLは details/ と html/ に保存。ノイズ・本文保持の最終判定は人間確認用。\n\n## 記事別比較\n\n| # | source | HTTP | Readability | Defuddle | R flags | D flags | 判定メモ |\n|---:|---|---:|---:|---:|---|---|---|\n`;
summary.forEach((x, i) => { const r = x.readability_flags || {}, d = x.defuddle_flags || {}; md += `| ${i + 1} | ${x.source} | ${x.http_status ?? '-'} | ${x.readability_success ? `成功 ${x.readability_chars}字 / ${x.readability_ms}ms` : '失敗'} | ${x.defuddle_success ? `成功 ${x.defuddle_chars}字 / ${x.defuddle_ms}ms` : '失敗'} | ${Object.entries(r).filter(([,v]) => v.length).map(([k]) => k).join(', ') || '-'} | ${Object.entries(d).filter(([,v]) => v.length).map(([k]) => k).join(', ') || '-'} | 詳細JSONを確認 |\n`; });
md += `\n## 集計\n\n- HTTP取得成功: ${aggregate.http_success}/10\n- Readability抽出成功: ${aggregate.readability_success}/10\n- Defuddle抽出成功: ${aggregate.defuddle_success}/10\n- Readabilityのみ成功: ${aggregate.readability_only_success}\n- Defuddleのみ成功: ${aggregate.defuddle_only_success}\n- 両方成功: ${aggregate.both_success}\n- 両方失敗: ${aggregate.both_failed}\n- 関連記事・おすすめ等の候補語を含む記事: ${aggregate.related_noise_articles}\n- 商品・広告候補語を含む記事: ${aggregate.product_ad_noise_articles}\n- 会員誘導等候補語を含む記事: ${aggregate.membership_ui_noise_articles}\n\n## 重点確認\n\n- 「本文→関連記事/おすすめ→本文」の途中ノイズは、単純な文字列削除で判定せず、details/*.json の全文と content_html を確認する。今回の有無は各抽出全文のDOM順序を確認して確定する。\n- Investing.com等のHTTP 403は抽出器の性能比較から除外し、HTTP取得失敗として扱う。\n- 会員限定ページは、HTML上に存在する本文までを抽出した場合、本文抽出失敗とは扱わない。\n\n## 処理時間\n\n各記事の fetch_ms、readability_ms、defuddle_ms は summary.json に保存した。ReadabilityとDefuddleは同一HTML取得後に個別DOMを生成して計測しているため、抽出器処理時間にはDOM生成時間を含む。\n`;
await fs.writeFile(path.join(outDir, 'comparison.md'), md);
console.log(`OUTPUT=${outDir}`);
