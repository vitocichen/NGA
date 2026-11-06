"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const ATTACH_BASE = "https://img.nga.cn/attachments/";
const SMILE_BASE = "https://img4.nga.cn/ngabbs/post/smile/";
const PREFETCH_PX = 1600;
const LOAD_BATCH = 3;

const state = {
  tid: localStorage.getItem("tid") || "47288722",
  topic: null,
  authorid: null,
  // chat：最新在下（默认，往上加载更早）；desc：最新在上；asc：从头看
  order: "chat",
  atBottom: true,
  from: null,
  to: null,
  cursor: 1,
  done: false,
  loading: false,
  gen: 0,
  latestLou: -1,
  rendered: new Set(),
  users: {},
  smiles: {},
  count: 0,
  pendingNew: 0,
  autoTimer: null,
};

// ---------- 工具 ----------
async function api(path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") q.set(k, v);
  let r;
  try {
    r = await fetch(`/api/${path}?${q}`);
  } catch (e) {
    throw new Error("本地服务未运行（可能已被关闭），请双击 启动.bat 后点「重试」");
  }
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDateInput = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const nowTs = () => Math.floor(Date.now() / 1000);
const startOfDay = (offsetDays = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offsetDays); return Math.floor(d / 1000); };

function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function parseTid(raw) {
  raw = raw.trim();
  const m = raw.match(/tid=(\d+)/) || raw.match(/^(\d+)$/);
  return m ? m[1] : null;
}

