const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const downloads = [];
const context = {
  chrome: {
    downloads: {
      download: async (options) => {
        downloads.push(options);
        return downloads.length;
      }
    },
    runtime: {
      onMessage: { addListener: () => {} }
    }
  },
  console,
  encodeURIComponent,
  Promise
};

vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
vm.runInContext(source, context, { filename: "service-worker.js" });

const payload = {
  exportedAt: "2026-08-16T00:00:00.000Z",
  source: {
    platform: "xiaohongshu",
    noteId: "6a76029300000000250070c1",
    url: "https://www.xiaohongshu.com/explore/6a76029300000000250070c1"
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

  process.stdout.write("service-worker smoke test passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
