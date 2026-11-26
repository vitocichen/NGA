"""A 股量能：从腾讯（主）/ 新浪 / 东方财富（备）公开行情取实时快照和近几日 1 分钟累计成交额。

成交额口径、分钟轴对齐规则参考 ashare-volpulse（MIT，https://github.com/LostMoonkin/ashare-volpulse）：
- 09:30 那条分时是 09:25 集合竞价终态，单独作为竞价成交额；
- 连续竞价 240 根：09:31..11:30 → 0..119，13:01..15:00 → 120..239；
- 腾讯分时的 13:00 与 11:30 重复，15:00 之后是盘后固定价格交易，都要丢掉。
"""
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
CODE_RE = re.compile(r"^(sh|sz)\d{6}$")
BOARD_RE = re.compile(r"^BK\d{4}$")
MAX_CODES = 80
MINUTE_TTL = 20
# 东方财富 push2 对频繁请求会直接断开连接：换节点重试、结果缓存，失败时先用上一次的数据
EM_HOSTS = ("push2.eastmoney.com", "17.push2.eastmoney.com", "82.push2.eastmoney.com", "91.push2.eastmoney.com")
EM_GAP = 1.5
EM_COOLDOWN = 120
DIR_MAX_AGE_DAYS = 7
KLINE_PERIODS = ("day", "week", "month")
KLINE_COUNT = 180
KLINE_CACHE_TTL = 60
MENU_URL = "https://quote.eastmoney.com/center/api/sidemenu_new.json"
BOARD_KINDS = {1: "地域", 2: "行业", 3: "概念"}
OVERVIEW_TTL = 30
BOARDS_TTL = 60
KLINE_TTL = 6 * 3600
BOARD_TYPES = {"industry": "m:90+t:2", "concept": "m:90+t:3"}
BOARD_SORTS = {"pct": "f3", "vr": "f10", "amt": "f6"}


class VolError(Exception):
    pass


def check_codes(raw):
    codes = [c for c in dict.fromkeys(x.strip().lower() for x in raw.split(",")) if c]
    bad = [c for c in codes if not CODE_RE.match(c)]
    if bad:
        raise VolError(f"代码格式不对：{', '.join(bad[:3])}（应为 sh600519 / sz000001 这种）")
    if not codes:
        raise VolError("没有要查询的代码")
    return codes[:MAX_CODES]


def minute_index(hhmm):
    h, m = int(hhmm[:2]), int(hhmm[2:4])
    t = h * 60 + m
    if 9 * 60 + 31 <= t <= 11 * 60 + 30:
        return t - (9 * 60 + 31)
    if 13 * 60 + 1 <= t <= 15 * 60:
        return 120 + t - (13 * 60 + 1)
    return None


def _num(s):
    try:
        v = float(s)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


