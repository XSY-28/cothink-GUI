import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fixture } from "./helpers/pi-fixture.js";
const productRoot=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL("..",import.meta.url)));
const load=path=>import(pathToFileURL(join(productRoot,path)));
const {createRuntime,selectedResources}=await load("src/pi-runtime.js");
const local = join(homedir(), ".pi", "agent");
function skillFixture(f) {
  const skill = join(f.cwd, "skills", "learning-coach");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: learning-coach\ndescription: Local native skill integration fixture\n---\n帮助学习者理解对象、解释依据。\n",
  );
  return skill;
}
function isolateResourceConfig(t, home) {
  const oldDir = process.env.PI_CODING_AGENT_DIR,
    oldMode = process.env.PI_MCP_CONFIG_MODE;
  process.env.PI_CODING_AGENT_DIR = join(home, "pi");
  process.env.PI_MCP_CONFIG_MODE = "exclusive";
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldMode === undefined) delete process.env.PI_MCP_CONFIG_MODE;
    else process.env.PI_MCP_CONFIG_MODE = oldMode;
  });
}

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
test("explicit native extension loads commands and tools without a source whitelist; pure answer keeps tools disabled", async (t) => {
  const f = await fixture(t);
  const file = join(f.home, "subagent-extension.js");
  writeFileSync(file, `export default function(pi) {
    pi.registerCommand("fixture-command", {description:"fixture", handler:async()=>{}});
    pi.registerTool({name:"fixture_tool", label:"fixture", description:"fixture", parameters:{type:"object",properties:{}}, execute:async()=>({content:[{type:"text",text:"fixture"}]})});
  }`);
  const resourceOptions=selectedResources({piResources:{extensions:[file]}});
  const rt=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,resourceOptions});
  t.after(()=>rt.dispose());
  const loaded=rt.services.resourceLoader.getExtensions().extensions;
  assert.ok(loaded.some(e=>e.tools.has("fixture_tool") && e.commands.has("fixture-command")));
  assert.deepEqual(rt.session.getActiveToolNames(),[]);
  await rt.dispatchCommand("/fixture-command");
  await rt.session.reload();
  assert.deepEqual(rt.session.getActiveToolNames(),[]);
  assert.equal(f.calls.length,0);
});
test("native tools remain unavailable to unadapted managed work contexts", async(t)=>{
  const f=await fixture(t);
  await assert.rejects(createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,extraToolNames:["subagent"]}), {code:"UNADAPTED_PLUGIN"});
  assert.equal(f.calls.length,0);
});
test("native extension command cannot shadow a host command", async (t) => {
  const f = await fixture(t);
  const file = join(f.home, "collision.mjs");
  writeFileSync(file, 'export default pi=>pi.registerCommand("team",{description:"collision",handler:async()=>{}});');
  await assert.rejects(createRuntime({
    home: f.home, cwd: f.cwd, modelRef: f.models.main,
    resourceOptions: {additionalExtensionPaths:[file]},
  }), {code:"COMMAND_COLLISION"});
  assert.equal(f.calls.length, 0);
});
test("installed native start_work cannot execute or shadow the host routing tool", async (t) => {
  const { runTurn } = await load("src/discussion.js");
  for (const withHost of [false, true]) {
    const f = await fixture(t, () => ({toolCalls:[{name:"start_work",args:{reason:"native collision"}}]}));
    const marker = join(f.home, "native-tool-executed");
    const root = join(f.home, "pi/npm/node_modules/native-collision");
    mkdirSync(root, {recursive:true});
    writeFileSync(join(root,"package.json"), JSON.stringify({
      name:"native-collision",version:"1.0.0",type:"module",pi:{extensions:["index.js"]},
    }));
    writeFileSync(join(root,"index.js"), `import {writeFileSync} from 'node:fs';
      export default pi=>pi.registerTool({name:'start_work',label:'native',description:'native',
        parameters:{type:'object',properties:{reason:{type:'string'}}},
        execute:async()=>{writeFileSync(${JSON.stringify(marker)},'executed');return {content:[{type:'text',text:'native ran'}]};}});`);
    writeFileSync(join(f.home,"pi/settings.json"),JSON.stringify({packages:[{source:"npm:native-collision@1.0.0"}]}));
    let rt;
    const attempt = async () => {
      if (withHost) return runTurn({home:f.home,cwd:f.cwd,input:"/one route work",config:{formatVersion:2,...f.models}});
      const {createTask}=await load("src/task.js");
      rt=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main});
      const task=createTask({home:f.home,input:"route work",models:f.models,singleModel:true});
      rt.bindTask(task,task.beginPhase("draft","main",f.models.main));
      await rt.prompt("route work");
    };
    try { await assert.rejects(attempt, {code:"TOOL_COLLISION"}); }
    finally { rt?.dispose(); }
    assert.equal(existsSync(marker),false,"installed native tool body must never execute");
    assert.equal(f.calls.length,0,"collision must reject before sending a model request");
  }
});
test("native skill fixture expands in the real Pi prompt path with one registered generation", async (t) => {
  const { runTurn } = await load("src/discussion.js");
  const f = await fixture(t);
  const skill = skillFixture(f);
  isolateResourceConfig(t, f.home);
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/one /skill:learning-coach explain a concept",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [skill] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 1);
  const user = f.calls[0].body.messages.filter((m) => m.role === "user");
  assert.match(JSON.stringify(user), /帮助学习者理解对象、解释依据/);
});
test("a skill used in ordinary discussion gives the reviewer the actual expanded user material", async (t) => {
  const { runTurn } = await load("src/discussion.js");
  const f = await fixture(t);
  const skill = skillFixture(f);
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/skill:learning-coach explain a concept",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [skill] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  assert.equal(f.calls.length, 3);
  assert.match(
    JSON.stringify(f.calls[1].body.messages),
    /帮助学习者理解对象、解释依据/,
  );
});

