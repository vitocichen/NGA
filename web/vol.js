"use strict";
// A 股行情：市场概况（放量/缩量、涨跌分布、主力净流入）、指数、今天的成交节奏、板块、自选分组、个股。
// 成交额同比与全天预测的算法参考 ashare-volpulse（MIT，https://github.com/LostMoonkin/ashare-volpulse）。

const VOL_TOTAL = { key: "TOTAL", name: "沪深两市", codes: ["sh000001", "sz399106"], priceCode: "sh000001" };
const VOL_INDICES = [
  { key: "sh000001", name: "上证指数", codes: ["sh000001"] },
  { key: "sz399001", name: "深证成指", codes: ["sz399001"] },
  { key: "sz399006", name: "创业板指", codes: ["sz399006"] },
  { key: "sh000680", name: "科创综指", codes: ["sh000680"] },
];
const VOL_LAMBDA = 0.12;
const VOL_FAST_MS = 3000;
const VOL_SLOW_MS = 60000;
const VOL_IDLE_FAST_MS = 60000;
const VOL_IDLE_SLOW_MS = 300000;
const VOL_MINUTE_REFRESH_MS = 30000;
const VOL_BUCKETS = ["涨停", "涨停-5%", "5-1%", "1-0%", "平盘", "0-1%", "1-5%", "5%-跌停", "跌停"];

function volLoadGroups() {
  try {
    const g = JSON.parse(localStorage.getItem("volGroups") || "null");
    if (Array.isArray(g) && g.length) return g;
  } catch (e) { /* 用默认 */ }
  let old = [];
  try { old = JSON.parse(localStorage.getItem("volWatch") || "[]"); } catch (e) { old = []; }
  return [{ name: "我的自选", items: old.map((w) => ({ code: w.code, name: w.name || "" })) }];
}

const vol = {
  active: false,
  groups: volLoadGroups(),
  gsel: +(localStorage.getItem("volGroupSel") || 0),
  boardType: localStorage.getItem("volBoardType") || "industry",
  boardSort: localStorage.getItem("volBoardSort") || "pct",
  snap: {},
  minutes: {},
  minutesAt: 0,
  minuteIdx: null,
  overview: null,
  boards: null,
  drawer: null,      // { type: "stock", code, name, fromBoard } | { type: "board", code, name, data }
  fastTimer: null,
  slowTimer: null,
  fastBusy: false,
  slowBusy: false,
  updatedAt: 0,
  slowAt: 0,
  source: "",
  error: "",
  slowError: "",
  boardQuotes: {},
  boardTrends: {},
  watchSort: (() => { try { return JSON.parse(localStorage.getItem("volWatchSort")) || { key: "", dir: -1 }; } catch (e) { return { key: "", dir: -1 }; } })(),
  klines: {},
  chart: null,
  miniCharts: {},
  page: localStorage.getItem("volPage") === "watch" ? "watch" : "market",
  panels: {
    drawer: { state: null, title: "#volDrawerTitle", body: "#volDrawerBody", back: "#volDrawerBack", chartId: "volDrawerChart", chart: null },
    watch: { state: null, title: "#volDetailTitle", body: "#volDetailBody", back: "#volDetailBack", remove: "#volDetailRemove", chartId: "volDetailChart", chart: null },
  },
};

