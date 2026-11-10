const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const NOTE_ID = "6a82bd6000000000330309ec";

function textNode(text, extra = {}) {
  return { innerText: text, textContent: text, ...extra };
}

function createDetailRoot(usePrimaryInteractionContainer = true) {
  const firstCommentLike = textNode("1");
  const nodes = new Map([
    ["#detail-title, #detail-desc, .comments-container", textNode("清华听涛园食堂异物")],
    ["#detail-title, .title", textNode("清华听涛园食堂异物")],
    [".author-wrapper .username", textNode("紫罗兰花铃")],
    [".author-wrapper a.name", { href: "https://www.xiaohongshu.com/user/profile/example" }],
    ["#detail-desc .note-text, #detail-desc, .desc .note-text", textNode("帖文正文")],
    [".bottom-container .date", textNode("08-17 北京")],
    [".comments-container .total", textNode("共 67 条评论")]
  ]);
  const interactionPrefix = usePrimaryInteractionContainer ? ".interact-container" : ".interactions";
  nodes.set(`${interactionPrefix} .like-wrapper .count`, textNode("1.2万"));
  nodes.set(`${interactionPrefix} .collect-wrapper .count`, textNode("345"));
  nodes.set(`${interactionPrefix} .chat-wrapper .count`, textNode("67"));
  if (usePrimaryInteractionContainer) nodes.set(".interactions .like-wrapper .count", firstCommentLike);

  return {
    querySelector(selector) {
      if (
        usePrimaryInteractionContainer &&
        selector === ".interact-container .like-wrapper .count, .interactions .like-wrapper .count"
      ) {
        return firstCommentLike;
      }
      return selector
        .split(",")
        .map((item) => item.trim())
        .map((item) => nodes.get(item))
        .find(Boolean) || nodes.get(selector) || null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

async function captureFromPage(rootSelector, detailRoot = createDetailRoot()) {
  let messageListener;
  const document = {
    title: "清华听涛园食堂异物 - 小红书",
    querySelector(selector) {
      return selector === rootSelector ? detailRoot : null;
    }
  };
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      },
      sendMessage: async () => ({ ok: true })
    },
    storage: { local: { set: async () => {} } }
  };
  const context = {
    chrome,
    // mock 里没有评论区：缩短「等待评论区挂载」的上限，避免用例空等真实时长
    __XHS_CAPTURE_TIMING__: { readyPollMs: 20, commentAreaWaitMs: 300 },
    crypto: { randomUUID: () => "page-session" },
    document,
    Event,
    globalThis: null,
    location: {
      href: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
      pathname: `/explore/${NOTE_ID}`
    },
    setTimeout,
    clearTimeout,
    URL
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "capture-common.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(__dirname, "..", "content-script.js"), "utf8"),
    context,
    { filename: "content-script.js" }
  );

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("capture response timed out")), 1000);
    const keepChannelOpen = messageListener(
      { type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 50 } },
      {},
      (response) => {
        clearTimeout(timeout);
        resolve(response);
      }
    );
    assert.equal(keepChannelOpen, true);
  });
}

async function pageContextFromPage(rootSelector, detailRoot = createDetailRoot()) {
  let messageListener;
  const document = {
    title: "清华听涛园食堂异物 - 小红书",
    querySelector(selector) {
      return selector === rootSelector ? detailRoot : null;
    }
  };
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      },
      sendMessage: async () => ({ ok: true })
    },
    storage: { local: { set: async () => {} } }
  };
  const context = {
    chrome,
    // mock 里没有评论区：缩短「等待评论区挂载」的上限，避免用例空等真实时长
    __XHS_CAPTURE_TIMING__: { readyPollMs: 20, commentAreaWaitMs: 300 },
    crypto: { randomUUID: () => "page-session" },
    document,
    Event,
    globalThis: null,
    location: {
      href: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
      pathname: `/explore/${NOTE_ID}`
    },
    setTimeout,
    clearTimeout,
    URL
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "capture-common.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(__dirname, "..", "content-script.js"), "utf8"),
    context,
    { filename: "content-script.js" }
  );
  let response;
  const keepChannelOpen = messageListener({ type: "XHS_PAGE_CONTEXT" }, {}, (res) => { response = res; });
  assert.equal(keepChannelOpen, false);
  return response;
}

