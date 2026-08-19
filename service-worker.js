importScripts("ai-pipeline.js");

const CONFIG_KEY = "xhsAiConfig";
const SECRETS_KEY = "xhsAiSecrets";
const CACHE_KEY = "xhsAiCacheV1";
const LAST_CAPTURE_KEY = "xhsAiLastCapture";
const LAST_RESULT_KEY = "xhsAiLastResult";
const MAX_CACHE_ENTRIES = 16;
const EXTENSION_PAGE_MESSAGES = new Set([
  "XHS_AI_GET_CONFIG",
  "XHS_AI_SAVE_CONFIG",
  "XHS_AI_TEST_PROVIDER",
  "XHS_AI_SUMMARIZE",
  "XHS_AI_GET_LAST",
  "XHS_AI_DOWNLOAD_LAST"
]);

function cleanText(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
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
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return XhsAi.normalizeConfig(stored[CONFIG_KEY]);
}

async function getStoredSecrets() {
  const stored = await chrome.storage.session.get(SECRETS_KEY);
  return stored[SECRETS_KEY] || { deepseekApiKey: "", qwenApiKey: "" };
}

async function saveAiSettings(config, secrets) {
  const normalized = XhsAi.validateConfig(XhsAi.normalizeConfig(config));
  const safeSecrets = {
    deepseekApiKey: String(secrets?.deepseekApiKey || "").trim(),
    qwenApiKey: String(secrets?.qwenApiKey || "").trim()
  };
  await Promise.all([
    chrome.storage.local.set({ [CONFIG_KEY]: normalized }),
    chrome.storage.session.set({ [SECRETS_KEY]: safeSecrets })
  ]);
  return { ok: true, config: normalized };
}

function emitAiProgress(progress) {
  chrome.runtime.sendMessage({
    type: "XHS_AI_PROGRESS",
    title: progress.stage === "vision" ? "正在识别图片" : progress.stage === "text" ? "正在撰写概括" : "概括完成",
    ...progress
  }).catch(() => {});
}

async function summarizePayload(payload, force) {
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
  const result = await XhsAi.summarize(payload, config, secrets, cache, emitAiProgress, Boolean(force));
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

async function getLastSessionData() {
  const stored = await chrome.storage.session.get([LAST_CAPTURE_KEY, LAST_RESULT_KEY]);
  return {
    ok: true,
    capture: stored[LAST_CAPTURE_KEY] || null,
    result: stored[LAST_RESULT_KEY] || null
  };
}

async function downloadLastCapture(options) {
  const stored = await chrome.storage.session.get(LAST_CAPTURE_KEY);
  const payload = stored[LAST_CAPTURE_KEY];
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
  let task;
  switch (message?.type) {
    case "XHS_EXPORT_DOWNLOAD":
      task = downloadExport(message.payload, message.options);
      break;
    case "XHS_AI_GET_CONFIG":
      task = Promise.all([getStoredConfig(), getStoredSecrets()]).then(([config, secrets]) => ({ ok: true, config, secrets }));
      break;
    case "XHS_AI_SAVE_CONFIG":
      task = saveAiSettings(message.config, message.secrets);
      break;
    case "XHS_AI_TEST_PROVIDER":
      task = XhsAi.testProvider(message.provider, message.config, message.secrets);
      break;
    case "XHS_AI_SUMMARIZE":
      task = summarizePayload(message.payload, message.force);
      break;
    case "XHS_AI_GET_LAST":
      task = getLastSessionData();
      break;
    case "XHS_AI_DOWNLOAD_LAST":
      task = downloadLastCapture(message.options);
      break;
    default:
      return undefined;
  }

  Promise.resolve(task)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || "操作失败" }));
  return true;
});
