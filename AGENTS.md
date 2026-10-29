# 薯页摘录 · AI 协作指南

本仓库是 Chrome / Edge Manifest V3 浏览器扩展「薯页摘录」：在侧边栏里采集小红书、微博帖文，用用户自备的大模型生成固定格式的中文舆情简报。

你接手任何任务，都按本文件的三个阶段工作。项目的长期事实与历史记录在 `.memory/` 目录。

## 一、开工前

1. 读 `.memory/context.md`：项目事实、模块地图、硬约束、开发约定。
2. 读 `.memory/backlog.md`：待办与已知问题。确认本次任务是否对应其中某一条。
3. 浏览 `.memory/tasks/` 里最近 2–3 份任务记录（文件名按日期排序）。
4. 本次要改的模块如果在 `.memory/decisions.md` 里有记录，先读相关条目。决策日志里明确否掉的方案，除非委托书要求，不要改回去。
5. 委托书与 `.memory` 内容冲突时，以委托书为准，并在任务记录里写明冲突点。

## 二、干活时

- `npm run check` 必须全部通过。测试是 `tests/*.cjs` 下的 Node 脚本，新行为要配新用例；改结构时改写旧用例，不要直接删掉覆盖点。
- 版本号：`manifest.json` 与 `package.json` 同步升级。新功能升次版本号（0.13.0 → 0.14.0），只修问题升修订号（0.13.0 → 0.13.1）。
- 行为变化要同步到 `README.md`；新增权限、新的网络请求或数据流向，要同步到 `PRIVACY_POLICY.md`，并在任务记录里附一段可直接粘贴到 Edge Partner Center 审核备注的说明。
- 提示词集中在 `prompts.js`。缓存键已包含生效提示词的哈希，改提示词不需要手动升任何版本常量。
- 不要在仓库里新建工作区目录。用 git worktree 时放到仓库外，或放在已被忽略的 `.worktrees/` 下。
- 提交信息沿用现有风格：一句中文说清改了什么，末尾括号注明版本号，例如「……（v0.13.1）」。

## 三、收工时（必做，没做完视为任务未完成）

1. 按 `.memory/tasks/_template.md` 新建任务记录：`.memory/tasks/YYYY-MM-DD-vX.Y.Z-简短英文slug.md`。这份记录就是交付说明，不要再另建 `DELIVERY.md`。
2. 更新 `.memory/backlog.md`：完成的条目移除，并在任务记录里注明关闭了哪一条；新发现的问题加进去。
3. 本次如果产生了用户确认过的设计决定，追加到 `.memory/decisions.md`。
4. `.memory/context.md` 里的事实如果变了（新模块、新消息、新约束、版本号），改写对应段落，保持它反映当前状态。不要往里追加流水账。
5. 在给用户的回复里写明任务记录的路径。
6. 纯样式或文案的小调整（无新行为、新约定、新权限），并入本次会话最近的任务记录，或与相邻小版本合并成一份记录（一个版本一行即可），不单独立档；任务记录和代码放在同一个提交里，不再单独提交「补充任务记录」。

## 写入 `.memory` 的规矩

- 用中文，简洁，写「是什么、为什么」。不复制大段代码或 diff，指向文件名和函数名即可。
- **禁止写入**：API Key、飞书 Webhook、签名密钥、App Secret、Cookie 值、用户个人信息，以及带 `xsec_token` 等参数的真实帖文链接。需要举例时只保留形态，例如 `xhslink.cn/o/<短码>`。
- `context.md` 控制在约 200 行以内，超出时精简旧内容，而不是截断。
- `decisions.md` 只记录用户确认过的决定。你自己的推测、建议和未决问题写进任务记录的「遗留问题」或 `backlog.md`。
- 用 UTF-8 无 BOM 写入。PowerShell 5.1 下要显式指定编码，例如 `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))`。

## 打包

扩展包里只能有运行所需的文件。用 `scripts/package.ps1` 打包：它按白名单复制文件后压缩，`manifest.json` 位于 zip 根目录。

运行（在仓库根目录）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1
```

产物为 `shuye-<版本号>.zip`，版本号从 `manifest.json` 读取。新增运行时文件时，同步更新脚本里的白名单。

- 进包：`manifest.json`、`panel.*`、`options.*`、运行时 `.js`（`prompts.js`、`ai-pipeline.js`、`service-worker.js`、`capture-common.js`、`content-script.js`、`weibo-content-script.js`、`main-world.js`）、`icons/`、`_locales/`（如存在）。
- 不进包：`AGENTS.md`、`.memory/`、`tests/`、`scripts/`、`README.md`、`PRIVACY_POLICY.md`、`package.json`、`.git*`、`.worktrees/`。

新增运行时文件时，同步更新白名单。
