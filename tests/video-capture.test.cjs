const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const NOTE_ID = "6a8268330000000022030779";

const SRT_SAMPLE = [
  "1",
  "00:00:00,000 --> 00:00:02,083",
  "一根棒棒糖直接炸出了全体新疆网友",
  "",
  "2",
  "00:00:02,083 --> 00:00:05,990",
  "事情起因是有网友去新疆旅游",
  "",
  "3",
  "00:00:06,000 --> 00:00:07,737",
  "事情起因是有网友去新疆旅游", // 连续重复行应被去重
  "",
  "4",
  "00:00:08,000 --> 00:00:09,000",
  "新疆<sometag>连糖都甜度超标</sometag>", // HTML 标签应被剥离
  ""
].join("\n");

const VIDEO_NOTE = {
  type: "video",
  video: {
    media: {
      stream: {
        h264: [{
          masterUrl: "http://sns-video-v3.xhscdn.com/stream/master_258.mp4?sign=abc",
          backupUrls: ["http://sns-bak-v1.xhscdn.com/stream/master_258.mp4"],
          duration: 33507,
          width: 720,
          height: 1280
        }]
      }
    },
    mediaV2: {
      video: {
        duration: 34,
        width: 1080,
        height: 1920,
        subtitles: {
          "zh-CN": [{ url: "https://sns-subtitle-s1.xhscdn.com/subtitle/zh.srt?sign=x" }],
          source: [{ url: "https://sns-subtitle-s1.xhscdn.com/subtitle/source.srt" }]
        }
      }
    }
  }
};

function textNode(text) {
  return { innerText: text, textContent: text };
}

