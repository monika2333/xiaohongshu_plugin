const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createElement() {
  return {
    hidden: true,
    disabled: false,
    checked: true,
    textContent: "",
    value: "",
    dataset: {},
    style: {},
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    select() {},
    after() {},
    appendChild() {},
    insertBefore() {}
  };
}

const selectors = [
  ".view-tabs",
  "#extract-button",
  ".button-label",
  "#settings-button",
  "#task-strip",
  "#task-list",
  "#status-card",
  "#status-title",
  "#status-detail",
  "#status-count",
  "#progress-bar",
  "#result-card",
  "#result-text",
  "#result-time",
  "#evidence-summary",
  "#copy-button",
  "#regenerate-button",
  "#merge-add-button",
  "#merge-dropzone",
  "#screenshot-staging",
  "#screenshot-run",
  "#screenshot-input",
  "#screenshot-url",
  "#merge-list",
  "#merge-summarize-button",
  "#merge-summarize-label",
  "#merge-clear-button",
  "#history-button",
  "#history-back-button",
  "#view-history",
  "#history-hint",
  "#history-list",
  "#history-clear-button",
  "#open-source-button",
  "#tab-single",
  "#tab-merge",
  "#view-single",
  "#view-merge",
  "#shot-single-dropzone",
  "#shot-single-staging",
  "#shot-single-run",
  "#shot-single-input",
  "#shot-single-url",
  "#link-input",
  "#link-run"
];
const elements = Object.fromEntries(selectors.map((selector) => [selector, createElement()]));
const pageUrlById = {
  7: "https://www.xiaohongshu.com/explore/6a76029300000000250070c1?xsec_token=test-token",
  8: "https://www.xiaohongshu.com/explore/6a76029300000000250070c2?xsec_token=test-token-8",
  9: "https://weibo.com/1257000310/RhJDvgyf3"
};
const sessionById = { 7: "page-session-7", 8: "page-session-8", 9: "page-session-9" };
let activeTabIdMock = 7;
const tabsUpdates = [];
const windowsUpdates = [];
let tabsActivatedListener = null;
let tabsRemovedListener = null;
let runtimeListener = null;
const documentListeners = {};

function pageContextFor(tabId) {
  return {
    ok: true,
    tabId,
    pageSessionId: sessionById[tabId],
    pageUrl: pageUrlById[tabId],
    noteId: String(tabId)
  };
}

