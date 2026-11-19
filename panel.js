const LIMIT = 50;
const LOGIN_REQUIRED_MESSAGE = "检测到当前小红书页面尚未登录。请先登录并刷新帖文详情页，再点击“提取并概括”。";
const WEIBO_LOGIN_REQUIRED_MESSAGE = "检测到当前微博页面尚未登录。请先登录 weibo.com 并刷新帖文页面，再点击“提取并概括”。";
// 链接概括：等待短链跳转与帖文渲染的总时长和轮询间隔
const LINK_OPEN_TIMEOUT_MS = 25000;
const LINK_POLL_INTERVAL_MS = 600;
// 补链接后给用户的反馈：编辑过的结果无法自动替换时，链接仍已保存，不能当错误提示
const RELINK_UPDATED_HINT = "链接已更新。";
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
  linkChoiceTitle: document.querySelector("#link-choice-title"),
  materialDropzone: document.querySelector("#material-dropzone"),
  materialStaging: document.querySelector("#material-staging"),
  stagingLink: document.querySelector("#staging-link"),
  stagingLinkValue: document.querySelector("#staging-link-value"),
  stagingLinkRemove: document.querySelector("#staging-link-remove"),
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
  basketHint: document.querySelector("#basket-hint"),
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
  feishuStaleHint: document.querySelector("#feishu-stale-hint"),
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
// 合并任务运行期间清单条目链接被改过：后台会把本次合并的飞书推送标为 deferred，
// 面板收到结果后先按当前清单重渲染，再推送最终文本（只发一条）。
let mergeLinkDirty = false;
// 正在延迟补发飞书的结果（按 historyId），期间禁止再手动点图标发第二条。
const feishuNotifyInFlight = new Set();
const HISTORY_HINT_TEXT = "概括成功后保存在本机（最多 100 条，超出自动淘汰最旧），可随时回看与复制。";

// —— 并行任务模型 ——
// 每个任务独立运行、只禁用自己的按钮，互不阻塞：
//   page:<tabId>  页签级采集概括（提取并概括 / 重新生成 / 加入清单的采集阶段）
//   merge         合并概括
//   shot:single   截图识别概括
//   shot:merge:<pendingId>  截图识别加入合并：每批截图一个任务，可同时识别多批
const tasks = new Map();
const pageSlots = new Map();
const mergeSlot = { status: null, result: null };
const shotSlot = { status: null, result: null, capture: null };
let stagedScreenshots = [];
// 挂在截图暂存卡上的原帖链接：贴链接时由用户明确选择「这是截图的原帖链接」才会挂上，
// 提交截图时只认它，不再从输入框里顺带读取。
let stagedShotLink = null;
// 已点「加入合并」、还在识别（或识别失败）的截图批次。只存在于面板，识别成功才写进后台的合并条目。
//   { id, status: "working" | "error", error, staged, link, sentLink, countLabel }
let pendingShots = [];
let pendingShotSeq = 0;
const SHOT_PENDING_TASK_PREFIX = "shot:merge:";

// 结果与状态只属于当前焦点：tab 跟随活动页签，shot 归截图任务，merge 归合并任务。
// 合并概括区的说明：空的时候讲清用途，有条目后补一句链接可随时补
const BASKET_HINT_EMPTY = "同一事件的几条帖文（含截图）放进来，生成一份简报。";
const BASKET_HINT_FILLED = "同一事件的几条帖文（含截图）放在一起，生成一份简报；链接可随时补到任意一条上。";

