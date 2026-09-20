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
  mergeDropzone: document.querySelector("#merge-dropzone"),
  screenshotStaging: document.querySelector("#screenshot-staging"),
  screenshotRun: document.querySelector("#screenshot-run"),
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
  shotSingleDropzone: document.querySelector("#shot-single-dropzone"),
  shotSingleStaging: document.querySelector("#shot-single-staging"),
  shotSingleRun: document.querySelector("#shot-single-run"),
  shotSingleInput: document.querySelector("#shot-single-input"),
  shotSingleUrl: document.querySelector("#shot-single-url")
};

let isWorking = false;
let currentPageContext = null;
let basketItems = [];
let currentView = "single";

// 状态与概括结果归属产生它们的页签：合并结果只出现在合并页签，单条结果只出现在单条页签。
const DEFAULT_STATUS = {
  single: { state: "idle", title: "准备就绪", detail: "请先打开一个小红书帖文详情页。", percent: 0 },
  merge: { state: "idle", title: "准备就绪", detail: "把帖文加入清单后，即可一键合并概括。", percent: 0 }
};
const viewState = {
  single: { status: null, result: null, capture: null },
  merge: { status: null, result: null }
};

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
  applyViewOutput(currentView);
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

function renderStatus(status) {
  const safePercent = Math.max(0, Math.min(100, Number(status.percent) || 0));
  elements.statusCard.dataset.state = status.state;
  elements.statusTitle.textContent = status.title;
  elements.statusDetail.textContent = status.detail;
  elements.statusCount.textContent = status.count == null ? `${safePercent}%` : `${Math.min(status.count, LIMIT)} / ${LIMIT}`;
  elements.progressBar.style.width = `${safePercent}%`;
}

// mode 缺省为当前页签；后台推送（工作流进度、合并进度）必须显式指定归属页签。
function setStatus(status, mode = currentView) {
  const slot = viewState[mode];
  if (!slot) return;
  slot.status = { ...status };
  if (mode === currentView) renderStatus(slot.status);
}

// 切换页签时重放该页签自己的状态与结果；没有结果就隐藏结果卡。
function applyViewOutput(mode) {
  const slot = viewState[mode];
  renderStatus(slot.status || DEFAULT_STATUS[mode]);
  if (slot.result) {
    renderResult(slot.result);
  } else {
    elements.resultCard.hidden = true;
    elements.resultText.value = "";
  }
}

function setWorking(working) {
  isWorking = working;
  elements.extractButton.disabled = working;
  elements.regenerateButton.disabled = working;
  elements.mergeAddButton.disabled = working;
  elements.screenshotRun.disabled = working;
  elements.shotSingleRun.disabled = working;
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

function renderResult(result) {
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

// capture 非空为单条结果，否则为合并结果；结果只渲染在归属页签上。
function showResult(result, capture, mode = capture ? "single" : "merge") {
  const slot = viewState[mode];
  if (!slot) return;
  slot.result = result;
  if (mode === "single") slot.capture = capture || null;
  if (mode === currentView) renderResult(result);
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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture-common.js", "content-script.js"] });
  } else {
    if (!(await hasLoginCookie("https://weibo.com", "SUB"))) {
      throw new Error(WEIBO_LOGIN_REQUIRED_MESSAGE);
    }
    // 微博采集走页面同源的 /ajax/ 接口，内容脚本直接携带会话 Cookie，无需主世界桥接。
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture-common.js", "weibo-content-script.js"] });
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
  if (workflow.capture) viewState.single.capture = workflow.capture;
  const progress = workflow.progress || {};
  if (workflow.status === "done" && workflow.result) {
    showResult(workflow.result, viewState.single.capture, "single");
    setWorking(false);
    setStatus({
      state: "done",
      title: progress.title || "概括完成",
      detail: progress.detail || "已按固定格式生成，可直接复制。",
      percent: 100
    }, "single");
    return true;
  }
  if (workflow.status === "done" && !workflow.result) {
    setWorking(false);
    setStatus({
      state: "done",
      title: progress.title || "已采集完成",
      detail: progress.detail || "页面证据采集完成，可回到插件继续操作。",
      percent: 100
    }, "single");
    return true;
  }
  if (workflow.status === "error") {
    setWorking(false);
    setStatus({
      state: "error",
      title: progress.title || "未能完成",
      detail: progress.detail || workflow.error || "发生未知错误。",
      percent: progress.percent || 0
    }, "single");
    return true;
  }
  setWorking(true);
  setStatus({
    state: "working",
    title: progress.title || "正在处理",
    detail: progress.detail || "正在恢复当前任务状态…",
    percent: progress.percent || 3,
    count: progress.count
  }, "single");
  return true;
}

async function runFullWorkflow() {
  setWorking(true);
  setStatus({ state: "working", title: "正在连接页面", detail: "检查当前帖文详情页…", percent: 3 }, "single");
  try {
    const response = await startPageWorkflow(null, false);
    setStatus({
      state: "done",
      title: "概括完成",
      detail: completionDetail(response.result, "已按固定格式生成，可直接复制。"),
      percent: 100
    }, "single");
  } catch (error) {
    setStatus({ state: "error", title: "未能完成", detail: error?.message || "发生未知错误。", percent: 0 }, "single");
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
  setStatus({ state: "working", title: "正在采集帖文", detail: "读取正文与评论，图片识别将同步进行…", percent: 5 }, "merge");
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
    }, "merge");
  } catch (error) {
    setStatus({ state: "error", title: "未能加入清单", detail: error?.message || "发生未知错误。", percent: 0 }, "merge");
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
    setStatus({ state: "error", title: "移除失败", detail: error?.message || "发生未知错误。", percent: 0 }, "merge");
  }
}

