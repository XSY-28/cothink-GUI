import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/pi-fixture.js";
import { repository, git } from "./helpers/git-fixture.js";
import { isPreparation, latest, outputs, projectDispatch, tool } from "./dispatch.fixture.js";

test("project cancellation during supervisor collect releases both seats and preserves the in-flight employee", { timeout:60000 }, async t => {
  const repo = repository(t), controller = new AbortController();
  let root = 0, supervisor = 0, current, managerId, employeeEntered = false, waitingAtCancel = false;
  const f = await fixture(t, async ({body}) => {
    if (body.model === "r2") {
      employeeEntered = true;
      // Wait for both the transport and the supervisor's saved handoff; no provider retry.
      while (!controller.signal.aborted && !current.record.members[0].waitingFor)
        await new Promise(resolve => setImmediate(resolve));
      waitingAtCancel = !!current.record.members[0].waitingFor;
      controller.abort();
      return null;
    }
    if (isPreparation(body)) return {text:"I understand the original goal."};
    if (body.model === "main") {
      if (++root === 1) return tool("delegate",{staffId:"compat",model:"fixture/r1",assignment:"Coordinate reader",reason:"Legacy data",readOnly:true});
      managerId = latest(body,r=>r.memberId)?.memberId;
      return tool("collect",{memberId:managerId});
    }
    if (++supervisor === 1) return tool("delegate",{staffId:"reader",model:"fixture/r2",assignment:"Inspect reader",reason:"Data formats",readOnly:true});
    return tool("collect");
  });
  const {task} = await projectDispatch(t,repo,f,{signal:controller.signal,onProgress:({task})=>{current=task;}});
  assert.ok(employeeEntered && waitingAtCancel);
  assert.ok(task.signal.aborted);
  const employee = task.record.members.find(m=>m.staffId==="reader");
  assert.ok(employee && ["cancelled","outcome_unknown"].includes(employee.status));
  assert.equal(f.calls.filter(c=>c.body.model==="r2").length,1);
  assert.ok(task.record.work.capacity.every(c=>c.active>=0 && c.active<=2));
  assert.equal(task.record.work.capacity.at(-1).active,0);
});

