// 截图存档（v0.21.0）：archive.js 的纯函数、截图流程、文件读写，以及侧边栏的存档联动。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const archiveSource = fs.readFileSync(path.join(root, "archive.js"), "utf8");
// vm 上下文里产生的数组/对象与本上下文原型不同，比较前转成普通 JSON
const plain = (value) => JSON.parse(JSON.stringify(value));
const deepEqual = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function notFound() {
  const error = new Error("not found");
  error.name = "NotFoundError";
  return error;
}

// 内存版目录句柄：覆盖 archive.js 用到的 File System Access 接口
function createFakeDir(name) {
  const entries = new Map();
  const dir = {
    name,
    kind: "directory",
    entries,
    permission: "granted",
    async getDirectoryHandle(child, options = {}) {
      const entry = entries.get(child);
      if (entry?.kind === "directory") return entry;
      if (entry) throw new Error("type mismatch");
      if (!options.create) throw notFound();
      const created = createFakeDir(child);
      entries.set(child, created);
      return created;
    },
    async getFileHandle(child, options = {}) {
      const entry = entries.get(child);
      if (entry?.kind === "file") return entry;
      if (entry) throw new Error("type mismatch");
      if (!options.create) throw notFound();
      const file = {
        kind: "file",
        name: child,
        data: null,
        async createWritable() {
          return {
            async write(blob) { file.data = blob; },
            async close() {}
          };
        }
      };
      entries.set(child, file);
      return file;
    },
    async removeEntry(child) {
      if (!entries.has(child)) throw notFound();
      entries.delete(child);
    },
    async queryPermission() { return dir.permission; },
    async requestPermission() { return dir.permission; }
  };
  return dir;
}

function createStorage() {
  const store = {};
  const listeners = [];
  return {
    store,
    listeners,
    local: {
      async get(key) {
        if (typeof key === "string") return key in store ? { [key]: structuredClone(store[key]) } : {};
        return structuredClone(store);
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { newValue: value };
          store[key] = structuredClone(value);
        }
        listeners.forEach((listener) => listener(changes, "local"));
      },
      async remove() {}
    },
    onChanged: { addListener(listener) { listeners.push(listener); } }
  };
}

function loadArchive(chromeMock, extra = {}) {
  const context = {
    chrome: chromeMock,
    console,
    Blob,
    fetch,
    URL,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    structuredClone,
    ...extra
  };
  vm.createContext(context);
  vm.runInContext(archiveSource, context, { filename: "archive.js" });
  return { context, Archive: context.XhsArchive };
}

async function settle(rounds = 20) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

