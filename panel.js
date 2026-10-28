const LIMIT = 50;
const LOGIN_REQUIRED_MESSAGE = "检测到当前小红书页面尚未登录。请先登录并刷新帖文详情页，再点击“提取并概括”。";
const WEIBO_LOGIN_REQUIRED_MESSAGE = "检测到当前微博页面尚未登录。请先登录 weibo.com 并刷新帖文页面，再点击“提取并概括”。";
// 链接概括：等待短链跳转与帖文渲染的总时长和轮询间隔
const LINK_OPEN_TIMEOUT_MS = 25000;
const LINK_POLL_INTERVAL_MS = 600;
// 补链接后给用户的反馈：编辑过的结果无法自动替换时，链接仍已保存，不能当错误提示
const RELINK_UPDATED_HINT = "链接已更新（未重新推送飞书）。";
const RELINK_KEPT_HINT = "链接已记录，但概括正文编辑过，未能自动替换，请手动修改。";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const elements = {
  extractButton: document.querySelector("#extract-button"),
  buttonLabel: document.querySelector(".button-label"),
  settingsButton: document.querySelector("#settings-button"),
  taskStrip: document.querySelector("#task-strip"),
  taskList: document.querySelector("#task-list"),
  workspace: document.querySelector("#workspace"),
  currentPostBadge: document.querySelector("#current-post-badge"),
  currentPostLabel: document.querySelector("#current-post-label"),
  statusCard: document.querySelector("#status-card"),
  statusTitle: document.querySelector("#status-title"),
  statusDetail: document.querySelector("#status-detail"),
  statusCount: document.querySelector("#status-count"),
  progressBar: document.querySelector("#progress-bar"),
  mergeAddButton: document.querySelector("#merge-add-button"),
  materialInput: document.querySelector("#material-input"),
  materialLinkButton: document.querySelector("#material-link-button"),
  materialFeedback: document.querySelector("#material-feedback"),
  linkChoice: document.querySelector("#link-choice"),
  linkChoiceOptions: document.querySelector("#link-choice-options"),
  materialDropzone: document.querySelector("#material-dropzone"),
  materialStaging: document.querySelector("#material-staging"),
  shotSummarizeButton: document.querySelector("#shot-summarize-button"),
  shotBasketButton: document.querySelector("#shot-basket-button"),
  materialShotActions: document.querySelector("#material-shot-actions"),
  materialFileInput: document.querySelector("#material-file-input"),
  basketPanel: document.querySelector("#basket-panel"),
  basketCount: document.querySelector("#basket-count"),
  basketList: document.querySelector("#merge-list"),
  basketLinkEditor: document.querySelector("#basket-link-editor"),
  basketLinkEditorLabel: document.querySelector("#basket-link-editor-label"),
  basketLinkInput: document.querySelector("#basket-link-input"),
  basketLinkSave: document.querySelector("#basket-link-save"),
  basketLinkCancel: document.querySelector("#basket-link-cancel"),
  basketLinkHint: document.querySelector("#basket-link-hint"),
  basketSingleHint: document.querySelector("#basket-single-hint"),
  mergeSummarizeButton: document.querySelector("#merge-summarize-button"),
  mergeSummarizeLabel: document.querySelector("#merge-summarize-label"),
  mergeViewResultButton: document.querySelector("#merge-view-result-button"),
  mergeClearButton: document.querySelector("#merge-clear-button"),
  resultCard: document.querySelector("#result-card"),
  resultSourceLabel: document.querySelector("#result-source-label"),
  resultText: document.querySelector("#result-text"),
  resultTime: document.querySelector("#result-time"),
  resultLinkRow: document.querySelector("#result-link-row"),
  resultLinkDisplay: document.querySelector("#result-link-display"),
  resultLinkState: document.querySelector("#result-link-state"),
  resultLinkEdit: document.querySelector("#result-link-edit"),
  resultLinkEditor: document.querySelector("#result-link-editor"),
  resultLinkInput: document.querySelector("#result-link-input"),
  resultLinkSave: document.querySelector("#result-link-save"),
  resultLinkCancel: document.querySelector("#result-link-cancel"),
  resultLinkHint: document.querySelector("#result-link-hint"),
  resultAddBasketButton: document.querySelector("#result-add-basket-button"),
  copyButton: document.querySelector("#copy-button"),
  regenerateButton: document.querySelector("#regenerate-button"),
  sendFeishuButton: document.querySelector("#send-feishu-button"),
  feishuFeedback: document.querySelector("#feishu-feedback"),
  historyButton: document.querySelector("#history-button"),
  historyBackButton: document.querySelector("#history-back-button"),
  viewHistory: document.querySelector("#view-history"),
  historyHint: document.querySelector("#history-hint"),
  historyList: document.querySelector("#history-list"),
  historyClearButton: document.querySelector("#history-clear-button"),
  openSourceButton: document.querySelector("#open-source-button"),
  evidenceSummary: document.querySelector("#evidence-summary")
};

let basketItems = [];
let historyItems = [];
let historyEntry = null;
let historyVisible = false;
let focusBeforeHistory = { kind: "tab" };
// 唯一的结果焦点：最后发起操作的来源；切换浏览器页签时回到 tab。
let focus = { kind: "tab" };
let activeTabId = null;
let activeTabUrl = "";
let basketLinkEditingId = null;
let pendingLinkChoice = null;
let pendingResultLinkConfirm = null;
let pendingBasketLinkConfirm = null;
let resultLinkEditing = false;
let feishuConfigured = false;
let linkResolveToken = 0;
let historyClearResetTimer = null;
let historyHintResetTimer = null;
let lastMergeLinkChange = null;
const HISTORY_HINT_TEXT = "概括成功后保存在本机（最多 100 条，超出自动淘汰最旧），可随时回看与复制。";

// —— 并行任务模型 ——
// 每个任务独立运行、只禁用自己的按钮，互不阻塞：
//   page:<tabId>  页签级采集概括（提取并概括 / 重新生成 / 加入清单的采集阶段）
//   merge         合并概括
//   shot:single   截图识别概括
//   shot:merge    截图识别加入清单
const tasks = new Map();
const pageSlots = new Map();
const mergeSlot = { status: null, result: null };
const shotSlot = { status: null, result: null, capture: null };
let stagedScreenshots = [];

// 结果与状态只属于当前焦点：tab 跟随活动页签，shot 归截图任务，merge 归合并任务。
const DEFAULT_STATUS = {
  tab: { state: "idle", title: "准备就绪", detail: "请先打开帖文详情页。", percent: 0 },
  shot: { state: "idle", title: "准备就绪", detail: "选择或粘贴截图后，可识别并概括，或加入清单。", percent: 0 },
  merge: { state: "idle", title: "准备就绪", detail: "把帖文加入清单后，即可一键合并概括。", percent: 0 }
};

function applyViewVisibility() {
  elements.workspace.hidden = historyVisible;
  elements.viewHistory.hidden = !historyVisible;
  elements.historyButton.dataset.active = historyVisible ? "true" : "false";
}

function setFocus(kind) {
  focus = { kind };
  if (historyVisible) {
    historyVisible = false;
    applyViewVisibility();
  }
  renderFocus();
}

function currentSlot() {
  return activeTabId != null ? pageSlots.get(activeTabId) : null;
}

function focusedPayload() {
  if (focus.kind === "shot") return shotSlot.capture;
  if (focus.kind === "tab") return currentSlot()?.capture || null;
  return null;
}

function currentResult() {
  if (focus.kind === "shot") return shotSlot.result;
  if (focus.kind === "merge") return mergeSlot.result;
  return currentSlot()?.result || null;
}

function currentStatus() {
  if (focus.kind === "shot") return shotSlot.status || DEFAULT_STATUS.shot;
  if (focus.kind === "merge") return mergeSlot.status || DEFAULT_STATUS.merge;
  return currentSlot()?.status || DEFAULT_STATUS.tab;
}

function renderStatus(status) {
  const safePercent = Math.max(0, Math.min(100, Number(status.percent) || 0));
  elements.statusCard.dataset.state = status.state;
  elements.statusTitle.textContent = status.title;
  elements.statusDetail.textContent = status.detail;
  elements.statusCount.textContent = status.count == null ? `${safePercent}%` : `${Math.min(status.count, LIMIT)} / ${LIMIT}`;
  elements.progressBar.style.width = `${safePercent}%`;
}

function platformBadge(platform) {
  if (platform === "weibo") return { label: "微博", className: "merge-badge-weibo" };
  if (platform === "xiaohongshu") return { label: "小红书", className: "merge-badge-page" };
  return null;
}

// 当前帖文：跟随浏览器活动页签；尚未采集时只显示平台徽标。
function renderCurrentPost() {
  const slot = currentSlot();
  const platform = currentPostPlatform() || (slot?.context?.pageUrl ? detectPostPlatform(slot.context.pageUrl) : null);
  const badge = platformBadge(platform);
  elements.currentPostBadge.hidden = !badge;
  if (badge) {
    elements.currentPostBadge.textContent = badge.label;
    elements.currentPostBadge.className = `merge-badge ${badge.className}`;
  }
  // 帖文页只显示平台徽标：提取到的标题/正文已经进入结果卡，不再在按钮上方重复铺开
  elements.currentPostLabel.textContent = platform
    ? ""
    : "打开小红书或微博帖文详情页后可在此提取。";
  elements.currentPostLabel.hidden = Boolean(platform);
}

function renderEvidence(result) {
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
}

// 合并结果是否仍对应当前清单：条目集合变化后只能作为「上次合并」查看
function mergeResultMatchesBasket(result) {
  if (!result?.itemIds) return true;
  const current = basketItems.map((item) => item.id).sort();
  const recorded = result.itemIds.slice().sort();
  return current.length === recorded.length &&
    current.every((id, index) => id === recorded[index]);
}

function resultSourceLabel(result) {
  if (focus.kind === "merge") {
    const count = result.postCount || result.evidence?.postCount || basketItems.length;
    return `${mergeResultMatchesBasket(result) ? "合并" : "上次合并"} ${count} 条`;
  }
  return focus.kind === "shot" ? "截图" : "当前页签";
}

function renderResult(result) {
  elements.resultText.value = result.text;
  elements.resultTime.textContent = formatTime(result.createdAt);
  elements.resultSourceLabel.textContent = resultSourceLabel(result);
  renderEvidence(result);
  elements.regenerateButton.hidden = false;
  elements.openSourceButton.hidden = true;
  renderResultLink();
  refreshResultBasketButton();
  elements.resultCard.hidden = false;
  hideFeishuFeedback();
  refreshFeishuButton();
}

function hideResultCard() {
  elements.resultCard.hidden = true;
  elements.resultText.value = "";
  elements.resultLinkEditor.hidden = true;
  elements.resultLinkHint.hidden = true;
  resultLinkEditing = false;
  hideFeishuFeedback();
  refreshFeishuButton();
}

function renderFocus() {
  if (historyVisible) return;
  applyViewVisibility();
  renderCurrentPost();
  renderStatus(currentStatus());
  renderBasket();
  const result = currentResult();
  if (result) renderResult(result);
  else hideResultCard();
  refreshButtons();
}

// —— 任务列表：所有并行任务常驻可见，点击跳到对应页签或结果来源 ——

function pageTaskKey(tabId) {
  return `page:${tabId}`;
}

function setTask(key, patch) {
  tasks.set(key, { ...(tasks.get(key) || { key }), ...patch });
  renderTasks();
  refreshButtons();
}

function removeTask(key) {
  if (!tasks.delete(key)) return;
  renderTasks();
  refreshButtons();
}

function taskBadge(task) {
  if (task.kind === "merge") return { label: "合并", className: "merge-badge-merge" };
  if (task.kind === "shot") return { label: "截图", className: "merge-badge-shot" };
  if (task.platform === "weibo") return { label: "微博", className: "merge-badge-weibo" };
  return { label: "网页", className: "merge-badge-page" };
}

