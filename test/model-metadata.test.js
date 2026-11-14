import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
import * as models from "../src/pi-model-runtime.js";
import { saveGuiProvider } from "../src/gui-settings.js";
import { selectModelRef, importLegacyConfig } from "../src/setup.js";
import { GUI_INPUT_VERSION } from "../src/gui-turn-options.js";

// This suite explicitly contacts controlled loopback metadata servers. Production
// PI_OFFLINE enforcement is tested separately below, with zero server requests.
let priorOffline;
beforeEach(()=>{priorOffline=process.env.PI_OFFLINE;process.env.PI_OFFLINE="0";});
afterEach(()=>{if(priorOffline===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=priorOffline;});

const reported = { id:"main", context_window:1048576, max_output_tokens:393216, input_modalities:["text","image"] };
function catalog(f, edit) {
  const path=join(f.home,"pi/models.json"), value=JSON.parse(readFileSync(path,"utf8"));
  if (edit) {edit(value);writeFileSync(path,JSON.stringify(value));}
  return value;
}
async function metadataFixture(t, reply = {data:[reported,{id:"remote-only",context_window:999999}]}) {
  const f=await fixture(t), requests=[];
  const server=createServer((req,res)=>{
    requests.push({url:req.url,method:req.method,authorization:req.headers.authorization,extra:req.headers["x-fixture"]});
    if (typeof reply==="function") return reply(req,res);
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(reply));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
  catalog(f,c=>{c.providers.fixture.baseUrl=endpoint;c.providers.fixture.headers={"x-fixture":"configured-header"};});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {...f,requests};
}
async function inspect(f) {
  assert.equal(typeof models.inspectProviderMetadata,"function","metadata inspection is available");
  return models.inspectProviderMetadata({home:f.home,providerId:"fixture"});
}
function save(f,row,metadata) {
  return saveGuiProvider(f.home,{providerId:"fixture",metadata:{modelId:row.modelId,...metadata},expectedModelDigest:row.expectedModelDigest});
}

test("explicit metadata inspection reports 1M against legacy 32000 without changing catalog or generating",async t=>{
  const f=await metadataFixture(t), before=catalog(f);
  const result=await inspect(f), row=result.models.find(m=>m.modelId==="main");
  assert.equal(result.status,"reported");assert.ok(result.checkedAt);
  assert.equal(row.current.contextWindow,32000);
  assert.deepEqual(row.reported,{contextWindow:1048576,maxTokens:393216,input:["text","image"]});
  assert.equal(row.sources.contextWindow,"local_config_unverified");
  assert.equal(result.models.some(m=>m.modelId==="remote-only"),false);
  assert.deepEqual(f.requests,[{url:"/v1/models",method:"GET",authorization:"Bearer fixture-secret",extra:"configured-header"}]);
  assert.deepEqual(catalog(f),before);assert.equal(f.calls.length,0);
  assert.doesNotMatch(JSON.stringify(result),/fixture-secret|configured-header|apiKey/);
});

test("metadata save merges selected fields under existing lock while preserving auth, prices and other models",async t=>{
  const f=await metadataFixture(t), result=await inspect(f), row=result.models[0];
  catalog(f,c=>{c.providers.fixture.models[1].name="renamed elsewhere";c.providers.fixture.models[0].maxTokens=5555;});
  const before=catalog(f);
  await save(f,row,{contextWindow:row.reported.contextWindow,input:row.reported.input});
  const after=catalog(f), model=after.providers.fixture.models[0];
  assert.equal(model.contextWindow,1048576);assert.deepEqual(model.input,["text","image"]);
  assert.equal(model.maxTokens,5555);assert.deepEqual(model.cost,before.providers.fixture.models[0].cost);
  assert.equal(after.providers.fixture.apiKey,before.providers.fixture.apiKey);
  assert.deepEqual(after.providers.fixture.models.slice(1),before.providers.fixture.models.slice(1));
  assert.equal(after.providers.fixture.models.length,4);assert.equal(f.requests.length,1);
});

test("metadata save rejects stale selected capability, changed override source and changed route",async t=>{
  for (const mutate of [
    c=>{c.providers.fixture.models[0].contextWindow=64000;},
    c=>{c.providers.fixture.modelOverrides={main:{contextWindow:32000}};},
    c=>{c.providers.fixture.models[0].baseUrl="https://changed.invalid/v1";},
    c=>{c.providers.fixture.baseUrl="https://changed.invalid/v1";},
  ]) {
    const f=await metadataFixture(t), row=(await inspect(f)).models[0];catalog(f,mutate);const before=catalog(f);
    await assert.rejects(save(f,row,{contextWindow:1048576}),{code:"MODEL_METADATA_CHANGED"});
    assert.deepEqual(catalog(f),before);
  }
});

test("metadata saves preserve explicit overrides as the authoritative effective capability",async t=>{
  const f=await metadataFixture(t);
  catalog(f,c=>{c.providers.fixture.modelOverrides={main:{contextWindow:64000}};});
  const row=(await inspect(f)).models[0];assert.equal(row.current.contextWindow,64000);assert.equal(row.sources.contextWindow,"model_override");
  await save(f,row,{maxTokens:393216});
  const runtime=await models.createModelRuntime(f.home);
  assert.equal(runtime.getModel("fixture","main").contextWindow,64000);
  assert.equal(runtime.getModel("fixture","main").maxTokens,393216);
});

test("metadata writes cannot piggyback credentials, provider creation, invalid fields or missing digests",async t=>{
  const f=await metadataFixture(t), row=(await inspect(f)).models[0], before=catalog(f);
  for(const args of [
    {apiKey:"replacement-key"},{custom:{api:"openai-completions",modelId:"other",baseUrl:f.endpoint}},
    {metadata:{modelId:"main",maxOutputTokens:12}}, {metadata:{modelId:"not-configured",contextWindow:20}},
    {metadata:{modelId:"main",contextWindow:-1}}, {metadata:{modelId:"main",input:["audio"]}},
    {expectedModelDigest:null},
  ]) await assert.rejects(saveGuiProvider(f.home,{providerId:"fixture",metadata:{modelId:"main",contextWindow:1048576},expectedModelDigest:row.expectedModelDigest,...args}));
  assert.deepEqual(catalog(f),before);
});

test("metadata failures and absent or malformed fields stay unknown and never echo server errors or follow redirects",async t=>{
  const target=await metadataFixture(t);
  for(const reply of [
    {data:[{id:"main"}]},
    {data:[{id:"main",context_window:"1048576",max_output_tokens:-1,input_modalities:["audio"]}]},
    (_req,res)=>{res.writeHead(302,{location:catalog(target).providers.fixture.baseUrl+"/models"});res.end();},
    (_req,res)=>{res.writeHead(401);res.end("fixture-secret server error");},
  ]){
    const f=await metadataFixture(t,reply), result=await inspect(f);
    assert.deepEqual(result.models[0].reported,{});assert.equal(f.requests.length,1);
    assert.doesNotMatch(JSON.stringify(result),/fixture-secret|server error/);
  }
  assert.equal(target.requests.length,0,"redirect destination receives no credential-bearing request");
});

test("new custom providers and legacy imports omit unknown capability placeholders",async t=>{
  const f=await fixture(t), runtime=await models.createModelRuntime(f.home);
  await selectModelRef({runtime,home:f.home,role:"test",io:{
    select:async label=>label.includes("服务商")?"custom":"openai-completions",
    prompt:async p=>p.type==="secret"?"new-key":({"自定义配置 ID":"new-provider","API 根地址":f.endpoint,"模型 ID":"new-model"})[p.message],notify(){},
  }});
  const custom=catalog(f).providers["new-provider"].models[0];
  assert.equal(custom.contextWindow,undefined);assert.equal(custom.maxTokens,undefined);
  writeFileSync(join(f.home,"config.json"),JSON.stringify({main:{baseUrl:f.endpoint,model:"main",apiKey:"old-key"},reviewer:{baseUrl:f.endpoint,model:"r1",apiKey:"old-key2"}}));
  const imported=await importLegacyConfig({home:f.home});
  const legacy=catalog(f).providers[imported.config.main.provider].models[0];
  assert.equal(legacy.contextWindow,undefined);assert.equal(legacy.maxTokens,undefined);assert.equal(f.calls.length,0);
  const facts=await models.projectModelFacts(await models.createModelRuntime(f.home),{provider:"new-provider",modelId:"new-model"});
  assert.equal(facts.capabilitySources.contextWindow,"sdk_default");
});

test("refreshed catalog capabilities retain frozen max thinking and omit optional request caps on real SDK wire",async t=>{
  const f=await metadataFixture(t), row=(await inspect(f)).models[0];
  await save(f,row,row.reported);
  // Send generation to the existing streaming fixture; metadata inspection never uses this route.
  catalog(f,c=>{c.providers.fixture.baseUrl=f.endpoint;});
  const {createRuntime}=await import("../src/pi-runtime.js"), {createTask}=await import("../src/task.js");
  const ref={provider:"fixture",modelId:"main",thinkingLevel:"max"};
  const task=createTask({home:f.home,input:"q",models:{main:ref,secondary:[]},singleModel:true});
  const rt=await createRuntime({home:f.home,cwd:f.home,modelRef:ref});t.after(()=>rt.dispose());
  rt.bindTask(task,task.beginPhase("draft","main",ref));await rt.prompt("q");
  assert.equal(rt.modelRuntime.getModel("fixture","main").contextWindow,1048576);
  assert.equal(rt.modelRuntime.getModel("fixture","main").maxTokens,393216);
  assert.equal(f.calls[0].body.reasoning_effort,"max");
  for(const field of ["max_tokens","max_output_tokens","max_completion_tokens"]) assert.equal(field in f.calls[0].body,false);
  assert.equal(f.calls.length,1);assert.equal(f.requests.length,1);
});

test("settings inspect only on explicit click and save only chosen capability fields without a key",async()=>{
  const React=await import("react"), {act}=React;
  const {modalEnvironment}=await import("./gui-modal.fixture.js");
  await modalEnvironment(async({root,container,win,Settings})=>{
    let reads=0;const saves=[];
    const row={modelId:"main",name:"Main",current:{contextWindow:32000,maxTokens:4096,input:["text"]},
      reported:{contextWindow:1048576,maxTokens:393216,input:["text","image"]},
      sources:{contextWindow:"local_config_unverified",maxTokens:"local_config_unverified",input:"local_config_unverified"},
      expectedModelDigest:{contextWindow:"a",maxTokens:"b",input:"c"}};
    await act(()=>root.render(React.createElement(Settings,{initialTab:"providers",boot:{configured:true,providers:[{id:"fixture",name:"Fixture",configured:true,apiKey:true}],models:[],teams:[],work:{},version:"fixture"},commands:{
      inspectProviderMetadata:async args=>{assert.deepEqual(args,{providerId:"fixture"});reads++;return {providerId:"fixture",status:"reported",checkedAt:"2026-11-12T00:00:00.000Z",models:[row]};},
      saveProvider:async args=>{saves.push(args);return {saved:true};},
    },onClose(){}})));
    const provider=container.querySelector("select");
    await act(()=>{provider.value="fixture";provider.dispatchEvent(new win.Event("change",{bubbles:true}));});
    assert.equal(reads,0);
    const button=[...container.querySelectorAll("button")].find(b=>b.textContent==="核对模型能力");
    assert.ok(button,"existing provider settings expose explicit metadata inspection");
    await act(async()=>button.click());assert.equal(reads,1);
    assert.match(container.textContent,/32000/);assert.match(container.textContent,/1048576/);assert.match(container.textContent,/未核实/);
    const check=container.querySelector('[aria-label="应用 main contextWindow"]');assert.equal(check.checked,false);
    await act(()=>check.click());
    await act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="保存所选能力").click());
    assert.equal(saves.length,1);assert.deepEqual(saves[0],{providerId:"fixture",metadata:{modelId:"main",contextWindow:1048576},expectedModelDigest:row.expectedModelDigest});
  });
});

