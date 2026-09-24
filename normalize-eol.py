"""把改过的文本文件行尾统一成 CRLF，并保留原来的 BOM 有无。

用法：python normalize-eol.py <文件> [<文件> ...]
（只做机械的行尾 / BOM 归一，不改内容。）
"""

import sys
from pathlib import Path


def normalize(path: Path) -> str:
    raw = path.read_bytes()
    has_bom = raw.startswith(b"\xef\xbb\xbf")
    body = raw[3:] if has_bom else raw
    text = body.decode("utf-8")
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    out = text.encode("utf-8")
    if has_bom:
        out = b"\xef\xbb\xbf" + out
    if out != raw:
        path.write_bytes(out)
        return "已归一（%s）" % ("BOM+CRLF" if has_bom else "CRLF")
    return "本来就是 CRLF"


def main() -> None:
    for arg in sys.argv[1:]:
        path = Path(arg)
        print("%-42s %s" % (path.name, normalize(path)))


if __name__ == "__main__":
    main()
