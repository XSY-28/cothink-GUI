import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import {readTask,readRequests} from '../src/task.js';
for(const args of ['{}',JSON.stringify({path:'a.txt',content:'must not be written'})])test('length tool call cannot execute or continue: '+args,{timeout:20000},async t=>{
 const plan={goal:'Update a.txt',scope:['a.txt'],readScope:['a.txt'],deliverables:['a.txt'],checks:[{command:'node',args:['-e','process.exit(0)']}]};
 const f=await fixture(t,(_,n,req,res)=>{
  if(n===1)return {toolCalls:[{name:'start_work',args:{action:'start',reason:'bounded work',plan}}]};
  assert.equal(n,2,'No automatic continuation or retry');
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=(delta,finish_reason=null,usage)=>res.write('data: '+JSON.stringify({id:'truncated',object:'chat.completion.chunk',model:'main',choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n');
  chunk({role:'assistant',content:'Useful partial draft retained.'});
  chunk({tool_calls:[{index:0,id:'incomplete-write',type:'function',function:{name:'write',arguments:args}}]});
  chunk({},'length',{prompt_tokens:12,completion_tokens:17,total_tokens:29});res.end('data: [DONE]\n\n');return null;
 });
 const base=await projectSession(t,repository(t),f),proposal=await runProjectTurn({...base,input:plan.goal});
 const root=await confirmProject(base,proposal),child=readTask(f.home,root.record.projectOperation.childTaskIds[0]);
 const calls=readRequests(f.home,child);assert.equal(f.calls.length,2);assert.equal(calls.length,1);
 const call=calls[0];assert.equal(call.status,'partial');assert.equal(call.response.stopReason,'length');assert.equal(call.usage.output,17);assert.match(call.text,/Useful partial draft retained/);
 assert.ok(call.response.content.some(p=>p.type==='toolCall'));assert.ok(!child.tools?.some(tool=>tool.name==='write'));
 assert.match(child.error,/Output limit interrupted a tool call/);assert.doesNotMatch(child.error,/recorded parent/);assert.ok(root.record.localExecutionClosedAt);
});
