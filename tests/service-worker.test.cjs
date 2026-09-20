const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const storageState = { local: {}, session: {} };
const accessLevels = [];
const runtimeMessages = [];
const panelBehaviors = [];

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
    sidePanel: {
      setPanelBehavior: async (behavior) => {
        panelBehaviors.push(behavior);
        return undefined;
      }
    },
    runtime: {
      onMessage: { addListener: () => {} },
      getURL: (value = "") => `chrome-extension://test/${value}`,
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        return { ok: true };
      }
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
  TextEncoder,
  crypto: webcrypto,
  setTimeout,
  clearTimeout,
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  importScripts: (...filenames) => {
    for (const filename of filenames) {
      const imported = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
      vm.runInContext(imported, context, { filename });
    }
  }
};

vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
vm.runInContext(source, context, { filename: "service-worker.js" });

// —— 侧边栏形态：图标点击开/关面板，不再使用弹出气泡 ——
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
assert.ok(manifest.permissions.includes("sidePanel"), "manifest 缺少 sidePanel 权限");
assert.equal(manifest.side_panel?.default_path, "panel.html");
assert.ok(!("default_popup" in manifest.action), "action 不应再定义 default_popup");
// 面板行为对象产生自 vm realm，跨 realm 比较原型会失败，逐字段断言
assert.equal(panelBehaviors.length, 1);
assert.equal(panelBehaviors[0].openPanelOnActionClick, true);

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
  assert.equal(context.XhsPrompts.version, "2026-09-18-v5");
  assert.match(context.XhsPrompts.visionSystem, /summary_value/);
  assert.match(context.XhsPrompts.textSystem, /event_summary/);
  assert.match(context.XhsPrompts.textSystem, /中央民族大学新老校区搬迁工作/);
  assert.match(context.XhsPrompts.textSystem, /video\.transcript/);
  assert.equal(context.XhsAi.DEFAULT_CONFIG.promptVersion, context.XhsPrompts.version);

  const structured = {
    headline: "高校教师称被移出工作群",
    eventSummary: "8月17日，小红书用户发帖反映其被移出学院工作群",
    opinionPoints: ["部分网民质疑相关管理方式", "部分网民猜测事件与职称评定有关"]
  };
  const rendered = context.XhsAi.renderSummary(structured, payload);
  assert.match(rendered, /^★ 高校教师称被移出工作群\n/);
  assert.match(rendered, /\n8月8日，小红书用户发帖反映其被移出学院工作群。/);
  assert.match(rendered, /12次点赞、100条评论/);
  assert.match(rendered, /部分网民质疑相关管理方式；部分网民猜测事件与职称评定有关。/);
  assert.match(rendered, /（小红书 https:\/\/www\.xiaohongshu\.com\/explore\/6a76029300000000250070c1\?xsec_token=test-token&xsec_source=pc_feed）$/);

  const relativePayload = {
    ...payload,
    exportedAt: "2026-08-19T04:00:00.000Z",
    note: { ...payload.note, publishedDisplay: "一天前", location: "北京" }
  };
  const relativeDate = context.XhsAi.resolvePublishedDate(relativePayload);
  assert.equal(relativeDate.iso, "2026-08-18");
  assert.equal(relativeDate.display, "8月18日");
  const relativeRendered = context.XhsAi.renderSummary({
    ...structured,
    eventSummary: "一天前，小红书用户发帖反映测试事件"
  }, relativePayload);
  assert.match(relativeRendered, /\n8月18日，小红书用户发帖反映测试事件。/);
  assert.doesNotMatch(relativeRendered, /一天前/);

  const ignoredImage = context.XhsAi.normalizeVisionItem({
    image_index: 1,
    has_text: false,
    factual_description: "一张普通人物自拍",
    summary_value: "none"
  }, 1);
  const usefulImage = context.XhsAi.normalizeVisionItem({
    image_index: 2,
    has_text: true,
    visible_text: "工作群通知",
    factual_description: "聊天记录截图",
    summary_value: "essential"
  }, 2);
  assert.equal(ignoredImage.factual_description, "");
  assert.equal(
    context.XhsAi.selectVisionEvidence([ignoredImage, usefulImage]).map((item) => item.image_index).join(","),
    "2"
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
  assert.equal("enabled" in customConfig.feishu, false);
  assert.equal(customConfig.feishu.mode, "webhook");

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

  const webhookConfig = context.XhsAi.normalizeConfig({
    ...customConfig,
    feishu: { enabled: false, mode: "webhook" }
  });
  assert.equal("enabled" in webhookConfig.feishu, false);
  assert.equal(context.hasFeishuSettings(webhookConfig, {}), false);
  assert.equal(await context.pushFeishuNotification("测试概括", webhookConfig, {}), null);
  let webhookRequest = null;
  context.fetch = async (url, options) => {
    webhookRequest = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, msg: "success" })
    };
  };
  const webhookTest = await context.testFeishuSettings(webhookConfig, {
    feishuWebhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-hook",
    feishuWebhookSecret: "test-signing-secret"
  });
  assert.equal(webhookTest.ok, true);
  assert.equal(webhookRequest.url, "https://open.feishu.cn/open-apis/bot/v2/hook/test-hook");
  assert.equal(webhookRequest.body.msg_type, "text");
  assert.match(webhookRequest.body.content.text, /飞书推送测试成功/);
  assert.match(webhookRequest.body.timestamp, /^\d+$/);
  assert.ok(webhookRequest.body.sign);

  const appConfig = context.XhsAi.normalizeConfig({
    ...customConfig,
    feishu: {
      mode: "app",
      appId: "cli_test",
      recipientId: "user@example.com"
    }
  });
  const appRequests = [];
  context.fetch = async (url, options) => {
    appRequests.push({ url, options, body: JSON.parse(options.body) });
    const data = url.includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "tenant-token" }
      : { code: 0, data: { message_id: "om_test" } };
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  const appTest = await context.testFeishuSettings(appConfig, { feishuAppSecret: "app-secret" });
  assert.equal(appTest.ok, true);
  assert.equal(appRequests.length, 2);
  assert.equal(appRequests[0].body.app_id, "cli_test");
  assert.match(appRequests[1].url, /receive_id_type=email/);
  assert.equal(appRequests[1].options.headers.Authorization, "Bearer tenant-token");
  assert.equal(appRequests[1].body.receive_id, "user@example.com");
  assert.equal(context.feishuRecipientType("ou_test"), "open_id");
  assert.throws(() => context.feishuRecipientType("not-an-id"), /企业邮箱|Open ID/);

  context.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 19001, msg: "invalid webhook" })
  });
  const failedNotification = await context.pushFeishuNotification("测试概括", webhookConfig, {
    feishuWebhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-hook"
  });
  assert.equal(failedNotification.status, "failed");
  assert.match(failedNotification.error, /invalid webhook/);

  let visionModelCalls = 0;
  context.fetch = async (url, options) => {
    if (url.includes("xhscdn.com")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "image/webp" },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer
      };
    }
    visionModelCalls += 1;
    assert.equal(url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-vision-key");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify([{
              image_index: 1,
              has_text: true,
              visible_text: "图片关键信息",
              factual_description: "图片补充了关键事实",
              summary_value: "essential"
            }])
          }
        }]
      })
    };
  };
  storageState.local.xhsAiConfig = context.XhsAi.DEFAULT_CONFIG;
  storageState.local.xhsAiPersistentSecrets = {
    textApiKey: "test-deepseek-key",
    visionApiKey: "test-vision-key"
  };
  const visionSender = { tab: { id: 42 }, url: payload.source.url };
  const visionPreparation = await context.prepareVisionPayload({
    payload: {
      source: { ...payload.source, pageSessionId: "page-session-1" },
      media: payload.media
    },
    pageSessionId: "page-session-1"
  }, visionSender);
  assert.equal(visionPreparation.ok, true);
  assert.equal(visionPreparation.preparedVision.status, "analyzed");
  assert.equal(visionPreparation.preparedVision.items.length, 1);
  assert.equal(visionModelCalls, 1);

  let textCalls = 0;
  let lastTextRequest = null;
  context.fetch = async (url, options) => {
    textCalls += 1;
    lastTextRequest = JSON.parse(options.body);
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
              event_summary: "小红书用户发帖反映测试事件",
              opinion_points: ["部分网民关注事件进展"]
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
  const textEvidence = lastTextRequest.messages[1].content;
  assert.match(textEvidence, /"publishedDate":"8月8日"/);
  assert.doesNotMatch(textEvidence, /"location"|浙江/);
  const cachedSummary = await context.XhsAi.summarize(
    textOnlyPayload,
    context.XhsAi.DEFAULT_CONFIG,
    { textApiKey: "test-deepseek-key", visionApiKey: "" },
    cache
  );
  assert.equal(cachedSummary.text, firstSummary.text);
  assert.equal(textCalls, 1);

  const imageSummary = await context.XhsAi.summarize(
    payload,
    context.XhsAi.DEFAULT_CONFIG,
    { textApiKey: "test-deepseek-key", visionApiKey: "test-vision-key" },
    {},
    () => {},
    false,
    visionPreparation.preparedVision
  );
  assert.equal(imageSummary.evidence.imagesAnalyzed, 1);
  assert.equal(textCalls, 2);
  assert.equal(visionModelCalls, 1);

  const pageSender = {
    tab: { id: 42 },
    url: textOnlyPayload.source.url
  };
  await context.recordCaptureProgress({
    pageSessionId: "page-session-1",
    pageUrl: textOnlyPayload.source.url,
    noteId: textOnlyPayload.source.noteId,
    title: "正在读取评论",
    detail: "已加载 20 条一级评论",
    count: 20
  }, pageSender);
  const runningWorkflow = await context.getWorkflowState(42, "page-session-1", textOnlyPayload.source.url);
  assert.equal(runningWorkflow.status, "working");
  assert.equal(runningWorkflow.progress.percent, 12);
  assert.equal(runningWorkflow.progress.count, 20);
  assert.equal(
    await context.getWorkflowState(42, "page-session-after-refresh", textOnlyPayload.source.url),
    null
  );

  storageState.local.xhsAiConfig = context.XhsAi.DEFAULT_CONFIG;
  storageState.local.xhsAiPersistentSecrets = { textApiKey: "test-deepseek-key", visionApiKey: "" };
  const pageSummary = await context.summarizePagePayload({
    payload: {
      ...textOnlyPayload,
      source: { ...textOnlyPayload.source, pageSessionId: "page-session-1" }
    },
    force: false,
    pageSessionId: "page-session-1"
  }, pageSender);
  assert.equal(pageSummary.ok, true);
  const completedWorkflow = await context.getWorkflowState(42, "page-session-1", textOnlyPayload.source.url);
  assert.equal(completedWorkflow.status, "done");
  assert.equal(completedWorkflow.result.text, pageSummary.result.text);
  assert.equal(completedWorkflow.capture.source.pageSessionId, "page-session-1");
  assert.ok(runtimeMessages.some((message) => message.type === "XHS_AI_WORKFLOW_STATE"));

  // —— 截图识别与多帖合并 ——
  assert.match(context.XhsPrompts.screenshotSystem, /visible_comments/);
  assert.match(context.XhsPrompts.mergeSystem, /posts 数组/);
  assert.equal(context.XhsAi.parseEngagementCount("1,255"), 1255);
  assert.equal(context.XhsAi.parseEngagementCount("1.2万"), 12000);
  assert.equal(context.XhsAi.parseEngagementCount("赞"), null);

  const screenshotPayload = context.XhsAi.buildScreenshotPayload({
    author: "难道你就一点猪也没有嘛",
    publishedDisplay: "3天前",
    title: "关于校园墙的一些看法",
    contentText: "针对校园墙上部分言论发表个人意见。",
    hashtags: ["校园墙"],
    likesRaw: "55",
    collectsRaw: "",
    commentsRaw: "998",
    visibleComments: [
      { author: "乙", content: "围观", likesRaw: "2", isAuthor: false },
      { author: "", content: "", likesRaw: "", isAuthor: false }
    ],
    uncertainties: [],
    imageCount: 2
  }, { sourceUrl: "", screenshotId: "shot-test-1" });
  assert.equal(screenshotPayload.source.origin, "user_screenshot");
  assert.equal(screenshotPayload.source.url, null);
  assert.equal(screenshotPayload.note.publishedDisplay, null);
  assert.ok(screenshotPayload.uncertainties.some((item) => /3天前/.test(item)));
  assert.equal(screenshotPayload.interactions.likes.value, 55);
  assert.equal(screenshotPayload.interactions.comments.value, 998);
  assert.equal(screenshotPayload.commentExport.extractedTopLevelCount, 1);
  assert.equal(screenshotPayload.commentExport.comments[0].likes.value, 2);

  const mergedRender = context.XhsAi.renderMergedSummary({
    headline: "网传某校学生发表不当言论引争议",
    eventSummary: "账号“@溜溜球”发帖询问某校“闪婚姐”是怎么回事；当日另一账号也就该话题发表意见。",
    opinionPoints: ["部分网民好奇事件全貌", "部分网民分享校园墙截图"]
  }, [textOnlyPayload, screenshotPayload]);
  assert.match(mergedRender, /^★ 网传某校学生发表不当言论引争议\n8月8日，/);
  assert.match(mergedRender, /上述帖文共获67次点赞、1098条评论。/);
  assert.match(mergedRender, /部分网民好奇事件全貌；部分网民分享校园墙截图。（小红书/);
  assert.match(mergedRender, /（小红书 https:\/\/www\.xiaohongshu\.com\/explore\/6a76029300000000250070c1\?xsec_token=test-token&xsec_source=pc_feed；另1条原帖已删除）$/);

  const shotOnlyRender = context.XhsAi.renderMergedSummary({
    headline: "据截图反映某事件",
    eventSummary: "截图显示有账号发帖反映某事件。",
    opinionPoints: []
  }, [screenshotPayload]);
  assert.match(shotOnlyRender, /截至目前，该帖文获55次点赞、998条评论。/);
  assert.match(shotOnlyRender, /（原帖已删除，内容据用户上传截图整理）$/);

  storageState.local.xhsAiConfig = context.XhsAi.DEFAULT_CONFIG;
  storageState.local.xhsAiPersistentSecrets = {
    textApiKey: "test-deepseek-key",
    visionApiKey: "test-vision-key"
  };
  let mergeTextCalls = 0;
  let lastMergeRequest = null;
  context.fetch = async (url, options) => {
    if (url.includes("dashscope.aliyuncs.com")) {
      const body = JSON.parse(options.body);
      assert.equal(options.headers.Authorization, "Bearer test-vision-key");
      assert.match(body.messages[0].content, /帖文截图识别助手/);
      assert.equal(body.messages[1].content[body.messages[1].content.length - 1].text, "以上共 1 张截图，来自同一条帖文。请综合全部截图返回一个 JSON 对象，不要输出 Markdown。");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                author: "溜溜球",
                published_display: "2026-09-16",
                title: "闪婚姐是怎么回事",
                content_text: "询问某校闪婚姐事件。",
                hashtags: [],
                likes_raw: "1200",
                collects_raw: "10",
                comments_raw: "233",
                visible_comments: [{ author: "丙", content: "求科普", likes_raw: "3", is_author: false }],
                uncertainties: ["右上角互动数字被遮挡"]
              })
            }
          }]
        })
      };
    }
    mergeTextCalls += 1;
    lastMergeRequest = JSON.parse(options.body);
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              headline: "网传某校学生婚姻选择言论引争议",
              event_summary: "小红书平台账号“@溜溜球”发布帖文询问某校“闪婚姐”是怎么回事；当日账号“@难道你就一点猪也没有嘛”也就该话题发表帖文，发表个人意见。",
              opinion_points: ["部分网民好奇事件全貌", "部分网民分享校园墙相关截图"]
            })
          }
        }]
      })
    };
  };

  await context.clearMergeBasket();
  const liveAdded = await context.addToMergeBasket(textOnlyPayload);
  assert.equal(liveAdded.ok, true);
  assert.equal(liveAdded.basket.length, 1);
  assert.equal(liveAdded.basket[0].kind, "live_page");
  const replacedAdd = await context.addToMergeBasket(textOnlyPayload);
  assert.equal(replacedAdd.replaced, true);
  assert.equal(replacedAdd.basket.length, 1);

  const invalidLink = await context.addScreenshotToBasket({
    images: ["data:image/png;base64,QUJD"],
    sourceUrl: "https://example.com/not-xhs"
  }).catch((error) => error);
  assert.match(invalidLink.message, /小红书帖文地址/);

  const shotAdded = await context.addScreenshotToBasket({
    images: ["data:image/png;base64,QUJD"],
    sourceUrl: " https://xhslink.cn/o/2CIVt7d2Y6p "
  });
  assert.equal(shotAdded.ok, true);
  assert.equal(shotAdded.basket.length, 2);
  assert.equal(shotAdded.basket[1].kind, "user_screenshot");
  assert.equal(shotAdded.basket[1].hasUrl, true);
  assert.equal(shotAdded.warnings.length, 1);
  assert.equal(shotAdded.warnings[0], "右上角互动数字被遮挡");

  const listed = await context.listMergeBasket();
  assert.equal(listed.basket.length, 2);
  assert.equal(listed.basket[0].id, `note:${textOnlyPayload.source.noteId}`);
  assert.match(listed.basket[1].id, /^shot:/);

  const mergedResponse = await context.summarizeMergeBasket({ force: true });
  assert.equal(mergedResponse.ok, true);
  assert.equal(mergedResponse.result.postCount, 2);
  assert.equal(mergeTextCalls, 1);
  assert.equal(lastMergeRequest.messages[0].content, context.XhsPrompts.mergeSystem);
  const mergedEvidence = lastMergeRequest.messages[1].content;
  assert.match(mergedEvidence, /"task":"merge_multiple_notes"/);
  assert.match(mergedEvidence, /"postCount":2/);
  assert.match(mergedEvidence, /"origin":"live_page"/);
  assert.match(mergedEvidence, /"origin":"user_screenshot"/);
  assert.match(mergedResponse.result.text, /^★ 网传某校学生婚姻选择言论引争议\n8月8日，/);
  assert.match(mergedResponse.result.text, /上述帖文共获1212次点赞、333条评论。/);
  assert.match(
    mergedResponse.result.text,
    /（小红书 https:\/\/www\.xiaohongshu\.com\/explore\/6a76029300000000250070c1\?xsec_token=test-token&xsec_source=pc_feed；https:\/\/xhslink\.cn\/o\/2CIVt7d2Y6p）$/
  );
  assert.equal(mergedResponse.result.evidence.postCount, 2);
  assert.equal(mergedResponse.result.evidence.topLevelComments, 2);
  assert.ok(runtimeMessages.some((message) => message.type === "XHS_AI_MERGE_PROGRESS"));

  const cachedMerge = await context.summarizeMergeBasket({ force: false });
  assert.equal(cachedMerge.ok, true);
  assert.equal(mergeTextCalls, 1);

  for (let index = 0; index < 3; index += 1) {
    await context.addToMergeBasket({
      ...textOnlyPayload,
      source: { ...textOnlyPayload.source, noteId: `6a7602930000000025007${String(index).padStart(2, "0")}` }
    });
  }
  const overflow = await context.addToMergeBasket({
    ...textOnlyPayload,
    source: { ...textOnlyPayload.source, noteId: "6a7602930000000025007ff" }
  }).catch((error) => error);
  assert.match(overflow.message, /最多保留 5 条/);
  for (let index = 0; index < 3; index += 1) {
    await context.removeFromMergeBasket({ id: `note:6a7602930000000025007${String(index).padStart(2, "0")}` });
  }
  assert.equal((await context.listMergeBasket()).basket.length, 2);

  const mergeDoneSender = { tab: { id: 43 }, url: textOnlyPayload.source.url };
  await context.recordMergeCaptureDone({
    pageSessionId: "page-session-merge",
    pageUrl: textOnlyPayload.source.url,
    noteId: textOnlyPayload.source.noteId,
    detail: "已采集 3 条一级评论和 0 张图片。"
  }, mergeDoneSender);
  const mergeDoneWorkflow = await context.getWorkflowState(43, "page-session-merge", textOnlyPayload.source.url);
  assert.equal(mergeDoneWorkflow.status, "done");
  assert.equal(mergeDoneWorkflow.result, null);
  assert.match(mergeDoneWorkflow.progress.detail, /3 条一级评论/);

  // —— 单条视图：截图识别后直接概括 ——
  await context.clearMergeBasket();
  const recognized = await context.recognizeScreenshots({
    images: ["data:image/png;base64,QUJD"],
    sourceUrl: "https://xhslink.cn/o/recognize-test"
  });
  assert.equal(recognized.ok, true);
  assert.equal(recognized.payload.source.origin, "user_screenshot");
  assert.ok(String(recognized.payload.source.screenshotId).length > 0);
  assert.equal((await context.listMergeBasket()).basket.length, 0);

  const shotSingle = await context.summarizePayload(recognized.payload, false);
  assert.equal(shotSingle.ok, true);
  assert.match(shotSingle.result.text, /截至目前，该帖文获1200次点赞、233条评论。/);
  assert.match(shotSingle.result.text, /（小红书 https:\/\/xhslink\.cn\/o\/recognize-test）$/);

  const renderedShotSingle = context.XhsAi.renderSummary({
    headline: "据截图反映某事件",
    eventSummary: "截图显示有账号发帖反映某事件。",
    opinionPoints: []
  }, screenshotPayload);
  assert.match(renderedShotSingle, /截至目前，该帖文获55次点赞、998条评论。/);
  assert.match(renderedShotSingle, /（原帖已删除，内容据用户上传截图整理）$/);

  // —— 概括历史：成功即追加，失败/关闭开关不记录 ——
  const historyEntries = storageState.local.xhsAiHistoryV1;
  assert.equal(historyEntries.length, 4);
  assert.equal(historyEntries[0].kind, "single");
  assert.equal(historyEntries[0].platform, "xiaohongshu");
  assert.equal(historyEntries[0].title, "测试/帖文");
  assert.equal(historyEntries[0].author, "测试用户");
  assert.match(historyEntries[0].url, /xiaohongshu\.com\/explore/);
  assert.match(historyEntries[0].result.text, /用户反映测试事件/);
  assert.equal(historyEntries[1].kind, "merge");
  assert.equal(historyEntries[1].title, "合并 2 条帖文");
  assert.equal(historyEntries[1].url, null);
  assert.equal(historyEntries[2].kind, "merge");
  assert.equal(historyEntries[3].kind, "screenshot");
  assert.equal(historyEntries[3].url, "https://xhslink.cn/o/recognize-test");

  const historyListed = await context.listHistory();
  assert.equal(historyListed.ok, true);
  assert.equal(historyListed.items.length, 4);
  assert.equal(historyListed.items[0].kind, "screenshot");

  await context.removeHistoryEntry({ id: historyEntries[3].id });
  assert.equal((await context.listHistory()).items.length, 3);

  // 固定条数上限：超出后淘汰最旧
  for (let index = 0; index < 105; index += 1) {
    await context.appendHistoryEntry({ id: `hist-fill-${index}`, createdAt: index });
  }
  const filled = storageState.local.xhsAiHistoryV1;
  assert.equal(filled.length, 100);
  assert.equal(filled[0].id, "hist-fill-5");
  assert.equal(filled[99].id, "hist-fill-104");

  storageState.local.xhsAiConfig = { ...context.XhsAi.DEFAULT_CONFIG, saveHistory: false };
  const noHistorySummary = await context.summarizePayload(textOnlyPayload, false);
  assert.equal(noHistorySummary.ok, true);
  assert.equal((await context.listHistory()).items.length, 100);

  await context.clearHistory();
  assert.equal(storageState.local.xhsAiHistoryV1.length, 0);

  process.stdout.write("service-worker and AI pipeline smoke tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
