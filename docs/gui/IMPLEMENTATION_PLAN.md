# CoThink GUI 施工计划

> **历史入口说明（2026-10-30）：** 本文保留首版 GUI 的设计／施工事实。当前重设计以 [REDESIGN_PROPOSAL.md](REDESIGN_PROPOSAL.md) 和 [REDESIGN_IMPLEMENTATION_PLAN.md](REDESIGN_IMPLEMENTATION_PLAN.md) 为入口；下文旧轮次的开工授权不自动适用于新重设计。

> **状态：已获明确开工授权（2026-10-23）。** 按各阶段持续实施、独立审查、自行核验并交付 private GitHub；不向用户提问。原停止指令仅针对此前轮次，现已取代。使用 subagent-driven-development，每阶段记录结果和失败。

**Goal:** 交付可实际启动的本地 GUI，同时完成连续问答与项目改代码；中央交付、右侧本轮协作，复用现有 Pi 与 agent-sync；分阶段核验后推送私有 GitHub。

**Architecture:** React 静态页面 → loopback Node HTTP 宿主 → 共享会话控制及现有 runTurn/runWork。Pi 主会话、Team、认证、task/request、agent-sync 为唯一事实来源；前端只显示结构化投影。

**Tech Stack:** Node.js >=22.19、ES modules、React/Vite、react-markdown + remark-gfm + remark-math + rehype-katex；Node 原生测试与既有 localhost Pi fixture。依赖从 npm 核对后锁定精确版本，静态资源随包交付。

**Spec:** [DESIGN.md](DESIGN.md)。它对应本次已授权实施的设计。

## 全局约束

- 问答 ONE 一次、CoThink 三次且仅第一副模型评审；工作 maxCalls=null，ONE 不委派。无新增总结、标题或分类请求。
- 无默认模型超时、可省略输出额度、自动重试、自动压缩、自动预热。未知费用/请求保留未知。
- 模式运行中修改仅影响下一条；Team 运行中不切；配置和身份随提交冻结。
- 普通 GUI 聊天不关联项目时使用中性目录并禁止项目上下文与 start_work；恢复到 CLI 也保留该边界。绑定项目沿用现有隔离、版本与检查。
- 原目录不自动覆盖；真实验收不使用私人项目或已有凭据，全部模型机制测试用 localhost fixture。实际模型质量不在本轮已验证结论内。
- 一个 GUI 宿主一条活跃用户任务；成员并行由现有核心负责。页面可浏览别的历史，不新增任务队列。
- 模型交流必须来自已有记录。无虚构话术、读回确认、共识率、逐条批评状态或额外 Agent/消息数据库。
- 浏览器拿不到历史 Key、原始认证对象或未筛选请求。HTML不执行，远程图片不自动加载。所有 API 含读取及事件均需启动令牌，校验 Host/Origin，仅绑定 loopback。
- 所有 Git 操作前检查变化文件并说明用途；只暂存明确路径。禁止向公开仓库推送，禁止改公开仓库可见性；不发布 npm、不替换全局安装。
- 原工作区已有未提交成果须保留。计划采用本次核对的较新干净发行源 fc5b0626e2d532e7527e90325d3493567b6d6c75（0.7.0-auth.2）；它包含原工作区尚未同步的认证修复。正式开工前重新检查源版本与差异，不能机械复用旧SHA。
- 计划使用独立开发副本和 codex/lightweight-gui 分支。私有目标建议 XSY-28/cothink-gui，执行时先创建/核对 private 再推送。若已存在则核对归属与内容，禁止覆盖不相关项目；目标已由 CLI 创建并核对 private，源码仍待最终验收后推送。
- 构建与任务证据保存在忽略目录 work/gui/，可公开的使用说明/测试放入源码；用户要求的完整计划和设计以无密钥、无本机私有记录的文档保留。

## 对外数据合同

模块名可按功能进一步小范围拆分，但只为文件职责而拆，不能新建通用框架。以下名称为各阶段共同接口，改变时同步调用方与测试。

```js
const controller = await createGuiController({home, cwd});
await controller.bootstrap();
await controller.session(sessionId);
await controller.task(taskId);
await controller.action(action, args);
await controller.diff(taskId);
await controller.output(taskId, outputRef, offset, limit);
await controller.patch(taskId);
controller.subscribe(listener); // returns unsubscribe; invalidation only
await controller.close();
```

