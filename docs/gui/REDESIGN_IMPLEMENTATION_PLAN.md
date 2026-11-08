# CoThink GUI 重设计施工方案

> **For agentic workers:** 获得本轮正式施工指令后，使用 executing-plans 按任务推进；需要分工时按当次授权使用 subagent-driven-development。复选框记录实际执行状态，不预填通过。

**状态：2026-10-30，P0—P6 本地实施、回归、候选安装、浏览器、维护性与独立审查完成。** 已确认的原型交互是设计输入，不是正式接口或运行证据；2026-10-23 旧计划的开工和发布授权不作为本轮开工指令。

> **后续体验修订（2026-10-30）：** 用户在实际 GUI 中追加授权了回复分支入口，并要求收紧 Team、输入区和顶部信息。历史分支原列后续增量的限制已被本次明确请求取代；实际能力与边界见 DESIGN_BASELINE、README 及本地 `work/gui/feedback-2026-10-30/` 验证记录。下文保留首轮 P0—P6 的施工语境。

**Goal：** 交付以编程和文件制作为主的 GUI：项目与对话切换顺畅，归档恢复位于设置，输入区 `team` 完成组合管理，成果文件和差异可直接阅读；后续调整布局、入口、文案和预览类型时，改动集中在相应职责内。

**Architecture：** 保留 React/Vite → 本地 HTTP → CoThink 控制器 → 共享 Pi／Team／runTurn／agent-sync 的路径。前端把服务端事实、用户操作和界面布局分开；按导航、对话、Team、设置、文件阅读组织组件。新增宿主展示元数据和文件投影只解决当前缺口，不建立另一套对话数据库或插件框架。

**Tech Stack：** 现有 Node.js >=22.19、ES modules、React/Vite、Markdown 渲染和 node:test。沿用 JavaScript，通过 JSDoc 描述跨模块合同；不为这次重设计增加状态库、UI 框架、TypeScript 迁移或新的桌面容器。

**Spec：** [重设计方案](REDESIGN_PROPOSAL.md)描述用户体验；[当前设计基线](../../DESIGN_BASELINE.md)约束运行语义。用户最新反馈优先：左下只保留“设置”，已归档查看与恢复在设置内；输入区按钮显示 `team`，承载选择、新建、调整另存和删除。原型的“原型说明、重置示例、模拟运行”不进入正式产品。

## 1. 文档归属与施工边界

| 文件 | 主要责任 |
| --- | --- |
| `REDESIGN_PROPOSAL.md` | 已确认的交互方向、取舍和用户操作路径 |
| 本文 | 模块职责、目标接口、施工依赖、迁移与验证要求 |
| `DESIGN_BASELINE.md` | 模型调用、会话、Team、权限和版本的现行语义 |
| `DESIGN.md` / `IMPLEMENTATION_PLAN.md` / `ACCEPTANCE.md` | 首版 GUI 的历史设计、施工及验收；保留当时事实 |
| `README.md` / `VALIDATION.md` | 实现后更新实际入口、能力和已取得的证据；不提前宣称支持 |

首轮必须完成下文 P0—P6。文件引用、真实附件、历史分支、非 Git 项目和执行生成网页脚本不作为本轮隐含承诺，边界列在第 10 节。后续开发都沿本方案的职责边界接入，而不是在根组件里追加分支。

### 全局约束

- 共用一套核心。ONE 问答一次；CoThink 问答三次、第一副模型评审；工作 `maxCalls=null`，ONE 不委派。不得为 UI 增加命名、分类、摘要或预热请求。
- 当前宿主仍只运行一条活跃用户任务。可切换历史和编辑草稿；不自动排队，不以 GUI 改造顺便加入后台调度。
- 模式与配置按提交冻结；运行中模式切换只影响下一条。Team 修改遵守现有忙碌限制、另存、当前组合和最后一个保护；历史不回写。
- 未知提交只查询原关联，不自动重发。调用、费用、检查和视觉评审各自依据真实记录，不把未知显示成零或成功。
- 保留写锁、损坏隔离、草稿保护、无项目的中性目录、固定起止版本和原项目不自动写回。agent-sync 公共边界不变；发现公共接口缺口时单独提出必要改动，不能绕过内核。
- 保留 loopback、启动凭据、Host/Origin、CSP、路径及内容边界。新增 UI 能力不自动扩大模型或文件权限。
- 原目录、用户配置及已有未提交改动保留。施工前在正确的统一源码 checkout 检查变化，建立适合本轮的隔离分支／工作区；不直接覆盖并发工作。
- 首轮默认本地候选交付；Git 发布、npm、全局切换与真实付费模型验收遵循当次明确授权。原型和 fixture 不代替真实模型质量证据。

## 2. 灵活性具体落在哪里

### 2.1 三类状态各有一个负责位置

| 状态 | 负责人 | 示例 | 界面变化时的规则 |
| --- | --- | --- | --- |
| 服务端事实 | 现有控制器／共享核心；前端工作区 hook 统一读取 | 会话、Team、归档状态、任务进度、版本、文件内容 | 组件接收快照，不能自己制造完成状态或复制业务规则 |
| 用户操作与恢复 | `useGuiWorkspace`，调用 `api.js` | 提交、切换会话、归档、保存 Team、确认未知提交 | 同一操作只有一条调用路径；入口移位不改变操作实现 |
| 纯显示状态 | 工作区视图状态及相应组件 | 当前面板、设置分类、文件页签、折叠、宽度、焦点 | 可以换布局、清理失效偏好；不能因此重置草稿或重新生成 |

