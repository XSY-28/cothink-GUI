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
