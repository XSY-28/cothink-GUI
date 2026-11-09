# CoThink 项目团队 GUI 施工文档

> **导航后续修正（2026-11-09）：** [项目 Team 导航修正施工文档](TEAM_NAVIGATION_REFINEMENT_PLAN.md)承接用户对实际 App 的最新反馈，目前仅完成规划。本文保留已实施的身份、保存和验收合同，不作为恢复旧视觉或重新迁移数据的指令。

> **下一轮入口（2026-11-08）：** [桌面与统一项目会话施工文档](DESKTOP_UNIFIED_IMPLEMENTATION_PLAN.md)承接用户已认可的新方向，当前仅编写与审查。本文保留上一轮本地实施和验收事实，不将旧授权或结果扩展为新 App／统一执行已完成。

> 执行者先读[设计文档](TEAM_WORKSPACE_DESIGN.md)和[当前基线](../../DESIGN_BASELINE.md)。获得正式实现指令后，按本文件任务顺序施工；可使用 executing-plans，独立任务需要并行时使用 subagent-driven-development。下列复选框记录已取得的本地证据。

**状态：2026-11-08，项目 Team 已按本计划实施，完成本地组合检查和独立候选验证，等待最终复核。** 用户接受珍珠白原型并授权本轮本地实施与验收。通过范围见 [VALIDATION.md](../../VALIDATION.md)。

**目标：** 将 GUI 改为一个项目一个 Team 的长期入口，保持白色玻璃质感，并完成新建、接续、找回成果、换阵容、归档与恢复的真实使用路径。

**架构：** 复用 React/Vite → 本地 HTTP → 现有 GUI 控制器、Pi 会话和 agent-sync。只补 GUI 项目目录表及必要展示元数据；会话正文、任务、阵容和正式版本仍各有一个事实来源。前端不复制调度和权限规则。

**技术栈：** 现有 Node.js、JavaScript、React、Vite、CSS Modules、Pi SDK 和 node:test；沿用已安装的浏览器检查工具。不开新框架、主题引擎、数据库或状态库。

## 1. 输入与完成边界

### 1.1 采用什么，不采用什么

体验以[项目团队设计](TEAM_WORKSPACE_DESIGN.md)为准，材质以用户接受的[珍珠白原型快照](prototypes/team-workspace-pearl.html)为准。快照 SHA-256：`fc7dbd1b2f1ed6aaefdc6cb509a7f1fdfbd57b9ee67288238cb659c4f1fc8102`。快照是可检查的 HTML 参考片段，图标和预览宿主相关能力不作为产品依赖。

代码核对范围为当前 `0.8.13-project.1` 工作树。正式开工必须重新核对变化文件、基线和接口；本文不以旧提交号覆盖后续成果。所有 Git 操作依项目约定先检查变化并解释，提交与发布按当次授权处理。

| 原型表现 | 正式实现的要求 |
| --- | --- |
| 珍珠白、浅银灰、透明高光、浮动侧栏和输入框 | 提炼成少量材质 token 与组件样式，保留可读性和降级；不复制三层累加 CSS |
| 三个演示阵容 | 移动并复用完整 TeamPanel：选择、新建、参数、另存、认证及删除保护 |
| 定时生成、按文本正则判断文件任务 | 全部删除，仍由现有 runTurn／工作入口处理 |
| 小于 15 KB 才保存的预览快照 | 全部删除；成功与否由宿主实际持久化结果决定，不静默丢数据 |
| 全局“制作”标记、插入命令覆盖草稿 | 改为同一会话的编辑快照；插入保留旧内容，替换须明确选择 |
| 布尔未读、发送任意消息即清“需处理” | 改为具体结果的已读记录和真实宿主交互／阻塞投影 |
| 前端复制消息来生成分支 | 复用现有 session.fork 与 Pi 所选历史终点快照 |
| 搜索仅打开一条聊天 | 保留真实命中片段、任务与文件定位，打开归档内容不自动恢复 |
| Tweak、重置演示、模拟差异、复制弹窗替身 | 不进入正式产品；复用真实复制、成果与设置入口 |

### 1.2 全局约束

- GUI 项目 Team 的内部名为 `workspace`；模型阵容继续使用既有 `team`。不把终端 PROJECT 调度或同型号岗位系统接进本轮导航。
- GUI 仍为 ONE／CoThink，普通纯答一／三次，工作调用次数不设上限；助手和未知用量按当前基线记录。导航、命名、状态和设置不得新增模型调用。
- 一个 GUI 宿主一条活跃用户任务；草稿不排队。当前任务冻结配置，未知提交查询原标识，不自动重发。
- 项目归属不是文件授权。执行目录仍以会话内 `cothink-project` 为准；无目录对话保持中性上下文与现有问答权限。
- 保留原会话与分支、历史阵容、固定成果版本、检查和部分结果；原目录不自动覆盖，不改变 agent-sync 内核。
- 保留 loopback、启动令牌、Host／Origin、内容与路径边界。凭据和原始私有请求不送到前端；原型页面不进入生产静态入口。
- 新用户默认珍珠白；已有明确的墨色偏好可以保留。首次安装、缺少偏好或旧“跟随系统”值均落到白色，不因宿主深色主题自动变蓝或变暗。
- 文档检查、临时 SDK 探针、真实 GUI 机制、实际模型质量和物理设备分别计证。不得靠跳过环境、扩大时限或修改成功定义制造通过。

## 2. 必要性与架构选择

### 2.1 收敛后的功能范围

