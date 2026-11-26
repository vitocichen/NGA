import html
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

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
SEED_NAMES_FILE = os.path.join(RES_DIR, "seed_names.json")
HARVEST_PAGES = 40
SMILES_FILE = os.path.join(DATA_DIR, "smiles.json")
COOKIE_FILE = os.path.join(DATA_DIR, "cookie.txt")

MAX_CONCURRENCY = 8
LOCATE_FANOUT = 8
LAST_PAGE_TTL = 8
USER_HOME_TTL = 300
USER_QUERY_GAP = 5
USER_QUERY_COOLDOWN = 60
USER_QUERY_COOLDOWN_MAX = 600


class NgaError(Exception):
    pass


class NgaRateLimited(NgaError):
    def __init__(self, seconds):
        self.retry = max(1, int(seconds + 0.999))
        super().__init__(f"NGA 限制了按用户查询的频率，{self.retry} 秒后自动重试")


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
        self.account = None
        if os.path.exists(COOKIE_FILE):
            self._apply_cookie(open(COOKIE_FILE, encoding="utf-8").read())
        self._net_slots = threading.Semaphore(MAX_CONCURRENCY)
        self._token_lock = threading.Lock()
        self._cache = {}
        self._cache_lock = threading.Lock()
        # 游客拿不到用户名，只能从楼层里的 [uid=..]昵称[/uid] 积累；打包时附带一份种子表
        self.names = {**_load_json(SEED_NAMES_FILE, {}), **_load_json(NAMES_FILE, {})}
        self._names_dirty = False
        self._harvested = set()
        self._names_lock = threading.Lock()
        self._rep_ids = {}
        self._smiles = None
        self._uq_lock = threading.Lock()
        self._uq_at = 0.0
        self._uq_block = 0.0
        self._uq_fails = 0

    # ---------- 登录 ----------
    @staticmethod
    def parse_cookie(text):
        pairs = {}
        for part in re.split(r";\s*", (text or "").strip()):
            k, sep, v = part.partition("=")
            if sep and k.strip():
                pairs[k.strip()] = v.strip()
        return pairs

    def _apply_cookie(self, text):
        pairs = self.parse_cookie(text)
        for k, v in pairs.items():
            self.s.cookies.set(k, v, domain=".nga.cn", path="/")
        uid = pairs.get("ngaPassportUid", "")
        self.account = {"uid": uid} if uid.isdigit() and pairs.get("ngaPassportCid") else None
        return pairs

    def login_with_cookie(self, pairs):
        """保存登录 Cookie 并验证，返回登录账号的昵称。"""
        if isinstance(pairs, str):
            pairs = self.parse_cookie(pairs)
        uid = pairs.get("ngaPassportUid", "")
        if not (uid.isdigit() and pairs.get("ngaPassportCid")):
            raise NgaError("Cookie 里缺少 ngaPassportUid（数字）或 ngaPassportCid，不是有效的登录状态")
        self.s.cookies.clear()
        text = "; ".join(f"{k}={v}" for k, v in pairs.items())
        self._apply_cookie(text)
        name = self._account_name(uid)
        if not name:
            self.logout()
            raise NgaError("用这个 Cookie 访问 NGA 仍是游客身份，可能已过期，请重新登录")
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(COOKIE_FILE, "w", encoding="utf-8") as f:
            f.write(text)
        self.account = {"uid": uid, "name": name}
        self._reset_cache()
        return name

    def logout(self):
        self.s.cookies.clear()
        self.account = None
        try:
            os.remove(COOKIE_FILE)
        except OSError:
            pass
        self._reset_cache()

    def account_status(self):
        if self.account and "name" not in self.account:
            self.account["name"] = self._account_name(self.account["uid"]) or ""
        a = self.account
        return {"logged_in": bool(a and a.get("name")), "uid": a and a["uid"], "name": a and a.get("name")}

    def _account_name(self, uid):
        """游客看到的用户名是 UID 加数字，能拿到真名才说明登录有效。"""
        try:
            d = self._fetch_json(f"{HOST}/nuke.php?__lib=ucp&__act=get&uid={uid}&__output=11")
        except NgaError:
            return None
        rows = d if isinstance(d, list) else d.get("0") or d.get("data") or []
        if isinstance(rows, dict):
            rows = [rows]
        for u in rows if isinstance(rows, list) else []:
            name = (u or {}).get("username", "")
            if name and not re.fullmatch(r"UID:?\d+", name):
                return name
        return None

    def _reset_cache(self):
        with self._cache_lock:
            self._cache.clear()
        self._harvested.clear()

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
        if page == "e" and not authorid and tid not in self._harvested:
            self._harvested.add(tid)
            threading.Thread(target=self._harvest_names, args=(tid, data["page"]), daemon=True).start()
        return data

    def _harvest_names(self, tid, last_page):
        """后台扫最近几十页，从回复/引用里多收集些昵称。"""
        pages = range(last_page - 1, max(0, last_page - HARVEST_PAGES), -1)
        with ThreadPoolExecutor(4) as pool:
            for _ in pool.map(lambda p: self._safe_page(tid, p), pages):
                pass
        self._flush_names()

    def _safe_page(self, tid, page):
        try:
            self.page(tid, page)
        except NgaError:
            pass

    def forum(self, fid, page=1):
        """版面帖子列表（按最后回复排序），每次都实时请求。"""
        d = self._fetch_json(f"{HOST}/thread.php?fid={fid}&page={page}&__output=11")
        rows = d.get("__T") or []
        rows = list(rows.values()) if isinstance(rows, dict) else rows
        per = d.get("__T__ROWS_PAGE") or 35
        topics = []
        for t in rows:
            if not isinstance(t, dict) or not t.get("tid"):
                continue
            if t.get("authorid") and t.get("author"):
                self._learn_name(t["authorid"], t["author"])
            topics.append({
                "tid": str(t["tid"]), "subject": html.unescape(str(t.get("subject") or "")),
                "author": t.get("author") or "", "authorid": str(t.get("authorid") or ""),
                "postdate": t.get("postdate") or 0, "lastpost": t.get("lastpost") or 0,
                "lastposter": t.get("lastposter") or "", "replies": t.get("replies") or 0,
            })
        self._flush_names()
        return {"fid": str(fid), "forum": (d.get("__F") or {}).get("name", ""), "page": int(page),
                "pages": max(1, math.ceil((d.get("__ROWS") or len(topics)) / per)), "topics": topics}

    def user_home(self, uid, kind="topics", page=1):
        """个人主页：topics=他发的主题，replies=他的回复，都是 NGA 按时间倒序给的。"""
        uid = str(uid)
        if not uid.isdigit():
            raise NgaError("UID 不正确")
        page = max(1, int(page))
        url = f"{HOST}/thread.php?authorid={uid}&page={page}&__output=11"
        if kind == "replies":
            url += "&searchpost=1"
        key = ("uh", uid, kind, page)
        with self._cache_lock:
            hit = self._cache.get(key)
        if hit and time.time() - hit[0] < USER_HOME_TTL:
            return hit[1]
        out = {"uid": uid, "kind": kind, "page": page, "items": [], "more": False, "hidden": 0}
        if page == 1:
            out["user"] = self.user_info(uid)
        # NGA 对按用户查询限流很紧（实测连续 3 次就 503，之后约 2 分钟才解封，期间再请求会继续封），
        # 所以请求之间留间隔，被封后冷却期内不再碰 NGA
        with self._uq_lock:
            wait = self._uq_block - time.time()
            if wait > 0:
                raise NgaRateLimited(wait)
            gap = self._uq_at + USER_QUERY_GAP - time.time()
            if gap > 0:
                time.sleep(gap)
            self._uq_at = time.time()
            try:
                d = self._fetch_json(url)
            except NgaError as e:
                # 翻过最后一页时 NGA 报「没有符合条件的结果」
                if "没有符合条件" in str(e):
                    return out
                if "503" in str(e):
                    # 封禁期内重复请求会让 NGA 封得更久，冷却时间逐次翻倍
                    cool = min(USER_QUERY_COOLDOWN_MAX, USER_QUERY_COOLDOWN * 2 ** self._uq_fails)
                    self._uq_fails += 1
                    self._uq_block = time.time() + cool
                    raise NgaRateLimited(cool) from e
                raise
            self._uq_fails = 0
        rows = d.get("__T") or []
        rows = list(rows.values()) if isinstance(rows, dict) else rows
        for t in rows:
            if not isinstance(t, dict) or not t.get("tid"):
                continue
            forum = str((t.get("parent") or {}).get("2") or "")
            if kind != "replies":
                # 没权限看的老帖只给占位标题「帖子发布或回复时间超过限制」，时间为 0
                if not t.get("postdate"):
                    out["hidden"] += 1
                    continue
                if t.get("authorid") and t.get("author"):
                    self._learn_name(t["authorid"], t["author"])
                out["items"].append({
                    "tid": str(t["tid"]), "subject": html.unescape(str(t.get("subject") or "")), "forum": forum,
                    "postdate": t.get("postdate") or 0, "lastpost": t.get("lastpost") or 0,
                    "lastposter": t.get("lastposter") or "", "replies": t.get("replies") or 0,
                })
                continue
            p = t.get("__P") or {}
            ts = p.get("postdate")
            # 没权限看的版面会返回占位条目（denied），时间为空
            if p.get("denied") or not isinstance(ts, int):
                out["hidden"] += 1
                continue
            out["items"].append({
                "tid": str(t["tid"]), "pid": str(p.get("pid") or 0), "ts": ts, "forum": forum,
                "subject": html.unescape(str(t.get("subject") or "")), "author": t.get("author") or "",
                "content": str(p.get("content") or ""),
            })
        if kind == "replies":
            out["more"] = bool(rows)
        else:
            per = int(d.get("__T__ROWS_PAGE") or 35)
            out["more"] = page * per < int(d.get("__ROWS") or 0)
        self._flush_names()
        with self._cache_lock:
            self._cache[key] = (time.time(), out)
        return out

    def pid_page(self, pid):
        """回复所在的帖子和页码：NGA 的 read.php?pid=&to=1 会 302 到 read.php?tid=..&page=.."""
        pid = str(pid)
        if not pid.isdigit():
            raise NgaError("pid 不正确")
        with self._net_slots:
            try:
                r = self.s.get(f"{HOST}/read.php?pid={pid}&to=1", timeout=15, allow_redirects=False)
            except requests.RequestException as e:
                raise NgaError(f"网络错误：{e}") from e
        m = re.search(r"tid=(\d+).*?page=(\d+)", r.headers.get("Location") or "")
        if not m:
            raise NgaError("没找到这条回复所在的页（可能已被删除）")
        return {"tid": m.group(1), "page": int(m.group(2))}

    def user_info(self, uid):
        uid = str(uid)
        with self._cache_lock:
            hit = self._cache.get(("user", uid))
        if hit:
            return hit
        info = {"uid": uid, "name": self.names.get(uid, "")}
        try:
            d = self._fetch_json(f"{HOST}/nuke.php?__lib=ucp&__act=get&uid={uid}&__output=11")
            row = (d if isinstance(d, list) else [d])[0] or {}
        except NgaError:
            row = {}
        name = row.get("username") or ""
        if name and not re.fullmatch(r"UID:?\d+", name):
            self._learn_name(uid, name)
            info["name"] = name
        avatar = row.get("avatar")
        info.update({
            "regdate": row.get("regdate") or 0, "ipLoc": row.get("ipLoc") or "", "group": row.get("group") or "",
            "fans": row.get("follow_by_num") or 0, "sign": row.get("sign") or "",
            "avatar": avatar if isinstance(avatar, str) and avatar.startswith("http") else None,
        })
        if row:
            with self._cache_lock:
                self._cache[("user", uid)] = info
        return info

    def find_user(self, name):
        """按昵称找 UID：先查本地昵称表（完全匹配，再忽略大小写），找不到再问 NGA。"""
        name = (name or "").strip()
        if not name:
            raise NgaError("请输入用户昵称")
        if name.isdigit():
            return {"uid": name, "name": self.names.get(name, f"UID:{name}")}
        with self._names_lock:
            pairs = list(self.names.items())
        for uid, n in pairs:
            if n == name:
                return {"uid": uid, "name": n}
        lower = [(uid, n) for uid, n in pairs if n.lower() == name.lower()]
        if len(lower) == 1:
            return {"uid": lower[0][0], "name": lower[0][1]}
        similar = [n for _, n in pairs if name.lower() in n.lower()][:8]
        hint = f"。相近的有：{'、'.join(similar)}" if similar else ""
        try:
            q = quote(name.encode("gbk"))
        except UnicodeEncodeError:
            raise NgaError("昵称里有 NGA 不支持的字符")
        # 这个接口连续查询容易被 NGA 限流（HTTP 503），稍等重试
        for attempt in range(3):
            try:
                d = self._fetch_json(f"{HOST}/nuke.php?__lib=ucp&__act=get&username={q}&__output=11")
                break
            except NgaError as e:
                if "找不到用户" in str(e):
                    raise NgaError(f"找不到用户「{name}」{hint}")
                if "503" not in str(e) or attempt == 2:
                    raise NgaError(f"查询用户失败（NGA 限流，稍后再试）{hint}")
                time.sleep(1.5 * (attempt + 1))
        row = (d if isinstance(d, list) else [d])[0] or {}
        uid = str(row.get("uid") or "")
        if not uid.isdigit():
            raise NgaError(f"找不到用户「{name}」")
        self._learn_name(uid, name)
        self._flush_names()
        return {"uid": uid, "name": name}

    def lookup_names(self, uids):
        with self._names_lock:
            return {u: self.names[u] for u in uids if u in self.names}

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
    """EdgeOne 会拦截 Python requests，图片代理改用 curl（Windows 10+ 与 macOS 都自带）。"""
    curl = shutil.which("curl") or "curl.exe"
    p = subprocess.run([curl, "-s", "-L", "--max-time", "20", "-A", UA, url],
                       capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if p.returncode != 0 or not p.stdout or p.stdout[:15].lower().startswith(b"<!doctype"):
        raise NgaError("图片获取失败")
    return p.stdout
