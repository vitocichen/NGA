"use strict";
// 一键判断：按 NGA 楼主「-阿狼-」2026-11 对海外链的说法，给当前自选分组里的海外链股票出加减仓信号。
// 他的原话：海外链每个压力位都有很大抛压；放量转缩量上板 = 压力位消化了，没缩量上板 = 还有换手筹码；
// 最后一个压力位突破、加速拉升 = 这波反弹结束；高开吃惯性溢价；大盘一旦缩量，海外链的压制就是全市场的压制。

// 海外链：[优先级, 说明]，优先级 1 最先减（他最看空的 CPO / 光纤），3 最后减（PCB，他认为海外链里最强）
const JUDGE_HW = {
  sz300394: [1, "CPO 光器件"], sh600105: [1, "光纤"], sz300308: [1, "光模块（大光）"], sz300502: [1, "光模块（二光）"],
  sz300570: [1, "光器件"], sh688498: [1, "光芯片"], sz000988: [1, "光模块"], sh603083: [1, "光模块"],
  sh688008: [2, "内存接口"], sz002156: [2, "AMD 封测"], sz002851: [2, "AI 服务器电源"], sz000657: [2, "PCB 钻针"],
  sh601138: [2, "AI 服务器"],
  sz002463: [3, "AI PCB"], sz300476: [3, "AI PCB"], sz002916: [3, "PCB"],
};
// 他看好的方向：拿住不追高，等洗盘的黑 K 再加
const JUDGE_MAIN = {
  sh588170: "半导体 ETF（他的主线）", sh688126: "半导体材料", sz300346: "光刻胶", sz300054: "光刻胶 / CMP",
  sz300236: "光刻胶", sh603650: "光刻胶", sh603306: "光刻胶",
};
const JUDGE_REF = { comm: "sh515880", semi: "sh588170", lead: ["sz300308", "sz300502"] };
const JUDGE_LEVELS = ["持有观察", "减 1/3", "减 1/2", "减 2/3"];
const judge = { busy: false, result: null, error: "" };

function judgeLimit(code, prev) {
  if (!prev) return null;
  const pct = /^(sz30|sh68|bj)/.test(code) ? (code.startsWith("bj") ? 0.3 : 0.2) : 0.1;
  return Math.round(prev * (1 + pct) * 100) / 100;
}

// 日 K 里今天之前的部分：昨日最高、3 日前收盘，以及近 60 日下跌段（用来找压力位台阶）
function judgePressure(items, today) {
  const hist = items.filter((r) => r.date.replace(/-/g, "") < today);
  if (!hist.length) return null;
  const last = hist[hist.length - 1], before = hist[hist.length - 2];
  const c3 = hist.length >= 3 ? hist[hist.length - 3].close : null;
  return { p1: last.high, c3, hist: hist.slice(-60), lastPct: before ? (last.close / before.close - 1) * 100 : null };
}