| 保留项 | 没有它，用户具体做不了什么 | 收缩方式 |
| --- | --- | --- |
| 独立具名 Team | 尚未发送消息的项目无法长期保留；无目录学习项目没有归处 | 一张小目录表，不建立 Agent／成员实体 |
| 空会话和完整编辑稿保存 | 重启会丢掉第一条未发送内容与本次制作选择 | 仍写 Pi 会话，不建草稿数据库或身份转换层 |
| 项目内历史与统一搜索 | 收起左栏历史后找不回任务和成果 | 共用当前搜索服务，不建第二索引或成果中心 |
| 阵容与新对话默认 | 更换模型会误改其他对话或失去项目连续性 | 复用一个面板；默认值只引用现有组合 ID |
| 已读位置、真实待处理与运行入口 | 返回时不知道哪里有新结果、什么需要处理 | 轻量展示记录加派生状态，不建待办系统 |
| 可逆归档 | 已结束项目持续挤占导航 | 保留恢复，不加永久删除或多层分类 |
| 成果／过程按需阅读 | 无法检查交付、分歧和文件来源 | 复用现有面板，不建设 IDE、多窗格或任务板 |
| 白色玻璃材质与清晰降级 | 已批准的视觉无法稳定呈现，透明效果可能遮住内容 | 一处 token、少量表面类；不做粒子、动态壁纸或主题插件 |

不追求逐像素恢复滚动位置：保存消息／任务锚点和小偏移即可。列表只保留任务标题或已有原文短摘录，不生成“智能进度摘要”。不增加自定义排序、头像编辑、批量搬运历史、多项目并行、自动记忆和自动写回。

### 2.2 两个关键取舍

**项目数据：** 将目录、默认阵容塞入现有模型 Team 会混淆身份；只按目录聚合又不能保存无目录 Team。采用独立的 GUI 目录表，记录项目入口所需的少量字段。目录表不保存聊天正文、成员任务或运行状态。

**空草稿：** 不采用“另存草稿 sidecar，首条消息时转换为 Pi 会话”的办法。它会产生两份正文、两种身份和崩溃后的搬运问题。采用 GUI 创建即写入合法 Pi 会话，再交回 SDK 追加的窄适配；纯 CLI 的空会话行为不改。

2026-11-07 已在本机临时目录用实际 Pi SDK 验证六项：原 custom entries 不落盘；原子写入 header＋entries 后公开 open 可恢复同一 ID 和草稿；零消息会话可被列表发现；后续 custom entry 能落盘；首条 user message 不重复 header／entry；目标存在时拒绝覆盖。无模型请求。证据在本地 `work/gui/team-workspace-planning-20261107/empty-draft-probe.json`；未验证控制器集成、崩溃、跨进程并发或 Windows，不能将探针当作功能完成。

### 2.3 职责与改动位置

| 位置 | 本轮责任 | 为什么在这里 |
| --- | --- | --- |
| 新增 `src/gui-workspace-state.js` | 项目目录表校验、短锁、原子更新和旧目录接入 | 项目入口须脱离会话存在，现有模型 schema 与会话展示文件均不负责它 |
| 新增 `src/gui-session-persistence.js` | 仅首次 GUI Pi 文件发布及重开 | 把 SDK 文件结构假设隔离在一处，不污染每个操作或修改 SDK 私有方法 |
| `src/conversation.js` | 读取／保存 GUI 归属和完整编辑快照，保留旧字段 | 共享入口已经拥有会话 custom entries 与分支语义 |
| `src/session-ui-state.js` | 原归档／置顶，加阅读锚点和已读记录 | 这些都是会话级展示状态，不能混入模型上下文 |
| `src/gui-controller.js`、`gui-projection.js`、`gui-server.js` | 准入、组装快照、派生状态、原传输白名单 | 保留唯一真实请求路径；不把新规则搬到组件 |
| `gui/src/useGuiWorkspace.js`、`api.js`、`workspace-view.js` | 一次发送、选择代次、草稿队列和纯显示偏好 | 不新增并行状态库或第二个请求 hook |
| `features/navigation/Navigation.jsx`、`ProjectDialog.jsx` | Team 列表、创建／绑定、对话选择与搜索 | 表单和列表留在导航职责中，App 只装配 |
| `features/teams/TeamPanel.jsx`、`Settings.jsx` | 唯一阵容编辑和已有设置；归档恢复 | 复用认证、参数、未知保存和删除保护 |
| `features/conversation/Conversation.jsx`、`Composer.js`、`Collaboration.jsx`、`features/files/FilePanel.jsx` | 输入、状态、正文、过程与成果 | 原记录投影与文件安全边界继续生效 |
| `gui/src/styles.css` 和各功能 CSS Modules | 语义 token、材质、布局和响应式 | 改颜色不改任务控制器，改布局不改数据格式 |

只新增上述两个宿主模块。导航内部的选择器与表单先作为局部组件；只有出现独立复用或明显职责分离需要时才拆文件。不将当前 1022 行控制器整体重构，也不将全部逻辑搬入新的巨型协调器。

灵活性以改动范围判断：换材质只动 token／CSS；换历史入口只动导航及其操作绑定；换模型组合仍走 TeamPanel；新增成果格式走已有文件投影。以后接入 PROJECT 可以另行增加真实执行入口，GUI 项目身份与 Pi 历史不需要因此改名。当前不预建执行策略注册表、插件槽位或通用事务框架。

## 3. 持久化和恢复合同

### 3.1 GUI 项目目录表

存放 `COTHINK_HOME/gui-workspaces.json`，沿用私有文件权限。建议结构如下；`workspace` 只在代码和诊断中使用，界面叫 Team。

```js
// 顶层 revision 用于刷新缓存；管理操作比较具体条目的 revision。
{
  schemaVersion: 1,
  revision: 4,
  workspaces: [{
    id: "UUID", revision: 1, name: "CoThink 开发",
    project: null, defaultRosterId: null,
    archived: false, createdAt: "ISO timestamp"
  }]
}
```

名称为去除首尾空白后的 1—80 个字符；ID 为 UUID。两个无目录 Team 不得使用相同名称（NFC 规范化后忽略英文字母大小写，包括已归档项），冲突时提示改名或打开已有项；有目录的重名用短目录区分。默认阵容只能是现有合法模型组合 ID 或 null，不复制组合正文。条目 ID 不随重命名或换阵容变化。

