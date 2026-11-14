import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertFencedModelTransport, requiresModelOutputLimit } from "./request-policy.js";
import { privateDirectory } from "./storage.js";
import { DEFAULT_THINKING_LEVEL, validateModelThinking } from "./thinking.js";
import { workModelIdentity } from "./model-roster.js";

const capabilityFields = ["contextWindow", "maxTokens", "input"];
function publicModelRoute(model) {
  try {
    const url=new URL(model.baseUrl);
    return {api:model.api,baseUrl:url.origin+url.pathname};
  } catch { return {api:model?.api??null,baseUrl:null}; }
}
/** Apply only saved non-secret capabilities; a route change requires a new task. */
export function effectiveTaskModel(model, task) {
  const facts=(task?.record?.projectModelFacts??task?.rootOwner?.rootTask?.record?.projectModelFacts)?.find(fact=>fact.provider===model?.provider&&fact.modelId===model?.id);
  if (!model || !facts) return model;
  if (facts.route?.baseUrl) {
    let same=false;
    try {same=model.api===facts.route.api && new URL(model.baseUrl).href===new URL(facts.route.baseUrl).href;} catch {}
    if (!same) throw Object.assign(Error("所选模型路由与任务快照不同；请核对原服务商地址后继续，或创建新任务。"),{code:"MODEL_ROUTE_CHANGED"});
  }
  return {...model,...Object.fromEntries(capabilityFields.filter(field=>facts[field]!=null).map(field=>[field,structuredClone(facts[field])]))};
}
export function readModelCatalog(home) {
  const path = join(home, "pi", "models.json");
  if (!existsSync(path)) return {providers:{}};
  try {
    const value = JSON.parse(readFileSync(path,"utf8"));
    if (!value || typeof value!=="object" || !value.providers || typeof value.providers!=="object" || Array.isArray(value.providers)) throw Error();
    return value;
  } catch { throw Object.assign(Error("本地模型目录无法读取；请先修复设置，原文件未修改。"),{code:"MODEL_CATALOG_INVALID"}); }
}

function modelCapabilityProvenance(config,modelId) {
  const declaration=config?.models?.find(entry=>entry.id===modelId),override=config?.modelOverrides?.[modelId];
  const sources=Object.fromEntries(capabilityFields.map(field=>[field,override?.[field]!==undefined ? "model_override" :
    declaration?.[field]!==undefined ? "local_config_unverified" : declaration ? "sdk_default" : "bundled_catalog"]));
  return {declaration,override,sources};
}

/** Derived from the current catalog/overrides; this is not a remote capability guarantee. */
export function providerModelMetadata(runtime, catalog, providerId) {
  const config=catalog.providers?.[providerId], provider=runtime.getProvider(providerId);
  if (!provider) throw Error("服务商不可用。");
  return runtime.getModels(providerId).map(model=>{
    const {declaration,override,sources}=modelCapabilityProvenance(config,model.id);
    const current={}, expectedModelDigest={};
    // Route declarations matter even if a more specific model route currently masks them.
    const route=[providerId,model.id,model.api,model.baseUrl,config?.api??null,config?.baseUrl??null,
      declaration?.api??null,declaration?.baseUrl??null,override?.api??null,override?.baseUrl??null];
    for (const field of capabilityFields) {
      current[field]=model[field]??null;
      expectedModelDigest[field]=createHash("sha256").update(JSON.stringify({route,field,value:current[field],source:sources[field],
        declared:declaration?.[field]??null,override:override?.[field]??null})).digest("hex");
    }
    return {modelId:model.id,name:model.name??model.id,current,sources,expectedModelDigest};
  });
}

