import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn,executeConfirmed} from '../src/project-turn.js';
import {inspectFileContinuation,affectedProjectSteps} from '../src/project-continuation.js';
import {reserveFileContinuation} from '../src/project-file-confirmation.js';
import {readTask,readRequests} from '../src/task.js';
import {writePrivateJson} from '../src/storage.js';
import {projectChatState,runProjectCommand} from '../src/project.js';
import {createVersioning} from '../src/versioning.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
async function continueFrom(base,source,checked,mode='user') {
  const reservation=await reserveFileContinuation({home:base.home,sessionId:source.sessionId,sourceRootTaskId:source.id,
    draft:checked.draft,submissionId:'continue-'+source.id,authorizationSource:{kind:'file_continuation',sourceTaskId:source.id,mode},
    expectedRevision:checked.revision,expectedFormalVersion:checked.formalVersion});
  const saved=readTask(base.home,source.id);
  return runProjectTurn({...base,input:saved.input,taskId:reservation.taskId,submissionId:reservation.submissionId,
    frozenConstraints:saved.constraints,budget:reservation.budgetSource.remaining,
    confirmedOperation:{source:saved,reservation,execute:task=>executeConfirmed(task,saved,reservation)}});
}

import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

test('continuing a prerequisite checks unresolved effects in its disjoint dependent step',async t=>{
 let starts=0;
 const server=createServer(async(req,res)=>{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const message=JSON.parse(Buffer.concat(chunks));let result;
   if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'pending-job',version:'1'}};
   else if(message.method==='tools/list')result={tools:[{name:'start',inputSchema:{type:'object',properties:{id:{type:'string'}}}}]};
   else if(message.method==='tools/call'){starts++;res.destroy();return;}
   if(message.id===undefined){res.writeHead(202);res.end();return;}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const selected={server:'pending',trust:'explicit-service-contract',tools:{start:{kind:'start',target:'dependent-job',action:'start',round:1,allowedArguments:[{id:'original'}]}}};
 const plan={goal:'Verify A then start the dependent B job',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],mcp:[selected],steps:[
   {id:'a',goal:'Verify A',scope:['a.txt'],readScope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]},
   {id:'b',goal:'Start B job',dependsOn:['a'],scope:['b.txt'],readScope:['b.txt'],deliverables:['b.txt'],
    works:[{id:'job',scope:['b.txt'],effect:{target:'dependent-job',action:'start',round:1}}],checks:[{command:'node',args:['-e',"require('fs').accessSync('b.txt')"]}]},
 ]};
 let second=false,index=0;
 const first=[tool('start_work',{action:'start',reason:'two dependent steps',plan}),{text:'A baseline verified'},
   tool('next_change',{reason:'own B job scope',scope:['b.txt'],readScope:['b.txt']}),tool('project_effect',{workId:'job'}),
   tool('project_mcp_0_start',{workId:'job',arguments:{id:'original'}})];
 const revised=[tool('start_work',{action:'revise',reason:'explicitly revise A while retaining the original B operation',plan}),
   tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]})];
 const f=await fixture(t,(_,n,req,res)=>{
   if(!second)return first[n-1]??{text:'B operation remains unresolved'};
   if(index===3){index++;res.destroy();return null;}
   return revised[index++]??{text:'Unexpected replay'};
 });
 mkdirSync(join(f.home,'pi'),{recursive:true});
 writeFileSync(join(f.home,'pi','mcp.json'),JSON.stringify({mcpServers:{pending:{url:`http://127.0.0.1:${server.address().port}/mcp`}}}));
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:20}}),original=await confirmProject(base,proposal);
 assert.equal(starts,1,'the original real external job was sent once');
 const oldState=(await projectChatState(f.home,repo.project)).state;
 assert.ok(oldState.callIntents.some(c=>c.kind==='external'&&c.status==='outcome_unknown'));
 second=true;
 const nextProposal=await runProjectTurn({...base,input:'Revise A explicitly and retain B history.',budget:{maxCalls:20}});
 const source=await confirmProject(base,nextProposal);
 assert.equal(source.record.status,'outcome_unknown',source.record.error);
 const state=(await projectChatState(f.home,repo.project)).state;
 assert.deepEqual(affectedProjectSteps(state,['a']),['a','b']);
 const inspected=await inspectFileContinuation({home:f.home,sourceRootTaskId:source.record.id});
 assert.equal(inspected.stepId,'a',JSON.stringify(inspected));
 assert.equal(inspected.eligible,false);
 const pending=state.callIntents.find(c=>c.kind==='external'&&c.status==='outcome_unknown');
 assert.ok(inspected.blockers.some(b=>b.code==='MCP_PENDING'&&b.sourceId===pending.id),JSON.stringify(inspected.blockers));
 const count=f.calls.length;
 await assert.rejects(continueFrom(base,source.record,inspected),{code:'CONTINUATION_BLOCKED'});
 assert.equal(f.calls.length,count);assert.equal(starts,1,'continuation cannot replay the disjoint dependent effect');
});

