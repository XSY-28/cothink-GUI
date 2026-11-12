import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import { opts } from "./unified-turn.fixture.js";
import {applyThinkingSelection} from '../src/thinking.js';

test('process checking can return an actionable report to the manager during collect',async t=>{
 const controller=new AbortController();
 let sawIssue=false;
 const f=await fixture(t,({body})=>{
   const observation=body.messages.findLast(message=>JSON.stringify(message.content).includes('cothink-process-observation'));
   if(observation){
     const content=typeof observation.content==='string'?observation.content:observation.content.find(part=>part.type==='text').text;
     const worker=JSON.parse(content).members.find(member=>member.evidenceIds.length);
     return {text:JSON.stringify({issues:worker?[{memberId:worker.memberId,kind:'blocker',
       evidenceIds:worker.evidenceIds,reason:'Worker has not returned a required result'}]:[]})};
   }
   if(body.model==='r2')return null;
   const tools=body.messages.filter(message=>message.role==='tool');
   if(!tools.length)return {toolCalls:[{name:'delegate',args:{
     workId:'pending-observation',model:'fixture/r2',assignment:'Independent work',reason:'Independent evidence',
   }}]};
   if(tools.length===1)return {toolCalls:[{name:'collect',args:{assignmentId:JSON.parse(tools[0].content).assignmentId}}]};
   const report=JSON.parse(tools[1].content);
   sawIssue=report.status==='running'&&report.progressReports.some(issue=>issue.kind==='blocker');
   controller.abort();
   return null;
 });
 const path=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
 for(const model of catalog.providers.fixture.models)model.reasoning=true;
 writeFileSync(path,JSON.stringify(catalog));
 const options=opts(f);
 const running=runProjectTurn({...options,frozenConfig:applyThinkingSelection(options.frozenConfig,{level:'low',scope:'all'}),input:'Compare evidence.',signal:controller.signal,processCheckClock:{interval:20}});
 const timer=setTimeout(()=>controller.abort(),5000);timer.unref();
 const task=await running.finally(()=>clearTimeout(timer));
 assert.equal(sawIssue,true);
 assert.ok(task.record.processCheck.reports.some(report=>report.status==='forwarded'));
 assert.notEqual(task.record.status,'completed');
 assert.ok(task.record.processCheck.observations.some(observation=>observation.kind==='periodic'));
 assert.ok(f.calls.every(call=>call.body.reasoning_effort==='low'));
});

