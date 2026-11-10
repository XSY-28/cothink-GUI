import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
import {createGuiController} from '../src/gui-controller.js';
import {saveConfig} from '../src/config.js';
import {createTeamConfig} from '../src/teams.js';
import {readTask} from '../src/task.js';
async function complete(c,id){for(let n=0;n<1000;n++){const task=await c.task(id);if(!['running','preparing','cancelling'].includes(task.status))return task;await new Promise(r=>setTimeout(r,10));}throw Error('task did not settle');}
async function controller(t,f,work){saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,...(work?{work}:{})},'Fixture',randomUUID()));const c=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>c.close());return c;}
test('GUI protocol cutover preserves one root, branch marker and per-turn cap',async t=>{
 const f=await fixture(t),c=await controller(t,f),s=await c.action('session.create',{project:null});
 await assert.rejects(c.action('task.submit',{sessionId:s.id,input:'old',submissionId:'old'}),/协议/);
 const args={sessionId:s.id,input:'question',submissionId:'root',protocolVersion:1,budget:{maxCalls:1}};
 const a=await c.action('task.submit',args),b=await c.action('task.submit',args);assert.equal(a.taskId,b.taskId);
 assert.equal((await complete(c,a.taskId)).status,'completed');assert.equal(f.calls.length,1);
 const turn=(await c.session(s.id)).turns[0];assert.equal(turn.flow,'unified');assert.ok(turn.endedAt);
 await assert.rejects(c.action('session.mode',{sessionId:s.id,mode:'one'}),/移除/);
});
test('two GUI confirmation IDs consume one immutable proposal and open accepted file through root',async t=>{
 const repo=repository(t),plan={goal:'Change a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('changed A'))process.exit(1)"]}]};
 const replies=[{toolCalls:[{name:'start_work',args:{action:'start',reason:'edit',plan}}]},
 {toolCalls:[{name:'read',args:{path:'a.txt'}}]},{toolCalls:[{name:'edit',args:{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}}]},{toolCalls:[{name:'accept_change',args:{}}]},{text:'Changed A'}];
 const f=await fixture(t,(_,n)=>replies[n-1]??{text:'done'}),c=await controller(t,f,{execution});
 const s=await c.action('session.create',{project:repo.project});
 const a=await c.action('task.submit',{sessionId:s.id,input:'Change a.txt',submissionId:'proposal',protocolVersion:1,budget:{maxCalls:7},constraints:{allowedSubtasks:[]}});
 await complete(c,a.taskId);const source=readTask(f.home,a.taskId);
 const editorBefore=await c.session(s.id);
 const nextVersion=(await c.action("project.materials",{ownerId:s.id,source:"saved"})).version;
 const nextOptions={id:randomUUID(),readOnly:true,delegate:false,review:false,maxCalls:'2',readAllowed:true,readPaths:'a.txt',readProject:editorBefore.project,readWorkspaceId:editorBefore.workspaceId,readVersion:nextVersion};
 await c.action('session.draft',{sessionId:s.id,text:'Next turn draft stays here',workRequest:null,selectionId:null,editId:randomUUID(),expectedDraftRevision:editorBefore.draftRevision,branchAnchor:editorBefore.branchAnchor,turnOptions:nextOptions});
 const nextTeam=await c.action('team.save',{name:'Next roster',main:f.models.secondary[1],secondary:[f.models.main]});
 await c.action('session.team',{sessionId:s.id,teamId:nextTeam.id});
 const args={sessionId:s.id,proposalRef:source.proposalRef,protocolVersion:1};
 const [one,two]=await Promise.all([c.action('task.confirmWork',{...args,submissionId:'confirm1'}),c.action('task.confirmWork',{...args,submissionId:'confirm2'})]);
 assert.equal(one.taskId,two.taskId);const result=await complete(c,one.taskId);assert.equal(result.status,'completed',result.error);
 const files=await c.files(one.taskId);assert.equal(files.items[0].ref.taskId,one.taskId);
 const file=await c.file(files.items[0].ref,{purpose:'source'});assert.equal(file.bytes.toString(),'changed A\n');
 const duplicate=await c.action('task.confirmWork',{...args,submissionId:'confirm3'});assert.equal(duplicate.taskId,one.taskId);assert.equal(f.calls.length,5);
 assert.equal(readTask(f.home,one.taskId).budget.maxCalls,6);
 const preserved=await c.session(s.id);assert.equal(preserved.turns.length,2);assert.equal(preserved.draft,'Next turn draft stays here');assert.deepEqual(preserved.editor.turnOptions,nextOptions);assert.equal(preserved.team.id,nextTeam.id);assert.ok(f.calls.every(call=>call.body.model==='main'),'confirmation retains proposal roster');
});

test('reserved confirmation survives host restart and explicit continue uses original root ID',async t=>{
 const {reserveConfirmation}=await import('../src/project-turn.js');const {writePrivateJson}=await import('../src/storage.js');const {join}=await import('node:path');
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]}:{text:'Verified'});
 const c=await controller(t,f,{execution}),s=await c.action('session.create',{project:repo.project});
 const accepted=await c.action('task.submit',{sessionId:s.id,input:'Verify a.txt',submissionId:'source',protocolVersion:1});await complete(c,accepted.taskId);
 await c.close();
 const source=readTask(f.home,accepted.taskId);
 const reservation=await reserveConfirmation({home:f.home,source,proposalRef:source.proposalRef,sessionId:s.id,workspaceId:source.workspace.id,submissionId:'original-confirm',save:()=>writePrivateJson(join(f.home,'tasks',source.id+'.json'),source)});
 const reopened=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>reopened.close());
 await reopened.session(s.id);assert.equal(f.calls.length,1,'observation never resumes');
 const continued=await reopened.action('task.confirmWork',{sessionId:s.id,submissionId:'explicit-continue',proposalRef:source.proposalRef,protocolVersion:1});
 assert.equal(continued.taskId,reservation.taskId);assert.equal((await complete(reopened,continued.taskId)).status,'completed');assert.equal(f.calls.length,2);
 assert.equal(readTask(f.home,continued.taskId).submissionId,'original-confirm');
});

