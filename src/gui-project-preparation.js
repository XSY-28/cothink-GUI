import { createHash, randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync,
  writeFileSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git, writeTree } from "../packages/agent-sync/src/git.js";
import { aliases } from "../packages/agent-sync/src/scope.js";
import { acquireSessionWriter, privateDirectory, writePrivateJson } from "./storage.js";
import { isWorkspaceId } from "./gui-workspace-state.js";
import { changed, digest, directory, fileFact, identity, inventory, issue, nulList, optionalStat, regular, same } from "./gui-project-preparation-files.js";

const branch = "refs/heads/main";
const name = "CoThink";
const email = "cothink@localhost";
const message = "Prepare CoThink project\n";
const stateDir = home => join(home, "gui-project-preparation");
const scopeFile = (dir, root) => join(dir, digest(canonical(root)) + ".scope");
const text = async (path, args, env, input) => (await git(path, args, input, env)).toString("utf8").replace(/\r?\n$/, "");
const damaged = () => issue("PROJECT_PREPARATION_DAMAGED", "此目录的准备记录已损坏，请先核对或恢复记录。");

function resolvedPath(path) {
  try { return realpathSync.native(path); } catch { return realpathSync(path); }
}

function canonical(path) {
  try { return resolvedPath(path); } catch { return resolve(path); }
}

function within(parent, path) {
  const rel = relative(parent, path);
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))) return true;
  // On case-insensitive volumes, the same directory can have multiple spellings.
  try {
    const parentId = directory(parent);
    for (let current = path; ; current = dirname(current)) {
      if (same(parentId, directory(current))) return true;
      if (current === dirname(current)) break;
    }
  } catch { /* A missing path has no filesystem identity to compare. */ }
  return false;
}

let systemUserHome;
try { systemUserHome = userInfo().homedir; } catch { /* Keep the runtime home check. */ }

export function protectedGuiProjectPath(path, home) {
  if (!path) return false;
  const target = canonical(path);
  const appData = home ? canonical(home) : null;
  return within(target, canonical(homedir())) ||
    Boolean(systemUserHome && within(target, canonical(systemUserHome))) ||
    Boolean(appData && within(appData, target));
}

function assertAllowed(path, home) {
  if (protectedGuiProjectPath(path, home))
    throw issue("PROJECT_PREPARATION_PROTECTED", "用户主目录、其上级目录及 CoThink 私有数据范围不可准备为项目。请选择专用文件夹。");
}

function readOperation(path) {
  const stat = optionalStat(path);
  return stat ? JSON.parse(regular(path, stat).toString("utf8")) : null;
}

function readJournal(dir, id) {
  try {
    const op = readOperation(join(dir, id + ".json"));
    if (op !== null && (op.operationId !== id || typeof op.root !== "string" ||
        typeof op.path !== "string" || !["preview", "executing", "ready"].includes(op.status))) throw damaged();
    return op;
  } catch { throw damaged(); }
}

async function gitOptional(path, args, env, exitCode) {
  try { return await text(path, args, env); }
  catch (error) { if (error.exitCode !== exitCode) throw error; return null; }
}