function createDetailRoot(videoOverrides = {}) {
  const nodes = new Map([
    ["#detail-title, #detail-desc, .comments-container", textNode("一根 “棒棒糖”，直接炸出了全体新疆网友")],
    ["#detail-title, .title", textNode("一根 “棒棒糖”，直接炸出了全体新疆网友")],
    [".author-wrapper .username", textNode("中优食品网")],
    ["#detail-desc .note-text, #detail-desc, .desc .note-text", textNode("视频正文")],
    [".bottom-container .date", textNode("09-10 新疆")],
    [".comments-container .total", textNode("共 12 条评论")]
  ]);
  nodes.set(".interact-container .like-wrapper .count, .interactions .like-wrapper .count", textNode("1255"));
  nodes.set(".interact-container .collect-wrapper .count, .interactions .collect-wrapper .count", textNode("89"));
  nodes.set(".interact-container .chat-wrapper .count, .interactions .chat-wrapper .count", textNode("12"));

  const root = {
    querySelector(selector) {
      if (selector === ".note-scroller") return videoOverrides.scroller || null;
      if (selector === "video") return videoOverrides.liveVideo || null;
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
  return root;
}

// window 事件路由：模拟隔离世界与页面主世界共享 DOM 事件。
function createWindowRouter() {
  const listeners = [];
  return {
    addEventListener(type, listener) { listeners.push({ type, listener }); },
    removeEventListener(type, listener) {
      const index = listeners.findIndex((item) => item.type === type && item.listener === listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatchEvent(event) {
      for (const item of [...listeners]) {
        if (item.type === event.type) item.listener(event);
      }
      return true;
    }
  };
}

function createFakeVideo(config) {
  const video = {
    crossOrigin: null,
    muted: false,
    preload: "",
    style: {},
    videoWidth: 720,
    videoHeight: 1280,
    readyState: 4,
    duration: NaN,
    _listeners: {},
    addEventListener(type, listener) { (this._listeners[type] ||= []).push(listener); },
    removeEventListener(type, listener) {
      this._listeners[type] = (this._listeners[type] || []).filter((item) => item !== listener);
    },
    remove() { config.removedVideos = (config.removedVideos || 0) + 1; },
    setAttribute(name, value) { this[name] = value; }
  };
  Object.defineProperty(video, "src", {
    set(value) {
      config.videoSrc = value;
      config.videoSrcAttempts = (config.videoSrcAttempts || 0) + 1;
      this.duration = 33.5;
      queueMicrotask(() => {
        const listeners = this._listeners[config.videoLoadFails ? "error" : "loadedmetadata"] || [];
        listeners.forEach((listener) => listener());
      });
    },
    get() { return config.videoSrc; }
  });
  let currentTime = 0;
  Object.defineProperty(video, "currentTime", {
    set(value) {
      currentTime = value;
      config.seekTimestamps = config.seekTimestamps || [];
      config.seekTimestamps.push(value);
      queueMicrotask(() => {
        (this._listeners.seeked || []).forEach((listener) => listener());
      });
    },
    get() { return currentTime; }
  });
  return video;
}

async function runVideoCapture({
  noteDetail = VIDEO_NOTE,
  withBridge = true,
  videoLoadFails = false,
  srtResponse = { ok: true, status: 200 }
} = {}) {
  const config = { videoLoadFails };
  let frameCounter = 0;
  const fakeVideo = createFakeVideo(config);
  const windowRouter = createWindowRouter();
  const progressMessages = [];
  const stateScript = `window.__INITIAL_STATE__=${JSON.stringify({
    note: { noteDetailMap: { [NOTE_ID]: { note: noteDetail } } }
  })}`;

  if (withBridge) {
    windowRouter.addEventListener("XHS_AI_STATE_REQUEST", (event) => {
      queueMicrotask(() => {
        windowRouter.dispatchEvent({
          type: "XHS_AI_STATE_RESPONSE",
          detail: { requestId: event.detail?.requestId, note: noteDetail }
        });
      });
    });
  }

  const detailRoot = createDetailRoot({
    liveVideo: {
      readyState: 4,
      videoWidth: 720,
      videoHeight: 1280,
      currentTime: 7.3
    }
  });

  const documentStub = {
    title: "一根 “棒棒糖”，直接炸出了全体新疆网友 - 小红书",
    body: { appendChild() {} },
    querySelector(selector) {
      return [".note-detail-mask", ".note-detail", "#noteContainer"].includes(selector) ? detailRoot : null;
    },
    querySelectorAll(selector) {
      if (selector === "script:not([src])") return [{ textContent: stateScript }];
      return [];
    },
    createElement(tag) {
      if (tag === "video") return fakeVideo;
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          toDataURL: () => `data:image/jpeg;base64,frame-${++frameCounter}`
        };
      }
      return {};
    }
  };

  const fetchCalls = [];
  const fetchStub = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes(".srt")) {
      return { ok: srtResponse.ok, status: srtResponse.status, text: async () => SRT_SAMPLE };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  let messageListener;
  const chromeStub = {
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
    chrome: chromeStub,
    crypto: { randomUUID: () => "video-page-session" },
    CustomEvent: class { constructor(type, params) { this.type = type; this.detail = params?.detail; } },
    document: documentStub,
    Event,
    fetch: fetchStub,
    globalThis: null,
    location: {
      href: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
      pathname: `/explore/${NOTE_ID}`
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
    window: windowRouter
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "content-script.js"), "utf8"),
    context,
    { filename: "content-script.js" }
  );

  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("video capture response timed out")), 8000);
    const keepChannelOpen = messageListener(
      { type: "XHS_CAPTURE_START", options: { limit: 50 } },
      {},
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      }
    );
    assert.equal(keepChannelOpen, true);
  });

  return { response, config, fetchCalls, progressMessages };
}

