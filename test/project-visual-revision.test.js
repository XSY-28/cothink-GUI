import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVisualRevision} from '../src/project-visual-revision.js';
import {digest} from '../src/project-collaboration-evidence.js';
import {assertContinuationIntents} from '../src/project-continuation-reservation.js';
function fixture(){
 const review={verdict:'uncertain',status:'completed',requestId:'q',integrationVersion:'v',imageHashes:['hash'],observation:'Visible page',reasons:'Missing final view'};
 const evidence={outputRef:'o',result:'captured',contentUnchanged:true,integrationVersion:'v',images:[{sha256:'hash'}],imageRequestId:'q',reviewedRequestId:'q',review};
 const prior={taskId:'root',requestId:'q',outputRef:'o',basis:{version:'v',revision:1},error:'uncertain'};prior.basisDigest=digest(prior.basis);
 const state={revision:1,version:'v',steps:[{status:'completed'}],delivery:{version:'v',revision:1,visual:prior}};
 const source={id:'root',localExecutionClosedAt:'closed',deliveryRef:{version:'v',visualDigest:digest(prior)},frozenConfig:{main:{provider:'fixture',modelId:'main'}},work:{visualEvidence:[evidence]},stages:[{id:'s',phase:'visual-review',callIds:['q'],sessionId:'session'}],rootRequests:[{requestId:'q',taskId:'root',stageId:'s',sessionId:'session',status:'completed'}]};
 const call={taskId:'root',stageId:'s',phase:'visual-review',status:'completed',sent:true,endedAt:'ended',actualModel:{provider:'fixture',modelId:'main'},transport:{projectDispatched:true},visualEvidence:{outputRef:'o',digest:prior.basisDigest,imageHashes:['hash']},response:{content:[{type:'toolCall',name:'submit_visual_review',arguments:{verdict:'uncertain',observation:review.observation,reasons:review.reasons}}]}};
 const visualRevision={sourceRequestId:'q',formalVersion:'v',reason:'Capture missing final view',capturePlan:[{script:'tests/capture.cjs',args:['--view=mobile'],label:'Mobile'}]};
 const deps={resolveDeliveryEvidence:()=>({visualError:'uncertain',visualSource:source}),readRequest:()=>call,readVisualFrame:()=>Buffer.from('verified')};
 const run=()=>inspectVisualRevision({home:'home',state,source,formalVersion:'v',visualRevision},deps);
 return {state,source,call,evidence,visualRevision,deps,run};
}
test('explicit final visual evidence preserves existing completed steps and uncertain receipt',()=>{const f=fixture(),before={source:structuredClone(f.source),state:structuredClone(f.state)};assert.equal(f.run(),true);assert.deepEqual(f.source,before.source);assert.deepEqual(f.state,before.state);});
for(const [name,change] of [
 ['no reason',f=>f.visualRevision.reason=''],['wrong old request',f=>f.visualRevision.sourceRequestId='wrong'],
 ['different formal',f=>f.visualRevision.formalVersion='other'],['extra authority',f=>f.visualRevision.scope=['*']],
 ['unfinished step',f=>f.state.steps[0].status='blocked'],['changed delivery',f=>f.state.delivery.version='other'],
 ['not closed',f=>delete f.source.localExecutionClosedAt],['cancelled',f=>f.source.cancelRequestedAt='now'],
 ['missing delivery proof',f=>f.deps.resolveDeliveryEvidence=()=>null],['foreign visual owner',f=>f.deps.resolveDeliveryEvidence=()=>({visualError:'err',visualSource:{id:'other'}})],
 ['unknown old call',f=>f.call.status='outcome_unknown'],['partial old call',f=>f.call.status='partial'],['unsent',f=>f.call.sent=false],
 ['unregistered dispatch',f=>f.call.transport.projectDispatched=false],['wrong actual model',f=>f.call.actualModel.modelId='other'],
 ['mismatch is not uncertain',f=>f.evidence.review.verdict='mismatch'],['fabricated uncertain',f=>f.call.response.content[0].arguments.verdict='match'],
 ['changed actual reason',f=>f.call.response.content[0].arguments.reasons='forged'],['changed image hash',f=>f.call.visualEvidence.imageHashes=['other']],
 ['image bytes invalid',f=>f.deps.readVisualFrame=()=>{throw Error('bad image');}],
 ['no capture',f=>f.visualRevision.capturePlan=[]],['shell command',f=>f.visualRevision.capturePlan=[{command:'curl secret',label:'bad'}]],
])test('final visual intent rejects '+name,()=>{const f=fixture();change(f);assert.throws(f.run);});
test('reserved visual intention cannot be replaced or removed',()=>{const f=fixture(),source={fileContinuationIntent:{continuation:{visualRevision:f.visualRevision}}};assertContinuationIntents(source,{visualRevision:f.visualRevision});assert.throws(()=>assertContinuationIntents(source,{}));assert.throws(()=>assertContinuationIntents(source,{visualRevision:{...f.visualRevision,reason:'different'}}));});

test('final-only participation refuses any intervening formal or step change',async()=>{
 const {finalVisualCandidates}=await import('../src/project-final-visual-participation.js');
 const state={version:'formal',steps:[{id:'complete',status:'completed',attempts:[{taskId:'old'}]}]};
 const evidence={version:'formal',stepsDigest:digest(state.steps),candidates:[{memberId:'old-verified-member'}]};
 assert.deepEqual(finalVisualCandidates(evidence,state),evidence.candidates);
 assert.throws(()=>finalVisualCandidates(evidence,{...state,version:'changed'}),{code:'FINAL_VISUAL_SOURCE'});
 assert.throws(()=>finalVisualCandidates(evidence,{...state,steps:[{...state.steps[0],status:'pending'}]}),{code:'FINAL_VISUAL_SOURCE'});
 assert.throws(()=>finalVisualCandidates(null,state),{code:'FINAL_VISUAL_SOURCE'});
});
