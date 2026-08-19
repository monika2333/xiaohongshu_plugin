const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createElement(overrides = {}) {
  return {
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    dataset: {},
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    ...overrides
  };
}

const ids = [
  "#text-base-url", "#text-model", "#text-key",
  "#vision-base-url", "#vision-model", "#vision-key",
  "#feishu-enabled", "#feishu-webhook-url", "#feishu-webhook-secret",
  "#feishu-app-id", "#feishu-app-secret", "#feishu-recipient-id",
  "#remember-keys", "#settings-form", "#save-button", "#save-status",
  "#clear-keys-button", "#storage-mode-hint", "#feishu-webhook-fields",
  "#feishu-app-fields", "#feishu-test-button", "#feishu-test-status",
  "#text-test-status", "#vision-test-status"
];
const elements = Object.fromEntries(ids.map((id) => [id, createElement()]));
const feishuCard = createElement();
const webhookRadio = createElement({ value: "webhook", checked: true });
const appRadio = createElement({ value: "app" });
const textTestButton = createElement({ dataset: { provider: "text" } });
const visionTestButton = createElement({ dataset: { provider: "vision" } });
const messages = [];
const permissions = [];

const configResponse = {
  ok: true,
  config: {
    text: { baseUrl: "https://text.example.com", model: "text-model" },
    vision: { baseUrl: "https://vision.example.com", model: "vision-model" },
    feishu: { enabled: false, mode: "webhook", appId: "", recipientId: "" },
    rememberApiKeys: true
  },
  secrets: {
    textApiKey: "text-key",
    visionApiKey: "vision-key",
    feishuWebhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-hook",
    feishuWebhookSecret: "sign-secret",
    feishuAppSecret: ""
  }
};

const context = {
  chrome: {
    permissions: {
      request: async (value) => {
        permissions.push(value);
        return true;
      }
    },
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === "XHS_AI_GET_CONFIG") return configResponse;
        if (message.type === "XHS_AI_TEST_FEISHU") return { ok: true, detail: "测试消息已发送" };
        return { ok: true, detail: "连接成功" };
      }
    }
  },
  document: {
    querySelector(selector) {
      if (selector === ".notification-card") return feishuCard;
      if (selector === 'input[name="feishu-mode"]:checked') return appRadio.checked ? appRadio : webhookRadio;
      if (selector.includes('input[name="feishu-mode"][value="app"]')) return appRadio;
      if (selector.includes('input[name="feishu-mode"][value="webhook"]')) return webhookRadio;
      return elements[selector] || null;
    },
    querySelectorAll(selector) {
      if (selector === 'input[name="feishu-mode"]') return [webhookRadio, appRadio];
      if (selector === ".test-button[data-provider]") return [textTestButton, visionTestButton];
      return [];
    }
  },
  URL,
  Promise,
  console
};

vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8"),
  context,
  { filename: "options.js" }
);

(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements["#text-base-url"].value, "https://text.example.com");
  assert.equal(elements["#feishu-webhook-url"].value, configResponse.secrets.feishuWebhookUrl);
  assert.equal(elements["#feishu-webhook-fields"].hidden, false);
  assert.equal(elements["#feishu-app-fields"].hidden, true);

  await elements["#feishu-test-button"].listeners.click();
  assert.deepEqual(
    messages.filter((message) => message.type !== "XHS_AI_GET_CONFIG").map((message) => message.type),
    ["XHS_AI_TEST_FEISHU"]
  );
  assert.equal(JSON.stringify(permissions), JSON.stringify([{ origins: ["https://open.feishu.cn/*"] }]));
  assert.equal(elements["#feishu-test-status"].dataset.state, "ok");

  process.stdout.write("options settings and Feishu test routing tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
