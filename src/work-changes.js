import { randomUUID } from "node:crypto";
import { inScope, withChangeQueue } from "./versioning.js";
import { problem } from "./task.js";

export function createWorkChanges({
  task,staff,shared,work,members,observerErrors,save,guard,notify,syncChange,
  getVersioning,getPluginWork,getMainBinding,
}) {
  async function invoke(action, input, fn) {
    guard();
    const v = getVersioning();
    const id = input.requestId ?? randomUUID();
    let request = work.requests.find((r) => r.requestId === id);
    if (!request) {
      request = {
        action,
        requestId: id,
        changeId: input.changeId ?? null,
        status: "preparing",
        ...(task.projectPolicy ? {dispatched:false} : {}),
      };
      work.requests.push(request);
    }
    request.status = "preparing";
    request.attempts = (request.attempts ?? 0) + 1;
    save();
    const started = performance.now(),
      before = observerErrors.length;
    try {
      const coordinated = input.changeId && ["prepareChange", "acceptChange", "refreshChange"].includes(action);
      const execute = async () => {
        guard();
        const change = work.changes.find(c => c.changeId === input.changeId);
        const resumeCandidate = action === "acceptChange" ? input.resumeCandidate : undefined;
        if (staff && coordinated && input.actor === "main" && change?.actor?.startsWith("member:"))
          staff.checkOwner({taskId:task.record.id, actorRole:"main", dispatchId:change.actor.slice(7), rootReview:true, resumeCandidate});
        if (task.projectPolicy && action !== "abandonChange")
          task.projectPolicy.admit(action === "acceptChange" || action === "checkCurrent" ? "accept" : "scope", {
            actor: input.actor ?? change?.actor ?? "main",
            actorRole:input.actorRole,
            scope: input.scope ?? change?.scope ?? [],
            readScope: input.readScope ?? change?.readScope ?? [],
            previousScope: action === "refreshChange" ? change?.scope : undefined,
            candidate: input.candidateVersion ?? change?.candidateVersion ?? change?.privateVersion,
            changeId: change?.changeId, privateVersion:change?.privateVersion, requestId: id,
          });
        if (coordinated) await getPluginWork()?.assertHandled(input.changeId);
        if (staff && coordinated && change?.actor?.startsWith("member:"))
          staff.checkOwner({taskId:task.record.id, actorRole:"main", dispatchId:change.actor.slice(7), rootReview:true, resumeCandidate});
        if (task.projectPolicy && !request.dispatched) {
          request.dispatched = true;
          save();
        }
        return fn(id);
      };
      const run = shared && action === 'acceptChange' ? () => shared.withFormal(execute) : execute;
      let result = coordinated ? await withChangeQueue(v, input.changeId, run) : await run();
      if (observerErrors.length > before && action === "acceptChange")
        result = {
          status: "unknown",
          requestId: id,
          changeId: input.changeId,
          error: observerErrors.at(-1),
        };
      request.status = result.status ?? "completed";
      save();
      if (action === "refreshChange")
        await task.projectPolicy?.observeRefresh?.({requestId:id, result, versioning:v});
      return result;
    } catch (e) {
      request.status = "rejected";
      request.error = { code: e.code ?? "ERROR", message: e.message };
      save();
      if (["prepareChange","acceptChange","checkCurrent"].includes(action) &&
          ["EXECUTOR_UNAVAILABLE","EXECUTOR_CONFIG","EXECUTION_UNKNOWN"].includes(e.code))
        task.projectPolicy?.environmentFailure?.({
          candidate:input.candidateVersion ?? work.changes.find(c=>c.changeId===input.changeId)?.privateVersion ?? work.version,
          requestId:id, code:e.code, message:e.message,
        });
      throw e;
    } finally {
      request.durationMs =
        (request.durationMs ?? 0) + (performance.now() - started);
      save();
    }
  }
  async function begin(
    actor,
    scope,
    readScope,
    intent,
    readOnly = false,
    options = {},
  ) {
    const v=getVersioning();
    const input = {
      requestId: options.requestId ?? randomUUID(),
      actor,
      ...(actor === "result" ? {actorRole:"main"} : {}),
      scope: readOnly ? [] : scope,
      readScope: readScope ?? (task.record.rootTaskId ? task.record.project.readScope : ["."]),
      intent,
      readOnly,
      wait: options.wait ?? false,
      ...(options.baseVersion ? {baseVersion:options.baseVersion} : {}),
      ...(shared && !readOnly ? {checkPolicy:task.record.project.checkPolicy} : {}),
    };
    const c = await invoke("beginChange", input, (id) =>
      v.beginChange(
        { ...input, requestId: id },
        { signal: options.signal ?? task.signal },
      ),
    );
    if (c.status === "blocked") return c;
    if (c.status === "unknown")
      throw Object.assign(
        problem("OPERATION_UNKNOWN", "授权结果未知：" + input.requestId),
        { requestId: input.requestId },
      );
    return syncChange(c);
  }
  async function abandon(c, reason, { queueHeld = false } = {}) {
    const v=getVersioning();
    const perform=async()=>{
      guard();
      const mainBinding=getMainBinding();
      const actor=mainBinding?.current.changeId===c.changeId?mainBinding:[...members.values()].find(m=>m.binding?.current.changeId===c.changeId)?.binding;
      if(c.status==="outcome_unknown"||actor?.unknownOperation)throw problem("OPERATION_UNKNOWN","Resolve the original operation ID before abandoning this change");
      await getPluginWork()?.assertHandled(c.changeId);
      const result = await invoke(
      "abandonChange",
      { changeId: c.changeId },
      (id) => v.abandonChange(c.changeId, { requestId: id }),
    );
    Object.assign(c, await v.inspect({ changeId: c.changeId }), {
      abandonReason: reason,
    });
    if (staff && c.actor === "main" && c.status === "abandoned") {
      const receipt = work.requests.findLast(r => r.action === "abandonChange" && r.changeId === c.changeId && r.status === "abandoned");
      if (receipt) staff.abandonedRoot({taskId:task.record.id, changeId:c.changeId, requestId:receipt.requestId, reason});
    }
    notify(true);
      return result;
    };
    return queueHeld?perform():withChangeQueue(v,c.changeId,perform);
  }
  function currentRequest(actor) {
    return task.requests().findLast((r) => r.role === actor.role && r.sent);
  }
  function receivedVersion(role, deliveredBy, version) {
    const requests = task.requests();
    const announced = requests.findIndex(r => r.id === deliveredBy);
    if (announced < 0) return false;
    const tools = requests[announced].response?.content?.filter(p => p.type === "toolCall" &&
      ["collect", "accept_change"].includes(p.name)).map(p => p.id) ?? [];
    return requests.slice(announced + 1).some(r => r.role === role && r.status === "completed" &&
      r.context?.messages?.some(msg => msg.role === "toolResult" && tools.includes(msg.toolCallId) &&
        !msg.isError && JSON.stringify(msg.content).includes(version)));
  }
  function refreshReady(actor) {
    if (!actor.refreshMarker) return true;
    const call = currentRequest(actor);
    if (
      call &&
      call.status === "completed" &&
      call.id !== actor.refreshCallId &&
      JSON.stringify(call.context).includes(actor.refreshMarker)
    ) {
      actor.current.refreshRequiresRequest = false;
      actor.refreshMarker = null;
      actor.refreshInput = null;
      save();
      return true;
    }
    return false;
  }
  function markRefresh(actor, result) {
    actor.refreshMarker = "refresh:" + randomUUID();
    actor.refreshCallId = currentRequest(actor)?.id ?? null;
    actor.refreshInput = {
      previous: actor.refreshInput ?? null,
      marker: actor.refreshMarker,
      ...result,
    };
    actor.current.refreshRequiresRequest = true;
    actor.current.refreshMarker = actor.refreshMarker;
    save();
    return actor.refreshInput;
  }
  function observationScope(actor, scope, readScope) {
    const visible = [...(scope ?? []), ...(readScope ?? ["."])];
    const missing = [...actor.observations.values()].filter(
      (o) => !inScope(o.path, visible),
    );
    if (missing.length)
      throw problem(
        "SCOPE",
        "新写授权须保留已观察依据的readScope：" +
          JSON.stringify(missing.map((x) => x.path)),
      );
  }
  async function observedDelta(actor, next) {
    const v=getVersioning();
    const changed = [];
    for (const o of actor.observations.values()) {
      const r = await v.read({
        changeId: next.changeId,
        path: o.path,
        kind: o.kind,
      });
      const fingerprint = o.kind === "file" ? r.contentHash : r.fingerprint;
      if (fingerprint !== o.fingerprint)
        changed.push({
          path: o.path,
          kind: o.kind,
          before: o.fingerprint,
          after: fingerprint,
        });
    }
    if (!changed.length) return null;
    const from = actor.current.baseVersion,
      to = next.baseVersion,
      diff = await v.inspect({ fromVersion: from, toVersion: to });
    const files = [];
    for (const path of diff.files.filter((p) =>
      inScope(p, [...next.scope, ...next.readScope]),
    )) {
      const a = await v.read({ version: from, path }),
        b = await v.read({ version: to, path });
      files.push({
        path,
        before:
          a.contentBase64 === null
            ? null
            : Buffer.from(a.contentBase64, "base64").toString("utf8"),
        after:
          b.contentBase64 === null
            ? null
            : Buffer.from(b.contentBase64, "base64").toString("utf8"),
      });
    }
    return {
      status: "basis_changed",
      fromVersion: from,
      toVersion: to,
      changed,
      files,
    };
  }
  async function ensureMainWrite(path) {
    const mainBinding=getMainBinding();
    guard();
    if (!refreshReady(mainBinding))
      throw problem(
        "REFRESH_REQUIRES_REQUEST",
        "先让该执行者在后续模型请求收到刷新差异。",
      );
    if (mainBinding.unknownOperation)
      throw problem("OPERATION_UNKNOWN", "先查询未知操作。");
    const old = mainBinding.current;
    if (!old.readOnly) {
      if (path && !inScope(path, old.scope))
        throw problem("SCOPE", "请refresh_change保留草稿后扩大实际范围。");
      return old;
    }
    if (path === null)
      throw problem(
        "SCOPE_REQUIRED",
        "Shell需要明确范围；使用next_change/refresh_change说明scope。",
      );
    await getPluginWork()?.assertHandled(old.changeId);
    const c = await begin(
      "main",
      [path],
      old.readScope,
      task.record.input,
      false,
    );
    if (c.status === "blocked")
      throw problem("SCOPE_BLOCKED", JSON.stringify(c));
    const delta = await observedDelta(mainBinding, c);
    // ensureMainWrite is invoked by workspaceTools while this old change queue is held.
    await abandon(old, "观察已转换为明确的单文件写意图", {queueHeld:true});
    mainBinding.current = c;
    if (delta) {
      const feedback = markRefresh(mainBinding, delta);
      throw problem("BASIS_CHANGED", JSON.stringify(feedback));
    }
    return c;
  }
  async function prepare(actor, check = false, caller = actor.role) {
    const v=getVersioning();
    const c = actor.current;
    await getPluginWork()?.assertHandled(c.changeId);
    if (c.status === "outcome_unknown" || actor.unknownOperation)
      throw problem("OPERATION_UNKNOWN", "未知结果只能查询已有ID。");
    const requestId = randomUUID();
    const member = actor.role.startsWith("member:") ? members.get(actor.role.slice(7)) : null;
    const signal = member ? AbortSignal.any([task.signal, member.controller.signal]) : task.signal;
    const r = await invoke("prepareChange", { changeId: c.changeId, actor:caller, requestId }, (id) =>
      v.prepareChange(c.changeId, { requestId: id, check, signal }),
    );
    actor.current = syncChange(r);
    if (check && task.projectPolicy) {
      const candidate = r.candidates.find(p => p.candidateVersion === r.candidateVersion);
      if (!candidate?.precheck)
        throw problem("PROJECT_CHECK", "The fixed candidate has no precheck receipt.");
      actor.projectRoute = await task.projectPolicy.observeCheck({kind:"precheck", candidate:candidate.candidateVersion,
        privateVersion:candidate.privateVersion, changeId:r.changeId, versioning:v,
        result:{...candidate.precheck, tree:candidate.tree, requestId}});
    }
    return actor.current;
  }
  return {invoke,begin,abandon,currentRequest,receivedVersion,refreshReady,markRefresh,
    observationScope,observedDelta,ensureMainWrite,prepare};
}