`bootstrap()` 返回 `{version,configured,teams,currentTeamId,providers,models,sessions,active,work,releaseNotes,suggestedProject,historyErrors}`。其中 provider/model 是明确选择的安全字段；model 包含 SDK 本地声明的 thinkingLevels（不联网、不生成）；`work` 仅返回已有公开执行配置。`active` 为 `{taskId,sessionId,status}` 或 null。`sessions` 为 `{id,title,project,updatedAt,readOnly}` 数组，不包含内部评审会话。

`session(id)` 返回 `{id,title,project,mode,team,thinking,draft,turns,submissions,readOnly,selectionError}`。mode 为 `one` 或 `cothink`，project 为规范绝对路径或 null；turns 每项 `{taskId,submissionId,input,status,mode,finalText}`。turns 按 Pi 当前选中分支的任务引用排序，继承祖先且排除兄弟分支；活跃已接纳任务可在首个引用写入前显示。submissions 为当前原始会话持久任务的 `{taskId,submissionId}` 关联，仅供 GET-only 确认恢复，不显示兄弟分支内容。去重键保持 `(sessionId,submissionId)`；fork 的相同 submissionId 是独立提交。历史读取不创建模型 runtime、不占写锁、不生成。损坏会话／请求保留原文件并返回 readOnly 与诊断，健康历史及设置仍可用。

`task(id)` 返回 `{id,sessionId,input,createdAt,endedAt,status,phase,mode,singleModel,team,participants,messages,usage,error,work}`。messages 每项 `{id,role,phase,model,status,text}`，按真实调用排列；模型和作者未知时显式 null。participants 为 `{id,role,model,status,participated}`。work 为筛选后的 `{root,startVersion,version,integrationRef,resultWorkspace,finalCheck,members,activities,acceptance,outputRefs}` 或 null。不要把原始 request.context/headers/response 直接送前端。

action 白名单及参数：

- `session.create` `{project:null|string}` → session；新会话默认 cothink，继承当前合法 Team。
- `session.name` `{sessionId,title}`；`session.draft` `{sessionId,text}`。
- `session.mode` `{sessionId,mode}`；`session.team` `{sessionId,teamId}`；`session.thinking` `{sessionId,level}`，按现有模型能力校验，运行中只改下一条。
- `team.save` `{name,main,secondary}` → 新 Team；调整阵容也保存新名字，保留旧组。
- `team.remove` `{teamId,sessionId}` → 保留当前与最后一个保护。
- `provider.save` `{providerId,apiKey,custom?}`；custom 含 baseUrl、api、modelId、name、contextWindow、maxTokens。复用 Pi 登录/已有校验，永不返回 apiKey。OAuth 已有认证复用，新增授权明确提供 CLI 指引。
- `settings.work` `{work}` → 保存共享全局配置，明确后续任务生效。
- `releaseNotes.ack` `{version}` → 仅确认已展示的当前安装版本摘要，复用 CLI 的已显示版本记录；bootstrap 返回是否未读，轮询不标记。
- `project.inspect` `{path}` → `{path,valid,dirty,head,version,execution,checks,error}`；只读，不偷偷初始化/迁移/提交。
- `task.submit` `{sessionId,input,submissionId}` → `{taskId,sessionId}`，异步执行，持久关联避免重复。
- `task.cancel` `{taskId}`；`task.reveal` `{taskId}` → 仅打开记录中的可信成果目录。

`diff(id)` 返回 `{fromVersion,toVersion,files,text,binaryFiles}`；`patch(id)` 返回同一完整 text。`output` 只允许属于该任务的 outputRef，返回分页文本及 nextOffset/eof。

## Task 1: 共享会话与完整 GUI 控制器

**Files:** 新增 src/conversation.js、src/gui-controller.js、src/gui-projection.js、test/gui-controller.test.js、test/gui-projection.test.js；必要时按职责拆成 src/gui-settings.js / src/gui-work.js。小改 src/interactive.js、src/discussion.js、src/pi-runtime.js、src/task.js、src/workers.js、src/extensions/cothink.js。

**Consumes:** 现有 Pi SessionManager、createRuntime、runTurn、Team 规则与 agent-sync。
**Produces:** 上述 createGuiController 合同；CLI与GUI共同使用的模式/Team/项目关联恢复；工作 startVersion；持久 submissionId。

- [x] 先用既有 fixture 写调用数与连续上下文的失败测试。示例断言：

