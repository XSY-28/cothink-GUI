import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn,executeConfirmed} from '../src/project-turn.js';
import {readTask,readRequests} from '../src/task.js';
import {inspectFileContinuation} from '../src/project-continuation.js';
import {reserveFileContinuation} from '../src/project-file-confirmation.js';
import {createVersioning} from '../src/versioning.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
for(const mode of ['success','chained','chained-changed','accepted-chain','accepted-result','covered','checker-unknown','checker-issues','budget','unconsumed','changed'])test('restored writer missing process coverage: '+mode,async t=>{
 const plan={goal:'Delegate A',scope:['a.txt'],readScope:['a.txt'],deliverables:['a.txt'],collaboration:{workers:1},checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('ready A'))process.exit(1)"]}]};
 if(mode.startsWith('accepted-')){plan.scope.push('b.txt');plan.readScope.push('b.txt');plan.deliverables.push('b.txt');}
 if(mode==='accepted-result'){plan.scope.push('c.txt');plan.readScope.push('c.txt');plan.deliverables.push('c.txt');}
 const leader=[tool('project_staff',{action:'appoint',input:{id:'writer',responsibility:'Change a.txt',models:['fixture/r2'],scope:['a.txt'],need:'deliverable',reason:'Implement file'}}),tool('delegate',{staffId:'writer',workId:'main:a.txt',model:'fixture/r2',assignment:'Change base A to ready A',scope:['a.txt'],readScope:['a.txt'],reason:'Implement'}),tool('collect'),tool('read',{path:'a.txt'})];
 let chainCut=false,resumed=false,l=0,w=0,workerCount=0,checks=0,due,time=0,restoredPrompt=false;
 const checked=Promise.withResolvers(),clock={now:()=>time,set(fn){due=fn;return fn;},clear(fn){if(due===fn)due=null;}};
 const f=await fixture(t,async({body},n,req,res)=>{
  if(n===1)return tool('start_work',{action:'start',reason:'collaboration',plan});
  const raw=JSON.stringify(body.messages.findLast(m=>m.role==='user')?.content);
  if(raw.includes('cothink-process-observation')) {
    if(++checks>1)checked.resolve();
    if(resumed&&mode==='checker-unknown'){res.destroy();return null;}
    if(resumed&&mode==='checker-issues') {
      const text=body.messages.findLast(m=>m.role==='user').content;
      const observation=JSON.parse(typeof text==='string'?text:text.map(p=>p.text).join(''));
      const fact=observation.members[0];
      return {text:JSON.stringify({issues:[{memberId:fact.memberId,kind:'blocker',evidenceIds:[fact.evidenceIds[0]],reason:'Missing acceptance criterion needs correction'}]})};
    }
    return{text:'{"issues":[]}'};
  }
  if(body.model==='r2'){if(mode==='covered'&&w===2){assert.ok(due);time+=60000;due();await checked.promise;}workerCount++;assert.equal(resumed,false);if(raw.includes('Independent task preparation'))return{text:'Will implement A.'};return [tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'ready A'}]}),{text:'Implemented ready A.'}][w++]??{text:'Ready A saved.'};}
  if(resumed&&(mode.startsWith('chained')&&l===1||mode==='accepted-chain'&&l===7)&&!chainCut){chainCut=true;res.destroy();return null;}
  if(resumed)restoredPrompt ||= /selected saved bytes are now your main draft/.test(JSON.stringify(body.messages))&&/inspect_change\/accept_change WITHOUT memberId/.test(JSON.stringify(body.messages));
  if(resumed&&mode==='accepted-result'&&!chainCut)return [tool('refresh_change',{scope:plan.scope,readScope:plan.readScope,reason:'Restore originally authorized full step before a second file'}),tool('read',{path:'a.txt'}),tool('accept_change'),tool('accept_change'),tool('next_change',{scope:['b.txt'],readScope:plan.readScope,reason:'Complete the second originally authorized file'}),tool('read',{path:'b.txt'}),tool('write',{path:'b.txt',content:'new B\n'}),tool('accept_change'),tool('accept_change'),{text:'Delivered A and B; C remains'}][l++]??{text:'C remains'};
  if(resumed&&mode==='accepted-result'&&chainCut)return [tool('refresh_change',{scope:plan.scope,readScope:plan.readScope,reason:'Complete original authorized remaining file'}),tool('write',{path:'c.txt',content:'new C\n'}),tool('read',{path:'a.txt'}),tool('accept_change'),tool('accept_change'),{text:'Delivered ABC'}][l++]??{text:'Delivered ABC'};
  if(resumed&&mode==='accepted-chain'&&!chainCut)return [tool('refresh_change',{scope:plan.scope,readScope:plan.readScope,reason:'Restore originally authorized full step before a second file'}),tool('read',{path:'a.txt'}),tool('accept_change'),tool('accept_change'),tool('next_change',{scope:['b.txt'],readScope:plan.readScope,reason:'Complete second originally authorized file'}),tool('read',{path:'b.txt'}),tool('write',{path:'b.txt',content:'new B\n'})][l++];
  return resumed?([tool('read',{path:'a.txt'}),...(['changed','chained-changed'].includes(mode)?[tool('edit',{path:'a.txt',edits:[{oldText:'ready A',newText:'ready A modified'}]})]:[]),tool('accept_change'),tool('accept_change'),{text:'Delivered A'}][l++]??{text:'Delivered'}):(leader[l++]??{text:'Collected ready A'});
 });
 const repo=repository(t),base=await projectSession(t,repo,f),upstream=globalThis.fetch;let cut=false,sends=0;
 globalThis.fetch=async(input,init)=>{
  assert.equal(new URL(input instanceof Request?input.url:input).hostname,'127.0.0.1');
  if(cut&&!resumed)throw Error('Interrupted; no extra sends');
  const body=JSON.parse(init.body);sends++;assert.ok(sends<=((mode.startsWith('chained')||mode.startsWith('accepted-'))?50:24));
  const tasks=readdirSync(join(f.home,'tasks')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(join(f.home,'tasks',n))));
  const processed=new Set(tasks.flatMap(t=>readRequests(f.home,t)).filter(r=>r.role==='main'&&r.status==='completed'&&r.context?.messages?.some(m=>m.role==='toolResult'&&m.toolName==='collect'&&!m.isError)).map(r=>r.taskId));
  const collected=tasks.find(t=>(mode==='unconsumed'||processed.has(t.id))&&t.members?.some(m=>m.collected&&m.status==='completed'&&m.changeId)&&!t.work?.acceptance?.length);
  const managerTools=body.tools?.some(t=>(t.name??t.function?.name)==='collect');
  const drop=!resumed&&!cut&&Boolean(collected)&&managerTools;
  const response=await upstream(input,init);
  if(drop&&response.ok){cut=true;await response.body.cancel();return new Response(new ReadableStream({start(c){c.error(Error('Controlled manager cut after collected writer'));}}),{status:200,headers:response.headers});}return response;
 };t.after(()=>{globalThis.fetch=upstream;});
 const proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:mode==='budget'?15:(mode.startsWith('chained')||mode.startsWith('accepted-'))?50:24}}),first=await confirmProject(base,proposal,mode==='covered'?{processCheckClock:clock}:{});
 assert.equal(cut,true,JSON.stringify(first.record));assert.equal(first.record.status,'outcome_unknown');
 const fact=await inspectFileContinuation({home:f.home,sourceRootTaskId:first.record.id});assert.equal(fact.eligible,true,JSON.stringify(fact.blockers));
 const beforeWorkers=workerCount,unknowns=first.record.rootRequests.filter(x=>readRequests(f.home,readTask(f.home,x.taskId)).find(r=>r.id===x.requestId)?.status==='outcome_unknown');assert.ok(unknowns.length);
 const reservation=await reserveFileContinuation({home:f.home,sessionId:first.record.sessionId,sourceRootTaskId:first.record.id,draft:fact.draft,submissionId:'explicit-resume',authorizationSource:{kind:'file_continuation',sourceTaskId:first.record.id,mode:'user'},expectedRevision:fact.revision,expectedFormalVersion:fact.formalVersion});
 const saved=readTask(f.home,first.record.id);const preserved=new Map(unknowns.map(x=>[join(f.home,'requests',x.requestId+'.json'),readFileSync(join(f.home,'requests',x.requestId+'.json'))]));resumed=true;l=0;
 let result=await runProjectTurn({...base,input:saved.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,confirmedOperation:{source:saved,reservation,execute:t=>executeConfirmed(t,saved,reservation)}});
 if(mode.startsWith('chained')||mode.startsWith('accepted-')){
   if(mode==='accepted-result'){chainCut=true;const stopped=readTask(f.home,result.record.projectOperation.childTaskIds[0]);assert.ok(stopped.work.resultChangeId,result.record.error);assert.equal(stopped.work.acceptance.length,2);}
   assert.equal(chainCut,true);assert.notEqual(result.record.status,'completed');
   const second=await inspectFileContinuation({home:f.home,sourceRootTaskId:result.record.id});
   assert.equal(second.eligible,true,JSON.stringify(second.blockers));
   if(mode==='accepted-result'){assert.equal(second.inputOnly,true);assert.equal(second.draft.version,second.formalVersion);}
   const again=await reserveFileContinuation({home:f.home,sessionId:result.record.sessionId,sourceRootTaskId:result.record.id,draft:second.draft,submissionId:'second-resume',authorizationSource:{kind:'file_continuation',sourceTaskId:result.record.id,mode:'user'},expectedRevision:second.revision,expectedFormalVersion:second.formalVersion});
   const prior=readTask(f.home,result.record.id);l=0;
   result=await runProjectTurn({...base,input:prior.input,taskId:again.taskId,submissionId:again.submissionId,budget:again.budgetSource.remaining,confirmedOperation:{source:prior,reservation:again,execute:t=>executeConfirmed(t,prior,again)}});
 }
 if(['success','chained','accepted-chain','accepted-result','covered'].includes(mode))assert.equal(result.record.status,'completed',result.record.error);
 else assert.notEqual(result.record.status,'completed');
 assert.equal(workerCount,beforeWorkers);
 assert.equal(restoredPrompt,true,'resume prompt must explain main draft ownership and omit old memberId');
 for(const x of unknowns)assert.equal(readRequests(f.home,readTask(f.home,x.taskId)).find(r=>r.id===x.requestId).status,'outcome_unknown');
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});try{const version=(await v.inspect()).version;assert.equal(Buffer.from((await v.read({version,path:'a.txt'})).contentBase64,'base64').toString(),['changed','chained-changed'].includes(mode)?'ready A modified\n':'ready A\n');}finally{await v.close();}
 for(const [file,bytes] of preserved)assert.deepEqual(readFileSync(file),bytes);
 const observations=result.record.processCheck?.observations??[];
 if(['success','chained','accepted-chain','accepted-result'].includes(mode)){if(mode!=='accepted-result'){assert.equal(observations.length,1);assert.equal(observations[0].status,'completed');}assert.equal(result.record.restoredWorkerProofs.length,1);}
 if(mode==='accepted-result')assert.ok(result.record.restoredWorkerProofs[0].inputRequestId);
 if(mode==='checker-unknown')assert.ok(observations.some(o=>o.status==='outcome_unknown'));
 if(mode==='checker-issues'){assert.match(result.record.error??'',/Restored employee|未完成|协作|PROCESS/);assert.ok(result.record.processCheck.reports.some(r=>r.status==='forwarded'));}
 if(mode==='budget')assert.ok(sends<=15);
 if(mode==='covered'){assert.equal(observations.length,0);assert.equal(result.record.restoredWorkerProofs.length,1);}
 if(['unconsumed','changed','chained-changed'].includes(mode)){assert.equal(observations.length,0);assert.equal(result.record.restoredWorkerProofs?.length??0,0);}
});