创建表单依次选择合法初值：当前对话对应的仍存在组合 → 当前 Team 的有效默认组合 → 全局最近有效组合；均不可用才为 null。表单显示所选名字，不增加必填步骤；宿主重新校验该 ID。对既有项目，null／已删除的默认不触发全局猜选，新建对话时明确选择；旧对话继续自身快照。

新绑定目录必须经真实路径和现有 Git／HEAD 检查。旧历史接入只校验已保存关联的绝对路径格式；目录已移动、不存在或不再可执行时仍保留原分组及路径，标明不可执行，不搬到通用对话。不能通过重新检查当前目录是否有效来决定旧历史是否存在。

复用 `acquireSessionWriter` 的已验证 owner 机制：目录表使用 `acquireSessionWriter(join(home,"gui"), "00000000-0000-4000-8000-000000000001")`；不要新写锁算法。条目 revision 从 0 开始，每次该条目成功管理变更加 1。写入持短锁读取最新内容，校验目标 revision 和唯一目录后，通过 `writePrivateJson` 发布，再释放；陈旧请求不得覆盖。目标 UUID 已存在时返回冲突和实际条目，不重复创建。确认丢失先按同一 ID 读取核对。

创建 Team 与创建第一条对话是两次明确结果：Team 已保存、对话失败时，保留空 Team 并就近提示重开对话，不能重新创建另一份 Team。目录绑定先检查，后保存；只有 null→目录的首次绑定进入本轮。已有目录迁移／重绑不在本轮；需要另一目录时新建 Team，旧历史继续可读。

同一有效规范目录只对应一个 Team，包括已归档 Team；重复添加显示“打开已有 Team”，已归档时仍需显式恢复。不同 worktree 不按 Git 仓库名称合并。目录异常不自动接管同名路径，不运行旧 agent-sync 项目迁移。

旧历史接入只生成 GUI 目录项：从健康会话的已保存目录关系聚合，不改 Pi 字节。无目录历史仍属通用对话；有新 `cothink-gui-workspace` 标记的无目录对话则属于具名 Team。关联损坏时显示不可确认，不用模型组合或标题猜归属。目录表损坏不重置为空：历史可读，依赖未知归属的管理及提交阻断。

### 3.2 Pi 仍是唯一会话正文来源

新增纯归属记录：

```js
// 具名Team填写其UUID；通用对话显式填写null。
{ customType: "cothink-gui-workspace", data: { workspaceId: null } }
```

通用对话也保存显式 null 标记，便于识别本轮 GUI 创建路径。`readSessionWorkspace` 对缺少标记返回 undefined（旧历史），显式 null 表示通用，UUID 表示具名归属；格式错误或引用缺失不可当作通用。执行目录只读取原 `cothink-project`。Team 后来绑定目录，为新目录另建对话；原 null 对话继续无目录权限。GUI 分支走已有 Pi 终点分支，继承所选历史的归属、目录、阵容和模式；不从当前面板状态重建。

新 GUI 创建采用 `SessionManager.create(cwd, directory, {id: sessionId})` 的公开指定 ID 能力。前端生成稳定 UUID，未知创建结果查询同一 ID。宿主先持该 Pi 会话 writer，核对 ID 不存在或已属于相同创建结果，再准备初始 custom entries、发布文件和公开重开。核对须扫描主会话目录中该 UUID 的候选文件名并严格检查 header；当前 summaries 会忽略坏 header，不能用“列表里没有”当作不存在。重复 ID、损坏头部或归属不符均保留现场并拒绝新建。

首次发布适配的核心顺序如下，正式实现还需包住路径检查、失败状态及 holder 交接：

```js
function persistNewGuiSession({manager, directory, assertOwned}) {
  const path = manager.getSessionFile();
  const header = manager.getHeader();
  const entries = manager.getEntries();
  // 调用者已确认：来自本GUI、尚无runtime、路径属于main会话目录、没有消息。
  if (!header || entries.some(e => e.type === "message")) throw Error("非新GUI会话");
  const bytes = [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n";
  writePrivateBytes(path, bytes, () => {
    assertOwned();
    if (existsSync(path)) throw Error("目标已存在，读取核对，不覆盖");
  });
  const reopened = SessionManager.open(path, directory, manager.getCwd());
  if (reopened.getSessionId() !== header.id) throw Error("会话身份不匹配");
  return reopened;
}
```

只在 `session.create` 的首次发布点使用；重开完成前不创建 model runtime。不要调用 `_persist`、改 `flushed` 或伪造 user message。文件已发布但响应／重开失败时保留已写文件和原 ID，返回可核对错误；不得换 ID 自动再做。初始之后统一使用 SDK 正常追加。

GUI 新会话因此从创建成功起属于已保存历史，即使没有消息也通过“归档”收起，不新增空文件删除特例。既有 `session.close` 继续只服务未持久化的旧空页；前端按真实 `persisted` 选择可用操作。纯 CLI 创建／退出行为保持原样。

### 3.3 编辑稿是一个会话内的完整快照

扩展已有 `cothink-draft`，默认值兼容旧的 `{text}`：

```js
{ text, workRequest: null, selectionId: null, editId: "UUID" }
```

`workRequest` 使用现有单次操作合同；选中时 `selectionId` 标识该次选择，不存全局布尔值。`editId` 识别同一次本地保存；`draftRevision` 使用最新 draft entry 的 Pi ID，没有记录时为 null，不另建计数器或草稿表。

`session.draft` 提交完整快照、`expectedDraftRevision` 与读取时的 `branchAnchor`（当时 Pi leaf ID）。在 `writeSelection` 中先核对锚点仍属于当前分支祖先，再比较 draft revision 后追加；null 锚点只在当前分支仍为空时成立。这样正常顺序追加不误拒绝，CLI 切到另一分支后的迟到保存会被拒绝。返回新 revision、editId 和当前 branchAnchor。缺少必需版本／锚点的旧 GUI 请求明确要求刷新，不能静默覆盖。CLI 的旧 draft 记录仍可读取。