async function captureAndSummarizeWithOverlappingVision() {
  let commentLoaded = false;
  const image = {
    currentSrc: "https://sns-webpic-qc.xhscdn.com/parallel-test.webp",
    src: "https://sns-webpic-qc.xhscdn.com/parallel-test.webp",
    naturalWidth: 1080,
    naturalHeight: 1440
  };
  const commentItem = {
    id: "comment-parallel",
    querySelector: () => null
  };
  const commentParent = {
    querySelector: () => commentItem,
    querySelectorAll: () => []
  };
  const scroller = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 500,
    dispatchEvent() { commentLoaded = true; }
  };
  const detailRoot = createDetailRoot();
  const baseQuerySelector = detailRoot.querySelector.bind(detailRoot);
  detailRoot.querySelector = (selector) => selector === ".note-scroller" ? scroller : baseQuerySelector(selector);
  detailRoot.querySelectorAll = (selector) => {
    if (selector === ".img-container img, .note-slider-img img, [class*='slider'] img") return [image];
    if (selector === ".parent-comment") return commentLoaded ? [commentParent] : [];
    return [];
  };

  let messageListener;
  let resolveVision;
  let signalVisionStarted;
  const visionStarted = new Promise((resolve) => { signalVisionStarted = resolve; });
  const runtimeMessages = [];
  const document = {
    title: "清华听涛园食堂异物 - 小红书",
    querySelector: (selector) => selector === "#noteContainer" ? detailRoot : null
  };
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      sendMessage(message) {
        runtimeMessages.push(message);
        if (message.type === "XHS_AI_PREPARE_VISION") {
          signalVisionStarted();
          return new Promise((resolve) => {
            resolveVision = () => resolve({
              ok: true,
              preparedVision: { key: "vision-key", items: [], status: "analyzed" }
            });
          });
        }
        if (message.type === "XHS_AI_SUMMARIZE_PAGE") {
          return Promise.resolve({ ok: true, result: { text: "测试概括" } });
        }
        return Promise.resolve({ ok: true });
      }
    },
    storage: { local: { set: async () => {} } }
  };
  const context = {
    chrome,
    crypto: { randomUUID: () => "parallel-page-session" },
    document,
    Event,
    globalThis: null,
    location: {
      href: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
      pathname: `/explore/${NOTE_ID}`
    },
    setTimeout,
    clearTimeout,
    URL
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "capture-common.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(__dirname, "..", "content-script.js"), "utf8"),
    context,
    { filename: "content-script.js" }
  );

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("parallel workflow response timed out")), 2000);
    const keepChannelOpen = messageListener(
      { type: "XHS_CAPTURE_AND_SUMMARIZE", options: { limit: 1 } },
      {},
      (response) => {
        clearTimeout(timeout);
        resolve(response);
      }
    );
    assert.equal(keepChannelOpen, true);
  });

  await visionStarted;
  assert.ok(runtimeMessages.some((message) => message.type === "XHS_AI_PREPARE_VISION"));
  assert.equal(runtimeMessages.some((message) => message.type === "XHS_AI_SUMMARIZE_PAGE"), false);
  // 采集进度携带帖文标题，供侧边栏任务列表区分并行任务
  const progressMessage = runtimeMessages.find((message) => message.type === "XHS_EXPORT_PROGRESS");
  assert.ok(progressMessage);
  assert.equal(progressMessage.noteTitle, "清华听涛园食堂异物");

  // 同一页面的并发请求立刻被拒绝（概括与合并采集共用同一个页面锁），
  // 不再并到进行中的任务上导致拿到别的帖文结果。
  let busySummaryResponse = null;
  messageListener({ type: "XHS_CAPTURE_AND_SUMMARIZE", options: { limit: 1 } }, {}, (response) => {
    busySummaryResponse = response;
  });
  assert.ok(busySummaryResponse);
  assert.equal(busySummaryResponse.ok, false);
  assert.match(busySummaryResponse.error, /已有任务/);
  let busyMergeResponse = null;
  messageListener({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 1 } }, {}, (response) => {
    busyMergeResponse = response;
  });
  assert.ok(busyMergeResponse);
  assert.equal(busyMergeResponse.ok, false);
  assert.match(busyMergeResponse.error, /已有任务/);

  resolveVision();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtimeMessages.some((message) => message.type === "XHS_AI_SUMMARIZE_PAGE"), false);

  const response = await responsePromise;
  assert.equal(response.ok, true);
  const summaryMessage = runtimeMessages.find((message) => message.type === "XHS_AI_SUMMARIZE_PAGE");
  assert.equal(summaryMessage.preparedVision.key, "vision-key");
}

