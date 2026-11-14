import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/pi-fixture.js';
import {managed} from './helpers/agent-sync-fixture.js';
import {createProjectPolicy,recordRouteObservation} from '../src/project-policy.js';
import {project,tool,review} from './project-policy.fixture.js';

for(const forged of [false,true])test(`scope-expansion judge sends only its bound tools and facts through actual Responses HTTP; forged=${forged}`,async t=>{
 let judgeWire;
 const expansion=tool('refresh_change',{scope:['export.json','meta.json'],reason:'The requested export includes metadata.'});
 const judgment={...review,contains:'"needsMetadata":true',repairScope:['meta.json']};
 const sequence=[tool('write',{path:'export.json',content:'{"version":2,"needsMetadata":true}'}),expansion,
  forged?tool('edit',{path:'export.json',edits:[{oldText:'"version":2',newText:'"version":99'}]}):tool('project_route_judge',judgment),
  expansion,tool('write',{path:'meta.json',content:'{"format":1}'}),tool('accept_change'),tool('accept_change'),{text:'Export and metadata delivered.'}];
 const {state,f}=await project(t,{responsesApi:true,budget:{maxCalls:8},spec:{deliverables:['export.json','meta.json'],scope:['export.json','meta.json']},handler:({body},n,_req,res)=>{
  if(n===3)judgeWire=structuredClone(body);
  const reply=sequence[n-1]??{text:'Stop.'},output=reply.toolCalls?reply.toolCalls.map((call,index)=>({type:'function_call',id:`fc_${n}_${index}`,call_id:`call_${n}_${index}`,name:call.name,arguments:JSON.stringify(call.args),status:'completed'})):
   [{type:'message',id:`message_${n}`,role:'assistant',content:[{type:'output_text',text:reply.text,annotations:[]}],status:'completed'}];
  res.writeHead(200,{'content-type':'text/event-stream'});const event=value=>res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  for(const [index,item]of output.entries()){event({type:'response.output_item.added',output_index:index,item:{...item,...(item.type==='function_call'?{arguments:''}:{content:[]})}});event({type:'response.output_item.done',output_index:index,item});}
  event({type:'response.completed',response:{id:`response_${n}`,status:'completed',output,usage:{input_tokens:12,output_tokens:5,total_tokens:17}}});res.end();return null;
 }});
 assert.ok(judgeWire,'the paused route must receive its one bound HTTP request');
 const declared=[...(judgeWire.tools??[]),...(judgeWire.input??[]).flatMap(item=>item.type==='additional_tools'?item.tools:[])].map(tool=>tool.name??tool.function?.name);
 assert.deepEqual(declared,['project_route_judge']);assert.equal(judgeWire.tools,undefined);assert.ok(judgeWire.input.some(item=>item.type==='additional_tools'));
 const system=JSON.stringify((judgeWire.input??[]).filter(item=>['system','developer'].includes(item.role)&&item.type!=='additional_tools'));
 assert.match(system,/scope_expansion/);assert.match(system,/project_route_judge/);assert.match(system,/one.*(?:use|request)|single.*request/i);assert.ok(system.includes(state.steps[0].route.candidate));assert.match(system,/requestedScope/);
 assert.ok(JSON.stringify(judgeWire).includes('Export a readable version 2 artifact.'));
 const route=state.steps[0].route;assert.equal(route.kind,'scope_expansion');assert.ok(route.judgmentCall);
 t.diagnostic(JSON.stringify({adapter:'openai-responses',toolsForm:'additional_tools',tools:declared,kind:route.kind,candidate:route.candidate,forged}));
 if(forged){assert.equal(route.status,'paused');assert.equal(route.judgment,undefined);assert.equal(f.calls.length,3);assert.equal(state.status,'blocked');}
 else {assert.equal(route.status,'resolved',JSON.stringify({status:state.status,error:state.steps[0].error,lastWire:f.calls.at(-1)?.body.input?.at(-1)}));assert.equal(route.probe.decision,'repair');assert.equal(state.status,'completed');assert.equal(f.calls.length,8);}
});

