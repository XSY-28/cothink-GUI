import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, watch } from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import { repository } from './helpers/git-fixture.js';
import { runProjectTurn, digest } from '../src/project-turn.js';
import { confirmProject, projectSession } from "./unified-project.fixture.js";

test('confirmed GUI plan overlaps three independent HTTP requests and starts D from checked A while B and C are still in flight', {timeout: 75_000}, async t => {
 const {projectChatState,runProjectCommand}=await import('../src/project.js');
 const {writePrivateJson}=await import('../src/storage.js');
 const repo=repository(t),ids=['a','b','c','d'];
 const checks=id=>[{command:'node',args:['-e',`const fs=require('node:fs');if(fs.readFileSync('${id}.txt','utf8')!=='approved ${id}\\n')process.exit(1)`]}];
 const plan={goal:'Build four approved text files',scope:ids.map(id=>id+'.txt'),steps:ids.map(id=>({
   id,goal:`Build approved ${id}`,scope:[id+'.txt'],deliverables:[id+'.txt'],checks:checks(id),
   ...(id==='d'?{dependsOn:['a']}:{dependsOn:[]}),
 }))};
 const tool=(name,args={})=>({toolCalls:[{name,args}]});
 const initial=new Set(),turns={},errors=[];
 let overlap,earlyD,dSawA,readWhilePeersOutstanding,memberSawA,memberTurns=0,liveRevisionRejected;
 const abc=Promise.withResolvers(),dStarted=Promise.withResolvers();
 const wait=(barrier,ms)=>new Promise(resolve=>{const timeout=setTimeout(resolve,ms);barrier.then(()=>{clearTimeout(timeout);resolve();});});
 const f=await fixture(t,async ({body},n)=>{
   if(n===1)return tool('start_work',{action:'start',reason:'independent scopes and explicit dependency',plan});
   const messages=JSON.stringify(body.messages);
   if(messages.includes('cothink-process-observation'))return {text:JSON.stringify({issues:[]})};
   if(messages.includes('verifiedStepReports'))return {text:'Delivered all four checked files.'};
   if(body.model==='r1'){
     memberTurns++;
     if(!body.tools?.some(tool=>tool.function.name==='report_task_conflict'))return {text:'Read the accepted A input for D.'};
     if(memberTurns===2)return tool('read',{path:'a.txt'});
     memberSawA=messages.includes('approved a');return {text:'The accepted A input says approved a.'};
   }
   const id=messages.match(/\\"stepId\\":\\"([a-d])\\"/)?.[1];
   if(!id){errors.push(`Cannot identify step in HTTP request ${n}`);return {text:'Cannot identify step'};}
   const turn=turns[id]=(turns[id]??0)+1;
   const path=id+'.txt',content=`approved ${id}\n`;
   if(turn===1){
     initial.add(id);
     if(['a','b','c'].every(x=>initial.has(x))){
       overlap=[...initial];
       const {projectId}=await projectChatState(f.home,repo.project);
       try {
         await assert.rejects(runProjectCommand({home:f.home,cwd:repo.project,args:['revise','--step','b','--goal','Unapproved change']}),/owning GUI root/);
         const commandId='late-legacy-revision';
         writePrivateJson(join(f.home,'project-delivery',projectId,'controls',commandId+'.json'),
           {id:commandId,action:'revise',steps:['b'],goal:'Unapproved inbox revision'});
         for(let i=0;i<40;i++){
           const {state}=await projectChatState(f.home,repo.project);
           if(state.commands[commandId]){
             liveRevisionRejected=state.commands[commandId].error;
             break;
           }
           await new Promise(resolve=>setTimeout(resolve,20));
         }
       } catch(error){errors.push(error.message);}
       finally{abc.resolve();}
     }
     if(id==='a')await wait(abc.promise,5000);
     if(id==='b'||id==='c')await wait(dStarted.promise,14_000);
     if(id==='d')earlyD=[...initial];
     initial.delete(id);
   }
   const tasks=id==='a'||id==='b'?[tool('read',{path}),tool('edit',{path,edits:[{oldText:`base ${id.toUpperCase()}`,newText:`approved ${id}`}]}),tool('accept_change')]:
      id==='c'?[tool('write',{path,content}),tool('accept_change')]:
      [tool('read',{path:'a.txt'}),tool('project_staff',{action:'appoint',input:{
        id:'dependency-reader',responsibility:'Verify the specific A input that D relies on',scope:[],readScope:['a.txt','d.txt'],
        models:['fixture/r1'],need:'deliverable',reason:'Independent input validation needs a read-only seat.',
      }}),tool('delegate',{staffId:'dependency-reader',model:'fixture/r1',workId:'d:d.txt',
        assignment:'Read the approved A input before building D.',reason:'Verify upstream bytes.',readOnly:true,scope:[],readScope:['a.txt','d.txt'],
      }),tool('collect'),tool('write',{path,content}),tool('accept_change')];
   if(id==='d'&&turn===2){
     dSawA=messages.includes('approved a');
     readWhilePeersOutstanding=['b','c'].every(peer=>initial.has(peer));
     dStarted.resolve();
   }
   return tasks[turn-1]??{text:`Delivered ${id}.`};
 });
 const base=await projectSession(t,repo,f);
 base.frozenConfig.work.maxConcurrentRequests=3;
 const source=await runProjectTurn({...base,input:'Build four approved files from the agreed dependencies.',budget:{maxCalls:30}});
 assert.ok(source.record.proposal,source.record.error);
 const root=await confirmProject(base,source);
 const debug=(await projectChatState(f.home,repo.project)).state;
 if(root.record.status!=='completed')t.diagnostic(JSON.stringify({turns,errors,rootError:root.record.error,projectError:debug.error,steps:debug.steps.map(({id,status,error})=>({id,status,error}))}));
 assert.deepEqual(overlap?.sort(),['a','b','c'],'A, B and C must reach the HTTP server before any of those first responses is sent');
 assert.deepEqual(earlyD?.sort(),['b','c','d'],'D must reach the server while B and C first responses are still held');
 assert.equal(dSawA,true,'D receives a real read result containing the accepted A bytes');
 assert.equal(readWhilePeersOutstanding,true,'the physical request carrying A’s bytes precedes the held B/C responses');
 assert.equal(memberSawA,true,'the new D position reads the same approved dependency in its own session');
 assert.deepEqual(errors,[]);
 assert.match(liveRevisionRejected??'',/Legacy inbox controls cannot mutate/);
 assert.equal(root.record.status,'completed',root.record.error);
 const sent=f.calls.length;
 const {state}=await projectChatState(f.home,repo.project);
 assert.equal(f.calls.length,sent,'opening saved project state emits zero model calls');
 assert.equal(state.delivery.version,state.version);
 const combined=state.finalChecks.at(-1).check;
 assert.equal(combined.version,state.delivery.version);
 assert.equal(combined.status,'passed');
 assert.deepEqual(combined.checks.map(({command,args})=>({command,args})),ids.flatMap(checks));
 assert.equal(state.revision,1,'late old control cannot alter the approved check catalog');
 assert.ok(Object.values(state.staffAssignments).some(a=>a.staffId==='dependency-reader'&&a.model==='fixture/r1'));
 const byId=Object.fromEntries(state.steps.map(step=>[step.id,step]));
 for(const id of ids){
   const [attempt]=byId[id].attempts;
   assert.equal(byId[id].attempts.length,1);
   assert.deepEqual(attempt.check.checks.map(({command,args})=>({command,args})),checks(id));
   assert.equal(attempt.check.version,attempt.version);
   assert.equal(attempt.check.binding.policy,attempt.checkPolicy.digest);
   assert.deepEqual(attempt.artifacts.map(x=>x.path),[id+'.txt']);
 }
 assert.equal(byId.d.attempts[0].inputArtifacts[0].deliveredVersion,byId.a.attempts[0].version);
 assert.equal(byId.d.attempts[0].inputArtifacts[0].inputHash,byId.a.attempts[0].artifacts[0].sha256);
 const {createVersioning}=await import('../src/versioning.js');
 const versioning=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 t.after(()=>versioning.close());
 const history=await versioning.inspect({history:{limit:20}});
 const ownVersions=ids.map(id=>byId[id].attempts[0].acceptedVersion);
 assert.equal(new Set(ownVersions).size,4);
 assert.deepEqual(history.versions.slice(0,4).map(row=>row.version).sort(),ownVersions.sort());
 assert.equal(history.versions[4].version,repo.baseVersion);
 assert.equal((await versioning.inspect()).integrationRef,state.integrationRef);
 assert.equal(f.calls.length,sent);
});