前端保留现有每会话 draft book 与串行保存队列。650ms 防抖可以沿用，但保存请求使用发送时该会话最新已确认 revision；切换、归档与提交先刷新相应快照。迟到确认只确认对应 editId，不抹掉后来输入。保存结果未知先读取同一会话核对 editId；冲突保留本机文本并提供读取保存稿、明确以本机稿再保存的路径，不自动二选一。

只有宿主确认提交后才按已提交快照清理输入／选择；正在输入的下一条不清除。命令插入不覆盖已有草稿。本次操作随稿恢复，提交未确认时不得重复消费或自动发送。

### 3.4 阅读与未读复用会话展示元数据

将 `src/session-ui-state.js` 升为兼容读取 v1 的 schema 2，保留原字段及管理 revision，新增独立的阅读 revision：

```js
{
  schemaVersion: 2,
  revision, archived, pinned, changedAt, // 原管理字段，只有管理变更才递增revision
  viewRevision,
  view: {
    initialized: true,
    lastOpenedAt: "ISO timestamp or null",
    anchor: null, // 或 { taskId, part: "input"|"result", offsetPx }
    seenResults: {} // taskId → 宿主生成的resultRevision；不存正文
  }
}
```

所有该文件写入取得 `acquireSessionWriter(join(home,"gui-ui"), sessionId)` 这一个独立 GUI UI 短锁，并在锁内读取最新完整文件、只修改所属部分。归档／置顶仍须先持会话 writer；纯阅读更新只拿 UI 锁，不抢执行会话 writer。仅拆 revision 而没有共同锁，不足以防止整文件覆盖。

固定锁序：已有会话 writer → 必要的目录表短锁 → UI 短锁；读取目录表或 UI 时不得反向申请会话 writer。无相关锁时不要机械全部取得；不在短锁内等待模型、网络、runtime 初始化或界面操作。目录检查在锁外完成，发布前复核所依赖的目录表 revision。

按会话 `lastOpenedAt` 推导 Team 最近对话与排列；后台更新不改变它。锚点只绑定当前分支实际可见的 taskId 和 input/result 区域，偏移限制在该区域范围；锚点失效退到可读消息并提示。不要用不断随 draft 变化的 leafId 当阅读更新的全局准入版本。

`resultRevision` 由宿主对“结果卡可见状态、交付正文、成果版本引用及检查结论”形成稳定摘要；只取现有记录和缓存中的引用，不为此读取成果文件正文。忽略活动计时、成本刷新和纯过程日志。首次正文为空的 partial／unknown 也保留其可见状态。前端只在结果确实展示且页面可见时提交 `(taskId,resultRevision)`，不能用打开 Team 或发送消息标记整批结果已读。

新 GUI 会话的已读集合从空开始，不能因 view 文件缺失走旧历史初始化。Pi 文件先发布后初始化空 view；若第二步失败，保留已成功保存的会话，使用空已读集合并提示阅读状态暂未持久化，后续仍按同一 UI 锁初始化。凭显式 GUI 归属标记恢复空基线，不把这期间任何结果当作旧结果已读。纯阅读记录缺失不阻止合法提交；现存 UI 文件损坏、归档或归属不可确认仍须阻断相应写入，不能将损坏当作缺省值。

首次接入旧历史时，以初始化快照中已结束的结果建立已读基线，正在运行／停止中的任务不纳入；明确区分旧接入批次和本轮 GUI 创建标记，不仅按 initialized 缺失或日期推断。初始化前后变化的结果按 revision 区分；初始化失败时显示状态暂不可用，不能把全部旧历史亮成未读。成功的 GUI fork 在原操作中将所选终点已继承的结果作为基线，并补归属标记，再允许继续；若恢复时无法确认该初始快照，采用空基线并提示已读位置未恢复，不猜测所有现存结果均已读。初始化只写展示文件，不改原任务。

“需处理”只来自真实结构化交互和宿主确认的准入阻塞，例如当前 `extensionUI.prompts`、选择保存失败或提交身份不能确认。普通回复中的问句不靠关键词／模型判断分类；它属于新结果。宿主重启后，不恢复已失效 prompt 的操作按钮。已读与阻塞解除相互独立。

### 3.5 原子性的边界

| 操作 | 成功边界与失败处理 |
| --- | --- |
| 创建 Team，再创建对话 | 两次持久化；第一步成功后保留项目，第二步失败可按原会话 ID 查询／继续 |
| 切换当前阵容，同时设为新对话默认 | 先走已有切换，确认后再更新目录表；分别报告结果，不声称跨文件原子成功 |
| 绑定目录后新建对话 | 绑定成功不改变旧对话；创建失败保留绑定并展示可重开的空入口 |
| 归档 Team | 本宿主活跃任务／插件命令拒绝归档；观察到外部 writer 占用时保守提示。GUI 提交在串行准入处再次核对归档 |
| 阅读进度保存失败 | 当前阅读继续，显示保存缺口；不能阻止无关任务、伪造已读或丢草稿 |

归档是 GUI 展示和后续 GUI 提交限制，不是撤销 CLI／内核权限，也不原子证明所有进程停工。其他入口已经接纳的任务按原冻结事实继续。对目录表与会话的两次写入不引入通用事务框架；可观察的部分成功必须准确显示。

## 4. 接口与前端状态

沿用现有 read/action、SSE invalidate 和错误返回，不另造通信层。下面是本轮新增／扩展合同，不表示当前已实现。

