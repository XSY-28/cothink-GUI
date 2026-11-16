import test from 'node:test';import assert from 'node:assert/strict';
import{readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';
import{fixture}from'./helpers/pi-fixture.js';import{repository,git}from'./helpers/git-fixture.js';
import{execution}from'./helpers/agent-sync-fixture.js';
import{projectSession,confirmProject}from'./unified-project.fixture.js';
import{runProjectTurn,executeConfirmed}from'../src/project-turn.js';
import{readTask}from'../src/task.js';import{projectChatState}from'../src/project.js';
import{inspectFileContinuation}from'../src/project-continuation.js';
import{reserveFileContinuation}from'../src/project-file-confirmation.js';
import{visualManifest,payloadImageHashes}from'../src/visual-preview.js';
const tool=(name,args={})=>({toolCalls:[{name,args}]});
for(const withWorker of [false])test('failed final capture publicly closes its projection; worker='+withWorker,{timeout:120000},async t=>{
 const repo=repository(t);
 const script=`const {chromium}=require('/opt/preview/node_modules/playwright-core');(async()=>{const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/opt/preview/browsers/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell',headless:true,args:['--no-sandbox']});const p=await b.newPage({viewport:{width:210,height:150}});await p.goto('file://'+process.cwd()+'/index.html');const png=await p.screenshot();await b.close();console.error('actual offline page screenshot');process.stdout.write(Buffer.concat([png,Buffer.from("mixed-log")]));})().catch(e=>{console.error(e);process.exitCode=1;});`;
 writeFileSync(join(repo.project,'capture.cjs'),script);git(repo.project,'add','--','capture.cjs');git(repo.project,'commit','-m','fixture capture script');
 const plan={goal:'Render a red page with independently visible final evidence',scope:['index.html'],readScope:['index.html','capture.cjs'],deliverables:['index.html'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('index.html','utf8').includes('red'))process.exit(1)"]}],workRequest:{kind:'html-svg',entry:'index.html',viewport:{width:180,height:120},frameTimesMs:[0]}};
 if(withWorker)plan.collaboration={workers:1};
 let visualCalls=0,implementationCalls=0,workerCalls=0;const wires=[],trace=[];
 const replies=[tool('write',{path:'index.html',content:'<!doctype html><body style="background:red">Final red page</body>'}),tool('accept_change'),tool('accept_change'),{text:'Final red page delivered.'}];
 if(withWorker)replies.splice(1,0,tool('project_staff',{action:'appoint',input:{id:'reader',responsibility:'Inspect implemented HTML',models:['fixture/r2'],scope:['index.html'],readScope:['index.html','capture.cjs'],need:'deliverable',reason:'Independent file observation'}}),tool('delegate',{staffId:'reader',workId:'main:index.html',model:'fixture/r2',assignment:'Inspect the capture script',scope:[],readScope:['index.html','capture.cjs'],readOnly:true,reason:'Required employee'}),tool('collect'));
 const f=await fixture(t,({body},n)=>{
  trace.push(body.messages.findLast(m=>m.role==='tool')?.content);
  const raw=JSON.stringify(body.messages.findLast(m=>m.role==='user')?.content);
  if(raw.includes('cothink-process-observation'))return{text:'{\"issues\":[]}'};
  if(body.model==='r2'){workerCalls++;return raw.includes('Independent task preparation')?{text:'I will read the page source.'}:workerCalls<3?tool('read',{path:'capture.cjs'}):{text:'The HTML has the red background and page text.'};}
  if(n===1)return tool('start_work',{action:'start',reason:'Create page',plan});
  if(body.tools?.some(t=>t.function.name==='submit_visual_review')){visualCalls++;wires.push(body);return tool('submit_visual_review',{verdict:visualCalls===1?'uncertain':'match',observation:'A red page is visible',reasons:visualCalls===1?'Need the explicitly selected extra capture':'New final-version capture shows the requested page'});}
  if(body.tools?.some(t=>t.function.name==='write'))implementationCalls++;
  return replies.shift()??{text:'Final verified red page.'};
 });
 const modelFile=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(modelFile));for(const m of catalog.providers.fixture.models)m.input=['text','image'];writeFileSync(modelFile,JSON.stringify(catalog));
 const base=await projectSession(t,repo,f);base.frozenConfig.work.execution={...execution,image:visualManifest().image};
 const proposal=await runProjectTurn({...base,input:plan.goal,budget:{maxCalls:25}}),first=await confirmProject(base,proposal);
 assert.equal(first.record.status,'partial',first.record.error);assert.equal(visualCalls,1);
 const state=(await projectChatState(f.home,repo.project)).state,beforeSteps=structuredClone(state.steps),oldVisual=structuredClone(state.delivery.visual);
 assert.ok(state.steps.every(s=>s.status==='completed'));assert.equal((await inspectFileContinuation({home:f.home,sourceRootTaskId:first.record.id})).eligible,false);
 const visualRevision={sourceRequestId:state.delivery.visual.requestId,formalVersion:state.version,reason:'Add explicit final-version capture without rebuilding the accepted page',capturePlan:[{script:'capture.cjs',args:[],label:'Full final page'}]};
 const params={home:f.home,sourceRootTaskId:first.record.id,visualRevision};const fact=await inspectFileContinuation(params);
 assert.equal(fact.eligible,true,JSON.stringify(fact.blockers));assert.equal(fact.stepId,null);assert.equal(fact.draft,null);assert.deepEqual(fact.requestIds,[]);
 const options={...params,sessionId:first.record.sessionId,submissionId:'new-visual-evidence',expectedRevision:fact.revision,expectedFormalVersion:fact.formalVersion};
 await assert.rejects(reserveFileContinuation({...options,authorizationSource:{kind:'file_continuation',sourceTaskId:first.record.id,mode:'preauthorized_once'}}),{code:'CONTINUATION_AUTH'});
 const reservation=await reserveFileContinuation({...options,authorizationSource:{kind:'file_continuation',sourceTaskId:first.record.id,mode:'user'}});
 assert.equal(reservation.proposal.action,'resume');await assert.rejects(reserveFileContinuation({...options,visualRevision:{...visualRevision,reason:'changed'},authorizationSource:{kind:'file_continuation',sourceTaskId:first.record.id,mode:'user'}}),{code:'CONTINUATION_AUTH'});
 const priorWorkerCalls=workerCalls,count=implementationCalls,source=readTask(f.home,first.record.id);
 const result=await runProjectTurn({...base,input:source.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,confirmedOperation:{source,reservation,execute:task=>executeConfirmed(task,source,reservation)}});
 assert.equal(result.record.status,'partial');assert.match(result.record.error,/pure PNG/);
 assert.equal(visualCalls,1,'invalid capture must not send another model request');assert.equal(implementationCalls,count);
 const after=(await projectChatState(f.home,repo.project)).state;assert.deepEqual(after.steps,beforeSteps);assert.equal(after.version,state.version);
 const close=after.delivery.visual.projectionClose;assert.equal(close.status,'abandoned');
 const {createVersioning}=await import('../src/versioning.js');const v=await createVersioning({home:f.home,project:repo.project,readOnly:true});
 try{const fact=await v.inspect({changeId:close.changeId});assert.equal(fact.status,'abandoned');assert.ok(['stopped','absent'].includes(fact.executionState));}finally{await v.close();}
 assert.equal(readTask(f.home,first.record.id).work.visualEvidence[0].review.verdict,'uncertain');
});