// ---------- 时间与分钟轴 ----------
// 连续竞价 240 根：09:30:xx → 0（上游标签 09:31）… 11:29:xx → 119，13:00:xx → 120 … 14:59:xx → 239
function volClock(stamp) {
  const hh = +stamp.slice(8, 10), mm = +stamp.slice(10, 12), ss = +stamp.slice(12, 14);
  const t = hh * 60 + mm;
  const date = stamp.slice(0, 8);
  if (t < 9 * 60 + 15) return { date, phase: "pre", idx: -1, sec: 0 };
  if (t < 9 * 60 + 30) return { date, phase: "auction", idx: -1, sec: 0 };
  if (t < 11 * 60 + 30) return { date, phase: "trading", idx: t - (9 * 60 + 30), sec: ss };
  if (t < 13 * 60) return { date, phase: "noon", idx: 119, sec: 60 };
  if (t < 15 * 60) return { date, phase: "trading", idx: 120 + t - 13 * 60, sec: ss };
  return { date, phase: "closed", idx: 239, sec: 60 };
}
function volLabel(i) {
  const t = i < 120 ? 9 * 60 + 31 + i : 13 * 60 + 1 + (i - 120);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
const volDateText = (d) => (d ? `${d.slice(4, 6)}-${d.slice(6, 8)}` : "-");
const volHm = (stamp) => (stamp ? `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}` : "--:--");
function volTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
function volIsTradingHours() {
  const d = new Date(), day = d.getDay(), t = d.getHours() * 60 + d.getMinutes();
  return day >= 1 && day <= 5 && ((t >= 9 * 60 + 14 && t <= 11 * 60 + 31) || (t >= 12 * 60 + 59 && t <= 15 * 60 + 2));
}

// ---------- 成交额同比计算 ----------
// 多个代码逐日逐分钟相加（两市总成交 = 上证 + 深证综指），只保留各代码都有的日期和分钟
function volMergeDays(codes, priceCode) {
  const lists = codes.map((c) => vol.minutes[c] && vol.minutes[c].days);
  if (lists.some((l) => !l || !l.length)) return null;
  if (lists.length === 1) return lists[0];
  const priceDays = (vol.minutes[priceCode || codes[0]] || {}).days || lists[0];
  return lists[0].filter((d) => lists.every((l) => l.some((x) => x.date === d.date))).map((d) => {
    const parts = lists.map((l) => l.find((x) => x.date === d.date));
    const cum = d.cum.map((_, i) => (parts.every((p) => p.cum[i] != null) ? parts.reduce((s, p) => s + p.cum[i], 0) : null));
    const auctions = parts.map((p) => p.auction);
    const pd = priceDays.find((x) => x.date === d.date) || d;
    return { date: d.date, cum, price: pd.price, prevClose: pd.prevClose,
      auction: auctions.every((a) => a != null) ? auctions.reduce((s, a) => s + a, 0) : null };
  });
}

function volSnapOf(t) {
  const items = t.codes.map((c) => vol.snap[c]).filter(Boolean);
  if (items.length !== t.codes.length) return null;
  const main = vol.snap[t.priceCode || t.codes[0]];
  const amounts = items.map((x) => x.amount);
  return { ...main, amount: amounts.every((a) => a != null) ? amounts.reduce((s, a) => s + a, 0) : null,
    time: items.map((x) => x.time).sort().pop() };
}

function volProfile(hist) {
  const full = hist.filter((d) => d.cum.every((v) => v != null) && d.cum[239] > 0);
  if (!full.length) return null;
  const avgFull = full.reduce((s, d) => s + d.cum[239], 0) / full.length;
  const shares = Array.from({ length: 240 }, (_, i) => full.reduce((s, d) => s + d.cum[i] / d.cum[239], 0) / full.length);
  const withAuction = full.filter((d) => d.auction != null);
  const auctionShare = withAuction.length ? withAuction.reduce((s, d) => s + d.auction / d.cum[239], 0) / withAuction.length : 0;
  return { days: full.length, avgFull, shares, auctionShare };
}

// 盘中未闭合分钟按已过秒数插值：X(t-1) + s/60 × (X(t) − X(t-1))，X(-1) 取 09:25 竞价
function volAligned(series, base, idx, sec) {
  if (idx < 0) return base;
  const cur = series[idx], before = idx === 0 ? base : series[idx - 1];
  if (cur == null || before == null) return null;
  return before + (sec / 60) * (cur - before);
}

function volCompute(t) {
  const snap = volSnapOf(t);
  const days = volMergeDays(t.codes, t.priceCode);
  if (!snap || !days || !snap.time) return { snap, ready: false };
  let clock = volClock(snap.time);
  // 盘前和 09:25 之前今天还没有成交，与其显示「-100% 缩量」，不如展示上一交易日的完整复盘
  const review = (clock.phase === "pre" || clock.phase === "auction") && !(snap.amount > 0) && days[0].date !== clock.date;
  if (review) clock = { date: days[0].date, phase: "closed", idx: 239, sec: 60, review: true };
  let today, prev, hist;
  if (days[0].date === clock.date) [today, prev, hist] = [days[0], days[1], days.slice(1)];
  else [today, prev, hist] = [{ date: clock.date, cum: Array(240).fill(null), price: Array(240).fill(null), auction: null, prevClose: snap.prev }, days[0], days];
  if (!prev) return { snap, ready: false };

  const idx = clock.idx, sec = clock.sec;
  const todayCum = today.cum.slice();
  const price = today.price.slice();
  if (idx >= 0 && snap.amount != null && !review) {
    todayCum[idx] = snap.amount;
    if (snap.price != null) price[idx] = snap.price;
  }
  const amount = review ? today.cum[239] : snap.amount;
  const prevAligned = volAligned(prev.cum, prev.auction, idx, sec);
  const diff = amount != null && prevAligned != null ? amount - prevAligned : null;
  const ratio = diff != null && prevAligned > 0 ? (diff / prevAligned) * 100 : null;

  // 全天预测：多日分时占比模板 + 剩余时段贝叶斯收缩，Â = A + (α·r + 1 − α) · Ā · (1 − w)，α = w / (w + λ)
  let pred = null;
  const prof = volProfile(hist) || volProfile([prev]);
  if (prof && amount != null && idx >= 0) {
    const w = volAligned(prof.shares, prof.auctionShare, idx, sec);
    if (w != null && w > 0) {
      const r = amount / (prof.avgFull * w);
      const alpha = w / (w + VOL_LAMBDA);
      pred = amount + (alpha * r + 1 - alpha) * prof.avgFull * Math.max(0, 1 - w);
    }
  }
  const rhythm = todayCum.map((v, i) => (i <= idx && v != null && prev.cum[i] > 0 ? ((v - prev.cum[i]) / prev.cum[i]) * 100 : null));
  const bar = (cum, auction, i) => (cum[i] == null ? null : cum[i] - (i === 0 ? auction || 0 : cum[i - 1] == null ? cum[i] : cum[i - 1]));
  return {
    ready: true, snap, clock, today, prev, idx, amount, prevAligned, diff, ratio, pred, prevFull: prev.cum[239],
    series: {
      rhythm,
      todayCum: todayCum.map((v, i) => (i <= idx ? v : null)),
      prevCum: prev.cum,
      price: price.map((v, i) => (i <= idx ? v : null)),
      todayBar: todayCum.map((_, i) => (i <= idx ? bar(todayCum, today.auction, i) : null)),
      prevClose: today.prevClose || snap.prev,
    },
  };
}

// ---------- 更新时间 ----------
// at 是秒级时间戳。超过 3 分钟没更新就明确写「东财暂未更新，显示 xx:xx 的数据」，别让人以为是实时的
const VOL_OLD_SEC = 180;
function volTimeText(at, label = "更新于") {
  if (!at) return "";
  const d = new Date(at * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = sameDay ? `${hm}:${pad(d.getSeconds())}` : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
  if (Date.now() / 1000 - at > VOL_OLD_SEC && volIsTradingHours()) return `<span class="vold">东财暂未更新，显示 ${sameDay ? hm : when} 的数据</span>`;
  return `${label} ${when}`;
}
// 腾讯快照的行情时间（yyyyMMddHHmmss）
function volSnapTime() {
  const t = Object.values(vol.snap).map((x) => x.time).filter(Boolean).sort().pop();
  return t ? `行情 ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}` : "";
}

// ---------- 格式化 ----------
const volAmt = (v) => (v == null ? "-" : Math.abs(v) >= 1e12 ? (v / 1e12).toFixed(2) + " 万亿" : (v / 1e8).toFixed(Math.abs(v) >= 1e10 ? 0 : Math.abs(v) >= 1e9 ? 1 : 2) + " 亿");
const volSign = (v, d = 1) => (v == null ? "-" : (v > 0 ? "+" : "") + v.toFixed(d));
const volCls = (v) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
const volPx = (v) => (v == null ? "-" : v.toFixed(2));
function volVrTag(vr) {
  if (vr == null) return "";
  return vr >= 1.2 ? '<span class="vbadge up">放量</span>' : vr <= 0.8 ? '<span class="vbadge down">缩量</span>' : '<span class="vbadge">正常</span>';
}
function volDiffTag(ratio) {
  if (ratio == null) return "";
  return ratio >= 0 ? '<span class="vbadge up">放量</span>' : '<span class="vbadge down">缩量</span>';
}

// ---------- 市场概况 ----------
function volRenderOverview(m) {
  const o = vol.overview;
  const box = $("#volOverview");
  if (!m.ready && !o) { box.innerHTML = `<div class="vov-empty">${esc(vol.error || "正在获取行情…")}</div>`; return; }
  const ratio = m.ready ? m.ratio : null;
  const predVsAvg = m.pred && o && o.avg60 ? (m.pred / o.avg60 - 1) * 100 : null;
  const stamp = m.ready ? m.snap.time : "";
  const atText = !m.ready ? "" : m.clock.review ? `${volDateText(m.today.date)} 全天复盘` : m.clock.phase === "closed" ? "今日收盘" : m.clock.phase === "noon" ? "午间休市" : `${volHm(stamp)}`;
  let dist = '<div class="vov-empty">涨跌分布加载中…</div>';
  if (o && o.buckets) {
    const max = Math.max(...o.buckets, 1);
    dist = `<div class="vdist">${o.buckets.map((n, i) => {
      const c = i < 4 ? "up" : i === 4 ? "flat" : "down";
      return `<div class="vdist-col"><span class="vdist-n ${c}">${n}</span><i class="${c}" style="height:${Math.max(2, (n / max) * 100)}%"></i><span class="vdist-l ${i === 0 || i === 8 ? c : ""}">${VOL_BUCKETS[i]}</span></div>`;
    }).join("")}</div>
    <div class="vratio"><i class="up" style="flex:${o.up}"></i><i class="flat" style="flex:${o.flat}"></i><i class="down" style="flex:${o.down}"></i></div>
    <div class="vratio-l"><span class="up">▲ 涨 ${o.up} 家</span><span class="down">跌 ${o.down} 家 ▼</span></div>`;
  }
  box.innerHTML = `
    <div class="vov-h"><b>市场概况</b><span class="vtime">成交额 ${atText}${o ? " · 涨跌分布 " + volTimeText(o.at) : ""}</span></div>
    <div class="vov-cards">
      <div class="vov-c"><div class="k">涨跌分布</div><div class="v">${o ? `<span class="up">${o.up}</span>:<span class="flat">${o.flat}</span>:<span class="down">${o.down}</span>` : "-"}</div></div>
      <div class="vov-c"><div class="k">主力净流入</div><div class="v ${volCls(o && o.main)}">${o ? volAmt(o.main) : "-"}</div></div>
      <div class="vov-c"><div class="k">昨日涨停表现</div><div class="v ${volCls(o && o.ztPerf)}">${o && o.ztPerf != null ? volSign(o.ztPerf, 2) + "%" : "-"}</div></div>
    </div>
    ${dist}
    <div class="vov-sum">
      <div><span>两市成交总额</span><b>${m.ready ? volAmt(m.amount) : "-"}</b></div>
      <div><span>较前一日同期</span><b class="${volCls(ratio)}">${ratio == null ? "-" : `${ratio >= 0 ? "放量" : "缩量"} ${volAmt(Math.abs(m.diff))} ${volSign(ratio, 2)}%`}</b></div>
      <div><span>预测成交总额</span><b>${m.ready ? volAmt(m.pred) : "-"}</b></div>
      <div><span>近 ${o && o.avgDays ? o.avgDays : 60} 日平均</span><b>${o && o.avg60 ? volAmt(o.avg60) : "-"} <em class="${volCls(predVsAvg)}">${predVsAvg == null ? "" : volSign(predVsAvg, 2) + "%"}</em></b></div>
    </div>`;
}

// 卡片结构只建一次（里面有图表实例），之后只更新文字和曲线
function volRenderIndices(results) {
  const box = $("#volIndices");
  if (!box.children.length) {
    box.innerHTML = VOL_INDICES.map((t) => `<div class="vic" data-code="${t.key}" title="点击查看大图">
      <div class="vic-info"></div><div class="vic-chart" id="volMini_${t.key}"></div></div>`).join("");
  }
  for (const t of VOL_INDICES) {
    const m = results[t.key], s = m.snap;
    const card = box.querySelector(`.vic[data-code="${t.key}"]`);
    card.querySelector(".vic-info").innerHTML = !s ? `<div class="vic-t">${t.name}</div><div class="vic-s">加载中…</div>` : `
      <div class="vic-t">${t.name}${volDiffTag(m.ratio)}</div>
      <div class="vic-v ${volCls(s.pct)}">${volPx(s.price)}<small>${volSign(s.pct, 2)}%</small></div>
      <div class="vic-s"><span>成交 ${volAmt(m.ready ? m.amount : s.amount)}</span><span class="${volCls(m.ratio)}">较昨日同期 ${m.ratio == null ? "-" : volSign(m.ratio) + "%"}</span></div>
      <div class="vic-s"><span>量比 ${s.vr == null ? "-" : s.vr.toFixed(2)}</span><span>${m.ready && m.pred ? "预测全天 " + volAmt(m.pred) : ""}</span></div>`;
    volRenderMini(t.key, m);
  }
}

function volRenderMini(key, m) {
  const el = document.getElementById(`volMini_${key}`);
  if (!el || typeof echarts === "undefined" || !m.ready) return;
  if (!vol.miniCharts[key]) {
    vol.miniCharts[key] = echarts.init(el);
    new ResizeObserver(() => requestAnimationFrame(() => vol.active && vol.miniCharts[key].resize())).observe(el);
  }
  const s = m.series, pc = s.prevClose;
  const vals = s.price.filter((v) => v != null);
  const span = pc && vals.length ? Math.max(...vals.map((v) => Math.abs(v - pc))) * 1.15 || pc * 0.005 : null;
  const last = vals.length ? vals[vals.length - 1] : pc;
  const color = last >= pc ? volCss("--vol-up") : volCss("--vol-down");
  vol.miniCharts[key].setOption({
    animation: false, grid: { left: 2, right: 2, top: 4, bottom: 4 },
    xAxis: { type: "category", data: s.price.map((_, i) => i), show: false, boundaryGap: false },
    yAxis: { type: "value", show: false, min: span ? pc - span : null, max: span ? pc + span : null },
    series: [{ type: "line", data: s.price, showSymbol: false, silent: true, lineStyle: { width: 1.4, color }, areaStyle: { color, opacity: 0.08 },
      markLine: pc ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: volCss("--muted"), type: "dashed", width: 1 }, data: [{ yAxis: pc }] } : undefined }],
  }, true);
}

