import { createModelRuntime, projectModelFacts } from "./pi-model-runtime.js";
import { validateConfig } from "./config.js";
import { DEFAULT_THINKING_LEVEL } from "./thinking.js";
import { validateModelRefs } from "./setup.js";
import { snapshotTeam } from "./teams.js";
import { materialImage, requireMaterialImageModel } from "./context.js";
import { problem } from "./task.js";

/** Prepare one turn's effective models before creating its task or sending requests. */
export async function prepareTurnModelFacts({
  home, frozen, mainRuntime, unified, rootOwner, confirmedOperation,
  singleModel, project, materials,
}) {
  validateConfig(frozen);
  const catalog = mainRuntime?.modelRuntime ?? (await createModelRuntime(home));
  for (const ref of [frozen.main, ...frozen.secondary]) {
    if (ref.thinkingLevel === undefined && catalog.getModel(ref.provider, ref.modelId)?.reasoning)
      ref.thinkingLevel = DEFAULT_THINKING_LEVEL;
  }
  if (frozen.team)
    frozen.team = snapshotTeam({
      ...frozen.team,
      main: frozen.main,
      secondary: frozen.secondary,
    });
  const inheritedModelFacts = confirmedOperation?.source?.projectModelFacts ??
    rootOwner?.rootTask?.record.projectModelFacts;
  const projectRoutes = inheritedModelFacts ? structuredClone(inheritedModelFacts) :
    (unified || rootOwner)
      ? await Promise.all([frozen.main, ...frozen.secondary].map(ref => projectModelFacts(catalog, ref)))
      : null;
  if (projectRoutes) {
    const [mainRoute] = projectRoutes;
    if (!mainRoute.available) throw problem(mainRoute.unavailableCode, mainRoute.unavailableReason);
  } else {
    await validateModelRefs(frozen, catalog, { singleModel: unified || Boolean(rootOwner) || singleModel });
  }
  if (!confirmedOperation && materials.some(material => materialImage(material.manifest))) {
    const reviewPossible = !unified && !singleModel && !project;
    for (const ref of [frozen.main, ...(reviewPossible ? frozen.secondary.slice(0, 1) : [])])
      requireMaterialImageModel(catalog.getModel(ref.provider, ref.modelId), ref);
  }
  // The caller writes these existing fields after the task's initial operation
  // identity is durable, and before onTaskCreated can consume that identity.
  const modelFactsSnapshot = projectRoutes ? {
    projectModelFacts: structuredClone(projectRoutes),
    projectModelFactsSource: inheritedModelFacts ? "inherited_task_snapshot" :
      confirmedOperation ? "current_at_confirmation_historical_unknown" : "current_at_task_start",
  } : null;
  return { catalog, projectRoutes, modelFactsSnapshot };
}