function renderTasks() {
  const items = [...tasks.values()];
  elements.taskStrip.hidden = items.length === 0;
  elements.taskList.innerHTML = items.map((task) => {
    const badge = taskBadge(task);
    const label = task.title || "正在处理";
    const meta = task.count != null
      ? `${Math.min(task.count, LIMIT)} / ${LIMIT}`
      : `${Math.max(0, Math.min(100, Number(task.percent) || 0))}%`;
    return `<li class="merge-item task-item" data-key="${escapeHtml(task.key)}">` +
      `<span class="task-spinner" aria-hidden="true"></span>` +
      `<span class="merge-item-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>` +
      `<span class="merge-badge ${badge.className}">${badge.label}</span>` +
      `<span class="merge-item-meta">${escapeHtml(meta)}</span>` +
      "</li>";
  }).join("");
}

// —— 按钮只跟随自己的任务与当前焦点 ——

function refreshButtons() {
  const tabBusy = activeTabId != null && tasks.has(pageTaskKey(activeTabId));
  const postPage = Boolean(currentPostPlatform());
  elements.extractButton.disabled = tabBusy || !postPage;
  elements.buttonLabel.textContent = tabBusy ? "正在处理…" : "提取并概括";
  elements.mergeAddButton.disabled = tabBusy || !postPage;
  elements.materialLinkButton.disabled = tasks.has("link");
  elements.shotSummarizeButton.disabled = tasks.has("shot:single");
  elements.shotBasketButton.disabled = tasks.has("shot:merge");
  elements.mergeSummarizeButton.disabled = tasks.has("merge") || basketItems.length < 2;
  const focusedTaskBusy = focus.kind === "merge"
    ? tasks.has("merge")
    : focus.kind === "shot"
      ? tasks.has("shot:single")
      : tabBusy;
  elements.regenerateButton.disabled = focusedTaskBusy;
  if (!elements.resultAddBasketButton.hidden) {
    const payload = focusedPayload();
    const inBasket = basketHasPayload(payload);
    const needsCapture = !payload;
    elements.resultAddBasketButton.disabled = inBasket || (needsCapture && tabBusy);
  }
}

// —— 页签槽位：状态与结果按 Chrome 页签保存 ——

function touchPageSlot(tabId) {
  if (tabId == null) return null;
  let slot = pageSlots.get(tabId);
  if (!slot) {
    slot = {
      context: null,
      status: null,
      result: null,
      capture: null,
      pendingGivenUrl: null,
      pendingGivenUrlVerified: false
    };
    pageSlots.set(tabId, slot);
  }
  return slot;
}

function writePageStatus(tabId, status) {
  const slot = touchPageSlot(tabId);
  if (!slot) return;
  slot.status = status;
  if (focus.kind === "tab" && activeTabId === tabId && !historyVisible) renderStatus(status);
}

function writePageResult(tabId, result, capture) {
  const slot = touchPageSlot(tabId);
  if (!slot) return;
  slot.result = result;
  if (capture) slot.capture = capture;
  if (focus.kind === "tab" && activeTabId === tabId && !historyVisible) renderFocus();
  else renderCurrentPost();
}

// 页签切换时轻量校验旧槽位：内容脚本不在了（页面整体刷新）或页面会话变了，
// 旧进度/结果即作废；校验失败静默清槽，回到默认空状态。
async function validateTabSlot(tabId) {
  const slot = pageSlots.get(tabId);
  if (!slot) return;
  if (!slot.context) {
    // 还没提取过、只暂存了链接的槽位不因缺少页面上下文被清掉
    if (!slot.pendingGivenUrl) pageSlots.delete(tabId);
    return;
  }
  try {
    const context = await chrome.tabs.sendMessage(tabId, { type: "XHS_PAGE_CONTEXT" });
    if (!context?.ok ||
      context.pageSessionId !== slot.context.pageSessionId ||
      context.pageUrl !== slot.context.pageUrl) {
      pageSlots.delete(tabId);
    }
  } catch {
    pageSlots.delete(tabId);
  }
}

async function refreshActiveTabInfo(tabId) {
  if (tabId == null) {
    activeTabUrl = "";
    return;
  }
  try {
    if (typeof chrome.tabs.get === "function") {
      const tab = await chrome.tabs.get(tabId);
      activeTabUrl = String(tab?.url || "");
      return;
    }
  } catch {
    // 页签可能已经关闭，退回槽位里记录的页面地址
  }
  activeTabUrl = String(pageSlots.get(tabId)?.context?.pageUrl || "");
}

async function setActiveTab(tabId) {
  if (tabId == null) return;
  const changed = tabId !== activeTabId;
  activeTabId = tabId;
  await refreshActiveTabInfo(tabId);
  if (changed) {
    focus = { kind: "tab" };
    await validateTabSlot(tabId);
  }
  if (!historyVisible) renderFocus();
  else refreshButtons();
}

// —— 通用工具 ——

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
      // /discovery/item/ 是分享短链（xhslink.cn）的落地路径，与 /explore/ 同为帖文页
      return /\/(?:explore|discovery\/item)\/[0-9a-f]{24}/i.test(parsed.pathname) ? "xiaohongshu" : null;
    }
    return null;
  } catch {
    return null;
  }
}

function currentPostPlatform() {
  const fromUrl = detectPostPlatform(activeTabUrl);
  if (fromUrl) return fromUrl;
  const contextUrl = currentSlot()?.context?.pageUrl || "";
  return detectPostPlatform(contextUrl);
}

function noteIdFromUrlForPlatform(platform, url) {
  try {
    const pathname = new URL(url).pathname;
    if (platform === "weibo") return pathname.match(/^\/\d+\/([0-9A-Za-z]+)\/?$/)?.[1] || null;
    return pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i)?.[1] || null;
  } catch {
    return null;
  }
}

