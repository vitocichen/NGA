"use strict";
// 楼层正文渲染（NGA BBCode → HTML），电脑版和手机版共用。表情表放在 window.SMILES。

const ATTACH_BASE = "https://img.nga.cn/attachments/";
const SMILE_BASE = "https://img4.nga.cn/ngabbs/post/smile/";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");

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
// [pid=楼ID,tid,页码] / [tid=帖子号]：带上跳转信息，阅读器拦截点击后在本页定位；拦截不了时仍能在 NGA 打开
function postLink(kind, id, args, text, cls) {
  const [, tid, page] = String(args || "").split(",");
  const isPid = kind.toLowerCase() === "pid" && id !== "0";
  const data = isPid ? `data-jpid="${id}" data-jtid="${esc(tid || "")}" data-jpage="${esc(page || "")}"`
    : `data-jpid="0" data-jtid="${esc(kind.toLowerCase() === "tid" ? id : tid || "")}" data-jpage="1"`;
  const href = isPid ? `pid=${id}` : `tid=${kind.toLowerCase() === "tid" ? id : tid}`;
  return `<a class="qjump${cls ? " " + cls : ""}" ${data} href="https://bbs.nga.cn/read.php?${href}" target="_blank" title="跳到被引用的楼层">${text}</a>`;
}
// 引用框 / 回复条整块可点：跳转信息放在容器上，用户名单独可点（只看此人）
function jumpAttrs(kind, id, args) {
  return postLink(kind, id, args, "", "").match(/data-jpid="[^"]*" data-jtid="[^"]*" data-jpage="[^"]*"/)[0];
}
function userTag(uid, name) {
  return uid ? `<span class="at" data-uid="${uid}" title="只看此人">${name}</span>` : `<span class="at">${name}</span>`;
}
// 点击引用框/回复条时的跳转目标；点到用户名、普通链接、图片、折叠标题或正在选中文字时不跳
function jumpTargetOf(e, curTid) {
  if (e.target.closest(".at[data-uid], .uname[data-uid], a:not(.qjump), .pimg, summary")) return null;
  if (String(window.getSelection() || "")) return null;
  const el = e.target.closest(".qlink[data-jpid], a.qjump[data-jpid]");
  if (!el || (el.dataset.jtid && el.dataset.jtid !== curTid)) return null;
  const pid = el.dataset.jpid, page = parseInt(el.dataset.jpage, 10);
  if (pid === "0") return { lou: 0 };
  return page ? { pid, page } : null;
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
  s = s.replace(/\[b\]\s*Reply to \[(pid|tid)=(\d+)([^\]]*)\][\s\S]*?\[\/\1\]\s*Post by \[uid=?(\d*)\]([\s\S]*?)\[\/uid\]\s*\(([^)]*)\)([\s\S]*?)\[\/b\]/gi,
    (m, k, id, args, uid, name, t, rest) => `<div class="replyto qlink" ${jumpAttrs(k, id, args)} title="点击跳到原楼层">回复 ${userTag(uid, `@${name}`)} <span class="t">${t}</span><span class="qgo">原楼 ›</span></div>${rest.replace(/^\s+/, "")}`);
  // 引用头：[pid=..]Reply[/pid] [b]Post by [uid=..]name[/uid] (time):[/b]
  s = s.replace(/\[(pid|tid)=(\d+)([^\]]*)\][\s\S]*?\[\/\1\]\s*\[b\]\s*Post by \[uid=?(\d*)\]([\s\S]*?)\[\/uid\]\s*\(([^)]*)\):?\s*\[\/b\]/gi,
    (m, k, id, args, uid, name, t) => `<div class="qhead" ${jumpAttrs(k, id, args)}>${userTag(uid, name)} <span class="t">${t}</span><span class="qgo">跳到原楼 ›</span></div>`);

  s = s.replace(/\[pid=(\d+)([^\]]*)\]([\s\S]*?)\[\/pid\]/gi, (m, id, args, t) => postLink("pid", id, args, t === "Reply" ? "回复" : t, ""));
  s = s.replace(/\[tid=(\d+)[^\]]*\]([\s\S]*?)\[\/tid\]/gi, (m, id, t) => `<a href="https://bbs.nga.cn/read.php?tid=${id}" target="_blank">${t === "Topic" ? "主题" : t}</a>`);
  s = s.replace(/\[uid=?(\d*)\]([\s\S]*?)\[\/uid\]/gi, (m, uid, n) => userTag(uid, n));
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
    [/\[quote\]((?:(?!\[quote\])[\s\S])*?)\[\/quote\]/gi, (m, b) => {
      b = b.replace(/^\n+|\n+$/g, "");
      const j = b.match(/^<div class="qhead" (data-jpid="[^"]*" data-jtid="[^"]*" data-jpage="[^"]*")>/);
      return j ? `<div class="quote qlink" ${j[1]} title="点击跳到原楼层">${b}</div>` : `<div class="quote">${b}</div>`;
    }],
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
function smile(group, name) {
  const g = (window.SMILES || {})[group];
  const f = g && g[name];
  return f ? `<img class="smile" src="${SMILE_BASE}${f}" alt="${esc(name)}" title="${esc(name)}">` : `<span class="smile-txt">[${name}]</span>`;
}