test('a forged edit in the judge response cannot inherit the repair grant before the next normal request',async t=>{
 const {createRuntime}=await import('../src/pi-runtime.js'),{Type}=await import('typebox');
 const judgment={...review,path:'a.txt',contains:'base A',repairScope:['a.txt']};
 const f=await fixture(t,(_call,n)=>n===1?{toolCalls:[{name:'project_route_judge',args:judgment},{name:'edit',args:{path:'a.txt',edits:[{oldText:'base A',newText:'forged mutation'}]}},{name:'read',args:{path:'a.txt'}}]}:{text:'Judgment returned; no mutation was authorized in its response.'});
 const m=await managed(t,{scope:['a.txt']}),step={id:'s',scope:['a.txt'],status:'running',revision:1,attempts:[{taskId:m.task.record.id}]};
 const state={id:'p',status:'active',goal:'Preserve source while diagnosing',steps:[step],scope:['a.txt'],budget:{maxCalls:3}};
 const host={read:()=>structuredClone(state),update:fn=>fn(state),assertOwned(){}};
 m.task.projectPolicy=createProjectPolicy({host,binding:{projectId:'p',stepId:'s',revision:1,taskId:m.task.record.id},home:m.home});
 recordRouteObservation(state,'s',{candidate:m.binding.current.privateVersion,privateVersion:m.binding.current.privateVersion,changeId:m.binding.current.changeId,taskId:m.task.record.id,actor:'main',kind:'failed',evidence:{exitCode:1}});
 m.stage.modelRef=f.models.main;
 const judge={name:'project_route_judge',description:'Propose the existing bound judgment',executionMode:'sequential',parameters:Type.Object({reason:Type.String(),path:Type.String(),contains:Type.String(),ifPresent:Type.String(),ifAbsent:Type.String(),repairScope:Type.Array(Type.String())}),
  execute:async(id,args)=>({content:[{type:'text',text:JSON.stringify(await m.task.projectPolicy.judgeLive(args,{actor:'main',toolCallId:id,versioning:m.v}))}]})};
 const runtime=await createRuntime({home:f.home,cwd:m.project,modelRef:f.models.main,role:"leader-"+m.task.record.id,projectManaged:true,toolDefinitions:[...m.definitions,judge]});t.after(()=>runtime.dispose());runtime.bindTask(m.task,m.stage);
 await runtime.prompt('Diagnose the exact paused candidate without editing it.');
 const toolResults=f.calls[1]?.body.messages.filter(message=>message.role==='tool')??[];
 assert.match(toolResults.at(-2)?.content??'',/read.only judgment|after the observed experiment/i,'a sequentially completed judge must not grant its sibling edit authority');
 assert.match(toolResults.at(-1)?.content??'',/read.only judgment/i,'the same bound request must not gain other ordinary tools after its judge completes');
 assert.equal(step.route.status,'repair');assert.equal(step.route.edit,undefined);
 assert.equal(Buffer.from((await m.v.read({version:m.binding.current.privateVersion,path:'a.txt'})).contentBase64,'base64').toString(),'base A\n');
 assert.ok(f.calls[1].body.tools.some(tool=>tool.function.name==='edit'),'a new normal request regains actual repair tools');assert.equal(f.calls.length,2);
});

for(const changed of ['new-pause','candidate'])test(`dispatch refuses a judge projection changed by ${changed} without spending its one-use request`,()=>{
 const id='14a38bc5-56b1-42db-abba-b8dace10be32',step={id:'s',scope:['a.txt'],revision:1,status:'running',attempts:[{taskId:id}]};
 const state={id:'p',status:'active',steps:[step],budget:{maxCalls:3}},host={read:()=>structuredClone(state),update:fn=>fn(state),assertOwned(){}};
 const policy=createProjectPolicy({host,binding:{projectId:'p',stepId:'s',revision:1,taskId:id}}),model={provider:'fixture',id:'main'},stage={id:'stage',role:'main',phase:'work',sessionId:'session',modelRef:{provider:'fixture',modelId:'main'}};
 const task={record:{id,input:'Keep original goal',stages:[stage]},requests:()=>[]};
 const pause=candidate=>recordRouteObservation(state,'s',{candidate,taskId:id,kind:'scope_expansion',evidence:{previousScope:['a.txt'],requestedScope:['a.txt','b.txt']}});
 if(changed==='candidate')pause('before');
 const context={messages:[{role:'system',content:'ordinary leader',toolsAdded:[{name:'edit'},{name:'project_route_judge'}]}]},intent=policy.locateSend({task,stage,context,model});
 policy.projectRequestContext(intent,context);
 if(changed==='new-pause')pause('after');else step.route.candidate='after';
 assert.throws(()=>policy.admit('prepareSend',intent),/projection|prepared.*route/i);
 assert.throws(()=>policy.admit('send',intent),/projection|prepared.*route/i);
 assert.equal(step.route.judgmentCall,undefined);assert.equal(state.callIntents,undefined);
});