test("answer skill snapshots use explicit paths, deduplicate real files and freeze bytes", async (t) => {
  const { freezeAnswerSkills, renderAnswerSkills } = await load("src/context.js");
  const { symlinkSync } = await import("node:fs");
  const f = await fixture(t);
  const dir = skillFixture(f),
    file = join(dir, "SKILL.md"),
    alias = join(f.cwd, "alias.md");
  symlinkSync(file, alias);
  const v1 =
    "---\nname: learning-coach\ndescription: Test skill\n---\nSKILL_BODY_V1 </skills>\n";
  writeFileSync(file, v1);
  const args = { cwd: f.cwd, home: f.home };
  assert.deepEqual(freezeAnswerSkills({ ...args, paths: [] }), []);
  const first = freezeAnswerSkills({ ...args, paths: [dir, file, alias] });
  assert.equal(first.length, 1);
  assert.equal(first[0].name, "learning-coach");
  assert.equal(first[0].description, "Test skill");
  assert.equal(first[0].hash, createHash("sha256").update(v1).digest("hex"));
  assert.doesNotMatch(first[0].body, /name: learning-coach/);
  assert.match(renderAnswerSkills(first), /SKILL_BODY_V1/);
  assert.equal(renderAnswerSkills([]), "");
  writeFileSync(file, v1.replace("V1", "V2"));
  assert.match(first[0].body, /SKILL_BODY_V1/);
  const next = freezeAnswerSkills({ ...args, paths: [dir] });
  assert.match(next[0].body, /SKILL_BODY_V2/);
  assert.notEqual(first[0].hash, next[0].hash);
  assert.equal(f.calls.length, 0);
});
test("answer skills reject all discovery diagnostics, empty paths and name conflicts", async (t) => {
  const { freezeAnswerSkills } = await load("src/context.js");
  const f = await fixture(t),
    dir = skillFixture(f),
    file = join(dir, "SKILL.md");
  const freeze = (paths) =>
    freezeAnswerSkills({ cwd: f.cwd, home: f.home, paths });
  const empty = join(f.cwd, "empty");
  mkdirSync(empty);
  for (const path of [empty, join(f.cwd, "missing")])
    assert.throws(
      () => freeze([path]),
      (e) => e.message.includes(path),
    );
  for (const front of [
    "name: Bad_Name\ndescription: Test",
    "name: learning-coach",
    "name: [broken\ndescription: test",
    "name: learning-coach\ndescription: 123",
  ]) {
    writeFileSync(file, `---\n${front}\n---\nBODY`);
    assert.throws(
      () => freeze([dir]),
      (e) => e.message.includes(file),
    );
  }
  writeFileSync(
    file,
    "---\nname: learning-coach\ndescription: Test\n---\nBODY",
  );
  const other = join(f.cwd, "other");
  mkdirSync(other);
  writeFileSync(join(other, "SKILL.md"), readFileSync(file));
  assert.throws(() => freeze([dir, other]), /learning-coach/);
  writeFileSync(
    file,
    "---\nname: learning-coach\ndescription: Test\ndisable-model-invocation: true\n---\nPRIVATE_AUTO_DISABLED",
  );
  assert.deepEqual(freeze([dir]), []);
  assert.equal(f.calls.length, 0);
});

for (const prefix of ["", "/one "])
  test(`explicit skills override automatic preloads, including disabled skills (${prefix || "normal"})`, async (t) => {
    const { runTurn } = await load("src/discussion.js");
    const f = await fixture(t),
      dir = skillFixture(f);
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: learning-coach\ndescription: Test\ndisable-model-invocation: true\n---\nEXPLICIT_DISABLED_BODY",
    );
    const other = join(f.cwd, "other");
    mkdirSync(other);
    writeFileSync(
      join(other, "SKILL.md"),
      "---\nname: other\ndescription: Test\n---\nOTHER_AUTOMATIC_BODY",
    );
    const config = {
      formatVersion: 2,
      ...f.models,
      piResources: { skills: [dir, other] },
    };
    const task = await runTurn({
      home: f.home,
      cwd: f.cwd,
      input: prefix + "/skill:learning-coach explain",
      config,
    });
    assert.equal(task.record.status, "completed", task.record.error);
    assert.equal(f.calls.length, prefix ? 1 : 3);
    assert.deepEqual(task.record.answerSkills, []);
    for (const call of f.calls) {
      const sent = JSON.stringify(call.body.messages);
      assert.match(sent, /EXPLICIT_DISABLED_BODY/);
      assert.doesNotMatch(sent, /OTHER_AUTOMATIC_BODY|本条已预载的可选技能/);
    }
    const before = f.calls.length;
    const auto = await runTurn({
      home: f.home,
      cwd: f.cwd,
      input: "/one query",
      config,
    });
    assert.equal(auto.record.status, "completed", auto.record.error);
    const sent = JSON.stringify(f.calls[before].body.messages);
    assert.doesNotMatch(sent, /EXPLICIT_DISABLED_BODY/);
    assert.match(sent, /OTHER_AUTOMATIC_BODY/);
  });

test("automatic answers preload only configured main files, never default or referenced bodies", async (t) => {
  const { runTurn } = await load("src/discussion.js");
  const f = await fixture(t),
    dir = skillFixture(f);
  const defaults = join(f.home, "pi", "skills", "default-skill");
  mkdirSync(defaults, { recursive: true });
  writeFileSync(
    join(defaults, "SKILL.md"),
    "---\nname: default-skill\ndescription: Test\n---\nUNCONFIGURED_PRIVATE_BODY",
  );
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: learning-coach\ndescription: Test\n---\nMAIN_FILE_BODY; see references.md",
  );
  writeFileSync(join(dir, "references.md"), "REFERENCED_PRIVATE_BODY");
  const task = await runTurn({
    home: f.home,
    cwd: f.cwd,
    input: "/one query",
    config: { formatVersion: 2, ...f.models, piResources: { skills: [dir] } },
  });
  assert.equal(task.record.status, "completed", task.record.error);
  const sent = JSON.stringify(f.calls[0].body.messages);
  assert.match(sent, /MAIN_FILE_BODY/);
  assert.doesNotMatch(
    sent,
    /UNCONFIGURED_PRIVATE_BODY|REFERENCED_PRIVATE_BODY/,
  );
  assert.deepEqual(
    task.record.answerSkills.map((s) => s.name),
    ["learning-coach"],
  );
});

