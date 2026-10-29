importScripts("prompts.js", "ai-pipeline.js");

const CONFIG_KEY = "xhsAiConfig";
const SECRETS_KEY = "xhsAiSecrets";
const PERSISTENT_SECRETS_KEY = "xhsAiPersistentSecrets";
const CACHE_KEY = "xhsAiCacheV1";
const WORKFLOW_STATES_KEY = "xhsAiWorkflowStatesV1";
const MERGE_BASKET_KEY = "xhsAiMergeBasketV1";
const HISTORY_KEY = "xhsAiHistoryV1";
const MAX_CACHE_ENTRIES = 16;
const MAX_WORKFLOW_STATES = 12;
const MAX_MERGE_ITEMS = 5;
const MAX_SCREENSHOT_IMAGES = 8;
const MAX_HISTORY_ENTRIES = 100;
const FEISHU_API_ORIGIN = "https://open.feishu.cn";
const FEISHU_REQUEST_TIMEOUT_MS = 15000;
const EXTENSION_PAGE_MESSAGES = new Set([
  "XHS_AI_GET_CONFIG",
  "XHS_AI_SAVE_CONFIG",
  "XHS_AI_CLEAR_KEYS",
  "XHS_AI_TEST_PROVIDER",
  "XHS_AI_TEST_FEISHU",
  "XHS_AI_GET_FEISHU_STATUS",
  "XHS_AI_SEND_FEISHU",
  "XHS_AI_SUMMARIZE",
  "XHS_AI_GET_WORKFLOW",
  "XHS_AI_LIST_WORKFLOWS",
  "XHS_AI_MERGE_ADD",
  "XHS_AI_MERGE_LIST",
  "XHS_AI_MERGE_REMOVE",
  "XHS_AI_MERGE_CLEAR",
  "XHS_AI_SCREENSHOT_ADD",
  "XHS_AI_SCREENSHOT_RECOGNIZE",
  "XHS_AI_MERGE_SUMMARIZE",
  "XHS_AI_HISTORY_LIST",
  "XHS_AI_HISTORY_REMOVE",
  "XHS_AI_HISTORY_CLEAR",
  "XHS_AI_RESOLVE_LINK",
  "XHS_AI_RELINK",
  "XHS_AI_MERGE_SET_LINK",
  "XHS_AI_MERGE_RERENDER"
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
    if (url.hostname.endsWith("xiaohongshu.com") && /\/(explore|discovery\/item)\/[0-9a-f]{24}/i.test(url.pathname)) {
      // /discovery/item/ 是分享短链（xhslink.cn）的落地路径，与 /explore/ 同为帖文页
      return "xiaohongshu";
    }
    return null;
  } catch {
    return null;
  }
}

// —— 链接解析：先把链接归成「平台 + 帖子 ID」，再决定补到哪条素材上 ——
const SHORT_LINK_TIMEOUT_MS = 8000;
const XHS_NOTE_ID_PATTERN = /(?:explore|discovery\/item)\/([0-9a-f]{24})/i;

function xhsNoteIdFromPathname(pathname) {
  return String(pathname || "").match(XHS_NOTE_ID_PATTERN)?.[1] || null;
}

// 微博长链 /<uid>/<id>：路径第二段。mblogid 是字母数字混排；纯数字段是 mid，
// 与页面拿到的 mblogid 对不上，返回 null，由面板按「解析不出 ID」处理。
function weiboNoteIdFromPathname(pathname) {
  const segment = String(pathname || "").match(/^\/\d+\/([0-9A-Za-z]+)\/?$/)?.[1] || null;
  return segment && !/^\d+$/.test(segment) ? segment : null;
}

function xhsNoteIdFromUrlLike(value, baseUrl) {
  const text = String(value || "").replace(/&amp;/g, "&").trim();
  if (!text) return null;
  const direct = text.match(XHS_NOTE_ID_PATTERN);
  if (direct) return direct[1];
  try {
    return xhsNoteIdFromPathname(new URL(text, baseUrl).pathname);
  } catch {
    return null;
  }
}

// 只读 og:url 与 canonical 两处，避免整页正文里的推荐帖 ID 造成误判。
function xhsNoteIdFromHtmlMeta(html, baseUrl) {
  const head = String(html || "").slice(0, 200000);
  const patterns = [
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i
  ];
  for (const pattern of patterns) {
    const match = head.match(pattern);
    const noteId = match ? xhsNoteIdFromUrlLike(match[1], baseUrl) : null;
    if (noteId) return noteId;
  }
  return null;
}

