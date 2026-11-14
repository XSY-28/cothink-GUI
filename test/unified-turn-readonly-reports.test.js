import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import { frozenInputFixture, opts } from "./unified-turn.fixture.js";

test('unified read-only roles receive separate frozen material and send saved reports through the root',async t=>{
 let materialRefs;
 const seen=new Set();
 let release;
 const bothWorkers=new Promise(resolve=>{release=resolve;});
 const {f,put}=await frozenInputFixture(t,async ({body})=>{
   if(JSON.stringify(body.messages).includes("cothink-process-observation"))
     return {text:'{"issues":[]}'};
   if(body.model!=='main'){
     seen.add(body.model);
     if(seen.size===2)release();
     await Promise.race([bothWorkers,new Promise(resolve=>setTimeout(resolve,600))]);
     return {text:body.model==='r1'?'Verified first report':'Verified second report'};
   }
   const tools=body.messages.filter(m=>m.role==='tool');
   if(!tools.length&&!body.tools.some(tool=>tool.function.name==='delegate'))return {text:'No delegation tool advertised'};
   if(!tools.length)return {toolCalls:['r1','r2'].map((modelId,i)=>({id:'assign-'+modelId,name:'delegate',args:{
     workId:'part-'+i,model:'fixture/'+modelId,assignment:'Compare part '+i,reason:'Independent evidence',
     attachments:[materialRefs[i]],readScope:[],
   }}))};
   const delegated=tools.map(m=>JSON.parse(m.content)).filter(r=>r.assignmentId&&!r.resultRequestId);
   if(tools.length===2&&delegated.length===2)return {toolCalls:delegated.map((value,i)=>({id:'collect-'+i,name:'collect',args:{assignmentId:value.assignmentId}}))};
   return {text:'Combined supported report'};
 },[]);
 const a=await put('a.md','text/markdown',Buffer.from('SOURCE-FIRST-721'));
 const b=await put('b.md','text/markdown',Buffer.from('SOURCE-SECOND-936'));
 materialRefs=[a,b].map(({manifest:{id,sha256}})=>({id,sha256}));
 const task=await runProjectTurn({...opts(f),input:'Use two different models in parallel to compare both sources.',materials:[a,b],
   frozenConstraints:{readOnly:true},budget:{maxCalls:7},
 });
 assert.ok(f.calls[0].body.tools.some(tool=>tool.function.name==='delegate'),'unified manager must advertise a live read-only delegation route');
 assert.equal(task.record.status,'completed',task.record.error);
 const roles=task.record.stages.filter(s=>s.assignment);
 assert.equal(roles.length,2);
 assert.equal(new Set(task.record.stages.map(s=>s.sessionId)).size,4);
 assert.equal(task.record.phase,'draft');
 assert.equal(task.record.rootRequests.length,f.calls.length);
 assert.equal(task.record.usage.calls,f.calls.length);
 assert.equal(task.record.collaborationResult[0].status,'fulfilled');
 assert.ok(task.record.processCheck.observations.some(observation=>observation.covered?.length===2));
 assert.equal(existsSync(join(f.home,'project-delivery')),false);
 assert.equal(existsSync(join(f.home,'.git')),false);
 for(const [model,own,other] of [['r1','SOURCE-FIRST-721','SOURCE-SECOND-936'],['r2','SOURCE-SECOND-936','SOURCE-FIRST-721']]){
   const body=f.calls.find(c=>c.body.model===model&&c.body.tools?.some(tool=>tool.function.name==='get_capabilities')).body;
   assert.match(JSON.stringify(body.messages),new RegExp(own));
   assert.doesNotMatch(JSON.stringify(body.messages),new RegExp(other));
   assert.deepEqual(body.tools?.map(t=>t.function.name)??[],['get_capabilities']);
 }
 assert.equal(seen.size,2);
 const last=f.calls.findLast(call=>call.body.model==='main').body;
 assert.equal(last.model,'main');
 assert.match(JSON.stringify(last.messages),/Verified first report/);
 assert.match(JSON.stringify(last.messages),/Verified second report/);
 assert.deepEqual(roles.map(role=>role.assignment.collected.toolCallId).sort(),['collect-0','collect-1']);

 const {startGuiServer}=await import('../src/gui-server.js');
 const host=await startGuiServer({home:f.home,cwd:f.cwd,open:false});
 try {
   const response=await fetch(host.origin+'/api/task?id='+task.record.id,{headers:{Authorization:'Bearer '+host.token}});
   assert.equal(response.status,200);
   const view=await response.json();
   const workers=view.participants.filter(person=>person.position==='employee');
   assert.deepEqual(workers.map(person=>person.workId).sort(),['part-0','part-1']);
   assert.ok(workers.every(person=>person.participated&&person.collected&&person.attachmentCount===1&&person.reason==='Independent evidence'));
   assert.deepEqual(workers.map(person=>person.model.modelId).sort(),['r1','r2']);
   assert.ok(view.processCheck.observations.some(observation=>observation.members.filter(person=>person.covered).length===2));
   assert.doesNotMatch(JSON.stringify(view),/SOURCE-FIRST-721|SOURCE-SECOND-936|reportDigest|argsDigest/);
 } finally {await host.close();}
});

