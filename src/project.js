import {validateWorkRequest} from "./visual-preview.js";
import {verifyProjectVisual} from "./visual-project-delivery.js";
import { assertRootOwner } from "./project-turn.js";
import { assertConfirmedProjectState } from "./project-file-confirmation.js";
import { digest } from "./project-collaboration-evidence.js";
import { resolveHandoffContext } from "./project-readonly-reports.js";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireSessionWriter,
  sessionWriterBusy,
  privateDirectory,
  writePrivateJson,
} from "./storage.js";
import { legacyGit } from "./git-versioning.js";
import { assertProjectPathSpellings, createVersioning, inScope, projectScopesOverlap, validProjectPath, withChangeQueue } from "./versioning.js";
import { readTask, readRequests, problem } from "./task.js";
import { loadConfig, validateConfig } from "./config.js";
import { resolveTeamConfig } from "./teams.js";
import { runTurn } from "./discussion.js";
import { safeText } from "./terminal.js";
import { recoverProjectMcpReceipt, validateProjectMcp } from "./project-mcp-work.js";
import { createProjectStaff, changeProjectStaff } from "./project-staff.js";
import {
  createProjectPolicy,
  validateProjectBudget,
  recordRouteObservation,
  runProjectRoute,
  projectUsage,
  reconcileProjectCalls,
} from "./project-policy.js";
import { evidence, formal, now, onOwnedLine, ownedParents, provePrevious, savedTask, verifyDelivery } from "./project-delivery-checks.js";

export const projectHelp = `cothink project start --file PLAN.json [--repo PATH] [--json]
cothink project status|pause|resume [--repo PATH] [--json]
cothink project revise --goal TEXT --step ID [--step ID ...] [--file REVISED-PLAN.json] [--repo PATH] [--json]
cothink project staff ACTION 'JSON' [--repo PATH] [--json]
cothink project mcp query|cancel '{"originalRequestId":"mcp:..."}' [--repo PATH] [--json]
cothink project route judge|experiment 'JSON' [--repo PATH] [--json]
计划绑定 goal、scope、steps、budget。每步指定 id、goal、dependsOn、deliverables 和在固定容器内执行的非空 checks。单步项目可直接指定 deliverables 和 checks，步骤 ID 为 main。
每个交付路径默认是一项工作。可用 works 定义具名工作及 scope，effect 用 {target,action,round} 绑定一次获准动作。需要异型号独立评审时，在步骤或具体工作上指定 independentReview:true。
`;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const required = (s, label) => {
  if (typeof s !== "string" || !s.trim())
    throw Error(label + " must be nonempty text");
  return s;
};
function paths(items, allowRoot = false, field = "project paths") {
  if (!Array.isArray(items) || !items.length)
    throw Error(field + " must be a nonempty array of path strings");
  for (const path of items)
    if (!validProjectPath(path, allowRoot)) throw Error("Invalid path in " + field + ": " + path);
  return [...new Set(items)];
}
// Preserve explicit requests independently of the planner. The structured,
// user-confirmed requirement is authoritative for more complex descriptions.
const allReviewTargets = /(?:所有|每(?:一个|个)?|各)(?:项目)?(?:步骤|工作项|交付物)|\b(?:each|every|all)\s+(?:project\s+)?(?:steps?|works?|deliverables?)\b/i;
export function preserveReviewRequest(text, plan) {
  const clauses = String(text ?? "").split(/[,;。；，！？!?\n]|\.(?=\s|$)/);
  const review = /(?:independent|different[- ]model)\s+(?:model\s+)?review|(?:独立|异模型|不同模型)(?:的)?(?:评审|审查|复核)/i;
  const mandated = /\b(?:requir(?:e[ds]?|ing)|needs?|must|mandatory)\b|必须|需要|要求|须经|应由|务必/i;
  const instruction = /\b(?:obtain|perform|conduct|arrange|request|complete|commission)\s+(?:an?\s+)?(?:independent|different[- ]model)\b|(?:进行|安排|开展|接受|完成)(?:一次)?(?:独立|异模型|不同模型)(?:评审|审查|复核)/i;
  const discussing = /\b(?:explain|describe|discuss|define|whether|if|could|consider)\b|解释|讨论|描述|说明如何|考虑是否|如果|例如/i;
  const optional = /(?:\bno(?:\s+need\s+for)?\s+(?:an?\s+)?(?:independent|different[- ]model)\b|\b(?:without|skip|waive)\s+(?:an?\s+)?(?:independent|different[- ]model)\b|\b(?:not|never)\s+(?:require|need|conduct|perform)\b|review\s+(?:is\s+)?(?:not required|optional|unnecessary)|无需|不必|不需要|不要求|不(?:是)?必须|可以不|不做)/i;
  const steps = plan.steps ?? [plan];
  const optOut = clauses.filter(c => review.test(c) && optional.test(c) &&
    !/(?:must\s+not|do\s+not|never)\s+(?:skip|waive)|不可省略|不能跳过/i.test(c));
  for (const clause of optOut) {
    const targeted = steps.filter(step => step.deliverables?.some(p => clause.includes(p)));
    const applicable = targeted.length ? targeted : steps;
    if (plan.independentReview || applicable.some(step => step.independentReview ||
      step.works?.some(work => work.independentReview && (!targeted.length ||
        step.deliverables.some(p => clause.includes(p) && inScope(p,work.scope))))))
      throw Error("目标与草案中的独立评审设置有冲突。请核对后重新规划。");
  }
  const demands = clauses.filter(c => review.test(c) && !discussing.test(c) &&
    (mandated.test(c) || instruction.test(c)) && !optOut.includes(c));
  if (!demands.length || plan.independentReview) return plan;
  if (demands.some(clause => allReviewTargets.test(clause))) return {...plan,independentReview:true};
  const hasReview = steps.some(step =>
    step.independentReview || step.works?.some(work => work.independentReview));
  if (hasReview) {
    for (const step of steps) {
      for (const path of step.deliverables ?? []) {
        if (demands.some(c => c.includes(path)) && !step.independentReview &&
            !step.works?.some(w => w.independentReview && inScope(path,w.scope)))
          throw Error("原目标明确要求独立评审，但草案没有绑定这个交付物：" + path);
      }
    }
    return plan;
  }
  if (plan.steps?.length > 1)
    throw Error("原目标要求独立评审，但草案未指定受审步骤。请明确步骤后重新规划。尚未启动项目。");
  return {...plan, independentReview:true};
}

export function projectReviewPlan(plan) {
  if (Array.isArray(plan.steps))
    plan = {...plan,steps:plan.steps.map(step => preserveReviewRequest(step.goal,step))};
  return preserveReviewRequest(plan.goal,plan);
}

