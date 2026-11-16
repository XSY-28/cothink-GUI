import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn,executeConfirmed} from '../src/project-turn.js';
import {readTask,readRequests} from '../src/task.js';
import {inspectFileContinuation} from '../src/project-continuation.js';
import {reserveFileContinuation} from '../src/project-file-confirmation.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});

// Real Pi HTTP and Docker, but no external model: exercise actual exhausted
// inheritance, not a manually reduced budget or forged accounting record.
for(const maxCalls of [14,16])test(`employee draft continuation retains cumulative root cap ${maxCalls}`,async t=>{
 const plan={goal:'Change A and B',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],deliverables:['a.txt','b.txt'],
  checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('changed A'))process.exit(1)"]}]};
 const first=[tool('read',{path:'a.txt'}),
  tool('project_staff',{action:'appoint',input:{id:'writer',responsibility:'Change a.txt',models:['fixture/r2'],scope:['a.txt'],need:'deliverable',reason:'Implement the file'}}),
  tool('delegate',{staffId:'writer',workId:'main:a.txt',model:'fixture/r2',assignment:'Change base A to changed A',scope:['a.txt'],readScope:['a.txt','b.txt'],reason:'Implement the file'}),
  tool('collect'),tool('read',{path:'a.txt'})];
 const resumed=[tool('read',{path:'a.txt'}),
  tool('refresh_change',{scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],reason:'Finish the original authorized step after restoring A'}),
  tool('read',{path:'b.txt'}),tool('write',{path:'b.txt',content:'unfinished B\n'}),
  tool('read',{path:'b.txt'}),tool('write',{path:'b.txt',content:'finished B\n'}),
  tool('accept_change'),tool('accept_change'),{text:'Delivered restored A and B'}];
 let continuing=false,leader=0,worker=0,checks=0,dropped=false;
 const f=await fixture(t,({body},n,req,res)=>{
  if(n===1)return tool('start_work',{action:'start',reason:'bounded collaboration',plan});
  const content=body.messages.findLast(m=>m.role==='user')?.content;
  const raw=typeof content==='string'?content:content?.map(p=>p.text).join('');
  if(raw?.includes('cothink-process-observation')){checks++;return {text:'{"issues":[]}'};}
  if(body.model==='r2'){
   assert.equal(continuing,false,'restoration must not re-dispatch the original worker');
   if(raw?.includes('Independent task preparation'))return {text:'File implementation understood.'};
   if(worker===2){dropped=true;res.destroy();return null;}
   return [tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]})][worker++];
  }
  return (continuing?resumed:first)[leader++]??{text:'Preserve the stopped employee draft.'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls}}),source=await confirmProject(base,proposal);
 assert.equal(dropped,true);assert.equal(source.record.status,'outcome_unknown',source.record.error);
 const fact=await inspectFileContinuation({home:f.home,sourceRootTaskId:source.record.id});
 assert.equal(fact.eligible,true,JSON.stringify(fact.blockers));
 assert.equal(fact.remainingBudget.maxCalls,maxCalls-f.calls.length);
 assert.ok(fact.remainingBudget.maxCalls>0&&fact.remainingBudget.maxCalls<resumed.length,'remaining calls are genuinely insufficient');
 const oldRequest=readRequests(f.home,readTask(f.home,fact.draft.taskId)).find(r=>r.sent&&r.status==='outcome_unknown');
 assert.ok(oldRequest);const oldPath=join(f.home,'requests',oldRequest.id+'.json'),oldBytes=readFileSync(oldPath);
 const reservation=await reserveFileContinuation({home:f.home,sessionId:source.record.sessionId,sourceRootTaskId:source.record.id,draft:fact.draft,
  submissionId:'budget-continuation',authorizationSource:{kind:'file_continuation',sourceTaskId:source.record.id,mode:'user'},expectedRevision:fact.revision,expectedFormalVersion:fact.formalVersion});
 const saved=readTask(f.home,source.record.id),before=f.calls.length,priorWorkers=f.calls.filter(c=>c.body.model==='r2').length;
 continuing=true;leader=0;
 const next=await runProjectTurn({...base,input:saved.input,taskId:reservation.taskId,submissionId:reservation.submissionId,
  budget:reservation.budgetSource.remaining,confirmedOperation:{source:saved,reservation,execute:task=>executeConfirmed(task,saved,reservation)}});
 assert.notEqual(next.record.status,'completed');
 assert.equal(f.calls.length,maxCalls,'proposal, employee, checker, lost response and continuation share the exact original cap');
 assert.equal(f.calls.length-before,fact.remainingBudget.maxCalls);
 assert.equal(f.calls.filter(c=>c.body.model==='r2').length,priorWorkers);
 assert.deepEqual(readFileSync(oldPath),oldBytes,'unknown request bytes are not rewritten');
 assert.equal(oldRequest.usage,null);
 const exhausted=await inspectFileContinuation({home:f.home,sourceRootTaskId:next.record.id});
 assert.equal(exhausted.eligible,false);
 assert.ok(exhausted.blockers.some(b=>b.code==='ROOT_BUDGET'),JSON.stringify(exhausted.blockers));
 const count=f.calls.length;
 await assert.rejects(reserveFileContinuation({home:f.home,sessionId:next.record.sessionId,sourceRootTaskId:next.record.id,draft:exhausted.draft,
  submissionId:'must-not-reset-budget',authorizationSource:{kind:'file_continuation',sourceTaskId:next.record.id,mode:'user'},
  expectedRevision:exhausted.revision,expectedFormalVersion:exhausted.formalVersion}),{code:'CONTINUATION_BLOCKED'});
 assert.equal(f.calls.length,count,'another continuation cannot mint calls');
 assert.ok(priorWorkers>=4,'employee preparation, read, edit and lost request participated');
 assert.ok(checks>=1,'process checker participated in the same original cap');
});
