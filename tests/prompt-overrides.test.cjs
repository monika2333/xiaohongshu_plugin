const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = {};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "prompts.js"), "utf8"),
  context,
  { filename: "prompts.js" }
);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "ai-pipeline.js"), "utf8"),
  context,
  { filename: "ai-pipeline.js" }
);

const { XhsAi, XhsPrompts } = context;

// —— normalizePromptOverrides：只保留四个合法键的非空字符串并截断 ——
// vm realm 与宿主 realm 原型不同，deepEqual 会误报，统一用 JSON 比较
const cleaned = XhsAi.normalizePromptOverrides({
  textSystem: "  自定义单帖提示词  ",
  mergeSystem: "   ",
  visionSystem: 123,
  screenshotSystem: null,
  bogusKey: "应被丢弃"
});
assert.equal(JSON.stringify(cleaned), JSON.stringify({ textSystem: "自定义单帖提示词" }));
assert.equal(JSON.stringify(XhsAi.normalizePromptOverrides(null)), "{}");
assert.equal(JSON.stringify(XhsAi.normalizePromptOverrides("not-an-object")), "{}");
assert.equal(JSON.stringify(XhsAi.normalizePromptOverrides(["textSystem"])), "{}");
assert.equal(
  XhsAi.normalizePromptOverrides({ textSystem: "a".repeat(9000) }).textSystem.length,
  8000,
  "超长覆盖文本应被截断"
);

// —— normalizeConfig：promptOverrides 缺省为空对象并参与落库 ——
const config = XhsAi.normalizeConfig({});
assert.equal(JSON.stringify(config.promptOverrides), "{}");
const roundTrip = XhsAi.normalizeConfig({ promptOverrides: { textSystem: "自定义", bogusKey: "x" } });
assert.equal(JSON.stringify(roundTrip.promptOverrides), JSON.stringify({ textSystem: "自定义" }));

// —— resolvePrompts：留空回落默认，覆盖生效 ——
const defaults = XhsAi.resolvePrompts({});
assert.equal(defaults.textSystem, XhsPrompts.textSystem);
assert.equal(defaults.mergeSystem, XhsPrompts.mergeSystem);
assert.equal(defaults.visionSystem, XhsPrompts.visionSystem);
assert.equal(defaults.screenshotSystem, XhsPrompts.screenshotSystem);
const overridden = XhsAi.resolvePrompts({ promptOverrides: { textSystem: "我的提示词" } });
assert.equal(overridden.textSystem, "我的提示词");
assert.equal(overridden.mergeSystem, XhsPrompts.mergeSystem);

// —— 缓存标签：覆盖即变、恢复默认即还原、其他场景不受牵连 ——
const defaultTag = XhsAi.promptCacheTag(config, "textSystem");
const customConfig = XhsAi.normalizeConfig({ promptOverrides: { textSystem: "自定义提示词" } });
assert.notEqual(XhsAi.promptCacheTag(customConfig, "textSystem"), defaultTag);
assert.equal(
  XhsAi.promptCacheTag(customConfig, "mergeSystem"),
  XhsAi.promptCacheTag(config, "mergeSystem"),
  "只改单帖提示词不应影响合并概括缓存"
);
const clearedConfig = XhsAi.normalizeConfig({ promptOverrides: { textSystem: "  " } });
assert.equal(XhsAi.promptCacheTag(clearedConfig, "textSystem"), defaultTag, "清空覆盖应回到默认标签");

// 模拟插件升级内置默认提示词：未自定义用户的缓存同样失效
const originalPrompts = context.XhsPrompts;
context.XhsPrompts = { ...originalPrompts, textSystem: `${originalPrompts.textSystem}\n新版本指令` };
assert.notEqual(XhsAi.promptCacheTag(config, "textSystem"), defaultTag, "内置默认升级应使旧缓存失效");
context.XhsPrompts = originalPrompts;
assert.equal(XhsAi.promptCacheTag(config, "textSystem"), defaultTag);

// —— 三类缓存键端到端：覆盖只作用于对应场景 ——
const payload = {
  source: { platform: "xiaohongshu", noteId: "note-1" },
  note: { title: "标题", content: "正文" },
  media: { images: [] }
};
assert.equal(
  XhsAi.visionCacheKey(payload, config),
  XhsAi.visionCacheKey(payload, customConfig),
  "文字提示词覆盖不应使图片识别缓存失效"
);
assert.notEqual(XhsAi.textCacheKey(payload, config, []), XhsAi.textCacheKey(payload, customConfig, []));
const mergeCustomConfig = XhsAi.normalizeConfig({ promptOverrides: { mergeSystem: "自定义合并提示词" } });
assert.notEqual(
  XhsAi.mergedTextCacheKey([payload], config, [[]]),
  XhsAi.mergedTextCacheKey([payload], mergeCustomConfig, [[]])
);

// —— 涉事主体推断：单帖与合并提示词都要求从评论区线索查明全称 ——
for (const key of ["textSystem", "mergeSystem"]) {
  const prompt = XhsPrompts[key];
  assert.match(prompt, /要尽量查明具体名称/, `${key} 应要求查明涉事主体`);
  assert.match(prompt, /结合它所回复的那条评论理解/, `${key} 应要求结合上下文理解发帖人的简短回复`);
  assert.match(prompt, /回复数字表示选中对应序号的选项/, `${key} 应说明发帖人回复数字的含义`);
  assert.match(prompt, /发帖人在评论区确认/, `${key} 应要求简要交代确认依据`);
  assert.match(prompt, /具体名称的全称/, `${key} 应要求简称换成全称`);
  assert.match(prompt, /在 opinion_points 中写明网民猜测的具体名称/, `${key} 应保留未确认猜测的写法`);
}

// —— 推断所需证据：发帖人的简短回复挂在被回复的评论下，并带作者标识 ——
const threadEvidence = XhsAi.buildEvidence({
  source: { platform: "xiaohongshu", noteId: "note-thread" },
  note: { title: "某高校洗澡水发黄", content: "已经一个星期了" },
  media: { images: [] },
  commentExport: {
    comments: [{
      content: "航天桥你是北工商还是首师的",
      likes: { value: 2 },
      visibleReplies: [{ content: "1", likes: { value: 0 }, isAuthor: true }]
    }]
  }
}, [], null);
const thread = JSON.parse(JSON.stringify(threadEvidence.comments[0]));
assert.equal(thread.content, "航天桥你是北工商还是首师的");
assert.equal(JSON.stringify(thread.visibleReplies), JSON.stringify([{ content: "1", likes: 0, isAuthor: true }]));

process.stdout.write("prompt overrides tests passed\n");
