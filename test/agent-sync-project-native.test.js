import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {invoke} from './helpers/cli-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('..',import.meta.url)));
const {saveConfig}=await import(pathToFileURL(join(productRoot,'src/config.js')));
const {listTasks}=await import(pathToFileURL(join(productRoot,'src/task.js')));
const tool=(name,args={})=>({toolCalls:[{name,args}]});
const runtime=process.env.COTHINK_TEST_PLUGIN_RUNTIME;
function installNative(f){
 const root=process.env.COTHINK_TEST_NATIVE_HOME;if(!root)throw Error('Set COTHINK_TEST_NATIVE_HOME to a prepared Pi directory containing original pi-subagents@0.84.0 npm/ and settings.json; prepare it with the normal cothink install command.');
 cpSync(join(root,'npm'),join(f.home,'pi/npm'),{recursive:true});cpSync(join(root,'settings.json'),join(f.home,'pi/settings.json'));
}
function evidence(name,value){const directory=process.env.COTHINK_TEST_EVIDENCE_DIR;if(!directory)return;mkdirSync(directory,{recursive:true});writeFileSync(join(directory,name),JSON.stringify(value,null,2));}

test('PROJECT original native frontend uses host model journal, independent source and reviewed public acceptance',{timeout:120000},async t=>{
 const repo=repository(t);let sourceSkill;let rootCalls=0,helperCalls=0,helperId,fixtureError;
 const f=await fixture(t,({body})=>{
  try{
   const system=String(body.messages.find(m=>m.role==='system')?.content??''),last=body.messages.findLast(m=>m.role==='tool')?.content??'';
   if(system.includes('You are helper ')){
    helperCalls++;if(helperCalls===1)return tool('read',{path:'/resources/native-method/references/value.txt'});
    if(helperCalls===2){assert.match(last,/NATIVE_PROJECT/);assert.doesNotMatch(last,/CHANGED_AFTER_LAUNCH/);return tool('bash',{command:'node /resources/native-method/scripts/write.cjs'});}
    if(helperCalls===3){assert.match(last,/exitCode.*0/);return tool('write',{path:'./a.txt',content:'NATIVE_PROJECT'});}
    if(helperCalls===4){assert.match(last,/successfully/i);const source=listTasks(f.home)[0].work.helpers[0].native.containerSource;return tool('write',{path:source+'/a.txt',content:'NATIVE_PROJECT'});}
    if(helperCalls===5){assert.match(last,/successfully/i);return tool('write',{path:'/native-work/00000000-0000-0000-0000-000000000000/source/a.txt',content:'ESCAPE'});}
    assert.match(last,/outside its own source copy/);return {text:'Native helper wrote exact artifact; relative and own absolute paths work, foreign copy is denied'};
   }
   switch(++rootCalls){
    case 1:writeFileSync(join(sourceSkill,'references/value.txt'),'CHANGED_AFTER_LAUNCH');return tool('next_change',{reason:'Implement exact file through original plugin helper',scope:['a.txt'],readScope:['a.txt']});
    case 2:return tool('project_plugin_0_subagent',{agent:'native-project',model:'fixture/main',task:'Write a.txt=NATIVE_PROJECT',async:false,artifacts:false});
    case 3:{const match=last.match(/"helperId":"([a-f0-9-]+)"/);assert.ok(match,last);helperId=match[1];return tool('cothink_helper_result',{helperId,decision:'inspect'});}
    case 4:assert.match(last,/NATIVE_PROJECT|TkFUSVZFX1BST0pFQ1Q/);return tool('cothink_helper_result',{helperId,decision:'adopt',reason:'Inspected exact original/new file bytes'});
    case 5:assert.equal(JSON.parse(last).status,'applied',last);return tool('prepare_change');
    case 6:return tool('accept_change');
    case 7:return tool('accept_change');
    default:assert.equal(JSON.parse(last).status,'accepted',last);return {text:'Original native helper reviewed and accepted.'};
   }
  }catch(error){fixtureError=error;return {text:'Unexpected native result; stop fixture.'};}
 });
 // Reuse the real installed compatibility-hashed package, never a replacement engine.
 installNative(f);
 mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-project.md'),'---\nname: native-project\ndescription: Original native PROJECT acceptance agent\nmodel: fixture/main\ntools: read, write, edit, ls, bash\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nPerform the requested file work.\n');
 sourceSkill=join(f.home,'native-method');mkdirSync(join(sourceSkill,'references'),{recursive:true});mkdirSync(join(sourceSkill,'scripts'));writeFileSync(join(sourceSkill,'SKILL.md'),'---\nname: native-method\ndescription: Frozen native helper file recipe\n---\nRead [value](references/value.txt) and run `scripts/write.cjs`.\n');writeFileSync(join(sourceSkill,'references/value.txt'),'NATIVE_PROJECT');writeFileSync(join(sourceSkill,'scripts/write.cjs'),"const fs=require('fs');if(fs.existsSync('/native-work')||fs.existsSync('/plugins'))throw Error('Helper shell escaped its isolated source');fs.writeFileSync('a.txt',fs.readFileSync(require('path').join(__dirname,'../references/value.txt')));");
 saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[sourceSkill]},work:{execution,projectPluginRuntime:runtime}});
 const plan=join(f.home,'plan.json');writeFileSync(plan,JSON.stringify({goal:'Write a.txt=NATIVE_PROJECT using the installed native plugin helper',scope:['a.txt'],plugins:['pi-subagents'],budget:{maxCalls:14},deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='NATIVE_PROJECT')process.exit(1)"]}]}));
 const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);
 evidence('project-native-latest-run.json',run);const task=listTasks(f.home)[0];if(task)evidence('project-native-latest-task.json',task);
 if(fixtureError)throw fixtureError;assert.equal(run.code,0,run.stdout+run.stderr);const state=JSON.parse(run.stdout);assert.equal(state.status,'completed',run.stdout);
 assert.equal(helperCalls,6);assert.equal(task.work.helpers.length,1);const child=task.work.helpers[0];assert.equal(child.status,'completed');assert.equal(child.treatment.decision,'adopted');assert.ok(child.native.sessionId);assert.equal(child.parentActorId,'main');assert.equal(task.stages.find(s=>s.id===child.stage.id).role,'helper:'+child.helperId);
 assert.equal(state.usage.calls,f.calls.length);assert.equal(readFileSync(join(task.work.resultWorkspace,'a.txt'),'utf8'),'NATIVE_PROJECT');assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
});