| 入口 | 输入与输出 |
| --- | --- |
| `bootstrap()` | 原 `teams` 仍为模型组合；增加 `workspaces`、`workspaceErrors`，条目包含记录字段和派生的最近对话／注意状态 |
| `workspace.create` | `{workspaceId, name, project:null|string, defaultRosterId:null|string}` → 已保存条目；稳定 ID，零模型调用 |
| `workspace.update` | `{workspaceId, expectedRevision, change}`；change 仅允许一个 name、defaultRosterId 或 archived 字段 → 新条目 |
| `workspace.bind` | `{workspaceId, expectedRevision, path}` → 绑定后的条目；仅首次绑定，不直接创建或移动历史 |
| `session.create` | 新 GUI 使用 `{sessionId, workspaceId:null|string}`；稳定 UUID。兼容旧 `{project}` 时，规范目录映射同一 workspace 并走相同准入，null 只归通用；两种形状混传拒绝 → 完整会话投影 |
| `session(id)` | 保留 `draft:string`；增加 `workspaceId`、`workspaceArchived`、`editor:{text,workRequest,selectionId,editId}`、`draftRevision`、`branchAnchor`、`view` 与 `viewRevision`。draft 只是 editor.text 的兼容投影，不是第二份保存 |
| `sessions(query)` | 增加 workspaceId 筛选，undefined=全部、null=通用；保留 query／archived／cursor／limit 及命中 taskId、field、fileRef、snippet |
| `task(id)`／会话 turns | 增加与实际结果卡一致的 `resultRevision`；无可展示结果时为 null，运行计时不改变它 |
| `session.draft` | `{sessionId, expectedDraftRevision, branchAnchor, editId, text, workRequest, selectionId}` → `{sessionId,draft,editor,draftRevision,branchAnchor}`；字段形状与 session(id) 一致，新前端以 editor 为编辑来源 |
| `session.view` | `{sessionId, expectedViewRevision, opened?, anchor?, seen?}` → 新 viewRevision；opened 由宿主记时间，seen 每次针对具体结果 |

`workspace` 用独立 UUID；会话与 task ID 继续用原身份。目录路径和工作权限不从浏览器默认值取得。目录表 defaultRosterId 失效时，已有会话照常读快照；新对话就近选择，不自动换组合。

新操作错误使用可识别的 `WORKSPACE_CONFLICT`、`WORKSPACE_UNAVAILABLE`、`WORKSPACE_ARCHIVED`、`DRAFT_CONFLICT`、`VIEW_CONFLICT`；必须加入 `gui-server.js` 现有 code 白名单与 HTTP 409 映射，并用 HTTP 测试确认 code 没被剥掉。schema 不支持／记录损坏保留现场；不把错误转换为空列表。未知写入只读取核对，不自动发第二次。

旧 project 形状仅是同一创建函数的输入兼容，不是绕过 workspace 的执行分支。新 GUI 一律传 sessionId；旧形状不传 ID 时可由宿主分配，但未知结果也不得自动重试。已有目录 Team 被归档或目录表不可确认时，旧形状同样拒绝创建新工作。

前端状态继续分三类：服务端事实由 `useGuiWorkspace` 接收；每会话编辑／提交归原 draft book 和 pending association；主题、面板、移动侧栏归 `workspace-view`。最近对话、已读和需要持久的阅读位置不只放 localStorage。纯显示偏好损坏可回默认，事实损坏不能回空状态。

读取 A 后切到 B，迟到 A 响应不能覆盖 B；保存 A 草稿的确认也不能清空 B。新增导航命令沿用现有 request generation 和一次订阅，不让组件直接 fetch。搜索默认复用当前源和缓存，Team 名命中可以直接进入项目；文件命中仍携带原 taskId/fileRef，不新建全库文件扫描。

## 5. 珍珠白材质与可访问性

颜色集中在 `styles.css` 的语义 token，不把原型每个色值散抄到组件：背景 `#fafafa`、侧栏 `#efefed`、浮层 `#fafaf8`、正文 `#30312f`、次要文字 `#6e706c`；白色高光、浅银灰阴影。大面积表面不得再使用蓝色底光或蓝灰投影。状态颜色只服务可见文字，不代替状态说明。

采用窗口、侧栏、输入框／浮层三类表面；背景只保留一处静态透光层。默认透明与模糊参考原型，文本自身不透明。禁止嵌套多个大范围 blur 或添加持续漂浮动画；主题变量变化不触碰业务状态。

`backdrop-filter` 不可用、系统要求减少透明效果或高对比模式下，全部玻璃表面降为足够不透明的白／中性背景；包括输入框、菜单、弹窗和文件面板。降级规则在最终层级生效，不能被后续配色覆盖。不另增“玻璃强度”产品设置，原型 Tweak 不进入成品。减少动态效果时关闭非必要过渡。

正文默认 14—16px，功能文字不小于 12px；正文／次要文字在实际背景上达到 4.5:1，焦点与控件边界达到 3:1。不能用 `outline:none!important` 抹掉输入焦点。交互目标保持键盘可达，窄屏侧栏关闭时 inert，覆盖式面板管理焦点并在关闭时归还触发入口。

布局依据可用宽度而非固定 770px 画布：默认两栏；并排详情会把正文挤到约 520px 以下时改为覆盖式面板。800×600 下导航可收起，输入、当前 Team、错误与停止可达；长公式／代码在自身区域滚动。文件与过程共用按需区域，不增长持久页签系统。

## 6. 施工任务

### T1：持久的项目 Team 与旧目录接入

**文件：** 新增 `src/gui-workspace-state.js`、`test/gui-workspace-state.test.js`；修改 `src/gui-controller.js`、`src/gui-server.js`、`package.json`、`test/gui-package.test.js`、`test/gui-history.test.js`、`test/gui-server.test.js`。

**输入：** Pi 主会话摘要、已保存 project 关联、现有模型组合列表、原子写入与锁。
**输出：** `readGuiWorkspaces(home)`、`createGuiWorkspace(home,args)`、`updateGuiWorkspace(home,args)`；表结构及三类 workspace action 依第 3—4 节。绑定的规范化由控制器复用 `inspectGuiProject`，状态模块只接受已核验值并在发布前重验 revision。

