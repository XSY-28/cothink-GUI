import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import { frozenInputFixture, opts } from "./unified-turn.fixture.js";

test('attachment-only unified turn sends the image and attributed text only to the main model',async t=>{
 const {f,image,text}=await frozenInputFixture(t,undefined,['main']);
 const {payloadImageHashes}=await import('../src/visual-preview.js');
 const task=await runProjectTurn({...opts(f),input:'',materials:[image,text]});
 assert.equal(task.record.status,'completed',task.record.error);
 assert.equal(task.record.input,'');
 assert.deepEqual(task.record.materials.map(m=>m.sha256),[image.manifest.sha256,text.manifest.sha256]);
 assert.deepEqual(f.calls.map(c=>c.body.model),['main']);
 assert.ok(payloadImageHashes(f.calls[0].body).has(image.manifest.sha256));
 assert.match(JSON.stringify(f.calls[0].body.messages),/Exact material text 你好/);
 assert.ok(task.requests()[0].materialImages.some(m=>m.originalSha256===image.manifest.sha256&&m.payloadSha256===image.manifest.sha256));
});

async function materialRuntime(f,options={}) {
 const {createRuntime}=await import('../src/pi-runtime.js'),{cothinkExtension}=await import('../src/extensions/cothink.js');
 const host={allowWork:false,flow:'unified'};
 const rt=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,projectManaged:true,useFrozenSkills:true,
  sessionManager:options.manager,extensionFactories:[{name:'cothink',factory:cothinkExtension(host)},...(options.extensions??[])]});
 rt.hostContext=task=>{host.task=task;host.runtime=rt;};
 return rt;
}
test('a follow-up retains the original explicit skill request without replaying the frozen skill body',async t=>{
 const f=await fixture(t),rt=await materialRuntime(f);t.after(()=>rt.dispose());
 const input='/skill:context-management First user request';
 assert.equal((await runProjectTurn({...opts(f),input,mainRuntime:rt})).record.status,'completed');
 assert.match(JSON.stringify(f.calls[0].body.messages),/A short handoff can state the goal/);
 assert.equal((await runProjectTurn({...opts(f),input:'Follow-up request',mainRuntime:rt})).record.status,'completed');
 const next=JSON.stringify(f.calls[1].body.messages);
 assert.match(next,/\/skill:context-management First user request/);
 assert.doesNotMatch(next,/A short handoff can state the goal/);
});
test('Pi input removing typed image fails before any actual HTTP dispatch',async t=>{
 const {f,image}=await frozenInputFixture(t);
 const rt=await materialRuntime(f,{extensions:[{name:'omit-typed-image',factory:pi=>pi.on('input',event=>({action:'transform',text:event.text,images:[]}))}]});
 t.after(()=>rt.dispose());
 const task=await runProjectTurn({...opts(f),mainRuntime:rt,materials:[image]});
 assert.equal(task.record.status,'failed');assert.match(task.record.error,/缺少已选图片/);
 assert.equal(f.calls.length,0);
});
test('provider payload dropping images fails before HTTP with an unsent receipt',async t=>{
 const {f,image}=await frozenInputFixture(t);
 const rt=await materialRuntime(f);
 t.after(()=>rt.dispose());
 const policyStream=rt.modelRuntime.streamSimple.bind(rt.modelRuntime);
 rt.modelRuntime.streamSimple=(model,context,options)=>policyStream(model,context,{...options,onPayload:body=>({
  ...body,messages:body.messages.map(message=>Array.isArray(message.content)?
   {...message,content:message.content.filter(part=>part.type!=='image_url')}:message),
 })});
 const task=await runProjectTurn({...opts(f),mainRuntime:rt,materials:[image]});
 assert.equal(task.record.status,'failed');assert.match(task.record.error,/正文缺少已选图片/);
 assert.equal(f.calls.length,0);
 assert.equal(task.requests().length,1);assert.equal(task.requests()[0].sent,false);
});
test('reopened follow-up and fork see only the selected branch attachment provenance',async t=>{
 const {f,image,text}=await frozenInputFixture(t);
 const {SessionManager}=await import('@earendil-works/pi-coding-agent'),{conversationMaterialRefs}=await import('../src/conversation.js');
 const {payloadImageHashes}=await import('../src/visual-preview.js');
 const original=await materialRuntime(f);t.after(()=>original.dispose());
 const first=await runProjectTurn({...opts(f),mainRuntime:original,materials:[image]});
 assert.equal(first.record.status,'completed',first.record.error);
 const forkAt=original.sessionManager.getLeafId(),path=original.sessionManager.getSessionFile();
 const second=await runProjectTurn({...opts(f),mainRuntime:original,input:'future material',materials:[text]});
 assert.equal(second.record.status,'completed',second.record.error);
 await original.dispose();
 const reopened=SessionManager.open(path);
 assert.deepEqual(conversationMaterialRefs(reopened).map(ref=>ref.id),[image.manifest.id,text.manifest.id]);
 reopened.createBranchedSession(forkAt);
 const branched=await materialRuntime(f,{manager:reopened});t.after(()=>branched.dispose());
 const follow=await runProjectTurn({...opts(f),mainRuntime:branched,input:'fork follow-up'});
 assert.equal(follow.record.status,'completed',follow.record.error);
 assert.deepEqual(conversationMaterialRefs(branched.sessionManager).map(ref=>ref.id),[image.manifest.id]);
 assert.ok(payloadImageHashes(f.calls.at(-1).body).has(image.manifest.sha256));
 assert.doesNotMatch(JSON.stringify(f.calls.at(-1).body),/Exact material text 你好/);
 assert.deepEqual(follow.record.handoffContext.attachmentRefs.map(ref=>ref.id),[image.manifest.id]);
});

