import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers/pi-fixture.js";
const api = await import("../src/pi-runtime.js").catch(() => ({}));

// These are the two imported official routes whose old catalog declares reasoning:false.
// Keep the fixture independent of local user configuration and use dummy credentials only.
function officialThinkingCatalog(f) {
  const path = join(f.home, "pi/models.json"), data = JSON.parse(readFileSync(path));
  for (const [provider, modelId, baseUrl] of [
    ["import-kimi", "kimi-k3", "https://api.moonshot.cn/v1"],
    ["import-deepseek", "deepseek-flash", "https://api.deepseek.com"],
  ]) data.providers[provider] = {
    api: "openai-completions", baseUrl, apiKey: "fixture-only",
    models: [{ id: modelId, name: `saved ${modelId}`, reasoning: false, input: ["text"],
      contextWindow: 32000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      compat: { maxTokensField: "max_completion_tokens" } },
      { id: "untouched-sibling", name: "Saved sibling", reasoning: false, contextWindow: 8192, maxTokens: 123 }],
  };
  writeFileSync(path, JSON.stringify(data));
  return { path, data };
}

test("official imported false declarations gain three thinking levels without taking ownership of configuration", async t => {
  const { validateModelThinking } = await import("../src/thinking.js");
  const f = await fixture(t), { path, data } = officialThinkingCatalog(f);
  const authPath = join(f.home, "pi/auth.json");
  writeFileSync(authPath, "{}");
  const before = readFileSync(path), runtime = await api.createModelRuntime(f.home);
  for (const instance of [runtime, await api.createModelRuntime(f.home)]) {
    await instance.refresh({ providers: ["import-kimi"], allowNetwork: true });
    for (const [provider, id, format] of [["import-kimi", "kimi-k3", "openai"], ["import-deepseek", "deepseek-flash", "deepseek"]]) {
      const model = instance.getModel(provider, id), saved = data.providers[provider].models[0];
      assert.equal(model.reasoning, true, `${provider}/${id} must correct the imported false capability`);
      assert.deepEqual(await validateModelThinking(model), ["low", "high", "max"]);
      assert.equal(model.compat.thinkingFormat, format);
      assert.equal(model.compat.requiresReasoningContentOnAssistantMessages, true);
      assert.equal(model.compat.supportsDeveloperRole, false);
      for (const key of ["name", "input", "contextWindow", "maxTokens", "cost"]) assert.deepEqual(model[key], saved[key]);
      assert.equal(model.baseUrl, data.providers[provider].baseUrl);
      assert.equal(model.compat.maxTokensField, "max_completion_tokens");
      assert.equal((await instance.getAuth(model)).auth.apiKey, "fixture-only");
      const sibling = instance.getModel(provider, "untouched-sibling");
      assert.equal(sibling.reasoning, false); assert.equal(sibling.maxTokens, 123);
      const ids = instance.getProvider(provider).getModels().map(model => model.id);
      assert.equal(ids.length, new Set(ids).size, "managed corrections must not duplicate models");
    }
  }
  assert.deepEqual(readFileSync(path), before);
  assert.equal(readFileSync(authPath, "utf8"), "{}");
  assert.equal(f.calls.length, 0);
});