- [x] 先在新状态测试中复现“没有会话就没有具名项目”的缺口；覆盖创建、重开、陈旧 revision、同目录冲突和损坏文件，不测私有 helper 调用次数。
- [x] 实现目录表与短锁，保留部分成功和稳定 ID；创建不启动 runtime，不修改原仓库。
- [x] 接入 bootstrap 与 action 白名单；旧历史按目录生成默认项目入口，不改其字节。新发现的旧 CLI 目录增量接入，重复接入不重复建项目。
- [x] 将新模块加入 package.json 的显式 files 清单，扩展 gui-package 检查；不等到可选打包时才处理必需源码。
- [x] 扩展 history/server 测试：相同阵容不同目录不合并，失效目录保留原分组，无目录历史仍可读；目录表坏了不清空历史或越过鉴权，新错误 code 经 HTTP 保留。
- [x] 运行 `node --test test/gui-workspace-state.test.js test/gui-history.test.js test/gui-server.test.js test/gui-package.test.js`，核对失败与真实修改范围。

关键外部行为测试应表达成下列含义，测试文件可复用既有临时目录生命周期：

```js
const created = createGuiWorkspace(home, {workspaceId, name:"学习", project:null, defaultRosterId:null});
assert.equal(readGuiWorkspaces(home).workspaces.find(w=>w.id===workspaceId).name, "学习");
assert.throws(() => updateGuiWorkspace(home, {
  workspaceId, expectedRevision:created.revision + 1, change:{name:"过期覆盖"}
}), {code:"WORKSPACE_CONFLICT"});
```

### T2：创建即保存的 Pi 会话与完整草稿

**文件：** 新增 `src/gui-session-persistence.js`；修改 `src/conversation.js`、`src/gui-controller.js`、`src/session-ui-state.js`、`gui/src/useGuiWorkspace.js`、`gui/src/view.js`、`package.json`、`test/gui-package.test.js`、`test/gui-controller.test.js`、`test/gui-history.test.js`、`test/gui-view.test.js`。

**输入：** 已保存 workspace、稳定 sessionId、公开 SessionManager API、会话 writer。
**输出：** `persistNewGuiSession({manager,directory,assertOwned})`、`readSessionWorkspace(manager)`、扩展的 `readConversationMetadata`；session.create／draft 的投影和版本合同。同步引入 schema 2 和 `initializeSessionView(home,{sessionId,seenResults})`，仅初始化尚无 view 的记录，已有／损坏状态不能覆盖；T3 再接通增量阅读写入与聚合。

- [x] 把本轮临时 SDK 探针转成 controller 测试中的用户路径：创建后无消息重启可见，首次草稿重启可读，随后只产生一次用户消息。
- [x] 引入 schema 2 时同时让初始化、原 archive/pin 写入使用共同 UI 短锁；管理／阅读 revision 分开，不能先发布一个混用两种锁的中间版本。
- [x] 在 runtime 创建之前完成目录／workspace 标记、可用阵容快照、首次文件发布和重开；持同一 session writer，存在文件拒绝覆盖。同 UUID 的坏头部必须阻断；保存后重开失败查询原 ID。新会话初始化空已读集合；纯阅读状态保存失败单独提示，不阻止已合法保存的会话、不套旧历史基线。
- [x] 扩展 draft 为 text＋本次操作＋editId，按分支锚点与最新 entry ID 做条件写；失败保留可恢复内容。更新旧空页关闭测试，使新持久空会话走归档，旧未持久页仍按原约束关闭。
- [x] 更新 draft book 和保存队列：确认只消费对应快照，命令插入不覆盖旧稿；修改本次操作也触发同一快照保存，不串 Team。
- [x] 复用 `session.fork`，检查归属继承与分支终点阵容；不移植原型前端复制消息。
- [x] 将首次持久化模块加入 package.json 的 files，并扩展分发测试。运行 `node --test test/gui-controller.test.js test/gui-history.test.js test/gui-view.test.js test/pi-session.test.js test/pi-modes.test.js test/gui-package.test.js`；此处以真实临时文件为准，不能用纯内存替身验证持久化。

```js
// 加入既有 gui-controller 测试；f/c/控制器生命周期复用同文件 helper。
const s = await c.action("session.create", {sessionId, workspaceId});
await c.action("session.draft", {sessionId:s.id, expectedDraftRevision:s.draftRevision, branchAnchor:s.branchAnchor,
  editId, text:"尚未发送", workRequest:null, selectionId:null});
await c.close();
const reopened = await controllerModule.createGuiController({home:f.home, cwd:f.cwd});
assert.equal((await reopened.session(s.id)).draft, "尚未发送");
assert.equal(f.calls.length, 0);
await reopened.close();
```

### T3：归档准入、默认阵容、阅读状态与聚合

**文件：** 修改 `src/session-ui-state.js`、`src/gui-controller.js`、`src/gui-projection.js`、`src/gui-server.js`；扩展 `test/gui-workspace-state.test.js`、`test/gui-controller.test.js`、`test/gui-history.test.js`、`test/gui-projection.test.js`。

**输入：** T1 目录表、T2 会话归属和草稿、既有任务卡／extensionUI／准入状态。
**输出：** `readSessionUiState` 的 v1/v2 兼容；`writeSessionViewState(home,args)`；`session.view`；workspace 注意状态、最近对话；更新后的 GUI 提交和管理准入。

- [x] 在实际临时文件中检查管理写和阅读写交错，确认 archived/pinned 与 view 都保留；旧 schema 不因只读访问被重写。
- [x] 所有 session-ui 写入统一 UI 短锁；管理 revision 和 viewRevision 分离，按第 3.4 节锁序执行。读取进度不抢其他入口的模型会话锁。
- [x] 从现有 task projection 生成稳定 resultRevision；处理首次接入／分支基线，运行中的结果不被标成已读，普通问句不推测为待处理。
- [x] 同时检查 workspace 与 session 两层归档：覆盖 `task.submit`、`session.create/fork/draft/name/mode/team/thinking` 和有副作用的插件入口；不能假定旧 session.fork 已拦住源会话归档。迟到编辑写同样拒绝。历史、文件、session.view、未知提交查询和取消仍可用；全局阵容／认证管理不因此禁用。
- [x] 当前阵容切换成功后才尝试设默认；模拟第二步失败，返回“当前已切换、默认未保存”，不回写旧任务或另一会话。
- [x] 运行 `node --test test/gui-workspace-state.test.js test/gui-controller.test.js test/gui-history.test.js test/gui-projection.test.js test/gui-server.test.js`。

