"""打包成不依赖 Python 的 Windows 程序：python build.py

产物：dist/NGAReader/（整个文件夹发给别人，双击 NGAReader.exe）
以及同名 zip。不会打包 data/（Key、Cookie、浏览器缓存、昵称缓存都在里面）。
完整源码附在 NGAReader/源码/ 下，拿到的人可以修改后用源码运行或重新打包。
"""
import os
import shutil
import sys

import PyInstaller.__main__

ROOT = os.path.dirname(os.path.abspath(__file__))
NAME = "NGAReader"
SOURCE_FILES = ["app.py", "nga_api.py", "nga_ai.py", "nga_login.py", "build.py", "requirements.txt",
                "README.md", "LICENSE", ".gitignore", ".gitattributes", "启动_windows.bat", "启动_mac.command"]


def copy_source(out):
    dest = os.path.join(out, "源码")
    os.makedirs(dest, exist_ok=True)
    for f in SOURCE_FILES:
        shutil.copy2(os.path.join(ROOT, f), dest)
    shutil.copytree(os.path.join(ROOT, "web"), os.path.join(dest, "web"), dirs_exist_ok=True)
    shutil.copy2(os.path.join(ROOT, "LICENSE"), out)


def copy_seed_names(out):
    """附带本机已收集的昵称表（NGA 公开昵称），新用户打开就能看到大部分昵称。"""
    src = os.path.join(ROOT, "data", "names.json")
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(out, "_internal", "seed_names.json"))


def main():
    os.chdir(ROOT)
    PyInstaller.__main__.run([
        os.path.join(ROOT, "app.py"),
        f"--name={NAME}",
        "--onedir",
        "--windowed",
        "--noconfirm",
        "--clean",
        # --specpath 下相对路径按 spec 目录解析，必须用绝对路径
        f"--add-data={os.path.join(ROOT, 'web')}{os.pathsep}web",
        # cursor-sdk 自带 node.exe 和桥接脚本，必须整包收集
        "--collect-all=cursor_sdk",
        # 本机环境里装了但程序用不到的库，会被可选依赖顺带分析进来
        *[f"--exclude-module={m}" for m in ("numpy", "PIL", "bcrypt", "cryptography", "tkinter", "pygments")],
        "--distpath=dist",
        "--workpath=build",
        "--specpath=build",
    ])
    out = os.path.join(ROOT, "dist", NAME)
    copy_source(out)
    copy_seed_names(out)
    for leak in (os.path.join(out, "data"), os.path.join(out, "源码", "data")):
        if os.path.exists(leak):
            sys.exit(f"打包结果里出现了 {leak}，已中止，请检查")
    archive = shutil.make_archive(os.path.join(ROOT, "dist", NAME), "zip", os.path.join(ROOT, "dist"), NAME)
    size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(out) for f in fs)
    print(f"\n打包完成：{out}（{size / 1e6:.0f} MB）")
    print(f"压缩包：{archive}（{os.path.getsize(archive) / 1e6:.0f} MB）")


if __name__ == "__main__":
    main()
