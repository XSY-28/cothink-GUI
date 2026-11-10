import { SessionManager } from '@earendil-works/pi-coding-agent';
import { taskDisplayStatus } from './task.js';
import { conversationMaterialRefs, sessionWriteIncomplete } from './conversation.js';
import {loadInputMaterials} from './context.js';
import { assertContextSource, buildConversationProjection, contextDigest, fail, readContextDisk } from "./context-projection.js";
export { assertContextSource, buildConversationProjection, contextDigest, contextSnapshot, contextState, contextToolNames, readContextDisk } from "./context-projection.js";
export { createContextAccess } from "./context-access.js";

export function verifyContextCommit(record,manager,requests){
  const snapshot=record.sourceSnapshot,all=manager.getEntries();
  if(!snapshot||snapshot.sessionId!==record.sessionId||contextDigest(all.slice(0,snapshot.entryCount))!==snapshot.entriesDigest)throw fail('CONTEXT_STORAGE','Original context entries no longer match');
  const sourceBranch=manager.getBranch(snapshot.sourceLeaf);
  if(contextDigest(sourceBranch)!==snapshot.branchDigest||contextDigest(sourceBranch.map(e=>e.id))!==contextDigest(snapshot.entryIds)||!snapshot.entryIds.includes(record.sourceLeaf))throw fail('CONTEXT_STORAGE','Frozen source branch identity does not match');
  const candidates=all.filter(e=>e.type==='compaction'&&e.details?.cothinkContext?.taskId===record.id);
  if(candidates.length!==1)throw fail('CONTEXT_STORAGE','Compaction commit is absent or ambiguous');
  const entry=candidates[0],p=entry.details.cothinkContext;
  if(entry.parentId!==snapshot.sourceLeaf||!snapshot.entryIds.includes(entry.firstKeptEntryId)||p.sessionId!==record.sessionId||p.sourceDigest!==snapshot.entriesDigest||p.sourceLeaf!==snapshot.sourceLeaf||p.summaryDigest!==contextDigest(entry.summary)||contextDigest(p.entryIds)!==contextDigest(snapshot.entryIds)||contextDigest(p.requestIds)!==contextDigest(requests.map(r=>r.id))||!requests.length||requests.some(r=>r.taskId!==record.id||r.phase!=='context-summary'||r.status!=='completed'||!r.sent||!record.stages.some(s=>s.id===r.stageId&&s.phase==='context-summary'&&s.sessionId===record.sessionId)))throw fail('CONTEXT_STORAGE','Compaction identity/source/request proof does not match');
  if(record.preparation?.expectedCalls!==requests.length||record.preparation?.firstKeptEntryId!==entry.firstKeptEntryId)throw fail('CONTEXT_STORAGE','Compaction preparation does not match');
  return entry;
}

