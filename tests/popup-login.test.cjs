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
let cookieChecks = 0;
let scriptExecutions = 0;
let pageMessages = 0;

const context = {
  chrome: {
    cookies: {
      get: async ({ url, name }) => {
        cookieChecks += 1;
        assert.equal(url, pageUrl);
        assert.equal(name, "web_session");
        return null;
      }
    },
    runtime: {
      onMessage: { addListener() {} },
      openOptionsPage() {},
      sendMessage: async () => ({ ok: true })
    },
    scripting: {
      executeScript: async () => { scriptExecutions += 1; }
    },
    tabs: {
      query: async () => [{ id: 7, url: pageUrl }],
      sendMessage: async () => {
        pageMessages += 1;
        return { ok: true };
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

  assert.equal(scriptExecutions, 0);
  assert.equal(pageMessages, 0);

  await elements["#extract-button"].listeners.click();

  assert.equal(cookieChecks, 2);
  assert.equal(scriptExecutions, 0);
  assert.equal(pageMessages, 0);
  assert.equal(elements["#status-title"].textContent, "未能完成");
  assert.match(elements["#status-detail"].textContent, /尚未登录/);
  assert.match(elements["#status-detail"].textContent, /先登录并刷新帖文详情页/);
  assert.equal(elements["#extract-button"].disabled, false);
  assert.equal(elements[".button-label"].textContent, "提取并概括");

  process.stdout.write("popup login preflight tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
