import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {fixtureConversation,prepareSubmit,seedFixtureConversationRepository,teamId} from './helpers/gui-controller-fixture.js';

test('confirmed PROJECT settings distinguish coordinator from the active owned model capabilities',{timeout:30000},async t=>{
 const {repository}=await import('./helpers/git-fixture.js'),{execution}=await import('./helpers/agent-sync-fixture.js'),{saveConfig}=await import('../src/config.js'),{createTeamConfig}=await import('../src/teams.js'),{createGuiController}=await import('../src/gui-controller.js');
 const repo=repository(t),plan={goal:'Change a.txt',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('changed A'))process.exit(1)"]}]};
 let release,reached,modelCapabilities,initialCapabilities;const ready=new Promise(r=>reached=r),barrier=new Promise(r=>release=r);
 const f=await fixture(t,async({body},n)=>{
  if(n===1)return {toolCalls:[{name:'start_work',args:{action:'start',reason:'edit',plan}}]};
  if(n===2)return {toolCalls:[{name:'get_capabilities',args:{}}]};
  if(n===3){initialCapabilities=JSON.parse(body.messages.findLast(m=>m.role==='tool').content);return {toolCalls:[{name:'read',args:{path:'a.txt'}}]};}
  if(n===4)return {toolCalls:[{name:'edit',args:{path:'a.txt',edits:[{oldText:'base A',newText:'changed A'}]}}]};
  if(n===5)return {toolCalls:[{name:'get_capabilities',args:{}}]};
  if(n===6){modelCapabilities=JSON.parse(body.messages.findLast(m=>m.role==='tool').content);reached();await barrier;return {toolCalls:[{name:'accept_change',args:{}}]};}return {text:'Changed A'};
 });
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,work:{execution}},'Fixture',teamId));
 const c=await createGuiController({home:f.home,cwd:repo.project});t.after(()=>c.close());const session=seedFixtureConversationRepository(repo.project,await fixtureConversation(t,c));
 const settle=async id=>{for(let n=0;n<300;n++){const task=await c.task(id);if(task.status!=='running')return task;await new Promise(r=>setTimeout(r,10));}throw Error('Task did not settle');};
 const proposal=await c.action('task.submit',await prepareSubmit(c,{sessionId:session.id,submissionId:'proposal-capabilities',input:'Change a.txt'})),source=await settle(proposal.taskId);assert.equal(source.status,'blocked',source.error);
 const confirmed=await c.action('task.confirmWork',{sessionId:session.id,submissionId:'confirm-capabilities',protocolVersion:1,proposalRef:source.proposalRef});
 let assertionFailure;try {await ready;const shown=await c.getSessionCapabilities(session.id),root=await c.task(confirmed.taskId);
  assert.equal(shown.scope,'coordinator');assert.deepEqual(shown.tools,[]);assert.equal(shown.permissions.fileWrite,false);assert.equal(shown.permissions.scriptExecution,false);
  assert.equal(shown.executors.length,1);assert.deepEqual(shown.executors[0],modelCapabilities);
  assert.equal(shown.executors[0].source.role,'main');assert.ok(root.projectOperation.childTaskIds.includes(shown.executors[0].source.taskId));assert.notEqual(shown.executors[0].source.taskId,source.id);
  assert.equal(modelCapabilities.permissions.fileWrite,true);assert.equal(modelCapabilities.permissions.scriptExecution,true);assert.ok(modelCapabilities.tools.includes('resource_exec'));
  assert.equal(modelCapabilities.permissions.fileReadAuthorized,true,'formal actor reads under its work binding, not the earlier GUI planning grant');assert.equal(modelCapabilities.permissions.readOnly,false);
  assert.equal(modelCapabilities.environment.managedExecutionConfigured,true);
  assert.equal(initialCapabilities.permissions.fileReadAuthorized,true);assert.equal(initialCapabilities.permissions.readOnly,true);assert.equal(initialCapabilities.permissions.fileWrite,false);assert.equal(initialCapabilities.permissions.visualPreview,false);assert.equal(initialCapabilities.permissions.scriptExecution,false,'initial observation has no writable grant even if effect tools can later request one');
  for(const hidden of [f.home,session.project,'fixture-secret','sourceDirectory','sourcePath'])assert.ok(!JSON.stringify(shown).includes(hidden),hidden);
 }catch(error){assertionFailure=error;}finally{release();}
 try {const final=await settle(confirmed.taskId);assert.equal(final.status,'completed',final.error);assert.equal(f.calls.length,7);
  assert.equal((await c.getSessionCapabilities(session.id)).executors,undefined,'completed execution is not a current capability source');if(assertionFailure)throw assertionFailure;
 }finally{await c.close();}
});
test('persisted inherited delivery IDs do not become active executor capability sources',async t=>{
 const {createTask}=await import('../src/task.js'),{createRootOwner,normalizeConstraints,normalizeRootBudget}=await import('../src/project-turn.js');
 const f=await fixture(t),root=createTask({home:f.home,input:'observe',models:f.models,flow:'unified',constraints:normalizeConstraints(),budget:normalizeRootBudget()});
 const owner=createRootOwner(root);root.record.projectOperation={commandId:'current-operation',childTaskIds:['inherited-task']};root.record.deliveryRef={sources:[{taskId:'inherited-task',relation:'inherited'}]};
 assert.deepEqual(owner.executorCapabilities(),[]);
 assert.throws(()=>owner.registerTask({record:{id:'inherited-task',rootTaskId:'previous-root',project:{commandId:'previous-operation'}},runtimes:new Set()}),{code:'ROOT_CHILD'});
 assert.deepEqual(owner.executorCapabilities(),[]);assert.equal(f.calls.length,0);
});
test('capability flags follow the live work binding and preparation or review stage',async t=>{
 const {managed}=await import('./helpers/agent-sync-fixture.js'),{createRuntime}=await import('../src/pi-runtime.js');
 const f=await fixture(t),work=await managed(t,{scope:['a.txt'],readScope:['a.txt']});
 const runtime=await createRuntime({home:f.home,cwd:work.project,modelRef:f.models.main,useFrozenSkills:true,toolDefinitions:work.definitions,getWorkspaceAuthority:()=>work.binding.current});
 try {
  runtime.bindTask(work.task,work.task.beginPhase('worker-prepare','member:test',f.models.main));
  const preparation=runtime.capabilities();assert.equal(preparation.permissions.readOnly,true);assert.equal(preparation.permissions.fileReadAuthorized,true);assert.equal(preparation.permissions.fileWrite,false);
  runtime.bindTask(work.task,work.task.beginPhase('worker','member:test',f.models.main));assert.equal(runtime.capabilities().permissions.fileWrite,true);
  runtime.bindTask(work.task,work.task.beginPhase('review','reviewer',f.models.main));assert.equal(runtime.capabilities().permissions.readOnly,true);assert.equal(runtime.capabilities().permissions.fileWrite,false);
  await work.v.abandonChange(work.binding.current.changeId,{requestId:'close-write'});
  work.binding.current=await work.v.beginChange({actor:'main',requestId:'readonly',intent:'observe',scope:[],readScope:['a.txt'],readOnly:true});
  runtime.bindTask(work.task,work.task.beginPhase('worker','member:test',f.models.main));
  const readonly=runtime.capabilities();assert.equal(readonly.permissions.readOnly,true);assert.equal(readonly.permissions.fileReadAuthorized,true);assert.equal(readonly.permissions.fileWrite,false);assert.equal(readonly.permissions.scriptExecution,false);
  await assert.rejects(work.call('write','refused-write',{path:'a.txt',content:'forbidden'}));assert.equal(readFileSync(join(work.project,'a.txt'),'utf8'),'base A\n');assert.equal(f.calls.length,0);
 }finally{await runtime.dispose();}
});
test('retained PROJECT member loses current capabilities at result and acceptance and regains them for feedback',{timeout:45000},async t=>{
 const {readTask}=await import('../src/task.js');
 const {repository}=await import('./helpers/git-fixture.js'),{execution}=await import('./helpers/agent-sync-fixture.js'),{saveConfig}=await import('../src/config.js'),{createTeamConfig}=await import('../src/teams.js'),{createGuiController}=await import('../src/gui-controller.js'),{projectChatState}=await import('../src/project.js'),{createProjectStaff}=await import('../src/project-staff.js');
 const repo=repository(t),plan={goal:'Deliver final A',scope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('a.txt','utf8').includes('final A'))process.exit(1)"]}]};
 let c,session,member,childId,failure,initialStage,memberSession;const turns={main:0,r1:0},observations=[];
 const tool=(name,args={})=>({toolCalls:[{name,args}]}),last=body=>JSON.parse(body.messages.findLast(m=>m.role==='tool').content);
 async function observe(label,active,model){
  const shown=await c.getSessionCapabilities(session.id),state=(await projectChatState(f.home,session.project)).state;
  const assignment=Object.values(state.staffAssignments).find(a=>a.dispatchId===member);childId=assignment.taskId;
  const staff=createProjectStaff({read:()=>state,update(){throw Error('read-only probe');}}),check=()=>staff.checkWork({taskId:childId,role:'member:'+member});
  const current=shown.executors.filter(x=>x.source.role==='member:'+member);
  if(active){assert.doesNotThrow(check);assert.equal(current.length,1);assert.deepEqual(current[0],model);assert.equal(model.permissions.fileReadAuthorized,true);assert.equal(model.permissions.fileWrite,true);}
  else {assert.throws(check,{code:'PROJECT_STAFF'});assert.deepEqual(current,[],'retained inactive member must not be listed as a current executor');}
  observations.push({label,assignment:assignment.status,projected:current.length,stage:model?.source.stageId});
 }
 const f=await fixture(t,async({body})=>{try {
  if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
  const n=++turns[body.model];
  if(body.model==='r1'){
   if(n===1)return {text:'I understand the original task and authorized file scope.'};
   if(n===2)return tool('read',{path:'a.txt'});
   if(n===3)return tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'candidate A'}]});
   if(n===4||n===6)return tool('get_capabilities');
   if(n===5){const model=last(body);await observe('active',true,model);initialStage=model.source.stageId;return {text:'Candidate A ready for review'};}
   if(n===7){const model=last(body);await observe('feedback-active',true,model);assert.notEqual(model.source.stageId,initialStage);return tool('edit',{path:'a.txt',edits:[{oldText:'candidate A',newText:'final A'}]});}
   return {text:'Final A ready for acceptance'};
  }
  if(n===1)return tool('start_work',{action:'start',reason:'implement',plan});
  if(n===2)return tool('project_staff',{action:'appoint',input:{id:'writer',responsibility:'Deliver a.txt',scope:['a.txt'],models:['fixture/r1'],need:'deliverable',reason:'Own the requested file'}});
  if(n===3)return tool('delegate',{staffId:'writer',model:'fixture/r1',scope:['a.txt'],readScope:['a.txt'],assignment:'Deliver the requested a.txt change',reason:'Assigned file author'});
  if(n===4){member=last(body).memberId;return tool('collect',{memberId:member});}
  if(n===5){await observe('result',false);const child=readTask(f.home,childId);memberSession=child.members.find(m=>m.memberId===member).sessionFile;assert.equal(typeof memberSession,'string');return tool('feedback',{memberId:member,feedback:'Replace candidate A with final A in the same reviewed draft.'});}
  if(n===6)return tool('collect',{memberId:member});
  if(n===7){await observe('feedback-result',false);const child=readTask(f.home,childId);assert.equal(child.members.find(m=>m.memberId===member).sessionFile,memberSession);return tool('accept_change',{memberId:member});}
  const child=readTask(f.home,childId);if(child.members.find(m=>m.memberId===member).status!=='accepted'&&n<10)return tool('accept_change',{memberId:member});
  await observe('accepted',false);return {text:'Delivered final A'};
 }catch(error){failure??=error;return {text:'Fixture observation failed: '+error.message};}});
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models,work:{execution}},'Fixture',teamId));c=await createGuiController({home:f.home,cwd:repo.project});
 const settle=async id=>{for(let n=0;n<1000;n++){const value=await c.task(id);if(value.status!=='running')return value;await new Promise(r=>setTimeout(r,10));}throw Error('Lifecycle task did not settle');};
 try {session=seedFixtureConversationRepository(repo.project,await fixtureConversation(t,c));const submitted=await c.action('task.submit',await prepareSubmit(c,{sessionId:session.id,input:'组队完成 a.txt 修改',submissionId:'lifecycle'})),source=await settle(submitted.taskId);
  const confirmed=await c.action('task.confirmWork',{sessionId:session.id,submissionId:'lifecycle-confirm',protocolVersion:1,proposalRef:source.proposalRef}),final=await settle(confirmed.taskId);
  if(failure)throw failure;assert.equal(final.status,'completed',final.error);const fulfilled=readTask(f.home,confirmed.taskId).collaborationResult[0];assert.equal(fulfilled.status,'fulfilled');assert.equal(fulfilled.requirement.workers,1);assert.equal(fulfilled.evidence.length,1);assert.deepEqual(observations.map(x=>x.label),['active','result','feedback-active','feedback-result','accepted']);
  assert.equal(observations.at(-1).assignment,'disposed');t.diagnostic(JSON.stringify({observations,requests:f.calls.length}));
 }finally{await c.close();}
});

