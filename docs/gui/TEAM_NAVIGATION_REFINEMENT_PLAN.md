# CoThink 项目 Team 导航修正施工文档

> 执行者先读[项目团队设计](TEAM_WORKSPACE_DESIGN.md)和[当前基线](../../DESIGN_BASELINE.md)。获得实现指令后使用 executing-plans，独立任务可使用 subagent-driven-development；以下复选框仅供实际施工时记录完成情况。

**状态：2026-11-09，用户已要求按本文在最新版开始施工；N1／N2 已实现，浏览器与隔离桌面候选专项通过；完整 GUI 回归及证据边界见 [VALIDATION.md](../../VALIDATION.md)。**

**目标：** 左栏始终以项目 Team 为一级对象；用户先选项目，再从项目内继续或新建对话。恢复这个关系，同时保留浅色紧凑窗口。

**架构：** 复用现有 workspace 身份、Pi 会话、ConversationPicker 与 TeamPanel。变更导航展示、入口装配和必要空状态；删除失去用途的侧栏历史缓存，不新增模型调用、存储格式、后端接口或通用导航框架。

**技术栈：** 当前 React/Vite、CSS Modules、Node.js、node:test、happy-dom、Playwright、Electron。使用已锁定依赖，不升级技术栈。

**设计来源：** 用户本轮确认的“侧栏只放 Team，内部对话按需打开”；[项目团队设计第 2—3 节](TEAM_WORKSPACE_DESIGN.md#2-用户需要理解的关系)给出身份与使用关系。[桌面方案](DESKTOP_UNIFIED_IMPLEMENTATION_PLAN.md)继续负责统一会话、用时、Skill 和桌面生命周期。本文替代其中旧“侧栏最近对话”和模型入口名 `team` 的要求，保留紧凑视觉。

## 1. 完成标准与范围

1. 左栏主体只列未归档项目 Team，不渲染会话列表、最近对话分区或可展开会话树。项目行显示名称、必要的真实状态和同名目录提示；不强制摘要、头像或模型请求。
2. 顶部搜索旁明确显示 `＋ 新建 Team`；创建表单也叫“新建 Team”。主区顶部是当前 Team 名称、`对话`、`阵容`。两种“新建”不混用。
3. `对话`打开当前 Team 内的最近对话、完整历史搜索、分页及“新建对话”。原会话重命名、置顶、归档／恢复和匹配消息／文件定位保留。
4. 新建 Team 只要求名称，目录可选；没有模型配置也能保存。未发消息的 Team 重启后仍在；选择 Team 恢复其最近查看的可用对话，不隐式创建、发送或丢弃草稿。
5. 换阵容不改变 workspace 身份、已有对话归属或目录权限。旧无归属历史通过全局搜索可达，归档内容按现有“包含归档”／设置入口找回。
6. 用三个 Team、每个至少两条对话完成真实界面操作验收；另外验证空 Team、历史、窄窗口和运行中切换。单一项目的截图不构成导航验收。

只修 GUI 导航。统一项目会话、真实用时、内置 Skill、权限、预算、agent-sync、文件接纳、草稿保存和 App 关闭协议沿用现状。内部 `team`、CLI `/team`、`workspaceId`、`defaultRosterId` 等字段不更名；不重新迁移历史，不按模型或聊天标题重新分组。

## 2. 目标界面与操作合同

```text
左栏                         主区顶部
搜索  ＋ 新建 Team           LLM 学习             对话  阵容

CoThink 开发 · 有新结果       当前对话正文
LLM 学习       ← 选中
课程笔记 · 需处理            原输入区与发送按钮

设置
```

保留约 226px 的雾白侧栏、稳定正文底色、现有圆角与系统窗口安全区。搜索和新建是顶部操作；Team 列表独立滚动；设置保持底部单一入口。不加品牌栏、项目分类标题、文件夹图标、头像墙或装饰计数。明确的“新建 Team”文字承担导航解释职责，不以只剩加号换取简洁。

### 2.1 创建与接续

- 左栏“新建 Team”调用原 `createWorkspace`，保存后沿现有流程打开第一条对话。名称、目录检查、重复目录处理和无默认阵容情况继续由原逻辑处理；不将“创建 Team”改成 `session.create`。
- Team 的持久保存独立于第一条对话成功与否。首条对话**明确创建失败**时保留 Team 与错误，用户可从“对话 → 新建对话”再建；**确认丢失且查询仍未知**时保留原会话 ID 和“创建结果尚未确认”提示，先按原 ID 查询，不能把另建对话当作确认原结果。两种情况都不重发 workspace.create，也不自动重建会话。
- 点击 Team 使用 `selectWorkspace(row)`：优先恢复宿主给出的 `recentSessionId`，没有可恢复记录时停在该 Team 的空状态。切换不等于归档、关闭或停止任务。
- 新建对话的主入口放在项目内“对话”面板。移除项目行上的悬停撰写快捷图标，避免左栏再次同时承担项目和会话两层创建；键盘和触屏都能从同一可见入口完成。
- 项目管理继续点击主区 Team 名称打开：重命名、首次关联目录、归档／恢复。已归档、目录失效或归属不明的记录维持原只读与准入规则。

### 2.2 历史和搜索

- 全局搜索仍调用 `openPicker("all")`，查询 Team、对话和已有成果引用，结果标明归属。全局请求省略 workspaceId；传 null 只代表查未分组，不代表全局。空查询可浏览历史及分页。
- 项目内“对话”调用 `openPicker("project")`，显示当前 workspace 的会话。全局搜索的词、归档筛选和分页结果不能污染下一次项目内列表。每次打开沿用现有显式初始化查询。
- 全局结果命中消息／文件时继续经 `openFromPicker → openSession(id, taskId, fileRef, field)`，不能退化为只打开对话首页。会话菜单继续使用 `SessionRow`；全局结果沿原规则打开所属对话后再管理。
- 无归属历史保留 `workspaceId:null` 与“未分组”提示；损坏／待核对归属保留 `undefined`／错误事实。两者不能合并，更不能为消除空白自动制造 Team。
- 打开未分组历史后，保留继续对话及经原“对话”入口新建未分组对话的能力，不强制迁入 Team。本轮只移除一级常驻通用入口，不改变这些后续行为。

### 2.3 空状态与异常

| 状态 | 界面与可执行动作 |
| --- | --- |
| 已加载，未创建 Team | 侧栏说明“创建第一个 Team，开始持续的工作。”；顶部“新建 Team”和搜索可见，已有历史仍可打开 |
| 已选 Team，没有可打开的对话 | 主区保留 Team 名称，说明“这个 Team 还没有可打开的对话。从‘对话’中新建，或查找已归档对话。”；“打开对话”复用原入口 |
| 已有空白会话 | 使用原输入区，不额外创建会话或要求先发消息才能保存 Team |
| Team 全部归档 | 无活动 Team 的说明补充“已归档 Team 可在搜索或设置中恢复”；不伪装成首次使用或删除记录 |
| 列表读取失败／连接中断 | 沿用真实错误、重连和已载入历史；不能显示“尚无 Team”误导用户重复创建 |
| 正在读取／归属待核对 | 保留加载、只读和禁用条件，不能临时落到 null 归属后发送 |

创建确认未知时，原 ID 与核对提示优先于普通空 Team 的新建引导，不用另建来解释原操作的恢复。

窄窗口继续用已有“切换导航”抽屉，里面也只有 Team 一级列表；保留 Esc、焦点回归、焦点限制及背景 inert。中文长名称省略并可查看全名，真实状态和操作不能被挤出可见范围。

## 3. 现有代码核对与兼容策略

本次按 2026-11-09 现场工作树核对；包版本字符串不足以确定源码／安装包一致。开工时先检查变化文件、当前指令和相关差异，再按项目约定进行必要 Git 操作；不得从旧 CLI checkout 覆盖当前 GUI。

| 源码事实 | 施工处理 |
| --- | --- |
| `Navigation` 已遍历 `boot.workspaces`，最近会话是另一段 `SessionRow`，最多六条 | 删除后者，保留 workspace 列表和状态；不能把会话标题改名为 Team |
| `createWorkspace` 经 `manageWorkspace` 先保存 Team、再建首会话；createSession 未知查询失败会抛含原 ID 的普通 Error | 原路径保留，不能仅靠 error.unknown 判断所有失败；保留具体信息并分别验收明确失败／确认未知，不新增恢复状态机 |
| `selectWorkspace` 已查询 `recentSessionId`，会话读取经过选择代次和草稿管理 | 复用，不另存前端“最近项目会话”映射，不从当前搜索结果猜恢复目标 |
| `useRecentConversations` 缓存侧栏行，并在离开 picker 时重置列表查询；后台 refresh 持续读取当前查询 | 删除缓存 hook，把离开 picker 的项目查询恢复移回 `App.setOverlay`；保留 `useGuiWorkspace` 的查询、选择代次、保存队列和 `openPicker` 初始化，避免关闭搜索后继续全局检索 |
| `SessionRow` 同时用于 `ConversationPicker`，`navigationCommands` 还用于设置 | 不随侧栏删掉；重命名、归档、置顶和恢复继续走原命令 |
| 原 `team` 组合与 `workspace` 项目独立保存，`TeamPanel` 是唯一阵容编辑器 | 只改用户可见“team”为“阵容”；内部 action、组件名、JSON、快照、用户命名不替换 |
| 现有视觉测试断言侧栏“最近对话”、悬停创建及 `team` 弹窗 | 修改这些已过时的体验断言，保留草稿、归属、搜索分页、零调用及小屏检查 |

**预期修改文件：**

- `gui/src/features/navigation/Navigation.jsx`、`Navigation.module.css`：项目列表、明确新建、空态，移除侧栏历史与撰写图标及其专用样式；保留 picker、SessionRow 及它们使用的样式。
- `gui/src/App.jsx`：收窄 Navigation 参数，移除 recent hook，将 `leavePicker` 的查询收口内联到原 `setOverlay`；保留 `navigationCommands`、`openPicker`、`openSession`、workspace 管理、模态层保护和草稿关闭握手。
- `gui/src/useRecentConversations.js`：确认无其他引用后删除；不保留空壳、功能开关或替代缓存。
- `gui/src/ProjectDialog.jsx`、`features/conversation/Conversation.jsx`：创建／阵容文案和上下文正确的空态。`features/teams/TeamPanel.jsx`、`Settings.jsx`、`Composer.js`仅在发现同一入口的旧可见文案时局部同步。
- `test/gui-components.test.js`、`test/gui-visual.test.js`：复用现有 fixture 和入口验证；其他测试只在真实行为缺口或可见名称变化影响时修改。
- 文档只维护本文、项目团队设计和桌面方案的相关段落；实施后的实际证据归 `VALIDATION.md`，不为导航另建一套验收体系。

默认无需修改 `src/gui-controller.js`、`src/gui-workspace-state.js`、`src/session-ui-state.js`、`src/conversation.js` 或桌面宿主。若真实验收暴露原功能缺陷，先固定失败证据，再在既有职责内最小修补；需要迁移格式或改变核心权限时，超出本导航施工范围。

## 4. 施工任务

### N1：恢复项目一级导航与创建语义

**消费接口：** `boot.workspaces`、`state.workspaceId`、`state.ready`、`commands.selectWorkspace(row)`、`commands.createWorkspace({name,project,defaultRosterId})`；返回值和持久化保持现状。

**产出：** 左栏只操作项目，原项目内会话选择器继续工作。

- [x] 在既有组件／浏览器 fixture 中准备三个 Team 和分别归属的会话，先把旧侧栏验收改为新合同，确认旧 UI 在“没有最近对话分区”“新建 Team 名称”上失败。
- [x] 在 Navigation 保留 `active.map(row => …)`、选中态、真实 attention 和目录提示；移除 `recent` 派生及其 section、行末新建对话按钮和相应参数。新建按钮显示 `＋ 新建 Team`，可访问名称为“新建 Team”。
- [x] App 删除 `useRecentConversations` 导入、实例；在原 `setOverlay` 开头以内联查询恢复替代 `recent.leavePicker`，条件与原行为一致，随后仍执行原 overlayRef 更新与 dispatch。去掉仅给 Navigation 的会话参数。保留 picker 的 `navigationCommands`、查询初始化和匹配定位回调。
- [x] 删除无引用的 hook 与专用 CSS；不删除 `SessionRow`、搜索结果和操作菜单样式。调整顶部按钮布局，使文字适配当前侧栏宽度。
- [x] ProjectDialog 新建标题改为“新建 Team”，说明为“一个 Team 对应一个长期项目。只填名称也可以开始讨论。”；绑定目录流程不变。补齐第 2.3 节空状态；没有 Team 时不自动创建默认 Team。

保留的查询收口（不触碰当前选择、草稿、阅读锚点）：

```js
if (overlayRef.current?.kind === "picker" && value?.kind !== "picker") {
  commands.searchSessions({scope:"project", query:"", includeArchived:false});
}
```

核心界面断言示意（加在已有浏览器场景，不另建测试框架）：

```js
const nav = page.locator('nav');
assert.equal(await nav.getByRole('button', {name:'新建 Team', exact:true}).count(), 1);
assert.equal(await nav.getByRole('region', {name:'最近对话', exact:true}).count(), 0);
assert.equal(await nav.getByRole('button', {name:'课程笔记', exact:true}).count(), 1);
await page.getByRole('button', {name:'对话', exact:true}).click();
await page.getByRole('dialog', {name:'对话', exact:true})
  .getByRole('button', {name:'新建对话', exact:true}).click();
```

### N2：统一术语并验证历史可达性

**消费接口：** 原 `openPicker("all" | "project")`、`openFromPicker`、`createSession({workspaceId})`、`onRoster`、`TeamPanel` 和归档恢复命令。

**产出：** 项目、会话、阵容在所有入口中含义一致；搜索不会改变目标项目或丢失历史功能。

- [x] Conversation 的入口文字与默认提示改“阵容”，App 对应 Modal 标题改“阵容”，ProjectDialog 的默认配置说明改“默认阵容”；更新同入口的 aria-label、tooltip、空配置提示和相关测试。保留双人图标，不改内部 `kind:"team"`、`Icon name="team"` 或用户已保存的组合名。
- [x] 从 Team A 打开全局搜索，命中 Team B 的消息／文件，再打开 B 的“对话”；确认只列 B 的历史。取消无匹配搜索、切换归档筛选与分页后重开项目列表，确认初始化查询正确且不跳走阅读锚点。**消息、文件、查询复位、分页与锚点均已验证；文件场景核对真实 taskId、版本、fileRef 和所属 Team，并使用打包后台复验。**
- [x] 经项目内列表执行重命名、置顶、归档、恢复；经全局搜索打开无归属历史和已归档 Team，确认未分组的继续／新建能力及归档恢复入口保留。未知归属仍不能新建／发送到猜测项目。
- [x] 验证当前会话阵容切换和“使用并设为新对话默认”：workspace ID、其他已有对话快照保持原值，不因 UI 名称相同而混改数据。

### N3：用真实布局和持久化路径验收

**消费接口：** 既有 GUI server/controller fixture、磁盘保存与 App 候选启动路径；不用真实收费模型作为导航验收前提。

**产出：** 记录各场景结果、截图与限制，能够判断修复是否接近用户日常使用。

- [x] 按第 5 节依次执行场景（包括 A5 跨 Team 文件命中后的完整界面交互）；沿用现有组件用例覆盖选择代次、慢保存、未知结果和焦点保护，缺少关键行为证据时才补有意义的反例。
- [x] 更新 `test/gui-visual.test.js` 首个紧凑侧栏场景：改为三个 Team、每个两条对话；从项目内 picker 新建。把原“全局分页后侧栏最近对话仍在”改为“关闭全局搜索后重新打开项目历史仍只属于当前 Team”。保留原无模型调用与无页面错误断言。
- [x] 运行本节命令并检查结果；有失败先定位是否由本变更造成，不删除保护性断言来获得通过。视觉检查用中文长标题、长正文和多个真实状态，不能只看空白主页。
- [x] 构建获授权的独立桌面候选后，在候选中检查相同布局与系统标题栏、窄屏抽屉、Esc／焦点、关闭重开后的草稿及 Team。构建／测试 App 放 `.noindex`，不默认替换 `/Applications/CoThink.app`。
- [x] 在 VALIDATION 中分别记录离线测试、浏览器、桌面候选证据及未验项。只有实际安装被授权时才做唯一正式入口、Launch Services 和 Spotlight 收尾；不能以网页截图声称安装版已更新。

以下为**施工验证命令**，逐次结果记录在 VALIDATION。工作目录为本仓库根；使用现有依赖和临时 fixture 数据根，不操作真实会话：

```sh
node --test test/gui-components.test.js test/gui-view.test.js test/gui-workspace-state.test.js
npm run build:gui
node --test --test-name-pattern='compact sidebar' test/gui-visual.test.js
npm run test:gui
npm run test:desktop
```

保持首个场景名称包含 `compact sidebar`，使聚焦命令有效。完整 `test:gui` 含既有执行环境检查，缺 Docker 等环境时如实记录阻塞，不能改 skip 或声称全通过。构建应先于依赖 `gui/dist` 的视觉验收；桌面打包与安装沿用[桌面施工文档](DESKTOP_UNIFIED_IMPLEMENTATION_PLAN.md)，不引入另一套脚本。若未触及统一运行层，不扩展到收费模型、插件全矩阵或全项目重测。

## 5. 验收场景

| 编号 | 操作 | 必须观察到的结果 |
| --- | --- | --- |
| A1 | 三个 Team 各建两条对话，再增加一条 | 左栏仍只有三个项目入口；会话只在对应 Team 的“对话”内增加 |
| A2 | Team A 两条对话各留草稿，选 A 的较早对话，再切 B、回 A | 恢复 A 最近查看的那条而非按置顶或搜索排序误选；草稿和阅读锚点各自保留 |
| A3 | 只填名称创建 Team，不发送；重启宿主／候选 App | Team 与空会话仍可找回；未配置模型也能创建、查看，发送仍遵守原准入 |
| A4 | 分别模拟首会话明确失败、创建确认丢失且按原 ID 查询仍失败 | 都保留已保存 Team；前者可显式再建，后者保留未知和原会话 ID、不建议另建来替代核对；均不自动重发 |
| A5 | 全局搜索跨 Team 内容、文件及未分组历史；取消后等一次后台刷新，再进项目对话 | 刷新已回项目查询，定位、分页与归档可用；未分组历史可继续／新建，旧归属不变 |
| A6 | 归档／恢复一条会话及一个 Team，直到无活动 Team | 归档对象从默认列表收起，搜索或设置可恢复；没有“全没了”的假空状态；记录、草稿保留 |
| A7 | 改项目名、换阵容、设默认阵容 | 项目 ID 和历史归属不变，旧会话保留各自快照；界面不会把阵容名称当项目名 |
| A8 | A 运行 fixture 任务，切到 B 浏览和写草稿，再返回 A | 活跃任务返回／停止入口仍在，切换不终止任务；发送限制与原提交边界一致，不自动排队发送 B 草稿 |
| A9 | 1280×880 与 800×600，长中文名、键盘和触屏目标 | Team 是视觉主体，无会话分区；新建 Team／对话／阵容可区分；无横向溢出，窗口按钮及焦点可用 |
| A10 | 列表读取失败、归属待核对、保存失败的已有反例 | 不把故障当空列表，不猜归属，不丢草稿、不自动重发；恢复入口与失败原因可见 |

A1—A3、A5、A9 必须有实际渲染与交互证据；持久化与错误分支可复用既有 controller／hook 测试并注明对应测试名。fixture 只证明流程和保护，不证明真实模型回答质量。恢复前后核对 ID、归属、草稿和历史内容，不把阅读行为产生的合法时间／已读记录变化误判为数据迁移。

## 6. 设计差距与兼容性复核

下表保留方案复核；实际实现与验证结果以 VALIDATION 为准。

| 审查点 | 已闭合的方案 |
| --- | --- |
| 只改标签，未恢复项目关系 | N1 只渲染 workspace，N2 区分阵容；A1／A7 验证 |
| 移除历史区造成能力丢失 | 保留 picker、SessionRow、设置恢复及未分组后续行为；A5—A6 验证 |
| 误删搜索收口、丢草稿或误重试 | 退出 picker 的查询恢复内联到 App，复用保存与选择代次；A2／A4／A8／A10 验证 |
| 单项目截图与架构扩张 | 三 Team 多对话与桌面窄屏验收；复用身份与保存格式，不增加存储／API／框架 |

**实施证据边界（2026-11-09）：** 本地导航、查询收口、空态与阵容文案已实现；真实浏览器及 macOS 隔离候选覆盖三 Team、草稿、重启、搜索分页、阅读锚点、归档／恢复和窄屏。验收发现并修复了最后一页移除按钮后的弹层 Escape／Tab 保护，以及已关闭会话菜单拦截 Escape。后续已启动缺失的 Docker daemon，完整 GUI 161/161 通过；原失败原因和未验证项保留在 [VALIDATION](../../VALIDATION.md)。随后用户授权完成补验、私有 GitHub 提交和本机安装；已完成，见 VALIDATION。未进行 npm 或公开发行。