export async function inspectGuiPreparation(input, home, { includePending = true } = {}) {
  if (typeof input !== "string" || !input.trim() || input.includes("\0"))
    throw issue("INVALID_PROJECT_PATH", "请输入项目目录。");
  const path = resolvedPath(resolve(input));
  assertAllowed(path, home);
  const pathIdentity = directory(path);
  const inspected = repo => includePending ? attachPending(home, repo) : repo;
  let marker = path;
  while (!optionalStat(join(marker, ".git"))) {
    const parent = dirname(marker);
    if (parent === marker) {
      // A bare repository or a metadata subdirectory is not an ordinary directory.
      if (await gitOptional(path, ["rev-parse", "--git-dir"], {}, 128) !== null)
        throw issue("INVALID_PROJECT_PATH", "请选择普通目录或 Git 工作目录。");
      return inspected({ path, pathIdentity, root: path, relativePath: ".", kind: "ordinary", head: null });
    }
    marker = parent;
  }
  assertAllowed(marker, home);

  let root;
  try { root = resolvedPath(await text(path, ["rev-parse", "--show-toplevel"])); }
  catch(error) {
    // A crash after exclusive creation can leave .git too incomplete for
    // Git discovery. Preserve the same operation in the directory UI.
    const pending = await inspected({path,pathIdentity,root:marker,
      relativePath:relative(marker,path).split(sep).join("/")||".",kind:"unborn",head:null});
    if (pending.preparation) return pending;
    throw error;
  }
  const rel = relative(root, path);
  if (root !== marker || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw changed();
  const gitDir = resolvedPath(await text(root, ["rev-parse", "--absolute-git-dir"]));
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_NO_LAZY_FETCH: "1" };
  const head = await gitOptional(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], env, 1);
  return inspected({
    path, pathIdentity, root, relativePath: rel.split(sep).join("/") || ".",
    kind: head ? "repository" : "unborn", head, gitDir,
    objectFormat: await text(root, ["rev-parse", "--show-object-format"], env),
    ref: await gitOptional(root, ["symbolic-ref", "--quiet", "HEAD"], env, 1),
  });
}

async function attachPending(home, repo) {
  if (!home) return repo;
  const dir = stateDir(resolvedPath(home));
  if (!optionalStat(dir)) return repo;
  directory(dir);
  const conventionalGit = join(repo.root, ".git");
  const gitDir = repo.gitDir ?? (optionalStat(conventionalGit)?.isDirectory() ? conventionalGit : null);
  const scoped = scopeFile(dir, repo.root);
  let pin, owner;
  try {
    if (optionalStat(scoped)) {
      pin = readOperation(scoped)?.operationId;
      if (!isWorkspaceId(pin)) throw damaged();
    } else if (gitDir && optionalStat(join(gitDir, "cothink-preparation"))) {
      owner = regular(join(gitDir, "cothink-preparation")).toString("utf8");
      if (!isWorkspaceId(owner)) throw damaged();
    }
  } catch { throw damaged(); }
  const sameRoot = path => path === repo.root || Boolean(path && canonical(path) === repo.root);
  if (pin && !sameRoot(readJournal(dir, pin)?.root)) throw damaged();

  // Legacy journals did not record a separate scope. If Git still holds an
  // index lock and no journal can identify it, do not declare that repo ready.
  let unknownLegacy = false;
  for (const filename of readdirSync(dir)) {
    const id = filename.slice(0, -5);
    if (!filename.endsWith(".json") || !isWorkspaceId(id)) continue;
    let op;
    try { op = readJournal(dir, id); }
    catch (error) {
      if (id === pin || id === owner) throw error;
      unknownLegacy = true;
      continue;
    }
    if (op?.status !== "executing" || !sameRoot(op.root)) continue;
    const result = await verifiedResult(home, op);
    if (result.status !== "ready") return { ...repo, preparation: result };
  }
  if (!pin && unknownLegacy && gitDir && optionalStat(join(gitDir, "index.lock"))) throw damaged();
  return repo;
}

function hasLegacyRecord(home, gitDir) {
  return optionalStat(join(home, "projects", digest(gitDir).slice(0, 24), "project.json"));
}

const repoEnv = repo => ({ GIT_DIR: repo.gitDir, GIT_WORK_TREE: repo.root, GIT_LITERAL_PATHSPECS: "1", GIT_NO_LAZY_FETCH: "1" });
const indexPath = repo => join(repo.gitDir, "index");