草稿继续由工作区层使用现有 `createDraftBook` 与宿主保存规则管理。不能把草稿放进可能被折叠或卸载的 Composer 内部，也不能随当前窗口 DOM 节点销毁。归档是持久的会话级展示状态，不是 Pi 的会话分支、运行终态或权限撤销。

组件不直接调用 `fetch`、写宿主状态或订阅 SSE。`api.js` 负责认证、一次发送和只读重连；`useGuiWorkspace` 负责一次订阅、刷新合并、错误与恢复。对不同会话的异步结果按 ID 归位，迟到的 A 会话响应不能覆盖已打开的 B 会话。

`useGuiWorkspace` 只协调共享会话和操作，不接管每个功能的所有细节。Team 的未提交表单由 TeamPanel 管理，文件读取结果与 Blob 生命周期由 FilePanel 管理，归档搜索输入由 Settings 管理；有需要时先使用该功能内的私有 helper。关闭未保存的表单要明确处理，而不是借布局卸载悄悄丢弃。不能把原 App 原样搬进一个新的巨型 hook，也不能为了一个消费者提前抽象通用框架。

### 2.2 按真实功能分解，不预造通用平台

以下是目标归属，不要求一次性移动全部旧代码。新文件在首次有消费者的任务中创建。

| 位置 | 职责与消费者 | 为什么需要 |
| --- | --- | --- |
| `gui/src/App.jsx` | 装配导航、对话、文件区和弹层；确定窄屏呈现 | 将布局调整限制在根装配与样式中 |
| `gui/src/useGuiWorkspace.js`（新增） | 根级宿主状态、命令、草稿、SSE、未知提交恢复；供所有功能区使用 | 防止每个新入口复制请求／恢复逻辑，或卸载面板时丢状态 |
| `gui/src/workspace-view.js`（新增） | 纯显示状态的初值和 reducer；App 使用 | 同一份选择状态支持侧栏、抽屉、窄屏全页，不保存多套冲突布尔值 |
| `gui/src/features/navigation/Navigation.jsx`（新增） | 项目和对话列表、就近菜单、搜索结果；设置内归档复用列表行 | 普通列表和归档列表共享行行为，入口可以独立调整 |
| `gui/src/features/conversation/Conversation.jsx`（新增） | 回复、任务状态、成果入口；复用现有 Composer／Markdown | 防止聊天展示和宿主执行规则混在 App 中 |
| `gui/src/features/teams/TeamPanel.jsx`（新增） | 选择、创建、编辑另存、删除；包含模型编辑视图 | 将 `/team` 的 GUI 入口变成一个可放进弹窗或抽屉的组件 |
| `gui/src/features/files/FilePanel.jsx`（新增） | 文件选择、成果／源码／差异阅读、下载 | 文件阅读可以增加格式，不影响会话生命周期 |
| `gui/src/Settings.jsx`、`ProjectDialog.jsx`、`Collaboration.jsx` | 设置外壳、项目接入、真实执行记录；按改动范围精简 | 保留已有功能，避免另造同名页面 |
| `src/session-ui-state.js`（新增） | 按会话 ID 读取／原子更新归档和置顶元数据；控制器消费 | 现有 Pi 分支记录不适合保存全会话的导航状态 |
| `src/gui-files.js`（新增） | 固定版本的文件清单、读取、格式与大小边界；控制器消费 | 防止每种文件视图各自拼路径、读取最新目录或放宽权限 |
| `src/gui-controller.js`、`src/gui-server.js`、`src/gui-work.js` | 调用协调、HTTP 白名单、现有版本／差异／日志能力 | 新功能通过既有宿主接入，不建立第二个服务 |

保留 `src/teams.js`、`config.js`、`conversation.js` 作为既有规则拥有者，TeamPanel 只提供即时提示。必要的只读投影由 `gui-projection.js` 负责。不能把原型的模拟模型、localStorage 会话数据或 `document` 事件总入口复制进生产实现。

样式随功能组织为同目录 `.module.css`；`styles.css` 逐步收敛到全局 token、基础排版和共享控件状态。根布局拥有列宽／断点，功能组件不计算整页坐标。先迁移本轮触及的样式，不顺便全库改名。现有组件测试已使用 Vite 构建，继续复用它处理 CSS Modules；不要用空样式 mock 掩盖构建接线问题。

不加入通用 action registry、插件注册、动态布局 DSL、事件总线或第二个全局 store。一个文件若只有一个消费者且职责很小，允许保留为该功能模块里的私有函数；不为目录整齐继续拆分。

### 2.3 后续常见调整应有明确改动范围

| 调整 | 正常应触及 | 不应因此触及 |
| --- | --- | --- |
| 把 Team 从弹窗改为右侧抽屉 | App 的承载方式、面板尺寸与焦点恢复 | `teams.js`、模型调用、Team 保存 API |
| 调整已归档分类在设置中的位置 | Settings 导航及显示状态 | 归档存储、Pi 会话正文 |
| 侧栏分组／排序／行密度变化 | Navigation 和查询参数 | 任务状态机、正文保存 |
| 新增一种只读文件视图 | FilePanel 的格式分派；确有需要才扩展 gui-files | 提交、模式、Team、agent-sync 接纳 |
| 更改默认列宽、暗色或按钮文案 | token、功能样式和文案 | API 形状、会话数据格式 |
| 真正改变业务行为 | 对应的核心拥有者、调用者及行为验证 | 不通过只改 UI 制造与核心不一致的新含义 |