/** Explicit metadata GET only; it never refreshes Pi catalogs, imports models or generates. */
export async function inspectProviderMetadata({home,providerId,signal}) {
  if (typeof providerId!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(providerId)) throw Error("服务商 ID 无效。");
  const catalog=readModelCatalog(home), runtime=await createModelRuntime(home), provider=runtime.getProvider(providerId);
  const models=providerModelMetadata(runtime,catalog,providerId).map(row=>({...row,reported:{}}));
  const result={providerId,checkedAt:new Date().toISOString(),status:"unavailable",message:"服务未报告可核实的能力字段；保留本地配置。",models};
  if (process.env.PI_OFFLINE && process.env.PI_OFFLINE!=="0") return {...result,message:"PI_OFFLINE 已启用，未查询远端模型能力。"};
  // The endpoint comes solely from the user's selected, already configured provider.
  if (!runtime.hasConfiguredAuth(providerId)) return {...result,message:"请先配置此服务商认证。"};
  const apis=runtime.getModels(providerId).map(model=>model.api);
  if (!apis.some(api=>["openai-completions","openai-responses","anthropic-messages"].includes(api))) return result;
  // A metadata lookup is a bounded technical request, independent of model generation policy.
  const abort=new AbortController(), requestSignal=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  const deadline=setTimeout(()=>abort.abort(new DOMException("Metadata deadline","TimeoutError")),10_000);
  deadline.unref?.();
  let bodyTooLarge=false;
  try {
    requestSignal.throwIfAborted();
    const base=new URL(provider.baseUrl);
    if (!["https:","http:"].includes(base.protocol)||base.username||base.password||base.search||base.hash) return result;
    const resolution=await runtime.getAuth(providerId,{signal:requestSignal});
    requestSignal.throwIfAborted();
    if (!resolution) return {...result,message:"此服务商认证暂不可用；未查询能力。"};
    const auth=resolution.auth;
    if (auth.baseUrl && new URL(auth.baseUrl).href!==base.href) return {...result,message:"认证路由与所选服务地址不同；未查询能力。"};
    const headers=new Headers();
    const anthropic=apis.every(api=>api==="anthropic-messages");
    if (auth.apiKey) headers.set(anthropic?"x-api-key":"authorization",anthropic?auth.apiKey:`Bearer ${auth.apiKey}`);
    if (anthropic) headers.set("anthropic-version","2023-06-01");
    for (const [key,value] of Object.entries({...provider.headers,...auth.headers})) {
      if (value===null) headers.delete(key);else if(value!==undefined) headers.set(key,value);
    }
    headers.set("accept","application/json");
    base.pathname=base.pathname.replace(/\/+$/,"")+"/models";
    // Redirects are never followed, including same-origin redirects; credentials stay on this one URL.
    const response=await fetch(base,{method:"GET",headers,redirect:"manual",signal:requestSignal});
    if (!response.ok) {await response.body?.cancel();return {...result,message:"能力查询失败或地址发生重定向；保留本地配置。"};}
    const chunks=[];let bytes=0;
    for await (const chunk of response.body??[]) {
      bytes+=chunk.byteLength;
      if (bytes>1024*1024) {
        bodyTooLarge=true;abort.abort();throw Error("Metadata body limit");
      }
      chunks.push(chunk);
    }
    const body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
    if (!Array.isArray(body?.data)) return result;
    for (const row of models) {
      const entries=body.data.filter(item=>item?.id===row.modelId);
      if (entries.length!==1) continue;
      const item=entries[0];
      for (const [remote,local] of [["context_window","contextWindow"],["max_output_tokens","maxTokens"]])
        if (Number.isSafeInteger(item[remote]) && item[remote]>0) row.reported[local]=item[remote];
      if (Array.isArray(item.input_modalities) && item.input_modalities.length &&
          item.input_modalities.every(value=>["text","image"].includes(value))) row.reported.input=[...new Set(item.input_modalities)];
    }
    if (models.some(row=>Object.keys(row.reported).length)) Object.assign(result,{status:"reported",message:"服务端报告值仅供本次核对；勾选并保存后才影响后续任务。"});
    return result;
  } catch {
    return {...result,message:signal?.aborted ? "能力查询已取消；保留本地配置。" :
      bodyTooLarge ? "能力查询正文超过 1 MiB；保留本地配置。" :
      abort.signal.aborted ? "能力查询超过 10 秒技术期限；保留本地配置。" : "无法核实服务端能力；保留本地配置。"};
  } finally {clearTimeout(deadline);}
}