// 短链实测（2026-10-28，本机匿名网络，未登录小红书）：
//   https://xhslink.cn/o/AxnRePgIokn
//   → 302 https://www.xiaohongshu.com/login?redirectPath=http%3A%2F%2Fwww.xiaohongshu.com
//     %2Fdiscovery%2Fitem%2F6a9d0eb2000000002a024480%3F...type%3Dnormal%26xsec_token%3D...
// 路径本身是 /login，帖文 ID 只在 redirectPath 查询参数里，响应 HTML 里没有 og:url 或
// canonical。已登录浏览器里的跳转形态（以及触发风控时的落地页）需要真实登录态样例才能
// 确认，当前按同一套规则兜底：路径 → 查询参数（必要时解两层编码）→ og:url/canonical。
// 查询参数值可能再套一层编码（404 页把 redirectPath 嵌在 source 参数里），所以先解码
// 一次再匹配；HTML 只读这两处元信息，不扫描正文，避免推荐帖 ID 误判。
async function resolveShortShareLink(input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHORT_LINK_TIMEOUT_MS);
  let response;
  try {
    // credentials: "omit"：不在后台请求里带上用户的小红书会话。
    response = await fetch(input, {
      redirect: "follow",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("解析短链超时，请稍后重试，或手动选择这条链接对应的帖文。");
    }
    throw new Error("无法访问短链服务，请检查网络后重试。");
  } finally {
    clearTimeout(timer);
  }

  const resolvedUrl = String(response?.url || input);
  let finalUrl;
  try {
    finalUrl = new URL(resolvedUrl);
  } catch {
    finalUrl = new URL(input);
  }
  let noteId = xhsNoteIdFromPathname(finalUrl.pathname);

  if (!noteId) {
    // URLSearchParams 取值时已经做过一次解码；部分登录页会把地址再编码一层。
    for (const value of finalUrl.searchParams.values()) {
      let decoded = value;
      try { decoded = decodeURIComponent(value); } catch { /* 保留原值 */ }
      noteId = xhsNoteIdFromUrlLike(decoded, finalUrl) || xhsNoteIdFromUrlLike(value, finalUrl);
      if (noteId) break;
    }
  }

  if (!noteId && typeof response?.text === "function") {
    try {
      noteId = xhsNoteIdFromHtmlMeta(await response.text(), finalUrl.href);
    } catch {
      noteId = null;
    }
  }

  return { ok: true, platform: "xiaohongshu", noteId: noteId || null, resolvedUrl: finalUrl.href };
}

async function resolveLink(rawUrl) {
  const input = cleanText(rawUrl);
  if (!input) throw new Error("请先粘贴帖文链接或分享文案。");
  let parsed;
  try {
    parsed = new URL(input.replace(/^http:\/\//i, "https://"));
  } catch {
    throw new Error("链接不是有效网址。");
  }
  if (parsed.protocol !== "https:") throw new Error("链接必须使用 HTTPS。");
  const host = parsed.hostname.toLowerCase();

  if (host === "xhslink.cn" || host.endsWith(".xhslink.cn")) {
    return resolveShortShareLink(parsed.href);
  }
  if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")) {
    const noteId = xhsNoteIdFromPathname(parsed.pathname);
    if (!noteId) throw new Error("这不是小红书帖文地址。");
    return { ok: true, platform: "xiaohongshu", noteId, resolvedUrl: parsed.href };
  }
  if (host === "weibo.com" || host.endsWith(".weibo.com")) {
    if (!/^\/\d+\/[0-9A-Za-z]+\/?$/.test(parsed.pathname)) throw new Error("这不是微博帖文地址。");
    return { ok: true, platform: "weibo", noteId: weiboNoteIdFromPathname(parsed.pathname), resolvedUrl: parsed.href };
  }
  throw new Error("只支持小红书或微博帖文链接。");
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
    // 任务列表显示用的帖文标题：显式提供者优先，其次沿用本页已有标题，
    // 都没有时退回页签标题（仅供展示，不参与任何匹配）。
    // 注意 patch 里可能带 noteTitle: null，不能用展开后的 next 判断“沿用”。
    const inheritedTitle = samePage ? previous?.noteTitle : undefined;
    const explicitTitle = cleanText(patch.noteTitle);
    const fallbackTitle = cleanText(patch.noteTitleFallback);
    const resolvedTitle = explicitTitle || cleanText(inheritedTitle) || fallbackTitle;
    if (resolvedTitle) next.noteTitle = resolvedTitle;
    else delete next.noteTitle;
    delete next.noteTitleFallback;
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

// 侧边栏打开时拉取全部页签的工作流状态，恢复任务列表与各页签的结果
async function listWorkflowStates() {
  const stored = await chrome.storage.session.get(WORKFLOW_STATES_KEY);
  return { ok: true, workflows: Object.values(stored[WORKFLOW_STATES_KEY] || {}) };
}

// 页签关闭后状态立即作废：任务列表不能留一个永远转圈的死条目
chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  const operation = workflowStateWrite.then(async () => {
    const stored = await chrome.storage.session.get(WORKFLOW_STATES_KEY);
    const states = stored[WORKFLOW_STATES_KEY] || {};
    if (!(workflowKey(tabId) in states)) return;
    delete states[workflowKey(tabId)];
    await chrome.storage.session.set({ [WORKFLOW_STATES_KEY]: states });
  });
  workflowStateWrite = operation.catch(() => {});
});