test("official thinking corrections use the final exact endpoint and leave explicit modelOverrides authoritative", async t => {
  const f = await fixture(t), { path, data } = officialThinkingCatalog(f);
  const original = data.providers["import-kimi"];
  for (const [suffix, patch] of [
    ["proxy", { baseUrl: "https://example.invalid/v1" }],
    ["wrong-path", { baseUrl: "https://api.moonshot.cn/proxy/v1" }],
    ["http", { baseUrl: "http://api.moonshot.cn/v1" }],
    ["wrong-protocol", { api: "anthropic-messages" }],
  ]) data.providers[`kimi-${suffix}`] = { ...original, ...patch };
  data.providers["model-url"] = { ...original, baseUrl: "https://example.invalid/v1",
    models: [{ ...original.models[0], baseUrl: "https://api.moonshot.ai/v1/" }] };
  data.providers["model-proxy"] = { ...original,
    models: [{ ...original.models[0], baseUrl: "https://example.invalid/v1" }] };
  data.providers["import-kimi"].modelOverrides = { "kimi-k3": { reasoning: false, name: "Explicit override" } };
  data.providers["import-deepseek"].models.push({ ...data.providers["import-deepseek"].models[0], id: "deepseek-flash-other" });
  writeFileSync(path, JSON.stringify(data));
  const runtime = await api.createModelRuntime(f.home);
  assert.equal(runtime.getModel("model-url", "kimi-k3").reasoning, true);
  for (const provider of ["kimi-proxy", "kimi-wrong-path", "kimi-http", "kimi-wrong-protocol", "model-proxy", "import-kimi"])
    assert.equal(runtime.getModel(provider, "kimi-k3").reasoning, false, provider);
  assert.equal(runtime.getModel("import-kimi", "kimi-k3").name, "Explicit override");
  const facts = await api.projectModelFacts(runtime, { provider: "import-kimi", modelId: "kimi-k3", thinkingLevel: "high" });
  assert.equal(facts.available, false);
  assert.match(facts.unavailableReason, /不支持思考档位 high/);
  assert.equal(runtime.getModel("import-deepseek", "deepseek-flash-other").reasoning, false);
  assert.equal(f.calls.length, 0);
});

test("refresh removes official thinking corrections and credentials when imported definitions change or disappear", async t => {
  const f = await fixture(t), { path, data } = officialThinkingCatalog(f);
  data.providers["import-deepseek"].headers = { "X-Fixture": "old" };
  writeFileSync(path, JSON.stringify(data));
  const runtime = await api.createModelRuntime(f.home);
  assert.equal(runtime.getModel("import-deepseek", "deepseek-flash").reasoning, true);
  data.providers["import-deepseek"].baseUrl = "https://example.invalid/v1";
  data.providers["import-deepseek"].apiKey = "replacement-fixture";
  delete data.providers["import-deepseek"].headers;
  writeFileSync(path, JSON.stringify(data));
  await runtime.refresh();
  let model = runtime.getModel("import-deepseek", "deepseek-flash");
  assert.equal(model.reasoning, false);
  assert.equal(model.baseUrl, "https://example.invalid/v1");
  const auth = await runtime.getAuth(model);
  assert.equal(auth.auth.apiKey, "replacement-fixture");
  assert.equal(auth.auth.headers?.["X-Fixture"], undefined);
  data.providers["import-deepseek"].baseUrl = "https://api.deepseek.com/v1/";
  delete data.providers["import-deepseek"].apiKey;
  writeFileSync(path, JSON.stringify(data));
  await runtime.refresh();
  model = runtime.getModel("import-deepseek", "deepseek-flash");
  assert.equal(model.reasoning, true);
  assert.equal(await runtime.getAuth(model), undefined);
  data.providers["import-deepseek"].models = [];
  delete data.providers["import-kimi"];
  writeFileSync(path, JSON.stringify(data));
  await Promise.all([runtime.refresh(), runtime.refresh({ providers: ["import-deepseek"] })]);
  assert.equal(runtime.getModel("import-deepseek", "deepseek-flash"), undefined);
  assert.equal(runtime.getProvider("import-kimi"), undefined);
  const reopened = await api.createModelRuntime(f.home);
  assert.equal(reopened.getModel("import-deepseek", "deepseek-flash"), undefined);
  assert.equal(reopened.getProvider("import-kimi"), undefined);
  assert.equal(f.calls.length, 0);
});

// Intercept only the external transport. Catalog lookup, CoThink admission/journaling,
// SDK serialization, HTTP body parsing, and response/tool continuation stay real.
function routeThinkingRequestsLocally(t, f) {
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const original = new URL(url instanceof Request ? url.url : url);
    assert.ok(["api.openai.com", "api.moonshot.cn", "api.deepseek.com", "openrouter.ai"].includes(original.hostname), original.hostname);
    return fetch(new URL(original.pathname, f.endpoint).href, init);
  };
  t.after(() => { globalThis.fetch = fetch; });
}

