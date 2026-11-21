# 项目上下文

> 本文件反映项目**当前**状态。事实变化时改写对应段落，不追加流水账。
> 最近更新：2026-11-21（v0.22.0 新增自动化入口 agent-api.js）

## 产品概况

- 名称：薯页摘录。Chrome / Edge MV3 扩展，侧边栏形态（Chrome 114+ / Edge 116+）。
- 功能：采集小红书、微博帖文的正文、图片、视频字幕与前 50 条一级评论，调用用户自备的 OpenAI-compatible 模型（默认文字与图片共用一个模型、只填一份 Key，可在设置里分开配置），生成「★标题 + 一段正文 + 平台与链接」的固定格式舆情简报。
- 支持：单条概括、最多 5 条跨平台合并概括、已删帖文的截图识别、分享短链自动识别、概括历史（本机 100 条）、飞书自动推送、可选的截图存档（帖文页截图与配图存到用户自选文件夹）。
- 发布：已上架 Microsoft Edge Add-ons（扩展 ID `hiafnpkhaeignkaealneapnangmbjedj`）与 Chrome Web Store。
- 当前版本：0.22.0。更早的演进见 `git log`。

## 硬约束（合规与商店）

- 不内置任何 API Key，模型 Key 由用户自行填写。
- `host_permissions` 只列必要域名，不用 `<all_urls>`。模型 API 域名走 `optional_host_permissions`，保存或测试设置时按需申请。`<all_urls>` 只作为可选权限，用户开启截图存档时才申请（`captureVisibleTab` 只认它或 activeTab）。`declarativeNetRequestWithHostAccess` 只用于给扩展自己的 `*.sinaimg.cn` 图片请求补 `Referer`（规则 `initiatorDomains` 限扩展 ID），依赖已声明的 host_permissions，不新增用户可见的权限提示。
- 产品主名称不使用「小红书」「Xiaohongshu」，避免商标问题。
- 商店描述要回应单一用途政策。
- `PRIVACY_POLICY.md` 必须如实披露所有数据流向：模型 API、飞书、xhslink.cn 短链解析。
- 只读取小红书 `web_session`、微博 `SUB` Cookie 是否存在，用于登录前置检查，不读取、不保存、不传出 Cookie 值。小红书不调用未公开接口。

## 模块地图

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 权限、侧边栏、设置页声明 |
| `panel.html` / `panel.css` / `panel.js` | 侧边栏：当前帖文、添加素材、合并概括、结果四区块，历史屏，任务条 |
| `options.html` / `options.css` / `options.js` | 设置页：模型配置（共用 / 分开）与测试、飞书推送、截图存档开关与存放文件夹、密钥存储模式、概括提示词自定义 |
| `archive.js` | 截图存档：初始屏与评论区长截图（截取、拼接）、配图下载、写入 / 删除存档文件夹、存档索引；侧边栏与设置页共用 |
| `media-access.js` | 微博图床防盗链：`declarativeNetRequest` 动态规则只给本扩展自己发起的 `*.sinaimg.cn` 请求补 `Referer`；侧边栏与后台在图片 fetch 前 `await ensureWeiboMediaReferer()`（设置页不取图，不需要） |
| `service-worker.js` | 后台：消息路由、配置与密钥、缓存、工作流状态、合并清单、历史、飞书推送、短链解析与补链接 |
| `agent-api.js` | 自动化入口 `globalThis.SHUYE_AGENT_API`（`ping` / `captureTab`）：供带调试端口的专用浏览器经 CDP 在后台调用，复用单条管线，可关本次飞书推送；不注册消息、不对外开放 |
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