// 从分享文案或裸链接里提取第一条小红书/微博帖文链接；短链（xhslink.cn）整条接受，
// 长链要求是帖文地址，避免用户主页等链接进来白等超时。
function extractPostUrl(rawText) {
  const text = String(rawText || "");
  if (!text) return null;
  const candidates = [];
  for (const match of text.matchAll(/https?:\/\/\S+/gi)) {
    // 分享文案的链接常与中文黏在一起：URL 不含裸非 ASCII 字符，先截到首个非
    // ASCII，再去掉黏尾的 ASCII 标点（全角标点已在截断时处理）
    const ascii = (match[0].match(/[^\s\u0080-\uFFFF]+/) || [""])[0];
    let candidate = ascii.replace(/[)"'>\]}.,;:!]+$/, "");
    if (candidate) candidates.push(candidate);
  }
  for (const rawCandidate of candidates) {
    try {
      // 用户手输的短链常是 http://：小红书两域均支持 https，统一升级后再校验
      const parsed = new URL(rawCandidate.replace(/^http:\/\//i, "https://"));
      if (parsed.protocol !== "https:") continue;
      const host = parsed.hostname.toLowerCase();
      if (host === "xhslink.cn" || host.endsWith(".xhslink.cn")) return parsed.href;
      if ((host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")) &&
        detectPostPlatform(parsed.href) === "xiaohongshu") return parsed.href;
      if ((host === "weibo.com" || host.endsWith(".weibo.com")) &&
        detectPostPlatform(parsed.href) === "weibo") return parsed.href;
    } catch {
      // 无法解析的候选直接跳过
    }
  }
  return null;
}

function shortenLink(value) {
  try {
    const url = new URL(value);
    const text = `${url.hostname.replace(/^www\./, "")}${url.pathname}`;
    return text.length > 44 ? `${text.slice(0, 42)}…` : text;
  } catch {
    return String(value || "");
  }
}

function effectiveLink(payload) {
  return String(payload?.source?.givenUrl || payload?.source?.url || "");
}

function payloadItemId(payload) {
  const source = payload?.source;
  if (!source) return null;
  if (source.origin === "user_screenshot") return source.screenshotId ? `shot:${source.screenshotId}` : null;
  if (!source.noteId) return null;
  return `${source.platform === "weibo" ? "wbnote" : "note"}:${source.noteId}`;
}

function basketHasPayload(payload) {
  const id = payloadItemId(payload);
  return Boolean(id) && basketItems.some((item) => item.id === id);
}

function captureLabel(capture) {
  const title = String(capture?.note?.title || "").trim();
  if (title) return title;
  const author = String(capture?.note?.author || "").trim();
  return author ? `@${author}` : "";
}

function completionDetail(result, fallback) {
  if (result?.notification?.status === "sent") return "概括已生成，并已推送到飞书。";
  if (result?.notification?.status === "failed") {
    return `概括已生成；飞书推送失败：${result.notification.error || "请检查设置。"}`;
  }
  return fallback;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

// 历史列表条目的时间：同年省略年份，跨年带上年份
function formatHistoryTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("zh-CN", {
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function hasLoginCookie(url, name) {
  const session = await chrome.cookies.get({ url, name });
  return Boolean(session?.value);
}

// —— 页面采集 ——

async function injectCaptureScripts(tab, platform) {
  if (platform === "xiaohongshu") {
    // 主世界桥接脚本读取小红书页面的 __INITIAL_STATE__（视频流与字幕地址），
    // 失败时内容脚本会退回解析 SSR 内联脚本，因此这里允许失败。
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["main-world.js"], world: "MAIN" }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture-common.js", "content-script.js"] });
  } else {
    // 微博采集走页面同源的 /ajax/ 接口，内容脚本直接携带会话 Cookie，无需主世界桥接。
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture-common.js", "weibo-content-script.js"] });
  }
}

// 注入采集脚本并确认页面会话，返回该页签的采集任务信息
async function prepareTabPage(tab, platform) {
  if (platform === "xiaohongshu") {
    if (!(await hasLoginCookie(tab.url, "web_session"))) {
      throw new Error(LOGIN_REQUIRED_MESSAGE);
    }
  } else {
    if (!(await hasLoginCookie("https://weibo.com", "SUB"))) {
      throw new Error(WEIBO_LOGIN_REQUIRED_MESSAGE);
    }
  }
  await injectCaptureScripts(tab, platform);
  const context = await chrome.tabs.sendMessage(tab.id, { type: "XHS_PAGE_CONTEXT" });
  if (!context?.ok || !context.pageSessionId) {
    throw new Error(context?.error || "无法确认当前页面状态，请刷新后重试。");
  }
  return adoptTabPage(tab, platform, context);
}

// 把页面会话挂到页签槽位上。同一页面会话保留旧状态、结果与暂存链接；
// 换了页面会话则从头开始。
function adoptTabPage(tab, platform, context) {
  const slot = pageSlots.get(tab.id);
  const sameContext = Boolean(
    slot?.context &&
    slot.context.pageSessionId === context.pageSessionId &&
    slot.context.pageUrl === context.pageUrl
  );
  pageSlots.set(tab.id, {
    context: {
      tabId: tab.id,
      pageSessionId: context.pageSessionId,
      pageUrl: context.pageUrl,
      noteId: context.noteId ?? null
    },
    status: sameContext ? slot.status ?? null : null,
    result: sameContext ? slot.result ?? null : null,
    capture: sameContext ? slot.capture ?? null : null,
    // 先拿到链接、之后才提取时，链接要跟着这个页签继续用；页面已经换掉则丢弃旧链接
    pendingGivenUrl: sameContext || !slot?.context ? slot?.pendingGivenUrl ?? null : null,
    pendingGivenUrlVerified: Boolean((sameContext || !slot?.context) && slot?.pendingGivenUrlVerified)
  });
  return {
    tabId: tab.id,
    platform,
    pageSessionId: context.pageSessionId,
    pageUrl: context.pageUrl,
    noteId: context.noteId ?? null,
    detailReady: context.detailReady !== false
  };
}

async function prepareCurrentPage() {
  const tab = await getActiveTab();
  const platform = detectPostPlatform(tab?.url || "");
  if (!tab?.id || !platform) {
    const error = new Error("请先打开小红书或微博帖文详情页，再点击提取并概括。");
    error.tabId = tab?.id ?? null;
    throw error;
  }
  try {
    return await prepareTabPage(tab, platform);
  } catch (error) {
    // 失败状态要落到发起操作的页签上，调用方据此显示错误
    error.tabId = error.tabId ?? tab.id;
    throw error;
  } finally {
    if (tab.id != null) {
      activeTabId = tab.id;
      activeTabUrl = String(tab.url || activeTabUrl);
      refreshButtons();
    }
  }
}

async function sendCaptureAndSummarize(page, payload, force, givenUrl = null) {
  const response = await chrome.tabs.sendMessage(page.tabId, {
    type: "XHS_CAPTURE_AND_SUMMARIZE",
    options: { limit: LIMIT },
    payload,
    force,
    givenUrl
  });
  if (!response?.ok) throw new Error(response?.error || "概括未完成。");
  return response;
}

async function assertXhsLogin() {
  if (!(await hasLoginCookie("https://www.xiaohongshu.com/", "web_session"))) {
    throw new Error(LOGIN_REQUIRED_MESSAGE);
  }
}

// 链接概括可能打开微博帖文：按目标平台检查对应登录状态。
async function assertLinkLogin(givenUrl) {
  if (detectPostPlatform(givenUrl) === "weibo") {
    if (!(await hasLoginCookie("https://weibo.com", "SUB"))) {
      throw new Error(WEIBO_LOGIN_REQUIRED_MESSAGE);
    }
    return;
  }
  await assertXhsLogin();
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

// 等待链接页签落地到帖文页并完成渲染，返回采集任务信息。
// 短链会 302 到 /discovery/item/<id>（xsec_token 在 query 里），桌面端采集走的
// 已知路径是 /explore/<id>，遇到 discovery 落地页时把页签原样改写到 explore
// （query 原样保留，token 不丢），之后轮询详情 DOM 就绪。
async function waitLinkTabPage(tabId) {
  const deadline = Date.now() + LINK_OPEN_TIMEOUT_MS;
  let rewritten = false;
  let injected = false;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error("链接页签已被关闭，概括中止。");
    }
    const url = String(tab?.url || "");
    if (!rewritten && /^https?:\/\/[^/]*xiaohongshu\.com\/discovery\/item\//i.test(url)) {
      rewritten = true;
      injected = false;
      await chrome.tabs.update(tabId, { url: url.replace(/\/discovery\/item\//i, "/explore/") }).catch(() => {});
    } else if (detectPostPlatform(url)) {
      const platform = detectPostPlatform(url);
      if (!injected) {
        await injectCaptureScripts(tab, platform);
        injected = true;
      }
      let context = null;
      try {
        context = await chrome.tabs.sendMessage(tabId, { type: "XHS_PAGE_CONTEXT" });
      } catch {
        context = null;
      }
      if (context?.ok && context.pageSessionId && context.detailReady !== false) {
        return adoptTabPage(tab, platform, context);
      }
    }
    await sleep(LINK_POLL_INTERVAL_MS);
  }
  throw new Error("链接页已打开，但迟迟没有出现帖文内容（帖子可能已删除、仅自己可见，或链接不是帖文地址）。");
}

// 链接概括：贴入分享文案或短链 → 开新页签 → 复用页签级采集概括管线。
// 结果与状态挂在打开的页签槽位上，页签保留不关闭。
async function runLinkWorkflow(explicitUrl = null) {
  if (tasks.has("link")) return;
  const givenUrl = explicitUrl || extractPostUrl(elements.materialInput.value);
  if (!givenUrl) {
    showMaterialFeedback("输入里没有找到小红书或微博帖文链接。", "error");
    return;
  }
  focus = { kind: "tab" };
  if (historyVisible) {
    historyVisible = false;
    applyViewVisibility();
  }
  hideLinkChoice();
  setTask("link", { kind: "page", title: "正在打开链接", detail: "正在打开帖文链接…", percent: 3 });
  let tab = null;
  try {
    await assertLinkLogin(givenUrl);
    tab = await chrome.tabs.create({ url: givenUrl, active: true });
    const page = await waitLinkTabPage(tab.id);
    // 交接：打开阶段的任务条目换成页签级任务，采集阶段由工作流广播接管
    removeTask("link");
    setTask(pageTaskKey(page.tabId), {
      kind: "page",
      tabId: page.tabId,
      platform: page.platform,
      title: captureLabel(pageSlots.get(page.tabId)?.capture) || "正在连接页面",
      detail: "检查帖文详情页…",
      percent: 3
    });
    writePageStatus(page.tabId, { state: "working", title: "正在连接页面", detail: "检查帖文详情页…", percent: 3 });
    const response = await sendCaptureAndSummarize(page, null, false, givenUrl);
    writePageResult(page.tabId, response.result, response.capture || null);
    writePageStatus(page.tabId, {
      state: "done",
      title: "概括完成",
      detail: completionDetail(response.result, "已按固定格式生成，可直接复制。"),
      percent: 100
    });
    elements.materialInput.value = "";
    clearMaterialFeedback();
  } catch (error) {
    const status = {
      state: "error",
      title: tab ? "链接概括未能完成" : "未能概括链接",
      detail: error?.message || "发生未知错误。",
      percent: 0
    };
    // 页签在等待期间被关掉时不再写状态（onRemoved 已清槽位）
    if (!tab || (await tabExists(tab.id))) {
      writePageStatus(tab?.id ?? activeTabId, status);
    } else if (focus.kind === "tab") {
      renderStatus(status);
    }
    showMaterialFeedback(status.detail, "error");
  } finally {
    removeTask("link");
    if (tab?.id != null) removeTask(pageTaskKey(tab.id));
  }
}

// 后台推送的工作流状态：写入对应页签的槽位并维护任务列表；
// 不再要求“正好是面板当前页签”，多个页签并行时各自更新各自的数据。
function statusFromWorkflow(workflow) {
  const progress = workflow.progress || {};
  if (workflow.status === "done") {
    return {
      state: "done",
      title: progress.title || (workflow.result ? "概括完成" : "已采集完成"),
      detail: progress.detail || (workflow.result ? "已按固定格式生成，可直接复制。" : "页面证据采集完成，可回到插件继续操作。"),
      percent: 100
    };
  }
  if (workflow.status === "error") {
    return {
      state: "error",
      title: progress.title || "未能完成",
      detail: progress.detail || workflow.error || "发生未知错误。",
      percent: progress.percent || 0
    };
  }
  return {
    state: "working",
    title: progress.title || "正在处理",
    detail: progress.detail || "正在恢复当前任务状态…",
    percent: progress.percent || 3,
    count: progress.count
  };
}

function applyWorkflowState(workflow) {
  if (!workflow || !Number.isInteger(workflow.tabId)) return;
  const tabId = workflow.tabId;
  let slot = pageSlots.get(tabId);
  // 面板没见过的页签也挂上槽位（例如面板关闭期间启动/完成的任务），
  // 过时的槽位会在页签切换时的轻量校验中被清除
  if (!slot && workflow.pageSessionId && workflow.pageUrl) {
    slot = {
      context: {
        tabId,
        pageSessionId: workflow.pageSessionId,
        pageUrl: workflow.pageUrl,
        noteId: workflow.noteId || null
      },
      status: null,
      result: null,
      capture: null,
      pendingGivenUrl: null,
      pendingGivenUrlVerified: false
    };
    pageSlots.set(tabId, slot);
  }
  const sameContext = Boolean(
    slot?.context &&
    slot.context.pageSessionId === workflow.pageSessionId &&
    slot.context.pageUrl === workflow.pageUrl
  );
  if (slot && sameContext) {
    if (workflow.noteId && !slot.context.noteId) slot.context.noteId = workflow.noteId;
    if (workflow.capture) slot.capture = workflow.capture;
    if (workflow.status === "done" && workflow.result) slot.result = workflow.result;
    slot.status = statusFromWorkflow(workflow);
    if (focus.kind === "tab" && activeTabId === tabId && !historyVisible) renderFocus();
  }
  const progress = workflow.progress || {};
  if (workflow.status === "working") {
    setTask(pageTaskKey(tabId), {
      kind: "page",
      tabId,
      platform: detectPostPlatform(workflow.pageUrl || ""),
      title: String(workflow.noteTitle || "").trim() || progress.title || "正在处理",
      detail: progress.detail || "",
      percent: progress.percent || 0,
      count: progress.count
    });
  } else {
    removeTask(pageTaskKey(tabId));
  }
}

async function runFullWorkflow() {
  focus = { kind: "tab" };
  if (historyVisible) {
    historyVisible = false;
    applyViewVisibility();
  }
  renderFocus();
  let page;
  try {
    page = await prepareCurrentPage();
  } catch (error) {
    writePageStatus(error.tabId ?? activeTabId, {
      state: "error",
      title: "未能完成",
      detail: error?.message || "发生未知错误。",
      percent: 0
    });
    return;
  }
  const key = pageTaskKey(page.tabId);
  if (tasks.has(key)) return;
  const pendingGivenUrl = pageSlots.get(page.tabId)?.pendingGivenUrl || null;
  const pendingGivenUrlVerified = Boolean(pageSlots.get(page.tabId)?.pendingGivenUrlVerified);
  setTask(key, {
    kind: "page",
    tabId: page.tabId,
    platform: page.platform,
    title: captureLabel(pageSlots.get(page.tabId)?.capture) || "正在连接页面",
    detail: "检查当前帖文详情页…",
    percent: 3
  });
  writePageStatus(page.tabId, { state: "working", title: "正在连接页面", detail: "检查当前帖文详情页…", percent: 3 });
  try {
    const response = await sendCaptureAndSummarize(page, null, false, pendingGivenUrl);
    // 暂存链接的“已验证/未能验证”状态由面板决定，内容脚本只负责写入 givenUrl
    if (pendingGivenUrl && response.capture?.source) {
      response.capture.source.givenUrlVerified = pendingGivenUrlVerified;
    }
    writePageResult(page.tabId, response.result, response.capture || null);
    writePageStatus(page.tabId, {
      state: "done",
      title: "概括完成",
      detail: completionDetail(response.result, "已按固定格式生成，可直接复制。"),
      percent: 100
    });
    // 提取期间用户可能又贴了链接：以完成那一刻槽位里的暂存链接为准
    await settlePendingLinkAfterWorkflow(page.tabId, pendingGivenUrl);
  } catch (error) {
    writePageStatus(page.tabId, {
      state: "error",
      title: "未能完成",
      detail: error?.message || "发生未知错误。",
      percent: 0
    });
  } finally {
    removeTask(key);
  }
}

async function regenerateShot() {
  const capture = shotSlot.capture;
  if (!capture) {
    await runFullWorkflow();
    return;
  }
  focus = { kind: "shot" };
  renderFocus();
  setTask("shot:single", {
    kind: "shot",
    title: captureLabel(capture) || "重新生成",
    detail: "复用截图证据，重新调用文字模型…",
    percent: 66
  });
  shotSlot.status = { state: "working", title: "正在重新生成", detail: "复用页面与图片证据，重新调用文字模型…", percent: 66 };
  renderStatus(shotSlot.status);
  try {
    const page = await prepareCurrentPage();
    const response = await sendCaptureAndSummarize(page, capture, true);
    shotSlot.result = response.result;
    shotSlot.status = {
      state: "done",
      title: "重新生成完成",
      detail: completionDetail(response.result, "新版本已替换原概括。"),
      percent: 100
    };
  } catch (error) {
    shotSlot.status = { state: "error", title: "重新生成失败", detail: error?.message || "发生未知错误。", percent: 66 };
  } finally {
    removeTask("shot:single");
  }
  if (focus.kind === "shot") renderFocus();
  else refreshButtons();
}

async function regenerateActiveTab() {
  if (activeTabId == null || tasks.has(pageTaskKey(activeTabId))) return;
  const tabId = activeTabId;
  const capture = pageSlots.get(tabId)?.capture;
  if (!capture) {
    await runFullWorkflow();
    return;
  }
  focus = { kind: "tab" };
  renderFocus();
  setTask(pageTaskKey(tabId), {
    kind: "page",
    tabId,
    platform: detectPostPlatform(pageSlots.get(tabId)?.context?.pageUrl || ""),
    title: captureLabel(capture) || "重新生成",
    detail: "复用页面与图片证据，重新调用文字模型…",
    percent: 66
  });
  writePageStatus(tabId, { state: "working", title: "正在重新生成", detail: "复用页面与图片证据，重新调用文字模型…", percent: 66 });
  try {
    const page = await prepareCurrentPage();
    const response = await sendCaptureAndSummarize(page, capture, true);
    writePageResult(page.tabId, response.result, response.capture || null);
    writePageStatus(page.tabId, {
      state: "done",
      title: "重新生成完成",
      detail: completionDetail(response.result, "新版本已替换原概括。"),
      percent: 100
    });
    // 重新生成期间贴入的链接以完成那一刻的暂存值为准
    await settlePendingLinkAfterWorkflow(page.tabId, null);
  } catch (error) {
    writePageStatus(tabId, {
      state: "error",
      title: "重新生成失败",
      detail: error?.message || "发生未知错误。",
      percent: 0
    });
  } finally {
    removeTask(pageTaskKey(tabId));
  }
}

// —— 添加素材：链接识别 ——

function showMaterialFeedback(text, state = "info") {
  elements.materialFeedback.textContent = text;
  elements.materialFeedback.dataset.state = state;
  elements.materialFeedback.hidden = false;
}

function clearMaterialFeedback() {
  elements.materialFeedback.hidden = true;
  elements.materialFeedback.textContent = "";
  delete elements.materialFeedback.dataset.state;
}

// 一次补链接可能同时更新单条与合并结果；只要有一处因正文被编辑而未能替换，就提示用户手动改。
function relinkFeedbackText(...linkApplied) {
  return linkApplied.includes("kept") ? RELINK_KEPT_HINT : RELINK_UPDATED_HINT;
}

function showRelinkFeedback(...linkApplied) {
  showMaterialFeedback(relinkFeedbackText(...linkApplied));
}

function hideLinkChoice() {
  pendingLinkChoice = null;
  elements.linkChoice.hidden = true;
  elements.linkChoiceOptions.innerHTML = "";
}

function currentTabCandidate() {
  const platform = currentPostPlatform();
  if (!platform || activeTabId == null) return null;
  const slot = currentSlot();
  const noteId = slot?.context?.noteId ||
    noteIdFromUrlForPlatform(platform, slot?.context?.pageUrl || activeTabUrl);
  if (!noteId) return null;
  return {
    kind: "tab",
    platform,
    noteId,
    label: "当前帖文"
  };
}

function basketCandidates() {
  return basketItems
    .filter((item) => item.kind !== "user_screenshot" && /^(?:note|wbnote):/.test(item.id))
    .map((item) => ({
      kind: "basket",
      id: item.id,
      platform: item.platform,
      noteId: item.id.replace(/^(?:note|wbnote):/, ""),
      label: item.title || item.author || item.id
    }));
}

function basketItemLabel(item) {
  if (!item) return "";
  const prefix = item.kind === "user_screenshot" ? "截图" : item.platform === "weibo" ? "微博" : "网页";
  const name = item.title || (item.author ? `@${item.author}` : item.id);
  return `${prefix}「${name}」`;
}

async function resolveLinkViaBackend(url) {
  const response = await chrome.runtime.sendMessage({ type: "XHS_AI_RESOLVE_LINK", url });
  if (!response?.ok) throw new Error(response?.error || "链接解析失败。");
  return response;
}

function isSupportedGivenLink(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "xhslink.cn" || host.endsWith(".xhslink.cn") ||
      host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") ||
      host === "weibo.com" || host.endsWith(".weibo.com");
  } catch {
    return false;
  }
}

function validateScreenshotLink(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("链接不是有效网址。");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" ||
    !(host.endsWith("xiaohongshu.com") || host === "xhslink.cn" || host.endsWith(".xhslink.cn"))) {
    throw new Error("截图帖文的链接需为小红书地址（xiaohongshu.com 或 xhslink.cn）。");
  }
  return parsed.href;
}

// 链接归位到当前页签：已有结果就直接换链接；还没提取就暂存，提取时带入。
// 页签任务进行中时一律只写 pendingGivenUrl，由任务完成后的统一检查补上。
async function applyLinkToTab(url, verified, { announce = true } = {}) {
  if (activeTabId == null) return { outcome: "none", linkApplied: null };
  const slot = touchPageSlot(activeTabId);
  const targetUrl = String(url || "").trim();
  if (tasks.has(pageTaskKey(activeTabId))) {
    if (!targetUrl) {
      showMaterialFeedback("任务进行中，完成后才能清空链接。", "error");
      return { outcome: "blocked", linkApplied: null };
    }
    slot.pendingGivenUrl = targetUrl;
    slot.pendingGivenUrlVerified = Boolean(verified);
    if (announce) showMaterialFeedback("任务完成后自动补上链接。");
    return { outcome: "task-pending", linkApplied: null };
  }
  if (slot.result && slot.capture) {
    const response = await requestRelink(
      slot.capture,
      slot.result,
      targetUrl,
      verified,
      { tabId: activeTabId, pageSessionId: slot.context?.pageSessionId || null }
    );
    slot.capture = response.payload;
    slot.result = response.result;
    let linkApplied = response.linkApplied || "rerendered";
    const id = payloadItemId(response.payload);
    if (id && basketItems.some((item) => item.id === id)) {
      await setBasketItemLink(id, targetUrl, verified);
      const mergeApplied = await rerenderMergeIfPossible();
      if (mergeApplied === "kept") linkApplied = "kept";
    }
    slot.status = {
      state: "done",
      title: "链接已更新",
      detail: relinkFeedbackText(linkApplied),
      percent: 100
    };
    if (focus.kind === "tab" && !historyVisible) renderFocus();
    return { outcome: "applied", linkApplied };
  }
  slot.pendingGivenUrl = targetUrl || null;
  slot.pendingGivenUrlVerified = Boolean(verified);
  // 同一条帖子已在清单里时一起同步，避免单条结果与清单条目各持一份链接
  const platform = currentPostPlatform();
  const noteId = slot.context?.noteId ||
    noteIdFromUrlForPlatform(platform, slot.context?.pageUrl || activeTabUrl);
  const itemId = noteId ? `${platform === "weibo" ? "wbnote" : "note"}:${noteId}` : null;
  let mergeApplied = null;
  if (itemId && basketItems.some((item) => item.id === itemId)) {
    await setBasketItemLink(itemId, targetUrl, verified);
    mergeApplied = await rerenderMergeIfPossible();
  }
  if (focus.kind === "tab" && !historyVisible) renderCurrentPost();
  if (!slot.pendingGivenUrl) return { outcome: "none", linkApplied: null };
  return { outcome: "pending", linkApplied: mergeApplied };
}

// 任务跑完后补上运行期间贴入的链接；只换链接，不调用模型、不重推飞书。
async function settlePendingLinkAfterWorkflow(tabId, usedGivenUrl) {
  const slot = pageSlots.get(tabId);
  if (!slot) return;
  const latest = String(slot.pendingGivenUrl || "").trim();
  if (!latest) return;
  if (latest === String(usedGivenUrl || "").trim()) {
    slot.pendingGivenUrl = null;
    slot.pendingGivenUrlVerified = false;
    return;
  }
  if (!slot.result || !slot.capture) return;
  const verified = Boolean(slot.pendingGivenUrlVerified);
  try {
    const response = await requestRelink(slot.capture, slot.result, latest, verified, {
      tabId,
      pageSessionId: slot.context?.pageSessionId || null
    });
    slot.capture = response.payload;
    slot.result = response.result;
    let linkApplied = response.linkApplied || "rerendered";
    const id = payloadItemId(response.payload);
    if (id && basketItems.some((item) => item.id === id)) {
      await setBasketItemLink(id, latest, verified);
      const mergeApplied = await rerenderMergeIfPossible();
      if (mergeApplied === "kept") linkApplied = "kept";
    }
    slot.status = {
      state: "done",
      title: "链接已更新",
      detail: relinkFeedbackText(linkApplied),
      percent: 100
    };
    slot.pendingGivenUrl = null;
    slot.pendingGivenUrlVerified = false;
    if (focus.kind === "tab" && activeTabId === tabId && !historyVisible) renderFocus();
    showMaterialFeedback(relinkFeedbackText(linkApplied));
  } catch (error) {
    // 补链接失败时保留 pending，下一次提取或加入清单还会再试
    showMaterialFeedback(error?.message || "链接更新失败。", "error");
  }
}

async function requestRelink(payload, result, givenUrl, verified, context = {}) {
  const response = await chrome.runtime.sendMessage({
    type: "XHS_AI_RELINK",
    payload,
    result,
    givenUrl,
    verified,
    ...(Number.isInteger(context.tabId) ? { tabId: context.tabId } : {}),
    ...(context.pageSessionId ? { pageSessionId: context.pageSessionId } : {})
  });
  if (!response?.ok) throw new Error(response?.error || "链接更新失败。");
  return response;
}

async function relinkCurrentResultOnly(url, verified) {
  const payload = focusedPayload();
  const result = currentResult();
  if (!payload || !result) return { outcome: "none", linkApplied: null };
  const slot = focus.kind === "tab" ? currentSlot() : null;
  if (focus.kind === "tab" && activeTabId != null && tasks.has(pageTaskKey(activeTabId))) {
    if (slot) {
      const targetUrl = String(url || "").trim();
      if (!targetUrl) {
        showMaterialFeedback("任务进行中，完成后才能清空链接。", "error");
        return { outcome: "blocked", linkApplied: null };
      }
      slot.pendingGivenUrl = targetUrl;
      slot.pendingGivenUrlVerified = Boolean(verified);
      showMaterialFeedback("任务完成后自动补上链接。");
    }
    return { outcome: "task-pending", linkApplied: null };
  }
  const response = await requestRelink(payload, result, url, verified, focus.kind === "tab"
    ? { tabId: activeTabId, pageSessionId: slot?.context?.pageSessionId || null }
    : {});
  const linkApplied = response.linkApplied || "rerendered";
  if (focus.kind === "shot") {
    shotSlot.capture = response.payload;
    shotSlot.result = response.result;
    shotSlot.status = {
      state: "done",
      title: "链接已更新",
      detail: relinkFeedbackText(linkApplied),
      percent: 100
    };
  } else {
    if (!slot) return { outcome: "none", linkApplied: null };
    slot.capture = response.payload;
    slot.result = response.result;
    slot.status = {
      state: "done",
      title: "链接已更新",
      detail: relinkFeedbackText(linkApplied),
      percent: 100
    };
  }
  return { outcome: "applied", linkApplied };
}

async function setBasketItemLink(id, url, verified) {
  const response = await chrome.runtime.sendMessage({
    type: "XHS_AI_MERGE_SET_LINK",
    id,
    givenUrl: url,
    verified
  });
  if (!response?.ok) throw new Error(response?.error || "清单链接更新失败。");
  // rerender 需要改动前后的来源后缀与链接，才能保住合并结果里的手工编辑
  lastMergeLinkChange = response.linkChange || null;
  basketItems = response.basket || [];
  renderBasket();
}

async function rerenderMergeIfPossible() {
  if (!mergeSlot.result) {
    lastMergeLinkChange = null;
    return null;
  }
  const linkChange = lastMergeLinkChange;
  lastMergeLinkChange = null;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "XHS_AI_MERGE_RERENDER",
      result: mergeSlot.result,
      ...(linkChange ? { linkChange } : {})
    });
    if (response?.ok && response.result) {
      mergeSlot.result = response.result;
      if (focus.kind === "merge" && !historyVisible) renderResult(mergeSlot.result);
      return response.linkApplied || null;
    }
    return null;
  } catch {
    // 合并结果留在原样，不影响单条链接已经保存
    return null;
  }
}

// 保存结果卡片上的链接：解析只用于校验，不调用模型。
async function saveResultLink() {
  const payload = focusedPayload();
  if (!payload) return;
  elements.resultLinkHint.hidden = true;
  pendingResultLinkConfirm = null;
  const raw = String(elements.resultLinkInput.value || "").trim();
  if (!raw) {
    try {
      await applyGivenLinkToResult("", false);
      closeResultLinkEditor();
    } catch (error) {
      showResultLinkHint(error?.message || "链接更新失败。");
    }
    return;
  }
  if (payload.source?.origin === "user_screenshot") {
    try {
      const normalized = validateScreenshotLink(raw);
      await applyGivenLinkToResult(normalized, false);
      closeResultLinkEditor();
    } catch (error) {
      showResultLinkHint(error?.message || "链接更新失败。");
    }
    return;
  }
  if (!isSupportedGivenLink(raw)) {
    showResultLinkHint("请填写小红书或微博帖文链接。");
    return;
  }
  let resolved = null;
  try {
    resolved = await resolveLinkViaBackend(raw);
  } catch {
    resolved = null;
  }
  const targetNoteId = payload.source?.noteId || null;
  const mismatch = Boolean(resolved?.noteId && targetNoteId && resolved.noteId !== targetNoteId);
  if (mismatch) {
    pendingResultLinkConfirm = { url: raw };
    showResultLinkConfirm("这条链接指向另一条帖文");
    return;
  }
  const verified = Boolean(resolved?.noteId && targetNoteId && resolved.noteId === targetNoteId);
  try {
    await applyGivenLinkToResult(raw, verified);
    closeResultLinkEditor();
  } catch (error) {
    showResultLinkHint(error?.message || "链接更新失败。");
  }
}

async function applyGivenLinkToResult(url, verified) {
  if (focus.kind === "tab") {
    const applied = await applyLinkToTab(url, verified, { announce: false });
    if (applied.outcome === "blocked") throw new Error("任务进行中，完成后才能清空链接。");
    if (applied.outcome === "task-pending") {
      showMaterialFeedback("任务完成后自动补上链接。");
      renderFocus();
      return;
    }
    renderFocus();
    if (applied.outcome === "applied") showRelinkFeedback(applied.linkApplied);
    return;
  }
  const applied = await relinkCurrentResultOnly(url, verified);
  if (applied.outcome === "blocked") throw new Error("任务进行中，完成后才能清空链接。");
  if (applied.outcome === "task-pending") {
    renderFocus();
    return;
  }
  let linkApplied = applied.linkApplied;
  const payload = focusedPayload();
  const id = payloadItemId(payload);
  if (id && basketItems.some((item) => item.id === id)) {
    await setBasketItemLink(id, url, verified);
    const mergeApplied = await rerenderMergeIfPossible();
    if (mergeApplied === "kept") linkApplied = "kept";
  }
  if (focus.kind === "shot") renderFocus();
  if (linkApplied) showRelinkFeedback(linkApplied);
}

async function saveBasketLink() {
  const id = basketLinkEditingId;
  if (!id) return;
  elements.basketLinkHint.hidden = true;
  pendingBasketLinkConfirm = null;
  const item = basketItems.find((entry) => entry.id === id);
  if (!item) {
    closeBasketLinkEditor();
    return;
  }
  const raw = String(elements.basketLinkInput.value || "").trim();
  if (!raw) {
    try {
      await applyGivenLinkToBasket(id, "", false);
      closeBasketLinkEditor();
    } catch (error) {
      showBasketLinkHint(error?.message || "链接更新失败。");
    }
    return;
  }
  if (item.kind === "user_screenshot") {
    try {
      const normalized = validateScreenshotLink(raw);
      await applyGivenLinkToBasket(id, normalized, false);
      closeBasketLinkEditor();
    } catch (error) {
      showBasketLinkHint(error?.message || "链接更新失败。");
    }
    return;
  }
  if (!isSupportedGivenLink(raw)) {
    showBasketLinkHint("请填写小红书或微博帖文链接。");
    return;
  }
  let resolved = null;
  try {
    resolved = await resolveLinkViaBackend(raw);
  } catch {
    resolved = null;
  }
  const targetNoteId = id.replace(/^(?:note|wbnote):/, "");
  const mismatch = Boolean(resolved?.noteId && resolved.noteId !== targetNoteId);
  if (mismatch) {
    pendingBasketLinkConfirm = { id, url: raw };
    showBasketLinkConfirm("这条链接指向另一条帖文");
    return;
  }
  const verified = Boolean(resolved?.noteId && resolved.noteId === targetNoteId);
  try {
    await applyGivenLinkToBasket(id, raw, verified);
    closeBasketLinkEditor();
  } catch (error) {
    showBasketLinkHint(error?.message || "链接更新失败。");
  }
}

async function applyGivenLinkToBasket(id, url, verified) {
  await setBasketItemLink(id, url, verified);
  const payload = focusedPayload();
  let relinkOutcome = "none";
  let linkApplied = null;
  if (payload && payloadItemId(payload) === id && currentResult()) {
    const applied = await relinkCurrentResultOnly(url, verified);
    relinkOutcome = applied.outcome;
    linkApplied = applied.linkApplied;
  }
  const mergeApplied = await rerenderMergeIfPossible();
  if (mergeApplied === "kept") linkApplied = "kept";
  renderFocus();
  if (relinkOutcome === "blocked") {
    showMaterialFeedback("任务进行中，完成后才能清空链接。", "error");
  } else if (relinkOutcome === "task-pending") {
    showMaterialFeedback("任务完成后自动补上链接。");
  } else {
    showRelinkFeedback(linkApplied || mergeApplied || "rerendered");
  }
}

// 解析失败时绝不猜：内联列出当前帖文、清单每条（含截图）与新帖。
function showLinkChoice(url) {
  pendingLinkChoice = { url };
  const options = [];
  const tabCandidate = currentTabCandidate();
  if (tabCandidate) {
    options.push({ choice: "tab", kind: "tab", label: "当前帖文" });
  }
  for (const item of basketItems) {
    options.push({ choice: `basket:${item.id}`, kind: "basket", label: basketItemLabel(item) });
  }
  options.push({ choice: "new", kind: "new", label: "作为新帖打开" });
  elements.linkChoiceOptions.innerHTML = options.map((option) => (
    `<button class="link-choice-option" type="button" data-choice="${escapeHtml(option.choice)}" data-kind="${option.kind}">${escapeHtml(option.label)}</button>`
  )).join("");
  elements.linkChoice.hidden = false;
}

async function handleMaterialLink() {
  const raw = elements.materialInput.value;
  const url = extractPostUrl(raw);
  if (!url) {
    showMaterialFeedback("没有找到小红书或微博帖文链接。", "error");
    hideLinkChoice();
    return;
  }
  hideLinkChoice();
  const token = ++linkResolveToken;
  showMaterialFeedback("正在识别链接…");
  let resolved;
  try {
    resolved = await resolveLinkViaBackend(url);
  } catch (error) {
    if (token !== linkResolveToken) return;
    // 短链请求失败也绝不猜：内联让用户选择链接归属
    showLinkChoice(url);
    showMaterialFeedback(error?.message || "链接解析失败，请手动选择链接归属。", "error");
    return;
  }
  if (token !== linkResolveToken) return;
  if (!resolved?.noteId) {
    showLinkChoice(url);
    showMaterialFeedback("无法自动判断这条链接属于哪条帖文，请在下方选择。", "error");
    return;
  }
  const tabCandidate = currentTabCandidate();
  const candidates = [...(tabCandidate ? [tabCandidate] : []), ...basketCandidates()];
  const matches = candidates.filter((candidate) => (
    candidate.platform === resolved.platform && candidate.noteId === resolved.noteId
  ));
  if (!matches.length) {
    // 解析出的 ID 对不上任何已有素材：当作新帖打开
    elements.materialInput.value = "";
    clearMaterialFeedback();
    await runLinkWorkflow(url);
    return;
  }
  const tabMatchedItemId = tabCandidate &&
    (resolved.platform === tabCandidate.platform && resolved.noteId === tabCandidate.noteId)
    ? `${resolved.platform === "weibo" ? "wbnote" : "note"}:${resolved.noteId}`
    : null;
  const labels = [];
  let taskPending = false;
  let kept = false;
  try {
    for (const match of matches) {
      if (match.kind === "tab") {
        const applied = await applyLinkToTab(url, true, { announce: false });
        if (applied.outcome === "task-pending") taskPending = true;
        else if (applied.outcome === "applied" || applied.outcome === "pending") {
          labels.push(match.label);
          if (applied.linkApplied === "kept") kept = true;
        }
      } else if (match.id !== tabMatchedItemId) {
        // 命中当前页签时 applyLinkToTab 已经同步了同一帖子的清单条目
        const applied = await applyLinkToBasketItemByMatch(match.id, url, true);
        labels.push(match.label);
        if (applied.linkApplied === "kept") kept = true;
      }
    }
  } catch (error) {
    showMaterialFeedback(error?.message || "链接归位失败。", "error");
    return;
  }
  elements.materialInput.value = "";
  if (taskPending) {
    showMaterialFeedback("任务完成后自动补上链接。");
  } else if (kept) {
    showRelinkFeedback("kept");
  } else {
    showRelinkFeedback(labels.length ? "rerendered" : null);
  }
  renderFocus();
}

// 从「添加素材」匹配到清单条目时的入口：不切换焦点
async function applyLinkToBasketItemByMatch(id, url, verified) {
  await setBasketItemLink(id, url, verified);
  let linkApplied = null;
  const payload = focusedPayload();
  if (payload && payloadItemId(payload) === id && currentResult()) {
    const applied = await relinkCurrentResultOnly(url, verified);
    if (applied.outcome === "applied") linkApplied = applied.linkApplied;
  }
  const mergeApplied = await rerenderMergeIfPossible();
  if (mergeApplied === "kept") linkApplied = "kept";
  return { linkApplied: linkApplied || mergeApplied };
}

async function chooseLinkTarget(choice) {
  const pending = pendingLinkChoice;
  if (!pending) return;
  const url = pending.url;
  hideLinkChoice();
  elements.materialInput.value = "";
  clearMaterialFeedback();
  if (choice === "new") {
    await runLinkWorkflow(url);
    return;
  }
  try {
    if (choice === "tab") {
      const applied = await applyLinkToTab(url, false, { announce: false });
      if (applied.outcome === "task-pending") {
        showMaterialFeedback("任务完成后自动补上链接。");
      } else {
        showRelinkFeedback(applied.linkApplied || "rerendered");
      }
    } else if (choice.startsWith("basket:")) {
      const id = choice.slice("basket:".length);
      // applyGivenLinkToBasket 已经按 linkApplied 写好反馈
      await applyGivenLinkToBasket(id, url, false);
    }
  } catch (error) {
    showMaterialFeedback(error?.message || "链接归位失败。", "error");
  }
  renderFocus();
}

// —— 清单 ——

function basketLinkButton(item) {
  const hasLink = Boolean(item.link);
  const unverified = hasLink && item.linkVerified === false;
  const text = hasLink ? shortenLink(item.link) : "＋补充链接";
  return `<button class="basket-link-value" type="button" data-basket-link="${escapeHtml(item.id)}" ` +
    `data-empty="${hasLink ? "false" : "true"}" data-unverified="${unverified ? "true" : "false"}" ` +
    `title="${escapeHtml(hasLink ? item.link : "补充这条帖文的链接")}">${escapeHtml(text)}</button>` +
    `<button class="link-edit-button" type="button" data-basket-link="${escapeHtml(item.id)}" ` +
    `title="编辑链接" aria-label="编辑链接">✎</button>`;
}

function renderBasket() {
  if (basketLinkEditingId && !basketItems.some((item) => item.id === basketLinkEditingId)) {
    basketLinkEditingId = null;
  }
  elements.basketList.innerHTML = basketItems.map((item) => {
    const isShot = item.kind === "user_screenshot";
    const isWeibo = !isShot && item.platform === "weibo";
    const badgeLabel = isShot ? "截图" : isWeibo ? "微博" : "网页";
    const badgeClass = isShot ? "merge-badge-shot" : isWeibo ? "merge-badge-weibo" : "merge-badge-page";
    const label = [item.author || "未知账号", item.title].filter(Boolean).join("：");
    const meta = `${item.isVideo ? "视频 · " : ""}${item.commentCount || 0} 条评论`;
    const unverified = item.link && item.linkVerified === false ? "（未能验证）" : "";
    return `<li class="merge-item basket-item" data-id="${escapeHtml(item.id)}">` +
      `<div class="basket-main">` +
      `<span class="merge-badge ${badgeClass}">${badgeLabel}</span>` +
      `<span class="merge-item-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>` +
      `<span class="merge-item-meta">${escapeHtml(meta)}</span>` +
      `<button class="merge-remove" type="button" title="移除">✕</button>` +
      `</div>` +
      `<div class="basket-link-line"><span class="basket-link-label">链接</span>${basketLinkButton(item)}` +
      `${unverified ? `<span class="merge-item-meta">${unverified}</span>` : ""}</div>` +
      `</li>`;
  }).join("");
  const count = basketItems.length;
  const hasMergeResult = Boolean(mergeSlot.result);
  elements.basketPanel.hidden = count === 0 && !hasMergeResult;
  elements.basketCount.textContent = String(count);
  elements.mergeClearButton.hidden = count === 0;
  elements.mergeSummarizeButton.hidden = count < 2;
  elements.mergeSummarizeLabel.textContent = `合并概括（${count} 条）`;
  elements.basketSingleHint.hidden = count !== 1;
  // 合并结果被切走后，清单区保留一个回到结果的入口；清单变了则标为「上次合并」
  elements.mergeViewResultButton.hidden = !hasMergeResult || focus.kind === "merge" || historyVisible;
  if (!elements.mergeViewResultButton.hidden) {
    elements.mergeViewResultButton.textContent = mergeResultMatchesBasket(mergeSlot.result)
      ? "查看合并结果"
      : "查看上次合并结果";
  }
  elements.basketLinkEditor.hidden = !basketLinkEditingId;
  if (basketLinkEditingId) {
    const item = basketItems.find((entry) => entry.id === basketLinkEditingId);
    elements.basketLinkEditorLabel.textContent = item ? `为${basketItemLabel(item)}补充链接` : "补充链接";
    // 编辑框移到对应条目下方，保持“原地编辑”的观感；列表重渲染后重新挂载
    const selector = `.basket-item[data-id="${String(basketLinkEditingId).replace(/"/g, '\\"')}"]`;
    const row = elements.basketList.querySelector?.(selector);
    if (row?.appendChild) row.appendChild(elements.basketLinkEditor);
    elements.basketLinkEditor.hidden = false;
  }
  if (focus.kind === "merge" && mergeSlot.result && !elements.resultCard.hidden) {
    elements.resultSourceLabel.textContent = resultSourceLabel(mergeSlot.result);
  }
  refreshResultBasketButton();
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

function refreshResultBasketButton() {
  if (focus.kind === "merge" || historyVisible) {
    elements.resultAddBasketButton.hidden = true;
    return;
  }
  elements.resultAddBasketButton.hidden = false;
  const inBasket = basketHasPayload(focusedPayload());
  elements.resultAddBasketButton.textContent = inBasket ? "已在清单" : "加入清单";
  elements.resultAddBasketButton.disabled = inBasket;
}

async function addPayloadToBasket(payload) {
  const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_ADD", payload });
  if (!response?.ok) throw new Error(response?.error || "加入清单失败。");
  basketItems = response.basket || [];
  renderBasket();
  return response;
}

function payloadWithPendingLink(payload, slot) {
  const pending = slot?.pendingGivenUrl;
  if (!pending) return payload;
  const source = { ...payload.source, givenUrl: pending };
  if (source.origin !== "user_screenshot") source.givenUrlVerified = Boolean(slot.pendingGivenUrlVerified);
  else delete source.givenUrlVerified;
  return { ...payload, source };
}

// 当前帖文「加入清单」：已有采集数据就直接复用，没有才重新采集。
async function addCurrentPostToBasket() {
  if (activeTabId == null) return;
  const tabId = activeTabId;
  const slot = pageSlots.get(tabId);
  if (slot?.capture) {
    const payload = payloadWithPendingLink(slot.capture, slot);
    try {
      const added = await addPayloadToBasket(payload);
      if (slot.pendingGivenUrl) {
        slot.capture = payload;
        slot.pendingGivenUrl = null;
        slot.pendingGivenUrlVerified = false;
      }
      const detail = added.replaced
        ? "已替换清单中的同一条帖文。"
        : `已加入清单，当前共 ${basketItems.length} 条。`;
      writePageStatus(tabId, { state: "done", title: "已加入合并清单", detail, percent: 100 });
      if (focus.kind !== "tab") showMaterialFeedback(detail);
      renderBasket();
      refreshButtons();
    } catch (error) {
      const status = { state: "error", title: "未能加入清单", detail: error?.message || "发生未知错误。", percent: 0 };
      writePageStatus(tabId, status);
      if (focus.kind !== "tab") showMaterialFeedback(status.detail, "error");
    }
    return;
  }

  let page;
  try {
    page = await prepareCurrentPage();
  } catch (error) {
    const status = { state: "error", title: "未能加入清单", detail: error?.message || "发生未知错误。", percent: 0 };
    writePageStatus(error.tabId ?? tabId, status);
    if (focus.kind !== "tab") showMaterialFeedback(status.detail, "error");
    return;
  }
  if (tasks.has(pageTaskKey(page.tabId))) return;
  writePageStatus(page.tabId, { state: "working", title: "正在采集帖文", detail: "读取正文与评论，图片识别将同步进行…", percent: 5 });
  try {
    const response = await chrome.tabs.sendMessage(page.tabId, {
      type: "XHS_CAPTURE_FOR_MERGE",
      options: { limit: LIMIT }
    });
    if (!response?.ok || !response.payload) throw new Error(response?.error || "采集未完成。");
    const currentSlot = pageSlots.get(page.tabId);
    const payload = payloadWithPendingLink(response.payload, currentSlot);
    const added = await addPayloadToBasket(payload);
    if (currentSlot?.pendingGivenUrl) {
      currentSlot.pendingGivenUrl = null;
      currentSlot.pendingGivenUrlVerified = false;
    }
    const detail = added.replaced
      ? "已替换清单中的同一条帖文。"
      : `当前清单共 ${basketItems.length} 条帖文，可继续加入或直接合并概括。`;
    writePageStatus(page.tabId, { state: "done", title: "已加入合并清单", detail, percent: 100 });
    if (focus.kind !== "tab") showMaterialFeedback(detail);
  } catch (error) {
    const status = { state: "error", title: "未能加入清单", detail: error?.message || "发生未知错误。", percent: 0 };
    writePageStatus(page.tabId, status);
    if (focus.kind !== "tab") showMaterialFeedback(status.detail, "error");
  }
  renderBasket();
}

// 结果卡片「加入清单」：直接复用结果对应的采集 payload，不重新采集。
async function addFocusedResultToBasket() {
  const payload = focusedPayload();
  if (!payload) {
    if (focus.kind === "tab") await addCurrentPostToBasket();
    return;
  }
  if (basketHasPayload(payload)) return;
  try {
    const added = await addPayloadToBasket(payload);
    const detail = added.replaced
      ? "已替换清单中的同一条帖文。"
      : `已加入清单，当前共 ${basketItems.length} 条。`;
    if (focus.kind === "shot") {
      shotSlot.status = { state: "done", title: "已加入合并清单", detail, percent: 100 };
    } else if (focus.kind === "tab" && activeTabId != null) {
      writePageStatus(activeTabId, { state: "done", title: "已加入合并清单", detail, percent: 100 });
    }
    renderFocus();
  } catch (error) {
    showMaterialFeedback(error?.message || "加入清单失败。", "error");
  }
}

async function removeBasketItem(id) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_REMOVE", id });
    if (!response?.ok) throw new Error(response?.error || "移除失败。");
    basketItems = response.basket || [];
    if (basketLinkEditingId === id) closeBasketLinkEditor();
    renderBasket();
    refreshButtons();
  } catch (error) {
    showMaterialFeedback(error?.message || "移除失败。", "error");
  }
}

async function clearBasket() {
  if (!basketItems.length) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_CLEAR" });
    if (!response?.ok) throw new Error(response?.error || "清空失败。");
  } catch (error) {
    showMaterialFeedback(error?.message || "清空失败。", "error");
    return;
  }
  basketItems = [];
  basketLinkEditingId = null;
  renderBasket();
  refreshButtons();
}

// —— 合并概括 ——

function mergeProgressTitle(stage) {
  if (stage === "vision") return "正在识别图片";
  if (stage === "text") return "正在撰写合并概括";
  if (stage === "notification") return "正在推送飞书";
  return "正在合并概括";
}

async function runMergeSummarize(force = false) {
  if (tasks.has("merge") || basketItems.length < 2) return;
  focus = { kind: "merge" };
  if (historyVisible) {
    historyVisible = false;
    applyViewVisibility();
  }
  setTask("merge", {
    kind: "merge",
    title: "合并概括",
    detail: `整合 ${basketItems.length} 条帖文的证据…`,
    percent: 8
  });
  mergeSlot.status = {
    state: "working",
    title: "正在合并概括",
    detail: `整合 ${basketItems.length} 条帖文的证据…`,
    percent: 8
  };
  renderFocus();
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_SUMMARIZE", force: Boolean(force) });
    if (!response?.ok) throw new Error(response?.error || "合并概括未完成。");
    mergeSlot.result = response.result;
    mergeSlot.status = {
      state: "done",
      title: force ? "重新生成完成" : "合并概括完成",
      detail: completionDetail(response.result, `已合并 ${response.result.postCount || basketItems.length} 条帖文，可直接复制。`),
      percent: 100
    };
  } catch (error) {
    mergeSlot.status = { state: "error", title: "合并概括失败", detail: error?.message || "发生未知错误。", percent: 0 };
  } finally {
    removeTask("merge");
  }
  if (focus.kind === "merge") renderFocus();
  else refreshButtons();
}

