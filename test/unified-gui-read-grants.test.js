import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import { fixtureConversation, seedFixtureConversationRepository } from './helpers/gui-controller-fixture.js';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {readTask} from '../src/task.js';
import { complete, controller } from "./unified-gui.fixture.js";

test('legacy editor read choice requires reselection before a model request, and the selected version can send',async t=>{
 const {editorTurnInput}=await import('../src/gui-turn-options.js');
 const f=await fixture(t),repo=repository(t),c=await controller(t,f);
 let session=seedFixtureConversationRepository(repo.project,await fixtureConversation(t,c));
 const input='Use the fixed project file';
 const legacy={id:randomUUID(),readAllowed:true,readPaths:'a.txt',readProject:session.project,readWorkspaceId:session.workspaceId};
 const location={project:session.project,workspaceId:session.workspaceId};
 const save=async turnOptions=>c.action('session.draft',{sessionId:session.id,text:input,workRequest:null,selectionId:null,
  editId:randomUUID(),expectedDraftRevision:session.draftRevision,branchAnchor:session.branchAnchor,turnOptions});
 session=await save(legacy);
 const request={sessionId:session.id,input,submissionId:randomUUID(),protocolVersion:1,editorEditId:session.editor.editId,readAuthorization:{paths:['a.txt']}};
 assert.throws(()=>editorTurnInput(session.editor.turnOptions,location),/重新选择项目文件/);
 await assert.rejects(c.action('task.submit',request),{code:'READ_VERSION'});
 assert.equal(f.calls.length,0);
 assert.equal((await c.session(session.id)).editor.editId,request.editorEditId);
 const {version}=await c.action('project.materials',{ownerId:session.id,source:'saved'});
 session=await save({...legacy,id:randomUUID(),readVersion:version});
 const selected=editorTurnInput(session.editor.turnOptions,location);
 const accepted=await c.action('task.submit',{...request,submissionId:randomUUID(),editorEditId:session.editor.editId,...selected});
 assert.equal((await complete(c,accepted.taskId)).status,'completed');
 assert.equal(readTask(f.home,accepted.taskId).readAuthorization.version,version);
 assert.equal(f.calls.length,1);
});
