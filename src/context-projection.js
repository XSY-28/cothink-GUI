import {createHash} from 'node:crypto';
import { readFileSync } from 'node:fs';
import {SessionManager,CURRENT_SESSION_VERSION} from '@earendil-works/pi-coding-agent';
import { problem, readTask, readRequest } from './task.js';

export const contextToolNames=['search_context','read_context','save_context_note'];
export const contextDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const fail=(code,message)=>problem(code,message);
export const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(x=>x.type==='text').map(x=>x.text).join('\n'):'';
export const page=(offset=0,limit=4000,max=16000)=>{
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>max)throw fail('CONTEXT_RANGE','Invalid bounded context page');
  return {offset,limit};
};

/** One conversation view for ordinary requests, formal handoff and explicit summaries. */
export function buildConversationProjection(home,manager,{projection=manager.buildSessionProjection(),liveFrom}={}){
  const branch=manager.getBranch(),index=liveFrom===null?-1:branch.findIndex(e=>e.id===liveFrom);
  const live=liveFrom!==undefined&&(liveFrom===null||index!==-1)?new Set(branch.slice(index+1).map(e=>e.id)):new Set();
  const taskAfterUser=new Map(branch.flatMap((entry,i)=>entry.message?.role==='user'&&branch[i+1]?.customType==='cothink-task'?
    [[entry.id,branch[i+1].data?.taskId]]:[]));
  const records=new Map(),adopted=new Set();
  const taskRecord=id=>{
    if(!records.has(id))records.set(id,readTask(home,id));
    return records.get(id);
  };
  const entries=projection.entries.map(({sourceEntry,messages})=>({sourceEntry,messages:messages.flatMap(message=>{
    if(live.has(sourceEntry.id))return [message];
    if(message.role==='user'){
      const id=taskAfterUser.get(sourceEntry.id);
      if(id&&message.content===sourceEntry.message?.content&&textOf(message.content).startsWith('[Original user input, verbatim]\n/skill:')){
        try{
          const input=taskRecord(id).input;
          if(input.startsWith('/skill:')&&textOf(message.content).startsWith('[Original user input, verbatim]\n'+input+'\n\n[Explicitly selected frozen skill;')){
            const images=Array.isArray(message.content)?message.content.filter(block=>block.type==='image'):[];
            return [{...message,content:[{type:'text',text:input},...images]}];
          }
        }catch{ /* Leave the original entry available when its old task is unavailable. */ }
      }
      return [message];
    }
    if(['compactionSummary','branchSummary'].includes(message.role))return [message];
    if(message.role!=='assistant')return [];
    const raw=sourceEntry.message,taskId=raw?.cothinkTaskId;
    if(taskId){
      try{
        const record=taskRecord(taskId);
        if(record.status!=='completed')return [];
        if(raw.cothinkDeliveryReport){
          const ref=record.managerFinal;
          if(!ref||ref.entryId!==sourceEntry.id||ref.displayId!==raw.cothinkMessageId||
            ref.textDigest!==contextDigest(textOf(raw.content))||
            raw.cothinkDeliveryReport!==contextDigest([ref.taskId,ref.callId,record.deliveryRef?.version]))return [];
        }else{
          if(record.projectOperation||!record.finalCallId)return [];
          const call=readRequest(home,taskId,record.finalCallId);
          if(call.status!=='completed'||call.role!=='main'||call.displayId!==raw.cothinkMessageId||contextDigest(call.text)!==contextDigest(textOf(raw.content)))return [];
        }
        if(adopted.has(raw.cothinkMessageId))return [];
        adopted.add(raw.cothinkMessageId);
      }catch{ return []; } // A damaged process record cannot block a different turn.
    }else if(raw?.content?.some?.(block=>block.type==='toolCall')||['aborted','error','length','toolUse'].includes(raw?.stopReason))return [];
    const content=Array.isArray(message.content)?message.content.filter(block=>block.type==='text'):message.content;
    return textOf(content)?[{...message,content}]:[];
  })}));
  return {...projection,entries,messages:entries.flatMap(entry=>entry.messages)};
}
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
