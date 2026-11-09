@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Python。请到 https://www.python.org/downloads/ 安装 Python 3，
  echo 安装时勾选 "Add python.exe to PATH"，装好后再双击本脚本。
  pause
  exit /b 1
)

python -c "import requests" 2>nul
if errorlevel 1 (
  echo 正在安装依赖 requests...
  python -m pip install -q requests
  if errorlevel 1 (
    echo 安装失败，请检查网络
    pause
    exit /b 1
  )
)

rem AI 分析里的 Cursor 服务商需要 cursor-sdk；装不上不影响看帖
python -c "import cursor_sdk" 2>nul
if errorlevel 1 (
  echo 正在安装可选依赖 cursor-sdk（约 50MB）...
  python -m pip install -q cursor-sdk >nul 2>nul
)

start "" pythonw app.py
