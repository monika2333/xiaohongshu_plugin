const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const downloads = [];
const storageState = { local: {}, session: {} };
const accessLevels = [];

function storageArea(name) {
  return {
    get: async (keys) => {
      const state = storageState[name];
      if (keys == null) return { ...state };
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => key in state).map((key) => [key, state[key]]));
    },
    set: async (values) => { Object.assign(storageState[name], values); },
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[name][key];
    },
    setAccessLevel: async (options) => { accessLevels.push({ name, ...options }); }
  };
}

let context;
context = {
  chrome: {
    downloads: {
      download: async (options) => {
        downloads.push(options);
        return downloads.length;
      }
    },
    runtime: {
      onMessage: { addListener: () => {} },
      getURL: (value = "") => `chrome-extension://test/${value}`
    },
    storage: {
      local: storageArea("local"),
      session: storageArea("session")
    }
  },
  console,
  encodeURIComponent,
  Promise,
  URL,
  Uint8Array,
  AbortController,
  setTimeout,
  clearTimeout,
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  importScripts: (filename) => {
    const imported = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
    vm.runInContext(imported, context, { filename });
  }
};

vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
vm.runInContext(source, context, { filename: "service-worker.js" });

const payload = {
  exportedAt: "2026-08-16T00:00:00.000Z",
  source: {
    platform: "xiaohongshu",
    noteId: "6a76029300000000250070c1",
    url: "https://www.xiaohongshu.com/explore/6a76029300000000250070c1?xsec_token=test-token&xsec_source=pc_feed"
  },
  note: {
    title: "测试/帖文",
    author: "测试用户",
    publishedDisplay: "08-08",
    location: "浙江",
    content: "正文"
  },
  interactions: {
    likes: { raw: "12", value: 12 },
    collects: { raw: "3", value: 3 },
    comments: { raw: "100", value: 100 }
  },
  commentExport: {
    extractedTopLevelCount: 1,
    comments: [
      {
        kind: "top_level",
        id: "comment-1",
        parentCommentId: null,
        author: "甲",
        userId: "user-1",
        content: "包含,逗号与\"引号\"",
        publishedDisplay: "1天前",
        location: "上海",
        likes: { raw: "2", value: 2 },
        displayedReplyCount: 1,
        isAuthor: false,
        isPinned: false,
        visibleReplies: [
          {
            kind: "visible_reply",
            id: "reply-1",
            parentCommentId: "comment-1",
            author: "乙",
            userId: "user-2",
            content: "回复内容",
            publishedDisplay: "1天前",
            location: "江苏",
            likes: { raw: "赞", value: null },
            displayedReplyCount: 0,
            isAuthor: false,
            isPinned: false
          }
        ]
      }
    ]
  },
  media: {
    images: [
      {
        url: "https://sns-webpic-qc.xhscdn.com/example.webp",
        width: 1080,
        height: 1440
      }
    ]
  }
};

