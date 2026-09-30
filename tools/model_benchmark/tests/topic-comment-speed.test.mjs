import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChatRequestBody, buildGoogleRequestBody, buildPrompt, errorClass, extractGooglePrimaryPartText, inspectOpenRouterFreeCapacity, loadCloudflareEnv, loadOpenRouterBenchmarkEnv, models, parseComments, runOne, runSequentialCampaign, selectCloudflareCredentials } from '../src/topic-comment-speed.mjs';
import { inspectAttemptBudget, listReservations, reserveAttempt } from '../src/send-ledger.mjs';

test('benchmark prompt contains only the saved title and facts as news input', () => {
  const prompt=buildPrompt({topic_id:'t1',thread_title:'Saved title',facts:['fact one']});
  assert.match(prompt,/THREAD_TITLE: Saved title/);
  assert.match(prompt,/- fact one/);
  assert.match(prompt,/RULE: 必ず10件生成。各レスはREPLY_TYPES/);
  assert.doesNotMatch(prompt,/NEWS_BODY|EXTRACTED_BODY|article body/i);
});

test('comment validation accepts exactly ten nonempty JSON strings', () => {
  assert.equal(parseComments(JSON.stringify(Array.from({length:10},(_,i)=>`comment ${i}`))).length,10);
  assert.throws(()=>parseComments(JSON.stringify(['only one'])),e=>e.type==='invalid_count');
  assert.throws(()=>parseComments('not json'),e=>e.type==='parse_error');
  assert.throws(()=>parseComments(JSON.stringify(Array.from({length:10},(_,i)=>i===4?'':`comment ${i}`))),e=>e.type==='invalid_schema');
});

test('provider errors classify rate and quota limits for fail-stop handling', () => {
  assert.equal(errorClass(429),'rate_limit');
  assert.equal(errorClass(403,'quota_exceeded'),'quota_exceeded');
  assert.equal(errorClass(401),'auth_error');
  assert.equal(errorClass(503),'server_error');
});

test('Google text extraction follows current sharedAi first-part behavior', () => {
  const out=extractGooglePrimaryPartText({candidates:[{content:{parts:[{thought:true,text:'first part'},{text:'["one"]'}]},finishReason:'STOP'}]});
  assert.equal(out.text,'first part');
  assert.equal(out.firstPartIsThought,true);
  assert.equal(out.finishReason,'STOP');
});

test('Google Gemma and Gemini Flash-Lite requests use their supported MINIMAL thinking setting', () => {
  const body=buildGoogleRequestBody(models.google_gemma,'prompt');
  assert.deepEqual(body.generationConfig.thinkingConfig,{thinkingLevel:'MINIMAL'});
  assert.equal(body.generationConfig.maxOutputTokens,1200);
  const gemini=buildGoogleRequestBody(models.gemini,'prompt');
  assert.deepEqual(gemini.generationConfig.thinkingConfig,{thinkingLevel:'MINIMAL'});
});

test('Groq and Cloudflare requests use the configured low/no-thinking settings and 1000-token cap', () => {
  const groq=buildChatRequestBody(models.groq,'prompt');
  assert.equal(groq.model,'openai/gpt-oss-120b');
  assert.equal(groq.max_tokens,1000);
  assert.equal(groq.reasoning_effort,'low');
  assert.equal(groq.stream,true);
  const cloudflare=buildChatRequestBody(models.cloudflare,'prompt');
  assert.equal(cloudflare.model,'@cf/google/gemma-4-26b-a4b-it');
  assert.equal(cloudflare.max_tokens,1000);
  assert.deepEqual(cloudflare.chat_template_kwargs,{enable_thinking:false});
});