test('PROJECT original background parallel workflow continues after tool return and shares two seats',{timeout:120000},async t=>{
 const repo=repository(t);let rootCalls=0,helperCalls=0,fixtureError,releaseBackground,returned=false,results=[],index=0;
 const rootReturned=new Promise(resolve=>releaseBackground=resolve);
 const f=await fixture(t,async({body})=>{
  try{
   const system=String(body.messages.find(m=>m.role==='system')?.content??''),last=body.messages.findLast(m=>m.role==='tool')?.content??'';
   if(system.includes('You are helper ')){
    helperCalls++;await rootReturned;
    if(JSON.stringify(body.messages).includes('PARALLEL_WRITER')&&body.messages.at(-1).role==='user')return tool('write',{path:'a.txt',content:'BACKGROUND_NATIVE'});
    return {text:'Original parallel child completed after frontend returned'};
   }
   rootCalls++;
   if(rootCalls===1)return tool('next_change',{reason:'Actual background original workflow',scope:['a.txt'],readScope:['a.txt']});
   if(rootCalls===2)return tool('project_plugin_0_subagent',{workflow:'parallel',args:{tasks:[{agent:'native-project',task:'PARALLEL_WRITER write a.txt=BACKGROUND_NATIVE',model:'fixture/main'},{agent:'native-project',task:'PARALLEL_READER explain assigned task',model:'fixture/main'}]},model:'fixture/main',async:true});
   if(rootCalls===3){assert.match(last,/started|background|async|nativeHostResults/i);returned=true;releaseBackground();return tool('project_plugin_0_bg_wait',{all:true});}
   if(rootCalls===4){for(const line of last.split('\n'))try{const value=JSON.parse(line);if(value.nativeHostResults)results=value.nativeHostResults.filter(r=>r.parentActorId==='main'&&!r.treatment);}catch{}assert.equal(results.length,2,last);}
   if(index<results.length)return tool('cothink_helper_result',{helperId:results[index++].helperId,decision:'adopt',reason:'Inspected native background file/text result after original writer terminal'});
   if(!last.includes('"status":"accepted"'))return tool('accept_change');
   return {text:'Reviewed background parallel native work and accepted file.'};
  }catch(error){fixtureError=error;releaseBackground();return {text:'Unexpected background result.'};}
 });
 installNative(f);mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-project.md'),'---\nname: native-project\ndescription: Actual original background workflow child\nmodel: fixture/main\ntools: read, write, edit, ls, bash\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nDo the requested file work.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,projectPluginRuntime:runtime}});
 const plan=join(f.home,'plan.json');writeFileSync(plan,JSON.stringify({goal:'Use original background parallel workflow to write a.txt=BACKGROUND_NATIVE',scope:['a.txt'],plugins:['pi-subagents'],budget:{maxCalls:16},deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='BACKGROUND_NATIVE')process.exit(1)"]}]}));
 const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);evidence('project-native-background-run.json',run);const task=listTasks(f.home)[0];if(task)evidence('project-native-background-task.json',task);
 if(fixtureError)throw fixtureError;assert.equal(run.code,0,run.stdout+run.stderr);const state=JSON.parse(run.stdout);assert.equal(state.status,'completed');assert.equal(returned,true);assert.equal(helperCalls,3);assert.ok(task.work.capacity.every(s=>s.active<=2));assert.equal(task.work.capacity.at(-1).active,0);assert.equal(task.work.helpers.length,2);assert.ok(task.work.helpers.every(h=>h.treatment?.decision==='adopted'&&h.stoppedAt));assert.equal(state.usage.calls,f.calls.length);assert.equal(readFileSync(join(task.work.resultWorkspace,'a.txt'),'utf8'),'BACKGROUND_NATIVE');
});