const DEFAULT_STATUS = {
  tab: { state: "idle", title: "准备就绪", detail: "请先打开帖文详情页。", percent: 0 },
  shot: { state: "idle", title: "准备就绪", detail: "选择或粘贴截图后，可识别并概括，或加入合并。", percent: 0 },
  merge: { state: "idle", title: "准备就绪", detail: "把同一事件的几条帖文加入合并后，即可一键生成一份简报。", percent: 0 }
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
  if (platform === "xiaohongshu") return { label: "小红书", className: "merge-badge-xhs" };
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
  return { label: "小红书", className: "merge-badge-xhs" };
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
  // 当前帖文已在合并里时按钮标明状态并置灰，与结果卡的「加入合并」一致
  const currentInBasket = postPage && basketHasPayload(currentSlot()?.capture);
  elements.mergeAddButton.textContent = currentInBasket ? "✓ 已在合并里" : "＋ 加入合并";
  elements.mergeAddButton.disabled = tabBusy || !postPage || currentInBasket;
  elements.materialLinkButton.disabled = tasks.has("link");
  elements.shotSummarizeButton.disabled = tasks.has("shot:single");
  // 还有截图在识别或识别失败时先不合并，免得合并时漏掉它
  elements.mergeSummarizeButton.disabled = tasks.has("merge") || basketItems.length < 2 || pendingShots.length > 0;
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

// 页签内的地址变化（点开笔记这类前端跳转、刷新、前进后退）不触发 onActivated，
// 只靠页签切换更新地址会让「提取并概括 / 加入清单」停在上一次的非帖文地址上一直置灰。
// 收到 onUpdated 后重新读一次活动页签地址，地址没变就什么都不做。
let tabUrlSyncing = false;

async function syncActiveTabUrl() {
  if (tabUrlSyncing || activeTabId == null) return;
  if (typeof chrome.tabs?.get !== "function") return;
  tabUrlSyncing = true;
  const tabId = activeTabId;
  try {
    const tab = await chrome.tabs.get(tabId);
    // 等待期间切了页签：交给 onActivated 处理
    if (tabId !== activeTabId) return;
    const url = String(tab?.url || "");
    if (!url || url === activeTabUrl) return;
    activeTabUrl = url;
    const slot = pageSlots.get(tabId);
    if (slot?.context && !tasks.has(pageTaskKey(tabId))) {
      // 仍停在同一篇帖文（例如地址补了 xsec_token）就保留旧结果；
      // 换了帖子或离开帖文页则清槽位，避免按钮与结果沿用上一页的上下文。
      const platform = detectPostPlatform(url);
      const nextNoteId = platform ? noteIdFromUrlForPlatform(platform, url) : null;
      if (!nextNoteId || nextNoteId !== slot.context.noteId) pageSlots.delete(tabId);
    }
    if (historyVisible) refreshButtons();
    else renderFocus();
  } catch {
    // 页签已关闭或读取失败：保持当前显示，等 onRemoved / onActivated
  } finally {
    tabUrlSyncing = false;
  }
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
  if (result?.notification?.status === "deferred") return "概括已生成，链接更新后会自动推送到飞书。";
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
  if (tab?.id != null) return tab;
  // Edge 侧边栏里 currentWindow 偶尔解析不到浏览器窗口：退回最近获得焦点的窗口，
  // 否则面板会以为没有活动页签，按钮一直置灰。
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return fallback;
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
    let keepLocalSent = false;
    if (workflow.status === "done" && workflow.result) {
      // relink 的工作流广播可能晚于面板的延迟补发：同一条结果的本地已发送状态优先，
      // 避免把刚推送成功的 deferred 又冲回未发送。
      const nextResult = workflow.result;
      const previous = slot.result;
      keepLocalSent = nextResult.notification?.status === "deferred" &&
        Boolean(previous?.historyId) && previous.historyId === nextResult.historyId &&
        previous.notification?.status === "sent";
      slot.result = keepLocalSent
        ? { ...nextResult, notification: previous.notification }
        : nextResult;
    }
    // 保留本地已发送状态时也保留对应的状态文案（“链接已更新，并已推送到飞书”）
    if (!keepLocalSent) slot.status = statusFromWorkflow(workflow);
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
    const relinked = await settlePendingLinkAfterWorkflow(page.tabId, pendingGivenUrl);
    // 后台在链接归位前把推送标记为 deferred：现在用最终文本补发一次（只发这一条）
    await finalizeDeferredFeishu("tab", { tabId: page.tabId, relinked, title: "概括完成" });
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
    const relinked = await settlePendingLinkAfterWorkflow(page.tabId, null);
    await finalizeDeferredFeishu("tab", { tabId: page.tabId, relinked, title: "重新生成完成" });
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

// 补链接后的完成态状态卡：各补链接入口共用同一文案。
function relinkedStatus(linkApplied) {
  return { state: "done", title: "链接已更新", detail: relinkFeedbackText(linkApplied), percent: 100 };
}

// 单条结果补了链接：同一帖子的清单条目一起同步，并尝试原地重渲染合并结果；
// 合并正文因手工编辑未能替换时按 kept 上报。
async function applyLinkToMatchingBasket(payload, url, verified, linkApplied) {
  const id = payloadItemId(payload);
  if (!id || !basketItems.some((item) => item.id === id)) return linkApplied;
  await setBasketItemLink(id, url, verified);
  const merge = await rerenderMergeIfPossible();
  return merge.linkApplied === "kept" ? "kept" : linkApplied;
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
  const prefix = item.kind === "user_screenshot" ? "截图" : item.platform === "weibo" ? "微博" : "小红书";
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

function validateShotLinkOrNull(url) {
  try {
    return validateScreenshotLink(url);
  } catch {
    return null;
  }
}

// 输入框里能挂到截图上的链接；截图管线只覆盖小红书，微博链接不算。
function screenshotLinkFromMaterialInput() {
  const url = extractPostUrl(elements.materialInput?.value);
  return url ? validateShotLinkOrNull(url) : null;
}

function attachLinkToStagedShots(url) {
  stagedShotLink = url;
  elements.materialInput.value = "";
  renderStaging();
  showMaterialFeedback("链接已挂到截图上，识别时一起带入。");
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
    const linkApplied = await applyLinkToMatchingBasket(
      response.payload, targetUrl, verified, response.linkApplied || "rerendered");
    slot.status = relinkedStatus(linkApplied);
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
  let basketUpdated = false;
  if (itemId && basketItems.some((item) => item.id === itemId)) {
    basketUpdated = true;
    await setBasketItemLink(itemId, targetUrl, verified);
    mergeApplied = (await rerenderMergeIfPossible()).linkApplied;
  }
  if (focus.kind === "tab" && !historyVisible) renderCurrentPost();
  if (!slot.pendingGivenUrl) return { outcome: "none", linkApplied: null };
  return { outcome: "pending", linkApplied: mergeApplied, basketUpdated };
}

// 任务跑完后补上运行期间贴入的链接；只换链接，不调用模型。
// 返回本次是否真的发生了 relink，调用方据此选择延迟推送后的状态文案。
async function settlePendingLinkAfterWorkflow(tabId, usedGivenUrl) {
  const slot = pageSlots.get(tabId);
  if (!slot) return false;
  const latest = String(slot.pendingGivenUrl || "").trim();
  if (!latest) return false;
  if (latest === String(usedGivenUrl || "").trim()) {
    slot.pendingGivenUrl = null;
    slot.pendingGivenUrlVerified = false;
    return false;
  }
  if (!slot.result || !slot.capture) return false;
  const verified = Boolean(slot.pendingGivenUrlVerified);
  try {
    const response = await requestRelink(slot.capture, slot.result, latest, verified, {
      tabId,
      pageSessionId: slot.context?.pageSessionId || null
    });
    slot.capture = response.payload;
    slot.result = response.result;
    const linkApplied = await applyLinkToMatchingBasket(
      response.payload, latest, verified, response.linkApplied || "rerendered");
    slot.status = relinkedStatus(linkApplied);
    slot.pendingGivenUrl = null;
    slot.pendingGivenUrlVerified = false;
    if (focus.kind === "tab" && activeTabId === tabId && !historyVisible) renderFocus();
    showMaterialFeedback(relinkFeedbackText(linkApplied));
    return true;
  } catch (error) {
    // 补链接失败时保留 pending，下一次提取或加入清单还会再试
    showMaterialFeedback(error?.message || "链接更新失败。", "error");
    return false;
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
    shotSlot.status = relinkedStatus(linkApplied);
  } else {
    if (!slot) return { outcome: "none", linkApplied: null };
    slot.capture = response.payload;
    slot.result = response.result;
    slot.status = relinkedStatus(linkApplied);
  }
  return { outcome: "applied", linkApplied };
}

async function setBasketItemLink(id, url, verified) {
  // 合并任务运行中改条目链接：同步置脏标记，后台推送前查询到它就会推迟到重渲染之后
  if (tasks.has("merge")) mergeLinkDirty = true;
  const response = await chrome.runtime.sendMessage({
    type: "XHS_AI_MERGE_SET_LINK",
    id,
    givenUrl: url,
    verified
  });
  if (!response?.ok) throw new Error(response?.error || "合并条目的链接更新失败。");
  // rerender 需要改动前后的来源后缀与链接，才能保住合并结果里的手工编辑
  lastMergeLinkChange = response.linkChange || null;
  basketItems = response.basket || [];
  renderBasket();
}

async function rerenderMergeIfPossible() {
  if (!mergeSlot.result) {
    lastMergeLinkChange = null;
    return { linkApplied: null, unchanged: false };
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
      return { linkApplied: response.linkApplied || null, unchanged: false };
    }
    // unchanged：清单条目集合变了，后台拒绝原地重渲染
    return { linkApplied: null, unchanged: Boolean(response?.unchanged) };
  } catch {
    // 合并结果留在原样，不影响单条链接已经保存
    return { linkApplied: null, unchanged: false };
  }
}

// 两个行内链接编辑器（结果卡与清单条目）共用的保存流程：
// 清空 / 截图特判 / 域名校验 → 后台解析校验 → 指向不符时两步确认 → 应用并收起编辑框。
async function saveLinkEditor({ raw: rawInput, isScreenshot, targetNoteId, apply, close, showHint, showConfirm, rememberPending }) {
  // 与素材输入框同一套提取：粘进来的常是带全角括号或分享文案的整段文字，
  // 直接 new URL 会把黏尾的「）」编码成 %EF%BC%89 写进简报链接
  const raw = rawInput ? (extractPostUrl(rawInput) || rawInput) : rawInput;
  if (!raw) {
    try {
      await apply("", false);
      close();
    } catch (error) {
      showHint(error?.message || "链接更新失败。");
    }
    return;
  }
  if (isScreenshot) {
    try {
      const normalized = validateScreenshotLink(raw);
      await apply(normalized, false);
      close();
    } catch (error) {
      showHint(error?.message || "链接更新失败。");
    }
    return;
  }
  if (!isSupportedGivenLink(raw)) {
    showHint("请填写小红书或微博帖文链接。");
    return;
  }
  let resolved = null;
  try {
    resolved = await resolveLinkViaBackend(raw);
  } catch {
    resolved = null;
  }
  const mismatch = Boolean(resolved?.noteId && targetNoteId && resolved.noteId !== targetNoteId);
  if (mismatch) {
    rememberPending(raw);
    showConfirm("这条链接指向另一条帖文");
    return;
  }
  const verified = Boolean(resolved?.noteId && targetNoteId && resolved.noteId === targetNoteId);
  try {
    await apply(raw, verified);
    close();
  } catch (error) {
    showHint(error?.message || "链接更新失败。");
  }
}

// 保存结果卡片上的链接：解析只用于校验，不调用模型。
async function saveResultLink() {
  const payload = focusedPayload();
  if (!payload) return;
  elements.resultLinkHint.hidden = true;
  pendingResultLinkConfirm = null;
  await saveLinkEditor({
    raw: String(elements.resultLinkInput.value || "").trim(),
    isScreenshot: payload.source?.origin === "user_screenshot",
    targetNoteId: payload.source?.noteId || null,
    apply: applyGivenLinkToResult,
    close: closeResultLinkEditor,
    showHint: showResultLinkHint,
    showConfirm: showResultLinkConfirm,
    rememberPending: (url) => { pendingResultLinkConfirm = { url }; }
  });
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
  const linkApplied = await applyLinkToMatchingBasket(
    focusedPayload(), url, verified, applied.linkApplied);
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
  await saveLinkEditor({
    raw: String(elements.basketLinkInput.value || "").trim(),
    isScreenshot: item.kind === "user_screenshot",
    targetNoteId: id.replace(/^(?:note|wbnote):/, ""),
    apply: (url, verified) => applyGivenLinkToBasket(id, url, verified),
    close: closeBasketLinkEditor,
    showHint: showBasketLinkHint,
    showConfirm: showBasketLinkConfirm,
    rememberPending: (url) => { pendingBasketLinkConfirm = { id, url }; }
  });
}

async function applyGivenLinkToBasket(id, url, verified) {
  await setBasketItemLink(id, url, verified);
  const { outcome: relinkOutcome, linkApplied } = await syncResultAndMergeForBasketItem(id, url, verified);
  renderFocus();
  if (relinkOutcome === "blocked") {
    showMaterialFeedback("任务进行中，完成后才能清空链接。", "error");
  } else if (relinkOutcome === "task-pending") {
    showMaterialFeedback("任务完成后自动补上链接。");
  } else {
    showRelinkFeedback(linkApplied || "rerendered");
  }
}

function renderLinkChoice(title, options) {
  elements.linkChoiceTitle.textContent = title;
  elements.linkChoiceOptions.innerHTML = options.map((option) => (
    `<button class="link-choice-option" type="button" data-choice="${escapeHtml(option.choice)}" data-kind="${option.kind}">${escapeHtml(option.label)}</button>`
  )).join("");
  elements.linkChoice.hidden = false;
}

// 暂存区有截图时贴入小红书链接：先问清楚是截图的原帖链接，还是另一条帖文。
// 截图帖文没有帖子 ID，程序无从比对，只能让用户说；绝不按“链接和截图同时摆着”去猜。
function showShotLinkChoice(url) {
  pendingLinkChoice = { url, mode: "shot" };
  renderLinkChoice("这条链接是：", [
    { choice: "shot-stage", kind: "basket", label: "下面这组截图的原帖链接" },
    { choice: "resolve", kind: "new", label: "另一条帖文，识别它" }
  ]);
}

// 输入框里有小红书链接、暂存区有截图、链接还没挂上时询问一次。贴链接和贴截图谁先谁后都会走到这里。
function maybeOfferShotLink() {
  const url = stagedScreenshots.length ? screenshotLinkFromMaterialInput() : null;
  if (!url || url === stagedShotLink) {
    if (pendingLinkChoice?.mode === "shot") hideLinkChoice();
    return;
  }
  if (pendingLinkChoice?.url === url) return;
  showShotLinkChoice(url);
}

// 还没有链接的截图帖文：识别好的合并条目，以及识别中的批次（识别完再补上）
function linklessScreenshotTargets() {
  return [
    ...basketItems
      .filter((item) => item.kind === "user_screenshot" && !item.link)
      .map((item) => ({ choice: `basket:${item.id}`, kind: "basket", label: basketItemLabel(item) })),
    ...pendingShots
      .filter((pending) => pending.status === "working" && !pending.link)
      .map((pending) => ({ choice: `pending:${pending.id}`, kind: "basket", label: `截图（识别中，${pending.countLabel}）` }))
  ];
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
  renderLinkChoice("无法自动判断这条链接属于哪条帖文", options);
}

async function handleMaterialLink({ skipShotOffer = false } = {}) {
  const raw = elements.materialInput.value;
  const url = extractPostUrl(raw);
  if (!url) {
    showMaterialFeedback("没有找到小红书或微博帖文链接。", "error");
    hideLinkChoice();
    return;
  }
  hideLinkChoice();
  // 暂存区有截图时，小红书链接很可能就是截图的原帖链接：先问，不直接当新帖打开
  const shotLink = validateShotLinkOrNull(url);
  if (!skipShotOffer && stagedScreenshots.length && shotLink) {
    if (shotLink === stagedShotLink) {
      elements.materialInput.value = "";
      showMaterialFeedback("这条链接已经挂在截图上了。");
    } else {
      clearMaterialFeedback();
      showShotLinkChoice(shotLink);
    }
    return;
  }
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
    // 对不上任何已有素材，但还有没链接的截图帖文：原帖多半已删，直接打开只会得到死页面，先问是不是它们的链接
    const shotTargets = resolved.platform === "weibo" ? [] : linklessScreenshotTargets();
    if (shotTargets.length) {
      pendingLinkChoice = { url, mode: "attach" };
      clearMaterialFeedback();
      renderLinkChoice("这条链接没有对上已有帖文。是下面截图帖文的原帖链接吗？", [
        ...shotTargets,
        { choice: "new", kind: "new", label: "都不是，作为新帖打开" }
      ]);
      return;
    }
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
  let taskPending = false;
  let pendingOnly = false;
  let appliedAny = false;
  let kept = false;
  try {
    for (const match of matches) {
      if (match.kind === "tab") {
        const applied = await applyLinkToTab(url, true, { announce: false });
        if (applied.outcome === "task-pending") {
          taskPending = true;
        } else if (applied.outcome === "applied") {
          appliedAny = true;
          if (applied.linkApplied === "kept") kept = true;
        } else if (applied.outcome === "pending") {
          // 还没提取：链接只记在页签上，提取时再带入；同一次操作也更新了清单条目时按“链接已更新”提示
          if (applied.basketUpdated) appliedAny = true;
          else pendingOnly = true;
        }
      } else if (match.id !== tabMatchedItemId) {
        // 命中当前页签时 applyLinkToTab 已经同步了同一帖子的清单条目
        const applied = await applyLinkToBasketItemByMatch(match.id, url, true);
        appliedAny = true;
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
  } else if (appliedAny) {
    showRelinkFeedback("rerendered");
  } else if (pendingOnly) {
    showMaterialFeedback("已记下链接，提取时会带入。");
  } else {
    showRelinkFeedback(null);
  }
  renderFocus();
}

// 清单条目换了链接：焦点结果若是同一条帖子就一起补链接，再尝试重渲染合并结果。
// outcome 为结果卡的补链接情况（applied/blocked/task-pending），未涉及结果卡时为 null。
async function syncResultAndMergeForBasketItem(id, url, verified) {
  let outcome = null;
  let linkApplied = null;
  const payload = focusedPayload();
  if (payload && payloadItemId(payload) === id && currentResult()) {
    const applied = await relinkCurrentResultOnly(url, verified);
    outcome = applied.outcome;
    if (applied.outcome === "applied") linkApplied = applied.linkApplied;
  }
  const merge = await rerenderMergeIfPossible();
  if (merge.linkApplied === "kept") linkApplied = "kept";
  return { outcome, linkApplied, mergeApplied: merge.linkApplied };
}

// 从「添加素材」匹配到清单条目时的入口：不切换焦点
async function applyLinkToBasketItemByMatch(id, url, verified) {
  await setBasketItemLink(id, url, verified);
  const { linkApplied, mergeApplied } = await syncResultAndMergeForBasketItem(id, url, verified);
  return { linkApplied: linkApplied || mergeApplied };
}

async function chooseLinkTarget(choice) {
  const pending = pendingLinkChoice;
  if (!pending) return;
  const url = pending.url;
  if (choice === "resolve") {
    // 不是截图的链接：按普通链接识别（输入框内容保留给识别流程）
    hideLinkChoice();
    await handleMaterialLink({ skipShotOffer: true });
    return;
  }
  hideLinkChoice();
  if (choice === "shot-stage") {
    attachLinkToStagedShots(url);
    return;
  }
  if (choice.startsWith("pending:")) {
    const target = pendingShots.find((item) => item.id === choice.slice("pending:".length));
    elements.materialInput.value = "";
    if (!target || target.status !== "working") {
      showMaterialFeedback("这批截图已经识别完了，请在合并条目上点 ✎ 补链接。", "error");
      return;
    }
    target.link = validateShotLinkOrNull(url) || url;
    renderBasket();
    showMaterialFeedback("已记下链接，这批截图识别完会自动补上。");
    return;
  }
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
      } else if (applied.outcome === "pending") {
        showMaterialFeedback(applied.basketUpdated ? "链接已更新。" : "已记下链接，提取时会带入。");
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

// 识别中 / 识别失败的截图批次：显示在合并条目末尾，识别成功后原地换成正常条目
function renderPendingShot(pending) {
  const failed = pending.status === "error";
  const label = failed ? "识别失败" : "识别中…";
  const linkText = pending.link ? shortenLink(pending.link) : "未添加";
  const actions = failed
    ? `<p class="basket-pending-error">${escapeHtml(pending.error || "截图识别失败。")}</p>` +
      `<div class="basket-pending-actions">` +
      `<button class="merge-clear" type="button" data-pending-action="retry">重试</button>` +
      `<button class="merge-clear" type="button" data-pending-action="restore">放回暂存区</button>` +
      `</div>`
    : "";
  return `<li class="merge-item basket-item basket-pending" data-pending-id="${escapeHtml(pending.id)}" data-state="${failed ? "error" : "working"}">` +
    `<div class="basket-main">` +
    `<span class="merge-badge merge-badge-shot">截图</span>` +
    `<span class="merge-item-label">${failed ? "" : `<span class="task-spinner" aria-hidden="true"></span>`}${label}</span>` +
    `<span class="merge-item-meta">${escapeHtml(pending.countLabel)}</span>` +
    (failed
      ? `<button class="merge-remove" type="button" title="丢弃这批截图" data-pending-action="discard">✕</button>`
      : `<span></span>`) +
    `</div>` +
    `<div class="basket-link-line"><span class="basket-link-label">链接</span>` +
    `<span class="basket-pending-link" data-empty="${pending.link ? "false" : "true"}" title="${escapeHtml(pending.link || "")}">${escapeHtml(linkText)}</span></div>` +
    actions +
    `</li>`;
}

function pendingShotHint() {
  const working = pendingShots.filter((item) => item.status === "working").length;
  const failed = pendingShots.length - working;
  if (working) return `还有 ${working} 条截图在识别，识别完即可合并。`;
  if (failed) return `有 ${failed} 条截图识别失败，重试或移除后再合并。`;
  return "";
}

function renderBasket() {
  if (basketLinkEditingId && !basketItems.some((item) => item.id === basketLinkEditingId)) {
    basketLinkEditingId = null;
  }
  elements.basketList.innerHTML = basketItems.map((item) => {
    const isShot = item.kind === "user_screenshot";
    const isWeibo = !isShot && item.platform === "weibo";
    const badgeLabel = isShot ? "截图" : isWeibo ? "微博" : "小红书";
    const badgeClass = isShot ? "merge-badge-shot" : isWeibo ? "merge-badge-weibo" : "merge-badge-xhs";
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
  }).join("") + pendingShots.map(renderPendingShot).join("");
  const count = basketItems.length;
  // 识别中的截图也算一条：点下「加入合并」那一刻它就出现在这里
  const total = count + pendingShots.length;
  const hasMergeResult = Boolean(mergeSlot.result);
  // 空的时候也常驻一条窄提示：用户点「加入合并」之前就知道东西会去哪、能干什么
  elements.basketPanel.hidden = false;
  elements.basketPanel.dataset.empty = total === 0 ? "true" : "false";
  elements.basketHint.textContent = total === 0
    ? BASKET_HINT_EMPTY
    : BASKET_HINT_FILLED;
  elements.basketCount.textContent = String(total);
  elements.mergeClearButton.hidden = count === 0 && !pendingShots.some((item) => item.status === "error");
  elements.mergeSummarizeButton.hidden = total < 2;
  elements.mergeSummarizeLabel.textContent = `合并概括（${total} 条）`;
  const pendingHint = pendingShotHint();
  elements.basketSingleHint.textContent = pendingHint || "再加入至少 1 条即可合并。";
  elements.basketSingleHint.hidden = !pendingHint && total !== 1;
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
  // 当前帖文的「加入合并」要跟着条目增删切换「已在合并里」
  refreshButtons();
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
  elements.resultAddBasketButton.textContent = inBasket ? "✓ 已在合并里" : "加入合并";
  elements.resultAddBasketButton.disabled = inBasket;
}

async function addPayloadToBasket(payload) {
  const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_ADD", payload });
  if (!response?.ok) throw new Error(response?.error || "加入合并失败。");
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
        ? "合并里已有这条帖文，已替换为最新内容。"
        : `已加入合并，当前共 ${basketItems.length} 条。`;
      writePageStatus(tabId, { state: "done", title: "已加入合并", detail, percent: 100 });
      if (focus.kind !== "tab") showMaterialFeedback(detail);
      renderBasket();
      refreshButtons();
    } catch (error) {
      const status = { state: "error", title: "未能加入合并", detail: error?.message || "发生未知错误。", percent: 0 };
      writePageStatus(tabId, status);
      if (focus.kind !== "tab") showMaterialFeedback(status.detail, "error");
    }
    return;
  }

  let page;
  try {
    page = await prepareCurrentPage();
  } catch (error) {
    const status = { state: "error", title: "未能加入合并", detail: error?.message || "发生未知错误。", percent: 0 };
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
      ? "合并里已有这条帖文，已替换为最新内容。"
      : `合并里共 ${basketItems.length} 条帖文，可继续加入或直接合并概括。`;
    writePageStatus(page.tabId, { state: "done", title: "已加入合并", detail, percent: 100 });
    if (focus.kind !== "tab") showMaterialFeedback(detail);
  } catch (error) {
    const status = { state: "error", title: "未能加入合并", detail: error?.message || "发生未知错误。", percent: 0 };
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
      ? "合并里已有这条帖文，已替换为最新内容。"
      : `已加入合并，当前共 ${basketItems.length} 条。`;
    if (focus.kind === "shot") {
      shotSlot.status = { state: "done", title: "已加入合并", detail, percent: 100 };
    } else if (focus.kind === "tab" && activeTabId != null) {
      writePageStatus(activeTabId, { state: "done", title: "已加入合并", detail, percent: 100 });
    }
    renderFocus();
  } catch (error) {
    showMaterialFeedback(error?.message || "加入合并失败。", "error");
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
  const failedShots = pendingShots.filter((item) => item.status === "error");
  if (!basketItems.length && !failedShots.length) return;
  if (basketItems.length) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_CLEAR" });
      if (!response?.ok) throw new Error(response?.error || "清空失败。");
    } catch (error) {
      showMaterialFeedback(error?.message || "清空失败。", "error");
      return;
    }
  }
  // 识别失败的批次一起清掉；正在识别的请求已经发出，识别完仍会加进来
  pendingShots = pendingShots.filter((item) => item.status === "working");
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
  if (tasks.has("merge") || basketItems.length < 2 || pendingShots.length) return;
  focus = { kind: "merge" };
  if (historyVisible) {
    historyVisible = false;
    applyViewVisibility();
  }
  // 本次合并刚开始：之前积累的链接改动不算数，只记录运行期间的改动
  mergeLinkDirty = false;
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
  let relinked = false;
  let failed = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_MERGE_SUMMARIZE", force: Boolean(force) });
    if (!response?.ok) throw new Error(response?.error || "合并概括未完成。");
    mergeSlot.result = response.result;
    if (mergeSlot.result?.notification?.status === "deferred") {
      // 合并期间改过条目链接：先用当前清单原地重渲染，再推送最终文本（只发一条）
      let rerender = null;
      if (mergeLinkDirty) {
        rerender = await rerenderMergeIfPossible();
        relinked = Boolean(rerender.linkApplied);
      }
      await finalizeDeferredFeishu("merge", { relinked, title: force ? "重新生成完成" : "合并概括完成" });
      if (rerender?.unchanged) {
        showMaterialFeedback("合并条目已变化，本次合并结果未包含新的链接。");
      }
    } else if (mergeLinkDirty) {
      // 查询窗口后的极小竞态：已经发过就不再自动发第二条，只重渲染显示并让旧版本标记生效
      const rerender = await rerenderMergeIfPossible();
      if (rerender.unchanged) {
        showMaterialFeedback("合并条目已变化，本次合并结果未包含新的链接。");
      }
    }
  } catch (error) {
    failed = true;
    mergeSlot.status = { state: "error", title: "合并概括失败", detail: error?.message || "发生未知错误。", percent: 0 };
  } finally {
    mergeLinkDirty = false;
    removeTask("merge");
  }
  if (!failed && mergeSlot.result) {
    mergeSlot.status = {
      state: "done",
      title: force ? "重新生成完成" : "合并概括完成",
      detail: deferredPushDetail(mergeSlot.result, relinked) ||
        completionDetail(mergeSlot.result, `已合并 ${mergeSlot.result.postCount || basketItems.length} 条帖文，可直接复制。`),
      percent: 100
    };
  }
  if (focus.kind === "merge") renderFocus();
  else refreshButtons();
}

// —— 截图：一份暂存列表，两个提交动作 ——

function readImageFile(file, label) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`读取 ${label || file?.name || "图片"} 失败。`));
    reader.readAsDataURL(file);
  });
}