test('resume inherits completed delivery without charging or reparenting old children',async t=>{
 const {digest}=await import('../src/project-turn.js');
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};
 let planRef;
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]}:n===3?{toolCalls:[{name:'start_work',args:{action:'resume',reason:'continue saved project',planRef}}]}:{text:'Verified'});
 const c=await controller(t,f,{execution}),s=await c.action('session.create',{project:repo.project});
 const submit=async id=>{const r=await c.action('task.submit',{sessionId:s.id,input:id,submissionId:id,protocolVersion:1,...(id==='resume'?{budget:{maxCalls:1}}:{})});await complete(c,r.taskId);return readTask(f.home,r.taskId);};
 const confirm=async source=>{const r=await c.action('task.confirmWork',{sessionId:s.id,proposalRef:source.proposalRef,submissionId:randomUUID(),protocolVersion:1});await complete(c,r.taskId);return readTask(f.home,r.taskId);};
 const firstProposal=await submit('initial'),first=await confirm(firstProposal),childId=first.projectOperation.childTaskIds[0];
 planRef={taskId:firstProposal.id,field:'proposal',sha256:digest(firstProposal.proposal)};
 const resumed=await submit('resume');
 assert.equal(resumed.proposal.budgetAtProposal.remainingCalls,0);
 assert.equal(resumed.status,'completed',resumed.error);assert.equal(f.calls.length,3);assert.deepEqual(resumed.projectOperation.childTaskIds,[]);assert.equal(resumed.deliveryRef.sources[0].relation,'inherited');
 assert.equal(readTask(f.home,childId).rootTaskId,first.id);assert.equal(resumed.usage.calls,1);assert.match((await c.session(s.id)).turns.find(turn=>turn.taskId===first.id).finalText,/Verified/);
});

test('cancelling a formal root drains its child and later chat does not resume paused work',async t=>{
 const {projectChatState}=await import('../src/project.js');const {digest}=await import('../src/project-turn.js');let resumeRef;
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};let entered;
 const inChild=new Promise(resolve=>entered=resolve);
 const f=await fixture(t,async(_,n)=>{if(n===1)return {toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]};if(n===2){entered();await new Promise(r=>setTimeout(r,600));}if(n===3)return {toolCalls:[{name:'start_work',args:{action:'resume',reason:'model proposes continuing during explanation',planRef:resumeRef}}]};return {text:'ordinary answer'};});
 const c=await controller(t,f,{execution}),s=await c.action('session.create',{project:repo.project});
 const p=await c.action('task.submit',{sessionId:s.id,input:'verify',submissionId:'plan',protocolVersion:1});await complete(c,p.taskId);
 const source=readTask(f.home,p.taskId);resumeRef={taskId:source.id,field:'proposal',sha256:digest(source.proposal)};const root=await c.action('task.confirmWork',{sessionId:s.id,proposalRef:source.proposalRef,submissionId:'execute',protocolVersion:1});await inChild;
 await c.action('task.cancel',{taskId:root.taskId});await complete(c,root.taskId);
 for(let n=0;n<100&&(await c.bootstrap()).active;n++)await new Promise(r=>setTimeout(r,10));
 const saved=readTask(f.home,root.taskId),child=readTask(f.home,saved.projectOperation.childTaskIds[0]);
 assert.ok(saved.cancelSettledAt);assert.ok(child.cancelSettledAt);assert.equal((await projectChatState(f.home,repo.project)).state.status,'paused');
 const chat=await c.action('task.submit',{sessionId:s.id,input:'Explain the current state',submissionId:'chat',protocolVersion:1});assert.equal((await complete(c,chat.taskId)).status,'blocked');assert.ok(readTask(f.home,chat.taskId).proposalRef,'paused work needs a fresh explicit confirmation even when the model requests resume');
 assert.equal((await projectChatState(f.home,repo.project)).state.status,'paused');assert.equal(f.calls.length,3);
});

