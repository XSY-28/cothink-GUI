# CoThink 可恢复长任务与草稿交付施工方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 不预设多人施工；任务内步骤使用复选框跟踪。

**Goal:** 让实际软件任务在已授权范围内完成有用的协作和文件交付；遇到可隔离的模型连接中断时，保留原未知记录，从已保存版本继续；确实不能继续时，用户仍能取得明确标记的草稿及具体原因。

**Architecture:** 保留唯一 Pi 调用通道、现有 Team/会话/根任务/项目调度，以及 agent-sync 的权限、版本、隔离执行和接纳边界。改动集中在 CoThink 的恢复准入、文件展示、能力登记和规划材料。恢复使用已有版本及 `beginChange({restoreFrom})`，不增加第二套调度器、文件复制协议或状态数据库。

**Tech Stack:** 现有 Node.js ESM、Pi 1.4.0-cothink.3、agent-sync 公共 JS API、React/Vite、Electron、固定离线 Docker 镜像；不新增运行依赖。

**Spec:** 本聊天已确认的五点修改方向，具体契约收敛于本文[设计约定](#设计约定)。现行边界见 [DESIGN_BASELINE.md](../../../DESIGN_BASELINE.md)。本文是待施工方案，不表示功能已经实现或真实长任务已经通过。

## 全局约束

- 源码基线：`0742d0f260ef63cf90dca812dceb0ff0b393620a`，版本 `0.8.14-desktop.10`；施工前重新核对 HEAD 和变化文件，保护后续用户修改。
- 本轮仅编写、检查方案；不运行收费模型、不修改用户配置、不安装、不提交或推送代码。后续实施沿届时明确授权，已有授权不重复索取。
- `packages/agent-sync/**`、Pi vendored 补丁及调用协议不在本轮修改范围。公共接口若存在经复现的真实缺口，先明确缩小目标或重新评估，不能在调用方绕过内核。
- 保留原始题意、已确认范围、权限、检查和正式 ref；保存旧失败、部分内容、未知请求与未知费用。禁止靠改状态、换 ID、换项目名来重放原未知操作。
- 自动原样重试、自动压缩、预热仍关闭；不新增隐藏的总调用上限、模型超时或可省略的输出额度。下文的继续是有明确来源的新尝试，不是模型请求重试。
- 主模型仍负责沟通、调度和最终交付；组队后的既有过程检查保留。不新增分类模型、校准请求或固定审查层。
- 新源码文件遵守现有大小门槛；既有超长文件只接入本次职责。需要抽取时按完整职责抽取，不能机械拆碎、压缩代码或删除必要说明来绕过检查。
- 文档随行为同步；README 面向使用，DESIGN_BASELINE 记录规则，VALIDATION 记录实际证据。不要把本文变成新的常驻流程系统。

## 问题与完成标准

| 已观察问题 | 本次必须产生的用户结果 | 归属 |
|---|---|---|
| 有固定版本草稿，界面却显示无成果 | 在原回复文件区查看、导出“未验收草稿”，无须模型或 Docker | 任务 1 |
| 模型结果未知把后续工作永久锁住 | 具有明确授权、旧本地执行已结清且无相关未决副作用时，能开启后续尝试 | 任务 2 |
| 恢复时模型重新输出整份源码 | 宿主恢复准确的候选文件，模型只处理剩余工作 | 任务 2 |
| 旧导入的 32k 被当作真实容量 | 能明确核对、保存模型能力；未核实值不冒充官方规格 | 任务 3 |
| MCP 不可见、参数误用、只读岗位被要求试玩 | 规划者看到真实能力和可执行参数，职责与工具相符 | 任务 4 |
| 我额外强化了每阶段多员工要求 | 对明确要求组队的本次测试，以经理和一个有用的副模型岗位起步，按工作需要增加 | 任务 4 |
| 模拟运行通过但真实链路中断 | 最小真实任务、受控中断恢复、完整任务分别验收 | 任务 5 |

系统指令裁剪和 Bash 未发送误分类已在 `.9/.10` 修复，本轮保留其回归，不重做一套实现。此次网络错误只能确认连接在响应头前关闭，不能断言由服务商还是中间网络造成。

## 设计约定

### 1. 草稿引用和读取

只引用已有任务、change 和不可变版本，不建立 checkpoint 数据库：

```ts
// 本文新增引用契约；不是任意 Git 表达式或宿主目录。
type DraftRef = { taskId: string; changeId: string; baseVersion: string; version: string };
// 扩展现有 FileRef，原有字段及正式成果语义保持。
type FileRef = {
  taskId: string; version: string; path: string;
  draft?: Pick<DraftRef, 'changeId' | 'baseVersion'>;
};
```

后端依据同一会话分支/项目的已保存记录和内核公开查询生成、验证引用。可读取路径受原任务授权约束；文件类型、大小、链接拒绝及静态 HTML 预览沿用现有实现。客户端不能靠填写版本号取得别的任务文件。

**只读取得草稿不要求任务成功、成果审查通过、Docker 可用或所有写入者停止。** 读取的是已经保存的不可变版本，不能改读正在变化的投影目录。某个草稿不可读时显示该条具体错误，仍显示其他可读成果。

优先展示领导草稿及已明确收取的员工草稿；多份未合并草稿分别显示来源，不按时间戳选择一个假装最终结果。“未验收”与文件的 added/modified/deleted 状态分开。静态预览仍不运行脚本；导出后用户可按项目说明打开或运行。

“导出草稿”将授权文件从固定版本写入既有任务 artifacts 的新子目录，完整写成后再返回，复用原打开目录/下载入口；不覆盖对话项目目录或用户编辑过的导出副本，不伪造 `deliveryRef`、正式接纳或测试通过。导出应包含该草稿授权范围内所需的项目文件，排除 Git 元数据及执行辅助产物；超出既有读取限额或缺少依赖时列出缺项，不称为完整可运行包。

### 2. 继续的范围与授权

普通 `resume/revise` 不因为实现本方案就自动忽略未知。通过现有回复操作提供“从保存草稿继续”，复用确认及提交回执机制；这是一项**新的执行尝试**，不是重发原 HTTP 请求。

继续前由宿主核对以下事实，模型自述不能代替：

1. 来源属于当前会话分支和同一项目，目标、版本、授权范围及正式 ref 能核对。
2. 原执行尝试的本地入口已封闭：原模型流/工具处理已结束或停止，旧 task/role 权限不能再驱动写入；相关本地执行及助手已结清。不能要求无法证明的“远端模型一定没有生成”，也不能仅看 PID 消失。
3. 与继续范围相关的内核命令、接纳、导入、MCP 外部操作和后台进程没有未决副作用。这里核对的是实际作用是否已结清，不要求所有历史输出都能找回。仅作用于选定草稿的受管离线副本的旧编辑/执行，即使结果回执未知，若公开内核已确认该 change 放弃、执行停止，且未涉及正式接纳或外部效果，可以明确不采用未确认产物，从已保存版本继续；原请求仍未知。未知接纳、导入、外部效果或无法核实的停止仍阻塞。沿用现有范围相交判定，无关且可证明隔离的工作不应额外阻塞。
4. 本次中断是模型回复丢失；与继续相关的本地状态已按上项核实。通过实际请求与已冻结能力核对，服务端没有绕过宿主的执行能力或不受管外部作业；存在这类能力时不能仅凭无返回 toolCall 就认定为纯模型请求。0 字节响应不是“未发送”证明；部分文本可留档，未完成的工具调用不得恢复执行。
5. 用户授权本次后续尝试，且原根预算剩余量和项目预算允许。旧未知调用仍占已发请求额度；未知费用保持未知。现有硬费用上限无法证明可满足时，不新增付费调用。

授权采用两种入口，复用原任务限制与确认记录，不做全局重试设置：

- **默认手动继续**：一次明确的继续操作授权一次新尝试，界面说明旧请求/费用未知、将使用哪个草稿及剩余预算。
- **无人值守的单次预授权**：在原任务开始前明确选择“仅模型连接中断且本地已结清时，允许从保存成果继续一次”。用原确认回执的单次消费控制它，后续尝试不自动获得新的预授权；再次失败仍可导出草稿、再由用户明确继续。首版不承诺连续多次失联后仍无限无人值守推进，不为此增加进度评分器或付费重试循环。这个可见的授权范围不改变原任务总调用额度。不得仅凭提示词中出现“不要提问”静默授予这一权限。

这是对现行“相同范围未知即阻塞”的**窄规则修订**，实施时同步设计基线；它不放开未决外部写入、停止未知、原内核操作重放或无来源的旧动作。只允许使用可核实的已保存版本，并不推断原请求成功或未发送。不是可靠性无限保证，也不更改原用户取消行为：主动取消不触发无人值守继续。

### 实测后的边界补充（2026-11-12）

原游戏实测发现：已明确继续的尝试若因已知错误结束，旧未知仍在账目中，普通 resume 又没有原许可。后续手动继续须逐条核对已有 command／reservation／根任务／请求的授权链，才能携带该历史许可；没有这条祖先的已知失败仍走普通任务或反馈，不获得未知例外。每次重新确认只启动一个新尝试，预算接续，自动预授权不续签。新未知及所有副作用仍分别核实。

资格检查与调度共用失败步骤的依赖闭包，检查完整执行范围；已在可信继续尝试中完成的前置步骤，不能被旧 unknown 重新降级。已有路线暂停及失败证据不能因新 revision 清除；新明确尝试先经原绑定裁决/实验。裁决请求实际发送的高优先级指令和工具集合必须与其权限一致，同一裁决回复中的其他工具不能取得后续修复权限，投影到发送之间状态变化时拒绝而不消费裁决机会。

### 3. 沿现有记录实现继续，不新增恢复状态机

新增信息放进现有根任务/命令/确认记录：

```ts
// 新尝试的 projectOperation 及既有 commands 回执引用同一份内容。
type FileContinuation = {
  sourceRootTaskId: string; stepId: string | null;
  requestIds: string[]; draft: DraftRef | null;
};
// 复用 authorizationSource，来源只能由用户入口/已冻结预授权构造。
type FileContinuationAuthorization = {
  kind: 'file_continuation'; sourceTaskId: string;
  mode: 'user' | 'preauthorized_once';
};
// 原任务真正完成本地结清后才保存。旧记录可用已有可靠回执复算。
// task.record.localExecutionClosedAt?: string  // ISO timestamp
```

`requestIds` 是核对后与该工作有关的未知模型请求集合，不是客户端任选的豁免列表。范围、revision、正式版本、配置、预算和输入摘要复用现有字段。仅当已有正式交付可核验、只剩经理终稿时，`stepId/draft` 同时为 null；它复用已有 `deliveryRef/reuseCompletedDelivery` 路径，只补终稿，不恢复文件或重置步骤，其他情况拒绝空引用。本轮预授权用已有 constraints 中的可选 `allowFileContinuation` 布尔值，缺失等同 false，由原任务限制的明确选择生成。`localExecutionClosedAt` 不能由“任务状态已改成终态”推导；持久化失败不算结清。会话对象可保持空闲，不要求退出整个 App 或销毁正常会话。

自动继续沿用已确认的模型路由、思考强度、权限和额度；配置变化不能借继续隐式生效。手动继续在确认中展示并冻结有效配置，实际调用仍经过原发送核对。后端不支持新能力时，旧端不发送新增字段；新端也不能把未知动作降级为普通提交。

新的授权只解除这些原模型请求对**该新尝试**的占用影响；原请求、原 attempt 和费用均不改成成功/未发送。新 attempt 通过后可以完成当前步骤，历史未知仍可查询并计账。普通新 ID、改名、模型提供的 `continuation` 字段均不能获得例外。

复用现有项目 writer、`reserved/consumed`、commandId 和 root 归属。重复点击、回执丢失或重新打开界面，先查询同一预留记录，不生成第二个后续尝试。自动接续回指原用户预授权并消费它，不能由模型或后续尝试再生成授权。旧正常提议的 `checkedProposal` 限制不放宽；用户继续授权单独校验后进入共用的预留/执行部分，不能把旧 `outcome_unknown` 根任务伪装成 `blocked`，也不能伪造 `start_work` 模型消息。

文件步骤使用既有修订机制，仅使失败步骤及其依赖步骤进入新 revision；无关已完成步骤保留。仅补经理终稿的路径沿用已核验交付，不制造文件步骤修订。**必须同时处理项目状态、发送占用、岗位占用及最终证据选择，不能只把界面的步骤状态改成 pending。** 各处读取同一已确认的继续引用，不各写一套放行规则。核对时发现原请求已有新的完整回执或版本发生变化，先刷新事实，不沿陈旧确认发起生成。

### 4. 复用内核恢复，不让模型重抄文件

当前 [agent-sync 公共接口](../../../packages/agent-sync/README.md#继续修改与恢复) 已有 `beginChange({restoreFrom})`。先使用公开 `inspect/read` 得到旧 base→draft 的变化路径，再核对这些路径在当前正式版本的内容及 mode：

- 当前仍等于旧 base：可恢复旧 draft。
- 当前已等于旧 draft：跳过这一路径，不能重复算新成果。
- 当前与两者都不同：报告具体冲突，交给已有的经理/冲突处理路径；不覆盖、不另造自动合并器。

`restoreFrom` 的作用范围是**确切待恢复路径**，不能直接传整个目录 scope，否则可能撤掉后来加入的无关文件。路径必须仍在本次授权及注册工作范围内；恢复新增、删除和 mode 变化，沿用现有普通文件限制。

将受控 `restoreFrom` 透传到已有 `createWorkChanges.begin(..., options)`，通过原意图/回执和 `v.beginChange` 进入新副本；后续范围调整仍走原 `refresh_change`。2026-11-13 用户明确修订：恢复副本取回原已确认阶段范围不再当作新增授权；范围外、其他副本及真正失败仍守原边界。不直接复制内部 workspace，不 reset/cherry-pick 正式 ref，不重开旧角色租约。恢复完成后第一次模型请求就能读到源码，只给它原任务、完整已知回执、草稿来源和剩余工作；不自动生成压缩摘要。

恢复不等于接纳：重新执行受影响的固定检查及已要求的候选审查。旧审查和截图保留为历史，不冒充新候选已验收；已完成、未受影响的资料查询和依赖步骤不原样重做。来源可核对、已完整收取并处理的员工贡献可以沿既有继承证据使用，不为恢复重新凑人数；参与证据与新候选的审查通过证据分别核对。

### 5. 历史边界必须诚实

旧记录缺少新字段，不直接回填 `not_sent` 或“已停止”，也不一律按版本号拒绝：能由已有可靠回执核对的照常处理，缺哪个证据就报告哪个缺口。读草稿与继续执行分开判定。

本次游戏旧记录还包含 `.9` 时代的一条内核 `not_found`。只读核对公开内核后，其所属草稿已是 `abandoned`、执行已 `stopped`，正式版本仍等于该草稿 base。该事实不能证明命令未发送，却说明“仍有本地写者”的判断不能仅由 `not_found` 得出。施工验收必须使用此类真实旧记录核对完整条件；若确认操作只限已关闭的离线副本、无未知正式接纳/外部效果，允许明确舍弃未确认输出后从保存版本继续，不回填旧发送标记。

**仍不能承诺任意旧未知任务都可续跑。** 对没有停止/隔离/来源证据的历史尝试，保留阻塞并提供草稿；将草稿作为明确授权的新独立测试输入时，旧任务仍保留未知，该成功不能算作旧任务恢复成功，也不能重新发送其原未知操作。

## 改动归属与接口

下表函数名是施工接口约定；现阶段尚未实现的新函数不能被报告为可调用。

| 归属 | 文件与接口 | 必要性 |
|---|---|---|
| 草稿读取/导出 | 在 `src/gui-work.js` 导出 `resolveTaskDraft({home, record, changeId})` → `DraftRef|null`、`exportTaskDraft({home,record,draft})` → `{directory,version,paths,warnings}`；修改 `src/gui-files.js`、`src/gui-file-content.js` 调用它们 | 用户当前取不到已经存在的未接纳代码；读取校验仍在原文件模块 |
| 继续资格与引用 | 新增 `src/project-continuation.js`：`inspectFileContinuation({home,sourceRootTaskId,draft})` → `{eligible,blockers,requestIds,stepId,draft,projectId,revision,formalVersion}`；blockers 复用 `{code,sourceId,message}` | 将确认、调度和发送端需要的同一判断收在一处；不持有第二份任务状态 |
| 确认和新尝试 | 修改 `src/project-file-confirmation.js`：`reserveFileContinuation({home,sessionId,sourceRootTaskId,draft,submissionId,authorizationSource,expectedRevision,expectedFormalVersion})` → 既有预留结构加继续引用；抽出原确认流程的共用预留/执行部分 | 允许真实用户授权后继续，仍走同一根任务与项目运行入口 |
| 预算/生命周期/调度 | 修改 `src/project-turn.js`、`src/project.js`、`src/project-policy.js`、`src/project-staff.js`、`src/project-delivery-checks.js`、`src/work-changes.js`，`src/workers.js` 只作恢复接入和必要结清记录 | 原未知保留，新尝试可调度；预算、旧权限封口和接纳继续由原组件承担 |
| 能力信息 | 修改 `src/pi-model-runtime.js`、`src/setup.js`、`src/gui-settings.js`；`inspectProviderMetadata({home,providerId})` → 当前/服务端字段对照，保存沿原设置入口 | 消除固定占位值冒充真实能力；不建能力数据库 |
| 工具与分工 | 修改 `src/extensions/cothink.js`、`src/builtin-skills.js`、`src/pi-runtime.js`、`src/project-mcp.js`、`src/project-mcp-work.js`及 `prompts/main.md`、`prompts/leader.md` | 规划得到真实能力，按现有权限调用；MCP 仍使用同一个 Pi 客户端 |
| GUI 接入 | 修改 `src/gui-controller.js`、`src/gui-turn-options.js`、`src/gui-projection.js`及原文件区、回复操作、任务限制、模型设置组件 | 草稿和继续在原对话中可用，不新增管理页面 |

本方案明确新增的生产模块只有集中表达继续规则的 `project-continuation.js`。已有超长文件若因大小门槛需要进一步抽取，限本次直接涉及的完整职责，移走原实现并保持一条调用路径，说明具体调用者；不为少建文件把无关代码塞在一起，也不开展顺手整理。不会新增服务、队列、模式、数据库、模型路由或通用工作流框架。

## 施工任务

### 任务 1：让未接纳草稿可读、可导出

**Files:** 修改上表草稿模块、`gui/src/features/files/FilePanel.jsx`、`src/gui-controller.js` 文件动作；扩展 `test/gui-files.test.js`、`test/unified-project.test.js`，新增集成场景集中放 `test/unified-project-continuation.test.js`。

**Consumes:** `resolveOwnedTasks`、`work.changes`、内核 `inspect/read`、现有路径/大小/静态预览限制。**Produces:** `DraftRef`、带草稿引用的文件列表、现有 artifacts 下的导出目录。

- [ ] 先加失败用例：真实工作写出 HTML，模型随后返回 503，未接纳；原回复仍能读取准确字节，正式 ref 不动，导出不新增模型或内核执行请求。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/pi-fixture.js';
import {repository} from './helpers/git-fixture.js';
import {projectSession,confirmProject} from './unified-project.fixture.js';
import {runProjectTurn} from '../src/project-turn.js';
import {readTask} from '../src/task.js';
import {guiFiles,guiFile} from '../src/gui-files.js';
test('failed work exposes its fixed unaccepted draft without generation',async t=>{
const plan={goal:'Create a page',scope:['index.html'],deliverables:['index.html'],
  checks:[{command:'node',args:['-e',"if(!require('fs').readFileSync('index.html','utf8').includes('draft'))process.exit(1)"]}]};
const f=await fixture(t,(_,n)=>n===1
  ? {toolCalls:[{name:'start_work',args:{action:'start',reason:'create',plan}}]}
  : n===2 ? {toolCalls:[{name:'write',args:{path:'index.html',content:'<h1>draft</h1>'}}]}
  : {error:503});
const repo=repository(t),base=await projectSession(t,repo,f);
const proposal=await runProjectTurn({...base,input:'Create index.html.'});
const root=await confirmProject(base,proposal);
const before=f.calls.length;
const list=await guiFiles(f.home,root.record);
const item=list.items.find(x=>x.name==='index.html' && x.ref?.draft);
assert.ok(item,'the original reply must expose its unaccepted draft');
const child=readTask(f.home,item.ref.taskId);
const file=await guiFile(f.home,child,item.ref);
assert.equal(file.bytes.toString(),'<h1>draft</h1>');
assert.equal(f.calls.length,before);
assert.notEqual(root.record.status,'completed');
});
```

- [ ] 用上述真实失败路径取得候选；实现 `resolveTaskDraft`，不靠任务是否 completed 决定内容是否可读。普通文件读取 helper 可改名为 `readFixedBlob`，两类文件共用校验，不复制一份“草稿安全检查”。
- [ ] 扩展原 FileRef 校验及文件区：草稿标签、来源、版本、查看/导出；正式成果样式与接纳含义不变。导出失败保留已知文件列表，缺项可见。
- [ ] 补三个反例：跨任务伪造引用被拒；投影被修改但固定版本读取仍准确；Docker 停止且模型不可用时仍能读/导出。复用既有路径、链接、HTML 安全测试，不复制整套矩阵。
- [ ] 运行 `node --test --test-concurrency=1 test/gui-files.test.js test/unified-project.test.js test/unified-project-continuation.test.js`。新测试文件在本任务实际创建后才加入命令。
- [ ] 同步 README 的草稿用途与限制；检查实际 diff，按明确文件保存本任务提交。此步可独立交付，不等待恢复功能。

### 任务 2：明确授权后，从已保存版本继续

**Files:** 新增 `src/project-continuation.js`，将它加入根 `package.json` 的显式随包文件清单；修改上表确认、生命周期、调度、岗位、证据和 work 接入模块。GUI 修改 `gui/src/features/conversation/ReplyActions.jsx`、`gui/src/features/conversation/TurnLimits.jsx`、`gui/src/useGuiWorkspace.js`、`gui/src/api.js`。测试集中于 `test/unified-project-continuation.test.js`，复用 `test/agent-sync-project-control.test.js`、`test/agent-sync-project-policy.test.js` 和 `test/gui-controller.test.js`。

**Consumes:** 任务 1 的 `DraftRef`，原根任务的完整回执、关闭事实和预算；现有 writer/confirmation/command 路径。**Produces:** 新 revision 与 attempt，以及绑定的 `projectOperation.continuation`；原请求状态不改写。

- [ ] 先用真实本地 HTTP fixture 在“写完草稿后的模型请求”断开响应，重现根任务 unknown；使用原 fixture 的 `res.destroy()`，不手改任务 JSON 制造结果。
- [ ] 在 `project-delivery-checks` 的原事实汇总中区分模型未知、操作结果未知和实际作用未结清；继续保留总 `unknown` 兼容结果。对旧隔离副本的已停止/放弃事实使用公开内核查询核对，不能依据错误文字将旧请求改成 `not_sent`。新模块消费这些事实，不再扫描一套独立状态表。
- [ ] 把正常失败路径的本地结清写入现有任务记录：在原根任务 `stopAndDrain`／正式执行收尾中，先封口并等待所属执行、工具及检查员结束，再保存 `localExecutionClosedAt`；不能在 `task.finish` 中无条件写标记。已有取消结清和助手停止回执可复用；旧记录允许复算，不能把缺新字段直接认定为未关闭。
- [ ] 实现只读资格检查、明确授权预留和同回执重入；预留携带资格检查返回的 revision/formalVersion，用现有版本核对拒绝陈旧确认。先查已有预留再判断是否创建，重复进入只回原回执。必要信息缺失时返回原操作 ID 与具体缺口。模型不能通过 `start_work` 参数自授继续权限。
- [ ] 抽取共用确认/执行部分：保持正常提议校验不变，用户继续授权不需要额外规划模型调用。新的 `task.continueWork` 动作复用原提交身份、并发确认的 joining 逻辑和 root 建立路径；`work.exportDraft` 只作任务文件导出。两者都核对当前会话来源，旧端不认识动作时明确拒绝，不能降级成普通 submit/resume。原目标/检查/范围保持；改变需求或扩大权限仍走原显式修订流程。
- [ ] 修改 `runProjectOperation` 的受信任继续分支，只选择失败步骤与依赖闭包进入新 revision；在发送、岗位占用和最终证据选择中使用同一继续引用。只对该新尝试忽略已确认的原模型占用，不删除原 call intent、attempt、费用或其他未知。
- [ ] 通过现有 `begin` options 透传已确认的恢复引用；先比较 base/current/draft 变化路径，再调用内核现有能力。参考接入形状：

```js
// 内部调用形状；restoreFrom 只从已确认的 continuation 取得。
await begin('main', restorePaths, readScope, 'Continue from saved draft', false, {
  requestId: savedRestoreRequestId,
  baseVersion: expectedFormalVersion,
  restoreFrom: draft.version
});
// savedRestoreRequestId、changeId、状态沿 work.requests 保存和查询。
// 恢复回执丢失时先查同一 ID，不能重新分配 ID 或重新创建工作副本。
```

- [ ] 恢复后维持正常可编辑范围、检查和接纳。第一次模型请求引用恢复后的源文件；不把整份源码放进新提示词要求模型重新输出。已有通过的无关步骤和资料回执仍可按原来源使用。
- [ ] GUI 在原回复给出草稿/阻塞原因/继续操作，优先显示实际失败原因，不让“协作未履行”掩盖连接或执行错误；无人值守选择只在原任务限制中出现，显示适用条件、单次消费及预算。自动动作在旧 root 完成结清、交回执行席位后进入原提交路径，不新增常驻定时器。取消、普通追问、只读浏览、旧记录不自动启用它。
- [ ] 以下表驱动场景共用一个现有项目 fixture，分别核对真实请求、字节、正式版本及账目；不只断言状态枚举。

| 场景 | 独立判据 |
|---|---|
| 仅模型断连，已明确继续 | 新尝试读取原草稿；完成必要修改/检查/接纳；原请求仍 unknown，未重新发送原 payload |
| 单次预授权，随后再次断连 | 首次可继续；不能再次消费同一授权；无后台付费循环，草稿仍可读，用户可再明确继续 |
| 重复点击/丢确认响应/宿主重开 | 同一 command/attempt 返回原回执；最多启动一个后续尝试 |
| 旧流迟到或确认后事实变化 | 旧权限不能执行工具；新的完整回执/版本变化使旧确认失效，不盲发新请求 |
| 内核仍有未决作用、MCP 未决写入、停止未知、不受管服务端执行 | 对相交范围阻塞并指出原 ID；仍可导出可信草稿；不相关隔离范围不被一并禁用 |
| 旧命令 not_found，但所属离线 change 已确认放弃/停止 | 不填造旧结果；核实仅作用于该隔离副本且无未知接纳/外部效果后，从选定版本继续，不复制未确认的辅助产物 |
| 剩余调用额度不足或硬费用边界不可核实 | 零新增生成；旧费用未知与已发次数保留，不重置项目预算 |
| 正式版有后来修改 | 无关路径保留；重叠差异进入冲突处理，不被 restoreFrom 覆盖 |
| 关闭/保存/恢复操作失败 | 不签发继续许可，不标已结清；查询同一操作，不伪造成功 |
| 已知准备失败或检查失败 | 不进入“未知模型”例外；由新明确任务/既有反馈规则处理，不重跑失败准备会话 |

模型断连用同一夹具分别覆盖经理、员工和检查器的请求；不要只验证经理一条路径。若没有新修改、仅终稿请求中断，已有正式接纳文件照常可读，继续只补剩余沟通，不重复生成或接纳相同文件。

- [ ] 运行 `node --test --test-concurrency=1 test/unified-project-continuation.test.js test/agent-sync-project-control.test.js test/agent-sync-project-policy.test.js test/unified-project.test.js test/gui-controller.test.js`。至少一次把正式文件恢复值故意改错，确认用户结果断言能失败。
- [ ] 同步 DESIGN_BASELINE、README、VALIDATION：写明窄例外、单次预授权、历史限制与未验证项。只提交该职责的明确文件。若需要绕开 kernel 未知、改 agent-sync 内部文件或伪造旧回执，停止扩大实现并报告具体公共接口缺口。

### 任务 3：模型能力核实使用原设置入口

**Files:** 修改 `src/pi-model-runtime.js`、`src/setup.js`、`src/gui-settings.js`、`src/gui-controller.js`、`gui/src/Settings.jsx`；新增能力核对用例集中于 `test/model-metadata.test.js`，复用既有 fixture，运行 `test/pi-runtime.test.js`、`test/pi-setup.test.js`、`test/gui-settings-repair.test.js`、`test/pi-requests.test.js` 回归，不在已饱和文件中机械堆用例。

**Consumes:** 已配置服务商、Pi 已有认证/模型目录、用户明确的刷新动作。**Produces:** 字段对照和用户保存后的目录值；任务仍冻结实际有效配置。

- [ ] 先重现旧导入条目 contextWindow=32000：受控 `/models` 返回 `context_window:1048576`；核对刷新只请求元数据、不生成模型回复。
- [ ] 新建/导入时保留明确来源的数值，未知值不再由 CoThink 固定写入32000/4096。当前 Pi schema 允许缺省这些字段；SDK 的兼容默认值只能标成 SDK 默认，不能冒充服务商上限。能力事实的来源可由原目录/覆盖字段推导，不另建来源表。错误达到这类估算阈值时说明其来源并给出核实入口，不能随意增大数值绕过限制。
- [ ] 在 `src/pi-model-runtime.js` 实现 `inspectProviderMetadata`，由 `provider.inspectMetadata` 动作调用：仅查询用户选择的已配置服务地址，复用原认证和 HTTP 行为，不输出密钥，不把凭据带到重定向目标。协议无字段或查询失败就如实显示，不能补成新的“官方上限”。
- [ ] 当前具体支持有明确定义的 `context_window`、`max_output_tokens`、`input_modalities`；其他已知能力继续由 Pi 当前目录和现有三档适配提供。没有元数据的服务可使用本地明确配置，不为未知模型名加硬编码表。
- [ ] 在原编辑表单展示本地值与服务端报告值；用户使用原 `provider.save` 动作应用选定字段。能力更新接受 `metadata:{modelId,contextWindow?,maxTokens?,input?}` 和核对结果中的 `expectedModelDigest`，摘要只覆盖待改字段、覆盖来源和所选路由，仅修改该已配置模型；与本次凭据/custom provider 修改互斥，保存能力不要求重新提交 API key。使用原管理锁，锁内重读合并，保留认证、名称、价格和其他条目，不因无关模型修改一律拒绝；远端额外模型不自动导入。`modelOverrides` 优先，不根据数值恰好等于32000或 provider 名字推断用户意图。旧无来源值标成“本地配置/未核实”，不后台自动覆盖。
- [ ] 不建立能力数据库或刷新历史表。来源/查询时间放在本次对照结果中；运行时说明有效值来自本地配置或随包目录，不能声称它永远是实时规格。
- [ ] 明确区分能力上限 `maxTokens` 与实际请求额度 `maxOutputTokens`：刷新前者不能给本来未设置额度的请求偷偷加上限，也不能改变 max/high/low 或输入材料权限。
- [ ] 将已有 `projectModelFacts` 的有效能力及路由随本轮配置记录在原任务快照中，便于核对实际使用的值；不存认证内容。对已确认/运行中的任务使用原快照；保存只影响后续任务。普通启动、历史浏览、任务运行过程中不自动联网刷新。离线要求、保存冲突及损坏记录沿现有处理。
- [ ] 使用以下输入核验归一化，再走真实 SDK 序列化检查有效值和输出额度边界：

```js
const reported={id:'deepseek-flash',context_window:1048576,
  max_output_tokens:393216,input_modalities:['text','image']};
// 目录归一化目标：contextWindow=1048576、maxTokens=393216、input=['text','image']。
// 请求仍使用冻结的 reasoning_effort='max'；未显式设置输出额度时，
// 实际 wire 不因目录 maxTokens 更新而新增 max_tokens/max_output_tokens。
// 显式 modelOverrides.contextWindow=64000 时，有效值仍为64000。
```

- [ ] 运行 `node --test --test-concurrency=1 test/model-metadata.test.js test/pi-runtime.test.js test/pi-setup.test.js test/gui-settings-repair.test.js test/pi-requests.test.js`，维护相关用法和证据后保存明确文件提交。

### 任务 4：对齐工具能力，收回无依据的协作负担

**Files:** 修改上表工具模块和两个控制提示；复用 `src/project-file-proposal.js`、`src/project-staff.js` 的既有校验。测试扩展 `test/unified-turn.test.js`、`test/unified-project.test.js`、`test/builtin-skills-project-capabilities.test.js`、`test/pi-project-mcp.test.js`、`test/unified-turn-readonly-supervision.test.js`。

**Consumes:** 有效模型/角色能力、已配置 MCP、明确用户需求和计划。**Produces:** 可实际执行的工具参数与分工，不增加模型请求阶段。

- [ ] 把本次踩到的 start/resume/revise 互斥参数、预览 `kind`、岗位 `need`（仅 `deliverable/review/capability`）及注册工作范围约束与现有校验对齐；有限枚举复用同一定义，错误给出可选字段/范围。不建通用 schema 生成器，不复制整套项目校验，也不静默替模型扩大 scope。
- [ ] 扩展现有 `get_capabilities`，默认提供无秘密的已配置服务摘要。可选 `mcpServer` 参数用于明确的只读发现；HTTP 服务复用 `project-mcp.js` 的 connect/listTools/close 代码，返回工具名、描述和输入 schema，绝不调用 tools/call。
- [ ] 普通启动不连接所有服务；缺配置、发现失败、尚需正式隔离执行分别说明，未用服务的故障不阻断普通任务。首版不在规划阶段启动命令型 MCP 服务，它仍按现有正式隔离路径发现。规划工具不可直接调用，不等于服务不存在。服务描述是外部资料，不得覆盖宿主指令。
- [ ] 真正 MCP 业务调用仍须已有 `plan.mcp` 的服务、具体参数和效果授权；发现信息或服务 annotations 不授予执行权。无需新的联网模式、代理层或通用 MCP 管理系统。
- [ ] 本任务只解决发现与说明，不把精确参数合同扩成任意通配执行。尚不能事前确定的参数仍走原明确提议；不得把“可发现”写成“任意连续调用已支持”。本次已有检索回执可以复用；真实验收若暴露动态参数合同的独立缺口，明确记录，不靠人工替模型补参数或静默放大权限来报通过。
- [ ] 将“Team 阵容”和“实际员工数”说清：明确要求组队的本次软件任务可由经理加一个副模型岗位完成；根据实现/审查需要增员，不默认每阶段再派两个员工。`workers` 仍只数员工，`distinctModels` 仍约束员工型号，不把经理混入旧计数含义。`stepIds` 是覆盖要求，不能擅自解释为每一步固定两人。
- [ ] 新计划避免写入用户未要求的硬人数/全步骤覆盖承诺；可用组织深度不等于必须建满层数。旧明确承诺保留原记录，变更必须经过已有计划修订；用户明确要求多人/并行/独立评审时仍严格执行。最终验证真实派工、collect和结果处理，不把建岗位当作完成。
- [ ] 只读代码审查不承担试玩义务。需要命令、预览的工作分配给已有执行权限的角色；前置独立准备仍可只读，但完成后只开放实际授权的工具。不能为省步骤一律扩大员工写权限。
- [ ] 固定复验四个场景：配置的 HTTP MCP 能在规划被识别且零 tools/call；只读角色不被宣称可试玩；经理+一个副模型满足未指定人数的协作需求；用户明确两员工的要求不会被新默认降级。另核对实际请求仍含系统指令、正确 max 和实际工具集合。
- [ ] 运行 `node --test --test-concurrency=1 test/unified-turn.test.js test/unified-project.test.js test/builtin-skills-project-capabilities.test.js test/pi-project-mcp.test.js test/unified-turn-readonly-supervision.test.js`；不再建“默认组队”分类器或自动复审循环。同步现有说明后保存明确文件提交。

### 任务 5：从真实入口验收，再安装

**Files:** 复用已有 `test/helpers/pi-fixture.js`、`test/unified-project.fixture.js`、实际 App 验收入口和本机测试目录；维护 `VALIDATION.md`，必要时同步版本、README、CHANGELOG。真实运行记录留在忽略的 `work/`，不新建长期测试平台。

- [ ] 先复核任务1—4的用户结果与反例；测试不能只根据提示中的观察标记返回固定“正确”报告，必须检查真实 wire 指令/能力和最终文件结果。
- [ ] 在获得实际执行授权后，用正式 App、廉价 team、max，对已保存单房间草稿完成一项小改动：真实副模型贡献、收集、检查、接纳、原对话可打开交付。须包括足以暴露原32k问题的真实代码材料，而不是只有几行文本。
- [ ] 用受控 HTTP fixture 分别注入纯模型断连、内核/外部操作未知，验收继续与阻塞不同结果；实际模型运行核实工具与职责的语义遵循。两类证据分别记录，不能用模拟恢复证明真实模型能完成游戏。
- [ ] 最小真实流程通过后，再运行原游戏需求：四阶段按需推进，不固定运行40分钟凑时长。记录实际耗时、调用、未决事项和阶段成果。全程不能依赖外部 Codex 补工具说明、修改隐藏状态或手工搬文件才能交付。
- [ ] 核对现存旧游戏任务是否满足新资格，特别验证“旧命令结果未知，但对应隔离副本已关闭”的区分；不能见 `not_found` 就一票否决，也不能见错误文字就放行。仍有实际作用/来源缺口时保持阻塞；新的独立测试与历史恢复成功分开标记，原请求始终不被偷偷清理。
- [ ] 本地相关检查通过后，使用原构建/安装流程验收候选和正式 App，明确验证包内存在新增模块，且实际 App 能走“中断→草稿→继续→交付”。备份用户数据，测试副本放 `.noindex`、注销 Launch Services 登记，按 bundle ID 和实际系统搜索核对唯一入口。构建或并行测试失败保留原因，只对失败/受影响部分复验。
- [ ] 将结果回填 VALIDATION，分别写明源码回归、模拟故障、真实模型、正式 App、原游戏是否完成。未跑完就保留失败与具体剩余缺口，不用“检查全绿”替代交付。

## 顺序、完成判据与防御性复核

实施顺序：**任务1 → 任务2的本地闭环 → 任务3/4 → 任务5**。任务2若不能用现有公共接口和单一 writer 做到安全继续，不先扩展平台；保留可独立交付的任务1，给出具体缺口再重审。

| 保留的防护 | 当前必要性 | 不增加的防御负担 |
|---|---|---|
| 固定版本、来源和范围校验 | 防止恢复错文件或覆盖后来修改 | 不另造快照库、签名协议或全机扫描 |
| 原本地执行结清、未决副作用核对 | 防止旧新执行者同时产生效果 | 不要求远端证明没计费；不因单纯费用未知永久禁止一切后续授权 |
| 原未知请求/费用保留 | 防止虚构成功、漏算调用 | 不把未知模型回复直接等同于所有本地操作未知 |
| 同一确认回执只消费一次 | 防止双击、重开和断连导致重复付费 | 不另设恢复队列、轮询调度器或层层审批 |
| 新候选重新检查/按约审查 | 恢复后的当前版本才是交付依据 | 不重做无关已完成步骤和成功资料查询；不固定每阶段多员工 |
| 老记录不补造发送或成功结果 | 防止把猜测变成运行事实 | 实际作用能核实已结清就不永久阻塞；无法继续也不禁止读取可信草稿 |

**方案自审已修正的欠缺：**

1. 删除自建文件复制/恢复算法，改用已存在的 `restoreFrom`，并限定确切变化路径及冲突处理，防止广目录恢复覆盖无关新文件。
2. 分开只读草稿导出与继续写入的条件，避免“未验收所以连文件也取不到”。
3. 明确继续必须贯通确认、调度、岗位、发送和证据，禁止只改一个 `unknown` 判断。
4. 删除按“进度”反复签发继续权限的设计，首版复用单次确认消费；不引入进度评分、内容指纹节流或循环重试。可见的一次预授权不改总调用预算，后续仍可明确继续。
5. 收回无依据的每阶段多员工承诺，保留已有计数语义和明确用户要求。
6. 明确能力刷新不等于输出额度变更，不覆盖显式配置，也不引入能力数据库。
7. 再核对旧游戏的公开内核事实，补齐“结果未知但隔离副本已关闭”的处理，删除仅因旧 `not_found` 永久阻塞的过重条件；仍不保证无证据的历史未知可以恢复。
8. 补齐随包文件清单和实际 App 入口验收；模型能力保存复用原设置，不要求用户重复输入密钥；恢复保留有效参与证据，不重新凑人数。
9. 草稿回归从现有 `guiFiles/guiFile` 用户入口断言，避免只因新函数尚未存在而失败；新导入也从源头取消 CoThink 的固定容量占位写入。

**文档完成不等于实现通过。** 最终标准是：真实任务在约定范围内产生可使用成果；允许继续的中断能够继续；不能继续时草稿可取、原因具体；无越权、无原未知请求重放、无费用伪造。未达到这些条件，不宣布长任务可靠性已解决。
