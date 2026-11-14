import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn,executeConfirmed} from '../src/project-turn.js';
import {inspectFileContinuation,affectedProjectSteps} from '../src/project-continuation.js';
import {reserveFileContinuation} from '../src/project-file-confirmation.js';
import {readTask,readRequests} from '../src/task.js';
import {writePrivateJson} from '../src/storage.js';
import {projectChatState,runProjectCommand} from '../src/project.js';
import {createVersioning} from '../src/versioning.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
async function continueFrom(base,source,checked,mode='user') {
  const reservation=await reserveFileContinuation({home:base.home,sessionId:source.sessionId,sourceRootTaskId:source.id,
    draft:checked.draft,submissionId:'continue-'+source.id,authorizationSource:{kind:'file_continuation',sourceTaskId:source.id,mode},
    expectedRevision:checked.revision,expectedFormalVersion:checked.formalVersion});
  const saved=readTask(base.home,source.id);
  return runProjectTurn({...base,input:saved.input,taskId:reservation.taskId,submissionId:reservation.submissionId,
    frozenConstraints:saved.constraints,budget:reservation.budgetSource.remaining,
    confirmedOperation:{source:saved,reservation,execute:task=>executeConfirmed(task,saved,reservation)}});
}

test('explicit descendant continuation preserves the paused route and corrects its original invalid judgment',async t=>{
 const mcpRequests=[];
 const server=createServer(async(req,res)=>{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const message=JSON.parse(Buffer.concat(chunks));mcpRequests.push({path:req.url,method:message.method});let result;
   if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'route-read',version:'1'}};
   else if(message.method==='tools/list')result={tools:[{name:'read',inputSchema:{type:'object'}}]};
   else if(message.method==='tools/call')result={content:[{type:'text',text:'authorized MCP read'}]};
   if(message.id===undefined){res.writeHead(202);res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const plan={mcp:['local','unused'].map(name=>({server:name,trust:'explicit-service-contract',tools:{read:{kind:'read',target:'bounded source evidence',allowedArguments:[{}]}}})),goal:'Deliver corrected A',scope:['a.txt'],readScope:['a.txt'],
   deliverables:['a.txt'],checks:[{command:'node',args:['-e',"const f=require('fs');if(f.readFileSync('a.txt','utf8')!=='fixed A\\n')process.exit(1)"]}]};
 let phase=0,index=0,oldJudgment;
 const old=[tool('start_work',{action:'start',reason:'two files',plan}),tool('read',{path:'a.txt'}),
   tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]})];
 const paused=[tool('prepare_change',{check:true}),
   tool('edit',{path:'a.txt',edits:[{oldText:'saved A',newText:'FORBIDDEN'}]})];
 const resumed=[tool('project_route_judge',{path:'a.txt',contains:'saved A',ifPresent:'repair',ifAbsent:'blocked',repairScope:['a.txt'],reason:'The retained saved A bytes distinguish correcting the failed check from starting over.'}),
   tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'saved A',newText:'fixed A'}]}),tool('prepare_change',{check:true}),
   tool('project_mcp_0_read',{workId:'main:a.txt',arguments:{outside:true}}),tool('project_mcp_0_read',{workId:'main:a.txt',arguments:{}}),
   tool('accept_change'),tool('accept_change'),{text:'Both files are checked and delivered.'}];
 const f=await fixture(t,({body},n,req,res)=>{
   if(phase===0){if(n===4){res.destroy();return null;}return old[n-1];}
   if(phase===1)return paused[index++]??{text:'Unexpected extra request'};
   if(index===0){
     assert.equal(mcpRequests.length,0,'paused descendant reaches its judge without any MCP connection');
     assert.deepEqual(body.tools.map(t=>t.function.name),['project_route_judge'],'resuming a paused boundary is judge-only');
     const context=JSON.stringify(body.messages);
     assert.ok(context.includes(oldJudgment),'the previous invalid completed judgment is supplied as concrete feedback');
     assert.match(context,/FORBIDDEN/);
   }
   if(index===5){assert.equal(mcpRequests.length,0,'invalid exact arguments do not even start a deferred client');assert.match(JSON.stringify(body.messages.at(-1)),/confirmed target.parameter scope/);}
   if(index===6)assert.match(JSON.stringify(body.messages.at(-1)),/authorized MCP read/);
   return resumed[index++]??{text:'Delivered'};
 });
 mkdirSync(join(f.home,'pi'),{recursive:true});writeFileSync(join(f.home,'pi','mcp.json'),JSON.stringify({mcpServers:Object.fromEntries(['local','unused'].map(name=>[name,{url:`http://127.0.0.1:${server.address().port}/${name}`}]))}));
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposal=await runProjectTurn({...base,input:'Correct a.txt and deliver it.',budget:{maxCalls:30},frozenConstraints:{allowFileContinuation:true}});
 const original=await confirmProject(base,proposal,{frozenConstraints:{allowFileContinuation:true}});
 assert.equal(original.record.status,'outcome_unknown',original.record.error);
 let inspected=await inspectFileContinuation({home:f.home,sourceRootTaskId:original.record.id});
 assert.equal(inspected.eligible,true,JSON.stringify(inspected.blockers));
 const unknownId=inspected.requestIds[0],originalChild=readTask(f.home,inspected.draft.taskId);
 phase=1;index=0;
 const partial=await continueFrom(base,original.record,inspected);
 assert.equal(partial.record.status,'partial',partial.record.error);
 assert.equal(readRequests(f.home,partial.record).filter(r=>r.sent&&r.status==='outcome_unknown').length,0);
 const before=(await projectChatState(f.home,repo.project)).state,route=before.steps[0].route;
 assert.equal(route.status,'paused');oldJudgment=route.judgmentCall;assert.ok(oldJudgment);
 const oldChild=readTask(f.home,partial.record.projectOperation.childTaskIds[0]);
 assert.equal(readRequests(f.home,oldChild).find(r=>r.id===oldJudgment).status,'completed');
 inspected=await inspectFileContinuation({home:f.home,sourceRootTaskId:partial.record.id});
 assert.equal(inspected.eligible,true,JSON.stringify(inspected.blockers));assert.deepEqual(inspected.requestIds,[unknownId]);
 assert.equal(inspected.remainingBudget.maxCalls,30-f.calls.length,'all ancestral sent calls, including the unknown response, still consume the original cap');
 const count=f.calls.length;
 const ancestor=readTask(f.home,original.record.id),tampered=structuredClone(ancestor);
 tampered.fileContinuationIntent.commandId='unrelated-command';
 writePrivateJson(join(f.home,'tasks',ancestor.id+'.json'),tampered);
 assert.ok((await inspectFileContinuation({home:f.home,sourceRootTaskId:partial.record.id})).blockers.some(b=>b.code==='CONTINUATION_SOURCE'));
 writePrivateJson(join(f.home,'tasks',ancestor.id+'.json'),ancestor);
 const unknown=readRequests(f.home,originalChild).find(r=>r.id===unknownId);
 writePrivateJson(join(f.home,'requests',unknownId+'.json'),{...unknown,status:'completed'});
 assert.ok((await inspectFileContinuation({home:f.home,sourceRootTaskId:partial.record.id})).blockers.some(b=>b.code==='PROPOSAL_STALE'));
 writePrivateJson(join(f.home,'requests',unknownId+'.json'),unknown);
 assert.equal(f.calls.length,count,'broken lineage and new receipts cannot generate requests');
 await assert.rejects(continueFrom(base,partial.record,inspected,'preauthorized_once'),{code:'CONTINUATION_AUTH'});
 await assert.rejects(runProjectCommand({home:f.home,cwd:repo.project,args:['resume']}),/owning GUI root/);
 assert.equal(f.calls.length,count,'neither renewed preauthorization nor generic resume can send');
 phase=2;index=0;mcpRequests.length=0;
 const completed=await continueFrom(base,partial.record,inspected);
 assert.equal(completed.record.status,'completed',completed.record.error);
 assert.equal(mcpRequests.filter(r=>r.method==='tools/call').length,1);assert.ok(mcpRequests.every(r=>r.path==='/local'));
 const newChild=readTask(f.home,completed.record.projectOperation.childTaskIds[0]);
 const clients=newChild.tools.filter(t=>t.kind==='project_mcp_runtime');assert.equal(clients.length,1);assert.equal(clients[0].serverName,'local');assert.equal(clients[0].status,'closed');
 const after=(await projectChatState(f.home,repo.project)).state;
 assert.equal(after.steps[0].route.status,'resolved');
 assert.ok(after.steps[0].routeHistory.some(r=>r.status==='paused'&&r.judgmentCall===oldJudgment&&r.taskId===oldChild.id));
 assert.equal(after.steps[0].route.restoredFrom.judgmentCall,oldJudgment);
 assert.notEqual(after.steps[0].route.judgmentCall,oldJudgment);
 assert.equal(readRequests(f.home,originalChild).find(r=>r.id===unknownId).status,'outcome_unknown');
 assert.equal(after.steps[0].attempts[0].status,'unknown');
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try {for(const [path,expected] of [['a.txt','fixed A\n']])assert.equal(Buffer.from((await v.read({version:after.version,path})).contentBase64,'base64').toString(),expected);}
 finally{await v.close();}
});

