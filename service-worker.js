importScripts("prompts.js", "ai-pipeline.js");

const CONFIG_KEY = "xhsAiConfig";
const SECRETS_KEY = "xhsAiSecrets";
const PERSISTENT_SECRETS_KEY = "xhsAiPersistentSecrets";
const CACHE_KEY = "xhsAiCacheV1";
const WORKFLOW_STATES_KEY = "xhsAiWorkflowStatesV1";
const MERGE_BASKET_KEY = "xhsAiMergeBasketV1";
const MAX_CACHE_ENTRIES = 16;
const MAX_WORKFLOW_STATES = 12;
const MAX_MERGE_ITEMS = 5;
const MAX_SCREENSHOT_IMAGES = 8;
const FEISHU_API_ORIGIN = "https://open.feishu.cn";
const FEISHU_REQUEST_TIMEOUT_MS = 15000;
const EXTENSION_PAGE_MESSAGES = new Set([
  "XHS_AI_GET_CONFIG",
  "XHS_AI_SAVE_CONFIG",
  "XHS_AI_CLEAR_KEYS",
  "XHS_AI_TEST_PROVIDER",
  "XHS_AI_TEST_FEISHU",
  "XHS_AI_SUMMARIZE",
  "XHS_AI_GET_WORKFLOW",
  "XHS_AI_MERGE_ADD",
  "XHS_AI_MERGE_LIST",
  "XHS_AI_MERGE_REMOVE",
  "XHS_AI_MERGE_CLEAR",
  "XHS_AI_SCREENSHOT_ADD",
  "XHS_AI_SCREENSHOT_RECOGNIZE",
  "XHS_AI_MERGE_SUMMARIZE"
]);
const CONTENT_SCRIPT_MESSAGES = new Set([
  "XHS_EXPORT_PROGRESS",
  "XHS_AI_PREPARE_VISION",
  "XHS_AI_SUMMARIZE_PAGE",
  "XHS_AI_WORKFLOW_FAILED",
  "XHS_AI_MERGE_CAPTURE_DONE"
]);

let workflowStateWrite = Promise.resolve();

const storageAccessReady = typeof chrome.storage.local.setAccessLevel === "function"
  ? chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  : Promise.resolve();

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});

function cleanText(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function isXhsPageUrl(value) {
  return postPagePlatform(value) === "xiaohongshu";
}

// 内容脚本消息的来源校验：小红书与微博帖文页均放行。
function isPostPageUrl(value) {
  return postPagePlatform(value) !== null;
}

function postPagePlatform(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "weibo.com" || url.hostname.endsWith(".weibo.com")) {
      return /^\/\d+\/[0-9A-Za-z]+\/?$/.test(url.pathname) ? "weibo" : null;
    }
    if (url.hostname.endsWith("xiaohongshu.com") && /\/explore\/[0-9a-f]{24}/i.test(url.pathname)) {
      return "xiaohongshu";
    }
    return null;
  } catch {
    return null;
  }
}

function workflowKey(tabId) {
  return String(Number(tabId));
}

function broadcastWorkflowState(workflow) {
  if (typeof chrome.runtime.sendMessage === "function") {
    chrome.runtime.sendMessage({ type: "XHS_AI_WORKFLOW_STATE", workflow }).catch(() => {});
  }
}

function updateWorkflowState(tabId, pageSessionId, patch) {
  const operation = workflowStateWrite.then(async () => {
    const stored = await chrome.storage.session.get(WORKFLOW_STATES_KEY);
    const states = stored[WORKFLOW_STATES_KEY] || {};
    const key = workflowKey(tabId);
    const previous = states[key];
    const samePage = previous?.pageSessionId === pageSessionId;
    const next = {
      ...(samePage ? previous : {}),
      ...patch,
      tabId: Number(tabId),
      pageSessionId,
      startedAt: samePage ? previous.startedAt || Date.now() : patch.startedAt || Date.now(),
      updatedAt: Date.now()
    };
    const boundedStates = Object.fromEntries(
      [...Object.entries({ ...states, [key]: next })]
        .sort(([, left], [, right]) => Number(left?.updatedAt || 0) - Number(right?.updatedAt || 0))
        .slice(-MAX_WORKFLOW_STATES)
    );
    await chrome.storage.session.set({ [WORKFLOW_STATES_KEY]: boundedStates });
    broadcastWorkflowState(next);
    return next;
  });
  workflowStateWrite = operation.catch(() => {});
  return operation;
}