const ACCEPTED_SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];

// 普通截图不缩放或转码，原始文件直接转 data URL 上传，保住文字清晰度；长截图在暂存时按原分辨率切段（见下）。
// 但单条 chrome.runtime 消息没有官方文档的大小上限，走 Mojo IPC 序列化，实践中约 64 MB 处会直接失败
// （Chromium issue 420956735；Tampermonkey #2285 同类问题靠分块规避）。本批 data URL 总长超过
// 32 MB（留足 JSON 序列化余量）时提前拦下，提示分批识别，避免静默失败。
const SCREENSHOT_MESSAGE_MAX_CHARS = 32 * 1024 * 1024;

// —— 长截图自动切段 ——
// 图片模型推理前会把整张图缩到约 1300×1300 总像素，整张超长截图里的文字会被缩到看不清；
// 所以高度超过宽度 2.5 倍的截图在本地按原分辨率切成有重叠的几段（每段约一屏高），
// 复用截图提示词已有的「多张按顺序拼接、去掉重叠」规则；普通截图保持原样上传。
// DeepSeek 单边上限为 8192 像素，但同一请求达到 15 张及以上时降到 4096；暂存时还不知道本批最终几张，
// 所以每段一律控制在 4096 以内：先多切几段，切到单张段数上限仍超出（或宽度本身超出）时才等比缩小该段。
// 这一步缩小不损失可见信息：模型推理前本来就会把每张图缩到约 1300×1300 总像素，远小于 4096 边长。
const SCREENSHOT_SPLIT_RATIO = 2.5;
const SCREENSHOT_MAX_SIDE = 4096;
const SCREENSHOT_SPLIT_OVERLAP_RATIO = 0.08;
const SCREENSHOT_SPLIT_OVERLAP_MIN = 120;
// 与 service-worker.js 的 MAX_SCREENSHOT_IMAGES 保持一致：长截图切段后会占多张。
const SCREENSHOT_BATCH_LIMIT = 20;
// 与后台 MAX_MERGE_ITEMS 一致：识别中的截图批次也算名额，避免识别完才发现放不下
const MERGE_ITEM_LIMIT = 5;

