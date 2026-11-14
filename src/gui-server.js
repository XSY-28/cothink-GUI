import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { GUI_MATERIAL_CAPABILITIES } from "./gui-materials.js";
import { createGuiController } from "./gui-controller.js";
import { GUI_INPUT_VERSION } from "./gui-turn-options.js";

const maxBodyBytes = 1024 * 1024;
const actions = new Set([
  "material.begin", "material.cancel", "project.materials", "project.material.import",
  "oauth.start", "oauth.query", "oauth.respond", "oauth.cancel", "oauth.open", "settings.localSkills", "settings.inspectExecution",
  "home.draft", "home.reserve", "home.transfer", "home.clearReservation",
  "session.create", "session.fork", "session.archive", "session.pin", "session.close", "session.name", "session.draft", "session.mode",
  "session.team", "session.thinking", "session.view", "team.save", "team.remove",
  "workspace.create", "workspace.update", "workspace.bind", "workspace.rebind", "workspace.rebind.query",
  "provider.save", "provider.inspectMetadata", "settings.work", "settings.builtinSkills", "releaseNotes.ack", "project.inspect", "project.browse", "project.mkdir", "project.prepare",
  "extension.commands", "extension.command", "extension.reload", "extension.respond",
  "context.organize", "task.submit", "task.continuePrepared", "task.confirmWork", "task.inspectContinuation", "task.continueWork", "work.exportDraft", "task.cancel", "task.reveal", "updates.check", "updates.configure",
]);
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
};
function openBrowser(url) {
  // Argument arrays avoid a shell on every platform. cmd/start is deliberately unused.
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((yes, no) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.once("error", () => no(Error("无法打开浏览器，请使用本次启动链接手动打开。")));
    child.once("spawn", () => { child.unref(); yes(); });
  });
}
async function jsonBody(req) {
  if (!/^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i.test(req.headers["content-type"] ?? ""))
    throw fail(415, "变更接口要求 application/json。");
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes))
    throw fail(413, "JSON 请求超过 1 MiB。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw fail(413, "JSON 请求超过 1 MiB。");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw fail(400, "JSON 格式无效。"); }
}
function query(url, names, required = names) {
  for (const key of url.searchParams.keys())
    if (!names.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw fail(400, "查询参数无效。");
  for (const key of required)
    if (!url.searchParams.get(key)) throw fail(400, "缺少查询参数。");
}
function pageNumber(value, fallback, positive = false) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (positive && Number(value) === 0))
    throw fail(400, "分页参数无效。");
  return Number(value);
}

