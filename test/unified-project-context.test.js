import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createGuiMaterialStore} from '../src/gui-materials.js';
import {payloadImageHashes} from '../src/visual-preview.js';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createRuntime} from '../src/pi-runtime.js';
import {cothinkExtension} from '../src/extensions/cothink.js';
import {runProjectTurn,reserveConfirmation,executeConfirmed,digest} from '../src/project-turn.js';

test('resumed workers and members, and revised workers, receive frozen inputs and inherited source identities',async t=>{
 const repo=repository(t),plan={goal:'Inspect tracked text',scope:['a.txt'],readScope:['.'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};
 let action='start',planRef,leaderTurn=0,appointed=false,readerId;
 const memberBodies=[],workerBodies=[];
 const f=await fixture(t,({body})=>{
   const names=body.tools?.map(x=>x.function.name)??[];
   if(names.includes('start_work'))return {toolCalls:[{name:'start_work',args:action==='resume'?{action,reason:'Continue failed step',planRef}:{action,reason:'Inspect text',plan:{...plan,goal:action==='revise'?'Inspect text again':plan.goal}}}]};
   if(body.model==='r1'){memberBodies.push(body);return {text:'Inspected authorized input'};}
   workerBodies.push(body);
   const staffResult=body.messages.findLast(m=>m.role==='tool');
   if(staffResult){const value=JSON.parse(staffResult.content);if(value.id&&value.supervisorId==='root')readerId=value.id;}
   const tool=(name,args)=>({toolCalls:[{name,args}]});
   if(!appointed){appointed=true;return tool('project_staff',{action:'appoint',input:{id:'reader-'+action,responsibility:'Inspect text',scope:[],readScope:['.'],models:['fixture/r1'],need:'deliverable',reason:'Read-only inspection'}});}
   switch(leaderTurn++%3){
     case 0:return tool('delegate',{staffId:readerId,model:'fixture/r1',assignment:'Inspect text',reason:'Read-only inspection',readOnly:true,scope:[],readScope:['.']});
     case 1:return tool('collect',{});
     default:return {text:'Inspection complete'};
   }
 });
 const modelPath=join(f.home,'pi','models.json'),catalog=JSON.parse(readFileSync(modelPath,'utf8'));
 for(const model of catalog.providers.fixture.models)model.input.push('image');
 writeFileSync(modelPath,JSON.stringify(catalog));
 const store=createGuiMaterialStore(f.home),bytes=Buffer.from('UklGRjYAAABXRUJQVlA4ICoAAACwAQCdASoCAAMAAUAmJZgCdLoABGaAAP77jUv7g5cuIKMv3QZZwzmAAAA=','base64');
 const upload={ownerId:randomUUID(),uploadId:randomUUID(),name:'Project input.webp',mediaType:'image/webp',
  byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 store.begin(upload);
 const material=store.read(await store.publish({...upload,body:bytes}));
 const host={allowWork:true,flow:'unified'},rt=await createRuntime({home:f.home,cwd:repo.project,modelRef:f.models.main,projectManaged:true,extensionFactories:[{name:'cothink',factory:cothinkExtension(host)}]});t.after(()=>rt.dispose());rt.hostContext=task=>{host.task=task;host.runtime=rt;};
 const base={home:f.home,cwd:repo.project,workspace:{id:null,project:repo.project},frozenConfig:{formatVersion:2,...f.models,work:{execution}},mainRuntime:rt};
 const markerId=rt.sessionManager.appendMessage({role:'user',content:[{type:'text',text:'INHERITED_CONTEXT_MARKER'}],timestamp:1});
 async function confirm(source,extra={}){
   const reservation=await reserveConfirmation({home:f.home,source:source.record,proposalRef:source.record.proposalRef,sessionId:source.record.sessionId,workspaceId:null,submissionId:'confirm-'+source.record.id,save:source.save});
   return runProjectTurn({...base,...extra,input:source.record.input,taskId:reservation.taskId,submissionId:reservation.submissionId,confirmedOperation:{source:source.record,reservation,execute:task=>executeConfirmed(task,source.record,reservation)}});
 }
 const source=await runProjectTurn({...base,input:'Inspect a.txt and preserve UNIQUE_START_REQUIREMENT',materials:[material]});
 assert.equal(source.record.handoffContext.attachmentRefs[0].sha256,upload.sha256);
 assert.equal(source.record.handoffContext.attachmentRefs[0].userEntryId!==undefined,true);
 assert.ok(!JSON.stringify(source.record.handoffContext).includes(bytes.toString('base64')));
 const abort=new AbortController(),create=ModelRuntime.create;
 const mocked=t.mock.method(ModelRuntime,'create',async function(...args){abort.abort();await new Promise(resolve=>setImmediate(resolve));return create.apply(this,args);});
 const first=await confirm(source,{signal:abort.signal});mocked.mock.restore();
 assert.equal(first.record.status,'cancelled');assert.equal(workerBodies.length,0);
 planRef={taskId:first.record.id,field:'proposal',sha256:digest(first.record.proposal)};action='resume';
 const resumeProposal=await runProjectTurn({...base,input:'Continue; retain UNIQUE_RESUME_REQUIREMENT',contextTaskIds:[source.record.id,first.record.id]}),resumed=await confirm(resumeProposal);
 assert.equal(resumed.record.status,'completed',resumed.record.error);
 assert.ok(memberBodies.length>=2,'member preparation and assigned request actually sent');
 for(const body of [workerBodies[0],...memberBodies]){
   assert.ok(payloadImageHashes(body).has(upload.sha256),'project request carries a typed WebP block');
   const sent=JSON.stringify(body.messages);
   for(const marker of ['UNIQUE_START_REQUIREMENT','UNIQUE_RESUME_REQUIREMENT','INHERITED_CONTEXT_MARKER',markerId,source.record.id])assert.ok(sent.includes(marker),marker);
 }
 const before=workerBodies.length;action='revise';appointed=false;
 const proposal=await runProjectTurn({...base,input:'Revise inspection; preserve UNIQUE_REVISE_REQUIREMENT',contextTaskIds:[source.record.id,first.record.id,resumed.record.id]}),revised=await confirm(proposal);
 assert.equal(revised.record.status,'completed',revised.record.error);assert.ok(workerBodies.length>before,'revised worker actually sent');
 for(const body of workerBodies.slice(before)){
   assert.ok(payloadImageHashes(body).has(upload.sha256),'project request carries a typed WebP block');
   const sent=JSON.stringify(body.messages);
   for(const marker of ['UNIQUE_START_REQUIREMENT','UNIQUE_RESUME_REQUIREMENT','UNIQUE_REVISE_REQUIREMENT',source.record.id,resumed.record.id])assert.ok(sent.includes(marker),marker);
 }
});
