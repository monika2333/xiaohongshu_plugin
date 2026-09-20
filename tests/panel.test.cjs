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
    appendChild() {}
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

(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements["#extract-button"].disabled, true);
  assert.equal(elements[".button-label"].textContent, "正在处理…");
  assert.equal(elements["#status-title"].textContent, "正在读取评论");
  assert.equal(elements["#status-detail"].textContent, "已加载 17 条一级评论");
  assert.equal(elements["#status-count"].textContent, "17 / 50");
  assert.equal(elements["#result-card"].hidden, true);

  runtimeListener({
    type: "XHS_AI_MERGE_PROGRESS",
    progress: { stage: "vision", percent: 40, detail: "帖文 1/2：准备识别 3 张图片" }
  });
  assert.equal(elements["#status-title"].textContent, "正在识别图片");
  assert.equal(elements["#status-detail"].textContent, "帖文 1/2：准备识别 3 张图片");

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
  context.chrome.runtime.sendMessage = async (message) => {
    runtimeCalls.push(message.type);
    if (message.type === "XHS_AI_MERGE_ADD") return { ok: true, replaced: false, basket: [basketItem] };
    if (message.type === "XHS_AI_MERGE_LIST") return { ok: true, basket: [basketItem] };
    if (message.type === "XHS_AI_MERGE_SUMMARIZE") {
      return {
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
      };
    }
    return { ok: true };
  };
  await elements["#merge-add-button"].listeners.click();
  assert.ok(runtimeCalls.includes("XHS_AI_MERGE_ADD"));
  assert.equal(elements["#status-title"].textContent, "已加入合并清单");
  assert.equal(elements["#merge-list"].hidden, false);
  assert.match(elements["#merge-list"].innerHTML, /合并帖文甲/);
  assert.match(elements["#merge-list"].innerHTML, /merge-badge-page/);
  assert.equal(elements["#merge-summarize-button"].hidden, false);
  assert.equal(elements["#merge-summarize-label"].textContent, "概括这条帖文");

  await elements["#merge-summarize-button"].listeners.click();
  assert.ok(runtimeCalls.includes("XHS_AI_MERGE_SUMMARIZE"));
  assert.equal(elements["#status-title"].textContent, "合并概括完成");
  assert.match(elements["#result-text"].value, /合并概括测试/);
  assert.match(elements["#evidence-summary"].textContent, /2 条帖文/);

  runtimeCalls.length = 0;
  await elements["#regenerate-button"].listeners.click();
  assert.ok(runtimeCalls.includes("XHS_AI_MERGE_SUMMARIZE"));

  // —— 视图切换与单条截图概括 ——
  await elements["#tab-merge"].listeners.click();
  assert.equal(elements["#tab-merge"].dataset.active, "true");
  assert.equal(elements["#tab-single"].dataset.active, "false");
  assert.equal(elements["#view-single"].hidden, true);
  assert.equal(elements["#view-merge"].hidden, false);
  await elements["#tab-single"].listeners.click();
  assert.equal(elements["#view-single"].hidden, false);
  assert.equal(elements["#view-merge"].hidden, true);

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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements["#shot-single-staging"].hidden, false);
  assert.match(elements["#shot-single-staging"].innerHTML, /staging-item/);
  assert.match(elements["#shot-single-run"].textContent, /识别这张截图并概括/);
  runtimeCalls.length = 0;
  await elements["#shot-single-run"].listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstPaste.defaultPrevented, true);
  assert.equal(elements["#shot-single-staging"].hidden, false);
  assert.match(elements["#shot-single-run"].textContent, /识别这张截图并概括/);
  documentListeners.paste(pasteImage("paste-2.png"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements["#shot-single-run"].textContent, /识别这 2 张截图并概括/);
  await elements["#shot-single-run"].listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const recognizeCall = runtimeCalls.find((message) => message.type === "XHS_AI_SCREENSHOT_RECOGNIZE");
  assert.ok(recognizeCall);
  assert.equal(recognizeCall.images.length, 2);
  assert.equal(elements["#status-title"].textContent, "截图概括完成");
  assert.equal(elements["#shot-single-staging"].hidden, true);

  // 纯文本粘贴（如往链接框贴 URL）不拦截、不进暂存区
  const textPasteEvent = makeDataTransferEvent({ files: [] });
  documentListeners.paste(textPasteEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(textPasteEvent.defaultPrevented, false);
  assert.equal(elements["#shot-single-staging"].hidden, true);

  // —— 拖拽进暂存区（合并视图），按钮提交后加入清单；非图片文件仅拦截默认行为 ——
  await elements["#tab-merge"].listeners.click();
  runtimeCalls.length = 0;
  documentListeners.drop(makeDataTransferEvent({
    types: ["Files"],
    files: [{ name: "shot-2.png", type: "image/png", size: 1000, dataUrl: "data:image/png;base64,QUJD" }]
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements["#screenshot-staging"].hidden, false);
  assert.match(elements["#screenshot-run"].textContent, /识别这张截图并加入清单/);
  await elements["#screenshot-run"].listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nonImageDropEvent.defaultPrevented, true);
  assert.equal(elements["#screenshot-staging"].hidden, true);

  process.stdout.write("panel workflow restoration tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
