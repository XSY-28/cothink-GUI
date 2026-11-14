import { renderAnswerSkills } from "../context.js";
import { Type } from "typebox";
import {readFileSync} from "node:fs";
import {projectRoutingBudget} from "../pi-runtime.js";
import {workIntentActions} from "../project-file-proposal.js";

const mainPrompt=readFileSync(new URL("../../prompts/main.md",import.meta.url),"utf8");
export const mainSystemPrompt=({unified=false}={})=>unified?mainPrompt:mainPrompt+
  "\nFor actual execution, call start_work with scope and readScope when known. For actual HTML/SVG creation or modification, also pass deliverableKind=\"html-svg\". The host binds an independent agent-sync work copy.";

const workPlanExample={goal:"Create an offline SVG page",scope:["index.html"],deliverables:["index.html"],
  checks:[{command:"node",args:["-e","if (!require('node:fs').readFileSync('index.html','utf8').includes('<svg')) process.exit(1)"]}]};
const planShape="For a single step provide goal, scope (array of repository-relative path strings), deliverables (array of file paths inside scope), and checks (nonempty array of {command,args?,timeoutMs?} for the configured offline container). The host assigns step id main. For multiple steps use steps instead of top-level deliverables/checks. Each step requires id, goal, deliverables and checks, and may specify scope and dependsOn (step IDs). Specify dependsOn for every step, using [] for independent steps, when asking to allow independent work to overlap. Optional project readScope is an array of paths. To commit to a specific collaboration plan, optionally provide collaboration: {workers?:positive integer,parallel?:boolean,distinctModels?:boolean,stepIds?:string[]}. The default is one worker, or two when parallel or distinctModels is true. workers counts employees only; the manager is separate. distinctModels compares employee identities. stepIds requires coverage across those steps, not the worker count on each step. Omit collaboration when no additional hard staffing commitment is needed. A generic request to form a team can use the manager plus one useful employee. Add staff for implementation or review needs; do not invent two employees per stage or promise all-step coverage without need. Preserve explicit worker counts, parallelism and independent review requirements. The host separately preserves direct user collaboration requirements.";
export function readOnlyToolDefinitions(host) {
  const result=value=>({content:[{type:"text",text:JSON.stringify(value)}]});
  const invoke=method=>async(id,args)=>{
    host.runtime.assertOwned();
    return result(await host.task.readonlyLifecycle[method](id,args,host.actor));
  };
  return [{
    name:"delegate",label:"Delegate read-only work",
    description:"Assign a bounded read-only part to a frozen provider/model. Select exact attachment {id,sha256} pairs, evidence source IDs, read paths, and frozen skill names. Omitted lists are empty. Assign a supervisor only when a subpart needs delegated work. Use reviewOf only for the exact collected report.",
    parameters:Type.Object({workId:Type.String(),model:Type.String(),assignment:Type.String(),reason:Type.String(),
      attachments:Type.Optional(Type.Array(Type.Object({id:Type.String(),sha256:Type.String()}))),
      evidence:Type.Optional(Type.Array(Type.String())),readScope:Type.Optional(Type.Array(Type.String())),
      skills:Type.Optional(Type.Array(Type.String())),canDelegate:Type.Optional(Type.Boolean()),
      maxDepth:Type.Optional(Type.Union([Type.Literal(3),Type.Literal(4)])),
      reviewOf:Type.Optional(Type.Object({assignmentId:Type.String(),reportDigest:Type.String(),criteria:Type.String()}))}),
    execute:invoke("delegate"),
  },{
    name:"collect",label:"Collect read-only report",
    description:"Wait for a direct report and read the saved receipt. After seeing it, optionally record adopt or discard with a specific reason. Only explicitly adopted reports may inform a later file plan.",
    parameters:Type.Object({assignmentId:Type.String(),
      decision:Type.Optional(Type.Union([Type.Literal("adopt"),Type.Literal("discard")])),reason:Type.Optional(Type.String())}),
    execute:invoke("collect"),
  },{
    name:"feedback",label:"Correct a direct report",
    description:"After collecting and inspecting a direct report, send concrete corrective feedback in its original role session. The returned assignment is the corrected attempt.",
    parameters:Type.Object({assignmentId:Type.String(),feedback:Type.String()}),
    execute:invoke("feedback"),
  },{
    name:"pause_member",label:"Pause a direct report",
    description:"Immediately close a direct report and its unfinished descendants to new work. Inspect the saved receipt for original requests and settlement.",
    parameters:Type.Object({assignmentId:Type.String(),reason:Type.String()}),
    execute:invoke("pause"),
  }];
}

