import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {managed,execution} from './helpers/agent-sync-fixture.js';
const root=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('..',import.meta.url)));
const {createPluginWork}=await import(pathToFileURL(join(root,'src/plugin-work.js')));
const {createProjectPolicy}=await import(pathToFileURL(join(root,'src/project-policy.js')));
const exec=promisify(execFile);

test('closing two command MCP services attempts the second stop after the first receipt fails',{timeout:30000},async t=>{
  const m=await managed(t,{execution});const servers={},selections=[];
  for(const name of ['first','second']) {
    const cwd=join(m.home,name);mkdirSync(cwd);
    writeFileSync(join(cwd,'server.mjs'),"import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'read',version:'1'}}:{tools:[{name:'read',inputSchema:{type:'object'}}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});");
    servers[name]={command:'node',args:['server.mjs'],cwd};selections.push({server:name,trust:'explicit-service-contract',tools:{read:{kind:'read',target:'a',allowedArguments:[{}]}}});
  }
  mkdirSync(join(m.home,'pi'),{recursive:true});writeFileSync(join(m.home,'pi/mcp.json'),JSON.stringify({mcpServers:servers}));
  m.task.record.project={projectId:'p',stepId:'s',revision:1,taskId:m.task.record.id,scope:['a.txt','new.txt'],mcp:selections};
  const state={id:'p',status:'active',budget:{maxCalls:null,maxCost:null},steps:[{id:'s',revision:1,status:'running',scope:['a.txt','new.txt'],works:[{id:'a',scope:['a.txt']}],attempts:[{taskId:m.task.record.id}]}]};
  m.task.projectPolicy=createProjectPolicy({host:{read:()=>structuredClone(state),update:fn=>fn(state),assertOwned(){}},binding:m.task.record.project,home:m.home});
  const work=await createPluginWork({task:m.task,versioning:m.v,execution}),context=await work.context({actor:'main',binding:m.binding,assertAllowed(){}});
  await context.bindSession('session');await context.projectTools();const runtimes=m.task.record.tools.filter(r=>r.kind==='project_mcp_runtime');assert.equal(runtimes.length,2);
  const originalSave=m.task.save;let injected=false;
  t.after(async()=>{m.task.save=originalSave;for(const r of runtimes)await exec('docker',['rm','-f',r.containerId]).catch(()=>{});});
  m.task.save=()=>{if(!injected&&runtimes[0].status==='stopped'){injected=true;throw Error('Injected first MCP stop receipt failure');}return originalSave();};
  await assert.rejects(work.close());assert.equal(injected,true);
  const {stdout}=await exec('docker',['container','ls','-a','--filter','name=^/'+runtimes[1].containerId+'$','--format','{{.ID}}']);assert.equal(stdout.trim(),'','Second original MCP container must be stopped despite first receipt error');
});
