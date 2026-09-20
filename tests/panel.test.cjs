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
  "#extract-button",
  ".button-label",
  "#settings-button",
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
  "#view-history",
  "#history-panel",
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
  "#shot-single-url"
];
const elements = Object.fromEntries(selectors.map((selector) => [selector, createElement()]));
const pageUrl = "https://www.xiaohongshu.com/explore/6a76029300000000250070c1?xsec_token=test-token";
const pageContext = {
  ok: true,
  tabId: 7,
  pageSessionId: "page-session-1",
  pageUrl,
  noteId: "6a76029300000000250070c1"
};
let runtimeListener = null;
const documentListeners = {};

const context = {
  chrome: {
    cookies: {
      get: async () => ({ name: "web_session", value: "logged-in-session" })
    },
    runtime: {
      onMessage: { addListener(listener) { runtimeListener = listener; } },
      openOptionsPage() {},
      sendMessage: async (message) => {
        if (message.type !== "XHS_AI_GET_WORKFLOW") return { ok: true };
        return {
          ok: true,
          workflow: {
            tabId: 7,
            pageSessionId: "page-session-1",
            pageUrl,
            status: "working",
            progress: {
              state: "working",
              title: "正在读取评论",
              detail: "已加载 17 条一级评论",
              percent: 10,
              count: 17
            }
          }
        };
      }
    },
    scripting: { executeScript: async () => [] },
    tabs: {
      query: async () => [{ id: 7, url: pageUrl }],
      sendMessage: async (_tabId, message) => {
        if (message.type === "XHS_PAGE_CONTEXT") return pageContext;
        throw new Error(`Unexpected tab message: ${message.type}`);
      }
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

async function settle() {
  for (let index = 0; index < 2; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

(async () => {
  await settle();

  // —— 启动：恢复单条工作流进度（只属于单条页签） ——
  assert.equal(elements["#extract-button"].disabled, true);
  assert.equal(elements[".button-label"].textContent, "正在处理…");
  assert.equal(elements["#status-title"].textContent, "正在读取评论");
  assert.equal(elements["#status-detail"].textContent, "已加载 17 条一级评论");
  assert.equal(elements["#status-count"].textContent, "17 / 50");
  assert.equal(elements["#result-card"].hidden, true);

  // 单条页签可见时，合并进度不得推进可见状态卡
  runtimeListener({
    type: "XHS_AI_MERGE_PROGRESS",
    progress: { stage: "vision", percent: 40, detail: "帖文 1/2：准备识别 3 张图片" }
  });
  assert.equal(elements["#status-title"].textContent, "正在读取评论");
  // 切到合并页签后能看到合并进度；切回单条页签恢复自己的进度
  await elements["#tab-merge"].listeners.click();
  assert.equal(elements["#status-title"].textContent, "正在识别图片");
  assert.equal(elements["#status-detail"].textContent, "帖文 1/2：准备识别 3 张图片");
  await elements["#tab-single"].listeners.click();
  assert.equal(elements["#status-title"].textContent, "正在读取评论");

  runtimeListener({
    type: "XHS_AI_WORKFLOW_STATE",
    workflow: {
      tabId: 7,
      pageSessionId: "page-session-1",
      pageUrl,
      status: "done",
      capture: { source: { pageSessionId: "page-session-1", url: pageUrl } },
      result: {
        text: "★ 测试概括\n测试正文。（小红书 https://example.com）",
        createdAt: Date.now(),
        evidence: {
          topLevelComments: 17,
          visibleReplies: 2,
          imagesFound: 3,
          imagesAnalyzed: 3,
          textModel: "deepseek-v4-flash"
        }
      },
      progress: {
        state: "done",
        title: "概括完成",
        detail: "已按固定格式生成，可直接复制。",
        percent: 100
      }
    }
  });

  assert.equal(elements["#extract-button"].disabled, false);
  assert.equal(elements[".button-label"].textContent, "提取并概括");
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /测试概括/);
  assert.equal(elements["#status-title"].textContent, "概括完成");
  assert.equal(elements["#status-count"].textContent, "100%");

  // —— 合并清单 UI ——
  const mergePayload = {
    source: { platform: "xiaohongshu", noteId: "6a76029300000000250070c1", url: pageUrl },
    note: { title: "合并帖文甲", author: "甲", publishedDisplay: "09-10" },
    commentExport: { extractedTopLevelCount: 3 },
    media: { images: [] }
  };
  context.chrome.tabs.sendMessage = async (_tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContext;
    if (message.type === "XHS_CAPTURE_FOR_MERGE") {
      return { ok: true, payload: mergePayload, topLevelCount: 3, imageCount: 0 };
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  };
  const basketItem = {
    id: "note:6a76029300000000250070c1",
    kind: "live_page",
    title: "合并帖文甲",
    author: "甲",
    publishedDisplay: "09-10",
    commentCount: 3,
    imageCount: 0,
    hasUrl: true,
    addedAt: Date.now()
  };
  const runtimeCalls = [];
  let resolveMergeSummarize = null;
  context.chrome.runtime.sendMessage = async (message) => {
    runtimeCalls.push(message.type);
    if (message.type === "XHS_AI_MERGE_ADD") return { ok: true, replaced: false, basket: [basketItem] };
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket: [basketItem] };
    if (message.type === "XHS_AI_MERGE_SUMMARIZE") {
      return new Promise((resolve) => { resolveMergeSummarize = resolve; });
    }
    return { ok: true };
  };

  await elements["#tab-merge"].listeners.click();
  // 单条页签的结果不允许串到合并页签：合并页签还没有自己的结果，结果卡应隐藏
  assert.equal(elements["#view-merge"].hidden, false);
  assert.equal(elements["#result-card"].hidden, true);
  assert.equal(elements["#result-text"].value, "");
  // 状态卡重放合并页签自己最近的状态（第二步存入的合并进度）
  assert.equal(elements["#status-title"].textContent, "正在识别图片");

  await elements["#merge-add-button"].listeners.click();
  assert.ok(runtimeCalls.includes("XHS_AI_MERGE_ADD"));
  assert.equal(elements["#status-title"].textContent, "已加入合并清单");
  assert.equal(elements["#merge-list"].hidden, false);
  assert.match(elements["#merge-list"].innerHTML, /合并帖文甲/);
  assert.match(elements["#merge-list"].innerHTML, /merge-badge-page/);
  assert.equal(elements["#merge-summarize-button"].hidden, false);
  assert.equal(elements["#merge-summarize-label"].textContent, "概括这条帖文");

  runtimeCalls.length = 0;
  const mergeClick = elements["#merge-summarize-button"].listeners.click();
  await settle();
  assert.ok(runtimeCalls.includes("XHS_AI_MERGE_SUMMARIZE"));
  assert.equal(elements["#status-title"].textContent, "正在合并概括");
  runtimeListener({
    type: "XHS_AI_MERGE_PROGRESS",
    progress: { stage: "vision", percent: 40, detail: "帖文 1/2：准备识别 3 张图片" }
  });
  assert.equal(elements["#status-title"].textContent, "正在识别图片");
  resolveMergeSummarize({
    ok: true,
    result: {
      text: "★ 合并概括测试\n9月10日，甲发帖。（小红书 https://example.com/a）",
      createdAt: Date.now(),
      postCount: 2,
      evidence: {
        postCount: 2,
        topLevelComments: 6,
        visibleReplies: 1,
        imagesFound: 0,
        imagesAnalyzed: 0,
        textModel: "deepseek-v4-flash"
      },
      notification: null
    }
  });
  await mergeClick;
  assert.equal(elements["#status-title"].textContent, "合并概括完成");
  assert.equal(elements["#status-count"].textContent, "100%");
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /合并概括测试/);
  assert.match(elements["#evidence-summary"].textContent, /2 条帖文/);

  // 合并页签内“重新生成”走合并概括
  runtimeCalls.length = 0;
  const mergeRegenerate = elements["#regenerate-button"].listeners.click();
  await settle();
  assert.ok(runtimeCalls.includes("XHS_AI_MERGE_SUMMARIZE"));
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
  await mergeRegenerate;

  // —— 切回单条页签：显示单条自己的结果与状态，合并结果不带过来 ——
  await elements["#tab-single"].listeners.click();
  assert.equal(elements["#view-single"].hidden, false);
  assert.equal(elements["#view-merge"].hidden, true);
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /测试正文/);
  assert.doesNotMatch(elements["#result-text"].value, /合并概括测试/);
  assert.equal(elements["#status-title"].textContent, "概括完成");

  // 切回合并页签：合并结果与合并页签自己的状态仍在
  await elements["#tab-merge"].listeners.click();
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /合并概括测试/);
  assert.equal(elements["#status-title"].textContent, "重新生成完成");
  await elements["#tab-single"].listeners.click();

  // —— 单条页签：提取并概括只写入单条页签 ——
  const singleCapture = {
    source: { platform: "xiaohongshu", noteId: pageContext.noteId, pageSessionId: "page-session-1", url: pageUrl },
    note: { title: "单条帖文", author: "乙" },
    commentExport: { extractedTopLevelCount: 4 },
    media: { images: [] }
  };
  context.chrome.tabs.sendMessage = async (_tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContext;
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      return {
        ok: true,
        result: {
          text: "★ 测试概括\n测试正文。（小红书 https://example.com）",
          createdAt: Date.now(),
          evidence: {
            topLevelComments: 4,
            visibleReplies: 2,
            imagesFound: 3,
            imagesAnalyzed: 3,
            textModel: "deepseek-v4-flash"
          },
          notification: null
        },
        capture: singleCapture
      };
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  };
  await elements["#extract-button"].listeners.click();
  assert.equal(elements["#status-title"].textContent, "概括完成");
  assert.equal(elements["#result-card"].hidden, false);
  assert.match(elements["#result-text"].value, /测试正文/);

  // 单条页签内“重新生成”复用采集证据，不影响合并页签的结果
  context.chrome.tabs.sendMessage = async (_tabId, message) => {
    if (message.type === "XHS_PAGE_CONTEXT") return pageContext;
    if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
      assert.equal(message.force, true);
      assert.deepEqual(message.payload, singleCapture);
      return {
        ok: true,
        result: {
          text: "★ 测试概括（新版本）\n测试正文二。（小红书 https://example.com）",
          createdAt: Date.now(),
          evidence: { topLevelComments: 4, visibleReplies: 2, imagesFound: 3, imagesAnalyzed: 3, textModel: "deepseek-v4-flash" },
          notification: null
        },
        capture: singleCapture
      };
    }
    throw new Error(`Unexpected tab message: ${message.type}`);
  };
  await elements["#regenerate-button"].listeners.click();
  assert.equal(elements["#status-title"].textContent, "重新生成完成");
  assert.match(elements["#result-text"].value, /新版本/);

  await elements["#tab-merge"].listeners.click();
  assert.match(elements["#result-text"].value, /合并概括测试/);
  await elements["#tab-single"].listeners.click();
  assert.match(elements["#result-text"].value, /新版本/);

  runtimeCalls.length = 0;
  context.chrome.runtime.sendMessage = async (message) => {
    runtimeCalls.push(message);
    if (message.type === "XHS_AI_SCREENSHOT_ADD") {
      return { ok: true, basket: [basketItem], warnings: [] };
    }
    if (message.type === "XHS_AI_SCREENSHOT_RECOGNIZE") {
      return {
        ok: true,
        payload: {
          source: { platform: "xiaohongshu", noteId: null, url: "https://xhslink.cn/o/abc", origin: "user_screenshot" },
          note: { title: "截图帖文", author: "截图作者" },
          commentExport: { extractedTopLevelCount: 2 },
          media: { images: [] }
        },
        warnings: ["发帖时间为相对表述（原文“3天前”），截图拍摄时间未知，无法换算为日期。"]
      };
    }
    if (message.type === "XHS_AI_SUMMARIZE") {
      assert.equal(message.payload.source.origin, "user_screenshot");
      return {
        ok: true,
        result: {
          text: "★ 截图帖文事件\n据截图整理。（小红书 https://xhslink.cn/o/abc）",
          createdAt: Date.now(),
          evidence: { topLevelComments: 2, visibleReplies: 0, imagesFound: 0, imagesAnalyzed: 0, textModel: "deepseek-v4-flash" },
          notification: null
        }
      };
    }
    return { ok: true };
  };
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

  // —— 文件选择进暂存区，按钮统一提交（单条视图） ——
  elements["#shot-single-url"].value = " https://xhslink.cn/o/abc ";
  elements["#shot-single-input"].files = [{ name: "shot.png", type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }];
  await elements["#shot-single-input"].listeners.change();
  await settle();
  assert.equal(elements["#shot-single-staging"].hidden, false);
  assert.match(elements["#shot-single-staging"].innerHTML, /staging-item/);
  assert.match(elements["#shot-single-run"].textContent, /识别这张截图并概括/);
  runtimeCalls.length = 0;
  await elements["#shot-single-run"].listeners.click();
  await settle();
  await settle();
  assert.ok(runtimeCalls.some((message) => message.type === "XHS_AI_SCREENSHOT_RECOGNIZE"));
  assert.ok(runtimeCalls.some((message) => message.type === "XHS_AI_SUMMARIZE"));
  assert.equal(elements["#status-title"].textContent, "截图概括完成");
  assert.match(elements["#result-text"].value, /截图帖文事件/);
  assert.equal(elements["#shot-single-url"].value, "");
  assert.equal(elements["#shot-single-staging"].hidden, true);
  assert.equal(elements["#shot-single-run"].hidden, true);

  // —— 剪贴板粘贴进暂存区（单条视图），两张一起提交 ——
  const pasteImage = (name) => makeDataTransferEvent({
    files: [{ name, type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }]
  });
  runtimeCalls.length = 0;
  const firstPaste = pasteImage("paste-1.png");
  documentListeners.paste(firstPaste);
  await settle();
  assert.equal(firstPaste.defaultPrevented, true);
  assert.equal(elements["#shot-single-staging"].hidden, false);
  assert.match(elements["#shot-single-run"].textContent, /识别这张截图并概括/);
  documentListeners.paste(pasteImage("paste-2.png"));
  await settle();
  assert.match(elements["#shot-single-run"].textContent, /识别这 2 张截图并概括/);
  await elements["#shot-single-run"].listeners.click();
  await settle();
  await settle();
  const recognizeCall = runtimeCalls.find((message) => message.type === "XHS_AI_SCREENSHOT_RECOGNIZE");
  assert.ok(recognizeCall);
  assert.equal(recognizeCall.images.length, 2);
  assert.equal(elements["#status-title"].textContent, "截图概括完成");
  assert.equal(elements["#shot-single-staging"].hidden, true);

  // 纯文本粘贴（如往链接框贴 URL）不拦截、不进暂存区
  const textPasteEvent = makeDataTransferEvent({ files: [] });
  documentListeners.paste(textPasteEvent);
  await settle();
  assert.equal(textPasteEvent.defaultPrevented, false);
  assert.equal(elements["#shot-single-staging"].hidden, true);

  // —— 拖拽进暂存区（合并视图），按钮提交后加入清单；非图片文件仅拦截默认行为 ——
  await elements["#tab-merge"].listeners.click();
  runtimeCalls.length = 0;
  documentListeners.drop(makeDataTransferEvent({
    types: ["Files"],
    files: [{ name: "shot-2.png", type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }]
  }));
  await settle();
  assert.equal(elements["#screenshot-staging"].hidden, false);
  assert.match(elements["#screenshot-run"].textContent, /识别这张截图并加入清单/);
  await elements["#screenshot-run"].listeners.click();
  await settle();
  await settle();
  const addCall = runtimeCalls.find((message) => message.type === "XHS_AI_SCREENSHOT_ADD");
  assert.ok(addCall);
  assert.equal(addCall.images.length, 1);
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
    url: pageUrl,
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
  runtimeCalls.length = 0;
  context.chrome.runtime.sendMessage = async (message) => {
    runtimeCalls.push(message.type);
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
  await settle();
  assert.ok(runtimeCalls.includes("XHS_AI_HISTORY_LIST"));
  assert.equal(elements["#history-list"].hidden, false);
  assert.match(elements["#history-list"].innerHTML, /历史帖文甲/);
  assert.match(elements["#history-list"].innerHTML, /merge-badge-merge/);
  assert.equal(elements["#history-clear-button"].hidden, false);
  assert.equal(elements["#status-title"].textContent, "概括历史");

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
  assert.match(elements["#evidence-summary"].textContent, /5 条一级评论/);
  assert.equal(elements["#regenerate-button"].hidden, true);
  assert.equal(elements["#open-source-button"].hidden, false);

  const createdTabs = [];
  context.chrome.tabs.create = async (options) => { createdTabs.push(options); return {}; };
  await elements["#open-source-button"].listeners.click();
  // options 对象产生自 vm realm，跨 realm 比较原型会失败，逐字段断言
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].url, pageUrl);
  assert.equal(createdTabs[0].active, true);

  await elements["#history-list"].listeners.click({ target: historyTarget("hist-2") });
  assert.equal(elements["#open-source-button"].hidden, true);

  // 切回单条页签：历史结果不串页签，结果卡回到页签自己的实时结果
  await elements["#tab-single"].listeners.click();
  assert.equal(elements["#view-history"].hidden, true);
  assert.equal(elements["#history-button"].dataset.active, "false");
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

  // 回到历史屏删除正在查看的条目，结果卡收起
  await elements["#history-button"].listeners.click();
  await settle();
  await elements["#history-list"].listeners.click({ target: historyTarget("hist-1") });
  await elements["#history-list"].listeners.click({ target: historyTarget("hist-1", true) });
  assert.ok(runtimeCalls.includes("XHS_AI_HISTORY_REMOVE"));
  assert.equal(elements["#result-card"].hidden, true);

  // 清空历史：两步确认
  await elements["#history-clear-button"].listeners.click();
  assert.equal(elements["#history-clear-button"].textContent, "再点一次确认清空");
  assert.equal(elements["#history-clear-button"].dataset.confirming, "true");
  await elements["#history-clear-button"].listeners.click();
  assert.ok(runtimeCalls.includes("XHS_AI_HISTORY_CLEAR"));
  assert.equal(elements["#history-list"].hidden, true);
  assert.equal(elements["#history-clear-button"].hidden, true);
  assert.equal(elements["#result-card"].hidden, true);

  process.stdout.write("panel workflow restoration tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
