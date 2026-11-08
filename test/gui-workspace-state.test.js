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