async function getWorkflowState(tabId, pageSessionId, pageUrl) {
  if (!Number.isInteger(Number(tabId)) || !pageSessionId || !pageUrl) return null;
  const stored = await chrome.storage.session.get(WORKFLOW_STATES_KEY);
  const workflow = stored[WORKFLOW_STATES_KEY]?.[workflowKey(tabId)] || null;
  if (!workflow || workflow.pageSessionId !== pageSessionId || workflow.pageUrl !== pageUrl) return null;
  return workflow;
}

async function recordCaptureProgress(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error("无法识别正在采集的标签页。");
  const count = Math.max(0, Number(message.count) || 0);
  return updateWorkflowState(tabId, message.pageSessionId, {
    pageUrl: message.pageUrl || sender.url,
    noteId: message.noteId || null,
    status: "working",
    result: null,
    error: null,
    progress: {
      state: "working",
      title: message.title || "正在读取页面",
      detail: message.detail || "正在读取当前帖文…",
      percent: Math.min(30, Math.round((count / 50) * 30)),
      count
    }
  });
}

async function recordWorkflowFailure(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error("无法识别发生错误的标签页。");
  const detail = cleanText(message.error) || "发生未知错误。";
  return updateWorkflowState(tabId, message.pageSessionId, {
    pageUrl: message.pageUrl || sender.url,
    noteId: message.noteId || null,
    status: "error",
    error: detail,
    progress: { state: "error", title: "未能完成", detail, percent: 0 }
  });
}

// “加入合并清单”只采集不概括，需要显式把该页 workflow 标记为完成，避免重开弹窗时停留在“正在处理”。
async function recordMergeCaptureDone(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error("无法识别正在采集的标签页。");
  return updateWorkflowState(tabId, message.pageSessionId, {
    pageUrl: message.pageUrl || sender.url,
    noteId: message.noteId || null,
    status: "done",
    result: null,
    capture: null,
    error: null,
    progress: {
      state: "done",
      title: "已采集完成",
      detail: cleanText(message.detail) || "页面证据已采集完成。",
      percent: 100
    }
  });
}

async function getStoredConfig() {
  await storageAccessReady;
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return XhsAi.normalizeConfig(stored[CONFIG_KEY]);
}

async function getStoredSecrets() {
  await storageAccessReady;
  const [sessionStored, localStored] = await Promise.all([
    chrome.storage.session.get(SECRETS_KEY),
    chrome.storage.local.get(PERSISTENT_SECRETS_KEY)
  ]);
  const sessionSecrets = sessionStored[SECRETS_KEY] || {};
  const persistentSecrets = localStored[PERSISTENT_SECRETS_KEY] || {};
  const saved = { ...persistentSecrets, ...sessionSecrets };
  return {
    textApiKey: saved.textApiKey || saved.deepseekApiKey || "",
    visionApiKey: saved.visionApiKey || saved.qwenApiKey || "",
    feishuWebhookUrl: saved.feishuWebhookUrl || "",
    feishuWebhookSecret: saved.feishuWebhookSecret || "",
    feishuAppSecret: saved.feishuAppSecret || ""
  };
}

function validateFeishuWebhookUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("飞书机器人 Webhook 地址无效。");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "open.feishu.cn" ||
    !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("请填写飞书开放平台生成的完整机器人 Webhook 地址。");
  }
  return parsed.href;
}

function validateFeishuSettings(config, secrets) {
  if (!hasFeishuSettings(config, secrets)) return false;
  if (config.feishu.mode === "webhook") {
    validateFeishuWebhookUrl(secrets?.feishuWebhookUrl);
    return true;
  }
  if (!config.feishu.appId) throw new Error("请填写飞书自建应用的 App ID。");
  if (!String(secrets?.feishuAppSecret || "").trim()) throw new Error("请填写飞书自建应用的 App Secret。");
  feishuRecipientType(config.feishu.recipientId);
  return true;
}