test('OpenRouter request pins the free model, disables reasoning, and rejects paid routing', () => {
  const body=buildChatRequestBody(models.openrouter,'prompt');
  assert.equal(body.model,'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.deepEqual(body.reasoning,{enabled:false});
  assert.equal(body.provider.allow_fallbacks,false);
  assert.deepEqual(body.provider.max_price,{prompt:0,completion:0,request:0,image:0});
});

test('OpenRouter credentials are always read from benchmark .env without revealing them', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'.env'),'OPENROUTER_API_KEY="file-key"\n');
  const env={OPENROUTER_API_KEY:'stale-process-key'};
  await loadOpenRouterBenchmarkEnv(root,env);
  assert.equal(env.OPENROUTER_API_KEY,'file-key');
  await fs.writeFile(path.join(root,'.env'),'OTHER=value\n');
  await assert.rejects(loadOpenRouterBenchmarkEnv(root,env),/missing_openrouter_benchmark_config/);
});

test('OpenRouter free preflight requires a free tier, zero model price, and reports remaining free requests', async () => {
  const responses=[
    {ok:true,status:200,json:async()=>({data:[{id:models.openrouter.api_model,pricing:{prompt:'0',completion:'0'}}]})},
    {ok:true,status:200,json:async()=>({data:{is_free_tier:true,free_model_daily_requests:{used:33,limit:50,remaining:17}}})},
  ];
  const result=await inspectOpenRouterFreeCapacity({OPENROUTER_API_KEY:'secret'},async()=>responses.shift());
  assert.equal(result.ok,true);
  assert.equal(result.remaining,17);
  assert.equal(result.requestLimit,50);
});

test('Cloudflare CLI credentials are loaded from project .env.server over stale benchmark .env values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'benchmark-cloudflare-env-'));
  const env = { CLOUDFLARE_API_TOKEN: 'stale-token', CLOUDFLARE_ACCOUNT_ID: 'stale-account' };
  await fs.writeFile(path.join(root, '.env.server'), 'CLOUDFLARE_API_TOKEN="server-token"\nCLOUDFLARE_ACCOUNT_ID=server-account\n');
  await loadCloudflareEnv(root, env);
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'server-token');
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'server-account');
});

test('Cloudflare falls back only after auth denial and only when account IDs match', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'benchmark-cloudflare-fallback-'));
  await fs.mkdir(path.join(root,'tools','model_benchmark'),{recursive:true});
  await fs.writeFile(path.join(root,'.env.server'),'CLOUDFLARE_API_TOKEN=primary\nCLOUDFLARE_ACCOUNT_ID=account-a\n');
  await fs.writeFile(path.join(root,'tools','model_benchmark','.env'),'CLOUDFLARE_API_TOKEN=fallback\nCLOUDFLARE_ACCOUNT_ID=account-a\n');
  const env={}; const calls=[];
  const selected=await selectCloudflareCredentials(root,env,async(url,options)=>{
    calls.push({url,token:options.headers.authorization});
    const ok=options.headers.authorization==='Bearer fallback';
    return {status:ok?200:403,ok,json:async()=>({success:ok})};
  });
  assert.equal(selected.ok,true);
  assert.equal(selected.source,'benchmark_env');
  assert.equal(selected.accountMatched,true);
  assert.equal(env.CLOUDFLARE_API_TOKEN,'fallback');
  assert.deepEqual(calls.map(x=>x.token),['Bearer primary','Bearer fallback']);

  await fs.writeFile(path.join(root,'tools','model_benchmark','.env'),'CLOUDFLARE_API_TOKEN=fallback\nCLOUDFLARE_ACCOUNT_ID=account-b\n');
  let mismatchCalls=0;
  const mismatch=await selectCloudflareCredentials(root,{},async()=>{mismatchCalls++;return {status:403,ok:false,json:async()=>({success:false})};});
  assert.equal(mismatch.ok,false);
  assert.equal(mismatch.reason,'fallback_account_mismatch');
  assert.equal(mismatchCalls,1);
});

async function tempRoot() { return fs.mkdtemp(path.join(os.tmpdir(),'comment-speed-ledger-')); }

test('reservation survives a simulated restart and prevents resending the same trial', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const first=await reserveAttempt({root,campaignId:'campaign',modelId:'model',topicId:'topic-1'});
  const restarted=await reserveAttempt({root,campaignId:'campaign',modelId:'model',topicId:'topic-1'});
  assert.equal(first.reserved,true);
  assert.equal(restarted.reserved,false);
  assert.equal(restarted.reason,'trial_already_reserved');
  assert.equal((await listReservations({root,campaignId:'campaign',modelId:'model'})).length,1);
  const different=await reserveAttempt({root,campaignId:'campaign',modelId:'model',topicId:'topic-2'});
  assert.notEqual(first.attemptId,different.attemptId);
});

