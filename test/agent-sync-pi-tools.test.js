import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, cpSync } from "node:fs";
import {execFileSync} from "node:child_process";
import { join } from "node:path";
import { managed, execution } from "./helpers/agent-sync-fixture.js";
for(const name of ["bash","write","edit"])test(`a rejected ${name} replay cannot erase previous kernel dispatch evidence`, async t => {
  const f=await managed(t,{scope:["a.txt"],execution});
  let denied=false,attempts=0;
  await f.call("read","basis",{path:"a.txt"});
  const method=name==="bash"?"exec":"edit",original=f.v[method];t.after(()=>{f.v[method]=original;});
  f.v[method]=async()=>{attempts++;throw Error("kernel reply lost");};
  f.task.projectPolicy={admit:(_action,detail)=>{if(denied&&detail.commit)throw Error("scope changed");}};
  const args=name==="bash"?{command:"node -e '0'"}:name==="write"?{path:"a.txt",content:"edited"}:{path:"a.txt",edits:[{oldText:"base A",newText:"edited"}]};
  const invoke=()=>f.call(name,"same-call",args);
  await assert.rejects(invoke(),/kernel reply lost/);
  const trace=f.task.record.tools.at(-1);
  assert.equal(trace.kernelDispatched,true);
  denied=true;
  for(const marker of [true,undefined]){
    trace.kernelDispatched=marker;
    await assert.rejects(invoke(),/scope changed/);
    assert.equal(trace.kernelDispatched,marker,"a later denial cannot prove the original was unsent");
  }
  assert.equal(attempts,1);
});
test("A04 native file operations require actual reads and atomically advance private tree", async (t) => {
  const f = await managed(t);
  await assert.rejects(
    f.call("write", "blind", { path: "a.txt", content: "blind" }),
    { code: "NEED_READ" },
  );
  await f.call("read", "read-a", { path: "a.txt" });
  await f.call("write", "write-a", { path: "a.txt", content: "old" });
  await f.call("edit", "edit-a", {
    path: "a.txt",
    edits: [{ oldText: "old", newText: "edited" }],
  });
  assert.equal(
    Buffer.from(
      (await f.v.read({ changeId: f.binding.current.changeId, path: "a.txt" }))
        .contentBase64,
      "base64",
    ).toString(),
    "edited",
  );
  assert.equal(readFileSync(join(f.project, "a.txt"), "utf8"), "base A\n");
  assert.ok(f.task.record.tools.every((x) => x.requestId));
});
test("A04 tool definitions resolve current change on every call; no stale cwd or shared oldHash", async (t) => {
  const f = await managed(t);
  await f.call("write", "new1", { path: "new.txt", content: "first" });
  const old = f.binding.current;
  await f.v.abandonChange(old.changeId, { requestId: "abandon" });
  f.binding.current = await f.v.beginChange({
    requestId: "second",
    actor: "main",
    intent: "second",
    scope: ["new.txt"],
  });
  await f.call("write", "new2", { path: "new.txt", content: "second" });
  assert.equal(readFileSync(join(old.workspace, "new.txt"), "utf8"), "first");
  assert.equal(
    readFileSync(join(f.binding.current.workspace, "new.txt"), "utf8"),
    "second",
  );
});
test("A04 directory/search tools use scoped snapshot and capture negative search basis", async (t) => {
  const f = await managed(t, { scope: ["new.txt"], readScope: ["a.txt"] });
  const ls = await f.call("ls", "ls", { path: "." });
  assert.match(JSON.stringify(ls), /a.txt/);
  assert.doesNotMatch(JSON.stringify(ls), /b.txt/);
  const sdk=join(f.home,'sdk'),bin=join(sdk,'bin');mkdirSync(bin,{recursive:true});
  cpSync(execFileSync('which',['rg'],{encoding:'utf8'}).trim(),join(bin,'rg'));
  const previous={PATH:process.env.PATH,PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR};
  try {
    process.env.PATH='/usr/bin:/bin';process.env.PI_CODING_AGENT_DIR=sdk;
    const grep = await f.call("grep", "grep", { pattern: "NO_MATCH", path: "." });
    assert.match(JSON.stringify(grep), /No matches|无匹配/);
    const matched=await f.call('grep','positive',{pattern:'^BASE [A-Z]',ignoreCase:true,path:'.'});
    assert.match(JSON.stringify(matched),/base A/);assert.doesNotMatch(JSON.stringify(matched),/base B/);
    const found=await f.call('find','find',{pattern:'*.txt',path:'.'});
    assert.match(JSON.stringify(found),/a.txt/);assert.doesNotMatch(JSON.stringify(found),/b.txt/);
  } finally {
    for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  await assert.rejects(
    f.call("read", "escape", { path: join(f.project, "b.txt") }),
  );
  await f.call("write", "create", { path: "new.txt", content: "new" });
  const p = await f.v.prepareChange(f.binding.current.changeId, {
    requestId: "prepare",
  });
  assert.ok(Object.keys(p.candidates.at(-1).basis).length);
});
test("A04 real Docker Shell exit, seconds conversion and full Unicode logs are correctly bridged", async (t) => {
  const f = await managed(t, { scope: ["a.txt"], execution });
  const r = await f.call("bash", "bash", {
    command: "printf changed > a.txt; printf warning >&2; exit 7",
    timeout: 1.5,
  });
  assert.equal(r.structuredContent.exit_code, 7);
  assert.equal(r.isError, true);
  assert.equal(f.task.record.tools.at(-1).timeoutMs, 1500);
  const large = await f.call("bash", "large", {
    command:
      "node -e \"for(let i=0;i<3500;i++)console.log('第'+i+'行 Unicode 正文')\"",
  });
  const ref = large.details.fullOutputPath;
  assert.match(ref, /^output:/);
  const page = await f.call("read", "log", {
    path: ref,
    offset: 3000,
    limit: 2,
  });
  assert.match(JSON.stringify(page), /第2999行/);
  assert.doesNotMatch(JSON.stringify(page), /�/);
  assert.equal(readFileSync(join(f.project, "a.txt"), "utf8"), "base A\n");
  await assert.rejects(
    f.call("write", "log-write", { path: ref, content: "bad" }),
  );
  await assert.rejects(
    f.call("read", "other-log", { path: "output:not-from-this-task" }),
  );
});


test('an owned binary command output is readable as an image without adding a source file',async t=>{
 const f=await managed(t,{scope:['new.txt'],execution});
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC';
 const out=await f.call('bash','image-output',{command:`node -e "process.stdout.write(Buffer.from('${png}','base64'))"`});
 assert.doesNotMatch(out.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'),/[\uFFFD\u0000]/,'binary bytes must not become model text');
 const ref=out.details.agentSync.outputRef;
 const raw=await f.v.read({outputRef:ref});assert.equal(raw.contentBase64,png);
 const image=await f.call('read','read-image-output',{path:'output:'+ref});
 assert.ok(image.content.some(part=>part.type==='image'&&part.mimeType==='image/png'),JSON.stringify(image.content.map(({data,...part})=>({...part,dataBytes:data?.length}))));
 assert.deepEqual(out.details.agentSync.changedFiles,[]);
 const mixed=await f.call('bash','mixed-image',{command:`node -e "process.stdout.write('diagnostic\\n');process.stdout.write(Buffer.from('${png}','base64'));process.exitCode=7"`});
 assert.equal(mixed.structuredContent.exit_code,7);assert.equal(mixed.isError,true);
 assert.doesNotMatch(mixed.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'),/[\uFFFD\u0000]/);
 const mixedRef=mixed.details.agentSync.outputRef,rawMixed=await f.v.read({outputRef:mixedRef});
 assert.deepEqual(Buffer.from(rawMixed.contentBase64,'base64'),Buffer.concat([Buffer.from('diagnostic\n'),Buffer.from(png,'base64')]));
 const mixedRead=await f.call('read','read-mixed-image',{path:'output:'+mixedRef});
 assert.doesNotMatch(mixedRead.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'),/[\uFFFD\u0000]/);
 assert.match(JSON.stringify(mixedRead),new RegExp(mixedRef));
 assert.ok(!mixedRead.content.some(p=>p.type==='image'),'mixed log is not a valid image');
 const text=await f.call('bash','valid-replacement',{command:"node -e \"process.stdout.write('有效文本 �')\""});
 assert.match(text.content.map(p=>p.text).join(''),/有效文本 �/,'a valid literal replacement character is still text');
 assert.doesNotMatch(out.structuredContent.output,/[\uFFFD\u0000]/);
 assert.doesNotMatch(mixed.structuredContent.output,/[\uFFFD\u0000]/);
 await assert.rejects(f.call('read','foreign-output',{path:'output:another-task'}),{code:'OUTPUT_SCOPE'});
});

for(const name of ['write','edit'])test(`${name} denied before kernel dispatch leaves no ambiguous mutation`,async t=>{
 const f=await managed(t,{scope:['a.txt'],execution});
 await f.call('read','read-basis',{path:'a.txt'});
 f.task.projectPolicy={admit:(_action,detail)=>{if(detail.commit)throw Error('the registered work boundary refuses this write');}};
 const args=name==='write'?{path:'a.txt',content:'not applied'}:{path:'a.txt',edits:[{oldText:'base A',newText:'not applied'}]};
 await assert.rejects(f.call(name,'denied',args),/registered work boundary/);
 const trace=f.task.record.tools.at(-1);assert.equal(trace.kernelDispatched,false);assert.ok(trace.kernelInput);
 assert.equal((await f.v.inspect({requestId:trace.requestId})).status,'not_found');
 const {executionFacts}=await import('../src/project-delivery-checks.js');
 const facts=await executionFacts(f.v,f.task.record,[]);
 assert.ok(facts.kernelRequests.some(r=>r.requestId===trace.requestId&&r.status==='not_sent'));
 assert.equal(Buffer.from((await f.v.read({changeId:f.binding.current.changeId,path:'a.txt'})).contentBase64,'base64').toString(),'base A\n');
});

test('one authorized paired write atomically updates an existing file and creates its companion',async t=>{
 const f=await managed(t,{scope:['a.txt','new.txt']});
 await f.call('read','pair-basis',{path:'a.txt'});
 const commits=[];f.task.projectPolicy={admit:(action,detail)=>{if(action==='write'&&detail.commit)commits.push(detail.scope);}};
 const original=f.v.edit;let sends=0;f.v.edit=async(...args)=>{sends++;return original(...args);};
 await assert.rejects(f.call('write','pair-outside',{files:[{path:'a.txt',content:'A'},{path:'outside.txt',content:'outside'}]}));
 assert.equal(sends,0);assert.deepEqual(commits,[]);
 const result=await f.call('write','pair-write',{files:[{path:'a.txt',content:'A'},{path:'new.txt',content:'N'}]});
 assert.equal(sends,1,'the pair uses one public atomic edit');assert.deepEqual(commits,[['a.txt','new.txt']]);
 for(const [path,text]of [['a.txt','A'],['new.txt','N']])assert.equal(Buffer.from((await f.v.read({changeId:f.binding.current.changeId,path})).contentBase64,'base64').toString(),text);
 assert.equal(result.details.agentSync.changeId,f.binding.current.changeId);
 assert.equal(readFileSync(join(f.project,'a.txt'),'utf8'),'base A\n','formal input stays unchanged until acceptance');
});
test('a stale second file prevents both halves of a paired write',async t=>{
 const f=await managed(t,{scope:['a.txt','b.txt']});
 await f.call('read','pair-read-a',{path:'a.txt'});await f.call('read','pair-read-b',{path:'b.txt'});
 const before=f.binding.current,old=await f.v.read({changeId:before.changeId,path:'b.txt'});
 await f.v.edit(before.changeId,{requestId:'external-b',expectedVersion:before.privateVersion,edits:[{path:'b.txt',oldHash:old.contentHash,contentBase64:Buffer.from('external B').toString('base64')}]});
 Object.assign(before,await f.v.inspect({changeId:before.changeId}));
 await assert.rejects(f.call('write','pair-stale',{files:[{path:'a.txt',content:'must not leak'},{path:'b.txt',content:'must not overwrite'}]}));
 for(const [path,text]of [['a.txt','base A\n'],['b.txt','external B']])assert.equal(Buffer.from((await f.v.read({changeId:before.changeId,path})).contentBase64,'base64').toString(),text);
});
