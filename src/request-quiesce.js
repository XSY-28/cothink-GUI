import {problem} from './task.js';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
function liveRequest(root,x){
 if(!/^[\da-f-]{36}$/.test(x.requestId))throw problem('INVALID_ID','Invalid live receipt');
 const r=JSON.parse(readFileSync(join(root.home,'requests',x.requestId+'.json'),'utf8'));
 if(r.id!==x.requestId||r.taskId!==x.taskId)throw problem('CORRUPT_REQUEST','Wrong live receipt owner');
 return r;
}
const gates=new WeakMap();
const terminal=new Set(['completed','failed','partial','outcome_unknown','not_sent','stop_unknown','cancelled']);
/** Preserve already-dispatched receipts after a transport loss, never retry or admit new work. */
async function waitForReceipts(task,call,{timeoutMs=120000,pollMs=100}={}) {
 const owner=task?.rootOwner;if(!owner)return;
 let gate=gates.get(owner);
 const network=call?.sent&&call.status==='outcome_unknown'&&!task.signal.aborted&&
  !call.transport?.abort&&!call.transport?.firstSseError&&
  (call.transport?.fetchError||call.transport?.bodyError);
 if(!gate&&network){
  const started=Date.now(),deadline=started+timeoutMs;
  const root=owner.rootTask,entries=root.record.rootRequests.filter(x=>x.requestId!==call.id).flatMap(x=>{
   const r=liveRequest(root,x);
   return r.sent&&!terminal.has(r.status)?[{requestId:x.requestId,taskId:x.taskId}]:[];
  });
  const record={triggerRequestId:call.id,startedAt:new Date(started).toISOString(),deadlineAt:new Date(deadline).toISOString(),requests:entries,status:'waiting'};
  gate={record};gates.set(owner,gate);root.record.networkQuiesce=record;
  owner.reserveRequest=args=>{throw problem('ROOT_QUIESCING','Network outcome unknown; new model requests are closed');};
  root.save();
  gate.promise=(async()=>{
   while(!task.signal.aborted&&!root.signal.aborted){
    const pending=entries.filter(x=>!terminal.has(liveRequest(root,x).status));
    if(!pending.length){record.status='settled';break;}
    if(Date.now()>=deadline){record.status='timed_out';break;}
    await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(1,deadline-Date.now()))));
   }
   if(record.status==='waiting')record.status='cancelled';
   record.endedAt=new Date().toISOString();root.save();
  })();
 }
 if(gate&&!task.signal.aborted&&!owner.rootTask.signal.aborted)await gate.promise;
}

export async function quiesceRequest(task,call,options){
 try{await waitForReceipts(task,call,options);}
 catch(error){
  // A receipt/storage failure must close authority, not strand the consumer stream.
  task.ioError??=error;
  const owner=task.rootOwner,root=owner?.rootTask;
  if(root){
   root.record.networkQuiesce??={triggerRequestId:call?.id,requests:[]};
   Object.assign(root.record.networkQuiesce,{status:'failed',error:error.message,endedAt:new Date().toISOString()});
   try{root.save();}catch{}
   try{void owner.stopAndDrain({cause:'network-quiesce-failed'}).catch(()=>{});}catch{}
  }
 }
}
