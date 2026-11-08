// Runs only in the offline PROJECT container. Actual extension factories and callbacks
// stay here; the host sees data and rechecks its own authority for every host request.
import {createInterface} from 'node:readline';
import {mkdirSync} from 'node:fs';
import {createNativeWorker} from '/trusted/project-native-worker.js';
import {randomUUID,createHash} from 'node:crypto';
import {Console} from 'node:console';
import {AsyncLocalStorage} from 'node:async_hooks';

const write=process.stdout.write.bind(process.stdout);
globalThis.console=new Console(process.stderr,process.stderr);
process.stdout.write=process.stderr.write.bind(process.stderr);
const send=message=>write(JSON.stringify(message)+'\n');
const pending=new Map(),operationScope=new AsyncLocalStorage();
const operation=(action,args,options={})=>new Promise((resolve,reject)=>{const id=randomUUID(),parentRequestId=operationScope.getStore()?.requestId;
  if(!parentRequestId&&!options.nativeHandle)return reject(Error('Host operation has no owning request'));
  pending.set(id,{resolve,reject});send({type:'operation',id,parentRequestId,action,args,...(options.nativeHandle?{nativeHandle:options.nativeHandle}:{})});});
// Pi's message APIs are synchronous void APIs. Persisted host receipts carry their
// failures; consume the local promise so a denied late callback is not an unhandled rejection.
const messageOperation=(action,args)=>{void (native?native.message(action,args):operation(action,args)).catch(error=>console.error(action+': '+error.message));};
const unsupported=name=>{throw Object.assign(Error('Unadapted PROJECT API: '+name),{code:'PROJECT_PLUGIN_UNSUPPORTED'});};
mkdirSync('/tmp/home',{recursive:true});
let loaded,runner,active=[],session,sourceDigest,buildSystemPrompt,native;
const inNative=callback=>native?native.run(callback):callback();
function tools(){return loaded.extensions.flatMap(e=>[...e.tools.values()].map(t=>t.definition));}
const schema=registration=>({...registration,tools:registration.tools.map(({name,parameters})=>({name,parameters})),commands:registration.commands.map(({name})=>({name}))});
function registration(){return {tools:tools().map(({name,label,description,parameters})=>({name,label,description,parameters})),
  commands:loaded.extensions.flatMap(e=>[...e.commands].map(([name,c])=>({name,description:c.description}))),
  handlers:[...new Set(loaded.extensions.flatMap(e=>[...e.handlers.keys()]))].sort()};}
