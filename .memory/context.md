# 项目上下文

> 本文件反映项目**当前**状态。事实变化时改写对应段落，不追加流水账。
> 最近更新：2026-10-28（v0.14.0 结果可编辑与手动发送飞书）

## 产品概况

- 名称：薯页摘录。Chrome / Edge MV3 扩展，侧边栏形态（Chrome 114+ / Edge 116+）。
- 功能：采集小红书、微博帖文的正文、图片、视频字幕与前 50 条一级评论，调用用户自备的 OpenAI-compatible 模型（文字模型 + 图片模型，可同用一家），生成「★标题 + 一段正文 + 平台与链接」的固定格式舆情简报。
- 支持：单条概括、最多 5 条跨平台合并概括、已删帖文的截图识别、分享短链自动识别、概括历史（本机 100 条）、飞书自动推送。
- 发布：已提交 Microsoft Edge Add-ons（扩展 ID `hiafnpkhaeignkaealneapnangmbjedj`），Chrome Web Store 在 Edge 之后再做。
- 当前版本：0.14.0。0.14.0 之前的演进见 `git log`。

## 硬约束（合规与商店）

- 不内置任何 API Key，模型 Key 由用户自行填写。
- `host_permissions` 只列必要域名，不用 `<all_urls>`。模型 API 域名走 `optional_host_permissions`，保存或测试设置时按需申请。
- 产品主名称不使用「小红书」「Xiaohongshu」，避免商标问题。
- 商店描述要回应单一用途政策。
- `PRIVACY_POLICY.md` 必须如实披露所有数据流向：模型 API、飞书、xhslink.cn 短链解析。
- 只读取小红书 `web_session`、微博 `SUB` Cookie 是否存在，用于登录前置检查，不读取、不保存、不传出 Cookie 值。小红书不调用未公开接口。

## 模块地图

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 权限、侧边栏、设置页声明 |
| `panel.html` / `panel.css` / `panel.js` | 侧边栏：当前帖文、添加素材、清单、结果四区块，历史屏，任务条 |
| `options.html` / `options.css` / `options.js` | 设置页：模型配置与测试、飞书推送、密钥存储模式、概括提示词自定义 |
| `service-worker.js` | 后台：消息路由、配置与密钥、缓存、工作流状态、合并清单、历史、飞书推送、短链解析与补链接 |
| `ai-pipeline.js` | 模型调用、证据构建、图片识别、文字概括、截图识别、结果渲染、缓存键 |
| `prompts.js` | 全部内置提示词 |
| `capture-common.js` | 两平台共享的采集工作流与内容脚本消息协议 |
| `content-script.js` | 小红书采集（含视频字幕与截帧） |
| `main-world.js` | 注入页面主世界，读取小红书 `__INITIAL_STATE__` |
| `weibo-content-script.js` | 微博采集，走页面同源 `/ajax/` 接口 |
| `tests/*.cjs` | Node 测试脚本，由 `npm run check` 统一运行 |
| `scripts/package.ps1` | 白名单打包为 `shuye-<版本号>.zip`，manifest 在 zip 根目录 |
| `.memory/` | 项目上下文、决策日志、待办、任务记录；不进入扩展包 |

## 核心数据流

1. **单条**：面板注入采集脚本 → 内容脚本采集，同时后台并行识别图片 → 后台调用文字模型 → `renderSummary` 拼出最终文本 → 写历史、推送飞书。
2. **合并**：清单条目的 payload 存在 `chrome.storage.session`，合并时按发帖时间排序后一次性交给文字模型，再由 `renderMergedSummary` 渲染。
3. **截图**：图片模型把截图抄录成结构化 JSON → `buildScreenshotPayload` 组装成与网页采集同 schema 的 payload → 复用单条或合并管线。
4. **链接**：`XHS_AI_RESOLVE_LINK` 把链接解析为「平台 + 帖子 ID」→ 与当前页签、清单条目比对 → 命中就补链接，没命中就开新页签采集，解析失败就让用户手动选择。

## 关键约定（改代码前必读）

