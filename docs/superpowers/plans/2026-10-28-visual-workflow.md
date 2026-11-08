# HTML/SVG 制作与视觉检查 Implementation Plan

> **状态：2026-10-28 已批准实施，随后批准调用方版本合同修订。** 不得据此启动收费模型测试、发布或修改本机全局安装。
> **For agentic workers:** 批准后使用 `executing-plans` 按任务顺序实施；不要自动创建子代理或新聊天。每步保留本地证据，不把fixture当成真实模型效果。

**Goal:** 让 HTML/SVG 制作真正进入既有工作循环，使用适用技能，在断网隔离环境中截图，将图片送给实际执行模型并支持修订；ONE与CoThink共享这些基础能力。

**Architecture:** 沿用 `runTurn → runWork → Pi SDK → agent-sync`。新增一个明确的单次制作提交入口及一个受控 `preview_html` 工具；截图通过agent-sync公共exec/read执行和取回，不另建模型客户端或版本管理。把视觉证据附在已有task/work/tools记录上。

**Tech Stack:** 当前固定Pi SDK、agent-sync公共API、Node、锁定Playwright 1.64.1与Chromium版本的Docker镜像；本地fixture服务。

**Spec:** 本文第1—7节是已批准规格；同时遵守根目录DESIGN_BASELINE.md。对显式制作入口、预检与交付判断的新增规则，在实施批准后同步基线。

## 1. 目标、范围与证据

第一版覆盖可离线打开的HTML/SVG作品及其本地CSS/JS/图片依赖，包括本次三道题。暂不扩展到自动搭建任意React项目、联网安装依赖、网站发布或通用远程浏览器。现有项目里已经构建好的本地HTML入口可使用同一预览工具。

已查明的当前代码事实：

- `src/discussion.js` 先调用draft；未进入work时，ONE直接把该回复作为完成结果。
- `src/extensions/cothink.js` 已有start_work交接；`src/workers.js` 已支持单模型多轮工作及协作成员，ONE成员列表为空。
- `src/context.js` 已冻结显式技能主文件，主答和成员能收到同一快照；无需创建另一个技能系统。
- `src/workspaces.js` 的read已能读取受管源码中的图片，但output日志强制按文本处理，不能把“截图写入日志”直接等同图片回传。
- agent-sync公共exec接受expectedVersion与signal，结束后检查源码变化；只读change不能执行Shell。现有固定Node镜像没有经过Chromium能力验收。
- `scripts/visual-bench/viewer.mjs` 是给用户看的宿主浏览器，不能当成模型的隔离截图后端。

## 2. 路线比较与推荐

| 路线 | 优点 | 缺口/决定 |
|---|---|---|
| 只加强提示词，仍允许直接返回HTML结束 | 改动少 | 无法解决实际绕过工作；不作为完整方案 |
| 明确制作入口＋原有自然语言识别＋受控截图工具 | 复用现有执行循环，明确入口有确定性保证，日常输入仍自然 | **推荐**；这是本文实施路线 |
| 所有消息都强制工作，或增加独立意图分类模型 | 容易统一分派 | 破坏普通问答、增加调用或误执行；不采用 |

自然语言的意图理解仍可能犯错，不能承诺靠提示实现100%识别。程序可以保证的是：用户通过明确的制作入口提交后，不会落到“一次代码块纯答即完成”。

## 3. 制作入口与技能

### 3.1 单次制作提交，不新增持久对话模式

