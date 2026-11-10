import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_PNG } from "../scripts/visual-preview.mjs";
import { problem, readRequest, readTask } from "./task.js";
import { createVersioning, inScope } from "./versioning.js";
import { checkedVisualReview, createPreviewTool, projectVisualInput, runVisualReview } from "./visual-preview.js";
import { sha, visualRuntimeProblem } from "./visual-browser.js";

export function checkedCombinedVisual(home, record, receipt) {
  const { basis, outputRef, requestId } = receipt;
  const evidence = record.work?.visualEvidence?.find(item => item.outputRef === outputRef);
  const stage = record.stages?.find(item => item.phase === "visual-review" && item.callIds?.includes(requestId));
  if (!outputRef || !requestId || !evidence || !stage || evidence.result !== "captured" || evidence.sourceVersion !== basis.version ||
      evidence.contentUnchanged !== true || evidence.review?.verdict !== "match" ||
      evidence.review.requestId !== requestId || !checkedVisualReview(evidence, basis.version, true) ||
      visualRuntimeProblem(evidence.diagnostics) ||
      evidence.entry !== basis.input.entry || evidence.execution?.image !== basis.execution.image ||
      evidence.execution?.network !== "none" ||
      JSON.stringify(evidence.viewport) !== JSON.stringify(basis.input.viewport) ||
      JSON.stringify(evidence.frameTimesMs) !== JSON.stringify(basis.input.frameTimesMs) ||
      JSON.stringify(evidence.actions) !== JSON.stringify(basis.input.actions) ||
      !evidence.visibility?.scope?.length || !evidence.visibility.scope.every(path=>inScope(path,basis.visibility.scope)) ||
      !basis.visibility.scope.every(path=>inScope(path,evidence.visibility.scope)) ||
      JSON.stringify(evidence.visibility.artifactPaths) !== JSON.stringify(basis.visibility.artifactPaths))
    return false;
  const call = readRequest(home, record.id, requestId);
  const claim = record.rootRequests?.find(item => item.requestId === requestId && item.taskId === record.id &&
    item.stageId === stage.id && item.sessionId === stage.sessionId && item.status === "completed" && !item.notSent);
  if (!claim || call.taskId !== record.id || call.stageId !== stage.id || call.phase !== stage.phase ||
      call.status !== "completed" || call.sent !== true || call.transport?.projectDispatched !== true ||
      call.actualModel?.provider !== record.frozenConfig?.main?.provider ||
      call.actualModel?.modelId !== record.frozenConfig?.main?.modelId ||
      call.visualEvidence?.outputRef !== outputRef || call.visualEvidence.digest !== receipt.basisDigest ||
      JSON.stringify(call.visualEvidence.imageHashes) !== JSON.stringify(evidence.images.map(i => i.sha256)))
    return false;
  evidence.images.forEach((_, index) => readVisualFrame(home, record, outputRef, index));
  return true;
}

