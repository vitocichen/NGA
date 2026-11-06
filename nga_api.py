import json
import math
import os
import random
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

HOST = "https://bbs.nga.cn"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
SMILE_JS = "https://img4.nga.cn/common_res/js_bbscode_core.js"

# 打包成 exe 后用户数据放在 exe 旁边，而不是 PyInstaller 的临时解包目录
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
    RES_DIR = getattr(sys, "_MEIPASS", BASE_DIR)
else:
    BASE_DIR = RES_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
NAMES_FILE = os.path.join(DATA_DIR, "names.json")
SMILES_FILE = os.path.join(DATA_DIR, "smiles.json")
COOKIE_FILE = os.path.join(DATA_DIR, "cookie.txt")

MAX_CONCURRENCY = 8
LOCATE_FANOUT = 8
LAST_PAGE_TTL = 8


class NgaError(Exception):
    pass


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


_save_lock = threading.Lock()


def _save_json(path, data):
    """缓存文件写失败（例如另一个实例正占用）不应影响读帖。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with _save_lock:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return False
    return True


def _title(text):
    m = re.search(r"<title>(.*?)</title>", text, re.S)
    t = m.group(1).strip() if m else ""
    t = re.sub(r"\s*NGA玩家社区$", "", t)
    m = re.match(r"在 - (.*) - 中的回复$", t)
    return m.group(1) if m else t


class NgaClient:
    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
            # 不带 Referer 时 guestJs 令牌每次都会被判 403
            "Referer": f"{HOST}/",
        })
        if os.path.exists(COOKIE_FILE):
            cookie = open(COOKIE_FILE, encoding="utf-8").read().strip()
            if cookie:
                self.s.headers["Cookie"] = cookie
        self._net_slots = threading.Semaphore(MAX_CONCURRENCY)
        self._token_lock = threading.Lock()
        self._cache = {}
        self._cache_lock = threading.Lock()
        self.names = _load_json(NAMES_FILE, {})
        self._names_dirty = False
        self._names_lock = threading.Lock()
        self._rep_ids = {}
        self._smiles = None

    # ---------- 网络 ----------
    def _fetch(self, url):
        with self._net_slots:
            try:
                r = self.s.get(url, timeout=15)
                text = r.content.decode("gbk", "ignore")
                if r.status_code == 403 and "guestJs=" in text:
                    with self._token_lock:
                        token = re.search(r"guestJs=([^;']+)", text).group(1)
                        self.s.cookies.set("guestJs", token, domain="bbs.nga.cn", path="/")
                        time.sleep(0.5)
                    sep = "&" if "?" in url else "?"
                    r = self.s.get(f"{url}{sep}rand={random.randint(0, 999)}", timeout=15)
                    text = r.content.decode("gbk", "ignore")
            except requests.RequestException as e:
                raise NgaError(f"网络错误：{e}") from e
        return r.status_code, text

    def _fetch_json(self, url):
        status, text = self._fetch(url)
        text = re.sub(r"^\s*window\.script_muti_get_var_store\s*=\s*", "", text)
        try:
            d = json.loads(text, strict=False)
        except ValueError:
            raise NgaError(f"HTTP {status}，返回内容无法解析")
        if isinstance(d, dict) and d.get("error"):
            err = d["error"]
            msg = err.get("0") if isinstance(err, dict) else str(err)
            raise NgaError(f"NGA 拒绝访问：{msg}")
        return d.get("data", d)

    # ---------- 帖子页 ----------
    def page(self, tid, page, authorid=None, fresh=False):
        tid = str(tid)
        authorid = str(authorid) if authorid else ""
        if page != "e":
            key = (tid, authorid, int(page))
            with self._cache_lock:
                hit = self._cache.get(key)
            if hit and not fresh:
                saved_at, data = hit
                if data["page"] < data["pages"] or time.time() - saved_at < LAST_PAGE_TTL:
                    return data

        url = f"{HOST}/read.php?tid={tid}&page={page}&__output=11"
        if authorid:
            url += f"&authorid={authorid}"
        try:
            data = self._normalize(self._fetch_json(url), tid)
        except NgaError as e:
            # 只看楼主时 NGA 的 JSON 输出会在中途截断（每页固定位置），HTML 版完整
            if "无法解析" not in str(e):
                raise
            data = self._page_from_html(tid, page, authorid)
        with self._cache_lock:
            self._cache[(tid, authorid, data["page"])] = (time.time(), data)
        self._flush_names()
        return data

    def locate(self, tid, ts, authorid=None):
        """返回包含时间戳 ts 附近楼层的页码：首楼时间 <= ts 的最后一页。"""
        last = self.page(tid, "e", authorid)
        lo, hi = 1, last["page"]
        if last["posts"] and last["posts"][0]["ts"] <= ts:
            return hi
        hi -= 1

        def first_ts(p):
            d = self.page(tid, p, authorid)
            return d["posts"][0]["ts"] if d["posts"] else ts + 1

        # 每轮并发探测 LOCATE_FANOUT 个等距页码，区间每轮缩小到 1/(N+1)
        with ThreadPoolExecutor(LOCATE_FANOUT) as pool:
            while lo < hi:
                n = min(LOCATE_FANOUT, hi - lo)
                probes = sorted({lo + max(1, round((hi - lo) * (i + 1) / (n + 1))) for i in range(n)})
                for p, t in zip(probes, pool.map(first_ts, probes)):
                    if t <= ts:
                        lo = p
                    else:
                        hi = p - 1
                        break
        return lo

    def _normalize(self, d, tid):
        topic = d.get("__T") or {}
        fid = topic.get("fid") or (d.get("__F") or {}).get("fid")
        if topic.get("authorid") and topic.get("author"):
            self._learn_name(topic["authorid"], topic["author"])

        rows = d.get("__R") or []
        rows = list(rows.values()) if isinstance(rows, dict) else rows
        posts = []
        for r in rows:
            if not isinstance(r, dict) or "lou" not in r:
                continue
            content = r.get("content") or ""
            if not isinstance(content, str):
                content = str(content)
            for uid, name in re.findall(r"\[uid=(\d+)\]([^\[]{1,40})\[/uid\]", content):
                self._learn_name(uid, name)
            attachs = r.get("attachs") or []
            if isinstance(attachs, dict):
                attachs = list(attachs.values())
            posts.append({
                "pid": r.get("pid", 0),
                "lou": r["lou"],
                "authorid": str(r.get("authorid", "")),
                "ts": r.get("postdatetimestamp") or 0,
                "time": r.get("postdate", ""),
                "subject": r.get("subject", ""),
                "content": content,
                "score": r.get("score", 0),
                "alterinfo": r.get("alterinfo", ""),
                "attachs": [a.get("attachurl") for a in attachs
                            if isinstance(a, dict) and a.get("type") == "img" and a.get("attachurl")],
            })

        rep_id = self._rep_id(fid)
        users = {}
        for k, u in (d.get("__U") or {}).items():
            if not isinstance(u, dict) or "uid" not in u:
                continue
            uid = str(u["uid"])
            name = u.get("username") or ""
            if name and not name.startswith("UID:"):
                self._learn_name(uid, name)
            rep = None
            if rep_id and u.get("reputation"):
                for item in str(u["reputation"]).split(","):
                    rk, _, rv = item.partition("_")
                    if rk == rep_id:
                        rep = int(rv)
            avatar = u.get("avatar")
            if not (isinstance(avatar, str) and avatar.startswith("http")):
                avatar = None
            users[uid] = {
                "uid": uid,
                "name": self.names.get(uid) or name or f"UID:{uid}",
                "avatar": avatar,
                "rep": rep,
                "prestige": (u.get("rvrc") or 0) / 10,
                "regdate": u.get("regdate") or 0,
                "money": u.get("money") or 0,
                "postnum": u.get("postnum") or 0,
                "muted": bool(u.get("mute_time")),
            }

        per_page = d.get("__R__ROWS_PAGE") or 20
        total = d.get("__ROWS") or len(posts)
        return {
            "tid": tid,
            "title": topic.get("subject", ""),
            "author": topic.get("author", ""),
            "authorid": str(topic.get("authorid", "")),
            "forum": (d.get("__F") or {}).get("name", ""),
            "fid": fid,
            "lastpost": topic.get("lastpost", 0),
            "page": d.get("__PAGE") or 1,
            "pages": max(1, math.ceil(total / per_page)),
            "per_page": per_page,
            "rows_total": total,
            "posts": posts,
            "users": users,
        }

    _PROC_RE = re.compile(
        r"commonui\.postArg\.proc\(\s*(\d+)\s*,(?:\s*\$\('[^']*'\)\s*,){7}"
        r"\s*[^,]*,[^,]*,\s*(\d+)\s*,\s*(\d+)\s*,"
        r"\s*[^,]*,\s*'(-?\d+)'\s*,\s*(\d+)\s*,\s*'([^']*)'\s*,\s*'(\d*)'\s*,\s*'([^']*)'")

    def _page_from_html(self, tid, page, authorid):
        url = f"{HOST}/read.php?tid={tid}&page={page}"
        if authorid:
            url += f"&authorid={authorid}"
        status, text = self._fetch(url)
        if status != 200:
            raise NgaError(f"HTTP {status}：{_title(text)}")

        raw_users = {}
        m = re.search(r"commonui\.userInfo\.setAll\(\s*(\{.*?\})\s*\)\s*\n", text, re.S)
        if m:
            try:
                raw_users = json.loads(m.group(1), strict=False)
            except ValueError:
                pass

        rows = []
        for pm in self._PROC_RE.finditer(text):
            lou, pid, ptype, uid, ts, score, _, alter = pm.groups()
            date = re.search(rf"id='postdate{lou}'[^>]*>([^<]+)<", text)
            subject = re.search(rf"id='postsubject{lou}'[^>]*>(.*?)</h3>", text, re.S)
            content = re.search(rf"id='postcontent{lou}'[^>]*>(.*?)</(?:span|p)>", text, re.S)
            score_parts = score.split(",")
            rows.append({
                "lou": int(lou), "pid": int(pid), "type": int(ptype), "authorid": uid,
                "postdatetimestamp": int(ts), "postdate": date.group(1).strip() if date else "",
                "subject": subject.group(1).strip() if subject else "",
                "content": content.group(1) if content else "",
                "score": int(score_parts[1]) if len(score_parts) > 1 and score_parts[1].isdigit() else 0,
                "alterinfo": alter,
            })

        page_info = re.search(r"__PAGE\s*=\s*\{0:'[^']*',1:(\d+),2:(\d+),3:(\d+)\}", text)
        pages, cur, per = (map(int, page_info.groups()) if page_info else (1, 1, 20))
        # 帖子级信息从全帖最后一页取（那里的 JSON 是完整的）
        meta = self.page(tid, "e") if authorid else {}
        d = {
            "__T": {"subject": meta.get("title") or _title(text), "author": meta.get("author", ""),
                    "authorid": meta.get("authorid") or authorid, "fid": meta.get("fid"),
                    "lastpost": meta.get("lastpost", 0)},
            "__F": {"name": meta.get("forum", "")},
            "__R": rows, "__U": raw_users, "__PAGE": cur, "__R__ROWS_PAGE": per,
            "__ROWS": (pages - 1) * per + len(rows) if cur >= pages else pages * per,
        }
        return self._normalize(d, tid)

    # ---------- 辅助数据 ----------
    def _learn_name(self, uid, name):
        uid, name = str(uid), str(name).strip()
        if not name or name.startswith("UID:") or name.startswith("#anony"):
            return
        with self._names_lock:
            if self.names.get(uid) != name:
                self.names[uid] = name
                self._names_dirty = True

    def _flush_names(self):
        with self._names_lock:
            if not self._names_dirty:
                return
            self._names_dirty = False
            snapshot = dict(self.names)
        if not _save_json(NAMES_FILE, snapshot):
            self._names_dirty = True

    def _rep_id(self, fid):
        if not fid:
            return None
        if fid not in self._rep_ids:
            rep = None
            try:
                _, text = self._fetch(f"{HOST}/nuke.php?__lib=view_privilege&__act=view&id={fid}")
                m = re.search(r"声望`[^`]*?\((\d+)\)`", text)
                rep = m.group(1) if m else None
            except NgaError:
                pass
            self._rep_ids[fid] = rep
        return self._rep_ids[fid]

    def smiles(self):
        if self._smiles is None:
            self._smiles = _load_json(SMILES_FILE, None)
        if not self._smiles:
            r = requests.get(SMILE_JS, headers={"User-Agent": UA}, timeout=15)
            self._smiles = parse_smiles(r.text)
            if self._smiles:
                _save_json(SMILES_FILE, self._smiles)
        return self._smiles


def parse_smiles(js):
    start = js.find("ubbcode.smiles")
    if start < 0:
        return {}
    body = js[js.find("{", start):]
    depth, i, quote = 0, 0, None
    while i < len(body):
        ch = body[i]
        if quote:
            if ch == "\\":
                i += 1
            elif ch == quote:
                quote = None
        elif body.startswith("//", i):
            nl = body.find("\n", i)
            i = nl if nl > 0 else len(body)
            continue
        elif ch in "'\"":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                body = body[1:i]
                break
        i += 1
    body = re.sub(r"//[^\n]*", "", body)
    result = {}
    for gm in re.finditer(r"(?:^|[\s,{])([\w]+)\s*:\s*\{(.*?)\}", body, re.S):
        group, inner = gm.group(1), gm.group(2)
        items = {}
        for k, v in re.findall(r"""["']?([^"'\s:,{}]+)["']?\s*:\s*["']([^"']+\.(?:png|gif|jpg))["']""", inner):
            items[k] = v
        if items:
            result[group] = items
    return result


def fetch_image(url):
    """EdgeOne 会拦截 Python requests，图片代理改用 curl。"""
    p = subprocess.run(["curl.exe", "-s", "-L", "--max-time", "20", "-A", UA, url],
                       capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if p.returncode != 0 or not p.stdout or p.stdout[:15].lower().startswith(b"<!doctype"):
        raise NgaError("图片获取失败")
    return p.stdout
