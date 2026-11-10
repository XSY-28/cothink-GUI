import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { workModelIdentity } from "./workers.js";
import { readTask, readRequest, readRequests, problem } from "./task.js";
import { createVersioning, inScope, projectScopesOverlap, validProjectPath } from "./versioning.js";
import { validateProjectBudget } from "./project-request-accounting.js";
export { projectUsage, reconcileProjectCalls, validateProjectBudget } from "./project-request-accounting.js";

const fail = (code, message) => {
  throw problem(code, message);
};
const routeError = (message) => fail("PROJECT_ROUTE", message);
const stamp = () => new Date().toISOString();
function ranges(paths, allowed) {
  if (!Array.isArray(paths) || paths.some((path) => !validProjectPath(path, true) || !inScope(path, allowed)))
    fail("PROJECT_SCOPE", "Requested paths exceed the project's authorized scope");
}

function live(state, binding) {
  if (state.id !== binding.projectId)
    fail("PROJECT_STALE", "Project or goal revision changed; old authority is closed");
  if (state.status === "paused" || state.paused === true)
    fail("PROJECT_PAUSED", "User paused this project; no new actions are admitted");
  const step = state.steps.find((s) => s.id === binding.stepId);
  if (!step || step.revision !== binding.revision)
    fail("PROJECT_STALE", "Project step or its goal revision changed");
  return step;
}
function checkBinding(state, binding) {
  const step = live(state, binding);
  if (
    step.attempts.at(-1)?.taskId !== binding.taskId ||
    ["completed", "delivered", "cancelled"].includes(step.status)
  )
    fail("PROJECT_STALE", "Task no longer owns this step");
  return step;
}

export function recordRouteObservation(
  state,
  stepId,
  { candidate, kind, evidence, changeId, privateVersion, taskId, actor },
) {
  const step = state.steps.find((s) => s.id === stepId);
  if (!step || !candidate || !evidence)
    routeError("A route observation needs a frozen candidate and host evidence");
  let route = step.route;
  if (route && route.revision === step.revision) {
    if (kind === "checkpoint" && route.kind === "checkpoint") return route;
    if (kind !== "checkpoint") {
      if (route.candidate === candidate && route.evidence.requestId === evidence.requestId) return route;
      if (["repair", "resolved"].includes(route.status)) {
        route.status = "blocked";
        route.recheck = { candidate, evidence, at: stamp() };
        step.status = "review";
      }
      return route;
    }
    if (route.status !== "resolved") return route;
  }
  route = {
    projectId: state.id,
    revision: step.revision,
    stepId,
    candidate,
    taskId,
    changeId,
    privateVersion,
    actor,
    kind,
    evidence,
    status: kind === "environment" ? "blocked" : "paused",
    at: stamp(),
  };
  if (step.route) (step.routeHistory ??= []).push(step.route);
  step.route = route;
  step.status = "review";
  return route;
}

function activeRoute(state, input) {
  const step = live(state, { projectId: state.id, stepId: input.stepId, revision: input.revision });
  const route = step.route;
  if (
    !route ||
    route.projectId !== state.id ||
    route.revision !== input.revision ||
    route.candidate !== input.candidate
  )
    routeError("Decision does not match current project, goal revision and immutable candidate");
  return { step, route };
}

function judge(state, input) {
  const { step, route } = activeRoute(state, input);
  if (route.status !== "paused") routeError("This route has no unused read-only judgment");
  const { path, contains, ifPresent, ifAbsent, reason, repairScope } = input;
  const choices =
    route.kind === "checkpoint"
      ? ["continue", "blocked", "repair", "shorten"]
      : ["repair", "shorten", "blocked"];
  const needsEdit = [ifPresent, ifAbsent].some((choice) => ["repair", "shorten"].includes(choice));
  if (
    typeof reason !== "string" ||
    !reason.trim() ||
    !validProjectPath(path) ||
    path === "." ||
    typeof contains !== "string" ||
    !contains.trim() ||
    ifPresent === ifAbsent ||
    ![ifPresent, ifAbsent].every((choice) => choices.includes(choice)) ||
    (needsEdit && !repairScope?.length)
  )
    routeError(
      "Name a file, a concrete discriminator, two different decisions, why it distinguishes them and a repair scope",
    );
  ranges(repairScope ?? [], step.scope);
  route.judgment = {
    id: randomUUID(),
    path,
    contains,
    ifPresent,
    ifAbsent,
    reason,
    repairScope: [...(repairScope ?? [])],
    at: stamp(),
  };
  route.status = "judged";
  return route;
}

// One read-only discriminating experiment over immutable candidate bytes. Neither models nor
// control clients supply the observed result. Persist intent first; uncertain probes never replay.
export async function runProjectRoute({ host, home, action, input, versioning }) {
  host.assertOwned();
  if (action === "judge") return host.update((state) => judge(state, input));
  if (action !== "experiment") routeError("Choose judge or experiment");
  const { repo, route } = host.update((state) => {
    const { route } = activeRoute(state, input);
    if (route.status !== "judged") routeError("This candidate has no unused experiment");
    route.status = "probing";
    route.probe = { id: randomUUID(), at: stamp() };
    return { repo: state.repo, route: structuredClone(route) };
  });
  let v;
  try {
    v = versioning ?? (await createVersioning({ home, project: repo, readOnly: true }));
    host.assertOwned();
    activeRoute(host.read(), input);
    const file = await v.read({ version: route.candidate, path: route.judgment.path });
    if (file.version !== route.candidate) routeError("Probe returned a different version");
    const present =
      file.contentBase64 !== null &&
      Buffer.from(file.contentBase64, "base64").includes(Buffer.from(route.judgment.contains));
    return host.update((state) => {
      const current = activeRoute(state, input);
      if (current.route.status !== "probing" || current.route.probe.id !== route.probe.id)
        routeError("Probe authority changed");
      const decision = present ? route.judgment.ifPresent : route.judgment.ifAbsent;
      Object.assign(current.route.probe, {
        path: route.judgment.path,
        contentHash: file.contentHash,
        present,
        decision,
        completedAt: stamp(),
      });
      if (decision === "continue") {
        const attempt = current.step.attempts.at(-1);
        if (attempt?.status !== "completed" || attempt.version !== current.route.candidate)
          routeError("Cannot release checkpoint without the successful verified artifact on this version");
        current.route.status = "resolved";
        current.step.status = "completed";
      } else {
        current.route.status = decision === "blocked" ? "blocked" : "repair";
        current.step.status = decision === "blocked" ? "review" : "pending";
        const assignments = Object.values(state.staffAssignments ?? {});
        const employee = assignments.find(
          (a) => a.taskId === current.route.taskId && a.role === current.route.actor,
        );
        if (decision !== "blocked" && employee) {
          const supervisor = assignments.find(
            (a) => a.taskId === employee.taskId && a.staffId === employee.actor,
          );
          current.route.next = supervisor
            ? {
                tool: "feedback",
                memberId: supervisor.dispatchId,
                coordinateMemberId: employee.dispatchId,
                reason:
                  "Resume the original supervisor to review and correct their employee’s diagnosed candidate",
              }
            : {
                tool: "feedback",
                memberId: employee.dispatchId,
                reason: "Give the original employee the observed counterexample",
              };
        }
      }
      return current.route;
    });
  } catch (error) {
    host.update((state) => {
      const step = state.steps.find((s) => s.id === input.stepId);
      if (step?.route?.probe?.id === route.probe.id) {
        step.route.status = "blocked";
        step.route.probe.error = error.message;
      }
    });
    throw error;
  } finally {
    if (!versioning) await v?.close();
  }
}

