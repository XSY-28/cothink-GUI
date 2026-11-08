import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {fixture} from '../helpers/pi-fixture.js';
import {repository} from '../helpers/git-fixture.js';
import {invoke} from '../helpers/cli-fixture.js';
import {execution} from '../helpers/agent-sync-fixture.js';
const root=resolve(process.env.COTHINK_TEST_PACKAGE_ROOT??fileURLToPath(new URL('../..',import.meta.url)));
const {saveConfig}=await import(pathToFileURL(join(root,'src/config.js')));
const {readTask}=await import(pathToFileURL(join(root,'src/task.js')));
const tool=(name,args={})=>({toolCalls:[{name,args}]});
const last=body=>JSON.parse(body.messages.findLast(m=>m.role==='tool').content);

test('real doc-maintenance is discovered/read by root, supervisor, worker and reviewer; worker runs actual checks', {timeout:90000},async t=>{
  assert.ok(process.env.COTHINK_TEST_DOC_SKILL&&process.env.COTHINK_TEST_SKILL_IMAGE,'Supply actual doc-maintenance skill and prepared immutable dependency image');
  const repo=repository(t);let supervisor,worker,reviewer,resultId,failure;const turns={main:0,r1:0,r2:0,r3:0};
  const command='mkdir -p /tmp/doc-runtime && cp -R /resources/doc-maintenance/scripts /tmp/doc-runtime/scripts && ln -s /opt/doc-maintenance/node_modules /tmp/doc-runtime/node_modules && node /tmp/doc-runtime/scripts/doc-maintenance.mjs check --root /workspace --files README.md --json';
  const f=await fixture(t,({body})=>{try{
    const n=++turns[body.model];
    if(n===1){assert.match(JSON.stringify(body.messages),/on-demand/);assert.doesNotMatch(JSON.stringify(body.messages),/帮助 coding agent 在现有仓库中维护/);return tool('read',{path:'skill:doc-maintenance/SKILL.md'});}
    if(body.model==='r1') {
      if(n===2)return tool('read',{path:'skill:doc-maintenance/references/verification.md'});
      if(n===3)return {text:'I understand the original documentation deliverable and the frozen skill limits.'};
      if(n===4)return tool('project_staff',{action:'appoint',input:{id:'doc',responsibility:'Write checked README',scope:['README.md'],models:['fixture/r2'],need:'deliverable',reason:'This group needs a documentation writer'}});
      if(n===5)return tool('delegate',{staffId:'doc',model:'fixture/r2',scope:['README.md'],readScope:['.'],assignment:'Write and check README using doc-maintenance',reason:'Assigned documentation responsibility'});
      if(n===6){worker=last(body).memberId;return tool('collect',{memberId:worker});}
      return {text:'Reviewed the exact employee README candidate and actual doc-maintenance check result.'};
    }
    if(body.model==='r2') {
      if(n===2)return tool('read',{path:'skill:doc-maintenance/references/checks.md'});
      if(n===3)return {text:'I understand the original goal; I will write README within the grant and run the real skill check.'};
      if(n===4)return tool('write',{path:'README.md',content:'# Local project\n\nRead the generated page locally.\n'});
      if(n===5)return tool('resource_exec',{command});
      if(n===6){const result=last(body);assert.equal(result.status,'completed',JSON.stringify(result));assert.match(result.stdout,/"ok":\s*true/);resultId=result.resultId;return tool('resource_result',{resultId,decision:'inspect'});}
      if(n===7)return tool('resource_result',{resultId,decision:'adopt',reason:'Actual read-only documentation checks passed; no unreviewed source delta'});
      return {text:'README and actual doc-maintenance checks are ready for review.'};
    }
    if(body.model==='r3') {
      assert.ok(!body.tools.some(t=>['resource_exec','write','bash'].includes(t.function.name)));
      if(n===2)return tool('read',{path:'skill:doc-maintenance/references/verification.md'});
      if(n===3)return tool('read',{path:'README.md'});
      return {text:'The exact candidate README is concise, readable and the stated local usage matches the original goal.'};
    }
    if(n===2)return tool('project_staff',{action:'appoint',input:{id:'lead',responsibility:'Coordinate documentation',scope:['README.md'],models:['fixture/r1','fixture/r2'],need:'deliverable',reason:'Documentation needs a group owner'}});
    if(n===3)return tool('project_staff',{action:'promote',input:{id:'lead',subgoal:'Deliver checked README',models:['fixture/r1','fixture/r2']}});
    if(n===4)return tool('delegate',{staffId:'lead',model:'fixture/r1',readOnly:true,scope:[],readScope:['.'],assignment:'Coordinate checked documentation',reason:'Owns the documentation group'});
    if(n===5){supervisor=last(body).memberId;return tool('collect',{memberId:supervisor});}
    if(n===6)return tool('collect',{memberId:worker});
    if(n===7)return tool('project_staff',{action:'appoint',input:{id:'review',responsibility:'Review exact README',scope:[],readScope:['README.md'],models:['fixture/r3'],need:'review',reason:'Check the employee candidate independently'}});
    if(n===8)return tool('delegate',{staffId:'review',model:'fixture/r3',reviewOf:worker,reviewKind:'ordinary',readOnly:true,scope:[],readScope:['README.md'],assignment:'Review README using actual skill guidance',reason:'Separate read-only reviewer'});
    if(n===9){reviewer=last(body).memberId;return tool('collect',{memberId:reviewer});}
    if(n===10||n===11)return tool('accept_change',{memberId:worker});
    return {text:'The checked and reviewed README is delivered.'};
  }catch(error){failure??=error;return {text:'Fixture assertion failure: '+error.message};}});
  saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[process.env.COTHINK_TEST_DOC_SKILL]},work:{execution:{...execution,image:process.env.COTHINK_TEST_SKILL_IMAGE}}});
  const plan=join(f.home,'plan.json');writeFileSync(plan,JSON.stringify({goal:'Use $doc-maintenance to write and check a concise README through a supervised worker and read-only review.',scope:['README.md'],budget:{maxCalls:40},deliverables:['README.md'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('README.md','utf8').includes('Local project'))process.exit(1)"]}]}));
  const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);if(failure)throw failure;
  assert.equal(run.code,0,run.stdout+run.stderr);const state=JSON.parse(run.stdout);assert.equal(state.status,'completed',state.blocker);
  const task=readTask(f.home,state.steps[0].attempts[0].taskId);
  const readers=new Set(task.tools.filter(x=>x.resourceName==='doc-maintenance').map(x=>x.actor));
  assert.equal(readers.size,4,JSON.stringify(task.tools.filter(x=>x.resourceName==='doc-maintenance')));
  const script=task.tools.find(x=>x.kind==='employee_script_result');assert.equal(script.parentActorId,'member:'+worker);assert.equal(script.treatment.decision,'adopted');
  assert.ok(task.members.find(m=>m.memberId===worker).supervisorMemberId===supervisor);
  assert.equal(task.work.acceptance.at(-1).status,'accepted');
  t.diagnostic(JSON.stringify({requests:f.calls.length,roles:[...readers],skillHash:task.work.skillResources[0].hash,image:process.env.COTHINK_TEST_SKILL_IMAGE}));
});