// 返回每段的源图起始 y、源图高度和输出尺寸；不需要处理时返回 null。段间按比例重叠，避免文字行正好被切断。
// 只缩不切的情况（宽度超过上限、高度不长）返回单段。
function planScreenshotSlices(width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  const isLong = height > width * SCREENSHOT_SPLIT_RATIO;
  if (!isLong && width <= SCREENSHOT_MAX_SIDE && height <= SCREENSHOT_MAX_SIDE) return null;

  // 宽度超过上限时整张按比例缩到上限宽，切段在源图上算，段高上限也按同一比例换算回源图像素。
  const widthScale = Math.min(1, SCREENSHOT_MAX_SIDE / width);
  const sourceMaxHeight = widthScale < 1 ? width : SCREENSHOT_MAX_SIDE;
  const outputSize = (partHeight, scale) => ({
    outputWidth: Math.max(1, Math.min(SCREENSHOT_MAX_SIDE, Math.round(width * scale))),
    outputHeight: Math.max(1, Math.min(SCREENSHOT_MAX_SIDE, Math.round(partHeight * scale)))
  });
  if (height <= sourceMaxHeight && !isLong) {
    return [{ y: 0, height, ...outputSize(height, widthScale) }];
  }

  const targetHeight = Math.max(1, Math.min(sourceMaxHeight, Math.round(width * SCREENSHOT_SPLIT_RATIO)));
  const overlap = Math.min(
    Math.max(SCREENSHOT_SPLIT_OVERLAP_MIN, Math.round(targetHeight * SCREENSHOT_SPLIT_OVERLAP_RATIO)),
    Math.floor(targetHeight / 3)
  );
  let count = Math.max(2, Math.ceil((height - overlap) / (targetHeight - overlap)));
  // 单张长图最多占满一批；切段再多也会超过后台的单次张数上限，反而无法提交。
  if (count > SCREENSHOT_BATCH_LIMIT) count = SCREENSHOT_BATCH_LIMIT;
  const sliceHeight = Math.ceil((height + (count - 1) * overlap) / count);
  // 段数封顶后每段仍超过上限：各段等比缩小到上限内，不再要求用户自己拆图。
  const scale = Math.min(widthScale, SCREENSHOT_MAX_SIDE / sliceHeight);
  const slices = [];
  for (let index = 0; index < count; index += 1) {
    const y = index * (sliceHeight - overlap);
    const partHeight = Math.min(sliceHeight, height - y);
    if (partHeight <= 0) break;
    slices.push({ y, height: partHeight, ...outputSize(partHeight, scale) });
  }
  return slices;
}