test('material context estimate rejects oversized exact text before model dispatch',async t=>{
 const {f,put}=await frozenInputFixture(t);
 const material=await put('too-long.txt','text/plain',Buffer.from('word '.repeat(34000)));
 const task=await runProjectTurn({...opts(f),materials:[material]});
 assert.equal(task.record.status,'failed');
 assert.match(task.record.error,/超出模型上下文估算上限/);
 assert.equal(f.calls.length,0);
});

test('manual compaction and subsequent requests keep typed images and original branch references',async t=>{
 const {f,image}=await frozenInputFixture(t);
 const {SessionManager}=await import('@earendil-works/pi-coding-agent');
 const {compactContext,contextSnapshot}=await import('../src/context-management.js');
 const {createTask}=await import('../src/task.js');
 const {createRootOwner,normalizeConstraints,normalizeRootBudget}=await import('../src/project-turn.js');
 const {conversationMaterialRefs}=await import('../src/conversation.js'),{payloadImageHashes}=await import('../src/visual-preview.js');
 const original=await materialRuntime(f);t.after(()=>original.dispose());
 const first=await runProjectTurn({...opts(f),mainRuntime:original,materials:[image]});
 assert.equal(first.record.status,'completed',first.record.error);
 const savedRefs=conversationMaterialRefs(original.sessionManager),path=original.sessionManager.getSessionFile();
 const reply=original.sessionManager.getBranch().findLast(e=>e.message?.role==='assistant').message;
 await original.dispose();
 const manager=SessionManager.open(path);
 for(let i=0;i<14;i++){
  manager.appendMessage({role:'user',content:'long request '.repeat(420),timestamp:Date.now()});
  manager.appendMessage({...reply,content:[{type:'text',text:'prior answer '.repeat(420)}],timestamp:Date.now()});
 }
 const rt=await materialRuntime(f,{manager});t.after(()=>rt.dispose());
 const snapshot=contextSnapshot(manager);
 const task=createTask({home:f.home,input:'Organize context',models:f.models,flow:'unified',constraints:normalizeConstraints(),
  budget:normalizeRootBudget({maxCalls:2}),sessionId:manager.getSessionId(),origin:'context.organize',sourceLeaf:snapshot.sourceLeaf,sourceSnapshot:snapshot});
 createRootOwner(task);
 await compactContext({task,runtime:rt,quarantine(error){rt.selectionError=error.message;}});
 assert.equal(task.record.status,'completed',task.record.error);
 assert.equal(task.record.contextResult.applied,true);
 assert.ok(payloadImageHashes(f.calls.at(-1).body).has(image.manifest.sha256));
 assert.deepEqual(conversationMaterialRefs(manager),savedRefs);
 const follow=await runProjectTurn({...opts(f),mainRuntime:rt,input:'continue after explicit compaction'});
 assert.equal(follow.record.status,'completed',follow.record.error);
 assert.ok(payloadImageHashes(f.calls.at(-1).body).has(image.manifest.sha256));
 assert.deepEqual(follow.record.handoffContext.attachmentRefs,savedRefs);
});

