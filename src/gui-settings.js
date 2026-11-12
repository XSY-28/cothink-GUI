import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CredentialSynchronizationError, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModelRuntime, projectModelFacts } from "./pi-runtime.js";
import { loadConfig, updateConfig, positiveInteger, validateConfig } from "./config.js";
import {
  addTeam,
  createTeamConfig,
  normalizeTeamName,
  removeTeam,
} from "./teams.js";
import { selectModelRef } from "./setup.js";
import { acquireSessionWriter, privateDirectory, writePrivateJson } from "./storage.js";
import {normalizeThinkingPreference} from "./thinking.js";
export {validateThinkingModels as validateGuiThinking} from "./thinking.js";
export { saveGuiBuiltinSkills, saveGuiLocalSkills } from "./gui-skills.js";

export async function saveGuiTeam(home, { name, main, secondary }) {
  main = {...main, thinkingLevel:normalizeThinkingPreference(main?.thinkingLevel)};
  secondary = secondary.map(ref=>({...ref,thinkingLevel:normalizeThinkingPreference(ref.thinkingLevel)}));
  const team = {
    id: randomUUID(),
    name: normalizeTeamName(name),
    main,
    secondary,
  };
  const runtime = await createModelRuntime(home);
  validateConfig({formatVersion:2,main,secondary});
  if (!secondary.length) throw Error("请配置至少一个副模型。");
  for (const ref of [main,...secondary]) {
    const model=await projectModelFacts(runtime,ref);
    if (!model.available) throw Object.assign(Error(model.unavailableReason),{code:model.unavailableCode});
  }
  updateConfig(home, (current) =>
    current?.formatVersion === 3
      ? addTeam(current, team)
      : current
        ? createTeamConfig({ ...current, main, secondary }, team.name, team.id)
        : createTeamConfig(
            { formatVersion: 2, main, secondary },
            team.name,
            team.id,
          ),
  );
  return team;
}
export function removeGuiTeam(home, teamId, currentTeam) {
  return updateConfig(home, (c) =>
    removeTeam(c, { targetId: teamId, currentTeam }),
  );
}
export function saveGuiWork(home, work) {
  if (
    !work ||
    typeof work !== "object" ||
    Array.isArray(work) ||
    Object.keys(work).some((k) => !["checks", "execution", "maxConcurrentRequests"].includes(k))
  )
    throw Error("工作设置只接受检查、执行环境和项目并发上限。");
  return updateConfig(home, (c) => {
    if (!c) throw Error("请先保存 Team。");
    return { ...c, work: structuredClone(work) };
  }).work;
}
export async function saveGuiProvider(home, { providerId, apiKey, custom }) {
  if (
    typeof providerId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(providerId)
  )
    throw Error("服务商 ID 无效。");
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
const authPromptMessages = {
  text:"请输入服务商要求的内容。",
  secret:"请输入服务商要求的密钥。",
  select:"请选择认证方式。",
  manual_code:"如果浏览器没有自动返回，请粘贴授权回调地址或服务商显示的代码。",
};
function safeAuthorizationUrl(value, userCode) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        [...url.searchParams].some(([key,value])=>
          /^code$/i.test(key) ? !userCode || value!==userCode :
          /^(?:device_code|.*token|.*secret|api.?key|password)$/i.test(key)))
      return null;
    return url;
  } catch {return null;}
}

