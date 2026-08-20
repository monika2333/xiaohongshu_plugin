(() => {
  if (globalThis.__XHS_NOTE_EXPORTER_INSTALLED__) return;
  globalThis.__XHS_NOTE_EXPORTER_INSTALLED__ = true;
  const PAGE_SESSION_ID = globalThis.__XHS_NOTE_EXPORTER_PAGE_SESSION_ID__ ||
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  globalThis.__XHS_NOTE_EXPORTER_PAGE_SESSION_ID__ = PAGE_SESSION_ID;

  const DEFAULT_LIMIT = 50;
  const MAX_SCROLL_ROUNDS = 80;
  const SCROLL_WAIT_MS = 650;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function textOf(root, selector) {
    return cleanText(root?.querySelector(selector)?.innerText || root?.querySelector(selector)?.textContent);
  }

  function normalizeCount(raw) {
    const value = cleanText(raw).replace(/,/g, "");
    if (!value || value === "赞" || value === "回复") return null;

    const match = value.match(/([\d.]+)\s*(万|千)?/);
    if (!match) return null;
    const number = Number.parseFloat(match[1]);
    if (!Number.isFinite(number)) return null;
    if (match[2] === "万") return Math.round(number * 10000);
    if (match[2] === "千") return Math.round(number * 1000);
    return Math.round(number);
  }

  function getNoteId() {
    return location.pathname.match(/\/explore\/([0-9a-f]{24})/i)?.[1] || null;
  }

  function getDetailRoot() {
    const roots = [
      document.querySelector(".note-detail-mask"),
      document.querySelector(".note-detail"),
      document.querySelector("[class*='note-detail']"),
      document.querySelector("#noteContainer"),
      document.querySelector(".note-container")
    ].filter(Boolean);

    return roots.find((root) => root.querySelector("#detail-title, #detail-desc, .comments-container")) || null;
  }

  function inferPublishedAt(noteId) {
    if (!/^[0-9a-f]{24}$/i.test(noteId || "")) return null;
    const milliseconds = Number.parseInt(noteId.slice(0, 8), 16) * 1000;
    const date = new Date(milliseconds);
    const lowerBound = Date.UTC(2013, 0, 1);
    const upperBound = Date.now() + 24 * 60 * 60 * 1000;
    return milliseconds >= lowerBound && milliseconds <= upperBound ? date.toISOString() : null;
  }

  function splitPublishedAndLocation(raw) {
    const text = cleanText(raw);
    const match = text.match(/^(.*?)(?:\s+)([^\s]+)$/);
    if (!match) return { publishedDisplay: text || null, location: null };
    return { publishedDisplay: cleanText(match[1]) || null, location: cleanText(match[2]) || null };
  }

  function getInteraction(root, selector) {
    const countSelector = selector
      .split(",")
      .map((item) => `${item.trim()} .count`)
      .join(", ");
    const raw = textOf(root, countSelector);
    return { raw: raw || null, value: normalizeCount(raw) };
  }

  function canonicalMediaKey(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.hostname}${parsed.pathname}`.replace(/^sns-webpic-[^/]+\//, "sns-webpic/");
    } catch {
      return url;
    }
  }

  function collectMedia(root) {
    const candidates = Array.from(root.querySelectorAll(
      ".img-container img, .note-slider-img img, [class*='slider'] img"
    ));
    const seen = new Set();
    const images = [];

    for (const img of candidates) {
      const url = img.currentSrc || img.src;
      if (!url || !/xhscdn\.com/i.test(url) || /avatar/i.test(url)) continue;
      const key = canonicalMediaKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({
        url: url.replace(/^http:/, "https:"),
        width: img.naturalWidth || null,
        height: img.naturalHeight || null,
        source: "detail_media_dom"
      });
    }

    return images;
  }

  function buildVisionSeed(root) {
    const noteId = getNoteId();
    if (!noteId) throw new Error("无法识别当前帖文 ID。");
    return {
      source: {
        platform: "xiaohongshu",
        url: location.href,
        noteId,
        pageSessionId: PAGE_SESSION_ID
      },
      media: {
        images: collectMedia(root),
        note: "页面当前可访问的图片版本，不保证为创作者上传的未压缩原文件。"
      }
    };
  }

  function parseCommentItem(item, kind = "top_level", parentCommentId = null) {
    const id = item.id?.replace(/^comment-/, "") || null;
    const authorNode = item.querySelector(":scope > .comment-inner-container .author .name");
    const contentNode = item.querySelector(":scope > .comment-inner-container .content .note-text");
    const dateRoot = item.querySelector(":scope > .comment-inner-container .info .date");
    const locationNode = dateRoot?.querySelector(".location");
    const dateParts = dateRoot
      ? Array.from(dateRoot.children)
          .filter((node) => !node.classList.contains("location"))
          .map((node) => cleanText(node.textContent))
          .filter(Boolean)
      : [];
    const likeRaw = textOf(item, ":scope > .comment-inner-container .info .like .count");
    const replyRaw = textOf(item, ":scope > .comment-inner-container .info .reply .count");

    return {
      id,
      parentCommentId,
      kind,
      author: cleanText(authorNode?.textContent) || null,
      userId: authorNode?.dataset?.userId || null,
      content: cleanText(contentNode?.innerText || contentNode?.textContent) || null,
      publishedDisplay: dateParts.join(" ") || null,
      location: cleanText(locationNode?.textContent) || null,
      likes: { raw: likeRaw || null, value: normalizeCount(likeRaw) },
      displayedReplyCount: normalizeCount(replyRaw) || 0,
      isAuthor: Boolean(item.querySelector(":scope > .comment-inner-container .author .tag")),
      isPinned: Boolean(item.querySelector(":scope > .comment-inner-container .labels .top"))
    };
  }

  function collectTopLevelComments(root, limit, includeVisibleReplies) {
    const parents = Array.from(root.querySelectorAll(".parent-comment"));
    return parents.slice(0, limit).map((parent) => {
      const topItem = parent.querySelector(":scope > .comment-item");
      if (!topItem) return null;
      const parsed = parseCommentItem(topItem);
      parsed.visibleReplies = includeVisibleReplies
        ? Array.from(parent.querySelectorAll(".reply-container .comment-item-sub"))
            .map((reply) => parseCommentItem(reply, "visible_reply", parsed.id))
        : [];
      return parsed;
    }).filter(Boolean);
  }

  async function sendProgress(title, detail, count) {
    const status = {
      state: "working",
      title,
      detail,
      count,
      pageSessionId: PAGE_SESSION_ID,
      pageUrl: location.href,
      noteId: getNoteId(),
      updatedAt: Date.now()
    };
    await Promise.allSettled([
      chrome.runtime.sendMessage({ type: "XHS_EXPORT_PROGRESS", ...status }),
      chrome.storage.local.set({ xhsExporterStatus: status })
    ]);
  }

  async function loadTopLevelComments(root, limit) {
    const scroller = root.querySelector(".note-scroller");
    if (!scroller) return { loaded: 0, reason: "comment_scroller_missing" };

    const originalScrollTop = scroller.scrollTop;
    let stableRounds = 0;
    let lastCount = 0;
    let reason = "limit_reached";

    try {
      for (let round = 0; round < MAX_SCROLL_ROUNDS; round += 1) {
        const count = root.querySelectorAll(".parent-comment").length;
        await sendProgress("正在读取评论", `已加载 ${Math.min(count, limit)} 条一级评论`, Math.min(count, limit));

        if (count >= limit) break;

        stableRounds = count === lastCount ? stableRounds + 1 : 0;
        lastCount = count;

        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const nextScrollTop = Math.min(maxScrollTop, scroller.scrollTop + Math.max(320, scroller.clientHeight * 0.82));
        scroller.scrollTop = nextScrollTop;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await sleep(SCROLL_WAIT_MS + (stableRounds > 1 ? 450 : 0));

        const atBottom = maxScrollTop - scroller.scrollTop < 8;
        if (atBottom && stableRounds >= 4) {
          reason = "page_exhausted";
          break;
        }
      }

      const loaded = root.querySelectorAll(".parent-comment").length;
      if (loaded < limit && reason === "limit_reached") reason = "round_limit";
      return { loaded, reason };
    } finally {
      scroller.scrollTop = originalScrollTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  }

  function extractNote(root, options, loadingResult) {
    const noteId = getNoteId();
    if (!noteId) throw new Error("无法识别当前帖文 ID。");

    const dateLocation = splitPublishedAndLocation(
      textOf(root, ".bottom-container .date") || textOf(root, ".bottom-container")
    );
    const displayedCommentRaw = textOf(root, ".comments-container .total") ||
      textOf(root, ".chat-wrapper .count");
    const comments = collectTopLevelComments(root, options.limit, options.includeVisibleReplies);

    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      source: {
        platform: "xiaohongshu",
        url: location.href,
        noteId,
        pageSessionId: PAGE_SESSION_ID
      },
      note: {
        title: textOf(root, "#detail-title, .title") || document.title.replace(/\s*-\s*小红书\s*$/, ""),
        author: textOf(root, ".author-wrapper .username") || null,
        authorProfileUrl: root.querySelector(".author-wrapper a.name")?.href || null,
        content: textOf(root, "#detail-desc .note-text, #detail-desc, .desc .note-text") || null,
        hashtags: Array.from(root.querySelectorAll("#detail-desc a.tag, .desc a.tag"))
          .map((node) => cleanText(node.textContent))
          .filter(Boolean),
        publishedDisplay: dateLocation.publishedDisplay,
        location: dateLocation.location,
        publishedAtInferred: inferPublishedAt(noteId),
        publishedAtInferredSource: "note_id_prefix_heuristic_not_official"
      },
      interactions: {
        likes: getInteraction(root, ".interact-container .like-wrapper, .interactions .like-wrapper"),
        collects: getInteraction(root, ".interact-container .collect-wrapper, .interactions .collect-wrapper"),
        comments: getInteraction(root, ".interact-container .chat-wrapper, .interactions .chat-wrapper"),
        displayedCommentTotalRaw: displayedCommentRaw || null,
        displayedCommentTotal: normalizeCount(displayedCommentRaw)
      },
      commentExport: {
        scope: `first_${options.limit}_top_level_in_current_page_order`,
        requestedTopLevelCount: options.limit,
        extractedTopLevelCount: comments.length,
        includesOnlyAlreadyVisibleReplies: options.includeVisibleReplies,
        visibleReplyCount: comments.reduce((sum, item) => sum + item.visibleReplies.length, 0),
        isCompleteCommentExport: false,
        stopReason: loadingResult.reason,
        comments
      },
      media: {
        images: collectMedia(root),
        note: "页面当前可访问的图片版本，不保证为创作者上传的未压缩原文件。"
      }
    };
  }

  async function runCapture(rawOptions, onVisionSeed = null) {
    const options = {
      limit: Math.max(1, Math.min(50, Number(rawOptions?.limit) || DEFAULT_LIMIT)),
      downloadImages: rawOptions?.downloadImages !== false,
      includeVisibleReplies: rawOptions?.includeVisibleReplies !== false
    };

    const root = getDetailRoot();
    if (!root) {
      throw new Error("没有找到帖文详情。请确认详情弹窗已经完全打开。");
    }

    await sendProgress("正在读取帖文", "获取元信息、互动数和媒体资源", 0);
    if (typeof onVisionSeed === "function") onVisionSeed(buildVisionSeed(root));
    const loadingResult = await loadTopLevelComments(root, options.limit);
    await sendProgress("正在整理证据", "汇总正文、互动数据、图片和评论", Math.min(options.limit, loadingResult.loaded));

    const payload = extractNote(root, options, loadingResult);
    return {
      ok: true,
      payload,
      topLevelCount: payload.commentExport.extractedTopLevelCount,
      imageCount: payload.media.images.length
    };
  }

  async function runExtraction(rawOptions) {
    const captured = await runCapture(rawOptions);
    const payload = captured.payload;
    const downloadResponse = await chrome.runtime.sendMessage({
      type: "XHS_EXPORT_DOWNLOAD",
      payload,
      options: { downloadImages: options.downloadImages }
    });

    if (!downloadResponse?.ok) {
      throw new Error(downloadResponse?.error || "文件下载失败。");
    }

    const finalStatus = {
      state: "done",
      title: "摘录完成",
      detail: downloadResponse.failedDownloadCount
        ? `已保存 ${payload.commentExport.extractedTopLevelCount} 条一级评论、${downloadResponse.imageCount} 张图片；${downloadResponse.failedDownloadCount} 张图片下载失败。`
        : `已保存 ${payload.commentExport.extractedTopLevelCount} 条一级评论、${downloadResponse.imageCount} 张图片。`,
      count: payload.commentExport.extractedTopLevelCount,
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ xhsExporterStatus: finalStatus });

    return {
      ok: true,
      topLevelCount: payload.commentExport.extractedTopLevelCount,
      imageCount: downloadResponse.imageCount,
      failedDownloadCount: downloadResponse.failedDownloadCount
    };
  }

  async function runCaptureAndSummarize(rawOptions, suppliedPayload, force) {
    let payload = suppliedPayload || null;
    let visionPreparationPromise = null;
    if (payload) {
      await sendProgress("正在重新生成", "复用本页面已经采集的证据", payload.commentExport?.extractedTopLevelCount || 0);
    } else {
      payload = (await runCapture(rawOptions, (visionSeed) => {
        if (!visionSeed.media.images.length) return;
        visionPreparationPromise = chrome.runtime.sendMessage({
          type: "XHS_AI_PREPARE_VISION",
          payload: visionSeed,
          pageSessionId: PAGE_SESSION_ID
        }).catch(() => null);
      })).payload;
    }

    const visionPreparationResponse = visionPreparationPromise
      ? await visionPreparationPromise
      : null;

    const response = await chrome.runtime.sendMessage({
      type: "XHS_AI_SUMMARIZE_PAGE",
      payload,
      force: Boolean(force),
      pageSessionId: PAGE_SESSION_ID,
      preparedVision: visionPreparationResponse?.ok ? visionPreparationResponse.preparedVision : null
    });
    if (!response?.ok) throw new Error(response?.error || "概括未完成。");
    return { ok: true, result: response.result, capture: payload };
  }

  async function notifyWorkflowFailure(error) {
    const detail = error?.message || "未知错误";
    await chrome.runtime.sendMessage({
      type: "XHS_AI_WORKFLOW_FAILED",
      pageSessionId: PAGE_SESSION_ID,
      pageUrl: location.href,
      noteId: getNoteId(),
      error: detail
    }).catch(() => {});
    return detail;
  }

  let activeAiWorkflow = null;

  function startAiWorkflow(message) {
    if (activeAiWorkflow) return activeAiWorkflow;
    const operation = runCaptureAndSummarize(message.options, message.payload, message.force);
    const tracked = operation.finally(() => {
      if (activeAiWorkflow === tracked) activeAiWorkflow = null;
    });
    activeAiWorkflow = tracked;
    return tracked;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "XHS_PAGE_CONTEXT") {
      sendResponse({
        ok: true,
        pageSessionId: PAGE_SESSION_ID,
        pageUrl: location.href,
        noteId: getNoteId()
      });
      return false;
    }

    if (!message || !["XHS_CAPTURE_START", "XHS_EXPORT_START", "XHS_CAPTURE_AND_SUMMARIZE"].includes(message.type)) {
      return undefined;
    }

    const operation = message.type === "XHS_CAPTURE_START"
      ? runCapture(message.options)
      : message.type === "XHS_EXPORT_START"
        ? runExtraction(message.options)
        : startAiWorkflow(message);
    operation
      .then(sendResponse)
      .catch(async (error) => {
        if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") await notifyWorkflowFailure(error);
        const status = {
          state: "error",
          title: "摘录失败",
          detail: error?.message || "未知错误",
          count: 0,
          updatedAt: Date.now()
        };
        await chrome.storage.local.set({ xhsExporterStatus: status }).catch(() => {});
        sendResponse({ ok: false, error: status.detail });
      });

    return true;
  });
})();
