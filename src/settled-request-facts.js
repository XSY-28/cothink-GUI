import {statSync} from 'node:fs';
import {join} from 'node:path';
import {readRequest,problem} from './task.js';
const identity=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
/** Writer-local status hints only; authorization and unknown receipts remain uncached. */
export function createSettledRequestFacts(home,{limit=2048,stat=statSync,read=readRequest}={}){
 if(!Number.isInteger(limit)||limit<1||limit>2048)throw problem('REQUEST_CACHE','Invalid cache bound');
 const cache=new Map();
 return claim=>{
  if(!/^[\da-f-]{36}$/.test(claim.id??''))throw problem('INVALID_ID','Invalid request identity');
  const path=join(home,'requests',claim.id+'.json'),key=claim.taskId+':'+claim.id;
  try{
   const before=identity(stat(path,{bigint:true})),old=cache.get(key);
   if(old?.identity===before){cache.delete(key);cache.set(key,old);return {...old.fact};}
   cache.delete(key);
   const request=read(home,claim.taskId,claim.id),after=identity(stat(path,{bigint:true}));
   if(before!==after)throw problem('REQUEST_CHANGED','Original request changed while being read');
   const fact={sent:request.sent,status:request.status};
   if(request.sent===true&&['completed','failed','partial'].includes(request.status)&&request.endedAt&&
      request.eventJournal?.version===1&&request.eventJournal.folded===true){
    cache.set(key,{identity:after,fact});
    if(cache.size>limit)cache.delete(cache.keys().next().value);
   }
   return {...fact};
  }catch(error){cache.delete(key);if(error.code==='ENOENT')return;throw error;}
 };
}