// 工作流广播的公共形态：noteTitle 是任务列表展示的标题
function workflowMessage(tabId, overrides = {}) {
  return {
    tabId,
    pageSessionId: sessionById[tabId],
    pageUrl: pageUrlById[tabId],
    noteTitle: `第${tabId}条帖文`,
    ...overrides
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
      sendMessage: async (message) => ({ ok: true })
    },
    scripting: { executeScript: async () => [] },
    tabs: {
      query: async () => [{ id: activeTabIdMock, url: pageUrlById[activeTabIdMock] }],
      update: async (tabId, options) => {
        tabsUpdates.push({ tabId, options });
        return { id: tabId, windowId: 3 };
      },
      create: async (options) => {
        tabsUpdates.push({ tabId: "create", options });
        return { id: 99 };
      },
      onActivated: { addListener(listener) { tabsActivatedListener = listener; } },
      onRemoved: { addListener(listener) { tabsRemovedListener = listener; } },
      sendMessage: async (_tabId, message) => {
        throw new Error(`Unexpected tab message: ${message.type}`);
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

async function settle(rounds = 4) {
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

(async () => {
  // 启动时的 GET_WORKFLOW：当前页签（7）有一条进行中的任务
  context.chrome.runtime.sendMessage = async (message) => {
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
    return { ok: true };
  };
  context.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    throw new Error(`Unexpected tab message: ${message.type}`);
  };

  await settle();

  // —— 启动：恢复当前页签的进行中任务；任务条常驻可见 ——
  assert.equal(elements["#extract-button"].disabled, true);
  assert.equal(elements[".button-label"].textContent, "正在处理…");
  assert.equal(elements["#status-title"].textContent, "正在读取评论");
  assert.equal(elements["#status-detail"].textContent, "已加载 17 条一级评论");
  assert.equal(elements["#status-count"].textContent, "17 / 50");
  assert.equal(elements["#result-card"].hidden, true);
  assert.equal(elements["#task-strip"].hidden, false);
  assert.equal(taskCount(), 1);
  assert.match(elements["#task-list"].innerHTML, /第7条帖文/);
  assert.match(elements["#task-list"].innerHTML, /task-spinner/);
  assert.match(elements["#task-list"].innerHTML, /merge-badge-page/);

  // —— 第二个页签并行概括：任务条出现第二条，当前视图不受打扰 ——
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
  // 活动页签（7）忙，按钮仍然禁用
  assert.equal(elements["#extract-button"].disabled, true);

  // —— 切到页签 8：单条视图跟随显示页签 8 的进度 ——
  await switchChromeTab(8);
  assert.equal(elements["#status-title"].textContent, "正在撰写概括");
  assert.equal(elements["#regenerate-button"].disabled, true);

  // 页签 8 完成：结果落页签 8，任务条剩一条
  runtimeListener({
    type: "XHS_AI_WORKFLOW_STATE",
    workflow: workflowMessage(8, {
      status: "done",
      capture: { source: { pageSessionId: sessionById[8], url: pageUrlById[8] }, note: { title: "第二条帖文", author: "乙" } },
      result: {
        text: "★ 第二条概括\n第二条正文。（小红书 https://example.com/8）",
        createdAt: Date.now(),
        evidence: { topLevelComments: 9, visibleReplies: 0, imagesFound: 0, imagesAnalyzed: 0, textModel: "deepseek-v4-flash" },
        notification: null
      },
      progress: { state: "done", title: "概括完成", detail: "已按固定格式生成，可直接复制。", percent: 100 }
    })
  });
  assert.equal(taskCount(), 1);
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /第二条概括/);
  assert.equal(elements["#status-title"].textContent, "概括完成");
  assert.equal(elements["#status-count"].textContent, "100%");
  // 页签 8 自己的任务结束，即使页签 7 还在跑，当前页签的按钮也恢复可用
  assert.equal(elements["#extract-button"].disabled, false);

  // —— 切回页签 7：显示页签 7 自己的进度，页签 8 的结果不带过来 ——
  await switchChromeTab(7);
  assert.equal(elements["#status-title"].textContent, "正在读取评论");
  assert.equal(elements["#result-card"].hidden, true);

  runtimeListener({
    type: "XHS_AI_WORKFLOW_STATE",
    workflow: workflowMessage(7, {
      status: "done",
      capture: { source: { pageSessionId: sessionById[7], url: pageUrlById[7] }, note: { title: "第一条帖文", author: "甲" } },
      result: {
        text: "★ 第一条概括\n第一条正文。（小红书 https://example.com/7）",
        createdAt: Date.now(),
        evidence: { topLevelComments: 17, visibleReplies: 2, imagesFound: 3, imagesAnalyzed: 3, textModel: "deepseek-v4-flash" },
        notification: null
      },
      progress: { state: "done", title: "概括完成", detail: "已按固定格式生成，可直接复制。", percent: 100 }
    })
  });
  assert.equal(elements["#extract-button"].disabled, false);
  assert.equal(elements[".button-label"].textContent, "提取并概括");
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /第一条概括/);
  assert.doesNotMatch(elements["#result-text"].value, /第二条概括/);
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
  assert.equal(windowsUpdates[0].windowId, 3);
  assert.equal(windowsUpdates[0].options.focused, true);

  // 切到页签 9 但页面会话已变：旧槽位作废，状态回默认；任务条仍在转圈
  context.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") {
      return { ...pageContextFor(tabId), pageSessionId: `${sessionById[tabId]}-changed` };
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  };
  await switchChromeTab(9);
  assert.equal(elements["#status-title"].textContent, "准备就绪");
  assert.equal(elements["#result-card"].hidden, true);
  assert.equal(taskCount(), 1);
  // 页签 9 关闭：任务条立即清理，不留死条目
  await tabsRemovedListener(9);
  assert.equal(taskCount(), 0);
  assert.equal(elements["#task-strip"].hidden, true);
  assert.equal(elements["#extract-button"].disabled, false);

  // —— 合并概括与页签任务并行：合并任务只禁用合并按钮 ——
  const basketItem = {
    id: "note:6a76029300000000250070c1",
    kind: "live_page",
    platform: "xiaohongshu",
    title: "合并帖文甲",
    author: "甲",
    publishedDisplay: "09-10",
    commentCount: 3,
    imageCount: 0,
    hasUrl: true,
    addedAt: Date.now()
  };
  const mergePayload = {
    source: { platform: "xiaohongshu", noteId: "6a76029300000000250070c1", url: pageUrlById[7] },
    note: { title: "合并帖文甲", author: "甲", publishedDisplay: "09-10" },
    commentExport: { extractedTopLevelCount: 3 },
    media: { images: [] }
  };
  context.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    if (message.type === "XHS_CAPTURE_FOR_MERGE") return { ok: true, payload: mergePayload, topLevelCount: 3, imageCount: 0 };
    throw new Error(`Unexpected tab message: ${message.type}`);
  };
  await switchChromeTab(7);
  let resolveMergeSummarize = null;
  context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket: [basketItem] };
    if (message.type === "XHS_AI_MERGE_ADD") return { ok: true, replaced: false, basket: [basketItem] };
    if (message.type === "XHS_AI_MERGE_SUMMARIZE") {
      return new Promise((resolve) => { resolveMergeSummarize = resolve; });
    }
    return { ok: true };
  };

  await elements["#tab-merge"].listeners.click();
  assert.equal(elements["#view-merge"].hidden, false);
  // 合并页签还没有自己的结果，结果卡隐藏；状态是默认文案
  assert.equal(elements["#result-card"].hidden, true);
  assert.equal(elements["#status-title"].textContent, "准备就绪");

  // 先把当前帖文加入清单（清单数据来自 MERGE_ADD 的返回）
  await elements["#merge-add-button"].listeners.click();
  assert.equal(elements["#status-title"].textContent, "已加入合并清单");
  assert.equal(elements["#merge-list"].hidden, false);
  assert.match(elements["#merge-list"].innerHTML, /合并帖文甲/);
  assert.equal(elements["#merge-summarize-button"].hidden, false);
  assert.equal(elements["#merge-summarize-label"].textContent, "概括这条帖文");

  const mergeClick = elements["#merge-summarize-button"].listeners.click();
  await settle();
  assert.equal(elements["#status-title"].textContent, "正在合并概括");
  assert.equal(taskCount(), 1);
  assert.match(elements["#task-list"].innerHTML, /merge-badge-merge/);
  assert.equal(elements["#merge-summarize-button"].disabled, true);
  // 合并概括进行中，页签操作照常可用
  assert.equal(elements["#extract-button"].disabled, false);
  assert.equal(elements["#merge-add-button"].disabled, false);

  runtimeListener({
    type: "XHS_AI_MERGE_PROGRESS",
    progress: { stage: "vision", percent: 40, detail: "帖文 1/1：准备识别 3 张图片" }
  });
  assert.equal(elements["#status-title"].textContent, "正在识别图片");
  // 合并进度不影响任务条上的页签条目数
  assert.equal(taskCount(), 1);

  resolveMergeSummarize({
    ok: true,
    result: {
      text: "★ 合并概括测试\n9月10日，甲发帖。（小红书 https://example.com/a）",
      createdAt: Date.now(),
      postCount: 2,
      evidence: { postCount: 2, topLevelComments: 6, visibleReplies: 1, imagesFound: 0, imagesAnalyzed: 0, textModel: "deepseek-v4-flash" },
      notification: null
    }
  });
  await mergeClick;
  assert.equal(elements["#status-title"].textContent, "合并概括完成");
  assert.equal(elements["#status-count"].textContent, "100%");
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /合并概括测试/);
  assert.match(elements["#evidence-summary"].textContent, /2 条帖文/);
  assert.equal(taskCount(), 0);
  assert.equal(elements["#merge-summarize-button"].disabled, false);

  // 合并页签内“重新生成”走合并概括
  context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "XHS_AI_MERGE_SUMMARIZE") {
      return {
        ok: true,
        result: {
          text: "★ 合并概括测试\n9月10日，甲发帖。（小红书 https://example.com/a）",
          createdAt: Date.now(),
          postCount: 2,
          evidence: { postCount: 2, topLevelComments: 6, visibleReplies: 1, imagesFound: 0, imagesAnalyzed: 0, textModel: "deepseek-v4-flash" },
          notification: null
        }
      };
    }
    return { ok: true };
  };
  await elements["#regenerate-button"].listeners.click();
  assert.equal(elements["#status-title"].textContent, "重新生成完成");

  // —— 切回单条页签：显示页签 7 自己的结果，合并结果不带过来 ——
  await elements["#tab-single"].listeners.click();
  assert.equal(elements["#view-single"].hidden, false);
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /第一条概括/);
  assert.doesNotMatch(elements["#result-text"].value, /合并概括测试/);
  assert.equal(elements["#status-title"].textContent, "概括完成");

  // —— 页签 7 重新生成：只锁页签 7 的按钮，任务条同步转圈 ——
  let resolveRegenerate = null;
  context.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContextFor(tabId);
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      assert.equal(tabId, 7);
      assert.equal(message.force, true);
      return new Promise((resolve) => { resolveRegenerate = resolve; });
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  };
  const regenerateClick = elements["#regenerate-button"].listeners.click();
  await settle();
  assert.equal(elements["#status-title"].textContent, "正在重新生成");
  assert.equal(elements["#extract-button"].disabled, true);
  assert.equal(elements["#regenerate-button"].disabled, true);
  assert.equal(taskCount(), 1);
  // 任务标题取采集证据里的帖文标题
  assert.match(elements["#task-list"].innerHTML, /第一条帖文/);
  resolveRegenerate({
    ok: true,
    result: {
      text: "★ 第一条概括（新版本）\n第一条正文二。（小红书 https://example.com/7）",
      createdAt: Date.now(),
      evidence: { topLevelComments: 17, visibleReplies: 2, imagesFound: 3, imagesAnalyzed: 3, textModel: "deepseek-v4-flash" },
      notification: null
    },
    capture: { source: { pageSessionId: sessionById[7], url: pageUrlById[7] }, note: { title: "第一条帖文", author: "甲" } }
  });
  await regenerateClick;
  assert.equal(elements["#status-title"].textContent, "重新生成完成");
  assert.match(elements["#result-text"].value, /新版本/);
  assert.equal(taskCount(), 0);
  assert.equal(elements["#extract-button"].disabled, false);

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

  // —— 截图识别概括与页签任务并行：只禁用自己的运行按钮 ——
  elements["#shot-single-url"].value = " https://xhslink.cn/o/abc ";
  elements["#shot-single-input"].files = [{ name: "shot.png", type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }];
  await elements["#shot-single-input"].listeners.change();
  await settle();
  assert.equal(elements["#shot-single-staging"].hidden, false);
  assert.match(elements["#shot-single-run"].textContent, /识别这张截图并概括/);

  let resolveScreenshotSummarize = null;
  context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "XHS_AI_SCREENSHOT_RECOGNIZE") {
      return {
        ok: true,
        payload: {
          source: { platform: "xiaohongshu", noteId: null, url: "https://xhslink.cn/o/abc", origin: "user_screenshot" },
          note: { title: "截图帖文", author: "截图作者" },
          commentExport: { extractedTopLevelCount: 2 },
          media: { images: [] }
        },
        warnings: []
      };
    }
    if (message.type === "XHS_AI_SUMMARIZE") {
      assert.equal(message.payload.source.origin, "user_screenshot");
      return new Promise((resolve) => { resolveScreenshotSummarize = resolve; });
    }
    return { ok: true };
  };
  const shotClick = elements["#shot-single-run"].listeners.click();
  await settle();
  // 识别桩立即返回，此时已进入撰写概括阶段，任务条与按钮锁定同步生效
  assert.equal(elements["#status-title"].textContent, "正在撰写概括");
  assert.equal(taskCount(), 1);
  assert.match(elements["#task-list"].innerHTML, /merge-badge-shot/);
  assert.equal(elements["#shot-single-run"].disabled, true);
  // 截图识别进行中，页签操作照常可用
  assert.equal(elements["#extract-button"].disabled, false);
  resolveScreenshotSummarize({
    ok: true,
    result: {
      text: "★ 截图帖文事件\n据截图整理。（小红书 https://xhslink.cn/o/abc）",
      createdAt: Date.now(),
      evidence: { topLevelComments: 2, visibleReplies: 0, imagesFound: 0, imagesAnalyzed: 0, textModel: "deepseek-v4-flash" },
      notification: null
    }
  });
  await shotClick;
  assert.equal(elements["#status-title"].textContent, "截图概括完成");
  assert.match(elements["#result-text"].value, /截图帖文事件/);
  assert.equal(elements["#shot-single-url"].value, "");
  assert.equal(elements["#shot-single-staging"].hidden, true);
  assert.equal(elements["#shot-single-run"].hidden, true);
  assert.equal(taskCount(), 0);

  // 后续截图运行改为立即返回的桩（不再用需要手动 resolve 的 deferred）
  const shotPayload = {
    source: { platform: "xiaohongshu", noteId: null, url: "https://xhslink.cn/o/abc", origin: "user_screenshot" },
    note: { title: "截图帖文", author: "截图作者" },
    commentExport: { extractedTopLevelCount: 2 },
    media: { images: [] }
  };
  const shotResult = {
    text: "★ 截图帖文事件\n据截图整理。（小红书 https://xhslink.cn/o/abc）",
    createdAt: Date.now(),
    evidence: { topLevelComments: 2, visibleReplies: 0, imagesFound: 0, imagesAnalyzed: 0, textModel: "deepseek-v4-flash" },
    notification: null
  };
  context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "XHS_AI_SCREENSHOT_RECOGNIZE") return { ok: true, payload: shotPayload, warnings: [] };
    if (message.type === "XHS_AI_SUMMARIZE") return { ok: true, result: shotResult };
    return { ok: true };
  };

  // —— 剪贴板粘贴进暂存区（单条视图），两张一起提交 ——
  const pasteImage = (name) => makeDataTransferEvent({
    files: [{ name, type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }]
  });
  documentListeners.paste(pasteImage("paste-1.png"));
  await settle();
  assert.equal(elements["#shot-single-staging"].hidden, false);
  documentListeners.paste(pasteImage("paste-2.png"));
  await settle();
  assert.match(elements["#shot-single-run"].textContent, /识别这 2 张截图并概括/);
  await elements["#shot-single-run"].listeners.click();
  await settle();
  assert.equal(elements["#status-title"].textContent, "截图概括完成");
  assert.equal(elements["#shot-single-staging"].hidden, true);

  // 纯文本粘贴（如往链接框贴 URL）不拦截、不进暂存区
  const textPasteEvent = makeDataTransferEvent({ files: [] });
  documentListeners.paste(textPasteEvent);
  await settle();
  assert.equal(textPasteEvent.defaultPrevented, false);
  assert.equal(elements["#shot-single-staging"].hidden, true);

  // —— 拖拽进暂存区（合并视图），按钮提交后加入清单 ——
  await elements["#tab-merge"].listeners.click();
  context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "XHS_AI_SCREENSHOT_ADD") {
      return { ok: true, basket: [basketItem], warnings: [] };
    }
    return { ok: true };
  };
  documentListeners.drop(makeDataTransferEvent({
    types: ["Files"],
    files: [{ name: "shot-2.png", type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }]
  }));
  await settle();
  assert.equal(elements["#screenshot-staging"].hidden, false);
  assert.match(elements["#screenshot-run"].textContent, /识别这张截图并加入清单/);
  await elements["#screenshot-run"].listeners.click();
  await settle();
  assert.equal(elements["#status-title"].textContent, "截图已识别并加入清单");
  assert.equal(elements["#screenshot-staging"].hidden, true);

  const nonImageDropEvent = makeDataTransferEvent({
    types: ["Files"],
    files: [{ name: "notes.txt", type: "text/plain", size: 10 }]
  });
  documentListeners.drop(nonImageDropEvent);
  await settle();
  assert.equal(nonImageDropEvent.defaultPrevented, true);
  assert.equal(elements["#screenshot-staging"].hidden, true);

  // —— 页眉「历史」按钮与历史屏 ——
  const historyEntryA = {
    id: "hist-1",
    kind: "single",
    platform: "xiaohongshu",
    title: "历史帖文甲",
    author: "甲",
    url: pageUrlById[7],
    createdAt: Date.now(),
    result: {
      text: "★ 历史帖文甲\n历史概括正文。（小红书 https://example.com）",
      createdAt: Date.now(),
      evidence: { topLevelComments: 5, visibleReplies: 0, imagesFound: 0, imagesAnalyzed: 0, textModel: "deepseek-v4-flash" },
      notification: null
    }
  };
  const historyEntryB = {
    id: "hist-2",
    kind: "merge",
    platform: null,
    title: "合并 2 条帖文",
    author: null,
    url: null,
    createdAt: Date.now() - 86400000,
    result: {
      text: "★ 合并历史\n合并概括正文。",
      createdAt: Date.now() - 86400000,
      evidence: {},
      notification: null
    }
  };
  context.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "XHS_AI_HISTORY_LIST") return { ok: true, items: [historyEntryA, historyEntryB] };
    if (message.type === "XHS_AI_HISTORY_REMOVE") return { ok: true };
    if (message.type === "XHS_AI_HISTORY_CLEAR") return { ok: true };
    return { ok: true };
  };

  await elements["#history-button"].listeners.click();
  assert.equal(elements["#history-button"].dataset.active, "true");
  assert.equal(elements["#view-history"].hidden, false);
  assert.equal(elements["#view-single"].hidden, true);
  assert.equal(elements["#view-merge"].hidden, true);
  // 历史屏没有进度可言，状态卡隐藏；概括页签栏也一并收起
  assert.equal(elements["#status-card"].hidden, true);
  assert.equal(elements[".view-tabs"].hidden, true);
  await settle();
  assert.equal(elements["#history-list"].hidden, false);
  // 条目标题用概括自身的标题行（去掉星号），不再显示“作者：帖文标题”
  assert.match(elements["#history-list"].innerHTML, /历史帖文甲/);
  assert.doesNotMatch(elements["#history-list"].innerHTML, /甲：历史帖文甲/);
  assert.match(elements["#history-list"].innerHTML, /合并历史/);
  assert.doesNotMatch(elements["#history-list"].innerHTML, /合并 2 条帖文/);
  assert.equal(elements["#history-clear-button"].hidden, false);

  const historyTarget = (id, remove = false) => ({
    closest(selector) {
      if (selector === ".history-item") return { dataset: { id } };
      if (selector === ".merge-remove") return remove ? {} : null;
      return null;
    }
  });

  // 点击条目：结果卡进入只读态，可复制、可打开原帖，不能重新生成
  await elements["#history-list"].listeners.click({ target: historyTarget("hist-1") });
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /历史概括正文/);
  assert.equal(elements["#regenerate-button"].hidden, true);
  assert.equal(elements["#open-source-button"].hidden, false);

  await elements["#open-source-button"].listeners.click();
  assert.equal(tabsUpdates.length, 2);
  assert.equal(tabsUpdates[1].options.url, pageUrlById[7]);
  assert.equal(tabsUpdates[1].options.active, true);

  await elements["#history-list"].listeners.click({ target: historyTarget("hist-2") });
  assert.equal(elements["#open-source-button"].hidden, true);

  // 切回单条页签：历史结果不串页签，结果卡回到页签自己的实时结果，状态卡恢复显示
  await elements["#tab-single"].listeners.click();
  assert.equal(elements["#view-history"].hidden, true);
  assert.equal(elements["#history-button"].dataset.active, "false");
  assert.equal(elements["#status-card"].hidden, false);
  assert.equal(elements[".view-tabs"].hidden, false);
  assert.match(elements["#result-text"].value, /截图帖文事件/);
  assert.equal(elements["#regenerate-button"].hidden, false);
  assert.equal(elements["#open-source-button"].hidden, true);

  // 再进历史屏：上次选中的条目被重放
  await elements["#history-button"].listeners.click();
  await settle();
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /合并概括正文/);
  assert.equal(elements["#regenerate-button"].hidden, true);

  // 历史屏内再点「历史」按钮：回到进入前的单条页签
  await elements["#history-button"].listeners.click();
  assert.equal(elements["#view-single"].hidden, false);
  assert.equal(elements["#view-history"].hidden, true);

  // 标题旁的返回按钮：同样回到进入前的单条页签
  await elements["#history-button"].listeners.click();
  await elements["#history-back-button"].listeners.click();
  assert.equal(elements["#view-single"].hidden, false);
  assert.equal(elements["#view-history"].hidden, true);
  assert.equal(elements["#history-button"].dataset.active, "false");

  // 回到历史屏删除正在查看的条目，结果卡收起
  await elements["#history-button"].listeners.click();
  await settle();
  await elements["#history-list"].listeners.click({ target: historyTarget("hist-1") });
  await elements["#history-list"].listeners.click({ target: historyTarget("hist-1", true) });
  assert.equal(elements["#result-card"].hidden, true);

  // 清空历史：两步确认
  await elements["#history-clear-button"].listeners.click();
  assert.equal(elements["#history-clear-button"].textContent, "再点一次确认清空");
  assert.equal(elements["#history-clear-button"].dataset.confirming, "true");
  await elements["#history-clear-button"].listeners.click();
  assert.equal(elements["#history-list"].hidden, true);
  assert.equal(elements["#history-clear-button"].hidden, true);
  assert.equal(elements["#result-card"].hidden, true);

  // —— 链接概括：短链提取、discovery 落地改写 explore、givenUrl 透传 ——
  // 前面历史测试停在历史屏、焦点留在截图任务上：先回单条页签并切页签刷新焦点
  await elements["#tab-single"].listeners.click();
  await switchChromeTab(8);
  assert.match(elements["#status-title"].textContent, /概括完成|准备就绪/);
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
  assert.equal(context.extractPostUrl("主页在这 https://www.xiaohongshu.com/user/profile/abc"), null);
  assert.equal(context.extractPostUrl("http://xhslink.cn/o/not-https"), null);
  assert.equal(context.extractPostUrl("这段文案里没有链接"), null);

  // 无链接输入：不开页签，错误落在当前页签槽位
  const createCountBefore = tabsUpdates.filter((update) => update.tabId === "create").length;
  elements["#link-input"].value = "这段文案里没有链接";
  await elements["#link-run"].listeners.click();
  await settle();
  assert.equal(elements["#status-title"].textContent, "未能概括链接");
  assert.equal(tabsUpdates.filter((update) => update.tabId === "create").length, createCountBefore);

  // 完整流程：短链开页签 → discovery 落地改写 explore → 采集概括沿用短链
  sessionById[99] = "page-session-99";
  pageUrlById[99] = "https://www.xiaohongshu.com/explore/6ab3c400000000000200d10e?xsec_token=tok&xsec_source=app_share";
  const shortLink = "https://xhslink.cn/o/8Edwk521FBf";
  elements["#link-input"].value = `已经精疲力尽了 ${shortLink} \n先复制这段，去【小红书】看看有多精彩~`;
  tabsUpdates.length = 0;
  const tabUrlQueue = [
    shortLink,
    "https://www.xiaohongshu.com/discovery/item/6ab3c400000000000200d10e?xsec_token=tok&xsec_source=app_share"
  ];
  context.chrome.tabs.get = async (tabId) => ({
    id: tabId,
    url: tabUrlQueue.length ? tabUrlQueue.shift() : pageUrlById[99]
  });
  context.chrome.tabs.create = async (options) => {
    tabsUpdates.push({ tabId: "create", options });
    // 真实浏览器里 tabs.create(active) 会触发 onActivated
    void tabsActivatedListener({ tabId: 99 });
    return { id: 99, windowId: 3 };
  };
  let linkCaptureMessage = null;
  context.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return { ...pageContextFor(tabId), detailReady: true };
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      linkCaptureMessage = message;
      return {
        ok: true,
        result: {
          text: "★ 短链帖文概括\n正文。（小红书 https://xhslink.cn/o/8Edwk521FBf）",
          createdAt: Date.now(),
          evidence: { topLevelComments: 8, visibleReplies: 0, imagesFound: 1, imagesAnalyzed: 1, textModel: "deepseek-v4-flash" },
          notification: null
        },
        capture: { source: { pageSessionId: sessionById[99], url: pageUrlById[99] }, note: { title: "短链帖文", author: "丙" } }
      };
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  };
  const fastSetTimeout = context.setTimeout;
  context.setTimeout = (fn) => fastSetTimeout(fn, 0);
  const linkClick = elements["#link-run"].listeners.click();
  await settle(12);
  await linkClick;
  context.setTimeout = fastSetTimeout;

  assert.ok(tabsUpdates.some((update) => update.tabId === "create" && update.options.url === shortLink), "开页签应沿用给定短链");
  const rewrite = tabsUpdates.find((update) => update.tabId === 99);
  assert.ok(rewrite, "discovery 落地页应改写为 explore");
  assert.match(rewrite.options.url, /www\.xiaohongshu\.com\/explore\/6ab3c400000000000200d10e\?xsec_token=tok/);
  assert.ok(linkCaptureMessage);
  assert.equal(linkCaptureMessage.givenUrl, shortLink);
  assert.equal(elements["#status-title"].textContent, "概括完成");
  assert.match(elements["#result-text"].value, /短链帖文概括/);
  assert.equal(elements["#link-input"].value, "");
  assert.equal(taskCount(), 0);

  process.stdout.write("panel parallel workflow tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