1. **单条**：面板注入采集脚本 → 内容脚本采集，同时后台并行识别图片 → 后台调用文字模型 → `renderSummary` 拼出最终文本 → 写历史 → 若面板还有比本次 `givenUrl` 更新的待补链接，先记 `notification = { status: "deferred" }`、不推送，否则立即推送飞书 → 面板完成 relink 后用最终文本调 `XHS_AI_NOTIFY_FEISHU_RESULT` 补发一次。
2. **合并**：清单条目的 payload 存在 `chrome.storage.session`，合并时按发帖时间排序后一次性交给文字模型，再由 `renderMergedSummary` 渲染；运行中改过清单链接时同样先 deferred，面板按当前清单原地重渲染后再推送一次。
3. **截图**：普通截图以原始文件、原始尺寸、原始格式上传；长截图（高度超过宽度 ×2.5 或高度超过 4096 像素）在面板暂存时按原分辨率带重叠切段（单张最多 20 段；PNG 源仍出 PNG，JPEG / WebP 转高质量 JPEG），段间重叠交给截图提示词已有的「多张按顺序拼接、去掉重叠」规则；单边超过 4096 的段或截图等比缩小，不提示用户。切段后的一批受源文件单张 12 MB、本批 data URL 总长 32 MB、单次最多 20 张限制，识别超时随张数放宽（`screenshotTimeoutMs`，最多 240 秒） → 图片模型把截图抄录成结构化 JSON → `buildScreenshotPayload` 组装成与网页采集同 schema 的 payload（相对时间复用 `resolvePublishedDate` 以识别时刻即上传当天换算）→ 复用单条或合并管线。提交截图时面板只带暂存卡上挂着的链接（`stagedShotLink`，随消息 `sourceUrl` 带入，落到 payload 的 `source.url`），不再从输入框顺带读取；微博链接挂不上（截图管线只覆盖小红书）。
4. **链接**：`XHS_AI_RESOLVE_LINK` 把链接解析为「平台 + 帖子 ID」→ 与当前页签、清单条目比对 → 命中就补链接，没命中就开新页签采集，解析失败就让用户手动选择。新页签只在 `detailReady`（标题渲染）后就开采集，因此小红书采集端自带就绪等待（`content-script.js` 的 `TIMING`，测试可用 `__XHS_CAPTURE_TIMING__` 缩短）：互动数或评论总数出现才继续，评论区挂载与首条评论各有等待上限；「共 0 条评论」立即结束，超时记 `comment_load_timeout` 并向 `uncertainties` 写「评论未能读取」。
6. **自动化**（v0.22.0）：本机 Agent 经 CDP 在后台调用 `SHUYE_AGENT_API.captureTab` → 注入采集脚本、等 `detailReady` → `XHS_CAPTURE_AND_SUMMARIZE`，与面板单条流程相同；`notify: false` 时把页签记入静默集合，`summarizePagePayload` 传 `skipNotify` 跳过飞书（不查询面板待补链接）。
5. **存档**（设置开启时）：面板发采集消息带 `options.archive` 并登记 tabId → pageSessionId。小红书边加载边截：`content-script.js` 加载评论前发 `XHS_ARCHIVE_FRAME` start（面板滚到顶截初始屏，兼作第一帧），每滚一步、等过新评论后发 frame（面板原地截一帧并记锚点），收尾在恢复滚动位置前发 end（面板按锚点丢掉错位帧、补截缺口，回复后再拼接）；每步都等面板回复才继续，面板不回或出错就停止请求、评论照常加载。采集完发 `XHS_ARCHIVE_PAGE_READY`（含 payload）后照常进入概括；面板只响应自己登记过的页签，有边加载边截的结果就直接用，否则（微博、或没能启动）排队单独滚一遍截图（与模型调用并行）→ 采集响应后下载配图 → 有了概括记录（单条完成 / 合并完成按 `captureKeys` / 重新生成）才写入 `<存放文件夹>/<时间_平台_标题_ID尾>/` → 索引记 `historyIds`。加入清单与概括失败的存档在内存里等待（`awaiting-summary`），移出或清空清单即丢弃。

## 关键约定（改代码前必读）

