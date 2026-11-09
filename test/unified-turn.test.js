import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
const opts=f=>({home:f.home,cwd:f.cwd,input:'question',frozenConfig:{formatVersion:2,...f.models},workspace:{id:null,project:null}});
test('unified quick answer is one actual HTTP and no project initialization',async t=>{
 const f=await fixture(t); const task=await runProjectTurn(opts(f));
 assert.equal(task.record.status,'completed',task.record.error); assert.equal(task.record.flow,'unified');
 assert.equal(task.record.maxCalls,null);assert.equal(f.calls.length,1);assert.equal(task.record.requestIds.length,1);
 assert.equal(existsSync(join(f.home,'project-delivery')),false);assert.ok(!f.calls[0].body.tools.some(t=>t.function.name==='read_project_context'));
});
test('unified review intent reuses independent review and revision',async t=>{
 const f=await fixture(t,(c,n)=> n===1?{toolCalls:[{name:'request_review',args:{reason:'check',draft:'FROZEN DRAFT'}}]}:{text:n===2?'REVIEW':'FINAL'});
 const task=await runProjectTurn(opts(f)); assert.equal(task.record.status,'completed',task.record.error);
 assert.deepEqual(f.calls.map(c=>c.body.model),['main','r1','main']);
 assert.match(JSON.stringify(f.calls[1].body),/FROZEN DRAFT/);
});
test('unified budget blocks required review at actual send and preserves draft',async t=>{
 const f=await fixture(t);const task=await runProjectTurn({...opts(f),budget:{maxCalls:1},frozenConstraints:{requireDifferentModelReview:true}});
 assert.notEqual(task.record.status,'completed');assert.equal(f.calls.length,1);
 assert.equal(task.record.rootRequests.filter(r=>!r.notSent).length,1);
});
test('unified unused reviewer is not prevalidated',async t=>{
 const f=await fixture(t);const o=opts(f);o.frozenConfig.secondary=[{provider:'fixture',modelId:'missing'}];
 const task=await runProjectTurn(o);assert.equal(task.record.status,'completed',task.record.error);assert.equal(f.calls.length,1);
});

test('read authorization is explicit, scoped and fixed before a tool continuation',async t=>{
 const {repository}=await import('./helpers/git-fixture.js');const {freezeReadAuthorization}=await import('../src/project-turn.js');
 const {writeFileSync}=await import('node:fs');const repo=repository(t);
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'read_project_context',args:{operation:'read',paths:['a.txt']}}]}:{text:'read answer'});
 const grant=await freezeReadAuthorization({home:f.home,workspace:{id:null,project:repo.project},sessionId:'test',submissionId:'read',input:{paths:['a.txt']}});
 writeFileSync(join(repo.project,'a.txt'),'UNCOMMITTED SECRET');
 const task=await runProjectTurn({...opts(f),cwd:repo.project,workspace:{id:null,project:repo.project},readAuthorization:grant});
 assert.equal(task.record.status,'completed',task.record.error);assert.equal(f.calls.length,2);assert.equal(task.record.work,undefined);
 const sent=JSON.stringify(f.calls[1].body);assert.match(sent,/base A/);assert.doesNotMatch(sent,/UNCOMMITTED SECRET/);
 await assert.rejects(task.unifiedReadContext({operation:'list',paths:['.']}),/unauthorized/);
 const noGrant=await runProjectTurn({...opts(f),input:'another turn'});await assert.rejects(noGrant.unifiedReadContext({operation:'read',paths:['a.txt']}),/No file-read authorization/);
});
test('two terminal tools in one response preserve the first source only',async t=>{
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{id:'first',name:'request_review',args:{reason:'check',draft:'FIRST DRAFT'}},{id:'conflict',name:'request_review',args:{reason:'replace',draft:'REPLACEMENT'}}]}:{text:'reviewed'});
 const task=await runProjectTurn(opts(f));assert.equal(task.record.routeIntent.toolCallId,'first');assert.equal(task.record.reviewDraft.text,'FIRST DRAFT');
 assert.equal(f.calls.length,3);assert.doesNotMatch(JSON.stringify(f.calls[1].body),/REPLACEMENT/);
});

