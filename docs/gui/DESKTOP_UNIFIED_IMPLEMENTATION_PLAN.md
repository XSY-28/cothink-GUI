# CoThink 桌面 App、统一项目会话与内置 Skill 施工文档

> **2026-11-10 协作设计修订。** [当前设计基线](../../DESIGN_BASELINE.md)定义主模型按任务复杂度和阵容能力自行组团、各岗位的身份和权限，以及最终交付责任。
>
> 下文保留 2026-11-08 的施工合同和验收口径。第 6 节的单次问答评审路线和结构化必需评审属于该期实现。0.8.14-desktop.5 仍保留旧的评审复选框，当前设计由主模型按任务判断是否组团。已交付行为及验证范围见 [VALIDATION](../../VALIDATION.md)。

> **导航后续修正（2026-11-09）。** 用户确认恢复项目 Team 一级导航，见[导航修正施工文档](TEAM_NAVIGATION_REFINEMENT_PLAN.md)。该修正在本文原施工记录之后实施，交付证据见 [VALIDATION](../../VALIDATION.md)。

> 执行者先读本文及[当前设计基线](../../DESIGN_BASELINE.md)。获得本轮实现指令后使用 executing-plans；确有独立任务时可使用 subagent-driven-development。复选框只记录后续实际完成情况，不因文档或原型存在而勾选。

**状态：2026-11-08，用户已认可下述产品方向；本文已完成源码核对、离线接缝探针及多视角独立审阅，并按发现修订闭合。用户随后授权按照本文开始施工；本地实现和验证进行中，未替换全局安装或发布。** 上一轮项目 Team GUI 的完成事实保留在[上一轮施工文档](TEAM_WORKSPACE_IMPLEMENTATION_PLAN.md)及 [VALIDATION.md](../../VALIDATION.md)，不能替代本轮验收。

**目标：** 提供可双击使用的桌面 App；保留珍珠白玻璃方向，改善控件与阅读层级；消息头显示真实用时；GUI 只有一个项目对话入口，简单问题主模型直接回答，需要时评审或开展正式项目工作；内置 doc-maintenance 与 context-management，并实现可检查的上下文整理和恢复。

**架构：** Electron 负责窗口和系统入口，随包独立 Node 进程运行原本地宿主，React 继续使用既有 HTTP/SSE。统一项目会话复用 Pi、请求记录、PROJECT 调度及 agent-sync；资源、预算和上下文由宿主落实，Skill 提供方法。保留一套模型调用实现，不重写整个 CoThink。

**技术栈：** 现有 React/Vite、JavaScript、Node、Pi SDK、node:test；新增 Electron 与官方 `@electron/packager`，具体发行版本在 D0 核对官方来源后锁定。首个桌面候选按当前 macOS ARM64 环境交付，保留 Windows 接口与构建边界，跨平台结果分别验证。

## 1. 与用户已确认方向逐项对齐

| 已确认要求 | 本轮明确交付 | 不算完成 |
| --- | --- | --- |
| 界面仍不好看，需要继续改 | 珍珠白阅读面、局部玻璃、轻量控件、原生窗口层级；真实长答复和文件任务对照检查 | 只改变透明度或移除浏览器地址栏 |
| 最终做成 App，现在开始 | 双击启动、独立窗口、数据根复用、系统目录选择、关闭和退出规则、本地安装候选 | 手动先启动网页服务，再打开一个空壳 |
| 图中的品牌／模式组合换成用时 | 回复头只保留本轮真实用时与必要状态，取消虚线头像和重复 CoThink／单多模型标签 | 用页面停留时间计时，或删掉失败／未知状态 |
| GUI 无 ONE／CoThink／PROJECT 模式选择 | 一个统一项目会话入口，同一主请求直接答／请求评审／提出工作 | 只隐藏下拉框，后台仍固定三次或永久 singleModel:true |
| 简单问题直接回答 | 无工具的快答自然一调用；读技能或材料的同模型续答如实计数，无额外分类请求 | 每句话先写项目计划、要求“开始”或初始化 Git／Docker |
| 复杂任务可协作 | 需要文件工作时接入正式 PROJECT；评审、岗位、预算、检查、取消和结果都真实关联 | 用旧普通工作冒充正式 PROJECT，或模型自己决定拥有权限 |
| 内置两项 Skill | 固定版本资源、按需读取、可禁用及显式替换、离线可执行的必要工具 | 复制 SKILL.md 就宣称能力齐全，或自动读取整份 Codex 技能库 |
| 真正管理上下文 | 可追溯检索、按引用读取、派生记要、用户单次触发整理、可靠应用与恢复 | 让 Skill 口头声称“已压缩”，或静默删历史 |
| 局部增量并保留基础 | 复用认证、Pi 会话、请求政策和 agent-sync；CLI 原模式保留 | 新数据库、第二套模型 HTTP、通用工作流／主题／技能平台 |

本轮最终范围必须覆盖表中全部交付。D1 桌面试用版是可检查的中间里程碑，不能因为窗口能打开就跳过统一会话和上下文部分。

## 2. 当前事实与最重要的接缝

核对对象为已完成上一轮 GUI 的 `0.8.13-project.1` 工作树，不以版本字符串断言与任意安装包相同。正式开工前按项目约定检查变化文件并解释 Git 操作，保存源码／SDK／资源构建摘要，保留已有未提交成果。

| 当前事实 | 本轮处理 |
| --- | --- |
| `gui-server.js` 支持 `port:0/open:false`，返回 URL、token 和 close | 桌面复用它，通过专用 IPC 就绪握手取得地址，不解析普通 CLI stdout |
| `process.execPath` 用于 helper／handoff 派生 | 首版随包独立 Node，避免把 Electron 可执行文件当 Node |
| GUI 提交仍走 one/cothink 的 runTurn | 新 GUI 引入统一 flow；原 singleModel 耦合只留给旧 CLI 行为 |
| projectChat 会把普通文本转为计划或目标修订 | 不直接用它接管 GUI 自然语言；从 project.js 抽程序入口，保留 CLI 包装 |
| PROJECT 从全局最近阵容取 nextConfig，命令 ID 每次随机 | GUI 执行改用根任务冻结配置和稳定操作 ID |
| workspace 是 UUID，PROJECT／agent-sync 按 Git common-dir 定位 | 导航身份与正式执行绑定分开，不为每个 worktree 新造正式 ref |
| finalText 在本 task 请求中查 finalCallId | 根任务引用子交付须经过归属验证，不能把子 call ID 填进根字段 |
| 技能资源挂在 work.skillResources | 升为任务通用资源记录，兼容读取旧位置，不能为读 Skill 伪造 work |
| SDK 有手动 compact，CoThink 自动 compact 关闭 | 增加受控手动入口；来源、预算、取消与应用前检查由宿主负责 |

本轮规划期间使用现有 createRuntime、request-policy、锁定 SDK、临时文件和 localhost fixture 做了七个上下文场景探针：正常整理一次请求、split-turn 两次、503 不重试、task.cancel 取消、裸调用分支漂移反例、提交守卫正常路径、守卫拒绝分支漂移。原 entries 均保留；裸调用确实可能把摘要应用到错误分支，守卫在 append 前拒绝了该反例。最初“一次请求”的种子实际触发两次，原错误预期保留。

本地证据：`work/gui/desktop-unified-planning-20261108/compact-probe*.json`、`.log` 和脚本。它不是产品修改或真实模型验收；摘要质量、真实费用、writer 丢失、跨进程竞争及 Windows 尚未验证。

随后增加第八个真实文件故障反例：摘要请求成功后，临时会话路径上的真实追加报 EISDIR，内存已新增 compaction 并推进 leaf，原历史备份字节不变，现有 sessionWriteIncomplete 返回 true。这验证了“写入不确定即隔离 runtime”的必要性，不证明产品已实现恢复。证据在同目录 `compact-write-failure-probe.json/.log`；未模拟磁盘写一半、断电或 Windows。

## 3. 只增加有明确职责的边界

```text
Electron 窗口 ──原 HTTP/SSE──┐
浏览器调试入口 ────────────┴─ GUI 控制器
                              │
                              └─ 统一项目会话协调
                                   ├─ 原 runTurn / Pi / request-policy
                                   │    ├─ 直接答复
                                   │    ├─ 只读材料与 Skill 工具
                                   │    └─ 独立评审 → 主答修订
                                   └─ PROJECT 程序入口 → 原调度与 agent-sync

桌面 IPC：仅启动握手、目录选择、窗口与退出协调
上下文与 Skill：复用 Pi 历史、任务记录、冻结资源及现有请求政策
```

