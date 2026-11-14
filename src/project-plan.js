import {validateWorkRequest} from './visual-preview.js';
import {validateProjectMcp} from './project-mcp-work.js';
import {validateProjectBudget} from './project-request-accounting.js';
import {inScope,validProjectPath,assertProjectPathSpellings} from './versioning.js';
import {now} from './project-delivery-checks.js';

export const required = (s, label) => {
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
export const allReviewTargets = /(?:所有|每(?:一个|个)?|各)(?:项目)?(?:步骤|工作项|交付物)|\b(?:each|every|all)\s+(?:project\s+)?(?:steps?|works?|deliverables?)\b/i;
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

export function workDefinitions(step, scope, deliverables, requiredReview) {
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
export const stepPaths = step => [
  ...(step.scope ?? []), ...(step.deliverables ?? []),
  ...[...(step.works ?? []), ...(step.subworks ?? [])].flatMap(work => work.scope),
];
export function projectSelections(plan) {
  const names = (value, label) => {
    if (!Array.isArray(value ?? []) || (value ?? []).some(x => typeof x !== "string" || !x.trim()))
      throw Error(label + " must be a list of nonempty names");
    return [...new Set(value ?? [])];
  };
  const explicit = [...required(plan.goal, "goal").matchAll(/(?:^|\s)(?:\/skill:|\$)([a-zA-Z0-9_-]+)(?=\s|$|[.,，。])/g)].map(m => m[1]);
  return {mcp:validateProjectMcp(plan.mcp),plugins:names(plan.plugins,"plugins"),explicitSkills:[...new Set([...names(plan.explicitSkills,"explicitSkills"),...explicit])]};
}
export function compileProjectPlan(plan, location, userInput) {
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
