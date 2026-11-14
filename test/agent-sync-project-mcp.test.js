import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {managed,execution} from './helpers/agent-sync-fixture.js';
import {fixture} from './helpers/pi-fixture.js';
import {repository,git} from './helpers/git-fixture.js';
import {invoke} from './helpers/cli-fixture.js';
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('..',import.meta.url)));
const load=path=>import(pathToFileURL(join(productRoot,path)));
const {createProjectPolicy,projectUsage}=await load('src/project-policy.js');
const {createPluginWork}=await load('src/plugin-work.js');
const {saveConfig}=await load('src/config.js');
const {listTasks}=await load('src/task.js');
const tool=(name,args={})=>({toolCalls:[{name,args}]});
const recovery={originalTool:'start',jobArgument:'id',sourceArgument:'id',jobField:'jobId',statusField:'status',terminalValues:['completed']};
function selection(server='local') {return {server,trust:'explicit-service-contract',tools:{
  read:{kind:'read',target:'remote counter',allowedArguments:[{}]},
  write:{kind:'write',target:'counter',action:'write',round:1,allowedArguments:[{value:7}]},
  start:{kind:'start',target:'job',action:'start',round:1,allowedArguments:[{id:'original',lose:true},{id:'independent'}]},
  status:{kind:'query',target:'original job status',recovery},cancel:{kind:'cancel',target:'original job cancellation',recovery:{originalTool:'start',jobArgument:'id',sourceArgument:'id'}}}};}
async function server(t) {
  const state={starts:0,value:0,cancels:0,requests:[],jobs:new Map()};
  const http=createServer(async(req,res)=>{
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    const chunks=[];for await(const b of req)chunks.push(b);let m;
    try{m=JSON.parse(Buffer.concat(chunks));}catch{res.writeHead(400);res.end();return;}
    state.requests.push({m,authorization:req.headers.authorization});let result;
    if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'controlled',version:'1'}};
    else if(m.method==='tools/list')result={tools:['read','write','start','start_second','status','status_second','cancel'].map(name=>({name,inputSchema:state.schemaChanged?{type:'object',properties:{changed:{type:'boolean'}}}:{type:'object'},annotations:{readOnlyHint:true}}))};
    else if(m.method==='tools/call'){
      const {name,arguments:a}=m.params;
      if(['start','write','cancel'].includes(name)&&req.headers.authorization==='Bearer readonly'){result={isError:true,content:[{type:'text',text:'ACCOUNT_READ_ONLY'}]};}
      else {
        if(name==='write')state.value=a.value;
        if(name==='start'||name==='start_second'){state.starts++;state.jobs.set(a.id,'running');state.onStart?.();if(a.lose){req.socket.destroy();return;}if(state.holdStarts)return;}
        if(name==='cancel')state.cancels++; // ACK deliberately leaves the job running.
        result={content:[{type:'text',text:String(state.value)}],structuredContent:{value:state.value,jobId:state.reportedJob??a.id,status:state.jobs.get(a.id),ack:name==='cancel'}};
      }
    }
    if(m.id===undefined){res.writeHead(202);res.end();return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,...(state.rpcErrorFor&&(state.rpcErrorFor===m.method||state.rpcErrorFor===m.params?.name)?{error:{code:-32603,message:'Service failed with '+req.headers.authorization}}:{result})}));
  });await new Promise(r=>http.listen(0,'127.0.0.1',r));t.after(()=>{http.closeAllConnections();return new Promise(r=>http.close(r));});
  return {...state,state,url:`http://127.0.0.1:${http.address().port}/mcp`};
}
function configMcp(home,config){mkdirSync(join(home,'pi'),{recursive:true});writeFileSync(join(home,'pi','mcp.json'),JSON.stringify({mcpServers:{local:config}}));}
async function controlled(t,config,selected=selection(),budget={maxCalls:1,maxCost:null}) {
  const m=await managed(t,{execution,scope:['a.txt','new.txt']});configMcp(m.home,config);
  m.task.record.project={projectId:'p',stepId:'s',revision:1,taskId:m.task.record.id,scope:['a.txt','new.txt'],mcp:[selected]};
  const works=[{id:'read-work',scope:['a.txt']},{id:'write-work',scope:['a.txt'],effect:{target:'counter',action:'write',round:1}},{id:'job-work',scope:['a.txt'],effect:{target:'job',action:'start',round:1}},{id:'duplicate-work',scope:['a.txt'],effect:{target:'job',action:'start',round:1}},{id:'independent-work',scope:['new.txt'],effect:{target:'job',action:'start',round:2}}];
  const state={id:'p',status:'active',budget,steps:[{id:'s',revision:1,status:'running',scope:['a.txt','new.txt'],works,attempts:[{taskId:m.task.record.id}]}],rootWorkClaims:works.map(w=>({taskId:m.task.record.id,workId:w.id,changeId:m.binding.current.changeId}))};
  const host={assertOwned(){},read:()=>structuredClone(state),update:fn=>fn(state)};
  m.task.projectPolicy=createProjectPolicy({host,binding:m.task.record.project,home:m.home});
  const work=await createPluginWork({task:m.task,versioning:m.v,execution});t.after(()=>work.close());
  const context=await work.context({actor:'main',binding:m.binding,assertAllowed(){}});await context.bindSession('session');const definitions=await context.projectTools();await context.beforePrompt({phase:'work'});
  const call=async(name,id,args)=>JSON.parse((await definitions.find(t=>t.name===name).execute(id,args,m.task.signal)).content[0].text);
  return {...m,state,work,context,call};
}

