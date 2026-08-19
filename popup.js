const LIMIT = 50;

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
  downloadButton: document.querySelector("#download-button"),
  downloadImages: document.querySelector("#download-images")
};

let currentCapture = null;
let isWorking = false;
let currentPageContext = null;

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
  elements.downloadButton.disabled = working;
  elements.buttonLabel.textContent = working ? "正在处理…" : "提取并概括";
}

function isXhsNoteUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("xiaohongshu.com") && /\/explore\/[0-9a-f]{24}/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function showResult(result, capture) {
  currentCapture = capture || currentCapture;
  elements.resultText.value = result.text;
  elements.resultTime.textContent = formatTime(result.createdAt);
  const evidence = result.evidence || {};
  elements.evidenceSummary.textContent = [
    `${evidence.topLevelComments || 0} 条一级评论`,
    `${evidence.visibleReplies || 0} 条已显示回复`,
    `${evidence.imagesAnalyzed || 0} / ${evidence.imagesFound || 0} 张图片完成识别`,
    `文字模型 ${evidence.textModel || "—"}`
  ].join(" · ");
  elements.resultCard.hidden = false;
}

async function prepareCurrentPage() {
  const tab = await getActiveTab();
  if (!tab?.id || !isXhsNoteUrl(tab.url || "")) {
    throw new Error("请先打开小红书帖文详情页，再点击提取并概括。");
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] });
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
    options: { limit: LIMIT, includeVisibleReplies: true, downloadImages: false },
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
    await startPageWorkflow(null, false);
    setStatus({ state: "done", title: "概括完成", detail: "已按固定格式生成，可直接复制。", percent: 100 });
  } catch (error) {
    setStatus({ state: "error", title: "未能完成", detail: error?.message || "发生未知错误。", percent: 0 });
  } finally {
    setWorking(false);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "XHS_AI_WORKFLOW_STATE") applyWorkflowState(message.workflow);
});

elements.extractButton.addEventListener("click", runFullWorkflow);
elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

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
  if (!currentCapture) {
    await runFullWorkflow();
    return;
  }
  setWorking(true);
  setStatus({ state: "working", title: "正在重新生成", detail: "复用页面与图片证据，重新调用文字模型…", percent: 66 });
  try {
    await startPageWorkflow(currentCapture, true);
    setStatus({ state: "done", title: "重新生成完成", detail: "新版本已替换原概括。", percent: 100 });
  } catch (error) {
    setStatus({ state: "error", title: "重新生成失败", detail: error?.message || "发生未知错误。", percent: 66 });
  } finally {
    setWorking(false);
  }
});

elements.downloadButton.addEventListener("click", async () => {
  elements.downloadButton.disabled = true;
  elements.downloadButton.textContent = "正在准备下载…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "XHS_AI_DOWNLOAD_LAST",
      tabId: currentPageContext?.tabId,
      pageSessionId: currentPageContext?.pageSessionId,
      pageUrl: currentPageContext?.pageUrl,
      options: { downloadImages: elements.downloadImages.checked }
    });
    if (!response?.ok) throw new Error(response?.error || "下载失败。");
    elements.downloadButton.textContent = response.failedDownloadCount
      ? `已下载，${response.failedDownloadCount} 张图片失败`
      : "原始数据已下载";
  } catch (error) {
    elements.downloadButton.textContent = error?.message || "下载失败";
  } finally {
    setTimeout(() => {
      elements.downloadButton.textContent = "下载 JSON · MD · CSV · 图片";
      elements.downloadButton.disabled = false;
    }, 2200);
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
