import React, { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown.js";
import { modelName, statusLabel, phaseLabel, revisionExplanation, elapsedLabel } from "./view.js";
import { ActualExecution, MemberConflicts, Participant, ProcessChecks, WorkActivities } from "./CollaborationExecution.jsx";
import { Checks } from "./CollaborationEvidence.jsx";
export { VisualEvidence } from "./CollaborationEvidence.jsx";

export function Collaboration({
  task,
  expanded,
  tab,
  setTab,
  onExpand,
  onClose,
  commands,
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (task?.status !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task?.id, task?.status]);
  const [target, setTarget] = useState(null),
    pane = useRef(null);
  const participants = (task?.participants || []).filter(
    (p) => p.participated || p.role === "main" || (task?.work && p.role === "member"),
  );
  // A work member may use a model whose reviewer role was never called. Keep
  // the recorded role/author intact, but do not label that same model unused.
  const modelKey = (model) => model?.provider && model?.modelId
    ? JSON.stringify([model.provider, model.modelId]) : null;
  const usedWorkModels = new Set(task?.work ? [
    ...participants.map((p) => modelKey(p.model)),
    ...(task.messages || []).map((message) => modelKey(message.model)),
  ].filter(Boolean) : []);
  const rest = (task?.participants || []).filter(
    (p) => !participants.includes(p) && !usedWorkModels.has(modelKey(p.model)),
  );
  useEffect(() => {
    if (expanded && target) {
      const message = [...pane.current.querySelectorAll("[data-role]")].find(
        (node) => node.dataset.role === target,
      );
      message?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setTarget(null);
    }
  }, [expanded, target]);
  const select = (p) => {
    setTab("collaboration");
    onExpand();
    setTarget(p.role === "member" ? "member:" + p.id : p.role);
  };
  return (
    <aside
      className={`collaboration ${expanded ? "expanded" : ""}`}
      aria-label="本轮协作"
      ref={pane}
    >
      <header className="panel-heading">
        <div>
          <h2>执行记录</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="收起本轮协作"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {!task ? (
        <div className="collaboration-empty">
          <p role="status">正在读取所选回复的执行记录…</p>
        </div>
      ) : (
        <>
          <div className="turn-timing">
            {typeof task.usage?.calls === "number"
              ? task.usage.helpers
                ? `阵容模型已发 ${task.usage.calls} 次；插件助手 ${task.usage.helpers.reportedTurns ?? "未知"} 轮（单独记账）`
                : `已发 ${task.usage.calls} 次调用`
              : "调用次数尚未汇总"}{" "}
            {task.usage?.nativeTools&&`；原生工具 ${task.usage.nativeTools.count} 次（扩展用量独立，未知不计为零）`}
            · {elapsedLabel(task, now)}
          </div>
          {task.actualRoles && task.budget && <p className="field-note">{task.projectOperation ? "执行" : "本轮"}请求上限 {task.budget.maxCalls ?? "不限"}{task.budget.maxCost != null && ` · 费用上限 ${task.budget.maxCost}`}</p>}
          {task.projectOperation && task.proposal?.plan?.budget?.maxCalls != null && <p className="field-note">项目累计请求上限 {task.proposal.plan.budget.maxCalls} · 按项目原记录累计，本轮上限同时适用。</p>}
          {task.correctionPolicy && <details><summary>请求与纠错政策</summary><p>{task.correctionPolicy}</p></details>}
          {task.executionError&&<p role="alert" className="error-text">{task.executionError}</p>}
          {!!task.activities?.length&&<details><summary>本轮工具与拒绝记录</summary>{task.activities.map(activity=><section key={activity.toolCallId}><strong>{activity.action} · {statusLabel(activity.status)}</strong><Markdown text={activity.text??''}/></section>)}</details>}
          {task.workPlanError&&!task.activities?.some(activity=>activity.toolCallId===task.workPlanError.toolCallId)&&<p className="error-text">文件计划未获准：{task.workPlanError.message}</p>}
          <ProcessChecks task={task} now={now}/>
          {task.actualRoles && <ActualExecution task={task} now={now} checkShown={!!task.processCheck}/>}
          {task.executionTasks?.map(source=><details key={source.id}><summary>{source.stepId} · {source.relation==='inherited'?'沿用已有交付':'本轮实际执行'} · {statusLabel(source.status)}</summary>
            <p>来源任务 {source.id} · 已发 {source.usage?.calls??'未知'} 次请求</p>
            {source.error&&<p className="error-text">{source.error}</p>}
            {source.actualRoles ? <ActualExecution task={source} now={now} checkShown={!!task.processCheck}/> :
              source.messages.map(message=><div key={message.id}><p>{message.role} · {modelName(message.model)}</p><Markdown text={message.text??''}/></div>)}
            {source.work&&<Checks work={source.work} taskId={source.id} commands={commands}/>}</details>)}
          {task.workRequest && <details className="field-note"><summary>制作HTML/SVG · 本条冻结技能</summary>{task.answerSkills?.map(s=><p key={s.hash}>{s.name}<br/><code>{s.hash}</code></p>)}</details>}
          {task.actualRoles ? <details className="roster">
            <summary>本轮冻结阵容</summary>
            {(task.rosterCandidates ?? []).map((model,i) => <p key={i}>{i === 0 ? "主模型" : "候选副模型"} · {modelName(model)}</p>)}
          </details> : <details className="roster"><summary>参与者与冻结阵容</summary>
            <div className="roster-title">
              <strong>{task.team?.name || "当时未记录阵容"}</strong>
              <span>{task.mode === "one" ? "ONE" : "CoThink"}</span>
            </div>
            <p className="field-note">所选任务的冻结阵容</p>
            {participants.map((p) => (
              <Participant p={p} key={p.id} onSelect={() => select(p)} />
            ))}
            {rest.length > 0 && (
              <details>
                <summary>完整阵容 · {rest.length} 位本轮未参与</summary>
                {rest.map((p) => (
                  <div className="inactive-member" key={p.id}>
                    <strong>{modelName(p.model)}</strong>
                    <small>
                      {p.role.startsWith("candidate-")?"候选副模型 · ":""}本轮未参与 ·{" "}
                      {p.status === "not_called"
                        ? "尚未调用"
                        : statusLabel(p.status)}
                    </small>
                  </div>
                ))}
              </details>
            )}
          </details>}
          {!expanded ? (
            <div className="compact-actions">
              <p>
                <span
                  className={
                    task.status === "running" ? "status-dot live" : "status-dot"
                  }
                />
                {statusLabel(task.status)} · {phaseLabel(task.managerFlow&&task.phase==="draft"?"answer":task.phase)}
              </p>
              <button
                onClick={() => {
                  setTab("collaboration");
                  onExpand();
                }}
              >
                展开{task.work ? "协作" : "讨论"}{" "}
                <span aria-hidden="true">↗</span>
              </button>
              {task.work && (
                <button
                  onClick={() => {
                    setTab("changes");
                    onExpand();
                  }}
                >
                  查看变更与检查
                </button>
              )}
            </div>
          ) : (
            <>
              <nav className="detail-tabs" aria-label="任务详情">
                <button
                  aria-current={tab === "collaboration" ? "page" : undefined}
                  onClick={() => setTab("collaboration")}
                >
                  {task.work ? "协作" : "讨论"}
                </button>
                {task.work && (
                  <>
                    <button
                      aria-current={tab === "changes" ? "page" : undefined}
                      onClick={() => setTab("changes")}
                    >
                      变更
                    </button>
                    <button
                      aria-current={tab === "checks" ? "page" : undefined}
                      onClick={() => setTab("checks")}
                    >
                      检查
                    </button>
                  </>
                )}
              </nav>
              <div className="detail-scroll">
                {tab === "collaboration" && (
                  <>
                    {!task.actualRoles && <p className="detail-caption">以下均为已有调用原文。</p>}
                    {!task.actualRoles && <div className="discussion-thread">
                      {task.messages.map((message) => {
                        const explanation =
                          message.phase === "revision"
                            ? revisionExplanation(message.text)
                            : null;
                        return (
                          <article
                            className="message-card"
                            key={message.id}
                            data-role={message.role}
                          >
                            <header>
                              <span className="thread-node" />
                              <div>
                                <strong>{phaseLabel(task.managerFlow&&message.phase==="draft"?"answer":message.phase)}</strong>
                                <small>{modelName(message.model)}</small>
                              </div>
                              <span className="message-status">
                                {statusLabel(message.status)}
                              </span>
                            </header>
                            {message.phase === "draft" ? (
                              <details>
                                <summary>主答初稿 · 展开原文</summary>
                                <div className="prose">
                                  <Markdown text={message.text} />
                                </div>
                              </details>
                            ) : explanation !== null ? (
                              <>
                                <h4>对评审意见的处理说明</h4>
                                <div className="prose">
                                  <Markdown text={explanation} />
                                </div>
                                <details>
                                  <summary>完整修订原文</summary>
                                  <div className="prose">
                                    <Markdown text={message.text} />
                                  </div>
                                </details>
                              </>
                            ) : (
                              <div className="prose">
                                <Markdown
                                  text={message.text || "尚无已保存的正文。"}
                                />
                              </div>
                            )}
                            <small className="source-ref">
                              调用 {message.id}
                            </small>
                            <details className="raw-message">
                              <summary>查看纯文本原文</summary>
                              <pre tabIndex={0}>
                                {message.text || "（尚无正文）"}
                              </pre>
                            </details>
                          </article>
                        );
                      })}
                    </div>}
                    {!task.actualRoles && task.work && <>
                      <MemberConflicts members={task.work.members}/>
                      <WorkActivities activities={task.work.activities} legacy/>
                    </>}
                    {task.error && <p className="error-text">{task.error}</p>}
                    <details>
                      <summary>用量记录</summary>
                      <p className="field-note">
                        未知保持未知；目录费用估算不等于服务商账单。
                      </p>
                      <pre>
                        {JSON.stringify(task.usage ?? "尚未汇总", null, 2)}
                      </pre>
                    </details>
                  </>
                )}
                {tab === "checks" && task.work && (
                  <Checks
                    key={task.id}
                    work={task.work}
                    taskId={task.id}
                    commands={commands}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
