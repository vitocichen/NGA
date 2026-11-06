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
function smile(group, name) {
  const g = (window.SMILES || {})[group];
  const f = g && g[name];
  return f ? `<img class="smile" src="${SMILE_BASE}${f}" alt="${esc(name)}" title="${esc(name)}">` : `<span class="smile-txt">[${name}]</span>`;
}
