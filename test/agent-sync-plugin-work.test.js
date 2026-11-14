import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, chmodSync, symlinkSync, mkdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixture} from './helpers/pi-fixture.js';
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('..',import.meta.url)));
const load=path=>import(pathToFileURL(join(productRoot,path)));
import { managed, execution } from './helpers/agent-sync-fixture.js';
import { snapshotHelper, freezeHelperResult, treatHelperResult, helperBlockers } from '../src/plugin-work.js';
async function helper(f,id='helper') {
  const cwd=join(f.home,id),snapshot=await snapshotHelper({versioning:f.v,change:f.binding.current,directory:cwd});
  const h={helperId:id,parentActorId:'main',changeId:f.binding.current.changeId,cwd,snapshot,...snapshot,status:'completed',stoppedAt:new Date().toISOString()};
  f.task.record.work??={helpers:[]};f.task.record.work.helpers.push(h);return h;
}

test('script inspection preserves complete edits without repeating unchanged source snapshots',async t=>{
 const {freezeAnswerSkills}=await import('../src/context.js'),{freezeTaskSkillResources}=await import('../src/skill-resources.js');
 const {createPluginWork}=await import('../src/plugin-work.js');
 const f=await managed(t,{execution,scope:['.']}),baseline='UNCHANGED_SOURCE\n'.repeat(2000);
 await f.call('read','read-baseline',{path:'b.txt'});await f.call('write','large-baseline',{path:'b.txt',content:baseline});
 const dir=join(f.home,'result-view-skill');mkdirSync(join(dir,'scripts'),{recursive:true});
 writeFileSync(join(dir,'SKILL.md'),'---\nname: result-view\ndescription: Check or produce a file\n---\nRun scripts/run.mjs.\n');
 writeFileSync(join(dir,'scripts/run.mjs'),"import fs from 'node:fs';if(process.argv[2]==='write')fs.writeFileSync('new.txt','COMPLETE_CHANGED_BYTES');console.log('CHECK_DONE');");
 f.task.record.project={id:'recorded-project'};f.task.frozenSkills=freezeAnswerSkills({cwd:f.project,home:f.home,paths:[dir],project:true});freezeTaskSkillResources({task:f.task});
 const plugin=await createPluginWork({task:f.task,versioning:f.v,execution});t.after(()=>plugin.close());
 const defs=plugin.resourceTools({actor:'main',binding:f.binding,assertAllowed(){}});
 const call=async(name,id,args)=>JSON.parse((await defs.find(d=>d.name===name).execute(id,args,f.task.signal)).content[0].text);
 for(const change of [false,true]){
  const id=change?'write':'check',started=await call('resource_exec',id,{command:'node /resources/result-view/scripts/run.mjs'+(change?' write':'')});
  assert.equal(started.status,'completed');assert.match(started.stdout,/CHECK_DONE/);
  const before=JSON.stringify(f.task.record.tools.find(r=>r.resultId===started.resultId));
  const inspected=await call('resource_result','inspect-'+id,{resultId:started.resultId,decision:'inspect'});
  assert.equal(inspected.snapshot.files['b.txt'].contentBase64,undefined,'baseline bytes are not model inspection material');
  assert.equal(inspected.result.files['b.txt'].contentBase64,undefined,'unchanged result bytes must not be duplicated');
  assert.equal(inspected.executions[0].exitCode,0);assert.match(inspected.executions[0].stdout,/CHECK_DONE/);
  assert.equal(inspected.result.edits.length,change?1:0);
  if(change)assert.equal(Buffer.from(inspected.result.edits[0].contentBase64,'base64').toString(),'COMPLETE_CHANGED_BYTES');
  assert.equal(JSON.stringify(f.task.record.tools.find(r=>r.resultId===started.resultId)),before,'inspection never rewrites the immutable source record');
  const replay=await call('resource_exec',id,{command:'node /resources/result-view/scripts/run.mjs'+(change?' write':'')});
  assert.equal(replay.replayed,true);assert.equal(replay.result.files['b.txt'].contentBase64,undefined);
  await call('resource_result','adopt-'+id,{resultId:started.resultId,decision:'adopt',reason:'Reviewed exact file changes and successful command output'});
 }
 assert.equal(Buffer.from((await f.v.read({changeId:f.binding.current.changeId,path:'new.txt'})).contentBase64,'base64').toString(),'COMPLETE_CHANGED_BYTES');
 assert.equal(Buffer.from((await f.v.read({changeId:f.binding.current.changeId,path:'b.txt'})).contentBase64,'base64').toString(),baseline);
 plugin.assertHandled();
});
test('independent public snapshots preserve binary, add/delete/mode and require creator review before import',async t=>{
 const f=await managed(t,{scope:['.']});
 const a=await helper(f,'a'),b=await helper(f,'b');
 assert.notEqual(a.cwd,b.cwd);assert.equal(a.inputVersion,b.inputVersion);
 writeFileSync(join(a.cwd,'binary'),Buffer.from([0,255,3]));unlinkSync(join(a.cwd,'a.txt'));chmodSync(join(a.cwd,'b.txt'),0o755);
 freezeHelperResult(a);assert.equal(helperBlockers(f.task).length,2);
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'impostor',binding:f.binding,decision:'adopt',reason:'reviewed'}),{code:'HELPER_PARENT'});
 f.binding.reviewedVersion=a.inputVersion;
 await treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'adopt',reason:'reviewed bytes and intended deletion'});
 assert.equal(f.binding.reviewedVersion,null);
 const got=await f.v.read({changeId:a.changeId,path:'binary'});assert.deepEqual(Buffer.from(got.contentBase64,'base64'),Buffer.from([0,255,3]));
 assert.equal((await f.v.read({changeId:a.changeId,path:'a.txt'})).contentBase64,null);
 assert.equal((await f.v.read({changeId:a.changeId,path:'b.txt'})).mode,process.platform==='win32'?'100644':'100755');
 writeFileSync(join(b.cwd,'a.txt'),'stale sibling');freezeHelperResult(b);
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:b,actor:'main',binding:f.binding,decision:'adopt',reason:'stale'}),{code:'STALE_PRIVATE'});
 assert.equal(b.import,undefined);assert.equal(readFileSync(join(f.project,'a.txt'),'utf8'),'base A\n');
});
test('readonly text handles without synthetic import; unauthorized/link results retained and rejected',async t=>{
 const f=await managed(t,{readOnly:true,scope:[],readScope:['a.txt']});const a=await helper(f);freezeHelperResult(a);
 const result=await treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'adopt',reason:'read-only findings reviewed'});
 assert.equal(result.status,'text_adopted');assert.equal(a.import,undefined);
 const b=await helper(f,'bad');writeFileSync(join(b.cwd,'escape'),'bad');assert.throws(()=>freezeHelperResult(b),{code:'SCOPE'});assert.equal(readFileSync(join(b.cwd,'escape'),'utf8'),'bad');
 const c=await helper(f,'link');symlinkSync(join(f.project,'a.txt'),join(c.cwd,'link'));assert.throws(()=>freezeHelperResult(c),{code:'HELPER_FILE_TYPE'});
});
test('uncertain import is recovered by original request ID only; no new edit after response loss',async t=>{
 const f=await managed(t,{scope:['.']});const a=await helper(f);writeFileSync(join(a.cwd,'a.txt'),'candidate');freezeHelperResult(a);
 const edit=f.v.edit;let calls=0;f.v.edit=async(...args)=>{calls++;await edit(...args);throw Error('lost response');};
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'adopt',reason:'reviewed'}),/lost response/);
 const id=a.import.requestId;
 const inspect=f.v.inspect;
 f.v.inspect=async input=>input.requestId===id?{status:'not_found'}:inspect(input);
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'reject',reason:'Do not hide unknown import'}),{code:'OPERATION_UNKNOWN'});
 assert.equal(helperBlockers(f.task).length,1);assert.equal(a.treatment,undefined);assert.equal(calls,1);
 f.v.inspect=inspect;
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'reject',reason:'Reject after actual applied edit'}),{code:'HELPER_IMPORT_APPLIED'});
 assert.equal(a.treatment.decision,'adopted');assert.equal(a.import.status,'applied');assert.equal(helperBlockers(f.task).length,0);
 const fact=await treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:f.binding,decision:'adopt',reason:'recover'});
 assert.equal(fact.status,'applied');assert.equal(calls,1);assert.equal(a.import.requestId,id);
 assert.equal(readFileSync(join(f.binding.current.workspace,'a.txt'),'utf8'),'candidate');
 const newerBinding={current:{changeId:'new-current-change',privateVersion:'new-current-version',workspace:'new-independent-copy'},reviewedVersion:'reviewed-new-version'};const beforeNewer=structuredClone(newerBinding);
 await treatHelperResult({task:f.task,versioning:f.v,helper:a,actor:'main',binding:newerBinding,decision:'adopt',reason:'Observe original receipt only'});assert.deepEqual(newerBinding,beforeNewer);assert.equal(calls,1);
 const cancelled=await helper(f,'cancel-after-inspect');writeFileSync(join(cancelled.cwd,'cancelled-owner.txt'),'AFTER_OWNER_CANCEL');freezeHelperResult(cancelled);
 const owner=new AbortController();
 f.v.inspect=async input=>{const fact=await inspect(input);if(input.changeId===cancelled.changeId)owner.abort();return fact;};
 await assert.rejects(treatHelperResult({task:f.task,versioning:f.v,helper:cancelled,actor:'main',binding:f.binding,decision:'adopt',reason:'Cancel during current-version inspection',signal:owner.signal,
   assertAllowed:()=>{if(owner.signal.aborted)throw Object.assign(Error('Owner cancelled'),{code:'CANCELLED'});}}),{code:'CANCELLED'});
 assert.equal(cancelled.import,undefined);assert.equal(calls,1);f.v.inspect=inspect;
 assert.equal((await f.v.read({changeId:cancelled.changeId,path:'cancelled-owner.txt'})).contentBase64,null);
});

