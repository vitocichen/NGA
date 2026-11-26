"use strict";
// NGA 实时版：页面以 https://bbs.nga.cn/ 为源运行（Scriptable WebView 的 baseURL），直接同源请求 NGA。

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const PRESETS = [
  { tid: "47288722", title: "自立自强，科学技术打头阵----救赎版" },
];
const BATCH_PAGES = 2;
const MAX_AUTO_PAGES = 40;
const PREFETCH_PX = 900;

const st = {
  tid: localStorage.getItem("live_tid") || PRESETS[0].tid,
  mode: "all",
  authorid: null,
  user: null,
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
  backs: [],
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
  if (!r.ok) {
    // NGA 的业务错误也走非 200，正文里带原因（如「帖子审核未通过」「需要登录」）
    const body = await r.text().catch(() => "");
    const m = body.match(/"error"\s*:\s*\[\s*"((?:[^"\\]|\\.)*)"/);
    let why = "";
    try { why = m ? JSON.parse(`"${m[1]}"`).replace(/^\d+:/, "") : ""; } catch (e) { why = ""; }
    throw new Error(why ? `NGA：${why}` : `NGA 返回 HTTP ${r.status}`);
  }
  return r;
}

// NGA 的 JSON 偶尔夹带原始控制字符（浏览器 JSON.parse 不认），也会偶发在中途截断
function parseNgaJson(text) {
  const body = text.replace(/^\s*window\.script_muti_get_var_store\s*=\s*/, "");
  try { return JSON.parse(body); } catch (e) { /* 清掉控制字符再试 */ }
  try { return JSON.parse(body.replace(/[\u0000-\u001f]/g, " ")); } catch (e) { return null; }
}

