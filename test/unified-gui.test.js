import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import { fixtureConversation, prepareSubmit, seedFixtureConversationRepository, submitDraft } from './helpers/gui-controller-fixture.js';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
import {createGuiController} from '../src/gui-controller.js';
import {readTask} from '../src/task.js';
import { complete, controller } from "./unified-gui.fixture.js";

test('new submission requires the current saved editor before a model request',async t=>{
 const f=await fixture(t),c=await controller(t,f),s=await fixtureConversation(t,c);
 await assert.rejects(c.action('task.submit',{sessionId:s.id,input:'unsaved',submissionId:'bare',protocolVersion:1}),{code:'DRAFT_CONFLICT'});
 assert.equal(f.calls.length,0);
});
test('GUI protocol cutover preserves one root, branch marker and per-turn cap',async t=>{
 const f=await fixture(t),c=await controller(t,f),s=await fixtureConversation(t,c);
 await assert.rejects(c.action('task.submit',{sessionId:s.id,input:'old',submissionId:'old'}),/协议/);
 const args=await prepareSubmit(c,{sessionId:s.id,input:'question',submissionId:'root',budget:{maxCalls:1}});
 const a=await c.action('task.submit',args),b=await c.action('task.submit',args);assert.equal(a.taskId,b.taskId);
 assert.equal((await complete(c,a.taskId)).status,'completed');assert.equal(f.calls.length,1);
 const turn=(await c.session(s.id)).turns[0];assert.equal(turn.flow,'unified');assert.ok(turn.endedAt);
 await assert.rejects(c.action('session.mode',{sessionId:s.id,mode:'one'}),/移除/);
});
function twoVerifiedFiles() {
 return {goal:'Verify both files',scope:['a.txt','b.txt'],steps:['a','b'].map(id=>({id,goal:`Verify ${id}.txt`,scope:[`${id}.txt`],deliverables:[`${id}.txt`],dependsOn:id==='b'?['a']:[],checks:[{command:'node',args:['-e',`require('fs').accessSync('${id}.txt')`]}]}))};
}
test('a verified multi-step delivery gets one manager report and follows the selected conversation endpoint',async t=>{
 const repo=repository(t),plan=twoVerifiedFiles();
 const replies=[{toolCalls:[{name:'start_work',args:{action:'start',reason:'PROPOSAL_PROCESS_SENTINEL',plan}}]}, {text:'STEP_REPORT_A'}, {text:'STEP_REPORT_B'}, {text:'ADOPTED_MANAGER_REPORT'}, {text:'LATER_REPLY_SENTINEL'}, {text:'FORK_REPLY'}];
 let rootId;const toolResult=call=>JSON.parse(call.body.messages.findLast(message=>message.role==='tool').content);
 const f=await fixture(t,(call,n)=>{
   if(n===7)return {toolCalls:[{name:'search_context',args:{purpose:'attribution',taskId:rootId,query:'manager-final'}}]};
   if(n===8)return {toolCalls:[{name:'read_context',args:{purpose:'attribution',ref:toolResult(call).items[0].ref}}]};
   return replies[n-1]??{text:'The process facts confirm the manager.'};
 });
 const path=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
 for(const model of catalog.providers.fixture.models)model.reasoning=true;
 writeFileSync(path,JSON.stringify(catalog));
 const c=await controller(t,f,{execution});
 const s=seedFixtureConversationRepository(repo.project,await fixtureConversation(t,c));
 await c.action('session.thinking',{sessionId:s.id,level:'low',scope:'all'});
 const submit=(c,sessionId,input,budget)=>submitDraft(c,{sessionId,input,submissionId:randomUUID(),protocolVersion:1,budget});
 const proposed=await submit(c,s.id,'Verify both actual files',{maxCalls:4});await complete(c,proposed.taskId);
 await c.action('session.thinking',{sessionId:s.id,level:'high',scope:'all'});
 const root=await c.action('task.confirmWork',{sessionId:s.id,proposalRef:readTask(f.home,proposed.taskId).proposalRef,submissionId:randomUUID(),protocolVersion:1});
 rootId=root.taskId;
 const delivered=await complete(c,root.taskId);
 assert.equal(delivered.status,'completed',delivered.error);
 assert.equal(f.calls.length,4);
 assert.equal(f.calls[3].body.model,'main');assert.ok(!f.calls[3].body.tools?.length);
 assert.ok(f.calls.every(call=>call.body.reasoning_effort==='low'),'both executors and manager synthesis inherit the proposal snapshot');
 assert.equal(readTask(f.home,root.taskId).stages.find(stage=>stage.phase==='manager-final').modelRef.thinkingLevel,'low');
 const synthesis=JSON.stringify(f.calls[3].body.messages);
 assert.match(synthesis,/Verify both actual files/);assert.match(synthesis,/STEP_REPORT_A/);assert.match(synthesis,/STEP_REPORT_B/);
 const original=await c.session(s.id);
 assert.equal(original.turns.find(turn=>turn.taskId===root.taskId).finalText,'ADOPTED_MANAGER_REPORT');
 assert.equal((await c.files(root.taskId)).items.length,2);
 await c.close();const reopened=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>reopened.close());
 const next=await submit(reopened,s.id,'Continue the delivery');assert.equal((await complete(reopened,next.taskId)).status,'completed');
 const fork=await reopened.action('session.fork',{sessionId:s.id,taskId:root.taskId});
 const forkTurn=await submit(reopened,fork.id,'Continue on the branch');assert.equal((await complete(reopened,forkTurn.taskId)).status,'completed');
 for(const request of f.calls.slice(4)){
   assert.equal(request.body.reasoning_effort,'high','explicit new turns and their branches use the current conversation selection');
   const messages=JSON.stringify(request.body.messages);
   assert.match(messages,/Verify both actual files/);
   assert.ok(request.body.messages.some(message=>['system','developer'].includes(message.role)&&message.content.includes('conversation manager')));
   assert.equal((messages.match(/ADOPTED_MANAGER_REPORT/g)??[]).length,1);
   assert.doesNotMatch(messages,/PROPOSAL_PROCESS_SENTINEL|STEP_REPORT_[AB]|LATER_REPLY_SENTINEL|savedPlanRef/);
 }
 const attribution=await submit(reopened,fork.id,'Who wrote the final report? Check the actual request.');
 assert.equal((await complete(reopened,attribution.taskId)).status,'completed');
 assert.equal(f.calls.length,9);
 const facts=JSON.parse(toolResult(f.calls[8]).text),manager=facts.roles.find(role=>role.phase==='manager-final');
 assert.equal(facts.taskId,rootId);assert.equal(manager.role,'main');
 assert.deepEqual(manager.model,{provider:'fixture',modelId:'main'});
 assert.equal(manager.requestId,readTask(f.home,rootId).finalCallId);
 assert.doesNotMatch(JSON.stringify(facts),/PROPOSAL_PROCESS_SENTINEL|STEP_REPORT_[AB]|fixture-secret/);
});