test("bound tasks enforce saved context capability and diagnosis after a live catalog change",async t=>{
  const f=await fixture(t), ref={provider:"fixture",modelId:"main",thinkingLevel:"max"};
  catalog(f,c=>{c.providers.fixture.models[0].contextWindow=64;});
  const oldRuntime=await models.createModelRuntime(f.home), facts=await models.projectModelFacts(oldRuntime,ref);
  catalog(f,c=>{c.providers.fixture.models[0].contextWindow=1048576;});
  const {createRuntime}=await import("../src/pi-runtime.js"), {createTask}=await import("../src/task.js");
  const task=createTask({home:f.home,input:"q",models:{main:ref,secondary:[]},singleModel:true});
  task.record.projectModelFacts=[facts];
  task.materialContext=[{manifest:{id:"text-material",name:"evidence.txt",mediaType:"text/plain",sha256:"a".repeat(64)},bytes:Buffer.from("x".repeat(1000))}];
  const rt=await createRuntime({home:f.home,cwd:f.home,modelRef:ref});t.after(()=>rt.dispose());
  rt.bindTask(task,task.beginPhase("draft","main",ref));
  await assert.rejects(rt.prompt("q"),error=>error.code==="MATERIAL_CONTEXT_LIMIT" && /64/.test(error.message) && /未核实/.test(error.message) && /模型与认证/.test(error.message));
  assert.equal(f.calls.length,0);assert.equal(rt.session.model.contextWindow,64);
});

