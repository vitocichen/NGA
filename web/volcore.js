"use strict";
// A 股行情的纯计算部分（电脑版 vol.js 和手机版 stock.js 共用）：分钟轴、成交额同比、全天预测、格式化。
// 依赖全局的 vol.snap / vol.minutes。成交额同比与全天预测的算法参考 ashare-volpulse（MIT，https://github.com/LostMoonkin/ashare-volpulse）。

const VOL_TOTAL = { key: "TOTAL", name: "沪深两市", codes: ["sh000001", "sz399106"], priceCode: "sh000001" };
const VOL_INDICES = [
  { key: "sh000001", name: "上证指数", codes: ["sh000001"] },
  { key: "sz399001", name: "深证成指", codes: ["sz399001"] },
  { key: "sz399006", name: "创业板指", codes: ["sz399006"] },
  { key: "sh000680", name: "科创综指", codes: ["sh000680"] },
];
const VOL_LAMBDA = 0.12;

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

// ---------- 格式化 ----------
const volAmt = (v) => (v == null ? "-" : Math.abs(v) >= 1e12 ? (v / 1e12).toFixed(2) + " 万亿" : (v / 1e8).toFixed(Math.abs(v) >= 1e10 ? 0 : Math.abs(v) >= 1e9 ? 1 : 2) + " 亿");
const volSign = (v, d = 1) => (v == null ? "-" : (v > 0 ? "+" : "") + v.toFixed(d));
const volCls = (v) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
const volPx = (v) => (v == null ? "-" : v.toFixed(2));