```js
const first = await c.action('task.submit', {sessionId, input:'first', submissionId:key});
const duplicate = await c.action('task.submit', {sessionId, input:'first', submissionId:key});
assert.equal(duplicate.taskId, first.taskId);
await waitForTask(first.taskId);
assert.equal(f.calls.length, 3);
assert.equal((await c.task(first.taskId)).messages.length, 3);
```

- [x] 测试空项目不加载启动目录 AGENTS、不暴露 start_work；绑定项目可进入真实 runWork。模式保存失败不得假成功，旧无Team记录必须显式绑定。
- [x] 提取 read/save 模式、选择 Team、恢复项目关联的共享非 UI 函数；保留终端交互和已有认证修复。连续运行传同一 mainRuntime。
- [x] 使用 Pi 主会话列表和既有 custom entry 保存草稿、标题、项目关联，不建立会话数据库；空项目使用中性目录。
- [x] 创建/恢复写 runtime 时沿用 writer 锁。只读查看与活跃 runtime 分开；活跃任务读取内存，历史 running 才投影未知。
- [x] 持久提交关联与串行提交边界：同 key 返回原 task，旧确认丢失只查询，不复发；关宿主取消，关页面不取消。
- [x] Settings用现有验证、配置锁与Pi认证；服务商错误不泄露Key；Team规则不能复制成另一套。
- [x] 用只读 inspect/read 投影工作成果，固定 startVersion，终点取本任务保存结果/接纳回执，不拿当前 tip；日志限定本任务、分页；reveal只用记录路径。
- [x] 问答三卡按原文；工作关系能证明时显示交接，缺关联仅活动记录。修订说明不做语义分类；历史身份不用当前设置覆盖。
- [x] 验证：`node --test test/gui-controller.test.js test/gui-projection.test.js`，以及改动覆盖的 pi-modes、pi-team-session、pi-discussion、agent-sync-entrypoints 测试。记录RED/GREEN及失败。
- [x] 自查后按明确文件提交，交任务审查；修复重要问题后再进入下阶段。

## Task 2: 本地 HTTP 宿主与 CLI 启动

**Files:** 新增 src/gui-server.js；修改 src/cli.js；新增 test/gui-server.test.js。
**Consumes:** Task 1 controller合同。
**Produces:** `startGuiServer({home,cwd,port=0,open=true,controller?,assetDirectory?})` → `{url,token,close,server}`；`cothink gui [--port N] [--no-open]`。

- [x] 先写真实 HTTP 失败测试：未认证读写403，错误Host/Origin403，未知 action 拒绝，JSON大小超限413，路径穿越/符号链接不泄漏，返回内容不含fixtureKey。
- [x] 实现静态资源服务与明确路由：GET /api/bootstrap、/api/session?id、/api/task?id、/api/diff?id、/api/patch?id、/api/output?id&ref&offset&limit；POST /api/action `{action,args}`；GET /api/events。
- [x] 所有API要求 Authorization Bearer；默认127.0.0.1随机端口。启动URL的fragment带一次启动token，前端读取后清除fragment并仅存本标签sessionStorage；token不进查询串、普通运行日志、任务记录或模型请求。CLI 首次有意展示含 fragment 的本机启动链接，用于 --no-open 手动访问；这属于显式凭据交付，测试保存输出时必须去除该凭据。
- [x] Host精确限制绑定地址端口；Origin如存在必须同源；变更要求JSON和认证。CSP限制本地脚本/样式，模型HTML不执行；读取构建目录必须限制realpath。
- [x] SSE使用fetch流，事件仅通知状态刷新，不自动重发任何action；连接丢失后读取同一 task。
- [x] CLI gui在生成配置/普通参数分派之前进入；无配置也可打开设置与历史；SIGINT/SIGTERM取消并关闭controller/server。open按平台受控参数调用，--no-open支持CI。
- [x] 验证真实server、CLI进程启动/退出、多个事件订阅、刷新和取消；跑Task1+Task2组合测试。
- [x] 自查并提交；任务审查后继续。

## Task 3: 可用的 React 界面

**Files:** 新增 gui/index.html、gui/src/main.jsx、gui/src/App.jsx、gui/src/api.js、gui/src/styles.css，可按设置/协作/成果拆小组件；gui/vite.config.js。修改 package.json、package-lock.json、.gitignore；新增 test/gui-view.test.js 或前端组件测试。
**Consumes:** Task2全部HTTP合同。
**Produces:** `npm run build:gui` → gui/dist；npm scripts `gui`、`test:gui`；产品 `cothink gui` 读dist。