// ---------- 今天的成交节奏 ----------
function volCss(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function volXAxis(muted, line) {
  const marks = [0, 59, 119, 179, 239];
  return {
    type: "category", data: Array.from({ length: 240 }, (_, i) => volLabel(i)), boundaryGap: false,
    axisLabel: { color: muted, interval: (i) => marks.includes(i), formatter: (v, i) => (i === 0 ? "9:30" : i === 119 ? "11:30/13:00" : v) },
    axisLine: { lineStyle: { color: line } }, axisTick: { show: false },
  };
}

function volRenderChart(m) {
  if (typeof echarts === "undefined" || !m.ready) return;
  if (!vol.chart) {
    vol.chart = echarts.init($("#volChart"));
    new ResizeObserver(() => requestAnimationFrame(() => vol.active && vol.chart.resize())).observe($("#volChart"));
  }
  const muted = volCss("--muted"), line = volCss("--line"), grid = volCss("--table-line") || line, ink = volCss("--ink");
  const up = volCss("--vol-up"), down = volCss("--vol-down");
  const r = m.series.rhythm;
  vol.chart.setOption({
    animation: false, grid: { left: 52, right: 24, top: 12, bottom: 22 },
    tooltip: {
      trigger: "axis", backgroundColor: volCss("--panel"), borderColor: line, textStyle: { color: ink, fontSize: 12 },
      formatter: (items) => {
        const i = items[0].dataIndex, v = r[i];
        if (v == null) return `<b>${volLabel(i)}</b><br>昨天同一时间累计：${volAmt(m.series.prevCum[i])}`;
        return `<b>${volLabel(i)}</b><br>今天累计 ${volAmt(m.series.todayCum[i])}，昨天同一时间 ${volAmt(m.series.prevCum[i])}<br>`
          + `<span style="color:${v >= 0 ? up : down}">${v >= 0 ? "放量" : "缩量"} ${volSign(v)}%</span>`;
      },
    },
    xAxis: volXAxis(muted, line),
    yAxis: { type: "value", axisLabel: { color: muted, formatter: "{value}%" }, splitLine: { lineStyle: { color: grid } } },
    series: [
      { type: "line", data: r.map((v) => (v == null ? null : Math.max(v, 0))), showSymbol: false, lineStyle: { width: 0 }, areaStyle: { color: up, opacity: 0.18 }, silent: true },
      { type: "line", data: r.map((v) => (v == null ? null : Math.min(v, 0))), showSymbol: false, lineStyle: { width: 0 }, areaStyle: { color: down, opacity: 0.18 }, silent: true },
      { name: "比昨天同一时间", type: "line", data: r, showSymbol: false, lineStyle: { width: 1.8, color: ink }, itemStyle: { color: ink },
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: muted, type: "dashed" }, data: [{ yAxis: 0 }] } },
    ],
  }, true);
}

// ---------- 板块 ----------
function volRenderBoards() {
  const meta = $("#volBoardsMeta");
  if (vol.boardQuery) {
    const r = vol.boardHits;
    if (!r) { meta.textContent = ""; $("#volBoards").innerHTML = '<tbody><tr><td class="vempty">搜索中…</td></tr></tbody>'; return; }
    meta.textContent = r.loading && !r.items.length ? "" : `搜索「${vol.boardQuery}」：${r.items.length} 个板块`;
    if (!r.items.length) {
      $("#volBoards").innerHTML = `<tbody><tr><td class="vempty">${r.loading ? "第一次使用，正在下载东财板块名单（约 20 秒），完成后自动显示结果…" : "没有名字匹配的板块，换个关键词试试"}</td></tr></tbody>`;
      return;
    }
    return volBoardTable(r.items, true);
  }
  const b = vol.boards;
  if (!b) { $("#volBoards").innerHTML = `<tbody><tr><td class="vempty">${esc(vol.slowError || "正在从东方财富获取板块数据（这一类第一次打开较慢，之后会先显示上次的数据）…")}</td></tr></tbody>`; meta.textContent = ""; return; }
  meta.innerHTML = `共 ${b.total} 个，显示前 ${b.items.length} 个 · ${volTimeText(b.at)}`;
  volBoardTable(b.items, false);
}

function volBoardTable(items, withType) {
  const g = volGroup();
  $("#volBoards").innerHTML = `<thead><tr><th>板块</th><th>涨跌幅</th><th>成交额</th><th>量比（比近 5 日同时段）</th><th>涨 / 跌家数</th><th>领涨股</th><th title="加入 / 移出当前自选分组">自选</th></tr></thead><tbody>${
    items.map((x) => `<tr data-board="${esc(x.code)}" data-name="${esc(x.name)}"><td><b>${esc(x.name)}</b>${withType ? ` <span class="vmuted">${esc(x.type || "")}</span>` : ""}</td>
      <td class="${volCls(x.pct)}">${volSign(x.pct, 2)}%</td><td>${volAmt(x.amount)}</td>
      <td>${volVrBar(x.vr)}</td><td><span class="up">${x.up ?? "-"}</span> / <span class="down">${x.down ?? "-"}</span></td>
      <td>${esc(x.lead || "-")} <span class="${volCls(x.leadPct)}">${x.leadPct == null ? "" : volSign(x.leadPct, 2) + "%"}</span></td>
      <td><a class="vstar${volGroupHas(g, x.code) ? " on" : ""}" data-star="${esc(x.code)}" title="${volGroupHas(g, x.code) ? "移出" : "加入"}「${esc(g.name)}」">${volGroupHas(g, x.code) ? "★" : "☆"}</a></td></tr>`).join("")}</tbody>`;
}

// 板块搜索：名单还在下载时每 3 秒重试，直到出结果
let volBoardSearchTimer = null;
async function volRunBoardSearch() {
  clearTimeout(volBoardSearchTimer);
  const q = vol.boardQuery;
  if (!q) return volRenderBoards();
  try {
    const r = await volApi("boardsearch", { q, quotes: 1 });
    if (vol.boardQuery !== q) return;
    vol.boardHits = r;
    if (r.loading && !r.items.length) volBoardSearchTimer = setTimeout(volRunBoardSearch, 3000);
  } catch (e) {
    vol.boardHits = { items: [], loading: false };
  }
  volRenderBoards();
}
function volVrBar(vr) {
  if (vr == null) return "-";
  const c = vr >= 1.2 ? "up" : vr <= 0.8 ? "down" : "flat";
  return `<span class="vvr"><i class="${c}" style="width:${Math.min(100, (vr / 3) * 100)}%"></i></span>${vr.toFixed(2)} ${volVrTag(vr)}`;
}

// ---------- 自选分组 ----------
function volGroup() {
  if (vol.gsel >= vol.groups.length) vol.gsel = 0;
  return vol.groups[vol.gsel];
}
function volSaveGroups() {
  localStorage.setItem("volGroups", JSON.stringify(vol.groups));
  localStorage.setItem("volGroupSel", String(vol.gsel));
}
const volIsBoard = (it) => it.type === "board";
function volGroupHas(g, code) { return g.items.some((x) => x.code === code); }
function volAddToGroup(gi, item) {
  const g = vol.groups[gi];
  if (!volGroupHas(g, item.code)) g.items.push(item);
  volSaveGroups();
  volRenderGroups();
  toast(`已加入「${g.name}」`);
  if (volIsBoard(item)) volLoadBoardQuotes(); else volFastTick();
}
function volRemoveFromGroup(g, code) {
  g.items = g.items.filter((x) => x.code !== code);
  volSaveGroups();
  volRenderGroups();
}

