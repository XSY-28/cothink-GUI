# CoThink 新版本提醒施工方案

> **For agentic workers:** 使用 executing-plans 按任务逐项执行；本侧聊不启用子代理。步骤用复选框记录。用户于 2026-10-26 授权创建分支并施工，随后明确授权提交并合并到本地主线；不授权推送、发布或全局安装。

**Goal:** 用户使用旧版 CoThink 时，能够在 CLI 和 GUI 内知道发布了新版，并找到适合自身安装方式的更新指引。

**Architecture:** 参考当前随包 Pi 1.4.0 的查新与版本比较思路，在 CoThink 侧建立一个共享查新模块。CLI 与 GUI 共享发布源、版本判断和缓存，继续复用现有通知、设置和本地更新记录，不启动更新服务或第二套模型运行路径。

**Tech Stack:** Node.js fetch、AbortController、semver、既有 Pi TUI、React GUI、node:test、现有 GUI/PTY 验证。

**Spec:** 本文第 1—5 节为拟实施规格；同时遵守 DESIGN_BASELINE.md。写作日期：2026-10-26。

## 1. 目标、范围与基线修订

当前 releaseNotes() 只读取安装包 package.json 与 CHANGELOG.md。CLI 首次启动展示本版本摘要，GUI 提供未读摘要；这两者不能发现尚未安装的版本。

当前基线“2026-10-19 已批准的本地更新摘要”明确规定“当前不建立联网查新渠道”。实施获批后，在基线追加本次修订：允许 CoThink 自身在交互入口后台检查官方发布版本；原有本地更新摘要、Pi 上游查新关闭及模型零调用要求保留。不要提前将本方案写成已批准或已实现。

首版包含：后台查新、手动检查、版本提醒、更新说明/安装指引入口、关闭自动检查。

首版不包含：自动下载、自动安装、一键替换当前程序、自动重启、操作系统通知、常驻守护进程、扩展包升级、额外模型调用。用户暂不更新时继续使用，不中断任务。

**全局约束：**

- 不修改 agent-sync 源码、接口、依赖版本或保证；如果确实需要修改，停止该部分并单独提交方案审批。本功能预计不需要。
- 不改变 Team、认证、历史、工作预算、协作和模型请求政策。
- 本轮先免费验证，不使用付费模型。
- 未获后续授权不提交、推送、发布、替换本机安装。执行任何 Git 操作前先检查变化文件并解释操作。
- 本文只写入当前文档路径；实现时选择当前产品 checkout，不能将旧评测工作树整体带入产品。

## 2. Pi 参考与取舍

已只读检查当前产品 `cothink-gui` 随包实现：

- `node_modules/@earendil-works/pi-coding-agent/dist/utils/version-check.js`
- 同路径 `.js.map` 内嵌 TypeScript 源码。
- `dist/modes/interactive/interactive-mode.js.map` 中本地 changelog 展示逻辑。

| Pi 当前实现 | CoThink 处理 |
| --- | --- |
| 请求 https://pi.dev/api/latest-version | 改用 CoThink 自身发布源，不向 pi.dev 查询 CoThink |
| semver.valid / compare | 复用成熟 semver 语义，避免字符串比较 |
| 无效版本时以“不相等”判断有更新 | 不采用；无效值显示无法判断，绝不提示安装 |
| 默认版本检查超时 10 秒 | 查新请求总期限采用 5 秒，涵盖读取响应体；与模型请求超时无关 |
| checkForNewPiVersion 捕获错误并静默返回 | 自动检查安静失败；手动检查明确显示失败，不能说已是最新 |
| 底层允许显式启用最多两次重试 | 不启用；一次检查一次请求，手动点击才再次检查 |
| PI_OFFLINE / PI_SKIP_VERSION_CHECK | CoThink 提供自己的开关；尊重外部明确设置的 PI_OFFLINE；不依赖内部为关闭 Pi 查新设置的变量 |

不直接导入 Pi 私有 dist 路径、不修改 vendor tarball，不直接复用绑定 Pi 发布源的函数。借鉴实现时保留必要许可证/来源说明。semver 作为显式直接依赖固定版本并纳入 bundledDependencies；实施时沿用当前 Pi 锁定依赖图中实际使用的版本，不能依赖偶然 hoist。安装包验收确认离线运行可解析该依赖。

## 3. 发布源与版本规则

### 3.1 唯一查新来源

后台固定 GET `https://registry.npmjs.org/cothink-v2/latest`。该 URL 是拟采用的接口；施工时用一次无认证只读查询验证响应 schema，自动测试使用本地 fixture。

