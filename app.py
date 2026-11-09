import json
import mimetypes
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

if sys.platform == "win32":
    # pythonw 没有控制台，它启动的控制台程序（cursor-sdk 的 node.exe 等）会各自弹出黑框，
    # 第三方库又不让传 creationflags，只能在进程级统一加上 CREATE_NO_WINDOW
    _popen_init = subprocess.Popen.__init__

    def _popen_no_window(self, *args, **kwargs):
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
        _popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _popen_no_window

import nga_ai
from nga_api import DATA_DIR, RES_DIR, NgaClient, NgaError, fetch_image
from nga_login import LoginError, LoginFlow

WEB_DIR = os.path.join(RES_DIR, "web")
IMG_HOST_SUFFIX = (".nga.cn", ".178.com", ".ngacn.cc")
PREFERRED_PORT = 18765
APP_ID = "nga-reader"
# 后台窗口会被 Edge 冻结、心跳停发，所以不能按“无心跳”退出；只在页面关闭后无人接手时退出
BYE_GRACE_SEC = 30
IDLE_EXIT_SEC = 12 * 3600
client = NgaClient()
last_activity = time.time()
bye_at = 0.0
analysis_lock = threading.Lock()
current_job = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype, cache=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache or "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, code=200):
        self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        global last_activity
        last_activity = time.time()
        try:
            if u.path == "/api/ping":
                self._json({"app": APP_ID})
            elif u.path == "/api/page":
                page = q.get("page", "1")
                page = "e" if page == "e" else int(page)
                self._json(client.page(q["tid"], page, q.get("authorid"), fresh=q.get("fresh") == "1"))
            elif u.path == "/api/locate":
                self._json({"page": client.locate(q["tid"], int(q["ts"]), q.get("authorid"))})
            elif u.path == "/api/nga/status":
                self._json({**client.account_status(), "login": login_flow.status()})
            elif u.path == "/api/names":
                uids = [x for x in q.get("uids", "").split(",") if x.isdigit()][:300]
                self._json(client.lookup_names(uids))
            elif u.path == "/api/smiles":
                self._json(client.smiles())
            elif u.path == "/api/ai/status":
                self._json(nga_ai.status())
            elif u.path == "/api/ai/models":
                self._json({"models": nga_ai.list_models(q.get("provider", ""))})
            elif u.path == "/img":
                url = q.get("u", "")
                host = urlparse(url).hostname or ""
                if not url.startswith("http") or not host.endswith(IMG_HOST_SUFFIX):
                    return self._json({"error": "不允许的图片地址"}, 400)
                ctype = mimetypes.guess_type(urlparse(url).path)[0] or "image/jpeg"
                self._send(200, fetch_image(url), ctype, "max-age=86400")
            else:
                self._static(u.path)
        except (NgaError, nga_ai.AiError) as e:
            self._json({"error": str(e)}, 502)
        except (KeyError, ValueError) as e:
            self._json({"error": f"参数错误：{e}"}, 400)
        except Exception as e:
            traceback.print_exc()
            self._json({"error": f"内部错误：{e}"}, 500)

    def do_POST(self):
        global bye_at, last_activity
        path = urlparse(self.path).path
        if path == "/api/bye":
            bye_at = time.time()
            return self._send(204, b"", "text/plain")
        last_activity = time.time()
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            if path == "/api/ai/config":
                info = nga_ai.save_provider(body["provider"], key=body.get("key") or None,
                                            base_url=body.get("base_url"), model=body.get("model"),
                                            activate=body.get("activate", True))
                self._json({"ok": True, "info": info})
            elif path == "/api/ai/clear":
                nga_ai.clear_provider(body["provider"])
                self._json({"ok": True})
            elif path == "/api/nga/login":
                login_flow.start()
                self._json({"ok": True, "login": login_flow.status()})
            elif path == "/api/nga/cookie":
                self._json({"ok": True, "name": client.login_with_cookie(body.get("cookie", ""))})
            elif path == "/api/nga/logout":
                client.logout()
                self._json({"ok": True})
            elif path == "/api/ai/cancel":
                job = current_job
                if job:
                    job.cancel()
                self._json({"ok": True, "cancelled": bool(job)})
            elif path == "/api/ai/analyze":
                self._analyze(body)
            else:
                self._json({"error": "未知接口"}, 404)
        except (nga_ai.AiError, NgaError, LoginError) as e:
            self._json({"error": str(e)}, 400)
        except (KeyError, ValueError) as e:
            self._json({"error": f"参数错误：{e}"}, 400)

    def _analyze(self, body):
        global current_job
        # 新的分析直接顶掉还在跑的旧任务，避免旧任务卡住后一直占着位置
        if current_job:
            current_job.cancel()
        if not analysis_lock.acquire(timeout=15):
            return self._json({"error": "上一个分析任务停不下来，请稍后再试"}, 409)
        job = current_job = nga_ai.Job()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            write_lock = threading.Lock()
            gone = False

            def emit(**ev):
                nonlocal gone
                if gone:
                    return
                with write_lock:
                    try:
                        self.wfile.write(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except OSError:
                        gone = True
                        job.cancel()

            try:
                self._run_analysis(body, emit, job)
            except nga_ai.Cancelled:
                emit(type="cancelled")
            except (NgaError, nga_ai.AiError) as e:
                emit(type="error", message=str(e))
            except Exception as e:
                traceback.print_exc()
                emit(type="error", message=f"内部错误：{e}")
        finally:
            if current_job is job:
                current_job = None
            analysis_lock.release()

    def _run_analysis(self, body, emit, job):
        pid, settings = nga_ai.active_settings()
        tid = str(body["tid"])
        authorid = str(body.get("authorid") or "")
        from_ts, to_ts = int(body.get("from") or 0), int(body.get("to") or 0)
        if not from_ts:
            raise nga_ai.AiError("请先选择分析的时间范围")
        question = nga_ai.PRESETS.get(body.get("preset")) or (body.get("question") or "").strip()
        if not question:
            raise nga_ai.AiError("请输入要分析的问题")
        model = settings["model"]
        model_label = f"{nga_ai.PROVIDERS[pid]['name']} · {model}"

        emit(type="progress", text="正在定位时间范围…")
        last, posts, users, dropped = nga_ai.collect_posts(
            client, tid, authorid or None, from_ts, to_ts,
            progress=lambda t: emit(type="progress", text=t), job=job)
        if not posts:
            raise nga_ai.AiError("这个时间范围内没有发言")
        material, used = nga_ai.build_material(posts, users, bool(authorid))
        skipped = dropped + len(posts) - used
        posts = posts[len(posts) - used:]

        scope = (f"{'只看楼主' if authorid else '全部发言'}，"
                 f"{nga_ai.fmt_ts(posts[0]['ts'])} ~ {nga_ai.fmt_ts(posts[-1]['ts'])}")
        key = nga_ai.cache_key(tid, authorid, from_ts, to_ts, question, pid, model, posts[-1]["lou"], len(posts))
        meta = dict(type="meta", count=len(posts), scope=scope, model=model_label, question=question,
                    skipped=skipped)
        cached = None if body.get("force") else nga_ai.cache_get(key)
        if cached:
            emit(**meta, cached=True)
            emit(type="text", text=cached["text"])
            return emit(type="done", usage=cached.get("usage"), cached=True)

        emit(**meta, cached=False)
        emit(type="progress", text=f"已整理 {len(posts)} 楼（约 {len(material) // 1000} 千字），"
                                   f"正在等待 {model_label} 生成，内容越多等得越久…", waiting=True)
        system, user = nga_ai.build_prompt(last["title"], question, material, scope, len(posts))
        # 缓存键同时作为会话 ID：同一次分析的重试会落在同一会话上
        text, usage = nga_ai.run_analysis(pid, settings, system, user,
                                          lambda t: emit(type="text", text=t), session=f"ses_nga{key}", job=job)
        nga_ai.cache_put(key, {"text": text, "usage": usage, "scope": scope, "model": model_label, "at": time.time()})
        emit(type="done", usage=usage, cached=False)

    def _static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)


