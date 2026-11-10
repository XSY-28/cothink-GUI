import test from "node:test";
import assert from "node:assert/strict";
import { roster } from "./staff.fixture.js";

test("the writer claims work and position separately, reuses lost replies, and keeps root edits bound", () => {
  const {state, staff, appoint} = roster();
  state.steps = [{id:"delivery", attempts:[{taskId:"task"}], scope:["src"], works:[
    {id:"front",scope:["src/ui"]}, {id:"math",scope:["src/math"]},
  ]}];
  for (const id of ["first", "second", "third"]) appoint(id);
  const claim = (id, work, changes = {}) => staff.begin({
    taskId:"task", staffId:id, actor:"root", actorRole:"main", model:"local/A", identity:"a",
    assignment:"Implement " + work, workId:work, scope:[work === "front" ? "src/ui" : "src/math"],
    readScope:["."], ...changes,
  });
  const front = claim("first", "front");
  assert.equal(claim("first", "front").dispatchId, front.dispatchId);
  assert.equal(claim("first", "front").reused, true);
  assert.throws(() => claim("second","front", {assignment:"renamed"}));
  assert.throws(() => claim("first","math"));
  staff.update(front.dispatchId, {status:"unknown", requestId:"pending"});
  const math = claim("second","math");
  assert.notEqual(math.dispatchId,front.dispatchId);
  assert.equal(Object.keys(state.staffAssignments).length,2);
  assert.throws(() => staff.claimWrite({role:"main",taskId:"task",scope:["src/ui/code"]}));
  assert.throws(() => staff.claimWrite({role:math.role,taskId:"task",scope:["src/ui/code"]}));
  assert.doesNotThrow(() => staff.claimWrite({role:math.role,taskId:"task",scope:["src/math/code"]}));
  assert.throws(() => staff.checkIdentity({taskId:"task",role:math.role,model:{provider:"other",id:"A"}}));
  assert.throws(() => staff.begin({...front, dispatchId:undefined, staffId:"third", actorRole:math.role}));
});

test("four layers are selected per root turn and bound to the live management chain", async () => {
  const {state, staff, appoint} = roster();
  const taskId = "step-one", otherTaskId = "step-two", nextTurnTaskId = "step-next";
  const model = "local/reader";
  state.entryPolicy = "unified";
  state.readScope = ["src"];
  const tool = (actor, id = taskId) => staff.tools(actor, () => {}, id, [model])[0];
  const run = (actor, action, input, id) => tool(actor, id).execute("tool", {action, input});
  state.steps = [
    {id:"one", scope:["src"], attempts:[{taskId, rootTaskId:"turn"}]},
    {id:"two", scope:["src"], attempts:[{taskId:otherTaskId, rootTaskId:"turn"}]},
    {id:"next", scope:["src"], attempts:[{taskId:nextTurnTaskId, rootTaskId:"next-turn"}]},
  ];
  const seat = (id, scope = ["src"]) => ({
    id, scope, models:[model], responsibility:id, need:"deliverable", reason:"Independent responsibility",
  });
  const promote = (actor, id, models = [model]) => run(actor, "promote", {id, models, subgoal:id});
  for (const id of ["lead", "sibling"]) {
    appoint(id);
    await promote("root", id);
  }
  await assert.rejects(run("root", "appoint", {...seat("outside-chain"), supervisorId:"lead"}), /direct report/i);
  await run("lead", "appoint", seat("sub"));
  await assert.rejects(promote("lead", "sub"), /depth|layer/i);
  await assert.rejects(run("lead", "set_depth", {maxDepth:4}), /root/i);
  await assert.rejects(run("root", "set_depth", {maxDepth:5}), /depth|layer/i);
  await run("root", "set_depth", {maxDepth:4});
  await assert.rejects(promote("sibling", "sub"), /direct report/i);
  await assert.rejects(promote("lead", "sub", ["local/unavailable"]), /roster/i);
  await promote("lead", "sub");
  await assert.rejects(run("sub", "appoint", seat("outside", ["sibling"])), /scope/i);
  await run("sub", "appoint", seat("leaf", ["src/one"]), otherTaskId);
  await assert.rejects(run("sub", "appoint", seat("wrong-turn", ["src/one"]), nextTurnTaskId), /depth|layer/i);
  await run("root", "set_depth", {maxDepth:3}, nextTurnTaskId);
  assert.equal(staff.canManage(taskId, "sub"), true);
  assert.equal(staff.canManage(nextTurnTaskId, "sub"), false);
  await assert.rejects(promote("sub", "leaf"), /depth|layer/i);
  await assert.rejects(run("leaf", "appoint", seat("fifth")), /supervisor|depth|layer/i);

  const grant = (staffId, owner, args = {}) => staff.begin({
    taskId, staffId, identity:"reader", model, scope:[], readScope:["src"], readOnly:true,
    actor:owner?.staffId ?? "root", actorRole:owner?.role ?? "main",
    supervisorMemberId:owner?.dispatchId,
    ...args,
  });
  const lead = grant("lead");
  const sub = grant("sub", lead);
  const leaf = grant("leaf", sub, {readScope:["src/one"]});
  assert.equal(new Set([lead.role, sub.role, leaf.role]).size, 3);
  assert.notEqual(lead.workId, sub.workId);
  assert.throws(() => staff.checkOwner({taskId, actorRole:lead.role, dispatchId:leaf.dispatchId}), /direct supervisor/i);
  assert.equal(staff.checkOwner({taskId, actorRole:sub.role, dispatchId:leaf.dispatchId}), true);
  assert.equal(staff.checkOwner({taskId, actorRole:"main", dispatchId:leaf.dispatchId, rootReview:true}), true);
  await assert.rejects(run("root", "set_depth", {maxDepth:3}, otherTaskId), /unresolved|settle/i);
  staff.update(leaf.dispatchId, {status:"disposed", outcome:"completed"});
  await run("root", "set_depth", {maxDepth:3}, otherTaskId);
  assert.throws(() => grant("leaf", sub, {readScope:["src/one"]}), /depth|layer/i);
});