test('PROJECT actual URL MCP uses confirmed credentials and exact args without counting tools as model calls',async t=>{
  const remote=await server(t),m=await controlled(t,{url:remote.url,headers:{authorization:'Bearer scoped'} });
  const read=await m.call('project_mcp_0_read','read',{workId:'read-work',arguments:{}});assert.equal(read.status,'completed');
  await assert.rejects(m.call('project_mcp_0_write','bad',{workId:'write-work',arguments:{value:8}}),{code:'PROJECT_MCP_ARGUMENTS'});
  const write=await m.call('project_mcp_0_write','write',{workId:'write-work',arguments:{value:7}});assert.equal(write.status,'completed');assert.equal(remote.state.value,7);
  assert.equal(projectUsage(m.state,m.home).calls,0);assert.equal(projectUsage(m.state,m.home).externalOperations,2);
  assert.ok(remote.state.requests.every(r=>r.authorization==='Bearer scoped'));
  assert.doesNotMatch(JSON.stringify(m.task.record),/Bearer scoped/);
  const r=await controlled(t,{url:remote.url,headers:{authorization:'Bearer readonly'}});
  const refused=await r.call('project_mcp_0_write','actual-readonly',{workId:'write-work',arguments:{value:7}});assert.equal(refused.value.isError,true);assert.match(JSON.stringify(refused),/ACCOUNT_READ_ONLY/);
});

test('PROJECT URL lost response, duplicate work, cancel ACK and pause use the original effect and job',async t=>{
  const remote=await server(t),selected=selection();selected.tools.start_second={kind:'start',target:'job',action:'start',round:2,allowedArguments:[{id:'independent'}]};selected.tools.status_second={kind:'query',target:'second original job status',recovery:{...recovery,originalTool:'start_second'}};const m=await controlled(t,{url:remote.url},selected);
  const first=await m.call('project_mcp_0_start','first',{workId:'job-work',arguments:{id:'original',lose:true}});assert.equal(first.status,'outcome_unknown');assert.equal(remote.state.starts,1);
  const duplicate=await m.call('project_mcp_0_start','renamed',{workId:'duplicate-work',arguments:{id:'original',lose:true}});assert.equal(duplicate.originalRequestId,'mcp:first');assert.equal(remote.state.starts,1);
  await assert.rejects(m.call('project_mcp_0_start','changed',{workId:'duplicate-work',arguments:{id:'independent'}}),{code:'PROJECT_EFFECT_HELD'});
  const independent=await m.call('project_mcp_0_start_second','independent',{workId:'independent-work',arguments:{id:'independent'}});assert.equal(independent.status,'outcome_unknown');assert.equal(remote.state.starts,2);
  m.state.status='paused';
  const cancel=await m.call('project_mcp_recover','cancel',{originalRequestId:'mcp:first',action:'cancel'});assert.equal(cancel.status,'outcome_unknown');assert.equal(remote.state.cancels,1);
  const status=await m.call('project_mcp_recover','status',{originalRequestId:'mcp:first',action:'query'});assert.equal(status.status,'outcome_unknown');
  await assert.rejects(m.call('project_mcp_0_read','after-pause',{workId:'read-work',arguments:{}}),{code:'PROJECT_PAUSED'});
  remote.state.jobs.set('original','completed');remote.state.reportedJob='different-job';const mismatch=await m.call('project_mcp_recover','mismatched-job',{originalRequestId:'mcp:first',action:'query'});assert.equal(mismatch.status,'outcome_unknown');delete remote.state.reportedJob;const completed=await m.call('project_mcp_recover','completed',{originalRequestId:'mcp:first',action:'query'});assert.equal(completed.status,'completed');assert.equal(remote.state.starts,2);
  await assert.rejects(m.call('project_mcp_recover','forged',{originalRequestId:'another-task',action:'query'}),{code:'PROJECT_MCP_RECOVERY'});
});

test('PROJECT MCP hard cap rejects asserted zero fees on URL before any operation send',async t=>{
  const remote=await server(t),selected=selection();selected.tools.read.feeBoundary={maxCost:0,authority:'claimed free'};
  const m=await controlled(t,{url:remote.url},selected,{maxCalls:null,maxCost:0});
  await assert.rejects(m.call('project_mcp_0_read','limited',{workId:'read-work',arguments:{}}),{code:'PROJECT_BUDGET'});
  assert.equal(remote.state.requests.filter(r=>r.m.method==='tools/call').length,0);
});