test('real frontend-design guides an employee page and the existing preview returns actual images',{timeout:60000},async t=>{
  assert.ok(process.env.COTHINK_TEST_DESIGN_SKILL,'Supply the selected real frontend-design skill');
  const repo=repository(t);let main=0,member=0,writer,failure,images=0;
  const f=await fixture(t,({body})=>{try{
    const names=body.tools.map(x=>x.function.name);
    if(names.includes('submit_visual_review')){assert.match(JSON.stringify(body),/data:image\/png;base64,/);images++;return tool('submit_visual_review',{verdict:'match',observation:'Cream page, dark serif heading, orange rule and short readable text.',reasons:'The page shows the requested library opening notice with the deliberate editorial layout.'});}
    if(body.model==='r1') {
      switch(++member) {
        case 1:assert.doesNotMatch(JSON.stringify(body),/This skill guides creation of distinctive/);return tool('read',{path:'skill:frontend-design/SKILL.md'});
        case 2:assert.match(JSON.stringify(body),/Typography/);return {text:'I understand the original library notice task and the actual design skill; choose a quiet editorial layout.'};
        case 3:return tool('write',{path:'index.html',content:'<!doctype html><html lang="en"><meta charset="utf-8"><title>Library hours</title><style>body{margin:10vh 10vw;background:#f4efdf;color:#25251e;font:22px Georgia,serif}h1{font-size:64px;border-top:5px solid #b54b27;padding-top:28px}p{max-width:34em;line-height:1.6}</style><h1>Library hours</h1><p>Open daily, 09:00–18:00. Bring a book, take a seat.</p></html>'});
        case 4:return tool('preview_html',{entry:'index.html',frameTimesMs:[0]});
        default:assert.match(JSON.stringify(body),/data:image\/png;base64,/);images++;return {text:'I inspected the actual page image; the serif editorial notice is readable.'};
      }
    }
    switch(++main) {
      case 1:return tool('read',{path:'skill:frontend-design/SKILL.md'});
      case 2:return tool('project_staff',{action:'appoint',input:{id:'designer',responsibility:'Design library notice',scope:['index.html'],models:['fixture/r1'],need:'deliverable',reason:'Needs an actual frontend executor'}});
      case 3:return tool('delegate',{staffId:'designer',model:'fixture/r1',scope:['index.html'],readScope:['.'],assignment:'Build and preview the library notice',reason:'Owns the frontend work'});
      case 4:writer=last(body).memberId;return tool('collect',{memberId:writer});
      case 5:case 6:return tool('accept_change',{memberId:writer});
      default:return {text:'Reviewed the actual page and accepted the employee candidate.'};
    }
  }catch(error){failure??=error;return {text:'Fixture assertion failure '+error.message};}});
  const modelFile=join(f.home,'pi/models.json'),models=JSON.parse(readFileSync(modelFile));for(const m of models.providers.fixture.models)m.input=['text','image'];writeFileSync(modelFile,JSON.stringify(models));
  const manifest=JSON.parse(readFileSync(join(root,'docker/visual-preview-manifest.json')));
  saveConfig(f.home,{formatVersion:2,...f.models,piResources:{skills:[process.env.COTHINK_TEST_DESIGN_SKILL]},work:{execution:{...execution,image:manifest.image}}});
  const plan=join(f.home,'plan.json');writeFileSync(plan,JSON.stringify({goal:'Use $frontend-design to create and preview a library hours notice with an editorial serif layout.',scope:['index.html'],budget:{maxCalls:25},deliverables:['index.html'],checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('index.html','utf8').includes('Library hours'))process.exit(1)"]}]}));
  const run=await invoke(f,['project','start','--file',plan,'--json'],'',repo.project);if(failure)throw failure;assert.equal(run.code,0,run.stdout+run.stderr);
  const state=JSON.parse(run.stdout),task=readTask(f.home,state.steps[0].attempts[0].taskId);assert.equal(state.status,'completed',state.blocker);assert.ok(images>=2);
  assert.ok(task.tools.some(x=>x.actor==='member:'+writer&&x.resourceName==='frontend-design'));
  assert.ok(task.work.visualEvidence.some(x=>x.actor==='member:'+writer&&x.result==='captured'));
});