test('Pi resizing preserves the association between original and actual HTTP image hashes',async t=>{
 const {f,image}=await frozenInputFixture(t);
 const {payloadImageHashes}=await import('../src/visual-preview.js');
 const rt=await materialRuntime(f);t.after(()=>rt.dispose());
 const catalog=rt.modelRuntime.getModel.bind(rt.modelRuntime);
 rt.modelRuntime.getModel=(provider,id)=>{
  const model=catalog(provider,id);
  return model&&provider==='fixture'?{...model,inputLimits:{images:{resize:{maxWidth:1,maxHeight:1}}}}:model;
 };
 const task=await runProjectTurn({...opts(f),mainRuntime:rt,materials:[image]});
 assert.equal(task.record.status,'completed',task.record.error);
 const [evidence]=task.requests()[0].materialImages;
 assert.equal(evidence.originalSha256,image.manifest.sha256);
 assert.notEqual(evidence.payloadSha256,evidence.originalSha256);
 assert.ok(payloadImageHashes(f.calls[0].body).has(evidence.payloadSha256));
});

test('a valid plan blocked by an unprepared legacy directory retains original attachments and budget',async t=>{
 const plan={goal:'Prepare a deliverable',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};
 const {f,image}=await frozenInputFixture(t,()=>({toolCalls:[{name:'start_work',args:{action:'start',reason:'Prepare directory first',plan}}]}));
 const rt=await materialRuntime(f);t.after(()=>rt.dispose());
 let reached=false;
 const {loadPreparedContinuation}=await import('../src/project-turn.js');
 const task=await runProjectTurn({...opts(f),mainRuntime:rt,workspace:{id:null,project:f.cwd},input:'original request',materials:[image],budget:{maxCalls:2},
  beforeWork(){reached=true;throw Object.assign(new Error('unprepared'),{code:'PROJECT_NOT_PREPARED',path:f.cwd});},
  onWork(){throw Error('must not start execution');}});
 assert.equal(reached,true);assert.equal(f.calls.length,1);
 assert.equal(task.record.status,'blocked',task.record.error);
 assert.deepEqual(task.record.projectPreparationBlocked,{code:'PROJECT_NOT_PREPARED',path:f.cwd});
 assert.equal(task.record.proposal,undefined);
 const continuation=loadPreparedContinuation({home:f.home,manager:rt.sessionManager,sourceTaskId:task.record.id});
 assert.equal(continuation.source.input,'original request');
 assert.deepEqual(continuation.materials[0].bytes,image.bytes);
 assert.equal(continuation.spentCalls,1);assert.equal(continuation.remainingBudget.maxCalls,1);
 assert.throws(()=>loadPreparedContinuation({home:f.home,manager:{getBranch:()=>[]},sourceTaskId:task.record.id}),{code:'PROJECT_SOURCE'});
});