/** One explicit task; caller owns GUI admission. No retry, private SDK API or rollback. */
export async function compactContext({task,runtime,onChange=()=>{},quarantine}){
  const manager=runtime.sessionManager,snapshot=task.record.sourceSnapshot;
  let original=manager.appendCompaction,unsubscribe,appendAttempted=false,hookError;
  let stage;
  let resolveSettled;const lifecycle=new Promise(resolve=>{resolveSettled=resolve;});
  task.contextLifecycle=lifecycle;
  const check=()=>{runtime.assertOwned();if(runtime.selectionError)throw fail('CONTEXT_STORAGE',runtime.selectionError);if(task.signal.aborted)throw task.signal.reason;if(task.ioError)throw task.ioError;if(task.record.status!=='running')throw fail('TASK_ENDED','Context operation has stopped');assertContextSource(snapshot,manager);};
  try{
    task.materialContext=loadInputMaterials(task.home,conversationMaterialRefs(manager));
    stage=task.beginPhase('context-summary','main',task.record.models.main);runtime.bindTask(task,stage);
    check();
    unsubscribe=runtime.onContextPreparation(event=>{
      try{
        check();if(event.reason!=='manual'||event.willRetry||event.signal.aborted||contextDigest(event.branchEntries)!==snapshot.branchDigest)throw fail('CONTEXT_SOURCE_CHANGED','Preparation no longer matches source');
        const p=event.preparation;
        const raw=SessionManager.inMemory(manager.getCwd(),undefined,[manager.getHeader(),...event.branchEntries]).buildSessionProjection();
        const view=buildConversationProjection(task.home,manager,{projection:raw});
        const visible=new Map();
        for(let i=0;i<raw.entries.length;i++){
          const before=raw.entries[i],after=view.entries[i];
          for(const message of before.messages){
            const replacement=after.messages.find(candidate=>candidate.role===message.role);
            if(replacement)visible.set(contextDigest(message),replacement);
          }
        }
        const project=messages=>messages.flatMap(message=>visible.get(contextDigest(message))??[]);
        p.messagesToSummarize=project(p.messagesToSummarize);
        p.turnPrefixMessages=project(p.turnPrefixMessages);
        p.fileOps={read:new Set(),written:new Set(),edited:new Set()};
        if(!p.messagesToSummarize.length&&!p.turnPrefixMessages.length)throw fail('CONTEXT_INCOMPLETE','没有可整理的已交付会话内容。');
        const expectedCalls=p.isSplitTurn&&p.turnPrefixMessages.length?(p.messagesToSummarize.length?2:1):1;
        task.record.preparation={isSplitTurn:p.isSplitTurn,expectedCalls,firstKeptEntryId:p.firstKeptEntryId,tokensBeforeEstimate:p.tokensBefore};task.save();onChange();
        if(task.record.budget.maxCost!==null||task.record.budget.maxCalls!==null&&task.record.budget.maxCalls<expectedCalls)throw fail('CONTEXT_BUDGET','整理预算不足；split-turn 可能需要两次请求，费用硬上限不能用估价保证。');
        return undefined;
      }catch(error){hookError=error;return {cancel:true};}
    });
    manager.appendCompaction=function(summary,firstKeptEntryId,tokensBefore,details,fromHook,...rest){
      check();const persisted=readContextDisk(manager.getSessionFile(),task.record.sessionId);
      if(contextDigest(persisted.getEntries())!==snapshot.entriesDigest)throw fail('CONTEXT_SOURCE_CHANGED','Persisted source changed before compaction append');
      const requests=task.requests(),prep=task.record.preparation;
      if(fromHook||!prep||prep.firstKeptEntryId!==firstKeptEntryId||!snapshot.entryIds.includes(firstKeptEntryId)||requests.length!==prep.expectedCalls||requests.some(r=>r.phase!=='context-summary'||r.status!=='completed'))throw fail('CONTEXT_INCOMPLETE','Incomplete or externally replaced summary cannot be applied');
      appendAttempted=true;
      return original.call(this,summary,firstKeptEntryId,tokensBefore,{...details,cothinkContext:{taskId:task.record.id,sessionId:task.record.sessionId,sourceLeaf:snapshot.sourceLeaf,sourceDigest:snapshot.entriesDigest,entryIds:snapshot.entryIds,summaryDigest:contextDigest(summary),requestIds:requests.map(r=>r.id)}},fromHook,...rest);
    };
    await runtime.session.bindExtensions({mode:'print'});check();
    await runtime.session.compact('Preserve original goals, source references, constraints and unresolved outcomes. This is a derived summary, never new user authorization.');
    if(hookError)throw hookError;
    const disk=readContextDisk(manager.getSessionFile(),task.record.sessionId);
    const entry=verifyContextCommit(task.record,disk,task.requests());
    if(sessionWriteIncomplete(runtime)||contextDigest(disk.getEntries())!==contextDigest(manager.getEntries()))throw fail('CONTEXT_STORAGE','Memory and persisted session differ');
    task.record.contextResult={applied:true,entryId:entry.id,summaryDigest:contextDigest(entry.summary)};stage.status='completed';task.finish('completed');
  }catch(caught){
    const error=hookError??caught;
    let storageUncertain=appendAttempted;
    try{const disk=readContextDisk(manager.getSessionFile(),task.record.sessionId);storageUncertain ||= contextDigest(disk.getEntries())!==contextDigest(manager.getEntries());}catch{storageUncertain=true;}
    if(storageUncertain){task.record.contextRecovery={reason:error.message,entries:structuredClone(manager.getEntries()),leaf:manager.getLeafId()};quarantine(error);}
    if(stage)stage.status='partial';task.record.contextResult={applied:false,uncertain:storageUncertain,error:error.message};
    if(!task.signal.aborted)task.finish(storageUncertain||task.requests().some(r=>r.status==='outcome_unknown')?'outcome_unknown':'failed',error.message);else {task.record.error=error.message;task.save();}
  }finally{
    manager.appendCompaction=original;unsubscribe?.();runtime.unbindTask();resolveSettled();onChange();
  }
  return task;
}

export function contextOperationView(record,requests,manager){
  if(record.origin!=='context.organize')throw fail('CONTEXT_IDENTITY','This task is not a context operation');
  let applied=false,error=record.error??null,entry;
  try{entry=verifyContextCommit(record,manager,requests);applied=true;}catch(e){if(record.contextResult?.applied||record.contextResult?.uncertain||record.status==='outcome_unknown'&&!record.contextResult)error=e.message;}
  return {operationId:record.id,taskId:record.id,sessionId:record.sessionId,status:applied&&!record.cancelRequestedAt?'completed':taskDisplayStatus(record),applied,entryId:entry?.id??null,error,preparation:record.preparation??null,budget:record.budget,createdAt:record.createdAt,endedAt:record.endedAt??null,requests:requests.map(r=>({id:r.id,phase:r.phase,status:r.status,sent:r.sent,usage:r.usage??null})),usage:record.usage??null};
}
