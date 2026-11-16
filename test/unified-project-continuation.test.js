import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import {readTask} from '../src/task.js';
import {guiFiles,guiFile,guiFileDiff} from '../src/gui-files.js';
import {createVersioning} from '../src/versioning.js';
import * as workFiles from '../src/gui-work.js';

test('failed work exposes its fixed unaccepted draft without generation or execution',async t=>{
 const plan={goal:'Create a page',scope:['index.html'],readScope:['a.txt'],deliverables:['index.html'],
   checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('index.html','utf8').includes('draft'))process.exit(1)"]}]};
 const page='<h1>draft</h1>';
 const replies=[{toolCalls:[{name:'start_work',args:{action:'start',reason:'create',plan}}]},
   {toolCalls:[{name:'refresh_change',args:{reason:'use approved file scope',scope:['index.html'],readScope:['a.txt']}}]},
   {toolCalls:[{name:'write',args:{path:'index.html',content:page}}]},
   {error:503}];
 const f=await fixture(t,(_,n)=>replies[n-1]??{error:503});
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposal=await runProjectTurn({...base,input:'Create index.html.'});
 const root=await confirmProject(base,proposal);
 const before=f.calls.length,list=await guiFiles(f.home,root.record);
 const item=list.items.find(x=>x.name==='index.html'&&x.ref?.draft);
 assert.ok(item,'the original reply must expose its unaccepted draft');
 const child=readTask(f.home,item.ref.taskId);
 assert.notEqual(root.record.status,'completed');
 assert.equal((await guiFile(f.home,child,item.ref)).bytes.toString(),page);
 assert.match((await guiFile(f.home,child,item.ref,{purpose:'preview'})).bytes.toString(),/draft/);
 assert.match((await guiFileDiff(f.home,child,item.ref)).patch,/\+.*draft/);
 const draft=await workFiles.resolveTaskDraft({home:f.home,record:child,changeId:item.ref.draft.changeId});
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try {
   const formal=(await v.inspect()).version;
   assert.equal(formal,repo.baseVersion,'failed work cannot advance the formal ref');
   const fact=await v.inspect({changeId:draft.changeId});
   writeFileSync(join(fact.workspace,'index.html'),'mutable projection must not be read');
   assert.equal((await guiFile(f.home,child,item.ref)).bytes.toString(),page);
   await assert.rejects(guiFile(f.home,child,{...item.ref,taskId:root.record.id}),{code:'FILE_VERSION_MISMATCH'});
   await assert.rejects(guiFile(f.home,child,{...item.ref,draft:{...item.ref.draft,changeId:'forged'}}),{code:'FILE_VERSION_MISMATCH'});
   const requestsBefore=JSON.stringify(child.work.requests),toolsBefore=JSON.stringify(child.tools);
   const exported=await workFiles.exportTaskDraft({home:f.home,record:child,draft});
   assert.equal(readFileSync(join(exported.directory,'index.html'),'utf8'),page);
   assert.equal(readFileSync(join(exported.directory,'a.txt'),'utf8'),'base A\n','authorized unchanged dependency is exported');
   assert.ok(!exported.paths.some(path=>path.startsWith('.git')));
   writeFileSync(join(exported.directory,'index.html'),'user-edited export');
   const second=await workFiles.exportTaskDraft({home:f.home,record:child,draft});
   assert.notEqual(second.directory,exported.directory);
   assert.equal(readFileSync(join(exported.directory,'index.html'),'utf8'),'user-edited export');
   assert.equal((await v.inspect()).version,formal);
   assert.equal(JSON.stringify(readTask(f.home,child.id).work.requests),requestsBefore);
   assert.equal(JSON.stringify(readTask(f.home,child.id).tools),toolsBefore);
   assert.equal(f.calls.length,before);
   root.record.projectOperation.childTaskIds.push('00000000-0000-0000-0000-000000000001');
   root.save();
   const isolated=await guiFiles(f.home,root.record);
   assert.ok(isolated.items.some(file=>file.name==='index.html'),'unrelated broken sibling must not hide a valid draft');
   assert.ok(isolated.warnings.some(message=>message.includes('ENOENT')));
 } finally {await v.close();}
});