(async () => {
  assert.equal(context.sanitizeFilename("测试/帖文"), "测试-帖文");
  const csv = context.commentsToCsv(payload);
  assert.match(csv, /"包含,逗号与""引号"""/);
  assert.match(csv, /visible_reply/);

  const result = await context.downloadExport(payload, { downloadImages: true });
  assert.equal(result.ok, true);
  assert.equal(result.imageCount, 1);
  assert.equal(downloads.length, 4);
  assert.ok(downloads.some((item) => item.filename.endsWith("note.json")));
  assert.ok(downloads.some((item) => item.filename.endsWith("note.md")));
  assert.ok(downloads.some((item) => item.filename.endsWith("comments.csv")));
  assert.ok(downloads.some((item) => item.filename.endsWith("images/001.webp")));
  assert.ok(downloads.every((item) => !item.filename.includes("测试/帖文")));

  const structured = {
    headline: "高校教师称被移出工作群",
    eventSummary: "8月17日，小红书用户发帖反映其被移出学院工作群",
    opinionPoints: ["部分网民质疑相关管理方式", "部分网民猜测事件与职称评定有关"]
  };
  const rendered = context.XhsAi.renderSummary(structured, payload);
  assert.match(rendered, /^★ 高校教师称被移出工作群\n/);
  assert.match(rendered, /12次点赞、100条评论/);
  assert.match(rendered, /部分网民质疑相关管理方式。/);
  assert.match(rendered, /（小红书 https:\/\/www\.xiaohongshu\.com\/explore\/6a76029300000000250070c1\?xsec_token=test-token&xsec_source=pc_feed）$/);
  assert.equal(
    context.XhsAi.originalPageUrl(payload),
    "https://www.xiaohongshu.com/explore/6a76029300000000250070c1?xsec_token=test-token&xsec_source=pc_feed"
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.XhsAi.parseJsonResponse("```json\n{\"ok\":true}\n```"))),
    { ok: true }
  );

  const customConfig = context.XhsAi.normalizeConfig({
    text: { baseUrl: "https://models.example.com/v1/", model: "custom-text" },
    vision: { baseUrl: "https://vision.example.com/openai/v1/", model: "custom-vision" }
  });
  assert.equal(customConfig.text.baseUrl, "https://models.example.com/v1");
  assert.equal(customConfig.text.model, "custom-text");
  assert.equal(customConfig.vision.baseUrl, "https://vision.example.com/openai/v1");
  assert.equal(customConfig.vision.model, "custom-vision");

  await context.saveAiSettings(
    { ...customConfig, rememberApiKeys: true },
    { textApiKey: "persistent-text", visionApiKey: "persistent-vision" }
  );
  assert.equal(storageState.local.xhsAiPersistentSecrets.textApiKey, "persistent-text");
  assert.equal(storageState.session.xhsAiSecrets, undefined);
  assert.equal((await context.getStoredSecrets()).visionApiKey, "persistent-vision");
  assert.deepEqual(accessLevels, [{ name: "local", accessLevel: "TRUSTED_CONTEXTS" }]);

  await context.saveAiSettings(
    { ...customConfig, rememberApiKeys: false },
    { textApiKey: "session-text", visionApiKey: "session-vision" }
  );
  assert.equal(storageState.local.xhsAiPersistentSecrets, undefined);
  assert.equal(storageState.session.xhsAiSecrets.textApiKey, "session-text");
  assert.equal((await context.getStoredSecrets()).visionApiKey, "session-vision");

  await context.clearStoredSecrets();
  assert.equal(storageState.local.xhsAiPersistentSecrets, undefined);
  assert.equal(storageState.session.xhsAiSecrets, undefined);

  let textCalls = 0;
  context.fetch = async (url, options) => {
    textCalls += 1;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-deepseek-key");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              headline: "用户反映测试事件",
              event_summary: "8月8日，小红书用户发帖反映测试事件",
              opinion_points: ["部分网民关注事件进展"],
              warnings: []
            })
          }
        }]
      })
    };
  };
  const textOnlyPayload = { ...payload, media: { images: [] } };
  const cache = {};
  const firstSummary = await context.XhsAi.summarize(
    textOnlyPayload,
    context.XhsAi.DEFAULT_CONFIG,
    { textApiKey: "test-deepseek-key", visionApiKey: "" },
    cache
  );
  assert.match(firstSummary.text, /用户反映测试事件/);
  assert.equal(textCalls, 1);
  const cachedSummary = await context.XhsAi.summarize(
    textOnlyPayload,
    context.XhsAi.DEFAULT_CONFIG,
    { textApiKey: "test-deepseek-key", visionApiKey: "" },
    cache
  );
  assert.equal(cachedSummary.text, firstSummary.text);
  assert.equal(textCalls, 1);

  process.stdout.write("service-worker and AI pipeline smoke tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
