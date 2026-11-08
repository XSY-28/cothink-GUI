import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import * as sdk from '/runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {createAssistantMessageEventStream} from '/runtime/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js';
import {createDefaultChildSessionFactory} from '/native/node_modules/pi-subagents/src/runs/shared/child-session.js';
import {registerHostIntegration,admitHostChild} from '/native/node_modules/pi-subagents/src/runs/shared/host-integration.js';
import {installProjectNativeModelBridge} from '/bridge.mjs';
const facts=[],streams=[];
const bridge=installProjectNativeModelBridge({ModelRuntime:sdk.ModelRuntime,createStream:createAssistantMessageEventStream,rpc:async(action,args)=>{
  assert.equal(action,'native.model');streams.push({...args,dummyOnly:!JSON.stringify(args).includes('COTHINK_NO_CREDENTIALS')});
  const message={role:'assistant',api:'openai-completions',provider:'fixture',model:'main',content:[{type:'text',text:'BRIDGED '+args.launchId}],stopReason:'stop',timestamp:Date.now(),cothinkMessageId:'host-'+args.launchId,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  return {events:[{type:'done',reason:'stop',message}]};
}});
mkdirSync('/tmp/parent',{recursive:true});
const close=registerHostIntegration({cwd:'/tmp/parent',parentSessionId:'parent-session',host:{
  agentDir:'/tmp/pi',admitOperation:async()=>({}),
  async admitChild(input){
    const launchId=input.runtime.agent,cwd='/tmp/source/'+launchId,hostAgentDir='/tmp/pi-'+launchId;
    mkdirSync(cwd,{recursive:true});mkdirSync(hostAgentDir,{recursive:true});
    bridge.admit({launchId,agentDir:hostAgentDir,model:{provider:'fixture',id:'main',api:'openai-completions',name:'main',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096}});
    assert.equal(existsSync(hostAgentDir+'/auth.json'),false);
    return {launchId,cwd,hostAgentDir,hostSettings:{retry:{enabled:false,provider:{maxRetries:0,timeoutMs:0}},compaction:{enabled:false},cacheWarming:'off'},model:'fixture/main'};
  },
  async claimStart({launchId}){facts.push({kind:'claimStart',launchId});},
  async started(fact){bridge.started({launchId:fact.launchId,sessionId:fact.sessionId});facts.push({kind:'started',launchId:fact.launchId,sessionId:fact.sessionId});},
  async terminal(fact){facts.push({kind:'terminal',...fact});}
}});
const factory=process.env.PROBE_BUNDLE==='1' ? (await import('/native/node_modules/pi-subagents/bundle/chunk-DZDETGRJ.js')).childSessionFactory() : createDefaultChildSessionFactory();
const launch=async name=>factory.create(await admitHostChild({cwd:'/tmp/parent',parentSessionId:'parent-session',model:'fixture/main',storage:{kind:'memory'},tools:[],extensionPaths:[],hooks:[],ambientExtensions:false,noSkills:true,noContextFiles:true,runtime:{agent:name},systemPrompt:'Reply to the user.'}));
const [a,b]=await Promise.all([launch('alpha'),launch('beta')]);
await Promise.all([a.prompt('alpha input'),b.prompt('beta input')]);
assert.match(a.messages.at(-1).content[0].text,/BRIDGED alpha/);
assert.match(b.messages.at(-1).content[0].text,/BRIDGED beta/);
assert.equal(new Set(streams.map(s=>s.sessionId)).size,2);
assert.ok(streams.every(s=>s.dummyOnly));assert.equal(a.messages.at(-1).cothinkMessageId,'host-alpha');assert.equal(b.messages.at(-1).cothinkMessageId,'host-beta');
await Promise.all([a.dispose(),b.dispose()]);await factory.dispose();await close();
assert.equal(facts.filter(f=>f.kind==='terminal'&&f.disposed&&f.shutdownCompleted).length,2);
bridge.restore();console.log(JSON.stringify({ok:true,streams:streams.map(({launchId,sessionId,method,dummyOnly})=>({launchId,sessionId,method,dummyOnly})),facts,scope:'Real original source child factory + real Pi SDK inside offline Docker; deterministic stream replacement, no host policy/transport integration proved.'}));
