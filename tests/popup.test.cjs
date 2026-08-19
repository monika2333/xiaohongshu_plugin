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
  "#download-images"
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

  process.stdout.write("popup workflow restoration tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