async function clearBasket() {
  if (isWorking || !basketItems.length) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_CLEAR" });
    if (!response?.ok) throw new Error(response?.error || "清空失败。");
  } catch (error) {
    setStatus({ state: "error", title: "清空失败", detail: error?.message || "发生未知错误。", percent: 0 }, "merge");
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
  }, "merge");
  elements.screenshotUrl.value = "";
}

async function summarizeScreenshotImages(images, sourceUrl) {
  const recognized = await chrome.runtime.sendMessage({
    type: "XHS_AI_SCREENSHOT_RECOGNIZE",
    images,
    sourceUrl
  });
  if (!recognized?.ok || !recognized.payload) throw new Error(recognized?.error || "截图识别失败。");
  setStatus({ state: "working", title: "正在撰写概括", detail: "截图证据已就绪，正在生成概括…", percent: 66 }, "single");
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
  }, "single");
  elements.shotSingleUrl.value = "";
}

const ACCEPTED_SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];
const stagedScreenshots = { single: [], merge: [] };

// 点击拖放区、Ctrl+V 粘贴或拖入的图片都先进暂存区，凑齐同一条帖文的截图后由按钮统一提交识别。
async function stageScreenshotFiles(files) {
  if (!files?.length) return;
  const staged = stagedScreenshots[currentView];
  const failures = [];
  for (const file of files) {
    const label = file.name || "剪贴板图片";
    if (!ACCEPTED_SCREENSHOT_TYPES.includes(file.type)) {
      failures.push(`${label} 不是支持的图片格式（PNG / JPEG / WebP）。`);
      continue;
    }
    if (file.size > 12 * 1024 * 1024) {
      failures.push(`${label} 超过 12 MB，请压缩后重试。`);
      continue;
    }
    try {
      staged.push({
        id: `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: label,
        dataUrl: await downscaleDataUrl(await readImageFile(file))
      });
    } catch (error) {
      failures.push(error?.message || `读取 ${label} 失败。`);
    }
  }
  renderStaging();
  if (failures.length) {
    setStatus({
      state: "error",
      title: failures.length === files.length ? "截图未能添加" : "部分截图未能添加",
      detail: failures[0],
      percent: 0
    });
  }
}

function renderStaging() {
  for (const view of ["single", "merge"]) {
    const staged = stagedScreenshots[view];
    const list = view === "single" ? elements.shotSingleStaging : elements.screenshotStaging;
    const runButton = view === "single" ? elements.shotSingleRun : elements.screenshotRun;
    list.innerHTML = staged.map((item) => (
      `<li class="staging-item"><img src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(item.name)}">` +
      `<button class="staging-remove" type="button" data-id="${escapeHtml(item.id)}" aria-label="移除 ${escapeHtml(item.name)}">×</button></li>`
    )).join("");
    list.hidden = !staged.length;
    runButton.hidden = !staged.length;
    runButton.textContent = view === "single"
      ? (staged.length > 1 ? `识别这 ${staged.length} 张截图并概括` : "识别这张截图并概括")
      : (staged.length > 1 ? `识别这 ${staged.length} 张截图并加入清单` : "识别这张截图并加入清单");
  }
}

