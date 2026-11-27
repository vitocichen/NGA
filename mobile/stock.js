"use strict";
// 手机版 A 股行情。页面放在 GitHub Pages，行情由手机直接请求：
//   腾讯 qt.gtimg.cn / web.ifzq.gtimg.cn / smartbox.gtimg.cn —— <script> 标签加载（返回的是 JS 变量），不受跨域限制；
//   东方财富 push2 / push2ex / push2his —— JSONP（cb= 回调）。
// 数据整理成和电脑版后端 /api/vol/* 一样的结构，分钟轴与成交额同比用 volcore.js，一键判断用 judge.js（两端共用）。

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };

const FAST_MS = 3000, IDLE_FAST_MS = 60000, SLOW_MS = 60000, IDLE_SLOW_MS = 300000, MINUTE_MS = 30000;
const EM_UT = "7eea3edcaed734bea9cbfc24409ed989";
const BOARD_FS = { industry: "m:90+t:2", concept: "m:90+t:3" };
const BOARD_FID = { pct: "f3", vr: "f10", amt: "f6" };

// ---------- 取数据 ----------
function loadScript(src, charset) {
  return new Promise((ok, fail) => {
    const s = document.createElement("script");
    if (charset) s.charset = charset;
    s.src = src;
    const done = (e) => { clearTimeout(t); s.remove(); e ? fail(e) : ok(); };
    const t = setTimeout(() => done(new Error("请求超时")), 10000);
    s.onload = () => done();
    s.onerror = () => done(new Error("请求失败"));
    document.head.appendChild(s);
  });
}
let seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${seq++}`;

// 腾讯 appstock 接口支持 _var=变量名，返回「var 变量名 = {...}」
async function tencentVar(url) {
  const v = uid("jptx");
  await loadScript(`${url}${url.includes("?") ? "&" : "?"}_var=${v}`);
  const d = window[v];
  delete window[v];
  if (!d || !d.data) throw new Error("腾讯返回为空");
  return d.data;
}

// 东财 JSONP：回调在脚本执行时同步调用，onload 之后还没调用就是返回异常
function eastmoney(url) {
  return new Promise((ok, fail) => {
    const cb = uid("jpem");
    window[cb] = (d) => { delete window[cb]; ok(d); };
    loadScript(`${url}&cb=${cb}`).then(() => {
      if (window[cb]) { delete window[cb]; fail(new Error("东财返回异常")); }
    }, () => { delete window[cb]; fail(new Error("东财暂不可用（可能被限流）")); });
  });
}

const cache = { minutes: {}, kline: {} };

async function apiSnapshot(codes) {
  const items = {};
  for (let i = 0; i < codes.length; i += 60) {
    const part = codes.slice(i, i + 60);
    await loadScript(`https://qt.gtimg.cn/q=${part.join(",")}&_=${Date.now()}`, "gbk");
    for (const c of part) {
      const raw = window[`v_${c}`];
      if (!raw) continue;
      const p = raw.split("~");
      if (p.length < 38 || !p[1]) continue;
      let amount = p[35] && p[35].split("/").length >= 3 ? num(p[35].split("/")[2]) : null;
      if (amount == null && num(p[37]) != null) amount = num(p[37]) * 1e4;
      items[c] = {
        name: p[1], price: num(p[3]), prev: num(p[4]), open: num(p[5]), volume: (num(p[6]) || 0) * 100,
        change: num(p[31]), pct: num(p[32]), high: num(p[33]), low: num(p[34]), amount, time: p[30].slice(0, 14),
        turn: num(p[38]), amp: num(p[43]), vr: p.length > 49 ? num(p[49]) : null,
      };
    }
  }
  return { items, source: "tencent" };
}

// 连续竞价 240 根：09:31 → 0 … 11:30 → 119，13:01 → 120 … 15:00 → 239（与电脑版后端一致）
function minuteIndex(hhmm) {
  const t = +hhmm.slice(0, 2) * 60 + +hhmm.slice(2, 4);
  if (t >= 9 * 60 + 31 && t <= 11 * 60 + 30) return t - (9 * 60 + 31);
  if (t >= 13 * 60 + 1 && t <= 15 * 60) return 120 + t - (13 * 60 + 1);
  return null;
}
async function minutesOne(code) {
  const hit = cache.minutes[code];
  if (hit && Date.now() - hit.at < 20000) return hit.data;
  const days = (await tencentVar(`https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${code}`))[code].data.map((day) => {
    const out = { date: day.date, prevClose: num(day.prec), auction: null, cum: Array(240).fill(null), price: Array(240).fill(null) };
    for (const row of day.data) {
      const p = row.split(" ");
      if (p.length < 4) continue;
      const amt = num(p[3]);
      if (p[0] === "0930") out.auction = amt;
      const i = minuteIndex(p[0]);
      if (i != null && amt != null) { out.cum[i] = amt; out.price[i] = num(p[1]); }
    }
    return out;
  });
  const data = { days, source: "tencent" };
  cache.minutes[code] = { at: Date.now(), data };
  return data;
}
async function apiMinutes(codes) {
  const items = {}, errors = {};
  await Promise.all(codes.map((c) => minutesOne(c).then((d) => { items[c] = d; }, (e) => { errors[c] = e.message; })));
  return { items, errors };
}