- GUI在发送入口提供“制作HTML/SVG”动作；CLI为 `cothink make-html [--one] <任务>`；持续终端为 `/make-html <任务>`，继承当前ONE/CoThink模式。
- 三个入口都只设置同一个内部参数 `workRequest: {kind: 'html-svg'}`，原始任务文字原样保留。不把普通输入中出现的命令文本、代码块或材料解析成动作。
- 这是本条请求的交付要求，不是与ONE/CoThink并列的第三种模式。提交后冻结，下一条仍沿用原对话模式。
- `runTurn` 遇到明确workRequest，先预检，再把现有task.mode设为work、maxCalls设为null，直接调用runWork；不先花一次模型调用生成纯答，也不增加分类调用。
- 直接进入work时须显式传入当前分支的已有对话材料和技能快照，不能依赖“第一条draft记录”来找上下文，不能传入旧请求的原始HTTP体。
- 首版仍要求关联已准备的工作项目。没有项目时保留输入、提示选择项目；不在用户任意目录偷偷git init，不自动覆盖原目录。通用自动建项目不进入本次范围。
- 自然语言输入“做一个/修改这个HTML界面”时，主提示明确要求实际start_work，不以代码块冒充制作完成；“解释原理”“只给示例代码、不创建文件”保持纯答。start_work增加可选 `deliverableKind:'html-svg'`，进入相同制作合同。自然语言识别的实际效果留给后续获准的真实测试。

### 3.2 使用现有技能来源

- 沿用 `piResources.skills`、受管包资源和freezeAnswerSkills；当前本机建议明确选择已安装的frontend-design主文件，而非导入整个技能目录。
- 制作项目配置须有显式的适用技能来源；运行前展示名称与版本哈希。未配置时给出具体缺项和配置方式，不宣称已加载，不静默扫描个人目录补齐。
- 同条任务主模型、副模型收到同一冻结正文和原题；各自按技能描述使用，技能不扩大权限，不改写原题。
- 通用的“先确认谁骑谁、实际制作、看图、修订、交付”属于leader/worker角色提示的短补充，不再新建一整套技能或质量代理。
- 本版不递归执行skill引用脚本。缺少必要资料时按已有规则明确报告，不能声称读过；以后若需要按需引用读取，另作小范围扩展。
- 不复制DSH全部系统提示，也不以提示长度为优化目标。配置更改仅作用于新任务；旧记录不回写。

## 4. 一个受控的离线预览工具

### 4.1 模型接口

新增 `preview_html`，只在工作运行时提供给主模型与实际成员，参数限制为作品路径、视口、观测时刻及少量交互动作：

```ts
type PreviewInput = {
  entry: string; // 当前受管投影中的相对HTML/SVG文件，禁止URL/绝对宿主路径
  viewport?: { width: number; height: number }; // 默认1440×900，最大1920×1080
  frameTimesMs?: number[]; // 默认[0,500,1000]，每次最多3帧，每个时刻0..10000
  actions?: Array<
    { kind: 'click'; selector: string } |
    { kind: 'fill'; selector: string; value: string } |
    { kind: 'key'; key: string }
  >; // 最多6步；不提供任意evaluate脚本接口
};
```

返回实际PNG图像块及简短文本：入口、视口、实际捕获时间、console/page错误、资源失败、被阻断的外部请求、对应privateVersion和截图哈希。图片必须作为Pi工具结果中的image内容传入下一次模型请求，不能只返回文件路径或“截图成功”。

默认三帧用于发现静止、位移和肢体变化，不保证恰好捕获所有动画状态。工具记录实际时间，不能把墙钟采样误称精确仿真。模型可补充另一视口/交互；没有硬设模型修订轮数。

### 4.2 执行与版本边界