for(const shared of [false,true])test(`a later failed dependent preserves its prerequisite (shared file: ${shared})`,async t=>{
 const plan={goal:'Deliver A then B',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],steps:[
   {id:'a',goal:'Save A',dependsOn:[],scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').startsWith('saved A'))process.exit(1)"]}]},
   {id:'b',goal:'Save B',scope:shared?['a.txt','b.txt']:['b.txt'],dependsOn:['a'],deliverables:shared?['a.txt','b.txt']:['b.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('b.txt','utf8')!=='saved B\\n')process.exit(1)"]}]},
 ]};
 let phase=0,index=0;
 const first=[tool('start_work',{action:'start',reason:'dependency ordering',plan}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]})];
 const middle=[tool('read',{path:'a.txt'}),tool('accept_change'),tool('accept_change'),{text:'A is checked.'},
   ...(shared?[tool('refresh_change',{scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],reason:'Implement the confirmed shared-file step'})]:[]),tool('read',{path:'b.txt'}),tool('edit',{path:'b.txt',edits:[{oldText:'base B',newText:'saved B'}]}),...(shared?[tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'saved A',newText:'saved A + B'}]}),tool('accept_change'),tool('accept_change'),tool('next_change',{scope:['b.txt'],readScope:['a.txt','b.txt'],reason:'Finish verification without undoing accepted shared work'}),null]:[{text:'B remains an unaccepted draft.'}])];
 const final=[tool('read',{path:'b.txt'}),tool('accept_change'),tool('accept_change'),{text:'B is checked.'},{text:'A and B are delivered.'}];
 const f=await fixture(t,(_,n,req,res)=>{
   if(phase===0){if(n===4){res.destroy();return null;}return first[n-1];}
   const reply=(phase===1?middle:final)[index++];if(reply===null){res.destroy();return null;}return reply??{text:'Delivered'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:35}}),original=await confirmProject(base,proposal);
 const inspected=await inspectFileContinuation({home:f.home,sourceRootTaskId:original.record.id});assert.equal(inspected.eligible,true,JSON.stringify(inspected.blockers));
 phase=1;index=0;const partial=await continueFrom(base,original.record,inspected);
 assert.equal(partial.record.status,shared?'outcome_unknown':'partial',partial.record.error);
 const before=(await projectChatState(f.home,repo.project)).state;
 assert.equal(before.steps[0].status,'completed');assert.equal(before.steps[1].status,shared?'unknown':'blocked');
 const next=await inspectFileContinuation({home:f.home,sourceRootTaskId:partial.record.id});
 assert.equal(next.eligible,true,JSON.stringify(next.blockers));assert.equal(next.stepId,'b');assert.deepEqual(next.affectedStepIds,['b']);
 assert.equal(next.remainingBudget.maxCalls,35-f.calls.length);
 let finalSource=partial.record,finalFacts=next;
 if(shared){
   const {provePrevious}=await import('../src/project-delivery-checks.js');
   await assert.rejects(provePrevious(f.home,before,next.formalVersion,['a']),/Missing previous deliverable/);
   for(const patch of [{attempts:[]},{scope:['b.txt']}]){
     const unproved={...before,steps:before.steps.map(step=>step.id==='b'?{...step,...patch}:step)};
     await assert.rejects(provePrevious(f.home,unproved,next.formalVersion,['a'],undefined,'b'),/Missing previous deliverable/);
   }
   const file=join(f.home,'project-delivery',before.id,'state.json'),bad=structuredClone(before);
   bad.steps[0].attempts.at(-1).artifacts[0].sha256='not-the-original-receipt';writePrivateJson(file,bad);
   const calls=f.calls.length,blocked=await continueFrom(base,partial.record,next);
   assert.match(blocked.record.error,/Missing previous deliverable/,'report the current startup blocker rather than the old connection error');
   assert.deepEqual(blocked.record.projectOperation.childTaskIds,[]);assert.equal(f.calls.length,calls);
   const restored=(await projectChatState(f.home,repo.project)).state;
   restored.steps[0].attempts.at(-1).artifacts=before.steps[0].attempts.at(-1).artifacts;writePrivateJson(file,restored);
   finalSource=blocked.record;finalFacts=await inspectFileContinuation({home:f.home,sourceRootTaskId:finalSource.id});
   assert.equal(finalFacts.eligible,true,JSON.stringify(finalFacts.blockers));
   const sourcePath=join(f.home,'tasks',finalSource.id+'.json'),saved=readFileSync(sourcePath),uncertain=JSON.parse(saved);
   uncertain.rootRequests=[{requestId:'unsettled-dispatch-intent'}];writePrivateJson(sourcePath,uncertain);
   assert.ok((await inspectFileContinuation({home:f.home,sourceRootTaskId:finalSource.id})).blockers.some(b=>b.code==='DRAFT_REQUIRED'));
   writeFileSync(sourcePath,saved);
 }
 phase=2;index=0;const completed=await continueFrom(base,finalSource,finalFacts);
 assert.equal(completed.record.status,'completed',completed.record.error);
 const after=(await projectChatState(f.home,repo.project)).state;
 assert.equal(after.steps[0].attempts.length,before.steps[0].attempts.length);
 assert.equal(after.steps[0].attempts.at(-1).taskId,before.steps[0].attempts.at(-1).taskId);
 assert.equal(after.steps[0].attempts[0].status,'unknown');assert.deepEqual(after.revisions.at(-1).affected,['b']);
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try {for(const [path,expected] of [['a.txt',shared?'saved A + B\n':'saved A\n'],['b.txt','saved B\n']])assert.equal(Buffer.from((await v.read({version:after.version,path})).contentBase64,'base64').toString(),expected);}
 finally {await v.close();}
});


