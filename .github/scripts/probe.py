"""在 GitHub Actions 上验证能否访问 NGA（游客令牌 + Referer 的访问方式）。"""
import json
import random
import re
import socket
import time

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
HOSTS = ["bbs.nga.cn", "ngabbs.com"]
TID = "47288722"


def session(host):
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", "Referer": f"https://{host}/",
                      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"})
    return s


def fetch(s, host, path):
    url = f"https://{host}{path}"
    t = time.time()
    r = s.get(url, timeout=20)
    text = r.content.decode("gbk", "ignore")
    if r.status_code == 403 and "guestJs=" in text:
        tok = re.search(r"guestJs=([^;']+)", text).group(1)
        s.cookies.set("guestJs", tok, domain=host, path="/")
        time.sleep(0.5)
        r = s.get(f"{url}&rand={random.randint(0, 999)}", timeout=20)
        text = r.content.decode("gbk", "ignore")
    return r.status_code, text, round(time.time() - t, 2)


def parse_json(text):
    text = re.sub(r"^\s*window\.script_muti_get_var_store\s*=\s*", "", text)
    try:
        return json.loads(text, strict=False).get("data")
    except ValueError:
        return None


def main():
    ip = requests.get("https://api.ipify.org", timeout=10).text
    print(f"runner 出口 IP: {ip}")
    for host in HOSTS:
        print(f"\n===== {host} =====")
        try:
            print("DNS:", socket.gethostbyname(host))
        except OSError as e:
            print("DNS 失败:", e)
            continue
        s = session(host)
        try:
            code, text, sec = fetch(s, host, f"/read.php?tid={TID}&page=e&__output=11")
            d = parse_json(text)
            ok = bool(d and d.get("__R"))
            print(f"全帖最后一页 JSON: HTTP {code}, {sec}s, 解析{'成功' if ok else '失败'}", end="")
            if ok:
                rows = d["__R"].values() if isinstance(d["__R"], dict) else d["__R"]
                last = list(rows)[-1]
                print(f"，标题={d['__T']['subject']}，共 {d['__ROWS']} 楼，最新 #{last['lou']} {last['postdate']}")
            else:
                print(f"，内容开头：{re.sub(r'\s+', ' ', text[:150])}")

            code, text, sec = fetch(s, host, f"/read.php?tid={TID}&page=e&__output=11&authorid=150058")
            print(f"只看楼主 JSON: HTTP {code}, {sec}s, 解析{'成功' if parse_json(text) else '失败（截断，需 HTML 兜底）'}")

            code, text, sec = fetch(s, host, f"/read.php?tid={TID}&page=e&authorid=150058")
            n = len(re.findall(r"commonui\.postArg\.proc\(", text))
            print(f"只看楼主 HTML: HTTP {code}, {sec}s, 楼层 {n} 个")

            r = requests.get("https://img4.nga.cn/ngabbs/post/smile/ac0.png", timeout=15)
            print(f"表情图片: HTTP {r.status_code}, {len(r.content)} bytes")
        except Exception as e:
            print("请求异常:", type(e).__name__, e)


if __name__ == "__main__":
    main()
