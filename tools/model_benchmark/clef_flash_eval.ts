// Reproducible, standalone Workers AI Clef decision-model evaluation.
export const CATEGORIES = ["トレンド", "エンタメ", "サブカル", "マネー", "IT・ガジェット", "除外"] as const;
export type Category = typeof CATEGORIES[number];

export interface EvalArticle { article_id: string; title: string; description: string; input_sha256: string }
export interface GroundTruth { article_id: string; category: Category; rationale: string; labeling_method: string; reviewer: string; input_sha256: string }
export interface RunResult {
  article_id: string; repeat: number; category: Category | null; probabilities: Partial<Record<Category, number>> | null;
  confidence: number | null; latency_ms: number | null; input_tokens: number | null; output_tokens: number | null; error: string | null;
}

const QUESTION = "news_category";
const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

export function parseDecision(body: unknown) {
  if (!isRecord(body) || !isRecord(body.answers) || !isRecord(body.answers[QUESTION])) return null;
  const choice = body.answers[QUESTION].choice;
  if (!isRecord(choice) || typeof choice.choice !== "string" || !CATEGORIES.includes(choice.choice as Category)) return null;
  const probs: Partial<Record<Category, number>> = {};
  const raw = choice.probabilities ?? choice.probability_by_option ?? choice.options;
  if (isRecord(raw)) for (const category of CATEGORIES) { const p = finite(raw[category]); if (p !== null) probs[category] = p; }
  return { category: choice.choice as Category, probabilities: Object.keys(probs).length ? probs : null, confidence: finite(choice.confidence) };
}

function average(xs: number[]) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null; }
function percentile(xs: number[], p: number) { const s=[...xs].sort((a,b)=>a-b); return s.length ? s[Math.max(0,Math.ceil(p*s.length)-1)] : null; }
function f1(p: number, r: number) { return p+r===0 ? 0 : 2*p*r/(p+r); }

