export const modelName = (model) =>
  model ? `${model.provider} / ${model.modelId}` : "来源未记录";
export const builtinSkillUse = {
  "web-design-engineer": "设计和改版网页界面，按需查阅布局、交互和视觉样式范例。",
  "doc-maintenance": "随代码变更维护用法与文档，并核对说明是否准确。",
  "context-management": "查找当前对话的上下文，并在需要时整理记要。",
};
export const THINKING_LEVELS = Object.freeze(["low","high","max"]);
export function normalizeThinkingPreference(value) {
  if (value === undefined || value === null || value === '') return 'high';
  if (['off','minimal','low'].includes(value)) return 'low';
  if (['medium','high'].includes(value)) return 'high';
  if (['xhigh','max'].includes(value)) return 'max';
  throw Error('无法识别思考档位。');
}
// Rendering preserves damaged values as an explicit error; writes still use strict normalization.
export function thinkingPreferenceView(value) {
  try {return {level:normalizeThinkingPreference(value),error:null};}
  catch {return {level:null,error:`无法识别思考档位 ${String(value)}；请选择 low、high、max。`};}
}
export function conversationThinking(session, models = []) {
  const level=normalizeThinkingPreference(session?.thinking);
  const refs=session?.team?[session.team.main,...session.team.secondary]:[];
  const problems=refs.map(ref=>{
    const model=models.find(model=>model.provider===ref.provider&&model.modelId===ref.modelId);
    if(!model)return `模型目录不可用：${modelName(ref)}；请修复目录或调整阵容。`;
    if(model.transport==='unsupported'||model.auth&&model.auth!=='configured')return model.unavailableReason??`${modelName(ref)}：模型服务配置不可用。`;
    if(model.thinkingLevels&&!model.thinkingLevels.includes(level))return `${model.name??modelName(model)} 不支持思考档位 ${level}；请修复型号配置或调整阵容。`;
    if((model.outputLimitRequired??model.api==='anthropic-messages')&&ref.maxOutputTokens==null)return `${modelName(ref)} 协议要求 maxOutputTokens，请明确配置输出额度后再发送。`;
    // Catalog facts use high and no per-ref cap. Re-evaluate those two parameter failures
    // above, while retaining errors from authentication, transport and other configuration.
    const staleThinking=model.unavailableCode==='MODEL_UNAVAILABLE'&&model.auth==='configured'&&model.transport==='project-http'&&model.thinkingLevel!=null&&model.thinkingLevels&&!model.thinkingLevels.includes(model.thinkingLevel);
    return model.available===false&&model.unavailableCode!=='REQUIRED_OUTPUT_LIMIT'&&!staleThinking?model.unavailableReason:null;
  }).filter(Boolean);
  return {level,scope:"all",levels:THINKING_LEVELS,reason:problems.join("；")||null};
}
export function elapsedLabel(task, now = Date.now()) {
  if (task?.status === "stop_unknown") return "用时未确认";
  const active = ["running", "preparing", "cancelling"].includes(task?.status);
  const endpoint = task?.cancelSettledAt ?? (task?.status === "cancelled" ? null : task?.endedAt);
  const start = Date.parse(task?.createdAt),
    end = active ? now : Date.parse(endpoint);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return "用时未知";
  const seconds = Math.floor((end - start) / 1000);
  return seconds < 60
    ? `${seconds}秒`
    : `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
}
export const statusLabel = (value) =>
  ({
    running: "进行中",
    preparing: "准备中",
    in_flight: "请求进行中",
    not_sent: "尚未发送",
    partial: "部分完成",
    blocked: "受阻",
    queued: "等待启动",
    starting: "正在启动",
    waiting: "等待中",
    unknown: "结果未知",
    rejected: "已拒绝",
    abandoned: "已放弃",
    basis_changed: "基础版本已变化",
    review_required: "需要评审",
    no_write_change: "无写入变更",
    completed: "已完成",
    failed: "失败",
    cancelled: "已停止",
    cancelling: "正在停止",
    stop_unknown: "停止未确认",
    checking_stop: "正在核对停止",
    canceled: "已停止",
    outcome_unknown: "结果未知",
    not_called: "尚未调用",
    succeeded: "已完成",
    passed: "通过",
    accepted: "已接纳",
    pending: "等待中",
    recorded: "已记录",
  })[value] ||
  value ||
  "未记录";
export const phaseLabel = (value) =>
  ({
    draft: "主答初稿",
    review: "评审",
    revision: "主答修订",
    answer: "主答",
    work: "项目工作",
    work_starting: "准备项目",
    work_main: "主模型工作",
    work_member: "成员工作",
    member: "成员工作",
    created: "任务已建立",
    initial: "主答中",
    worker: "成员工作",
    "worker-feedback": "成员处理反馈",
    "worker-prepare": "成员独立理解",
    "worker-conflict-resolution": "成员核对更正",
    "visual-review": "独立视觉审查",
  })[value] ||
  value ||
  "等待阶段记录";
export function shouldSubmit(event) {
  return (
    event.key === "Enter" &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}
export function checkLabel(check) {
  if (!check) return "未记录检查";
  if (check.status !== "passed") return `未通过 · ${statusLabel(check.status)}`;
  if (check.verification !== "passed") return "未验证（空检查策略）";
  return check.reusedFrom ? "通过（复用既有检查）" : "通过";
}
export function readGuiStorage(key, fallback = null) {
  try { return JSON.parse(globalThis.sessionStorage.getItem(key) ?? "null") ?? fallback; }
  catch { return fallback; }
}
export function writeGuiStorage(key, value) {
  try {
    if (value == null) globalThis.sessionStorage.removeItem(key);
    else globalThis.sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* A browser buffer is best-effort; the host owns saved state. */ }
}

// Local unsent text must survive background snapshots and a late submit response.
export function createDraftBook(buffer = false) {
  const drafts = new Map();
  const empty = () => ({editorVersion:2,text:"",workRequest:null,selectionId:null,editId:null,materials:[]});
  const key = id => "cothink.draft." + id;
  const dirty = draft => !!draft?.editId && draft.editId !== draft.savedEditId;
  function put(id, draft) {
    drafts.set(id, draft);
    if (buffer) writeGuiStorage(key(id), dirty(draft) ? draft : null);
  }
  function snapshotFromHost(id, editor, draftRevision, branchAnchor) {
    return {sessionId:id,...empty(),...(typeof editor === "string" ? {text:editor} : editor),revision:0,
      expectedDraftRevision:draftRevision,branchAnchor,savedEditId:typeof editor === "object" ? editor?.editId ?? null : null};
  }
  return {
    load(id, editor, draftRevision = null, branchAnchor = null) {
      if (!drafts.has(id)) {
        const host = snapshotFromHost(id,editor,draftRevision,branchAnchor);
        const local = buffer ? readGuiStorage(key(id)) : null;
        const recover = local?.sessionId===id && typeof local.editId==="string" && dirty(local) &&
          typeof local.text==="string" && Array.isArray(local.materials) &&
          Number.isSafeInteger(local.revision) && local.editId!==host.savedEditId;
        put(id,recover ? local : host);
      }
      return drafts.get(id).text;
    },
    observe(id, saved, observed) {
      const now=drafts.get(id);
      if (!now) {
        this.load(id,saved.editor ?? saved.draft,saved.draftRevision,saved.branchAnchor);
        return true;
      }
      // A read started before a newer edit or its write acknowledgement.
      if (now.editId !== observed.editId || now.savedEditId !== observed.savedEditId ||
          now.expectedDraftRevision !== observed.expectedDraftRevision || now.branchAnchor !== observed.branchAnchor) return false;
      if (dirty(now)) {
        return saved.editor?.editId === now.editId && this.confirmed(now,saved);
      }
      if (saved.editor?.editId === now.savedEditId && saved.draftRevision === now.expectedDraftRevision &&
          saved.branchAnchor === now.branchAnchor) return false;
      this.restore(id,saved);
      return true;
    },
    reconcile(id, saved, observed, recoverReceipt) {
      if (saved.selectionError || (!saved.editor && typeof saved.draft !== "string")) {
        this.load(id,"");
        return null;
      }
      const changed = this.observe(id,saved,observed);
      const editor = drafts.get(id);
      const accepted = recoverReceipt && editor.editId && editor.editId === editor.savedEditId &&
        editor.editId === saved.editor?.editId &&
        saved.submissions?.some(receipt => receipt.editorEditId === editor.editId);
      if (accepted) this.accepted(editor);
      if (!changed && !accepted) return null;
      const current = drafts.get(id);
      const save = !saved.readOnly && dirty(current);
      return {accepted, save, conflict:save && current.expectedDraftRevision !== (saved.draftRevision ?? null)};
    },
    edit(id, change) {
      const prior=drafts.get(id) ?? {sessionId:id,...empty(),revision:0,expectedDraftRevision:null,branchAnchor:null};
      put(id,{...prior,...(typeof change === "string" ? {text:change} : change),
        editId:crypto.randomUUID(),revision:prior.revision+1});
    },
    snapshot(id) { return structuredClone(drafts.get(id) ?? {}); },
    pending() { return structuredClone([...drafts.values()].filter(draft=>draft.editId && draft.editId !== draft.savedEditId)); },
    confirmed(sent, saved) {
      const now=drafts.get(sent.sessionId);
      if (!now || saved.editor?.editId !== sent.editId) return false;
      put(sent.sessionId,{...now,expectedDraftRevision:saved.draftRevision,branchAnchor:saved.branchAnchor,savedEditId:sent.editId});
      return true;
    },
    rebase(id,saved) {
      const now=drafts.get(id);
      if (now) put(id,{...now,expectedDraftRevision:saved.draftRevision,branchAnchor:saved.branchAnchor});
    },
    restore(id,saved) {
      const host = snapshotFromHost(id,saved.editor ?? saved.draft,saved.draftRevision ?? null,saved.branchAnchor ?? null);
      put(id,host);
      return host.text;
    },
    accepted(sent) {
      const now=drafts.get(sent.sessionId);
      if (!now) return;
      const same = now.editId === sent.editId && (sent.editId !== null || now.revision === sent.revision);
      const consume = sent.selectionId && now.selectionId === sent.selectionId;
      const consumeOptions=sent.turnOptions?.id&&now.turnOptions?.id===sent.turnOptions.id;
      const submitted=new Set((sent.materials??[]).map(ref=>`${ref.id}:${ref.sha256}`));
      const materials=(now.materials??[]).filter(ref=>!submitted.has(`${ref.id}:${ref.sha256}`));
      if (same || consume || consumeOptions || materials.length!==(now.materials??[]).length)
        put(sent.sessionId,{...now,materials,...(same ? {text:""} : {}),
        ...(consume ? {workRequest:null,selectionId:null} : {}),...(consumeOptions?{turnOptions:null}:{}),editId:crypto.randomUUID(),revision:now.revision+1});
    },
  };
}
export { revisionExplanation } from "../../src/final-answer.js";
export function outputReferences(value) {
  const refs = new Set();
  const visit = (v) => {
    if (v && typeof v === "object")
      for (const [key, item] of Object.entries(v)) {
        if (key === "outputRef" && typeof item === "string") refs.add(item);
        else visit(item);
      }
  };
  visit(value);
  return [...refs];
}

export function readPending() {
  const value = readGuiStorage("cothink.pending");
  return typeof value?.sessionId === "string" && typeof value?.submissionId === "string" ? value : null;
}

export function readCreations() {
  try {
    const rows=JSON.parse(sessionStorage.getItem("cothink.creations")||"[]");
    return new Map(rows.filter(([key,row])=>typeof key==="string"&&typeof row?.sessionId==="string"));
  }catch{return new Map();}
}

export function readingFactSaved(view, field, wanted) {
  if (!view) return false;
  if (field === "opened") return !!view.lastOpenedAt && view.lastOpenedAt !== wanted;
  if (field === "anchor") return JSON.stringify(wanted) === JSON.stringify(view.anchor);
  return view.seenResults[wanted.taskId] === wanted.resultRevision;
}

export function mergeReadingView(views, value, confirmed = []) {
  const id = value.sessionId ?? value.id;
  const known = views.get(id);
  if (Number.isSafeInteger(value.viewRevision) && (!known || value.viewRevision >= known.viewRevision)) {
    const failures = known?.failures ?? new Map();
    for (const [key, {field,wanted}] of failures)
      if (confirmed.includes(key) || (!value.viewError && readingFactSaved(value.view,field,wanted))) failures.delete(key);
    views.set(id, {viewRevision:value.viewRevision, view:value.view, viewError:value.viewError, failures});
  }
  return known && Number.isSafeInteger(value.viewRevision) && value.viewRevision < known.viewRevision
    ? {...value,viewRevision:known.viewRevision,view:known.view} : value;
}