const commandServer=`import {createInterface} from 'node:readline';import fs from 'node:fs';let starts=0;const jobs=new Map();createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'node-controlled',version:'1'}};if(m.method==='tools/list')result={tools:['read','write','start','status'].map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}))};if(m.method==='tools/call'){try{const a=m.params.arguments;if(m.params.name==='start'){starts++;jobs.set(a.id,'completed');result={content:[],structuredContent:{jobId:a.id,status:'ack',starts}};}else if(m.params.name==='status')result={content:[],structuredContent:{jobId:a.id,status:jobs.get(a.id),starts}};else{if(m.params.name==='write')fs.writeFileSync('a.txt','MCP_CHECKED\\n');result={content:[{type:'text',text:fs.readFileSync('a.txt','utf8')}]};}}catch(e){result={isError:true,content:[{type:'text',text:e.code}]};}}if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
test('normal PROJECT CLI executes command MCP in an independent copy, creator imports and root accepts actual files',{timeout:90000},async t=>{
  const repo=repository(t);let resultId,error,jobReceipt;
  const f=await fixture(t,({body},n)=>{try{
    const last=body.messages.findLast(m=>m.role==='tool')?.content??'';
    if(n===1)return tool('next_change',{reason:'Use confirmed command MCP for a.txt',scope:['a.txt'],readScope:['a.txt']});
    if(n===2){assert.doesNotMatch(last,/error|cannot|needs|requires|pending|closed|unknown/i,last);return tool('project_mcp_0_read',{workId:'file',arguments:{}});}
    if(n===3){assert.match(last,/base A/);return tool('project_mcp_0_start',{workId:'job',arguments:{id:'original',lose:true}});}
    if(n===4){const started=JSON.parse(last);jobReceipt=started.originalRequestId;assert.equal(started.status,'outcome_unknown');assert.equal(started.value.structuredContent.starts,1);return tool('project_mcp_recover',{originalRequestId:jobReceipt,action:'query'});}
    if(n===5){const queried=JSON.parse(last);assert.equal(queried.status,'completed');assert.equal(queried.value.structuredContent.starts,1);return tool('project_mcp_0_write',{workId:'file',arguments:{value:7}});}
    if(n===6){resultId=JSON.parse(last).projectMcpResultId;assert.ok(resultId,last);return tool('project_mcp_result',{resultId,decision:'inspect'});}
    if(n===7)return tool('project_mcp_result',{resultId,decision:'adopt',reason:'Inspected complete MCP delta'});
    if(n===8){assert.equal(JSON.parse(last).status,'applied',last);return tool('prepare_change');}
    if(n===9)return tool('accept_change');if(n===10)return tool('accept_change');assert.equal(JSON.parse(last).status,'accepted',last);return {text:'Delivered actual command MCP file.'};
  }catch(e){error=e;return {text:'Unexpected MCP fixture output'};}});
  const code=join(f.home,'mcp-code');mkdirSync(code);writeFileSync(join(code,'server.mjs'),commandServer);configMcp(f.home,{command:'node',args:['server.mjs'],cwd:code});
  const selected=selection();delete selected.tools.cancel;
  saveConfig(f.home,{formatVersion:2,...f.models,work:{execution}});
  const plan=join(f.home,'plan.json');writeFileSync(plan,JSON.stringify({goal:'Use selected command MCP to update a.txt',mcp:[selected],scope:['a.txt'],works:[{id:'file',scope:['a.txt'],effect:{target:'counter',action:'write',round:1}},{id:'job',scope:['a.txt'],effect:{target:'job',action:'start',round:1}}],budget:{maxCalls:12},deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='MCP_CHECKED\\n')process.exit(1)"]}]}));
  const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);if(error)throw error;assert.equal(run.code,0,run.stdout+run.stderr);
  const state=JSON.parse(run.stdout);assert.equal(state.status,'completed',run.stdout);assert.equal(git(repo.project,'show',state.version+':a.txt'),'MCP_CHECKED');assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
  assert.equal(state.usage.calls,f.calls.length);assert.equal(state.usage.externalOperations,3);assert.equal(f.calls.length,11);
  const task=listTasks(f.home)[0];assert.ok(task.tools.filter(t=>t.kind==='project_mcp_runtime').every(r=>r.stoppedAt));assert.equal(task.tools.find(r=>r.resultId===resultId).treatment.decision,'adopted');
});

test('normal URL PROJECT runs real read/write/start, deduplicates across work, continues independent effect and reconnects original paused receipts',{timeout:60000},async t=>{
  const remote=await server(t),repo=repository(t);let error,originalId,independentId;
  const f=await fixture(t,({body},n)=>{try{
    const last=body.messages.findLast(m=>m.role==='tool')?.content??'';
    if(n===1)return tool('next_change',{reason:'Perform confirmed server operations within two independent works',scope:['a.txt','new.txt'],readScope:['a.txt']});
    if(n===2){assert.doesNotMatch(last,/error/i,last);return tool('project_mcp_0_read',{workId:'counter',arguments:{}});}
    if(n===3){assert.equal(JSON.parse(last).value.structuredContent.value,0);return tool('project_mcp_0_write',{workId:'counter',arguments:{value:7}});}
    if(n===4){assert.equal(JSON.parse(last).value.structuredContent.value,7);return tool('project_mcp_0_start',{workId:'job',arguments:{id:'original',lose:true}});}
    if(n===5){originalId=JSON.parse(last).originalRequestId;assert.equal(JSON.parse(last).status,'outcome_unknown');return tool('project_mcp_0_start',{workId:'duplicate',arguments:{id:'original',lose:true}});}
    if(n===6){assert.equal(JSON.parse(last).originalRequestId,originalId);return tool('project_mcp_0_start_second',{workId:'independent',arguments:{id:'independent'}});}
    independentId=JSON.parse(last).originalRequestId;assert.ok(independentId);return {text:'The remote effects remain unknown; inspect original receipts before delivery.'};
  }catch(e){error=e;return {text:'Unexpected URL MCP material'};}});
  configMcp(f.home,{url:remote.url,headers:{authorization:'Bearer scoped'}});saveConfig(f.home,{formatVersion:2,...f.models,work:{execution}});
  const selected=selection();selected.tools.start_second={kind:'start',target:'job',action:'start',round:2,allowedArguments:[{id:'independent'}]};selected.tools.status_second={kind:'query',target:'second original job status',recovery:{...recovery,originalTool:'start_second'}};
  const plan=join(f.home,'url-plan.json');writeFileSync(plan,JSON.stringify({goal:'Read and modify controlled service then start two independent confirmed jobs',mcp:[selected],scope:['a.txt','new.txt'],works:[
    {id:'counter',scope:['a.txt'],effect:{target:'counter',action:'write',round:1}},
    {id:'job',scope:['a.txt'],effect:{target:'job',action:'start',round:1}},
    {id:'duplicate',scope:['a.txt'],effect:{target:'job',action:'start',round:1}},
    {id:'independent',scope:['new.txt'],effect:{target:'job',action:'start',round:2}}],budget:{maxCalls:8},deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='base A\\n')process.exit(1)"]}]}));
  const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);if(error)throw error;assert.notEqual(JSON.parse(run.stdout).status,'completed');assert.equal(remote.state.starts,2);assert.equal(f.calls.length,7);
  let state=JSON.parse(run.stdout);assert.equal(state.usage.calls,7);assert.equal(state.usage.externalOperations,4);assert.equal(state.usage.actualCost,null);assert.equal(state.usage.unresolvedExternal.length,2);
  const pause=await invoke(f,['project','pause','--json'],'',repo.project);assert.equal(pause.code,0,pause.stdout+pause.stderr);
  for(const action of ['cancel','query']){
    const result=await invoke(f,['project','mcp',action,JSON.stringify({originalRequestId:originalId}),'--json'],'',repo.project);assert.equal(result.code,0,result.stdout+result.stderr);state=JSON.parse(result.stdout);assert.equal(state.status,'paused');assert.equal(state.mcpRecovery.status,'outcome_unknown');
  }
  assert.equal(remote.state.cancels,1);assert.equal(remote.state.starts,2);
  remote.state.jobs.set('original','completed');remote.state.jobs.set('independent','completed');
  for(const id of [originalId,independentId]){
    const result=await invoke(f,['project','mcp','query',JSON.stringify({originalRequestId:id}),'--json'],'',repo.project);assert.equal(result.code,0,result.stdout+result.stderr);state=JSON.parse(result.stdout);assert.equal(state.mcpRecovery.status,'completed');
  }
  assert.equal(remote.state.starts,2);assert.equal(state.usage.calls,7);assert.equal(state.usage.unresolvedExternal.length,0);assert.equal(f.calls.length,7);
  const task=listTasks(f.home)[0];assert.doesNotMatch(JSON.stringify(task),/Bearer scoped/);assert.equal(task.tools.flatMap(r=>r.kind==='project_mcp_runtime'?r.requests:[]).filter(r=>r.tool==='start'||r.tool==='start_second').length,2);
});

test('PROJECT chat freezes and displays the same explicit MCP contract before starting, and cancel has no MCP traffic',async t=>{
  const {projectChat}=await load('src/project-chat.js');const remote=await server(t),repo=repository(t),selected=selection();
  const plan={mcp:[selected],scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e','process.exit(0)']}],budget:{maxCalls:0}};
  const f=await fixture(t,()=>({text:JSON.stringify(plan)}));configMcp(f.home,{url:remote.url,headers:{authorization:'Bearer scoped'}});
  const config={formatVersion:2,...f.models,work:{execution}};saveConfig(f.home,config);let draft=null;
  const send=text=>projectChat({home:f.home,cwd:repo.project,config,text,draft,signal:new AbortController().signal,saveDraft:value=>{draft=value;},report(){},onTask(){},chooseStep(){throw Error('Unexpected choice');}});
  const preview=await send('Use configured local MCP with the explicitly confirmed service contract to read a.txt');
  assert.match(preview,/待确认/);assert.match(preview,/explicit-service-contract/);assert.deepEqual(draft.plan.mcp,[selected]);assert.doesNotMatch(preview,/Bearer scoped/);assert.equal(remote.state.requests.length,0);assert.equal(f.calls.length,1);
  await send('取消计划');assert.equal(draft,null);assert.equal(remote.state.requests.length,0);
});

test('PROJECT command MCP async start counts once, queries the original job, and narrowing destroys the original writable process',{timeout:45000},async t=>{
  const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');
  const directory=mkdtempSync(join(tmpdir(),'cothink-project-mcp-node-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  writeFileSync(join(directory,'server.mjs'),`import fs from 'node:fs';import {createInterface} from 'node:readline';let count=0;const jobs=new Map();createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local-async',version:'1'}};if(m.method==='tools/list')result={tools:['probe','start','status'].map(name=>({name,inputSchema:{type:'object'}}))};if(m.method==='tools/call'){const a=m.params.arguments;if(m.params.name==='start'){count++;jobs.set(a.id,'completed');result={content:[],structuredContent:{jobId:a.id,status:'ack',count}};}else if(m.params.name==='status')result={content:[],structuredContent:{jobId:a.id,status:jobs.get(a.id),count}};else{let writable=false;try{const fd=fs.openSync('a.txt','r+');fs.closeSync(fd);writable=true}catch{}result={content:[],structuredContent:{writable}};}}if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const selected=selection();selected.tools={probe:{kind:'read',target:'a.txt',allowedArguments:[{}]},start:selected.tools.start,status:selected.tools.status};
  const m=await controlled(t,{command:'node',args:['server.mjs'],cwd:directory},selected);
  const first=await m.call('project_mcp_0_probe','probe',{workId:'read-work',arguments:{}});assert.equal(first.value.structuredContent.writable,true);
  const runtime=m.task.record.tools.find(r=>r.kind==='project_mcp_runtime');
  const start=await m.call('project_mcp_0_start','start',{workId:'job-work',arguments:{id:'original',lose:true}});assert.equal(start.status,'outcome_unknown');assert.equal(start.value.structuredContent.count,1);
  const dup=await m.call('project_mcp_0_start','dup',{workId:'duplicate-work',arguments:{id:'original',lose:true}});assert.equal(dup.originalRequestId,'mcp:start');
  const done=await m.call('project_mcp_recover','status',{originalRequestId:'mcp:start',action:'query'});assert.equal(done.status,'completed');assert.equal(done.value.structuredContent.count,1);
  assert.equal(m.task.record.tools.filter(r=>r.kind==='project_mcp_runtime').length,1);
  m.binding.current=await m.v.beginChange({requestId:'narrow-mcp',actor:'main',intent:'Revoke the actual writable MCP mount',scope:[],readScope:['a.txt'],readOnly:true});
  const narrowed=await m.call('project_mcp_0_probe','narrowed',{workId:'read-work',arguments:{}});assert.equal(narrowed.value.structuredContent.writable,false);assert.ok(runtime.stoppedAt);
  assert.equal(m.task.record.tools.filter(r=>r.kind==='project_mcp_runtime').length,2);
  await assert.rejects(m.call('project_mcp_0_start','readonly-start',{workId:'job-work',arguments:{id:'independent'}}),{code:'PROJECT_MCP_READONLY'});
});