// 自选页：只列文字（涨跌、量比、放量/缩量），点一行才在右侧显示曲线或成分股
function volRenderGroups() {
  $("#volGroupTabs").innerHTML = vol.groups.map((g, i) => `<button class="vgtab${i === vol.gsel ? " on" : ""}" data-g="${i}">${esc(g.name)}<em>${g.items.length}</em></button>`).join("")
    + '<button class="vgtab vgadd" data-g="new" title="新建分组">＋</button>';
  const g = volGroup();
  const sel = vol.panels.watch.state && (vol.panels.watch.state.fromBoard || vol.panels.watch.state).code;
  const boardAts = g.items.filter(volIsBoard).map((x) => volBoardRow(x.code).at).filter(Boolean);
  $("#volWatchMeta").innerHTML = g.items.length ? `${g.items.filter((x) => !volIsBoard(x)).length} 只股票 · ${g.items.filter(volIsBoard).length} 个板块 · 股票${volSnapTime()}`
    + (boardAts.length ? ` · 板块${volTimeText(Math.min(...boardAts), "数据")}` : "") : "";
  if (!g.items.length) {
    $("#volWatchTable").innerHTML = '<tbody><tr><td class="vempty">这个分组还是空的：在左上角搜索股票或板块，打开后点「加入分组」；也可以在市场概况的板块表点 ☆</td></tr></tbody>';
    return;
  }
  const rows = g.items.map((it) => {
    if (volIsBoard(it)) {
      const b = volBoardRow(it.code);
      // 板块数据来自东财：还没拿到时写明在加载还是被限制，而不是一排「-」
      const old = b.at && Date.now() / 1000 - b.at > VOL_OLD_SEC && volIsTradingHours();
      const hm = b.at ? new Date(b.at * 1000).toTimeString().slice(0, 5) : "";
      const sub = b.pct != null || b.amount != null ? (old ? `板块 · ${hm} 的数据` : "板块")
        : /频繁|断开|Connection|aborted/i.test(vol.boardErr || "") ? "板块 · 东财限制访问，稍后自动重试"
        : vol.boardErr ? "板块 · 暂时取不到" : "板块 · 加载中…";
      return { it, board: true, name: b.name || it.name || it.code, sub, price: b.price, pct: b.pct, amount: b.amount, vr: b.vr, diff: b.diff, base: b.prevAt };
    }
    const s = vol.snap[it.code] || {};
    const m = volCompute({ key: it.code, codes: [it.code] });
    return { it, board: false, name: s.name || it.name || it.code, sub: it.code.slice(2), price: s.price, pct: s.pct, amount: s.amount, vr: s.vr,
      diff: m.ready ? m.diff : null, base: m.ready ? m.prevAligned : null };
  });
  // 点表头排序：只改显示顺序，不改分组里保存的顺序；没有数据的排在最后
  const { key, dir } = vol.watchSort;
  if (key) {
    rows.sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
      return (key === "name" ? String(x).localeCompare(String(y), "zh") : x - y) * dir;
    });
  }
  const th = (k, label, title = "") => `<th data-sort="${k}" class="vsort${key === k ? " on" : ""}"${title ? ` title="${title}"` : ""}>${label}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  $("#volWatchTable").innerHTML = `<thead><tr>${th("name", "名称")}${th("price", "现价")}${th("pct", "涨跌幅")}${th("amount", "成交额")}${th("vr", "量比")}${
    th("diff", "比昨天同时", "今天到现在的成交额比昨天同一时间多（放）或少（缩）多少")}</tr></thead><tbody>${rows.map((r) => {
    const on = r.it.code === sel ? " class=\"on\"" : "";
    const attrs = r.board ? `data-board="${esc(r.it.code)}" data-name="${esc(r.it.name)}"` : `data-code="${esc(r.it.code)}"`;
    return `<tr${on} ${attrs}><td><b>${esc(r.name)}</b> <span class="vmuted">${esc(r.sub)}</span></td>
      <td class="${volCls(r.pct)}">${r.price != null ? volPx(r.price) : "-"}</td><td class="${volCls(r.pct)}">${r.pct != null ? volSign(r.pct, 2) + "%" : "-"}</td>
      <td>${r.amount != null ? volAmt(r.amount) : "-"}</td><td>${r.vr != null ? r.vr.toFixed(2) : "-"}</td><td>${volDiffText(r.diff, r.base)}</td></tr>`;
  }).join("")}</tbody>`;
}

// 「放 12.3 亿」/「缩 4.5 亿」：今天到现在比昨天同一时间多或少成交多少，悬停看百分比
function volDiffText(diff, base) {
  if (diff == null) return "-";
  const pct = base > 0 ? `（${volSign((diff / base) * 100)}%）` : "";
  return `<span class="${diff >= 0 ? "up" : "down"}" title="比昨天同一时间${diff >= 0 ? "多" : "少"}成交 ${volAmt(Math.abs(diff))}${pct}">${diff >= 0 ? "放" : "缩"} ${volAmt(Math.abs(diff))}</span>`;
}

// 板块行情：东财实时行情（push2，有量比、涨跌家数）+ 分时（push2his，有比昨天同时），哪个有用哪个
function volBoardRow(code) {
  const q = vol.boardQuotes[code] || {}, t = vol.boardTrends[code] || {};
  return { name: q.name || t.name, price: t.price, pct: q.pct ?? t.pct, amount: q.amount ?? t.amount, vr: q.vr, up: q.up, down: q.down,
    diff: t.diff, prevAt: t.prevAt, at: Math.max(q.at || 0, t.at || 0) || null };
}

// 自选里的板块行情来自东财，跟着慢速刷新；切换分组、加入板块时马上取一次
async function volLoadBoardQuotes() {
  const codes = volGroup().items.filter(volIsBoard).map((x) => x.code);
  if (!codes.length) return;
  const errs = [];
  await Promise.all([
    volApi("boardtrends", { codes: codes.join(",") }).then((r) => {
      Object.assign(vol.boardTrends, r.items);
      if (Object.keys(r.errors || {}).length) errs.push(Object.values(r.errors)[0]);
    }).catch((e) => errs.push(e.message)),
    volApi("boardquotes", { codes: codes.join(",") }).then((r) => {
      for (const [c, x] of Object.entries(r.items)) vol.boardQuotes[c] = { ...x, at: r.at };
    }).catch((e) => errs.push(e.message)),
  ]);
  vol.boardErr = errs.length === 2 ? errs[0] : "";
  volRenderGroups();
  for (const [key, p] of Object.entries(vol.panels)) if (p.state && p.state.type === "board") volRenderPanel(key);
}

// ---------- 个股 / 板块面板 ----------
// 两个面板：市场概况页点开的是右侧浮层（drawer），自选页点开的是右半边详情（watch）
function volPanelKey() { return vol.page === "watch" ? "watch" : "drawer"; }
function volPanelStates() { return Object.values(vol.panels).map((p) => p.state).filter(Boolean); }

function volOpenStock(code, name, fromBoard, key = volPanelKey()) {
  vol.panels[key].state = { type: "stock", code: code.toLowerCase(), name: name || "", fromBoard: fromBoard || null };
  if (key === "drawer") $("#volDrawer").classList.remove("hidden");
  volRenderPanel(key);
  if (key === "watch") volRenderGroups();
  volFastTick(true);
}
function volOpenBoard(code, name, key = volPanelKey()) {
  vol.panels[key].state = { type: "board", code, name, data: null };
  if (key === "drawer") $("#volDrawer").classList.remove("hidden");
  volRenderPanel(key);
  if (key === "watch") volRenderGroups();
  volLoadBoard(key);
}
function volCloseDrawer() {
  vol.panels.drawer.state = null;
  $("#volDrawer").classList.add("hidden");
}
// 自选页右侧详情：没选中时收起，列表占满宽度
function volCloseDetail() {
  const p = vol.panels.watch;
  p.state = null;
  if (p.chart) { p.chart.dispose(); p.chart = null; p.chartSig = null; }
  $("#volDetailTitle").innerHTML = "";
  $("#volDetailBody").innerHTML = "";
  $("#volWatchBody").classList.add("no-detail");
  volRenderGroups();
}
async function volLoadBoard(key) {
  const d = vol.panels[key].state;
  if (!d || d.type !== "board") return;
  try {
    const r = await volApi("board", { code: d.code });
    if (vol.panels[key].state === d) { d.data = r; d.error = ""; }
  } catch (e) {
    if (vol.panels[key].state === d) d.error = e.message;
  }
  if (vol.panels[key].state === d) volRenderPanel(key);
}

function volRenderPanel(key) {
  const p = vol.panels[key], d = p.state;
  if (!d) return;
  if (key === "watch") $("#volWatchBody").classList.remove("no-detail");
  $(p.back).classList.toggle("hidden", !(d.type === "stock" && d.fromBoard));
  if (p.remove) {
    const top = d.fromBoard || d;
    $(p.remove).classList.toggle("hidden", !volGroupHas(volGroup(), top.code));
  }
  if (d.type === "board") return volRenderBoardPanel(p, d);
  const s = vol.snap[d.code];
  const name = (s && s.name) || d.name || d.code;
  $(p.title).innerHTML = `${esc(name)} <span>${esc(d.code.slice(2))}</span>`;
  if (!s) { $(p.body).innerHTML = '<div class="vempty">正在获取行情…</div>'; return; }
  const m = volCompute({ key: d.code, codes: [d.code] });
  const stat = (k, v, cls = "") => `<div><span>${k}</span><b class="${cls}">${v}</b></div>`;
  // 骨架（切换按钮、图表容器、加入分组）只在换股票时重建：每 3 秒刷新只更新文字和曲线，K 线不会被反复重画
  let skel = $(p.body).querySelector(`.vd-skel[data-code="${d.code}"]`);
  if (!skel) {
    $(p.body).innerHTML = `<div class="vd-skel" data-code="${esc(d.code)}"><div class="vd-info"></div>
      <div class="vd-tabs">${VOL_VIEWS.map(([v, label]) => `<button data-view="${v}">${label}</button>`).join("")}</div>
      <div id="${p.chartId}" class="vd-chart"></div><div class="vd-addwrap"></div></div>`;
    skel = $(p.body).querySelector(".vd-skel");
    p.addSig = null;
  }
  d.view = d.view || "min";
  skel.querySelectorAll(".vd-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === d.view));
  const sig = vol.groups.map((g) => g.name + (volGroupHas(g, d.code) ? "*" : "")).join("|") + vol.gsel;
  if (p.addSig !== sig) { skel.querySelector(".vd-addwrap").innerHTML = volAddBar(d.code); p.addSig = sig; }
  skel.querySelector(".vd-info").innerHTML = `
    <div class="vd-price ${volCls(s.pct)}">${volPx(s.price)}<small>${volSign(s.change, 2)}　${volSign(s.pct, 2)}%</small></div>
    <div class="vd-line">${m.ready && m.ratio != null ? `成交 ${volAmt(m.amount)}，比昨天同一时间 <b class="${volCls(m.ratio)}">${m.ratio >= 0 ? "多" : "少"} ${Math.abs(m.ratio).toFixed(1)}%</b>${m.pred ? `，预计全天 ${volAmt(m.pred)}（昨天 ${volAmt(m.prevFull)}）` : ""}` : `成交 ${volAmt(s.amount)}`}</div>
    <div class="vd-stats">
      ${stat("量比", (s.vr == null ? "-" : s.vr.toFixed(2)) + " " + volVrTag(s.vr))}${stat("换手率", s.turn == null ? "-" : s.turn.toFixed(2) + "%")}
      ${stat("振幅", s.amp == null ? "-" : s.amp.toFixed(2) + "%")}${stat("成交额", volAmt(s.amount))}
      ${stat("最高", volPx(s.high), volCls(s.high - s.prev))}${stat("最低", volPx(s.low), volCls(s.low - s.prev))}
      ${stat("今开", volPx(s.open), volCls(s.open - s.prev))}${stat("昨收", volPx(s.prev))}
    </div>`;
  if (d.view === "min") volRenderPanelChart(p, m);
  else if (d.view === "5d") volRenderFiveDay(p, d.code);
  else volRenderKline(p, d.code, d.view);
}

const VOL_VIEWS = [["min", "分时"], ["5d", "五日"], ["day", "日K"], ["week", "周K"], ["month", "月K"]];

function volAddBar(code) {
  const inGroups = vol.groups.filter((g) => volGroupHas(g, code));
  return `<div class="vd-add">
    ${inGroups.length ? `<span>已在：${inGroups.map((g) => esc(g.name)).join("、")}</span>` : ""}
    <select>${vol.groups.map((g, i) => `<option value="${i}"${i === vol.gsel ? " selected" : ""}>${esc(g.name)}</option>`).join("")}</select>
    <button class="btn small">加入分组</button>
  </div>`;
}

function volRenderBoardPanel(p, d) {
  const listed = (vol.boards && vol.boards.items.find((x) => x.code === d.code)) || (vol.boardHits && vol.boardHits.items.find((x) => x.code === d.code)) || {};
  const br = volBoardRow(d.code);
  const row = { ...listed, ...Object.fromEntries(Object.entries(br).filter(([, v]) => v != null)) };
  $(p.title).innerHTML = `${esc(d.name)} <span class="${volCls(row.pct)}">${row.pct != null ? volSign(row.pct, 2) + "%" : ""}</span>`;
  const summary = [row.amount != null ? `成交 ${volAmt(row.amount)}` : "", row.diff != null ? `比昨天同时 ${volDiffText(row.diff, row.prevAt)}` : "",
    row.vr != null ? `量比 ${row.vr.toFixed(2)} ${volVrTag(row.vr)}` : ""].filter(Boolean).join(" · ");
  if (!d.data) { $(p.body).innerHTML = `${summary ? `<div class="vd-line">${summary}</div>` : ""}<div class="vempty">${esc(d.error ? `成分股暂时取不到：${d.error}` : "正在获取成分股…")}</div>${volAddBar(d.code)}`; return; }
  $(p.body).innerHTML = `
    <div class="vd-line">${summary ? summary + " · " : ""}共 ${d.data.total} 只，按涨跌幅排序（前 ${d.data.items.length} 只）</div>
    ${volAddBar(d.code)}
    <table class="vtable vd-table"><thead><tr><th>股票</th><th>现价</th><th>涨跌幅</th><th>量比</th><th>成交额</th></tr></thead><tbody>
    ${d.data.items.map((x) => `<tr data-code="${esc(x.code)}" data-name="${esc(x.name)}"><td><b>${esc(x.name)}</b> <span class="vmuted">${esc(x.code.slice(2))}</span></td>
      <td class="${volCls(x.pct)}">${volPx(x.price)}</td><td class="${volCls(x.pct)}">${volSign(x.pct, 2)}%</td>
      <td>${x.vr == null ? "-" : x.vr.toFixed(2)} ${volVrTag(x.vr)}</td><td>${volAmt(x.amount)}</td></tr>`).join("")}
    </tbody></table>`;
}

// 换股票、换板块时图表容器是新节点，旧实例要释放
function volPanelChart(p) {
  const el = document.getElementById(p.chartId);
  if (!el || typeof echarts === "undefined") return null;
  if (p.chart && p.chart.getDom() !== el) { p.chart.dispose(); p.chart = null; p.chartSig = null; }
  if (!p.chart) {
    p.chart = echarts.init(el);
    new ResizeObserver(() => requestAnimationFrame(() => p.chart && p.chart.resize())).observe(el);
  }
  return p.chart;
}

// 五日：近 5 个交易日的分时连成一条线，下面是每分钟成交额
function volRenderFiveDay(p, code) {
  const chart = volPanelChart(p);
  const days = vol.minutes[code] && vol.minutes[code].days;
  if (!chart) return;
  if (!days) { chart.clear(); p.chartSig = null; return; }
  const list = days.slice(0, 5).reverse();
  const sig = `5d:${code}:${list.map((d) => d.cum.filter((v) => v != null).length).join(",")}`;
  if (p.chartSig === sig) return;
  p.chartSig = sig;
  const muted = volCss("--muted"), line = volCss("--line"), grid = volCss("--table-line") || line, ink = volCss("--ink");
  const up = volCss("--vol-up"), down = volCss("--vol-down"), priceC = volCss("--vol-price");
  const x = [], price = [], bars = [], barColor = [];
  for (const d of list) {
    for (let i = 0; i < 240; i++) {
      x.push(`${volDateText(d.date)} ${volLabel(i)}`);
      price.push(d.price[i]);
      const prevCum = i === 0 ? d.auction || 0 : d.cum[i - 1];
      bars.push(d.cum[i] != null && prevCum != null ? d.cum[i] - prevCum : null);
      barColor.push(d.price[i] != null && (i === 0 ? d.prevClose : d.price[i - 1]) != null && d.price[i] < (i === 0 ? d.prevClose : d.price[i - 1]) ? down : up);
    }
  }
  const pc = list[0].prevClose;
  chart.setOption({
    animation: false,
    grid: [{ left: 52, right: 16, top: 10, height: "56%" }, { left: 52, right: 16, top: "70%", bottom: 22 }],
    tooltip: { trigger: "axis", backgroundColor: volCss("--panel"), borderColor: line, textStyle: { color: ink, fontSize: 12 },
      formatter: (items) => { const i = items[0].dataIndex; return price[i] == null ? x[i] : `<b>${x[i]}</b><br>价格 ${volPx(price[i])}<br>这一分钟成交 ${volAmt(bars[i])}`; } },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: [0, 1].map((gi) => ({ type: "category", data: x, gridIndex: gi, boundaryGap: false, axisTick: { show: false }, axisLine: { lineStyle: { color: line } },
      axisLabel: gi === 0 ? { show: false } : { color: muted, interval: (i) => i % 240 === 0, formatter: (v) => v.slice(0, 5) } })),
    yAxis: [
      { type: "value", gridIndex: 0, scale: true, axisLabel: { color: muted, formatter: (v) => v.toFixed(2) }, splitLine: { lineStyle: { color: grid } } },
      { type: "value", gridIndex: 1, splitNumber: 2, axisLabel: { color: muted, showMinLabel: false, formatter: (v) => (v >= 1e8 ? (v / 1e8).toFixed(1) + "亿" : (v / 1e4).toFixed(0) + "万") }, splitLine: { show: false } },
    ],
    series: [
      { type: "line", xAxisIndex: 0, yAxisIndex: 0, data: price, showSymbol: false, connectNulls: false, lineStyle: { width: 1.3, color: priceC }, itemStyle: { color: priceC },
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: muted, type: "dashed" },
          data: [...(pc ? [{ yAxis: pc }] : []), ...list.slice(1).map((_, k) => ({ xAxis: (k + 1) * 240 }))] } },
      { type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: bars.map((v, i) => ({ value: v, itemStyle: { color: barColor[i] } })), barWidth: "80%" },
    ],
  }, true);
}

// 日 / 周 / 月 K：蜡烛图 + 5/10/20 均线 + 成交量；数据 1 分钟内不重复请求
async function volRenderKline(p, code, period) {
  const chart = volPanelChart(p);
  if (!chart) return;
  const key = `${code}:${period}`;
  const k = vol.klines[key];
  if (!k || (Date.now() - k.at > 60000 && !k.loading)) {
    vol.klines[key] = { ...(k || {}), loading: true, at: k ? k.at : 0 };
    volApi("kline", { code, period }).then((r) => { vol.klines[key] = { items: r.items, at: Date.now() }; })
      .catch((e) => { vol.klines[key] = { ...(vol.klines[key] || {}), loading: false, error: e.message, at: Date.now() }; })
      .finally(() => { if (p.state && p.state.code === code && p.state.view === period) volRenderKline(p, code, period); });
    if (!k || !k.items) { chart.clear(); p.chartSig = null; chart.showLoading({ text: "加载 K 线…", color: volCss("--brown2"), textColor: volCss("--muted"), maskColor: "transparent" }); return; }
  }
  const cur = vol.klines[key];
  chart.hideLoading();
  if (!cur.items || !cur.items.length) { chart.clear(); p.chartSig = null; return; }
  const items = cur.items;
  const sig = `k:${key}:${items.length}:${items[items.length - 1].close}`;
  if (p.chartSig === sig) return;
  const keepZoom = p.chartSig && p.chartSig.startsWith(`k:${key}:`);
  p.chartSig = sig;
  const muted = volCss("--muted"), line = volCss("--line"), grid = volCss("--table-line") || line, ink = volCss("--ink");
  const up = volCss("--vol-up"), down = volCss("--vol-down");
  const ma = (n) => items.map((_, i) => (i < n - 1 ? null : +(items.slice(i - n + 1, i + 1).reduce((s, x) => s + x.close, 0) / n).toFixed(3)));
  const pct = (i) => (i > 0 && items[i - 1].close ? ((items[i].close - items[i - 1].close) / items[i - 1].close) * 100 : null);
  const zoom = chart.getOption && keepZoom ? (chart.getOption().dataZoom || [])[0] : null;
  const startPct = items.length > 90 ? (1 - 90 / items.length) * 100 : 0;
  chart.setOption({
    animation: false,
    legend: { top: 0, left: 52, itemHeight: 8, textStyle: { color: muted, fontSize: 11 }, data: ["MA5", "MA10", "MA20"] },
    grid: [{ left: 52, right: 16, top: 22, height: "56%" }, { left: 52, right: 16, top: "74%", bottom: 22 }],
    tooltip: { trigger: "axis", axisPointer: { type: "cross" }, backgroundColor: volCss("--panel"), borderColor: line, textStyle: { color: ink, fontSize: 12 },
      formatter: (its) => {
        const i = its[0].dataIndex, x = items[i], c = pct(i);
        return `<b>${x.date}</b><br>开 ${volPx(x.open)}　收 ${volPx(x.close)}<br>高 ${volPx(x.high)}　低 ${volPx(x.low)}<br>`
          + `涨跌 <span style="color:${c == null ? ink : c >= 0 ? up : down}">${volSign(c, 2)}%</span>　成交量 ${(x.volume / 1e6).toFixed(2)} 万手`;
      } },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], start: zoom ? zoom.start : startPct, end: zoom ? zoom.end : 100 }],
    xAxis: [0, 1].map((gi) => ({ type: "category", data: items.map((x) => x.date), gridIndex: gi, axisTick: { show: false }, axisLine: { lineStyle: { color: line } },
      axisLabel: gi === 0 ? { show: false } : { color: muted } })),
    yAxis: [
      { type: "value", gridIndex: 0, scale: true, axisLabel: { color: muted, formatter: (v) => v.toFixed(2) }, splitLine: { lineStyle: { color: grid } } },
      { type: "value", gridIndex: 1, splitNumber: 2, axisLabel: { color: muted, showMinLabel: false, formatter: (v) => (v >= 1e8 ? (v / 1e8).toFixed(1) + "亿" : (v / 1e4).toFixed(0) + "万") }, splitLine: { show: false } },
    ],
    series: [
      { name: "K", type: "candlestick", data: items.map((x) => [x.open, x.close, x.low, x.high]),
        itemStyle: { color: up, color0: down, borderColor: up, borderColor0: down } },
      ...[["MA5", 5, "#e0a800"], ["MA10", 10, "#8e44ad"], ["MA20", 20, "#2f6fb0"]].map(([name, n, c]) => ({
        name, type: "line", data: ma(n), showSymbol: false, smooth: true, lineStyle: { width: 1, color: c }, itemStyle: { color: c } })),
      { type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: items.map((x, i) => ({ value: x.volume, itemStyle: { color: x.close >= x.open ? up : down } })) },
    ],
  }, true);
}

function volRenderPanelChart(p, m) {
  if (!volPanelChart(p)) return;
  p.chartSig = "min";
  if (!m.ready) { p.chart.clear(); return; }
  const muted = volCss("--muted"), line = volCss("--line"), grid = volCss("--table-line") || line, ink = volCss("--ink");
  const up = volCss("--vol-up"), down = volCss("--vol-down"), price = volCss("--vol-price");
  const s = m.series, pc = s.prevClose;
  const vals = s.price.filter((v) => v != null).concat(pc ? [pc] : []);
  const span = vals.length ? Math.max(...vals.map((v) => Math.abs(v - pc))) * 1.1 || pc * 0.01 : 0;
  p.chart.setOption({
    animation: false,
    grid: [{ left: 52, right: 52, top: 10, height: "56%" }, { left: 52, right: 52, top: "70%", bottom: 22 }],
    tooltip: {
      trigger: "axis", backgroundColor: volCss("--panel"), borderColor: line, textStyle: { color: ink, fontSize: 12 },
      formatter: (items) => {
        const i = items[0].dataIndex, px = s.price[i];
        return px == null ? volLabel(i) : `<b>${volLabel(i)}</b><br>价格 ${volPx(px)}（${volSign(pc ? ((px - pc) / pc) * 100 : null, 2)}%）<br>这一分钟成交 ${volAmt(s.todayBar[i])}`;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: [{ ...volXAxis(muted, line), gridIndex: 0, axisLabel: { show: false } }, { ...volXAxis(muted, line), gridIndex: 1 }],
    yAxis: [
      { type: "value", gridIndex: 0, min: pc ? pc - span : null, max: pc ? pc + span : null, axisLabel: { color: muted, formatter: (v) => v.toFixed(2) }, splitLine: { lineStyle: { color: grid } } },
      { type: "value", gridIndex: 0, position: "right", min: pc ? -span / pc * 100 : null, max: pc ? span / pc * 100 : null, axisLabel: { color: muted, formatter: (v) => v.toFixed(1) + "%" }, splitLine: { show: false } },
      { type: "value", gridIndex: 1, splitNumber: 2, axisLabel: { color: muted, showMinLabel: false, formatter: (v) => (v >= 1e8 ? (v / 1e8).toFixed(1) + "亿" : (v / 1e4).toFixed(0) + "万") }, splitLine: { show: false } },
    ],
    series: [
      { type: "line", xAxisIndex: 0, yAxisIndex: 0, data: s.price, showSymbol: false, lineStyle: { width: 1.5, color: price }, itemStyle: { color: price },
        markLine: pc ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: muted, type: "dashed" }, data: [{ yAxis: pc }] } : undefined },
      { type: "bar", xAxisIndex: 1, yAxisIndex: 2, data: s.todayBar.map((v, i) => ({ value: v, itemStyle: { color: s.price[i] != null && pc && s.price[i] >= (s.price[i - 1] ?? pc) ? up : down } })), barWidth: "70%" },
    ],
  }, true);
}

// ---------- 搜索 ----------
let volSearchTimer = null;
function volBindSearch() {
  const input = $("#volSearch"), box = $("#volSuggest");
  const show = (stocks, boards) => {
    const rows = stocks.map((it) => `<div class="vsg" data-code="${esc(it.code)}" data-name="${esc(it.name)}">
      <b>${esc(it.name || it.code)}</b><span>${esc(it.code)}</span><em>${esc(it.type)}</em></div>`)
      .concat(boards.slice(0, 8).map((b) => `<div class="vsg" data-board="${esc(b.code)}" data-name="${esc(b.name)}">
      <b>${esc(b.name)}</b><span>${esc(b.code)}</span><em>${esc(b.type)}板块</em></div>`));
    box.innerHTML = rows.length ? rows.join("") : '<div class="vsg-empty">没有找到，试试 6 位代码或板块名</div>';
    box.classList.remove("hidden");
  };
  const run = async () => {
    const q = input.value.trim();
    if (!q) { box.classList.add("hidden"); return; }
    const [s, b] = await Promise.all([
      volApi("search", { q }).then((r) => r.items).catch(() => []),
      volApi("boardsearch", { q }).then((r) => r.items).catch(() => []),
    ]);
    if (input.value.trim() === q) show(s, b);
  };
  const pick = (el) => {
    input.value = "";
    box.innerHTML = "";
    box.classList.add("hidden");
    if (el.dataset.board) volOpenBoard(el.dataset.board, el.dataset.name);
    else volOpenStock(el.dataset.code, el.dataset.name);
  };
  input.addEventListener("input", () => { clearTimeout(volSearchTimer); volSearchTimer = setTimeout(run, 300); });
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") return box.classList.add("hidden");
    if (e.key !== "Enter") return;
    clearTimeout(volSearchTimer);
    await run();
    const first = box.querySelector(".vsg");
    if (first) pick(first);
  });
  box.addEventListener("click", (e) => { const it = e.target.closest(".vsg"); if (it) pick(it); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".vsearch")) box.classList.add("hidden"); });
}

// ---------- 数据轮询 ----------
async function volApi(path, params) {
  const r = await fetch(`/api/vol/${path}?${new URLSearchParams(params)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function volMinuteCodes() {
  const codes = [...VOL_TOTAL.codes, ...VOL_INDICES.flatMap((t) => t.codes)];
  for (const d of volPanelStates()) if (d.type === "stock") codes.push(d.code);
  // 自选页要给每只股票算「比昨天同时放/缩多少亿」，需要它们的分时
  if (vol.page === "watch") codes.push(...volGroup().items.filter((x) => !volIsBoard(x)).map((x) => x.code));
  return [...new Set(codes)];
}
function volSnapCodes() {
  return [...new Set([...volMinuteCodes(), ...volGroup().items.filter((x) => !volIsBoard(x)).map((x) => x.code)])];
}

// 行情（腾讯）：3 秒一次；分时每分钟或 30 秒补一次
async function volFastTick(force) {
  if (!vol.active || vol.fastBusy) return;
  vol.fastBusy = true;
  clearTimeout(vol.fastTimer);
  try {
    const snap = await volApi("snapshot", { codes: volSnapCodes().join(",") });
    vol.snap = { ...vol.snap, ...snap.items };
    vol.source = snap.source;
    let dirty = false;
    for (const g of vol.groups) for (const it of g.items) if (!volIsBoard(it) && !it.name && vol.snap[it.code]) { it.name = vol.snap[it.code].name; dirty = true; }
    if (dirty) volSaveGroups();
    const anyTime = Object.values(snap.items).map((x) => x.time).sort().pop() || "";
    const idx = anyTime ? volClock(anyTime).idx : null;
    const codes = volMinuteCodes();
    if (force || codes.some((c) => !vol.minutes[c]) || idx !== vol.minuteIdx || Date.now() - vol.minutesAt > VOL_MINUTE_REFRESH_MS) {
      const m = await volApi("minutes", { codes: codes.join(",") });
      Object.assign(vol.minutes, m.items);
      vol.minutesAt = Date.now();
      vol.minuteIdx = idx;
    }
    vol.error = "";
    vol.updatedAt = Date.now();
  } catch (e) {
    vol.error = `获取行情失败：${e.message}`;
  } finally {
    vol.fastBusy = false;
  }
  volRender();
  if (vol.active) vol.fastTimer = setTimeout(volFastTick, volIsTradingHours() ? VOL_FAST_MS : VOL_IDLE_FAST_MS);
}

// 市场概况和板块（东方财富，按 IP 限额）：1 分钟一次，非交易时段 5 分钟；在自选页时只取自选里的板块
async function volSlowTick() {
  if (!vol.active || vol.slowBusy) return;
  vol.slowBusy = true;
  clearTimeout(vol.slowTimer);
  const errs = [];
  // 后端按东财域名分别排队，这里同时发出，谁先回来先显示
  const jobs = [volLoadBoardQuotes()];
  for (const [key, p] of Object.entries(vol.panels)) if (p.state && p.state.type === "board") jobs.push(volLoadBoard(key));
  if (vol.page === "market") {
    jobs.push(volApi("overview", {}).then((o) => { vol.overview = o; volRender(); }).catch((e) => errs.push(`市场概况：${e.message}`)));
    jobs.push(volApi("boards", { type: vol.boardType, sort: vol.boardSort }).then((b) => {
      vol.boards = { ...b, type: vol.boardType, sort: vol.boardSort };
      volRenderBoards();
    }).catch((e) => errs.push(`板块：${e.message}`)));
    if (vol.boardQuery) jobs.push(volRunBoardSearch());
  }
  await Promise.all(jobs);
  vol.slowError = errs.join("；");
  vol.slowAt = Date.now();
  vol.slowBusy = false;
  volRender();
  volRenderBoards();
  // 请求途中切换了行业/概念或排序：马上按新的再取一次
  const changed = vol.page === "market" && (!vol.boards || vol.boards.type !== vol.boardType || vol.boards.sort !== vol.boardSort);
  // 先拿到的是旧数据时，后端已在后台取新的：几秒后再问一次（最多连续 3 次），新数据不用等满 1 分钟
  const stale = [vol.overview, vol.boards, ...Object.values(vol.boardTrends)].some((x) => x && x.stale);
  vol.quickRetry = stale ? (vol.quickRetry || 0) + 1 : 0;
  const quick = stale && vol.quickRetry <= 3 && volIsTradingHours();
  if (vol.active) vol.slowTimer = setTimeout(volSlowTick, changed ? 100 : quick ? 6000 : volIsTradingHours() ? VOL_SLOW_MS : VOL_IDLE_SLOW_MS);
}

function volRender() {
  const results = { TOTAL: volCompute(VOL_TOTAL) };
  for (const t of VOL_INDICES) results[t.key] = volCompute(t);
  volRenderOverview(results.TOTAL);
  volRenderIndices(results);
  volRenderChart(results.TOTAL);
  volRenderGroups();
  for (const [key, p] of Object.entries(vol.panels)) if (p.state && p.state.type === "stock") volRenderPanel(key);
  $("#volRhythmTime").textContent = volSnapTime();
  $("#volIdxTime").textContent = volSnapTime();
  const m = results.TOTAL;
  const phase = m.ready ? m.clock.phase : null;
  const now = new Date();
  const preOpen = now.getDay() >= 1 && now.getDay() <= 5 && now.getHours() * 60 + now.getMinutes() < 9 * 60 + 30;
  const label = !phase ? "连接中" : m.clock.date !== volTodayStr() ? `${preOpen ? "盘前" : "休市"} · 显示 ${volDateText(m.clock.date)} 复盘`
    : { pre: "盘前", auction: "集合竞价", trading: "交易中", noon: "午间休市", closed: "已收盘" }[phase];
  const liveCls = phase === "trading" || phase === "auction" ? "live" : "idle";
  const pace = volIsTradingHours() ? "行情 3 秒刷新" : "非交易时段，每分钟检查一次";
  $("#volStatus").innerHTML = `<span class="${liveCls}">● ${label}</span> · ${vol.source === "sina" ? "新浪" : "腾讯"}行情 · ${pace}<br>`
    + `最近更新 ${vol.updatedAt ? new Date(vol.updatedAt).toLocaleTimeString() : "--"}`
    + (vol.error ? `<br><span class="err">${esc(vol.error)}</span>` : "")
    + (vol.slowError ? `<br><span class="err">${esc(vol.slowError)}</span>` : "");
}

// ---------- 入口 ----------
function setAppTab(tab) {
  const isVol = tab === "vol";
  document.body.classList.toggle("vol-mode", isVol);
  $$(".apptabs [data-app]").forEach((b) => b.classList.toggle("on", b.dataset.app === tab));
  localStorage.setItem("appTab", tab);
  vol.active = isVol;
  clearTimeout(vol.fastTimer);
  clearTimeout(vol.slowTimer);
  // 帖子区隐藏期间加载的内容没法贴底，切回来时补上；内容不够一屏时继续加载
  if (!isVol && typeof state !== "undefined" && state.view === "thread") {
    if (state.order === "chat" && state.atBottom) scrollToBottom();
    if (sentinelNear()) loadMore();
  }
  if (isVol) {
    volRender();
    volRenderBoards();
    volFastTick(!Object.keys(vol.minutes).length);
    volSlowTick();
  }
}
window.volRefresh = () => { volFastTick(true); volSlowTick(); };

// 市场概况 / 我的自选：两页互斥显示
function volSetPage(page) {
  const changed = vol.page !== page;
  vol.page = page;
  localStorage.setItem("volPage", page);
  $$(".vnav [data-vpage]").forEach((b) => b.classList.toggle("on", b.dataset.vpage === page));
  $("#volPageMarket").classList.toggle("hidden", page !== "market");
  $("#volPageWatch").classList.toggle("hidden", page !== "watch");
  if (page === "watch") volCloseDrawer();
  $("#volMain").scrollTop = 0;
  volRenderGroups();
  if (changed && vol.active) { clearTimeout(vol.slowTimer); if (!vol.slowBusy) volSlowTick(); }
}

function volSeg(sel, cur, apply) {
  $$(`${sel} button`).forEach((b) => {
    b.classList.toggle("active", b.dataset.v === cur);
    b.onclick = () => { $$(`${sel} button`).forEach((x) => x.classList.toggle("active", x === b)); apply(b.dataset.v); };
  });
}

(function volInit() {
  $$(".apptabs [data-app]").forEach((b) => (b.onclick = () => setAppTab(b.dataset.app)));
  volBindSearch();
  const reloadBoards = () => { vol.boards = null; volRenderBoards(); if (!vol.slowBusy) volSlowTick(); };
  volSeg("#volBoardType", vol.boardType, (v) => { vol.boardType = v; localStorage.setItem("volBoardType", v); reloadBoards(); });
  volSeg("#volBoardSort", vol.boardSort, (v) => { vol.boardSort = v; localStorage.setItem("volBoardSort", v); reloadBoards(); });
  let bsTimer = null;
  const bsInput = $("#volBoardSearch");
  const setBoardQuery = (q) => {
    vol.boardQuery = q.trim();
    vol.boardHits = null;
    $("#volBoardSearchClear").classList.toggle("hidden", !vol.boardQuery);
    volRunBoardSearch();
  };
  // 查实时涨跌要请求东财，等停止输入一会儿再查
  bsInput.addEventListener("input", () => { clearTimeout(bsTimer); bsTimer = setTimeout(() => setBoardQuery(bsInput.value), 700); });
  bsInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(bsTimer); setBoardQuery(bsInput.value); } });
  bsInput.addEventListener("keydown", (e) => { if (e.key === "Escape") { bsInput.value = ""; setBoardQuery(""); } });
  $("#volBoardSearchClear").onclick = (e) => { e.preventDefault(); bsInput.value = ""; setBoardQuery(""); };

  $("#volGroupTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-g]");
    if (!b) return;
    if (b.dataset.g === "new") {
      const name = (prompt("新分组名称：", `分组 ${vol.groups.length + 1}`) || "").trim();
      if (!name) return;
      vol.groups.push({ name: name.slice(0, 12), items: [] });
      vol.gsel = vol.groups.length - 1;
    } else vol.gsel = +b.dataset.g;
    volSaveGroups();
    volRenderGroups();
    volRenderBoards();
    volFastTick();
    volLoadBoardQuotes();
  });
  $("#volGroupRename").onclick = (e) => {
    e.preventDefault();
    const g = volGroup();
    const name = (prompt("分组改名为：", g.name) || "").trim();
    if (name) { g.name = name.slice(0, 12); volSaveGroups(); volRenderGroups(); }
  };
  $("#volGroupDelete").onclick = (e) => {
    e.preventDefault();
    if (vol.groups.length <= 1) return toast("至少保留一个分组");
    const g = volGroup();
    if (!confirm(`删除分组「${g.name}」？里面的 ${g.items.length} 只股票会一起移出`)) return;
    vol.groups.splice(vol.gsel, 1);
    vol.gsel = 0;
    volSaveGroups();
    volRenderGroups();
  };
  $$(".vnav [data-vpage]").forEach((b) => (b.onclick = () => volSetPage(b.dataset.vpage)));
  $("#volWatchTable").addEventListener("click", (e) => {
    const h = e.target.closest("th[data-sort]");
    if (h) {
      // 第一次点降序（名称升序），再点反过来，第三次恢复分组里的原顺序
      const k = h.dataset.sort, s = vol.watchSort, first = k === "name" ? 1 : -1;
      vol.watchSort = s.key !== k ? { key: k, dir: first } : s.dir === first ? { key: k, dir: -first } : { key: "", dir: -1 };
      localStorage.setItem("volWatchSort", JSON.stringify(vol.watchSort));
      return volRenderGroups();
    }
    const board = e.target.closest("tr[data-board]");
    if (board) return volOpenBoard(board.dataset.board, board.dataset.name, "watch");
    const row = e.target.closest("tr[data-code]");
    if (row) volOpenStock(row.dataset.code, "", null, "watch");
  });
  $("#volDetailRemove").onclick = (e) => {
    e.preventDefault();
    const d = vol.panels.watch.state;
    if (!d) return;
    const top = d.fromBoard || d;
    volRemoveFromGroup(volGroup(), top.code);
    volCloseDetail();
  };
  $("#volDetailClose").onclick = volCloseDetail;
  $("#volIndices").addEventListener("click", (e) => { const c = e.target.closest(".vic[data-code]"); if (c) volOpenStock(c.dataset.code); });
  $("#volBoards").addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      const g = volGroup(), code = star.dataset.star;
      if (volGroupHas(g, code)) volRemoveFromGroup(g, code);
      else volAddToGroup(vol.gsel, { type: "board", code, name: star.closest("tr").dataset.name });
      return volRenderBoards();
    }
    const r = e.target.closest("tr[data-board]");
    if (r) volOpenBoard(r.dataset.board, r.dataset.name);
  });
  $("#volDrawerClose").onclick = volCloseDrawer;
  for (const [key, p] of Object.entries(vol.panels)) {
    $(p.back).onclick = (e) => {
      e.preventDefault();
      const d = p.state;
      if (d && d.fromBoard) { p.state = d.fromBoard; volRenderPanel(key); }
    };
    $(p.body).addEventListener("click", (e) => {
      const d = p.state;
      if (!d) return;
      if (e.target.closest(".vd-add button")) {
        const gi = +$(p.body).querySelector(".vd-add select").value;
        const item = d.type === "board" ? { type: "board", code: d.code, name: d.name }
          : { type: "stock", code: d.code, name: (vol.snap[d.code] || {}).name || d.name || "" };
        volAddToGroup(gi, item);
        volRenderBoards();
        return volRenderPanel(key);
      }
      const tab = e.target.closest(".vd-tabs [data-view]");
      if (tab && d.type === "stock") { d.view = tab.dataset.view; p.chartSig = null; return volRenderPanel(key); }
      const r = e.target.closest("tr[data-code]");
      if (r && d.type === "board") volOpenStock(r.dataset.code, r.dataset.name, d, key);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !vol.active || (e.target.closest && e.target.closest("input"))) return;
    if (vol.panels.drawer.state) volCloseDrawer();
    else if (vol.page === "watch" && vol.panels.watch.state) volCloseDetail();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && vol.active) { volFastTick(); volSlowTick(); } });
  $("#themeSel").addEventListener("change", () => { if (vol.active) { volRender(); volRenderBoards(); } });
  volSetPage(new URLSearchParams(location.search).get("vpage") || vol.page);
  const qs = new URLSearchParams(location.search).get("tab");
  setAppTab(qs === "vol" || (!qs && localStorage.getItem("appTab") === "vol") ? "vol" : "nga");
})();
