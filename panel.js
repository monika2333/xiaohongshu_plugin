const LIMIT = 50;
const LOGIN_REQUIRED_MESSAGE = "检测到当前小红书页面尚未登录。请先登录并刷新帖文详情页，再点击“提取并概括”。";
const WEIBO_LOGIN_REQUIRED_MESSAGE = "检测到当前微博页面尚未登录。请先登录 weibo.com 并刷新帖文页面，再点击“提取并概括”。";

const elements = {
  viewTabs: document.querySelector(".view-tabs"),
  extractButton: document.querySelector("#extract-button"),
  buttonLabel: document.querySelector(".button-label"),
  settingsButton: document.querySelector("#settings-button"),
  taskStrip: document.querySelector("#task-strip"),
  taskList: document.querySelector("#task-list"),
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
  historyButton: document.querySelector("#history-button"),
  viewSingle: document.querySelector("#view-single"),
  viewMerge: document.querySelector("#view-merge"),
  viewHistory: document.querySelector("#view-history"),
  historyHint: document.querySelector("#history-hint"),
  historyList: document.querySelector("#history-list"),
  historyClearButton: document.querySelector("#history-clear-button"),
  openSourceButton: document.querySelector("#open-source-button"),
  tabSingle: document.querySelector("#tab-single"),
  tabMerge: document.querySelector("#tab-merge"),
  shotSingleDropzone: document.querySelector("#shot-single-dropzone"),
  shotSingleStaging: document.querySelector("#shot-single-staging"),
  shotSingleRun: document.querySelector("#shot-single-run"),
  shotSingleInput: document.querySelector("#shot-single-input"),
  shotSingleUrl: document.querySelector("#shot-single-url")
};

let basketItems = [];
let currentView = "single";
let historyItems = [];
let historyEntry = null;
let tabBeforeHistory = "single";
let historyClearResetTimer = null;
let historyHintResetTimer = null;
const HISTORY_HINT_TEXT = "概括成功后保存在本机（最多 100 条，超出自动淘汰最旧），可随时回看与复制。";

// —— 并行任务模型 ——
// 每个任务独立运行、只禁用自己的按钮，互不阻塞：
//   page:<tabId>  页签级采集概括（提取并概括 / 重新生成 / 加入清单的采集阶段）
//   merge         合并概括
//   shot:single   单条页签的截图识别概括
//   shot:merge    合并页签的截图识别加入清单
// 页签级状态与结果按 Chrome 页签分槽保存；单条视图跟随当前活动页签显示。
const tasks = new Map();
const pageSlots = new Map();
const mergeSlot = { status: null, result: null };
const shotSingleSlot = { status: null, result: null, capture: null };
const shotMergeStatus = { status: null };
let activeTabId = null;
let singleFocus = "tab";
let mergeFocus = "merge";

// 概括页签的状态与结果归属各自的来源：页签级归各 Chrome 页签，截图归截图任务。
// 历史屏由页眉「历史」按钮进入，没有进度可言，不显示状态卡。
const DEFAULT_STATUS = {
  single: { state: "idle", title: "准备就绪", detail: "请先打开一个小红书帖文详情页。", percent: 0 },
  merge: { state: "idle", title: "准备就绪", detail: "把帖文加入清单后，即可一键合并概括。", percent: 0 }
};

function switchView(view) {
  currentView = view === "merge" ? "merge" : view === "history" ? "history" : "single";
  if (currentView === "single" || currentView === "merge") tabBeforeHistory = currentView;
  elements.tabSingle.dataset.active = currentView === "single" ? "true" : "false";
  elements.tabMerge.dataset.active = currentView === "merge" ? "true" : "false";
  elements.historyButton.dataset.active = currentView === "history" ? "true" : "false";
  elements.viewSingle.hidden = currentView !== "single";
  elements.viewMerge.hidden = currentView !== "merge";
  elements.viewHistory.hidden = currentView !== "history";
  // 概括页签栏只服务两个概括页签；历史屏内退出历史即回到概括页签，无需常驻入口
  elements.viewTabs.hidden = currentView === "history";
  // 状态卡只服务两个概括页签：单条视图紧贴“提取并概括”按钮，合并视图挂在合并面板之后
  elements.statusCard.hidden = currentView === "history";
  if (currentView === "merge") {
    elements.viewMerge.appendChild(elements.statusCard);
  } else if (currentView === "single") {
    elements.extractButton.after(elements.statusCard);
  }
  renderCurrentView();
  if (currentView === "history") refreshHistory();
  // 历史是临时视图，不写入视图记忆
  if (currentView !== "history") {
    try {
      void chrome.storage?.local?.set?.({ xhsPanelView: currentView })?.catch?.(() => {});
    } catch {
      // storage 不可用时仅影响视图记忆
    }
  }
}