test('planning MCP discovery lists only the selected HTTP service without invoking tools or command servers',async t=>{
 const {createServer}=await import('node:http'),{writeFileSync}=await import('node:fs'),{runProjectTurn}=await import('../src/project-turn.js'),{opts}=await import('./unified-turn.fixture.js');
 const methods=[],seen=[];
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const message=JSON.parse(Buffer.concat(chunks));methods.push(message.method);
  if(req.url==='/unavailable'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'fixture-token'}));return;}
  let result;if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'catalog',version:'1'}};
  else if(message.method==='tools/list')result={tools:[{name:'search',description:'External description fixture-token',inputSchema:{type:'object',properties:{query:{type:'string'},...(req.url==='/key-leak'?{'fixture-token':{type:'string'}}:{})}},annotations:{readOnlyHint:true}}]};
  else if(message.method==='tools/call')throw Error('Discovery must never invoke business tools');
  if(message.id===undefined){res.writeHead(202);res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const tool=(args={})=>({toolCalls:[{name:'get_capabilities',args}]}),f=await fixture(t,({body},n)=>{
  if(n===1)return tool();seen.push(JSON.parse(body.messages.findLast(m=>m.role==='tool').content));
  if(n===2)return tool({mcpServer:'catalog'});if(n===3)return tool({mcpServer:'command'});if(n===4)return tool({mcpServer:'missing'});if(n===5)return tool({mcpServer:'broken'});if(n===6)return tool({mcpServer:'credential-key'});return {text:'Discovery complete'};
 });
 writeFileSync(join(f.home,'pi','mcp.json'),JSON.stringify({mcpServers:{catalog:{url:`http://127.0.0.1:${server.address().port}/mcp`,headers:{Authorization:'Bearer fixture-token'}},command:{command:'node',args:['never-start.mjs'],cwd:'/must-not-read'},disabled:{url:'https://unused.invalid',disabled:true},unavailable:{url:'https://unused.invalid'},broken:{url:`http://127.0.0.1:${server.address().port}/unavailable`,headers:{Authorization:'Bearer fixture-token'}},'credential-key':{url:`http://127.0.0.1:${server.address().port}/key-leak`,headers:{Authorization:'Bearer fixture-token'}}}}));
 const options=opts(f);options.frozenConfig.main.maxOutputTokens=123;const task=await runProjectTurn(options);
 assert.equal(task.record.status,'completed',task.record.error);assert.equal(seen.length,6);
 assert.deepEqual(seen[0].mcp.servers.map(s=>[s.server,s.transport,s.status]),[['catalog','http','configured'],['command','stdio','requires_isolated_execution'],['disabled','http','disabled'],['unavailable','http','configured'],['broken','http','configured'],['credential-key','http','configured']]);
 assert.equal(seen[1].mcp.discovery.status,'discovered');assert.deepEqual(seen[1].mcp.discovery.tools.map(t=>t.name),['search']);assert.equal(seen[1].mcp.discovery.tools[0].inputSchema.properties.query.type,'string');
 assert.equal(seen[1].mcp.discovery.untrusted,true);assert.equal(seen[1].mcp.discovery.executionAuthorized,false);
 assert.equal(seen[2].mcp.discovery.status,'requires_isolated_execution');assert.equal(seen[3].mcp.discovery.status,'not_configured');assert.equal(seen[4].mcp.discovery.status,'discovery_failed');assert.equal(seen[5].mcp.discovery.status,'discovery_failed');
 assert.equal(methods.filter(m=>m==='tools/list').length,2);assert.equal(methods.filter(m=>m==='tools/call').length,0);
 for(const snapshot of seen){assert.ok(!JSON.stringify(snapshot).includes('fixture-token'));assert.ok(!JSON.stringify(snapshot).includes('Authorization'));assert.ok(!JSON.stringify(snapshot).includes('/must-not-read'));}
 assert.ok(f.calls.every(c=>(c.body.max_tokens??c.body.max_completion_tokens)===123));
 assert.ok(f.calls.every(c=>c.body.messages.some(m=>['system','developer'].includes(m.role)&&m.content.includes('conversation manager'))));
 assert.ok(f.calls[0].body.tools.find(t=>t.function.name==='get_capabilities').function.parameters.properties.mcpServer);
});

test('capability snapshot distinguishes preview permission from a tool name during read-only preparation',async()=>{
 const {capabilitySnapshot}=await import('../src/builtin-skills.js');
 for(const readOnly of [true,false]){
  const snapshot=capabilitySnapshot({tools:['read','preview_html','resource_exec'],readOnly,scriptAuthorized:true});
  assert.equal(snapshot.permissions.visualPreview,!readOnly);
 }
 assert.equal(capabilitySnapshot({tools:['read'],readOnly:false}).permissions.visualPreview,false);
});
