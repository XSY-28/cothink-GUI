# GUI 候选验收记录

> **历史入口（2026-10-30）：** 本文保留首版 GUI 的验收事实。当前重设计及本地候选分别见 [重设计方案](REDESIGN_PROPOSAL.md)、[施工与完成标准](REDESIGN_IMPLEMENTATION_PLAN.md) 和 [当前验证记录](../../VALIDATION.md)；下列旧 CI、包哈希与安装结果不替代本轮验收。

本记录保留 `0.8.0-gui.1` 私有开发候选的历史验收。当前统一候选由根 `package.json` 的版本驱动，CLI 与 GUI 从同一个包安装；下列历史结果不自动代表统一候选已经通过。代码位于 [XSY-28/cothink-gui](https://github.com/XSY-28/cothink-gui)，不代表 npm 发布或全局安装已经更新。设计与逐阶段范围见 [DESIGN.md](DESIGN.md) 和 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)。

## 已验证的使用路径

- 空配置可进入设置，保存自定义服务商、隐藏输入的 Key 和命名 Team；管理操作零生成请求。
- 未关联项目时保持中性目录和纯问答权限。连续 CoThink 问答调用主答、第一位副模型评审、主答修订三次；ONE 一次。历史保留实际阵容、参与者、意见原文与修订。
- GUI → 实际 CLI PTY → GUI 恢复同一会话，保留上下文、模式、Team 和明确的无项目边界；同时占用时拒绝第二个 writer。
- 项目工作经实际 Pi／agent-sync 执行 read、edit、独立成员、Docker 检查与接纳，成果保存在独立目录。原项目文件与 Git status 不变。下载的补丁可重建相同 Git tree，覆盖二进制、删除和执行位；旧任务 diff 不随后续版本推进而变化。
- 从其他历史可返回并取消评审／成员任务。保留已完成内容、未发送草稿与未知请求，刷新和断连重连不排队、不重放生成；未知费用保持 null。
- Pi fork 继承当前分支的祖先轮次，排除兄弟分支；后续真实请求上下文与显示一致。确认恢复仅 GET 查询持久关联，提交去重键为 `(sessionId, submissionId)`，不同会话可独立复用同一键。
- 截断的会话、缺失或损坏的请求保持原字节并禁止继续生成；健康历史和设置仍可用。损坏诊断可见，不靠丢弃坏行恢复写入。

## 本机与安装包证据

macOS ARM64、localhost 固定回复和真实本机 Docker；零付费模型调用。源主套件 217 项中 216 通过、1 项既有 Windows 原生检查跳过；agent-sync 内核 48/48；终端 PTY 分组 17、40、6 通过。GUI 60/60；最后历史／写锁定向 9/9，相关共享存储／Pi／包／Team／恢复 40/40。已释放锁不再被误标为占用；只读判断复用现有最新 generation／released 语义，不改锁记录。

实际安装候选还运行 HTTP／CLI PTY／Docker 和真实 Pi 分支／损坏记录回归。打包先重建静态资源，使用中文和空格的独立 prefix 安装；检查实际 CLI、模块、认证、全部静态资源，以及安装文件与 tarball／源码字节一致。冻结 SDK 原始归档及其自身运行文件保持一致；不把 npm 会裁剪的嵌套依赖文档宣称为逐字节保留。

实际浏览器交互覆盖设置、讨论、ONE、项目成果与补丁、取消、历史、改名搜索、草稿、深浅主题。1280×800、1024×768、800×600 的实际 DOM 尺寸逐一核对；无横向溢出，输入区与窄屏浮层可达，焦点和滚动恢复通过，检查时 console 无 warning/error。最后历史修复另做安装候选浏览器复查。阶段截图、包 SHA-256、完整命令输出、失败现场与独立审查报告保留在本地忽略的执行证据目录，不进入源码仓库。

## 远端 CI

[Unified CLI and GUI verification](https://github.com/XSY-28/cothink-gui/actions/workflows/gui.yml) 在 `main` push、针对 `main` 的 PR 和手动触发时运行。工作流保留 Node 22.19.0，以验证根包声明的最低兼容版本；从根包读取预期版本，再校验 `pack-result.json` 中的版本与精确 tarball 文件名，不依赖版本常量或通配符挑包。每次 `pack:npm` 先构建 GUI；CLI 与 GUI 安装后检查使用同一候选。

Linux ARM64 保留完整源码、内核、GUI、PTY、Docker 及安装后集成；先准备 ripgrep／pyte，拉取冻结镜像摘要，核对架构并做禁网运行预检。Windows x64 与 ARM64 执行 Windows 专项、DOM／显示、构建、独立安装、实际 CLI／静态资源／认证／SDK 字节检查、原生剪贴板，以及安装目录模块驱动的真实 HTTP 历史和 partial／未知请求回归；x64 另复用现有 ConPTY 检查。安装验证的预期版本来自调用方 `COTHINK_EXPECT_VERSION`，未指定时来自独立源码；`gui-installed.mjs` 的第二个参数还指定用于版本和字节比较的源码目录。

以上是统一候选的 CI 配置范围，平台结果须绑定后续实际运行的 SHA。Windows Docker、物理 IME 和实体机体验仍需单独验收；旧公开发行 CI 不能替代本候选结论。

首次私有 CI 的失败记录保留：[39913455635](https://github.com/XSY-28/cothink-gui/actions/runs/39913455635)。Linux ARM64 runner 未预装现有搜索工具所需的 ripgrep，主套件报 `spawn rg ENOENT`；CI 现显式准备该依赖。Windows 源码／界面／构建已通过，安装字节比较发现 npm 将 CLI shebang 的 CRLF 规范化为 LF；用 `.gitattributes` 固定该入口文件为 LF，保持实际安装与源码一致。两项均保留原断言，修正后重新运行平台 CI。

修正后 [CI 39914559981](https://github.com/XSY-28/cothink-gui/actions/runs/39914559981) 在源码 `6defc97aa1ccc530977bcaef56db21f63cf40efb` 全部通过。Linux ARM64 包括完整主套件、内核、GUI、PTY、真实 Docker、干净安装及安装后集成；Windows x64 包括专项、DOM、构建与实际安装。最后只补验收文档，运行文件和 CI 配置与该检查点相同。CI 的 Actions Node 20 兼容提示保留；应用由配置的 Node 22.19.0 运行。

最终本地候选 SHA-256 为 `fe4bd5228e39b470b9c36c7d40bfe61111344cc505e2117832da916040b23c63`。15,157个安装普通文件与归档一致，实际入口、认证、62个HTTP静态资源与冻结SDK检查通过。与12项安装集成／最后浏览器候选比较，运行代码和GUI资源逐字节相同，仅README／VALIDATION说明不同。

可复现的主要本地命令：

```sh
npm ci --ignore-scripts
npm test
npm run test:agent-sync-core
npm run test:gui
npm run test:pi-terminal
export COTHINK_EXPECT_VERSION="$(node -p "require('./package.json').version")"
npm run --silent pack:npm -- dist > pack-result.json
tarball="$(node -p "require('./pack-result.json')[0].filename")"
prefix="$(mktemp -d)"
npm install --prefix "$prefix" --ignore-scripts --no-audit --no-fund "./dist/$tarball"
node test/helpers/gui-installed.mjs "$prefix/node_modules/cothink-v2" .
node test/helpers/npm-installed.mjs "$prefix/node_modules/cothink-v2"
COTHINK_TEST_PACKAGE_ROOT="$prefix/node_modules/cothink-v2" node --test test/gui-integration.test.js test/gui-history.test.js test/gui-partial.test.js
```

## 边界与保留问题

这些检查验证执行、状态和交付机制，不证明真实服务商答案质量或模型协作的普遍收益。尚未验收物理中文输入法、人工跨应用剪贴板、Windows 实体机与 Windows Docker。macOS 锁屏阻止 Finder 窗口观察，不能宣称成果目录窗口呈现通过。

已有 OAuth 认证可复用；新 OAuth 授权走 CLI `/login`。Shell 和非空检查要求固定镜像摘要的 Docker 配置；缺失时保留 partial／错误，不回退宿主 Shell。空检查策略明确为未验证。

冻结 SDK `1.0.0-cothink.9` → minimatch `10.2.6` → brace-expansion `5.0.9` 仍有 npm audit high（GHSA-qhr7-859c-m2p7、GHSA-6j4f-fj2g-mc7p），不是仅开发依赖问题；未擅自重打 SDK 消除告警。新增 KaTeX 依赖固定到 `0.19.0`。Vite 的大于 500 kB chunk 告警保留，约 707 kB／gzip 216 kB；构建通过不等于无告警。浏览器依赖和本地字体的声明见 [THIRD_PARTY_NOTICES.txt](../../gui/THIRD_PARTY_NOTICES.txt)。