- **程序写，模型不写**：结果里的日期、互动数、来源链接都由程序渲染，不交给模型生成。
- **链接只写 `source.givenUrl`**，永远不改 `source.url`。`source.url` 会进入证据和缓存键，改了会触发重新调用模型。
- **补链接不调用模型、不重推飞书**：用结果里已有的 `structured` 重新渲染，并按 `historyId` 同步历史。合并结果只有在条目集合（`itemIds`）未变时才原地重渲染。
- **任务进行中补链接**：面板先写槽位 `pendingGivenUrl`，任务完成后再 `XHS_AI_RELINK`；后台 `relinkResult` 遇到 `working` 或 pageSession 不一致时不改写工作流状态。
- **合并结果找回**：`mergeSlot.result` 在切换焦点后通过清单区入口恢复；清单条目集合与 `itemIds` 不一致时入口和来源标签标为「上次合并」。
- **当前帖文区只显示平台徽标**：提取到的标题/正文只进入结果卡，不在“当前帖文”按钮上方重复渲染。
- **结果链接行内编辑**：点 ✎ 后原链接文本直接变成输入框，保存/取消与链接同一行，不另起编辑框。
- **结果动作同排**：复制、加入清单和重新生成在同一行；重新生成是圆形返回箭头图标，`title` 悬停提示“重新生成”。配置飞书后追加飞书发送图标。
- **结果可编辑**：结果框可改，改动写入当前结果对象的 `text`（会话内有效，不写历史存储）；复制和手动飞书发送都取框内当前文本。
- **手动发送飞书**：`XHS_AI_GET_FEISHU_STATUS` 决定图标是否显示，`XHS_AI_SEND_FEISHU` 发送当前编辑文本；未配置时不显示图标。
- **提示词**：全部集中在 `prompts.js`。用户可在设置页覆盖（`xhsAiConfig.promptOverrides`）。缓存键含生效提示词的哈希，改提示词自动失效旧缓存。输出 JSON 字段名与 `ai-pipeline.js` 的解析代码绑定，改字段名要同步改解析。
- **图片与文字分开调用**：图片模型只负责如实描述与 OCR，内容是否有增量、是否写进概括，由文字模型判断。合并调用对图片多的帖文太慢，因此分开。
- **提示词修改原则**：最小干预。先移除诱因，再考虑加约束；尽量不写明确禁令；每次只改一处并单独测试。通过书面规则修正，不加 few-shot 示例。
- **缓存**：`chrome.storage.session` 的 `xhsAiCacheV1`，只保留最近 16 条，被淘汰后会重新识别或生成。
- **清单**：上限 5 条，会话存储，关闭浏览器即清空。条目 ID 为 `note:<id>`、`wbnote:<id>` 或 `shot:<id>`，同 ID 重复加入会替换。
- **历史**：`chrome.storage.local`，最多 100 条，只存概括全文与元信息，不存评论和图片证据。
- **消息来源校验**：`EXTENSION_PAGE_MESSAGES` 只接受插件页面发出的消息，内容脚本消息只接受来自帖文页的。新增消息要加入对应集合。
- **帖子 ID**：小红书为 24 位十六进制，取自 `/explore/<id>` 或 `/discovery/item/<id>`。微博为 `mblogid`；URL 路径是纯数字 mid 时视为无法解析。
- **短链**：只支持 `xhslink.cn`。后台解析时不携带登录信息（`credentials: "omit"`），实测落到登录页，帖子 ID 在 `redirectPath` 参数里。

## 开发环境

- 用户在 Windows 上开发，用 PowerShell。PowerShell 不支持反斜杠续行，命令要写成单行。
- 检查：`npm run check`（语法检查加全部测试）。
- 打包：`scripts/package.ps1`，按白名单打包，见 `AGENTS.md`。
- 分工：用户与 Claude 讨论设计、写委托书、验收；具体实现交给编程 AI。

## Edge 商店经验

- 商店列表的语言由扩展的 `_locales` 决定，不是 Partner Center 里的设置。没有 `_locales` 时，中文文案放在 en-US 栏位，中国用户也能正常看到。
- 上架市场和列表语言是分开设置的。
- 上传包、填完列表不等于发布，必须手动点「发布」。
- 审核备注要说明：需要打开小红书页面才能使用、需要用户自备 API Key，以及每项新增权限的用途。