function hasFeishuSettings(config, secrets) {
  if (config.feishu?.mode === "app") {
    return Boolean(
      String(config.feishu.appId || "").trim() ||
      String(secrets?.feishuAppSecret || "").trim() ||
      String(config.feishu.recipientId || "").trim()
    );
  }
  return Boolean(String(secrets?.feishuWebhookUrl || "").trim());
}

function feishuRecipientType(value) {
  const recipient = String(value || "").trim();
  if (/^ou_[A-Za-z0-9_-]+$/.test(recipient)) return "open_id";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return "email";
  throw new Error("接收人需填写飞书企业邮箱或以 ou_ 开头的 Open ID。");
}

async function saveAiSettings(config, secrets) {
  await storageAccessReady;
  const normalized = XhsAi.validateConfig(XhsAi.normalizeConfig(config));
  const safeSecrets = {
    textApiKey: String(secrets?.textApiKey || "").trim(),
    visionApiKey: String(secrets?.visionApiKey || "").trim(),
    feishuWebhookUrl: String(secrets?.feishuWebhookUrl || "").trim(),
    feishuWebhookSecret: String(secrets?.feishuWebhookSecret || "").trim(),
    feishuAppSecret: String(secrets?.feishuAppSecret || "").trim()
  };
  validateFeishuSettings(normalized, safeSecrets);
  const storageJobs = [chrome.storage.local.set({ [CONFIG_KEY]: normalized })];
  if (normalized.rememberApiKeys) {
    storageJobs.push(
      chrome.storage.local.set({ [PERSISTENT_SECRETS_KEY]: safeSecrets }),
      chrome.storage.session.remove(SECRETS_KEY)
    );
  } else {
    storageJobs.push(
      chrome.storage.session.set({ [SECRETS_KEY]: safeSecrets }),
      chrome.storage.local.remove(PERSISTENT_SECRETS_KEY)
    );
  }
  await Promise.all(storageJobs);
  return { ok: true, config: normalized };
}

async function clearStoredSecrets() {
  await storageAccessReady;
  await Promise.all([
    chrome.storage.session.remove(SECRETS_KEY),
    chrome.storage.local.remove(PERSISTENT_SECRETS_KEY)
  ]);
  return { ok: true };
}