// —— 截图：一份暂存列表，两个提交动作 ——

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

const ACCEPTED_SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];

// 点击拖放区、Ctrl+V 粘贴或拖入的图片都进同一份暂存列表，凑齐后由按钮统一提交。
async function stageScreenshotFiles(files) {
  if (!files?.length) return;
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
      stagedScreenshots.push({
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
    showMaterialFeedback(failures[0], "error");
  }
}

function renderStaging() {
  elements.materialStaging.innerHTML = stagedScreenshots.map((item) => (
    `<li class="staging-item"><img src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(item.name)}">` +
    `<button class="staging-remove" type="button" data-id="${escapeHtml(item.id)}" aria-label="移除 ${escapeHtml(item.name)}">×</button></li>`
  )).join("");
  const count = stagedScreenshots.length;
  elements.materialStaging.hidden = count === 0;
  elements.materialShotActions.hidden = count === 0;
  elements.shotSummarizeButton.textContent = count > 1 ? `识别这 ${count} 张截图并概括` : "识别这张截图并概括";
  elements.shotBasketButton.textContent = count > 1 ? `识别这 ${count} 张截图并加入清单` : "识别这张截图并加入清单";
}

async function summarizeScreenshotImages(images, writeStatus) {
  const recognized = await chrome.runtime.sendMessage({
    type: "XHS_AI_SCREENSHOT_RECOGNIZE",
    images
  });
  if (!recognized?.ok || !recognized.payload) throw new Error(recognized?.error || "截图识别失败。");
  shotSlot.capture = recognized.payload;
  writeStatus({ state: "working", title: "正在撰写概括", detail: "截图证据已就绪，正在生成概括…", percent: 66 });
  const response = await chrome.runtime.sendMessage({
    type: "XHS_AI_SUMMARIZE",
    payload: recognized.payload,
    force: false
  });
  if (!response?.ok) throw new Error(response?.error || "概括未完成。");
  shotSlot.result = response.result;
  const warningNote = recognized.warnings?.length
    ? `；${recognized.warnings.length} 项信息未能完全识别（如时间、互动数）`
    : "";
  writeStatus({
    state: "done",
    title: "截图概括完成",
    detail: completionDetail(response.result, "已按固定格式生成，可直接复制。") + warningNote,
    percent: 100
  });
}

async function addScreenshotImagesToBasket(images) {
  const response = await chrome.runtime.sendMessage({
    type: "XHS_AI_SCREENSHOT_ADD",
    images
  });
  if (!response?.ok) throw new Error(response?.error || "截图识别失败。");
  basketItems = response.basket || [];
  renderBasket();
  const warningNote = response.warnings?.length
    ? `；${response.warnings.length} 项信息未能完全识别（如时间、互动数）`
    : "";
  showMaterialFeedback(`截图已识别并加入清单，当前共 ${basketItems.length} 条${warningNote}。`);
}

async function commitStagedScreenshots(mode) {
  const isMerge = mode === "basket";
  const taskKey = isMerge ? "shot:merge" : "shot:single";
  if (!stagedScreenshots.length || tasks.has(taskKey)) return;
  if (!isMerge) {
    focus = { kind: "shot" };
    if (historyVisible) {
      historyVisible = false;
      applyViewVisibility();
    }
    renderFocus();
  }
  const writeStatus = (status) => {
    if (isMerge) return;
    shotSlot.status = status;
    if (focus.kind === "shot" && !historyVisible) renderStatus(status);
    if (status.state === "working") {
      setTask(taskKey, { detail: status.detail, percent: status.percent });
    }
  };
  setTask(taskKey, {
    kind: "shot",
    title: isMerge ? "识别截图加入清单" : "识别截图并概括",
    detail: `共 ${stagedScreenshots.length} 张截图，正在提取帖文内容…`,
    percent: 15
  });
  writeStatus({ state: "working", title: "正在识别截图", detail: `共 ${stagedScreenshots.length} 张截图，正在提取帖文内容…`, percent: 15 });
  const committedIds = new Set(stagedScreenshots.map((item) => item.id));
  try {
    const images = stagedScreenshots.map((item) => item.dataUrl);
    if (isMerge) {
      await addScreenshotImagesToBasket(images);
    } else {
      await summarizeScreenshotImages(images, writeStatus);
    }
    // 只移除本次提交的截图：识别期间新贴入的图片保留在暂存区
    stagedScreenshots = stagedScreenshots.filter((item) => !committedIds.has(item.id));
    renderStaging();
  } catch (error) {
    if (isMerge) {
      showMaterialFeedback(error?.message || "截图识别失败。", "error");
    } else {
      writeStatus({ state: "error", title: "截图识别失败", detail: error?.message || "发生未知错误。", percent: 0 });
    }
  } finally {
    removeTask(taskKey);
    if (focus.kind === (isMerge ? "merge" : "shot")) renderFocus();
    else {
      renderBasket();
      refreshButtons();
    }
  }
}

// —— 结果卡片上的链接编辑 ——

function renderResultLink() {
  if (focus.kind === "merge" || historyVisible) {
    elements.resultLinkRow.hidden = true;
    elements.resultLinkEditor.hidden = true;
    return;
  }
  elements.resultLinkRow.hidden = false;
  const payload = focusedPayload();
  const link = effectiveLink(payload);
  elements.resultLinkDisplay.textContent = link ? shortenLink(link) : "＋补充链接";
  elements.resultLinkDisplay.dataset.empty = link ? "false" : "true";
  elements.resultLinkDisplay.title = link || "补充原帖链接";
  const unverified = Boolean(link && payload?.source?.givenUrl && payload.source.givenUrlVerified === false);
  // 编辑时链接本身变成输入框：隐藏展示文本和铅笔按钮，不另起一行
  elements.resultLinkDisplay.hidden = resultLinkEditing;
  elements.resultLinkEdit.hidden = resultLinkEditing;
  elements.resultLinkState.hidden = resultLinkEditing || !unverified;
  elements.resultLinkEditor.hidden = !resultLinkEditing;
  if (!resultLinkEditing) elements.resultLinkHint.hidden = true;
}

function openResultLinkEditor() {
  const payload = focusedPayload();
  resultLinkEditing = true;
  elements.resultLinkInput.value = effectiveLink(payload);
  elements.resultLinkHint.hidden = true;
  pendingResultLinkConfirm = null;
  renderResultLink();
  elements.resultLinkInput.focus?.();
  elements.resultLinkInput.select?.();
}

function closeResultLinkEditor() {
  resultLinkEditing = false;
  elements.resultLinkEditor.hidden = true;
  elements.resultLinkHint.hidden = true;
  pendingResultLinkConfirm = null;
  renderResultLink();
}

function showResultLinkHint(text) {
  elements.resultLinkHint.textContent = text;
  elements.resultLinkHint.hidden = false;
}

function showResultLinkConfirm(text) {
  elements.resultLinkHint.hidden = false;
  elements.resultLinkHint.innerHTML = `${escapeHtml(text)} ` +
    `<button type="button" data-link-choice="use">仍然使用</button>` +
    `<button type="button" data-link-choice="cancel">取消</button>`;
}

function showBasketLinkHint(text) {
  elements.basketLinkHint.textContent = text;
  elements.basketLinkHint.hidden = false;
}

function showBasketLinkConfirm(text) {
  elements.basketLinkHint.hidden = false;
  elements.basketLinkHint.innerHTML = `${escapeHtml(text)} ` +
    `<button type="button" data-link-choice="use">仍然使用</button>` +
    `<button type="button" data-link-choice="cancel">取消</button>`;
}

function openBasketLinkEditor(id) {
  const item = basketItems.find((entry) => entry.id === id);
  if (!item) return;
  basketLinkEditingId = id;
  pendingBasketLinkConfirm = null;
  elements.basketLinkInput.value = item.link || "";
  elements.basketLinkHint.hidden = true;
  renderBasket();
  elements.basketLinkEditor.hidden = false;
  elements.basketLinkInput.focus?.();
}

function closeBasketLinkEditor() {
  basketLinkEditingId = null;
  pendingBasketLinkConfirm = null;
  elements.basketLinkEditor.hidden = true;
  elements.basketLinkHint.hidden = true;
  renderBasket();
}

// —— 手动发送到飞书 ——

async function refreshFeishuStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_GET_FEISHU_STATUS" });
    feishuConfigured = Boolean(response?.ok && response.configured);
  } catch {
    feishuConfigured = false;
  }
  refreshFeishuButton();
}

