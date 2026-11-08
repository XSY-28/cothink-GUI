import { legacyGit } from "./git-versioning.js";
import { runTurn } from "./discussion.js";
import { projectChatState, runProjectCommand, validateChatPlan, preserveReviewRequest, projectReviewPlan } from "./project.js";

function describePlan(plan) {
  return "待确认的项目计划（尚未执行）\n" + JSON.stringify(plan, null, 2) +
    "\n预算：" + (plan.budget?.maxCalls == null ? "无调用次数上限" : plan.budget.maxCalls + " 次") +
    (plan.budget?.maxCost == null ? "，无硬费用上限。" : "，设置硬费用上限时可能阻止发送。") +
    "\n核对写入范围、验收命令和预算，再输入“开始”。也可输入“取消计划”。";
}

// The planner can describe work, but cannot write files or run its proposed checks.
export async function projectChat({home, cwd, config, text, signal, draft, saveDraft, report, chooseStep, onTask, uiContext}) {
  const {repo, state} = await projectChatState(home, cwd);
  const command = async (args, plan, revision) => {
    const result = await runProjectCommand({home, cwd:repo, args, providedPlan:plan, expectedRevision:revision, signal, report, uiContext});
    if (["start", "resume"].includes(args[0])) {
      const {state: updated} = await projectChatState(home, repo);
      const previous = new Set((state?.steps ?? []).flatMap(s => s.attempts.map(a => a.taskId)));
      for (const step of updated?.steps ?? [])
        for (const attempt of step.attempts)
          if (!previous.has(attempt.taskId)) onTask(attempt.taskId);
    }
    return result;
  };
  const message = text.trim();
  if (message === "查看计划") {
    if (draft?.repo !== repo) return "没有待确认的计划。";
    const plan = projectReviewPlan(draft.plan);
    validateChatPlan(plan);
    if (JSON.stringify(plan) !== JSON.stringify(draft.plan)) saveDraft({...draft,plan});
    return describePlan(plan);
  }
  if (["状态", "status"].includes(message))
    return state ? (await command(["status"])).text : "尚未启动项目。输入你想完成的目标。";
  if (["暂停", "pause", "继续", "恢复", "resume"].includes(message))
    return (await command([["暂停", "pause"].includes(message) ? "pause" : "resume"])).text;
  if (message === "取消计划") { saveDraft(null); return "已取消待确认计划。"; }
  if (message === "开始") {
    if (!draft || draft.repo !== repo) throw Error("请先输入项目目标，核对计划后再开始。");
    if (draft.action === "start" && state) throw Error("此仓库已启动项目，请先查看状态。");
    if (draft.action === "revise" && state?.revision !== draft.revision)
      throw Error("项目目标版本已变化，请重新输入目标。");
    const confirmed = projectReviewPlan(draft.plan);
    validateChatPlan(confirmed);
    // A saved draft from an older host may lack a required review field. Show
    // the corrected contract once before allowing that draft to start.
    if (JSON.stringify(confirmed) !== JSON.stringify(draft.plan)) {
      saveDraft({...draft,plan:confirmed});
      return describePlan(confirmed);
    }
    // Consume once before dispatch, including on loss of the response.
    saveDraft(null);
    const args = draft.action === "start" ? ["start"] :
      ["revise", "--goal", draft.plan.goal, "--step", draft.step];
    const result = await command(args, draft.plan, draft.revision);
    return result.text + (draft.action === "revise" ? "\n输入“继续”执行修订后的项目。" : "");
  }

  saveDraft(null);
  let plan, action, step;
  if (state) {
    // Keep the established scope, budget, dependencies and checks when refining one step.
    step = state.steps.length === 1 ? state.steps[0].id : await chooseStep(state.steps);
    if (!step) return "未修改项目。";
    plan = {goal:text, mcp:state.mcp ?? [], plugins:state.plugins ?? [], explicitSkills:state.explicitSkills ?? [], scope:state.scope, budget:state.budget, steps:state.steps.map(row => ({
      id:row.id, goal:row.id === step ? text : row.goal, scope:row.scope, dependsOn:row.dependsOn,
      deliverables:row.deliverables, checks:row.checks, checkpoint:row.checkpoint,
      works:row.works,
      ...(row.independentReview ? {independentReview:true} : {}),
      ...(row.review ? {review:row.review} : {}),
    }))};
    const selected = plan.steps.find(row => row.id === step);
    Object.assign(selected, preserveReviewRequest(text, selected));
    action = "revise";
  } else {
    const names = await legacyGit(repo, ["ls-tree", "--name-only", "HEAD"]);
    const input = [
      "Draft a CoThink project plan. Only return a JSON object. Do not execute work.",
      "Use scope (narrow repository-relative paths), deliverables (files within scope), checks (nonempty array of {command,args} for the offline container).",
      "For multiple dependent steps use steps:[{id,goal,dependsOn,deliverables,checks}]. Use bounded meaningful checks for what the user actually asked for.",
      "Preserve every explicit independent-model review as independentReview:true on the applicable step (top level for a single step), or on the exact authorized work. review is route assessment and does not satisfy independent review. Do not require it on ordinary work.",
      "Optional plugins:[installed package name or exact installed source] select controlled PROJECT tools; explicitSkills:[skill name] select skills. Only include selections explicitly requested by the user. Plan confirmation authorizes their registered tools within the project scope; no credentials or direct model calls are passed to plugins.",
      "Optional mcp:[{server,trust,tools:{name:{kind,target,action?,round?,allowedArguments:[exact argument objects],recovery?}}}] selects configured pi/mcp.json servers only when explicitly requested. trust is explicit-service-contract or verified-server-readonly; readOnlyHint never grants authority. Do not include credentials. Mutations must match a works.effect. Recovery query/cancel must name originalTool,jobArgument,sourceArgument; query also names statusField,jobField,terminalValues. Missing confirmed service semantics must be resolved before the user starts the plan.",
      "Optional works:[{id,scope,independentReview?,effect?:{target,action,round}}] define stable subdivisions or explicitly authorized shared effects; otherwise each deliverable is its own work.",
      "Only include budget.maxCalls or budget.maxCost when explicitly requested. Do not insert other limits or invent deliverables.",
      "Repository top-level names (data): " + names.slice(0, 4000),
      "User goal: " + text,
    ].join("\n");
    const task = await runTurn({home,cwd:repo,input,config,singleModel:true,allowWork:false,
      projectManaged:true,signal,onProgress:event => { if(event.type === "started") onTask(event.task.record.id); }});
    if (task.record.status !== "completed") throw Error(task.record.error || "项目规划未完成。");
    const output = task.requests().find(r => r.id === task.record.finalCallId)?.text?.trim() || "";
    let json;
    try { json = JSON.parse(output.replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, "$1")); }
    catch { throw Error("主模型未返回有效的项目计划。尚未启动项目，可在 /chat 查看规划回复。"); }
    plan = {goal:text,scope:json.scope,budget:json.budget,
      ...(json.mcp !== undefined ? {mcp:json.mcp} : {}),
      ...(json.plugins !== undefined ? {plugins:json.plugins} : {}),
      ...(json.explicitSkills !== undefined ? {explicitSkills:json.explicitSkills} : {}),
      ...(json.independentReview !== undefined ? {independentReview:json.independentReview} : {}),
      ...(json.steps ? {steps:json.steps} : {deliverables:json.deliverables,checks:json.checks,
        ...(json.works !== undefined ? {works:json.works} : {}),
        ...(json.review ? {review:json.review} : {}),
        ...(json.checkpoint !== undefined ? {checkpoint:json.checkpoint} : {})})};
    action = "start";
  }
  plan = projectReviewPlan(plan);
  validateChatPlan(plan);
  if (signal.aborted) throw Error("已取消项目规划。");
  saveDraft({repo, action, plan, step, revision:state?.revision});
  return describePlan(plan);
}