async function loadScreenshotBitmap(file) {
  // 解不出尺寸（老浏览器或损坏文件）时退回原样上传，让接口报错，不在这里吞掉。
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("长截图切段失败，请重试。"));
    }, mime, quality);
  });
}

async function splitScreenshotFile(file, bitmap, slices) {
  // 保留源图的文本清晰度：PNG 仍出 PNG；JPEG / WebP 按高质量 JPEG 重新编码，避免切段后体积失控。
  const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
  const quality = mime === "image/jpeg" ? 0.95 : undefined;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法切分长截图，请先把长图拆小后再上传。");
  const dataUrls = [];
  for (const slice of slices) {
    const outputWidth = slice.outputWidth || bitmap.width;
    const outputHeight = slice.outputHeight || slice.height;
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    // 画布尺寸变化会重置上下文状态，每段都要重新设置；只在需要缩小时才用到插值质量。
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    // JPEG 不支持透明，先铺白底，避免透明区域变黑；PNG 保留原始透明通道。
    if (mime === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(bitmap, 0, slice.y, bitmap.width, slice.height, 0, 0, outputWidth, outputHeight);
    const blob = await canvasToBlob(canvas, mime, quality);
    const partLabel = slices.length > 1 ? `（第 ${dataUrls.length + 1}/${slices.length} 段）` : "";
    dataUrls.push(await readImageFile(blob, `${file.name || "剪贴板图片"}${partLabel}`));
  }
  return dataUrls;
}

function makeStagedScreenshot(name, dataUrl) {
  return {
    id: `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    dataUrl
  };
}

// 暂存区按「原截图」分组显示：长截图内部虽然拆成多段，界面上仍是一张图，只标注自动切成了几段。
function stagedScreenshotGroups() {
  const groups = [];
  const byKey = new Map();
  for (const item of stagedScreenshots) {
    const key = item.groupId || item.id;
    let group = byKey.get(key);
    if (!group) {
      group = { key, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

function stagedScreenshotCountLabel() {
  const groups = stagedScreenshotGroups();
  return groups.length < stagedScreenshots.length
    ? `共 ${groups.length} 张截图（自动切成 ${stagedScreenshots.length} 段）`
    : `共 ${groups.length} 张截图`;
}

function screenshotBatchLimitMessage() {
  const groups = stagedScreenshotGroups();
  const splitNote = groups.length < stagedScreenshots.length
    ? `（长图自动切段后共 ${stagedScreenshots.length} 段）`
    : "";
  return `单次最多识别 ${SCREENSHOT_BATCH_LIMIT} 张截图${splitNote}，当前暂存 ${groups.length} 张，请先移除部分截图（长截图会整组移除）。`;
}

// 单张文件 → 一条或多条暂存项。长图返回切段后的多张，并带上切段信息供界面提示。
async function prepareScreenshotStaging(file) {
  const label = file.name || "剪贴板图片";
  const bitmap = await loadScreenshotBitmap(file);
  if (bitmap) {
    try {
      const slices = planScreenshotSlices(bitmap.width, bitmap.height);
      // 只超宽、不够长的图：等比缩到单边上限内，仍是一张普通截图，不提示用户。
      if (slices?.length === 1) {
        const [dataUrl] = await splitScreenshotFile(file, bitmap, slices);
        return { items: [makeStagedScreenshot(label, dataUrl)], split: null };
      }
      if (slices) {
        const dataUrls = await splitScreenshotFile(file, bitmap, slices);
        const groupId = `shot-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        return {
          items: dataUrls.map((dataUrl, index) => ({
            ...makeStagedScreenshot(`${label}（第 ${index + 1}/${dataUrls.length} 段）`, dataUrl),
            groupId,
            sourceName: label,
            partIndex: index + 1,
            partCount: dataUrls.length
          })),
          split: { label, width: bitmap.width, height: bitmap.height, count: dataUrls.length }
        };
      }
    } finally {
      bitmap.close?.();
    }
  }
  return { items: [makeStagedScreenshot(label, await readImageFile(file))], split: null };
}

// 点击拖放区、Ctrl+V 粘贴或拖入的图片都进同一份暂存列表，凑齐后由按钮统一提交。
async function stageScreenshotFiles(files) {
  if (!files?.length) return;
  const failures = [];
  const splits = [];
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
      const staged = await prepareScreenshotStaging(file);
      stagedScreenshots.push(...staged.items);
      if (staged.split) splits.push(staged.split);
    } catch (error) {
      failures.push(error?.message || `读取 ${label} 失败。`);
    }
  }
  renderStaging();
  // 先贴了链接、后加截图：问一句要不要把输入框里的链接挂上
  maybeOfferShotLink();
  if (failures.length) {
    showMaterialFeedback(failures[0], "error");
  } else if (stagedScreenshots.length > SCREENSHOT_BATCH_LIMIT) {
    showMaterialFeedback(screenshotBatchLimitMessage(), "error");
  } else if (splits.length) {
    const parts = splits.reduce((sum, split) => sum + split.count, 0);
    showMaterialFeedback(
      splits.length === 1
        ? `「${splits[0].label}」是长截图（${splits[0].width}×${splits[0].height}），识别时会自动切成 ${splits[0].count} 段上传，文字更清晰。`
        : `已自动切分 ${splits.length} 张长截图，共 ${parts} 段，识别时文字更清晰。`
    );
  }
}

