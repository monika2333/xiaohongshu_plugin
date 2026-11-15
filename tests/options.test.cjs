const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const optionsHtml = fs.readFileSync(path.join(__dirname, "..", "options.html"), "utf8");

function createElement(overrides = {}) {
  return {
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    dataset: {},
    attributes: {},
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    ...overrides
  };
}

const ids = [
  "#text-base-url", "#text-model", "#text-key",
  "#vision-base-url", "#vision-model", "#vision-key",
  "#feishu-webhook-url", "#feishu-webhook-secret",
  "#feishu-app-id", "#feishu-app-secret", "#feishu-recipient-id",
  "#remember-keys", "#settings-form", "#save-button", "#save-status",
  "#clear-keys-button", "#feishu-webhook-fields",
  "#feishu-app-fields", "#feishu-test-button", "#feishu-test-status",
  "#text-test-status", "#vision-test-status",
  "#tab-models", "#tab-prompts", "#prompts-tab-badge",
  "#panel-models", "#panel-prompts", "#prompt-save-status", "#prompt-save-button",
  "#split-models", "#vision-group", "#text-group-title", "#text-test-button",
  "#switch-to-split-button", "#model-intro", "#flow-vision", "#flow-text"
];
const promptKeys = ["textSystem", "mergeSystem", "visionSystem", "screenshotSystem"];
const promptSelectors = promptKeys.flatMap((key) => [
  `[data-prompt-input="${key}"]`,
  `[data-prompt-badge="${key}"]`,
  `[data-prompt-reset="${key}"]`
]);
// 与真实 HTML 初始状态对齐：提示词面板和页签徽标初始隐藏
const initiallyHidden = new Set([
  "#panel-prompts", "#prompts-tab-badge", "#vision-group", "#text-group-title", "#switch-to-split-button"
]);
const elements = Object.fromEntries(
  [...ids, ...promptSelectors].map((selector) => [
    selector,
    createElement(
      selector.startsWith("[data-prompt-badge=") || initiallyHidden.has(selector) ? { hidden: true } : {}
    )
  ])
);
elements["#prompt-save-button"].dataset.stayOpen = "true";
const webhookRadio = createElement({ value: "webhook", checked: true });
const appRadio = createElement({ value: "app" });
const textTestButton = elements["#text-test-button"];
textTestButton.dataset.provider = "text";
const visionTestButton = createElement({ dataset: { provider: "vision" } });
const messages = [];
const permissions = [];
const confirmCalls = [];

const configResponse = {
  ok: true,
  config: {
    modelMode: "split",
    text: { baseUrl: "https://text.example.com", model: "text-model" },
    vision: { baseUrl: "https://vision.example.com", model: "vision-model" },
    feishu: { mode: "webhook", appId: "", recipientId: "" },
    rememberApiKeys: true,
    promptOverrides: { textSystem: "自定义单帖提示词" }
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
  console,
  confirm: (message) => {
    confirmCalls.push(message);
    return true;
  },
  setInterval: () => 1,
  clearInterval: () => {}
};

vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "prompts.js"), "utf8"),
  context,
  { filename: "prompts.js" }
);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8"),
  context,
  { filename: "options.js" }
);