async function unbornFacts(home, repo) {
  const gitDir = join(repo.root, ".git");
  if (repo.gitDir !== gitDir || repo.relativePath !== "." || !repo.ref?.startsWith("refs/heads/"))
    throw issue("PROJECT_PREPARATION_UNSUPPORTED", "请选择独立仓库的根目录，或先自行完成首次提交。");
  if (hasLegacyRecord(home, gitDir))
    throw issue("MIGRATION_REQUIRED", "目录存在旧项目记录。请先明确迁移。");

  // Includes and alternates move the state outside the frozen metadata. Keep
  // those layouts on the normal Git path with a user-created first commit.
  await text(repo.root, ["check-ref-format", repo.ref], repoEnv(repo));
  const refStat=optionalStat(join(gitDir, repo.ref));
  if (refStat?.isSymbolicLink() || refStat && !repo.head) throw changed();
  const config = fileFact(join(gitDir, "config"));
  const configKeys = await text(repo.root, ["config", "--file", join(gitDir, "config"), "--no-includes", "--name-only", "--list"], repoEnv(repo));
  if (/(?:^|\n)(?:include\.|includeif\.|core\.worktree$|extensions\.(?:worktreeconfig|refstorage)$)/im.test(configKeys) ||
      optionalStat(join(gitDir, "commondir")) ||
      optionalStat(join(gitDir, "objects", "info", "alternates")) ||
      optionalStat(join(gitDir, "objects", "info", "http-alternates")))
    throw issue("PROJECT_PREPARATION_UNSUPPORTED", "仓库的 Git 配置引用了其他位置。请先自行完成首次提交。");
  if (!same(config, fileFact(join(gitDir, "config")))) throw changed();
  const dirs = [gitDir, join(gitDir, "objects"), join(gitDir, "refs"), join(gitDir, "refs", "heads")];
  for (let parent = dirname(join(gitDir, repo.ref)); parent !== gitDir; parent = dirname(parent))
    if (optionalStat(parent)) directory(parent);
  const directories = [...new Set(dirs)].map(path => {
    const stat = optionalStat(path);
    return stat ? directory(path) : null;
  });
  const logs = join(gitDir, "logs");
  for (const leaf of [join(logs, "HEAD"), join(logs, repo.ref)]) {
    if (optionalStat(leaf)) fileFact(leaf);
    for (let parent = dirname(leaf); parent !== gitDir; parent = dirname(parent))
      if (optionalStat(parent)) directory(parent);
  }
  const head = fileFact(join(gitDir, "HEAD"));
  if (regular(join(gitDir, "HEAD")).toString("utf8").trim() !== "ref: " + repo.ref) throw changed();
  return {
    directories, config, head, index: fileFact(indexPath(repo)),
    exclude: fileFact(join(gitDir, "info", "exclude")),
    packedRefs: fileFact(join(gitDir, "packed-refs")),
  };
}

