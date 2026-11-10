import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync,mkdtempSync,rmSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fixture} from './helpers/pi-fixture.js';
import { fixtureConversation, prepareSubmit, teamId } from './helpers/gui-controller-fixture.js';
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
test('read_skill accepts its advertised URI and rejects paths outside the selected frozen skill',async t=>{
 const name='frontend-design',uri='skill:frontend-design/SKILL.md';
 const paths={
  uri,relative:'SKILL.md',reference:'skill:frontend-design/references/layout.md',
  cross:'skill:doc-maintenance/SKILL.md',escape:'skill:frontend-design/../doc-maintenance/SKILL.md',
  malformed:'skill:frontend-design//SKILL.md',driveRelative:'skill:frontend-design/C:outside.md',
  absent:'skill:frontend-design/references/absent.md',
 };
 const toolCalls=Object.entries(paths).map(([id,path])=>({id,name:'read_skill',args:{name,path}}));
 const f=await fixture(t,(_,n)=>n===1?{toolCalls}:{text:'Skill read complete'});
 const dir=join(f.home,name);mkdirSync(join(dir,'references'),{recursive:true});
 writeFileSync(join(dir,'SKILL.md'),'---\nname: frontend-design\ndescription: Design guidance\n---\nFROZEN_DESIGN_BODY');
 writeFileSync(join(dir,'references','layout.md'),'FROZEN_LAYOUT_REFERENCE');
 const o=opts(f);o.frozenConfig.piResources={skills:[dir]};const task=await runProjectTurn(o);
 assert.equal(task.record.status,'completed',task.record.error);
 assert.ok(f.calls[0].body.messages.some(m=>m.role==='system'&&m.content.includes(uri)));
 const results=Object.fromEntries(f.calls[1].body.messages.filter(m=>m.role==='tool').map(m=>[m.tool_call_id,m.content]));
 assert.match(results.uri,/FROZEN_DESIGN_BODY/);
 assert.deepEqual(JSON.parse(results.uri),JSON.parse(results.relative));
 assert.match(results.reference,/FROZEN_LAYOUT_REFERENCE/);
 for(const id of ['cross','escape','malformed','driveRelative'])assert.match(results[id],/Invalid skill resource path/);
 assert.match(results.absent,/Resource was not selected in the task freeze/);
 assert.deepEqual(task.record.tools.filter(x=>x.kind==='skill_resource_read').map(x=>x.resourcePath),['SKILL.md','SKILL.md','references/layout.md']);
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
test('generic restore never refreshes sources and rejects manifest conflict or corrupted frozen bytes',async t=>{
 const {freezeTaskSkillResources,readTaskSkillResource,getTaskSkillResources,readFrozenSkill}=await import('../src/skill-resources.js');
 const f=await fixture(t),task=await runProjectTurn(opts(f)),record=structuredClone(task.record),saved=record.skillResources[0];
 const restored={home:f.home,record,save(){throw Error('restoration must not resave');}};
 freezeTaskSkillResources({task:restored});assert.equal(record.work,undefined);assert.match(readTaskSkillResource(restored,'skill:doc-maintenance/SKILL.md').bytes.toString(),/Doc Maintenance/);
 assert.throws(()=>getTaskSkillResources({skillResources:null}),{code:'SKILL_CHANGED'});
 assert.throws(()=>getTaskSkillResources({skillResources:record.skillResources,work:{skillResources:[]}}),{code:'SKILL_CHANGED'});
 assert.equal(getTaskSkillResources({work:{skillResources:record.skillResources}}).length,2);
 writeFileSync(saved.path,'changed frozen bytes');assert.throws(()=>freezeTaskSkillResources({task:restored}),{code:'SKILL_CHANGED'});
 const running={...restored,record:{...record,status:'running'}};
 assert.throws(()=>readFrozenSkill(running,{name:saved.name,path:'skill:'+saved.name+'/SKILL.md'}),{code:'SKILL_CHANGED'});
});
test('shared settings capability DTO reports real limits and config save survives reload',async t=>{
 const {saveConfig,loadConfig}=await import('../src/config.js'),{createTeamConfig}=await import('../src/teams.js'),{createGuiController}=await import('../src/gui-controller.js');
 const f=await fixture(t);saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Fixture',teamId));
 const c=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>c.close());const session=await fixtureConversation(t,c);
 const capability=await c.getSessionCapabilities(session.id);assert.equal(capability.version,1);assert.equal(capability.skills.length,2);assert.equal(capability.permissions.fileWrite,false);assert.equal(capability.environment.contextToolsAvailable,true);assert.doesNotMatch(JSON.stringify(capability),new RegExp(f.home));
 await c.action('settings.builtinSkills',{builtinSkills:{disabled:['doc-maintenance']}});assert.deepEqual(loadConfig(f.home).piResources.builtinSkills,{disabled:['doc-maintenance']});
 assert.deepEqual((await c.getSessionCapabilities(session.id)).skills.map(x=>x.name),['context-management']);assert.equal(f.calls.length,0);
 await assert.rejects(c.action('settings.builtinSkills',{builtinSkills:{disabled:['Doc-maintenance']}}),/builtin|内置/);
});
test('model capability tool and settings read the same active host facts',async t=>{
 const {saveConfig}=await import('../src/config.js'),{createTeamConfig}=await import('../src/teams.js'),{createGuiController}=await import('../src/gui-controller.js');let c,session,observed;
 const f=await fixture(t,async({body},n)=>{if(n===1)return {toolCalls:[{name:'get_capabilities',args:{}}]};observed=JSON.parse(body.messages.findLast(m=>m.role==='tool').content);assert.deepEqual(observed,await c.getSessionCapabilities(session.id));return {text:'Capabilities inspected'};});
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Fixture',teamId));c=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>c.close());session=await fixtureConversation(t,c);
 const submitted=await c.action('task.submit',await prepareSubmit(c,{sessionId:session.id,submissionId:'capabilities',input:'inspect capabilities'}));
 let task;for(let n=0;n<100;n++){task=await c.task(submitted.taskId);if(task.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(task.status,'completed',task.error);assert.equal(observed.permissions.fileWrite,false);assert.equal(observed.environment.contextOrganizationAvailable,true);assert.equal(f.calls.length,2);
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