test('saved campaign history is included in the per-model cap', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const results=path.join(root,'results'); await fs.mkdir(results,{recursive:true});
  const header='run_id,article_id,model_id,model_display_name,provider,task,status,failure_type,latency_ms,http_status,finish_reason,input_tokens,output_tokens,reasoning_tokens,prompt_version,detail_file';
  const rows=Array.from({length:20},(_,i)=>`campaign-old,topic-${i},model,Model,test,comments,failed,timeout,,,,,,,p,d.json`);
  await fs.writeFile(path.join(results,'results.csv'),`${header}\n${rows.join('\n')}\n`);
  const result=await reserveAttempt({root,campaignId:'campaign',modelId:'model',topicId:'new-topic'});
  assert.equal(result.reserved,false);
  assert.equal(result.reason,'model_limit_reached');
  assert.equal(result.used,20);
});

test('corrupt ledger fails closed without reserving', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const results=path.join(root,'results'); await fs.mkdir(results,{recursive:true});
  await fs.writeFile(path.join(results,'topic-comment-speed-send-ledger.jsonl'),'not-json\n');
  await assert.rejects(reserveAttempt({root,campaignId:'campaign',modelId:'model',topicId:'topic-1'}),e=>e.code==='ledger_corrupt');
});

test('result-save failure leaves the attempt consumed and a rerun never calls sender again', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let sends=0;
  const sender=async()=>{ sends++; return {requestAt:new Date().toISOString(),firstTokenMs:10,apiResponseMs:20,parseValidationMs:1,httpStatus:200,usage:{prompt_tokens:10,completion_tokens:10},validatedComments:10,costUsd:0,success:true,generationMs:21}; };
  await assert.rejects(runOne({provider:'openrouter',topic:{topic_id:'topic-1',category:'test',thread_title:'title',facts:['fact']},runId:'campaign',root,freeConfirmed:true,sender,persist:async()=>{throw new Error('disk full');}}),/disk full/);
  const rerun=await runOne({provider:'openrouter',topic:{topic_id:'topic-1',category:'test',thread_title:'title',facts:['fact']},runId:'campaign',root,freeConfirmed:true,sender,persist:async()=>({file:'unused'})});
  assert.equal(rerun.sent,false);
  assert.equal(rerun.reason,'trial_already_reserved');
  assert.equal(sends,1);
  assert.equal((await listReservations({root,campaignId:'campaign',modelId:'nemotron-3-ultra-free'})).length,1);
});

test('budget inspection includes all historical calls and initializes a durable baseline', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const results=path.join(root,'results'); await fs.mkdir(results,{recursive:true});
  const header='run_id,article_id,model_id,model_display_name,provider,task,status,failure_type,latency_ms,http_status,finish_reason,input_tokens,output_tokens,reasoning_tokens,prompt_version,detail_file';
  await fs.writeFile(path.join(results,'results.csv'),`${header}\nold-run,topic-1,model,Model,test,comments,success,,100,200,stop,1,1,,,p,d.json\n`);
  const budget=await inspectAttemptBudget({root,campaignId:'campaign',modelId:'model'});
  assert.deepEqual({used:budget.used,remaining:budget.remaining,baseline:budget.baseline},{used:1,remaining:19,baseline:1});
});

test('limit reached prevents the runner from invoking its sender', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const results=path.join(root,'results'); await fs.mkdir(results,{recursive:true});
  const header='run_id,article_id,model_id,model_display_name,provider,task,status,failure_type,latency_ms,http_status,finish_reason,input_tokens,output_tokens,reasoning_tokens,prompt_version,detail_file';
  for(let i=0;i<20;i++) await reserveAttempt({root,campaignId:'campaign',modelId:'nemotron-3-ultra-free',topicId:`topic-${i}`,budgetScope:'campaign'});
  let sends=0;
  const result=await runOne({provider:'openrouter',topic:{topic_id:'new-topic',category:'test',thread_title:'title',facts:['fact']},runId:'campaign',root,freeConfirmed:true,sender:async()=>{sends++;throw new Error('must not send');}});
  assert.equal(result.reason,'model_limit_reached');
  assert.equal(sends,0);
});