export function createProjectPolicy({ host, binding, staff, home }) {
  const pendingEffects = new Map();
  const issuedSends = new WeakMap();
  const processStages = new WeakMap();
  const pluginCapabilities = new WeakMap();
  const nativeCapabilities=new WeakMap(),nativeStages=new WeakMap(),nativeByLaunch=new Map();
  const mcpCapabilities = new WeakMap();
  const mcpRecoveries=new Map();
  function issuePluginCapability(spec) {
    host.assertOwned();
    const state = host.read(); checkBinding(state, binding);
    if (!binding.plugins?.includes(spec.selection) || !spec.sessionId || !spec.actor || !spec.changeId || !spec.inputVersion || !spec.sourceDigest)
      fail("PROJECT_PLUGIN_UNBOUND", "A selected frozen source and owning session/change are required");
    ranges(spec.scope ?? [], binding.scope);
    if(binding.rootTaskId)ranges(spec.readScope??[],binding.readScope);
    staff?.checkWork?.({taskId:binding.taskId,role:spec.actor,action:"read",scope:spec.scope,readScope:spec.readScope});
    const capability = Object.freeze({});
    pluginCapabilities.set(capability, Object.freeze({...spec,scope:[...(spec.scope ?? [])],readScope:[...(spec.readScope ?? [])]}));
    return capability;
  }
  function checkPlugin(detail) {
    const spec = pluginCapabilities.get(detail.capability);
    if (!spec || !binding.plugins?.includes(spec.selection)) fail("PROJECT_PLUGIN_UNBOUND", "Only the selected host-issued controlled runtime has project authority");
    for (const key of ["actor","sessionId","changeId","inputVersion","sourceDigest","registrationVersion","readOnly"])
      if (detail[key] !== spec[key]) fail("PROJECT_PLUGIN_STALE", "Controlled plugin binding changed: " + key);
    if (JSON.stringify(detail.scope) !== JSON.stringify(spec.scope) || JSON.stringify(detail.readScope) !== JSON.stringify(spec.readScope))
      fail("PROJECT_PLUGIN_STALE", "Controlled plugin scope changed; stop and rebuild old handles");
    staff?.checkWork?.({taskId:binding.taskId,role:spec.actor,action:"read",scope:spec.scope,readScope:spec.readScope});
    if (!["load","tool","command","event","host","resume","import"].includes(detail.operation)) fail("PROJECT_PLUGIN_UNBOUND", "Unsupported managed operation");
  }
  function issueNativeHelper(spec) {
    if(binding.constraints && !binding.constraints.allowedSubtasks.includes("work"))fail("ROOT_SUBTASK","This root forbids plugin helpers");
    host.assertOwned();const state=host.read(),step=checkBinding(state,binding);
    const source=pluginCapabilities.get(spec.pluginCapability),parent=spec.parentHelperId?nativeByLaunch.get(spec.parentHelperId):nativeCapabilities.get(spec.parentCapability);
    if(!source||!binding.plugins?.includes(source.selection)||!spec.task||spec.task.record.id!==binding.taskId||
      !spec.launchId||nativeByLaunch.has(spec.launchId)||spec.creatorRole!==source.actor||spec.creatorSessionId!==source.sessionId)
      fail('PROJECT_NATIVE_UNBOUND','Native launch needs its actual selected plugin creator/session and a unique host identity');
    admit('plugin',{...source,capability:spec.pluginCapability,operation:'host'});
    if(spec.parentHelperId&&(!parent||parent.closed||parent.creatorRole!==spec.creatorRole))fail('PROJECT_NATIVE_UNBOUND','Nested creator is not an active helper of this owner');
    for(const key of ['changeId','inputVersion','readOnly'])if(spec[key]!==source[key])fail('PROJECT_NATIVE_UNBOUND','Native input differs from its creator: '+key);
    const basis=parent??source;ranges(spec.scope??[],basis.scope??[]);ranges(spec.readScope??[],[...(basis.scope??[]),...(basis.readScope??[])]);
    if(basis.readOnly&&(!spec.readOnly||spec.scope?.length))fail('PROJECT_NATIVE_UNBOUND','Read-only authority cannot create a writer');
    const refs=[spec.task.record.models.main,...(spec.task.record.models.secondary??[])];
    const modelRef=refs.find(ref=>ref.provider===spec.modelRef?.provider&&ref.modelId===spec.modelRef?.modelId);
    if(!modelRef)fail('PROJECT_NATIVE_UNBOUND','Helper model is not in the frozen task roster');
    staff?.checkWork?.({taskId:binding.taskId,role:spec.creatorRole,action:'read',scope:spec.scope,readScope:spec.readScope,model:modelRef});
    const assignment=assignmentOf(state,spec.creatorRole);
    if(!assignment&&!spec.readOnly)staff?.claimWrite?.({taskId:binding.taskId,role:spec.creatorRole,scope:spec.scope,changeId:spec.changeId});
    const workIds=assignment?[assignment.workId]:[...new Set((host.read().rootWorkClaims??[]).filter(c=>c.taskId===binding.taskId&&c.changeId===spec.changeId).map(c=>c.workId))];
    if(!workIds.length&&spec.readOnly)for(const work of [...(step.works??[]),...(step.subworks??[])])if(work.scope.some(path=>inScope(path,spec.readScope??[])))workIds.push(work.id);
    if(spec.workId&&!workIds.includes(spec.workId))fail('PROJECT_NATIVE_UNBOUND','Native launch cannot select another project work');
    const capability=Object.freeze({}),grant={...spec,modelRef:structuredClone(modelRef),scope:[...(spec.scope??[])],readScope:[...(spec.readScope??[])],
      workIds,workId:spec.workId??(workIds.length===1?workIds[0]:null),parent,source,role:'helper:'+spec.launchId,sessionId:undefined,closed:false};
    nativeCapabilities.set(capability,grant);nativeByLaunch.set(spec.launchId,grant);return capability;
  }
  function checkNative(grant,operation='model',paths) {
    if(binding.constraints?.readOnly && ['write','shell','launch'].includes(operation))fail('ROOT_READ_ONLY','Root forbids native effects');
    host.assertOwned();checkBinding(host.read(),binding);
    if(!grant||grant.closed||grant.task.signal?.aborted||grant.task.record.status!=='running')fail('PROJECT_NATIVE_STALE','Native helper no longer owns live task authority');
    if(grant.parent)checkNative(grant.parent,'read');
    admit('plugin',{...grant.source,capability:grant.pluginCapability,operation:'host'});
    if(!['start','model','read','write','shell','launch'].includes(operation))fail('PROJECT_NATIVE_UNBOUND','Unsupported native helper action');
    if(['write','shell'].includes(operation)){if(grant.readOnly)fail('PROJECT_NATIVE_UNBOUND','Read-only helper cannot write or execute shell');ranges(paths??grant.scope,grant.scope);}
    staff?.checkWork?.({taskId:binding.taskId,role:grant.creatorRole,action:['write','shell'].includes(operation)?operation:'read',scope:paths??grant.scope,readScope:grant.readScope,model:grant.modelRef});
    if(operation==='model'&&!grant.sessionId)fail('PROJECT_NATIVE_UNBOUND','Native SDK session has not been bound');
    return grant;
  }
  function admitNativeHelper(capability,{operation='model',scope}={}){return checkNative(nativeCapabilities.get(capability),operation,scope);}
  function bindNativeHelperSession(capability,{task,stage,sessionId}) {
    const grant=checkNative(nativeCapabilities.get(capability),'start');
    if(task!==grant.task||!task.record.stages.includes(stage)||stage.role!==grant.role||stage.phase!=='project-native-helper'||
      stage.modelRef.provider!==grant.modelRef.provider||stage.modelRef.modelId!==grant.modelRef.modelId||!sessionId||grant.sessionId&&grant.sessionId!==sessionId)
      fail('PROJECT_NATIVE_UNBOUND','Native stage/session differs from its host-admitted launch');
    grant.sessionId=sessionId;grant.stage=stage;stage.sessionId=sessionId;stage.nativeLaunchId=grant.launchId;stage.creatorRole=grant.creatorRole;
    nativeStages.set(stage,grant);
  }
  function closeNativeHelper(capability){const grant=nativeCapabilities.get(capability);if(grant)grant.closed=true;}
  function originalNativeAuthority(source,task) {
    host.assertOwned();const state=host.read(),step=state.steps.find(s=>s.id===binding.stepId);
    if(!source||state.id!==binding.projectId||!step?.attempts.some(a=>a.taskId===binding.taskId&&(a.revision===undefined||a.revision===binding.revision)))
      fail('PROJECT_NATIVE_UNBOUND','Cleanup no longer refers to this original project attempt');
    return {projectActive:!state.paused&&state.status!=='paused'&&step.revision===binding.revision&&step.attempts.at(-1)?.taskId===binding.taskId&&
      (!task||task.record.status==='running'&&!task.signal?.aborted),creatorRole:source.actor,sourceDigest:source.sourceDigest};
  }
  function admitNativeCleanup(capability,{operation}={}) {
    if(!['cancelModel','terminal','finished'].includes(operation))fail('PROJECT_NATIVE_UNBOUND','Native cleanup cannot start new work');
    const grant=nativeCapabilities.get(capability);if(!grant)fail('PROJECT_NATIVE_UNBOUND','Cleanup needs the original host-issued helper handle');
    return originalNativeAuthority(grant.source,grant.task);
  }
  function checkOriginalPluginCapability(capability,{operation}={}) {
    if(!['runnerClose','runnerDone','operationReturned'].includes(operation))fail('PROJECT_NATIVE_UNBOUND','Original plugin cleanup is limited to recorded runner settlement');
    return originalNativeAuthority(pluginCapabilities.get(capability));
  }
  function issueMcpCapability(spec) {
    host.assertOwned(); checkBinding(host.read(), binding);
    const selected = binding.mcp?.find(s => s.server === spec.server);
    if (!selected || !spec.actor || !spec.sessionId || !spec.sourceDigest || !spec.changeId || !spec.inputVersion)
      fail("PROJECT_MCP_UNBOUND", "MCP needs a confirmed server and an actual owning session/change");
    ranges(spec.scope ?? [], binding.scope);
    if(binding.rootTaskId)ranges(spec.readScope??[],binding.readScope);
    staff?.checkWork?.({taskId:binding.taskId,role:spec.actor,action:"read",scope:spec.scope,readScope:spec.readScope});
    const capability=Object.freeze({});mcpCapabilities.set(capability,structuredClone(spec));return capability;
  }
  function issueMcpRecoveryCapability(spec,originalRequestId) {
    host.assertOwned();const state=host.read(),step=state.steps.find(s=>s.id===binding.stepId);
    const claim=state.callIntents?.find(c=>c.kind==="external"&&c.id===originalRequestId&&c.taskId===binding.taskId&&c.role===spec.actor&&c.sessionId===spec.sessionId&&c.sourceDigest===spec.sourceDigest&&c.server===spec.server);
    const historical=spec.cleanupOnly&&spec.localNoNetwork&&/^[a-f0-9]{64}$/.test(spec.containerProofDigest??'')&&claim?.containerProofDigest===spec.containerProofDigest&&
      step?.attempts.some(a=>a.taskId===binding.taskId&&(a.revision===undefined||a.revision===binding.revision));
    if(!claim||state.id!==binding.projectId||(!historical&&(step?.revision!==binding.revision||step.attempts.at(-1)?.taskId!==binding.taskId)))
      fail("PROJECT_MCP_RECOVERY","Original MCP receipt no longer belongs to this task/revision/source");
    if(spec.cleanupOnly&&!historical)fail('PROJECT_MCP_RECOVERY','Original command container has no matching persisted identity proof');
    const capability=Object.freeze({});mcpCapabilities.set(capability,structuredClone(spec));return capability;
  }
  function admitMcp(detail) {
    if(binding.constraints?.readOnly && ["write","start"].includes(detail.kind))fail("ROOT_READ_ONLY","Root forbids MCP effects");
    host.assertOwned();const state=host.read(), spec=mcpCapabilities.get(detail.capability);
    if (!spec) fail("PROJECT_MCP_UNBOUND", "MCP authority must be issued by the owning project");
    const recovery=["query","cancel","close"].includes(detail.kind);
    if (recovery) {
      const step=state.steps.find(s=>s.id===binding.stepId);
      const historical=spec.cleanupOnly&&spec.localNoNetwork&&detail.localProcessCleanup&&['query','cancel'].includes(detail.kind)&&
        step?.attempts.some(a=>a.taskId===binding.taskId&&(a.revision===undefined||a.revision===binding.revision));
      if(state.id!==binding.projectId||(!historical&&(step?.revision!==binding.revision||step.attempts.at(-1)?.taskId!==binding.taskId)))
        fail("PROJECT_STALE","Original MCP receipt belongs to a different task or revision");
    } else {checkBinding(state,binding);admit("read",{actor:spec.actor});}
    for(const key of ["actor","sessionId","sourceDigest","server","changeId","inputVersion","readOnly","registrationVersion"])
      if(detail[key]!==spec[key])fail("PROJECT_MCP_STALE","MCP source, actor, session or input authority changed");
    if(JSON.stringify(detail.scope)!==JSON.stringify(spec.scope)||JSON.stringify(detail.readScope)!==JSON.stringify(spec.readScope))
      fail("PROJECT_MCP_STALE","MCP scope changed; stop the old service before rebuilding");
    if(spec.cleanupOnly) {
      const original=state.callIntents?.find(c=>c.kind==='external'&&c.id===detail.original?.id&&c.taskId===binding.taskId&&c.role===spec.actor&&c.server===spec.server&&c.sourceDigest===spec.sourceDigest);
      if(!spec.localNoNetwork||!detail.localProcessCleanup||!['query','cancel'].includes(detail.kind)||detail.tool||!original||
        detail.containerProofDigest!==spec.containerProofDigest||original.containerProofDigest!==spec.containerProofDigest)
        fail('PROJECT_MCP_RECOVERY','Local cleanup may only inspect or stop its original proven container');
      const currentStep=state.steps.find(s=>s.id===binding.stepId),stillCurrent=currentStep?.revision===binding.revision&&currentStep.attempts.at(-1)?.taskId===binding.taskId;
      if(detail.kind==='cancel'&&stillCurrent&&!state.paused&&state.status!=='paused'&&(state.callIntents??[]).some(c=>c.kind==='external'&&!c.notSent&&c.id!==original.id&&c.containerProofDigest===spec.containerProofDigest&&c.status!=='completed'))
        fail('PROJECT_MCP_SHARED_RUNTIME','Other unresolved jobs share this original container. Pause the whole project before stopping their shared process.');
      return;
    }
    if(detail.kind==="close")return;
    if(!spec.localNoNetwork&&state.budget?.maxCost!=null)
      fail("PROJECT_BUDGET","No enforceable MCP fee bound for connection/discovery or operation; hard cost cap prevents URL sending");
    if(recovery&&!detail.original)fail("PROJECT_MCP_RECOVERY","Recovery requires an original task-owned receipt");
    if(recovery) {
      const original=state.callIntents?.find(c=>c.kind==="external"&&c.id===detail.original.id&&c.taskId===binding.taskId&&c.role===spec.actor&&c.server===spec.server);
      if(!original)fail("PROJECT_MCP_RECOVERY","Recovery may only inspect the original owned operation");
    } else staff?.checkWork?.({taskId:binding.taskId,role:spec.actor,action:"read",scope:spec.scope,readScope:spec.readScope});
    if(detail.protocolCancellation) {
      const original=state.callIntents?.find(c=>c.kind==="external"&&c.id===detail.original?.id&&c.taskId===binding.taskId&&c.role===spec.actor&&c.server===spec.server);
      if(detail.kind!=="cancel"||!original||detail.requestId!==original.id||detail.tool!==original.tool||!isDeepStrictEqual(detail.args,original.args)||detail.original.protocolRequestId!==detail.protocolRequestId||detail.protocolRequestId==null)
        fail("PROJECT_MCP_RECOVERY","Protocol cancellation must address the exact original sent RPC");
      return; // This is notifications/cancelled, never a new business tools/call.
    }
    if(spec.readOnly&&["write","start","cancel"].includes(detail.kind))fail("PROJECT_MCP_READONLY","This employee has no write authority");
    if(detail.tool) {
      const grant=binding.mcp.find(s=>s.server===spec.server)?.tools?.[detail.tool];
      if(!grant||grant.kind!==detail.kind)fail("PROJECT_MCP_UNBOUND","Tool operation differs from the confirmed service contract");
      if(!["query","cancel"].includes(grant.kind)&&!grant.allowedArguments.some(args=>isDeepStrictEqual(args,detail.args)))
        fail("PROJECT_MCP_ARGUMENTS","Transport arguments exceed the confirmed exact parameter scope");
      if(["query","cancel"].includes(grant.kind)) {
        const original=state.callIntents.find(c=>c.kind==="external"&&c.id===detail.original.id&&c.taskId===binding.taskId);
        const recovery=grant.recovery,jobId=original.jobId??original.args?.[recovery.sourceArgument];
        if(original.tool!==recovery.originalTool||!jobId||!isDeepStrictEqual(detail.args,{[recovery.jobArgument]:jobId}))
          fail("PROJECT_MCP_RECOVERY","Recovery endpoint/arguments do not match the original saved job");
      }
      if(state.budget?.maxCost!==null&&state.budget?.maxCost!==undefined) {
        // A plan's fee assertion is not an invoice or an enforced provider cap.
        // Only this host-issued offline command boundary proves no remote charge.
        if(!spec.localNoNetwork)fail("PROJECT_BUDGET","No provider-enforced MCP fee boundary; hard cost cap prevents URL sending");
        const used=(state.callIntents??[]).filter(c=>!c.notSent&&c.kind==="external"&&c.id!==detail.requestId).reduce((n,c)=>n+(c.costBound??Infinity),0);
        if((state.callIntents??[]).some(c=>c.kind!=="external"&&!c.notSent)||used>state.budget.maxCost)
          fail("PROJECT_BUDGET","Project hard cost cap has no remaining proven upper bound");
      }
    }
  }
  function claimMcpEffect(detail) {
    admitMcp(detail);
    const spec=mcpCapabilities.get(detail.capability);let state=host.read();const step=checkBinding(state,binding);
    const work=(step.works??[]).find(w=>w.id===detail.workId);
    if(!work)fail("PROJECT_MCP_WORK","Choose an existing authorized project work");
    ranges(work.scope,[...spec.scope,...(["read"].includes(detail.kind)?spec.readScope:[])]);
    const assignment=assignmentOf(state,spec.actor);
    if(assignment&&(assignment.workId!==work.id||assignment.readOnly&&["write","start"].includes(detail.kind)))
      fail("PROJECT_MCP_WORK","Employee does not own this work");
    if(!assignment&&!spec.readOnly) {
      staff?.claimWrite?.({taskId:binding.taskId,role:spec.actor,scope:work.scope,changeId:spec.changeId});state=host.read();
      if(!state.rootWorkClaims?.some(c=>c.taskId===binding.taskId&&c.workId===work.id&&c.changeId===spec.changeId))
        fail("PROJECT_MCP_WORK","Root must claim the exact work and change before using MCP");
    }
    const effect=["write","start"].includes(detail.kind)?work.effect:null;
    const grant=binding.mcp.find(s=>s.server===spec.server).tools[detail.tool];
    if(effect&&JSON.stringify([effect.target,effect.action,effect.round])!==JSON.stringify([grant.target,grant.action,grant.round]))
      fail("PROJECT_MCP_EFFECT","Confirmed tool target/action/round differs from the work effect");
    if(["write","start"].includes(detail.kind)&&!effect)fail("PROJECT_MCP_EFFECT","A mutation needs its explicitly confirmed work effect");
    const prior=(state.callIntents??[]).find(c=>!c.notSent&&(c.id===detail.requestId||effect&&sameEffect(c.effect,effect)));
    if(prior) {
      if(prior.kind!=="external"||prior.payloadDigest!==detail.payloadDigest||prior.server!==spec.server||prior.sourceDigest!==spec.sourceDigest)
        fail("PROJECT_EFFECT_HELD","Original effect has a different source or parameters: "+prior.id);
      return {...structuredClone(prior),reused:true};
    }
    const pending=(state.callIntents??[]).find(c=>c.kind==="external"&&!c.notSent&&c.workId===work.id&&!["completed","not_sent"].includes(c.status));
    if(pending)fail("PROJECT_EFFECT_HELD","Inspect the original unresolved work effect "+pending.id);
    const claim={kind:"external",id:detail.requestId,taskId:binding.taskId,role:spec.actor,sessionId:spec.sessionId,server:spec.server,
      sourceDigest:spec.sourceDigest,workId:work.id,scope:work.scope,tool:detail.tool,args:structuredClone(detail.args),payloadDigest:detail.payloadDigest,
      ...(spec.containerProofDigest?{containerProofDigest:spec.containerProofDigest}:{}),
      ...(effect?{effect}:{}),costBound:spec.localNoNetwork?0:null,actualCost:null,status:"intent",at:stamp()};
    host.update(s=>{checkBinding(s,binding);(s.callIntents??=[]).push(claim);});return structuredClone(claim);
  }
  function observeMcpRequest(receipt) {
    host.assertOwned();host.update(s=>{
      const claim=s.callIntents?.find(c=>c.kind==="external"&&c.id===receipt.id&&c.taskId===binding.taskId);
      if(!claim)return;
      for(const key of ["status","sent","jobId","result","error","completedAt"])if(receipt[key]!==undefined)claim[key]=structuredClone(receipt[key]);
      if(receipt.status==="not_sent")claim.notSent=true;
      if(receipt.sent&&claim.effect) {
        const fact={taskId:binding.taskId,role:claim.role,workId:claim.workId,requestId:claim.id,sourceTaskId:binding.taskId,kind:"external"};
        if(!(s.effectReads??=[]).some(r=>r.taskId===fact.taskId&&r.role===fact.role&&r.workId===fact.workId&&r.requestId===fact.requestId))s.effectReads.push(fact);
      }
    });
  }
  // A repair authorizes one public mutation with an exact draft/basis; a Shell, helper,
  // new delegate or broader grant cannot stand in for that mutation.
  function admit(action, detail = {}) {
    if(binding.constraints?.readOnly && ["write","shell","scope","accept"].includes(action))fail("ROOT_READ_ONLY","Root forbids file or shell effects");
    if(action==="delegate" && binding.constraints && !binding.constraints.allowedSubtasks.includes("work")){
      const control=detail.staffControl;
      const metadata=control&&['list','register_work'].includes(control.action);
      const review=binding.constraints.allowedSubtasks.includes('review') && (
        detail.readOnly===true&&!detail.scope?.length&&detail.reviewOf&&detail.reviewSource?.candidate&&(detail.reviewKind??'independent')==='independent' ||
        control?.action==='appoint'&&control.input.need==='review'&&Array.isArray(control.input.scope)&&control.input.scope.length===0);
      if(!metadata&&!review)fail('ROOT_SUBTASK','Root forbids work delegation; only a bound independent read-only review may be allowed');
    }
    host.assertOwned();
    const state = host.read(),
      step = checkBinding(state, binding);
    if (detail.actor && ["read", "write", "shell", "scope", "delegate"].includes(action))
      staff?.checkWork?.({
        taskId: binding.taskId,
        action,
        role: detail.actorRole ?? detail.actor,
        scope: detail.scope,
        readScope: detail.readScope,
      });
    const route = step.route?.revision === step.revision ? step.route : null;
    const judgment =
      route?.status === "paused" &&
      route.kind !== "checkpoint" &&
      !step.review &&
      !route.judgmentCall &&
      route.taskId === binding.taskId &&
      detail.role === "main" && detail.phase === "work" &&
      ["prepareSend", "send"].includes(action);
    if (route && !["repair", "resolved"].includes(route.status) && !judgment)
      routeError(
        "Route is " +
          route.status +
          " at " +
          route.candidate +
          "; preserve evidence and use the bound judge/experiment",
      );
    if (
      action === "scope" &&
      detail.previousScope &&
      detail.scope?.some((p) => !inScope(p, detail.previousScope))
    ) {
      const extra = detail.scope.filter((p) => !inScope(p, detail.previousScope));
      if (
        route?.kind === "scope_expansion" &&
        route.status === "repair" &&
        !route.expansion &&
        detail.changeId === route.changeId &&
        detail.privateVersion === route.privateVersion &&
        detail.scope.every((path) => route.evidence.requestedScope.includes(path))
      ) {
        ranges(detail.scope, step.scope);
        ranges(extra, route.judgment.repairScope);
        host.update((s) => {
          checkBinding(s, binding).route.expansion = {
            requestId: detail.requestId,
            changeId: detail.changeId,
          };
        });
      } else {
        host.update((s) =>
          recordRouteObservation(s, step.id, {
            ...detail,
            candidate: detail.privateVersion ?? detail.candidate,
            kind: "scope_expansion",
            evidence: { previousScope: detail.previousScope, requestedScope: detail.scope },
            taskId: binding.taskId,
          }),
        );
        routeError("Expanding the grant requires route review");
      }
    }
    ranges(detail.scope ?? [], step.scope);
    if(binding.rootTaskId)ranges(detail.readScope??[],binding.readScope);
    if (detail.coordination && (action !== "feedback" || route?.status !== "repair"))
      routeError("Supervisor resumption needs an active repair of its original direct report");
    if (
      route?.status === "resolved" &&
      route.edit &&
      (["delegate", "feedback", "shell", "write"].includes(action) ||
        (action === "accept" && detail.changeId && detail.changeId !== route.edit.changeId))
    )
      routeError("The diagnosed repair already passed. Finish the original checks.");
    const commitRepair = route?.status === "repair" && guardRepair(state, route, action, detail);
    if (action === "plugin") checkPlugin(detail);
    if (action === "helper")
      fail(
        "PROJECT_PLUGIN_UNBOUND",
        "This native plugin cannot attest each project send/write; use the project's managed Team tools",
      );
    if (detail.commit && ["write", "shell"].includes(action)) {
      for (const work of step.works ?? []) {
        if (!work.effect || !projectScopesOverlap(work.scope, detail.scope ?? [])) continue;
        if (!state.effectReads?.some((r) => r.taskId === binding.taskId && r.role === detail.actor && r.workId === work.id))
          fail("PROJECT_EFFECT_REQUIRED", "Read the frozen project_effect result for work " + work.id + " before writing.");
      }
      if (staff || commitRepair) host.update((s) => {
        checkBinding(s, binding);
        staff?.claimWrite?.({ taskId: binding.taskId, role: detail.actor, scope: detail.scope, changeId: detail.changeId }, s);
        if (commitRepair) commitRepair(s);
      });
    }
    if (action === "prepareSend") authorizeSend(state, detail);
    if (action === "send") host.update((current) => authorizeSend(current, detail, true));
  }

  function guardRepair(state, route, action, detail) {
    if (["delegate", "shell", "plugin", "helper"].includes(action))
      routeError("Only the diagnosed edit and its original verification are authorized");
    if (
      action === "scope" &&
      detail.scope?.length &&
      route.taskId === binding.taskId &&
      route.changeId &&
      detail.changeId !== route.changeId
    )
      routeError("Another change cannot run under this candidate's repair authorization");
    if (action === "scope" && detail.scope?.length && (route.taskId !== binding.taskId || !route.changeId)) {
      if (binding.startVersion !== route.candidate)
        routeError("Repair must use the diagnosed candidate; a fresh task cannot rewrite a different base");
      ranges(detail.scope, route.judgment.repairScope);
    }
    if (action === "feedback" && detail.coordination) {
      const supervisor = state.staffAssignments?.[detail.dispatchId];
      const child = state.staffAssignments?.[detail.coordination.dispatchId];
      if (
        route.edit ||
        route.feedback ||
        route.coordination ||
        detail.actor !== "root" ||
        route.taskId !== binding.taskId ||
        supervisor?.taskId !== binding.taskId ||
        supervisor.status !== "disposed" ||
        !supervisor.readOnly ||
        supervisor.role !== detail.role ||
        supervisor.identity !== detail.identity ||
        child?.taskId !== binding.taskId ||
        child.actor !== supervisor.staffId ||
        child.status !== "result" ||
        child.role !== route.actor ||
        child.changeId !== route.changeId ||
        detail.coordination.changeId !== route.changeId ||
        detail.coordination.privateVersion !== route.privateVersion ||
        detail.coordination.candidate !== route.candidate
      )
        routeError(
          "Coordination must reopen the original read-only supervisor for exactly the diagnosed direct report",
        );
      host.update((s) => {
        checkBinding(s, binding).route.coordination = {
          role: supervisor.role,
          supervisorId: supervisor.staffId,
          dispatchId: supervisor.dispatchId,
          childId: child.dispatchId,
          at: stamp(),
        };
      });
    }
    if (action === "feedback" && !detail.coordination) {
      if (
        route.coordination &&
        (detail.actor !== route.coordination.supervisorId ||
          detail.dispatchId !== route.coordination.childId ||
          detail.actorRole !== route.coordination.role)
      )
        routeError("Only the original supervisor may give this employee corrective feedback");
      if (
        route.edit ||
        route.feedback ||
        !detail.existingResult ||
        !route.changeId ||
        route.taskId !== binding.taskId ||
        route.changeId !== detail.changeId ||
        route.privateVersion !== detail.privateVersion ||
        route.candidate !== detail.candidate
      )
        routeError("Corrective feedback requires the original diagnosed employee draft and result");
      host.update((s) => {
        checkBinding(s, binding).route.feedback = { dispatchId: detail.dispatchId, at: stamp() };
      });
    }
    if (action === "write") {
      // Other calls in the same assistant reply can race the experiment. Only a
      // tool emitted after its model actually received the observation can repair.
      const request = readRequests(home, readTask(home, binding.taskId)).findLast(
        (r) =>
          r.role === detail.actor &&
          r.status === "completed" &&
          r.response?.content?.some((part) => part.type === "toolCall" && part.id === detail.toolCallId),
      );
      if (!(state.callIntents ?? []).some((c) => c.id === request?.id && c.afterProbe === route.probe.id))
        routeError("Repair must come from a request admitted after the observed experiment");
      const basis = route.expansion?.confirmedVersion ?? route.privateVersion;
      const sameDraft =
        route.taskId === binding.taskId &&
        route.changeId === detail.changeId &&
        basis === detail.privateVersion &&
        (route.kind === "scope_expansion" || detail.candidate === route.candidate);
      const sameBaseline =
        binding.startVersion === route.candidate && detail.privateVersion === route.candidate;
      if (!sameDraft && !sameBaseline) routeError("Repair candidate or private basis is stale");
      ranges(detail.scope, route.judgment.repairScope);
      if (route.edit && (route.edit.requestId !== detail.requestId || route.edit.taskId !== binding.taskId))
        routeError("The single repair was already claimed; run the original acceptance");
      if (detail.commit && !route.edit)
        return (s) => {
          const current = checkBinding(s, binding).route;
          if (current.status !== "repair" || current.edit) routeError("Repair authorization changed");
          current.edit = {
            requestId: detail.requestId,
            taskId: binding.taskId,
            changeId: detail.changeId,
            paths: detail.scope,
            at: stamp(),
          };
        };
    }
    if (action === "accept" && (!route.edit || (detail.changeId && route.edit.changeId !== detail.changeId)))
      routeError("Verification must use the repaired change");
  }

  function assignmentOf(state, role) {
    if (role === "main") return null;
    const assignment = Object.values(state.staffAssignments ?? {}).find(
      (a) => a.taskId === binding.taskId && a.role === role && a.status === "active",
    );
    if (!assignment) fail("PROJECT_STAFF", "No active assignment for this project session: " + role);
    return assignment;
  }

  // The cause comes from the host-created stage or the recorded provider response
  // whose tool results Pi is now consuming. A new transport UUID is never a new turn.
  function assertProcessBudget(needed, state = host.read()) {
    host.assertOwned();
    checkBinding(state, binding);
    const {maxCalls, maxCost} = validateProjectBudget(state.budget);
    if (maxCost !== null || (maxCalls !== null && (state.callIntents ?? []).filter(claim =>
      claim.kind !== "external" && !claim.notSent).length + needed > maxCalls))
      fail("PROJECT_BUDGET", "Project call budget exhausted or reserved for required process checking");
  }

  function bindProcessObservation(task, stage, observation, body) {
    host.assertOwned();
    checkBinding(host.read(), binding);
    const root = task.rootOwner?.rootTask.record;
    const digest = createHash("sha256").update(body).digest("hex");
    if (!binding.rootTaskId || root?.id !== binding.rootTaskId || task.record.id !== binding.taskId ||
        !root.processCheck?.observations.includes(observation) || processStages.has(stage) ||
        stage.phase !== "process-check" || stage.role !== "process-check" || observation.taskId !== binding.taskId ||
        observation.commandId !== binding.commandId || observation.revision !== binding.revision ||
        observation.stageId !== stage.id || observation.sessionId !== stage.sessionId ||
        !isDeepStrictEqual(observation.model, stage.modelRef) || observation.snapshotDigest !== digest)
      fail("PROCESS_UNBOUND", "A process check requires the live root's exact host observation");
    processStages.set(stage, {observation, body});
  }

  function locateSend({ task, stage, context, model }) {
    host.assertOwned();
    const state = host.read();
    const step = checkBinding(state, binding);
    if (task.record.id !== binding.taskId || !task.record.stages.includes(stage) || !stage.sessionId)
      fail("PROJECT_STALE", "Request has no project-owned stage/session");
    const native=nativeStages.get(stage);
    const process = processStages.get(stage);
    if (stage.phase === "process-check" || stage.role === "process-check") {
      const last = context.messages?.at(-1);
      const body = typeof last?.content === "string" ? last.content :
        last?.content?.length === 1 && last.content[0].type === "text" ? last.content[0].text : null;
      if (!process || last?.role !== "user" || body !== process.body || context.tools?.length)
        fail("PROCESS_UNBOUND", "Checker cannot send outside its tool-free host observation");
    }
    if(stage.role.startsWith('helper:')&&!native)fail('PROJECT_NATIVE_UNBOUND','A helper role string is not a native session grant');
    if(native)checkNative(native,'model');
    const assignment = process ? null : assignmentOf(state, native?.creatorRole??stage.role);
    const member = task.record.members?.find((m) => "member:" + m.memberId === (native?.creatorRole??stage.role));
    const sessionId = stage.sessionId;
    if (model.provider !== stage.modelRef.provider || model.id !== stage.modelRef.modelId)
      fail("PROJECT_STALE", "Actual route does not match the stage's frozen model");
    const position = { taskId: binding.taskId, role: stage.role, sessionId, phase: stage.phase,
      workId: native?.workId??stage.effectWorkId ?? assignment?.workId ?? null, dispatchId: assignment?.dispatchId ?? null,
      ...(native?{nativeLaunchId:native.launchId,creatorRole:native.creatorRole,workIds:native.workIds,scope:native.scope,readScope:native.readScope}: {}) };
    const calls = task.requests();
    const messages = context.messages ?? [];
    const last = messages.at(-1);
    let cause = "initial";
    if (process) cause = "observe:" + process.observation.id;
    else if (last?.role === "toolResult") {
      const assistant = messages.findLast((m) => m.role === "assistant");
      const parent = assistant?.cothinkMessageId && calls.find((r) =>
        r.displayId === assistant.cothinkMessageId && r.role === stage.role && r.status === "completed" &&
        r.projectSend?.sessionId === stage.sessionId &&
        r.response?.content?.some((part) => part.type === "toolCall" && part.id === last.toolCallId));
      if (!parent) fail("PROJECT_STALE", "Pi continuation has no recorded parent request in this session");
      cause = "tools:" + parent.id;
      if (!assignment && !position.workId) {
        const toolIds = parent.response.content.filter((p) => p.type === "toolCall").map((p) => p.id);
        const traces = task.record.tools?.filter((t) =>
          t.stageId === parent.stageId && toolIds.includes(t.toolCallId)) ?? [];
        const claims = (state.rootWorkClaims ?? []).filter((c) =>
          c.taskId === binding.taskId && traces.some((t) => t.changeId === c.changeId &&
            (!t.sourcePath || inScope(t.sourcePath, c.scope))));
        const ids = new Set(claims.map((c) => c.workId));
        if (ids.size === 1) position.workId = [...ids][0];
      }
    } else if (last?.role === "custom" && last.customType === "cothink-project-plugin") {
      const receipt=task.record.tools?.find(t=>t.kind==='project_plugin_message'&&t.requestId===last.details?.hostOperationId&&t.status==='queued'&&t.stageId===stage.id&&t.sessionId===sessionId&&t.parentActorId===stage.role);
      if(!receipt)fail("PROJECT_PLUGIN_UNBOUND","Plugin message has no host-owned queued receipt in this stage");
      cause="plugin:"+receipt.requestId;
    } else if (last?.role === "user") {
      // A host prompt may resume the same stage after a completed assistant turn.
      const previous = messages.findLast((m) => m.role === "assistant" && m.cothinkMessageId);
      const parent = previous && calls.find((r) => r.stageId === stage.id && r.displayId === previous.cothinkMessageId);
      if (parent) cause = "resume:" + parent.id;
    }
    const feedback = member?.feedback?.length ?? 0;
    const digest = createHash("sha256").update(JSON.stringify([
      "project-send-v1", binding.projectId, binding.taskId, position.dispatchId, position.workId, stage.role, stage.phase, feedback, cause,
    ])).digest("hex");
    const requestId = [digest.slice(0,8), digest.slice(8,12), digest.slice(12,16), digest.slice(16,20), digest.slice(20,32)].join("-");
    const detail = { ...position, requestId, cause, feedback, model };
    const claims = (state.callIntents ?? []).filter((c) => c.taskId === binding.taskId && !c.notSent && c.sessionId);
    const separate = (phase) => phase === "project-effect" || phase === "visual-review";
    if (claims.some((c) => c.sessionId === sessionId && c.role !== detail.role ||
        c.role === detail.role && !separate(stage.phase) && !separate(c.phase) && c.sessionId !== sessionId))
      fail("PROJECT_STALE", "Pi session is not the session bound to this project role");
    if(!native&&!process)staff?.checkIdentity?.({ ...detail, taskId: binding.taskId }, state);
    if (stage.phase === "project-effect") {
      const work = (step.works ?? []).find((w) => w.id === stage.effectWorkId);
      if (!work?.effect || cause !== "initial" || (assignment && work.id !== assignment.workId))
        fail("PROJECT_EFFECT_HELD", "A frozen effect permits one tool-free request for the claimed work");
      detail.effect = work.effect;
    }
    issuedSends.set(detail, {task, stage, member,native,process});
    return Object.freeze(detail);
  }

  function originalResult(detail, task) {
    const state = host.read();
    checkBinding(state, binding);
    const native=issuedSends.get(detail)?.native;
    if(native)checkNative(native,'model');else if(!issuedSends.get(detail)?.process)staff?.checkIdentity?.(detail, state);
    const own = task.requests().find((r) => r.id === detail.requestId);
    const prior = state.callIntents?.find((c) => c.id === detail.requestId && !c.notSent);
    if (!own && !prior) return;
    const request = own ?? originalRequest(prior);
    if (request?.status === "completed" && request.response?.stopReason === "stop" && request.text?.trim() &&
        own && own.projectSend?.sessionId === detail.sessionId) return own;
    fail("PROJECT_REPLAY", "Use the original project request " + detail.requestId + " (" + (request?.status ?? "unknown") + "); no replay.");
  }

  function originalRequest(claim) {
    try {
      return readRequest(home, claim.taskId, claim.id);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  function sameEffect(a, b) {
    return a && b && a.target === b.target && a.action === b.action && a.round === b.round;
  }
  function effectOwner(state, detail) {
    return state.callIntents?.find((c) => !c.notSent && c.id !== detail.requestId && sameEffect(c.effect, detail.effect));
  }
  // The effect runtime has no tools or employee history. Its sole input is the
  // frozen plan tuple. The consumer receives evidence, then runs its own work.
  async function prepareEffect({ task, role, modelRef, workId, changeId, run, wait }) {
    host.assertOwned();
    const state = host.read();
    const step = checkBinding(state, binding);
    const work = (step.works ?? []).find((w) => w.id === workId);
    if (!work?.effect) {
      if (role === "main") fail("PROJECT_EFFECT_REQUIRED", "Select a registered work with a frozen effect");
      return null;
    }
    if (task.record.id !== binding.taskId) fail("PROJECT_STALE", "Effect caller is outside this project task");
    const checkOwner = (s) => {
      checkBinding(s, binding);
      const a = assignmentOf(s, role);
      if (a && (a.workId !== workId || a.readOnly)) fail("PROJECT_EFFECT_HELD", "Not the current effect work owner");
      staff?.checkIdentity?.({taskId:binding.taskId, role, model:modelRef}, s);
      if (!a && !s.rootWorkClaims?.some((c) => c.taskId === binding.taskId && c.workId === workId && c.changeId === changeId))
        fail("PROJECT_EFFECT_HELD", "Root has not claimed this work and change");
    };
    admit("read", {actor:role});
    if (step.route?.status === "repair") routeError("Only the diagnosed repair may run; a new effect is not authorized");
    if (role === "main") {
      const main = task.record.models.main;
      if (main.provider !== modelRef.provider || main.modelId !== modelRef.modelId)
        fail("PROJECT_STALE", "Root effect must use the frozen main model");
      if (!changeId) fail("PROJECT_EFFECT_HELD", "Root effect generation needs its project change");
      staff?.claimWrite?.({taskId:binding.taskId, role, scope:work.scope, changeId});
    }
    checkOwner(host.read());
    const {target, action, round} = work.effect;
    const key = JSON.stringify([target, action, round]);
    const findOwner = (s) => (s.callIntents ?? []).find((c) => !c.notSent && sameEffect(c.effect,work.effect));
    let owner = findOwner(host.read());
    const externalRoutes=(binding.mcp??[]).flatMap(server=>Object.entries(server.tools??{})
      .filter(([,grant])=>['write','start'].includes(grant.kind)&&sameEffect(grant,work.effect))
      .map(([tool,grant])=>({server:server.server,tool,kind:grant.kind})));
    if(!owner&&externalRoutes.length)return JSON.stringify({source:'Confirmed MCP operation contract; no effect has been sent',
      status:'external_operation_required',workId,target,action,round,routes:externalRoutes,
      instruction:'Use the confirmed MCP tool for this effect. Do not generate a substitute model effect; its actual receipt and file result still require normal review.'});
    if (!owner || pendingEffects.has(key)) {
      if (!pendingEffects.has(key)) {
        // Install the in-process waiter before creating a Pi session. Durable
        // authority and budget are still checked by the actual transport below.
        const generate = Promise.resolve().then(async () => {
          const stage = task.beginPhase("project-effect", role, modelRef);
          stage.effectWorkId = workId;
          task.save();
          await run(stage, JSON.stringify({ instruction:
            "Perform only this project's explicitly authorized generation. Return its text result. No tools.",
            target, action, round }));
        });
        pendingEffects.set(key, generate);
        try { await generate; } finally { pendingEffects.delete(key); }
      } else {
        const running = pendingEffects.get(key);
        await (wait ? wait(running) : running);
      }
      owner = findOwner(host.read());
    }
    if(owner?.kind==="external") {
      host.update(s=>{checkOwner(s);const receipt={taskId:binding.taskId,role,workId,requestId:owner.id,sourceTaskId:owner.taskId,kind:"external"};
        if(!(s.effectReads??=[]).some(r=>r.taskId===receipt.taskId&&r.role===role&&r.workId===workId&&r.requestId===owner.id))s.effectReads.push(receipt);});
      return JSON.stringify({source:"Original MCP external effect; do not regenerate",requestId:owner.id,status:owner.status,result:owner.result??null});
    }
    const request = owner && originalRequest(owner);
    if (!request?.sent || request.status !== "completed" || request.response?.stopReason !== "stop" ||
        !sameEffect(request.projectSend?.effect, work.effect) || request.phase !== "project-effect" || !request.text?.trim())
      fail("PROJECT_EFFECT_HELD", "Inspect original effect request " + (owner?.id ?? "(not sent)") + "; no replay.");
    const receipt = {taskId:binding.taskId, role, workId, requestId:owner.id, sourceTaskId:owner.taskId};
    host.update((s) => {
      checkOwner(s);
      if (!(s.effectReads ??= []).some((r) => r.taskId === receipt.taskId && r.role === role &&
          r.workId === workId && r.requestId === owner.id)) s.effectReads.push(receipt);
    });
    return JSON.stringify({source:"Untrusted result of the frozen project effect", ...receipt, text:request.text});
  }

  function checkUnresolved(state, step, detail) {
    const {native, process} = issuedSends.get(detail);
    const current = process ? null : assignmentOf(state, native?.creatorRole??detail.role);
    const localCalls = new Map(issuedSends.get(detail).task.requests().map((call) => [call.id, call]));
    const currentWork = detail.workId && (step.works ?? []).find((w) => w.id === detail.workId);
    for (const prior of state.callIntents ?? []) {
      if (prior.kind === "external" || prior.notSent || prior.id === detail.requestId) continue;
      const oldStep = state.steps.find((s) => s.attempts.some((a) => a.taskId === prior.taskId));
      const oldAssignment = Object.values(state.staffAssignments ?? {}).find(
        (a) => a.taskId === prior.taskId && a.role === prior.role);
      const workId = prior.workId ?? oldAssignment?.workId;
      if (prior.taskId === binding.taskId && prior.role !== detail.role && prior.cause &&
          (!detail.workId || !workId)) continue;
      const runningPeer = prior.taskId === binding.taskId && prior.role !== detail.role &&
        localCalls.get(prior.id)?.status === "in_flight";
      const priorNative=prior.nativeLaunchId&&nativeByLaunch.get(prior.nativeLaunchId);
      if(runningPeer&&priorNative&&!priorNative.closed&&priorNative.creatorRole===(native?.creatorRole??detail.role))continue;
      if(runningPeer&&native&&prior.role===native.creatorRole)continue;
      if (workId && detail.workId && workId !== detail.workId &&
          (runningPeer || (oldAssignment?.readOnly && current?.readOnly))) continue;
      // Known, separate modern roles may coordinate an unknown worker without
      // claiming its work. Legacy actions with no provable target remain held.
      const oldWork = workId && oldStep?.works?.find((w) => w.id === workId);
      const oldScope = prior.scope?.length?prior.scope:oldAssignment?.scope?.length ? oldAssignment.scope : oldWork?.scope ?? oldStep?.scope;
      const scope = native?.scope?.length?native.scope:current?.scope?.length ? current.scope : currentWork?.scope ?? step.scope;
      if (oldScope?.length && scope?.length && !projectScopesOverlap(oldScope, scope)) continue;
      const original = localCalls.get(prior.id) ?? originalRequest(prior);
      if (!original?.sent || ["in_flight", "preparing", "outcome_unknown"].includes(original.status))
        fail("PROJECT_IDENTITY_HELD", "Prior unresolved project request " + prior.id + "; inspect it without replay");
    }
  }

  function authorizeSend(state, detail, dispatch = false) {
    const liveSend = issuedSends.get(detail);
    if (!liveSend) fail("PROJECT_STALE", "Missing host-issued Pi send identity");
    const { task, stage, member,native,process } = liveSend;
    if(native)checkNative(native,'model');
    if (stage.sessionId !== detail.sessionId || (member?.feedback?.length ?? 0) !== detail.feedback ||
        (task.record.status && task.record.status !== "running") || task.signal?.aborted)
      fail("PROJECT_STALE", "Session, task or corrective feedback changed before dispatch");
    const step = checkBinding(state, binding);
    if (process && (process.observation.status !== "preparing" ||
      detail.cause !== "observe:" + process.observation.id || !task.rootOwner?.rootTask.record.processCheck?.observations.includes(process.observation)))
      fail("PROCESS_UNBOUND", "Original observation is no longer authorized for dispatch");
    const route = step.route?.revision === step.revision ? step.route : null;
    const judgment = route?.status === "paused" && route.kind !== "checkpoint" && !step.review &&
      !route.judgmentCall && route.taskId === binding.taskId && detail.role === "main" && detail.phase === "work";
    if (route && !["resolved","repair"].includes(route.status) && !judgment)
      routeError("Route is " + route.status + "; inspect its original evidence");
    if (route?.status === "repair" && detail.role !== "main" && detail.role !== route.actor &&
        detail.role !== route.coordination?.role)
      routeError("Only the diagnosed change owner or root reviewer may continue this repair");
    const assignment = process ? null : assignmentOf(state, native?.creatorRole??detail.role);
    const rootClaim = !assignment && detail.workId &&
      state.rootWorkClaims?.some((c) => c.taskId === binding.taskId && c.workId === detail.workId);
    if (!detail.sessionId || !detail.cause || (assignment?.dispatchId ?? null) !== detail.dispatchId ||
        (!native&&!rootClaim && (assignment?.workId ?? null) !== detail.workId))
      fail("PROJECT_STALE", "Send no longer matches its authorized project session or work");
    if(!native&&!process)staff?.checkIdentity?.({ ...detail, taskId: binding.taskId }, state);
    const { maxCalls, maxCost } = validateProjectBudget(state.budget);
    if (maxCost !== null) fail("PROJECT_BUDGET",
      "No provider-enforced per-request price bound or authoritative bill is available; hard cost cap prevents sending");
    const claimed = state.callIntents ?? [];
    const prior = claimed.find((c) => c.id === detail.requestId);
    if (prior && !prior.notSent) fail("PROJECT_REPLAY", "Inspect the original project send " + prior.id);
    const owner = effectOwner(state, detail);
    if (owner) fail("PROJECT_EFFECT_HELD", "Inspect or wait for the original effect request " + owner.id + "; no replay.");
    checkUnresolved(state, step, detail);
    if (maxCalls !== null && claimed.filter((c) => c.kind !== "external" && !c.notSent).length +
        (task.rootOwner?.processCheck.reserved(binding.taskId, stage.role) ?? 0) >= maxCalls)
      fail("PROJECT_BUDGET", "Project call budget exhausted or reserved for required process checking");
    if (!dispatch) return;
    if (judgment) step.route.judgmentCall = detail.requestId;
    const claim = { id: detail.requestId, taskId: binding.taskId, role: detail.role,
      identity: workModelIdentity({ modelId: detail.model.modelId ?? detail.model.id }),
      sessionId: detail.sessionId, dispatchId: detail.dispatchId, workId: detail.workId,
      cause: detail.cause, phase: detail.phase, feedback: detail.feedback,
      ...(native?{nativeLaunchId:native.launchId,creatorRole:native.creatorRole,workIds:native.workIds,scope:native.scope,readScope:native.readScope}:{}),
      ...(detail.effect ? {effect: detail.effect} : {}),
      ...(route?.status === "repair" ? { afterProbe: route.probe.id } : {}), at: stamp() };
    if (prior) Object.assign(prior, claim, {notSent: false});
    else (state.callIntents ??= []).push(claim);
  }

  async function observeCheck({ kind, candidate, result, changeId, privateVersion, versioning }) {
    host.assertOwned();
    const state = host.read(),
      step = checkBinding(state, binding);
    const matches = (check) =>
      step.checks?.some(
        (expected) =>
          expected.command === check.command &&
          JSON.stringify(expected.args ?? []) === JSON.stringify(check.args ?? []),
      );
    const checks = result.checks?.filter(matches) ?? [];
    if (checks.some((c) => c.exitCode !== 0 || c.sourceChanged)) {
      const infrastructure = checks.some(
        (c) => c.exitCode === null || c.cancelled || [126, 127].includes(c.exitCode),
      );
      const receiptChange = changeId ?? result.changeId;
      let basisMatches = true,
        actor;
      if (versioning && receiptChange && result.tree) {
        const current = await versioning.inspect({ changeId: receiptChange });
        actor = current.actor;
        basisMatches = current.candidates?.some(
          (c) => c.candidateVersion === candidate && c.tree === result.tree,
        );
      }
      const route = host.update((s) =>
        recordRouteObservation(s, step.id, {
          candidate,
          changeId: receiptChange,
          privateVersion,
          taskId: binding.taskId,
          actor,
          kind: infrastructure || !basisMatches ? "environment" : "failed",
          evidence: {
            checks,
            requestId: result.requestId,
            tree: result.tree,
            basisMatches,
            expectedTip: result.binding?.expectedTip,
          },
        }),
      );
      if (route.status === "paused" && step.review) {
        const input = { ...step.review, stepId: step.id, revision: step.revision, candidate };
        await runProjectRoute({ host, home, action: "judge", input, versioning });
        await runProjectRoute({ host, home, action: "experiment", input, versioning });
      }
    } else if (
      ["accepted", "passed"].includes(result.status) &&
      checks.length &&
      step.checks.every((matchesExpected) =>
        checks.some(
          (c) =>
            c.command === matchesExpected.command &&
            JSON.stringify(c.args) === JSON.stringify(matchesExpected.args ?? []),
        ),
      )
    ) {
      const route = step.route;
      if (route?.status === "repair" && route.edit?.changeId === changeId && result.status === "accepted")
        host.update((s) => {
          const current = checkBinding(s, binding).route;
          current.status = "resolved";
          current.recheck = {
            candidate,
            requestId: result.requestId,
            checks,
            acceptedVersion: result.acceptedVersion,
          };
        });
    }
    return host.read().steps.find((s) => s.id === step.id)?.route;
  }
  async function autoReviewScope() {
    const step = checkBinding(host.read(), binding),
      route = step.route;
    if (route?.status !== "paused" || route.kind !== "scope_expansion" || !step.review) return;
    const input = { ...step.review, stepId: step.id, revision: step.revision, candidate: route.candidate };
    await runProjectRoute({ host, home, action: "judge", input });
    await runProjectRoute({ host, home, action: "experiment", input });
  }
  async function observeRefresh({ requestId, result, versioning }) {
    const route = checkBinding(host.read(), binding).route;
    if (!route?.expansion || route.expansion.requestId !== requestId) return;
    const diff =
      result.status === "open" && result.changeId === route.changeId && result.privateVersion
        ? await versioning.inspect({ fromVersion: route.privateVersion, toVersion: result.privateVersion })
        : null;
    host.update((s) => {
      const current = checkBinding(s, binding).route;
      if (current.expansion?.requestId !== requestId) routeError("Scope review changed during refresh");
      if (!diff || diff.files.length || diff.binaryFiles?.length || diff.text) {
        current.status = "blocked";
        current.expansion.error = "Expanded grant no longer has the diagnosed candidate bytes";
      } else current.expansion.confirmedVersion = result.privateVersion;
    });
  }
  async function judgeLive(plan, { actor, toolCallId, versioning }) {
    const step = checkBinding(host.read(), binding),
      route = step.route;
    if (
      actor !== "main" ||
      route?.status !== "paused" ||
      !route.judgmentCall ||
      route.taskId !== binding.taskId
    )
      routeError("No unused judgment from this task on the paused candidate");
    const call = readRequests(home, readTask(home, binding.taskId)).find((r) => r.id === route.judgmentCall);
    if (
      call?.status !== "completed" ||
      call.role !== actor ||
      !call.response?.content?.some(
        (part) => part.type === "toolCall" && part.name === "project_route_judge" && part.id === toolCallId,
      )
    )
      routeError("Judgment must come from the admitted read-only request");
    const input = { ...plan, stepId: step.id, revision: step.revision, candidate: route.candidate };
    await runProjectRoute({ host, home, action: "judge", input, versioning });
    return runProjectRoute({ host, home, action: "experiment", input, versioning });
  }
  function environmentFailure({ candidate, requestId, code, message }) {
    if (!["EXECUTOR_UNAVAILABLE", "EXECUTOR_CONFIG", "EXECUTION_UNKNOWN"].includes(code)) return;
    host.update((s) => {
      checkBinding(s, binding);
      recordRouteObservation(s, binding.stepId, {
        candidate: candidate ?? binding.startVersion,
        kind: "environment",
        taskId: binding.taskId,
        evidence: { requestId, code, message },
      });
    });
  }
  return { staff, assertProcessBudget, bindProcessObservation, issueNativeHelper,bindNativeHelperSession,admitNativeHelper,closeNativeHelper,admitNativeCleanup,checkOriginalPluginCapability,
    budgetStatus() {
      host.assertOwned();
      const state = host.read();
      checkBinding(state, binding);
      const {maxCalls,maxCost} = validateProjectBudget(state.budget);
      const used = (state.callIntents ?? []).filter(call=>call.kind !== "external" && !call.notSent).length;
      return {maxCost, remainingCalls:maxCalls === null ? null : Math.max(0,maxCalls-used)};
    },
    unresolvedMcpClaims:actor=>(host.read().callIntents??[]).filter(c=>c.kind==='external'&&c.taskId===binding.taskId&&(!actor||c.role===actor)&&!c.notSent&&c.status!=='completed').map(c=>structuredClone(c)),
    registerMcpRecovery:(actor,recover)=>mcpRecoveries.set(actor,recover),
    recoverMcp:(id,action)=>{const claim=host.read().callIntents?.find(c=>c.kind==="external"&&c.id===id&&c.taskId===binding.taskId);const recover=claim&&mcpRecoveries.get(claim.role);if(!recover)fail("PROJECT_MCP_RECOVERY","Original live handle is unavailable");return recover(id,action);}, admit, issueMcpCapability, issueMcpRecoveryCapability, admitMcp, claimMcpEffect, observeMcpRequest, issuePluginCapability, locateSend, originalResult, prepareEffect, observeCheck, observeRefresh, autoReviewScope, judgeLive, environmentFailure };
}