- 构建包含固定Node、Playwright、Chromium、中文字体与可信预览脚本的镜像；实际执行只接受构建后核验的digest。沿用项目work.execution指定镜像，不改agent-sync实现。
- 通过公共 `versioning.exec(changeId, {requestId, expectedVersion, command}, {signal})` 调用镜像内固定脚本。参数用严格schema校验后安全编码，不能拼接模型提供的Shell命令。
- 该工具要求活跃且具有明确scope的change；只读change或已关闭change不能偷偷执行。成员在自己的change预览；主模型复查已接纳版本时，通过已有next_change取得精确范围的检查工作区，检查完无修改则明确结束该change。
- renderer在容器内以只读方式服务允许的作品树，临时文件仅放容器/tmp。保留 sourceVersion（执行前）及 privateVersion（执行后）；要求回执 changedFiles 为空、执行后 inspect 版本等于回执版本，且公共 inspect({fromVersion: sourceVersion, toVersion: privateVersion}) 的 files/text/binaryFiles 均为空，以核对源码未变化；意外变化不能当作有效截图证据，不静默回滚或自动接纳。
- 截图与诊断由固定脚本输出为有界JSON结果，经公共read(outputRef)分页取回。新工具解析后保存至 `home/artifacts/<taskId>/<requestId>/（使用宿主生成的执行 requestId 作为目录名，避免将不可信 toolCallId 用作路径；两者关联保留在证据中）`，不把截图或浏览器缓存混入用户源码、正式ref和待接纳diff。
- 输出总量上限16MiB、单图PNG最多4MiB；超出明确失败，不截断为成功图片。既有output日志read每页上限1MiB，按该合同取回。
- 浏览器运行和本地HTTP服务都在同一 `network:none` 容器内，仅允许容器loopback访问作品；阻断远端HTTP、WebSocket、导航、Service Worker、下载和宿主file路径。不存在宿主浏览器或宿主Shell回退。
- 预览操作明确采用30秒技术超时，用于终止死循环页面；不改变模型请求、任务或费用上限。取消整条任务传入既有signal，由executor清理容器进程。
- 正常结束、异常、取消都关闭page/context/browser/容器内服务。首版不打开Google Chrome for Testing用户窗口来执行模型检查；用户手动查看作品仍沿用已修复的查看器生命周期。

### 4.3 先验证现有公共接口确实足够

第一项施工必须先用无模型的临时项目验证：在现有executor的非root、只读根文件系统、cap-drop、no-new-privileges、network:none及既有挂载合同下启动Chromium，并成功返回PNG，且公共版本差异证明源码内容未变（允许内核记录操作而产生新版本）。

计划不预先假定该组合必然可用。若失败原因需要新增挂载/特权、改变agent-sync公共保证或直接读取其内部scratch，记录具体BLOCKED条件并提交独立内核方案；不得把宿主执行当替代方案。镜像digest必须由真实构建得到，不能在计划中编造。

## 5. 看图、修订与交付

### 单模型

同一个模型依次理解题意、制作文件、调用preview_html、看到图像、说明具体问题、修改、再预览、交付。`singleModel=true` 继续禁止评审和委派；它仍可进行多次模型调用和本地工具调用。

### CoThink

主模型按现有能力规则选择执行者；执行成员得到原题、技能快照与自己的预览工具。主模型collect后审阅成果，按原题给具体反馈；验收最终组合时自己也能看到对应版本截图。采用已有feedback/refresh/accept流程，不增加固定“视觉评审模型”或额外共识阶段。

### 交付判断

复用task/work记录增加视觉证据引用，不另建数据库。每项证据至少绑定actor、changeId、privateVersion、entry、截图哈希、工具调用ID，以及实际携带图片的模型requestId。

```ts
type VisualEvidence = {
  toolCallId: string;
  actor: string;
  changeId: string;
  sourceVersion: string; // 执行前源码版本
  privateVersion: string; // 执行后回执版本；公共diff必须为空
  entry: string;
  images: Array<{ path: string; sha256: string }>;
  imageRequestId: string | null;
  result: 'captured' | 'failed';
};
```

