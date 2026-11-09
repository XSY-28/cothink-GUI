import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {SessionManager,CURRENT_SESSION_VERSION} from '@earendil-works/pi-coding-agent';
import {problem,readTask,readRequests,taskDisplayStatus} from './task.js';
import {conversationTaskIds,sessionWriteIncomplete} from './conversation.js';
import {resolveDelivery} from './project-turn.js';
import {finalGuiText} from './gui-projection.js';

export const contextToolNames=['search_context','read_context','save_context_note'];
export const contextDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,message)=>problem(code,message);
const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(x=>x.type==='text').map(x=>x.text).join('\n'):'';
const page=(offset=0,limit=4000,max=16000)=>{
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>max)throw fail('CONTEXT_RANGE','Invalid bounded context page');
  return {offset,limit};
};
/** Strict reader: unlike writable SDK open, never skips a malformed/truncated line. */
export function readContextDisk(path,sessionId){
  const raw=readFileSync(path,'utf8');
  if(!raw.endsWith('\n'))throw fail('CONTEXT_STORAGE','Session tail is incomplete; original bytes retained');
  const lines=raw.split('\n');lines.pop();
  if(lines.some(l=>!l.trim()))throw fail('CONTEXT_STORAGE','Empty session record');
  const entries=lines.map(l=>JSON.parse(l)),header=entries[0],ids=new Set();
  if(header?.type!=='session'||header.id!==sessionId||header.version!==CURRENT_SESSION_VERSION)throw fail('CONTEXT_STORAGE','Session identity/version mismatch');
  for(const e of entries.slice(1)){
    if(typeof e.id!=='string'||!e.id||ids.has(e.id)||e.type==='session'||(e.parentId!==null&&!ids.has(e.parentId)))throw fail('CONTEXT_STORAGE','Invalid session ancestry or duplicate record');
    ids.add(e.id);
  }
  return SessionManager.inMemory(header.cwd,undefined,entries);
}
export function contextSnapshot(manager){
  const entries=structuredClone(manager.getEntries()),branch=manager.getBranch();
  return {sessionId:manager.getSessionId(),sourceLeaf:manager.getLeafId(),entryIds:branch.map(e=>e.id),entriesDigest:contextDigest(entries),entryCount:entries.length,branchDigest:contextDigest(branch)};
}
export function assertContextSource(snapshot,manager){
  if(snapshot.sessionId!==manager.getSessionId()||snapshot.sourceLeaf!==manager.getLeafId()||snapshot.entriesDigest!==contextDigest(manager.getEntries())||snapshot.branchDigest!==contextDigest(manager.getBranch()))throw fail('CONTEXT_SOURCE_CHANGED','Context source changed; current branch retained');
}
export function contextState(manager){
  const entry=manager.getBranch().findLast(e=>e.type==='compaction');
  return {automaticCompression:false,sourceLeaf:manager.getLeafId(),summary:entry?{entryId:entry.id,operationId:entry.details?.cothinkContext?.taskId??null,derived:true,tokensBeforeEstimate:entry.tokensBefore??null}:null};
}
/** Prove SDK fork ancestry from stored bytes, never from a marker's claimed session ID. */
function contextLineage(home,manager){
  const lineage=new Map([[manager.getSessionId(),manager.getBranch()]]);
  let child=manager,selected=manager.getBranch();
  while(child.getHeader()?.parentSession){
    const path=child.getHeader().parentSession;
    let parent;
    try{
      const directory=realpathSync(join(home,'pi/sessions/main'));
      if(typeof path!=='string'||!isAbsolute(path))throw Error('Invalid parent path');
      const actual=realpathSync(path);
      if(dirname(actual)!==directory||!actual.endsWith('.jsonl'))throw Error('Parent is outside session storage');
      const header=JSON.parse(readFileSync(actual,'utf8').split('\n')[0]);
      if(!/^[0-9a-f-]{36}$/.test(header?.id)||lineage.has(header.id))throw Error('Invalid or cyclic parent identity');
      parent=readContextDisk(actual,header.id);
      if(realpathSync(parent.getCwd())!==realpathSync(child.getCwd()))throw Error('Parent belongs to another project directory');
    }catch(error){throw fail('CONTEXT_SOURCE','Cannot verify stored SDK fork parent: '+error.message);}
    const inherited=[];
    for(const entry of selected){if(!parent.getEntry(entry.id))break;inherited.push(entry);}
    if(selected.slice(inherited.length).some(entry=>parent.getEntry(entry.id)))throw fail('CONTEXT_SOURCE','Fork inherited entries are not a selected prefix');
    if(!inherited.length){lineage.set(parent.getSessionId(),[]);break;}
    const original=parent.getBranch(inherited.at(-1).id);
    if(contextDigest(inherited)!==contextDigest(original)){
      // Public SDK branching removes/recreates labels and rechains parent IDs.
      // Reuse that exact transformation in memory; never rewrite either file.
      const normalized=SessionManager.inMemory(parent.getCwd(),undefined,[parent.getHeader(),...parent.getEntries()]);
      normalized.createBranchedSession(inherited.at(-1).id);
      if(contextDigest(inherited)!==contextDigest(normalized.getBranch().filter(entry=>entry.type!=='label')))throw fail('CONTEXT_SOURCE','Fork inherited content differs from its selected source branch');
    }
    lineage.set(parent.getSessionId(),inherited);
    selected=original;child=parent;
  }
  return lineage;
}
/** Only readable branch material. Request bodies, tools, auth and filesystem paths are never sources. */
export function createContextAccess({home,manager,getTask,assertOwned,quarantine}){
  const catalog=()=>{
    const branch=manager.getBranch(),sessionId=manager.getSessionId(),items=[];
    const lineage=contextLineage(home,manager);
    const add=(kind,id,field,text,extra={})=>{
      if(!text)return;const ref={sessionId,kind,id,field,sha256:contextDigest(text)};
      items.push({sourceId:contextDigest(ref),ref,kind,...extra,text});
    };
    for(const e of branch){
      if(e.type==='message'&&['user','assistant'].includes(e.message?.role))add(e.message.role,e.id,'text',textOf(e.message.content));
      if(e.type==='custom'&&e.customType==='cothink-context-note'){
        const n=e.data;if(typeof n?.text!=='string'||!Array.isArray(n.sources)||n.sourceDigest!==contextDigest(n.sources)||!branch.slice(0,branch.indexOf(e)).some(x=>x.id===n.sourceLeaf))throw fail('CONTEXT_NOTE','Context note provenance is invalid');
        add('note',e.id,'text',n.text,{derived:true,author:n.author,sources:n.sources,label:n.sources.length?'派生记要':'当前模型建议'});
      }
      if(e.type==='compaction')add('summary',e.id,'summary',e.summary,{derived:true,label:'派生摘要',provenance:{firstKeptEntryId:e.firstKeptEntryId,source:e.details?.cothinkContext??null}});
    }
    for(const id of conversationTaskIds(manager)){
      const record=getTask?.()?.record.id===id?getTask().record:readTask(home,id);
      if(!lineage.has(record.sessionId)||!conversationTaskIds({getBranch:()=>lineage.get(record.sessionId)}).includes(id))throw fail('CONTEXT_SOURCE','Task session does not match the current branch or its saved fork lineage');
      // Membership also requires the saved session/fork lineage, not only a model-supplied ID.
      add('task',id,'input',record.input);
      if(record.deliveryRef)resolveDelivery(home,record);
      if(record.status==='completed')add('task',id,'delivery',finalGuiText(record,readRequests(home,record),home));
      if(record.executionBinding&&record.deliveryRef)add('task',id,'project-facts',JSON.stringify({projectId:record.deliveryRef.projectId,revision:record.deliveryRef.revision,version:record.deliveryRef.version,checks:record.deliveryRef.checksRef}),{derived:false});
    }
    return items;
  };
  const resolve=ref=>{
    if(!ref||typeof ref!=='object'||Object.keys(ref).sort().join(',')!=='field,id,kind,sessionId,sha256')throw fail('CONTEXT_SOURCE','Use a host-issued context reference');
    const item=catalog().find(x=>['kind','id','field','sha256'].every(key=>x.ref[key]===ref[key]));
    let permitted=ref.sessionId===manager.getSessionId();
    if(!permitted){
      const prefix=contextLineage(home,manager).get(ref.sessionId)??[];
      permitted=ref.kind==='task'?conversationTaskIds({getBranch:()=>prefix}).includes(ref.id)&&readTask(home,ref.id).sessionId===ref.sessionId:prefix.some(e=>e.id===ref.id);
    }
    if(!item||!permitted)throw fail('CONTEXT_SOURCE','Source is not on the current branch or its content changed');
    return item;
  };
  return {
    freeze(){
      // Use the public effective projection: summarized or context-edited-away text
      // must not be silently expanded into a fresh executor's context.
      const sources=catalog(),materials=[];
      for(const {sourceEntry,messages} of manager.buildSessionProjection().entries){
        for(const message of messages){
          const kind=message.role==='compactionSummary'?'summary':message.role;
          if(!['user','assistant','summary'].includes(kind))continue;
          const original=sources.find(item=>item.ref.id===sourceEntry.id&&item.kind===kind);
          const text=kind==='summary'?message.summary:textOf(message.content);
          if(!original||!text)continue;
          const ref={...original.ref,sha256:contextDigest(text)};
          materials.push({...original,ref,sourceId:contextDigest(ref),text,role:kind,
            ...(text!==original.text?{projection:{originalRef:original.ref,derived:true}}:{})});
        }
      }
      return {source:contextSnapshot(manager),materials:structuredClone(materials)};
    },
    search({query='',offset=0,limit=20}={}){
      page(offset,limit,50);if(typeof query!=='string'||query.length>500)throw fail('CONTEXT_RANGE','Query too long');
      const items=catalog().filter(x=>x.text.toLowerCase().includes(query.toLowerCase()));
      return {scope:'current-branch',sourceLeaf:manager.getLeafId(),items:items.slice(offset,offset+limit).map(({text,...item})=>({...item,snippet:text.slice(Math.max(0,text.toLowerCase().indexOf(query.toLowerCase())-60),Math.max(0,text.toLowerCase().indexOf(query.toLowerCase())-60)+320)})),nextOffset:offset+limit<items.length?offset+limit:null};
    },
    read({ref,offset=0,limit=4000}){page(offset,limit);const {text,...item}=resolve(ref);return {...item,offset,text:text.slice(offset,offset+limit),total:text.length,nextOffset:offset+limit<text.length?offset+limit:null};},
    save({text,sources}){
      const task=getTask?.();assertOwned();
      if(!task||task.signal.aborted||task.record.status!=='running'||task.ioError)throw fail('TASK_ENDED','No active context-note author');
      if(typeof text!=='string'||!text.trim()||text.length>16000||!Array.isArray(sources)||sources.length>32)throw fail('CONTEXT_NOTE','A bounded note and source list are required');
      const checked=sources.map(ref=>resolve(ref).ref),sourceLeaf=manager.getLeafId();
      if(!sourceLeaf)throw fail('CONTEXT_NOTE','No source branch');
      const data={text,sources:checked,author:{taskId:task.record.id,role:'main',model:task.record.models.main},taskId:task.record.id,sourceLeaf,sourceDigest:contextDigest(checked),derived:true};
      try{const id=manager.appendCustomEntry('cothink-context-note',data);const disk=readContextDisk(manager.getSessionFile(),manager.getSessionId());if(contextDigest(disk.getEntry(id))!==contextDigest(manager.getEntry(id)))throw fail('CONTEXT_STORAGE','Note write was not confirmed');return {saved:true,...resolve({sessionId:manager.getSessionId(),kind:'note',id,field:'text',sha256:contextDigest(text)})};}
      catch(error){quarantine(error);throw error;}
    },
  };
}

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
    stage=task.beginPhase('context-summary','main',task.record.models.main);runtime.bindTask(task,stage);
    check();
    unsubscribe=runtime.onContextPreparation(event=>{
      try{
        check();if(event.reason!=='manual'||event.willRetry||event.signal.aborted||contextDigest(event.branchEntries)!==snapshot.branchDigest)throw fail('CONTEXT_SOURCE_CHANGED','Preparation no longer matches source');
        const p=event.preparation,expectedCalls=p.isSplitTurn&&p.turnPrefixMessages.length?(p.messagesToSummarize.length?2:1):1;
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
