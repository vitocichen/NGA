#!/bin/bash
# NGA 阅读器 macOS 启动脚本：双击运行。首次若提示无权限，见 README「Mac 使用」
cd "$(dirname "$0")" || exit 1

pause_exit() {
  read -r -p "按回车键退出…" _
  exit 1
}

PY=$(command -v python3)
if [ -z "$PY" ]; then
  echo "没有找到 python3。"
  echo "请到 https://www.python.org/downloads/macos/ 下载安装 Python 3，装好后再双击本脚本。"
  pause_exit
fi

# 独立的运行环境：macOS 自带的 Python 不允许直接 pip 安装到系统里
if [ ! -x .venv/bin/python ]; then
  echo "首次运行：正在创建运行环境…"
  "$PY" -m venv .venv || { echo "创建运行环境失败"; pause_exit; }
fi

if ! .venv/bin/python -c "import requests" 2>/dev/null; then
  echo "正在安装依赖 requests…"
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q requests || { echo "安装失败，请检查网络"; pause_exit; }
fi

# AI 分析里的 Cursor 服务商需要 cursor-sdk；装不上不影响看帖
if ! .venv/bin/python -c "import cursor_sdk" 2>/dev/null; then
  echo "正在安装可选依赖 cursor-sdk（约 50MB）…"
  .venv/bin/python -m pip install -q cursor-sdk >/dev/null 2>&1 \
    || echo "（cursor-sdk 没装上，AI 分析里的 Cursor 用不了，其他功能不受影响）"
fi

echo "NGA 阅读器已启动。关闭阅读器窗口后，这个终端窗口可以直接关掉。"
exec .venv/bin/python app.py
