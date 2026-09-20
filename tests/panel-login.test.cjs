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

// 按平台 URL 构造侧边栏环境；cookieImpl 返回 null 表示未登录。
function createPopupEnvironment({ tabUrl, cookieImpl }) {
  const elements = Object.fromEntries(selectors.map((selector) => [selector, createElement()]));
  const state = { cookieChecks: [], scriptExecutions: [], pageMessages: 0 };

  const context = {
    chrome: {
      cookies: {
        get: async (details) => {
          state.cookieChecks.push(details);
          return cookieImpl(details);
        }
      },
      runtime: {
        onMessage: { addListener() {} },
        openOptionsPage() {},
        sendMessage: async () => ({ ok: true })
      },
      scripting: {
        executeScript: async (options) => { state.scriptExecutions.push(options); }
      },
      tabs: {
        query: async () => [{ id: 7, url: tabUrl }],
        sendMessage: async () => {
          state.pageMessages += 1;
          return { ok: true, pageSessionId: "page-session", pageUrl: tabUrl };
        }
      }
    },
    document: {
      querySelector: (selector) => elements[selector] || null,
      execCommand: () => true,
      addEventListener: () => {}
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

  return { elements, state };
}

async function settle(rounds = 2) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

(async () => {
  // —— 小红书未登录：不注入任何脚本，提示登录小红书 ——
  {
    const pageUrl = "https://www.xiaohongshu.com/explore/6a76029300000000250070c1?xsec_token=test-token";
    const { elements, state } = createPopupEnvironment({ tabUrl: pageUrl, cookieImpl: () => null });
    await settle();

    await elements["#extract-button"].listeners.click();

    assert.deepEqual(state.cookieChecks.map((item) => item.name), ["web_session", "web_session"]);
    assert.equal(state.scriptExecutions.length, 0);
    assert.equal(state.pageMessages, 0);
    assert.equal(elements["#status-title"].textContent, "未能完成");
    assert.match(elements["#status-detail"].textContent, /尚未登录/);
    assert.match(elements["#status-detail"].textContent, /先登录并刷新帖文详情页/);
    assert.equal(elements["#extract-button"].disabled, false);
    assert.equal(elements[".button-label"].textContent, "提取并概括");
  }

  // —— 微博未登录：检查 SUB Cookie，不注入脚本，提示登录 weibo.com ——
  {
    const pageUrl = "https://weibo.com/1257000310/RhJDvgyf3";
    const { elements, state } = createPopupEnvironment({ tabUrl: pageUrl, cookieImpl: () => null });
    await settle();

    await elements["#extract-button"].listeners.click();

    assert.deepEqual(state.cookieChecks.map((item) => item.name), ["SUB", "SUB"]);
    assert.ok(state.cookieChecks.every((item) => item.url === "https://weibo.com"));
    assert.equal(state.scriptExecutions.length, 0);
    assert.equal(state.pageMessages, 0);
    assert.equal(elements["#status-title"].textContent, "未能完成");
    assert.match(elements["#status-detail"].textContent, /尚未登录/);
    assert.match(elements["#status-detail"].textContent, /weibo\.com/);
  }

  // —— 微博已登录：只注入微博采集脚本，不注入小红书桥接 ——
  {
    const pageUrl = "https://weibo.com/1257000310/RhJDvgyf3";
    const { elements, state } = createPopupEnvironment({
      tabUrl: pageUrl,
      cookieImpl: (details) => (details.name === "SUB" ? { name: "SUB", value: "session" } : null)
    });
    await settle();

    await elements["#extract-button"].listeners.click();

    assert.equal(state.pageMessages, 3); // 恢复工作流 + PAGE_CONTEXT + 采集概括
    const files = state.scriptExecutions.map((item) => (item.files || []).join(",")).filter(Boolean);
    assert.deepEqual(files, [
      "capture-common.js,weibo-content-script.js",
      "capture-common.js,weibo-content-script.js"
    ]);
    assert.ok(state.scriptExecutions.every((item) => !item.world));
  }

  // —— 非帖文页面：不检查登录，提示打开帖文详情页 ——
  {
    const { elements, state } = createPopupEnvironment({
      tabUrl: "https://weibo.com/hot/search",
      cookieImpl: () => ({ name: "SUB", value: "session" })
    });
    await settle();

    await elements["#extract-button"].listeners.click();

    assert.equal(state.cookieChecks.length, 0);
    assert.equal(state.scriptExecutions.length, 0);
    assert.equal(state.pageMessages, 0);
    assert.match(elements["#status-detail"].textContent, /请先打开小红书或微博帖文详情页/);
  }

  process.stdout.write("panel login preflight tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
