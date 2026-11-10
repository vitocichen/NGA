"use strict";
// 手机版：读取 GitHub Actions 定时生成的 data/*.json，纯静态展示

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const BATCH = 40;
const STALE_SEC = 40 * 60;
const PREFETCH_PX = 800;

const st = {
  tid: localStorage.getItem("m_tid") || "",
  mode: "all",
  // chat：最新在下（默认，往上加载更早）；desc：最新在上
  order: "chat",
  range: "0",
  index: null,
  data: null,
  list: [],
  // list 中已渲染的区间 [lo, hi)
  lo: 0,
  hi: 0,
  atBottom: true,
  // 指定用户：user={uid,name}；userData 为服务端按 authorid 抓的近 7 天数据，没有时退回在已同步楼层里筛
  user: null,
  userData: null,
  userPending: false,
};

const fmt = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// 手机屏幕窄：今天只显示时分
const shortTime = (ts) => {
  const d = new Date(ts * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
};
const ago = (ts) => {
  const s = Math.floor(Date.now() / 1000) - ts;
  return s < 60 ? "刚刚" : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : `${Math.floor(s / 3600)} 小时前`;
};
const pageBottom = () => document.documentElement.scrollHeight - window.innerHeight;
const isAtBottom = () => pageBottom() - window.scrollY < 80;
const scrollToBottom = () => { window.scrollTo(0, pageBottom()); st.atBottom = true; };

const DATA_API = "https://api.github.com/repos/vitocichen/NGA/contents/";

// Pages 的 CDN 会缓存 10 分钟且忽略 ?t= 参数；有 Token 时改从 data 分支经 API 读取，拿到的是刚推送的数据
async function getJson(path) {
  const token = localStorage.getItem("gh_token");
  if (token && path.startsWith("data/")) {
    try {
      const r = await fetch(`${DATA_API}${path.slice(5)}?ref=data&t=${Date.now()}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json" },
      });
      if (r.ok) return r.json();
    } catch (e) { /* 失败时退回 Pages */ }
  }
  const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadIndex() {
  st.index = await getJson("data/index.json");
  const threads = st.index.threads;
  if (!threads.some((t) => t.tid === st.tid)) st.tid = threads[0].tid;
  $("#threadSel").innerHTML = threads.map((t) => `<option value="${t.tid}">${esc(t.title)}</option>`).join("");
  $("#threadSel").value = st.tid;
}

async function loadThread() {
  $("#more").textContent = "加载中…";
  st.data = await getJson(`data/${st.tid}.json`);
  document.title = `${st.data.title} - NGA 阅读`;
  if (st.mode === "user") await loadUserData();
  rebuild();
}

const watched = (uid) => (st.index.watch || []).some((w) => w.uid === uid);

async function loadUserData() {
  st.userData = null;
  if (!st.user || !st.user.uid || !watched(st.user.uid)) return;
  try {
    st.userData = await getJson(`data/${st.tid}.u${st.user.uid}.json`);
  } catch (e) { /* 列表刚更新、文件还没部署时退回本地筛选 */ }
}

function currentSource() {
  const d = st.data;
  if (st.mode === "op") return d.op_posts;
  if (st.mode === "user") {
    if (st.userData) return st.userData.posts;
    return st.user && st.user.uid ? d.posts.filter((p) => p.authorid === st.user.uid) : [];
  }
  return d.posts;
}

function inRange(p) {
  if (st.range === "0") return true;
  if (st.range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return p.ts >= d / 1000;
  }
  return p.ts >= Math.floor(Date.now() / 1000) - Number(st.range);
}

function rebuild() {
  st.list = currentSource().filter(inRange);
  if (st.order === "desc") st.list.reverse();
  $("#feed").innerHTML = "";
  renderMeta();
  if (!st.list.length) {
    const msg = st.mode === "user" && st.userPending ? `正在获取 ${esc(st.user.name)} 近 7 天的发言，约 1 分钟…`
      : st.mode === "user" ? `${esc(st.user ? st.user.name : "该用户")} 在这个范围内没有发言` : "这个范围内没有发言";
    $("#feed").innerHTML = `<div class="empty">${msg}</div>`;
    $("#more").textContent = "";
    $("#topMore").textContent = "";
    return;
  }
  if (st.order === "chat") {
    st.lo = st.hi = st.list.length;
    renderOlder();
    scrollToBottom();
  } else {
    st.lo = st.hi = 0;
    renderNewer();
    window.scrollTo(0, 0);
  }
}

function renderMeta() {
  const d = st.data;
  const up = st.index.updated;
  const stale = Date.now() / 1000 - up > STALE_SEC;
  const who = st.user ? esc(st.user.name) : "";
  const scope = st.mode === "op" ? `楼主近 7 天 ${d.op_posts.length} 帖`
    : st.mode === "user" ? (st.userData ? `${who} 近 7 天 ${st.userData.posts.length} 帖` : `最近 ${d.posts.length} 楼里 ${who} 的发言`)
    : `最近 ${d.posts.length} 楼`;
  let note = "";
  if (st.mode === "user" && !st.userData) {
    note = st.userPending ? '<br><span class="busy">正在获取近 7 天的完整发言，约 1 分钟后自动显示…</span>'
      : '<br><span class="stale">只在已同步的最近几百楼里找；设置「强制更新」Token 后可获取近 7 天完整发言</span>';
  }
  const src = currentSource();
  const span = src.length ? Math.floor(Date.now() / 1000) - src[0].ts : 0;
  const want = st.range === "today" ? 0 : Number(st.range);
  if (st.mode === "all" && want && span < want) {
    note = `<br><span class="stale">全部发言只同步了最近约 ${Math.max(1, Math.round(span / 3600))} 小时，看更长时间请切到「楼主」</span>`;
  }
  $("#meta").innerHTML = `共 <b>${d.rows_total}</b> 楼 · 显示${scope}中的 <b>${st.list.length}</b> 条 · `
    + `<span class="${stale ? "stale" : ""}">数据更新于 ${fmt(up)}（${ago(up)}）</span>${note}`;
}

// 按 authorid 抓取时 NGA 返回的 lou 是此人在本帖的第几帖，不是全帖楼层
function floorLabel(lou) {
  const perAuthor = st.mode === "op" || (st.mode === "user" && st.userData);
  if (!perAuthor) return `#${lou}`;
  return lou === 0 ? "主楼" : `第${lou}帖`;
}

function postHtml(p) {
  const d = st.data;
  const u = d.users[p.authorid] || (st.userData && st.userData.users[p.authorid]) || {};
  const name = u.name || `UID:${p.authorid}`;
  const isOp = p.authorid === d.authorid;
  const alter = (p.alterinfo || "").match(/\[E(\d{9,})/);
  return `<article class="post${isOp ? " op" : ""}">
    <div class="phead">
      <span class="uname" data-uid="${esc(p.authorid)}">${esc(name)}</span>
      ${isOp ? '<span class="tag">楼主</span>' : ""}
      ${p.score ? `<span class="score">赞 ${p.score}</span>` : ""}
      <span class="ptime">${shortTime(p.ts)}</span>
      <a class="floor" href="https://bbs.nga.cn/read.php?pid=${p.pid || 0}" target="_blank">${floorLabel(p.lou)}</a>
    </div>
    ${p.lou === 0 && p.subject ? `<h3 class="subject">${esc(p.subject)}</h3>` : ""}
    <div class="content">${renderContent(p.content)}</div>
    ${alter ? `<div class="alter">最后编辑于 ${fmt(+alter[1])}</div>` : ""}
  </article>`;
}

const END_TIP = "没有更早的了（只同步最近的楼层，更早的内容请到 NGA 查看）";

// 最新在下：往上补更早的楼层，并保持当前看到的位置不动
function renderOlder() {
  if (st.lo <= 0) return;
  const from = Math.max(0, st.lo - BATCH);
  const html = st.list.slice(from, st.lo).map(postHtml).join("");
  const keep = document.documentElement.scrollHeight - window.scrollY;
  $("#feed").insertAdjacentHTML("afterbegin", html);
  window.scrollTo(0, document.documentElement.scrollHeight - keep);
  st.lo = from;
  $("#topMore").textContent = st.lo > 0 ? "继续上滑加载更早的" : END_TIP;
  $("#more").textContent = "已是最新 · 点「刷新」获取最新同步的数据";
}

// 最新在上：往下补更早的楼层
function renderNewer() {
  const next = st.list.slice(st.hi, st.hi + BATCH);
  $("#feed").insertAdjacentHTML("beforeend", next.map(postHtml).join(""));
  st.hi += next.length;
  $("#topMore").textContent = "";
  $("#more").textContent = st.hi < st.list.length ? "继续下滑加载更多" : END_TIP;
}

async function reload() {
  const btn = $("#reloadBtn");
  btn.disabled = true;
  btn.textContent = "刷新中";
  try {
    await loadIndex();
    await loadThread();
  } catch (e) {
    $("#more").innerHTML = `<span class="err">加载失败：${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "刷新";
  }
}

// ---------- 强制更新：调用 GitHub 接口立即跑一次抓取工作流 ----------
const DISPATCH_URL = "https://api.github.com/repos/vitocichen/NGA/actions/workflows/mobile-site.yml/dispatches";
const FORCE_TIMEOUT = 240;

function openTokenPanel() {
  $("#tokenInput").value = "";
  $("#tokenPanel").classList.remove("hidden");
}

// 触发一次抓取并等它完成；返回新的 index（超时返回 null）。onTick(秒数) 用于显示进度
async function dispatchAndWait(inputs, onTick) {
  const token = localStorage.getItem("gh_token");
  if (!token) {
    openTokenPanel();
    return null;
  }
  const before = st.index ? st.index.updated : 0;
  const r = await fetch(DISPATCH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ ref: "main", inputs: inputs || {} }),
  });
  if (r.status === 401 || r.status === 403 || r.status === 404) {
    const detail = (await r.json().catch(() => ({}))).message || "";
    localStorage.removeItem("gh_token");
    const why = r.status === 401 ? "Token 无效或已过期"
      : "Token 没有触发工作流的权限：请确认 Repository access 选了 NGA，且 Permissions 里 Actions 是 Read and write";
    alert(`${why}\n\nGitHub 返回（HTTP ${r.status}）：${detail}`);
    openTokenPanel();
    return null;
  }
  if (r.status !== 204) throw new Error(`HTTP ${r.status}`);
  const t0 = Date.now();
  await new Promise((ok) => setTimeout(ok, 8000));
  for (;;) {
    const sec = Math.round((Date.now() - t0) / 1000);
    if (onTick) onTick(sec);
    try {
      const idx = await getJson("data/index.json");
      if (idx.updated > before) return idx;
    } catch (e) { /* 部署过程中短暂取不到属正常 */ }
    if (sec > FORCE_TIMEOUT) return null;
    await new Promise((ok) => setTimeout(ok, 5000));
  }
}

async function forceUpdate() {
  if (!localStorage.getItem("gh_token")) return openTokenPanel();
  const btn = $("#forceBtn");
  btn.disabled = true;
  try {
    const idx = await dispatchAndWait({}, (sec) => { btn.textContent = `更新中 ${sec}s`; });
    if (idx) await reload();
    else if (localStorage.getItem("gh_token")) alert("已触发，但 4 分钟内还没更新完，GitHub 可能在排队，请稍后点「刷新」");
  } catch (e) {
    alert(`触发失败：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "强制更新";
  }
}

// ---------- 指定用户 ----------
function setModeButtons() {
  $$("[data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === st.mode));
  $("[data-mode=user]").textContent = st.mode === "user" && st.user ? st.user.name : "指定用户";
}

function openUserPanel() {
  const list = (st.index && st.index.watch) || [];
  $("#watchList").innerHTML = list.length
    ? list.map((w) => `<button data-watch="${esc(w.uid)}">${esc(w.name)}</button>`).join("")
    : '<span class="hint">关注列表还是空的</span>';
  $("#userName").value = "";
  $("#userPanel").classList.remove("hidden");
}

// 在已同步的数据里按昵称找 uid：关注列表 → 本帖用户（完全匹配 → 唯一的包含匹配）
function resolveLocal(name) {
  const low = name.toLowerCase();
  const w = (st.index.watch || []).find((x) => x.name.toLowerCase() === low || x.uid === name);
  if (w) return { uid: w.uid, name: w.name };
  const users = Object.entries(st.data.users).map(([uid, u]) => ({ uid, name: u.name }));
  const exact = users.find((u) => u.name.toLowerCase() === low || u.uid === name);
  if (exact) return exact;
  const part = users.filter((u) => u.name.toLowerCase().includes(low));
  return part.length === 1 ? part[0] : null;
}

async function pickUser(user) {
  $("#userPanel").classList.add("hidden");
  st.mode = "user";
  st.user = user;
  st.userPending = false;
  setModeButtons();
  await loadUserData();
  if (st.userData || !localStorage.getItem("gh_token")) return rebuild();

  // 不在关注列表：先显示本地筛选结果，同时让 GitHub 抓近 7 天并加入关注列表
  st.userPending = true;
  rebuild();
  try {
    const idx = await dispatchAndWait({ users: user.name });
    if (idx) {
      st.index = idx;
      const w = (idx.watch || []).find((x) => x.uid === user.uid || x.name.toLowerCase() === user.name.toLowerCase());
      if (w && st.user === user) {
        st.user = { uid: w.uid, name: w.name };
        await loadUserData();
      } else if (st.user === user && !w) {
        alert(`GitHub 没找到用户「${user.name}」，请检查昵称`);
      }
    }
  } catch (e) {
    alert(`获取失败：${e.message}`);
  }
  if (st.user && (st.user === user || st.user.uid === user.uid)) {
    st.userPending = false;
    setModeButtons();
    if (st.mode === "user") rebuild();
  }
}

function submitUserName() {
  const name = $("#userName").value.trim();
  if (!name) return alert("请输入昵称");
  const u = resolveLocal(name);
  if (u) return pickUser(u);
  if (!localStorage.getItem("gh_token")) {
    return alert(`在已同步的数据里没找到「${name}」。设置「强制更新」Token 后可以查询任意用户`);
  }
  // 本地不认识这个人：交给服务端查昵称
  pickUser({ uid: null, name });
}

// 切回前台时只在站点数据确实更新了才重载，避免打断阅读位置
async function reloadIfUpdated() {
  try {
    const idx = await getJson("data/index.json");
    if (!st.index || idx.updated !== st.index.updated) reload();
  } catch (e) { /* 离线时保持原样 */ }
}

// iPhone 状态栏颜色跟随主题顶栏
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--side").trim();
}

function bind() {
  $("#themeSel").value = document.documentElement.dataset.theme;
  applyTheme($("#themeSel").value);
  $("#themeSel").onchange = () => {
    applyTheme($("#themeSel").value);
    localStorage.setItem("m_theme", $("#themeSel").value);
  };
  $("#threadSel").onchange = () => {
    st.tid = $("#threadSel").value;
    localStorage.setItem("m_tid", st.tid);
    loadThread().catch((e) => { $("#more").innerHTML = `<span class="err">加载失败：${esc(e.message)}</span>`; });
  };
  $("#reloadBtn").onclick = reload;
  $("#forceBtn").onclick = forceUpdate;
  $("#tokenCancel").onclick = () => $("#tokenPanel").classList.add("hidden");
  $("#tokenSave").onclick = () => {
    const t = $("#tokenInput").value.trim();
    if (!/^(github_pat_|ghp_)/.test(t)) return alert("看起来不是 GitHub Token，应以 github_pat_ 开头");
    localStorage.setItem("gh_token", t);
    $("#tokenPanel").classList.add("hidden");
    forceUpdate();
  };
  $("#tokenClear").onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem("gh_token");
    $("#tokenPanel").classList.add("hidden");
    alert("已清除");
  };
  const group = (attr, key) => $$(`[data-${attr}]`).forEach((b) => b.onclick = () => {
    st[key] = b.dataset[attr];
    $$(`[data-${attr}]`).forEach((x) => x.classList.toggle("on", x === b));
    if (st.data) rebuild();
  });
  $$("[data-mode]").forEach((b) => b.onclick = () => {
    if (b.dataset.mode === "user") return openUserPanel();
    st.mode = b.dataset.mode;
    setModeButtons();
    if (st.data) rebuild();
  });
  $("#watchList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-watch]");
    if (b) pickUser({ uid: b.dataset.watch, name: b.textContent });
  });
  $("#userOk").onclick = submitUserName;
  $("#userName").addEventListener("keydown", (e) => e.key === "Enter" && submitUserName());
  $("#userCancel").onclick = () => $("#userPanel").classList.add("hidden");
  group("order", "order");
  group("range", "range");

  new IntersectionObserver((ents) => {
    if (st.order === "chat" && st.data && ents.some((e) => e.isIntersecting)) renderOlder();
  }, { rootMargin: `${PREFETCH_PX}px 0px 0px 0px` }).observe($("#topMore"));
  new IntersectionObserver((ents) => {
    if (st.order === "desc" && st.data && st.hi < st.list.length && ents.some((e) => e.isIntersecting)) renderNewer();
  }, { rootMargin: `0px 0px ${PREFETCH_PX}px 0px` }).observe($("#more"));

  window.addEventListener("scroll", () => { st.atBottom = isAtBottom(); }, { passive: true });
  // 图片、表情加载会撑高页面；停在底部时继续贴底
  document.addEventListener("load", (e) => {
    if (e.target instanceof HTMLImageElement && st.order === "chat" && st.atBottom) scrollToBottom();
  }, true);
  $("#toTop").onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
  $("#toBottom").onclick = () => window.scrollTo({ top: pageBottom(), behavior: "smooth" });

  $("#feed").addEventListener("click", (e) => {
    const un = e.target.closest(".uname[data-uid]");
    if (un) {
      if (un.dataset.uid === st.data.authorid) return $("[data-mode=op]").click();
      return pickUser({ uid: un.dataset.uid, name: un.textContent });
    }
    const img = e.target.closest(".pimg");
    if (!img) return;
    $("#lightbox img").src = img.src;
    $("#lightbox").classList.remove("hidden");
  });
  $("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");
  document.addEventListener("visibilitychange", () => { if (!document.hidden && st.data) reloadIfUpdated(); });
}

(async function init() {
  bind();
  try {
    window.SMILES = await getJson("data/smiles.json");
  } catch (e) { /* 没有表情表时以文字显示 */ }
  await reload();
  const want = new URLSearchParams(location.search).get("user");
  if (want && st.data) {
    const u = resolveLocal(want);
    if (u) pickUser(u);
  }
})();
