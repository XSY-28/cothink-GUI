import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {execution} from './helpers/agent-sync-fixture.js';
import {load,fixtureConversation,submitDraft,seedFixtureConversationRepository} from './helpers/gui-controller-fixture.js';
import {complete,controller} from './unified-gui.fixture.js';
const {startGuiServer}=await load('src/gui-server.js');
const {readTask,readRequests}=await load('src/task.js');

const waitFor=async read=>{for(let i=0;i<500;i++){const value=await read();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('waiting fixture did not reach expected state');};
test('live owned request remains observable through slow stream and manager failure retains file links',{timeout:45000},async t=>{
 const repo=repository(t),ready=Promise.withResolvers(),release=Promise.withResolvers();let output;
 t.after(()=>{release.resolve();output?.destroy();});
 try {
 const plan={goal:'Verify both actual files',scope:['a.txt','b.txt'],steps:['a','b'].map(id=>({id,goal:`Verify ${id}.txt`,scope:[`${id}.txt`],deliverables:[`${id}.txt`],dependsOn:id==='b'?['a']:[],checks:[{command:'node',args:['-e',`require('fs').accessSync('${id}.txt')`]}]}))};
 const f=await fixture(t,async(_,n,req,res)=>{
  if(n===1)return {toolCalls:[{name:'start_work',args:{action:'start',reason:'Verify',plan}}]};
  if(n===2){output=res;ready.resolve();await release.promise;return null;}
  if(n===3)return {text:'Verified file b.txt'};
  if(n===5){res.destroy();return null;}
  return {error:503};
 });
 const c=await controller(t,f,{execution}),session=seedFixtureConversationRepository(repo.project,await fixtureConversation(t,c));
 const source=await submitDraft(c,{sessionId:session.id,input:'Verify the two saved files',budget:{maxCalls:4}});await complete(c,source.taskId);
 const root=await c.action('task.confirmWork',{sessionId:session.id,proposalRef:readTask(f.home,source.taskId).proposalRef,submissionId:randomUUID(),protocolVersion:1});
 await ready.promise;
 const host=await startGuiServer({controller:c,open:false});t.after(()=>host.close());
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(5000);
 await page.addInitScript(id=>sessionStorage.setItem("cothink.session",id),session.id);
 await page.goto(host.url);
 await page.getByLabel("输入问题",{exact:true}).waitFor();

 const reply=page.locator(`article[data-task-id="${root.taskId}"]`);
 await reply.getByRole('button',{name:'查看过程',exact:true}).click();
 const panel=page.getByRole('complementary',{name:'本轮协作'});
 const expand=async()=>{await panel.waitFor();while(await panel.locator('details:not([open]) > summary:visible').count()){await panel.locator('details:not([open]) > summary:visible').first().click();}};
 await panel.getByText(/a · 本轮实际执行/).waitFor();
 await expand();
 const wait=panel.getByText(/等待模型返回/);await wait.waitFor();
 assert.match(await wait.textContent(),/尚未收到响应头或正文数据/);
 const directory=resolve(process.env.COTHINK_UI_SCREENSHOTS??'work/long-task-reliability');mkdirSync(directory,{recursive:true});
 await page.waitForFunction(()=>[...document.querySelectorAll('.field-note')].some(node=>/已等待 [1-9]\d* 秒/.test(node.textContent)));
 await wait.scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,'task-4-wait-no-response.png')});
 output.writeHead(200,{'Content-Type':'text/event-stream'});
 const frame=text=>output.write('data: '+JSON.stringify({id:'slow',object:'chat.completion.chunk',model:'main',choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\n');
 frame('Verified ');
 const first=await waitFor(async()=>{const task=await c.task(root.taskId),child=task.executionTasks.find(x=>x.stepId==='a'),p=child?.messages.at(-1)?.progress;return p?.lastDataAt&&{child,p};});
 await new Promise(r=>setTimeout(r,20));frame('file a.txt');
 const next=await waitFor(async()=>{const child=(await c.task(root.taskId)).executionTasks.find(x=>x.stepId==='a');const progress=child.messages.at(-1).progress;return progress.lastDataAt!==first.p.lastDataAt&&progress;});
 const durable=readRequests(f.home,readTask(f.home,first.child.id)).at(-1);
 assert.notEqual(durable.transport.lastBodyAt,next.lastDataAt,'subsequent stream visibility uses the trusted live child without rewriting the durable request per chunk');
 await page.getByText(/最近收到数据 .* 秒 前/).waitFor();
 await page.screenshot({path:join(directory,'task-4-wait-stream.png')});
 assert.doesNotMatch(JSON.stringify(await c.task(root.taskId)),/fixture-secret|responseHeaders|unterminatedSseTail/);
 output.end('data: '+JSON.stringify({id:'slow',object:'chat.completion.chunk',model:'main',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:5,total_tokens:17}})+'\n\ndata: [DONE]\n\n');release.resolve();
 const partial=await complete(c,root.taskId);assert.equal(partial.status,'partial',partial.error);assert.match(partial.error,/缺少经理终稿/);assert.equal(f.calls.length,4);
 await page.reload();await reply.getByRole('button',{name:'a.txt',exact:false}).waitFor();await reply.getByRole('button',{name:'b.txt',exact:false}).waitFor();
 await reply.getByRole('button',{name:'查看过程',exact:true}).click();await panel.getByText(/a · 本轮实际执行/).waitFor();await panel.locator('.turn-timing').scrollIntoViewIfNeeded();
 await page.screenshot({path:join(directory,'task-4-partial-files.png')});
 await reply.getByRole('button',{name:'b.txt',exact:false}).click();await page.getByText('base B',{exact:false}).waitFor();
 const unknown=await submitDraft(c,{sessionId:session.id,input:'Inspect a request with no confirmed response'});
 assert.equal((await complete(c,unknown.taskId)).status,'outcome_unknown');
 await page.reload();const unknownReply=page.locator(`article[data-task-id="${unknown.taskId}"]`);
 await unknownReply.getByText('请求结果未知，不会自动重发。请查看此条执行记录核对已保存内容。',{exact:true}).waitFor();
 await unknownReply.getByRole('button',{name:'查看过程',exact:true}).click();await panel.getByText(/主模型经理/).waitFor();await expand();
 await page.screenshot({path:join(directory,'task-4-unknown.png')});
 assert.equal(f.calls.length,5);assert.deepEqual(errors,[]);
 } finally {if(output&&!output.writableEnded){if(!output.headersSent)output.writeHead(200,{'Content-Type':'text/event-stream'});output.end('data: [DONE]\n\n');}release.resolve();}
});