/** Keeps Pi callbacks and credential values on the host. Only a single current prompt may be answered. */
export function createGuiOAuthManager(home, { onChange = () => {}, createRuntime = createModelRuntime } = {}) {
  const byId = new Map(), running = new Map();
  let closed = false, authSettings;
  const project = entry => structuredClone(entry.view);
  const unknown = operationId => ({
    operationId, status:"unknown", saved:null, message:"无法确认此登录结果；请先查看已有认证。", prompt:null, notification:null,
  });
  function finishPrompt(entry, value, error) {
    const prompt = entry.prompt;
    if (!prompt) return;
    prompt.signal?.removeEventListener("abort", prompt.abort);
    entry.prompt = null;
    entry.view.prompt = null;
    if (error) prompt.reject(error);
    else prompt.resolve(value);
    onChange();
  }
  function promptFor(entry, request) {
    const signal = entry.abort.signal;
    signal.throwIfAborted();
    request.signal?.throwIfAborted();
    if (entry.prompt || !Object.hasOwn(authPromptMessages,request.type))
      throw Error("此登录步骤暂不支持。");
    const id = randomUUID();
    // Provider option IDs stay on the host; they need not be suitable for publication.
    const options = request.type === "select" ? request.options.map((option,index)=>({
      id:String(index), label:String(option.label).slice(0,100),
    })) : undefined;
    return new Promise((resolve,reject) => {
      const abort = () => finishPrompt(entry, undefined, new DOMException("已取消输入","AbortError"));
      entry.prompt = {resolve,reject,abort,signal:request.signal,optionIds:request.options?.map(option=>option.id)};
      const message = request.type==="text" && entry.view.providerId==="github-copilot" ?
        "请输入 GitHub Enterprise 的地址或域名。使用 github.com 时可留空。" :
        authPromptMessages[request.type];
      entry.view.prompt = {id,type:request.type,message, ...(options ? {options}: {})};
      request.signal?.addEventListener("abort",abort,{once:true});
      onChange();
    });
  }
  function notifyFor(entry, event) {
    if (entry.abort.signal.aborted || running.get(entry.view.providerId)!==entry) return;
    if (event.type === "auth_url" || event.type === "device_code") {
      const userCode = event.type==="device_code" && typeof event.userCode==="string" &&
        /^[A-Z0-9-]{1,32}$/i.test(event.userCode) ? event.userCode : undefined;
      const url = safeAuthorizationUrl(event.type==="auth_url" ? event.url : event.verificationUri,userCode);
      if (!url) {
        entry.unsupportedLink = true;
        entry.abort.abort(new DOMException("服务商未提供可安全打开的 HTTPS 授权地址。","AbortError"));
        finishPrompt(entry,undefined,entry.abort.signal.reason);
        return;
      }
      entry.url = url.href;
      entry.view.notification = {type:event.type, url:url.origin};
      if (userCode) entry.view.notification.userCode = userCode;
      if (Number.isFinite(event.expiresInSeconds) && event.expiresInSeconds>0)
        entry.view.notification.expiresInSeconds = event.expiresInSeconds;
    } else if (["progress","info"].includes(event.type) && !entry.url) {
      entry.view.notification = {type:event.type,message:"等待服务商完成授权。"};
    } else return;
    onChange();
  }
  async function login(entry) {
    const {providerId} = entry.view, {signal} = entry.abort;
    let usedDeviceId = false;
    let status = "failed", message = "OAuth 未完成；请核对服务商授权和本机认证存储。", saved = false;
    try {
      signal.throwIfAborted();
      const runtime = await createRuntime(home);
      signal.throwIfAborted();
      if (!runtime.getProvider(providerId)?.auth?.oauth?.login) {
        status = "unsupported";
        message = "当前服务商没有提供可交互的 OAuth 登录。";
        return;
      }
      await runtime.login(providerId, "oauth", {signal,prompt:request=>promptFor(entry,request),notify:event=>notifyFor(entry,event)}, {
        getDeviceId() {
          const dir = join(home,"pi");
          if (!authSettings) {
            privateDirectory(dir);
            authSettings = SettingsManager.create(home,dir,{projectTrusted:false});
          }
          usedDeviceId = true;
          return authSettings.getOrCreateDeviceId();
        },
      });
      status = "saved";
      message = "OAuth 凭据已保存，之后可复用。";
      saved = true;
    } catch (error) {
      if (error instanceof CredentialSynchronizationError && error.operation === "login" && error.providerId === providerId) {
        status = "saved_with_warning";
        message = "凭据已保存，但本地模型状态尚未同步；请重新打开后查看。";
        saved = true;
      } else if (entry.unsupportedLink) {
        status = "unsupported";
        message = "服务商未提供可安全打开的 HTTPS 授权地址。";
      } else if (signal.aborted) {
        status = "cancelled";
        message = "已取消登录。";
      }
    } finally {
      if (usedDeviceId) {
        let writeFailed;
        try {
          await authSettings.flush();
          writeFailed = authSettings.drainErrors().length > 0;
        } catch {
          writeFailed = true;
        }
        if(writeFailed){
          if(saved)status="saved_with_warning";
          message=saved?"凭据已保存，但安装标识设置未能写入；请检查本机存储权限。":
            message+" 安装标识设置未能写入，请检查本机存储权限。";
        }
      }
      running.delete(providerId);
      Object.assign(entry.view,{status,message,saved,notification:null});
      entry.url = null;
      finishPrompt(entry, undefined, new DOMException("登录已结束","AbortError"));
      onChange();
    }
  }
  return {
    start(providerId) {
      if (closed) throw Error("认证入口已关闭。");
      if (typeof providerId!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(providerId))
        throw Error("服务商 ID 无效。");
      if (running.has(providerId)) return project(running.get(providerId));
      for (const [id, entry] of byId) {
        if (byId.size < 16) break;
        if (!running.has(entry.view.providerId)) byId.delete(id);
      }
      const operationId = randomUUID(), entry = {abort:new AbortController(),view:{
        operationId,providerId,status:"running",saved:null,message:"正在准备 OAuth 登录。",prompt:null,notification:null,
      }};
      byId.set(operationId, entry);
      running.set(providerId, entry);
      entry.completion=login(entry);
      onChange();
      return project(entry);
    },
    lookup(operationId) {
      return byId.has(operationId) ? project(byId.get(operationId)) : unknown(operationId);
    },
    snapshot() {return [...byId.values()].map(project);},
    authorizationUrl(operationId) {return byId.get(operationId)?.url ?? null;},
    respond(operationId,promptId,value) {
      const entry = byId.get(operationId);
      if (!entry?.view.prompt || entry.view.prompt.id !== promptId || entry.abort.signal.aborted ||
          typeof value!=="string" || value.length>8192) throw Error("登录输入已失效或无效。");
      if (entry.view.prompt.type==="select") {
        if (!entry.view.prompt.options.some(option=>option.id===value)) throw Error("认证选项无效。");
        value = entry.prompt.optionIds[Number(value)];
      }
      finishPrompt(entry,value);
      return project(entry);
    },
    cancel(operationId) {
      const entry = byId.get(operationId);
      if (!entry) return unknown(operationId);
      if (entry.view.status === "running") {
        entry.view.status = "cancelling";
        entry.view.notification = null;
        entry.url = null;
        entry.abort.abort(new DOMException("已取消登录","AbortError"));
        finishPrompt(entry,undefined,entry.abort.signal.reason);
        onChange();
      }
      return project(entry);
    },
    async close() {
      closed = true;
      const entries=[...running.values()];
      for (const entry of entries) this.cancel(entry.view.operationId);
      await Promise.all(entries.map(entry=>entry.completion));
    },
  };
}

