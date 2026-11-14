import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createModelRuntime, readModelCatalog, providerModelMetadata } from "./pi-model-runtime.js";
import { positiveInteger } from "./config.js";
import { selectModelRef } from "./setup.js";
import { acquireSessionWriter, writePrivateJson } from "./storage.js";

export async function saveGuiProvider(home, args) {
  const {providerId,apiKey,custom,metadata,expectedModelDigest}=args;
  if (
    typeof providerId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(providerId)
  )
    throw Error("服务商 ID 无效。");
  if (metadata!==undefined) {
    if (Object.keys(args).some(key=>!["providerId","metadata","expectedModelDigest"].includes(key)))
      throw Error("保存能力不能同时修改认证或自定义服务商。");
    if (!metadata || typeof metadata!=="object" || Array.isArray(metadata) ||
        typeof metadata.modelId!=="string" || !metadata.modelId.trim() ||
        Object.keys(metadata).some(key=>!["modelId","contextWindow","maxTokens","input"].includes(key))) throw Error("模型能力字段无效。");
    const fields=Object.keys(metadata).filter(key=>key!=="modelId");
    if (!fields.length) throw Error("请选择要应用的能力字段。");
    for (const field of fields) {
      if (field==="input") {
        if (!Array.isArray(metadata.input) || !metadata.input.length || metadata.input.some(value=>!["text","image"].includes(value))) throw Error("输入类型无效。");
      } else positiveInteger(metadata[field],field);
      if (typeof expectedModelDigest?.[field]!=="string" || !/^[a-f0-9]{64}$/.test(expectedModelDigest[field])) throw Error("能力核对已失效，请重新核对。");
    }
    const lock=acquireSessionWriter(join(home,"provider-write"),"48b7614a-e0b7-4c05-925a-d33b7deed1d0");
    try {
      const runtime=await createModelRuntime(home), catalog=readModelCatalog(home);
      const row=providerModelMetadata(runtime,catalog,providerId).find(row=>row.modelId===metadata.modelId);
      if (!row || fields.some(field=>row.expectedModelDigest[field]!==expectedModelDigest[field]))
        throw Object.assign(Error("所选模型能力或路由已变化，请重新核对；原配置未覆盖。"),{code:"MODEL_METADATA_CHANGED"});
      catalog.providers ??= {};
      const provider=catalog.providers[providerId]??={};
      const model=provider.models?.find(model=>model.id===metadata.modelId);
      for (const field of fields) {
        // Preserve override ownership: never shadow an existing explicit override with a base value.
        const target=provider.modelOverrides?.[metadata.modelId]?.[field]!==undefined || !model ?
          ((provider.modelOverrides??={})[metadata.modelId]??={}) : model;
        target[field]=field==="input"?[...new Set(metadata.input)]:Number(metadata[field]);
      }
      writePrivateJson(join(home,"pi/models.json"),catalog,lock.assertOwned);
      return {providerId,modelId:metadata.modelId,saved:true,verified:false};
    } finally {lock.release();}
  }
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey))
    throw Error("API key 不能为空或包含换行。");
  if (custom) {
    if (!["openai-completions", "anthropic-messages"].includes(custom.api))
      throw Error("协议无效。");
    if (typeof custom.modelId !== "string" || !custom.modelId.trim())
      throw Error("模型 ID 不能为空。");
    if (custom.contextWindow !== undefined)
      positiveInteger(custom.contextWindow, "contextWindow");
    if (custom.maxTokens !== undefined)
      positiveInteger(custom.maxTokens, "maxTokens");
  }
  const lock = acquireSessionWriter(
    join(home, "provider-write"),
    "48b7614a-e0b7-4c05-925a-d33b7deed1d0",
  );
  try {
    const runtime = await createModelRuntime(home);
    if (custom) {
      // Use the same catalog conflict, endpoint and Pi authentication path as CLI setup.
      const values = {
        "自定义配置 ID": providerId,
        "API 根地址": custom.baseUrl,
        "模型 ID": custom.modelId,
      };
      await selectModelRef({
        runtime,
        home,
        role: "GUI",
        io: {
          select: async (label) => (label === "协议" ? custom.api : "custom"),
          prompt: async (p) =>
            p.type === "secret" ? apiKey : values[p.message],
          notify() {},
        },
      });
      const path = join(home, "pi/models.json"),
        models = JSON.parse(readFileSync(path, "utf8"));
      const model = models.providers[providerId].models[0];
      if (custom.name !== undefined) model.name = String(custom.name);
      if (custom.contextWindow !== undefined)
        model.contextWindow = Number(custom.contextWindow);
      if (custom.maxTokens !== undefined)
        model.maxTokens = Number(custom.maxTokens);
      writePrivateJson(path, models, lock.assertOwned);
    } else {
      const provider = runtime.getProvider(providerId);
      if (!provider) throw Error("服务商不可用。");
      if (!provider.auth?.apiKey?.login)
        throw Error(
          "此服务商需要 OAuth 或环境认证；请在 CLI 使用 cothink 后 /login。已有 OAuth 可直接复用。",
        );
      try {
        await runtime.login(providerId, "api_key", {
          prompt: async () => apiKey,
          notify() {},
        });
      } catch {
        throw Error("认证未完成；请检查服务商认证方式和本机存储权限。");
      }
    }
    return { providerId, saved: true, verified: false };
  } finally {
    lock.release();
  }
}
