import { CATEGORIES, callWorkersAI, evaluate, parseDecision, type GroundTruth, type RunResult } from "./clef_flash_eval.ts";

function normalize(v:any):any{if(Array.isArray(v))return v.map(normalize);if(v&&typeof v==="object")return Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])]));return v}
function assertEquals<T>(actual:T,expected:T){if(JSON.stringify(normalize(actual))!==JSON.stringify(normalize(expected)))throw new Error(`assertEquals failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)}

Deno.test("parses documented Clef choice answer, probabilities, and confidence",()=>{
  assertEquals(parseDecision({answers:{news_category:{choice:{choice:"除外",probabilities:{除外:.8,トレンド:.2},confidence:.8}}}}),
    {category:"除外",probabilities:{除外:.8,トレンド:.2},confidence:.8});
  assertEquals(parseDecision({result:{answers:{}}}),null);
  assertEquals(parseDecision({answers:{news_category:{choice:{choice:"unknown"}}}}),null);
});

Deno.test("calculates class metrics, exclusion confusion, repeat stability, and latency",()=>{
  const truth:GroundTruth[]=[
    {article_id:"a",category:"除外",rationale:"promo",labeling_method:"independent_rubric_review",reviewer:"reviewer",input_sha256:"x"},
    {article_id:"b",category:"マネー",rationale:"market",labeling_method:"independent_rubric_review",reviewer:"reviewer",input_sha256:"y"},
  ];
  const results:RunResult[]=[
    {article_id:"a",repeat:1,category:"除外",probabilities:null,confidence:null,latency_ms:20,input_tokens:null,output_tokens:null,error:null},
    {article_id:"a",repeat:2,category:"除外",probabilities:null,confidence:null,latency_ms:30,input_tokens:null,output_tokens:null,error:null},
    {article_id:"b",repeat:1,category:"トレンド",probabilities:null,confidence:null,latency_ms:50,input_tokens:null,output_tokens:null,error:null},
    {article_id:"b",repeat:2,category:null,probabilities:null,confidence:null,latency_ms:90,input_tokens:null,output_tokens:null,error:"http_500"},
  ];
  const s=evaluate(results,truth);
  assertEquals(s.attempted,4);assertEquals(s.successful,3);assertEquals(s.failed,1);
  assertEquals(s.accuracy,.5);assertEquals(s.exclusion.precision,1);assertEquals(s.exclusion.recall,1);
  assertEquals(s.repeat_agreement,1);assertEquals(s.latency_ms.p50,30);assertEquals(s.latency_ms.p95,90);
  assertEquals(s.repeat_articles,[{article_id:"b",predictions:["トレンド",null]}]);assertEquals(CATEGORIES.length,6);
});

Deno.test("sends the documented decision model request and reports API errors",async()=>{
  let sent:any;
  const fetcher=(async(_input:RequestInfo|URL,init?:RequestInit)=>{sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({success:true,answers:{news_category:{choice:{choice:"IT・ガジェット",probabilities:{}}}}}),{status:200});}) as typeof fetch;
  const result=await callWorkersAI({accountId:"account",token:"token",repeat:1,article:{article_id:"a",title:"title",description:"body",input_sha256:"hash"},fetcher});
  assertEquals(sent.model,"clef-flash");assertEquals(sent.state,{title:"title",description:"body"});assertEquals(sent.questions.news_category.type,"choice");
  assertEquals(result.category,"IT・ガジェット");
  const failing=(async()=>new Response(JSON.stringify({success:false,errors:[{code:1000}]}),{status:200})) as typeof fetch;
  assertEquals((await callWorkersAI({accountId:"a",token:"t",repeat:1,article:{article_id:"a",title:"",description:"",input_sha256:""},fetcher:failing})).error,"api_error");
});