这些是施工时可审查的依赖边界，不是已经测得的维护成本保证。

## 3. 目标合同

本节记录本轮施工合同；P0 接线核对与 P1—P5 实施已完成，当前接口细节以对应源码为准，验证范围见第 4 节执行状态与 VALIDATION。

### 3.1 前端工作区

```js
// 由 App 创建一次，功能区通过 props 使用。
const { state, commands } = useGuiWorkspace(api);
// state: bootstrap、sessions、selectedSessionId、session、task、draft、pending、connection、errors
// commands:
openSession(sessionId)
createSession({ project })
setDraft(sessionId, text)
submit({ sessionId, input, workRequest })
recoverSubmission({ sessionId, submissionId })
setSessionNavigation({ sessionId, expectedRevision, change }) // change 只含 archived 或 pinned 之一
selectTeam({ sessionId, teamId })
saveTeam({ name, main, secondary })
removeTeam({ sessionId, teamId })
loadFiles(taskId)
readFile(fileRef, { purpose, signal })
readFileDiff(fileRef)
```

上面是命令签名清单，不是可以直接粘贴的完整实现。`submit` 继续在唯一提交入口生成／冻结 `submissionId`，保存 pending 后只发送一次；其他组件不得另发请求。`workRequest` 保留当前真实合同，普通输入不强制进入工作。

`saveTeam` 返回保存的组合；随后 `selectTeam` 单独确认切换。如果保存成功而切换失败，要显示“已保存，当前对话未切换”，不能回滚已保存事实或重复创建。删除动作绑定发起时的 `sessionId`，后端按新鲜配置再次校验。保存 Team 的响应未知时只刷新组合列表，保留编辑内容；发现同名组合先展示实际阵容供核对，不能自动再创建或凭名称自动切换。

```js
// workspace-view.js：同一时刻只出现一种主要弹层；文件阅读与其独立。
const initialView = {
  overlay: null, // { kind: 'settings', section: 'archives' } | { kind: 'team' }
  filesBySession: {}, // sessionId -> { taskId, fileRef, tab: 'preview'|'source'|'diff' } | null
  navigation: { collapsed: false, expandedProjects: {} }
};
// App 的 closeOverlay 只把 overlay 设为 null 并恢复焦点。
// TeamPanel 本身不包含 Modal；App 决定用 Modal、Drawer 还是窄屏页承载。
<TeamPanel session={state.session} teams={state.bootstrap.teams}
  models={state.bootstrap.models} busy={!!state.bootstrap.active}
  commands={commands} onClose={closeOverlay} />
```

面板选择绑定会话和任务，不绑定数组位置。请求开始时保留对象身份，响应回来后核对身份；切换项目不会把 A 文件放到 B 对话。显示偏好只存可丢弃的 ID、页签和尺寸，带 `schemaVersion`；不能在 localStorage 保存对话、认证、任务事实和 Team 的权威副本。无效偏好恢复为关闭面板，不删除宿主数据。

### 3.2 归档、置顶与搜索

`session(id)` 和会话列表增加 `navigation`：

```js
{ schemaVersion: 1, revision: 0, archived: false, pinned: false, changedAt: null }
```

状态存放于 `COTHINK_HOME/session-ui/<sessionId>.json`；目录和文件沿用私有权限创建。只含展示元数据，不复制正文、Team、模式或项目路径。模块提供 `readSessionUiState(home, sessionId)` 与 `writeSessionUiState(home, change, assertOwned)`，其中 change 包含 sessionId、expectedRevision 和一个目标字段；版本校验及递增只在这个存储函数内完成。缺文件按默认值读取；损坏／未来版本保留原文件并禁用该记录的管理操作，不将错误解释为“没有历史”。

- `session.archive {sessionId, archived:boolean, expectedRevision}`、`session.pin {sessionId, pinned:boolean, expectedRevision}` → `{sessionId,navigation}`。使用显式目标值，不使用容易重复翻转的 toggle。
- 控制器先通过现有严格会话读取校验 ID 和内容；归档必须拒绝活跃任务，置顶在本宿主持有合法 writer 时可执行。再取得／复用现有 Pi writer，在 `writeSelection` 中核对 revision，通过 `writePrivateJson` 原子保存，提交前再次检查 ownership。revision 不一致返回冲突，界面重新读取后由用户决定，不覆盖别人的新状态。
- 成功归档后释放该会话的空闲 runtime／writer，复用并提取现有 `close()` 中相同的释放逻辑；不能让隐藏对话长期占锁，也不能取消运行中的任务。释放异常与归档是否已保存分别报告。
- 响应丢失时 GET 会话状态，只陈述现在是否已归档，不自动重发。归档撤销是一次有新 revision 的恢复操作。原子保存失败不先从列表永久消失。
- 归档只影响 GUI 导航，不移动 Pi 日志、删除成果或撤销 CLI 的读取权限。旧 CLI 仍可按其现有入口继续该会话；首次实现不静默改变 CLI 会话列举与执行规则。
- 已持久化的对话支持归档／恢复；未形成 Pi 历史的纯空白页可直接关闭，不制造“归档的空记录”。仅有未发送草稿时保留草稿并解释尚无历史可归档，不通过发送空消息强制落盘。原型的空记录归档不作为该存储语义的证据；未发送草稿的跨进程持久化要另行统一设计。