async function apiKline(code, period = "day") {
  const key = `${code}:${period}`, hit = cache.kline[key];
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  const d = (await tencentVar(`https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${code},${period},,,180`))[code];
  const data = { items: (d[period] || []).filter((r) => r.length >= 6).map((r) => ({
    date: r[0], open: num(r[1]), close: num(r[2]), high: num(r[3]), low: num(r[4]), volume: (num(r[5]) || 0) * 100 })) };
  cache.kline[key] = { at: Date.now(), data };
  return data;
}

const SEARCH_TYPES = [["GP-A", "A股"], ["ZS", "指数"], ["ETF", "ETF"], ["LOF", "LOF"]];
async function apiSearch(q) {
  window.v_hint = "";
  await loadScript(`https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all&c=1`, "utf-8");
  const out = [];
  for (const item of (window.v_hint || "").split("^")) {
    const p = item.split("~");
    const kind = p.length >= 5 && (SEARCH_TYPES.find(([k]) => p[4].startsWith(k)) || [])[1];
    if (kind && (p[0] === "sh" || p[0] === "sz")) out.push({ code: p[0] + p[1], name: p[2], type: kind });
  }
  return out.slice(0, 10);
}
let boardDir = null;
async function boardSearch(q) {
  if (!boardDir) boardDir = (await (await fetch("boards_seed.json")).json()).items || [];
  const s = q.trim().toLowerCase();
  return boardDir.filter((b) => b.name.toLowerCase().includes(s) || b.py.startsWith(s) || b.code.toLowerCase() === s)
    .sort((a, b) => (a.name.startsWith(q) ? 0 : 1) - (b.name.startsWith(q) ? 0 : 1)).slice(0, 6)
    .map((b) => ({ code: b.code, name: b.name, type: `${b.type}板块`, board: true }));
}