for(const missing of ['budget','unknown'])test(`missing manager report (${missing}) retains checked files without replay`,async t=>{
 const repo=repository(t),plan=twoVerifiedFiles();
 const f=await fixture(t,(_,n,_request,response)=>{
   if(n===1)return {toolCalls:[{name:'start_work',args:{action:'start',reason:'Verify',plan}}]};
   if(n<4)return {text:n===2?'STEP_REPORT_A':'STEP_REPORT_B'};
   response.destroy();return null;
 });
 const path=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
 for(const model of catalog.providers.fixture.models)model.reasoning=true;
 writeFileSync(path,JSON.stringify(catalog));
 const c=await controller(t,f,{execution});
 const session=seedFixtureConversationRepository(repo.project,await fixtureConversation(t,c));
 await c.action('session.thinking',{sessionId:session.id,level:'low',scope:'all'});
 const source=await submitDraft(c,{sessionId:session.id,input:'Verify both files',submissionId:randomUUID(),protocolVersion:1,budget:{maxCalls:missing==='budget'?3:4}});
 await complete(c,source.taskId);
 const args={sessionId:session.id,proposalRef:readTask(f.home,source.taskId).proposalRef,submissionId:randomUUID(),protocolVersion:1};
 const root=await c.action('task.confirmWork',args),result=await complete(c,root.taskId);
 assert.equal(result.status,missing==='budget'?'partial':'outcome_unknown',result.error);
 assert.match(result.error,/缺少经理终稿/);
 assert.equal(f.calls.length,missing==='budget'?3:4);
 assert.equal(readTask(f.home,root.taskId).finalCallId,null);
 await c.action('session.thinking',{sessionId:session.id,level:'high',scope:'all'});
 await c.close();const reopened=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>reopened.close());
 const fileList=await reopened.files(root.taskId);
 assert.deepEqual(fileList.items.map(file=>file.name),['a.txt','b.txt']);
 assert.equal((await reopened.file(fileList.items[1].ref,{purpose:'source'})).bytes.toString(),'base B\n');
 const turn=(await reopened.session(session.id)).turns.find(turn=>turn.taskId===root.taskId);
 assert.match(turn.finalText,/STEP_REPORT_A[\s\S]*STEP_REPORT_B/);
 assert.equal((await reopened.action('task.confirmWork',args)).taskId,root.taskId);
 assert.equal(f.calls.length,missing==='budget'?3:4);
 assert.ok(f.calls.every(call=>call.body.reasoning_effort==='low'),'recovery observes the original attempt without sending again at the new selection');
 assert.equal(readTask(f.home,root.taskId).frozenConfig.main.thinkingLevel,'low');
});