test('selected folder under a parent repository bounds plan and saved-version reads',async t=>{
 const {repository}=await import('./helpers/git-fixture.js'),{mkdirSync,realpathSync}=await import('node:fs');
 const {freezeReadAuthorization}=await import('../src/project-turn.js');
 const repo=repository(t),path=join(repo.project,'selected');
 mkdirSync(path);
 const workspace={id:null,project:path};
 let accepted;
 const plan={goal:'Edit one selected file',scope:['selected'],readScope:['selected'],deliverables:['selected/a.txt'],checks:[{command:'true'}]};
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'start_work',args:{action:'start',reason:'attempt broad scope',plan:{...plan,readScope:['.']}}}]}:
  n===2?{text:'Scope denied'}:{toolCalls:[{name:'start_work',args:{action:'start',reason:'narrow scope',plan}}]});
 await assert.rejects(freezeReadAuthorization({home:f.home,workspace,sessionId:'test',input:{paths:['.']}}),{code:'READ_SCOPE'});
 const grant=await freezeReadAuthorization({home:f.home,workspace,sessionId:'test',input:{paths:['selected']}});
 assert.equal(grant.canonicalRepo,realpathSync(repo.project));assert.deepEqual(grant.paths,['selected']);
 const input={...opts(f),workspace,beforeWork:()=>({root:repo.project,relativePath:'selected'}),
  onWork(task){accepted=task.record.routeIntent.args.plan;task.finish('blocked','preview');return task;}};
 const broad=await runProjectTurn(input);
 assert.equal(accepted,undefined);assert.equal(broad.record.proposal,undefined);
 assert.match(JSON.stringify(f.calls[1].body),/selected/);
 const narrow=await runProjectTurn(input);
 assert.deepEqual(accepted,plan);
 assert.deepEqual(narrow.record.executionScope,{path:realpathSync(path),root:realpathSync(repo.project),relativePath:'selected'});
});

test('follow-up on a smaller image model renormalizes historical attachments without rewriting their source',async t=>{
 const {f,image}=await frozenInputFixture(t);
 const {payloadImageHashes}=await import('../src/visual-preview.js');
 const {conversationMaterialRefs}=await import('../src/conversation.js');
 const rt=await materialRuntime(f);t.after(()=>rt.dispose());
 const catalog=rt.modelRuntime.getModel.bind(rt.modelRuntime);
 rt.modelRuntime.getModel=(provider,id)=>{
  const model=catalog(provider,id);
  return model&&provider==='fixture'&&id==='r1'?{...model,inputLimits:{images:{resize:{maxWidth:1,maxHeight:1}}}}:model;
 };
 const first=await runProjectTurn({...opts(f),mainRuntime:rt,materials:[image]});
 assert.equal(first.record.status,'completed',first.record.error);
 const [original]=conversationMaterialRefs(rt.sessionManager);
 assert.equal(original.payloadSha256,image.manifest.sha256);
 const sourceEntry=structuredClone(rt.sessionManager.getEntry(original.userEntryId));
 const second=await runProjectTurn({...opts(f),mainRuntime:rt,input:'inspect the previous attachment',frozenConfig:{
  formatVersion:2,main:f.models.secondary[0],secondary:[f.models.main],
 }});
 assert.equal(second.record.status,'completed',second.record.error);
 assert.deepEqual(f.calls.map(call=>call.body.model),['main','r1']);
 const [evidence]=second.requests()[0].materialImages;
 assert.equal(evidence.originalSha256,image.manifest.sha256);
 assert.notEqual(evidence.payloadSha256,evidence.originalSha256);
 const hashes=payloadImageHashes(f.calls[1].body);
 assert.ok(hashes.has(evidence.payloadSha256));
 assert.equal(hashes.has(evidence.originalSha256),false);
 assert.deepEqual(rt.sessionManager.getEntry(original.userEntryId),sourceEntry);
 const {SessionManager}=await import('@earendil-works/pi-coding-agent');
 const reopened=SessionManager.open(rt.sessionManager.getSessionFile());
 assert.deepEqual(reopened.getEntry(original.userEntryId),sourceEntry);
 assert.deepEqual(conversationMaterialRefs(reopened),[original]);
});
