// Thin adapter over Pi's shipped MCP protocol client. The task owns authorization,
// effect identity, budgets and receipt persistence; tool annotations grant nothing.
import {McpClient,StreamableHttpTransport,StdioTransport} from '@earendil-works/pi-mcp';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {realpathSync,readFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {redact} from './storage.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {problem} from './task.js';
const exec=promisify(execFile),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function openProjectMcp({connection,record,save,authorize,signal,discoveryOnly=false}) {
  if(typeof authorize!=='function'||typeof save!=='function'||!record)throw problem('MCP_AUTHORITY','An owning task must authorize and persist MCP operations');
  if(!discoveryOnly&&!['explicit-service-contract','verified-server-readonly'].includes(connection.trust))
    throw problem('MCP_TRUST','MCP requires a confirmed service contract or verified server-side read-only account');
  if(discoveryOnly&&!connection.url)throw problem('MCP_DISCOVERY','Planning discovery only supports configured HTTP services; command services require isolated execution');
  const client=new McpClient({name:'cothink-project',version:'1',requestTimeoutMs:0});
  let transport,current,container,closed=false,paused=false,closing,connected=false;
  const sendContext=new AsyncLocalStorage();
  const abort=()=>{if(!connection.url||!connected)void close().catch(()=>{});};
  client.onError(error=>{record.protocolError=error.message;save();void close().catch(()=>{});});
  record.requests??=[];
  const admit=async detail=>{
    if(closed&&detail.kind!=='close')throw problem('MCP_CLOSED','Connection is closed');
    if(paused&&!['resume','close'].includes(detail.kind))throw problem('MCP_PAUSED','Command service is frozen');
    if(signal?.aborted&&!['query','cancel','close'].includes(detail.kind))throw problem('CANCELLED','MCP owner stopped');
    await authorize({...detail,server:connection.url??record.containerId});
    if(closed&&detail.kind!=='close')throw problem('MCP_CLOSED','Connection closed during authorization');
    if(paused&&!['resume','close'].includes(detail.kind))throw problem('MCP_PAUSED','Service frozen during authorization');
    if(signal?.aborted&&!['query','cancel','close'].includes(detail.kind))throw problem('CANCELLED','Owner stopped during authorization');
  };
  await admit({kind:'connect'});
  if(connection.url) {
    const url=new URL(connection.url);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw problem('MCP_URL','Use an approved HTTP(S) server without credentials in its URL');
    if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw problem('MCP_URL','Remote MCP requires HTTPS');
    record.server=url.href;
    transport=new StreamableHttpTransport({url,headers:connection.headers,openGetStream:false,reconnect:{maxRetries:0},
      fetch:async(input,init)=>{
        if(new URL(typeof input==='string'||input instanceof URL?input:input.url).href!==url.href)throw problem('MCP_URL','MCP target changed');
        const authority=sendContext.getStore()??current?.authority??{kind:closed?'close':'connect'};
        await admit({...authority,transport:true});
        return fetch(input,{...init,redirect:'error'});
      }});
  }else {
    const {execution,codeDirectory,workspace,entry,readOnly=true}=connection;
    if(execution?.engine!=='docker'||execution.network!=='none'||!/^(?:[\w./:-]+@)?sha256:[a-f0-9]{64}$/.test(execution.image??''))throw problem('MCP_ENVIRONMENT','Command MCP requires fixed offline Docker');
    if(!entry||isAbsolute(entry)||entry.split(/[\\/]/).includes('..'))throw problem('MCP_SOURCE','MCP entry must be relative to its selected code directory');
    container='cothink-mcp-'+randomUUID();record.containerId=container;record.status='starting';
    const labels={'cothink.project-mcp.owner':randomUUID(),'cothink.project-mcp.task':record.taskId??'component',
      'cothink.project-mcp.actor':record.parentActorId??'component','cothink.project-mcp.session':record.sessionId??'component',
      'cothink.project-mcp.source':record.sourceDigest??'component'};
    record.creationIntent={name:container,labels,image:execution.image,workspace:realpathSync(workspace),codeDirectory:realpathSync(codeDirectory),readOnly,entry};save();
    const created=await exec('docker',['create','--name',container,...Object.entries(labels).flatMap(([key,value])=>['--label',key+'='+value]),'--pull','never','-i','--network','none','--read-only','--cap-drop','ALL',
      '--security-opt','no-new-privileges','--pids-limit',String(execution.limits?.pids??128),
      '--memory',String(execution.limits?.memoryBytes??536870912),'--cpus',String(execution.limits?.cpus??1),
      '--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--tmpfs','/tmp:rw,nosuid,nodev,size=128m',
      '-e','HOME=/tmp','-v',realpathSync(codeDirectory)+':/server:ro',
      '-v',realpathSync(workspace)+':/workspace'+(readOnly?':ro':''),'-w','/workspace',execution.image,'node','/server/'+entry]);
    const dockerId=created.stdout.trim();if(!/^[a-f0-9]{64}$/.test(dockerId))throw problem('MCP_CONTAINER_ID','Docker did not return an immutable container ID');
    container=dockerId;
    const inspected=JSON.parse((await exec('docker',['inspect',dockerId])).stdout)[0];
    const identity={...record.creationIntent,id:dockerId,imageId:inspected.Image};
    record.commandIdentity={...identity,digest:hash(identity)};save();
    verifyCommandIdentity(inspected,record.commandIdentity);
    transport=new StdioTransport({command:'docker',args:['start','-a','-i',container],inheritEnv:false,
      env:{PATH:process.env.PATH,HOME:process.env.HOME},stderr:'pipe'});
  }
  const originalSend=transport.send.bind(transport);
  transport.send=async(message,options)=>{
    if(discoveryOnly&&message.method==='tools/call')throw problem('MCP_DISCOVERY','Discovery cannot invoke business tools');
    const detail=message.method==='notifications/cancelled'?{...current?.authority,kind:'cancel',protocolCancellation:true,
      original:current?structuredClone(current.entry):null,protocolRequestId:message.params?.requestId}:(current?.authority??{kind:'connect'});
    await admit(detail);
    if(message.method==='tools/call'&&current){current.entry.sent=true;current.entry.protocolRequestId=message.id;save();}
    return sendContext.run(detail,()=>originalSend(message,options));
  };
  async function close() {
    if(closing)return closing;closed=true;
    signal?.removeEventListener('abort',abort);
    closing=(async()=>{try {await client.close();}
    finally {
      if(container) {
        try {await exec('docker',['rm','-f',container]);const {stdout}=await exec('docker',['container','ls','-a','--no-trunc','--filter','id='+container,'--format','{{.ID}}']);
          if(stdout.trim())throw Error('MCP container still exists');record.stoppedAt=new Date().toISOString();record.status='stopped';}
        catch(error){record.status='stop_unknown';record.stopError=error.message;save();throw error;}
      }else record.status='closed';
      save();
    }
    })();return closing;
  }
  signal?.addEventListener('abort',abort,{once:true});
  record.status='connecting';record.connectionIntent={id:randomUUID(),server:connection.url??container};save();
  try {if(signal?.aborted)throw problem('CANCELLED','MCP owner stopped before connect');await client.connect(transport);record.tools=await client.listTools({signal});record.registrationVersion=hash(record.tools);record.status='ready';connected=true;save();}
  catch(error){try{await close();}catch(stopError){error.stopError=stopError.message;}throw error;}
  if(discoveryOnly)return {tools:record.tools,close};
  async function execute({tool,args={},effectKey,requestId=randomUUID(),originalRequestId},query=false) {
    if(record.registrationChanged)throw problem('MCP_REGISTRATION','Service registration changed; a new confirmed binding is required');
    const grant=connection.tools?.[tool];
    if(!grant||!record.tools.some(t=>t.name===tool))throw problem('MCP_TOOL','Tool has no confirmed operation grant');
    if(grant.cost!=null&&(!Number.isFinite(grant.cost)||grant.cost<0))throw problem('MCP_COST_UNKNOWN','Invalid fee bound for this MCP operation');
    if(connection.trust==='verified-server-readonly'&&!['read','query'].includes(grant.kind))throw problem('MCP_READONLY','Server account only permits reads');
    const original=query?record.requests.find(r=>r.id===originalRequestId):null;
    if(query&&(!original||!['query','cancel'].includes(grant.kind)))throw problem('MCP_QUERY','Recovery requires an original receipt and a confirmed status/cancel tool');
    if(!query&&['query','cancel'].includes(grant.kind))throw problem('MCP_QUERY','Use the original-operation recovery interface');
    const authority={kind:grant.kind,tool,args,requestId,effectKey,cost:grant.cost??null,registrationVersion:record.registrationVersion,
      ...(original?{original:structuredClone(original)}:{})};
    await admit(authority);
    const prior=record.requests.find(r=>r.id===requestId||(!query&&effectKey&&r.effectKey===effectKey));
    if(prior) {
      if(prior.payloadDigest!==hash({tool,args}))throw problem('MCP_REPLAY','Original effect parameters cannot be changed under a new request name');
      if(prior.status==='completed')return structuredClone(prior.result);
      throw problem('MCP_EFFECT_UNKNOWN','Original operation is unresolved; query its receipt, never resend');
    }
    if(current)throw problem('MCP_BUSY','An operation still owns this service connection');
    if(!query&&!effectKey)throw problem('MCP_EFFECT','A stable authorized effect identity is required');
    const entry={id:requestId,tool,args:structuredClone(args),effectKey,originalRequestId,registrationVersion:record.registrationVersion,
      payloadDigest:hash({tool,args}),status:'pending',sent:false};
    record.requests.push(entry);save();current={entry,authority};
    try {
      const latest=await client.listTools({signal:query?undefined:signal,timeoutMs:0});
      const observedVersion=hash(latest);
      if(observedVersion!==record.registrationVersion) {
        record.registrationChanged=true;record.observedTools=latest;record.observedRegistrationVersion=observedVersion;save();
        throw problem('MCP_REGISTRATION','Service tool schemas changed before invocation; old approval is not reused');
      }
      entry.result=await client.callTool(tool,args,{signal:query?undefined:signal,timeoutMs:0});
      entry.status=grant.kind==='start'?'outcome_unknown':'completed';entry.jobId=entry.result.structuredContent?.jobId??null;
      if(grant.kind==='start')entry.acknowledgedAt=new Date().toISOString();
      entry.completedAt=new Date().toISOString();save();return entry.result;
    }catch(error){entry.status=entry.sent?'outcome_unknown':'not_sent';entry.error={code:error.code,message:error.message};save();throw error;}
    finally{current=null;}
  }
  return {tools:record.tools,call:args=>execute(args),query:args=>execute(args,true),
    async freeze(){if(!container)throw problem('MCP_REMOTE','Local freezing cannot stop a remote service');if(paused)return;
      await exec('docker',['pause',container]);const {stdout}=await exec('docker',['inspect','--format','{{.State.Paused}}',container]);
      if(stdout.trim()!=='true')throw problem('MCP_STOP_UNKNOWN','MCP writers were not frozen');paused=true;record.status='frozen';save();},
    async resume(){if(!container)throw problem('MCP_REMOTE','No controlled local process');await admit({kind:'resume'});if(!paused)return;await exec('docker',['unpause',container]);paused=false;record.status='ready';save();},
    receipt:id=>structuredClone(record.requests.find(r=>r.id===id)??null),close};
}


function verifyCommandIdentity(actual,proof) {
  const matches=(destination,source,writable)=>actual.Mounts?.filter(m=>m.Type==='bind'&&m.Destination===destination).length===1&&actual.Mounts.some(m=>m.Type==='bind'&&m.Destination===destination&&m.Source===source&&m.RW===writable);
  if(actual.Id!==proof.id||actual.Name!=='/'+proof.name||actual.Config?.Image!==proof.image||actual.Image!==proof.imageId||
    actual.HostConfig?.NetworkMode!=='none'||actual.HostConfig?.ReadonlyRootfs!==true||
    !Object.entries(proof.labels).every(([key,value])=>actual.Config?.Labels?.[key]===value)||
    !matches('/workspace',proof.workspace,!proof.readOnly)||!matches('/server',proof.codeDirectory,false)||
    actual.Mounts.filter(m=>m.Type==='bind').length!==2||JSON.stringify(actual.Config?.Cmd)!==JSON.stringify(['node','/server/'+proof.entry]))
    throw problem('MCP_CONTAINER_IDENTITY','Original Docker identity, labels, image or source bindings differ; no process was stopped');
}

// This branch observes/stops one historically owned cgroup; it never reconnects
// MCP, starts a server, unpauses writers or claims a remote job terminal state.
export async function recoverProjectMcpCommand({record,save,authorize,stop=false}) {
  const proof=record.commandIdentity;
  if(!proof||!/^[a-f0-9]{64}$/.test(proof.id??'')||proof.name!==record.containerId)throw problem('MCP_CONTAINER_IDENTITY','Original runtime lacks adequate immutable container creation evidence; outcome remains unknown');
  const {digest,...identity}=proof;
  if(hash(identity)!==digest)throw problem('MCP_CONTAINER_IDENTITY','Original container identity evidence changed; outcome remains unknown');
  const admit=()=>authorize({kind:stop?'cancel':'query',localProcessCleanup:true,containerProofDigest:digest,containerId:proof.id});
  await admit();
  let actual;
  try{actual=JSON.parse((await exec('docker',['inspect',proof.id])).stdout)[0];}
  catch(error){if(!/No such (?:object|container)/i.test(error.stderr??''))throw error;}
  if(actual)verifyCommandIdentity(actual,proof);
  const observation={containerId:proof.id,containerName:proof.name,identityVerified:true,localState:actual?.State?.Status??'absent',
    running:actual?.State?.Running??false,paused:actual?.State?.Paused??false,jobOutcome:'unknown',serviceQueryPerformed:false,
    explanation:'Docker process observation only; paused MCP business status is unavailable without resuming writers',at:new Date().toISOString()};
  record.processObservation=observation;save();
  if(stop&&actual){
    await admit();await exec('docker',['rm','-f',proof.id]);
    const {stdout}=await exec('docker',['container','ls','-a','--no-trunc','--filter','id='+proof.id,'--format','{{.ID}}']);
    if(stdout.trim())throw problem('MCP_STOP_UNKNOWN','Original immutable container ID still exists after removal');
    observation.localState='absent';observation.running=false;observation.paused=false;
  }
  if(!actual||stop){record.stoppedAt??=new Date().toISOString();record.status='stopped';observation.stoppedVerified=true;}
  save();return observation;
}

export function scrubMcpOutput(value,secrets) {
  if(!value||typeof value!=="object")return;
  for(const key of Object.keys(value)) {
    if(typeof value[key]==="string")value[key]=redact(value[key],secrets);
    else scrubMcpOutput(value[key],secrets);
  }
}
function mcpConfiguration(home) {
  try {const data=JSON.parse(readFileSync(join(home,'pi','mcp.json'),'utf8'));if(!data.mcpServers||typeof data.mcpServers!=='object'||Array.isArray(data.mcpServers))throw Error();return data.mcpServers;}
  catch(error){if(error.code==='ENOENT')return null;throw problem('PROJECT_MCP_CONFIG','Cannot read valid server configuration from COTHINK_HOME/pi/mcp.json');}
}
/** Local names and transport readiness only: never expose connection targets or credentials. */
export function projectMcpSummary(home) {
  try {const servers=mcpConfiguration(home);return {status:servers?'configured':'not_configured',servers:Object.entries(servers??{}).map(([server,config])=>({server,transport:config?.url?'http':config?.command?'stdio':'unknown',status:config?.disabled?'disabled':config?.url?'configured':config?.command?'requires_isolated_execution':'unsupported'}))};}
  catch(error){return {status:'invalid_configuration',servers:[],message:error.message};}
}
/** Explicit HTTP registration discovery uses the same Pi connection lifecycle as execution. */
export async function discoverProjectMcp({home,server,signal}) {
  const base={server,untrusted:true,executionAuthorized:false};let api,secrets=[];
  try {
    const config=mcpConfiguration(home)?.[server];
    if(!config)return {...base,status:'not_configured',message:'No configured MCP service has this name'};
    if(config.disabled)return {...base,status:'disabled',message:'The configured MCP service is disabled'};
    if(!config.url)return {...base,status:config.command?'requires_isolated_execution':'unsupported',message:'Command services are discovered only through the existing authorized isolated execution path; planning never starts them'};
    const source=projectMcpHttpConfig(projectMcpServerConfig(home,server),{server,trust:null,tools:{}});secrets=source.secrets;
    api=await openProjectMcp({connection:source.connection,discoveryOnly:true,record:{requests:[]},save(){},signal,
      authorize(detail){if(!['connect','close'].includes(detail.kind))throw problem('MCP_DISCOVERY','Only registration discovery is authorized');}});
    const tools=api.tools.map(({name,description,inputSchema})=>({name,...(description?{description}:{}),inputSchema}));
    // Redacting a schema key could change its meaning or collide with another key.
    // Refuse that registration rather than leak credentials or advertise altered arguments.
    const pending=[tools];
    while(pending.length){const value=pending.pop();if(!value||typeof value!=='object')continue;
      for(const [key,item]of Object.entries(value)){if(redact(key,secrets)!==key)throw problem('PROJECT_MCP_REGISTRATION_SECRET','Service registration contains credentials in field names; discovery was withheld');pending.push(item);}}
    scrubMcpOutput(tools,secrets);
    await api.close();api=null;return {...base,status:'discovered',tools};
  }catch(error){return {...base,status:error.code==='PROJECT_MCP_UNSUPPORTED'?'unsupported':'discovery_failed',message:redact(error.message,secrets)};}
  finally{try{await api?.close();}catch{/* A discovery failure reports unavailable registration, never execution success. */}}
}
export function projectMcpServerConfig(home,server) {
  const config=mcpConfiguration(home)?.[server];
  if(config?.disabled===true)throw problem('PROJECT_MCP_CONFIG','Selected MCP server is disabled');
  if(!config)throw problem('PROJECT_MCP_CONFIG','MCP server is absent from COTHINK_HOME/pi/mcp.json: '+server);
  if(config.oauth||config.auth||config.env||config.envFile)throw problem('PROJECT_MCP_UNSUPPORTED','OAuth, command environment credentials and automatic account discovery are not adapted');
  return config;
}
export function projectMcpHttpConfig(config,selection) {
  const safe={server:selection.server,trust:selection.trust,tools:selection.tools};
  if(config.type&&!['http','streamable-http'].includes(config.type)||config.transport&&!['http','streamable-http'].includes(config.transport))throw problem('PROJECT_MCP_UNSUPPORTED','Only Streamable HTTP is adapted; legacy SSE and account/OAuth transports are not');
  const url=new URL(config.url);
  if(url.username||url.password||url.search||url.hash)throw problem('PROJECT_MCP_SECRET','Use fixed MCP URL without embedded credential/query/fragment');
  if(config.command||config.args)throw problem('PROJECT_MCP_CONFIG','Select one MCP transport');
  return {selection,secrets:Object.values(config.headers??{}).filter(v=>typeof v==='string'&&v).flatMap(v=>[v,...(/^(?:Bearer|Basic)\s+(.+)$/i.exec(v)?.slice(1)??[])]),connection:{url:url.href,headers:config.headers,trust:selection.trust},digest:hash({...safe,url:url.href,credentialDigest:hash(config.headers??{})})};
}
