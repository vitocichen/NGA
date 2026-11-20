// NGA 实时阅读（在 iPhone 的 Scriptable 里运行）
// 页面从 GitHub Pages 下载，以 https://bbs.nga.cn/ 的身份打开，所以能直接实时读取 NGA，不经过任何服务器。
// 页面更新后重新运行即可，不用改这个脚本。
const PAGE = "https://vitocichen.github.io/NGA/live.html";
const fm = FileManager.local();
const cache = fm.joinPath(fm.documentsDirectory(), "nga_live.html");

let html = null;
try {
  const req = new Request(`${PAGE}?t=${Date.now()}`);
  req.timeoutInterval = 15;
  html = await req.loadString();
  if (!html.includes("NGA_LIVE")) throw new Error("下载到的页面内容不对");
  fm.writeString(cache, html);
} catch (e) {
  // 网络不好时用上次下载的页面
  if (fm.fileExists(cache)) {
    html = fm.readString(cache);
  } else {
    const a = new Alert();
    a.title = "加载失败";
    a.message = String(e);
    a.addAction("好");
    await a.present();
  }
}

if (html) {
  const wv = new WebView();
  await wv.loadHTML(html, "https://bbs.nga.cn/");
  await wv.present(true);
}
Script.complete();