新增 `controller.sessions({query='', project, archived='active', cursor, limit=50})` 和 `GET /api/sessions`；`project` 缺省为全部，指定目录或 null 分别代表该项目或无项目。返回 `{items,nextCursor,errors}`，行包含现有 summary 与 navigation。上限 100 条，query 上限 200 字符；标题、用户输入、最终回复做本地文本匹配，不读取兄弟分支或内部评审会话。

排序固定为置顶、最近修改、ID；cursor 包含列表指纹和位置，列表变化时返回可识别的失效结果，客户端重新读取并按 ID 合并。`bootstrap` 保留现有字段，使用同一列表查询产出初页并提供后续 cursor，不维护另一套列表事实。正文按需读，不能为了侧栏和搜索反复装载所有任务全文。文件名检索在 P4 有可信文件清单后加入；不做全文文件索引或向量检索。

API 公开错误继续脱敏，增加可识别的 `code` 与 HTTP 状态：`SESSION_STATE_CONFLICT`／`SESSION_BUSY` 为 409，`SESSION_NOT_PERSISTED` 为 409，`SESSION_STATE_UNAVAILABLE` 为 409，查询 cursor 失效为 409 / `CURSOR_EXPIRED`。`api.js` 传递这些安全 code，不解析中文文案决定流程；其他错误保留现有 unknown 语义。

**入口约定：** 左下角只有设置；“已归档”是 Settings 的分类，支持搜索、查看和恢复。对话行菜单仍负责归档。设置内恢复不强迫跳转对话；“查看”才打开原对话。普通搜索可以明确包含已归档结果，打开后呈现只读状态，继续发送前恢复。

### 3.3 文件阅读

实现提供 `controller.files(taskId)`、`controller.file(fileRef, {purpose})` 与 `controller.fileDiff(fileRef)`。对应的认证 GET 入口是 `/api/files?id=…`、`/api/file?taskId=…&version=…&path=…&purpose=…` 和 `/api/file-diff?taskId=…&version=…&path=…`。下载与源码／预览复用同一文件授权和字节校验，不另开裸文件服务器。

前端 `api.file(fileRef, {purpose='source', signal})` 沿用认证 fetcher，返回 ArrayBuffer 与响应元数据；工作区 `readFile` 转发这些选项，`readFileDiff` 通过 `api.read('file-diff', fileRef)` 读取 JSON。JSON 读取器不用于文件二进制。

```js
const fileRef = { taskId, version, path }; // 项目相对路径，version 必须为该任务固定终点
// files(taskId):
// {taskId, fromVersion, toVersion, limits,
//  items:[{ref, name, status, mediaType, previewKind, readable}], warnings}
// file(ref, {purpose='source'}):
// {bytes, mediaType, filename, version, representation, contentHash, sourceContentHash, warnings}
// fileDiff(ref):
// {path, fromVersion, toVersion, before, after, status, binary, patch}
```

`purpose` 只接受 `source`、`preview`、`download`。源码按文本返回；静态 HTML/SVG 预览返回经校验的派生 HTML（`representation='static-preview'`），其他原始读取为 `original`；下载不改写原始字节。`contentHash` 是此次返回字节的 SHA-256，`sourceContentHash` 是原始入口文件字节的 SHA-256；派生预览时两者可不同，均不能替代带 Git blob 头的对象身份。

HTTP 使用实际 Content-Type／Content-Length，下载为 attachment，其余为 inline；UTF-8 filename 由 Content-Disposition 编码。X-CoThink-Representation／Version／Content-Hash／Source-Hash 对应上述元数据。文件 bytes 不经 JSON/redact；安全错误继续返回 JSON/code。HTTP 二进制响应不逐字段传递控制器 warnings，界面的静态限制提示依据 representation 显示。逐文件差异无法可靠拆分时返回 FILE_DIFF_UNSUPPORTED，保留完整补丁入口；二进制只陈述事实，不伪造文本 diff。

后端根据任务记录及接纳回执解析固定终点，核对 ref.version，并从该版本的清单核对路径；调用方不能提供任意工作目录或新 tip。清单、文件读取、逐文件差异与完整 diff 共用 `withGuiWork`／`guiWorkVersions` 的版本来源。删除文件展示差异，不假装有最终文件；二进制不伪造文本 diff。

当前公共 `v.read({version,path,kind})` 可读取固定版本，但文件内容一次性返回；不得把“返回后截断”称作读取内存限制。P0 已用 SHA-1／SHA-256 临时仓库确认：有可信成果目录时采用第 1 条；缺目录时保持第 2 条拒绝边界。公共 tree 与整体 diff 仍一次返回，不能将文件额度说成仓库元数据／整体 patch 的流式内存上限。

1. 已有可信 `resultWorkspace`：通过公共 tree 读取取得对应路径的 Git 对象身份，再在记录的成果目录做限量读取，校验路径、非符号链接／非外部硬链接及内容的 Git blob 身份与目标版本一致。按实际仓库对象格式计算带 `blob <字节数>\0` 头的对象散列，与公共 tree 的 object 比较；不能只比较 mtime 或把普通 SHA-256 内容散列当作 Git 对象 ID。先限制读取字节，再解析；目录被改动或身份不符时拒绝展示，不能把变动后的文件冒充旧成果。
2. 缺少可验证的成果目录：保留已有固定版本 diff 和经哈希验证的截图入口；不降级去读用户原目录。没有有界读取保证时不开放任意文件下载。若必须补公共接口，单独提 agent-sync 最小改动方案；其余 GUI 任务照常推进。