async function privateRepair(t,{kind='scope_expansion',checked=true}={}) {
 const {execution}=await import('./helpers/agent-sync-fixture.js'),{runProjectRoute}=await import('../src/project-policy.js');
 const checks=[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='fixed A\\n')process.exit(1)"]}];
 const m=await managed(t,{scope:['a.txt'],checks,execution}),step={id:'s',scope:['a.txt'],checks,revision:1,status:'running',attempts:[{taskId:m.task.record.id}]};
 const state={id:'p',status:'active',steps:[step],budget:{maxCalls:5}},host={read:()=>structuredClone(state),update:fn=>fn(state),assertOwned(){}};
 recordRouteObservation(state,'s',{kind,candidate:m.binding.current.privateVersion,privateVersion:m.binding.current.privateVersion,changeId:m.binding.current.changeId,taskId:m.task.record.id,actor:'main',evidence:{previousScope:['a.txt'],requestedScope:['a.txt','extra.txt']}});
 const input={stepId:'s',revision:1,candidate:step.route.candidate,path:'a.txt',contains:'base A',ifPresent:'repair',ifAbsent:'blocked',repairScope:['a.txt'],reason:'The saved original file distinguishes the bounded correction.'};
 await runProjectRoute({host,home:m.home,action:'judge',input,versioning:m.v});await runProjectRoute({host,home:m.home,action:'experiment',input,versioning:m.v});
 await m.call('read','read-before-repair',{path:'a.txt'});await m.call('edit','bounded-repair',{path:'a.txt',edits:[{oldText:'base A',newText:'fixed A'}]});
 step.route.edit={requestId:m.task.record.tools.find(tool=>tool.toolCallId==='bounded-repair').requestId,taskId:m.task.record.id,changeId:m.binding.current.changeId,paths:['a.txt']};
 const prepared=await m.v.prepareChange(m.binding.current.changeId,{requestId:'private-verify',check:checked}),candidate=prepared.candidates.at(-1);
 m.task.record.project={projectId:'p',stepId:'s',revision:1,taskId:m.task.record.id,checkPolicy:{digest:candidate.policy}};
 m.task.record.work={requests:[{action:'prepareChange',requestId:'private-verify',changeId:prepared.changeId,status:'prepared',dispatched:true}],changes:[prepared]};
 const policy=createProjectPolicy({host,binding:m.task.record.project,home:m.home});m.task.projectPolicy=policy;m.task.save();
 const result={...candidate.precheck,tree:candidate.tree,requestId:'private-verify'};
 return {...m,step,state,policy,candidate,prepared,result};
}
for(const kind of ['scope_expansion','failed'])test(`trusted private checks resolve ${kind} without accepting the artifact`,async t=>{
 const m=await privateRepair(t,{kind}),formal=(await m.v.inspect()).version;
 await m.policy.observeCheck({kind:'precheck',candidate:m.candidate.candidateVersion,privateVersion:m.candidate.privateVersion,changeId:m.prepared.changeId,result:m.result,versioning:m.v});
 assert.equal(m.step.route.status,'resolved');assert.equal(m.step.route.recheck.kind,'precheck');
 assert.equal((await m.v.inspect()).version,formal);assert.equal(m.step.status,'pending');
 assert.doesNotThrow(()=>m.policy.admit('delegate',{actor:'main'}),'original work permission returns after local verification');
 const accepted=await m.v.acceptChange({changeId:m.prepared.changeId,candidateVersion:m.candidate.candidateVersion,requestId:'accept-verified'});
 await m.policy.observeCheck({kind:'candidate',candidate:m.candidate.candidateVersion,changeId:m.prepared.changeId,result:accepted,versioning:m.v});
 assert.equal(m.step.route.recheck.acceptedVersion,accepted.acceptedVersion,'formal acceptance closes this repair episode');
 const next=await m.v.beginChange({requestId:'later-change',actor:'main',intent:'later work',scope:['a.txt'],readScope:['a.txt']});
 recordRouteObservation(m.state,'s',{candidate:next.privateVersion,privateVersion:next.privateVersion,changeId:next.changeId,taskId:m.task.record.id,actor:'main',kind,evidence:{requestId:'new-observation',exitCode:1}});
 assert.equal(m.step.route.status,'paused','later work gets its own mandatory judgment, not an old blocked candidate');
 assert.equal(m.step.routeHistory.at(-1).recheck.acceptedVersion,accepted.acceptedVersion);
 assert.throws(()=>m.policy.admit('delegate',{actor:'main'}),{code:'PROJECT_ROUTE'});
});
for(const fault of ['stale','missing-check','forged','source-changed','wrong-policy','missing-receipt'])test(`private verification cannot resolve a repair with ${fault}`,async t=>{
 const m=await privateRepair(t,{checked:fault!=='forged'});let result=structuredClone(m.result);
 if(fault==='stale'){const old=await m.v.read({changeId:m.prepared.changeId,path:'a.txt'});await m.v.edit(m.prepared.changeId,{requestId:'newer-unchecked',expectedVersion:m.candidate.privateVersion,edits:[{path:'a.txt',oldHash:old.contentHash,contentBase64:Buffer.from('unchecked\n').toString('base64')}]});}
 if(fault==='missing-check')m.step.checks.push({command:'node',args:['--version']});
 if(fault==='forged')result={status:'passed',verification:'passed',checks:[{command:m.step.checks[0].command,args:m.step.checks[0].args,exitCode:0,sourceChanged:false}],tree:m.candidate.tree,requestId:'private-verify',binding:{candidateVersion:m.candidate.candidateVersion,policy:m.candidate.policy}};
 if(fault==='source-changed')result.checks[0].sourceChanged=true;
 if(fault==='wrong-policy')m.task.record.project.checkPolicy.digest='not-the-frozen-policy';
 if(fault==='missing-receipt')result.requestId='missing-private-receipt';
 m.task.save();
 await m.policy.observeCheck({kind:'precheck',candidate:m.candidate.candidateVersion,privateVersion:m.candidate.privateVersion,changeId:m.prepared.changeId,result,versioning:m.v}).catch(()=>{});
 assert.notEqual(m.step.route.status,'resolved');
});

