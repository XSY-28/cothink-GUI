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

test('unused MCP availability cannot block a manager and employee delivering a file',async t=>{
  const {createServer}=await import('node:http');
  const {tool}=await import('./project-policy.fixture.js');
  const {repository,git}=await import('./helpers/git-fixture.js');
  const {fixture}=await import('./helpers/pi-fixture.js');
  const {invoke}=await import('./helpers/cli-fixture.js');
  const {saveConfig}=await import(pathToFileURL(join(root,'src/config.js')));
  let initializations=0,businessCalls=0,main=0,worker=0,memberId,failure;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const message=JSON.parse(Buffer.concat(chunks));let result;
    if(message.method==='initialize'){
      initializations++;res.writeHead(503);res.end('unused service unavailable');return;
    }else if(message.method==='tools/list')result={tools:[{name:'read',inputSchema:{type:'object'}}]};
    else if(message.method==='tools/call'){businessCalls++;result={content:[]};}
    if(message.id===undefined){res.writeHead(202);res.end();return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const repo=repository(t),f=await fixture(t,({body})=>{try{
    if(JSON.stringify(body.messages).includes('cothink-process-observation'))return {text:'{"issues":[]}'};
    const names=(body.tools??[]).map(row=>row.function.name),last=body.messages.findLast(row=>row.role==='tool')?.content??'';
    if(names.includes('accept_change'))switch(++main){
      case 1:return tool('project_staff',{action:'appoint',input:{id:'writer',responsibility:'Correct a.txt',models:['fixture/r1'],scope:['a.txt'],need:'deliverable',reason:'Own the bounded file correction'}});
      case 2:return tool('delegate',{staffId:'writer',model:'fixture/r1',scope:['a.txt'],readScope:['a.txt'],assignment:'Correct base A to checked A in a.txt using ordinary file tools.',reason:'Owns the file correction'});
      case 3:memberId=JSON.parse(last).memberId;assert.ok(memberId,last);return tool('collect',{memberId});
      case 4:assert.match(last,/checked A/);return tool('accept_change',{memberId});
      default:if(JSON.parse(last).status==='review_required')return tool('accept_change',{memberId});return {text:'Checked file delivered.'};
    }
    if(!names.includes('write'))return {text:'I understand the exact a.txt correction and will inspect the authorized file before editing.'};
    return [tool('read',{path:'a.txt'}),tool('edit',{path:'a.txt',edits:[{oldText:'base A',newText:'checked A'}]}),{text:'checked A is ready for creator review.'}][worker++]??{text:'checked A is ready.'};
  }catch(error){failure=error;return {text:'Fixture observed a failure.'};}});
  mkdirSync(join(f.home,'pi'),{recursive:true});writeFileSync(join(f.home,'pi/mcp.json'),JSON.stringify({mcpServers:{optional:{url:`http://127.0.0.1:${server.address().port}/mcp`}}}));
  saveConfig(f.home,{formatVersion:2,...f.models,work:{execution}});
  const plan=join(f.home,'optional-plan.json');writeFileSync(plan,JSON.stringify({goal:'Have the designated employee correct base A to checked A in a.txt using ordinary file tools.',scope:['a.txt'],deliverables:['a.txt'],budget:{maxCalls:14},
    mcp:[{server:'optional',trust:'explicit-service-contract',tools:{read:{kind:'read',target:'optional reference',allowedArguments:[{}]}}}],
    checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='checked A\\n')process.exit(1)"]}]}));
  const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project),state=JSON.parse(run.stdout);

  assert.equal(initializations,0,'neither manager nor employee may connect an unused MCP service');
  assert.equal(businessCalls,0);if(failure)throw failure;
  assert.equal(state.status,'completed',JSON.stringify(state));assert.equal(git(repo.project,'show',state.version+':a.txt'),'checked A');
});

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
  await context.bindSession('session');const definitions=await context.projectTools();await context.beforePrompt({phase:'work'});
  state.rootWorkClaims=[{taskId:m.task.record.id,workId:'a',changeId:m.binding.current.changeId}];
  for(let i=0;i<2;i++)await definitions.find(d=>d.name==='project_mcp_'+i+'_read').execute('read-'+i,{workId:'a',arguments:{}},m.task.signal);
  const runtimes=m.task.record.tools.filter(r=>r.kind==='project_mcp_runtime');assert.equal(runtimes.length,2);
  const originalSave=m.task.save;let injected=false;
  t.after(async()=>{m.task.save=originalSave;for(const r of runtimes)await exec('docker',['rm','-f',r.containerId]).catch(()=>{});});
  m.task.save=()=>{if(!injected&&runtimes[0].status==='stopped'){injected=true;throw Error('Injected first MCP stop receipt failure');}return originalSave();};
  await assert.rejects(work.close());assert.equal(injected,true);
  const {stdout}=await exec('docker',['container','ls','-a','--filter','name=^/'+runtimes[1].containerId+'$','--format','{{.ID}}']);assert.equal(stdout.trim(),'','Second original MCP container must be stopped despite first receipt error');
});

test('PROJECT MCP capability cannot be forged, transferred to another session/actor/schema or widened',()=>{
  const selected={server:'local',trust:'explicit-service-contract',tools:{read:{kind:'read',target:'a.txt',allowedArguments:[{}]},status:{kind:'query',target:'original'}}},binding={projectId:'p',stepId:'s',revision:1,taskId:'t',scope:['a.txt'],mcp:[selected]};
  const state={id:'p',status:'active',budget:{maxCost:null},steps:[{id:'s',revision:1,status:'running',scope:['a.txt'],attempts:[{taskId:'t'}]}]};
  const policy=createProjectPolicy({host:{assertOwned(){},read:()=>structuredClone(state),update:f=>f(state)},binding});
  const spec={server:'local',actor:'main',sessionId:'session',sourceDigest:'source',changeId:'change',inputVersion:'version',registrationVersion:'schema',readOnly:false,scope:['a.txt'],readScope:['a.txt'],localNoNetwork:false};
  const capability=policy.issueMcpCapability(spec),detail={...spec,capability,kind:'read',tool:'read',args:{}};
  policy.admitMcp(detail);
  for(const change of [{capability:{}},{capability:JSON.parse(JSON.stringify(capability))},{actor:'member:other'},{sessionId:'other'},{registrationVersion:'new-schema'},{scope:['.']},{readOnly:true}])assert.throws(()=>policy.admitMcp({...detail,...change}),/authority|changed|owning/i);
  state.status='paused';assert.throws(()=>policy.admitMcp(detail),{code:'PROJECT_PAUSED'});
  assert.throws(()=>policy.admitMcp({...detail,kind:'query',tool:'status',original:{id:'forged'}}),{code:'PROJECT_MCP_RECOVERY'});
});
