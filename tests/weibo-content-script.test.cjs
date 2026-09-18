const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const POST_ID = "RhJDvgyf3";
const POST_URL = `https://weibo.com/1257000310/${POST_ID}`;
const AUTHOR_ID = 1257000310;

const SHOW_BASE = {
  ok: 1,
  id: 5342270053944877,
  idstr: "5342270053944877",
  mblogid: POST_ID,
  created_at: "Sat Sep 12 10:24:58 +0800 2026",
  text_raw: "堂堂的京师大学堂，也要过紧日子了？ \u200b\u200b\u200b",
  isLongText: false,
  region_name: "发布于 山东",
  source: "荣耀400",
  user: { id: AUTHOR_ID, screen_name: "百忍说" },
  pic_ids: ["pic-1"],
  pic_infos: {
    "pic-1": { largest: { url: "https://wx3.sinaimg.cn/large/pic-1.jpg", width: 1080, height: 1440 } }
  },
  reposts_count: 37,
  comments_count: 25,
  attitudes_count: 139,
  tag_struct: [{ tag_name: "京师大学堂" }],
  page_info: null
};

const COMMENT_AUTHOR = { id: 6526487870, screen_name: "用户6526487870" };
const REPLY_AUTHOR = { id: 7934010998, screen_name: "夜雨寄北----" };

const COMMENTS_PAGE_1 = {
  ok: 1,
  total_number: 25,
  max_id: 81319544188,
  data: [
    {
      id: 5342293448196916,
      idstr: "5342293448196916",
      created_at: "Sat Sep 12 11:57:56 +0800 2026",
      like_counts: 5,
      total_number: 3,
      text_raw: "京师大学堂，是北京师范大学",
      user: COMMENT_AUTHOR,
      comments: [
        {
          id: 5342295000000001,
          idstr: "5342295000000001",
          created_at: "Sat Sep 12 12:00:13 +0800 2026",
          like_counts: 15,
          text_raw: "多去读点书再来评论[允悲]",
          user: REPLY_AUTHOR
        }
      ]
    },
    {
      id: 5342296000000002,
      idstr: "5342296000000002",
      created_at: "Sat Sep 12 12:10:00 +0800 2026",
      like_counts: 1,
      total_number: 0,
      text_raw: "博主自己来回复",
      user: { id: AUTHOR_ID, screen_name: "百忍说" },
      comments: []
    }
  ]
};

const COMMENTS_PAGE_2 = {
  ok: 1,
  total_number: 25,
  max_id: 0,
  data: [
    {
      id: 5342297000000003,
      idstr: "5342297000000003",
      created_at: "Sat Sep 12 12:20:00 +0800 2026",
      like_counts: 0,
      total_number: 0,
      text_raw: "第三条评论",
      user: { id: 42, screen_name: "路人甲" },
      comments: []
    },
    // 与第一页重复的评论：翻页重叠时不应重复计入
    { ...COMMENTS_PAGE_1.data[0] }
  ]
};

const LONG_TEXT_CONTENT = "这是长文的完整内容，比截断版长得多。".repeat(3);

function fetchLog() {
  return [];
}

function createEnvironment({ show = { ...SHOW_BASE }, longText = null, commentPages = null } = {}) {
  const requests = [];
  const pages = commentPages || [COMMENTS_PAGE_1, COMMENTS_PAGE_2];

  const fetchImpl = async (url) => {
    requests.push(String(url));
    const respond = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.startsWith("/ajax/statuses/show")) return respond(show);
    if (url.startsWith("/ajax/statuses/longtext")) return respond(longText || { ok: 1, data: {} });
    if (url.startsWith("/ajax/statuses/buildComments")) {
      const requestedMax = new URLSearchParams(url.split("?")[1]).get("max_id");
      // 第 0 页不带游标；第 i 页由前一页的 max_id 游标唤起
      const pageIndex = requestedMax
        ? pages.findIndex((page, index) => index > 0 && String(pages[index - 1].max_id) === requestedMax)
        : 0;
      return respond(pageIndex >= 0 ? (pages[pageIndex] || { ok: 1, total_number: 25, max_id: 0, data: [] }) : { ok: 1, total_number: 25, max_id: 0, data: [] });
    }
    return { ok: false, status: 404, json: async () => ({ ok: 0 }) };
  };

  const runtimeMessages = [];
  let messageListener = null;
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) { messageListener = listener; }
      },
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        return { ok: true };
      }
    },
    storage: { local: { set: async () => {} } }
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => "data:image/jpeg;base64,frame"
  };
  const document = {
    createElement: (tag) => (tag === "canvas" ? canvas : {}),
    querySelectorAll: () => []
  };

  const context = {
    chrome,
    fetch: fetchImpl,
    document,
    crypto: { randomUUID: () => "weibo-page-session" },
    location: { href: `${POST_URL}?sudaref=example`, pathname: `/1257000310/${POST_ID}` },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    fetchRequests: requests,
    runtimeMessages
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "capture-common.js"), "utf8") + "\n" +
    fs.readFileSync(path.join(__dirname, "..", "weibo-content-script.js"), "utf8"),
    context,
    { filename: "weibo-content-script.js" }
  );

  function send(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("capture response timed out")), 2000);
      const keepChannelOpen = messageListener(message, {}, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      assert.equal(keepChannelOpen, true);
    });
  }

  return { context, send, runtimeMessages, requests };
}