test('new campaign has its own 20-send allowance without deleting historical results', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const results=path.join(root,'results'); await fs.mkdir(results,{recursive:true});
  const header='run_id,article_id,model_id,model_display_name,provider,task,status,failure_type,latency_ms,http_status,finish_reason,input_tokens,output_tokens,reasoning_tokens,prompt_version,detail_file';
  const rows=Array.from({length:20},(_,i)=>`old-run,topic-${i},gemini-3.1-flash-lite,Model,google_ai_studio,comments,failed,timeout,,,,,,,p,d.json`);
  await fs.writeFile(path.join(results,'results.csv'),`${header}\n${rows.join('\n')}\n`);
  let sends=0;
  const result=await runOne({provider:'gemini',topic:{topic_id:'new-topic',category:'test',thread_title:'title',facts:['fact']},runId:'new-experiment',root,freeConfirmed:true,preflight:async()=>({ok:true}),sender:async()=>{sends++;return {requestAt:new Date().toISOString(),firstTokenMs:10,apiResponseMs:20,parseValidationMs:0,httpStatus:200,usage:{},validatedComments:10,costUsd:0,success:true,generationMs:20};},persist:async(_root,detail)=>({file:`${detail.experiment_id}-${detail.article_id}`})});
  assert.equal(result.sent,true);
  assert.equal(sends,1);
  assert.equal(result.detail.experiment_id,'new-experiment');
  assert.equal(result.detail.experiment_api_send_number,1);
  assert.equal(result.detail.metrics.valid_comment_count,10);
  assert.deepEqual(result.detail.metrics.request_generation_config.thinkingConfig,{thinkingLevel:'MINIMAL'});
  assert.equal((await fs.readFile(path.join(results,'results.csv'),'utf8')).split(/\r?\n/).length,22);
});

test('OpenRouter saves its effective request config and stops immediately on 429', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const topics=Array.from({length:3},(_,i)=>({topic_id:`or-topic-${i}`,category:'test',thread_title:'title',facts:['fact']}));
  let sends=0,saved;
  const result=await runSequentialCampaign({provider:'openrouter',topics,experimentId:'or-429-stop',root,freeConfirmed:true,intervalMs:0,wait:async()=>{},sender:async()=>{sends++;return {requestAt:new Date().toISOString(),apiResponseMs:1,httpStatus:429,errorType:'rate_limit',retryAfter:'0',usage:{},success:false,generationMs:1};},persist:async(_root,detail)=>{saved=detail;return {file:`${detail.experiment_id}-${detail.article_id}`};}});
  assert.equal(result.sent,1);
  assert.equal(sends,1);
  assert.deepEqual(saved.metrics.request_generation_config.reasoning,{enabled:false});
  assert.equal(saved.metrics.request_generation_config.provider.allow_fallbacks,false);
  assert.deepEqual(saved.metrics.request_generation_config.provider.max_price,{prompt:0,completion:0,request:0,image:0});
});

test('verified OpenRouter campaign stops on its first unsuccessful sample', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const topics=Array.from({length:3},(_,i)=>({topic_id:`or-first-${i}`,category:'test',thread_title:'title',facts:['fact']}));
  let sends=0;
  const result=await runSequentialCampaign({provider:'openrouter',topics,experimentId:'or-first-fail',root,freeConfirmed:true,requireFirstSuccess:true,intervalMs:0,wait:async()=>{},sender:async()=>{sends++;return {requestAt:new Date().toISOString(),apiResponseMs:1,httpStatus:200,errorType:'parse_error',usage:{},success:false,generationMs:1};},persist:async()=>({file:'detail.json'})});
  assert.equal(result.sent,1);
  assert.equal(sends,1);
});

