(() => {
  if (globalThis.__XHS_AI_STATE_BRIDGE__) return;
  globalThis.__XHS_AI_STATE_BRIDGE__ = true;

  // 小红书把帖文完整数据挂在 window.__INITIAL_STATE__ 上，内容脚本的隔离世界读不到。
  // 本脚本以 world: "MAIN" 注入页面主世界，收到隔离世界的请求后读取状态并回传。
  // 只回传 JSON 可序列化的纯数据，页面脚本无法借此触达扩展 API。
  window.addEventListener("XHS_AI_STATE_REQUEST", (event) => {
    const detail = event.detail || {};
    let note = null;
    try {
      const map = window.__INITIAL_STATE__?.note?.noteDetailMap || {};
      const entries = Object.values(map);
      const entry = (detail.noteId && map[detail.noteId]) ||
        entries.find((item) => item?.note?.noteId === detail.noteId) ||
        entries.find((item) => item?.note) ||
        null;
      note = entry?.note ? JSON.parse(JSON.stringify(entry.note)) : null;
    } catch {
      note = null;
    }
    window.dispatchEvent(new CustomEvent("XHS_AI_STATE_RESPONSE", {
      detail: { requestId: detail.requestId, note }
    }));
  });
})();
