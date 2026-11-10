import {execution} from './helpers/agent-sync-fixture.js';
import { runProjectTurn, reserveConfirmation, executeConfirmed } from '../src/project-turn.js';

export const deliveryContext=record=>record.handoffContext;

// Keep the actual Pi session so automatic resume uses the same authority branch.
export async function projectSession(t,repo,f){
 const {createRuntime}=await import('../src/pi-runtime.js'),{cothinkExtension}=await import('../src/extensions/cothink.js');
 const host={allowWork:true,flow:'unified'},rt=await createRuntime({home:f.home,cwd:repo.project,modelRef:f.models.main,projectManaged:true,extensionFactories:[{name:'cothink',factory:cothinkExtension(host)}]});
 t.after(()=>rt.dispose());rt.hostContext=task=>{host.task=task;host.runtime=rt;};
 return {home:f.home,cwd:repo.project,workspace:{id:null,project:repo.project},frozenConfig:{formatVersion:2,...f.models,work:{execution}},mainRuntime:rt};
}
export async function confirmProject(base,source,extra={}){
 const reservation=await reserveConfirmation({home:base.home,source:source.record,proposalRef:source.record.proposalRef,sessionId:source.record.sessionId,workspaceId:null,submissionId:'confirm-'+source.record.id,save:source.save});
 return runProjectTurn({...base,input:source.record.input,taskId:reservation.taskId,submissionId:reservation.submissionId,budget:reservation.budgetSource.remaining,...extra,confirmedOperation:{source:source.record,reservation,execute:task=>executeConfirmed(task,source.record,reservation)}});
}