| 位置 | 唯一责任 | 为什么不能仅在 GUI 处理 |
| --- | --- | --- |
| 新 `desktop/main.cjs` | 窗口、单实例、所属后台进程、系统退出 | 浏览器组件不应管理宿主进程 |
| 新 `desktop/preload.cjs` | 暴露少量明确系统能力 | 不向 renderer 暴露通用 Node／shell／任意 IPC |
| 新 `desktop/host.mjs` | 就绪／关闭协议，启动本地服务；干净入口准入 | 不复用会打印 token 的 CLI 输出作协议 |
| 新 `scripts/pack-desktop.mjs` 与桌面打包配置 | 组合现有后台候选、平台 Node、桌面壳及清单 | 用户机器不应在首次启动时安装依赖 |
| 新 `src/project-turn.js` | 根任务生命周期、行动请求、执行引用及根预算 | 模式消失后，执行选择、取消和恢复仍须真实可控 |
| 新 `src/builtin-skills.js`、内置资源目录 | 固定内置目录、禁用／冲突处理与分发来源 | 不依赖本机 Codex 路径，也不另建技能注册平台 |
| 新 `src/context-management.js` | 受控检索、来源记要、单次整理及应用守卫 | Skill 文本无法保证历史、分支、预算和原子应用 |
| 原 `discussion.js`、`pi-runtime.js`、`request-policy.js` | 唯一模型生命周期与实际发送 | 复用原适配、认证、用量和未知请求规则 |
| 原 `project.js`、`project-policy.js` | 正式计划、权限、岗位、版本与检查 | GUI 请求只能消费现有受控执行，不能绕过内核 |
| 原 GUI 组件与 CSS | 布局、用时、操作入口及真实投影 | 模型、权限、预算不放进组件或 CSS 状态 |

不按“以后可能支持”增加 provider 注册表、路由插件总线、通用事务层、云账号或同步数据库。具体实现可在上述职责内部拆小函数；每个跨模块新增接口都必须有当前调用者。

## 4. 桌面 App 合同

### 4.1 独立 Node 与原有传输

Electron 负责窗口；后台使用应用资源内的独立 Node 和由 `pack:npm` 生成的同一个后台候选。主进程明确指定 Node 路径启动 `desktop/host.mjs`，不依赖用户 PATH、全局 cothink 或 Electron 的默认 child-process execPath。可执行／动态加载资源放在 ASAR 外。

当前本机 Node 为 `v24.19.0`、macOS ARM64。D0 从官方可获得的受支持 Node LTS 与 Electron 稳定版本选择确切版本，结合项目 engines 和实际 native/helper 检查冻结；记录下载来源、SHA-256 和 lockfile，不在用户启动时查 latest 或下载 runtime。版本变更须重验，不把本机 Node 版本存在当作官方分发已核验。

`startGuiServer({home, cwd:neutralDirectory(home), port:0, open:false, suggestedProject:null})` 继续提供同源 loopback 服务；增加显式空建议目录参数，不把双击启动的 `/` 或应用资源目录推荐成项目。启动协议如下：

```js
// 父进程只接受它实际创建的child及匹配nonce的消息；不得写入普通日志。
{ type:"ready", nonce, origin, token, backendVersion, protocolVersion:1, buildId }
// 正常退出协议
{ type:"prepareShutdown", requestId }
{ type:"shutdownState", requestId, settled:false, reason, taskRefs }
{ type:"stopped", requestId, settled:true }
```

主进程验证 origin 为该 child 的 `127.0.0.1` 随机端口、protocol/build 与包内清单匹配，再加载现有前端并消费 token。日志、崩溃报告、页面标题和错误信息均不得含 token；保留当前 Host／Origin／Bearer 和 CSP。HTTP/SSE 不改成另一套业务 IPC。

preload 只暴露 `chooseProjectDirectory()`、`onPrepareClose(callback)`、`acknowledgeClose({requestId,saved})` 和必要的只读桌面信息。IPC 同时检查所属窗口、顶层 frame、本次受信任 origin 及请求 ID；主窗口不得导航到其他 origin，新窗口默认拒绝。系统外链仅接受明确的 http/https，不把模型输出的任意 scheme 交给 shell.openExternal。renderer 保持 sandbox、contextIsolation，关闭 Node integration；模型内容和文件预览继续按不可信内容处理。

目录选择仅返回用户选中的路径，绑定仍经过现有 `inspectGuiProject`、workspace、Git／HEAD 和授权检查。用户取消对话框不改变原目录、草稿或项目。

### 4.2 进程、数据根与生命周期

- 同一个 App 第二次启动聚焦已有窗口，不启动第二个后台。数据仍使用显式 `COTHINK_HOME` 或既有默认根，不另复制历史。
- ready 的协议与 buildId 只证明本次实际启动的 child；现有 writer 不含构建身份，不能据此宣称识别了所有其他版本。首版承诺收窄为当前 App 单实例、既有会话写锁及可识别活动占用检查；发现无法证明兼容的已有占用时不自动接管。受支持的写入组合为同一新版 App／随包 CLI，旧安装写入 unified 会话不受支持，也不能声称它必定认识新标记。
- macOS 关闭窗口先刷新草稿，成功后隐藏并保留该窗口，App 与已授权的当前任务可继续；Dock 再打开恢复同一宿主。真正退出才销毁窗口，不产生新的后台任务或开机启动。
- 真正退出采用两阶段：先冻结新生成，刷新全部未确认编辑稿并请求原取消／排空；期间保留只读 API、必要取消和恢复查询。确认所属操作及后代结清后，才调用最终 close 关闭 HTTP/SSE 和退出。失败返回 settled:false 并保留／恢复核对窗口，不能仅保留一个已断线的页面。
- renderer 崩溃只保证宿主已保存的草稿；后台崩溃后禁新提交、保留已载入内容，用户明确重开只恢复观察和已保存事实，不重发未知任务。
- Electron 父进程异常死亡或 IPC disconnect 时，Node 宿主进入同一受控停止与保存路径，禁止新增发送及自动重启。它不能依靠父进程继续管理；无法确认的停止保留原操作未知状态，后续启动先核对，不放任无人管理的服务继续发起收费请求。
- 系统强制终止不能保证优雅退出，使用原恢复记录解释状态。不能用强制杀进程或任意加长等待来伪造“全部停止”。

`requestSingleInstanceLock` 与数据写锁分别承担窗口单实例和数据安全；不建设第二套通用进程管理服务。

控制器新增 `beginShutdown()`／`shutdownState()`，最终 `close()` 只在可结清时调用；不能复用当前先关闭服务再等待 controller.close 的顺序。关闭草稿回执与后端排空结果分别确认，renderer 自称 saved 不能代替宿主实际保存状态。

### 4.3 干净 PROJECT 入口

桌面无 TTY，不能沿用旧终端观察器的证明。统一项目会话的宿主必须从未加载第三方原生扩展的入口启动：先检查预加载环境与入口身份，再建立受管资源边界；模型工具和插件执行通过已有冻结资源及受管 PROJECT 运行端。

D1 可以承载现有 GUI；升级到统一执行时必须以新构建重启到干净宿主，不在已加载任意扩展的旧 GUI 进程里 dispose 后宣称干净。已有宿主仍有未知派生动作时按原可信交接规则处理，不能通过桌面包装绕过。独立 Node 只保留原运行前提，本身不是隔离证明。

### 4.4 交付形态

首个候选为本机可启动的 macOS App。把后台代码、GUI 静态资源、选定 Node、SDK、内置 Skill 和已有必要的受管 runtime 逐项列入分发清单并核对实际字节。离线可打开、看历史、配置和使用本地资源；模型仍依赖用户原服务，文件工作仍须检测 Git、Docker、固定镜像等现有条件。

本轮不新增自动更新系统、商店发布、云账号或同步。签名、公证、正式发布及 Windows 实机在相应条件具备后单独计证；本地未签名试用不能写成公开分发完成。

App 使用 CoThink 的窗口标题、最小应用／编辑菜单和可辨认的 Dock 图标，不以默认 Electron 标识交付。图标优先复用已有品牌资源；没有可复用文件时，D1 提供与白色界面一起检视的简洁本地图标，放 `desktop/assets/`，不另建图标系统。

现有 npm 更新通道只代表 CLI／后台包，不能在桌面壳里冒称 App 更新。桌面宿主标明安装形态，本地候选只展示本地版本和更新记录，不自动发起 npm 查新或建议用 npm 命令替换 App；浏览器／CLI 原通道保持原行为。正式 App 更新渠道留给后续分发阶段。

## 5. GUI 与真实用时

### 5.1 视觉精修

2026-11-09 用户确认紧凑侧栏视觉稿并授权 UI 局部修改，取代本节此前的[珍珠白玻璃参考](prototypes/team-workspace-pearl.html)。采用浅色一体窗口、226px 雾白侧栏和稳定正文底色，取消大面积反光、浮动卡片边界与重复品牌；既有深色偏好仍保留。

同日用户实际使用后确认[导航修正](TEAM_NAVIGATION_REFINEMENT_PLAN.md)：左栏只列项目 Team 名称及必要真实状态，放大镜紧邻“＋ 新建 Team”，不显示项目分类标题或文件夹图标。最近对话、完整历史与新建对话统一由顶部“对话”打开；侧栏移除最近对话分区及项目行悬停新建对话图标。旧无归属历史通过全局搜索继续可达。模型组合入口与弹层标题使用“阵容”，沿用双人轮廓；设置只保留左下入口。名称、按钮和位置变化不修改保存数据与底层 `team`／`workspace` 含义。导航修正已在本地源码与隔离候选实现；专项证据、完整回归及本机正式安装结果见 [VALIDATION](../../VALIDATION.md)；本次已完成用户授权的本机更新。

移除每条回复中的虚线圆圈、重复 CoThink 名称及单／多模型标签。低频操作使用轻量文字或图标，重要动作才形成按钮。输入框圆角为 26px，发送按钮保持圆形；输入区使用可控自动增长，保留清晰键盘焦点和中文组词保护。新对话提示就近放在输入框上方，不占据正文顶部。

后续 [Team 头像候选](TEAM_AVATAR_IMPLEMENTATION_PLAN.md)的回复头在真实用时之前加圆形静态角色头像，仅表示该回复的项目 Team。左栏角色悬停播放，停留 2 秒才显示 Team 名；主对话的用时、状态及模型身份说明继续沿用现有入口。