function workDefinitions(step, scope, deliverables, requiredReview) {
  const definitions = step.works ?? deliverables.map(path => ({
    id: step.id + ":" + path, scope: [path],
  }));
  if (!Array.isArray(definitions) || !definitions.length)
    throw Error("Expected a nonempty list of authorized works");
  const works = definitions.map(work => {
    const id = required(work.id, "work ID");
    if (id === "__proto__" || Object.hasOwn(Object.prototype, id) || /[\x00-\x1f\x7f]/.test(id))
      throw Error("Invalid work ID");
    const boundary = paths(work.scope, true).sort();
    if (boundary.some(p => !inScope(p, scope)))
      throw Error("Work scope exceeds step scope: " + id);
    if (work.independentReview !== undefined && typeof work.independentReview !== "boolean")
      throw Error("Work independentReview must be a boolean");
    const normalized = {id, scope:boundary};
    if (requiredReview || work.independentReview) normalized.independentReview = true;
    if (work.effect !== undefined) {
      const {target, action, round} = work.effect ?? {};
      if (!Number.isSafeInteger(round) || round < 1) throw Error("Effect round must be a positive integer");
      normalized.effect = {target:required(target,"effect target").trim(), action:required(action,"effect action").trim(), round};
    }
    return normalized;
  });
  if (deliverables.some(path => !works.some(work => inScope(path, work.scope))))
    throw Error("A deliverable has no authorized work");
  return works;
}
const stepPaths = step => [
  ...(step.scope ?? []), ...(step.deliverables ?? []),
  ...[...(step.works ?? []), ...(step.subworks ?? [])].flatMap(work => work.scope),
];
function projectSelections(plan) {
  const names = (value, label) => {
    if (!Array.isArray(value ?? []) || (value ?? []).some(x => typeof x !== "string" || !x.trim()))
      throw Error(label + " must be a list of nonempty names");
    return [...new Set(value ?? [])];
  };
  const explicit = [...required(plan.goal, "goal").matchAll(/(?:^|\s)(?:\/skill:|\$)([a-zA-Z0-9_-]+)(?=\s|$|[.,，。])/g)].map(m => m[1]);
  return {mcp:validateProjectMcp(plan.mcp),plugins:names(plan.plugins,"plugins"),explicitSkills:[...new Set([...names(plan.explicitSkills,"explicitSkills"),...explicit])]};
}
function compileProjectPlan(plan, location, userInput) {
  if(!plan||typeof plan!=="object"||Array.isArray(plan))throw Error("plan must be an object");
  const goal = required(plan.goal, "goal");
  if(plan.steps!==undefined&&(!Array.isArray(plan.steps)||plan.steps.some(step=>!step||typeof step!=="object"||Array.isArray(step))))
    throw Error("steps must be an array of step objects");
  if(userInput!==undefined)plan=preserveReviewRequest(userInput,plan);
  plan = projectReviewPlan(plan);
  const scope = paths(plan.scope, true, "scope");
  const definitions =
    plan.steps ??
    (plan.deliverables && plan.checks ? [{ ...plan, id: "main", goal }] : []);
  if (!Array.isArray(definitions) || !definitions.length)
    throw Error("Provide top-level deliverables and checks for one step, or a nonempty steps array");
  if (plan.independentReview !== undefined && typeof plan.independentReview !== "boolean")
    throw Error("Project independentReview must be a boolean");
  const steps = definitions.map((s) => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(required(s.id, "step id")))
      throw Error("Invalid step ID");
    const stepScope = paths(s.scope ?? scope, true, "step "+s.id+" scope");
    if (!stepScope.every((p) => inScope(p, scope)))
      throw Error("Step scope exceeds project scope");
    const deliverables = paths(s.deliverables, false, "step "+s.id+" deliverables");
    if (!deliverables.every((p) => inScope(p, stepScope)))
      throw Error("Deliverable outside step scope");
    if (
      !Array.isArray(s.checks) ||
      !s.checks.length ||
      s.checks.some(
        (c) =>
          !c ||
          !c.command ||
          typeof c.command !== "string" ||
          c.command.startsWith("/") ||
          Object.keys(c).some(
            (k) => !["command", "args", "timeoutMs"].includes(k),
          ) ||
          (c.args !== undefined &&
            (!Array.isArray(c.args) ||
              c.args.some((a) => typeof a !== "string"))) ||
          (c.timeoutMs !== undefined &&
            (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1)),
      )
    )
      throw Error("step "+s.id+" checks must be a nonempty array of fixed container entry points {command,args?,timeoutMs?}");
    const dependsOn = s.dependsOn ?? [];
    if (!Array.isArray(dependsOn))
      throw Error("dependsOn must be a list of step IDs");
    if (s.checkpoint !== undefined && typeof s.checkpoint !== "boolean")
      throw Error("checkpoint must be a boolean");
    if (s.independentReview !== undefined && typeof s.independentReview !== "boolean")
      throw Error("Step independentReview must be a boolean");
    const independentReview = !!(plan.independentReview || s.independentReview);
    return {
      id: s.id,
      goal: required(s.goal, "step goal"),
      scope: stepScope,
      dependsOn: [...new Set(dependsOn)],
      deliverables,
      checks: s.checks,
      works: workDefinitions(s, stepScope, deliverables, independentReview),
      ...(independentReview ? {independentReview:true} : {}),
      checkpoint: s.checkpoint ?? false,
      ...(s.review ? { review: s.review } : {}),
      revision: 1,
      status: "pending",
      attempts: [],
    };
  });
  if (new Set(steps.map((s) => s.id)).size !== steps.length)
    throw Error("Duplicate project step");
  assertProjectPathSpellings([...scope, ...steps.flatMap(stepPaths)]);
  const ids = steps.flatMap(s => s.works.map(work => work.id));
  if (new Set(ids).size !== ids.length) throw Error("Duplicate project work ID");
  const reachable = new Set();
  for (let pass = 0; pass < steps.length; pass++)
    for (const s of steps)
      if (s.dependsOn.every((k) => reachable.has(k))) reachable.add(s.id);
  if (reachable.size !== steps.length)
    throw Error("Unknown or cyclic step dependency");
  const state={
    formatVersion: 1,
    id: location.id,
    repo: location.repo,
    ...projectSelections(plan),
    ...(plan.workRequest ? {workRequest:validateWorkRequest(plan.workRequest)} : {}),
    originalGoal: goal,
    goal,
    revision: 1,
    revisions: [],
    scope,
    ...(plan.readScope!==undefined ? {readScope:paths(plan.readScope,true,"readScope")} : {}),
    steps,
    budget: validateProjectBudget(plan.budget ?? {}),
    staff: [],
    staffAssignments: {},
    status: "active",
    version: null,
    integrationRef: null,
    commands: {},
    createdAt: now(),
  };
  return {plan,state};
}
async function locate(home, cwd) {
  const repo = realpathSync(
    await legacyGit(cwd, ["rev-parse", "--show-toplevel"]),
  );
  const common = realpathSync(
    await legacyGit(repo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
  );
  const hex = createHash("sha256").update(common).digest("hex");
  const id = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
  const store = join(home, "project-delivery"),
    dir = join(store, id);
  return {
    id,
    repo,
    commonDir:common,
    store,
    dir,
    file: join(dir, "state.json"),
    inbox: join(dir, "controls"),
  };
}
function stored(loc) {
  const s = json(loc.file);
  if (
    s.formatVersion !== 1 ||
    s.id !== loc.id ||
    !Array.isArray(s.steps) ||
    typeof s.repo !== "string"
  )
    throw Error("Corrupt project record; original preserved");
  // Old records have only deliverable paths. Do not rewrite pending dispatches or invent their IDs.
  for (const step of s.steps)
    step.works ??= workDefinitions(step, step.scope, step.deliverables, step.independentReview);
  return s;
}
function nextStep(s) {
  return s.steps.find(
    (step) =>
      ["pending", "running"].includes(step.status) &&
      step.dependsOn.every(
        (k) => s.steps.find((other) => other.id === k)?.status === "completed",
      ),
  );
}
function summary(s) {
  const blocked = s.steps.filter((x) =>
    ["blocked", "unknown", "review"].includes(x.status),
  );
  return {
    ...s,
    commands: undefined,
    next: s.status === "paused" ? null : (nextStep(s)?.id ?? null),
    blocker:
      s.error ??
      (blocked.map((x) => x.id + ": " + (x.error ?? x.status)).join("\n") ||
        null),
  };
}
async function view(home, loc) {
  const s = stored(loc);
  const writerActive = sessionWriterBusy(loc.store, loc.id);
  const result = { ...summary(s), writerActive, usage: projectUsage(s, home) };
  try {
    const current = await formal(home, s.repo);
    result.currentVersion = current.version;
    result.formalRef = current.integrationRef;
    if (s.status === "completed" && current.version !== s.version)
      result.blocker =
        "正式版本已在项目交付后移动；本次成果只核验到保存的版本。";
  } catch (e) {
    result.currentVersion = null;
    result.blocker = e.message;
  }
  if (s.status === "active" && !writerActive)
    result.blocker ??=
      "调度宿主已退出。请运行 cothink project resume 以核查原任务和请求。";
  return result;
}
export async function projectChatState(home, cwd) {
  const loc = await locate(home, cwd);
  const state = existsSync(loc.file) ? stored(loc) : null;
  if (state && state.repo !== loc.repo) throw Error("这个项目属于另一个工作树：" + state.repo);
  return {repo:loc.repo, commonDir:loc.commonDir, projectId:loc.id, state};
}
export function validateChatPlan(plan,{userInput}={}) {
  return compileProjectPlan(plan, {id:"preview", repo:""}, userInput);
}
export async function readProject(home, repo) {
  return view(home, await locate(home, repo));
}
function checkWorkRevision(state, before, after) {
  // Retired non-strict paths may be replaced. Their old identity and target stay
  // reserved in revision history, so a rename cannot create new ownership.
  const history = [...state.steps, ...state.revisions.flatMap(r => r.previousDefinitions ?? [])];
  for (const oldStep of history) {
    for (const old of oldStep.works ?? []) {
      const sameId = after.works.find(work => work.id === old.id);
      if (sameId) {
        if (oldStep.id !== after.id || !isDeepStrictEqual(old.scope,sameId.scope) ||
            !isDeepStrictEqual(old.effect,sameId.effect) || (old.independentReview && !sameId.independentReview))
          throw Error("Revision cannot rebind or weaken frozen work: " + old.id);
        continue;
      }
      if (oldStep.id !== before.id) continue;
      const claimed = Object.values(state.staffAssignments ?? {}).some(a => a.workId === old.id &&
        a.status !== "disposed");
      if (old.independentReview || claimed || after.works.some(work => projectScopesOverlap(work.scope,old.scope)))
        throw Error("Revision cannot rename or drop protected work: " + old.id);
    }
  }
}
function control(s, command) {
  if (command.action === "staff")
    return changeProjectStaff(s, command.operation, command.input);
  if (command.action === "pause") {
    s.status = "paused";
    return;
  }
  if (command.action === "resume") {
    if (s.status !== "completed") s.status = "active";
    for (const step of s.steps)
      if (
        step.status === "blocked" &&
        step.attempts.at(-1)?.status === "intent"
      )
        step.status = "running";
    delete s.error;
    return;
  }
  if (command.action !== "revise")
    throw Error("Unknown project control " + command.action);
  if (command.expectedRevision !== undefined && command.expectedRevision !== s.revision)
    throw Error("Project revision changed. Prepare the revised goal again.");
  const goal = required(command.goal, "revised goal"),
    affected = new Set(command.steps);
  if (
    !affected.size ||
    [...affected].some((id) => !s.steps.some((x) => x.id === id))
  )
    throw Error("Select affected steps using --step ID");
  const previousDefinitions = [];
  if (command.plan) {
    const {state:revised} = compileProjectPlan(command.plan, { id: s.id, repo: s.repo });
    assertProjectPathSpellings([...revised.steps.flatMap(stepPaths), ...s.steps.flatMap(stepPaths),
      ...s.revisions.flatMap(r => r.previousDefinitions ?? []).flatMap(stepPaths),
      ...Object.values(s.staffAssignments ?? {}).flatMap(a => [...(a.scope ?? []), ...(a.readScope ?? [])])]);
    const equal = isDeepStrictEqual;
    if (
      revised.goal !== goal ||
      !equal(revised.scope, s.scope) ||
      !equal(revised.readScope, s.readScope) ||
      !equal(revised.budget, s.budget) ||
      (s.entryPolicy === "unified" ? s.workRequest && !revised.workRequest :
        !equal(revised.workRequest, s.workRequest)) ||
      !equal(
        revised.steps.map((x) => x.id),
        s.steps.map((x) => x.id),
      )
    )
      throw Error(
        "Revised plan must preserve project scope, budget, and steps and match --goal",
      );
    for (const before of s.steps) {
      const after = revised.steps.find((x) => x.id === before.id);
      if (
        !equal(before.scope, after.scope) ||
        !equal(before.dependsOn, after.dependsOn)
      )
        throw Error("Revision cannot change a step's scope or dependencies");
      if (before.independentReview && !after.independentReview)
        throw Error("Revision cannot remove a frozen independent review");
      if (before.works.some(work => work.independentReview) &&
          (before.checks.some(check => !after.checks.some(c => equal(c, check))) ||
           before.deliverables.some(path => !after.deliverables.includes(path))))
        throw Error("Revision cannot drop frozen independent review checks or deliverables");
      checkWorkRevision(s, before, after);
      const definition = ({
        id,
        goal,
        checks,
        deliverables,
        checkpoint,
        independentReview,
        works,
        review,
      }) => ({
        id,
        goal,
        checks,
        deliverables,
        checkpoint,
        works,
        ...(independentReview ? {independentReview:true} : {}),
        ...(review ? { review } : {}),
      });
      if (equal(definition(before), definition(after))) continue;
      if (!affected.has(before.id))
        throw Error("Changed step definition was not selected: " + before.id);
      previousDefinitions.push(definition(before));
      delete before.review;
      Object.assign(before, definition(after));
    }
    if (s.entryPolicy === "unified" && revised.workRequest) s.workRequest = revised.workRequest;
  } else {
    const selected = s.steps.filter(step => affected.has(step.id));
    const updated = preserveReviewRequest(goal, {steps:selected});
    if (updated.independentReview && allReviewTargets.test(goal) &&
        s.steps.some(step => !affected.has(step.id) && !step.independentReview))
      throw Error("Select every affected step for a project-wide independent review");

    if (updated.independentReview) {
      for (const step of selected) {
        previousDefinitions.push({id:step.id,goal:step.goal,works:structuredClone(step.works),
          checks:step.checks,deliverables:step.deliverables,checkpoint:step.checkpoint});
        step.independentReview = true;
        for (const work of step.works) work.independentReview = true;
      }
    }
  }
  for (let i = 0; i < s.steps.length; i++)
    for (const step of s.steps)
      if (step.dependsOn.some((x) => affected.has(x))) affected.add(step.id);
  s.revisions.push({
    previousGoal: s.goal,
    goal,
    revision: s.revision + 1,
    affected: [...affected],
    previousDefinitions,
    ...(s.delivery ? { previousDelivery: s.delivery } : {}),
    at: now(),
  });
  delete s.delivery;
  s.explicitSkills = command.plan ? projectSelections(command.plan).explicitSkills
    : [...new Set([...(s.explicitSkills ?? []), ...projectSelections({goal}).explicitSkills])];
  if (command.plan) {s.plugins = projectSelections(command.plan).plugins;s.mcp=projectSelections(command.plan).mcp;}
  s.goal = goal;
  s.revision++;
  for (const step of s.steps.filter((x) => affected.has(x.id))) {
    step.revision = s.revision;
    if (step.route) {
      (step.routeHistory ??= []).push(step.route);
      delete step.route;
    }
    if (step.status !== "unknown") {
      step.status = "pending";
      delete step.error;
    }
  }
  if (s.status !== "paused") s.status = "active";
  delete s.error;
}

function ownHost(home, loc, lock, initial) {
  let state = initial;
  const host = {
    home,
    read: () => structuredClone(state),
    assertOwned: lock.assertOwned,
    live: new Map(),
    runRequested: false,
    update(fn) {
      lock.assertOwned();
      const next = structuredClone(state),
        result = fn(next);
      if (result && typeof result.then === "function")
        throw Error("Project mutations must be synchronous");
      next.updatedAt = now();
      writePrivateJson(loc.file, next, lock.assertOwned);
      state = next;
      return result;
    },
  };
  // A command is acknowledged only after its effect and ID are in the same durable snapshot.
  let draining;
  host.drain = () => {
    if (draining) return draining;
    draining = (async () => {
      for (const file of readdirSync(loc.inbox)
        .filter((f) => f.endsWith(".json"))
        .sort()) {
        lock.assertOwned();
        const c = json(join(loc.inbox, file));
        if (!Object.hasOwn(state.commands, c.id)) {
          let error;
          try {
            if(state.entryPolicy==="unified")throw Error("Legacy inbox controls cannot mutate a unified project");
            if (c.action === "route") {
              host.update((s) => {
                s.commands[c.id] = { at: now(), status: "in_flight" };
              });
              await runProjectRoute({
                host,
                home,
                action: c.operation,
                input: c.input,
              });
            }
            if(c.action==="mcp") {
              host.update(s=>{s.commands[c.id]={at:now(),status:"in_flight"};});
              const id=c.input.originalRequestId;
              if(Object.keys(c.input).some(k=>k!=="originalRequestId")||typeof id!=="string"||!["query","cancel"].includes(c.operation))throw Error("MCP recovery accepts only originalRequestId and query/cancel");
              const claim=host.read().callIntents?.find(x=>x.kind==="external"&&x.id===id);
              if(!claim)throw Error("Unknown original MCP receipt");
              if(host.live.size) {
                const live=host.live.get(claim.taskId);
                if(!live)throw Error("Another live task owns this project; wait for its saved result");
                const result=await live.projectPolicy.recoverMcp(id,c.operation);
                host.update(s=>{s.mcpRecovery={...result,at:now()};});
              } else {
                const record=readTask(home,claim.taskId),policy=createProjectPolicy({host,binding:record.project,home});
                const result=await recoverProjectMcpReceipt({home,record,projectPolicy:policy,originalRequestId:id,action:c.operation,save:()=>writePrivateJson(join(home,"tasks",record.id+".json"),record,host.assertOwned)});
                host.update(s=>{s.mcpRecovery={...result,at:now()};});
              }
            }
            host.update((s) => {
              if (!["route","mcp"].includes(c.action)) control(s, c);
              s.commands[c.id] = { at: now() };
            });
            if (c.action === "resume") host.runRequested = true;
          } catch (e) {
            error = e.message;
            host.update((s) => {
              s.commands[c.id] = { at: now(), error };
            });
          }
          if (
            !error &&
            host.finalController &&
            ["pause", "revise"].includes(c.action)
          )
            host.finalController.abort();
          if (!error) for (const live of host.live.values())
            if (state.status === "paused" ||
              state.steps.find(x => x.id === live.stepId).revision !== live.revision)
              live.controller.abort();
        }
        unlinkSync(join(loc.inbox, file));
      }
    })().finally(() => {
      draining = null;
    });
    return draining;
  };
  return host;
}
function nextConfig(home, step, frozen) {
  const loaded = frozen ? structuredClone(frozen) : loadConfig(home);
  if (!loaded)
    throw Error("Set up a Team with cothink init before resuming this project");
  const cfg =
    loaded.formatVersion === 3 && !frozen
      ? resolveTeamConfig(loaded)
      : structuredClone(loaded);
  cfg.work = { ...cfg.work, checks: step.checks };
  return validateConfig(cfg);
}
function snapshot(s, step, attempt, home) {
  return {
    id: s.id,
    projectId: s.id,
    taskId: attempt.taskId,
    ...(attempt.rootTaskId ? {rootTaskId:attempt.rootTaskId,commandId:attempt.commandId,constraints:attempt.constraints,contextRef:attempt.contextRef,handoffContext:resolveHandoffContext(home,attempt.rootTaskId,attempt.contextRef,{commandId:attempt.commandId})} : {}),
    plugins: s.plugins ?? [],
    mcp: s.mcp ?? [],
    explicitSkills: s.explicitSkills ?? [],
    projectPluginRuntime: attempt.projectPluginRuntime ?? null,
    ...(s.workRequest ? {workRequest:s.workRequest} : {}),
    originalGoal: s.originalGoal,
    goal: s.goal,
    revision: step.revision,
    stepId: step.id,
    subgoal: step.goal,
    scope: step.scope,
    readScope: attempt.readScope ?? s.readScope ?? ["."],
    startVersion: attempt.startVersion,
    ...(attempt.checkPolicy ? {checkPolicy:attempt.checkPolicy} : {}),
    inputArtifacts: attempt.inputArtifacts,
    deliverables: step.deliverables,
    checks: step.checks,
    works: [...step.works, ...(step.subworks ?? [])],
    ...(step.independentReview ? {independentReview:true} : {}),
    checkpoint: step.checkpoint,
    staff: s.staff,
    dependencies: step.dependsOn.map((id) => {
      const other = s.steps.find((x) => x.id === id),
        a = other.attempts.at(-1);
      return {
        stepId: id,
        goal: other.goal,
        version: a.version,
        artifacts: a.artifacts,
      };
    }),
    ...(step.route ? { route: step.route } : {}),
  };
}
async function reconcileAttempt(
  host,
  step,
  attempt,
  { recovery = false } = {},
) {
  const { home } = host;
  const rec = savedTask(home, attempt.taskId);
  if (!rec) {
    if (host.read().callIntents?.some((c) => c.taskId === attempt.taskId))
      throw Error(
        "Project send intent exists without its original task record: " +
          attempt.taskId,
      );
    return "unsent";
  }
  if (
    rec.submissionId !== attempt.submissionId ||
    rec.input !== (attempt.contextRef ? resolveHandoffContext(home,attempt.rootTaskId,attempt.contextRef,{commandId:attempt.commandId}).input : host.read().originalGoal) ||
    rec.project?.id !== host.read().id ||
    rec.project?.stepId !== step.id ||
    (attempt.rootTaskId && (rec.rootTaskId!==attempt.rootTaskId || rec.project?.commandId!==attempt.commandId))
  )
    throw Error(
      "Task does not match its saved project intent; inspect " + attempt.taskId,
    );
  const requests = readRequests(home, rec);
  const proof = await evidence(
    home,
    host.read(),
    step,
    rec,
    requests,
    attempt,
  );
  if (recovery)
    host.update((state) => reconcileProjectCalls(state, rec, requests));
  const claims =
    host.read().callIntents?.filter((c) => c.kind !== "external" && c.taskId === rec.id && !c.notSent) ??
    [];
  const ambiguous = claims.filter(
    (c) => !requests.some((r) => r.id === c.id && r.sent),
  );
  if (ambiguous.length) {
    proof.unknown = true;
    proof.error =
      "Dispatch intent has no decisive original request evidence: " +
      ambiguous.map((c) => c.id).join(", ");
  }
  const staff = createProjectStaff(host);
  staff.reconcile(rec, requests, proof.kernelRequests ?? []);
  // Before the first model send, a process can only have allocated read-only resources
  // or started the declared change. A writable/uncertain operation requires inspection.
  const preliminary = (rec.work?.requests ?? []).every(
    (r) => r.action === "beginChange",
  );
  if (
    recovery &&
    !requests.some((r) => r.sent) &&
    preliminary &&
    !proof.unknown &&
    rec.status === "outcome_unknown" &&
    !rec.tools?.length
  ) {
    const backup = join(
      home,
      "project-delivery",
      host.read().id,
      attempt.taskId + ".unsent.json",
    );
    if (!existsSync(backup))
      writePrivateJson(backup, { record: rec, requests }, host.assertOwned);
    return "unsent";
  }
  if (rec.status === "outcome_unknown" && requests.some((r) => r.sent)) {
    // Even with a terminal response, its remaining tools/finalization were not necessarily consumed.
    proof.error ??=
      "Process exited after a recorded send; original task was not terminal";
  }
  host.update((s) => {
    const current = s.steps.find((x) => x.id === step.id),
      a = current.attempts.find((x) => x.taskId === attempt.taskId);
    Object.assign(a, proof, {
      status: proof.unknown ? "unknown" : proof.error ? "blocked" : "completed",
    });
    if (
      proof.integrationRef &&
      s.integrationRef &&
      s.integrationRef !== proof.integrationRef
    )
      throw Error("Formal ref changed");
    if (
      proof.ownedLine &&
      (a.checkPolicy ? proof.advancesProject : [a.startVersion, proof.formalVersion].includes(s.version))
    ) {
      s.version = proof.formalVersion;
      s.integrationRef = proof.integrationRef;
    }
    if (proof.unknown) {
      current.status = "unknown";
      current.error = proof.error ?? "Unresolved sent request";
    } else if (current.revision !== a.revision) {
      current.status = "pending";
      delete current.error;
    } else if (!proof.error) {
      current.status = "completed";
      delete current.error;
    } else {
      current.status = "blocked";
      current.error = proof.error;
      if (
        (s.status === "paused" && rec.cancelRequestedAt) ||
        (rec.status === "cancelled" && rec.cancelSettledAt)
      )
        current.status = "pending";
    }
    if (
      s.status !== "paused" &&
      current.revision === a.revision &&
      !proof.unknown
    ) {
      if (!proof.error && current.checkpoint)
        recordRouteObservation(s, current.id, {
          kind: "checkpoint",
          candidate: proof.version,
          evidence: proof.check,
        });
      else if (proof.check?.status === "check_failed")
        recordRouteObservation(s, current.id, {
          kind: "failed",
          candidate: proof.check.version,
          evidence: proof.check,
        });
      if (
        current.route &&
        ["paused", "judged", "probing", "blocked"].includes(
          current.route.status,
        )
      )
        current.status = "review";
    }
  });
  return "settled";
}
async function revisit(host) {
  const state = host.read();
  for (const step of state.steps) {
    for (const a of step.attempts) {
      if (a.status !== "intent" && a.status !== "unknown") continue;
      const outcome = await reconcileAttempt(host, step, a, { recovery: true });
      if (outcome !== "unsent" || a.status !== "intent" || state.stepScheduling !== "dependencies-v1" ||
          !host.unified || a.rootTaskId === host.unified.rootTaskId) continue;
      // A stop may land after registering a ready attempt and before the first
      // send. Preserve that identity and only let the new explicit root admit
      // remaining work after recovery proves that the old attempt did not send.
      host.update(current => {
        const row = current.steps.find(x => x.id === step.id), old = row.attempts.find(x => x.taskId === a.taskId);
        old.status = "not_sent";
        old.endedAt ??= now();
        if (row.attempts.at(-1) === old && ["running", "blocked"].includes(row.status)) row.status = "pending";
      });
    }
  }
}
async function autoReview(host) {
  const s = host.read();
  if (s.status !== "active") return;
  for (const step of s.steps) {
    if (
      !step.review ||
      !step.route ||
      !["paused", "judged"].includes(step.route.status)
    )
      continue;
    const input = {
      ...step.review,
      stepId: step.id,
      revision: step.revision,
      candidate: step.route.candidate,
    };
    try {
      if (step.route.status === "paused")
        await runProjectRoute({
          host,
          home: host.home,
          action: "judge",
          input,
        });
      if (host.read().status === "active")
        await runProjectRoute({
          host,
          home: host.home,
          action: "experiment",
          input,
        });
    } catch (e) {
      host.update((state) => {
        state.steps.find((x) => x.id === step.id).error = e.message;
      });
    }
  }
}
// The existing project host owns one queue for the formal ref and one pool
// for actual HTTP sends. Worker sessions keep their own local work queues.
export function requestSeats(limit) {
  const waiters = [];
  let occupied = 0;
  const grant = () => {
    while (occupied < limit && waiters.length) {
      const waiter = waiters.shift();
      waiter.signal.removeEventListener('abort',waiter.cancel);
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
      occupied++;
      let released = false;
      waiter.resolve(() => { if (!released) { released = true; occupied--; grant(); } });
    }
  };
  return signal => new Promise((resolve,reject) => {
    signal.throwIfAborted();
    const waiter = {signal,resolve,reject,cancel:()=>{
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i,1);
      reject(signal.reason);
    }};
    waiters.push(waiter);
    signal.addEventListener('abort',waiter.cancel,{once:true});
    grant();
  });
}

