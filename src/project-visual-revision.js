import {isDeepStrictEqual} from 'node:util';
import {readRequest,problem} from './task.js';
import {resolveDeliveryEvidence} from './project-delivery.js';
import {checkedVisualReview} from './visual-preview.js';
import {readVisualFrame} from './visual-project-delivery.js';
import {digest} from './project-collaboration-evidence.js';
import {validateCapturePlan} from './visual-supplement.js';

// This intent permits only new final visual evidence, never another file step.
// The original uncertain review and all accepted work remain authoritative history.
export function inspectVisualRevision({home,state,source,formalVersion,visualRevision},deps={}) {
  if(visualRevision===undefined)return false;
  const fail=()=>{throw problem('VISUAL_REVISION','Explicit final visual evidence is not bound to a completed uncertain review');};
  const intent=visualRevision;
  if(!intent||Object.keys(intent).some(k=>!['sourceRequestId','formalVersion','reason','capturePlan'].includes(k))||
    typeof intent.reason!=='string'||!intent.reason.trim()||intent.reason.length>2000||
    intent.formalVersion!==formalVersion||!intent.sourceRequestId)fail();
  (deps.validateCapturePlan??validateCapturePlan)(intent.capturePlan);
  if(!state.steps?.length||state.steps.some(s=>s.status!=='completed')||!source.deliveryRef||
    source.deliveryRef.version!==formalVersion||state.version!==formalVersion||
    state.delivery?.version!==formalVersion||state.delivery.revision!==state.revision||
    !source.localExecutionClosedAt||source.localExecutionCloseError||source.cancelRequestedAt)fail();
  const delivery=(deps.resolveDeliveryEvidence??resolveDeliveryEvidence)(home,source);
  const prior=state.delivery.visual;
  if(!delivery?.visualError||delivery.visualSource?.id!==source.id||!prior?.error||
    prior.taskId!==source.id||prior.requestId!==intent.sourceRequestId||
    prior.basis?.version!==formalVersion||prior.basis.revision!==state.revision||
    prior.basisDigest!==digest(prior.basis)||source.deliveryRef.visualDigest!==digest(prior))fail();
  const evidence=source.work?.visualEvidence?.find(e=>e.outputRef===prior.outputRef);
  const stage=source.stages?.find(s=>s.phase==='visual-review'&&s.callIds?.includes(prior.requestId));
  const claim=source.rootRequests?.find(c=>c.requestId===prior.requestId&&c.taskId===source.id&&c.stageId===stage?.id);
  const call=(deps.readRequest??readRequest)(home,source.id,prior.requestId);
  const submitted=call.response?.content?.filter(c=>c.type==='toolCall'&&c.name==='submit_visual_review');
  if(!evidence||evidence.result!=='captured'||!evidence.contentUnchanged||
    evidence.review?.verdict!=='uncertain'||!checkedVisualReview(evidence,formalVersion,true)||
    !stage||!claim||claim.notSent||claim.status!=='completed'||claim.sessionId!==stage.sessionId||
    call.taskId!==source.id||call.stageId!==stage.id||call.phase!=='visual-review'||call.status!=='completed'||
    !call.sent||!call.endedAt||!call.transport?.projectDispatched||
    call.actualModel?.provider!==source.frozenConfig.main.provider||call.actualModel?.modelId!==source.frozenConfig.main.modelId||
    call.visualEvidence?.digest!==prior.basisDigest||call.visualEvidence.outputRef!==prior.outputRef||
    !isDeepStrictEqual(call.visualEvidence.imageHashes,evidence.images.map(i=>i.sha256))||
    submitted?.length!==1||submitted[0].arguments?.verdict!=='uncertain'||
    submitted[0].arguments.observation!==evidence.review.observation||submitted[0].arguments.reasons!==evidence.review.reasons)fail();
  evidence.images.forEach((_,index)=>(deps.readVisualFrame??readVisualFrame)(home,source,prior.outputRef,index));
  return true;
}
