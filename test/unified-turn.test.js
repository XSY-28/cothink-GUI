import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import { opts } from "./unified-turn.fixture.js";

test('unified quick answer is one actual HTTP and no project initialization',async t=>{
 const f=await fixture(t); const task=await runProjectTurn(opts(f));
 assert.equal(task.record.status,'completed',task.record.error); assert.equal(task.record.flow,'unified');
 assert.equal(task.record.maxCalls,null);assert.equal(f.calls.length,1);assert.equal(task.record.requestIds.length,1);
 assert.equal(existsSync(join(f.home,'project-delivery')),false);assert.ok(!f.calls[0].body.tools.some(t=>t.function.name==='read_project_context'));
 assert.ok(!f.calls[0].body.tools.some(t=>t.function.name==='request_review'));
 assert.doesNotMatch(JSON.stringify(f.calls[0].body),/deliverableKind|initial-answer stage/);
});
test('an invalid file plan keeps its diagnosis and does not turn inline HTML into a delivery',async t=>{
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'start_work',args:{action:'start',reason:'make a file',plan:{
   goal:'Draw a pelican',scope:['index.html'],steps:[{goal:'Draw the scene',deliverables:['index.html'],checks:[{command:'node',args:['--version']}]}],
 }}}]}:{text:'<html><body>Inline answer</body></html>'});
 let entered=0;
 const task=await runProjectTurn({...opts(f),input:'Create index.html.',workspace:{id:null,project:f.cwd},
   beforeWork(){entered++;throw Error('invalid input reached directory admission');}});
 assert.equal(entered,0);
 assert.equal(task.record.status,'partial',task.record.error);
 assert.match(task.record.error,/step id/i);
 assert.equal(task.record.proposal,undefined);
 assert.equal(f.calls.length,2);
});
test('the first unified HTTP request exposes usable and missing frozen routes without calling either secondary',async t=>{
 const f=await fixture(t),o=opts(f),path=join(f.home,'pi','models.json');
 const catalog=JSON.parse(readFileSync(path,'utf8'));
 catalog.providers.outside={...catalog.providers.fixture,api:'google-generative-ai',models:[{...catalog.providers.fixture.models[0],id:'outside-fence'}]};
 writeFileSync(path,JSON.stringify(catalog));
 const unsupported={provider:'outside',modelId:'outside-fence'};
 o.frozenConfig.secondary=[{provider:'fixture',modelId:'missing'},f.models.secondary[1],unsupported];
 o.budget={maxCalls:4};o.frozenConfig.main={...f.models.main,maxOutputTokens:123};
 const task=await runProjectTurn(o);assert.equal(task.record.status,'completed',task.record.error);assert.equal(f.calls.length,1);
 const body=f.calls[0].body;assert.equal(body.model,'main');assert.equal(body.max_tokens??body.max_completion_tokens,123);
 const system=body.messages.filter(message=>message.role==='system'||message.role==='developer').map(message=>message.content).join('\n');
 const context=system.match(/^Frozen model and budget facts: (.+)$/m);
 assert.ok(context,'The model facts belong to the ordinary first HTTP request');
 const {models,budget}=JSON.parse(context[1]);
 assert.deepEqual(models.map(model=>[model.identity,model.available]),[['fixture/main',true],['fixture/missing',false],['fixture/r2',true],['outside/outside-fence',false]]);
 assert.equal(models[0].maxOutputTokens,123);
 assert.equal(models[1].input,null);
 assert.match(models[1].unavailableReason,/目录|catalog/);
 assert.deepEqual(models[2].input,['text']);
 assert.equal(models[2].contextWindow,32000);
 assert.equal(models[2].auth,'configured');
 assert.equal(models[3].auth,'configured');
 assert.equal(models[3].transport,'unsupported');
 assert.equal(models[3].unavailableCode,'PROJECT_TRANSPORT');
 assert.equal(budget.rootRemainingCalls,4);
 assert.equal(budget.remainingCalls,3);
 await assert.rejects(runProjectTurn({...o,frozenConfig:{...o.frozenConfig,main:unsupported,secondary:[f.models.main]}}),{code:'PROJECT_TRANSPORT'});
 assert.equal(f.calls.length,1);
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
test('two valid file routes in one response preserve the first source only',async t=>{
 const {repository}=await import('./helpers/git-fixture.js');
 const {project}=repository(t);
 const first={action:'start',reason:'first',plan:{goal:'First plan',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]}};
 const f=await fixture(t,()=>({toolCalls:[{id:'first',name:'start_work',args:first},{id:'conflict',name:'start_work',args:{...first,reason:'replacement'}}]}));
 const task=await runProjectTurn({...opts(f),workspace:{id:null,project}});
 assert.equal(task.record.routeIntent.toolCallId,'first');
 assert.equal(task.record.proposal.plan.goal,'First plan');
 assert.equal(f.calls.length,1);
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

test('advertised start_work arguments reject mixed or missing action-specific sources before dispatch',async()=>{
 const {cothinkExtension}=await import('../src/extensions/cothink.js'),{validateToolArguments}=await import('@earendil-works/pi-ai');
 const tools=[];cothinkExtension({flow:'unified'})({on(){},registerTool(tool){tools.push(tool);}});const tool=tools.find(t=>t.name==='start_work');
 const plan={goal:'file'},planRef={taskId:'saved',field:'proposal',sha256:'hash'};
 const check=arguments_=>validateToolArguments(tool,{name:'start_work',arguments:arguments_});
 for(const action of ['start','revise']){
  assert.doesNotThrow(()=>check({action,reason:'bounded work',plan}));
  assert.throws(()=>check({action,reason:'bounded work',plan,planRef}));
  assert.throws(()=>check({action,reason:'bounded work',planRef}));
 }
 assert.doesNotThrow(()=>check({action:'resume',reason:'saved source',planRef}));
 assert.throws(()=>check({action:'resume',reason:'saved source',plan,planRef}));
 assert.throws(()=>check({action:'resume',reason:'saved source',plan}));
});

test('staff tool rejects unsupported needs and reports the current registered scope without widening it',async()=>{
 const {createProjectStaff}=await import('../src/project-staff.js'),{validateToolArguments}=await import('@earendil-works/pi-ai');
 const state={staff:[],scope:['a.txt'],readScope:['a.txt'],steps:[{id:'main',scope:['a.txt'],deliverables:['a.txt'],attempts:[{taskId:'current'}]}]};
 const staff=createProjectStaff({read:()=>state,update:fn=>fn(state)}),tool=staff.tools('root',()=>{},'current',['fixture/r1']).find(t=>t.name==='project_staff');
 for(const need of ['deliverable','review','capability'])assert.doesNotThrow(()=>validateToolArguments(tool,{name:tool.name,arguments:{action:'appoint',input:{need}}}));
 assert.throws(()=>validateToolArguments(tool,{name:tool.name,arguments:{action:'appoint',input:{need:'implementation'}}}));
 await assert.rejects(tool.execute('outside',{action:'register_work',input:{scope:['b.txt']}}),error=>error.code==='PROJECT_STAFF'&&error.message.includes('a.txt'));
 assert.equal(state.steps[0].subworks,undefined);
});

test('an explicit two-employee requirement cannot be fulfilled by the manager plus one collected employee',async t=>{
 let main=0;
 const f=await fixture(t,({body})=>{
  if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
  if(body.model==='r2')return {text:'Read-only source investigation completed; execution and playtesting remain unverified.'};
  if(++main===1)return {toolCalls:[{name:'delegate',args:{workId:'source-review',model:'fixture/r2',assignment:'Review source evidence without execution',reason:'First explicitly required employee'}}]};
  if(main===2)return {toolCalls:[{name:'collect',args:{assignmentId:JSON.parse(body.messages.findLast(m=>m.role==='tool').content).assignmentId}}]};
  return {text:'One employee was collected; a second employee is still missing.'};
 });
 const task=await runProjectTurn({...opts(f),input:'安排两名员工分析证据。'});
 assert.equal(task.record.status,'partial',task.record.error);assert.equal(task.record.collaborationResult[0].requirement.workers,2);
 assert.equal(task.record.collaborationResult[0].status,'unfulfilled');assert.equal(task.record.collaborationResult[0].evidence.length,1);
 assert.equal(task.record.stages.filter(s=>s.assignment&&!s.assignment.reviewOf).length,1);
 const employee=f.calls.find(c=>c.body.model==='r2');assert.ok(employee);
 assert.ok(!employee.body.tools.some(t=>['bash','preview_html','write','edit'].includes(t.function.name)));
});
