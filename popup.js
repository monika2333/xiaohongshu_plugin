const LIMIT = 50;

const button = document.querySelector("#extract-button");
const buttonLabel = document.querySelector(".button-label");
const statusCard = document.querySelector("#status-card");
const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const statusCount = document.querySelector("#status-count");
const progressBar = document.querySelector("#progress-bar");
const downloadImages = document.querySelector("#download-images");
const includeVisibleReplies = document.querySelector("#include-visible-replies");

function setStatus({ state = "idle", title, detail, count = 0 }) {
  const safeCount = Math.max(0, Math.min(LIMIT, Number(count) || 0));
  statusCard.dataset.state = state;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  statusCount.textContent = `${safeCount} / ${LIMIT}`;
  progressBar.style.width = `${(safeCount / LIMIT) * 100}%`;
}

function setWorking(working) {
  button.disabled = working;
  buttonLabel.textContent = working ? "正在摘录…" : "开始摘录";
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

async function restoreLastStatus() {
  const { xhsExporterStatus } = await chrome.storage.local.get("xhsExporterStatus");
  if (!xhsExporterStatus) return;

  const recent = Date.now() - (xhsExporterStatus.updatedAt || 0) < 10 * 60 * 1000;
  if (!recent) return;

  setStatus({
    state: xhsExporterStatus.state,
    title: xhsExporterStatus.title,
    detail: xhsExporterStatus.detail,
    count: xhsExporterStatus.count
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "XHS_EXPORT_PROGRESS") return;
  setStatus({
    state: "working",
    title: message.title || "正在摘录",
    detail: message.detail || "正在读取当前帖文…",
    count: message.count || 0
  });
});

button.addEventListener("click", async () => {
  setWorking(true);
  setStatus({
    state: "working",
    title: "正在连接页面",
    detail: "检查当前帖文详情页…",
    count: 0
  });

  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isXhsNoteUrl(tab.url || "")) {
      throw new Error("请先打开小红书帖文详情页，再点击开始摘录。");
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"]
    });

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "XHS_EXPORT_START",
      options: {
        limit: LIMIT,
        downloadImages: downloadImages.checked,
        includeVisibleReplies: includeVisibleReplies.checked
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "摘录未完成，请刷新帖文后重试。");
    }

    setStatus({
      state: "done",
      title: "摘录完成",
      detail: response.failedDownloadCount
        ? `已保存 ${response.topLevelCount} 条一级评论、${response.imageCount} 张图片；${response.failedDownloadCount} 张图片失败。`
        : `已保存 ${response.topLevelCount} 条一级评论、${response.imageCount} 张图片。`,
      count: response.topLevelCount
    });
  } catch (error) {
    setStatus({
      state: "error",
      title: "未能完成",
      detail: error?.message || "发生未知错误，请刷新页面后重试。",
      count: 0
    });
  } finally {
    setWorking(false);
  }
});

restoreLastStatus().catch(() => {});