export async function verifyProjectVisual(host, state, previous, signal) {
  const { rootTask: task } = host.unified.rootOwner;
  const { delivery } = state, model = task.record.frozenConfig.main;
  const input = projectVisualInput(state.workRequest, delivery.artifacts.map(item => item.path));
  const execution = state.steps[0].attempts.at(-1).execution;
  const basis = {
    projectId: state.id, revision: state.revision, version: delivery.version,
    integrationRef: state.integrationRef, input, execution,
    approvedGoal: state.goal, originalTask: state.visualContract?.originalTask ?? state.originalGoal,
    networkMode: task.record.constraints?.networkMode ?? state.visualContract?.networkMode ?? null,
    visibility: { scope: [...new Set([input.entry, ...state.scope, ...(state.readScope ?? state.scope)])],
      artifactPaths: execution?.artifactPaths ?? ["node_modules"] },
  };
  const basisDigest = sha(JSON.stringify(basis));
  const guard = () => {
    signal.throwIfAborted();
    host.assertOwned();
    const current = host.read();
    if (current.status !== "active" || current.revision !== basis.revision ||
        current.version !== basis.version || current.integrationRef !== basis.integrationRef ||
        task.record.status !== "running" || task.ioError)
      throw problem("STALE_VISUAL", "视觉复核的正式版本或任务授权已改变。");
  };
  const saveVisual = visual => host.update(s => {
    if (s.delivery?.version === basis.version && s.delivery.revision === basis.revision)
      s.delivery.visual = structuredClone(visual);
  });
  guard();
  if (previous?.basisDigest === basisDigest) {
    const origin = readTask(task.home, previous.taskId);
    const capture = origin.tools?.find(tool => tool.toolCallId === previous.toolCallId);
    const call = previous.requestId ? readRequest(task.home, previous.taskId, previous.requestId) : null;
    if (!previous.error && call && checkedCombinedVisual(task.home, origin, previous)) {
      saveVisual(previous);
      return;
    }
    if (["running","unknown"].includes(capture?.status) || call?.sent || call?.transport?.projectDispatched) {
      saveVisual(previous);
      throw problem("VISUAL_ORIGINAL", previous.error ?? "请核对原视觉检查请求，已保留正式文件版本。");
    }
  }

  const toolCallId = "combined-visual-" + randomUUID();
  const receipt = { taskId: task.record.id, commandId: host.unified.commandId, basis, basisDigest,
    toolCallId, outputRef: null, requestId: null, error: null };
  saveVisual(receipt);
  let versioning, stage;
  try {
    await task.preflightVisual({projectCwd:state.repo});
    guard();
    versioning = host.kernel ?? await createVersioning({ home: task.home, project: state.repo, checks: [], execution, signal });
    const current = await versioning.inspect();
    if (current.version !== basis.version || current.integrationRef !== basis.integrationRef ||
        current.execution?.image !== execution.image || current.execution?.network !== "none")
      throw problem("STALE_VISUAL", "正式版本或离线渲染环境在视觉验收前改变。");
    const readScope = [...new Set([...state.scope, ...(state.readScope ?? state.scope)])];
    const change = await versioning.beginChange({requestId:randomUUID(), actor:"combined-visual",
      scope:[input.entry], readScope, intent:"Verify the final combined visual artifact", wait:false}, {signal});
    if (change.status !== "open" || change.baseVersion !== basis.version || change.privateVersion !== basis.version)
      throw problem("STALE_VISUAL", "无法在同一正式版本打开独立预览授权。");
    task.record.work = {...task.record.work, version: basis.version};
    stage = task.beginPhase("visual-preview", "main", model);
    const preview = createPreviewTool({task, stage, versioning, getChange:() => change, assertOwned:guard});
    const material = await preview.execute(toolCallId, input, signal);
    const evidence = material.details.visualEvidence;
    const diff = await versioning.inspect({fromVersion:basis.version,toVersion:evidence.privateVersion});
    if (diff.files.length || diff.text || diff.binaryFiles.length)
      throw problem("VISUAL_SOURCE_CHANGED", "预览源码与正式版本不一致。");
    const abandoned = await versioning.abandonChange(change.changeId, {requestId:randomUUID()});
    if (abandoned.status !== "abandoned")
      throw problem("STALE_VISUAL", "无法确认关闭仅用于截图的授权。");
    Object.assign(evidence, {integrationVersion:basis.version});
    stage.status = "completed";
    task.save();
    receipt.outputRef = evidence.outputRef;
    saveVisual(receipt);
    const diagnostic = visualRuntimeProblem(evidence.diagnostics);
    if (diagnostic) throw problem("VISUAL_OFFLINE", diagnostic);
    guard();
    evidence.images.forEach((_, index) => readVisualFrame(task.home, task.record, evidence.outputRef, index));
    const review = await runVisualReview({
      task, model, cwd: state.repo, material, evidence, versioning, guard,
      basis:{...basis,digest:basisDigest}, maxOutputTokens:model.maxOutputTokens,
      beforeDispatch(call) {
        guard();
        host.update(current => {
          const claims = current.callIntents ??= [];
          if (current.budget.maxCost !== null || (current.budget.maxCalls !== null &&
              claims.filter(claim => claim.kind !== "external" && !claim.notSent).length >= current.budget.maxCalls))
            throw problem("PROJECT_BUDGET", "项目预算没有剩余可核验的视觉复核请求额度。");
          claims.push({id:call.id, taskId:task.record.id, rootTaskId:task.record.id, role:call.role,
            phase:call.phase, basisDigest, at:new Date().toISOString()});
          receipt.requestId = call.id;
          current.delivery.visual = structuredClone(receipt);
        });
      },
    });
    guard();
    if (review.verdict !== "match")
      throw problem("VISUAL_MISMATCH", "主模型的最终视觉复核未通过。" + review.reasons);
    if (!checkedCombinedVisual(task.home, task.record, receipt))
      throw problem("VISUAL_NOT_SENT", "没有可核验的最终截图及主模型物理请求。");
  } catch (error) {
    receipt.outputRef ??= task.record.work?.visualEvidence?.find(item => item.toolCallId === toolCallId)?.outputRef ?? null;
    receipt.error = "已接纳文件，但最终视觉复核未通过。已保存的固定版本仍可打开。" + error.message;
    if (stage?.status === "running") stage.status = "failed";
    task.save();
    throw problem("VISUAL_DELIVERY", receipt.error);
  } finally {
    try { saveVisual(receipt); }
    finally { if (!host.kernel) await versioning?.close(); }
  }
}

export function readVisualFrame(home, record, ref, index) {
  if (!/^[a-z\d_-]+$/i.test(ref ?? "") || !Number.isSafeInteger(index) || index < 0)
    throw Error("截图引用无效。");
  const evidence = record.work?.visualEvidence?.find(e => e.outputRef === ref);
  const image = evidence?.images?.[index];
  if (!image) throw Error("截图不属于此任务。");
  const expected = resolve(home, "artifacts", record.id, ref, `${index}.png`);
  const root = realpathSync(join(home, "artifacts"));
  const taskRoot = realpathSync(join(root, record.id));
  const inside = (base, path) => {
    const rel = relative(base, path);
    return rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
  };
  if (!inside(root, taskRoot) || resolve(image.path) !== expected) throw Error("截图路径无效。");
  const path = realpathSync(image.path), info = lstatSync(image.path);
  if (!inside(taskRoot, path) || !info.isFile() || info.isSymbolicLink() ||
      info.nlink !== 1 || info.size > MAX_PNG) throw Error("截图路径或大小无效。");
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      sha(bytes) !== image.sha256) throw Error("截图类型或哈希不匹配。");
  return bytes;
}
