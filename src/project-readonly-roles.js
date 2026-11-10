import { runReadOnlyRole } from "./project-readonly-runtime.js";
import { materialImage } from "./context.js";
import { randomUUID } from 'node:crypto';
import { problem } from './task.js';
import { validProjectPath, inScope } from './versioning.js';
import { digest } from "./project-collaboration-evidence.js";
import { adoptedReadOnlySource, collectReadOnlyEvidence, readOnlyReport, reportReceived, reviewSource } from "./project-readonly-reports.js";

// Read-only assignments live in root stages. The live map contains only
// runtime handles and promises for work already registered in that record.
export function bindReadonlyRoles(task,{admission,cwd}) {
  const roles=new Map();
  let main,closed=false,closing;
  let observationsChanged=Promise.withResolvers();
  const monitor=()=>task.rootOwner.processCheck;
  const inAdmission=action=>admission(action);
  const assertOpen=()=>{
    task.signal.throwIfAborted();
    if(closed||task.ioError||task.record.status!=="running")
      throw problem("ROOT_STOPPED","Root no longer permits read-only work");
  };
  const source={
    task,cwd,config:task.record.frozenConfig,get modelRuntime(){return main?.modelRuntime;},
    notify(){observationsChanged.resolve();observationsChanged=Promise.withResolvers();},
    bindObservation:grant=>task.rootOwner.bindReadonlyObservation(grant),
    snapshot(){
      return [...roles.values()].map(({stage})=>{
        const {assignment}=stage;
        return {taskId:task.record.id,memberId:stage.id,leaderId:assignment.leaderId,
          attempt:stage.id,assignment:assignment.work,status:assignment.pause&&!assignment.settledAt?"paused":assignment.status,
          evidenceIds:task.processRequestFacts(stage.role).map(call=>call.id)};
      });
    },
    isCurrent({memberId,leaderId,attempt}){
      const role=roles.get(memberId)?.stage;
      return role?.id===attempt&&role.assignment.leaderId===leaderId&&!role.assignment.closedAt;
    },
  };
  const actorTool=(name,id,args,actor)=>{
    const supervisor=actor==="main"?null:roles.get(actor)?.stage;
    if(actor!=="main"&&(!supervisor?.assignment.canDelegate||supervisor.assignment.closedAt||supervisor.assignment.settledAt))
      throw problem("GROUP_OWNERSHIP","Only a live authorized supervisor may manage its direct reports");
    const role=supervisor?.role??"main";
    const request=task.requests().findLast(call=>call.role===role&&call.sent&&call.status==="completed"&&
      (supervisor?call.stageId===supervisor.id:call.phase==="draft")&&
      call.response?.content?.some(item=>item.type==="toolCall"&&item.name===name&&item.id===id&&digest(item.arguments)===digest(args)));
    if(!request)throw problem("INTENT_SOURCE","No saved physical supervisor response for this tool call");
    return {request,supervisor};
  };
  const directReport=(id,actor)=>{
    const handle=roles.get(id);
    if(!handle||handle.stage.assignment.leaderId!==actor)
      throw problem("GROUP_OWNERSHIP","Only the direct supervisor can manage this report");
    return handle;
  };
  function launch(modelRef,assignment,phase="readonly-worker") {
    const permit=monitor().admit(source);
    try{
      const stageId=randomUUID();
      const stage=task.beginPhase(phase,"member:"+stageId,modelRef,{roleOnly:true,stageId,assignment});
      const handle={stage};
      roles.set(stage.id,handle);
      try{
        if(assignment.corrects)roles.get(assignment.corrects).stage.assignment.supersededBy=stage.id;
        task.save();
        permit.commit(stage.id);
      }catch(error){task.stop(error);throw error;}
      handle.done=Promise.resolve().then(()=>runReadOnlyRole(handle,{task,cwd,main,previous:roles.get(assignment.corrects)?.stage,assertOpen}));
      void handle.done.catch(error=>task.stop(error));
      return {assignmentId:stage.id,workId:assignment.workId,saved:true};
    }catch(error){permit.release();throw error;}
  }
  function checkedList(value) {
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>32||new Set(value.map(item=>digest(item))).size!==value.length)
      throw problem("ROLE_EVIDENCE","Expected a bounded list of distinct frozen grants");
    return value;
  }
  const finalize=async({cancel=false,finalCall}={})=>{
    closed=true;
    for(const handle of roles.values()){
      const {assignment}=handle.stage;
      if(!assignment.settledAt){
        assignment.closedAt=new Date().toISOString();task.save();
        if(handle.runtime)void handle.runtime.session.abort().catch(error=>{handle.stopError=error;});
      }
    }
    await Promise.all([...roles.values()].map(handle=>handle.done));
    const stages=[...roles.values()].map(handle=>handle.stage);
    const checker=monitor();
    const requests=task.requests();
    const gaps=new Set();
    if(stages.length){
      try {
        if(!cancel&&!task.signal.aborted)await checker.cover(source);
      }catch(error){gaps.add(error.message);}
      finally{
        await checker.detach(source);
        await checker.close();
      }
    }
    return collectReadOnlyEvidence({task,roles,stages,requests,finalCall,cancel,gaps});
  };
  return task.readonlyLifecycle={
    bind(runtime){main=runtime;},
    available(){return Boolean(!closed&&monitor()&&task.record.constraints.allowedSubtasks.includes("work"));},
    async beforeFileRoute(call){
      if(!roles.size)return;
      if([...roles.values()].some(({stage:{assignment}})=>!assignment.settledAt||!assignment.collected))
        throw problem("ROLE_HANDOFF","Collect and settle read-only assignments before proposing file work");
      const result=await this.close({finalCall:call});
      if(result.gap||result.unknown)throw problem("ROLE_HANDOFF",result.gap??"Read-only assignment settlement is unknown");
      const context=task.record.handoffContext;
      const adopted=[...roles.values()].flatMap(({stage})=>stage.assignment.leaderId==="main"&&
        !stage.assignment.supersededBy&&!stage.assignment.review&&stage.assignment.treatment?.decision==="adopt"
        ?[adoptedReadOnlySource(task.home,task.record,stage)]:[]);
      const existing=new Set(context.materials.map(item=>item.sourceId));
      context.materials.push(...adopted.filter(item=>!existing.has(item.sourceId)));
      if(adopted.length)task.save();
    },
    delegate(id,args,actor="main"){
      return inAdmission(()=>{
        assertOpen();
        if(!this.available())throw problem("ROOT_SUBTASK","This turn does not authorize read-only delegation");
        if(task.record.routeIntent)throw problem("INTENT_CONFLICT","A file route is already saved");
        const {request:call,supervisor}=actorTool("delegate",id,args,actor),argsDigest=digest(args);
        const prior=[...roles.values()].find(({stage})=>stage.assignment.leaderId===actor&&stage.assignment.toolCallId===id);
        if(prior){
          if(prior.stage.assignment.callId!==call.id||prior.stage.assignment.argsDigest!==argsDigest)
            throw problem("ROLE_REPLAY","Assignment tool identity was already used");
          return {assignmentId:prior.stage.id,workId:prior.stage.assignment.workId,saved:true};
        }
        const {workId,model,assignment:work,reason,canDelegate=false,maxDepth,reviewOf}=args;
        const depth=(supervisor?.assignment.depth??1)+1;
        const ceiling=maxDepth??task.record.staffMaxDepth??3;
        if((maxDepth!==undefined&&(actor!=="main"||![3,4].includes(maxDepth)||maxDepth<(task.record.staffMaxDepth??3)))||
          depth>ceiling||canDelegate&&(depth===ceiling||reviewOf))
          throw problem("GROUP_DEPTH","This role exceeds the authorized staffing depth");
        if(typeof workId!=="string"||!/^[-_a-zA-Z0-9]{1,80}$/.test(workId)||
            [work,reason].some(value=>typeof value!=="string"||!value.trim()||value.length>8000))
          throw problem("ROLE_ASSIGNMENT","A bounded work ID, assignment and reason are required");
        if([...roles.values()].some(({stage})=>stage.assignment.workId===workId))
          throw problem("ROLE_ASSIGNMENT","A role is already assigned to this work ID");
        const route=task.projectRoutes.find(route=>route.identity===model);
        if(!route?.available)throw problem("MODEL_UNAVAILABLE",route?.unavailableReason??"Model is outside the frozen eligible roster");
        const modelRef=[task.record.models.main,...task.record.models.secondary].find(ref=>ref.provider===route.provider&&ref.modelId===route.modelId);
        const selectedModel=main.modelRuntime.getModel(route.provider,route.modelId);
        if(!selectedModel||selectedModel.api!==route.api)
          throw problem("MODEL_UNAVAILABLE","Selected provider route changed during this turn");
        const {target,review}=reviewOf?reviewSource(task,roles,directReport(reviewOf.assignmentId,actor).stage,reviewOf,call,selectedModel):{};
        if(review&&!task.record.constraints.allowedSubtasks.includes("review"))
          throw problem("ROOT_SUBTASK","This turn does not authorize review");
        const frozenContext=task.record.handoffContext;
        const parent=target?.assignment??supervisor?.assignment;
        const attachmentSources=parent?parent.attachments:frozenContext.attachmentRefs;
        const evidenceSources=parent?parent.evidence:frozenContext.materials;
        const attachments=checkedList(args.attachments).map(ref=>{
          const match=attachmentSources?.find(a=>a.id===ref?.id&&a.sha256===ref.sha256);
          if(!match)throw problem("ROLE_EVIDENCE","Attachment is outside this turn’s frozen sources");
          if(materialImage(match)&&!route.input?.includes("image"))
            throw problem("MATERIAL_IMAGE_MODEL","Selected role model cannot receive its assigned image");
          return match;
        });
        const evidence=checkedList(args.evidence).map(id=>{
          const item=evidenceSources.find(item=>item.sourceId===id);
          if(!item||item.attachmentRefs?.some(a=>!attachments.some(selected=>selected.id===a.id&&selected.sha256===a.sha256)))
            throw problem("ROLE_EVIDENCE","Evidence source is outside this role’s frozen sources or includes an unselected attachment");
          const {ref,text,projection,derived,sourceId,attachmentRefs}=item;
          return {ref,text,projection,derived,sourceId,attachmentRefs};
        });
        const parentGrant=parent?parent.grant:task.record.readAuthorization;
        const paths=checkedList(args.readScope);
        if(paths.some(path=>!parentGrant||!validProjectPath(path,true)||!inScope(path,parentGrant.paths)))
          throw problem("READ_SCOPE","Requested role path is outside the frozen parent read grant");
        const grant=paths.length?{...parentGrant,paths}:null;
        const skills=checkedList(args.skills);
        if(skills.some(name=>parent?!parent.skills.includes(name):!task.answerSkills.some(skill=>skill.name===name)))
          throw problem("SKILL_RESOURCE","Skill is outside this turn’s frozen skills");
        if(maxDepth!==undefined)task.record.staffMaxDepth=maxDepth;
        return launch(modelRef,{workId,work,reason,leaderId:actor,depth,canDelegate,toolCallId:id,callId:call.id,argsDigest,
          status:"registered",attachments,evidence,grant,skills,route:{api:route.api,baseUrl:selectedModel.baseUrl},
          ...(review?{review}:{})});
      });
    },
    pause(id,args,actor="main"){
      return inAdmission(()=>{
        assertOpen();
        const {request}=actorTool("pause_member",id,args,actor);
        const root=directReport(args.assignmentId,actor),original=root.stage.assignment.pause;
        if(original){
          if(original.toolCallId!==id||original.callId!==request.id||original.reason!==args.reason)
            throw problem("ROLE_REPLAY","This report has a saved pause; inspect the original receipt");
          return {assignmentId:root.stage.id,...original};
        }
        if(typeof args.reason!=="string"||!args.reason.trim()||args.reason.length>4000||
          root.stage.assignment.settledAt)
          throw problem("ROLE_PAUSE","An unfinished direct report and a specific pause reason are required");
        const affected=new Set([root.stage.id]);
        for(const {stage} of roles.values())
          if(affected.has(stage.assignment.leaderId))affected.add(stage.id);
        const open=[...affected].map(id=>roles.get(id)).filter(({stage})=>!stage.assignment.settledAt&&!stage.assignment.pause);
        for(const {stage} of open){
          const a=stage.assignment;
          a.closedAt=new Date().toISOString();
          a.pause={toolCallId:id,callId:request.id,reason:args.reason,closedAt:a.closedAt,status:"settling",
            requestIds:[...stage.callIds]};
        }
        task.save();
        for(const handle of open)if(handle.runtime)void handle.runtime.session.abort().catch(error=>{
          handle.stopError=error;
          handle.stage.assignment.pause.status="unknown";
          task.save();
        });
        return {assignmentId:root.stage.id,...root.stage.assignment.pause,affected:[...affected]};
      });
    },
    feedback(id,args,actor="main"){
      return inAdmission(()=>{
        assertOpen();
        const {request}=actorTool("feedback",id,args,actor);
        const prior=directReport(args.assignmentId,actor).stage,a=prior.assignment;
        if(a.supersededBy){
          const original=roles.get(a.supersededBy).stage.assignment;
          if(original.toolCallId===id&&original.callId===request.id&&original.argsDigest===digest(args))
            return {assignmentId:a.supersededBy,workId:a.workId,saved:true};
          throw problem("ROLE_REPLAY","This report already has a saved correction");
        }
        if(a.review||a.canDelegate||a.treatment||a.status!=="completed"||!a.collected||
          !reportReceived(request,a.collected)||typeof args.feedback!=="string"||!args.feedback.trim()||args.feedback.length>4000)
          throw problem("ROLE_FEEDBACK","Collect the direct worker's settled report and identify a specific gap before correcting it");
        const {workId,work,reason,leaderId,depth,attachments,evidence,grant,skills,route}=a;
        return launch(prior.modelRef,{workId,work,reason,leaderId,depth,attachments,evidence,grant,skills,route,
          corrects:prior.id,feedback:args.feedback,toolCallId:id,callId:request.id,argsDigest:digest(args),status:"registered"},
          "readonly-feedback");
      });
    },
    async collect(id,args,actor="main"){
      const {handle,call}=await inAdmission(()=>{
        assertOpen();
        const {request:call}=actorTool("collect",id,args,actor);
        return {handle:directReport(args.assignmentId,actor),call};
      });
      while(!handle.stage.assignment.settledAt){
        const progressReports=monitor().reports(source,actor);
        if(progressReports.length)return {assignmentId:handle.stage.id,status:handle.stage.assignment.status,progressReports};
        await Promise.race([handle.done,observationsChanged.promise]);
      }
      return inAdmission(()=>{
        assertOpen();
        const {stage}=handle,a=stage.assignment;
        if(a.collected?.toolCallId===id&&a.collected.callId!==call.id)
          throw problem("ROLE_REPLAY","Collection tool identity was already used");
        const request=a.status==="completed"?readOnlyReport(task.home,task.record,stage):null;
        const {decision,reason}=args;
        if(decision){
          if(!["adopt","discard"].includes(decision)||typeof reason!=="string"||!reason.trim()||
            reason.length>4000||!a.collected||!reportReceived(call,a.collected)||a.status==="outcome_unknown"||
            (decision==="adopt"&&!request))
            throw problem("ROLE_REPORT","Read the settled role report before recording an adoption or discard with its reason");
          const next={decision,reason,toolCallId:id,callId:call.id};
          if(a.treatment&&digest(a.treatment)!==digest(next))
            throw problem("ROLE_REPORT","A report decision is already saved");
          a.treatment=next;
        }
        a.collected??={toolCallId:id,callId:call.id};
        task.save();
        return {assignmentId:stage.id,workId:a.workId,status:a.status,sessionId:stage.sessionId,
          resultRequestId:a.resultRequestId,reportDigest:a.reportDigest,report:request?.text,error:a.error,treatment:a.treatment,reviewReceipt:a.reviewReceipt,
          progressReports:monitor().reports?.(source,"main")??[]};
      });
    },
    close(options){return closing??=finalize(options);},
  };
}
