import { Type } from "typebox";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadInputMaterials } from "./context.js";
import { readOnlyToolDefinitions } from "./extensions/cothink.js";
import { createRuntime, projectRoutingBudget } from "./pi-runtime.js";
import { digest } from "./project-collaboration-evidence.js";
import { reviewReceipt } from "./project-readonly-reports.js";
import { problem } from "./task.js";
import { readProjectContext } from "./versioning.js";

export async function runReadOnlyRole(handle,{task,cwd,main,previous,assertOpen}){
  const {stage}=handle,{assignment}=stage;
  try {
    if(assignment.closedAt)throw problem("ROLE_CLOSED","Assignment stopped before sending");
    const {grant,attachments,evidence,skills,route,review,feedback}=assignment;
    const actorHost={task,actor:stage.id};
    const supervisorTools=assignment.canDelegate?readOnlyToolDefinitions(actorHost):[];
    const runtime=await createRuntime({home:task.home,cwd,modelRef:stage.modelRef,role:"readonly-"+stage.id,
      sessionManager:previous?SessionManager.open(previous.sessionFile):undefined,
      projectManaged:true,useFrozenSkills:true,contextAccess:false,packageSnapshot:main.packageSnapshot,
      activeToolNames:["get_capabilities",...(skills.length?["read_skill"]:[]),...(grant?["read_project_context"]:[]),...supervisorTools.map(tool=>tool.name)],
      getWorkspaceAuthority:()=>({active:!assignment.closedAt,readOnly:true,readScope:grant?.paths??[]}),
      resourceOptions:{noContextFiles:true,systemPrompt:
        "You are a read-only worker. Complete only the assigned part and return a sourced report to your manager. Work within the tools and evidence supplied to this role. User requirements and constraints remain authoritative. Follow the user’s language."+
        (assignment.canDelegate?" Manage only your own direct reports. Select only from your frozen materials, collect their results and correct specific gaps.":"")+
        (review?' Independently review only the fixed report and its specified evidence against the given criteria. Return JSON with verdict (pass, reject, or uncertain) and observation.':"")},
      toolDefinitions:[...supervisorTools,...(grant?[{name:"read_project_context",label:"Read assigned project context",
        description:"Read, list or search fixed committed files within this role’s read grant.",
        parameters:Type.Object({operation:Type.Union([Type.Literal("list"),Type.Literal("read"),Type.Literal("search")]),
          paths:Type.Array(Type.String()),query:Type.Optional(Type.String()),offset:Type.Optional(Type.Integer()),limit:Type.Optional(Type.Integer())}),
        async execute(_id,args){
          assertOpen();
          if(assignment.closedAt)throw problem("ROLE_CLOSED","Read grant is closed");
          return {content:[{type:"text",text:JSON.stringify(await readProjectContext({home:task.home,record:{readAuthorization:grant}},args))}]};
        },
      }]:[])],
    });
    actorHost.runtime=handle.runtime=runtime;
    try {
      assertOpen();
      if(assignment.closedAt)throw problem("ROLE_CLOSED","Assignment stopped before sending");
      const model=runtime.modelRuntime.getModel(stage.modelRef.provider,stage.modelRef.modelId);
      if(!model||model.api!==route.api||model.baseUrl!==route.baseUrl)
        throw problem("MODEL_UNAVAILABLE","Selected provider route changed during this turn");
      const inputMaterials=loadInputMaterials(task.home,attachments);
      runtime.bindTask(task,stage,{materials:inputMaterials,allowedSkills:skills});
      assignment.status="running";task.save();
      const input=feedback?{source:"Specific corrective feedback from your direct supervisor",feedback}:
        {originalUserInput:task.record.input,constraints:task.record.constraints,
          assignment:assignment.work,reason:assignment.reason,
          evidence,readGrant:grant?{paths:grant.paths,version:grant.version}:null,skills,
          ...(assignment.canDelegate?{attachments:attachments.map(({id,sha256})=>({id,sha256})),
            models:task.projectRoutes,budget:projectRoutingBudget(task),maxDepth:task.record.staffMaxDepth??3}:{}),
          ...(review?{review:review.artifact}:{})};
      const result=await runtime.prompt(JSON.stringify(input),{inputMaterials:feedback?[]:inputMaterials});
      if(!result.text.trim())throw problem("ROLE_REPORT","Role did not return a report");
      assignment.resultRequestId=result.call.id;
      assignment.reportDigest=digest(result.text);
      if(review)assignment.reviewReceipt=reviewReceipt(stage,review,result.call);
    } finally {
      await runtime.dispose();
    }
    assignment.status="completed";
  }catch(error){
    const requests=task.requests().filter(call=>stage.callIds.includes(call.id));
    assignment.status=error.code==="SHUTDOWN_UNKNOWN"||requests.some(call=>call.status==="outcome_unknown"||call.status==="in_flight")
      ?"outcome_unknown":assignment.closedAt&&!requests.some(call=>call.sent)?"not_sent":"failed";
    stage.status=assignment.status;
    assignment.error={code:error.code??"ROLE_FAILURE",message:error.message};
  }finally{
    assignment.settledAt=new Date().toISOString();
    if(assignment.pause)assignment.pause.status=assignment.status==="outcome_unknown"?"unknown":"settled";
    task.save();
  }
}