test("all seven precise routes send low/high/max through the actual SDK HTTP payload and CoThink journal", async t => {
  const { createTask } = await import("../src/task.js");
  const f = await fixture(t, (call, n, req, res) => {
    if (!call.url.endsWith("/responses")) return { text: "fixture answer" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
    event({ type: "response.output_item.added", output_index: 0,
      item: { type: "message", id: `message-${n}`, role: "assistant", content: [] } });
    event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "fixture answer" });
    const completed = { type: "response.completed", response: { id: `response-${n}`, status: "completed",
      output: [{ type: "message", id: `message-${n}`, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "fixture answer", annotations: [] }] }],
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } } };
    event(completed); res.end();
    return null;
  });
  const { path, data } = officialThinkingCatalog(f);
  for (const provider of ["openai", "openrouter", "moonshotai-cn"]) data.providers[provider] = { apiKey: "fixture-only" };
  writeFileSync(path, JSON.stringify(data));
  const before = readFileSync(path);
  routeThinkingRequestsLocally(t, f);
  for (const [provider, modelId, format] of [
    ["openai", "gpt-6.1-sol", "nested"], ["openai", "gpt-6-astra", "nested"],
    ["moonshotai-cn", "kimi-k3.1-pro", "effort"], ["import-kimi", "kimi-k3", "effort"],
    ["import-deepseek", "deepseek-flash", "deepseek"],
    ["openrouter", "deepseek/deepseek-v4.1-flash", "nested"], ["openrouter", "z-ai/glm-5.3", "nested"],
  ]) await t.test(`${provider}/${modelId}`, async t => {
    for (const level of ["low", "high", "max"]) {
      const ref = { provider, modelId, thinkingLevel: level };
      const task = createTask({ home: f.home, input: "SDK thinking fixture", models: { main: ref, secondary: [] }, singleModel: true });
      const runtime = await api.createRuntime({ home: f.home, cwd: f.cwd, modelRef: ref });
      try {
        runtime.bindTask(task, task.beginPhase("draft", "main", ref));
        const count = f.calls.length, { call } = await runtime.prompt("short fixture");
        assert.equal(f.calls.length, count + 1);
        const body = f.calls.at(-1).body;
        assert.equal(body.model, modelId);
        assert.equal(call.requestedModel.thinkingLevel, level);
        assert.equal(call.actualModel.modelId, modelId);
        assert.equal(format === "nested" ? body.reasoning.effort : body.reasoning_effort, level);
        assert.equal(format === "nested" ? call.payload.reasoning.effort : call.payload.reasoning_effort, level);
        if (format === "deepseek") assert.deepEqual(body.thinking, { type: "enabled" });
        for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) assert.equal(field in body, false);
      } finally { await runtime.dispose(); }
    }
  });
  assert.equal(f.calls.length, 21);
  assert.deepEqual(readFileSync(path), before);
});

