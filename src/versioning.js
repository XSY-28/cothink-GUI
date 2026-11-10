import { join, resolve } from "node:path";
import { createAgentSync } from "../packages/agent-sync/src/index.js";
import { gitTreeRecords } from "../packages/agent-sync/src/git.js";
import { legacyGit, legacyProjectInfo, createGitVersioning } from "./git-versioning.js";
import { problem } from "./task.js";
/** One production writer; only legacy records retain a separate read-only interpretation. */
export async function createVersioning({
  home,
  toolHome,
  backend,
  readOnly = false,
  ...options
}) {
  const legacy = await legacyProjectInfo({ project: options.project, home });
  if (readOnly && backend !== "agent-sync" && !toolHome && legacy)
    return createGitVersioning({ ...options, home, readOnly: true });
  if (!readOnly && legacy && legacy.meta.ownerId !== "agent-sync:v1")
    throw problem(
      "MIGRATION_REQUIRED",
      "此项目仍由旧Git格式管理；请先明确迁移，旧记录与原目录保持不变。",
    );
  if (
    !readOnly &&
    legacy?.meta.ownerId === "agent-sync:v1" &&
    legacy.meta.migration?.status !== "ready"
  )
    throw problem(
      "MIGRATION_INCOMPLETE",
      "旧写入口已停用但迁移尚未完成；请显式重新运行migrate-work核对登记，普通工作/查询不自动完成迁移。",
    );
  const directory = resolve(
    toolHome ?? legacy?.meta.toolHome ?? join(home, "agent-sync"),
  );
  const v = await createAgentSync({
    ...options,
    home: directory,
    readOnly,
    ...(legacy?.meta.ownerId === "agent-sync:v1"
      ? { integrationRef: legacy.meta.integrationRef }
      : {}),
  });
  return Object.assign(v, { toolHome: directory });
}
export const inScope = (path, scope) =>
  scope.some((p) => p === "." || p === path || path.startsWith(p + "/"));

export async function readProjectContext(task, {operation, paths, query = "", offset = 0, limit = 100}) {
  const grant = task.record.readAuthorization;
  if (!grant) throw problem("READ_AUTHORIZATION", "No file-read authorization for this turn; ask for materials or explicit read scope");
  if (!["list", "read", "search"].includes(operation) || !Array.isArray(paths) || !paths.length ||
      paths.some(path => !validProjectPath(path, true) || !inScope(path, grant.paths)) ||
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      typeof query !== "string" || query.length > 500)
    throw problem("READ_SCOPE", "Invalid or unauthorized read request");

  let versioning;
  try {
    let files;
    if (grant.projectId) {
      versioning = await createVersioning({home:task.home, project:grant.canonicalRepo, readOnly:true});
      const tree = await versioning.read({version:grant.version, path:".", kind:"tree"});
      if (tree.version !== grant.version || !Array.isArray(tree.entries))
        throw problem("READ_VERSION", "Cannot verify formal version");
      files = tree.entries.map(file => ({path:file.path, mode:file.mode, oid:file.object}));
    } else {
      const tree = await legacyGit(grant.canonicalRepo, ["ls-tree", "-rz", grant.version], {bytes:true});
      files = [...gitTreeRecords(tree,{skipInvalidUtf8:true})].filter(entry => entry.type === "blob");
    }
    files = files.filter(file => validProjectPath(file.path) && inScope(file.path, paths) &&
      inScope(file.path, grant.paths) && ["100644", "100755"].includes(file.mode));
    let items = [];
    const decoder = new TextDecoder("utf-8", {fatal:true, ignoreBOM:true});
    const textLimit = 512 * 1024;
    if (operation === "list") items = files.map(file => file.path);
    else for (const file of files) {
      if (operation === "read" && !paths.includes(file.path)) continue;
      let bytes;
      if (versioning) {
        const value = await versioning.read({version:grant.version, path:file.path});
        if (value.version !== grant.version) throw problem("READ_VERSION", "Cannot verify formal file version");
        bytes = Buffer.from(value.contentBase64, "base64");
      } else {
        const size = Number(await legacyGit(grant.canonicalRepo, ["cat-file", "-s", file.oid], {bytes:true}));
        if (size > textLimit) throw problem("READ_LIMIT", "File exceeds bounded text read: " + file.path);
        bytes = await legacyGit(grant.canonicalRepo, ["cat-file", "blob", file.oid], {bytes:true});
      }
      if (bytes.length > textLimit) throw problem("READ_LIMIT", "File exceeds bounded text read: " + file.path);
      let text;
      try {
        text = decoder.decode(bytes);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error();
      } catch {
        if (operation === "search") continue;
        throw problem("READ_FORMAT", "Read authorized UTF-8 text only. Import images as material copies: " + file.path);
      }
      for (const [index, line] of text.split("\n").entries()) {
        if (operation === "read" || line.includes(query))
          items.push({path:file.path, line:index + 1, text:line.slice(0, 2000), ...(line.length > 2000 && {truncated:true})});
        if (items.length > offset + limit) break;
      }
      if (items.length > offset + limit) break;
    }
    return {version:grant.version, uncommitted:false, items:items.slice(offset, offset + limit), more:items.length > offset + limit};
  } finally { await versioning?.close(); }
}

