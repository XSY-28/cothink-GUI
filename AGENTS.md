# CoThink 维护约定

开始项目工作前完整阅读 [DESIGN_BASELINE.md](DESIGN_BASELINE.md)。行为和验收以当前基线为准，历史夹具不构成运行规格。

- 从用户当前需要出发；新增对象、配置或模块前，说明没有它用户哪件具体事情做不了。
- 修改运行行为时沿用唯一 Pi 调用路径与独立 agent-sync 内核边界；保留原始失败、部分结果和未知费用。
- 完成前运行与改动有关的 `package.json` 检查，报告本地 fixture、真实模型与现场验收各自的证据和缺口。完整测试包含本机 Docker 容器，不能把缺少环境改成 skip。
- Git 操作前检查变化文件，并说明目的和影响；只暂存明确文件。认证、任务记录、私有备份和本机路径留在仓库外。付费生成、推送和发布须有用户授权。
- 普通原生工具复用 Pi 动态注册表与独立副本，文件结果沿用创建者审阅和公共 edit/accept；本地命令不得启动未绑定的模型工作。GUI 使用固定插件的 headless 工具／workflow 引擎，原生 TUI 明确指向终端。选定 `pi-subagents@0.84.0 + native-host-admission-v2` 的原生前台／后台 subagent、workflow 和旧前台助手共享意图／副本／结果路径；后台复用同一认证宿主与源码屏障，远端及其他未适配路由不得绕过受管副本、父审阅与正式接纳。具体边界见 docs/pi-subagents-host-contract.md。包候选补丁与来源哈希须可追溯，未知停止／用量不得补成成功或零。
- 版本更新同步 README、CHANGELOG 与 VALIDATION；第三方补丁和产物哈希保持可追溯。安装包与源码分别验证。


# CoThink GUI implementation

For project-Team GUI work, read docs/gui/TEAM_WORKSPACE_DESIGN.md and docs/gui/TEAM_WORKSPACE_IMPLEMENTATION_PLAN.md. The user approved local implementation and validation of this iteration on 2026-11-07. REDESIGN_PROPOSAL.md / REDESIGN_IMPLEMENTATION_PLAN.md retain the preceding iteration; DESIGN.md / IMPLEMENTATION_PLAN.md / ACCEPTANCE.md retain the first iteration. Current implementation evidence is in VALIDATION.md.
Keep one Pi model path and the existing agent-sync boundary. The current baseline permits installed agent plugins; preserve parent ownership, resource selection and agent-sync acceptance. No new automatic retries or unrecorded model calls.
Before Git operations inspect changed files; stage only explicit paths. Never push to the public source repository.
The 2026-10-30 P0–P6 authorization applies to the preceding redesign. Record actual evidence and remaining boundaries. Remote CI, Git or npm publication, global replacement and paid-model validation require separate authorization.
Keep private runtime data and local evidence out of commits. Do not modify the user's original workspace or global installation.

## 统一维护入口

唯一开发主线为私有仓库 `XSY-28/cothink-gui`，CLI 与 GUI 共用核心和根包版本。公开 `XSY-28/Cothink-release` 仅接收按固定源码版本生成的发行内容，不另行手工维护核心。原 CLI 工作目录保留历史和未提交成果，不写入迁移标记，也不继续作为开发入口。