test('scope repair private verification restores collaboration and real visual work before formal acceptance',async t=>{
 const {readFileSync}=await import('node:fs'),{join}=await import('node:path'),{listTasks}=await import('../src/task.js');
 const {execution}=await import('./helpers/agent-sync-fixture.js'),{visualManifest,payloadImageHashes}=await import('../src/visual-preview.js');
 const {saveConfig}=await import('../src/config.js'),{fileURLToPath}=await import('node:url');
 const workExecution={...execution,image:visualManifest().image};
 const html=`<!doctype html><button id="start" onclick="this.textContent='Clicked'">Ready</button>`;
 const check={command:'node',args:['-e',"if(!require('fs').readFileSync('index.html','utf8').includes('>Verified</button>'))process.exit(1)"]};
 let n=0,worker=0,failure,home,privateVersion,reviewedImages=false,checkedBeforeRoles=false;
 const rogue={id:'rogue',responsibility:'must never start',models:['fixture/r1'],scope:[],readScope:['index.html'],need:'deliverable',reason:'same-response escalation'};
 const {f,state}=await project(t,{onSetup:({f})=>{home=f.home;saveConfig(f.home,{formatVersion:2,...f.models,work:{execution:workExecution},piResources:{skills:[fileURLToPath(new URL('./fixtures/visual-skill/SKILL.md',import.meta.url))]}});},budget:{maxCalls:30},vision:true,workExecution,
  spec:{goal:'Repair then inspect the interactive page',scope:['index.html','extra.txt'],deliverables:['index.html'],checks:[check]},
  handler:({body})=>{try{
   if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
   if(body.model==='r1')return ++worker===1?{text:'I will inspect the fixed HTML read-only.'}:worker===2?tool('read',{path:'index.html'}):{text:'The source has the Verified button and click handler; visual behavior needs the manager preview.'};
   if(body.tools?.some(tool=>tool.function.name==='submit_visual_review'))return tool('submit_visual_review',{verdict:'match',observation:'The button is rendered.',reasons:'The actual supplied screenshot shows the button.'});
   switch(++n){
    case 1:return tool('write',{path:'index.html',content:html});
    case 2:return tool('refresh_change',{scope:['index.html','extra.txt'],reason:'Consider another page file'});
    case 3:return tool('project_route_judge',{path:'index.html',contains:'Ready',ifPresent:'shorten',ifAbsent:'blocked',repairScope:['index.html'],reason:'The existing button file is sufficient for this correction'});
    case 4:return tool('edit',{path:'index.html',edits:[{oldText:'Ready',newText:'Verified'}]});
    case 5:{
     const names=body.tools.map(tool=>tool.function.name);for(const forbidden of ['bash','delegate','project_staff','write','edit'])assert.ok(!names.includes(forbidden),forbidden);
     const schema=body.tools.find(tool=>tool.function.name==='prepare_change').function.parameters;assert.equal(schema.properties.check.const,true);
     const system=JSON.stringify(body.messages.filter(message=>['system','developer'].includes(message.role)));assert.match(system,/prepare_change/);assert.ok(system.includes(check.args[1]));
     return {toolCalls:[{name:'prepare_change',args:{check:true}},{name:'bash',args:{command:"node -e \"require('fs').writeFileSync('index.html','FORGED')\""}},{name:'project_staff',args:{action:'appoint',input:rogue}}]};
    }
    case 6:{
     const errors=body.messages.filter(message=>message.role==='tool').slice(-2);assert.ok(errors.every(message=>message.content.includes('bounded repair authority')));
     assert.ok(body.tools.some(tool=>tool.function.name==='delegate'));assert.ok(body.tools.some(tool=>tool.function.name==='bash'));
     const restored=body.messages.filter(message=>['system','developer'].includes(message.role)).map(message=>message.content).join('\n');assert.match(restored,/normal ORIGINAL/);assert.match(restored,/not delivery/);assert.match(restored,/"formalAcceptancePending":true/);
     const record=listTasks(home).find(task=>task.project),saved=JSON.parse(readFileSync(join(home,'project-delivery',record.project.projectId,'state.json')));
     assert.equal(saved.steps[0].route.status,'resolved');assert.equal(saved.steps[0].route.recheck.kind,'precheck');
     assert.equal(record.work.acceptance.length,0);assert.equal(saved.version,record.work.startVersion);assert.ok(!saved.staff.some(position=>position.id==='rogue'));
     privateVersion=saved.steps[0].route.recheck.privateVersion;checkedBeforeRoles=true;
     return tool('project_staff',{action:'appoint',input:{...rogue,id:'inspector',reason:'Original authorized independent source inspection'}});
    }
    case 7:return tool('delegate',{staffId:'inspector',model:'fixture/r1',workId:'export:index.html',assignment:'Inspect index.html without executing or editing it',reason:'Independent source evidence before acceptance',scope:[],readScope:['index.html'],readOnly:true});
    case 8:return tool('collect');
    case 9:return tool('preview_html',{entry:'index.html',viewport:{width:180,height:100},frameTimesMs:[0],actions:[{kind:'click',selector:'#start'}]});
    case 10:reviewedImages=payloadImageHashes(body).size>0;assert.equal(reviewedImages,true,JSON.stringify(body.messages.at(-1)));return tool('accept_change');
    case 11:return tool('accept_change');
    default:return {text:'The repaired page was privately checked, independently inspected, rendered and clicked before formal acceptance.'};
   }
  }catch(error){failure??=error;return {text:'Fixture contract check failed: '+error.message};}}
 });
 if(failure)throw failure;
 assert.equal(state.status,'completed',JSON.stringify(state.steps[0]));assert.equal(state.steps[0].route.status,'resolved');assert.equal(state.steps[0].route.recheck.acceptedVersion,state.version);
 assert.equal(checkedBeforeRoles,true);assert.equal(reviewedImages,true);assert.ok(worker>=3);assert.ok(state.version);assert.notEqual(state.version,privateVersion);
 const assignments=Object.values(state.staffAssignments);assert.equal(assignments.length,1);assert.equal(assignments[0].staffId,'inspector');
 const record=listTasks(f.home).find(task=>task.project);assert.ok(record.work.acceptance.some(receipt=>receipt.status==='accepted'));assert.ok(!record.tools.some(row=>row.name==='bash'&&row.kernelDispatched));
});