async function recordCaptureProgress(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error("无法识别正在采集的标签页。");
  const count = Math.max(0, Number(message.count) || 0);
  return updateWorkflowState(tabId, message.pageSessionId, {
    pageUrl: message.pageUrl || sender.url,
    noteId: message.noteId || null,
    noteTitle: message.noteTitle || null,
    noteTitleFallback: sender?.tab?.title || null,
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
    noteTitle: message.noteTitle || null,
    noteTitleFallback: sender?.tab?.title || null,
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
    noteTitle: message.noteTitle || null,
    noteTitleFallback: sender?.tab?.title || null,
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
    textApiKey: saved.textApiKey || "",
    visionApiKey: saved.visionApiKey || "",
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

// 面板只询问“是否已配置可用”，不把 Webhook/App Secret 回传给侧边栏。
async function getFeishuStatus() {
  const [config, secrets] = await Promise.all([getStoredConfig(), getStoredSecrets()]);
  let configured = false;
  try {
    configured = validateFeishuSettings(config, secrets);
  } catch {
    configured = false;
  }
  return { ok: true, configured };
}

// 手动发送结果框里的文本：保留换行，避免 cleanText 把编辑后的格式压平。
async function sendManualFeishu(message) {
  const text = String(message?.text ?? "").replace(/\u0000/g, "").trim();
  if (!text) throw new Error("没有可发送的内容。");
  if (text.length > 20000) throw new Error("内容过长，飞书消息最多 20000 字。");
  const [config, secrets] = await Promise.all([getStoredConfig(), getStoredSecrets()]);
  if (!validateFeishuSettings(config, secrets)) {
    throw new Error("尚未配置飞书推送，请先在设置中填写。");
  }
  const delivered = await sendFeishuMessage(text, config, secrets);
  return { ok: true, channel: delivered.channel };
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
  const historyId = newHistoryId();
  const storedResult = {
    ...publicResult,
    // 程序最后一次渲染的干净文本；结果框里的编辑不写回历史，补链接时靠它判断是否被改过
    renderedText: publicResult.text,
    notification,
    historyId,
    noteId: payload.source?.noteId || null,
    createdAt: Date.now()
  };
  const boundedCache = Object.fromEntries(Object.entries(updatedCache).slice(-MAX_CACHE_ENTRIES));
  await chrome.storage.session.set({ [CACHE_KEY]: boundedCache });
  // 历史写入失败不应影响已完成的概括与推送
  await recordHistory(payload, storedResult, historyId).catch(() => {});
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
    noteTitle: payload?.note?.title || null,
    noteTitleFallback: sender?.tab?.title || null,
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
  const givenUrl = cleanText(payload.source?.givenUrl);
  const link = givenUrl || cleanText(payload.source?.url) || null;
  const isScreenshot = payload.source?.origin === "user_screenshot";
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
    // 清单条目当前生效的链接（givenUrl 优先）与校验状态：截图不设校验状态
    link,
    linkVerified: givenUrl ? (isScreenshot ? null : payload.source?.givenUrlVerified === true) : null,
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

// —— 概括历史：只存概括全文与精简元信息，不存评论、图片识别等完整证据 ——
async function getHistoryEntries() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  return stored[HISTORY_KEY] || [];
}

async function appendHistoryEntry(entry) {
  const entries = await getHistoryEntries();
  // 固定条数上限：超出后淘汰最旧的记录
  const bounded = [...entries, entry].slice(-MAX_HISTORY_ENTRIES);
  await chrome.storage.local.set({ [HISTORY_KEY]: bounded });
  return bounded;
}

function newHistoryId() {
  return `hist-${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(16).slice(2)}`;
}

async function recordHistory(payload, publicResult, historyId = null) {
  const entry = {
    id: historyId || newHistoryId(),
    kind: payload?.source?.origin === "user_screenshot" ? "screenshot" : "single",
    platform: payload?.source?.platform === "weibo" ? "weibo" : "xiaohongshu",
    title: cleanText(payload?.note?.title) || "（无标题帖文）",
    author: cleanText(payload?.note?.author) || null,
    // 链接概括流沿用用户提供的链接（短链）；其余场景仍是页面地址
    url: cleanText(payload?.source?.givenUrl) || cleanText(payload?.source?.url) || null,
    result: publicResult,
    createdAt: publicResult.createdAt || Date.now()
  };
  await appendHistoryEntry(entry);
  return entry;
}

async function recordMergedHistory(payloads, publicResult, historyId = null) {
  const entry = {
    id: historyId || newHistoryId(),
    kind: "merge",
    platform: null,
    title: `合并 ${payloads.length} 条帖文`,
    author: null,
    url: null,
    result: publicResult,
    createdAt: publicResult.createdAt || Date.now()
  };
  await appendHistoryEntry(entry);
  return entry;
}

// 换链接不新增历史，只同步已有条目的链接与全文；historyId 缺失或已被淘汰时静默跳过。
async function updateHistoryEntry(historyId, { url, text } = {}) {
  const id = cleanText(historyId);
  if (!id) return null;
  const entries = await getHistoryEntries();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return null;
  const entry = entries[index];
  const nextResult = {
    ...entry.result,
    ...(text !== undefined ? { text } : {})
  };
  // 历史里只有程序渲染的干净文本；relink 传入的 text 就是重渲染结果
  if (text !== undefined && typeof entry.result?.renderedText === "string") {
    nextResult.renderedText = text;
  }
  const next = {
    ...entry,
    ...(url !== undefined ? { url } : {}),
    result: nextResult
  };
  entries[index] = next;
  await chrome.storage.local.set({ [HISTORY_KEY]: entries });
  return next;
}

async function listHistory() {
  // 新记录排在前，面板按此顺序直接渲染
  const entries = await getHistoryEntries();
  return { ok: true, items: entries.slice().reverse() };
}

async function removeHistoryEntry(message) {
  const id = cleanText(message?.id);
  if (!id) throw new Error("缺少要删除的历史条目。");
  const entries = (await getHistoryEntries()).filter((entry) => entry.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: entries });
  return { ok: true };
}

async function clearHistory() {
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  return { ok: true };
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
  const visionApiKey = secrets.visionApiKey;
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
  const historyId = newHistoryId();
  const mergeResult = {
    ...publicResult,
    renderedText: publicResult.text,
    notification,
    historyId,
    merged: true,
    postCount: payloads.length,
    // 生成时的清单条目顺序，换链接后只有集合未变才允许原地重渲染
    itemIds: items.map((item) => item.id),
    createdAt: Date.now()
  };
  const boundedCache = Object.fromEntries(Object.entries(updatedCache).slice(-MAX_CACHE_ENTRIES));
  await chrome.storage.session.set({ [CACHE_KEY]: boundedCache });
  // 历史写入失败不应影响已完成的概括与推送
  await recordMergedHistory(payloads, mergeResult, historyId).catch(() => {});
  return { ok: true, result: mergeResult };
}

// —— 补链接：只改 source.givenUrl 并用已有 structured 重新渲染，不调用任何模型 ——

function validateGivenLink(value) {
  const text = cleanText(value);
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("链接不是有效网址。");
  }
  if (parsed.protocol !== "https:") throw new Error("链接必须使用 HTTPS。");
  return parsed.href;
}

function payloadWithGivenUrl(payload, rawGivenUrl, verified) {
  if (!payload?.source) throw new Error("缺少要更新链接的采集数据。");
  const givenUrl = cleanText(rawGivenUrl);
  const source = { ...payload.source };
  if (!givenUrl) {
    delete source.givenUrl;
    delete source.givenUrlVerified;
  } else if (source.origin === "user_screenshot") {
    // 截图帖文只校验网址合法，不设 givenUrlVerified
    source.givenUrl = validateScreenshotSourceUrl(givenUrl);
    delete source.givenUrlVerified;
  } else {
    source.givenUrl = validateGivenLink(givenUrl);
    source.givenUrlVerified = Boolean(verified);
  }
  return { ...payload, source };
}

const RELINK_UPDATED_HINT = "链接已更新（未重新推送飞书）。";
const RELINK_KEPT_HINT = "链接已记录，但概括正文编辑过，未能自动替换，请手动修改。";

function relinkHint(linkApplied) {
  return linkApplied === "kept" ? RELINK_KEPT_HINT : RELINK_UPDATED_HINT;
}

// 结果当前生效的来源链接：用户提供的链接优先于落地页地址。
function payloadSourceLink(payload) {
  return cleanText(payload?.source?.givenUrl) || cleanText(payload?.source?.url);
}

// 只替换最后一处，避免正文里偶然出现同一个词时被连带改掉。
function replaceLastOccurrence(text, search, replacement) {
  const source = String(text ?? "");
  const needle = String(search ?? "");
  if (!needle) return source;
  const index = source.lastIndexOf(needle);
  if (index < 0) return source;
  return source.slice(0, index) + String(replacement ?? "") + source.slice(index + needle.length);
}

// 旧结果没有 renderedText 时视为没编辑过；编辑过才只做局部替换，避免整段覆盖。
function isResultEdited(result) {
  return typeof result?.renderedText === "string" && String(result.text ?? "") !== result.renderedText;
}

function applyLinkText(result, { oldSuffix, newSuffix, oldLink, newLink, renderedText }) {
  const text = String(result?.text ?? "");
  if (!isResultEdited(result)) {
    return { text: renderedText, renderedText, linkApplied: "rerendered" };
  }
  if (oldSuffix && text.includes(oldSuffix)) {
    return {
      text: replaceLastOccurrence(text, oldSuffix, newSuffix || ""),
      renderedText,
      linkApplied: "replaced"
    };
  }
  if (oldLink && text.includes(oldLink)) {
    return {
      text: replaceLastOccurrence(text, oldLink, newLink || ""),
      renderedText,
      linkApplied: "replaced"
    };
  }
  return { text, renderedText, linkApplied: "kept" };
}

async function relinkResult(message) {
  const payload = message?.payload;
  const result = message?.result;
  if (!payload?.source || !result) throw new Error("缺少要更新链接的结果。");
  if (!result.structured) throw new Error("这条结果缺少结构化概括，无法在不调用模型的情况下更新链接。");

  const nextPayload = payloadWithGivenUrl(payload, message.givenUrl, message.verified);
  const renderedText = XhsAi.renderSummary(result.structured, nextPayload);
  const applied = applyLinkText(result, {
    oldSuffix: XhsAi.renderSourceSuffix(payload),
    newSuffix: XhsAi.renderSourceSuffix(nextPayload),
    oldLink: payloadSourceLink(payload),
    newLink: payloadSourceLink(nextPayload),
    renderedText
  });
  const nextResult = { ...result, text: applied.text, renderedText: applied.renderedText };
  const historyUrl = cleanText(nextPayload.source.givenUrl) || cleanText(nextPayload.source.url) || null;
  // 历史保留程序重渲染出的干净文本，不写入结果框里的手工编辑
  await updateHistoryEntry(result.historyId, { url: historyUrl, text: applied.renderedText });

  const tabId = Number(message.tabId);
  const pageSessionId = cleanText(message.pageSessionId);
  if (Number.isInteger(tabId) && pageSessionId) {
    // 页签任务进行中（或页面会话已变）时不能用换链接结果覆盖工作流：
    // 面板会把链接暂存到 pendingGivenUrl，等任务完成后再统一补上。
    const stored = await chrome.storage.session.get(WORKFLOW_STATES_KEY);
    const currentWorkflow = stored[WORKFLOW_STATES_KEY]?.[workflowKey(tabId)] || null;
    const sameSession = currentWorkflow?.pageSessionId === pageSessionId;
    if (currentWorkflow && sameSession && currentWorkflow.status !== "working") {
      // 同步该页签的工作流快照，面板重开时不会又显示旧链接
      await updateWorkflowState(tabId, pageSessionId, {
        pageUrl: cleanText(nextPayload.source.url) || message.pageUrl || "",
        noteId: nextPayload.source.noteId || null,
        status: "done",
        capture: nextPayload,
        result: nextResult,
        error: null,
        progress: {
          state: "done",
          title: "链接已更新",
          detail: relinkHint(applied.linkApplied),
          percent: 100
        }
      }).catch(() => {});
    }
  }
  return { ok: true, payload: nextPayload, result: nextResult, linkApplied: applied.linkApplied };
}

async function setMergeItemLink(message) {
  const id = cleanText(message?.id);
  if (!id) throw new Error("缺少要更新链接的清单条目。");
  const items = await getMergeBasket();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("该条目已不在清单中。");
  const previousPayload = items[index].payload;
  // 合并结果的来源后缀由整组条目渲染；把改动前后的后缀一起交给 rerender，
  // 编辑过的合并正文才能只替换后缀、保住其余文字。
  const previousSuffix = XhsAi.renderMergedSourceSuffix(
    XhsAi.sortPayloadsChronologically(items.map((item) => item.payload))
  );
  const nextPayload = payloadWithGivenUrl(previousPayload, message.givenUrl, message.verified);
  items[index] = { ...items[index], payload: nextPayload };
  await chrome.storage.session.set({ [MERGE_BASKET_KEY]: items });
  const nextSuffix = XhsAi.renderMergedSourceSuffix(
    XhsAi.sortPayloadsChronologically(items.map((item) => item.payload))
  );
  return {
    ok: true,
    basket: items.map(basketItemSummary),
    linkChange: {
      id,
      previousSuffix,
      nextSuffix,
      previousLink: payloadSourceLink(previousPayload),
      nextLink: payloadSourceLink(nextPayload)
    }
  };
}

async function rerenderMergeResult(message) {
  const result = message?.result;
  if (!result?.structured || !Array.isArray(result.itemIds)) return { ok: true, unchanged: true };
  const items = await getMergeBasket();
  const currentIds = items.map((item) => item.id).sort();
  const recordedIds = result.itemIds.slice().sort();
  const sameItems = currentIds.length === recordedIds.length &&
    currentIds.every((id, index) => id === recordedIds[index]);
  if (!sameItems) return { ok: true, unchanged: true };

  const ordered = XhsAi.sortPayloadsChronologically(items.map((item) => item.payload));
  const renderedText = XhsAi.renderMergedSummary(result.structured, ordered);
  const linkChange = message?.linkChange || null;
  const applied = applyLinkText(result, {
    oldSuffix: cleanText(linkChange?.previousSuffix) || null,
    newSuffix: XhsAi.renderMergedSourceSuffix(ordered),
    oldLink: cleanText(linkChange?.previousLink) || "",
    newLink: cleanText(linkChange?.nextLink) || "",
    renderedText
  });
  const nextResult = { ...result, text: applied.text, renderedText: applied.renderedText };
  await updateHistoryEntry(result.historyId, { text: applied.renderedText });
  return { ok: true, result: nextResult, linkApplied: applied.linkApplied };
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
    case "XHS_AI_GET_FEISHU_STATUS":
      task = getFeishuStatus();
      break;
    case "XHS_AI_SEND_FEISHU":
      task = sendManualFeishu(message);
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
    case "XHS_AI_HISTORY_LIST":
      task = listHistory();
      break;
    case "XHS_AI_HISTORY_REMOVE":
      task = removeHistoryEntry(message);
      break;
    case "XHS_AI_HISTORY_CLEAR":
      task = clearHistory();
      break;
    case "XHS_AI_RESOLVE_LINK":
      task = resolveLink(message.url);
      break;
    case "XHS_AI_RELINK":
      task = relinkResult(message);
      break;
    case "XHS_AI_MERGE_SET_LINK":
      task = setMergeItemLink(message);
      break;
    case "XHS_AI_MERGE_RERENDER":
      task = rerenderMergeResult(message);
      break;
    case "XHS_AI_GET_WORKFLOW":
      task = getWorkflowForPanel(message);
      break;
    case "XHS_AI_LIST_WORKFLOWS":
      task = listWorkflowStates();
      break;
    default:
      return undefined;
  }

  Promise.resolve(task)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || "操作失败" }));
  return true;
});
