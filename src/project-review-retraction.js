export const reviewInstruction="Finish with JSON containing verdict (pass/reject/uncertain) and observation (specific candidate evidence or counterexample), no prose outside JSON. For rejection solely on absence of an exact literal, specify counterexample:{kind:'missing_text',path,text}; refute it with refutesRequestId and evidence:{path,quote} showing that literal. To explicitly withdraw YOUR OWN earlier rejection after feedback on the SAME candidate, return pass with retractsRequestId (exact rejection request ID) and retractionReason (why the objection was mistaken or is nonblocking). A plain pass, another reviewer or changed candidate cannot retract it. Preserve the old rejection; never claim unavailable checks or images were independently verified. Otherwise repair and re-review.";

// Only the original reviewer can withdraw its own completed objection. A new
// vote or an inferred interpretation of prose is not a withdrawal.
export function reviewerRetraction({verdict,receipt,prior,call,previous,calls}) {
  if(verdict.verdict!=='pass'||typeof verdict.retractsRequestId!=='string'||
    typeof verdict.retractionReason!=='string'||verdict.retractionReason.trim().length<8||
    prior?.verdict!=='reject'||prior.requestId!==verdict.retractsRequestId||
    prior.reviewTaskId!==receipt.reviewTaskId||prior.dispatchId!==receipt.dispatchId||
    prior.reviewer!==receipt.reviewer||prior.model!==receipt.model||
    prior.taskId!==receipt.taskId||prior.changeId!==receipt.changeId||prior.candidateVersion!==receipt.candidateVersion||
    !previous||previous.id!==prior.requestId||previous.taskId!==call.taskId||previous.role!==call.role||
    !previous.sent||previous.status!=='completed'||previous.response?.stopReason!=='stop'||
    call.phase!=='worker-feedback'||call.status!=='completed'||!call.sent||call.response?.stopReason!=='stop'||
    !call.projectSend?.sessionId||call.projectSend.sessionId!==previous.projectSend?.sessionId||
    call.projectSend.dispatchId!==receipt.dispatchId||previous.projectSend?.dispatchId!==receipt.dispatchId||
    call.projectSend.workId!==previous.projectSend.workId||
    !Number.isInteger(call.projectSend.feedback)||!Number.isInteger(previous.projectSend.feedback)||
    call.projectSend.feedback<=previous.projectSend.feedback||calls.indexOf(previous)>=calls.indexOf(call)||
    call.actualModel?.provider!==previous.actualModel?.provider||call.actualModel?.modelId!==previous.actualModel?.modelId)return null;
  try {const old=JSON.parse(previous.text);if(old.verdict!=='reject'||old.observation!==prior.observation)return null;}catch{return null;}
  return {requestId:call.id,priorRequestId:prior.requestId,sessionId:call.projectSend.sessionId,
    feedback:call.projectSend.feedback,reason:verdict.retractionReason};
}
