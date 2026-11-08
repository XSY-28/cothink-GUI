import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {installProjectNativeModelBridge,collectBufferedNativeStream,projectModelMetadata} from '../src/project-native-model.js';

test('native SDK model bridge binds unique admitted auth paths and returns original canonical evidence without keys',async t=>{
  const root=mkdtempSync(join(tmpdir(),'cothink-native-model-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const actual=[],sent=[];
  const bridge=installProjectNativeModelBridge({ModelRuntime,createStream:createAssistantMessageEventStream,
    async rpc(action,args){sent.push({action,args});const message={role:'assistant',api:'openai-completions',provider:'fixture',model:'main',content:[{type:'text',text:args.launchId}],stopReason:'stop',timestamp:Date.now(),cothinkMessageId:'original-'+args.launchId,usage:{input:12,output:5,cacheRead:0,cacheWrite:0,totalTokens:17,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};return {events:[{type:'done',reason:'stop',message}]};}});
  t.after(()=>bridge.restore());
  for(const launchId of ['first','second']) {
    const agentDir=join(root,launchId);mkdirSync(agentDir);
    bridge.admit({launchId,agentDir,model:{provider:'fixture',id:'main',api:'openai-completions',name:'fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096}});
    assert.equal(existsSync(join(agentDir,'auth.json')),false);
    const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});
    bridge.started({launchId,sessionId:'native-session-'+launchId});
    const out=runtime.streamSimple(runtime.getModel('fixture','main'),{messages:[]},{apiKey:'DO_NOT_FORWARD'});actual.push(out.result());
  }
  const messages=await Promise.all(actual);assert.deepEqual(messages.map(m=>m.cothinkMessageId),['original-first','original-second']);
  assert.equal(JSON.stringify(sent).includes('DO_NOT_FORWARD'),false);assert.equal(new Set(sent.map(s=>s.args.sessionId)).size,2);
  await assert.rejects(ModelRuntime.create({authPath:join(root,'unapproved/auth.json')}),{code:'PROJECT_NATIVE_UNBOUND'});
  bridge.close('first');assert.match(readFileSync(join(root,'first/models.json'),'utf8'),/COTHINK_NO_CREDENTIALS/);
});

test('a modest native response stays within the RPC frame bound regardless of provider chunk count',async()=>{
  const text='x'.repeat(20000),message={role:'assistant',content:[{type:'text',text}],stopReason:'stop',cothinkMessageId:'original-request',timestamp:Date.now()};
  async function* source(){yield {type:'start',partial:{...message,content:[]}};for(let i=0;i<1000;i++)yield {type:'text_delta',delta:'x',partial:message};yield {type:'done',reason:'stop',message};}
  const result=await collectBufferedNativeStream(source());
  assert.ok(Buffer.byteLength(JSON.stringify(result))<8*1024*1024,'Repeated partial snapshots must not turn a 20KB answer into an oversized control frame');
  const stream=createAssistantMessageEventStream();for(const event of result.events)stream.push(event);stream.end();
  const final=await stream.result();assert.equal(final.content[0].text,text);assert.equal(final.cothinkMessageId,'original-request');
});

test('native runtime archives remain distinct when two owners receive the same operation ID',async t=>{
  const {createProjectNativeHost}=await import('../src/project-native-host.js');
  const home=mkdtempSync(join(tmpdir(),'cothink-native-archives-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const task={home,record:{id:'task',tools:[],work:{}},projectPolicy:{admit(){}},save(){}};
  const make=(actor,bytes)=>createProjectNativeHost({task,actor,state:{},getSessionId:()=>actor,guard(){},grant:()=>({}),
    entry:{changeId:'change',readOnly:false,snapshot:{inputVersion:'v1',scope:['a.txt'],readScope:['a.txt']},runtime:{async captureSource(_source,directory){writeFileSync(join(directory,'a.txt'),bytes);}}},
    scan:directory=>({'a.txt':{contentBase64:readFileSync(join(directory,'a.txt')).toString('base64'),mode:'100644'}})});
  const operationId='77777777-7777-7777-7777-777777777777';
  await make('main','FIRST').operation('native.admitOperation',{operationId,parentSessionId:'main',cwd:'/workspace',nativeParams:{async:false}},{});
  const first=task.record.tools[0].cwd;
  await make('member:employee','SECOND').operation('native.admitOperation',{operationId,parentSessionId:'member:employee',cwd:'/workspace',nativeParams:{async:false}},{});
  assert.equal(readFileSync(join(first,'a.txt'),'utf8'),'FIRST');
  assert.equal(readFileSync(join(task.record.tools[1].cwd,'a.txt'),'utf8'),'SECOND');
});

test('container model metadata excludes real endpoints and authentication fields',()=>{
  const value=projectModelMetadata({provider:'fixture',id:'main',api:'openai-completions',reasoning:true,baseUrl:'https://name:PRIVATE_CREDENTIAL@example.invalid/?key=PRIVATE_CREDENTIAL',headers:{authorization:'PRIVATE_CREDENTIAL'},apiKey:'PRIVATE_CREDENTIAL',thinkingLevelMap:{high:'high'}});
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_CREDENTIAL|example[.]invalid/);
  assert.equal(value.baseUrl,'http://cothink.invalid/v1');assert.deepEqual(value.thinkingLevelMap,{high:'high'});
});
