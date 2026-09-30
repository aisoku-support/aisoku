import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from '../../readability_defuddle_comparison/node_modules/jsdom/lib/api.js';
import readabilityModule from '../../readability_defuddle_comparison/node_modules/@mozilla/readability/Readability.js';
import { clean } from './cleaner.mjs';
import { preClean } from './preclean.mjs';
const Readability = readabilityModule.default ?? readabilityModule;

const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.resolve(here, '..');
const source = path.resolve(root, '../readability_defuddle_comparison/runs/2026-09-22T07-26-43-315Z');
const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const out = path.join(root, 'results', stamp);
for (const d of ['details','baseline','post_clean','pre_post_clean','removed_nodes']) await fs.mkdir(path.join(out,d), {recursive:true});
const detailFiles = (await fs.readdir(path.join(source,'details'))).filter(x=>x.endsWith('.json'));
const htmlFiles = new Set(await fs.readdir(path.join(source,'html')));
const articles=[];
function textOf(doc){return (doc?.textContent||'').replace(/\s+/g,' ').trim();}
function parse(html){const dom=new JSDOM(html); const result=new Readability(dom.window.document).parse(); return {dom,result};}
function headTail(a,b){const n=80; return {a_start:a.slice(0,n), c_start:b.slice(0,n), a_end:a.slice(-n), c_end:b.slice(-n), start_same:b.startsWith(a.slice(0,Math.min(n,a.length))), end_same:b.endsWith(a.slice(-Math.min(n,a.length)))};}
for (const df of detailFiles) {
  const meta=JSON.parse(await fs.readFile(path.join(source,'details',df),'utf8')); if(!meta.readability?.success) continue;
  const id=meta.article_id; const hf=`${id}.html`; if(!htmlFiles.has(hf)) continue; const html=await fs.readFile(path.join(source,'html',hf),'utf8');
  const a=parse(html); const aText=textOf(new JSDOM(a.result?.content||'').window.document.body); const aTitle=a.result?.title||null;
  const b=parse(html); const bContentDom=new JSDOM(b.result?.content||'<div></div>'); const bRemoved=clean(bContentDom.window.document.body); const bText=textOf(bContentDom.window.document.body); const bTitle=b.result?.title||null;
  const cdom=new JSDOM(html); const preRemoved=preClean(cdom.window.document); const cRead=new Readability(cdom.window.document).parse(); const cReadText=textOf(new JSDOM(cRead?.content||'').window.document.body); const cTitle=cRead?.title||null;
  const cPostDom=new JSDOM(cRead?.content||'<div></div>'); const postRemoved=clean(cPostDom.window.document.body); const cText=textOf(cPostDom.window.document.body);
  const change=headTail(aText,cReadText); const readabilityChanged=aTitle!==cTitle || aText!==cReadText;
  const falseDeletion=Boolean(aText.length && cReadText.length < aText.length*.65 && !change.start_same && !change.end_same);
  const status=falseDeletion ? 'regression' : (preRemoved.length||postRemoved.length) ? 'improved' : 'unchanged';
  const item={article_id:id,title:meta.title,source:meta.source, A:{readability_title:aTitle,chars:aText.length,text:aText}, B:{readability_title:bTitle,chars:bText.length,post_removed: bRemoved.length,text:bText}, C:{readability_title:cTitle,readability_chars:cReadText.length,final_chars:cText.length,pre_removed:preRemoved.length,post_removed:postRemoved.length,readability_text:cReadText,text:cText}, readability_selection_changed:readabilityChanged, readability_diff:change, normal_body_false_deletion:falseDeletion, status, removed:{pre:preRemoved,post:postRemoved}};
  articles.push(item); await fs.writeFile(path.join(out,'details',`${id}.json`),JSON.stringify(item,null,2));
  await fs.writeFile(path.join(out,'baseline',`${id}.txt`),aText); await fs.writeFile(path.join(out,'post_clean',`${id}.txt`),bText); await fs.writeFile(path.join(out,'pre_post_clean',`${id}.txt`),cText); await fs.writeFile(path.join(out,'removed_nodes',`${id}.json`),JSON.stringify(item.removed,null,2));
}
const allFixtures=[...JSON.parse(await fs.readFile(path.join(root,'fixtures/fixtures.json'),'utf8')),...JSON.parse(await fs.readFile(path.join(root,'fixtures/preclean-fixtures.json'),'utf8'))]; const fixtureResults=[];
for(const f of allFixtures){const d=new JSDOM(f.html); const pre=preClean(d.window.document.body); const post=clean(d.window.document.body); const after=textOf(d.window.document.body); const pass=f.keep.every(x=>after.includes(x))&&f.remove.every(x=>!after.includes(x))&&(f.expect_removed===undefined || (f.expect_removed ? pre.length>0 : pre.length===0)); fixtureResults.push({id:f.id,pass,pre_removed:pre,post_removed:post,output:after,expected_keep:f.keep,expected_remove:f.remove});}
const summary={experiment:'Readability before/after generic DOM cleaner A/B/C',source_run:'2026-09-22T07-26-43-315Z',readability_version:'0.6.0',jsdom_version:'30.1.1',real_html_count:articles.length,fixture_count:allFixtures.length,aggregate:{improved:articles.filter(x=>x.status==='improved').length,unchanged:articles.filter(x=>x.status==='unchanged').length,regression:articles.filter(x=>x.status==='regression').length,not_applicable:4,normal_body_false_deletions:articles.filter(x=>x.normal_body_false_deletion).length,readability_selection_changed:articles.filter(x=>x.readability_selection_changed).length,fixture_pass:fixtureResults.filter(x=>x.pass).length,fixture_fail:fixtureResults.filter(x=>!x.pass).length},articles:articles.map(x=>({article_id:x.article_id,title:x.title,source:x.source,A:{title:x.A.readability_title,chars:x.A.chars},B:{chars:x.B.chars,post_removed:x.B.post_removed},C:{readability_title:x.C.readability_title,readability_chars:x.C.readability_chars,final_chars:x.C.final_chars,pre_removed:x.C.pre_removed,post_removed:x.C.post_removed},readability_selection_changed:x.readability_selection_changed,normal_body_false_deletion:x.normal_body_false_deletion,status:x.status})),fixtures:fixtureResults,rule_risk:{safe:['Post:独立ブロック内rel=sponsoredかつ自然文ほぼなし'],medium:['Pre:関連記事見出し+複数リンク+高リンク密度+自然文不足+小さな独立container'],risky:['文言単独','高リンク密度単独','CTA文言単独','大きなancestor削除']},recommendation:'Pre-cleanは追加データ検証が必要。最小安全ancestorとReadability選択変化を継続監視する。'};
await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
let md=`# A/B/C Readability前後Generic DOM Cleaner\n\n- Readability ${summary.readability_version} / JSDOM ${summary.jsdom_version}\n- 保存HTMLのみ: ${summary.source_run}\n- 実HTML ${articles.length}件 / fixture ${allFixtures.length}件\n- improved ${summary.aggregate.improved}, unchanged ${summary.aggregate.unchanged}, regression ${summary.aggregate.regression}\n- 誤削除 ${summary.aggregate.normal_body_false_deletions}件 / fixture PASS ${summary.aggregate.fixture_pass}, FAIL ${summary.aggregate.fixture_fail}\n\n| article | A chars | B chars | C Readability | C final | C pre | C post | selection changed | status |\n|---|---:|---:|---:|---:|---:|---:|---|---|\n`;
for(const x of summary.articles) md+=`| ${x.article_id} | ${x.A.chars} | ${x.B.chars} | ${x.C.readability_chars} | ${x.C.final_chars} | ${x.C.pre_removed} | ${x.C.post_removed} | ${x.readability_selection_changed} | ${x.status} |\n`;
md+='\n## 削除ログ\n\n'; for(const x of articles){for(const stage of ['pre','post'])for(const r of x.removed[stage])md+=`- ${x.article_id} ${stage}: ${r.text_preview} (${r.chars} chars) — ${r.reasons.join(', ')}\n`;}
md+='\n## Fixture\n\n'; for(const f of fixtureResults)md+=`- ${f.id}: ${f.pass?'PASS':'FAIL'}; pre=${f.pre_removed.length}, post=${f.post_removed.length}\n`;
await fs.writeFile(path.join(out,'comparison.md'),md); console.log(JSON.stringify({run_dir:out,...summary.aggregate}));