test('resume inherits completed delivery without charging or reparenting old children',async t=>{
 const {digest}=await import('../src/project-turn.js');
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};
 let planRef;
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]}:n===3?{toolCalls:[{name:'start_work',args:{action:'resume',reason:'continue saved project',planRef}}]}:{text:'Verified'});
 const catalogPath=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(catalogPath,'utf8'));
 for(const model of catalog.providers.fixture.models)model.reasoning=true;
 writeFileSync(catalogPath,JSON.stringify(catalog));
 const c=await controller(t,f,{execution}),s=seedFixtureConversationRepository(repo.project,await fixtureConversation(t,c));
 await c.action('session.thinking',{sessionId:s.id,level:'low',scope:'all'});
 const submit=async id=>{const r=await submitDraft(c,{sessionId:s.id,input:id,submissionId:id,protocolVersion:1,...(id==='resume'?{budget:{maxCalls:1}}:{})});await complete(c,r.taskId);return readTask(f.home,r.taskId);};
 const confirm=async source=>{const r=await c.action('task.confirmWork',{sessionId:s.id,proposalRef:source.proposalRef,submissionId:randomUUID(),protocolVersion:1});await complete(c,r.taskId);return readTask(f.home,r.taskId);};
 const firstProposal=await submit('initial'),first=await confirm(firstProposal),childId=first.projectOperation.childTaskIds[0];
 planRef={taskId:firstProposal.id,field:'proposal',sha256:digest(firstProposal.proposal)};
 await c.action('session.thinking',{sessionId:s.id,level:'high',scope:'all'});
 const resumed=await submit('resume');
 assert.equal(resumed.proposal.budgetAtProposal.remainingCalls,0);
 assert.equal(resumed.status,'completed',resumed.error);assert.equal(f.calls.length,3);assert.deepEqual(resumed.projectOperation.childTaskIds,[]);assert.equal(resumed.deliveryRef.sources[0].relation,'inherited');
 assert.equal(readTask(f.home,childId).rootTaskId,first.id);assert.equal(resumed.usage.calls,1);assert.match((await c.session(s.id)).turns.find(turn=>turn.taskId===first.id).finalText,/Verified/);
 assert.equal(readTask(f.home,childId).models.main.thinkingLevel,'low','inherited child retains its original configuration');
 assert.equal(resumed.models.main.thinkingLevel,'high','explicit resume uses the newly selected task configuration');
 assert.deepEqual(f.calls.map(call=>call.body.reasoning_effort),['low','low','high']);
 await submit('follow-up after reuse');
 assert.equal(f.calls.length,4);
 assert.equal(f.calls[3].body.messages.filter(message=>message.role==='assistant'&&message.content==='Verified').length,1);
});

