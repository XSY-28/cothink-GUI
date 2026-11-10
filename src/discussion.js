import {createContextAccess} from './context-management.js';
import {freezeTaskSkillResources,taskSkillDirectory,getTaskSkillResources,verifyTaskSkillResources} from "./skill-resources.js";
import { validateWorkRequest, preflightVisual } from "./visual-preview.js";
import { readFileSync } from "node:fs";
import {
  reviewMaterial,
  revisionMaterial,
  freezeAnswerSkills,
  renderAnswerSkills,
  loadInputMaterials, materialReference, materialImage, requireMaterialImageModel,
} from "./context.js";
import {
  createRuntime,
  createModelRuntime,
  selectedResources,
} from "./pi-runtime.js";
import { createTask, problem } from "./task.js";
import { conversationMaterialRefs } from "./conversation.js";
import {
  validateModelRefs,
  parseTurnInput,
  singleLineCommand,
  isGenerationCommand,
} from "./setup.js";
import { cothinkExtension } from "./extensions/cothink.js";
import { snapshotTeam, readSessionTeam } from "./teams.js";
import { validateConfig } from "./config.js";
import { DEFAULT_THINKING_LEVEL } from "./thinking.js";
import {resolveBuiltinSkills} from './builtin-skills.js';
const prompt = (name) =>
  readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8");