/** Local Pi catalog and host admission facts. Remote access remains unverified. */
export async function projectModelFacts(runtime, ref) {
  const identity = `${ref.provider}/${ref.modelId}`;
  const model = runtime.getModel(ref.provider, ref.modelId);
  const auth = !runtime.getProvider(ref.provider) ? null
    : runtime.hasConfiguredAuth(ref.provider) ? "configured" : "missing";
  const thinkingLevels = model ? await validateModelThinking(model) : null;
  const thinkingLevel = model ? ref.thinkingLevel ?? (model.reasoning ? DEFAULT_THINKING_LEVEL : "off") : null;
  const maxOutputTokens = ref.maxOutputTokens ?? null;
  const outputLimitRequired = requiresModelOutputLimit(model);
  let unavailableReason = null, unavailableCode = null, transport = null;
  if (model && (!model.type || model.type === "chat")) {
    try {
      assertFencedModelTransport(model);
      transport = "project-http";
    } catch (error) {
      unavailableReason = error.message;
      unavailableCode = error.code;
      transport = "unsupported";
    }
  } else {
    unavailableReason = `模型不可用：${identity}；目录中没有对应的对话模型。`;
    unavailableCode = "MODEL_UNAVAILABLE";
  }
  if (!unavailableReason && auth !== "configured") {
    unavailableReason = `服务商 ${ref.provider} 缺少凭据，请 /login。`;
    unavailableCode = "MODEL_UNAVAILABLE";
  }
  if (!unavailableReason && !thinkingLevels.includes(thinkingLevel)) {
    unavailableReason = `${identity} 不支持思考档位 ${thinkingLevel}；可用：${thinkingLevels.join(', ')}。`;
    unavailableCode = "MODEL_UNAVAILABLE";
  }
  if (!unavailableReason && outputLimitRequired && maxOutputTokens === null) {
    unavailableReason = `${model.api} 协议要求 maxOutputTokens，请明确配置后再发送。`;
    unavailableCode = "REQUIRED_OUTPUT_LIMIT";
  }
  const rates = model?.cost && Object.fromEntries(["input","output","cacheRead","cacheWrite"].map(key=>[
    key,Number.isFinite(model.cost[key]) ? model.cost[key] : null,
  ]));
  return {
    identity, provider:ref.provider, modelId:ref.modelId, name:model?.name ?? ref.modelId,
    actualModelIdentity:workModelIdentity(ref), available:unavailableReason === null, unavailableReason, unavailableCode,
    input:Array.isArray(model?.input) ? [...model.input] : null, reasoning:model?.reasoning ?? null, thinkingLevels, thinkingLevel,
    api:model?.api ?? null, transport, auth, toolCalling:null,
    route:publicModelRoute(model),
    contextWindow:model?.contextWindow ?? null, maxTokens:model?.maxTokens ?? null,
    capabilitySources:runtime.getModelCapabilitySources?.(ref.provider,ref.modelId) ?? null,
    maxOutputTokens, outputLimitRequired,
    estimatedUsdPerMillionTokens:rates && Object.values(rates).some(value=>typeof value === "number" && value > 0) ? rates : null,
  };
}

export function projectRoutingBudget(task, role = "main") {
  const root = task.rootOwner?.rootTask?.record;
  const remaining = (limit, used) => limit == null ? null : Math.max(0, limit - used);
  const rootRemaining = remaining(root?.budget?.maxCalls, (root?.rootRequests ?? []).filter(request=>!request.notSent).length);
  const project = task.projectPolicy?.budgetStatus?.();
  const limits = [rootRemaining, project?.remainingCalls].filter(value=>value != null);
  const reservedForChecks = task.rootOwner?.processCheck?.reserved(task.record.id,role) ?? 0;
  const hardCostCap = root?.budget?.maxCost ?? project?.maxCost ?? null;
  return {
    // The physical request carrying these facts also uses one call.
    remainingCalls:hardCostCap !== null ? 0 : limits.length ? remaining(Math.min(...limits),reservedForChecks+1) : null,
    rootRemainingCalls:rootRemaining, projectRemainingCalls:project?.remainingCalls ?? null,
    reservedForChecks, hardCostCap,
  };
}