async function feishuWebhookSignature(timestamp, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${timestamp}\n${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array());
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function postFeishuJson(url, body, authorization = "") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEISHU_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(authorization ? { Authorization: authorization } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`飞书返回了无法解析的响应（HTTP ${response.status}）。`);
    }
    const code = data.code ?? data.StatusCode;
    if (!response.ok || (code !== undefined && Number(code) !== 0)) {
      const detail = cleanText(data.msg || data.StatusMessage || data.message) || `HTTP ${response.status}`;
      throw new Error(`飞书接口拒绝了请求：${detail}`);
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("连接飞书超时，请稍后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendFeishuMessage(text, config, secrets) {
  if (!validateFeishuSettings(config, secrets)) return null;
  const messageText = String(text || "").trim();
  if (!messageText) throw new Error("没有可推送的概括内容。");

  if (config.feishu.mode === "webhook") {
    const webhookUrl = validateFeishuWebhookUrl(secrets.feishuWebhookUrl);
    const body = { msg_type: "text", content: { text: messageText } };
    if (secrets.feishuWebhookSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      body.timestamp = timestamp;
      body.sign = await feishuWebhookSignature(timestamp, secrets.feishuWebhookSecret);
    }
    await postFeishuJson(webhookUrl, body);
    return { channel: "webhook" };
  }

  const tokenResponse = await postFeishuJson(`${FEISHU_API_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`, {
    app_id: config.feishu.appId,
    app_secret: secrets.feishuAppSecret
  });
  const tenantToken = tokenResponse.tenant_access_token;
  if (!tenantToken) throw new Error("飞书未返回 tenant_access_token，请检查应用凭据。");
  const recipientType = feishuRecipientType(config.feishu.recipientId);
  await postFeishuJson(
    `${FEISHU_API_ORIGIN}/open-apis/im/v1/messages?receive_id_type=${recipientType}`,
    {
      receive_id: config.feishu.recipientId,
      msg_type: "text",
      content: JSON.stringify({ text: messageText })
    },
    `Bearer ${tenantToken}`
  );
  return { channel: "direct" };
}

async function pushFeishuNotification(text, config, secrets) {
  if (!hasFeishuSettings(config, secrets)) return null;
  try {
    const delivered = await sendFeishuMessage(text, config, secrets);
    return { status: "sent", channel: delivered.channel, sentAt: Date.now() };
  } catch (error) {
    return {
      status: "failed",
      error: cleanText(error?.message || "飞书推送失败。").slice(0, 180)
    };
  }
}

async function testFeishuSettings(rawConfig, secrets) {
  const config = XhsAi.normalizeConfig(rawConfig);
  XhsAi.validateConfig(config);
  if (!hasFeishuSettings(config, secrets)) throw new Error("请先填写当前推送方式所需的飞书配置。");
  const delivered = await sendFeishuMessage("薯页摘录：飞书推送测试成功。", config, secrets || {});
  return {
    ok: true,
    detail: delivered.channel === "direct" ? "已向指定账号发送测试消息" : "已向机器人所在群发送测试消息"
  };
}

async function prepareVisionPayload(message, sender) {
  const tabId = sender?.tab?.id;
  const payload = message.payload;
  const pageSessionId = cleanText(message.pageSessionId || payload?.source?.pageSessionId);
  const pageUrl = cleanText(payload?.source?.url || sender?.url);
  if (
    !Number.isInteger(tabId) ||
    !pageSessionId ||
    !payload?.source?.noteId ||
    !payload?.media ||
    !isPostPageUrl(pageUrl)
  ) {
    throw new Error("无法确认图片所属的帖文页面，请刷新页面后重试。");
  }

  const [config, secrets, cacheRecord] = await Promise.all([
    getStoredConfig(),
    getStoredSecrets(),
    chrome.storage.session.get(CACHE_KEY)
  ]);
  const cache = cacheRecord[CACHE_KEY] || {};
  const prepared = await XhsAi.prepareVision(payload, config, secrets, cache);
  const latestRecord = await chrome.storage.session.get(CACHE_KEY);
  const mergedCache = { ...(latestRecord[CACHE_KEY] || {}), ...prepared.cache };
  const boundedCache = Object.fromEntries(Object.entries(mergedCache).slice(-MAX_CACHE_ENTRIES));
  await chrome.storage.session.set({ [CACHE_KEY]: boundedCache });
  return {
    ok: true,
    preparedVision: {
      key: prepared.key,
      items: prepared.items,
      status: prepared.status
    }
  };
}

async function summarizePayload(payload, force, progressListener = () => {}, preparedVision = null) {
  const isScreenshot = payload?.source?.origin === "user_screenshot";
  if (!payload?.commentExport || !payload?.media || (!payload?.source?.noteId && !isScreenshot)) {
    throw new Error("页面采集数据不完整，请重新打开帖文后再试。");
  }
  const [config, secrets, cacheRecord] = await Promise.all([
    getStoredConfig(),
    getStoredSecrets(),
    chrome.storage.session.get(CACHE_KEY)
  ]);
  const cache = cacheRecord[CACHE_KEY] || {};
  const result = await XhsAi.summarize(
    payload,
    config,
    secrets,
    cache,
    progressListener,
    Boolean(force),
    preparedVision
  );
  const { cache: updatedCache, ...publicResult } = result;
  if (hasFeishuSettings(config, secrets)) {
    progressListener({ stage: "notification", percent: 96, detail: "概括已生成，正在推送到飞书" });
  }
  const notification = await pushFeishuNotification(publicResult.text, config, secrets);
  const storedResult = {
    ...publicResult,
    notification,
    noteId: payload.source?.noteId || null,
    createdAt: Date.now()
  };
  const boundedCache = Object.fromEntries(Object.entries(updatedCache).slice(-MAX_CACHE_ENTRIES));
  await chrome.storage.session.set({ [CACHE_KEY]: boundedCache });
  return { ok: true, result: storedResult };
}

async function summarizePagePayload(message, sender) {
  const tabId = sender?.tab?.id;
  const payload = message.payload;
  const pageSessionId = cleanText(message.pageSessionId || payload?.source?.pageSessionId);
  const pageUrl = cleanText(payload?.source?.url || sender?.url);
  if (!Number.isInteger(tabId) || !pageSessionId || !isPostPageUrl(pageUrl)) {
    throw new Error("无法确认当前帖文页面，请刷新页面后重试。");
  }

  await updateWorkflowState(tabId, pageSessionId, {
    pageUrl,
    noteId: payload?.source?.noteId || null,
    status: "working",
    capture: payload,
    result: null,
    error: null,
    progress: {
      state: "working",
      title: "页面证据已就绪",
      detail: `已读取 ${payload?.commentExport?.extractedTopLevelCount || 0} 条一级评论和 ${payload?.media?.images?.length || 0} ${payload?.media?.video ? "帧视频画面" : "张图片"}`,
      percent: 30
    }
  });

  const onProgress = (progress) => {
    const title = progress.stage === "vision"
      ? "正在识别图片与视频画面"
      : progress.stage === "text"
        ? "正在撰写概括"
        : progress.stage === "notification"
          ? "正在推送飞书"
          : "正在完成概括";
    updateWorkflowState(tabId, pageSessionId, {
      pageUrl,
      noteId: payload?.source?.noteId || null,
      status: "working",
      progress: {
        state: "working",
        title,
        detail: progress.detail || "正在处理…",
        percent: progress.percent || 30
      }
    }).catch(() => {});
  };

  try {
    const response = await summarizePayload(payload, message.force, onProgress, message.preparedVision);
    const notification = response.result.notification;
    const completionDetail = notification?.status === "sent"
      ? "概括已生成，并已推送到飞书。"
      : notification?.status === "failed"
        ? `概括已生成；飞书推送失败：${notification.error}`
        : message.force
          ? "新版本已替换原概括。"
          : "已按固定格式生成，可直接复制。";
    await updateWorkflowState(tabId, pageSessionId, {
      pageUrl,
      noteId: payload?.source?.noteId || null,
      status: "done",
      capture: payload,
      result: response.result,
      error: null,
      progress: {
        state: "done",
        title: message.force ? "重新生成完成" : "概括完成",
        detail: completionDetail,
        percent: 100
      }
    });
    return response;
  } catch (error) {
    const detail = error?.message || "发生未知错误。";
    await updateWorkflowState(tabId, pageSessionId, {
      pageUrl,
      noteId: payload?.source?.noteId || null,
      status: "error",
      capture: payload,
      error: detail,
      progress: { state: "error", title: "未能完成", detail, percent: 0 }
    });
    throw error;
  }
}

async function getWorkflowForPanel(message) {
  const workflow = await getWorkflowState(message.tabId, message.pageSessionId, message.pageUrl);
  return { ok: true, workflow };
}

function basketItemSummary(item) {
  const payload = item?.payload || {};
  return {
    id: item.id,
    kind: item.kind,
    platform: payload.source?.platform === "weibo" ? "weibo" : "xiaohongshu",
    title: cleanText(payload.note?.title) || "（无标题帖文）",
    author: cleanText(payload.note?.author) || null,
    publishedDisplay: cleanText(payload.note?.publishedDisplay) || null,
    commentCount: payload.commentExport?.extractedTopLevelCount || 0,
    imageCount: payload.media?.images?.length || 0,
    isVideo: Boolean(payload.media?.video),
    hasUrl: Boolean(cleanText(payload.source?.url)),
    addedAt: item.addedAt
  };
}

async function getMergeBasket() {
  const stored = await chrome.storage.session.get(MERGE_BASKET_KEY);
  return stored[MERGE_BASKET_KEY] || [];
}

async function addToMergeBasket(payload) {
  if (!payload?.note || !payload?.commentExport || !payload?.source) {
    throw new Error("要加入清单的采集数据不完整，请重新采集后再试。");
  }
  const isScreenshot = payload.source.origin === "user_screenshot";
  if (!isScreenshot && !payload.source.noteId) {
    throw new Error("采集数据缺少帖文 ID，无法加入清单。");
  }
  // 微博 ID 与小红书 ID 的命名空间不同，清单条目 ID 带平台前缀避免混淆。
  const liveIdPrefix = payload.source.platform === "weibo" ? "wbnote:" : "note:";
  const id = isScreenshot
    ? `shot:${payload.source.screenshotId}`
    : `${liveIdPrefix}${payload.source.noteId}`;

  const items = await getMergeBasket();
  const existingIndex = items.findIndex((item) => item.id === id);
  const item = { id, kind: isScreenshot ? "user_screenshot" : "live_page", addedAt: Date.now(), payload };
  if (existingIndex >= 0) {
    items[existingIndex] = item;
  } else {
    if (items.length >= MAX_MERGE_ITEMS) {
      throw new Error(`合并清单最多保留 ${MAX_MERGE_ITEMS} 条帖文，请先移除部分条目。`);
    }
    items.push(item);
  }
  await chrome.storage.session.set({ [MERGE_BASKET_KEY]: items });
  return { ok: true, replaced: existingIndex >= 0, basket: items.map(basketItemSummary) };
}

async function removeFromMergeBasket(message) {
  const id = cleanText(message?.id);
  if (!id) throw new Error("缺少要移除的清单条目。");
  const items = (await getMergeBasket()).filter((item) => item.id !== id);
  await chrome.storage.session.set({ [MERGE_BASKET_KEY]: items });
  return { ok: true, basket: items.map(basketItemSummary) };
}

async function clearMergeBasket() {
  await chrome.storage.session.set({ [MERGE_BASKET_KEY]: [] });
  return { ok: true, basket: [] };
}

async function listMergeBasket() {
  return { ok: true, basket: (await getMergeBasket()).map(basketItemSummary) };
}

function validateScreenshotSourceUrl(value) {
  const sourceUrl = cleanText(value);
  if (!sourceUrl) return "";
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("原始链接不是有效网址。");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !(host.endsWith("xiaohongshu.com") || host === "xhslink.cn" || host.endsWith(".xhslink.cn"))) {
    throw new Error("原始链接需为小红书帖文地址（xiaohongshu.com 或 xhslink.cn）。");
  }
  return parsed.href;
}

