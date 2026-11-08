# 委派题意与独立验收 Implementation Plan

> **状态：2026-10-28 用户已授权“开始修改”，本地实施及免费机制验收完成。** 不调用付费真实模型、不改变旧结果、不发布；执行证据见 `work/task-fidelity/progress.md`。
> **For agentic workers:** 获准后使用executing-plans顺序实施，每步保留行为测试证据；不自动启动额外子代理或收费验收。

**Goal:** 降低主模型改题经委派传播、成员未纠偏以及验收沿用错误标准的风险，并让冲突与未验证结论真实可见。
**Architecture:** 原题、职责和建议分别注明来源；成员在既有Pi会话先读原题，再处理委派建议；最终视觉验收使用同一主模型的独立短上下文，复用当前截图及版本证据。agent-sync继续负责版本/权限，不负责语义判断。
**Tech Stack:** 当前Pi SDK、现有runWork与task记录、现有preview_html及localhost模型fixture。
**Spec:** 本文第1—6节；沿用DESIGN_BASELINE.md。新增的成员准备调用和独立上下文验收在用户批准实施后同步基线。

## 1. 选择与边界

比较了三条路线：只加重提示语改动最小，但原题优先规则此前已存在且失败；建立通用需求图谱/关键词拦截会增加维护与误拦；推荐调整信息来源、先后顺序和检查上下文，并给冲突一个可执行的处理出口。

本次优先覆盖HTML/SVG制作的语义与视觉验收；原题来源及成员冲突处理可以用于所有工作任务。普通问答1/3次政策保持，非视觉工作的业务检查不扩展。

不能用程序证明任意自然语言任务没有改题，也不能保证模型看图一定正确。本方案保证的是输入来源、准备阶段无写入、冲突不能静默接纳、审查上下文隔离和版本证据绑定；正确理解本身仍需模型与后续真实样本验证。

## 2. 委派：原题由宿主提供，主模型不再制造第二份“用户要求”

### 2.1 收窄delegate输入

将新任务的delegate参数从自由重写整项task/materials，改为：

```ts
type DelegateInput = {
  model: string;
  assignment: string;       // 本成员负责哪部分工作
  implementationAdvice?: string; // 建议/假设，明确低于原题；不得冒充用户原话
  reason: string;
  scope?: string[];
  readScope?: string[];
  readOnly?: boolean;
  dependsOn?: string[];
};
```

宿主从task.record.input构造不可由模型参数覆盖的originalTask。保留原始文字，不做摘要、翻译或关系抽取来替换它。旧成员日志继续原样可读，新运行不继续提供旧task/materials作为同义写入口。

HTML整体委派的目标示例：

```json
{
  "assignment": "负责 index.html 的完整实现、预览和修订",
  "implementationAdvice": "可考虑海岸背景；配色和版式由你判断",
  "scope": ["index.html"]
}
```

“谁骑谁”等用户已经确定的关系由原文承载。主模型若必须补充解释，放入advice并标为其解释，不能标成“用户硬约束”。代码不能仅凭换字段名判断建议在语义上是否冲突；后续独立理解与冲突处理仍必须存在。

### 2.2 防止建议与原文混成一条指令

在context.js新增纯函数buildMemberTaskMaterial，返回有来源边界的材料：用户原文、成员职责、主模型建议、实际权限/工具。真实工具名由宿主当前注册列表生成，不让主模型代写“成员没有preview_html”。技能保持原文和冻结哈希，不能把主模型转述的技能要点冒充原技能。

同条任务不新增可变“标准答案”，不把主模型抽取的关系作为后续唯一验收标准。新的人类澄清属于后续明确输入；运行中主模型不能自行修改原题。

### 2.3 控制文本与任务内容的语言边界

沿用已有英文角色提示修订约定：新增或修改的模型角色提示、宿主生成的上下文标签与控制指令、工具及参数description、模型可见的固定诊断信息统一使用英文。具体包括buildMemberTaskMaterial的来源/优先级/权限说明、成员准备与冲突恢复指令、visual-review角色规则，以及collect中宿主生成的说明文本。

用户原题、明确澄清、技能正文、历史记录及引用内容保持原样，不以英文翻译替换。模型生成的assignment、implementationAdvice、understanding、冲突理由和审查意见不强制转成英文；面向用户的自然语言遵循用户明确指定的语言，未指定时沿用用户语言。上面的中文委派JSON是任务内容示例，可保留；方案正文、代码注释、中文回归案例与本地化界面文案不受英文控制文本约束。