macOS 使用隐藏内嵌标题栏，保留系统窗口按钮；左侧顶部留出安全区，窄窗口的主工具栏也避让原生按钮。顶部空白可拖动，输入和操作控件不可被拖动区吞掉。正文、文件和输入区按同一阅读网格对齐；不另建主题引擎或常驻材质调节器。

### 5.2 用时的唯一含义

消息头默认呈现本轮任务用时，例如“用时 18 秒”；运行时为“已用时 12 秒”。完成、失败、部分完成、停止未确认仍分别显示，模式／模型与调用细节只在过程里查询。

复用 task 的真实 `createdAt/endedAt` 与 `elapsedLabel`。新根任务的创建时间在接受本轮、建立持久身份后记录；用时包括本轮思考、工具、评审与正式工作等待，按墙钟差计算，不把并行子任务耗时相加。取消中的任务计时到实际结清；旧记录缺结束时间显示未知，不能用当前时间补算为已完成耗时。

具体取值：正常终态用 endedAt，已确认取消用 cancelSettledAt；仍在 running/preparing/cancelling 时刷新当前已用时。stop_unknown 或缺少可信终点不能套用“已完成用时”，保留用时未确认。已有 elapsedLabel 需扩展这些状态，不能只替换标签而沿用仅识别 running 的旧判断。

需要用户确认新增授权时，本轮交付具体提议并结束为待处理状态，不把用户隔夜考虑的时间持续算进模型工作。确认／继续产生新一轮任务身份，引用原提议和正式项目状态；暂停项目也不意味着以后每轮问答都使用项目累计时长。

`session(id).turns` 必须直接携带所需时间和状态；不能只有点开某个 task 详情后才显示用时。页面刷新、切换和重开不重新起计时器。机器时钟异常或缺记录时说明未知，不伪造精度。

## 6. 统一项目会话合同

本节记录首版统一会话的准入与路由。继续设计组团时，采用[当前设计基线](../../DESIGN_BASELINE.md)的岗位和调度约定。下列历史用例用于解释既有实现和任务记录。

### 6.1 一个根任务，按需使用已有能力

GUI 无模式选择器，也不常驻“PROJECT 模式”文字。新的自然语言提交走 `runProjectTurn`；它复用 runTurn 的主答、评审、修订和请求政策，实际文件工作只消费正式 PROJECT 程序入口。

```js
runProjectTurn({
  home, workspace, mainRuntime, input,
  frozenConfig, frozenConstraints, budget,
  taskId, submissionId, confirmedOperation, signal, onProgress
});
```

这个函数拥有根任务的协调，不另发一套 HTTP。`discussion.js` 提取或参数化已有阶段，使旧 CLI 默认行为与新 flow 共用同一模型实现；不得复制整份 runTurn。一个根任务只调用一次现有任务工厂：runProjectTurn 向 runTurn 传稳定身份、unified flow 与工作交接回调，由后者创建／保存根 task；回调在同一任务完成前等待项目操作并返回交付引用，不能外围先建 task 再让 runTurn 创建第二份。

| 首轮结果 | 宿主行为 |
| --- | --- |
| 自然语言完整答复 | 没有必需评审时直接交付；不建 Git 项目、容器、岗位或 JSON 计划 |
| 调用 `request_review({reason,draft})` | draft 是本轮主模型产生的自然语言初稿，宿主绑定真实 call/toolCall ID 后冻结；复用 review→revision，不能虚构评审确认最终稿 |
| 调用统一版 `start_work` | 携带具体动作和计划材料／已保存引用，先保存意图，交回宿主核对后进入正式 PROJECT |
| 读取技能／历史材料 | 使用受控只读工具后继续同一主模型，实际调用计账，不额外分类 |
| 询问原因、进度或讨论方案 | 读取已授权状态并回答，不清除待确认计划、不自动 revise 目标 |

`request_review` 必须绑定本轮已保存的非空初稿，模型只提供正文和理由，不能填写或冒认来源身份；初稿可从真实工具参数冻结，不要求重复在正文输出一份。没有可评审初稿时返回具体缺口，不捏造通过。用户要求必需评审时，即使主模型直接输出答案，宿主也把该答复作为冻结初稿，在完整交付前完成合法评审。两种情况共用原 reviewMaterial/revisionMaterial 和调用实现。

一个根轮次最多接纳一个终结性路线选择：读取可以先行，之后选择评审或正式工作。接纳时先保存意图；同一 toolCall／已保存意图重复调用查询原结果，第二个冲突选择拒绝，不覆盖 proposal/projectOperation、不启动第二份工作。评审后修订交付，工作内的多步和评审由正式计划承担；不增加路线队列或分类调用。

拆开旧 `singleModel` 的两项耦合：问答是否必需评审与工作能否委派不再由同一布尔值决定。新 flow 不能固定 singleModel:true，也不能继续用 ONE 的一次请求硬限去阻止技能读取后的正常续答。无工具的简单问题自然一调用；有工具时按冻结预算如实计数。

### 6.2 最小任务约束与授权来源

```js
{
  readOnly: false,
  allowedSubtasks: ["review", "work"], // work涵盖正式成员、插件助手及后代
  requireDifferentModelReview: false
}
```

默认值表示“不施加这项额外限制”，不授予文件或外部权限。实际能力始终为：已有明确授权 ∩ 本条约束 ∩ 执行者范围。

可信来源是“+”菜单里的本条约束、仍有效的项目授权和用户明确确认的修订。原始用户输入逐字保留并随交接传递；有限原文识别可保守收紧“只分析不修改”等明确要求，但不宣传为任意自然语言的可靠编译器。首轮模型可进一步收窄能力，不能为自己解锁。

- “只分析”禁止写文件、修改型 Shell／MCP／插件及后代效果，不能仅隐藏 start_work。
- “禁止委派”对应 allowedSubtasks 空数组；若用户明确允许独立评审，则只开放 review。与必需异模型评审冲突时，在受影响调用前澄清，不私自取消某个要求。
- 必需异模型评审使用可辨认的不同实际型号与独立只读会话。问答评审绑定初稿，文件评审绑定候选版本；同型号别名不能充数。
- 选中目录、启用 Skill、模型生成计划都不等于授权。已有授权覆盖的普通工作直接执行；真正增加范围、外部效果或费用权限时只确认新增部分，不要求每句话都“开始”。

程序保证结构化约束的执行，不以字段合法证明模型理解原题。真实自然语言的约束识别和路由质量须单独验收。

### 6.3 持久目标与工作请求

保留待确认提议和正式项目目标的独立性。只有显式工作／修订意图才准备计划；解释、比较和状态追问不修改已确认目标。已有目标未变化时接续原项目，修订影响目标、范围、检查、预算或独立评审要求时保存具体差异和授权来源。

工作计划沿用现有 PROJECT 必要字段，不重复调用旧 projectChat 的 JSON 规划请求。主模型首轮可以提供计划材料，宿主验证后直接复用；缺少实质信息时询问具体缺口，不能机械多发一个分类／规划请求。

统一 flow 的工具合同扩展为 `start_work({action,reason,plan?,planRef?})`，action 只允许 start/resume/revise；plan 与 planRef 互斥。start/revise 必须给出现有验证器所需的 scope、deliverables/checks 或 steps，不能只传 reason；resume 引用真实已保存计划和当前预期 revision。projectId、repo、授权及 commandId 均由宿主绑定，模型不能指定另一项目或正式 ref。旧 CLI 的 start_work 形状只在 legacy flow 使用。

根主模型通过受控 `read_project_context({operation,paths,query?,offset?,limit?})` 准备真实依据：只允许 list/read/search，在已有明确只读授权范围内读取固定版本，不执行模型提供的命令。不进入新正式项目：未绑定执行时可用受控 Git 只读操作读取原仓库 HEAD，并注明未提交内容未纳入；已有正式绑定时读取 agent-sync 的实际正式版本。没有读取授权时先请求具体材料或范围，不猜文件和检查命令；无目录会话不开放此工具。

2026-11-08 施工接缝核对：既有 workspace、会话目录关联及 work 配置均不保存内容读取授权。D3 在现有“+”菜单增加本轮只读范围的明确选择，作为 task.submit 的独立 readAuthorization 输入；宿主核对并冻结真实目录、范围、固定版本和用户操作来源。缺省不授权，不将此字段混入仅收紧能力的 constraints，不建立全局权限注册表；该许可不授予写入、Shell 或插件效果。

需要新增授权时，将可读 proposal 保存到根 task，内容包括 action、完整计划、约束、实际目录／版本、预算及来源。`task.confirmWork({sessionId,submissionId,proposalRef})` 是明确的确认入口：proposalRef 绑定 sourceTaskId、toolCallId、planDigest、workspace 和 project revision；宿主重验这些事实后才创建新根 turn，直接执行原提议，不让模型重写已批准内容。重复确认返回同一个 consumedByTaskId，冲突或失效只展示差异，不自动新建计划。

一次性消费的顺序必须固定：持原 session writer，经源根 owner 的元数据保存入口，在 proposal 之外的 `confirmationIntent` 字段先原子预留 `{taskId,submissionId,proposalRef,budgetSource,status:"reserved"}`；proposal 本体保持不可变。然后以预留 ID 和可信 `confirmedOperation` 调用 runProjectTurn／runTurn 的唯一任务工厂，跳过首次模型 prompt，仍按原分支记录本次操作。失败或重启只查询这份预留，新根存在则严格核对归属后返回，不另分额度／ID；不同 submissionId 再确认同一提议也不能产生第二根。终态源根不能再发请求，迟到保存不得覆盖 confirmationIntent。