test('a persisted unsent-or-unknown MCP intent cannot replay after its runtime has been rebuilt',async t=>{
  const remote=await server(t),m=await controlled(t,{url:remote.url});
  await assert.rejects(m.call('project_mcp_0_read','unowned',{workId:'unowned',arguments:{}}));
  const runtime=m.task.record.tools.find(r=>r.kind==='project_mcp_runtime');
  const spec={server:'local',actor:'main',sessionId:runtime.sessionId,sourceDigest:runtime.sourceDigest,changeId:runtime.changeId,inputVersion:runtime.inputVersion,registrationVersion:runtime.registrationVersion,readOnly:runtime.readOnly,scope:runtime.scope,readScope:runtime.readScope,localNoNetwork:false};
  const capability=m.task.projectPolicy.issueMcpCapability(spec),args={value:7},payloadDigest=createHash('sha256').update(JSON.stringify({tool:'write',args})).digest('hex');
  m.task.projectPolicy.claimMcpEffect({...spec,capability,kind:'write',tool:'write',workId:'write-work',requestId:'mcp:ambiguous',args,payloadDigest});
  assert.throws(()=>m.context.assertHandled(),{code:'PROJECT_MCP_UNKNOWN'});
  await m.context.seal(); // The saved intent deliberately has no decisive transport receipt.
  const result=await m.call('project_mcp_0_write','ambiguous',{workId:'write-work',arguments:args});
  assert.equal(result.originalRequestId,'mcp:ambiguous');assert.equal(result.status,'intent');assert.equal(remote.state.value,0);
  assert.equal(remote.state.requests.filter(r=>r.m.method==='tools/call').length,0);
  assert.equal(m.state.callIntents.filter(c=>c.kind==='external').length,1);
});


