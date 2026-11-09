import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const productRoot = resolve(
  process.env.COTHINK_TEST_PACKAGE_ROOT ?? fileURLToPath(new URL("../..", import.meta.url)),
);
export const load = path => import(pathToFileURL(join(productRoot, path)));

const { saveConfig } = await load("src/config.js");
const { createTeamConfig } = await load("src/teams.js");

export const teamId = "7c8094cd-3476-4bfa-8f53-055d87972896";
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
