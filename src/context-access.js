import {readFileSync,realpathSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { readTask, readRequest } from './task.js';
import { conversationMaterialRefs, conversationTaskIds } from './conversation.js';
import { digest } from "./project-collaboration-evidence.js";
import { resolveDeliveryEvidence, resolveManagerFinal, resolveOwnedTasks } from "./project-delivery.js";
import { buildConversationProjection, contextDigest, contextSnapshot, fail, page, readContextDisk, textOf } from "./context-projection.js";

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
  const catalog=({includeTasks=true}={})=>{
    const branch=manager.getBranch(),sessionId=manager.getSessionId(),items=[];
    const lineage=contextLineage(home,manager);
    const add=(kind,id,field,text,extra={})=>{
      if(!text)return;const ref={sessionId,kind,id,field,sha256:contextDigest(text)};
      items.push({sourceId:contextDigest(ref),ref,kind,...extra,text});
    };
    const attachmentRefs=conversationMaterialRefs(manager);
    const raw={entries:branch.map(sourceEntry=>({sourceEntry,messages:sourceEntry.type==='message'&&sourceEntry.message?[sourceEntry.message]:[]}))};
    const approved=new Map(buildConversationProjection(home,manager,{projection:raw}).entries.map(({sourceEntry,messages})=>[sourceEntry.id,messages]));
    for(const e of branch){
      if(e.type==='message'&&['user','assistant'].includes(e.message?.role)){
        const attached=attachmentRefs.filter(ref=>ref.userEntryId===e.id);
        const message=approved.get(e.id)?.find(candidate=>candidate.role===e.message.role);
        if(message)add(e.message.role,e.id,'text',textOf(message.content),{
          ...(attached.length?{attachmentRefs:attached}:{}),
          ...(e.message.cothinkTaskId?{taskId:e.message.cothinkTaskId}:{}),
        });
      }
      if(e.type==='custom'&&e.customType==='cothink-context-note'){
        const n=e.data;if(typeof n?.text!=='string'||!Array.isArray(n.sources)||n.sourceDigest!==contextDigest(n.sources)||!branch.slice(0,branch.indexOf(e)).some(x=>x.id===n.sourceLeaf))throw fail('CONTEXT_NOTE','Context note provenance is invalid');
        add('note',e.id,'text',n.text,{derived:true,author:n.author,sources:n.sources,label:n.sources.length?'派生记要':'当前模型建议'});
      }
      if(e.type==='compaction')add('summary',e.id,'summary',e.summary,{derived:true,label:'派生摘要',provenance:{firstKeptEntryId:e.firstKeptEntryId,source:e.details?.cothinkContext??null}});
      if(e.type==='branch_summary')add('summary',e.id,'summary',e.summary,{derived:true,label:'派生摘要',provenance:{fromId:e.fromId}});
    }
    for(const id of conversationTaskIds(manager)){
      let record;
      try{record=getTask?.()?.record.id===id?getTask().record:readTask(home,id);}catch{continue;}
      if(!lineage.has(record.sessionId)||!conversationTaskIds({getBranch:()=>lineage.get(record.sessionId)}).includes(id))throw fail('CONTEXT_SOURCE','Task session does not match the current branch or its saved fork lineage');
      // Membership also requires the saved session/fork lineage, not only a model-supplied ID.
      if(includeTasks)add('task',id,'input',record.input);
    }
    return items;
  };
  const processFacts=(taskId,purpose)=>{
    if(!['attribution','evidence','continuation'].includes(purpose)||typeof taskId!=='string'||!conversationTaskIds(manager).includes(taskId))
      throw fail('CONTEXT_SOURCE','Process lookup requires a purpose and a task on the current branch');
    const lineage=contextLineage(home,manager),items=[];
    const add=(field,value)=>{
      const text=JSON.stringify(value),ref={sessionId:manager.getSessionId(),kind:'process',id:taskId,field,sha256:contextDigest(text)};
      items.push({sourceId:contextDigest(ref),ref,kind:'process',purpose,text});
    };
    let root;
    try {root=readTask(home,taskId);}catch{add('unavailable',{taskId,missing:'task'});return items;}
    const belongs=record=>conversationTaskIds({getBranch:()=>lineage.get(record.sessionId)??[]}).includes(record.id);
    if(!belongs(root))
      throw fail('CONTEXT_SOURCE','Process task does not belong to the verified branch ancestry');
    if(purpose==='continuation'){
      const p=root.proposal,hash=p&&digest(p);
      const operation=root.projectOperation;
      const confirmed=!!(p&&operation?.planDigest===hash&&operation.planRef?.taskId===taskId&&operation.planRef.sha256===hash&&
        operation.contextRef?.sha256===p.contextDigest);
      if(p&&(root.proposalRef?.sourceTaskId===taskId&&root.proposalRef.planDigest===hash||confirmed)){
        add('plan',{taskId,confirmed,planRef:{taskId,field:'proposal',sha256:hash},
          version:p.version,revision:root.projectOperation?.revision??p.expectedRevision,constraints:p.constraints,plan:p.plan});
      }else add('unavailable',{taskId,missing:'verified plan'});
    }
    let delivery;
    if(root.deliveryRef){
      try{
        delivery=resolveDeliveryEvidence(home,root);
        if(purpose!=='attribution'){
          add('version',{taskId,projectId:root.deliveryRef.projectId,version:root.deliveryRef.version,revision:root.deliveryRef.revision,
            files:[...delivery.artifacts.keys()],checks:root.deliveryRef.checksRef,
            visualVerified:root.deliveryRef.visualDigest?!delivery.visualError:undefined});
        }
      }catch{add('unavailable',{taskId,missing:'verified delivery'});}
    }
    if(purpose==='attribution'||purpose==='evidence'){
      let children=[];
      try{children=resolveOwnedTasks(home,root,()=>add('unavailable',{taskId,missing:'owned execution'}));}
      catch{add('unavailable',{taskId,missing:'execution ownership'});}
      for(const {record,relation} of delivery?.sources??[]){
        if(relation==='inherited'){
          try{if(belongs(readTask(home,record.rootTaskId)))children.push(record);}
          catch{add('unavailable',{taskId,missing:'inherited execution ownership'});}
        }
      }
      for(const record of [root,...children]){
        const calls=[];
        for(const requestId of record.requestIds??[]){
          try{
            const call=readRequest(home,record.id,requestId);
            const stage=record.stages.find(s=>s.id===call.stageId);
            if(!stage||stage.role!==call.role||stage.phase!==call.phase)throw Error('role binding changed');
            calls.push({requestId,role:stage.role,phase:stage.phase,status:call.status,sent:call.sent,
              ...(call.actualModel?{model:{provider:call.actualModel.provider,modelId:call.actualModel.modelId}}:{})});
          }catch{add('unavailable',{taskId:record.id,requestId,missing:'request or role binding'});}
        }
        add('roles:'+record.id,{taskId:record.id,stepId:record.project?.stepId,roles:calls,
          assignments:(record.members??[]).map(m=>({memberId:m.memberId,workId:m.workId,staffId:m.staffId,parentActorId:m.parentActorId,
            assignment:m.assignment,status:m.status}))});
      }
      if(root.managerFinal?.reusedFrom){
        try{
          const origin=readTask(home,root.managerFinal.reusedFrom);
          if(!belongs(origin))throw Error('Report is outside the verified branch');
          const report=resolveManagerFinal(home,root,delivery);
          add('report-author',{taskId,sourceTaskId:report.taskId,requestId:report.id,role:report.role,
            model:{provider:report.actualModel.provider,modelId:report.actualModel.modelId}});
        }catch{add('unavailable',{taskId,missing:'reused report author'});}
      }
    }
    return items;
  };
  const resolve=(ref,purpose)=>{
    if(!ref||typeof ref!=='object'||Object.keys(ref).sort().join(',')!=='field,id,kind,sessionId,sha256')throw fail('CONTEXT_SOURCE','Use a host-issued context reference');
    const process=ref.kind==='process';
    const item=(process?processFacts(ref.id,purpose):catalog()).find(x=>['kind','id','field','sha256'].every(key=>x.ref[key]===ref[key]));
    let permitted=ref.sessionId===manager.getSessionId();
    if(!permitted){
      const prefix=contextLineage(home,manager).get(ref.sessionId)??[];
      permitted=ref.kind==='task'||process?conversationTaskIds({getBranch:()=>prefix}).includes(ref.id)&&readTask(home,ref.id).sessionId===ref.sessionId:prefix.some(e=>e.id===ref.id);
    }
    if(!item||!permitted)throw fail('CONTEXT_SOURCE','Source is not on the current branch or its content changed');
    return item;
  };
  return {
    freeze(){
      // Use the public effective projection: summarized or context-edited-away text
      // must not be silently expanded into a fresh executor's context.
      const sources=catalog({includeTasks:false}),materials=[];
      for(const {sourceEntry,messages} of buildConversationProjection(home,manager).entries){
        for(const message of messages){
          const kind=['compactionSummary','branchSummary'].includes(message.role)?'summary':message.role;
          if(!['user','assistant','summary'].includes(kind))continue;
          const original=sources.find(item=>item.ref.id===sourceEntry.id&&item.kind===kind);
          const text=kind==='summary'?message.summary:textOf(message.content);
          if(!original||!text)continue;
          const ref={...original.ref,sha256:contextDigest(text)};
          materials.push({...original,ref,sourceId:contextDigest(ref),text,role:kind,
            ...(text!==original.text?{projection:{originalRef:original.ref,derived:true}}:{})});
        }
      }
      const attachmentRefs=conversationMaterialRefs(manager);
      return {source:contextSnapshot(manager),materials:structuredClone(materials),...(attachmentRefs.length?{attachmentRefs}:{})};
    },
    search({query='',offset=0,limit=20,purpose,taskId}={}){
      page(offset,limit,50);if(typeof query!=='string'||query.length>500)throw fail('CONTEXT_RANGE','Query too long');
      const items=(purpose!==undefined||taskId!==undefined?processFacts(taskId,purpose):catalog()).filter(x=>x.text.toLowerCase().includes(query.toLowerCase()));
      return {scope:'current-branch',sourceLeaf:manager.getLeafId(),items:items.slice(offset,offset+limit).map(({text,...item})=>({...item,snippet:text.slice(Math.max(0,text.toLowerCase().indexOf(query.toLowerCase())-60),Math.max(0,text.toLowerCase().indexOf(query.toLowerCase())-60)+320)})),nextOffset:offset+limit<items.length?offset+limit:null};
    },
    read({ref,purpose,offset=0,limit=4000}){page(offset,limit);const {text,...item}=resolve(ref,purpose);return {...item,offset,text:text.slice(offset,offset+limit),total:text.length,nextOffset:offset+limit<text.length?offset+limit:null};},
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
