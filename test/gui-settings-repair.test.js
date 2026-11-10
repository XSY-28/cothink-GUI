import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "../src/config.js";
import * as settings from "../src/gui-settings.js";
import {fixture} from "./helpers/pi-fixture.js";
import {controller,finished,fixtureConversation,prepareSubmit} from "./helpers/gui-controller-fixture.js";

const next = async (manager, id, status) => {
  for (let i = 0; i < 20; i++) {
    const value = manager.lookup(id);
    if (typeof status === "function" ? status(value) : value.status === status) return value;
    await setImmediate();
  }
  assert.fail("OAuth operation did not reach expected state");
};
const runtime = login => async () => ({
  getProvider: () => ({auth:{oauth:{login:true}}}), login,
});

test("OAuth projects only the user step and never publishes replies or stored credentials", async () => {
  const sentinel = "private-returned-credential";
  const manager = settings.createGuiOAuthManager("/fixture", {createRuntime:runtime(async (provider, type, io, opts) => {
    assert.equal(provider, "fixture");
    assert.equal(type, "oauth");
    assert.equal(opts.allowNetwork, undefined);
    io.notify({type:"auth_url",url:"https://auth.example/login?state=123",token:sentinel,instructions:sentinel});
    io.notify({type:"device_code",verificationUri:"https://auth.example/device",userCode:"ABCD-EFGH",deviceCode:sentinel});
    const value = await io.prompt({type:"manual_code",message:sentinel,placeholder:sentinel});
    assert.equal(value, "private-manual-reply");
    return {access:sentinel};
  })});
  const id = manager.start("fixture").operationId;
  assert.equal(manager.start("fixture").operationId, id);
  const step = await next(manager, id, v=>v.prompt);
  assert.equal(step.notification.userCode, "ABCD-EFGH");
  assert.equal(manager.authorizationUrl(id), "https://auth.example/device");
  assert.equal(step.prompt.type, "manual_code");
  assert.doesNotMatch(JSON.stringify(step), /private-/);
  assert.throws(() => manager.respond(id, "wrong-prompt", "reply"));
  manager.respond(id, step.prompt.id, "private-manual-reply");
  const finished = await next(manager, id, "saved");
  assert.equal(finished.saved, true);
  assert.doesNotMatch(JSON.stringify(manager.snapshot()), /private-/);
  assert.equal(manager.lookup("stale-id").status, "unknown");
});