import {executeConfirmed} from '../src/project-turn.js';
import {inspectFileContinuation} from '../src/project-continuation.js';
import {reserveFileContinuation,confirmationState} from '../src/project-file-confirmation.js';
import {readRequests} from '../src/task.js';
import {writePrivateJson} from '../src/storage.js';
import {projectChatState} from '../src/project.js';

test('explicit continuation restores saved bytes and accepts with original unknown untouched',async t=>{
 const plan={goal:'Change a.txt',scope:['a.txt'],readScope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='changed A\\n')process.exit(1)"]}]};
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const replies=[tool('start_work',{action:'start',reason:'edit',plan}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}),tool('bash',{command:"node -e \"if(!require('fs').readFileSync('a.txt','utf8').includes('changed A'))process.exit(1)\""}),null,
   tool('read',{path:'a.txt'}),tool('accept_change',{}),tool('accept_change',{}),{text:'Changed A'},{text:'Delivered'}];
 const f=await fixture(t,(_,n,req,res)=>{if(n===5){res.destroy();return null;}return replies[n-1]??{text:'Delivered'};});
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposal=await runProjectTurn({...base,input:'Change a.txt.',budget:{maxCalls:15}}),source=await confirmProject(base,proposal);
 assert.equal(source.record.status,'outcome_unknown',source.record.error);
 const checked=await inspectFileContinuation({home:f.home,sourceRootTaskId:source.record.id});
 assert.equal(checked.eligible,true,JSON.stringify(checked));
 const original=checked.requestIds.map(id=>source.record.rootRequests.find(r=>r.requestId===id));
 const args={home:f.home,sessionId:source.record.sessionId,sourceRootTaskId:source.record.id,draft:checked.draft,
   submissionId:'continue-once',authorizationSource:{kind:'file_continuation',sourceTaskId:source.record.id,mode:'user'},expectedRevision:checked.revision,expectedFormalVersion:checked.formalVersion};
 const reservation=await reserveFileContinuation(args),saved=readTask(f.home,source.record.id);
 assert.equal((await reserveFileContinuation({...args,submissionId:'duplicate'})).taskId,reservation.taskId);
 assert.equal((await confirmationState({home:f.home,source:saved,reservation})).mayCreate,true);
 let creationReceipt;
 const root=await runProjectTurn({...base,input:saved.input,taskId:reservation.taskId,submissionId:reservation.submissionId,
   onTaskCreated(task){
     saved.fileContinuationIntent.status='consumed';saved.fileContinuationIntent.consumedByTaskId=task.record.id;
     writePrivateJson(join(f.home,'tasks',saved.id+'.json'),saved);
     creationReceipt=confirmationState({home:f.home,source:readTask(f.home,saved.id),reservation});
   },
   budget:reservation.budgetSource.remaining,confirmedOperation:{source:saved,reservation,execute:task=>executeConfirmed(task,saved,reservation)}});
 assert.equal(root.record.status,'completed',root.record.error);
 const continuedChild=readTask(f.home,root.record.projectOperation.childTaskIds[0]);
 const observations=continuedChild.project.continuationEvidence.observations;
 assert.equal(observations.commands.length,1,JSON.stringify(observations));
 assert.equal(observations.fixedChecksRequired,true);
 assert.equal(continuedChild.tools.filter(t=>t.name==='bash').length,0,'fixture consumes evidence without optional command replay');
 assert.equal(continuedChild.work.finalCheck.status,'passed','new formal combination check is still required');
 assert.match(JSON.stringify(f.calls[5].body),/observations/,'first resumed request receives candidate-bound evidence');
 assert.equal((await creationReceipt).task.id,reservation.taskId,'consumed receipt resolves before execute initializes the operation');
 for(const claim of original)assert.equal(readRequests(f.home,readTask(f.home,claim.taskId)).find(r=>r.id===claim.requestId).status,'outcome_unknown');
 assert.equal(f.calls.length,9);
 assert.match(JSON.stringify(f.calls[6].body.messages),/changed A/);
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try {const current=(await v.inspect()).version;assert.equal(Buffer.from((await v.read({version:current,path:'a.txt'})).contentBase64,'base64').toString(),'changed A\n');}finally{await v.close();}
 const state=(await projectChatState(f.home,repo.project)).state;
 assert.equal(state.steps[0].attempts.length,2);assert.equal(state.steps[0].attempts[0].status,'unknown');
});