// 市场概况：涨跌分布（push2ex）+ 主力净流入、昨日涨停表现（push2）+ 近 60 日日均成交（push2his，缓存半天）
async function apiOverview() {
  const [u, z] = await Promise.allSettled([
    eastmoney("https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.000001,0.399106,0.899050,90.BK0815&fields=f12,f3,f62"),
    eastmoney(`https://push2ex.eastmoney.com/getTopicZDFenBu?ut=${EM_UT}&dpt=wz.ztzt`),
  ]);
  if (u.status !== "fulfilled" && z.status !== "fulfilled") throw new Error(u.reason.message);
  const out = { at: Date.now() / 1000 };
  if (u.status === "fulfilled" && u.value.data) {
    const rows = Object.fromEntries(u.value.data.diff.map((r) => [r.f12, r]));
    out.main = ["000001", "399106", "899050"].reduce((s, c) => s + (typeof (rows[c] || {}).f62 === "number" ? rows[c].f62 : 0), 0);
    out.ztPerf = (rows.BK0815 || {}).f3;
  }
  if (z.status === "fulfilled" && z.value.data) {
    const counts = {};
    for (const item of z.value.data.fenbu) for (const [k, v] of Object.entries(item)) counts[+k] = v;
    const n = (keys) => keys.reduce((s, k) => s + (counts[k] || 0), 0);
    const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
    out.buckets = [n([11]), n(range(6, 11)), n(range(2, 6)), n([1]), n([0]), n([-1]), n(range(-5, -1)), n(range(-10, -5)), n([-11])];
    Object.assign(out, { up: n(range(1, 12)), flat: n([0]), down: n(range(-11, 0)), date: String(z.value.data.qdate || "") });
  }
  const avg = await apiAvg60().catch(() => null);
  if (avg) Object.assign(out, avg);
  return out;
}
async function apiAvg60() {
  const saved = JSON.parse(localStorage.getItem("stock_avg60") || "null");
  if (saved && Date.now() - saved.at < 6 * 3600 * 1000) return saved;
  const series = [];
  for (const secid of ["1.000001", "0.399106"]) {
    const d = await eastmoney(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=61&end=20500101&fields1=f1&fields2=f51,f57`);
    series.push(Object.fromEntries(d.data.klines.map((k) => [k.split(",")[0], +k.split(",")[1]])));
  }
  const today = new Date().toISOString().slice(0, 10);
  const hist = Object.keys(series[0]).filter((x) => x in series[1] && x < today).sort().slice(-60);
  const out = { avg60: hist.reduce((s, x) => s + series[0][x] + series[1][x], 0) / hist.length, avgDays: hist.length, at: Date.now() };
  localStorage.setItem("stock_avg60", JSON.stringify(out));
  return out;
}

async function apiBoards(type, sort) {
  const d = await eastmoney(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=60&po=1&np=1&fltt=2&invt=2&fid=${BOARD_FID[sort]}&fs=${BOARD_FS[type]}&fields=f3,f6,f10,f12,f14,f104,f105,f128,f136`);
  return { items: d.data.diff.map((r) => ({ code: r.f12, name: r.f14, pct: num(r.f3), amount: num(r.f6), vr: num(r.f10), up: r.f104, down: r.f105, lead: r.f128, leadPct: num(r.f136) })),
    total: d.data.total, at: Date.now() / 1000 };
}
async function apiBoardQuotes(codes) {
  const d = await eastmoney(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f3,f6,f10,f12,f14,f104,f105&secids=${codes.map((c) => "90." + c).join(",")}`);
  return Object.fromEntries(((d.data || {}).diff || []).map((r) => [r.f12, { name: r.f14, pct: num(r.f3), amount: num(r.f6), vr: num(r.f10), up: r.f104, down: r.f105, at: Date.now() / 1000 }]));
}
async function apiBoardStocks(code) {
  const d = await eastmoney(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=60&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:${code}&fields=f2,f3,f6,f12,f13,f14`);
  return d.data.diff.filter((r) => r.f13 === 0 || r.f13 === 1)
    .map((r) => ({ code: (r.f13 === 1 ? "sh" : "sz") + r.f12, name: r.f14, price: num(r.f2), pct: num(r.f3), amount: num(r.f6) }));
}

// judge.js 用的是电脑版的 /api/vol/* 接口，这里接到上面的实现
async function volApi(path, params) {
  if (path === "snapshot") return apiSnapshot(params.codes.split(","));
  if (path === "minutes") return apiMinutes(params.codes.split(","));
  if (path === "kline") return apiKline(params.code, params.period);
  throw new Error(`手机版不支持 ${path}`);
}

// ---------- 状态 ----------
function loadGroups() {
  try {
    const g = JSON.parse(localStorage.getItem("volGroups") || "null");
    if (Array.isArray(g) && g.length) return g;
  } catch (e) { /* 用默认 */ }
  return [{ name: "我的自选", items: [] }];
}
const vol = {
  groups: loadGroups(),
  gsel: +(localStorage.getItem("volGroupSel") || 0),
  page: localStorage.getItem("volPage") === "watch" ? "watch" : "market",
  boardType: localStorage.getItem("volBoardType") || "industry",
  boardSort: localStorage.getItem("volBoardSort") || "pct",
  watchSort: JSON.parse(localStorage.getItem("stock_watchSort") || '{"key":"","dir":-1}'),
  snap: {}, minutes: {}, minutesAt: 0,
  overview: null, boards: null, boardQuotes: {}, emError: "",
  detail: null, charts: {},
};
// 上次的东财数据先显示，避免打开时一片空白
try { Object.assign(vol, JSON.parse(localStorage.getItem("stock_cache") || "{}")); } catch (e) { /* 忽略 */ }
const saveCache = () => localStorage.setItem("stock_cache", JSON.stringify({ overview: vol.overview, boards: vol.boards, boardQuotes: vol.boardQuotes }));
const saveGroups = () => { localStorage.setItem("volGroups", JSON.stringify(vol.groups)); localStorage.setItem("volGroupSel", String(vol.gsel)); };
function volGroup() { if (vol.gsel >= vol.groups.length) vol.gsel = 0; return vol.groups[vol.gsel]; }
const volIsBoard = (it) => it.type === "board";
const groupHas = (code) => volGroup().items.some((x) => x.code === code);

function toast(msg, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
const ago = (at) => { if (!at) return ""; const d = new Date(at * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const isOld = (at) => at && Date.now() / 1000 - at > 180 && volIsTradingHours();

// ---------- 市场页 ----------
const BUCKETS = ["涨停", "涨停-5%", "5-1%", "1-0%", "平盘", "0-1%", "1-5%", "5%-跌停", "跌停"];
function renderOverview() {
  const o = vol.overview, m = volCompute(VOL_TOTAL);
  const ratio = m.ready ? m.ratio : null;
  const max = o && o.buckets ? Math.max(...o.buckets, 1) : 1;
  const bars = o && o.buckets ? o.buckets.map((v, i) => {
    const color = i < 4 ? "var(--up)" : i === 4 ? "var(--muted)" : "var(--down)";
    return `<div><b style="color:${color}">${v}</b><i style="height:${Math.max(2, (v / max) * 60)}px;background:${color}"></i><em>${BUCKETS[i]}</em></div>`;
  }).join("") : "";
  const avgRatio = o && o.avg60 && m.pred ? (m.pred / o.avg60 - 1) * 100 : null;
  $("#ovCard").innerHTML = `
    <div class="card-h"><b>市场概况</b><span class="muted">${o ? (isOld(o.at) ? `<span class="stale">东财暂未更新，显示 ${ago(o.at)} 的数据</span>` : `东财 ${ago(o.at)}`) : vol.emError ? `<span class="stale">${esc(vol.emError)}</span>` : "加载中…"}</span></div>
    <div class="ov-top">
      <div><span>涨跌分布</span><b><span class="up">${o && o.up != null ? o.up : "-"}</span>:${o && o.flat != null ? o.flat : "-"}:<span class="down">${o && o.down != null ? o.down : "-"}</span></b></div>
      <div><span>主力净流入</span><b class="${volCls(o && o.main)}">${o && o.main != null ? volSign(o.main / 1e8, 1) + "亿" : "-"}</b></div>
      <div><span>昨日涨停表现</span><b class="${volCls(o && o.ztPerf)}">${o && o.ztPerf != null ? volSign(o.ztPerf, 2) + "%" : "-"}</b></div>
    </div>
    ${bars ? `<div class="ov-bars">${bars}</div><div class="ov-ratio"><i class="u" style="flex:${o.up}"></i><i class="f" style="flex:${o.flat}"></i><i class="d" style="flex:${o.down}"></i></div>` : ""}
    <div class="ov-rows">
      <div><span>两市成交</span><b>${m.ready ? volAmt(m.amount) : "-"}</b></div>
      <div><span>比昨天同时</span><b class="${volCls(ratio)}">${ratio == null ? "-" : `${ratio >= 0 ? "放" : "缩"} ${volAmt(Math.abs(m.diff))}`}</b></div>
      <div><span>预测全天</span><b>${m.pred ? volAmt(m.pred) : "-"}</b></div>
      <div><span>近 60 日平均</span><b class="${volCls(avgRatio)}">${o && o.avg60 ? volAmt(o.avg60) : "-"}${avgRatio == null ? "" : ` ${volSign(avgRatio, 0)}%`}</b></div>
    </div>`;
}

function renderIndices() {
  $("#idxCard").innerHTML = VOL_INDICES.map((t) => {
    const s = vol.snap[t.codes[0]], m = volCompute(t);
    if (!s) return `<div class="idx"><div class="n">${t.name}</div><div class="p">-</div></div>`;
    return `<div class="idx"><div class="n">${t.name}${m.ready && m.ratio != null ? `<span class="vbadge ${m.ratio >= 0 ? "up" : "down"}">${m.ratio >= 0 ? "放量" : "缩量"}</span>` : ""}</div>
      <div class="p ${volCls(s.pct)}">${s.price.toFixed(2)} <small>${volSign(s.pct, 2)}%</small></div>
      <div class="s">成交 ${volAmt(m.ready ? m.amount : s.amount)} · 比昨天同时 ${m.ready && m.ratio != null ? volSign(m.ratio, 1) + "%" : "-"}</div></div>`;
  }).join("");
}

function chartOf(id) {
  const el = document.getElementById(id);
  if (!el || !window.echarts) return null;
  let c = vol.charts[id];
  if (c && c.getDom() !== el) { c.dispose(); c = null; }
  if (!c) c = vol.charts[id] = echarts.init(el);
  return c;
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function xAxis() {
  return { type: "category", data: Array.from({ length: 240 }, (_, i) => volLabel(i)), boundaryGap: false,
    axisLabel: { color: css("--muted"), interval: (i) => i === 0 || i === 60 || i === 120 || i === 180 || i === 239, formatter: (v, i) => (i === 120 ? "11:30/13:00" : i === 239 ? "15:00" : i === 0 ? "9:30" : v) },
    axisLine: { lineStyle: { color: css("--line") } } };
}
function renderRhythm() {
  const m = volCompute(VOL_TOTAL), c = chartOf("rhythmChart");
  if (!c || !m.ready) return;
  const r = m.series.rhythm;
  c.setOption({
    animation: false, grid: { left: 40, right: 10, top: 10, bottom: 24 },
    tooltip: { trigger: "axis", valueFormatter: (v) => (v == null ? "-" : v.toFixed(1) + "%") }, xAxis: xAxis(),
    yAxis: { type: "value", axisLabel: { color: css("--muted"), formatter: "{value}%" }, splitLine: { lineStyle: { color: css("--line") } } },
    series: [
      { type: "line", data: r.map((v) => (v == null ? null : Math.max(v, 0))), showSymbol: false, lineStyle: { width: 0 }, areaStyle: { color: css("--up"), opacity: .2 }, silent: true },
      { type: "line", data: r.map((v) => (v == null ? null : Math.min(v, 0))), showSymbol: false, lineStyle: { width: 0 }, areaStyle: { color: css("--down"), opacity: .2 }, silent: true },
      { type: "line", data: r, showSymbol: false, lineStyle: { width: 1.6, color: css("--ink") } },
    ],
  }, true);
}

function boardRow(b) {
  return `<div class="wrow" data-board="${esc(b.code)}" data-name="${esc(b.name)}"><span class="nm"><b>${esc(b.name)}</b><small>${esc(b.lead || "")} ${b.leadPct == null ? "" : volSign(b.leadPct, 1) + "%"}</small></span>
    <span class="${volCls(b.pct)}">${volSign(b.pct, 2)}%</span><span>${volAmt(b.amount)}</span><span>量比 ${b.vr == null ? "-" : b.vr.toFixed(2)}</span></div>`;
}
function renderBoards() {
  $$("#boardType button").forEach((b) => b.classList.toggle("on", b.dataset.v === vol.boardType));
  $$("#boardSort button").forEach((b) => b.classList.toggle("on", b.dataset.v === vol.boardSort));
  const b = vol.boards;
  const fit = b && b.type === vol.boardType && b.sort === vol.boardSort;
  $("#boardList").innerHTML = fit ? b.items.map(boardRow).join("") : `<div class="meta">${vol.emError ? esc(vol.emError) : "板块加载中…"}</div>`;
  $("#boardMeta").innerHTML = fit ? `共 ${b.total} 个，显示前 ${b.items.length} 个 · ${isOld(b.at) ? `<span class="stale">东财暂未更新，显示 ${ago(b.at)} 的数据</span>` : `更新于 ${ago(b.at)}`}` : "";
}

// ---------- 自选页 ----------
function stockRow(it) {
  const s = vol.snap[it.code] || {};
  const m = volCompute({ codes: [it.code] });
  const diff = m.ready ? m.diff : null;
  return { it, name: s.name || it.name || it.code, price: s.price, pct: s.pct, diff,
    html: () => `<div class="wrow" data-code="${esc(it.code)}"><span class="nm"><b>${esc(s.name || it.name || it.code)}</b><small>${it.code.slice(2)}</small></span>
      <span class="${volCls(s.pct)}">${s.price == null ? "-" : s.price < 10 ? s.price.toFixed(3) : s.price.toFixed(2)}</span>
      <span class="${volCls(s.pct)}">${s.pct == null ? "-" : volSign(s.pct, 2) + "%"}</span>
      <span class="${volCls(diff)}">${diff == null ? "-" : `${diff >= 0 ? "放" : "缩"} ${volAmt(Math.abs(diff))}`}</span></div>` };
}
function boardWatchRow(it) {
  const q = vol.boardQuotes[it.code] || {};
  return { it, name: q.name || it.name, price: null, pct: q.pct, diff: null,
    html: () => `<div class="wrow" data-board="${esc(it.code)}" data-name="${esc(q.name || it.name)}"><span class="nm"><b>${esc(q.name || it.name)}</b><small>板块</small></span>
      <span>${q.amount == null ? "-" : volAmt(q.amount)}</span><span class="${volCls(q.pct)}">${q.pct == null ? "-" : volSign(q.pct, 2) + "%"}</span>
      <span>${q.up == null ? "-" : `<span class="up">${q.up}</span>/<span class="down">${q.down}</span>`}</span></div>` };
}
function renderWatch() {
  $("#groupChips").innerHTML = vol.groups.map((g, i) => `<button data-g="${i}" class="${i === vol.gsel ? "on" : ""}">${esc(g.name)} ${g.items.length}</button>`).join("")
    + '<button data-g="new">＋</button>';
  const g = volGroup();
  let rows = g.items.map((it) => (volIsBoard(it) ? boardWatchRow(it) : stockRow(it)));
  const { key, dir } = vol.watchSort;
  if (key) rows = rows.slice().sort((a, b) => (key === "name" ? a.name.localeCompare(b.name) * dir : ((a[key] ?? -1e18) - (b[key] ?? -1e18)) * dir));
  $$("#watchHead span").forEach((s) => { s.classList.toggle("on", s.dataset.sort === key); s.textContent = s.textContent.replace(/[▲▼]$/, "") + (s.dataset.sort === key ? (dir > 0 ? "▲" : "▼") : ""); });
  $("#watchList").innerHTML = rows.map((r) => r.html()).join("") || '<div class="meta">这个分组还没有股票，用上面的搜索框添加</div>';
  const t = Object.values(vol.snap).map((x) => x.time).filter(Boolean).sort().pop();
  $("#watchMeta").textContent = g.items.length ? `${g.items.filter((x) => !volIsBoard(x)).length} 只股票 · ${g.items.filter(volIsBoard).length} 个板块 · 点表头排序，点股票看分时和 K 线` : "";
  if (t) $("#updTime").textContent = `行情 ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`;
}

function render() {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.page === vol.page));
  $("#pageMarket").classList.toggle("hidden", vol.page !== "market");
  $("#pageWatch").classList.toggle("hidden", vol.page !== "watch");
  const t = Object.values(vol.snap).map((x) => x.time).filter(Boolean).sort().pop();
  if (t) $("#updTime").textContent = `行情 ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`;
  if (vol.page === "market") { renderOverview(); renderIndices(); renderRhythm(); renderBoards(); }
  else renderWatch();
  if (vol.detail) renderDetail();
}

// ---------- 详情（底部弹层） ----------
function openDetail(d) {
  vol.detail = { view: "min", ...d };
  $("#sheet").classList.remove("hidden");
  renderDetail(true);
  if (d.type === "board") loadBoardDetail();
  else { minutesOne(d.code).then((m) => { vol.minutes[d.code] = m; renderDetail(); }).catch(() => {}); }
}
function closeDetail() {
  vol.detail = null;
  $("#sheet").classList.add("hidden");
  if (vol.charts.detailChart) { vol.charts.detailChart.dispose(); delete vol.charts.detailChart; }
}
async function loadBoardDetail() {
  const d = vol.detail;
  try { d.stocks = await apiBoardStocks(d.code); } catch (e) { d.err = e.message; }
  if (vol.detail === d) renderDetail(true);
}
function renderDetail(full) {
  const d = vol.detail;
  if (!d) return;
  $("#sheetStar").textContent = groupHas(d.code) ? "移出自选" : "＋自选";
  if (d.type === "board") {
    const q = vol.boardQuotes[d.code] || (vol.boards && vol.boards.items.find((x) => x.code === d.code)) || {};
    $("#sheetTitle").innerHTML = `${esc(d.name)}<small>板块 ${q.pct == null ? "" : `<span class="${volCls(q.pct)}">${volSign(q.pct, 2)}%</span>`}</small>`;
    if (!full) return;
    $("#sheetBody").innerHTML = d.err ? `<div class="meta">${esc(d.err)}</div>` : !d.stocks ? '<div class="meta">成分股加载中…</div>'
      : `<div class="meta">成分股按涨幅排序（前 ${d.stocks.length} 只），点开看个股</div>${d.stocks.map((s) => `<div class="wrow" data-code="${esc(s.code)}"><span class="nm"><b>${esc(s.name)}</b><small>${s.code.slice(2)}</small></span>
        <span class="${volCls(s.pct)}">${s.price == null ? "-" : s.price.toFixed(2)}</span><span class="${volCls(s.pct)}">${volSign(s.pct, 2)}%</span><span>${volAmt(s.amount)}</span></div>`).join("")}`;
    return;
  }
  const s = vol.snap[d.code] || {};
  const m = volCompute({ codes: [d.code] });
  $("#sheetTitle").innerHTML = `${esc(s.name || d.name || d.code)}<small>${d.code.slice(2)}</small>`;
  if (full || !$("#detailChart")) {
    $("#sheetBody").innerHTML = `<div class="dt-price"><b id="dtPrice"></b><span id="dtPct"></span></div>
      <div class="dt-grid" id="dtGrid"></div><div class="dt-line" id="dtLine"></div>
      <div class="seg dt-tabs" id="dtTabs"><button data-v="min">分时</button><button data-v="day">日K</button><button data-v="week">周K</button></div>
      <div id="detailChart" class="chart" style="height:260px"></div>`;
    $$("#dtTabs button").forEach((b) => b.onclick = () => { d.view = b.dataset.v; renderDetail(); });
  }
  $$("#dtTabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === d.view));
  $("#dtPrice").className = volCls(s.pct);
  $("#dtPrice").textContent = s.price == null ? "-" : s.price.toFixed(s.price < 10 ? 3 : 2);
  $("#dtPct").innerHTML = s.pct == null ? "" : `<span class="${volCls(s.pct)}">${volSign(s.change, 2)}　${volSign(s.pct, 2)}%</span>`;
  $("#dtGrid").innerHTML = [["今开", volPx(s.open)], ["最高", volPx(s.high)], ["最低", volPx(s.low)], ["昨收", volPx(s.prev)], ["成交额", volAmt(s.amount)], ["量比", s.vr == null ? "-" : s.vr.toFixed(2)],
    ["换手", s.turn == null ? "-" : s.turn + "%"], ["振幅", s.amp == null ? "-" : s.amp + "%"], ["时间", s.time ? `${s.time.slice(8, 10)}:${s.time.slice(10, 12)}` : "-"]]
    .map(([k, v]) => `<div><span>${k}</span> ${v}</div>`).join("");
  $("#dtLine").innerHTML = m.ready && m.ratio != null ? `成交比昨天同一时间 <b class="${volCls(m.ratio)}">${m.ratio >= 0 ? "多" : "少"} ${Math.abs(m.ratio).toFixed(1)}%</b>${m.pred ? `，预计全天 ${volAmt(m.pred)}（昨天 ${volAmt(m.prevFull)}）` : ""}` : "";
  if (d.view === "min") return drawMinute(m, s);
  const key = `${d.code}:${d.view}`;
  if (cache.kline[key]) return drawKline(cache.kline[key].data.items);
  apiKline(d.code, d.view).then((k) => { if (vol.detail === d && d.view !== "min") drawKline(k.items); }).catch((e) => toast(`K 线获取失败：${e.message}`));
}
function drawMinute(m, s) {
  const c = chartOf("detailChart");
  if (!c || !m.ready) return;
  const prev = m.series.prevClose || s.prev;
  c.setOption({
    animation: false, grid: [{ left: 46, right: 10, top: 10, height: "62%" }, { left: 46, right: 10, top: "78%", bottom: 22 }],
    tooltip: { trigger: "axis" },
    xAxis: [{ ...xAxis(), gridIndex: 0, axisLabel: { show: false } }, { ...xAxis(), gridIndex: 1 }],
    yAxis: [{ type: "value", scale: true, gridIndex: 0, axisLabel: { color: css("--muted") }, splitLine: { lineStyle: { color: css("--line") } } },
      { type: "value", gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } }],
    series: [
      { type: "line", data: m.series.price, showSymbol: false, lineStyle: { width: 1.4, color: css("--link") || "#3d8fd1" },
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: css("--muted"), type: "dashed" }, data: [{ yAxis: prev }] } },
      { type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: m.series.todayBar, itemStyle: { color: css("--muted") } },
    ],
  }, true);
}
function drawKline(items) {
  const c = chartOf("detailChart");
  if (!c) return;
  const rows = items.slice(-90);
  const ma = (n) => rows.map((_, i) => (i < n - 1 ? null : +(rows.slice(i - n + 1, i + 1).reduce((s, r) => s + r.close, 0) / n).toFixed(2)));
  c.setOption({
    animation: false, grid: [{ left: 46, right: 10, top: 10, height: "62%" }, { left: 46, right: 10, top: "78%", bottom: 22 }],
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    xAxis: [{ type: "category", data: rows.map((r) => r.date.slice(5)), gridIndex: 0, axisLabel: { show: false } },
      { type: "category", data: rows.map((r) => r.date.slice(5)), gridIndex: 1, axisLabel: { color: css("--muted") } }],
    yAxis: [{ type: "value", scale: true, gridIndex: 0, axisLabel: { color: css("--muted") }, splitLine: { lineStyle: { color: css("--line") } } },
      { type: "value", gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } }],
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], start: 40, end: 100 }],
    series: [
      { type: "candlestick", data: rows.map((r) => [r.open, r.close, r.low, r.high]),
        itemStyle: { color: css("--up"), color0: css("--down"), borderColor: css("--up"), borderColor0: css("--down") } },
      { type: "line", data: ma(5), showSymbol: false, lineStyle: { width: 1 } },
      { type: "line", data: ma(20), showSymbol: false, lineStyle: { width: 1 } },
      { type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: rows.map((r, i) => ({ value: r.volume, itemStyle: { color: r.close >= (rows[i - 1] || r).close ? css("--up") : css("--down") } })) },
    ],
  }, true);
}