- 受制作合同约束的任务，只有代码块、没有实际文件，不能completed。
- 最新交付版本没有对应截图，或图片未进入实际模型请求，不能标记视觉检查已完成。
- 修改或组合产生新版本后，旧截图只能作为历史参考；最终接纳后的集成版本必须重新预览并回传主模型，随后才给最终回复。不能把成员旧候选的截图直接用于不同组合。
- 已正式接纳但截图失败时保留接纳事实及文件，报告partial/未完成视觉检查，不回滚正式版本，不假称全通过。
- 程序只能验证文件、版本、图片传递和运行错误。主体关系正确、美观、运动自然等仍由模型与用户判断；“模型收到图”不等于质量已经被独立证明。
- 角色提示要求按“主体/动作/对象 → 动态行为 → 构图和交互”检查。修改要有具体反馈；没有依据时不重复生成碰运气。完成后用自然语言报告实际检查和未解决问题，不强迫模型输出整套内部证据JSON。
- 为使最终版本检查落到真实控制流，runWork需要把当前“leader.prompt一次返回→直接结束”改为有依据的收尾循环：模型先给终稿意向，宿主完成已有成员收尾/接纳与checkCurrent，针对确定的集成版本取得检查change、生成截图，再经同一leader会话发送带来源的图片材料；模型明确检查后给最终回复，或提供具体修订。发生修订则重新走接纳和新版本检查；未发生变化且已有对应图片请求证据时才发布resultWorkspace。
- 这里追加的是携带新截图/具体失败信息的必要工作请求，计入既有请求/费用记录，不是额外分类请求或原样重试。若没有新版本、新证据或具体修订行动，不反复催同一模型；以partial及缺项结束。取消和未知请求直接保留现场。
- 图片收尾材料是来源明确的内部custom message，不伪造成用户的新要求。当前runtime的custom分支只发送文本，实施时扩展其content为text+image数组，并保留已有纯文本调用兼容；必须测试实际provider payload包含PNG。
- 截图、DOM文本和控制台信息都属于待检查的作品内容，不得当成新权限或系统指令。绑定版本/图像哈希证明来源，不证明画面中的文字可信。
- 主模型不支持图像或API拒收图像时，不偷偷换模型/降级成纯文字视觉检查；保留作品，明确缺项。能力预检能发现的错误尽量在首个模型请求前阻止。

## 6. 文件职责与必要新增

| 文件 | 变化与职责 |
|---|---|
| src/discussion.js、src/task.js | 接收workRequest；明确制作跳过draft直接进入runWork；保存制作合同；不改变普通问答1/3次政策 |
| src/extensions/cothink.js、prompts/main.md | 自然语言制作应start_work；新增可选deliverableKind，与直接入口汇合 |
| src/workers.js | 接收显式initialMaterial；两种模式注册同一预览能力；最终版本证据门槛与具体反馈 |
| src/context.js、src/pi-runtime.js | 复用技能冻结和图片消息路径，验证实际payload携带image；避免技能快照与资源配置相互覆盖 |
| **src/visual-preview.js（新增）** | 将public exec/read包装成preview_html、核对版本、解析输出、保存证据并返回图片；没有它，模型拿不到受控渲染和图片反馈 |
| **scripts/visual-preview.mjs（新增）** | 容器内固定预览程序：允许树的本地服务、Chromium、截图、动作、日志和清理；不含模型调用 |
| **docker/visual-preview.Dockerfile（新增）** | 可复现浏览器运行依赖；不能依赖宿主碰巧安装的Chrome。构建锁定清单与镜像证据随文件保存 |
| src/cli.js、src/setup.js、src/interactive.js | make-html单次入口和帮助；模式、草稿与恢复保持原规则 |
| src/gui-controller.js、src/gui-server.js、gui/src/App.jsx、gui/src/Composer.js | GUI制作入口传同一workRequest，未关联项目时明确提示；防止重复提交 |
| src/gui-projection.js、src/gui-work.js、gui/src/Collaboration.jsx | 只投影本任务的截图/错误/检查状态；鉴权读取PNG，不暴露任意宿主路径 |
| scripts/visual-bench/worker.mjs、core.mjs、runner.mjs | 新轮次可冻结同等制作入口、技能和镜像；旧轮次仍按原记录查看，不重写 |
| package.json、README.md、VALIDATION.md、DESIGN_BASELINE.md | 打包新增脚本、说明配置与证据边界；批准后同步基线 |

不修改packages/agent-sync源码或vendor模型SDK，不增加技能市场、模型适配层、递归成员、独立评审服务和自动重试。

## 7. 验收标准