/** Loopback transport only; controller owns all durable task and session facts. */
export async function startGuiServer({ home, cwd = process.cwd(), port = 0, open = true, suggestedProject = cwd, installation = "browser", controller, assetDirectory = fileURLToPath(new URL("../gui/dist", import.meta.url)) }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("GUI 端口必须是 0—65535 的整数。");
  controller ??= await createGuiController({ home, cwd, suggestedProject, installation });
  const token = randomBytes(32).toString("base64url"),
    bearer = Buffer.from(`Bearer ${token}`),
    clients = new Set();
  let authority, origin, closing;
  const call = async (method, ...args) => {
    try { return await controller[method](...args); }
    catch (error) {
      // The controller's public methods redact credentials, including newly entered keys.
      const codes = ["HOST_SHUTTING_DOWN", "SHUTDOWN_UNSETTLED", "SESSION_STATE_CONFLICT", "SESSION_BUSY", "SESSION_NOT_PERSISTED", "SESSION_STATE_UNAVAILABLE", "CURSOR_EXPIRED", "WORKSPACE_CONFLICT", "WORKSPACE_UNAVAILABLE", "WORKSPACE_ARCHIVED", "DRAFT_CONFLICT", "VIEW_CONFLICT"];
      const fileCodes = ["FILE_UNSUPPORTED", "FILE_UNAVAILABLE", "FILE_PATH_INVALID", "FILE_IDENTITY_MISMATCH", "FILE_TOO_LARGE", "FILE_ENCODING_UNSUPPORTED", "FILE_TYPE_MISMATCH", "FILE_DIFF_UNSUPPORTED", "FILE_VERSION_MISMATCH", "FILE_NOT_FOUND", "FILE_DELETED", "FILE_PREVIEW_UNSUPPORTED", "FILE_PURPOSE_INVALID", "STATIC_PREVIEW_UNSUPPORTED"];
      const pluginCodes = ["EXTENSION_COMMAND", "EXTENSION_UI_UNSUPPORTED", "COMMAND_UNAVAILABLE", "UNADAPTED_PLUGIN"];
      const extraCodes=["SUBMISSION_CONFLICT","CONTEXT_BUSY","READ_SCOPE","READ_VERSION","PROJECT_SCOPE","PROJECT_PREPARATION_CHANGED","PROJECT_NOT_PREPARED","PROJECT_EXECUTION_REQUIRED","NETWORK_POLICY","PROPOSAL_BLOCKED","GUI_INPUT_UPGRADE","TURN_CONSTRAINTS"];
      const code = [...codes,...fileCodes,...pluginCodes,...extraCodes].includes(error.code) || /^MATERIAL_[A-Z_]+$/.test(error.code??"") ? error.code : undefined;
      throw Object.assign(fail(["FILE_TOO_LARGE","MATERIAL_LIMIT"].includes(code) ? 413 : code==="MATERIAL_UNKNOWN" ? 503 : code==="MATERIAL_NOT_FOUND" ? 404 : codes.includes(code)||["SUBMISSION_CONFLICT","MATERIAL_CONFLICT","MATERIAL_PENDING","READ_VERSION","GUI_INPUT_UPGRADE"].includes(code) ? 409 : 400, String(error.message).replaceAll(token, "[REDACTED]")), {code, ...(code?.startsWith("WORKSPACE_") && error.workspace && {workspace:error.workspace})});
    }
  };
  const headers = {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob: https:; font-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
  const send = (res, status, value, type = "application/json; charset=utf-8") => {
    res.writeHead(status, { ...headers, "Content-Type": type });
    res.end(type.startsWith("application/json") ? JSON.stringify(value ?? null) : value);
  };
  const server = createServer(async (req, res) => {
    try {
      if (closing) throw fail(503, "GUI 宿主正在关闭。");
      if (req.headers.host !== authority || (req.headers.origin !== undefined && req.headers.origin !== origin))
        throw fail(403, "Host 或 Origin 不受信任。");
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw fail(400, "请求路径无效。");
      const url = new URL(req.url, origin);
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const supplied = Buffer.from(req.headers.authorization ?? "");
        if (supplied.length !== bearer.length || !timingSafeEqual(supplied, bearer))
          throw fail(403, "需要本次启动凭据。");
        if(url.pathname==="/api/materials"){
          if(req.method==="POST"){
            query(url,["ownerId","uploadId"]);
            if(req.headers["x-cothink-gui-input"]!==GUI_INPUT_VERSION)
              throw Object.assign(fail(409,"需要新版 CoThink 界面。"),{code:"GUI_INPUT_UPGRADE"});
            if(req.headers["content-type"]!=="application/octet-stream")throw fail(415,"材料上传需要二进制请求。");
            const length=req.headers["content-length"];
            if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>GUI_MATERIAL_CAPABILITIES.imageBytes))
              throw Object.assign(fail(413,"材料超过二进制上传上限。"),{code:"MATERIAL_LIMIT"});
            const abort=new AbortController();
            const onClose=()=>{if(!res.writableEnded)abort.abort();};
            res.once("close",onClose);
            try {
              const uploaded=await call("materialUpload",{ownerId:url.searchParams.get("ownerId"),uploadId:url.searchParams.get("uploadId"),
                body:req.iterator({destroyOnReturn:false}),signal:abort.signal,stop:()=>req.destroy()});
              if(!res.destroyed)return send(res,200,uploaded);
              return;
            } finally {res.removeListener("close",onClose);}
          }
          if(req.method!=="GET")throw fail(405,"请求方法不允许。");
          query(url,["ownerId","uploadId","id","sha256","taskId"],["ownerId"]);
          const args=Object.fromEntries(url.searchParams);
          if(!args.id){
            if(args.sha256||args.taskId)throw fail(400,"缺少材料 ID。");
            return send(res,200,await call("materialQuery",args));
          }
          if(args.uploadId)throw fail(400,"请选择上传状态或材料字节。");
          const {manifest,bytes}=await call("materialRead",args);
          return send(res,200,bytes,manifest.mediaType.startsWith("text/")?"text/plain; charset=utf-8":manifest.mediaType);
        }
        const actionRoute = url.pathname === "/api/action";
        if (req.method !== (actionRoute ? "POST" : "GET")) throw fail(405, "请求方法不允许。");
        if (actionRoute) {
          query(url, []);
          const body = await jsonBody(req);
          if (!body || typeof body !== "object" || Array.isArray(body) ||
              Object.keys(body).some((k) => !["action", "args"].includes(k)) ||
              !actions.has(body.action) || !body.args || typeof body.args !== "object" || Array.isArray(body.args))
            throw fail(400, "操作或参数无效。");
          const receiptOnly=req.headers["x-cothink-gui-input"]!==GUI_INPUT_VERSION;
          if (body.action !== "project.inspect" && body.action !== "task.submit" && receiptOnly)
            throw Object.assign(fail(409,"需要新版 CoThink 界面。请重新打开应用；已保存草稿和历史保留。"),{code:"GUI_INPUT_UPGRADE"});
          return send(res, 200, await call("action", body.action, body.args,{receiptOnly}));
        }
        if (url.pathname === "/api/events") {
          query(url, []);
          res.writeHead(200, { ...headers, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
          const notify = () => {
            // Events are invalidations only, never controller payloads or task actions.
            if (!res.destroyed && !res.writableEnded && !res.write("event: invalidate\ndata: {}\n\n")) res.end();
          };
          const unsubscribe = controller.subscribe(notify);
          clients.add(res);
          res.once("close", () => { clients.delete(res); unsubscribe(); });
          notify();
          return;
        }
        if (url.pathname === "/api/shutdown") {
          query(url, []);
          return send(res, 200, await call("shutdownState"));
        }
        if(url.pathname === '/api/context-operation') {query(url,['operationId'],['operationId']);return send(res,200,await call('readContextOperation',url.searchParams.get('operationId')));}
        if (url.pathname === "/api/bootstrap") {
          query(url, []);
          return send(res, 200, await call("bootstrap"));
        }
        if(url.pathname==='/api/capabilities') {
          query(url,['sessionId','draftId'],[]);return send(res,200,await call('getSessionCapabilities',url.searchParams.get('sessionId'),url.searchParams.get('draftId')));
        }
        if(url.pathname==="/api/project-material"){
          query(url,["ownerId","source","version","path"],["ownerId","source","path"]);
          const {mediaType,bytes,sha256,sourceToken}=await call("projectMaterialPreview",Object.fromEntries(url.searchParams));
          res.writeHead(200,{...headers,"Content-Type":mediaType.startsWith("text/")?"text/plain; charset=utf-8":mediaType,
            "X-CoThink-Content-Hash":sha256,"X-CoThink-Material-Source":sourceToken});
          return res.end(bytes);
        }
        if (url.pathname === "/api/sessions") {
          query(url, ["query", "project", "workspaceId", "archived", "cursor", "limit"], []);
          const args = Object.fromEntries(url.searchParams);
          if (url.searchParams.has("project")) args.project = args.project === "" ? null : args.project;
          if (args.workspaceId === "") args.workspaceId = null;
          if (url.searchParams.has("limit")) args.limit = pageNumber(args.limit,50,true);
          return send(res,200,await call("sessions",args));
        }
        if(url.pathname === "/api/file" || url.pathname === "/api/file-diff") {
          const content=url.pathname === "/api/file";
          query(url,content?["taskId","version","path","purpose","draft"]:["taskId","version","path","draft"],["taskId","version","path"]);
          const ref=Object.fromEntries(["taskId","version","path"].map(k=>[k,url.searchParams.get(k)]));
          if(url.searchParams.has("draft")) {
            try {
              const draft=JSON.parse(url.searchParams.get("draft"));
              if(!draft||typeof draft!=="object"||Array.isArray(draft)||Object.keys(draft).length!==2||
                typeof draft.changeId!=="string"||typeof draft.baseVersion!=="string")throw Error();
              ref.draft=draft;
            } catch {throw Object.assign(Error("草稿引用无效。"),{code:"FILE_VERSION_MISMATCH"});}
          }
          if(!content)return send(res,200,await call("fileDiff",ref));
          const purpose=url.searchParams.get("purpose")??"source", result=await call("file",ref,{purpose});
          const filename=encodeURIComponent(result.filename).replace(/[!'()*]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase());
          res.writeHead(200,{...headers,"Content-Type":result.mediaType,"Content-Length":result.bytes.length,
            "Content-Disposition":`${purpose === "download" ? "attachment" : "inline"}; filename*=UTF-8''${filename}`,
            "X-CoThink-Representation":result.representation,"X-CoThink-Version":result.version,
            "X-CoThink-Content-Hash":result.contentHash,"X-CoThink-Source-Hash":result.sourceContentHash});
          return res.end(result.bytes);
        }
        if(url.pathname === "/api/artifact") {
          query(url,["id","ref","index"]);
          return send(res,200,await call("artifact",url.searchParams.get("id"),url.searchParams.get("ref"),pageNumber(url.searchParams.get("index"),0)),"image/png");
        }
        const method = { "/api/files": "files", "/api/session": "session", "/api/session-creation": "sessionCreation", "/api/task": "task", "/api/diff": "diff", "/api/patch": "patch", "/api/output": "output" }[url.pathname];
        if (!method) throw fail(404, "接口不存在。");
        const isOutput = method === "output";
        query(url, isOutput ? ["id", "ref", "offset", "limit"] : ["id"], isOutput ? ["id", "ref"] : ["id"]);
        const id = url.searchParams.get("id");
        if (isOutput) return send(res, 200, await call("output", id, url.searchParams.get("ref"), pageNumber(url.searchParams.get("offset"), 0), pageNumber(url.searchParams.get("limit"), 65536, true)));
        const result = await call(method, id);
        if (method === "patch") return send(res, 200, result, "text/plain; charset=utf-8");
        return send(res, 200, result);
      }
      if (!["GET", "HEAD"].includes(req.method)) throw fail(405, "请求方法不允许。");
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { throw fail(400, "资源路径无效。"); }
      if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) throw fail(403, "资源路径不允许。");
      let root;
      try { root = await realpath(assetDirectory); }
      catch (e) {
        if (e.code !== "ENOENT") throw e;
        return send(res, 503, "GUI 尚未构建。请在源码目录运行 npm run build:gui，然后重新启动 cothink gui。", "text/plain; charset=utf-8");
      }
      let path;
      try {
        path = await realpath(resolve(root, "." + (decoded === "/" ? "/index.html" : decoded)));
      } catch (e) {
        if (["ENOENT", "ENOTDIR"].includes(e.code)) throw fail(404, "资源不存在。");
        throw e;
      }
      if (!inside(root, path)) throw fail(403, "资源路径不允许。");
      if (!(await stat(path)).isFile()) throw fail(404, "资源不存在。");
      const data = await readFile(path);
      res.writeHead(200, { ...headers, "Content-Type": mime[extname(path)] ?? "application/octet-stream", "Content-Length": data.length });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (error) {
      if(res.destroyed)return;
      if (res.headersSent) return res.end();
      // Controller errors are already redacted; do not echo request bodies, URLs or tokens.
      const message = error.status ? error.message : "操作未完成，请刷新状态并检查配置或已保存记录。";
      send(res, error.status ?? 400, { error: message, ...(error.code ? {code:error.code} : {}), ...(error.workspace && {workspace:error.workspace}) });
    }
  });
  const beginShutdown = () => controller.beginShutdown?.() ?? Promise.resolve({settled:true});
  const shutdownState = () => controller.shutdownState?.() ?? {settled:false};
  let finalizing;
  async function close() {
    if (closing) return closing;
    if (finalizing) return finalizing;
    finalizing=(async()=>{
      const state=await beginShutdown();
      if (!state.settled) throw Object.assign(Error(state.reason || "宿主停止尚未确认。"),{code:"SHUTDOWN_UNSETTLED"});
      await controller.close();
      closing = new Promise((yes, no) => {
        for (const client of clients) client.end();
        server.close(e=>e && e.code !== "ERR_SERVER_NOT_RUNNING" ? no(e) : yes());
        server.closeAllConnections();
      });
      return closing;
    })();
    try {return await finalizing;} finally {finalizing=null;}
  }
  try {
    await new Promise((yes, no) => { server.once("error", no); server.listen(port, "127.0.0.1", () => { server.off("error", no); yes(); }); });
    authority = `127.0.0.1:${server.address().port}`;
    origin = `http://${authority}`;
    const url = `${origin}/#token=${token}`;
    void controller.checkForUpdates?.();
    if (open) {
      try { await openBrowser(url); }
      catch { process.stderr.write("无法自动打开浏览器，请使用本次启动链接手动打开。\n"); }
    }
    return { url, token, origin, beginShutdown, shutdownState, close, server };
  } catch (error) {
    await close();
    throw error;
  }
}
