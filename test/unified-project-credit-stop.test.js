import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import {readTask,readRequests} from '../src/task.js';
import {guiFiles,guiFile} from '../src/gui-files.js';
import {reserveFileContinuation} from '../src/project-file-confirmation.js';
import {inspectFileContinuation} from '../src/project-continuation.js';

 test('HTTP 200 SSE credit exhaustion stops the root and preserves draft and unknown usage',async t=>{
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const plan={goal:'Save A',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e','process.exit(0)']}]};
 const replies=[tool('start_work',{action:'start',reason:'edit',plan}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]})];
 let exhausted=0;
 const f=await fixture(t,(_,n,req,res)=>{
  if(n===4){exhausted++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({error:{type:'insufficient_quota',code:'credit_balance_exhausted',message:'You have no credits remaining.'}})+'\n\ndata: [DONE]\n\n');return null;}
  assert.ok(n<4,'no generation after credit exhaustion');return replies[n-1];
 });
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposed=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:20},frozenConstraints:{allowFileContinuation:true}});
 const root=await confirmProject(base,proposed);
 assert.equal(exhausted,1);assert.equal(f.calls.length,4);
 const saved=readTask(f.home,root.record.id),child=readTask(f.home,saved.projectOperation.childTaskIds[0]);
 const failed=readRequests(f.home,child).find(r=>r.transport?.firstSseError?.error?.code==='credit_balance_exhausted');
 assert.ok(failed);assert.equal(failed.httpStatus,200);assert.equal(failed.status,'outcome_unknown');
 assert.equal(failed.usage,null);assert.equal(failed.estimatedCost,null);
 assert.equal(saved.providerCreditStop.requestId,failed.id);assert.ok(saved.localExecutionClosedAt);
 assert.equal(readRequests(f.home,child).filter(r=>['preparing','in_flight'].includes(r.status)).length,0);
 const files=await guiFiles(f.home,saved),item=files.items.find(x=>x.name==='a.txt'&&x.ref?.draft);
 assert.ok(item);assert.equal((await guiFile(f.home,readTask(f.home,item.ref.taskId),item.ref)).bytes.toString(),'saved A\n');
 const facts=await inspectFileContinuation({home:f.home,sourceRootTaskId:saved.id});
 assert.equal(facts.eligible,true,JSON.stringify(facts.blockers));assert.equal(facts.requiresManual,true);
 await assert.rejects(reserveFileContinuation({home:f.home,sessionId:saved.sessionId,sourceRootTaskId:saved.id,draft:facts.draft,submissionId:'auto',expectedRevision:facts.revision,expectedFormalVersion:facts.formalVersion,authorizationSource:{kind:'file_continuation',sourceTaskId:saved.id,mode:'preauthorized_once'}}),{code:'CONTINUATION_AUTH'});
 assert.equal(f.calls.length,4);
});

