import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,rmSync} from 'node:fs';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn,executeConfirmed} from '../src/project-turn.js';
import {inspectFileContinuation} from '../src/project-continuation.js';
import {reserveFileContinuation} from '../src/project-file-confirmation.js';
import {createTask,readTask,readRequests} from '../src/task.js';
import {writePrivateJson} from '../src/storage.js';
import {projectChatState} from '../src/project.js';
import {createVersioning} from '../src/versioning.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});

test('legacy held repair restores verified bytes without changing old receipts or skipping final acceptance',async t=>{
 const plan={goal:'Deliver corrected A',scope:['a.txt','extra.txt'],readScope:['a.txt','extra.txt'],deliverables:['a.txt'],
  checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='fixed A\\n')process.exit(1)"]}]};
 let restoring=false,index=0,restoredWire;
 const internalMarker='PRIVATE_RUNTIME_SOURCE_NOT_RECOVERY_TEXT';
 const sequence=[tool('start_work',{action:'start',reason:'correct A',plan}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]}),
  tool('refresh_change',{scope:['a.txt','extra.txt'],readScope:['a.txt','extra.txt'],reason:'check whether extra file is needed'}),
  tool('project_route_judge',{path:'a.txt',contains:'saved A',ifPresent:'shorten',ifAbsent:'blocked',repairScope:['a.txt'],reason:'The existing base file is sufficient for the correction.'}),
  tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'saved A',newText:'fixed A'}]}),tool('prepare_change',{check:true})];
 const f=await fixture(t,({body},n,req,res)=>{
  if(!restoring){if(n>sequence.length){res.destroy();return null;}return sequence[n-1];}
  if(index===0){restoredWire=body;assert.ok(body.tools.some(row=>row.function.name==='bash'));assert.match(JSON.stringify(body.messages),/formalAcceptancePending/);}
  return [tool('accept_change'),tool('accept_change'),{text:'A was checked and delivered.'}][index++]??{text:'Delivered'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposal=await runProjectTurn({...base,input:'Correct A and deliver it.',budget:{maxCalls:35},frozenConstraints:{allowFileContinuation:true}});
 const original=await confirmProject(base,proposal,{frozenConstraints:{allowFileContinuation:true}});
 assert.equal(original.record.status,'outcome_unknown',original.record.error);
 const state=(await projectChatState(f.home,repo.project)).state,step=state.steps[0];
 assert.ok(step.route,JSON.stringify(readTask(f.home,original.record.projectOperation.childTaskIds[0]).tools));assert.equal(step.route.status,'resolved');assert.equal(step.route.recheck.kind,'precheck');
 // Reproduce the historical host boundary: genuine public precheck, held repair.
 step.route.status='repair';delete step.route.recheck;
 writePrivateJson(join(f.home,'project-delivery',state.id,'state.json'),state);
 const child=readTask(f.home,step.route.taskId),childPath=join(f.home,'tasks',child.id+'.json');
 // Runtime source snapshots remain on disk; they are not a new model task.
 child.tools[0].snapshot={files:[{path:'runtime.js',content:internalMarker.repeat(1000)}]};
 writePrivateJson(childPath,child);
 const unknown=readRequests(f.home,child).find(row=>row.status==='outcome_unknown');assert.ok(unknown);
 const savedChild=readFileSync(childPath),savedUnknown=readFileSync(join(f.home,'requests',unknown.id+'.json'));
 const bad=structuredClone(child);bad.project.checkPolicy={digest:'wrong-policy'};writePrivateJson(childPath,bad);
 const denied=await inspectFileContinuation({home:f.home,sourceRootTaskId:original.record.id});
 assert.ok(denied.blockers.some(row=>row.code==='PROJECT_ROUTE'));
 writePrivateJson(childPath,child);
 const inspected=await inspectFileContinuation({home:f.home,sourceRootTaskId:original.record.id});
 assert.equal(inspected.eligible,true,JSON.stringify(inspected.blockers));assert.equal(inspected.requiresManual,true);
 assert.ok(inspected.repairVerification);assert.deepEqual(readFileSync(childPath),savedChild);
 const reserve=mode=>reserveFileContinuation({home:f.home,sessionId:original.record.sessionId,sourceRootTaskId:original.record.id,
  draft:inspected.draft,submissionId:'legacy-'+mode,authorizationSource:{kind:'file_continuation',sourceTaskId:original.record.id,mode},
  expectedRevision:inspected.revision,expectedFormalVersion:inspected.formalVersion});
 await assert.rejects(reserve('preauthorized_once'),{code:'CONTINUATION_AUTH'});
 const reservation=await reserve('user'),source=readTask(f.home,original.record.id);restoring=true;
 const completed=await runProjectTurn({...base,input:original.record.input,taskId:reservation.taskId,submissionId:reservation.submissionId,
  frozenConstraints:original.record.constraints,budget:reservation.budgetSource.remaining,
  confirmedOperation:{source,reservation,execute:task=>executeConfirmed(task,source,reservation)}});
 assert.equal(completed.record.status,'completed',completed.record.error);
 assert.ok(!JSON.stringify(restoredWire).includes(internalMarker),'recovery wire must not inline internal runtime source snapshots');
 assert.ok(JSON.stringify(restoredWire).includes(child.tools[0].requestId),'original tool receipt identity remains available');
 assert.match(JSON.stringify(restoredWire),/Connection error/,'the original failure remains explicit');
 const after=(await projectChatState(f.home,repo.project)).state;
 assert.ok(after.steps[0].routeHistory.some(row=>row.status==='repair'&&row.taskId===child.id));
 assert.equal(after.steps[0].route.recheck.acceptedVersion,after.version);
 assert.ok(after.steps[0].routeHistory.some(row=>row.recheck?.kind==='precheck'&&row.recheck.restoredVersion));
 assert.deepEqual(readFileSync(childPath),savedChild);assert.deepEqual(readFileSync(join(f.home,'requests',unknown.id+'.json')),savedUnknown);
 assert.notEqual(after.version,inspected.formalVersion);
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try{assert.equal(Buffer.from((await v.read({version:after.version,path:'a.txt'})).contentBase64,'base64').toString(),'fixed A\n');}finally{await v.close();}
});


test('a legacy scope observation requires the exact accepted base and still returns a paused route',async t=>{
 const {execution}=await import('./helpers/agent-sync-fixture.js');
 const {replace,accept}=await import('../packages/agent-sync/test/helpers/repository.js');
 const {createProjectPolicy}=await import('../src/project-policy.js');
 const {createWorkChanges}=await import('../src/work-changes.js');
 const {recoverContinuationRoute}=await import('../src/project-completed-continuation.js');
 const repo=repository(t,{cleanup:false}),checks=[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='fixed A\\n')process.exit(1)"]}];
 const v=await createVersioning({home:repo.home,project:repo.project,checks,execution});
 t.after(async()=>{await v.close();rmSync(repo.root,{recursive:true,force:true});});
 const first=await v.beginChange({requestId:'first',actor:'main',intent:'fixed baseline',scope:['a.txt'],readScope:['a.txt']});
 await replace(v,first,'a.txt','fixed A\n','fix');const accepted=await accept(v,first,'accept-fixed');
 const current=await v.beginChange({requestId:'current',actor:'main',intent:'later work',scope:['a.txt'],readScope:['a.txt']});
 const source=createTask({home:repo.home,input:'continue',models:{main:{},secondary:[]}}).record;
 const previous=createTask({home:repo.home,input:'baseline',models:{main:{},secondary:[]}}),task=createTask({home:repo.home,input:'later',models:{main:{},secondary:[]}});
 source.projectOperation={childTaskIds:[previous.record.id,task.record.id]};
 previous.record.rootTaskId=source.id;previous.record.work={acceptance:[accepted]};previous.save();
 const route={projectId:'p',revision:1,stepId:'s',taskId:previous.record.id,candidate:first.privateVersion,
  kind:'scope_expansion',status:'resolved',evidence:{previousScope:[],requestedScope:['a.txt']},recheck:{kind:'precheck'}};
 const step={id:'s',revision:1,status:'running',scope:['a.txt','new.txt'],checks,route,attempts:[
  {taskId:previous.record.id,rootTaskId:source.id},{taskId:task.record.id,rootTaskId:source.id}]};
 const state={id:'p',status:'active',budget:{maxCalls:null,maxCost:null},steps:[step]};
 const host={read:()=>structuredClone(state),update:fn=>fn(state),assertOwned(){}};
 task.record.rootTaskId=source.id;task.record.project={projectId:'p',stepId:'s',revision:1,taskId:task.record.id,scope:step.scope,route:structuredClone(route)};
 const work=task.record.work={startVersion:accepted.acceptedVersion,changes:[current],requests:[],operations:[]};
 task.projectPolicy=createProjectPolicy({host,binding:task.record.project,home:repo.home});
 const changes=createWorkChanges({task,work,members:new Map(),observerErrors:[],save:task.save,guard(){},notify(){},
  getVersioning:()=>v,getPluginWork:()=>null,getMainBinding:()=>null,syncChange:x=>x});
 await assert.rejects(changes.invoke('refreshChange',{changeId:current.changeId,actor:'main',scope:step.scope},()=>{throw Error('must not reach kernel');}),{code:'PROJECT_ROUTE'});
 assert.equal(step.route.status,'blocked');assert.equal(work.requests[0].dispatched,false);
 const inspect=(overrides={})=>recoverContinuationRoute({home:repo.home,state,source,step,versioning:v,formalVersion:accepted.acceptedVersion,...overrides});
 const saved=JSON.stringify(state),proof=await inspect();
 assert.equal(proof.status,'paused');assert.equal(proof.taskId,task.record.id);assert.equal(proof.candidate,current.privateVersion);
 assert.equal(proof.priorAcceptance.requestId,accepted.requestId);assert.equal(JSON.stringify(state),saved,'inspection never rewrites saved route history');
 assert.equal(await inspect({formalVersion:repo.baseVersion}),null);
 const denied={...v,inspect:args=>args.requestId===accepted.requestId?Promise.resolve({status:'not_found'}):v.inspect(args)};
 assert.equal(await inspect({versioning:denied}),null,'missing acceptance cannot reopen an old route');
 const outside=structuredClone(step);outside.route.recheck.evidence.requestedScope=['outside.txt'];
 assert.equal(await inspect({step:outside}),null,'recovery cannot widen the project scope');
});


test('actual continuation of an old misattached route starts with judgment and preserves the accepted baseline',async t=>{
 const plan={goal:'Deliver fixed A, optionally marked verified',scope:['a.txt','extra.txt'],readScope:['a.txt','extra.txt'],deliverables:['a.txt'],
  checks:[{command:'node',args:['-e',"if(!['fixed A\\n','fixed A verified\\n'].includes(require('fs').readFileSync('a.txt','utf8')))process.exit(1)"]}]};
 let phase=0,index=0,legacyRoute,repo,failure,home;
 const judge={path:'a.txt',contains:'saved A',ifPresent:'shorten',ifAbsent:'blocked',repairScope:['a.txt'],reason:'Correct the existing file; no new file is required.'};
 const original=[tool('start_work',{action:'start',reason:'fixed file',plan}),tool('read',{path:'a.txt'}),
  tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]}),tool('prepare_change',{check:true}),
  tool('project_route_judge',judge),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'saved A',newText:'fixed A'}]}),
  tool('prepare_change',{check:true}),tool('accept_change'),tool('next_change',{scope:['a.txt'],readScope:plan.readScope,reason:'Continue checking the accepted file'})];
 const f=await fixture(t,async({body},n,req,res)=>{try{
  if(phase===0){if(index===8)legacyRoute=structuredClone((await projectChatState(home,repo.project)).state.steps[0].route);if(index===original.length){res.destroy();return null;}return original[index++];}
  if(phase===1)return [tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'fixed A',newText:'later A'}]}),
    tool('refresh_change',{scope:plan.scope,readScope:plan.readScope,reason:'Check a newly requested extra file.'}),{text:'A bound route must decide this.'}][index++]??{text:'Stopped at route'};
  if(index===0)assert.deepEqual(body.tools.map(x=>x.function.name),['project_route_judge'],'recovery grants no normal tools before the new judgment');
  if(index===6){const last=body.messages.findLast(m=>m.role==='tool')?.content;assert.equal(JSON.parse(last).status,'accepted',last);}
  return [tool('project_route_judge',{...judge,contains:'later A'}),tool('read',{path:'a.txt'}),
    tool('edit',{path:'a.txt',edits:[{oldText:'later A',newText:'fixed A verified'}]}),tool('prepare_change',{check:true}),tool('accept_change'),tool('accept_change'),{text:'Fixed A delivered.'}][index++]??{text:'Fixed A delivered.'};
 }catch(error){failure??=error;return {text:'Fixture failure retained.'};}});home=f.home;repo=repository(t);
 const base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:40}});
 const first=await confirmProject(base,proposal);if(failure)throw failure;assert.equal(first.record.status,'outcome_unknown',first.record.error);
 const firstChild=readTask(home,first.record.projectOperation.childTaskIds[0]);assert.ok(firstChild.work.acceptance.some(r=>r.status==='accepted'));
 const unknown=readRequests(home,firstChild).find(r=>r.status==='outcome_unknown'),unknownPath=join(home,'requests',unknown.id+'.json'),unknownBytes=readFileSync(unknownPath);
 // Reproduce the old host snapshot only; genuine acceptance and request receipts remain untouched.
 const saved=(await projectChatState(home,repo.project)).state;saved.steps[0].route=legacyRoute;
 writePrivateJson(join(home,'project-delivery',saved.id,'state.json'),saved);
 const resume=async source=>{
  const fact=await inspectFileContinuation({home,sourceRootTaskId:source.id});assert.equal(fact.eligible,true,JSON.stringify(fact.blockers));
  const reservation=await reserveFileContinuation({home,sessionId:source.sessionId,sourceRootTaskId:source.id,draft:fact.draft,
   submissionId:'continue-'+source.id,authorizationSource:{kind:'file_continuation',sourceTaskId:source.id,mode:'user'},expectedRevision:fact.revision,expectedFormalVersion:fact.formalVersion});
  source=readTask(home,source.id);
  return runProjectTurn({...base,input:source.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,
   confirmedOperation:{source,reservation,execute:task=>executeConfirmed(task,source,reservation)}});
 };
 phase=1;index=0;const later=await resume(first.record);if(failure)throw failure;
 const paused=(await projectChatState(home,repo.project)).state;assert.equal(paused.steps[0].route.status,'blocked');
 const qualified=await inspectFileContinuation({home,sourceRootTaskId:later.record.id});assert.equal(qualified.eligible,true,JSON.stringify(qualified.blockers));assert.equal(qualified.recoveredRoute.status,'paused');assert.equal(qualified.requiresManual,true);
 const retained=readFileSync(join(home,'tasks',later.record.projectOperation.childTaskIds[0]+'.json'));
 phase=2;index=0;const delivered=await resume(later.record);if(failure)throw failure;
 assert.equal(delivered.record.status,'completed',delivered.record.error);
 assert.deepEqual(readFileSync(unknownPath),unknownBytes);assert.deepEqual(readFileSync(join(home,'tasks',later.record.projectOperation.childTaskIds[0]+'.json')),retained);
 const end=(await projectChatState(home,repo.project)).state;assert.ok(end.steps[0].routeHistory.some(r=>r.status==='blocked'));
 assert.equal(end.steps[0].route.recheck.acceptedVersion,end.version);
 const v=await createVersioning({home,project:repo.project,readOnly:true});
 try{assert.equal(Buffer.from((await v.read({version:end.version,path:'a.txt'})).contentBase64,'base64').toString(),'fixed A verified\n');}finally{await v.close();}
});
