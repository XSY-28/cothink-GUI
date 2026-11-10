import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { git } from "../packages/agent-sync/src/git.js";
import { pathName } from "../packages/agent-sync/src/scope.js";

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const issue = (code, message) => Object.assign(new Error(message), { code });
export const changed = () => issue("PROJECT_PREPARATION_CHANGED", "目录、文件或 Git 状态已变化。请重新预览。");
export const identity = stat => [String(stat.dev), String(stat.ino)];
export const nulList = bytes => bytes.toString("utf8").split("\0").filter(Boolean);

export function optionalStat(path) {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}

export function directory(path) {
  const stat = optionalStat(path);
  if (!stat?.isDirectory() || realpathSync(path) !== path) throw changed();
  return identity(stat);
}

export function regular(path, initial = optionalStat(path)) {
  if (!initial?.isFile() || initial.nlink !== 1n || realpathSync(path) !== path) throw changed();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    const key = stat => [...identity(stat), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
    if (!same(key(initial), key(before))) throw changed();
    const bytes = readFileSync(fd);
    if (!same(key(before), key(fstatSync(fd, { bigint: true }))) || realpathSync(path) !== path) throw changed();
    return bytes;
  } finally { closeSync(fd); }
}

export function fileFact(path) {
  const stat = optionalStat(path);
  return stat ? { identity: identity(stat), hash: digest(regular(path, stat)) } : null;
}

const excludedName = /^(?:\.git(?:$|~)|node_modules$|\.venv$|venv$|\.npmrc$|\.pypirc$|\.netrc$|\.aws$|\.ssh$|\.gnupg$|\.env(?:$|\.)|id_(?:rsa|ed25519|ecdsa|dsa)(?:$|\.)|credentials(?:$|\.)|secrets?(?:$|\.)|.*\.(?:pem|key|p12|pfx)$)/i;

async function checkIgnored(root, paths, env) {
  if (!paths.length) return new Set();
  const bytes = await git(root, ["check-ignore", "--no-index", "-z", "--stdin"], paths.join("\0") + "\0", env)
    .catch(error => { if (error.exitCode !== 1) throw error; return error.stdout; });
  return new Set(nulList(bytes));
}

async function candidates(root, home, env) {
  const files = [], ignored = [], directories = [], ignoredDirectories = [];
  const privateData = optionalStat(home);
  let pending = [{ abs: root, path: "" }];
  while (pending.length) {
    const next = [];
    for (const dir of pending) {
      const before = directory(dir.abs);
      directories.push([dir.path || ".", before]);
      for (const name of readdirSync(dir.abs, { encoding: "buffer" })) {
        const decoded = name.toString("utf8");
        if (!dir.path && decoded === ".git") continue;
        const path = dir.path ? dir.path + "/" + decoded : decoded;
        const abs = join(dir.abs, decoded);
        if (!name.equals(Buffer.from(decoded))) { ignored.push({ path, reason: "path" }); continue; }
        if (abs === home || excludedName.test(decoded)) { ignored.push({ path, reason: "protected" }); continue; }
        try { pathName(path); } catch { ignored.push({ path, reason: "path" }); continue; }
        const stat = optionalStat(abs);
        if (!stat) throw changed();
        if (stat.isDirectory() && privateData && stat.dev === privateData.dev && stat.ino === privateData.ino) {
          ignored.push({ path, reason: "protected" });
          continue;
        }
        if (stat.isDirectory()) next.push({ abs, path });
        else if (!stat.isFile() || stat.nlink !== 1n) ignored.push({ path, reason: "non-regular" });
        else files.push({ path, stat });
      }
      if (!same(before, directory(dir.abs))) throw changed();
    }
    // Batch by depth, and ask Git before reading any entries below a directory.
    const ignoredDirs = await checkIgnored(root, next.map(dir => dir.path + "/"), env);
    pending = next.filter(({ abs, path }) => {
      if (ignoredDirs.has(path + "/")) {
        ignoredDirectories.push(path);
        ignored.push({ path, reason: "gitignore" });
        return false;
      }
      if (optionalStat(join(abs, ".git")) || (optionalStat(join(abs, "HEAD")) &&
          optionalStat(join(abs, "objects"))?.isDirectory() && optionalStat(join(abs, "refs"))?.isDirectory())) {
        ignored.push({ path, reason: "nested-repository" });
        return false;
      }
      return true;
    });
  }
  return { files, ignored, ignoredDirectories, directories: directories.sort(([a], [b]) => a.localeCompare(b)) };
}

export async function inventory(home, repo, scratch, originalFacts, selectedPaths = []) {
  const selected = new Set(selectedPaths);
  const env = { GIT_DIR: scratch, GIT_WORK_TREE: repo.root };
  if (originalFacts?.exclude)
    writeFileSync(join(scratch, "info", "exclude"), regular(join(repo.gitDir, "info", "exclude")));
  const { files, ignored, directories, ignoredDirectories } = await candidates(repo.root, home, env);
  const ignoredPaths = await checkIgnored(repo.root, files.map(file => file.path), env);
  const found = [], contents = new Map();
  for (const file of files) {
    if (ignoredPaths.has(file.path)) {
      ignored.push({ path: file.path, reason: "gitignore" });
      continue;
    }
    const bytes = regular(join(repo.root, file.path), file.stat);
    const mode = process.platform === "win32" || !(file.stat.mode & 0o111n) ? "100644" : "100755";
    found.push({ path: file.path, mode, sha256: digest(bytes), size: bytes.length });
    if (selected.has(file.path)) contents.set(file.path, bytes);
  }
  const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return { files: found.sort(byPath), ignored: ignored.sort(byPath), directories, ignoredDirectories, contents };
}
