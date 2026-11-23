// ==UserScript==
// @name         NGA 实时阅读
// @namespace    https://vitocichen.github.io/NGA/
// @version      1.0.0
// @description  打开 https://bbs.nga.cn/nga_live 直接进入 NGA 实时阅读页（与 iPhone Scriptable 版相同）
// @match        https://bbs.nga.cn/nga_live*
// @run-at       document-start
// @grant        none
// @downloadURL  https://vitocichen.github.io/NGA/nga-live.user.js
// @updateURL    https://vitocichen.github.io/NGA/nga-live.user.js
// ==/UserScript==

(async () => {
  // 这个地址在 NGA 上是个很小的 404 页；等它解析完再整页换成实时版（解析中途 document.write 会插进原页面，window.stop 后又写不进去）
  const LIVE = "https://vitocichen.github.io/NGA/live.html";
  const parsed = new Promise((ok) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", ok, { once: true }) : ok()));
  try {
    const r = await fetch(`${LIVE}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    await parsed;
    document.open();
    document.write(html);
    document.close();
  } catch (e) {
    await parsed;
    document.open();
    document.write(`<p style="padding:20px;font-size:16px">实时版加载失败：${String(e.message || e)}，请检查网络后刷新。</p>`);
    document.close();
  }
})();
