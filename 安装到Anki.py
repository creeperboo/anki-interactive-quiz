"""把「互动答题卡」插件安装到 Anki，并重新打包 .ankiaddon。

用法（在本文件夹里执行）：
    python 安装到Anki.py                     # 自动找 Anki 插件目录并安装
    python 安装到Anki.py --addons "路径"      # 手动指定 addons21 目录
    python 安装到Anki.py --package-only      # 只重新打包，不安装

装完记得重启 Anki。插件只在 Anki 启动时加载。
"""

import argparse
import os
import shutil
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "源码")
PACKAGE = os.path.join(HERE, "interactive_quiz.ankiaddon")
FOLDER_NAME = "interactive_quiz"

ADDON_FILES = [
    "manifest.json",
    "config.json",
    "config.md",
    "README.md",
    "__init__.py",
    "assets/quiz.js",
    "assets/quiz.css",
    "assets/editor.js",
]


def default_addons_dir():
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return os.path.join(appdata, "Anki2", "addons21")
    for candidate in (
        os.path.expanduser("~/Library/Application Support/Anki2/addons21"),
        os.path.expanduser("~/.local/share/Anki2/addons21"),
    ):
        if os.path.isdir(candidate):
            return candidate
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--addons", help="Anki 的 addons21 目录")
    parser.add_argument("--package-only", action="store_true", help="只重新打包，不安装")
    args = parser.parse_args()

    if not os.path.isdir(SRC):
        raise SystemExit("找不到「源码」目录：" + SRC)

    missing = [f for f in ADDON_FILES if not os.path.isfile(os.path.join(SRC, *f.split("/")))]
    if missing:
        raise SystemExit("源码目录缺少文件：" + "、".join(missing))

    # 1) 重新打包（zip 条目必须用正斜杠）
    if os.path.exists(PACKAGE):
        os.remove(PACKAGE)
    with zipfile.ZipFile(PACKAGE, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in ADDON_FILES:
            with open(os.path.join(SRC, *rel.split("/")), "rb") as fh:
                z.writestr(rel, fh.read())
    print("已打包：%s（%d 字节）" % (PACKAGE, os.path.getsize(PACKAGE)))

    if args.package_only:
        return

    # 2) 安装
    addons = args.addons or default_addons_dir()
    if not addons or not os.path.isdir(addons):
        raise SystemExit("找不到 Anki 的 addons21 目录，请用 --addons 指定")
    target = os.path.join(addons, FOLDER_NAME)
    os.makedirs(target, exist_ok=True)
    for rel in ADDON_FILES:
        dst = os.path.join(target, *rel.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(SRC, *rel.split("/")), dst)
    print("已安装到：%s" % target)
    print("重启 Anki 后生效。")


if __name__ == "__main__":
    main()