预留成功但新根尚未创建时，重启先只读核对。用户随后明确继续，在同一 writer 下证明预留的新根 task 文件与命令均未创建／派发后，用原预留 taskId、submissionId 和预算来源补建；不能只凭列表缺失判定未创建，也不重新分配额度。无法证明则保留未知，不释放给另一确认。

confirmedOperation 使用提议冻结的阵容与资源，不改变当前对话为下一条选择的阵容。确认路径没有主模型初问，不能借此向 Pi 追加新的阵容选择或把当前另一模型的 runtime 当作已批准模型；正式子任务用冻结配置创建。要改变计划、模型或预算，应明确修订并重新绑定具体提议。

确认不会重置原用户给定的总额度。提议冻结此前已消费／未决调用和剩余额度，新根继承剩余值及来源；源根结束后不得继续发出新请求。一个提议只能被一个后续根消费，仍在运行／用量影响硬限制且无法确认时不转换。正式项目范围的预算继续沿原项目账；纯控制确认不需要再付一次分类调用。

未绑定目录的 Team 与通用对话都能快答、合法评审和读取已启用技能；没有项目文件权限，也不为了满足 PROJECT 身份创建临时 Git 仓库。当前文件工作仍要求真实支持的 Git 目录与执行环境。

### 6.4 导航身份与正式执行绑定

```js
workspaceId // 原GUI长期入口UUID
executionBinding: null | {
  projectId, canonicalRepo, commonDir, formalRef
}
```

只有真实文件工作需要正式绑定。PROJECT 与 agent-sync 以 common-dir 定位且共享同一正式 ref，GUI 中两个 worktree 仍可分别显示，但不能据此新建两条正式主线。

本轮采用保守边界：已有同 common-dir 项目而 canonicalRepo 不符时，保留答复和只读状态，明确拒绝隐式接管；不自动重新绑定或创建新 ref。跨 worktree 显式接入同一正式线属于另一个具体操作，不在本轮偷偷实现。用户必须知道实际执行在哪个目录和版本上。

### 6.5 根任务、正式操作和交付引用

根任务沿用现有 `taskId/submissionId/sessionId/branchId`，新增 `flow:"unified"` 和冻结约束；`project` 原字段仍只用于拥有合法 step／attempt 的正式子任务，不用它伪造根任务的项目权限。

调用项目执行前，先在根任务保存：

```js
projectOperation: {
  action, commandId, projectId, expectedRevision, planRef, planDigest,
  frozenConfigRef, contextRef,
  status:"intent", childTaskIds:[]
}
```

从 `runProjectCommand` 抽出 `runProjectOperation` 程序入口，接受稳定 commandId/rootTaskId、动作和已核对参数。CLI 包装继续沿原命令使用同一实现。相同操作先查原回执，不随机生成新 ID 后重放。根意图已保存、项目回执未确认时显示未知，不自动换项目或新建一次 start。

planRef／frozenConfigRef／contextRef 都是宿主生成的 `SavedRef:{taskId,field,sha256}`，field 仅允许根 task 的不可变 `proposal`、`frozenConfig`、`handoffContext` 字段。分别保存完整可读计划及其授权来源、不含凭据的实际阵容／资源配置、原题及被选历史材料与来源 ID、所用摘要身份；hash 绑定这些持久字节，不代替正文。解引用先检查根所属 workspace/session/operation、字段和摘要，不接受任意文件路径或模型自填引用。checksRef 使用 `{projectId,revision,requestId,version}`，对应原 PROJECT state.finalChecks 中的实际记录及内核检查事实。无法解引用就保留缺口，不重跑模型重建已批准内容。

每个项目 attempt 保留自身 taskId、会话、请求和正式版本，保存其 rootTaskId 归属。运行配置从根任务冻结阵容／资源生成，再叠加该步检查，不能调用全局最近阵容覆盖。未决 attempt 保留旧快照；结清后新操作才能选择新阵容。

根任务的文件交付使用带归属核验的引用：

```js
deliveryRef: {
  projectId, commandId, revision,
  sources:[{taskId, callId, relation:"owned"}], version, checksRef
}
```

sources 的 relation 为 owned 或 inherited。owned 必须属于本根操作；inherited 必须有同一 PROJECT 中已完成步骤／依赖及正式版本的来源证明，保留原 task/root 身份。childTaskIds 只记录本轮实际执行、预算与取消所属的子任务；继承旧成果不重复计费，也不能被本轮停止动作重新取消。

不得将子任务 callId 写入根任务 finalCallId。`finalGuiText`、文件列表、用量和历史恢复分别校验上述关系及固定版本。缺来源、过期或未结清时显示部分／未知。已有正式报告直接展示；没有统一报告时按步骤列实际交付，不为漂亮摘要默认追加一次模型请求。

resume/revise 不改旧 attempt 的 rootTaskId。已完成步骤作为 inherited 依赖使用；旧未决 attempt 先查询，不在新根中重发。只有证明旧意图未发送或已经结清，才能按原恢复政策结束旧尝试并建立归属当前根的新 attempt，保留原记录；如果现有恢复路径无法证明这些条件，返回具体阻塞，不能借换父 ID 继续。

根任务结束须与该操作的实际状态、交付检查和后代清理一致，不先标成功再后台等待。持久项目可以之后继续，但该根任务不能吞并其他用户提交的工作。

### 6.6 预算、停止与恢复

每个根预算覆盖该轮主答、材料读取后的续答、评审及所属子请求，按物理 requestId 去重；用户另行触发的上下文整理有自己的根和预算。正式 PROJECT 预算继续约束其执行请求；普通聊天没有 step/attempt，不能冒用 projectPolicy 的准入身份。两种范围在详情中明确。

每个活跃根在 project-turn 内建立一个 `rootOwner`，独占该根 task 的协调写入，提供 `reserveRequest/settleRequest/registerExecution/stopAndDrain`。预算 claim 和操作状态由这个 owner 的短串行队列更新同一个活对象并保存；子任务／容器不能各自读改根 JSON。根 task 的普通 save 与 owner 更新走同一保存入口，避免旧快照覆盖 claim。恢复先取得原 session writer、读取原 task 和意图再重建唯一 owner；不能同时有两个 owner。

接口参数固定为 `reserveRequest({requestId,taskId,sessionId,stageId,model,cause})`、`settleRequest({requestId,taskId,status,notSent,usage})`、`registerExecution({commandId,cancel,settled})` 和 `stopAndDrain({cause})`。前两者只接受来自受控请求链及已登记 owned task 的事实；实际用量以请求 journal 为准。每个队列临界段只做同步读／变更／原子保存，不跨网络或模型 await，不让普通 task.save 另持一份陈旧整记录。

根 record.requestIds 仍只拥有本 task 的物理请求，不能为聚合改写来源。新 flow 的 GUI usage 投影通过 owned 子引用去重计算总调用，并同时保留本根／子任务分项；inherited 成果不计入本轮。账本 claim 是准入事实，请求 journal 是实际发送／用量事实，两者不得混成两个可独立修改的总额。

现有 GUI 的旧预算文字不是授权输入。本轮在“+”菜单增加本条可选 maxCalls 输入，经 task.submit 的独立 budget 结构严格校验；缺省为 null，不从自然语言或旧显示文字推导有限额度。新 flow 默认不偷偷设置调用数、本地超时或可省略输出额度；用户明确预算必须在每个实际发送前检查。根预算在 request-policy 的发送前准入记录 claim，正式子请求还要通过原 projectPolicy；只有两边均允许才发出。两份记录不是跨文件原子事务：中断时保守保留未决 claim，只有证明未发送才释放计数，不事后合计再声称已经限额。

runProjectOperation 接收根 owner 的受控 admission/control 句柄；项目调用及既有受管模型消息桥在真实 HTTP 前回到该 owner，并校验 task/attempt 的已保存归属。claim 使用实际 requestId，在源码和跨进程桥中是同一身份；没有可验证的根准入链就拒绝发送，不把 guard 当可选回调。

未知用量／费用保持未知。现有不能证明费用上界的硬费用限制继续拒绝，不把估价当账单，也不因为统一入口解除原限制。没有预算满足必需评审时保留已有结果并说明未完成条件。

停止根任务取消其正在执行的项目命令与所有当前后代，复用原受管停止／paused 路径，保留已接纳版本。迟到的停止请求必须核对 commandId 和 root 归属，不能暂停后来其他人的工作。停止未确认时保持相应状态和占用，不能立即开始冲突任务。

在 dispatch 之前，rootOwner 通过 registerExecution 按稳定 commandId 登记 `cancel()` 和 `settled` 依赖，并先保存依赖身份。扩展 task.cancel 的结清判断：除了原 runtimes/helperLifecycle，还必须等待该依赖及本轮 child tasks；之后才保存根 cancelSettledAt 和结束时间。仅把 signal 传入项目入口不合格，因为现有 task.cancel 不认识 PROJECT 子运行时。桌面退出复用同一 stopAndDrain，不另写一套取消语义。

断线仅恢复观察；重启按根任务、命令回执和子 task IDs 核对，未知发送不自动恢复。停止后的项目可保持 paused；新的普通问题仍能回答，不自动恢复文件执行。仍是一条活跃用户任务，运行中可读宿主状态和编辑草稿，不新增排队／多项目并行。

