# 薯页摘录 0.13.0 交付说明

- 仓库：`monika2333/xiaohongshu_plugin`
- 基线：`016e234`（manifest 0.12.1）
- Worktree：`.worktrees/sidebar-unified`
- 分支：`feature/sidebar-unified`
- 版本：manifest / package.json 均为 `0.13.0`
- 检查：`npm run check` 全部通过

## 1. 改动摘要

| 文件 | 改动 |
| --- | --- |
| `panel.html` | 删除 `.view-tabs`、单条/多条视图、旧链接与截图入口；重写为「当前帖文 / 添加素材 / 清单 / 结果」四个区块。结果卡新增来源标签、原帖链接行、加清单按钮；新增链接归属选择列表与清单链接编辑器。 |
| `panel.css` | 删除页签样式；补充当前帖文动作区、统一素材区、清单链接行、原地链接编辑、结果链接行等样式，沿用原有纸张/红黑视觉语言。 |
| `panel.js` | 用 `focus = {kind:"tab"|"shot"|"merge"}` 取代 `currentView/singleFocus/mergeFocus`；截图暂存合并为一份数组；保留并行任务、页签槽位、历史屏、截图压缩与现有工作流。新增链接解析/归位、结果与清单补链接、链接选择列表、两路「加入清单」。 |
| `service-worker.js` | 新增 `XHS_AI_RESOLVE_LINK`、`XHS_AI_RELINK`、`XHS_AI_MERGE_SET_LINK`、`XHS_AI_MERGE_RERENDER`；历史 ID 先写入结果再落历史；合并结果记录 `itemIds`；清单摘要补充 `link/linkVerified`；短链解析按路径 → 查询参数 → og:url/canonical。 |
| `manifest.json` | 新增 `https://xhslink.cn/*` 与 `https://*.xhslink.cn/*` host 权限；版本 0.13.0。 |
| `package.json` | 版本 0.13.0。 |
| `README.md` | 把「两种概括视图与截图识别」重写为「统一工作区与截图识别」，补充链接自动识别、补链接与截图单入口用法；数据章节补充短链网络请求与补链接不调用模型。 |
| `PRIVACY_POLICY.md` | 补充短链 URL、解析时读取的 `og:url`/`canonical`、不携带登录信息且不保存页面正文；更新日期，新增 4.2 节并顺延编号。 |
| `tests/panel.test.cjs` | 按新结构重写面板测试，覆盖焦点规则、并行页签与合并、加入清单两条路径、链接归位四类分支、选择列表、结果/清单补链接、清空链接、截图单入口与历史屏。 |
| `tests/panel-login.test.cjs` | 选择器同步到新 DOM；登录前置检查覆盖保持不变。 |
| `tests/service-worker.test.cjs` | 新增四个后台消息用例；短链桩覆盖路径 ID、查询参数、双层编码参数、og:url、全部失败与超时；断言换链接/合并重渲染时模型 `fetch` 调用为 0；补充版本与 xhslink 权限断言。 |

未改动：`prompts.js`、`ai-pipeline.js`、`content-script.js`、`weibo-content-script.js`、`capture-common.js`、提示词、缓存键算法、采集逻辑、飞书推送、历史/设置行为。

## 2. 短链实测结果

实测时间：2026-10-28，本机匿名网络，未登录小红书。

真实短链：

`https://xhslink.cn/o/AxnRePgIokn`

观察到的跳转：

```text
302 / 跟随重定向后最终地址：
https://www.xiaohongshu.com/login?redirectPath=http%3A%2F%2Fwww.xiaohongshu.com
  %2Fdiscovery%2Fitem%2F6a9d0eb2000000002a024480%3Fapp_platform%3Dios
  %26app_version%3D9.45%26type%3Dnormal%26xsec_token%3DCB7rCz...%26...
```

- 最终路径是 `/login`，不是 `/discovery/item/<id>`；
- 帖文 ID `6a9d0eb2000000002a024480` 只出现在 `redirectPath` 查询参数里；
- 响应 HTML 里没有 `og:url`，也没有 `<link rel="canonical">`；
- 用实际 `service-worker.js` 的 `resolveLink()` 调用，返回：

```json
{
  "ok": true,
  "platform": "xiaohongshu",
  "noteId": "6a9d0eb2000000002a024480",
  "resolvedUrl": "https://www.xiaohongshu.com/login?redirectPath=..."
}
```

- 已登录情况：后台请求固定使用 `credentials: "omit"`，不会携带用户的小红书会话，因此浏览器是否登录不会改变该请求的跳转形态；实际仍会以匿名状态落到登录页，再由 `redirectPath` 取 ID。该结论来自请求设计 + 本次匿名实测，未用真实登录态浏览器复测。
- 风控情况：未实测到风控页。规则对登录页/404 页的 `redirectPath`、以及 404 页把 `redirectPath` 再嵌进 `source` 参数的双层编码都做了处理；本次另用 404 页形态做了桩测试。
- 顺带观察：旧分享域名 `xhslink.com` 的样例会落到 `/404?source=...redirectPath=...` 且可解析出 ID，但委托书只要求 `xhslink.cn`，本次未加入 `.com` 支持。