test('sequential experiment records an invalid response and continues with the next topic', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let sends=0;
  const topics=Array.from({length:20},(_,i)=>({topic_id:`topic-${i}`,category:'test',thread_title:'title',facts:['fact']}));
  let saved;
  const result=await runSequentialCampaign({provider:'gemini',topics,experimentId:'gemini-first-failure',root,freeConfirmed:true,intervalMs:0,wait:async()=>{},preflight:async()=>({ok:true}),sender:async()=>{sends++;return {requestAt:new Date().toISOString(),apiResponseMs:10,parseValidationMs:0,httpStatus:200,usage:{thoughtsTokenCount:3},validatedComments:null,costUsd:0,success:false,errorType:'parse_error',parserMessage:'Unexpected token',responseText:'bad-json',googleParts:[{index:0,thought:false,hasText:true,textLength:8}],generationMs:10};},persist:async(_root,detail)=>{saved=detail;return {file:`${detail.experiment_id}-${detail.article_id}`};}});
  assert.equal(result.sent,20);
  assert.equal(result.attempts,20);
  assert.equal(sends,20);
  assert.equal(saved.raw.output,'bad-json');
  assert.equal(saved.failure.parser_message,'Unexpected token');
});

test('a rate-limited topic is not retried and the next topic waits Retry-After', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const topics=Array.from({length:3},(_,i)=>({topic_id:`rate-topic-${i}`,category:'test',thread_title:'title',facts:['fact']}));
  const sentTopics=[],waits=[];
  const result=await runSequentialCampaign({provider:'groq',topics,experimentId:'groq-rate-limit-test',root,freeConfirmed:true,intervalMs:100,wait:async ms=>waits.push(ms),preflight:async()=>({ok:true}),sender:async(_model,_prompt)=>{sentTopics.push(sentTopics.length);if(sentTopics.length===1)return {requestAt:new Date().toISOString(),apiResponseMs:1,httpStatus:429,errorType:'rate_limit',retryAfter:'2',usage:{},success:false,generationMs:1};return {requestAt:new Date().toISOString(),apiResponseMs:1,parseValidationMs:0,httpStatus:200,usage:{},validatedComments:10,costUsd:null,success:true,generationMs:1};},persist:async(_root,detail)=>({file:`${detail.experiment_id}-${detail.article_id}`})});
  assert.equal(result.sent,3);
  assert.equal(result.attempts,3);
  assert.deepEqual(waits,[2000,100]);
  assert.deepEqual(sentTopics,[0,1,2]);
  assert.deepEqual(result.results.map(x=>x.topicId),topics.map(x=>x.topic_id));
});

test('authentication failure stops the campaign without sending another topic', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const topics=Array.from({length:3},(_,i)=>({topic_id:`auth-topic-${i}`,category:'test',thread_title:'title',facts:['fact']}));
  let sends=0;
  const result=await runSequentialCampaign({provider:'cloudflare',topics,experimentId:'cloudflare-auth-failure-test',root,freeConfirmed:true,intervalMs:0,wait:async()=>{},preflight:async()=>({ok:true}),sender:async()=>{sends++;return {requestAt:new Date().toISOString(),apiResponseMs:1,httpStatus:401,errorType:'auth_error',usage:{},success:false,generationMs:1};},persist:async(_root,detail)=>({file:`${detail.experiment_id}-${detail.article_id}`})});
  assert.equal(result.sent,1);
  assert.equal(result.attempts,1);
  assert.equal(sends,1);
  assert.equal(result.stoppedBecause,'auth_error');
});

test('unconfirmed free billing state prevents reservation and API sender invocation', async t => {
  const root=await tempRoot(); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let sends=0;
  const result=await runOne({provider:'gemini',topic:{topic_id:'topic-1',category:'test',thread_title:'title',facts:['fact']},runId:'campaign',root,freeConfirmed:false,sender:async()=>{sends++;throw new Error('must not send');}});
  assert.equal(result.sent,false);
  assert.equal(result.reason,'free_status_unconfirmed');
  assert.equal(sends,0);
  assert.equal((await listReservations({root,campaignId:'campaign',modelId:'gemini-3.1-flash-lite'})).length,0);
});
