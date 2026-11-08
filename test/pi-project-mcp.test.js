import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execution} from './helpers/agent-sync-fixture.js';
import {openProjectMcp} from '../src/project-mcp.js';

test('actual MCP HTTP calls preserve one effect after a lost response and allow an independent operation',async t=>{
  let starts=0;const jobs=new Map();
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const b of req)chunks.push(b);
    const m=JSON.parse(Buffer.concat(chunks));let result;
    if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'controlled',version:'1'}};
    else if(m.method==='tools/list')result={tools:[{name:'start',inputSchema:{type:'object'}},{name:'status',inputSchema:{type:'object'}}]};
    else if(m.method==='tools/call') {
      if(m.params.name==='start'){starts++;jobs.set(m.params.arguments.id,'completed');if(m.params.arguments.lose){req.socket.destroy();return;}}
      result={content:[{type:'text',text:jobs.get(m.params.arguments.id)??'absent'}],structuredContent:{jobId:m.params.arguments.id,status:jobs.get(m.params.arguments.id)}};
    }
    if(m.id===undefined){res.writeHead(202);res.end();return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  let paused=false;const record={requests:[]};
  const api=await openProjectMcp({connection:{url:`http://127.0.0.1:${server.address().port}/mcp`,trust:'explicit-service-contract',
    tools:{start:{kind:'start',cost:0},status:{kind:'query',cost:0}}},record,save(){},
    authorize(detail){if(paused&&detail.kind!=='query'&&detail.kind!=='close')throw Error('paused');}});
  t.after(()=>api.close());
  await assert.rejects(api.call({tool:'start',args:{id:'original',lose:true},effectKey:'one',requestId:'first'}));
  assert.equal(record.requests.find(r=>r.id==='first').status,'outcome_unknown');
  await assert.rejects(api.call({tool:'start',args:{id:'original',lose:true},effectKey:'one',requestId:'renamed'}),{code:'MCP_EFFECT_UNKNOWN'});
  await assert.rejects(api.call({tool:'start',args:{id:'changed'},effectKey:'one',requestId:'changed'}),{code:'MCP_REPLAY'});
  paused=true;
  const result=await api.query({originalRequestId:'first',tool:'status',args:{id:'original'},requestId:'query'});
  assert.equal(result.structuredContent.status,'completed');
  assert.equal(starts,1);
  paused=false;
  await api.call({tool:'start',args:{id:'independent'},effectKey:'two',requestId:'second'});
  assert.equal(starts,2);
});

