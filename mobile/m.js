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

async function getJson(path) {
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
  rebuild();
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
  const d = st.data;
  const src = st.mode === "op" ? d.op_posts : d.posts;
  st.list = src.filter(inRange);
  if (st.order === "desc") st.list.reverse();
  $("#feed").innerHTML = "";
  renderMeta();
  if (!st.list.length) {
    $("#feed").innerHTML = '<div class="empty">这个范围内没有发言</div>';
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
  const scope = st.mode === "op" ? `楼主近 7 天 ${d.op_posts.length} 帖` : `最近 ${d.posts.length} 楼`;
  let note = "";
  const src = st.mode === "op" ? d.op_posts : d.posts;
  const span = src.length ? Math.floor(Date.now() / 1000) - src[0].ts : 0;
  const want = st.range === "today" ? 0 : Number(st.range);
  if (st.mode === "all" && want && span < want) {
    note = `<br><span class="stale">全部发言只同步了最近约 ${Math.max(1, Math.round(span / 3600))} 小时，看更长时间请切到「楼主」</span>`;
  }
  $("#meta").innerHTML = `共 <b>${d.rows_total}</b> 楼 · 显示${scope}中的 <b>${st.list.length}</b> 条 · `
    + `<span class="${stale ? "stale" : ""}">数据更新于 ${fmt(up)}（${ago(up)}）</span>${note}`;
}

function floorLabel(lou) {
  if (st.mode !== "op") return `#${lou}`;
  return lou === 0 ? "主楼" : `第${lou}帖`;
}

function postHtml(p) {
  const d = st.data;
  const u = d.users[p.authorid] || {};
  const name = u.name || `UID:${p.authorid}`;
  const isOp = p.authorid === d.authorid;
  const alter = (p.alterinfo || "").match(/\[E(\d{9,})/);
  return `<article class="post${isOp ? " op" : ""}">
    <div class="phead">
      <span class="uname">${esc(name)}</span>
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

// 切回前台时只在站点数据确实更新了才重载，避免打断阅读位置
async function reloadIfUpdated() {
  try {
    const idx = await getJson("data/index.json");
    if (!st.index || idx.updated !== st.index.updated) reload();
  } catch (e) { /* 离线时保持原样 */ }
}

function bind() {
  $("#threadSel").onchange = () => {
    st.tid = $("#threadSel").value;
    localStorage.setItem("m_tid", st.tid);
    loadThread().catch((e) => { $("#more").innerHTML = `<span class="err">加载失败：${esc(e.message)}</span>`; });
  };
  $("#reloadBtn").onclick = reload;
  const group = (attr, key) => $$(`[data-${attr}]`).forEach((b) => b.onclick = () => {
    st[key] = b.dataset[attr];
    $$(`[data-${attr}]`).forEach((x) => x.classList.toggle("on", x === b));
    if (st.data) rebuild();
  });
  group("mode", "mode");
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
  reload();
})();