function plannedReads(state, step) {
  return [...new Set([...step.scope,...step.deliverables,...state.steps
    .filter(other=>step.dependsOn.includes(other.id)).flatMap(other=>other.deliverables)])]
    .filter(path=>inScope(path,state.readScope));
}
function overlapSteps(state,a,b) {
  return projectScopesOverlap(a.scope,b.scope) || projectScopesOverlap(a.scope,plannedReads(state,b)) ||
    projectScopesOverlap(b.scope,plannedReads(state,a));
}

async function launchStep(host, signal, uiContext, s, step) {
  const {home} = host;
  const f = host.kernel ? await host.kernel.inspect() : await formal(home,s.repo);
  if ((s.integrationRef && f.integrationRef !== s.integrationRef) ||
      (s.version && s.version !== f.version && (!host.kernel ||
        !onOwnedLine(await ownedParents(host.kernel,home,s),f.version,s.version))))
    throw Error("Formal line changed outside the saved project decision; inspect before resuming");
  let inputArtifacts;
  try {
    inputArtifacts = await provePrevious(home,s,f.version,step.dependsOn);
    if (host.kernel && inputArtifacts.some(artifact=>!inScope(artifact.path,s.readScope)))
      throw Error('Dependency artifact is outside the approved read scope');
  } catch (e) {
    host.update(state => {
      const job = state.steps.find(x => x.id === step.id);
      if (job.revision === step.revision) { job.status = 'blocked'; job.error = e.message; }
    });
    return;
  }
  if (host.kernel) {
    const registered = host.checkedDefinitions.get(step.id);
    if (registered?.revision !== step.revision || !isDeepStrictEqual(registered?.checks,step.checks))
      throw Error('The current step revision was not registered with the project owner');
  }
  let config = nextConfig(home,step,host.unified?.frozenConfig);
  const current = host.read(), latest = current.steps.find(x => x.id === step.id);
  if (signal.aborted || current.status !== 'active' || latest.revision !== step.revision || latest.status !== step.status) return;
  const pending = step.attempts.findLast(a => a.status === 'intent' && a.revision === step.revision);
  if (step.route?.status === 'repair' && step.route.candidate !== f.version) {
    host.update(state => {
      const job = state.steps.find(x => x.id === step.id);
      job.status = 'review';
      job.error = 'The reviewed private candidate requires its original draft; no new task was sent';
    });
    return;
  }
  if (!pending) host.update(state => {
    const job = state.steps.find(x => x.id === step.id);
    job.attempts.push({
      ...(host.unified ? {rootTaskId:host.unified.rootTaskId,commandId:host.unified.commandId,frozenConfig:structuredClone(config),constraints:host.unified.rootOwner.rootTask.record.constraints,contextRef:structuredClone(host.unified.contextRef)} : {}),
      taskId:randomUUID(), submissionId:randomUUID(), revision:job.revision,
      startVersion:f.version, inputArtifacts,
      ...(host.kernel ? {checkPolicy:host.policy('step-'+step.id),
        readScope:plannedReads(s,step)} : {}),
      execution:config.work.execution ?? null,
      projectPluginRuntime:config.work.projectPluginRuntime ?? null,
      status:'intent', createdAt:now(),
    });
    job.status = 'running'; state.version = f.version; state.integrationRef = f.integrationRef;
  });
  const active = host.read(), job = active.steps.find(x => x.id === step.id), attempt = job.attempts.at(-1);
  if (attempt.startVersion !== f.version || attempt.status !== 'intent')
    throw Error('Saved start intent does not match the current version');
  if (host.unified && attempt.rootTaskId !== host.unified.rootTaskId)
    throw Error('Unsettled attempt belongs to an earlier root; inspect its original result before resuming');
  if (attempt.frozenConfig) config = structuredClone(attempt.frozenConfig);
  if (attempt.execution) config.work.execution = attempt.execution;
  config.work.projectPluginRuntime = attempt.projectPluginRuntime ?? undefined;
  const binding = snapshot(active,job,attempt,home), staff = createProjectStaff(host);
  const projectPolicy = createProjectPolicy({host,binding,staff,home}), controller = new AbortController();
  const ready = Promise.withResolvers(), observer = {};
  if (host.acquireRequestSeat) Object.assign(projectPolicy,{
    acquireRequestSeat:host.acquireRequestSeat,maxConcurrentRequests:host.maxConcurrentRequests,
  });
  if (host.kernel) Object.assign(projectPolicy, {
    kernel:host.kernel,withFormal:host.withFormal,
    attachOperationObserver:onOperation=>{observer.onOperation=onOperation;},initialProjectionSettled:ready.resolve,
  });
  const live = {stepId:job.id,revision:job.revision,taskId:attempt.taskId,projectPolicy,controller};
  host.live.set(attempt.taskId,live);
  const run = async () => {
    let error;
    try {
      if (host.read().status === 'paused' || controller.signal.aborted || signal.aborted ||
          host.read().steps.find(x => x.id === job.id).revision !== job.revision) return;
      await runTurn({
        home,cwd:s.repo,input:binding.handoffContext?.input ?? s.originalGoal,config,
        id:attempt.taskId,submissionId:attempt.submissionId,project:binding,workRequest:binding.workRequest,projectPolicy,
        ...(host.unified ? {rootOwner:host.unified.rootOwner,rootTaskId:host.unified.rootTaskId,frozenSkillSource:host.unified.rootOwner.rootTask.record,packageSnapshot:host.unified.rootOwner.rootTask.record.packageSnapshot,frozenPackageSnapshot:host.unified.rootOwner.rootTask.record.packageSnapshot} : {}),
        ...(uiContext ? {uiContext,uiMode:'rpc'} : {}),
        signal:AbortSignal.any([controller.signal,signal]),
      });
    } catch (e) { error = e.message; }
    finally { ready.resolve(); }
    const settle = async () => {
      if (!savedTask(home,attempt.taskId)) {
        host.update(state => {
          const row = state.steps.find(x => x.id === job.id);
          row.error = error ?? 'No task record'; row.status = 'blocked';
          if (!host.kernel && state.status !== 'paused') state.status = 'blocked';
        });
      } else await reconcileAttempt(host,job,attempt);
    };
    await (host.kernel ? host.withFormal(settle) : settle());
  };
  live.done = (host.operationObservers ? host.operationObservers.run(observer,run) : run()).finally(()=>host.live.delete(attempt.taskId));
  // Keep failures available to the scheduler even when initial projection ends first.
  live.done.catch(()=>{});
  if (host.kernel) await ready.promise;
  return live;
}

