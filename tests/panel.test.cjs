const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createElement() {
  return {
    hidden: true,
    disabled: false,
    checked: true,
    className: "",
    textContent: "",
    value: "",
    innerHTML: "",
    files: null,
    dataset: {},
    style: {},
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    select() {},
    focus() {},
    contains() { return false; }
  };
}

const selectors = [
  "#extract-button",
  ".button-label",
  "#settings-button",
  "#task-strip",
  "#task-list",
  "#workspace",
  "#current-post-badge",
  "#current-post-label",
  "#status-card",
  "#status-title",
  "#status-detail",
  "#status-count",
  "#progress-bar",
  "#merge-add-button",
  "#material-input",
  "#material-link-button",
  "#material-feedback",
  "#link-choice",
  "#link-choice-options",
  "#material-dropzone",
  "#material-staging",
  "#shot-summarize-button",
  "#shot-basket-button",
  "#material-shot-actions",
  "#material-file-input",
  "#basket-panel",
  "#basket-count",
  "#merge-list",
  "#basket-link-editor",
  "#basket-link-editor-label",
  "#basket-link-input",
  "#basket-link-save",
  "#basket-link-cancel",
  "#basket-link-hint",
  "#basket-single-hint",
  "#merge-summarize-button",
  "#merge-summarize-label",
  "#merge-view-result-button",
  "#merge-clear-button",
  "#result-card",
  "#result-source-label",
  "#result-text",
  "#result-time",
  "#result-link-row",
  "#result-link-display",
  "#result-link-state",
  "#result-link-edit",
  "#result-link-editor",
  "#result-link-input",
  "#result-link-save",
  "#result-link-cancel",
  "#result-link-hint",
  "#result-add-basket-button",
  "#copy-button",
  "#open-source-button",
  "#regenerate-button",
  "#send-feishu-button",
  "#feishu-feedback",
  "#evidence-summary",
  "#history-button",
  "#history-back-button",
  "#view-history",
  "#history-hint",
  "#history-list",
  "#history-clear-button"
];
const elements = Object.fromEntries(selectors.map((selector) => [selector, createElement()]));

const XHS_NOTE_7 = "6a76029300000000250070c1";
const XHS_NOTE_8 = "6a76029300000000250070c2";
const XHS_NOTE_10 = "6a76029300000000250070ca";
const XHS_NOTE_11 = "6a76029300000000250070cb";
const XHS_NOTE_12 = "6a76029300000000250070cc";
const XHS_NOTE_99 = "6ab3c400000000000200d10e";
const WEIBO_ID_9 = "RhJDvgyf3";
const pageUrlById = {
  7: `https://www.xiaohongshu.com/explore/${XHS_NOTE_7}?xsec_token=test-token`,
  8: `https://www.xiaohongshu.com/explore/${XHS_NOTE_8}?xsec_token=test-token-8`,
  9: `https://weibo.com/1257000310/${WEIBO_ID_9}`,
  10: `https://www.xiaohongshu.com/explore/${XHS_NOTE_10}?xsec_token=test-token-10`,
  11: `https://www.xiaohongshu.com/explore/${XHS_NOTE_11}?xsec_token=test-token-11`,
  12: `https://www.xiaohongshu.com/explore/${XHS_NOTE_12}?xsec_token=test-token-12`,
  99: `https://www.xiaohongshu.com/explore/${XHS_NOTE_99}?xsec_token=tok&xsec_source=app_share`
};
const noteIdById = {
  7: XHS_NOTE_7,
  8: XHS_NOTE_8,
  9: WEIBO_ID_9,
  10: XHS_NOTE_10,
  11: XHS_NOTE_11,
  12: XHS_NOTE_12,
  99: XHS_NOTE_99
};
const sessionById = {
  7: "page-session-7",
  8: "page-session-8",
  9: "page-session-9",
  10: "page-session-10",
  11: "page-session-11",
  12: "page-session-12",
  99: "page-session-99"
};
let activeTabIdMock = 7;
let tabsGetQueue = {};
const tabsUpdates = [];
const windowsUpdates = [];
let tabsActivatedListener = null;
let tabsRemovedListener = null;
let runtimeListener = null;
const documentListeners = {};
const runtimeMessages = [];
const tabMessages = [];
let runtimeHandler = async () => ({ ok: true });
let tabHandler = async () => ({ ok: true });

function pageContextFor(tabId) {
  return {
    ok: true,
    tabId,
    pageSessionId: sessionById[tabId],
    pageUrl: pageUrlById[tabId],
    noteId: noteIdById[tabId]
  };
}

// 工作流广播的公共形态：noteTitle 是任务列表展示的标题
function workflowMessage(tabId, overrides = {}) {
  return {
    tabId,
    pageSessionId: sessionById[tabId],
    pageUrl: pageUrlById[tabId],
    noteId: noteIdById[tabId],
    noteTitle: `第${tabId}条帖文`,
    ...overrides
  };
}

function makeCapture(tabId, title, author) {
  const platform = tabId === 9 ? "weibo" : "xiaohongshu";
  return {
    source: { platform, noteId: noteIdById[tabId], url: pageUrlById[tabId] },
    note: { title, author },
    commentExport: { extractedTopLevelCount: 3 },
    media: { images: [] }
  };
}

function makeResult(text, extra = {}) {
  return {
    text,
    createdAt: Date.now(),
    historyId: `hist-${Math.random().toString(16).slice(2)}`,
    structured: { headline: "测试标题", eventSummary: "测试事件", opinionPoints: [] },
    evidence: { topLevelComments: 3, visibleReplies: 0, imagesFound: 0, imagesAnalyzed: 0, textModel: "test-model" },
    notification: null,
    ...extra
  };
}

const context = {
  chrome: {
    cookies: {
      get: async () => ({ name: "web_session", value: "logged-in-session" })
    },
    runtime: {
      onMessage: { addListener(listener) { runtimeListener = listener; } },
      openOptionsPage() {},
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        return runtimeHandler(message);
      }
    },
    scripting: { executeScript: async () => [] },
    tabs: {
      query: async () => [{ id: activeTabIdMock, url: pageUrlById[activeTabIdMock] }],
      get: async (tabId) => {
        const queue = tabsGetQueue[tabId];
        const url = queue?.length ? queue.shift() : pageUrlById[tabId];
        return { id: tabId, url };
      },
      update: async (tabId, options) => {
        tabsUpdates.push({ tabId, options });
        return { id: tabId, windowId: 3 };
      },
      create: async (options) => {
        tabsUpdates.push({ tabId: "create", options });
        if (options.url && (options.url.includes("xhslink.cn") || options.url.includes(XHS_NOTE_99))) {
          void tabsActivatedListener({ tabId: 99 });
        }
        return { id: 99, windowId: 3 };
      },
      onActivated: { addListener(listener) { tabsActivatedListener = listener; } },
      onRemoved: { addListener(listener) { tabsRemovedListener = listener; } },
      sendMessage: async (tabId, message) => {
        tabMessages.push({ tabId, message });
        return tabHandler(tabId, message);
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      update: async (windowId, options) => { windowsUpdates.push({ windowId, options }); },
      onFocusChanged: { addListener() {} }
    }
  },
  document: {
    querySelector: (selector) => elements[selector] || null,
    execCommand: () => true,
    addEventListener: (type, listener) => { documentListeners[type] = listener; }
  },
  navigator: { clipboard: { writeText: async () => {} } },
  console,
  Intl,
  URL,
  Date,
  Math,
  Promise,
  setTimeout,
  clearTimeout
};

vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, "..", "panel.js"), "utf8");
vm.runInContext(source, context, { filename: "panel.js" });