test('a confirmed continuation carries closed predecessor ownership through its approved dependency closure',async t=>{
 const {continuedTask}=await import('../src/project-continuation.js');
 const checks=text=>[{command:'node',args:['-e',`if(!(${text}))process.exit(1)`]}];
 const plan={goal:'Preserve A while extending it in B',scope:['a.txt'],readScope:['a.txt'],steps:[
  {id:'a',goal:'Write A',dependsOn:[],scope:['a.txt'],deliverables:['a.txt'],checks:checks("require('fs').readFileSync('a.txt','utf8').startsWith('A')")},
  {id:'b',goal:'Extend to AB',dependsOn:['a'],scope:['a.txt'],deliverables:['a.txt'],checks:checks("require('fs').readFileSync('a.txt','utf8')==='AB\\n'")},
 ]};
 let continuing=false,main=0,worker=0;
 const f=await fixture(t,({body},n,req,res)=>{
  if(n===1)return tool('start_work',{action:'start',reason:'ordered implementation',plan});
  const content=body.messages.findLast(m=>m.role==='user')?.content,raw=typeof content==='string'?content:content?.map(x=>x.text).join('');
  if(raw?.includes('cothink-process-observation'))return {text:'{"issues":[]}'};
  if(body.model==='r2'){
   if(raw?.includes('Independent task preparation'))return {text:'I understand the scoped A implementation.'};
   if(worker===2){res.destroy();return null;}
   return [tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'A'}]})][worker++];
  }
  if(!continuing)return [
   tool('project_staff',{action:'appoint',input:{id:'writer',scope:['a.txt'],readScope:['a.txt'],models:['fixture/r2'],responsibility:'Write A',need:'deliverable',reason:'Bounded implementation'}}),
   tool('delegate',{staffId:'writer',workId:'a:a.txt',model:'fixture/r2',scope:['a.txt'],readScope:['a.txt'],assignment:'Replace base A with A',reason:'Implement A'}),
   tool('collect'),{text:'Preserve the stopped employee draft.'},
  ][main++]??{text:'Stopped'};
  return [tool('read',{path:'a.txt'}),tool('accept_change'),tool('accept_change'),{text:'A complete.'},
   tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'A',newText:'AB'}]}),tool('accept_change'),tool('accept_change'),{text:'B complete.'}][main++]??{text:'AB delivered.'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:40}}),source=await confirmProject(base,proposal);
 assert.equal(source.record.status,'outcome_unknown',source.record.error);
 const old=readTask(f.home,source.record.projectOperation.childTaskIds[0]),oldPath=join(f.home,'tasks',old.id+'.json'),saved=readFileSync(oldPath);
 const unknown=readRequests(f.home,old).find(r=>r.status==='outcome_unknown'),unknownPath=join(f.home,'requests',unknown.id+'.json'),savedUnknown=readFileSync(unknownPath);
 const fact=await inspectFileContinuation({home:f.home,sourceRootTaskId:source.record.id});assert.equal(fact.eligible,true,JSON.stringify(fact));
 continuing=true;main=0;const done=await continueFrom(base,source.record,fact);assert.equal(done.record.status,'completed',JSON.stringify({error:done.record.error,lastTools:f.calls.map(c=>c.body.messages.findLast(m=>m.role==='tool')?.content).filter(Boolean).slice(-7)}));
 const {state}=await projectChatState(f.home,repo.project),current=state.steps[1].attempts.at(-1).taskId;
 assert.equal(continuedTask(state,current,old.id),true);
 for(const alter of [s=>s.steps[0].status='pending',s=>s.steps[1].dependsOn=[],s=>s.steps[0].attempts[0].rootTaskId='foreign']){
  const bad=structuredClone(state);alter(bad);assert.equal(continuedTask(bad,current,old.id),false);
 }
 assert.deepEqual(readFileSync(oldPath),saved);assert.deepEqual(readFileSync(unknownPath),savedUnknown);
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try{assert.equal(Buffer.from((await v.read({version:state.version,path:'a.txt'})).contentBase64,'base64').toString(),'AB\n');}finally{await v.close();}
});

