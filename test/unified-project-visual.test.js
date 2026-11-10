import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {join} from 'node:path';
import {fixture} from './helpers/pi-fixture.js';
import {repository,git} from './helpers/git-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
import { runProjectTurn } from '../src/project-turn.js';
import {guiFiles,guiFile} from '../src/gui-files.js';
import { confirmProject, projectSession } from "./unified-project.fixture.js";

test('visual delivery reviews the combined version after a later step changes a rendered asset', {timeout:60000}, async t=>{
 const repo=repository(t);
 writeFileSync(join(repo.project,'style.css'),'body {background: blue}');
 git(repo.project,'status','--porcelain');
 git(repo.project,'add','--','style.css');
 git(repo.project,'commit','-m','fixture blue stylesheet');
 const plan={goal:'Render the red version of the page',scope:['index.html','style.css'],
   workRequest:{kind:'html-svg',entry:'index.html',viewport:{width:180,height:120},frameTimesMs:[0]},steps:[
     {id:'layout',dependsOn:[],goal:'Build layout and preview the draft',scope:['index.html'],deliverables:['index.html'],checks:[{command:'node',args:['-e',"require('fs').accessSync('index.html')"]}]},
     {id:'style',dependsOn:['layout'],goal:'Change draft blue styling to red',scope:['style.css'],deliverables:['style.css'],checks:[{command:'node',args:['-e',"if (!require('fs').readFileSync('style.css','utf8').includes('red')) process.exit(1)"]}]},
   ]};
 const callTool=(name,args={})=>({toolCalls:[{name,args}]});
 const steps=[
   callTool('write',{path:'index.html',content:'<!doctype html><link rel="stylesheet" href="style.css"><p>Visual proof</p>'}),
   callTool('preview_html',{entry:'index.html',viewport:{width:180,height:120},frameTimesMs:[0]}),
   callTool('accept_change'),callTool('accept_change'),{text:'Layout implemented and previewed.'},
   callTool('read',{path:'style.css'}),
   callTool('edit',{path:'style.css',edits:[{oldText:'blue',newText:'red'}]}),
   callTool('accept_change'),{text:'The final stylesheet is red.'},
 ];
 const f=await fixture(t,(c,n)=>n===1?callTool('start_work',{action:'start',reason:'Render the page',plan}):
   c.body.tools?.some(tool=>tool.function.name==='submit_visual_review')?callTool('submit_visual_review',{
     verdict:'match',observation:'The page has a red background.',reasons:'The final screenshot shows red.'
   }):steps.shift()??{text:'The red page is ready.'});
 const modelFile=join(f.home,'pi','models.json'),catalog=JSON.parse(readFileSync(modelFile));
 for(const model of catalog.providers.fixture.models)model.input=['text','image'];
 writeFileSync(modelFile,JSON.stringify(catalog));
 const {visualManifest,payloadImageHashes}=await import('../src/visual-preview.js');
 const {resolveDeliveryEvidence}=await import('../src/project-turn.js');
 const base=await projectSession(t,repo,f);
 base.frozenConfig.work.execution={...execution,image:visualManifest().image};
 const source=await runProjectTurn({...base,input:'Make a page with a red background and verify the visual result offline.',budget:{maxCalls:12}});
 assert.ok(source.record.proposal,source.record.error);
 assert.equal(source.record.proposal.stepScheduling,'dependencies-v1');
 const root=await confirmProject(base,source);
 const {projectChatState}=await import('../src/project.js');
 const {state}=await projectChatState(f.home,repo.project);
 assert.equal(root.record.status,'completed',root.record.error??JSON.stringify(state.steps.map(({id,error,status})=>({id,error,status}))));
 const delivery=resolveDeliveryEvidence(f.home,root.record);
 assert.equal(delivery.sources.length,2);
 const earlier=delivery.sources[0].record.work.visualEvidence.find(row=>row.result==='captured');
 assert.ok(earlier,'the layout worker really rendered the old blue page');
 const final=root.record.work.visualEvidence.find(row=>row.review?.verdict==='match');
 assert.ok(final,'the root task owns the final visual check');
 assert.notEqual(earlier.sourceVersion,final.sourceVersion);
 assert.equal(final.sourceVersion,root.record.deliveryRef.version);
 const reviews=f.calls.filter(c=>c.body.tools?.some(tool=>tool.function.name==='submit_visual_review'));
 assert.equal(reviews.length,1,'no mandatory step-level review');
 assert.equal(reviews[0].body.model,'main');
 assert.deepEqual([...payloadImageHashes(reviews[0].body)],[...new Set(final.images.map(row=>row.sha256))]);
 assert.ok(!final.images.some(row=>row.sha256===earlier.images[0].sha256),'the pre-change PNG cannot count for the final check');
 const files=await guiFiles(f.home,root.record);
 assert.match((await guiFile(f.home,root.record,files.items.find(item=>item.name==='style.css').ref)).bytes.toString(),/red/);
});

