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
  rememberKeys: document.querySelector("#remember-keys"),
  splitModels: document.querySelector("#split-models")
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
const visionGroup = document.querySelector("#vision-group");
const textGroupTitle = document.querySelector("#text-group-title");
const textTestButton = document.querySelector("#text-test-button");
const switchToSplitButton = document.querySelector("#switch-to-split-button");
const modelIntro = document.querySelector("#model-intro");
const flowVision = document.querySelector("#flow-vision");
const flowText = document.querySelector("#flow-text");

const MODEL_INTRO = {
  shared: "文字概括与图片识别默认共用一个模型，只需填一份 API Key。模型需同时支持文字与图片输入，点「测试模型」会一并检查。",
  split: "文字概括与图片识别分别使用下面两组设置。图片模型需支持图像输入。"
};

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

function modelMode() {
  return fields.splitModels.checked ? "split" : "shared";
}

// 图片那组是否已有用户自己的设置：没有时，第一次开启分开配置先用当前文字设置填好，用户只改需要改的。
let visionConfigured = false;

function updateModelModeUi() {
  const split = modelMode() === "split";
  visionGroup.hidden = !split;
  textGroupTitle.hidden = !split;
  switchToSplitButton.hidden = true;
  textTestButton.textContent = split ? "测试文字模型" : "测试模型";
  const introLink = modelIntro.querySelector?.("a");
  modelIntro.textContent = MODEL_INTRO[split ? "split" : "shared"];
  if (introLink) modelIntro.append(introLink);
  flowVision.textContent = split ? "图片模型识别" : "模型识别图片";
  flowText.textContent = split ? "文字模型编写" : "模型编写简报";
}

function prefillVisionFromText() {
  if (visionConfigured) return;
  fields.visionBaseUrl.value = fields.textBaseUrl.value;
  fields.visionModel.value = fields.textModel.value;
  fields.visionKey.value = "";
  visionConfigured = true;
}

function setModelMode(split) {
  fields.splitModels.checked = split;
  if (split) prefillVisionFromText();
  updateModelModeUi();
}

fields.splitModels.addEventListener("change", () => {
  cancelCloseCountdown();
  setModelMode(fields.splitModels.checked);
});

switchToSplitButton.addEventListener("click", () => {
  cancelCloseCountdown();
  setModelMode(true);
  fields.visionModel.focus?.();
});

function selectedFeishuMode() {
  return document.querySelector('input[name="feishu-mode"]:checked')?.value || "webhook";
}

function formValue() {
  return {
    config: {
      modelMode: modelMode(),
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
  visionConfigured = response.config.modelMode === "split";
  fields.splitModels.checked = response.config.modelMode === "split";
  updateModelModeUi();
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
    const permissionUrls = [values.config.text.baseUrl];
    if (values.config.modelMode === "split") permissionUrls.push(values.config.vision.baseUrl);
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
    const values = formValue();
    // 共用模式下文字那组的测试按钮同时测文字与图片（provider: shared）。
    const provider = button.dataset.provider === "vision"
      ? "vision"
      : (values.config.modelMode === "shared" ? "shared" : "text");
    const status = document.querySelector(provider === "vision" ? "#vision-test-status" : "#text-test-status");
    button.disabled = true;
    if (provider === "shared") switchToSplitButton.hidden = true;
    status.textContent = { text: "正在连接…", vision: "正在测试图片识别…", shared: "正在测试文字与图片识别…" }[provider];
    status.dataset.state = "";
    try {
      const targetUrl = provider === "vision" ? values.config.vision.baseUrl : values.config.text.baseUrl;
      await ensureApiPermissions([targetUrl]);
      const response = await chrome.runtime.sendMessage({
        type: "XHS_AI_TEST_PROVIDER",
        provider,
        ...values
      });
      if (!response?.ok) throw new Error(response?.error || "连接失败。");
      if (provider === "shared" && response.vision?.ok === false) {
        status.textContent = `文字可用，图片识别失败：${response.vision.error} 帖文配图和截图将无法识别，可改为分开配置另选图片模型。`;
        status.dataset.state = "error";
        switchToSplitButton.hidden = false;
      } else if (provider === "shared") {
        status.textContent = `连接成功 · 文字与图片均可用（${response.vision?.detail || response.detail}）`;
        status.dataset.state = "ok";
      } else {
        status.textContent = `连接成功 · ${response.detail}`;
        status.dataset.state = "ok";
      }
    } catch (error) {
      status.textContent = error?.message || "连接失败。";
      status.dataset.state = "error";
    } finally {
      button.disabled = false;
    }
  });
});

