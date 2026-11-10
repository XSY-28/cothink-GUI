/** Isolated localhost demo. --package-root MUST point at the installed candidate for installed QA.
 * --empty starts with no model catalog/config; configure two custom providers using control.json.
 * Prompts: GUI_NORMAL (math/code/GFM), GUI_WORK (real read/edit/Docker/accept),
 * GUI_CANCEL_MANAGER, GUI_CANCEL_MEMBER (30 second fixture delay; Cancel stops the task).
 * Control file intentionally carries ephemeral credentials, mode 0600; ordinary stdout redacts URL fragment.
 */
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { fixture } from "./pi-fixture.js";
import { repository } from "./git-fixture.js";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const packageRoot = resolve(
  option("--package-root", fileURLToPath(new URL("../..", import.meta.url))),
);
const controlFile = resolve(option("--control", "work/gui/demo-control.json"));
const load = (path) => import(pathToFileURL(join(packageRoot, path)));
const { startGuiServer } = await load("src/gui-server.js");
const { saveConfig } = await load("src/config.js");
const { createTeamConfig } = await load("src/teams.js");
const cleanups = [];
const lifecycle = { after: (fn) => cleanups.push(fn) };
const repo = repository(lifecycle);
const counts = new Map();
let fileGeneration=0,projectRound=0;
let f;
const trace = [];
const tool = (name, args = {}) => ({ toolCalls: [{ name, args }] });
const normal =
  "# 本地演示 · GUI_NORMAL\n\n中文与 emoji 👩🏽‍💻。这是固定 fixture，不是模型质量结论。\n\n设 $x=2$，则\n\n$$\\sum_{k=1}^{3} k^2=14$$\n\n```js\nconst square = x => x * x;\nconsole.log(square(2));\n```\n\n| 路径 | 调用 |\n| --- | --- |\n| 直接答复 | 1 |\n| 按需评审 | 3 |\n\n- [x] 本地固定回复\n\n## 对评审意见的处理说明\n保留推导与代码，并说明这只是机制演示。";
f = await fixture(lifecycle, async (call, n, req, res) => {
  const body = call.body,
    text = JSON.stringify(body.messages),
    member = body.model === "r1" || body.model === "review";
  const filesWork=/GUI_FILES/.test(text);
  const work = /GUI_WORK|GUI_CANCEL_MEMBER|GUI_FILES/.test(text);
  trace.push({
    n,
    model: body.model,
    work,
    toolNames: (body.tools ?? []).map((x) => x.function?.name),
    time: Date.now(),
  });
  writeFileSync(
    controlFile + ".stats.json",
    JSON.stringify({ calls: trace.length, trace }, null, 2),
  );
  if (
    member ? /GUI_CANCEL_MEMBER/.test(text) : /GUI_CANCEL_MANAGER/.test(text)
  ) {
    await new Promise((done) => {
      const timer = setTimeout(done, 30000);
      res.once("close", () => {
        clearTimeout(timer);
        done();
      });
    });
    if (res.destroyed) return null;
  }
  if (member)
    return {
      text: work
        ? "成员已检查原始文件，保留 main 的独立修改范围。"
        : "独立评审：请保留公式、代码和 fixture 证据边界。",
    };
  if (work) {
    const isStart = (body.tools ?? []).some(
      (x) => x.function?.name === "start_work",
    );
    if (isStart) {
      if(filesWork)fileGeneration++;

      counts.set("work", 0);projectRound++;
      return tool("start_work", {action:projectRound===1?"start":"revise",reason:"isolated fixture project change",
        plan:{goal:filesWork?'GUI_FILES '+fileGeneration:'GUI_WORK '+projectRound,scope:['.'],works:[{id:'delivery',scope:['.']}],
          deliverables:filesWork?['a.txt','成果 页面/index.html','样式.css','说明.md','图形.svg','不安全.html','图片 空格.png','二进制.bin']:['a.txt'],
          checks:[{command:'node',args:['-e',"if(require('fs').readFileSync('a.txt','utf8')!=='GUI fixture accepted output\\n')process.exit(1);console.log('GUI fixture Docker check passed')"]}]}});

    }
    const turn = (counts.get("work") ?? 0) + 1;
    counts.set("work", turn);
    if(turn===1)return tool("next_change",{reason:"confirmed fixture delivery",scope:["."],readScope:["."]});
    const k=turn-1;
    if(filesWork) {
      const files=[
        ['a.txt','GUI fixture accepted output\n'],
        ['成果 页面/index.html',`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../样式.css"><main><h1>CoThink 文件成果 ${fileGeneration}</h1><p>固定版本静态预览 · 中文与空格资源</p><img src="../图片%20空格.png" width="180" height="180"><a href="https://example.invalid">导航已禁用</a></main>`],
        ['样式.css','body { margin: 0; padding: 48px; background: #f7f5f0; color: #20332b; font-family: sans-serif; } main { max-width: 600px; margin: auto; } h1 { font-size: 36px; } img { image-rendering: pixelated; }'],
        ['说明.md',`# 文件交付 ${fileGeneration}\n\n这是一组由本地 fixture 通过真实工作入口生成的文件。\n\n- HTML 和相对 CSS、图片\n- 独立 SVG\n- 源码、差异与原始下载\n\n机制验证不代表模型质量。`],
        ['图形.svg','<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 180"><rect width="300" height="180" rx="18" fill="#dce9e0"/><circle cx="75" cy="90" r="40" fill="#2d6650"/><text x="135" y="96" font-size="20" fill="#20332b">静态 SVG</text></svg>'],
        ['不安全.html','<h1>脚本预览必须拒绝</h1><script>window.parent.localStorage.setItem("p4-unsafe","ran");fetch("https://example.invalid/p4")</script>'],
      ];
      // Later generations overwrite existing paths and must obtain fresh observations first.
      const operations=files.flatMap(([path,content])=>[
        ...((fileGeneration>1||path==='a.txt')?[tool('read',{path})]:[]),
        tool('write',{path,content}),
      ]);
      if(k<=operations.length)return operations[k-1];
      if(k===operations.length+1)return tool('bash',{command:`node -e 'const fs=require("node:fs");fs.writeFileSync("图片 空格.png",Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64"));fs.writeFileSync("二进制.bin",Buffer.from([0,255,1,2]));if(fs.existsSync("b.txt"))fs.unlinkSync("b.txt");fs.chmodSync("a.txt",0o755);'`});
      if(k===operations.length+2||k===operations.length+3)return tool('accept_change');
      return {text:`# 本轮文件成果 ${fileGeneration}\n\n文件已保存到独立成果目录，原项目未写回。通过下方文件入口查看固定版本的网页、Markdown、SVG、二进制下载及删除差异。\n\n不安全 HTML 保留原字节，静态预览应明确拒绝。此轮使用本地 fixture，检查状态以宿主实际记录为准。`};
    }
    if(k===1)return tool("project_staff",{action:"appoint",input:{id:"reader",responsibility:"Inspect original input",scope:[],readScope:["."],models:[args.includes("--empty")?"demo-review/review":"fixture/r1"],need:"deliverable",reason:"Independent inspection"}});
    if (k === 2)
      return tool("delegate", {
        staffId:"reader",
        model: args.includes("--empty") ? "demo-review/review" : "fixture/r1",
        assignment: "Inspect original a.txt",
        implementationAdvice: "read only fixture inspection",
        reason: "independent inspection",
        scope: [],
        readScope: ["."],
        readOnly: true,
      });
    if (k === 3) return tool("collect");
    if (k === 4) return tool("read", { path: "a.txt" });
    if (k === 5)
      return tool("write", {
        path: "a.txt",
        content: "GUI fixture accepted output\n",
      });
    if (k === 6 || k === 7) return tool("accept_change");
    return {
      text: "# 项目成果\n\n已通过本地 Docker fixture 检查，独立成果中的 a.txt 已更新。原项目目录没有写回。",
    };
  }
  return { text: normal };
});
if (args.includes("--empty")) rmSync(join(f.home, "pi/models.json"));
else if (!args.includes("--setup"))
  saveConfig(
    f.home,
    createTeamConfig(
      { formatVersion: 2, ...f.models },
      "本地 GUI 验收",
      randomUUID(),
    ),
  );
