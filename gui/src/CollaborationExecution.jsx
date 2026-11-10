import React from "react";
import { Markdown } from "./Markdown.js";
import { modelName, statusLabel, phaseLabel } from "./view.js";

export function Participant({ p, onSelect }) {
  const candidate=p.role.startsWith("candidate-");
  return (
    <button type="button" className="participant" onClick={onSelect}>
      <span
        className={`participant-mark ${p.status === "running" ? "live" : ""}`}
      >
        {p.role === "main" ? "主" : p.role === "member" ? "工" : candidate ? "候" : "评"}
      </span>
      <span>
        <strong>
          {p.role === "main"
            ? "主答"
            : p.role === "member"
              ? "成员 " + p.id
              : candidate ? "候选副模型 " + p.role.replace("candidate-", "") : "评审 " + p.role.replace("reviewer-", "")}
        </strong>
        <small>{modelName(p.model)}</small>
      </span>
      <em>{statusLabel(p.status)}</em>
    </button>
  );
}
const positionNames = {
  manager: "主模型经理", supervisor: "负责人", employee: "员工", review: "成果复核",
  "independent-review": "独立审查", "process-check": "过程检查员",
};
const processStatus = status => ({
  registered:"已登记", settled:"已结清", stopped:"已停止", pausing:"正在结清", paused:"已暂停", unverified:"来源未核验",
}[status] ?? statusLabel(status));
const requestPhase = phase => ({
  draft:"主模型回复","manager-final":"经理终稿","process-check":"过程检查","visual-review":"视觉复核",
  "readonly-worker":"只读执行","readonly-feedback":"只读返工",
}[phase] ?? phaseLabel(phase));
const scopeText = paths => paths.length ? paths.join("、") : "无";
const tokenText = usage => usage ? `输入 ${usage.input ?? "未知"} · 输出 ${usage.output ?? "未知"} tokens` : "用量未知";
const positionId = person => person.staffId ?? person.workId;

export function ActualExecution({task,checkShown = false}) {
  const participants = task.participants.filter(participant => !checkShown || participant.position !== "process-check");
  const callsByRole = Map.groupBy(task.messages, message => message.role);
  const staffById = new Map(participants.map(person => [person.id,positionId(person) ?? person.id]));
  return <>
    {task.scope && <div className="field-note">
      {task.scope.assignment && <p>{task.scope.assignment}</p>}
      {task.scope.read && <p>任务读取范围：{scopeText(task.scope.read)}</p>}
      {task.scope.write && <p>任务写入范围：{scopeText(task.scope.write)}</p>}
      {task.scope.inputVersion && <p>输入版本 <code>{task.scope.inputVersion}</code></p>}
    </div>}
    {participants.length > 0 && <section aria-label="实际岗位与请求">
      <h3>实际岗位与请求</h3>
      {participants.map(person => {
        const calls = callsByRole.get(person.requestRole) ?? [];
        const label = positionNames[person.position] ?? (person.role.startsWith("helper:") ? "助手" : person.role);
        return <details key={person.id} className="work-detail">
          <summary>{label}{positionId(person) ? ` · ${positionId(person)}` : ""}{person.readOnly ? " · 只读" : ""} · {processStatus(person.status)}</summary>
          {person.assignment && <p>{person.assignment}</p>}
          {person.reason && <p>选人理由：{person.reason}</p>}
          {person.supervisorId && <p>直属负责人：{person.supervisorId === "main" ? "主模型" : staffById.get(person.supervisorId) ?? person.supervisorId}</p>}
          {person.reviewVersion && <p>审查版本 <code>{person.reviewVersion}</code></p>}
          {person.readScope && <p>读取范围：{scopeText(person.readScope)}</p>}
          {person.scope && <p>写入范围：{scopeText(person.scope)}</p>}
          {person.inputVersion && <p>读取版本 <code>{person.inputVersion}</code></p>}
          {person.sourceCount != null && <p>已选材料 · 对话来源 {person.sourceCount} 个 · 附件 {person.attachmentCount ?? 0} 个</p>}
          {person.selectedModel && <p>所选模型：{modelName(person.selectedModel)}</p>}
          {person.collected && <p>经理已收集报告{person.treatment && ` · ${person.treatment.decision === "adopt" ? "已采纳" : "已弃用"} · ${person.treatment.reason}`}</p>}
          {person.error && <p className="error-text">{person.error}</p>}
          {person.pause && <p>岗位暂停 · {person.pause.status === "unknown" ? "停止未确认" : processStatus(person.pause.status)}
            {person.pause.reason && ` · ${person.pause.reason}`}
            {!!person.pause.unresolvedRequestIds?.length && ` · 待核对 ${person.pause.unresolvedRequestIds.join("、")}`}</p>}
          {!calls.length && <p>尚无该岗位的请求记录。</p>}
          {calls.map(call => <details key={call.id}>
            <summary>{requestPhase(call.phase)} · {processStatus(call.status)} · {call.actualModel ? modelName(call.actualModel) : call.sent ? "实际模型未记录" : "尚未发送"}</summary>
            <p className="source-ref">请求 {call.id}{call.sessionId && ` · 会话 ${call.sessionId}`}</p>
            <p>{tokenText(call.usage)}{call.maxOutputTokens != null && ` · 输出上限 ${call.maxOutputTokens} tokens`}</p>
            {call.error && <p className="error-text">{call.error}</p>}
            {call.text && <div className="prose"><Markdown text={call.text}/></div>}
          </details>)}
        </details>;
      })}
    </section>}
    {!!task.skillReads?.length && <details>
      <summary>已读取技能 · {task.skillReads.length} 条</summary>
      {task.skillReads.map((skill, i) => <p key={`${skill.stageId}:${i}`}>
        {skill.name} · {skill.path} · {staffById.get(skill.role.replace(/^member:/, "")) ?? skill.role} · <code>{skill.hash}</code>
      </p>)}
    </details>}
    {task.work && <MemberConflicts members={task.work.members}/>}
    {!!task.work?.activities?.length && <WorkActivities activities={task.work.activities}/>}
  </>;
}

