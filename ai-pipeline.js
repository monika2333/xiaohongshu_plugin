(() => {
  const PROMPT_VERSION = XhsPrompts.version;
  const DISPLAY_TIME_ZONE = "Asia/Shanghai";
  const MAX_IMAGE_COUNT = 18;
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const VISION_BATCH_SIZE = 3;

  const DEFAULT_CONFIG = Object.freeze({
    text: {
      provider: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash"
    },
    vision: {
      provider: "openai_compatible",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-vl-plus"
    },
    rememberApiKeys: true,
    includeVisibleReplies: true,
    commentLimit: 50,
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
      rememberApiKeys: raw.rememberApiKeys !== false,
      includeVisibleReplies: raw.includeVisibleReplies !== false,
      commentLimit: Math.max(1, Math.min(50, Number(raw.commentLimit) || 50)),
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
      content.push({ type: "text", text: XhsPrompts.imageLabel(startIndex + offset + 1) });
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

  function compactComment(comment, includeVisibleReplies) {
    const result = {
      content: cleanText(comment.content, 700),
      likes: comment.likes?.value ?? comment.likes?.raw ?? null,
      isAuthor: Boolean(comment.isAuthor),
      isPinned: Boolean(comment.isPinned)
    };
    if (includeVisibleReplies) {
      result.visibleReplies = (comment.visibleReplies || []).slice(0, 10).map((reply) => ({
        content: cleanText(reply.content, 400),
        likes: reply.likes?.value ?? reply.likes?.raw ?? null,
        isAuthor: Boolean(reply.isAuthor)
      }));
    }
    return result;
  }

  function buildEvidence(payload, vision, config) {
    const publishedDate = resolvePublishedDate(payload);
    return {
      source: {
        platform: "小红书",
        url: originalPageUrl(payload),
        noteId: payload.source?.noteId || null
      },
      note: {
        title: cleanText(payload.note?.title, 500),
        author: cleanText(payload.note?.author, 200),
        publishedDate: publishedDate?.display || null,
        publishedDateIso: publishedDate?.iso || null,
        content: cleanText(payload.note?.content, 10000),
        hashtags: (payload.note?.hashtags || []).slice(0, 30).map((item) => cleanText(item, 100))
      },
      comments: (payload.commentExport?.comments || [])
        .slice(0, config.commentLimit)
        .map((comment) => compactComment(comment, config.includeVisibleReplies)),
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
        .filter(Boolean),
      warnings: (Array.isArray(parsed.warnings) ? parsed.warnings : [])
        .slice(0, 8)
        .map((item) => cleanText(item, 300))
        .filter(Boolean)
    };
  }

  function originalPageUrl(payload) {
    const url = cleanText(payload?.source?.url);
    if (!url) throw new Error("页面采集数据缺少完整原始地址，请重新打开帖文后再试。");
    return url;
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

    const sourceUrl = originalPageUrl(payload);
    const publishedDate = resolvePublishedDate(payload);
    const eventBody = withoutLeadingPublishDate(cleanText(structured.eventSummary).split(sourceUrl).join(""));
    const eventSummary = publishedDate?.display ? `${publishedDate.display}，${eventBody}` : eventBody;
    const opinions = (structured.opinionPoints || []).map((item) => sentence(cleanText(item).split(sourceUrl).join(""))).join("");
    const paragraph = `${sentence(eventSummary)}${engagement}${opinions}（小红书 ${sourceUrl}）`;
    return `★ ${withoutTrailingPunctuation(structured.headline)}\n${paragraph}`;
  }

  function visionCacheKey(payload, config) {
    const urls = (payload.media?.images || []).slice(0, MAX_IMAGE_COUNT).map((item) => stableImageUrl(item.url));
    return `vision:${payload.source?.noteId}:${hashText(config.vision.baseUrl)}:${config.vision.model}:${PROMPT_VERSION}:${hashText(JSON.stringify(urls))}`;
  }

  function textCacheKey(payload, config, vision) {
    const evidence = buildEvidence(payload, vision, config);
    return `text:${payload.source?.noteId}:${hashText(config.text.baseUrl)}:${config.text.model}:${PROMPT_VERSION}:${hashText(JSON.stringify(evidence))}`;
  }

  async function summarize(payload, rawConfig, secrets, cache = {}, emitProgress = () => {}, force = false) {
    const config = validateConfig(normalizeConfig(rawConfig));
    const textApiKey = secrets?.textApiKey || secrets?.deepseekApiKey;
    const visionApiKey = secrets?.visionApiKey || secrets?.qwenApiKey;
    if (!cleanText(textApiKey)) throw new Error("尚未配置文字模型 API Key，请先打开模型设置。");

    const images = (payload.media?.images || []).slice(0, MAX_IMAGE_COUNT);
    const warnings = [];
    let vision = [];
    const vKey = visionCacheKey(payload, config);

    if (images.length) {
      if (!cleanText(visionApiKey)) {
        warnings.push("未配置图片模型 API Key，本次未识别图片。");
      } else if (cache[vKey]) {
        vision = cache[vKey];
        emitProgress({ stage: "vision", percent: 62, detail: `已复用 ${images.length} 张图片的识别缓存` });
      } else {
        emitProgress({ stage: "vision", percent: 34, detail: `准备识别 ${images.length} 张图片` });
        try {
          for (let offset = 0; offset < images.length; offset += VISION_BATCH_SIZE) {
            const batch = images.slice(offset, offset + VISION_BATCH_SIZE);
            const items = await analyzeVisionBatch(batch, offset, config, visionApiKey);
            vision.push(...items);
            emitProgress({
              stage: "vision",
              percent: 34 + Math.round(((offset + batch.length) / images.length) * 28),
              detail: `已识别 ${Math.min(offset + batch.length, images.length)} / ${images.length} 张图片`
            });
          }
          cache[vKey] = vision;
        } catch (error) {
          warnings.push(`图片识别未完成：${error?.message || "未知错误"}`);
          vision = [];
        }
      }
    } else {
      emitProgress({ stage: "vision", percent: 62, detail: "当前帖文没有可识别的图片" });
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

    const allWarnings = [...warnings, ...(structured.warnings || [])];
    emitProgress({ stage: "done", percent: 100, detail: "概括已经生成" });
    return {
      text: renderSummary(structured, payload),
      structured,
      warnings: allWarnings,
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

  async function testProvider(provider, rawConfig, secrets) {
    const config = validateConfig(normalizeConfig(rawConfig));
    const isVision = provider === "vision";
    const target = isVision ? config.vision : config.text;
    const apiKey = isVision
      ? secrets?.visionApiKey || secrets?.qwenApiKey
      : secrets?.textApiKey || secrets?.deepseekApiKey;
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
    originalPageUrl,
    resolvePublishedDate,
    normalizeVisionItem,
    selectVisionEvidence,
    renderSummary,
    summarize,
    testProvider,
    hashText
  };
})();