async function schedule(host, signal, uiContext) {
  const parallel = host.read().stepScheduling === 'dependencies-v1';
  let lastFailure;
  try {
    await revisit(host);
    if (host.read().stepScheduling && !signal.aborted && host.read().status === 'active') {
      const s = host.read(), config = nextConfig(host.home,s.steps[0],host.unified?.frozenConfig);
      host.maxConcurrentRequests = config.work.maxConcurrentRequests ?? 2;
      const ordinarySeat=requestSeats(host.maxConcurrentRequests),checkSeat=requestSeats(1);
      // The request policy has already checked the host-issued stage before fetch.
      host.acquireRequestSeat=(signal,stage)=>stage?.phase==='process-check'?checkSeat(signal):ordinarySeat(signal);
    }
    if (parallel && !signal.aborted && host.read().status === 'active') {
      const s = host.read(), config = nextConfig(host.home,s.steps[0],host.unified?.frozenConfig);
      const execution = config.work.execution;
      if (!execution || s.steps.some(step => step.attempts.some(a => a.checkPolicy &&
        !isDeepStrictEqual(a.execution,execution))))
        throw Error('The fixed execution environment differs from the saved project');
      host.withFormal = fn => withChangeQueue(host,'formal',fn);
      host.operationObservers = new AsyncLocalStorage();
      host.checkedDefinitions = new Map(s.steps.map(step=>[step.id,{revision:step.revision,checks:step.checks}]));
      host.kernel = await createVersioning({home:host.home,project:s.repo,execution,signal,
        checkPolicies:{...Object.fromEntries(s.steps.map(step=>['step-'+step.id,step.checks])),
          'project-final':s.steps.flatMap(step=>step.checks)},
        onOperation:e=>host.operationObservers.getStore()?.onOperation?.(e),
      });
      const catalog = (await host.kernel.inspect()).checkPolicies;
      host.policy = id => ({id,digest:catalog[id]});
    }
    for (;;) {
      await host.drain();
      if (host.read().status === 'paused' || signal.aborted) return;
      await autoReview(host);
      const s = host.read();
      const live = [...host.live.values()];
      const step = parallel ? s.steps.find(step =>
        ['pending','running'].includes(step.status) &&
        step.dependsOn.every(id=>s.steps.find(other=>other.id===id)?.status==='completed') &&
        !live.some(active=>active.stepId===step.id) &&
        !s.steps.some(other=>other.id!==step.id && (other.status==='unknown'||live.some(active=>active.stepId===other.id)) &&
          overlapSteps(s,step,other))) : nextStep(s);
      if (step && (!parallel || live.length < host.maxConcurrentRequests)) {
        const launched = await (host.kernel ? host.withFormal(()=>launchStep(host,signal,uiContext,s,step)) : launchStep(host,signal,uiContext,s,step));
        if (launched) {
          if (!parallel) await launched.done;
          else launched.done.catch(error=>{lastFailure ??= error;});
        }
        if (lastFailure) throw lastFailure;
        if (!parallel && host.read().status === 'blocked') return;
        continue;
      }
      if (live.length) { await Promise.race(live.map(entry=>entry.done)); continue; }
      if (lastFailure) throw lastFailure;
      const complete = s.steps.every(x=>x.status==='completed');
      if (complete) {
        await verifyDelivery(host,s,signal);
        const accepted = host.read();
        if (host.unified && s.workRequest && accepted.status === "active" &&
            accepted.delivery?.revision === s.revision && !signal.aborted)
          await verifyProjectVisual(host, accepted, s.delivery?.visual, signal);
      }
      const result = host.read();
      if (result.revision !== s.revision) continue;
      if (result.status === 'paused' || signal.aborted) return;
      if (complete && result.delivery?.revision !== s.revision)
        throw Error('No project delivery verification is available');
      host.update(state=>{if(state.status!=='paused')state.status=complete?'completed':'blocked';});
      return;
    }
  } finally {
    const live = [...host.live.values()];
    for (const entry of live) entry.controller.abort();
    await Promise.allSettled(live.map(entry=>entry.done));
    await host.kernel?.close();
    host.kernel = null;
  }
}

