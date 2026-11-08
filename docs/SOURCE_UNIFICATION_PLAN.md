# CoThink 单一源码与双入口实施计划

目标：在现有私有开发仓库中维护唯一CoThink核心、一个根包版本和CLI／GUI两个入口。公开发行内容由固定源码版本生成，不作为第二个手工开发主线。

## 固定输入与约束

- GUI起点：e887c4355b722b8f2f78d9448b8454f8d010f5da。
- CLI发行输入：175780af59c32d221ec558ac9174c71614a24847。
- 共同来源：fc5b0626e2d532e7527e90325d3493567b6d6c75。
- 候选分支codex/unify-cli-gui；验收后的长期分支main；唯一写入远端XSY-28/cothink-gui，保持private。
- 原CLI工作目录及其未提交／未跟踪内容、公开发行checkout、用户配置与全局安装保留。私人快照、日志和实际会话不进入Git。
- 一个根包版本0.8.0-unified.1，仍为未发布私有候选。生产依赖、bundledDependencies与4个锁定SDK归档保持既有字节；不增加core包、模型后端或CLI到GUI的HTTP转接。
- Pi／runTurn／agent-sync边界不变；ONE问答一次，讨论问答三次，工作maxCalls=null，ONE不委派。未知结果不重发，partial保留；Windows原子文件替换的有限重试不属于模型重试。
- 本轮允许实施、测试、本地提交和私有同步；不授权收费模型、npm／公开发布、全局安装切换或强推。

## Task 1: 合并固定CLI修复并保持两入口

Requirements:
- 复用已经独立于原目录的GUI开发副本，在codex/unify-cli-gui工作；正常读取本地CLI发行提交并三方合并，保留两方历史。
- 解决package.json、package-lock.json、README.md、CHANGELOG.md、VALIDATION.md冲突。根版本0.8.0-unified.1，保留GUI入口、files、依赖及完整许可；元数据指向私有统一仓库，旧发行证据按版本保留。
- 合并后必须同时保留src/pi-runtime.js的secretValues导出与length诊断、src/storage.js的最新generation/released只读判断与Windows原子保存修复；保留输入中的UTF-8 fixture修正、真实文件锁与截断测试、CI版本传递。
- 以RED/GREEN增加实际localhost HTTP GUI的length/partial回归：保留已收文本、阶段／模型／额度事实、调用次数正确、未知不重发。错误操作建议同时适用于模型设置与CLI参数；最小调整现有自然语言说明，不新增错误框架。
- 更新AGENTS.md和README的维护入口：唯一私有开发主线；CLI与GUI共用核心；公开仓库为按版本生成的发行入口；原目录只保留，不在原目录写入标记。
- 不提前重构设置、SDK、agent-sync或新建发布框架。不修改本计划（由主控维护）。不推送，不切main。

Verification:
- 保留完整merge父提交与冲突解决清单；确认4个归档字节不变、生产依赖不变。
- 新HTTP回归有明确RED/GREEN。运行受影响的GUI历史／controller、请求／会话／writer和Windows源码测试；平台跳过如实报告，不能替代原生WindowsCI。
- 完整端到端／打包由Task3统一执行。产出明确本地提交、文件清单、日志路径和报告。

## Task 2: 统一版本驱动的构建与CI

Requirements:
- 基于Task1通过版本，保留一个pack:npm入口，每次先构建GUI。CLI与GUI安装来自同一候选包。
- 调整.github/workflows/gui.yml为main push／针对main的PR／手动触发；用根package版本和现有pack-result元数据驱动expected version与精确tarball路径，不再写死0.8.0-gui.1。
- 复用现有Linux ARM64完整源码／内核／GUI／PTY／Docker及安装后集成。固定Docker digest必须先拉取、核对架构和禁网预检；准备现有rg与pyte依赖。
- Windows x64与ARM64执行现有Windows专项、DOM显示、构建、独立安装和真实GUI HTTP历史检查；x64额外复用既有ConPTY入口。Windows不冒称Docker或物理IME通过。
- 调整test/helpers/gui-installed.mjs和必要的GUI打包测试，按调用方明确期望或源码版本核对实际安装版本，不接受“拿安装包自己的版本与自己比较”的空检查；保留分发文件／SDK及所有静态资源字节核对、认证与实际启动检查。
- 尽量复用现有test/helpers/npm-installed.mjs、windows-installed.mjs及测试夹具。不要为一次版本合并新建通用release服务或重复整个测试循环。
- 更新文档中实际命令与边界；不修改本计划，不推送，不切main。合理配置修改使用实际YAML、构建、安装和CI核验，不编写仅镜像文本的测试。

Verification:
- 运行相关GUI package／view／组件与脚本验证、构建、YAML检查；重型组合测试与最终干净安装由Task3统一顺序执行。
- 产出明确本地提交、测试命令、文件清单和报告。具体CI平台结果由Task4实跑，不能提前宣称通过。

## Task 3: 最终组合与安装验收

主控顺序执行完整npm test、test:agent-sync-core、test:gui、test:pi-terminal、build:gui。工具依赖使用隔离Python环境；Docker使用既有固定镜像，不回退宿主执行。

从最终源码重包，在含中文／空格的全新prefix安装；验证真实CLI、GUI、SDK、全部静态资源、分发文件字节与候选哈希。安装后运行实际HTTP／CLI PTY／Docker／分支／损坏历史及新增partial回归；检查原项目不自动写回。

使用实际安装候选做GUI针对性浏览器检查：版本、连续对话或partial错误指引、保留内容与不重放。无需重复未改布局的所有截图；新受影响行为必须有现场或真实HTTP证据。

分任务审查与整分支独立审查，修复重要发现并复核。保留旧失败、候选与未知费用；不以两方历史通过代替新组合验收。

## Task 4: 私有主线交付

- 校验源码allowlist和敏感数据排除；重新核验目标为private。只正常推送到XSY-28/cothink-gui。
- 通过版本快进本地main，将main上游设为私有origin/main，正常推送并运行统一CI。CI失败继续定位修复，不强推。
- CI通过后将私有默认分支设为main；移除本轮曾用于本地读取发行源码的source-local临时远端，来源仍在merge历史和证据中，保留旧分支与原目录。
- 重新读取远端SHA／默认分支／可见性，核对主要blob；最后文档如单独提交，明确绑定通过CI的源码SHA与未变化的运行字节。
- 交付统一开发根目录、两入口命令、候选包与哈希、最终SHA、CI链接、完整验证记录和未验边界。

## 进度

执行状态与失败证据保存在本计划对应的本地忽略账本；此文件定义验收要求，不以写完计划作为实现完成。

2026-10-23：固定输入正常合并；本地完整源码、实际安装和浏览器验收通过。[CI 39978528008](https://github.com/XSY-28/cothink-gui/actions/runs/39978528008) 在源码 `22e9117f5998f62be3b45bb4cba8176924f865d9` 上通过 Linux ARM64、Windows x64／ARM64，包括明确使用后端 0 的实际 ConPTY。曾误用旧 WinPTY 后端 1 的失败与诊断记录均保留，最终移除临时探针。运行源码和冻结 SDK 不受终端验收脚本修复影响，完整范围及证据边界见 [SOURCE_UNIFICATION_ACCEPTANCE.md](SOURCE_UNIFICATION_ACCEPTANCE.md)。