async function captureForMergeWithOverlappingVision() {
  let commentLoaded = false;
  const image = {
    currentSrc: "https://sns-webpic-qc.xhscdn.com/merge-test.webp",
    src: "https://sns-webpic-qc.xhscdn.com/merge-test.webp",
    naturalWidth: 1080,
    naturalHeight: 1440
  };
  const commentItem = {
    id: "comment-merge",
    querySelector: () => null
  };
  const commentParent = {
    querySelector: () => commentItem,
    querySelectorAll: () => []
  };
  const scroller = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 500,
    dispatchEvent() { commentLoaded = true; }
  };
  const detailRoot = createDetailRoot();
  const baseQuerySelector = detailRoot.querySelector.bind(detailRoot);
  detailRoot.querySelector = (selector) => selector === ".note-scroller" ? scroller : baseQuerySelector(selector);
  detailRoot.querySelectorAll = (selector) => {
    if (selector === ".img-container img, .note-slider-img img, [class*='slider'] img") return [image];
    if (selector === ".parent-comment") return commentLoaded ? [commentParent] : [];
    return [];
  };

  let messageListener;
  let resolveVision;
  let signalVisionStarted;
  const visionStarted = new Promise((resolve) => { signalVisionStarted = resolve; });
  const runtimeMessages = [];
  const document = {
    title: "清华听涛园食堂异物 - 小红书",
    querySelector: (selector) => selector === "#noteContainer" ? detailRoot : null
  };
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      sendMessage(message) {
        runtimeMessages.push(message);
        if (message.type === "XHS_AI_PREPARE_VISION") {
          signalVisionStarted();
          return new Promise((resolve) => {
            resolveVision = () => resolve({ ok: true, preparedVision: { key: "vision-key", items: [], status: "analyzed" } });
          });
        }
        return Promise.resolve({ ok: true });
      }
    },
    storage: { local: { set: async () => {} } }
  };
  const context = {
    chrome,
    crypto: { randomUUID: () => "merge-page-session" },
    document,
    Event,
    globalThis: null,
    location: {
      href: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
      pathname: `/explore/${NOTE_ID}`
    },
    setTimeout,
    clearTimeout,
    URL
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "capture-common.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(__dirname, "..", "content-script.js"), "utf8"),
    context,
    { filename: "content-script.js" }
  );

  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("merge capture response timed out")), 2000);
    const keepChannelOpen = messageListener(
      { type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 1 } },
      {},
      (response) => {
        clearTimeout(timeout);
        resolve(response);
      }
    );
    assert.equal(keepChannelOpen, true);
  });

  await visionStarted;
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 图片识别尚未返回前不应结束采集，也不应触发文字概括。
  assert.equal(runtimeMessages.some((message) => message.type === "XHS_AI_MERGE_CAPTURE_DONE"), false);
  assert.equal(runtimeMessages.some((message) => message.type === "XHS_AI_SUMMARIZE_PAGE"), false);
  resolveVision();

  const response = await responsePromise;
  assert.equal(response.ok, true);
  assert.equal(response.payload.source.noteId, NOTE_ID);
  assert.equal(response.payload.commentExport.extractedTopLevelCount, 1);
  const doneMessage = runtimeMessages.find((message) => message.type === "XHS_AI_MERGE_CAPTURE_DONE");
  assert.ok(doneMessage);
  assert.equal(doneMessage.noteId, NOTE_ID);
  assert.equal(runtimeMessages.some((message) => message.type === "XHS_AI_SUMMARIZE_PAGE"), false);
}