async function fetchPage(tid, page, authorid) {
  const q = `tid=${tid}&page=${page}${authorid ? `&authorid=${authorid}` : ""}`;
  let r = await ngaFetch(`/read.php?${q}&__output=11`);
  let text = await r.text();
  let d = parseNgaJson(text);
  if (!d) {
    r = await ngaFetch(`/read.php?${q}&__output=11&rand=${Math.floor(Math.random() * 1000)}`);
    text = await r.text();
    d = parseNgaJson(text);
  }
  if (!d) {
    // 两次都解析不了就退回解析 HTML 版
    try {
      const h = await fetchPageHtml(tid, page, authorid);
      if (h.posts.length) return h;
    } catch (e) { /* 用下面的报错 */ }
    const head = text.replace(/\s+/g, " ").slice(0, 60);
    throw new Error(`NGA 返回内容无法解析（HTTP ${r.status}，${text.length} 字，开头：${head}）`);
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
    page: d.__PAGE || 1, pages: Math.max(1, Math.ceil(total / per)), rows: total, per, posts, users,
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

async function refreshList() {
  if (lst.loading) return -1;
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
    return updated.size;
  } catch (e) {
    return -1;
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

// view：thread=帖子，list=版面帖子列表，user=个人主页
function showView(v) {
  if (st.view === "user") uh.scrollY = window.scrollY;
  st.view = v;
  const thread = v === "thread";
  ["#listTop", "#listFeed", "#listMore"].forEach((s) => $(s).classList.toggle("hidden", v !== "list"));
  ["#userTop", "#uhFeed", "#uhMore"].forEach((s) => $(s).classList.toggle("hidden", v !== "user"));
  ["#top", "#feed", "#topMore", "#more", "#newTip"].forEach((s) => $(s).classList.toggle("hidden", !thread || (s === "#newTip")));
  $("#jumpBtn").classList.toggle("hidden", !thread);
  $("#jumpBack").classList.toggle("hidden", !thread || !st.backs.length);
}

async function fetchPageHtml(tid, page, authorid) {
  const r = await ngaFetch(`/read.php?tid=${tid}&page=${page}${authorid ? `&authorid=${authorid}` : ""}`);
  const html = new TextDecoder("gbk").decode(await r.arrayBuffer());
  const tm = html.match(/<title>([^<]*)<\/title>/);
  const title = tm ? decodeEntities(tm[1]).replace(/\s*NGA玩家社区.*$/, "").trim() : "";
  // setDefault(版面, 合集, 帖子号, 楼主 uid, ...)
  const dm = html.match(/commonui\.postArg\.setDefault\(\s*(\d+)\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)/);
  const fm = html.match(/__CURRENT_FID\s*=\s*(\d+)/);
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
    __T: st.topic && st.topic.tid === String(tid) ? { subject: st.topic.title || title, author: st.topic.author, authorid: st.topic.authorid }
      : { subject: title, authorid: dm ? dm[2] : "", fid: dm ? dm[1] : fm ? fm[1] : "" },
    __R: rows, __U: users, __PAGE: cur, __R__ROWS_PAGE: per,
    __ROWS: cur >= pages ? (pages - 1) * per + rows.length : pages * per,
  });
}

// ---------- 视图 ----------
function sortedPosts() {
  return [...st.posts.values()].sort((a, b) => a.lou - b.lou);
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
  const hit = st.hit && String(p.pid) === st.hit.pid && Date.now() < st.hit.until;
  return `<article class="post${isOp ? " op" : ""}${isNew ? " new" : ""}${hit ? " hit" : ""}" data-lou="${p.lou}" data-pid="${esc(p.pid)}">
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
  $("#feed").innerHTML = list.length ? list.map((p) => postHtml(p, newLous && newLous.has(p.lou))).join("")
    : `<div class="empty">${st.loading ? "加载中…" : "还没有发言"}</div>`;
  updateEdges();
}

function updateEdges() {
  $("#topMore").textContent = st.done ? "没有更早的了" : st.loading ? "加载中…" : "继续上滑加载更早的";
  if (st.pulling) return;
  const t = st.refreshedAt ? hms(new Date(st.refreshedAt)) : "--";
  if (st.jump) $("#more").textContent = st.loading ? "加载中…" : "继续下滑加载更新的楼层（接上最新后恢复实时刷新）";
  else $("#more").textContent = `${t} 刷新 · 继续上拉立即刷新`;
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
  st.jump = false;
  setBack(null);
  st.loading = true;
  renderAll();
  try {
    const d = await fetchPage(st.tid, "e", st.authorid);
    if (gen !== st.gen) return;
    const same = st.topic && st.topic.tid === st.tid;
    st.topic = { tid: st.tid, title: d.title || (same ? st.topic.title : ""), author: d.author || (same ? st.topic.author : ""),
      authorid: d.authorid || (same ? st.topic.authorid : ""), rows: d.rows };
    st.per = d.per;
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
    scrollToBottom();
  } catch (e) {
    if (gen !== st.gen) return;
    st.loading = false;
    const msg = st.authorid && /找不到内容|没有更多页/.test(e.message) ? "这个用户在本帖没有发言" : `读取失败：${e.message}`;
    $("#feed").innerHTML = `<div class="empty err">${esc(msg)}</div>`;
    $("#topMore").textContent = "";
    $("#more").textContent = "";
  }
}

// 首屏楼层太少时（最后一页刚翻页、只看某人）自动往前补页
async function fillOlder(gen) {
  let n = 0;
  while (!st.done && n < MAX_AUTO_PAGES && gen === st.gen && st.posts.size < 30) {
    await loadOlder(gen, true);
    n++;
  }
}

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
      window.scrollTo(0, document.documentElement.scrollHeight - keep);
    }
  } catch (e) {
    st.loading = false;
    if (!silent) $("#topMore").textContent = `加载失败：${e.message}`;
  }
}

async function refresh(manual) {
  if (st.loading || !st.topic) return;
  // 跳转浏览时页面和最新楼层之间隔着很多页：自动刷新跳过，手动刷新直接回到最新
  if (st.jump) {
    if (manual) start();
    return;
  }
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
    if (stick) scrollToBottom();
    else if (fresh.size) showTip(`↓ 新增 ${fresh.size} 楼`);
    return fresh.size;
  } catch (e) {
    return -1;
  }
}

function showTip(text) {
  const t = $("#newTip");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(showTip._t);
  showTip._t = setTimeout(() => t.classList.add("hidden"), 6000);
}

// ---------- 楼层跳转 / 引用跳转 ----------
// target：{ pid, page }（引用）或 { lou }（全帖楼号）。只看某人时页面上的 lou 是此人的第几帖，不能按楼号找
function findPost(t) {
  if (t.pid) return document.querySelector(`#feed .post[data-pid="${t.pid}"]`);
  return document.querySelector(`#feed .post[data-lou="${t.lou}"]`);
}
// 顶栏是 sticky 的，滚到元素后再让出顶栏高度
function scrollToEl(el) {
  window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - $("#top").offsetHeight - 6);
}
// 整页重绘会重建楼层元素，高亮和跟随都按 pid 记
function flashPost(el) {
  scrollToEl(el);
  el.classList.remove("hit");
  void el.offsetWidth;
  el.classList.add("hit");
  st.hit = { pid: el.dataset.pid, until: Date.now() + 2600 };
  // 上方图片陆续加载会把目标挤下去，短时间内跟住它；手指一碰就放手
  st.anchor = { pid: el.dataset.pid, until: Date.now() + 4000 };
}
const postByPid = (pid) => document.querySelector(`#feed .post[data-pid="${pid}"]`);
// 返回栈：view 项是跳转前的整个视图（只记最初那个），其余是页内位置，「返回」逐层退回
function setBack(b) {
  if (!b) st.backs = [];
  else if (!(b.view && st.backs.some((x) => x.view))) st.backs.push(b);
  $("#jumpBack").classList.toggle("hidden", !st.backs.length || st.view !== "thread");
}
// 记住屏幕最上面那条楼层和它的位置，上方插入内容后也能回到原处
function viewSpot() {
  const y = $("#top").offsetHeight + 8;
  const el = document.elementFromPoint(window.innerWidth / 2, y);
  const post = el && el.closest("#feed .post");
  return post ? { pid: post.dataset.pid, off: post.getBoundingClientRect().top } : { y: window.scrollY };
}
async function jumpTo(t) {
  const inDom = (t.pid || st.mode === "all") && findPost(t);
  if (inDom) {
    setBack(viewSpot());
    return flashPost(inDom);
  }
  const back = { view: true, mode: st.mode, user: st.user };
  const page = t.page || Math.floor(t.lou / (st.per || 20)) + 1;
  if (st.mode !== "all") setMode("all");
  const gen = ++st.gen;
  st.posts = new Map();
  st.loading = true;
  st.done = false;
  renderAll();
  try {
    const d = await fetchPage(st.tid, page, null);
    if (gen !== st.gen) return;
    addPosts(d);
    st.loPage = st.hiPage = d.page;
    st.lastPage = d.pages;
    st.done = d.page <= 1;
    st.jump = d.page < d.pages;
    st.loading = false;
    setBack(back);
    renderAll();
    const el = findPost(t);
    if (el) flashPost(el);
    else { window.scrollTo(0, 0); showTip("这一页里没找到这层楼（可能已被删除）"); }
  } catch (e) {
    if (gen !== st.gen) return;
    st.loading = false;
    setBack(back);
    $("#feed").innerHTML = `<div class="empty err">跳转失败：${esc(e.message)}</div>`;
  }
}

