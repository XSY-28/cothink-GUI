import {test} from 'node:test';
import assert from 'node:assert/strict';
import {savedInput} from '../src/project-saved-input.js';
function fixture(){
 const policy={id:'p',digest:'d'},state={id:'p',repo:'/repo',integrationRef:'main'};
 const attempt={taskId:'t',rootTaskId:'r',submissionId:'s',commandId:'cmd',startVersion:'v0',checkPolicy:policy};
 const step={id:'step',scope:['a'],checks:[],attempts:[attempt]};
 const changes=[{changeId:'w1',actor:'main',readOnly:false,baseVersion:'v0',scope:['a'],readScope:['a']},{changeId:'w2',actor:'main',readOnly:false,baseVersion:'v1',scope:['a'],readScope:['a']},{changeId:'input',actor:'main',readOnly:true,baseVersion:'v2',privateVersion:'v2'}];
 const acceptance=[1,2].map(i=>({requestId:'accept'+i,changeId:'w'+i,status:'accepted',verification:'passed',candidateVersion:'c'+i,expectedTip:'v'+(i-1),acceptedVersion:'v'+i,checkPolicy:policy}));
 const record={id:'t',rootTaskId:'r',submissionId:'s',localExecutionClosedAt:'now',project:{id:'p',stepId:'step',commandId:'cmd',scope:['a'],checks:[]},work:{root:'/repo',integrationRef:'main',startVersion:'v0',resultChangeId:'input',changes,acceptance,requests:acceptance.map(r=>({...r,action:'acceptChange',dispatched:true}))}};
 const facts=Object.fromEntries(changes.map((c,i)=>[c.changeId,{...c,actor:i===2?'result':c.actor,status:i===2?'interrupted':'accepted',executionState:i===1?'absent':'stopped',...(i<2?{acceptedVersion:'v'+(i+1)}:{})}]));
 const receipts=structuredClone(Object.fromEntries(acceptance.map(a=>[a.requestId,a])));
 const v={inspect:async q=>structuredClone(q.changeId?facts[q.changeId]:receipts[q.requestId])};
 return {state,step,record,facts,receipts,run:()=>savedInput(state,step,record,v,'v2')};
}
test('closed accepted chain exposes exact formal readonly input only',async()=>{assert.deepEqual(await fixture().run(),{taskId:'t',changeId:'input',baseVersion:'v2',version:'v2'});});
const cases={
 'unaccepted writer':f=>f.facts.w1.status='abandoned',
 'active writer':f=>f.facts.w1.executionState='running',
 'active readonly':f=>f.facts.input.executionState='running',
 'open task':f=>delete f.record.localExecutionClosedAt,
 'cleanup failed':f=>f.record.work.cleanupErrors=['failed'],
 'wrong receipt change':f=>f.receipts.accept1.changeId='other',
 'wrong candidate':f=>f.receipts.accept1.candidateVersion='other',
 'unverified accept':f=>f.receipts.accept1.verification='failed',
 'unknown accept':f=>f.receipts.accept1.status='outcome_unknown',
 'wrong policy':f=>f.receipts.accept1.checkPolicy.digest='other',
 'wrong formal':f=>f.facts.w2.acceptedVersion='other',
 'broken parent':f=>{f.receipts.accept2.expectedTip='other';f.record.work.acceptance[1].expectedTip='other';},
 'missing dispatch':f=>f.record.work.requests[0].dispatched=false,
 'different project':f=>f.record.project.id='other',
 'wrong scope':f=>f.facts.w1.scope=['other'],
 'input drift':f=>f.facts.input.privateVersion='other',
 'unbound result actor':f=>f.record.work.resultChangeId='other',
 'wrong input identity':f=>f.facts.input.changeId='other',
};
for(const [name,mutate] of Object.entries(cases))test(name,async()=>{const f=fixture();mutate(f);assert.equal(await f.run(),null);});
test('existing pure readonly input remains valid',async()=>{const f=fixture();f.record.work.changes=f.record.work.changes.slice(-1);assert.equal((await f.run()).version,'v2');});
