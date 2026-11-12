import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import {readTask,readRequests} from '../src/task.js';
import {opts} from './unified-turn.fixture.js';
import {confirmProject,projectSession} from './unified-project.fixture.js';

const tool=(name,args={})=>({toolCalls:[{name,args}]});
const latest=body=>JSON.stringify(body.messages.findLast(message=>message.role==='user')?.content);
const check=path=>[{command:'node',args:['-e',`require('fs').accessSync('${path}')`]}];

test('missing explicit collaboration gets one same-session feedback before roles close, then real delegate and collect',async t=>{
 let main=0;
 const f=await fixture(t,({body})=>{
   if(latest(body).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r2')return {text:'Separately investigated the requested evidence.'};
   if(++main===1)return {text:'Premature answer without employees.'};
   if(main===2)return tool('delegate',{workId:'evidence',model:'fixture/r2',assignment:'Investigate the evidence',reason:'Explicitly requested worker'});
   if(main===3)return tool('collect',{assignmentId:JSON.parse(body.messages.findLast(message=>message.role==='tool').content).assignmentId});
   return {text:'Combined the actual employee report.'};
 });
 const task=await runProjectTurn({...opts(f),input:'Assign one worker to investigate the evidence.',budget:{maxCalls:10}});
 assert.equal(task.record.status,'completed',task.record.error);
 assert.equal(task.record.collaborationResult[0].status,'fulfilled');
 const feedback=task.record.completionFeedback;
 assert.ok(feedback,'completion feedback is saved separately from the original answer');
 const requests=task.requests(),original=requests.find(call=>call.id===feedback.sourceRequestId);
 assert.equal(original.text,'Premature answer without employees.');
 const corrected=requests.find(call=>call.id===feedback.resultRequestId);
 assert.equal(corrected.stageId,original.stageId);
 assert.ok(corrected.context.messages.some(message=>JSON.stringify(message.content).includes('cothink-completion-feedback')));
 assert.equal(task.record.stages.filter(stage=>stage.assignment).length,1);
 assert.equal(task.record.usage.calls,f.calls.length);
 assert.equal(task.record.rootRequests.filter(row=>!row.notSent).length,f.calls.length);
});

test('missing file route returns one precise feedback and still requires original proposal confirmation',async t=>{
 const repo=repository(t);
 const f=await fixture(t,(_,n)=>n===1?{text:'Here is inline code for report.txt.'}:tool('start_work',{action:'start',reason:'Deliver the requested file',plan:{
   goal:'Create report',scope:['report.txt'],deliverables:['report.txt'],checks:check('report.txt'),
 }}));
 const base=await projectSession(t,repo,f);
 const task=await runProjectTurn({...base,input:'Create report.txt.',budget:{maxCalls:2}});
 assert.equal(task.record.status,'blocked',task.record.error);
 assert.ok(task.record.proposalRef);
 assert.ok(task.record.completionFeedback);
 assert.equal(f.calls.length,2);
 assert.match(latest(f.calls[1].body),/start_work/);
 assert.equal(task.record.projectOperation,undefined);
 assert.equal(existsSync(join(repo.project,'report.txt')),false);
 assert.equal(task.record.proposal.budgetAtProposal.remainingCalls,0);
});

test('one consumed employee cannot make four missing workers affordable with only two requests remaining',async t=>{
 let main=0;
 const f=await fixture(t,({body})=>{
   if(latest(body).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r2')return {text:'The first completed employee report.'};
   if(++main===1)return tool('delegate',{workId:'first',model:'fixture/r2',assignment:'Investigate one part',reason:'First of five requested workers'});
   if(main===2)return tool('collect',{assignmentId:JSON.parse(body.messages.findLast(message=>message.role==='tool').content).assignmentId});
   return {text:'One employee report consumed; four requested workers remain missing.'};
 });
 const task=await runProjectTurn({...opts(f),input:'Assign five workers to investigate.',budget:{maxCalls:8}});
 assert.equal(task.record.status,'partial',task.record.error);
 assert.equal(main,3,'do not spend a correction request known to be insufficient');
 assert.equal(task.record.collaborationResult[0].evidence.length,1);
 assert.equal(task.record.completionFeedback.status,'not_sent');
 assert.equal(task.record.budget.maxCalls-task.record.rootRequests.filter(row=>!row.notSent).length,2);
 assert.match(task.record.error,/ROOT_BUDGET/);
});

for(const scenario of [
 {input:'What is 2 + 2?',calls:1,status:'completed'},
 {input:'Assign one worker if useful, or answer directly.',calls:1,status:'completed'},
 {input:'Assign one worker to investigate.',calls:2,status:'partial'},
 {input:'Assign one worker to investigate.',budget:{maxCalls:2},calls:1,status:'partial'},
 {input:'Assign one worker to investigate.',reply:{text:'Incomplete',finish:'length'},calls:1},
 {input:'Assign one worker to investigate.',reply:{error:503},calls:1},
])test(`bounded completion: ${scenario.input} ${JSON.stringify(scenario.budget??scenario.reply??scenario.calls)}`,async t=>{
 const f=await fixture(t,()=>scenario.reply??{text:'A direct answer; no worker report.'});
 const task=await runProjectTurn({...opts(f),input:scenario.input,budget:scenario.budget});
 assert.equal(f.calls.length,scenario.calls);
 if(scenario.status)assert.equal(task.record.status,scenario.status,task.record.error);
 else assert.notEqual(task.record.status,'completed');
 if(scenario.calls===2){
   assert.match(task.record.error,/协作承诺/);
   assert.equal(task.record.completionFeedback.status,'completed');
 }
 if(scenario.budget){
   assert.equal(task.record.completionFeedback.status,'not_sent');
   assert.match(task.record.error,/ROOT_BUDGET/);
 }
});

test('cancelled unknown initial answer never sends completion feedback',async t=>{
 const arrived=Promise.withResolvers(),controller=new AbortController();
 const f=await fixture(t,()=>{arrived.resolve();return null;});
 const pending=runProjectTurn({...opts(f),input:'Assign one worker to investigate.',signal:controller.signal});
 await arrived.promise;controller.abort();
 const task=await pending;
 assert.equal(f.calls.length,1);
 assert.equal(task.record.completionFeedback,undefined);
 assert.notEqual(task.record.status,'completed');
});

test('cancelling completion feedback preserves the completed original and unknown follow-up without replay',async t=>{
 const arrived=Promise.withResolvers(),controller=new AbortController();
 const f=await fixture(t,(_,n)=>{
   if(n===1)return {text:'Premature final answer.'};
   arrived.resolve();return null;
 });
 const pending=runProjectTurn({...opts(f),input:'Assign one worker to investigate.',signal:controller.signal});
 await arrived.promise;controller.abort();
 const task=await pending;
 assert.equal(f.calls.length,2);
 assert.equal(task.record.completionFeedback.status,'outcome_unknown');
 const [original,correction]=task.requests();
 assert.equal(original.status,'completed');
 assert.equal(correction.status,'outcome_unknown');
 assert.equal(correction.usage,null);
 assert.deepEqual(task.record.completionFeedback.requestIds,[correction.id]);
});

test('a manager can collect its still-live employee during completion feedback without replaying that employee',async t=>{
 const release=Promise.withResolvers(),started=Promise.withResolvers();
 t.after(()=>release.resolve());
 let main=0,assignmentId;
 const f=await fixture(t,async ({body})=>{
   if(latest(body).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r2'){started.resolve();await release.promise;return {text:'The original employee report.'};}
   if(++main===1)return tool('delegate',{workId:'pending',model:'fixture/r2',assignment:'Investigate',reason:'Explicit request'});
   if(main===2){
     assignmentId=JSON.parse(body.messages.findLast(message=>message.role==='tool').content).assignmentId;
     await started.promise;return {text:'Premature answer before collection.'};
   }
   if(main===3){release.resolve();return tool('collect',{assignmentId});}
   return {text:'Consumed the original employee report.'};
 });
 const task=await runProjectTurn({...opts(f),input:'Assign one worker to investigate.'});
 assert.equal(task.record.status,'completed',task.record.error);
 assert.equal(f.calls.filter(call=>call.body.model==='r2').length,1);
 assert.equal(task.record.collaborationResult[0].status,'fulfilled');
});

for(const response of [{error:503},{text:'Truncated employee report',finish:'length'}])
test(`a known incomplete employee response is not turned into completion feedback: ${JSON.stringify(response)}`,async t=>{
 let main=0;
 const f=await fixture(t,({body})=>{
   if(latest(body).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r2')return response;
   if(++main===1)return tool('delegate',{workId:'failed',model:'fixture/r2',assignment:'Investigate',reason:'Requested work'});
   if(main===2)return tool('collect',{assignmentId:JSON.parse(body.messages.findLast(message=>message.role==='tool').content).assignmentId});
   return {text:'The employee service failed; investigation is unfinished.'};
 });
 const task=await runProjectTurn({...opts(f),input:'Assign one worker to investigate.'});
 assert.equal(task.record.status,'partial',task.record.error);
 assert.equal(main,3);
 assert.equal(f.calls.filter(call=>call.body.model==='r2').length,1);
 assert.equal(task.record.completionFeedback,undefined);
 assert.ok(task.requests().some(call=>response.error?call.httpStatus===503&&call.status==='failed':call.status==='partial'));
});

async function formalOmission(t,{ignore=false,budget,twoSteps=false,scoped=false}={}){
 const repo=repository(t);
 const plan={goal:'Verify files with an employee',scope:['a.txt','b.txt'],collaboration:scoped?{workers:2,stepIds:['first','second']}:{workers:1},
   ...(budget?{budget:{maxCalls:budget}}:{}),
   ...(twoSteps?{steps:[{id:'first',goal:'Verify a',scope:['a.txt'],deliverables:['a.txt'],checks:check('a.txt')},
     {id:'second',goal:'Verify b',dependsOn:['first'],scope:['b.txt'],deliverables:['b.txt'],checks:check('b.txt')}]}:
     {deliverables:['a.txt'],checks:check('a.txt')}),
 };
 const corrected=new Set(),turns=new Map();
 const f=await fixture(t,({body},n)=>{
   if(n===1)return tool('start_work',{action:'start',reason:'Check files with a worker',plan});
   if(latest(body).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r2')return {text:'The requested file exists; original task understood.'};
   if(!body.tools?.some(tool=>tool.function.name==='accept_change'))return {text:'Delivered the checked files.'};
   const messages=JSON.stringify(body.messages);
   const step=twoSteps?(messages.includes('\\"stepId\\":\\"second\\"')?'second':'first'):'main';
   if(latest(body).includes('cothink-completion-feedback'))corrected.add(step);
   if(ignore||!corrected.has(step))return {text:'Files are present; manager stopped without assigning new work.'};
   const path=step==='second'?'b.txt':'a.txt',staffId='reader-'+step;
   const responses=[tool('project_staff',{action:'appoint',input:{id:staffId,responsibility:'Verify '+path,models:['fixture/r2'],scope:[path],need:'deliverable',reason:'Requested independent evidence'}}),
     tool('delegate',{staffId,workId:step+':'+path,model:'fixture/r2',assignment:'Verify '+path+' exists',scope:[],readScope:[path],readOnly:true,reason:'Required employee'}),tool('collect')];
   const turn=turns.get(step)??0;turns.set(step,turn+1);
   return responses[turn]??{text:'Verified the file using the collected employee report.'};
 });
 const base=await projectSession(t,repo,f),source=await runProjectTurn({...base,input:'Verify the files.'});
 const root=await confirmProject(base,source);
 return {f,root,children:root.record.projectOperation.childTaskIds.map(id=>readTask(f.home,id))};
}

test('confirmed file executor corrects omitted staffing before teardown and final strict provenance passes',async t=>{
 const {f,root,children}=await formalOmission(t);
 assert.equal(root.record.status,'completed',root.record.error);
 assert.equal(root.record.collaborationResult[0].status,'fulfilled');
 const [child]=children;
 assert.ok(child.completionFeedback);
 assert.equal(child.members.length,1);
 assert.ok(child.members[0].collected);
 const calls=readRequests(f.home,child),first=calls.find(call=>call.id===child.completionFeedback.sourceRequestId);
 assert.match(first.text,/without assigning/);
 assert.equal(calls.find(call=>call.id===child.completionFeedback.resultRequestId).stageId,first.stageId);
 assert.ok(root.record.collaborationResult[0].evidence[0].checkRequestId);
});

test('a later project step reuses fulfilled project-wide collaboration without new staffing',async t=>{
 const {root,children}=await formalOmission(t,{twoSteps:true});
 assert.equal(root.record.status,'completed',root.record.error);
 assert.equal(children.length,2);
 assert.ok(children[0].completionFeedback);
 assert.equal(children[1].completionFeedback,undefined);
 assert.equal(children[1].members.length,0);
});

test('scoped feedback preserves the sealed requirement and asks each executor only for currently due coverage',async t=>{
 const {root,children}=await formalOmission(t,{twoSteps:true,scoped:true});
 assert.equal(root.record.status,'completed',root.record.error);
 assert.equal(children.flatMap(child=>child.members).length,2);
 const first=children[0].completionFeedback.gaps[0];
 assert.deepEqual(first.requirement.stepIds,['first','second']);
 assert.deepEqual(first.dueStepIds,['first']);
 assert.deepEqual(first.missing,['step_coverage']);
 assert.equal(root.record.collaborationResult[0].evidence.length,2);
});

for(const budget of [undefined,2])test(`formal omitted staffing remains explicit after ${budget?'insufficient budget':'one failed correction'}`,async t=>{
 const {root,children}=await formalOmission(t,{ignore:true,budget});
 assert.equal(root.record.status,'partial',root.record.error);
 assert.match(root.record.error,/协作承诺/);
 const [child]=children;
 assert.equal(child.completionFeedback?.status,budget?'not_sent':'completed');
 if(budget)assert.match(root.record.error,/PROJECT_BUDGET/);
 assert.equal(child.members.length,0);
 assert.equal(readRequests(root.home,child).filter(call=>call.sent&&call.role==='main').length,budget?1:2);
});
