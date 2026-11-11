import { join } from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertFencedModelTransport, requiresModelOutputLimit } from "./request-policy.js";
import { privateDirectory } from "./storage.js";
import { DEFAULT_THINKING_LEVEL, validateModelThinking } from "./thinking.js";
import { workModelIdentity } from "./model-roster.js";

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
    contextWindow:model?.contextWindow ?? null, maxTokens:model?.maxTokens ?? null,
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
  const agentDir = join(home, "pi");
  privateDirectory(agentDir);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
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