// 跳转浏览时往下加载更新的楼层；接上最后一页后恢复成实时刷新
async function loadNewer(gen) {
  if (st.loading || !st.jump) return;
  st.loading = true;
  updateEdges();
  try {
    const pages = [];
    for (let p = st.hiPage + 1; p <= st.lastPage && pages.length < BATCH_PAGES; p++) pages.push(p);
    const ds = await Promise.all(pages.map((p) => fetchPage(st.tid, p, null)));
    if (gen !== st.gen) return;
    ds.forEach(addPosts);
    if (pages.length) st.hiPage = Math.max(...pages);
    st.lastPage = Math.max(st.lastPage, ...ds.map((d) => d.pages));
    if (st.hiPage >= st.lastPage) st.jump = false;
    st.loading = false;
    renderAll();
  } catch (e) {
    st.loading = false;
    $("#more").textContent = `加载失败：${e.message}`;
  }
}

function goBack() {
  st.anchor = null;
  const b = st.backs.pop();
  $("#jumpBack").classList.toggle("hidden", !st.backs.length);
  if (!b) return;
  if (b.home) { setBack(null); return openUserHome(b.home, b.kind); }
  if (!b.view) {
    const el = b.pid && postByPid(b.pid);
    return window.scrollTo(0, el ? el.getBoundingClientRect().top + window.scrollY - b.off : b.y || 0);
  }
  // 从主页进来的帖子：退回整页视图后仍保留「回到主页」那一项
  const home = st.backs.find((x) => x.home);
  if (b.mode === "user") setMode("user", b.user); else setMode(b.mode);
  start();
  if (home) setBack(home);
}

function refreshCurrent() {
  if (st.view === "list") refreshList(false); else if (st.view === "thread") refresh(false);
}

