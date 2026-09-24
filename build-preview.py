# -*- coding: utf-8 -*-
"""生成 答题反馈预览-1.1.6.html（就在本脚本旁边）。

把真实的 assets/quiz.js + assets/quiz.css 塞进几个 iframe（每个 iframe 就是一张真卡片的
DOM 结构），再让每个 iframe 自己跑一小段「演示脚本」把卡片点到答完的状态，这样在浏览器里
看到的着色 / 空里答案跟 Anki 里完全同一套代码画出来的。

用法：python build-preview.py        # 在项目文件夹里跑即可，路径自己找
"""

import base64
import json
from pathlib import Path

# 脚本自己所在目录 = 项目根目录（这样整个文件夹搬到哪都能跑）
HERE = Path(__file__).resolve().parent
SRC = HERE / "源码"
OUT = HERE / "答题反馈预览-1.1.6.html"

CSS = (SRC / "assets" / "quiz.css").read_text(encoding="utf-8")
JS = (SRC / "assets" / "quiz.js").read_text(encoding="utf-8")


def raw_block(
    options="", answer="", explanation="", tips="", source="", question_raw="", knowledge=""
):
    return (
        '<div id="iq-raw" hidden="hidden">\n'
        '  <div id="iq-raw-options">%s</div>\n'
        '  <div id="iq-raw-answer">%s</div>\n'
        '  <div id="iq-raw-explanation">%s</div>\n'
        '  <div id="iq-raw-tips">%s</div>\n'
        '  <div id="iq-raw-source">%s</div>\n'
        '  <div id="iq-raw-type"></div>\n'
        '  <div id="iq-raw-question">%s</div>\n'
        '  <div id="iq-raw-knowledge">%s</div>\n'
        "</div>"
    ) % (options, answer, explanation, tips, source, question_raw, knowledge)


def card(
    side,
    question,
    options="",
    answer="",
    explanation="",
    tips="",
    cloze=False,
    question_raw="",
    knowledge="",
):
    cloze_attr = ' data-iq-cloze="1"' if cloze else ""
    header = '<div class="iq-card" id="iq-card" data-side="%s"%s>\n' % (side, cloze_attr)
    header += '  <div class="iq-question" id="iq-question">%s</div>\n' % question
    if side == "front":
        body = (
            '  <div class="iq-options" id="iq-options"></div>\n'
            '  <div class="iq-controls" id="iq-controls"></div>\n'
            '  <div class="iq-feedback" id="iq-feedback" hidden="hidden"></div>\n'
            '  <div class="iq-actions" id="iq-actions"></div>\n'
        )
    else:
        body = (
            '  <div class="iq-options" id="iq-options"></div>\n'
            '  <div class="iq-explain" id="iq-explanation"></div>\n'
            '  <div class="iq-explain iq-tips" id="iq-tips"></div>\n'
            '  <div class="iq-explain iq-knowledge" id="iq-knowledge"></div>\n'
            '  <div class="iq-explain" id="iq-source"></div>\n'
        )
    return header + body + "</div>\n" + raw_block(
        options=options,
        answer=answer,
        explanation=explanation,
        tips=tips,
        question_raw=question_raw,
        knowledge=knowledge,
    )


CHOICE_Q = "《静夜思》的作者是谁？"
CHOICE_OPTS = "*A. 李白<br>B. 杜甫<br>C. 白居易"
CHOICE_EXP = "李白，字太白，唐代诗人。"
CHOICE_TIPS = "先想朝代，再想代表诗人。"
CHOICE_KNOWLEDGE = (
    "唐诗 -> https://zh.wikipedia.org/wiki/静夜思\n"
    "宋词 -> https://zh.wikipedia.org/wiki/宋词"
)

TF_Q = "地球是圆的"
TF_RAW = "地球是圆的<!--iq-tf:对-->"

CLOZE_Q = (
    "中国的首都是"
    '<span class="cloze" data-cloze="北京" data-ordinal="1">[...]</span>'
    "，最大的城市是"
    '<span class="cloze" data-cloze="上海" data-ordinal="2">[...]</span>'
    "。"
)


def demo(js_code):
    """等卡片 boot 完（quiz.js 会置 window.__IQ_BOOTED__）再执行演示动作。"""
    return (
        "<script>(function(){var n=0;function go(){if(!window.__IQ_BOOTED__&&n++<60)"
        "{return setTimeout(go,100);}try{%s}catch(e){}}setTimeout(go,120);})();</script>" % js_code
    )


CLICK = "document.querySelectorAll('#iq-options .iq-opt')[%d].click();"
FILL = (
    "var ins=document.querySelectorAll('#iq-question .iq-input');"
    "var v=%s;for(var i=0;i<ins.length;i++){ins[i].value=v[i]||'';}"
    "document.querySelector('#iq-controls .iq-submit').click();"
)