test("new roots persist current capabilities while an existing task sends with its saved model and no output quota",async t=>{
  const f=await fixture(t), {runProjectTurn}=await import("../src/project-turn.js");
  const config={formatVersion:2,...f.models}, source=await runProjectTurn({home:f.home,cwd:f.home,input:"Explain one thing",frozenConfig:config,workspace:{id:null,project:null}});
  assert.equal(source.record.status,"completed",source.record.error);
  assert.equal(source.record.projectModelFacts[0].contextWindow,32000);
  assert.equal(source.record.projectModelFactsSource,"current_at_task_start");
  const {readTask,createTask}=await import("../src/task.js");
  assert.equal(readTask(f.home,source.record.id).projectModelFacts[0].maxTokens,4096);
  catalog(f,c=>{const m=c.providers.fixture.models[0];m.contextWindow=1048576;m.maxTokens=393216;m.input=["text","image"];});
  const {createRuntime}=await import("../src/pi-runtime.js"),ref={...f.models.main,thinkingLevel:"max"};
  const frozen=createTask({home:f.home,input:"q",models:{main:ref,secondary:[]},singleModel:true});
  frozen.record.projectModelFacts=structuredClone(source.record.projectModelFacts);
  const rt=await createRuntime({home:f.home,cwd:f.home,modelRef:ref});t.after(()=>rt.dispose());
  rt.bindTask(frozen,frozen.beginPhase("draft","main",ref));await rt.prompt("q");
  assert.equal(rt.session.model.contextWindow,32000);assert.equal(rt.session.model.maxTokens,4096);assert.deepEqual(rt.session.model.input,["text"]);
  assert.equal(f.calls[1].body.reasoning_effort,"max");
  for(const field of ["max_tokens","max_output_tokens","max_completion_tokens"])assert.equal(field in f.calls[1].body,false);
  const next=await runProjectTurn({home:f.home,cwd:f.home,input:"A new question",frozenConfig:config,workspace:{id:null,project:null}});
  assert.equal(next.record.projectModelFacts[0].contextWindow,1048576);assert.equal(next.record.projectModelFacts[0].maxTokens,393216);
});

