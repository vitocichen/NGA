"""NGA 登录：打开独立的 Edge 窗口让用户在 NGA 官方页面登录，通过 DevTools 协议读取登录 Cookie。

密码只在 NGA 自己的页面里输入，本程序只拿登录后的 Cookie，保存到 data/cookie.txt。
游客也会有 ngaPassportUid（guest 开头），只有数字 uid + ngaPassportCid 才算登录成功。
"""
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import threading
import time
from urllib.parse import urlparse
from urllib.request import urlopen

from nga_api import DATA_DIR

LOGIN_URL = "https://bbs.nga.cn/nuke.php?__lib=login&__act=account&login"
PROFILE_DIR = os.path.join(DATA_DIR, "nga_login_browser")
LOGIN_TIMEOUT = 15 * 60


class LoginError(Exception):
    pass


# ---------- 最小 WebSocket 客户端（只连本机 DevTools，避免多一个依赖） ----------
class _WS:
    def __init__(self, url, timeout=10):
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\n"
                           f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise LoginError("DevTools 握手失败")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise LoginError("DevTools 拒绝连接")
        self.buf = head.split(b"\r\n\r\n", 1)[1]
        self._id = 0

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise LoginError("DevTools 连接断开")
            self.buf += chunk
        data, self.buf = self.buf[:n], self.buf[n:]
        return data

    def _send(self, text):
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        n = len(payload)
        header = bytes([0x81])
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _read_message(self):
        parts = []
        while True:
            b0, b1 = self._recv(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._recv(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._recv(8))[0]
            data = self._recv(n)
            opcode = b0 & 0x0F
            if opcode == 8:
                raise LoginError("DevTools 连接关闭")
            if opcode in (0, 1):
                parts.append(data)
            if b0 & 0x80 and opcode in (0, 1):
                return b"".join(parts).decode("utf-8", "replace")

    def call(self, method, params=None):
        self._id += 1
        self._send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self._read_message())
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise LoginError(f"DevTools 错误：{msg['error'].get('message')}")
                return msg.get("result", {})

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _cookie_string(cookies):
    nga = [c for c in cookies if c.get("domain", "").lstrip(".").endswith(("nga.cn", "178.com", "ngacn.cc"))]
    seen = {}
    for c in nga:
        seen[c["name"]] = c["value"]
    return seen


def is_logged_in(cookies):
    uid = cookies.get("ngaPassportUid", "")
    return uid.isdigit() and bool(cookies.get("ngaPassportCid"))


# ---------- 登录流程 ----------
class LoginFlow:
    def __init__(self, browser_path, on_success):
        self.browser_path = browser_path
        self.on_success = on_success
        self.state = "idle"
        self.message = ""
        self._lock = threading.Lock()
        self._proc = None

    def status(self):
        return {"state": self.state, "message": self.message}

    def start(self):
        with self._lock:
            if self.state == "waiting":
                return
            if not self.browser_path:
                raise LoginError("没有找到 Edge 或 Chrome，请改用「手动粘贴 Cookie」")
            self.state, self.message = "waiting", "已打开 NGA 登录窗口，请在窗口里完成登录"
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        port = _free_port()
        try:
            # 每次用干净的配置目录，避免残留上一个账号
            shutil.rmtree(PROFILE_DIR, ignore_errors=True)
            self._proc = subprocess.Popen([
                self.browser_path, f"--remote-debugging-port={port}", f"--user-data-dir={PROFILE_DIR}",
                "--no-first-run", "--no-default-browser-check", "--window-size=1000,800", LOGIN_URL])
            ws_url = self._wait_devtools(port)
            deadline = time.time() + LOGIN_TIMEOUT
            while time.time() < deadline:
                if self._proc.poll() is not None and not self._devtools_alive(port):
                    self.state, self.message = "failed", "登录窗口已关闭，未检测到登录"
                    return
                cookies = self._read_cookies(ws_url)
                if cookies is not None and is_logged_in(cookies):
                    name = self.on_success(cookies)
                    self.state, self.message = "success", f"登录成功：{name}"
                    self._close_browser(ws_url)
                    return
                time.sleep(1.5)
            self.state, self.message = "failed", "登录超时（15 分钟），请重试"
            self._close_browser(ws_url)
        except Exception as e:
            self.state, self.message = "failed", f"登录失败：{e}"
            if self._proc and self._proc.poll() is None:
                self._proc.terminate()

    def _wait_devtools(self, port):
        for _ in range(60):
            try:
                with urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as r:
                    return json.loads(r.read())["webSocketDebuggerUrl"]
            except (OSError, ValueError, KeyError):
                time.sleep(0.5)
        raise LoginError("浏览器调试接口没有启动")

    def _devtools_alive(self, port):
        try:
            with urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1):
                return True
        except OSError:
            return False

    def _read_cookies(self, ws_url):
        try:
            ws = _WS(ws_url)
        except (OSError, LoginError):
            return None
        try:
            return _cookie_string(ws.call("Storage.getCookies").get("cookies", []))
        except (OSError, LoginError):
            return None
        finally:
            ws.close()

    def _close_browser(self, ws_url):
        try:
            ws = _WS(ws_url)
            ws.call("Browser.close")
            ws.close()
        except (OSError, LoginError):
            pass
        time.sleep(1)
        shutil.rmtree(PROFILE_DIR, ignore_errors=True)