// 压力位台阶：下跌途中留下套牢盘的价位。来源有四类：
//   跳空缺口（回补时有抛压）、横盘平台（连续 5 天振幅 ≤13% 后被跌破，平台里买的人全被套）、
//   成交密集区（下跌段成交量集中的价格带）、60 日均线。
// 每个价位取开始有人解套卖出的位置作代表价（缺口下沿、平台最低点），代表价相距 3% 内的合并；
// 离现价 40% 以上的是上一轮下跌留下的，这波反弹基本够不到，不计入。
const PRESS_FAR = 1.4, PRESS_BOX = 0.13, PRESS_MERGE = 1.03;
function judgeLadder(kp, price) {
  const h = kp && kp.hist;
  if (!h || h.length < 10) return [];
  let pk = 0;
  h.forEach((r, i) => { if (r.high > h[pk].high) pk = i; });
  const dec = h.slice(pk);
  const md = (d) => d.slice(5).replace("-", "/");
  const lv = [];
  for (let i = 1; i < dec.length; i++) {
    if (dec[i].high < dec[i - 1].low) lv.push({ at: dec[i].high, top: dec[i - 1].low, src: `${md(dec[i].date)} 跳空缺口` });
  }
  for (let i = 0; i + 5 < dec.length; i++) {
    const box = dec.slice(i, i + 5);
    const lo = Math.min(...box.map((r) => r.low)), hi = Math.max(...box.map((r) => r.high));
    if (hi / lo - 1 <= PRESS_BOX && dec[i + 5].close < lo) {
      lv.push({ at: lo, top: hi, src: `${md(box[0].date)}～${md(box[4].date)} 平台` });
      i += 4;
    }
  }
  // 成交密集区：下跌段按现价的 3% 分档统计成交量，单档占 6% 以上的算一级（量越大套住的人越多）
  const step = price * 0.03, bins = new Map();
  let volSum = 0;
  for (const r of dec) {
    const k = Math.floor((r.high + r.low + r.close) / 3 / step);
    bins.set(k, (bins.get(k) || 0) + r.volume);
    volSum += r.volume;
  }
  for (const [k, v] of bins) {
    if (volSum > 0 && v / volSum >= 0.06) lv.push({ at: k * step, top: (k + 1) * step, src: `成交密集区（占 ${Math.round((v / volSum) * 100)}%）` });
  }
  if (h.length >= 60) {
    const ma60 = h.reduce((s, r) => s + r.close, 0) / h.length;
    lv.push({ at: ma60, top: ma60, src: "60 日均线" });
  }
  // 正在测试的（现价已进入区间）也算一级，用区间上沿判断是否已经过去
  const zones = [];
  for (const x of lv.filter((x) => x.top > price && x.at < price * PRESS_FAR).sort((a, b) => a.at - b.at)) {
    const z = zones[zones.length - 1];
    if (z && x.at <= z.lo * PRESS_MERGE) { z.hi = Math.max(z.hi, x.at); z.src.push(x.src); }
    else zones.push({ lo: x.at, hi: x.at, top: x.top, src: [x.src] });
  }
  return zones.length > 5 ? [...zones.slice(0, 4), zones[zones.length - 1]] : zones;
}
function judgeZoneText(z) {
  const hi = z.src.length === 1 ? z.top : z.hi;
  return hi - z.lo < z.lo * 0.005 ? volPx(z.lo) : `${volPx(z.lo)}～${volPx(hi)}`;
}

// 单只股票当下的盘面信号
function judgeSignals(code, s, kp) {
  const lim = judgeLimit(code, s.prev);
  const sealed = lim != null && s.price >= lim - 0.005;
  // 腾讯的成交量多数是「手」（后端已 ×100），科创板等是「股」：均价离现价太远就是单位不同
  let vwap = s.volume > 0 && s.amount > 0 ? s.amount / s.volume : null;
  if (vwap != null && s.price && vwap < s.price * 0.2) vwap *= 100;
  const m = volCompute({ codes: [code] });
  const ladder = judgeLadder(kp, s.price);
  const first = ladder[0] || null, lastZone = ladder[ladder.length - 1] || null;
  const limPct = lim && s.prev ? (lim / s.prev - 1) * 100 : 10;
  // 反弹尾声 = 他说的「最后一个压力位突破、加速拉升」：碰到最后一级压力区（或上方已没有压力）+ 连续加速 + 放巨量
  const gain3 = kp && kp.c3 ? (s.price / kp.c3 - 1) * 100 : null;
  const tailWhy = kp ? {
    lastPress: !lastZone || s.price >= lastZone.lo * 0.97,
    accel: (gain3 != null && gain3 >= 25) || (kp.lastPct >= limPct - 1.5 && s.pct >= limPct - 1.5),
    hugeVol: m.ready && m.ratio != null && m.ratio >= 50,
  } : null;
  return {
    gap: s.open && s.prev ? (s.open / s.prev - 1) * 100 : null,
    vwap,
    below: vwap != null && s.price < vwap * 0.998,
    sealed,
    broke: lim != null && s.high >= lim - 0.005 && !sealed,
    fade: s.high && s.prev ? ((s.high - s.price) / s.prev) * 100 : 0,
    breakP1: kp && s.price > kp.p1,
    ladder, first, lastZone,
    press: first ? first.lo : null,
    inPress: !!first && s.price >= first.lo,
    nearPress: !!first && (first.lo - s.price) / s.price < 0.02,
    // 大涨：涨幅达到涨停幅度的 6 成（主板 6%、创业板 / 科创板 12%）。前一天涨停时最高价≈收盘价，
    // 只看「突破昨日最高」的话涨 0.2% 也算强，必须加这个门槛
    bigUp: s.pct >= limPct * 0.6,
    // 离涨停价不到 1%（比如天孚 160.52 vs 涨停 160.79）：和封板一样对待
    nearLimit: lim != null && !sealed && s.price >= lim * 0.99,
    gain3,
    tailWhy,
    tail: !!tailWhy && tailWhy.lastPress && tailWhy.accel && tailWhy.hugeVol,
    volRatio: m.ready ? m.ratio : null,
  };
}