export function evaluate(results: RunResult[], truth: GroundTruth[]) {
  const labels = new Map(truth.map(x=>[x.article_id,x.category]));
  const scored = results.filter(r=>labels.has(r.article_id));
  const matrix = Object.fromEntries(CATEGORIES.map(t=>[t,Object.fromEntries(CATEGORIES.map(p=>[p,0]))])) as Record<Category,Record<Category,number>>;
  for (const r of scored) if (r.category) matrix[labels.get(r.article_id)!][r.category]++;
  const perCategory = Object.fromEntries(CATEGORIES.map(c=>{
    const tp=matrix[c][c], fp=CATEGORIES.reduce((n,t)=>n+matrix[t][c],0)-tp, fn=CATEGORIES.reduce((n,p)=>n+matrix[c][p],0)-tp;
    const precision=tp+fp?tp/(tp+fp):0, recall=tp+fn?tp/(tp+fn):0;
    return [c,{precision,recall,f1:f1(precision,recall),support:tp+fn}];
  })) as Record<Category,{precision:number;recall:number;f1:number;support:number}>;
  const n=scored.length, ok=scored.filter(r=>r.category!==null).length;
  const tp=matrix["除外"]["除外"], fp=CATEGORIES.reduce((x,t)=>x+matrix[t]["除外"],0)-tp, fn=CATEGORIES.reduce((x,p)=>x+matrix["除外"][p],0)-tp;
  const p=tp+fp?tp/(tp+fp):0, r=tp+fn?tp/(tp+fn):0;
  const macroPrecision=average(CATEGORIES.map(c=>perCategory[c].precision))!, macroRecall=average(CATEGORIES.map(c=>perCategory[c].recall))!;
  const totalSupport=CATEGORIES.reduce((a,c)=>a+perCategory[c].support,0);
  const weightedF1=totalSupport?CATEGORIES.reduce((a,c)=>a+perCategory[c].f1*perCategory[c].support,0)/totalSupport:0;
  const byArticle = new Map<string,RunResult[]>(); for(const x of results){const xs=byArticle.get(x.article_id)??[];xs.push(x);byArticle.set(x.article_id,xs);}
  const variability=[...byArticle].filter(([,xs])=>xs.length>1 && new Set(xs.map(x=>x.category)).size>1).map(([article_id,xs])=>({article_id,predictions:xs.map(x=>x.category)}));
  const agreements=[...byArticle.values()].filter(xs=>xs.length>1 && xs.every(x=>x.category!==null)).map(xs=>new Set(xs.map(x=>x.category)).size===1?1:0);
  const stability=Object.fromEntries(CATEGORIES.map(c=>{const xs=[...byArticle.values()].filter(rs=>rs.some(x=>x.category===c));return[c,{articles_with_category_prediction:xs.length,stable:xs.filter(rs=>rs.every(x=>x.category===c)).length,rate:xs.length?xs.filter(rs=>rs.every(x=>x.category===c)).length/xs.length:null}]}));
  const latency=results.map(x=>x.latency_ms).filter((x):x is number=>x!==null);
  return {attempted:results.length,scored:n,successful:ok,failed:results.length-ok,successful_rate:n?ok/n:null,failure_rate:n?1-ok/n:null,
    accuracy:n?scored.filter(x=>x.category===labels.get(x.article_id)).length/n:null,macro_precision:macroPrecision,macro_recall:macroRecall,
    macro_f1:average(CATEGORIES.map(c=>perCategory[c].f1)),weighted_f1:weightedF1,per_category:perCategory,
    exclusion:{precision:p,recall:r,f1:f1(p,r),confusion_matrix:{true_positive:tp,false_positive:fp,true_negative:CATEGORIES.filter(c=>c!=="除外").reduce((a,c)=>a+CATEGORIES.filter(d=>d!=="除外").reduce((b,d)=>b+matrix[c][d],0),0),false_negative:fn}},
    confusion_matrix:matrix,repeat_agreement:average(agreements),repeat_articles:variability,repeat_stability:stability,
    latency_ms:{p50:percentile(latency,.5),p95:percentile(latency,.95),average:average(latency),min:latency.length?Math.min(...latency):null,max:latency.length?Math.max(...latency):null},
    input_tokens:results.every(x=>x.input_tokens!==null)?results.reduce((a,x)=>a+(x.input_tokens??0),0):null,
    output_tokens:results.every(x=>x.output_tokens!==null)?results.reduce((a,x)=>a+(x.output_tokens??0),0):null};
}