当前上限集中在 `gui-files.js` 的 FILE_LIMITS：文本及静态入口 1 MiB、图片／静态预览原始资源总计 8 MiB、原始下载 32 MiB、64 个资源、4 层资源读取、派生表示 16 MiB。拒绝超限要说明原因并提供已有“打开成果目录”；这些是 GUI 内容处理额度，不是模型输出额度。上限可以日后在同一位置调整，前后端不各写一份常量。

预览分派只用一个显式函数／静态映射，先支持纯文本、代码、Markdown、图片、静态 HTML/SVG。Markdown 沿用既有安全渲染；HTML/SVG 不内联进应用 DOM，不执行脚本，使用隔离 iframe 和拒绝外联的 CSP。相对样式／图片只从同一固定版本取得，资源数、深度和总字节在服务端逐项核对后，把允许的同版本 CSS 内联、栅格图片改为 data URI；派生表示另受 16 MiB 额度约束。CSS @import／url()／外部字体、转义及其他不支持结构明确拒绝；4 层是共用上限，不表示支持任意递归 CSS。无法正确还原时提供已有截图／源码／下载并说明限制。PDF／Office 等首版提供已验证文件的下载或打开目录，不显示假预览。

文件的元数据和错误仍走现有安全投影；二进制读取使用单独的受限返回，不把 Buffer 交给通用 JSON/redact 包装破坏原字节。只返回经过授权与身份校验的成果，不将认证文件或任意宿主文件加入清单；拒绝必须明确，不能悄悄改写下载内容。

展示“截图已产生、模型已收到图片、模型已完成审查、检查通过、文件已保存”时仍分别取实际事实。无论面板放在哪里，都不能把一项事实推导成另一项。

## 4. 施工任务与依赖

顺序：`P0 → P1 → P2 → P3 → P4 → P5 → P6`。只有确认不共享改动文件后才并行；控制器、根状态与全局样式不分派给多个实现者同时改。每项结束以实际文件、行为证据和未解决问题交接。

### P0：核对基线、合同与已有验证

**Files：** 读取 App、Composer、Settings、Collaboration、api/view、gui-controller/server/work、teams/config/conversation、已有 GUI 测试和安装脚本；先不修改核心。施工记录放在既有 `work/gui/` 范围。

**Consumes：** 本文、设计方案、当前源码；**Produces：** 本轮固定输入、改动范围、测试复用清单，以及文件读取路线的实际验证结论。

- [x] 检查实际未提交文件、分支与依赖；保护并发修改，选择正确统一仓库的隔离工作区。说明此次 Git 操作目的，再进行分支／worktree 操作。
- [x] 从 `package.json` 核对当前测试和构建命令；按本轮触及范围先运行 GUI 控制器／历史／Team 相关已有检查，记录已有失败，不重设成功标准。
- [x] 在临时项目中核对公共固定版本 tree/read、成果目录来源、对象格式、文件大小限制和 Windows 路径规则；按 3.3 的两条路线作出明确选择，保留例子与拒绝行为。
- [x] 列出原型与真实接口的差异：归档持久化、空白会话、真实模型能力、文件读取、目录选择。禁止把原型 localStorage 或模拟成功消息接入产品。

**退出条件：** 当前可实现范围和文件读取路线有具体证据，依赖／环境缺口已明确。不能用完整实现重写来掩盖合同尚未核对。

### P1：分离状态与显示，保持已有行为

**Files：** 修改 `gui/src/App.jsx`、`styles.css`；新增 `useGuiWorkspace.js`、`workspace-view.js`、Navigation 和 Conversation；复用 Composer、Modal、Markdown、api、view。相关样式随各组件迁移。

**Consumes：** 现有控制器合同、createDraftBook、api.recover/subscribe；**Produces：** 第 3.1 节的统一 state/commands 与受控组件边界。

- [x] 将 App 的请求、SSE、草稿与 pending 恢复搬到根级 hook，先保持现有功能可用。校验整个页面只有一处订阅和提交入口。
- [x] 将导航和消息展示提取为受控组件。把 modal／drawer 承载留在 App；显示状态按 sessionId/taskId/fileRef 保存，不跟随组件挂载重置。
- [x] 使用 CSS token 和局部样式实现默认两栏、按需文件区、窄屏返回。保留中文输入法、Option+M、Enter／Shift+Enter、Esc、背景 inert、焦点恢复。
- [x] 验证切换项目、开关／卸载面板、调整窗口后草稿与 pending 仍在；迟到响应不能切错对话，开关面板不触发模型调用。

**检查：** 复用 `node --test test/gui-components.test.js test/gui-view.test.js test/gui-controller.test.js test/gui-history.test.js test/gui-partial.test.js`；运行 `npm run build:gui`，实际浏览器走切换与草稿路径。现有测试足够时不新增测试。

### P2：归档、置顶、搜索与项目导航

**Files：** 新增 `src/session-ui-state.js`；修改 controller/server/api、Navigation、Settings、useGuiWorkspace；扩展现有 controller/history/server 测试。

**Consumes：** writer 与原子保存、Pi 会话 ID、P1 命令入口；**Produces：** 第 3.2 节的持久 navigation、查询与 settings 归档页。