### 6.7 旧会话与 CLI

旧任务记录、模式、作者和验证事实不重写。旧 GUI 对话的后续新提交在新宿主中采用 unified，并在所选分支保存明确的 flow 标记；历史详情仍按当时记录显示。

同一新版包内的 CLI 保留原 ONE／CoThink／PROJECT 命令和旧会话行为。本轮不在终端重做新的交互产品：遇到已经进入新 unified flow 的会话，新版 CLI 可只读查看，继续执行明确指向支持该 flow 的 GUI；在模型／插件初始化前拒绝静默降级为旧三次或旧 projectChat。已经安装且未升级的二进制可能忽略新 custom marker，不受这项保证约束，写入新 flow 明确不受支持。D0 用已知旧版本核对实际反应并记录兼容矩阵；若不能证明拒绝，就不能写成 fail-closed 保证，也不自动覆盖全局 CLI。

这项保护也覆盖不经 Pi 会话恢复的直接 `cothink project start/resume/revise`：正式项目一旦承接 unified 根操作，保存 `entryPolicy:"unified"`，新版 CLI 的无根变更调用拒绝并指向 GUI；status／历史读取保留。GUI 调用必须携带可验证 rootOwner，不能仅因为位于同一新版包就绕过根预算。原来未接入 unified 的 CLI 项目仍沿旧语义；旧二进制不识别此字段的限制照实保留。

GUI 的旧模式命令作为本地已移除入口处理，不再暗中切回 legacy；引用／粘贴材料中的文字仍只是材料。前端只有在宿主明确支持 unified 协议时启用新发送路径，旧后端／缓存前端不匹配时提示重开，不能只删按钮掩盖不兼容。

## 7. 两项内置 Skill

### 7.1 固定来源、离线资源与启用规则

首批只有 `doc-maintenance` 和 `context-management`。放入随包 `resources/builtin-skills/`，包含主文件、必要引用、工具资源和来源／版本／hash／许可证清单。它们是现有资源发现的一个受控来源，不是新技能平台。

doc-maintenance 采用核对过的 `agent-doc-maintenance@0.1.0` MIT 来源，保留 LICENSE、NOTICE 和锁定依赖许可。改写宿主相关文字：不带开发者绝对路径或 Codex 专属工具名，不要求运行时 npm ci。构建阶段把 markdown-it、github-slugger、yaml、picomatch 等裸依赖打包进可离线执行的 checker 资源，不能假设冻结器会追踪裸包 import。

新统一路径默认启用两项；旧 CLI 保持原显式资源选择，避免偷偷改变旧一／三次调用合同。用户可通过现有配置／设置禁用内置项；如需同名替换，明确禁用内置项后启用外部来源，仍启用的两个同名来源继续报冲突，不按路径顺序猜优先级。

配置字段固定为 `piResources.builtinSkills:{disabled:[]}`，disabled 只接受这两项规范名称、去重后的字符串数组；缺字段表示统一入口默认启用两项，不改变 legacy 入口的原资源默认。设置保存仍走现有配置锁、校验和明确成功回执；未知保存读取核对，不重新写另一份用户偏好。禁用 Skill 指导不等于删除已有历史或关闭宿主的核心历史读取能力。

配置禁用表示不进入可用目录；frontmatter 的 disable-model-invocation 继续表示只允许用户显式选择，两者不混淆。模型或项目材料不能自行启用被禁用资源。

### 7.2 目录按需读取与记录

新统一任务首先只携带可用技能的名称、描述、版本、限制和冻结引用。`read_skill` 只读已经冻结的主文件／引用；无目录对话也能使用，但不会因此获得任意宿主文件或原生插件工具。

把新任务资源 manifest 提升到通用 `task.record.skillResources`，所有消费者通过一个 accessor 读取；旧 `work.skillResources` 只做兼容来源。两处同时存在且冲突时拒绝，不悄悄选择一份。读技能不创建 work 字段、不初始化项目。

根任务、评审与所属执行成员使用同一冻结版本；恢复未决工作不回源刷新。读取和脚本执行各自记录真实来源，不能把“已提供／已加载”当作“已使用”。模型与设置里的能力清单来自宿主，区分技能、工具和实际权限，避免再把 start_work 当成全部 Skill。

doc-maintenance 只在文档或影响用法／接口／配置／行为的修改中展开。`check`、`confirm`、`run` 的读写与执行性质保持区别，checker 在受管副本中使用；Skill 不自行授予 shell、网络、正式接纳或发布权限。

## 8. 上下文管理是实际宿主能力

### 8.1 第一版提供什么

| 能力 | 合同 |
| --- | --- |
| `search_context` | 默认只搜索当前可见分支的用户任务、交付和可读项目事实，返回来源 ID、短片段和范围 |
| `read_context` | 通过宿主验证的引用分页读取，不返回认证、原始私有请求或任意绝对路径 |
| `save_context_note` | 将本轮决定／交接作为派生记录保存，带创建者、源任务／entry ID、分支锚点与来源摘要 |
| 能力／上下文状态查看 | 说明实际启用资源、当前摘要与估算情况，不宣称精确 token 或模型“记住全部历史” |
| “整理上下文” | 用户明确触发一次真实整理，显示会产生模型调用，完成后可追溯并继续对话 |

Skill 指导相关性、记要和何时建议整理；完整历史、来源、长度处理、预算、权限和应用由程序管理。记要和摘要均不是用户原话或授权，不覆盖当前目标、写范围、预算、正式版本和未解决冲突；这些始终来自结构化记录和原题。

不自动跨项目汇总、不扫描全部用户文件、不创建向量库。其他对话材料必须经用户明确选择或已有授权的项目材料入口，引用保留来源。旧原文继续可查；新摘要不删除原 entries。

记要使用 Pi custom entry `cothink-context-note`，包含 text、sources、author、taskId、sourceLeaf 和 sourceDigest。模型仅提交 text 与已有来源引用；其余字段由宿主核验并填入。search_context/read_context 明确检索和读取这些条目，同时保留“派生记要”标签与原文入口。没有来源的想法可以标为当前模型建议，但不能冒认已确认决定或用户要求。

### 8.2 保持自动压缩关闭

本轮只开放用户单次“整理上下文”；接近模型窗口可提示，不自动付费摘要、不悄悄截断、不触发后台记忆。普通任务内保存模型已经产生的有来源记要，不需要再发一次独立总结请求。

手动整理沿用 SDK 公开 `session.compact(customInstructions)`，经过当前 request-policy，绑定单独的 `context-summary` 阶段与真实请求记录。SDK 在 split-turn 场景可能发两次请求，UI 和预算按实际 preparation 说明，不能宣传固定一次。预算不足、失败、长度截断或未知结果不应用新摘要、不自动重试。

只有当前宿主空闲、源会话 writer 可得时才开始；SDK compact 会先 abort，不能拿它中断一个尚在执行的项目。context.organize 与 task.submit 共用同一短串行准入，一次整理创建且只创建一个 task，并占用既有 active 直到结清；其他对话可以阅读／存草稿，不能再启动第二条任务。整理是独立一轮预算和用时，不回填上一聊天根的预算。

operationId 使用客户端预先生成的 UUID，并直接作为该整理 taskId；task 记录保存 `origin:"context.organize"`、sessionId、sourceLeaf、budget、输入摘要和 sourceSnapshot。相同 ID 但任何身份或预算不一致时拒绝，不能返回另一操作造成误认。入口返回 `{operationId,taskId,status}`，task.cancel 和恢复查询明确作用同一记录，无需新上下文数据库。

先刷新源会话完整草稿，再保存整理意图与来源快照。整理期间冻结该会话的分支／模式／阵容／持久编辑操作，本机新输入可以保留为未保存稿；其他会话的只读和草稿不被全局长锁阻塞。

### 8.3 应用前守卫与恢复

本轮探针验证了下面的窄适配路线。正式实现放在 context-management 模块，不调用 SDK 私有方法：

```js
// 在一次受控整理中包装公开提交方法，所有出口都恢复原方法。
const original = manager.appendCompaction;
manager.appendCompaction = function(summary, firstKeptEntryId, tokensBefore, details, ...rest) {
  assertOwned();
  if (signal.aborted) throw signal.reason;
  assertSourceUnchanged(sourceSnapshot, manager); // leaf、原entries摘要与来源集合
  if (!sourceSnapshot.entryIds.includes(firstKeptEntryId)) throw contextSourceChanged();
  return original.call(this, summary, firstKeptEntryId, tokensBefore,
    {...details, cothinkContext:{...sourceSnapshot.provenance,
      requestIds:task.requests().map(r => r.id)}}, ...rest);
};
try { return await session.compact(instructions); }
finally { manager.appendCompaction = original; }
```

`sourceSnapshot.provenance` 保存整理 taskId、源 sessionId、整理前 leaf、覆盖范围／摘要和实际 requestIds，不保存权限替代品。守卫必须在真正 append 之前执行；事后发现错分支再回滚不合格。

整理结果完整且来源仍匹配，SDK 追加有效 compaction 并核对真实文件后才供后续上下文使用。来源改变时拒绝追加，保留当前分支，不强行退回旧 leaf。取消、503、未知发送不追加有效摘要，已产生请求仍如实计账。