(async () => {
  // —— 基础采集：正文、互动数、图片、评论与楼中楼 ——
  {
    const { send, requests } = createEnvironment();
    const response = await send({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 50 } });
    assert.equal(response.ok, true);

    const payload = response.payload;
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.source.platform, "weibo");
    assert.equal(payload.source.noteId, POST_ID);
    assert.equal(payload.source.url, POST_URL);
    assert.equal(payload.note.title, null);
    assert.equal(payload.note.author, "百忍说");
    assert.equal(payload.note.authorProfileUrl, `https://weibo.com/u/${AUTHOR_ID}`);
    assert.equal(payload.note.content, "堂堂的京师大学堂，也要过紧日子了？");
    assert.equal(payload.note.type, "normal");
    assert.deepEqual(payload.note.hashtags, ["#京师大学堂"]);
    assert.equal(payload.note.publishedDisplay, "2026-09-12 10:24");
    assert.equal(payload.note.location, "山东");
    // 跨 realm 对象原型不同，交互数等嵌套结构逐字段断言
    assert.equal(payload.interactions.likes.raw, "139");
    assert.equal(payload.interactions.likes.value, 139);
    assert.equal(payload.interactions.reposts.raw, "37");
    assert.equal(payload.interactions.reposts.value, 37);
    assert.equal(payload.interactions.comments.raw, "25");
    assert.equal(payload.interactions.comments.value, 25);
    assert.equal(payload.interactions.collects.raw, null);
    assert.equal(payload.interactions.collects.value, null);
    assert.equal(payload.commentExport.extractedTopLevelCount, 3);
    assert.equal(payload.commentExport.stopReason, "page_exhausted");
    assert.equal(payload.commentExport.scope, "first_50_top_level_in_api_order");

    const firstComment = payload.commentExport.comments[0];
    assert.equal(firstComment.author, "用户6526487870");
    assert.equal(firstComment.content, "京师大学堂，是北京师范大学");
    assert.equal(firstComment.publishedDisplay, "09-12 11:57");
    assert.equal(firstComment.likes.raw, "5");
    assert.equal(firstComment.likes.value, 5);
    assert.equal(firstComment.displayedReplyCount, 3);
    assert.equal(firstComment.isAuthor, false);
    assert.equal(firstComment.visibleReplies.length, 1);
    assert.equal(firstComment.visibleReplies[0].author, "夜雨寄北----");
    assert.equal(firstComment.visibleReplies[0].parentCommentId, "5342293448196916");
    assert.equal(firstComment.visibleReplies[0].kind, "visible_reply");

    // 作者本人的评论由 payload 组装阶段按帖子作者 ID 回填 isAuthor
    assert.equal(payload.commentExport.comments[1].isAuthor, true);
    assert.equal(payload.commentExport.comments[2].author, "路人甲");

    assert.equal(payload.media.images.length, 1);
    assert.equal(payload.media.images[0].url, "https://wx3.sinaimg.cn/large/pic-1.jpg");
    assert.equal(payload.media.images[0].width, 1080);
    assert.equal(payload.media.video, null);
    assert.equal(payload.uncertainties, undefined);
    assert.ok(requests.some((url) => url.startsWith("/ajax/statuses/show?")));
  }

  // —— limit 截断 + 翻页游标 ——
  {
    const { send, requests } = createEnvironment();
    const response = await send({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 2 } });
    assert.equal(response.ok, true);
    assert.equal(response.payload.commentExport.extractedTopLevelCount, 2);
    assert.equal(response.payload.commentExport.stopReason, "limit_reached");
    const commentRequest = requests.find((url) => url.startsWith("/ajax/statuses/buildComments"));
    assert.match(commentRequest, /id=RhJDvgyf3/);
    assert.match(commentRequest, /is_mix=0/);
  }

  // —— 翻页去重：第二页重复的第一条不应重复计入 ——
  {
    const commentPages = [
      COMMENTS_PAGE_1,
      { ok: 1, total_number: 25, max_id: 0, data: [{ ...COMMENTS_PAGE_1.data[0] }] }
    ];
    const { send } = createEnvironment({ commentPages });
    const response = await send({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 50 } });
    assert.equal(response.payload.commentExport.extractedTopLevelCount, 2);
    assert.equal(response.payload.commentExport.stopReason, "page_exhausted");
  }

  // —— 长文：isLongText 时读取 longtext 接口替换截断正文 ——
  {
    const show = { ...SHOW_BASE, isLongText: true, text_raw: "这是截断的正文…" };
    const { send, requests } = createEnvironment({
      show,
      longText: { ok: 1, data: { longTextContent: LONG_TEXT_CONTENT } }
    });
    const response = await send({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 5 } });
    assert.equal(response.payload.note.content, LONG_TEXT_CONTENT);
    assert.ok(requests.some((url) => url.startsWith("/ajax/statuses/longtext?")));
  }

  // —— 长文读取失败时保留截断正文并记录 uncertainty ——
  {
    const show = { ...SHOW_BASE, isLongText: true, text_raw: "这是截断的正文…" };
    const { send } = createEnvironment({ show, longText: { ok: 0 } });
    const response = await send({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 5 } });
    assert.equal(response.payload.note.content, "这是截断的正文…");
    assert.ok(response.payload.uncertainties.some((item) => item.includes("长文")));
  }

  // —— 视频帖：无字幕，播放器截帧作为画面证据 ——
  {
    const show = {
      ...SHOW_BASE,
      pic_ids: [],
      pic_infos: {},
      page_info: { object_type: "video", media_info: { duration: 61.5 } }
    };
    const { context, send } = createEnvironment({ show });
    // 模拟详情页播放器中的 <video> 元素（1080x1920，当前播放到 3.4s）
    const fakeVideo = { readyState: 2, videoWidth: 1080, videoHeight: 1920, currentTime: 3.4 };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => "data:image/jpeg;base64,frame"
    };
    context.document.querySelectorAll = (selector) => (selector === "video" ? [fakeVideo] : []);
    context.document.createElement = (tag) => (tag === "canvas" ? canvas : {});

    const response = await send({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 5 } });
    assert.equal(response.payload.note.type, "video");
    assert.equal(response.payload.media.video.durationSec, 62);
    assert.equal(response.payload.media.video.transcript, null);
    assert.equal(response.payload.media.images.length, 1);
    assert.equal(response.payload.media.images[0].dataUrl, "data:image/jpeg;base64,frame");
    assert.equal(response.payload.media.images[0].source, "video_frame");
    // 长边压到 720：1080x1920 → 405x720
    assert.equal(response.payload.media.images[0].width, 405);
    assert.equal(response.payload.media.images[0].height, 720);
    assert.equal(response.payload.media.video.frameTimestamps[0], 3);
    assert.ok(response.payload.uncertainties.some((item) => item.includes("自动字幕")));
  }

  // —— 转发帖：原微博文本并入正文，图片合并 ——
  {
    const show = {
      ...SHOW_BASE,
      pic_ids: [],
      pic_infos: {},
      text_raw: "转发理由",
      retweeted_status: {
        user: { id: 999, screen_name: "原博" },
        text_raw: "原始微博内容",
        isLongText: false,
        pic_ids: ["rt-pic"],
        pic_infos: { "rt-pic": { largest: { url: "https://wx1.sinaimg.cn/large/rt-pic.jpg", width: 800, height: 600 } } }
      }
    };
    const { send } = createEnvironment({ show });
    const response = await send({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 5 } });
    assert.equal(response.payload.note.content, "转发理由\n// @原博：原始微博内容");
    assert.equal(response.payload.media.images.length, 1);
    assert.equal(response.payload.media.images[0].url, "https://wx1.sinaimg.cn/large/rt-pic.jpg");
    assert.equal(response.payload.uncertainties, undefined);
  }

  // —— 提取并概括：payload 上送 + 图片识别并行准备 ——
  {
    const { send, runtimeMessages } = createEnvironment();
    const response = await send({
      type: "XHS_CAPTURE_AND_SUMMARIZE",
      options: { limit: 50 },
      payload: null,
      force: false
    });
    assert.equal(response.ok, true);
    const summarize = runtimeMessages.find((message) => message.type === "XHS_AI_SUMMARIZE_PAGE");
    assert.ok(summarize);
    assert.equal(summarize.payload.source.platform, "weibo");
    assert.equal(summarize.pageSessionId, "weibo-page-session");
    const vision = runtimeMessages.find((message) => message.type === "XHS_AI_PREPARE_VISION");
    assert.ok(vision);
    assert.equal(vision.payload.source.noteId, POST_ID);
    assert.equal(vision.payload.media.images[0].url, "https://wx3.sinaimg.cn/large/pic-1.jpg");
  }

  // —— 加入合并清单：只采集不概括，完成后通知后台 ——
  {
    const { send, runtimeMessages } = createEnvironment();
    const response = await send({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 50 } });
    assert.equal(response.ok, true);
    assert.equal(response.payload.source.noteId, POST_ID);
    const done = runtimeMessages.find((message) => message.type === "XHS_AI_MERGE_CAPTURE_DONE");
    assert.ok(done);
    assert.equal(done.noteId, POST_ID);
    assert.equal(runtimeMessages.some((message) => message.type === "XHS_AI_SUMMARIZE_PAGE"), false);
  }

  // —— 帖文不可访问：接口返回 ok:0 时给出可读错误 ——
  {
    const { send } = createEnvironment({ show: { ok: 0 } });
    const response = await send({ type: "XHS_CAPTURE_FOR_MERGE", options: { limit: 5 } });
    assert.equal(response.ok, false);
    assert.match(response.error, /微博博文接口/);
  }

  console.log("weibo-content-script tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// —— AI 管线的平台标识与来源后缀 ——
(async () => {
  const pipelineContext = { console };
  pipelineContext.globalThis = pipelineContext;
  vm.createContext(pipelineContext);
  for (const filename of ["prompts.js", "ai-pipeline.js"]) {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "..", filename), "utf8"),
      pipelineContext,
      { filename }
    );
  }
  const { XhsAi } = pipelineContext;

  assert.equal(XhsAi.platformLabel({ platform: "weibo" }), "微博");
  assert.equal(XhsAi.platformLabel({ platform: "xiaohongshu" }), "小红书");
  assert.equal(XhsAi.platformLabel({}), "小红书");

  const weiboPayload = {
    exportedAt: "2026-09-18T00:00:00.000Z",
    source: { platform: "weibo", url: "https://weibo.com/1257000310/RhJDvgyf3", noteId: POST_ID },
    note: { publishedDisplay: "2026-09-12 10:24" },
    interactions: { likes: { raw: "139", value: 139 }, comments: { raw: "25", value: 25 } },
    commentExport: { comments: [] },
    media: { images: [] }
  };
  const xhsPayload = {
    ...weiboPayload,
    source: {
      platform: "xiaohongshu",
      url: "https://www.xiaohongshu.com/explore/6a76029300000000250070c1",
      noteId: "6a76029300000000250070c1"
    }
  };

  const single = XhsAi.renderSummary(
    { headline: "标题", eventSummary: "事件经过", opinionPoints: [] },
    weiboPayload
  );
  assert.match(single, /（微博 https:\/\/weibo\.com\/1257000310\/RhJDvgyf3）/);
  assert.ok(!single.includes("小红书"));
  assert.match(single, /截至目前，该帖文获139次点赞、25条评论。/);

  const mixed = XhsAi.renderMergedSummary(
    { headline: "标题", eventSummary: "事件经过", opinionPoints: [] },
    [xhsPayload, weiboPayload]
  );
  assert.match(
    mixed,
    /（小红书 https:\/\/www\.xiaohongshu\.com\/explore\/6a76029300000000250070c1；微博 https:\/\/weibo\.com\/1257000310\/RhJDvgyf3）/
  );

  const weiboOnly = XhsAi.renderMergedSummary(
    { headline: "标题", eventSummary: "事件经过", opinionPoints: [] },
    [weiboPayload, { ...weiboPayload, source: { ...weiboPayload.source, url: "https://weibo.com/42/AbCdEfG" } }]
  );
  assert.match(weiboOnly, /（微博 https:\/\/weibo\.com\/1257000310\/RhJDvgyf3；https:\/\/weibo\.com\/42\/AbCdEfG）/);

  // buildEvidence 输出的 platform 供文字模型区分“小红书平台用户/微博平台用户”
  const evidence = XhsAi.buildEvidence(
    weiboPayload,
    [],
    XhsAi.normalizeConfig({})
  );
  assert.equal(evidence.source.platform, "微博");

  console.log("weibo ai-pipeline platform tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
