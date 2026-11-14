import test from 'node:test';
import assert from 'node:assert/strict';
import {continuationObservations} from '../src/project-completed-continuation.js';

const checks=[{command:'node',args:['check.cjs']}];
const execution={engine:'docker',image:'sha256:fixed',network:'none'};
function setup() {
 const source={project:{checks:structuredClone(checks)},work:{execution:structuredClone(execution),operations:[{action:'command_start',requestId:'command-1',changeId:'saved'}],changes:[{changeId:'saved',actor:'main'}]},tools:[{
  name:'bash',requestId:'command-1',status:'completed',kernelDispatched:true,exitCode:0,
  kernelInput:{expectedVersion:'before',command:'node optional-browser.cjs'},
 }]};
 const receipt={status:'completed',requestId:'command-1',exitCode:0,privateVersion:'observed',changedFiles:[],outputRef:'command-1'};
 const v={async inspect(input={}) {
  if(input.requestId)return receipt;
  if(input.changeId)return {actor:'main',privateVersion:'restored'};
  if(input.fromVersion)return {files:[]};
  return {execution,version:'base'};
 }};
 return {source,receipt,v};
}
test('completed command observations bind candidate, check definitions, environment and source receipt without changing history',async()=>{
 const {source,v}=setup(),before=JSON.stringify(source);
 const result=await continuationObservations(v,source,{version:'restored',baseVersion:'base',changeId:'saved'},checks);
 assert.equal(result.commands.length,1);assert.equal(result.fixedChecksRequired,true);
 assert.deepEqual(result.commands[0],{requestId:'command-1',recordedCommand:'node optional-browser.cjs',observedVersion:'observed',candidate:'restored',outputRef:'command-1',exitCode:0,checks,execution});
 assert.equal(JSON.stringify(source),before);
});
for(const [name,mutate] of [
 ['changed formal input',({v})=>{const inspect=v.inspect;v.inspect=arg=>!arg?{execution,version:'new-input'}:inspect(arg);}],
 ['missing command source',({source})=>source.work.operations=[]],
 ['wrong command source',({source})=>source.work.changes[0].changeId='another'],
 ['changed actor',({source})=>source.work.changes[0].actor='another'],
 ['changed checks',({source})=>source.project.checks[0].args=['new-check.cjs']],
 ['changed environment',({source})=>source.work.execution.image='sha256:other'],
 ['networked environment',({source})=>source.work.execution.network='host'],
 ['failed tool',({source})=>source.tools[0].status='failed'],
 ['unknown tool',({source})=>source.tools[0].status='outcome_unknown'],
 ['unissued tool',({source})=>source.tools[0].kernelDispatched=false],
 ['failed receipt',({receipt})=>receipt.exitCode=1],
 ['missing receipt',({receipt})=>receipt.status='not_found'],
 ['wrong receipt',({receipt})=>receipt.requestId='another'],
 ['source-mutating command',({receipt})=>receipt.changedFiles=['a.txt']],
 ['changed candidate',({v})=>{const inspect=v.inspect;v.inspect=arg=>arg?.toVersion==='restored'?{files:['a.txt']}:inspect(arg);}],
 ['changed bytes during observation',({v})=>{const inspect=v.inspect;v.inspect=arg=>arg?.toVersion==='observed'?{files:['a.txt']}:inspect(arg);}],
 ['unavailable evidence',({v})=>{v.inspect=arg=>{if(arg?.requestId)throw Error('unavailable');return {execution,version:'base'};};}],
])test('observations are invalidated for '+name,async()=>{
 const state=setup();mutate(state);
 const result=await continuationObservations(state.v,state.source,{version:'restored',baseVersion:'base',changeId:'saved'},checks);
 assert.equal(result.commands.length,0);assert.equal(result.invalidated.length,1);assert.equal(result.fixedChecksRequired,true);
});