// 模拟「链接概括流新开页签」的页面：帖文标题一直可用（detailReady 为真），
// 互动条/评论区/评论数据按各自延迟陆续挂载，模拟 SPA 的渐进渲染与评论接口返回。
function createDelayedDetailRoot({
  countsDelayMs = 0,
  scrollerDelayMs = 0,
  commentsDelayMs = 0,
  countsTexts = ["1.2万", "345", "67"],
  totalCountText = "共 67 条评论",
  commentCount = 1
} = {}) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const commentItem = { id: "comment-delayed", querySelector: () => null };
  const commentParent = { querySelector: () => commentItem, querySelectorAll: () => [] };
  const scroller = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 500,
    dispatchEvent() {}
  };
  const title = textNode("清华听涛园食堂异物");
  const baseNodes = new Map([
    ["#detail-title, #detail-desc, .comments-container", title],
    ["#detail-title, .title", title],
    ["#detail-desc .note-text, #detail-desc, .desc .note-text", textNode("帖文正文")],
    [".bottom-container .date", textNode("08-17 北京")]
  ]);
  // 互动数与评论总数按单段选择器做键：getInteraction/textOf 逐段查询
  const readyNodes = new Map([
    ...baseNodes,
    [".interact-container .like-wrapper .count", textNode(countsTexts[0])],
    [".interact-container .collect-wrapper .count", textNode(countsTexts[1])],
    [".interact-container .chat-wrapper .count", textNode(countsTexts[2])],
    [".comments-container .total", textNode(totalCountText)]
  ]);
  const activeNodes = () => (elapsed() >= countsDelayMs ? readyNodes : baseNodes);
  return {
    querySelector(selector) {
      if (selector === ".note-scroller") return elapsed() >= scrollerDelayMs ? scroller : null;
      return selector
        .split(",")
        .map((item) => item.trim())
        .map((item) => activeNodes().get(item))
        .find(Boolean) || activeNodes().get(selector) || null;
    },
    querySelectorAll(selector) {
      if (selector === ".parent-comment") {
        return elapsed() >= commentsDelayMs && commentCount > 0 ? [commentParent] : [];
      }
      return [];
    }
  };
}

// 与 captureFromPage 同构，但使用延迟挂载的详情根，并记录采集进度与耗时
function captureFromDelayedPage(detailRoot, timing = {}) {
  let messageListener;
  const progressMessages = [];
  const document = {
    title: "清华听涛园食堂异物 - 小红书",
    querySelector: (selector) => selector === "#noteContainer" ? detailRoot : null
  };
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      sendMessage: async (message) => {
        if (message.type === "XHS_EXPORT_PROGRESS") progressMessages.push(message);
        return { ok: true };
      }
    },
    storage: { local: { set: async () => {} } }
  };
  const context = {
    chrome,
    __XHS_CAPTURE_TIMING__: { readyPollMs: 20, interactionReadyWaitMs: 2000, commentAreaWaitMs: 900, ...timing },
    crypto: { randomUUID: () => "delayed-page-session" },
    document,
    Event,
    globalThis: null,
    location: {
      href: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
      pathname: `/explore/${NOTE_ID}`
    },
    setTimeout,
    clearTimeout,
    URL
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "capture-common.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(__dirname, "..", "content-script.js"), "utf8"),
    context,
    { filename: "content-script.js" }
  );
  return {
    run(options) {
      const startedAt = Date.now();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("delayed capture response timed out")), 8000);
        const keepChannelOpen = messageListener(
          { type: "XHS_CAPTURE_FOR_MERGE", options: { limit: options?.limit ?? 1 } },
          {},
          (response) => {
            clearTimeout(timeout);
            resolve({ response, progressMessages, elapsedMs: Date.now() - startedAt });
          }
        );
        assert.equal(keepChannelOpen, true);
      });
    }
  };
}