async function commitStagedScreenshots(view) {
  const staged = stagedScreenshots[view];
  if (isWorking || !staged.length) return;
  setWorking(true);
  setStatus({ state: "working", title: "正在识别截图", detail: `共 ${staged.length} 张截图，正在提取帖文内容…`, percent: 15 }, view);
  const committedIds = new Set(staged.map((item) => item.id));
  try {
    const images = staged.map((item) => item.dataUrl);
    const sourceUrlInput = view === "merge" ? elements.screenshotUrl : elements.shotSingleUrl;
    if (view === "merge") {
      await addScreenshotImagesToBasket(images, sourceUrlInput.value.trim());
    } else {
      await summarizeScreenshotImages(images, sourceUrlInput.value.trim());
    }
    // 只移除本次提交的截图：识别期间新贴入的图片保留在暂存区
    stagedScreenshots[view] = stagedScreenshots[view].filter((item) => !committedIds.has(item.id));
    renderStaging();
  } catch (error) {
    setStatus({ state: "error", title: "截图识别失败", detail: error?.message || "发生未知错误。", percent: 0 }, view);
  } finally {
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
  }, "merge");
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_SUMMARIZE", force: Boolean(force) });
    if (!response?.ok) throw new Error(response?.error || "合并概括未完成。");
    showResult(response.result, null);
    setStatus({
      state: "done",
      title: force ? "重新生成完成" : "合并概括完成",
      detail: completionDetail(response.result, `已合并 ${response.result.postCount || basketItems.length} 条帖文，可直接复制。`),
      percent: 100
    }, "merge");
  } catch (error) {
    setStatus({ state: "error", title: "合并概括失败", detail: error?.message || "发生未知错误。", percent: 0 }, "merge");
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
    }, "merge");
  }
});

elements.extractButton.addEventListener("click", runFullWorkflow);
elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.tabSingle.addEventListener("click", () => switchView("single"));
elements.tabMerge.addEventListener("click", () => switchView("merge"));
elements.mergeAddButton.addEventListener("click", addCurrentPostToBasket);
for (const [view, zone, input, runButton, stagingList] of [
  ["single", elements.shotSingleDropzone, elements.shotSingleInput, elements.shotSingleRun, elements.shotSingleStaging],
  ["merge", elements.mergeDropzone, elements.screenshotInput, elements.screenshotRun, elements.screenshotStaging]
]) {
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    stageScreenshotFiles(Array.from(input.files || []));
    input.value = "";
  });
  runButton.addEventListener("click", () => commitStagedScreenshots(view));
  stagingList.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".staging-remove");
    if (!button) return;
    stagedScreenshots[view] = stagedScreenshots[view].filter((item) => item.id !== button.dataset?.id);
    renderStaging();
  });
  zone.addEventListener("dragenter", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) zone.dataset.dragover = "true";
  });
  zone.addEventListener("dragleave", (event) => {
    if (!zone.contains(event.relatedTarget)) zone.dataset.dragover = "false";
  });
}

// 粘贴/拖入的图片与文件选择共用同一个暂存区；纯文本粘贴不拦截，链接输入框可正常贴 URL。
function imageFilesFromDataTransfer(dataTransfer) {
  return Array.from(dataTransfer?.files || []).filter((file) => file.type?.startsWith("image/"));
}

document.addEventListener("paste", (event) => {
  const files = imageFilesFromDataTransfer(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  stageScreenshotFiles(files);
});

document.addEventListener("dragover", (event) => {
  // 不阻止 dragover 默认行为，drop 不会触发
  if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
});

document.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  // 拦下浏览器“用拖入文件替换页面”的默认行为，再只挑图片进暂存区
  event.preventDefault();
  elements.shotSingleDropzone.dataset.dragover = "false";
  elements.mergeDropzone.dataset.dragover = "false";
  const files = imageFilesFromDataTransfer(event.dataTransfer);
  if (files.length) stageScreenshotFiles(files);
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
  // 结果卡只显示当前页签自己的结果，“重新生成”跟随当前页签。
  if (currentView === "merge") {
    await runMergeSummarize(true);
    return;
  }
  if (!viewState.single.capture) {
    await runFullWorkflow();
    return;
  }
  setWorking(true);
  setStatus({ state: "working", title: "正在重新生成", detail: "复用页面与图片证据，重新调用文字模型…", percent: 66 }, "single");
  try {
    const response = await startPageWorkflow(viewState.single.capture, true);
    setStatus({
      state: "done",
      title: "重新生成完成",
      detail: completionDetail(response.result, "新版本已替换原概括。"),
      percent: 100
    }, "single");
  } catch (error) {
    setStatus({ state: "error", title: "重新生成失败", detail: error?.message || "发生未知错误。", percent: 66 }, "single");
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