// —— v0.17.0 共用模式：只填一组；测试同时测图片，失败可一键改为分开配置并用文字设置预填 ——
async function runSharedModeScenario() {
  const els = Object.fromEntries(
    [...ids, ...promptSelectors].map((selector) => [
      selector,
      createElement(
        selector.startsWith("[data-prompt-badge=") || initiallyHidden.has(selector) ? { hidden: true } : {}
      )
    ])
  );
  els["#text-test-button"].dataset.provider = "text";
  const visionButton = createElement({ dataset: { provider: "vision" } });
  const sent = [];
  const requested = [];
  let visionTestFails = true;
  const ctx = {
    chrome: {
      permissions: { request: async (value) => { requested.push(value); return true; } },
      runtime: {
        sendMessage: async (message) => {
          sent.push(message);
          if (message.type === "XHS_AI_GET_CONFIG") {
            return {
              ok: true,
              config: {
                modelMode: "shared",
                text: { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
                vision: { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
                feishu: { mode: "webhook", appId: "", recipientId: "" },
                rememberApiKeys: true,
                promptOverrides: {}
              },
              secrets: { textApiKey: "shared-key", visionApiKey: "" }
            };
          }
          if (message.type === "XHS_AI_TEST_PROVIDER" && message.provider === "shared") {
            return visionTestFails
              ? { ok: true, detail: "OK", vision: { ok: false, error: "模型请求失败：image input is not supported" } }
              : { ok: true, detail: "OK", vision: { ok: true, detail: "红色" } };
          }
          return { ok: true, detail: "连接成功" };
        }
      }
    },
    document: {
      querySelector(selector) {
        if (selector === 'input[name="feishu-mode"]:checked') return createElement({ value: "webhook", checked: true });
        if (selector.startsWith('input[name="feishu-mode"]')) return createElement();
        return els[selector] || null;
      },
      querySelectorAll(selector) {
        if (selector === ".test-button[data-provider]") return [els["#text-test-button"], visionButton];
        return [];
      }
    },
    URL,
    Promise,
    console,
    confirm: () => true,
    setInterval: () => 1,
    clearInterval: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "prompts.js"), "utf8"), ctx, { filename: "prompts.js" });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8"), ctx, { filename: "options.js" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(els["#split-models"].checked, false);
  assert.equal(els["#vision-group"].hidden, true);
  assert.equal(els["#text-group-title"].hidden, true);
  assert.equal(els["#text-test-button"].textContent, "测试模型");
  assert.equal(els["#flow-vision"].textContent, "模型识别图片");
  assert.equal(els["#flow-text"].textContent, "模型编写简报");

  // 共用模式只申请一个 API 域名，保存 modelMode: shared
  await els["#settings-form"].listeners.submit({ preventDefault() {} });
  const sharedSave = sent.find((message) => message.type === "XHS_AI_SAVE_CONFIG");
  assert.equal(sharedSave.config.modelMode, "shared");
  assert.equal(JSON.stringify(requested[0].origins), JSON.stringify(["https://api.deepseek.com/*"]));

  // 测试按钮发 provider: shared；图片失败时提示并露出「改为分开配置」
  els["#text-model"].value = "text-only-model";
  await els["#text-test-button"].listeners.click();
  assert.equal(sent.filter((message) => message.type === "XHS_AI_TEST_PROVIDER").pop().provider, "shared");
  assert.equal(els["#text-test-status"].dataset.state, "error");
  assert.match(els["#text-test-status"].textContent, /文字可用，图片识别失败：.*image input is not supported/);
  assert.equal(els["#switch-to-split-button"].hidden, false);

  // 一键改为分开：图片那组用当前文字设置预填，Key 留空（同域名沿用文字 Key）
  els["#vision-key"].value = "leftover";
  await els["#switch-to-split-button"].listeners.click();
  assert.equal(els["#split-models"].checked, true);
  assert.equal(els["#vision-group"].hidden, false);
  assert.equal(els["#switch-to-split-button"].hidden, true);
  assert.equal(els["#vision-base-url"].value, "https://api.deepseek.com");
  assert.equal(els["#vision-model"].value, "text-only-model");
  assert.equal(els["#vision-key"].value, "");
  assert.equal(els["#text-test-button"].textContent, "测试文字模型");

  // 预填只发生一次：用户改过图片设置后来回切换不被覆盖
  els["#vision-model"].value = "qwen3-vl-plus";
  els["#split-models"].checked = false;
  els["#split-models"].listeners.change();
  els["#split-models"].checked = true;
  els["#split-models"].listeners.change();
  assert.equal(els["#vision-model"].value, "qwen3-vl-plus");

  // 回到共用、图片测试通过时显示两项均可用
  els["#split-models"].checked = false;
  els["#split-models"].listeners.change();
  visionTestFails = false;
  await els["#text-test-button"].listeners.click();
  assert.equal(els["#text-test-status"].dataset.state, "ok");
  assert.match(els["#text-test-status"].textContent, /文字与图片均可用/);
  assert.equal(els["#switch-to-split-button"].hidden, true);
}