for(const readOnly of [false,true])test(`actual command MCP runs in offline container with readOnly=${readOnly}`,{timeout:30000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'cothink-mcp-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const code=join(root,'code'),workspace=join(root,'source');mkdirSync(code);mkdirSync(workspace);writeFileSync(join(workspace,'note.txt'),'original');
  writeFileSync(join(code,'server.mjs'),`import {createInterface} from 'node:readline';import fs from 'node:fs';
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);let result;
      if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'controlled-command',version:'1'}};
      if(m.method==='tools/list')result={tools:['read','write'].map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}))};
      if(m.method==='tools/call'){try{if(m.params.name==='write')fs.writeFileSync('note.txt','actual MCP modification');result={content:[{type:'text',text:fs.readFileSync('note.txt','utf8')}]};}catch(e){result={isError:true,content:[{type:'text',text:e.code}]};}}
      if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const record={requests:[]};
  const api=await openProjectMcp({connection:{execution,codeDirectory:code,workspace,entry:'server.mjs',readOnly,trust:'explicit-service-contract',
    tools:{read:{kind:'read',cost:0},write:{kind:'write',cost:0}}},record,save(){},authorize(){}});
  t.after(()=>api.close());assert.match(JSON.stringify(await api.call({tool:'read',effectKey:'read-one',requestId:'r'})),/original/);
  const result=await api.call({tool:'write',effectKey:'write-one',requestId:'w'});
  assert.equal(!!result.isError,readOnly,'Server readOnlyHint must not substitute for actual OS enforcement');
  assert.equal(readFileSync(join(workspace,'note.txt'),'utf8'),readOnly?'original':'actual MCP modification');
  await api.close();assert.equal(record.status,'stopped');assert.ok(record.stoppedAt);
});

test('cancelling MCP initialization closes the in-flight protocol without waiting for a timeout',async t=>{
  let received;const accepted=new Promise(resolve=>{received=resolve;});
  const server=createServer((_req,_res)=>received());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const controller=new AbortController(),record={requests:[]};
  const pending=openProjectMcp({connection:{url:`http://127.0.0.1:${server.address().port}/mcp`,trust:'explicit-service-contract',tools:{}},record,save(){},authorize(){},signal:controller.signal});
  await accepted;controller.abort();await assert.rejects(pending);assert.equal(record.status,'closed');
});

test('cancelled command initialization returns only after its exact container is stopped',{timeout:30000},async t=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const root=mkdtempSync(join(tmpdir(),'cothink-mcp-cancel-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const code=join(root,'code'),workspace=join(root,'source');mkdirSync(code);mkdirSync(workspace);
  writeFileSync(join(code,'server.mjs'),"import fs from 'node:fs';fs.writeFileSync('started.txt','started');process.stdin.resume();setInterval(()=>{},1000);");
  const controller=new AbortController(),record={requests:[]};
  const pending=openProjectMcp({connection:{execution,codeDirectory:code,workspace,entry:'server.mjs',readOnly:false,trust:'explicit-service-contract',tools:{}},record,save(){},authorize(){},signal:controller.signal});
  for(let i=0;i<500&&!existsSync(join(workspace,'started.txt'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(existsSync(join(workspace,'started.txt')));controller.abort();await assert.rejects(pending);
  assert.equal(record.status,'stopped');assert.ok(record.stoppedAt);
  const {stdout}=await promisify(execFile)('docker',['container','ls','-a','--filter','name=^/'+record.containerId+'$','--format','{{.ID}}']);assert.equal(stdout.trim(),'');
});

test('URL recovery survives pause; cancel acknowledgement does not certify a remote job stopped',async t=>{
  let status='absent',starts=0;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const b of req)chunks.push(b);const m=JSON.parse(Buffer.concat(chunks));let result;
    if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'controlled-job',version:'1'}};
    else if(m.method==='tools/list')result={tools:['start','status','cancel'].map(name=>({name,inputSchema:{type:'object'}}))};
    else if(m.method==='tools/call') {
      if(m.params.name==='start'){starts++;status='running';setTimeout(()=>{status='completed';},60);}
      result={content:[{type:'text',text:m.params.name==='cancel'?'cancel acknowledged':status}],structuredContent:{jobId:'job-1',status:m.params.name==='cancel'?'acknowledged':status}};
    }
    if(m.id===undefined){res.writeHead(202);res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const controller=new AbortController(),record={requests:[]};
  const api=await openProjectMcp({connection:{url:`http://127.0.0.1:${server.address().port}/mcp`,trust:'explicit-service-contract',tools:{start:{kind:'start',cost:null},status:{kind:'query',cost:0},cancel:{kind:'cancel',cost:0}}},record,save(){},authorize(){},signal:controller.signal});t.after(()=>api.close());
  await api.call({tool:'start',args:{id:'job-1'},effectKey:'original',requestId:'original'});controller.abort();
  const ack=await api.query({tool:'cancel',args:{id:'job-1'},originalRequestId:'original',requestId:'cancel'});assert.equal(ack.structuredContent.status,'acknowledged');assert.equal(api.receipt('original').status,'outcome_unknown');
  await new Promise(resolve=>setTimeout(resolve,90));
  const result=await api.query({tool:'status',args:{id:'job-1'},originalRequestId:'original',requestId:'status'});assert.equal(result.structuredContent.status,'completed');assert.equal(starts,1);
  await assert.rejects(api.call({tool:'start',args:{id:'job-2'},effectKey:'new'}),{code:'CANCELLED'});
});