function refreshFeishuButton() {
  elements.sendFeishuButton.hidden = !(feishuConfigured && !elements.resultCard.hidden);
}

function hideFeishuFeedback() {
  elements.feishuFeedback.hidden = true;
  elements.feishuFeedback.textContent = "";
  delete elements.feishuFeedback.dataset.state;
}

function showFeishuFeedback(text, state = "done") {
  elements.feishuFeedback.textContent = text;
  elements.feishuFeedback.dataset.state = state;
  elements.feishuFeedback.hidden = false;
}

async function sendResultToFeishu() {
  const text = elements.resultText.value.trim();
  if (!text) {
    showFeishuFeedback("没有可发送的内容。", "error");
    return;
  }
  elements.sendFeishuButton.disabled = true;
  hideFeishuFeedback();
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_SEND_FEISHU", text });
    if (!response?.ok) throw new Error(response?.error || "发送到飞书失败。");
    showFeishuFeedback("已发送到飞书。");
  } catch (error) {
    showFeishuFeedback(error?.message || "发送到飞书失败。", "error");
  } finally {
    elements.sendFeishuButton.disabled = false;
  }
}

// —— 历史屏 ——

function historyBadge(item) {
  if (item.kind === "merge") return { label: "合并", className: "merge-badge-merge" };
  if (item.kind === "screenshot") return { label: "截图", className: "merge-badge-shot" };
  if (item.platform === "weibo") return { label: "微博", className: "merge-badge-weibo" };
  return { label: "网页", className: "merge-badge-page" };
}