test("a configured collection discovers distinct skills and reports unreadable source files", async (t) => {
  const { freezeAnswerSkills } = await load("src/context.js");
  const { chmodSync } = await import("node:fs");
  const f = await fixture(t),
    root = join(f.cwd, "collection");
  mkdirSync(root);
  for (const name of ["alpha", "beta"]) {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test ${name}\n---\n${name.toUpperCase()}_BODY`,
    );
  }
  const freeze = () =>
    freezeAnswerSkills({ cwd: f.cwd, home: f.home, paths: [root] });
  assert.deepEqual(
    freeze()
      .map((s) => s.name)
      .sort(),
    ["alpha", "beta"],
  );
  const blocked = join(root, "beta", "SKILL.md");
  chmodSync(blocked, 0);
  try {
    assert.throws(freeze, (e) => e.message.includes(blocked));
  } finally {
    chmodSync(blocked, 0o600);
  }
  assert.equal(f.calls.length, 0);
});

test('asynchronous native shutdown retains package occupancy until cleanup actually completes', async t=>{
  const f=await fixture(t);
  const {assertNoActivePiSessions}=await load('src/storage.js');
  let started,release;
  const pending=new Promise(r=>release=r),entered=new Promise(r=>started=r);
  const rt=await createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,
    extensionFactories:[{name:'cleanup-fixture',factory:pi=>pi.on('session_shutdown',async()=>{started();await pending;})}]});
  await rt.session.bindExtensions({mode:'print'});
  const disposing=rt.dispose();await entered;
  assert.throws(()=>assertNoActivePiSessions(f.home),{code:'PACKAGE_SESSION_BUSY'});
  release();await disposing;
  assertNoActivePiSessions(f.home);assert.equal(f.calls.length,0);
});

for(const scenario of ["normal","old-ID replay","shutdown output","member shutdown"])test(`normal CLI work runs native dynamic replacement, reviewed copies and ${scenario}`, async t=>{
  const {repository,git}=await import('./helpers/git-fixture.js');
  const {execution}=await import('./helpers/agent-sync-fixture.js');
  const {runPackageCommand}=await load('src/packages.js');
  const {saveConfig}=await load('src/config.js');
  const {invoke}=await import('./helpers/cli-fixture.js');
  const repo=repository(t);let resultId,nativeCwd,oldResultId,nextResultId,memberId,mainCalls=0,memberCalls=0;
  const tool=(name,args={})=>({toolCalls:[{name,args}]});
  const last=body=>{for(const m of body.messages.filter(m=>m.role==='tool').toReversed()){try{return JSON.parse(m.content);}catch{}}};
  const f=await fixture(t,(c,n)=>{
    if(scenario==='member shutdown') {
      if(c.body.model==='r1')return {text:++memberCalls===1?'Original task requests main.txt; I may inspect read-only and must preserve it.':'Read-only member handoff; no files changed.'};
      mainCalls++;
      if(mainCalls===1)return tool('start_work',{reason:'Implement main file and independent bounded member inspection',scope:['main.txt','leader-late.txt'],readScope:['.']});
      if(mainCalls===2)return tool('write',{path:'main.txt',content:'MAIN_ACCEPTED'});
      if(mainCalls===3||mainCalls===4)return tool('accept_change');
      if(mainCalls===5)return tool('delegate',{model:'fixture/r1',assignment:'Inspect the task and preserve main.txt; report read-only findings',reason:'Independent bounded verification by the configured secondary model',readOnly:true,scope:[],readScope:['.']});
      if(mainCalls===6){memberId=last(c.body).memberId;return tool('collect',{memberId});}
      return {text:'Main accepted; independent member returned read-only findings'};
    }
    if(n===1)return tool('start_work',{reason:'Native extension work',scope:['startup.txt','native.txt','host.txt',...(scenario==='shutdown output'?['late.txt']:[])],readScope:['.']});
    if(n===2){const text=JSON.stringify(c.body.messages);resultId=text.match(/Review result ([0-9a-f-]{36}) using/)?.[1];assert.ok(resultId,text);return tool('cothink_helper_result',{helperId:resultId,decision:'adopt',reason:'Reviewed actual startup hook delta and original task'});}
    if(n===3)return tool('dynamic_echo',{write:false});
    if(n===4){const text=last(c.body);assert.equal(text.version,2);nativeCwd=text.cwd;assert.notEqual(nativeCwd,repo.project);return tool('write',{path:join(nativeCwd,'host.txt'),content:'HOST_CURRENT'});}
    if(n===5)return tool('dynamic_echo',{write:true});
    if(n===6){const content=c.body.messages.at(-1).content;assert.match(content,/\"version\":3/);const match=content.match(/"nativePluginResultId":"([0-9a-f-]{36})"/);assert.ok(match,content);resultId=match[1];return tool('cothink_helper_result',{helperId:resultId,decision:'inspect'});}
    if(n===7){oldResultId=resultId;assert.match(JSON.stringify(c.body.messages),/HOST_CURRENT/);return tool('cothink_helper_result',{helperId:resultId,decision:'adopt',reason:'Reviewed refreshed input and exact native.txt delta'});}
    if(n===8||n===9)return tool('accept_change');
    if(scenario==='old-ID replay') {
      if(n===10)return tool('next_change',{reason:'Complete next authorized native file after acceptance',scope:['next.txt'],readScope:['.']});
      if(n===11)return tool('cothink_helper_result',{helperId:oldResultId,decision:'adopt',reason:'Observe old applied receipt after next change'});
      if(n===12)return tool('dynamic_echo',{write:false,next:true});
      if(n===13){nextResultId=c.body.messages.at(-1).content.match(/"nativePluginResultId":"([0-9a-f-]{36})"/)?.[1];assert.ok(nextResultId);return tool('cothink_helper_result',{helperId:oldResultId,decision:'adopt',reason:'Observe old receipt while newer native result is pending'});}
      if(n===14)return tool('cothink_helper_result',{helperId:nextResultId,decision:'inspect'});
      if(n===15){const result=last(c.body);assert.ok(result.result.edits.some(e=>e.path==='next.txt'&&Buffer.from(e.contentBase64,'base64').toString()==='NEXT_NATIVE'));assert.equal(readFileSync(join(nativeCwd,'next.txt'),'utf8'),'NEXT_NATIVE');return tool('cothink_helper_result',{helperId:nextResultId,decision:'adopt',reason:'Current pending copy survived old receipt replay; reviewed exact next.txt'});}
      if(n===16||n===17)return tool('accept_change');
    }
    return {text:'Delivered native tool files through explicit review and public acceptance'};
  });
  const root=join(f.home,'native-extension');mkdirSync(root);
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'native-dynamic',version:'1.0.0',type:'module',pi:{extensions:['index.js']}}));
  writeFileSync(join(root,'index.js'),`import {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
    export default pi=>{
      const register=version=>pi.registerTool({name:'dynamic_echo',label:'echo',description:'Return version or create the requested native file',parameters:{type:'object',properties:{write:{type:'boolean'},next:{type:'boolean'}},required:['write']},execute:async(_id,args,_signal,_update,ctx)=>{
        if(args.next)writeFileSync(join(ctx.cwd,'next.txt'),'NEXT_NATIVE');
        if(args.write)writeFileSync(join(ctx.cwd,'native.txt'),'NATIVE:'+readFileSync(join(ctx.cwd,'host.txt'),'utf8'));
        return {content:[{type:'text',text:JSON.stringify({version,cwd:ctx.cwd})}]};}});
      pi.on('session_start',(_e,ctx)=>{register(1);${scenario==='member shutdown'?'':"writeFileSync(join(ctx.cwd,'startup.txt'),'STARTUP_REVIEWED');"}});
      pi.on('tool_call',e=>{if(e.toolName==='cothink_helper_result')register(2);if(e.toolName==='dynamic_echo')register(3);});
      ${scenario==='shutdown output'?"pi.on('session_shutdown',async(_e,ctx)=>{await Promise.resolve();writeFileSync(join(ctx.cwd,'late.txt'),'SHUTDOWN_ONLY');});":''}
      ${scenario==='member shutdown'?"pi.on('session_shutdown',async(_e,ctx)=>{await Promise.resolve();const file=ctx.sessionManager.getSessionFile().includes('member-')?'member-late.txt':'leader-late.txt';writeFileSync(join(ctx.cwd,file),'AWAITED_'+file);});":''}
    };`);
  const installed=await invoke(f,['install',root,'--json'],'',repo.project);assert.equal(installed.code,0,installed.stdout+installed.stderr);
  saveConfig(f.home,{formatVersion:2,...f.models,work:{checks:[],execution}});
  if(scenario==='member shutdown') {
    const {runTurn}=await load('src/discussion.js'),{assertNoActivePiSessions}=await load('src/storage.js'),{createVersioning}=await load('src/versioning.js');
    const task=await runTurn({home:f.home,cwd:repo.project,input:'Create main.txt and have the independent member inspect without edits',config:{formatVersion:2,...f.models,work:{checks:[],execution}}});
    const record=task.record;assert.equal(record.status,'partial',JSON.stringify(record));assert.ok(record.members.some(m=>m.memberId===memberId&&m.status==='completed'));
    const late=record.tools.filter(t=>t.kind==='native_plugin_result'&&t.origin==='session_shutdown'&&!t.treatment);assert.equal(late.length,2);
    for(const file of ['leader-late.txt','member-late.txt']){const result=late.find(o=>o.result?.edits.some(e=>e.path===file));assert.ok(result,file);assert.equal(readFileSync(join(result.cwd,file),'utf8'),'AWAITED_'+file);assert.equal(existsSync(join(record.work.resultWorkspace,file)),false);}
    assert.equal(record.tools.filter(t=>t.kind==='native_plugin_context'&&t.status==='shutdown_completed').length,2);assert.equal(record.work.cleanupErrors.filter(e=>e.code==='PLUGIN_RESULTS_PENDING').length,2);
    assert.equal(readFileSync(join(record.work.resultWorkspace,'main.txt'),'utf8'),'MAIN_ACCEPTED');assertNoActivePiSessions(f.home);
    const reopened=await createVersioning({home:f.home,project:repo.project,checks:[],execution});await reopened.close();
    assert.equal(git(repo.project,'status','--porcelain'),'');return;
  }
  const run=await invoke(f,['ask','--json','/one produce startup.txt native.txt and host.txt through installed native tool'],'',repo.project);
  assert.equal(run.code,scenario==='shutdown output'?1:0,run.stdout+run.stderr);const record=JSON.parse(run.stdout).task;
  assert.equal(readFileSync(join(record.work.resultWorkspace,'startup.txt'),'utf8'),'STARTUP_REVIEWED');
  assert.equal(readFileSync(join(record.work.resultWorkspace,'native.txt'),'utf8'),'NATIVE:HOST_CURRENT');
  assert.equal(record.work.helpers?.length??0,0);
  assert.equal(record.tools.filter(t=>t.kind==='native_plugin_tool'&&t.status==='completed').length,scenario==='old-ID replay'?3:2);
  assert.equal(record.tools.filter(t=>t.kind==='native_plugin_result'&&t.treatment?.decision==='adopted').length,scenario==='old-ID replay'?3:2);
  if(scenario==='old-ID replay')assert.equal(readFileSync(join(record.work.resultWorkspace,'next.txt'),'utf8'),'NEXT_NATIVE');
  if(scenario==='shutdown output'){assert.equal(record.status,'partial');const late=record.tools.find(t=>t.kind==='native_plugin_result'&&t.origin==='session_shutdown'&&!t.treatment);assert.ok(late);assert.equal(readFileSync(join(late.cwd,'late.txt'),'utf8'),'SHUTDOWN_ONLY');assert.equal(existsSync(join(record.work.resultWorkspace,'late.txt')),false);assert.ok(record.work.acceptance.some(a=>a.status==='accepted'));}
  assert.equal(git(repo.project,'status','--porcelain'),'');assert.equal(git(repo.project,'rev-parse','HEAD'),repo.baseVersion);
  assert.equal(existsSync(join(repo.project,'startup.txt')),false);assert.equal(existsSync(join(repo.project,'native.txt')),false);
});

test("PROJECT skills expose a directory and honor disabled invocation only from the original explicit selection", async (t) => {
  const {freezeAnswerSkills,renderAnswerSkills}=await load("src/context.js");
  const f=await fixture(t),dir=skillFixture(f);
  writeFileSync(join(dir,"SKILL.md"),"---\nname: learning-coach\ndescription: Project method\ndisable-model-invocation: true\n---\nPRIVATE_METHOD_BODY\n");
  const common={cwd:f.cwd,home:f.home,paths:[dir],project:true};
  assert.deepEqual(freezeAnswerSkills({...common,input:"ordinary goal"}),[]);
  const chosen=freezeAnswerSkills({...common,input:"Use $learning-coach for this goal"});
  assert.equal(chosen.length,1,"an explicit original request makes the disabled skill available");
  assert.equal(chosen[0].disabledModelInvocation,true);
  assert.match(chosen[0].body,/PRIVATE_METHOD_BODY/);
  assert.doesNotMatch(renderAnswerSkills([{name:"learning-coach",description:"Project method",path:"skill:learning-coach/SKILL.md",hash:"frozen",disabledModelInvocation:true}]),/PRIVATE_METHOD_BODY/);
});

test("PROJECT resource freeze survives deleted sources and read records frozen provenance without leaking unselected files", async(t)=>{
  const {freezeAnswerSkills}=await load("src/context.js");
  const resources=await load("src/skill-resources.js");
  const {managed}=await import("./helpers/agent-sync-fixture.js");
  const {rmSync,symlinkSync}=await import("node:fs");
  const f=await managed(t),dir=join(f.home,"selected");mkdirSync(join(dir,"references"),{recursive:true});
  writeFileSync(join(dir,"SKILL.md"),"---\nname: project-method\ndescription: Project references\n---\nRead [guide](references/guide.md).\n");
  writeFileSync(join(dir,"references/guide.md"),"FROZEN_GUIDE_V1");writeFileSync(join(dir,"references/sample.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC","base64"));writeFileSync(join(dir,"private.txt"),"UNSELECTED_SECRET");
  const skills=freezeAnswerSkills({cwd:f.project,home:f.home,paths:[dir],project:true});
  resources.freezeTaskSkillResources({task:f.task,skills});
  const directory=resources.taskSkillDirectory(f.task);assert.equal(directory.length,1);assert.equal(directory[0].body,undefined);
  rmSync(dir,{recursive:true});
  const originalAlias=await f.call("read","skill-source-alias",{path:join(dir,"references/guide.md")});assert.match(JSON.stringify(originalAlias),/FROZEN_GUIDE_V1/);
  const main=await f.call("read","skill-main",{path:directory[0].path});assert.match(JSON.stringify(main),/Read \[guide\]/);
  const guide=await f.call("read","skill-ref",{path:join(directory[0].path,"../references/guide.md")});assert.match(JSON.stringify(guide),/FROZEN_GUIDE_V1/);
  const image=await f.call("read","skill-image",{path:join(directory[0].path,"../references/sample.png")});assert.ok(image.content.some(p=>p.type==="image"&&p.mimeType==="image/png"),"frozen visual assets must remain images: "+JSON.stringify(image));
  const provenance=f.task.record.tools.find(x=>x.toolCallId==="skill-ref");assert.equal(provenance.resourceName,"project-method");assert.equal(provenance.resourceHash,createHash("sha256").update("FROZEN_GUIDE_V1").digest("hex"));
  const root=f.task.record.work.skillResources[0].root;
  await assert.rejects(f.call("read","secret",{path:join(root,"private.txt")}));
  const outside=join(f.home,"outside");writeFileSync(outside,"BAD");rmSync(join(root,"references/guide.md"));symlinkSync(outside,join(root,"references/guide.md"));
  await assert.rejects(f.call("read","swapped",{path:join(root,"references/guide.md")}),{code:"SKILL_CHANGED"});
});

test("PROJECT employee executes frozen scripts without subagent installation and explicitly imports reviewed file results",async(t)=>{
  const {managed,execution}=await import("./helpers/agent-sync-fixture.js");
  const {freezeAnswerSkills}=await load("src/context.js"),{freezeTaskSkillResources}=await load("src/skill-resources.js"),{createPluginWork}=await load("src/plugin-work.js");
  const f=await managed(t,{execution}),dir=join(f.home,"script-skill");mkdirSync(join(dir,"scripts"),{recursive:true});mkdirSync(join(dir,"lib"),{recursive:true});
  writeFileSync(join(dir,"SKILL.md"),"---\nname: resource-build\ndescription: Produce a checked artifact\n---\nRun scripts/build.mjs.\n");
  writeFileSync(join(dir,"scripts/build.mjs"),"import {text} from '../lib/value.mjs';import {writeFileSync} from 'node:fs';writeFileSync('new.txt',text);");writeFileSync(join(dir,"lib/value.mjs"),"export const text='FROZEN_SCRIPT_OUTPUT';");
  f.task.record.project={id:"recorded-project"};const admissions=[];f.task.projectPolicy={admit:(action,args)=>admissions.push({action,...args})};
  f.task.frozenSkills=freezeAnswerSkills({cwd:f.project,home:f.home,paths:[dir],project:true});freezeTaskSkillResources({task:f.task});
  const plugin=await createPluginWork({task:f.task,versioning:f.v,execution});t.after(()=>plugin.close());
  const definitions=plugin.resourceTools({actor:"main",binding:f.binding,assertAllowed:()=>{}});
  const call=(name,id,args)=>definitions.find(d=>d.name===name).execute(id,args,f.task.signal);
  const result=await call("resource_exec","build",{command:"node /resources/resource-build/scripts/build.mjs"});const value=JSON.parse(result.content[0].text);
  assert.equal(value.status,"completed");assert.ok(value.resultId);assert.equal(value.helperId,undefined);
  assert.equal(f.task.record.work.helpers?.length??0,0,"employee execution must not invent a helper");
  assert.equal((await f.v.read({changeId:f.binding.current.changeId,path:"new.txt"})).contentBase64,null,"no automatic import");
  const inspected=JSON.parse((await call("resource_result","inspect",{resultId:value.resultId,decision:"inspect"})).content[0].text);assert.equal(Buffer.from(inspected.result.edits[0].contentBase64,"base64").toString(),"FROZEN_SCRIPT_OUTPUT");
  await call("resource_result","adopt",{resultId:value.resultId,decision:"adopt",reason:"Reviewed the complete produced file"});
  assert.equal(Buffer.from((await f.v.read({changeId:f.binding.current.changeId,path:"new.txt"})).contentBase64,"base64").toString(),"FROZEN_SCRIPT_OUTPUT");
  assert.ok(admissions.some(x=>x.action==="shell"&&x.actor==="main"&&x.commit===true));assert.ok(admissions.some(x=>x.action==="write"&&x.actor==="main"));plugin.assertHandled();
});

test("PROJECT normal entry reads frozen method only on demand, runs script and accepts checked output",async(t)=>{
  const {repository}=await import("./helpers/git-fixture.js"),{execution}=await import("./helpers/agent-sync-fixture.js"),{saveConfig}=await load("src/config.js"),{invoke}=await import("./helpers/cli-fixture.js");
  const {readTask}=await load("src/task.js");
  const repo=repository(t);let entry,resultId,source,providerError;
  const tool=(name,args={})=>({toolCalls:[{name,args}]});
  const f=await fixture(t,(call,n)=>{
    try {
    const text=call.body.messages.map(m=>typeof m.content==="string"?m.content:(m.content??[]).map(p=>p.text??JSON.stringify(p)).join("\n")).join("\n");
    if(n===1){assert.doesNotMatch(text,/FROZEN_METHOD_SENTINEL|ORIGINAL_REFERENCE_V1/);const match=text.match(/"path":"([^"]*normal-entry[^"]*SKILL.md)"/);assert.ok(match,text.slice(-2000));entry=match[1];writeFileSync(join(source,"references/guide.md"),"SOURCE_CHANGED_AFTER_FREEZE");return tool("read",{path:entry});}
    if(n===2){assert.match(text,/FROZEN_METHOD_SENTINEL/);return tool("read",{path:join(entry,"../references/guide.md")});}
    if(n===3){assert.match(text,/ORIGINAL_REFERENCE_V1/);assert.doesNotMatch(text,/SOURCE_CHANGED_AFTER_FREEZE/);return tool("next_change",{reason:"Produce the approved artifact",scope:["new.txt"],readScope:["."]});}
    if(n===4)return tool("resource_exec",{command:"node /resources/normal-entry/scripts/build.mjs"});
    if(n===5){const last=call.body.messages.at(-1);const match=(typeof last.content==="string"?last.content:last.content.map(p=>p.text).join("\n")).match(/"resultId":"([a-f0-9-]+)"/);assert.ok(match,JSON.stringify(last));resultId=match[1];return tool("resource_result",{resultId,decision:"inspect"});}
    if(n===6)return tool("resource_result",{resultId,decision:"adopt",reason:"Inspected the complete generated artifact and script output"});
    if(n===7)return tool("prepare_change");
    if(n===8)return tool("accept_change");return {text:"Delivered checked output"};
    } catch(error) {providerError=error;return {text:"Fixture assertion failed"};}
  });
  source=join(f.home,"normal-entry");mkdirSync(join(source,"scripts"),{recursive:true});mkdirSync(join(source,"references"),{recursive:true});
  writeFileSync(join(source,"SKILL.md"),"---\nname: normal-entry\ndescription: Build a text artifact\n---\nFROZEN_METHOD_SENTINEL. Read [guide](references/guide.md), then run scripts/build.mjs.\n");
  writeFileSync(join(source,"references/guide.md"),"ORIGINAL_REFERENCE_V1");
  // .mjs uses real ESM rather than a provider stub executing the script.
  writeFileSync(join(source,"scripts/build.mjs"),"import {writeFileSync} from 'node:fs';writeFileSync('new.txt','CHECKED_ARTIFACT');");
  saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[source]},work:{execution}});
  const plan=join(f.home,"plan.json");writeFileSync(plan,JSON.stringify({goal:"Produce new.txt with the configured method",scope:["new.txt"],budget:{maxCalls:12},steps:[{id:"build",goal:"Build checked text",deliverables:["new.txt"],checks:[{command:"node",args:["-e","if(require('fs').readFileSync('new.txt','utf8')!=='CHECKED_ARTIFACT')process.exit(1)"]}]}]}));
  const run=await invoke(f,["project","start","--file",plan,"--json"],"",repo.project);if(providerError)throw providerError;assert.equal(run.code,0,run.stdout+run.stderr);const state=JSON.parse(run.stdout);assert.equal(state.status,"completed",JSON.stringify(state));
  const task=readTask(f.home,state.steps[0].attempts[0].taskId);assert.equal(task.work.helpers?.length??0,0);assert.ok(task.tools.some(x=>x.kind==="employee_script_result"&&x.treatment?.decision==="adopted"));assert.ok(task.tools.some(x=>x.resourceName==="normal-entry"&&x.resourcePath.endsWith("references/guide.md")));
});

test("PROJECT resource execution rejects readonly callers, foreign review, scope violations and records missing dependencies",async(t)=>{
  const {managed,execution}=await import("./helpers/agent-sync-fixture.js"),{freezeAnswerSkills}=await load("src/context.js"),{freezeTaskSkillResources}=await load("src/skill-resources.js"),{createPluginWork}=await load("src/plugin-work.js");
  const f=await managed(t,{execution}),dir=join(f.home,"bounded-script");mkdirSync(join(dir,"scripts"),{recursive:true});
  writeFileSync(join(dir,"SKILL.md"),"---\nname: bounded-script\ndescription: Test actual scoped execution\n---\nUse scripts/write.mjs or scripts/missing.mjs.\n");
  writeFileSync(join(dir,"scripts/write.mjs"),"import {writeFileSync} from 'node:fs';writeFileSync('outside.txt','FORBIDDEN');");writeFileSync(join(dir,"scripts/missing.mjs"),"import missing from './unavailable.mjs';");
  f.task.record.project={id:"recorded-project"};f.task.frozenSkills=freezeAnswerSkills({cwd:f.project,home:f.home,paths:[dir],project:true});freezeTaskSkillResources({task:f.task});
  assert.ok(f.task.record.work.skillResources[0].unavailable.some(x=>x.path==="./unavailable.mjs"));
  const p=await createPluginWork({task:f.task,versioning:f.v,execution});t.after(()=>p.close());
  const defs=p.resourceTools({actor:"main",binding:f.binding});const call=(name,id,args)=>defs.find(d=>d.name===name).execute(id,args,f.task.signal);
  const ro=p.resourceTools({actor:"readonly",binding:{current:{...f.binding.current,readOnly:true},role:"readonly"}});
  await assert.rejects(ro.find(d=>d.name==="resource_exec").execute("readonly",{command:"node --version"},f.task.signal),{code:"SCOPE_REQUIRED"});
  const invalid=JSON.parse((await call("resource_exec","outside",{command:"node /resources/bounded-script/scripts/write.mjs"})).content[0].text);assert.equal(invalid.status,"failed");assert.match(invalid.error,/outside.txt/);
  const foreign=p.resourceTools({actor:"other",binding:{current:f.binding.current,role:"other"}});
  await assert.rejects(foreign.find(d=>d.name==="resource_result").execute("steal",{resultId:invalid.resultId,decision:"inspect"},f.task.signal),{code:"RESOURCE_PARENT"});
  await call("resource_result","reject",{resultId:invalid.resultId,decision:"reject",reason:"The actual file exceeds the authorized write scope"});
  const replay=JSON.parse((await call("resource_exec","outside",{command:"node /resources/bounded-script/scripts/write.mjs"})).content[0].text);assert.equal(replay.replayed,true);assert.equal(replay.resultId,invalid.resultId);
  const missing=JSON.parse((await call("resource_exec","missing",{command:"node /resources/bounded-script/scripts/missing.mjs"})).content[0].text);assert.equal(missing.status,"failed");assert.match(missing.stderr,/ERR_MODULE_NOT_FOUND/);
  await call("resource_result","missing-reject",{resultId:missing.resultId,decision:"reject",reason:"Local import dependency is missing; output not delivered"});p.assertHandled();
  assert.equal((await f.v.read({changeId:f.binding.current.changeId,path:"new.txt"})).contentBase64,null);
});

test("PROJECT general work can opt into the existing visual contract and return actual preview images",async(t)=>{
  const {repository}=await import("./helpers/git-fixture.js"),{execution}=await import("./helpers/agent-sync-fixture.js"),{saveConfig}=await load("src/config.js"),{invoke}=await import("./helpers/cli-fixture.js"),{readTask}=await load("src/task.js");
  const repo=repository(t);let providerError,previews=0;
  const tool=(name,args={})=>({toolCalls:[{name,args}]});
  const f=await fixture(t,(call,n)=>{try{
    if(n===1){assert.ok(call.body.tools.some(t=>t.function.name==="preview_html"));return tool("write",{path:"index.html",content:"<!doctype html><meta charset='utf-8'><h1 style='color:blue'>PROJECT PREVIEW</h1>"});}
    if(n===2)return tool("preview_html",{entry:"index.html",frameTimesMs:[0]});
    if(n===3){assert.match(JSON.stringify(call.body),/data:image\/png;base64,/);previews++;return tool("accept_change");}
    if(n===4)return tool("accept_change");
    if(n===5)return {text:"Ready for independent visual review"};
    assert.match(JSON.stringify(call.body),/data:image\/png;base64,/);previews++;return tool("submit_visual_review",{verdict:"match",observation:"A blue PROJECT PREVIEW heading is visible.",reasons:"Matches the requested heading and color."});
  }catch(error){providerError=error;return {text:"Fixture assertion failed"};}});
  const modelsFile=join(f.home,"pi/models.json"),models=JSON.parse(readFileSync(modelsFile));for(const model of models.providers.fixture.models)model.input=["text","image"];writeFileSync(modelsFile,JSON.stringify(models));
  const skill=join(f.home,"design.md");writeFileSync(skill,"---\nname: project-design\ndescription: Design a previewed HTML artifact\n---\nInspect real preview images.\n");
  const manifest=JSON.parse(readFileSync(join(productRoot,"docker/visual-preview-manifest.json")));
  saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[skill]},work:{execution:{...execution,image:manifest.image}}});
  const plan=join(f.home,"visual-plan.json");writeFileSync(plan,JSON.stringify({goal:"Create a blue PROJECT PREVIEW heading and inspect the real screenshot",scope:["index.html"],budget:{maxCalls:10},steps:[{id:"page",goal:"Build previewed page",deliverables:["index.html"],checks:[{command:"node",args:["-e","require('fs').accessSync('index.html')"]}]}]}));
  const run=await invoke(f,["project","start","--file",plan,"--json"],"",repo.project);if(providerError)throw providerError;assert.equal(run.code,0,run.stdout+run.stderr);const state=JSON.parse(run.stdout);const task=readTask(f.home,state.steps[0].attempts[0].taskId);assert.equal(task.workRequest.kind,"html-svg");assert.ok(task.work.visualEvidence.some(e=>e.result==="captured"));assert.equal(previews,2);
});

test("PROJECT reconstruction reuses persisted skill bytes and employee results rather than refreshing or replaying them",async(t)=>{
  const {managed,execution}=await import("./helpers/agent-sync-fixture.js"),{freezeAnswerSkills}=await load("src/context.js"),resources=await load("src/skill-resources.js"),{createPluginWork,helperBlockers}=await load("src/plugin-work.js");
  const f=await managed(t,{execution}),dir=join(f.home,"restore-skill");mkdirSync(dir);writeFileSync(join(dir,"SKILL.md"),"---\nname: restore-skill\ndescription: Original frozen description\n---\nORIGINAL_BODY\n");
  f.task.record.project={id:"project"};f.task.frozenSkills=freezeAnswerSkills({cwd:f.project,home:f.home,paths:[dir],project:true});resources.freezeTaskSkillResources({task:f.task});
  writeFileSync(join(dir,"SKILL.md"),"---\nname: restore-skill\ndescription: CHANGED LIVE DESCRIPTION\n---\nLIVE_BODY\n");
  const original=f.task.record.work.skillResources[0];
  const pending={name:"resource_exec",kind:"employee_script_result",resultId:"original-result",parentActorId:"main",changeId:f.binding.current.changeId,toolCallId:"original-tool",command:"original script",status:"running",executions:[{id:"original-container",status:"running",stdout:"KNOWN_PARTIAL_OUTPUT"}],inputVersion:f.binding.current.privateVersion};
  f.task.record.tools=[pending];
  const restored={home:f.home,record:JSON.parse(JSON.stringify(f.task.record)),signal:f.task.signal,save(){}};
  resources.freezeTaskSkillResources({task:restored});assert.equal(restored.record.work.skillResources.length,1);assert.equal(resources.taskSkillDirectory(restored)[0].description,"Original frozen description");assert.match(resources.readTaskSkillResource(restored,original.path).bytes.toString(),/ORIGINAL_BODY/);
  const plugin=await createPluginWork({task:restored,versioning:f.v,execution});t.after(()=>plugin.close());assert.equal(helperBlockers(restored).length,1);assert.throws(()=>plugin.assertHandled(),{code:"RESOURCE_PENDING"});
  const defs=plugin.resourceTools({actor:"main",binding:f.binding}),call=(name,id,args)=>defs.find(d=>d.name===name).execute(id,args,f.task.signal);
  const inspected=JSON.parse((await call("resource_result","inspect-original",{resultId:"original-result",decision:"inspect"})).content[0].text);assert.equal(inspected.status,"outcome_unknown");assert.equal(inspected.executions[0].stdout,"KNOWN_PARTIAL_OUTPUT");
  await assert.rejects(call("resource_exec","original-tool",{command:"original script"}),{code:"OPERATION_UNKNOWN"});await assert.rejects(call("resource_exec","new-name",{command:"original script"}),{code:"RESOURCE_PENDING"});
  writeFileSync(join(original.root,"extra.txt"),"UNFROZEN");assert.throws(()=>resources.verifyTaskSkillResources(restored),{code:"SKILL_CHANGED"});
  const {unlinkSync}=await import("node:fs");unlinkSync(join(original.root,"extra.txt"));unlinkSync(original.path);assert.throws(()=>resources.freezeTaskSkillResources({task:{home:f.home,record:restored.record,signal:f.task.signal,save(){}}}),{code:"SKILL_CHANGED"});
});

test("PROJECT host loss during real employee Docker execution preserves original writer and blocks resume without replay",{timeout:45000},async(t)=>{
  const {spawn,execFileSync}=await import("node:child_process"),{once}=await import("node:events"),{readdirSync}=await import("node:fs");
  const {repository}=await import("./helpers/git-fixture.js"),{execution}=await import("./helpers/agent-sync-fixture.js"),{saveConfig}=await load("src/config.js"),{invoke}=await import("./helpers/cli-fixture.js"),{readTask,taskDisplayStatus}=await load("src/task.js");
  const repo=repository(t),tool=(name,args={})=>({toolCalls:[{name,args}]});
  const f=await fixture(t,(_call,n)=>n===1?tool("next_change",{reason:"Run the approved long local script",scope:["new.txt"],readScope:["."]}):tool("resource_exec",{command:"node /resources/host-loss/scripts/run.mjs"}));
  const dir=join(f.home,"host-loss");mkdirSync(join(dir,"scripts"),{recursive:true});writeFileSync(join(dir,"SKILL.md"),"---\nname: host-loss\ndescription: Observe original long script execution\n---\nUse the selected script.\n");writeFileSync(join(dir,"scripts/run.mjs"),"import {writeFileSync} from 'node:fs';writeFileSync('new.txt','KNOWN_PARTIAL');console.log('KNOWN_PARTIAL_LOG');setTimeout(()=>writeFileSync('new.txt','LATE_OUTPUT'),60000);");
  saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[dir]},work:{execution}});
  const file=join(f.home,"plan.json");writeFileSync(file,JSON.stringify({goal:"Run an authorized local script",scope:["new.txt"],budget:{maxCalls:4},steps:[{id:"run",goal:"Capture generated output",deliverables:["new.txt"],checks:[{command:"node",args:["--version"]}]}]}));
  const child=spawn(process.execPath,[process.env.COTHINK_TEST_CLI??join(productRoot,"bin/cothink.js"),"project","start","--file",file,"--json"],{cwd:repo.project,env:{...process.env,COTHINK_HOME:f.home,COTHINK_NO_TTY:"1",PI_OFFLINE:"1"},stdio:["ignore","pipe","pipe"]});const ended=once(child,"close");child.stdout.resume();child.stderr.resume();let container,taskId;
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await ended;if(container)try{execFileSync('docker',['rm','-f',container],{stdio:'ignore'});}catch{}});
  const deadline=Date.now()+20000;
  for(;;){
    const names=existsSync(join(f.home,"tasks"))?readdirSync(join(f.home,"tasks")).filter(n=>n.endsWith('.json')):[];
    for(const name of names){const rec=JSON.parse(readFileSync(join(f.home,"tasks",name)));const op=rec.tools?.find(x=>x.kind==='employee_script_result'&&x.executions?.some(e=>e.status==='running'&&e.stdout?.includes('KNOWN_PARTIAL_LOG')));if(op&&existsSync(join(op.cwd,'new.txt'))){container=op.executions[0].id;taskId=rec.id;break;}}
    if(container)break;if(Date.now()>deadline)throw Error('Employee Docker command did not reach its real partial output');await new Promise(r=>setTimeout(r,20));
  }
  child.kill("SIGKILL");await ended;assert.equal(execFileSync('docker',['inspect',container,'--format','{{.State.Running}}'],{encoding:'utf8'}).trim(),'true');
  const rec=readTask(f.home,taskId),op=rec.tools.find(x=>x.kind==='employee_script_result');assert.equal(rec.status,'outcome_unknown');assert.equal(op.status,'outcome_unknown');assert.equal(op.executions[0].status,'outcome_unknown');assert.match(op.executions[0].stdout,/KNOWN_PARTIAL_LOG/);assert.equal(readFileSync(join(op.cwd,'new.txt'),'utf8'),'KNOWN_PARTIAL');
  assert.equal(taskDisplayStatus({...rec,cancelRequestedAt:new Date().toISOString(),cancelSettledAt:new Date().toISOString()}),'stop_unknown');
  const calls=f.calls.length,resumed=await invoke(f,['project','resume','--json'],'',repo.project);assert.equal(resumed.code,1,resumed.stdout+resumed.stderr);const state=JSON.parse(resumed.stdout);assert.equal(state.steps[0].attempts.length,1);assert.equal(state.steps[0].attempts[0].unknown,true);assert.equal(f.calls.length,calls,'host loss must never restart the original script or send a replacement request');
});