test('MCP changed schemas revoke the current operation and cannot become approved by rebuilding the same project runtime',async t=>{
  const remote=await server(t),m=await controlled(t,{url:remote.url});
  await m.call('project_mcp_0_read','first',{workId:'read-work',arguments:{}});
  remote.state.schemaChanged=true;
  const changed=await m.call('project_mcp_0_read','changed',{workId:'read-work',arguments:{}});assert.equal(changed.status,'not_sent');assert.match(changed.error,/schema.*changed/i);
  assert.equal(remote.state.requests.filter(r=>r.m.method==='tools/call').length,1);
  await m.context.seal();
  await assert.rejects(m.call('project_mcp_0_read','rebuilt',{workId:'read-work',arguments:{}}),{code:'PROJECT_MCP_SCHEMA'});
  assert.equal(remote.state.requests.filter(r=>r.m.method==='tools/call').length,1);
});

test('actual PROJECT task cancellation preserves a remote unknown effect and original-job query permission',async t=>{
  const remote=await server(t),m=await controlled(t,{url:remote.url});remote.state.holdStarts=true;
  let accepted;const started=new Promise(resolve=>{accepted=resolve;});remote.state.onStart=accepted;
  const pending=m.call('project_mcp_0_start','cancelled-start',{workId:'job-work',arguments:{id:'independent'}});
  await started;m.state.status='paused';await m.task.cancel();const result=await pending;
  assert.equal(result.status,'outcome_unknown');assert.equal(remote.state.starts,1);
  await assert.rejects(m.call('project_mcp_0_read','after-cancel',{workId:'read-work',arguments:{}}),{code:'CANCELLED'});
  const status=await m.call('project_mcp_recover','query-running',{originalRequestId:'mcp:cancelled-start',action:'query'});assert.equal(status.status,'outcome_unknown');
  remote.state.jobs.set('independent','completed');const completed=await m.call('project_mcp_recover','query-completed',{originalRequestId:'mcp:cancelled-start',action:'query'});assert.equal(completed.status,'completed');assert.equal(remote.state.starts,1);
});