for(const thinking of ['low','high','max'])test(`supervisor and direct report retain ${thinking} across corrections`,async t=>{
 let supervisorCalls=0;
 const f=await fixture(t,({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   const tools=body.messages.filter(message=>message.role==='tool');
   if(body.model==='r2')return {text:JSON.stringify(body.messages).includes('Include the units')?'Corrected value 2 m':'Uncorrected value 2'};
   if(body.model==='r1'){
     supervisorCalls++;
     if(!body.tools?.some(tool=>tool.function.name==='feedback'))return {text:'Supervisor tools were missing'};
     if(supervisorCalls===1)return {toolCalls:[{name:'delegate',id:'child',args:{
       workId:'measure',model:'fixture/r2',assignment:'Check the measured value',reason:'Independent calculation',
     }}]};
     if(supervisorCalls===2)return {toolCalls:[{name:'collect',id:'first-collect',args:{assignmentId:JSON.parse(tools.at(-1).content).assignmentId}}]};
     if(supervisorCalls===3)return {toolCalls:[{name:'feedback',id:'correct',args:{
       assignmentId:JSON.parse(tools.at(-1).content).assignmentId,feedback:'Include the units',
     }}]};
     if(supervisorCalls===4)return {toolCalls:[{name:'collect',id:'corrected-collect',args:{assignmentId:JSON.parse(tools.at(-1).content).assignmentId}}]};
     return {text:JSON.parse(tools.at(-1).content).report};
   }
   if(!tools.length)return {toolCalls:[{name:'delegate',id:'supervisor',args:{
     workId:'supervise',model:'fixture/r1',assignment:'Oversee measurement report',reason:'Can manage the calculation',canDelegate:true,
   }}]};
   if(tools.length===1)return {toolCalls:[{name:'collect',args:{assignmentId:JSON.parse(tools[0].content).assignmentId}}]};
   return {text:JSON.parse(tools.at(-1).content).report};
 });
 const path=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
 for(const model of catalog.providers.fixture.models)model.reasoning=true;
 writeFileSync(path,JSON.stringify(catalog));
 f.models.secondary=f.models.secondary.filter(ref=>ref.modelId!=='r3');
 const options=opts(f);
 const task=await runProjectTurn({...options,frozenConfig:applyThinkingSelection(options.frozenConfig,{level:thinking,scope:'all'}),input:'Check the measurement.'});
 assert.ok(f.calls.find(call=>call.body.model==='r1'&&call.body.tools?.some(tool=>tool.function.name==='feedback')),
   'authorized supervisor must advertise direct-report feedback');
 assert.equal(task.record.status,'completed',task.record.error);
 const stages=task.record.stages.filter(stage=>stage.assignment?.workId==='measure');
 assert.equal(stages.length,2);
 assert.equal(stages[0].sessionId,stages[1].sessionId);
 assert.equal(stages[0].assignment.leaderId,stages[1].assignment.leaderId);
 assert.equal(stages[1].assignment.feedback,'Include the units');
 assert.equal(task.requests().find(call=>call.id===task.record.finalCallId).text,'Corrected value 2 m');
 assert.ok(task.record.stages.some(stage=>stage.assignment?.canDelegate));
 assert.ok(task.requests().some(request=>request.phase==='process-check'));
 assert.ok(f.calls.length>4);
 for(const request of task.requests().filter(request=>request.sent)){
   assert.equal(request.requestedModel.thinkingLevel,thinking);
   assert.equal(request.payload.reasoning_effort,thinking);
 }
 assert.ok(f.calls.every(call=>call.body.reasoning_effort===thinking));
});

for(const thinking of ['low','high','max'])test(`three-model strict review sends ${thinking} and rejects the contributor route`,async t=>{
 let mainCalls=0;
 const f=await fixture(t,({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r2')return {text:'Fixed candidate report'};
   if(body.model==='r3')return {text:'{"verdict":"pass","observation":"Matches the fixed report criteria"}'};
   const tools=body.messages.filter(message=>message.role==='tool');
   mainCalls++;
   if(mainCalls===1)return {toolCalls:[{name:'delegate',args:{
     workId:'candidate',model:'fixture/r2',assignment:'Produce a report',reason:'Author',
   }}]};
   if(mainCalls===2)return {toolCalls:[{name:'collect',args:{assignmentId:JSON.parse(tools[0].content).assignmentId}}]};
   if(mainCalls===3||mainCalls===4){
     const {assignmentId,reportDigest}=JSON.parse(tools[1].content);
     return {toolCalls:[{name:'delegate',args:{workId:'strict-review',model:'fixture/'+(mainCalls===3?'r2':'r3'),
       assignment:'Review the exact report',reason:'Independent review',reviewOf:{assignmentId,reportDigest,criteria:'Check the evidence'},
     }}]};
   }
   if(mainCalls===5)return {toolCalls:[{name:'collect',args:{assignmentId:JSON.parse(tools.at(-1).content).assignmentId}}]};
   return {text:'Review result saved for the manager'};
 });
 const path=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
 for(const model of catalog.providers.fixture.models)model.reasoning=true;
 writeFileSync(path,JSON.stringify(catalog));
 f.models.secondary=f.models.secondary.filter(ref=>ref.modelId!=='r1');
 const options=opts(f);
 const task=await runProjectTurn({...options,frozenConfig:applyThinkingSelection(options.frozenConfig,{level:thinking,scope:'all'}),input:'Compare the evidence.'});
 const roleCalls=f.calls.filter(call=>call.body.model==='r2'&&!JSON.stringify(call.body.messages).includes('cothink-process-observation'));
 assert.equal(roleCalls.length,1,'same contributor route must not receive a review request');
 const reviewerCall=f.calls.find(call=>call.body.model==='r3');
 assert.ok(reviewerCall,JSON.stringify({error:task.record.error,tools:f.calls.map(c=>c.body.messages.filter(m=>m.role==='tool').at(-1)?.content)}));
 const reviewer=reviewerCall.body;
 assert.match(JSON.stringify(reviewer.messages),/Fixed candidate report/);
 assert.doesNotMatch(JSON.stringify(reviewer.tools),/delegate|collect|feedback/);
 const review=task.record.stages.find(stage=>stage.assignment?.review);
 assert.equal(review.assignment.reviewReceipt.verdict,'pass');
 assert.equal(review.assignment.reviewReceipt.certified,false,'opaque loopback provider cannot certify independence');
 assert.equal(task.record.status,'partial');
 assert.match(task.record.error,/Independent review/);
 assert.ok(f.calls.every(call=>call.body.reasoning_effort===thinking));
 assert.ok(task.requests().filter(request=>request.sent).every(request=>request.requestedModel.thinkingLevel===thinking&&request.payload.reasoning_effort===thinking));
 mkdirSync('work/unified-thinking-three-levels',{recursive:true});
 writeFileSync(join('work/unified-thinking-three-levels',`review-3-${thinking}-roles.json`),JSON.stringify({thinking,
  requests:task.requests().filter(row=>row.sent).map(row=>({phase:row.phase,role:row.role,model:row.requestedModel?.modelId,level:row.requestedModel?.thinkingLevel,effort:row.payload?.reasoning_effort})),
  wire:f.calls.map((call,index)=>({index:index+1,model:call.body.model,effort:call.body.reasoning_effort})),
 },null,2));
});

test('a supervisor pauses its direct report at the dispatch boundary and preserves the original request',async t=>{
 let started;
 const workerStarted=new Promise(resolve=>{started=resolve;});
 let paused;
 const f=await fixture(t,async ({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   const tools=body.messages.filter(message=>message.role==='tool');
   if(body.model==='r2'){started();return null;}
   if(body.model==='r1'){
     if(!tools.length)return {toolCalls:[{name:'delegate',args:{
       workId:'worker-pause',model:'fixture/r2',assignment:'Inspect evidence',reason:'Independent evidence',
     }}]};
     if(tools.length===1){
       await workerStarted;
       return {toolCalls:[{name:'pause_member',args:{assignmentId:JSON.parse(tools[0].content).assignmentId,reason:'Evidence scope needs confirmation'}}]};
     }
     paused=JSON.parse(tools[1].content);
     return {text:'Paused my report'};
   }
   if(!tools.length)return {toolCalls:[{name:'delegate',args:{
     workId:'supervisor-pause',model:'fixture/r1',assignment:'Manage evidence',reason:'Needs supervisor',canDelegate:true,
   }}]};
   if(tools.length===1)return {toolCalls:[{name:'collect',args:{assignmentId:JSON.parse(tools[0].content).assignmentId}}]};
   return {text:'Supervisor reported the pause'};
 });
 const task=await runProjectTurn({...opts(f),input:'Check the evidence.'});
 assert.equal(task.record.status,'outcome_unknown',task.record.error);
 const role=task.record.stages.find(stage=>stage.assignment?.workId==='worker-pause');
 assert.equal(paused.assignmentId,role.id);
 assert.equal(role.assignment.pause.status,'unknown');
 assert.deepEqual(role.assignment.pause.requestIds,role.callIds);
 assert.equal(f.calls.filter(call=>call.body.model==='r2').length,1);
});

test('strict approval of an earlier report cannot certify its corrected successor',async t=>{
 const manager='gpt-4o',author='claude-sonnet-4-5',reviewer='deepseek-v4.1-flash-1017';
 const originById={[manager]:'https://api.openai.com',[author]:'https://api.anthropic.com',[reviewer]:'https://api.deepseek.com'};
 const providerFor=id=>'review-'+id;
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 let managerCalls=0,first;
 const f=await fixture(t,({body})=>{
   const messages=JSON.stringify(body.messages);
   if(messages.includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model===author)return {text:messages.includes('Fix the unit')?'Corrected report uses metres':'Original report uses feet'};
   if(body.model===reviewer)return {text:'{"verdict":"pass","observation":"Reviewed the original report"}'};
   const tools=body.messages.filter(message=>message.role==='tool');
   const last=()=>JSON.parse(tools.at(-1).content);
   switch(++managerCalls){
     case 1:return tool('delegate',{workId:'candidate',model:providerFor(author)+'/'+author,assignment:'Prepare report',reason:'Author'});
     case 2:return tool('collect',{assignmentId:last().assignmentId});
     case 3:
       first=last();
       return tool('delegate',{workId:'independent',model:providerFor(reviewer)+'/'+reviewer,assignment:'Review the report',
         reason:'Independent check',reviewOf:{assignmentId:first.assignmentId,reportDigest:first.reportDigest,criteria:'Verify units'}});
     case 4:return tool('collect',{assignmentId:last().assignmentId});
     case 5:return tool('feedback',{assignmentId:first.assignmentId,feedback:'Fix the unit'});
     case 6:return tool('collect',{assignmentId:last().assignmentId});
     default:return {text:'The corrected report is ready'};
   }
 });
 const {readFileSync,writeFileSync}=await import('node:fs');
 const catalogPath=join(f.home,'pi','models.json');
 const template=JSON.parse(readFileSync(catalogPath,'utf8')).providers.fixture;
 writeFileSync(catalogPath,JSON.stringify({providers:Object.fromEntries([manager,author,reviewer].map(id=>[
   providerFor(id),{...template,baseUrl:originById[id]+'/v1',models:[{...template.models[0],id,name:id}]},
 ]))}));
 const fetch=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{
   const requested=new URL(typeof url==='string'||url instanceof URL?url:url.url);
   assert.ok(Object.values(originById).includes(requested.origin),'fixture rejects every unrelated origin');
   const response=await fetch(new URL(requested.pathname,f.endpoint),init);
   Object.defineProperty(response,'url',{value:requested.href});
   return response;
 };
 t.after(()=>{globalThis.fetch=fetch;});
 const frozenConfig={formatVersion:2,main:{provider:providerFor(manager),modelId:manager},
   secondary:[author,reviewer].map(id=>({provider:providerFor(id),modelId:id}))};
 const task=await runProjectTurn({...opts(f),frozenConfig,input:'Review the measurement report.'});
 const oldReview=task.record.stages.find(stage=>stage.assignment?.review)?.assignment.reviewReceipt;
 assert.equal(oldReview?.certified,true,task.record.error);
 assert.equal(oldReview.verdict,'pass');
 assert.ok(task.record.stages.some(stage=>stage.assignment?.feedback==='Fix the unit'&&stage.assignment.status==='completed'));
 assert.equal(task.record.status,'partial',task.record.error);
 assert.match(task.record.error,/latest report/);
});

test('a four-level read-only chain rejects a fifth level and returns through direct supervisors',async t=>{
 const tool=(name,args)=>({toolCalls:[{name,args}]});
 const delegate=(workId,model,canDelegate,options={})=>tool('delegate',{
   workId,model:'fixture/'+model,assignment:'Verify '+workId,reason:'Narrow the evidence',canDelegate,...options,
 });
 let denied=false,nonDirectDenied=false,leafTools,leafId;
 const f=await fixture(t,({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   const tools=body.messages.filter(message=>message.role==='tool');
   const last=()=>JSON.parse(tools.at(-1).content);
   const collect=()=>tool('collect',{assignmentId:last().assignmentId});
   const summarize=()=>({text:last().report});
   if(body.model==='main'){
     if(!tools.length)return delegate('level-2','r1',true,{maxDepth:4});
     if(tools.length===1)return collect();
     if(tools.length===2)return tool('collect',{assignmentId:leafId});
     nonDirectDenied=/Only the direct supervisor/.test(tools[2].content);
     return {text:JSON.parse(tools[1].content).report};
   }
   if(body.model==='r1'){
     if(!tools.length)return delegate('level-3','r2',true);
     return tools.length===1?collect():summarize();
   }
   if(body.model==='r2'){
     if(!tools.length)return delegate('level-4','r3',true);
     if(tools.length===1){
       denied=/staffing depth/.test(tools[0].content);
       return delegate('level-4','r3',false);
     }
     if(tools.length===2){
       leafId=last().assignmentId;
       return collect();
     }
     return summarize();
   }
   leafTools=body.tools?.map(tool=>tool.function.name)??[];
   return {text:'The fourth-level evidence was verified.'};
 });
 const task=await runProjectTurn({...opts(f),input:'Verify the evidence through four levels.'});
 assert.equal(task.record.status,'completed',task.record.error);
 const stages=task.record.stages.filter(stage=>stage.assignment);
 assert.equal(task.record.staffMaxDepth,4);
 assert.deepEqual(stages.map(stage=>stage.assignment.depth),[2,3,4]);
 assert.deepEqual(stages.map(stage=>stage.assignment.leaderId),['main',stages[0].id,stages[1].id]);
 assert.equal(new Set(stages.map(stage=>stage.sessionId)).size,3);
 assert.equal(denied,true);
 assert.equal(nonDirectDenied,true);
 assert.equal(existsSync(join(f.home,'project-delivery')),false);
 assert.deepEqual(leafTools,['get_capabilities']);
 assert.equal(task.requests().find(call=>call.id===task.record.finalCallId).text,'The fourth-level evidence was verified.');
 assert.equal(f.calls.filter(call=>call.body.model==='r3').length,1);
});

for(const maxCalls of [12,3]) test(`readonly checker correction shares root budget ${maxCalls} and preserves original output`,async t=>{
 let checks=0;
 const f=await fixture(t,({body})=>{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))
     return {text:++checks===1?'{"issues":false}':'{"issues":[]}'};
   if(body.model==='r2')return {text:'Independent evidence verified'};
   const tools=body.messages.filter(message=>message.role==='tool');
   if(!tools.length)return {toolCalls:[{name:'delegate',args:{workId:'checked',model:'fixture/r2',assignment:'Investigate',reason:'Separate evidence'}}]};
   if(tools.length===1)return {toolCalls:[{name:'collect',args:{assignmentId:JSON.parse(tools[0].content).assignmentId}}]};
   return {text:'Combined evidence verified'};
 });
 const task=await runProjectTurn({...opts(f),input:'Investigate together.',budget:{maxCalls}});
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
