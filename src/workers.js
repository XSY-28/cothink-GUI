import { createPreviewTool } from "./visual-preview.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createVersioning, inScope, withChangeQueue } from "./versioning.js";
import { createPluginWork } from "./plugin-work.js";
import { workspaceTools } from "./workspaces.js";
import { createRuntime, selectedResources } from "./pi-runtime.js";
import { renderAnswerSkills, buildMemberTaskMaterial } from "./context.js";
import { problem, readRequest, readTask } from "./task.js";
import { DEFAULT_THINKING_LEVEL } from "./thinking.js";
const prompt = (n) =>
  readFileSync(new URL(`../prompts/${n}.md`, import.meta.url), "utf8");
const modelName = (m) => m.provider + "/" + m.modelId;
// Provider identity is not model identity. Strip only recognized vendor namespaces;
// arbitrary custom IDs/remappings remain opaque, and versions are never guessed.
export const workModelIdentity = (m) => {
  const id = m.modelId.replace(/^(?:openai|anthropic|deepseek|moonshotai|moonshot)\//, "");
  if (id === "k3.1-pro") return "kimi-k3.1-pro";
  if (id === "anthropic.claude-opus-5-5") return "claude-opus-5-5";
  if (id === "claude-opus-5.5") return "claude-opus-5-5";
  if (id === "deepseek-v4.1-flash1017") return "deepseek-v4.1-flash-1017";
  return id;
};
const text = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});
const terminal = new Set([
  "accepted",
  "abandoned",
  "completed",
  "failed",
  "outcome_unknown",
  "cancelled",
]);
/** CoThink owns sessions/capacity/intent; the public kernel alone owns write permission and versions. */
export async function runWork({
  task,
  home,
  cwd,
  config,
  onProgress = () => {},
  maxOutputTokens,
  timeout,
  initialMaterial,
}) {
  if (
    task.workModelAllowlist !== undefined &&
    (!Array.isArray(task.workModelAllowlist) ||
      task.workModelAllowlist.some((identity) => typeof identity !== "string"))
  )
    throw problem("MODEL_UNAVAILABLE", "工作模型允许列表必须是身份数组。");
  const staff = task.record.project && task.projectPolicy?.staff;
  const roster = staff ? [config.main, ...config.secondary] : config.secondary;
  const available = (task.record.singleModel ? [] : roster).filter(
    (m) =>
      (staff || workModelIdentity(m) !== workModelIdentity(config.main)) &&
      (task.workModelAllowlist === undefined ||
        task.workModelAllowlist.includes(modelName(m))),
  );
  let checks = config.work?.checks;
  if (checks === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      checks = pkg.scripts?.test ? [{ command: "npm", args: ["test"] }] : [];
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      checks = [];
    }
  }
  const work = (task.record.work = {
    ...(task.record.work ?? {}),
    checks: structuredClone(checks),
    changes: [],
    acceptance: [],
    operations: [],
    capacity: [],
    requests: [],
  });
  const members = new Map(),
    nativeSeats = new Map(),
    runtimes = new Set(),
    listeners = new Set();
  let v,
    executionError,
    pluginWork,
    leader,
    mainBinding,
    active = 0,
    leaderSeat = { held: false },
    epoch = 0,
    revision = 0,
    seatWaiters = [],
    observerErrors = [];
  function save() {
    try {
      task.save();
    } catch (e) {
      task.ioError = e;
      try {
        task.stop(e);
      } catch {}
      throw e;
    }
  }
  function guard() {
    if (task.signal.aborted || task.record.status !== "running" || task.ioError)
      throw (
        task.signal.reason ??
        task.ioError ??
        problem("TASK_ENDED", "任务已停止。")
      );
  }
  function capacity() {
    work.capacity.push({ active, at: new Date().toISOString() });
    save();
  }
  function notify(resource = false) {
    if (resource) epoch++;
    revision++;
    for (const fn of [...listeners]) fn();
    schedule();
  }
  function waitChange(seen, signal = task.signal) {
    if (revision !== seen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const fn = () => {
        listeners.delete(fn);
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        listeners.delete(fn);
        reject(signal.reason);
      };
      listeners.add(fn);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  function syncChange(raw) {
    let c = work.changes.find((x) => x.changeId === raw.changeId);
    if (c) Object.assign(c, raw);
    else {
      c = raw;
      work.changes.push(c);
    }
    save();
    return c;
  }
  function binding(c, role, record) {
    return {
      current: c,
      role,
      record,
      reads: new Map(),
      observations: new Map(),
      reviewedVersion: null,
    };
  }
  function selected(id) {
    const m = members.get(id);
    if (!m) throw problem("MEMBER", "成员不存在；使用delegate返回的memberId。");
    return m;
  }
  const unknownModel = (m) =>
    task
      .requests()
      .some(
        (r) => r.role === m.binding?.role && r.status === "outcome_unknown",
      );
  function choose(name) {
    const m = available.find((m) => modelName(m) === name);
    if (!m)
      throw problem(
        "MODEL_UNAVAILABLE",
        "从冻结列表选择：" + available.map(modelName).join(", "),
      );
    return m;
  }
  function assertModelFree(model, self = null) {
    // Project staffing claims the work and the position together before starting a session.
    if (staff) return;
    const occupied = [...members.values()].find(
      (m) =>
        m !== self &&
        workModelIdentity(m.record.model) === workModelIdentity(model) &&
        (unknownModel(m) ||
          m.binding?.unknownOperation ||
          m.record.kernelUnknownRequestId ||
          m.record.status === "outcome_unknown" ||
          (!["accepted", "abandoned"].includes(m.record.status) &&
            !(m.record.status === "completed" &&
              m.record.collected &&
              (m.record.readOnly || m.record.noChange)))),
    );
    if (occupied)
      throw problem(
        "MEMBER_BUSY",
        `模型已有未处理成员 memberId=${occupied.record.memberId}，status=${occupied.record.status}；collect已有成员，检查未知requestId或给出具体feedback；勿新建副本。`,
      );
  }
  async function invoke(action, input, fn) {
    guard();
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
        if (staff && coordinated && input.actor === "main" && change?.actor?.startsWith("member:"))
          staff.checkOwner({taskId:task.record.id, actorRole:"main", dispatchId:change.actor.slice(7), rootReview:true});
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
        if (coordinated) await pluginWork?.assertHandled(input.changeId);
        if (task.projectPolicy && !request.dispatched) {
          request.dispatched = true;
          save();
        }
        return fn(id);
      };
      let result = coordinated ? await withChangeQueue(v, input.changeId, execute) : await execute();
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
    const input = {
      requestId: options.requestId ?? randomUUID(),
      actor,
      ...(actor === "result" ? {actorRole:"main"} : {}),
      scope: readOnly ? [] : scope,
      readScope: readScope ?? (task.record.rootTaskId ? task.record.project.readScope : ["."]),
      intent,
      readOnly,
      wait: options.wait ?? false,
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
    const perform=async()=>{
      guard();
      const actor=mainBinding?.current.changeId===c.changeId?mainBinding:[...members.values()].find(m=>m.binding?.current.changeId===c.changeId)?.binding;
      if(c.status==="outcome_unknown"||actor?.unknownOperation)throw problem("OPERATION_UNKNOWN","Resolve the original operation ID before abandoning this change");
      await pluginWork?.assertHandled(c.changeId);
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
    await pluginWork?.assertHandled(old.changeId);
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
    const c = actor.current;
    await pluginWork?.assertHandled(c.changeId);
    if (c.status === "outcome_unknown" || actor.unknownOperation)
      throw problem("OPERATION_UNKNOWN", "未知结果只能查询已有ID。");
    const requestId = randomUUID();
    const r = await invoke("prepareChange", { changeId: c.changeId, actor:caller, requestId }, (id) =>
      v.prepareChange(c.changeId, { requestId: id, check }),
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
  function finishPromise(m) {
    m.resolve?.();
    m.resolve = null;
  }
  function resetPromise(m) {
    m.promise = new Promise((r) => (m.resolve = r));
  }
  function schedule() {
    if (!v || task.signal.aborted || task.ioError) return;
    while (active < 2 && seatWaiters.length) {
      const {seat, resolve} = seatWaiters.shift();
      if (!seat.held) {
        seat.held = true;
        active++;
        capacity();
      }
      resolve();
    }
    while (active < 2 && !seatWaiters.length) {
      const m = [...members.values()].find(
        (m) =>
          m.record.status === "queued" ||
          (m.record.status === "waiting" && m.retryEpoch < epoch),
      );
      if (!m) break;
      const attemptEpoch = epoch;
      m.record.status = "starting";
      m.held = true;
      active++;
      capacity();
      m.attempt = executeMember(m, attemptEpoch);
      m.attempt.catch(() => {});
    }
  }
  async function acquireSeat(seat) {
    guard();
    const signal = seat.controller?.signal ?? task.signal;
    signal.throwIfAborted();
    if (seat.held) return;
    await new Promise((resolve, reject) => {
      const waiter = {seat, resolve: () => { signal.removeEventListener("abort", abort); resolve(); }};
      const abort = () => {
        seatWaiters = seatWaiters.filter(w => w !== waiter);
        reject(signal.reason);
      };
      seatWaiters.push(waiter);
      signal.addEventListener("abort", abort, {once:true});
      schedule();
    });
    guard();
    signal.throwIfAborted();
  }
  function releaseSeat(seat) {
    if (!seat.held) return;
    seat.held = false;
    active--;
    capacity();
  }
  const nativeScheduler={
    async acquire(id,signal=task.signal){
      if(typeof id!=='string'||!id.startsWith('helper:'))throw problem('PROJECT_NATIVE_UNBOUND','Native seat needs its host helper identity');
      let seat=nativeSeats.get(id);
      if(!seat){seat={held:false,controller:{signal:AbortSignal.any([task.signal,signal])}};nativeSeats.set(id,seat);}
      try{await acquireSeat(seat);}catch(error){releaseSeat(seat);notify(true);throw error;}
    },
    release(id){const seat=nativeSeats.get(id);if(seat){releaseSeat(seat);notify(true);}},
    async waitFor(actor,operation){
      const seat=actor==='main'?leaderSeat:actor.startsWith('member:')?members.get(actor.slice('member:'.length)):nativeSeats.get(actor);
      if(!seat)throw problem('PROJECT_NATIVE_UNBOUND','Only the actual creator can yield its seat');
      const signal=seat.controller?.signal??task.signal;
      seat.nativeWaitDepth=(seat.nativeWaitDepth??0)+1;
      if(seat.nativeWaitDepth===1){seat.nativeWasHeld=seat.held;releaseSeat(seat);notify(true);}
      try{return await (typeof operation==='function'?operation():operation);}
      finally{seat.nativeWaitDepth--;if(seat.nativeWaitDepth===0&&seat.nativeWasHeld&&!task.signal.aborted&&!signal.aborted&&!task.ioError)await acquireSeat(seat);}
    },
  };
  async function executeMember(m, attemptEpoch) {
    let blocked = false;
    try {
      guardMember(m);
      if (m.transition) {
        const intent = m.transition;
        let result;
        if (intent.kind !== "refresh") {
          observationScope(m.binding, intent.scope, intent.readScope);
          result = await begin(
            m.binding.current.actor,
            intent.scope,
            intent.readScope,
            m.record.assignment,
            intent.kind === "observe",
            {
              requestId: intent.requestId,
              signal: AbortSignal.any([task.signal, m.controller.signal]),
            },
          );
          if (result.status !== "blocked") {
            const old = m.binding.current,
              delta = await observedDelta(m.binding, result);
            m.record.previousChanges ??= [];
            m.record.previousChanges.push(old.changeId);
            if (old.status !== "abandoned")
              await abandon(old, "只读调查转为明确写意图");
            m.binding.current = result;
            m.binding.readChangeId = result.changeId;
            if (delta) markRefresh(m.binding, delta);
          }
        } else {
          result = await invoke(
            "refreshChange",
            {
              requestId: intent.requestId,
              changeId: m.binding.current.changeId,
              scope: intent.scope, readScope: intent.readScope,
            },
            (id) =>
              v.refreshChange(
                m.binding.current.changeId,
                {
                  requestId: id,
                  reason: intent.reason,
                  scope: intent.scope,
                  readScope: intent.readScope,
                },
                {
                  wait: false,
                  signal: AbortSignal.any([task.signal, m.controller.signal]),
                },
              ),
          );
          if (result.status === "unknown") {
            m.binding.unknownOperation = intent.requestId;
            throw Object.assign(
              problem("OPERATION_UNKNOWN", "刷新结果未知：" + intent.requestId),
              { requestId: intent.requestId },
            );
          }
          if (result.status !== "blocked") {
            m.binding.current = syncChange(result);
            markRefresh(m.binding, result);
          }
        }
        if (m.controller.signal.aborted || task.signal.aborted)
          throw problem("CANCELLED", "刷新交接取消");
        if (result.status === "blocked") {
          blocked = true;
          m.retryEpoch = attemptEpoch;
          m.record.status = "waiting";
          m.record.blockers = result.blockers;
          return;
        }
        m.transition = null;
        m.record.changeId = m.binding.current.changeId;
        m.record.baseVersion = m.binding.current.baseVersion;
        m.record.workspace = m.binding.current.workspace;
      }
      if (!m.binding || m.newChange) {
        m.beginId ??= randomUUID();
        m.record.beginRequestId = m.beginId;
        save();
        const c = await begin(
          "member:" + m.record.memberId,
          m.record.scope,
          m.record.readScope,
          m.record.assignment,
          m.record.readOnly,
          {
            requestId: m.beginId,
            signal: AbortSignal.any([task.signal, m.controller.signal]),
          },
        );
        if (m.controller.signal.aborted || task.signal.aborted)
          throw problem("CANCELLED", "成员获权交接时取消");
        if (c.status === "blocked") {
          blocked = true;
          m.retryEpoch = attemptEpoch;
          m.record.status = "waiting";
          m.record.blockers = c.blockers;
          return;
        }
        if (m.binding) {
          m.binding.current = c;
          m.binding.reads.clear();
          m.binding.observations.clear();
          m.binding.reviewedVersion = null;
          m.binding.unknownOperation = null;
          m.binding.failedMutations?.clear();
        } else m.binding = binding(c, "member:" + m.record.memberId, m.record);
        m.newChange = false;
        m.record.changeId = c.changeId;
        m.record.baseVersion = c.baseVersion;
        m.record.workspace = c.workspace;
      }
      guardMember(m);
      m.record.status = "running";
      m.record.blockers = [];
      m.record.changeId = m.binding.current.changeId;
      m.record.baseVersion = m.binding.current.baseVersion;
      m.record.workspace = m.binding.current.workspace;
      save();
      const readTools = [...(m.record.reviewOf ? ["read"] : ["read", "grep", "find", "ls"]), "read_skill", "get_capabilities"];
      if (!m.runtime) {
        const defs = workspaceTools({
          task,
          visualPreview: task.record.workRequest?.kind === "html-svg",
          stage: () => m.stage,
          versioning: v,
          binding: m.binding,
          getChange: () => m.binding.current,
          readOnly: Boolean(m.record.reviewOf),
          reviewVersion: m.record.reviewVersion,
          onChanged: (c) => {
            m.binding.current = syncChange(c);
          },
          assertOwned: () => {
            guardMember(m);
            if (m.conflictHalted)
              throw problem("TASK_CONFLICT", "Member execution stopped after reporting a task conflict; preserve the draft and provide concrete feedback.");
            if (m.controller.signal.aborted)
              throw problem("CANCELLED", "成员取消");
            if (!refreshReady(m.binding))
              throw problem(
                "REFRESH_REQUIRES_REQUEST",
                "成员必须先收到自己的刷新材料。",
              );
          },
          onProgress,
        });
        defs.push(...pluginWork.resourceTools({actor:"member:"+m.record.memberId,binding:m.binding,signal:m.controller.signal,assertAllowed:()=>{guardMember(m);if(m.conflictHalted||m.resolvingConflict||!m.record.understandingCallId)throw problem("TASK_CONFLICT","Resource execution requires completed independent preparation");}}));
        defs.push(...pluginWork.tools({actor: "member:"+m.record.memberId,binding:m.binding,model:m.record.model,signal:m.controller.signal,getModelContract:(provider,id)=>leader.modelRuntime.getModel(provider,id),getPricing:()=>leader.modelRuntime.getModel(m.record.model.provider,m.record.model.modelId)?.cost,
          assertAllowed:()=>{guardMember(m);if(m.controller.signal.aborted)throw problem("CANCELLED","Member no longer permits helpers");if(m.conflictHalted || m.resolvingConflict || !m.record.understandingCallId)
            throw problem("TASK_CONFLICT", "Helper tools require completed independent preparation and no unresolved conflict");}}));
        defs.push({
          name: "report_task_conflict",
          label: "report_task_conflict",
          description: "Report a conflict between the original user task and delegated instructions. Execution stops and the draft is preserved. After concrete feedback, resolved=true confirms your own consistent understanding; only a successful confirmation request can clear the conflict.",
          parameters: Type.Object({
            message: Type.String({ description: "Specific conflict or resolution reasons, quoting the relevant source text." }),
            resolved: Type.Optional(Type.Boolean({ description: "Confirm resolution during a later feedback request; defaults to false." })),
          }),
          async execute(id, args) {
            guardMember(m);
            if (m.controller.signal.aborted) throw problem("CANCELLED", "Member was cancelled.");
            if (!args.message.trim()) throw problem("TASK_CONFLICT", "A specific conflict or resolution explanation is required.");
            const requestId = currentRequest(m.binding)?.id;
            if (args.resolved) {
              if (!m.resolvingConflict || !m.record.taskConflict?.unresolved || m.conflictHalted)
                throw problem("TASK_CONFLICT", "Resolution is allowed only after concrete feedback in a subsequent member request.");
              m.pendingResolution = { message: args.message, requestId };
            } else {
              const previous = m.record.taskConflict;
              m.record.taskConflict = { message: args.message, requestId, unresolved: true,
                ...(previous ? { previous } : {}) };
              m.pendingResolution = null;
              m.conflictHalted = true;
            }
            // End the current tool turn without aborting a completed provider request.
            m.record.tools = [...readTools, "report_task_conflict"];
            m.runtime.setToolNames(m.record.tools);
            m.runtime.stopAfterTurn();
            save();
            return text({ status: args.resolved ? "resolution_pending_request_completion" : "task_conflict", message: args.message });
          },
        });
        const position = projectPosition(m);
        if (position?.canDelegate && position.supervisorId === "root" && !m.record.reviewOf) {
          m.groupTools = ["delegate", "collect", "feedback"].map(name => groupFactories.get(name)(m));
          m.groupTools.push(...staff.tools(position.id, detail => {
            guardMember(m);
            if (m.conflictHalted || m.resolvingConflict || !m.record.understandingCallId)
              throw problem("TASK_CONFLICT", "Staffing is unavailable during independent preparation or conflict resolution.");
            task.projectPolicy.admit("delegate", {actor:m.binding.role,...detail});
          }, task.record.id));
          defs.push(...m.groupTools);
        }
        m.toolNames = defs.map(d => d.name);
        m.runtime = await createRuntime({
          home,
          cwd: m.binding.current.workspace,
          modelRef: m.record.model,
          role: "member-" + m.record.memberId,
          getWorkspaceAuthority:()=>({active:m.record.status==='running'&&!m.controller.signal.aborted,scope:m.binding.current.scope,readScope:m.binding.current.readScope,readOnly:m.binding.current.readOnly||!!m.record.coordinatingMemberId||m.conflictHalted||m.resolvingConflict}),
          projectManaged:Boolean(staff),
          packageSnapshot: task.packageSnapshot,
          useFrozenSkills: true,
          uiContext:task.extensionUI,
          uiMode:task.extensionMode,
          nativeContext: await pluginWork.context({actor:"member:"+m.record.memberId,binding:m.binding,signal:m.controller.signal,assertAllowed:()=>{guardMember(m);if(m.controller.signal.aborted)throw problem("CANCELLED","Native plugin owner stopped");}}),
          resourceOptions: { ...task.resourceOptions, systemPrompt: prompt("worker") + (m.groupTools
            ? "\nHost-authorized project supervisor. After independent preparation you can delegate to direct reports, collect their results and return concrete feedback. Use the registered work and exact authorized model route, including your own model when suitable. Report fixed candidate IDs and versions to the project leader for formal acceptance."
            : "") },
          toolDefinitions: defs,
          activeToolNames: readTools,
          maxOutputTokens,
          timeout,
        });
        m.toolNames.push(...(m.runtime.projectToolNames ?? []));
        runtimes.add(m.runtime);
      }
      guardMember(m);
      const executionInfo = {
        readOnly: m.binding.current.readOnly,
        scope: m.binding.current.scope,
        readScope: m.binding.current.readScope,
        checks,
        execution: work.execution ? {
          engine: work.execution.engine,
          image: work.execution.image,
          network: work.execution.network,
          limits: work.execution.limits,
          artifactPaths: work.execution.artifactPaths,
        } : null,
      };
      if (m.record.reviewOf) {
        const verified = await staff.reviewCandidate(m.record.reviewOf, task, v, m.binding.current.readScope,
          m.record.supervisorMemberId ? "member:" + m.record.supervisorMemberId : "main");
        if (m.record.reviewVersion !== verified.artifact.version)
          throw problem("REVIEW_SOURCE", "The candidate has changed since the reviewer was assigned.");
        m.reviewArtifact = verified.artifact;
      }
      const material = (preparation, tools) => buildMemberTaskMaterial({
        originalTask: task.record.input,
        assignment: m.reviewArtifact ? "Review the exact candidate against the original task." : m.record.assignment,
        implementationAdvice: m.reviewArtifact && m.record.reviewKind !== "ordinary" ? "" : m.record.implementationAdvice,
        reason: m.reviewArtifact ? "Host-bound candidate review." : m.record.reason,
        project: task.record.project,
        execution: {...executionInfo,
          ...(m.effectMaterial && !preparation ? {effectMaterial:m.effectMaterial} : {}),
          ...(m.reviewArtifact ? {reviewArtifact:m.reviewArtifact, reviewKind:m.record.reviewKind,
            ...(!preparation ? {reviewInstruction:"Finish with a JSON object containing verdict (pass/reject/uncertain) and observation (specific candidate evidence or counterexample). No prose outside JSON. For rejection solely on the absence of an exact literal, specify counterexample:{kind:'missing_text',path,text}. To refute it, include refutesRequestId and evidence:{path,quote} showing that exact literal on this candidate. Other objections require repair and re-review."} : {})} : {}),
          ...(!preparation && m.routeEvidence ? {diagnosis:m.routeEvidence} : {}),
          ...(!preparation && m.groupTools ? {directReports:directReports(m), registeredWork:staff.works(task.record.id,m.binding.role),
            ...(m.record.coordinatingMemberId ? {coordinationOnlyFor:m.record.coordinatingMemberId} : {})} : {})},
        tools, preparation,
        answerSkills: task.answerSkills ?? [],
        feedback: m.feedback, refresh: m.binding.refreshInput,
        taskConflict: m.record.taskConflict?.unresolved ? m.record.taskConflict : undefined,
      });
      if (!m.record.understandingCallId) {
        // An explicit feedback turn cannot replay a failed/unknown preparation.
        if (m.record.preparationStarted)
          throw problem("PREPARATION_FAILED", "Preparation did not complete; it is not automatically replayed.");
        m.record.preparationStarted = true;
        m.stage = task.beginPhase("worker-prepare", m.binding.role, m.record.model);
        m.runtime.setToolNames(readTools);
        m.runtime.bindTask(task, m.stage);
        m.record.sessionFile = m.runtime.sessionManager.getSessionFile();
        save();
        const understanding = await m.runtime.prompt(material(true, readTools), { custom: "cothink-member-preparation" });
        guardMember(m);
        if (understanding.message?.stopReason !== "stop" || !understanding.text.trim())
          throw problem("PREPARATION_FAILED", "Preparation needs a complete, nonempty understanding before implementation.");
        m.record.understanding = understanding.text;
        m.record.understandingCallId = understanding.call.id;
        save();
      }
      const activeTools = m.record.coordinatingMemberId
        ? [...readTools, "collect", "feedback", "report_task_conflict"]
        : m.binding.current.readOnly ? [...readTools, ...(m.runtime.projectToolNames ?? []), "report_task_conflict", ...(m.groupTools ?? []).map(t => t.name)] : m.toolNames;
      m.record.tools = activeTools;
      m.conflictHalted = false;
      if (m.record.taskConflict?.unresolved) {
        m.resolvingConflict = true;
        m.pendingResolution = null;
        const confirmationTools = [...readTools, "report_task_conflict"];
        m.stage = task.beginPhase("worker-conflict-resolution", m.binding.role, m.record.model);
        m.record.tools = confirmationTools;
        m.runtime.setToolNames(confirmationTools);
        m.runtime.bindTask(task, m.stage);
        try {
          m.result = await m.runtime.prompt(material(false, confirmationTools), { custom: "cothink-conflict-correction" });
          guard();
          if (m.controller.signal.aborted) throw problem("CANCELLED", "Conflict confirmation was cancelled.");
          const resolution = m.pendingResolution;
          if (!resolution || m.conflictHalted ||
              !task.requests().some(r => r.id === resolution.requestId && r.status === "completed"))
            throw problem("TASK_CONFLICT", "The member has not confirmed resolution of the task conflict.");
          Object.assign(m.record.taskConflict, { unresolved: false,
            resolution: resolution.message, resolutionRequestId: resolution.requestId });
          save();
        } finally {
          m.resolvingConflict = false;
          m.pendingResolution = null;
        }
      }
      if (staff && !m.record.readOnly && !m.effectMaterial && staff.assignment(m.record.memberId)?.effect)
        m.effectMaterial = await prepareEffect(m.record.workId, m);
      m.record.tools = activeTools;
      m.stage = task.beginPhase(m.feedback ? "worker-feedback" : "worker", m.binding.role, m.record.model);
      m.runtime.setToolNames(activeTools);
      m.runtime.bindTask(task, m.stage);
      m.record.sessionFile = m.runtime.sessionManager.getSessionFile();
      save();
      m.result = await m.runtime.prompt(material(false, activeTools), { custom: "cothink-member-assignment" });
      guardMember(m);
      if (m.record.taskConflict?.unresolved)
        throw problem("TASK_CONFLICT", "The member reported an unresolved task conflict; preserve the draft and provide concrete correction or request user clarification.");
      if ([...members.values()].some(child => child.record.supervisorMemberId === m.record.memberId &&
          !child.record.supervisorCollected && !["accepted","abandoned"].includes(child.record.status)))
        throw problem("GROUP_UNFINISHED", "Collect the direct report's result before handing off this subgoal.");
      refreshReady(m.binding);
      if (m.binding.failedMutations?.size)
        throw problem(
          "UNRESOLVED_TOOL",
          "成员仍有未完成的文件写入；给出具体反馈修复或明确放弃。",
        );
      if (!m.record.readOnly) {
        try {
          m.binding.current = await prepare(m.binding);
          m.record.candidateVersion = m.binding.current.candidateVersion;
          m.record.diff = m.binding.current.diff;
          m.record.ignoredFiles = m.binding.current.ignoredFiles;
        } catch (e) {
          if (e.code !== "NO_WRITE_CHANGE") throw e;
          m.record.noChange = true;
          await abandon(m.binding.current, "已确认无源码变化");
        }
      } else await abandon(m.binding.current, "只读调查完成");
      m.record.status = "completed";
      delete m.record.error;
      delete m.record.errorCode;
      m.record.callId = m.result.call.id;
      if (m.record.reviewOf) {
        await staff.completeReview(m.record, task, v);
        m.record.reviewReceipts = staff.assignment(m.record.memberId)?.reviewReceipts ?? [];
      }
    } catch (e) {
      if (e.code === "OPERATION_UNKNOWN")
        m.record.kernelUnknownRequestId = e.requestId ?? m.beginId ?? null;
      if (m.record.status !== "abandoned")
        m.record.status =
          m.controller.signal.aborted || task.signal.aborted
            ? "cancelled"
            : unknownModel(m) ||
                m.binding?.unknownOperation ||
                e.code === "OPERATION_UNKNOWN"
              ? "outcome_unknown"
              : "failed";
      m.record.error = e.message;
      m.record.errorCode = e.code ?? "ERROR";
    } finally {
      try { releaseSeat(m); } catch (error) { task.ioError = error; }
      m.attempt = null;
      if (!blocked || m.controller.signal.aborted || task.signal.aborted)
        finishPromise(m);
      try {
        if (!blocked && !["accepted","abandoned"].includes(m.record.status)) {
          staffUpdate(m, m.record.status === "outcome_unknown" ? "unknown" : "result");
        }
        save();
        notify(!blocked);
      } catch (e) {
        task.ioError = e;
        task.stop(e);
      }
    }
  }
  const tools = [];
  const groupFactories = new Map();
  const projectPosition = m => staff?.list().find(p => p.id === m.record.staffId);
  const directReports = owner => staff?.list().filter(p => p.supervisorId === (owner?.record.staffId ?? "root"));
  function rememberDiagnosis(route) {
    if (route?.taskId !== task.record.id || !route.changeId) return;
    const owner = [...members.values()].find(m => m.record.changeId === route.changeId);
    if (owner) owner.routeEvidence = {candidate:route.candidate, privateVersion:route.privateVersion,
      checks:route.evidence?.checks, judgment:route.judgment, observation:route.probe};
  }
  function assignmentInput(record) {
    return {staffId: record.staffId, dispatchId: record.memberId, actor: record.supervisorId,
      identity: workModelIdentity(record.model), model: modelName(record.model),
      workId: record.workId, assignment:record.assignment, implementationAdvice:record.implementationAdvice,
      dependsOn:record.dependsOn, reason:record.reason, reviewKind:record.reviewKind,
      rootModel:modelName(config.main), rootIdentity:workModelIdentity(config.main),
      actorRole:record.supervisorMemberId ? "member:" + record.supervisorMemberId : "main",
      supervisorMemberId:record.supervisorMemberId,
      scope: record.scope, readScope: record.readScope, readOnly: record.readOnly,
      taskId: task.record.id, role: record.memberId && "member:" + record.memberId, reviewOf: record.reviewOf};
  }
  function staffUpdate(m, status) {
    if (!staff) return;
    const unknown = unknownModel(m) || m.binding?.unknownOperation || m.record.kernelUnknownRequestId;
    if (unknown) status = "unknown";
    if (m.projectStatus === status) return;
    staff.update(m.record.memberId, {status, outcome:status === "disposed" ? m.record.status : undefined, candidate: m.record.candidateVersion, version:m.record.acceptedVersion,
      baseVersion:m.record.baseVersion, requestId: m.record.kernelUnknownRequestId ?? m.binding?.unknownOperation ?? task.requests().findLast(r => r.role === m.binding?.role)?.id,
      failure:m.record.error, changeId:m.record.changeId});
    m.projectStatus = status;
  }
  function owns(owner, member, rootReview = false) {
    if (owner && (member.record.supervisorMemberId !== owner.record.memberId ||
        (owner.record.coordinatingMemberId && owner.record.coordinatingMemberId !== member.record.memberId)))
      throw problem("GROUP_OWNERSHIP", "Only a direct report of this supervisor may be collected or corrected.");
    if (staff) staff.checkOwner({taskId:task.record.id, actorRole:owner?.binding.role ?? "main",
      dispatchId:member.record.memberId, rootReview});
    return member;
  }
  function guardMember(m) {
    guard();
    m.controller.signal.throwIfAborted();
    if (staff) staff.checkWork({taskId:task.record.id, role:"member:" + m.record.memberId});
  }
  function register(name, description, properties, fn) {
    const definition = owner => ({
      name,
      label: name,
      description,
      parameters: Type.Object(properties),
      ...(staff && ["collect","project_effect"].includes(name) ? {executionMode:"sequential"} : {}),
      async execute(id, args, signal) {
        guard();
        if (signal?.aborted) throw signal.reason;
        try {
          if (owner) {
            guardMember(owner);
            if (owner.conflictHalted || owner.resolvingConflict || !owner.record.understandingCallId ||
                !projectPosition(owner)?.canDelegate)
              throw problem("GROUP_OWNERSHIP", "This session does not currently hold group authority.");
          }
          const result = await fn(args, id, owner);
          guard();
          save();
          return text(result);
        } catch (e) {
          if (task.ioError || task.signal.aborted) throw e;
          return {
            ...text({ error: { code: e.code ?? "ERROR", message: e.message } }),
            isError: true,
          };
        }
      },
    });
    if (["delegate", "collect", "feedback"].includes(name)) groupFactories.set(name, definition);
    tools.push(definition(null));
  }
  const summary = (m) => {
    const previews = (work.visualEvidence ?? []).filter(e => e.actor === m.binding?.role);
    const requests = task.requests();
    return { ...m.record, result: m.result?.text ?? null,
      capabilities: { source: "Host-registered member tools", registeredTools: m.toolNames ?? [], activeTools: m.record.tools ?? [] },
      preview: { source: "Host-recorded previews; acceptance is version storage, not semantic proof",
        successful: previews.filter(e => e.result === "captured").length,
        failed: previews.filter(e => e.result === "failed").length,
        evidence: previews.map(e => ({
          result: e.result, entry: e.entry, sourceVersion: e.sourceVersion, privateVersion: e.privateVersion,
          candidateVersion: m.record.candidateVersion ?? null,
          currentCandidate: e.privateVersion === m.binding?.current.privateVersion,
          imageRequestId: e.imageRequestId,
          imageRequestCompleted: !!e.imageRequestId && requests.some(r => r.id === e.imageRequestId && r.status === "completed"),
          screenshots: e.images.map((i,index) => ({ outputRef: e.outputRef, index, sha256: i.sha256, capturedAtMs: i.capturedAtMs })),
        })),
      },
    };
  };
  function hasReady(m) {
    return ["completed", "failed", "outcome_unknown", "cancelled"].includes(
      m.record.status,
    );
  }
  function blockersFor(targets) {
    const ids = new Set(
      targets.flatMap((m) => (m.record.blockers ?? []).map((b) => b.changeId)),
    );
    return [...members.values()].filter(
      (m) => ids.has(m.binding?.current.changeId) && hasReady(m),
    );
  }
  function cycleToOwner(targets, owner, seen = new Set()) {
    for (const m of targets) {
      if (seen.has(m.record.memberId)) continue;
      seen.add(m.record.memberId);
      if (m.record.waitingFor) {
        const cycle = cycleToOwner(m.record.waitingFor.map(selected), owner, seen);
        if (cycle) return cycle;
      }
      for (const b of m.record.blockers ?? []) {
        if (b.changeId === (owner?.binding ?? mainBinding).current.changeId) return b;
        const next = [...members.values()].find(
          (x) => x.binding?.current.changeId === b.changeId,
        );
        if (next) {
          const cycle = cycleToOwner([next], owner, seen);
          if (cycle) return cycle;
        }
      }
    }
    return null;
  }
  if (!task.record.singleModel)
    register(
      "delegate",
      "Assign a bounded responsibility to an eligible model. The host supplies the original user task; assignment and implementationAdvice cannot override it. Legacy task/materials parameters are rejected.",
      {
        model: Type.String({ description: "Exact eligible model identity." }),
        assignment: Type.String({ description: "Member responsibility, subordinate to the original task." }),
        implementationAdvice: Type.Optional(Type.String({ description: "Optional leader suggestions or hypotheses, not user requirements." })),
        reason: Type.String({ description: "Reason for selecting this executor." }),
        scope: Type.Optional(Type.Array(Type.String())),
        readScope: Type.Optional(Type.Array(Type.String())),
        readOnly: Type.Optional(Type.Boolean()),
        dependsOn: Type.Optional(Type.Array(Type.String())),
        ...(staff ? {staffId: Type.String({description:"Authorized direct report position ID."}),
          workId: Type.Optional(Type.String({description:"Host-registered work ID. Omit only when the host can identify one authorized boundary."})),
          reviewKind: Type.Optional(Type.Union([Type.Literal("ordinary"), Type.Literal("independent")])),
          reviewOf: Type.Optional(Type.String({description:"Employee dispatch ID or exact root candidate reviewOf returned by prepare_change."}))} : {}),
      },
      async (args, toolId, owner) => {
        if ("task" in args || "materials" in args)
          throw problem("DELEGATE_INPUT", "Legacy task/materials are not supported. Use assignment and optional implementationAdvice; the host supplies the original task.");
        if (!args.assignment.trim() || !args.reason.trim())
          throw problem("DELEGATE_INPUT", "Assignment and selection reason must not be empty.");
        for (const id of args.dependsOn ?? [])
          if (owns(owner, selected(id)).record.status !== "accepted")
            throw problem("DEPENDENCY", "依赖尚未正式接纳：" + id);
        const model = choose(args.model);
        if(task.record.workRequest && !args.readOnly && !leader.modelRuntime.getModel(model.provider,model.modelId)?.input?.includes("image")) throw problem("VISUAL_MODEL","制作执行成员必须支持图像；不降级成文字检查。");
        assertModelFree(model);
        const record = {
          ...(staff ? {staffId: args.staffId, supervisorId: owner?.record.staffId ?? "root",
            supervisorMemberId: owner?.record.memberId ?? null, reviewOf: args.reviewOf,
            reviewKind:args.reviewKind ?? (args.reviewOf ? "independent" : undefined), workId:args.workId} : {memberId:randomUUID()}),
          model,
          assignment: args.assignment,
          implementationAdvice: args.implementationAdvice ?? "",
          reason: args.reason,
          scope: args.scope ?? [],
          readScope:
            args.readScope ??
            (args.readOnly && args.scope?.length ? args.scope : task.record.rootTaskId ? task.record.project.readScope : ["."]),
          readOnly: args.readOnly ?? false,
          dependsOn: args.dependsOn ?? [],
          status: "queued",
          feedback: [],
        };
        if (staff) {
          if (record.reviewKind && !record.reviewOf)
            throw problem("REVIEW_SOURCE", "A review needs a fixed candidate reference.");
          const position = directReports(owner)?.find(p => p.id === record.staffId);
          if (!position || (position.canDelegate && owner))
            throw problem("GROUP_OWNERSHIP", "Select an authorized direct report of this group.");
          const input = assignmentInput(record);
          if (record.reviewOf) {
            const verified = await staff.reviewCandidate(record.reviewOf, task, v, record.readScope, owner?.binding.role ?? "main");
            input.reviewSource = verified.source;
            record.reviewVersion = verified.artifact.version;
          }
          task.projectPolicy.admit("delegate", input);
          const claim = staff.begin(input);
          record.memberId = claim.dispatchId;
          record.workId = claim.workId;
          if (claim.reused || members.has(claim.dispatchId) || claim.taskId !== task.record.id || claim.status !== "active") {
            const receipt = {memberId:claim.dispatchId, workId:claim.workId, status:claim.status, taskId:claim.taskId,
              requestId:claim.requestId, changeId:claim.changeId, candidate:claim.candidate, resultVersion:claim.version};
            if (!["result","disposed"].includes(claim.status)) return receipt;
            const original = claim.taskId === task.record.id ? task.record : readTask(home, claim.taskId);
            const member = original.members?.find(m => m.memberId === claim.dispatchId);
            if (member?.callId) {
              const call = claim.taskId === task.record.id ? task.requests().find(r => r.id === member.callId)
                : readRequest(home, claim.taskId, member.callId);
              if (call?.role === claim.role && call.status === "completed") receipt.result = call.text;
            }
            return receipt;
          }
        }
        const m = { record, controller: new AbortController(), retryEpoch: -1 };
        m.controller.signal.addEventListener(
          "abort",
          () => {
            void pluginWork?.stopActor?.("member:"+m.record.memberId).catch(error=>{m.record.stopError=error.message;save();});
            for (const child of members.values())
              if (child.record.supervisorMemberId === m.record.memberId) child.controller.abort();
            void m.runtime?.session.abort();
            if (!m.attempt) finishPromise(m);
          },
          { once: true },
        );
        resetPromise(m);
        members.set(record.memberId, m);
        task.record.members.push(record);
        save();
        schedule();
        return { memberId: record.memberId, ...(staff ? {workId:record.workId} : {}), status: record.status };
      },
    );
  register(
    "collect",
    "Collect stopped member results, conflicts and host-recorded tool/preview evidence. Returns a ready blocking candidate when relevant; rejects a dependency cycle. Image delivery is not semantic proof.",
    { memberId: Type.Optional(Type.String()) },
    async (args, toolId, owner) => {
      const targets = args.memberId
        ? [owns(owner, selected(args.memberId), !owner)]
        : owner?.record.coordinatingMemberId ? [owns(owner, selected(owner.record.coordinatingMemberId))]
        : [...members.values()].filter(m => !staff || m.record.supervisorMemberId === (owner?.record.memberId ?? null));
      if (owner) {
        owner.record.waitingFor = targets.map(m => m.record.memberId);
        save();
      }
      const seat = owner ?? leaderSeat;
      releaseSeat(seat);
      notify(true);
      try {
        for (;;) {
          guard();
          if (owner) guardMember(owner);
          for (const m of targets) owns(owner, m, !owner);
          const seen = revision;
          schedule();
          const ready = targets.filter(
              (m) =>
                hasReady(m) &&
                (!(m.record.readOnly || m.record.noChange) ||
                  !m.record.collected ||
                  args.memberId),
            ),
            blocking = blockersFor(targets);
          if (owner && blocking.some(m => m.record.supervisorMemberId !== owner.record.memberId))
            throw problem("GROUP_BLOCKED", "A draft outside this group is blocking a direct report; ask the project leader to resolve it.");
          if (ready.length || blocking.length)
            return {
              members: [...new Set([...ready, ...blocking])].map((m) => {
                if (m.binding && m.record.status === "completed") {
                  if (owner) {
                    m.record.supervisorReviewedVersion = m.binding.current.privateVersion;
                    m.record.supervisorReviewCallId = currentRequest(owner.binding)?.id;
                  } else if (staff) {
                    m.record.rootReviewedVersion = m.binding.current.privateVersion;
                    m.record.rootReviewCallId = currentRequest(mainBinding)?.id;
                  }
                  else m.binding.reviewedVersion = m.binding.current.privateVersion;
                }
                if (owner) m.record.supervisorCollected = true;
                if (!m.record.supervisorMemberId || owner) m.record.collected = true;
                if (m.record.collected && m.record.status === "completed" && (m.record.readOnly || m.record.noChange))
                  staffUpdate(m, "disposed");
                return summary(m);
              }),
              waiting: targets.filter((m) => !hasReady(m)).map(summary),
            };
          if (
            targets.every(
              (m) =>
                ["accepted", "abandoned"].includes(m.record.status) ||
                ((m.record.readOnly || m.record.noChange) &&
                  m.record.status === "completed"),
            )
          )
            return { members: targets.map(summary), waiting: [] };
          const cycle = cycleToOwner(targets, owner);
          if (cycle)
            throw problem(
              "WOULD_DEADLOCK",
              "A member is waiting for the leader's write scope; handle your own draft first: " +
                JSON.stringify(cycle),
            );
          await waitChange(seen, owner?.controller.signal ?? task.signal);
        }
      } finally {
        if (owner) delete owner.record.waitingFor;
        if (!task.signal.aborted && !task.ioError && !owner?.controller.signal.aborted) await acquireSeat(seat);
      }
    },
  );
  async function prepareEffect(workId, member) {
    const owner = member?.binding ?? mainBinding;
    const modelRef = member?.record.model ?? config.main;
    const signal = member?.controller.signal ?? task.signal;
    return task.projectPolicy.prepareEffect({task, role:owner.role, workId, changeId:owner.current.changeId, modelRef,
      async wait(pending) {
        const seat = member ?? leaderSeat;
        releaseSeat(seat);
        notify(true);
        let abort;
        try {
          signal.throwIfAborted();
          await Promise.race([pending, new Promise((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, {once:true});
          })]);
        } finally {
          if (abort) signal.removeEventListener("abort", abort);
          if (!task.signal.aborted && !signal.aborted && !task.ioError) await acquireSeat(seat);
        }
      },
      run:async (stage, material) => {
        guard();
        signal.throwIfAborted();
        const runtime = await createRuntime({
          home, cwd:owner.current.workspace, modelRef, role:"project-effect-" + stage.id, projectManaged:true,
          packageSnapshot:{...task.packageSnapshot, extensions:[], skills:[], prompts:[], themes:[]},
          resourceOptions:{noContextFiles:true, systemPrompt:"Produce only the frozen project effect described in the host input. You have no tools or access to other employees' materials."},
          activeToolNames:[], toolDefinitions:[], maxOutputTokens, timeout,
        });
        runtimes.add(runtime);
        const stop = () => { void runtime.session.abort(); };
        try {
          signal.addEventListener("abort", stop, {once:true});
          signal.throwIfAborted();
          runtime.bindTask(task, stage);
          return await runtime.prompt(material, {custom:"cothink-project-effect"});
        } finally {
          signal.removeEventListener("abort", stop);
          await runtime.dispose();
          runtimes.delete(runtime);
        }
      },
    });
  }
  if (staff) register("project_effect",
    "Read or perform the selected work's explicitly approved effect. The host binds the target, action and round and reuses existing evidence.",
    {workId:Type.String({description:"Exact frozen project work ID."})},
    async ({workId}) => prepareEffect(workId));
  register(
    "prepare_change",
    "可选：固定/预检领导草稿并展示确切diff。",
    { check: Type.Optional(Type.Boolean()) },
    async (args) => {
      if (!refreshReady(mainBinding))
        throw problem(
          "REFRESH_REQUIRES_REQUEST",
          "当前执行者尚未收到刷新差异。",
        );
      const c = await prepare(mainBinding, args.check ?? false);
      mainBinding.reviewedVersion = c.privateVersion;
      if (!staff) return c;
      return {...c, reviewOf:`root:${task.record.id}:${c.changeId}:${c.candidateVersion}`,
        ...(mainBinding.projectRoute ? {route:mainBinding.projectRoute} : {})};
    },
  );
  if (task.projectPolicy) {
    const decision = Type.Union([Type.Literal("repair"), Type.Literal("shorten"), Type.Literal("blocked")]);
    register(
      "project_route_judge",
      "After a failed user-entry check, propose one read-only test on the exact frozen candidate. Give the repository path, distinguishing literal, and bounded decisions for finding or missing that literal. Use the resulting evidence before any repair.",
      {reason:Type.String(), path:Type.String(), contains:Type.String(), ifPresent:decision, ifAbsent:decision,
        repairScope:Type.Array(Type.String())},
      async (args, toolCallId) => {
        const route = await task.projectPolicy.judgeLive(args, {actor:"main", toolCallId, versioning:v});
        rememberDiagnosis(route);
        return route;
      },
    );
  }
  register(
    "inspect_change",
    "查询正式事实、旧请求、候选、历史或版本差异，不执行模型/检查。",
    {
      memberId: Type.Optional(Type.String()),
      requestId: Type.Optional(Type.String()),
      history: Type.Optional(
        Type.Object({
          limit: Type.Optional(Type.Number()),
          cursor: Type.Optional(Type.String()),
        }),
      ),
      fromVersion: Type.Optional(Type.String()),
      toVersion: Type.Optional(Type.String()),
    },
    async (args) => {
      let fact;
      if (args.requestId) fact = await v.inspect({ requestId: args.requestId });
      else if (args.history) fact = await v.inspect({ history: args.history });
      else if (args.fromVersion)
        fact = await v.inspect({
          fromVersion: args.fromVersion,
          toVersion: args.toVersion,
        });
      else
        fact = await v.inspect({
          changeId: args.memberId
            ? selected(args.memberId).binding?.current.changeId
            : mainBinding.current.changeId,
        });
      if (["applied", "completed"].includes(fact.status) && args.requestId) {
        const trace = (task.record.tools ?? []).find(
          (t) => t.requestId === args.requestId,
        );
        const actors = [
          mainBinding,
          ...[...members.values()].map((m) => m.binding),
        ].filter(Boolean);
        const actor = actors.find((a) => a.unknownOperation === args.requestId);
        if (actor && trace) {
          actor.current = syncChange(
            await v.inspect({ changeId: trace.changeId }),
          );
          actor.unknownOperation = null;
          actor.failedMutations?.delete(trace.sourcePath);
          for (const p of fact.files ?? fact.changedFiles ?? [])
            actor.failedMutations?.delete(p);
          trace.reportedStatus ??= trace.status;
          trace.status =
            fact.exitCode !== undefined && fact.exitCode !== 0
              ? "failed"
              : "completed";
          trace.exitCode = fact.exitCode ?? trace.exitCode;
          trace.kernelStatus = fact.status;
          trace.resolvedByQuery = true;
          const diff = await v.inspect({
            fromVersion: actor.current.baseVersion,
            toVersion: actor.current.privateVersion,
          });
          actor.reviewedVersion = actor.current.privateVersion;
          fact = { ...fact, diff, changeId: actor.current.changeId };
          for (const m of members.values())
            if (m.binding === actor && !unknownModel(m)) {
              delete m.record.kernelUnknownRequestId;
              if (m.record.status === "outcome_unknown") {
                m.record.status =
                  m.result?.message?.stopReason === "stop"
                    ? "completed"
                    : "failed";
                m.record.diff = diff;
              }
            }
          save();
        }
      }
      if (fact.status === "accepted") {
        const receipt = work.acceptance.find(
          (r) => r.requestId === fact.requestId,
        );
        if (receipt) {
          const old = receipt.status;
          Object.assign(receipt, fact, {
            reportedStatus: receipt.reportedStatus ?? old,
          });
        }
        const c = work.changes.find((c) => c.changeId === fact.changeId);
        if (c)
          Object.assign(c, {
            status: "accepted",
            acceptedVersion: fact.acceptedVersion,
          });
        for (const m of members.values())
          if (m.binding?.current.changeId === fact.changeId)
            Object.assign(m.record, {
              status: "accepted",
              acceptedVersion: fact.acceptedVersion,
              acceptance: fact,
            });
        work.version = (await v.inspect()).version;
        notify(true);
      }
      return fact;
    },
  );
  register(
    "accept_change",
    "Accept reviewed content after host candidate and latest-combination checks. Unresolved task conflicts block acceptance. Unseen Shell changes return a diff first; acceptance is not semantic or visual proof.",
    { memberId: Type.Optional(Type.String()) },
    async (args) => {
      const m = args.memberId ? selected(args.memberId) : null,
        actor = m?.binding ?? mainBinding;
      if (m?.record.taskConflict?.unresolved)
        throw problem("TASK_CONFLICT", "Cannot accept a member draft with an unresolved task conflict. Send concrete corrective feedback; only the member can confirm resolution.");
      if (!actor) throw problem("MEMBER", "成员尚未获权");
      const c = actor.current;
      await pluginWork?.assertHandled(c.changeId);
      if (m && m.record.status === "accepted") return m.record.acceptance;
      if (m && m.record.status !== "completed")
        throw problem("MEMBER_BUSY", "先collect等待成员明确停止");
      if (actor.unknownOperation || c.status === "outcome_unknown")
        throw problem(
          "OPERATION_UNKNOWN",
          "先inspect_change查询原requestId，禁止新ID绕过。",
        );
      if (!refreshReady(actor))
        throw problem(
          "REFRESH_REQUIRES_REQUEST",
          "该执行者尚未在后续真实请求收到刷新差异。",
        );
      if (c.status === "accepted")
        return work.acceptance.findLast(
          (r) => r.changeId === c.changeId && r.status === "accepted",
        );
      if (m?.record.noChange)
        return { status: "no_write_change", changeId: c.changeId };
      if (m && staff) owns(null, m, true);
      const fixed = await prepare(actor, false, "main");
      if (!refreshReady(actor))
        throw problem(
          "REFRESH_REQUIRES_REQUEST",
          "刷新差异必须进入该执行者后续请求。",
        );
      const nested = !!m?.record.supervisorMemberId;
      if (nested && (m.record.supervisorReviewedVersion !== fixed.privateVersion ||
          !receivedVersion("member:" + m.record.supervisorMemberId, m.record.supervisorReviewCallId, fixed.privateVersion)))
        throw problem("GROUP_REVIEW", "The direct supervisor must receive this fixed candidate before formal acceptance.");
      const reviewed = staff && m
        ? m.record.rootReviewedVersion === fixed.privateVersion && receivedVersion("main", m.record.rootReviewCallId, fixed.privateVersion)
        : actor.reviewedVersion === fixed.privateVersion && (!staff || task.requests().some(r =>
          r.role === "main" && r.status === "completed" && r.context?.messages?.some(msg =>
            msg.role === "toolResult" && !msg.isError && ["edit","write","prepare_change","accept_change","inspect_change"].includes(msg.toolName) &&
            JSON.stringify(msg.content).includes(fixed.privateVersion))));
      if (!reviewed) {
        if (staff && m) {
          m.record.rootReviewedVersion = fixed.privateVersion;
          m.record.rootReviewCallId = currentRequest(mainBinding)?.id;
        } else actor.reviewedVersion = fixed.privateVersion;
        return {
          status: "review_required",
          changeId: fixed.changeId,
          diff: fixed.diff,
          privateVersion: fixed.privateVersion,
        };
      }
      const requestId = randomUUID(),
        pending = {
          status: "pending",
          requestId,
          changeId: fixed.changeId,
          candidateVersion: fixed.candidateVersion,
        };
      work.acceptance.push(pending);
      save();
      const result = await invoke("acceptChange", {...pending, actor:"main"}, (id) =>
        v.acceptChange({ ...pending, requestId: id }),
      );
      Object.assign(pending, result);

      work.version = (await v.inspect()).version;
      if (result.status === "accepted") {
        Object.assign(fixed, {
          status: "accepted",
          acceptedVersion: result.acceptedVersion,
        });
        if (m)
          Object.assign(m.record, {
            status: "accepted",
            acceptedVersion: result.acceptedVersion,
            acceptance: result,
          });
        if (m) staffUpdate(m, "disposed");
        notify(true);
      } else if (result.status === "unknown") {
        fixed.status = "outcome_unknown";
        if (m) m.record.status = "outcome_unknown";
      } else if (result.status === "basis_changed")
        fixed.basisStatus = "changed";
      save();
      const route = await task.projectPolicy?.observeCheck?.({kind:"candidate", candidate:fixed.candidateVersion, privateVersion:fixed.privateVersion,
        changeId:fixed.changeId, versioning:v, result});
      rememberDiagnosis(route);
      return route ? {...pending, route} : pending;
    },
  );
  register(
    "feedback",
    "Send specific corrective feedback on the same unaccepted draft. A task conflict requires the same member to confirm the correction before writes resume. Only new work after acceptance starts a new change.",
    {
      memberId: Type.String(),
      feedback: Type.String(),
      ...(staff ? {coordinateMemberId:Type.Optional(Type.String({description:"Root only: resume the original read-only supervisor to correct this direct report's diagnosed, unaccepted candidate."}))} : {}),
      model: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Array(Type.String())),
      readScope: Type.Optional(Type.Array(Type.String())),
    },
    async (args, toolId, owner) => {
      const m = owns(owner, selected(args.memberId));
      if (!args.feedback.trim()) throw Error("需要具体反馈");
      if (
        !["completed", "failed", "accepted"].includes(m.record.status) ||
        unknownModel(m) ||
        m.binding?.unknownOperation
      )
        throw problem("MEMBER_BUSY", "成员必须已明确停止且无未知请求");
      const nextModel = choose(args.model ?? modelName(m.record.model));
      if (m.record.taskConflict?.unresolved && modelName(nextModel) !== modelName(m.record.model))
        throw problem("TASK_CONFLICT", "The member that reported the conflict must receive and confirm the correction; changing model cannot clear it.");
      assertModelFree(nextModel, m);
      if (staff) {
        if (owner && m.record.status === "completed" && (!m.record.supervisorCollected ||
            !receivedVersion(owner.binding.role, m.record.supervisorReviewCallId, m.binding.current.privateVersion)))
          throw problem("GROUP_REVIEW", "Collect and inspect the direct report's candidate before feedback.");
        const input = assignmentInput({...m.record, model: nextModel, scope: args.scope ?? m.record.scope,
          readOnly: args.scope?.length ? false : m.record.readOnly, readScope: args.readScope ?? m.record.readScope});
        if (input.actor !== (owner?.record.staffId ?? "root"))
          throw problem("GROUP_OWNERSHIP", "Feedback belongs to the direct supervisor.");
        if (m.record.status === "accepted")
          throw problem("PROJECT_STAFF", "The work was accepted. Select another authorized work item.");
        const draft = m.binding?.current;
        let coordination;
        if (args.coordinateMemberId) {
          const child = selected(args.coordinateMemberId);
          if (child.record.supervisorMemberId !== m.record.memberId) throw problem("GROUP_OWNERSHIP", "Coordination requires this supervisor's direct report.");
          if (owner || !projectPosition(m)?.canDelegate || !m.record.readOnly || !m.record.collected ||
              m.record.status !== "completed" || draft?.status !== "abandoned" || !child.record.supervisorCollected ||
              child.record.status !== "completed" || !child.binding?.current.candidateVersion ||
              args.scope || args.readScope || modelName(nextModel) !== modelName(m.record.model))
            throw problem("GROUP_REVIEW", "Coordination must resume the original settled read-only supervisor for its known candidate.");
          const c = child.binding.current;
          coordination = {dispatchId:child.record.memberId, changeId:c.changeId, privateVersion:c.privateVersion, candidate:c.candidateVersion};
        }
        task.projectPolicy.admit("feedback", {...input, actorRole:owner?.binding.role ?? "main",
          changeId:draft?.changeId, privateVersion:draft?.privateVersion, candidate:draft?.candidateVersion, coordination,
          existingResult:m.record.collected && m.record.status === "completed" &&
            !m.record.noChange && !m.record.readOnly && !args.scope && !args.readScope && modelName(nextModel) === modelName(m.record.model)});
        staff.resume(input);
        m.record.coordinatingMemberId = coordination?.dispatchId;
        if (coordination) m.routeEvidence = selected(coordination.dispatchId).routeEvidence;
        m.projectStatus = "active";
      }
      // Validate before changing the draft, identity, or queued state.
      m.record.model = nextModel;
      if (m.record.status === "accepted" || m.record.noChange ||
          (staff && m.record.readOnly && m.binding?.current.status === "abandoned")) {
        m.record.previousChanges ??= [];
        m.record.previousChanges.push(m.binding.current.changeId);
        m.newChange = true;
        m.beginId = null;
      } else if (m.binding && (args.scope || args.readScope)) {
        if (m.record.readOnly && args.scope?.length) m.record.readOnly = false;
        m.transition = {
          kind: m.binding.current.readOnly
            ? args.scope?.length
              ? "write-observation"
              : "observe"
            : "refresh",
          requestId: randomUUID(),
          reason: args.feedback,
          scope: args.scope ?? m.binding.current.scope,
          readScope: args.readScope ?? m.binding.current.readScope,
        };
        m.record.refreshRequestId = m.transition.requestId;
      }
      if (args.scope) m.record.scope = args.scope;
      if (args.readScope) m.record.readScope = args.readScope;
      m.record.feedback.push(args.feedback);
      m.feedback = args.feedback;
      m.record.status = "queued";
      m.record.collected = false;
      m.record.noChange = false;
      delete m.record.candidateVersion;
      delete m.record.supervisorReviewedVersion;
      delete m.record.supervisorCollected;
      delete m.record.supervisorReviewCallId;
      resetPromise(m);
      save();
      notify(true);
      return {
        memberId: m.record.memberId,
        status: m.record.status,
        changeId: m.binding?.current.changeId,
      };
    },
  );
  register(
    "refresh_change",
    "仅针对依据/范围变化或明确环境重置保留草稿刷新。差异必须进入该执行者下一请求。",
    {
      memberId: Type.Optional(Type.String()),
      reason: Type.String(),
      scope: Type.Optional(Type.Array(Type.String())),
      readScope: Type.Optional(Type.Array(Type.String())),
      resetExecution: Type.Optional(Type.Boolean()),
    },
    async (args) => {
      if (!args.reason.trim()) throw Error("需要具体刷新原因");
      const m = args.memberId ? selected(args.memberId) : null,
        actor = m?.binding ?? mainBinding;
      if (!actor) throw Error("尚无修改");
      if (
        m &&
        (!["completed", "failed"].includes(m.record.status) || unknownModel(m))
      )
        throw problem("MEMBER_BUSY", "成员必须已停止且无未知请求");
      if (actor.unknownOperation)
        throw problem("OPERATION_UNKNOWN", "未知命令不能通过刷新重发。");
      if (actor.current.readOnly && args.scope?.length) {
        observationScope(
          actor,
          args.scope,
          args.readScope ?? actor.current.readScope,
        );
        const old = actor.current,
          c = await begin(
            old.actor,
            args.scope,
            args.readScope ?? old.readScope,
            args.reason,
            false,
          );
        if (c.status === "blocked") return c;
        const delta = await observedDelta(actor, c);
        await abandon(old, "明确写意图替换只读观察");
        actor.current = c;
        notify(true);
        return markRefresh(actor, {
          ...c,
          feedback: delta ?? {
            fromVersion: old.baseVersion,
            toVersion: c.baseVersion,
          },
        });
      }
      const result = await invoke(
        "refreshChange",
        { changeId: actor.current.changeId, scope:args.scope, readScope:args.readScope },
        (id) =>
          v.refreshChange(
            actor.current.changeId,
            { ...args, requestId: id },
            { wait: false },
          ),
      );
      if (result.status === "unknown") {
        actor.unknownOperation = result.requestId;
        actor.current.status = "outcome_unknown";
        throw problem("OPERATION_UNKNOWN", JSON.stringify(result));
      }
      if (result.status === "blocked") {
        actor.current = syncChange(
          await v.inspect({ changeId: actor.current.changeId }),
        );
        notify(true);
        return result;
      }
      actor.current = syncChange(result);
      actor.reviewedVersion = null;
      if (m) {
        delete m.record.candidateVersion;
        m.record.diff = result.diff ?? null;
      }
      notify(true);
      return markRefresh(actor, result);
    },
  );
  register(
    "abandon_member",
    "取消等待/运行并确认结束，保留全部草稿和记录。",
    { memberId: Type.String(), reason: Type.String() },
    async (args) => {
      const m = owns(null, selected(args.memberId), true);
      if (!args.reason.trim()) throw Error("需要具体放弃理由");
      if (m.record.status === "accepted") throw Error("接纳不会回滚");
      m.record.status = "abandoned";
      m.record.abandonReason = args.reason;
      save();
      m.controller.abort();
      try {await pluginWork?.stopActor?.("member:"+m.record.memberId,{reason:args.reason});}
      catch(error){m.record.status="outcome_unknown";m.record.stopError=error.message;save();throw error;}
      await m.promise;
      if (m.binding) await abandon(m.binding.current, args.reason);
      staffUpdate(m, "disposed");
      notify(true);
      return summary(m);
    },
  );
  register(
    "abandon_change",
    "明确放弃领导草稿，保留内容。",
    { reason: Type.String() },
    async (args) => {
      if (!args.reason.trim()) throw Error("需要具体放弃理由");
      if (
        mainBinding.current.status === "outcome_unknown" ||
        mainBinding.unknownOperation
      )
        throw problem("OPERATION_UNKNOWN", "先查询未知结果");
      mainBinding.failedMutations?.clear();
      await abandon(mainBinding.current, args.reason);
      return mainBinding.current;
    },
  );
  register(
    "next_change",
    "换一件工作；无scope时只读观察，未接纳草稿应refresh而非丢弃。",
    {
      reason: Type.String(),
      scope: Type.Optional(Type.Array(Type.String())),
      readScope: Type.Optional(Type.Array(Type.String())),
    },
    async (args) => {
      if (!args.reason.trim()) throw Error("需要具体工作理由");
      const old = mainBinding.current,
        actual = await v.inspect({ changeId: old.changeId });
      if (mainBinding.failedMutations?.size && actual.status !== "abandoned")
        throw problem(
          "UNRESOLVED_TOOL",
          "仍有未完成的写入；修复或明确放弃后才换任务。",
        );
      if (
        !["accepted", "abandoned"].includes(actual.status) &&
        actual.privateVersion !== actual.baseVersion
      )
        throw problem(
          "UNACCEPTED_CHANGE",
          "草稿尚在；请accept、refresh或明确放弃",
        );
      if (!["accepted", "abandoned"].includes(actual.status))
        await abandon(old, "切换已确认无修改的观察");
      const c = await begin(
        "main",
        args.scope,
        args.readScope,
        args.reason,
        !args.scope?.length,
      );
      if (c.status === "blocked") return c;
      mainBinding.current = c;
      mainBinding.reads.clear();
      mainBinding.observations.clear();
      mainBinding.reviewedVersion = null;
      mainBinding.readChangeId = c.changeId;
      notify(true);
      return c;
    },
  );
  async function reviewVisual(material, evidence) {
    if (task.requests().some(r => r.sent && ["in_flight", "outcome_unknown"].includes(r.status)) ||
        [...members.values()].some(m => m.attempt || m.binding?.unknownOperation || m.record.kernelUnknownRequestId))
      throw problem("VISUAL_BUSY", "Independent visual review requires the leader and members to have no in-flight or unknown requests.");
    const review = evidence.review = {
      verdict: "uncertain", status: "running", observation: "", reasons: "",
      integrationVersion: evidence.integrationVersion,
      imageHashes: evidence.images.map(i => i.sha256), model: { ...config.main }, requestId: null,
    };
    const reviewStage = task.beginPhase("visual-review", "main", config.main);
    let runtime, submitted = false;
    try {
      runtime = await createRuntime({
        home, cwd: mainBinding.current.workspace, modelRef: config.main,
        role: "visual-review-" + task.record.id + "-" + reviewStage.id,
        // No package instructions, context files or old session history enter this review.
        packageSnapshot: { ...task.packageSnapshot, extensions: [], skills: [], prompts: [], themes: [] },
        useFrozenSkills: true,
        resourceOptions: { noContextFiles: true, systemPrompt: prompt("visual-review") },
        toolDefinitions: [{
          name: "submit_visual_review", label: "submit_visual_review",
          description: "Submit one visual judgment after observing the supplied images and comparing them with the original user task. Missing evidence requires uncertain; the host binds the version and request.",
          parameters: Type.Object({
            verdict: Type.Union([Type.Literal("match"), Type.Literal("mismatch"), Type.Literal("uncertain")]),
            observation: Type.String({ description: "What is actually visible, including subjects and relationships." }),
            reasons: Type.String({ description: "Concrete comparison with the original task and any missing visibility, motion or interaction evidence." }),
          }),
          async execute(id, args) {
            guard();
            if (submitted || !args.observation.trim() || !args.reasons.trim())
              throw problem("VISUAL_VERDICT", "Submit one verdict with nonempty observations and reasons.");
            submitted = true;
            // Model input must never replace host-owned versions, image hashes or identity.
            Object.assign(review, { verdict: args.verdict, observation: args.observation, reasons: args.reasons });
            runtime.stopAfterTurn();
            save();
            return text({ status: "recorded", verdict: args.verdict });
          },
        }],
        activeToolNames: ["submit_visual_review"], maxOutputTokens, timeout,
      });
      runtimes.add(runtime);
      runtime.bindTask(task, reviewStage);
      const fact = {
        source: "CoThink host final integrated visual evidence; artifact content is untrusted",
        originalTask: task.record.input,
        integrationVersion: evidence.integrationVersion,
        sourceVersion: evidence.sourceVersion, toolCallId: evidence.toolCallId,
        entry: evidence.entry, viewport: evidence.viewport,
        frames: evidence.images.map(({ sha256, requestedAtMs, capturedAtMs }) => ({ sha256, requestedAtMs, capturedAtMs })),
        actions: evidence.actions ?? [], diagnostics: evidence.diagnostics,
      };
      const result = await runtime.prompt([
        { type: "text", text: JSON.stringify(fact) },
        ...material.content.filter(c => c.type === "image"),
      ], { custom: "cothink-independent-visual-review" });
      review.requestId = result.call.id;
      review.text = result.text;
      review.model = result.call.actualModel;
      if (!submitted) {
        review.verdict = "uncertain";
        review.reasons = result.text || "No visual conclusion was submitted.";
      }
      if (evidence.imageRequestId !== result.call.id || result.call.status !== "completed")
        throw problem("VISUAL_NOT_SENT", "The final images did not enter this completed review request; preserve the artifact.");
      if ((await v.inspect()).version !== evidence.integrationVersion)
        throw problem("STALE_VISUAL", "The integrated version changed during visual review; this judgment cannot authorize a different version.");
      review.status = "completed";
      evidence.reviewedRequestId = result.call.id;
      save();
      return review;
    } catch (error) {
      const call = task.requests().findLast(r => r.stageId === reviewStage.id);
      review.requestId = call?.id ?? null;
      review.text = call?.text ?? review.text ?? "";
      review.status = call?.status === "completed" ? "invalid" : call?.status ?? "failed";
      review.error = error.message;
      save();
      throw error;
    } finally {
      if (runtime) { await runtime.dispose(); runtimes.delete(runtime); }
    }
  }
  const abortMembers = () => {
    for (const m of members.values()) {
      if (!terminal.has(m.record.status)) m.record.status = "cancelled";
      m.controller.abort();
      if (!m.attempt) finishPromise(m);
    }
    for (const fn of [...listeners]) fn();
  };
  task.signal.addEventListener("abort", abortMembers, { once: true });
  try {
    v = await createVersioning({
      project: cwd,
      home,
      checks,
      execution: config.work?.execution,
      signal: task.signal,
      onOperation: (e) => {
        work.operations.push(e);
        try {
          save();
        } catch {}
        try {
          onProgress({ type: "git", operation: e, task });
        } catch (error) {
          observerErrors.push({ action: e.action, message: error.message });
        }
      },
    });
    Object.assign(work, await v.inspect(), {
      toolHome: v.toolHome,
      kernelVersion: JSON.parse(
        readFileSync(
          new URL("../packages/agent-sync/package.json", import.meta.url),
          "utf8",
        ),
      ).version,
    });
    work.startVersion = work.version;
    const expectedStart = task.record.project?.startVersion;
    if (expectedStart && work.startVersion !== expectedStart)
      throw problem("PROJECT_VERSION", "Formal project version no longer matches the approved startVersion.");
    pluginWork = await createPluginWork({task,versioning:v,execution:work.execution,maxOutputTokens,remoteMachines:config.work?.remoteMachines,nativeScheduler});
    task.record.members = [];
    save();
    await acquireSeat(leaderSeat);
    const intent = task.record.workIntent ?? {},
      initial = await begin(
        "main",
        intent.scope,
        intent.readScope,
        task.record.input,
        !intent.scope?.length,
      );
    work.startVersion = initial.baseVersion ?? work.startVersion;
    if (expectedStart && work.startVersion !== expectedStart)
      throw problem("PROJECT_VERSION", "Initial change is based on a different version than the approved project step.");
    if (initial.status === "blocked")
      throw problem("SCOPE_BLOCKED", JSON.stringify(initial));
    mainBinding = binding(initial, "main", work);
    const stage = task.beginPhase("work", "main", config.main);
    leader = await createRuntime({
      home,
      cwd: initial.workspace,
      modelRef: config.main,
      role: "leader-" + task.record.id,
      getWorkspaceAuthority:()=>({scope:mainBinding.current.scope,readScope:mainBinding.current.readScope,readOnly:mainBinding.current.readOnly}),
      projectManaged:Boolean(staff),
      packageSnapshot: task.packageSnapshot,
      useFrozenSkills: true,
      uiContext:task.extensionUI,
          uiMode:task.extensionMode,
      nativeContext: await pluginWork.context({actor:"main",binding:mainBinding,assertAllowed:guard}),
      resourceOptions: {
        ...(task.resourceOptions ?? selectedResources(config, cwd)),
        systemPrompt: prompt("leader") + "\n\n" + (task.record.singleModel
          ? "This task uses ONE single-model work mode at the Team layer. You are the sole Team owner; formal secondary member delegation is unavailable. Installed managed plugin helpers may assist unless the user disabled them. Review helper results and perform final checks and delivery yourself. Any host-required visual review uses this same main model."
          : prompt("leader-cothink") + "\n\n" + (staff ? prompt("leader-project")
            : "Never delegate to yourself or a known alias. One actual model may not have parallel A+A/B+B copies. Collect or give concrete feedback to an existing unresolved member and finish it safely before reusing that model sequentially. Installed managed plugin helpers do not become Team members or independent reviewers. Each creator must explicitly treat its own helper results. Another explicitly selected configured model may continue a draft with change identity and provenance retained.")),
      },
      extraToolNames: config.piResources?.tools ?? [],
      toolDefinitions: [
        ...workspaceTools({
          task,
          visualPreview: task.record.workRequest?.kind === "html-svg",
          stage,
          versioning: v,
          binding: mainBinding,
          getChange: () => mainBinding.current,
          ensureWrite: ensureMainWrite,
          onChanged: (c) => {
            mainBinding.current = syncChange(c);
          },
          assertOwned: guard,
          onProgress,
        }),
        ...pluginWork.resourceTools({actor:"main",binding:mainBinding,assertAllowed:guard}),
        ...tools,
        ...(staff?.tools("root", detail => { guard(); task.projectPolicy.admit("delegate", {actor:"main",...detail}); }, task.record.id) ?? []),
        ...pluginWork.tools({actor:"main",binding:mainBinding,model:config.main,assertAllowed:guard,getModelContract:(provider,id)=>leader.modelRuntime.getModel(provider,id),getPricing:()=>leader.modelRuntime.getModel(config.main.provider,config.main.modelId)?.cost}),
      ],
      maxOutputTokens,
      timeout,
    });
    runtimes.add(leader);
    leader.bindTask(task, stage);
    const modelFact = (m) => {
      const model = leader.modelRuntime.getModel(m.provider, m.modelId);
      return {
        identity: modelName(m),
        actualModelIdentity: workModelIdentity(m),
        input: model?.input,
        reasoning: model?.reasoning,
        contextWindow: model?.contextWindow,
        maxTokens: model?.maxTokens,
        thinkingLevel: m.thinkingLevel ?? (model?.reasoning ? DEFAULT_THINKING_LEVEL : null),
        thinkingSetting: m.thinkingLevel === undefined ? (model?.reasoning ? `Host default ${DEFAULT_THINKING_LEVEL}` : "Reasoning is not enabled for this model") : "Effective setting for this task",
      };
    };
    initialMaterial ??= task.requests().find((r) => r.phase === "draft")
      ?.context?.messages;
    if(task.materialContext?.length&&Array.isArray(initialMaterial)){
      initialMaterial=initialMaterial.map(message=>Array.isArray(message.content)?
        {...message,content:message.content.filter(block=>block.type!=="image")}:message);
    }
    let result = await leader.prompt(
      `Original user task:\n${task.record.input}\nFrozen initial material: ${JSON.stringify(initialMaterial ?? [])}\nLeader identity and catalog facts: ${JSON.stringify(modelFact(config.main))}\n${staff ? "Project positions reporting to you: " + JSON.stringify(directReports(null)) + "\nRegistered project work: " + JSON.stringify(staff.works(task.record.id)) + "\nEligible frozen project model routes" : "Eligible secondary models"} (matching actualModelIdentity values are aliases of one model, not independent experts): ${JSON.stringify(available.map(modelFact))}\nCurrent singleModel=${task.record.singleModel}; capacity=2; maxCalls=null.\nInput version=${initial.baseVersion}; source projection=${initial.workspace}; readOnly=${initial.readOnly}; write scope=${JSON.stringify(initial.scope)}\nOriginal directory=${v.root} (uncommitted content is outside the formal starting version; the original directory is not automatically overwritten).\nExecution capabilities=${JSON.stringify(work.execution)}; fixed checks=${JSON.stringify(checks)}. Apply the role, authorization and execution rules in the system prompt to these current facts.\n${renderAnswerSkills(task.answerSkills ?? [])}`,
    );
    let lastVisualVersion, lastReviewKey, lastEvidenceCount;
    for (;;) {
    guard();
    await pluginWork.assertHandled();
    if (mainBinding.failedMutations?.size)
      throw problem(
        "UNRESOLVED_TOOL",
        "仍有未完成的文件写入；不能把模型停止当作交付完成。",
      );
    if (result.message?.stopReason !== "stop" || !result.text.trim())
      throw problem("NO_FINAL", "缺完整最终文本，保存已有成果。");
    if (
      [...members.values()].some(
        (m) =>
          !["accepted", "abandoned"].includes(m.record.status) &&
          !(
            m.record.status === "completed" &&
            (m.record.readOnly || m.record.noChange)
          ),
      )
    )
      throw problem(
        "UNFINISHED_MEMBERS",
        "成员未收尾；请collect、接纳、反馈或明确放弃。",
      );
    for (const c of work.changes.filter(
      (c) => c.actor === "main" && !c.readOnly && c.status !== "abandoned",
    )) {
      const actual = await v.inspect({ changeId: c.changeId });
      if (
        c.status === "outcome_unknown" ||
        (actual.status !== "accepted" &&
          actual.privateVersion !== actual.baseVersion)
      )
        {
          const diff=await v.inspect({fromVersion:actual.baseVersion,toVersion:actual.privateVersion});
          if(!task.record.workRequest||c.status==="outcome_unknown"||diff.files.length||diff.text||diff.binaryFiles.length)throw problem("UNACCEPTED_CHANGE", "领导草稿尚未接纳。");
          await abandon(c,"确认只有无内容变化的操作记账，结束检查");
        }
    }
    if (mainBinding.unknownOperation)
      throw problem("OPERATION_UNKNOWN", "领导尚有未知命令。");
    work.finalCheck = await invoke("checkCurrent", {}, (id) =>
      v.checkCurrent({ requestId: id }),
    );
    const finalProject = await v.inspect();
    work.version = finalProject.version;
    work.execution = finalProject.execution;
    if (task.record.project && work.finalCheck.version !== work.version)
      throw problem("PROJECT_VERSION", "The formal version changed after the final combination check.");
    await task.projectPolicy?.observeCheck?.({kind:"final", candidate:work.version, versioning:v, result:work.finalCheck});
    save();
    if (work.finalCheck.status !== "passed")
      throw problem(
        "FINAL_CHECK",
        "最新组合检查未通过：" + work.finalCheck.status,
      );
    if(task.record.workRequest) {
      if (lastVisualVersion === work.version && work.visualEvidence.length === lastEvidenceCount)
        throw problem("VISUAL_UNRESOLVED", "Visual review remains unresolved with no new version or additional captured evidence; preserve the partial artifact.");
      const tree=await v.read({version:work.version,path:'.',kind:'tree'});
      const entries=tree.entries.filter(e=>/\.(html?|svg)$/i.test(e.path)).map(e=>e.path);
      const previous=work.visualEvidence?.findLast(e=>e.result==='captured'&&entries.includes(e.entry));
      const entry=previous?.entry??(entries.length===1?entries[0]:null);
      if(!entry)throw problem('VISUAL_ENTRY','最终版本没有明确的HTML/SVG作品入口；请实际制作文件并preview_html选择入口。');
      // A pure observation command may add an operation commit. Close only after public empty-diff proof.
      const current=await v.inspect({changeId:mainBinding.current.changeId});
      if(!['accepted','abandoned','interrupted'].includes(current.status))await abandon(mainBinding.current,'最终视觉检查前结束无修改观察');
      const check=await begin('main',[entry],task.record.rootTaskId?task.record.project.readScope:['.'],'最终集成版本视觉检查',false);
      if(check.status==='blocked'||check.baseVersion!==work.version)throw problem('STALE_VISUAL','最终检查范围被占用或集成版本已改变');
      const preview=createPreviewTool({task,stage,versioning:v,getChange:()=>check,assertOwned:guard,onChanged:c=>Object.assign(check,syncChange(c)),onProgress});
      let material;
      try {
        material=await preview.execute('final-visual-'+randomUUID(),{entry, ...(previous?.viewport ? {viewport:previous.viewport} : {}), ...(previous?.frameTimesMs ? {frameTimesMs:previous.frameTimesMs} : {}), ...(previous?.actions?.length ? {actions:previous.actions} : {})},task.signal);
        const evidence=work.visualEvidence.at(-1);evidence.integrationVersion=work.version;
        const diff=await v.inspect({fromVersion:work.version,toVersion:evidence.privateVersion});
        if(diff.files.length||diff.text||diff.binaryFiles.length)throw problem('VISUAL_SOURCE_CHANGED','最终检查源码与集成版本不一致');
        await abandon(check,'最终截图已取回，确认源码未变；不接纳操作记账提交');
      } catch(e) { save(); throw e; }
      const evidence = work.visualEvidence.at(-1);
      const reviewKey = JSON.stringify([work.version, evidence.entry, evidence.viewport, evidence.images.map(i=>i.sha256), evidence.frameTimesMs, evidence.actions ?? []]);
      if (lastReviewKey === reviewKey)
        throw problem("VISUAL_UNRESOLVED", "No new visual evidence was provided; the previous review remains unresolved.");
      lastVisualVersion = work.version;
      lastReviewKey = reviewKey;
      lastEvidenceCount = work.visualEvidence.length;
      save();
      const review = await reviewVisual(material, evidence);
      const d = evidence.diagnostics;
      const runtimeErrors = !!(d.pageErrors?.length || d.resourceErrors?.length || d.console?.some(x=>x.startsWith("error:")));
      if (review.verdict === "match" && !runtimeErrors) break;
      // The original implementation context receives only specific attributed feedback.
      leader.bindTask(task, stage);
      result = await leader.prompt(JSON.stringify({
        source: "Independent visual review feedback; not a new user request",
        originalTask: task.record.input,
        review: { verdict: review.verdict, observation: review.observation, reasons: review.reasons, text: review.text },
        ...(runtimeErrors ? { runtimeErrors: d } : {}),
        instruction: "Address specific defects using the original task. Revise and accept a new version, or capture additional relevant views/interactions with preview_html. State any reasoned disagreement with new verifiable evidence. If you cannot act or supply missing evidence, explain the gap and stop; the result remains partial. Do not repeat unchanged requests or merely declare the review passed.",
      }), { custom: "cothink-visual-feedback" });
      continue;
    }
    break;
    }
    const published = await begin("result", [], task.record.rootTaskId?task.record.project.readScope:["."], "只读最终成果", true);
    if (published.baseVersion !== work.version)
      throw problem("STALE_RESULT", "最终投影版本已变化");
    work.resultWorkspace = published.workspace;
    work.resultChangeId = published.changeId;
    save();
    return result;
  } catch (e) {
    executionError=e;
    try {
      task.stop(e);
    } catch {
      task.ioError ??= e;
    }
    throw e;
  } finally {
    const cleanupErrors=[];
    const cleanup=async(phase,run)=>{try{await run();}catch(error){cleanupErrors.push({phase,error});}};
    if (task.signal.aborted) await cleanup("abort-members",()=>abortMembers());
    for (const m of members.values()) {
      await cleanup("cancel-member:"+m.record.memberId,()=>{m.controller.abort();if(!m.attempt)finishPromise(m);});
    }
    await cleanup("plugin-helpers",()=>pluginWork?.close());
    const aborts=await Promise.allSettled([...runtimes].map(rt=>rt.session.abort()));
    aborts.forEach((result,index)=>{if(result.status==="rejected")cleanupErrors.push({phase:"abort-runtime:"+index,error:result.reason});});
    await Promise.allSettled([...members.values()].map(m=>m.promise));
    await cleanup("capacity",()=>releaseSeat(leaderSeat));
    // A known partial result or an unknown shutdown in one session cannot skip another session.
    for(const rt of runtimes)await cleanup("runtime:"+rt.sessionManager.getSessionId(),()=>rt.dispose());
    task.signal.removeEventListener("abort",abortMembers);
    if(v)await cleanup("versioning",()=>v.close());
    if(cleanupErrors.length) {
      work.cleanupErrors=cleanupErrors.map(({phase,error})=>({phase,code:error.code??null,message:error.message??String(error)}));
      try{save();}catch{}
      if(!executionError)throw cleanupErrors[0].error;
    }
  }
}
