import { createRequestJournal, recoverRequestJournal } from "./request-journal.js";
import { snapshotTeam } from "./teams.js";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory, writePrivateJson, redact } from "./storage.js";
const terminal = new Set([
  "completed",
  "cancelled",
  "partial",
  "failed",
  "outcome_unknown",
  "blocked",
]);
export const problem = (code, message) => Object.assign(new Error(message), { code });
export function taskDisplayStatus(record) {
  if((record.tools??[]).some(t=>t.kind==='project_mcp_runtime'&&t.containerId&&!t.stoppedAt&&['outcome_unknown','stop_unknown'].includes(t.status)))return 'stop_unknown';
  if((record.tools??[]).some(t=>t.kind==='project_mcp_call'&&['intent','pending','outcome_unknown'].includes(t.status)))return 'outcome_unknown';
  if((record.tools??[]).some(t=>t.kind==='project_mcp_runtime'&&t.requests?.some(r=>!r.originalRequestId&&['pending','outcome_unknown'].includes(r.status))))return 'outcome_unknown';
  if(!record.cancelRequestedAt)return record.status;
  if(record.cancelStopError || record.nativeShutdownError || (record.work?.helpers??[]).some(h=>h.status==='outcome_unknown') || (record.tools??[]).some(t=>(t.nativeBackground||t.kind==='employee_script_result'||t.kind==='project_plugin_runtime'||t.kind==='project_mcp_runtime'&&t.containerId)&&['outcome_unknown','stop_unknown'].includes(t.status)))return 'stop_unknown';
  if(!record.cancelSettledAt || (record.work?.helpers??[]).some(h=>!h.stoppedAt) || (record.tools??[]).some(t=>(t.nativeBackground||t.kind==='employee_script_result'||t.kind==='project_plugin_runtime'||t.kind==='project_mcp_runtime'&&t.containerId)&&!t.stoppedAt))return 'cancelling';
  return record.status;
}
export function createTask({
  home,
  input,
  models,
  team,
  singleModel = false,
  sessionId = null,
  branchId = null,
  persist,
  writeRequest,
  secrets = [],
  id = randomUUID(),
  submissionId,
  workRequest,
  project,
  projectPolicy,
  flow, constraints, budget, rootTaskId, rootOwner, frozenConfig, workspace, readAuthorization, confirmationSource, budgetSource, operationAuthorization, projectOperation, editorEditId,
  origin, sourceLeaf, sourceSnapshot, inputDigest, materials, continuationSource,
}) {
  const controller = new AbortController(),
    runtimes = new Set(),
    requests = new Map(),
    journals = new Map();
  const closeJournals = () => {
    for (const journal of journals.values()) journal.close();
  };
  const record = {
    formatVersion: 2,
    id,
    ...(submissionId ? { submissionId } : {}),
    ...(editorEditId ? {editorEditId} : {}),
    ...(continuationSource ? {continuationSource:structuredClone(continuationSource)} : {}),
    ...(origin ? {origin,sourceLeaf,sourceSnapshot:structuredClone(sourceSnapshot),inputDigest} : {}),
    ...((flow==='unified'||rootTaskId)?{localExecutionClosedAt:null}:{}),
    createdAt: new Date().toISOString(),
    input,
    ...(materials?.length ? {materials:structuredClone(materials)} : {}),
    singleModel,
    ...(flow ? {flow, constraints:structuredClone(constraints), budget:structuredClone(budget), frozenConfig:structuredClone(frozenConfig), workspace:structuredClone(workspace), readAuthorization:structuredClone(readAuthorization ?? null)} : {}),
    ...(rootTaskId ? {rootTaskId} : {}),
    ...(confirmationSource ? {confirmationSource:structuredClone(confirmationSource),budgetSource:structuredClone(budgetSource)} : {}),
    ...(operationAuthorization ? {operationAuthorization:structuredClone(operationAuthorization),projectOperation:structuredClone(projectOperation),budgetSource:structuredClone(budgetSource)} : {}),
    ...(project ? { project: structuredClone(project) } : {}),
    ...(workRequest ? { workRequest: structuredClone(workRequest) } : {}),
    models: structuredClone(models),
    ...(team ? { team: snapshotTeam(team) } : {}),
    sessionId,
    branchId,
    mode: workRequest || project ? "work" : "answer",
    phase: "created",
    status: "running",
    maxCalls: flow === "unified" ? budget?.maxCalls ?? null : workRequest || project ? null : singleModel ? 1 : 3,
    stages: [],
    requestIds: [],
    finalCallId: null,
  };
  const directory = join(home, "tasks");
  privateDirectory(directory);
  privateDirectory(join(home, "requests"));
  const save = () => {
    const safe = redact(record, secrets);
    if (persist) persist(safe);
    else writePrivateJson(join(directory, record.id + ".json"), safe);
  };
  const task = {
    home,
    ...(projectPolicy ? { projectPolicy } : {}),
    ...(rootOwner ? {rootOwner} : {}),
    record,
    signal: controller.signal,
    save,
    runtimes,
    beginPhase(phase, role, modelRef, { roleOnly = false, assignment, stageId = randomUUID() } = {}) {
      if (controller.signal.aborted || terminal.has(record.status))
        throw problem("CANCELLED", "任务已停止");
      const stage = {
        id: stageId,
        displayId: randomUUID(),
        phase,
        role,
        modelRef: structuredClone(modelRef),
        status: "running",
        callIds: [],
      };
      if (assignment) stage.assignment = assignment;
      if (!roleOnly) record.phase = phase;
      record.stages.push(stage);
      save();
      return stage;
    },
    register(request) {
      requests.set(request.id, request);
      record.requestIds.push(request.id);
    },
    writeRequest(request) {
      try {
        const folded = !["preparing", "in_flight"].includes(request.status);
        if (!writeRequest && !journals.has(request.id) && !projectPolicy)
          journals.set(request.id, createRequestJournal(home, request));
        const snapshot = writeRequest ? request : {
          ...request,
          events: folded || !journals.has(request.id) ? request.events : [],
          ...(journals.has(request.id) ? { eventJournal: { version: 1, folded, ...(folded ? { count: request.events.length } : {}) } } : {}),
        };
        const safe = redact(snapshot, [...secrets, ...(request._secrets ?? [])]);
        delete safe._secrets;
        if (writeRequest) writeRequest(safe);
        else {
          writePrivateJson(join(home, "requests", request.id + ".json"), safe);
          if (folded) journals.get(request.id)?.close();
        }
      } catch (error) {
        task.ioError = error;
        controller.abort(error);
        throw error;
      }
    },
    appendRequestEvent(request, event) {
      const safe = redact(event, [...secrets, ...(request._secrets ?? [])]);
      request.events.push(safe);
      try {
        if (writeRequest) task.writeRequest(request);
        else {
          if (!journals.has(request.id)) {
            if (!projectPolicy || !request.sent) throw new Error("请求事件日志尚未初始化");
            journals.set(request.id, createRequestJournal(home, request));
            // Publish the journal reference before appending its first provider event.
            task.writeRequest(request);
          }
          journals.get(request.id).append(safe);
        }
      } catch (error) {
        task.ioError = error;
        controller.abort(error);
        throw error;
      }
    },
    processRequestFacts(role, feedback = 0) {
      return [...requests.values()].filter(request => request.role === role && request.sent &&
        (request.projectSend?.feedback ?? 0) === feedback).map(request => ({
          id: request.id, stageId: request.stageId, phase: request.phase, status: request.status,
          at: request.transport?.dispatchedAt ?? request.transport?.startedAt ?? request.createdAt,
          endedAt: request.endedAt ?? null,
        }));
    },
    requests() {
      return [...requests.values()].map((r) => {
        const safe = redact(r, [...secrets, ...(r._secrets ?? [])]);
        delete safe._secrets;
        return safe;
      });
    },
    usage() {
      const calls = [...requests.values()].filter((r) => r.sent);
      const known = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let unknownCalls = 0,
        cost = 0,
        costUnknown = false;
      for (const call of calls) {
        if (call.usage) {
          for (const key of Object.keys(known)) known[key] += call.usage[key] ?? 0;
        } else unknownCalls++;
        if (typeof call.estimatedCost === "number") cost += call.estimatedCost;
        else costUnknown = true;
      }
      const helpers=(record.work?.helpers??[]).filter(h=>!h.native?.projectManaged),nativeTools=(record.tools??[]).filter(t=>t.kind==="native_plugin_tool");
      const unknownHelpers=helpers.filter(h=>(h.process||h.native)&&(!h.stoppedAt||!h.usage||typeof h.usage.cost!=='number')).length;
      const helperCost=unknownHelpers?null:helpers.reduce((sum,h)=>sum+(typeof h.usage?.cost==='number'?h.usage.cost:0),0);
      return {
        calls: calls.length,
        known,
        unknownCalls,
        cost: costUnknown ? null : cost,
        costSource: "catalog_estimate",
        ...(helpers.length ? {
          scope:"team_only",costScope:"team_only",
          helpers:{count:helpers.length,reportedTurns:helpers.every(h=>h.usage?.turns!==undefined)?helpers.reduce((sum,h)=>sum+h.usage.turns,0):null,
            unknownHelpers,cost:helperCost,costSource:"pi-subagents catalog-derived report"},
          totalCatalogCost:costUnknown||helperCost===null?null:cost+helperCost,
        } : {}),
        ...(nativeTools.length?{scope:"team_only",costScope:"team_only",nativeTools:{count:nativeTools.length,reportedUsage:nativeTools.map(t=>({toolCallId:t.toolCallId,usage:t.usage??null,source:t.usageSource??null}))},totalCatalogCost:null}:{}),
      };
    },
    finish(status, error) {
      if (record.cancelRequestedAt && status === "completed")
        throw problem("CANCELLED", "已取消任务不能完成");
      if(status === "completed" && (record.tools??[]).some(t=>t.kind==="project_plugin_runtime"&&!t.stoppedAt))
        throw problem("PLUGIN_WRITER_UNKNOWN","Controlled plugin cgroup termination is not confirmed");
      if(status === "completed" && (record.tools??[]).some(t=>(t.kind==="native_plugin_result"||t.kind==="employee_script_result"||t.kind==="project_plugin_result")&&(!t.stoppedAt||!["adopted","rejected"].includes(t.treatment?.decision)||(t.import&&(t.import.status!=="applied"||t.treatment?.decision!=="adopted")))))
        throw problem("PLUGIN_RESULTS_PENDING","Native plugin results/imports are not settled; preserved for creator review.");
      if(status === "completed" && (record.work?.helpers ?? []).some(h=>!h.stoppedAt || !["adopted","rejected"].includes(h.treatment?.decision) || (h.import && (h.import.status!=="applied" || h.treatment?.decision!=="adopted"))))
        throw problem("HELPERS_PENDING","助手或其成果尚未处理，不能完成整条任务");
      record.status = status;
      record.error = error;
      record.endedAt = new Date().toISOString();
      record.usage = task.rootOwner?.rootTask===task ? task.rootOwner.usage() : task.usage();
      try { save(); } finally { closeJournals(); }
    },
    stop(error) {
      record.stopReason = error.message;
      try {
        save();
      } finally {
        controller.abort(error);
      }
    },
    async cancel() {
      if (task.cancelPromise) return task.cancelPromise;
      task.cancelPromise = task.cancelOwned();
      return task.cancelPromise;
    },
    async cancelOwned() {
      if (terminal.has(record.status)) return;
      record.cancelRequestedAt = new Date().toISOString();
      record.status = "cancelled";
      const recover = (error) => {
        record.status = "partial";
        record.error = "取消记录保存失败：" + error.message;
        task.recovery = { record, requests: task.requests() };
      };
      try {
        save();
      } catch (error) {
        recover(error);
      } finally {
        controller.abort(problem("CANCELLED", "用户取消整条任务；远端结果可能未知，不自动重发。"));
      }
      // Helper tools may be what a parent abort is waiting on; propagate their stop first.
      const executionStop = task.rootOwner?.rootTask === task ? task.rootOwner.stopAndDrain({cause:"cancel"}) : null;
      const helperStop = task.helperLifecycle?.close();
      const stopped = await Promise.allSettled([...runtimes].map((r) => r.session.abort()));
      if(stopped.some(result=>result.status==='rejected')) record.cancelStopError='One or more runtime aborts did not confirm stop';
      try {await helperStop;}catch(error){record.cancelStopError=error.message;}
      try {await executionStop;}catch(error){record.cancelStopError=error.message;}
      try {await task.readonlyLifecycle?.close({cancel:true});}catch(error){record.cancelStopError=error.message;}
      try {await task.contextLifecycle;}catch(error){record.cancelStopError=error.message;}
      if (!record.cancelStopError) record.cancelSettledAt=new Date().toISOString();
      closeJournals();
      record.usage = task.rootOwner?.rootTask===task ? task.rootOwner.usage() : task.usage();
      try {
        save();
      } catch (error) {
        recover(error);
      }
    },
  };
  save();
  return task;
}
export function readTask(home, id) {
  if (!/^[\da-f-]{36}$/.test(id)) throw problem("INVALID_ID", "无效任务 ID");
  const record = JSON.parse(readFileSync(join(home, "tasks", id + ".json"), "utf8"));
  if (record.id !== id || record.formatVersion !== 2 || !Array.isArray(record.stages))
    throw problem("CORRUPT_TASK", "任务记录损坏，原文件保留");
  if (record.status === "running") {
    record.status = "outcome_unknown";
    record.error = "进程可能已中断或仍在运行；不自动重发。";
  }
  if (record.processCheck?.status === "running") {
    const unsettled = record.processCheck.observations.filter(observation => observation.status === "preparing");
    for (const observation of unsettled) {
      try {
        const original = readRequest(home, observation.taskId, observation.requestId);
        if (original.phase !== "process-check" || original.stageId !== observation.stageId)
          throw problem("PROCESS_UNBOUND", "Observation and request ownership differ");
        observation.status = original.sent ? original.status === "completed" ? "unverified" : original.status : "not_sent";
        observation.usage = original.usage ?? null;
      } catch {
        observation.status = observation.requestId ? "outcome_unknown" : "not_sent";
      }
    }
    record.processCheck.status = unsettled.some(observation => observation.status === "outcome_unknown") ? "outcome_unknown" : "unverified";
  }
  for(const stage of record.stages) {
    if(stage.assignment&&!stage.assignment.settledAt){
      stage.status=stage.assignment.status="outcome_unknown";
      stage.assignment.error={message:"Assignment settlement is unconfirmed; query its original requests without replay."};
    }
  }
  for(const helper of record.work?.helpers ?? []) {
    if(["queued","starting","running"].includes(helper.status)) {
      helper.status="outcome_unknown";
      helper.error={message:"保存时助手尚未确认停止；不自动重发，不按PID终止进程。"};
    }
  }
  for(const operation of record.tools??[])if((operation.nativeBackground||operation.kind==='employee_script_result'||operation.kind==='project_plugin_runtime')&&!operation.stoppedAt){operation.status="outcome_unknown";operation.error={message:"Writer exit was not confirmed; no automatic replay or PID-only stop."};for(const execution of operation.executions??[])if(!execution.stoppedAt)execution.status="outcome_unknown";}
  return record;
}
export function readRequest(home, taskId, id) {
  if (typeof id !== "string" || !/^[\da-f-]{36}$/.test(id)) throw problem("INVALID_ID", "无效请求 ID");
  const call = JSON.parse(readFileSync(join(home, "requests", id + ".json"), "utf8"));
  if (call.id !== id || call.taskId !== taskId)
    throw problem("CORRUPT_REQUEST", "请求归属损坏");
  recoverRequestJournal(home, call);
  if (["preparing", "in_flight"].includes(call.status))
    call.status = call.sent ? "outcome_unknown" : "not_sent";
  return call;
}
export function readRequests(home, record) {
  return record.requestIds.map((id) => readRequest(home, record.id, id));
}
export function listTasks(home) {
  let files;
  try {
    files = readdirSync(join(home, "tasks"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return files
    .filter((n) => n.endsWith(".json"))
    .map((n) => readTask(home, n.slice(0, -5)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function rootUsage(home,record) {
  const tasks=[record,...(record.projectOperation?.childTaskIds??[]).map(id=>{
    const child=readTask(home,id);if(child.rootTaskId!==record.id||child.project?.commandId!==record.projectOperation.commandId)throw problem('ROOT_CHILD','Usage child ownership changed');return child;
  })];
  const requests=new Map();for(const task of tasks)for(const id of task.requestIds){const call=readRequest(home,task.id,id);if(requests.has(id))throw problem('ROOT_REQUEST','Duplicate physical request ownership');requests.set(id,call);}
  const sent=[...requests.values()].filter(r=>r.sent),known={input:0,output:0,cacheRead:0,cacheWrite:0};let cost=0,costUnknown=false;
  for(const call of sent){for(const key of Object.keys(known))known[key]+=call.usage?.[key]??0;if(typeof call.estimatedCost==='number')cost+=call.estimatedCost;else costUnknown=true;}
  return {scope:'root_and_owned',calls:sent.length,known,unknownCalls:sent.filter(r=>!r.usage).length,cost:costUnknown?null:cost,costSource:'catalog_estimate',ownCalls:sent.filter(r=>r.taskId===record.id).length,ownedCalls:sent.filter(r=>r.taskId!==record.id).length,pendingClaims:(record.rootRequests??[]).filter(c=>!c.notSent&&!requests.get(c.requestId)?.sent).length};
}
