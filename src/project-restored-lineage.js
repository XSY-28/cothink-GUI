import {isDeepStrictEqual} from 'node:util';
import {readTask,problem} from './task.js';
import {inScope} from './versioning.js';

const same=(a,b)=>a?.sessionId===b?.sessionId&&a?.workspace?.id===b?.workspace?.id&&
  a?.workspace?.project===b?.workspace?.project&&a?.projectOperation?.projectId===b?.projectOperation?.projectId;
const closed=r=>!!r.localExecutionClosedAt&&!r.localExecutionCloseError&&
  (!r.cancelRequestedAt||!!r.cancelSettledAt)&&!['running','cancelling','stop_unknown'].includes(r.status);
const reject=()=>{throw problem('PROCESS_RESTORED_SOURCE','Restored worker lineage is not verified');};

// A bounded identity discovery only. No contribution is counted until the public
// receipts and unchanged worker bytes are checked after actual acceptance.
export function restoredWorkerLineage(home,root,child,member,{read=readTask}={}) {
  if(!home||!root.sessionId||!root.workspace?.project||!root.projectOperation?.projectId||member.status!=='completed'||!member.collected||!member.scope?.length)return null;
  try {
    const hops=[],seen=new Set();let cursor=root;
    for(let depth=0;depth<64;depth++) {
      if(seen.has(cursor.id))return null;seen.add(cursor.id);
      const link=cursor.projectOperation?.continuation,draft=link?.draft;
      if(!draft||!link.sourceRootTaskId)return null;
      const previous=read(home,link.sourceRootTaskId),selected=read(home,draft.taskId);
      const reservation=previous.fileContinuationIntent;
      if(!same(root,previous)||!closed(previous)||!closed(selected)||
        selected.rootTaskId!==previous.id||!selected.sessionId||selected.sessionId===root.sessionId||
        selected.project?.commandId!==previous.projectOperation.commandId||
        !previous.projectOperation?.childTaskIds?.includes(selected.id)||
        selected.project?.projectId!==root.projectOperation.projectId||selected.project?.stepId!==link.stepId||
        reservation?.taskId!==cursor.id||reservation.commandId!==cursor.projectOperation.commandId||
        !isDeepStrictEqual(reservation.continuation?.draft,draft))return null;
      const change=selected.work?.changes?.find(c=>c.changeId===draft.changeId);
      if(!change||change.privateVersion!==draft.version||change.baseVersion!==draft.baseVersion)return null;
      const ownsScope=member.scope.every(path=>inScope(path,change.scope));
      if(draft.taskId===child.id&&draft.changeId===member.changeId&&draft.version===member.rootReviewedVersion) {
        if(previous.id!==child.rootTaskId||!ownsScope)return null;
        return {draft,hops};
      }
      if(!ownsScope&&(!member.scope.every(path=>inScope(path,selected.project.readScope??[]))||
        !selected.work.acceptance?.some(a=>a.status==='accepted'&&a.acceptedVersion===change.baseVersion&&a.changeId!==change.changeId)))return null;
      if(!(change.actor==='main'||change.actor==='result'&&change.readOnly&&change.changeId===selected.work.resultChangeId)||!selected.work.restoreRequestId||
        !isDeepStrictEqual(selected.project?.continuation,previous.projectOperation?.continuation))return null;
      hops.push({rootId:previous.id,taskId:selected.id,changeId:change.changeId,version:draft.version,
        baseVersion:change.baseVersion,scope:change.scope,readScope:selected.project.readScope??[],
        readOnly:!!change.readOnly,resultChangeId:selected.work.resultChangeId,changes:selected.work.changes,
        input:structuredClone(previous.projectOperation.continuation.draft),restoreRequestId:selected.work.restoreRequestId,
        acceptance:selected.work.acceptance??[],requests:selected.work.requests});
      cursor=previous;
    }
  } catch { return null; }
  return null;
}