test('an input-only continuation preserves a legacy missing-deliverable failure without resetting a real candidate',async t=>{
 const {execution}=await import('./helpers/agent-sync-fixture.js');
 const {readFileSync}=await import('node:fs');
 const plan={goal:'Read A and create new.txt',scope:['a.txt','new.txt'],readScope:['a.txt','new.txt'],deliverables:['new.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('new.txt','utf8')!=='B\\n')process.exit(1)"]}]};
 let phase=0,index=0;
 const f=await fixture(t,(_,n,req,res)=>{
  if(phase===0){if(n===3){res.destroy();return null;}return [tool('start_work',{action:'start',reason:'new deliverable',plan}),tool('read',{path:'a.txt'})][n-1];}
  if(phase===1)return [tool('read',{path:'a.txt'}),{text:'No implementation was produced.'}][index++]??{text:'Stopped'};
  return [tool('write',{path:'new.txt',content:'B\n'}),tool('accept_change'),tool('accept_change'),{text:'New file delivered.'}][index++]??{text:'Delivered'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:35},frozenConstraints:{allowFileContinuation:true}}),source=await confirmProject(base,proposal);
 const initial=await inspectFileContinuation({home:f.home,sourceRootTaskId:source.record.id});
 assert.equal(initial.eligible,true,JSON.stringify(initial.blockers));assert.equal(initial.requiresManual,true);assert.deepEqual(initial.restorePaths,[]);
 await assert.rejects(continueFrom(base,source.record,initial,'preauthorized_once'));
 phase=1;index=0;const stopped=await continueFrom(base,source.record,initial);
 assert.equal(stopped.record.status,'partial');assert.match(stopped.record.error,/尚未交付/);
 const child=readTask(f.home,stopped.record.projectOperation.childTaskIds[0]);assert.equal(child.work.finalCheck,undefined,'no implementation means no final candidate to diagnose');
 const {state}=await projectChatState(f.home,repo.project),step=state.steps[0];
 let v=await createVersioning({home:f.home,project:repo.project,execution,checks:step.checks,checkPolicies:{'step-main':step.checks}});
 try{
  // Reproduce the old host's final check over an unchanged, read-only input.
  const failed=await v.checkCurrent({requestId:'legacy-input-check',checkPolicy:child.project.checkPolicy});assert.equal(failed.status,'check_failed');
  child.work.finalCheck=failed;child.work.requests.push({action:'checkCurrent',requestId:failed.requestId,status:'check_failed',dispatched:true});
  const childPath=join(f.home,'tasks',child.id+'.json');writePrivateJson(childPath,child);const saved=readFileSync(childPath);
  step.route={projectId:state.id,stepId:step.id,revision:step.revision,taskId:child.id,kind:'failed',status:'paused',candidate:failed.version,evidence:{requestId:failed.requestId,checks:failed.checks,tree:failed.tree}};
  const statePath=join(f.home,'project-delivery',state.id,'state.json');writePrivateJson(statePath,state);
  const inspected=await inspectFileContinuation({home:f.home,sourceRootTaskId:stopped.record.id});
  assert.equal(inspected.eligible,true,JSON.stringify(inspected.blockers));assert.ok(inspected.recoveredRoute.inputOnlyFailure);
  const bad=structuredClone(state);bad.steps[0].route.evidence.requestId='missing-check';writePrivateJson(statePath,bad);
  assert.ok((await inspectFileContinuation({home:f.home,sourceRootTaskId:stopped.record.id})).blockers.some(x=>x.code==='PROJECT_ROUTE'));
  writePrivateJson(statePath,state);await v.close();phase=2;index=0;const done=await continueFrom(base,stopped.record,inspected);
  assert.equal(done.record.status,'completed',done.record.error);
  v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
  assert.deepEqual(readFileSync(childPath),saved);assert.equal((await v.inspect({requestId:failed.requestId})).status,'check_failed');
  const after=(await projectChatState(f.home,repo.project)).state;
  assert.ok(after.steps[0].routeHistory.some(r=>r.status==='paused'&&r.inputOnlyFailure));
  assert.equal(Buffer.from((await v.read({version:after.version,path:'new.txt'})).contentBase64,'base64').toString(),'B\n');
 }finally{await v.close();}
});
