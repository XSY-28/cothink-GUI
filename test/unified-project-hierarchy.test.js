import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import { repository } from './helpers/git-fixture.js';
import { runProjectTurn, resolveDelivery } from '../src/project-turn.js';
import { confirmProject, projectSession } from "./unified-project.fixture.js";

test('unified project uses four staff layers over Pi HTTP, forwards a blocker and checks the preserved handoff', {timeout:60000}, async t=>{
 const repo=repository(t), path='a.txt', peerPath='b.txt';
 const plan={goal:'Update and verify the four-layer marker',scope:[path,peerPath],readScope:[path,peerPath],
   deliverables:[path,peerPath],collaboration:{workers:2,stepIds:['main']},checks:[
   {command:'node',args:['-e',"const fs=require('fs'),a=fs.readFileSync('a.txt','utf8'),b=fs.readFileSync('b.txt','utf8');if(a!=='four layers\\n'||!['base B\\n','peer saw '+a].includes(b))process.exit(1);console.log(b==='base B\\n'?'Marker checkpoint verified':'Both exact files verified')"]},
 ]};
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const staff=(action,input)=>tool('project_staff',{action,input});
 const appoint=(id,model,scope=[path],readScope=[path])=>staff('appoint',{id,responsibility:id,scope,readScope,
   models:[model],need:'deliverable',reason:'Own a separate bounded responsibility'});
 const promote=(id,models)=>staff('promote',{id,models,subgoal:'Coordinate '+id});
 const delegate=(staffId,model,readOnly,scope=[path],readScope=[path])=>tool('delegate',{staffId,model,readOnly,scope:readOnly?[]:scope,
   readScope,assignment:'Own '+staffId,reason:'Use the approved model and work boundary'});
 const collect=memberId=>tool('collect',{memberId});
 const accept=memberId=>tool('accept_change',{memberId});
 const forward=forwardRequestId=>tool('request_staff_group',{forwardRequestId});
 const result=body=>JSON.parse(body.messages.findLast(m=>m.role==='tool').content);
 const rosters={second:['fixture/main','fixture/r2','fixture/r1'],third:['fixture/r2','fixture/r1']};
 let main=0, second=0, third=0, fourth=0, depth, secondId, thirdId, fourthId, leafHasManagement, grandparentDenial, rootReview, supervisorRouting;
 let peerLead=0, peerWorker=0, peerLeadId, peerWorkerId, peerSawHandoff, paused, resumed, firstAcceptance;
 let leafReport, thirdReport, rootReport;
 const report={blocker:'The marker needs an independent peer record',scope:[peerPath],dependsOn:['main:a.txt'],maxCalls:10};
 let overlappingMainSends=0;
 const overlap=Promise.withResolvers();
 const meet=async()=>{
   if(++overlappingMainSends===2)overlap.resolve();
   await overlap.promise;
 };
 const f=await fixture(t,async({body},n)=>{
   if(n===1)return tool('start_work',{action:'start',reason:'edit with delegated responsibility',plan});
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   const names=(body.tools??[]).map(x=>x.function.name);
   if(names.includes('accept_change')){
     switch(++main){
       case 1:return staff('set_depth',{maxDepth:4});
       case 2:depth=result(body).maxDepth;return appoint('second','fixture/main');
       case 3:return promote('second',rosters.second);
       case 4:return delegate('second','fixture/main',true);
       case 5:secondId=result(body).memberId;await meet();return collect(secondId);
       case 6:
         rootReport=result(body).members?.[0]?.staffGroupRequests?.[0];
         if(!rootReport)return {text:'The forwarded request has not reached the root.'};
         return appoint('peer-lead','fixture/r3',rootReport.proposal.scope,[path,peerPath]);
       case 7:return promote('peer-lead',['fixture/r3','fixture/r2']);
       case 8:return accept(fourthId);
       case 9:rootReview=result(body);return accept(fourthId);
       case 10:
         firstAcceptance=result(body);
         return delegate('peer-lead','fixture/r3',true,[peerPath],[path,peerPath]);
       case 11:peerLeadId=result(body).memberId;return collect(peerLeadId);
       case 12:return accept(peerWorkerId);
       case 13:return accept(peerWorkerId);
       default:return {text:'The four-layer marker and peer record are delivered.'};
     }
   }
   if(body.model==='main' && names.includes('project_staff')){
     switch(++second){
       case 1:{
         const user=body.messages.findLast(message=>message.role==='user');
         const content=typeof user?.content==='string'?user.content:user?.content?.find(part=>part.type==='text')?.text;
         try { supervisorRouting=JSON.parse(content).execution; } catch {}
         return appoint('third','fixture/r2');
       }
       case 2:return promote('third',rosters.third);
       case 3:return delegate('third','fixture/r2',true);
       case 4:thirdId=result(body).memberId;return collect(thirdId);
       case 5:thirdReport=result(body).members?.[0]?.staffGroupRequests?.[0];return forward(thirdReport?.id);
       default:return {text:'Third-layer report collected.'};
     }
   }
   if(body.model==='main' && JSON.stringify(body.messages).includes('Independent task preparation'))await meet();
   if(body.model==='r2' && names.includes('project_staff')){
     switch(++third){
       case 1:return appoint('fourth','fixture/r1');
       case 2:return delegate('fourth','fixture/r1',false);
       case 3:fourthId=result(body).memberId;return collect(secondId);
       case 4:grandparentDenial=result(body).error;return collect(fourthId);
       case 5:leafReport=result(body).members?.[0]?.staffGroupRequests?.[0];return forward(leafReport?.id);
       case 6:return tool('pause_member',{memberId:fourthId,reason:'Preserve the fixed marker while escalating the peer check'});
       case 7:return collect(fourthId);
       default:
         if(!paused){
           const receipt=result(body).members?.[0]?.pause;
           if(receipt?.status!=='settled')return collect(fourthId);
           paused=receipt;
           return tool('resume_candidate',{memberId:fourthId,candidate:paused.candidate,
             privateVersion:paused.privateVersion,reason:'Use the exact preserved marker as the peer input'});
         }
         resumed=result(body);
         return {text:'Fourth-layer candidate inspected, preserved and released for root review.'};
     }
   }
   if(body.model==='r3' && names.includes('project_staff')){
     switch(++peerLead){
       case 1:return appoint('peer-writer','fixture/r2',[peerPath],[path,peerPath]);
       case 2:return delegate('peer-writer','fixture/r2',false,[peerPath],[path,peerPath]);
       case 3:peerWorkerId=result(body).memberId;return collect(peerWorkerId);
       default:return {text:'The peer record was inspected.'};
     }
   }
   if(body.model==='r2' && names.includes('edit')){
     switch(++peerWorker){
       case 1:return tool('read',{path});
       case 2:
         peerSawHandoff=body.messages.findLast(m=>m.role==='tool')?.content;
         return tool('read',{path:peerPath});
       case 3:return tool('edit',{path:peerPath,edits:[{oldText:'base B',newText:'peer saw four layers'}]});
       default:return {text:'Recorded the exact observed marker.'};
     }
   }
   if(body.model==='r1' && names.includes('edit')){
     leafHasManagement=names.some(x=>['project_staff','delegate','collect','feedback','accept_change'].includes(x));
     if(++fourth===1)return tool('read',{path});
     if(fourth===2)return tool('edit',{path,edits:[{oldText:'base A',newText:'four layers'}]});
     if(fourth===3)return tool('request_staff_group',report);
   }
   return {text:'I understand the original marker task and its scope.'};
 });
 const base=await projectSession(t,repo,f);
 const source=await runProjectTurn({...base,input:'Update a.txt to the exact marker four layers and record the peer observation in b.txt.',budget:{maxCalls:65}});
 assert.ok(source.record.proposal,source.record.error);
 const root=await confirmProject(base,source);
 const delivery=resolveDelivery(f.home,root.record);
 assert.equal(root.record.status,'completed',root.record.error+' '+JSON.stringify(f.calls.at(-1)?.body.messages.findLast(m=>m.role==='tool')));
 const child=delivery[0].record;
 assert.equal(depth,4);
 assert.equal(overlappingMainSends,2);
 assert.equal(readFileSync(join(child.work.resultWorkspace,path),'utf8'),'four layers\n');
 assert.equal(readFileSync(join(repo.project,path),'utf8'),'base A\n');
 assert.equal(readFileSync(join(child.work.resultWorkspace,peerPath),'utf8'),'peer saw four layers\n');
 assert.equal(readFileSync(join(repo.project,peerPath),'utf8'),'base B\n');
 assert.deepEqual(rootReport?.proposal,report);
 assert.deepEqual([leafReport?.dispatchId,thirdReport?.dispatchId,rootReport?.dispatchId],[fourthId,thirdId,secondId]);
 assert.equal(thirdReport?.forwardedFrom,leafReport?.id);
 assert.equal(rootReport?.forwardedFrom,thirdReport?.id);
 assert.equal(resumed?.candidate,paused?.candidate);
 assert.equal(resumed?.privateVersion,paused?.privateVersion);
 assert.equal(resumed?.status,'ready_for_root_review');
 assert.equal(firstAcceptance?.candidateVersion,paused?.candidate);
 assert.equal(firstAcceptance?.verification,'passed');
 assert.match(String(peerSawHandoff),/four layers/);
 const peer=child.members.find(m=>m.memberId===peerWorkerId);
 assert.equal(peer?.baseVersion,firstAcceptance?.acceptedVersion);
 assert.deepEqual(peer?.scope,[peerPath]);
 assert.equal(child.work.finalCheck.status,'passed');
 assert.equal(child.work.finalCheck.version,child.work.version);
 const {createVersioning}=await import('../src/versioning.js');
 const audit=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try {
   const output=await audit.read({outputRef:child.work.finalCheck.checks[0].outputRef});
   assert.match(Buffer.from(output.contentBase64,'base64').toString(),/Both exact files verified/);
 } finally { await audit.close(); }
 assert.equal(grandparentDenial?.code,'GROUP_OWNERSHIP');
 assert.equal(rootReview?.status,'review_required');
 assert.match(JSON.stringify(rootReview.diff),/four layers/);
 assert.equal(leafHasManagement,false);
 assert.deepEqual(supervisorRouting?.modelRoutes?.map(model=>model.identity),['fixture/main','fixture/r1','fixture/r2']);
 assert.ok(supervisorRouting.modelRoutes.every(model=>model.available&&model.transport==='project-http'));
 assert.ok(supervisorRouting.budget.remainingCalls>0 && supervisorRouting.budget.remainingCalls<64);
 assert.deepEqual(child.members.map(m=>[m.memberId,m.supervisorMemberId]),[
   [secondId,null],[thirdId,secondId],[fourthId,thirdId],[peerLeadId,null],[peerWorkerId,peerLeadId],
 ]);
 assert.equal(new Set(child.members.map(m=>m.sessionFile)).size,5);
 assert.deepEqual(child.members.map(m=>m.model.modelId),['main','r2','r1','r3','r2']);
 assert.ok(child.members.every(m=>m.callId && m.sessionFile));
 assert.ok(root.record.collaborationResult?.some(row=>row.status==='fulfilled'&&row.evidence.some(worker=>worker.memberId===fourthId)));
 assert.ok(child.work.capacity.every(c=>c.active>=0 && c.active<=2));
 assert.equal(Math.max(...child.work.capacity.map(c=>c.active)),2);
 assert.equal(child.work.capacity.at(-1).active,0);
 assert.equal(root.record.rootRequests.filter(r=>!r.notSent).length,f.calls.length-1);
});
