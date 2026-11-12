import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {fixture} from './helpers/pi-fixture.js';
import {createTask,readRequests} from '../src/task.js';
import {createRootOwner,normalizeRootBudget,normalizeConstraints} from '../src/project-turn.js';
import {projectGuiTask} from '../src/gui-projection.js';
import {finalText} from '../src/presentation.js';
import {modalEnvironment} from './gui-modal.fixture.js';

const model={provider:'fixture',modelId:'main'};
const record={id:'root',flow:'unified',turnIntent:{},status:'running',stages:[{id:'worker',role:'main',phase:'draft',callIds:['r']}],models:{main:model,secondary:[]}};
const call={id:'r',stageId:'worker',role:'main',status:'in_flight',sent:true,actualModel:model,
 createdAt:'2026-11-12T00:00:00.000Z',transport:{dispatchedAt:'2026-11-12T00:00:01.000Z',headersAt:'2026-11-12T00:00:02.000Z',lastBodyAt:'2026-11-12T00:00:10.000Z',responseHeaders:{authorization:'secret-header'},unterminatedSseTail:'secret-tail'}};

test('request progress whitelists timings and keeps saved incomplete observations distinct from live waits',()=>{
 const live=projectGuiTask(record,[call],[],{liveRequests:true});
 assert.deepEqual(live.messages[0].progress,{live:true,startedAt:'2026-11-12T00:00:01.000Z',headersAt:'2026-11-12T00:00:02.000Z',lastDataAt:'2026-11-12T00:00:10.000Z',endedAt:null});
 assert.equal(projectGuiTask(record,[call]).messages[0].progress.live,false);
 assert.doesNotMatch(JSON.stringify(live),/secret-header|secret-tail|responseHeaders/);
 const commands=projectGuiTask({...record,tools:[{name:'bash',toolCallId:'shell',stageId:'worker',status:'running',kernelInput:{command:'secret shell text'}}]},[]);
 assert.deepEqual(commands.commands,[{id:'shell',role:'main',status:'running',submitted:true,registeredAt:null,live:false}]);
 assert.doesNotMatch(JSON.stringify(commands),/secret shell/);
});

test('only registered current-operation children supply live transport snapshots; durable snapshots remain unchanged',async t=>{
 const f=await fixture(t),root=createTask({home:f.home,input:'root',models:f.models,flow:'unified',constraints:normalizeConstraints(),budget:normalizeRootBudget()});
 root.record.projectOperation={commandId:'operation',childTaskIds:[]};const owner=createRootOwner(root);
 const child=createTask({home:f.home,input:'child',models:f.models,rootTaskId:root.record.id,project:{commandId:'operation'}});
 owner.registerTask(child);const request={...call,id:randomUUID(),events:[],taskId:child.record.id,transport:{...call.transport}};child.register(request);child.writeRequest(request);
 request.transport.lastBodyAt='2026-11-12T00:01:00.000Z';
 assert.equal(owner.snapshotFor(child.record.id).requests[0].transport.lastBodyAt,'2026-11-12T00:01:00.000Z');
 assert.equal(readRequests(f.home,child.record)[0].transport.lastBodyAt,'2026-11-12T00:00:10.000Z');
 assert.equal(owner.snapshotFor('historical'),null);
 child.record.project.commandId='different';assert.equal(owner.snapshotFor(child.record.id),null);
 child.record.project.commandId='operation';root.record.status='partial';assert.equal(owner.snapshotFor(child.record.id),null);
});