async function recognizeScreenshots(message) {
  const images = (Array.isArray(message?.images) ? message.images : [])
    .filter((item) => typeof item === "string" && item.startsWith("data:image/"));
  if (!images.length) throw new Error("请先选择要识别的帖文截图。");
  if (images.length > MAX_SCREENSHOT_IMAGES) {
    throw new Error(`单次最多识别 ${MAX_SCREENSHOT_IMAGES} 张截图，请分批上传。`);
  }
  const sourceUrl = validateScreenshotSourceUrl(message?.sourceUrl);

  const [config, secrets] = await Promise.all([getStoredConfig(), getStoredSecrets()]);
  const visionApiKey = secrets.visionApiKey || secrets.qwenApiKey;
  if (!cleanText(visionApiKey)) throw new Error("识别截图需要先配置图片模型 API Key，请打开设置填写。");

  const extraction = await XhsAi.analyzeScreenshots(images, config, visionApiKey);
  const payload = XhsAi.buildScreenshotPayload(extraction, {
    sourceUrl,
    screenshotId: crypto.randomUUID?.() || `shot-${Date.now()}-${Math.random().toString(16).slice(2)}`
  });
  return { ok: true, payload, warnings: payload.uncertainties || [] };
}

async function addScreenshotToBasket(message) {
  const recognized = await recognizeScreenshots(message);
  const added = await addToMergeBasket(recognized.payload);
  return { ...added, warnings: recognized.warnings };
}