// ---------- BBCode 渲染 ----------
function normalizeImg(u) {
  u = u.trim();
  if (u.startsWith("./")) u = ATTACH_BASE + u.slice(2);
  else if (u.startsWith("/")) u = ATTACH_BASE + u.slice(1);
  else if (/^mon_\d/.test(u)) u = ATTACH_BASE + u;
  return u.replace("img.nga.178.com", "img.nga.cn");
}
function imgTag(u) {
  u = normalizeImg(u);
  if (!/^https?:\/\//.test(u)) return "";
  return `<img class="pimg" loading="lazy" referrerpolicy="no-referrer" src="${esc(u)}" data-orig="${esc(u)}">`;
}
function safeUrl(u) {
  u = u.trim().replace(/&amp;/g, "&");
  if (u.startsWith("/")) u = "https://bbs.nga.cn" + u;
  return /^https?:\/\//.test(u) ? esc(u) : null;
}

function renderContent(src) {
  let s = String(src || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // NGA 对 emoji 等字符做了双重转义：&amp;#128059;
    .replace(/&amp;(#\d{2,7};|#x[0-9a-f]{2,6};)/gi, "&$1");

  s = s.replace(/\[s:(\d+)\]/g, (m, n) => smile("0", n, m));
  s = s.replace(/\[s:([^:\]]+):([^\]]+)\]/g, (m, g, n) => smile(g, n, m));
  s = s.replace(/\[img\]\s*([\s\S]*?)\s*\[\/img\]/gi, (m, u) => imgTag(u));

  // 楼中楼回复头：[b]Reply to [pid=..]Reply[/pid] Post by [uid=..]name[/uid] (time)正文可能也在[/b]里
  s = s.replace(/\[b\]\s*Reply to \[(pid|tid)=(\d+)[^\]]*\][\s\S]*?\[\/\1\]\s*Post by \[uid=?(\d*)\]([\s\S]*?)\[\/uid\]\s*\(([^)]*)\)([\s\S]*?)\[\/b\]/gi,
    (m, k, id, uid, name, t, rest) => `<div class="replyto">回复 <a class="at" href="https://bbs.nga.cn/read.php?${k}=${id}" target="_blank">@${name}</a> <span class="t">${t}</span></div>${rest.replace(/^\s+/, "")}`);
  // 引用头：[pid=..]Reply[/pid] [b]Post by [uid=..]name[/uid] (time):[/b]
  s = s.replace(/\[(pid|tid)=(\d+)[^\]]*\][\s\S]*?\[\/\1\]\s*\[b\]\s*Post by \[uid=?(\d*)\]([\s\S]*?)\[\/uid\]\s*\(([^)]*)\):?\s*\[\/b\]/gi,
    (m, k, id, uid, name, t) => `<div class="qhead"><a class="at" href="https://bbs.nga.cn/read.php?${k}=${id}" target="_blank">${name}</a> <span class="t">${t}</span></div>`);

  s = s.replace(/\[pid=(\d+)[^\]]*\]([\s\S]*?)\[\/pid\]/gi, (m, id, t) => `<a href="https://bbs.nga.cn/read.php?pid=${id}" target="_blank">${t === "Reply" ? "回复" : t}</a>`);
  s = s.replace(/\[tid=(\d+)[^\]]*\]([\s\S]*?)\[\/tid\]/gi, (m, id, t) => `<a href="https://bbs.nga.cn/read.php?tid=${id}" target="_blank">${t === "Topic" ? "主题" : t}</a>`);
  s = s.replace(/\[uid=?(\d*)\]([\s\S]*?)\[\/uid\]/gi, (m, uid, n) => `<span class="at">${n}</span>`);
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (m, u, t) => { const h = safeUrl(u); return h ? `<a href="${h}" target="_blank">${t}</a>` : t; });
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (m, u) => { const h = safeUrl(u); return h ? `<a href="${h}" target="_blank">${u}</a>` : u; });

  const simple = [
    [/\[b\]([\s\S]*?)\[\/b\]/gi, "<b>$1</b>"],
    [/\[i\]([\s\S]*?)\[\/i\]/gi, "<i>$1</i>"],
    [/\[u\]([\s\S]*?)\[\/u\]/gi, "<u>$1</u>"],
    [/\[del\]([\s\S]*?)\[\/del\]/gi, "<del>$1</del>"],
    [/\[h\]([\s\S]*?)\[\/h\]/gi, "<h4>$1</h4>"],
    [/\[code\]([\s\S]*?)\[\/code\]/gi, "<pre>$1</pre>"],
    [/\[color=([#\w]{1,20})\]([\s\S]*?)\[\/color\]/gi, '<span style="color:$1">$2</span>'],
    [/\[align=(left|right|center)\]([\s\S]*?)\[\/align\]/gi, '<div style="text-align:$1">$2</div>'],
    [/\[font=[^\]]*\]([\s\S]*?)\[\/font\]/gi, "$1"],
    [/\[list\]([\s\S]*?)\[\/list\]/gi, (m, b) => "<ul>" + b.split("[*]").filter((x) => x.trim()).map((x) => `<li>${x}</li>`).join("") + "</ul>"],
    [/\[size=(\d+)%?\]([\s\S]*?)\[\/size\]/gi, (m, n, t) => `<span style="font-size:${Math.min(250, Math.max(60, +n))}%">${t}</span>`],
    [/\[collapse(?:=([^\]]*))?\]([\s\S]*?)\[\/collapse\]/gi, (m, t, b) => `<details><summary>${t || "点击显示隐藏的内容"}</summary>${b}</details>`],
    [/\[quote\]((?:(?!\[quote\])[\s\S])*?)\[\/quote\]/gi, (m, b) => `<div class="quote">${b.replace(/^\n+|\n+$/g, "")}</div>`],
  ];
  for (let i = 0; i < 6; i++) {
    const before = s;
    for (const [re, rep] of simple) s = s.replace(re, rep);
    if (s === before) break;
  }
  s = s.replace(/\[\/?(attach|flash|stripbtn|randomblock|dice)[^\]]*\]/gi, "");
  s = s.replace(/(<\/div>|<\/details>|<\/ul>|<\/h4>|<\/pre>)\n{1,2}/g, "$1");
  return s.replace(/\n/g, "<br>");
}
function smile(group, name, raw) {
  const g = state.smiles[group];
  const f = g && g[name];
  return f ? `<img class="smile" src="${SMILE_BASE}${f}" alt="${esc(name)}" title="${esc(name)}">` : `<span class="smile-txt">[${name}]</span>`;
}

