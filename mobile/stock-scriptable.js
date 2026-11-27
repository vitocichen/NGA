// A股行情（手机版）。用法：Scriptable 里新建脚本 → 粘贴全部内容 → 点 ▶ 运行。
// SEED 是电脑上导出的自选（电脑版 A股行情 → 我的自选 → 「📱 导出到手机」会生成带自选的版本）。
// 手机上第一次打开时写入；之后在手机上改了自选，再运行也不会被覆盖。想用 SEED 覆盖手机上的自选，把 FORCE 改成 true 运行一次再改回来。
// 电脑版 vol.js 的 volMobileScript() 生成的内容与本文件一致，改动时两边同步。
const URL = "https://vitocichen.github.io/NGA/stock.html";
const SEED = [];
const FORCE = false;

const wv = new WebView();
await wv.loadURL(URL);
if (SEED.length) {
  await wv.evaluateJavaScript(`(() => {
    if (${FORCE} || !localStorage.getItem("volGroups")) {
      localStorage.setItem("volGroups", ${JSON.stringify(JSON.stringify(SEED))});
      localStorage.setItem("volGroupSel", "0");
      localStorage.setItem("volPage", "watch");
      location.reload();
    }
    return 1;
  })()`);
}
await wv.present(true);