// 历史列表用概括自身的标题行（★ 开头的第一行，去掉星号）做条目标题，比“作者：帖文标题”更可读
function summaryHeadline(text) {
  const firstLine = String(text || "").split("\n", 1)[0] || "";
  const headline = firstLine.replace(/^\s*★\s*/, "").trim();
  return headline || null;
}

function renderHistory() {
  elements.historyList.innerHTML = historyItems.map((item) => {
    const badge = historyBadge(item);
    const headline = summaryHeadline(item.result?.text);
    const label = headline || (item.kind === "merge"
      ? item.title
      : [item.author || "未知账号", item.title].filter(Boolean).join("："));
    const meta = formatHistoryTime(item.createdAt);
    return `<li class="merge-item history-item" data-id="${escapeHtml(item.id)}" data-selected="${historyEntry?.id === item.id ? "true" : "false"}">` +
      `<span class="merge-badge ${badge.className}">${badge.label}</span>` +
      `<span class="merge-item-label history-item-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>` +
      `<span class="merge-item-meta">${escapeHtml(meta)}</span>` +
      `<button class="merge-remove" type="button" title="删除">✕</button>` +
      "</li>";
  }).join("");
  elements.historyList.hidden = historyItems.length === 0;
  elements.historyClearButton.hidden = historyItems.length === 0;
}

