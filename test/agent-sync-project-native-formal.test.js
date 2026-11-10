import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {invoke} from './helpers/cli-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
import { evidence, installNative, listTasks, runtime, saveConfig, tool } from "./project-native.fixture.js";

test('PROJECT formal employee uses its allowed same-model original native helper and root accepts reviewed file',{timeout:120000},async t=>{
 const repo=repository(t);let rootCalls=0,employeeCalls=0,helperCalls=0,memberId,helperId,fixtureError;
 const f=await fixture(t,({body})=>{
  try{
   const system=String(body.messages.find(message=>message.role==='system')?.content??''),names=(body.tools??[]).map(item=>item.function.name),last=body.messages.findLast(message=>message.role==='tool')?.content??'';
   if(system.includes('You are helper ')){
    assert.equal(body.model,'r1','helper must use the actual employee-approved model');
    if(++helperCalls===1)return tool('write',{path:'a.txt',content:'EMPLOYEE_NATIVE'});
    assert.match(last,/successfully/i);return {text:'Original employee-owned native helper wrote EMPLOYEE_NATIVE'};
   }
   if(body.model==='main'){
    switch(++rootCalls){
     case 1:return tool('project_staff',{action:'appoint',input:{id:'native-writer',responsibility:'Own the checked a.txt deliverable',models:['fixture/r1'],scope:['a.txt'],need:'deliverable',reason:'Employee has the approved native helper model and exact file scope'}});
     case 2:return tool('delegate',{staffId:'native-writer',model:'fixture/r1',scope:['a.txt'],readScope:['a.txt'],assignment:'Use the original installed native helper on your allowed fixture/r1 model to write a.txt=EMPLOYEE_NATIVE; inspect and adopt its exact file before handing back',reason:'The designated employee owns the original deliverable and creator review'});
     case 3:memberId=JSON.parse(last).memberId;assert.ok(memberId,last);return tool('collect',{memberId});
     case 4:assert.match(last,/EMPLOYEE_NATIVE/);return tool('accept_change',{memberId});
     default:if(JSON.parse(last).status==='review_required')return tool('accept_change',{memberId});assert.equal(JSON.parse(last).status,'accepted',last);return {text:'Root independently inspected and accepted the employee native artifact.'};
    }
   }
   assert.equal(body.model,'r1');
   if(!names.includes('project_plugin_0_subagent'))return {text:'The original task is one exact a.txt artifact. I will inspect the given scope, use only my approved r1 route, and review any native child result myself before returning it.'};
   switch(++employeeCalls){
    case 1:return tool('project_plugin_0_subagent',{agent:'native-employee',model:'fixture/r1',task:'Write a.txt=EMPLOYEE_NATIVE in the independent creator-owned source',async:false,artifacts:false});
    case 2:{const match=last.match(/"helperId":"([a-f0-9-]+)"/);assert.ok(match,last);helperId=match[1];return tool('cothink_helper_result',{helperId,decision:'inspect'});}
    case 3:assert.match(last,/EMPLOYEE_NATIVE|RU1QTE9ZRU/);return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Actual employee inspected the complete original/new a.txt diff and owns its scope'});
    default:assert.equal(JSON.parse(last).status,'applied',last);return {text:'EMPLOYEE_NATIVE is implemented in my employee draft after explicit native helper inspection and adoption; ready for root checks.'};
   }
  }catch(error){fixtureError=error;return {text:'Unexpected employee native integration result.'};}
 });
 installNative(f);mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-employee.md'),'---\nname: native-employee\ndescription: Original employee-owned native child\nmodel: fixture/r1\ntools: read, write, edit, ls\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nFollow the original task and creator file scope.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,projectPluginRuntime:runtime}});
 const plan=join(f.home,'plan.json');writeFileSync(plan,JSON.stringify({goal:'Designated employee must use its approved same-model original native helper and explicitly adopt a.txt=EMPLOYEE_NATIVE before root acceptance',scope:['a.txt'],plugins:['pi-subagents'],budget:{maxCalls:18},deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='EMPLOYEE_NATIVE')process.exit(1)"]}]}));
 const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);const task=listTasks(f.home)[0];evidence('project-native-employee-run.json',run);if(task)evidence('project-native-employee-task.json',task);
 if(fixtureError)throw fixtureError;assert.equal(run.code,0,run.stdout+run.stderr);const project=JSON.parse(run.stdout);assert.equal(project.status,'completed',run.stdout);
 const helper=task.work.helpers.find(item=>item.helperId===helperId);assert.equal(helper.parentActorId,'member:'+memberId);assert.equal(helper.model.modelId,'r1');assert.equal(helper.treatment.decision,'adopted');assert.equal(helper.import.status,'applied');assert.equal(helper.status,'completed');assert.equal(helperCalls,2);
 const rootStage=task.stages.find(stage=>stage.role==='main'&&stage.phase==='work'),employeeStage=task.stages.find(stage=>stage.role==='member:'+memberId&&stage.phase==='worker'),helperStage=task.stages.find(stage=>stage.nativeLaunchId===helperId);assert.ok(rootStage&&employeeStage&&helperStage);assert.equal(helperStage.creatorRole,employeeStage.role);assert.equal(new Set([rootStage.sessionId,employeeStage.sessionId,helperStage.sessionId]).size,3);
 assert.ok(task.work.capacity.every(sample=>sample.active<=2));assert.equal(task.work.capacity.at(-1).active,0);assert.equal(project.usage.calls,f.calls.length);assert.equal(task.usage.calls,f.calls.length);assert.equal(task.work.acceptance.filter(item=>item.status==='accepted').length,1);assert.equal(readFileSync(join(task.work.resultWorkspace,'a.txt'),'utf8'),'EMPLOYEE_NATIVE');assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
});