function renderStaging() {
  const groups = stagedScreenshotGroups();
  elements.materialStaging.innerHTML = groups.map((group) => {
    const first = group.items[0];
    const segmentCount = group.items.length;
    // 长截图在暂存区仍只显示一张缩略图，角标标注识别时会自动切成几段。
    const partBadge = segmentCount > 1
      ? `<span class="staging-part">长图 · ${segmentCount} 段</span>`
      : "";
    const title = segmentCount > 1
      ? `${first.sourceName || first.name}（长图，识别时自动切成 ${segmentCount} 段）`
      : first.name;
    const removeLabel = segmentCount > 1
      ? `移除整张截图（长图自动切成 ${segmentCount} 段）`
      : `移除 ${first.name}`;
    return `<li class="staging-item">${partBadge}<img src="${escapeHtml(first.dataUrl)}" alt="${escapeHtml(title)}" title="${escapeHtml(title)}">` +
      `<button class="staging-remove" type="button" data-id="${escapeHtml(first.id)}" aria-label="${escapeHtml(removeLabel)}">×</button></li>`;
  }).join("");
  const count = groups.length;
  elements.materialStaging.hidden = count === 0;
  elements.materialShotActions.hidden = count === 0;
  // 原帖链接挂在暂存卡上，提交前一眼看得到链接跟着哪组截图
  elements.stagingLink.hidden = count === 0;
  elements.stagingLink.dataset.empty = stagedShotLink ? "false" : "true";
  elements.stagingLinkValue.textContent = stagedShotLink
    ? shortenLink(stagedShotLink)
    : "未添加（把原帖链接贴到上方输入框即可挂上）";
  elements.stagingLinkValue.title = stagedShotLink || "";
  elements.stagingLinkRemove.hidden = !stagedShotLink;
  elements.shotSummarizeButton.textContent = count > 1 ? `识别这 ${count} 张截图并概括` : "识别这张截图并概括";
  elements.shotBasketButton.textContent = count > 1 ? `识别这 ${count} 张截图并加入合并` : "识别这张截图并加入合并";
}

// 图片模型因图片过大、尺寸或长宽比超限拒收时，接口的原始报错原样透出，并附拆分建议；其余错误不加工。
function screenshotRecognitionError(recognized) {
  const message = recognized?.error || "截图识别失败。";
  return message.includes("模型请求失败") ? `${message}。可把长截图拆成几张再上传。` : message;
}

async function summarizeScreenshotImages(images, writeStatus, sourceUrl) {
  const recognized = await chrome.runtime.sendMessage({
    type: "XHS_AI_SCREENSHOT_RECOGNIZE",
    images,
    ...(sourceUrl ? { sourceUrl } : {})
  });
  if (!recognized?.ok || !recognized.payload) throw new Error(screenshotRecognitionError(recognized));
  shotSlot.capture = recognized.payload;
  writeStatus({ state: "working", title: "正在撰写概括", detail: "截图证据已就绪，正在生成概括…", percent: 66 });
  const response = await chrome.runtime.sendMessage({
    type: "XHS_AI_SUMMARIZE",
    payload: recognized.payload,
    force: false
  });
  if (!response?.ok) throw new Error(response?.error || "概括未完成。");
  shotSlot.result = response.result;
  const dateNote = recognized.dateNotice ? `；${recognized.dateNotice}` : "";
  const warningNote = recognized.warnings?.length
    ? `；${recognized.warnings.length} 项信息未能完全识别（如时间、互动数）`
    : "";
  writeStatus({
    state: "done",
    title: "截图概括完成",
    detail: completionDetail(response.result, "已按固定格式生成，可直接复制。") + dateNote + warningNote,
    percent: 100
  });
}

// 识别前的统一检查：张数与体积超限时提前拦下，不让后台静默失败
function checkScreenshotBatch(items) {
  // 长截图切段后张数会变多，先按后台的单次上限拦下，避免提交后才报错
  if (items.length > SCREENSHOT_BATCH_LIMIT) throw new Error(screenshotBatchLimitMessage());
  const totalChars = items.reduce((sum, item) => sum + String(item.dataUrl).length, 0);
  if (totalChars > SCREENSHOT_MESSAGE_MAX_CHARS) throw new Error("截图总体积过大，请分批识别。");
}

function pendingShotTaskKey(pending) {
  return `${SHOT_PENDING_TASK_PREFIX}${pending.id}`;
}

// 「识别并加入合并」：截图立刻从暂存区搬进合并概括，成为一条「识别中」的占位条目；
// 暂存区马上空出来，可以接着贴下一条帖文的截图，几批同时识别。
function commitScreenshotsToMerge() {
  if (!stagedScreenshots.length) return;
  try {
    checkScreenshotBatch(stagedScreenshots);
    const queued = basketItems.length + pendingShots.filter((item) => item.status === "working").length;
    if (queued >= MERGE_ITEM_LIMIT) {
      throw new Error(`合并概括最多放 ${MERGE_ITEM_LIMIT} 条帖文，请先移除部分条目。`);
    }
  } catch (error) {
    showMaterialFeedback(error?.message || "截图识别失败。", "error");
    return;
  }
  const pending = {
    id: `pending-${++pendingShotSeq}`,
    status: "working",
    error: null,
    staged: stagedScreenshots,
    link: stagedShotLink,
    sentLink: null,
    countLabel: stagedScreenshotCountLabel()
  };
  stagedScreenshots = [];
  stagedShotLink = null;
  if (pendingLinkChoice?.mode === "shot") hideLinkChoice();
  pendingShots.push(pending);
  renderStaging();
  showMaterialFeedback("已放进合并概括，正在识别；可以接着添加下一条帖文的截图。");
  void runPendingShot(pending);
}

async function runPendingShot(pending) {
  const taskKey = pendingShotTaskKey(pending);
  pending.status = "working";
  pending.error = null;
  pending.sentLink = pending.link;
  setTask(taskKey, {
    kind: "shot",
    title: "识别截图加入合并",
    detail: `${pending.countLabel}，正在提取帖文内容…`,
    percent: 15
  });
  renderBasket();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "XHS_AI_SCREENSHOT_ADD",
      images: pending.staged.map((item) => item.dataUrl),
      ...(pending.sentLink ? { sourceUrl: pending.sentLink } : {})
    });
    if (!response?.ok) throw new Error(screenshotRecognitionError(response));
    pendingShots = pendingShots.filter((item) => item !== pending);
    basketItems = response.basket || [];
    // 识别期间才补上的链接：条目落地后按普通补链接写进去
    let lateLinkNote = "";
    if (pending.link && pending.link !== pending.sentLink && response.id) {
      try {
        await setBasketItemLink(response.id, pending.link, false);
        lateLinkNote = "，识别期间补的链接已带上";
      } catch (error) {
        lateLinkNote = `；链接未能补上（${error?.message || "未知错误"}），可在条目上点 ✎ 重补`;
      }
    }
    renderBasket();
    const dateNote = response.dateNotice ? `；${response.dateNotice}` : "";
    const warningNote = response.warnings?.length
      ? `；${response.warnings.length} 项信息未能完全识别（如时间、互动数）`
      : "";
    const linkNote = pending.sentLink ? "，已带上原帖链接" : "";
    showMaterialFeedback(`截图已识别并加入合并，当前共 ${basketItems.length} 条${linkNote}${lateLinkNote}${dateNote}${warningNote}。`);
  } catch (error) {
    pending.status = "error";
    pending.error = error?.message || "截图识别失败。";
    renderBasket();
    showMaterialFeedback(`有一批截图识别失败，可在合并概括里重试或放回暂存区。`, "error");
  } finally {
    removeTask(taskKey);
    renderBasket();
  }
}

// 识别失败的占位条目：重试、放回暂存区，或直接丢弃
function handlePendingShotAction(id, action) {
  const pending = pendingShots.find((item) => item.id === id);
  if (!pending || pending.status !== "error") return;
  if (action === "retry") {
    void runPendingShot(pending);
    return;
  }
  pendingShots = pendingShots.filter((item) => item !== pending);
  if (action === "restore") {
    stagedScreenshots = stagedScreenshots.concat(pending.staged);
    if (pending.link && !stagedShotLink) stagedShotLink = pending.link;
    renderStaging();
    showMaterialFeedback("截图已放回暂存区。");
  }
  renderBasket();
}