```js
// 读未读不影响运行状态：用既有 history/projection fixture 的实际任务。
const before = await c.session(sessionId);
await c.action("session.view", {sessionId, expectedViewRevision:before.viewRevision,
  seen:{taskId, resultRevision}});
assert.equal((await c.task(taskId)).status, originalStatus);
assert.equal((await c.session(sessionId)).view.seenResults[taskId], resultRevision);
// 将任务交付改为新的真实保存版本后，旧resultRevision不得把新卡标为已读。
```

### T4：两栏导航与珍珠白界面

**文件：** 修改 `gui/src/App.jsx`、`gui/src/features/navigation/Navigation.jsx` 与同目录 CSS、`gui/src/ProjectDialog.jsx`、`gui/src/features/conversation/Conversation.jsx` 与同目录 CSS、`gui/src/styles.css`、`gui/src/workspace-view.js`、`test/gui-components.test.js`、`test/gui-view.test.js`。

**输入：** T1—T3 的快照和命令；已确认的原型视觉。
**输出：** Team 导航、创建／绑定对话框、项目内历史／搜索入口、按需阅读区域及白色材质。

- [x] 用现有组件测试表达创建／切换／打开历史；空 Team 与无配置状态可见，缺配置只阻断生成，不阻断项目保存和历史。
- [x] 左栏改为 Team 列表与通用对话；不默认展开全部会话。顶部一个对话入口和一个阵容入口；新建、搜索、重命名、归档各有明确归属。
- [x] ProjectDialog 承担“创建 Team／首次绑定目录”两种明确用途，复用目录检查；不增加另一个项目向导。
- [x] 把白色材质整理到 token 与相应 CSS Modules，删除原型叠加样式和模拟装饰。默认浅色，不迁入 Tweak 或巨型演示脚本。
- [x] 在实际页面检查默认双栏、文件展开、弹窗和 800×600 布局；低透明效果、键盘、焦点与中文输入按第 5 节处理。
- [x] 运行 `node --test test/gui-components.test.js test/gui-view.test.js` 与 `npm run build:gui`；组件 DOM 通过不替代玻璃与布局的浏览器检查。

```js
// 实际浏览器路径复用已有page；不限定隐藏面板是否卸载DOM。
assert.equal(await page.getByRole("button", {name:"新建 Team", exact:true}).isVisible(), true);
assert.equal(await page.getByRole("complementary", {name:"阅读面板", exact:true}).isVisible(), false);
// 打开真实成果后面板可见、关闭恢复焦点与阅读位置；截图确认隐藏时不占正文空间。
```

### T5：把真实日常流程接完整

**文件：** 修改 `gui/src/useGuiWorkspace.js`、`gui/src/api.js`、`gui/src/Composer.js`、`gui/src/features/teams/TeamPanel.jsx`、`gui/src/Settings.jsx`、`gui/src/features/files/FilePanel.jsx`、`gui/src/Collaboration.jsx`；扩展 `test/gui-components.test.js`、`test/gui-history.test.js`、`test/gui-files.test.js`、`test/gui-integration.test.js`。

**输入：** T4 界面和原请求／文件／阵容能力。
**输出：** 新建到接续、保存到重开、搜索到原成果、切换到默认、归档到恢复的实际闭环。

- [x] 将模型组合可见名称统一为“阵容”，保留原 TeamPanel 的编辑、另存、参数、认证、删除保护与未知保存处理；只补明确的新对话默认选项。
- [x] 统一全局搜索与 Team 内搜索服务，保留命中 taskId/fileRef。搜索已归档内容只读打开，不自动恢复；所有新工作入口要求先恢复。
- [x] 接通阅读锚点、已读提交和最新结果入口；返回 Team 默认恢复上次阅读，不因后台更新改列表顺序或滚到底部。
- [x] 保留现有一次发送、pending submission 查询、模式冻结及取消。反例覆盖 A/B 切换迟到响应、草稿晚确认、归档与提交交错、停止未确认。
- [x] 成果和过程只读真实记录，普通问答按一／三次核对；文件差异、检查和原目录未写回分别显示。复制使用已有真实复制入口。
- [x] 运行 `node --test test/gui-components.test.js test/gui-history.test.js test/gui-files.test.js test/gui-integration.test.js`；记录 HTTP、Docker、浏览器和 fixture 各自范围。

```js
// 复用现有三次问答夹具：导航与管理不应额外生成。
const callsBefore = f.calls.length;
await c.bootstrap();
await c.sessions({workspaceId, query:"登录", archived:"all"});
assert.equal(f.calls.length, callsBefore);
// 完成一次讨论后核对仍为三次真实fixture请求，并从命中taskId打开同一结果。
```

### T6：组合验收、文档与候选

**文件：** 复用 `test/gui-visual.test.js`、`test/helpers/gui-demo.mjs`、`test/helpers/gui-installed.mjs`；实现后更新 `README.md`、`VALIDATION.md`、必要的 CHANGELOG 与本计划状态。证据留在 `work/gui/team-workspace/`。

**输入：** T1—T5 通过的实现，不使用聊天内模拟页替代。
**输出：** 第 7 节逐项证据、实际可启动的本地候选和清楚的未验边界；不自动推送或安装替换。

- [x] 运行 `npm run test:gui`、`npm run build:gui`；共享 conversation/storage 涉及的 `npm test` 必须运行。核心未变则不机械重跑不相关模型／终端批次。
- [x] 用现有 `test/helpers/gui-demo.mjs` 的隔离 fixture，经真实本地 HTTP GUI 走第 7 节场景；模型请求只能走 localhost 测试端点，不能加载用户的真实账户生成。
- [x] 使用真实浏览器检查 1280×800、1024×768、800×600 的两栏、按需面板和错误态，保留关键画面，并核对恢复、阵容、过程和文件文字的 12 CSS px 下限；浏览器交互由当前宿主允许的工具或已有自动化入口执行。
- [x] 分别记录无 blur 的 CSS 静态核对、透明／动态媒体模拟、实际浏览器键盘与合成组词事件。物理 IME、后台标签页及无 blur 浏览器留待实机验证。
- [x] 新模块分发检查在 T1／T2 已是必做。若制作安装候选，复用 `pack:npm` 和 installed fixture，在临时安装目录验证实际可导入和运行；不改全局版本。生成包本身不授权 npm／Git 发布。
- [x] 同步设计、使用说明及已验证事实，复读全部改动，运行 doc-maintenance 局部检查。所有失败保留，不把待完成复选框预填为成功。