// 压力位的说明：正在测试哪一级、离最后一级还有多远
function judgePressWhy(g, price) {
  const out = [];
  if (g.inPress) out.push(`正在测试压力 ${judgeZoneText(g.first)}（${g.first.src.join("、")}）`);
  if (g.lastZone && !(g.inPress && g.lastZone === g.first)) {
    out.push(`最后压力 ${judgeZoneText(g.lastZone)}，还差 ${((g.lastZone.lo / price - 1) * 100).toFixed(0)}%`);
  }
  return out;
}

function judgeStock(code, s, kp, ctx) {
  const prio = JUDGE_HW[code][0];
  const g = judgeSignals(code, s, kp);
  const why = [];
  let level, verdict, upside = true, calm = false;
  const back = g.first ? judgeZoneText(g.first) : volPx(kp && kp.p1);
  if (g.gap != null && g.gap < -0.5 && s.price <= s.prev && s.pct <= -5 && g.below) {
    // 风控（楼主没说过，是这里加的）：低开低走跌超 5% 还在均价线下方，不能一股不动
    level = ctx.leadWeak ? 2 : 1;
    upside = false;
    verdict = `低开低走破位：先减 ${level === 2 ? "1/2" : "1/3"} 控制风险，剩下的等反弹到 ${back} 附近再减（此条为风控补充，非楼主原话）`;
    why.push(`低开 ${volSign(g.gap)}%`, `现跌 ${volSign(s.pct)}%`, "在均价线下方");
    if (ctx.leadWeak) why.push("大光 / 二光也走弱");
  } else if (g.gap != null && g.gap < -0.5 && s.price <= s.prev) {
    level = 0;
    upside = false;
    verdict = `低开，惯性溢价没出现：不割，等反弹到 ${back} 附近再减`;
    why.push(`低开 ${volSign(g.gap)}%`);
  } else if (g.broke || g.below || g.fade >= 3) {
    level = [3, 2, 2][prio - 1];
    verdict = "冲高走弱：抛压没消化，坚决减";
    if (g.broke) why.push("炸板（摸过涨停没封住）");
    if (g.below) why.push(`跌破分时均价线 ${volPx(g.vwap)}`);
    if (g.fade >= 3) why.push(`冲高回落 ${g.fade.toFixed(1)} 个点`);
  } else if (g.tail) {
    level = [3, 2, 2][prio - 1];
    verdict = "反弹尾声（最后一个压力位突破 + 加速 + 巨量）：哪怕封板也要分批卖";
    why.push(g.lastZone ? `碰到最后压力 ${judgeZoneText(g.lastZone)}` : "上方已没有压力位", g.gain3 >= 25 ? `3 日累计 ${volSign(g.gain3, 0)}%` : "连续涨停", `比昨天同时放量 ${volSign(g.volRatio, 0)}%`);
  } else if (g.sealed || g.nearLimit) {
    // 封住（或离涨停不到 1%）当天不卖：他说缩量上板是压力位消化了，并建议吃下一个交易日的惯性溢价
    level = 0;
    upside = false;
    const shrink = g.volRatio != null && g.volRatio < 0;
    const what = g.sealed ? "封板" : "几乎涨停";
    verdict = shrink ? `缩量${what}，压力位消化了：今天拿着，下一交易日高开吃溢价，再按开盘规则判断`
      : `${what}但没缩量：今天拿着，下一交易日高开后冲不上去、跌破均价线就减`;
    if (g.nearLimit) why.push(`离涨停价只差 ${((judgeLimit(code, s.prev) / s.price - 1) * 100).toFixed(1)}%`);
    why.push(g.volRatio == null ? what : shrink ? `缩量${what}（压力位消化了）` : `${what}但比昨天同时放量 ${volSign(g.volRatio, 0)}%（还有换手筹码）`);
    why.push(...judgePressWhy(g, s.price));
  } else if (g.breakP1 && g.fade < 1 && g.bigUp) {
    // 没封死涨停还卖得出去，所以大盘缩量、龙头走弱照样加档（upside 保持 true）
    level = 0;
    verdict = "大涨且在最高点附近：接近封板的强度，先拿着，到冲高回落或跌破均价线再卖";
    why.push(`涨 ${volSign(s.pct)}%，突破昨日最高 ${volPx(kp.p1)}`, `距今日最高仅 ${g.fade.toFixed(1)} 个点`);
    why.push(...judgePressWhy(g, s.price));
  } else if (g.breakP1 && g.bigUp) {
    level = 1;
    verdict = "突破昨日最高后有回落：先减 1/3 锁利润，剩下的到冲高回落 3 个点或跌破均价线再卖";
    why.push(`突破昨日最高 ${volPx(kp.p1)}`, `已从最高回落 ${g.fade.toFixed(1)} 个点`);
  } else if (s.price > s.prev && g.nearPress) {
    level = 1;
    verdict = `冲到压力位 ${judgeZoneText(g.first)} 附近：先减 1/3`;
    why.push(g.inPress ? `正在压力区 ${judgeZoneText(g.first)} 里（${g.first.src.join("、")}）`
      : `距压力 ${judgeZoneText(g.first)} 还有 ${(((g.first.lo - s.price) / s.price) * 100).toFixed(1)}%`);
  } else {
    level = 0;
    calm = true;
    verdict = "盘面平稳：先拿着，盯压力位和均价线";
  }
  const base = level;
  const env = [];
  if (upside) {
    if (ctx.mktShrink) { level++; env.push("大盘缩量（海外链冲高就是卖点）"); }
    if (ctx.leadWeak) { level++; env.push("大光 / 二光走弱"); }
    // 半导体强于通信是相对强弱（当天通信可能也大涨），只给本身走势平平的股票加档
    if (calm && level === 0 && ctx.semiStrong && s.price > s.prev) { level++; env.push("半导体强于通信，资金在切回国产"); }
  }
  why.push(...env);
  level = Math.min(level, 3);
  if (base === 0 && level > 0) verdict = `个股本身不弱，但${env.map((x) => x.replace(/（.*）/, "")).join("、")}：趁还在涨先${JUDGE_LEVELS[level]}`;
  return { code, name: s.name, prio, note: JUDGE_HW[code][1], s, kp, g, level, verdict, why };
}