test('an outbound attempt during the confirmed offline visual interaction retains the exact accepted artifact', {timeout:60000}, async t=>{
 const repo=repository(t);
 const plan={goal:'Build an offline action page',scope:['index.html'],deliverables:['index.html'],
   checks:[{command:'node',args:['-e',"require('fs').accessSync('index.html')"]}],
   workRequest:{kind:'html-svg',entry:'index.html',viewport:{width:180,height:120},frameTimesMs:[500],actions:[{kind:'click',selector:'#start'}]}};
 const html=`<!doctype html><button id="start" onclick="fetch('http://example.invalid/attempt').catch(()=>{})">Start</button>`;
 const replies=[
   {toolCalls:[{name:'start_work',args:{action:'start',reason:'Build offline page',plan}}]},
   {toolCalls:[{name:'write',args:{path:'index.html',content:html}}]},
   {toolCalls:[{name:'accept_change',args:{}}]},
   {text:'The accepted page has a start button.'},
 ];
 const f=await fixture(t,()=>replies.shift()??{text:'An unexpected extra model request.'});
 const modelFile=join(f.home,'pi','models.json'),catalog=JSON.parse(readFileSync(modelFile));
 for(const model of catalog.providers.fixture.models)model.input=['text','image'];
 writeFileSync(modelFile,JSON.stringify(catalog));
 const {visualManifest}=await import('../src/visual-preview.js');
 const {createConversationFolder,requireConversationFileWork}=await import('../src/gui-work.js');
 const workspace={id:null,...createConversationFolder(f.home,realpathSync(repo.root),randomUUID())};
 await requireConversationFileWork(f.home,workspace);
 const base=await projectSession(t,workspace,f);
 base.workspace=workspace;
 base.frozenConfig.work.execution={...execution,image:visualManifest().image};
 const source=await runProjectTurn({...base,input:'Build index.html and show the result after clicking Start. Do not use the network in the artifact.'});
 assert.ok(source.record.proposal,source.record.error);
 const root=await confirmProject(base,source);
 assert.equal(root.record.status,'partial');
 assert.match(root.record.error,/被拦截的网络或浏览器请求/);
 assert.equal(root.record.work.visualEvidence[0].diagnostics.blocked[0],'http://example.invalid/attempt');
 assert.equal(root.record.work.visualEvidence[0].sourceVersion,root.record.deliveryRef.version);
 assert.equal(f.calls.length,4,'runtime rejection needs no visual or synthesis model call');
 assert.equal(existsSync(join(workspace.project,'index.html')),false,'the managed conversation folder remains untouched');
 const files=await guiFiles(f.home,root.record);
 const artifact=files.items.find(item=>item.name==='index.html');
 assert.equal(artifact.ref.version,root.record.deliveryRef.version);
 assert.equal((await guiFile(f.home,root.record,artifact.ref)).bytes.toString(),html);
});