// ---------- 轮询 ----------
const groupCodes = () => volGroup().items.filter((x) => !volIsBoard(x)).map((x) => x.code);
function minuteCodes() {
  const codes = [...VOL_TOTAL.codes];
  if (vol.page === "market") codes.push(...VOL_INDICES.flatMap((t) => t.codes));
  else codes.push(...groupCodes());
  if (vol.detail && vol.detail.type !== "board") codes.push(vol.detail.code);
  return [...new Set(codes)];
}
let fastTimer = null, slowTimer = null, fastBusy = false, slowBusy = false;
async function fastTick() {
  if (fastBusy) return;
  fastBusy = true;
  clearTimeout(fastTimer);
  try {
    const codes = [...new Set([...minuteCodes(), ...VOL_INDICES.flatMap((t) => t.codes), ...groupCodes()])];
    const snap = await apiSnapshot(codes);
    vol.snap = { ...vol.snap, ...snap.items };
    let dirty = false;
    for (const g of vol.groups) for (const it of g.items) if (!volIsBoard(it) && !it.name && vol.snap[it.code]) { it.name = vol.snap[it.code].name; dirty = true; }
    if (dirty) saveGroups();
    const need = minuteCodes();
    if (need.some((c) => !vol.minutes[c]) || Date.now() - vol.minutesAt > MINUTE_MS) {
      const m = await apiMinutes(need);
      Object.assign(vol.minutes, m.items);
      vol.minutesAt = Date.now();
    }
  } catch (e) {
    $("#updTime").textContent = `行情获取失败：${e.message}`;
  } finally {
    fastBusy = false;
  }
  render();
  fastTimer = setTimeout(fastTick, document.hidden ? IDLE_FAST_MS : volIsTradingHours() ? FAST_MS : IDLE_FAST_MS);
}
async function slowTick() {
  if (slowBusy) return;
  slowBusy = true;
  clearTimeout(slowTimer);
  const errs = [];
  const jobs = [];
  if (vol.page === "market") {
    jobs.push(apiOverview().then((o) => { vol.overview = { ...(vol.overview || {}), ...o }; }, (e) => errs.push(e.message)));
    const type = vol.boardType, sort = vol.boardSort;
    jobs.push(apiBoards(type, sort).then((b) => { vol.boards = { ...b, type, sort }; }, (e) => errs.push(e.message)));
  }
  const boards = volGroup().items.filter(volIsBoard).map((x) => x.code);
  if (vol.page === "watch" && boards.length) jobs.push(apiBoardQuotes(boards).then((q) => Object.assign(vol.boardQuotes, q), (e) => errs.push(e.message)));
  await Promise.all(jobs);
  vol.emError = errs.length ? `东财：${errs[0]}` : "";
  saveCache();
  slowBusy = false;
  render();
  slowTimer = setTimeout(slowTick, volIsTradingHours() ? SLOW_MS : IDLE_SLOW_MS);
}
function refreshAll() { fastTick(); slowTick(); }