function setAuto() {
  clearInterval(st.autoTimer);
  const sec = Number($("#autoSel").value);
  localStorage.setItem("live_auto", String(sec));
  if (sec) st.autoTimer = setInterval(() => { if (!document.hidden) refreshCurrent(); }, sec * 1000);
  if (st.view === "list") renderList(); else updateEdges();
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
  $("#homeBtn").classList.toggle("hidden", mode === "all");
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

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------- 个人主页：他发的帖 / 他的回复 ----------
// NGA 对按用户查询限流很紧（按账号算，实测连续 3 次就 503，之后至少 2 分钟才解封，期间再请求会封得更久），
// 所以请求之间留间隔、结果缓存，被封后冷却期内不再请求
const UQ_GAP = 5000, UQ_COOLDOWN = 60, UQ_COOLDOWN_MAX = 600, UH_TTL = 300000;
const uq = { at: 0, block: 0, fails: 0, chain: Promise.resolve(), cache: new Map(), info: new Map() };
const uh = { uid: null, name: "", kind: "topics", items: [], page: 0, hidden: 0, more: true, loading: false, error: "",
  retryAt: 0, retryTimer: null, scrollY: 0, gen: 0, saved: {}, from: "thread" };

const rateLimited = (sec) => Object.assign(new Error("NGA 限制了按用户查询的频率，稍后再试"), { retry: Math.max(1, Math.ceil(sec)) });

async function fetchUserInfo(uid) {
  if (uq.info.has(uid)) return uq.info.get(uid);
  try {
    const r = await ngaFetch(`/nuke.php?__lib=ucp&__act=get&uid=${uid}&__output=11`);
    const d = parseNgaJson(await r.text());
    const data = d && (d.data || d);
    const row = (Array.isArray(data) ? data[0] : data && data[0]) || {};
    if (row.username && !/^UID:?\d+$/.test(row.username)) { learnName(uid, row.username); saveNames(); }
    const info = { regdate: row.regdate || 0, ipLoc: row.ipLoc || "", group: row.group || "", fans: row.follow_by_num || 0 };
    uq.info.set(uid, info);
    return info;
  } catch (e) {
    return null;
  }
}

async function fetchUserHome(uid, kind, page) {
  const key = `${uid}|${kind}|${page}`;
  const hit = uq.cache.get(key);
  if (hit && Date.now() - hit.at < UH_TTL) return hit.data;
  const run = async () => {
    const wait = uq.block - Date.now();
    if (wait > 0) throw rateLimited(wait / 1000);
    const gap = uq.at + UQ_GAP - Date.now();
    if (gap > 0) await sleep(gap);
    uq.at = Date.now();
    const out = { items: [], more: false, hidden: 0 };
    let d;
    try {
      const r = await ngaFetch(`/thread.php?authorid=${uid}${kind === "replies" ? "&searchpost=1" : ""}&page=${page}&__output=11`);
      d = parseNgaJson(await r.text());
      if (!d) throw new Error("NGA 返回内容无法解析");
      if (d.error) throw new Error(String(Array.isArray(d.error) ? d.error[0] : d.error[0]).replace(/^\d+:/, ""));
    } catch (e) {
      // 翻过最后一页时 NGA 报「没有符合条件的结果」
      if (/没有符合条件/.test(e.message)) return out;
      if (/HTTP 503/.test(e.message)) {
        const cool = Math.min(UQ_COOLDOWN_MAX, UQ_COOLDOWN * 2 ** uq.fails);
        uq.fails++;
        uq.block = Date.now() + cool * 1000;
        throw rateLimited(cool);
      }
      if (/登录/.test(e.message)) throw new Error("需要先登录 NGA 才能看个人主页（右上角 ⋯ → 登录 NGA）");
      throw e;
    }
    uq.fails = 0;
    const data = d.data || d;
    let rows = data.__T || [];
    rows = Array.isArray(rows) ? rows : Object.values(rows);
    for (const t of rows) {
      if (!t || !t.tid) continue;
      const forum = String((t.parent && t.parent["2"]) || "");
      if (kind !== "replies") {
        // 没权限看的老帖只给占位标题「帖子发布或回复时间超过限制」，时间为 0
        if (!t.postdate) { out.hidden++; continue; }
        if (t.authorid && t.author) learnName(t.authorid, t.author);
        out.items.push({ tid: String(t.tid), subject: decodeEntities(t.subject), forum, postdate: t.postdate,
          lastpost: t.lastpost || 0, lastposter: t.lastposter || "", replies: t.replies || 0 });
        continue;
      }
      const p = t.__P || {};
      if (p.denied || typeof p.postdate !== "number") { out.hidden++; continue; }
      out.items.push({ tid: String(t.tid), pid: String(p.pid || 0), ts: p.postdate, forum,
        subject: decodeEntities(t.subject), content: String(p.content || "") });
    }
    out.more = kind === "replies" ? rows.length > 0 : page * Number(data.__T__ROWS_PAGE || 35) < Number(data.__ROWS || 0);
    saveNames();
    uq.cache.set(key, { at: Date.now(), data: out });
    return out;
  };
  // 串行执行，切换标签时不会同时打出多个请求
  const p = uq.chain.then(run, run);
  uq.chain = p.catch(() => {});
  return p;
}

// 发帖 / 回复各自保留已加载的列表，来回切换不重新请求
const UH_LIST_KEYS = ["items", "page", "hidden", "more", "scrollY"];
function openUserHome(u, kind = "topics") {
  if (st.view !== "user") {
    uh.from = st.view;
    if (st.view === "thread") st.threadScroll = window.scrollY;
    else if (st.view === "list") lst.scrollY = window.scrollY;
  } else if (uh.uid === u.uid && uh.kind !== kind && !uh.error && uh.items.length) {
    uh.saved[uh.kind] = Object.fromEntries(UH_LIST_KEYS.map((k) => [k, k === "scrollY" ? window.scrollY : uh[k]]));
  }
  showView("user");
  if (uh.uid === u.uid && uh.kind === kind && uh.items.length && !uh.error) {
    renderUserHome();
    return window.scrollTo(0, uh.scrollY);
  }
  if (uh.uid !== u.uid) uh.saved = {};
  const saved = uh.saved[kind];
  clearInterval(uh.retryTimer);
  Object.assign(uh, { uid: u.uid, name: u.name || (uh.uid === u.uid ? uh.name : ""), kind, items: [], page: 0,
    hidden: 0, more: true, loading: false, error: "", retryAt: 0, scrollY: 0, gen: uh.gen + 1 }, saved || {});
  renderUserHome();
  window.scrollTo(0, uh.scrollY);
  if (!uq.info.has(u.uid)) fetchUserInfo(u.uid).then(() => st.view === "user" && uh.uid === u.uid && renderUserHome());
  if (saved) uhFillIfShort(); else loadUserHome();
}

function leaveUserHome() {
  if (uh.from === "list") return showList(st.fid || lst.fid);
  showView("thread");
  window.scrollTo(0, st.threadScroll || 0);
}

function uhFillIfShort() {
  if (st.view === "user" && uh.more && pageBottom() - window.scrollY < PREFETCH_PX) loadUserHome();
}

async function loadUserHome() {
  if (uh.loading || !uh.more) return;
  uh.loading = true;
  const gen = uh.gen;
  renderUhMore();
  try {
    const d = await fetchUserHome(uh.uid, uh.kind, uh.page + 1);
    if (gen !== uh.gen) return;
    uh.page += 1;
    uh.more = d.more;
    uh.items.push(...d.items);
    uh.hidden += d.hidden;
  } catch (e) {
    if (gen !== uh.gen) return;
    uh.error = e.message;
    uh.more = false;
    if (e.retry) uhScheduleRetry(e.retry, gen);
  }
  uh.loading = false;
  renderUserHome();
  uhFillIfShort();
}

// 被限流时倒计时，到点自动重试（离开主页就不再自动请求）
function uhScheduleRetry(sec, gen) {
  clearInterval(uh.retryTimer);
  uh.retryAt = Date.now() + sec * 1000;
  uh.retryTimer = setInterval(() => {
    if (gen !== uh.gen || st.view !== "user") return clearInterval(uh.retryTimer);
    if (Date.now() < uh.retryAt) return renderUhMore();
    retryUserHome();
  }, 1000);
}
function retryUserHome() {
  clearInterval(uh.retryTimer);
  Object.assign(uh, { retryAt: 0, error: "", more: true });
  loadUserHome();
}

function userTopicHtml(t) {
  const pages = Math.ceil((t.replies + 1) / 20);
  return `<article class="topic" data-tid="${esc(t.tid)}">
    <div class="t-title">${t.forum ? `<span class="t-forum">${esc(t.forum)}</span>` : ""}${esc(t.subject)}</div>
    <div class="t-meta">
      <span>发表于 ${fmt(t.postdate)}</span>
      <span class="replies">回复 ${t.replies}${pages > 1 ? `（${pages} 页）` : ""}</span>
      ${t.lastpost ? `<span>最后：${esc(t.lastposter)} ${ago(t.lastpost)}</span>` : ""}
    </div>
  </article>`;
}
function userReplyHtml(r) {
  return `<article class="topic urow" data-tid="${esc(r.tid)}" data-pid="${esc(r.pid)}">
    <div class="u-head">${r.forum ? `<span class="t-forum">${esc(r.forum)}</span>` : ""}<b>${esc(r.subject)}</b><span>${shortTime(r.ts)}</span></div>
    <div class="content">${renderContent(r.content)}</div>
  </article>`;
}

function renderUserHome() {
  const i = uq.info.get(uh.uid) || {};
  const name = names[uh.uid] || uh.name || `UID:${uh.uid}`;
  $("#uhName").textContent = `${name} 的主页`;
  const meta = [`UID ${uh.uid}`];
  if (i.regdate) { const d = new Date(i.regdate * 1000); meta.push(`注册于 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`); }
  if (i.ipLoc) meta.push(i.ipLoc);
  if (i.group) meta.push(i.group);
  if (i.fans) meta.push(`${i.fans} 人关注`);
  $("#uhMeta").textContent = meta.join(" · ");
  $("#uhNga").href = `https://bbs.nga.cn/nuke.php?func=ucp&uid=${encodeURIComponent(uh.uid)}`;
  $$("[data-uhkind]").forEach((b) => b.classList.toggle("on", b.dataset.uhkind === uh.kind));
  $("#uhFeed").innerHTML = uh.items.map(uh.kind === "topics" ? userTopicHtml : userReplyHtml).join("");
  renderUhMore();
}

function renderUhMore() {
  const none = uh.kind === "topics" ? "没有发过帖子" : "没有可查看的回复";
  const hidden = uh.hidden ? `<br>另有 ${uh.hidden} 条 NGA 不开放查看（太久远或版面无权限），已隐藏` : "";
  const left = Math.ceil((uh.retryAt - Date.now()) / 1000);
  const retry = '<a href="#" onclick="retryUserHome();return false">立即重试</a>';
  const leftText = left >= 60 ? `${Math.floor(left / 60)} 分 ${left % 60} 秒` : `${left} 秒`;
  $("#uhMore").innerHTML = uh.error && left > 0
    ? `<span class="err">NGA 限制了你账号按用户查询的频率（防刷），${leftText}后自动重试</span><br>${retry}`
    : uh.error ? `<span class="err">读取失败：${esc(uh.error)}</span><br>${retry}`
    : uh.loading ? "加载中…"
    : uh.more ? `继续下滑加载更多${hidden}` : (uh.items.length ? `没有更多了 · 共 ${uh.items.length} 条` : none) + hidden;
}

const homeBack = () => ({ home: { uid: uh.uid, name: names[uh.uid] || uh.name }, kind: uh.kind });

// 回复所在页：NGA 的 read.php?pid=&to=1 会重定向到 read.php?tid=..&page=..
async function pidPage(pid) {
  const r = await fetch(`/read.php?pid=${pid}&to=1`, { credentials: "include", cache: "no-store" });
  const m = r.url.match(/[?&]page=(\d+)/);
  try { if (r.body) r.body.cancel(); } catch (e) { /* 忽略 */ }
  return m ? Number(m[1]) : null;
}

async function openPostAt(tid, pid) {
  const back = homeBack();
  st.tid = tid;
  localStorage.setItem("live_tid", tid);
  showView("thread");
  setMode("all");
  setTitle();
  const gen = ++st.gen;
  Object.assign(st, { posts: new Map(), users: {}, loading: true, done: false, jump: false });
  setBack(null);
  renderAll();
  $("#more").textContent = "正在定位这条回复所在的页…";
  try {
    let page = pid === "0" ? 1 : null;
    if (!page) { try { page = await pidPage(pid); } catch (e) { page = null; } }
    const d = await fetchPage(tid, page || "e", null);
    if (gen !== st.gen) return;
    st.topic = { tid, title: d.title, author: d.author, authorid: d.authorid, rows: d.rows };
    st.per = d.per;
    if (d.fid) st.fid = d.fid;
    rememberThread(tid, d.title);
    addPosts(d);
    Object.assign(st, { loPage: d.page, hiPage: d.page, lastPage: d.pages, done: d.page <= 1, jump: d.page < d.pages,
      refreshedAt: Date.now(), loading: false });
    renderAll();
    setBack(back);
    const el = findPost(pid === "0" ? { lou: 0 } : { pid });
    if (el) flashPost(el);
    else { scrollToBottom(); showTip("没找到这条回复（可能已被删除）"); }
  } catch (e) {
    if (gen !== st.gen) return;
    st.loading = false;
    setBack(back);
    $("#feed").innerHTML = `<div class="empty err">读取失败：${esc(e.message)}</div>`;
  }
}

// 长按用户名：弹出菜单（进入主页 / 只看他在本帖的发言）
const userOf = (el) => ({ uid: el.dataset.uid, name: el.textContent.replace(/^@/, "").trim() });
function onlyUser(u) {
  if (st.topic && u.uid === st.topic.authorid) setMode("op"); else setMode("user", u);
  start();
}
function openUserSheet(u, inThread) {
  $("#sheetName").textContent = u.name;
  $("#sheetOnly").classList.toggle("hidden", !inThread);
  $("#sheetHome").onclick = () => { $("#userSheet").classList.add("hidden"); openUserHome(u); };
  $("#sheetOnly").onclick = () => { $("#userSheet").classList.add("hidden"); onlyUser(u); };
  $("#userSheet").classList.remove("hidden");
}
function bindLongPress() {
  const SEL = "#feed .uname[data-uid], #feed .at[data-uid], #uhFeed .at[data-uid]";
  let timer = null, x0 = 0, y0 = 0, el = null, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; if (el) el.classList.remove("pressing"); el = null; };
  window.addEventListener("touchstart", (e) => {
    fired = false;
    cancel();
    const t = e.target.closest && e.target.closest(SEL);
    if (!t || e.touches.length !== 1) return;
    el = t;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    el.classList.add("pressing");
    timer = setTimeout(() => {
      fired = true;
      const u = userOf(el);
      const inThread = !!el.closest("#feed");
      cancel();
      if (navigator.vibrate) navigator.vibrate(15);
      openUserSheet(u, inThread);
    }, 450);
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (timer && Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 10) cancel();
  }, { passive: true });
  window.addEventListener("touchend", cancel, { passive: true });
  window.addEventListener("touchcancel", cancel, { passive: true });
  // 长按松手后浏览器可能补发一次点击，吞掉它，免得同时触发「只看此人」
  document.addEventListener("click", (e) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.addEventListener("contextmenu", (e) => { if (e.target.closest && e.target.closest(SEL)) e.preventDefault(); });
}

function bindUserHome() {
  bindLongPress();
  $("#sheetCancel").onclick = () => $("#userSheet").classList.add("hidden");
  $("#userSheet").addEventListener("click", (e) => { if (e.target.id === "userSheet") $("#userSheet").classList.add("hidden"); });
  $("#uhBack").onclick = leaveUserHome;
  $("#homeBtn").onclick = () => {
    if (!st.authorid) return;
    const name = st.mode === "op" ? (st.topic && st.topic.author) : st.user && st.user.name;
    openUserHome({ uid: st.authorid, name: name || "" });
  };
  $$("[data-uhkind]").forEach((b) => b.onclick = () => openUserHome({ uid: uh.uid, name: uh.name }, b.dataset.uhkind));
  $("#uhFeed").addEventListener("click", (e) => {
    const at = e.target.closest(".at[data-uid]");
    if (at) { e.preventDefault(); return openUserHome(userOf(at)); }
    const img = e.target.closest(".pimg");
    if (img) { $("#lightbox img").src = img.src; return $("#lightbox").classList.remove("hidden"); }
    if (e.target.closest("a, summary")) return;
    const row = e.target.closest("[data-tid]");
    if (!row) return;
    uh.scrollY = window.scrollY;
    if (row.dataset.pid) return openPostAt(row.dataset.tid, row.dataset.pid);
    const back = homeBack();
    openThread(row.dataset.tid);
    setBack(back);
  });
  new IntersectionObserver((ents) => {
    if (st.view === "user" && ents.some((e) => e.isIntersecting)) loadUserHome();
  }, { rootMargin: `0px 0px ${PREFETCH_PX}px 0px` }).observe($("#uhMore"));
}

// ---------- NGA 登录 ----------
// NGA 官方登录页 account_copy.html 放进同源 iframe：它通过 parent.__API 取参数、报告登录成功（与 NGA 网页版外层页面一致）。
// 它的所有提示都用 alert，App 内嵌的 WebView 常常不显示 alert，这里接管过来显示在面板里。
const LOGIN_FRAME_URL = "https://bbs.nga.cn/nuke/account_copy.html?login";
const loggedUid = () => { const m = document.cookie.match(/(?:^|;\s*)ngaPassportUid=(\d+)/); return m ? m[1] : ""; };

function loginMsg(text, isErr) {
  const el = $("#loginMsg");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
  el.classList.remove("hidden");
}

window.__API = {
  get(name, arg) {
    let a = {};
    if (arg) { try { a = new Function(`return (${arg})`)(); } catch (e) { a = {}; } }
    switch (name) {
      case "appid": return "5004";
      case "style": return "web";
      case "userAgent": return navigator.userAgent;
      case "loginSuccess": onNgaLogin(a); return "";
      default: return "";
    }
  },
  getAsync(name, arg, callback) {
    $("#loginFrame").contentWindow[callback](name, arg, this.get(name, arg));
  },
};

async function onNgaLogin(a) {
  if (!a || !a.uid || !a.token) return loginMsg("NGA 返回的登录信息不完整，请再试一次", true);
  loginMsg("登录成功，正在保存登录状态…");
  try {
    await fetch("/nuke.php?__lib=login&__act=login_set_cookie_quick&__output=11", {
      method: "POST", credentials: "include", body: new URLSearchParams({ uid: a.uid, cid: a.token }),
    });
  } catch (e) { /* 下面兜底 */ }
  if (loggedUid() !== String(a.uid)) {
    const opt = `; path=/; domain=.nga.cn; max-age=${3600 * 24 * 365}; secure`;
    document.cookie = `ngaPassportUid=${a.uid}${opt}`;
    document.cookie = `ngaPassportCid=${a.token}${opt}`;
  }
  if (loggedUid() !== String(a.uid)) return loginMsg("NGA 显示登录成功，但登录状态没能保存，请关闭后重新运行脚本再试", true);
  closeLogin();
  checkAccount();
  toast("登录成功，正在重新加载");
  if (st.view === "list") refreshList(true); else start();
}

function openLogin() {
  $("#menuPanel").classList.add("hidden");
  $("#loginMsg").classList.add("hidden");
  const f = $("#loginFrame");
  f.onload = () => {
    try {
      const w = f.contentWindow;
      w.alert = (m) => loginMsg(String(m), !/成功/.test(String(m)));
    } catch (e) { /* 非同源时接管不了，保持原样 */ }
  };
  f.src = LOGIN_FRAME_URL;
  $("#loginPanel").classList.remove("hidden");
}
function closeLogin() {
  $("#loginPanel").classList.add("hidden");
  $("#loginFrame").src = "about:blank";
}

async function checkAccount() {
  try {
    const uid = loggedUid();
    const name = uid && names[uid];
    $("#acctText").textContent = uid ? `已登录：${name || `UID ${uid}`}` : "NGA 账号：未登录";
    $("#loginBtn").textContent = uid ? "重新登录" : "登录 NGA";
  } catch (e) { /* 忽略 */ }
}

// 安卓 App 的返回键：先关面板，再从帖子回到列表；返回 false 时 App 退出
window.__androidBack = () => {
  const open = ["#loginPanel", "#jumpPanel", "#userPanel", "#userSheet", "#menuPanel", "#lightbox"].find((s) => !$(s).classList.contains("hidden"));
  if (open) {
    if (open === "#loginPanel") closeLogin(); else $(open).classList.add("hidden");
    return true;
  }
  if (st.view === "user") { leaveUserHome(); return true; }
  if (st.view === "thread") { showList(st.fid || lst.fid); return true; }
  return false;
};

// ---------- 拉动刷新 ----------
// 帖子页：已经在底部时继续往上拉；帖子列表：已经在顶部时继续往下拉。松手时超过 PULL_PX 就立即刷新
const PULL_PX = 70;
function bindPull() {
  let startY = null, dist = 0;
  const list = () => st.view === "list";
  const show = (text, ms) => (list() ? toast(text, ms || 1500) : ($("#more").textContent = text));
  const reset = () => { st.pulling = false; $("#more").classList.remove("pulling"); updateEdges(); };

  window.addEventListener("touchstart", (e) => {
    startY = null;
    dist = 0;
    if (e.touches.length !== 1 || st.pulling || st.view === "user") return;
    const atEdge = list() ? window.scrollY <= 0 : (isAtBottom() && !st.jump && !st.loading);
    if (atEdge) startY = e.touches[0].clientY;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const y = e.touches[0].clientY;
    dist = list() ? y - startY : startY - y;
    if (dist < 12) return;
    st.pulling = true;
    if (!list()) $("#more").classList.add("pulling");
    show(dist >= PULL_PX ? "松开立即刷新" : list() ? "继续下拉刷新" : "继续上拉刷新");
  }, { passive: true });

  window.addEventListener("touchend", async () => {
    if (startY === null) return;
    startY = null;
    if (!st.pulling) return;
    if (dist < PULL_PX) return list() ? (st.pulling = false) : reset();
    const isList = list();
    show("刷新中…", 8000);
    const n = isList ? await refreshList() : await refresh(true);
    const got = isList ? `已刷新，${n} 个帖子有新回复` : `已刷新，新增 ${n} 楼`;
    show(n > 0 ? got : n === 0 ? "已刷新，暂无新回复" : n < 0 ? "刷新失败，稍后再试" : "已刷新", 1800);
    setTimeout(() => (isList ? (st.pulling = false) : reset()), 1800);
  });
}

// ---------- 事件 ----------
function bind() {
  $$(".menuBtn").forEach((b) => b.onclick = () => { checkAccount(); $("#menuPanel").classList.remove("hidden"); });
  $("#backBtn").onclick = () => showList(st.fid || lst.fid);
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
    if (!m) return toast("请输入帖子链接或数字 tid");
    $("#menuPanel").classList.add("hidden");
    openThread(m[1]);
  };
  $("#loginBtn").onclick = openLogin;
  $("#loginClose").onclick = closeLogin;

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
    if (!r) return toast("在已加载的楼层里没找到这个昵称，可以先多翻几页，或直接点楼层里的用户名", 5000);
    if (r.many) return toast(`匹配到多个：${r.many.map((u) => u.name).join("、")}，请输入完整昵称`, 5000);
    $("#userPanel").classList.add("hidden");
    if (st.topic && r.uid === st.topic.authorid) setMode("op"); else setMode("user", r);
    start();
  };
  $("#userOk").onclick = pickName;
  $("#userName").addEventListener("keydown", (e) => e.key === "Enter" && pickName());
  $("#userCancel").onclick = () => $("#userPanel").classList.add("hidden");

  new IntersectionObserver((ents) => {
    if (st.view === "thread" && ents.some((e) => e.isIntersecting)) loadOlder(st.gen, false);
  }, { rootMargin: `${PREFETCH_PX}px 0px 0px 0px` }).observe($("#topMore"));
  new IntersectionObserver((ents) => {
    if (st.jump && ents.some((e) => e.isIntersecting)) loadNewer(st.gen);
  }, { rootMargin: `0px 0px ${PREFETCH_PX}px 0px` }).observe($("#more"));
  bindPull();

  window.addEventListener("scroll", () => {
    st.atBottom = isAtBottom();
    if (st.atBottom) $("#newTip").classList.add("hidden");
  }, { passive: true });
  document.addEventListener("load", (e) => {
    if (!(e.target instanceof HTMLImageElement)) return;
    const a = st.anchor;
    const ael = a && Date.now() < a.until && postByPid(a.pid);
    if (ael) return scrollToEl(ael);
    if (st.view === "thread" && st.atBottom) scrollToBottom();
  }, true);
  window.addEventListener("touchstart", () => { st.anchor = null; }, { passive: true });
  $("#jumpBack").onclick = goBack;
  $("#jumpBtn").onclick = () => {
    $("#jumpInput").value = "";
    $("#jumpPanel").classList.remove("hidden");
    setTimeout(() => $("#jumpInput").focus(), 50);
  };
  const doJump = () => {
    const lou = parseInt($("#jumpInput").value, 10);
    if (isNaN(lou) || lou < 0) return showTip("请输入楼层号");
    if (st.mode === "all" && st.topic && lou >= st.topic.rows) return showTip(`本帖目前只有 #0 ~ #${st.topic.rows - 1}`);
    $("#jumpPanel").classList.add("hidden");
    $("#jumpInput").blur();
    jumpTo({ lou });
  };
  $("#jumpGo").onclick = doJump;
  $("#jumpInput").addEventListener("keydown", (e) => e.key === "Enter" && doJump());
  $("#jumpCancel").onclick = () => $("#jumpPanel").classList.add("hidden");
  $("#toTop").onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
  $("#toBottom").onclick = () => window.scrollTo({ top: pageBottom(), behavior: "smooth" });
  $("#newTip").onclick = () => { $("#newTip").classList.add("hidden"); scrollToBottom(); };

  $("#feed").addEventListener("click", (e) => {
    // 任何位置的用户名轻点是「只看此人」，长按是菜单；引用框/回复条其余区域点了跳到原楼
    const un = e.target.closest(".uname[data-uid], .at[data-uid]");
    if (un) {
      e.preventDefault();
      if (!localStorage.getItem("live_lp_tip")) {
        localStorage.setItem("live_lp_tip", "1");
        toast("提示：长按用户名可以进入他的个人主页，看他所有的发帖和回复", 5000);
      }
      return onlyUser(userOf(un));
    }
    const t = jumpTargetOf(e, st.tid);
    if (t) {
      e.preventDefault();
      return jumpTo(t);
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
  bindUserHome();
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