test('lost manager final resumes only communication with unchanged accepted bytes and revision',async t=>{
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const plan={goal:'Change a.txt and b.txt',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],steps:[
   {id:'a',goal:'Change A',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('changed A'))process.exit(1)"]}]},
   {id:'b',goal:'Change B',scope:['b.txt'],dependsOn:['a'],deliverables:['b.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('b.txt','utf8').includes('changed B'))process.exit(1)"]}]},
 ]};
 const replies=[tool('start_work',{action:'start',reason:'two bounded steps',plan}),
   tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}),tool('accept_change',{}),{text:'Changed A'},
   tool('read',{path:'b.txt'}),tool('edit',{path:'b.txt',edits:[{oldText:'base B',newText:'changed B'}]}),tool('accept_change',{}),{text:'Changed B'}];
 const f=await fixture(t,(_,n,req,res)=>{if(n===10){res.destroy();return null;}return replies[n-1]??{text:'Both checked files delivered.'};});
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:'Change a.txt and b.txt.',budget:{maxCalls:20}}),source=await confirmProject(base,proposal);
 assert.equal(source.record.status,'outcome_unknown',source.record.error);
 const checked=await inspectFileContinuation({home:f.home,sourceRootTaskId:source.record.id});
 assert.equal(checked.eligible,true,JSON.stringify(checked.blockers));assert.equal(checked.draft,null);assert.equal(checked.stepId,null);
 const before=(await projectChatState(f.home,repo.project)).state;
 const reservation=await reserveFileContinuation({home:f.home,sessionId:source.record.sessionId,sourceRootTaskId:source.record.id,draft:null,
   submissionId:'final-only',authorizationSource:{kind:'file_continuation',sourceTaskId:source.record.id,mode:'user'},expectedRevision:checked.revision,expectedFormalVersion:checked.formalVersion});
 const saved=readTask(f.home,source.record.id);
 const result=await runProjectTurn({...base,input:saved.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,
   confirmedOperation:{source:saved,reservation,execute:task=>executeConfirmed(task,saved,reservation)}});
 assert.equal(result.record.status,'completed',result.record.error);
 const after=(await projectChatState(f.home,repo.project)).state;
 assert.equal(after.revision,before.revision);assert.equal(after.version,before.version);
 assert.deepEqual(after.steps.map(s=>s.attempts.length),[1,1]);assert.equal(f.calls.length,11);
 assert.equal(readRequests(f.home,readTask(f.home,source.record.id)).find(r=>r.phase==='manager-final').status,'outcome_unknown');
});

