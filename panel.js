const LIMIT = 50;
const LOGIN_REQUIRED_MESSAGE = "检测到当前小红书页面尚未登录。请先登录并刷新帖文详情页，再点击“提取并概括”。";
const WEIBO_LOGIN_REQUIRED_MESSAGE = "检测到当前微博页面尚未登录。请先登录 weibo.com 并刷新帖文页面，再点击“提取并概括”。";

const elements = {
  extractButton: document.querySelector("#extract-button"),
  buttonLabel: document.querySelector(".button-label"),
  settingsButton: document.querySelector("#settings-button"),
  statusCard: document.querySelector("#status-card"),
  statusTitle: document.querySelector("#status-title"),
  statusDetail: document.querySelector("#status-detail"),
  statusCount: document.querySelector("#status-count"),
  progressBar: document.querySelector("#progress-bar"),
  resultCard: document.querySelector("#result-card"),
  resultText: document.querySelector("#result-text"),
  resultTime: document.querySelector("#result-time"),
  evidenceSummary: document.querySelector("#evidence-summary"),
  copyButton: document.querySelector("#copy-button"),
  regenerateButton: document.querySelector("#regenerate-button"),
  mergeAddButton: document.querySelector("#merge-add-button"),
  mergeUploadButton: document.querySelector("#merge-upload-button"),
  screenshotInput: document.querySelector("#screenshot-input"),
  screenshotUrl: document.querySelector("#screenshot-url"),
  mergeList: document.querySelector("#merge-list"),
  mergeSummarizeButton: document.querySelector("#merge-summarize-button"),
  mergeSummarizeLabel: document.querySelector("#merge-summarize-label"),
  mergeClearButton: document.querySelector("#merge-clear-button"),
  tabSingle: document.querySelector("#tab-single"),
  tabMerge: document.querySelector("#tab-merge"),
  viewSingle: document.querySelector("#view-single"),
  viewMerge: document.querySelector("#view-merge"),
  shotSingleUpload: document.querySelector("#shot-single-upload"),
  shotSingleInput: document.querySelector("#shot-single-input"),
  shotSingleUrl: document.querySelector("#shot-single-url")
};

let currentCapture = null;
let isWorking = false;
let currentPageContext = null;
let basketItems = [];
let lastResultMode = "single";
let currentView = "single";

function switchView(view) {
  currentView = view === "merge" ? "merge" : "single";
  elements.tabSingle.dataset.active = currentView === "single" ? "true" : "false";
  elements.tabMerge.dataset.active = currentView === "merge" ? "true" : "false";
  elements.viewSingle.hidden = currentView !== "single";
  elements.viewMerge.hidden = currentView !== "merge";
  // 状态卡两个视图共用：单条视图紧贴“提取并概括”按钮，合并视图挂在合并面板之后
  if (currentView === "merge") {
    elements.viewMerge.appendChild(elements.statusCard);
  } else {
    elements.extractButton.after(elements.statusCard);
  }
  try {
    void chrome.storage?.local?.set?.({ xhsPanelView: currentView })?.catch?.(() => {});
  } catch {
    // storage 不可用时仅影响视图记忆
  }
}

async function restoreStoredView() {
  try {
    const stored = await chrome.storage?.local?.get?.("xhsPanelView");
    if (stored?.xhsPanelView) switchView(stored.xhsPanelView);
  } catch {
    // 保持默认视图
  }
}

function setStatus({ state = "idle", title, detail, percent = 0, count = null }) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  elements.statusCard.dataset.state = state;
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.statusCount.textContent = count == null ? `${safePercent}%` : `${Math.min(count, LIMIT)} / ${LIMIT}`;
  elements.progressBar.style.width = `${safePercent}%`;
}

