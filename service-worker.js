importScripts("prompts.js", "ai-pipeline.js");

const CONFIG_KEY = "xhsAiConfig";
const SECRETS_KEY = "xhsAiSecrets";
const PERSISTENT_SECRETS_KEY = "xhsAiPersistentSecrets";
const CACHE_KEY = "xhsAiCacheV1";
const LAST_CAPTURE_KEY = "xhsAiLastCapture";
const LAST_RESULT_KEY = "xhsAiLastResult";
const WORKFLOW_STATES_KEY = "xhsAiWorkflowStatesV1";
const MAX_CACHE_ENTRIES = 16;
const MAX_WORKFLOW_STATES = 12;
const EXTENSION_PAGE_MESSAGES = new Set([
  "XHS_AI_GET_CONFIG",
  "XHS_AI_SAVE_CONFIG",
  "XHS_AI_CLEAR_KEYS",
  "XHS_AI_TEST_PROVIDER",
  "XHS_AI_SUMMARIZE",
  "XHS_AI_GET_WORKFLOW",
  "XHS_AI_GET_LAST",
  "XHS_AI_DOWNLOAD_LAST"
]);
const CONTENT_SCRIPT_MESSAGES = new Set([
  "XHS_EXPORT_PROGRESS",
  "XHS_AI_SUMMARIZE_PAGE",
  "XHS_AI_WORKFLOW_FAILED"
]);

let workflowStateWrite = Promise.resolve();

const storageAccessReady = typeof chrome.storage.local.setAccessLevel === "function"
  ? chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  : Promise.resolve();

function cleanText(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function isXhsPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith("xiaohongshu.com") && /\/explore\/[0-9a-f]{24}/i.test(url.pathname);
  } catch {
    return false;
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

function sanitizeFilename(value, fallback = "untitled") {
  const sanitized = cleanText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 64);
  return sanitized || fallback;
}

function dataUrl(content, mimeType) {
  return `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function flattenComments(commentExport) {
  const rows = [];
  for (const comment of commentExport.comments || []) {
    rows.push(comment);
    rows.push(...(comment.visibleReplies || []));
  }
  return rows;
}

function commentsToCsv(payload) {
  const headers = [
    "kind",
    "id",
    "parent_comment_id",
    "author",
    "user_id",
    "content",
    "published_display",
    "location",
    "likes_raw",
    "likes_value",
    "displayed_reply_count",
    "is_author",
    "is_pinned"
  ];
  const rows = flattenComments(payload.commentExport).map((comment) => [
    comment.kind,
    comment.id,
    comment.parentCommentId,
    comment.author,
    comment.userId,
    comment.content,
    comment.publishedDisplay,
    comment.location,
    comment.likes?.raw,
    comment.likes?.value,
    comment.displayedReplyCount,
    comment.isAuthor,
    comment.isPinned
  ]);

  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function payloadToMarkdown(payload) {
  const { note, interactions, commentExport, media, source } = payload;
  const lines = [
    `# ${note.title || "无标题帖文"}`,
    "",
    `- 作者：${note.author || "未知"}`,
    `- 页面日期：${note.publishedDisplay || "未显示"}`,
    `- 地点：${note.location || "未显示"}`,
    `- 点赞：${interactions.likes.raw || "未显示"}`,
    `- 收藏：${interactions.collects.raw || "未显示"}`,
    `- 评论：${interactions.comments.raw || "未显示"}`,
    `- 原始链接：${source.url}`,
    "",
    "## 正文",
    "",
    note.content || "（无正文）",
    "",
    "## 评论摘录",
    "",
    `> 当前页面顺序前 ${commentExport.extractedTopLevelCount} 条一级评论；不是完整评论导出。`,
    ""
  ];

  commentExport.comments.forEach((comment, index) => {
    lines.push(`### ${index + 1}. ${comment.author || "匿名用户"}`);
    lines.push("");
    lines.push(comment.content || "（无文字内容）");
    lines.push("");
    lines.push(`_${[comment.publishedDisplay, comment.location, comment.likes?.raw ? `赞 ${comment.likes.raw}` : null].filter(Boolean).join(" · ")}_`);
    lines.push("");

    for (const reply of comment.visibleReplies || []) {
      lines.push(`- **回复 · ${reply.author || "匿名用户"}：** ${reply.content || "（无文字内容）"}`);
    }
    if ((comment.visibleReplies || []).length) lines.push("");
  });

  if (media.images.length) {
    lines.push("## 图片");
    lines.push("");
    media.images.forEach((_, index) => lines.push(`- images/${String(index + 1).padStart(3, "0")}.webp`));
    lines.push("");
  }

  lines.push("---");
  lines.push(`导出时间：${payload.exportedAt}`);
  return lines.join("\n");
}

