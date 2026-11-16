import {problem} from './task.js';
import {digest} from './project-collaboration-evidence.js';
function reservationIdentity(value) {
  if(!value)return null;
  const {status,consumedByTaskId,...identity}=value;return identity;
}
export function isContinuationReservation(source,reservation) {
  return reservation?.continuation?.sourceRootTaskId===source.id&&
    ['reserved','consumed'].includes(reservation.status)&&
    /^[\da-f-]{36}$/.test(reservation.taskId)&&/^[\da-f-]{36}$/.test(reservation.commandId)&&
    (!source.fileContinuationIntent?.consumedByTaskId||source.fileContinuationIntent.consumedByTaskId===reservation.taskId)&&
    digest(reservationIdentity(source.fileContinuationIntent))===digest(reservationIdentity(reservation));
}

export function assertContinuationIntents(source,{routeRevision,visualRevision}) {
  for(const [key,value] of Object.entries({routeRevision,visualRevision}))
    if(digest(value??null)!==digest(source.fileContinuationIntent.continuation[key]??null))
      throw problem('CONTINUATION_AUTH','Reserved continuation intent cannot change');
}

export function assertConfirmedProjectState(proposal,{repo,version,state,expectedRevision}) {
  if(proposal.canonicalRepo!==repo||proposal.version!==version||(state?.revision??null)!==(expectedRevision??null))
    throw problem("PROPOSAL_STALE","Confirmed project version/revision changed before dispatch");
  if(proposal.reuseCompletedDelivery&&!(state?.status==="completed"&&state.delivery&&state.delivery.version===state.version&&state.delivery.revision===state.revision))
    throw problem("PROPOSAL_STALE","已交付状态已变化，无法只沿用已有成果。请重新核对。");
}
