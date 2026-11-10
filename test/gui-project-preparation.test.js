import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
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

test("does not enter an unreadable subtree excluded by Git", { skip: process.platform === "win32" }, async t => {
  const { path, run } = fixture(t);
  const ignored = join(path, "build-cache");
  mkdirSync(ignored);
  writeFileSync(join(path, ".gitignore"), "/build-cache/\n");
  chmodSync(ignored, 0);
  try {
    const result = await run("preview");
    assert.equal(result.status, "inventory");
    assert.deepEqual(result.files.map(file => file.path), [".gitignore"]);
    assert.deepEqual(result.ignored, [{ path: "build-cache", reason: "gitignore" }]);
  } finally {
    chmodSync(ignored, 0o700);
  }
});

test("confirms an older inventory that listed the contents of a Git-ignored directory", async t => {
  const { home, path, operationId, run } = fixture(t);
  mkdirSync(join(path, "cache"));
  writeFileSync(join(path, ".gitignore"), "/cache/\n");
  writeFileSync(join(path, "cache", "artifact"), "not tracked");
  await run("preview", { selectedPaths: [".gitignore"] });
  const record = join(home, "gui-project-preparation", operationId + ".json");
  const old = JSON.parse(readFileSync(record, "utf8"));
  delete old.inventoryVersion;
  const cache = lstatSync(join(path, "cache"), { bigint: true });
  old.directories.push(["cache", [String(cache.dev), String(cache.ino)]]);
  old.ignored = [{ path: "cache/artifact", reason: "gitignore" }];
  writeFileSync(record, JSON.stringify(old));
  assert.equal((await run("confirm")).status, "ready");
  assert.equal(await textGit(path, ["ls-files"]), ".gitignore");
});

test("protects an OS home and its ancestors even when an old preview exists", t => {
  const { dir, home, operationId } = fixture(t);
  const osHome = realpathSync(home);
  const appData = join(osHome, ".cothink");
  mkdirSync(appData);
  const state = join(appData, "gui-project-preparation");
  mkdirSync(state);
  writeFileSync(join(state, operationId + ".json"), JSON.stringify({
    status: "preview", operationId, path: osHome, root: osHome,
  }));
  const source = new URL("../src/gui-project-preparation.js", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {homedir} from 'node:os';
    import {randomUUID} from 'node:crypto';
    const {prepareGuiProject}=await import(${JSON.stringify(source)});
    const [home, ancestor, id]=process.argv.slice(1);
    const denied={code:'PROJECT_PREPARATION_PROTECTED'};
    assert.equal(homedir(),${JSON.stringify(osHome)});
    const {existsSync,realpathSync}=await import('node:fs');
    const protectedPaths=[homedir(),ancestor];
    for (const path of [...protectedPaths]) {
      const alias=path.toUpperCase();
      if(existsSync(alias)&&realpathSync.native(alias)===realpathSync.native(path))protectedPaths.push(alias);
    }
    for (const path of protectedPaths) {
      await assert.rejects(prepareGuiProject(home,{action:'preview',path,operationId:randomUUID()}),denied);
    }
    for (const action of ['query','confirm','finish']) {
      await assert.rejects(prepareGuiProject(home,{action,operationId:id}),denied);
    }
  `, appData, realpathSync(dir), operationId], { env: { ...process.env, HOME: osHome, USERPROFILE: osHome } });
  assert.equal(existsSync(join(osHome, ".git")), false);
});

test("a damaged preparation record blocks only its own repository", async t => {
  const { dir, home, path, operationId, run } = fixture(t);
  const other = join(dir, "unrelated");
  mkdirSync(other);
  await git(path, ["init", "--template=", "--initial-branch=fixture"]);
  await run("preview", { selectedPaths: [] });
  assert.equal((await run("confirm")).status, "ready");
  const otherId = randomUUID();
  const prepareOther = (action, extra = {}) => prepareGuiProject(home, { action, operationId: otherId, ...extra });
  await prepareOther("preview", { path: other, selectedPaths: [] });
  assert.equal((await prepareOther("confirm")).status, "ready");
  writeFileSync(join(home, "gui-project-preparation", operationId + ".json"), "{");
  assert.ok((await inspectGuiPreparation(other, home)).head);
  await assert.rejects(inspectGuiPreparation(path, home), { code: "PROJECT_PREPARATION_DAMAGED" });
  const alias = path.toUpperCase();
  if (existsSync(alias) && realpathSync.native(alias) === realpathSync.native(path))
    await assert.rejects(inspectGuiPreparation(alias, home), { code: "PROJECT_PREPARATION_DAMAGED" });
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