// ---------- 楼层卡片 ----------
function money(m) {
  const g = Math.floor(m / 10000), s = Math.floor((m % 10000) / 100), c = m % 100;
  return (g ? `${g}金` : "") + (s ? `${s}银` : "") + (!g && !s ? `${c}铜` : "");
}
function regDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return `${String(d.getFullYear()).slice(2)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 只看楼主时 NGA 返回的 lou 是楼主自己的第几帖，不是全帖楼层
function floorLabel(lou) {
  if (!state.authorid) return `#${lou}`;
  return lou === 0 ? "主楼" : `第${lou}帖`;
}

// alterinfo 形如 "[E1785486496 0 0]"，E 表示编辑时间
function alterText(a) {
  if (!a) return "";
  const m = String(a).match(/\[E(\d{9,})/);
  return m ? `最后编辑于 ${fmtTime(+m[1])}` : "";
}

function postHtml(p, isNew) {
  const u = state.users[p.authorid];
  const name = (u && u.name) || `UID:${p.authorid}`;
  const isOp = state.topic && p.authorid === state.topic.authorid;
  const tip = u ? `声望 ${u.rep ?? "-"}　威望 ${u.prestige}　发帖 ${u.postnum}　注册 ${regDate(u.regdate)}　财富 ${money(u.money)}` : "";
  const inContent = p.content || "";
  const extra = (p.attachs || []).filter((a) => !inContent.includes(a.replace(/^\.\//, "")));
  return `
  <div class="post${isNew ? " new" : ""}${isOp ? " op" : ""}" id="l${p.lou}" data-lou="${p.lou}">
    <div class="poster" title="${esc(tip)}">
      <div class="utop">
        <span class="uname">${esc(name)}</span>
        ${isOp ? '<span class="tag op">楼主</span>' : ""}
        ${u && u.muted ? '<span class="tag muted">禁言</span>' : ""}
      </div>
      ${u ? `<div class="ustat">
        <span>声望: <b>${u.rep ?? "-"}</b></span><span>威望: <b>${u.prestige}</b></span>
        <span>注册: <b>${regDate(u.regdate)}</b></span><span>财富: <b>${money(u.money)}</b></span>
      </div>` : ""}
    </div>
    <div class="pbody">
      <div class="phead">
        ${p.score ? `<span class="score">赞 ${p.score}</span>` : ""}
        ${isNew ? '<span class="tag newtag">新</span>' : ""}
        <span class="ptime">${esc(p.time || fmtTime(p.ts))}</span>
        <a class="floor" href="https://bbs.nga.cn/read.php?pid=${p.pid}" target="_blank" title="在 NGA 打开这一楼">${floorLabel(p.lou)}</a>
      </div>
      ${p.lou === 0 && p.subject ? `<h3 class="subject">${esc(p.subject)}</h3>` : ""}
      <div class="content">${renderContent(p.content)}</div>
      ${extra.length ? `<div class="attachs">${extra.map(imgTag).join("")}</div>` : ""}
      ${alterText(p.alterinfo) ? `<div class="alter">${esc(alterText(p.alterinfo))}</div>` : ""}
    </div>
  </div>`;
}

function inRange(p) {
  return (!state.from || p.ts >= state.from) && (!state.to || p.ts <= state.to);
}
function renderPosts(posts, where, isNew = false) {
  const fresh = posts.filter((p) => inRange(p) && !state.rendered.has(p.lou));
  if (!fresh.length) return 0;
  fresh.forEach((p) => state.rendered.add(p.lou));
  const html = fresh.map((p) => postHtml(p, isNew)).join("");
  $("#feed").insertAdjacentHTML(where === "top" ? "afterbegin" : "beforeend", html);
  state.count += fresh.length;
  return fresh.length;
}

// ---------- 视图与加载 ----------
function applyMeta(d) {
  state.topic = { title: d.title, author: d.author, authorid: d.authorid, forum: d.forum, lastpost: d.lastpost, rows: d.rows_total, pages: d.pages, perPage: d.per_page };
  Object.assign(state.users, d.users);
  document.title = d.title ? `${d.title} - NGA 阅读器` : "NGA 阅读器";
  $("#topicTitle").textContent = d.title || "-";
  $("#topicAuthor").textContent = d.author || d.authorid;
  $("#topicForum").textContent = d.forum || "-";
  $("#topicLast").textContent = d.lastpost ? fmtTime(d.lastpost) : "-";
  if (!state.authorid) $("#topicRows").textContent = `${d.rows_total} 楼 / ${d.pages} 页`;
}

function describeView() {
  const who = state.authorid ? "只看楼主" : "全部发言";
  const ord = { chat: "最新在下", desc: "最新在上", asc: "从头看" }[state.order];
  let range = "不限时间";
  if (state.from || state.to) range = `${state.from ? fmtTime(state.from) : "最早"} ~ ${state.to ? fmtTime(state.to) : "现在"}`;
  $("#viewDesc").textContent = `${who} · ${ord} · ${range}`;
}
function updateFooter(text) {
  $("#loadedInfo").textContent = `已加载 ${state.count} 楼`;
  const chat = state.order === "chat";
  const f = chat ? $("#topText") : $("#footerText");
  const other = chat ? $("#footerText") : $("#topText");
  other.textContent = chat && state.count && !state.to ? "已是最新 · 点「刷新」获取新回复" : "";
  if (text) f.innerHTML = text;
  else if (state.loading) f.innerHTML = '<span class="spinner"></span>加载中…';
  else if (state.done) f.textContent = state.count ? (state.order === "asc" && !state.to ? "已经到最新了，点「刷新」获取新回复" : "没有更早的了") : "这个范围内没有发言";
  else f.textContent = chat ? "继续上滑加载更早的发言" : "继续下滑加载更多";
}

function isAtBottom() {
  const m = $("#main");
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}
function scrollToBottom() {
  const m = $("#main");
  m.scrollTop = m.scrollHeight;
  state.atBottom = true;
}

async function startView(opts = {}) {
  const gen = ++state.gen;
  $("#feed").innerHTML = "";
  $("#topText").textContent = "";
  $("#footerText").textContent = "";
  $("#main").scrollTop = 0;
  Object.assign(state, { rendered: new Set(), count: 0, done: false, loading: true, pendingNew: 0, atBottom: true });
  $("#newBanner").classList.add("hidden");
  describeView();
  updateFooter('<span class="spinner"></span>正在读取帖子…');
  try {
    const last = await api("page", { tid: state.tid, page: "e", authorid: state.authorid, fresh: 1 });
    if (gen !== state.gen) return;
    applyMeta(last);
    if (state.authorid) $("#topicRows").textContent = `楼主共 ${last.rows_total} 楼`;
    state.latestLou = Math.max(-1, ...last.posts.map((p) => p.lou));

    let start;
    if (opts.page) start = Math.min(opts.page, last.pages);
    else if (state.order !== "asc") start = state.to && state.to < nowTs() ? await locate(state.to, gen) : last.page;
    else start = state.from ? await locate(state.from, gen) : 1;
    if (gen !== state.gen) return;
    state.cursor = start;
    state.loading = false;
    await loadMore();
    if (state.order === "chat" && gen === state.gen) scrollToBottom();
    if (opts.scrollTo !== undefined) scrollToFloor(opts.scrollTo);
    $("#refreshInfo").textContent = `最近刷新 ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    if (gen !== state.gen) return;
    state.loading = false;
    updateFooter(`<span class="err">读取失败：${esc(e.message)}</span>　<a href="#" onclick="startView();return false">重试</a>`);
  }
}

async function locate(ts, gen) {
  updateFooter('<span class="spinner"></span>正在按时间定位页码（约需几秒）…');
  const d = await api("locate", { tid: state.tid, ts, authorid: state.authorid });
  return d.page;
}

function sentinelNear() {
  const box = $("#main").getBoundingClientRect();
  if (state.order === "chat") return $("#topSentinel").getBoundingClientRect().bottom > box.top - PREFETCH_PX;
  return $("#sentinel").getBoundingClientRect().top < box.bottom + PREFETCH_PX;
}

// 往顶部插入内容时保持视口内容不跳动（在底部时就继续贴底）
function prependKeepingView(posts) {
  const m = $("#main");
  const fromBottom = m.scrollHeight - m.scrollTop;
  const added = renderPosts(posts, "top");
  if (added) m.scrollTop = m.scrollHeight - fromBottom;
  return added;
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  const gen = state.gen;
  updateFooter();
  try {
    let emptyPages = 0;
    const step = state.order === "asc" ? 1 : -1;
    const chat = state.order === "chat";
    while (!state.done && gen === state.gen) {
      const maxPage = (state.topic && state.topic.pages) || state.cursor;
      const batch = [];
      for (let p = state.cursor; batch.length < LOAD_BATCH && p >= 1 && p <= maxPage; p += step) batch.push(p);
      const pages = await Promise.all(batch.map((p) => api("page", { tid: state.tid, page: p, authorid: state.authorid })));
      if (gen !== state.gen) return;
      for (const d of pages) {
        Object.assign(state.users, d.users);
        const posts = d.posts;
        const added = chat ? prependKeepingView(posts)
          : renderPosts(step < 0 ? [...posts].reverse() : posts, "bottom");
        emptyPages = added ? 0 : emptyPages + 1;
        if (step < 0) {
          if (d.page <= 1 || (state.from && posts.length && posts[0].ts < state.from)) { state.done = true; break; }
        } else if (d.page >= d.pages || (state.to && posts.length && posts[posts.length - 1].ts > state.to)) { state.done = true; break; }
        state.cursor = d.page + step;
      }
      if (!sentinelNear() && emptyPages === 0) break;
      if (emptyPages > 60) break;
    }
  } catch (e) {
    updateFooter(`<span class="err">加载失败：${esc(e.message)}</span>　<a href="#" onclick="loadMore();return false">重试</a>`);
    state.loading = false;
    return;
  }
  state.loading = false;
  updateFooter();
}

async function refresh() {
  if (state.loading) return;
  const btn = $("#refreshBtn");
  btn.disabled = true;
  btn.textContent = "刷新中…";
  try {
    const last = await api("page", { tid: state.tid, page: "e", authorid: state.authorid, fresh: 1 });
    applyMeta(last);
    if (state.authorid) $("#topicRows").textContent = `楼主共 ${last.rows_total} 楼`;
    let collected = last.posts.filter((p) => p.lou > state.latestLou);
    let pagePosts = last.posts;
    let pg = last.page;
    while (pg > 1 && pg > last.page - 10 && pagePosts.length && pagePosts.every((p) => p.lou > state.latestLou)) {
      pg--;
      const d = await api("page", { tid: state.tid, page: pg, authorid: state.authorid, fresh: 1 });
      Object.assign(state.users, d.users);
      pagePosts = d.posts;
      collected = pagePosts.filter((p) => p.lou > state.latestLou).concat(collected);
    }
    if (collected.length) state.latestLou = Math.max(state.latestLou, ...collected.map((p) => p.lou));

    let shown = 0;
    if (state.order === "chat" && (!state.to || state.to >= nowTs())) {
      const stick = isAtBottom();
      shown = renderPosts(collected, "bottom", true);
      if (stick) scrollToBottom();
      else if (shown) showBanner(shown, "bottom");
    } else if (state.order === "desc" && (!state.to || state.to >= nowTs())) {
      const main = $("#main");
      const keep = main.scrollTop > 40;
      const h0 = main.scrollHeight;
      shown = renderPosts([...collected].reverse(), "top", true);
      if (keep) main.scrollTop += main.scrollHeight - h0;
      if (keep && shown) showBanner(shown, "top");
    } else if (state.order === "asc" && state.done && !state.to) {
      shown = renderPosts(collected, "bottom", true);
    } else if (collected.length) {
      showBanner(collected.length, "switch");
    }
    updateFooter();
    $("#refreshInfo").textContent = `最近刷新 ${new Date().toLocaleTimeString()}，新增 ${collected.length} 楼`;
    toast(collected.length ? `新增 ${collected.length} 楼` : "暂无新回复");
  } catch (e) {
    toast(`刷新失败：${e.message}`, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = "刷新";
  }
}

function showBanner(n, mode) {
  state.pendingNew += n;
  const b = $("#newBanner");
  b.textContent = {
    switch: `有 ${state.pendingNew} 条新回复，点此切到「最新在下」查看`,
    top: `↑ 顶部新增 ${state.pendingNew} 楼，点此回到顶部`,
    bottom: `↓ 底部新增 ${state.pendingNew} 楼，点此查看`,
  }[mode];
  b.dataset.mode = mode;
  b.classList.toggle("bottom", mode === "bottom");
  b.classList.remove("hidden");
}
function hideBanner() {
  $("#newBanner").classList.add("hidden");
  state.pendingNew = 0;
}

function scrollToFloor(lou) {
  const el = document.getElementById(`l${lou}`);
  if (el) { el.scrollIntoView({ block: "start" }); el.classList.add("new"); setTimeout(() => el.classList.remove("new"), 2500); }
}

// ---------- 事件 ----------
function setRange(from, to) {
  state.from = from || null;
  state.to = to || null;
  $("#fromInput").value = from ? fmtDateInput(from) : "";
  $("#toInput").value = to ? fmtDateInput(to) : "";
}

function bind() {
  $("#tidInput").value = `https://bbs.nga.cn/read.php?tid=${state.tid}`;
  $("#openBtn").onclick = () => {
    const tid = parseTid($("#tidInput").value);
    if (!tid) return toast("无法识别 tid，请输入帖子链接或数字");
    state.tid = tid;
    localStorage.setItem("tid", tid);
    state.authorid = null;
    setMode();
    startView();
  };
  $("#tidInput").addEventListener("keydown", (e) => e.key === "Enter" && $("#openBtn").click());
  $("#refreshBtn").onclick = refresh;
  $("#allBtn").onclick = () => { state.authorid = null; setMode(); startView(); };
  $("#opBtn").onclick = () => {
    if (!state.topic) return;
    state.authorid = state.topic.authorid;
    setMode();
    startView();
  };
  $$(".order").forEach((b) => b.onclick = () => {
    state.order = b.dataset.order;
    $$(".order").forEach((x) => x.classList.toggle("active", x === b));
    startView();
  });
  $$("[data-range]").forEach((b) => b.onclick = () => {
    const n = nowTs();
    const map = {
      "1h": [n - 3600, null], "3h": [n - 3 * 3600, null], today: [startOfDay(0), null],
      yesterday: [startOfDay(-1), startOfDay(0) - 1], "7d": [n - 7 * 86400, null], all: [null, null],
    };
    setRange(...map[b.dataset.range]);
    $$("[data-range]").forEach((x) => x.classList.toggle("active", x === b && b.dataset.range !== "all"));
    startView();
  });
  $("#applyRange").onclick = () => {
    const f = $("#fromInput").value, t = $("#toInput").value;
    const from = f ? Math.floor(new Date(f) / 1000) : null;
    const to = t ? Math.floor(new Date(t) / 1000) + 59 : null;
    if (from && to && from > to) return toast("开始时间不能晚于结束时间");
    setRange(from, to);
    $$("[data-range]").forEach((x) => x.classList.remove("active"));
    startView();
  };
  $("#jumpBtn").onclick = () => {
    const lou = parseInt($("#jumpInput").value, 10);
    if (isNaN(lou) || lou < 0) return toast("请输入楼层号");
    if (state.authorid) { state.authorid = null; setMode(); }
    setRange(null, null);
    $$("[data-range]").forEach((x) => x.classList.remove("active"));
    state.order = "asc";
    $$(".order").forEach((x) => x.classList.toggle("active", x.dataset.order === "asc"));
    const per = (state.topic && state.topic.perPage) || 20;
    startView({ page: Math.floor(lou / per) + 1, scrollTo: lou });
  };
  $("#jumpInput").addEventListener("keydown", (e) => e.key === "Enter" && $("#jumpBtn").click());

  $("#autoChk").onchange = $("#autoSec").onchange = () => {
    clearInterval(state.autoTimer);
    if ($("#autoChk").checked) state.autoTimer = setInterval(refresh, +$("#autoSec").value * 1000);
  };

  $("#newBanner").onclick = () => {
    const mode = $("#newBanner").dataset.mode;
    hideBanner();
    if (mode === "switch") {
      state.order = "chat";
      setRange(null, null);
      $$(".order").forEach((x) => x.classList.toggle("active", x.dataset.order === "chat"));
      startView();
    } else if (mode === "bottom") scrollToBottom();
    else $("#main").scrollTop = 0;
  };
  const toTop = () => { $("#main").scrollTop = 0; };
  const toBottom = () => scrollToBottom();
  $("#topBtn").onclick = toTop;
  $("#bottomBtn").onclick = toBottom;
  let posPending = false;
  $("#main").addEventListener("scroll", () => {
    state.atBottom = isAtBottom();
    const mode = $("#newBanner").dataset.mode;
    if ((mode === "top" && $("#main").scrollTop < 40) || (mode === "bottom" && state.atBottom)) hideBanner();
    if (!posPending) { posPending = true; requestAnimationFrame(() => { posPending = false; updatePos(); }); }
  });
  // 图片/表情加载会撑高内容，停在底部时继续贴底
  document.addEventListener("load", (e) => {
    if (e.target instanceof HTMLImageElement && state.order === "chat" && state.atBottom) scrollToBottom();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea")) return;
    if (e.key === "Home") { e.preventDefault(); toTop(); }
    if (e.key === "End") { e.preventDefault(); toBottom(); }
  });
  window.addEventListener("pagehide", () => navigator.sendBeacon("/api/bye"));
  setInterval(() => fetch("/api/ping").catch(() => {}), 15000);

  $("#feed").addEventListener("click", (e) => {
    const img = e.target.closest(".pimg");
    if (!img) return;
    const lb = $("#lightbox");
    lb.querySelector("img").src = img.currentSrc || img.src;
    lb.classList.remove("hidden");
  });
  $("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#lightbox").classList.add("hidden");
    if (e.key === "F5") { e.preventDefault(); refresh(); }
  });

  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.orig || img.dataset.proxied) return;
    img.dataset.proxied = "1";
    img.src = `/img?u=${encodeURIComponent(img.dataset.orig)}`;
  }, true);

  new IntersectionObserver((ents) => { if (state.order !== "chat" && ents.some((x) => x.isIntersecting)) loadMore(); },
    { root: $("#main"), rootMargin: `0px 0px ${PREFETCH_PX}px 0px` }).observe($("#sentinel"));
  new IntersectionObserver((ents) => { if (state.order === "chat" && ents.some((x) => x.isIntersecting)) loadMore(); },
    { root: $("#main"), rootMargin: `${PREFETCH_PX}px 0px 0px 0px` }).observe($("#topSentinel"));
}

