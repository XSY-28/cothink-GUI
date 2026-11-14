import {join} from "node:path";
import {readTask} from "./task.js";
import {writePrivateJson} from "./storage.js";
import {conversationTaskIds,readSessionProject} from "./conversation.js";
import {readGuiWorkspaces,workspaceError,isWorkspaceId} from "./gui-workspace-state.js";
import {unifiedProtocol,checkedProposal,reserveConfirmation,confirmationState,workConfirmationBlocker,loadPreparedContinuation} from "./project-turn.js";
import {requireFileWork,requireGuiExecution,exportTaskDraft,revealGuiDirectory} from "./gui-work.js";

// The controller owns all state and serialization. These accessors stay live
// across awaited preparation; this module neither caches a seat nor queues work.
export function createGuiFileActions({
  home,reader,workspaceFacts,projectMembership,writeSelection,owner,assertWorkspaceWritable,assertSessionUnarchived,
  live,taskCache,inspectExecution,submit,emit,oauthBusy,rawTask,getActive,isManaging,setManaging,isShuttingDown,
}) {
  async function confirmWork(args) {
    if(!args||Object.keys(args).some(k=>!["sessionId","submissionId","proposalRef","protocolVersion"].includes(k))||args.protocolVersion!==unifiedProtocol||typeof args.submissionId!=="string"||!args.submissionId||args.submissionId.length>200)throw Error("确认参数或协议无效。");
    const {sessionId,proposalRef,submissionId}=args, id=proposalRef?.sourceTaskId;
    const assertProposalBranch=manager=>{
      if(!conversationTaskIds(manager).includes(id))throw Error("提议不属于当前可见分支。");
    };
    const prepared=await writeSelection(async()=>{
      const manager=await reader(sessionId);
      assertProposalBranch(manager);
      const saved=readTask(home,id);
      if(saved.confirmationIntent){
        const facts=workspaceFacts(manager);
        const membership=projectMembership(facts,readGuiWorkspaces(home));
        if(membership.workspaceError||saved.workspace?.project!==facts.project)
          throw workspaceError("WORKSPACE_UNAVAILABLE",membership.workspaceError??"提议的目录归属无法确认。");
        checkedProposal(home,saved,proposalRef,{sessionId,workspaceId:membership.workspaceId});
        const found=await confirmationState({home,source:saved,reservation:saved.confirmationIntent,receiptOnly:true});
        if(found.task)return {found};
        if(getActive()?.taskId===saved.confirmationIntent.taskId&&getActive().sessionId===sessionId)return {joining:getActive().ready};
      }
      if(getActive()||isManaging())throw Error("当前任务或设置尚未结束，请先等待。");
      setManaging(true);
      try {
        assertSessionUnarchived(sessionId);
        const holder=await owner(sessionId,{mutating:true});
        const membership=await assertWorkspaceWritable(holder.sessionManager,{forExecution:true,requireTeam:true});
        assertProposalBranch(holder.sessionManager);
        const sourceTask=live.get(id),source=sourceTask?.record??readTask(home,id);
        if (source.workspace?.directoryIdentity!==undefined)
          await requireFileWork(home,source.workspace.project,source.workspace.directoryIdentity);
        const save=()=>{holder.assertOwned();if(sourceTask)sourceTask.save();else writePrivateJson(join(home,"tasks",id+".json"),source,holder.assertOwned);taskCache.delete(id);};
        checkedProposal(home,source,proposalRef,{sessionId,workspaceId:membership.workspaceId});
        const blocker=workConfirmationBlocker(source);
        if(blocker)throw workspaceError("PROPOSAL_BLOCKED",blocker);
        if(!source.proposal.reuseCompletedDelivery)await requireGuiExecution(source.frozenConfig.work,inspectExecution);
        if(isShuttingDown())throw Error("宿主正在关闭，任务未发送。");
        const reservation=await reserveConfirmation({home,source,proposalRef,sessionId,workspaceId:membership.workspaceId,submissionId,save});
        const found=await confirmationState({home,source,reservation});
        return {source,reservation,found};
      } finally {setManaging(false);emit();}
    });
    if(prepared.joining)return prepared.joining;
    if(prepared.found.task)return {taskId:prepared.found.task.id,sessionId:args.sessionId};
    return submit({sessionId:args.sessionId,input:prepared.source.input,submissionId:prepared.reservation.submissionId},prepared);
  }
  async function inspectContinuation(args) {
    if(!args||Object.keys(args).some(k=>!["sessionId","sourceRootTaskId","draft"].includes(k))||
       !isWorkspaceId(args.sessionId)||!isWorkspaceId(args.sourceRootTaskId))throw Error("继续核对参数无效。");
    const manager=await reader(args.sessionId);
    if(!conversationTaskIds(manager).includes(args.sourceRootTaskId))throw Error("原任务不属于当前可见分支。");
    const source=readTask(home,args.sourceRootTaskId),facts=workspaceFacts(manager);
    const membership=projectMembership(facts,readGuiWorkspaces(home));
    if(source.sessionId!==args.sessionId||membership.workspaceError||source.workspace?.project!==facts.project||
      (source.workspace?.id??null)!==(membership.workspaceId??null))throw Error("原任务的目录或 Team 归属无法核对。");
    const {inspectFileContinuation}=await import('./project-continuation.js');
    const result=await inspectFileContinuation({home,sourceRootTaskId:source.id,...(Object.hasOwn(args,'draft')?{draft:args.draft}:{})});
    const config=source.frozenConfig;
    return {...result,models:[config?.main,...(config?.secondary??[])].filter(Boolean).map(ref=>
      `${ref.provider}/${ref.modelId}${ref.thinkingLevel?' · '+ref.thinkingLevel:''}`)};
  }
  async function continueFileWork(args,mode='user') {
    if(!args||Object.keys(args).some(k=>!["sessionId","sourceRootTaskId","draft","submissionId","protocolVersion","expectedRevision","expectedFormalVersion"].includes(k))||
      args.protocolVersion!==unifiedProtocol||!isWorkspaceId(args.sessionId)||!isWorkspaceId(args.sourceRootTaskId)||
      typeof args.submissionId!=='string'||!args.submissionId||args.submissionId.length>200)throw Error("继续参数或协议无效。");
    const {reserveFileContinuation}=await import('./project-file-confirmation.js');
    const prepared=await writeSelection(async()=>{
      const manager=await reader(args.sessionId);
      if(!conversationTaskIds(manager).includes(args.sourceRootTaskId))throw Error("原任务不属于当前可见分支。");
      const saved=readTask(home,args.sourceRootTaskId),existing=saved.fileContinuationIntent;
      if(existing){
        const found=await confirmationState({home,source:saved,reservation:existing,receiptOnly:true});
        if(found.task)return {found};
        if(getActive()?.taskId===existing.taskId&&getActive().sessionId===args.sessionId)return {joining:getActive().ready};
      }
      if(getActive()||isManaging()||oauthBusy())throw Error("当前任务或设置尚未结束；继续操作不会排队。");
      setManaging(true);
      try {
        assertSessionUnarchived(args.sessionId);
        const holder=await owner(args.sessionId,{mutating:true});
        const membership=await assertWorkspaceWritable(holder.sessionManager,{forExecution:true,requireTeam:true});
        const source=readTask(home,args.sourceRootTaskId);
        if(source.sessionId!==args.sessionId||source.workspace?.project!==readSessionProject(holder.sessionManager)||
           (source.workspace?.id??null)!==(membership.workspaceId??null))throw Error("原任务的目录或 Team 已变化。");
        if(source.workspace?.directoryIdentity!==undefined)
          await requireFileWork(home,source.workspace.project,source.workspace.directoryIdentity);
        if(args.draft!==null)await requireGuiExecution(source.frozenConfig.work,inspectExecution);
        if(isShuttingDown())throw Error("宿主正在关闭，任务未发送。");
        const reservation=await reserveFileContinuation({home,sessionId:args.sessionId,sourceRootTaskId:source.id,
          draft:args.draft,submissionId:args.submissionId,expectedRevision:args.expectedRevision,expectedFormalVersion:args.expectedFormalVersion,
          authorizationSource:{kind:'file_continuation',sourceTaskId:source.id,mode},
          save:updated=>{
            holder.assertOwned();const current=live.get(source.id);
            if(current){current.record.fileContinuationIntent=updated.fileContinuationIntent;current.save();}
            else writePrivateJson(join(home,'tasks',source.id+'.json'),updated,holder.assertOwned);
            taskCache.delete(source.id);
          }});
        const updated=readTask(home,source.id);
        return {source:updated,reservation,found:await confirmationState({home,source:updated,reservation})};
      }finally{setManaging(false);emit();}
    });
    if(prepared.joining)return prepared.joining;
    if(prepared.found.task)return {taskId:prepared.found.task.id,sessionId:args.sessionId};
    return submit({sessionId:args.sessionId,input:prepared.source.input,submissionId:prepared.reservation.submissionId},prepared);
  }
  async function continuePrepared(args) {
    if (!args || Object.keys(args).length!==4 || !isWorkspaceId(args.sessionId) || !isWorkspaceId(args.sourceTaskId) ||
        !isWorkspaceId(args.submissionId) || args.protocolVersion!==unifiedProtocol) throw Error("工作续作参数无效。");
    const manager=await reader(args.sessionId);
    const continuation=loadPreparedContinuation({home,manager,sourceTaskId:args.sourceTaskId});
    if (continuation.remainingBudget.maxCost!==null)
      throw Error("原工作费用上限无法核实剩余金额，续作尚未发送。");
    if (continuation.remainingBudget.maxCalls===0)
      throw Error("原任务的调用额度已经用完。");
    return submit({sessionId:args.sessionId,input:continuation.source.input,submissionId:args.submissionId,
      protocolVersion:unifiedProtocol},null,continuation);
  }

  async function exportDraft(args) {
    const result=await exportTaskDraft({home,record:rawTask(args.taskId).record,draft:args.draft});
    try {await revealGuiDirectory(result.directory);}
    catch(error){result.warnings.push("草稿已导出，但目录未能打开："+error.message);}
    return result;
  }
  return {confirmWork,inspectContinuation,continueFileWork,continuePrepared,exportDraft};
}