每个隔离的模型上下文都须自行包含英文写成的回复语言规则，不能依赖未传入的旧会话。例如：`Use the user's explicitly requested response language; otherwise use the user's language. Preserve quoted source text verbatim.` 不因控制提示使用英文而默认要求英文输出；已有约定的固定原文和标题仍原样保留。

## 3. 成员：先独立理解，再比较建议，冲突能真正停下

### 3.1 成员准备阶段

对于首次委派，在已有成员Pi会话中先调用一次准备请求，只发送原题、宿主确认的实际scope/readOnly/工具能力及适用技能。此时不发送主模型assignment、implementationAdvice、reason或验收断言，防止错误题意藏在“职责”字段中提前进入上下文。

允许read/grep/find/ls，暂不开放write/edit/bash/preview_html。要求用简短自然语言说明原题的目标、关键关系和明确约束，以及文件范围与目标关系中的疑问。此时不要求猜测尚未收到的具体分工。例如对“自行车骑鹈鹕”应独立说明自行车是骑乘者、鹈鹕承载它。例子是回归案例，不写入生产代码的特判规则。

准备结果保存在已有member记录的understanding和understandingCallId，保持普通自然语言；不是机器证明的正确答案。空答复、失败、取消或unknown不能开启写工具，也不自动重发。之后才发送主模型的assignment和implementationAdvice，要求对照自身理解和原文处理冲突，进入原有实现循环。

这通常增加每个首次委派至少一次成员模型调用，实际次数照常记账。不是零成本优化，也不声称它就是零额外调用的原流程。后续有具体feedback的同草稿修订不重复建立准备会话。

### 3.2 冲突上报与恢复

新增成员工具report_task_conflict({message})：成员用自然语言指出冲突，并引用相关原文/建议。无须填写版本号、哈希、需求ID等内部字段。

工具记录taskConflict={message,requestId,unresolved:true}，停止成员当前运行、保留草稿并撤下写工具；沿用现有failed/错误码TASK_CONFLICT交回collect，不新增成员业务状态机。宿主拒绝接纳unresolved冲突成员。

主模型收到冲突后：

- 原题明确、委派错误：通过现有feedback承认并撤回具体错误建议，按原题继续同一草稿。
- 原题确实有歧义：报告需用户澄清，保留成果。
- 不能以“我是主模型”“仍按刚才的详细要求做”解除冲突。

通过feedback恢复时，成员实际收到原题、冲突与针对性更正；随后用report_task_conflict({message, resolved:true})确认自身理解已经一致。只有该成员的后续请求成功完成并确认，unresolved才清除；主模型不能直接改标记。该接口新增可选resolved布尔字段，默认false。标记证明冲突处理步骤完成，不证明模型判断必然正确。

## 4. 验收：用干净上下文直接比较原题与成品

### 4.1 替换现有最终视觉调用

当前最终截图发回原leader会话；这个会话含其错误委派和历次自我解释。改成独立短上下文的主模型审查运行：

- 仍使用当前配置的主模型、thinking、预算和唯一Pi请求实现；只有原leader和相关成员无在途请求/未知占用时才顺序执行。
- 不同时建立同模型并行分身，不委派主模型给自己，不新增第三模型。
- 仅传原始用户任务、当前最终版本的真实截图、视口/时刻、运行错误和必要交互事实。排除原leader的委派文本、设计论证、成员自评及“已经通过”的结论。
- 当前最终视觉检查调用由这次检查替代；原leader上下文保留以便收到具体缺陷后修订。检查不继承既有leader/成员会话历史。
- ONE同样用主模型顺序执行隔离上下文自查，不引入副模型；这提供上下文独立性，不等于不同模型之间的独立判断。

新增短角色提示prompts/visual-review.md，检查顺序为：先客观描述图中主体、承载/上下/动作关系，再与原题比较，再检查动态与布局。先观察、再判符合，不能先宣告“题意正确”。看不全的区域必须标不确定；背景移动不能单独证明腿部运动正确。

该新增角色提示及审查请求的固定包装使用英文，并在独立审查上下文中显式加入第2.3节的回复语言规则；中文原题和原始证据内容不翻译替换。

### 4.2 一个小结论接口，保留完整理由

审查运行没有文件写入、Shell、委派或接纳工具，仅有submit_visual_review：

```ts
type VisualReview = {
  verdict: 'match' | 'mismatch' | 'uncertain';
  observation: string; // 看见了什么，不复述委派说明
  reasons: string;     // 对照原题的具体理由；说明缺失视野或动作证据
};
```