test('concurrent runtime requests compete for the same last root HTTP allowance',async t=>{
 const {createTask}=await import('../src/task.js'),{createRootOwner,normalizeConstraints,normalizeRootBudget}=await import('../src/project-turn.js'),{createRuntime}=await import('../src/pi-runtime.js');
 const f=await fixture(t),task=createTask({home:f.home,input:'parallel',models:f.models,flow:'unified',constraints:normalizeConstraints(),budget:normalizeRootBudget({maxCalls:1})});createRootOwner(task);
 const runtimes=await Promise.all(['first','second'].map(role=>createRuntime({home:f.home,cwd:f.cwd,role,modelRef:f.models.main,projectManaged:true})));t.after(()=>Promise.all(runtimes.map(r=>r.dispose())));
 for(const [i,rt]of runtimes.entries())rt.bindTask(task,task.beginPhase('review','reviewer-'+i,f.models.main));
 const results=await Promise.allSettled(runtimes.map(rt=>rt.prompt('answer')));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.length,1);assert.equal(task.record.rootRequests.length,1);
});
test('root cancellation does not settle before its registered operation exits',async t=>{
 const {createTask}=await import('../src/task.js'),{createRootOwner,normalizeConstraints,normalizeRootBudget}=await import('../src/project-turn.js');
 const f=await fixture(t),task=createTask({home:f.home,input:'stop',models:f.models,flow:'unified',constraints:normalizeConstraints(),budget:normalizeRootBudget()});const owner=createRootOwner(task);
 let release,cancelled=false;const settled=new Promise(r=>release=r);task.record.projectOperation={commandId:'operation',childTaskIds:[]};owner.registerExecution({commandId:'operation',cancel(){cancelled=true;},settled});
 const closing=task.cancel();await new Promise(r=>setImmediate(r));assert.equal(cancelled,true);assert.equal(task.record.cancelSettledAt,undefined);
 release();await closing;assert.ok(task.record.cancelSettledAt);
});

test('hard cost cap never uses directory estimates as an enforceable charge bound',async t=>{
 const f=await fixture(t),task=await runProjectTurn({...opts(f),budget:{maxCost:1}});assert.notEqual(task.record.status,'completed');assert.equal(f.calls.length,0);assert.match(task.record.error,/fee upper bound/);
});
test('root constraints fence actual project effect and helper admission entrances',async()=>{
 const {createProjectPolicy}=await import('../src/project-policy.js');
 const constraints={readOnly:true,allowedSubtasks:[],requireDifferentModelReview:false};
 const policy=createProjectPolicy({host:{assertOwned(){},read(){return {};}},binding:{constraints},home:'/unused'});
 for(const action of ['write','shell','scope','accept'])assert.throws(()=>policy.admit(action),{code:'ROOT_READ_ONLY'});
 assert.throws(()=>policy.admit('delegate'),{code:'ROOT_SUBTASK'});
 assert.throws(()=>policy.issueNativeHelper({}),{code:'ROOT_SUBTASK'});
 assert.throws(()=>policy.admitMcp({kind:'write'}),{code:'ROOT_READ_ONLY'});
});

test('review-only constraints allow a bound independent reader but reject ordinary delegation and widening',async()=>{
 const {createProjectPolicy}=await import('../src/project-policy.js');
 const state={id:'p',status:'active',steps:[{id:'s',revision:1,status:'running',attempts:[{taskId:'t'}]}]};
 const policy=createProjectPolicy({host:{assertOwned(){},read:()=>state},binding:{projectId:'p',id:'p',stepId:'s',revision:1,taskId:'t',constraints:{readOnly:false,allowedSubtasks:['review']}}});
 assert.doesNotThrow(()=>policy.admit('delegate',{actor:'main',staffControl:{action:'appoint',input:{need:'review',scope:[]}}}));
 const review={actor:'main',readOnly:true,scope:[],reviewOf:'source',reviewKind:'independent',reviewSource:{candidate:'fixed'}};
 assert.doesNotThrow(()=>policy.admit('delegate',review));
 for(const change of [{reviewOf:null},{readOnly:false},{scope:['a.txt']},{reviewKind:'ordinary'}])assert.throws(()=>policy.admit('delegate',{...review,...change}),{code:'ROOT_SUBTASK'});
});