async function event(value){
  if(native){const original=message=>message?.details?.nativeNotification?{...message,customType:message.details.nativeNotification.customType,content:message.details.nativeNotification.content}:message;value={...value,...(value?.message?{message:original(value.message)}:{}),...(value?.context?{context:{...value.context,...(Array.isArray(value.context.contextMessages)?{contextMessages:value.context.contextMessages.map(original)}:{})}}:{})};}
  if(value?.type==='before_agent_start') {
    const {systemPrompt,systemPromptOptions,...trigger}=value;
    const result=await runner.emitBeforeAgentStart(trigger,systemPromptOptions??{cwd:'/workspace',forceSystemPrompt:systemPrompt??''});
    return {...result,systemPrompt:buildSystemPrompt(result.systemPromptOptions)};
  }
  if(value?.type==='message_end') {
    const replacement=await runner.emitMessageEnd(value);
    if(replacement)unsupported('message_end replacement');
    return null;
  }
  if(['turn_end','agent_before_settle'].includes(value?.type)) {
    const result=await runner.emitBoundary(value,async entries=>{if(entries.length){if(!native||entries.some(entry=>entry.type!=='custom_message'))unsupported('boundary entries');for(const entry of entries)await operation('sendMessage',{message:{customType:entry.customType,content:entry.content,display:entry.display},options:{triggerTurn:true,deliverAs:'followUp'}});}return value.context??{messages:[]};});
    if(result?.continue&&!native)unsupported('boundary continuation');
    return null;
  }
  if(['input','context','tool_call','tool_result'].includes(value?.type))unsupported('transform event '+value.type);
  return runner.emit(value);
}
async function dispatch(action,args) {
  if(action==='load') {
    sourceDigest=args.sourceDigest;
    const base='/runtime/node_modules/@earendil-works/pi-coding-agent/dist/';
    const sdk=await import(base+'index.js');
    const {DefaultResourceLoader,SettingsManager,ExtensionRunner,SessionManager}=sdk;
    ({buildSystemPrompt}=await import(base+'core/system-prompt.js'));
    session=SessionManager.inMemory('/workspace');
    if(args.native){session.getSessionId=()=>args.native.sessionId;native=await createNativeWorker({rpc:operation,sessionId:args.native.sessionId,models:args.native.models,agents:args.native.agents});}
    const loader=new DefaultResourceLoader({cwd:'/workspace',agentDir:'/tmp/pi',
      settingsManager:SettingsManager.inMemory({}),noExtensions:true,noSkills:true,
      noPromptTemplates:true,noThemes:true,noContextFiles:true,
      ...(args.native?{additionalExtensionPaths:[],extensionFactories:await Promise.all(args.extensions.map(async path=>({name:'native:'+path,factory:(await import(path)).default})))}:{additionalExtensionPaths:args.extensions})});
    await inNative(()=>loader.reload());loaded=loader.getExtensions();
    if(loaded.errors.length)throw Error(loaded.errors.map(e=>e.error).join('\n'));
    runner=new ExtensionRunner(loaded.extensions,loaded.runtime,'/workspace',session,{
      getAvailable:()=>args.native?.models??[],getAll:()=>args.native?.models??[],getRegisteredProviderIds:()=>[],getRegisteredProviderConfig:()=>undefined,getRegisteredNativeProvider:()=>undefined,getApiKey:()=>unsupported('raw model credential'),
      registerProvider:()=>unsupported('registerProvider'),registerNativeProvider:()=>unsupported('registerNativeProvider')});
    runner.onError(error=>{throw Error(error.error);});
    active=tools().map(t=>t.name);
    runner.bindCore({
      sendMessage:(message,options)=>messageOperation('sendMessage',{message,options}),
      sendUserMessage:(message,options)=>messageOperation('sendUserMessage',{message,options}),
      appendEntry:(type,data)=>session.appendCustomEntry(type,data),
      setSessionName:name=>session.appendSessionInfo(name),getSessionName:()=>session.getSessionName(),
      setLabel:(id,label)=>session.appendLabelChange(id,label),
      getActiveTools:()=>active,getAllTools:()=>tools().map(({name,description,parameters})=>({name,description,parameters})),
      getSettings:()=>({}),setActiveTools:names=>{active=names;},refreshTools:()=>{},
      getCommands:()=>loaded.extensions.flatMap(e=>[...e.commands].map(([name,c])=>({name,description:c.description}))),
      setModel:()=>unsupported('setModel'),getThinkingLevel:()=>undefined,setThinkingLevel:()=>unsupported('setThinkingLevel'),
    },{getModel:()=>args.native?.model,getScopedModels:()=>args.native?.models??[],isIdle:()=>true,isProjectTrusted:()=>false,getSignal:()=>undefined,
      abort:()=>operation('abort',{}),hasPendingMessages:()=>false,shutdown:()=>operation('shutdown',{}),
      getContextUsage:()=>undefined,compact:()=>unsupported('compact'),getSystemPrompt:()=>'',
      executeTool:(toolCallId,name,args,options)=>operation('executeTool',{toolCallId,name,args,options})});
    const ui=Object.fromEntries(['notify','select','input','confirm'].map(key=>[key,(...args)=>operation('ui.'+key,args)]));
    ui.notify=(...args)=>messageOperation('ui.notify',args);
    for(const name of ['custom','editor','setStatus','setWidget','setFooter','setHeader','setTitle','setEditorText','getEditorText','setEditorComponent'])ui[name]=()=>unsupported('ui.'+name);
    runner.setUIContext(ui,'rpc');
    runner.hasUI=()=>args.uiAvailable===true;
    await inNative(()=>event({type:'session_start',reason:'new'}));
    return registration();
  }
  if(!runner)throw Error('Runtime not initialized');
  const currentVersion=createHash('sha256').update(JSON.stringify({sourceDigest,registration:schema(registration())})).digest('hex');
  if(args.registrationVersion!==currentVersion)throw Object.assign(Error('Plugin registration changed; reconcile the new registry before execution'),{code:'PROJECT_PLUGIN_REGISTRATION'});
  if(action==='event')return event(args.event);
  if(action==='command') {
    const command=loaded.extensions.flatMap(e=>[...e.commands]).find(([name])=>name===args.command)?.[1];
    if(!command)throw Error('Unknown command');
    const context=runner.createCommandContext();
    for(const key of ['newSession','fork','navigateTree','switchSession','reload','shutdown'])context[key]=()=>unsupported('command.'+key);
    await command.handler(args.args,context);return null;
  }
  if(action==='tool') {
    const tool=tools().find(t=>t.name===args.tool);if(!tool||!active.includes(tool.name))throw Error('Unknown or inactive tool');
    const id=randomUUID();const before=await runner.emitToolCall({type:'tool_call',toolCallId:id,toolName:tool.name,input:args.args});
    if(before?.block)throw Error(before.reason??'Tool blocked by extension');
    const signal=new AbortController().signal;
    const result=await tool.execute(id,args.args,signal,undefined,runner.createToolContext(id,signal));
    const after=await runner.emitToolResult({type:'tool_result',toolCallId:id,toolName:tool.name,input:args.args,...result,isError:!!result.isError});
    return {...result,...after};
  }
  throw Error('Unknown request action');
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
let queue=Promise.resolve();
input.on('line',line=>{
  if(Buffer.byteLength(line)>8*1024*1024)process.exit(2);
  let message;try{message=JSON.parse(line);}catch{process.exit(2);}
  if(message.type==='response') {
    const p=pending.get(message.id);if(!p)process.exit(2);pending.delete(message.id);
    message.error?p.reject(Object.assign(Error(message.error.message),message.error)):p.resolve(message.value);return;
  }
  if(message.type!=='request'||typeof message.id!=='string')process.exit(2);
  queue=queue.then(()=>operationScope.run({requestId:message.id},async()=>{try{const value=await inNative(()=>dispatch(message.action,message.args));send({type:'response',id:message.id,value,...(loaded?{registration:registration()}:{})});}
    catch(error){send({type:'response',id:message.id,error:{code:error.code,message:error.message},...(loaded?{registration:registration()}:{})});}}));
});
input.on('close',()=>process.exit(0));