(async () => {
  assert.match(optionsHtml, /https:\/\/platform\.deepseek\.com\/api_keys/);
  assert.match(optionsHtml, /https:\/\/open\.feishu\.cn\/document\/feishu-cards\/quick-start\/send-message-cards-with-custom-bot/);
  assert.doesNotMatch(optionsHtml, /common-capabilities\/message-card\/getting-started\/send-message-cards-with-a-custom-bot/);
  assert.match(optionsHtml, />获取 DeepSeek API Key ↗<\/a>/);
  assert.doesNotMatch(optionsHtml, /feishu-enabled|完成后自动推送/);
  // 模型组内的 .fields / .card-actions 必须复位卡片网格里的列位置，否则窄屏下字段被挤到右半边
  const optionsCss = fs.readFileSync(path.join(__dirname, "..", "options.css"), "utf8");
  assert.match(optionsCss, /\.model-group \.fields,\s*\.model-group \.card-actions \{ grid-column: auto; \}/);

  // options.js 引用的所有 id 必须真实存在于 options.html（防止 mock 元素掩盖页面缺元素）
  const optionsJs = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
  for (const match of optionsJs.matchAll(/querySelector(?:All)?\("#([A-Za-z0-9-]+)"/g)) {
    assert.match(
      optionsHtml,
      new RegExp(`id="${match[1]}"`),
      `options.js 引用的 #${match[1]} 在 options.html 中不存在`
    );
  }

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements["#text-base-url"].value, "https://text.example.com");
  // 分开模式的老配置：图片那组展开，按钮与流程条用「文字 / 图片模型」说法
  assert.equal(elements["#split-models"].checked, true);
  assert.equal(elements["#vision-group"].hidden, false);
  assert.equal(elements["#text-group-title"].hidden, false);
  assert.equal(elements["#text-test-button"].textContent, "测试文字模型");
  assert.equal(elements["#flow-vision"].textContent, "图片模型识别");
  assert.equal(elements["#feishu-webhook-url"].value, configResponse.secrets.feishuWebhookUrl);
  assert.equal(elements["#feishu-webhook-fields"].hidden, false);
  assert.equal(elements["#feishu-app-fields"].hidden, true);

  // —— 提示词编辑器：覆盖回填，未覆盖的场景直接预填内置默认 ——
  const promptInput = (key) => elements[`[data-prompt-input="${key}"]`];
  assert.equal(promptInput("textSystem").value, "自定义单帖提示词");
  assert.equal(elements['[data-prompt-badge="textSystem"]'].hidden, false);
  assert.equal(elements['[data-prompt-reset="textSystem"]'].disabled, false);
  assert.equal(promptInput("mergeSystem").value, context.XhsPrompts.mergeSystem);
  assert.equal(elements['[data-prompt-badge="mergeSystem"]'].hidden, true);
  assert.equal(elements['[data-prompt-reset="mergeSystem"]'].disabled, true);
  assert.equal(elements['[data-prompt-reset="mergeSystem"]'].title, "当前已是内置默认提示词，无需恢复");
  promptInput("visionSystem").value = "  自定义图片提示词  ";

  // —— 页签与徽标：默认停在「模型与推送」，徽标计数为已自定义场景数 ——
  assert.equal(elements["#panel-models"].hidden, false);
  assert.equal(elements["#panel-prompts"].hidden, true);
  assert.equal(elements["#prompts-tab-badge"].hidden, false);
  assert.equal(elements["#prompts-tab-badge"].textContent, "1");

  await elements["#feishu-test-button"].listeners.click();
  assert.deepEqual(
    messages.filter((message) => message.type !== "XHS_AI_GET_CONFIG").map((message) => message.type),
    ["XHS_AI_TEST_FEISHU"]
  );
  assert.equal(JSON.stringify(permissions), JSON.stringify([{ origins: ["https://open.feishu.cn/*"] }]));
  assert.equal(elements["#feishu-test-status"].dataset.state, "ok");

  await elements["#settings-form"].listeners.submit({ preventDefault() {} });
  const saveMessage = messages.find((message) => message.type === "XHS_AI_SAVE_CONFIG");
  assert.ok(saveMessage);
  assert.equal(saveMessage.config.modelMode, "split");
  assert.equal("enabled" in saveMessage.config.feishu, false);
  assert.equal("saveHistory" in saveMessage.config, false);
  assert.equal(
    JSON.stringify(permissions[1].origins),
    JSON.stringify(["https://text.example.com/*", "https://vision.example.com/*", "https://open.feishu.cn/*"])
  );
  // 与内置默认一致的项（mergeSystem 预填后未改动）不落库，继续跟随插件默认更新
  assert.equal(
    JSON.stringify(saveMessage.config.promptOverrides),
    JSON.stringify({ textSystem: "自定义单帖提示词", visionSystem: "自定义图片提示词" })
  );

  // 恢复默认按钮：填回内置默认文本并隐藏徽标（弹确认框后执行），随后回到禁用态
  await elements['[data-prompt-reset="textSystem"]'].listeners.click();
  assert.equal(promptInput("textSystem").value, context.XhsPrompts.textSystem);
  assert.equal(elements['[data-prompt-badge="textSystem"]'].hidden, true);
  assert.equal(elements['[data-prompt-reset="textSystem"]'].disabled, true);
  assert.equal(elements['[data-prompt-reset="textSystem"]'].title, "当前已是内置默认提示词，无需恢复");
  assert.equal(confirmCalls.length, 1);

  // —— 页签切换：模型与推送 ↔ 概括提示词 ——
  await elements["#tab-prompts"].listeners.click();
  assert.equal(elements["#panel-models"].hidden, true);
  assert.equal(elements["#panel-prompts"].hidden, false);
  assert.equal(elements["#tab-prompts"].attributes["aria-selected"], "true");
  assert.equal(elements["#tab-models"].attributes["aria-selected"], "false");
  // 恢复默认后徽标归零
  assert.equal(elements["#prompts-tab-badge"].hidden, true);
  assert.equal(elements["#prompts-tab-badge"].textContent, "");

  // —— 提示词页签保存：提交成功、状态栏写在自己的保存行、主状态栏不被改写（不触发关页流程） ——
  await elements["#settings-form"].listeners.submit({ preventDefault() {}, submitter: elements["#prompt-save-button"] });
  const saveMessages = messages.filter((message) => message.type === "XHS_AI_SAVE_CONFIG");
  assert.equal(saveMessages.length, 2);
  assert.equal(
    JSON.stringify(saveMessages[1].config.promptOverrides),
    JSON.stringify({ visionSystem: "自定义图片提示词" }),
    "恢复默认后的 textSystem 不应再落库"
  );
  assert.equal(elements["#prompt-save-status"].textContent, "已保存，本页保持打开，可继续调整提示词。");
  assert.equal(elements["#prompt-save-status"].dataset.state, "ok");
  assert.doesNotMatch(elements["#save-status"].textContent, /保持打开/);
  assert.match(elements["#save-status"].textContent, /自动关闭/);

  // 分开模式下文字那组的测试只测文字
  await textTestButton.listeners.click();
  assert.equal(messages.filter((message) => message.type === "XHS_AI_TEST_PROVIDER").pop().provider, "text");

  await runSharedModeScenario();

  process.stdout.write("options settings and Feishu test routing tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