test('a read-only role cannot read a path outside its part of a fixed root grant',async t=>{
 const {repository}=await import('./helpers/git-fixture.js');
 const {freezeReadAuthorization}=await import('../src/project-turn.js');
 const {writeFileSync}=await import('node:fs');
 const {project,baseVersion}=repository(t);
 const f=await fixture(t,({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   const tools=body.messages.filter(message=>message.role==='tool');
   if(body.model==='r2')return tools.length?{text:'Read the fixed file'}:{toolCalls:['a.txt','b.txt'].map((path,i)=>({
     id:'fixed-'+i,name:'read_project_context',args:{operation:'read',paths:[path]},
   }))};
   if(!tools.length)return {toolCalls:[{name:'delegate',args:{workId:'fixed-read',model:'fixture/r2',
     assignment:'Read the first saved file',reason:'Separate evidence',readScope:['a.txt']}}]};
   if(tools.length===1)return {toolCalls:[{name:'collect',args:{assignmentId:JSON.parse(tools[0].content).assignmentId}}]};
   return {text:'Read-only report collected'};
 });
 const workspace={id:null,project};
 const grant=await freezeReadAuthorization({home:f.home,workspace,sessionId:'root',submissionId:'fixed',input:{paths:['a.txt','b.txt']}});
 writeFileSync(join(project,'a.txt'),'AFTER-SNAPSHOT-668');
 const task=await runProjectTurn({...opts(f),workspace,readAuthorization:grant,frozenConstraints:{readOnly:true}});
 assert.equal(task.record.status,'completed',task.record.error);
 const workerCalls=f.calls.filter(call=>call.body.model==='r2');
 assert.equal(workerCalls.length,2);
 const first=JSON.stringify(workerCalls[0].body);
 assert.match(first,new RegExp(baseVersion));assert.doesNotMatch(first,/b\.txt/);
 const second=JSON.stringify(workerCalls[1].body);
 assert.match(second,/base A/);assert.match(second,/unauthorized/);
 assert.doesNotMatch(second,/base B|AFTER-SNAPSHOT-668/);
 assert.equal(existsSync(join(f.home,'project-delivery')),false);
});

test('a finished role whose report the manager did not collect cannot complete the root answer',async t=>{
 let reported;
 const roleResponded=new Promise(resolve=>{reported=resolve;});
 const f=await fixture(t,async ({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r2'){reported();return {text:'An uncollected report'};}
   if(!body.messages.some(message=>message.role==='tool'))return {toolCalls:[{name:'delegate',args:{
     workId:'pending',model:'fixture/r2',assignment:'Independent work',reason:'Requested',
   }}]};
   await roleResponded;
   return {text:'Premature manager answer'};
 });
 const task=await runProjectTurn({...opts(f),input:'Read only.'});
 assert.notEqual(task.record.status,'completed');
 const role=task.record.stages.find(stage=>stage.assignment);
 assert.ok(role.assignment.settledAt);
 assert.equal(role.assignment.collected,undefined);
 assert.equal(task.record.rootRequests.filter(r=>r.stageId===role.id).length,1);
 const {readTask}=await import('../src/task.js');
 const restored=readTask(f.home,task.record.id);
 assert.equal(restored.stages.find(stage=>stage.id===role.id).assignment.status,role.assignment.status);
});

test('whole-turn cancellation keeps the original sent read-only request unknown and does not replay it',async t=>{
 const controller=new AbortController();
 let started;
 const roleStarted=new Promise(resolve=>{started=resolve;});
 const f=await fixture(t,async ({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r2'){started();return null;}
   if(!body.messages.some(message=>message.role==='tool'))return {toolCalls:[{name:'delegate',args:{
     workId:'cancelled',model:'fixture/r2',assignment:'Independent work',reason:'Requested',
   }}]};
   await roleStarted;
   return null;
 });
 const running=runProjectTurn({...opts(f),input:'Read only.',signal:controller.signal});
 await roleStarted;
 controller.abort();
 const task=await running;
 const role=task.record.stages.find(stage=>stage.assignment);
 const {readTask,readRequest,taskDisplayStatus}=await import('../src/task.js');
 const restored=readTask(f.home,task.record.id);
 assert.equal(taskDisplayStatus(restored),'stop_unknown');
 assert.equal(role.assignment.status,'outcome_unknown');
 assert.equal(readRequest(f.home,restored.id,role.callIds[0]).status,'outcome_unknown');
 assert.equal(f.calls.filter(call=>call.body.model==='r2').length,1);
});

test('file confirmation uses only the adopted read-only report and the original remaining budget',async t=>{
 const {repository}=await import('./helpers/git-fixture.js');
 const {execution}=await import('./helpers/agent-sync-fixture.js');
 const {reserveConfirmation,executeConfirmed,resolveDeliveryEvidence}=await import('../src/project-turn.js');
 const {guiFiles,guiFile}=await import('../src/gui-files.js');
 const {project}=repository(t);
 const acceptedText='The accepted answer is 42.\n';
 const adoptedText='ROLE-HANDOFF-SENTINEL answer=42';
 const unusedText='UNADOPTED-ROLE-SENTINEL answer=99';
 const plan={action:'start',reason:'Create a file after comparing evidence',plan:{
   goal:'Create a text file',scope:['report.txt'],deliverables:['report.txt'],checks:[{
     command:'node',args:['-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('report.txt','utf8'),"+JSON.stringify(acceptedText)+")"],
   }],
 }};
 const proposal={name:'start_work',args:plan};
 let mainCalls=0,formalCalls=0,confirmed=false;
 const f=await fixture(t,({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(confirmed){
     const tools=body.tools?.map(tool=>tool.function.name)??[];
     if(!tools.includes('accept_change'))return {text:'The checked report contains the accepted answer.'};
     if(++formalCalls===1)return {toolCalls:[{name:'write',args:{path:'report.txt',content:acceptedText}}]};
     if(formalCalls===2)return {toolCalls:[{name:'accept_change',args:{}}]};
     return {text:'Created and checked the adopted answer.'};
   }
   if(body.model==='r2')return {text:adoptedText};
   if(body.model==='r3')return {text:unusedText};
   mainCalls++;
   const tools=body.messages.filter(m=>m.role==='tool');
   if(mainCalls===1)return {toolCalls:[{name:'delegate',id:'first-role',args:{
     workId:'evidence',model:'fixture/r2',assignment:'Compare evidence',reason:'Independent judgment',
   }},{...proposal,id:'too-soon'},{name:'delegate',id:'unused-role',args:{
     workId:'alternate',model:'fixture/r3',assignment:'Consider a second interpretation',reason:'UNRELATED-ROLE-REASON',
   }}]};
   const [adoptedId,unusedId]=[0,2].map(index=>JSON.parse(tools[index].content).assignmentId);
   if(mainCalls===2)return {toolCalls:[{name:'collect',id:'read-report',args:{assignmentId:adoptedId}},
     {name:'collect',id:'read-unused',args:{assignmentId:unusedId}}]};
   if(mainCalls===3)return {toolCalls:[{name:'collect',id:'adopt-report',args:{
     assignmentId:adoptedId,decision:'adopt',reason:'Supports the text file plan',
   }},{name:'collect',id:'discard-report',args:{
     assignmentId:unusedId,decision:'discard',reason:'The report uses the weaker interpretation',
   }}]};
   return {toolCalls:[{...proposal,id:'settled-proposal'}]};
 });
 const input='Create report.txt.',workspace={id:null,project},maxCalls=14;
 const base={...opts(f),cwd:project,workspace,input,frozenConfig:{formatVersion:2,...f.models,work:{execution}}};
 const source=await runProjectTurn({...base,budget:{maxCalls}});
 assert.equal(source.record.routeIntent?.toolCallId,'settled-proposal',source.record.error);
 assert.equal(source.record.proposal?.plan.goal,'Create a text file');
 assert.match(JSON.stringify(f.calls.filter(call=>call.body.model==='main')[1].body),/Collect and settle read-only assignments/);
 const [adopted,...extra]=source.record.handoffContext.materials.filter(item=>item.kind==='readonly-report');
 assert.equal(adopted.text,adoptedText);
 assert.deepEqual(extra,[]);
 const spent=f.calls.length;
 assert.equal(source.record.proposal.budgetAtProposal.spentCalls,spent);
 assert.equal(existsSync(join(project,'report.txt')),false);
 const reservation=await reserveConfirmation({home:f.home,source:source.record,proposalRef:source.record.proposalRef,
   sessionId:source.record.sessionId,workspaceId:null,submissionId:'confirm-adopted-report',save:source.save});
 assert.equal(reservation.budgetSource.remaining.maxCalls,maxCalls-spent);
 confirmed=true;
 const root=await runProjectTurn({...base,taskId:reservation.taskId,submissionId:reservation.submissionId,
   budget:reservation.budgetSource.remaining,confirmedOperation:{source:source.record,reservation,
     execute:task=>executeConfirmed(task,source.record,reservation)}});
 assert.equal(root.record.status,'completed',root.record.error);
 assert.equal(root.record.budget.maxCalls,maxCalls-spent);
 assert.equal(root.record.usage.calls,f.calls.length-spent);
 assert.ok(f.calls.length<=maxCalls);
 const physical=JSON.stringify(f.calls[spent].body.messages);
 assert.match(physical,new RegExp(adoptedText));
 for(const value of [adopted.ref.id,adopted.ref.sha256,adopted.ref.sessionId])
   assert.ok(physical.includes(value),value);
 const discarded=source.record.stages.find(stage=>stage.assignment?.workId==='alternate').assignment;
 for(const {body} of f.calls.slice(spent)){
   const messages=JSON.stringify(body.messages);
   assert.doesNotMatch(messages,/UNADOPTED-ROLE-SENTINEL|UNRELATED-ROLE-REASON/);
   assert.ok(!messages.includes(discarded.resultRequestId)&&!messages.includes(discarded.reportDigest));
 }
 const evidence=resolveDeliveryEvidence(f.home,root.record);
 assert.ok(evidence.checks.some(check=>check.status==='passed'));
 const files=await guiFiles(f.home,root.record);
 assert.deepEqual(files.items.map(file=>file.name),['report.txt']);
 assert.equal((await guiFile(f.home,root.record,files.items[0].ref)).bytes.toString(),acceptedText);
 assert.equal(existsSync(join(project,'report.txt')),false);
});

test('a saved file route rejects a later read-only delegation from the same response',async t=>{
 const {repository}=await import('./helpers/git-fixture.js');
 const {project}=repository(t);
 const f=await fixture(t,()=>({toolCalls:[{id:'file-first',name:'start_work',args:{action:'start',reason:'Propose work',plan:{
   goal:'Produce report',scope:['report.txt'],deliverables:['report.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('report.txt')"]}],
 }}},{id:'late-role',name:'delegate',args:{
   workId:'late',model:'fixture/r2',assignment:'Read work',reason:'Would arrive too late',
 }}]}));
 const task=await runProjectTurn({...opts(f),cwd:project,workspace:{id:null,project},input:'Create report.txt.'});
 assert.equal(task.record.routeIntent?.toolCallId,'file-first',task.record.error);
 assert.ok(task.record.proposal);
 assert.equal(task.record.stages.some(stage=>stage.assignment),false);
 assert.equal(f.calls.length,1);
});

for(const maxCalls of [12,3]) test(`readonly checker correction shares root budget ${maxCalls} and preserves original output`,async t=>{
 let checks=0;
 const detached=Promise.withResolvers();
 const f=await fixture(t,async({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation')) {
     const index=++checks;
     if(maxCalls===3&&index===1)await detached.promise;
     return {text:index===1?'{"issues":false}':'{"issues":[]}'};
   }
   if(body.model==='r2')return {text:'Independent evidence verified'};
   const tools=body.messages.filter(message=>message.role==='tool');
   if(!tools.length)return {toolCalls:[{name:'delegate',args:{workId:'checked',model:'fixture/r2',assignment:'Investigate',reason:'Separate evidence'}}]};
   if(tools.length===1)return {toolCalls:[{name:'collect',args:{assignmentId:JSON.parse(tools[0].content).assignmentId}}]};
   return {text:'Combined evidence verified'};
 });
 const task=await runProjectTurn({...opts(f),input:'Investigate together.',budget:{maxCalls},
   onTaskCreated(root){
     if(maxCalls!==3)return;
     const checker=root.rootOwner.processCheck,detach=checker.detach.bind(checker);
     // Return the real malformed HTTP response only once teardown has entered
     // the real detach method; the employee reservation must still be held.
     checker.detach=source=>{const settled=detach(source);detached.resolve();return settled;};
   },
 });
 const [original,correction]=task.record.processCheck.observations;
 assert.equal(original.status,'failed');
 assert.equal(correction.correctionOf,original.id);
 assert.equal(task.requests().find(row=>row.id===original.requestId).status,'completed');
 assert.equal(task.record.rootRequests.filter(row=>!row.notSent).length,f.calls.length);
 assert.equal(task.record.usage.calls,f.calls.length);
 assert.ok(f.calls.length<=maxCalls);
 if(maxCalls===3){
   assert.notEqual(task.record.status,'completed');
   assert.equal(checks,1);
   assert.equal(task.record.processCheck.gap.code,'ROOT_BUDGET');
 }else{
   assert.equal(task.record.status,'completed',task.record.error);
   assert.equal(correction.status,'completed');
   const {projectGuiProcessCheck}=await import('../src/gui-process-projection.js');
   const messages=task.requests().map(row=>({...row,taskId:task.record.id,sessionId:task.record.stages.find(stage=>stage.id===row.stageId)?.sessionId}));
   const view=projectGuiProcessCheck(task.record,messages);
   assert.equal(view.observations.find(row=>row.id===correction.id).correctionOf,original.id);
   assert.ok(view.observations.some(row=>row.members.some(member=>member.covered)));
 }
});
