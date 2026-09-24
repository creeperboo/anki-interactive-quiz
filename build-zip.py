# -*- coding: utf-8 -*-
"""把整个项目文件夹打包成「互动答题卡-源码更新-1.1.7.zip」（就在本脚本旁边）。

打包规则：项目文件夹里除下面这几类之外的**所有文件**都进包——
  · `.git`（版本库，不进包）
  · 任何 `__pycache__`
  · 任何 `user_files`（插件运行数据：统计库 / 判断题标记 / 整理报告）
  · 以 `.` 开头的文件（比如 .gitignore）
  · 这个 zip 自己
  · **别的版本**的产物（`答题反馈预览-x.y.z.html` / `互动答题卡-源码更新-x.y.z.zip` /
    `一键更新插件到Anki-x.y.z.cmd` 里版本号不是 version.txt 的那几个）——
    上一版的包还没删掉时，也不会被塞进新包里

用法：python build-zip.py        # 在项目文件夹里跑即可，路径自己找
"""

import hashlib
import re
import zipfile
from pathlib import Path

# 脚本自己所在目录 = 项目根目录（这样整个文件夹搬到哪都能跑）
PROJ = Path(__file__).resolve().parent
OUT = PROJ / "互动答题卡-源码更新-1.1.7.zip"

SKIP_DIR_NAMES = {"__pycache__", "user_files"}

# 当前版本（文件名叫 x.y.z 的产物，只留这一版）
CURRENT_VERSION = (PROJ / "version.txt").read_text(encoding="utf-8").strip()
VERSIONED_RE = re.compile(
    r"^(答题反馈预览|互动答题卡-源码更新|一键更新插件到Anki)-(\d+\.\d+\.\d+)"
)


def is_other_version(name: str) -> bool:
    m = VERSIONED_RE.match(name)
    return bool(m) and m.group(2) != CURRENT_VERSION


def collect_files() -> list[str]:
    """按上面的规则列出要打进 zip 的相对路径（正斜杠）。"""
    out = []
    for path in sorted(PROJ.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(PROJ)
        parts = rel.parts
        if any(part.startswith(".") for part in parts):
            continue
        if any(part in SKIP_DIR_NAMES for part in parts[:-1]):
            continue
        if path.name == OUT.name:
            continue
        if is_other_version(path.name):
            continue
        out.append(rel.as_posix())
    return out


FILES = collect_files()


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in FILES:
            path = PROJ / Path(rel)
            data = path.read_bytes()
            z.writestr(rel.replace("\\", "/"), data)
    # 自检：逐个条目对 SHA256
    bad = []
    with zipfile.ZipFile(OUT) as z:
        for rel in FILES:
            want = hashlib.sha256((PROJ / Path(rel)).read_bytes()).hexdigest()
            got = hashlib.sha256(z.read(rel.replace("\\", "/"))).hexdigest()
            if want != got:
                bad.append(rel)
    print("已生成：%s（%d 字节，%d 个文件）" % (OUT, OUT.stat().st_size, len(FILES)))
    print("SHA256 校验：", "全部一致" if not bad else ("不一致 -> %s" % bad))


if __name__ == "__main__":
    main()
