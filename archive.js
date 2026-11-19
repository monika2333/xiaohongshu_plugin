// 帖文存档：帖文初始屏截图、评论区长截图、配图原图、采集数据与概括文本，
// 写入用户在设置页选定的本地文件夹（File System Access 目录句柄存在 IndexedDB）。
// 由 panel.html 与 options.html 在主脚本之前加载；纯函数部分供 Node 测试直接调用。
(() => {
  if (globalThis.XhsArchive) return;

  const SETTINGS_KEY = "xhsAiArchiveSettingsV1";
  const INDEX_KEY = "xhsAiArchiveIndexV1";
  const DB_NAME = "shuye-archive";
  const DB_STORE = "handles";
  const ROOT_HANDLE_KEY = "root";
  const CAPTURE_ORIGINS = ["<all_urls>"];
  const MAX_INDEX_ENTRIES = 2000;
  // 浏览器单张画布的高度上限约 32767 像素，留出余量后超过就分张
  const MAX_PART_HEIGHT = 30000;
  // captureVisibleTab 每秒最多 2 次
  const MIN_CAPTURE_GAP_MS = 600;
  const MAX_XHS_COMMENT_SCREENS = 60;
  // 微博评论区随滚动无限加载，按屏数封顶（用户确认 10 屏足够）
  const MAX_WEIBO_COMMENT_SCREENS = 10;

  const FILE_NAMES = Object.freeze({
    firstScreen: "01-帖文初始屏.png",
    comments: "02-评论区长截图",
    summary: "概括.txt",
    data: "采集数据.json"
  });

  const SWITCHED_MESSAGE = "截图期间页签被切走，已停止截图，避免截到别的页面。回到帖文页签后可点「重新截图」。";
  const PERMISSION_MESSAGE = "缺少截图权限：请到设置页把「截图存档」关闭再打开，并允许访问所有网站。";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pad2 = (value) => String(value).padStart(2, "0");

  // —— 纯函数 ——

  function captureMeta(payload) {
    const source = payload?.source || {};
    const isShot = source.origin === "user_screenshot";
    return {
      platform: source.platform === "weibo" ? "weibo" : "xiaohongshu",
      origin: isShot ? "screenshot" : "page",
      noteId: isShot ? null : (source.noteId || null),
      screenshotId: isShot ? (source.screenshotId || null) : null,
      exportedAt: payload?.exportedAt || null,
      title: String(payload?.note?.title || "").trim(),
      author: String(payload?.note?.author || "").trim()
    };
  }

  // 一次采集的身份：平台 + 帖子（或截图）ID + 采集时刻。与 service-worker.js 的 archiveCaptureKey 同格式。
  function captureKey(payloadOrMeta) {
    const meta = payloadOrMeta?.source ? captureMeta(payloadOrMeta) : payloadOrMeta;
    if (!meta?.exportedAt) return null;
    const id = meta.origin === "screenshot" ? `shot-${meta.screenshotId || ""}` : (meta.noteId || "");
    return `${meta.platform}|${id}|${meta.exportedAt}`;
  }

  function sanitizeName(value, maxChars) {
    const text = String(value || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return Array.from(text).slice(0, maxChars).join("").trim().replace(/[. ]+$/g, "");
  }

  function folderName(meta, fallbackDate = new Date()) {
    const parsed = meta?.exportedAt ? new Date(meta.exportedAt) : null;
    const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallbackDate;
    const stamp = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_` +
      `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
    const label = meta?.origin === "screenshot" ? "截图" : meta?.platform === "weibo" ? "微博" : "小红书";
    const title = sanitizeName(meta?.title, 20) || sanitizeName(meta?.author, 12) || "无标题";
    const idTail = meta?.origin === "screenshot" ? "" : sanitizeName(String(meta?.noteId || "").slice(-6), 6);
    return [stamp, label, title, idTail].filter(Boolean).join("_");
  }

  function imageExtension(contentType, url) {
    const type = String(contentType || "").toLowerCase();
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    if (type.includes("gif")) return "gif";
    if (type.includes("avif")) return "avif";
    if (type.includes("heic")) return "heic";
    if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
    const match = /\.(png|jpe?g|webp|gif|avif|heic)(?:$|[?!#])/i.exec(String(url || ""));
    if (match) return match[1].toLowerCase().replace("jpeg", "jpg");
    return "jpg";
  }

  // 采集数据另存一份 JSON 便于日后核对；视频截帧等 dataUrl 已另存为图片文件，不再内联。
  function payloadJson(payload) {
    return JSON.stringify(payload ?? null, (key, value) => (
      key === "dataUrl" && typeof value === "string" ? "（已另存为图片文件）" : value
    ), 2);
  }

  // 拼接方案：每屏只取「未被吸顶/底栏遮挡、且尚未拼过」的那一段，按滚动距离精确落位。
  // segments: [{ from, to, scrollTop, rect, scale }]，坐标为滚动内容坐标（CSS 像素）。
  function planComposite(segments, startY, endY, maxPartHeight = MAX_PART_HEIGHT) {
    if (!segments?.length) return { width: 0, height: 0, parts: [] };
    const scale = segments[0].scale;
    const srcX = Math.round(segments[0].rect.left * scale);
    const width = Math.max(1, Math.round(segments[0].rect.width * scale));
    const height = Math.max(1, Math.round((endY - startY) * scale));
    const partCount = Math.max(1, Math.ceil(height / maxPartHeight));
    const parts = [];
    for (let part = 0; part < partCount; part += 1) {
      const partTop = part * maxPartHeight;
      const partHeight = Math.min(maxPartHeight, height - partTop);
      const draws = [];
      segments.forEach((segment, index) => {
        const destTop = Math.round((segment.from - startY) * scale);
        const destBottom = Math.min(height, Math.round((segment.to - startY) * scale));
        const clipTop = Math.max(destTop, partTop);
        const clipBottom = Math.min(destBottom, partTop + partHeight);
        if (clipBottom <= clipTop) return;
        const srcY = Math.round((segment.rect.top + (segment.from - segment.scrollTop)) * segment.scale);
        draws.push({
          index,
          sx: srcX,
          sy: srcY + (clipTop - destTop),
          sw: width,
          sh: clipBottom - clipTop,
          dy: clipTop - partTop
        });
      });
      parts.push({ height: partHeight, draws });
    }
    return { width, height, parts };
  }

  // 边加载边截的一帧是否还能用：截图时位于这一帧底边以上的锚点（评论区顶部、各条评论顶部），
  // 到最后都必须原地不动。上方内容变高（图片晚加载等）会让它们整体下移，这一帧就作废、改为补截。
  function frameStillValid(frame, finalAnchors, tolerance = 1.5) {
    const bottom = frame.scrollTop + frame.rect.height;
    const checks = [];
    if (frame.anchors?.box != null) checks.push([frame.anchors.box, finalAnchors?.box]);
    (frame.anchors?.items || []).forEach((y, index) => checks.push([y, finalAnchors?.items?.[index]]));
    for (const [captured, final] of checks) {
      if (captured > bottom + 1) continue;
      if (final == null || Math.abs(final - captured) > tolerance) return false;
    }
    return true;
  }

  // 用已有的帧覆盖 [startY, endY]：每一段取能看到该位置、且往下看得最远的那一帧；
  // 没有帧覆盖的部分记为缺口，由调用方补截。
  function planCoverage(frames, startY, endY) {
    const views = (frames || []).map((frame, index) => ({
      index,
      top: frame.scrollTop + (frame.inset || 0),
      bottom: frame.scrollTop + frame.rect.height - (frame.bottomInset || 0)
    }));
    const segments = [];
    const gaps = [];
    let y = startY;
    while (y < endY - 0.5) {
      let best = null;
      for (const view of views) {
        if (view.top <= y + 0.5 && view.bottom > y + 0.5 && (!best || view.bottom > best.bottom)) best = view;
      }
      if (best) {
        const to = Math.min(best.bottom, endY);
        segments.push({ index: best.index, from: y, to });
        y = to;
        continue;
      }
      const next = views.filter((view) => view.top > y + 0.5)
        .reduce((nearest, view) => Math.min(nearest, view.top), endY);
      const gapEnd = Math.min(next, endY);
      gaps.push({ from: y, to: gapEnd });
      y = gapEnd;
    }
    return { segments, gaps };
  }

  // 删除历史后哪些存档文件夹可以删：被删记录引用、且不再被任何现存记录引用的才删。
  // 只被已自动淘汰的旧记录引用的文件夹不在此列（淘汰时保留存档）。
  function foldersToRelease(index, removedIds, existingIds) {
    const removed = new Set(removedIds || []);
    const existing = new Set(existingIds || []);
    const release = [];
    const keep = [];
    for (const entry of index || []) {
      const ids = Array.isArray(entry.historyIds) ? entry.historyIds : [];
      if (!ids.some((id) => removed.has(id))) {
        keep.push(entry);
        continue;
      }
      const remaining = ids.filter((id) => !removed.has(id));
      if (remaining.some((id) => existing.has(id))) keep.push({ ...entry, historyIds: remaining });
      else release.push(entry);
    }
    return { release, keep };
  }

  function entriesForHistory(index, historyId) {
    if (!historyId) return [];
    return (index || []).filter((entry) => (entry.historyIds || []).includes(historyId));
  }

  // —— 设置、目录句柄与存档索引 ——

  function isSupported() {
    return typeof globalThis.showDirectoryPicker === "function";
  }

  async function getSettings() {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const value = stored?.[SETTINGS_KEY] || {};
    return { enabled: Boolean(value.enabled), folderName: value.folderName || "" };
  }

  async function setSettings(patch) {
    const current = await getSettings();
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getRootHandle() {
    if (typeof indexedDB === "undefined") return null;
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(DB_STORE).objectStore(DB_STORE).get(ROOT_HANDLE_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async function setRootHandle(handle) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(handle, ROOT_HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  async function permissionState(handle, { request = false } = {}) {
    if (!handle) return "none";
    try {
      const state = await handle.queryPermission({ mode: "readwrite" });
      if (state === "granted" || !request) return state;
      return await handle.requestPermission({ mode: "readwrite" });
    } catch {
      return "denied";
    }
  }

  async function hasCapturePermission() {
    try {
      return await chrome.permissions.contains({ origins: CAPTURE_ORIGINS });
    } catch {
      return false;
    }
  }

  function requestCapturePermission() {
    return chrome.permissions.request({ origins: CAPTURE_ORIGINS });
  }

  // 索引写入串行化，避免并行存档互相覆盖
  let indexWrite = Promise.resolve();

  async function getIndex() {
    const stored = await chrome.storage.local.get(INDEX_KEY);
    return Array.isArray(stored?.[INDEX_KEY]) ? stored[INDEX_KEY] : [];
  }

  function updateIndex(mutator) {
    const run = indexWrite.then(async () => {
      const next = (await mutator(await getIndex())) || [];
      await chrome.storage.local.set({ [INDEX_KEY]: next.slice(-MAX_INDEX_ENTRIES) });
      return next;
    });
    indexWrite = run.catch(() => {});
    return run;
  }

  function upsertIndexEntry(entry) {
    return updateIndex((index) => {
      const existing = index.find((item) => item.folder === entry.folder);
      const historyIds = [...new Set([...(existing?.historyIds || []), ...(entry.historyIds || [])])];
      const merged = { ...existing, ...entry, historyIds };
      return existing
        ? index.map((item) => (item.folder === entry.folder ? merged : item))
        : [...index, merged];
    });
  }

  function linkIndexHistory(key, historyId) {
    if (!key || !historyId) return Promise.resolve(null);
    return updateIndex((index) => index.map((entry) => (
      entry.key === key && !(entry.historyIds || []).includes(historyId)
        ? { ...entry, historyIds: [...(entry.historyIds || []), historyId] }
        : entry
    )));
  }

  function saveIndex(entries) {
    return updateIndex(() => entries);
  }

  // —— 写文件 ——

  async function entryExists(dir, name) {
    try {
      await dir.getDirectoryHandle(name);
      return true;
    } catch {
      try {
        await dir.getFileHandle(name);
        return true;
      } catch {
        return false;
      }
    }
  }

  async function createFolder(root, baseName) {
    let name = baseName;
    for (let suffix = 2; await entryExists(root, name); suffix += 1) name = `${baseName}-${suffix}`;
    await root.getDirectoryHandle(name, { create: true });
    return name;
  }

  async function writeFiles(root, folder, files) {
    const dir = await root.getDirectoryHandle(folder, { create: true });
    for (const file of files) {
      const handle = await dir.getFileHandle(file.name, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(file.blob);
      } finally {
        await writable.close();
      }
    }
  }

  async function removeFolder(root, name) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
    }
  }

  async function dataUrlToBlob(dataUrl) {
    return (await fetch(dataUrl)).blob();
  }

  function textBlob(text) {
    return new Blob([String(text || "")], { type: "text/plain;charset=utf-8" });
  }

  function jsonBlob(payload) {
    return new Blob([payloadJson(payload)], { type: "application/json;charset=utf-8" });
  }

  // 帖文配图：直接从图片服务器下载页面上的图片文件，不做任何处理；视频帖存截帧。
  async function collectMediaFiles(payload) {
    const images = Array.isArray(payload?.media?.images) ? payload.media.images : [];
    const isVideo = Boolean(payload?.media?.video);
    const files = [];
    let failed = 0;
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      try {
        let blob;
        if (typeof image?.dataUrl === "string" && image.dataUrl.startsWith("data:image/")) {
          blob = await dataUrlToBlob(image.dataUrl);
        } else {
          const response = await fetch(image.url, { credentials: "omit" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          blob = await response.blob();
        }
        files.push({
          name: `${isVideo ? "视频截帧" : "配图"}-${pad2(index + 1)}.${imageExtension(blob.type, image?.url)}`,
          blob
        });
      } catch {
        failed += 1;
      }
    }
    return { files, failed };
  }

  // 用户上传的截图本身就是原始画面，原样保存。来源可以是 data URL，也可以是原始文件（长图切段前的 File）。
  async function screenshotFiles(sources) {
    const files = [];
    for (let index = 0; index < (sources || []).length; index += 1) {
      const source = sources[index];
      const blob = typeof source === "string" ? await dataUrlToBlob(source) : source;
      files.push({ name: `原始截图-${pad2(index + 1)}.${imageExtension(blob.type)}`, blob });
    }
    return files;
  }

  // —— 注入帖文页执行的函数（必须自包含） ——

  // 滚到 target（null 表示不滚），等可见图片加载，再量截取区域与吸顶/底栏遮挡。
  // 小红书：截取帖文所在的滚动区域（宽窗口是弹窗右侧的 .note-scroller；窄窗口上下排列时是外层容器或整个页面）；
  // 微博：页面整体滚动，截取正文所在的那一栏。
  // 返回的 scrollTop 是「截取区域上沿对应的滚动内容坐标」，target 也按这个坐标给。
  async function pageMeasure(mode, target) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isXhs = mode === "xhs";
    // 找真正在滚的区域：宽窗口下是 .note-scroller 自己；窗口变窄、帖文改成上下排列后，.note-scroller 不再滚动，
    // 滚的是外层容器或整个页面。取自身或祖先中第一个设了滚动且内容超出的；都没有时，帖文不在固定定位的弹层里
    // 就用页面；再不然退回第一个设了滚动的（内容没超出、不用滚）。本段在各页面函数里保持一致（页面函数必须自包含）。
    const resolveXhs = () => {
      const note = document.querySelector(".note-scroller");
      if (!note) return null;
      const page = document.scrollingElement || document.documentElement;
      const styled = (element) => /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY);
      const overflowing = (element) => element.scrollHeight > element.clientHeight + 4;
      let firstStyled = null;
      let insideFixed = false;
      for (let node = note; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (styled(node)) {
          if (overflowing(node)) return { note, scroller: node, isPage: false };
          firstStyled = firstStyled || node;
        }
        if (getComputedStyle(node).position === "fixed") insideFixed = true;
      }
      if (!insideFixed && page && overflowing(page)) return { note, scroller: page, isPage: true };
      return { note, scroller: firstStyled || note, isPage: false };
    };
    // 截取区域：横向取帖文那一栏，纵向取滚动区域在屏幕上看得见的部分；originTop 是滚动内容坐标 0 在屏幕上的位置
    const xhsFrame = ({ note, scroller, isPage }) => {
      const viewWidth = document.documentElement.clientWidth;
      const viewHeight = document.documentElement.clientHeight;
      let originTop = 0;
      let top = 0;
      let bottom = viewHeight;
      let left = 0;
      let right = viewWidth;
      if (!isPage) {
        const box = scroller.getBoundingClientRect();
        originTop = box.top + scroller.clientTop;
        top = Math.max(0, originTop);
        bottom = Math.min(viewHeight, originTop + scroller.clientHeight);
        left = box.left + scroller.clientLeft;
        right = left + scroller.clientWidth;
      }
      if (scroller !== note) {
        const noteBox = note.getBoundingClientRect();
        left = Math.max(left, noteBox.left);
        right = Math.min(right, noteBox.right);
      }
      left = Math.max(0, left);
      right = Math.min(viewWidth, right);
      return {
        rect: { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) },
        originTop,
        scrollTop: isPage ? window.scrollY : scroller.scrollTop
      };
    };
    const weiboColumn = () => {
      const tab = document.querySelector(".wbpro-tab3");
      const article = document.querySelector("article");
      if (!tab || !article) return null;
      let node = tab.parentElement;
      while (node && node !== document.body && !node.contains(article)) node = node.parentElement;
      return node && node !== document.body ? node : null;
    };
    const found = isXhs ? resolveXhs() : null;
    if (isXhs && !found) return { error: "页面上找不到帖文滚动区域" };

    if (target != null) {
      if (isXhs) {
        const before = xhsFrame(found);
        const value = Math.max(0, target - (before.rect.top - before.originTop));
        if (found.isPage) {
          window.scrollTo(0, value);
        } else {
          found.scroller.scrollTop = value;
          found.scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
      } else {
        window.scrollTo(0, target);
      }
      await wait(400);
    }

    let rect;
    let contentEnd;
    let column = null;
    let originTop = 0;
    let rawScrollTop = window.scrollY;
    if (isXhs) {
      const frame = xhsFrame(found);
      rect = frame.rect;
      originTop = frame.originTop;
      rawScrollTop = frame.scrollTop;
      contentEnd = found.scroller.scrollHeight;
    } else {
      const viewWidth = document.documentElement.clientWidth;
      const viewHeight = document.documentElement.clientHeight;
      column = weiboColumn();
      if (column) {
        const box = column.getBoundingClientRect();
        const left = Math.max(0, box.left);
        rect = { left, top: 0, width: Math.max(1, Math.min(viewWidth, box.right) - left), height: viewHeight };
        contentEnd = box.bottom + window.scrollY;
      } else {
        rect = { left: 0, top: 0, width: viewWidth, height: viewHeight };
        contentEnd = document.scrollingElement.scrollHeight;
      }
    }

    const scope = isXhs ? found.note : (column || document.body);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const pending = Array.from(scope.querySelectorAll("img")).some((img) => {
        const box = img.getBoundingClientRect();
        return box.width > 0 && box.bottom > rect.top && box.top < rect.top + rect.height && !img.complete;
      });
      if (!pending) break;
      await wait(150);
    }

    // 吸顶/底栏：横跨截取区域一半以上、贴着上沿（或彼此相连）的固定元素都算遮挡
    const overlays = [];
    const overlayScope = isXhs && !found.isPage ? found.scroller : document.body;
    for (const element of overlayScope.querySelectorAll("*")) {
      const position = getComputedStyle(element).position;
      if (position !== "sticky" && position !== "fixed") continue;
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.bottom <= rect.top || box.top >= rect.top + rect.height) continue;
      const overlap = Math.min(box.right, rect.left + rect.width) - Math.max(box.left, rect.left);
      if (overlap < rect.width * 0.5) continue;
      overlays.push({ top: box.top - rect.top, bottom: box.bottom - rect.top });
    }
    let inset = 0;
    for (const item of overlays.slice().sort((a, b) => a.top - b.top)) {
      if (item.top <= inset + 12) inset = Math.max(inset, item.bottom);
    }
    let bottomInset = 0;
    for (const item of overlays.slice().sort((a, b) => b.bottom - a.bottom)) {
      if (item.bottom >= rect.height - bottomInset - 12 && item.top > inset) {
        bottomInset = Math.max(bottomInset, rect.height - item.top);
      }
    }
    // 弹层自己的顶栏、底栏不在滚动容器里，上面那步扫不到：按点命中找出盖在截取区域上下沿的东西
    if (isXhs && !found.isPage && typeof document.elementFromPoint === "function") {
      const xs = [0.3, 0.5, 0.7].map((fraction) => rect.left + rect.width * fraction);
      const covered = (y) => xs.every((x) => {
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit) && !found.scroller.contains(hit);
      });
      const limit = rect.height * 0.4;
      let top = 0;
      while (top < limit && covered(rect.top + top + 1)) top += 4;
      let bottom = 0;
      while (bottom < limit && covered(rect.top + rect.height - bottom - 2)) bottom += 4;
      if (top < limit) inset = Math.max(inset, top);
      if (bottom < limit) bottomInset = Math.max(bottomInset, bottom);
    }
    if (inset + bottomInset >= rect.height * 0.8) {
      inset = 0;
      bottomInset = 0;
    }
    // 锚点：评论区顶部与每条一级评论顶部的位置。边加载边截图时用来核对截图之后页面有没有错位
    let anchors = null;
    if (isXhs) {
      const toY = (value) => value - originTop + rawScrollTop;
      const commentsBox = found.note.querySelector(".comments-container") || found.note.querySelector(".comments-el");
      anchors = {
        box: commentsBox ? toY(commentsBox.getBoundingClientRect().top) : null,
        items: Array.from(found.note.querySelectorAll(".parent-comment")).slice(0, 80)
          .map((element) => toY(element.getBoundingClientRect().top))
      };
    }
    return {
      scrollTop: isXhs ? rect.top - originTop + rawScrollTop : window.scrollY,
      contentEnd,
      rect,
      inset,
      bottomInset,
      innerWidth: window.innerWidth,
      anchors
    };
  }

  // 截图前后记下并恢复滚动位置（容器自身的 scrollTop，不经坐标换算）
  function pageScrollPosition(mode) {
    if (mode !== "xhs") return window.scrollY;
    // 找真正在滚的区域：宽窗口下是 .note-scroller 自己；窗口变窄、帖文改成上下排列后，.note-scroller 不再滚动，
    // 滚的是外层容器或整个页面。取自身或祖先中第一个设了滚动且内容超出的；都没有时，帖文不在固定定位的弹层里
    // 就用页面；再不然退回第一个设了滚动的（内容没超出、不用滚）。本段在各页面函数里保持一致（页面函数必须自包含）。
    const resolveXhs = () => {
      const note = document.querySelector(".note-scroller");
      if (!note) return null;
      const page = document.scrollingElement || document.documentElement;
      const styled = (element) => /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY);
      const overflowing = (element) => element.scrollHeight > element.clientHeight + 4;
      let firstStyled = null;
      let insideFixed = false;
      for (let node = note; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (styled(node)) {
          if (overflowing(node)) return { note, scroller: node, isPage: false };
          firstStyled = firstStyled || node;
        }
        if (getComputedStyle(node).position === "fixed") insideFixed = true;
      }
      if (!insideFixed && page && overflowing(page)) return { note, scroller: page, isPage: true };
      return { note, scroller: firstStyled || note, isPage: false };
    };
    // 截取区域：横向取帖文那一栏，纵向取滚动区域在屏幕上看得见的部分；originTop 是滚动内容坐标 0 在屏幕上的位置
    const xhsFrame = ({ note, scroller, isPage }) => {
      const viewWidth = document.documentElement.clientWidth;
      const viewHeight = document.documentElement.clientHeight;
      let originTop = 0;
      let top = 0;
      let bottom = viewHeight;
      let left = 0;
      let right = viewWidth;
      if (!isPage) {
        const box = scroller.getBoundingClientRect();
        originTop = box.top + scroller.clientTop;
        top = Math.max(0, originTop);
        bottom = Math.min(viewHeight, originTop + scroller.clientHeight);
        left = box.left + scroller.clientLeft;
        right = left + scroller.clientWidth;
      }
      if (scroller !== note) {
        const noteBox = note.getBoundingClientRect();
        left = Math.max(left, noteBox.left);
        right = Math.min(right, noteBox.right);
      }
      left = Math.max(0, left);
      right = Math.min(viewWidth, right);
      return {
        rect: { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) },
        originTop,
        scrollTop: isPage ? window.scrollY : scroller.scrollTop
      };
    };
    const found = resolveXhs();
    if (!found) return null;
    return found.isPage ? window.scrollY : found.scroller.scrollTop;
  }

  function pageRestoreScroll(mode, value) {
    if (mode !== "xhs") {
      window.scrollTo(0, value);
      return true;
    }
    // 找真正在滚的区域：宽窗口下是 .note-scroller 自己；窗口变窄、帖文改成上下排列后，.note-scroller 不再滚动，
    // 滚的是外层容器或整个页面。取自身或祖先中第一个设了滚动且内容超出的；都没有时，帖文不在固定定位的弹层里
    // 就用页面；再不然退回第一个设了滚动的（内容没超出、不用滚）。本段在各页面函数里保持一致（页面函数必须自包含）。
    const resolveXhs = () => {
      const note = document.querySelector(".note-scroller");
      if (!note) return null;
      const page = document.scrollingElement || document.documentElement;
      const styled = (element) => /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY);
      const overflowing = (element) => element.scrollHeight > element.clientHeight + 4;
      let firstStyled = null;
      let insideFixed = false;
      for (let node = note; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (styled(node)) {
          if (overflowing(node)) return { note, scroller: node, isPage: false };
          firstStyled = firstStyled || node;
        }
        if (getComputedStyle(node).position === "fixed") insideFixed = true;
      }
      if (!insideFixed && page && overflowing(page)) return { note, scroller: page, isPage: true };
      return { note, scroller: firstStyled || note, isPage: false };
    };
    // 截取区域：横向取帖文那一栏，纵向取滚动区域在屏幕上看得见的部分；originTop 是滚动内容坐标 0 在屏幕上的位置
    const xhsFrame = ({ note, scroller, isPage }) => {
      const viewWidth = document.documentElement.clientWidth;
      const viewHeight = document.documentElement.clientHeight;
      let originTop = 0;
      let top = 0;
      let bottom = viewHeight;
      let left = 0;
      let right = viewWidth;
      if (!isPage) {
        const box = scroller.getBoundingClientRect();
        originTop = box.top + scroller.clientTop;
        top = Math.max(0, originTop);
        bottom = Math.min(viewHeight, originTop + scroller.clientHeight);
        left = box.left + scroller.clientLeft;
        right = left + scroller.clientWidth;
      }
      if (scroller !== note) {
        const noteBox = note.getBoundingClientRect();
        left = Math.max(left, noteBox.left);
        right = Math.min(right, noteBox.right);
      }
      left = Math.max(0, left);
      right = Math.min(viewWidth, right);
      return {
        rect: { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) },
        originTop,
        scrollTop: isPage ? window.scrollY : scroller.scrollTop
      };
    };
    const found = resolveXhs();
    if (!found) return false;
    if (found.isPage) {
      window.scrollTo(0, value);
    } else {
      found.scroller.scrollTop = value;
      found.scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    return true;
  }

  // 评论区在滚动内容里的范围：从评论区顶部到第 limit 条一级评论底部（不足 limit 条时到评论区底部）
  function xhsCommentRange(limit) {
    // 找真正在滚的区域：宽窗口下是 .note-scroller 自己；窗口变窄、帖文改成上下排列后，.note-scroller 不再滚动，
    // 滚的是外层容器或整个页面。取自身或祖先中第一个设了滚动且内容超出的；都没有时，帖文不在固定定位的弹层里
    // 就用页面；再不然退回第一个设了滚动的（内容没超出、不用滚）。本段在各页面函数里保持一致（页面函数必须自包含）。
    const resolveXhs = () => {
      const note = document.querySelector(".note-scroller");
      if (!note) return null;
      const page = document.scrollingElement || document.documentElement;
      const styled = (element) => /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY);
      const overflowing = (element) => element.scrollHeight > element.clientHeight + 4;
      let firstStyled = null;
      let insideFixed = false;
      for (let node = note; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
        if (styled(node)) {
          if (overflowing(node)) return { note, scroller: node, isPage: false };
          firstStyled = firstStyled || node;
        }
        if (getComputedStyle(node).position === "fixed") insideFixed = true;
      }
      if (!insideFixed && page && overflowing(page)) return { note, scroller: page, isPage: true };
      return { note, scroller: firstStyled || note, isPage: false };
    };
    // 截取区域：横向取帖文那一栏，纵向取滚动区域在屏幕上看得见的部分；originTop 是滚动内容坐标 0 在屏幕上的位置
    const xhsFrame = ({ note, scroller, isPage }) => {
      const viewWidth = document.documentElement.clientWidth;
      const viewHeight = document.documentElement.clientHeight;
      let originTop = 0;
      let top = 0;
      let bottom = viewHeight;
      let left = 0;
      let right = viewWidth;
      if (!isPage) {
        const box = scroller.getBoundingClientRect();
        originTop = box.top + scroller.clientTop;
        top = Math.max(0, originTop);
        bottom = Math.min(viewHeight, originTop + scroller.clientHeight);
        left = box.left + scroller.clientLeft;
        right = left + scroller.clientWidth;
      }
      if (scroller !== note) {
        const noteBox = note.getBoundingClientRect();
        left = Math.max(left, noteBox.left);
        right = Math.min(right, noteBox.right);
      }
      left = Math.max(0, left);
      right = Math.min(viewWidth, right);
      return {
        rect: { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) },
        originTop,
        scrollTop: isPage ? window.scrollY : scroller.scrollTop
      };
    };
    const found = resolveXhs();
    const box = found?.note.querySelector(".comments-container") || found?.note.querySelector(".comments-el");
    if (!found || !box) return { error: "页面上找不到评论区" };
    const frame = xhsFrame(found);
    const toY = (value) => value - frame.originTop + frame.scrollTop;
    const startY = toY(box.getBoundingClientRect().top);
    const parents = Array.from(found.note.querySelectorAll(".parent-comment"));
    const endY = parents.length > limit
      ? toY(parents[limit - 1].getBoundingClientRect().bottom) + 16
      : toY(box.getBoundingClientRect().bottom);
    return { startY, endY: Math.min(endY, found.scroller.scrollHeight), comments: Math.min(parents.length, limit) };
  }

  function weiboCommentRange() {
    const tab = document.querySelector(".wbpro-tab3");
    const article = document.querySelector("article");
    if (!tab || !article) return { error: "页面上找不到评论区" };
    return { startY: article.getBoundingClientRect().bottom + window.scrollY };
  }

  // —— 截图（在侧边栏中执行） ——

  async function inPage(tabId, func, args = []) {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return result?.result;
  }

  let lastCaptureAt = 0;

  // 每截一屏前后都确认目标页签仍在前台：切走了就停，绝不把别的页面存进存档
  async function captureTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.active) throw new Error(SWITCHED_MESSAGE);
    const win = chrome.windows?.get ? await chrome.windows.get(tab.windowId) : null;
    if (win?.state === "minimized") throw new Error("浏览器窗口被最小化，已停止截图。");
    const gap = MIN_CAPTURE_GAP_MS - (Date.now() - lastCaptureAt);
    if (gap > 0) await sleep(gap);
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    } catch (error) {
      const message = String(error?.message || error || "");
      if (/all_urls|activeTab|permission/i.test(message)) throw new Error(PERMISSION_MESSAGE);
      throw new Error(`截图失败：${message || "未知错误"}`);
    } finally {
      lastCaptureAt = Date.now();
    }
    const after = await chrome.tabs.get(tabId);
    if (!after?.active) throw new Error(SWITCHED_MESSAGE);
    return dataUrl;
  }

  async function captureLong(tabId, mode, startY, endCap, maxScreens, onScreen) {
    const segments = [];
    let y = startY;
    let inset = 0;
    let end = endCap;
    let truncated = false;
    for (let screen = 0; y < end - 0.5; screen += 1) {
      if (screen >= maxScreens) {
        truncated = true;
        break;
      }
      let geometry = await inPage(tabId, pageMeasure, [mode, Math.max(0, y - inset)]);
      if (!geometry || geometry.error) throw new Error(geometry?.error || "无法测量页面");
      if (Math.abs(geometry.inset - inset) > 0.5) {
        inset = geometry.inset;
        geometry = await inPage(tabId, pageMeasure, [mode, Math.max(0, y - inset)]);
        if (!geometry || geometry.error) throw new Error(geometry?.error || "无法测量页面");
      }
      end = Math.min(endCap, geometry.contentEnd);
      if (y >= end - 0.5) break;
      if (typeof onScreen === "function") onScreen(screen + 1);
      const dataUrl = await captureTab(tabId);
      const visibleTop = geometry.scrollTop + geometry.inset;
      const visibleBottom = geometry.scrollTop + geometry.rect.height - geometry.bottomInset;
      const from = Math.max(y, visibleTop);
      const to = Math.min(visibleBottom, end);
      if (to <= from + 0.5) break;
      segments.push({ dataUrl, from, to, scrollTop: geometry.scrollTop, rect: geometry.rect, innerWidth: geometry.innerWidth });
      y = to;
    }
    return { segments, startY: segments[0]?.from ?? startY, endY: y, truncated };
  }

  async function composeLong(segments, startY, endY) {
    const decoded = [];
    try {
      for (const segment of segments) {
        const bitmap = await createImageBitmap(await dataUrlToBlob(segment.dataUrl));
        decoded.push({ ...segment, bitmap, scale: bitmap.width / segment.innerWidth });
      }
      const plan = planComposite(decoded, startY, endY);
      const blobs = [];
      for (const part of plan.parts) {
        const canvas = new OffscreenCanvas(plan.width, part.height);
        const context = canvas.getContext("2d");
        for (const draw of part.draws) {
          const bitmap = decoded[draw.index].bitmap;
          // 截取位置超出这一屏画面：说明测量出错，报错而不是静默拼出空白图
          if (draw.sy < -1 || draw.sx < -1 || draw.sy + draw.sh > bitmap.height + 1 || draw.sx + draw.sw > bitmap.width + 1) {
            throw new Error("评论区截取位置超出画面，未能拼接长截图。");
          }
          context.drawImage(bitmap, draw.sx, draw.sy, draw.sw, draw.sh, 0, draw.dy, draw.sw, draw.sh);
        }
        blobs.push(await canvas.convertToBlob({ type: "image/png" }));
      }
      return blobs;
    } finally {
      decoded.forEach((item) => item.bitmap?.close?.());
    }
  }

  // —— 边加载边截（小红书）：采集脚本每滚一步请侧边栏截一帧，收尾时核对错位、补截缺口 ——

  function frameFromGeometry(geometry, dataUrl) {
    return {
      dataUrl,
      scrollTop: geometry.scrollTop,
      rect: geometry.rect,
      inset: geometry.inset,
      bottomInset: geometry.bottomInset,
      innerWidth: geometry.innerWidth,
      anchors: geometry.anchors
    };
  }

  // 开始：滚到顶截帖文初始屏，这一屏同时作为第一帧
  async function liveStart(tabId) {
    if (!(await hasCapturePermission())) throw new Error(PERMISSION_MESSAGE);
    const geometry = await inPage(tabId, pageMeasure, ["xhs", 0]);
    if (!geometry || geometry.error) throw new Error(geometry?.error || "无法测量页面");
    const dataUrl = await captureTab(tabId);
    return {
      file: { name: FILE_NAMES.firstScreen, blob: await dataUrlToBlob(dataUrl) },
      frame: frameFromGeometry(geometry, dataUrl)
    };
  }

  // 采集脚本滚完一步、等过新评论之后：不再滚动，原地截一帧
  async function liveFrame(tabId) {
    const geometry = await inPage(tabId, pageMeasure, ["xhs", null]);
    if (!geometry || geometry.error) throw new Error(geometry?.error || "无法测量页面");
    return frameFromGeometry(geometry, await captureTab(tabId));
  }

  // 收尾（评论已加载完、采集脚本还没恢复滚动位置）：定评论区范围，丢掉错位的帧，补截缺口
  async function liveFinish(tabId, frames, limit = 50, onTopUp) {
    const warnings = [];
    const range = await inPage(tabId, xhsCommentRange, [limit]);
    if (!range || range.error) {
      return { segments: [], warnings: [`评论区未截取：${range?.error || "页面没有返回评论区位置"}`], topUp: 0, reused: 0 };
    }
    if (range.endY - range.startY < 4) return { segments: [], warnings: ["该帖没有可截取的评论。"], topUp: 0, reused: 0 };
    const final = await inPage(tabId, pageMeasure, ["xhs", null]);
    if (!final || final.error) throw new Error(final?.error || "无法测量页面");
    const valid = (frames || []).filter((frame) => frameStillValid(frame, final.anchors));
    const plan = planCoverage(valid, range.startY, range.endY);
    const segments = plan.segments.map((segment) => {
      const frame = valid[segment.index];
      return {
        dataUrl: frame.dataUrl,
        from: segment.from,
        to: segment.to,
        scrollTop: frame.scrollTop,
        rect: frame.rect,
        innerWidth: frame.innerWidth
      };
    });
    let topUp = 0;
    for (const gap of plan.gaps) {
      const long = await captureLong(tabId, "xhs", gap.from, gap.to, MAX_XHS_COMMENT_SCREENS, () => {
        topUp += 1;
        if (typeof onTopUp === "function") onTopUp(topUp);
      });
      segments.push(...long.segments);
      if (long.endY < gap.to - 0.5) warnings.push("评论区有一段没有截到。");
    }
    segments.sort((a, b) => a.from - b.from);
    return { segments, warnings, topUp, reused: plan.segments.length };
  }

  async function composeCommentFiles(segments) {
    if (!segments?.length) return [];
    const parts = await composeLong(segments, segments[0].from, segments[segments.length - 1].to);
    return parts.map((blob, index) => ({
      name: parts.length === 1 ? `${FILE_NAMES.comments}.png` : `${FILE_NAMES.comments}-${index + 1}.png`,
      blob
    }));
  }

  // 截帖文初始屏与评论区长截图。评论已由采集脚本加载好，这里只滚动与截取，结束后恢复滚动位置。
  async function captureScreens({ tabId, platform, limit = 50, onProgress } = {}) {
    if (!(await hasCapturePermission())) throw new Error(PERMISSION_MESSAGE);
    const mode = platform === "weibo" ? "weibo" : "xhs";
    const report = (text) => { if (typeof onProgress === "function") onProgress(text); };
    const files = [];
    const warnings = [];
    const original = await inPage(tabId, pageScrollPosition, [mode]).catch(() => null);
    try {
      report("正在截取帖文初始屏");
      const first = await inPage(tabId, pageMeasure, [mode, 0]);
      if (!first || first.error) throw new Error(first?.error || "无法测量页面");
      files.push({ name: FILE_NAMES.firstScreen, blob: await dataUrlToBlob(await captureTab(tabId)) });

      const range = await inPage(tabId, mode === "xhs" ? xhsCommentRange : weiboCommentRange, [limit]);
      if (!range || range.error) {
        warnings.push(`评论区未截取：${range?.error || "页面没有返回评论区位置"}`);
        return { files, warnings };
      }
      const endCap = mode === "xhs" ? range.endY : Infinity;
      if (endCap - range.startY < 4) {
        warnings.push("该帖没有可截取的评论。");
        return { files, warnings };
      }
      const maxScreens = mode === "xhs" ? MAX_XHS_COMMENT_SCREENS : MAX_WEIBO_COMMENT_SCREENS;
      const long = await captureLong(tabId, mode, range.startY, endCap, maxScreens,
        (screen) => report(`正在截取评论区（第 ${screen} 屏）`));
      if (!long.segments.length) {
        warnings.push("评论区没有截到内容。");
        return { files, warnings };
      }
      if (long.truncated) warnings.push(`评论区较长，只截取了前 ${maxScreens} 屏。`);
      report("正在拼接评论区长截图");
      const parts = await composeLong(long.segments, long.startY, long.endY);
      parts.forEach((blob, index) => {
        files.push({
          name: parts.length === 1 ? `${FILE_NAMES.comments}.png` : `${FILE_NAMES.comments}-${index + 1}.png`,
          blob
        });
      });
      return { files, warnings };
    } catch (error) {
      // 截到一半被打断：已截到的部分随错误带回，调用方可先存下来
      const wrapped = error instanceof Error ? error : new Error(String(error));
      wrapped.partialFiles = files.slice();
      throw wrapped;
    } finally {
      if (original != null) await inPage(tabId, pageRestoreScroll, [mode, original]).catch(() => {});
    }
  }

  globalThis.XhsArchive = Object.freeze({
    SETTINGS_KEY,
    INDEX_KEY,
    CAPTURE_ORIGINS,
    FILE_NAMES,
    SWITCHED_MESSAGE,
    PERMISSION_MESSAGE,
    captureMeta,
    captureKey,
    sanitizeName,
    folderName,
    imageExtension,
    payloadJson,
    planComposite,
    foldersToRelease,
    entriesForHistory,
    frameStillValid,
    planCoverage,
    isSupported,
    getSettings,
    setSettings,
    getRootHandle,
    setRootHandle,
    permissionState,
    hasCapturePermission,
    requestCapturePermission,
    getIndex,
    upsertIndexEntry,
    linkIndexHistory,
    saveIndex,
    createFolder,
    writeFiles,
    removeFolder,
    textBlob,
    jsonBlob,
    collectMediaFiles,
    screenshotFiles,
    captureScreens,
    liveStart,
    liveFrame,
    liveFinish,
    composeCommentFiles,
    // 以下供测试使用
    pageMeasure,
    xhsCommentRange,
    weiboCommentRange
  });
})();