// 静态结构：旧单条/多条页签已删除，四个区块与结果卡的新控件都在
const panelHtml = fs.readFileSync(path.join(__dirname, "..", "panel.html"), "utf8");
assert.doesNotMatch(panelHtml, /class="view-tabs"/);
assert.doesNotMatch(panelHtml, /id="(?:view-single|view-merge|shot-single-[^"]*|link-input|link-run|screenshot-url|merge-dropzone|screenshot-staging|screenshot-run|screenshot-input)"/);
for (const id of [
  "current-post-panel",
  "add-material-panel",
  "basket-panel",
  "result-card",
  "result-link-row",
  "result-add-basket-button",
  "link-choice",
  "material-staging",
  "shot-summarize-button",
  "shot-basket-button",
  "merge-view-result-button"
]) {
  assert.match(panelHtml, new RegExp(`id="${id}"`), `panel.html 缺少 #${id}`);
}
// 结果动作同一行：复制 → 加入清单 →（历史）打开原帖 → 重新生成图标
const actionOrder = ["copy-button", "result-add-basket-button", "open-source-button", "regenerate-button"]
  .map((id) => panelHtml.indexOf(`id="${id}"`));
assert.ok(actionOrder.every((index) => index > 0), "结果动作按钮缺失");
assert.ok(actionOrder.every((index, position) => position === 0 || index > actionOrder[position - 1]), "结果动作顺序不对");
assert.match(panelHtml, /id="regenerate-button"[^>]*title="重新生成"/);
assert.doesNotMatch(panelHtml, /id="regenerate-button"[^>]*>\s*重新生成/);
for (const [id, title] of [["result-link-save", "保存链接"], ["result-link-cancel", "取消编辑"]]) {
  assert.match(panelHtml, new RegExp(`id="${id}"[^>]*title="${title}"`), `#${id} 缺少悬停提示`);
  assert.doesNotMatch(panelHtml, new RegExp(`id="${id}"[^>]*>\\s*${title}`), `#${id} 不应是文字按钮`);
}