import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

test('a known partial file task without a confirmed unknown ancestor cannot obtain a continuation',async t=>{
 const plan={goal:'Save A',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}]};
 const script=[tool('start_work',{action:'start',reason:'write one file',plan}),tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]}),{text:'Draft only; not accepted.'}];
 const f=await fixture(t,(_,n)=>script[n-1]??{text:'Draft only'}),repo=repository(t),base=await projectSession(t,repo,f);
 const proposal=await runProjectTurn({...base,input:plan.goal}),source=await confirmProject(base,proposal);
 assert.equal(source.record.status,'partial',source.record.error);
 const before=f.calls.length,checked=await inspectFileContinuation({home:f.home,sourceRootTaskId:source.record.id});
 assert.ok(checked.draft);assert.equal(checked.eligible,false);assert.ok(checked.blockers.some(b=>b.code==='NO_UNKNOWN_MODEL'));
 await assert.rejects(continueFrom(base,source.record,checked),{code:'CONTINUATION_BLOCKED'});assert.equal(f.calls.length,before);
});

import {hostToolsOnlyPayload} from '../src/request-policy.js';
test('Responses additional_tools cannot hide unresolved server execution behind host-only continuation',()=>{
 const model={api:'openai-responses'};
 const input=tools=>[{type:'additional_tools',role:'developer',tools}];
 assert.equal(hostToolsOnlyPayload(model,{input:input([{type:'function',name:'read'}])}),true);
 for(const tools of [[{type:'web_search'}],[{type:'mcp'}],[null],null,{}])
   assert.equal(hostToolsOnlyPayload(model,{input:input(tools)}),false);
 assert.equal(hostToolsOnlyPayload(model,{input:[...input([{type:'function',name:'read'}]),...input([{type:'mcp'}])]}),false);
 for(const field of ['tools','additional_tools'])for(const tool of [{type:'web_search'},{type:'mcp'},null])
   assert.equal(hostToolsOnlyPayload(model,{[field]:[tool]}),false);
});


