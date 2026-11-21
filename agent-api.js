// 自动化入口（v0.22.0）
//
// 给「小红书舆情 Agent」这类本机自动化用：Agent 用带调试端口的专用浏览器，经 CDP 连进本扩展的
// 后台（service worker），直接调用 globalThis.SHUYE_AGENT_API。这里不注册任何新消息、不声明
// externally_connectable，网页和其他扩展都调用不到；普通安装下没有调试端口，也就没有代码路径能触发它。
// 不新增权限：注入脚本、给页签发消息、读 web_session 是否存在，用的都是侧边栏已有的能力。
//
// 采集与概括复用侧边栏同一条管线：注入采集脚本 → XHS_PAGE_CONTEXT 等详情就绪 →
// XHS_CAPTURE_AND_SUMMARIZE → 内容脚本采集 → 后台 XHS_AI_SUMMARIZE_PAGE。
// 唯一的差别是可以关掉本次的飞书推送（notify: false），避免批量采集刷屏。
(() => {
  const API_VERSION = 1;
  const DEFAULT_COMMENT_LIMIT = 50;
  const DETAIL_READY_TIMEOUT_MS = 25000;
  const DETAIL_POLL_INTERVAL_MS = 500;
  const NOTE_ID_PATTERN = /(?:explore|discovery\/item)\/([0-9a-f]{24})/i;

  // 本次由自动化发起、要求不推送飞书的页签。后台 summarizePagePayload 据此跳过推送。
  const quietTabs = new Set();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function noteIdOf(url) {
    return String(url || "").match(NOTE_ID_PATTERN)?.[1] || null;
  }

  async function findXhsTab({ tabId, noteId }) {
    if (Number.isInteger(tabId)) {
      return chrome.tabs.get(tabId);
    }
    const wanted = String(noteId || "").toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(wanted)) {
      throw new Error("需要提供 tabId，或 24 位帖子 ID（noteId）。");
    }
    const tabs = await chrome.tabs.query({ url: "https://*.xiaohongshu.com/*" });
    const tab = tabs.find((item) => noteIdOf(item.url)?.toLowerCase() === wanted);
    if (!tab) throw new Error(`没有找到打开着帖子 ${wanted} 的页签，请先打开帖文详情页。`);
    return tab;
  }

  async function waitDetailReady(tabId) {
    const deadline = Date.now() + DETAIL_READY_TIMEOUT_MS;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await chrome.tabs.sendMessage(tabId, { type: "XHS_PAGE_CONTEXT" });
      } catch {
        last = null;
      }
      if (last?.ok && last.pageSessionId && last.detailReady !== false) return last;
      await sleep(DETAIL_POLL_INTERVAL_MS);
    }
    throw new Error("帖文详情迟迟没有渲染出来（可能已删除、仅自己可见，或页面被验证拦住）。");
  }

  function pickMeta(capture) {
    if (!capture) return null;
    return {
      title: capture.note?.title || null,
      author: capture.note?.author || null,
      publishedDisplay: capture.note?.publishedDisplay || null,
      location: capture.note?.location || null,
      type: capture.note?.type || null,
      likes: capture.interactions?.likes?.value ?? null,
      collects: capture.interactions?.collects?.value ?? null,
      comments: capture.interactions?.comments?.value ?? null,
      imageCount: capture.media?.images?.length ?? 0,
      commentCount: capture.commentExport?.extractedTopLevelCount ?? 0
    };
  }

  // 采集并概括一个已打开的小红书帖文页签。
  // input: { tabId? , noteId?, commentLimit = 50, notify = true }
  // 返回：{ ok, apiVersion, noteId, pageUrl, text, historyId, notification, meta }
  async function captureTab(input = {}) {
    const tab = await findXhsTab(input);
    if (postPagePlatform(tab.url) !== "xiaohongshu") {
      throw new Error("目标页签不是小红书帖文详情页。");
    }
    const session = await chrome.cookies.get({ url: "https://www.xiaohongshu.com/", name: "web_session" });
    if (!session?.value) throw new Error("小红书未登录，请先在这个浏览器里登录。");

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["main-world.js"], world: "MAIN" }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture-common.js", "content-script.js"] });
    const context = await waitDetailReady(tab.id);

    const limit = Math.max(1, Math.min(50, Number(input.commentLimit) || DEFAULT_COMMENT_LIMIT));
    const quiet = input.notify === false;
    if (quiet) quietTabs.add(tab.id);
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: "XHS_CAPTURE_AND_SUMMARIZE",
        options: { limit },
        force: Boolean(input.force)
      });
    } finally {
      if (quiet) quietTabs.delete(tab.id);
    }
    if (!response?.ok) throw new Error(response?.error || "概括未完成。");
    const result = response.result || {};
    return {
      ok: true,
      apiVersion: API_VERSION,
      noteId: context.noteId || noteIdOf(tab.url),
      pageUrl: context.pageUrl || tab.url,
      text: result.text || "",
      historyId: result.historyId || null,
      notification: result.notification || null,
      meta: pickMeta(response.capture)
    };
  }

  async function ping() {
    return {
      ok: true,
      apiVersion: API_VERSION,
      extensionVersion: chrome.runtime.getManifest?.().version || null
    };
  }

  globalThis.SHUYE_AGENT_API = Object.freeze({
    version: API_VERSION,
    ping,
    captureTab,
    isQuiet: (tabId) => quietTabs.has(tabId)
  });
})();