- [x] 实现元数据读写、revision 校验、坏文件只读处理、忙碌检查和归档后释放空闲占用；不要移动 Pi JSONL。
- [x] 接入 archive/pin 操作和 sessions 查询。把归档、恢复、置顶都接到同一命令；Settings 和普通列表复用同一行的选择／菜单行为。
- [x] 实现设置内归档搜索、查看、恢复，及就近归档／撤销。归档最后一个可见对话后显示项目空态，不自动造新记录。
- [x] 项目切换恢复该项目最近可见对话；全局新建明确继承当前项目，保留“无项目”路径。项目折叠和列表位置只是显示偏好。
- [x] 用真实临时 home 重启宿主验证恢复；覆盖 revision 冲突、原子写失败、占锁、运行中、损坏记录和空白会话。未知响应先读取，零模型调用。

下面的行为例子可加入现有 `test/gui-controller.test.js`，沿用该文件已有 `controller`、`fixture`、`finished` helper；新增方法来自第 3.2 节，不用模拟数据库代替持久化：

```js
const f = await fixture(t, (_, n) => ({text: `reply ${n}`}));
const c = await controller(t, f);
const s = await c.action('session.create', {project: null});
const run = await c.action('task.submit', {
  sessionId: s.id, input: 'archive case', submissionId: 'archive-case'
});
await finished(c, run.taskId);
const original = await c.session(s.id), calls = f.calls.length;
await c.close();
const history = await controller(t, f);
await history.action('session.archive', {sessionId:s.id, archived:true, expectedRevision:0});
await history.close();
const reopened = await controller(t, f);
const archived = await reopened.session(s.id);
assert.equal(archived.navigation.archived, true);
assert.deepEqual(archived.turns, original.turns);
await reopened.action('session.archive', {
  sessionId:s.id, archived:false, expectedRevision:archived.navigation.revision
});
assert.equal((await reopened.session(s.id)).navigation.archived, false);
assert.equal(f.calls.length, calls);
```

**检查：** controller/history/server 的已有组合；浏览器完成“归档 → 刷新 → 设置中搜索 → 查看旧文件 → 恢复”。通过标准是内容和状态保真，不是菜单 DOM 数量。

### P3：接上真实 Team 与输入区

**Files：** 新增 TeamPanel，从 Settings 提取现有 TeamSettings／ModelEditor；修改 Composer、App、useGuiWorkspace；复用 `src/teams.js`、`config.js`、`gui-settings.js` 规则，只有实际缺口才修改控制器。

**Consumes：** bootstrap.teams/models/providers、session.team 快照，以及既有 `team.save`、`team.remove`、`session.team`；**Produces：** 输入区 `team` 与 `/team` 共用的一套完整操作。

- [x] 按原型提供选择、新建、基于当前组合调整、另存、删除；真实模型和思考档位来自 SDK 投影，不把示例模型列表写进生产。
- [x] 复用 `switchMainModel` 的主副交换语义与当前模型引用校验。副模型顺序可调；至少一个副模型、名称唯一、输出额度合法、当前和最后一个保护由后端最终检查。
- [x] 保存与切换分开报告结果；变更组合不回写旧回复或旧会话。已删除组合的历史快照仍可读；新对话继承最近合法选择。
- [x] 在同一命令入口处理 `/team`，不把它发给模型。运行中管理限制和下一条模式提示沿现有规则，草稿保留。
- [x] 输入区保持一个发送按钮；制作 HTML/SVG 是一次性 workRequest 选项。额度摘要从当前实际配置派生，不能设置额度后仍显示“未设限”。

**检查：** `node --test test/pi-teams.test.js test/pi-team-session.test.js test/pi-model-switch.test.js test/gui-controller.test.js test/gui-components.test.js`。浏览器验证新建／选择／参数／另存／取消删除／2→1／禁止1→0／历史保留／跨项目切换。优先复用现有用例，只补真实接口接线缺口。

### P4：可信文件清单、读取与逐文件差异

**Files：** 新增 `src/gui-files.js`；修改 gui-work/controller/server/api、新增 FilePanel，精简 Collaboration 中的 Changes 展示。扩展现有 integration/server/visual/package 测试。

**Consumes：** P0 已确认的读取路线、现有 fixed-version diff 与 artifact；**Produces：** 第 3.3 节的文件合同和前端文件阅读。

- [x] 从任务固定终点生成文件清单；内容引用同时绑定 taskId/version/path。将现有下载补丁、reveal 和检查信息接入成果区。
- [x] 按 3.3 实现内容限量、对象校验、格式与路径检查。身份不符、文件不存在、版本过期、超限和无可信目录均返回明确拒绝，不读取最新工作树补缺。
- [x] 逐文件差异必须正确处理中文、空格、重命名、删除、二进制及执行位。不能简单按文件名字符串切整段 patch；以既有结构化结果确定文件边界，必要解析仅放在 gui-files 一处。
- [x] 先完成文本／代码／Markdown／图片与下载，再接静态 HTML/SVG 及已有截图；不执行生成代码，不加载外部资源。文件区关闭、页签切换和跨项目切换不重新运行模型。
- [x] 回复中的成果入口直接打开本次文件；文件不再位于 roster／长版本号之后。详细来源和检查仍可展开，原始事实不删。
- [x] 用两个内容不同的正式版本验证旧任务仍读旧文件；试验篡改成果目录、路径穿越、符号链接、外部硬链接、超大文件和包含脚本的 HTML，检查拒绝／隔离边界。

