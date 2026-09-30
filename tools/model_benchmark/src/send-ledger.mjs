import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const csvRow = line => {
  const fields=[]; let value='', quoted=false;
  for(let i=0;i<line.length;i++) {
    const c=line[i];
    if(quoted) { if(c==='"'&&line[i+1]==='"'){value+='"';i++;} else if(c==='"') quoted=false; else value+=c; }
    else if(c===',' ){fields.push(value);value='';}
    else if(c==='"') quoted=true;
    else value+=c;
  }
  fields.push(value); return fields;
};

async function historyCount(root, modelId) {
  const results=path.join(root,'results');
  const csv=await fs.readFile(path.join(results,'results.csv'),'utf8').catch(()=>null);
  let csvCount=0;
  if(csv) for(const line of csv.split(/\r?\n/).slice(1)) {
    if(!line.trim()) continue;
    const row=csvRow(line);
    if(row[2]===modelId && row[5]==='comments') csvCount++;
  }
  let detailsCount=0;
  const details=path.join(results,'details');
  for(const name of await fs.readdir(details).catch(()=>[])) {
    if(!name.includes(`__${modelId}__`) || !name.endsWith('.json')) continue;
    try { const d=JSON.parse(await fs.readFile(path.join(details,name),'utf8')); if(d.model?.model_id===modelId && d.task==='comments') detailsCount++; } catch { detailsCount++; }
  }
  return Math.max(csvCount,detailsCount);
}

async function readLedger(file) {
  const text=await fs.readFile(file,'utf8').catch(()=> '');
  const events=[];
  for(const line of text.split(/\r?\n/).filter(Boolean)) {
    try { events.push(JSON.parse(line)); }
    catch { throw Object.assign(new Error('ledger_corrupt'),{code:'ledger_corrupt'}); }
  }
  return events;
}