1. 同一HTML任务，ONE与CoThink的明确制作入口都进入真实runWork，原题字节不变；ONE全程只有主模型，CoThink按合法成员规则执行。
2. 一般问题仍为ONE一次、普通CoThink三次；只要示例代码的请求不会被确定性入口强制执行。自然语言自动识别效果不以fixture冒充真实语义验证。
3. 实际技能正文和哈希进入领导/成员上下文；未配置、读取失败、名称冲突均可见，运行期间修改原skill不改变当前快照。
4. 真实Docker+Chromium能离线渲染带动画和中文的固定作品，采集多个时刻及手机/桌面视口；错误、外联、资源失败可见。
5. localhost模型fixture确实收到PNG图像块，然后生成修订；第二次截图绑定新版本。只写“看过图”或返回路径不能通过。
6. 旧截图、错误candidate、未发送图片、渲染失败、最终组合变化均不能假完成；原作品与已接纳事实保留。
7. 取消及异常无残留浏览器/容器进程；未知执行只查询原requestId，不重发。
8. 旧九任务数据、盲选顺序和选票不变；不自动调用旧轮次或收费API。

## 8. 顺序施工与本地验证

### Task 1：验证并准备离线浏览器环境

**Files:** 新Dockerfile、容器预览脚本、`test/visual-preview.test.js`；保留证据于work/visual-workflow/。

**Consumes:** 当前agent-sync公共exec/read、固定执行策略。**Produces:** 实测可用的镜像digest、固定renderer入口和有界结果格式。

- [x] 建立临时Git项目和带SVG/CSS/JS动画、中文字体的fixture；先核对文件变化并解释仅操作临时测试历史。
- [x] 用真实公共API授予明确scope，运行固定容器脚本，验证PNG签名/尺寸及源码内容未变，并保留执行前后版本。
- [x] 验证外部陷阱HTTP/WebSocket服务器收到0请求、不能读取投影外文件、慢/死循环页面被清理。
- [x] 对截图依赖缺失、取消、畸形输出和超量输出记录失败，不改成跳过；不满足公共合同则停止后续实现并报告具体缺口。

核心验证结构：

```js
const before = await versioning.inspect({ changeId });
const result = await versioning.exec(changeId, {
  requestId, expectedVersion: before.privateVersion,
  command: fixedPreviewCommand,
  timeoutMs: 30000,
}, { signal });
assert.equal(result.status, 'completed');
assert.equal(result.exitCode, 0);
assert.deepEqual(result.changedFiles, []);
const after = await versioning.inspect({changeId});
assert.equal(after.privateVersion, result.privateVersion);
assert.deepEqual(await versioning.inspect({fromVersion: before.privateVersion, toVersion: after.privateVersion}), {files: [], text: '', binaryFiles: []});
// 再以read({outputRef:requestId,...})分页取回真实PNG；不使用模拟截图。
```

### Task 2：制作入口和技能快照

**Files:** discussion/task/extensions、CLI/TUI/GUI提交入口；扩展 `test/pi-routing.test.js`、`test/pi-entrypoints.test.js`、`test/gui-controller.test.js`，技能现有断言归入对应context测试。

**Consumes:** 现有会话、Team、模式与freezeAnswerSkills。**Produces:** 冻结的 `workRequest:{kind:'html-svg'}` 和同一技能快照。

- [x] 先写入口行为用例：明确制作首个模型请求就有工作工具；纯答路径不受影响；无项目/无环境预检零模型请求。
- [x] 将直接工作与start_work汇合，给runWork增加显式initialMaterial参数，保留当前分支上下文。
- [x] 技能来源仅取显式配置；网页制作配置中指定frontend-design，模拟运行中技能文件变化并核对leader/member仍用冻结哈希。
- [x] 检查GUI快速重复点击、运行中模式切换、历史恢复、管道多行文本；不把材料内命令当操作。

### Task 3：preview_html与图片回传

**Files:** 新src/visual-preview.js、workers、必要的runtime图片封装；新增 `test/visual-workflow.test.js`，复用 `test/helpers/pi-fixture.js`。

**Consumes:** Task 1固定renderer；当前task/stage/change及公共versioning实例。**Produces:** 上述PreviewInput对应的Pi text+image工具结果、VisualEvidence。

- [x] 在fixture中让模型写出初版、调用preview_html；检查下一请求确实包含图片内容和原始目标。
- [x] 两种模式使用同一工具构造与同一renderer；取消信号、版本检查、权限和工具记录按现有workspaceTools约定接入。
- [x] 取回输出后只把验证过的PNG保存到本任务artifact目录，解析失败保留原outputRef，不返回伪造图片。
- [x] 运行真实截图的localhost循环；不以工具mock代替PNG生成或实际请求中的图片。