test("staff subtree transfers reject cycles, excessive depth, and unresolved descendant work", async () => {
  const {state, staff, appoint} = roster();
  const taskId = "step", model = "local/reader";
  state.steps = [{id:"step", scope:["src"], attempts:[{taskId}]}];
  const run = (actor, action, input) => staff.tools(actor, () => {}, taskId, [model])[0]
    .execute("tool", {action, input});
  const promote = (actor, id) => run(actor, "promote", {id, models:[model], subgoal:id});
  const transfer = (id, supervisorId) => run("root", "transfer", {id, supervisorId, reason:"Move settled responsibility"});
  await run("root", "set_depth", {maxDepth:4});
  for (const id of ["source", "destination"]) {
    appoint(id);
    await promote("root", id);
  }
  appoint("child", {supervisorId:"source"});
  await promote("source", "child");
  await run("child", "appoint", {
    id:"grandchild", responsibility:"Inspect the isolated result", scope:["src/grandchild"],
    need:"deliverable", reason:"Separate inspection",
  });
  await assert.rejects(transfer("source", "child"), /cycle/i);
  await assert.rejects(transfer("source", "destination"), /depth|layer/i);
  assert.equal(staff.list().find(p => p.id === "source").status, "active");
  const grant = (staffId, owner, readScope = ["src"]) => staff.begin({
    taskId, staffId, identity:"reader", model, scope:[], readScope, readOnly:true,
    actor:owner?.staffId ?? "root", actorRole:owner?.role ?? "main", supervisorMemberId:owner?.dispatchId,
  });
  const source = grant("source"), child = grant("child", source);
  const grandchild = grant("grandchild", child, ["src/grandchild"]);
  await assert.rejects(transfer("child", "destination"), /unresolved|settle/i);
  staff.update(grandchild.dispatchId, {status:"disposed", outcome:"completed"});
  staff.update(child.dispatchId, {status:"disposed", outcome:"completed"});
  await transfer("child", "destination");
  await run("root", "finish", {id:"child"});
  assert.equal(staff.list().find(p => p.id === "child").supervisorId, "destination");
  assert.equal(staff.list().find(p => p.id === "grandchild").supervisorId, "child");
});

test("a supervisor pause closes descendant assignments while preserving accepted receipts and sibling authority", () => {
  const {staff, appoint, assign} = roster();
  const taskId = "task-1";
  appoint("lead");
  staff.change("promote", {
    id:"lead", subgoal:"Coordinate both assigned files", models:["local/lead", "local/report", "local/accepted"],
  });
  appoint("report", {supervisorId:"lead"});
  appoint("accepted", {supervisorId:"lead"});
  appoint("sibling");
  const lead = assign("lead");
  const subordinate = {actor:"lead", actorRole:lead.role, supervisorMemberId:lead.dispatchId};
  const report = assign("report", subordinate);
  const accepted = assign("accepted", subordinate);
  const sibling = assign("sibling");
  staff.update(accepted.dispatchId, {status:"disposed", outcome:"accepted", version:"accepted-version"});
  assert.throws(() => staff.pause({taskId, actorRole:sibling.role, dispatchId:report.dispatchId, reason:"wrong group"}, () => ({})));
  const affected = staff.pause({
    taskId, actorRole:"main", dispatchId:lead.dispatchId, reason:"Pause this independent group",
  }, () => ({}));
  assert.deepEqual(affected.map(a => a.dispatchId), [lead.dispatchId, report.dispatchId]);
  assert.throws(() => staff.checkIdentity({taskId, role:report.role, model:{id:"report"}}), {code:"GROUP_PAUSED"});
  assert.equal(staff.checkIdentity({taskId, role:sibling.role, model:{id:"sibling"}}), true);
  assert.equal(staff.assignment(accepted.dispatchId).version, "accepted-version");
  assert.equal(staff.assignment(accepted.dispatchId).pause, undefined);
});