**检查：** 复用 `node --test test/gui-integration.test.js test/gui-server.test.js test/gui-visual.test.js test/gui-package.test.js`；当前用例未覆盖的文件合同可在这些文件增补或新增聚焦的 `test/gui-files.test.js`，不建立第二套端到端 runner。浏览器实际打开、切换并下载一个文件，核对字节与固定版本。

### P5：完成项目、设置与异常路径

**Files：** Settings、ProjectDialog、Conversation、Collaboration、Composer、useGuiWorkspace；对应局部样式和已有组件／HTTP 测试。

**Consumes：** P1—P4 的真实命令与投影；**Produces：** 没有假按钮、重复入口或误导状态的首轮完整工作区。

- [x] 设置分类为“已归档、模型与认证、项目执行、偏好与更新”。Team 编辑只由同一 TeamPanel 负责；设置不复制另一套阵容表单。
- [x] 项目入口保留可靠路径输入及最近项目，选择后只读检查；默认前置未提交修改、缺执行环境等实际阻碍，版本和 JSON 收入详情。宿主文件夹选择若未完成，明确使用路径入口，不能用上传文件夹伪装本机路径。
- [x] 执行记录放回对应回复；默认成果／变更区不显示完整阵容。保留工具、评审、实际处理理由、视觉检查的来源与区别。
- [x] 活跃状态、取消、partial、未知提交、会话占用和损坏分别提供具体下一步。普通更新与正常连接不抢占工作区；明确当前安装版本与新版本提示的区别。
- [x] 实际跑通空配置引导、没有项目、没有成果、没有归档、没有搜索结果，以及任务执行中的导航。未接入的能力不放一个看似可用的空按钮。

**检查：** 相关 components/controller/partial/updates 测试与浏览器路径；不根据内部 hook 数量或截图像素完全相等定义成功。

### P6：组合验收、维护验证与文档交付

**Files：** 已有测试、构建／安装脚本、README、CHANGELOG、VALIDATION；必要时更新 GUI 文档入口。仅修复新发现的实际缺陷，不借收尾重构无关代码。

**Consumes：** P0—P5 的可运行成果；**Produces：** 可使用的新 GUI、可安装候选、文档和有边界的验证记录。

- [x] 复核改动范围与新增模块必要性，完成规格逐项对应检查。正式组件不依赖原型文件、静态示例内容或其 localStorage 键。
- [x] 在同一 root 状态保持的情况下，检查 TeamPanel 由不同承载层打开、文件区折叠／卸载及宽度变化；确认草稿、历史选择、pending 与模型调用不随布局变化。若用临时移动入口验证边界，不把第二套布局或测试专用业务开关留进产品。
- [x] 完整运行现有 `npm test`、`npm run test:agent-sync-core`、`npm run test:gui`、`npm run test:pi-terminal`、`npm run build:gui`。缺 Docker 等环境先补齐或明确失败，不改成任意 skip。
- [x] 从当前源码 `npm run pack:npm -- <隔离输出目录>`，在全新含中文／空格的 prefix 安装；依据实际 package 版本和 pack 元数据核对 CLI、GUI、静态资源与新模块字节。`package.json.files` 显式纳入新增宿主模块和 GUI 目录，不能只在源码树中通过。
- [x] 浏览器覆盖项目切换／草稿、设置归档／重启恢复、真实 Team 操作、固定版本文件预览／下载、partial／未知状态和键盘焦点；桌面、中等窗口与窄窗口都走实际主要路径，记录截图及 console。
- [ ] **本轮未授权、未执行：**重用 `.github/workflows/gui.yml` 的平台入口，在具备当次远端授权时运行 Linux ARM64、Windows x64／ARM64；Windows ConPTY 使用命名后端 0，不能把旧 WinPTY 当作 ConPTY。未取得的 CI／实机证据明确列出，不用本地结果代替。
- [x] 更新实际能力文档，记录 source SHA、包哈希、输入版本、失败与未验项。新增本地检查点只暂存明确文件；推送／发布／全局安装按当次授权执行。

P6 当前证据：整分支独立审查 Spec通过／Quality Approve；临时 React＋happy-dom 同root载体验证在Modal／drawer之间保留草稿、selectedSession、pending ID，仍只有原始一次submit，未增生产切换（这是状态边界检查，不是浏览器布局评分）。源码主套件302通过／3项既有Windows平台skip、内核48/48、GUI106/106、PTY17＋45＋6、构建通过；初候选中文／空格prefix离线安装、实际入口／62静态资源／1439源码与SDK字节、安装后组合74/74通过。原始GUI旧入口和PTY环境失败保留，详见 [VALIDATION](../../VALIDATION.md)。主代理在安装候选实际宿主完成设置、Team、静态预览／原始下载及1440／1040／620宽度路径，pageerror为0；与各阶段的归档重启、旧版本及未知提交证据共同满足首轮范围。最后README入口修订包重新离线安装与实际CLI／静态资源校验通过，与浏览器所验包仅README字节不同；安装回归、现场浏览器和最终包的对应关系在本地delivery-manifest.json，未把等同运行字节写成重复执行。根版本0.8.7-modes.1保持不变，本地候选未发布。远端平台行因本轮未授权而保持未勾选，不能用本机结果代替。

## 5. 测试放在哪一层

