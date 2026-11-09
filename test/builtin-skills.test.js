import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync,mkdtempSync,rmSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fixture} from './helpers/pi-fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import {runTurn} from '../src/discussion.js';
import {validateConfig} from '../src/config.js';
const opts=f=>({home:f.home,cwd:f.cwd,input:'explain documentation maintenance',frozenConfig:{formatVersion:2,...f.models},workspace:{id:null,project:null}});
test('unified no-directory reads frozen builtin on demand and records actual use',async t=>{
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'read_skill',args:{name:'doc-maintenance'}}]}:{text:'checked guidance'});
 const task=await runProjectTurn(opts(f));assert.equal(task.record.status,'completed',task.record.error);
 const first=JSON.stringify(f.calls[0].body),second=JSON.stringify(f.calls[1]?.body);
 assert.match(first,/doc-maintenance/);assert.doesNotMatch(first,/帮助 coding agent 在现有仓库中维护/);assert.doesNotMatch(first,/\/Users\/|sourceDirectory|sourcePath/);
 assert.match(second,/帮助 coding agent 在现有仓库中维护/);assert.equal(f.calls.length,2);assert.equal(task.record.work,undefined);
 assert.deepEqual(task.record.skillResources.map(s=>s.name),['doc-maintenance','context-management']);
 assert.equal(task.record.tools.filter(x=>x.kind==='skill_resource_read').length,1);
 assert.ok(!f.calls[0].body.tools.some(x=>['read','write','bash','resource_exec'].includes(x.function.name)));
});
test('builtin config rejects unknown names and duplicate disabled entries',()=>{
 for(const disabled of [['unknown'],['doc-maintenance','doc-maintenance'],'doc-maintenance',[1]])assert.throws(()=>validateConfig({formatVersion:2,main:{provider:'p',modelId:'m'},secondary:[],piResources:{builtinSkills:{disabled}}}),/builtin|内置/);
});
test('explicit unified skill expansion consumes frozen body after source changes',async t=>{
 const f=await fixture(t),dir=join(f.home,'selected');mkdirSync(dir);
 const body=text=>'---\nname: selected\ndescription: Selected only\ndisable-model-invocation: true\n---\n'+text;
 writeFileSync(join(dir,'SKILL.md'),body('ORIGINAL_FROZEN_BODY'));
 const o=opts(f);o.input='/skill:selected explain';o.frozenConfig.piResources={skills:[dir]};
 const task=await runProjectTurn({...o,onProgress:e=>{if(e.type==='started')writeFileSync(join(dir,'SKILL.md'),body('LIVE_CHANGED_BODY'));}});
 assert.equal(task.record.status,'completed',task.record.error);assert.equal(task.record.input,o.input);
 assert.match(JSON.stringify(f.calls[0].body),/ORIGINAL_FROZEN_BODY/);assert.doesNotMatch(JSON.stringify(f.calls[0].body),/LIVE_CHANGED_BODY/);
 assert.equal(task.record.tools.filter(x=>x.kind==='skill_resource_read'&&x.explicit).length,1);
});
test('legacy CLI defaults remain empty while builtin disable and external replacement are explicit',async t=>{
 const f=await fixture(t);const legacy=await runTurn({home:f.home,cwd:f.cwd,input:'answer',config:{formatVersion:2,...f.models},singleModel:true});
 assert.equal(legacy.record.status,'completed',legacy.record.error);assert.deepEqual(legacy.record.answerSkills,[]);assert.doesNotMatch(JSON.stringify(f.calls[0].body),/doc-maintenance|context-management/);
 const o=opts(f);o.frozenConfig.piResources={builtinSkills:{disabled:['doc-maintenance','context-management']}};
 const disabled=await runProjectTurn(o);assert.deepEqual(disabled.record.skillResources,[]);assert.equal(disabled.record.work,undefined);
 const dir=join(f.home,'replacement');mkdirSync(dir);writeFileSync(join(dir,'SKILL.md'),'---\nname: doc-maintenance\ndescription: Explicit alternative\n---\nREPLACEMENT_BODY');
 o.frozenConfig.piResources.skills=[dir];const replaced=await runProjectTurn(o);assert.equal(replaced.record.skillResources.length,1);assert.equal(replaced.record.skillResources[0].sourceKind,'selected');
 o.frozenConfig.piResources.builtinSkills.disabled=[];const sent=f.calls.length;await assert.rejects(runProjectTurn(o),/名称冲突/);assert.equal(f.calls.length,sent);
});
test('automatic invocation cannot access explicitly restricted skill or arbitrary paths',async t=>{
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'read_skill',args:{name:'restricted'}},{name:'read_skill',args:{name:'doc-maintenance',path:'../../secret'}}]}:{text:'Unavailable resources reported'});
 const dir=join(f.home,'restricted');mkdirSync(dir);writeFileSync(join(dir,'SKILL.md'),'---\nname: restricted\ndescription: Explicit only\ndisable-model-invocation: true\n---\nRESTRICTED_SECRET');
 const o=opts(f);o.frozenConfig.piResources={skills:[dir]};const task=await runProjectTurn(o);
 assert.equal(task.record.status,'completed',task.record.error);assert.ok(!task.record.skillResources.some(s=>s.name==='restricted'));assert.doesNotMatch(JSON.stringify(f.calls),/RESTRICTED_SECRET/);assert.equal(task.record.tools?.filter(x=>x.kind==='skill_resource_read').length??0,0);
});
test('independent reviewer reads the same frozen body without preloading it',async t=>{
 const f=await fixture(t,(_,n)=>n===1?{toolCalls:[{name:'request_review',args:{reason:'verify',draft:'Draft'}}]}:n===2?{toolCalls:[{name:'read_skill',args:{name:'doc-maintenance'}}]}:{text:n===3?'Reviewed':'Final'});
 const task=await runProjectTurn(opts(f));assert.equal(task.record.status,'completed',task.record.error);
 assert.deepEqual(f.calls.map(c=>c.body.model),['main','r1','r1','main']);
 assert.doesNotMatch(JSON.stringify(f.calls[1].body),/帮助 coding agent 在现有仓库中维护/);assert.match(JSON.stringify(f.calls[2].body),/帮助 coding agent 在现有仓库中维护/);
 const read=task.record.tools.find(x=>x.kind==='skill_resource_read');assert.equal(read.actor,'reviewer-1');assert.equal(read.skillHash,task.record.skillResources.find(x=>x.name==='doc-maintenance').hash);
});
test('generic restore never refreshes sources and rejects manifest conflict or corrupted frozen bytes',async t=>{
 const {freezeTaskSkillResources,readTaskSkillResource,getTaskSkillResources}=await import('../src/skill-resources.js');
 const f=await fixture(t),task=await runProjectTurn(opts(f)),record=structuredClone(task.record),saved=record.skillResources[0];
 const restored={home:f.home,record,save(){throw Error('restoration must not resave');}};
 freezeTaskSkillResources({task:restored});assert.equal(record.work,undefined);assert.match(readTaskSkillResource(restored,'skill:doc-maintenance/SKILL.md').bytes.toString(),/Doc Maintenance/);
 assert.throws(()=>getTaskSkillResources({skillResources:null}),{code:'SKILL_CHANGED'});
 assert.throws(()=>getTaskSkillResources({skillResources:record.skillResources,work:{skillResources:[]}}),{code:'SKILL_CHANGED'});
 assert.equal(getTaskSkillResources({work:{skillResources:record.skillResources}}).length,2);
 writeFileSync(saved.path,'changed frozen bytes');assert.throws(()=>freezeTaskSkillResources({task:restored}),{code:'SKILL_CHANGED'});
});
test('shared settings capability DTO reports real limits and config save survives reload',async t=>{
 const {saveConfig,loadConfig}=await import('../src/config.js'),{createTeamConfig}=await import('../src/teams.js'),{createGuiController}=await import('../src/gui-controller.js');
 const f=await fixture(t);saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Fixture','7c8094cd-3476-4bfa-8f53-055d87972896'));
 const c=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>c.close());const session=await c.action('session.create',{project:null});
 const capability=await c.getSessionCapabilities(session.id);assert.equal(capability.version,1);assert.equal(capability.skills.length,2);assert.equal(capability.permissions.fileWrite,false);assert.equal(capability.environment.contextToolsAvailable,true);assert.doesNotMatch(JSON.stringify(capability),new RegExp(f.home));
 await c.action('settings.builtinSkills',{builtinSkills:{disabled:['doc-maintenance']}});assert.deepEqual(loadConfig(f.home).piResources.builtinSkills,{disabled:['doc-maintenance']});
 assert.deepEqual((await c.getSessionCapabilities(session.id)).skills.map(x=>x.name),['context-management']);assert.equal(f.calls.length,0);
 await assert.rejects(c.action('settings.builtinSkills',{builtinSkills:{disabled:['Doc-maintenance']}}),/builtin|内置/);
});
test('model capability tool and settings read the same active host facts',async t=>{
 const {saveConfig}=await import('../src/config.js'),{createTeamConfig}=await import('../src/teams.js'),{createGuiController}=await import('../src/gui-controller.js');let c,session,observed;
 const f=await fixture(t,async({body},n)=>{if(n===1)return {toolCalls:[{name:'get_capabilities',args:{}}]};observed=JSON.parse(body.messages.findLast(m=>m.role==='tool').content);assert.deepEqual(observed,await c.getSessionCapabilities(session.id));return {text:'Capabilities inspected'};});
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Fixture','7c8094cd-3476-4bfa-8f53-055d87972896'));c=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>c.close());session=await c.action('session.create',{project:null});
 const submitted=await c.action('task.submit',{sessionId:session.id,submissionId:'capabilities',protocolVersion:1,input:'inspect capabilities'});
 let task;for(let n=0;n<100;n++){task=await c.task(submitted.taskId);if(task.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(task.status,'completed',task.error);assert.equal(observed.permissions.fileWrite,false);assert.equal(observed.environment.contextOrganizationAvailable,true);assert.equal(f.calls.length,2);
});
test('confirmed PROJECT settings distinguish coordinator from the active owned model capabilities',{timeout:30000},async t=>{
 const {repository}=await import('./helpers/git-fixture.js'),{execution}=await import('./helpers/agent-sync-fixture.js'),{saveConfig}=await import('../src/config.js'),{createTeamConfig}=await import('../src/teams.js'),{createGuiController}=await import('../src/gui-controller.js');
 const repo=repository(t),plan={goal:'Change a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('changed A'))process.exit(1)"]}]};
 let release,reached,modelCapabilities,initialCapabilities;const ready=new Promise(r=>reached=r),barrier=new Promise(r=>release=r);
 const f=await fixture(t,async({body},n)=>{
  if(n===1)return {toolCalls:[{name:'start_work',args:{action:'start',reason:'edit',plan}}]};
  if(n===2)return {toolCalls:[{name:'get_capabilities',args:{}}]};
  if(n===3){initialCapabilities=JSON.parse(body.messages.findLast(m=>m.role==='tool').content);return {toolCalls:[{name:'read',args:{path:'a.txt'}}]};}
  if(n===4)return {toolCalls:[{name:'edit',args:{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}}]};
  if(n===5)return {toolCalls:[{name:'get_capabilities',args:{}}]};
  if(n===6){modelCapabilities=JSON.parse(body.messages.findLast(m=>m.role==='tool').content);reached();await barrier;return {toolCalls:[{name:'accept_change',args:{}}]};}return {text:'Changed A'};
 });
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,work:{execution}},'Fixture','7c8094cd-3476-4bfa-8f53-055d87972896'));
 const c=await createGuiController({home:f.home,cwd:repo.project});t.after(()=>c.close());const session=await c.action('session.create',{project:repo.project});
 const settle=async id=>{for(let n=0;n<300;n++){const task=await c.task(id);if(task.status!=='running')return task;await new Promise(r=>setTimeout(r,10));}throw Error('Task did not settle');};
 const proposal=await c.action('task.submit',{sessionId:session.id,submissionId:'proposal-capabilities',protocolVersion:1,input:'Change a.txt'}),source=await settle(proposal.taskId);assert.equal(source.status,'blocked',source.error);
 const confirmed=await c.action('task.confirmWork',{sessionId:session.id,submissionId:'confirm-capabilities',protocolVersion:1,proposalRef:source.proposalRef});
 let assertionFailure;try {await ready;const shown=await c.getSessionCapabilities(session.id),root=await c.task(confirmed.taskId);
  assert.equal(shown.scope,'coordinator');assert.deepEqual(shown.tools,[]);assert.equal(shown.permissions.fileWrite,false);assert.equal(shown.permissions.scriptExecution,false);
  assert.equal(shown.executors.length,1);assert.deepEqual(shown.executors[0],modelCapabilities);
  assert.equal(shown.executors[0].source.role,'main');assert.ok(root.projectOperation.childTaskIds.includes(shown.executors[0].source.taskId));assert.notEqual(shown.executors[0].source.taskId,source.id);
  assert.equal(modelCapabilities.permissions.fileWrite,true);assert.equal(modelCapabilities.permissions.scriptExecution,true);assert.ok(modelCapabilities.tools.includes('resource_exec'));
  assert.equal(modelCapabilities.permissions.fileReadAuthorized,true,'formal actor reads under its work binding, not the earlier GUI planning grant');assert.equal(modelCapabilities.permissions.readOnly,false);
  assert.equal(modelCapabilities.environment.managedExecutionConfigured,true);
  assert.equal(initialCapabilities.permissions.fileReadAuthorized,true);assert.equal(initialCapabilities.permissions.readOnly,true);assert.equal(initialCapabilities.permissions.fileWrite,false);assert.equal(initialCapabilities.permissions.scriptExecution,false,'initial observation has no writable grant even if effect tools can later request one');
  for(const hidden of [f.home,repo.project,'fixture-secret','sourceDirectory','sourcePath'])assert.ok(!JSON.stringify(shown).includes(hidden),hidden);
 }catch(error){assertionFailure=error;}finally{release();}
 try {const final=await settle(confirmed.taskId);assert.equal(final.status,'completed',final.error);assert.equal(f.calls.length,7);
  assert.equal((await c.getSessionCapabilities(session.id)).executors,undefined,'completed execution is not a current capability source');if(assertionFailure)throw assertionFailure;
 }finally{await c.close();}
});
test('persisted inherited delivery IDs do not become active executor capability sources',async t=>{
 const {createTask}=await import('../src/task.js'),{createRootOwner,normalizeConstraints,normalizeRootBudget}=await import('../src/project-turn.js');
 const f=await fixture(t),root=createTask({home:f.home,input:'observe',models:f.models,flow:'unified',constraints:normalizeConstraints(),budget:normalizeRootBudget()});
 const owner=createRootOwner(root);root.record.projectOperation={commandId:'current-operation',childTaskIds:['inherited-task']};root.record.deliveryRef={sources:[{taskId:'inherited-task',relation:'inherited'}]};
 assert.deepEqual(owner.executorCapabilities(),[]);
 assert.throws(()=>owner.registerTask({record:{id:'inherited-task',rootTaskId:'previous-root',project:{commandId:'previous-operation'}},runtimes:new Set()}),{code:'ROOT_CHILD'});
 assert.deepEqual(owner.executorCapabilities(),[]);assert.equal(f.calls.length,0);
});
test('capability flags follow the live work binding and preparation or review stage',async t=>{
 const {managed}=await import('./helpers/agent-sync-fixture.js'),{createRuntime}=await import('../src/pi-runtime.js');
 const f=await fixture(t),work=await managed(t,{scope:['a.txt'],readScope:['a.txt']});
 const runtime=await createRuntime({home:f.home,cwd:work.project,modelRef:f.models.main,useFrozenSkills:true,toolDefinitions:work.definitions,getWorkspaceAuthority:()=>work.binding.current});
 try {
  runtime.bindTask(work.task,work.task.beginPhase('worker-prepare','member:test',f.models.main));
  const preparation=runtime.capabilities();assert.equal(preparation.permissions.readOnly,true);assert.equal(preparation.permissions.fileReadAuthorized,true);assert.equal(preparation.permissions.fileWrite,false);
  runtime.bindTask(work.task,work.task.beginPhase('worker','member:test',f.models.main));assert.equal(runtime.capabilities().permissions.fileWrite,true);
  runtime.bindTask(work.task,work.task.beginPhase('review','reviewer',f.models.main));assert.equal(runtime.capabilities().permissions.readOnly,true);assert.equal(runtime.capabilities().permissions.fileWrite,false);
  await work.v.abandonChange(work.binding.current.changeId,{requestId:'close-write'});
  work.binding.current=await work.v.beginChange({actor:'main',requestId:'readonly',intent:'observe',scope:[],readScope:['a.txt'],readOnly:true});
  runtime.bindTask(work.task,work.task.beginPhase('worker','member:test',f.models.main));
  const readonly=runtime.capabilities();assert.equal(readonly.permissions.readOnly,true);assert.equal(readonly.permissions.fileReadAuthorized,true);assert.equal(readonly.permissions.fileWrite,false);assert.equal(readonly.permissions.scriptExecution,false);
  await assert.rejects(work.call('write','refused-write',{path:'a.txt',content:'forbidden'}));assert.equal(readFileSync(join(work.project,'a.txt'),'utf8'),'base A\n');assert.equal(f.calls.length,0);
 }finally{await runtime.dispose();}
});
test('retained PROJECT member loses current capabilities at result and acceptance and regains them for feedback',{timeout:45000},async t=>{
 const {readTask}=await import('../src/task.js');
 const {repository}=await import('./helpers/git-fixture.js'),{execution}=await import('./helpers/agent-sync-fixture.js'),{saveConfig}=await import('../src/config.js'),{createTeamConfig}=await import('../src/teams.js'),{createGuiController}=await import('../src/gui-controller.js'),{projectChatState}=await import('../src/project.js'),{createProjectStaff}=await import('../src/project-staff.js');
 const repo=repository(t),plan={goal:'Deliver final A',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('final A'))process.exit(1)"]}]};
 let c,session,member,childId,failure,initialStage,memberSession;const turns={main:0,r1:0},observations=[];
 const tool=(name,args={})=>({toolCalls:[{name,args}]}),last=body=>JSON.parse(body.messages.findLast(m=>m.role==='tool').content);
 async function observe(label,active,model){
  const shown=await c.getSessionCapabilities(session.id),state=(await projectChatState(f.home,repo.project)).state;
  const assignment=Object.values(state.staffAssignments).find(a=>a.dispatchId===member);childId=assignment.taskId;
  const staff=createProjectStaff({read:()=>state,update(){throw Error('read-only probe');}}),check=()=>staff.checkWork({taskId:childId,role:'member:'+member});
  const current=shown.executors.filter(x=>x.source.role==='member:'+member);
  if(active){assert.doesNotThrow(check);assert.equal(current.length,1);assert.deepEqual(current[0],model);assert.equal(model.permissions.fileReadAuthorized,true);assert.equal(model.permissions.fileWrite,true);}
  else {assert.throws(check,{code:'PROJECT_STAFF'});assert.deepEqual(current,[],'retained inactive member must not be listed as a current executor');}
  observations.push({label,assignment:assignment.status,projected:current.length,stage:model?.source.stageId});
 }
 const f=await fixture(t,async({body})=>{try {
  const n=++turns[body.model];
  if(body.model==='r1'){
   if(n===1)return {text:'I understand the original task and authorized file scope.'};
   if(n===2)return tool('read',{path:'a.txt'});
   if(n===3)return tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'candidate A'}]});
   if(n===4||n===6)return tool('get_capabilities');
   if(n===5){const model=last(body);await observe('active',true,model);initialStage=model.source.stageId;return {text:'Candidate A ready for review'};}
   if(n===7){const model=last(body);await observe('feedback-active',true,model);assert.notEqual(model.source.stageId,initialStage);return tool('edit',{path:'a.txt',edits:[{oldText:'candidate A',newText:'final A'}]});}
   return {text:'Final A ready for acceptance'};
  }
  if(n===1)return tool('start_work',{action:'start',reason:'implement',plan});
  if(n===2)return tool('project_staff',{action:'appoint',input:{id:'writer',responsibility:'Deliver a.txt',scope:['a.txt'],models:['fixture/r1'],need:'deliverable',reason:'Own the requested file'}});
  if(n===3)return tool('delegate',{staffId:'writer',model:'fixture/r1',scope:['a.txt'],readScope:['a.txt'],assignment:'Deliver the requested a.txt change',reason:'Assigned file author'});
  if(n===4){member=last(body).memberId;return tool('collect',{memberId:member});}
  if(n===5){await observe('result',false);const child=readTask(f.home,childId);memberSession=child.members.find(m=>m.memberId===member).sessionFile;assert.equal(typeof memberSession,'string');return tool('feedback',{memberId:member,feedback:'Replace candidate A with final A in the same reviewed draft.'});}
  if(n===6)return tool('collect',{memberId:member});
  if(n===7){await observe('feedback-result',false);const child=readTask(f.home,childId);assert.equal(child.members.find(m=>m.memberId===member).sessionFile,memberSession);return tool('accept_change',{memberId:member});}
  const child=readTask(f.home,childId);if(child.members.find(m=>m.memberId===member).status!=='accepted'&&n<10)return tool('accept_change',{memberId:member});
  await observe('accepted',false);return {text:'Delivered final A'};
 }catch(error){failure??=error;return {text:'Fixture observation failed: '+error.message};}});
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,work:{execution}},'Fixture','7c8094cd-3476-4bfa-8f53-055d87972896'));c=await createGuiController({home:f.home,cwd:repo.project});
 const settle=async id=>{for(let n=0;n<1000;n++){const value=await c.task(id);if(value.status!=='running')return value;await new Promise(r=>setTimeout(r,10));}throw Error('Lifecycle task did not settle');};
 try {session=await c.action('session.create',{project:repo.project});const submitted=await c.action('task.submit',{sessionId:session.id,input:'Deliver final A',submissionId:'lifecycle',protocolVersion:1}),source=await settle(submitted.taskId);
  const confirmed=await c.action('task.confirmWork',{sessionId:session.id,submissionId:'lifecycle-confirm',protocolVersion:1,proposalRef:source.proposalRef}),final=await settle(confirmed.taskId);
  if(failure)throw failure;assert.equal(final.status,'completed',final.error);assert.deepEqual(observations.map(x=>x.label),['active','result','feedback-active','feedback-result','accepted']);
  assert.equal(observations.at(-1).assignment,'disposed');t.diagnostic(JSON.stringify({observations,requests:f.calls.length}));
 }finally{await c.close();}
});
test('actual shipped checker runs detached with good and bad links and no runtime dependency installation',()=>{
 const root=mkdtempSync(join(tmpdir(),'cothink-builtin-detached-'));try {
  const checker=join(root,'checker.mjs');cpSync(new URL('../resources/builtin-skills/doc-maintenance/scripts/doc-maintenance.mjs',import.meta.url),checker);
  const project=join(root,'project');mkdirSync(project);writeFileSync(join(project,'target.md'),'# Target\n');
  for(const [link,exit,code]of [['target.md#target',0,null],['missing.md',1,'LINK_MISSING'],['target.md#missing',1,'LINK_ANCHOR']]){
   const input='# Readme\n\n[Reference]('+link+')\n';writeFileSync(join(project,'README.md'),input);
   const result=spawnSync(process.execPath,[checker,'check','--root',project,'--json'],{cwd:project,encoding:'utf8',env:{PATH:'',NODE_PATH:'',HOME:root}});
   assert.equal(result.status,exit,result.stderr);const parsed=JSON.parse(result.stdout);if(code)assert.equal(parsed.errors[0].code,code);else assert.equal(parsed.ok,true);
   assert.equal(readFileSync(join(project,'README.md'),'utf8'),input);assert.equal(existsSync(join(root,'node_modules')),false);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('missing packaged checker is diagnosed without installing or silently dropping the builtin',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cothink-builtin-missing-'));try {
  mkdirSync(join(root,'src'));cpSync(new URL('../src/builtin-skills.js',import.meta.url),join(root,'src/builtin-skills.mjs'));
  cpSync(new URL('../resources/',import.meta.url),join(root,'resources'),{recursive:true});
  rmSync(join(root,'resources/builtin-skills/doc-maintenance/scripts/doc-maintenance.mjs'));
  const {pathToFileURL}=await import('node:url'),{resolveBuiltinSkills}=await import(pathToFileURL(join(root,'src/builtin-skills.mjs')));
  const found=resolveBuiltinSkills({});assert.ok(found.diagnostics.some(x=>x.name==='doc-maintenance'));assert.ok(!found.skills.some(x=>x.name==='doc-maintenance'));
  assert.equal(existsSync(join(root,'node_modules')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('builtin checker runs good and bad links in actual managed offline Docker copies',{timeout:60000},async t=>{
 const {managed,execution}=await import('./helpers/agent-sync-fixture.js'),{resolveBuiltinSkills}=await import('../src/builtin-skills.js'),{freezeAnswerSkills}=await import('../src/context.js'),{freezeTaskSkillResources}=await import('../src/skill-resources.js'),{createPluginWork}=await import('../src/plugin-work.js');
 const f=await managed(t,{execution,scope:['README.md'],readScope:['.']});f.task.record.project={id:'builtin-checker-proof'};
 f.task.frozenSkills=freezeAnswerSkills({cwd:f.project,home:f.home,paths:resolveBuiltinSkills({}).skills.map(s=>s.path),project:true});freezeTaskSkillResources({task:f.task});
 const plugin=await createPluginWork({task:f.task,versioning:f.v,execution});t.after(()=>plugin.close());
 const defs=plugin.resourceTools({actor:'main',binding:f.binding}),call=async(name,id,args)=>JSON.parse((await defs.find(x=>x.name===name).execute(id,args,f.task.signal)).content[0].text);
 for(const [name,link,expected]of [['good','a.txt',true],['bad','absent.txt',false]]){
  await f.call('write','write-'+name,{path:'README.md',content:'# Readme\n\n[File]('+link+')\n'});
  const result=await call('resource_exec','check-'+name,{command:'node /resources/doc-maintenance/scripts/doc-maintenance.mjs check --root /workspace --files README.md --json'});
  assert.equal(result.exitCode,expected?0:1,JSON.stringify(result));assert.equal(JSON.parse(result.stdout).ok,expected);assert.equal(result.files.length,0);
  await call('resource_result','inspect-'+name,{resultId:result.resultId,decision:'inspect'});
  await call('resource_result','reject-'+name,{resultId:result.resultId,decision:'reject',reason:'Read-only checker evidence reviewed; no file output to import'});
 }
 plugin.assertHandled();assert.equal(readFileSync(join(f.project,'a.txt'),'utf8'),'base A\n');
 t.diagnostic(JSON.stringify({image:execution.image,network:execution.network,requests:f.task.record.requestIds.length,results:f.task.record.tools.filter(x=>x.kind==='employee_script_result').map(x=>({status:x.status,exitCode:x.executions?.at(-1)?.exitCode,treatment:x.treatment?.decision}))}));
});