async function withScratch(home, format, fn) {
  const scratch = mkdtempSync(join(stateDir(home), "scratch-"));
  try {
    await git(scratch, ["init", "--bare", "--template=", "--initial-branch=main", "--object-format=" + format]);
    return await fn(scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

async function freeze(scratch, contents, files, metadata) {
  const entries = new Map();
  for (const file of files) {
    const oid = await text(scratch, ["hash-object", "--no-filters", "-w", "--stdin"], {}, contents.get(file.path));
    entries.set(file.path, { mode: file.mode, oid });
  }
  const tree = await writeTree(scratch, entries);
  const env = {
    GIT_AUTHOR_NAME: metadata.author.name, GIT_AUTHOR_EMAIL: metadata.author.email,
    GIT_COMMITTER_NAME: metadata.committer.name, GIT_COMMITTER_EMAIL: metadata.committer.email,
    GIT_AUTHOR_DATE: metadata.date, GIT_COMMITTER_DATE: metadata.date,
  };
  const commit = await text(scratch, ["commit-tree", tree, "-F", "-"], env, metadata.message);
  return { tree, commit };
}

function publicResult(op, status = op.status, error = op.error) {
  const { operationId, path, root, relativePath, files, ignored, staged, selectedPaths, metadata, expectedTree, expectedCommit, changes, head } = op;
  return { operationId, path, root, relativePath, files, ignored, staged, selectedPaths,
    metadata, expectedTree, expectedCommit, changes, head, status,
    ...(status === "ready" && { commit: expectedCommit ?? head }),
    ...(op.status === "ready" && status !== "ready" && { completedCommit: expectedCommit }),
    ...(error && { error }) };
}

async function stagedPaths(repo) {
  return [...new Set(nulList(await git(repo.root, ["ls-files", "--stage", "-z"], undefined, repoEnv(repo)))
    .map(entry => entry.slice(entry.indexOf("\t") + 1)))];
}

export async function inspectGuiGitChanges(repo) {
  const env = repoEnv(repo), scope = repo.relativePath;
  const staged = nulList(await git(repo.root,
    ["diff-index", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv", repo.head, "--", scope], undefined, env));
  const untracked = nulList(await git(repo.root,
    ["ls-files", "--others", "--exclude-standard", "-z", "--", scope], undefined, env));
  const entries = nulList(await git(repo.root, ["ls-files", "--stage", "-z", "--", scope], undefined, env));
  const modified = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t"), path = entry.slice(tab + 1);
    const [mode, oid, stage] = entry.slice(0, tab).split(" ");
    const abs = join(repo.root, path), stat = optionalStat(abs);
    if (stage !== "0" || !stat || !stat.isFile() || stat.nlink !== 1n || realpathSync(abs) !== abs ||
      !["100644", "100755"].includes(mode)) {
      modified.push(path);
      continue;
    }
    const bytes = regular(abs, stat);
    const actual = createHash(repo.objectFormat).update("blob " + bytes.length + "\0").update(bytes).digest("hex");
    if (oid !== actual || (process.platform !== "win32" && (mode === "100755") !== Boolean(stat.mode & 0o111n)))
      modified.push(path);
  }
  return { staged, untracked, modified };
}

async function preview(home, input, save) {
  const repo = await inspectGuiPreparation(input.path, home);
  if (repo.preparation) return repo.preparation;
  const base = { ...repo, operationId: input.operationId, files: [], ignored: [], staged: [] };
  if (repo.head) return publicResult({ ...base, changes: await inspectGuiGitChanges(repo) }, "ready");
  if (repo.relativePath !== ".") return publicResult(base, "blocked", "所选目录位于尚无首次提交的父仓库中。请先在父仓库准备。");
  if (repo.kind === "ordinary" && hasLegacyRecord(home, join(repo.root, ".git")))
    throw issue("MIGRATION_REQUIRED", "目录存在旧项目记录。请先明确迁移。");
  const originalFacts = repo.kind === "unborn" ? await unbornFacts(home, repo) : null;
  if (originalFacts) {
    base.staged = await stagedPaths(repo);
    if (base.staged.length) return publicResult(base, "blocked", "请先自行处理已有暂存项。");
  }
  if (input.selectedPaths !== undefined && (!Array.isArray(input.selectedPaths) ||
      !input.selectedPaths.every(path => typeof path === "string") ||
      new Set(input.selectedPaths).size !== input.selectedPaths.length))
    throw issue("INVALID_PROJECT_SELECTION", "请选择当前预览中的普通文件。");
  const objectFormat = repo.objectFormat ?? "sha1";
  return withScratch(home, objectFormat, async scratch => {
    const { files, ignored, directories, contents } = await inventory(home, repo, scratch, originalFacts, input.selectedPaths);
    const op = { ...base, files, ignored, directories, inventoryVersion: 2, objectFormat, originalFacts };
    if (input.selectedPaths === undefined) return publicResult(op, "inventory");
    if (!input.selectedPaths.every(path => contents.has(path)))
      throw issue("INVALID_PROJECT_SELECTION", "请选择当前预览中的普通文件。");
    const selectedPaths = [...input.selectedPaths].sort();
    aliases(selectedPaths);
    const selected = files.filter(file => selectedPaths.includes(file.path));
    const metadata = {
      author: { name, email }, committer: { name, email },
      date: new Date().toISOString(), message, ref: repo.ref ?? branch,
      createsGitDirectory: repo.kind === "ordinary", createsIndex: true,
    };
    const { tree, commit } = await freeze(scratch, contents, selected, metadata);
    const frozen = { ...op, status: "preview", selectedPaths, metadata, expectedTree: tree, expectedCommit: commit };
    save(frozen);
    return publicResult(frozen);
  });
}

function currentRepo(home, op) {
  return inspectGuiPreparation(op.path, home, { includePending: false }).then(repo => {
    if (!same(repo.pathIdentity, op.pathIdentity) || repo.root !== canonical(op.root)) throw changed();
    return repo;
  });
}

function assertUnchangedMetadata(actual, original, ignoreIndex = false) {
  if (ignoreIndex) {
    const { index: _actualIndex, ...actualMetadata } = actual;
    const { index: _originalIndex, ...originalMetadata } = original;
    if (!same(actualMetadata, originalMetadata)) throw changed();
  } else if (!same(actual, original)) throw changed();
}

async function assertUnchangedInventory(home, op, scratch, facts, selectedPaths) {
  const current = await inventory(home, op, scratch, facts, selectedPaths);
  // Older journals listed every ignored descendant. Compare the still-relevant
  // entries while keeping all file identities and bytes outside ignored trees.
  const ignoredDir = path => op.inventoryVersion !== 2 &&
    current.ignoredDirectories.some(dir => path === dir || path.startsWith(dir + "/"));
  const visibleIgnored = files => files.filter(file => !ignoredDir(file.path));
  const visibleDirectories = dirs => dirs.filter(([path]) => !ignoredDir(path));
  if (!same(current.files, op.files) || !same(visibleIgnored(current.ignored), visibleIgnored(op.ignored)) ||
      !same(visibleDirectories(current.directories), visibleDirectories(op.directories))) throw changed();
  return current.contents;
}

function ownerPath(repo) { return join(repo.gitDir, "cothink-preparation"); }

function verifyOwner(op, repo) {
  if (op.kind === "ordinary" && regular(ownerPath(repo)).toString("utf8") !== op.operationId)
    throw changed();
}

async function copyObjects(scratch, gitDir) {
  const source = join(scratch, "objects"), target = join(gitDir, "objects");
  directory(target);
  for (const prefix of readdirSync(source).filter(entry => /^[0-9a-f]{2}$/.test(entry))) {
    const dir = join(target, prefix);
    try { mkdirSync(dir); } catch (error) { if (error.code !== "EEXIST") throw error; }
    directory(dir);
    for (const name of readdirSync(join(source, prefix))) {
      const bytes = regular(join(source, prefix, name));
      const dest = join(dir, name);
      const temporary = join(dir, "tmp_ct_" + randomUUID());
      try {
        const fd = openSync(temporary, "wx", 0o444);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        try { linkSync(temporary, dest); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          // A pre-existing object can use another compression level.
          regular(dest);
          const oid = prefix + name;
          const type = await text(scratch, ["cat-file", "-t", oid]);
          const expected = await git(scratch, ["cat-file", type, oid]);
          const actual = await git(gitDir, ["cat-file", type, oid], undefined, { GIT_DIR: gitDir });
          if (!actual.equals(expected)) throw changed();
        }
      } finally {
        if (optionalStat(temporary)) unlinkSync(temporary);
      }
    }
  }
}

async function buildIndex(root, scratch, env, tree) {
  const path = join(scratch, "prepared-index");
  await git(root, ["-c", "index.version=2", "read-tree", tree], undefined, {
    ...env, GIT_INDEX_FILE: path,
  });
  return regular(path);
}

function writeIndex(repo, op, bytes) {
  const path = indexPath(repo) + ".lock";
  if (!same(fileFact(indexPath(repo)), op.publishFacts.index) || digest(bytes) !== op.indexHash)
    throw changed();
  const lock = fileFact(path);
  if (!lock || !same(lock.identity, op.indexLock)) throw changed();
  const fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(identity(fstatSync(fd, { bigint: true })), op.indexLock)) throw changed();
    // The owned lock starts empty. An interruption may leave a written prefix,
    // which can be resumed only if it still matches the same index.
    const old = regular(path);
    if (old.length > bytes.length || !bytes.subarray(0, old.length).equals(old)) throw changed();
    let offset = old.length;
    while (offset < bytes.length)
      offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (!same(fileFact(indexPath(repo)), op.publishFacts.index) ||
      !same(fileFact(path), { identity: op.indexLock, hash: op.indexHash })) throw changed();
  renameSync(path, indexPath(repo));
}

async function verifiedResult(home, op) {
  assertAllowed(op.path, home);
  assertAllowed(op.root, home);
  if (!["executing", "ready"].includes(op.status)) return publicResult(op);
  try {
    const repo = await currentRepo(home, op);
    if (repo.head !== op.expectedCommit || repo.ref !== op.metadata.ref || !op.publishFacts) throw changed();
    verifyOwner(op, repo);
    const facts = await unbornFacts(home, repo);
    assertUnchangedMetadata(facts, op.publishFacts, true);
    const actualTree = await text(repo.root, ["rev-parse", "HEAD^{tree}"], repoEnv(repo));
    if (actualTree !== op.expectedTree) throw changed();
    const lock = fileFact(indexPath(repo) + ".lock");
    if (!lock && facts.index?.hash === op.indexHash) return publicResult(op, "ready");
    if (op.status === "ready") throw changed();
    if (!same(facts.index, op.publishFacts.index) || !same(lock?.identity, op.indexLock)) throw changed();
    return publicResult(op, "partial", "首次提交已发布，索引尚未完成。可以完成同一次准备。");
  } catch (error) {
    if (op.status === "ready")
      return publicResult(op, "blocked", "首次准备曾成功。当前目录的 Git 状态已变化，请重新检查目录。");
    return publicResult(op, "unknown", error.message);
  }
}

async function confirm(home, op, save, assertOwned) {
  if (op.status !== "preview") return verifiedResult(home, op);
  const initialRepo = await currentRepo(home, op);
  if (initialRepo.kind !== op.kind || initialRepo.head || initialRepo.ref !== op.ref)
    throw changed();
  const facts = initialRepo.kind === "unborn" ? await unbornFacts(home, initialRepo) : null;
  assertUnchangedMetadata(facts, op.originalFacts);
  return withScratch(home, op.objectFormat, async scratch => {
    const contents = await assertUnchangedInventory(home, op, scratch, facts, op.selectedPaths);
    const result = await freeze(scratch, contents, op.files.filter(file => op.selectedPaths.includes(file.path)), op.metadata);
    if (result.tree !== op.expectedTree || result.commit !== op.expectedCommit) throw changed();
    const indexBytes = await buildIndex(scratch, scratch, {}, op.expectedTree);
    let repo = await currentRepo(home, op);
    if (repo.kind !== op.kind || repo.head || repo.ref !== op.ref) throw changed();
    if (facts) {
      assertUnchangedMetadata(await unbornFacts(home, repo), facts);
      if (optionalStat(indexPath(repo) + ".lock")) throw changed();
    } else if (hasLegacyRecord(home, join(op.root, ".git"))) {
      throw issue("MIGRATION_REQUIRED", "目录存在旧项目记录。请先明确迁移。");
    }
    op = { ...op, status: "executing" };
    save(op);
    try {
      if (repo.kind === "ordinary") {
        const gitDir = join(repo.root, ".git");
        assertOwned();
        mkdirSync(gitDir);
        writeFileSync(join(gitDir, "cothink-preparation"), op.operationId, { flag: "wx", mode: 0o600 });
        await git(repo.root, ["init", "--template=", "--initial-branch=main", "--object-format=" + op.objectFormat],
          undefined, { GIT_DIR: gitDir, GIT_WORK_TREE: repo.root });
        repo = await currentRepo(home, op);
        verifyOwner(op, repo);
      }
      if (repo.head || repo.ref !== op.metadata.ref) throw changed();
      const lockPath = indexPath(repo) + ".lock";
      const lockFd = openSync(lockPath, "wx", 0o600);
      const indexLock = identity(fstatSync(lockFd, { bigint: true }));
      closeSync(lockFd);
      let publishAttempted = false;
      try {
        const publishFacts = await unbornFacts(home, repo);
        if (facts) assertUnchangedMetadata(publishFacts, facts);
        await copyObjects(scratch, repo.gitDir);
        op = { ...op, publishFacts, indexLock, indexHash: digest(indexBytes) };
        save(op);
        await assertUnchangedInventory(home, op, scratch, publishFacts);
        const before = await currentRepo(home, op);
        if (before.ref !== repo.ref || before.head) throw changed();
        assertUnchangedMetadata(await unbornFacts(home, before), publishFacts);
        verifyOwner(op, before);
        assertOwned();
        publishAttempted = true;
        await git(repo.root, ["update-ref", "--no-deref", repo.ref, op.expectedCommit, "0".repeat(op.expectedCommit.length)],
          undefined, repoEnv(repo));
        await assertUnchangedInventory(home, op, scratch, publishFacts);
        if ((await verifiedResult(home, op)).status !== "partial") throw changed();
        assertOwned();
        writeIndex(repo, op, indexBytes);
      } finally {
        if (!publishAttempted && same(fileFact(lockPath)?.identity, indexLock)) unlinkSync(lockPath);
      }
      const result = await verifiedResult(home, op);
      if (result.status === "ready") save({ ...op, status: "ready" });
      return result;
    } catch (error) {
      const result = await verifiedResult(home, op);
      return result.status === "unknown" ? publicResult(op, "unknown", error.message) : result;
    }
  });
}

async function finish(home, op, save, assertOwned) {
  const outcome = await verifiedResult(home, op);
  if (op.status !== "executing") return outcome;
  if (outcome.status === "ready") {
    save({ ...op, status: "ready" });
    return outcome;
  }
  if (outcome.status !== "partial") return outcome;
  const repo = await currentRepo(home, op);
  return withScratch(home, op.objectFormat, async scratch => {
    await assertUnchangedInventory(home, op, scratch, op.publishFacts);
    const bytes = await buildIndex(scratch, scratch, { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo.gitDir, "objects") }, op.expectedTree);
    if ((await verifiedResult(home, op)).status !== "partial") throw changed();
    assertOwned();
    writeIndex(repo, op, bytes);
    const result = await verifiedResult(home, op);
    if (result.status === "ready") save({ ...op, status: "ready" });
    return result;
  });
}

export async function prepareGuiProject(home, input) {
  if (!isWorkspaceId(input?.operationId) || !["preview", "confirm", "query", "finish"].includes(input?.action))
    throw issue("INVALID_PROJECT_PREPARATION", "目录准备操作无效。");
  home = resolvedPath(home);
  const dir = stateDir(home);
  const record = join(dir, input.operationId + ".json");
  if (input.action === "query") {
    const op = readJournal(dir, input.operationId);
    return op ? verifiedResult(home, op) : { status: "missing", operationId: input.operationId };
  }
  if (optionalStat(dir)) directory(dir);
  privateDirectory(dir);
  directory(dir);
  const writer = acquireSessionWriter(join(home, "gui"), "00000000-0000-4000-8000-000000000002");
  try {
    // The same writer owns every scratch directory. A prior crashed process
    // may have left object bytes here; recovery uses only the journal and Git.
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory() && /^scratch-[A-Za-z0-9]{6}$/.test(entry.name))
        rmSync(join(dir, entry.name), { recursive: true, force: true });
    const op = readJournal(dir, input.operationId);
    const save = value => {
      if (value.status === "executing" && !value.publishFacts)
        writePrivateJson(scopeFile(dir, value.root), { operationId: value.operationId }, writer.assertOwned);
      writePrivateJson(record, value, writer.assertOwned);
    };
    if (input.action === "preview") {
      if (!op) return await preview(home, input, save);
      if (resolvedPath(resolve(input.path)) !== canonical(op.path) ||
          (input.selectedPaths !== undefined && (!Array.isArray(input.selectedPaths) ||
            !same([...input.selectedPaths].sort(), op.selectedPaths))))
        throw issue("PROJECT_PREPARATION_CONFLICT", "操作已绑定其他目录或文件清单。请使用新的操作编号。");
      return await verifiedResult(home, op);
    }
    if (!op) throw issue("PROJECT_PREPARATION_MISSING", "找不到已冻结的目录预览。");
    if (input.action === "finish") return await finish(home, op, save, writer.assertOwned);
    return await confirm(home, op, save, writer.assertOwned);
  } finally { writer.release(); }
}