- **程序写，模型不写**：结果里的日期、互动数、来源链接都由程序渲染，不交给模型生成。
- **链接只写 `source.givenUrl`**，永远不改 `source.url`。`source.url` 会进入证据和缓存键，改了会触发重新调用模型。例外是截图 payload 的**创建时**：暂存卡上挂着的链接经 `XHS_AI_SCREENSHOT_RECOGNIZE`/`_ADD` 的 `sourceUrl` 字段写入 `source.url`（先于任何模型调用，无缓存失效问题）；事后补链接（含识别期间才选定的链接，落地后走 `XHS_AI_MERGE_SET_LINK`）仍只写 `givenUrl`。
- **补链接不调用模型、不自动重复推送**：用结果里已有的 `structured` 重新渲染，并按 `historyId` 同步历史。合并结果只有在条目集合（`itemIds`）未变时才原地重渲染。生成进行中贴入的待补链接会延迟推送：后台先记 `notification = { status: "deferred" }`，面板 relink 后调 `XHS_AI_NOTIFY_FEISHU_RESULT` 用最终文本补发，一次生成仍只有一条消息；已经发送过之后再补链接/编辑不自动重发，结果卡显示「飞书里仍是旧版本」+ 飞书图标红点，点图标重发当前文本。结果对象带 `renderedText`（程序最后一次渲染的干净文本），后台按 `text !== renderedText` 判断是否被手工编辑；编辑过就只替换来源后缀或旧链接，两者都找不到时保持用户文本并返回 `linkApplied: "kept"`，不整段覆盖。历史始终写干净的重渲染文本。
- **飞书发送状态**：`notification.status` 为 `sent | failed | deferred`；成功时带 `sentText`（实际发送的文本），用于判断结果卡/历史里是否还是旧版本。后台推送前用 `XHS_AI_QUERY_PENDING_LINK` 向面板同步查询待补链接（面板有 pending 就答 true，即使已切走；无 pending 时只有 `activeTabId` 匹配才答 false，避免多窗口里非属主抢先答 false；合并任务只由运行它的面板应答），延迟补发走 `XHS_AI_NOTIFY_FEISHU_RESULT`。补发期间按 `historyId` 记录在途，点图标提示“正在推送飞书，请稍候”，避免第二条；更新历史与工作流快照里的 `notification` 时不广播 `XHS_AI_WORKFLOW_STATE`，避免覆盖面板当前编辑。
- **任务进行中补链接**：面板先写槽位 `pendingGivenUrl`，任务完成后再 `XHS_AI_RELINK`；后台 `relinkResult` 遇到 `working` 或 pageSession 不一致时不改写工作流状态。
- **合并结果找回**：`mergeSlot.result` 在切换焦点后通过合并概括区入口恢复；清单条目集合与 `itemIds` 不一致时入口和来源标签标为「上次合并」。
- **当前帖文区只显示平台徽标**：提取到的标题/正文只进入结果卡，不在“当前帖文”按钮上方重复渲染。
- **当前帖文跟随页签地址**：`activeTabUrl` 由面板打开、`tabs.onActivated`、`tabs.onUpdated`（页签内跳转、刷新、前进后退）与窗口焦点变化更新；地址变化统一走 `syncActiveTabUrl()`——仍停在同一篇帖文（如地址补了 `xsec_token`）保留旧结果，换了帖子或离开帖文页清槽位（页签任务进行中不清）。两个按钮置灰即表示「当前不是帖文页」，新增地址来源时要同步这里，否则会一直按旧地址判断。
- **平台徽标统一**：徽标出现的所有位置（当前帖文、任务条、合并概括区、历史列表），小红书一律显示「小红书」+ 主题红（`merge-badge-xhs`），微博橙、截图绿、合并黑；不再用「网页」通称。
- **结果链接行内编辑**：保存前先经 `extractPostUrl` 提取（与素材输入框一致），粘整段文字不会把全角括号带进链接。点 ✎ 后原链接文本直接变成输入框，保存/取消是行内对勾与叉号图标，悬停分别提示“保存链接”“取消编辑”，不另起编辑框。
- **结果动作同排**：复制、加入合并和重新生成在同一行；重新生成是圆形返回箭头图标，`title` 悬停提示“重新生成”。配置飞书后追加飞书发送图标。
- **结果可编辑**：结果框可改，改动写入当前结果对象的 `text`（会话内有效，不写历史存储）；复制和手动飞书发送都取框内当前文本。输入时实时刷新「飞书里仍是旧版本」提示与图标红点，改回已发送文本则标记消失。
- **手动发送飞书**：`XHS_AI_GET_FEISHU_STATUS` 决定图标是否显示，`XHS_AI_SEND_FEISHU` 发送当前编辑文本并带 `historyId` / `tabId` + `pageSessionId`，后台把 `sentText` 写回历史与工作流快照；未配置时不显示图标。已经推送过的结果不会因为文本变化自动补发。
- **提示词**：全部集中在 `prompts.js`。用户可在设置页覆盖（`xhsAiConfig.promptOverrides`）。缓存键含生效提示词的哈希，改提示词自动失效旧缓存。输出 JSON 字段名与 `ai-pipeline.js` 的解析代码绑定，改字段名要同步改解析。
- **模型共用 / 分开**：`xhsAiConfig.modelMode` 为 `shared`（默认）或 `split`，`text`、`vision` 两组设置都保存。所有调模型的入口经 `ai-pipeline.js` 的 `resolveModels` 取生效配置与 Key：共用时 vision 取 text 那组、图片 Key 即文字 Key；分开时图片 Key 留空只在两边 API 同 origin 时沿用文字 Key，跨域名绝不沿用。新增调模型的入口必须走它，不要直接读 `config.vision` / `secrets.visionApiKey`。共用模式不校验保存着的 vision。旧配置无 `modelMode` 时按「地址与模型都相同 → shared」推断。设置页「测试模型」在共用模式发 `provider: shared`，会附一张内置纯红小图，回答没有「红 / red」也判为不能看图。内置图在 `ai-pipeline.js` 的 `VISION_TEST_IMAGE`，`tests/service-worker.test.cjs` 会按 PNG 规范真解码并校验纯红，换图必须先确认是有效 PNG（v0.17.0–v0.21.3 内嵌的坏图让 DeepSeek 回「invalid image … corrupted」，能看图的模型也被判成不支持）。
- **图片与文字分开调用**：图片模型只负责如实描述与 OCR，内容是否有增量、是否写进概括，由文字模型判断。合并调用对图片多的帖文太慢，因此分开。图片模型给的 `summary_value` 只用来筛无字的无关配图：`selectVisionEvidence` 对判成 `none` 但有 `visible_text` 的图照样放行（画面描述已被 `normalizeVisionItem` 清空，只带 OCR 文字）。复述标题的文字卡片常被判成 `none`，v0.21.4 及以前会把卡片里的学校简称一起丢掉（北理国补帖）。写作提示词（单帖 `TEXT_SYSTEM`）把图片证据当作这条帖文本身的一部分：只并入多出来的信息，与标题、正文意思相同的不再复述、不交代出自图片；旧说法「图片证据是正文的补充」会让模型另起半句「所附文字同样在问……」。合并提示词的图片规则未改。
- **长截图自动切段**：`panel.js` 的 `stageScreenshotFiles` 用 `createImageBitmap` 读原始尺寸，高度超过宽度 2.5 倍或超过 4096 像素时按原分辨率切段（`planScreenshotSlices`，目标段高 = 宽 × 2.5 且不超过 4096，段间 8% 重叠、单张最多 20 段），内部暂存项带 `partIndex` / `partCount` / `groupId`；界面按原截图单卡显示（`stagedScreenshotGroups`），角标标注「长图 · N 段」，点这张卡片的移除按钮按 `groupId` 整组删除，避免只删中间段。每段带 `outputWidth` / `outputHeight`：段数封顶后仍超 4096，或宽度超过 4096（不够长时返回单段），都等比缩到 4096 以内，不提示用户。4096 来自 DeepSeek「一次 15 张及以上时单边上限从 8192 降到 4096」，暂存时不知道本批张数，所以一律按 4096；模型推理前本来就缩到约 1300×1300 总像素，这一步缩小不损失信息。两边都不超过 4096 的普通截图不转码。切段后的张数计入后台 `MAX_SCREENSHOT_IMAGES = 20`，面板 `SCREENSHOT_BATCH_LIMIT` 必须与它同步（测试里有断言）。截图识别出的评论只保留前 50 条（`normalizeScreenshotExtraction`），超出部分静默丢弃，用户确认不提示。
- **截图证据对齐网页帖**：截图帖文的配图文字（`note.imageText`）与画面描述（`note.imageDescription`，截图模型字段 `image_description`）不直接进证据，由 `buildEvidence` 合成一条与图片模型输出同结构的 `imageEvidence` 条目，分别落在 `visible_text` / `factual_description`（只在证据内部，不进图片识别缓存）；只有标题的视频帖缺了画面描述时，文字模型会拿话题标签和「正文未说明……」凑正文，写作规则只在提示词维护一处。截图相对时间按上传当天换算，换算提示由 `screenshotDateNotice` 随识别响应返回。
- **日期行拆属地**：`content-script.js` 的 `splitPublishedAndLocation` 只在末段不含数字、不是相对时间时才当 IP 属地拆走；页面不显示属地时日期行只有「编辑于 10-13」，旧逻辑会把日期当属地，概括丢日期。
- **涉事主体全称**：帖文简称或话题标签本身能定全称时直接写全称、不写依据句；只有借评论区线索认定才交代依据。`prompts.js` 的 `SUBJECT_RULE` 由单帖与合并提示词共用，要求帖文只写代称或简称时结合评论区查明全称；发帖人回复「对」「是」算确认，对列选项的追问回复数字算选中对应序号；发帖人确认，或线索足以认定（发帖人透露的校区、类型指向唯一主体，或与网民点名吻合且未否认）才写进标题正文，正文交代依据且线索认定不能写成「发帖人确认」；仅网民猜测时保留代称、猜测写进 opinion_points。opinion_points 字段规则另有一句「已认定的不再单列猜测」——写在字段规则里模型才听。依赖证据里评论回复挂在父评论下并带 `isAuthor`（`compactComment`），改评论证据结构时别丢。
- **正文不写的内容**：话题标签、证据缺了什么、其他网民评论都不进 event_summary。光靠提示词禁令压不住（帖文只有一句标题时模型会拿这些凑字），所以 `buildEvidence` 在数据旁写用途：标签放在 `note.topicTags = { usage, tags }`，评论前紧挨一条 `commentsUsage`（文案在 `prompts.js` 的 `topicTagsUsage` / `commentsUsage`）。评论必须留在原位——挪到证据末尾实测会让模型把线索认定误写成「发帖人确认」。提示词侧另有单列的「event_summary 里不写三类内容」与「谁何时何地，缺的要素直接略过」。
- **提示词修改原则**：最小干预。先移除诱因，再考虑加约束；尽量不写明确禁令；每次只改一处并单独测试。通过书面规则修正，不加 few-shot 示例。
- **缓存**：`chrome.storage.session` 的 `xhsAiCacheV1`，只保留最近 16 条，被淘汰后会重新识别或生成。
- **清单（界面叫「合并概括」）**：代码里仍叫 basket / 清单，用户可见文案一律按用途叫「合并概括」「加入合并」「✓ 已在合并里」，不再出现「清单」二字。上限 5 条，会话存储，关闭浏览器即清空。条目 ID 为 `note:<id>`、`wbnote:<id>` 或 `shot:<id>`，同 ID 重复加入会替换。合并概括区常驻：为空时 `#basket-panel[data-empty="true"]` 收成标题 + 一句用途说明（`BASKET_HINT_EMPTY`），有条目后换成 `BASKET_HINT_FILLED`。当前帖文与结果卡的「加入合并」在该帖已在合并里时都显示「✓ 已在合并里」并置灰（`refreshButtons` / `refreshResultBasketButton`，`renderBasket` 末尾会调 `refreshButtons` 同步）。
- **截图原帖链接挂在暂存卡上**：暂存区有截图时，素材输入框一出现小红书链接（`input` 事件，含粘贴），或加完截图时输入框里已有链接，`maybeOfferShotLink` 就用链接选择区问「下面这组截图的原帖链接 / 另一条帖文，识别它」（`pendingLinkChoice.mode = "shot"`）；回车或「识别链接」在此状态下也先问、不解析。截图帖文没有帖子 ID，程序无从比对，所以只能让用户说，不按「同时摆着」去猜。截图全部移除时链接放回输入框。识别后才拿到的链接：解析出的 ID 对不上任何帖文、又有没链接的截图条目（含识别中的批次）时，`handleMaterialLink` 列出它们让用户选（`mode = "attach"`），不直接当新帖打开。
- **截图加入合并的占位条目**：「识别并加入合并」点下去就把暂存截图搬进 `pendingShots`（面板内存，后台不知道），在合并概括末尾渲染「识别中…」条目，暂存区立刻清空；每批一个任务 `shot:merge:<pendingId>`，可并行。成功后后台返回新条目 `id`，识别期间才选定的链接用它补写；失败的条目可重试、放回暂存区或丢弃。有占位条目时合并按钮置灰（`refreshButtons` 与 `runMergeSummarize` 都判断 `pendingShots.length`），条数与 5 条名额都算上识别中的批次（面板 `MERGE_ITEM_LIMIT` 必须等于后台 `MAX_MERGE_ITEMS`，有测试断言）。后台合并条目的增删改都经 `withMergeBasketLock` 串行，避免并行识别完一起落地时读-改-写互相覆盖；测试的存储 mock 返回拷贝，才测得出这种覆盖。
- **历史**：`chrome.storage.local`，最多 100 条，只存概括全文与元信息，不存评论和图片证据。
- **截图存档**：一份存档对应一次采集，键为 `平台|帖子ID或shot-截图ID|exportedAt`（`archive.js` 的 `captureKey` 与 `service-worker.js` 的 `archiveCaptureKey` 同格式，测试对齐）。设置 `xhsAiArchiveSettingsV1`、索引 `xhsAiArchiveIndexV1`（`folder`、`key`、`files`、`historyIds`）、目录句柄在 IndexedDB `shuye-archive`。重新生成复用同一存档、只追加 historyId；合并结果带 `captureKeys` 关联各帖存档。存档只在有概括记录时写入（`flushArchiveJob` 无 historyId 时只置 `awaiting-summary`），因此索引里每个文件夹都至少关联过一条历史；删除历史按 `foldersToRelease` 只删不再被现存记录引用的文件夹；自动淘汰不删。微博评论区截图 10 屏封顶。截图只截前台页签，每屏前后都查 `tabs.get().active`，切走即停（不要放宽，否则会把别的页面存进存档）。文件夹授权必须在用户点击当下申请（`primeArchiveFolder`），浏览器重启后会再要一次。小红书截「真正在滚的区域」：宽窗口是 `.note-scroller` 自己，窗口变窄帖文上下排列后 `.note-scroller` 不再滚动，滚的是外层弹层或页面——`content-script.js` 的 `resolveCommentScroller` 与 `archive.js` 页面函数里的 `resolveXhs` 用同一规则找它（页面函数必须自包含，`resolveXhs` 在四个页面函数里各有一份，改时要一起改）；截取区域横向取帖文那一栏、纵向取滚动区域在屏幕上看得见的部分，弹层自带的顶栏底栏靠 `elementFromPoint` 命中测试排除。拼接时截取位置超出画面直接报错，不再拼出空白图。微博靠 `.wbpro-tab3` + `article` 定位正文栏。
- **微博图床防盗链**：`*.sinaimg.cn` 对带浏览器 UA、但没有 `weibo.com` Referer 的请求返回 403。扩展页面与后台发起的 fetch 不带 Referer，`fetch` 的 `referrer` 选项与 `XHR.setRequestHeader("Referer")` 都会被浏览器丢掉，只能用 `media-access.js` 的 `declarativeNetRequest` 动态规则补（`initiatorDomains` 用 `chrome.runtime.id`，只改本扩展自己的请求）。`archive.js` 的 `collectMediaFiles` 与 `ai-pipeline.js` 的 `imageToDataUrl` 在 fetch 前都 await 规则就绪；以后新增读取平台图片的入口也要先 await，否则微博配图会静默失败（图片识别失败只降级为纯文字概括，界面上看不出来）。
- **消息来源校验**：`EXTENSION_PAGE_MESSAGES` 只接受插件页面发出的消息，内容脚本消息只接受来自帖文页的。新增消息要加入对应集合。`XHS_ARCHIVE_PAGE_READY` 与 `XHS_ARCHIVE_FRAME` 由面板直接接收（后台不处理），面板按发送页签与登记的 pageSessionId 校验；`XHS_ARCHIVE_FRAME` 只有发起采集的面板才回复（异步 sendResponse），其他面板不回。
- **帖子 ID**：小红书为 24 位十六进制，取自 `/explore/<id>` 或 `/discovery/item/<id>`。微博为 `mblogid`；URL 路径是纯数字 mid 时视为无法解析。
- **短链**：只支持 `xhslink.cn`。后台解析时不携带登录信息（`credentials: "omit"`），实测落到登录页，帖子 ID 在 `redirectPath` 参数里。

## 开发环境

- 用户在 Windows 上开发，用 PowerShell。PowerShell 不支持反斜杠续行，命令要写成单行。
- 检查：`npm run check`（语法检查加全部测试，含 `tests/package.test.cjs` 的打包白名单防漏）。
- 打包：`scripts/package.ps1`，按白名单打包，见 `AGENTS.md`。
- 分工：用户与 Claude 讨论设计、写委托书、验收；具体实现交给编程 AI。

## 商店上架经验

- 商店列表的语言由扩展的 `_locales` 决定，不是 Partner Center 里的设置。没有 `_locales` 时，中文文案放在 en-US 栏位，中国用户也能正常看到。
- 上架市场和列表语言是分开设置的。
- 上传包、填完列表不等于发布，必须手动点「发布」。
- 审核备注要说明：需要打开小红书页面才能使用、需要用户自备 API Key，以及每项新增权限的用途。