def running_instance(port):
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1.5) as r:
            return json.loads(r.read()).get("app") == APP_ID
    except (OSError, ValueError):
        return False


def free_port(preferred):
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue


def find_browser():
    """找一个支持 --app 窗口和 DevTools 的 Chromium 系浏览器；找不到时退回系统默认浏览器。"""
    if sys.platform == "darwin":
        apps = ["Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser"]
        candidates = [f"{root}/Applications/{a}.app/Contents/MacOS/{a}"
                      for root in ("", os.path.expanduser("~")) for a in apps]
    else:
        candidates = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
    for c in candidates:
        if os.path.exists(c):
            return c
    for name in ("msedge", "google-chrome", "chromium", "chrome"):
        if shutil.which(name):
            return shutil.which(name)
    return None


login_flow = LoginFlow(find_browser(), client.login_with_cookie)


def open_window(url):
    browser = find_browser()
    if not browser:
        webbrowser.open(url)
        return
    profile = os.path.join(DATA_DIR, "browser")
    subprocess.Popen([browser, f"--app={url}", f"--user-data-dir={profile}",
                      "--window-size=1440,920", "--no-first-run", "--no-default-browser-check",
                      "--disable-background-timer-throttling", "--disable-renderer-backgrounding"])


def main():
    server_only = "--server-only" in sys.argv
    if not server_only and running_instance(PREFERRED_PORT):
        open_window(f"http://127.0.0.1:{PREFERRED_PORT}/")
        return

    port = free_port(PREFERRED_PORT)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"NGA 阅读器已启动：{url}", flush=True)
    if server_only:
        httpd.serve_forever()
        return

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    open_window(url)
    # 不能用 Edge 进程退出判断窗口关闭：同一配置已在运行时，新启动的 Edge 会把窗口交给旧进程后立即退出
    while True:
        time.sleep(2)
        now = time.time()
        if bye_at and last_activity < bye_at and now - bye_at > BYE_GRACE_SEC:
            print(f"{time.ctime()} 所有窗口已关闭，退出", flush=True)
            break
        if now - last_activity > IDLE_EXIT_SEC:
            print(f"{time.ctime()} 长时间无活动，退出", flush=True)
            break
    httpd.shutdown()


def setup_log():
    """pythonw 没有控制台，输出和异常写入 data/server.log 便于排查。"""
    if sys.stdout is None or sys.stderr is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        log = open(os.path.join(DATA_DIR, "server.log"), "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log
    threading.excepthook = lambda a: traceback.print_exception(a.exc_type, a.exc_value, a.exc_traceback)


if __name__ == "__main__":
    setup_log()
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise
