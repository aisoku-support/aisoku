import json, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
from lxml import html as lhtml
import trafilatura

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'tools' / 'readability_defuddle_comparison' / 'runs' / '2026-09-22T07-26-43-315Z'
OUT = ROOT / 'tools' / 'trafilatura_comparison' / 'runs' / datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
OUT.mkdir(parents=True, exist_ok=True)

NODE = r'''import fs from 'node:fs'; import {JSDOM} from '../readability_defuddle_comparison/node_modules/jsdom/lib/api.js'; import mod from '../readability_defuddle_comparison/node_modules/@mozilla/readability/Readability.js'; import {clean} from '../article_cleanup_experiment/src/cleaner.mjs'; const R=mod.default??mod; const f=process.argv[2]; const h=fs.readFileSync(f,'utf8'); const d=new JSDOM(h); const r=new R(d.window.document).parse(); const dom=new JSDOM(r?.content||'<div></div>'); const t=(dom.window.document.body.textContent||'').replace(/\s+/g,' ').trim(); const removed=clean(dom.window.document.body); const ct=(dom.window.document.body.textContent||'').replace(/\s+/g,' ').trim(); console.log(JSON.stringify({success:!!r,title:r?.title||null,html:r?.content||'',text:t,clean_text:ct,removed}));'''
NODE_FILE = ROOT / 'tools' / 'trafilatura_comparison' / 'readability_helper.mjs'; NODE_FILE.write_text(NODE, encoding='utf-8')

def paragraphs(text):
    try:
        root = lhtml.fromstring(text or '<div></div>')
        return [re.sub(r'\s+', ' ', ''.join(x.itertext())).strip() for x in root.xpath('.//p|.//h1|.//h2|.//h3|.//li') if ''.join(x.itertext()).strip()]
    except Exception:
        return [x.strip() for x in re.split(r'\n+', text or '') if x.strip()]

def noise(text):
    s = text or ''
    low = s.lower()
    def count(pattern): return len(re.findall(pattern, s, re.I))
    return {
        'related': count(r'関連記事|関連ニュース|おすすめ|こちらも|related articles|you may also'),
        'product_ad': count(r'商品|価格|購入|amazon|楽天|ps5|スポンサー|sponsored|広告'),
        'comments_ugc': count(r'コメント|返信|投稿|ユーザー|comment|reply'),
        'cta_membership': count(r'会員|ログイン|登録|購読|続きを読む|続き|subscribe|sign in|read more'),
    }

def run_readability(path):
    p = subprocess.run(['node', str(NODE_FILE), str(path)], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if p.returncode: raise RuntimeError(p.stderr)
    return json.loads(p.stdout)

records=[]
for detail in sorted((SOURCE/'details').glob('*.json')):
    meta=json.loads(detail.read_text(encoding='utf-8'))
    aid=meta['article_id']; hp=SOURCE/'html'/f'{aid}.html'
    if not hp.exists(): continue
    raw=hp.read_text(encoding='utf-8', errors='replace')
    rr=run_readability(hp)
    standard=trafilatura.extract(raw, output_format='html', include_comments=True, include_tables=True, favor_precision=False) or ''
    precision=trafilatura.extract(raw, output_format='html', include_comments=True, include_tables=True, favor_precision=True) or ''
    def rec(name, text, markup=None, success=True):
        ps=paragraphs(markup if markup is not None else text)
        return {'success':success and bool(text.strip()), 'chars':len(re.sub(r'\s+',' ',text or '').strip()), 'paragraph_count':len(ps), 'noise':noise(text), 'paragraphs':ps, 'text':re.sub(r'\s+',' ',text or '').strip()}
    readability=rec('readability',rr.get('text',''),rr.get('html',''),rr.get('success',False))
    safe=rec('safe_post_clean',rr.get('clean_text',''),rr.get('html',''),rr.get('success',False))
    std=rec('trafilatura_standard',standard,standard)
    prec=rec('trafilatura_precision',precision,precision)
    rp=set(readability['paragraphs']); tp=set(std['paragraphs']); pp=set(prec['paragraphs'])
    records.append({'article_id':aid,'title':meta.get('title'),'source':meta.get('source'),'url':meta.get('url') or meta.get('link'),'html_bytes':len(raw.encode()),'readability':readability,'safe_post_clean':safe,'trafilatura_standard':std,'trafilatura_precision':prec,'paragraph_diff':{'readability_and_standard':sorted(rp&tp),'readability_only_vs_standard':sorted(rp-tp),'standard_only_vs_readability':sorted(tp-rp),'readability_and_precision':sorted(rp&pp),'readability_only_vs_precision':sorted(rp-pp),'precision_only_vs_readability':sorted(pp-rp)}})

summary={'generated_at':datetime.now(timezone.utc).isoformat(),'source_run':str(SOURCE.relative_to(ROOT)),'network_for_articles':False,'readability_version':'0.6.0','trafilatura_version':trafilatura.__version__,'article_count':len(records),'articles':records}
(OUT/'results.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
md=['# Readability / Trafilatura 比較','',f'- 入力: `{summary["source_run"]}` の保存HTMLのみ',f'- Readability: {summary["readability_version"]}',f'- Trafilatura: {summary["trafilatura_version"]}',f'- 記事数: {len(records)}','', '## 記事別比較','', '| source | article_id | Readability | Readability+safe | Trafilatura Standard | Trafilatura Precision |','|---|---|---:|---:|---:|---:|']
for a in records:
    def cell(k):
        x=a[k]; n=x['noise']; return f"{x['chars']}字 / {x['paragraph_count']}段落 (関連{n['related']},商品広告{n['product_ad']},UGC{n['comments_ugc']},CTA{n['cta_membership']})"
    md.append(f"| {a['source']} | `{a['article_id']}` | {cell('readability')} | {cell('safe_post_clean')} | {cell('trafilatura_standard')} | {cell('trafilatura_precision')} |")
md += ['', '## 段落差分', '']
for a in records:
    d=a['paragraph_diff']; md += [f"### {a['source']} / `{a['article_id']}`",f"- Readability ∩ Standard: {len(d['readability_and_standard'])}",f"- Readabilityのみ: {len(d['readability_only_vs_standard'])}",f"- Standardのみ: {len(d['standard_only_vs_readability'])}",f"- Readability ∩ Precision: {len(d['readability_and_precision'])}",f"- Readabilityのみ vs Precision: {len(d['readability_only_vs_precision'])}",f"- Precisionのみ: {len(d['precision_only_vs_readability'])}", '']
    for key,label in [('readability_only_vs_standard','Readabilityだけ'),('standard_only_vs_readability','Standardだけ'),('precision_only_vs_readability','Precisionだけ')]:
        md.append(f'#### {label}')
        md.extend([f'- {p[:300]}' for p in d[key][:30]] or ['- なし']); md.append('')
(OUT/'comparison.md').write_text('\n'.join(md),encoding='utf-8')
print(json.dumps({'out':str(OUT),'articles':len(records),'trafilatura':trafilatura.__version__},ensure_ascii=False))