test('programmatic unified entry refuses an actually preloaded child without model requests',async t=>{
 const {writeFileSync,existsSync}=await import('node:fs');const {spawnSync}=await import('node:child_process');
 const f=await fixture(t),preload=join(f.home,'preload.mjs'),script=join(f.home,'entry.mjs'),canary=join(f.home,'preloaded');
 writeFileSync(preload,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(canary)},'ran');`);
 writeFileSync(script,`import{runProjectTurn}from${JSON.stringify(new URL('../src/project-turn.js',import.meta.url).href)};try{await runProjectTurn(${JSON.stringify(opts(f))});process.exitCode=9;}catch(error){console.log(error.code);if(!/干净入口/.test(error.message))process.exitCode=8;}`);
 const child=spawnSync(process.execPath,['--import',preload,script],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/PROJECT_HANDOFF_BLOCKED/);assert.equal(existsSync(canary),true,'preload ran before Node entry; refusal does not undo it');assert.equal(f.calls.length,0);
});

test('revision can continue after an authorized read without selecting another terminal route',async t=>{
 const {repository}=await import('./helpers/git-fixture.js'),{freezeReadAuthorization}=await import('../src/project-turn.js');const repo=repository(t);
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'request_review',args:{reason:'check',draft:'Draft'}}]}:n===3?{toolCalls:[{name:'read_project_context',args:{operation:'read',paths:['a.txt']}}]}:{text:n===2?'Review':'Final after reading'});
 const workspace={id:null,project:repo.project},grant=await freezeReadAuthorization({home:f.home,workspace,sessionId:'fixture',submissionId:'revision',input:{paths:['a.txt']}});
 const task=await runProjectTurn({...opts(f),cwd:repo.project,workspace,readAuthorization:grant,budget:{maxCalls:4}});
 assert.equal(task.record.status,'completed',task.record.error);assert.equal(f.calls.length,4);assert.equal(task.requests().find(c=>c.id===task.record.finalCallId).text,'Final after reading');assert.match(JSON.stringify(f.calls[3].body),/base A/);
});

test('stopped roots reject late execution and owned-task registration before persistence',async t=>{
 const {createTask}=await import('../src/task.js'),{createRootOwner,normalizeConstraints,normalizeRootBudget}=await import('../src/project-turn.js');
 const f=await fixture(t),root=createTask({home:f.home,input:'stop before registration',models:f.models,flow:'unified',constraints:normalizeConstraints(),budget:normalizeRootBudget()});
 const owner=createRootOwner(root);await root.cancel();root.record.projectOperation={commandId:'late',childTaskIds:[]};let cancelled=false;
 assert.throws(()=>owner.registerExecution({commandId:'late',cancel(){cancelled=true;},settled:new Promise(()=>{})}),{code:'ROOT_STOPPED'});
 assert.throws(()=>owner.registerTask({record:{id:'late-child',rootTaskId:root.record.id,project:{commandId:'late'}}}),{code:'ROOT_STOPPED'});
 assert.equal(root.record.projectOperation.registered,undefined);assert.deepEqual(root.record.projectOperation.childTaskIds,[]);assert.equal(cancelled,false);assert.ok(root.record.cancelSettledAt);
});
test('an already-aborted confirmed root never invokes its execution callback',async t=>{
 const f=await fixture(t),abort=new AbortController();abort.abort();let executed=false;
 const task=await runProjectTurn({...opts(f),signal:abort.signal,confirmedOperation:{execute(){executed=true;}}});
 assert.equal(executed,false);assert.equal(task.record.status,'cancelled');assert.ok(task.record.cancelSettledAt);assert.equal(task.record.projectOperation,undefined);assert.equal(f.calls.length,0);
});

test('cancellation during confirmed import leaves no operation intent',async t=>{
 const {createTask}=await import('../src/task.js'),{createRootOwner,normalizeConstraints,normalizeRootBudget,executeConfirmed}=await import('../src/project-turn.js');
 const f=await fixture(t),root=createTask({home:f.home,input:'cancel during admission',models:f.models,frozenConfig:{formatVersion:2,...f.models},flow:'unified',constraints:normalizeConstraints(),budget:normalizeRootBudget()});createRootOwner(root);
 const pending=executeConfirmed(root,{proposal:{action:'start',plan:{}}},{commandId:'unused'});
 const rejected=assert.rejects(pending,{code:'CANCELLED'});await root.cancel();await rejected;
 assert.equal(root.record.projectOperation,undefined);assert.equal(root.record.confirmationSource,undefined);assert.ok(root.record.cancelSettledAt);assert.equal(f.calls.length,0);
});

async function frozenInputFixture(t, respond, imageModels=['main','r1']) {
 const f=await fixture(t,respond);
 const fs=await import('node:fs'),{createHash,randomUUID}=await import('node:crypto'),{createGuiMaterialStore}=await import('../src/gui-materials.js');
 const path=join(f.home,'pi','models.json'),config=JSON.parse(fs.readFileSync(path,'utf8'));
 for(const m of config.providers.fixture.models)if(imageModels.includes(m.id))m.input.push('image');
 fs.writeFileSync(path,JSON.stringify(config));
 const store=createGuiMaterialStore(f.home),ownerId=randomUUID();
 const put=async(name,mediaType,bytes)=>{
  const intent={ownerId,uploadId:randomUUID(),name,mediaType,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  store.begin(intent);const saved=await store.publish({...intent,body:bytes});return store.read(saved);
 };
 const image=await put('proof.png','image/png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mNklAtgYGBgYmBgQFAACEIAdYij2wsAAAAASUVORK5CYII=','base64'));
 const text=await put('notes.md','text/markdown',Buffer.from('Exact material text 你好'));
 return {f,image,text,put};
}
test('attachment-only unified turn sends real image and attributed exact text to all three phases',async t=>{
 const {f,image,text}=await frozenInputFixture(t,(_,n)=>n===1?{toolCalls:[{name:'request_review',args:{reason:'check evidence',draft:'Frozen draft'}}]}:{text:n===2?'Reviewed':'Final'});
 const {payloadImageHashes}=await import('../src/visual-preview.js');
 const task=await runProjectTurn({...opts(f),input:'',materials:[image,text]});
 assert.equal(task.record.status,'completed',task.record.error);
 assert.equal(task.record.input,'');assert.deepEqual(task.record.materials.map(m=>m.sha256),[image.manifest.sha256,text.manifest.sha256]);
 assert.deepEqual(f.calls.map(c=>c.body.model),['main','r1','main']);
 for(const c of f.calls){
  assert.ok(payloadImageHashes(c.body).has(image.manifest.sha256));assert.match(JSON.stringify(c.body),/Exact material text 你好/);
 }
 for(const call of task.requests())assert.ok(call.materialImages.some(m=>m.originalSha256===image.manifest.sha256&&m.payloadSha256===image.manifest.sha256));
});
test('image-incompatible reviewer blocks dispatch before the main model can be charged',async t=>{
 const {f,image}=await frozenInputFixture(t,undefined,['main']);
 await assert.rejects(runProjectTurn({...opts(f),materials:[image]}),error=>error.code==='MATERIAL_IMAGE_MODEL'&&error.message.includes('fixture/r1'));
 assert.equal(f.calls.length,0);
});

async function materialRuntime(f,options={}) {
 const {createRuntime}=await import('../src/pi-runtime.js'),{cothinkExtension}=await import('../src/extensions/cothink.js');
 const host={allowWork:false,flow:'unified'};
 const rt=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,projectManaged:true,useFrozenSkills:true,
  sessionManager:options.manager,extensionFactories:[{name:'cothink',factory:cothinkExtension(host)},...(options.extensions??[])]});
 rt.hostContext=task=>{host.task=task;host.runtime=rt;};
 return rt;
}
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

test('unprepared directory blocks the saved route before plan validation, retaining original attachments and budget',async t=>{
 const {f,image}=await frozenInputFixture(t,()=>({toolCalls:[{name:'start_work',args:{action:'start',reason:'Prepare directory first'}}]}));
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
