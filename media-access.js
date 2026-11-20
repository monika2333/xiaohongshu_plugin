// 微博图床（*.sinaimg.cn）对带浏览器 UA 的请求做防盗链：没有 weibo.com 的 Referer 就返回 403。
// 扩展页面与 Service Worker 发出的请求不带 Referer，fetch 的 referrer 选项也会被浏览器丢掉，
// 所以用 declarativeNetRequest 给本扩展自己发起的 sinaimg 请求补上 Referer。
// 微博配图识别（ai-pipeline.js）与截图存档的配图下载（archive.js）在 fetch 前都先 await
// ensureWeiboMediaReferer()，确保规则已注册；规则只匹配本扩展发起的请求，不改动网页请求。
// 由 panel.html 与 service-worker.js 在各自主脚本之前加载。
(() => {
  if (globalThis.XhsMediaAccess) return;

  const RULE_ID = 7101;
  const WEIBO_IMAGE_REFERER = "https://weibo.com/";

  // 纯函数：规则内容固定，反复注册时先删再加（removeRuleIds + addRules 同一次调用）。
  // condition.initiatorDomains 用扩展 ID，把改动限定在本扩展自己发出的请求上；
  // 扩充到别的平台图片域名时改 requestDomains 即可。
  function weiboMediaRefererRule(extensionId) {
    return {
      id: RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: WEIBO_IMAGE_REFERER }
        ]
      },
      condition: {
        requestDomains: ["sinaimg.cn"],
        resourceTypes: ["xmlhttprequest"],
        initiatorDomains: [String(extensionId || "")]
      }
    };
  }

  // 每个上下文只注册一次；没有 declarativeNetRequest 权限或运行时（Node 测试）时安静返回 false，
  // 调用方照常发请求，行为与修复前一致。注册失败（可能是临时错误）不缓存结果，下次取图会重试。
  let ready = null;
  let warned = false;
  function registrationFailed() {
    ready = null;
    if (!warned) {
      warned = true;
      console.warn("微博配图补 Referer 的请求头规则注册失败，本次可能无法下载或识别微博配图。");
    }
    return false;
  }
  function ensureWeiboMediaReferer() {
    if (ready) return ready;
    const declarativeNetRequest = globalThis.chrome?.declarativeNetRequest;
    const extensionId = globalThis.chrome?.runtime?.id;
    if (!declarativeNetRequest?.updateDynamicRules || !extensionId) {
      ready = Promise.resolve(false);
      return ready;
    }
    try {
      ready = Promise.resolve(declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID],
        addRules: [weiboMediaRefererRule(extensionId)]
      })).then(() => true, registrationFailed);
    } catch {
      ready = null;
      if (!warned) {
        warned = true;
        console.warn("微博配图补 Referer 的请求头规则注册失败，本次可能无法下载或识别微博配图。");
      }
      return Promise.resolve(false);
    }
    return ready;
  }

  globalThis.XhsMediaAccess = Object.freeze({
    RULE_ID,
    WEIBO_IMAGE_REFERER,
    weiboMediaRefererRule,
    ensureWeiboMediaReferer
  });
})();