test("imported DeepSeek preserves reasoning_content across two tool continuations and a subsequent user turn", async t => {
  const { createTask } = await import("../src/task.js");
  const reasoning = ["Observe first.", "Check next.", "Deliver result."];
  const f = await fixture(t, (call, n, req, res) => {
    if (n > 3) return { text: "follow-up answer" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({
      id: "deepseek-tools", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason }],
    }) + "\n\n");
    chunk({ role: "assistant", reasoning_content: reasoning[n - 1] });
    if (n < 3) {
      chunk({ tool_calls: [{ index: 0, id: `deepseek-probe-${n}`, type: "function", function: { name: "probe", arguments: "{}" } }] });
      chunk({}, "tool_calls");
    } else { chunk({ content: "done" }); chunk({}, "stop"); }
    res.end("data: [DONE]\n\n");
    return null;
  });
  officialThinkingCatalog(f);
  routeThinkingRequestsLocally(t, f);
  const ref = { provider: "import-deepseek", modelId: "deepseek-flash", thinkingLevel: "max" };
  const task = createTask({ home: f.home, input: "tool reasoning fixture", models: { main: ref, secondary: [] }, singleModel: true });
  const runtime = await api.createRuntime({ home: f.home, cwd: f.cwd, modelRef: ref,
    toolDefinitions: [{ name: "probe", label: "Probe", description: "Fixture observation", parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "observed" }] }) }], activeToolNames: ["probe"] });
  t.after(() => runtime.dispose());
  runtime.bindTask(task, task.beginPhase("draft", "main", ref));
  task.record.mode = "work"; task.record.maxCalls = null; task.save();
  await runtime.prompt("observe twice");
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[2].body.messages.filter(m => m.role === "assistant").map(m => m.reasoning_content), reasoning.slice(0, 2));
  assert.deepEqual(f.calls[2].body.messages.filter(m => m.role === "tool").map(m => m.tool_call_id), ["deepseek-probe-1", "deepseek-probe-2"]);
  await runtime.prompt("continue");
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[3].body.messages.filter(m => m.role === "assistant").map(m => m.reasoning_content), reasoning);
  for (const { body } of f.calls) {
    assert.equal(body.reasoning_effort, "max");
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.messages.some(m => m.role === "developer"), false);
  }
});
test("thinking selection copies role refs, keeps source roster defaults and rejects unknown scopes", async () => {
  const {applyThinkingSelection} = await import("../src/thinking.js");
  const config = {main:{modelId:"manager",thinkingLevel:"high"},secondary:[{modelId:"worker",thinkingLevel:"medium"}],team:{main:{thinkingLevel:"high"}}};
  const all = applyThinkingSelection(config,{level:"low",scope:"all"});
  assert.equal(all.main.thinkingLevel,"low");
  assert.equal(all.secondary[0].thinkingLevel,"low");
  assert.equal(config.main.thinkingLevel,"high");
  assert.equal(config.secondary[0].thinkingLevel,"medium");
  assert.deepEqual(all.team,config.team,"named roster defaults remain the selection source");
  assert.equal(applyThinkingSelection(config,{level:"low"}).secondary[0].thinkingLevel,"medium");
  assert.deepEqual(applyThinkingSelection(config,{scope:"all"}),config);
  assert.throws(()=>applyThinkingSelection(config,{scope:"future"}),/作用范围/);
});
test("required extension load failure rejects host creation with zero requests", async (t) => {
  assert.equal(typeof api.createRuntime, "function", "Pi host is implemented");
  const f = await fixture(t);
  await assert.rejects(
    api.createRuntime({
      home: f.home,
      cwd: f.cwd,
      modelRef: f.models.main,
      extensionFactories: [
        () => {
          throw Error("broken extension");
        },
      ],
    }),
    /broken extension/,
  );
  assert.equal(f.calls.length, 0);
});
test("extension runtime failure is visible and blocks the provider send", async (t) => {
  const { createTask } = await import("../src/task.js");
  const f = await fixture(t);
  const rt = await api.createRuntime({
    home: f.home,
    cwd: f.cwd,
    modelRef: f.models.main,
    extensionFactories: [
      (pi) =>
        pi.on("before_provider_request", () => {
          throw Error("hook failed");
        }),
    ],
  });
  t.after(() => rt.dispose());
  const task = createTask({ home: f.home, input: "q", models: f.models });
  rt.bindTask(task, task.beginPhase("draft", "main", f.models.main));
  await assert.rejects(rt.prompt("q"), /hook failed/);
  assert.equal(f.calls.length, 0);
});

