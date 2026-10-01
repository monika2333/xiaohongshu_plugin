const fields = {
  textBaseUrl: document.querySelector("#text-base-url"),
  textModel: document.querySelector("#text-model"),
  textKey: document.querySelector("#text-key"),
  visionBaseUrl: document.querySelector("#vision-base-url"),
  visionModel: document.querySelector("#vision-model"),
  visionKey: document.querySelector("#vision-key"),
  feishuWebhookUrl: document.querySelector("#feishu-webhook-url"),
  feishuWebhookSecret: document.querySelector("#feishu-webhook-secret"),
  feishuAppId: document.querySelector("#feishu-app-id"),
  feishuAppSecret: document.querySelector("#feishu-app-secret"),
  feishuRecipientId: document.querySelector("#feishu-recipient-id"),
  rememberKeys: document.querySelector("#remember-keys")
};

const form = document.querySelector("#settings-form");
const saveButton = document.querySelector("#save-button");
const saveStatus = document.querySelector("#save-status");
const promptSaveStatus = document.querySelector("#prompt-save-status");
const promptSaveButton = document.querySelector("#prompt-save-button");
const tabModelsButton = document.querySelector("#tab-models");
const tabPromptsButton = document.querySelector("#tab-prompts");
const promptsTabBadge = document.querySelector("#prompts-tab-badge");
const panelModels = document.querySelector("#panel-models");
const panelPrompts = document.querySelector("#panel-prompts");
const clearKeysButton = document.querySelector("#clear-keys-button");
const feishuWebhookFields = document.querySelector("#feishu-webhook-fields");
const feishuAppFields = document.querySelector("#feishu-app-fields");
const feishuTestButton = document.querySelector("#feishu-test-button");
const feishuTestStatus = document.querySelector("#feishu-test-status");

const PROMPT_EDITORS = ["textSystem", "mergeSystem", "visionSystem", "screenshotSystem"].map((key) => ({
  key,
  input: document.querySelector(`[data-prompt-input="${key}"]`),
  badge: document.querySelector(`[data-prompt-badge="${key}"]`),
  reset: document.querySelector(`[data-prompt-reset="${key}"]`)
}));

// 编辑框始终展示完整提示词（覆盖优先，否则内置默认）；与内置一致的项保存时不落库，仍跟随插件默认更新。
function refreshPromptEditorState(editor) {
  const customized = Boolean(editor.input.value.trim()) && editor.input.value.trim() !== XhsPrompts[editor.key];
  editor.badge.hidden = !customized;
  editor.reset.disabled = !customized;
  editor.reset.title = customized ? "恢复为内置默认提示词" : "当前已是内置默认提示词，无需恢复";
  refreshPromptsTabBadge();
}

function refreshPromptsTabBadge() {
  const count = PROMPT_EDITORS.filter((editor) => !editor.badge.hidden).length;
  promptsTabBadge.hidden = count === 0;
  promptsTabBadge.textContent = count ? String(count) : "";
}

const OPTION_TABS = [
  { name: "models", button: tabModelsButton, panel: panelModels },
  { name: "prompts", button: tabPromptsButton, panel: panelPrompts }
];

function switchOptionTab(name) {
  for (const tab of OPTION_TABS) {
    const active = tab.name === name;
    tab.button.setAttribute("aria-selected", String(active));
    tab.panel.hidden = !active;
  }
}

tabModelsButton.addEventListener("click", () => switchOptionTab("models"));
tabPromptsButton.addEventListener("click", () => switchOptionTab("prompts"));

function fillPromptEditors(overrides = {}) {
  for (const editor of PROMPT_EDITORS) {
    editor.input.value = overrides[editor.key] || XhsPrompts[editor.key];
    refreshPromptEditorState(editor);
  }
}

function promptOverridesValue() {
  const overrides = {};
  for (const editor of PROMPT_EDITORS) {
    const value = editor.input.value.trim();
    if (value && value !== XhsPrompts[editor.key]) overrides[editor.key] = value;
  }
  return overrides;
}

