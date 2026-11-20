import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import * as state from "../src/gui-workspace-state.js";

function temp(t) {
  const home = mkdtempSync(join(tmpdir(), "cothink-gui-workspace-"));
  t.after(() => rmSync(home, {recursive:true, force:true}));
  return home;
}
const args = (workspaceId, name, project = null) => ({workspaceId, name, project, defaultRosterId:null});
test("a named workspace survives without a Pi session and stale updates preserve the latest entry", t => {
  const home = temp(t), workspaceId = randomUUID();
  assert.equal(state.createGuiWorkspace(home, args(workspaceId," 学习 ")).revision, 0);
  assert.equal(state.readGuiWorkspaces(home).workspaces[0].name, "学习");
  assert.equal(state.updateGuiWorkspace(home, {workspaceId, expectedRevision:0, change:{name:"线代"}}).revision, 1);
  assert.throws(() => state.updateGuiWorkspace(home, {workspaceId, expectedRevision:0, change:{name:"过期覆盖"}}),
    error => error.code === "WORKSPACE_CONFLICT" && error.workspace?.name === "线代");
  assert.throws(() => state.createGuiWorkspace(home, args(workspaceId,"重建")),
    error => error.code === "WORKSPACE_CONFLICT" && error.workspace?.revision === 1);
});
test("archived entries still reserve their directory and normalized unbound names", t => {
  const home = temp(t), workspaceId = randomUUID();
  const project = join(home, "repo");
  state.createGuiWorkspace(home, args(workspaceId,"项目",project));
  state.updateGuiWorkspace(home, {workspaceId, expectedRevision:0, change:{archived:true}});
  assert.throws(() => state.createGuiWorkspace(home,args(randomUUID(),"另一个",project)),
    error => error.code === "WORKSPACE_CONFLICT" && error.workspace?.id === workspaceId);
  state.createGuiWorkspace(home,args(randomUUID(),"CAFÉ"));
  assert.throws(() => state.createGuiWorkspace(home,args(randomUUID(),"cAFE\u0301")), {code:"WORKSPACE_CONFLICT"});
  assert.equal(state.createGuiWorkspace(home,args(randomUUID(),"项目",join(home,"worktree"))).name, "项目");
});
test("corrupt and future workspace snapshots survive failed reads and writes byte for byte", t => {
  const home = temp(t), file = join(home,"gui-workspaces.json");
  for (const bytes of ["{unfinished", '{"schemaVersion":9,"revision":0,"workspaces":[]}', '{"schemaVersion":1,"revision":0,"workspaces":[{}]}']) {
    writeFileSync(file,bytes);
    assert.throws(() => state.readGuiWorkspaces(home), {code:"WORKSPACE_UNAVAILABLE"});
    assert.throws(() => state.createGuiWorkspace(home,args(randomUUID(),"保留现场")), {code:"WORKSPACE_UNAVAILABLE"});
    assert.equal(readFileSync(file,"utf8"),bytes);
  }
});

test("rebind atomically freezes each legacy branch and preserves the exact v1 snapshot", t => {
  const home = temp(t), workspaceId = randomUUID(), otherId = randomUUID();
  const project = join(home, "before"), other = join(home, "other"), moved = join(home, "moved");
  state.createGuiWorkspace(home, args(workspaceId, "项目", project));
  state.createGuiWorkspace(home, args(otherId, "其他", other));
  const sessionId = randomUUID(), operationId = randomUUID();
  const original = readFileSync(join(home, "gui-workspaces.json"));
  assert.equal(typeof state.rebindGuiWorkspace, "function");
  const input = { workspaceId, operationId, expectedRevision:0, path:moved,
    legacyBindings:[{sessionId, project}, {sessionId, project:other}] };
  const result = state.rebindGuiWorkspace(home, input, () => {});
  assert.equal(result.mutationId, operationId);
  assert.equal(result.project, moved);
  const snapshot = state.readGuiWorkspaces(home);
  assert.equal(snapshot.schemaVersion, 2);
  assert.deepEqual(readFileSync(join(home,"gui-workspaces.v1.json")), original);
  assert.equal(state.workspaceForSession(snapshot, sessionId, project, null).id, workspaceId);
  assert.equal(state.workspaceForSession(snapshot, sessionId, other, null).id, otherId);
  assert.equal(state.workspaceForSession(snapshot, sessionId, project, otherId).id, otherId);
  assert.equal(state.workspaceForSession(snapshot, sessionId, null, null), undefined);
  assert.equal(state.importGuiWorkspaceProjects(home, [{sessionId, project}]).workspaces.length, 2);
  assert.equal(state.queryGuiWorkspaceRebind(home, input).status, "confirmed");
  state.updateGuiWorkspace(home, {workspaceId, expectedRevision:1, change:{name:"项目改名"}});
  assert.equal(state.queryGuiWorkspaceRebind(home, input).status, "unconfirmed");
});