async function summarizeMergeBasket(message) {
  const items = await getMergeBasket();
  if (!items.length) throw new Error("合并清单是空的，请先加入帖文或上传截图。");
  const payloads = items.map((item) => item.payload);

  const [config, secrets, cacheRecord] = await Promise.all([
    getStoredConfig(),
    getStoredSecrets(),
    chrome.storage.session.get(CACHE_KEY)
  ]);
  const cache = cacheRecord[CACHE_KEY] || {};
  const onProgress = (progress) => {
    chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_PROGRESS", progress }).catch(() => {});
  };

  const result = await XhsAi.summarizeMerged(payloads, config, secrets, cache, onProgress, Boolean(message?.force));
  const { cache: updatedCache, ...publicResult } = result;
  if (hasFeishuSettings(config, secrets)) {
    onProgress({ stage: "notification", percent: 96, detail: "概括已生成，正在推送到飞书" });
  }
  const notification = await pushFeishuNotification(publicResult.text, config, secrets);
  const boundedCache = Object.fromEntries(Object.entries(updatedCache).slice(-MAX_CACHE_ENTRIES));
  await chrome.storage.session.set({ [CACHE_KEY]: boundedCache });
  return {
    ok: true,
    result: {
      ...publicResult,
      notification,
      merged: true,
      postCount: payloads.length,
      createdAt: Date.now()
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (EXTENSION_PAGE_MESSAGES.has(message?.type)) {
    const extensionRoot = chrome.runtime.getURL("");
    if (!String(sender?.url || "").startsWith(extensionRoot)) {
      sendResponse({ ok: false, error: "该操作只能从插件界面发起。" });
      return false;
    }
  }
  if (CONTENT_SCRIPT_MESSAGES.has(message?.type) && (!isPostPageUrl(sender?.url) || !Number.isInteger(sender?.tab?.id))) {
    sendResponse({ ok: false, error: "该操作只能从小红书或微博帖文页面发起。" });
    return false;
  }
  let task;
  switch (message?.type) {
    case "XHS_EXPORT_PROGRESS":
      task = recordCaptureProgress(message, sender).then(() => ({ ok: true }));
      break;
    case "XHS_AI_GET_CONFIG":
      task = Promise.all([getStoredConfig(), getStoredSecrets()]).then(([config, secrets]) => ({ ok: true, config, secrets }));
      break;
    case "XHS_AI_SAVE_CONFIG":
      task = saveAiSettings(message.config, message.secrets);
      break;
    case "XHS_AI_CLEAR_KEYS":
      task = clearStoredSecrets();
      break;
    case "XHS_AI_TEST_PROVIDER":
      task = XhsAi.testProvider(message.provider, message.config, message.secrets);
      break;
    case "XHS_AI_TEST_FEISHU":
      task = testFeishuSettings(message.config, message.secrets);
      break;
    case "XHS_AI_SUMMARIZE":
      task = summarizePayload(message.payload, message.force);
      break;
    case "XHS_AI_SUMMARIZE_PAGE":
      task = summarizePagePayload(message, sender);
      break;
    case "XHS_AI_PREPARE_VISION":
      task = prepareVisionPayload(message, sender);
      break;
    case "XHS_AI_WORKFLOW_FAILED":
      task = recordWorkflowFailure(message, sender).then(() => ({ ok: true }));
      break;
    case "XHS_AI_MERGE_CAPTURE_DONE":
      task = recordMergeCaptureDone(message, sender).then(() => ({ ok: true }));
      break;
    case "XHS_AI_MERGE_ADD":
      task = addToMergeBasket(message.payload);
      break;
    case "XHS_AI_MERGE_LIST":
      task = listMergeBasket();
      break;
    case "XHS_AI_MERGE_REMOVE":
      task = removeFromMergeBasket(message);
      break;
    case "XHS_AI_MERGE_CLEAR":
      task = clearMergeBasket();
      break;
    case "XHS_AI_SCREENSHOT_ADD":
      task = addScreenshotToBasket(message);
      break;
    case "XHS_AI_SCREENSHOT_RECOGNIZE":
      task = recognizeScreenshots(message);
      break;
    case "XHS_AI_MERGE_SUMMARIZE":
      task = summarizeMergeBasket(message);
      break;
    case "XHS_AI_GET_WORKFLOW":
      task = getWorkflowForPanel(message);
      break;
    default:
      return undefined;
  }

  Promise.resolve(task)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || "操作失败" }));
  return true;
});
