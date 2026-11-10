import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {cpSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const productRoot = resolve(
  process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("../..", import.meta.url)),
);
export const load = path => import(pathToFileURL(join(productRoot, path)));

const { saveConfig } = await load("src/config.js");
const { createTeamConfig } = await load("src/teams.js");
const {editorTurnInput}=await load("src/gui-turn-options.js");

// Save a real editor revision before a new submit. Reuse the returned args for receipt retries.
export async function prepareSubmit(c,{sessionId,input,turnOptions,constraints,budget,readAuthorization,...args}) {
  const current=await (c.session ? c.session(sessionId) : c.get("/api/session?id="+sessionId));
  const chosen=turnOptions??(constraints||budget||readAuthorization ? {
    id:randomUUID(),
    readOnly:constraints?.readOnly??false,
    delegate:constraints?.allowedSubtasks?.includes("work")??true,
    ...(constraints?.networkMode?{networkMode:constraints.networkMode}:{}),
    maxCalls:budget?.maxCalls==null?"":String(budget.maxCalls),
    ...(readAuthorization?{readAllowed:true,readPaths:readAuthorization.paths,readVersion:readAuthorization.version,
      readProject:current.project,readWorkspaceId:current.workspaceId??null}:{}),
  } : null);
  const saved=await c.action("session.draft",{sessionId,text:input,editorVersion:2,materials:[],editId:randomUUID(),
    expectedDraftRevision:current.draftRevision,branchAnchor:current.branchAnchor,workRequest:null,selectionId:null,turnOptions:chosen});
  return {sessionId,input,submissionId:randomUUID(),protocolVersion:1,...args,editorEditId:saved.editor.editId,materials:[],
    ...editorTurnInput(saved.editor.turnOptions,{project:saved.project,workspaceId:saved.workspaceId??null})};
}
export async function submitDraft(c,args) {
  return c.action("task.submit",await prepareSubmit(c,args));
}

export const teamId = "7c8094cd-3476-4bfa-8f53-055d87972896";

// A real writable Team outside COTHINK_HOME. Pass the same Team when a test
// compares conversations; pass the fixture's configured roster if not teamId.
export function fixtureWorkspace(t, api, {project, name, defaultRosterId=teamId}={}) {
  const workspaceId=randomUUID();
  if (!project) {
    project=mkdtempSync(join(tmpdir(),"cothink-gui-team-"));
    t.after(()=>rmSync(project,{recursive:true,force:true}));
  }
  return api.action("workspace.create",{workspaceId,project,name:name??"Fixture "+workspaceId.slice(0,8),defaultRosterId});
}

export async function fixtureConversation(t, api, {workspace, sessionId=randomUUID(), ...workspaceOptions}={}) {
  const owner=workspace??await fixtureWorkspace(t,api,workspaceOptions);
  return api.action("session.create",{workspaceId:owner.id,sessionId});
}
// Seed an already created conversation with a Git fixture without pointing it
// at the parent repository or granting access to a sibling fixture.
export function seedFixtureConversationRepository(project,room) {
  assert.ok(room.teamDirectory && room.project!==room.teamDirectory && room.project!==project);
  cpSync(project,room.project,{recursive:true});
  return room;
}

export const controllerModule = await load("src/gui-controller.js").catch(
  () => ({}),
);
export async function controller(t, f, extra = {}) {
  assert.equal(
    typeof controllerModule.createGuiController,
    "function",
    "GUI controller must exist",
  );
  saveConfig(
    f.home,
    createTeamConfig({ formatVersion: 2, ...f.models, ...extra }, "Fixture", teamId),
  );
  const c = await controllerModule.createGuiController({
    home: f.home,
    cwd: f.cwd,
  });
  t.after(() => c.close());
  return c;
}
export async function finished(c, id) {
  for (let n = 0; n < 500; n++) {
    const task = await c.task(id);
    if (task.status !== "running") return task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture task did not settle");
}