/** Answer routing is part of the first ordinary model request. */
export function cothinkExtension(host = {}) {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const task = host.task;
      if (task?.record.status !== "running" || task.record.mode !== "answer")
        return;
      const material = renderAnswerSkills(task.answerSkills ?? []);
      const workRoute = host.allowWork!==false && task.record.workspace?.project && !task.record.constraints?.readOnly
        ? " Use start_work with a valid file plan before claiming file delivery." : "";
      const offlineArtifact = task.record.constraints?.networkMode === "artifact-offline"
        ? " Keep the deliverable usable offline and propose checks for external dependencies." : "";
      const {requireDifferentModelReview,...constraints}=task.record.constraints??{};
      const role = task.record.flow === "unified"
        ? "You are the conversation manager. Answer simple questions directly." + workRoute + offlineArtifact +
          (task.record.turnIntent?.fileRequired?" This turn requires actual files. If a plan is rejected, use its specific error to correct it within the remaining budget, or report the blocker. Inline code does not fulfill the file request.":"") +
          (requireDifferentModelReview?" The saved candidate review requirement applies to file work.":"") +
          (task.record.turnIntent?.collaboration?.length?" Frozen direct user collaboration requirements: " + JSON.stringify(task.record.turnIntent.collaboration):"") +
          " Decide in this request whether the goal benefits from independent work. For complex work, compare locally eligible frozen routes using the task requirements, user preferences and relevant saved evidence. Consider input modalities, available tools, context, and budget. Treat unknown facts as unknown and explain any provisional choice. Do not send a separate classification or calibration request." +
          (task.readonlyLifecycle?.available()?" For independent read-only work, use delegate for each part and collect each saved assignment before delivering the combined answer. Only select the materials, paths, and skills needed by that role.":"") +
          " Use tools within their authorized scope. At most one terminal route per turn. Frozen constraints follow. " + JSON.stringify(constraints) +
          "\nFrozen model and budget facts: " + JSON.stringify({models:task.projectRoutes??[],budget:projectRoutingBudget(task)})
        : task.record.singleModel
        ? "This task uses ONE single-model mode. You are solely responsible for the complete final answer; no other model will review or revise it. Check key reasoning, original constraints and omissions before delivering, and make necessary corrections within this response. If the task enters work, you remain the sole Team owner; no formal secondary members are delegated. Installed managed plugin helpers may assist unless the user disabled helpers."
        : task.record.phase === "revision"
          ? "This is the CoThink revision stage. Independently assess the supplied review and deliver the complete final answer. Explain important accepted or rejected comments as instructed, and preserve unresolved disagreements."
          : "This is the CoThink initial-answer stage. Independently produce a complete draft for review, making key reasons, assumptions and uncertainty clear. A later review does not reduce your responsibility for this answer's completeness and accuracy.";
      return { systemPrompt: [event.systemPrompt, role, material].filter(Boolean).join("\n\n") };
    });
    if(host.flow === "unified") {
      const result=value=>({content:[{type:"text",text:JSON.stringify(value)}]});
      for(const tool of readOnlyToolDefinitions(host))pi.registerTool(tool);
      pi.registerTool({name:"start_work",label:"Propose file work",
        description:"Use start when no formal project exists, including replacing an unconfirmed proposal. Use resume with only planRef for a saved approved plan, or revise with only a complete plan for an existing formal project. Never combine plan and planRef. A proposal does not grant write permission. "+planShape+" This example is a complete single-step plan. "+JSON.stringify(workPlanExample)+" Optional mcp:[{server,trust,tools:{name:{kind,target,allowedArguments:[exact argument objects]}}}] selects configured pi/mcp.json services; trust is explicit-service-contract or verified-server-readonly. Selected MCP tools become available during file execution; their absence during planning does not establish service unavailability. Never include credentials or infer authorization from tool annotations. For a requested visual check, set workRequest to {kind:\"html-svg\",entry:\"index.html\"} with an HTML/SVG entry declared in deliverables. Optional viewport, frameTimesMs and actions define how to inspect this entry. Actions use {kind:\"click\",selector}, {kind:\"fill\",selector,value}, or {kind:\"key\",key}.",
        parameters:Type.Object({
          action:Type.Union(workIntentActions.map(action=>Type.Literal(action))),reason:Type.String(),
          plan:Type.Optional(Type.Any({description:planShape})),
          planRef:Type.Optional(Type.Object({taskId:Type.String(),field:Type.Literal("proposal"),sha256:Type.String()},{description:"Reference previously reported by the host for this conversation"})),
        },{additionalProperties:false,anyOf:[
          {properties:{action:{enum:["start","revise"]}},required:["plan"],not:{required:["planRef"]}},
          {properties:{action:{const:"resume"}},required:["planRef"],not:{required:["plan"]}},
        ]}),
        async execute(id,args){
          try{
            const intent=await host.task.unifiedIntent("start_work",id,args);
            host.runtime.stopAfterTurn();
            return result({saved:true,kind:intent.kind,toolCallId:intent.toolCallId});
          }catch(error){
            if(host.task.stopUnifiedPlanAttempts)host.runtime.stopAfterTurn();
            throw error;
          }
        }});
      if(host.allowWork!==false)pi.registerTool({name:"read_project_context",label:"Read authorized project context",description:"Read/list/search fixed committed files within this turn's explicit read authorization; never executes commands.",
        parameters:Type.Object({operation:Type.Union([Type.Literal("list"),Type.Literal("read"),Type.Literal("search")]),paths:Type.Array(Type.String()),query:Type.Optional(Type.String()),offset:Type.Optional(Type.Integer()),limit:Type.Optional(Type.Integer())}),
        async execute(id,args){return result(await host.task.unifiedReadContext(args));}});
      pi.on("agent_before_settle",()=>host.task?.record.phase==="draft" && host.task.record.routeIntent ? {continue:false} : undefined);
      return;
    }
    pi.registerTool({
      name: "start_work",
      label: "开始工作",
      description:
        "开始实际工作；可声明scope/readScope，未知范围先观察，写入和Shell由agent-sync控制。",
      parameters: Type.Object({
        reason: Type.String(),
        deliverableKind: Type.Optional(Type.Literal("html-svg")),
        scope: Type.Optional(Type.Array(Type.String())),
        readScope: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(id, args) {
        if (host.allowWork === false) throw Error("当前会话未关联项目，不能开始工作。请选择项目新建对话。");
        if (!host.task) throw Error("任务尚未绑定");
        if(args.deliverableKind) { await host.task.preflightVisual(); host.task.record.workRequest={kind:args.deliverableKind}; }
        host.task.record.mode = "work";
        host.task.record.maxCalls = null;
        host.task.record.workReason = args.reason;
        host.task.record.workIntent = {
          reason: args.reason,
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.readScope ? { readScope: args.readScope } : {}),
        };
        host.task.record.phase = "work_starting";
        try {
          host.task.save();
        } catch (error) {
          host.task.ioError = error;
          throw error;
        }
        host.runtime.stopAfterTurn();
        return {
          content: [
            { type: "text", text: "工作意图已保存；宿主正在绑定独立工作区。" },
          ],
          details: { handoff: true },
        };
      },
    });
    pi.on("agent_before_settle", () => {
      if (host.task?.record.mode === "work") return { continue: false };
    });
  };
}