### Task 4：修订与最终版本门槛

**Files:** workers、leader/worker prompts、task evidence；扩展visual-workflow与agent-sync-entrypoints测试。

**Consumes:** Task 3图片与版本记录。**Produces:** 对应最终版本的截图回传证据及诚实终态。

- [x] fixture用初版红色SVG→PNG输入→修订为蓝色SVG→新PNG→接纳→最终组合截图→最终回复的序列，验证新旧图片/版本不同、源码未由截图工具修改。
- [x] ONE检查没有副模型请求；CoThink检查主模型与成员都实际接收其负责版本的图片，feedback包含原题及具体修订意见。
- [x] 收尾先固定并检查实际集成版本，再把真实截图作为内部材料送入同一主模型会话；fixture收到图后才发送最终回复，或根据图修改后重新检查。所有新增调用照常记账。
- [x] 模拟截图未入下一请求、接纳后组合改变、缺图能力：均不能完整完成；保留内容和明确缺项。不用原样提示重复催促，不重发未知请求。
- [x] 视检只作为制作交付的证据要求，不冒充agent-sync的可信正式检查或普遍审美结论。

### Task 5：展示、打包与评测准备

**Files:** GUI投影/图片读取、Collaboration、package.json、文档与visual-bench配置消费。

**Consumes:** 冻结制作合同与证据。**Produces:** 用户可查看的版本/截图/错误，以及同条件的新轮次准备能力。

- [x] GUI截图路由只接受task内已登记artifact引用，校验真实路径和PNG类型，拒绝跨任务/路径穿越；CLI提供可点击本地证据位置。
- [x] 打包确认新脚本可用，浏览器镜像预检明确所需digest，不在模型运行中联网下载。
- [x] 新benchmark使用同一制作入口、相同技能快照/镜像/视口/动作能力；prepare冻结这些条件，旧配置/成果仅查看。
- [x] 执行相应新测试、`npm test`、`npm run test:gui`、`npm run test:visual`、`npm run build:gui`及必要CLI/TUI检查。失败保留，不把缺Docker/浏览器改为skip。
- [x] 本地证据通过后交付；真实模型的题意理解、看图有效性和审美收益仍未验证。付费复验须在另行明确授权后新开轮次，不由此计划自动触发。

## 9. 实施前后的约束

本方案批准前不改变产品行为。批准实施后也不自动授权Git发布、全局替换、收费生成或修改agent-sync。Git操作遵守先检查变化、解释目的、只处理明确文件的项目规则。

验收报告分别列出代码/fixture、实际Docker浏览器、本机GUI与真实模型证据。不得把“机制跑通”写成“画面一定更好”，不得把本次模式入口变化隐藏在旧实验结果中。

## 2026-10-28 版本合同修订与归属

用户批准继续，要求明确 agent-sync 修改边界。采用 CoThink 调用方适配：记录前后版本并经公共 diff 验证内容不变；最终检查绑定确定集成版本，检查 change 无内容变化则 abandon，不接纳操作记账提交。此修订不修改 agent-sync 内核、依赖或恢复语义。若今后确需内核修改，另列方案与审批；旧失败证据保留。

## 2026-10-28 本地交付结果

Task 1–5 的本地实现和约定验证已完成。主套件 294 通过 / 3 个原有 Windows 专属跳过；GUI 80 通过；视觉套件 37 通过。真实 Docker、localhost provider PNG payload、CLI、PTY、GUI 三视口及隔离安装验证通过。候选中 143 个随包文件与当前源码字节一致。

全部修改属于 CoThink；agent-sync 内核/依赖未修改，执行前后版本与空差异适配通过公共 API 实现。保留初始版本假设失败、技能元数据重载修复和并行测试失败；证据与归属清单见 work/visual-workflow/progress.md。

未付费调用、未发布/推送、未替换全局安装；Windows Docker/Linux x64 与真实模型质量未验证。不把 fixture 完成当作真实审美收益。