test('a pre-capability GUI proposal with implicit array order retains sequential execution after confirmation', {timeout:30_000}, async t=>{
 const repo=repository(t), steps=['a','b'].map(id=>({
   id,goal:`Verify ${id}`,scope:[id+'.txt'],deliverables:[id+'.txt'],
   checks:[{command:'node',args:['-e',`require('node:fs').accessSync('${id}.txt')`]}],
 }));
 let aFinished=false,bStartedAfterA;
 const f=await fixture(t,async ({body},n)=>{
   if(n===1)return {toolCalls:[{name:'start_work',args:{action:'start',reason:'verify in listed order',plan:{goal:'Verify both files',scope:['a.txt','b.txt'],steps}}}]};
   const id=JSON.stringify(body.messages).match(/\\"stepId\\":\\"([ab])\\"/)?.[1];
   if(id==='a'){await new Promise(resolve=>setTimeout(resolve,300));aFinished=true;}
   if(id==='b')bStartedAfterA=aFinished;
   return {text:`Verified ${id}.`};
 });
 const base=await projectSession(t,repo,f);
 base.frozenConfig.work.maxConcurrentRequests=3;
 const source=await runProjectTurn({...base,input:'Verify each existing file.'});
 assert.ok(source.record.proposal,source.record.error);
 assert.equal(source.record.proposal.stepScheduling,'sequential-v1');
 // The original serialized shape predates the host scheduling capability.
 delete source.record.proposal.stepScheduling;
 source.record.proposalRef.planDigest=digest(source.record.proposal);source.save();
 const root=await confirmProject(base,source);
 assert.equal(root.record.status,'completed',root.record.error);
 assert.equal(bStartedAfterA,true);
 const {projectChatState}=await import('../src/project.js');
 assert.equal((await projectChatState(f.home,repo.project)).state.stepScheduling,undefined);
 assert.equal(f.calls.filter(({body})=>{const messages=JSON.stringify(body.messages);return !messages.includes('verifiedStepReports')&&/\\"stepId\\":\\"[ab]\\"/.test(messages);}).length,2,'each historical step sent one manager request');
});