test("model catalog stays offline for native startup, reload and provider refresh", async (t) => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  const offline = process.env.PI_OFFLINE;
  const calls = [];
  delete process.env.PI_OFFLINE;
  globalThis.fetch = async (input) => {
    calls.push(String(input?.url ?? input));
    return new Response("", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  });
  const runtime = await api.createModelRuntime(f.home);
  await runtime.refresh();
  await runtime.refresh({ allowNetwork: true, providers: ["openrouter"] });
  assert.deepEqual(calls, [], "catalog refresh must use only the pinned local data");
});

test('model switching defaults to high, preserves explicit levels and rejects unsupported high',async t=>{
  const {readFileSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');
  const f=await fixture(t);const path=join(f.home,'pi/models.json'),data=JSON.parse(readFileSync(path));
  for(const m of data.providers.fixture.models.slice(0,3)){m.reasoning=true;m.compat={supportsReasoningEffort:true,thinkingFormat:'openai'};}
  data.providers.fixture.models[3].reasoning=false;
  data.providers.fixture.models[2].thinkingLevelMap={off:null,minimal:null,low:'low',medium:null,high:null,xhigh:null,max:null};
  writeFileSync(path,JSON.stringify(data));
  const rt=await api.createRuntime({home:f.home,cwd:f.cwd,modelRef:{...f.models.main,thinkingLevel:'low'}});t.after(()=>rt.dispose());
  assert.equal(rt.session.thinkingLevel,'low');
  await rt.selectModel(f.models.secondary[0]);assert.equal(rt.session.thinkingLevel,'high');
  await rt.selectModel({...f.models.secondary[0],thinkingLevel:'low'});assert.equal(rt.session.thinkingLevel,'low');
  await rt.selectModel(f.models.secondary[2]);assert.equal(rt.session.thinkingLevel,'off');
  await assert.rejects(rt.selectModel(f.models.secondary[1]),/不支持.*high/);
  assert.equal(f.calls.length,0);
});

test('role thinking selection uses SDK thinkingLevelMap in the actual provider request and journal', async t => {
  const {readFileSync,writeFileSync}=await import('node:fs'),{join}=await import('node:path');
  const {createTask}=await import('../src/task.js');
  const f=await fixture(t),path=join(f.home,'pi/models.json'),catalog=JSON.parse(readFileSync(path,'utf8'));
  const model=catalog.providers.fixture.models[0];
  model.reasoning=true;
  model.compat={supportsReasoningEffort:true,thinkingFormat:'openai'};
  model.thinkingLevelMap={low:'medium'};
  writeFileSync(path,JSON.stringify(catalog));
  const ref={...f.models.main,thinkingLevel:'low'},task=createTask({home:f.home,input:'mapping',models:{main:ref,secondary:[]}});
  const runtime=await api.createRuntime({home:f.home,cwd:f.cwd,modelRef:ref});t.after(()=>runtime.dispose());
  runtime.bindTask(task,task.beginPhase('draft','main',ref));
  const {call}=await runtime.prompt('mapping');
  assert.equal(call.requestedModel.thinkingLevel,'low');
  assert.equal(call.payload.reasoning_effort,'medium');
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].body.reasoning_effort,'medium');
});

test('explicit empty and singleton tool policies remain exact under managed resource registration',async t=>{
 const {createTask}=await import('../src/task.js');
 for(const selected of [[],['chosen']])await t.test(JSON.stringify(selected),async t=>{
   const f=await fixture(t),task=createTask({home:f.home,input:'Generate only',models:f.models});
   const rt=await api.createRuntime({home:f.home,cwd:f.cwd,modelRef:f.models.main,projectManaged:true,useFrozenSkills:true,contextAccess:true,
     activeToolNames:selected,toolDefinitions:[{name:'chosen',label:'Chosen tool',description:'Only explicitly selected tool',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}]})}]});
   t.after(()=>rt.dispose());rt.bindTask(task,task.beginPhase('draft','main',f.models.main));
   await rt.prompt('Generate only');
   assert.deepEqual((f.calls[0].body.tools??[]).map(x=>x.function.name),selected);
 });
});