async function judgeRun() {
  if (judge.busy) return;
  judge.busy = true;
  judge.error = "";
  judgeRender();
  try {
    const stocks = volGroup().items.filter((x) => !volIsBoard(x));
    const hw = stocks.map((x) => x.code).filter((c) => JUDGE_HW[c]);
    const leads = JUDGE_REF.lead;
    const minuteCodes = [...new Set([...VOL_TOTAL.codes, ...hw, ...leads])];
    const codes = [...new Set([...minuteCodes, ...stocks.map((x) => x.code), JUDGE_REF.comm, JUDGE_REF.semi])];
    const [snap, mins, ...ks] = await Promise.all([
      volApi("snapshot", { codes: codes.join(",") }),
      volApi("minutes", { codes: minuteCodes.join(",") }),
      ...[...new Set([...hw, ...leads])].map((c) => volApi("kline", { code: c, period: "day" }).then((r) => [c, r.items]).catch(() => [c, null])),
    ]);
    vol.snap = { ...vol.snap, ...snap.items };
    Object.assign(vol.minutes, mins.items);
    const S = snap.items;
    const time = Object.values(S).map((x) => x.time).filter(Boolean).sort().pop() || "";
    const today = time.slice(0, 8);
    const K = Object.fromEntries(ks.map(([c, items]) => [c, items ? judgePressure(items, today) : null]));

    const total = volCompute(VOL_TOTAL);
    const comm = S[JUDGE_REF.comm], semi = S[JUDGE_REF.semi];
    const leadSig = leads.filter((c) => S[c]).map((c) => ({ name: S[c].name, s: S[c], g: judgeSignals(c, S[c], K[c]) }));
    const ctx = {
      mktRatio: total.ready ? total.ratio : null,
      mktShrink: total.ready && total.ratio != null && total.ratio < 0,
      semiStrong: comm && semi && semi.pct > comm.pct,
      leadWeak: leadSig.length > 0 && leadSig.filter((x) => x.g.below || x.g.broke || x.g.fade >= 3).length >= Math.ceil(leadSig.length / 2),
      comm, semi, leadSig,
    };
    const rows = hw.filter((c) => S[c]).map((c) => judgeStock(c, S[c], K[c], ctx)).sort((a, b) => b.level - a.level || a.prio - b.prio);
    const others = stocks.filter((x) => !JUDGE_HW[x.code]).map((x) => ({ code: x.code, name: (S[x.code] && S[x.code].name) || x.name, s: S[x.code], main: JUDGE_MAIN[x.code] }));
    judge.result = { time, phase: time ? volClock(time).phase : "", ctx, rows, others };
  } catch (e) {
    judge.error = e.message;
  } finally {
    judge.busy = false;
    judgeRender();
  }
}