| 要守住的行为 | 合适的验证 | 不采用的替代指标 |
| --- | --- | --- |
| 归档恢复后内容仍在 | 临时真实 home、重启 controller／HTTP、核对正文和原文件 | localStorage 演示、状态变量等于 true |
| Team 与历史不串用 | 既有核心 Team 测试＋真实 GUI action＋浏览器操作 | 只检查按钮文字 |
| 布局变化不丢草稿／重复提交 | 面板开关、会话切换、迟到响应和未知提交路径 | hook 或组件调用次数 |
| 文件确实属于该任务版本 | 两个不同版本、内容身份和下载字节比较 | URL 包含任务 ID 或页面出现文件名 |
| UI 容易使用 | 实际项目、归档、Team、文件四条路径及用户反馈 | 测试数量、任意设计总分或截图存在 |

只在已有覆盖不足时补测试，修 bug 不机械新增测试。明确失败是环境、fixture 过时、实现还是验证脚本问题；不隐藏旧失败，不自动重试未知模型请求。

## 6. 迁移与回退

- 既有会话没有 navigation 时按未归档、未置顶读取；不批量改 Pi 日志，不重写旧 Team。新元数据版本独立于模型运行格式。
- 旧 GUI 或 CLI 忽略新展示元数据时，仍能读取原历史。归档不是安全权限，因此不能把旧客户端能看到归档记录称为数据泄露或悄悄封锁旧入口。
- 原型数据不导入正式产品。浏览器显示偏好加版本和合法 ID 校验；失效只影响布局偏好，不清除宿主事实。
- 每个阶段可以形成可恢复的本地提交，业务与元数据格式变化和大面积样式变化不混在同一提交里。版本切换失败保留现场；回退程序不删除新导航状态和成果。
- 当前 writer／原子写语义、未知提交关联和正式版本保持不变。只有对外合同确实改变时才更新文档与相应检查，不为每次摆放按钮升级数据格式。

## 7. 文档同步规则

实现过程中，交互要求归 REDESIGN_PROPOSAL，模块与接口归本文，运行政策归 DESIGN_BASELINE。以后改布局只更新相关布局段，不把全部规则复制到新文档；改变实际能力后更新 README／VALIDATION 的对应部分。

Task 的执行过程、截图和日志留在 `work/gui/`，不持续扩写 README。历史首版计划与旧验收保持当时事实，只在文件开头标明新的设计／施工入口。AGENTS 的 GUI 路由保持指向现行说明；其中只保留稳定边界、当次授权和链接。

## 8. 首轮完成标准

- [x] 设置内能查找、打开、恢复真实归档记录，刷新及重启后事实一致。
- [x] `team` 使用真实模型目录和现有核心规则；创建、调整、删除和历史保护都可检查。
- [x] 项目与对话切换保留草稿和正确上下文；单活跃任务及未知提交约束仍成立。
- [x] 文件／差异明确绑定任务版本，真实读取与下载受限；不以当前工作树替代历史成果。
- [x] 默认工作区没有空协作栏，文件区没有被阵容和技术回执挤占；窄窗口可返回并恢复操作位置。
- [x] 布局、功能和宿主事实按本方案分工，移动一个入口不需要修改核心业务；没有为未来猜测添加通用平台。
- [x] 所需检查、构建、安装候选与实际浏览器路径有证据；未授权或未取得的验证单独注明。

## 9. 规格对应与当前验证状态

| 设计内容 | 施工归属 |
| --- | --- |
| 项目／对话主工作区、按需阅读区、视觉与响应式 | P1、P5 |
| 设置内归档、恢复、置顶、本地内容搜索 | P2 |
| 输入区 team、完整组合管理、模式及政策摘要 | P3 |
| 成果文件、固定版本差异、下载和检查事实 | P4 |
| 项目入口、认证／执行设置、更新及异常表达 | P5 |
| 草稿、历史、权限、未知结果与安装入口 | P0 核对，P1—P5 各自落实，P6 组合验证 |
| 文件引用、真实附件、历史分支与新执行能力 | 第 10 节后续增量，不伪装成本轮已交付 |


本轮核对了当前源码中的控制器、API、会话／Team、文件读取、原子写与 writer、已有 GUI 测试，以及原型反馈。文档链接／结构检查由 Doc maintenance 执行，检查结论记录在本次交付中。该检查不证明未来实现、模型质量、跨平台行为或用户使用感受已经通过。

## 10. 后续增量的接入方式

| 后续需要 | 从哪个现有边界进入 | 开始前必须明确的合同 |
| --- | --- | --- |
| 项目文件引用、图片／文档附件 | Composer 的材料选择 + 单一提交命令 | 读取范围、大小、格式、模型能力及提交时的内容快照；不能只画上传成功 |
| 从历史新建分支 | 工作区命令 + controller + Pi 公共 fork 能力 | 合法祖先位置、兄弟分支隔离、新 ID／新提交归属；原会话不改写 |
| 宿主目录选择、非 Git 文件制作 | ProjectDialog + 受限宿主能力 | 真实宿主路径、用户明确选择／初始化；浏览器上传不是本机目录授权 |
| 交互式 HTML 预览 | gui-files + 独立的预览执行边界 | 脚本、网络、来源隔离、资源额度和退出；不得执行于 GUI 凭据所在同源页面 |
| 并行用户任务／写回原项目 | 单独的核心行为提案 | 调度、权限、冲突、取消和回退；不能当作布局配置顺带开启 |

这些方向不提前创建空模块、占位 endpoint 或插件接口。需求到来时补充相应合同和验证，复用已完成的工作区命令与数据来源。
