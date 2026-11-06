"use strict";
// 手机版：读取 GitHub Actions 定时生成的 data/*.json，纯静态展示

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const BATCH = 40;
const STALE_SEC = 40 * 60;

const st = {
  tid: localStorage.getItem("m_tid") || "",
  mode: "all",
  order: "desc",
  range: "0",
  index: null,
  data: null,
  list: [],
  shown: 0,
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
  $("#feed").innerHTML = "";
  $("#more").textContent = "加载中…";
  st.data = await getJson(`data/${st.tid}.json`);
  document.title = `${st.data.title} - NGA 阅读`;
  rebuild();
}

function inRange(p) {
  if (st.range === "0") return true;
  const now = Math.floor(Date.now() / 1000);
  if (st.range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return p.ts >= d / 1000;
  }
  return p.ts >= now - Number(st.range);
}

function rebuild() {
  const d = st.data;
  const src = st.mode === "op" ? d.op_posts : d.posts;
  st.list = src.filter(inRange);
  if (st.order === "desc") st.list = st.list.slice().reverse();
  st.shown = 0;
  $("#feed").innerHTML = "";
  renderMeta();
  if (!st.list.length) {
    $("#feed").innerHTML = '<div class="empty">这个范围内没有发言</div>';
    $("#more").textContent = "";
    return;
  }
  renderMore();
  window.scrollTo(0, 0);
}

function renderMeta() {
  const d = st.data;
  const up = st.index.updated;
  const stale = Date.now() / 1000 - up > STALE_SEC;
  const range = st.mode === "op" ? `楼主最近 ${d.op_posts.length} 帖` : `最近 ${d.posts.length} 楼`;
  $("#meta").innerHTML = `共 <b>${d.rows_total}</b> 楼 · 显示${range}中的 <b>${st.list.length}</b> 条 · `
    + `<span class="${stale ? "stale" : ""}">数据更新于 ${fmt(up)}（${ago(up)}）</span>`;
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

function renderMore() {
  const next = st.list.slice(st.shown, st.shown + BATCH);
  $("#feed").insertAdjacentHTML("beforeend", next.map(postHtml).join(""));
  st.shown += next.length;
  $("#more").textContent = st.shown < st.list.length ? "继续下滑加载更多" : "没有更多了（只同步最近的楼层，完整内容请到 NGA 查看）";
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
    if (ents.some((e) => e.isIntersecting) && st.data && st.shown < st.list.length) renderMore();
  }, { rootMargin: "800px 0px" }).observe($("#more"));

  window.addEventListener("scroll", () => $("#toTop").classList.toggle("hidden", window.scrollY < 600), { passive: true });
  $("#toTop").onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
  $("#feed").addEventListener("click", (e) => {
    const img = e.target.closest(".pimg");
    if (!img) return;
    $("#lightbox img").src = img.src;
    $("#lightbox").classList.remove("hidden");
  });
  $("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");
  // 从后台切回来时自动拉最新数据
  document.addEventListener("visibilitychange", () => { if (!document.hidden && st.data) reload(); });
}

(async function init() {
  bind();
  try {
    window.SMILES = await getJson("data/smiles.json");
  } catch (e) { /* 没有表情表时以文字显示 */ }
  reload();
})();
