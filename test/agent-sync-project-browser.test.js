import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { saveConfig } from "../src/config.js";
import { createVersioning } from "../src/versioning.js";
import { execution } from "./helpers/agent-sync-fixture.js";
import { invoke } from "./helpers/cli-fixture.js";
import { git, repository } from "./helpers/git-fixture.js";
import { fixture } from "./helpers/pi-fixture.js";

const preview = JSON.parse(readFileSync(new URL("../docker/visual-preview-manifest.json", import.meta.url)));

// Frozen in the project plan, outside the application and every worker's write scope.
async function checkPage() {
  const assert = require("node:assert/strict");
  const { pathToFileURL } = require("node:url");
  const { resolve } = require("node:path");
  const { chromium } = require("/opt/preview/node_modules/playwright-core");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve("index.html")).href);
    for (const [quantity, expected] of [["3", "5"], ["10", "10"]]) {
      await page.getByLabel("Quantity").fill(quantity);
      await page.getByLabel("Minimum").fill("5");
      await page.getByRole("button", { name: "Calculate" }).click();
      const actual = await page.locator("output").innerText();
      console.log(JSON.stringify({ quantity, expected, actual }));
      assert.equal(actual, expected);
    }
  } finally {
    await browser.close();
  }
}

test("two same-model claims cannot deliver a broken page; a repaired formal version passes the same browser inputs", async t => {
  const repo = repository(t);
  const entry = `<!doctype html><meta charset="utf-8"><title>Order quantity</title>
<script src="algorithm.js"></script>
<form><label>Quantity <input name="quantity" type="number"></label>
<label>Minimum <input name="minimum" type="number"></label>
<button>Calculate</button><output></output></form>
<script>
document.querySelector("form").onsubmit = event => {
  event.preventDefault();
  const fields = event.target.elements;
  event.target.querySelector("output").value = orderQuantity(fields.quantity.value, fields.minimum.value);
};
</script>`;
  const bug = "quantity > minimum ? quantity : minimum";
  writeFileSync(join(repo.project, "index.html"), entry);
  writeFileSync(join(repo.project, "algorithm.js"), `function orderQuantity(quantity, minimum) { return ${bug}; }\n`);
  git(repo.project, "status", "--porcelain");
  git(repo.project, "add", "--", "index.html", "algorithm.js");
  git(repo.project, "commit", "-m", "Seed the integrated order page with a numeric coercion bug");

  const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
  const claims = [];
  let repairing = false, leaderTurns = 0, repairTurns = 0;
  const f = await fixture(t, ({ body }) => {
    if (repairing) {
      switch (++repairTurns) {
        case 1: return tool("read", { path: "algorithm.js" });
        case 2: return tool("edit", { path: "algorithm.js", edits: [{oldText: bug, newText: "Math.max(Number(quantity), Number(minimum))"}] });
        case 3: return tool("accept_change");
        default: return { text: "Converted the page's string inputs to numbers." };
      }
    }
    if (body.messages.some(message => JSON.stringify(message).includes("CoThink host-provided member material"))) {
      if (!body.tools?.some(tool => tool.function.name === "report_task_conflict"))
        return { text: "Check the order form and its numeric result." };
      claims.push(["employee", body.model]);
      return { text: "The order page passes." };
    }
    switch (++leaderTurns) {
      case 1: return tool("project_staff", { action: "appoint", input: {
        id: "inspector", responsibility: "Inspect the order page", scope: [], readScope: ["index.html"],
        models: ["fixture/main"], need: "deliverable", reason: "Review the order form.",
      } });
      case 2: return tool("delegate", { staffId: "inspector", model: "fixture/main", workId: "main:index.html",
        assignment: "Inspect the order form", reason: "Read the interface independently", readOnly: true,
        scope: [], readScope: ["index.html"],
      });
      case 3: return tool("collect");
      default:
        claims.push(["root", body.model]);
        return { text: "The order page passes." };
    }
  });

  saveConfig(f.home, { formatVersion: 2, ...f.models, work: { execution: { ...execution, image: preview.image } } });
  const plan = {
    goal: "Verify the order form returns the larger quantity.",
    scope: ["index.html", "algorithm.js"], deliverables: ["index.html", "algorithm.js"],
    checks: [{ command: "node", args: ["-e", `(${checkPage})().catch(err => {console.error(err);process.exitCode=1})`] }],
  };
  const file = join(repo.root, "contract.json");
  writeFileSync(file, JSON.stringify(plan));
  const run = async (...args) => {
    const { code, stdout, stderr } = await invoke(f, ["project", ...args, "--json"], "", repo.project);
    assert.ok(stdout, stderr);
    return [code, JSON.parse(stdout)];
  };
  const output = async check => {
    const v = await createVersioning({ home: f.home, project: repo.project, readOnly: true });
    try {
      const { contentBase64 } = await v.read({ outputRef: check.checks[0].outputRef });
      return Buffer.from(contentBase64, "base64").toString();
    } finally {
      await v.close();
    }
  };

  const [failCode, failed] = await run("start", "--file", file);
  assert.equal(failCode, 1);
  assert.equal(failed.status, "blocked");
  assert.equal(failed.delivery, undefined);
  const failCheck = failed.steps[0].attempts[0].check;
  assert.equal(failCheck?.status, "check_failed", JSON.stringify(failed.steps[0].attempts[0]));
  assert.equal(failCheck.version, failed.version);
  const failLog = await output(failCheck);
  assert.match(failLog, /"quantity":"3","expected":"5","actual":"5"/);
  assert.match(failLog, /"quantity":"10","expected":"10","actual":"5"/);
  assert.deepEqual(claims, [["employee", "main"], ["root", "main"]]);

  const jobs = Object.values(failed.staffAssignments);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].model, "fixture/main");
  assert.equal(jobs[0].staffId, "inspector");
  assert.equal(jobs[0].status, "disposed");

  repairing = true;
  const [revisionCode] = await run("revise", "--step", "main", "--goal", "Repair numeric handling; compare 10 and 5 numerically.");
  assert.equal(revisionCode, 0);
  const [successCode, fixed] = await run("resume");
  assert.equal(successCode, 0, JSON.stringify(fixed.steps[0].attempts.at(-1)));
  assert.equal(fixed.status, "completed");
  assert.notEqual(fixed.version, failed.version);
  assert.equal(fixed.delivery.version, fixed.version);
  const passCheck = fixed.steps[0].attempts.at(-1).check;
  assert.equal(passCheck.version, fixed.delivery.version);
  assert.equal(passCheck.status, "passed");
  assert.deepEqual(passCheck.checks[0].args, failCheck.checks[0].args);
  const passLog = await output(passCheck);
  assert.match(passLog, /"quantity":"3","expected":"5","actual":"5"/);
  assert.match(passLog, /"quantity":"10","expected":"10","actual":"10"/);
  t.diagnostic(`Chromium: 3 vs 5 returned 5 on both versions. 10 vs 5 returned 5 at blocked ${failed.version}, then 10 at delivered ${fixed.version}.`);
});