async function commitStagedScreenshots(mode) {
  if (mode === "basket") {
    commitScreenshotsToMerge();
    return;
  }
  const taskKey = "shot:single";
  if (!stagedScreenshots.length || tasks.has(taskKey)) return;
  const countLabel = stagedScreenshotCountLabel();
  focus = { kind: "shot" };
  if (historyVisible) {
    historyVisible = false;
    applyViewVisibility();
  }
  renderFocus();
  const writeStatus = (status) => {
    shotSlot.status = status;
    if (focus.kind === "shot" && !historyVisible) renderStatus(status);
    if (status.state === "working") {
      setTask(taskKey, { detail: status.detail, percent: status.percent });
    }
  };
  setTask(taskKey, {
    kind: "shot",
    title: "识别截图并概括",
    detail: `${countLabel}，正在提取帖文内容…`,
    percent: 15
  });
  writeStatus({ state: "working", title: "正在识别截图", detail: `${countLabel}，正在提取帖文内容…`, percent: 15 });
  const committedIds = new Set(stagedScreenshots.map((item) => item.id));
  // 只带暂存卡上挂着的链接，不再从输入框顺带读取
  const givenLink = stagedShotLink;
  try {
    checkScreenshotBatch(stagedScreenshots);
    await summarizeScreenshotImages(stagedScreenshots.map((item) => item.dataUrl), writeStatus, givenLink);
    // 只移除本次提交的截图：识别期间新贴入的图片保留在暂存区
    stagedScreenshots = stagedScreenshots.filter((item) => !committedIds.has(item.id));
    if (givenLink && stagedShotLink === givenLink) stagedShotLink = null;
    renderStaging();
  } catch (error) {
    writeStatus({ state: "error", title: "截图识别失败", detail: error?.message || "发生未知错误。", percent: 0 });
  } finally {
    removeTask(taskKey);
    if (focus.kind === "shot") renderFocus();
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

function showLinkHint(hintElement, text) {
  hintElement.textContent = text;
  hintElement.hidden = false;
}

function showLinkConfirm(hintElement, text) {
  hintElement.hidden = false;
  hintElement.innerHTML = `${escapeHtml(text)} ` +
    `<button type="button" data-link-choice="use">仍然使用</button>` +
    `<button type="button" data-link-choice="cancel">取消</button>`;
}

const showResultLinkHint = (text) => showLinkHint(elements.resultLinkHint, text);
const showResultLinkConfirm = (text) => showLinkConfirm(elements.resultLinkHint, text);
const showBasketLinkHint = (text) => showLinkHint(elements.basketLinkHint, text);
const showBasketLinkConfirm = (text) => showLinkConfirm(elements.basketLinkHint, text);

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

// —— 手动发送 / 延迟推送飞书 ——

const FEISHU_SEND_LABEL = "发送到飞书";
const FEISHU_STALE_OLD_HINT = "飞书里仍是旧版本，点飞书图标重发当前内容。";
const FEISHU_STALE_DEFERRED_HINT = "这条概括还没有推送到飞书，点飞书图标发送当前内容。";
const FEISHU_STALE_OLD_LABEL = "飞书里仍是旧版本，点击重发";
const FEISHU_STALE_DEFERRED_LABEL = "还没有推送到飞书，点击发送";

async function refreshFeishuStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "XHS_AI_GET_FEISHU_STATUS" });
    feishuConfigured = Boolean(response?.ok && response.configured);
  } catch {
    feishuConfigured = false;
  }
  refreshFeishuButton();
}

// 历史屏查看的也是结果卡，旧版本提示同样适用
function feishuDisplayedResult() {
  if (historyVisible) return historyEntry?.result || null;
  return currentResult();
}

// 飞书里是否还是旧版本：deferred 表示从未推送；sent 时比较最后一次实际发送的文本。
// 旧数据没有 sentText，无法判断，按不标记处理，不报错。
function feishuStaleState(result) {
  const notification = result?.notification;
  if (!notification) return null;
  if (notification.status === "deferred") return "deferred";
  if (notification.status !== "sent") return null;
  if (typeof notification.sentText !== "string") return null;
  return String(result.text ?? "").trim() === notification.sentText.trim() ? null : "stale";
}

function setFeishuButtonLabel(label) {
  elements.sendFeishuButton.title = label;
  elements.sendFeishuButton.setAttribute?.("title", label);
  elements.sendFeishuButton.setAttribute?.("aria-label", label);
}

function refreshFeishuStaleHint() {
  const stale = feishuConfigured && !elements.resultCard.hidden ? feishuStaleState(feishuDisplayedResult()) : null;
  if (!stale) {
    elements.feishuStaleHint.hidden = true;
    elements.feishuStaleHint.textContent = "";
    return;
  }
  elements.feishuStaleHint.textContent = stale === "deferred" ? FEISHU_STALE_DEFERRED_HINT : FEISHU_STALE_OLD_HINT;
  elements.feishuStaleHint.hidden = false;
}

function refreshFeishuButton() {
  const visible = Boolean(feishuConfigured && !elements.resultCard.hidden);
  elements.sendFeishuButton.hidden = !visible;
  const stale = visible ? feishuStaleState(feishuDisplayedResult()) : null;
  if (stale) {
    elements.sendFeishuButton.dataset.stale = "true";
    setFeishuButtonLabel(stale === "deferred" ? FEISHU_STALE_DEFERRED_LABEL : FEISHU_STALE_OLD_LABEL);
  } else {
    delete elements.sendFeishuButton.dataset.stale;
    setFeishuButtonLabel(FEISHU_SEND_LABEL);
  }
  refreshFeishuStaleHint();
}

// 延迟推送完成后的状态文案；链接确实归位时才说明“链接已更新”
function deferredPushDetail(result, relinked) {
  const notification = result?.notification;
  if (notification?.status === "sent") {
    return relinked ? "链接已更新，并已推送到飞书。" : "概括已生成，并已推送到飞书。";
  }
  if (notification?.status === "failed") {
    return `概括已生成；飞书推送失败：${notification.error || "请检查设置。"}`;
  }
  return null;
}

function feishuResultKey(result) {
  return result?.historyId || result;
}

function currentResultForTarget(target, tabId) {
  if (target === "merge") return mergeSlot.result;
  return Number.isInteger(tabId) ? pageSlots.get(tabId)?.result || null : null;
}

// await 期间槽位结果可能被迟到的 XHS_AI_WORKFLOW_STATE 广播换掉：
// 补发完成后要按 historyId 找当前对象再写，否则 sent 会写到旧对象上、界面仍显示 deferred。
function latestResultForTarget(target, tabId, historyId) {
  const current = currentResultForTarget(target, tabId);
  if (!current) return null;
  if (historyId && current.historyId !== historyId) return null;
  return current;
}

// 后台把推送标成 deferred 后，面板补完链接用最终文本补发一次；结果卡与历史里的状态随之更新。
async function finalizeDeferredFeishu(target, { tabId = activeTabId, relinked = false, title = null } = {}) {
  const slot = target === "merge" ? mergeSlot : (Number.isInteger(tabId) ? pageSlots.get(tabId) : null);
  const result = slot?.result || null;
  if (!result || result.notification?.status !== "deferred") return null;
  const historyId = result.historyId || null;
  const statusTitle = title || (target === "merge" ? "合并概括完成" : "概括完成");
  const text = String(result.text ?? "").trim();
  feishuNotifyInFlight.add(historyId || result);
  try {
    let notification;
    if (!text) {
      notification = { status: "failed", error: "没有可推送的概括内容。" };
    } else {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "XHS_AI_NOTIFY_FEISHU_RESULT",
          text,
          kind: target === "merge" ? "merge" : "single",
          ...(historyId ? { historyId } : {}),
          ...(target === "tab" && Number.isInteger(tabId) ? { tabId } : {}),
          ...(target === "tab" && slot?.context?.pageSessionId ? { pageSessionId: slot.context.pageSessionId } : {})
        });
        if (!response?.ok) throw new Error(response?.error || "飞书推送失败。");
        notification = response.notification || null;
      } catch (error) {
        notification = { status: "failed", error: String(error?.message || "飞书推送失败。").slice(0, 180) };
      }
    }
    // 慢请求期间结果对象可能已被广播替换：当前对象优先，历史 ID 对不上（新一代替换）时不覆盖新结果
    const latest = latestResultForTarget(target, tabId, historyId);
    const written = latest || result;
    if (notification) written.notification = notification;
    else delete written.notification;
    if (latest) {
      const status = {
        state: "done",
        title: statusTitle,
        detail: deferredPushDetail(latest, relinked) || "概括已生成，可直接复制。",
        percent: 100
      };
      if (target === "merge") {
        mergeSlot.status = status;
        if (focus.kind === "merge" && !historyVisible) {
          renderStatus(status);
          renderResult(latest);
        }
      } else {
        writePageStatus(tabId, status);
        if (focus.kind === "tab" && activeTabId === tabId && !historyVisible) renderResult(latest);
      }
    }
    return notification;
  } finally {
    feishuNotifyInFlight.delete(historyId || result);
  }
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