(async () => {
  const directPage = await captureFromPage("#noteContainer");
  assert.equal(directPage.ok, true);
  assert.equal(directPage.payload.source.noteId, NOTE_ID);
  assert.equal(directPage.payload.note.title, "清华听涛园食堂异物");
  assert.equal(directPage.payload.interactions.likes.value, 12000);
  assert.equal(directPage.payload.interactions.collects.value, 345);
  assert.equal(directPage.payload.interactions.comments.value, 67);
  // mock 里评论区从未挂载：应如实注明评论缺失，而不是静默按 0 条处理
  assert.equal(directPage.payload.commentExport.stopReason, "comment_scroller_missing");
  assert.ok(directPage.payload.uncertainties.some((item) => item.includes("评论未能读取")));

  const modalPage = await captureFromPage(".note-detail-mask", createDetailRoot(false));
  assert.equal(modalPage.ok, true);
  assert.equal(modalPage.payload.note.content, "帖文正文");
  assert.equal(modalPage.payload.commentExport.stopReason, "comment_scroller_missing");

  // XHS_PAGE_CONTEXT 带 detailReady：链接概括流据此判断详情 DOM 是否已渲染
  const readyContext = await pageContextFromPage("#noteContainer");
  assert.equal(readyContext.ok, true);
  assert.equal(readyContext.detailReady, true);

  const notReadyRoot = createDetailRoot();
  const baseQuery = notReadyRoot.querySelector.bind(notReadyRoot);
  notReadyRoot.querySelector = (selector) => (
    selector === "#detail-title, #detail-desc, .comments-container" ? null : baseQuery(selector)
  );
  const notReadyContext = await pageContextFromPage("#noteContainer", notReadyRoot);
  assert.equal(notReadyContext.detailReady, false);

  await captureAndSummarizeWithOverlappingVision();
  await captureForMergeWithOverlappingVision();

  // 1) 新页签场景：标题先渲染（detailReady 为真），互动条与评论数据 250ms 后才挂载。
  //    采集应等待就绪，读到互动数与评论，而不是把「还没加载出来」当成「没有」。
  const delayed = captureFromDelayedPage(createDelayedDetailRoot({ countsDelayMs: 250, scrollerDelayMs: 250, commentsDelayMs: 250 }));
  const delayedRun = await delayed.run();
  assert.equal(delayedRun.response.ok, true);
  assert.equal(delayedRun.response.payload.interactions.likes.value, 12000);
  assert.equal(delayedRun.response.payload.commentExport.extractedTopLevelCount, 1);
  assert.equal(delayedRun.response.payload.uncertainties, undefined);
  assert.ok(delayedRun.progressMessages.some((message) => message.title === "正在等待页面就绪"), "应上报等待页面就绪的进度");

  // 2) 评论区始终未挂载：等待有上限，结束时应如实注明评论缺失
  const neverMounted = captureFromDelayedPage(createDelayedDetailRoot({
    scrollerDelayMs: Number.MAX_SAFE_INTEGER,
    commentsDelayMs: Number.MAX_SAFE_INTEGER,
    commentCount: 0
  }), { commentAreaWaitMs: 300 });
  const neverRun = await neverMounted.run();
  assert.equal(neverRun.response.ok, true);
  assert.equal(neverRun.response.payload.commentExport.stopReason, "comment_scroller_missing");
  assert.equal(neverRun.response.payload.commentExport.extractedTopLevelCount, 0);
  assert.ok(neverRun.response.payload.uncertainties.some((item) => item.includes("评论未能读取")));
  assert.ok(neverRun.progressMessages.some((message) => message.detail === "等待评论区加载"));

  // 3) 评论总数明确为 0（「共 0 条评论」）：接口已答复，立即结束，不算评论缺失
  const zeroComments = captureFromDelayedPage(createDelayedDetailRoot({
    totalCountText: "共 0 条评论",
    commentCount: 0
  }));
  const zeroRunStart = Date.now();
  const zeroRun = await zeroComments.run({ limit: 50 });
  assert.equal(zeroRun.response.ok, true);
  assert.equal(zeroRun.response.payload.commentExport.stopReason, "page_exhausted");
  assert.equal(zeroRun.response.payload.uncertainties, undefined);
  assert.ok(zeroRun.progressMessages.some((message) => message.detail === "该帖没有评论"));
  assert.ok(Date.now() - zeroRunStart < 3000, "确认没有评论后应立即结束，不再空等");

  // 4) 评论接口慢：滚动到底但一条评论都没出现时，在宽限上限内继续等而不是判「到底」
  const slowComments = captureFromDelayedPage(createDelayedDetailRoot({ commentsDelayMs: 600 }), { scrollWaitMs: 30 });
  const slowRun = await slowComments.run();
  assert.equal(slowRun.response.ok, true);
  assert.equal(slowRun.response.payload.commentExport.extractedTopLevelCount, 1);
  assert.equal(slowRun.response.payload.commentExport.stopReason, "limit_reached");
  assert.equal(slowRun.response.payload.uncertainties, undefined);
  assert.ok(slowRun.progressMessages.some((message) => message.detail === "已加载 0 条一级评论"), "等待期间应如实上报 0 条");
  assert.ok(slowRun.progressMessages.some((message) => message.detail === "已加载 1 条一级评论"));

  console.log("content-script tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