function updatePos() {
  const main = $("#main");
  const box = main.getBoundingClientRect();
  const el = document.elementFromPoint(box.left + box.width / 2, box.top + 30);
  const post = el && el.closest(".post");
  const info = $("#posInfo");
  if (!post || main.scrollTop < 40) { info.classList.add("hidden"); return; }
  const time = post.querySelector(".ptime");
  info.textContent = `当前 ${floorLabel(+post.dataset.lou)}${time ? " · " + time.textContent : ""}`;
  info.classList.remove("hidden");
}

function setMode() {
  $("#allBtn").classList.toggle("active", !state.authorid);
  $("#opBtn").classList.toggle("active", !!state.authorid);
}

(async function init() {
  const qs = new URLSearchParams(location.search);
  if (parseTid(qs.get("tid") || "")) state.tid = parseTid(qs.get("tid"));
  if (["asc", "desc", "chat"].includes(qs.get("order"))) state.order = qs.get("order");
  $$(".order").forEach((x) => x.classList.toggle("active", x.dataset.order === state.order));
  bind();
  try { state.smiles = await api("smiles", {}); } catch (e) { console.warn("表情表加载失败", e); }
  const range = qs.get("range");
  if (qs.get("op") === "1") {
    const last = await api("page", { tid: state.tid, page: "e" });
    state.authorid = last.authorid;
    setMode();
  }
  if (range) document.querySelector(`[data-range="${range}"]`)?.click();
  else startView();
})();