test('cancelling a formal root drains its child and later chat does not resume paused work',async t=>{
 const {projectChatState}=await import('../src/project.js');const {digest}=await import('../src/project-turn.js');let resumeRef;
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};let entered;
 const inChild=new Promise(resolve=>entered=resolve);
 const f=await fixture(t,async(_,n)=>{if(n===1)return {toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]};if(n===2){entered();await new Promise(r=>setTimeout(r,600));}if(n===3)return {toolCalls:[{name:'start_work',args:{action:'resume',reason:'model proposes continuing during explanation',planRef:resumeRef}}]};return {text:'ordinary answer'};});
 const c=await controller(t,f,{execution}),s=seedFixtureConversationRepository(repo.project,await fixtureConversation(t,c));
 const p=await submitDraft(c,{sessionId:s.id,input:'verify',submissionId:'plan',protocolVersion:1});await complete(c,p.taskId);
 const source=readTask(f.home,p.taskId);resumeRef={taskId:source.id,field:'proposal',sha256:digest(source.proposal)};const root=await c.action('task.confirmWork',{sessionId:s.id,proposalRef:source.proposalRef,submissionId:'execute',protocolVersion:1});await inChild;
 await c.action('task.cancel',{taskId:root.taskId});await complete(c,root.taskId);
 for(let n=0;n<100&&(await c.bootstrap()).active;n++)await new Promise(r=>setTimeout(r,10));
 const saved=readTask(f.home,root.taskId),child=readTask(f.home,saved.projectOperation.childTaskIds[0]);
 assert.ok(saved.cancelSettledAt);assert.ok(child.cancelSettledAt);assert.equal((await projectChatState(f.home,s.project)).state.status,'paused');
 const chat=await submitDraft(c,{sessionId:s.id,input:'Explain the current state',submissionId:'chat',protocolVersion:1});assert.equal((await complete(c,chat.taskId)).status,'blocked');assert.ok(readTask(f.home,chat.taskId).proposalRef,'paused work needs a fresh explicit confirmation even when the model requests resume');
 assert.equal((await projectChatState(f.home,s.project)).state.status,'paused');assert.equal(f.calls.length,3);
});

test('a GUI fork can see inherited work but cannot execute a plan in the source folder',async t=>{
 const {digest}=await import('../src/project-turn.js');
 const {projectChatState}=await import('../src/project.js');
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};let planRef;
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]}:n===3?{toolCalls:[{name:'start_work',args:{action:'resume',reason:'continue inherited plan',planRef}}]}:{text:'Verified'});
 const c=await controller(t,f,{execution}),s=seedFixtureConversationRepository(repo.project,await fixtureConversation(t,c));
 const submit=async(sessionId,input)=>{const r=await submitDraft(c,{sessionId,input,submissionId:randomUUID(),protocolVersion:1});await complete(c,r.taskId);return readTask(f.home,r.taskId);};
 const confirm=async(sessionId,source)=>{const r=await c.action('task.confirmWork',{sessionId,submissionId:randomUUID(),proposalRef:source.proposalRef,protocolVersion:1});await complete(c,r.taskId);return readTask(f.home,r.taskId);};
 const first=await confirm(s.id,await submit(s.id,'initial'));
 const fork=await c.action('session.fork',{sessionId:s.id,taskId:first.id});
 planRef={taskId:first.id,field:'proposal',sha256:digest(first.proposal)};
 const pending=await submit(fork.id,'continue inherited plan');assert.notEqual(fork.project,s.project);
 assert.ok(fork.turns.some(turn=>turn.taskId===first.id));
 assert.match(pending.workPlanError.message,/Saved plan does not belong/);
 assert.equal(pending.proposalRef,undefined);assert.equal(f.calls.length,4,'manager can still give an explanation after the rejection');
 assert.equal((await projectChatState(f.home,s.project)).state.version,first.deliveryRef.version);
});
