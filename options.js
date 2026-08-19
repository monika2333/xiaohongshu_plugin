const fields = {
  textBaseUrl: document.querySelector("#text-base-url"),
  textModel: document.querySelector("#text-model"),
  textKey: document.querySelector("#text-key"),
  visionBaseUrl: document.querySelector("#vision-base-url"),
  visionModel: document.querySelector("#vision-model"),
  visionKey: document.querySelector("#vision-key"),
  rememberKeys: document.querySelector("#remember-keys")
};

const form = document.querySelector("#settings-form");
const saveButton = document.querySelector("#save-button");
const saveStatus = document.querySelector("#save-status");
const clearKeysButton = document.querySelector("#clear-keys-button");
const storageModeHint = document.querySelector("#storage-mode-hint");

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
      rememberApiKeys: fields.rememberKeys.checked,
      includeVisibleReplies: true,
      commentLimit: 50
    },
    secrets: {
      textApiKey: fields.textKey.value.trim(),
      visionApiKey: fields.visionKey.value.trim()
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

function updateStorageModeHint() {
  storageModeHint.textContent = fields.rememberKeys.checked
    ? "浏览器和电脑重启后仍可直接使用，仅本插件的可信页面可以读取。"
    : "只保留到浏览器关闭、插件重新加载或更新，之后需要重新填写。";
}

async function restoreSettings() {
  const response = await chrome.runtime.sendMessage({ type: "XHS_AI_GET_CONFIG" });
  if (!response?.ok) throw new Error(response?.error || "无法读取设置。");
  fields.textBaseUrl.value = response.config.text.baseUrl;
  fields.textModel.value = response.config.text.model;
  fields.visionBaseUrl.value = response.config.vision.baseUrl;
  fields.visionModel.value = response.config.vision.model;
  fields.rememberKeys.checked = response.config.rememberApiKeys !== false;
  fields.textKey.value = response.secrets.textApiKey || "";
  fields.visionKey.value = response.secrets.visionApiKey || "";
  updateStorageModeHint();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  setSaveStatus("正在保存设置…");
  try {
    const values = formValue();
    await ensureApiPermissions([values.config.text.baseUrl, values.config.vision.baseUrl]);
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_SAVE_CONFIG", ...values });
    if (!response?.ok) throw new Error(response?.error || "保存失败。");
    setSaveStatus(
      values.config.rememberApiKeys
        ? "已保存到本机浏览器，重启后无需重新填写。"
        : "已保存到当前会话，关闭浏览器后会自动清除。",
      "ok"
    );
  } catch (error) {
    setSaveStatus(error?.message || "保存失败。", "error");
  } finally {
    saveButton.disabled = false;
  }
});

fields.rememberKeys.addEventListener("change", updateStorageModeHint);

clearKeysButton.addEventListener("click", async () => {
  clearKeysButton.disabled = true;
  setSaveStatus("正在清除已保存密钥…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_CLEAR_KEYS" });
    if (!response?.ok) throw new Error(response?.error || "清除失败。");
    fields.textKey.value = "";
    fields.visionKey.value = "";
    setSaveStatus("文字与图片模型的 API Key 已从本机和当前会话中清除。", "ok");
  } catch (error) {
    setSaveStatus(error?.message || "清除失败。", "error");
  } finally {
    clearKeysButton.disabled = false;
  }
});

document.querySelectorAll(".test-button").forEach((button) => {
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
