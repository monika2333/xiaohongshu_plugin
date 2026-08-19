const fields = {
  textBaseUrl: document.querySelector("#text-base-url"),
  textModel: document.querySelector("#text-model"),
  textKey: document.querySelector("#text-key"),
  visionBaseUrl: document.querySelector("#vision-base-url"),
  visionModel: document.querySelector("#vision-model"),
  visionKey: document.querySelector("#vision-key"),
  feishuEnabled: document.querySelector("#feishu-enabled"),
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
const clearKeysButton = document.querySelector("#clear-keys-button");
const storageModeHint = document.querySelector("#storage-mode-hint");
const feishuCard = document.querySelector(".notification-card");
const feishuWebhookFields = document.querySelector("#feishu-webhook-fields");
const feishuAppFields = document.querySelector("#feishu-app-fields");
const feishuTestButton = document.querySelector("#feishu-test-button");
const feishuTestStatus = document.querySelector("#feishu-test-status");

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
        enabled: fields.feishuEnabled.checked,
        mode: selectedFeishuMode(),
        appId: fields.feishuAppId.value.trim(),
        recipientId: fields.feishuRecipientId.value.trim()
      },
      rememberApiKeys: fields.rememberKeys.checked,
      includeVisibleReplies: true,
      commentLimit: 50
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

function setSaveStatus(text, state = "") {
  saveStatus.textContent = text;
  saveStatus.dataset.state = state;
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

function updateStorageModeHint() {
  storageModeHint.textContent = fields.rememberKeys.checked
    ? "浏览器和电脑重启后仍可直接使用，仅本插件的可信页面可以读取。"
    : "API Key、Webhook 和 App Secret 只保留到浏览器关闭、插件重新加载或更新。";
}

function updateFeishuUi() {
  const mode = selectedFeishuMode();
  feishuWebhookFields.hidden = mode !== "webhook";
  feishuAppFields.hidden = mode !== "app";
  feishuCard.dataset.enabled = fields.feishuEnabled.checked ? "true" : "false";
}

async function restoreSettings() {
  const response = await chrome.runtime.sendMessage({ type: "XHS_AI_GET_CONFIG" });
  if (!response?.ok) throw new Error(response?.error || "无法读取设置。");
  fields.textBaseUrl.value = response.config.text.baseUrl;
  fields.textModel.value = response.config.text.model;
  fields.visionBaseUrl.value = response.config.vision.baseUrl;
  fields.visionModel.value = response.config.vision.model;
  fields.feishuEnabled.checked = response.config.feishu?.enabled === true;
  fields.feishuAppId.value = response.config.feishu?.appId || "";
  fields.feishuRecipientId.value = response.config.feishu?.recipientId || response.config.feishu?.recipientOpenId || "";
  const mode = response.config.feishu?.mode === "app" ? "app" : "webhook";
  const modeInput = document.querySelector(`input[name="feishu-mode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  fields.rememberKeys.checked = response.config.rememberApiKeys !== false;
  fields.textKey.value = response.secrets.textApiKey || "";
  fields.visionKey.value = response.secrets.visionApiKey || "";
  fields.feishuWebhookUrl.value = response.secrets.feishuWebhookUrl || "";
  fields.feishuWebhookSecret.value = response.secrets.feishuWebhookSecret || "";
  fields.feishuAppSecret.value = response.secrets.feishuAppSecret || "";
  updateStorageModeHint();
  updateFeishuUi();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  cancelCloseCountdown();
  saveButton.disabled = true;
  setSaveStatus("正在保存设置…");
  try {
    const values = formValue();
    const permissionUrls = [values.config.text.baseUrl, values.config.vision.baseUrl];
    if (values.config.feishu.enabled) permissionUrls.push("https://open.feishu.cn");
    await ensureApiPermissions(permissionUrls);
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_SAVE_CONFIG", ...values });
    if (!response?.ok) throw new Error(response?.error || "保存失败。");
    beginCloseCountdown(
      values.config.rememberApiKeys
        ? "设置已全部保存到本机浏览器，重启后无需重新填写。"
        : "设置已全部保存到当前会话，关闭浏览器后会自动清除。"
    );
  } catch (error) {
    setSaveStatus(error?.message || "保存失败。", "error");
  } finally {
    saveButton.disabled = false;
  }
});

fields.rememberKeys.addEventListener("change", updateStorageModeHint);
fields.feishuEnabled.addEventListener("change", updateFeishuUi);
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