async function startDownload(url, filename) {
  return chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
}

async function downloadExport(payload, options) {
  const noteId = sanitizeFilename(payload.source.noteId, "note");
  const title = sanitizeFilename(payload.note.title, "untitled");
  const folder = `xiaohongshu-export/${title}_${noteId}`;
  const jobs = [
    startDownload(
      dataUrl(JSON.stringify(payload, null, 2), "application/json"),
      `${folder}/note.json`
    ),
    startDownload(
      dataUrl(payloadToMarkdown(payload), "text/markdown"),
      `${folder}/note.md`
    ),
    startDownload(
      dataUrl(commentsToCsv(payload), "text/csv"),
      `${folder}/comments.csv`
    )
  ];

  let imageCount = 0;
  if (options?.downloadImages !== false) {
    payload.media.images.forEach((image, index) => {
      imageCount += 1;
      const filename = `${folder}/images/${String(index + 1).padStart(3, "0")}.webp`;
      jobs.push(startDownload(image.url, filename));
    });
  }

  const results = await Promise.allSettled(jobs);
  const metadataFailures = results.slice(0, 3).filter((result) => result.status === "rejected");
  const imageFailures = results.slice(3).filter((result) => result.status === "rejected");
  if (metadataFailures.length) {
    throw new Error("浏览器未能完整保存数据文件，请检查下载权限后重试。");
  }

  return {
    ok: true,
    imageCount: imageCount - imageFailures.length,
    failedDownloadCount: imageFailures.length
  };
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
  const saved = sessionSecrets.textApiKey || sessionSecrets.visionApiKey || sessionSecrets.deepseekApiKey || sessionSecrets.qwenApiKey
    ? sessionSecrets
    : persistentSecrets;
  return {
    textApiKey: saved.textApiKey || saved.deepseekApiKey || "",
    visionApiKey: saved.visionApiKey || saved.qwenApiKey || ""
  };
}