for(const disconnectedRole of ['employee','employee-draft','checker','manager-after-collect','manager-after-collect-via-failure'])test(`real ${disconnectedRole} disconnect can continue from the saved implementation draft`,async t=>{
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const employeeDraft=disconnectedRole==='employee-draft';
 const managerAfterCollect=disconnectedRole.startsWith('manager-after-collect');
 const plan={...(managerAfterCollect?{collaboration:{workers:1}}:{}),goal:'Change a.txt and inspect b.txt',scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],deliverables:employeeDraft?['a.txt','b.txt']:['a.txt'],
   checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('changed A'))process.exit(1)"]}]};
 const replies=employeeDraft?[
   tool('read',{path:'a.txt'}),
   tool('project_staff',{action:'appoint',input:{id:'writer',responsibility:'Change a.txt',models:['fixture/r2'],scope:['a.txt'],need:'deliverable',reason:'Implement the file'}}),
   tool('delegate',{staffId:'writer',workId:'main:a.txt',model:'fixture/r2',assignment:'Change base A to changed A',scope:['a.txt'],readScope:['a.txt','b.txt'],reason:'Implement the file'}),
   tool('collect',{}),tool('read',{path:'a.txt'}),
 ]:[tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}),
   tool('project_staff',{action:'appoint',input:{id:'reader',responsibility:'Read b.txt',models:['fixture/r2'],scope:['b.txt'],need:'deliverable',reason:'Independent material'}}),
   tool('delegate',{staffId:'reader',workId:'main:a.txt',model:'fixture/r2',assignment:'Inspect b.txt',scope:[],readScope:['a.txt','b.txt'],readOnly:true,reason:'Independent observation'}),tool('collect',{}),tool('read',{path:'a.txt'})];
 let leader=0,continued=false,newLeader=0,dropped=false,due,time=0,checkCount=0,resumedInput,interruptNextContinuation=false,writerCalls=0;
 const checkedAgain=Promise.withResolvers();
 const clock={now:()=>time,set(fn){due=fn;return fn;},clear(fn){if(due===fn)due=null;}};
 const f=await fixture(t,async({body},n,req,res)=>{
   if(n===1)return tool('start_work',{action:'start',reason:'bounded collaboration',plan});
   const user=body.messages.findLast(m=>m.role==='user')?.content;
   const raw=typeof user==='string'?user:user?.map(p=>p.text).join('');
   const checker=raw?.includes('cothink-process-observation');
   if(!continued&&!dropped&&(disconnectedRole==='checker'?checker:disconnectedRole==='employee'?body.model==='r2':!checker&&body.model==='main'&&leader===6)){dropped=true;res.destroy();return null;}
   if(checker){if(++checkCount>1)checkedAgain.resolve();return {text:'{"issues":[]}'};}
   if(!continued&&managerAfterCollect&&leader===5){assert.ok(due);time+=60000;due();await checkedAgain.promise;}
   if(body.model==='r2'){
     if(raw?.includes('Independent task preparation'))return {text:employeeDraft?'File implementation understood.':'Read-only task understood.'};
     if(employeeDraft){
       if(writerCalls===2){dropped=true;res.destroy();return null;}
       return [tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]})][writerCalls++];
     }
     if(!body.messages.some(m=>m.role==='tool'))return tool('read',{path:'b.txt'});
     return {text:'COMPLETED_REPORT: b.txt contains base B; no commands or writes were performed.'};
   }
   if(continued&&newLeader===0)resumedInput=structuredClone(body);
   if(continued&&employeeDraft&&newLeader===3)assert.match(body.messages.findLast(m=>m.role==='tool').content,/PROJECT_SCOPE/,'the original grant cannot include outside.txt');
   if(continued&&interruptNextContinuation){if(newLeader++===0)return tool('read',{path:'a.txt'});interruptNextContinuation=false;return {error:503};}
   if(continued)return [tool('read',{path:'a.txt'}),...(employeeDraft?[
     tool('refresh_change',{scope:['a.txt','b.txt'],readScope:['a.txt','b.txt'],reason:'Finish the original authorized step after restoring only A'}),
     tool('refresh_change',{scope:['a.txt','b.txt','outside.txt'],readScope:['a.txt','b.txt'],reason:'Must be refused outside the original plan'}),
     tool('read',{path:'b.txt'}),tool('write',{path:'b.txt',content:'unfinished B\n'}),
     tool('read',{path:'b.txt'}),tool('write',{path:'b.txt',content:'finished B\n'}),
   ]:[]),tool('accept_change',{}),tool('accept_change',{}),{text:'Delivered restored A'}][newLeader++]??{text:'Delivered'};
   return replies[leader++]??{text:'Saved A; employee/checker incomplete.'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f),proposal=await runProjectTurn({...base,input:'Change a.txt and inspect b.txt.',budget:{maxCalls:30}}),root=await confirmProject(base,proposal,{processCheckClock:clock});
 assert.equal(dropped,true,'actual target HTTP request must be disconnected');
 if(employeeDraft){
   const files=await guiFiles(f.home,root.record),file=files.items.find(x=>x.name==='a.txt'&&x.ref?.draft);
   assert.ok(file,'the collected employee draft is already available in the original file panel');
   assert.equal((await guiFile(f.home,readTask(f.home,file.ref.taskId),file.ref)).bytes.toString(),'changed A\n');
   const path=join(f.home,'tasks',file.ref.taskId+'.json'),saved=readFileSync(path),uncollected=JSON.parse(saved);
   uncollected.members.find(m=>m.changeId===file.ref.draft.changeId).collected=false;
   writePrivateJson(path,uncollected);
   try {assert.ok((await inspectFileContinuation({home:f.home,sourceRootTaskId:root.record.id})).blockers.some(b=>b.code==='DRAFT_REQUIRED'),'uncollected employee files are not continuation candidates');}
   finally {writeFileSync(path,saved);}
 }
 const checked=await inspectFileContinuation({home:f.home,sourceRootTaskId:root.record.id});
 assert.equal(checked.eligible,true,JSON.stringify({checked,error:root.record.error}));
 const continueFrom=async source=>{
   const fact=await inspectFileContinuation({home:f.home,sourceRootTaskId:source.id});assert.equal(fact.eligible,true,JSON.stringify(fact.blockers));
   const reservation=await reserveFileContinuation({home:f.home,sessionId:source.sessionId,sourceRootTaskId:source.id,draft:fact.draft,
     submissionId:'continue-'+source.id,authorizationSource:{kind:'file_continuation',sourceTaskId:source.id,mode:'user'},expectedRevision:fact.revision,expectedFormalVersion:fact.formalVersion});
   const saved=readTask(f.home,source.id);continued=true;newLeader=0;
   return runProjectTurn({...base,input:saved.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,
     confirmedOperation:{source:saved,reservation,execute:task=>executeConfirmed(task,saved,reservation)}});
 };
 let source=root.record;
 if(disconnectedRole.endsWith('via-failure')){
   interruptNextContinuation=true;const middle=await continueFrom(source);source=middle.record;
   assert.notEqual(source.status,'completed');assert.equal(readTask(f.home,source.projectOperation.childTaskIds[0]).members.length,0);
 }
 const before=f.calls.length,priorWorkers=f.calls.filter(c=>c.body.model==='r2').length,next=await continueFrom(source);
 assert.equal(f.calls.filter(c=>c.body.model==='r2').length,priorWorkers,'already processed workers are not re-executed by continuation');
 assert.equal(next.record.status,'completed',next.record.error);
 assert.equal(f.calls.length-before,employeeDraft?10:4,'restoring the original grant permits normal implementation without another route judgment');
 if(managerAfterCollect){assert.match(JSON.stringify(resumedInput),/COMPLETED_REPORT/);assert.match(JSON.stringify(resumedInput),/resultRequestId/);assert.match(JSON.stringify(resumedInput),/checkRequestId/);}
 else assert.doesNotMatch(JSON.stringify(resumedInput),/COMPLETED_REPORT/,'incomplete or uncovered worker reports cannot be presented as verified');
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try {const version=(await v.inspect()).version;assert.equal(Buffer.from((await v.read({version,path:'a.txt'})).contentBase64,'base64').toString(),'changed A\n');
   if(employeeDraft)assert.equal(Buffer.from((await v.read({version,path:'b.txt'})).contentBase64,'base64').toString(),'finished B\n');
 }finally{await v.close();}
});