for(const role of ['employee','checker','manager-after-collect'])test(`credit exhaustion in ${role} closes every owned role`,async t=>{
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const plan={goal:'Save A and inspect B',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e','process.exit(0)']}]};
 const replies=[tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}),
 tool('project_staff',{action:'appoint',input:{id:'reader',responsibility:'Read b.txt',models:['fixture/r2'],scope:['b.txt'],need:'deliverable',reason:'Independent observation'}}),
 tool('delegate',{staffId:'reader',workId:'main:a.txt',model:'fixture/r2',assignment:'Inspect b.txt',scope:[],readScope:['a.txt','b.txt'],readOnly:true,reason:'Independent observation'}),tool('collect',{}),tool('read',{path:'a.txt'})];
 let leader=0,dropped=false,due,time=0,stoppedAtCall;
 const clock={now:()=>time,set(fn){due=fn;return fn;},clear(fn){if(due===fn)due=null;}};
 const f=await fixture(t,({body},n,req,res)=>{
  assert.equal(dropped,false,'no role may issue a new request after quota failure');
  if(n===1)return tool('start_work',{action:'start',reason:'bounded collaboration',plan});
  const raw=JSON.stringify(body.messages.findLast(m=>m.role==='user')?.content),checker=raw.includes('cothink-process-observation');
  if(role==='checker'?checker:role==='employee'?body.model==='r2':!checker&&body.model==='main'&&leader===6){
   dropped=true;stoppedAtCall=n;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({error:{type:'insufficient_quota',code:'credit_balance_exhausted',message:'No credits'}})+'\n\ndata: [DONE]\n\n');return null;
  }
  if(checker)return {text:'{"issues":[]}'};
  if(body.model==='r2'){
   if(raw.includes('Independent task preparation'))return {text:'Read-only task understood.'};
   if(!body.messages.some(m=>m.role==='tool'))return tool('read',{path:'b.txt'});
   return {text:'Read b.txt; no writes.'};
  }
  return replies[leader++]??{text:'Saved A'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:30}}),root=await confirmProject(base,proposal,{processCheckClock:clock});
 assert.equal(dropped,true);assert.equal(f.calls.length,stoppedAtCall);const saved=readTask(f.home,root.record.id);assert.ok(saved.providerCreditStop);assert.ok(saved.localExecutionClosedAt);
 const records=[saved,...saved.projectOperation.childTaskIds.map(id=>readTask(f.home,id))],requests=records.flatMap(record=>readRequests(f.home,record));
 assert.equal(requests.filter(r=>['preparing','in_flight'].includes(r.status)).length,0);
 const quota=requests.find(r=>r.id===saved.providerCreditStop.requestId);
 assert.equal(quota.status,'outcome_unknown');assert.equal(quota.usage,null);assert.equal(quota.estimatedCost,null);
 const count=f.calls.length;await new Promise(r=>setTimeout(r,50));assert.equal(f.calls.length,count);
 const files=await guiFiles(f.home,saved);assert.ok(files.items.some(x=>x.name==='a.txt'&&x.ref?.draft));
});

test('credit exhaustion at manager final still requires a new manual confirmation',async t=>{
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const plan={goal:'Change a.txt and b.txt',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],steps:[
   {id:'a',goal:'Change A',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('changed A'))process.exit(1)"]}]},
   {id:'b',goal:'Change B',scope:['b.txt'],dependsOn:['a'],deliverables:['b.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('b.txt','utf8').includes('changed B'))process.exit(1)"]}]},
 ]};
 const replies=[tool('start_work',{action:'start',reason:'two bounded steps',plan}),
   tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}),tool('accept_change',{}),{text:'Changed A'},
   tool('read',{path:'b.txt'}),tool('edit',{path:'b.txt',edits:[{oldText:'base B',newText:'changed B'}]}),tool('accept_change',{}),{text:'Changed B'}];
 const f=await fixture(t,(_,n,req,res)=>{if(n===10){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({error:{type:'insufficient_quota',code:'credit_balance_exhausted',message:'No credits'}})+'\n\ndata: [DONE]\n\n');return null;}return replies[n-1]??{text:'Both checked files delivered.'};});
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:'Change a.txt and b.txt.',budget:{maxCalls:20}}),source=await confirmProject(base,proposal);
 assert.equal(source.record.status,'outcome_unknown',source.record.error);
 const checked=await inspectFileContinuation({home:f.home,sourceRootTaskId:source.record.id});
 assert.equal(checked.eligible,true,JSON.stringify(checked.blockers));assert.equal(checked.draft,null);assert.equal(checked.stepId,null);
 assert.equal(checked.requiresManual,true);assert.equal(checked.creditExhausted,true);assert.equal(f.calls.length,10);
});

test('quota words in ordinary model output do not stop a task',async t=>{
 const f=await fixture(t,()=>({text:'The text credit_balance_exhausted is only an example.'}));
 const repo=repository(t),base=await projectSession(t,repo,f),root=await runProjectTurn({...base,input:'Explain this error code.',budget:{maxCalls:3}});
 assert.equal(root.record.status,'completed');assert.equal(root.record.providerCreditStop,undefined);assert.equal(f.calls.length,1);
});