(async () => {
  // —— 纯函数 ——
  {
    const { Archive } = loadArchive({});
    const payload = {
      exportedAt: "2026-11-19T04:05:06.000Z",
      source: { platform: "xiaohongshu", noteId: "6afd91e6000000001802d5b8" },
      note: { title: "某高校食堂/后厨:卫生问题*曝光?", author: "测试用户" }
    };
    assert.equal(Archive.captureKey(payload), "xiaohongshu|6afd91e6000000001802d5b8|2026-11-19T04:05:06.000Z");
    assert.equal(Archive.captureKey(Archive.captureMeta(payload)), Archive.captureKey(payload));
    assert.equal(
      Archive.captureKey({ exportedAt: "2026-11-19T00:00:00.000Z", source: { origin: "user_screenshot", screenshotId: "abc" } }),
      "xiaohongshu|shot-abc|2026-11-19T00:00:00.000Z"
    );
    assert.equal(Archive.captureKey({ source: { platform: "weibo", noteId: "x" } }), null, "没有采集时刻就没有存档键");

    // 与 service-worker.js 的 archiveCaptureKey 同格式：两边各自实现，这里对齐
    const swSource = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    const swFunction = /function archiveCaptureKey\(payload\) \{[\s\S]*?\n\}/.exec(swSource)?.[0];
    assert.ok(swFunction, "service-worker.js 缺少 archiveCaptureKey");
    const swKey = vm.runInNewContext(`(${swFunction.replace("function archiveCaptureKey", "function")})`);
    for (const sample of [
      payload,
      { exportedAt: "2026-11-19T00:00:00.000Z", source: { platform: "weibo", noteId: "RnHpD2nzq" } },
      { exportedAt: "2026-11-19T00:00:00.000Z", source: { origin: "user_screenshot", screenshotId: "s1" } }
    ]) {
      assert.equal(swKey(sample), Archive.captureKey(sample));
    }

    // 文件夹名：时间_平台_标题前 20 字_帖子 ID 后 6 位，非法字符替换掉
    const name = Archive.folderName(Archive.captureMeta(payload));
    assert.match(name, /^\d{4}-\d{2}-\d{2}_\d{6}_小红书_/);
    assert.ok(name.endsWith("_02d5b8"));
    assert.doesNotMatch(name, /[\\/:*?"<>|]/);
    assert.equal(
      Archive.folderName({ origin: "screenshot", title: "", author: "某人", exportedAt: "2026-01-02T03:04:05" }),
      "2026-01-02_030405_截图_某人"
    );
    assert.match(Archive.folderName({ platform: "weibo", origin: "page", title: "", noteId: "RnHpD2nzq" }), /_微博_无标题_pD2nzq$/);
    assert.equal(Archive.sanitizeName("标题结尾带点...  ", 20), "标题结尾带点");

    assert.equal(Archive.imageExtension("image/webp", ""), "webp");
    assert.equal(Archive.imageExtension("", "https://wx1.sinaimg.cn/large/abc.jpeg?x=1"), "jpg");
    assert.equal(Archive.imageExtension("application/octet-stream", "https://sns-img.xhscdn.com/abc!nd_dft"), "jpg");

    // 采集数据 JSON：视频截帧的 dataUrl 不内联
    const json = JSON.parse(Archive.payloadJson({ media: { images: [{ dataUrl: "data:image/jpeg;base64,AAAA", timestampSec: 3 }] } }));
    assert.equal(json.media.images[0].dataUrl, "（已另存为图片文件）");
    assert.equal(json.media.images[0].timestampSec, 3);

    // 拼接方案：各屏首尾相接、不重叠不留缝，超高按上限分张
    const rect = { left: 600, top: 80, width: 400, height: 700 };
    const segments = [
      { from: 900, to: 1600, scrollTop: 900, rect, scale: 2 },
      { from: 1600, to: 2300, scrollTop: 1600, rect, scale: 2 },
      { from: 2300, to: 2600, scrollTop: 1900, rect, scale: 2 }
    ];
    const plan = Archive.planComposite(segments, 900, 2600, 1500);
    assert.equal(plan.width, 800);
    assert.equal(plan.height, 3400);
    assert.equal(plan.parts.length, 3);
    deepEqual(plan.parts.map((part) => part.height), [1500, 1500, 400]);
    const covered = plan.parts.flatMap((part, partIndex) => part.draws.map((draw) => ({
      top: partIndex * 1500 + draw.dy,
      bottom: partIndex * 1500 + draw.dy + draw.sh
    }))).sort((a, b) => a.top - b.top);
    assert.equal(covered[0].top, 0);
    covered.forEach((range, index) => {
      if (index) assert.equal(range.top, covered[index - 1].bottom, "拼接处出现重叠或缝隙");
    });
    assert.equal(covered[covered.length - 1].bottom, 3400);
    // 第三屏滚动被夹在底部（scrollTop 1900）：内容 y=2300 在画面里位于 (80 + 400) * 2 = 960 像素处，
    // 它横跨第 2、3 张：第 2 张取 960 起 200 像素，第 3 张接着从 1160 起取 400 像素
    const thirdInPart2 = plan.parts[1].draws.find((draw) => draw.index === 2);
    const thirdInPart3 = plan.parts[2].draws.find((draw) => draw.index === 2);
    deepEqual([thirdInPart2.sy, thirdInPart2.sh, thirdInPart2.dy], [960, 200, 1300]);
    deepEqual([thirdInPart3.sy, thirdInPart3.sh, thirdInPart3.dy], [1160, 400, 0]);
    const firstDraw = plan.parts[0].draws[0];
    assert.equal(firstDraw.sx, 1200);
    assert.equal(firstDraw.sy, 160);

    // 删除联动：只删「被删记录引用、且没有现存记录再引用」的文件夹
    const index = [
      { folder: "A", historyIds: ["h1"] },
      { folder: "B", historyIds: ["h1", "h2"] },
      { folder: "C", historyIds: ["h3"] },
      { folder: "D", historyIds: ["h1", "evicted"] },
      { folder: "E", historyIds: [] }
    ];
    const released = Archive.foldersToRelease(index, ["h1"], ["h2", "h3"]);
    deepEqual(released.release.map((entry) => entry.folder), ["A", "D"]);
    deepEqual(released.keep.map((entry) => entry.folder), ["B", "C", "E"]);
    deepEqual(released.keep.find((entry) => entry.folder === "B").historyIds, ["h2"]);
    deepEqual(Archive.foldersToRelease(index, ["h1", "h2", "h3"], []).release.map((entry) => entry.folder), ["A", "B", "C", "D"]);
    deepEqual(Archive.entriesForHistory(index, "h2").map((entry) => entry.folder), ["B"]);
  }

  // —— 页面测量：微博截取正文那一栏，顶部固定导航与吸顶返回栏连在一起算遮挡 ——
  {
    const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
    const element = (rect, position = "static") => ({ rect, position, getBoundingClientRect: () => rect });
    const article = element(box(211, 114, 640, 697));
    const column = element(box(210, 114, 642, 4886));
    column.contains = (node) => node === article;
    column.querySelectorAll = () => [];
    const tab = element(box(211, 904, 640, 46));
    tab.parentElement = column;
    const nav = element(box(0, 0, 1200, 60), "fixed");
    const stickyCard = element(box(210, 68, 642, 46), "sticky");
    const leftNav = element(box(20, 68, 182, 575), "sticky");
    const body = { querySelectorAll: (selector) => (selector === "*" ? [nav, stickyCard, leftNav] : []) };
    column.parentElement = body;
    const documentMock = {
      body,
      scrollingElement: { scrollHeight: 5100 },
      documentElement: { clientWidth: 1200, clientHeight: 800 },
      querySelector: (selector) => ({ ".wbpro-tab3": tab, article }[selector] || null)
    };
    const pageContext = {
      document: documentMock,
      window: { scrollY: 0, innerWidth: 1215, scrollTo() {} },
      getComputedStyle: (node) => ({ position: node.position }),
      Event: class {},
      Date,
      Math,
      Array,
      setTimeout
    };
    const { Archive } = loadArchive({});
    vm.createContext(pageContext);
    const measure = vm.runInContext(`(${Archive.pageMeasure.toString()})`, pageContext);
    const geometry = await measure("weibo", null);
    deepEqual(geometry.rect, { left: 210, top: 0, width: 642, height: 800 });
    assert.equal(geometry.inset, 114, "顶部导航 60px 与吸顶返回栏（68–114px）应合并为遮挡");
    assert.equal(geometry.bottomInset, 0);
    assert.equal(geometry.contentEnd, 5000);

    const commentRange = vm.runInContext(`(${Archive.weiboCommentRange.toString()})`, pageContext);
    assert.equal(commentRange().startY, 811);
  }

  // —— 截图流程：初始屏 + 评论区按屏截取拼接，结束后恢复滚动位置 ——
  async function runCapture({ activeAfter = Infinity, permission = true, rangeError = null } = {}) {
    const calls = { executed: [], captures: 0, restored: null, draws: [] };
    let tabsGetCount = 0;
    let scrollTop = 0;
    const chromeMock = {
      permissions: { contains: async () => permission },
      windows: { get: async () => ({ state: "normal" }) },
      tabs: {
        get: async (tabId) => {
          tabsGetCount += 1;
          return { id: tabId, windowId: 1, active: tabsGetCount <= activeAfter };
        },
        captureVisibleTab: async () => {
          calls.captures += 1;
          return PNG_DATA_URL;
        }
      },
      scripting: {
        executeScript: async ({ func, args }) => {
          calls.executed.push(func.name);
          if (func.name === "pageScrollPosition") return [{ result: 120 }];
          if (func.name === "pageRestoreScroll") {
            calls.restored = args[1];
            return [{ result: true }];
          }
          if (func.name === "xhsCommentRange") {
            return [{ result: rangeError ? { error: rangeError } : { startY: 900, endY: 2600, comments: 12 } }];
          }
          if (func.name === "pageMeasure") {
            if (args[1] != null) scrollTop = Math.max(0, Math.min(3000 - 700, args[1]));
            return [{
              result: {
                scrollTop,
                contentEnd: 3000,
                rect: { left: 600, top: 80, width: 400, height: 700 },
                inset: 0,
                bottomInset: 0,
                innerWidth: 1000
              }
            }];
          }
          return [{ result: null }];
        }
      }
    };
    class FakeCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage: (...drawArgs) => calls.draws.push({ canvasHeight: this.height, args: drawArgs }) };
      }
      async convertToBlob() { return new Blob(["png"], { type: "image/png" }); }
    }
    const { Archive } = loadArchive(chromeMock, {
      createImageBitmap: async () => ({ width: 2000, height: 1600, close() {} }),
      OffscreenCanvas: FakeCanvas
    });
    let result;
    let error;
    const progress = [];
    try {
      result = await Archive.captureScreens({ tabId: 7, platform: "xiaohongshu", limit: 50, onProgress: (text) => progress.push(text) });
    } catch (caught) {
      error = caught;
    }
    return { Archive, calls, result, error, progress };
  }

  {
    const { Archive, calls, result, progress } = await runCapture();
    deepEqual(result.files.map((file) => file.name), ["01-帖文初始屏.png", "02-评论区长截图.png"]);
    deepEqual(result.warnings, []);
    assert.equal(calls.captures, 4, "初始屏 1 张 + 评论区 900→2600 每屏 700px 共 3 张");
    assert.equal(calls.restored, 120, "截完要恢复原来的滚动位置");
    assert.ok(progress.includes("正在截取评论区（第 3 屏）"));
    const drawnHeight = calls.draws.reduce((sum, draw) => sum + draw.args[4], 0);
    assert.equal(drawnHeight, 3400, "拼接高度应等于评论区高度 × 缩放");
    assert.equal(Archive.FILE_NAMES.firstScreen, "01-帖文初始屏.png");
  }

  {
    // 第 3 次查询页签时已被切走：停止截图、带回已截到的初始屏，仍恢复滚动位置
    const { Archive, calls, error } = await runCapture({ activeAfter: 3 });
    assert.equal(error?.message, Archive.SWITCHED_MESSAGE);
    deepEqual(error.partialFiles.map((file) => file.name), ["01-帖文初始屏.png"]);
    assert.equal(calls.restored, 120);
  }

  {
    const { Archive, error, calls } = await runCapture({ permission: false });
    assert.equal(error?.message, Archive.PERMISSION_MESSAGE);
    assert.equal(calls.captures, 0);
  }

  {
    const { result } = await runCapture({ rangeError: "页面上找不到评论区" });
    deepEqual(result.files.map((file) => file.name), ["01-帖文初始屏.png"]);
    assert.match(result.warnings[0], /评论区未截取：页面上找不到评论区/);
  }

  // —— 写文件、重名、删除与索引 ——
  {
    const storage = createStorage();
    const { Archive } = loadArchive({ storage });
    const rootDir = createFakeDir("舆情存档");
    const first = await Archive.createFolder(rootDir, "2026-11-19_120000_小红书_标题");
    const second = await Archive.createFolder(rootDir, "2026-11-19_120000_小红书_标题");
    assert.equal(first, "2026-11-19_120000_小红书_标题");
    assert.equal(second, "2026-11-19_120000_小红书_标题-2");
    await Archive.writeFiles(rootDir, first, [
      { name: "概括.txt", blob: Archive.textBlob("★ 标题\n正文") },
      { name: "采集数据.json", blob: Archive.jsonBlob({ a: 1 }) }
    ]);
    const folder = rootDir.entries.get(first);
    deepEqual([...folder.entries.keys()], ["概括.txt", "采集数据.json"]);
    assert.equal(await folder.entries.get("概括.txt").data.text(), "★ 标题\n正文");
    await Archive.removeFolder(rootDir, first);
    await Archive.removeFolder(rootDir, "不存在的文件夹");
    assert.ok(!rootDir.entries.has(first));

    await Archive.upsertIndexEntry({ folder: "F1", key: "k1", files: ["a"], historyIds: ["h1"] });
    await Archive.upsertIndexEntry({ folder: "F1", key: "k1", files: ["a", "b"], historyIds: ["h2"] });
    await Archive.linkIndexHistory("k1", "h3");
    await Archive.linkIndexHistory("k1", "h3");
    const stored = await Archive.getIndex();
    assert.equal(stored.length, 1);
    deepEqual(stored[0].files, ["a", "b"]);
    deepEqual(stored[0].historyIds, ["h1", "h2", "h3"]);

    const settings = await Archive.setSettings({ enabled: true });
    assert.equal(settings.enabled, true);
    assert.equal((await Archive.getSettings()).enabled, true);
  }

  // —— 侧边栏联动：开启存档 → 采集时带 archive 标记 → 收到截图信号截图 → 概括完写入文件夹 → 删除历史时删文件夹 ——
  {
    const pageUrl = "https://www.xiaohongshu.com/explore/6afd91e6000000001802d5b8?xsec_token=t";
    const elements = {};
    const element = () => ({
      hidden: true, disabled: false, checked: true, textContent: "", value: "", innerHTML: "",
      dataset: {}, attributes: {}, style: {}, listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      select() {}, focus() {}, contains() { return false; }
    });
    const storage = createStorage();
    const rootDir = createFakeDir("舆情存档");
    let runtimeListener = null;
    const tabMessages = [];
    const captureCalls = [];
    let historyItems = [];
    const payload = {
      exportedAt: "2026-11-19T04:05:06.000Z",
      source: { platform: "xiaohongshu", noteId: "6afd91e6000000001802d5b8", url: pageUrl },
      note: { title: "测试帖文", author: "测试用户" },
      commentExport: { extractedTopLevelCount: 3 },
      media: { images: [{ url: "https://sns-img.xhscdn.com/a" }] }
    };
    const result = {
      text: "★ 测试标题\n测试正文",
      createdAt: Date.now(),
      historyId: "hist-1",
      evidence: { topLevelComments: 3 },
      notification: null
    };
    let readySender = { id: undefined, tab: { id: 7 } };
    let tabsActivated = null;
    let tabsRemoved = null;
    let mergeCaptureCount = 0;
    let failNextSummary = false;
    const RETRY_TEXT = ["★ 重试标题", "重试正文"].join("\n");
    const retryPayload = { ...payload, exportedAt: "2026-11-19T07:00:00.000Z" };
    let lastMergeKey = null;
    const context = {
      chrome: {
        storage,
        cookies: { get: async () => ({ name: "web_session", value: "session" }) },
        runtime: {
          onMessage: { addListener(listener) { runtimeListener = listener; } },
          openOptionsPage() {},
          sendMessage: async (message) => {
            if (message.type === "XHS_AI_HISTORY_LIST") return { ok: true, items: historyItems };
            if (message.type === "XHS_AI_MERGE_ADD") return { ok: true, basket: [{ id: "note:a" }, { id: `note:${payload.source.noteId}` }] };
            if (message.type === "XHS_AI_MERGE_SUMMARIZE") {
              return {
                ok: true,
                result: {
                  text: "★ 合并标题\n合并正文", historyId: "hist-merge", merged: true, postCount: 2,
                  itemIds: ["note:a", `note:${payload.source.noteId}`], captureKeys: [lastMergeKey], evidence: {}, notification: null
                }
              };
            }
            if (message.type === "XHS_AI_HISTORY_REMOVE") {
              historyItems = historyItems.filter((item) => item.id !== message.id);
              return { ok: true };
            }
            return { ok: true };
          }
        },
        scripting: { executeScript: async () => [] },
        tabs: {
          query: async () => [{ id: 7, url: pageUrl }],
          get: async (tabId) => ({ id: tabId, url: pageUrl, active: true }),
          update: async () => ({}),
          onActivated: { addListener(listener) { tabsActivated = listener; } },
          onRemoved: { addListener(listener) { tabsRemoved = listener; } },
          onUpdated: { addListener() {} },
          sendMessage: async (tabId, message) => {
            tabMessages.push(message);
            if (message.type === "XHS_PAGE_CONTEXT") return { ok: true, pageSessionId: "ps-7", pageUrl, noteId: payload.source.noteId };
            if (message.type === "XHS_CAPTURE_FOR_MERGE") {
              // 「加入清单」没有模型调用：采集响应可能先于截图信号到达
              mergeCaptureCount += 1;
              const mergePayload = { ...payload, exportedAt: `2026-11-19T06:00:0${mergeCaptureCount}.000Z` };
              lastMergeKey = `xiaohongshu|${payload.source.noteId}|${mergePayload.exportedAt}`;
              setTimeout(() => runtimeListener({ type: "XHS_ARCHIVE_PAGE_READY", pageSessionId: "ps-7", payload: mergePayload }, { tab: { id: 7 } }, () => {}), 5);
              return { ok: true, payload: mergePayload };
            }
            if (message.type === "XHS_CAPTURE_AND_SUMMARIZE" && message.payload) {
              // 重新生成：复用失败时留下的 payload，不再采集
              return { ok: true, result: { ...result, text: RETRY_TEXT, historyId: "hist-retry" }, capture: message.payload };
            }
            if (message.type === "XHS_CAPTURE_AND_SUMMARIZE" && failNextSummary) {
              failNextSummary = false;
              runtimeListener({ type: "XHS_ARCHIVE_PAGE_READY", pageSessionId: "ps-7", payload: retryPayload }, { tab: { id: 7 } }, () => {});
              // 后台工作流在失败时保留 payload，侧边栏据此可以「重新生成」
              runtimeListener({
                type: "XHS_AI_WORKFLOW_STATE",
                workflow: { tabId: 7, pageSessionId: "ps-7", pageUrl, status: "error", capture: retryPayload, error: "模型请求失败" }
              }, {}, () => {});
              return { ok: false, error: "模型请求失败" };
            }
            if (message.type === "XHS_CAPTURE_AND_SUMMARIZE") {
              // 内容脚本采集完先发截图信号，再返回概括结果
              runtimeListener({ type: "XHS_ARCHIVE_PAGE_READY", pageSessionId: "ps-7", payload }, readySender, () => {});
              return { ok: true, result, capture: payload };
            }
            return { ok: true };
          }
        },
        windows: { WINDOW_ID_NONE: -1, update: async () => {}, onFocusChanged: { addListener() {} } }
      },
      document: {
        querySelector: (selector) => {
          if (!elements[selector]) elements[selector] = element();
          return elements[selector];
        },
        execCommand: () => true,
        addEventListener: () => {}
      },
      navigator: { clipboard: { writeText: async () => {} } },
      confirm: () => true,
      console, Intl, URL, Date, Math, JSON, Blob, fetch, Promise, setTimeout, clearTimeout, structuredClone
    };
    vm.createContext(context);
    vm.runInContext(archiveSource, context, { filename: "archive.js" });
    const real = context.XhsArchive;
    context.XhsArchive = {
      ...real,
      getRootHandle: async () => rootDir,
      permissionState: async (handle) => (handle ? "granted" : "none"),
      captureScreens: async (options) => {
        captureCalls.push(options);
        return {
          files: [
            { name: real.FILE_NAMES.firstScreen, blob: new Blob(["first"]) },
            { name: `${real.FILE_NAMES.comments}.png`, blob: new Blob(["long"]) }
          ],
          warnings: []
        };
      },
      collectMediaFiles: async () => ({ files: [{ name: "配图-01.jpg", blob: new Blob(["img"]) }], failed: 0 })
    };
    await storage.local.set({ [real.SETTINGS_KEY]: { enabled: true } });
    vm.runInContext(fs.readFileSync(path.join(root, "panel.js"), "utf8"), context, { filename: "panel.js" });
    await settle();
    assert.equal(elements["#archive-hint"].hidden, false, "开启存档后提取按钮下要提醒不要切换页签");

    // 长截图暂存时会切段：存档取原始上传文件，同一张长图只存一次
    const longOriginal = new Blob(["original-long"], { type: "image/png" });
    const sources = context.shotArchiveSources([
      { dataUrl: "data:image/png;base64,AAAA", sourceFile: longOriginal },
      { dataUrl: "data:image/png;base64,BBBB", sourceFile: longOriginal },
      { dataUrl: PNG_DATA_URL }
    ]);
    assert.equal(sources.length, 2);
    assert.equal(sources[0], longOriginal);
    assert.equal(sources[1], PNG_DATA_URL);
    const shotFiles = await real.screenshotFiles(sources);
    deepEqual(shotFiles.map((file) => file.name), ["原始截图-01.png", "原始截图-02.png"]);
    assert.equal(await shotFiles[0].blob.text(), "original-long");

    await elements["#extract-button"].listeners.click();
    await settle(40);

    const captureMessage = tabMessages.find((message) => message.type === "XHS_CAPTURE_AND_SUMMARIZE");
    deepEqual(captureMessage.options, { limit: 50, archive: true });
    assert.equal(captureCalls.length, 1);
    assert.equal(captureCalls[0].tabId, 7);
    assert.equal(captureCalls[0].platform, "xiaohongshu");

    const folders = [...rootDir.entries.keys()];
    assert.equal(folders.length, 1);
    assert.match(folders[0], /_小红书_测试帖文_02d5b8$/);
    deepEqual([...rootDir.entries.get(folders[0]).entries.keys()].sort(), [
      "01-帖文初始屏.png", "02-评论区长截图.png", "概括.txt", "配图-01.jpg", "采集数据.json"
    ].sort());
    const index = await real.getIndex();
    assert.equal(index.length, 1);
    deepEqual(index[0].historyIds, ["hist-1"]);
    assert.equal(elements["#archive-status"].hidden, false);
    assert.match(elements["#archive-status-text"].textContent, /已保存到「舆情存档\//);
    assert.match(elements["#archive-status-text"].textContent, /共 5 个文件/);
    assert.equal(elements["#archive-banner"].hidden, true, "截图结束后提示条要收起");

    // 别的页签发来的截图信号不响应（只响应自己发起的采集）
    readySender = { tab: { id: 8 } };
    runtimeListener({ type: "XHS_ARCHIVE_PAGE_READY", pageSessionId: "ps-7", payload: { ...payload, exportedAt: "2026-11-19T05:00:00.000Z" } }, readySender, () => {});
    await settle();
    assert.equal(captureCalls.length, 1);

    // 删除历史：只被这条记录引用的存档文件夹一并删除
    historyItems = [{ id: "hist-1", kind: "single", platform: "xiaohongshu", title: "测试帖文", result, createdAt: Date.now() }];
    await elements["#history-button"].listeners.click();
    await settle();
    const row = { dataset: { id: "hist-1" } };
    await elements["#history-list"].listeners.click({
      target: { closest: (selector) => (selector === ".history-item" || selector === ".merge-remove" ? row : null) }
    });
    await settle(20);
    assert.equal(rootDir.entries.size, 0, "删除历史后存档文件夹应被删除");
    deepEqual(await real.getIndex(), []);
    assert.match(elements["#history-hint"].textContent, /已一并删除 1 个存档文件夹/);

    // 「加入清单」：截图照常进行（响应先到、截图信号后到也不漏），但合并概括之前不写入文件夹
    await elements["#history-back-button"].listeners.click();
    tabsRemoved(7);
    await tabsActivated({ tabId: 7 });
    await settle();
    const addToBasket = async () => {
      await elements["#merge-add-button"].listeners.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await settle(40);
    };
    await addToBasket();
    const mergeCapture = tabMessages.filter((message) => message.type === "XHS_CAPTURE_FOR_MERGE");
    assert.equal(mergeCapture.length, 1);
    deepEqual(mergeCapture[0].options, { limit: 50, archive: true });
    assert.equal(captureCalls.length, 2);
    assert.equal(rootDir.entries.size, 0, "加入清单后、合并概括前不应写入存档");

    // 清空清单：这条没合并的存档直接丢弃；再加入一次，合并概括后才写入
    const droppedKey = lastMergeKey;
    await elements["#merge-clear-button"].listeners.click();
    await settle();
    await addToBasket();
    assert.equal(captureCalls.length, 3);
    assert.notEqual(lastMergeKey, droppedKey);
    assert.equal(rootDir.entries.size, 0);
    await elements["#merge-summarize-button"].listeners.click();
    await settle(40);
    const mergeFolders = [...rootDir.entries.keys()];
    assert.equal(mergeFolders.length, 1, "只写入合并了的那次采集");
    deepEqual([...rootDir.entries.get(mergeFolders[0]).entries.keys()].sort(), [
      "01-帖文初始屏.png", "02-评论区长截图.png", "配图-01.jpg", "采集数据.json"
    ].sort());
    const mergeIndex = await real.getIndex();
    assert.equal(mergeIndex.length, 1);
    assert.equal(mergeIndex[0].key, lastMergeKey);
    deepEqual(mergeIndex[0].historyIds, ["hist-merge"]);

    // 概括失败：截图先留在内存不写入；重新生成成功后写入，概括文本取新结果
    tabsRemoved(7);
    await tabsActivated({ tabId: 7 });
    await settle();
    failNextSummary = true;
    await elements["#extract-button"].listeners.click();
    await settle(40);
    assert.equal(captureCalls.length, 4);
    assert.equal(rootDir.entries.size, 1, "概括失败时不写入存档");
    await elements["#regenerate-button"].listeners.click();
    await settle(40);
    assert.equal(captureCalls.length, 4, "重新生成不再截图");
    assert.equal(rootDir.entries.size, 2);
    const retryIndex = (await real.getIndex()).find((entry) => entry.key.endsWith(retryPayload.exportedAt));
    deepEqual(retryIndex.historyIds, ["hist-retry"]);
    const retryFolder = rootDir.entries.get(retryIndex.folder);
    assert.equal(await retryFolder.entries.get("概括.txt").data.text(), RETRY_TEXT);
  }

  // —— 关闭存档：采集消息不带 archive 标记，不截图 ——
  {
    const tabMessages = [];
    const storage = createStorage();
    const elements = {};
    const element = () => ({
      hidden: true, disabled: false, textContent: "", value: "", innerHTML: "", dataset: {}, style: {}, listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; },
      setAttribute() {}, removeAttribute() {}, select() {}, focus() {}, contains() { return false; }
    });
    const pageUrl = "https://www.xiaohongshu.com/explore/6afd91e6000000001802d5b8?xsec_token=t";
    const context = {
      chrome: {
        storage,
        cookies: { get: async () => ({ name: "web_session", value: "session" }) },
        runtime: { onMessage: { addListener() {} }, openOptionsPage() {}, sendMessage: async () => ({ ok: true }) },
        scripting: { executeScript: async () => [] },
        tabs: {
          query: async () => [{ id: 7, url: pageUrl }],
          get: async (tabId) => ({ id: tabId, url: pageUrl, active: true }),
          onActivated: { addListener() {} },
          onRemoved: { addListener() {} },
          onUpdated: { addListener() {} },
          sendMessage: async (tabId, message) => {
            tabMessages.push(message);
            if (message.type === "XHS_PAGE_CONTEXT") return { ok: true, pageSessionId: "ps-7", pageUrl };
            return { ok: true, result: { text: "★ 标题", historyId: "h", evidence: {} }, capture: null };
          }
        },
        windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener() {} } }
      },
      document: {
        querySelector: (selector) => {
          if (!elements[selector]) elements[selector] = element();
          return elements[selector];
        },
        execCommand: () => true,
        addEventListener: () => {}
      },
      navigator: { clipboard: { writeText: async () => {} } },
      console, Intl, URL, Date, Math, JSON, Blob, fetch, Promise, setTimeout, clearTimeout, structuredClone
    };
    vm.createContext(context);
    vm.runInContext(archiveSource, context, { filename: "archive.js" });
    vm.runInContext(fs.readFileSync(path.join(root, "panel.js"), "utf8"), context, { filename: "panel.js" });
    await settle();
    assert.equal(elements["#archive-hint"].hidden, true);
    await elements["#extract-button"].listeners.click();
    await settle(20);
    const captureMessage = tabMessages.find((message) => message.type === "XHS_CAPTURE_AND_SUMMARIZE");
    deepEqual(captureMessage.options, { limit: 50 });
  }

  // —— 静态结构：页面引用、提示文案、内容脚本信号 ——
  {
    const panelHtml = fs.readFileSync(path.join(root, "panel.html"), "utf8");
    const optionsHtml = fs.readFileSync(path.join(root, "options.html"), "utf8");
    assert.ok(panelHtml.indexOf('src="archive.js"') > 0 && panelHtml.indexOf('src="archive.js"') < panelHtml.indexOf('src="panel.js"'));
    assert.ok(optionsHtml.indexOf('src="archive.js"') > 0 && optionsHtml.indexOf('src="archive.js"') < optionsHtml.indexOf('src="options.js"'));
    for (const id of ["archive-banner", "archive-hint", "archive-status", "archive-grant-button", "archive-retry-button"]) {
      assert.match(panelHtml, new RegExp(`id="${id}"`), `panel.html 缺少 #${id}`);
    }
    for (const id of ["archive-enabled", "archive-folder-button", "archive-folder-status"]) {
      assert.match(optionsHtml, new RegExp(`id="${id}"`), `options.html 缺少 #${id}`);
    }
    assert.match(optionsHtml, /截图期间请停留在帖文页签，不要切换/);
    assert.match(archiveSource, /const MAX_WEIBO_COMMENT_SCREENS = 10;/, "微博评论区截图按 10 屏封顶");
    const common = fs.readFileSync(path.join(root, "capture-common.js"), "utf8");
    assert.match(common, /XHS_ARCHIVE_PAGE_READY/);
    assert.equal((common.match(/^\s+announceArchiveReady\(rawOptions, /gm) || []).length, 2, "单条采集与加入清单两条路径都要发截图信号");
  }

  process.stdout.write("archive tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