test("a saved task refuses changed routing before sending and metadata actions use the existing controller",async t=>{
  const f=await metadataFixture(t), {createGuiController}=await import("../src/gui-controller.js");
  const controller=await createGuiController({home:f.home,cwd:f.home});
  const {startGuiServer}=await import("../src/gui-server.js"),server=await startGuiServer({home:f.home,cwd:f.home,open:false,controller});t.after(()=>server.close());
  const origin=new URL(server.url).origin, action=(action,args)=>fetch(origin+"/api/action",{method:"POST",headers:{authorization:`Bearer ${server.token}`,origin,"content-type":"application/json","X-CoThink-GUI-Input":GUI_INPUT_VERSION},body:JSON.stringify({action,args})});
  const response=await action("provider.inspectMetadata",{providerId:"fixture"});assert.equal(response.status,200,await response.clone().text());
  const result=await response.json(),row=result.models[0];
  const saved=await action("provider.save",{providerId:"fixture",metadata:{modelId:row.modelId,contextWindow:1048576},expectedModelDigest:row.expectedModelDigest});assert.equal(saved.status,200,await saved.clone().text());
  assert.equal(catalog(f).providers.fixture.models[0].contextWindow,1048576);assert.equal(f.requests.length,1);
  await assert.rejects(controller.action("provider.inspectMetadata",{providerId:"fixture",baseUrl:"https://unselected.invalid"}));
  const runtime=await models.createModelRuntime(f.home), facts=await models.projectModelFacts(runtime,f.models.main);
  catalog(f,c=>{c.providers.fixture.baseUrl=f.endpoint;});
  const {createRuntime}=await import("../src/pi-runtime.js"),{createTask}=await import("../src/task.js");
  const task=createTask({home:f.home,input:"q",models:{main:f.models.main,secondary:[]},singleModel:true});task.record.projectModelFacts=[facts];
  const rt=await createRuntime({home:f.home,cwd:f.home,modelRef:f.models.main});t.after(()=>rt.dispose());rt.bindTask(task,task.beginPhase("draft","main",f.models.main));
  await assert.rejects(rt.prompt("q"),{code:"MODEL_ROUTE_CHANGED"});assert.equal(f.calls.length,0);
});

