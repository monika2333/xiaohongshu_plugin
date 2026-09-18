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
    select() {}
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
  "#download-button",
  "#download-images",
  ".download-option",
  "#merge-add-button",
  "#merge-upload-button",
  "#screenshot-input",
  "#screenshot-url",
  "#merge-list",
  "#merge-summarize-button",
  "#merge-summarize-label",
  "#merge-clear-button"
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
    execCommand: () => true
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
const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
vm.runInContext(source, context, { filename: "popup.js" });

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
  assert.equal(elements["#download-button"].hidden, true);
  assert.equal(elements[".download-option"].hidden, true);

  runtimeCalls.length = 0;
  await elements["#regenerate-button"].listeners.click();
  assert.ok(runtimeCalls.includes("XHS_AI_MERGE_SUMMARIZE"));

  process.stdout.write("popup workflow restoration tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