async function settle(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function taskCount() {
  return (elements["#task-list"].innerHTML.match(/class="merge-item task-item"/g) || []).length;
}

async function switchChromeTab(tabId) {
  activeTabIdMock = tabId;
  await tabsActivatedListener({ tabId });
  await settle();
}

function setRuntime(handler) {
  runtimeMessages.length = 0;
  runtimeHandler = handler;
}

function setTabHandler(handler) {
  tabMessages.length = 0;
  tabHandler = handler;
}

function findRuntime(type) {
  return runtimeMessages.filter((message) => message.type === type);
}

function findTabMessage(type) {
  return tabMessages.filter((entry) => entry.message.type === type);
}

function delegationTarget({ rowSelector, row, buttonSelector, button }) {
  return {
    closest(selector) {
      if (rowSelector && selector === rowSelector) return row;
      if (buttonSelector && selector === buttonSelector) return button || {};
      return null;
    }
  };
}

function basketItem(id, title, { kind = "live_page", platform = "xiaohongshu", link = null, linkVerified = null, author = "甲" } = {}) {
  return {
    id,
    kind,
    platform,
    title,
    author,
    publishedDisplay: null,
    commentCount: 3,
    imageCount: 0,
    isVideo: false,
    hasUrl: true,
    link,
    linkVerified,
    addedAt: Date.now()
  };
}

(async () => {
  // 启动时的 GET_WORKFLOW：当前页签（7）有一条进行中的任务
  runtimeHandler = async (message) => {
    if (message.type === "XHS_AI_GET_WORKFLOW") {
      return {
        ok: true,
        workflow: workflowMessage(7, {
          status: "working",
          progress: { state: "working", title: "正在读取评论", detail: "已加载 17 条一级评论", percent: 10, count: 17 }
        })
      };
    }
    if (message.type === "XHS_AI_LIST_WORKFLOWS") return { ok: true, workflows: [] };
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket: [] };
    if (message.type === "XHS_AI_HISTORY_LIST") return { ok: true, items: [] };
    return { ok: true };
  };
  tabHandler = async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    throw new Error(`Unexpected tab message: ${message.type}`);
  };

  await settle(8);

  // —— 启动：恢复当前页签的进行中任务；当前帖文区块显示平台 ——
  assert.equal(elements["#extract-button"].disabled, true);
  assert.equal(elements[".button-label"].textContent, "正在处理…");
  assert.equal(elements["#status-title"].textContent, "正在读取评论");
  assert.equal(elements["#status-detail"].textContent, "已加载 17 条一级评论");
  assert.equal(elements["#status-count"].textContent, "17 / 50");
  assert.equal(elements["#result-card"].hidden, true);
  assert.equal(elements["#task-strip"].hidden, false);
  assert.equal(taskCount(), 1);
  assert.match(elements["#task-list"].innerHTML, /第7条帖文/);
  assert.equal(elements["#current-post-badge"].textContent, "小红书");
  assert.equal(elements["#current-post-badge"].hidden, false);
  assert.equal(elements["#workspace"].hidden, false);

  // —— 第二个页签并行概括：任务条出现第二条，当前结果不受打扰 ——
  runtimeListener({
    type: "XHS_AI_WORKFLOW_STATE",
    workflow: workflowMessage(8, {
      status: "working",
      progress: { state: "working", title: "正在撰写概括", detail: "正在综合证据撰写概括…", percent: 66 }
    })
  });
  assert.equal(taskCount(), 2);
  assert.match(elements["#task-list"].innerHTML, /第8条帖文/);
  assert.equal(elements["#status-title"].textContent, "正在读取评论");

  // —— 切到页签 8：焦点回到 tab，显示页签 8 的进度 ——
  await switchChromeTab(8);
  assert.equal(elements["#status-title"].textContent, "正在撰写概括");
  assert.equal(elements["#result-card"].hidden, true);
  assert.equal(elements["#regenerate-button"].disabled, true);

  // 页签 8 完成：结果落页签 8
  runtimeListener({
    type: "XHS_AI_WORKFLOW_STATE",
    workflow: workflowMessage(8, {
      status: "done",
      capture: makeCapture(8, "第二条帖文", "乙"),
      result: makeResult("★ 第二条概括\n第二条正文。（小红书 https://example.com/8）"),
      progress: { state: "done", title: "概括完成", detail: "已按固定格式生成，可直接复制。", percent: 100 }
    })
  });
  await settle(2);
  assert.equal(taskCount(), 1);
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /第二条概括/);
  assert.equal(elements["#result-source-label"].textContent, "当前页签");
  // 提取完成后只保留平台徽标，不在按钮上方重复渲染标题/正文
  assert.equal(elements["#current-post-label"].hidden, true);
  assert.equal(elements["#current-post-label"].textContent, "");
  assert.equal(elements["#status-title"].textContent, "概括完成");
  assert.equal(elements["#status-count"].textContent, "100%");
  assert.equal(elements["#result-add-basket-button"].textContent, "加入清单");
  assert.match(elements["#result-link-display"].textContent, /xiaohongshu\.com\/explore\//);
  assert.equal(elements["#extract-button"].disabled, false);

  // —— 切回页签 7：显示页签 7 自己的进度，页签 8 的结果不带过来 ——
  await switchChromeTab(7);
  assert.equal(elements["#status-title"].textContent, "正在读取评论");
  assert.equal(elements["#result-card"].hidden, true);

  runtimeListener({
    type: "XHS_AI_WORKFLOW_STATE",
    workflow: workflowMessage(7, {
      status: "done",
      capture: makeCapture(7, "第一条帖文", "甲"),
      result: makeResult("★ 第一条概括\n第一条正文。（小红书 https://example.com/7）"),
      progress: { state: "done", title: "概括完成", detail: "已按固定格式生成，可直接复制。", percent: 100 }
    })
  });
  assert.equal(elements["#extract-button"].disabled, false);
  assert.equal(elements[".button-label"].textContent, "提取并概括");
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /第一条概括/);
  assert.doesNotMatch(elements["#result-text"].value, /第二条概括/);
  assert.equal(elements["#current-post-label"].hidden, true);
  assert.equal(taskCount(), 0);
  assert.equal(elements["#task-strip"].hidden, true);

  // —— 任务条点击：跳到对应 Chrome 页签并聚焦其窗口 ——
  runtimeListener({
    type: "XHS_AI_WORKFLOW_STATE",
    workflow: workflowMessage(9, {
      status: "working",
      progress: { state: "working", title: "正在读取帖文", detail: "通过微博接口获取正文、互动数和媒体资源", percent: 5 }
    })
  });
  assert.equal(taskCount(), 1);
  assert.match(elements["#task-list"].innerHTML, /merge-badge-weibo/);
  await elements["#task-list"].listeners.click({
    target: { closest: (selector) => selector === ".task-item" ? { dataset: { key: "page:9" } } : null }
  });
  await settle();
  assert.equal(tabsUpdates.length, 1);
  assert.equal(tabsUpdates[0].tabId, 9);
  assert.equal(tabsUpdates[0].options.active, true);
  assert.equal(windowsUpdates.length, 1);
  assert.equal(windowsUpdates[0].options.focused, true);

  // 页签 9 关闭：任务条立即清理，不留死条目
  await tabsRemovedListener(9);
  assert.equal(taskCount(), 0);
  assert.equal(elements["#task-strip"].hidden, true);

  // —— 加入清单路径一：已有 capture 直接 MERGE_ADD，不重新采集 ——
  let basket = [];
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    if (message.type === "XHS_AI_MERGE_ADD") {
      const id = `note:${message.payload.source.noteId}`;
      const item = basketItem(id, message.payload.note.title, { link: message.payload.source.url });
      basket = basket.filter((entry) => entry.id !== id).concat(item);
      return { ok: true, replaced: false, basket };
    }
    if (message.type === "XHS_AI_MERGE_REMOVE") {
      basket = basket.filter((entry) => entry.id !== message.id);
      return { ok: true, basket };
    }
    if (message.type === "XHS_AI_MERGE_CLEAR") {
      basket = [];
      return { ok: true, basket };
    }
    return { ok: true };
  });
  setTabHandler(async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    if (message.type === "XHS_CAPTURE_FOR_MERGE") throw new Error("已有采集数据时不应重新采集");
    throw new Error(`Unexpected tab message: ${message.type}`);
  });
  await switchChromeTab(7);
  await elements["#merge-add-button"].listeners.click();
  await settle();
  assert.equal(findRuntime("XHS_AI_MERGE_ADD").length, 1);
  assert.equal(findRuntime("XHS_AI_MERGE_ADD")[0].payload.note.title, "第一条帖文");
  assert.equal(findTabMessage("XHS_CAPTURE_FOR_MERGE").length, 0);
  assert.equal(elements["#basket-panel"].hidden, false);
  assert.equal(elements["#basket-count"].textContent, "1");
  assert.match(elements["#merge-list"].innerHTML, /第一条帖文/);
  assert.equal(elements["#basket-single-hint"].hidden, false);
  assert.equal(elements["#merge-summarize-button"].hidden, true);
  assert.equal(elements["#result-add-basket-button"].textContent, "已在清单");
  assert.equal(elements["#result-add-basket-button"].disabled, true);

  // —— 痛点 2：页签 8 的结果直接加入清单，清单出现合并入口 ——
  await switchChromeTab(8);
  await elements["#result-add-basket-button"].listeners.click();
  await settle();
  assert.equal(elements["#basket-count"].textContent, "2");
  assert.equal(elements["#merge-summarize-button"].hidden, false);
  assert.equal(elements["#merge-summarize-label"].textContent, "合并概括（2 条）");
  assert.equal(elements["#result-add-basket-button"].textContent, "已在清单");

  // —— 合并概括：焦点切到 merge，结果顶部标注来源 ——
  let resolveMerge;
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_MERGE_SUMMARIZE") {
      return new Promise((resolve) => { resolveMerge = resolve; });
    }
    return { ok: true };
  });
  const mergeClick = elements["#merge-summarize-button"].listeners.click();
  await settle();
  assert.equal(elements["#status-title"].textContent, "正在合并概括");
  assert.equal(taskCount(), 1);
  assert.match(elements["#task-list"].innerHTML, /merge-badge-merge/);
  assert.equal(elements["#merge-summarize-button"].disabled, true);
  assert.equal(elements["#extract-button"].disabled, false);
  resolveMerge({
    ok: true,
    result: makeResult("★ 合并概括测试\n9月10日，甲发帖。（小红书 https://example.com/a）", {
      postCount: 2,
      merged: true,
      itemIds: [`note:${XHS_NOTE_7}`, `note:${XHS_NOTE_8}`]
    })
  });
  await mergeClick;
  await settle();
  assert.equal(elements["#status-title"].textContent, "合并概括完成");
  assert.equal(elements["#result-source-label"].textContent, "合并 2 条");
  assert.match(elements["#result-text"].value, /合并概括测试/);
  assert.equal(elements["#result-link-row"].hidden, true);
  assert.equal(elements["#result-add-basket-button"].hidden, true);
  assert.equal(taskCount(), 0);

  // 合并焦点下重新生成走合并概括
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_MERGE_SUMMARIZE") {
      return { ok: true, result: makeResult("★ 合并概括测试\n9月10日，甲再次发帖。（小红书 https://example.com/a）", { postCount: 2, merged: true, itemIds: [`note:${XHS_NOTE_7}`, `note:${XHS_NOTE_8}`] }) };
    }
    return { ok: true };
  });
  await elements["#regenerate-button"].listeners.click();
  await settle();
  assert.equal(elements["#status-title"].textContent, "重新生成完成");
  assert.match(elements["#result-text"].value, /再次发帖/);

  // —— 切回页签 7：显示页签自己的结果；清单区提供「查看合并结果」入口 ——
  await switchChromeTab(7);
  assert.equal(elements["#result-source-label"].textContent, "当前页签");
  assert.match(elements["#result-text"].value, /第一条概括/);
  assert.doesNotMatch(elements["#result-text"].value, /合并概括测试/);
  assert.equal(elements["#result-link-row"].hidden, false);
  assert.equal(elements["#merge-view-result-button"].hidden, false);
  assert.equal(elements["#merge-view-result-button"].textContent, "查看合并结果");
  const mergeSummarizeCallsBeforeView = findRuntime("XHS_AI_MERGE_SUMMARIZE").length;
  await elements["#merge-view-result-button"].listeners.click();
  await settle();
  assert.equal(elements["#result-source-label"].textContent, "合并 2 条");
  assert.match(elements["#result-text"].value, /再次发帖/);
  assert.equal(findRuntime("XHS_AI_MERGE_SUMMARIZE").length, mergeSummarizeCallsBeforeView);
  assert.equal(elements["#merge-view-result-button"].hidden, true);
  await switchChromeTab(8);
  await switchChromeTab(7);

  // —— 页签级重新生成：只锁页签按钮，任务条同步 ——
  let resolveRegenerate;
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    return { ok: true };
  });
  setTabHandler(async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      assert.equal(tabId, 7);
      assert.equal(message.force, true);
      return new Promise((resolve) => { resolveRegenerate = resolve; });
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  });
  const regenerateClick = elements["#regenerate-button"].listeners.click();
  await settle();
  assert.equal(elements["#status-title"].textContent, "正在重新生成");
  assert.equal(elements["#extract-button"].disabled, true);
  assert.equal(elements["#regenerate-button"].disabled, true);
  assert.equal(taskCount(), 1);
  assert.match(elements["#task-list"].innerHTML, /第一条帖文/);
  resolveRegenerate({
    ok: true,
    result: makeResult("★ 第一条概括（新版本）\n第一条正文二。（小红书 https://example.com/7）"),
    capture: makeCapture(7, "第一条帖文", "甲")
  });
  await regenerateClick;
  await settle();
  assert.equal(elements["#status-title"].textContent, "重新生成完成");
  assert.match(elements["#result-text"].value, /新版本/);
  assert.equal(taskCount(), 0);
  assert.equal(elements["#extract-button"].disabled, false);

  // —— 并发不回退：页签任务与合并任务同时跑，各自只锁自己的按钮 ——
  let resolveConcurrentRegenerate;
  let resolveConcurrentMerge;
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    if (message.type === "XHS_AI_MERGE_SUMMARIZE") {
      return new Promise((resolve) => { resolveConcurrentMerge = resolve; });
    }
    return { ok: true };
  });
  setTabHandler(async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      return new Promise((resolve) => { resolveConcurrentRegenerate = resolve; });
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  });
  const concurrentRegenerateClick = elements["#regenerate-button"].listeners.click();
  await settle();
  const concurrentMergeClick = elements["#merge-summarize-button"].listeners.click();
  await settle();
  assert.equal(taskCount(), 2);
  assert.equal(elements["#status-title"].textContent, "正在合并概括");
  assert.equal(elements["#extract-button"].disabled, true);
  assert.equal(elements["#merge-add-button"].disabled, true);
  assert.equal(elements["#merge-summarize-button"].disabled, true);
  // 切到另一个页签：焦点回到 tab，页签 8 的按钮不被页签 7/合并任务锁住
  await switchChromeTab(8);
  assert.equal(elements["#status-title"].textContent, "已加入合并清单");
  assert.equal(elements["#extract-button"].disabled, false);
  assert.equal(elements["#merge-summarize-button"].disabled, true);
  assert.equal(taskCount(), 2);
  resolveConcurrentMerge({
    ok: true,
    result: makeResult("★ 并行合并\n并行合并正文。（小红书 https://example.com/parallel）", {
      postCount: 2,
      merged: true,
      itemIds: [`note:${XHS_NOTE_7}`, `note:${XHS_NOTE_8}`]
    })
  });
  await concurrentMergeClick;
  await settle();
  assert.equal(taskCount(), 1);
  assert.match(elements["#result-text"].value, /第二条概括/);
  resolveConcurrentRegenerate({
    ok: true,
    result: makeResult("★ 第一条概括（并行版）\n并行重新生成。（小红书 https://example.com/7）"),
    capture: makeCapture(7, "第一条帖文", "甲")
  });
  await concurrentRegenerateClick;
  await settle();
  assert.equal(taskCount(), 0);

  // —— 截图入口：一份暂存列表，两个提交动作 ——
  context.FileReader = class {
    readAsDataURL(file) {
      this.result = file.dataUrl;
      this.onload();
    }
  };
  context.Image = class {
    set src(value) {
      this.naturalWidth = 100;
      this.naturalHeight = 100;
      this.onload();
    }
  };
  function makeDataTransferEvent(clipboard) {
    return {
      clipboardData: clipboard,
      dataTransfer: clipboard,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
  }

  const shotPayload = {
    source: { platform: "xiaohongshu", noteId: null, url: null, origin: "user_screenshot", screenshotId: "shot-test-1" },
    note: { title: "截图帖文", author: "截图作者" },
    commentExport: { extractedTopLevelCount: 2 },
    media: { images: [] }
  };
  elements["#material-file-input"].files = [{ name: "shot.png", type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }];
  await elements["#material-file-input"].listeners.change();
  await settle();
  assert.equal(elements["#material-staging"].hidden, false);
  assert.equal(elements["#material-shot-actions"].hidden, false);
  assert.match(elements["#shot-summarize-button"].textContent, /识别这张截图并概括/);
  assert.match(elements["#shot-basket-button"].textContent, /识别这张截图并加入清单/);

  let resolveShotSummarize;
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_SCREENSHOT_RECOGNIZE") return { ok: true, payload: shotPayload, warnings: [] };
    if (message.type === "XHS_AI_SUMMARIZE") {
      assert.equal(message.payload.source.origin, "user_screenshot");
      return new Promise((resolve) => { resolveShotSummarize = resolve; });
    }
    if (message.type === "XHS_AI_MERGE_ADD") {
      const item = basketItem(`shot:${shotPayload.source.screenshotId}`, "截图帖文", { kind: "user_screenshot", link: null });
      basket = basket.concat(item);
      return { ok: true, replaced: false, basket };
    }
    return { ok: true };
  });
  const shotClick = elements["#shot-summarize-button"].listeners.click();
  await settle();
  assert.equal(elements["#status-title"].textContent, "正在撰写概括");
  assert.equal(elements["#result-card"].hidden, true);
  assert.equal(taskCount(), 1);
  assert.match(elements["#task-list"].innerHTML, /merge-badge-shot/);
  assert.equal(elements["#extract-button"].disabled, false);
  resolveShotSummarize({
    ok: true,
    result: makeResult("★ 截图帖文事件\n据截图整理。（原帖已删除，内容据用户上传截图整理）")
  });
  await shotClick;
  await settle();
  assert.equal(elements["#status-title"].textContent, "截图概括完成");
  assert.match(elements["#result-text"].value, /截图帖文事件/);
  assert.equal(elements["#result-source-label"].textContent, "截图");
  assert.equal(elements["#material-staging"].hidden, true);
  assert.equal(elements["#result-link-display"].textContent, "＋补充链接");
  assert.equal(elements["#result-add-basket-button"].textContent, "加入清单");

  // 截图结果的「加入清单」复用 payload
  await elements["#result-add-basket-button"].listeners.click();
  await settle();
  assert.equal(elements["#basket-count"].textContent, "3");
  assert.equal(findRuntime("XHS_AI_MERGE_ADD").length, 1);
  assert.equal(findRuntime("XHS_AI_MERGE_ADD")[0].payload.source.origin, "user_screenshot");
  assert.equal(elements["#result-add-basket-button"].textContent, "已在清单");

  // 截图结果补链接：只校验网址合法，随后可清空回到“原帖已删除”
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RELINK") {
      const source = { ...message.payload.source };
      if (message.givenUrl) source.givenUrl = message.givenUrl;
      else delete source.givenUrl;
      delete source.givenUrlVerified;
      const suffix = message.givenUrl
        ? `（小红书 ${message.givenUrl}）`
        : "（原帖已删除，内容据用户上传截图整理）";
      return {
        ok: true,
        payload: { ...message.payload, source },
        result: { ...message.result, text: `★ 截图帖文事件\n据截图整理。${suffix}` }
      };
    }
    if (message.type === "XHS_AI_MERGE_SET_LINK") {
      basket = basket.map((item) => item.id === message.id
        ? { ...item, link: message.givenUrl || null, linkVerified: null }
        : item);
      return { ok: true, basket };
    }
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  elements["#result-link-edit"].listeners.click();
  elements["#result-link-input"].value = "https://xhslink.cn/o/shot-link";
  await elements["#result-link-save"].listeners.click();
  await settle(10);
  assert.equal(findRuntime("XHS_AI_RELINK").length, 1);
  assert.equal(findRuntime("XHS_AI_RELINK")[0].givenUrl, "https://xhslink.cn/o/shot-link");
  assert.equal(findRuntime("XHS_AI_RELINK")[0].verified, false);
  assert.match(elements["#result-text"].value, /xhslink\.cn\/o\/shot-link/);
  assert.equal(elements["#result-link-state"].hidden, true);
  elements["#result-link-edit"].listeners.click();
  elements["#result-link-input"].value = "";
  await elements["#result-link-save"].listeners.click();
  await settle(10);
  assert.match(elements["#result-text"].value, /原帖已删除，内容据用户上传截图整理/);

  // 统一暂存列表的「识别并加入清单」
  let resolveShotBasket;
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_SCREENSHOT_ADD") {
      const item = basketItem(`shot:shot-test-2`, "粘贴截图", { kind: "user_screenshot" });
      basket = basket.concat(item);
      return new Promise((resolve) => {
        resolveShotBasket = () => resolve({ ok: true, basket, warnings: [] });
      });
    }
    return { ok: true };
  });
  documentListeners.paste(makeDataTransferEvent({
    files: [{ name: "paste-1.png", type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }]
  }));
  await settle();
  documentListeners.paste(makeDataTransferEvent({
    files: [{ name: "paste-2.png", type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }]
  }));
  await settle();
  assert.match(elements["#shot-basket-button"].textContent, /识别这 2 张截图并加入清单/);
  const shotBasketClick = elements["#shot-basket-button"].listeners.click();
  await settle();
  assert.equal(findRuntime("XHS_AI_SCREENSHOT_ADD").length, 1);
  assert.equal(findRuntime("XHS_AI_SCREENSHOT_ADD")[0].images.length, 2);
  assert.equal(findRuntime("XHS_AI_SCREENSHOT_ADD")[0].sourceUrl, undefined);
  resolveShotBasket();
  await shotBasketClick;
  await settle();
  assert.match(elements["#material-feedback"].textContent, /截图已识别并加入清单/);
  assert.equal(elements["#basket-count"].textContent, "4");
  assert.equal(elements["#material-staging"].hidden, true);

  // 纯文本粘贴不拦截；非图片拖入被拦下但不进暂存区
  const textPasteEvent = makeDataTransferEvent({ files: [] });
  documentListeners.paste(textPasteEvent);
  assert.equal(textPasteEvent.defaultPrevented, false);
  const nonImageDropEvent = makeDataTransferEvent({
    types: ["Files"],
    files: [{ name: "notes.txt", type: "text/plain", size: 10 }]
  });
  documentListeners.drop(nonImageDropEvent);
  await settle();
  assert.equal(nonImageDropEvent.defaultPrevented, true);
  assert.equal(elements["#material-staging"].hidden, true);

  // —— 链接自动识别：短链命中当前页签结果，只换链接不调用模型 ——
  const shortLink7 = "https://xhslink.cn/o/note7short";
  let basketLink = "https://xhslink.cn/o/note7short";
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_7, resolvedUrl: pageUrlById[7] };
    }
    if (message.type === "XHS_AI_RELINK") {
      const source = { ...message.payload.source, givenUrl: message.givenUrl, givenUrlVerified: message.verified };
      const payload = { ...message.payload, source };
      return {
        ok: true,
        payload,
        result: { ...message.result, text: `★ 第一条概括\n第一条正文。（小红书 ${message.givenUrl}）` }
      };
    }
    if (message.type === "XHS_AI_MERGE_SET_LINK") {
      basket = basket.map((item) => item.id === message.id
        ? { ...item, link: message.givenUrl, linkVerified: message.verified }
        : item);
      return { ok: true, basket };
    }
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  await switchChromeTab(8);
  await switchChromeTab(7);
  elements["#material-input"].value = `分享文案 ${shortLink7} 快看看`;
  await elements["#material-link-button"].listeners.click();
  await settle(10);
  assert.equal(findRuntime("XHS_AI_RELINK").length >= 1, true);
  assert.equal(findRuntime("XHS_AI_RELINK")[0].givenUrl, shortLink7);
  assert.equal(findRuntime("XHS_AI_RELINK")[0].tabId, 7);
  assert.equal(findRuntime("XHS_AI_RELINK")[0].pageSessionId, "page-session-7");
  assert.equal(findRuntime("XHS_AI_MERGE_SET_LINK").length >= 1, true);
  assert.equal(findRuntime("XHS_AI_MERGE_SET_LINK")[0].id, `note:${XHS_NOTE_7}`);
  assert.match(elements["#result-text"].value, /xhslink\.cn\/o\/note7short/);
  assert.equal(elements["#material-feedback"].textContent, "链接已更新（未重新推送飞书）。");
  assert.equal(findRuntime("XHS_AI_MERGE_SUMMARIZE").length, 0);
  assert.equal(elements["#material-input"].value, "");

  // 短链只命中清单中的另一条：只更新清单，不动当前页签结果
  const shortLink8 = "https://xhslink.cn/o/note8short";
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_8, resolvedUrl: pageUrlById[8] };
    }
    if (message.type === "XHS_AI_MERGE_SET_LINK") {
      basket = basket.map((item) => item.id === message.id
        ? { ...item, link: message.givenUrl, linkVerified: message.verified }
        : item);
      return { ok: true, basket };
    }
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  elements["#material-input"].value = shortLink8;
  await elements["#material-link-button"].listeners.click();
  await settle(10);
  assert.equal(findRuntime("XHS_AI_RELINK").length, 0);
  assert.equal(findRuntime("XHS_AI_MERGE_SET_LINK").length >= 1, true);
  assert.equal(findRuntime("XHS_AI_MERGE_SET_LINK")[0].id, `note:${XHS_NOTE_8}`);
  assert.doesNotMatch(elements["#result-text"].value, /note8short/);

  // 解析失败：内联选择列表包含当前帖文、清单每条（含截图）与新帖
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") return { ok: true, platform: "xiaohongshu", noteId: null, resolvedUrl: "https://www.xiaohongshu.com/login" };
    return { ok: true };
  });
  elements["#material-input"].value = "https://xhslink.cn/o/risk-control";
  await elements["#material-link-button"].listeners.click();
  await settle(10);
  assert.equal(elements["#link-choice"].hidden, false);
  assert.match(elements["#link-choice-options"].innerHTML, /当前帖文/);
  assert.match(elements["#link-choice-options"].innerHTML, /截图/);
  assert.match(elements["#link-choice-options"].innerHTML, /作为新帖打开/);

  // 选择清单里的截图条目：链接补到该条目
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_MERGE_SET_LINK") {
      basket = basket.map((item) => item.id === message.id
        ? { ...item, link: message.givenUrl, linkVerified: null }
        : item);
      return { ok: true, basket };
    }
    return { ok: true };
  });
  await elements["#link-choice-options"].listeners.click({
    target: { closest: (selector) => selector === "[data-choice]" ? { dataset: { choice: "basket:shot:shot-test-1" } } : null }
  });
  await settle(8);
  assert.equal(elements["#link-choice"].hidden, true);
  assert.equal(findRuntime("XHS_AI_MERGE_SET_LINK")[0].id, "shot:shot-test-1");
  assert.equal(findRuntime("XHS_AI_MERGE_SET_LINK")[0].givenUrl, "https://xhslink.cn/o/risk-control");

  // —— 先拿到短链、人已在帖子页：暂存到页签，提取时带入 ——
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_10, resolvedUrl: pageUrlById[10] };
    }
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    return { ok: true };
  });
  setTabHandler(async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      return {
        ok: true,
        result: makeResult(`★ 帖文十概括\n正文。（小红书 ${message.givenUrl}）`),
        capture: { ...makeCapture(10, "帖文十", "丁"), source: { ...makeCapture(10, "帖文十", "丁").source, givenUrl: message.givenUrl } }
      };
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  });
  await switchChromeTab(10);
  elements["#material-input"].value = "https://xhslink.cn/o/note10short";
  await elements["#material-link-button"].listeners.click();
  await settle(10);
  assert.equal(elements["#material-feedback"].textContent, "链接已更新（未重新推送飞书）。");
  assert.equal(elements["#material-input"].value, "");
  assert.equal(elements["#material-staging"].hidden, true);
  await elements["#extract-button"].listeners.click();
  await settle(8);
  const tenCapture = findTabMessage("XHS_CAPTURE_AND_SUMMARIZE");
  assert.equal(tenCapture.length, 1);
  assert.equal(tenCapture[0].message.givenUrl, "https://xhslink.cn/o/note10short");
  assert.match(elements["#result-text"].value, /note10short/);

  // —— 短链指向别的帖子：开新页签采集并概括，结果沿用短链 ——
  activeTabIdMock = 7;
  sessionById[99] = "page-session-99";
  const shortLink99 = "https://xhslink.cn/o/note99short";
  tabsGetQueue = {
    99: [
      shortLink99,
      `https://www.xiaohongshu.com/discovery/item/${XHS_NOTE_99}?xsec_token=tok&xsec_source=app_share`
    ]
  };
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_99, resolvedUrl: pageUrlById[99] };
    }
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    return { ok: true };
  });
  let linkCaptureMessage = null;
  setTabHandler(async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return { ...pageContextFor(tabId), detailReady: true };
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      linkCaptureMessage = message;
      return {
        ok: true,
        result: makeResult(`★ 短链帖文概括\n正文。（小红书 ${shortLink99}）`),
        capture: { ...makeCapture(99, "短链帖文", "丙"), source: { ...makeCapture(99, "短链帖文", "丙").source, givenUrl: shortLink99 } }
      };
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  });
  elements["#material-input"].value = `已经精疲力尽了 ${shortLink99} \n先复制这段`;
  const linkClick = elements["#material-link-button"].listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await linkClick;
  assert.ok(tabsUpdates.some((update) => update.tabId === "create" && update.options.url === shortLink99), "开页签应沿用给定短链");
  const rewrite = tabsUpdates.find((update) => update.tabId === 99);
  assert.ok(rewrite, "discovery 落地页应改写为 explore");
  assert.match(rewrite.options.url, /www\.xiaohongshu\.com\/explore\/6ab3c400000000000200d10e\?xsec_token=tok/);
  assert.ok(linkCaptureMessage);
  assert.equal(linkCaptureMessage.givenUrl, shortLink99);
  assert.match(elements["#result-text"].value, /短链帖文概括/);

  // —— 结果卡片指定目标补链接：不符时确认，取消不改动 ——
  await switchChromeTab(7);
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_8, resolvedUrl: pageUrlById[8] };
    }
    return { ok: true };
  });
  elements["#result-link-edit"].listeners.click();
  assert.equal(elements["#result-link-editor"].hidden, false);
  // 编辑时原链接行本身变成输入框，不再在下方另起一行
  assert.equal(elements["#result-link-display"].hidden, true);
  assert.equal(elements["#result-link-edit"].hidden, true);
  assert.ok(elements["#result-link-input"].value.length > 0);
  elements["#result-link-input"].value = pageUrlById[8];
  await elements["#result-link-save"].listeners.click();
  await settle(8);
  assert.match(elements["#result-link-hint"].innerHTML, /这条链接指向另一条帖文/);
  assert.equal(findRuntime("XHS_AI_RELINK").length, 0);
  await elements["#result-link-hint"].listeners.click({
    target: { closest: (selector) => selector === "[data-link-choice]" ? { dataset: { linkChoice: "cancel" } } : null }
  });
  await settle();
  assert.equal(findRuntime("XHS_AI_RELINK").length, 0);
  assert.equal(elements["#result-link-hint"].hidden, true);

  // 指向同一帖子：直接保存并重新渲染，不调用模型
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_7, resolvedUrl: pageUrlById[7] };
    }
    if (message.type === "XHS_AI_RELINK") {
      const source = { ...message.payload.source, givenUrl: message.givenUrl, givenUrlVerified: message.verified };
      return {
        ok: true,
        payload: { ...message.payload, source },
        result: { ...message.result, text: `★ 第一条概括\n换过的链接。（小红书 ${message.givenUrl}）` }
      };
    }
    if (message.type === "XHS_AI_MERGE_SET_LINK") return { ok: true, basket };
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  elements["#result-link-input"].value = "https://xhslink.cn/o/matched7";
  await elements["#result-link-save"].listeners.click();
  await settle(10);
  assert.equal(findRuntime("XHS_AI_RELINK").length, 1);
  assert.equal(findRuntime("XHS_AI_RELINK")[0].givenUrl, "https://xhslink.cn/o/matched7");
  assert.equal(findRuntime("XHS_AI_RELINK")[0].verified, true);
  assert.match(elements["#result-text"].value, /换过的链接/);
  assert.equal(elements["#result-link-editor"].hidden, true);
  assert.equal(elements["#result-link-display"].hidden, false);
  assert.equal(elements["#result-link-edit"].hidden, false);
  assert.match(elements["#result-link-display"].textContent, /xhslink\.cn\/o\/matched7/);

  // 清空链接：网页帖文回到落地页地址
  elements["#result-link-edit"].listeners.click();
  elements["#result-link-input"].value = "";
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RELINK") {
      const source = { ...message.payload.source };
      delete source.givenUrl;
      delete source.givenUrlVerified;
      return {
        ok: true,
        payload: { ...message.payload, source },
        result: { ...message.result, text: `★ 第一条概括\n恢复落地页。（小红书 ${source.url}）` }
      };
    }
    if (message.type === "XHS_AI_MERGE_SET_LINK") return { ok: true, basket };
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  await elements["#result-link-save"].listeners.click();
  await settle(8);
  assert.equal(findRuntime("XHS_AI_RELINK")[0].givenUrl, "");
  assert.match(elements["#result-text"].value, /恢复落地页/);
  assert.match(elements["#result-link-display"].textContent, /xiaohongshu\.com\/explore/);

  // —— 结果框可编辑；配置了飞书时显示手动发送图标 ——
  assert.doesNotMatch(panelHtml, /id="result-text"[^>]*readonly/);
  assert.equal(elements["#send-feishu-button"].hidden, true);
  const editedText = "用户编辑后的概括\n第二行内容（含换行）";
  elements["#result-text"].value = editedText;
  elements["#result-text"].listeners.input();
  await switchChromeTab(8);
  await switchChromeTab(7);
  assert.equal(elements["#result-text"].value, editedText);

  let feishuStatus = false;
  let sentFeishuText = null;
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_GET_FEISHU_STATUS") return { ok: true, configured: feishuStatus };
    if (message.type === "XHS_AI_SEND_FEISHU") {
      sentFeishuText = message.text;
      return { ok: true, channel: "webhook" };
    }
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    return { ok: true };
  });
  await context.refreshFeishuStatus();
  assert.equal(elements["#send-feishu-button"].hidden, true);
  feishuStatus = true;
  await context.refreshFeishuStatus();
  assert.equal(elements["#send-feishu-button"].hidden, false);
  await elements["#send-feishu-button"].listeners.click();
  await settle();
  assert.equal(sentFeishuText, editedText);
  assert.equal(elements["#feishu-feedback"].hidden, false);
  assert.equal(elements["#feishu-feedback"].textContent, "已发送到飞书。");
  feishuStatus = false;
  await context.refreshFeishuStatus();
  assert.equal(elements["#send-feishu-button"].hidden, true);

  // —— 清单条目补链接：编辑框在清单下方，保存走 MERGE_SET_LINK ——
  await elements["#merge-list"].listeners.click({
    target: delegationTarget({
      rowSelector: ".basket-item",
      row: { dataset: { id: `note:${XHS_NOTE_7}` } },
      buttonSelector: ".basket-link-value",
      button: {}
    })
  });
  assert.equal(elements["#basket-link-editor"].hidden, false);
  assert.match(elements["#basket-link-editor-label"].textContent, /第一条帖文/);
  elements["#basket-link-input"].value = "https://xhslink.cn/o/basket7";
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_MERGE_SET_LINK") {
      basket = basket.map((item) => item.id === message.id
        ? { ...item, link: message.givenUrl, linkVerified: message.verified }
        : item);
      return { ok: true, basket };
    }
    if (message.type === "XHS_AI_RELINK") {
      const source = { ...message.payload.source, givenUrl: message.givenUrl, givenUrlVerified: message.verified };
      return { ok: true, payload: { ...message.payload, source }, result: message.result };
    }
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  await elements["#basket-link-save"].listeners.click();
  await settle(10);
  assert.equal(findRuntime("XHS_AI_MERGE_SET_LINK").length, 1);
  assert.equal(findRuntime("XHS_AI_MERGE_SET_LINK")[0].givenUrl, "https://xhslink.cn/o/basket7");
  assert.equal(elements["#basket-link-editor"].hidden, true);
  assert.match(elements["#material-feedback"].textContent, /链接已更新/);

  // —— 加入清单路径二：没有采集数据时先采集，并把暂存链接带进 payload ——
  const shortLink11 = "https://xhslink.cn/o/note11short";
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_11, resolvedUrl: pageUrlById[11] };
    }
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    if (message.type === "XHS_AI_MERGE_ADD") {
      const item = basketItem(`note:${message.payload.source.noteId}`, message.payload.note.title, {
        link: message.payload.source.givenUrl || message.payload.source.url
      });
      basket = basket.filter((entry) => entry.id !== item.id).concat(item);
      return { ok: true, replaced: false, basket };
    }
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  let resolveElevenCapture;
  setTabHandler(async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    if (message.type === "XHS_CAPTURE_FOR_MERGE") {
      return new Promise((resolve) => {
        resolveElevenCapture = () => resolve({
          ok: true,
          payload: makeCapture(11, "帖文十一", "戊"),
          topLevelCount: 3,
          imageCount: 0
        });
      });
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  });
  await switchChromeTab(11);
  const elevenAddClick = elements["#merge-add-button"].listeners.click();
  await settle();
  assert.equal(findTabMessage("XHS_CAPTURE_FOR_MERGE").length, 1);
  assert.equal(findRuntime("XHS_AI_MERGE_ADD").length, 0);
  // 采集进行中贴入同一帖短链：以入清单那一刻槽位里的暂存链接为准
  elements["#material-input"].value = shortLink11;
  await elements["#material-link-button"].listeners.click();
  await settle(10);
  assert.equal(elements["#material-feedback"].textContent, "链接已更新（未重新推送飞书）。");
  resolveElevenCapture();
  await elevenAddClick;
  await settle(10);
  const addedEleven = findRuntime("XHS_AI_MERGE_ADD")[0];
  assert.ok(addedEleven);
  assert.equal(addedEleven.payload.source.givenUrl, shortLink11);
  assert.equal(addedEleven.payload.source.givenUrlVerified, true);
  assert.equal(elements["#basket-count"].textContent, "5");

  // 清单新增条目后，旧合并结果只能作为「上次合并」查看
  assert.equal(elements["#merge-view-result-button"].hidden, false);
  assert.equal(elements["#merge-view-result-button"].textContent, "查看上次合并结果");
  const mergeCallsBeforeLastView = findRuntime("XHS_AI_MERGE_SUMMARIZE").length;
  await elements["#merge-view-result-button"].listeners.click();
  await settle();
  assert.equal(elements["#result-source-label"].textContent, "上次合并 2 条");
  assert.match(elements["#result-text"].value, /并行合并/);
  assert.equal(findRuntime("XHS_AI_MERGE_SUMMARIZE").length, mergeCallsBeforeLastView);

  await switchChromeTab(8);
  await switchChromeTab(7);

  // —— 修复项 1：提取进行中贴入的链接，完成后立即补到新结果 ——
  const shortLink12 = "https://xhslink.cn/o/note12short";
  let resolveTwelveCapture;
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_12, resolvedUrl: pageUrlById[12] };
    }
    if (message.type === "XHS_AI_RELINK") {
      const source = { ...message.payload.source, givenUrl: message.givenUrl, givenUrlVerified: message.verified };
      return {
        ok: true,
        payload: { ...message.payload, source },
        result: { ...message.result, text: `★ 帖文十二概括\n正文。（小红书 ${message.givenUrl}）` }
      };
    }
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  setTabHandler(async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      assert.equal(message.givenUrl, null);
      return new Promise((resolve) => {
        resolveTwelveCapture = () => resolve({
          ok: true,
          result: makeResult(`★ 帖文十二概括\n正文。（小红书 ${pageUrlById[12]}）`),
          capture: makeCapture(12, "帖文十二", "己")
        });
      });
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  });
  await switchChromeTab(12);
  const twelveExtractClick = elements["#extract-button"].listeners.click();
  await settle();
  assert.equal(taskCount(), 1);
  elements["#material-input"].value = shortLink12;
  await elements["#material-link-button"].listeners.click();
  await settle(10);
  assert.match(elements["#material-feedback"].textContent, /任务完成后自动补上链接/);
  assert.equal(findRuntime("XHS_AI_RELINK").length, 0);
  assert.equal(taskCount(), 1);
  resolveTwelveCapture();
  await twelveExtractClick;
  await settle(12);
  assert.equal(findRuntime("XHS_AI_RELINK").length, 1);
  assert.equal(findRuntime("XHS_AI_RELINK")[0].givenUrl, shortLink12);
  assert.match(elements["#result-text"].value, /note12short/);
  assert.equal(elements["#status-title"].textContent, "链接已更新");
  assert.equal(taskCount(), 0);
  assert.equal(findRuntime("XHS_AI_SUMMARIZE").length, 0);

  // —— 修复项 3：重新生成进行中补链接，任务不提前消失，完成后应用 ——
  await switchChromeTab(7);
  const shortLinkBusy = "https://xhslink.cn/o/busy7";
  let resolveBusyRegenerate;
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_7, resolvedUrl: pageUrlById[7] };
    }
    if (message.type === "XHS_AI_RELINK") {
      const source = { ...message.payload.source, givenUrl: message.givenUrl, givenUrlVerified: message.verified };
      return {
        ok: true,
        payload: { ...message.payload, source },
        result: { ...message.result, text: `★ 第一条概括\n补过链接。（小红书 ${message.givenUrl}）` }
      };
    }
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket };
    if (message.type === "XHS_AI_MERGE_SET_LINK") {
      basket = basket.map((item) => item.id === message.id
        ? { ...item, link: message.givenUrl, linkVerified: message.verified }
        : item);
      return { ok: true, basket };
    }
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  setTabHandler(async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      assert.equal(message.force, true);
      return new Promise((resolve) => {
        resolveBusyRegenerate = () => resolve({
          ok: true,
          result: makeResult(`★ 第一条概括\n旧链接版本。（小红书 ${pageUrlById[7]}）`),
          capture: makeCapture(7, "第一条帖文", "甲")
        });
      });
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  });
  const busyRegenerateClick = elements["#regenerate-button"].listeners.click();
  await settle();
  assert.equal(taskCount(), 1);
  assert.equal(elements["#status-title"].textContent, "正在重新生成");
  elements["#material-input"].value = shortLinkBusy;
  await elements["#material-link-button"].listeners.click();
  await settle(10);
  assert.match(elements["#material-feedback"].textContent, /任务完成后自动补上链接/);
  assert.equal(findRuntime("XHS_AI_RELINK").length, 0);
  assert.equal(taskCount(), 1);
  assert.equal(elements["#status-title"].textContent, "正在重新生成");
  resolveBusyRegenerate();
  await busyRegenerateClick;
  await settle(12);
  assert.equal(findRuntime("XHS_AI_RELINK").length, 1);
  assert.equal(findRuntime("XHS_AI_RELINK")[0].givenUrl, shortLinkBusy);
  assert.match(elements["#result-text"].value, /busy7/);
  assert.equal(elements["#status-title"].textContent, "链接已更新");
  assert.equal(taskCount(), 0);
  assert.ok(findRuntime("XHS_AI_MERGE_SET_LINK").some((message) => message.id === `note:${XHS_NOTE_7}`));

  await switchChromeTab(8);
  await switchChromeTab(7);

  // —— 历史屏：独立状态，可回看、打开原帖、删除与清空 ——
  const historyEntryA = {
    id: "hist-1",
    kind: "single",
    platform: "xiaohongshu",
    title: "历史帖文甲",
    author: "甲",
    url: pageUrlById[7],
    createdAt: Date.now(),
    result: makeResult("★ 历史帖文甲\n历史概括正文。（小红书 https://example.com）")
  };
  const historyEntryB = {
    id: "hist-2",
    kind: "merge",
    platform: null,
    title: "合并 2 条帖文",
    author: null,
    url: null,
    createdAt: Date.now() - 86400000,
    result: makeResult("★ 合并历史\n合并概括正文。")
  };
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_HISTORY_LIST") return { ok: true, items: [historyEntryA, historyEntryB] };
    if (message.type === "XHS_AI_HISTORY_REMOVE") return { ok: true };
    if (message.type === "XHS_AI_HISTORY_CLEAR") return { ok: true };
    return { ok: true };
  });
  await elements["#history-button"].listeners.click();
  await settle();
  assert.equal(elements["#history-button"].dataset.active, "true");
  assert.equal(elements["#view-history"].hidden, false);
  assert.equal(elements["#workspace"].hidden, true);
  assert.equal(elements["#result-card"].hidden, true);
  assert.match(elements["#history-list"].innerHTML, /历史帖文甲/);
  assert.match(elements["#history-list"].innerHTML, /合并历史/);

  const historyTarget = (id, remove = false) => ({
    closest(selector) {
      if (selector === ".history-item") return { dataset: { id } };
      if (selector === ".merge-remove") return remove ? {} : null;
      return null;
    }
  });
  await elements["#history-list"].listeners.click({ target: historyTarget("hist-1") });
  assert.equal(elements["#result-card"].hidden, false);
  assert.equal(elements["#result-source-label"].textContent, "历史");
  assert.match(elements["#result-text"].value, /历史概括正文/);
  assert.equal(elements["#regenerate-button"].hidden, true);
  assert.equal(elements["#open-source-button"].hidden, false);
  assert.equal(elements["#result-link-row"].hidden, true);
  assert.equal(elements["#result-add-basket-button"].hidden, true);
  await elements["#open-source-button"].listeners.click();
  assert.ok(tabsUpdates.some((update) => update.tabId === "create" && update.options.url === pageUrlById[7]));

  await elements["#history-list"].listeners.click({ target: historyTarget("hist-2") });
  assert.equal(elements["#open-source-button"].hidden, true);

  await elements["#history-back-button"].listeners.click();
  assert.equal(elements["#workspace"].hidden, false);
  assert.equal(elements["#view-history"].hidden, true);
  assert.equal(elements["#history-button"].dataset.active, "false");
  assert.equal(elements["#result-source-label"].textContent, "当前页签");
  assert.equal(elements["#result-link-row"].hidden, false);

  await elements["#history-button"].listeners.click();
  await settle();
  await elements["#history-list"].listeners.click({ target: historyTarget("hist-1") });
  await elements["#history-list"].listeners.click({ target: historyTarget("hist-1", true) });
  assert.equal(elements["#result-card"].hidden, true);

  await elements["#history-clear-button"].listeners.click();
  assert.equal(elements["#history-clear-button"].textContent, "再点一次确认清空");
  assert.equal(elements["#history-clear-button"].dataset.confirming, "true");
  await elements["#history-clear-button"].listeners.click();
  assert.equal(elements["#history-list"].hidden, true);
  assert.equal(elements["#history-clear-button"].hidden, true);
  assert.equal(elements["#result-card"].hidden, true);

  // —— 补链接：编辑过的结果无法自动替换时，用提示态显示 kept 文案 ——
  assert.equal(context.relinkFeedbackText("kept"), "链接已记录，但概括正文编辑过，未能自动替换，请手动修改。");
  assert.equal(context.relinkFeedbackText("rerendered"), "链接已更新（未重新推送飞书）。");
  await elements["#history-back-button"].listeners.click();
  await switchChromeTab(7);
  assert.equal(elements["#result-card"].hidden, false);
  context.clearMaterialFeedback();
  const keptEditedText = "★ 第一条概括\n用户编辑后的正文。（小红书 https://xhslink.cn/o/old-kept）";
  elements["#result-text"].value = keptEditedText;
  elements["#result-text"].listeners.input();
  setRuntime(async (message) => {
    if (message.type === "XHS_AI_RESOLVE_LINK") {
      return { ok: true, platform: "xiaohongshu", noteId: XHS_NOTE_7, resolvedUrl: pageUrlById[7] };
    }
    if (message.type === "XHS_AI_RELINK") {
      return {
        ok: true,
        payload: message.payload,
        result: { ...message.result, text: message.result.text, renderedText: message.result.text },
        linkApplied: "kept"
      };
    }
    if (message.type === "XHS_AI_MERGE_SET_LINK") return { ok: true, basket };
    if (message.type === "XHS_AI_MERGE_RERENDER") return { ok: true, unchanged: true };
    return { ok: true };
  });
  elements["#result-link-edit"].listeners.click();
  elements["#result-link-input"].value = "https://xhslink.cn/o/new-kept";
  await elements["#result-link-save"].listeners.click();
  await settle(10);
  const keptRelink = findRuntime("XHS_AI_RELINK")[0];
  assert.ok(keptRelink);
  assert.equal(keptRelink.result.text, keptEditedText);
  assert.equal(elements["#result-text"].value, keptEditedText);
  assert.equal(
    elements["#material-feedback"].textContent,
    "链接已记录，但概括正文编辑过，未能自动替换，请手动修改。"
  );
  assert.equal(elements["#material-feedback"].dataset.state, "info");

  // —— 解析工具：小红书短链/长链、微博长链、非帖文地址 ——
  assert.equal(
    context.extractPostUrl("已经精疲力尽了 https://xhslink.cn/o/8Edwk521FBf \n先复制这段，去【小红书】看看有多精彩~"),
    "https://xhslink.cn/o/8Edwk521FBf"
  );
  assert.equal(
    context.extractPostUrl("https://www.xiaohongshu.com/explore/6a76029300000000250070c1?xsec_token=abc，看看！"),
    "https://www.xiaohongshu.com/explore/6a76029300000000250070c1?xsec_token=abc"
  );
  assert.equal(
    context.extractPostUrl("https://www.xiaohongshu.com/discovery/item/6ab3c400000000000200d10e?xsec_source=app_share"),
    "https://www.xiaohongshu.com/discovery/item/6ab3c400000000000200d10e?xsec_source=app_share"
  );
  assert.equal(
    context.extractPostUrl("https://weibo.com/1257000310/RhJDvgyf3"),
    "https://weibo.com/1257000310/RhJDvgyf3"
  );
  assert.equal(context.extractPostUrl("主页在这 https://www.xiaohongshu.com/user/profile/abc"), null);
  assert.equal(
    context.extractPostUrl("http://xhslink.cn/o/1qbjU0B1ODG"),
    "https://xhslink.cn/o/1qbjU0B1ODG"
  );
  assert.equal(context.extractPostUrl("这段文案里没有链接"), null);

  process.stdout.write("panel unified workspace tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
