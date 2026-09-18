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

  // 视频帖证据：自动字幕 + 按时长比例截帧。截帧位置避开片头片尾，长边压到 720px。
  const STATE_REQUEST_TIMEOUT_MS = 1500;
  const VIDEO_TRANSCRIPT_LIMIT = 6000;
  const VIDEO_FRAME_POSITIONS = [0.08, 0.24, 0.4, 0.56, 0.72, 0.88];
  const VIDEO_FRAME_MAX_EDGE = 720;
  const VIDEO_FRAME_QUALITY = 0.62;
  const VIDEO_LOAD_TIMEOUT_MS = 15000;
  const VIDEO_SEEK_TIMEOUT_MS = 6000;

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

  // ---- 视频帖：读取页面主世界的 __INITIAL_STATE__，拿到视频流与自动字幕地址 ----

  function requestNoteDetail(noteId) {
    if (!noteId || typeof window?.addEventListener !== "function") return Promise.resolve(null);
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;
      const finish = (note) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("XHS_AI_STATE_RESPONSE", onResponse);
        resolve(note || null);
      };
      const timer = setTimeout(() => finish(null), STATE_REQUEST_TIMEOUT_MS);
      const onResponse = (event) => {
        if (event?.detail?.requestId !== requestId) return;
        finish(event.detail?.note || null);
      };
      window.addEventListener("XHS_AI_STATE_RESPONSE", onResponse);
      try {
        window.dispatchEvent(new CustomEvent("XHS_AI_STATE_REQUEST", { detail: { requestId, noteId } }));
      } catch {
        finish(null);
      }
    });
  }

  // 桥接脚本缺失时（注入失败或旧版浏览器）退回解析 SSR 内联脚本。
  function parseInitialStateFromScript() {
    const scripts = Array.from(document.querySelectorAll("script:not([src])"));
    const marker = "window.__INITIAL_STATE__=";
    for (const script of scripts) {
      const text = script.textContent || "";
      const start = text.indexOf(marker);
      if (start < 0) continue;
      try {
        return JSON.parse(text.slice(start + marker.length));
      } catch {
        return null;
      }
    }
    return null;
  }

  async function requestNoteDetailWithFallback(noteId) {
    const bridged = await requestNoteDetail(noteId);
    if (bridged) return bridged;
    try {
      const state = parseInitialStateFromScript();
      const map = state?.note?.noteDetailMap || {};
      const entry = map[noteId] ||
        Object.values(map).find((item) => item?.note?.noteId === noteId) ||
        null;
      return entry?.note ? JSON.parse(JSON.stringify(entry.note)) : null;
    } catch {
      return null;
    }
  }

  function httpsMediaUrl(url) {
    const text = cleanText(url);
    return text ? text.replace(/^http:\/\//i, "https://") : null;
  }

  function pickStreamUrl(entry) {
    return httpsMediaUrl(
      entry?.masterUrl || entry?.master_url ||
      (Array.isArray(entry?.backupUrls) ? entry.backupUrls[0] : null) ||
      (Array.isArray(entry?.backup_urls) ? entry.backup_urls[0] : null)
    );
  }

  // 页面状态的数据形态会随登录态或版本变化（stream 的键名在 h264 与 EF4 等
  // 编码名之间切换，字幕可能整体缺失），因此先按已知路径读取，再用受限深扫兜底。
  function scanVideoSubtree(video) {
    const mp4Urls = [];
    const srtUrls = [];
    const visit = (value, path, depth) => {
      if (value == null || depth > 8) return;
      if (typeof value === "object") {
        for (const key of Object.keys(value)) visit(value[key], `${path}.${key}`, depth + 1);
        return;
      }
      if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return;
      if (/\.mp4(\?|$)/i.test(value)) mp4Urls.push({ url: value, path });
      else if (/\.srt(\?|$)/i.test(value)) srtUrls.push({ url: value, path });
    };
    visit(video, "video", 0);
    return { mp4Urls, srtUrls };
  }

  function buildVideoInfo(noteDetail) {
    if (!noteDetail || noteDetail.type !== "video") return null;
    const video = noteDetail.video || {};

    const streamMap = video.media?.stream || {};
    const knownEntries = [];
    for (const value of Object.values(streamMap)) {
      if (Array.isArray(value)) knownEntries.push(...value.filter((item) => item && typeof item === "object"));
    }
    const h264Entries = Array.isArray(streamMap.h264) ? streamMap.h264 : [];
    const preferredKnown =
      h264Entries.find((item) => item?.masterUrl || item?.master_url) ||
      h264Entries[0] ||
      knownEntries.find((item) => item?.masterUrl || item?.master_url) ||
      knownEntries[0] ||
      null;

    const { mp4Urls, srtUrls } = scanVideoSubtree(video);
    const streamUrl = pickStreamUrl(preferredKnown) ||
      httpsMediaUrl(mp4Urls.find((item) => !/backup/i.test(item.path))?.url || mp4Urls[0]?.url);
    const subtitleUrl = httpsMediaUrl(
      srtUrls.find((item) => /zh/i.test(item.path))?.url || srtUrls[0]?.url
    );
    if (!streamUrl && !subtitleUrl) return null;

    const durationSource = preferredKnown || null;
    const streamDurationMs = Number(durationSource?.duration) || null;
    const mediaV2Video = video.mediaV2?.video || {};
    const v2DurationSec = Number(mediaV2Video.duration) || null;
    return {
      streamUrl,
      subtitleUrl,
      // stream.duration 是毫秒，mediaV2.video.duration 是取整后的秒
      durationMs: streamDurationMs || (v2DurationSec ? v2DurationSec * 1000 : null),
      width: Number(durationSource?.width) || Number(mediaV2Video.width) || null,
      height: Number(durationSource?.height) || Number(mediaV2Video.height) || null
    };
  }

  function parseSrtTranscript(text) {
    const cues = [];
    for (const block of String(text || "").replace(/\r/g, "").split(/\n{2,}/)) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeIndex < 0) continue;
      const content = lines.slice(timeIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
      if (content && cues[cues.length - 1] !== content) cues.push(content);
    }
    return cues;
  }

  async function fetchVideoTranscript(subtitleUrl) {
    if (!subtitleUrl) return null;
    const response = await fetch(subtitleUrl, { credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const transcript = parseSrtTranscript(await response.text()).join(" ");
    return transcript ? transcript.slice(0, VIDEO_TRANSCRIPT_LIMIT) : null;
  }

  function drawVideoFrame(video) {
    const scale = Math.min(1, VIDEO_FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return {
      dataUrl: canvas.toDataURL("image/jpeg", VIDEO_FRAME_QUALITY),
      width: canvas.width,
      height: canvas.height
    };
  }

  function captureFrameAt(video, timeSec) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), VIDEO_SEEK_TIMEOUT_MS);
      const onSeeked = () => {
        try {
          const frame = drawVideoFrame(video);
          finish({ ...frame, timestampSec: Math.round(timeSec), source: "video_frame" });
        } catch {
          finish(null);
        }
      };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = Math.min(Math.max(timeSec, 0), Math.max(0, (video.duration || timeSec) - 0.1));
    });
  }

  // 用独立的隐藏 video 元素截帧，不干扰用户正在观看的播放器；
  // crossOrigin="anonymous" 保证画布可导出，加载失败时降级为当前播放器画面。
  async function captureVideoFrames(streamUrl, durationMs) {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    video.style.position = "fixed";
    video.style.left = "-9999px";
    video.style.top = "0";
    video.style.width = "2px";
    video.style.height = "2px";
    document.body.appendChild(video);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("加载超时")), VIDEO_LOAD_TIMEOUT_MS);
        video.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("视频流无法加载")); }, { once: true });
        video.src = streamUrl;
      });
      const duration = Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : (Number(durationMs) || 0) / 1000;
      if (!duration) return [];
      const frames = [];
      for (const fraction of VIDEO_FRAME_POSITIONS) {
        const frame = await captureFrameAt(video, duration * fraction);
        if (frame) frames.push(frame);
      }
      return frames;
    } finally {
      video.remove();
    }
  }

  function captureLivePlayerFrame(root) {
    const live = root.querySelector("video");
    if (!live || live.readyState < 2 || !live.videoWidth) return null;
    try {
      return {
        ...drawVideoFrame(live),
        timestampSec: Math.round(live.currentTime || 0),
        source: "video_frame"
      };
    } catch {
      return null;
    }
  }

  async function loadVideoEvidence(root, videoInfo, onDetail) {
    const evidence = {
      durationMs: videoInfo.durationMs || null,
      width: videoInfo.width || null,
      height: videoInfo.height || null,
      transcript: null,
      transcriptSource: null,
      frames: [],
      warnings: []
    };

    if (videoInfo.subtitleUrl) {
      evidence.transcriptSource = "auto_subtitle";
      try {
        evidence.transcript = await fetchVideoTranscript(videoInfo.subtitleUrl);
        onDetail?.(evidence.transcript ? "已读取视频自动字幕" : "该视频的自动字幕为空");
      } catch (error) {
        evidence.warnings.push(`视频自动字幕读取失败（${error?.message || "未知错误"}），口播内容缺失。`);
      }
    } else {
      evidence.warnings.push("该视频没有平台自动字幕，口播内容无法读取。");
    }

    if (videoInfo.streamUrl) {
      try {
        evidence.frames = await captureVideoFrames(videoInfo.streamUrl, videoInfo.durationMs);
        onDetail?.(evidence.frames.length ? `已截取 ${evidence.frames.length} 帧视频画面` : "未能截取视频画面");
      } catch (error) {
        evidence.warnings.push(`视频画面截取失败（${error?.message || "未知错误"}）。`);
        const liveFrame = captureLivePlayerFrame(root);
        if (liveFrame) evidence.frames.push(liveFrame);
      }
    }

    return evidence;
  }

  function buildVideoEvidence(root, noteId, onDetail) {
    if (!noteId) return Promise.resolve(null);
    return requestNoteDetailWithFallback(noteId)
      .then((noteDetail) => {
        const videoInfo = buildVideoInfo(noteDetail);
        if (!videoInfo) return null;
        return loadVideoEvidence(root, videoInfo, onDetail);
      })
      .catch(() => null);
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
    const selectors = selector
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const raw = selectors
      .map((item) => textOf(root, `${item} .count`))
      .find(Boolean) || "";
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

  // 视频帖没有轮播图，画面证据就是截帧（dataUrl 直接随消息传给后台识别）。
  function collectNoteMedia(root, videoEvidence) {
    if (videoEvidence) {
      return videoEvidence.frames.map((frame) => ({
        url: null,
        dataUrl: frame.dataUrl,
        width: frame.width || null,
        height: frame.height || null,
        timestampSec: frame.timestampSec,
        source: "video_frame"
      }));
    }
    return collectMedia(root);
  }

  function buildVisionSeed(root, videoEvidence) {
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
        images: collectNoteMedia(root, videoEvidence),
        video: videoEvidence ? {
          durationSec: videoEvidence.durationMs ? Math.round(videoEvidence.durationMs / 1000) : null,
          transcript: videoEvidence.transcript,
          transcriptSource: videoEvidence.transcriptSource
        } : null,
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

  function extractNote(root, options, loadingResult, videoEvidence = null) {
    const noteId = getNoteId();
    if (!noteId) throw new Error("无法识别当前帖文 ID。");

    const dateLocation = splitPublishedAndLocation(
      textOf(root, ".bottom-container .date") || textOf(root, ".bottom-container")
    );
    const displayedCommentRaw = textOf(root, ".comments-container .total") ||
      textOf(root, ".chat-wrapper .count");
    const comments = collectTopLevelComments(root, options.limit, options.includeVisibleReplies);
    const frameImages = collectNoteMedia(root, videoEvidence);

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
        type: videoEvidence ? "video" : "normal",
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
        images: frameImages,
        video: videoEvidence ? {
          durationSec: videoEvidence.durationMs ? Math.round(videoEvidence.durationMs / 1000) : null,
          width: videoEvidence.width,
          height: videoEvidence.height,
          transcript: videoEvidence.transcript,
          transcriptSource: videoEvidence.transcriptSource,
          frameTimestamps: videoEvidence.frames.map((frame) => frame.timestampSec)
        } : null,
        note: "页面当前可访问的图片版本，不保证为创作者上传的未压缩原文件。"
      },
      uncertainties: videoEvidence?.warnings?.length ? videoEvidence.warnings : undefined
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
    const videoEvidence = await buildVideoEvidence(root, getNoteId(), (detail) => {
      return sendProgress("正在读取视频", detail, 0);
    });
    if (typeof onVisionSeed === "function") onVisionSeed(buildVisionSeed(root, videoEvidence));
    const loadingResult = await loadTopLevelComments(root, options.limit);
    await sendProgress("正在整理证据", "汇总正文、互动数据、媒体和评论", Math.min(options.limit, loadingResult.loaded));

    const payload = extractNote(root, options, loadingResult, videoEvidence);
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

  function startVisionPreparation(visionSeed) {
    if (!visionSeed?.media?.images?.length) return null;
    return chrome.runtime.sendMessage({
      type: "XHS_AI_PREPARE_VISION",
      payload: visionSeed,
      pageSessionId: PAGE_SESSION_ID
    }).catch(() => null);
  }

  async function runCaptureAndSummarize(rawOptions, suppliedPayload, force) {
    let payload = suppliedPayload || null;
    let visionPreparationPromise = null;
    if (payload) {
      await sendProgress("正在重新生成", "复用本页面已经采集的证据", payload.commentExport?.extractedTopLevelCount || 0);
    } else {
      payload = (await runCapture(rawOptions, (visionSeed) => {
        visionPreparationPromise = startVisionPreparation(visionSeed);
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

  // 供“加入合并清单”使用：完整采集并等待后台图片识别写入缓存，但不调用文字模型。
  async function runCaptureForMerge(rawOptions) {
    let visionPreparationPromise = null;
    const captured = await runCapture(rawOptions, (visionSeed) => {
      visionPreparationPromise = startVisionPreparation(visionSeed);
    });
    if (visionPreparationPromise) await visionPreparationPromise;

    const payload = captured.payload;
    const mediaUnit = payload.media.video ? "帧视频画面" : "张图片";
    const detail = `已采集 ${payload.commentExport.extractedTopLevelCount} 条一级评论和 ${payload.media.images.length} ${mediaUnit}。`;
    await Promise.allSettled([
      chrome.runtime.sendMessage({
        type: "XHS_AI_MERGE_CAPTURE_DONE",
        pageSessionId: PAGE_SESSION_ID,
        pageUrl: location.href,
        noteId: payload.source?.noteId || null,
        detail
      }),
      chrome.storage.local.set({
        xhsExporterStatus: {
          state: "done",
          title: "已采集完成",
          detail: "页面证据已采集，可回到插件加入合并清单。",
          count: payload.commentExport.extractedTopLevelCount,
          updatedAt: Date.now()
        }
      })
    ]);
    return {
      ok: true,
      payload,
      topLevelCount: captured.topLevelCount,
      imageCount: captured.imageCount
    };
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

    if (!message || !["XHS_CAPTURE_START", "XHS_EXPORT_START", "XHS_CAPTURE_AND_SUMMARIZE", "XHS_CAPTURE_FOR_MERGE"].includes(message.type)) {
      return undefined;
    }

    const operation = message.type === "XHS_CAPTURE_START"
      ? runCapture(message.options)
      : message.type === "XHS_EXPORT_START"
        ? runExtraction(message.options)
        : message.type === "XHS_CAPTURE_FOR_MERGE"
          ? runCaptureForMerge(message.options)
          : startAiWorkflow(message);
    operation
      .then(sendResponse)
      .catch(async (error) => {
        if (["XHS_CAPTURE_AND_SUMMARIZE", "XHS_CAPTURE_FOR_MERGE"].includes(message.type)) {
          await notifyWorkflowFailure(error);
        }
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