CARDS = [
    {
        "title": "选择题 · 答错",
        "hint": "点错的那项标红，该选的那项标绿；反馈区不再有「正确答案：A. …」那一行。",
        "html": card("front", CHOICE_Q, options=CHOICE_OPTS, explanation=CHOICE_EXP, tips=CHOICE_TIPS),
        "demo": demo(CLICK % 1),
    },
    {
        "title": "选择题 · 答对",
        "hint": "答对只靠绿色和判定文字说明，同样没有答案文字。",
        "html": card("front", CHOICE_Q, options=CHOICE_OPTS, explanation=CHOICE_EXP, tips=CHOICE_TIPS),
        "demo": demo(CLICK % 0),
    },
    {
        "title": "判断题 · 答对",
        "hint": "判断题就是两个选项，正确的那项绿。",
        "html": card("front", TF_Q, question_raw=TF_RAW, explanation="这是常识。"),
        "demo": demo(CLICK % 0),
    },
    {
        "title": "判断题 · 答案面（背面）",
        "hint": "背面也画成两个着色的选项：该选的那项绿、另一项灰，不再写「答案：对」。",
        "html": card("back", TF_Q, question_raw=TF_RAW, explanation="这是常识。"),
        "demo": "",
    },
    {
        "title": "填空题 · 答错",
        "hint": "空里先划掉你填的（红），再跟标准答案（绿）：南京 → 北京。反馈区没有答案那一行。",
        "html": card("front", CLOZE_Q, explanation="首都 = 北京；最大城市 = 上海。", cloze=True),
        "demo": demo(FILL % '["南京","广州"]'),
    },
    {
        "title": "填空题 · 答对",
        "hint": "答对时空里写卡片里的标准答案（绿色下划线），你填的可接受写法也一样显示标准答案。",
        "html": card("front", CLOZE_Q, explanation="首都 = 北京；最大城市 = 上海。", cloze=True),
        "demo": demo(FILL % '["北京","上海"]'),
    },
    {
        "title": "选择题 · 答对（相关知识点 = 可点的标签）",
        "hint": "「知识点」不再是单独一个大按钮，而是一排标签：点哪个标签就跳哪个链接。"
        "制卡时在「知识点」里一行写一条「标签 -> 链接」，编辑器里点 [🏷 配置标签链接] 逐行填也行。",
        "html": card(
            "front",
            CHOICE_Q,
            options=CHOICE_OPTS,
            explanation=CHOICE_EXP,
            tips=CHOICE_TIPS,
            knowledge=CHOICE_KNOWLEDGE,
        ),
        "demo": demo(CLICK % 0),
    },
]

PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>互动答题卡 1.1.6 · 答完效果预览</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 24px 20px 60px;
    background: #eef0f4; color: #1f2328;
    font: 15px/1.6 "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .lead { max-width: 60rem; color: #4b5563; margin: 0 0 4px; }
  .lead code { background: #fff; padding: 0 .3em; border-radius: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: 18px; margin-top: 20px; }
  .frame-box { background: #fff; border-radius: 14px; box-shadow: 0 1px 3px rgba(16,24,40,.10); overflow: hidden; }
  .frame-head { padding: 12px 16px 10px; border-bottom: 1px solid #e5e8ee; }
  .frame-title { font-weight: 700; }
  .frame-hint { color: #6b7280; font-size: 13px; margin-top: 2px; }
  iframe { display: block; width: 100%; height: 420px; border: 0; background: #fff; }
  .foot { margin-top: 22px; color: #6b7280; font-size: 13px; }
</style>
</head>
<body>
<h1>互动答题卡 1.1.6 · 答完效果预览</h1>
<p class="lead">这一页用的是插件里那份真实的 <code>quiz.js</code> / <code>quiz.css</code>，每格是一张真卡片
（iframe 里自动帮你点成「已答完」的样子）。<b>选择题 / 判断题只看颜色，填空题把标准答案写进空里。</b></p>
<div class="grid" id="grid"></div>
<p class="foot">灰色小字里的「→ 北京」就是现在的呈现方式；反馈区那句「正确答案：…」已经去掉。
想自己动手点，直接在格子里刷新（iframe 会重新跑一遍演示）或到 Anki 里试。</p>
<script id="payload" type="application/json">__PAYLOAD__</script>
<script>
(function () {
  var payload = JSON.parse(document.getElementById("payload").textContent);
  function decode(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    return new TextDecoder("utf-8").decode(bytes);
  }
  var css = decode(payload.css);
  var js = decode(payload.js);
  var grid = document.getElementById("grid");
  payload.cards.forEach(function (c) {
    var box = document.createElement("div");
    box.className = "frame-box";
    var head = document.createElement("div");
    head.className = "frame-head";
    var t = document.createElement("div");
    t.className = "frame-title";
    t.textContent = c.title;
    var h = document.createElement("div");
    h.className = "frame-hint";
    h.textContent = c.hint;
    head.appendChild(t);
    head.appendChild(h);
    var frame = document.createElement("iframe");
    frame.setAttribute("title", c.title);
    frame.srcdoc =
      '<!doctype html><html><head><meta charset="utf-8"><style>' + css + "</style></head>" +
      '<body style="margin:14px 16px 18px">' + c.html +
      "<scr" + 'ipt>window.__ANKI_QUIZ_CONFIG__ = {};</scr' + "ipt>" +
      "<scr" + 'ipt>' + js + "</scr" + "ipt>" + c.demo +
      "</body></html>";
    box.appendChild(head);
    box.appendChild(frame);
    grid.appendChild(box);
  });
})();
</script>
</body>
</html>
"""


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "css": base64.b64encode(CSS.encode("utf-8")).decode("ascii"),
        "js": base64.b64encode(JS.encode("utf-8")).decode("ascii"),
        "cards": CARDS,
    }
    # 注意：payload 里带 <script>…</script> 的字符串，直接塞进 <script type="application/json">
    # 会让 HTML 解析器在第一个 </script> 处提前收尾。JSON 允许 \/ 转义，所以统一转义 "/"。
    payload_json = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    html = PAGE.replace("__PAYLOAD__", payload_json)
    OUT.write_text(html, encoding="utf-8", newline="\r\n")
    # 自检：base64 解回来必须跟源文件一字不差
    assert base64.b64decode(payload["css"]).decode("utf-8") == CSS
    assert base64.b64decode(payload["js"]).decode("utf-8") == JS
    print("已生成：%s（%d 字节，%d 张卡）" % (OUT, OUT.stat().st_size, len(CARDS)))


if __name__ == "__main__":
    main()
