# CoThink

## 介绍

**CoThink 让你把不同的 AI 模型组成一支团队，一起为你做事。**

在 CoThink 里，你的阵容由一个主模型和至少一个副模型组成。你直接和主模型对话。简单问题，它自己回答。遇到复杂任务，它就当项目经理，把目标拆成几项工作，再根据各个模型的长处安排分工。它可以亲自做其中的一部分，也可以让其他模型负责一个子项目。团队工作时，有模型负责执行，也有模型检查进度、指出哪里跑偏了。最后，由主模型把成果交给你。

CoThink 想探索的是，怎样**用算力换智力**。一项任务要经过很多步才能完成时，多出来的算力可以用来尝试另一条思路，检查前一步的错误，或者把有问题的部分重新做好。我们希望通过这样的协作，让模型团队能完成单个模型难以独立完成的长程任务。

## 更新

**0.8.14-desktop.33（2026-11-19）** 折叠回复里的代码块，支持展开、复制，以及在对话旁预览 HTML 和 SVG。完整记录见 [CHANGELOG.md](CHANGELOG.md)。

**0.8.14-desktop.34** 桌面对话内置 Web Design Engineer，可输入 `/skill:web-design-engineer` 并附上设计需求。开关在「设置 → 技能与能力」。

**0.8.14-desktop.35** 新建 Team 时可从九个角色中选头像（含小狗洛丽塔），点击“创建”保存。侧栏和该 Team 的回复都使用所选头像。旧 Team 默认使用巴巴祖。公开 npm 包使用占位图，角色名称和选择仍会保存。

**0.8.14-desktop.36** 配置阵容时先显示常用型号，可按服务商浏览或搜索完整目录。选好主、副模型后，可以在对应席位保存或更换 API Key；同一服务商的席位共用认证。离线目录补入 GPT-6.2 Sol、GPT-6.2 Astra 和 Claude Fable 5.2 的官方或网关条目。

**0.8.14-desktop.37** 在侧栏右键单击 Team 头像，选择「删除 Team」并确认。该 Team 及其全部对话将从 CoThink 移除，磁盘上的项目文件会保留。

## 下载

- **Windows 桌面 App**：关闭 CoThink，从 [Windows .36 发行页](https://github.com/XSY-28/cothink-GUI/releases/tag/v0.8.14-desktop.36) 下载相应的安装器。Intel、AMD 电脑选 x64，骁龙电脑选 ARM64。双击可安装或更新，运行时和动态 Team 头像已内置。
- **npm 版**：需要 Node.js 22.19 或更新版本。运行 `npm install -g cothink-v2@latest`，Windows PowerShell 可用 `npm.cmd`。运行 `cothink gui` 打开浏览器界面。[npm 包页面](https://www.npmjs.com/package/cothink-v2)
- **下载 npm 安装包**：从 [npm 下载 .tgz](https://registry.npmjs.org/cothink-v2/-/cothink-v2-0.8.14-desktop.37.tgz)，在下载目录运行 `npm install -g ./cothink-v2-0.8.14-desktop.37.tgz`。
- **历史分平台 npm 包**：[0.8.14-desktop.34 发行页](https://github.com/XSY-28/cothink-GUI/releases/tag/v0.8.14-desktop.34) 提供 macOS Apple Silicon、Windows x64 和 Windows ARM64 归档。