async function restoreStoredView() {
  try {
    const stored = await chrome.storage?.local?.get?.("xhsPanelView");
    // 旧版本可能存过 history，视图记忆只认两个概括页签
    if (stored?.xhsPanelView === "single" || stored?.xhsPanelView === "merge") switchView(stored.xhsPanelView);
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
  // 页签结果是实时结果：可重新生成、无“打开原帖”；历史屏展示条目时会改写这两个按钮
  elements.regenerateButton.hidden = false;
  elements.openSourceButton.hidden = true;
  elements.resultCard.hidden = false;
}

function hideResultCard() {
  elements.resultCard.hidden = true;
  elements.resultText.value = "";
}

// 当前视图只显示自己槽位的状态与结果；单条视图按 singleFocus 决定跟随页签还是截图任务。
function renderCurrentView() {
  if (currentView === "history") {
    applyHistoryOutput();
    return;
  }
  if (currentView === "merge") {
    renderMergeView();
  } else {
    renderSingleView();
  }
}

function renderSingleView() {
  if (singleFocus === "shot") {
    renderStatus(shotSingleSlot.status || DEFAULT_STATUS.single);
    if (shotSingleSlot.result) {
      renderResult(shotSingleSlot.result);
    } else {
      hideResultCard();
    }
    return;
  }
  const slot = activeTabId != null ? pageSlots.get(activeTabId) : null;
  renderStatus(slot?.status || DEFAULT_STATUS.single);
  if (slot?.result) {
    renderResult(slot.result);
  } else {
    hideResultCard();
  }
}

function renderMergeView() {
  const status = mergeFocus === "shot" ? shotMergeStatus.status : mergeSlot.status;
  renderStatus(status || DEFAULT_STATUS.merge);
  if (mergeSlot.result) {
    renderResult(mergeSlot.result);
  } else {
    hideResultCard();
  }
}

// 切换页签时重放该页签自己的状态与结果；历史屏只重放选中条目。
function applyHistoryOutput() {
  if (historyEntry) {
    renderResult(historyEntry.result);
    elements.resultTime.textContent = formatHistoryTime(historyEntry.createdAt);
    elements.regenerateButton.hidden = true;
    elements.openSourceButton.hidden = !historyEntry.url;
  } else {
    hideResultCard();
  }
}

// —— 任务列表：所有并行任务常驻可见，点击跳到对应页签或视图 ——

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

// —— 按钮只跟随自己的任务：页签按钮看该页签，合并/截图按钮看各自任务 ——

function refreshButtons() {
  const tabBusy = activeTabId != null && tasks.has(pageTaskKey(activeTabId));
  elements.extractButton.disabled = tabBusy;
  elements.buttonLabel.textContent = tabBusy ? "正在处理…" : "提取并概括";
  elements.mergeAddButton.disabled = tabBusy;
  elements.shotSingleRun.disabled = tasks.has("shot:single");
  elements.screenshotRun.disabled = tasks.has("shot:merge");
  elements.mergeSummarizeButton.disabled = tasks.has("merge");
  if (currentView === "merge") {
    elements.regenerateButton.disabled = tasks.has("merge");
  } else if (currentView === "single") {
    elements.regenerateButton.disabled = tabBusy || (singleFocus === "shot" && tasks.has("shot:single"));
  }
}

// —— 页签槽位：单条视图的进度与结果按 Chrome 页签保存 ——

function touchPageSlot(tabId) {
  if (tabId == null) return null;
  let slot = pageSlots.get(tabId);
  if (!slot) {
    slot = { context: null, status: null, result: null, capture: null };
    pageSlots.set(tabId, slot);
  }
  return slot;
}

function writePageStatus(tabId, status) {
  const slot = touchPageSlot(tabId);
  if (!slot) return;
  slot.status = status;
  if (currentView === "single" && singleFocus === "tab" && activeTabId === tabId) renderStatus(status);
}

function writePageResult(tabId, result, capture) {
  const slot = touchPageSlot(tabId);
  if (!slot) return;
  slot.result = result;
  if (capture) slot.capture = capture;
  if (currentView === "single" && singleFocus === "tab" && activeTabId === tabId) renderSingleView();
}

// 页签切换时轻量校验旧槽位：内容脚本不在了（页面整体刷新）或页面会话变了，
// 旧进度/结果即作废；校验失败静默清槽，回到默认空状态。
async function validateTabSlot(tabId) {
  const slot = pageSlots.get(tabId);
  if (!slot) return;
  if (!slot.context) {
    pageSlots.delete(tabId);
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

async function setActiveTab(tabId) {
  if (tabId == null) return;
  const changed = tabId !== activeTabId;
  activeTabId = tabId;
  if (changed) {
    singleFocus = "tab";
    await validateTabSlot(tabId);
    if (currentView === "single") renderSingleView();
  }
  refreshButtons();
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

async function prepareCurrentPage() {
  const tab = await getActiveTab();
  const platform = detectPostPlatform(tab?.url || "");
  if (!tab?.id || !platform) {
    const error = new Error("请先打开小红书或微博帖文详情页，再点击提取并概括。");
    error.tabId = tab?.id ?? null;
    throw error;
  }
  let context;
  try {
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
    context = await chrome.tabs.sendMessage(tab.id, { type: "XHS_PAGE_CONTEXT" });
    if (!context?.ok || !context.pageSessionId) {
      throw new Error(context?.error || "无法确认当前页面状态，请刷新后重试。");
    }
  } catch (error) {
    // 失败状态要落到发起操作的页签上，调用方据此显示错误
    error.tabId = error.tabId ?? tab.id;
    throw error;
  } finally {
    if (tab.id != null) {
      activeTabId = tab.id;
      refreshButtons();
    }
  }
  // 同一页面会话保留旧状态与结果（重新生成不掉结果）；换了页面会话则从头开始
  const slot = pageSlots.get(tab.id);
  const sameContext = Boolean(
    slot?.context &&
    slot.context.pageSessionId === context.pageSessionId &&
    slot.context.pageUrl === context.pageUrl
  );
  pageSlots.set(tab.id, {
    context: { tabId: tab.id, pageSessionId: context.pageSessionId, pageUrl: context.pageUrl },
    status: sameContext ? slot.status ?? null : null,
    result: sameContext ? slot.result ?? null : null,
    capture: sameContext ? slot.capture ?? null : null
  });
  return { tabId: tab.id, platform, pageSessionId: context.pageSessionId, pageUrl: context.pageUrl, noteId: context.noteId ?? null };
}

async function sendCaptureAndSummarize(page, payload, force) {
  const response = await chrome.tabs.sendMessage(page.tabId, {
    type: "XHS_CAPTURE_AND_SUMMARIZE",
    options: { limit: LIMIT },
    payload,
    force
  });
  if (!response?.ok) throw new Error(response?.error || "概括未完成。");
  return response;
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
    slot = { context: { tabId, pageSessionId: workflow.pageSessionId, pageUrl: workflow.pageUrl }, status: null, result: null, capture: null };
    pageSlots.set(tabId, slot);
  }
  const sameContext = Boolean(
    slot?.context &&
    slot.context.pageSessionId === workflow.pageSessionId &&
    slot.context.pageUrl === workflow.pageUrl
  );
  if (slot && sameContext) {
    if (workflow.capture) slot.capture = workflow.capture;
    if (workflow.status === "done" && workflow.result) slot.result = workflow.result;
    slot.status = statusFromWorkflow(workflow);
    if (currentView === "single" && singleFocus === "tab" && activeTabId === tabId) renderSingleView();
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
  singleFocus = "tab";
  if (currentView === "single") renderSingleView();
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
    const response = await sendCaptureAndSummarize(page, null, false);
    writePageResult(page.tabId, response.result, response.capture || null);
    writePageStatus(page.tabId, {
      state: "done",
      title: "概括完成",
      detail: completionDetail(response.result, "已按固定格式生成，可直接复制。"),
      percent: 100
    });
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
  const capture = shotSingleSlot.capture;
  if (!capture) {
    await runFullWorkflow();
    return;
  }
  setTask("shot:single", {
    kind: "shot",
    title: captureLabel(capture) || "重新生成",
    detail: "复用截图证据，重新调用文字模型…",
    percent: 66
  });
  shotSingleSlot.status = { state: "working", title: "正在重新生成", detail: "复用页面与图片证据，重新调用文字模型…", percent: 66 };
  if (currentView === "single" && singleFocus === "shot") renderStatus(shotSingleSlot.status);
  try {
    const page = await prepareCurrentPage();
    const response = await sendCaptureAndSummarize(page, capture, true);
    shotSingleSlot.result = response.result;
    shotSingleSlot.status = {
      state: "done",
      title: "重新生成完成",
      detail: completionDetail(response.result, "新版本已替换原概括。"),
      percent: 100
    };
  } catch (error) {
    shotSingleSlot.status = { state: "error", title: "重新生成失败", detail: error?.message || "发生未知错误。", percent: 66 };
  } finally {
    removeTask("shot:single");
  }
  if (currentView === "single" && singleFocus === "shot") renderSingleView();
}

async function regenerateActiveTab() {
  if (activeTabId == null || tasks.has(pageTaskKey(activeTabId))) return;
  const tabId = activeTabId;
  const capture = pageSlots.get(tabId)?.capture;
  if (!capture) {
    await runFullWorkflow();
    return;
  }
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
  } catch (error) {
    writePageStatus(tabId, {
      state: "error",
      title: "重新生成失败",
      detail: error?.message || "发生未知错误。",
      percent: 66
    });
  } finally {
    removeTask(pageTaskKey(tabId));
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
    // 提不出标题行时（异常数据）退回“作者：帖文标题”
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

// 历史只读：结果卡进入“查看”态，可复制、可打开原帖，不能重新生成。
function showHistoryEntry(item) {
  historyEntry = item;
  renderResult(item.result);
  elements.resultTime.textContent = formatHistoryTime(item.createdAt);
  elements.regenerateButton.hidden = true;
  elements.openSourceButton.hidden = !item.url;
  renderHistory();
}

function clearViewedHistoryEntry() {
  historyEntry = null;
  elements.resultCard.hidden = true;
  elements.resultText.value = "";
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

async function addCurrentPostToBasket() {
  let page;
  try {
    page = await prepareCurrentPage();
  } catch (error) {
    mergeFocus = "merge";
    if (currentView === "merge") renderMergeView();
    mergeSlot.status = { state: "error", title: "未能加入清单", detail: error?.message || "发生未知错误。", percent: 0 };
    if (currentView === "merge") renderMergeView();
    return;
  }
  if (tasks.has(pageTaskKey(page.tabId))) return;
  mergeFocus = "merge";
  mergeSlot.status = { state: "working", title: "正在采集帖文", detail: "读取正文与评论，图片识别将同步进行…", percent: 5 };
  if (currentView === "merge") renderMergeView();
  try {
    const response = await chrome.tabs.sendMessage(page.tabId, {
      type: "XHS_CAPTURE_FOR_MERGE",
      options: { limit: LIMIT }
    });
    if (!response?.ok || !response.payload) throw new Error(response?.error || "采集未完成。");
    const added = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_ADD", payload: response.payload });
    if (!added?.ok) throw new Error(added?.error || "加入清单失败。");
    basketItems = added.basket || [];
    renderBasket();
    mergeSlot.status = {
      state: "done",
      title: added.replaced ? "已替换清单中的同一条帖文" : "已加入合并清单",
      detail: `当前清单共 ${basketItems.length} 条帖文，可继续加入或直接合并概括。`,
      percent: 100
    };
  } catch (error) {
    mergeSlot.status = { state: "error", title: "未能加入清单", detail: error?.message || "发生未知错误。", percent: 0 };
  }
  if (currentView === "merge") renderMergeView();
}

async function removeBasketItem(id) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_REMOVE", id });
    if (!response?.ok) throw new Error(response?.error || "移除失败。");
    basketItems = response.basket || [];
    renderBasket();
  } catch (error) {
    mergeSlot.status = { state: "error", title: "移除失败", detail: error?.message || "发生未知错误。", percent: 0 };
    if (currentView === "merge") renderMergeView();
  }
}

async function clearBasket() {
  if (!basketItems.length) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_CLEAR" });
    if (!response?.ok) throw new Error(response?.error || "清空失败。");
  } catch (error) {
    mergeSlot.status = { state: "error", title: "清空失败", detail: error?.message || "发生未知错误。", percent: 0 };
    if (currentView === "merge") renderMergeView();
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

async function addScreenshotImagesToBasket(images, sourceUrl, writeStatus) {
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
  writeStatus({
    state: "done",
    title: "截图已识别并加入清单",
    detail: `当前清单共 ${basketItems.length} 条帖文${warningNote}。`,
    percent: 100
  });
  elements.screenshotUrl.value = "";
}

async function summarizeScreenshotImages(images, sourceUrl, writeStatus) {
  const recognized = await chrome.runtime.sendMessage({
    type: "XHS_AI_SCREENSHOT_RECOGNIZE",
    images,
    sourceUrl
  });
  if (!recognized?.ok || !recognized.payload) throw new Error(recognized?.error || "截图识别失败。");
  writeStatus({ state: "working", title: "正在撰写概括", detail: "截图证据已就绪，正在生成概括…", percent: 66 });
  const response = await chrome.runtime.sendMessage({
    type: "XHS_AI_SUMMARIZE",
    payload: recognized.payload,
    force: false
  });
  if (!response?.ok) throw new Error(response?.error || "概括未完成。");
  shotSingleSlot.result = response.result;
  shotSingleSlot.capture = recognized.payload;
  const warningNote = recognized.warnings?.length
    ? `；${recognized.warnings.length} 项信息未能完全识别（如时间、互动数）`
    : "";
  writeStatus({
    state: "done",
    title: "截图概括完成",
    detail: completionDetail(response.result, "已按固定格式生成，可直接复制。") + warningNote,
    percent: 100
  });
  elements.shotSingleUrl.value = "";
}

const ACCEPTED_SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];
const stagedScreenshots = { single: [], merge: [] };

// 点击拖放区、Ctrl+V 粘贴或拖入的图片都先进暂存区，凑齐同一条帖文的截图后由按钮统一提交识别。
async function stageScreenshotFiles(files) {
  if (!files?.length) return;
  const staged = stagedScreenshots[currentView];
  // 历史屏不接收截图
  if (!staged) return;
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
    const status = {
      state: "error",
      title: failures.length === files.length ? "截图未能添加" : "部分截图未能添加",
      detail: failures[0],
      percent: 0
    };
    // 报错写进当前视图正在看的槽位，不切换焦点（可能正有截图任务在跑）
    if (currentView === "merge") {
      if (mergeFocus === "shot") shotMergeStatus.status = status;
      else mergeSlot.status = status;
      renderStatus(status);
    } else if (currentView === "single") {
      if (singleFocus === "shot") shotSingleSlot.status = status;
      else writePageStatus(activeTabId, status);
      renderStatus(status);
    }
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
  const taskKey = view === "merge" ? "shot:merge" : "shot:single";
  const isMerge = view === "merge";
  if (!staged.length || tasks.has(taskKey)) return;
  if (isMerge) {
    mergeFocus = "shot";
  } else {
    singleFocus = "shot";
    if (currentView === "single") renderSingleView();
  }
  const writeStatus = (status) => {
    if (isMerge) {
      shotMergeStatus.status = status;
      if (currentView === "merge" && mergeFocus === "shot") renderStatus(status);
    } else {
      shotSingleSlot.status = status;
      if (currentView === "single" && singleFocus === "shot") renderStatus(status);
    }
    if (status.state === "working") {
      setTask(taskKey, { detail: status.detail, percent: status.percent });
    }
  };
  setTask(taskKey, {
    kind: "shot",
    title: isMerge ? "识别截图加入清单" : "识别截图并概括",
    detail: `共 ${staged.length} 张截图，正在提取帖文内容…`,
    percent: 15
  });
  writeStatus({ state: "working", title: "正在识别截图", detail: `共 ${staged.length} 张截图，正在提取帖文内容…`, percent: 15 });
  const committedIds = new Set(staged.map((item) => item.id));
  try {
    const images = staged.map((item) => item.dataUrl);
    const sourceUrlInput = isMerge ? elements.screenshotUrl : elements.shotSingleUrl;
    if (isMerge) {
      await addScreenshotImagesToBasket(images, sourceUrlInput.value.trim(), writeStatus);
    } else {
      await summarizeScreenshotImages(images, sourceUrlInput.value.trim(), writeStatus);
    }
    // 只移除本次提交的截图：识别期间新贴入的图片保留在暂存区
    stagedScreenshots[view] = stagedScreenshots[view].filter((item) => !committedIds.has(item.id));
    renderStaging();
  } catch (error) {
    writeStatus({ state: "error", title: "截图识别失败", detail: error?.message || "发生未知错误。", percent: 0 });
  } finally {
    removeTask(taskKey);
    if (currentView === (isMerge ? "merge" : "single")) renderCurrentView();
  }
}

async function runMergeSummarize(force = false) {
  if (tasks.has("merge") || !basketItems.length) return;
  mergeFocus = "merge";
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
  if (currentView === "merge") renderMergeView();
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
  if (currentView === "merge") renderMergeView();
}

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
    if (currentView === "merge" && mergeFocus === "merge") renderStatus(status);
  }
});

// —— Chrome 页签跟随：切到哪个页签，单条视图就显示哪个页签的状态与结果 ——

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
  })();
});