test("project pause fences a reviewed candidate before racing acceptance and preserves unrelated work", {timeout:30000}, async t=>{
  const repo=repository(t);
  const scope=["a.txt","b.txt"];
  const staffRows=scope.map((path,index)=>({
    id:"writer-"+index, supervisorId:"root", responsibility:"Edit "+path, models:["fixture/r"+(index+1)],
    scope:[path], readScope:[path], status:"active", canDelegate:false,
  }));
  const delegate=(index, assignment="Edit "+scope[index])=>tool("delegate",{
    staffId:"writer-"+index, model:"fixture/r"+(index+1), scope:[scope[index]], readScope:[scope[index]],
    assignment, reason:"Independent file",
  });
  let leader=0, first, sibling, pause, denied, held, wrongCandidate, reopened, reopenResult, reviewedAgain;
  const f=await fixture(t,({body})=>{
    if(isPreparation(body))return {text:"I independently understand the assigned file task."};
    if(body.model!=="main"){
      const index=body.model==="r1"?0:1;
      const toolResults=body.messages.filter(m=>m.role==="tool").length;
      if(toolResults===0)return tool("read",{path:scope[index]});
      if(toolResults===1)
        return tool("edit",{path:scope[index],edits:[{oldText:index?"base B":"base A",newText:index?"kept sibling":"retained draft"}]});
      return {text:"The private candidate is ready."};
    }
    switch(++leader){
      case 1:return delegate(0);
      case 2:first=latest(body,r=>r.memberId).memberId;return tool("collect",{memberId:first});
      case 3:return {toolCalls:[
        {name:"accept_change",args:{memberId:first}},
        {name:"pause_member",args:{memberId:first,reason:"Preserve this candidate for later resolution"}},
      ]};
      case 4:
        pause=latest(body,r=>r.status==="pausing");
        denied=latest(body,r=>r.error?.code==="GROUP_PAUSED");
        return delegate(0,"Restart the paused file with changed instructions");
      case 5:
        held=latest(body,r=>r.error?.code==="PROJECT_STAFF");
        return delegate(1);
      case 6:sibling=latest(body,r=>r.memberId).memberId;return tool("collect",{memberId:sibling});
      case 7:return tool("accept_change",{memberId:sibling});
      case 8:return tool("resume_candidate",{
        memberId:first, candidate:"forged-candidate", privateVersion:pause?.affected[0].pause.privateVersion,
        reason:"Continue from the preserved candidate",
      });
      case 9:
        wrongCandidate=latest(body,r=>r.error?.code==="GROUP_RESUME");
        return tool("resume_candidate",{
          memberId:first, candidate:pause?.affected[0].pause.candidate,
          privateVersion:pause?.affected[0].pause.privateVersion, reason:"Continue from the preserved candidate",
        });
      case 10:
        reopenResult=outputs(body).at(-1);
        reopened=latest(body,r=>r.status==="ready_for_root_review");
        return tool("accept_change",{memberId:first});
      case 11:
        reviewedAgain=latest(body,r=>r.status==="review_required");
        return tool("accept_change",{memberId:first});
      default:return {text:"The sibling and the explicitly continued candidate are accepted."};
    }
  });
  const {task,state}=await projectDispatch(t,repo,f,{scope,staffRows});
  const stopped=task.record.members.find(m=>m.memberId===first);
  const delivered=task.record.members.find(m=>m.memberId===sibling);
  assert.ok(pause,JSON.stringify(f.calls.at(-1)?.body.messages.slice(-6)));
  assert.equal(denied?.error?.code,"GROUP_PAUSED");
  assert.match(held?.error?.message ?? "", /original owner|held/i);
  assert.equal(stopped.pause.status,"settled");
  assert.equal(state.staffAssignments[first].pause.status,"settled");
  assert.ok(stopped.pause.candidate && stopped.pause.privateVersion);
  assert.equal(git(repo.project,"show",stopped.pause.privateVersion+":a.txt"),"retained draft");
  assert.equal(wrongCandidate?.error?.code,"GROUP_RESUME");
  assert.equal(reopened?.candidate,stopped.pause.candidate,JSON.stringify({
    reopenResult, snapshot:pause?.affected[0].pause.candidate, settled:stopped.pause.candidate,
  }));
  assert.equal(reviewedAgain?.privateVersion,stopped.pause.privateVersion);
  assert.equal(task.record.work.requests.filter(r=>r.action==="acceptChange"&&r.changeId===stopped.changeId&&r.dispatched).length,1);
  assert.equal(stopped.status,"accepted");
  assert.equal(stopped.acceptance.candidateVersion,stopped.pause.candidate);
  assert.equal(delivered.status,"accepted");
  assert.equal(git(repo.project,"show",delivered.acceptedVersion+":a.txt"),"base A");
  assert.equal(git(repo.project,"show",task.record.work.version+":a.txt"),"retained draft");
  assert.equal(git(repo.project,"show",task.record.work.version+":b.txt"),"kept sibling");
  assert.equal(f.calls.filter(c=>c.body.model==="r1").length,4);
});