const execution = JSON.parse(
  (await import("node:fs")).readFileSync(
    new URL(
      "../../packages/agent-sync/execution-manifest.json",
      import.meta.url,
    ),
  ),
).execution;
if (!args.includes("--empty") && !args.includes("--setup")) {
  const cfg = JSON.parse(
    (await import("node:fs")).readFileSync(join(f.home, "config.json")),
  );
  saveConfig(f.home, {
    ...cfg,
    work: {
      execution,
      checks: [
        {
          command: "node",
          args: [
            "-e",
            "if(require('fs').readFileSync('a.txt','utf8')!=='GUI fixture accepted output\\n')process.exit(1);console.log('GUI fixture Docker check passed')",
          ],
        },
      ],
    },
  });
}
let host = await startGuiServer({
  home: f.home,
  cwd: repo.project,
  open: false,
});
mkdirSync(join(controlFile, ".."), { recursive: true });
function writeControl() { writeFileSync(
  controlFile,
  JSON.stringify(
    {
      packageRoot,
      home: f.home,
      project: repo.project,
      url: host.url,
      endpoint: f.endpoint,
      dummyKey: "localhost-only-dummy",
      models: ["main", "r1"],
      empty: args.includes("--empty"),
      execution,
      checks: [
        {
          command: "node",
          args: [
            "-e",
            "if(require('fs').readFileSync('a.txt','utf8')!=='GUI fixture accepted output\\n')process.exit(1);console.log('GUI fixture Docker check passed')",
          ],
        },
      ],
      pid:process.pid,
      restart:"向本进程 stdin 写入 restart\n，或在 macOS/Linux 发送 SIGUSR2；private control 将更新同 home 的新 token。",
      prompts: [
        "GUI_FILES",
        "GUI_NORMAL",
        "GUI_WORK",
        "GUI_CANCEL_MANAGER",
        "GUI_CANCEL_MEMBER",
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
chmodSync(controlFile, 0o600); }
writeControl();
console.log(
  JSON.stringify({
    packageRoot,
    controlFile,
    origin: new URL(host.url).origin,
    paidModelCalls: 0,
  }),
);
let closing = false, restarting = false;
async function restartHost() {
  if(closing||restarting)return;
  restarting=true;
  try {await host.close();host=await startGuiServer({home:f.home,cwd:repo.project,open:false});writeControl();console.log(JSON.stringify({restarted:true,home:f.home,origin:new URL(host.url).origin}));}
  catch(error){console.error('Fixture host restart failed:',error.message);}
  finally{restarting=false;}
}
process.stdin.setEncoding('utf8');
let input='';process.stdin.on('data',chunk=>{input+=chunk;let at;while((at=input.indexOf('\n'))>=0){const command=input.slice(0,at).trim();input=input.slice(at+1);if(command==='restart')void restartHost();}});
if(process.platform!=='win32')process.on('SIGUSR2',()=>void restartHost());
async function close() {
  if (closing) return;
  closing = true;
  await host.close();
  for (const fn of cleanups.toReversed()) await fn();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, close);