test('normal PROJECT employee uses its own command MCP copy and creator review before root acceptance',{timeout:60000},async t=>{
  const repo=repository(t);let root=0,employee=0,memberId,resultId,error;
  const f=await fixture(t,({body})=>{try{
    const names=body.tools.map(t=>t.function.name),last=body.messages.findLast(m=>m.role==='tool')?.content??'';
    if(names.includes('accept_change')){
      switch(++root){
        case 1:return tool('project_staff',{action:'appoint',input:{id:'writer',responsibility:'Own a.txt',models:['fixture/main'],scope:['a.txt'],need:'deliverable',reason:'Use confirmed MCP in the employee-owned source copy'}});
        case 2:return tool('delegate',{staffId:'writer',model:'fixture/main',scope:['a.txt'],readScope:['a.txt'],assignment:'Use confirmed command MCP to change a.txt to MCP_CHECKED, inspect and adopt your own complete result',reason:'Owns the checked file deliverable'});
        case 3:memberId=JSON.parse(last).memberId;assert.ok(memberId,last);return tool('collect',{memberId});
        case 4:assert.match(last,/MCP_CHECKED/);return tool('accept_change',{memberId});
        default:if(JSON.parse(last).status==='review_required')return tool('accept_change',{memberId});assert.equal(JSON.parse(last).status,'accepted',last);return {text:'Root accepted the creator-reviewed employee MCP file.'};
      }
    }
    if(!names.includes('project_mcp_0_read'))return {text:'I independently checked the original exact file goal and will inspect the scoped MCP source before changing the artifact.'};
    switch(++employee){
      case 1:return tool('project_mcp_0_read',{workId:'file',arguments:{}});
      case 2:assert.match(last,/base A/);return tool('project_mcp_0_write',{workId:'file',arguments:{value:7}});
      case 3:resultId=JSON.parse(last).projectMcpResultId;assert.ok(resultId,last);return tool('project_mcp_result',{resultId,decision:'inspect'});
      case 4:return tool('project_mcp_result',{resultId,decision:'adopt',reason:'Inspected complete employee-owned MCP file delta'});
      default:assert.equal(JSON.parse(last).status,'applied',last);return {text:'MCP_CHECKED is ready in my employee change for root acceptance.'};
    }
  }catch(e){error=e;return {text:'Unexpected employee MCP material'};}});
  const code=join(f.home,'employee-mcp-code');mkdirSync(code);writeFileSync(join(code,'server.mjs'),commandServer);configMcp(f.home,{command:'node',args:['server.mjs'],cwd:code});
  const selected=selection();delete selected.tools.start;delete selected.tools.status;delete selected.tools.cancel;
  saveConfig(f.home,{formatVersion:2,...f.models,work:{execution}});const plan=join(f.home,'employee-plan.json');
  writeFileSync(plan,JSON.stringify({goal:'Have the designated employee change a.txt to MCP_CHECKED using its confirmed command MCP',mcp:[selected],scope:['a.txt'],works:[{id:'file',scope:['a.txt'],effect:{target:'counter',action:'write',round:1}}],budget:{maxCalls:16},deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='MCP_CHECKED\\n')process.exit(1)"]}]}));
  const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);if(error)throw error;assert.equal(run.code,0,run.stdout+run.stderr);const state=JSON.parse(run.stdout);assert.equal(state.status,'completed',run.stdout);
  const task=listTasks(f.home)[0],result=task.tools.find(r=>r.resultId===resultId);assert.equal(result.parentActorId,'member:'+memberId);assert.equal(result.treatment.decision,'adopted');assert.equal(git(repo.project,'show',state.version+':a.txt'),'MCP_CHECKED');
  assert.equal(task.stages.filter(s=>s.phase==='project-effect').length,0,'The MCP effect must not cause an extra model generation');assert.equal(state.usage.calls,f.calls.length);assert.equal(state.usage.externalOperations,2);
  const runtimes=task.tools.filter(r=>r.kind==='project_mcp_runtime');assert.ok(runtimes.every(r=>r.stoppedAt));assert.ok(runtimes.length>0);
  for(const r of runtimes){assert.equal(r.parentActorId,'member:'+memberId);assert.ok(task.stages.some(s=>s.sessionId===r.sessionId&&s.role===r.parentActorId));assert.ok(r.cwd.includes('/member-'+memberId+'/'));}
});


test('MCP echoed credentials in RPC initialization, tool and recovery errors are redacted before model, history and CLI propagation',async t=>{
  const remote=await server(t);remote.state.rpcErrorFor='initialize';
  const initializing=await controlled(t,{url:remote.url,headers:{authorization:'Bearer scoped'}});
  await assert.rejects(initializing.call('project_mcp_0_read','init-error',{workId:'read-work',arguments:{}}),error=>{assert.doesNotMatch(error.message,/Bearer scoped/);assert.match(error.message,/REDACTED/);return true;});
  delete remote.state.rpcErrorFor;const m=await controlled(t,{url:remote.url,headers:{authorization:'Bearer scoped'}});
  remote.state.rpcErrorFor='write';const failed=await m.call('project_mcp_0_write','error-write',{workId:'write-work',arguments:{value:7}});assert.equal(failed.status,'outcome_unknown');assert.doesNotMatch(JSON.stringify(failed),/Bearer scoped/);assert.match(failed.error,/REDACTED/);assert.doesNotMatch(JSON.stringify(m.task.record),/Bearer scoped/);assert.doesNotMatch(JSON.stringify(m.state),/Bearer scoped/);
  delete remote.state.rpcErrorFor;const started=await m.call('project_mcp_0_start','error-job',{workId:'job-work',arguments:{id:'independent'}});assert.equal(started.status,'outcome_unknown');
  remote.state.rpcErrorFor='status';await assert.rejects(m.call('project_mcp_recover','error-query',{originalRequestId:'mcp:error-job',action:'query'}),error=>{assert.doesNotMatch(error.message,/Bearer scoped/);assert.match(error.message,/REDACTED/);return true;});assert.doesNotMatch(JSON.stringify(m.task.record),/Bearer scoped/);
});


test('normal CLI recovers only the original command cgroup after owner loss and retains complete partial files without replay',{timeout:45000},async t=>{
  const {existsSync,rmSync}=await import('node:fs');const repo=repository(t);let fixtureError;
  const f=await fixture(t,({body},n)=>{try{if(n===1)return tool('next_change',{reason:'Run the confirmed original command job',scope:['a.txt'],readScope:['a.txt']});if(n===2)return tool('project_mcp_0_start',{workId:'job',arguments:{id:'lost-owner'}});throw Error('A recovery operation must not generate another model call');}catch(e){fixtureError=e;return {text:'Unexpected recovery fixture request'};}});
  const code=join(f.home,'owner-loss-code');mkdirSync(code);writeFileSync(join(code,'server.mjs'),`import fs from 'node:fs';import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owner-loss',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'start',inputSchema:{type:'object'}}]};if(m.method==='tools/call'){fs.writeFileSync('a.txt','PARTIAL_FROM_ORIGINAL');setInterval(()=>fs.appendFileSync('a.txt','.'),20);return;}if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  configMcp(f.home,{command:'node',args:['server.mjs'],cwd:code});saveConfig(f.home,{formatVersion:2,...f.models,work:{execution}});
  const selected={server:'local',trust:'explicit-service-contract',tools:{start:{kind:'start',target:'owner-loss-job',action:'start',round:1,allowedArguments:[{id:'lost-owner'}]}}};
  const plan=join(f.home,'owner-loss-plan.json');writeFileSync(plan,JSON.stringify({goal:'Start one confirmed command job and preserve its partial file on owner loss',mcp:[selected],scope:['a.txt'],works:[{id:'job',scope:['a.txt'],effect:{target:'owner-loss-job',action:'start',round:1}}],budget:{maxCalls:3},deliverables:['a.txt'],checks:[{command:'node',args:['-e','process.exit(0)']}]}));
  const cli=process.env.COTHINK_TEST_CLI??new URL('../bin/cothink.js',import.meta.url).pathname;
  const child=spawn(process.execPath,[cli,'project','start','--file',plan,'--json'],{cwd:repo.project,env:{...process.env,COTHINK_HOME:f.home,COTHINK_NO_TTY:'1',PI_OFFLINE:'1'},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit'),output=[];child.stdout.on('data',b=>output.push(b));child.stderr.on('data',b=>output.push(b));
  const cleanupIds=[];t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');for(const id of cleanupIds)try{execFileSync('docker',['rm','-f',id],{stdio:'ignore'});}catch{}});
  let task,runtime,original;
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){task=listTasks(f.home).find(x=>x.project);runtime=task?.tools?.findLast(r=>r.kind==='project_mcp_runtime'&&r.requests?.some(q=>q.tool==='start'&&q.sent));original=runtime?.requests.find(q=>q.tool==='start'&&q.sent);if(runtime&&existsSync(join(runtime.cwd,'a.txt'))&&readFileSync(join(runtime.cwd,'a.txt'),'utf8').startsWith('PARTIAL_FROM_ORIGINAL'))break;if(child.exitCode!==null||child.signalCode!==null)throw Error(Buffer.concat(output).toString());await delay(30);}
  assert.ok(original,Buffer.concat(output).toString());const originalId=runtime.commandIdentity.id;cleanupIds.push(originalId);
  assert.equal(task.tools.find(t=>t.kind==='project_mcp_call'&&t.requestId===original.id).containerProofDigest,runtime.commandIdentity.digest);
  child.kill('SIGKILL');await exited;assert.equal(f.calls.length,2);assert.equal(JSON.parse(execFileSync('docker',['inspect',originalId],{encoding:'utf8'}))[0].State.Running,true);
  const revision=await invoke(f,['project','revise','--goal','Preserve the original pending command job without replay under its old receipt','--step','main','--json'],'',repo.project);assert.equal(revision.code,0,revision.stdout+revision.stderr);assert.equal(JSON.parse(revision.stdout).revision,2);
  const pause=await invoke(f,['project','pause','--json'],'',repo.project);assert.equal(pause.code,0,pause.stdout+pause.stderr);assert.equal(f.calls.length,2);
  const unrelatedName='cothink-unrelated-'+randomUUID(),unrelatedId=execFileSync('docker',['run','-d','--name',unrelatedName,'--network','none',execution.image,'node','-e','setInterval(()=>{},1000)'],{encoding:'utf8'}).trim();cleanupIds.push(unrelatedId);
  // Cleanup must use historical process evidence even after current config/code changes.
  rmSync(join(f.home,'pi','mcp.json'));writeFileSync(join(code,'server.mjs'),'throw Error("Changed config/source must not be imported for old cleanup")');
  const taskFile=join(f.home,'tasks',task.id+'.json'),originalTaskBytes=readFileSync(taskFile),legacy=JSON.parse(originalTaskBytes);
  delete legacy.tools.find(r=>r.kind==='project_mcp_runtime'&&r.commandIdentity?.id===originalId).commandIdentity;
  writeFileSync(taskFile,JSON.stringify(legacy));
  const unsafe=await invoke(f,['project','mcp','cancel',JSON.stringify({originalRequestId:original.id}),'--json'],'',repo.project);assert.notEqual(unsafe.code,0);assert.equal(JSON.parse(execFileSync('docker',['inspect',originalId],{encoding:'utf8'}))[0].State.Running,true);writeFileSync(taskFile,originalTaskBytes);
  const query=await invoke(f,['project','mcp','query',JSON.stringify({originalRequestId:original.id}),'--json'],'',repo.project);assert.equal(query.code,0,query.stdout+query.stderr);let state=JSON.parse(query.stdout),observation=state.mcpRecovery.processObservation;
  assert.equal(observation.identityVerified,true);assert.equal(observation.running,true);assert.equal(observation.serviceQueryPerformed,false);assert.equal(state.mcpRecovery.jobOutcome,'unknown');assert.equal(f.calls.length,2);
  const cancel=await invoke(f,['project','mcp','cancel',JSON.stringify({originalRequestId:original.id}),'--json'],'',repo.project);assert.equal(cancel.code,0,cancel.stdout+cancel.stderr);state=JSON.parse(cancel.stdout);observation=state.mcpRecovery.processObservation;
  assert.equal(observation.stoppedVerified,true);assert.equal(observation.localState,'absent');assert.equal(state.mcpRecovery.jobOutcome,'unknown');assert.notEqual(state.mcpRecovery.status,'completed');assert.equal(f.calls.length,2);
  assert.equal(execFileSync('docker',['container','ls','-a','--no-trunc','--filter','id='+originalId,'--format','{{.ID}}'],{encoding:'utf8'}).trim(),'');
  assert.equal(JSON.parse(execFileSync('docker',['inspect',unrelatedId],{encoding:'utf8'}))[0].State.Running,true);
  task=listTasks(f.home).find(x=>x.id===task.id);const result=task.tools.find(r=>r.resultId===state.mcpRecovery.projectMcpResultId);assert.ok(result);assert.equal(result.inputVersion,runtime.inputVersion);assert.equal(result.origin,'original-command-cgroup-cleanup');assert.equal(result.businessOutcome,'unknown');assert.match(readFileSync(join(result.cwd,'a.txt'),'utf8'),/^PARTIAL_FROM_ORIGINAL/);assert.equal(result.treatment,undefined);assert.equal(result.import,undefined);assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
  const bytes=readFileSync(join(result.cwd,'a.txt'));await delay(100);assert.deepEqual(readFileSync(join(result.cwd,'a.txt')),bytes);
  // Reusing the original name cannot redirect a second cancel to another cgroup.
  const impostorId=execFileSync('docker',['run','-d','--name',runtime.containerId,'--network','none',execution.image,'node','-e','setInterval(()=>{},1000)'],{encoding:'utf8'}).trim();cleanupIds.push(impostorId);
  const again=await invoke(f,['project','mcp','cancel',JSON.stringify({originalRequestId:original.id}),'--json'],'',repo.project);assert.equal(again.code,0,again.stdout+again.stderr);assert.equal(JSON.parse(execFileSync('docker',['inspect',impostorId],{encoding:'utf8'}))[0].State.Running,true);assert.equal(f.calls.length,2);if(fixtureError)throw fixtureError;
});