test('process details report each request wait without a global checker heartbeat or invented historical inactivity',async()=>{
 await modalEnvironment(async({root,container,Collaboration})=>{
  const now=Date.now(),worker={...call,transport:{...call.transport,lastBodyAt:new Date(now-65000).toISOString()}},
    checker={...call,id:'check',stageId:'check',role:'process-check',transport:{lastBodyAt:new Date(now).toISOString()}};
  const task=projectGuiTask({...record,stages:[...record.stages,{id:'check',role:'process-check',phase:'process-check',callIds:['check']}],budget:{maxCalls:8}},[worker,checker],[],{liveRequests:true});
  const render=task=>act(()=>root.render(React.createElement(Collaboration,{task,expanded:true,tab:'collaboration',setTab(){},onExpand(){},onClose(){},commands:{}})));
  await render(task);assert.match(container.textContent,/等待模型返回/);assert.match(container.textContent,/最近收到数据/);assert.match(container.textContent,/检查报告.*最多.*1.*模型请求/s);assert.match(container.textContent,/经理.*1.*补做提示/s);
  const workerTiming=[...container.querySelectorAll('.source-ref')].find(node=>node.textContent==='请求 r').previousElementSibling.textContent;
  assert.match(workerTiming,/最近收到数据 6[5-9] 秒 前/,'a fresh checker response must not reset the waiting worker clock');
  await render(projectGuiTask({...record,status:'outcome_unknown'},[call]));
  assert.match(container.textContent,/保存快照/);assert.doesNotMatch(container.textContent,/距今.*秒/);
  for(const status of ['running','preparing']) {
   const saved=projectGuiTask({...record,status:'outcome_unknown',tools:[{name:'bash',toolCallId:'original-bash',stageId:'worker',status,kernelInput:{},registeredAt:'2026-11-12T00:00:00.000Z'}]},[]);
   await render(saved);
   assert.match(container.textContent,/命令 original-bash/,'the original command receipt pointer remains visible');
   assert.match(container.textContent,/保存快照，当前状态未确认/);
   assert.match(container.textContent,/核对原回执，不自动重发/);
   assert.match(container.textContent,/宿主登记 /);
   assert.doesNotMatch(container.textContent,/等待命令回执|命令尚未返回|等待执行准入|距宿主登记/,'saved unsettled commands must not imply a current execution or clock');
   assert.equal(saved.commands[0].status,status);assert.equal(saved.commands[0].live,false);
  }
 });
});

test('work proposal shows independent root and cumulative project caps with bounded correction policy',()=>{
 const text=finalText({flow:'unified',proposal:{canonicalRepo:'/fixture',version:'v',constraints:{},budgetAtProposal:{remainingCalls:7},plan:{budget:{maxCalls:4}}},models:{main:model}},[]);
 assert.match(text,/本轮剩余请求数：7/);assert.match(text,/项目累计请求上限：4/);assert.match(text,/检查报告.*1.*模型请求/s);assert.match(text,/经理.*补做提示/s);
});

test('new managed command records host registration once and querying its original receipt does not reset the wait clock',async t=>{
 const {managed,execution}=await import('./helpers/agent-sync-fixture.js');
 const work=await managed(t,{execution});
 const args={command:'node -e "setTimeout(()=>process.stdout.write(\'ok\'),200)"'};
 const running=work.call('bash','timed-command',args);
 let trace;for(let i=0;i<100;i++){trace=work.task.record.tools?.find(x=>x.toolCallId==='timed-command');if(trace)break;await new Promise(r=>setTimeout(r,10));}
 const registered=trace?.registeredAt;
 assert.ok(Number.isFinite(Date.parse(registered)),'host registration is present before the command returns');
 assert.equal(projectGuiTask(work.task.record).commands[0].registeredAt,registered);
 await modalEnvironment(async({root,container,Collaboration})=>{
  const task=projectGuiTask({...work.task.record,flow:'unified',turnIntent:{}},[],[],{liveRequests:true});
  await act(()=>root.render(React.createElement(Collaboration,{task,expanded:true,tab:'collaboration',setTab(){},onExpand(){},onClose(){},commands:{}})));
  assert.match(container.textContent,/命令尚未返回/);assert.match(container.textContent,/距宿主登记 \d+ 秒/);
  assert.match(container.textContent,/启动及进度未确认/);
 });
 await running;await work.call('bash','timed-command',args);
 assert.equal(work.task.record.tools.find(x=>x.toolCallId==='timed-command').registeredAt,registered);
 assert.equal(projectGuiTask(work.task.record,[],[],{liveRequests:true}).commands[0].live,false,'completed command does not keep ticking');
});