若需要补齐登录态/风控样例，请提供：

1. 已登录小红书浏览器里复制的一条 `xhslink.cn` 分享短链；
2. 一条会在当前网络环境触发风控或登录失效的短链；
3. 若希望支持旧分享域名，再提供一条 `xhslink.com` 短链。

## 3. Edge Partner Center 审核备注（可直接粘贴）

> 本扩展新增 `https://xhslink.cn/*` 主机权限，仅用于解析用户主动粘贴的小红书分享短链。用户粘贴短链并点击“识别链接”时，扩展后台会向 xhslink.cn 发起一次不携带登录信息（credentials: “omit”）的请求，跟随跳转后只读取最终地址、地址中的跳转参数，以及落地页的 `og:url` / `canonical` 元信息，以确定该短链对应的小红书帖子并补到用户已有的概括素材上。该请求不会读取或保存页面正文，不会上传任何数据，也不会在后台自动发起；不粘贴短链时不会访问 xhslink.cn。

## 4. 偏离委托书的地方及理由

1. **清单链接编辑器的挂载方式**：真实浏览器里会把同一个编辑框移动到被编辑条目下方（`row.appendChild`），视觉上是原地编辑；但它仍是单个共享编辑控件，而不是每个条目各建一个。委托书只要求原地编辑，未要求每行独立实例，这样实现更小且测试可覆盖。
2. **微博纯数字 mid**：`RESOLVE_LINK` 对 `weibo.com/<uid>/<纯数字>` 返回 `noteId: null`，按「解析不出 ID」处理，避免把 mid 误当成 mblogid 造成“指向另一条帖文”的误报；字母数字混排的 mblogid 仍正常返回。
3. **`打开原帖` 按钮**：沿用现有行为，实时结果卡不显示，历史屏条目显示；没有为实时结果新增打开原帖入口。
4. **旧截图 payload 的 `source.url`**：按委托书要求永远不改 `source.url`；新流程截图的链接只写 `givenUrl`。因此若会话里残留旧版本“可选原始链接”生成的截图 payload，清空 `givenUrl` 后会回退到旧 `source.url`，而不是显示“原帖已删除”。扩展更新会清空 session 存储，正常升级不会遇到。
5. **`xhslink.com` 未支持**：委托书只列 `xhslink.cn`，manifest、输入解析与权限均按 `.cn` 实现。
6. **微博链接登录检查**：链接概括打开微博帖文时改为检查微博 `SUB` Cookie（原实现只检查小红书 `web_session`）。这是支持微博长链后必要的修正，不改变小红书流程。
7. **合并结果的可达性**：严格按委托书“焦点切换后只显示当前焦点结果”实现；切换页签后合并结果不再显示，需要重新点击合并概括（会复用缓存）才能再次聚焦。未额外增加“回到上次合并结果”的入口，以免超出委托范围。

## 5. 验收场景对照

| 场景 | 状态 | 覆盖方式 |
| --- | --- | --- |
| 痛点 1：先提取后补短链 | 通过 | 面板测试：短链命中当前结果，RELINK + MERGE_SET_LINK，无新页签、无模型；后台测试：历史同步 |
| 痛点 2：单条结果直接加入清单 | 通过 | 面板测试：复用 `slot.capture` 发 MERGE_ADD，不重新采集 |
| 先拿短链、人已在帖子页 | 通过 | 面板测试：`pendingGivenUrl` 暂存，提取消息带 `givenUrl` |
| 短链指向别的帖子 | 通过 | 面板测试：开新页签、discovery 改写 explore、结果沿用短链 |
| 短链对应清单条目 | 通过 | 面板测试：MERGE_SET_LINK；后台测试：MERGE_RERENDER 原地重渲染 |
| 解析失败让用户点选 | 通过 | 面板测试：选择列表含当前帖文、截图条目、作为新帖打开 |
| 指定目标但链接不符 | 通过 | 面板测试：提示后取消不改动 |
| 清空链接 | 通过 | 面板测试：网页回到落地页；截图回到“原帖已删除” |
| 截图单入口与结果加清单 | 通过 | 面板测试：同一暂存列表两按钮 + 结果卡加入清单 |
| 并发不回退 | 通过 | 面板测试：页签任务与合并任务并行、切页签只锁各自按钮 |
| 面板重开显示新链接 | 通过 | 后台测试：RELINK 同步 workflow；面板启动通过 GET_WORKFLOW 恢复 |

## 6. 验证命令

```powershell
cd C:\Users\10137\Documents\ChatGPT\xiaohongshu_plugin\.worktrees\sidebar-unified
npm run check
```

最后手工建议：在 Edge/Chrome 加载该 worktree 文件夹，登录小红书后分别验证真实短链补链接、截图暂存与合并；这些依赖真实账号与浏览器环境的步骤无法在单元测试中完成。