test('manual continuation preserves one unused repair and applies its two files atomically',async t=>{
 const plan={goal:'Deliver A and new N while maintaining the existing B input',scope:['a.txt','b.txt','new.txt'],readScope:['a.txt','b.txt','new.txt'],deliverables:['a.txt','new.txt'],
  checks:[{command:'node',args:['-e',"const f=require('fs');if(f.readFileSync('a.txt','utf8')!=='saved A\\n'||f.readFileSync('b.txt','utf8')!=='fixed B'||f.readFileSync('new.txt','utf8')!=='new N')process.exit(1)"]}]};
 let resumed=false,index=0,firstWire;
 const initial=[tool('start_work',{action:'start',reason:'deliver three files',plan}),tool('read',{path:'a.txt'}),
  tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'saved A'}]}),tool('prepare_change',{check:true}),
  tool('project_route_judge',{path:'b.txt',contains:'base B',ifPresent:'repair',ifAbsent:'blocked',repairScope:['b.txt','new.txt'],reason:'The saved A implementation requires corrected B and the missing companion.'})];
 const next=[tool('prepare_change',{check:true}),
  tool('read',{path:'b.txt'}),tool('write',{files:[{path:'b.txt',content:'fixed B'},{path:'new.txt',content:'new N'}]}),
  tool('prepare_change',{check:true}),tool('accept_change'),tool('accept_change'),{text:'All three exact files were checked and delivered.'}];
 const f=await fixture(t,({body},n,req,res)=>{
  if(!resumed){if(n>initial.length){res.destroy();return null;}return initial[n-1];}
  if(resumed==='hold')return {text:'Preserve the unused repair without modifying files.'};
  firstWire??=body;return next[index++]??{text:'Delivered.'};
 });
 const repo=repository(t),base=await projectSession(t,repo,f);
 const proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:30}}),original=await confirmProject(base,proposal);
 assert.equal(original.record.status,'outcome_unknown',original.record.error);
 const state=(await projectChatState(f.home,repo.project)).state,step=state.steps[0],route=step.route;
 assert.equal(route.status,'repair');assert.ok(route.probe.completedAt);assert.equal(route.edit,undefined);
 // Replay a legacy repeated observation of the actual unchanged failed receipt.
 route.recheck={candidate:route.candidate,evidence:structuredClone(route.evidence)};route.status='blocked';
 writePrivateJson(join(f.home,'project-delivery',state.id,'state.json'),state);
 const child=readTask(f.home,route.taskId),unknown=readRequests(f.home,child).find(r=>r.status==='outcome_unknown');
 const oldTask=readFileSync(join(f.home,'tasks',child.id+'.json')),oldRequest=readFileSync(join(f.home,'requests',unknown.id+'.json'));
 const inspected=await inspectFileContinuation({home:f.home,sourceRootTaskId:original.record.id});
 assert.equal(inspected.eligible,true,JSON.stringify(inspected.blockers));assert.equal(inspected.requiresManual,true);
 const statePath=join(f.home,'project-delivery',state.id,'state.json');
 for(const patch of [{edit:{requestId:'already-used'}},{feedback:{dispatchId:'already-resumed'}},{probe:{...route.probe,contentHash:'bad'}}]){
  const bad=structuredClone(state);Object.assign(bad.steps[0].route,patch);writePrivateJson(statePath,bad);
  const blocked=await inspectFileContinuation({home:f.home,sourceRootTaskId:original.record.id});assert.equal(blocked.eligible,false);
 }
 writePrivateJson(statePath,state);
 await assert.rejects(continueFrom(base,original.record,inspected,'preauthorized_once'),{code:'CONTINUATION_AUTH'});
 resumed='hold';const held=await continueFrom(base,original.record,inspected);assert.equal(held.record.status,'partial');
 const heldFacts=await inspectFileContinuation({home:f.home,sourceRootTaskId:held.record.id});assert.equal(heldFacts.eligible,true,JSON.stringify(heldFacts.blockers));
 resumed=true;const completed=await continueFrom(base,held.record,heldFacts);
 assert.equal(completed.record.status,'completed',completed.record.error);
 const wireText=firstWire.messages.flatMap(m=>typeof m.content==='string'?[m.content]:(m.content??[]).filter(p=>p.type==='text').map(p=>p.text)).join('\n');
 assert.ok(wireText.includes('write scope='+JSON.stringify(plan.scope)),JSON.stringify({scopeText:wireText.match(/write scope=[^\n]{0,180}/g),repairScope:wireText.match(/repairScope[^\n]{0,180}/g)}));
 const advertised=firstWire.tools.map(t=>t.function.name);assert.ok(advertised.includes('write')&&!advertised.includes('refresh_change')&&!advertised.includes('prepare_change')&&!advertised.includes('accept_change'));assert.ok(!advertised.includes('bash')&&!advertised.includes('delegate')&&!advertised.includes('project_route_judge'));
 const after=(await projectChatState(f.home,repo.project)).state,active=after.steps[0].route;
 assert.equal(active.probe.id,route.probe.id,'the old experiment is retained, not repeated');
 assert.ok(after.steps[0].subworks.some(w=>JSON.stringify(w.scope)===JSON.stringify(['b.txt'])),'the approved existing input has a registered work boundary');
 assert.deepEqual(active.edit.paths,['b.txt','new.txt']);assert.equal(active.status,'resolved');
 assert.ok(after.steps[0].routeHistory.some(r=>r.status==='blocked'&&!r.edit&&r.recheck));
 const latest=readTask(f.home,active.edit.taskId);
 assert.ok(latest.work.requests.some(r=>r.action==='prepareChange'&&r.dispatched===false&&r.status==='rejected'),'verification cannot consume an unused repair');
 const writes=latest.tools.filter(t=>t.kernelInput?.edits);
 assert.equal(writes.length,1);assert.deepEqual(writes[0].kernelInput.edits.map(e=>e.path),['b.txt','new.txt']);
 assert.deepEqual(readFileSync(join(f.home,'tasks',child.id+'.json')),oldTask);assert.deepEqual(readFileSync(join(f.home,'requests',unknown.id+'.json')),oldRequest);
 const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try{for(const [path,text]of [['a.txt','saved A\n'],['b.txt','fixed B'],['new.txt','new N']])assert.equal(Buffer.from((await v.read({version:after.version,path})).contentBase64,'base64').toString(),text);}finally{await v.close();}
});