for (const editor of PROMPT_EDITORS) {
  editor.input.value = XhsPrompts[editor.key] || "";
  refreshPromptEditorState(editor);
  editor.input.addEventListener("input", () => refreshPromptEditorState(editor));
  editor.reset.addEventListener("click", () => {
    if (editor.input.value.trim() !== XhsPrompts[editor.key] && !confirm("恢复默认会丢弃这条提示词的当前修改，确定吗？")) {
      return;
    }
    cancelCloseCountdown();
    editor.input.value = XhsPrompts[editor.key];
    refreshPromptEditorState(editor);
    setSaveStatus("已填回内置默认提示词，保存全部设置后生效。", "", promptSaveStatus);
  });
}

function selectedFeishuMode() {
  return document.querySelector('input[name="feishu-mode"]:checked')?.value || "webhook";
}

function formValue() {
  return {
    config: {
      text: {
        baseUrl: fields.textBaseUrl.value.trim(),
        model: fields.textModel.value.trim()
      },
      vision: {
        baseUrl: fields.visionBaseUrl.value.trim(),
        model: fields.visionModel.value.trim()
      },
      feishu: {
        mode: selectedFeishuMode(),
        appId: fields.feishuAppId.value.trim(),
        recipientId: fields.feishuRecipientId.value.trim()
      },
      rememberApiKeys: fields.rememberKeys.checked,
      promptOverrides: promptOverridesValue()
    },
    secrets: {
      textApiKey: fields.textKey.value.trim(),
      visionApiKey: fields.visionKey.value.trim(),
      feishuWebhookUrl: fields.feishuWebhookUrl.value.trim(),
      feishuWebhookSecret: fields.feishuWebhookSecret.value.trim(),
      feishuAppSecret: fields.feishuAppSecret.value.trim()
    }
  };
}

function hasFeishuSettings(values) {
  if (values.config.feishu.mode === "app") {
    return Boolean(
      values.config.feishu.appId ||
      values.secrets.feishuAppSecret ||
      values.config.feishu.recipientId
    );
  }
  return Boolean(values.secrets.feishuWebhookUrl);
}

function permissionPattern(baseUrl) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:") throw new Error("API 地址必须使用 HTTPS。");
  return `${parsed.protocol}//${parsed.host}/*`;
}

async function ensureApiPermissions(baseUrls) {
  const origins = [...new Set(baseUrls.map(permissionPattern))];
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error("需要授权访问所填写的 API 域名，才能测试或调用模型。");
}

function setSaveStatus(text, state = "", target = saveStatus) {
  target.textContent = text;
  target.dataset.state = state;
}

let closeCountdownTimer = null;

function cancelCloseCountdown() {
  if (closeCountdownTimer) {
    clearInterval(closeCountdownTimer);
    closeCountdownTimer = null;
  }
}

async function closeOptionsPage() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {}
  window.close();
}

function beginCloseCountdown(savedText) {
  cancelCloseCountdown();
  let secondsLeft = 3;
  const render = () =>
    setSaveStatus(`${savedText} 本页将在 ${secondsLeft} 秒后自动关闭，也可以直接关闭本页。`, "ok");
  render();
  closeCountdownTimer = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      cancelCloseCountdown();
      closeOptionsPage();
      return;
    }
    render();
  }, 1000);
}

function updateFeishuUi() {
  const mode = selectedFeishuMode();
  feishuWebhookFields.hidden = mode !== "webhook";
  feishuAppFields.hidden = mode !== "app";
}

