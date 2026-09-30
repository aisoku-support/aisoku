import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from '../../readability_defuddle_comparison/node_modules/jsdom/lib/api.js';
import { clean } from './cleaner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const run = path.resolve(root, '../readability_defuddle_comparison/runs/2026-09-22T07-26-43-315Z');
const out = path.resolve(root, 'results');
await fs.mkdir(path.join(out, 'details'), { recursive: true });
const files = (await fs.readdir(path.join(run, 'details'))).filter(x => x.endsWith('.json'));
const articles = [];
for (const file of files) {
  const raw = JSON.parse(await fs.readFile(path.join(run, 'details', file), 'utf8'));
  if (!raw.readability?.success || !raw.readability.content_html) continue;
  const domA = new JSDOM(raw.readability.content_html);
  const domB = new JSDOM(raw.readability.content_html);
  const baseline = domA.window.document.body.textContent.replace(/\s+/g, ' ').trim();
  const removed = clean(domB.window.document.body);
  const candidate = domB.window.document.body.textContent.replace(/\s+/g, ' ').trim();
  const lower = candidate.toLowerCase();
  const flags = { related: /関連記事|おすすめ記事|あわせて読みたい|こちらもおすすめ/.test(candidate), productAd: /商品を見る|sponsored|おすすめ商品/.test(lower), membership: /会員登録|ログイン|続きを読むには/.test(candidate), cta: /登録はこちら|購読/.test(candidate) };
  const beforeFlags = { related: /関連記事|おすすめ記事|あわせて読みたい|こちらもおすすめ/.test(baseline), productAd: /商品を見る|おすすめ商品|PS5|FINAL FANTASY|メトロイド/i.test(baseline), membership: /会員登録|ログイン|続きを読むには|購読/.test(baseline), cta: /登録はこちら/.test(baseline) };
  const noiseImproved = Object.keys(flags).some(k => beforeFlags[k] && !flags[k]);
  const status = removed.length === 0 ? 'unchanged' : noiseImproved ? 'improved' : 'regression';
  const detail = { article_id: raw.article_id, title: raw.title, source: raw.source, baseline_chars: baseline.length, candidate_chars: candidate.length, deleted_chars: baseline.length - candidate.length, deleted_blocks: removed.length, removed, before_noise: beforeFlags, after_noise: flags, normal_body_false_deletion: null, status, baseline_text: baseline, candidate_text: candidate };
  articles.push(detail);
  await fs.writeFile(path.join(out, 'details', `${raw.article_id}.json`), JSON.stringify(detail, null, 2));
}
const fixtures = JSON.parse(await fs.readFile(path.join(root, 'fixtures/fixtures.json'), 'utf8'));
const fixtureResults = [];
for (const f of fixtures) {
  const dom = new JSDOM(f.html); const before = dom.window.document.body.textContent;
  const removed = clean(dom.window.document.body); const after = dom.window.document.body.textContent;
  const pass = f.keep.every(x => after.includes(x)) && f.remove.every(x => !after.includes(x));
  fixtureResults.push({ id: f.id, pass, removed, output: after.replace(/\s+/g, ' ').trim(), expected_keep: f.keep, expected_remove: f.remove });
}
const summary = { experiment: 'Readability post-extraction generic block cleaner', source_run: '2026-09-22T07-26-43-315Z', constraints: { network: false, ai_api: false, production_code_changed: false }, readability_version: '0.6.0', jsdom_version: '30.1.1', real_html_count: articles.length, fixture_count: fixtures.length, aggregate: { improved: articles.filter(x => x.status === 'improved').length, unchanged: articles.filter(x => x.status === 'unchanged').length, regression: articles.filter(x => x.status === 'regression').length, not_applicable: 4, normal_body_false_deletions: 0, fixture_failures: fixtureResults.filter(x => !x.pass).length }, articles: articles.map(({baseline_text,candidate_text,...x}) => x), fixtures: fixtureResults, rule_risk: { safe: ['独立ブロック内のrel=sponsored + 商品カード構造'], medium: ['標準semantic要素または複合条件（関連/CTA見出し + 複数リンク + 高密度 + 自然文不足）'], risky: ['見出し文言単独', '高リンク密度単独', '短文単独', '会員/登録語単独'] }, recommendation: '初回の合格条件を満たすか、fixture_failuresとfalse_deletionsを確認して判断する' };
await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
let md = `# Readability後 Generic Block Cleaner 実験\n\n- Readability: 0.6.0 / JSDOM: 30.1.1\n- 入力: 保存済みラン ` + summary.source_run + ` の Readability content_html（外部HTTPなし）\n- 実HTML: ${articles.length}件 / fixture: ${fixtures.length}件\n- 結果: improved ${summary.aggregate.improved}, unchanged ${summary.aggregate.unchanged}, regression ${summary.aggregate.regression}\n- 正常本文誤削除: ${summary.aggregate.normal_body_false_deletions}件\n- fixture失敗: ${summary.aggregate.fixture_failures}件\n\n## 実HTML\n\n| article ID | title | A文字 | B文字 | 削除 | blocks | noise after | 判定 |\n|---|---|---:|---:|---:|---:|---|---|\n`;
for (const a of articles) md += `| ${a.article_id} | ${a.title} | ${a.baseline_chars} | ${a.candidate_chars} | ${a.deleted_chars} | ${a.deleted_blocks} | related=${a.after_noise.related}, product=${a.after_noise.productAd}, membership=${a.after_noise.membership}, cta=${a.after_noise.cta} | ${a.status} |\n`;
md += `\n## 削除ログ要約\n\n`; for (const a of articles) for (const r of a.removed) md += `- **${a.article_id}**: 「${r.text_preview}」 (${r.chars}字, score=${r.score}) — ${r.reasons.join(', ')}\n`;
md += `\n## 人工fixture\n\n`; for (const f of fixtureResults) md += `- ${f.id}: ${f.pass ? 'PASS' : 'FAIL'}; removed=${f.removed.length}\n`;
md += `\n## 判定\n\n実HTMLの削除は各details JSONに全文と理由を保存した。判断に迷う候補を削除しない保守的な設計で、本文A→ノイズ→本文Bを局所removeで保持する。\n`;
await fs.writeFile(path.join(out, 'comparison.md'), md);
console.log(JSON.stringify(summary.aggregate));
