// v0.22.0 自动化入口 agent-api.js：经 CDP 在后台调用 globalThis.SHUYE_AGENT_API.captureTab
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.join(__dirname, "..");
const NOTE_ID = "6a76029300000000250070c1";
const NOTE_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=test-token&xsec_source=pc_search`;

const calls = { executeScript: [], tabMessages: [] };
let cookieValue = "session";
let tabs = [{ id: 7, url: NOTE_URL }];
let contextReplies = [];
let captureReply = null;
let quietDuringCapture = null;

function storageArea() {
  const state = {};
  return {
    get: async (keys) => {
      if (keys == null) return { ...state };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in state).map((key) => [key, state[key]]));
    },
    set: async (values) => { Object.assign(state, values); },
    remove: async () => {},
    setAccessLevel: async () => {}
  };
}

const context = {
  chrome: {
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: {
      onMessage: { addListener: () => {} },
      getURL: (value = "") => `chrome-extension://test/${value}`,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")),
      sendMessage: async () => ({ ok: true })
    },
    storage: { local: storageArea(), session: storageArea() },
    cookies: { get: async () => (cookieValue ? { value: cookieValue } : null) },
    tabs: {
      get: async (id) => {
        const tab = tabs.find((item) => item.id === id);
        if (!tab) throw new Error("No tab");
        return tab;
      },
      query: async () => tabs,
      sendMessage: async (tabId, message) => {
        calls.tabMessages.push({ tabId, message });
        if (message.type === "XHS_PAGE_CONTEXT") {
          return contextReplies.length ? contextReplies.shift() : { ok: true, pageSessionId: "ps-1", pageUrl: NOTE_URL, noteId: NOTE_ID, detailReady: true };
        }
        if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
          quietDuringCapture = context.SHUYE_AGENT_API.isQuiet(tabId);
          return captureReply;
        }
        return undefined;
      }
    },
    scripting: {
      executeScript: async (details) => {
        calls.executeScript.push(details);
        return [];
      }
    }
  },
  console,
  Promise,
  URL,
  Date,
  Uint8Array,
  AbortController,
  TextEncoder,
  crypto: webcrypto,
  setTimeout,
  clearTimeout,
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  importScripts: (...filenames) => {
    for (const filename of filenames) {
      vm.runInContext(fs.readFileSync(path.join(root, filename), "utf8"), context, { filename });
    }
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "service-worker.js"), "utf8"), context, { filename: "service-worker.js" });

const api = context.SHUYE_AGENT_API;

(async () => {
  assert.ok(api, "后台应暴露 SHUYE_AGENT_API");
  assert.equal(api.version, 1);
  assert.ok(Object.isFrozen(api), "入口对象应冻结，避免被页面外代码改写");

  const pong = await api.ping();
  assert.equal(pong.ok, true);
  assert.equal(pong.apiVersion, 1);
  assert.equal(pong.extensionVersion, "0.22.0");

  // 正常路径：按 noteId 找页签 → 注入采集脚本 → 等详情就绪 → 发采集消息；notify:false 时采集期间静默
  contextReplies = [
    { ok: true, pageSessionId: "ps-1", pageUrl: NOTE_URL, noteId: NOTE_ID, detailReady: false },
    { ok: true, pageSessionId: "ps-1", pageUrl: NOTE_URL, noteId: NOTE_ID, detailReady: true }
  ];
  captureReply = {
    ok: true,
    result: { text: "★标题\n正文\n小红书：链接", historyId: "h-1", notification: null },
    capture: {
      note: { title: "标题", author: "作者", publishedDisplay: "11-21", location: "北京", type: "normal" },
      interactions: { likes: { value: 12 }, collects: { value: 3 }, comments: { value: 5 } },
      media: { images: [{}, {}] },
      commentExport: { extractedTopLevelCount: 5 }
    }
  };
  const result = await api.captureTab({ noteId: NOTE_ID.toUpperCase(), commentLimit: 30, notify: false });
  assert.equal(result.ok, true);
  assert.equal(result.apiVersion, 1);
  assert.equal(result.noteId, NOTE_ID);
  assert.equal(result.text, "★标题\n正文\n小红书：链接");
  assert.equal(result.historyId, "h-1");
  assert.equal(result.meta.author, "作者");
  assert.equal(result.meta.likes, 12);
  assert.equal(result.meta.imageCount, 2);
  assert.equal(quietDuringCapture, true, "notify:false 时采集期间该页签应处于静默");
  assert.equal(api.isQuiet(7), false, "采集结束后应解除静默");
  assert.equal(calls.executeScript.length, 2);
  assert.equal(calls.executeScript[0].world, "MAIN");
  assert.deepEqual([...calls.executeScript[0].files], ["main-world.js"]);
  assert.deepEqual([...calls.executeScript[1].files], ["capture-common.js", "content-script.js"]);
  const captureMessage = calls.tabMessages.find((item) => item.message.type === "XHS_CAPTURE_AND_SUMMARIZE");
  assert.equal(captureMessage.tabId, 7);
  assert.equal(captureMessage.message.options.limit, 30);
  assert.equal(calls.tabMessages.filter((item) => item.message.type === "XHS_PAGE_CONTEXT").length, 2, "详情没就绪时应继续等待");

  // 默认推送：不传 notify 时不静默
  captureReply = { ok: true, result: { text: "x" } };
  await api.captureTab({ tabId: 7 });
  assert.equal(quietDuringCapture, false);

  // 采集失败也要解除静默，并把错误抛给调用方
  captureReply = { ok: false, error: "模型未配置" };
  await assert.rejects(() => api.captureTab({ noteId: NOTE_ID, notify: false }), /模型未配置/);
  assert.equal(api.isQuiet(7), false);

  // 前置检查
  await assert.rejects(() => api.captureTab({}), /noteId/);
  await assert.rejects(() => api.captureTab({ noteId: "0".repeat(24) }), /没有找到/);
  tabs = [{ id: 8, url: "https://www.xiaohongshu.com/search_result?keyword=x" }];
  await assert.rejects(() => api.captureTab({ tabId: 8 }), /不是小红书帖文详情页/);
  tabs = [{ id: 7, url: NOTE_URL }];
  cookieValue = null;
  await assert.rejects(() => api.captureTab({ noteId: NOTE_ID }), /未登录/);

  // 不新增权限，不开放给网页或其他扩展
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.ok(!("externally_connectable" in manifest), "自动化入口不应通过 externally_connectable 开放");
  assert.deepEqual(manifest.permissions, [
    "activeTab", "clipboardWrite", "cookies", "declarativeNetRequestWithHostAccess", "scripting", "sidePanel", "storage"
  ]);
  const agentSource = fs.readFileSync(path.join(root, "agent-api.js"), "utf8");
  assert.doesNotMatch(agentSource, /onMessageExternal|addEventListener\(\s*["']message/, "入口不应监听外部或页面消息");

  process.stdout.write("agent api tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
