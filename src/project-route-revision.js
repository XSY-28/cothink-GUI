import {isDeepStrictEqual as equal} from 'node:util';
import {readTask,problem} from './task.js';
import {inScope} from './versioning.js';
const reject=()=>{throw problem('PROJECT_ROUTE_REVISION','Explicit revision must bind a new failed check and its exact saved candidate');};
/** A user-confirmed new diagnosis, never another automatic repair attempt. */
export async function revisedFailureRoute({home,state,source,step,versioning:v,draft,routeRevision:intent}) {
  if(intent===undefined)return null;
  const route=step.route,recheck=route?.recheck;
  if(!intent||Object.keys(intent).sort().join(',')!=='candidate,reason,sourceRequestId'||
    typeof intent.reason!=='string'||intent.reason.trim().length<8||intent.reason.length>2000||
    route?.status!=='blocked'||route.kind!=='failed'||!route.edit||!route.judgmentCall||
    route.projectId!==state.id||route.stepId!==step.id||route.revision!==step.revision||
    !recheck?.candidate||intent.candidate!==recheck.candidate||intent.sourceRequestId!==recheck.evidence?.requestId||
    recheck.candidate===route.candidate||intent.sourceRequestId===route.evidence?.requestId||
    draft?.taskId!==route.taskId||draft.changeId!==route.changeId||
    step.routeHistory?.some(r=>r.routeRevision?.sourceRequestId===intent.sourceRequestId))reject();
  const record=readTask(home,route.taskId),attempt=step.attempts.find(a=>a.taskId===record.id);
  if(record.rootTaskId!==source.id||attempt?.rootTaskId!==source.id||!source.localExecutionClosedAt||!record.localExecutionClosedAt||
    source.localExecutionCloseError||record.localExecutionCloseError||source.cancelRequestedAt||
    record.project?.id!==state.id||record.project.stepId!==step.id||
    !equal(record.project.scope,step.scope)||!equal(record.project.checks,step.checks)||
    !record.work.requests.some(r=>r.requestId===intent.sourceRequestId&&r.action==='prepareChange'&&r.changeId===route.changeId&&r.dispatched&&r.status==='prepared')||
    !record.tools.some(t=>t.requestId===route.edit.requestId&&t.changeId===route.changeId&&t.kernelDispatched===true&&t.status==='completed'))reject();
  const receipt=await v.inspect({requestId:intent.sourceRequestId});
  const candidate=receipt.candidates?.find(c=>c.candidateVersion===intent.candidate),check=candidate?.precheck;
  if(receipt.changeId!==route.changeId||receipt.actor!=='main'||receipt.readOnly||
    candidate?.privateVersion!==draft.version||receipt.baseVersion!==draft.baseVersion||
    check?.status!=='check_failed'||check.binding?.candidateVersion!==intent.candidate||
    record.project.checkPolicy&&check.binding.policy!==record.project.checkPolicy.digest||
    !equal(check.checks,recheck.evidence.checks)||!check.checks.length||check.checks.length>step.checks.length||
    !check.checks.some(c=>Number.isInteger(c.exitCode)&&c.exitCode!==0)||check.checks.some((c,i)=>
      c.sourceChanged!==false||c.command!==step.checks[i].command||!equal(c.args??[],step.checks[i].args??[])))reject();
  const edited=await v.inspect({requestId:route.edit.requestId});
  if(edited.status!=='applied'||edited.privateVersion!==draft.version||
    edited.changeId!==undefined&&edited.changeId!==route.changeId||edited.actor!==undefined&&edited.actor!=='main'||!edited.files?.length||
    edited.files.some(p=>!inScope(p,route.judgment.repairScope)))reject();
  const same=await v.inspect({fromVersion:intent.candidate,toVersion:draft.version});
  const changed=await v.inspect({fromVersion:route.candidate,toVersion:draft.version});
  if(same.files.length||same.binaryFiles?.length||!changed.files.length)reject();
  return {projectId:state.id,revision:step.revision,stepId:step.id,kind:'failed',status:'paused',
    taskId:record.id,changeId:draft.changeId,actor:'main',candidate:intent.candidate,privateVersion:draft.version,
    evidence:structuredClone(recheck.evidence),at:recheck.at,routeRevision:structuredClone(intent)};
}
