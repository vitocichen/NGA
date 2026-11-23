// 安卓等没有 Scriptable 的手机用：在 bbs.nga.cn 的页面里运行，把实时版页面换进来。
// 页面仍属于 bbs.nga.cn，请求 NGA 是同源的，和 Scriptable 版一样实时。
(async () => {
  const LIVE = "https://vitocichen.github.io/NGA/live.html";
  if (location.hostname !== "bbs.nga.cn") {
    location.href = "https://bbs.nga.cn/nga_live";
    return;
  }
  try {
    const r = await fetch(`${LIVE}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    document.open();
    document.write(html);
    document.close();
  } catch (e) {
    document.body.innerHTML = `<p style="padding:20px;font-size:16px">实时版加载失败：${String(e.message || e)}，请检查网络后重试。</p>`;
  }
})();