function setWorking(working) {
  isWorking = working;
  elements.extractButton.disabled = working;
  elements.regenerateButton.disabled = working;
  elements.mergeAddButton.disabled = working;
  elements.mergeUploadButton.disabled = working;
  elements.mergeSummarizeButton.disabled = working;
  elements.buttonLabel.textContent = working ? "正在处理…" : "提取并概括";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

function detectPostPlatform(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname === "weibo.com" || parsed.hostname.endsWith(".weibo.com")) {
      return /^\/\d+\/[0-9A-Za-z]+\/?$/.test(parsed.pathname) ? "weibo" : null;
    }
    if (parsed.hostname.endsWith("xiaohongshu.com")) {
      return /\/explore\/[0-9a-f]{24}/i.test(parsed.pathname) ? "xiaohongshu" : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function hasLoginCookie(url, name) {
  const session = await chrome.cookies.get({ url, name });
  return Boolean(session?.value);
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function showResult(result, capture) {
  currentCapture = capture || null;
  lastResultMode = capture ? "single" : "merge";
  elements.resultText.value = result.text;
  elements.resultTime.textContent = formatTime(result.createdAt);
  const evidence = result.evidence || {};
  const notificationLabel = result.notification?.status === "sent"
    ? "飞书已推送"
    : result.notification?.status === "failed"
      ? "飞书推送失败"
      : null;
  const postNote = evidence.postCount ? `${evidence.postCount} 条帖文` : null;
  elements.evidenceSummary.textContent = [
    postNote,
    `${evidence.topLevelComments || 0} 条一级评论`,
    `${evidence.visibleReplies || 0} 条已显示回复`,
    `${evidence.imagesAnalyzed || 0} / ${evidence.imagesFound || 0} 张图片完成识别`,
    `文字模型 ${evidence.textModel || "—"}`,
    notificationLabel
  ].filter(Boolean).join(" · ");
  elements.resultCard.hidden = false;
}

function completionDetail(result, fallback) {
  if (result?.notification?.status === "sent") return "概括已生成，并已推送到飞书。";
  if (result?.notification?.status === "failed") {
    return `概括已生成；飞书推送失败：${result.notification.error || "请检查设置。"}`;
  }
  return fallback;
}

async function prepareCurrentPage() {
  const tab = await getActiveTab();
  const platform = detectPostPlatform(tab?.url || "");
  if (!tab?.id || !platform) {
    throw new Error("请先打开小红书或微博帖文详情页，再点击提取并概括。");
  }
  if (platform === "xiaohongshu") {
    if (!(await hasLoginCookie(tab.url, "web_session"))) {
      throw new Error(LOGIN_REQUIRED_MESSAGE);
    }
    // 主世界桥接脚本读取小红书页面的 __INITIAL_STATE__（视频流与字幕地址），
    // 失败时内容脚本会退回解析 SSR 内联脚本，因此这里允许失败。
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["main-world.js"], world: "MAIN" }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] });
  } else {
    if (!(await hasLoginCookie("https://weibo.com", "SUB"))) {
      throw new Error(WEIBO_LOGIN_REQUIRED_MESSAGE);
    }
    // 微博采集走页面同源的 /ajax/ 接口，内容脚本直接携带会话 Cookie，无需主世界桥接。
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["weibo-content-script.js"] });
  }
  const context = await chrome.tabs.sendMessage(tab.id, { type: "XHS_PAGE_CONTEXT" });
  if (!context?.ok || !context.pageSessionId) {
    throw new Error(context?.error || "无法确认当前页面状态，请刷新后重试。");
  }
  currentPageContext = { tabId: tab.id, ...context };
  return currentPageContext;
}

async function startPageWorkflow(payload = null, force = false) {
  const page = await prepareCurrentPage();
  const response = await chrome.tabs.sendMessage(page.tabId, {
    type: "XHS_CAPTURE_AND_SUMMARIZE",
    options: { limit: LIMIT },
    payload,
    force
  });
  if (!response?.ok) throw new Error(response?.error || "概括未完成。");
  showResult(response.result, response.capture || payload);
  return response;
}

function workflowMatchesCurrentPage(workflow) {
  return Boolean(
    workflow &&
    currentPageContext &&
    workflow.tabId === currentPageContext.tabId &&
    workflow.pageSessionId === currentPageContext.pageSessionId &&
    workflow.pageUrl === currentPageContext.pageUrl
  );
}