test("PROJECT normal entry reads frozen method only on demand, runs script and accepts checked output",async(t)=>{
  const {repository}=await import("./helpers/git-fixture.js"),{execution}=await import("./helpers/agent-sync-fixture.js"),{saveConfig}=await load("src/config.js"),{invoke}=await import("./helpers/cli-fixture.js");
  const {readTask}=await load("src/task.js");
  const repo=repository(t);let entry,resultId,source,providerError;
  const tool=(name,args={})=>({toolCalls:[{name,args}]});
  const f=await fixture(t,(call,n)=>{
    try {
    const text=call.body.messages.map(m=>typeof m.content==="string"?m.content:(m.content??[]).map(p=>p.text??JSON.stringify(p)).join("\n")).join("\n");
    if(n===1){assert.doesNotMatch(text,/FROZEN_METHOD_SENTINEL|ORIGINAL_REFERENCE_V1/);const match=text.match(/"path":"([^"]*normal-entry[^"]*SKILL.md)"/);assert.ok(match,text.slice(-2000));entry=match[1];writeFileSync(join(source,"references/guide.md"),"SOURCE_CHANGED_AFTER_FREEZE");return tool("read",{path:entry});}
    if(n===2){assert.match(text,/FROZEN_METHOD_SENTINEL/);return tool("read",{path:join(entry,"../references/guide.md")});}
    if(n===3){assert.match(text,/ORIGINAL_REFERENCE_V1/);assert.doesNotMatch(text,/SOURCE_CHANGED_AFTER_FREEZE/);return tool("next_change",{reason:"Produce the approved artifact",scope:["new.txt"],readScope:["."]});}
    if(n===4)return tool("resource_exec",{command:"node /resources/normal-entry/scripts/build.mjs"});
    if(n===5){const last=call.body.messages.at(-1);const match=(typeof last.content==="string"?last.content:last.content.map(p=>p.text).join("\n")).match(/"resultId":"([a-f0-9-]+)"/);assert.ok(match,JSON.stringify(last));resultId=match[1];return tool("resource_result",{resultId,decision:"inspect"});}
    if(n===6){
      const content=call.body.messages.at(-1).content,view=JSON.parse(typeof content==='string'?content:content.map(p=>p.text).join('\n'));
      for(const files of [view.snapshot.files,view.result.files])assert.ok(Object.values(files).every(file=>!Object.hasOwn(file,'contentBase64')),'actual model wire must omit duplicate source snapshots');
      assert.equal(Buffer.from(view.result.edits[0].contentBase64,'base64').toString(),'CHECKED_ARTIFACT','actual model wire retains the complete proposed edit');
      return tool("resource_result",{resultId,decision:"adopt",reason:"Inspected the complete generated artifact and script output"});
    }
    if(n===7)return tool("prepare_change");
    if(n===8)return tool("accept_change");return {text:"Delivered checked output"};
    } catch(error) {providerError=error;return {text:"Fixture assertion failed"};}
  });
  source=join(f.home,"normal-entry");mkdirSync(join(source,"scripts"),{recursive:true});mkdirSync(join(source,"references"),{recursive:true});
  writeFileSync(join(source,"SKILL.md"),"---\nname: normal-entry\ndescription: Build a text artifact\n---\nFROZEN_METHOD_SENTINEL. Read [guide](references/guide.md), then run scripts/build.mjs.\n");
  writeFileSync(join(source,"references/guide.md"),"ORIGINAL_REFERENCE_V1");
  // .mjs uses real ESM rather than a provider stub executing the script.
  writeFileSync(join(source,"scripts/build.mjs"),"import {writeFileSync} from 'node:fs';writeFileSync('new.txt','CHECKED_ARTIFACT');");
  saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[source]},work:{execution}});
  const plan=join(f.home,"plan.json");writeFileSync(plan,JSON.stringify({goal:"Produce new.txt with the configured method",scope:["new.txt"],budget:{maxCalls:12},steps:[{id:"build",goal:"Build checked text",deliverables:["new.txt"],checks:[{command:"node",args:["-e","if(require('fs').readFileSync('new.txt','utf8')!=='CHECKED_ARTIFACT')process.exit(1)"]}]}]}));
  const run=await invoke(f,["project","start","--file",plan,"--json"],"",repo.project);if(providerError)throw providerError;assert.equal(run.code,0,run.stdout+run.stderr);const state=JSON.parse(run.stdout);assert.equal(state.status,"completed",JSON.stringify(state));
  const task=readTask(f.home,state.steps[0].attempts[0].taskId);assert.equal(task.work.helpers?.length??0,0);assert.ok(task.tools.some(x=>x.kind==="employee_script_result"&&x.treatment?.decision==="adopted"));assert.ok(task.tools.some(x=>x.resourceName==="normal-entry"&&x.resourcePath.endsWith("references/guide.md")));
});