export async function runProjectCommand({
  home,
  cwd = process.cwd(),
  args,
  providedPlan,
  expectedRevision,
  uiContext,
  report = () => {},
  unified,
  signal = new AbortController().signal,
}) {
  if(unified)assertRootOwner(unified.rootOwner,unified.rootTaskId);
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      file: { type: "string" },
      goal: { type: "string" },
      step: { type: "string", multiple: true },
    },
  });
  const [action, operation, data] = positionals;
  if (values.help || !action) return { text: projectHelp, code: 0 };
  if (
    ![
      "start",
      "status",
      "pause",
      "resume",
      "revise",
      "staff",
      "route",
      "mcp",
    ].includes(action) ||
    positionals.length > (["staff", "route", "mcp"].includes(action) ? 3 : 1)
  )
    throw Error(projectHelp);
  if (values.file && !["start", "revise"].includes(action))
    throw Error("--file is only valid for start or revise");
  const plan = providedPlan ?? (
    action === "start" || (action === "revise" && values.file)
      ? json(resolve(cwd, required(values.file, "--file")))
      : null);
  const loc = await locate(
    home,
    resolve(cwd, values.repo ?? plan?.repo ?? "."),
  );
  if (
    plan?.repo &&
    values.repo &&
    realpathSync(resolve(cwd, plan.repo)) !== loc.repo
  )
    throw Error("Plan repo differs from --repo");
  if (action === "status")
    return rendered(await view(home, loc), values.json, 0, home);
  const existing=existsSync(loc.file)?stored(loc):null;
  if(existing && existing.repo!==loc.repo)throw Error("This project belongs to another canonical worktree: "+existing.repo);
  if(existing?.entryPolicy==="unified"&&!unified)throw Error("Unified project mutations require the owning GUI root; CLI status remains available");
  if(unified && existing?.commands?.[unified.commandId]) {
    const receipt=existing.commands[unified.commandId];
    if(receipt.rootTaskId!==unified.rootTaskId||receipt.operationDigest!==unified.operationDigest)throw Error("Command identity conflict");
    return rendered(existing,values.json,receipt.error?1:0,home);
  }
  if (action !== "start" && !existsSync(loc.file))
    throw Error("No project started for this repository");
  privateDirectory(loc.dir);
  privateDirectory(loc.inbox);
  const command = {
    action,
    operation,
    input: data ? JSON.parse(data) : {},
    goal: values.goal,
    ...(expectedRevision !== undefined ? {expectedRevision} : {}),
    steps: values.step ?? [],
    ...(action === "revise" && plan ? { plan } : {}),
    id: unified?.commandId ?? randomUUID(),
    ...(unified ? {rootTaskId:unified.rootTaskId} : {}),
  };
  if (action !== "start" && !unified)
    writePrivateJson(join(loc.inbox, command.id + ".json"), command);
  const finish = (s, code = 0) => rendered(s, values.json, code, home);
  let writer;
  for (;;) {
    if (action !== "start" && existsSync(loc.file)) {
      const s = stored(loc),
        receipt = s.commands[command.id];
      if (receipt) {
        if (receipt.error) throw Error(receipt.error);
        if (receipt.status !== "in_flight") return finish(s);
        if (!sessionWriterBusy(loc.store, loc.id))
          throw Error(
            "Route control was interrupted; inspect its saved judgment or probe, do not replay",
          );
      }
    }
    if (signal.aborted)
      throw Error("Project command interrupted; inspect its saved state");
    try {
      writer = acquireSessionWriter(loc.store, loc.id);
      break;
    } catch (e) {
      if (e.code !== "SESSION_BUSY" || action === "start") throw e;
      await delay(40);
    }
  }
  let host, timer, onStop;
  try {
    if (action === "start" && existsSync(loc.file))
      throw Error(
        "This repository already has a project; use status or resume",
      );
    if(unified){
      const observed=await formal(home,loc.repo),proposal=unified.rootOwner.rootTask.record.proposal;
      const current=existsSync(loc.file)?stored(loc):null;
      assertConfirmedProjectState(proposal,{repo:loc.repo,version:observed.version,state:current,expectedRevision});
      signal.throwIfAborted();
    }
    const state = action === "start" ? compileProjectPlan(plan, loc).state : stored(loc);
    host = ownHost(home, loc, writer, state);
    if(unified){
      host.unified=unified;
      host.update(s=>{
        const scheduling=unified.rootOwner.rootTask.record.proposal.stepScheduling;
        if(action==='start'&&['dependencies-v1','sequential-v1'].includes(scheduling))
          s.stepScheduling=scheduling;
        if(action!=="start")control(s,command);
        if (action !== "resume" && s.workRequest) {
          const record = unified.rootOwner.rootTask.record;
          s.visualContract = { originalTask: record.handoffContext.input, networkMode: record.constraints.networkMode ?? null };
        }
        assertProjectReviewRequirement(s,unified.rootOwner.rootTask.record.constraints);
        s.entryPolicy="unified";s.readScope??=s.scope;s.commands[command.id]={status:"in_flight",rootTaskId:unified.rootTaskId,operationDigest:unified.operationDigest,at:now()};
      });
      host.runRequested=true;
    } else if (action === "start") host.update(() => {});
    onStop = () => {
      try {
        host.update((s) => {
          s.status = "paused";
        });
      } finally {
        for (const live of host.live.values()) live.controller.abort();
      }
    };
    signal.addEventListener("abort", onStop, { once: true });
    if(signal.aborted)onStop();
    await host.drain();
    const receipt = host.read().commands[command.id];
    if (receipt?.error) throw Error(receipt.error);
    if (action === "start") host.runRequested = true;
    timer = setInterval(() => {
      void host.drain().catch((e) => {
        for (const live of host.live.values()) live.controller.abort(e);
      });
    }, 40);
    do {
      if (host.runRequested && host.read().status !== "completed") {
        host.runRequested = false;
        try {
          const { budget } = host.read();
          const calls = budget.maxCalls === null ? "不设上限" : `最多 ${budget.maxCalls} 次`;
          const cost = budget.maxCost === null ? "未设硬费用上限" : `硬费用上限 ${budget.maxCost}，无法核实单次支出时停止发送`;
          report(`项目预算：累计模型调用${calls}，${cost}。另一个窗口可用 cothink project status 查看进度。`);
          await schedule(host, signal, uiContext);
        } catch (e) {
          host.update((s) => {
            s.error = e.message;
            if (s.status !== "paused") s.status = "blocked";
          });
        }
      } else host.runRequested = false;
      await host.drain();
    } while (host.runRequested && !signal.aborted);
    if(unified && unified.rootOwner.rootTask.record.constraints.requireDifferentModelReview && host.read().status==='completed'){
      const delivered=host.read();
      assertProjectReviewRequirement(delivered,unified.rootOwner.rootTask.record.constraints);
      const reviews=[];
      await provePrevious(home,delivered,delivered.delivery.version,undefined,reviews);
      if(!reviews.length)throw problem('PROJECT_REVIEW_REQUIRED','当前交付缺少可核验的异型号独立评审证据。');
      if(signal.aborted)onStop();
    }
    if(unified)host.update(s=>{
      if(s.delivery){
        s.delivery.taskIds=s.steps.filter(step=>step.status==="completed").map(step=>step.attempts.at(-1).taskId);
        (s.deliveries??={})[s.delivery.revision]=structuredClone(s.delivery);
      }
      s.commands[command.id]={...s.commands[command.id],status:"settled",resultStatus:s.status,endedAt:now(),
        ...(s.delivery?.visual?{visual:structuredClone(s.delivery.visual)}:{})};
    });
    const result = host.read();
    return finish(
      result,
      ["start", "resume"].includes(action) && result.status === "blocked"
        ? 1
        : 0,
    );
  } finally {
    clearInterval(timer);
    if (onStop) signal.removeEventListener("abort", onStop);
    writer.release();
  }
}
function rendered(s, asJson, code, home) {
  const state = {
    ...summary(s),
    ...(s.writerActive !== undefined
      ? {
          writerActive: s.writerActive,
          currentVersion: s.currentVersion,
          formalRef: s.formalRef,
          blocker: s.blocker,
        }
      : {}),
    usage: s.usage ?? projectUsage(s, home),
  };
  const text = asJson
    ? JSON.stringify(state, null, 2) + "\n"
    : [
        `项目 ${state.id} · ${state.status}`,
        state.goal,
        `仓库 ${state.repo}`,
        `正式版本 ${state.currentVersion ?? state.version ?? "尚无"} · 下一步 ${state.next ?? "无"}`,
        ...state.steps.map((x) => {
          const a = x.attempts.at(-1);
          return [
            x.id,
            x.status,
            x.goal,
            a?.resultWorkspace,
            a?.taskId && "cothink show " + a.taskId,
          ]
            .filter(Boolean)
            .join("  ");
        }),
        ...Object.values(state.staffAssignments ?? {}).map(a => {
          const requests = (state.callIntents ?? []).filter(c => c.taskId === a.taskId && c.role === a.role);
          const ids = [...new Set([...requests.map(c => c.id), ...(a.requestId ? [a.requestId] : [])])];
          const reviews = (a.reviewReceipts ?? []).map(r =>
            `${r.label} · ${r.verdict}${r.kind === "independent" && !r.certified ? "（型号独立性未核实）" : ""} · 候选 ${r.candidateVersion} · 请求 ${r.requestId} · ${r.observation}`
          );
          return [`岗位 ${a.staffId} · ${a.model} · 工作 ${a.workId ?? "旧记录未注明"} · 派工 ${a.dispatchId} · ${a.status} · 请求 ${ids.join("、") || "尚无"}`, ...reviews].join("\n");
        }),
        `模型调用 ${state.usage.calls}，助手 ${state.usage.helpers}，实际费用 ${state.usage.actualCost ?? "未知"}`,
        state.blocker,
      ]
        .filter(Boolean)
        .join("\n") + "\n";
  return { text: asJson ? text : safeText(text), code };
}