// Grants use exact spellings. Only conflict detection folds paths, matching the
// kernel's portable namespace, including differently cased directory prefixes.
export function validProjectPath(path, allowRoot = false) {
  if (allowRoot && path === ".") return true;
  return typeof path === "string" && path === path.normalize("NFC") &&
    !/[\\:\x00-\x1f\x7f]/.test(path) &&
    path.split("/").every(part => part && part !== "." && part !== ".." &&
      !/[. ]$/.test(part) && !/^\.git(?:$|~)/i.test(part));
}
const projectPathKey = path => path.normalize("NFC").toLowerCase();
export function projectScopesOverlap(a, b) {
  const left = a.map(projectPathKey), right = b.map(projectPathKey);
  return left.some(path => inScope(path, right)) || right.some(path => inScope(path, left));
}
export function assertProjectPathSpellings(paths) {
  const seen = new Map();
  for (const path of paths) {
    let prefix = "";
    for (const part of path.split("/")) {
      prefix = prefix ? prefix + "/" + part : part;
      const key = projectPathKey(prefix);
      if (seen.has(key) && seen.get(key) !== prefix)
        throw Error("Ambiguous project path alias: " + seen.get(key) + " / " + prefix);
      seen.set(key, prefix);
    }
  }
}

// Consumer coordination only. The kernel remains authoritative for versions and permissions.
const changeQueues = new WeakMap();
export function withChangeQueue(versioning, changeId, operation) {
  let queues = changeQueues.get(versioning);
  if (!queues) changeQueues.set(versioning, queues = new Map());
  const run = (queues.get(changeId) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(changeId, run);
  void run.finally(() => { if (queues.get(changeId) === run) queues.delete(changeId); }).catch(() => {});
  return run;
}

/** Explicit CoThink legacy handoff. No model, checks, merge or user checkout mutation. */
export async function migrateLegacyProject({
  project,
  home,
  toolHome,
  ...options
}) {
  const { readFileSync, writeFileSync, readdirSync, existsSync } = await import(
    "node:fs"
  );
  const { randomUUID } = await import("node:crypto");
  const { writePrivateJson, acquireSessionWriter } = await import(
    "./storage.js"
  );
  const { legacyGit } = await import("./git-versioning.js");
  const info = await legacyProjectInfo({ project, home });
  if (!info) throw problem("NO_PROJECT", "没有可迁移的旧项目。");
  let current = JSON.parse(readFileSync(info.path, "utf8")),
    snapshot,
    lock,
    v;
  if (current.ownerId === "agent-sync:v1") {
    if (!current.migration?.snapshot)
      throw problem("LEGACY_CORRUPT", "迁移缺少原始快照；保持旧写入口停用。");
    snapshot = JSON.parse(readFileSync(current.migration.snapshot, "utf8"));
  } else {
    lock = acquireSessionWriter(info.directory, current.ownerId);
    try {
      const ro = await createGitVersioning({ project, home, readOnly: true });
      const receipts = [];
      for (const name of readdirSync(join(info.directory, "acceptance")).filter(
        (n) => n.endsWith(".json"),
      ))
        receipts.push(await ro.inspect({ requestId: name.slice(0, -5) }));
      const changes = [];
      for (const name of readdirSync(join(info.directory, "changes")).filter(
        (n) => n.endsWith(".json"),
      )) {
        const c = JSON.parse(
          readFileSync(join(info.directory, "changes", name), "utf8"),
        );
        changes.push(c);
      }
      const unresolved = changes.filter(
        (c) =>
          !["accepted", "abandoned"].includes(c.status) &&
          !receipts.some(
            (r) =>
              r.status === "accepted" &&
              r.changeId === c.changeId &&
              r.candidateVersion === c.candidateVersion,
          ),
      );
      if (
        unresolved.length ||
        receipts.some((r) =>
          ["unknown", "preparing", "prepared", "pending"].includes(r.status),
        )
      )
        throw problem(
          "MIGRATION_BLOCKED",
          "先核对旧open/prepared/unknown成果，不能自动放弃：" +
            JSON.stringify(
              unresolved.map((c) => ({
                changeId: c.changeId,
                status: c.status,
              })),
            ),
        );
      const originalText = readFileSync(info.path, "utf8"),
        version = (await ro.inspect()).version;
      snapshot = {
        projectId: info.projectId,
        originalText,
        originalMeta: current,
        changes,
        receipts,
        expectedTip: version,
        originalChanges: await legacyGit(info.root, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
        createdAt: new Date().toISOString(),
      };
      const path = join(info.directory, "migration-" + randomUUID() + ".json");
      writePrivateJson(path, snapshot);
      lock.assertOwned();
      if (readFileSync(info.path, "utf8") !== originalText)
        throw problem("LEGACY_CORRUPT", "迁移前元数据变化，停止。");
      current = {
        ...current,
        ownerId: "agent-sync:v1",
        backend: "agent-sync",
        toolHome: resolve(toolHome ?? join(home, "agent-sync")),
        migration: {
          status: "legacy_disabled",
          snapshot: path,
          expectedTip: version,
          originalOwnerId: current.ownerId,
        },
      };
      writePrivateJson(info.path, current);
      await ro.close();
    } finally {
      lock.release();
      lock = null;
    }
  }
  try {
    v = await createAgentSync({
      project,
      home: current.toolHome,
      checks: options.checks ?? [],
      execution: options.execution,
      integrationRef: current.integrationRef,
    });
    const fact = await v.inspect();
    if (fact.integrationRef !== current.integrationRef)
      throw problem(
        "MIGRATION_AUTHORITY",
        "正式引用不一致，保持停用旧写入口。",
      );
    if (
      current.migration.status !== "ready" &&
      fact.version !== snapshot.expectedTip
    )
      throw problem(
        "MIGRATION_AUTHORITY",
        "未完成迁移期间正式版本变化，必须人工核对。",
      );
    current.migration.status = "ready";
    current.migration.newProjectId = fact.projectId;
    writePrivateJson(info.path, current);
    return {
      status: "ready",
      version: fact.version,
      integrationRef: fact.integrationRef,
      toolHome: current.toolHome,
      snapshot: current.migration.snapshot,
      legacyProjectId: info.projectId,
      projectId: fact.projectId,
    };
  } finally {
    await v?.close();
  }
}
export async function rollbackLegacyMigration({ project, home }) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { acquireSessionWriter, writePrivateBytes } = await import(
    "./storage.js"
  );
  const info = await legacyProjectInfo({ project, home });
  if (info?.meta.ownerId !== "agent-sync:v1" || !info.meta.migration?.snapshot)
    throw problem("MIGRATION_STATE", "没有待回退的迁移。");
  const snapshot = JSON.parse(
    readFileSync(info.meta.migration.snapshot, "utf8"),
  );
  const lock = acquireSessionWriter(
    info.directory,
    snapshot.originalMeta.ownerId,
  );
  let v;
  try {
    v = await createAgentSync({
      project,
      home: info.meta.toolHome,
      integrationRef: info.meta.integrationRef,
    });
    const current = await v.inspect();
    if (current.version !== snapshot.expectedTip)
      throw problem(
        "MIGRATION_FORWARD_ONLY",
        "已有新正式历史；不能reset或直接恢复旧写程序。",
      );
    lock.assertOwned();
    writePrivateBytes(info.path, snapshot.originalText, lock.assertOwned);
    return {
      status: "rolled_back",
      version: current.version,
      snapshot: info.meta.migration.snapshot,
    };
  } finally {
    await v?.close();
    lock.release();
  }
}