// ---------- 交互 ----------
function setPage(p) {
  vol.page = p;
  localStorage.setItem("volPage", p);
  render();
  refreshAll();
}
function addItem(item) {
  const g = volGroup();
  if (g.items.some((x) => x.code === item.code)) return toast("已经在这个分组里了");
  g.items.push(item.board ? { type: "board", code: item.code, name: item.name } : { type: "stock", code: item.code, name: item.name });
  saveGroups();
  toast(`已加入「${g.name}」`);
  refreshAll();
}
function toggleStar(d) {
  const g = volGroup();
  if (groupHas(d.code)) { g.items = g.items.filter((x) => x.code !== d.code); toast(`已从「${g.name}」移出`); }
  else { g.items.push(d.type === "board" ? { type: "board", code: d.code, name: d.name } : { type: "stock", code: d.code, name: d.name || "" }); toast(`已加入「${g.name}」`); }
  saveGroups();
  render();
}

function bindSearch() {
  const box = $("#searchResults");
  let timer = null, lastQ = "";
  $("#searchInput").addEventListener("input", () => {
    clearTimeout(timer);
    const q = $("#searchInput").value.trim();
    if (!q) { box.classList.add("hidden"); return; }
    timer = setTimeout(async () => {
      lastQ = q;
      const [a, b] = await Promise.all([apiSearch(q).catch(() => []), boardSearch(q).catch(() => [])]);
      if (q !== lastQ) return;
      const items = [...a, ...b];
      box.innerHTML = items.length ? items.map((x, i) => `<div data-i="${i}"><span><b>${esc(x.name)}</b> <small>${esc(x.code)} · ${esc(x.type)}</small></span><button class="small">${groupHas(x.code) ? "已添加" : "＋添加"}</button></div>`).join("")
        : '<div><span class="muted">没有找到</span></div>';
      box.classList.remove("hidden");
      box.onclick = (e) => {
        const row = e.target.closest("[data-i]");
        if (!row) return;
        const it = items[+row.dataset.i];
        if (e.target.closest("button")) { addItem(it); box.classList.add("hidden"); $("#searchInput").value = ""; }
        else openDetail(it.board ? { type: "board", code: it.code, name: it.name } : { type: "stock", code: it.code, name: it.name });
      };
    }, 300);
  });
}

