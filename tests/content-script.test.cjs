const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const NOTE_ID = "6a82bd6000000000330309ec";

function textNode(text, extra = {}) {
  return { innerText: text, textContent: text, ...extra };
}

function createDetailRoot() {
  const nodes = new Map([
    ["#detail-title, #detail-desc, .comments-container", textNode("清华听涛园食堂异物")],
    ["#detail-title, .title", textNode("清华听涛园食堂异物")],
    [".author-wrapper .username", textNode("紫罗兰花铃")],
    [".author-wrapper a.name", { href: "https://www.xiaohongshu.com/user/profile/example" }],
    ["#detail-desc .note-text, #detail-desc, .desc .note-text", textNode("帖文正文")],
    [".bottom-container .date", textNode("08-17 北京")],
    [".interactions .like-wrapper .count", textNode("1.2万")],
    [".interactions .collect-wrapper .count", textNode("345")],
    [".interactions .chat-wrapper .count", textNode("67")],
    [".comments-container .total", textNode("共 67 条评论")]
  ]);

  return {
    querySelector(selector) {
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

async function captureFromPage(rootSelector) {
  const detailRoot = createDetailRoot();
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
    crypto: { randomUUID: () => "page-session" },
    document,
    Event,
    globalThis: null,
    location: {
      href: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
      pathname: `/explore/${NOTE_ID}`
    },
    URL
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "content-script.js"), "utf8"),
    context,
    { filename: "content-script.js" }
  );

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("capture response timed out")), 1000);
    const keepChannelOpen = messageListener(
      { type: "XHS_CAPTURE_START", options: { limit: 50 } },
      {},
      (response) => {
        clearTimeout(timeout);
        resolve(response);
      }
    );
    assert.equal(keepChannelOpen, true);
  });
}

(async () => {
  const directPage = await captureFromPage("#noteContainer");
  assert.equal(directPage.ok, true);
  assert.equal(directPage.payload.source.noteId, NOTE_ID);
  assert.equal(directPage.payload.note.title, "清华听涛园食堂异物");
  assert.equal(directPage.payload.interactions.likes.value, 12000);
  assert.equal(directPage.payload.interactions.collects.value, 345);
  assert.equal(directPage.payload.interactions.comments.value, 67);

  const modalPage = await captureFromPage(".note-detail-mask");
  assert.equal(modalPage.ok, true);
  assert.equal(modalPage.payload.note.content, "帖文正文");

  console.log("content-script tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