只接受 package name 为 `cothink-v2`、version 为有效 SemVer 的成功响应。超时、非 2xx、畸形 JSON、超大响应均为检查不可用。限制响应体最多 256 KiB；拒绝重定向，不从响应读取可执行命令或任意下载地址。请求不携带模型密钥、npm token、会话、项目路径或用户材料，不读取用户 npm 认证来查新。

版本以 npm latest 渠道为准，GitHub Releases 用于说明与分平台下载。发布者应先准备公开说明和资产，再将对应版本推广到 npm latest；未发布到 latest 的版本不主动推荐。提醒意味着 npm 推荐版本已可发现，不代表所有平台资产均已核实可用。

### 3.2 比较语义

- 使用 semver.valid 和 semver.compare，只有远端严格大于本地才提醒。
- `0.8.3-delegation.1` 等预发布版本不能简单丢弃：只要发布者明确放到 latest，就可推荐；界面标明“预发布版本”。不额外建立 beta 渠道。
- 同核心版本的正式版高于其预发布版；数字预发布段按数字比较；build metadata 不改变排序。
- 本地开发版、非法版本、远端回退到更低版本均不误报“请升级”。本地更新时保留本地更高版本，不建议降级。
- “已是最新”仅用于成功取得合法元数据且版本相等；本地更高显示“当前版本高于发布渠道版本”；失败显示“暂时无法检查”。

### 3.3 公开入口

固定说明/下载页：`https://github.com/XSY-28/Cothink-release/releases`。
固定 npm 页：`https://www.npmjs.com/package/cothink-v2`。
不为每次检查额外请求 GitHub API，也不从远端自由文本生成 Shell。

## 4. 交互和检查生命周期

### 4.1 CLI

- 全屏终端已就绪后触发后台检查，不 await 网络后才允许输入。
- 发现更新显示：`CoThink 有新版本：当前 X → Y。/updates 查看更新方式。`
- 提示为宿主通知，不进入模型上下文或历史对话正文；不抢焦点、不清草稿。
- 新增 `/updates` 本地面板，显示当前版本、最近成功检查时间、已知最新版本、是否使用旧缓存、说明链接及更新方式。
- 面板可“检查更新”“关闭/开启自动检查”；关闭后仍可手动检查。
- 新增 `cothink check-update [--json]`，在模型配置/Team 迁移之前分派，无 API key 也可用。成功检查返回 0，检查失败返回 1；JSON 只输出该命令结构化结果。
- `ask`、管道、history、show、--help 等入口不自动查新、不添加输出。`/changelog` 保持本地离线含义。
- 未知 `/updates ...` 参数本地报错，不能意外发给模型；命令补全、保留命令列表同步更新。

### 4.2 GUI

- 页面先可用，后台结果通过已有 controller 订阅机制刷新，不在 bootstrap 中等待网络。
- 顶部或设置入口附近显示非模态“有新版本”提示；点击展开版本、说明和指引。
- 复用现有设置面板加入“自动检查更新”和“检查更新”按钮。
- 保持本地“本次更新”摘要与远端“可更新”提示语义分离，不拿旧 CHANGELOG 冒充远端新版说明。
- 关闭提示仅作用于当前界面生命周期；之后启动可再次显示已知新版本，不新增“永久忽略版本”存储。
- 检查进行中按钮禁用；失败显示可读状态。已有运行、草稿与选中对话保持不变。

### 4.3 节流、关闭与退出

- 默认启用自动检查，设置和 README 明示会访问 npm；`COTHINK_NO_UPDATE_CHECK=1` 禁止自动检查。显式外部 PI_OFFLINE 禁止所有查新，包括手动，并说明离线状态。
- 同一数据目录持久记录自动尝试时间；24 小时内不再自动发请求，失败也计入间隔。手动检查可绕过间隔；同进程共享进行中 Promise，连续点击不并发发请求。
- 本轮不增加跨进程锁服务。多进程恰好同时首次启动可能各发一个请求；“每日一次”是持久节流，不承诺跨进程严格配额。缓存写使用现有原子文件函数，不能破坏其他 UI 状态。
- 已打开超过 24 小时的实例，在窗口重新获得焦点或下一次用户提交任务的本地事件处检查是否到期，然后后台触发；不建立周期守护任务、不阻塞提交。
- 自动失败不弹错误；手动页面显示失败和上次成功信息。旧缓存明确注明检查时间，不能冒充本次在线结论。
- 状态文件损坏或不可写：保留原文件，自动检查禁用到本次进程结束；手动检查可用内存结果，提示无法保存偏好/缓存，不能宣称已保存开关。
- 时间戳在未来或类型异常视为无效缓存，不无限抑制检查；退出取消在途请求，移除事件监听，不允许晚到结果污染终端或关掉的 GUI。

## 5. 更新方式：指引，不执行安装