async function refreshHistory() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_HISTORY_LIST" });
    historyItems = response?.ok ? response.items || [] : [];
  } catch {
    historyItems = [];
  }
  renderHistory();
}

// 历史只读：结果卡进入“查看”态，可复制、可打开原帖，不能重新生成、补链接或加入清单。
function renderHistoryResult(item) {
  elements.resultText.value = item.result?.text || "";
  elements.resultTime.textContent = formatHistoryTime(item.createdAt);
  elements.resultSourceLabel.textContent = "历史";
  renderEvidence(item.result || {});
  elements.regenerateButton.hidden = true;
  elements.openSourceButton.hidden = !item.url;
  elements.resultAddBasketButton.hidden = true;
  elements.resultLinkRow.hidden = true;
  elements.resultLinkEditor.hidden = true;
  elements.resultCard.hidden = false;
  hideFeishuFeedback();
  refreshFeishuButton();
}

function showHistoryEntry(item) {
  historyEntry = item;
  renderHistoryResult(item);
  renderHistory();
}

function clearViewedHistoryEntry() {
  historyEntry = null;
  elements.resultCard.hidden = true;
  elements.resultText.value = "";
}

async function openHistory() {
  if (historyVisible) {
    closeHistory();
    return;
  }
  focusBeforeHistory = focus;
  historyVisible = true;
  applyViewVisibility();
  await refreshHistory();
  if (historyEntry) renderHistoryResult(historyEntry);
  else hideResultCard();
}

function closeHistory() {
  historyVisible = false;
  focus = focusBeforeHistory;
  applyViewVisibility();
  renderFocus();
}

function flashHistoryError(detail) {
  if (!elements.historyHint) return;
  clearTimeout(historyHintResetTimer);
  elements.historyHint.textContent = detail;
  elements.historyHint.dataset.error = "true";
  historyHintResetTimer = setTimeout(() => {
    elements.historyHint.dataset.error = "false";
    elements.historyHint.textContent = HISTORY_HINT_TEXT;
  }, 3000);
}

async function removeHistoryItem(id) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_HISTORY_REMOVE", id });
    if (!response?.ok) throw new Error(response?.error || "删除失败。");
    historyItems = historyItems.filter((item) => item.id !== id);
    if (historyEntry?.id === id) clearViewedHistoryEntry();
    renderHistory();
  } catch (error) {
    flashHistoryError(error?.message || "删除失败。");
  }
}

