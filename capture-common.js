// 小红书与微博内容脚本共享的采集工作流：进度上报、图片识别预备、概括、
// 合并清单与消息协议。平台脚本通过 createCaptureWorkflow 提供各自的
// runCapture 与 getNoteId，消息协议改动只需修改本文件。
// 由 panel.js 通过 executeScript 在平台脚本之前注入页面。
(() => {
  if (globalThis.__XHS_CAPTURE_COMMON__) return;
  globalThis.__XHS_CAPTURE_COMMON__ = true;

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function httpsMediaUrl(url) {
    const text = cleanText(url);
    return text ? text.replace(/^http:\/\//i, "https://") : null;
  }

  // 同一页面反复注入时保持同一会话 ID，重开侧边栏才能恢复同一工作流状态。
  function ensurePageSessionId(globalKey) {
    const id = globalThis[globalKey] ||
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    globalThis[globalKey] = id;
    return id;
  }

  function createCaptureWorkflow({ pageSessionId, getNoteId, getNoteTitle, getDetailReady, runCapture }) {
    function currentNoteTitle() {
      return typeof getNoteTitle === "function" ? cleanText(getNoteTitle()) : "";
    }

    async function sendProgress(title, detail, count) {
      const status = {
        state: "working",
        title,
        detail,
        count,
        pageSessionId,
        pageUrl: location.href,
        noteId: getNoteId(),
        updatedAt: Date.now()
      };
      // 帖文标题供侧边栏任务列表区分多个并行任务
      const noteTitle = currentNoteTitle();
      if (noteTitle) status.noteTitle = noteTitle;
      await chrome.runtime.sendMessage({ type: "XHS_EXPORT_PROGRESS", ...status }).catch(() => {});
    }

    function startVisionPreparation(visionSeed) {
      if (!visionSeed?.media?.images?.length) return null;
      return chrome.runtime.sendMessage({
        type: "XHS_AI_PREPARE_VISION",
        payload: visionSeed,
        pageSessionId
      }).catch(() => null);
    }

    async function runCaptureAndSummarize(rawOptions, suppliedPayload, force, givenUrl) {
      let payload = suppliedPayload || null;
      let visionPreparationPromise = null;
      if (payload) {
        await sendProgress("正在重新生成", "复用本页面已经采集的证据", payload.commentExport?.extractedTopLevelCount || 0);
      } else {
        payload = (await runCapture(rawOptions, (visionSeed) => {
          visionPreparationPromise = startVisionPreparation(visionSeed);
        })).payload;
      }
      // 链接概括流：概括输出与历史沿用用户提供的链接（如 xhslink.cn 短链），
      // 页面自身的 location.href 保留在 source.url，供后台校验与页签匹配使用。
      if (givenUrl && payload?.source) payload.source.givenUrl = String(givenUrl);

      const visionPreparationResponse = visionPreparationPromise
        ? await visionPreparationPromise
        : null;

      const response = await chrome.runtime.sendMessage({
        type: "XHS_AI_SUMMARIZE_PAGE",
        payload,
        force: Boolean(force),
        pageSessionId,
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
      const doneMessage = {
        type: "XHS_AI_MERGE_CAPTURE_DONE",
        pageSessionId,
        pageUrl: location.href,
        noteId: payload.source?.noteId || null,
        detail
      };
      const noteTitle = currentNoteTitle();
      if (noteTitle) doneMessage.noteTitle = noteTitle;
      await chrome.runtime.sendMessage(doneMessage).catch(() => {});
      return {
        ok: true,
        payload,
        topLevelCount: captured.topLevelCount,
        imageCount: captured.imageCount
      };
    }

    async function notifyWorkflowFailure(error) {
      const detail = error?.message || "未知错误";
      const failureMessage = {
        type: "XHS_AI_WORKFLOW_FAILED",
        pageSessionId,
        pageUrl: location.href,
        noteId: getNoteId(),
        error: detail
      };
      const noteTitle = currentNoteTitle();
      if (noteTitle) failureMessage.noteTitle = noteTitle;
      await chrome.runtime.sendMessage(failureMessage).catch(() => {});
      return detail;
    }

    // 同一页面同一时间只允许一个采集/概括任务：面板会按页签禁用按钮，
    // 这里兜底拒绝并发请求，避免两次采集在同一页面互相踩踏。
    let activeOperation = null;
    const PAGE_BUSY_MESSAGE = "当前页面已有任务在进行，请等它完成后再试。";

    function beginOperation(start) {
      if (activeOperation) return null;
      const operation = start();
      const tracked = operation.finally(() => {
        if (activeOperation === tracked) activeOperation = null;
      });
      activeOperation = tracked;
      return tracked;
    }

    function startMessageListener() {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type === "XHS_PAGE_CONTEXT") {
          sendResponse({
            ok: true,
            pageSessionId,
            pageUrl: location.href,
            noteId: getNoteId(),
            // 帖文详情 DOM 是否已渲染：链接概括流据此判断页签可以开始采集
            detailReady: typeof getDetailReady === "function" ? Boolean(getDetailReady()) : true
          });
          return false;
        }

        if (!message || !["XHS_CAPTURE_AND_SUMMARIZE", "XHS_CAPTURE_FOR_MERGE"].includes(message.type)) {
          return undefined;
        }

        const operation = message.type === "XHS_CAPTURE_FOR_MERGE"
          ? beginOperation(() => runCaptureForMerge(message.options))
          : beginOperation(() => runCaptureAndSummarize(message.options, message.payload, message.force, message.givenUrl));
        if (!operation) {
          sendResponse({ ok: false, error: PAGE_BUSY_MESSAGE });
          return true;
        }
        operation
          .then(sendResponse)
          .catch(async (error) => {
            await notifyWorkflowFailure(error);
            sendResponse({ ok: false, error: error?.message || "未知错误" });
          });

        return true;
      });
    }

    return { sendProgress, startMessageListener };
  }

  globalThis.XhsCaptureCommon = Object.freeze({
    cleanText,
    httpsMediaUrl,
    ensurePageSessionId,
    createCaptureWorkflow
  });
})();