export async function callWorkersAI(args:{accountId:string;token:string;article:EvalArticle;repeat:number;fetcher?:typeof fetch}):Promise<RunResult>{
  const started=performance.now(); const base={article_id:args.article.article_id,repeat:args.repeat};
  try {
    const response=await (args.fetcher??fetch)(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(args.accountId)}/ai/run/@cf/cloudflare/clef-flash`,{
      method:"POST",headers:{Authorization:`Bearer ${args.token}`,"Content-Type":"application/json"},
      body:JSON.stringify({model:"clef-flash",state:{title:args.article.title,description:args.article.description},questions:{[QUESTION]:{
        type:"choice",instructions:"ニュース記事を以下の基準で最も適切なカテゴリに分類する。タイトルとdescriptionを評価し、記事の主題に基づいて選ぶ。",
        criteria:{"トレンド":"政治、社会、事件、事故、災害、国際、生活など一般ニュース","エンタメ":"芸能、映画、音楽、テレビ、スポーツ","サブカル":"漫画、アニメ、ゲーム、VTuber、ネット文化、オタク文化","マネー":"株式、市場、金融、投資、企業業績、企業経済、経済","IT・ガジェット":"IT技術、AI、ソフトウェア、Webサービス、スマートフォン、PC、家電、デジタル製品","除外":"広告、宣伝、販促、求人、イベント告知、本文なし、掲示板反応集・雑談などニュース価値が低いもの"}}}})});
    const latency_ms=Math.round(performance.now()-started);
    let body:unknown; try{body=await response.json();}catch{return {...base,category:null,probabilities:null,confidence:null,latency_ms,input_tokens:null,output_tokens:null,error:response.ok?"invalid_json":"invalid_error_json"};}
    if(!response.ok)return {...base,category:null,probabilities:null,confidence:null,latency_ms,input_tokens:null,output_tokens:null,error:`http_${response.status}`};
    if(isRecord(body)&&body.success===false)return {...base,category:null,probabilities:null,confidence:null,latency_ms,input_tokens:null,output_tokens:null,error:"api_error"};
    const parsed=parseDecision(body); const usage=isRecord(body)?body.usage:null;
    return {...base,...(parsed??{category:null,probabilities:null,confidence:null}),latency_ms,input_tokens:finite(usage?.input_tokens),output_tokens:finite(usage?.output_tokens),error:parsed?null:"invalid_response"};
  } catch {return {...base,category:null,probabilities:null,confidence:null,latency_ms:Math.round(performance.now()-started),input_tokens:null,output_tokens:null,error:"network_error"};}
}

async function loadArticles(dir:URL):Promise<EvalArticle[]>{
  const articles:EvalArticle[]=[];
  for await(const e of Deno.readDir(dir)){if(!e.isFile||!/^article-\d+\.json$/.test(e.name))continue;const d=JSON.parse(await Deno.readTextFile(new URL(e.name,dir)));
    if(typeof d.article_id!=="string"||typeof d.title!=="string")continue;const description=typeof d.description==="string"?d.description:"";
    const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`${d.title}\n${description}`));const input_sha256=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
    articles.push({article_id:d.article_id,title:d.title,description,input_sha256});}
  return articles.sort((a,b)=>a.article_id.localeCompare(b.article_id));
}
if(import.meta.main){
  const arg=(name:string,fallback?:string)=>{const i=Deno.args.indexOf(name);return i>=0?Deno.args[i+1]:fallback;};
  const dir=new URL("./dataset/articles/",import.meta.url), articles=await loadArticles(dir), live=Deno.args.includes("--live");
  const root=new URL("./",import.meta.url), gtUrl=new URL("./dataset/ground_truth/clef_news_categories.json",root),outUrl=new URL("./results/clef_flash/evaluation.json",root);
  const gtExists=await Deno.stat(gtUrl).then(()=>true).catch(()=>false); const gt=gtExists?JSON.parse(await Deno.readTextFile(gtUrl)) as GroundTruth[]:[];
  const repeat=Math.max(1,Math.min(3,Number(arg("--repeat","2"))||2));
  const report:any={dataset:"tools/model_benchmark/dataset/articles/*.json",article_count:articles.length,model:"@cf/cloudflare/clef-flash",repeat_requested:repeat,
    ground_truth_count:gt.length,legacy_app_categories_used:false,api_mode:live?"live":"dry_run",results:[]};
  if(!live){report.status="dry_run";report.selected_count=articles.length;report.selected_inputs=articles.map(({article_id,input_sha256})=>({article_id,input_sha256}));console.log(JSON.stringify(report,null,2));Deno.exit(0);}
  const accountId=Deno.env.get("CLOUDFLARE_ACCOUNT_ID"),token=Deno.env.get("CLOUDFLARE_API_TOKEN");
  if(!accountId||!token){report.status="BLOCKED_MISSING_CLOUDFLARE_CREDENTIALS";report.results=[];console.log(JSON.stringify(report,null,2));Deno.exit(0);}
  const results:RunResult[]=[];for(let r=1;r<=repeat;r++)for(const article of articles)results.push(await callWorkersAI({accountId,token,article,repeat:r}));
  report.status=gt.length===articles.length?"completed":"BLOCKED_MISSING_GROUND_TRUTH";report.results=results;report.summary=evaluate(results,gt);
  await Deno.mkdir(new URL("./results/clef_flash/",root),{recursive:true});await Deno.writeTextFile(outUrl,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:undefined},null,2));
}