const execFileAsync = promisify(execFile);
async function runLocalDocker(args) {
  const {PATH, HOME, USERPROFILE, SystemRoot} = process.env;
  const result = await execFileAsync("docker", args, {
    env:{PATH,HOME,USERPROFILE,SystemRoot},
    timeout:12_000, maxBuffer:64*1024, windowsHide:true,
  });
  return result.stdout.trim();
}
const fixedDigest = /^(?:[a-zA-Z0-9._/:-]+@)?sha256:[0-9a-f]{64}$/;
const imageId = /^sha256:[0-9a-f]{64}$/;
export function guiExecutionConfigDigest(work) {
  const stable = value => Array.isArray(value) ? value.map(stable) :
    value && typeof value==="object" ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(stable(work??{}))).digest("hex");
}

/** Read-only diagnostics unless the caller explicitly requests the fixed local container. */
export async function inspectGuiExecution(home, {probe = false, runDocker = runLocalDocker, onCleanupPending, work: frozenWork} = {}) {
  const work = frozenWork ?? loadConfig(home)?.work, execution = work?.execution;
  const configDigest = guiExecutionConfigDigest(work);
  const result = {checkedAt:new Date().toISOString(),configDigest,
    diagnostic:null,probe:{status:"not_run"}};
  function diagnostic(status, code, message, facts) {
    result.diagnostic = {status,code,message,...facts};
    return result;
  }
  if (!execution) return diagnostic("unavailable","EXECUTION_NOT_CONFIGURED","请先保存固定镜像和执行限额。");
  const {image,limits} = execution;
  if (execution.engine!=="docker" || execution.network!=="none" || typeof image!=="string" || !fixedDigest.test(image) ||
      !Number.isSafeInteger(limits?.memoryBytes) || limits.memoryBytes<16777216 ||
      !Number.isFinite(limits.cpus) || limits.cpus<=0 ||
      !Number.isSafeInteger(limits.pids) || limits.pids<2)
    return diagnostic("unavailable","EXECUTION_CONFIG","请核对固定镜像摘要、网络禁用和内存、CPU、进程限额。");
  let endpoint;
  try {
    endpoint = JSON.parse(await runDocker(["context","inspect","--format","{{json .Endpoints.docker.Host}}"]));
  } catch(error) {
    return error.code==="ENOENT" ? diagnostic("unavailable","DOCKER_MISSING","未找到 Docker 命令，请启动或安装 Docker 后重查。") :
      diagnostic("unavailable","DOCKER_CONTEXT","无法读取当前 Docker 连接，请核对 Docker context 后重查。");
  }
  const unix = typeof endpoint==="string" && /^unix:\/\/\/[^\0\r\n]+$/.test(endpoint);
  const pipe = typeof endpoint==="string" && process.platform==="win32" && /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint);
  if (!unix && !pipe)
    return diagnostic("unavailable","REMOTE_ENDPOINT","当前 Docker 连接不是本机 Unix socket 或 Windows 命名管道，请切换到本机 Docker。");
  // Pin all subsequent calls to the endpoint inspected above, even if the default context changes.
  const docker = args => runDocker(["--host",endpoint,...args]);
  const facts = {endpointKind:unix?"unix":"npipe",image};
  try {
    const version = await docker(["version","--format","{{.Server.Version}}"]);
    if (!/^\d+[\w.-]{1,39}$/.test(version)) throw Error("Invalid Docker server version");
    facts.daemonVersion = version;
  } catch {
    return diagnostic("unavailable","DAEMON_UNAVAILABLE","本机 Docker 未响应，请启动后重查。",facts);
  }
  try {
    const identity = await docker(["image","inspect","--format","{{.Id}}",image]);
    if (!imageId.test(identity) || image.startsWith("sha256:") && image!==identity) throw Error("Unexpected local image identity");
    facts.imageId = identity;
  } catch {
    return diagnostic("unavailable","IMAGE_UNAVAILABLE","本机没有与配置匹配的镜像，请选择已存在的固定镜像。",facts);
  }
  diagnostic("passed","LOCAL_IMAGE_FOUND","本机 Docker 已响应，固定镜像已存在。",facts);
  if (!probe) return result;
  if (!frozenWork && guiExecutionConfigDigest(loadConfig(home)?.work) !== configDigest) {
    result.probe = {status:"not_run",code:"CONFIG_CHANGED",message:"执行配置已改变，请重新检查。"};
    return result;
  }
  const name = "cothink-settings-probe-"+randomUUID();
  let passed = false, cleanupFailed = false;
  const removeProbe=async()=>{
    try {await docker(["rm","--force","--volumes",name]);}
    catch(error){
      if(!/no such container/i.test(error.stderr??""))
        throw Error("无法确认执行探针及其卷已清理，请核对本机 Docker 后重试。");
    }
  };
  try {
    await docker(["create","--name",name,"--pull=never","--network=none","--read-only",
      "--cap-drop=ALL","--security-opt=no-new-privileges","--ipc=private",
      "--no-healthcheck","--env","NODE_OPTIONS=",
      "--user",`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,
      "--memory",String(limits.memoryBytes),"--memory-swap",String(limits.memoryBytes),
      "--cpus",String(limits.cpus),"--pids-limit",String(limits.pids),
      "--entrypoint","/usr/local/bin/node",facts.imageId,"-e","process.exit(0)"]);
    await docker(["start","--attach",name]);
    const state = await docker(["container","inspect","--format","{{.State.Status}} {{.State.ExitCode}}",name]);
    passed = state === "exited 0";
  } catch {
    passed = false;
  } finally {
    try {await removeProbe();}
    catch {
      cleanupFailed=true;
      onCleanupPending?.(removeProbe);
    }
  }
  result.probe = cleanupFailed ?
    {status:"failed",code:"PROBE_CLEANUP",message:"无法确认探针容器已清理，请核对本机 Docker 后重查。",container:name} :
    passed ? {status:"passed",code:"PROBE_PASSED",message:"固定镜像可以在当前限制下启动、退出并清理。"} :
    {status:"failed",code:"PROBE_FAILED",message:"固定镜像未通过最小启动检查，请核对镜像中的 Node 和执行限额。"};
  return result;
}