test("legacy import preserves explicitly supplied capacity values without treating a request quota as capability",async t=>{
  const f=await fixture(t);
  writeFileSync(join(f.home,"config.json"),JSON.stringify({
    main:{baseUrl:f.endpoint,model:"main",apiKey:"old-key",contextWindow:64000,maxTokens:8000,maxOutputTokens:77},
    reviewer:{baseUrl:f.endpoint,model:"r1",apiKey:"old-key2",maxOutputTokens:55},
  }));
  const imported=await importLegacyConfig({home:f.home}),c=catalog(f);
  const main=c.providers[imported.config.main.provider].models[0],secondary=c.providers[imported.config.secondary[0].provider].models[0];
  assert.equal(main.contextWindow,64000);assert.equal(main.maxTokens,8000);assert.equal(imported.config.main.maxOutputTokens,77);
  assert.equal(secondary.contextWindow,undefined);assert.equal(secondary.maxTokens,undefined);assert.equal(imported.config.secondary[0].maxOutputTokens,55);
});

test("offline metadata checks and corrupt local catalogs preserve original files without contacting the provider",async t=>{
  const f=await metadataFixture(t), previous=process.env.PI_OFFLINE;
  process.env.PI_OFFLINE="1";
  try {const result=await inspect(f);assert.equal(result.status,"unavailable");assert.match(result.message,/PI_OFFLINE/);}
  finally {if(previous===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=previous;}
  assert.equal(f.requests.length,0);
  const path=join(f.home,"pi/models.json"),bad="{broken-catalog-private-key";writeFileSync(path,bad);
  await assert.rejects(inspect(f),error=>error.code==="MODEL_CATALOG_INVALID"&&!error.message.includes("private-key"));
  assert.equal(readFileSync(path,"utf8"),bad);assert.equal(f.requests.length,0);
});
test("metadata rejects a body above 1 MiB and times out a partial body after its technical deadline",{timeout:15000},async t=>{
  const large=await metadataFixture(t,{data:[],padding:"x".repeat(1024*1024)});
  const oversized=await inspect(large);assert.equal(oversized.status,"unavailable");assert.match(oversized.message,/1 MiB/);
  const stalled=await metadataFixture(t,(_req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.write('{"data":[');});
  const timedOut=await inspect(stalled);assert.equal(timedOut.status,"unavailable");assert.match(timedOut.message,/10 秒/);assert.equal(stalled.calls.length,0);
});