test('PROJECT parent SIGINT stops original native cgroup and retains partial files and unknown sent request',{timeout:120000},async t=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const repo=repository(t);let rootCalls=0,helperCalls=0,child;
 const f=await fixture(t,({body})=>{
  const system=String(body.messages.find(m=>m.role==='system')?.content??'');
  if(system.includes('You are helper ')){
   if(++helperCalls===1)return tool('write',{path:'a.txt',content:'PARTIAL_BEFORE_CANCEL'});
   setImmediate(()=>child.kill('SIGINT'));return null;
  }
  if(++rootCalls===1)return tool('next_change',{reason:'Original native cancellation evidence',scope:['a.txt'],readScope:['a.txt']});
  return tool('project_plugin_0_subagent',{agent:'native-project',model:'fixture/main',task:'Write partial a.txt then wait',async:false,artifacts:false});
 });
 installNative(f);mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-project.md'),'---\nname: native-project\ndescription: Actual cancellation child\nmodel: fixture/main\ntools: read, write\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nDo assigned work.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,projectPluginRuntime:runtime}});
 const plan=join(f.home,'plan.json');writeFileSync(plan,JSON.stringify({goal:'Use original native helper and retain partial work on cancellation',scope:['a.txt'],plugins:['pi-subagents'],budget:{maxCalls:8},deliverables:['a.txt'],checks:[{command:'node',args:['-e','process.exit(0)']}]}));
 const run=await new Promise((resolve,reject)=>{child=spawn(process.execPath,[process.env.COTHINK_TEST_CLI??join(productRoot,'bin/cothink.js'),'project','start','--file',plan,'--json'],{cwd:repo.project,env:{...process.env,COTHINK_HOME:f.home,COTHINK_NO_TTY:'1',PI_OFFLINE:'1'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});
 evidence('project-native-cancel-run.json',run);const task=listTasks(f.home)[0];evidence('project-native-cancel-task.json',task);
 assert.notEqual(run.code,0);assert.equal(helperCalls,2);assert.notEqual(task.status,'completed');const helper=task.work.helpers[0];assert.equal(helper.status,'outcome_unknown');assert.equal(helper.partialResult,true);assert.equal(readFileSync(join(helper.cwd,'a.txt'),'utf8'),'PARTIAL_BEFORE_CANCEL');assert.ok(task.usage.unknownCalls>=1);assert.ok(task.tools.filter(r=>r.kind==='project_plugin_runtime').every(r=>r.containerStoppedAt));assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');assert.equal(task.work.capacity.at(-1).active,0);
});

test('PROJECT original native parallel children compete for one remaining actual HTTP call',{timeout:120000},async t=>{
 const repo=repository(t);let rootCalls=0,helperCalls=0;
 const f=await fixture(t,({body})=>{const system=String(body.messages.find(m=>m.role==='system')?.content??'');if(system.includes('You are helper ')){helperCalls++;return {text:'Exactly one physical helper send admitted.'};}if(++rootCalls===1)return tool('next_change',{reason:'Native budget race within one work',scope:['a.txt'],readScope:['a.txt']});return tool('project_plugin_0_subagent',{workflow:'parallel',args:{tasks:[{agent:'native-project',task:'RACE_ONE answer briefly',model:'fixture/main'},{agent:'native-project',task:'RACE_TWO answer briefly',model:'fixture/main'}]},model:'fixture/main',async:false});});
 installNative(f);mkdirSync(join(f.home,'pi/agents'),{recursive:true});writeFileSync(join(f.home,'pi/agents/native-project.md'),'---\nname: native-project\ndescription: Actual original budget-race child\nmodel: fixture/main\ntools: read\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nAnswer briefly.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,projectPluginRuntime:runtime}});const plan=join(f.home,'plan.json');writeFileSync(plan,JSON.stringify({goal:'Two original native helpers may compete for remaining project call; stop at budget',scope:['a.txt'],plugins:['pi-subagents'],budget:{maxCalls:3},deliverables:['a.txt'],checks:[{command:'node',args:['-e','process.exit(0)']}]}));
 const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);const task=listTasks(f.home)[0];evidence('project-native-budget-task.json',task);evidence('project-native-budget-run.json',run);
 assert.notEqual(run.code,0);assert.equal(helperCalls,1);assert.equal(f.calls.length,3);assert.equal(task.usage.calls,3);assert.equal(task.work.helpers.length,2);assert.ok(task.work.helpers.some(h=>h.status==='failed'||h.status==='outcome_unknown'));assert.ok(task.work.capacity.every(s=>s.active<=2));assert.equal(readFileSync(join(repo.project,'a.txt'),'utf8'),'base A\n');
});

test('PROJECT original nested native child reads creator overlay and returns files through its actual creator',{timeout:120000},async t=>{
 const repo=repository(t);let rootCalls=0,parentCalls=0,leafCalls=0,fixtureError,parentId,leafId;
 const f=await fixture(t,({body})=>{try{const system=String(body.messages.find(m=>m.role==='system')?.content??''),last=body.messages.findLast(m=>m.role==='tool')?.content??'';
  if(system.includes('You are helper ')){
   if(system.includes('PARENT_NATIVE_MARKER')){switch(++parentCalls){case 1:return tool('write',{path:'a.txt',content:'PARENT_OVERLAY'});case 2:return tool('subagent',{agent:'native-leaf',task:'Read a.txt creator overlay then write NESTED_FINAL',model:'fixture/main',async:false,artifacts:false});case 3:{const match=last.match(/"helperId":"([a-f0-9-]+)"/);assert.ok(match,last);leafId=match[1];return tool('cothink_helper_result',{helperId:leafId,decision:'adopt',reason:'Actual creator inspected grandchild exact overlay and file result'});}default:return {text:'Creator adopted native child file into its own overlay'};}}
   if(++leafCalls===1)return tool('read',{path:'a.txt'});if(leafCalls===2){assert.match(last,/PARENT_OVERLAY/);return tool('write',{path:'a.txt',content:'NESTED_FINAL'});}return {text:'Leaf used actual creator overlay'};
  }
  switch(++rootCalls){case 1:return tool('next_change',{reason:'Original nested creator relationship',scope:['a.txt'],readScope:['a.txt']});case 2:return tool('project_plugin_0_subagent',{agent:'native-parent',model:'fixture/main',task:'Create overlay then use original native-leaf subagent and explicitly adopt it',async:false,artifacts:false});case 3:{const match=last.match(/"helperId":"([a-f0-9-]+)"/);assert.ok(match,last);parentId=match[1];return tool('cothink_helper_result',{helperId:parentId,decision:'adopt',reason:'Root reviewed creator overlay containing explicitly adopted grandchild'});}default:if(!last.includes('"status":"accepted"'))return tool('accept_change');return {text:'Nested original native result accepted'};}
 }catch(error){fixtureError=error;return {text:'Unexpected nested result'};}});
 installNative(f);mkdirSync(join(f.home,'pi/agents'),{recursive:true});
 for(const [name,nested]of [['native-parent',true],['native-leaf',false]])writeFileSync(join(f.home,'pi/agents',name+'.md'),'---\nname: '+name+'\ndescription: Actual native nested creator\nmodel: fixture/main\ntools: read, write, edit, ls'+(nested?', subagent':'')+'\nallowNestedSubagents: '+nested+'\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\n'+(nested?'PARENT_NATIVE_MARKER':'LEAF_NATIVE_MARKER')+'\nDo assigned work and review child results.\n');
 saveConfig(f.home,{formatVersion:2,...f.models,work:{execution,projectPluginRuntime:runtime}});const plan=join(f.home,'plan.json');writeFileSync(plan,JSON.stringify({goal:'Original nested native creator must adopt leaf overlay then root accepts a.txt=NESTED_FINAL',scope:['a.txt'],plugins:['pi-subagents'],budget:{maxCalls:20},deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='NESTED_FINAL')process.exit(1)"]}]}));
 const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);const task=listTasks(f.home)[0];evidence('project-native-nested-task.json',task);evidence('project-native-nested-run.json',run);if(fixtureError)throw fixtureError;assert.equal(run.code,0,run.stdout+run.stderr);const parent=task.work.helpers.find(h=>h.helperId===parentId),leaf=task.work.helpers.find(h=>h.helperId===leafId);assert.equal(leaf.parentActorId,parentId);assert.equal(leaf.treatment.destinationHelperId,parentId);assert.equal(Buffer.from(leaf.snapshot.files['a.txt'].contentBase64,'base64').toString(),'PARENT_OVERLAY');assert.equal(readFileSync(join(task.work.resultWorkspace,'a.txt'),'utf8'),'NESTED_FINAL');assert.ok(task.work.capacity.every(s=>s.active<=2));
});

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