- [x] 添加精确锁定React/Vite及Markdown公式库；避免运行时CDN、SSR、状态管理框架；记录已有依赖警告，不写成零警告。
- [x] 页面实现深浅色、240px导航、主要阅读区、本轮协作概览；1280×800、1024×768、800×600可用，窄窗覆盖式面板保持焦点/返回位置。
- [x] 左栏新对话、项目、搜索、历史；中央完整最终稿、草稿、输入与模式/Team/思考控制；右侧真实参与者、连续初稿→评审→处理说明。点击成员定位已有记录。
- [x] 项目右栏共用“协作/变更/检查”，带只读日志、版本差异、检查、补丁和成果目录。部分成果保留，清楚说明未写回原目录。
- [x] 设置完整覆盖Key、自定义服务商、Team另存与删除保护、全局work配置；引导场景可从空配置完成，不假装OAuth全部有GUI。
- [x] API密钥不回显历史值，表单提交后清空；服务商失败显示可读错误；不加载远程图片/执行模型HTML。
- [x] 活跃任务跨页面可返回/停止。Enter发送但IME composition不误发；Shift+Enter换行；运行中草稿保留，不排队。刷新重连、提交确认丢失只查同submissionId。
- [x] 前端状态来源后端，不能在页面假造完成、参与者、共识或检查通过。主答处理说明为原文，格式不明完整展示。
- [x] 更新摘要先展示后调用 releaseNotes.ack，复用跨 CLI/GUI 的版本显示状态；bootstrap 轮询无确认副作用，损坏状态保留并提示。
- [x] 构建通过，组件/投影测试验证最关键交互与无脚本渲染，记录失败及修复；自查并提交后交审。

## Task 4: 集成、真实入口与发布包验收

**Files:** 新增 test/gui-integration.test.js、test/helpers/gui-demo.mjs；修改 scripts/pack-npm.mjs、package.json files、README.md、CHANGELOG.md、VALIDATION.md；只因发现缺陷修改覆盖的源码。
**Consumes:** Task1–3实际产物。
**Produces:** 0.8.0-gui.1 私有候选、可重复fixture、可安装包与验收记录。

- [x] localhost fixture通过真实server发送：空配置设置→命名Team→三次问答→ONE→恢复；至少一次项目read/edit/check/accept完整工作；确认原目录字节不变。
- [x] 验证重复提交、刷新、断连、取消评审、取消成员、写锁、损坏/旧记录、未配置检查、缺Docker、旧任务固定版本diff、补丁应用重建结果。所有失败保留。
- [x] 运行 `npm test`、`npm run test:agent-sync-core`、`npm run test:gui`、`npm run test:pi-terminal`、`npm run build:gui`；环境缺失先独立确认原因再修，不改成功标准。
- [x] 使用浏览器打开实际构建服务器，完成问答/讨论/模式/项目/设置/取消/历史交互；检查三种视口、中文与公式、横向溢出、焦点与console。截图保存在work/gui，不带真实Key/私人项目。
- [x] 打包加入GUI源码模块与dist（排除测试凭据、work、.superpowers等），在干净prefix安装候选；`--version`、`gui --no-open`、静态资源及fixture路径再次检查，不替换全局。
- [x] 通过文档写清安装、启动、功能边界、OAuth、Docker、独立成果与非实时模型验收。真实浏览器操作不冒称Windows实体机或真实付费模型通过。
- [x] 自审与整分支审查，修复重要发现；保留最终完整证据和变更清单。

## Task 5: 私有 GitHub 交付

**Files:** .github/workflows/gui.yml（复用现有CI，必要时扩展GUI构建/API测试）；docs/gui/ACCEPTANCE.md（仅无敏感数据的结论）。
**Produces:** 已核对private的仓库、远端源码提交和可追溯提交SHA。

- [x] 核对当前分支变化清单，生成明确交付allowlist；扫描凭据、真实会话、绝对私人路径、模型原始日志，排除本地证据目录。
- [x] 创建或核对 XSY-28/cothink-gui 为private；origin只指向该私有目标，不改公开仓库可见性。目标如冲突，选择新的明确私有开发仓库并记录理由。
- [x] 分阶段提交均有本地证据；最终以正常非force push发送当前分支。新私有仓库的默认分支可用此交付分支，保留完整来源历史与许可证。
- [x] 重新读取远端private属性、branch SHA、主要文件blob，与本地核对。运行可用CI并处理实际失败；若平台无法提供某验证，准确记录边界。
- [x] 交付完整计划、源码目录、启动命令、私有链接、最终SHA和验证结果。不得只说已推送而不给可检查入口。

