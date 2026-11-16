import test from 'node:test';import assert from 'node:assert/strict';
import{buildMemberTaskMaterial}from'../src/context.js';
const artifact={baseVersion:'base',version:'candidate',diff:{files:['a.txt'],text:'exact diff'}};
const args={originalTask:'User original goal',assignment:'LEADER_ASSIGNMENT',implementationAdvice:'LEADER_OPINION',reason:'LEADER_REASON',project:{goal:'User goal',subgoal:'Current stage'},execution:{reviewKind:'independent',reviewArtifact:artifact,readOnly:true,reviewInstruction:'JSON verdict bound to candidate'},tools:['read','inspect_change']};
const material=a=>JSON.parse(buildMemberTaskMaterial(a));
test('independent preparation is brief boundary confirmation, not an initial full review',()=>{
 const p=material({...args,preparation:true});assert.match(p.instruction,/Preparation only/);assert.match(p.instruction,/Do not perform the full review/);assert.match(p.instruction,/next review phase in this same session/);
 for(const text of ['LEADER_ASSIGNMENT','LEADER_OPINION','LEADER_REASON'])assert.ok(!JSON.stringify(p).includes(text));
 assert.deepEqual(p.execution.reviewArtifact,artifact);assert.deepEqual(p.execution.tools,args.tools);assert.equal(p.originalTask.text,args.originalTask);assert.equal(p.execution.readOnly,true);
});
test('formal independent phase retains complete validation, exact evidence and output contract',()=>{
 const p=material(args);assert.match(p.instruction,/complete independent review/);assert.match(p.instruction,/do not omit required validation/);assert.match(p.instruction,/Reuse observations/);assert.deepEqual(p.execution.reviewArtifact,artifact);assert.deepEqual(p.execution.tools,args.tools);assert.equal(p.execution.reviewInstruction,args.execution.reviewInstruction);
});
test('ordinary review retains prior independent observations contract',()=>{
 const p=material({...args,preparation:true,execution:{...args.execution,reviewKind:'ordinary'}});assert.equal(p.instruction,'Inspect the supplied candidate against the original task. Record your own observations, counterexamples and uncertainties before receiving any prior opinion. Use read for evidence from this exact version.');
});
test('ordinary employee and feedback keep their existing preparation and reuse boundaries',()=>{
 const p=material({...args,preparation:true,execution:{}});assert.match(p.instruction,/Before receiving any assignment or advice/);assert.match(p.instruction,/Do not implement yet/);
 const reuse=material({...args,reuseAssignment:true});assert.match(reuse.instruction,/Continue the same assignment/);assert.equal(reuse.assignment,undefined);
});
