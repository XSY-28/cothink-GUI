import {randomUUID} from 'node:crypto';
import {problem} from './task.js';
import {inScope} from './versioning.js';
import {sha} from './visual-browser.js';
import {MAX_PNG} from '../scripts/visual-preview.mjs';
const fail=message=>{throw problem('VISUAL_CAPTURE',message);};
export function validateCapturePlan(plan){
 if(!Array.isArray(plan)||!plan.length||plan.length>4)fail('Use 1..4 explicit capture scripts');
 return plan.map(row=>{
  if(!row||Object.keys(row).sort().join(',')!=='args,label,script'||typeof row.script!=='string'||
   !/^[a-zA-Z0-9_./-]+\.(?:js|cjs|mjs)$/.test(row.script)||row.script.startsWith('/')||
   row.script.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git')||row.script.length>512||
   typeof row.label!=='string'||!row.label.trim()||row.label.length>200||row.label.includes('\0')||
   !Array.isArray(row.args)||row.args.length>12||row.args.some(a=>typeof a!=='string'||a.length>500||/[\0\r\n]/.test(a)||a.includes('://')||/(^|[=,])\//.test(a)||a.split(/[=,\/]/).includes('..')))fail('Invalid explicit capture script or arguments');
  return {script:row.script,args:[...row.args],label:row.label};
 });
}
export function purePng(bytes){
 if(bytes.length<33||bytes.length>MAX_PNG||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return false;
 let at=8,first=true;
 while(at+12<=bytes.length){const length=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);
  if(length>MAX_PNG||at+length+12>bytes.length||first&&(type!=='IHDR'||length!==13))return false;
  if(first&&(bytes.readUInt32BE(at+8)>8192||bytes.readUInt32BE(at+12)>8192))return false;
  first=false;at+=length+12;if(type==='IEND')return length===0&&at===bytes.length;
 }return false;
}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function output(v,ref){let offset=0;const chunks=[];for(let i=0;i<1024;i++){
 const page=await v.read({outputRef:ref,offset});const bytes=Buffer.from(page.contentBase64,'base64');chunks.push(bytes);
 if(chunks.reduce((n,b)=>n+b.length,0)>MAX_PNG)fail('Capture exceeds image bound');
 if(page.eof)return Buffer.concat(chunks);if(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=offset)fail('Invalid capture output pagination');offset=page.nextOffset;
 }fail('Capture output did not terminate');}
/** Executes only the separately frozen host plan in the existing offline projection. */
export async function captureSupplement({versioning,change,plan,version,scope,signal,guard,record=()=>{}}){
 const result=[];
 for(const item of validateCapturePlan(plan)){
  guard();if(!inScope(item.script,scope))fail('Capture script is outside approved read scope');
  const before=await versioning.inspect({fromVersion:version,toVersion:change.privateVersion});
  if(!Array.isArray(before.files)||before.files.length||before.text||before.binaryFiles?.length)fail('Capture input differs from formal version');
  const requestId=randomUUID(),stderr='/tmp/cothink-visual-'+requestId+'.log';
  const input={requestId,expectedVersion:change.privateVersion,timeoutMs:240000,
   command:['node',quote(item.script),...item.args.map(quote)].join(' ')+' 2>'+quote(stderr)};
  record({requestId,changeId:change.changeId,input,status:'running'});
  let receipt;try{receipt=await versioning.exec(change.changeId,input,{signal});}
  catch(error){record({requestId,changeId:change.changeId,input,status:'unknown',error:error.message});throw error;}
  record({requestId,changeId:change.changeId,input,receipt,status:receipt.status});guard();
  if(receipt.requestId!==requestId||receipt.status!=='completed'||receipt.exitCode!==0||
   !Array.isArray(receipt.changedFiles)||receipt.changedFiles.length||!receipt.privateVersion||receipt.outputRef!==requestId)fail('Capture did not complete without source changes');
  const diff=await versioning.inspect({fromVersion:version,toVersion:receipt.privateVersion});
  if(!Array.isArray(diff.files)||diff.files.length||diff.text||diff.binaryFiles?.length)fail('Capture changed formal source');
  const bytes=await output(versioning,receipt.outputRef);if(!purePng(bytes))fail('Capture output is not one bounded pure PNG');
  change.privateVersion=receipt.privateVersion;
  result.push({label:item.label,requestId,sourceVersion:version,privateVersion:receipt.privateVersion,
   sha256:sha(bytes),data:bytes.toString('base64'),stderrRef:stderr});
 }return result;
}

// verifyDelivery has just rebuilt these host receipts at this exact formal tip.
// Keep their narrow scope: a passed command is not proof of every user requirement.
export function visualVerificationLayers(state){
 const d=state.delivery,version=d.version;
 const checks=(d.requestIds??[]).map(id=>{
  const fact=state.finalChecks?.find(r=>r.requestId===id&&r.revision===state.revision)?.check??
   state.steps.flatMap(s=>s.attempts??[]).find(a=>a.check?.requestId===id)?.check;
  if(!fact||fact.version!==version||fact.binding?.version!==version||fact.status!=='passed'||fact.verification!=='passed')fail('Final check layer is not bound to this version');
  return {requestId:id,version,status:'passed',checks:(fact.checks??[]).map(c=>({command:c.command,args:c.args,exitCode:c.exitCode,sourceChanged:c.sourceChanged}))};
 });
 const independentReviews=(d.reviewReceipts??[]).filter(r=>r.certified===true&&r.verdict==='pass').map(r=>({
  requestId:r.requestId,taskId:r.reviewTaskId,candidateVersion:r.candidateVersion,observedIdentity:r.observedIdentity,certified:true,verdict:'pass'}));
 return {source:'Host delivery verification, separate from image interpretation',version,fixedChecks:checks,independentReviews,
  limits:'These are completed checks and independent code reviews verified by the host, not visual judgments or exhaustive proof of all functionality. Assess visible appearance and visible interaction; do not re-demand source-only or workflow facts from PNGs.'};
}

export async function closeVisualProjection(versioning,change,receipt){
 if(!change||receipt.projectionClose?.status==='abandoned')return;
 if(receipt.cleanupError)fail(receipt.cleanupError);
 const requestId=randomUUID();receipt.projectionClose={requestId,changeId:change.changeId,status:'pending'};
 try{
  const fact=await versioning.abandonChange(change.changeId,{requestId});
  receipt.projectionClose={...fact,requestId,changeId:change.changeId};
  if(fact.status!=='abandoned')fail('Visual projection did not close');
 }catch(error){receipt.cleanupError=error.message;throw error;}
}
