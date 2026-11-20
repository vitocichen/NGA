"use strict";
// NGA 实时版：页面以 https://bbs.nga.cn/ 为源运行（Scriptable WebView 的 baseURL），直接同源请求 NGA。

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const PRESETS = [
  { tid: "47288722", title: "自立自强，科学技术打头阵----救赎版" },
  { tid: "47812645", title: "左光右存算电主楼" },
];
const BATCH_PAGES = 2;
const MAX_AUTO_PAGES = 40;
const PREFETCH_PX = 900;

const st = {
  tid: localStorage.getItem("live_tid") || PRESETS[0].tid,
  mode: "all",
  authorid: null,
  user: null,
  order: "chat",
  range: "0",
  topic: null,
  lastPage: 1,
  loPage: 1,
  hiPage: 1,
  posts: new Map(),
  users: {},
  loading: false,
  done: false,
  gen: 0,
  atBottom: true,
  refreshedAt: 0,
  autoTimer: null,
  view: "thread",
  fid: "",
};
let names = {};
try { names = JSON.parse(localStorage.getItem("live_names") || "{}"); } catch (e) { names = {}; }

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const nowTs = () => Math.floor(Date.now() / 1000);
const fmt = (ts) => { const d = new Date(ts * 1000); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const shortTime = (ts) => {
  const d = new Date(ts * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
};
const pageBottom = () => document.documentElement.scrollHeight - window.innerHeight;
const isAtBottom = () => pageBottom() - window.scrollY < 80;
const scrollToBottom = () => { window.scrollTo(0, pageBottom()); st.atBottom = true; };

// ---------- 取数据（同源请求 NGA） ----------
async function ngaFetch(path) {
  let r = await fetch(path, { credentials: "include", cache: "no-store" });
  if (r.status === 403) {
    // 游客校验：拦截页里给出 guestJs 令牌，写入 Cookie 后重试（与 NGA 网页的做法一致）
    const html = await r.text();
    const m = html.match(/guestJs=([^;']+)/);
    if (!m) throw new Error("NGA 拒绝访问（403）");
    document.cookie = `guestJs=${m[1]}; path=/; max-age=3000`;
    await sleep(500);
    r = await fetch(`${path}${path.includes("?") ? "&" : "?"}rand=${Math.floor(Math.random() * 1000)}`,
      { credentials: "include", cache: "no-store" });
  }
  if (!r.ok) throw new Error(`NGA 返回 HTTP ${r.status}`);
  return r;
}

async function fetchPage(tid, page, authorid) {
  const q = `tid=${tid}&page=${page}${authorid ? `&authorid=${authorid}` : ""}`;
  const r = await ngaFetch(`/read.php?${q}&__output=11`);
  const text = await r.text();
  let d;
  try {
    d = JSON.parse(text.replace(/^\s*window\.script_muti_get_var_store\s*=\s*/, ""));
  } catch (e) {
    // 只看某人时 NGA 的 JSON 有时会在中途截断，退回解析 HTML 版
    if (authorid) return fetchPageHtml(tid, page, authorid);
    throw new Error("NGA 返回内容无法解析");
  }
  if (d.error) {
    const msg = Array.isArray(d.error) ? d.error[0] : (d.error[0] || JSON.stringify(d.error));
    throw new Error(String(msg).replace(/^\d+:/, ""));
  }
  return normalize(d.data || d);
}

function learnName(uid, name) {
  uid = String(uid);
  name = String(name || "").trim();
  if (!name || /^UID:?\d+$/.test(name) || name.startsWith("#anony")) return;
  names[uid] = name;
}
function saveNames() {
  try { localStorage.setItem("live_names", JSON.stringify(names)); } catch (e) { /* 存满时忽略 */ }
}

function normalize(d) {
  const topic = d.__T || {};
  if (topic.authorid && topic.author) learnName(topic.authorid, topic.author);
  let rows = d.__R || [];
  rows = Array.isArray(rows) ? rows : Object.values(rows);
  const posts = [];
  for (const r of rows) {
    if (!r || r.lou === undefined) continue;
    const content = String(r.content || "");
    for (const m of content.matchAll(/\[uid=(\d+)\]([^\[]{1,40})\[\/uid\]/g)) learnName(m[1], m[2]);
    posts.push({
      pid: r.pid || 0, lou: Number(r.lou), authorid: String(r.authorid || ""), ts: r.postdatetimestamp || 0,
      time: r.postdate || "", subject: r.subject || "", content, score: r.score || 0, alterinfo: r.alterinfo || "",
    });
  }
  const users = {};
  for (const [k, u] of Object.entries(d.__U || {})) {
    if (!u || typeof u !== "object" || u.uid === undefined) continue;
    learnName(u.uid, u.username);
    users[String(u.uid)] = { name: u.username || "" };
  }
  const per = d.__R__ROWS_PAGE || 20;
  const total = d.__ROWS || posts.length;
  saveNames();
  return {
    title: topic.subject || "", author: topic.author || "", authorid: String(topic.authorid || ""),
    fid: String(topic.fid || (d.__F && d.__F.fid) || ""),
    page: d.__PAGE || 1, pages: Math.max(1, Math.ceil(total / per)), rows: total, posts, users,
  };
}

// ---------- 版面帖子列表 ----------
const DEFAULT_FID = "510567";
// 接口里子版面返回的是上级版面名（如「杂谈」），常用的这里写死显示名
const FORUM_NAMES = { "510567": "[股市]技术分析" };
const lst = { fid: localStorage.getItem("live_fid") || DEFAULT_FID, forum: "", topics: new Map(), page: 0,
  pages: 1, loading: false, scrollY: 0, refreshedAt: 0, loaded: false };

function decodeEntities(s) {
  const t = document.createElement("textarea");
  t.innerHTML = String(s || "");
  return t.value;
}

async function fetchList(fid, page) {
  const r = await ngaFetch(`/thread.php?fid=${fid}&page=${page}&__output=11`);
  const d = JSON.parse((await r.text()).replace(/^\s*window\.script_muti_get_var_store\s*=\s*/, ""));
  if (d.error) throw new Error(String(Array.isArray(d.error) ? d.error[0] : d.error[0]).replace(/^\d+:/, ""));
  const data = d.data || d;
  let rows = data.__T || [];
  rows = Array.isArray(rows) ? rows : Object.values(rows);
  const per = data.__T__ROWS_PAGE || 35;
  return {
    forum: (data.__F && data.__F.name) || "",
    pages: Math.max(1, Math.ceil((data.__ROWS || rows.length) / per)),
    topics: rows.filter((t) => t && t.tid).map((t) => ({
      tid: String(t.tid), subject: decodeEntities(t.subject), author: t.author || "", authorid: String(t.authorid || ""),
      postdate: t.postdate || 0, lastpost: t.lastpost || 0, lastposter: t.lastposter || "", replies: t.replies || 0,
      locked: Boolean((t.type || 0) & 1024),
    })),
  };
}

const ago = (ts) => {
  const s = nowTs() - ts;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return fmt(ts);
};

function topicHtml(t, updated) {
  const pages = Math.ceil((t.replies + 1) / 20);
  return `<article class="topic${updated ? " updated" : ""}${t.tid === st.tid ? " current" : ""}" data-tid="${esc(t.tid)}">
    <div class="t-title">${t.tid === st.tid ? '<span class="t-tag">正在看</span>' : ""}${esc(t.subject)}</div>
    <div class="t-meta">
      <span>${esc(t.author)}</span>
      <span class="replies">回复 ${t.replies}${pages > 1 ? `（${pages} 页）` : ""}</span>
      <span>最后：${esc(t.lastposter)} ${ago(t.lastpost)}</span>
    </div>
  </article>`;
}

function renderList(updated) {
  const list = [...lst.topics.values()].sort((a, b) => b.lastpost - a.lastpost);
  $("#listFeed").innerHTML = list.map((t) => topicHtml(t, updated && updated.has(t.tid))).join("")
    || `<div class="empty">${lst.loading ? "加载中…" : "没有帖子"}</div>`;
  const forum = FORUM_NAMES[lst.fid] || lst.forum;
  $("#listTitle").textContent = forum ? `${forum} · 帖子列表` : "帖子列表";
  const t = lst.refreshedAt ? hms(new Date(lst.refreshedAt)) : "--";
  const auto = Number($("#autoSel").value);
  $("#listMeta").innerHTML = `<span class="live">● 实时</span> · 按最后回复排序 · 已加载 ${list.length} 帖 · 刷新于 ${t}${auto ? `（每 ${auto} 秒自动）` : ""}`;
  $("#listMore").textContent = lst.loading ? "加载中…" : lst.page >= lst.pages ? "没有更多了" : "继续下滑加载更多";
}

async function loadListPage() {
  if (lst.loading || lst.page >= lst.pages) return;
  lst.loading = true;
  renderList();
  try {
    const d = await fetchList(lst.fid, lst.page + 1);
    lst.forum = d.forum || lst.forum;
    lst.pages = d.pages;
    lst.page += 1;
    for (const t of d.topics) if (!lst.topics.has(t.tid)) lst.topics.set(t.tid, t);
    lst.refreshedAt = lst.refreshedAt || Date.now();
  } catch (e) {
    $("#listMore").textContent = `加载失败：${e.message}`;
  } finally {
    lst.loading = false;
    renderList();
  }
}

async function refreshList(manual) {
  if (lst.loading) return;
  const btn = $("#listReload");
  if (manual) { btn.disabled = true; btn.textContent = "刷新中"; }
  try {
    const d = await fetchList(lst.fid, 1);
    lst.forum = d.forum || lst.forum;
    lst.pages = d.pages;
    const updated = new Set();
    for (const t of d.topics) {
      const old = lst.topics.get(t.tid);
      if (!old || t.lastpost > old.lastpost) updated.add(t.tid);
      lst.topics.set(t.tid, t);
    }
    lst.refreshedAt = Date.now();
    const keepTop = window.scrollY < 40;
    renderList(lst.loaded ? updated : null);
    if (keepTop) window.scrollTo(0, 0);
  } catch (e) {
    $("#listMeta").innerHTML += ` <span class="err">刷新失败：${esc(e.message)}</span>`;
  } finally {
    if (manual) { btn.disabled = false; btn.textContent = "刷新"; }
  }
}

async function showList(fid) {
  if (fid && fid !== lst.fid) {
    Object.assign(lst, { fid, forum: "", topics: new Map(), page: 0, pages: 1, loaded: false, scrollY: 0 });
    localStorage.setItem("live_fid", fid);
  }
  st.threadScroll = window.scrollY;
  showView("list");
  if (!lst.loaded) {
    lst.loaded = true;
    await loadListPage();
  } else {
    renderList();
    window.scrollTo(0, lst.scrollY);
    refreshList(false);
  }
}

function showView(v) {
  st.view = v;
  const list = v === "list";
  ["#listTop", "#listFeed", "#listMore"].forEach((s) => $(s).classList.toggle("hidden", !list));
  ["#top", "#feed", "#topMore", "#more", "#newTip"].forEach((s) => $(s).classList.toggle("hidden", list || (s === "#newTip")));
}

async function fetchPageHtml(tid, page, authorid) {
  const r = await ngaFetch(`/read.php?tid=${tid}&page=${page}&authorid=${authorid}`);
  const html = new TextDecoder("gbk").decode(await r.arrayBuffer());
  const procRe = /commonui\.postArg\.proc\(\s*(\d+)\s*,(?:\s*\$\('[^']*'\)\s*,){7}\s*[^,]*,[^,]*,\s*(\d+)\s*,\s*(\d+)\s*,\s*[^,]*,\s*'(-?\d+)'\s*,\s*(\d+)\s*,\s*'([^']*)'\s*,\s*'(\d*)'\s*,\s*'([^']*)'/g;
  const rows = [];
  for (const m of html.matchAll(procRe)) {
    const [, lou, pid, , uid, ts, score, , alter] = m;
    const date = html.match(new RegExp(`id='postdate${lou}'[^>]*>([^<]+)<`));
    const content = html.match(new RegExp(`id='postcontent${lou}'[^>]*>([\\s\\S]*?)</(?:span|p)>`));
    rows.push({ lou, pid, authorid: uid, postdatetimestamp: Number(ts), postdate: date ? date[1].trim() : "",
      content: content ? content[1] : "", score: Number(score.split(",")[1] || 0), alterinfo: alter });
  }
  const um = html.match(/commonui\.userInfo\.setAll\(\s*(\{[\s\S]*?\})\s*\)\s*\n/);
  let users = {};
  try { users = um ? JSON.parse(um[1]) : {}; } catch (e) { users = {}; }
  const pm = html.match(/__PAGE\s*=\s*\{0:'[^']*',1:(\d+),2:(\d+),3:(\d+)\}/);
  const [pages, cur, per] = pm ? pm.slice(1).map(Number) : [1, 1, 20];
  return normalize({
    __T: st.topic ? { subject: st.topic.title, author: st.topic.author, authorid: st.topic.authorid } : {},
    __R: rows, __U: users, __PAGE: cur, __R__ROWS_PAGE: per,
    __ROWS: cur >= pages ? (pages - 1) * per + rows.length : pages * per,
  });
}

// ---------- 视图 ----------
function inRange(p) {
  if (st.range === "0") return true;
  if (st.range === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return p.ts >= d / 1000; }
  return p.ts >= nowTs() - Number(st.range);
}
function rangeStart() {
  if (st.range === "0") return 0;
  if (st.range === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); return d / 1000; }
  return nowTs() - Number(st.range);
}
function sortedPosts() {
  return [...st.posts.values()].filter(inRange).sort((a, b) => a.lou - b.lou);
}
function nameOf(uid) {
  const u = st.users[uid];
  return names[uid] || (u && u.name && !/^UID:?\d+$/.test(u.name) ? u.name : "") || `UID:${uid}`;
}
function floorLabel(lou) {
  if (!st.authorid) return `#${lou}`;
  return lou === 0 ? "主楼" : `第${lou}帖`;
}
function postHtml(p, isNew) {
  const isOp = st.topic && p.authorid === st.topic.authorid;
  const alter = (p.alterinfo || "").match(/\[E(\d{9,})/);
  return `<article class="post${isOp ? " op" : ""}${isNew ? " new" : ""}" data-lou="${p.lou}">
    <div class="phead">
      <span class="uname" data-uid="${esc(p.authorid)}">${esc(nameOf(p.authorid))}</span>
      ${isOp ? '<span class="tag">楼主</span>' : ""}
      ${p.score ? `<span class="score">赞 ${p.score}</span>` : ""}
      <span class="ptime">${shortTime(p.ts)}</span>
      <a class="floor" href="https://bbs.nga.cn/read.php?pid=${p.pid}" target="_blank">${floorLabel(p.lou)}</a>
    </div>
    ${p.lou === 0 && p.subject ? `<h3 class="subject">${esc(p.subject)}</h3>` : ""}
    <div class="content">${renderContent(p.content)}</div>
    ${alter ? `<div class="alter">最后编辑于 ${fmt(+alter[1])}</div>` : ""}
  </article>`;
}

function renderAll(newLous) {
  const list = sortedPosts();
  if (st.order === "desc") list.reverse();
  $("#feed").innerHTML = list.length ? list.map((p) => postHtml(p, newLous && newLous.has(p.lou))).join("")
    : `<div class="empty">${st.loading ? "加载中…" : "这个范围内没有发言"}</div>`;
  renderMeta();
  updateEdges();
}

function renderMeta() {
  const who = st.mode === "op" ? "只看楼主" : st.mode === "user" ? `只看 ${esc(st.user ? st.user.name : "")}` : "全部发言";
  const t = st.refreshedAt ? hms(new Date(st.refreshedAt)) : "--";
  const auto = Number($("#autoSel").value);
  $("#meta").innerHTML = `<span class="live">● 实时</span> · ${who} · 共 <b>${st.topic ? st.topic.rows : "-"}</b> 楼`
    + ` · 已加载 ${sortedPosts().length} 条 · 刷新于 ${t}${auto ? `（每 ${auto} 秒自动）` : ""}`;
}

function updateEdges() {
  const tip = st.done ? "没有更早的了" : st.loading ? "加载中…" : (st.order === "chat" ? "继续上滑加载更早的" : "");
  $("#topMore").textContent = st.order === "chat" ? tip : "";
  $("#more").textContent = st.order === "desc" ? (st.done ? "没有更早的了" : st.loading ? "加载中…" : "继续下滑加载更早的")
    : "已是最新 · 自动刷新中";
}

function addPosts(d) {
  Object.assign(st.users, d.users);
  for (const p of d.posts) st.posts.set(p.lou, p);
}

async function start() {
  const gen = ++st.gen;
  st.posts = new Map();
  st.users = {};
  st.done = false;
  st.loading = true;
  renderAll();
  try {
    const d = await fetchPage(st.tid, "e", st.authorid);
    if (gen !== st.gen) return;
    st.topic = { title: d.title, author: d.author, authorid: d.authorid || (st.topic && st.topic.authorid), rows: d.rows };
    if (d.fid) st.fid = d.fid;
    rememberThread(st.tid, d.title);
    st.lastPage = st.loPage = st.hiPage = d.page;
    addPosts(d);
    st.done = d.page <= 1;
    st.refreshedAt = Date.now();
    st.loading = false;
    await fillOlder(gen);
    if (gen !== st.gen) return;
    renderAll();
    if (st.order === "chat") scrollToBottom(); else window.scrollTo(0, 0);
  } catch (e) {
    if (gen !== st.gen) return;
    st.loading = false;
    const msg = st.authorid && /找不到内容|没有更多页/.test(e.message) ? "这个用户在本帖没有发言" : `读取失败：${e.message}`;
    $("#feed").innerHTML = `<div class="empty err">${esc(msg)}</div>`;
    $("#topMore").textContent = "";
    $("#more").textContent = "";
  }
}

// 首屏楼层太少或选了时间范围时，自动往前补页
async function fillOlder(gen) {
  let n = 0;
  const since = rangeStart();
  while (!st.done && n < MAX_AUTO_PAGES && gen === st.gen) {
    const all = sortedPostsAll();
    const enough = since ? all.length && all[0].ts < since : sortedPosts().length >= 30;
    if (enough) break;
    await loadOlder(gen, true);
    n++;
  }
}
function sortedPostsAll() { return [...st.posts.values()].sort((a, b) => a.lou - b.lou); }

async function loadOlder(gen, silent) {
  if (st.loading || st.done) return;
  st.loading = true;
  if (!silent) updateEdges();
  try {
    const pages = [];
    for (let p = st.loPage - 1; p >= 1 && pages.length < BATCH_PAGES; p--) pages.push(p);
    const ds = await Promise.all(pages.map((p) => fetchPage(st.tid, p, st.authorid)));
    if (gen !== st.gen) return;
    const keep = document.documentElement.scrollHeight - window.scrollY;
    ds.forEach(addPosts);
    st.loPage = Math.min(...pages);
    st.done = st.loPage <= 1;
    st.loading = false;
    if (!silent) {
      renderAll();
      if (st.order === "chat") window.scrollTo(0, document.documentElement.scrollHeight - keep);
    }
  } catch (e) {
    st.loading = false;
    if (!silent) $("#topMore").textContent = `加载失败：${e.message}`;
  }
}

async function refresh(manual) {
  if (st.loading || !st.topic) return;
  const btn = $("#reloadBtn");
  if (manual) { btn.disabled = true; btn.textContent = "刷新中"; }
  try {
    const before = new Set(st.posts.keys());
    const last = await fetchPage(st.tid, "e", st.authorid);
    st.topic.rows = last.rows;
    const pages = [];
    for (let p = st.hiPage; p < last.page; p++) pages.push(p);
    const ds = await Promise.all(pages.map((p) => fetchPage(st.tid, p, st.authorid)));
    ds.forEach(addPosts);
    addPosts(last);
    st.hiPage = st.lastPage = last.page;
    st.refreshedAt = Date.now();
    const fresh = new Set([...st.posts.keys()].filter((k) => !before.has(k)));
    const stick = isAtBottom();
    // 新楼层只会加在下方，停在中间时当前位置不受影响
    renderAll(fresh);
    if (st.order === "chat") {
      if (stick) scrollToBottom();
      else if (fresh.size) showTip(`↓ 新增 ${fresh.size} 楼`);
    } else if (fresh.size && window.scrollY > 40) {
      showTip(`↑ 新增 ${fresh.size} 楼`);
    }
  } catch (e) {
    $("#meta").innerHTML += ` <span class="err">刷新失败：${esc(e.message)}</span>`;
  } finally {
    if (manual) { btn.disabled = false; btn.textContent = "刷新"; }
  }
}

function showTip(text) {
  const t = $("#newTip");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(showTip._t);
  showTip._t = setTimeout(() => t.classList.add("hidden"), 6000);
}

function refreshCurrent() {
  if (st.view === "list") refreshList(false); else refresh(false);
}

function setAuto() {
  clearInterval(st.autoTimer);
  const sec = Number($("#autoSel").value);
  localStorage.setItem("live_auto", String(sec));
  if (sec) st.autoTimer = setInterval(() => { if (!document.hidden) refreshCurrent(); }, sec * 1000);
  if (st.view === "list") renderList(); else renderMeta();
}

// ---------- 帖子与用户 ----------
function knownTitle(tid) {
  const t = lst.topics.get(tid) || PRESETS.find((x) => x.tid === tid);
  return t ? (t.subject || t.title) : "";
}
function setTitle(title) {
  $("#threadTitle").textContent = title || knownTitle(st.tid) || `帖子 ${st.tid}`;
}
function rememberThread(tid, title) {
  if (title && tid === st.tid) setTitle(title);
}
function openThread(tid) {
  st.tid = tid;
  localStorage.setItem("live_tid", tid);
  showView("thread");
  setMode("all");
  setTitle();
  start();
}

function setMode(mode, user) {
  st.mode = mode;
  st.user = mode === "user" ? user : null;
  st.authorid = mode === "op" ? (st.topic && st.topic.authorid) : mode === "user" ? user.uid : null;
  $$("[data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === mode));
  $("[data-mode=user]").textContent = mode === "user" ? user.name : "指定用户";
}

function resolveUser(name) {
  name = name.trim();
  if (/^\d+$/.test(name)) return { uid: name, name: names[name] || `UID:${name}` };
  const low = name.toLowerCase();
  const all = Object.entries(names).map(([uid, n]) => ({ uid, name: n }));
  const exact = all.find((u) => u.name.toLowerCase() === low);
  if (exact) return exact;
  const part = all.filter((u) => u.name.toLowerCase().includes(low));
  return part.length === 1 ? part[0] : part.length ? { many: part.slice(0, 8) } : null;
}

async function checkAccount() {
  try {
    const m = document.cookie.match(/ngaPassportUid=(\d+)/);
    $("#acctText").textContent = m ? `已登录（UID ${m[1]}）` : "NGA 账号：未登录";
    $("#loginBtn").textContent = m ? "重新登录" : "登录 NGA";
  } catch (e) { /* 忽略 */ }
}

// ---------- 事件 ----------
function bind() {
  $("#reloadBtn").onclick = () => refresh(true);
  $$(".menuBtn").forEach((b) => b.onclick = () => { checkAccount(); $("#menuPanel").classList.remove("hidden"); });
  $("#backBtn").onclick = () => showList(st.fid || lst.fid);
  $("#listReload").onclick = () => refreshList(true);
  $("#listFeed").addEventListener("click", (e) => {
    const t = e.target.closest(".topic[data-tid]");
    if (!t) return;
    lst.scrollY = window.scrollY;
    openThread(t.dataset.tid);
  });
  new IntersectionObserver((ents) => {
    if (st.view === "list" && ents.some((e) => e.isIntersecting)) loadListPage();
  }, { rootMargin: `0px 0px ${PREFETCH_PX}px 0px` }).observe($("#listMore"));
  $("#menuClose").onclick = () => $("#menuPanel").classList.add("hidden");
  $("#autoSel").value = localStorage.getItem("live_auto") || "30";
  $("#autoSel").onchange = setAuto;
  $("#themeSel").value = document.documentElement.dataset.theme;
  $("#themeSel").onchange = () => {
    document.documentElement.dataset.theme = $("#themeSel").value;
    localStorage.setItem("live_theme", $("#themeSel").value);
  };
  $("#tidGo").onclick = () => {
    const raw = $("#tidInput").value.trim();
    const m = raw.match(/tid=(\d+)/) || raw.match(/^(\d+)$/);
    if (!m) return alert("请输入帖子链接或数字 tid");
    $("#menuPanel").classList.add("hidden");
    openThread(m[1]);
  };
  $("#loginBtn").onclick = () => { location.href = "/nuke.php?__lib=login&__act=account&login"; };

  $$("[data-mode]").forEach((b) => b.onclick = () => {
    if (b.dataset.mode === "user") {
      $("#userName").value = "";
      $("#userPanel").classList.remove("hidden");
      return;
    }
    setMode(b.dataset.mode);
    start();
  });
  const pickName = () => {
    const r = resolveUser($("#userName").value);
    if (!r) return alert("在已加载的楼层里没找到这个昵称，可以先多翻几页，或直接点楼层里的用户名");
    if (r.many) return alert(`匹配到多个：${r.many.map((u) => u.name).join("、")}，请输入完整昵称`);
    $("#userPanel").classList.add("hidden");
    if (st.topic && r.uid === st.topic.authorid) setMode("op"); else setMode("user", r);
    start();
  };
  $("#userOk").onclick = pickName;
  $("#userName").addEventListener("keydown", (e) => e.key === "Enter" && pickName());
  $("#userCancel").onclick = () => $("#userPanel").classList.add("hidden");

  $$("[data-order]").forEach((b) => b.onclick = () => {
    st.order = b.dataset.order;
    $$("[data-order]").forEach((x) => x.classList.toggle("on", x === b));
    renderAll();
    if (st.order === "chat") scrollToBottom(); else window.scrollTo(0, 0);
  });
  $$("[data-range]").forEach((b) => b.onclick = async () => {
    st.range = b.dataset.range;
    $$("[data-range]").forEach((x) => x.classList.toggle("on", x === b));
    const gen = st.gen;
    renderAll();
    await fillOlder(gen);
    renderAll();
    if (st.order === "chat") scrollToBottom(); else window.scrollTo(0, 0);
  });

  new IntersectionObserver((ents) => {
    if (st.order === "chat" && ents.some((e) => e.isIntersecting)) loadOlder(st.gen, false);
  }, { rootMargin: `${PREFETCH_PX}px 0px 0px 0px` }).observe($("#topMore"));
  new IntersectionObserver((ents) => {
    if (st.order === "desc" && ents.some((e) => e.isIntersecting)) loadOlder(st.gen, false);
  }, { rootMargin: `0px 0px ${PREFETCH_PX}px 0px` }).observe($("#more"));

  window.addEventListener("scroll", () => {
    st.atBottom = isAtBottom();
    if (st.atBottom) $("#newTip").classList.add("hidden");
  }, { passive: true });
  document.addEventListener("load", (e) => {
    if (e.target instanceof HTMLImageElement && st.order === "chat" && st.atBottom) scrollToBottom();
  }, true);
  $("#toTop").onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
  $("#toBottom").onclick = () => window.scrollTo({ top: pageBottom(), behavior: "smooth" });
  $("#newTip").onclick = () => { $("#newTip").classList.add("hidden"); if (st.order === "chat") scrollToBottom(); else window.scrollTo(0, 0); };

  $("#feed").addEventListener("click", (e) => {
    const un = e.target.closest(".uname[data-uid]");
    if (un) {
      const uid = un.dataset.uid;
      if (st.topic && uid === st.topic.authorid) setMode("op"); else setMode("user", { uid, name: un.textContent });
      return start();
    }
    const img = e.target.closest(".pimg");
    if (img) {
      $("#lightbox img").src = img.src;
      $("#lightbox").classList.remove("hidden");
    }
  });
  $("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");
  // 切回前台立刻刷新一次
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshCurrent(); });
}

(async function init() {
  bind();
  setTitle();
  const pages = "https://vitocichen.github.io/NGA/data/";
  const [smiles, remoteNames] = await Promise.all([
    fetch(`${pages}smiles.json`).then((r) => r.json()).catch(() => null),
    fetch(`${pages}names.json`).then((r) => r.json()).catch(() => null),
  ]);
  if (smiles) window.SMILES = smiles;
  // 游客拿不到用户名：合并 GitHub 定时任务以登录身份积累的昵称表，本机学到的优先
  if (remoteNames) names = { ...remoteNames, ...names };
  await start();
  setAuto();
})();