chrome.tabs.onRemoved?.addListener?.((tabId) => {
  pageSlots.delete(tabId);
  removeTask(pageTaskKey(tabId));
  if (activeTabId === tabId) activeTabId = null;
  refreshButtons();
});

// 任务条点击：页签任务跳到对应 Chrome 页签，其余任务切到自己的视图
elements.taskList.addEventListener("click", (event) => {
  const row = event.target?.closest?.(".task-item");
  if (!row) return;
  const task = tasks.get(row.dataset?.key);
  if (!task) return;
  if (task.kind === "page" && Number.isInteger(task.tabId)) {
    void (async () => {
      try {
        const tab = await chrome.tabs.update(task.tabId, { active: true });
        if (tab?.windowId != null) await chrome.windows?.update?.(tab.windowId, { focused: true });
      } catch {
        // 页签可能已被关闭
      }
    })();
    return;
  }
  if (task.key === "shot:single") {
    singleFocus = "shot";
    switchView("single");
    return;
  }
  if (task.key === "shot:merge") {
    mergeFocus = "shot";
    switchView("merge");
    return;
  }
  if (task.kind === "merge") switchView("merge");
});

elements.extractButton.addEventListener("click", runFullWorkflow);
elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.tabSingle.addEventListener("click", () => switchView("single"));
elements.tabMerge.addEventListener("click", () => switchView("merge"));
// 「历史」按钮是开关：进入历史屏，再点一次回到进入前的概括页签
elements.historyButton.addEventListener("click", () => {
  switchView(currentView === "history" ? tabBeforeHistory : "history");
});
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
  if (!row || event.target.closest?.(".merge-remove")) return;
  removeBasketItem(row.dataset?.id);
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

elements.regenerateButton.addEventListener("click", async () => {
  if (currentView === "merge") {
    await runMergeSummarize(true);
    return;
  }
  if (currentView !== "single") return;
  if (singleFocus === "shot") {
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
    if (tab?.id != null) activeTabId = tab.id;
  } catch {
    // 查询失败时等 onActivated 再跟进
  }
  switchView("single");
  restoreStoredView();
  refreshBasket();
  refreshHistory();
  refreshButtons();
  restoreCurrentWorkflow();
  hydrateWorkflows();
})();