const judgeTag = (text, cls = "") => `<span class="jtag ${cls}">${esc(text)}</span>`;

function judgeLeadText(x) {
  const g = x.g;
  const state = g.sealed ? "封板" : g.broke ? "炸板" : g.below ? "跌破均价线" : g.fade >= 3 ? "冲高回落" : "均价线上方";
  const bad = g.broke || g.below || g.fade >= 3;
  return `${esc(x.name)} <b class="${volCls(x.s.pct)}">${volSign(x.s.pct, 2)}%</b> ${judgeTag(state, bad ? "bad" : "good")}`;
}

function judgeRender() {
  const box = $("#volJudge");
  if (!box || box.classList.contains("hidden")) return;
  $("#volJudgeRun").disabled = judge.busy;
  $("#volJudgeRun").textContent = judge.busy ? "判断中…" : "重新判断";
  const r = judge.result;
  if (judge.error) { $("#volJudgeBody").innerHTML = `<div class="vempty err">判断失败：${esc(judge.error)}</div>`; return; }
  if (!r) { $("#volJudgeBody").innerHTML = '<div class="vempty">正在拉取最新行情…</div>'; return; }
  const c = r.ctx;
  const phaseNote = r.phase === "trading" ? "" : r.phase === "closed" || r.phase === "pre"
    ? '<div class="jnote">现在不是交易时段，下面是按最近一个交易日收盘数据的复盘。周一 9:25 竞价结束后、开盘后各点一次，看实时结论。</div>'
    : '<div class="jnote">集合竞价 / 午休中，结论只作预判。</div>';
  const env = `<div class="jenv">
    <div><span>两市成交 vs 昨天同时</span>${c.mktRatio == null ? "-" : `<b class="${volCls(c.mktRatio)}">${c.mktRatio >= 0 ? "放量" : "缩量"} ${volSign(c.mktRatio)}%</b> ${judgeTag(c.mktShrink ? "缩量：海外链冲高就是卖点" : "放量：可以分几次慢慢卖", c.mktShrink ? "bad" : "good")}`}</div>
    <div><span>通信ETF vs 半导体ETF</span>${c.comm && c.semi ? `<b class="${volCls(c.comm.pct)}">${volSign(c.comm.pct, 2)}%</b> vs <b class="${volCls(c.semi.pct)}">${volSign(c.semi.pct, 2)}%</b> ${judgeTag(c.semiStrong ? "半导体更强：资金切回国产" : "通信更强：留意是否加速见顶", c.semiStrong ? "bad" : "")}` : "-"}</div>
    <div><span>大光 / 二光</span>${c.leadSig.map(judgeLeadText).join("　") || "-"}</div>
  </div>`;
  const rows = r.rows.length ? `<table class="vtable jtable"><thead><tr><th>股票</th><th>现价 / 涨跌</th><th>开盘</th><th>均价线</th><th>上方压力位（从近到远）</th><th>判断依据</th><th>建议</th></tr></thead><tbody>${
    r.rows.map((x) => `<tr>
      <td><b>${esc(x.name)}</b><div class="vmuted">${esc(x.note)} · 第 ${x.prio} 批减</div></td>
      <td>${volPx(x.s.price)}<div class="${volCls(x.s.pct)}">${volSign(x.s.pct, 2)}%</div></td>
      <td>${volPx(x.s.open)}<div class="${volCls(x.g.gap)}">${x.g.gap == null ? "" : volSign(x.g.gap, 1) + "%"}</div></td>
      <td>${volPx(x.g.vwap)}<div class="${x.g.below ? "down" : "up"}">${x.g.vwap == null ? "" : x.g.below ? "在下方" : "在上方"}</div></td>
      <td class="jpress">${x.g.ladder.length ? x.g.ladder.map((z, i) => `<div title="${esc(z.src.join("、"))}"><span class="vmuted">${i === 0 ? "第一" : i === x.g.ladder.length - 1 ? "最后" : `第${i + 1}`}</span> ${judgeZoneText(z)}${i === 0 && x.g.inPress ? " ←正在测试" : ""}</div>`).join("")
        : '<span class="vmuted">上方 40% 内没有压力位</span>'}<div class="vmuted">昨日最高 ${x.kp ? volPx(x.kp.p1) : "-"}</div></td>
      <td class="jwhy">${x.why.map((w) => judgeTag(w)).join("") || '<span class="vmuted">无明显信号</span>'}</td>
      <td class="jact"><span class="jlevel l${x.level}">${JUDGE_LEVELS[x.level]}</span><div>${esc(x.verdict)}</div></td>
    </tr>`).join("")}</tbody></table>` : '<div class="vempty">当前分组里没有识别出海外链股票（先在「我的自选」里切到你的持仓分组）。</div>';
  const others = r.others.length ? `<div class="jothers"><b>其他持仓</b>${r.others.map((o) => `<div><span>${esc(o.name)}</span>${o.s ? ` <b class="${volCls(o.s.pct)}">${volSign(o.s.pct, 2)}%</b>` : ""} — ${
    o.main ? `${esc(o.main)}：拿住，不追高，等洗盘的黑 K 再加` : "不在海外链规则内，按你自己的逻辑处理"}</div>`).join("")}</div>` : "";
  const rules = `<details class="jrules"><summary>判断规则（按楼主原话整理）</summary><ul>
    <li><b>低开</b>：惯性溢价没出现，不割，等下一次反弹到压力位再减。<b>风控补充（楼主没说过）</b>：低开低走跌超 5% 且在均价线下方 → 先减 1/3，大光二光也弱则减 1/2。</li>
    <li><b>冲高走弱</b>：炸板、跌破分时均价线、或从最高点回落 ≥3 个点 → 抛压没消化，坚决减（光模块 / 光纤减 2/3，其他减 1/2）。</li>
    <li><b>封住涨停，或离涨停价不到 1%</b>：当天不卖（大盘、龙头、板块强弱都不影响），下一交易日高开吃惯性溢价，再按开盘情况判断。缩量封 = 压力位消化了；放量封 = 还有换手筹码，第二天封不住就减。</li>
    <li><b>大涨（涨停幅度的 6 成以上）且在最高点 1 个点内</b>：接近封板，先拿着；<b>大涨后从最高回落 1～3 个点</b> → 先减 1/3 锁利润。这两种没封死、还卖得出去，大盘缩量 / 龙头走弱照样加档。涨幅不到 6 成的按普通情况处理。</li>
    <li><b>压力位</b>：近 60 日最高点之后的下跌段里，留下套牢盘的价格区间——跳空缺口、横盘平台（连续 5 天振幅 ≤13% 后被跌破，取平台最低点）、成交密集区（下跌段按 3% 分档、单档成交占 6% 以上）、60 日均线；相距 3% 内合并，离现价 40% 以上的视为这波够不到。最近的一级是「第一」，最高的一级是「最后一个压力位」。</li>
    <li><b>反弹尾声</b>（他说的「最后一个压力位突破、加速拉升」）：碰到最后一级压力区（3% 内）+ 连续两个涨停或 3 日涨 25% 以上 + 比昨天同时放量 50% 以上，三条同时满足 → 哪怕封板也分批卖（光模块 / 光纤减 2/3，其他减 1/2）。</li>
    <li><b>冲到第一压力位附近</b>（距离 2% 内或已进入压力区）、但没封板也没收在最高点 → 先减 1/3。</li>
    <li><b>加一档</b>：大盘比昨天同时缩量；大光、二光有一半以上走弱。<b>半导体强于通信</b>只给本身走势平平（没大涨、没走弱）的股票加档——它是相对强弱，通信也大涨的日子不算卖点。</li>
    <li>减仓顺序：第 1 批 光模块、光纤 → 第 2 批 存储接口、封测、电源、钻针 → 第 3 批 PCB。</li>
  </ul></details>`;
  $("#volJudgeBody").innerHTML = `${phaseNote}${env}${rows}${others}${rules}
    <div class="jnote">数据时间 ${r.time ? `${volDateText(r.time.slice(0, 8))} ${r.time.slice(8, 10)}:${r.time.slice(10, 12)}:${r.time.slice(12, 14)}` : "-"}。这是把楼主的观点机械化成规则后的结果，<b>不是投资建议</b>；减仓比例是示意，实际按你的成本和仓位定。</div>`;
}

function judgeOpen() {
  $("#volJudge").classList.remove("hidden");
  judgeRender();
  judgeRun();
}

function judgeBind() {
  $("#volJudgeBtn").onclick = (e) => { e.preventDefault(); judgeOpen(); };
  $("#volJudgeRun").onclick = judgeRun;
  $("#volJudgeClose").onclick = () => $("#volJudge").classList.add("hidden");
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#volJudge").classList.add("hidden"); });
}
judgeBind();
