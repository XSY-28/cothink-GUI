import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { git, textGit } from "../packages/agent-sync/src/git.js";
import { inspectGuiPreparation, prepareGuiProject } from "../src/gui-project-preparation.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ct-preparation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), path = join(dir, "project");
  mkdirSync(home);
  mkdirSync(path);
  const operationId = randomUUID();
  const run = (action, input = {}) => prepareGuiProject(home, {
    action, operationId, ...(action === "preview" ? { path } : {}), ...input,
  });
  return { dir, home, path, operationId, run };
}

test("previews without creating .git and commits exactly the selected bytes", async t => {
  const { path, run } = fixture(t);
  writeFileSync(join(path, "selected.txt"), "first\r\n");
  writeFileSync(join(path, "other.txt"), "keep");
  writeFileSync(join(path, ".env"), "secret");
  writeFileSync(join(path, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(path, "ignored.txt"), "ignored");
  symlinkSync("other.txt", join(path, "alias.txt"));
  const inventory = await run("preview");
  assert.equal(inventory.status, "inventory");
  assert.deepEqual(inventory.files.map(x => x.path), [".gitignore", "other.txt", "selected.txt"]);
  assert.deepEqual(inventory.ignored.map(x => x.path), [".env", "alias.txt", "ignored.txt"]);
  const preview = await run("preview", { selectedPaths: ["selected.txt"] });
  assert.equal(preview.status, "preview");
  assert.equal(existsSync(join(path, ".git")), false);
  assert.equal((await run("confirm")).status, "ready");
  assert.equal(await textGit(path, ["rev-parse", "HEAD"]), preview.expectedCommit);
  assert.equal(await textGit(path, ["rev-parse", "HEAD^{tree}"]), preview.expectedTree);
  assert.equal(await textGit(path, ["ls-files"]), "selected.txt");
  assert.deepEqual(await git(path, ["show", "HEAD:selected.txt"]), Buffer.from("first\r\n"));
  assert.equal(readFileSync(join(path, ".env"), "utf8"), "secret");
  assert.equal((await run("query")).status, "ready");
  assert.equal((await run("confirm")).commit, preview.expectedCommit);
});

test("changing confirmed bytes requires a new preview and preserves files", async t => {
  const { path, run } = fixture(t);
  const file = join(path, "work.txt");
  writeFileSync(file, "before");
  await run("preview", { selectedPaths: ["work.txt"] });
  writeFileSync(file, "after");
  await assert.rejects(run("confirm"), { code: "PROJECT_PREPARATION_CHANGED" });
  assert.equal(existsSync(join(path, ".git")), false);
  assert.equal(readFileSync(file, "utf8"), "after");
});

test("preserves staged unborn files and restricts a selection inside a parent repo", async t => {
  const { path, run } = fixture(t);
  const child = join(path, "child");
  mkdirSync(child);
  writeFileSync(join(child, "inside.txt"), "inside");
  writeFileSync(join(path, "outside.txt"), "outside");
  await git(path, ["init", "--template=", "--initial-branch=fixture"]);
  await git(path, ["add", "--", "outside.txt"]);
  const before = readFileSync(join(path, ".git", "index"));
  const blocked = await run("preview", { selectedPaths: ["child/inside.txt"] });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.staged, ["outside.txt"]);
  const parent = await run("preview", { path: child, selectedPaths: [] });
  assert.equal(parent.status, "blocked");
  assert.equal(parent.relativePath, "child");
  assert.equal(existsSync(join(child, ".git")), false);
  assert.deepEqual(readFileSync(join(path, ".git", "index")), before);
});

