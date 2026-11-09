export const modelName = (model) =>
  model ? `${model.provider} / ${model.modelId}` : "来源未记录";
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
// Local unsent text must survive background snapshots and a late submit response.
export function createDraftBook() {
  const drafts = new Map();
  const empty = () => ({text:"",workRequest:null,selectionId:null,editId:null});
  return {
    load(id, editor, draftRevision = null, branchAnchor = null) {
      if (!drafts.has(id)) drafts.set(id,{sessionId:id,...empty(),
        ...(typeof editor === "string" ? {text:editor} : editor),revision:0,
        expectedDraftRevision:draftRevision,branchAnchor,savedEditId:typeof editor === "object" ? editor?.editId ?? null : null});
      return drafts.get(id).text;
    },
    edit(id, change) {
      const prior=drafts.get(id) ?? {sessionId:id,...empty(),revision:0,expectedDraftRevision:null,branchAnchor:null};
      drafts.set(id,{...prior,...(typeof change === "string" ? {text:change} : change),
        editId:crypto.randomUUID(),revision:prior.revision+1});
    },
    snapshot(id) { return structuredClone(drafts.get(id) ?? {}); },
    pending() { return structuredClone([...drafts.values()].filter(draft=>draft.editId && draft.editId !== draft.savedEditId)); },
    confirmed(sent, saved) {
      const now=drafts.get(sent.sessionId);
      if (!now || saved.editor?.editId !== sent.editId) return false;
      drafts.set(sent.sessionId,{...now,expectedDraftRevision:saved.draftRevision,branchAnchor:saved.branchAnchor,savedEditId:sent.editId});
      return true;
    },
    rebase(id,saved) {
      const now=drafts.get(id);
      if (now) drafts.set(id,{...now,expectedDraftRevision:saved.draftRevision,branchAnchor:saved.branchAnchor});
    },
    restore(id,saved) {
      drafts.delete(id); return this.load(id,saved.editor ?? saved.draft,saved.draftRevision,saved.branchAnchor);
    },
    accepted(sent) {
      const now=drafts.get(sent.sessionId);
      if (!now) return;
      const same = now.editId === sent.editId && (sent.editId !== null || now.revision === sent.revision);
      const consume = sent.selectionId && now.selectionId === sent.selectionId;
      const consumeOptions=sent.turnOptions?.id&&now.turnOptions?.id===sent.turnOptions.id;
      if (same || consume || consumeOptions) drafts.set(sent.sessionId,{...now,...(same ? {text:""} : {}),
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
