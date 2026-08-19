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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "XHS_EXPORT_DOWNLOAD") return undefined;

  downloadExport(message.payload, message.options)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || "下载失败" }));

  return true;
});