async function restoreSettings() {
  const response = await chrome.runtime.sendMessage({ type: "XHS_AI_GET_CONFIG" });
  if (!response?.ok) throw new Error(response?.error || "无法读取设置。");
  fields.textBaseUrl.value = response.config.text.baseUrl;
  fields.textModel.value = response.config.text.model;
  fields.visionBaseUrl.value = response.config.vision.baseUrl;
  fields.visionModel.value = response.config.vision.model;
  fields.feishuAppId.value = response.config.feishu?.appId || "";
  fields.feishuRecipientId.value = response.config.feishu?.recipientId || "";
  const mode = response.config.feishu?.mode === "app" ? "app" : "webhook";
  const modeInput = document.querySelector(`input[name="feishu-mode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  fields.rememberKeys.checked = response.config.rememberApiKeys !== false;
  fields.textKey.value = response.secrets.textApiKey || "";
  fields.visionKey.value = response.secrets.visionApiKey || "";
  fields.feishuWebhookUrl.value = response.secrets.feishuWebhookUrl || "";
  fields.feishuWebhookSecret.value = response.secrets.feishuWebhookSecret || "";
  fields.feishuAppSecret.value = response.secrets.feishuAppSecret || "";
  fillPromptEditors(response.config.promptOverrides);
  updateFeishuUi();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  cancelCloseCountdown();
  saveButton.disabled = true;
  promptSaveButton.disabled = true;
  // 提示词页签的保存按钮标记 stay-open：保存后不自动关页，方便反复调整提示词。
  const stayOpen = event.submitter?.dataset.stayOpen === "true";
  const statusTarget = stayOpen ? promptSaveStatus : saveStatus;
  setSaveStatus("正在保存设置…", "", statusTarget);
  try {
    const values = formValue();
    const permissionUrls = [values.config.text.baseUrl, values.config.vision.baseUrl];
    if (hasFeishuSettings(values)) permissionUrls.push("https://open.feishu.cn");
    await ensureApiPermissions(permissionUrls);
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_SAVE_CONFIG", ...values });
    if (!response?.ok) throw new Error(response?.error || "保存失败。");
    if (stayOpen) {
      setSaveStatus("已保存，本页保持打开，可继续调整提示词。", "ok", promptSaveStatus);
    } else {
      beginCloseCountdown(
        values.config.rememberApiKeys
          ? "设置已全部保存到本机浏览器，重启后无需重新填写。"
          : "设置已全部保存到当前会话，关闭浏览器后会自动清除。"
      );
    }
  } catch (error) {
    setSaveStatus(error?.message || "保存失败。", "error", statusTarget);
  } finally {
    saveButton.disabled = false;
    promptSaveButton.disabled = false;
  }
});

document.querySelectorAll('input[name="feishu-mode"]').forEach((input) => {
  input.addEventListener("change", updateFeishuUi);
});

clearKeysButton.addEventListener("click", async () => {
  cancelCloseCountdown();
  clearKeysButton.disabled = true;
  setSaveStatus("正在清除已保存密钥…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_CLEAR_KEYS" });
    if (!response?.ok) throw new Error(response?.error || "清除失败。");
    fields.textKey.value = "";
    fields.visionKey.value = "";
    fields.feishuWebhookUrl.value = "";
    fields.feishuWebhookSecret.value = "";
    fields.feishuAppSecret.value = "";
    setSaveStatus("模型 API Key、飞书 Webhook 与 App Secret 已全部清除。", "ok");
  } catch (error) {
    setSaveStatus(error?.message || "清除失败。", "error");
  } finally {
    clearKeysButton.disabled = false;
  }
});

feishuTestButton.addEventListener("click", async () => {
  feishuTestButton.disabled = true;
  feishuTestStatus.textContent = "正在发送…";
  feishuTestStatus.dataset.state = "";
  try {
    const values = formValue();
    await ensureApiPermissions(["https://open.feishu.cn"]);
    const response = await chrome.runtime.sendMessage({
      type: "XHS_AI_TEST_FEISHU",
      ...values
    });
    if (!response?.ok) throw new Error(response?.error || "测试消息发送失败。");
    feishuTestStatus.textContent = response.detail;
    feishuTestStatus.dataset.state = "ok";
  } catch (error) {
    feishuTestStatus.textContent = error?.message || "测试消息发送失败。";
    feishuTestStatus.dataset.state = "error";
  } finally {
    feishuTestButton.disabled = false;
  }
});

document.querySelectorAll(".test-button[data-provider]").forEach((button) => {
  button.addEventListener("click", async () => {
    const provider = button.dataset.provider;
    const status = document.querySelector(provider === "vision" ? "#vision-test-status" : "#text-test-status");
    button.disabled = true;
    status.textContent = "正在连接…";
    status.dataset.state = "";
    try {
      const values = formValue();
      const targetUrl = provider === "vision" ? values.config.vision.baseUrl : values.config.text.baseUrl;
      await ensureApiPermissions([targetUrl]);
      const response = await chrome.runtime.sendMessage({
        type: "XHS_AI_TEST_PROVIDER",
        provider,
        ...values
      });
      if (!response?.ok) throw new Error(response?.error || "连接失败。");
      status.textContent = `连接成功 · ${response.detail}`;
      status.dataset.state = "ok";
    } catch (error) {
      status.textContent = error?.message || "连接失败。";
      status.dataset.state = "error";
    } finally {
      button.disabled = false;
    }
  });
});

restoreSettings().catch((error) => setSaveStatus(error?.message || "无法读取设置。", "error"));
