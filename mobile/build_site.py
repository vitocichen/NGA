"""生成手机版静态站点：python mobile/build_site.py --out _site

由 GitHub Actions 定时运行。环境变量 NGA_COOKIE（可选）用于以登录身份抓取，这样用户名才完整。
"""
import argparse
import json
import os
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from nga_api import NgaClient, NgaError  # noqa: E402

THREADS = ["47288722", "47812645"]
ALL_PAGES = 15
# 楼主按时间同步：覆盖最近 7 天，最多 OP_MAX_PAGES 页
OP_DAYS = 7
OP_MAX_PAGES = 20
# 指定用户：手机上查过的人进关注列表，每次运行都刷新他最近 7 天的发言；最多 5 人，3 天没再查看就移除
WATCH_MAX = 5
WATCH_DAYS = 3
WATCH_FILE = os.path.join(ROOT, "data", "watch.json")
STATIC_FILES = ["index.html", "m.css", "m.js", "manifest.json", "icon-180.png", "icon-512.png"]


def collect(client, tid, authorid, pages, since=0):
    """从最后一页往前取，最多 pages 页；给了 since 时取到早于 since 的楼层为止，并丢掉更早的。"""
    last = client.page(tid, "e", authorid, fresh=True)
    posts, users = list(last["posts"]), dict(last["users"])
    for p in range(last["page"] - 1, max(0, last["page"] - pages), -1):
        if since and posts and posts[0]["ts"] < since:
            break
        d = client.page(tid, p, authorid)
        posts = d["posts"] + posts
        users.update(d["users"])
    if since:
        posts = [x for x in posts if x["ts"] >= since]
    return last, posts, users


def slim(p):
    return {k: p[k] for k in ("lou", "pid", "authorid", "ts", "time", "content", "score", "alterinfo", "subject")
            if p.get(k) not in (None, "", 0) or k in ("lou", "ts")}


def build_thread(client, tid):
    # 抓取任务本身已覆盖最近几十页，不需要再后台扫描昵称
    client._harvested.add(tid)
    last, posts_all, users = collect(client, tid, None, ALL_PAGES)
    _, posts_op, users_op = collect(client, tid, last["authorid"], OP_MAX_PAGES, since=time.time() - OP_DAYS * 86400)
    users.update(users_op)
    uids = {p["authorid"] for p in posts_all + posts_op}
    slim_users = {}
    for uid in uids:
        u = users.get(uid, {})
        name = u.get("name") or ""
        if not name or name.startswith("UID:"):
            name = client.names.get(uid) or f"UID:{uid}"
        slim_users[uid] = {"name": name, "rep": u.get("rep"), "prestige": u.get("prestige")}
    return {
        "tid": tid, "title": last["title"], "author": last["author"], "authorid": last["authorid"],
        "forum": last["forum"], "rows_total": last["rows_total"], "lastpost": last["lastpost"],
        "posts": [slim(p) for p in posts_all], "op_posts": [slim(p) for p in posts_op], "users": slim_users,
    }


def update_watch(client):
    """读上次的关注列表，加入本次请求（环境变量 NGA_USERS，逗号分隔昵称），去掉过期的。"""
    try:
        with open(WATCH_FILE, encoding="utf-8") as f:
            watch = json.load(f)
    except (OSError, ValueError):
        watch = []
    now = int(time.time())
    for name in [x.strip() for x in os.environ.get("NGA_USERS", "").replace("，", ",").split(",") if x.strip()]:
        try:
            u = client.find_user(name)
        except NgaError as e:
            print(f"查找用户「{name}」失败：{e}")
            continue
        watch = [w for w in watch if w["uid"] != u["uid"]]
        watch.insert(0, {"uid": u["uid"], "name": u["name"], "ts": now})
        print(f"关注用户：{u['name']}（UID {u['uid']}）")
    return [w for w in watch if w["ts"] > now - WATCH_DAYS * 86400][:WATCH_MAX]


def build_user(client, tid, title, op_uid, user):
    try:
        _, posts, users = collect(client, tid, user["uid"], OP_MAX_PAGES, since=time.time() - OP_DAYS * 86400)
    except NgaError:
        # 这个人在本帖没有发言
        posts, users = [], {}
    slim_users = {uid: {"name": (u.get("name") if not str(u.get("name", "")).startswith("UID:") else None)
                        or client.names.get(uid) or user["name"], "rep": u.get("rep"), "prestige": u.get("prestige")}
                  for uid, u in users.items()}
    return {"tid": tid, "title": title, "authorid": op_uid, "user": {"uid": user["uid"], "name": user["name"]},
            "posts": [slim(p) for p in posts], "users": slim_users}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "_site"))
    out = ap.parse_args().out
    os.makedirs(os.path.join(out, "data"), exist_ok=True)

    client = NgaClient()
    cookie = os.environ.get("NGA_COOKIE", "").strip()
    if cookie:
        try:
            print("以登录身份抓取：", client.login_with_cookie(cookie))
        except NgaError as e:
            print("NGA_COOKIE 无效，改用游客身份：", e)
    else:
        print("未设置 NGA_COOKIE，以游客身份抓取，部分用户名只能显示 UID")

    watch = update_watch(client)
    index = []
    for tid in THREADS:
        t = time.time()
        try:
            data = build_thread(client, tid)
        except NgaError as e:
            print(f"[{tid}] 抓取失败：{e}")
            continue
        with open(os.path.join(out, "data", f"{tid}.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        named = sum(1 for u in data["users"].values() if not u["name"].startswith("UID:"))
        print(f"[{tid}] {data['title']}：全部 {len(data['posts'])} 楼，楼主 {len(data['op_posts'])} 帖，"
              f"昵称 {named}/{len(data['users'])}，{time.time() - t:.1f}s")
        index.append({k: data[k] for k in ("tid", "title", "author", "rows_total", "lastpost")})
        for user in watch:
            ud = build_user(client, tid, data["title"], data["authorid"], user)
            with open(os.path.join(out, "data", f"{tid}.u{user['uid']}.json"), "w", encoding="utf-8") as f:
                json.dump(ud, f, ensure_ascii=False, separators=(",", ":"))
            print(f"[{tid}] 用户 {user['name']}：近 {OP_DAYS} 天 {len(ud['posts'])} 帖")

    if not index:
        sys.exit("所有帖子都抓取失败")
    with open(os.path.join(out, "data", "index.json"), "w", encoding="utf-8") as f:
        json.dump({"updated": int(time.time()), "threads": index,
                   "watch": [{"uid": w["uid"], "name": w["name"]} for w in watch]}, f, ensure_ascii=False)
    with open(os.path.join(out, "data", "watch.json"), "w", encoding="utf-8") as f:
        json.dump(watch, f, ensure_ascii=False)
    with open(os.path.join(out, "data", "smiles.json"), "w", encoding="utf-8") as f:
        json.dump(client.smiles(), f, ensure_ascii=False)

    here = os.path.dirname(os.path.abspath(__file__))
    for name in STATIC_FILES:
        shutil.copy2(os.path.join(here, name), out)
    for shared in ("render.js", "themes.css"):
        shutil.copy2(os.path.join(ROOT, "web", shared), out)
    print("站点已生成：", out)


if __name__ == "__main__":
    main()