## 阶段验收与推进规则

每阶段完成“需求对应检查 → 针对性测试 → 独立审查 → 修复 → 复核”后才进入下一阶段。每阶段形成一份记录，包含文件清单、实际测试命令、结果、失败及其处置、提交SHA；检查通过后仅暂存该阶段的明确文件并建立本地提交。最终整体回归、安装包与隐私检查通过后，再推送已确认private的仓库并核对远端SHA和CI。

不以测试数量替代功能验收，不把模拟模型或浏览器截图称为真实模型质量、Windows实体机或普遍性能结论。常规歧义由执行者按设计基线作出最小决定并记录理由。遇到缺少凭据/权限等无法自行取得的条件，保留现场、完成其他独立工作并报告具体缺口；不得擅自扩大权限、转为公开发布、放宽检查或编造通过。

每阶段本地提交是可恢复检查点。失败时保留失败记录和已有产物，修复后重验；不覆盖原工作区，不自动替换全局安装，不重发结果未知的模型请求。

## 计划执行状态

- [x] 0：复核隔离副本、分支、来源和差异；Docker 29.8.2 可用。
- [x] 1：共享会话与控制器；d3ba2ca、916bb13，42/42 通过，四项审查问题已关闭。
- [x] 2：HTTP与CLI；9983001，48/48 通过，独立审查无待修项。
- [x] 3：完整GUI；7160125、7db6f5a，GUI44/44，焦点审查问题关闭。
- [x] 4：集成与候选验收；73d88d4、67bf023、4bb9c58，最终 GUI60/60、安装集成12/12，独立审查关闭。
- [x] 5：私有GitHub提交与远端核验；源码6defc97的Linux ARM64／Windows x64 CI全部通过，正常推送、默认分支与关键blob已核对。最后仅补验收记录。

## 预设取舍

- 公开发行仓库不能承接本次private要求，因此使用独立私有开发目标；不改变原公开仓库。
- 基于较新的0.7.0-auth.2，避免回退认证修复；原工作目录不覆盖。
- 无新增付费模型调用；本轮质量结论限定机制、界面与localhost验证。
- 优先复用适合的隔离副本；若需新建，选择能保留现有未提交工作且不会误推公开仓库的方式。当前原repo指向已归档旧仓库，因此隔离克隆较合适。
- 原始失败证据保留在忽略目录，优先于技能默认的临时工作区删除建议。

## 本次纠正后的现场记录

收到“不要施工”后已中断执行代理，未发现GUI实现文件或产品代码改动。此前误启动的准备动作包括：创建本地隔离副本、安装其锁定依赖、运行既有25项基线检查、启动已有Docker、建立一个仅含计划与执行说明的本地文档提交。没有推送。私有仓库创建命令在前置GitHub用户查询时TLS超时；随后连接器查询未找到目标仓库。上述准备不算任何GUI实现阶段完成，不继续执行。


## 2026-10-23 明确重新开工

用户已明确授权连续实施、阶段核验与私有仓库交付；上述历史停止记录保留为历史，现不再阻断执行。

## 最终交付核验（2026-10-23）

私有目标为 [XSY-28/cothink-gui](https://github.com/XSY-28/cothink-gui)，默认分支 `codex/lightweight-gui`。源码检查点 `6defc97aa1ccc530977bcaef56db21f63cf40efb` 的 [GUI CI](https://github.com/XSY-28/cothink-gui/actions/runs/39914559981) 全部通过：Linux ARM64 完整源码／内核／GUI／PTY、真实 Docker、打包及安装后集成，Windows x64 专项／DOM／构建与实际安装。

首次 CI 的缺少 ripgrep 和 Windows shebang 换行差异保留原失败记录，修复没有跳过用例或放宽字节断言。最后文档提交只更新本计划与验收记录，运行代码、依赖、README、分发包和 CI 配置保持已验字节；CI 绑定源码检查点，最后文档 SHA 由交付记录另外列明。

最终本地候选 SHA-256 为 `fe4bd5228e39b470b9c36c7d40bfe61111344cc505e2117832da916040b23c63`。它与12项安装集成及最后浏览器候选的运行代码／GUI资源逐字节相同，仅README／VALIDATION说明不同；新包实际入口与全部静态资源另已通过。完整来源、失败、候选比较和截图保留于本地执行证据，未推送认证或真实会话。