test("OAuth cancel rejects waiting input; a Pi-confirmed credential write stays visible", async () => {
  for (const committed of [false,true]) {
    const manager = settings.createGuiOAuthManager("/fixture", {createRuntime:runtime(async (provider, _, io) => {
      try {await io.prompt({type:"secret",message:"Secret"});}
      catch(error) {
        if (!committed) throw error;
        throw new CredentialSynchronizationError(provider, "login", {access:"private"});
      }
    })});
    const id = manager.start("fixture").operationId;
    await next(manager, id, v=>v.prompt);
    manager.cancel(id);
    assert.equal(manager.start("fixture").operationId, id);
    const result = await next(manager, id, committed ? "saved_with_warning" : "cancelled");
    assert.equal(result.saved, committed);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

const modelConfig = {formatVersion:2,main:{provider:"p",modelId:"m"},secondary:[]};
function temporaryHome(t) {
  const home=mkdtempSync(join(tmpdir(),"cothink-settings-"));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  return home;
}

test("local skill source changes use real discovery and preserve configuration on name conflict", async t => {
  const home=temporaryHome(t);
  saveConfig(home, {...modelConfig, piResources:{tools:["read"]}});
  function source(parent, name, restricted = false) {
    const dir=join(home,parent,name);
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,"SKILL.md"), `---\nname: ${name}\ndescription: Example description\n${restricted?"disable-model-invocation: true\n":""}---\nRead only.\n`);
    writeFileSync(join(dir,"unsafe.js"),"throw Error('should not be imported');");
    return dir;
  }
  const a = source("first","external",true);
  const saved = await settings.saveGuiLocalSkills(home,[a],{cwd:home});
  assert.equal(saved.skills.find(s=>s.name==="external").explicitOnly,true);
  const duplicate = source("second","external");
  await assert.rejects(settings.saveGuiLocalSkills(home,[a,duplicate],{cwd:home}), /名称冲突 external/);
  await assert.rejects(settings.saveGuiLocalSkills(home,[source("third","doc-maintenance")],{cwd:home}), /技能名称冲突 doc-maintenance/);
  assert.deepEqual(loadConfig(home).piResources,{tools:["read"],skills:[a]});
});

test("saving a local skill validates its resources before replacing the previous selection", async t => {
  const home=temporaryHome(t), skill=join(home,"external"), assets=join(home,"asset-source");
  saveConfig(home,{...modelConfig,piResources:{tools:["read"]}});
  mkdirSync(skill);mkdirSync(assets);
  writeFileSync(join(skill,"SKILL.md"),"---\nname: external\ndescription: Test resource validation\n---\nRead only.\n");
  symlinkSync(assets,join(skill,"assets"),process.platform==="win32"?"junction":"dir");
  await assert.rejects(settings.saveGuiLocalSkills(home,[skill],{cwd:home}),/external.*symbolic link/s);
  assert.deepEqual(loadConfig(home).piResources,{tools:["read"]});

  // Previously saved broken sources can still be removed without touching source bytes.
  saveConfig(home,{...modelConfig,piResources:{skills:[skill],tools:["read"]}});
  assert.deepEqual((await settings.saveGuiLocalSkills(home,[],{cwd:home})).paths,[]);
});

const image="sha256:"+"d".repeat(64);
const work={execution:{engine:"docker",network:"none",image,limits:{memoryBytes:33554432,cpus:1,pids:16}}};
const docker = ({host="unix:///fixture/docker.sock",missing=false,cliMissing=false}={}) => {
  const calls=[];
  return {calls,run:async args=>{
    calls.push(args);
    if(args[0]==="context") {
      if(cliMissing) throw Object.assign(Error("secret Docker path"),{code:"ENOENT"});
      return JSON.stringify(host);
    }
    const op=args[2];
    if(op==="version") return "28.0.0";
    if(op==="image") {
      if(missing) throw Error("private Docker output");
      return image;
    }
    if(op==="container") return "exited 0";
    if(op==="run"||op==="create"||op==="start"||op==="rm") return "";
    assert.fail("unexpected Docker operation "+args.join(" "));
  }};
};

test("Docker only probes on request using the inspected image and a restricted fixed command", async t => {
  const home=temporaryHome(t);
  saveConfig(home,{...modelConfig,work});
  const fixture=docker();
  const read=await settings.inspectGuiExecution(home,{runDocker:fixture.run});
  assert.equal(read.diagnostic.status,"passed");
  assert.equal(read.probe.status,"not_run");
  assert.deepEqual(fixture.calls.map(a=>a[0]==="context"?"context":a[2]),["context","version","image"]);
  const result=await settings.inspectGuiExecution(home,{probe:true,runDocker:fixture.run});
  assert.equal(result.probe.status,"passed");
  const container=fixture.calls.find(a=>a[2]==="create"||a[2]==="run");
  assert.ok(container.includes("--pull=never"));
  assert.ok(container.includes("--network=none"));
  assert.ok(container.includes("--read-only"));
  assert.ok(container.includes("--no-healthcheck"));
  assert.equal(container[container.indexOf("--env")+1],"NODE_OPTIONS=");
  assert.ok(container.includes(image));
  assert.equal(container.some(a=>/^(-v$|--volume|--mount)/.test(a)),false);
  assert.notEqual(result.configDigest,settings.guiExecutionConfigDigest({execution:{...work.execution,limits:{...work.execution.limits,pids:17}}}));
});

test("Docker remote endpoint, missing CLI and missing image never reach the probe", async t => {
  const home=temporaryHome(t);
  saveConfig(home,{...modelConfig,work});
  for (const [fixture,code] of [
    [docker({host:"ssh://private.remote"}),"REMOTE_ENDPOINT"],
    [docker({cliMissing:true}),"DOCKER_MISSING"],
    [docker({missing:true}),"IMAGE_UNAVAILABLE"],
  ]) {
    const value=await settings.inspectGuiExecution(home,{probe:true,runDocker:fixture.run});
    assert.equal(value.diagnostic.code,code);
    assert.equal(value.probe.status,"not_run");
    assert.equal(fixture.calls.some(a=>a[2]==="create"||a[2]==="run"),false);
    assert.doesNotMatch(JSON.stringify(value),/private/);
  }
});

test("Pi callback cancels just the manual prompt and can still complete login", async () => {
  const manual = new AbortController();
  const manager = settings.createGuiOAuthManager("/fixture", {createRuntime:runtime(async (_,__,io) => {
    const waiting = io.prompt({type:"manual_code",message:"Paste URL",signal:manual.signal});
    await assert.rejects(waiting,{name:"AbortError"});
    assert.equal(io.signal.aborted,false);
    return {};
  })});
  const id=manager.start("fixture").operationId;
  const {prompt}=await next(manager,id,value=>value.prompt);
  manual.abort();
  assert.throws(()=>manager.respond(id,prompt.id,"late reply"));
  assert.equal((await next(manager,id,"saved")).saved,true);
});

test("a Docker configuration change during diagnostics prevents container creation", async t => {
  const home=temporaryHome(t), fixture=docker();
  saveConfig(home,{...modelConfig,work});
  const result = await settings.inspectGuiExecution(home,{probe:true,runDocker:async args=>{
    if(args[2]==="image") saveConfig(home,{...modelConfig,work:{...work,checks:[{command:"node"}]}});
    return fixture.run(args);
  }});
  assert.equal(result.probe.code,"CONFIG_CHANGED");
  assert.equal(fixture.calls.some(a=>a[2]==="create"),false);
});

test("Docker probe verifies exit and still cleans up after failure", async t => {
  const home=temporaryHome(t), fixture=docker();
  saveConfig(home,{...modelConfig,work});
  const result = await settings.inspectGuiExecution(home,{probe:true,runDocker:async args=>{
    const value=await fixture.run(args);
    if(args[2]==="container") return "exited 7";
    return value;
  }});
  assert.equal(result.probe.status,"failed");
  assert.equal(fixture.calls.at(-1)[2],"rm");
  assert.ok(fixture.calls.at(-1).includes("--volumes"));
});

test("Pi may request the same installation identity on subsequent OAuth operations", async t => {
  const home=temporaryHome(t);
  const received=[];
  const createRuntime=runtime(async (_,__,___,options)=> {
    received.push(options.getDeviceId());
    return {};
  });
  for(let i=0;i<2;i++){
    const manager=settings.createGuiOAuthManager(home,{createRuntime});
    const id=manager.start("openai-chatgpt").operationId;
    await next(manager,id,"saved");
  }
  assert.match(received[0],/^[a-f0-9-]{36}$/);
  assert.equal(received[0],received[1]);
});


test("a missing project directory preserves builtin settings and permits a simple main answer",async t=>{
  const f=await fixture(t,()=>({text:"The conversation still works."}));
  const project=temporaryHome(t);
  const c=await controller(t,f,{piResources:{builtinSkills:{disabled:["doc-maintenance"]}}});
  const session=await fixtureConversation(t,c,{project});
  rmSync(session.project,{recursive:true});
  const result=await c.action("task.submit",await prepareSubmit(c,{sessionId:session.id,input:"What is SVG?"}));
  assert.equal((await finished(c,result.taskId)).status,"completed");
  assert.equal(f.calls.length,1);
});
