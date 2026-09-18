(() => {
  if (globalThis.__WEIBO_POST_EXPORTER_INSTALLED__) return;
  globalThis.__WEIBO_POST_EXPORTER_INSTALLED__ = true;
  const PAGE_SESSION_ID = globalThis.__WEIBO_POST_EXPORTER_PAGE_SESSION_ID__ ||
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  globalThis.__WEIBO_POST_EXPORTER_PAGE_SESSION_ID__ = PAGE_SESSION_ID;

  const DEFAULT_LIMIT = 50;
  // 评论按平台默认热度序分页拉取；条数上限与小红书一致（50 条一级评论）。
  const COMMENT_PAGE_SIZE = 20;
  const MAX_COMMENT_PAGES = 6;
  const REPLY_LIMIT_PER_COMMENT = 10;
  const FRAME_MAX_EDGE = 720;
  const FRAME_QUALITY = 0.62;

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function stripSharedFragments(text) {
    // 微博正文里常见“ ​​​”零宽占位与“收起d”等界面碎片，避免进入模型证据。
    return cleanText(String(text || "").replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, ""));
  }

  function getNoteId() {
    return location.pathname.match(/^\/\d+\/([0-9A-Za-z]+)/)?.[1] || null;
  }

  function httpsMediaUrl(url) {
    const text = cleanText(url);
    return text ? text.replace(/^http:\/\//i, "https://") : null;
  }

  async function fetchWeiboJson(path, errorLabel) {
    let response;
    try {
      response = await fetch(path, { credentials: "include" });
    } catch {
      throw new Error(`${errorLabel}请求失败，请检查网络后重试。`);
    }
    if (!response.ok) throw new Error(`${errorLabel}返回 HTTP ${response.status}。`);
    const data = await response.json();
    if (data?.ok !== 1) {
      throw new Error(`${errorLabel}未返回数据，请确认已登录微博且帖文可访问后重试。`);
    }
    return data;
  }

  // 微博接口时间形如 "Sat Sep 12 10:24:58 +0800 2026"，是官方绝对时间，无需推断。
  // 展示统一按北京时间格式化，避免采集机器的本地时区把日期挪前一天。
  const DISPLAY_TIME_ZONE = "Asia/Shanghai";

  function parseWeiboTime(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function zonedTimeParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: DISPLAY_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function formatPostTime(date) {
    if (!date) return null;
    const parts = zonedTimeParts(date);
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }

  function formatCommentTime(date, referenceYear) {
    if (!date) return null;
    const parts = zonedTimeParts(date);
    const monthDay = `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    return Number(parts.year) === referenceYear ? monthDay : `${parts.year}-${monthDay}`;
  }

  function toCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
  }

  function countField(value) {
    const number = toCount(value);
    return { raw: number == null ? null : String(number), value: number };
  }

  function regionOf(value) {
    return cleanText(value).replace(/^(?:发布于|来自)\s*/, "") || null;
  }

  function hashtagsOf(post, text) {
    const tagged = (Array.isArray(post?.tag_struct) ? post.tag_struct : [])
      .map((tag) => cleanText(tag?.tag_name))
      .filter(Boolean)
      .map((name) => `#${name}`);
    if (tagged.length) return tagged;
    return Array.from(new Set(
      Array.from(String(text || "").matchAll(/#([^#\s]{1,40})#/g))
        .map((match) => `#${match[1]}`)
    )).slice(0, 30);
  }

  async function loadLongText(mblogid) {
    if (!mblogid) return null;
    try {
      const data = await fetchWeiboJson(
        `/ajax/statuses/longtext?id=${encodeURIComponent(mblogid)}`,
        "微博长文接口"
      );
      return stripSharedFragments(data?.data?.longTextContent) || null;
    } catch {
      return null;
    }
  }

  // ---- 视频帖：微博接口没有自动字幕；画面证据为播放器当前帧（尽力而为）。 ----

  function findVideoMediaInfo(post) {
    if (post?.page_info?.object_type === "video" && post.page_info?.media_info) {
      return post.page_info.media_info;
    }
    const items = Array.isArray(post?.mix_media_info?.items) ? post.mix_media_info.items : [];
    const videoItem = items.find((item) => item?.type === "video" && item?.data);
    return videoItem?.data?.media_info || videoItem?.data || null;
  }

  function capturePlayerFrame() {
    const videos = Array.from(document.querySelectorAll("video"))
      .filter((video) => video.readyState >= 2 && video.videoWidth > 0)
      .sort((left, right) => (right.videoWidth * right.videoHeight) - (left.videoWidth * left.videoHeight));
    const video = videos[0];
    if (!video) return null;
    try {
      const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      return {
        dataUrl: canvas.toDataURL("image/jpeg", FRAME_QUALITY),
        width: canvas.width,
        height: canvas.height,
        timestampSec: Math.round(video.currentTime || 0),
        source: "video_frame"
      };
    } catch {
      return null;
    }
  }

  function buildVideoEvidence(post) {
    const mediaInfo = findVideoMediaInfo(post);
    if (!mediaInfo) return null;
    const evidence = {
      durationMs: toCount(Number(mediaInfo.duration) * 1000),
      width: toCount(mediaInfo.width),
      height: toCount(mediaInfo.height),
      transcript: null,
      transcriptSource: null,
      frames: [],
      warnings: ["微博视频没有可读取的自动字幕，口播内容缺失。"]
    };
    const frame = capturePlayerFrame();
    if (frame) evidence.frames.push(frame);
    else evidence.warnings.push("未能截取视频画面，仅依据正文与评论概括。");
    return evidence;
  }

  function collectImages(posts) {
    const images = [];
    const seen = new Set();
    for (const post of posts) {
      if (!post) continue;
      const picInfos = post.pic_infos || {};
      const picIds = Array.isArray(post.pic_ids) ? post.pic_ids : Object.keys(picInfos);
      for (const picId of picIds) {
        const info = picInfos[picId];
        const largest = info?.largest || info?.original || info?.large;
        const url = httpsMediaUrl(largest?.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        images.push({
          url,
          width: toCount(largest?.width),
          height: toCount(largest?.height),
          source: "weibo_api_pic_infos"
        });
      }
    }
    return images;
  }

  // 转发帖：正文图在前，原微博图在后；视频帧作为画面证据追加。
  function collectAllImages(bundle, videoEvidence) {
    return [
      ...collectImages([bundle.post]),
      ...(videoEvidence ? videoEvidence.frames : []),
      ...collectImages([bundle.post?.retweeted_status || null])
    ];
  }

  function parseComment(item, authorUserId, referenceYear) {
    const user = item?.user || {};
    const userId = user.id != null ? String(user.id) : null;
    return {
      id: item?.idstr || (item?.id != null ? String(item.id) : null),
      parentCommentId: null,
      kind: "top_level",
      author: cleanText(user.screen_name) || null,
      userId,
      content: stripSharedFragments(item?.text_raw) || null,
      publishedDisplay: formatCommentTime(parseWeiboTime(item?.created_at), referenceYear),
      location: regionOf(item?.region_name),
      likes: countField(item?.like_counts),
      displayedReplyCount: toCount(item?.total_number) || 0,
      isAuthor: Boolean(userId && authorUserId && userId === authorUserId),
      isPinned: false
    };
  }

  function parseCommentWithReplies(item, authorUserId, referenceYear) {
    const parsed = parseComment(item, authorUserId, referenceYear);
    parsed.visibleReplies = (Array.isArray(item?.comments) ? item.comments : [])
      .slice(0, REPLY_LIMIT_PER_COMMENT)
      .map((reply) => {
        const user = reply?.user || {};
        const replyUserId = user.id != null ? String(user.id) : null;
        return {
          id: reply?.idstr || (reply?.id != null ? String(reply.id) : null),
          parentCommentId: parsed.id,
          kind: "visible_reply",
          author: cleanText(user.screen_name) || null,
          userId: replyUserId,
          content: stripSharedFragments(reply?.text_raw) || null,
          publishedDisplay: formatCommentTime(parseWeiboTime(reply?.created_at), referenceYear),
          location: regionOf(reply?.region_name),
          likes: countField(reply?.like_counts),
          displayedReplyCount: 0,
          isAuthor: Boolean(replyUserId && authorUserId && replyUserId === authorUserId),
          isPinned: false
        };
      });
    return parsed;
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

  async function loadComments(noteId, limit) {
    const referenceYear = Number(zonedTimeParts(new Date()).year);
    const comments = [];
    const seen = new Set();
    let maxId = 0;
    let reason = "limit_reached";

    for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
      const params = new URLSearchParams({
        is_reload: "1",
        id: noteId,
        is_show_bulletin: "2",
        is_mix: "0",
        count: String(COMMENT_PAGE_SIZE),
        level: "0",
        flow: "0"
      });
      if (maxId) params.set("max_id", String(maxId));
      const data = await fetchWeiboJson(`/ajax/statuses/buildComments?${params.toString()}`, "微博评论接口");
      const items = Array.isArray(data?.data) ? data.data : [];
      if (!items.length) {
        reason = "page_exhausted";
        break;
      }

      for (const item of items) {
        const id = item?.idstr || String(item?.id ?? "");
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        if (comments.length >= limit) break;
        comments.push(parseCommentWithReplies(item, null, referenceYear));
      }
      await sendProgress("正在读取评论", `已加载 ${Math.min(comments.length, limit)} 条一级评论`, Math.min(comments.length, limit));

      if (comments.length >= limit) break;
      const nextMaxId = Number(data?.max_id) || 0;
      if (!nextMaxId) {
        reason = "page_exhausted";
        break;
      }
      maxId = nextMaxId;
      if (page === MAX_COMMENT_PAGES - 1) reason = "round_limit";
    }

    if (comments.length < limit && reason === "limit_reached") reason = "page_exhausted";
    return { comments, reason };
  }

  // 微博接口缺少作者回复标记时兜底：loadComments 之后统一按帖子作者 ID 重算 isAuthor。
  async function loadPostBundle() {
    const noteId = getNoteId();
    if (!noteId) throw new Error("无法识别当前微博 ID，请确认打开的是微博帖文详情页。");
    const post = await fetchWeiboJson(
      `/ajax/statuses/show?id=${encodeURIComponent(noteId)}`,
      "微博博文接口"
    );
    const retweeted = post?.retweeted_status || null;
    let content = stripSharedFragments(post?.text_raw) || null;
    if (post?.isLongText) {
      const longText = await loadLongText(post?.mblogid || noteId);
      if (longText) content = longText;
    }
    let quoted = null;
    if (retweeted) {
      let quotedText = stripSharedFragments(retweeted?.text_raw) || null;
      if (retweeted?.isLongText) {
        const longText = await loadLongText(retweeted?.mblogid || null);
        if (longText) quotedText = longText;
      }
      quoted = {
        author: cleanText(retweeted?.user?.screen_name) || null,
        userId: retweeted?.user?.id != null ? String(retweeted.user.id) : null,
        content: quotedText
      };
    }
    return { post, content, quoted };
  }

  function buildPayload(bundle, options, commentResult, videoEvidence) {
    const { post, content, quoted } = bundle;
    // URL 里可能是数字 mid 或 mblogid，统一以接口返回的 mblogid 为准，保证清单去重稳定。
    const noteId = bundle.post?.mblogid || getNoteId();
    const authorUserId = post?.user?.id != null ? String(post.user.id) : null;

    let contentText = content;
    if (quoted) {
      const quotedText = quoted.content ? `：${quoted.content}` : "";
      contentText = `${contentText || ""}\n// @${quoted.author || "未知用户"}${quotedText}`.trim();
    }
    for (const comment of commentResult.comments) {
      comment.isAuthor = Boolean(comment.userId && authorUserId && comment.userId === authorUserId);
    }

    const images = collectAllImages(bundle, videoEvidence);

    const uncertainties = [];
    if (videoEvidence) uncertainties.push(...videoEvidence.warnings);
    if (post?.isLongText && contentText === stripSharedFragments(post?.text_raw)) {
      uncertainties.push("该微博为长文，但长文内容未能读取，正文可能不完整。");
    }
    if (quoted && !quoted.content) {
      uncertainties.push("转发的原微博内容未能读取。");
    }

    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      source: {
        platform: "weibo",
        url: location.href.split("?")[0],
        noteId,
        pageSessionId: PAGE_SESSION_ID
      },
      note: {
        title: null,
        author: cleanText(post?.user?.screen_name) || null,
        authorProfileUrl: authorUserId ? `https://weibo.com/u/${authorUserId}` : null,
        content: contentText || null,
        type: videoEvidence ? "video" : "normal",
        hashtags: hashtagsOf(post, contentText),
        publishedDisplay: formatPostTime(parseWeiboTime(post?.created_at)),
        location: regionOf(post?.region_name),
        publishedAtInferred: null,
        publishedAtInferredSource: null
      },
      interactions: {
        likes: countField(post?.attitudes_count),
        collects: { raw: null, value: null },
        reposts: countField(post?.reposts_count),
        comments: countField(post?.comments_count),
        displayedCommentTotalRaw: post?.comments_count != null ? String(post.comments_count) : null,
        displayedCommentTotal: toCount(post?.comments_count)
      },
      commentExport: {
        scope: `first_${options.limit}_top_level_in_api_order`,
        requestedTopLevelCount: options.limit,
        extractedTopLevelCount: commentResult.comments.length,
        includesOnlyAlreadyVisibleReplies: options.includeVisibleReplies,
        visibleReplyCount: commentResult.comments.reduce((sum, item) => sum + item.visibleReplies.length, 0),
        isCompleteCommentExport: false,
        stopReason: commentResult.reason,
        comments: commentResult.comments
      },
      media: {
        images,
        video: videoEvidence ? {
          durationSec: videoEvidence.durationMs ? Math.round(videoEvidence.durationMs / 1000) : null,
          width: videoEvidence.width,
          height: videoEvidence.height,
          transcript: null,
          transcriptSource: null,
          frameTimestamps: videoEvidence.frames.map((frame) => frame.timestampSec)
        } : null,
        note: "图片为微博接口提供的最大尺寸版本，不保证为创作者上传的未压缩原文件。"
      },
      uncertainties: uncertainties.length ? uncertainties : undefined
    };
  }

  async function runCapture(rawOptions, onVisionSeed = null) {
    const options = {
      limit: Math.max(1, Math.min(50, Number(rawOptions?.limit) || DEFAULT_LIMIT)),
      downloadImages: rawOptions?.downloadImages !== false,
      includeVisibleReplies: rawOptions?.includeVisibleReplies !== false
    };

    await sendProgress("正在读取帖文", "通过微博接口获取正文、互动数和媒体资源", 0);
    const bundle = await loadPostBundle();
    const videoEvidence = buildVideoEvidence(bundle.post);
    if (typeof onVisionSeed === "function") {
      const seedImages = collectAllImages(bundle, videoEvidence);
      if (seedImages.length) {
        onVisionSeed({
          source: {
            platform: "weibo",
            url: location.href.split("?")[0],
            noteId: bundle.post?.mblogid || getNoteId(),
            pageSessionId: PAGE_SESSION_ID
          },
          media: {
            images: seedImages,
            video: videoEvidence ? {
              durationSec: videoEvidence.durationMs ? Math.round(videoEvidence.durationMs / 1000) : null,
              transcript: null,
              transcriptSource: null
            } : null,
            note: "页面当前可访问的图片版本，不保证为创作者上传的未压缩原文件。"
          }
        });
      }
    }
    const commentResult = await loadComments(bundle.post?.mblogid || getNoteId(), options.limit);
    await sendProgress("正在整理证据", "汇总正文、互动数据、媒体和评论", commentResult.comments.length);

    const payload = buildPayload(bundle, options, commentResult, videoEvidence);
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
      options: { downloadImages: rawOptions?.downloadImages !== false }
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
