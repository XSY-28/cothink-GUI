import {atomicWriteDefinition,writeSourceFiles} from './work-changes.js';
import {readTaskSkillResource} from "./skill-resources.js";
import { createPreviewTool, imageMime, binaryOutputNotice } from "./visual-preview.js";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, lstatSync, unlinkSync, realpathSync, existsSync } from "node:fs";
import { relative, resolve, isAbsolute, join, posix } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getAgentDir,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { inScope, withChangeQueue } from "./versioning.js";
import { problem } from "./task.js";
const exec = promisify(execFile),
  hash = (b) => createHash("sha256").update(b).digest("hex");
/** Pi schemas/rendering/matching with per-call operations; never raw host write or Shell. */
export function workspaceTools({
  task,
  stage,
  versioning,
  getChange,
  change,
  binding = {},
  ensureWrite,
  onChanged = () => {},
  readOnly = false,
  reviewVersion,
  assertOwned = () => {},
  onProgress = () => {},
  visualPreview = false,
}) {
  if (!versioning)
    throw problem("VERSIONING_REQUIRED", "工作工具必须绑定agent-sync实例。");
  getChange ??= () => change;
  binding.reads ??= new Map();
  binding.observations ??= new Map();
  binding.failedMutations ??= new Map();
  const prototypes = [
    createReadToolDefinition("."),
    createGrepToolDefinition("."),
    createFindToolDefinition("."),
    createLsToolDefinition("."),
    ...(!readOnly
      ? [
          atomicWriteDefinition(createWriteToolDefinition(".")),
          createEditToolDefinition("."),
          createBashToolDefinition(".", { exposeSessionEnvironment: false }),
        ]
      : []),
  ];
  if ((visualPreview || task.record.project) && !readOnly) {
    const preview=createPreviewTool({task,stage,versioning,getChange,binding,onChanged,assertOwned,onProgress});
    if(task.record.project){const execute=preview.execute;preview.execute=async(...args)=>{if(task.record.workRequest?.kind!=="html-svg"){await task.preflightVisual();task.record.workRequest={kind:"html-svg"};task.save();}return execute(...args);};}
    prototypes.push(preview);
  }
  function save() {
    try {
      task.save();
    } catch (e) {
      task.ioError = e;
      throw e;
    }
  }
  function guard() {
    assertOwned();
    if (task.signal.aborted || task.record.status !== "running" || task.ioError)
      throw (
        task.signal.reason ??
        task.ioError ??
        problem("TASK_ENDED", "任务已停止。")
      );
  }
  function pathOf(path, c) {
    if (
      typeof path !== "string" ||
      path.includes("\0") ||
      path.split(/[\\/]/).includes("..") ||
      (path.includes("\\") && process.platform !== "win32")
    )
      throw problem("PATH", "需要无歧义的工作区相对路径。");
    if (path.startsWith("output:"))
      throw problem("PATH", "output:只用于read日志，不能作为源码路径。");
    if(isAbsolute(path))for(const context of task.record.tools??[]) {
      if(context.kind!=="native_plugin_context"||context.changeId!==c.changeId)continue;
      const roots=[resolve(context.cwd)];try{roots.push(realpathSync(context.cwd));}catch{}
      for(const root of roots) {
        const rel=relative(root,resolve(path));
        if(!isAbsolute(rel)&&rel!==".."&&!rel.startsWith("../")) {path=rel||".";break;}
      }
      if(!isAbsolute(path))break;
    }
    const nativeRel = relative(c.workspace, resolve(c.workspace, path));
    // Normalize Windows separators.
    const rel = nativeRel.replaceAll("\\", "/");
    if (
      isAbsolute(nativeRel) ||
      rel === ".." ||
      rel.startsWith("../") ||
      rel.split("/").some((x) => x.toLowerCase() === ".git")
    )
      throw problem("WORKSPACE_ESCAPE", "文件路径不属于当前工作区。");
    return rel || ".";
  }
  const role = () => (typeof stage === "function" ? stage() : stage);
  async function logBuffer(ref) {
    const actor = role().role;
    const member = Boolean(task.record.project && task.projectPolicy && actor !== "main");
    const stageIds = member && new Set(task.record.stages.filter(s => s.role === actor).map(s => s.id));
    const allowed = [
      ...(task.record.tools ?? []).filter(t => !member || stageIds.has(t.stageId)).map(t => t.outputRef),
      ...(!member ? task.record.work?.acceptance ?? [] : []).flatMap((r) =>
        (r.checks ?? []).map((c) => c.outputRef),
      ),
      ...(!member ? task.record.work?.finalCheck?.checks ?? [] : []).map(c => c.outputRef),
      ...(task.record.work?.changes ?? []).filter(c => !member || c.actor === actor).flatMap((c) =>
        (c.candidates ?? []).flatMap((p) =>
          (p.precheck?.checks ?? []).map((c) => c.outputRef),
        ),
      ),
    ];
    if (!allowed.includes(ref))
      throw problem("OUTPUT_SCOPE", "日志不属于当前任务/项目。");
    const chunks = [];
    let offset = 0;
    for (;;) {
      const page = await versioning.read({ outputRef: ref, offset });
      chunks.push(Buffer.from(page.contentBase64, "base64"));
      if (page.eof) break;
      offset = page.nextOffset;
    }
    return Buffer.concat(chunks);
  }
  async function perform(def, id, args, signal, onUpdate, ctx) {
    if (def.name === "preview_html") {
      task.projectPolicy?.admit("read", {actor:role().role});
      return def.execute(id,args,signal);
    }
    if (reviewVersion && (def.name !== "read" || args.path?.startsWith("output:")))
      throw problem("REVIEW_SOURCE","Review may only read the fixed candidate and frozen skills.");
    const started = performance.now();
    guard();
    const pair=def.name==='write'&&Object.hasOwn(args,'files')?args.files:null;
    if(def.name==='write'&&(Object.hasOwn(args,'files')?(args.path!==undefined||args.content!==undefined||!Array.isArray(pair)||pair.length!==2||pair.some(f=>typeof f?.path!=='string'||typeof f.content!=='string')):
      typeof args.path!=='string'||typeof args.content!=='string'))throw problem('WRITE_INPUT','Supply path/content or exactly two files, not both.');
    if (!["write","edit","bash"].includes(def.name)) task.projectPolicy?.admit("read", {actor:role().role});
    // Read selected skills from the task copy; run inspected scripts in offline Docker.
    const resource = def.name === "read" && readTaskSkillResource(task,args.path);
    if(resource) {
      const native=createReadToolDefinition(resource.record.root,{operations:{access:async()=>{},readFile:async()=>resource.bytes,detectImageMimeType:async()=>imageMime(resource.bytes)}});
      const result=await native.execute(id,{...args,path:resource.path},signal,onUpdate,ctx);
      (task.record.tools??=[]).push({toolCallId:id,name:"read",stageId:role().id,actor:role().role,status:"completed",resourceName:resource.record.name,resourcePath:resource.path,sourcePath:resource.relativePath==="SKILL.md"?resource.record.sourcePath:join(resource.record.sourceDirectory,resource.relativePath),resourceHash:resource.hash,skillHash:resource.record.hash});
      save();return result;
    }
    const s = role(),
      combined = signal ? AbortSignal.any([signal, task.signal]) : task.signal;
    if (combined.aborted) throw combined.reason;
    const prior = (task.record.tools ?? []).find(
      (t) => t.toolCallId === id && t.stageId === s.id,
    );
    if (
      prior?.requestId &&
      ["completed", "unknown", "cancelled"].includes(prior.status)
    ) {
      const fact = await versioning.inspect({ requestId: prior.requestId });
      if (fact.status !== "not_found")
        return { content: [{ type: "text", text: JSON.stringify(fact) }] };
    }
    const trace = prior ?? {
      toolCallId: id,
      name: def.name,
      ...(["bash","write","edit"].includes(def.name)?{registeredAt:new Date().toISOString(),kernelDispatched:false}:{}),
      stageId: s.id,
      requestId: randomUUID(),
      status: "preparing",
      sessionFile: s.sessionFile,
    };
    if (!prior) (task.record.tools ??= []).push(trace);
    save();
    let c = getChange(),
      path,
      logRef,writePaths,
      tempPaths = new Set(),
      lastKernel;
    if (binding.readChangeId !== c.changeId) {
      binding.reads.clear();
      binding.observations.clear();
      binding.reviewedVersion = null;
      binding.readChangeId = c.changeId;
    }
    const isWrite = ["write", "edit", "bash"].includes(def.name);
    if (binding.unknownOperation && isWrite)
      throw problem(
        "OPERATION_UNKNOWN",
        "先查询未知操作 " + binding.unknownOperation + "；禁止用新ID重发。",
      );
    if (def.name === "read" && args.path?.startsWith("output:"))
      logRef = args.path.slice(7);
    else if(pair){
      writePaths=pair.map(f=>pathOf(f.path,c));
      if(new Set(writePaths).size!==2||writePaths.some(p=>!inScope(p,c.scope)))throw problem('SCOPE','Paired writes need two distinct paths in the current write scope.');
    }else if (def.name !== "bash") path = pathOf(args.path ?? ".", c);
    trace.sourcePath = path ?? null;
    const projectWrite = (commit = false) => task.projectPolicy?.admit(def.name === "bash" ? "shell" : "write", {
      actor:s.role, scope:writePaths??(path ? [path] : c.scope), changeId:c.changeId, privateVersion:c.privateVersion, candidate:c.candidateVersion, requestId:trace.requestId, toolCallId:id, commit,
    });
    if (isWrite) {
      projectWrite();
      if (ensureWrite)
        c = await ensureWrite(def.name === "bash" ? null : path, {
          signal: combined,
          trace,
          binding,
        });
      binding.readChangeId = c.changeId;
      if (c.readOnly)
        throw problem(
          "SCOPE_REQUIRED",
          "Shell/写入需要明确scope；请next_change或refresh_change说明范围。",
        );
      if (
        ["accepted", "abandoned", "interrupted", "outcome_unknown"].includes(
          c.status,
        )
      )
        throw problem(
          "CHANGE_CLOSED",
          "当前修改已结束，请next_change或明确恢复。",
        );
      if (def.name !== "bash" && (writePaths??[path]).some(p=>!inScope(p,c.scope)))
        throw problem(
          "SCOPE",
          "写入范围不足；refresh_change保留草稿后扩大范围。",
        );
    }
    trace.changeId = c.changeId;
    trace.cwd = c.workspace;
    trace.status = "running";
    save();
    onProgress({ type: "tool", tool: trace, task });
    guard();
    const cache = new Map();
    let native;
    async function sourceRead(absolute) {
      const p = pathOf(absolute, c);
      if (cache.has(p)) return cache.get(p);
      if (reviewVersion && !inScope(p,c.readScope))
        throw problem("SCOPE","Candidate read exceeds the reviewer’s authorized scope: " + p);
      const value = await versioning.read(reviewVersion ? {version:reviewVersion,path:p} : {changeId:c.changeId,path:p});
      if (reviewVersion) trace.reviewVersion = value.version;
      if (value.contentBase64 === null)
        throw Object.assign(problem("ENOENT", "文件不存在：" + p), { path: p });
      const bytes = Buffer.from(value.contentBase64, "base64");
      cache.set(p, bytes);
      binding.reads.set(p, { hash: value.contentHash, version: value.version });
      binding.observations.set("file:" + p, {
        path: p,
        kind: "file",
        fingerprint: value.contentHash,
        version: value.version,
      });
      return bytes;
    }
    async function writeSource(absolute,content) {
      lastKernel=await writeSourceFiles({versioning,c,binding,trace,files:Array.isArray(absolute)?absolute:[{path:absolute,content}],
        editing:def.name==='edit',cache,pathOf,signal:combined,guard,beforeWrite:()=>projectWrite(true),save,onChanged});
    }
    async function tree(requested) {
      const visible = [...new Set([...c.scope, ...c.readScope])],
        ranges = inScope(requested, visible)
          ? [requested]
          : visible.filter(
              (p) => requested === "." || p.startsWith(requested + "/"),
            );
      if (!ranges.length) throw problem("SCOPE", "读取超出可见源码投影。");
      const map = new Map();
      for (const p of ranges) {
        if (p !== ".") {
          const file = await versioning.read({ changeId: c.changeId, path: p });
          binding.observations.set("file:" + p, {
            path: p,
            kind: "file",
            fingerprint: file.contentHash,
            version: file.version,
          });
          if (file.contentBase64 !== null) {
            map.set(p, { path: p, mode: file.mode });
            continue;
          }
        }
        const r = await versioning.read({
          changeId: c.changeId,
          path: p,
          kind: "tree",
        });
        binding.observations.set("tree:" + p, {
          path: p,
          kind: "tree",
          fingerprint: r.fingerprint,
          version: r.version,
        });
        for (const e of r.entries) map.set(e.path, e);
      }
      return [...map.keys()].sort();
    }
    async function stableFiles(p) {
      const list = await tree(p);
      for (const name of list) {
        const st = lstatSync(join(c.workspace, name));
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
          throw problem("UNMANAGED_WRITE", "投影存在不受管类型。");
        const bytes = await sourceRead(join(c.workspace, name));
        if (!bytes.equals(readFileSync(join(c.workspace, name))))
          throw problem("UNMANAGED_WRITE", "投影与权威tree不一致。");
      }
      return list;
    }
    async function rg(args) {
      const cached = join(getAgentDir(), "bin", process.platform === "win32" ? "rg.exe" : "rg");
      try {
        return (
          await exec(existsSync(cached) ? cached : "rg", args, {
            cwd: c.workspace,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
            signal: combined,
          })
        ).stdout;
      } catch (e) {
        if (e.code === 1) return "";
        throw e;
      }
    }
    function scrub(result) {
      const old =
        result?.details?.fullOutputPath ??
        result?.structuredContent?.full_output_path;
      if (old && old !== `output:${trace.requestId}`) tempPaths.add(old);
      if (def.name !== "bash") return result;
      const ref = `output:${trace.requestId}`;
      return {
        ...result,
        content: result.content?.map((x) =>
          x.type === "text"
            ? {
                ...x,
                text: [...tempPaths].reduce(
                  (s, p) => s.replaceAll(p, ref),
                  x.text,
                ),
              }
            : x,
        ),
        ...(result.details
          ? {
              details: {
                ...result.details,
                ...(old ? { fullOutputPath: ref } : {}),
                environment: "Linux 隔离环境",
                outputRef: trace.requestId,
              },
            }
          : {}),
        ...(result.structuredContent
          ? {
              structuredContent: {
                ...result.structuredContent,
                ...(result.structuredContent.full_output_path
                  ? { full_output_path: ref }
                  : {}),
              },
            }
          : {}),
      };
    }
    try {
      if(logRef){
        const bytes=await logBuffer(logRef);
        const text=binaryOutputNotice(bytes,logRef);
        if(!imageMime(bytes)&&text){
          trace.status='completed';return {content:[{type:'text',text}]};
        }
      }
      if (def.name === "read")
        native = createReadToolDefinition(c.workspace, {
          operations: {
            access: async (p) => {
              if (logRef) await logBuffer(logRef);
              else await sourceRead(p);
            },
            readFile: (p) => (logRef ? logBuffer(logRef) : sourceRead(p)),
            detectImageMimeType: async p=>imageMime(logRef?await logBuffer(logRef):await sourceRead(p)),
          },
        });
      if(pair)native={execute:async()=>{await writeSource(pair);return {content:[{type:'text',text:'Wrote both files atomically: '+writePaths.join(', ')}]};}};
      else if (def.name === "write")
        native = createWriteToolDefinition(c.workspace, {
          operations: {
            mkdir: async (p) => {
              pathOf(p, c);
            },
            writeFile: writeSource,
          },
        });
      if (def.name === "edit")
        native = createEditToolDefinition(c.workspace, {
          operations: {
            access: sourceRead,
            readFile: sourceRead,
            writeFile: writeSource,
          },
        });
      if (def.name === "ls") {
        const list = await tree(path);
        const exists = (p) => {
          const q = pathOf(p, c);
          return (
            q === "." || list.some((x) => x === q || x.startsWith(q + "/"))
          );
        };
        native = createLsToolDefinition(c.workspace, {
          operations: {
            exists,
            stat: (p) => {
              const q = pathOf(p, c);
              return {
                isDirectory: () =>
                  q === "." || list.some((x) => x.startsWith(q + "/")),
              };
            },
            readdir: (p) => {
              const q = pathOf(p, c),
                prefix = q === "." ? "" : q + "/";
              return [
                ...new Set(
                  list
                    .filter((x) => x.startsWith(prefix))
                    .map((x) => x.slice(prefix.length).split("/")[0]),
                ),
              ];
            },
          },
        });
      }
      if (def.name === "find") {
        const files = await stableFiles(path);
        native = createFindToolDefinition(c.workspace, {
          operations: {
            exists: () => true,
            glob: async (pattern, _where, opts) =>
              files.map(p => posix.relative(path, p)).filter(p =>
                posix.matchesGlob(pattern.includes("/") ? p : posix.basename(p), pattern)).slice(0, opts.limit),
          },
        });
      }
      if (def.name === "grep") {
        const list = await stableFiles(path);
        let text = "";
        if (list.length) {
          const flags = [
            "--line-number",
            "--no-heading",
            "--hidden",
            "--no-follow",
            ...(args.ignoreCase ? ["--ignore-case"] : []),
            ...(args.literal ? ["--fixed-strings"] : []),
            ...(args.context ? ["--context", String(args.context)] : []),
            ...(args.glob ? ["--glob", args.glob] : []),
            "--",
            args.pattern,
            ...list,
          ];
          text = await rg(flags);
        }
        trace.status = "completed";
        return {
          content: [{ type: "text", text: text || "No matches found" }],
        };
      }
      if (def.name === "bash")
        native = createBashToolDefinition(c.workspace, {
          exposeSessionEnvironment: false,
          operations: {
            exec: async (command, _cwd, opts) => {
              guard();
              const input = {
                requestId: trace.requestId,
                expectedVersion: c.privateVersion,
                command,
                ...(opts.timeout === undefined
                  ? {}
                  : { timeoutMs: Math.ceil(opts.timeout * 1000) }),
              };
              trace.timeoutMs = input.timeoutMs ?? null;
              trace.kernelInput = input;
              trace.outputRef = trace.requestId;
              save();
              projectWrite(true);
              trace.kernelDispatched = true;
              save();
              lastKernel = await versioning.exec(c.changeId, input, {
                signal: combined,
                onData: opts.onData,
              });
              trace.exitCode = lastKernel.exitCode ?? null;
              trace.executionStatus = lastKernel.status;
              Object.assign(
                c,
                await versioning.inspect({ changeId: c.changeId }),
              );
              onChanged(c);
              if (lastKernel.status !== "completed") {
                if (lastKernel.status === "unknown")
                  binding.unknownOperation = trace.requestId;
                throw problem(
                  lastKernel.status === "unknown"
                    ? "OPERATION_UNKNOWN"
                    : "EXECUTION_" + lastKernel.status.toUpperCase(),
                  JSON.stringify(lastKernel),
                );
              }
              for (const p of lastKernel.changedFiles ?? [])
                binding.failedMutations.delete(p);
              binding.reviewedVersion = null;
              return { exitCode: lastKernel.exitCode };
            },
          },
        });
      const result = await native.execute(
        id,
        args,
        combined,
        (u) => onUpdate?.(scrub(u)),
        { ...ctx, cwd: c.workspace },
      );
      trace.status = combined.aborted
        ? "cancelled"
        : result.isError
          ? "failed"
          : "completed";
      if(def.name==='bash'&&result.content?.some(p=>p.type==='text'&&/[\uFFFD\u0000]/.test(p.text))){
        const text=binaryOutputNotice(await logBuffer(trace.outputRef),trace.outputRef);
        if(text){
          result.content=[{type:'text',text}];
          if(result.structuredContent)result.structuredContent.output=text;
        }
      }
      const shown = scrub(result);
      if (isWrite)
        shown.content = [
          ...(shown.content ?? []),
          {
            type: "text",
            text: `agent-sync源码投影：${c.workspace}；私有版本：${c.privateVersion}。${def.name === "bash" ? `Linux隔离命令 exitCode=${lastKernel?.exitCode}；实际源变化=${JSON.stringify(lastKernel?.changedFiles ?? [])}；未导入辅助产物=${JSON.stringify(lastKernel?.ignoredFiles ?? [])}；日志 output:${trace.outputRef}。` : ""}`,
          },
        ];
      return {
        ...shown,
        details: {
          ...shown.details,
          agentSync: {
            changeId: c.changeId,
            privateVersion: c.privateVersion,
            ...(reviewVersion ? {reviewVersion} : {}),
            workspace: c.workspace,
            outputRef: trace.outputRef ?? null,
            changedFiles: lastKernel?.changedFiles ?? lastKernel?.files ?? [],
            ignoredFiles: lastKernel?.ignoredFiles ?? [],
          },
        },
      };
    } catch (e) {
      trace.status = combined.aborted
        ? "cancelled"
        : binding.unknownOperation
          ? "unknown"
          : "failed";
      trace.error = e.message;
      if (def.name === "bash") task.projectPolicy?.environmentFailure?.({
        candidate:c.privateVersion, requestId:trace.requestId, code:e.code, message:e.message,
      });
      throw e;
    } finally {
      trace.durationMs = performance.now() - started;
      for (const path of tempPaths)
        try {
          unlinkSync(path);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      save();
    }
  }
  return prototypes.map((def) => ({
    ...def,
    description:def.description+(def.name==="read"?" Task-owned output:<requestId> references support images too: a command can write only PNG/JPEG bytes to stdout, then read that output without adding a source file.":""),
    async execute(...args) {
      const run = withChangeQueue(versioning, getChange().changeId, () => perform(def, ...args))
        .catch((e) => {
          const trace = (task.record.tools ?? []).find(
            (t) => t.toolCallId === args[0] && t.stageId === role().id,
          );
          if (trace) {
            trace.status = task.signal.aborted
              ? "cancelled"
              : e.code === "OPERATION_UNKNOWN"
                ? "unknown"
                : "failed";
            trace.error = e.message;
            if (["write", "edit"].includes(def.name))
              binding.failedMutations.set(
                trace.sourcePath ?? args[1]?.path,
                trace.requestId,
              );
            if (e.code === "OPERATION_UNKNOWN")
              binding.unknownOperation = trace.requestId;
            save();
          }
          throw e;
        });
      return run;
    },
  }));
}
