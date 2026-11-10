import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { finished, load, productRoot } from "./helpers/gui-controller-fixture.js";

export const sdkUrl=pathToFileURL(join(productRoot,"node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
export const {SessionManager}=await import(sdkUrl);
export const {createTeamConfig}=await load("src/teams.js");
export const {readTask}=await load("src/task.js");
export const checkedPlan=(goal='Observe project',checks=[{command:'node',args:['-e',"require('fs').accessSync('a.txt')"]}])=>({goal,scope:['a.txt'],readScope:['.'],deliverables:['a.txt'],checks});
export async function confirmProject(c,sessionId,submitted){
 const proposal=await finished(c,submitted.taskId);assert.equal(proposal.status,'blocked',proposal.error);
 const accepted=await c.action('task.confirmWork',{sessionId,submissionId:randomUUID(),proposalRef:proposal.proposalRef,protocolVersion:1});
 const root=await finished(c,accepted.taskId);assert.equal(root.status,'completed',root.error);
 return {taskId:accepted.taskId,task:await c.task(root.projectOperation.childTaskIds[0])};
}