function bind() {
  $$(".tabs button").forEach((b) => b.onclick = () => setPage(b.dataset.page));
  $$("#boardType button").forEach((b) => b.onclick = () => { vol.boardType = b.dataset.v; localStorage.setItem("volBoardType", vol.boardType); renderBoards(); slowTick(); });
  $$("#boardSort button").forEach((b) => b.onclick = () => { vol.boardSort = b.dataset.v; localStorage.setItem("volBoardSort", vol.boardSort); renderBoards(); slowTick(); });
  $("#groupChips").onclick = (e) => {
    const b = e.target.closest("[data-g]");
    if (!b) return;
    if (b.dataset.g === "new") return $("#groupNew").click();
    vol.gsel = +b.dataset.g;
    saveGroups();
    render();
    refreshAll();
  };
  $("#watchHead").onclick = (e) => {
    const s = e.target.closest("[data-sort]");
    if (!s) return;
    const k = s.dataset.sort, cur = vol.watchSort;
    vol.watchSort = cur.key !== k ? { key: k, dir: -1 } : cur.dir < 0 ? { key: k, dir: 1 } : { key: "", dir: -1 };
    localStorage.setItem("stock_watchSort", JSON.stringify(vol.watchSort));
    renderWatch();
  };
  document.addEventListener("click", (e) => {
    const row = e.target.closest(".wrow[data-code], .wrow[data-board]");
    if (!row || row.closest(".whead")) return;
    if (row.dataset.board) openDetail({ type: "board", code: row.dataset.board, name: row.dataset.name });
    else openDetail({ type: "stock", code: row.dataset.code, name: "" });
  });
  $("#sheetClose").onclick = closeDetail;
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeDetail(); });
  $("#sheetStar").onclick = () => vol.detail && toggleStar(vol.detail);
  bindSearch();

  $("#menuBtn").onclick = () => $("#menuPanel").classList.remove("hidden");
  $("#menuClose").onclick = () => $("#menuPanel").classList.add("hidden");
  $("#menuPanel").addEventListener("click", (e) => { if (e.target.id === "menuPanel") $("#menuPanel").classList.add("hidden"); });
  $("#themeSel").value = document.documentElement.dataset.theme;
  $("#themeSel").onchange = () => {
    document.documentElement.dataset.theme = $("#themeSel").value;
    localStorage.setItem("stock_theme", $("#themeSel").value);
    Object.values(vol.charts).forEach((c) => c.dispose());
    vol.charts = {};
    render();
  };
  $("#groupNew").onclick = () => {
    const name = (prompt("新分组名称") || "").trim();
    if (!name) return;
    vol.groups.push({ name, items: [] });
    vol.gsel = vol.groups.length - 1;
    saveGroups();
    setPage("watch");
  };
  $("#groupRename").onclick = () => {
    const g = volGroup(), name = (prompt("分组改名", g.name) || "").trim();
    if (name) { g.name = name; saveGroups(); render(); }
  };
  $("#groupDelete").onclick = () => {
    if (vol.groups.length <= 1) return toast("至少保留一个分组");
    const g = volGroup();
    if (!confirm(`删除分组「${g.name}」（${g.items.length} 项）？`)) return;
    vol.groups.splice(vol.gsel, 1);
    vol.gsel = 0;
    saveGroups();
    render();
  };
  $("#exportBtn").onclick = async () => {
    const text = JSON.stringify(vol.groups);
    try { await navigator.clipboard.writeText(text); toast("已复制到剪贴板"); } catch (e) { prompt("复制下面这段文字保存：", text); }
  };
  $("#importBtn").onclick = () => {
    const text = prompt("粘贴之前导出的自选文字（会覆盖当前全部分组）：");
    if (!text) return;
    try {
      const g = JSON.parse(text);
      if (!Array.isArray(g) || !g.every((x) => x.name && Array.isArray(x.items))) throw new Error("格式不对");
      vol.groups = g;
      vol.gsel = 0;
      saveGroups();
      toast(`已导入 ${g.length} 个分组`);
      render();
      refreshAll();
    } catch (e) { toast(`导入失败：${e.message}`); }
  };
  window.addEventListener("resize", () => Object.values(vol.charts).forEach((c) => c.resize()));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });
}

bind();
render();
refreshAll();