class VolClient:
    def __init__(self, cache_dir=None, seed_file=None):
        self.cache_dir = cache_dir
        self.seed_file = seed_file
        self._dir = None
        self._dir_loading = False
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA
        self._cache = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=4)
        self._em_lock = threading.Lock()
        self._em_at = 0.0
        self._em_block = {}

    def _get(self, url, referer, timeout=8):
        r = self.s.get(url, headers={"Referer": referer}, timeout=timeout)
        r.raise_for_status()
        return r

    # ---------- 实时快照 ----------
    def snapshot(self, codes):
        errors = []
        for fn in (self._snap_tencent, self._snap_sina):
            try:
                items = fn(codes)
                if items:
                    return {"items": items, "source": fn.__name__[6:]}
            except (requests.RequestException, ValueError, IndexError) as e:
                errors.append(f"{fn.__name__[6:]}: {e}")
        raise VolError("行情快照获取失败（" + "；".join(errors) + "）")

    def _snap_tencent(self, codes):
        text = self._get("https://qt.gtimg.cn/q=" + ",".join(codes), "https://gu.qq.com/").content.decode("gb18030", "replace")
        items = {}
        for m in re.finditer(r'v_(\w+)="([^"]*)"', text):
            p = m.group(2).split("~")
            if len(p) < 38 or not p[1]:
                continue
            amt = _num(p[35].split("/")[2]) if p[35].count("/") >= 2 else None
            if amt is None and _num(p[37]) is not None:
                amt = _num(p[37]) * 10000
            items[m.group(1)] = {
                "name": p[1], "price": _num(p[3]), "prev": _num(p[4]), "open": _num(p[5]),
                "change": _num(p[31]), "pct": _num(p[32]), "high": _num(p[33]), "low": _num(p[34]),
                "amount": amt, "time": p[30][:14],
                "turn": _num(p[38]), "amp": _num(p[43]), "vr": _num(p[49]) if len(p) > 49 else None,
            }
        return items

    def _snap_sina(self, codes):
        text = self._get("https://hq.sinajs.cn/list=" + ",".join(codes), "https://finance.sina.com.cn/").content.decode("gb18030", "replace")
        items = {}
        for m in re.finditer(r'hq_str_(\w+)="([^"]*)"', text):
            p = m.group(2).split(",")
            if len(p) < 32 or not p[0]:
                continue
            price, prev = _num(p[3]), _num(p[2])
            items[m.group(1)] = {
                "name": p[0], "price": price, "prev": prev, "open": _num(p[1]),
                "change": price - prev if price and prev else None,
                "pct": (price - prev) / prev * 100 if price and prev else None,
                "high": _num(p[4]), "low": _num(p[5]), "amount": _num(p[9]),
                "time": p[30].replace("-", "") + p[31].replace(":", ""),
            }
        return items

    # ---------- 近几日 1 分钟累计成交额 ----------
    def minutes(self, codes):
        futures = {c: self._pool.submit(self._minutes_one, c) for c in codes}
        out, errors = {}, {}
        for c, f in futures.items():
            try:
                out[c] = f.result()
            except VolError as e:
                errors[c] = str(e)
        return {"items": out, "errors": errors}

    def _minutes_one(self, code):
        now = time.time()
        with self._lock:
            hit = self._cache.get(code)
        if hit and now - hit[0] < MINUTE_TTL:
            return hit[1]
        errors = []
        for fn in (self._min_tencent, self._min_eastmoney):
            try:
                days = fn(code)
                if days:
                    data = {"days": days, "source": fn.__name__[5:]}
                    with self._lock:
                        self._cache[code] = (now, data)
                    return data
            except (requests.RequestException, ValueError, KeyError, IndexError, TypeError) as e:
                errors.append(f"{fn.__name__[5:]}: {e}")
        if hit:
            return hit[1]
        raise VolError("分时获取失败（" + "；".join(errors) + "）")

    @staticmethod
    def _empty_day(date, prev_close=None):
        return {"date": date, "prevClose": prev_close, "auction": None, "cum": [None] * 240, "price": [None] * 240}

    def _min_tencent(self, code):
        d = self._get(f"https://web.ifzq.gtimg.cn/appstock/app/day/query?code={code}", "https://gu.qq.com/").json()
        days = []
        for day in d["data"][code]["data"]:
            out = self._empty_day(day["date"], _num(day.get("prec")))
            for row in day["data"]:
                parts = row.split()
                if len(parts) < 4:
                    continue
                hhmm, price, amt = parts[0], _num(parts[1]), _num(parts[3])
                if hhmm == "0930":
                    out["auction"] = amt
                i = minute_index(hhmm)
                if i is not None and amt is not None:
                    out["cum"][i], out["price"][i] = amt, price
            days.append(out)
        return days

    def _min_eastmoney(self, code):
        secid = ("1." if code.startswith("sh") else "0.") + code[2:]
        d = self._get("https://push2his.eastmoney.com/api/qt/stock/trends2/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13"
                      f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=5&iscr=1&secid={secid}",
                      "https://quote.eastmoney.com/").json()
        by_date, total = {}, {}
        for row in d["data"]["trends"]:
            p = row.split(",")
            date, hhmm = p[0][:10].replace("-", ""), p[0][11:16].replace(":", "")
            day = by_date.setdefault(date, self._empty_day(date))
            amt = _num(p[6]) or 0
            total[date] = total.get(date, 0) + amt
            if hhmm == "0930":
                day["auction"] = amt
            i = minute_index(hhmm)
            if i is not None:
                day["cum"][i], day["price"][i] = total[date], _num(p[2])
        return [by_date[k] for k in sorted(by_date, reverse=True)]

    # ---------- K 线（腾讯，前复权） ----------
    def kline(self, code, period):
        if not CODE_RE.match(code or ""):
            raise VolError("代码格式不对")
        if period not in KLINE_PERIODS:
            raise VolError("K 线周期不对")

        def load():
            d = self._get(f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},{period},,,{KLINE_COUNT},qfq",
                          "https://gu.qq.com/").json()["data"][code]
            rows = d.get("qfq" + period) or d.get(period) or []
            return {"items": [{"date": r[0], "open": _num(r[1]), "close": _num(r[2]), "high": _num(r[3]), "low": _num(r[4]),
                               "volume": (_num(r[5]) or 0) * 100} for r in rows if len(r) >= 6]}
        now = time.time()
        key = f"k:{code}:{period}"
        with self._lock:
            hit = self._cache.get(key)
        if hit and now - hit[0] < KLINE_CACHE_TTL:
            return hit[1]
        try:
            data = load()
        except (requests.RequestException, ValueError, KeyError, TypeError) as e:
            if hit:
                return hit[1]
            raise VolError(f"K 线获取失败：{e}") from e
        with self._lock:
            self._cache[key] = (now, data)
        return data

    # ---------- 东方财富：市场概况、板块 ----------
    def _cached(self, key, ttl, fn):
        now = time.time()
        with self._lock:
            hit = self._cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
        try:
            data = fn()
        except (requests.RequestException, ValueError, KeyError, TypeError, IndexError) as e:
            if hit:
                return {**hit[1], "stale": True}
            raise VolError(f"东方财富数据获取失败：{e}") from e
        with self._lock:
            self._cache[key] = (now, data)
        return data

    def _em(self, path, host=None):
        # 东财按 IP 限额，被断开后继续请求只会延长封禁：所有节点都失败时暂停一段时间，期间直接用缓存。
        # 各域名的限额互不影响（实测 push2 被封时 push2his 仍可用），按域名分别暂停
        family = host or "push2"
        until = self._em_block.get(family, 0)
        if time.time() < until:
            raise requests.ConnectionError(f"东财请求过于频繁，{int(until - time.time())} 秒后再试")
        last = None
        for h in ([host] * 2 if host else EM_HOSTS[:2]):
            # 东财短时间内连续请求会被断开，全局排队并保持最小间隔
            with self._em_lock:
                wait = self._em_at + EM_GAP - time.time()
                if wait > 0:
                    time.sleep(wait)
                try:
                    r = self.s.get(f"https://{h}{path}", headers={"Referer": "https://quote.eastmoney.com/", "Connection": "close"}, timeout=8)
                    r.raise_for_status()
                    return r.json()
                except (requests.RequestException, ValueError) as e:
                    last = e
                finally:
                    self._em_at = time.time()
        self._em_block[family] = time.time() + EM_COOLDOWN
        raise last

    def overview(self):
        """全市场涨跌分布、主力净流入、昨日涨停表现，以及沪深两市近 60 个交易日日均成交额。"""
        def load():
            d = self._em("/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.000001,0.399106,0.899050,90.BK0815&fields=f12,f3,f62")
            rows = {r["f12"]: r for r in d["data"]["diff"]}
            main = sum(rows[c]["f62"] for c in ("000001", "399106", "899050") if isinstance(rows.get(c, {}).get("f62"), (int, float)))
            fb = self._em("/getTopicZDFenBu?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt", "push2ex.eastmoney.com")["data"]
            counts = {int(k): v for item in fb["fenbu"] for k, v in item.items()}
            n = lambda keys: sum(counts.get(k, 0) for k in keys)
            # 东财按 1% 一档给家数：±11 是涨跌停，1 表示 0~1%，5 表示 4~5%，以此类推
            buckets = [n([11]), n(range(6, 11)), n(range(2, 6)), n([1]), n([0]), n([-1]), n(range(-5, -1)), n(range(-10, -5)), n([-11])]
            return {"date": str(fb.get("qdate", "")), "main": main, "ztPerf": (rows.get("BK0815") or {}).get("f3"),
                    "buckets": buckets, "up": n(range(1, 12)), "flat": n([0]), "down": n(range(-11, 0))}
        data = self._cached("overview", OVERVIEW_TTL, load)
        try:
            data = {**data, **self._cached("avg60", KLINE_TTL, self._avg60)}
        except VolError:
            pass
        return data

    def _avg60(self):
        """近 60 个交易日（不含今天）沪深两市日均成交额，用东财日 K 的成交额字段。"""
        series = []
        for secid in ("1.000001", "0.399106"):
            d = self._em(f"/api/qt/stock/kline/get?secid={secid}&klt=101&fqt=1&lmt=61&end=20500101&fields1=f1&fields2=f51,f57",
                         "push2his.eastmoney.com")
            series.append({k.split(",")[0]: float(k.split(",")[1]) for k in d["data"]["klines"]})
        dates = sorted(set(series[0]) & set(series[1]))
        today = time.strftime("%Y-%m-%d")
        hist = [x for x in dates if x < today][-60:]
        return {"avg60": sum(series[0][x] + series[1][x] for x in hist) / len(hist), "avgDays": len(hist)}

    def boards(self, kind, sort):
        fs, fid = BOARD_TYPES.get(kind), BOARD_SORTS.get(sort)
        if not fs or not fid:
            raise VolError("板块类型或排序参数不对")
        self.board_directory()

        def load():
            d = self._em(f"/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid={fid}&fs={fs}"
                         "&fields=f3,f6,f10,f12,f14,f104,f105,f128,f136")
            return {"items": [{"code": r["f12"], "name": r["f14"], "pct": _num(r["f3"]), "amount": _num(r["f6"]), "vr": _num(r["f10"]),
                               "up": r.get("f104"), "down": r.get("f105"), "lead": r.get("f128"), "leadPct": _num(r.get("f136"))}
                              for r in d["data"]["diff"]], "total": d["data"]["total"]}
        return self._cached(f"boards:{kind}:{sort}", BOARDS_TTL, load)

    # ---------- 板块名单（搜索用） ----------
    # 东财的搜索接口已不可用：程序自带一份名单（web/boards_seed.json），本机副本超过 DIR_MAX_AGE_DAYS 天在后台更新
    def _dir_file(self):
        return os.path.join(self.cache_dir, "boards.json") if self.cache_dir else None

    def _read_dir(self, path):
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            return d if d.get("items") else None
        except (OSError, ValueError, AttributeError):
            return None

    def board_directory(self):
        """返回板块名单（可能是自带或较旧的副本）；需要更新时在后台下载。"""
        if not self._dir:
            local = self._dir_file()
            self._dir = (local and os.path.exists(local) and self._read_dir(local)) or (
                self.seed_file and os.path.exists(self.seed_file) and self._read_dir(self.seed_file)) or None
        age = DIR_MAX_AGE_DAYS + 1
        if self._dir:
            try:
                age = (time.time() - time.mktime(time.strptime(self._dir["date"], "%Y-%m-%d"))) / 86400
            except (KeyError, ValueError):
                pass
        if age > DIR_MAX_AGE_DAYS:
            with self._lock:
                start = not self._dir_loading
                self._dir_loading = True
            if start:
                threading.Thread(target=self._load_directory, daemon=True).start()
        return self._dir["items"] if self._dir else None

    def fetch_directory(self):
        """东财行情中心左侧菜单（静态文件，不受行情接口频率限制）里有全部板块的代码、名称和拼音首字母。"""
        d = self._get(MENU_URL, "https://quote.eastmoney.com/center/").json()
        found = {}

        def walk(node):
            if isinstance(node, dict):
                code = str(node.get("code") or "")
                if node.get("market") == 90 and BOARD_RE.match(code) and node.get("type") in BOARD_KINDS:
                    found[code] = {"code": code, "name": node.get("name", ""), "py": (node.get("pinyin") or "").lower(),
                                   "type": BOARD_KINDS[node["type"]]}
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)
        walk(d)
        if len(found) < 100:
            raise ValueError(f"菜单里只找到 {len(found)} 个板块，格式可能变了")
        return {"date": time.strftime("%Y-%m-%d"), "items": list(found.values())}

    def _load_directory(self):
        try:
            self._dir = self.fetch_directory()
            path = self._dir_file()
            if path:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(self._dir, f, ensure_ascii=False)
        except (requests.RequestException, ValueError, KeyError, TypeError, OSError) as e:
            print(f"板块名单下载失败：{e}", flush=True)
        finally:
            self._dir_loading = False

    def board_search(self, q, quotes=False):
        q = q.strip().lower()[:20]
        if not q:
            return {"items": []}
        items = self.board_directory()
        if items is None:
            return {"items": [], "loading": True}
        # 名称或拼音首字母包含关键词；以关键词开头的排前面（搜 PCB 先出「PCB」）
        hits = sorted((b for b in items if q in b["name"].lower() or q in b.get("py", "")),
                      key=lambda b: (not (b["name"].lower().startswith(q) or b.get("py", "").startswith(q)), len(b["name"])))[:30]
        hits = [{"code": b["code"], "name": b["name"], "type": b["type"]} for b in hits]
        if hits and quotes:
            try:
                qs = self.board_quotes(",".join(b["code"] for b in hits))["items"]
                hits = [{**b, **qs.get(b["code"], {}), "type": b["type"]} for b in hits]
            except VolError:
                pass
        return {"items": hits, "loading": self._dir_loading}

    def board_trends(self, codes):
        """自选板块的分时（push2his）：现价、涨跌幅、今日累计成交额、昨天同一时刻的累计成交额。
        push2his 与实时行情的 push2 分开限额，实时行情被限制时也能用。"""
        codes = [c for c in dict.fromkeys(x.strip().upper() for x in codes.split(",")) if c][:20]
        if not codes or not all(BOARD_RE.match(c) for c in codes):
            raise VolError("板块代码不对")
        out, errors = {}, {}
        for c in codes:
            try:
                out[c] = self._cached(f"bt:{c}", BOARDS_TTL, lambda c=c: self._board_trend(c))
            except VolError as e:
                errors[c] = str(e)
        return {"items": out, "errors": errors}

    def _board_trend(self, code):
        d = self._em("/api/qt/stock/trends2/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13"
                     f"&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=2&iscr=1&secid=90.{code}", "push2his.eastmoney.com")["data"]
        days = {}
        for row in d["trends"]:
            p = row.split(",")
            date, hhmm = p[0][:10], p[0][11:16].replace(":", "")
            day = days.setdefault(date, {"cum": [None] * 240, "price": [None] * 240, "total": 0.0})
            day["total"] += _num(p[6]) or 0
            i = minute_index(hhmm)
            if i is not None:
                day["cum"][i], day["price"][i] = day["total"], _num(p[2])
        dates = sorted(days)
        if len(dates) < 2:
            raise ValueError("板块分时不足两天")
        today, prev = days[dates[-1]], days[dates[-2]]
        idx = max((i for i, v in enumerate(today["cum"]) if v is not None), default=-1)
        price = today["price"][idx] if idx >= 0 else None
        pre = _num(d.get("preClose")) or _num(d.get("prePrice"))
        amount = today["total"]
        prev_at = prev["cum"][idx] if idx >= 0 else None
        return {"code": code, "name": d.get("name", ""), "price": price, "pct": (price / pre - 1) * 100 if price and pre else None,
                "amount": amount, "prevAt": prev_at, "diff": amount - prev_at if prev_at is not None else None,
                "date": dates[-1], "minute": idx}

    def board_quotes(self, codes):
        """自选里的板块：涨跌幅、成交额、量比、涨跌家数。"""
        codes = [c for c in dict.fromkeys(x.strip().upper() for x in codes.split(",")) if c][:MAX_CODES]
        if not codes or not all(BOARD_RE.match(c) for c in codes):
            raise VolError("板块代码不对")

        def load():
            d = self._em("/api/qt/ulist.np/get?fltt=2&invt=2&fields=f3,f6,f10,f12,f14,f104,f105&secids="
                         + ",".join(f"90.{c}" for c in codes))
            return {"items": {r["f12"]: {"code": r["f12"], "name": r["f14"], "pct": _num(r["f3"]), "amount": _num(r["f6"]),
                                         "vr": _num(r["f10"]), "up": r.get("f104"), "down": r.get("f105")}
                              for r in (d.get("data") or {}).get("diff") or []}}
        return self._cached("bq:" + ",".join(sorted(codes)), OVERVIEW_TTL, load)

    def board_stocks(self, code):
        if not BOARD_RE.match(code or ""):
            raise VolError("板块代码不对")

        def load():
            d = self._em(f"/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:{code}"
                         "&fields=f2,f3,f6,f8,f10,f12,f13,f14")
            items = []
            for r in d["data"]["diff"]:
                if r.get("f13") not in (0, 1):
                    continue
                items.append({"code": ("sh" if r["f13"] == 1 else "sz") + r["f12"], "name": r["f14"], "price": _num(r["f2"]),
                              "pct": _num(r["f3"]), "amount": _num(r["f6"]), "turn": _num(r["f8"]), "vr": _num(r["f10"])})
            return {"items": items, "total": d["data"]["total"]}
        return self._cached(f"board:{code}", OVERVIEW_TTL, load)

    # ---------- 搜索 ----------
    def search(self, q):
        q = q.strip()[:20]
        if not q:
            return []
        try:
            res = self._search_tencent(q)
            if res:
                return res
        except (requests.RequestException, ValueError):
            pass
        # 搜索不可用时，6 位代码按规则推断市场：6 开头沪市，0/3 开头深市
        m = re.fullmatch(r"(?:sh|sz)?(\d{6})", q.lower())
        if m and m.group(1)[0] in "603":
            return [{"code": ("sh" if m.group(1)[0] == "6" else "sz") + m.group(1), "name": "", "type": "A股"}]
        return []

    def _search_tencent(self, q):
        text = self._get(f"https://smartbox.gtimg.cn/s3/?v=2&q={requests.utils.quote(q)}&t=all",
                         "https://gu.qq.com/").content.decode("gb18030", "replace")
        m = re.search(r'v_hint="([^"]*)"', text)
        out = []
        for item in (m.group(1).split("^") if m else []):
            p = item.split("~")
            if len(p) < 5 or p[0] not in ("sh", "sz") or not ("GP-A" in p[4] or p[4].startswith("ZS")):
                continue
            name = json.loads(f'"{p[2]}"') if "\\u" in p[2] else p[2]
            out.append({"code": p[0] + p[1], "name": name, "type": "指数" if p[4].startswith("ZS") else "A股"})
        return out[:10]
