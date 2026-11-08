import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { writePrivateBytes } from "./storage.js";
import { sessionStateError } from "./session-ui-state.js";

// Summaries deliberately omit unidentifiable histories. Creation must also inspect
// UUID-bearing filenames, so a damaged header cannot make an occupied ID look free.
export function assertNewGuiSessionId(directory, id) {
  for (const name of readdirSync(directory).filter(name => name.endsWith(".jsonl"))) {
    let header;
    try { header = JSON.parse(readFileSync(join(directory,name),"utf8").split("\n").find(Boolean)); }
    catch {
      if (name.includes(id)) throw sessionStateError("SESSION_STATE_UNAVAILABLE","同一会话 ID 的文件头损坏；原文件保留，请读取核对，不能重新创建。");
      continue;
    }
    if (name.includes(id) || header?.id === id) {
      if (header?.type !== "session" || header.id !== id || header.version !== CURRENT_SESSION_VERSION || typeof header.cwd !== "string")
        throw sessionStateError("SESSION_STATE_UNAVAILABLE","同一会话 ID 的文件头不可确认；原文件保留。");
      throw sessionStateError("SESSION_STATE_CONFLICT","会话 ID 已存在；请按原 ID 读取核对，本次未覆盖。");
    }
  }
}

/** Only the first GUI publication; all later appends belong to the public SDK. */
export function persistNewGuiSession({manager,directory,assertOwned}) {
  const path = manager.getSessionFile(), header = manager.getHeader(), entries = manager.getEntries();
  if (!path || resolve(dirname(path)) !== resolve(directory) || realpathSync(dirname(path)) !== realpathSync(directory) ||
      header?.type !== "session" || header.version !== CURRENT_SESSION_VERSION || header.id !== manager.getSessionId() ||
      entries.some(entry => entry.type === "message") || !entries.some(entry => entry.type === "custom" && entry.customType === "cothink-gui-workspace"))
    throw sessionStateError("SESSION_STATE_UNAVAILABLE","不是可首次发布的 GUI 会话。");
  assertOwned();
  assertNewGuiSessionId(directory,header.id);
  const bytes=[header,...entries].map(entry=>JSON.stringify(entry)).join("\n")+"\n";
  writePrivateBytes(path,bytes,()=>{
    assertOwned();
    if (existsSync(path)) throw sessionStateError("SESSION_STATE_CONFLICT","会话文件已存在，请按原 ID 读取核对；未覆盖。");
    assertNewGuiSessionId(directory,header.id);
  });
  try {
    const reopened=SessionManager.open(path,directory,manager.getCwd());
    if (reopened.getSessionId() !== header.id || reopened.getLeafId() !== manager.getLeafId()) throw Error("会话身份或终点不匹配");
    return reopened;
  } catch(error) {
    throw sessionStateError("SESSION_STATE_UNAVAILABLE",`会话 ${header.id} 已发布，但重开未确认；请按原 ID 查询，不要重复创建。${error.message}`);
  }
}