(async () => {
  // 1) 桥接可用：视频帖采集到字幕与截帧
  const bridged = await runVideoCapture();
  assert.equal(bridged.response.ok, true);
  const payload = bridged.response.payload;
  assert.equal(payload.note.type, "video");
  assert.equal(payload.media.video.transcriptSource, "auto_subtitle");
  assert.ok(payload.media.video.transcript.includes("一根棒棒糖直接炸出了全体新疆网友"));
  assert.ok(payload.media.video.transcript.includes("连糖都甜度超标"));
  assert.equal(payload.media.video.transcript.split("事情起因是有网友去新疆旅游").length - 1, 1, "连续重复字幕行应去重");
  assert.ok(!payload.media.video.transcript.includes("<sometag>"), "字幕中的 HTML 标签应被剥离");
  assert.equal(payload.media.video.durationSec, 34);
  assert.equal(payload.media.images.length, 6);
  assert.ok(payload.media.images.every((image) => image.source === "video_frame" && image.dataUrl.startsWith("data:image/jpeg")));
  assert.deepEqual([...payload.media.video.frameTimestamps], [3, 8, 13, 19, 24, 29]);
  assert.equal(bridged.config.videoSrc, "https://sns-video-v3.xhscdn.com/stream/master_258.mp4?sign=abc", "视频流地址应升级为 https");
  assert.ok(bridged.fetchCalls.some((url) => url.includes("zh.srt")), "应优先抓取中文字幕");
  assert.equal(payload.uncertainties, undefined, "字幕与画面都成功时不应有警告");
  assert.ok(bridged.progressMessages.some((message) => message.title === "正在读取视频"));

  // 2) 桥接缺失：退回解析 SSR 内联脚本
  const fallback = await runVideoCapture({ withBridge: false });
  assert.equal(fallback.response.payload.note.type, "video");
  assert.equal(fallback.response.payload.media.images.length, 6);
  assert.ok(fallback.response.payload.media.video.transcript.includes("新疆网友"));

  // 3) 视频流加载失败：降级截取当前播放器画面，并记录警告
  const degraded = await runVideoCapture({ videoLoadFails: true });
  const degradedPayload = degraded.response.payload;
  assert.equal(degradedPayload.media.images.length, 1);
  assert.ok(degradedPayload.media.images[0].dataUrl.startsWith("data:image/jpeg"));
  assert.ok(Array.isArray(degradedPayload.uncertainties));
  assert.ok(degradedPayload.uncertainties.some((warning) => warning.includes("视频画面截取失败")));

  // 4) 字幕接口失败：记录警告，口播内容为空，画面证据保留
  const srtFailed = await runVideoCapture({ srtResponse: { ok: false, status: 403 } });
  const srtFailedPayload = srtFailed.response.payload;
  assert.equal(srtFailedPayload.media.video.transcript, null);
  assert.equal(srtFailedPayload.media.images.length, 6);
  assert.ok(srtFailedPayload.uncertainties.some((warning) => warning.includes("自动字幕读取失败")));

  // 5) 图文帖：桥接返回普通帖数据，不应产生视频证据
  const imageNote = await runVideoCapture({ noteDetail: { type: "normal", video: null } });
  const imagePayload = imageNote.response.payload;
  assert.equal(imagePayload.note.type, "normal");
  assert.equal(imagePayload.media.video, null);
  assert.equal(imagePayload.media.images.length, 0);

  // 6) stream 键名为编码名（EF4/EF5…）且无字幕：深扫兜底拿到视频流，字幕警告保留
  const codecNote = await runVideoCapture({
    noteDetail: {
      type: "video",
      video: {
        media: {
          stream: {
            EF4: [{
              masterUrl: "http://sns-video-v2.xhscdn.com/stream/ef4_259.mp4?sign=xyz",
              backupUrls: ["http://sns-bak-v1.xhscdn.com/stream/ef4_259.mp4"],
              duration: 33507,
              width: 720,
              height: 1280
            }],
            EF5: [{ backupUrls: ["http://sns-bak-v1.xhscdn.com/stream/ef5_301.mp4"] }]
          }
        },
        mediaV2: "plain-string-not-object"
      }
    }
  });
  const codecPayload = codecNote.response.payload;
  assert.equal(codecPayload.note.type, "video");
  assert.equal(codecNote.config.videoSrc, "https://sns-video-v2.xhscdn.com/stream/ef4_259.mp4?sign=xyz", "编码名键下应能取到主视频流");
  assert.equal(codecPayload.media.video.durationSec, 34);
  assert.equal(codecPayload.media.video.transcript, null);
  assert.ok(codecPayload.uncertainties.some((warning) => warning.includes("没有平台自动字幕")));
  assert.equal(codecPayload.media.images.length, 6);

  console.log("video capture tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