// 手动发送要带上结果上下文，后台才能把 sentText 写回历史与工作流快照。
function feishuSendContext() {
  if (historyVisible && historyEntry) {
    return {
      kind: historyEntry.kind === "merge" ? "merge" : historyEntry.kind === "screenshot" ? "screenshot" : "single",
      historyId: historyEntry.id
    };
  }
  const result = currentResult();
  const context = {
    kind: focus.kind === "merge" ? "merge" : focus.kind === "shot" ? "screenshot" : "single",
    ...(result?.historyId ? { historyId: result.historyId } : {})
  };
  if (focus.kind === "tab" && Number.isInteger(activeTabId)) {
    context.tabId = activeTabId;
    const pageSessionId = currentSlot()?.context?.pageSessionId;
    if (pageSessionId) context.pageSessionId = pageSessionId;
  }
  return context;
}

// 手动发送成功后，若结果仍在当前焦点显示，状态行改为“已推送到飞书。”，标题保持原样。
function markFeishuResultPushed(result) {
  if (!result || historyVisible) return;
  const detail = "已推送到飞书。";
  if (focus.kind === "tab" && Number.isInteger(activeTabId)) {
    const slot = pageSlots.get(activeTabId);
    if (slot?.result === result && slot.status?.state === "done") {
      writePageStatus(activeTabId, { ...slot.status, detail });
    }
    return;
  }
  if (focus.kind === "merge") {
    if (mergeSlot.result !== result || mergeSlot.status?.state !== "done") return;
    mergeSlot.status = { ...mergeSlot.status, detail };
    renderStatus(mergeSlot.status);
    return;
  }
  if (focus.kind === "shot") {
    if (shotSlot.result !== result || shotSlot.status?.state !== "done") return;
    shotSlot.status = { ...shotSlot.status, detail };
    renderStatus(shotSlot.status);
  }
}

async function sendResultToFeishu() {
  const text = elements.resultText.value.trim();
  if (!text) {
    showFeishuFeedback("没有可发送的内容。", "error");
    return;
  }
  const result = feishuDisplayedResult();
  // 延迟补发还在路上：此时再点图标会发出第二条，先挡住
  if (result && feishuNotifyInFlight.has(feishuResultKey(result))) {
    showFeishuFeedback("正在推送飞书，请稍候。");
    return;
  }
  elements.sendFeishuButton.disabled = true;
  hideFeishuFeedback();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "XHS_AI_SEND_FEISHU",
      text,
      ...feishuSendContext()
    });
    if (!response?.ok) throw new Error(response?.error || "发送到飞书失败。");
    const notification = response.notification || {
      status: "sent",
      channel: response.channel || null,
      sentAt: Date.now(),
      sentText: text
    };
    if (result) {
      // await 期间结果对象可能被广播替换：优先写到当前显示的对象上
      const current = feishuDisplayedResult();
      const written = current && feishuResultKey(current) === feishuResultKey(result) ? current : result;
      written.notification = notification;
      markFeishuResultPushed(written);
    }
    showFeishuFeedback("已发送到飞书。");
  } catch (error) {
    showFeishuFeedback(error?.message || "发送到飞书失败。", "error");
  } finally {
    elements.sendFeishuButton.disabled = false;
    refreshFeishuButton();
  }
}

// —— 历史屏 ——

function historyBadge(item) {
  if (item.kind === "merge") return { label: "合并", className: "merge-badge-merge" };
  if (item.kind === "screenshot") return { label: "截图", className: "merge-badge-shot" };
  if (item.platform === "weibo") return { label: "微博", className: "merge-badge-weibo" };
  return { label: "小红书", className: "merge-badge-xhs" };
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

// 后台推送飞书前同步询问：这个页签/本次合并是否还有更新的待补链接。
// 有 pending 就答 true，即便本窗口已经切到别的页签（pending 仍在槽位里）；
// 没有 pending 时只有当前活动页签就是这个页签的面板才答 false，
// 其它窗口的侧边栏不响应，避免它们抢先答 false 让后台立即推送旧链接。
// 没有合并任务时不响应。
function answerPendingLinkQuery(message, sendResponse) {
  if (typeof sendResponse !== "function") return false;
  if (message.kind === "merge") {
    if (!tasks.has("merge")) return false;
    sendResponse({ pending: Boolean(mergeLinkDirty) });
    return false;
  }
  if (message.kind !== "page") return false;
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) return false;
  const slot = pageSlots.get(tabId);
  if (!slot?.context || slot.context.pageSessionId !== message.pageSessionId) return false;
  const pending = Boolean(
    slot.pendingGivenUrl &&
    String(slot.pendingGivenUrl).trim() !== String(message.givenUrl || "").trim()
  );
  if (!pending && activeTabId !== tabId) return false;
  sendResponse({ pending });
  return false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "XHS_AI_QUERY_PENDING_LINK") {
    return answerPendingLinkQuery(message, sendResponse);
  }
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

// 活动页签内地址变化（前端跳转 / 刷新 / 前进后退）只发 onUpdated：
// 不跟着更新地址，按钮会按旧地址判断而一直置灰。
chrome.tabs.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (tabId !== activeTabId || !changeInfo) return;
  if (changeInfo.url == null && changeInfo.status !== "complete") return;
  void syncActiveTabUrl();
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

// 侧边栏重新展开时补一次：折叠期间可能已经在页签里跳转过，事件不一定送达
document.addEventListener?.("visibilitychange", () => {
  if (document.hidden) return;
  void syncActiveTabUrl();
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
  if (task.key === "shot:single") {
    setFocus("shot");
    return;
  }
  if (String(task.key).startsWith(SHOT_PENDING_TASK_PREFIX)) {
    // 截图加入合并的进度就在合并概括区的占位条目上
    elements.basketPanel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
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
// 暂存区有截图时，输入框里一出现小红书链接就问它是不是截图的原帖链接（粘贴也会触发 input）
elements.materialInput.addEventListener("input", () => {
  maybeOfferShotLink();
});
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
  const target = stagedScreenshots.find((item) => item.id === button.dataset?.id);
  if (!target) return;
  // 长截图的分段共用一个 groupId：删掉任意一段就删整组，避免只删中间段导致识别内容缺失。
  const removed = target.groupId
    ? stagedScreenshots.filter((item) => item.groupId === target.groupId)
    : [target];
  const removedIds = new Set(removed.map((item) => item.id));
  stagedScreenshots = stagedScreenshots.filter((item) => !removedIds.has(item.id));
  // 截图全部移除后，挂着的链接放回输入框，不悄悄丢掉
  const restoredLink = !stagedScreenshots.length && stagedShotLink ? stagedShotLink : null;
  if (restoredLink) {
    stagedShotLink = null;
    if (!elements.materialInput.value.trim()) elements.materialInput.value = restoredLink;
  }
  renderStaging();
  if (pendingLinkChoice?.mode === "shot" && !stagedScreenshots.length) hideLinkChoice();
  if (restoredLink) showMaterialFeedback("截图已全部移除，原帖链接放回了输入框。");
  else if (removed.length > 1) showMaterialFeedback(`已移除整张长截图（${removed.length} 段）。`);
});
elements.stagingLinkRemove.addEventListener("click", () => {
  stagedShotLink = null;
  renderStaging();
  showMaterialFeedback("已移除截图的原帖链接。");
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
  if (row.dataset?.pendingId) {
    const action = event.target.closest?.("[data-pending-action]")?.dataset?.pendingAction;
    if (action) handlePendingShotAction(row.dataset.pendingId, action);
    return;
  }
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
    refreshFeishuButton();
    return;
  }
  const result = currentResult();
  if (result) result.text = elements.resultText.value;
  refreshFeishuButton();
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