export function ProcessChecks({task}) {
  const check = task.processCheck;
  if (!check) return null;
  const participants = new Map([task,...(task.executionTasks ?? [])].flatMap(source =>
    (source.participants ?? []).map(person => [`${source.id}:${person.id}`,positionId(person) ?? person.id])));
  const name = (taskId, memberId) => memberId === "main" ? "主模型" : participants.get(`${taskId}:${memberId}`) ?? memberId;
  return <details className="work-detail" open={!!check.gap}>
    <summary>过程检查 · {check.observations.length} 次观察 · {processStatus(check.status)}</summary>
    {check.interval != null && <p>检查周期 {check.interval / 1000} 秒{check.selectedModel && ` · 所选模型 ${modelName(check.selectedModel)}`}</p>}
    {check.gap && <p className="error-text">{check.gap.message ?? check.gap.code}</p>}
    {check.observations.map(observation => <details key={observation.id}>
      <summary>{({first:"首检",periodic:"定期检查",closing:"收尾检查"}[observation.kind] ?? "检查")} {observation.sequence}
        {" · "}{processStatus(observation.status)} · 覆盖 {observation.members.filter(member => member.covered).length} / {observation.members.length}</summary>
      <p>{observation.observedAt && `观察于 ${new Date(observation.observedAt).toLocaleString()} · `}
        {observation.delayMs != null && `延迟 ${observation.delayMs / 1000} 秒 · `}
        {!!observation.missedIntervals && `跳过 ${observation.missedIntervals} 个间隔 · `}{tokenText(observation.usage)}</p>
      {observation.requestId && <p className="source-ref">请求 {observation.requestId} · {modelName(observation.actualModel)}</p>}
      {observation.error && <p className="error-text">{observation.error}</p>}
      {observation.members.map(member => <p key={`${member.taskId}:${member.memberId}:${member.attempt}`}>
        {name(member.taskId,member.memberId)} · {statusLabel(member.status)} · {member.covered ? "已覆盖" : "未覆盖"}
        {!!member.blockers && ` · ${member.blockers} 个阻塞`}
      </p>)}
      {observation.reports.map(report => <p key={report.id}>
        {name(report.taskId,report.memberId)} · {({direction:"方向",progress:"进度",blocker:"阻塞"}[report.kind] ?? report.kind)} · {report.reason}
        {" · "}{({forwarded:"已送直属负责人",pending:"待送直属负责人",stale:"已过时"}[report.status] ?? processStatus(report.status))}
        {report.leaderId && ` ${name(report.taskId,report.leaderId)}`}
        {report.forwardedAt && ` · ${new Date(report.forwardedAt).toLocaleString()}`}
        {!!report.evidenceIds?.length && <small className="source-ref"> · 证据 {report.evidenceIds.join("、")}</small>}
      </p>)}
    </details>)}
    {!!check.unexecuted?.length && <p>未执行岗位：{check.unexecuted.map(member => name(member.taskId,member.memberId)).join("、")}</p>}
  </details>;
}
export function MemberConflicts({members}) {
  return members?.filter(m=>m.taskConflict).map(m=><section key={m.id} className="work-detail">
    <h3>成员题意冲突 · {m.taskConflict.unresolved?'尚未解决':'成员已确认更正'}</h3>
    <p>{modelName(m.model)}</p><Markdown text={m.taskConflict.message}/>
    {m.feedback?.map((text,i)=><details key={i}><summary>主模型具体反馈 {i+1}</summary><Markdown text={text}/></details>)}
    {m.taskConflict.resolution&&<Markdown text={m.taskConflict.resolution}/>}
    <small>确认表示冲突处理步骤完成，不证明理解必然正确。</small>
  </section>);
}
export function WorkActivities({activities,legacy=false}) {
  return <details className="activities">
    <summary>执行记录 · {activities.length} 条</summary>
    {activities.map((activity,i) => <section key={i}>
      <div className="small-label">{activity.type === "handoff" ? "已保存交接" : "活动记录"}
        {" · "}{activity.action} · {processStatus(activity.status)}</div>
      {activity.memberId && <p>关联成员 {activity.memberId}</p>}
      {activity.text && <div className="prose"><Markdown text={activity.text}/></div>}
      {legacy && <pre>{JSON.stringify(activity,null,2)}</pre>}
    </section>)}
  </details>;
}
