const fields = {
  deepseekBaseUrl: document.querySelector("#deepseek-base-url"),
  deepseekModel: document.querySelector("#deepseek-model"),
  deepseekKey: document.querySelector("#deepseek-key"),
  qwenBaseUrl: document.querySelector("#qwen-base-url"),
  qwenModel: document.querySelector("#qwen-model"),
  qwenKey: document.querySelector("#qwen-key")
};

const form = document.querySelector("#settings-form");
const saveButton = document.querySelector("#save-button");
const saveStatus = document.querySelector("#save-status");

function formValue() {
  return {
    config: {
      text: {
        baseUrl: fields.deepseekBaseUrl.value.trim(),
        model: fields.deepseekModel.value.trim()
      },
      vision: {
        baseUrl: fields.qwenBaseUrl.value.trim(),
        model: fields.qwenModel.value.trim()
      },
      includeVisibleReplies: true,
      commentLimit: 50
    },
    secrets: {
      deepseekApiKey: fields.deepseekKey.value.trim(),
      qwenApiKey: fields.qwenKey.value.trim()
    }
  };
}

function setSaveStatus(text, state = "") {
  saveStatus.textContent = text;
  saveStatus.dataset.state = state;
}

async function restoreSettings() {
  const response = await chrome.runtime.sendMessage({ type: "XHS_AI_GET_CONFIG" });
  if (!response?.ok) throw new Error(response?.error || "无法读取设置。");
  fields.deepseekBaseUrl.value = response.config.text.baseUrl;
  fields.deepseekModel.value = response.config.text.model;
  fields.qwenBaseUrl.value = response.config.vision.baseUrl;
  fields.qwenModel.value = response.config.vision.model;
  fields.deepseekKey.value = response.secrets.deepseekApiKey || "";
  fields.qwenKey.value = response.secrets.qwenApiKey || "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  setSaveStatus("正在保存设置…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_SAVE_CONFIG", ...formValue() });
    if (!response?.ok) throw new Error(response?.error || "保存失败。");
    setSaveStatus("已保存。API Key 会在关闭浏览器后自动清除。", "ok");
  } catch (error) {
    setSaveStatus(error?.message || "保存失败。", "error");
  } finally {
    saveButton.disabled = false;
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
      const response = await chrome.runtime.sendMessage({
        type: "XHS_AI_TEST_PROVIDER",
        provider,
        ...formValue()
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
