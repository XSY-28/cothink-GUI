import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  validatePreviewInput,
  MAX_OUTPUT,
  MAX_PNG,
  PREVIEW_PROTOCOL,
} from "../scripts/visual-preview.mjs";
import { problem } from "./task.js";

const exec = promisify(execFile);
export const sha = (b) => createHash("sha256").update(b).digest("hex");
export const visualManifest = () =>
  JSON.parse(
    readFileSync(
      new URL("../docker/visual-preview-manifest.json", import.meta.url),
      "utf8",
    ),
  );
export async function preflightVisual({
  cwd,
  config,
  skills,
  model,
  allowWork = true,
}) {
  if (!allowWork)
    throw problem(
      "VISUAL_PROJECT",
      "制作HTML/SVG需要先选择已准备的 Git 项目；输入已保留。",
    );
  if (!skills?.length)
    throw problem(
      "VISUAL_SKILLS",
      "制作需要显式技能来源：请在 piResources.skills 配置适用的 frontend-design SKILL.md 主文件，或选择受管包技能。",
    );
  if (!model?.input?.includes("image"))
    throw problem(
      "VISUAL_MODEL",
      "当前主模型不支持图像输入；不会切换模型或降级为文字视觉检查。",
    );
  try {
    await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  } catch {
    throw problem(
      "VISUAL_PROJECT",
      "制作HTML/SVG需要已准备的 Git 项目，不会自动 git init。",
    );
  }
  const manifest = visualManifest();
  if (
    sha(
      readFileSync(new URL("../scripts/visual-preview.mjs", import.meta.url)),
    ) !== manifest.rendererSha256
  )
    throw problem(
      "VISUAL_ENVIRONMENT",
      "预览脚本与镜像锁定清单不一致，请重新构建核验。",
    );
  if (
    config.work?.execution?.image !== manifest.image ||
    config.work.execution.network !== "none"
  )
    throw problem(
      "VISUAL_ENVIRONMENT",
      `请配置已核验的离线预览镜像 work.execution.image=${manifest.image}，network=none。`,
    );
  try {
    const { stdout } = await exec("docker", [
      "image",
      "inspect",
      manifest.image,
      "--format",
      "{{.Id}}",
    ]);
    if (stdout.trim() !== manifest.image) throw Error("digest mismatch");
  } catch (e) {
    throw problem("VISUAL_ENVIRONMENT", "离线浏览器镜像不可用：" + e.message);
  }
  return {
    image: manifest.image,
    protocol: manifest.protocol,
    skills: skills.map(({ name, hash }) => ({ name, hash })),
  };
}
export function parsePreviewOutput(text, input) {
  if (Buffer.byteLength(text) > MAX_OUTPUT)
    throw problem("VISUAL_OUTPUT", "预览输出超过16MiB");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw problem("VISUAL_OUTPUT", "预览输出不是完整JSON");
  }
  if (result.protocol !== PREVIEW_PROTOCOL || result.status !== "captured")
    throw problem("VISUAL_RENDER", result.error ?? "预览未成功");
  if (
    result.entry !== input.entry ||
    result.viewport?.width !== input.viewport.width ||
    result.viewport?.height !== input.viewport.height ||
    !Array.isArray(result.images) ||
    result.images.length !== input.frameTimesMs.length
  )
    throw problem("VISUAL_OUTPUT", "预览元数据不匹配");
  for (const [index, frame] of result.images.entries()) {
    if (
      typeof frame.data !== "string" ||
      frame.data.length > Math.ceil(MAX_PNG / 3) * 4
    )
      throw problem("VISUAL_OUTPUT", "图片超过4MiB或缺失");
    const bytes = Buffer.from(frame.data, "base64");
    if (
      bytes.length < 33 ||
      bytes.length > MAX_PNG ||
      bytes.toString("base64") !== frame.data ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== input.viewport.width ||
      bytes.readUInt32BE(20) !== input.viewport.height ||
      sha(bytes) !== frame.sha256 ||
      !Number.isFinite(frame.capturedAtMs) ||
      frame.requestedAtMs !== input.frameTimesMs[index]
    )
      throw problem("VISUAL_OUTPUT", "PNG签名、尺寸、时间或哈希无效");
  }
  return result;
}
export async function capturePreview({
  versioning,
  change,
  input,
  requestId,
  signal,
  onVersion = () => {},
}) {
  input = validatePreviewInput(input);
  if (
    change.readOnly ||
    !change.scope?.length ||
    !["open", "prepared"].includes(change.status)
  )
    throw problem(
      "VISUAL_SCOPE",
      "预览需要活跃且具有明确scope的change；请 next_change/refresh_change 声明范围。",
    );
  const sourceVersion = change.privateVersion;
  const source = await versioning.read({
    changeId: change.changeId,
    path: input.entry,
  });
  if (source.contentBase64 === null)
    throw problem("VISUAL_ENTRY", "入口不是当前受管源码文件。");
  const environment = (await versioning.inspect()).execution;
  if (environment?.image !== visualManifest().image || environment.network !== "none")
    throw problem("VISUAL_ENVIRONMENT", "截图需要锁定版本的断网浏览器镜像。");
  const envelope = {
    input,
    visibility: {
      scope: [...new Set([...change.scope, ...change.readScope])],
      artifactPaths: environment.artifactPaths ?? ["node_modules"],
    },
  };
  const encoded = Buffer.from(JSON.stringify(envelope)).toString("base64");
  if (encoded.length > 100000)
    throw problem("VISUAL_INPUT", "预览参数与授权范围过大，请缩小范围。");
  const command = "node /opt/preview/visual-preview.mjs " + encoded;
  const receipt = await versioning.exec(
    change.changeId,
    { requestId, expectedVersion: sourceVersion, command, timeoutMs: 30000 },
    { signal },
  );
  if (receipt.status !== "completed")
    throw problem(
      receipt.status === "unknown"
        ? "OPERATION_UNKNOWN"
        : "VISUAL_" + receipt.status.toUpperCase(),
      `预览${receipt.status}；只查询原requestId ${requestId}，不重发。`,
    );
  const after = await versioning.inspect({ changeId: change.changeId });
  onVersion(after);
  const diff = await versioning.inspect({
    fromVersion: sourceVersion,
    toVersion: receipt.privateVersion,
  });
  if (
    after.privateVersion !== receipt.privateVersion ||
    receipt.changedFiles?.length ||
    diff.files.length ||
    diff.text ||
    diff.binaryFiles.length
  )
    throw problem(
      "VISUAL_SOURCE_CHANGED",
      "预览期间源码/版本发生意外变化；保留现场，不回滚或自动接纳。",
    );
  const chunks = [];
  let offset = 0,
    size = 0;
  for (;;) {
    const page = await versioning.read({
      outputRef: requestId,
      offset,
      limit: 1048576,
    });
    const bytes = Buffer.from(page.contentBase64, "base64");
    size += bytes.length;
    if (size > MAX_OUTPUT) throw problem("VISUAL_OUTPUT", "预览输出超过16MiB");
    chunks.push(bytes);
    if (page.eof) break;
    if (page.nextOffset <= offset)
      throw problem("VISUAL_OUTPUT", "日志分页未前进");
    offset = page.nextOffset;
  }
  const output = Buffer.concat(chunks).toString();
  const result = parsePreviewOutput(output, input);
  if (receipt.exitCode !== 0)
    throw problem("VISUAL_RENDER", "预览进程失败：" + receipt.exitCode);
  return {
    ...result,
    sourceVersion,
    privateVersion: after.privateVersion,
    visibility: envelope.visibility,
    execution: environment,
    change: after,
    contentUnchanged: true,
  };
}

export function visualRuntimeProblem(diagnostics) {
  if (!diagnostics || !["blocked", "pageErrors", "resourceErrors", "console"].every(
    key => Array.isArray(diagnostics[key]) && diagnostics[key].every(message => typeof message === "string")))
    return "缺少可核验的浏览器运行诊断。";
  if (diagnostics.blocked.length)
    return "离线预览发现被拦截的网络或浏览器请求。";
  if (diagnostics.pageErrors.length || diagnostics.resourceErrors.length ||
      diagnostics.console.some(message => message.startsWith("error:")))
    return "离线预览发现页面运行或资源加载失败。";
  return null;
}