持久化失败单独处理：SDK 会先修改内存 entries/leaf 再写磁盘，append 抛错或读回不确定时，holder 立即不可继续，不能只恢复包装方法后从该内存投影生成。保留原文件、坏尾部及内存恢复材料，用 sessionWriteIncomplete 和严格 JSONL／身份／来源核对确认实际状态，再公开 open 重建可信 runtime；无法确认就保持未知。不能自动删除尾部、覆盖文件或回滚后来分支。

重启时根据原整理身份、请求和 compaction 记录查询状态，不再发一次摘要“确认是否成功”。无法确认追加是否完整时不把它标成已应用。查看整理前原文使用现有树／分支读取；如需沿旧上下文继续，使用原有受支持的历史回复分支入口，当前会话、摘要与后来消息全部保留。本轮不新增语义不清的原地“撤销摘要”按钮。

## 9. 接口、持久字段与兼容规则

下面为本轮新增合同，尚未实现；名字在各任务间保持一致。

| 接口／字段 | 责任 |
| --- | --- |
| `runProjectTurn(options)` | 接受一个根 GUI turn，复用原请求／阶段与正式执行；返回根 task |
| `runProjectOperation({home,cwd,action,commandId,rootTaskId,expectedRevision,providedPlan,frozenConfig,contextRef,rootOwner,signal,onProgress})` | PROJECT 的程序入口，先查原稳定回执，再决定执行；GUI子请求必须带根owner准入，CLI沿原入口使用同一底层调度 |
| `rootOwner.reserveRequest/settleRequest/registerExecution/stopAndDrain` | 唯一根记录写者；保守记账、登记停止依赖及等待结清，子任务不直接改根JSON |
| 根 task `flow/constraints/projectOperation/deliveryRef` | 只保存新增协调事实和引用，不复制子请求正文或正式版本数据库 |
| 子 task `rootTaskId` | 根预算／取消／交付聚合依据，创建和恢复都由宿主验证 |
| `getTaskSkillResources(task)` | 新通用 manifest 与旧 work manifest 的唯一兼容读取位置 |
| `resolveBuiltinSkills(config)` | 返回启用的随包资源与诊断，合入原发现／冻结路径 |
| `getSessionCapabilities(sessionId)` | 供主模型和设置读取真实资源、工具、权限及环境缺口，避免自述猜测 |
| `organizeContext({sessionId,operationId,sourceLeaf,budget,signal})` | operationId即整理taskId，占用原active；一次明确整理，返回相同身份与状态 |
| `readContextOperation(operationId)` | 只读恢复入口，不能偷偷重新开始整理 |
| `beginShutdown()/shutdownState()` | 冻结新生成并排空，读查询仍可用；结清后才最终close，不将断线当停止 |
| `session`/`task` 投影 | 用时、根子归属、deliveryRef 对应内容、能力与整理状态；不再把新 flow 映射成旧“多模型三次” |

HTTP 扩展沿现有约定：`capabilities` 只读接收 sessionId；`context-operation` 只读接收 operationId；action `context.organize` 接收 `{sessionId,operationId,sourceLeaf,budget}`，相同身份／输入才返回原状态，取消仍走对应 task.cancel；action `task.confirmWork` 绑定第 6.3 节原提议。原 `task.submit` 增加本条 constraints 与独立 readAuthorization，宿主验证来源及权限上界后冻结；不允许浏览器指定子 task、正式 ref 或伪造根执行绑定。

新增操作沿原 API 白名单、版本校验和错误传输，不能仅在按钮处禁止。`bootstrap` 增加协议／能力版本用于新旧前端判断；不把 app buildId 或资源摘要当模型必须填写的字段。

会话记录保存 unified flow 标记，原模式和历史仍可读；不批量迁移所有旧会话。同一新版包的 CLI 对无法执行的新 flow 明确只读，禁止忽略字段后按旧模式重发；未升级二进制的限制按第 6.7 节说明，不虚构兼容保证。来源、权限、预算、资源和实际执行版本按任务冻结，后续偏好只影响新任务。

## 10. 施工顺序与任务

构建命令固定为以下职责，具体脚本随对应任务添加，当前不执行不存在的命令：

```json
{
  "desktop:dev": "electron desktop",
  "build:skills": "node scripts/build-builtin-skills.mjs",
  "pack:desktop": "node scripts/pack-desktop.mjs",
  "test:app": "node --test --test-concurrency=1 test/desktop-*.test.js test/unified-*.test.js test/builtin-skills.test.js test/context-management.test.js"
}
```

`pack:desktop` 复用一次 `pack:npm` 的后台产物；后者在 D5 后显式构建 Skill 和 GUI，不依赖被关闭的 npm 生命周期脚本。桌面配置固定为 `desktop/packager.config.cjs`，Node 下载版本／来源／摘要固定为 `desktop/runtime-manifest.json`；它们是打包输入，不保存用户路径、认证或运行 token。

### D0：冻结真实起点与高风险接缝

**文件：** 本文、`package.json`、已有 pack／fixture 入口；证据放 `work/gui/desktop-unified/`，不在仓库保存凭据。
**输入：** 已完成的 Team GUI、官方 Electron/Node 资料、本轮探针。
**输出：** 具体工具链锁定、分发清单、当前能力／未验项及后续测试输入。

- [x] 检查工作树变化、运行服务和候选来源，按当次 Git 约定建立隔离施工位置；不覆盖上一轮未提交成果。
- [x] 锁定 Electron、打包工具、目标平台 Node 及 SHA，核对项目 engines、原生依赖和 helper 的 process.execPath；记录 buildId，版本号不作为唯一身份。
- [x] 以已知旧二进制和本轮新版入口核对 unified 标记的实际反应，固定兼容矩阵；旧版本无法证明拒绝写时明确不支持，不通过新 marker 冒称强制隔离。
- [x] 复读本轮上下文探针，保留裸调用漂移反例及首次错误预期；将所需反例纳入后续产品测试，不运行外网模型。
- [x] 固定真实入口的素材：短问答、长答案、文件工作、两条不同阵容对话、暂停项目、只读限制、待确认权限和历史分支。

D0 实际证据：`work/gui/desktop-unified/D0-report.md`、`D0-review.md` 及 `d0-evidence/`。Node 与 Electron 完整归档均已核对官方 SHA；兼容矩阵已用真实旧／新入口核对：旧安装忽略 unified 标记且可写，同版新入口拒绝越过统一会话权限；不支持旧二进制续写。见 `D0-old-compatibility.md` 与 D3/D4 报告。

### D1：可双击的桌面试用版

**文件：** 新增 `desktop/main.cjs`、`desktop/preload.cjs`、`desktop/host.mjs`、`desktop/package.json`、`desktop/packager.config.cjs`、`desktop/runtime-manifest.json`、`scripts/pack-desktop.mjs`、`test/desktop-host.test.js`；修改根 `package.json`、`src/gui-server.js`、`src/gui-controller.js`、必要的 `gui/src/api.js`／`gui/src/App.jsx`。桌面版本从根版本构建生成，不另手工维护一条产品版本线。
**输入：** 当前 GUI/后台候选及 D0 工具链。
**输出：** 独立窗口＋所属 Node 宿主，启动／关闭协议，窄系统桥和临时安装候选。

- [x] 先验证就绪、错误和关闭握手，使用真实 child/HTTP，不用假窗口冒充完整 App；断线不得触发写操作重发。
- [x] 单实例、bundle 内 Node 路径、随机端口、token 校验和脱敏均落实；就绪失败显示可操作错误，不能给可发送的空页面。窗口／Dock／菜单使用 CoThink 标识，桌面安装形态不误用 npm 更新指引。
- [x] 目录选择接回原检查；renderer 保持隔离，文件预览／外链无宿主能力。
- [x] 接通关闭前草稿刷新、macOS 隐藏窗口后返回、两阶段退出、保存失败及宿主／父进程崩溃路径。排空失败时读 API 和核对窗口仍可用；IPC disconnect 触发受控停止，未确认结果保留未知。
- [x] 打包后在不依赖全局 Node/cothink 的环境双击启动，检查目录、历史、认证引用和必要外部执行依赖；不修改用户全局安装。
- [x] 将 Node/后台/SDK/资源实际文件加入桌面分发核对；本阶段是桌面中间里程碑，不宣称已统一模式。

D1 本地证据：`work/gui/desktop-unified/D1-report.md`、`D1-rereview2.md`。实际 macOS ARM64 App、独立 Node、系统目录选择及 LaunchServices 启动已核对；真实 App 退出／崩溃反例 4/4、宿主 7/7 通过。仅本地未签名候选，远端认证、Windows、物理输入法与 Finder 双击仍未验证。

### D2：桌面视觉精修与消息用时

**文件：** 修改 `gui/src/features/conversation/Conversation.jsx` 与 CSS、`gui/src/Composer.js`、`gui/src/styles.css`、`gui/src/view.js`、`src/gui-projection.js`、`src/gui-controller.js`；扩展 `test/gui-view.test.js`、`test/gui-components.test.js`、`test/gui-projection.test.js`。
**输入：** D1 真实桌面窗口、珍珠白参考、真实任务记录。
**输出：** 轻量控件、可读白色材质、用时消息头和准确状态。