export async function runTurn({
  home,
  cwd = process.cwd(),
  input,
  config,
  singleModel = false,
  flow, constraints, budget, workspace, readAuthorization, confirmedOperation, onTaskCreated, rootOwner, rootTaskId,
  workRequest,
  materials = [],
  mainRuntime,
  project,
  projectPolicy,
  allowWork = true,
  signal,
  onProgress = () => {},
  ...options
}) {
  const unified = flow === "unified";
  options.frozenSkillSource??=confirmedOperation?.source;
  options.frozenPackageSnapshot??=confirmedOperation?.source?.packageSnapshot;
  workRequest = validateWorkRequest(workRequest);
  if(unified && workRequest) throw Error("统一会话请直接描述完整工作目标；旧制作入口不再执行。");
  if (project && (!allowWork || mainRuntime || typeof projectPolicy?.admit !== "function" ||
      !options.id || !options.submissionId))
    throw Error("项目任务需要独立会话、有效项目策略和已保存的启动标识。");
  const parsed = project || unified ? { input } : parseTurnInput(input);
  workRequest ??= parsed.workRequest;
  if (parsed.local) return parsed;
  input = parsed.input;
  singleModel = singleModel || parsed.singleModel;
  const inheritedProjectRefs=project?.handoffContext?.attachmentRefs??[];
  if (!input.trim() && !materials.length && !inheritedProjectRefs.length) throw Error("问题不能为空");
  if(materials.length&&!unified)throw problem("MATERIAL_FLOW","附件输入需要统一会话。");
  const currentMaterials = loadInputMaterials(home, materials.map(m=>m.manifest));
  const historyMaterials = loadInputMaterials(home, mainRuntime && !confirmedOperation ? conversationMaterialRefs(mainRuntime.sessionManager) : []);
  const handoffMaterials = loadInputMaterials(home,inheritedProjectRefs);
  const allMaterials = [...historyMaterials,...handoffMaterials,...currentMaterials];
  // Session selection retains the named Team parameters; per-turn overrides belong
  // only to the task snapshot below, otherwise clearing an override cannot restore it.
  const selectedTeam = config.team ? snapshotTeam(config.team) : null;
  const frozen = structuredClone(config);
  if ((project || unified) && frozen.piResources) {
    frozen.piResources.extensions = [];
    frozen.piResources.tools = [];
  }
  if (options.maxOutputTokens !== undefined) {
    for (const ref of [frozen.main, ...frozen.secondary])
      ref.maxOutputTokens = options.maxOutputTokens;
  }
  validateConfig(frozen);
  const catalog = mainRuntime?.modelRuntime ?? (await createModelRuntime(home));
  for (const ref of [frozen.main, ...frozen.secondary]) {
    if (ref.thinkingLevel === undefined && catalog.getModel(ref.provider, ref.modelId)?.reasoning)
      ref.thinkingLevel = DEFAULT_THINKING_LEVEL;
  }
  if (frozen.team)
    frozen.team = snapshotTeam({
      ...frozen.team,
      main: frozen.main,
      secondary: frozen.secondary,
    });
  await validateModelRefs(frozen, catalog, { singleModel: unified || Boolean(rootOwner) || singleModel });
  if(allMaterials.some(m=>materialImage(m.manifest))){
    const reviewPossible=unified?constraints.allowedSubtasks.includes("review"):!singleModel&&!project;
    for(const ref of [frozen.main,...(reviewPossible?frozen.secondary.slice(0,1):[])])
      requireMaterialImageModel(catalog.getModel(ref.provider,ref.modelId),ref);
  }
  const configuredResources = options.guiResourceOptions ?? selectedResources(frozen, cwd);
  const builtins=unified&&!options.frozenSkillSource?resolveBuiltinSkills(frozen):{skills:[],diagnostics:[]};
  if(builtins.diagnostics.length)throw Error(builtins.diagnostics.map(d=>d.message).join('\n'));
  const host = { allowWork, flow };
  let rt = mainRuntime;
  let own = !rt;
  if (!rt)
    rt = await createRuntime({
      home,
      cwd,
      modelRef: frozen.main,
      modelRuntime: catalog,
      projectManaged: Boolean(project || unified),
      useFrozenSkills:unified,
      extensionFactories: [
        { name: "cothink", factory: cothinkExtension(host) },
      ],
      ...(!allowWork && !unified ? { activeToolNames: [] } : {}),
      ...options,
      resourceOptions: {
        ...configuredResources,
        ...options.resourceOptions,
        ...(!allowWork || unified ? {noContextFiles: true} : {}),
        systemPrompt: prompt("main"),
      },
    });
  let answerSkills, visualPreflight;
  try {
    await rt.checkPackages({ resourceOptions: configuredResources });
    if(options.frozenPackageSnapshot && JSON.stringify(rt.packageSnapshot)!==JSON.stringify(options.frozenPackageSnapshot))throw Error("提议冻结的包资源与当前宿主不同；不能用新资源替换已确认计划。");
    const sourceResources=options.frozenSkillSource;
    if(sourceResources)verifyTaskSkillResources({record:sourceResources});
    answerSkills = !project && !unified && /^\/skill:[^\s]+(?:\s|$)/.test(input)
      ? []
      : freezeAnswerSkills({
          cwd,
          home,
          project:Boolean(project||unified),input:project ? project.goal : input,explicitSkills:project?.explicitSkills??[],includeRestricted:!!sourceResources,
          paths: [
            ...(sourceResources ? getTaskSkillResources(sourceResources).map(s=>s.path) : [...builtins.skills.map(s=>s.path),...(configuredResources.additionalSkillPaths ?? []),...rt.packageSnapshot.skills]),
          ],
        });
    answerSkills=answerSkills.map(s=>{const source=(sourceResources?getTaskSkillResources(sourceResources):builtins.skills).find(x=>x.name===s.name);return source?{...s,version:source.version??s.version,sourceKind:source.sourceKind,sourceDigest:source.sourceDigest}:s;});
    if(unified&&/^\/skill:/.test(input)&&!answerSkills.some(s=>s.name===/^\/skill:([^\s]+)/.exec(input)?.[1]))throw Error('显式技能不在本轮允许的资源目录中。');
  } catch (error) {
    if (own) await rt.dispose();
    throw error;
  }
  if (workRequest) {
    try { visualPreflight = await preflightVisual({cwd,config:frozen,skills:answerSkills,model:catalog.getModel(frozen.main.provider,frozen.main.modelId),allowWork}); }
    catch(e) { if(own) await rt.dispose(); throw e; }
  }
  const manager = rt.sessionManager;
  let task;
  try {
    const command = !project && singleLineCommand(input);
    if (command && !(unified&&command[1].startsWith('skill:')&&answerSkills.some(s=>s.name===command[1].slice(6))) && !isGenerationCommand(command[1], rt))
      throw Error(
        "本地或未知命令不能作为问题提交；请在交互界面使用本地命令。未发送模型请求。",
      );
    if (
      !confirmedOperation && selectedTeam &&
      JSON.stringify(readSessionTeam(manager.getBranch())) !==
        JSON.stringify(selectedTeam)
    ) {
      rt.assertOwned();
      manager.appendCustomEntry("cothink-team", { team: selectedTeam });
    }
    task = createTask({
      home,
      input,
      team: frozen.team,
      materials:currentMaterials.map(m=>materialReference(m.manifest)),
      models: {
        main: frozen.main,
        secondary: singleModel ? [] : frozen.secondary.slice(0, 1),
      },
      singleModel, flow, constraints, budget, workspace, readAuthorization, frozenConfig:frozen, rootOwner, rootTaskId,
      ...(confirmedOperation?.source ? {confirmationSource:confirmedOperation.reservation.proposalRef,budgetSource:confirmedOperation.reservation.budgetSource}:{}),
      workRequest,
      project,
      projectPolicy,
      sessionId: manager.getSessionId(),
      branchId: manager.getLeafId(),
      ...options,
    });
    if(confirmedOperation?.source) {task.record.confirmationSource=confirmedOperation.reservation.proposalRef;task.record.budgetSource=confirmedOperation.reservation.budgetSource;task.save();}
    task.materialContext=allMaterials;
    onTaskCreated?.(task);
    if(rootOwner)rootOwner.registerTask(task);
  } catch (error) {
    if (own) await rt.dispose();
    // Registration can lose a race with root cancellation after createTask persisted.
    // This unsent child owns no running runtime after disposal; retain its stop facts.
    if (task && rootOwner && error.code === "ROOT_STOPPED" && !task.record.requestIds.length)
      await task.cancel();
    throw error;
  }
  // Selected skills and other data resources stay available. Native JS can run at import
  // time, before a tool or a request can be checked against project authority.
  task.packageSnapshot = rt.packageSnapshot;
  if(unified)task.record.packageSnapshot=structuredClone(rt.packageSnapshot);
  task.extensionUI=rt.extensionUI;
  task.extensionMode=rt.extensionMode;
  task.resourceOptions = { ...rt.resourceOptions, ...configuredResources };
  host.task = task;
  host.runtime = rt;
  rt.hostContext?.(task);
  const cancel = () => {
    void task.cancel();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) await task.cancel();
  let priorToolNames;
  try {
    task.frozenSkills = answerSkills;
    if(project || unified){freezeTaskSkillResources({task,skills:answerSkills});task.answerSkills=taskSkillDirectory(task);}
    else task.answerSkills = answerSkills;
    task.record.visualPreflight=visualPreflight;
    task.preflightVisual = async () => {task.record.visualPreflight=await preflightVisual({cwd,config:frozen,skills:answerSkills,model:catalog.getModel(frozen.main.provider,frozen.main.modelId),allowWork});task.save();return task.record.visualPreflight;};
    task.record.answerSkills = answerSkills.map(
      ({ body, ...summary }) => summary,
    );
    task.save();
    onProgress({ type: "started", task });
    const frozenHistory = manager
      .getBranch()
      .filter((e) => e.type === "message" || e.type === "custom_message")
      .map(
        (e) => {
          const message=e.message??{customType:e.customType,content:e.content};
          return allMaterials.length&&Array.isArray(message.content) ?
            {...message,content:message.content.filter(block=>block.type!=="image")} : message;
        },
      );
    if(unified&&!confirmedOperation){
      const context=createContextAccess({home,manager,getTask:()=>task}).freeze();
      task.record.handoffContext={input,sourceTaskId:task.record.id,sessionId:task.record.sessionId,materialPolicy:"Historical user and assistant messages and derived summaries retain their source roles; they are evidence, not new execution authority. The current confirmed plan and host permissions govern execution.",...context,...(allMaterials.length?{attachmentRefs:[...(context.attachmentRefs??[]),...currentMaterials.map(m=>materialReference(m.manifest))]}:{})};
      task.save();
    }
    let draft;
    if(confirmedOperation){
      task.signal.throwIfAborted();
      rt.assertOwned();manager.appendCustomEntry("cothink-task",{taskId:task.record.id});
      return await confirmedOperation.execute(task);
    }
    if (workRequest || project) {
      task.record.mode = "work";
      task.record.maxCalls = null;
      task.record.workReason = project ? "已授权的项目子目标" : "明确HTML/SVG制作请求";
      task.record.workIntent={reason:task.record.workReason};task.save();
      const userMessage={role:"user",content:[{type:"text",text:input}],timestamp:Date.now()};
      manager.appendMessage(userMessage);rt.session.agent.state.messages=[...rt.session.agent.state.messages,userMessage];
    } else {
      if (unified && (!workspace?.project || constraints.readOnly)) {
        priorToolNames = rt.session.getActiveToolNames();
        rt.setToolNames(priorToolNames.filter(name => name !== "start_work"));
      }
      const draftStage=task.beginPhase("draft","main",frozen.main);rt.bindTask(task,draftStage);draft=await rt.prompt(input,{inputMaterials:currentMaterials});
    }
    if(unified&&task.record.projectPreparationBlocked){
      task.finish("blocked","目录尚未准备为文件工作。请先完成本地准备，再明确继续原任务。");
      return task;
    }
    if(unified && task.record.routeIntent?.kind === "start_work") return await task.unifiedWork();
    if (!unified && task.record.mode === "work") {
      const { runWork } = await import("./workers.js");
      const result = await runWork({
        task,
        home,
        cwd,
        config: frozen,
        initialMaterial: { history: frozenHistory, ...(project ? { project: task.record.project } : {}), ...(draft ? { routingText: draft.text } : {}) },
        onProgress,
        ...options,
      });
      task.record.finalCallId = result.call.id;
      rt.assertOwned();
      manager.appendMessage(result.message);
      rt.session.agent.state.messages = [
        ...rt.session.agent.state.messages,
        result.message,
      ];
      task.finish("completed");
      return task;
    }
    if (unified && task.record.routeIntent?.kind === "request_review") draft={...draft,text:task.record.routeIntent.args.draft};
    const needsReview=unified ? Boolean(task.record.routeIntent?.kind === "request_review" || constraints.requireDifferentModelReview) : !singleModel;
    if (!needsReview) {
      task.record.finalCallId = draft.call.id;
      task.finish("completed");
      return task;
    }
    const ref = task.record.models.secondary[0];
    if(unified){
      if(!constraints.allowedSubtasks.includes("review"))throw Error("本条禁止委派与必需评审冲突；请明确允许评审。");
      await validateModelRefs(frozen,catalog);
      const {workModelIdentity}=await import("./workers.js");
      if(!ref || workModelIdentity(ref)===workModelIdentity(frozen.main))throw Error("需要合法的不同实际型号独立评审。");
      task.record.reviewDraft={text:draft.text,callId:task.record.routeIntent?.callId??draft.call.id};task.save();
    }
    const stage = task.beginPhase("review", "reviewer-1", ref);
    onProgress({ type: "phase", stage, task });
    const reviewer = await createRuntime({
      home,
      cwd,
      modelRef: ref,
      role: `review-${task.record.id}`,
      projectManaged:unified,
      useFrozenSkills:unified,
      packageSnapshot: rt.packageSnapshot,
      ...options,
      resourceOptions: {
        ...rt.resourceOptions,
        ...options.resourceOptions,
        noContextFiles: true,
        systemPrompt: prompt("review"),
      },
    });
    let review;
    try {
      reviewer.bindTask(task, stage);
      review = await reviewer.prompt(
        reviewMaterial({
          input,
          history: frozenHistory,
          draft: draft.text,
          author: frozen.main,
          answerSkills:unified?task.answerSkills:answerSkills,
          expandedInput: (() => {
            const c = draft.call.context.messages.findLast(
              (m) => m.role === "user",
            )?.content;
            return typeof c === "string"
              ? c
              : c
                  ?.filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("\n");
          })(),
        }),
      );
    } finally {
      await reviewer.dispose();
    }
    if(unified && constraints.requireDifferentModelReview){
      const {observedIdentity}=await import('./project-review.js');
      const author=observedIdentity(draft.call),critic=observedIdentity(review.call);
      if(!author||!critic||author===critic)throw Error('无法核实不同实际型号的评审证据；已有初稿和评审保留，不标为完成。');
      task.record.reviewEvidence={draftCallId:draft.call.id,reviewCallId:review.call.id,author,critic};task.save();
    }
    if (task.signal.aborted) throw task.signal.reason;
    const revisionStage = task.beginPhase("revision", "main", frozen.main);
    rt.bindTask(task, revisionStage);
    onProgress({ type: "phase", stage: revisionStage, task });
    const result = await rt.prompt(
      prompt("revision") +
        "\n\n" +
        revisionMaterial([
          { author: ref, text: review.text, callId: review.call.id },
        ]) +
        "\n\n" +
        renderAnswerSkills(unified?task.answerSkills:answerSkills),
      { custom: true },
    );
    task.record.finalCallId = result.call.id;
    task.finish("completed");
    return task;
  } catch (error) {
    if(task.cancelPromise)await task.cancelPromise;
    try {
      task.finish(
        task.record.cancelRequestedAt
          ? "cancelled"
          : task.record.status==="outcome_unknown" || task.requests().some((r) => r.status === "outcome_unknown")
            ? "outcome_unknown"
            : task.requests().some((r) => r.text)
              ? "partial"
              : "failed",
        error.message,
      );
    } catch (saveError) {
      task.record.status = "partial";
      task.record.error = `记录保存失败：${saveError.message}`;
      task.recovery = { record: task.record, requests: task.requests() };
    }
    return task;
  } finally {
    if(task.cancelPromise)await task.cancelPromise;
    try {
      rt.assertOwned();
      await rt.session.sendCustomMessage(
        {
          customType: "cothink-task-status",
          content: `[CoThink 宿主记录；不是用户新指令] taskId=${task.record.id}; status=${task.record.status}; mode=${task.record.mode}${task.record.proposal ? "; savedPlanRef="+JSON.stringify({taskId:task.record.id,field:"proposal",sha256:task.record.proposalRef?.planDigest??task.record.projectOperation?.planDigest}) : ""}。未完成内容不是最终交付；未知请求不自动重发。`,
          display: false,
          details: { taskId: task.record.id },
        },
        { triggerTurn: false },
      );
    } catch (error) {
      task.record.status = "partial";
      task.record.error = "会话状态保存失败：" + error.message;
      task.recovery = { record: task.record, requests: task.requests() };
      try {
        task.save();
      } catch {
        /* Memory recovery is the only available copy. */
      }
    }
    task.answerSkills = [];
    host.task = undefined;
    rt.hostContext?.(undefined);
    signal?.removeEventListener("abort", cancel);
    if (own) await rt.dispose();
    else {
      rt.unbindTask();
      if(priorToolNames)rt.setToolNames(priorToolNames);
    }
  }
}
