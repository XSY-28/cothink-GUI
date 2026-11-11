# GUI 统一思考强度施工方案

> 2026-11-11 已实施并本机安装。GUI 280/280、Pi 280 通过（4 项平台跳过）、实际 App 121/121。构建与安装回执见本机 work/unified-thinking。

**目标**　在发送按钮左侧提供一个思考强度按钮。用户显式选档后，本对话后续新任务的主模型、员工、过程检查、成果评审和经理汇总均使用该统一档。

**架构**　复用会话的 `cothink-thinking` 设置、宿主提交锁、冻结配置、各角色的 `modelRef.thinkingLevel` 和唯一 Pi 调用路径。在会话选择进入任务快照时应用统一档，运行端继续消费各角色的有效配置。

**技术栈**　现有 Node.js ESM、React/Vite、Electron、Pi SDK、本机 HTTP/SSE、node:test、Happy DOM 和 Playwright。

**需求依据**　本次用户选择先实施方案一，GUI 采用发送按钮左侧的紧凑调整按钮。产品语义见本文第二节，项目约束见[设计基线](../../../DESIGN_BASELINE.md#目标与最小路径)。

## 1. 本次核对的代码

源码基准为私有维护仓库提交 `bf25d3c69725753fc5ad33030d40b083dca9d5d9`，版本 `0.8.14-desktop.5`。已按模块拆分后的代码定位，主要事实如下。

| 现有入口 | 实际行为 | 对本次施工的影响 |
| --- | --- | --- |
| [Composer.js](../../../gui/src/Composer.js) 的 `composer-options` | 底部已有添加入口与发送按钮，发送按钮用 `margin-left:auto` 贴右 | 增加右侧按钮组，思考按钮与发送按钮相邻 |
| [TeamPanel.jsx](../../../gui/src/features/teams/TeamPanel.jsx) | “此对话的思考设置”藏在阵容面板内，实际覆盖主模型 | 主入口迁至输入区，旧主模型设置需要明确识别 |
| [gui-controller.js](../../../src/gui-controller.js) 的 `session.thinking` | 经 `writeSelection` 保存 `cothink-thinking`，调用 `validateGuiThinking` | 沿用同一保存动作与锁 |
| [gui-settings.js](../../../src/gui-settings.js) 的 `validateGuiThinking` | 只验证 `team.main` | 扩展为按设置范围验证主模型或整份阵容 |
| [conversation.js](../../../src/conversation.js) 的 `readConversationMetadata` | 读取最近一条 `cothink-thinking.level` | 增加范围读取，缺范围的旧记录仍按主模型解释 |
| [gui-controller.js](../../../src/gui-controller.js) 的提交与上下文整理 | 当前只修改 `effective.main.thinkingLevel` 或 `snapshot.config.main.thinkingLevel` | 提交快照是统一档应用的主要接入点 |
| [discussion.js](../../../src/discussion.js) 的 `runTurn` | 克隆配置、补默认档、保存有效阵容并创建角色运行时 | 可直接承接已经应用统一档的配置 |
| [process-check.js](../../../src/process-check.js)、[project-readonly-roles.js](../../../src/project-readonly-roles.js)、[project-manager-report.js](../../../src/project-manager-report.js) | 从所属任务配置或传入的 `modelRef` 创建 Pi 运行时 | 优先验证既有传递，发生漏传才在该处修正 |
| [project.js](../../../src/project.js)、[project-file-confirmation.js](../../../src/project-file-confirmation.js) | 正式项目与确认保存并使用 `frozenConfig` | 原提议的确认和原尝试恢复使用其已冻结档位 |
| [thinking.js](../../../src/thinking.js)、[pi-runtime.js](../../../src/pi-runtime.js) | SDK 能力查询、显式档校验、创建与切换模型已有实现 | 复用现有能力，GUI 展示 SDK 返回的档位名称 |
| [request-policy.js](../../../src/request-policy.js) | 保存 `requestedModel`、`actualModel` 和脱敏后的实际 `payload` | 用这些证据核对实际发送参数 |
| [project-native-host.js](../../../src/project-native-host.js) | 插件子代理从冻结阵容取模型，并计算和使用 `effectiveThinking` | 原生子代理也纳入统一档验证 |

本次已运行三个现有用例，均通过。它们证明当前主模型档位切换、提交冻结、清除覆盖可以工作。全阵容统一行为属于下面的新增验收。

```sh
node --test --test-name-pattern='model switching defaults|accepted submit freezes|explicit follow-Team choice' test/pi-runtime.test.js test/gui-controller.test.js
```

维护工作树另有文档整理中的修改。实施前重新检查变化文件与源码版本，以函数职责定位接缝，保留并行工作成果。

## 2. 产品语义与兼容规则

### 2.1 输入区

底部布局为左侧添加入口，右侧相邻的“思考 high ▾”与发送按钮。按钮点击后向上打开紧凑菜单，包含“跟随阵容”及当前主、副模型共同支持的档位。样式使用现有字体、颜色、圆角和控件高度。

- 默认采用当前会话已保存的设置。没有覆盖值时显示“思考 默认”，展开后说明跟随阵容各模型参数。阵容中未指定的可思考模型按现行默认 `high` 处理。
- 用户显式选档后按对话保存，后续新任务持续沿用。新对话从自己的阵容参数开始，分支按已有会话继承规则还原设置。
- 运行中可以为下一条任务改档，菜单注明“作用于下一条消息”。当前任务、已发请求和已冻结提议按原快照执行。
- 首页尚无 Team 对话或尚未绑定阵容时，按钮显示禁用状态并说明先选择对话阵容。这与当前首页先带稿进入 Team 对话再发送的流程一致。空的新对话绑定阵容后，首次发送前即可选档。
- 保存中、提交确认中、归档、只读、上下文整理或断线时按对应状态禁用。档位保存未确认时阻止新提交，草稿继续保留。
- 支持键盘打开、方向键选择、Enter 确认、Esc 收起和焦点返回。菜单按会话身份管理，切换会话时收起。

### 2.2 支持范围

新按钮提供全阵容共同支持的 SDK 档位，以主模型返回的顺序求交集。显示实际名称，如 `low`、`medium`、`high`、`xhigh`、`max`，避免调用旧 CLI 将 `low/high/max` 显示成“低/中/高”的别名函数。

共同支持的判断包含阵容中全部主、副模型。非思考模型按 SDK 返回的能力参与判断，不能伪造 `high`。共同档位为空时显示具体不兼容模型，允许选择“跟随阵容”或调整阵容。模型目录缺失时保留旧选择并提示修复，发送前由宿主重新校验。

方案一中的检查员也使用统一档。后续方案二所讨论的“检查固定 high”属于另一轮设计。

### 2.3 旧记录和接口

复用 `cothink-thinking` 事件，只增加必要的范围字段。

```js
// 既有记录，语义继续为仅主模型
{ level: "low" }

// 新按钮保存的记录
{ level: "low", scope: "all" }

// 明确选择“跟随阵容”
{ scope: "all" }
```

`readConversationMetadata` 在已有 `thinking` 旁返回 `thinkingScope`。有档位、缺少范围的旧记录解释为 `main`。旧记录在新按钮上显示“主模型 low”，菜单说明这是历史设置；用户再次选档后才转为全阵容范围。未知范围报错并保留历史。

`session.thinking` 接受 `{sessionId, level?, scope?}`，`scope` 缺省按旧的 `main` 解释，新按钮始终传 `all`。清除覆盖后恢复阵容参数。阵容面板保留每个模型自己的默认参数编辑，原“此对话思考设置”改为只读摘要并指向输入区按钮。

由于旧后端会忽略未知参数，新的客户端必须确认后端支持全阵容语义。使用现有 `GUI_INPUT_VERSION` 版本门槛，从 `3` 升到 `4`，草稿的 `editorVersion` 保持现有格式。按钮与新提交核对 bootstrap 版本，旧页面写入沿现有 `GUI_INPUT_UPGRADE` 规则拒绝，历史和提交回执仍可查询。

### 2.4 冻结与恢复

设置读取、能力校验、配置复制和快照发布放在已有提交准入与 `writeSelection` 顺序中。保存设置与提交同时发生时，以锁内实际接受顺序为准。

统一档只写入本轮配置副本的 `main.thinkingLevel` 与每个 `secondary[].thinkingLevel`。保存的具名阵容保持其默认参数，`runTurn` 继续生成本轮有效快照。所有角色从本轮配置取得各自的模型引用。

确认已有提议使用原 `source.frozenConfig`。原尝试恢复使用它的尝试配置。用户明确发起的新一轮续作按现有新任务准入选择当前设置，既有已完成成果及其请求仍保留原档位。验收分别覆盖这些入口。

上下文整理只调用主模型，复用同一设置解析，实际请求使用当前选档。CLI 对统一 GUI 会话已有只读限制。其两处旧会话参数读取也要识别 `scope`，因为 GUI 可能在旧会话第一次转为统一流程之前保存新设置；缺少范围的历史记录仍只作用于主模型。

## 3. 保持灵活性的具体做法

把“选择档位”与“运行模型”放在现有两处职责内。当前由用户选择，提交时生成各模型的有效引用；将来方案二可以在直属负责人派工时，生成带子任务档位的角色模型引用，继续交给同一个 `resolveModelThinking` 和 `createRuntime`。

本轮所需的新数据只有会话设置的 `scope`。任务已有模型引用、冻结配置和请求正文足以保存执行证据。复用现有模块与测试文件，开发内容集中在设置、快照与输入区，agent-sync 继续负责版本与接纳。

实现时尤其避免把统一档硬编码到 `createRuntime`、请求传输层或全局模型目录。那些位置应消费传入的角色配置，这样未来同一模型的不同岗位才能使用不同档位。

## 4. 施工任务

### T1 扩展设置范围并保留旧语义

**修改文件**　`src/conversation.js`、`src/gui-settings.js`、`src/gui-controller.js`、`src/gui-turn-options.js`。

**复用测试**　`test/gui-controller.test.js`、`test/gui-server.test.js`。

- [x] 在现有 `cothink-thinking` 读取处加入范围校验与 `thinkingScope` 投影；旧无范围记录解析为 `main`，清除覆盖表示回到阵容参数。
- [x] 将 `validateGuiThinking(home, team, level, scope = "main")` 扩展为按范围选择模型后逐个调用 `validateModelThinking`。`all` 中任一成员不支持时返回包含模型标识和可用档位的错误。清除覆盖应可执行，以便修复失效偏好。
- [x] `session.thinking` 在保存前验证范围与档位，随后一次追加事件。会话读取响应返回 `thinkingScope`。保留原有写入失败、归档和占用保护。
- [x] 升级现有 GUI 输入协议门槛，核对新旧客户端交叉连接。历史缺字段继续可读，未知提交仍查询原回执。
- [x] 扩展现有保存与清除覆盖用例，验证设置动作零模型请求、旧主模型设置、全阵容设置、清除、重开与分支继承，以及不兼容副模型在保存前拒绝。

新接口的测试调用形式如下，使用现有 fixture 中的真实会话。

```js
await c.action("session.thinking", {
  sessionId: s.id,
  level: "low",
  scope: "all",
});
const saved = await c.session(s.id);
assert.equal(saved.thinking, "low");
assert.equal(saved.thinkingScope, "all");
assert.equal(f.calls.length, 0);
```

测试应在创建 controller 前，把该用例的模型目录设置为支持所测档位。继续保留默认非思考模型的共享 fixture，用它验证不兼容组合。

### T2 在快照接缝应用统一档

**修改文件**　`src/thinking.js`、`src/gui-controller.js`、`src/interactive.js` 的两处设置读取。只有证据表明传递缺失时才改对应角色入口。

**复用测试**　`test/gui-controller.test.js`、`test/unified-gui.test.js`、`test/gui-context.test.js`、`test/pi-session.test.js`。

- [x] 在 `thinking.js` 增加一个供提交与上下文整理共同使用的纯函数 `applyThinkingSelection(config, {level, scope = "main"})`，返回配置副本。值缺省时返回原配置语义，`main` 只覆盖主模型，`all` 覆盖所有主、副模型引用，非法范围拒绝。
- [x] 替换 GUI 两处只给主模型赋值的逻辑。普通新提交先校验本次有效阵容再应用选择；已确认提议沿用保存的配置。上下文整理应用选择后校验实际使用的主模型。
- [x] 让 `runTurn` 沿用自己的默认值解析、有效阵容快照、`projectRoutes` 和运行时创建。保持 `config.team` 作为所选阵容来源，避免清除覆盖后失去模型原参数。
- [x] 在已有“提交后立刻改档”用例中把覆盖设成 `all`，验证当前所有角色仍为旧档，下一条为新档。增加“选档后换阵容导致不兼容”的提交前拒绝，要求零物理请求。
- [x] 对已有提议确认、重开后确认、原尝试恢复和明确新一轮续作分别断言档位来源，保留原任务身份与未知请求处理。
- [x] `interactive.js` 的 `create` 和 `session_tree` 两处读取复用同一函数，随后沿用各自已有的能力校验与 Team 快照处理。验证旧记录仍只覆盖主模型，带 `all` 的记录按全阵容解释，统一 GUI 会话仍在初始化模型前按原准入规则处理。

纯函数保持如下规模，具体模型能力由调用方已有验证入口核对。

```js
export function applyThinkingSelection(config, { level, scope = "main" }) {
  if (scope !== "main" && scope !== "all") {
    throw new Error("无法识别思考档位的作用范围");
  }
  const effective = structuredClone(config);
  if (level === undefined) return effective;
  const models = scope === "all"
    ? [effective.main, ...effective.secondary]
    : [effective.main];
  for (const model of models) model.thinkingLevel = level;
  return effective;
}
```

### T3 验证所有实际调用继承统一档

**核对入口**　`discussion.js`、`project-readonly-roles.js`、`process-check.js`、`project.js`、`project-manager-report.js`、`project-native-host.js`、`pi-runtime.js`、`request-policy.js`。

**复用测试**　`test/unified-turn-readonly-supervision.test.js`、`test/unified-project-process-check.test.js`、`test/unified-gui.test.js`、`test/agent-sync-project-native.test.js`、`test/pi-runtime.test.js`。

- [x] 在已有只读组队场景加入统一档，覆盖经理、子负责人、员工、定时过程检查和独立报告审查。核对已经保存的 `requestedModel` 与 fixture 接收的请求正文。
- [x] 在正式文件组队场景核对冻结配置传入文件执行者、过程检查与经理最终汇总；原生插件子代理核对 `effectiveThinking` 与宿主最终请求。
- [x] 在一个现有支持 `thinkingLevelMap` 的模型夹具上验证 SDK 映射后的服务参数。非思考模型与共同档位为空沿 T1/T2 的准入行为处理。
- [x] 针对漏传做最小修补，并重跑暴露它的现有场景。请求层继续保存已有脱敏 `payload`，校验实际发送字段，历史未知值按未知显示。

对于支持 `reasoning_effort` 的本地夹具，可直接核对本轮实际收到的每次请求。

```js
assert.ok(f.calls.length > 1);
for (const call of f.calls) {
  assert.equal(call.body.reasoning_effort, "low");
}
```

同时核对该用例确实产生了所要求的角色，避免仅主模型运行也让断言通过。其他协议按各自的真实请求字段检查。

### T4 接入发送按钮左侧的控件

**修改文件**　`gui/src/Composer.js`、`gui/src/styles.css`、`gui/src/features/conversation/Conversation.jsx`、`gui/src/useGuiWorkspace.js`、`gui/src/features/teams/TeamPanel.jsx`。

**复用测试**　`test/gui-components.test.js`、`test/gui-navigation-visual.test.js`。

- [x] 从 `boot.models` 的 `thinkingLevels` 与当前阵容计算可选交集，客户端用于展示，宿主负责最终校验。沿用模型标识匹配与已有 SDK 顺序。
- [x] 在 Composer 底部加右侧控件容器，把现有发送按钮的 `margin-left:auto` 移到容器，内部使用 flex 与现有间距。思考按钮紧邻发送按钮左侧，菜单右对齐并向上展开。
- [x] Composer 仅接收当前选择、可选档位、保存状态与 `onThinkingChange`。Conversation 将操作交给工作区 hook，hook 复用 `changeSession("session.thinking", {level, scope:"all"}, sessionId)`。
- [x] hook 为这次设置保存同步登记待确认状态，并让提交入口读取同一状态，避免点完档位立即发送却用到旧值。成功后使用宿主返回值；响应未知时只读查询原会话，确认前继续阻止发送。切换会话后的迟到结果只归属原会话。
- [x] 设置保存与自动草稿保存复用现有 `draftQueue` 排序。设置回执返回后，在草稿版本仍匹配时通过已有 `book.rebase` 更新分支锚点，保留期间新增的文字与材料；真实版本冲突沿用现有草稿冲突处理。验收快速输入、选档、立即发送这一条用户路径。
- [x] “跟随阵容”传 `{scope:"all"}`。已有主模型专属设置按第二节显示。阵容面板改成摘要，模型默认参数仍由原 ModelEditor 编辑。
- [x] 验证普通、运行中、保存中、未知保存、只读、无阵容和不兼容状态。验证长草稿、材料卡片、中文组合输入、键盘操作、浅色/深色及窄窗口。点击选档和打开菜单均为零模型调用。

### T5 同步文档并完成组合验收

**修改文件**　`DESIGN_BASELINE.md` 的调用设置、`README.md` 的 GUI 用法、`VALIDATION.md` 的本轮证据。发布版本时按项目约定同步 `CHANGELOG.md`。

- [x] 文档准确说明按钮位置、全阵容范围、原任务冻结、跟随阵容、旧主模型设置和不兼容提示。将方案二作为后续方向，以本轮实现范围解释已交付功能。
- [x] 先运行下面的聚焦组合，再构建 GUI 并跑已有视觉入口。若相关运行代码发生变化，按 `package.json` 补跑 `test:pi`、`test:app`、`test:gui`；涉及正式文件或插件路径时使用现有 Docker 与插件验收命令，缺环境如实记录。
- [x] 记录本地请求夹具、视觉、打包和真实服务各自的结果。收费模型验收、正式安装替换及远端发布按届时明确授权执行。
- [x] 若进入 macOS 交付，候选 App 放 `.noindex`，核对包内代码与资源，安装后按 bundle ID 检查 Spotlight、注销测试副本登记并实际搜索。

```sh
node --test --test-concurrency=1 test/gui-controller.test.js test/gui-server.test.js test/gui-components.test.js test/gui-context.test.js test/pi-runtime.test.js test/pi-session.test.js
node --test --test-concurrency=1 test/unified-turn-readonly-supervision.test.js test/unified-project-process-check.test.js test/unified-gui.test.js test/agent-sync-project-native.test.js
npm run build:gui
node --test test/gui-navigation-visual.test.js
```

## 5. 完成标准与重审条件

交付至少需要实际证明以下五点。

1. 在空的新对话首次发送前，以及已有对话中，都能从发送按钮左侧选档；选档成功以保存回执为准。
2. 统一档覆盖真实产生的经理、员工、检查与评审请求，协议请求正文能证明传参。
3. 运行中改档只影响后续新提交，提议确认与恢复使用原快照，结果未知的请求保持原身份。
4. 旧主模型覆盖、跟随阵容、阵容各模型默认值、重开和分支均能正确解释；不兼容选择在发送前可见。
5. 当前实现保持角色有效配置的传递方式，未来增加派工选档时可以复用同一 Pi 运行入口。

本方案的默认选择为“沿用会话已有设置，未覆盖时跟随阵容”。GUI 按当前模型目录严格提供公共档位。如果用户希望混入非思考模型时仍对其他模型统一选档，需要另行明确这个例外的界面与语义。当前按严格方案一验收。

施工前重新核对模块与调用关系。如果模型路由已迁移，按现有职责更新接入位置；如果实际调用链暴露独立模型绕过冻结阵容，先固定失败证据并在该宿主接缝处理。