async function appendDurably(file, event) {
  const handle=await fs.open(file,'a');
  try { await handle.writeFile(`${JSON.stringify(event)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

export async function reserveAttempt({root,campaignId,modelId,topicId,limit=20,budgetScope='history',now=new Date()}) {
  const results=path.join(root,'results'); await fs.mkdir(results,{recursive:true});
  const ledger=path.join(results,'topic-comment-speed-send-ledger.jsonl');
  const lock=ledger+'.lock';
  let lockHandle;
  for(let attempt=0;attempt<20;attempt++) {
    try { lockHandle=await fs.open(lock,'wx'); break; }
    catch(e) { if(e.code!=='EEXIST') throw e; await new Promise(r=>setTimeout(r,50)); }
  }
  if(!lockHandle) throw Object.assign(new Error('ledger_lock_uncertain'),{code:'ledger_lock_uncertain'});
  try {
    await lockHandle.writeFile(`${process.pid}:${now.toISOString()}`); await lockHandle.sync();
    const events=await readLedger(ledger);
    if(events.some(e=>e.event==='reserved'&&e.campaign_id===campaignId&&e.model_id===modelId&&e.topic_id===topicId)) return {reserved:false,reason:'trial_already_reserved',used:events.filter(e=>e.event==='reserved'&&e.campaign_id===campaignId&&e.model_id===modelId).length,limit,ledger};
    const meta=events.find(e=>e.event==='baseline'&&e.campaign_id===campaignId&&e.model_id===modelId);
    const baseline=budgetScope==='campaign'?0:(meta?.count??await historyCount(root,modelId));
    if(!meta) await appendDurably(ledger,{event:'baseline',campaign_id:campaignId,model_id:modelId,count:baseline,scope:budgetScope,at:now.toISOString()});
    const reservations=events.filter(e=>e.event==='reserved'&&e.campaign_id===campaignId&&e.model_id===modelId).length;
    const externalHistory=budgetScope==='campaign'?0:await historyCount(root,modelId);
    const used=Math.max(baseline+reservations,externalHistory);
    if(used>=limit) return {reserved:false,reason:'model_limit_reached',used,limit,ledger};
    const trialId=crypto.createHash('sha256').update(`${campaignId}\0${modelId}\0${topicId}`).digest('hex');
    const attemptId=`${campaignId}-${modelId}-${topicId}-${crypto.randomUUID()}`;
    await appendDurably(ledger,{event:'reserved',campaign_id:campaignId,model_id:modelId,topic_id:topicId,trial_id:trialId,attempt_id:attemptId,at:now.toISOString(),count_before:used,limit});
    return {reserved:true,reason:null,used:used+1,limit,ledger,trialId,attemptId};
  } finally { await lockHandle.close(); await fs.rm(lock,{force:true}).catch(()=>{}); }
}

export async function inspectAttemptBudget({root,campaignId,modelId,limit=20,budgetScope='history',now=new Date()}) {
  const results=path.join(root,'results'); await fs.mkdir(results,{recursive:true});
  const ledger=path.join(results,'topic-comment-speed-send-ledger.jsonl');
  const lock=ledger+'.lock'; let lockHandle;
  for(let attempt=0;attempt<20;attempt++) {
    try { lockHandle=await fs.open(lock,'wx'); break; }
    catch(e) { if(e.code!=='EEXIST') throw e; await new Promise(r=>setTimeout(r,50)); }
  }
  if(!lockHandle) throw Object.assign(new Error('ledger_lock_uncertain'),{code:'ledger_lock_uncertain'});
  try {
    await lockHandle.writeFile(`${process.pid}:${now.toISOString()}`); await lockHandle.sync();
    const events=await readLedger(ledger);
    const meta=events.find(e=>e.event==='baseline'&&e.campaign_id===campaignId&&e.model_id===modelId);
    const baseline=budgetScope==='campaign'?0:(meta?.count??await historyCount(root,modelId));
    if(!meta) await appendDurably(ledger,{event:'baseline',campaign_id:campaignId,model_id:modelId,count:baseline,scope:budgetScope,at:now.toISOString()});
    const reservations=events.filter(e=>e.event==='reserved'&&e.campaign_id===campaignId&&e.model_id===modelId).length;
    const used=budgetScope==='campaign'?baseline+reservations:Math.max(baseline+reservations,await historyCount(root,modelId));
    return {used,limit,remaining:Math.max(0,limit-used),eligible:used<limit,baseline,reservations,ledger};
  } finally { await lockHandle.close(); await fs.rm(lock,{force:true}).catch(()=>{}); }
}

export async function listReservations({root,campaignId,modelId}) {
  const ledger=path.join(root,'results','topic-comment-speed-send-ledger.jsonl');
  return (await readLedger(ledger)).filter(e=>e.event==='reserved'&&e.campaign_id===campaignId&&(!modelId||e.model_id===modelId));
}

export async function recordAttemptResult({root,attemptId,status,at=new Date()}) {
  const results=path.join(root,'results'); await fs.mkdir(results,{recursive:true});
  const ledger=path.join(results,'topic-comment-speed-send-ledger.jsonl');
  const lock=ledger+'.lock'; let lockHandle;
  for(let attempt=0;attempt<20;attempt++) {
    try { lockHandle=await fs.open(lock,'wx'); break; }
    catch(e) { if(e.code!=='EEXIST') throw e; await new Promise(r=>setTimeout(r,50)); }
  }
  if(!lockHandle) throw Object.assign(new Error('ledger_lock_uncertain'),{code:'ledger_lock_uncertain'});
  try {
    await lockHandle.writeFile(`${process.pid}:${at.toISOString()}`); await lockHandle.sync();
    const events=await readLedger(ledger);
    if(!events.some(e=>e.event==='reserved'&&e.attempt_id===attemptId)) throw Object.assign(new Error('attempt_not_reserved'),{code:'attempt_not_reserved'});
    await appendDurably(ledger,{event:'result',attempt_id:attemptId,status,at:at.toISOString()});
  } finally { await lockHandle.close(); await fs.rm(lock,{force:true}).catch(()=>{}); }
}