- [x] 移除重复回复品牌／虚线圆圈／模式标签，header 显示实际用时；将必要时间字段补进会话 turns，而不是依赖当前打开 task。
- [x] 覆盖完成、失败、取消中、停止未知、无时间旧记录和刷新；并行子任务只算根墙钟，不相加。
- [x] 调整控件层级、输入自动增长、原生拖动区及内容对齐；减少普遍硬描边，保留焦点和高对比可用性。
- [x] 在同窗口尺寸用长答复、文件成果、运行态和弹层对照检查。玻璃降级、中文输入和窄窗口不损失操作。
- [x] `node --test test/gui-view.test.js test/gui-components.test.js test/gui-projection.test.js` 与 `npm run build:gui` 通过后，另做真实窗口观察；截图存在不等于审美已符合。

```js
// 在既有用时测试中使用真实字段语义，不依赖组件内部类名。
assert.equal(elapsedLabel({createdAt:"2026-11-08T00:00:00Z",endedAt:"2026-11-08T00:00:18Z",status:"completed"}), "18秒");
assert.equal(elapsedLabel({createdAt:"2026-11-08T00:00:00Z",status:"completed"}), "用时未知");
```

D2 证据：`work/gui/desktop-unified/D2-report.md`、`D2-review.md`、`D2-app-visual.json`。相关四组 83/83、最终指定三组 49/49、实际候选生命周期 4/4；13 组窗口截图含真实接纳文件。原生拖动前后坐标证据及物理中文输入法候选选择仍由 D7 单列，不能用 CSS／合成事件代替。

### D3：统一主会话与可信约束

**文件：** 新增 `src/project-turn.js`、`test/unified-turn.test.js`；修改 `src/discussion.js`、`src/extensions/cothink.js`、`src/task.js`、`src/pi-runtime.js`、`src/request-policy.js`、`src/gui-controller.js`、`src/gui-server.js`、`src/conversation.js`、`src/cli.js`、`src/interactive.js`、`gui/src/Composer.js`、`package.json` 和分发测试。
**输入：** 现有 Pi 主会话、完整用户输入、冻结阵容、资源和可信约束。
**输出：** runProjectTurn、统一 flow 标记、直接答／评审／工作意图，CLI 明确兼容边界。

- [x] 用 localhost fixture 检查无工具短问答恰好一请求、无额外分类、无 Git/项目初始化；合法工具续答不被旧 ONE 上限截断。
- [x] 参数化原问答阶段，拆开是否必需评审与委派能力；结构校验仍做，未使用的评审角色可用性在实际调用前校验，缺必需角色不可降级。
- [x] 工作／评审工具仅提出意图，保存后由宿主分派；普通解释与状态提问不清计划、不 revise。禁止把 start_work 的旧 mode=work 分支误导到普通 runWork。
- [x] 同一回复给出多个 request_review/start_work 时，只接纳一个终结性意图；重复查询原结果，冲突不覆盖或启动第二份工作。
- [x] 接通受控只读准备、统一 start_work 完整计划参数及 task.confirmWork；未知／重复确认核对同一提议，新根继承剩余额度，确认不重规划、不重置预算。
- [x] 两个 submissionId 同时确认、预留成功但新根未创建即中断，都只得到同一预留根；用户明确继续且证明未派发时可用原ID补建，不能永远卡在reserved。确认使用提议阵容，不改下一条对话配置；proposal hash 保持不变。
- [x] 在实际动作和派生请求处落实只读、allowedSubtasks、必需异模型评审，原题和来源保留；引用材料不能解锁。语义不确定只澄清受影响动作。
- [x] 干净入口在第三方 import 前成立；新旧协议不匹配、旧已加载宿主、未知旧派生状态不能通过隐藏 UI 绕过。
- [x] 最后再移除 GUI 模式控件／快捷键和旧模式命令入口；旧 CLI 路径继续各自约定，新 flow 的旧入口继续行为按第 6.7 节处理。
- [x] 新模块进入根 package.files，新增 `test:app` 覆盖本轮 desktop/unified/context/builtin 测试；原核心与 GUI 测试入口继续保留。

D3/D4 组合证据：`work/gui/desktop-unified/D3-D4-report.md`、`D3-D4-rereview2.md`。源码与真实 localhost/Git/Docker/浏览器路径通过限定审查；取消准入、晚登记、必需评审与未发送子记录收尾反例已修复。最终 App／全量安装组合仍归 D7，真实模型语义与费用不由 fixture 推断。

### D4：正式 PROJECT 接入、根子账与恢复

**文件：** 修改 `src/project.js`、`src/project-policy.js`、`src/project-staff.js`、`src/project-turn.js`、`src/task.js`、`src/presentation.js`、`src/gui-projection.js`、`src/gui-files.js`、`src/gui-controller.js`；新增 `test/unified-project.test.js`，扩展已有 `test/agent-sync-project*.test.js` 的相关场景。
**输入：** D3 根意图、已确认项目授权、冻结配置、contextRef 和稳定 ID。
**输出：** runProjectOperation、正式执行绑定、deliveryRef、发送前根预算与原项目预算、整根停止及恢复。

- [x] 抽出稳定程序入口而不复制调度器；命令回执必须使用调用方 commandId，未知根意图只查询原回执。
- [x] 首次真实工作才绑定 projectId/commonDir/formalRef；无目录仍能问答。同 common-dir 不同 repo 的冲突真实拒绝，不制造另一正式线。
- [x] 正式接入时记录 entryPolicy；新版CLI直接项目变更不能以缺少rootOwner的旧参数绕过准入，原未接入CLI项目仍可按原方式工作。
- [x] 改 nextConfig 消费根冻结阵容／资源，未决 attempt 保持旧快照；子任务保存真实 rootTaskId 和版本。
- [x] 根owner统一 reserve/settle 与保存，根／项目双重发送前准入覆盖并发竞争、claim 中断与 not_sent 证明；子进程不得自己改根JSON，按 requestId 去重，未知费用不补零。
- [x] 根最终内容与成果从经过归属校验的 deliveryRef 读取；区分 owned 与 inherited，前一轮完成的步骤不改父身份、不重复计费。缺引用／失败／部分结果保留，不能偷用另一任务 finalCallId。
- [x] dispatch前登记cancel/settled依赖，根取消及桌面退出等待所属操作与后代。晚到停止不影响后来操作；恢复不换 commandId，旧未知attempt不改父身份，暂停后的普通问题不自动resume。
- [x] 复用真实临时 Git／Docker 和现有 fixture 走至少一个正式修改、检查、接纳、成果打开闭环；不改 agent-sync 内核。

D3/D4 组合证据：`work/gui/desktop-unified/D3-D4-report.md`、`D3-D4-rereview2.md`。源码与真实 localhost/Git/Docker/浏览器路径通过限定审查；取消准入、晚登记、必需评审与未发送子记录收尾反例已修复。最终 App／全量安装组合仍归 D7，真实模型语义与费用不由 fixture 推断。

### D5：内置两项 Skill 与真实能力清单

**文件：** 新增 `src/builtin-skills.js`、`resources/builtin-skills/doc-maintenance/`、`resources/builtin-skills/context-management/`、`scripts/build-builtin-skills.mjs`、`test/builtin-skills.test.js`；修改 `src/config.js`、`src/pi-runtime.js`、`src/skill-resources.js`、`src/context.js`、`gui/src/Settings.jsx`、`scripts/pack-npm.mjs`、`package.json`、`test/gui-package.test.js` 及许可证说明。
**输入：** 锁定来源、许可证和用户显式资源选择。
**输出：** resolveBuiltinSkills、通用冻结 manifest、read_skill、设置／模型一致的能力清单、离线 checker。

- [x] 固定 doc-maintenance 来源与改写范围，保留 LICENSE/NOTICE；context-management 用本项目合同编写，不声称来源于未核对上游。
- [x] 构建时准备裸依赖，运行时无 npm install；在干净临时安装和受管副本中实际运行 checker，检查好链接与坏链接反例。
- [x] 新资源 manifest 放通用 task 字段，所有消费者走 getTaskSkillResources；兼容旧 work 位置但不双写、冲突不猜测。
- [x] 首请求只有技能目录；按需读冻结正文及引用，无目录可用但不获文件写入／原生插件能力。
- [x] 覆盖禁用、显式调用限制、同名冲突、显式替换、缺依赖、资源变动、恢复不刷新及角色共享版本；记录真实读取，不把提供目录标成使用。
- [x] 发布清单包括技能、checker、依赖许可和摘要；能力清单不泄露凭据、原始私有请求或无权限目录。

D5 证据：`work/gui/desktop-unified/D5-report.md`、`D5-rereview2.md`。固定资源、完整许可、按需冻结读取、设置恢复及实际离线／Docker checker 已验证；所属执行者与已结束成员的能力投影已修复。修复后的整包与 App 字节和入口仍由 D7 重建验收。

### D6：上下文检索、记要与受控整理

**文件：** 新增 `src/context-management.js`、`test/context-management.test.js`；修改 `src/project-turn.js`、`src/context.js`、`src/pi-runtime.js`、`src/gui-controller.js`、`src/gui-server.js`、`gui/src/useGuiWorkspace.js`、`gui/src/Composer.js` 和分发清单。
**输入：** 当前可见分支、已有任务／项目事实、明确用户整理动作和预算。
**输出：** 第 8 节工具与 organizeContext/readContextOperation，来源受控的 Pi compaction 和恢复。

