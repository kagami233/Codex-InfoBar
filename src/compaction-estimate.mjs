import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const positive=n=>finite(n)&&n>0;
// Conservative forecast, never a promise of the next compaction checkpoint.
export function estimateCompaction(s,models,policy={}) {
 if(!positive(s.contextWindowTokens)||!finite(s.contextUsedTokens))return null;
 const model=models.find(m=>m.slug===s.model);
 const usable=s.contextWindowTokens;
 const matches=model&&positive(model.context_window)&&positive(model.effective_context_window_percent)&&Math.floor(model.context_window*model.effective_context_window_percent/100)===usable;
 const raw=matches?model.context_window:usable;
 const candidates=[{limit:raw*.9,source:matches?'model-default':'window-fallback'}];
 if(matches&&positive(model.auto_compact_token_limit))candidates.push({limit:model.auto_compact_token_limit,source:'model-limit'});
 if(positive(policy.limit)&&policy.scope!=='body_after_prefix')candidates.push({limit:policy.limit,source:'config-limit'});
 if(positive(policy.postTurnPercent)&&policy.postTurnPercent<=100)candidates.push({limit:usable*policy.postTurnPercent/100,source:'post-turn'});
 if(policy.asyncEnabled===true&&policy.tokenBudget!==true)candidates.push({limit:raw*(positive(policy.asyncPercent)?Math.min(100,policy.asyncPercent):65)/100,source:'async'});
 // When feature resolution fails, use an explicitly conservative prior rather
 // than silently assuming that early background compaction is disabled.
 if(policy.asyncEnabled==null)candidates.push({limit:raw*.65,source:'unresolved-feature-prior'});
 const samples=(s.compactionSamples??[]).filter(x=>x.model===s.model&&x.contextWindow===usable&&positive(x.tokens)&&(x.trigger==='auto'||x.tokens>=usable*.4)&&x.tokens<=usable*1.2&&x.trigger!=='manual').slice(-8);
 if(samples.length){
  const sorted=samples.map(x=>x.tokens).sort((a,b)=>a-b);
  // A lower quartile avoids optimistic forecasts. Unclassified events may
  // include manual compactions, so retain that distinction in diagnostics.
  candidates.push({limit:sorted[Math.floor((sorted.length-1)*.25)]*.97,source:samples.some(x=>x.trigger==='auto')?'observed-auto':'observed-unclassified'});
 }
 const chosen=candidates.reduce((a,b)=>a.limit<=b.limit?a:b);
 const limit=Math.max(1,Math.floor(Math.min(usable,chosen.limit)));
 const growth=(s.recentContextGrowth??[]).filter(x=>positive(x)&&x<usable*.25).slice(-12).sort((a,b)=>a-b);
 const reserve=Math.min(limit*.1,Math.max(2048,growth.length?growth[Math.floor((growth.length-1)*.8)]:usable*.02));
 const remaining=Math.max(0,Math.floor(limit-s.contextUsedTokens-reserve));
 return {kind:'calibrated-compaction-estimate',limit,remaining,remainingPercent:Math.min(100,remaining/limit*100),reserve:Math.round(reserve),source:chosen.source,sampleCount:samples.length};
}

const policies=new Map();let models=[],checkedAt=0;
export async function readCompactionPolicy(client,cwd){
 if(!client)return {};
 const key=cwd??'';const hit=policies.get(key);
 if(hit&&Date.now()-hit.at<60000)return hit.value;
 const value=await client.evaluate(`(async()=>{
  const rpc=(method,params)=>new Promise(resolve=>{
   const id='codex-infobar-compaction:'+crypto.randomUUID();
   const done=value=>{clearTimeout(timer);window.removeEventListener('message',onMessage);resolve(value);};
   const onMessage=event=>{const d=event.data;if(d?.hostId==='local'&&d.type==='mcp-response'&&d.message?.id===id)done(d.message.error?null:d.message.result);};
   const timer=setTimeout(()=>done(null),1800);window.addEventListener('message',onMessage);
   try{Promise.resolve(window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',request:{id,method,params},timeoutMs:1800})).catch(()=>done(null));}catch{done(null);}
  });
  const [result,features]=await Promise.all([rpc('config/read',{includeLayers:false,...${JSON.stringify(typeof cwd==='string'?{cwd}:{})}}),rpc('experimentalFeature/list',{limit:1000})]);
  const c=result?.config??{},list=features?.data??[];
  const flag=(name)=>{const v=c.features?.[name];return typeof v==='boolean'?v:typeof v?.enabled==='boolean'?v.enabled:list.find(f=>f.name===name)?.enabled??null;};
  return {limit:c.model_auto_compact_token_limit??null,scope:c.model_auto_compact_token_limit_scope??'total',postTurnPercent:c.model_post_turn_compact_threshold_percent??0,asyncEnabled:flag('async_compaction'),tokenBudget:flag('token_budget'),asyncPercent:c.features?.async_compaction?.model_async_compact_threshold_percent??65};
 })()`);
 const clean={limit:positive(value?.limit)?value.limit:null,scope:value?.scope==='body_after_prefix'?'body_after_prefix':'total',postTurnPercent:finite(value?.postTurnPercent)&&value.postTurnPercent<=100?value.postTurnPercent:0,asyncEnabled:typeof value?.asyncEnabled==='boolean'?value.asyncEnabled:null,tokenBudget:typeof value?.tokenBudget==='boolean'?value.tokenBudget:null,asyncPercent:positive(value?.asyncPercent)&&value.asyncPercent<=100?value.asyncPercent:65};
 policies.delete(key);policies.set(key,{at:Date.now(),value:clean});if(policies.size>64)policies.delete(policies.keys().next().value);
 return clean;
}
export async function addCompactionEstimate(snapshot,client,previous){
 if(previous?.threadId===snapshot.threadId){
  const records=[...(previous.compactionSamples??[]),...(snapshot.compactionSamples??[])];
  snapshot={...snapshot,compactionSamples:[...new Map(records.map(x=>[JSON.stringify(x),x])).values()].slice(-8)};
 }
 if(Date.now()-checkedAt>60000){checkedAt=Date.now();try{const file=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'models_cache.json');if((await fs.stat(file)).size>16*1024*1024)throw new Error('model cache too large');const data=JSON.parse(await fs.readFile(file,'utf8'));models=Array.isArray(data.models)?data.models:[];}catch{models=[];}}
 let policy={};try{policy=await readCompactionPolicy(client,snapshot.compactionCwd);}catch{}
 return {...snapshot,compactReference:estimateCompaction(snapshot,models,policy)};
}