面板让用户按原安装方式选择指引，不仅凭操作系统猜安装方式。展示当前程序路径用于识别；不扫描全盘、不执行 npm 来探测安装。

| 原安装方式 | 展示指引 |
| --- | --- |
| npm 全局，macOS/Linux | `npm install -g cothink-v2@<已验证的目标版本>`；自定义 prefix 用户沿用原 prefix |
| npm 全局，Windows | `npm.cmd install -g cothink-v2@<已验证的目标版本>` |
| Windows ZIP | 打开官方 Releases，下载适配架构的新版，退出旧程序，在新目录安装启动；保留原数据目录 |
| 源码、托管目录或无法判断 | 打开官方指引，按原方式更新；不提供可能覆盖另一安装的默认执行按钮 |

命令只供阅读/复制，不由 CoThink 执行。目标使用检查时的精确有效版本，避免 latest 在检查后变化。提醒退出旧进程后重开；不删除 COTHINK_HOME、不自动备份/迁移用户目录。已有旧版用户需要先手动安装一次含此功能的版本，以后才有提醒。

## 6. 文件与接口

以下路径相对当前产品仓库 `cothink-gui`；实施时重新确认 checkout 与用户改动。

| 文件 | 变更职责 |
| --- | --- |
| 新建 src/updates.js | 共享版本校验、请求、缓存、偏好及指引数据；单模块，不拆检查器/调度器框架 |
| src/cli.js | 无模型配置前处理 check-update，帮助 |
| src/interactive.js | 就绪后触发、通知、/updates 面板及事件清理 |
| src/packages.js | 更新命令保留列表，防扩展遮蔽 |
| src/gui-controller.js | 共享服务实例、只读更新状态、动作和已有订阅通知 |
| src/gui-server.js | 给已有认证动作白名单加入更新操作；不新增外部服务器 |
| gui/src/App.jsx、Settings.jsx、styles.css | 更新提示、面板、开关及状态 |
| package.json、package-lock.json | 显式 semver 依赖、bundle、新文件打包清单、测试入口 |
| DESIGN_BASELINE.md、README.md、CHANGELOG.md | 获批后修订范围、操作与离线/联网说明 |
| test/pi-updates.test.js、test/gui-updates.test.js | 核心行为与 GUI 接入验证 |
| test/pi_slash_checks.py、test/pi-entrypoints.test.js | 真实终端命令/非交互输出约束 |

新增模块和缓存的必要性：没有共享模块，CLI/GUI 会产生两套查新规则；没有缓存与偏好，重启后无法遵守节流和关闭设置。采用单文件 `COTHINK_HOME/update-state.json`，不修改现有 releaseNotes 已读结构，不引入数据库或新配置层级。

共享工厂建议合同：

```js
createUpdateService({ home, currentVersion, fetchImpl = fetch, now = Date.now })
// 返回：
// snapshot() -> { currentVersion, latestVersion, status, checkedAt,
//                 stale, automatic, error, releaseUrl }
// check({ manual = false }) -> Promise<上述快照>
// setAutomatic(boolean) -> 已持久化的快照；失败抛出可读错误
// close() -> 取消在途请求、阻止迟到更新
// status: unchecked | checking | available | current | ahead | unavailable | disabled
```

缓存仅保存 schemaVersion、automatic、lastAttemptAt、lastSuccessAt、latestVersion。状态按当前版本重新计算，不持久化网络错误或安装命令。生产 endpoint 固定；测试用 fetchImpl 注入，不给用户任意更新服务 URL 配置。GUI 复用既有动作通道 `updates.check`、`updates.configure`；请求字段由宿主验证，页面不能传 endpoint 或包名。

## 7. 施工步骤与验收

### T1：共享查新及状态

- [x] 检查当前产品文件变化，确认基线修订已获批准；固定 Pi/semver 依赖版本与许可证。
- [x] 新增共享模块和必要行为测试，再实现请求、SemVer、节流与开关；复用 writePrivateJson 原子写，不覆盖损坏状态。
- [x] 用可控时钟、可挂起 fetch 和临时 home 验证；测试不访问公网、不构造模型会话。
- [x] 验证以下断言：

```js
// 基于公开行为验证，实际工厂导入来自 src/updates.js。
const service = createUpdateService({
  home, currentVersion: '0.8.3-delegation.1',
  fetchImpl: async () => new Response(JSON.stringify({
    name: 'cothink-v2', version: '0.8.3'
  }), { status: 200 }),
  now: () => 1000000000
});
const result = await service.check({ manual: true });
assert.equal(result.status, 'available');
assert.equal(result.latestVersion, '0.8.3');
service.close();
```

- [x] 执行 `node --test test/pi-updates.test.js`。通过标准见第 8 节，不以测试数作为完成标准。