/** Programmatic adapter shares the CLI scheduler; it cannot be authorized by a string ID alone. */
export async function runProjectOperation({home,cwd,action,commandId,rootTaskId,expectedRevision,providedPlan,frozenConfig,contextRef,rootOwner,signal,onProgress=()=>{}}) {
  assertRootOwner(rootOwner,rootTaskId);
  if(!["start","resume","revise"].includes(action)||!/^[\da-f-]{36}$/.test(commandId))throw Error("Invalid unified operation");
  if(providedPlan?.repo)throw Error("Model plan may not choose the repository");
  const root=rootOwner.rootTask.record, saved=root.projectOperation;
  if(!saved||saved.commandId!==commandId||saved.action!==action||!saved.registered)throw Error("Operation must be durably registered before dispatch");
  const args=[action,"--json"];
  if(action==="revise"){
    args.push("--goal",providedPlan.goal);
    for(const step of providedPlan.steps??[{id:"main"}])args.push("--step",step.id);
  }
  resolveHandoffContext(home,rootTaskId,contextRef,{commandId});
  if(digest(saved.frozenConfigRef)!==digest({taskId:rootTaskId,field:"frozenConfig",sha256:digest(frozenConfig)})||digest(saved.planRef)!==digest({taskId:rootTaskId,field:"proposal",sha256:digest(root.proposal)}))throw Error("Frozen operation sources changed");
  const operationDigest=digest({action,providedPlan:providedPlan??null,expectedRevision:expectedRevision??null,rootTaskId,contextRef});
  const result=await runProjectCommand({home,cwd,args,providedPlan,expectedRevision,signal,report:onProgress,
    unified:{commandId,rootTaskId,rootOwner,frozenConfig,contextRef,operationDigest}});
  const loc=await locate(home,cwd),state=stored(loc);
  return {state,executionBinding:{projectId:state.id,canonicalRepo:loc.repo,commonDir:loc.commonDir,formalRef:state.integrationRef??null},code:result.code};
}
export async function queryProjectOperation({home,cwd,commandId}) {
  const loc=await locate(home,cwd);
  if(!existsSync(loc.file)) {
    if(existsSync(join(loc.inbox,commandId+".json")))throw Error("Command inbox exists without project state");
    return {exists:false,projectId:loc.id};
  }
  const state=stored(loc);if(state.repo!==loc.repo)throw Error("Canonical repository mismatch");
  return {exists:Boolean(state.commands[commandId]),receipt:state.commands[commandId]??null,state};
}

export function validateProjectRevision(state,plan){
 const copy=structuredClone(state);control(copy,{action:'revise',goal:plan.goal,steps:(plan.steps??[{id:'main'}]).map(s=>s.id),plan,expectedRevision:state.revision});
}

/** A root may tighten acceptance, but resume cannot silently rewrite the saved plan. */
export function assertProjectReviewRequirement(state,constraints){
 if(!constraints?.requireDifferentModelReview)return;
 const missing=!state?.steps?.length||state.steps.some(step=>!step.works?.length||[...step.works,...(step.subworks??[])].some(work=>work.independentReview!==true));
 if(missing)throw problem('PROJECT_REVIEW_REQUIREMENT','本条要求异型号独立评审，但当前项目修订没有覆盖全部交付的评审要求。请提交 independentReview:true 的明确 revise 计划并确认；旧交付不视为满足新要求。');
}
