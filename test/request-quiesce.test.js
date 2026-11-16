import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {quiesceRequest} from '../src/request-quiesce.js';
function setup(t){
 const home=mkdtempSync(join(tmpdir(),'quiesce-'));mkdirSync(join(home,'requests'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const controller=new AbortController(),taskId=randomUUID(),a={id:randomUUID(),taskId,sent:true,status:'outcome_unknown',transport:{fetchError:{message:'fetch failed'}},usage:null},b={id:randomUUID(),taskId,sent:true,status:'in_flight',transport:{},usage:null};
 const write=r=>writeFileSync(join(home,'requests',r.id+'.json'),JSON.stringify(r));write(a);write(b);
 const root={home,signal:controller.signal,record:{rootRequests:[a,b].map(r=>({requestId:r.id,taskId}))},save(){}};
 let admissions=0;const owner={rootTask:root,reserveRequest(){admissions++;}};const task={home,signal:controller.signal,rootOwner:owner};
 return{home,controller,task,root,owner,a,b,write,admissions:()=>admissions};
}
test('network loss synchronously closes admission and waits only already sent receipts without rewriting unknown',async t=>{
 const f=setup(t),before=readFileSync(join(f.home,'requests',f.a.id+'.json'));let ended=false;
 const wait=quiesceRequest(f.task,f.a,{timeoutMs:200,pollMs:1}).then(()=>ended=true);
 assert.throws(()=>f.owner.reserveRequest({}),{code:'ROOT_QUIESCING'});assert.equal(ended,false);
 assert.deepEqual(f.root.record.networkQuiesce.requests,[{requestId:f.b.id,taskId:f.b.taskId}]);
 f.b.status='completed';f.b.usage={input:1,output:2};f.write(f.b);await wait;
 assert.equal(f.root.record.networkQuiesce.status,'settled');assert.equal(f.admissions(),0);
 assert.deepEqual(readFileSync(join(f.home,'requests',f.a.id+'.json')),before);
 assert.throws(()=>f.owner.reserveRequest({}),{code:'ROOT_QUIESCING'});
});
test('simultaneous unknowns share one deadline and never wait on themselves',async t=>{
 const f=setup(t),one=quiesceRequest(f.task,f.a,{timeoutMs:200,pollMs:1}),deadline=f.root.record.networkQuiesce.deadlineAt;
 f.b.status='outcome_unknown';f.b.transport.fetchError={message:'closed'};f.write(f.b);
 await Promise.all([one,quiesceRequest(f.task,f.b,{timeoutMs:5000})]);
 assert.equal(f.root.record.networkQuiesce.deadlineAt,deadline);assert.equal(f.root.record.networkQuiesce.status,'settled');
});
test('bounded wait times out without making unknown requests successful',async t=>{
 const f=setup(t);await quiesceRequest(f.task,f.a,{timeoutMs:15,pollMs:1});
 assert.equal(f.root.record.networkQuiesce.status,'timed_out');assert.equal(f.a.status,'outcome_unknown');assert.equal(f.b.status,'in_flight');
});
test('explicit stop interrupts waiting rather than consuming the deadline',async t=>{
 const f=setup(t),wait=quiesceRequest(f.task,f.a,{timeoutMs:10000,pollMs:1});f.controller.abort();await wait;assert.equal(f.root.record.networkQuiesce.status,'cancelled');
});
for(const mode of ['cancel','credit','budget','not-sent'])test(mode+' does not create a network delay',async t=>{
 const f=setup(t);if(mode==='cancel')f.controller.abort();
 if(mode==='credit')f.a.transport.firstSseError={error:{code:'credit_balance_exhausted'}};
 if(mode==='budget'){f.a.status='failed';f.a.transport={};}
 if(mode==='not-sent')f.a.sent=false;
 await quiesceRequest(f.task,f.a);assert.equal(f.root.record.networkQuiesce,undefined);
});

test('corrupt receipt fails closed without rejecting the stream error barrier',async t=>{
 const f=setup(t);let stops=0;f.owner.stopAndDrain=async()=>{stops++;f.controller.abort();};
 writeFileSync(join(f.home,'requests',f.b.id+'.json'),'not json');
 await quiesceRequest(f.task,f.a,{timeoutMs:200,pollMs:1});
 assert.equal(stops,1);assert.ok(f.task.ioError);assert.equal(f.root.record.networkQuiesce.status,'failed');
});
test('storage failure during quiesce also closes authority without stranding the stream',async t=>{
 const f=setup(t);let stops=0;f.root.save=()=>{throw Error('disk failed');};f.owner.stopAndDrain=async()=>{stops++;f.controller.abort();};
 await quiesceRequest(f.task,f.a);assert.equal(stops,1);assert.equal(f.root.record.networkQuiesce.status,'failed');
});