test("creates a normal empty index and a single root commit", async t => {
  const { path, run } = fixture(t);
  const preview = await run("preview", { selectedPaths: [] });
  assert.equal((await run("confirm")).status, "ready");
  assert.equal(await textGit(path, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(await textGit(path, ["rev-parse", "HEAD"]), preview.expectedCommit);
  assert.equal(await textGit(path, ["status", "--porcelain"]), "");
  assert.equal(existsSync(join(path, ".git", "index")), true);
});

test("preserves an empty unborn index branch and config and suppresses hooks and filters", async t => {
  const { dir, path, run } = fixture(t);
  const sentinel = join(dir, "ran"), hookDir = join(dir, "hooks");
  mkdirSync(hookDir);
  writeFileSync(join(hookDir, "reference-transaction"), '#!/bin/sh\ntouch "' + sentinel + '"\n', { mode: 0o755 });
  await git(path, ["init", "--template=", "--initial-branch=feature/local"]);
  await git(path, ["read-tree", "--empty"]);
  await git(path, ["config", "--local", "core.hooksPath", hookDir]);
  await git(path, ["config", "--local", "filter.sideeffect.clean", 'touch "' + sentinel + '"; cat']);
  writeFileSync(join(path, ".gitattributes"), "*.txt filter=sideeffect\n");
  writeFileSync(join(path, "work.txt"), "keep\n");
  const config = readFileSync(join(path, ".git", "config"));
  await run("preview", { selectedPaths: ["work.txt", ".gitattributes"] });
  assert.equal((await run("confirm")).status, "ready");
  assert.equal(existsSync(sentinel), false);
  assert.equal(await textGit(path, ["symbolic-ref", "HEAD"]), "refs/heads/feature/local");
  assert.deepEqual(readFileSync(join(path, ".git", "config")), config);
  assert.equal(await textGit(path, ["ls-files"]), ".gitattributes\nwork.txt");
});

test("stops before publishing when an unborn repository's configuration changes", async t => {
  const { path, run } = fixture(t);
  await git(path, ["init", "--template=", "--initial-branch=fixture"]);
  const preview = await run("preview", { selectedPaths: [] });
  await git(path, ["config", "--local", "core.filemode", "false"]);
  await assert.rejects(run("confirm"), { code: "PROJECT_PREPARATION_CHANGED" });
  assert.equal((await run("query")).expectedCommit, preview.expectedCommit);
  assert.equal((await inspectGuiPreparation(path)).head, null);
});

test("reports scoped dirty files without changing an existing parent repository", async t => {
  const { path, run } = fixture(t);
  const child = join(path, "child");
  mkdirSync(child);
  writeFileSync(join(child, "inside.txt"), "original");
  writeFileSync(join(path, "outside.txt"), "outside");
  await git(path, ["init", "--template=", "--initial-branch=fixture"]);
  await git(path, ["add", "--", "outside.txt", "child/inside.txt"]);
  await git(path, ["commit", "-m", "fixture"]);
  const head = await textGit(path, ["rev-parse", "HEAD"]);
  writeFileSync(join(child, "inside.txt"), "modified");
  writeFileSync(join(path, "outside.txt"), "modified");
  const index = readFileSync(join(path, ".git", "index"));
  const result = await run("preview", { path: child, selectedPaths: [] });
  assert.equal(result.status, "ready");
  assert.equal(result.relativePath, "child");
  assert.deepEqual(result.changes.modified, ["child/inside.txt"]);
  assert.equal(await textGit(path, ["rev-parse", "HEAD"]), head);
  assert.deepEqual(readFileSync(join(path, ".git", "index")), index);
});

test("recovers a process interrupted after ref publication using the original operation", { skip: process.platform === "win32" }, async t => {
  const { dir, home, path, operationId, run } = fixture(t);
  writeFileSync(join(path, "file.txt"), "selected\n");
  const preview = await run("preview", { selectedPaths: ["file.txt"] });
  const binaryDir = join(dir, "bin");
  mkdirSync(binaryDir);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(binaryDir, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = update-ref ]; then
    "$CT_TEST_GIT" "$@" || exit $?
    kill -KILL "$PPID"
    exit 0
  fi
done
exec "$CT_TEST_GIT" "$@"
`, { mode: 0o755 });
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { prepareGuiProject } from ${JSON.stringify(new URL("../src/gui-project-preparation.js", import.meta.url).href)};
    await prepareGuiProject(process.argv[1], { action: "confirm", operationId: process.argv[2] });
  `, home, operationId], {
    env: { ...process.env, PATH: binaryDir + delimiter + process.env.PATH, CT_TEST_GIT: realGit },
    timeout: 15000,
  });
  assert.equal(child.signal, "SIGKILL", String(child.stderr));
  assert.equal(await textGit(path, ["rev-parse", "HEAD"]), preview.expectedCommit);
  assert.equal(existsSync(join(path, ".git", "index")), false);
  assert.equal((await run("query")).status, "partial");
  assert.equal((await inspectGuiPreparation(path, home)).preparation.operationId, operationId);
  assert.equal((await run("confirm")).status, "partial");
  const result = await run("finish");
  assert.equal(result.status, "ready");
  assert.equal(result.commit, preview.expectedCommit);
  assert.equal(await textGit(path, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(await textGit(path, ["status", "--porcelain"]), "");
});

test("reports historical completion separately when a prepared directory disappears", async t => {
  const { path, run } = fixture(t);
  const preview = await run("preview", { selectedPaths: [] });
  assert.equal((await run("confirm")).status, "ready");
  rmSync(path, { recursive: true });
  for (const action of ["query", "confirm"]) {
    const result = await run(action);
    assert.equal(result.status, "blocked");
    assert.equal(result.completedCommit, preview.expectedCommit);
    assert.equal(result.commit, undefined);
  }
  assert.equal(existsSync(path), false);
});