async function saveAiSettings(config, secrets) {
  await storageAccessReady;
  const normalized = XhsAi.validateConfig(XhsAi.normalizeConfig(config));
  const safeSecrets = {
    textApiKey: String(secrets?.textApiKey || "").trim(),
    visionApiKey: String(secrets?.visionApiKey || "").trim()
  };
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

function emitAiProgress(progress) {
  chrome.runtime.sendMessage({
    type: "XHS_AI_PROGRESS",
    title: progress.stage === "vision" ? "正在识别图片" : progress.stage === "text" ? "正在撰写概括" : "概括完成",
    ...progress
  }).catch(() => {});
}

async function summarizePayload(payload, force, progressListener = emitAiProgress) {
  if (!payload?.source?.noteId || !payload?.commentExport || !payload?.media) {
    throw new Error("页面采集数据不完整，请重新打开帖文后再试。");
  }
  const [config, secrets, cacheRecord] = await Promise.all([
    getStoredConfig(),
    getStoredSecrets(),
    chrome.storage.session.get(CACHE_KEY)
  ]);
  const cache = cacheRecord[CACHE_KEY] || {};
  await chrome.storage.session.set({ [LAST_CAPTURE_KEY]: payload });
  const result = await XhsAi.summarize(payload, config, secrets, cache, progressListener, Boolean(force));
  const { cache: updatedCache, ...publicResult } = result;
  const storedResult = {
    ...publicResult,
    noteId: payload.source?.noteId || null,
    createdAt: Date.now()
  };
  const boundedCache = Object.fromEntries(Object.entries(updatedCache).slice(-MAX_CACHE_ENTRIES));
  await chrome.storage.session.set({
    [CACHE_KEY]: boundedCache,
    [LAST_RESULT_KEY]: storedResult
  });
  return { ok: true, result: storedResult };
}

async function summarizePagePayload(message, sender) {
  const tabId = sender?.tab?.id;
  const payload = message.payload;
  const pageSessionId = cleanText(message.pageSessionId || payload?.source?.pageSessionId);
  const pageUrl = cleanText(payload?.source?.url || sender?.url);
  if (!Number.isInteger(tabId) || !pageSessionId || !isXhsPageUrl(pageUrl)) {
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
      detail: `已读取 ${payload?.commentExport?.extractedTopLevelCount || 0} 条一级评论和 ${payload?.media?.images?.length || 0} 张图片`,
      percent: 30
    }
  });

  const onProgress = (progress) => {
    const title = progress.stage === "vision"
      ? "正在识别图片"
      : progress.stage === "text"
        ? "正在撰写概括"
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
    const response = await summarizePayload(payload, message.force, onProgress);
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
        detail: message.force ? "新版本已替换原概括。" : "已按固定格式生成，可直接复制。",
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

async function getWorkflowForPopup(message) {
  const workflow = await getWorkflowState(message.tabId, message.pageSessionId, message.pageUrl);
  return { ok: true, workflow };
}

async function getLastSessionData() {
  const stored = await chrome.storage.session.get([LAST_CAPTURE_KEY, LAST_RESULT_KEY]);
  return {
    ok: true,
    capture: stored[LAST_CAPTURE_KEY] || null,
    result: stored[LAST_RESULT_KEY] || null
  };
}

async function downloadLastCapture(options, identity = {}) {
  const [stored, workflow] = await Promise.all([
    chrome.storage.session.get(LAST_CAPTURE_KEY),
    getWorkflowState(identity.tabId, identity.pageSessionId, identity.pageUrl)
  ]);
  const payload = workflow?.capture || stored[LAST_CAPTURE_KEY];
  if (!payload) throw new Error("当前会话中没有可下载的原始数据，请先提取一次。");
  return downloadExport(payload, options);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (EXTENSION_PAGE_MESSAGES.has(message?.type)) {
    const extensionRoot = chrome.runtime.getURL("");
    if (!String(sender?.url || "").startsWith(extensionRoot)) {
      sendResponse({ ok: false, error: "该操作只能从插件界面发起。" });
      return false;
    }
  }
  if (CONTENT_SCRIPT_MESSAGES.has(message?.type) && (!isXhsPageUrl(sender?.url) || !Number.isInteger(sender?.tab?.id))) {
    sendResponse({ ok: false, error: "该操作只能从小红书帖文页面发起。" });
    return false;
  }
  let task;
  switch (message?.type) {
    case "XHS_EXPORT_PROGRESS":
      task = recordCaptureProgress(message, sender).then(() => ({ ok: true }));
      break;
    case "XHS_EXPORT_DOWNLOAD":
      task = downloadExport(message.payload, message.options);
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
    case "XHS_AI_SUMMARIZE":
      task = summarizePayload(message.payload, message.force);
      break;
    case "XHS_AI_SUMMARIZE_PAGE":
      task = summarizePagePayload(message, sender);
      break;
    case "XHS_AI_WORKFLOW_FAILED":
      task = recordWorkflowFailure(message, sender).then(() => ({ ok: true }));
      break;
    case "XHS_AI_GET_WORKFLOW":
      task = getWorkflowForPopup(message);
      break;
    case "XHS_AI_GET_LAST":
      task = getLastSessionData();
      break;
    case "XHS_AI_DOWNLOAD_LAST":
      task = downloadLastCapture(message.options, message);
      break;
    default:
      return undefined;
  }

  Promise.resolve(task)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || "操作失败" }));
  return true;
});
