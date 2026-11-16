import test from 'node:test';import assert from 'node:assert/strict';
import{fixture}from'./helpers/pi-fixture.js';import{repository}from'./helpers/git-fixture.js';import{projectSession,confirmProject}from'./unified-project.fixture.js';import{runProjectTurn}from'../src/project-turn.js';import{readTask,readRequests}from'../src/task.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
for(const mode of ['settle','tool-only','user-stop','credit'])test('network quiesce with '+mode,{timeout:20000},async t=>{
const plan={goal:'Inspect A and B',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e','process.exit(0)']}]};
let activeRoot;let leader=0,releaseReviewer,reviewStarted,failed=false,callsAtFailure;const started=new Promise(r=>reviewStarted=r),release=new Promise(r=>releaseReviewer=r);
const replies=[tool('read',{path:'a.txt'}),tool('project_staff',{action:'appoint',input:{id:'reader',responsibility:'Read b.txt',models:['fixture/r2'],scope:['b.txt'],need:'deliverable',reason:'Independent observation'}}),tool('delegate',{staffId:'reader',workId:'main:a.txt',model:'fixture/r2',assignment:'Inspect b.txt',scope:[],readScope:['a.txt','b.txt'],readOnly:true,reason:'Independent observation'})];
const f=await fixture(t,async({body},n,req,res)=>{
assert.equal(failed,false,'No new HTTP after unknown');
if(n===1)return tool('start_work',{action:'start',reason:'bounded collaboration',plan});
const raw=JSON.stringify(body.messages.findLast(m=>m.role==='user')?.content);
if(raw.includes('cothink-process-observation'))return{text:'{"issues":[]}'};
if(body.model==='r2'){
 if(raw.includes('Independent task preparation'))return{text:'Read-only task understood.'};
 if(!body.messages.some(m=>m.role==='tool'))return tool('read',{path:'b.txt'});
 reviewStarted();await release;if(mode==='credit'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({error:{code:'credit_balance_exhausted',message:'No credits'}})+'\n\ndata: [DONE]\n\n');return null;}return mode==='tool-only'?tool('read',{path:'a.txt'}):{text:'Read b.txt; no writes.'};
}
if(leader<replies.length)return replies[leader++];
await started;failed=true;callsAtFailure=f.calls.length;res.destroy();setTimeout(()=>{if(mode==='user-stop')void activeRoot.cancel();else releaseReviewer();},100);if(mode==='user-stop')setTimeout(releaseReviewer,500);return null;
});
const base=await projectSession(t,repository(t),f),proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:40}});
const root=await confirmProject(base,proposal,{onTaskCreated(root){activeRoot=root;}});
const saved=readTask(f.home,root.record.id),requests=[saved,...saved.projectOperation.childTaskIds.map(id=>readTask(f.home,id))].flatMap(r=>readRequests(f.home,r));
assert.ok(failed);assert.equal(f.calls.length,callsAtFailure);assert.ok(saved.localExecutionClosedAt);
const unknown=requests.filter(r=>r.sent&&r.status==='outcome_unknown');assert.ok(unknown.some(r=>r.actualModel.modelId==='main'&&r.usage===null));assert.ok(saved.networkQuiesce);if(mode==='settle')assert.equal(unknown.length,1);if(mode==='credit')assert.ok(saved.providerCreditStop);if(mode==='user-stop')assert.ok(saved.cancelRequestedAt);
if(mode==='tool-only')assert.ok(saved.projectOperation.childTaskIds.map(id=>readTask(f.home,id)).every(r=>r.members.every(m=>m.status!=='completed')));
if(mode==='settle')assert.ok(requests.some(r=>r.actualModel?.modelId==='r2'&&r.status==='completed'&&r.text==='Read b.txt; no writes.'&&r.usage));
});
