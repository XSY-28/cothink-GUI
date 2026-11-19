# CoThink

CoThink 是接入多种模型 API 的协作 Harness，基于固定 Pi 1.4.0。目前为预览版，既有发行支持 macOS 和 Windows x64／ARM64。版本验证见 [VALIDATION.md](VALIDATION.md)，问题可通过 [Issues](https://github.com/XSY-28/Cothink-release/issues) 反馈。

## 当前协作设计

每个项目 Team 可有多条对话，各自选择一主、至少一副的阵容。用户与担任经理的主模型交流。它独立处理简单任务，复杂任务按能力组织岗位，最后交付成果。岗位使用各自的会话、权限和获准技能。CoThink 负责调度，agent-sync 负责文件范围、版本、检查与接纳。层级、定时检查、会话接续等设计以 [当前设计基线](DESIGN_BASELINE.md) 为准。旧版行为和验收范围见 [VALIDATION.md](VALIDATION.md)。

开发工作树支持同一评审对同候选的显式撤回协议；须指明原拒绝请求与理由，普通通过意见不会覆盖旧反例。尚未安装。

开发工作树可在明确确认新失败回执和精确草稿后重新开启只读诊断；普通继续不会重置已消费的修复，原预算、检查和历史保留。尚未安装。

开发工作树会在工具调用被输出上限截断时明确停止，保留部分正文与实际用量，不自动执行或重试；尚未安装。

开发工作树另支持明确选择已停止员工的 partial 内容继续，仍需新经理验证接纳，不把未收取结果算作完成贡献；尚未安装。

开发工作树另减少已结算历史请求的重复解析；每次核对文件身份，未知请求与授权检查不缓存。仅完成本地免费验证，尚未安装。

开发工作树的独立只读审查另调整为简短准备、同会话正式分析；不省略候选验证，真实效率改善尚未验证。

开发工作树另有尚未安装的网络故障收尾修正：停止新模型请求，给已发送请求最多 120 秒保存回复与用量；用户取消或额度耗尽仍立即停止。仅本地免费验证，范围见 [验收记录](VALIDATION.md)。

## 本版新增（0.8.14-desktop.33）

- 点击箭头或语言名可展开代码，点击旁边的分栏图标可预览 HTML 或 SVG，双页图标可复制代码。宽窗口中，预览与对话以直线分栏，两侧标题栏对齐。窄窗口打开浮层阅读面板。预览可运行内嵌样式、脚本和动画；需要其他文件或外部资源的页面可能显示不全。点击预览右上角的 × 回到对话。悬停或用键盘聚焦图标可查看说明。

### 0.8.14-desktop.30

- 对话回复中的代码块默认折叠，可按块展开或复制。回复下方移除了开发测试用的“查看过程”按钮。

### 0.8.14-desktop.29

- 服务明确报告 API 额度耗尽时停止本轮，保留草稿与未知费用；额度恢复后须重新手动确认。
- 续作材料列出候选、检查与环境一致的成功观察，提示复用可选验证，不省略固定检查或独立审查。
- 恢复消息和脚本检查结果不重复携带未变源码；完整实际变更、执行证据与原存档保留，上下文上限不变。
- 在原回复读取、导出未验收草稿；已保存版本不依赖模型或 Docker。
- 模型连接中断且原执行已结清时，可明确授权从保存成果继续一次；未知请求和费用保留。
- 设置内核对模型能力；规划可发现已配置 HTTP MCP。各岗位只在实际调用时连接 MCP，并核对注册、参数和权限。

本版证据见 [VALIDATION.md](VALIDATION.md)。旧 CLI 保留 ONE／CoThink／PROJECT 及其历史规则。

## 本地桌面候选（统一项目会话）

桌面壳位于 `desktop/`，可在 macOS ARM64、Windows ARM64 或 Windows x64 上构建对应的本地候选。构建时传入 [runtime-manifest.json](desktop/runtime-manifest.json) 锁定的官方 Node 与 Electron 归档，脚本先核对 SHA-256，再组合与 `pack:npm` 相同的后台包。版本取自根 `package.json`；启动使用随包 Node。

```sh
npm run test:desktop
npm run pack:desktop -- --node-archive /path/to/node-v24.22.2-darwin-arm64.tar.gz --electron-archive /path/to/electron-v45.2.3-darwin-arm64.zip --out /path/to/new-candidate.noindex
```

macOS 测试候选必须位于 `.noindex` 目录，避免被 Spotlight 当作重复应用。正式安装仅保留 `/Applications/CoThink.app`；安装后注销测试副本的 Launch Services 登记，并核对系统搜索只出现正式版。旧候选可保留在隔离目录或压缩归档中。

需要随包离线 PROJECT 执行资源时，构建前设置 `COTHINK_PACK_PLUGIN_RUNTIME` 指向已有核验的运行端目录，沿用原打包校验。构建后使用 `COTHINK_DESKTOP_APP=/absolute/CoThink.app npm run test:desktop-app` 验证真实桌面生命周期；缺少候选路径时明确失败，不跳过。输出 `CoThink-darwin-arm64/CoThink.app` 和 `desktop-build.json`；App 内 `distribution.json` 记录实际资源摘要。双击 App 使用随包 Node，并补充常见 Docker 命令路径。数据仍取 `COTHINK_HOME`，未设置时为 `~/.cothink`；独立测试请先指定临时数据根。文件项目需 Git、本机 Docker 和固定镜像，提交及确认时检查。依赖提前准备，执行断网；失败保留草稿，不回退宿主，选目录不扩大权限。

macOS 关闭窗口会先保存全部已编辑会话的草稿，再隐藏；从 Dock 返回同一宿主。菜单“退出 CoThink”先冻结新操作、保存草稿并停止所属任务，只有停止与保存均确认后才退出。失败时保留窗口和只读查询，不强杀来冒充完成。页面或宿主崩溃只保证已经保存的内容，不自动重发任务；重新打开页面前会说明未保存输入的风险。

Windows 在 PowerShell 中使用与目标架构匹配的 Node 构建。以下示例假定两个官方 ZIP 都在当前目录。

```powershell
$arch = node.exe -p process.arch
npm.cmd ci --ignore-scripts
npm.cmd run pack:desktop -- --node-archive "node-v24.22.2-win-$arch.zip" --electron-archive "electron-v45.2.3-win32-$arch.zip" --out dist/desktop
& "dist/desktop/CoThink-win32-$arch/CoThink.exe"
```

需要离线构建时，可用 npm 的 `npm_config_cache` 和 `npm_config_offline` 指向预先准备的依赖缓存。

移动或解压 Windows 候选时保留整个 `CoThink-win32-<架构>` 文件夹。关闭窗口会保存草稿并退出，重开时沿用原数据根。独立验收可先设置 `$env:COTHINK_HOME` 指向一个新的测试目录。

桌面设置显示本地版本和更新记录，关于窗口显示完整构建标识。候选的签名状态、平台及实际验收范围见 [VALIDATION.md](VALIDATION.md)。

## 本地浏览器界面

运行已安装的 `cothink gui` 会打开对应发行版的界面。下面的首次引导目前可在本工作树构建的界面使用。

首次打开空首页，点「创建我的第一个 Team」，为项目选一个文件夹。接着选择已有阵容，或配置一个主模型和至少一个副模型。两个不同型号来自同一家服务商时，可以共用一把 API Key。点「开始对话」会把阵容用于当前对话，并设为该 Team 新对话的默认值。输入框保留之前的草稿，等你点击「发送」才会发出模型请求。退出引导后，可在对话输入框旁点「选择阵容」继续。改用 OAuth 或自定义服务商时，打开「设置 → 模型与认证」。[首次引导设计与验收范围](docs/gui/FIRST_RUN_ONBOARDING_DESIGN.md)

创建 Team 时填写名称并选择文件夹。桌面使用系统选择器，浏览器也可新建文件夹。Team 创建后会打开第一条对话。再点“新对话”，程序会在同一 Team 文件夹内创建另一个子目录。旧对话、草稿和历史授权保持原位。

左栏只列 Team；顶部显示当前 Team 和对话标题。“对话”列表显示活动时间、摘要和状态，便于区分同名历史。全局搜索可查 Team、未分组历史及跨 Team 成果文件，打开文件命中会定位原任务及其保存版本。勾选“包含归档”可只读查看归档结果，也可在设置的“已归档”里恢复。

左栏宽 88 像素，Team 头像为 44 像素。左下自上而下是“新建”“搜索”“设置”三个图标。鼠标停留 2 秒显示 Team 名，移出后收起。全局搜索的同名结果带目录提示。

提供本地头像素材时，Team 默认使用巴巴祖，左栏悬停会播放动作，回复显示圆形静态头像。启用系统“减少动态”时，左栏头像保持静止。源码检出后可直接使用内置占位头像，见[本地素材目录](docs/gui/TEAM_AVATAR_IMPLEMENTATION_PLAN.md#2-素材和角色选择)。

顶部“阵容”可按组合名、模型或服务商搜索。点选一行只切换当前对话的后续提交；行菜单可单独设为 Team 的新对话默认、调整另存或删除。修改阵容要另存新名字，不能删除当前阵容或最后一个组合。其他旧对话继续使用各自快照。

发送按钮左侧的“思考”菜单与模型参数编辑器都只有 `low`、`high`、`max`，缺省为 `high`。会话选择在提交时覆盖本轮主模型、各层员工、过程检查、成果审查和经理汇总的模型参数；运行中改档只影响下一条新任务。旧偏好的 `off/minimal/low` 归为 `low`，`medium/high` 归为 `high`，`xhigh/max` 归为 `max`，缺省归为 `high`；旧主模型专属偏好也作为后续新任务的统一档。只读设置不回写历史，损坏值按错误处理。选档保存期间等待确认再发送；结果未知时读取已保存设置，不自动重发。已有任务和已冻结文件提议继续使用原快照。

完整 JSON 围栏本地处理；完整但不合规的过程报告最多追加一次带反馈的纠错。服务错误、截断、未知、取消和保存失败不重发。协作或交付缺口最多给经理一次补做提示，派工及续答计原预算。仍须确认和验收，未补齐就保留受阻或部分完成。

回到左侧工作会打开上次查看的对话并恢复宿主保存的阅读位置。“查看新结果”会跳到对应回复；后台更新保留当前阅读位置。成果文件和执行记录按需打开阅读面板。

回复头显示本轮根任务的真实用时。进行中、失败和停止等状态也会单独显示。用时包含思考、工具、评审和工作等待，并行子任务的时间不累加。准备、执行和取消清理期间继续计时，确认停止后采用取消结清时间。停止未确认或旧记录缺少可信时间时明确显示未知，刷新和切换不会重新计时。回复下方的复制原文和从这里分支使用图标，悬停或用键盘聚焦时显示说明。

关闭顶部更新提示后，可以在“设置 → 偏好与更新 → 查看本地更新记录”重新打开。输入区随草稿增长，到上限后在内部滚动。中文组词期间 Enter 不发送。

CLI／GUI 共用核心与已有历史、Team 和认证，GUI 的新提交使用统一 flow，旧历史不改写。已安装发行包可运行 `cothink gui`（或 `ct gui`）打开该版本的界面。这里的项目 Team 界面可通过当前源码或下方独立候选安装使用。通过源码运行时，在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run build:skills
npm run build:gui
npm run gui -- --no-open
```

打开命令输出的本机启动链接。链接中的 fragment 是本次宿主的临时凭据，请勿分享；页面读取后会清除地址中的凭据。默认仅监听 `127.0.0.1` 的随机端口。省略 `--no-open` 可自动打开浏览器，`--port 4317` 可指定端口。

输入区没有模式选择或 Option/Alt+M 切换。直接描述问题即可。简单任务由主模型处理，读取材料后可能继续请求同一主模型，均按真实请求计账。旧 `/one`、`/cothink`、`/project` GUI 命令明确拒绝。

草稿可编辑时，点击对话标题或“首页草稿”，从“对话操作 → 下一条消息的限制”设置只读、禁止派工、请求上限或单次中断接续授权。请求上限默认留空。已设限制显示在输入框上。源码 GUI 移除了普通对话的强制评审选项。含旧选项的草稿先确认采用新规则再发送，历史回复和已有工作提议照原记录保留。

“禁止派工”允许主模型独立完成已授权工作。旧稿的禁止派工限制在迁移后继续生效，可从消息限制明确修改。手动“整理上下文”需要实际模型请求，沿用草稿中的次数上限，保留草稿和原历史。硬费用上限没有可执行的单次支出证明时拒绝发送，目录估价不是账单。

输入框的“+”可添加文件或图片、选择项目文件和使用技能。选择文件、拖放文件与粘贴图片都可导入；支持 UTF-8 文本／代码、PNG、JPEG、静态 WebP。文本每份最多 512 KiB，图片每份最多 4 MiB 且不超过 2500 万像素；每条最多 8 份、原始字节合计最多 16 MiB。PDF、Office、音视频与 OCR 暂不支持。材料就绪后可仅发送材料；上传中或有失败项时，先查询／重试或移除。模型需支持图片；超过上下文或不支持的输入会明确报错。正文中的受权本地图片可直接显示，HTTPS 外链图由用户点击后加载。

“选择项目文件”有两种方式：导入当前磁盘文件的副本，可逐项预览，含未提交内容，按附件限额导入；或选择固定的已保存版本及文件／子目录范围，只授予本条在该版本中的读取权。后者不包含未提交内容；两种方式都不授予写入、Shell 或额外插件权限。没有关联目录时可从入口先关联。

“使用技能”将当前可选技能加入本次草稿；设置的“技能”可查看来源、用途与可用状态，也可添加本机技能目录或 SKILL.md 的绝对路径。选择技能不会授予脚本权限。

桌面 App 的消息、回复和代码块复制按钮将原文写入系统剪贴板，写入完成后提示成功。浏览器版使用浏览器的剪贴板权限。

直接描述任务。对话子目录的 Git 起点在有效文件计划需要时准备。普通聊天和被拒的无效计划无需初始化 Git。文件制作请求中的“不允许联网”默认约束执行和成品，模型仍使用所选阵容；明确要求整轮离线且无法保证时，会在模型调用前提示。

将鼠标移到自己发出的文字消息上，或用键盘聚焦消息下方的复制按钮，可复制原文。回答期间显示简短状态和停止按钮。停止结果未知时，先核对同一任务再决定是否继续停止。

文件工作沿用正式 PROJECT 的范围、检查和验收。主模型提出计划后可确认执行，原始目录权限和读取范围保持原授权。明确需要文件的请求如果只得到代码或计划被拒，回复会显示未交付及可查的原因。新对话的已验收成果放入对应子目录。如果本地内容冲突，保留你的修改，成果仍可从这轮的文件列表取出。需要执行命令或检查时仍使用配置的隔离环境。

统一宿主从未加载第三方原生扩展的入口开始；已安装插件的文件工作通过原受管 PROJECT 运行端。任意宿主插件命令及原生 TUI 请在旧 CLI 会话使用，不能在已加载插件的旧 GUI 进程里热切换为统一执行。前后端协议不匹配时保留草稿并要求重新打开。统一发送目前复用已具备实际 HTTP 准入的 OpenAI completions/responses、Codex SSE、Anthropic、Azure responses、Mistral 和 pi-messages 适配器；其他传输（包括未适配的 Google 路径）明确拒绝，不退回未受控发送。必需异型号评审还要能从直连来源与服务商响应核实身份，无法核实的代理别名保留为未完成。

从源码生成的安装包也可安装到独立目录，不替换原有全局命令：

```sh
npm run pack:npm -- dist
npm install --prefix ./gui-preview --ignore-scripts ./dist/cothink-v2-0.8.13-project.1.tgz
node ./gui-preview/node_modules/cothink-v2/bin/cothink.js gui --no-open
```

`pack:npm` 每次先重新构建内置技能 checker 和 GUI，输出精确包名、版本和摘要；使用本次输出的归档，避免同版本旧包混淆。包内包含静态页面、公式字体、界面源文件与第三方声明。源码构建需要开发依赖，checker 构建在临时目录按随包 shrinkwrap 准备依赖；安装后不需要 Vite、网络 CDN 或运行时 npm 安装。本地打包和独立目录安装不会发布 npm，也不会替换已有全局命令。

源码主线还包含题意保真修复：成员先独立阅读原题，再接收分工与建议；题意冲突会暂停并保留草稿。HTML/SVG 最终截图由同一主模型在独立上下文中审查，界面分别显示版本接纳、图像请求和符合／不符合／不确定判断。首次委派通常至少增加一次准备调用；旧 CLI 普通问答仍为 ONE 一次、CoThink 三次。源码与安装包以固定提交和摘要标识。

在设置“模型与认证”保存 API key 或配置自定义服务商；对支持交互 OAuth 的服务商可点“使用 OAuth 登录”，在浏览器授权，按提示完成回调。已有 OAuth 和环境认证可复用；配置保存不发送试探模型请求，也不代表远端权限已核实。从顶部“阵容”创建具名组合。已有组合的副模型后来不可用时会显示原因，主模型仍可处理自己能完成的任务。新组合和新设的 Team 默认要求核验各席位。GUI 和 CLI 共用 COTHINK_HOME，同一会话不能同时写入；同一新版 CLI 可查看统一 GUI 历史，继续写入请回 GUI。直接运行 CLI 的项目命令也不能绕过已绑定的统一会话预算。

“模型与认证”中的“核对模型能力”只向所选已配置地址读取元数据，不生成回复、不自动导入其他模型，也不跟随重定向。表单对照本地值、来源与服务端报告的上下文、输出容量和输入类型；勾选字段后用原保存入口应用，无须重填密钥。元数据读取限10秒、1MiB，退出会取消正在核对的请求；缺字段或查询失败保持本地值。旧无来源值标为未核实；SDK 默认不代表服务商上限。能力更新不改变已确认任务的有效能力、思考档位或实际输出额度，仅影响后续任务。

旧安装不识别新标记，不能用于写入 unified 会话或项目。实测旧二进制会继续该分支，并会修改带 `entryPolicy:"unified"` 的项目目标或暂停状态；这是明确不支持的组合，不是已被阻断的操作。本轮没有替换全局 CLI。

普通对话不隐式授权启动目录。明确授权并确认计划后通过现有 Pi 与 agent-sync 读取、修改、检查和接纳；原目录不会自动写回。非空检查和 Shell 必须配置固定镜像摘要的 Docker 环境，不回退宿主 Shell。设置中的 work 为共享配置，对后续任务生效；旧 CLI 空检查策略显示“未验证”，统一正式计划必须提供非空检查。回复的文件入口列出已核验交付物。可读固定版本的文本、代码、Markdown 和图片，也可下载原文件或打开已核对的成果目录。“变更与检查”提供逐文件差异和完整补丁。删除文件只显示差异，二进制按原格式处理。项目部分完成时，已独立接纳的固定文件仍可打开。HTML/SVG 内嵌预览仅运行隔离的静态子集，其他页面可看已保存截图或下载原文件。文本预览上限 1 MiB，图片／静态资源合计 8 MiB，原始下载 32 MiB；缺少可信成果目录或文件身份不符时拒绝读取。

未接纳的固定版本另标“未验收草稿”，显示来源和版本，不能据此声称检查或正式交付通过。可在原回复文件区查看、下载或导出；导出在任务 artifacts 下新建目录，保留授权范围内文件，缺项单独列出，不覆盖原目录或旧导出。模型不可用、Docker 关闭或其他子任务失败时，可读草稿仍可取得。静态预览及文件大小、链接限制与正式文件相同。

仅模型响应丢失时，可在原回复点击“从保存成果继续”，先核对草稿、原阵容和剩余额度再确认。主模型草稿与已明确收取的员工草稿沿用同一固定版本核验；多份草稿须明确选择，不自动合并。宿主验证本地执行与相关副作用已结清，只恢复确切变化路径；同一恢复副本可通过原范围刷新入口取回已确认阶段的写范围，阶段外仍拒绝。正式版本发生重叠变化时阻塞并列出冲突。当前阶段已经正式接纳的共用文件更新，可凭该阶段的接纳链成为继续输入；前置原回执仍须核对，无证明的变化仍拒绝。旧请求仍为未知，新尝试重新检查、接纳；重复点击和重新打开只核对同一回执。仅剩经理终稿时沿用已核验成果，不重新生成文件。旧隔离副本已公开核实接纳并停止时，旧本地编辑／执行回执仍保持未知，可从已确认版本继续；未知接纳、导入或外部作用不适用。旧记录不能核实来源或停止时仍阻塞，但草稿读取独立判断。 已明确继续的任务后来因已知错误结束时，可再次手动继续，宿主会核对整条确认链并保留原未知许可；没有这条授权链的普通已知失败不因此获得例外。已保存的路线暂停仍须先通过原裁决或约定实验，不能直接放开写入；每次继续沿用剩余额度，不自动续签。

若中断前只有只读调查，且保存输入与当前正式版本一致，确认框显示“已保存输入版本”，仅允许手动继续。它不代表产生了新成果；未收取的可写草稿仍须先处理。已完成阶段可按原交接证据释放范围，确认继续的授权沿已批准依赖后继使用；活动与未决工作仍保持冲突保护。只读调查缺少声明交付文件时报告尚未交付，不冒充候选验收；真实候选仍执行全部原检查。

已完成判断、尚未派发修复写入且证据完整时，可手动沿原判断继续；确认框列出剩余一次修复及允许路径。已使用的编辑、反馈或未决作用不能借此重置。恢复副本在第一条模型请求前通过原公开刷新接口确保修复所需的原范围已可写，核对候选未变；获批修复路径尚未登记时复用原工作登记检查，活动冲突及冻结审查/效果仍阻止登记。仍须通过原固定检查及接纳。尚未写入时不能执行修复验收，重复检查旧候选不会冒充已用过一次编辑。

需要无人值守时，在发送前的“下一条消息的限制”明确勾选“模型连接中断后，允许从保存成果继续一次”。它不增加总调用额度，不允许重放原请求；再次中断、主动取消、未决外部写入或无法核实硬费用边界时不自动继续。普通追问、历史浏览和“不要提问”等文字不会开启此授权。

规划的 get_capabilities 默认列出已配置 MCP 服务摘要；指定 mcpServer 仅发现 HTTP 服务工具，不执行业务调用，命令型服务仍需正式隔离运行。发现不授予 plan.mcp 以外的服务、参数或效果权限。泛指“组队”可由经理加一个有用员工完成；明确人数、并行和独立审查要求仍执行原约定，只读岗位不能试玩或运行命令。

“项目执行”可核对本机 Docker 与固定镜像，并设置普通请求的并发上限，默认 2。新计划明确列出各步骤依赖后，已就绪且范围独立的步骤可并行开工。旧计划仍按原顺序。组队后定时检查，交付时核对协作承诺。“检查执行环境”启动并清理最小容器，不自动拉取镜像。配置改动后需重新检查，探针结果不替代实际项目检查。已完成回复下方的“从这里分支”保留截至该轮的上下文、阵容和项目，来源草稿仍留在原对话；旧格式、缺失或不可信的父历史会阻止依赖它的操作。

新对话须归属一个 Team。首页草稿可转入明确选择的 Team，保留正文、已就绪材料、技能和消息限制。材料仍归原记录，项目读取授权需在目标目录重新选择。创建回执丢失时核对原会话，恢复不自动发送。

目录失效时仍可聊天，不能使用该目录的项目资源。新对话可用目标 Team 的有效默认阵容。未设置默认时，近期和来源阵容仅作为提示，发送前须明确选择。旧未分组会话可阅读和复制，继续工作时在 Team 内创建对话。创建和选择不产生模型请求。

文本、材料、技能选择、本条限制和读取选择作为同一份草稿保存。出现保存冲突时，可读取保存稿或明确以本机稿再保存；任务提交确认丢失时按原标识查询，界面不会自动重发。旧 HTTP 界面仍可读取历史，写入需要新版。升级前关闭旧 CLI 和 GUI；新版 CLI 对统一 GUI 会话只提供历史查询。CLI 空会话仍在首次消息后落盘。

对话或所属项目 Team 归档后，仍可查看历史、草稿和成果；继续发送、编辑或从回复创建分支前，先恢复对应归档。归档只约束 GUI 的后续操作。

关闭页面不会取消任务；刷新仅重新观察已有任务。停止按钮取消整条任务，保留已保存内容。宿主退出会执行取消；崩溃不会自动续跑，原未知请求不会重发。仅上述明确的一次预授权可在当前宿主结清后开始新尝试。历史 Team、参与者和费用来自已有记录，缺失内容保持未知。

本地模型机制检查使用 localhost fixture 和实际 Docker，不能据此判断真实模型答案质量或物理中文输入法、人工剪贴板体验；跨平台 CI 与实机证据分别记录。具体证据及限制见 [VALIDATION.md](VALIDATION.md)。

## 安装与启动

从 `0.8.11-ct.1` 起，安装包提供短命令 `ct`。输入 `ct` 开始新会话，`ct -r` 选择历史会话，`ct -c` 继续当前目录最近的会话。`ct` 与 `cothink` 使用同一入口，所有参数通用。Windows PowerShell 可用 `ct.cmd`，使用支持此简写的 ZIP 时，从解压目录运行 `.\ct.cmd`。

安装或更新 npm `latest`：

```sh
npm install -g cothink-v2@latest
cothink --version
```

也可指定 `npm install -g cothink-v2@0.8.12-gui.1`。已有历史安装包可在 [GitHub 发行页](https://github.com/XSY-28/Cothink-release/releases)查找。

Windows PowerShell 使用 `npm.cmd` 和 `cothink.cmd`；本轮未提供新的 Windows ZIP，旧 ZIP 保留在历史发行页。原配置、Team、认证和历史继续保留；退出旧进程后重新启动。

需要 Node.js ≥22.19、npm 和 Git；项目代码搜索还需要 ripgrep（`rg`）。

该安装包同时包含 CLI 与本地浏览器 GUI。安装后运行 `cothink` 进入终端，运行 `cothink gui` 打开浏览器界面。Windows Terminal + PowerShell 的命令见下方[安装说明](#windows-通过-npm-安装)。

安装 npm 渠道版本：

```sh
npm install -g cothink-v2
```

安装后运行 `cothink`。首次启动会引导你选择主副模型、为 Team 命名并配置认证；已有认证会继续复用。也可以运行 `cothink init` 单独完成设置，或用 `cothink --version` 检查版本。

更新 npm 渠道版本使用同一条命令：

```sh
npm install -g cothink-v2@latest
```

如果全局安装提示权限不足，可安装到自己的目录，并将其加入 PATH：

```sh
npm install -g --prefix "$HOME/.local" cothink-v2
export PATH="$HOME/.local/bin:$PATH"
```

将上面的 `export` 加入 `~/.zshrc`，新终端也会使用该路径。更新前建议保留 `~/.cothink` 的备份；已经打开的旧进程需要退出重开。

### 维护与公开发行入口

此前版本 `0.7.0-auth.2` 包括添加模型时的内联认证（明确复用哪个服务商的认证，缺少 API key 时当场隐藏输入）、终端启动标识，以及 Team/模型长列表的滚动与缩放修复。GitHub 上的 `0.6.0-windows.1` ZIP 继续保留。

唯一开发主线位于私有仓库 [XSY-28/cothink-gui-workspace](https://github.com/XSY-28/cothink-gui-workspace)，CLI 与 GUI 共用同一核心和根包版本。公开仓库 [XSY-28/Cothink-release](https://github.com/XSY-28/Cothink-release) 只承接按固定版本生成的发行内容，不另行手工维护核心源码。原 CLI 工作目录保留为历史和未提交成果，不作为继续开发入口。

`0.8.1-pi.1` 保留长回复诊断和 Windows 请求记录原子保存修复，并更新到 Pi 1.4.0。公开仓库保留历史发行源码；安装当前版本请使用 npm 或 [GitHub Releases](https://github.com/XSY-28/Cothink-release/releases)，不要把历史源码快照当作当前开发主线。历史验收按版本保存在 VALIDATION.md。

维护者发布 npm 使用 [npm-publish.yml](.github/workflows/npm-publish.yml) 的 GitHub Actions OIDC 可信发布，无需保存 npm 发布 Token。工作流仅接受私有主线的 `main`，复用全部 CLI／GUI、Docker 与 Windows 检查，再发布已经安装验证的同一个 tarball，并核对 registry integrity 与所选频道。默认只演练，不改变 npm。

每次正式发布前，先将新版本、README、CHANGELOG 与 VALIDATION 合入 `main`；`version` 必须等于该次源码的根版本，且尚未发布。Agent 可直接触发：

```sh
gh workflow run npm-publish.yml --repo XSY-28/cothink-gui-workspace --ref main \
  -f version=待发布的完整版本 -f dist-tag=latest -F publish=true
```

省略 `-F publish=true` 为演练；预览频道可用 `-f dist-tag=next`。触发后须检查 Actions 的最终结果；正式发布还须确认 npm 的版本、频道和完整性，不能把已触发或 dry-run 当成发布成功。

上述命令仅为未来公开发行流程，本次未触发；当前私有仓库 Actions 关闭，npm trusted publisher 是否已迁到新仓库尚未核验。实际公开发行前，npm 的包设置须绑定正确的源仓库与 `npm-publish.yml`，允许 `npm publish`；仅允许 stage 时仍需要人工审批。使用 GitHub 托管运行器，Node 24.19.0／npm ≥11.5.1。新连接首次成功发布前有 2 天有效期；过期需重新配置。私有源码不生成 npm provenance，不为此公开源码。账户付款或 Actions 支出限额阻止任务启动时，必须由账户持有人处理；本地检查不替代远端首次发布。[npm 配置要求](https://docs.npmjs.com/trusted-publishers/)

旧 CLI 首次设置选择一个主模型、至少一个有序副模型，并为 team 命名。通过 `/team` 复用、创建、调整和删除组合，已有服务商认证继续复用。API Key 隐藏输入，由 Pi 保存到 CoThink 数据根的 `pi/auth.json`；角色配置只保存模型引用。内置服务商不需要手填地址和协议。配置过程不发送生成请求；OAuth 登录可能需要浏览器操作。

旧版只配置主模型的配置仍可在一次性入口通过 `/one` 使用；建立具名 team 时需要至少一个副模型。普通讨论缺少评审时会在首次请求前拒绝。

## 动态 HTML／SVG 盲选测试

源码仓库附带 `scripts/visual-bench.mjs`：同题使用同一条简短提示词，三题九个任务独立并发，离线执行，最后在浏览器匿名选择动态作品。重复轮次、预算、隔离与使用命令见 [测试脚本说明](docs/VISUAL_BENCH.md)。该工具按需调用真实模型；准备和查看不产生模型请求。

## 项目工作如何分工

本节记录旧 CLI 普通工作入口的现有策略和限制。当前设计的项目岗位及同型号多岗位规则见 [当前设计基线](DESIGN_BASELINE.md)。

主副模型须忠实保留原题的主体、动作、对象和关系方向；委派解释与原题冲突时以原题为准，验收先检查题意，再处理视觉和实现细节。未指定思考档位时，支持思考的模型默认使用 `high`，显式选择优先。

主模型在实现前比较自己与当前合法副模型，说明执行者选择及理由。前端默认 Opus 5.5 优先于 Kimi K3.1 Pro，两者都比 DeepSeek 更优先；其他领域参考 GPT-6 Astra、GPT-6.1 Sol、DeepSeek 与 Kimi 的具体任务偏好。默认顺序指向副模型时实际委派；选择自己或偏离默认需说明具体依据。这些是可修订的调度偏好，尚未验证为通用能力排名，也不会自动添加未配置的模型。副模型独立核实方案，按每次请求附带的当前实际权限、固定检查与执行环境完成工作，交接文件、接口、实际检查和未完成项。

工作运行时禁止委派给主模型本身及已知同模型别名；同一模型尚有未处理或结果未知的成员工作时，不能另建分身或通过改派绕过。可收集成果、给出具体反馈，在安全收尾后继续顺序工作。`/one` 由主模型担任唯一 Team 负责人，不调用正式评审或副模型。

成员实际执行、主模型收集整合、检查与接纳都沿用同一 Pi 和 agent-sync 路径。配置了副模型不代表本次已经调用它；请以实际成员记录与成果为准。当前验证证明运行机制，不证明这些分工建议已经带来稳定的 coding 提升。

## 使用 Kimi K3.1 Pro

在终端 `/models` 或 GUI 的模型设置中，选择 Moonshot AI CN（国内）或 Moonshot AI（国际），再选择 `Kimi K3.1 Pro`（ID `kimi-k3.1-pro`）。已有官方 Moonshot API 地址的导入配置也会显示该模型，并复用同一服务商的认证；选择新模型后按原规则另存为新 Team，旧组合不改写。

模型支持 `low`、`high`、`max` 三档，GUI 按原值显示。它始终思考；CoThink 会保留并回传完整 `reasoning_content`，包括多轮工具调用。没有显式设置时仍不发送本地输出 cap；模型服务本身的默认输出限制继续存在。输入上下文与最大输出能力按官方声明登记为 1,048,576 tokens，不表示可以同时占满输入和输出。

本轮接入官方开放平台的标准 Pro，API 根地址为 `https://api.moonshot.cn/v1` 或 `https://api.moonshot.ai/v1`。代理地址、手工定义的同名模型与不同协议配置保留自己的声明，不自动改写。官方 API 账号需满足充值解锁条件，网页会员或赠送代金券不代表此模型的 API 权限。参见 [官方接口与限制](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart)。

新模型的目录价格尚未可靠固定时，任务费用显示未知，不能按免费或实际账单理解；token 用量与已收到内容照常保存。测试范围及真实调用证据见 VALIDATION.md。

## Windows 通过 npm 安装

安装 Node.js ≥22.19 与 Git for Windows。在 Windows Terminal 的 PowerShell 中运行：

```powershell
npm.cmd install -g cothink-v2
cothink.cmd
```

使用 `.cmd` 入口可以避免 PowerShell 对 `.ps1` 脚本的执行策略限制，无需修改系统执行策略。首次启动会引导设置 Team 和认证；也可先运行 `cothink.cmd init`。更新使用 `npm.cmd install -g cothink-v2@latest`，升级后退出旧窗口并重开。

npm 下载同一个跨平台包，按当前系统准备本地依赖。全局命令应来自当前 npm prefix；可用 `Get-Command cothink.cmd` 检查。数据仍在 `$HOME\.cothink`，安装和升级不删除配置、认证或历史。需要离线包时仍可使用下方 ZIP。

## Windows 下载与启动

到 [v0.7.1-windows.1 发行页面](https://github.com/XSY-28/Cothink-release/releases/tag/v0.7.1-windows.1) 下载与你的系统匹配的 `windows-x64.zip` 或 `windows-arm64.zip`（完整文件名包含版本），并用同页 SHA256SUMS 核对。不要选 GitHub 自动生成的 Source code 压缩包，它不包含离线依赖和启动脚本。

先安装 Node.js ≥22.19 和 Git for Windows。将 ZIP 完整解压，在 Windows Terminal 的 PowerShell 中进入该文件夹：

```powershell
.\install.cmd
.\cothink.cmd init
.\cothink.cmd
```

安装通过 Windows tar.exe 展开随包锁定依赖，不调用 npm、不执行安装生命周期脚本、不联网，也不改 PowerShell 执行策略。所有程序文件在解压目录中，支持中文与空格路径。已有配置和历史继续使用 `$HOME\.cothink`；可用 `$env:COTHINK_HOME = 'D:\CoThink 数据'` 指定其他目录。升级时解压新版本，先退出旧程序，再运行新目录的安装与启动脚本，不删除数据目录。

从实际项目目录启动时，用 `& 'D:\CoThink\cothink.cmd'`，当前项目目录保持不变。Enter 发送，Ctrl+J 换行，Ctrl+Shift+V 粘贴；Shift+Enter 由 Pi 原生 Windows 键盘识别，终端无法区分时请用 Ctrl+J。应用内选区松开后顺序写入 Windows 原生剪贴板，写入完成后才提示成功。

Windows PowerShell 5.1 的中文管道请明确 UTF-8：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 .\question.txt | & 'D:\CoThink\cothink.cmd'
```

GitHub Actions 验证范围及实际结果见 [VALIDATION.md](VALIDATION.md)。Windows 原生组件与自动化控制台检查不代替中文输入法、实体键盘和各款终端的现场体验。Windows 用户目录的权限依靠 ACL；POSIX 0600/0700 不等同于 Windows ACL。Git 执行位由已有版本保留，新 Windows 文件默认非可执行；Windows 文件系统上的 chmod 不作为执行位变更接纳。Shell 仍在 Linux Docker 中运行，宿主 PowerShell 不获模型执行权限；Windows Docker 环境尚未现场验收。

## 提问、取消与历史

```sh
cothink ask "问题"
cothink ask --one "只用主模型回答"
cothink ask --json "问题"
cat question.txt | cothink > answer.md
cothink history
cothink show <任务ID> --all
```

交互、参数、管道、print 和 JSON 共用完成判断。默认显示完整最终稿；`--all`、`/chat` 与 Ctrl+O 展开初稿、评审、成员、工具原文和状态。明确标题下的评审处理说明默认收起，原始记录和后续模型上下文保留全文；标题无法识别时保留全文。partial、failed、cancelled、unknown 不成功退出，也不展示为最终交付。

长回答显示 `partial` 时，先查看错误中的阶段、模型和停止原因。服务返回 `length` 表示达到输出额度或上下文限制；未指定本地额度时，服务商的默认额度仍可能生效。`--json` 只导出已收到的完整记录，不改变模型额度。需要更长输出时，请检查模型设置中的输出额度；CLI 可按服务商支持范围显式设置，例如 `cothink ask --json --max-output-tokens 32768 "问题"`；该值须符合各参与模型的输出及上下文限制。已接收内容可通过 `cothink show <任务ID> --all` 查看，程序不会自动续写或重试。

若错误为请求记录 `.tmp` 替换 `.json` 时的 `EPERM`，说明保存操作被 Windows 拒绝，并非服务端返回 `length`。本版对临时占用做有限等待后重试同一文件替换；持续权限问题仍会报错，旧记录保留。请保留错误信息排查占用者或目录权限，不必先修改输出 token 额度。

| 命令或按键 | 行为 |
| --- | --- |
| `/project` | 终端进入 PROJECT 项目模式，下一条可直接输入项目目标 |
| Option+M（Alt+M） | 终端依次切换 CoThink → ONE → PROJECT → CoThink，保留草稿；运行中只影响下一条 |
| `/one` | 当前对话持续切换为 ONE 单模型模式 |
| `/cothink` | 当前对话切回 CoThink 讨论模式 |
| `/one <任务>` | 仅本条使用主模型，下一条沿用当前对话模式 |
| `/team` | 选择、新建、调整或删除具名模型组合 |
| `/models` | 编辑当前阵容，增加、移除、换主或重排后另起名字保存；原组合保留 |
| `/login`、`/logout` | Pi 认证，使用 CoThink 独立数据根 |
| `/thinking` | 当前模型实际支持的思考档位 |
| `/chat`、Ctrl+O | 零生成调用查看详情；Esc 返回原草稿 |
| `/changelog` | 离线查看 CoThink 完整更新记录；升级后首次启动显示摘要，同一版本不重复 |
| Esc、Ctrl+C | 取消当前整条任务，包括成员和受管工具进程 |
| `/new`、`/resume`、`/fork`、`/tree`、`/reload` | Pi 会话操作；运行中拒绝切换，不自动重发未知请求 |
| Enter | 发送完整输入 |
| Shift+Return、Ctrl+J | 换行；支持扩展编码及 macOS Terminal 的 Escape+Return 编码 |

macOS Terminal 使用此快捷键时，需在“设置 → 描述文件 → 键盘”开启“将 Option 键用作 Meta 键”；新 GUI 不再提供模式快捷键。未开启时终端可能输入 `µ`，程序不会把这个普通字符或粘贴内容当作切换命令。

终端输入框下方持续显示 `ONE · 单模型`、`COTHINK · 讨论` 或 `PROJECT · 项目`；预算按实际任务更新，临时 `/one <任务>` 完成后回到当前对话模式。模式切换不改变上下文和 Team。恢复、clone、fork、tree 和 reload 按所选历史保留模式，新对话及未记录模式的旧对话默认 CoThink。空会话的选择在首次发送消息后随对话落盘。运行中切换只影响下一条，当前任务的模式与预算已固定。

单模型纯答一次，讨论纯答三次；工作都可能多次调用，ONE 由主模型担任唯一 Team 负责人，不调用正式评审或副模型；CoThink 工作可按需委派正式成员。

### 终端提醒

macOS 自带“终端”的全屏会话会在本轮任务完成、出错停止或运行中等待输入/确认时发送一次原生提醒。主动取消、中间模型/工具输出、查看历史和打开设置不触发；一次性 `ask`、JSON 和管道输出不发送提醒。当前仅识别 macOS 的 `TERM_PROGRAM=Apple_Terminal`。

在“终端 → 设置 → 描述文件 → 当前使用的描述文件 → 高级”中开启“标记 App 和窗口程序坞图标”。如只需要角标，可关闭可听报警声、可见报警声和图标弹跳。后台判断、数字及清除由终端管理；数字表示收到提醒的后台终端会话数，也可能包含其他程序，不是 CoThink 未读消息条数。见 [Apple 设置说明](https://support.apple.com/zh-cn/guide/terminal/trmladvn/mac)。CoThink 不自动修改终端设置；本版有 macOS 用户现场反馈，其他系统及终端不承诺显示该角标。

新对话 `/new` 继承当前 team；全新进程采用最近一次选择或提交任务时使用的已保存 team。恢复、分支和导入使用各自会话的阵容快照。同一个 team 不共享聊天历史。`/thinking` 调整会话参数，无需给阵容重新命名。

修改阵容后在编辑器选择「保存为新 team」，输入新名字；取消保留原组合。原生模型切换快捷键也使用这个流程。删除前确认名称与阵容，不能删除当前对话选择的 team，且至少保留一个（允许2→1、禁止1→0）。删除不删除模型、认证或历史；旧对话保留独立快照，已删除的组合不会自动回到列表。

Team、模型和服务商菜单的长列表随选中项滚动。用 ↑/↓ 或鼠标滚轮移动，PageUp/PageDown 翻页，Home/End 跳到首尾，Enter 确认，Esc 取消；窗口缩放保留选中项。名称过长时仅缩略显示，选择仍对应完整模型或 team。

终端启动页使用细线 C 和冷蓝方点标识，上横与方点右边缘对齐。至少 80×24 时显示完整标识，较小窗口使用紧凑标题；设置 `NO_COLOR` 时保持单色。

已有 Pi v2 配置首次进入交互界面时，会要求为原阵容命名，升级前备份原字节，保留模型顺序、参数及全局工作/技能配置；取消不会发送问题。无终端的旧 `ask`/管道可暂时沿用原阵容，稍后通过 `cothink init` 升级。旧会话未记录完整 team 时仍可浏览，继续前需明确选择一个 team。

切换主模型时，原主模型会回到副模型列表：选择已有副模型则交换两者的位置；选择名单外的新模型则把原主模型放到副模型第一位。模型已有设置和其他副模型的相对顺序保留；删除模型使用「删除副模型」。

追加模型时，阵容编辑页会说明复用哪个服务商的 API key、OAuth 登录或环境认证。要使用尚未认证的服务商，在模型列表末尾选择「配置服务商或模型」，即可在当前流程输入 API key，输入和提交后的画面都隐藏密钥，无需另去 `/login`。若服务商仅支持 OAuth 或环境认证，则使用其支持的方式。

按 Esc 取消认证会回到原阵容编辑，空白 key 不保存。确认保存的认证按服务商共享；取消后续 Team 编辑不会删除已保存的认证。自定义服务商须使用新的配置 ID，避免改变现有服务商和 Team。认证配置存在不等于 key 的远端权限已验证；添加过程不自动调用模型。

`-c` 继续当前目录最近会话，`-r` 打开选择器。运行时新输入保留为草稿，不自动排队。多行粘贴中的命令文字保留为材料；小于 40×12 时暂停发送。选中文字使用 macOS／Windows 原生剪贴板顺序复制，写入完成后才确认。

直接 `!` Shell 与手动压缩入口仍关闭。工作中的 Shell 使用受管 Pi 工具。

## 安装和查看 Pi 资源包

```sh
cothink install npm:包名
cothink install npm:@scope/包名@1.2.3
cothink install git:https://github.com/owner/repo@ref
cothink install ./my-plugin
cothink install npm:包名 --local
cothink list --json
cothink remove npm:包名
```

从源码运行时，将上面的 `cothink` 替换为 `node bin/cothink.js`。

个人 npm/Git 包保存在当前 `COTHINK_HOME/pi/npm` 或 `pi/git`，同一数据目录的所有 Team 共享。`--local` 使用原项目 `.pi/npm` 或 `.pi/git`；`remove --local` 只移除项目登记。URL 指锁定 Pi 支持的 Git URL，不包括任意归档下载；内嵌凭据请改用 Git credential helper。本地文件或目录沿用原生链接语义，卸载只取消登记，不删除原文件。项目包的明确安装授权保存在 CoThink 数据根，绑定原项目规范路径与登记摘要；复制或生成 `.pi` 不会自动获得授权。管理命令不需要模型配置、API Key 或已命名 Team，不发送生成请求。

安装会联网下载文件，并按 npm 原生方式执行根包和依赖的生命周期脚本；安装本身不 import 扩展来检查兼容性。脚本属于用户主动选择运行的代码，受管候选回退不能撤销任意宿主副作用。实际精确版本及 npm lockfile 会保留；再次安装同一精确版本会先核验现有文件，无版本或 tag 的显式安装可选择新版本，没有后台更新。安装/卸载前须退出使用同一数据目录的全部 CoThink 窗口，包括空闲会话；`list` 可在会话打开时执行且不联网、不补装。

可用的 skill 正文、Markdown 提示模板和 JSON 主题会在下次启动时载入。旧 CLI 的普通纯答沿用原模式，CoThink 有一位评审、共三次调用，`/one` 一次。显式 `/skill:名称` 与模板使用现有入口。手工 `piResources` 保留，同名不同来源或覆盖 `/team`、`/models` 等本地命令的资源会在发布前报错。包资源不能引用包外路径或符号链接。

显式安装的 JavaScript 扩展按 Pi 原生接口加载，不要求固定 UI 哈希白名单。安装与加载不代表工具已接入项目成果管理。普通问答不开放原生工作工具；本地插件命令在任务外执行，若尝试启动未绑定模型工作会明确拒绝。已适配原生工具复用 Pi 动态注册表，在独立副本中执行；有文件变化时须明确审阅后导入。插件代码受用户安装选择信任，不能声称受 agent-sync 全面沙箱保护。

失败和取消会保留候选及私有日志路径；不会自动重发安装。若提交中断，程序停止加载包；退出会话后下一次明确的 `install`/`remove` 会先核验备份并恢复上一稳定状态。证据不完整或目录被另行修改时会保留现场并报恢复错误。历史查询仍使用已保存的请求和技能正文，删除包不删除历史。

## 执行项目工作

在有 HEAD 提交的 Git 项目中启动并描述实际修改。主模型在首次请求中选择进入工作，无额外分类请求。`/one <任务>` 沿用同一版本流程，由主模型担任唯一 Team 负责人。

每位执行者使用 agent-sync 的独立源码投影。写范围冲突在执行前等待，读快照不占写锁；已知范围可以直接声明，未知时先观察。领导可亲自工作，collect 先返回可处理成果。普通工作只有主模型可以正式委派；显式项目里，获授权的子负责人还可在直属组内派工。原目录未提交内容不自动进入起点，原用户目录不覆盖。非Git或无HEAD目录明确拒绝。

文件工具读取权威tree，写入有旧内容前提并整批原子提交；候选固定后仍可修订。领导审阅已展示内容后可直接accept_change，宿主负责候选ID。反馈保留原草稿/会话；具体依据或范围变化通过refresh_change保留成果并反馈差异，不靠重造patch解决。

默认采用项目声明的 npm test；可配置容器内固定检查命令和执行环境：

```json
"work": {
  "checks": [{ "command": "node", "args": ["--test"] }],
  "execution": {
    "engine": "docker",
    "image": "node@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8",
    "network": "none",
    "limits": { "memoryBytes": 4294967296, "cpus": 2, "pids": 256 },
    "artifactPaths": ["node_modules"]
  }
}
```

纯文件操作不要求Docker。Shell和非空正式检查需要可用的本机Docker引擎、固定镜像及其工具/依赖；首次Shell才创建容器，同一修改复用。网络默认关闭，项目依赖需宿主预置到固定镜像，不能借用成员放入的node_modules作可信检查。宿主绝对命令、秘密env、任意挂载和宿主Shell回退不支持。未配置/不可用会报告具体环境缺口，不影响问答或只读历史。

Shell是Linux隔离环境，工具交接暂停全部进程，后台服务可跨命令使用；不承诺macOS专属编译/GUI/宿主权限。非法或越界源变化整体拒绝并保留现场，明确resetExecution才封存后恢复。长日志使用read的 output:<outputRef> 入口，offset/limit仍按行；日志路径不能写入或作为源码搜索。

最新组合满足固定检查后，唯一正式ref才条件更新；空策略明确unverified。响应未知只能查询原请求，不能换ID重发。最终给出实际版本、检查和只读成果目录；写回原分支仍需明确Git操作。

元数据默认位于 COTHINK_HOME/agent-sync，旧 projects 留作历史解释。新写路径不会自动接管已有项目；先处理所有旧open/prepared/unknown记录，再明确迁移：

```sh
cothink migrate-work /absolute/project --json
# 没有任何新接纳时，才允许显式回退元数据；不会reset历史
cothink migrate-work /absolute/project --rollback --json
```

迁移保存原元数据、回执、修改和引用快照，停用旧写入口，再登记原正式ref。数据损坏、缺ref、旧请求未决或活跃writer都会停止。旧安装对迁移项目的写入被阻止，旧只读事实仍可查。已有新接纳后必须沿新历史修复，不能简单换回旧程序继续写。

原生 skills、模板和显式选择的扩展保留。扩展来源哈希用于追溯，不作为逐包放行白名单。普通原生工具经工作适配器使用独立副本，本地命令零模型调用；选中资源不授予额外写权限，候选中的 .pi 也不自动加载。兼容边界和源码/localhost/安装/PTY/真实模型证据见 VALIDATION.md。

### 从 CLI 持续推进项目

在有初始提交的 Git 仓库打开交互式 `cothink`，输入 `/project`。状态栏变为 **PROJECT · 项目**，切换本身不调用模型。直接输入目标，例如“给现有列表增加 CSV 导出”。新项目先用当前主模型做一次只读规划（这一次调用在项目预算之外），展示拟修改范围、交付物、容器验收命令及预算。按 Esc 回到输入框，输入“开始”才执行。也可输入“查看计划”重新核对，“取消计划”丢弃草案，或输入更准确的目标重新拟定。

项目开始后，输入“状态”“暂停”或“继续”。运行中可用 `/project status` 或 `/project pause`，也可用下面的独立终端命令。已有项目中输入新目标会拟定对既有步骤的修订，沿用范围、预算和验收命令；确认修订后输入“继续”。切回 `/one` 或 `/cothink` 只更改下一条输入的处理方式。项目详情用状态输出中的 `cothink show <任务ID> --all` 查看。会话恢复和分支保留终端模式与该分支的待确认草案。GUI 后续新提交使用上文统一会话，保留旧任务事实。

也可直接从系统终端运行项目。在有 HEAD 的 Git 仓库内，准备一个项目计划。下面的例子假设已提交的旧文件 `legacy.json` 使用 `{"rows":[{"id":"0007"}]}` 格式。第一步导出原数组，第二步从正式版本读回并核对条数。先配置好 Team、认证和工作环境。开始和恢复可以发送模型请求，查看状态只读。

```json
{
  "goal": "把旧记录导出为 JSON，再读回核对条数",
  "scope": ["export.json", "count.txt"],
  "steps": [
    {"id": "export", "goal": "把 legacy.json 的 rows 数组原样写入 export.json", "deliverables": ["export.json"],
     "checks": [{"command":"node", "args":["-e","require('node:assert/strict').deepEqual(require('./export.json'),require('./legacy.json').rows)"]}]},
    {"id": "verify", "goal": "读回 export.json，把条数写入 count.txt",
     "dependsOn": ["export"], "deliverables": ["count.txt"],
     "checks": [{"command":"node", "args":["-e","if (String(require('./export.json').length) !== require('fs').readFileSync('count.txt','utf8').trim()) process.exit(1)"]}]}
  ]
}
```

把计划保存为 `plan.json`。在当前源码候选中可用 `node /path/to/checkout/bin/cothink.js` 代替下面的 `cothink`。

```sh
cothink project start --file plan.json
cothink project status --json
cothink project pause
cothink project revise --goal '导出时保留空记录和原顺序，再核对条数' --step export
cothink project resume
```

每步需要明确交付路径和至少一项固定容器检查。依赖满足后项目会自动开始下一步，交付前在最终版本核对全部入口。小项目可以直接在计划顶层填写 `deliverables` 和 `checks`，这时步骤 ID 为 `main`。改目标时如需改变某步的交付或检查，同时传 `--file revised-plan.json` 并用 `--step` 选中该步，原验收记录仍可查看。

`budget.maxCalls` 限制整个项目的调用次数，未知发送占用次数；`budget.maxCost` 是硬费用上限，目前由于缺少服务商可强制的单次费用界限，设置数值会阻止新模型调用。显式项目使用受管 Team 工具和冻结技能。选定插件的 PROJECT 容器路径见下节；普通原生助手路由不能借此获得项目权限。模型请求须通过宿主可逐次核验的 HTTP 适配器；不支持的传输会在发送前被拒绝。

### PROJECT 技能与受控插件（本工作树的未发布改动）

正式项目的根、子负责人、员工和只读审查者收到同轮技能目录，按需用 `read` 读取冻结正文、引用和资源。源文件随后改动或删除不会刷新正在进行的任务；新一轮才更新。`explicitSkills` 可在确认计划中点名禁自动调用的技能，完整修订计划可以撤销选择。目录可见、实际读取、脚本执行和产物检查是不同证据，都保存在既有任务记录中。

可写员工使用 `resource_exec` 在固定断网镜像中运行所需脚本，资源位于只读 `/resources/<技能名>/`，源码位于授权副本 `/workspace`。`resource_result` 先检查并明确采用或拒绝差异，随后仍须正常接纳。只读审查者不能借技能启动写入。Node/Python、浏览器、npm 依赖和服务账号必须事先准备；文件链接和本地 import 扫描不等于完整依赖解析。缺依赖时保留失败与已完成内容。

插件先按既有 `install` 安装，再在计划顶层选择 `"plugins":["已安装包名或精确source"]`，并在共享配置设置 `work.projectPluginRuntime` 指向预先准备的 Linux Pi 运行目录。从源码准备可运行：

```sh
node scripts/prepare-project-plugin-runtime.mjs /absolute/path/to/new-runtime
```

含平台运行包的本地候选会由该脚本离线解包；源码准备使用锁文件在明确的 Docker 准备步骤安装依赖。项目执行时不安装。原生包代码、依赖和技能只读挂载，每位员工使用独立源码副本；不传入原目录、正式版本线、整份数据根、Docker socket 或模型密钥。插件工具按来源编号显示为 `project_plugin_0_read` 等，文件结果经 `project_plugin_result` 审阅后导入。实际模型续行仍受同一项目调用预算约束。

已安装原生扩展时，可以用 `cothink --project` 从干净进程直接进入终端项目模式；文件入口仍为 `cothink project start --file plan.json`。普通终端切换 `/project` 时，曾加载原生扩展的旧进程不会通过 dispose 冒充干净：可用的 macOS 内核观察器先核对连续观察记录，保存当前会话、分支和草稿，等旧进程真正退出后，由可信父入口从新进程恢复 PROJECT。恢复的草稿需要用户提交，不自动生成。

自动迁移采用保守边界：首次第三方加载之后发生过任何进程派生（包括合法的宿主命令）、存在未决动作，或观察器/交接状态无法核实时，保持阻塞并保留历史和草稿；不通过扫描不到 PID 来放行，也不声称本地退出撤销了远端效果。未经监督的旧进程、设置了 `NODE_OPTIONS` 或额外 Node 启动参数的进程，以及缺少可核验平台后端的环境不提供自动迁移。源码使用前运行 `npm run build:handoff` 准备 macOS 观察器；macOS 的 `npm run pack:npm` 自动执行该构建并随包分发摘要核验的产物，交互启动时不会编译或安装。Windows/Linux 的自动旧宿主迁移仍需对应的可靠后端，直接干净 PROJECT 入口不依赖这个后端。

特殊 UI、未接管的生命周期变换和未适配助手路径会给出具体限制。源码、真实包、替身、安装入口及外部服务证据分别见 [VALIDATION.md](VALIDATION.md)。

计划选择 `pi-subagents` 后，可用原生前台助手和已验证的异步 `parallel` workflow。助手使用独立副本、同轮技能和同一项目预算；父级等待让出席位，项目最多两名活动执行者。`cothink_helper_result` 由实际创建者检查、采用或拒绝成果，根再正式接纳。容器中没有真实模型密钥；调用与未知费用按宿主请求记录计算。原生 remote/resume/verifier 路径及所有 inline workflow 变体不在当前支持承诺内，具体见[原生宿主合同](docs/pi-subagents-host-contract.md)。

已正式接纳的主模型草稿按原接纳回执结清旧范围占用；主模型缩小新草稿范围后，员工可接手既有工作。未接纳草稿和未知操作仍保留占用。保存内容已经等于正式版本时，继续从只读状态起步，不重复恢复文件。继续材料包含每项工作／模型最近的已收取报告及原范围、版本和回执，避免仅因切换尝试重复派工；这不保证报告结论正确，也不替代当前候选检查。

受管 `write` 可用原 `path`/`content` 写单文件，也可用 `files: [{path, content}, {path, content}]` 一次原子写入两个文件。两个路径必须都已在当前写范围内，旧文件须先读取；第二个依据过期时第一个也不会写入。一次双文件写入仍只消费一次修复写入机会，不省略候选检查。

受管 `grep` 使用 Pi 工具目录中的 `rg`，没有时查 PATH；两处都没有时会明确失败，不在任务中下载搜索程序。`find` 只查询当前获准版本的文件清单。`read output:<请求ID>` 可读取本任务获准的命令输出；纯 PNG/JPEG 二进制输出按图片显示，截图无需仅为查看而加入源码。命令产生非 UTF-8 或含 NUL 的二进制日志时，模型收到原输出引用，不收到乱码；混合文本与图片的日志明确标为非文本，原始字节保留，不能冒充可显示的纯图片。Shell 权限、输出归属和预览工具的原有限制不变。

### PROJECT 的 MCP 连接

未调用的服务不会在岗位启动时连接；实际调用前仍验证工具登记、精确参数、权限与费用边界。连接地址及最小服务凭据沿用 `COTHINK_HOME/pi/mcp.json` 的 `mcpServers`。目前接入 Streamable HTTP URL，以及 `command:"node"`、一个 JS 入口参数和专用代码 `cwd` 的命令服务；命令服务运行在断网容器中。OAuth、额外环境凭据、任意可执行程序/npx/Python、legacy SSE 等路径尚不支持，会明确报错。

在文件计划或终端待确认计划的 `mcp` 中选择已配置服务、工具、实际目标和精确参数。例如以下是计划片段，仍需已有的目标、范围、交付物与检查：

```json
"mcp": [{
  "server": "local-service",
  "trust": "explicit-service-contract",
  "tools": {
    "read": {"kind":"read","target":"sample","allowedArguments":[{"id":"sample"}]}
  }
}]
```

`trust` 表示用户确认了服务语义，或已有可核实的服务端只读账号限制；服务自报 `readOnlyHint` 不授予权限。写入及启动还须与该工作的 `effect` 具有相同 `target/action/round`。参数扩大、账号/来源或工具 schema 改变时，旧批准不能继续使用。URL 服务没有可强制的费用上界，硬费用预算下会阻止连接和调用；工具次数不计作模型调用数，外部效果认领数也不是全部网络请求或账单。

URL 长任务用原请求回执恢复；确认计划中的 `query/cancel` 必须绑定原启动工具与 job 参数。可在另一终端使用 `cothink project mcp query '{"originalRequestId":"原请求ID"}'` 或 `cancel`，不会重发启动工具。取消 ACK、断线、关闭连接及取得 job ID 都不代表远端已停止。未知动作保留占用，仍可推进已证明无关且获准的工作。

**暂停后的可写命令型服务不会被重新解冻来查询 job**。宿主丢失后，同一 `project mcp query/cancel` 入口可以核验原命令容器的不可变 ID、标签、镜像和挂载，查询其进程状态或停止原容器，保留部分文件与原输入版本；不重连服务、不启动新 job、不自动导入，业务结果仍可为 unknown。若一个当前容器还有其他未决工作，应先明确暂停全项目再停止共享进程。旧记录缺少身份凭据时保持阻塞。正常活跃命令服务的原 job 查询及 URL 的暂停后恢复已有本地验证；真实外部账号、效果和费用另行验收。

用 `project staff appoint` 点名设岗，例如 `cothink project staff appoint '{"id":"exporter","responsibility":"兼容旧导出","scope":["export.json"]}'`。岗位沿用已配置的 Team。用 `promote` 指定子目标与允许的模型，子负责人可直接给直属员工派工、收集和退回同一草稿。独立审查使用只读岗位。对于总负责人自己的草稿，用 `prepare_change` 返回的 `reviewOf` 指向已固定的候选。正式接纳仍由总负责人查看确定的差异后完成。转派或撤岗先交接并停止新派工，再用 `finish` 核实在途请求和未处理成果。

正式项目默认最多三层，根计第一层。根负责人可用 `project_staff` 的 `set_depth` 为本轮选四层。各级只在获准范围和阵容内授权直属员工。减层或转组前须结清受影响的指派。

负责人用 `pause_member` 暂停直属员工和未结清的下属。宿主先封住请求、写入和接纳，再请求停止，保留草稿和原回执。不相关工作继续，未核实的请求保持未知。当前任务内，直属负责人可用 `resume_candidate` 提交已结清的原候选和私有版本，由根负责人重新审阅。

员工用 `request_staff_group` 上报阻塞、建议范围、依赖和调用预算。直属负责人通过 `collect` 接收，可增员或转报原请求。

在显式项目里，两个员工可同时选择 Team 里同一条模型路由，也可选择主模型。每个员工仍有自己的岗位、会话和草稿。总负责人和子负责人等待下属时让出执行席位，合计最多两席。查看 `project status` 可以把岗位和工作编号对应到派工与请求；用 `show <任务ID> --all` 查看那一次实际调用。如果一次发送结果未知，请按原请求号查询，改标题、岗位或模型不会给同一工作增加一次发送机会。

默认每个交付文件有一个工作编号，例如上例的 `export:export.json`。要在同一步并行实施前端和算法，可声明下面的两个工作。把 `works` 放在该步的 `deliverables` 和 `checks` 旁边，两个文件都须在步骤范围内。

```json
{
  "works": [
    {"id": "frontend", "scope": ["index.html"]},
    {"id": "algorithm", "scope": ["algorithm.js"], "independentReview": true}
  ]
}
```

派工工具 `delegate` 的 `staffId` 选择直属岗位，`workId` 选择已登记的工作，`model` 填 Team 中获准的完整 `provider/model`。有权限的负责人可用 `project_staff` 的 `register_work` 为普通步骤登记范围清楚的子项。需要严格评审或共享生成的工作请在初始计划中划分，这类工作不支持在运行中拆开。若两个工作要使用同一份生成样本，在两项工作内写入相同的 `"effect":{"target":"样本 A","action":"生成输入","round":1}`。宿主按目标、动作和轮次共用一次生成结果，各岗位仍分别完成本职工作。确需第二份样本时，在计划中另行授权第二轮。用量按实际发送计入项目预算。

上例只要求 `algorithm` 独立评审。把 `independentReview: true` 放在步骤上会要求审查该步的所有工作。终端草案中同样可核对这一字段及其对应的交付物，确认前可重新拟定。只读岗位审查具体候选时在 `delegate` 中给出 `reviewOf`；省略 `reviewKind` 按独立评审处理，普通复查显式用 `reviewKind: "ordinary"`。`reviewOf` 创建的候选评审岗位与协作承诺中的员工工作分别计数；普通实现、调查、测试或不带 `reviewOf` 的只读检查可以形成员工贡献，仍须真实执行、收取、处理并经过过程检查。普通员工从当前正式版本取得输入；Shell 即使只运行检查也占用调用者的写范围，应先安排彼此不冲突的实际工作。严格评审须能核实异型号，并排除该候选的作者和参与决定的上级。同型号复查可以提供反例。宿主核对直接服务端点及实际响应中的型号。自定义代理、localhost 或无法辨认的路由可以执行工作，其型号证据不足以签发严格通过回执。缺少合格回执、受审内容已变或仍有未解决的反例时，状态会说明交付缺口。所有交付还须通过最终版本的固定检查。

带 `checkpoint: true` 的步骤会停下来复核。可在步骤的 `review` 中提前指定一个能区分原因的文件观察，包括 `path`、`contains`、`reason`、`ifPresent` 和 `ifAbsent`。对于已通过的复核点，两个分支可分别指定 `continue` 和 `blocked`；如果观察允许修复，还须指定 `repairScope`。人工介入时通过 `project status --json` 取得步骤、修订号和候选版本，再用 `project route judge` 与 `project route experiment` 绑定这一次观察。

诊断后的单次修复通过 `prepare_change(check=true)` 执行原固定检查。只有当前候选和公开回执完全对应，后续新请求才恢复原权限；同一修复回复不会因此获得额外权限。私有检查通过不等于正式接纳，原协作、视觉检查、独立审查和最终检查仍须完成。旧任务若已通过这些私有检查却停在修复边界，可在核实原草稿与回执后手动继续；原未知记录保留。

同一数据根按 Git 仓库保存一份持续项目记录。同仓后续目标用 `revise`，从另一个窗口控制时用相同的 `COTHINK_HOME` 和 `--repo`。暂停在项目记录中保留，重新打开后用 `resume` 明确恢复。请求已发出而结果不明时，查看原任务和请求记录；成果位置与正式版本以项目状态为准。工作区中的未提交文件不进入正式起点。

## 数据与旧配置

数据根默认 `~/.cothink`，可用 `COTHINK_HOME` 指定。项目团队记录位于 `project-delivery/`，模型会话、任务和请求分别在 `pi/`、`tasks/` 和 `requests/`。旧 `runs/` 与会话记录继续只读可查，不自动恢复执行。

旧格式配置须显式导入：

```sh
cothink init --import-legacy
```

导入先备份原字节，再保存 Pi 认证和模型引用。回退时恢复保留的旧程序和对应旧配置，保留新旧历史；若配置在切换后又被修改，先核对差异，不强制覆盖。不要把认证文件或私有备份提交到仓库。

## 选择 Pi 资源

不自动继承 `~/.pi` 的全部设置。可在现有配置添加明确的本地资源路径：

```json
"piResources": {
  "skills": ["/absolute/path/to/skill"],
  "extensions": ["/absolute/path/to/extension.ts"]
}
```

当前源码的统一 GUI 默认提供 `doc-maintenance` 与 `context-management`。设置 →「技能与能力」可逐项禁用，并查看宿主提供的技能、实际工具、权限与环境缺口。禁用只影响新任务；手工配置为 `piResources.builtinSkills: {"disabled":["doc-maintenance"]}`，只接受两个规范名称且不能重复。用外部同名技能替换时，先禁用内置项再添加外部路径；两个启用来源同名会在请求前报错。

正式 PROJECT 运行时，能力页分别显示协调器与所属执行者的工具和当前权限，不把执行者的权限合并给协调器。权限取自当前工作范围与准备／评审阶段；初始只读观察即使列有后续可申请的写工具，也不表示已获得写入权限。历史继承成果不成为当前执行者的能力来源。成员交回结果或获接纳后，即使会话仍保留供反馈使用，也不列为当前执行者；合法反馈重新激活后才恢复显示。停止的任务或角色不保留当前执行权限。

统一任务先向模型提供冻结目录，按需通过 `read_skill` 读取正文和引用。`/skill:name` 也是读取本轮冻结正文，不会在请求时重新读取源文件；原输入和真实读取记录保留。没有工作目录也能读技能，不会因此创建项目或获得任意文件、脚本和插件权限。根任务、独立评审与所属正式执行任务共享同一冻结版本，恢复不回源刷新。 GUI 的显式 `/skill:name` 也按此目录校验；禁用或未知名称在发送前拒绝，仅显式调用的外部技能不会自动加入普通问题。目录提供、正文读取和脚本执行分别记录，不能把提供目录称为使用了技能。

`doc-maintenance` 的来源、版本、原始哈希与改写说明见[资源来源](resources/builtin-skills/doc-maintenance/assets/source.json)。随包 checker 已包含锁定依赖，需在获得执行权限的受管副本中通过 `resource_exec` 运行；例如 `node /resources/doc-maintenance/scripts/doc-maintenance.mjs check --root /workspace --files README.md --json`。`check` 只读，`confirm` 写确认记录，`run` 执行选定项目命令；结果仍需创建者通过 `resource_result` 审阅，文件按原规则接纳。没有执行工具时只提供指导。

`context-management` 的普通追问和手动整理只带当前分支的用户消息、经理终稿和生效摘要。需要查归因、证据或续作时，主模型用 `search_context` 和 `read_context` 按当前分支任务及目的查询核对过的事实；原始工具、私有请求和凭据不进入上下文。引用可分页，`save_context_note` 保存派生记要，记要与摘要不授予权限。正式工作提议冻结原题、有效会话与来源；确认、恢复和修订使用核验后的原快照，另保留较早已确认操作的原题，不重新展开已压缩历史。引用缺失、归属不符或字节变化时停止执行。

「对话操作 → 整理上下文…」在明确确认后先保存完整编辑稿，再以独立任务执行一次整理，使用所选本轮请求上限。实际 preparation 通常需要一次，split-turn 最多两次；预算不足在首次发送前拒绝。整理期间该会话的持久编辑暂缓，本机新输入保留，其他会话仍可存稿。原 entries 保留，来源或磁盘写入不确定时隔离运行端，查询原 operationId 而不重发；需要旧上下文时从整理前已完成的回复新建分支，不原地撤销。自动压缩继续关闭，口头总结不等于保存记忆。`disable-model-invocation: true` 是仅用户显式选择限制，与整项禁用不同；引用材料不能替代显式选择。

旧 CLI 的 `skills` 仍是普通自然语言问答的预载来源，默认不启用任何技能，也不自动增加这两项内置资源。配置路径后，每条任务会将其中允许自动调用的技能主文件正文加入实际模型上下文，主模型按当前目标与描述判断是否适用，无需 `/skill:`。普通纯答仍是三次，`/one` 仍是一次；技能不会扩大工具权限或构成执行授权。

旧 CLI 普通问答每条任务冻结同一份内容供初稿、评审、修订使用；下一条才读取文件更新。预载只加载主文件，不递归读取引用或执行脚本；正文增加输入用量，不截断或自动重试。正式 PROJECT 的目录及引用冻结采用上节路径。文件缺失、无效元数据、空目录及不同文件同名会在生成前报错，真实文件重复路径去重。`disable-model-invocation: true` 不自动预载。

旧 CLI 的 `/skill:name`（包括 `/one /skill:name`）优先使用 Pi 原生显式展开，本条不再叠加自动预载列表，禁用自动调用的技能仍可显式使用。`/chat`、Ctrl+O、`show ID --all` 可查看已预载的名称、来源和哈希；这只表示已提供材料，不代表模型已使用。`show ID --json` 的原请求保留正文，旧任务不受技能文件之后的修改影响。恢复和查看本身不生成。

另有 `prompts`、`themes` 路径数组。主会话加载选定资源；普通工作动态发现已安装工具，无需手工枚举工具名。旧 `piResources.tools` 不会绕过工作授权，建议移除该字段。准备、冲突确认和普通纯答不开放原生工具；宿主 read/write/start_work 等名称不得被扩展覆盖。注册替换遵循锁定 Pi 的调用快照：在 tool_call 中替换同名定义，后续调用使用新定义，已进入的调用仍使用其原定义。

原生工具及工作生命周期的 `ctx.cwd` 是独立副本；文件变化保留为 nativePluginResultId，由创建者明确审阅、导入或拒绝，沿用公共 edit、审阅与接纳。宿主写入后，干净副本从当前正式私有版本刷新；有未处理差异或旧输入时明确阻断。普通异步工具的 Promise 返回仅证明该次受观察调用结束，不证明任意脱离的后台 JavaScript 或进程已停止；这类路径不在通用兼容承诺内。

旧 CLI 通过 Pi 入口执行已注册的本地插件命令。会话空闲时在终端输入 `/reload`，重新加载本地入口及其相对 JavaScript 模块。统一 GUI 不在宿主加载这些任意原生入口。重载失败会阻止新生成，已保存的历史仍可读取。Pi/Jiti 的窄兼容补丁保留模块来源、顶层 await 与 SDK 共享身份，见 THIRD_PARTY_NOTICES.md。

历史 GUI 版本映射通知、状态、select/input/confirm（取消与插件显式提示超时）；会话／任务关闭会结束待答提示。文字小组件可显示；原生被动装饰仅显示未渲染警告，不运行组件工厂。主动 custom/editor、终端输入及自定义编辑器等接口明确报 EXTENSION_UI_UNSUPPORTED，使用交互终端入口。非交互 ask 维持 Pi 的 hasUI=false，不宣称显示了对话框。历史加载/注册结果不构成任意插件兼容承诺。

模型文件工具限于各自副本与选定技能资源。工作中的脚本执行沿用已配置的固定断网 Docker 环境，不回退宿主 Shell。技能主文件及明确引用的资源复制到任务材料，不递归复制其任意上级目录；缺失资源明确报告。实际工具调用、插件报告用量和未知费用分别保存。第三方任意 JavaScript 副作用不在本地验证保证范围内。

## 调用与验证规则

- 默认不设本地模型超时或可省略的输出额度；`--timeout MS`、`--max-output-tokens N` 可显式设置，运行前展示实际政策。协议必填额度须配置，按模型配置的显式额度也会传到实际请求。
- 自动重试、压缩、预热关闭。未知请求不重发；纠错须有具体反馈。接纳结果未知时查询既有 requestId，不用新 ID 重做。
- 请求意图和工具意图先保存；保存失败则停止副作用。用量缺失保持未知，目录费用估算与账单区分，未知费用为 null。
- 源码与安装包的 localhost fixture、PTY、真实模型和用户现场检查属于不同证据层；具体版本及限制见 [VALIDATION.md](VALIDATION.md)。各版本 CI、安装与物理平台证据分别记录，不能相互替代。

源码验证与固定依赖重建：

```sh
npm test
npm run test:pi-terminal
npm run build:pi
```

Pi 来源、固定补丁和产物哈希在 `vendor/pi-patches/`，许可说明在 `THIRD_PARTY_NOTICES.md`。重建使用固定源码与已发布目录数据，不刷新为最新模型目录。源码中的 `archive/agent-sync-git-20261019/` 只保留迁移测试所需的旧实现夹具，发行包与当前执行入口均不导入它。

## 许可证

CoThink 原创代码与仓库内 agent-sync 内核采用 [MIT](LICENSE)。第三方依赖保留各自许可证，固定 Pi 补丁、来源和许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。


### 新版本提醒

交互 CLI 和 GUI 就绪后默认在后台检查 `https://registry.npmjs.org/cothink-v2/latest`，每个数据目录 24 小时内自动尝试一次（失败也计入间隔）。请求不携带模型密钥、npm token、对话或项目内容，检查不调用模型；非交互 ask、管道、history、show 和帮助不会自动查新。查新以 npm latest 为准，可能包含发布者明确推荐的预发布版本。

- CLI：`/updates` 查看版本、最近检查时间、官方说明和更新指引，手动检查或切换自动检查。
- 无模型配置时：`cothink check-update`；脚本使用 `cothink check-update --json`，成功检查返回 0，检查不可用返回 1。
- GUI：顶部“有新版本”提示打开设置的“可用更新”；也可直接从设置检查。提示不抢焦点、不清草稿；“本地更新记录”仍只说明已安装版本。
- 停用自动检查：在面板关闭开关，或设置 `COTHINK_NO_UPDATE_CHECK=1`。显式 `PI_OFFLINE=1` 禁止包括手动在内的全部查新。开关保存在 `COTHINK_HOME/update-state.json`，与 Team、认证和本地摘要已读状态分开。

一次查新只发送一个 GET，不重试；总期限 5 秒（含响应体）、最大 256 KiB、拒绝重定向。网络失败时继续使用，手动界面显示失败与带时间的旧缓存。状态损坏或不可写时保留原件，本次进程停用自动检查；手动结果只在内存可用，保存失败不会显示“已保存”。已打开的界面在下一次任务提交或 GUI 获得焦点时再检查是否到期，不运行常驻定时服务；多个进程恰好同时首次启动可能各发一次请求。

按原安装方式选择指引：npm 全局安装显示经过验证的精确版本命令（Windows 为 `npm.cmd`）；自定义 prefix 沿用原 prefix。Windows ZIP 从[官方 Releases](https://github.com/XSY-28/Cothink-release/releases)选适配架构，退出旧进程，在新目录安装启动，保留数据目录；源码或托管目录按原方式更新。所有命令仅供阅读/复制，CoThink 不执行下载、安装、目录替换或重启。npm 推荐版本可发现不代表所有平台资产均已核实可用。旧版用户需先手动安装一次含此功能的版本，以后才有提醒。

## HTML/SVG 制作与视觉检查

已有 Git 项目中可用 `cothink make-html --one "制作任务"`；省略 `--one` 使用 CoThink。持续终端用 `/make-html <任务>`，继承当前 ONE/CoThink；统一 GUI 直接描述制作目标，在完整计划中确认 `workRequest:{kind:"html-svg"}` 后沿用子任务的制作与视觉检查路径。这是单条制作要求，不是第三种对话模式。输入中的引用、代码块不作为制作动作；CLI 管道保留多行原文。没有关联项目时先选择项目，草稿保留，不自动初始化 Git。

提交前需要：支持图片的主模型、显式配置的适用技能、Docker 和已核验的预览镜像。技能通过 `piResources.skills` 指定 SKILL.md 主文件或已有受管包，任务冻结名称、正文和 SHA-256；不会扫描个人目录补齐。CoThink 的实际制作成员也必须支持图片。示意配置需合并进现有配置，不替换 Team/认证：

```json
{
  "piResources": {"skills": ["/绝对路径/frontend-design/SKILL.md"]},
  "work": {
    "checks": [],
    "execution": {
      "engine": "docker",
      "image": "从 docker/visual-preview-manifest.json 读取实际 image 字段",
      "network": "none",
      "limits": {"memoryBytes": 2147483648, "cpus": 2, "pids": 256},
      "artifactPaths": []
    }
  }
}
```

旧 CLI 的纯问答沿用 ONE 一次、CoThink 三次。这个制作入口直接进入工作，调用次数不设上限，不额外调用分类模型。输出额度按已有模型配置，不新增默认模型超时。`preview_html` 在断网容器内服务 HTML/SVG 及本地资源，可指定视口、最多三帧和六步 click/fill/key；没有任意 evaluate 接口。预览操作的 30 秒技术上限用于清理失控页面，不是模型请求超时。实际采样时间是墙钟时间，不是精确动画仿真。

截图作为 PNG 进入同一 Pi 请求路径。最终接纳后，宿主为确定的集成版本再截图并送回主模型；有修订则检查新版本。图片未发送、截图失败、页面错误或未知请求不能冒称视觉检查完成；已接纳内容不会回滚。截图保存在数据根 `artifacts/<taskId>/<requestId>/`，GUI“检查”页按任务鉴权读取，CLI 输出本地证据链接。候选/历史截图与最终版本检查分开显示。

这些都是 **CoThink 调用方能力**。agent-sync 内核、依赖、权限与恢复合同未修改：其无内容变化的 exec 仍可能产生新 privateVersion。调用方保存执行前后版本，并通过公共 inspect 的空差异证明内容未变；最终检查 change 随后结束，不把操作记账提交作为产品修改接纳。

### 预览镜像的来源与重建

当前实测平台为 Linux ARM64（macOS Docker Desktop），锁定 Node 基础镜像、Playwright 1.64.1、Chromium Headless Shell 156.0.8078.4 / revision 1248。镜像 digest、脚本 SHA-256 和浏览器资产 SHA-256 见 `docker/visual-preview-manifest.json`；实际 Debian 包版本清单见 `docker/visual-preview-packages.lock`。镜像不在模型任务运行中下载，也不包含在 npm 包里。Windows Docker / Linux x64 尚未实测，不承诺已有对应镜像。

从锁定依赖的源码准备以下构建上下文：`playwright-core/` 来自 `node_modules/playwright-core/`，`visual-preview.mjs` 来自 `scripts/visual-preview.mjs`，`chromium_headless_shell-1248/` 包含解压后的 `chrome-headless-shell-linux-arm64/`。浏览器资产为 [官方 Linux ARM64 Headless Shell](https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux-arm64/chrome-headless-shell-linux-arm64.zip)，SHA-256 必须是 `81ab9d4d3c301dc5fdfb6c541b9e6632b16fc819a6a854460f40a76fe2b2c476`。不要使用宿主 macOS 浏览器目录。

使用 `docker build -f docker/visual-preview.Dockerfile -t cothink-visual-preview:local <上述上下文目录>` 构建。Dockerfile 在构建阶段安装 Debian 签名包与字体；清单记录本次实际版本，不承诺未来镜像源仍供应所有相同包。重建后必须核对包清单、实际 image digest、renderer SHA-256，更新锁定清单并运行 `npm run test:visual`；不能仅更换配置中的 digest 而宣称通过。已有核验镜像可用 Docker 的 save/load 原样转移，不需重新构建。

新视觉 benchmark 的 `prepare` 冻结相同制作合同、技能源文件字节、镜像和预览能力。`run` 仍是会发送模型请求的独立动作，须另行授权；新制作轮次不自动重试。旧轮次只查看/报告，不回写旧成果、盲选顺序或选票。

GitHub Linux ARM64 CI 使用 `node scripts/build-visual-preview.mjs` 在构建阶段取得锁定的 Linux 浏览器资产、构建固定镜像，并记录该次构建的实际 digest/包清单后再验证。此脚本不由模型运行时调用；其他平台可提供已核验的 Linux ARM64 上下文 `--context <目录>`。CI 结果绑定各次实际构建，不假定不同机器一定产生同一 digest。

角色、工具使用、版本和失败处理的控制提示词使用英文；用户原题、委派材料、反馈和技能正文保留原文。自然语言回复遵循用户语言，界面识别的“## 对评审意见的处理说明”标题保持中文。成员只在实际授权内工作并交接，主模型及宿主负责授权调整、接纳和最终集成版本检查。语言改写经过机制回归，不代表英文已被真实模型对照证明更有效。

本地 2026-11-16 真实恢复最终验收已完成，包含原大型游戏多角色、完整图证、正式接纳及终稿；最新修复仍未替换全局 App。逐项证据、历史快照与未覆盖边界见 [验证记录](VALIDATION.md)。
