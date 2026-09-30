import json, re, subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from lxml import html as lhtml
import trafilatura

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'tools'/'trafilatura_comparison'/'runs'/('live-'+datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')); (OUT/'html').mkdir(parents=True)
URLS=[
 ('tv-asahi','https://news.tv-asahi.co.jp/news_politics/articles/000535072.html'),
 ('itmedia','https://www.itmedia.co.jp/news/article/2606/04/1260604102/'),
 ('mynavi','https://news.mynavi.jp/article/20260922-4829487/DETAIL/'),
 ('ntv','https://news.ntv.co.jp/new/society'),
 ('itmedia-news','https://www.itmedia.co.jp/news/')]
HELPER=ROOT/'tools'/'trafilatura_comparison'/'readability_helper.mjs'
def paras(markup):
 try:
  r=lhtml.fromstring(markup or '<div></div>'); return [re.sub(r'\s+',' ',''.join(x.itertext())).strip() for x in r.xpath('.//p|.//h1|.//h2|.//h3|.//li') if ''.join(x.itertext()).strip()]
 except Exception:return []
def noise(s):
 return {k:len(re.findall(p,s or '',re.I)) for k,p in {'related':r'関連記事|関連ニュース|おすすめ|こちらも|related articles','product_ad':r'商品|価格|購入|amazon|楽天|広告|sponsored','comments_ugc':r'コメント|返信|投稿|ユーザー|comment|reply','cta_membership':r'会員|ログイン|登録|購読|続きを読む|subscribe|sign in'}.items()}
def node(path):
 p=subprocess.run(['node',str(HELPER),str(path)],cwd=ROOT,capture_output=True,text=True,encoding='utf-8',errors='replace')
 return json.loads(p.stdout) if p.returncode==0 else {'success':False,'text':'','html':'','clean_text':'','error':p.stderr[-1000:]}
rows=[]
for slug,url in URLS:
 try:
  req=Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; local extraction evaluation)'})
  raw=urlopen(req,timeout=20).read(); (OUT/'html'/f'{slug}.html').write_bytes(raw); text=raw.decode('utf-8','replace')
  rr=node(OUT/'html'/f'{slug}.html')
  outs={}
  for name,markup in [('readability',rr.get('html','')),('safe_post_clean',rr.get('html','')),('trafilatura_standard',trafilatura.extract(text,output_format='html',include_comments=True,include_tables=True) or ''),('trafilatura_precision',trafilatura.extract(text,output_format='html',include_comments=True,include_tables=True,favor_precision=True) or '')]:
   if name=='readability': val=rr.get('text','')
   elif name=='safe_post_clean': val=rr.get('clean_text','')
   else: val=lhtml.fromstring(markup or '<div></div>').text_content()
   val=re.sub(r'\s+',' ',val).strip(); outs[name]={'success':bool(val),'chars':len(val),'paragraphs':paras(markup),'noise':noise(val),'text':val}
  rows.append({'slug':slug,'url':url,'html_bytes':len(raw),'result':outs,'status':'ok'})
 except Exception as e: rows.append({'slug':slug,'url':url,'status':'error','error':str(e)})
out={'generated_at':datetime.now(timezone.utc).isoformat(),'article_count':len(rows),'trafilatura_version':trafilatura.__version__,'rows':rows}
(OUT/'results.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
md=['# Live fallback evaluation','',f'- Trafilatura {trafilatura.__version__}','- HTML fetched only for these test URLs; no API/AI API','', '| site | URL | Readability | Standard | Precision |', '|---|---|---:|---:|---:|']
for r in rows:
 if r['status']!='ok': md.append(f"| {r['slug']} | {r['url']} | fetch error | | |"); continue
 def c(k):
  x=r['result'][k]; return f"{x['chars']}字 / noise={sum(x['noise'].values())}"
 md.append(f"| {r['slug']} | {r['url']} | {c('readability')} | {c('trafilatura_standard')} | {c('trafilatura_precision')} |")
(OUT/'comparison.md').write_text('\n'.join(md),encoding='utf-8'); print(OUT)