export async function createModelRuntime(home) {
  let catalog=readModelCatalog(home);
  const agentDir = join(home, "pi");
  privateDirectory(agentDir);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  runtime.getModelCapabilitySources=(providerId,modelId)=>runtime.getModel(providerId,modelId) ?
    modelCapabilityProvenance(catalog.providers?.[providerId],modelId).sources : null;
  // Pi's flag covers create() only; native UI refreshes must use the same pinned catalog.
  const refresh = runtime.refresh.bind(runtime);
  const managedProviders = new Set();
  const builtinIds = new Set([...getBuiltinProviders(), "radius"]);
  let registering = false, pending = Promise.resolve();
  runtime.refresh = (options = {}) => {
    // Pi registration invokes refresh synchronously in the background. The enclosing
    // pass performs that refresh after all declarations are installed instead.
    if (registering) return Promise.resolve({ aborted: false, errors: new Map() });
    const run = pending.then(async () => {
      catalog=readModelCatalog(home);
      registering = true;
      try {
        for (const id of managedProviders) runtime.unregisterProvider(id);
        managedProviders.clear();
      } finally { registering = false; }
      // Reconcile the whole local config even when the UI requested one provider:
      // deleted identities must disappear and newly imported identities must appear.
      const first = await refresh({ ...options, providers: undefined, allowNetwork: false });
      registering = true;
      try { addModels(); } finally { registering = false; }
      const last = await refresh({ ...options, allowNetwork: false });
      return { aborted: first.aborted || last.aborted, errors: new Map([...first.errors, ...last.errors]) };
    });
    pending = run.catch(() => {});
    return run;
  };
  function officialEndpoint(baseUrl) {
    try {
      const url = new URL(baseUrl), path = url.pathname.replace(/\/+$/, "");
      if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return null;
      if (["api.moonshot.cn", "api.moonshot.ai"].includes(url.hostname) && path === "/v1") return "moonshot";
      if (url.hostname === "api.deepseek.com" && ["", "/v1"].includes(path)) return "deepseek";
    } catch { /* Unknown endpoints retain their declared capabilities. */ }
    return null;
  }
  function addModels() {
    // Register only current model definitions; Pi keeps ownership of endpoints and authentication.
    // The extension model layer must follow models.json: native providers alone cannot repair
    // imported reasoning:false declarations. Explicit user modelOverrides still apply last.
    for (let provider of runtime.getProviders()) {
      let models = [...(provider.getAllModels?.() ?? provider.getModels())], changed = false;
      const moonshot = ["moonshotai-cn", "moonshotai"].includes(provider.id);
      const canAddPro = (moonshot || (officialEndpoint(provider.baseUrl) === "moonshot" && !builtinIds.has(provider.id))) &&
        models.some(model => (!model.type || model.type === "chat") && model.api === "openai-completions");
      if (canAddPro && !models.some(model => (!model.type || model.type === "chat") && model.id === "kimi-k3.1-pro")) {
        const pro = {
          type: "chat", id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro",
          provider: provider.id, api: "openai-completions", baseUrl: provider.baseUrl,
          reasoning: true, input: ["text", "image"],
          contextWindow: 1048576, maxTokens: 1048576,
          thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
          // Pi's zero-price sentinel leaves CoThink's catalog estimate null, never a claim of free usage.
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: {
            supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
            maxTokensField: "max_completion_tokens", supportsStrictMode: false,
            thinkingFormat: "openai", requiresReasoningContentOnAssistantMessages: true,
            supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true,
          },
        };
        if (moonshot) {
          // Preserve the existing builtin fallback even if Pi rejects an empty user
          // provider overlay. Rebuild from the credential-free factory, never a composed provider.
          const base = provider.id === "moonshotai-cn" ? moonshotaiCnProvider() : moonshotaiProvider();
          const nativePro = { ...pro, baseUrl: base.baseUrl };
          runtime.registerNativeProvider({
            ...base, getModels: () => [...base.getModels(), nativePro],
            getAllModels: () => [...(base.getAllModels?.() ?? base.getModels()), nativePro],
          });
          managedProviders.add(provider.id);
          provider = runtime.getProvider(provider.id);
          models = [...(provider.getAllModels?.() ?? provider.getModels())];
        } else models.push(pro);
        changed = true;
      }
      models = models.map(model => {
        if ((model.type && model.type !== "chat") || model.api !== "openai-completions") return model;
        const endpoint = officialEndpoint(model.baseUrl);
        const kimi = endpoint === "moonshot" && ["kimi-k3", "kimi-k3.1-pro"].includes(model.id);
        const deepseek = endpoint === "deepseek" && model.id === "deepseek-flash";
        if (!kimi && !deepseek) return model;
        changed = true;
        return {
          ...model, reasoning: true,
          thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
          compat: { ...model.compat, supportsReasoningEffort: true, supportsDeveloperRole: false,
            requiresReasoningContentOnAssistantMessages: true, thinkingFormat: deepseek ? "deepseek" : "openai" },
        };
      });
      if (!changed) continue;
      managedProviders.add(provider.id);
      try { runtime.registerProvider(provider.id, { models }); }
      catch (error) {
        // Native registration historically retains builtin models on invalid user
        // overlays. Keep Pi's existing diagnostic and fallback rather than throwing
        // out the whole local catalog; new registration errors must still surface.
        if (!runtime.getError()?.includes(error.message)) throw error;
      }
    }
  }
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}
