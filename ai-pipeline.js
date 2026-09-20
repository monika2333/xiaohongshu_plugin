(() => {
  const PROMPT_VERSION = XhsPrompts.version;
  const DISPLAY_TIME_ZONE = "Asia/Shanghai";
  const MAX_IMAGE_COUNT = 18;
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const VISION_BATCH_SIZE = 3;
  // 与内容脚本的采集上限一致：进入模型证据的评论条数兜底上限。
  const COMMENT_LIMIT = 50;

  const DEFAULT_CONFIG = Object.freeze({
    text: {
      provider: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash"
    },
    vision: {
      provider: "openai_compatible",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-vl-plus"
    },
    feishu: {
      mode: "webhook",
      appId: "",
      recipientId: ""
    },
    rememberApiKeys: true,
    saveHistory: true,
    promptVersion: PROMPT_VERSION
  });

  function cleanText(value, limit = Infinity) {
    return String(value ?? "")
      .replace(/\u0000/g, "")
      .replace(/\r/g, "")
      .trim()
      .slice(0, limit);
  }

  function zonedDateParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: DISPLAY_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day)
    };
  }

  function shiftedCalendarDate(parts, days) {
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate()
    };
  }

  function parseCountToken(value) {
    if (/^\d+$/.test(value)) return Number(value);
    const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (value === "十") return 10;
    if (value.includes("十")) {
      const [tens, ones] = value.split("十");
      return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
    }
    return digits[value] ?? Number.NaN;
  }

  // 用于解析截图 OCR 抄录的互动数字原文（如 "1,255"、"1.2万"）。
  function parseEngagementCount(raw) {
    const value = cleanText(raw).replace(/,/g, "");
    if (!value) return null;
    const match = value.match(/([\d.]+)\s*(万|千)?/);
    if (!match) return null;
    const number = Number.parseFloat(match[1]);
    if (!Number.isFinite(number)) return null;
    if (match[2] === "万") return Math.round(number * 10000);
    if (match[2] === "千") return Math.round(number * 1000);
    return Math.round(number);
  }

  function resolvedDate(parts, referenceParts, original, source) {
    const year = String(parts.year).padStart(4, "0");
    const month = String(parts.month).padStart(2, "0");
    const day = String(parts.day).padStart(2, "0");
    return {
      iso: `${year}-${month}-${day}`,
      display: parts.year === referenceParts.year
        ? `${parts.month}月${parts.day}日`
        : `${parts.year}年${parts.month}月${parts.day}日`,
      original,
      source
    };
  }

  function resolvePublishedDate(payload) {
    const original = cleanText(payload?.note?.publishedDisplay, 100);
    if (!original) return null;

    const parsedReference = new Date(payload?.exportedAt || Date.now());
    const reference = Number.isNaN(parsedReference.getTime()) ? new Date() : parsedReference;
    const referenceParts = zonedDateParts(reference);
    const normalized = original.replace(/^(?:编辑于|发布于)\s*/, "").trim();
    let target = null;
    let source = "";

    if (/^(?:刚刚|今天)/.test(normalized)) {
      target = referenceParts;
      source = "relative_today";
    } else if (/^昨天/.test(normalized)) {
      target = shiftedCalendarDate(referenceParts, -1);
      source = "relative_days";
    } else if (/^前天/.test(normalized)) {
      target = shiftedCalendarDate(referenceParts, -2);
      source = "relative_days";
    } else {
      const countPattern = "([零一二三四五六七八九十两\\d]+)";
      const daysAgo = normalized.match(new RegExp(`^${countPattern}\\s*(?:天|日)前`));
      const hoursAgo = normalized.match(new RegExp(`^${countPattern}\\s*小时前`));
      const minutesAgo = normalized.match(new RegExp(`^${countPattern}\\s*分钟前`));
      const fullDate = normalized.match(/^(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?/);
      const monthDay = normalized.match(/^(\d{1,2})[月\-/.](\d{1,2})日?/);

      if (daysAgo) {
        target = shiftedCalendarDate(referenceParts, -parseCountToken(daysAgo[1]));
        source = "relative_days";
      } else if (hoursAgo || minutesAgo) {
        const elapsedMs = hoursAgo
          ? parseCountToken(hoursAgo[1]) * 60 * 60 * 1000
          : parseCountToken(minutesAgo[1]) * 60 * 1000;
        target = zonedDateParts(new Date(reference.getTime() - elapsedMs));
        source = hoursAgo ? "relative_hours" : "relative_minutes";
      } else if (fullDate) {
        target = { year: Number(fullDate[1]), month: Number(fullDate[2]), day: Number(fullDate[3]) };
        source = "absolute_date";
      } else if (monthDay) {
        target = { year: referenceParts.year, month: Number(monthDay[1]), day: Number(monthDay[2]) };
        const targetNumber = Date.UTC(target.year, target.month - 1, target.day);
        const referenceNumber = Date.UTC(referenceParts.year, referenceParts.month - 1, referenceParts.day);
        if (targetNumber > referenceNumber + 24 * 60 * 60 * 1000) target.year -= 1;
        source = "month_day";
      }
    }

    if (!target) return null;
    const validation = new Date(Date.UTC(target.year, target.month - 1, target.day));
    if (
      validation.getUTCFullYear() !== target.year ||
      validation.getUTCMonth() + 1 !== target.month ||
      validation.getUTCDate() !== target.day
    ) return null;
    return resolvedDate(target, referenceParts, original, source);
  }

  function normalizeBaseUrl(value) {
    return cleanText(value).replace(/\/+$/, "");
  }

  function platformLabel(source) {
    const platform = cleanText(source?.platform, 40).toLowerCase();
    if (platform === "weibo") return "微博";
    if (platform === "xiaohongshu" || !platform) return "小红书";
    return platform;
  }

  function normalizeConfig(raw = {}) {
    return {
      text: {
        provider: "openai_compatible",
        baseUrl: normalizeBaseUrl(raw.text?.baseUrl || DEFAULT_CONFIG.text.baseUrl),
        model: cleanText(raw.text?.model || DEFAULT_CONFIG.text.model, 120)
      },
      vision: {
        provider: "openai_compatible",
        baseUrl: normalizeBaseUrl(raw.vision?.baseUrl || DEFAULT_CONFIG.vision.baseUrl),
        model: cleanText(raw.vision?.model || DEFAULT_CONFIG.vision.model, 120)
      },
      feishu: {
        mode: raw.feishu?.mode === "app" ? "app" : "webhook",
        appId: cleanText(raw.feishu?.appId, 160),
        recipientId: cleanText(raw.feishu?.recipientId, 160)
      },
      rememberApiKeys: raw.rememberApiKeys !== false,
      saveHistory: raw.saveHistory !== false,
      promptVersion: PROMPT_VERSION
    };
  }

  function validateHttpsUrl(value, label) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${label}不是有效网址。`);
    }
    if (parsed.protocol !== "https:") throw new Error(`${label}必须使用 HTTPS。`);
  }

  function validateConfig(config) {
    validateHttpsUrl(config.text.baseUrl, "文字模型 API 地址");
    validateHttpsUrl(config.vision.baseUrl, "图片模型 API 地址");
    if (!config.text.model) throw new Error("请填写文字模型名称。");
    if (!config.vision.model) throw new Error("请填写图片模型名称。");
    return config;
  }

  function endpointFor(baseUrl) {
    return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  }

  function hashText(value) {
    let hash = 2166136261;
    const input = String(value);
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function stableImageUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return String(url || "");
    }
  }

  function extractMessageText(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((item) => item?.text || item?.content || "").join("\n");
    }
    throw new Error("模型响应中没有可读取的内容。");
  }

  async function callChat({ baseUrl, apiKey, model, messages, temperature = 0.1, timeoutMs = 120000 }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpointFor(baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model, messages, temperature }),
        signal: controller.signal
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (!response.ok) {
        const detail = data?.error?.message || data?.message || cleanText(text, 280) || `HTTP ${response.status}`;
        throw new Error(`模型请求失败：${detail}`);
      }
      return extractMessageText(data);
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("模型响应超时，请稍后重试。");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function parseJsonResponse(text) {
    const cleaned = cleanText(text)
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      return JSON.parse(cleaned);
    } catch {
      const objectStart = cleaned.indexOf("{");
      const arrayStart = cleaned.indexOf("[");
      const starts = [objectStart, arrayStart].filter((value) => value >= 0);
      if (!starts.length) throw new Error("模型没有返回约定的 JSON 格式。");
      const start = Math.min(...starts);
      const end = cleaned[start] === "{" ? cleaned.lastIndexOf("}") : cleaned.lastIndexOf("]");
      if (end <= start) throw new Error("模型返回的 JSON 不完整。");
      return JSON.parse(cleaned.slice(start, end + 1));
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async function imageToDataUrl(image) {
    // 视频截帧已经是 dataUrl，无需再抓取
    if (typeof image?.dataUrl === "string" && image.dataUrl.startsWith("data:image/")) {
      return image.dataUrl;
    }
    const response = await fetch(image.url, { credentials: "omit" });
    if (!response.ok) throw new Error(`图片读取失败（HTTP ${response.status}）`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("图片超过 12 MB，已跳过");
    const contentType = response.headers.get("content-type")?.split(";")[0] || "image/webp";
    return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
  }

  function stringArray(value, itemLimit = 20, textLimit = 300) {
    return (Array.isArray(value) ? value : [])
      .slice(0, itemLimit)
      .map((item) => cleanText(item, textLimit))
      .filter(Boolean);
  }

  function normalizeVisionItem(item, fallbackIndex) {
    const visibleText = cleanText(item?.visible_text, 12000);
    const factualDescription = cleanText(item?.factual_description ?? item?.visual_summary, 2000);
    const allowedValues = new Set(["essential", "supporting", "none"]);
    const requestedValue = cleanText(item?.summary_value).toLowerCase();
    const requestedIndex = Number(item?.image_index);
    const summaryValue = allowedValues.has(requestedValue)
      ? requestedValue
      : (visibleText || factualDescription ? "supporting" : "none");
    return {
      image_index: Number.isInteger(requestedIndex) && requestedIndex > 0 ? requestedIndex : fallbackIndex,
      has_text: typeof item?.has_text === "boolean" ? item.has_text : Boolean(visibleText),
      visible_text: visibleText,
      factual_description: summaryValue === "none" ? "" : factualDescription,
      summary_value: summaryValue,
      include_reason: cleanText(item?.include_reason, 500),
      people: stringArray(item?.people),
      organizations: stringArray(item?.organizations),
      dates: stringArray(item?.dates),
      claims: stringArray(item?.claims),
      uncertainties: stringArray(item?.uncertainties)
    };
  }

  function selectVisionEvidence(vision) {
    return (vision || []).filter((item) => ["essential", "supporting"].includes(item?.summary_value));
  }

  async function analyzeVisionBatch(images, startIndex, config, apiKey) {
    const content = [];
    for (let offset = 0; offset < images.length; offset += 1) {
      const dataUrl = await imageToDataUrl(images[offset]);
      content.push({
        type: "text",
        text: XhsPrompts.imageLabel(
          startIndex + offset + 1,
          images[offset]?.source === "video_frame" ? images[offset] : null
        )
      });
      content.push({ type: "image_url", image_url: { url: dataUrl } });
    }
    content.push({
      type: "text",
      text: XhsPrompts.visionBatchInstruction(startIndex + 1, startIndex + images.length)
    });
    const raw = await callChat({
      baseUrl: config.vision.baseUrl,
      apiKey,
      model: config.vision.model,
      messages: [
        { role: "system", content: XhsPrompts.visionSystem },
        { role: "user", content }
      ],
      temperature: 0
    });
    const parsed = parseJsonResponse(raw);
    if (!Array.isArray(parsed)) throw new Error("图片模型返回结果不是 JSON 数组。");
    return parsed.map((item, offset) => normalizeVisionItem(item, startIndex + offset + 1));
  }

  function normalizeScreenshotExtraction(item, imageCount) {
    const source = Array.isArray(item) ? item[0] : item;
    const visibleComments = (Array.isArray(source?.visible_comments) ? source.visible_comments : [])
      .slice(0, 50)
      .map((comment) => ({
        author: cleanText(comment?.author, 200),
        content: cleanText(comment?.content, 700),
        likesRaw: cleanText(comment?.likes_raw ?? comment?.likesRaw, 40),
        isAuthor: Boolean(comment?.is_author)
      }))
      .filter((comment) => comment.author || comment.content);
    return {
      author: cleanText(source?.author, 200),
      publishedDisplay: cleanText(source?.published_display ?? source?.publishedDisplay, 100),
      title: cleanText(source?.title, 500),
      contentText: cleanText(source?.content_text ?? source?.contentText, 10000),
      hashtags: stringArray(source?.hashtags),
      likesRaw: cleanText(source?.likes_raw ?? source?.likesRaw, 40),
      collectsRaw: cleanText(source?.collects_raw ?? source?.collectsRaw, 40),
      commentsRaw: cleanText(source?.comments_raw ?? source?.commentsRaw, 40),
      visibleComments,
      uncertainties: stringArray(source?.uncertainties),
      imageCount: Number(imageCount) || 1
    };
  }

  // 把截图识别结果组装成与网页采集同 schema 的合成 payload，后续合并概括管线零改动复用。
  function buildScreenshotPayload(extraction, context = {}) {
    if (!extraction?.author && !extraction?.title && !extraction?.contentText && !extraction?.visibleComments?.length) {
      throw new Error("截图未能识别出帖文内容，请确认截图清晰完整后重试。");
    }

    const uncertainties = [...(extraction.uncertainties || [])];
    let publishedDisplay = extraction.publishedDisplay;
    if (publishedDisplay && !/^(?:\d{4}[年\-/.]\d{1,2}[月\-/.]\d{1,2}|\d{1,2}[月\-/.]\d{1,2})/.test(publishedDisplay)) {
      uncertainties.push(`发帖时间为相对表述（原文“${publishedDisplay}”），截图拍摄时间未知，无法换算为日期。`);
      publishedDisplay = "";
    }

    const likes = { raw: extraction.likesRaw || null, value: parseEngagementCount(extraction.likesRaw) };
    const collects = { raw: extraction.collectsRaw || null, value: parseEngagementCount(extraction.collectsRaw) };
    const commentsCount = parseEngagementCount(extraction.commentsRaw);
    const interactions = {
      likes,
      collects,
      comments: { raw: extraction.commentsRaw || null, value: commentsCount },
      displayedCommentTotalRaw: extraction.commentsRaw || null,
      displayedCommentTotal: commentsCount
    };
    const visibleComments = (extraction.visibleComments || [])
      .filter((comment) => comment.author || comment.content);

    return {
      schemaVersion: 1,
      exportedAt: (context.exportedAt instanceof Date ? context.exportedAt : new Date()).toISOString(),
      source: {
        platform: "xiaohongshu",
        url: cleanText(context.sourceUrl) || null,
        noteId: null,
        origin: "user_screenshot",
        screenshotId: cleanText(context.screenshotId) || "unknown",
        screenshotCount: extraction.imageCount
      },
      note: {
        title: extraction.title || null,
        author: extraction.author || null,
        authorProfileUrl: null,
        content: extraction.contentText || null,
        hashtags: extraction.hashtags,
        publishedDisplay: publishedDisplay || null,
        location: null,
        publishedAtInferred: null,
        publishedAtInferredSource: null
      },
      interactions,
      commentExport: {
        scope: "user_screenshot_visible_comments",
        extractedTopLevelCount: visibleComments.length,
        includesOnlyAlreadyVisibleReplies: false,
        visibleReplyCount: 0,
        isCompleteCommentExport: false,
        stopReason: "screenshot",
        comments: visibleComments.map((comment) => ({
          id: null,
          parentCommentId: null,
          kind: "top_level",
          author: comment.author || null,
          userId: null,
          content: comment.content || null,
          publishedDisplay: null,
          location: null,
          likes: { raw: comment.likesRaw || null, value: parseEngagementCount(comment.likesRaw) },
          displayedReplyCount: 0,
          isAuthor: comment.isAuthor,
          isPinned: false,
          visibleReplies: []
        }))
      },
      media: {
        images: [],
        note: "内容来自用户上传的帖文截图，图片二进制不保存。"
      },
      uncertainties
    };
  }

  async function analyzeScreenshots(dataUrls, config, apiKey) {
    if (!Array.isArray(dataUrls) || !dataUrls.length) throw new Error("没有可识别的截图。");
    const content = [];
    dataUrls.forEach((dataUrl, index) => {
      content.push({ type: "text", text: XhsPrompts.imageLabel(index + 1) });
      content.push({ type: "image_url", image_url: { url: dataUrl } });
    });
    content.push({ type: "text", text: XhsPrompts.screenshotInstruction(dataUrls.length) });
    const raw = await callChat({
      baseUrl: config.vision.baseUrl,
      apiKey,
      model: config.vision.model,
      messages: [
        { role: "system", content: XhsPrompts.screenshotSystem },
        { role: "user", content }
      ],
      temperature: 0
    });
    return normalizeScreenshotExtraction(parseJsonResponse(raw), dataUrls.length);
  }

  function compactComment(comment) {
    return {
      content: cleanText(comment.content, 700),
      likes: comment.likes?.value ?? comment.likes?.raw ?? null,
      isAuthor: Boolean(comment.isAuthor),
      isPinned: Boolean(comment.isPinned),
      visibleReplies: (comment.visibleReplies || []).slice(0, 10).map((reply) => ({
        content: cleanText(reply.content, 400),
        likes: reply.likes?.value ?? reply.likes?.raw ?? null,
        isAuthor: Boolean(reply.isAuthor)
      }))
    };
  }

  function buildEvidence(payload, vision, config) {
    const publishedDate = resolvePublishedDate(payload);
    const video = payload?.media?.video || null;
    const isVideoNote = Boolean(video) || payload?.note?.type === "video";
    return {
      source: {
        platform: platformLabel(payload?.source),
        url: cleanText(payload?.source?.url) || null,
        noteId: payload.source?.noteId || null,
        origin: payload.source?.origin === "user_screenshot" ? "user_screenshot" : "live_page"
      },
      note: {
        title: cleanText(payload.note?.title, 500),
        author: cleanText(payload.note?.author, 200),
        noteType: isVideoNote ? "video" : "normal",
        publishedDate: publishedDate?.display || null,
        publishedDateIso: publishedDate?.iso || null,
        content: cleanText(payload.note?.content, 10000),
        hashtags: (payload.note?.hashtags || []).slice(0, 30).map((item) => cleanText(item, 100)),
        uncertainties: stringArray(payload?.uncertainties || [])
      },
      video: video ? {
        durationSec: Number(video.durationSec) || null,
        transcript: cleanText(video.transcript, 6000) || null,
        transcriptSource: cleanText(video.transcriptSource, 60) || null
      } : null,
      comments: (payload.commentExport?.comments || [])
        .slice(0, COMMENT_LIMIT)
        .map((comment) => compactComment(comment)),
      imageEvidence: selectVisionEvidence(vision)
    };
  }

  async function createTextSummary(payload, vision, config, apiKey) {
    const evidence = buildEvidence(payload, vision, config);
    const raw = await callChat({
      baseUrl: config.text.baseUrl,
      apiKey,
      model: config.text.model,
      messages: [
        { role: "system", content: XhsPrompts.textSystem },
        {
          role: "user",
          content: XhsPrompts.textEvidence(evidence)
        }
      ],
      temperature: 0.2
    });
    const parsed = parseJsonResponse(raw);
    if (!parsed || Array.isArray(parsed) || !cleanText(parsed.headline) || !cleanText(parsed.event_summary)) {
      throw new Error("文字模型返回结果缺少标题或事件概括。");
    }
    return {
      headline: cleanText(parsed.headline, 160).replace(/^★\s*/, ""),
      eventSummary: cleanText(parsed.event_summary, 1800),
      opinionPoints: (Array.isArray(parsed.opinion_points) ? parsed.opinion_points : [])
        .slice(0, 3)
        .map((item) => cleanText(item, 500))
        .filter(Boolean)
    };
  }

  function withoutTrailingPunctuation(value) {
    return cleanText(value).replace(/[。！？；;,.，\s]+$/g, "");
  }

  function sentence(value) {
    const text = withoutTrailingPunctuation(value);
    return text ? `${text}。` : "";
  }

  function withoutLeadingPublishDate(value) {
    return cleanText(value)
      .replace(/^(?:\d{4}年)?\d{1,2}月\d{1,2}日[，,、：:\s]*/, "")
      .replace(/^\d{4}[\-/.]\d{1,2}[\-/.]\d{1,2}[，,、：:\s]*/, "")
      .replace(/^(?:刚刚|今天|昨天|前天|[零一二三四五六七八九十两\d]+\s*(?:分钟|小时|天|日)前)[，,、：:\s]*/, "");
  }

  function formatMetric(raw, value) {
    if (raw != null && cleanText(raw)) return cleanText(raw);
    return Number.isFinite(value) ? String(value) : "";
  }

  function renderSummary(structured, payload) {
    const likes = formatMetric(payload.interactions?.likes?.raw, payload.interactions?.likes?.value);
    const comments = formatMetric(
      payload.interactions?.comments?.raw || payload.interactions?.displayedCommentTotalRaw,
      payload.interactions?.comments?.value ?? payload.interactions?.displayedCommentTotal
    );
    let engagement = "";
    if (likes && comments) engagement = `截至目前，该帖文获${likes}次点赞、${comments}条评论。`;
    else if (likes) engagement = `截至目前，该帖文获${likes}次点赞。`;
    else if (comments) engagement = `截至目前，该帖文有${comments}条评论。`;

    const sourceUrl = cleanText(payload?.source?.url);
    const publishedDate = resolvePublishedDate(payload);
    let eventBody = cleanText(structured.eventSummary);
    if (sourceUrl) eventBody = eventBody.split(sourceUrl).join("");
    eventBody = withoutLeadingPublishDate(eventBody);
    const eventSummary = publishedDate?.display ? `${publishedDate.display}，${eventBody}` : eventBody;
    const opinionPoints = (structured.opinionPoints || [])
      .map((item) => withoutTrailingPunctuation(sourceUrl ? cleanText(item).split(sourceUrl).join("") : cleanText(item)))
      .filter(Boolean);
    const opinions = opinionPoints.length ? `${opinionPoints.join("；")}。` : "";
    const sourceSuffix = sourceUrl
      ? `（${platformLabel(payload?.source)} ${sourceUrl}）`
      : "（原帖已删除，内容据用户上传截图整理）";
    const paragraph = `${sentence(eventSummary)}${engagement}${opinions}${sourceSuffix}`;
    return `★ ${withoutTrailingPunctuation(structured.headline)}\n${paragraph}`;
  }

  function visionCacheKey(payload, config) {
    const urls = (payload.media?.images || []).slice(0, MAX_IMAGE_COUNT).map((item) => (
      item?.dataUrl ? `frame:${hashText(item.dataUrl)}` : stableImageUrl(item.url)
    ));
    return `vision:${platformLabel(payload?.source)}:${payload.source?.noteId}:${hashText(config.vision.baseUrl)}:${config.vision.model}:${PROMPT_VERSION}:${hashText(JSON.stringify(urls))}`;
  }

  async function resolveVision(payload, config, visionApiKey, cache, emitProgress) {
    const images = (payload.media?.images || []).slice(0, MAX_IMAGE_COUNT);
    const key = visionCacheKey(payload, config);
    let items = [];
    let status = "no_images";

    if (images.length) {
      if (!cleanText(visionApiKey)) {
        status = "missing_key";
        emitProgress({ stage: "vision", percent: 62, detail: "未配置图片模型，已跳过图片识别" });
      } else if (cache[key]) {
        items = cache[key];
        status = "cached";
        emitProgress({ stage: "vision", percent: 62, detail: `已复用 ${images.length} 张图片的识别缓存` });
      } else {
        emitProgress({ stage: "vision", percent: 34, detail: `准备识别 ${images.length} 张图片` });
        try {
          for (let offset = 0; offset < images.length; offset += VISION_BATCH_SIZE) {
            const batch = images.slice(offset, offset + VISION_BATCH_SIZE);
            const batchItems = await analyzeVisionBatch(batch, offset, config, visionApiKey);
            items.push(...batchItems);
            emitProgress({
              stage: "vision",
              percent: 34 + Math.round(((offset + batch.length) / images.length) * 28),
              detail: `已识别 ${Math.min(offset + batch.length, images.length)} / ${images.length} 张图片`
            });
          }
          cache[key] = items;
          status = "analyzed";
        } catch {
          items = [];
          status = "failed";
          emitProgress({ stage: "vision", percent: 62, detail: "图片识别未完成，继续概括文字内容" });
        }
      }
    } else {
      emitProgress({ stage: "vision", percent: 62, detail: "当前帖文没有可识别的图片" });
    }

    return { key, items, status };
  }

  function emitPreparedVisionProgress(prepared, imageCount, emitProgress) {
    if (prepared.status === "missing_key") {
      emitProgress({ stage: "vision", percent: 62, detail: "未配置图片模型，已跳过图片识别" });
    } else if (prepared.status === "failed") {
      emitProgress({ stage: "vision", percent: 62, detail: "图片识别未完成，继续概括文字内容" });
    } else if (prepared.status === "no_images") {
      emitProgress({ stage: "vision", percent: 62, detail: "当前帖文没有可识别的图片" });
    } else if (prepared.status === "cached") {
      emitProgress({ stage: "vision", percent: 62, detail: `已复用 ${imageCount} 张图片的识别缓存` });
    } else {
      emitProgress({ stage: "vision", percent: 62, detail: `已在读取评论期间识别 ${imageCount} 张图片` });
    }
  }

  async function prepareVision(payload, rawConfig, secrets, cache = {}, emitProgress = () => {}) {
    const config = validateConfig(normalizeConfig(rawConfig));
    const visionApiKey = secrets?.visionApiKey;
    const prepared = await resolveVision(payload, config, visionApiKey, cache, emitProgress);
    return { ...prepared, cache };
  }

  function textCacheKey(payload, config, vision) {
    const evidence = buildEvidence(payload, vision, config);
    return `text:${platformLabel(payload?.source)}:${payload.source?.noteId}:${hashText(config.text.baseUrl)}:${config.text.model}:${PROMPT_VERSION}:${hashText(JSON.stringify(evidence))}`;
  }

  async function summarize(
    payload,
    rawConfig,
    secrets,
    cache = {},
    emitProgress = () => {},
    force = false,
    preparedVision = null
  ) {
    const config = validateConfig(normalizeConfig(rawConfig));
    const textApiKey = secrets?.textApiKey;
    const visionApiKey = secrets?.visionApiKey;
    if (!cleanText(textApiKey)) throw new Error("尚未配置文字模型 API Key，请先打开模型设置。");

    const images = (payload.media?.images || []).slice(0, MAX_IMAGE_COUNT);
    const vKey = visionCacheKey(payload, config);
    let vision;

    if (preparedVision?.key === vKey && Array.isArray(preparedVision.items)) {
      vision = preparedVision.items.map((item, offset) => normalizeVisionItem(item, offset + 1));
      if (["analyzed", "cached"].includes(preparedVision.status)) cache[vKey] = vision;
      emitPreparedVisionProgress(preparedVision, images.length, emitProgress);
    } else {
      vision = (await resolveVision(payload, config, visionApiKey, cache, emitProgress)).items;
    }

    const tKey = textCacheKey(payload, config, vision);
    let structured = !force ? cache[tKey] : null;
    if (structured) {
      emitProgress({ stage: "text", percent: 88, detail: "已复用文字概括缓存" });
    } else {
      emitProgress({ stage: "text", percent: 68, detail: "文字模型正在整合正文、图片与评论" });
      structured = await createTextSummary(payload, vision, config, textApiKey);
      cache[tKey] = structured;
    }

    emitProgress({ stage: "done", percent: 94, detail: "概括已经生成" });
    return {
      text: renderSummary(structured, payload),
      structured,
      evidence: {
        topLevelComments: payload.commentExport?.extractedTopLevelCount || 0,
        visibleReplies: payload.commentExport?.visibleReplyCount || 0,
        imagesFound: payload.media?.images?.length || 0,
        imagesAnalyzed: vision.length,
        imagesSelected: selectVisionEvidence(vision).length,
        visionModel: vision.length ? config.vision.model : null,
        textModel: config.text.model
      },
      cache
    };
  }

  function sortPayloadsChronologically(payloads) {
    return payloads
      .map((payload, index) => ({ payload, index, date: resolvePublishedDate(payload) }))
      .sort((left, right) => {
        if (left.date?.iso && right.date?.iso) return left.date.iso.localeCompare(right.date.iso);
        if (left.date?.iso) return -1;
        if (right.date?.iso) return 1;
        return left.index - right.index;
      })
      .map((entry) => entry.payload);
  }

  function buildMergedEvidence(payloads, visions, config) {
    return {
      task: "merge_multiple_notes",
      postCount: payloads.length,
      posts: payloads.map((payload, index) => buildEvidence(payload, visions[index], config))
    };
  }

  async function createMergedSummary(payloads, visions, config, apiKey) {
    const evidence = buildMergedEvidence(payloads, visions, config);
    const raw = await callChat({
      baseUrl: config.text.baseUrl,
      apiKey,
      model: config.text.model,
      messages: [
        { role: "system", content: XhsPrompts.mergeSystem },
        { role: "user", content: XhsPrompts.mergeEvidence(evidence) }
      ],
      temperature: 0.2
    });
    const parsed = parseJsonResponse(raw);
    if (!parsed || Array.isArray(parsed) || !cleanText(parsed.headline) || !cleanText(parsed.event_summary)) {
      throw new Error("文字模型返回结果缺少标题或事件概括。");
    }
    return {
      headline: cleanText(parsed.headline, 160).replace(/^★\s*/, ""),
      eventSummary: cleanText(parsed.event_summary, 2400),
      opinionPoints: (Array.isArray(parsed.opinion_points) ? parsed.opinion_points : [])
        .slice(0, 4)
        .map((item) => cleanText(item, 500))
        .filter(Boolean)
    };
  }

  function renderMergedSummary(structured, payloads) {
    const sources = [];
    let missingLinkCount = 0;
    let likesTotal = 0;
    let likesKnown = 0;
    let commentsTotal = 0;
    let commentsKnown = 0;
    let earliest = null;

    for (const payload of payloads) {
      const url = cleanText(payload?.source?.url);
      if (url) sources.push({ platform: platformLabel(payload?.source), url });
      else missingLinkCount += 1;
      const likes = payload.interactions?.likes?.value;
      if (Number.isFinite(likes) && likes > 0) {
        likesTotal += likes;
        likesKnown += 1;
      }
      const comments = payload.interactions?.comments?.value ?? payload.interactions?.displayedCommentTotal;
      if (Number.isFinite(comments) && comments > 0) {
        commentsTotal += comments;
        commentsKnown += 1;
      }
      const date = resolvePublishedDate(payload);
      if (date?.iso && (!earliest || date.iso < earliest.iso)) earliest = date;
    }

    const singular = payloads.length === 1;
    let engagement = "";
    if (singular) {
      if (likesKnown && commentsKnown) engagement = `截至目前，该帖文获${likesTotal}次点赞、${commentsTotal}条评论。`;
      else if (likesKnown) engagement = `截至目前，该帖文获${likesTotal}次点赞。`;
      else if (commentsKnown) engagement = `截至目前，该帖文有${commentsTotal}条评论。`;
    } else if (likesKnown && commentsKnown) engagement = `截至目前，上述帖文共获${likesTotal}次点赞、${commentsTotal}条评论。`;
    else if (likesKnown) engagement = `截至目前，上述帖文共获${likesTotal}次点赞。`;
    else if (commentsKnown) engagement = `截至目前，上述帖文共有${commentsTotal}条评论。`;

    let eventBody = cleanText(structured.eventSummary);
    for (const { url } of sources) eventBody = eventBody.split(url).join("");
    eventBody = withoutLeadingPublishDate(eventBody);
    const eventSummary = earliest?.display ? `${earliest.display}，${eventBody}` : eventBody;
    const opinionPoints = (structured.opinionPoints || [])
      .map((item) => withoutTrailingPunctuation(cleanText(item)))
      .filter(Boolean);
    const opinions = opinionPoints.length ? `${opinionPoints.join("；")}。` : "";

    // 同一平台时沿用“（小红书 链接1；链接2）”的形式；跨平台混排时逐条标注来源平台。
    const platformLabels = [...new Set(sources.map((source) => source.platform))];
    const sourcePrefix = platformLabels.length === 1 ? `${platformLabels[0]} ` : "";
    const sourceEntries = sources.map((source) => (
      platformLabels.length === 1 ? source.url : `${source.platform} ${source.url}`
    ));
    let sourceSuffix;
    if (!sources.length) {
      sourceSuffix = payloads.length > 1
        ? "（原帖均已删除，内容据用户上传截图整理）"
        : "（原帖已删除，内容据用户上传截图整理）";
    } else if (missingLinkCount > 0) {
      sourceSuffix = `（${sourcePrefix}${[...sourceEntries, `另${missingLinkCount}条原帖已删除`].join("；")}）`;
    } else {
      sourceSuffix = `（${sourcePrefix}${sourceEntries.join("；")}）`;
    }

    return `★ ${withoutTrailingPunctuation(structured.headline)}\n${sentence(eventSummary)}${engagement}${opinions}${sourceSuffix}`;
  }

  function mergedTextCacheKey(payloads, config, visions) {
    const evidence = buildMergedEvidence(payloads, visions, config);
    const ids = payloads
      .map((payload) => `${platformLabel(payload?.source)}:${payload.source?.noteId || payload.source?.screenshotId || "unknown"}`)
      .join(",");
    return `merge:${ids}:${hashText(config.text.baseUrl)}:${config.text.model}:${PROMPT_VERSION}:${hashText(JSON.stringify(evidence))}`;
  }

  async function summarizeMerged(
    payloads,
    rawConfig,
    secrets,
    cache = {},
    emitProgress = () => {},
    force = false
  ) {
    if (!Array.isArray(payloads) || !payloads.length) {
      throw new Error("合并清单是空的，请先加入帖文或上传截图。");
    }
    const config = validateConfig(normalizeConfig(rawConfig));
    const textApiKey = secrets?.textApiKey;
    const visionApiKey = secrets?.visionApiKey;
    if (!cleanText(textApiKey)) throw new Error("尚未配置文字模型 API Key，请先打开模型设置。");

    const ordered = sortPayloadsChronologically(payloads);
    const visions = [];
    let imagesFound = 0;
    let imagesAnalyzed = 0;
    let imagesSelected = 0;
    let visionModelUsed = false;

    for (let index = 0; index < ordered.length; index += 1) {
      const payload = ordered[index];
      imagesFound += payload.media?.images?.length || 0;
      if (payload.source?.origin === "user_screenshot") {
        visions.push([]);
        continue;
      }
      const percentBase = 30 + Math.round(((index + 0.5) / ordered.length) * 30);
      const resolved = await resolveVision(payload, config, visionApiKey, cache, (progress) => {
        emitProgress({
          stage: "vision",
          percent: percentBase,
          detail: `帖文 ${index + 1}/${ordered.length}：${progress.detail || "正在识别图片"}`
        });
      });
      visions.push(resolved.items);
      imagesAnalyzed += resolved.items.length;
      imagesSelected += selectVisionEvidence(resolved.items).length;
      if (resolved.items.length) visionModelUsed = true;
    }

    const tKey = mergedTextCacheKey(ordered, config, visions);
    let structured = !force ? cache[tKey] : null;
    if (structured) {
      emitProgress({ stage: "text", percent: 88, detail: "已复用合并概括缓存" });
    } else {
      emitProgress({
        stage: "text",
        percent: 68,
        detail: `文字模型正在整合 ${ordered.length} 条帖文的正文、图片与评论`
      });
      structured = await createMergedSummary(ordered, visions, config, textApiKey);
      cache[tKey] = structured;
    }

    emitProgress({ stage: "done", percent: 94, detail: "合并概括已经生成" });
    const totalTopLevel = ordered.reduce(
      (sum, payload) => sum + (payload.commentExport?.extractedTopLevelCount || 0), 0
    );
    const totalReplies = ordered.reduce(
      (sum, payload) => sum + (payload.commentExport?.visibleReplyCount || 0), 0
    );
    return {
      text: renderMergedSummary(structured, ordered),
      structured,
      evidence: {
        postCount: ordered.length,
        posts: ordered.map((payload) => ({
          noteId: payload.source?.noteId || null,
          origin: payload.source?.origin === "user_screenshot" ? "user_screenshot" : "live_page"
        })),
        topLevelComments: totalTopLevel,
        visibleReplies: totalReplies,
        imagesFound,
        imagesAnalyzed,
        imagesSelected,
        visionModel: visionModelUsed ? config.vision.model : null,
        textModel: config.text.model
      },
      cache
    };
  }

  async function testProvider(provider, rawConfig, secrets) {
    const config = validateConfig(normalizeConfig(rawConfig));
    const isVision = provider === "vision";
    const target = isVision ? config.vision : config.text;
    const apiKey = isVision ? secrets?.visionApiKey : secrets?.textApiKey;
    if (!cleanText(apiKey)) throw new Error(`请先填写${isVision ? "图片" : "文字"}模型 API Key。`);
    const answer = await callChat({
      baseUrl: target.baseUrl,
      apiKey,
      model: target.model,
      messages: [{ role: "user", content: XhsPrompts.connectionTest }],
      temperature: 0,
      timeoutMs: 45000
    });
    return { ok: true, detail: cleanText(answer, 80) || "连接成功" };
  }

  globalThis.XhsAi = {
    DEFAULT_CONFIG,
    normalizeConfig,
    validateConfig,
    parseJsonResponse,
    platformLabel,
    resolvePublishedDate,
    normalizeVisionItem,
    selectVisionEvidence,
    renderSummary,
    prepareVision,
    summarize,
    testProvider,
    hashText,
    parseEngagementCount,
    normalizeScreenshotExtraction,
    buildScreenshotPayload,
    analyzeScreenshots,
    sortPayloadsChronologically,
    buildEvidence,
    buildMergedEvidence,
    renderMergedSummary,
    summarizeMerged
  };
})();