function applyWorkflowState(workflow) {
  if (!workflowMatchesCurrentPage(workflow)) return false;
  currentCapture = workflow.capture || currentCapture;
  const progress = workflow.progress || {};
  if (workflow.status === "done" && workflow.result) {
    lastResultMode = "single";
    showResult(workflow.result, currentCapture);
    setWorking(false);
    setStatus({
      state: "done",
      title: progress.title || "概括完成",
      detail: progress.detail || "已按固定格式生成，可直接复制。",
      percent: 100
    });
    return true;
  }
  if (workflow.status === "done" && !workflow.result) {
    setWorking(false);
    setStatus({
      state: "done",
      title: progress.title || "已采集完成",
      detail: progress.detail || "页面证据采集完成，可回到插件继续操作。",
      percent: 100
    });
    return true;
  }
  if (workflow.status === "error") {
    setWorking(false);
    setStatus({
      state: "error",
      title: progress.title || "未能完成",
      detail: progress.detail || workflow.error || "发生未知错误。",
      percent: progress.percent || 0
    });
    return true;
  }
  setWorking(true);
  setStatus({
    state: "working",
    title: progress.title || "正在处理",
    detail: progress.detail || "正在恢复当前任务状态…",
    percent: progress.percent || 3,
    count: progress.count
  });
  return true;
}

async function runFullWorkflow() {
  setWorking(true);
  setStatus({ state: "working", title: "正在连接页面", detail: "检查当前帖文详情页…", percent: 3 });
  try {
    const response = await startPageWorkflow(null, false);
    setStatus({
      state: "done",
      title: "概括完成",
      detail: completionDetail(response.result, "已按固定格式生成，可直接复制。"),
      percent: 100
    });
  } catch (error) {
    setStatus({ state: "error", title: "未能完成", detail: error?.message || "发生未知错误。", percent: 0 });
  } finally {
    setWorking(false);
  }
}

function mergeProgressTitle(stage) {
  if (stage === "vision") return "正在识别图片";
  if (stage === "text") return "正在撰写合并概括";
  if (stage === "notification") return "正在推送飞书";
  return "正在合并概括";
}

function renderBasket() {
  elements.mergeList.innerHTML = basketItems.map((item) => {
    const isShot = item.kind === "user_screenshot";
    const isWeibo = !isShot && item.platform === "weibo";
    const badgeLabel = isShot ? "截图" : isWeibo ? "微博" : "网页";
    const badgeClass = isShot ? "merge-badge-shot" : isWeibo ? "merge-badge-weibo" : "merge-badge-page";
    const label = [item.author || "未知账号", item.title].filter(Boolean).join("：");
    const meta = `${item.isVideo ? "视频 · " : ""}${item.commentCount || 0} 条评论${item.hasUrl ? "" : " · 无链接"}`;
    return `<li class="merge-item" data-id="${escapeHtml(item.id)}">` +
      `<span class="merge-badge ${badgeClass}">${badgeLabel}</span>` +
      `<span class="merge-item-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>` +
      `<span class="merge-item-meta">${escapeHtml(meta)}</span>` +
      `<button class="merge-remove" type="button" title="移除">✕</button>` +
      "</li>";
  }).join("");
  elements.mergeList.hidden = basketItems.length === 0;
  elements.mergeClearButton.hidden = basketItems.length === 0;
  elements.mergeSummarizeButton.hidden = basketItems.length === 0;
  elements.mergeSummarizeLabel.textContent = basketItems.length > 1
    ? `合并概括（${basketItems.length} 条帖文）`
    : "概括这条帖文";
}

async function refreshBasket() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_LIST" });
    basketItems = response?.ok ? response.basket || [] : [];
  } catch {
    basketItems = [];
  }
  renderBasket();
}

async function addCurrentPostToBasket() {
  if (isWorking) return;
  setWorking(true);
  setStatus({ state: "working", title: "正在采集帖文", detail: "读取正文与评论，图片识别将同步进行…", percent: 5 });
  try {
    const page = await prepareCurrentPage();
    const response = await chrome.tabs.sendMessage(page.tabId, {
      type: "XHS_CAPTURE_FOR_MERGE",
      options: { limit: LIMIT }
    });
    if (!response?.ok || !response.payload) throw new Error(response?.error || "采集未完成。");
    const added = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_ADD", payload: response.payload });
    if (!added?.ok) throw new Error(added?.error || "加入清单失败。");
    basketItems = added.basket || [];
    renderBasket();
    setStatus({
      state: "done",
      title: added.replaced ? "已替换清单中的同一条帖文" : "已加入合并清单",
      detail: `当前清单共 ${basketItems.length} 条帖文，可继续加入或直接合并概括。`,
      percent: 100
    });
  } catch (error) {
    setStatus({ state: "error", title: "未能加入清单", detail: error?.message || "发生未知错误。", percent: 0 });
  } finally {
    setWorking(false);
  }
}