function resetHistoryClearButton() {
  clearTimeout(historyClearResetTimer);
  historyClearResetTimer = null;
  elements.historyClearButton.dataset.confirming = "false";
  elements.historyClearButton.textContent = "清空历史";
}

async function clearHistoryRecords() {
  if (!historyItems.length) return;
  // 清空不可恢复，按钮两步确认，3 秒未确认自动还原
  if (elements.historyClearButton.dataset.confirming !== "true") {
    elements.historyClearButton.dataset.confirming = "true";
    elements.historyClearButton.textContent = "再点一次确认清空";
    clearTimeout(historyClearResetTimer);
    historyClearResetTimer = setTimeout(resetHistoryClearButton, 3000);
    return;
  }
  resetHistoryClearButton();
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_HISTORY_CLEAR" });
    if (!response?.ok) throw new Error(response?.error || "清空失败。");
    historyItems = [];
    clearViewedHistoryEntry();
    renderHistory();
  } catch (error) {
    flashHistoryError(error?.message || "清空失败。");
  }
}

// —— 消息与事件 ——

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "XHS_AI_WORKFLOW_STATE") applyWorkflowState(message.workflow);
  if (message?.type === "XHS_AI_MERGE_PROGRESS" && tasks.has("merge")) {
    const progress = message.progress || {};
    const status = {
      state: "working",
      title: mergeProgressTitle(progress.stage),
      detail: progress.detail || "正在处理…",
      percent: progress.percent || 8
    };
    mergeSlot.status = status;
    setTask("merge", { detail: status.detail, percent: status.percent });
    if (focus.kind === "merge" && !historyVisible) renderStatus(status);
  }
});

// 设置页保存/清除飞书配置后，侧边栏无需重开即可更新发送图标
chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (!changes) return;
  const relevant = areaName === "local"
    ? "xhsAiConfig" in changes || "xhsAiPersistentSecrets" in changes
    : areaName === "session" && "xhsAiSecrets" in changes;
  if (relevant) void refreshFeishuStatus();
});

chrome.tabs.onActivated?.addListener?.((info) => {
  void setActiveTab(info?.tabId);
});

chrome.windows?.onFocusChanged?.addListener?.((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void (async () => {
    try {
      const tab = await getActiveTab();
      if (tab?.id != null) await setActiveTab(tab.id);
    } catch {
      // 查询失败时保留当前显示
    }
    void refreshFeishuStatus();
  })();
});

chrome.tabs.onRemoved?.addListener?.((tabId) => {
  pageSlots.delete(tabId);
  removeTask(pageTaskKey(tabId));
  if (activeTabId === tabId) {
    activeTabId = null;
    activeTabUrl = "";
    if (focus.kind === "tab" && !historyVisible) renderFocus();
  }
  refreshButtons();
});

// 任务条点击：页签任务跳到对应 Chrome 页签，其余任务切到自己的结果来源
elements.taskList.addEventListener("click", (event) => {
  const row = event.target?.closest?.(".task-item");
  if (!row) return;
  const task = tasks.get(row.dataset?.key);
  if (!task) return;
  if (task.kind === "page" && Number.isInteger(task.tabId)) {
    focus = { kind: "tab" };
    if (historyVisible) {
      historyVisible = false;
      applyViewVisibility();
    }
    void (async () => {
      try {
        const tab = await chrome.tabs.update(task.tabId, { active: true });
        if (tab?.windowId != null) await chrome.windows?.update?.(tab.windowId, { focused: true });
      } catch {
        // 页签可能已被关闭
      }
    })();
    renderFocus();
    return;
  }
  if (task.key === "shot:single" || task.key === "shot:merge") {
    setFocus("shot");
    return;
  }
  if (task.kind === "merge") setFocus("merge");
});

elements.extractButton.addEventListener("click", runFullWorkflow);
elements.mergeAddButton.addEventListener("click", addCurrentPostToBasket);
elements.resultAddBasketButton.addEventListener("click", addFocusedResultToBasket);
elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.historyButton.addEventListener("click", () => { void openHistory(); });
elements.historyBackButton.addEventListener("click", closeHistory);

elements.materialLinkButton.addEventListener("click", () => { void handleMaterialLink(); });
elements.materialInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void handleMaterialLink();
  }
});
elements.linkChoiceOptions.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-choice]");
  if (!button) return;
  void chooseLinkTarget(button.dataset?.choice);
});

elements.materialDropzone.addEventListener("click", () => elements.materialFileInput.click());
elements.materialDropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements.materialFileInput.click();
  }
});
elements.materialFileInput.addEventListener("change", () => {
  void stageScreenshotFiles(Array.from(elements.materialFileInput.files || []));
  elements.materialFileInput.value = "";
});
elements.shotSummarizeButton.addEventListener("click", () => { void commitStagedScreenshots("summarize"); });
elements.shotBasketButton.addEventListener("click", () => { void commitStagedScreenshots("basket"); });
elements.materialStaging.addEventListener("click", (event) => {
  const button = event.target?.closest?.(".staging-remove");
  if (!button) return;
  stagedScreenshots = stagedScreenshots.filter((item) => item.id !== button.dataset?.id);
  renderStaging();
});
elements.materialDropzone.addEventListener("dragenter", (event) => {
  if (event.dataTransfer?.types?.includes("Files")) elements.materialDropzone.dataset.dragover = "true";
});
elements.materialDropzone.addEventListener("dragleave", (event) => {
  if (!elements.materialDropzone.contains(event.relatedTarget)) elements.materialDropzone.dataset.dragover = "false";
});

// 粘贴/拖入的图片与文件选择共用同一份暂存列表；纯文本粘贴不拦截，链接输入框可正常贴 URL。
function imageFilesFromDataTransfer(dataTransfer) {
  return Array.from(dataTransfer?.files || []).filter((file) => file.type?.startsWith("image/"));
}

document.addEventListener("paste", (event) => {
  const files = imageFilesFromDataTransfer(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  void stageScreenshotFiles(files);
});

document.addEventListener("dragover", (event) => {
  // 不阻止 dragover 默认行为，drop 不会触发
  if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
});

document.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  // 拦下浏览器“用拖入文件替换页面”的默认行为，再只挑图片进暂存区
  event.preventDefault();
  elements.materialDropzone.dataset.dragover = "false";
  const files = imageFilesFromDataTransfer(event.dataTransfer);
  if (files.length) void stageScreenshotFiles(files);
});

elements.mergeSummarizeButton.addEventListener("click", () => { void runMergeSummarize(false); });
elements.mergeViewResultButton.addEventListener("click", () => {
  if (mergeSlot.result) setFocus("merge");
});
elements.mergeClearButton.addEventListener("click", () => { void clearBasket(); });
elements.basketList.addEventListener("click", (event) => {
  const row = event.target?.closest?.(".basket-item");
  if (!row) return;
  if (event.target.closest?.(".merge-remove")) {
    void removeBasketItem(row.dataset?.id);
    return;
  }
  const linkButton = event.target.closest?.("[data-basket-link]") ||
    event.target.closest?.(".basket-link-value");
  if (linkButton) openBasketLinkEditor(row.dataset?.id);
});
elements.basketLinkSave.addEventListener("click", () => { void saveBasketLink(); });
elements.basketLinkCancel.addEventListener("click", closeBasketLinkEditor);
elements.basketLinkInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveBasketLink();
  }
});
elements.basketLinkHint.addEventListener("click", (event) => {
  const choice = event.target?.closest?.("[data-link-choice]")?.dataset?.linkChoice;
  if (!choice || !pendingBasketLinkConfirm) return;
  const pending = pendingBasketLinkConfirm;
  pendingBasketLinkConfirm = null;
  elements.basketLinkHint.hidden = true;
  if (choice === "cancel") return;
  void applyGivenLinkToBasket(pending.id, pending.url, false)
    .then(() => closeBasketLinkEditor())
    .catch((error) => {
      showBasketLinkHint(error?.message || "链接更新失败。");
    });
});

elements.resultLinkEdit.addEventListener("click", openResultLinkEditor);
elements.resultLinkSave.addEventListener("click", () => { void saveResultLink(); });
elements.resultLinkCancel.addEventListener("click", closeResultLinkEditor);
elements.resultLinkInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveResultLink();
  }
});
elements.resultLinkHint.addEventListener("click", (event) => {
  const choice = event.target?.closest?.("[data-link-choice]")?.dataset?.linkChoice;
  if (!choice || !pendingResultLinkConfirm) return;
  const pending = pendingResultLinkConfirm;
  pendingResultLinkConfirm = null;
  elements.resultLinkHint.hidden = true;
  if (choice === "cancel") return;
  void applyGivenLinkToResult(pending.url, false)
    .then(() => closeResultLinkEditor())
    .catch((error) => showResultLinkHint(error?.message || "链接更新失败。"));
});

elements.historyClearButton.addEventListener("click", clearHistoryRecords);
elements.historyList.addEventListener("click", (event) => {
  const row = event.target?.closest?.(".history-item");
  if (!row) return;
  const item = historyItems.find((entry) => entry.id === row.dataset?.id);
  if (!item) return;
  if (event.target.closest?.(".merge-remove")) {
    return removeHistoryItem(item.id);
  }
  showHistoryEntry(item);
});
elements.openSourceButton.addEventListener("click", () => {
  if (historyEntry?.url) chrome.tabs.create({ url: historyEntry.url, active: true });
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

// 结果文本可编辑：改动先保留在当前结果对象里；手动发送与复制都取框内当前文本
elements.resultText.addEventListener("input", () => {
  hideFeishuFeedback();
  if (historyVisible) {
    if (historyEntry?.result) historyEntry.result.text = elements.resultText.value;
    return;
  }
  const result = currentResult();
  if (result) result.text = elements.resultText.value;
});

elements.sendFeishuButton.addEventListener("click", () => { void sendResultToFeishu(); });

elements.regenerateButton.addEventListener("click", async () => {
  if (historyVisible || historyEntry) return;
  if (focus.kind === "merge") {
    await runMergeSummarize(true);
    return;
  }
  if (focus.kind === "shot") {
    if (tasks.has("shot:single")) return;
    await regenerateShot();
    return;
  }
  await regenerateActiveTab();
});

// 面板打开时对当前页签做一次完整恢复：注入脚本拿到最新页面会话，再查该页签的工作流
async function restoreCurrentWorkflow() {
  try {
    const page = await prepareCurrentPage();
    const response = await chrome.runtime.sendMessage({
      type: "XHS_AI_GET_WORKFLOW",
      tabId: page.tabId,
      pageSessionId: page.pageSessionId,
      pageUrl: page.pageUrl
    });
    if (response?.ok && response.workflow) applyWorkflowState(response.workflow);
  } catch {
    // 非帖文页签或脚本注入失败：保持默认空状态
  }
}

// 再拉取全部页签的工作流状态：进行中的进任务列表，已完成的结果落到各自槽位
async function hydrateWorkflows() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_LIST_WORKFLOWS" });
    if (response?.ok) {
      for (const workflow of response.workflows || []) applyWorkflowState(workflow);
    }
  } catch {
    // 列表不可用时仅影响任务条与跨页签恢复
  }
}

void (async () => {
  try {
    const tab = await getActiveTab();
    if (tab?.id != null) {
      activeTabId = tab.id;
      activeTabUrl = String(tab.url || "");
    }
  } catch {
    // 查询失败时等 onActivated 再跟进
  }
  applyViewVisibility();
  renderFocus();
  refreshBasket();
  refreshHistory();
  refreshFeishuStatus();
  refreshButtons();
  restoreCurrentWorkflow();
  hydrateWorkflows();
  // 视图不再需要记忆：清掉旧版本遗留的存储键
  try {
    void chrome.storage?.local?.remove?.("xhsPanelView")?.catch?.(() => {});
  } catch {
    // storage 不可用时忽略
  }
})();