test('reopening a paused parallel project preserves accepted A and unknown B while explicit resume dispatches only C and D', {timeout:65_000}, async t=>{
 const {projectChatState,readProject}=await import('../src/project.js');
 const {readRequest}=await import('../src/task.js');
 const repo=repository(t), ids=['a','b','c','d','e'];
 const pathFor=id=>id==='e'?'b.txt':id+'.txt';
 const plan={goal:'Build independent artifacts and a dependent summary',scope:['a.txt','b.txt','c.txt','d.txt'],steps:ids.map(id=>({
   id,goal:`Build ${id}`,scope:[pathFor(id)],deliverables:[pathFor(id)],
   dependsOn:id==='d'?['a']:[],
   checks:[{command:'node',args:['-e',`const fs=require('node:fs');if(fs.readFileSync('${pathFor(id)}','utf8')!=='saved ${id}\\n')process.exit(1)`]}],
 }))};
 const tool=(name,args={})=>({toolCalls:[{name,args}]});
 const controller=new AbortController(), bStarted=Promise.withResolvers();
 const counts={}; let watchState, confirmedCheckpoint, resumeRef, resumePlanners=0, dReadsApprovedA=false;
 const f=await fixture(t,async ({body},n)=>{
   if(n===1)return tool('start_work',{action:'start',reason:'confirm separate work and dependencies',plan});
   if(resumeRef&&body.tools?.some(tool=>tool.function.name==='start_work')){
     resumePlanners++;return tool('start_work',{action:'resume',reason:'continue only proven remaining steps',planRef:resumeRef});
   }
   const messages=JSON.stringify(body.messages),id=messages.match(/\\"stepId\\":\\"([a-e])\\"/)?.[1];
   if(!id)return {text:'No bound step'};
   const turn=counts[id]=(counts[id]??0)+1;
   if(id==='b'){
     const {projectId}=await projectChatState(f.home,repo.project),dir=join(f.home,'project-delivery',projectId);
     watchState=watch(dir,(_event,file)=>{
       if(String(file)!=='state.json')return;
       const state=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'));
       if(state.steps[0].status!=='completed')return;
       confirmedCheckpoint=state;
       watchState.close();controller.abort();
     });
     bStarted.resolve();
     // Deliberately keep the original HTTP request without a decisive response.
     return null;
   }
   if(id==='a'&&turn===1)await bStarted.promise;
   if(id==='d'&&turn===2)dReadsApprovedA=messages.includes('saved a');
   const list=id==='a'?[tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved a'}]}),tool('accept_change')]:
     [...(id==='d'?[tool('read',{path:'a.txt'})]:[]),tool('write',{path:pathFor(id),content:`saved ${id}\n`}),tool('accept_change')];
   return list[turn-1]??{text:`Saved ${id}.`};
 });
 t.after(()=>watchState?.close());
 const base=await projectSession(t,repo,f), source=await runProjectTurn({...base,input:'Build files with the given dependencies.',budget:{maxCalls:25}});
 const root=await confirmProject(base,source,{signal:controller.signal});
 assert.ok(confirmedCheckpoint,'paused immediately after a durable completed-A checkpoint');
 assert.deepEqual(counts,{a:4,b:1});
 const countBeforeQuery=f.calls.length, paused=await readProject(f.home,repo.project);
 assert.equal(f.calls.length,countBeforeQuery,'reopen/status reads make no physical requests');
 assert.equal(paused.status,'paused');
 const [a,b,c,d,e]=paused.steps;
 assert.equal(a.status,'completed');assert.equal(b.status,'unknown');
 assert.ok([...c.attempts,...d.attempts,...e.attempts].every(a=>!a.requestIds?.length),'no later step was physically sent; a persisted admission intent may have raced stop');
 const bAttempt=b.attempts[0],bRequest=readRequest(f.home,bAttempt.taskId,bAttempt.requestIds[0]);
 assert.equal(bRequest.sent,true);assert.equal(bRequest.status,'outcome_unknown');
 resumeRef={taskId:root.record.id,field:'proposal',sha256:digest(root.record.proposal)};
 const continuation=await runProjectTurn({...base,input:'Explicitly continue this paused project.',contextTaskIds:[source.record.id,root.record.id],budget:{maxCalls:25}});
 assert.ok(continuation.record.proposal,continuation.record.error);
 await confirmProject(base,continuation);
 const resumed=await readProject(f.home,repo.project);
 assert.equal(resumePlanners,1);
 assert.deepEqual(counts,{a:4,b:1,c:3,d:4});
 assert.equal(dReadsApprovedA,true);
 assert.equal(resumed.steps[0].attempts.length,1);
 assert.equal(resumed.steps[0].attempts[0].acceptedVersion,a.attempts[0].acceptedVersion);
 assert.equal(resumed.steps[1].status,'unknown');
 assert.deepEqual(resumed.steps[1].attempts[0].requestIds,bAttempt.requestIds);
 assert.equal(resumed.steps[2].status,'completed');assert.equal(resumed.steps[3].status,'completed');
 assert.equal(resumed.steps[4].attempts.length,0,'overlap with unresolved B remains on hold');
 assert.equal(resumed.delivery,undefined,'unresolved B cannot be called a completed project');
});

test('configured three-seat limit admits three employees in one confirmed step after its manager yields', {timeout:40_000},async t=>{
 const repo=repository(t),paths=['a.txt','b.txt','.gitignore'];
 const plan={goal:'Inspect three existing files independently',scope:paths,deliverables:paths,
   checks:[{command:'node',args:['-e',`const fs=require('fs');for(const path of ${JSON.stringify(paths)})fs.accessSync(path)`]}]};
 const tool=(name,args={})=>({toolCalls:[{name,args}]});
 const groups=paths.map((path,i)=>({id:`reader-${i}`,path,assignment:`Inspect seat ${i} independently`}));
 const tools=[...groups.map(g=>tool('project_staff',{action:'appoint',input:{id:g.id,responsibility:g.assignment,
   scope:[],readScope:[g.path],models:['fixture/r1'],need:'deliverable',reason:'Each file has a separate read boundary.'}})),
   ...groups.map(g=>tool('delegate',{staffId:g.id,model:'fixture/r1',workId:'main:'+g.path,
     assignment:g.assignment,reason:'Separate file inspection.',readOnly:true,scope:[],readScope:[g.path]})),
   ...groups.map(()=>tool('collect'))];
 let leader=0,physical=new Set(),observed;
 const all=Promise.withResolvers(),firstSeen=new Set();
 const f=await fixture(t,async ({body},n)=>{
   if(n===1)return tool('start_work',{action:'start',reason:'three independent file inspections',plan});
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:JSON.stringify({issues:[]})};
   if(body.model!=='r1')return tools[leader++]??{text:'All three files were inspected.'};
   const messages=JSON.stringify(body.messages),group=groups.find(g=>messages.includes(g.assignment));
   if(!group)return {text:'Independent preparation confirmed.'};
   if(!firstSeen.has(group.id)){
     firstSeen.add(group.id);physical.add(group.id);
     if(physical.size===3){observed=[...physical];all.resolve();}
     await new Promise(resolve=>{const timer=setTimeout(resolve,5000);all.promise.then(()=>{clearTimeout(timer);resolve();});});
     physical.delete(group.id);
   }
   return {text:'The file boundary is understood and the inspection is complete.'};
 });
 const base=await projectSession(t,repo,f);base.frozenConfig.work.maxConcurrentRequests=3;
 const source=await runProjectTurn({...base,input:'Inspect the three files independently.',budget:{maxCalls:30}});
 const root=await confirmProject(base,source);
 assert.deepEqual(observed?.sort(),groups.map(g=>g.id));
 const {projectChatState}=await import('../src/project.js');
 const {state}=await projectChatState(f.home,repo.project);
 assert.equal(root.record.status,'completed',root.record.error??state.steps[0].error);
});