## 7. 设计覆盖与验收矩阵

| 设计要求 | 施工归属 | 必须观察到的结果 |
| --- | --- | --- |
| 一个项目一 Team、目录可选 | T1、T2、T4 | 新建不发消息仍存在；无目录 Team 能问答且不获文件权限 |
| 名字／阵容变化不改变项目身份 | T1、T3、T5 | ID、历史和成果保持；旧任务作者不变 |
| 旧历史、同名目录与 worktree | T1、T2 | 不按阵容合并；不同目录可辨识；不改原 Pi／项目字节 |
| 首次绑定目录与重复绑定 | T1、T2、T4 | 旧 null 对话仍无目录；新对话用新目录；重复绑定打开已有项 |
| 默认两栏、按需阅读 | T4 | 无空右栏；正文有足够宽度，覆盖式面板可返回 |
| 项目内多对话、通用对话 | T2、T4、T5 | 新话题独立上下文；通用历史继续保存 |
| 搜索和找回旧文件 | T3、T5 | 命中原任务／文件，保持原归档状态，不只打开最近会话 |
| 阵容另存与默认范围 | T3、T5 | 两条旧对话保持独立；局部保存失败分别说明；忙碌时只读 |
| 完整草稿跨重启 | T2、T5 | 文本和单次操作一起恢复；未知／失败不丢稿、不重复提交 |
| 单活跃任务、模式与停止 | T3、T5 | 可去别处读历史写稿，发送不排队；停止确认与结果分开 |
| 最终交付、分歧与过程 | T5 | 正文保留重要边界；实际作者／调用可查，无虚构共识 |
| 文件、差异、检查与带走 | T5、T6 | 同一任务固定版本的真实成果；未配置检查不标通过 |
| 返回阅读、未读与需处理 | T3、T5 | 旧失败不永久亮提醒，新结果不被旧确认吃掉，不猜自然语言问句 |
| 归档、恢复、分支 | T2、T3、T5 | 无隐式恢复；旧状态和分支终点快照保留；外部入口限制如实说明 |
| 珍珠白及无蓝色底光 | T4、T6 | 默认白色，实际页面可读；深色宿主不改变新默认 |
| 无模糊、键盘、窄屏与公式 | T4、T6 | 降级仍可操作；关闭导航不可聚焦，中文组词不误发 |
| 断线、保存故障与未知请求 | T2、T3、T5 | 保留已载入内容与本机草稿，只查询原提交，恢复不产生新请求 |

“全部完成”需要真实 GUI 闭环。纯样式完成、组件测试通过、SDK 探针通过或一次原型点击均不能单独达成以上标准。实际模型内容质量和费用效果不属于本轮默认验收，另按授权检查。

## 8. 本轮审查与重审条件

本轮审查针对设计、原型与源码，未把尚未实现的接口当作测试通过。已确认需修订的事项及处理：

| 缺口或冗余 | 本计划的处理 |
| --- | --- |
| 原设计没有记录白色版本已被接受 | 固定参考快照和默认色系，更新设计阶段状态 |
| 空草稿“保存”未必落盘 | 先做真实 SDK 探针，再规定首次发布与重开；不另造草稿存储 |
| 只拆 revision 无法避免 UI 文件丢字段 | 所有 UI 写入共用短锁，管理与阅读各自版本，锁序固定 |
| 新导航可能把旧结果全部标成未读 | 首次接入与分支建立已结束结果基线，运行中结果排除 |
| 新会话误套旧历史基线，或阅读失败阻断任务 | 显式区分新建来源，空已读起步；移除非必要阻断，损坏／归属不明仍受保护 |
| 无目录 Team 可能因绑定而获得隐式权限 | GUI 归属与执行目录分开，绑定另开对话，旧权限不改 |
| 原型功能看似完整但多数是替身 | 明确不移植定时成功、固定预设、模拟文件、静默快照及前端分支 |
| “需处理”缺少可证明事实 | 只投影宿主交互与准入，不新增问句分类或待办系统 |
| 两次设置被误称一次原子修改 | 分别确认与恢复，不增加通用事务引擎 |
| 玻璃效果可能变成层层模糊和主题架构 | 收为语义 token、三类表面与统一降级；无动态壁纸和新主题平台 |
| 默认阵容、无目录重名和编辑稿字段不唯一 | 固定继承顺序、无目录名称冲突规则及 editor 投影，设计同步 |
| 旧参数或迟到编辑绕过新归档 | 兼容形状共用同一准入，两层归档覆盖所有会话修改，草稿绑定所见分支 |
| 源码可用但安装包缺新模块 | T1／T2 同步显式分发清单及包检查，不能留作可选验收 |

继续这条路线的依据：新增内容各自解决当前明确的使用缺口，关键空会话接缝已有本机 SDK 证据，核心执行路径可复用。需要重审的信号是：首次发布无法在真实控制器中保持单一身份／writer；目录归属必须复制聊天正文才能成立；普通布局调整开始要求修改模型调度；或真实用户无法从隐藏入口找回工作。出现这些情况先修相应边界，不继续堆控制面板或放宽历史／权限保证。

本轮由源码／接口、设计覆盖／必要性、架构／恢复三个独立审阅视角检查初稿，再逐项修订并复核。已关闭上表文档缺口，未发现还需先增加框架或顶层功能的理由；上述结论属于开工前审查。实现后的控制器、恢复、安装和浏览器证据分别记录在 [VALIDATION.md](../../VALIDATION.md)。