### T2：CLI 最短使用路径

- [x] 先接入无配置也可运行的 check-update，再接交互 /updates 与后台通知。
- [x] 增补已有入口/PTY 测试：假 registry 宣告新版 → 界面提醒 → 打开更新面板 → 草稿保留；关闭自动检查后重启无请求。
- [x] 执行 `node --test test/pi-updates.test.js test/pi-entrypoints.test.js` 及 `python3 test/pi_slash_checks.py`。
- [x] 验收管道/JSON 无额外文本、无模型请求、退出不被检查拖住；/changelog 行为保留。

### T3：GUI 同源接入

- [x] 接 controller 共享服务、后台完成事件与已认证动作；bootstrap 只读取快照。
- [x] 加入非模态提示、设置开关与手动检查；采用现有组件/样式，不另建通知中心。
- [x] 增补测试：挂起请求不阻塞页面、完成后显示、失败不报最新、设置失败回显、取消页面后无迟到影响。
- [x] 执行 `npm run test:gui` 和 `npm run build:gui`；通过浏览器实际点选并检查窄窗口、键盘操作、焦点与草稿。

### T4：打包与整体交付

- [x] 更新基线、README、CHANGELOG；增加设置对外联网说明和旧版用户首次手动升级说明。
- [x] 执行 `npm test`、`npm run test:terminal`、`npm run pack:npm`；修复与本次变更有关的失败，保留无关失败证据。
- [x] 在临时目录安装候选包，验证共享模块和 semver 已打包；用本地 fixture 检查 CLI/GUI、断网启动与空 home，无全局安装切换。
- [x] 记录 agent-sync 相关文件与依赖前后哈希不变；所有模型请求数为 0。
- [x] 输出验收报告，分别列离线测试、真实浏览器、打包安装、一次官方元数据读取、Windows CI/实机证据和未验证项。
- [x] 未获发布授权时停在本地验收；不能把“功能完成”写成“用户已收到更新”。

## 8. 必过行为清单

| 情况 | 期望 |
| --- | --- |
| 同版本、远端更低、本地更高 | 不提示升级；文案区分相等与本地更高 |
| prerelease.2 → prerelease.10、预发布 → 正式 | 按 SemVer 正确判断 |
| build metadata 不同 | 不当成版本升级 |
| name 错误、非法版本、控制字符 | 拒绝元数据，不显示命令 |
| 断网、5 秒超时、挂起响应体、500、畸形 JSON、超大响应 | 不阻塞使用；手动显示失败；无自动重试 |
| 自动关闭、外部离线、管道/ask/JSON | 遵守网络及输出边界 |
| 24 小时内重启、手动检查、并发点击 | 节流有效；手动可刷新；同进程请求合并 |
| 缓存损坏/不可写/未来时间戳 | 原件保留，状态诚实，不改用户配置或历史 |
| 查询中退出、刷新/重开 GUI | 无未处理异常、无资源泄漏、无关闭后通知 |
| 没有 API key、旧配置尚未迁移 | 手动检查可用且无模型请求 |
| npm/ZIP/自定义 prefix/源码安装 | 指引匹配所选方式，不代执行、不建议未知安装盲目覆盖 |
| 已安装新版首次启动 | 原本本地更新摘要照常展示，不误报远端更新 |

## 9. 完成标准和证据边界

用户能从安装着旧版的 CLI 或 GUI 中看到 fixture 宣告的新版本；能够手动检查、关闭自动检查、打开说明并找到更新方式；检查失败仍可正常使用；没有模型费用、agent-sync 变化或自动安装。

离线 fixture 证明机制，不证明未来 npm/GitHub 始终可用。官方元数据读取只证明当时发布源可访问，不证明真实升级与回退成功。Windows CI 不等于 Windows 物理终端验收。发布与本机更新仍是独立后续动作。

本方案优先完成“知道可以更新”。若后续需要一键安装，另写包含安装来源识别、活跃进程检查、完整性校验、候选切换和回退的方案，不把安装器隐藏在本次提醒功能中。


## 本次施工结果（2026-10-26）

按用户授权在当前产品主线的独立分支 `codex/update-notification` 完成 T1–T4 的本地施工和验收；不提交、推送或发布。分层证据摘要见 VALIDATION.md，原始失败、截图、安装及哈希证据在忽略目录 work/update-notification。上述“模型请求为0”指没有真实/付费模型请求；既有模型机制回归使用 localhost fixture。Windows CI/实机和真实升级回退未验证。

2026-10-26 后续授权：用户明确要求“合并到主线里”，据此允许为本次成果建立本地提交并合并到产品 main；原先不提交的边界被本次明确授权更新，推送、发布和全局安装仍不在范围。