async function removeBasketItem(id) {
  if (isWorking) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_REMOVE", id });
    if (!response?.ok) throw new Error(response?.error || "移除失败。");
    basketItems = response.basket || [];
    renderBasket();
  } catch (error) {
    setStatus({ state: "error", title: "移除失败", detail: error?.message || "发生未知错误。", percent: 0 });
  }
}

async function clearBasket() {
  if (isWorking || !basketItems.length) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_CLEAR" });
    if (!response?.ok) throw new Error(response?.error || "清空失败。");
  } catch (error) {
    setStatus({ state: "error", title: "清空失败", detail: error?.message || "发生未知错误。", percent: 0 });
    return;
  }
  basketItems = [];
  renderBasket();
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败。`));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法解析，请确认文件未损坏。"));
    image.src = dataUrl;
  });
}

// 控制发往后台的消息体积：长边超过 1600px 的截图等比缩小后转 JPEG。
async function downscaleDataUrl(dataUrl, maxEdge = 1600) {
  const image = await loadImageElement(dataUrl);
  const longest = Math.max(image.naturalWidth || 0, image.naturalHeight || 0);
  if (!longest || longest <= maxEdge) return dataUrl;
  const scale = maxEdge / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

async function addScreenshotImagesToBasket(images, sourceUrl) {
  const response = await chrome.runtime.sendMessage({
    type: "XHS_AI_SCREENSHOT_ADD",
    images,
    sourceUrl
  });
  if (!response?.ok) throw new Error(response?.error || "截图识别失败。");
  basketItems = response.basket || [];
  renderBasket();
  const warningNote = response.warnings?.length
    ? `；${response.warnings.length} 项信息未能完全识别（如时间、互动数）`
    : "";
  setStatus({
    state: "done",
    title: "截图已识别并加入清单",
    detail: `当前清单共 ${basketItems.length} 条帖文${warningNote}。`,
    percent: 100
  });
  elements.screenshotUrl.value = "";
}

async function summarizeScreenshotImages(images, sourceUrl) {
  const recognized = await chrome.runtime.sendMessage({
    type: "XHS_AI_SCREENSHOT_RECOGNIZE",
    images,
    sourceUrl
  });
  if (!recognized?.ok || !recognized.payload) throw new Error(recognized?.error || "截图识别失败。");
  setStatus({ state: "working", title: "正在撰写概括", detail: "截图证据已就绪，正在生成概括…", percent: 66 });
  const response = await chrome.runtime.sendMessage({
    type: "XHS_AI_SUMMARIZE",
    payload: recognized.payload,
    force: false
  });
  if (!response?.ok) throw new Error(response?.error || "概括未完成。");
  showResult(response.result, recognized.payload);
  const warningNote = recognized.warnings?.length
    ? `；${recognized.warnings.length} 项信息未能完全识别（如时间、互动数）`
    : "";
  setStatus({
    state: "done",
    title: "截图概括完成",
    detail: completionDetail(response.result, "已按固定格式生成，可直接复制。") + warningNote,
    percent: 100
  });
  elements.shotSingleUrl.value = "";
}

async function uploadScreenshots(files) {
  if (isWorking || !files?.length) return;
  const sourceUrlInput = currentView === "merge" ? elements.screenshotUrl : elements.shotSingleUrl;
  setWorking(true);
  setStatus({ state: "working", title: "正在识别截图", detail: `共 ${files.length} 张截图，正在提取帖文内容…`, percent: 15 });
  try {
    const images = [];
    for (const file of files) {
      if (file.size > 12 * 1024 * 1024) throw new Error(`${file.name} 超过 12 MB，请压缩后重试。`);
      images.push(await downscaleDataUrl(await readImageFile(file)));
    }
    if (currentView === "merge") {
      await addScreenshotImagesToBasket(images, sourceUrlInput.value.trim());
    } else {
      await summarizeScreenshotImages(images, sourceUrlInput.value.trim());
    }
  } catch (error) {
    setStatus({ state: "error", title: "截图识别失败", detail: error?.message || "发生未知错误。", percent: 0 });
  } finally {
    elements.screenshotInput.value = "";
    elements.shotSingleInput.value = "";
    setWorking(false);
  }
}

async function runMergeSummarize(force = false) {
  if (isWorking || !basketItems.length) return;
  setWorking(true);
  setStatus({
    state: "working",
    title: "正在合并概括",
    detail: `整合 ${basketItems.length} 条帖文的证据…`,
    percent: 8
  });
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_SUMMARIZE", force: Boolean(force) });
    if (!response?.ok) throw new Error(response?.error || "合并概括未完成。");
    showResult(response.result, null);
    setStatus({
      state: "done",
      title: force ? "重新生成完成" : "合并概括完成",
      detail: completionDetail(response.result, `已合并 ${response.result.postCount || basketItems.length} 条帖文，可直接复制。`),
      percent: 100
    });
  } catch (error) {
    setStatus({ state: "error", title: "合并概括失败", detail: error?.message || "发生未知错误。", percent: 0 });
  } finally {
    setWorking(false);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "XHS_AI_WORKFLOW_STATE") applyWorkflowState(message.workflow);
  if (message?.type === "XHS_AI_MERGE_PROGRESS" && isWorking) {
    const progress = message.progress || {};
    setStatus({
      state: "working",
      title: mergeProgressTitle(progress.stage),
      detail: progress.detail || "正在处理…",
      percent: progress.percent || 8
    });
  }
});

elements.extractButton.addEventListener("click", runFullWorkflow);
elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.tabSingle.addEventListener("click", () => switchView("single"));
elements.tabMerge.addEventListener("click", () => switchView("merge"));
elements.mergeAddButton.addEventListener("click", addCurrentPostToBasket);
elements.mergeUploadButton.addEventListener("click", () => elements.screenshotInput.click());
elements.shotSingleUpload.addEventListener("click", () => elements.shotSingleInput.click());
elements.screenshotInput.addEventListener("change", () => {
  uploadScreenshots(Array.from(elements.screenshotInput.files || []));
});
elements.shotSingleInput.addEventListener("change", () => {
  uploadScreenshots(Array.from(elements.shotSingleInput.files || []));
});
elements.mergeSummarizeButton.addEventListener("click", () => runMergeSummarize(false));
elements.mergeClearButton.addEventListener("click", clearBasket);
elements.mergeList.addEventListener("click", (event) => {
  const row = event.target?.closest?.(".merge-item");
  if (!row || !event.target.closest?.(".merge-remove")) return;
  removeBasketItem(row.dataset?.id);
});

elements.copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.resultText.value);
    elements.copyButton.textContent = "已复制";
    setTimeout(() => { elements.copyButton.textContent = "复制概括"; }, 1400);
  } catch {
    elements.resultText.select();
    document.execCommand("copy");
  }
});

elements.regenerateButton.addEventListener("click", async () => {
  if (isWorking) return;
  if (lastResultMode === "merge") {
    await runMergeSummarize(true);
    return;
  }
  if (!currentCapture) {
    await runFullWorkflow();
    return;
  }
  setWorking(true);
  setStatus({ state: "working", title: "正在重新生成", detail: "复用页面与图片证据，重新调用文字模型…", percent: 66 });
  try {
    const response = await startPageWorkflow(currentCapture, true);
    setStatus({
      state: "done",
      title: "重新生成完成",
      detail: completionDetail(response.result, "新版本已替换原概括。"),
      percent: 100
    });
  } catch (error) {
    setStatus({ state: "error", title: "重新生成失败", detail: error?.message || "发生未知错误。", percent: 66 });
  } finally {
    setWorking(false);
  }
});

async function restoreCurrentWorkflow() {
  try {
    const page = await prepareCurrentPage();
    const response = await chrome.runtime.sendMessage({
      type: "XHS_AI_GET_WORKFLOW",
      tabId: page.tabId,
      pageSessionId: page.pageSessionId,
      pageUrl: page.pageUrl
    });
    if (response?.ok && response.workflow) {
      applyWorkflowState(response.workflow);
      return;
    }
  } catch {
    return;
  }
  setWorking(false);
}

restoreCurrentWorkflow();
switchView("single");
restoreStoredView();
refreshBasket();