export async function verifyRestoredWorkerLineage(versioning,lineage,member) {
  if(!lineage?.draft||!Array.isArray(lineage.hops)||lineage.hops.length>=64)reject();
  for(const hop of lineage.hops) {
    if(!hop.requests?.some(r=>r.requestId===hop.restoreRequestId&&r.action==='beginChange'&&r.dispatched&&r.status==='open'))reject();
    const receipt=await versioning.inspect({requestId:hop.restoreRequestId});
    if(receipt.actor!=='main'||receipt.status!=='open'||receipt.baseVersion!==hop.input.baseVersion||!receipt.privateVersion||
      !member.scope.every(path=>inScope(path,[...(receipt.scope??[]),...(receipt.readScope??[])])))reject();
    const versions=[hop.input.version,receipt.privateVersion,hop.version];
    if(receipt.changeId!==hop.changeId) {
      // A new main draft may inherit unchanged worker bytes through the exact
      // publicly accepted predecessor, without claiming write access to them.
      if(!member.scope.every(path=>inScope(path,hop.readScope)))reject();
      let current=receipt.baseVersion,first=true;const seen=new Set(),chain=[];
      while(current!==hop.baseVersion) {
        if(chain.length>=128||seen.has(current))reject();seen.add(current);
        const rows=(hop.acceptance??[]).filter(a=>a.status==='accepted'&&a.expectedTip===current);
        if(rows.length!==1)reject();const row=rows[0];
        if(first&&row.changeId!==receipt.changeId||!row.candidateVersion||!row.acceptedVersion||
          !hop.requests.some(r=>r.action==='acceptChange'&&r.dispatched&&r.status==='accepted'&&r.requestId===row.requestId&&r.changeId===row.changeId))reject();
        const owned=hop.changes?.find(c=>c.changeId===row.changeId);
        if(!owned||owned.actor!=='main'||owned.readOnly)reject();
        const accepted=await versioning.inspect({requestId:row.requestId});
        const change=await versioning.inspect({changeId:row.changeId});
        if(accepted.status!=='accepted'||accepted.verification!=='passed'||accepted.changeId!==row.changeId||
          accepted.candidateVersion!==row.candidateVersion||accepted.acceptedVersion!==row.acceptedVersion||accepted.expectedTip!==current||
          change.changeId!==row.changeId||change.status!=='accepted'||change.actor!=='main'||change.readOnly||
          !['stopped','absent'].includes(change.executionState)||change.baseVersion!==current||change.acceptedVersion!==row.acceptedVersion)reject();
        versions.push(accepted.candidateVersion,accepted.acceptedVersion);chain.push(row.requestId);
        current=accepted.acceptedVersion;first=false;
      }
      if(!chain.length)reject();
      const begins=hop.requests.filter(r=>r.action==='beginChange'&&r.dispatched&&r.status==='open');
      if(begins.length>128)reject();let next;
      for(const begin of begins){const value=await versioning.inspect({requestId:begin.requestId});if(value.changeId===hop.changeId){next=value;break;}}
      if(!next||!(next.actor==='main'||next.actor==='result'&&next.readOnly&&next.changeId===hop.resultChangeId)||next.status!=='open'||!!next.readOnly!==hop.readOnly||next.baseVersion!==current||
        !next.privateVersion||!member.scope.every(path=>inScope(path,[...(next.scope??[]),...(next.readScope??[])])))reject();
      versions.push(next.privateVersion);
      hop.acceptanceRequestId=chain[0];hop.acceptanceRequestIds=chain;
    } else if(!member.scope.every(path=>inScope(path,hop.scope)))reject();
    for(const version of versions) {
      const diff=await versioning.inspect({fromVersion:lineage.draft.version,toVersion:version});
      if(!Array.isArray(diff.files)||diff.files.some(path=>inScope(path,member.scope)))reject();
    }
  }
  return lineage;
}
