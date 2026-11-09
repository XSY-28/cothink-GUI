import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {Window} from 'happy-dom';
import {fixture} from './helpers/pi-fixture.js';
import {createGuiController} from '../src/gui-controller.js';
import {saveConfig} from '../src/config.js';
import {createTeamConfig} from '../src/teams.js';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {useGuiWorkspace} from '../gui/src/useGuiWorkspace.js';
import {Composer} from '../gui/src/Composer.js';

test('GUI organizer flushes complete options, keeps new input, and recovers a lost receipt without replay',async t=>{
 let release;const hold=new Promise(r=>release=r),f=await fixture(t,async()=>{await hold;return {text:'summary'};});t.after(()=>release());
 saveConfig(f.home,createTeamConfig({formatVersion:2,...f.models},'Fixture',randomUUID()));
 let controller=await createGuiController({home:f.home,cwd:f.cwd}),s=await controller.action('session.create',{project:null});await controller.close();
 const path=join(f.home,'pi/sessions/main',readdirSync(join(f.home,'pi/sessions/main')).find(n=>n.endsWith('.jsonl'))),manager=SessionManager.open(path);
 for(let i=0;i<14;i++){manager.appendMessage({role:'user',content:'User request '+i+'. '+'material '.repeat(650),timestamp:Date.now()});manager.appendMessage({role:'assistant',api:'openai-completions',provider:'fixture',model:'main',content:[{type:'text',text:'Response '+i+'. '+'evidence '.repeat(650)}],stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()});}
 controller=await createGuiController({home:f.home,cwd:f.cwd});t.after(()=>controller.close());
 const win=new Window({url:'http://localhost/'}),previous={};
 for(const key of ['window','document','navigator','HTMLElement','Event','sessionStorage']){previous[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?win:win[key]});}
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=await import('react-dom/client'),container=win.document.createElement('div');win.document.body.append(container);const root=createRoot(container);
 let workspace,organizes=0,queries=0,operationId;const actions=[];
 const api={subscribe:(_invalidate,status)=>{status('connected');return ()=>{};},async read(kind,args={}){if(kind==='session')return controller.session(args.id);if(kind==='sessions')return controller.sessions(args);if(kind==='task')return controller.task(args.id);if(kind==='context-operation'){queries++;return controller.readContextOperation(args.operationId);}return controller.bootstrap();},async action(name,args){actions.push(name);const value=await controller.action(name,args);if(name==='context.organize'){organizes++;operationId=args.operationId;throw Object.assign(Error('lost receipt'),{unknown:true});}return value;}};
 function Harness(){workspace=useGuiWorkspace(api);return React.createElement(Composer,{session:workspace.state.session,boot:workspace.state.bootstrap,draft:workspace.state.draft,onDraft:text=>workspace.commands.setDraft(s.id,text),onSubmit(){},onChange(){},turnOptions:workspace.state.turnOptions,onTurnOptions:change=>workspace.commands.setTurnOptions(s.id,change),onOrganize:()=>workspace.commands.organizeContext(),busy:!!workspace.state.bootstrap.active,submitting:workspace.state.submitting,pending:!!workspace.state.pending});}
 try{
  await act(async()=>root.render(React.createElement(Harness)));await act(async()=>workspace.commands.openSession(s.id));
  await act(()=>{workspace.commands.setDraft(s.id,'preserve next task');workspace.commands.setTurnOptions(s.id,{maxCalls:'2',readOnly:true,delegate:false});});
  await act(async()=>workspace.commands.organizeContext());assert.equal(organizes,1);assert.ok(actions.indexOf('session.draft')<actions.indexOf('context.organize'));assert.equal(workspace.state.pending.kind,'context');
  const saved=await controller.session(s.id);assert.equal(saved.editor.text,'preserve next task');assert.equal(saved.editor.turnOptions.maxCalls,'2');assert.equal(saved.editor.turnOptions.readOnly,true);
  await act(()=>workspace.commands.setDraft(s.id,'newer local next task'));await act(async()=>workspace.commands.flushAllDrafts().catch(()=>{}));assert.equal((await controller.session(s.id)).editor.text,'preserve next task');
  await act(async()=>workspace.commands.recoverSubmission());assert.equal(organizes,1);assert.ok(queries>0);assert.equal(workspace.state.draft,'newer local next task');
  await act(async()=>{release();for(let i=0;i<500&&(await controller.bootstrap()).active;i++)await new Promise(r=>setTimeout(r,10));});
  await act(async()=>{await workspace.commands.refresh();await new Promise(r=>setTimeout(r,20));});await act(async()=>workspace.commands.flushAllDrafts());
  assert.equal((await controller.readContextOperation(operationId)).applied,true);assert.equal((await controller.session(s.id)).editor.text,'newer local next task');assert.equal(workspace.state.turnOptions.maxCalls,'2');assert.equal(organizes,1);
 }finally{release();await act(()=>root.unmount());win.happyDOM.abort();for(const [key,value]of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