版本、截图哈希、模型、requestId均由宿主填写并绑定已有visualEvidence，模型不生成这些字段。自然语言回复完整保留；缺少工具结论时记uncertain，不能丢掉已有有效意见，也不自动原样重试。

- match：只是该模型按此证据判断符合；还须原有版本/图片实际发送/正常回复检查满足，才允许任务completed。
- mismatch：阻止完整交付；把观察和理由作为来源明确的具体feedback交回leader。leader修订、接纳新版本、重新截图后再独立检查。
- uncertain：报告缺少什么。若能补拍关键区域或交互则补证据；否则partial并提供已有文件。
- 保留有理由的分歧。leader可说明审查哪里判断错并提供新的可核验证据；不强求口头一致，也不能直接把不符合改成通过。无新证据/无具体行动时结束为partial，避免无限自评循环。
- 审查请求失败或503拒绝、未携带图片、版本变化，都不能写成检查完成。unknown不重发。

审查模型仍可能判断错误；这个小接口仅使错误/不确定结论能影响程序分支，不能充当客观语义oracle。

## 5. 接纳与证据展示

collect向leader返回宿主生成的能力与预览摘要：成员实际工具、预览成功/失败次数、对应candidate/source版本、是否有已完成的图像请求、截图引用。必要图片通过受控工具结果传递，不允许任意宿主路径。

主模型可从这些事实知道成员确实有preview_html。旧候选或只有imageRequestId而模型请求failed的记录，显示为未完成判断，不能算已审阅。

accept_change继续负责版本接纳；不是画面符合原题的证明。未解决taskConflict时不能接纳。已接纳作品可以保留，但最终独立检查mismatch/uncertain/失败时任务只能partial，用户仍能查看文件与原因。不得回滚已经确认的接纳来掩盖问题。

本次不把agent-sync改成语义检查器，不增加需求图谱、关键词对称性规则或业务数据库。

## 6. 免费验收与真实效果边界

必须测试的用户行为：

1. 两个反转案例的原题逐字保留；主模型建议无法覆盖originalTask或伪装为用户消息。
2. 成员准备请求不含主模型assignment/advice/reason，不能调用写工具；准备失败时没有任何源码编辑。
3. 准备后才传分工与建议；fixture主动报告冲突后，接纳被阻止、草稿保留；具体更正实际传给同一成员后方可解除。
4. 独立视觉审查请求包含原题和真实PNG，但不含错误委派/成员自评/旧leader历史；ONE无副模型请求，同模型运行顺序占用。
5. fixture返回mismatch时不能completed；它提供具体反馈后允许修订，第二次检查绑定新图和新版本。uncertain、503、无工具结论、缺图/裁切证据都不能伪造通过。
6. 过期版本的match不能授权新版本；已接纳文件在检查失败后仍可读。
7. collect的工具能力/预览信息从真实记录生成；成员有成功preview时不能显示“工具不存在”，failed图像请求不记已完成审查。
8. 捕获实际成员准备、执行、冲突恢复和独立视觉审查请求，检查新增宿主控制文本及工具description使用英文，每个隔离上下文均有回复语言规则；同时验证中文原题、引用、技能正文与反馈逐字保留。按来源检查，不能用“整个payload不得含中文”的断言误伤原始材料。fixture只能证明规则已传入，不能证明真实模型一定遵循语言要求。

使用本地HTTP fixture与真实Docker截图证明上述机制；可用红/蓝SVG或确定几何图形检查版本和图片传递。fixture按脚本报告冲突/错误不能证明真实模型会识别“谁骑谁”。语义提升、误报率、审美与费用收益留待另行授权的小规模真实对照，不在本轮付费重跑。

## 7. 顺序实施任务

### Task 1：来源分离与成员准备

**Files:** src/context.js、src/workers.js、prompts/leader.md、prompts/worker.md；扩展test/agent-sync-dispatch.test.js、test/visual-workflow.test.js。
**Consumes:** task.record.input、delegate参数、技能快照与现有member runtime。
**Produces:** 新DelegateInput、buildMemberTaskMaterial、member.understanding及understandingCallId。

- [x] 按第05轮暴露的关系反转问题构造确定性fixture，验证原题始终由宿主注入（重建冲突场景，不复制或改写旧真实实验日志）。
- [x] 修改工具schema，旧task/materials字段的新调用明确拒绝并提示新参数；旧历史不重写。
- [x] 成员首阶段仅原题/宿主权限事实及只读工具，随后加入分工与建议；首阶段失败不得打开写工具。
- [x] 测试普通问答和ONE路径不误加成员阶段；记录新增调用实际数量。