test('an inherited visible plan in a GUI fork needs new confirmation and keeps the formal ref',async t=>{
 const {digest}=await import('../src/project-turn.js');
 const repo=repository(t),plan={goal:'Verify a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};let planRef;
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'start_work',args:{action:'start',reason:'verify',plan}}]}:n===3?{toolCalls:[{name:'start_work',args:{action:'resume',reason:'continue inherited plan',planRef}}]}:{text:'Verified'});
 const c=await controller(t,f,{execution}),s=await c.action('session.create',{project:repo.project});
 const submit=async(sessionId,input)=>{const r=await c.action('task.submit',{sessionId,input,submissionId:randomUUID(),protocolVersion:1});await complete(c,r.taskId);return readTask(f.home,r.taskId);};
 const confirm=async(sessionId,source)=>{const r=await c.action('task.confirmWork',{sessionId,submissionId:randomUUID(),proposalRef:source.proposalRef,protocolVersion:1});await complete(c,r.taskId);return readTask(f.home,r.taskId);};
 const first=await confirm(s.id,await submit(s.id,'initial'));
 const fork=await c.action('session.fork',{sessionId:s.id,taskId:first.id});
 planRef={taskId:first.id,field:'proposal',sha256:digest(first.proposal)};
 const pending=await submit(fork.id,'continue inherited plan');assert.equal(pending.status,'blocked');assert.ok(pending.proposalRef);assert.equal(f.calls.length,3);
 const result=await confirm(fork.id,pending);assert.equal(result.status,'completed',result.error);assert.equal(result.executionBinding.formalRef,first.executionBinding.formalRef);assert.equal(result.deliveryRef.sources[0].relation,'inherited');assert.equal(f.calls.length,3);
});

test('legacy editor read choice requires reselection before a model request, and the selected version can send',async t=>{
 const {editorTurnInput}=await import('../src/gui-turn-options.js');
 const f=await fixture(t),repo=repository(t),c=await controller(t,f);
 let session=await c.action('session.create',{project:repo.project});
 const input='Use the fixed project file';
 const legacy={id:randomUUID(),readAllowed:true,readPaths:'a.txt',readProject:session.project,readWorkspaceId:session.workspaceId};
 const location={project:session.project,workspaceId:session.workspaceId};
 const save=async turnOptions=>c.action('session.draft',{sessionId:session.id,text:input,workRequest:null,selectionId:null,
  editId:randomUUID(),expectedDraftRevision:session.draftRevision,branchAnchor:session.branchAnchor,turnOptions});
 session=await save(legacy);
 const request={sessionId:session.id,input,submissionId:randomUUID(),protocolVersion:1,editorEditId:session.editor.editId,readAuthorization:{paths:['a.txt']}};
 assert.throws(()=>editorTurnInput(session.editor.turnOptions,location),/重新选择项目文件/);
 await assert.rejects(c.action('task.submit',request),{code:'READ_VERSION'});
 assert.equal(f.calls.length,0);
 assert.equal((await c.session(session.id)).editor.editId,request.editorEditId);
 const {version}=await c.action('project.materials',{ownerId:session.id,source:'saved'});
 session=await save({...legacy,id:randomUUID(),readVersion:version});
 const selected=editorTurnInput(session.editor.turnOptions,location);
 const accepted=await c.action('task.submit',{...request,submissionId:randomUUID(),editorEditId:session.editor.editId,...selected});
 assert.equal((await complete(c,accepted.taskId)).status,'completed');
 assert.equal(readTask(f.home,accepted.taskId).readAuthorization.version,version);
 assert.equal(f.calls.length,1);
});