// —— 截图存档：开关与存放文件夹即时生效，不走「保存全部设置」 ——
const archiveEnabledInput = document.querySelector("#archive-enabled");
const archiveFolderButton = document.querySelector("#archive-folder-button");
const archiveFolderStatus = document.querySelector("#archive-folder-status");
const archiveStatus = document.querySelector("#archive-status");
const Archive = globalThis.XhsArchive || null;

function setArchiveStatus(text, state = "") {
  if (!archiveStatus) return;
  archiveStatus.textContent = text;
  archiveStatus.dataset.state = state;
}

async function refreshArchiveUi() {
  if (!Archive || !archiveEnabledInput) return;
  const settings = await Archive.getSettings();
  const enabled = settings.enabled && (await Archive.hasCapturePermission());
  archiveEnabledInput.checked = enabled;
  const root = await Archive.getRootHandle().catch(() => null);
  if (!root) {
    archiveFolderStatus.textContent = "尚未选择存放文件夹";
    archiveFolderStatus.dataset.state = enabled ? "error" : "";
    return;
  }
  const permission = await Archive.permissionState(root);
  archiveFolderStatus.textContent = permission === "granted"
    ? `存放在「${root.name}」`
    : `存放在「${root.name}」，下次存档时需再点一次「允许」`;
  archiveFolderStatus.dataset.state = permission === "granted" ? "ok" : "";
}

if (Archive && archiveEnabledInput && archiveFolderButton) {
  if (!Archive.isSupported()) {
    archiveEnabledInput.disabled = true;
    archiveFolderButton.disabled = true;
    setArchiveStatus("当前浏览器不支持写入本地文件夹，无法使用截图存档。", "error");
  }

  archiveEnabledInput.addEventListener("change", async () => {
    try {
      if (!archiveEnabledInput.checked) {
        await Archive.setSettings({ enabled: false });
        setArchiveStatus("截图存档已关闭，之后提取帖文不再截图。");
        return;
      }
      const granted = await Archive.requestCapturePermission().catch(() => false);
      if (!granted) {
        archiveEnabledInput.checked = false;
        await Archive.setSettings({ enabled: false });
        setArchiveStatus("没有获得截图所需的「访问所有网站」权限，截图存档保持关闭。", "error");
        return;
      }
      await Archive.setSettings({ enabled: true });
      const root = await Archive.getRootHandle().catch(() => null);
      setArchiveStatus(root
        ? "截图存档已开启。提醒：截图期间请停留在帖文页签，不要切换。"
        : "截图存档已开启，请再选择存放文件夹。提醒：截图期间请停留在帖文页签，不要切换。", root ? "ok" : "error");
    } catch (error) {
      setArchiveStatus(error?.message || "设置未能保存。", "error");
    } finally {
      await refreshArchiveUi().catch(() => {});
    }
  });

  archiveFolderButton.addEventListener("click", async () => {
    try {
      const handle = await globalThis.showDirectoryPicker({ id: "shuye-archive", mode: "readwrite" });
      await Archive.setRootHandle(handle);
      await Archive.setSettings({ folderName: handle.name });
      setArchiveStatus(`已选择「${handle.name}」，之后的存档都写入这个文件夹。`, "ok");
    } catch (error) {
      if (error?.name === "AbortError") return;
      setArchiveStatus(`没能选择文件夹：${error?.message || "未知错误"}`, "error");
    } finally {
      await refreshArchiveUi().catch(() => {});
    }
  });

  refreshArchiveUi().catch(() => {});
}

restoreSettings().catch((error) => setSaveStatus(error?.message || "无法读取设置。", "error"));