### Task 2：冲突暂停与更正

**Files:** src/workers.js、prompts/leader.md、prompts/worker.md；扩展test/agent-sync-dispatch.test.js。
**Consumes:** Task 1成员准备结果、现有feedback/collect/accept_change。
**Produces:** report_task_conflict工具与现有member记录上的taskConflict字段。

- [x] 先构造成员报告“原题自行车骑鹈鹕，建议却为鹈鹕骑车”的测试；断言保存冲突并拒绝后续接纳。
- [x] 主模型feedback后，核对同一成员请求确实收到更正；未确认resolved不能接纳。
- [x] 测试取消、未知请求、写到一半才发现冲突时，内容保留且不重复生成。

### Task 3：隔离上下文的最终检查

**Files:** src/workers.js、src/context.js、src/pi-runtime.js（仅必要封装）、新增prompts/visual-review.md；扩展test/visual-workflow.test.js。
**Consumes:** 当前最终版本截图、原题、原有请求政策与身份占用。
**Produces:** submit_visual_review及绑定到visualEvidence的review记录。

- [x] 在原leader历史植入错误解释与“已经通过”，验证审查payload中没有这些历史，只有原题与准确图像事实。
- [x] 用相同main model顺序创建受限审查runtime，复用现有createRuntime及createRequestPolicy；结束后释放会话/占用。没有隐藏的新provider请求路径。
- [x] 由独立审查替换现有最终leader看图调用；将mismatch/uncertain的具体理由送回原leader，保留其实现上下文。
- [x] 逐项验证match/mismatch/uncertain、503、缺结论、旧图/新版本、主模型无图像能力及未知结果不重发。

最小验收断言形式：

```js
assert.equal(task.record.status, 'partial'); // fixture明确报告不符合且未修订
assert.ok(task.record.work.resultWorkspace || task.record.work.acceptance.length);
assert.equal(reviewInput.originalTask, originalUserInput);
assert.equal(reviewInput.messages.some(m => m.text?.includes('错误委派哨兵')), false);
// 真实请求中另核对PNG数据；不能用只有路径的消息替代。
```

reviewInput是测试从捕获的实际请求解析出的结果，不是新增生产协议。状态断言测试策略，不以fixture代替真实模型语义。

### Task 4：证据投影和回归

**Files:** src/workers.js、src/gui-projection.js、gui/src/Collaboration.jsx、docs/VISUAL_BENCH.md、DESIGN_BASELINE.md、VALIDATION.md；更新受delegate schema影响的既有fixture。
**Consumes:** 实际工具能力、preview及review记录。
**Produces:** 用户能查看的冲突、更正、审查结论、理由和失败边界。

- [x] 宿主填充collect能力/证据；界面区分接纳保存、图像已发送、审查正常完成、语义判断。
- [x] 运行相关dispatch/entrypoint测试、npm test、npm run test:visual、npm run test:gui及build:gui；真实容器缺失报错，不能改skip。
- [x] 保存本轮差异、失败及通过证据，核对旧实验记录未改。
- [x] 检查第2.3节语言边界及第6节第8项实际请求证据；新visual-review上下文显式携带回复语言规则，不依赖leader历史。
- [x] 交付本地机制结果与实际调用增量，明确真实模型效果仍未验证。

## 8. 范围、成本与执行条件

成员准备阶段可能增加每次首次委派的调用；最终独立检查替换现有最后看图调用，发现问题后的修订照常增加调用。所有调用计入task账本，未知费用保持未知，不把更长流程宣称为免费提升。

单模型的最终检查仍使用主模型顺序自查；协作模式不新增固定第三模型，不允许同模型并行分身。普通问答次数不变。模型主要输出自然语言，新增的两个小工具只提供程序确实需要的冲突出口和结论分支，版本/身份/哈希都由宿主处理。

本方案已获用户确认实施。实施不自动授权付费重跑、发布、全局安装或agent-sync变更。Git操作前按项目规则检查变化并解释目的。后续真实测试应使用独立冻结的源码副本，避免其他工作修改提示词再次打断测试；该运行隔离应在下次测试准备中落实。

## 本轮交付证据

核心 302 通过、0 失败（3 项既有 Windows 平台跳过）；视觉 45/45；GUI 82/82；GUI 构建成功。完整失败、修复、实际请求快照及截图见 `work/task-fidelity/progress.md` 与 VALIDATION.md 顶部。未进行真实模型质量对照、发布或全局安装。