- [x] 检索默认当前分支，所有读取走验证引用并分页；来源不明／跨项目未经选择拒绝，不扫描认证或模型原始私有请求。
- [x] 记要保存为 cothink-context-note 并可被同分支检索；宿主核验来源，授权和任务约束仍从结构化记录装配，不允许摘要改写。
- [x] 整理 operationId=taskId，输入摘要相同才幂等返回；与普通提交共用 active，先保存编辑稿。建立同会话 mutation gate，其他会话可保存草稿，不长持全局 writeSelection。
- [x] 将本轮七场景探针转为产品入口验证，增加 writer 丢失、持久化失败、预算不足、旧分支恢复和重复操作查询；保护公开 appendCompaction，finally 释放守卫和门禁。
- [x] preparation 为 split-turn 时如实检查两次调用，实际请求全部进入 context-summary；503／取消／未知不得追加有效 compaction 或自动重试。
- [x] 整理前后保留原 entries、来源引用及用户约束；重启只核对原操作，原文可查。GUI “整理上下文”入口明确费用性质，自动压缩继续关闭。
- [x] 注入真实文件写失败，验证内存已推进时runtime会被隔离；严格磁盘核对之前不得再生成。不实现原地撤销，不丢弃整理后的消息。

D6 证据：`work/gui/desktop-unified/D6-report.md`、`D6-review.md`。真实 controller／HTTP／SDK 来源、预算、取消、失败隔离与只读恢复通过限定审查；源码浏览器的费用提示、完整草稿保留、重开查询和窄屏已观察。最终安装包／App 和全量组合仍归 D7。

### D7：组合验收、安装与文档交付

**文件：** 复用 `test/helpers/gui-demo.mjs`、`test/helpers/gui-installed.mjs` 和实际桌面验收入口；实现后更新 README、CHANGELOG、VALIDATION、设计与本计划状态。
**输入：** D1—D6 的实现与固定构建清单。
**输出：** 完整桌面候选、真实入口证据和准确的未验范围。

- [x] 运行 `npm test`、`npm run test:gui`、新增 `npm run test:app`、`npm run build:gui`；有新失败就定位修复，不用旧全绿替代新结果。
- [x] 打包实际候选到独立目录，核对 Electron／Node／后台／SDK／GUI／Skill 字节；在没有开发 node_modules 或全局 cothink 的条件下打开。
- [x] 在真实桌面窗口完成第 11 节路径，保存默认、长答案、运行、文件、弹层和降级对照。浏览器 fixture 不代替 App 生命周期，App 启动不代替正式文件执行。
- [x] 物理中文输入法、Windows、签名／公证和真实模型语义按实际证据单列。真实模型验收沿当次模型与预算授权，不从离线 fixture 推导质量或费用结论。
- [x] 文档仅将实际完成能力写入 README/VALIDATION；doc-maintenance 检查链接、来源和状态。未提交／发布／替换全局安装时如实说明，不自动进行。

D7 本地交付证据见 D7 验收报告（本机 `work/gui/desktop-unified/D7-report.md`）。核心480通过／4平台跳过、后续SDK分支修复专项83/83、GUI158/158、App组合73/73与真实窗口矩阵按各自输入摘要记录；设置页脚文案后另做组件1/1及最终新候选smoke。最终App和同内容consumer均已核对；原生拖动、物理输入法、Windows、收费模型和签名／公证仍按报告单列，不由勾选推断已验证。

## 11. 覆盖矩阵与反例

| 核心路径 | 可检查的通过标准 | 归属 |
| --- | --- | --- |
| 双击 App → 打开历史 | 无手动网页服务、无用户 PATH 依赖，数据根正确，重复启动无第二宿主 | D1/D7 |
| 关窗再回来／真正退出 | 草稿保留、当前任务语义明确；保存失败不丢稿，停止未确认不假成功 | D1/D7 |
| 消息头用时 | 无重复品牌／模式标签，结束时间固定；旧未知、取消中、刷新和并行均正确 | D2 |
| 无目录短问答 | 通常一主请求，无分类、计划、Git、容器或默认评审 | D3 |
| 读取 Skill 后答复 | 只读冻结资源、实际续答计数，不伪造文件工作或全量预载两份正文 | D3/D5 |
| 必需异模型评审 | 原题＋冻结初稿或候选，真实独立身份；缺模型／预算不能跳过 | D3/D4 |
| 只分析／禁止派生 | 实际文件、Shell、MCP、插件与后代准入都拒绝越权；引用材料不能解锁 | D3/D4 |
| 追问正在做什么／为什么 | 不清待确认计划、不修改目标；暂停项目不自动启动 | D3/D4 |
| 正式文件任务 | 根意图先保存，稳定 commandId，冻结阵容不漂移，原正式 ref 与检查保证保留 | D4 |
| 多意图／重复确认 | 一个根只接纳一个终结性路线；原提议单次预留，崩溃恢复不产生第二根或第二份剩余额度 | D3/D4 |
| 相同 common-dir 的两个 worktree | 保留两个导航入口但不伪造两条正式项目线；不符绑定明确拒绝 | D4 |
| 子任务完成与根交付 | 结果／文件引用可验证，实际请求去重计账；不能挪用子 finalCallId 冒充根请求 | D4 |
| 停止／断线／重启 | 所属后代结清、已有成果可查；晚到取消不影响新工作，未知不自动重放 | D1/D4 |
| 内置 checker 离线运行 | 固定来源及依赖完整，好／坏链接能区分；不靠本机开发依赖碰巧成功 | D5/D7 |
| 整理期间换分支／取消／503 | append 前守卫拒绝错用，不回滚后来分支；无有效新摘要、原记录保留 | D6 |
| 整理后继续与恢复 | 来源和当前约束一致，原文可读，重启查询原操作而不再付费总结 | D6 |
| 摘要已生成但文件写入失败 | 不从已污染内存继续生成；原文件和恢复材料保留，严格读回后才能重开 | D6 |
| 新 GUI 与 CLI／缓存前端 | 同包CLI对unified会话和正式项目变更均不静默降级；历史版本支持范围明确，旧历史不改写 | D3/D4/D7 |
| 白色材质与真实桌面阅读 | 无蓝底、控件层级清楚；无模糊、高对比、窄窗与输入法仍可操作 | D2/D7 |

实际模型的路由与摘要保真至少用短概念问答、带材料问题、独立评审要求、文件修改、项目追问和“只分析”的反例检查。其结果与机制测试分开，不以工具调用格式合法证明语义正确。

## 12. 依据、审查与重审信号

桌面选择依据：[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[隔离与安全边界](https://www.electronjs.org/docs/latest/tutorial/security)、[应用生命周期与单实例](https://www.electronjs.org/docs/latest/api/app)。结合现有 Node helper、HTTP/SSE 和打包入口，选择独立 Node；没有依据要求重写成 Rust／Swift 或复制业务 IPC。

本地 App 打包使用[官方 Electron Packager](https://electron.github.io/packager/main/)，避免在首次试用阶段引入商店、自动更新及复杂安装器流程；具体版本与平台字节在 D0／D1 验证。

源码依据集中在 `src/discussion.js`、`extensions/cothink.js`、`project.js`、`project-policy.js`、`pi-runtime.js`、`skill-resources.js`、`gui-controller.js` 与 `gui-server.js`。本机 Skill 来源核对只支持选定版本及许可，不证明任意第三方 Skill 可离线执行。

本方案最关键的设计检验是：主模型处理简单问题时是否确实更直接；复杂工作是否仍进入正式版本与检查；桌面化是否只增加必要系统边界；Skill 和摘要是否始终服从来源、预算与权限。若为这些目标开始复制会话、模型调用或版本库，应先收缩边界，不继续加框架。

本轮经过桌面分发、统一执行、Skill／上下文和整体架构四个独立视角审读，并对实质问题复核。主要闭合项如下：

| 审阅发现 | 已写入的修订 |
| --- | --- |
| 退出先关闭HTTP，停止失败后无法核对 | 两阶段排空保留读API；父进程断开也受控停止 |
| ready只证明自身child，却像在保证所有旧版本兼容 | 收窄支持范围，区分新版CLI与未升级二进制，保留实际兼容矩阵 |
| 首轮工作意图缺少计划／只读依据 | 固定统一工具参数、受控版本读取和可解引用的完整快照 |
| 多个终结意图可能覆盖单一操作槽 | 每根只接纳一个路线，冲突拒绝且不覆盖 |
| 确认可能重复分配任务或预算，也可能永久卡在reserved | 不变proposal＋独立原子预留；同ID工厂；证明未派发后明确继续补建 |
| 子任务预算与取消不归根owner，可能提前显示停止 | 唯一根写者、发送前双重准入、dispatch前取消结清依赖 |
| 后续交付包含前轮成果会误拒绝或重复计费 | owned与inherited分开，保留原attempt身份与版本依赖 |
| 旧CLI直接project命令可能绕开根约束 | 新版包的entryPolicy保护覆盖会话和直接项目入口 |
| 读Skill会伪造work，脚本裸依赖可能漏包 | 通用manifest兼容读取、构建时离线依赖及分发检查 |
| 整理无明确task／active，摘要可能错分支或只写入内存 | operationId=taskId占active，append前守卫，写入不确定隔离runtime后严格恢复 |
| “撤销摘要”扩大范围且可能隐藏后来消息 | 不增加原地撤销，复用已有历史读取和分支能力 |

在本轮文档核对范围内，未发现仍须先引入新框架或修改设计初衷的阻塞缺口，可作为后续施工输入。实际 App 生命周期、rootOwner 跨进程准入、并发／崩溃恢复、真实模型语义、Windows 与签名分发仍按各任务验收；文档闭合和八个离线探针场景不替代这些证据。