test("project pause records a physically sent member stop as unknown under the original request", {timeout:30000}, async t=>{
  const repo=repository(t), entered=Promise.withResolvers();
  let leader=0, memberId, memberSends=0, denied;
  const f=await fixture(t,async({body})=>{
    if(body.model!=="main"){
      memberSends++;
      entered.resolve();
      return null;
    }
    switch(++leader){
      case 1:return tool("delegate",{
        staffId:"reader",model:"fixture/r1",scope:[],readScope:["a.txt"],readOnly:true,
        assignment:"Read the file",reason:"Independent observation",
      });
      case 2:
        memberId=latest(body,r=>r.memberId).memberId;
        await entered.promise;
        return tool("pause_member",{memberId,reason:"Stop the active read"});
      case 3:return tool("resume_candidate",{
        memberId,candidate:"invented-candidate",privateVersion:"invented-version",reason:"Attempt to continue",
      });
      default:
        denied=latest(body,r=>r.error?.code==="GROUP_RESUME");
        return {text:"The original read result remains unknown."};
    }
  });
  const {task,state}=await projectDispatch(t,repo,f,{staffRows:[{
    id:"reader",supervisorId:"root",responsibility:"Read file",models:["fixture/r1"],
    scope:[],readScope:["a.txt"],status:"active",canDelegate:false,
  }]});
  const member=task.record.members.find(m=>m.memberId===memberId);
  const request=task.requests().find(r=>r.role==="member:"+memberId);
  assert.equal(memberSends,1);
  assert.equal(denied?.error?.code,"GROUP_RESUME");
  assert.equal(request.status,"outcome_unknown");
  assert.equal(member.pause.status,"unknown");
  assert.equal(state.staffAssignments[memberId].status,"unknown");
  assert.ok(member.pause.requests.some(r=>r.id===request.id&&r.sent&&r.status==="outcome_unknown"&&r.usage===null));
});

test("a blocked worker asks only its direct supervisor, which may forward the original request", {timeout:30000}, async t=>{
  const repo=repository(t);
  let root=0, supervisor=0, employee=0, supervisorId, memberId, directReport, forwardedReport, denied;
  const report={blocker:"The independent check requires another peer",scope:["a.txt"],dependsOn:["reader:a.txt"],maxCalls:2};
  const delegate=(staffId,model)=>tool("delegate",{
    staffId,model,scope:[],readScope:["a.txt"],readOnly:true,
    assignment:"Inspect the dependency for "+staffId,reason:"Separate bounded responsibility",
  });
  const f=await fixture(t,({body})=>{
    if(isPreparation(body))return {text:"I understand the original file task."};
    if(body.model==="main"){
      switch(++root){
        case 1:return delegate("compat","fixture/r1");
        case 2:supervisorId=latest(body,r=>r.memberId).memberId;return tool("collect",{memberId:supervisorId});
        case 3:
          forwardedReport=latest(body,r=>r.members)?.members[0]?.staffGroupRequests?.[0];
          return tool("collect",{memberId});
        default:
          assert.equal(latest(body,r=>r.members)?.members[0]?.staffGroupRequests,undefined);
          return {text:"The forwarded request is recorded for the authorized group owner."};
      }
    }
    if(body.model==="r1"){
      switch(++supervisor){
        case 1:return delegate("reader","fixture/r2");
        case 2:memberId=latest(body,r=>r.memberId).memberId;return tool("collect",{memberId});
        case 3:
          directReport=latest(body,r=>r.members)?.members[0]?.staffGroupRequests?.[0];
          return tool("request_staff_group",{forwardRequestId:"unknown-source"});
        case 4:
          denied=latest(body,r=>r.error?.code==="GROUP_REPORT");
          if(directReport)return tool("request_staff_group",{forwardRequestId:directReport.id});
      }
      return {text:"Forwarded the concrete blocker to my leader."};
    }
    if(++employee===1)return tool("request_staff_group",report);
    return {text:"Inspection depends on the reported peer check."};
  });
  const {task}=await projectDispatch(t,repo,f);
  assert.ok(directReport && forwardedReport);
  assert.equal(denied?.error?.code,"GROUP_REPORT");
  assert.equal(forwardedReport.forwardedFrom,directReport.id);
  assert.deepEqual(forwardedReport.proposal,report);
  assert.equal(directReport.dispatchId,memberId);
  assert.equal(forwardedReport.dispatchId,supervisorId);
  assert.ok(task.requests().some(r=>r.id===directReport.requestId&&r.role==="member:"+memberId&&r.sent));
  assert.ok(task.requests().some(r=>r.id===forwardedReport.requestId&&r.role==="member:"+supervisorId&&r.sent));
});