test("failed frozen-history validation and unbound name conflicts do not change the directory table", t => {
  const home = temp(t), workspaceId = randomUUID();
  const project = join(home, "project");
  state.createGuiWorkspace(home, args(workspaceId, "项目", project));
  const file = join(home, "gui-workspaces.json");
  const before = readFileSync(file);
  const input = { workspaceId, operationId:randomUUID(), expectedRevision:0, path:null, legacyBindings:[] };
  assert.equal(typeof state.rebindGuiWorkspace, "function");
  assert.throws(() => state.rebindGuiWorkspace(home, input, () => { throw Error("branch changed"); }), /branch changed/);
  assert.deepEqual(readFileSync(file), before);
  state.createGuiWorkspace(home, args(randomUUID(), "项目"));
  const withConflict = readFileSync(file);
  assert.throws(() => state.rebindGuiWorkspace(home, input, () => {}), { code:"WORKSPACE_CONFLICT" });
  assert.deepEqual(readFileSync(file), withConflict);
});

test("legacy discovery records a branch identity without making its old path an alias", t => {
  const home = temp(t), oldPath = join(home, "before"), moved = join(home, "after");
  const originalSession = randomUUID();
  const discovered = state.importGuiWorkspaceProjects(home, [{sessionId:originalSession, project:oldPath}]);
  const workspaceId = discovered.workspaces[0].id;
  state.rebindGuiWorkspace(home, { workspaceId, operationId:randomUUID(), expectedRevision:0,
    path:moved, legacyBindings:[] }, () => {});
  const laterSession = randomUUID();
  const current = state.importGuiWorkspaceProjects(home, [
    {sessionId:originalSession, project:oldPath}, {sessionId:laterSession, project:oldPath},
  ]);
  assert.equal(current.workspaces.length, 2);
  assert.equal(state.workspaceForSession(current, originalSession, oldPath, null).id, workspaceId);
  assert.notEqual(state.workspaceForSession(current, laterSession, oldPath, null).id, workspaceId);
});

test("rebind resolves newly found history against the directory table before the move", t => {
  const home=temp(t), workspaceId=randomUUID(), sessionId=randomUUID();
  const source=join(home,"source"), destination=join(home,"destination");
  state.createGuiWorkspace(home,args(workspaceId,"Existing Team",source));
  const input={workspaceId,operationId:randomUUID(),expectedRevision:0,path:destination,
    legacyBindings:[{sessionId,project:destination}]};
  assert.throws(()=>state.rebindGuiWorkspace(home,input,()=>{}),{code:"WORKSPACE_CONFLICT"});
  const unchanged=state.readGuiWorkspaces(home);
  assert.equal(unchanged.workspaces.length,1);
  assert.equal(unchanged.workspaces[0].project,source);
  const discovered=state.importGuiWorkspaceProjects(home,input.legacyBindings);
  const owner=state.workspaceForSession(discovered,sessionId,destination);
  assert.ok(owner && owner.id!==workspaceId);
  assert.throws(()=>state.rebindGuiWorkspace(home,input,()=>{}),{code:"WORKSPACE_CONFLICT"});

  const distinct=join(home,"distinct"), another=join(home,"another"), anotherSession=randomUUID();
  state.rebindGuiWorkspace(home,{...input,path:distinct,
    legacyBindings:[...input.legacyBindings,{sessionId:anotherSession,project:another}]},()=>{});
  const rebound=state.readGuiWorkspaces(home);
  assert.equal(state.workspaceForSession(rebound,sessionId,destination).id,owner.id);
  assert.equal(state.workspaceForSession(rebound,anotherSession,another).project,another);
  assert.ok(rebound.legacyMembership[anotherSession][another]);
});

test("deleting a Team frees its directory and preserves the ownership of older conversations", t => {
  const home = temp(t), workspaceId = randomUUID(), sessionId = randomUUID();
  const project = join(home, "shared-folder");
  state.createGuiWorkspace(home, args(workspaceId, "Original", project));
  state.importGuiWorkspaceProjects(home, [{sessionId, project}]);
  const remove = revision => state.deleteGuiWorkspace(home, {workspaceId, expectedRevision:revision});
  assert.throws(() => remove(1), {code:"WORKSPACE_CONFLICT"});
  remove(0);
  const replacement = state.createGuiWorkspace(home, args(randomUUID(), "Replacement", project));
  const disk = state.importGuiWorkspaceProjects(home, [{sessionId, project}]);
  assert.deepEqual(disk.workspaces.map(row => row.id), [replacement.id]);
  assert.equal(state.workspaceForSession(disk,sessionId,project), undefined);
  assert.equal(state.workspaceForSession(disk,sessionId,project,workspaceId), undefined);
  assert.throws(() => state.createGuiWorkspace(home,args(workspaceId,"Reuse")), {code:"WORKSPACE_CONFLICT"});
});
