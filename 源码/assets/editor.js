/* =====================================================================
 * 互动答题卡 · 编辑器助手
 *
 * 直接把字段改造成好用的控件（不是弹窗）：
 *   选择题：隐藏原来的「选项」文本框，换成一行一个输入框 + 右侧「正确」勾选框；
 *           [＋ 添加选项] / 行尾 [×] 增删，Enter 加行、空行按 Backspace 删行、
 *           Alt+↑↓ 上下移动、Alt+数字 勾选/取消第 N 行
 *   判断题：隐藏「答案」文本框，换成一个「正确」勾选框（勾上 = 对，不勾 = 错）
 *   填空题：只显示一行状态（数出几个空 = 几张卡）
 *
 * 字段的读写都由插件（Python 侧）负责：新版 Anki 编辑器的字段内容存在页面自己的
 * 状态里（DOM 里那个 textarea 只是输入代理，改了没用），所以这里的改动会通过
 * pycmd 送回插件，插件先 saveNow 取到真实字段值、换掉我们这一格、再用页面自己的
 * setFields 写回去。没有宿主（老版本 Anki 字段就是 textarea）时退回直接写 textarea。
 * ===================================================================== */
(function () {
  "use strict";

  var MARK_RE = /^\s*[*+\u221a\u2713\u2714]\s?/;
  var LABEL_RE = /^\s*[A-Za-z]\s*[.\u3001)\uFF09\uFF0E:\uFF1A]\s*/;

  var API = window.__IQ_EDITOR__ || {};
  API.cfg = API.cfg || null;
  API.installed = true;
  API.rows = [];
  API.built = false;
  /* 字段名 -> 当前内容（纯文本）。由插件在注入时给初值，之后我们自己的改动同步更新。 */
  API.values = API.values || {};

  /* ---------------- 小工具 ---------------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) {
      node.setAttribute("class", cls);
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function qsa(selector) {
    if (typeof document.querySelectorAll !== "function") {
      return [];
    }
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector) || []);
    } catch (e) {
      return [];
    }
  }

  function allAreas() {
    var areas = qsa(".fields textarea");
    if (!areas.length) {
      areas = qsa(".field-container textarea");
    }
    if (!areas.length) {
      areas = qsa("textarea");
    }
    return areas;
  }

  /* ---------------- 字段块的定位：按名字，不靠顺序 ----------------

     Anki 26 的编辑器里，字段列表是 Svelte 的「按数组下标做 key」：换笔记类型时
     它按位置复用同一批 .field-container 节点，只改 data-index 和字段名。
     字段名在 <span class="label-name"> 里（".field-label" 只是 slot 名，不是 class）。
     所以「藏字段、挂控件」都得先按名字确认这块真的是那个字段，
     只按位置记着「我藏过第 2 块」的话，换题型就会把新题型的字段带累。 */

  function fieldBlocks() {
    var blocks = qsa(".fields .field-container");
    if (!blocks.length) {
      blocks = qsa(".field-container");
    }
    return blocks;
  }

  function trimText(text) {
    return String(text === null || text === undefined ? "" : text)
      .replace(/[\s\u00a0]+/g, " ")
      .replace(/^ | $/g, "");
  }

  /* 这块字段叫什么（认不出来返回空串） */
  function blockName(node) {
    if (!node || typeof node.querySelector !== "function") {
      return "";
    }
    var label = null;
    try {
      label = node.querySelector(".label-name");
    } catch (e) {
      label = null;
    }
    return label ? trimText(label.textContent) : "";
  }

  function blockIndex(node) {
    var raw = node && node.getAttribute ? node.getAttribute("data-index") : null;
    var num = parseInt(raw, 10);
    return isNaN(num) ? -1 : num;
  }

  /* 按字段名找字段块。名字对得上才认；读不到名字又对不上字段表时返回 null ——
     宁可不藏（顶多自己多显示一块），也绝不藏错（那会让用户没法填）。 */
  function blockFor(name) {
    var blocks = fieldBlocks();
    if (!blocks.length) {
      return null;
    }
    var want = API.index(name);
    var named = [];
    var readable = false;
    for (var i = 0; i < blocks.length; i++) {
      var label = blockName(blocks[i]);
      if (label) {
        readable = true;
      }
      if (label === name) {
        named.push(blocks[i]);
      }
    }
    if (named.length > 1 && want >= 0) {
      for (var j = 0; j < named.length; j++) {
        if (blockIndex(named[j]) === want) {
          return named[j];
        }
      }
    }
    if (named.length) {
      return named[0];
    }
    /* 老版本 Anki 上字段名读不到：只在块数和字段表一致、位置也对得上时才敢认 */
    if (readable || want < 0) {
      return null;
    }
    var names = (API.cfg && API.cfg.fields) || [];
    if (blocks.length !== names.length) {
      return null;
    }
    var node = blocks[want] || null;
    if (node && blockIndex(node) >= 0 && blockIndex(node) !== want) {
      return null;
    }
    return node;
  }

  API.blockFor = blockFor;

  /* 字段块里的输入代理 textarea（字段内容由插件从 Python 侧给，这儿只当兜底） */
  function areaIn(node) {
    if (!node || typeof node.querySelector !== "function") {
      return null;
    }
    var inner = null;
    try {
      inner = node.querySelector("textarea");
    } catch (e) {
      inner = null;
    }
    return inner || null;
  }

  /* 页面上的字段表，跟插件给的 cfg 对不对得上。
     换题型的中间态会短暂对不上 —— 那时候先别动手，免得把控件挂到别人的字段上。 */
  function domMatchesCfg() {
    var names = (API.cfg && API.cfg.fields) || [];
    if (!names.length) {
      return false;
    }
    var blocks = fieldBlocks();
    if (blocks.length !== names.length) {
      return false;
    }
    for (var i = 0; i < blocks.length; i++) {
      var at = blockIndex(blocks[i]);
      if (at >= 0 && at !== i) {
        return false;
      }
      var label = blockName(blocks[i]);
      if (label && label !== names[i]) {
        return false;
      }
    }
    /* 一个名字都读不出来的老版本：退回「块数对得上就算对得上」，仍走按顺序的老路 */
    return true;
  }

  API.index = function (name) {
    if (!API.cfg || !API.cfg.fields) {
      return -1;
    }
    return API.cfg.fields.indexOf(name);
  };

  /* 页面上的字段名读不读得出来（只有读不出来时才允许按顺序兜底） */
  function namesReadable() {
    var blocks = fieldBlocks();
    for (var i = 0; i < blocks.length; i++) {
      if (blockName(blocks[i])) {
        return true;
      }
    }
    return false;
  }

  API.area = function (name) {
    var inner = areaIn(blockFor(name));
    if (inner) {
      return inner;
    }
    /* 兜底：老版本 Anki 的字段名读不出来时，退回按顺序取。
       能读出名字却没匹配上（换题型的中间态、字段被改过）时绝不兜底 ——
       宁可不写，也不能把内容写到别人的字段里。 */
    if (namesReadable()) {
      return null;
    }
    var idx = API.index(name);
    var areas = allAreas();
    if (idx < 0 || idx >= areas.length) {
      return null;
    }
    return areas[idx];
  };

  function fire(area) {
    try {
      area.dispatchEvent(new Event("input", { bubbles: true }));
      area.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      /* 忽略 */
    }
  }

  API.setValue = function (area, value) {
    if (!area) {
      return false;
    }
    area.value = value;
    fire(area);
    return true;
  };

  /* ---------------- 字段值的读写 ---------------- */

  /* 插件给的字段值是 HTML（Anki 存的就是 HTML），转成按行可用的纯文本 */
  function decodeEntities(text) {
    return String(text)
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&amp;/gi, "&");
  }

  function htmlToText(html) {
    var s = String(html === null || html === undefined ? "" : html);
    s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\s*\/\s*(div|p|li|tr|h[1-6]|blockquote|pre|ul|ol|table|dd|dt)\s*>/gi, "\n");
    s = s.replace(/<\s*(div|p|li|tr|h[1-6]|blockquote|pre|ul|ol|table|dd|dt)\b[^>]*>/gi, "\n");
    s = s.replace(/<[^>]*>/g, "");
    return decodeEntities(s);
  }

  /* 取某个字段当前的文本：优先用插件给的/我们自己写过的值，没有才回退到 DOM */
  API.fieldText = function (name) {
    if (API.values && Object.prototype.hasOwnProperty.call(API.values, name)) {
      var cached = API.values[name];
      return cached === null || cached === undefined ? "" : String(cached);
    }
    var area = API.area(name);
    return area ? String(area.value === null || area.value === undefined ? "" : area.value) : "";
  };

  /* 插件同步过来的「原生字段值」：给状态行、知识点预览这类只读展示用 */
  API.native = API.native || {};

  API.nativeText = function (name) {
    if (API.native && Object.prototype.hasOwnProperty.call(API.native, name)) {
      var v = API.native[name];
      return v === null || v === undefined ? "" : String(v);
    }
    return API.fieldText(name);
  };

  API.setNative = function (values) {
    if (!values || !API.cfg) {
      return false;
    }
    var names = API.cfg.fields || [];
    API.native = {};
    API.raw = {};
    for (var i = 0; i < names.length; i++) {
      if (values.length > i) {
        API.raw[names[i]] = values[i] === null || values[i] === undefined ? "" : String(values[i]);
        API.native[names[i]] = htmlToText(values[i]);
      }
    }
    return true;
  };

  /* 原始（未去标签）字段值：判断题的隐藏标记要靠它才找得到 */
  API.raw = API.raw || {};

  API.rawText = function (name) {
    if (API.raw && Object.prototype.hasOwnProperty.call(API.raw, name)) {
      var v = API.raw[name];
      return v === null || v === undefined ? "" : String(v);
    }
    var area = API.area(name);
    return area ? String(area.value === null || area.value === undefined ? "" : area.value) : "";
  };

  /* 把字段内容送回插件（插件再用页面自己的 setFields 写回 Anki） */
  function sendToHost(index, text) {
    if (typeof pycmd !== "function") {
      return false;
    }
    try {
      pycmd("iq:editor:set:" + index + ":" + encodeURIComponent(text));
      return true;
    } catch (e) {
      return false;
    }
  }

  function commitField(name, text) {
    var index = API.index(name);
    if (index < 0) {
      return false;
    }
    API.values[name] = text;
    if (sendToHost(index, text)) {
      return true;
    }
    /* 没有宿主：老版本 Anki 的字段就是一个 textarea，直接写 */
    return API.setValue(API.area(name), text);
  }

  API.commit = commitField;

  API.dump = function () {
    var out = {};
    var names = (API.cfg && API.cfg.fields) || [];
    for (var i = 0; i < names.length; i++) {
      out[names[i]] = API.fieldText(names[i]);
    }
    return JSON.stringify(out);
  };

  API.apply = function (values) {
    var ok = 0;
    for (var key in values) {
      if (Object.prototype.hasOwnProperty.call(values, key) && commitField(key, values[key])) {
        ok++;
      }
    }
    API.build();
    return ok;
  };

  /* 藏 / 还原是一对：只认我们自己打过标记的字段块（data-iq-hidden），
     绝不去碰 Anki 自己的 .field-container.hide（那是图片遮挡在用的）。 */
  var HIDE_MARK = "data-iq-hidden";

  function hideBlock(node) {
    if (!node) {
      return null;
    }
    if (!node.style) {
      node.style = {};
    }
    if (typeof node.style.setProperty === "function") {
      node.style.setProperty("display", "none", "important");
    } else {
      node.style.display = "none";
    }
    if (node.classList && typeof node.classList.add === "function") {
      /* 编辑器重新渲染时可能会覆盖内联样式，用 class 兜一层 */
      node.classList.add("iq-hidden");
    }
    if (node.setAttribute) {
      node.setAttribute(HIDE_MARK, "1");
    }
    return node;
  }

  function unhideBlock(node) {
    if (!node) {
      return null;
    }
    if (node.classList && typeof node.classList.remove === "function") {
      node.classList.remove("iq-hidden");
    }
    if (node.style) {
      if (typeof node.style.removeProperty === "function") {
        try {
          node.style.removeProperty("display");
        } catch (e) {
          /* 忽略 */
        }
      }
      node.style.display = "";
    }
    if (node.removeAttribute) {
      node.removeAttribute(HIDE_MARK);
    }
    return node;
  }

  /* 现在被我们藏着的块（可能还带着上一轮、上一个题型的痕迹） */
  function taggedBlocks() {
    var out = [];
    function add(node) {
      if (node && out.indexOf(node) < 0) {
        out.push(node);
      }
    }
    var marked = qsa(".iq-hidden");
    for (var i = 0; i < marked.length; i++) {
      add(marked[i]);
    }
    var blocks = fieldBlocks();
    for (var j = 0; j < blocks.length; j++) {
      if (blocks[j].getAttribute && blocks[j].getAttribute(HIDE_MARK) === "1") {
        add(blocks[j]);
      }
    }
    return out;
  }

  function hasToken(node, token) {
    if (!node) {
      return false;
    }
    var cls = "";
    try {
      cls = String((node.getAttribute && node.getAttribute("class")) || node.className || "");
    } catch (e) {
      cls = "";
    }
    return cls.split(/\s+/).indexOf(token) >= 0;
  }

  /* 往上找到这个字段所在的整块（Anki 的 DOM 层级挺深，实测要爬 8 层） */
  function fieldContainer(area) {
    var node = area;
    for (var i = 0; i < 14 && node; i++) {
      if (hasToken(node, "field-container")) {
        return node;
      }
      if (i > 0 && hasToken(node, "fields")) {
        break;
      }
      node = node.parentNode;
    }
    return null;
  }

  var CSS = [
    ".iq-hidden{display:none !important;}",
    ".iq-ed-host{margin:.4rem 0 .9rem;padding:.6rem .7rem;border:1px solid rgba(128,128,128,.35);",
    "border-radius:8px;font-size:.92rem;}",
    ".iq-ed-host .iq-ed-title{font-weight:600;margin-bottom:.35rem;}",
    ".iq-ed-host .iq-ed-row{display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem;}",
    ".iq-ed-host .iq-ed-input{flex:1 1 auto;min-width:4rem;padding:.25rem .5rem;font:inherit;",
    "border:1px solid rgba(128,128,128,.5);border-radius:6px;background:transparent;color:inherit;}",
    ".iq-ed-host .iq-ed-input:focus{outline:none;border-color:#3b6ef6;}",
    ".iq-ed-host .iq-ed-check{display:flex;align-items:center;gap:.25rem;white-space:nowrap;cursor:pointer;}",
    ".iq-ed-host .iq-ed-del{border:none;background:transparent;cursor:pointer;font-size:1.05rem;",
    "opacity:.55;padding:0 .35rem;color:inherit;}",
    ".iq-ed-host .iq-ed-del:hover{opacity:1;color:#d64545;}",
    ".iq-ed-host .iq-ed-add{margin-top:.2rem;padding:.25rem .7rem;border-radius:6px;cursor:pointer;",
    "border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;font:inherit;}",
    ".iq-ed-host .iq-ed-add:hover{border-color:#3b6ef6;}",
    ".iq-ed-host .iq-ed-tip{opacity:.6;font-size:.78rem;margin-top:.3rem;}",
    ".iq-ed-host .iq-ed-status{margin-top:.35rem;font-weight:600;}",
    ".iq-ed-host .iq-ed-ok{color:#1a9c5b;}",
    ".iq-ed-host .iq-ed-warn{color:#c07000;}",
    ".iq-ed-host .iq-ed-tf{display:flex;align-items:center;gap:.45rem;font-weight:600;cursor:pointer;}",
    ".iq-ed-bar{margin-top:.35rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;}",
    ".iq-ed-mini{padding:.2rem .6rem;border-radius:6px;cursor:pointer;border:1px solid rgba(128,128,128,.5);",
    "background:transparent;color:inherit;font:inherit;font-size:.85rem;white-space:nowrap;}",
    ".iq-ed-mini:hover{border-color:#3b6ef6;}",
    ".iq-ed-mini[disabled]{opacity:.45;cursor:not-allowed;}",
    ".iq-ed-bar-hint{font-size:.78rem;opacity:.75;}",
    ".iq-ed-panel{margin-top:.3rem;padding:.25rem .5rem;width:100%;max-height:15rem;overflow:auto;",
    "border:1px solid rgba(128,128,128,.35);border-radius:8px;}",
    ".iq-ed-panel-row{display:flex;gap:.5rem;align-items:flex-start;padding:.3rem 0;",
    "border-bottom:1px solid rgba(128,128,128,.2);}",
    ".iq-ed-panel-row:last-child{border-bottom:none;}",
    ".iq-ed-panel-body{flex:1 1 auto;min-width:0;}",
    ".iq-ed-panel-title{font-weight:600;font-size:.85rem;}",
    ".iq-ed-panel-text{font-size:.82rem;opacity:.85;white-space:pre-wrap;}",
    ".iq-ed-panel-tags{font-size:.75rem;opacity:.6;}",
    ".iq-ed-knowrow{align-items:center;}",
    ".iq-ed-knowrow-name{flex:0 0 auto;max-width:9rem;overflow:hidden;text-overflow:ellipsis;",
    "white-space:nowrap;font-size:.82rem;font-weight:600;}",
    ".iq-ed-knowrow-input{flex:1 1 auto;min-width:6rem;padding:.25rem .5rem;font:inherit;",
    "font-size:.82rem;border:1px solid rgba(128,128,128,.5);border-radius:6px;background:transparent;color:inherit;}",
    ".iq-ed-knowrow-input:focus{outline:none;border-color:#3b6ef6;}",
  ].join("");

  function ensureStyle() {
    if (document.getElementById && document.getElementById("iq-ed-style")) {
      return;
    }
    var style = document.createElement("style");
    style.setAttribute("id", "iq-ed-style");
    style.textContent = CSS;
    var head = document.head || document.body;
    if (head && head.appendChild) {
      head.appendChild(style);
    }
  }

  /* 把我们的控件插在某个字段容器的后面 */
  function hostAfter(area, block) {
    var old = document.getElementById("iq-ed-host");
    if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }
    var host = el("div", "iq-ed-host");
    host.setAttribute("id", "iq-ed-host");
    var anchor = block || fieldContainer(area) || area;
    var parent = anchor.parentNode || (document.body || null);
    if (!parent) {
      return host;
    }
    var anchorNext = anchor.nextSibling;
    if (typeof parent.insertBefore === "function") {
      parent.insertBefore(host, anchorNext);
    } else {
      parent.appendChild(host);
    }
    return host;
  }

  /* 当前题型下「该整块藏起来」的字段名。

     1.1.4 的 hideLeftoverAnswerField() 由这里接手：题型里万一还残留着「答案」字段
     （Anki 接口不肯删时）也整块藏起来，保证「添加卡片」窗口里看不到它。 */
  function hiddenNames() {
    var mode = API.cfg ? API.cfg.mode : "";
    var names = (API.cfg && API.cfg.fields) || [];
    var out = [];
    if (mode === "choice") {
      out.push("\u9009\u9879");
    }
    if (mode === "choice" || mode === "tf" || mode === "cloze") {
      if (names.indexOf("\u7b54\u6848") >= 0) {
        out.push("\u7b54\u6848");
      }
    }
    return out;
  }

  /* 把「藏了谁」收敛到当前题型该藏的那几个：不在名单上的，一律还原回去。

     每一轮都重算（build 和 900ms 巡检都调）：
     换了题型、编辑器重新渲染之后会自己回到正确状态，不会像以前那样把上一个题型的
     隐藏状态跟着节点带到新题型的同位置字段上。幂等，反复调没副作用。 */
  API.syncHidden = function () {
    var want = hiddenNames();
    var keep = [];
    for (var i = 0; i < want.length; i++) {
      var block = blockFor(want[i]);
      if (block && keep.indexOf(block) < 0) {
        keep.push(block);
      }
    }
    var tagged = taggedBlocks();
    for (var j = 0; j < tagged.length; j++) {
      if (keep.indexOf(tagged[j]) < 0) {
        unhideBlock(tagged[j]);
      }
    }
    for (var k = 0; k < keep.length; k++) {
      hideBlock(keep[k]);
    }
    return keep.length;
  };

  /* 我们插进编辑器页面的控件 */
  var OUR_IDS = [
    "iq-ed-host",
    "iq-ed-tipsbar",
    "iq-ed-tipspanel",
    "iq-ed-knowbar",
    "iq-ed-knowpanel",
  ];

  /* 收摊：摘掉我们的控件，并把我们藏过的字段全部还原（不是我们的题型时，一个都不留） */
  API.teardown = function () {
    if (document.getElementById) {
      for (var i = 0; i < OUR_IDS.length; i++) {
        var node = document.getElementById(OUR_IDS[i]);
        if (node && node.parentNode) {
          node.parentNode.removeChild(node);
        }
      }
    }
    API.rows = [];
    API.list = null;
    API.status = null;
    API.paintTf = null;
    API.built = false;
    API.syncHidden();
    return true;
  };

  /* 不是我们的题型时把巡检停掉，别白跑 */
  API.stopAlive = function () {
    if (API.timer && typeof clearInterval === "function") {
      try {
        clearInterval(API.timer);
      } catch (e) {
        /* 忽略 */
      }
    }
    API.timer = null;
    return true;
  };

  /* ---------------- 解析 ---------------- */

  function parseOptions(text) {
    var lines = String(text === null || text === undefined ? "" : text).split(/\r\n|\r|\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
      if (!line) {
        continue;
      }
      var correct = MARK_RE.test(line);
      var body = line.replace(MARK_RE, "").replace(LABEL_RE, "");
      out.push({ text: body, correct: correct });
    }
    return out;
  }

  function tfValue(text) {
    var t = String(text === null || text === undefined ? "" : text)
      .replace(/[\s\u3002.]/g, "")
      .toLowerCase();
    if (["\u5bf9", "\u6b63\u786e", "\u662f", "\u771f", "\u221a", "\u2713", "\u2714", "t", "true"].indexOf(t) >= 0) {
      return true;
    }
    if (["\u9519", "\u9519\u8bef", "\u5426", "\u5047", "\u00d7", "\u2717", "\u2718", "f", "false"].indexOf(t) >= 0) {
      return false;
    }
    return null;
  }

  function clozeNumbers(text) {
    var out = [];
    var re = /\{\{c(\d+)::/g;
    var m;
    while ((m = re.exec(String(text || ""))) !== null) {
      var n = parseInt(m[1], 10);
      if (n && out.indexOf(n) < 0) {
        out.push(n);
      }
    }
    out.sort(function (a, b) {
      return a - b;
    });
    return out;
  }

  /* ---------------- 选择题：选项行编辑器 ---------------- */

  function writeOptions() {
    if (API.index("\u9009\u9879") < 0) {
      return;
    }
    var lines = [];
    for (var i = 0; i < API.rows.length; i++) {
      var row = API.rows[i];
      var text = String(row.input.value || "").replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
      if (!text) {
        /* 空行先不写进去（勾选状态还在界面上，等填了内容再一起写） */
        continue;
      }
      lines.push((row.box.checked ? "*" : "") + text);
    }
    commitField("\u9009\u9879", lines.join("\n"));
    syncStatus();
  }

  function syncStatus() {
    var node = API.status;
    if (!node) {
      return;
    }
    var total = 0;
    var correct = 0;
    for (var i = 0; i < API.rows.length; i++) {
      if (String(API.rows[i].input.value || "").replace(/\s/g, "")) {
        total++;
      }
      if (API.rows[i].box.checked) {
        correct++;
      }
    }
    var text;
    if (!total) {
      text = "还没有选项，点 [＋ 添加选项] 或按 Enter";
      node.setAttribute("class", "iq-ed-status iq-ed-warn");
    } else if (!correct) {
      text = "\u26a0 \u8fd8\u6ca1\u52fe\u9009\u6b63\u786e\u7b54\u6848\uff08\u53f3\u4fa7\u7684\u6846\uff09";
      node.setAttribute("class", "iq-ed-status iq-ed-warn");
    } else if (correct === 1) {
      text = "\u2705 \u8bc6\u522b\u4e3a\u3010\u5355\u9009\u3011";
      node.setAttribute("class", "iq-ed-status iq-ed-ok");
    } else {
      text =
        "\u2705 \u8bc6\u522b\u4e3a\u3010\u591a\u9009\u3011\uff08" + correct + " \u4e2a\u6b63\u786e\u9879\uff09";
      node.setAttribute("class", "iq-ed-status iq-ed-ok");
    }
    node.textContent = text;
  }

  function removeRow(index, keepFocus) {
    var row = API.rows[index];
    if (!row) {
      return;
    }
    if (row.node.parentNode) {
      row.node.parentNode.removeChild(row.node);
    }
    API.rows.splice(index, 1);
    writeOptions();
    if (keepFocus && API.rows.length) {
      var target = API.rows[Math.max(0, index - 1)];
      try {
        target.input.focus();
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  function moveRow(index, delta) {
    var target = index + delta;
    if (target < 0 || target >= API.rows.length) {
      return;
    }
    var row = API.rows[index];
    API.rows.splice(index, 1);
    API.rows.splice(target, 0, row);
    var list = row.node.parentNode;
    if (list) {
      if (list.removeChild) {
        list.removeChild(row.node);
      }
      var ref = API.rows[target + 1] ? API.rows[target + 1].node : null;
      if (ref && typeof list.insertBefore === "function") {
        list.insertBefore(row.node, ref);
      } else if (list.appendChild) {
        list.appendChild(row.node);
      }
    }
    writeOptions();
    try {
      row.input.focus();
    } catch (e) {
      /* 忽略 */
    }
  }

  function makeRow(text, correct) {
    var row = el("div", "iq-ed-row");
    var input = el("input", "iq-ed-input");
    input.setAttribute("type", "text");
    input.setAttribute("placeholder", "\u9009\u9879\u5185\u5bb9");
    input.value = text || "";

    var label = el("label", "iq-ed-check");
    var box = el("input", "iq-ed-box");
    box.setAttribute("type", "checkbox");
    box.checked = !!correct;
    label.appendChild(box);
    label.appendChild(el("span", "iq-ed-check-text", "\u6b63\u786e"));

    var del = el("button", "iq-ed-del", "\u00d7");
    del.setAttribute("type", "button");
    del.setAttribute("title", "\u5220\u9664\u8fd9\u4e2a\u9009\u9879");

    row.appendChild(input);
    row.appendChild(label);
    row.appendChild(del);

    var entry = { node: row, input: input, box: box };

    input.addEventListener("input", writeOptions);
    box.addEventListener("change", writeOptions);
    del.addEventListener("click", function () {
      removeRow(API.rows.indexOf(entry), false);
    });
    input.addEventListener("keydown", function (ev) {
      var index = API.rows.indexOf(entry);
      if (ev.key === "Enter" || ev.keyCode === 13) {
        ev.preventDefault();
        ev.stopPropagation();
        addRow("", false, index + 1);
        return;
      }
      if ((ev.key === "Backspace" || ev.keyCode === 8) && !input.value) {
        ev.preventDefault();
        ev.stopPropagation();
        removeRow(index, true);
        return;
      }
      if (ev.altKey && (ev.key === "ArrowUp" || ev.keyCode === 38)) {
        ev.preventDefault();
        ev.stopPropagation();
        moveRow(index, -1);
        return;
      }
      if (ev.altKey && (ev.key === "ArrowDown" || ev.keyCode === 40)) {
        ev.preventDefault();
        ev.stopPropagation();
        moveRow(index, 1);
        return;
      }
      var digit = String(ev.key || "").match(/^([1-9])$/);
      if (ev.altKey && digit) {
        ev.preventDefault();
        ev.stopPropagation();
        var target = API.rows[parseInt(digit[1], 10) - 1];
        if (target) {
          target.box.checked = !target.box.checked;
          writeOptions();
        }
      }
    });
    input.addEventListener("paste", function (ev) {
      var data = ev.clipboardData || (window.clipboardData || null);
      var text = data && data.getData ? data.getData("text") : "";
      if (!text || !/\r|\n/.test(text)) {
        return;
      }
      ev.preventDefault();
      var parts = text.replace(/\r\n|\r/g, "\n").split("\n");
      var index = API.rows.indexOf(entry);
      input.value = parts[0];
      var at = index + 1;
      for (var i = 1; i < parts.length; i++) {
        if (parts[i].replace(/\s/g, "")) {
          addRow(parts[i], false, at);
          at++;
        }
      }
      writeOptions();
    });
    return entry;
  }

  function addRow(text, correct, at) {
    var entry = makeRow(text, correct);
    var list = API.list;
    if (!list) {
      return null;
    }
    var index = typeof at === "number" ? at : API.rows.length;
    if (index < 0) {
      index = 0;
    }
    if (index > API.rows.length) {
      index = API.rows.length;
    }
    var ref = API.rows[index] ? API.rows[index].node : null;
    if (ref && typeof list.insertBefore === "function") {
      list.insertBefore(entry.node, ref);
    } else if (list.appendChild) {
      list.appendChild(entry.node);
    }
    API.rows.splice(index, 0, entry);
    writeOptions();
    try {
      entry.input.focus();
    } catch (e) {
      /* 忽略 */
    }
    return entry;
  }

  API.addOption = function () {
    if (!API.cfg || API.cfg.mode !== "choice") {
      return false;
    }
    addRow("", false, API.rows.length);
    return true;
  };

  function buildChoice(area, block) {
    var host = hostAfter(area, block);
    host.appendChild(
      el("div", "iq-ed-title", "\u9009\u9879\uff08\u4e00\u884c\u4e00\u4e2a\uff0c\u53f3\u4fa7\u52fe\u9009\u6b63\u786e\u7b54\u6848\uff09")
    );
    var list = el("div", "iq-ed-list");
    host.appendChild(list);
    var add = el("button", "iq-ed-add", "\uff0b \u6dfb\u52a0\u9009\u9879");
    add.setAttribute("type", "button");
    add.addEventListener("click", function () {
      API.addOption();
    });
    host.appendChild(add);
    var tip = el(
      "div",
      "iq-ed-tip",
      "\u5feb\u6377\u952e\uff1aEnter \u52a0\u4e0b\u4e00\u884c \u00b7 \u7a7a\u884c\u6309 Backspace \u5220\u884c \u00b7 Alt+\u2191\u2193 \u4e0a\u4e0b\u79fb \u00b7 Alt+\u6570\u5b57 \u52fe\u9009\u7b2c N \u884c"
    );
    host.appendChild(tip);
    var status = el("div", "iq-ed-status");
    host.appendChild(status);
    API.list = list;
    API.status = status;
    API.rows = [];
    var parsed = parseOptions(API.fieldText("\u9009\u9879"));
    for (var i = 0; i < parsed.length; i++) {
      addRowAtEnd(parsed[i].text, parsed[i].correct);
    }
    if (!API.rows.length) {
      addRowAtEnd("", false);
    }
    syncStatus();
  }

  function addRowAtEnd(text, correct) {
    var entry = makeRow(text, correct);
    if (API.list && API.list.appendChild) {
      API.list.appendChild(entry.node);
    }
    API.rows.push(entry);
    return entry;
  }

  /* ---------------- 判断题：一个勾选框 ---------------- */

  /* 判断题的真值存在「题目」末尾的隐藏标记里：<!--iq-tf:对--> */
  function tfFlagFromHtml(html) {
    var match = /<!--\s*iq-tf\s*[:：]\s*([^\s>\-]*)\s*-->/i.exec(String(html || ""));
    if (!match) {
      return "";
    }
    var flag = match[1].replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
    return flag === "\u5bf9" || flag === "\u9519" ? flag : "";
  }

  function currentTfFlag() {
    var fromQuestion = tfFlagFromHtml(API.rawText("\u9898\u76ee"));
    if (fromQuestion) {
      return fromQuestion;
    }
    /* 插件写完会推最新值回来；推送还没到之前先认本地这次点的 */
    return API.tfLocal || "";
  }

  function sendTfFlag(flag) {
    API.tfLocal = flag;
    if (typeof pycmd !== "function") {
      return false;
    }
    try {
      pycmd("iq:editor:tf:" + encodeURIComponent(flag));
      return true;
    } catch (e) {
      return false;
    }
  }

  function buildTrueFalse(area, block) {
    var host = hostAfter(area, block);
    var truth = currentTfFlag();
    var wrapper = el("label", "iq-ed-tf");
    var box = el("input", "iq-ed-box");
    box.setAttribute("type", "checkbox");
    box.checked = truth === "\u5bf9";
    wrapper.appendChild(box);
    wrapper.appendChild(el("span", "iq-ed-tf-text", "\u8fd9\u9898\u662f\u6b63\u786e\u7684"));
    host.appendChild(wrapper);
    var hint = el("div", "iq-ed-tip");
    host.appendChild(hint);

    function paint() {
      var flag = currentTfFlag();
      box.checked = flag === "\u5bf9";
      hint.textContent =
        flag === "\u5bf9"
          ? "\u5f53\u524d\uff1a\u5bf9"
          : flag === "\u9519"
          ? "\u5f53\u524d\uff1a\u9519"
          : "\u8fd8\u6ca1\u8bbe\u7f6e\uff1a\u52fe\u4e0a = \u5bf9\uff0c\u4e0d\u52fe = \u9519";
    }

    box.addEventListener("change", function () {
      sendTfFlag(box.checked ? "\u5bf9" : "\u9519");
      paint();
    });
    API.paintTf = paint;
    paint();
  }

  /* ---------------- 填空题：只报状态 ---------------- */

  function buildCloze(area, block) {
    var host = hostAfter(area, block);
    var status = el("div", "iq-ed-status");
    status.setAttribute("id", "iq-ed-cloze-status");
    host.appendChild(status);
    var tip = el(
      "div",
      "iq-ed-tip",
      "\u7528\u5de5\u5177\u680f\u7684\u6316\u7a7a\u6309\u94ae\u6216 Ctrl+Shift+C \u65b0\u5efa\u7a7a"
    );
    host.appendChild(tip);
    paintClozeStatus(API.fieldText("\u9898\u76ee"));
    watchClozeField();
  }

  function paintClozeStatus(text) {
    var node = document.getElementById ? document.getElementById("iq-ed-cloze-status") : null;
    if (!node) {
      return;
    }
    var numbers = clozeNumbers(htmlToText(text));
    if (numbers.length) {
      node.setAttribute("class", "iq-ed-status iq-ed-ok");
      node.textContent =
        "\u5171 " + numbers.length + " \u4e2a\u7a7a \u2192 " + numbers.length + " \u5f20\u5361";
    } else {
      node.setAttribute("class", "iq-ed-status iq-ed-warn");
      node.textContent = "\u26a0 \u9898\u76ee\u91cc\u8fd8\u6ca1\u6709 {{c1::\u7b54\u6848}}";
    }
  }

  /* 填空题的「题目」是用户在原生输入框里打的，我们读不到实时内容，
     所以隔一会儿问插件要一次最新字段值，好把「几张卡」刷出来。 */
  function watchClozeField() {
    if (API.clozeWatch) {
      return;
    }
    if (API.index("\u9898\u76ee") < 0) {
      return;
    }
    API.clozeWatch = watchField("\u9898\u76ee", askHostForValues(500));
  }

  /* 插件把最新字段值推回来（只用来刷新填空题状态行） */
  API.applyNativeValues = function (values) {
    if (!API.cfg || !values || !API.setNative(values)) {
      return false;
    }
    /* 插件推来了带标记的题目：本地的临时猜测可以让位了 */
    if (tfFlagFromHtml(API.rawText("\u9898\u76ee"))) {
      API.tfLocal = "";
    }
    paintClozeStatus(API.nativeText("\u9898\u76ee"));
    paintKnowledge();
    if (API.paintTf) {
      API.paintTf();
    }
    return true;
  };

  /* ---------------- 解题技巧：一键用同标签卡片的技巧 ---------------- */

  function barHost(container, id) {
    var old = document.getElementById ? document.getElementById(id) : null;
    if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }
    var bar = el("div", "iq-ed-bar");
    bar.setAttribute("id", id);
    if (container && container.appendChild) {
      container.appendChild(bar);
    }
    return bar;
  }

  function barHint(bar, text) {
    if (!bar) {
      return;
    }
    var node = bar.querySelector(".iq-ed-bar-hint");
    if (!node) {
      node = el("div", "iq-ed-bar-hint");
      bar.appendChild(node);
    }
    node.textContent = text || "";
    if (node.style) {
      node.style.display = text ? "" : "none";
    }
  }

  function miniButton(text, onClick) {
    var btn = el("button", "iq-ed-mini", text);
    btn.setAttribute("type", "button");
    btn.addEventListener("click", onClick);
    return btn;
  }

  /* 标签框里的标签只存在于页面里（用户没失焦前不会同步到插件），所以自己读一份带走 */
  function currentTags() {
    var out = [];
    var nodes = qsa(".tag-editor .tag");
    for (var i = 0; i < nodes.length; i++) {
      var text = String(nodes[i].textContent || "").replace(/[\s\u00a0]+/g, "");
      if (text && out.indexOf(text) < 0) {
        out.push(text);
      }
    }
    return out;
  }

  function buildTipsBar() {
    var container = blockFor("\u89e3\u9898\u6280\u5de7");
    if (!container) {
      return;
    }
    if (document.getElementById && document.getElementById("iq-ed-tipsbar")) {
      return;
    }
    var bar = barHost(container, "iq-ed-tipsbar");
    bar.appendChild(
      miniButton("\u26a1 \u7528\u540c\u6807\u7b7e\u5361\u7247\u7684\u6280\u5de7", function () {
        var old = document.getElementById ? document.getElementById("iq-ed-tipspanel") : null;
        if (old && old.parentNode) {
          old.parentNode.removeChild(old);
        }
        if (typeof pycmd !== "function") {
          barHint(bar, "\u6ca1\u6709\u63d2\u4ef6\u901a\u9053\uff0c\u627e\u4e0d\u5230\u540c\u6807\u7b7e\u7684\u5361\u7247");
          return;
        }
        barHint(bar, "\u6b63\u5728\u627e\u540c\u6807\u7b7e\u7684\u5361\u7247\u2026");
        try {
          pycmd("iq:editor:tips:" + encodeURIComponent(JSON.stringify(currentTags())));
        } catch (e) {
          barHint(bar, "\u627e\u4e0d\u5230\u63d2\u4ef6\u901a\u9053");
        }
      })
    );
    /* 在「解题技巧」里改完，一键把新内容同步到全库用同一条技巧的卡 */
    bar.appendChild(
      miniButton("\ud83d\udd01 \u540c\u6b65\u5230\u540c\u6280\u5de7\u5361\u7247", function () {
        if (typeof pycmd !== "function") {
          barHint(bar, "\u6ca1\u6709\u63d2\u4ef6\u901a\u9053\uff0c\u540c\u6b65\u4e0d\u4e86");
          return;
        }
        barHint(bar, "\u6b63\u5728\u540c\u6b65\u2026");
        try {
          pycmd(
            "iq:editor:sync-tip:" + encodeURIComponent(API.tipBase === undefined ? "" : API.tipBase)
          );
        } catch (e) {
          barHint(bar, "\u627e\u4e0d\u5230\u63d2\u4ef6\u901a\u9053");
        }
      })
    );
    barHint(bar, "");
  }

  /* 插件把同步结果推过来 */
  API.showSyncResult = function (payload) {
    payload = payload || {};
    var bar = document.getElementById ? document.getElementById("iq-ed-tipsbar") : null;
    if (!bar) {
      return false;
    }
    var reason = payload.reason || "";
    var text;
    if (payload.ok) {
      text =
        "\u5df2\u540c\u6b65\u5230 " +
        (payload.total || payload.synced || 0) +
        " \u5f20\u5361\u7247\uff08\u542b\u672c\u5361\uff09";
    } else if (reason === "empty") {
      text = "\u5148\u5728\u300c\u89e3\u9898\u6280\u5de7\u300d\u91cc\u586b\u4e0a\u5185\u5bb9";
    } else if (reason === "unchanged") {
      text =
        "\u6ca1\u6539\u52a8\uff1a\u5185\u5bb9\u548c\u683c\u5f0f\u90fd\u8ddf\u6253\u5f00\u65f6\u4e00\u6837";
    } else if (reason === "no-base") {
      text = "\u8bfb\u4e0d\u5230\u539f\u6280\u5de7\uff1a\u5148\u5173\u6389\u91cd\u5f00\u8fd9\u5f20\u5361\u518d\u8bd5";
    } else if (reason === "only-self") {
      text = "\u6ca1\u6709\u522b\u7684\u5361\u7247\u7528\u8fd9\u6761\u6280\u5de7";
    } else if (reason === "declined") {
      text = "\u5df2\u53d6\u6d88\uff0c\u6ca1\u540c\u6b65";
    } else if (payload.error) {
      text = "\u540c\u6b65\u5931\u8d25\uff1a" + payload.error;
    } else {
      text = "\u6ca1\u80fd\u540c\u6b65";
    }
    barHint(bar, text);
    if (payload.ok && payload.tip_html !== undefined && payload.tip_html !== null) {
      /* 同步成功：基准换成刚写出去的那一份，连着改第二次也能对上 */
      API.tipBase = String(payload.tip_html);
    }
    return true;
  };

  /* 插件把候选技巧推过来 */
  API.showTips = function (payload) {
    payload = payload || {};
    var bar = document.getElementById ? document.getElementById("iq-ed-tipsbar") : null;
    if (!bar) {
      return false;
    }
    var old = document.getElementById ? document.getElementById("iq-ed-tipspanel") : null;
    if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }
    if (payload.error) {
      barHint(bar, "\u6ca1\u67e5\u5230\uff1a" + payload.error);
      return false;
    }
    if (payload.reason === "no-tags") {
      barHint(bar, "\u8fd9\u5f20\u5361\u8fd8\u6ca1\u6709\u6807\u7b7e\uff1a\u5148\u5728\u4e0b\u9762\u52a0\u4e0a\u6807\u7b7e\uff0c\u518d\u70b9\u8fd9\u91cc");
      return false;
    }
    var items = payload.items || [];
    if (!items.length) {
      barHint(bar, "\u540c\u6807\u7b7e\u7684\u5361\u7247\u91cc\u8fd8\u6ca1\u6709\u300c\u89e3\u9898\u6280\u5de7\u300d");
      return false;
    }
    var panel = el("div", "iq-ed-panel");
    panel.setAttribute("id", "iq-ed-tipspanel");
    for (var i = 0; i < items.length; i++) {
      buildTipRow(panel, bar, items[i]);
    }
    bar.appendChild(panel);
    barHint(
      bar,
      "\u627e\u5230 " + items.length + " \u6761" + (payload.total > items.length ? "\uff08\u5171 " + payload.total + " \u6761\uff09" : "") + "\uff0c\u9009\u4e00\u6761\uff1a"
    );
    return true;
  };

  function buildTipRow(panel, bar, item) {
    var row = el("div", "iq-ed-panel-row");
    row.appendChild(
      miniButton("\u7528\u8fd9\u6761", function () {
        /* 连格式一起搬：<br>、&nbsp;、行内格式都保留 */
        var text = item.tip_html || item.tip || "";
        commitField("\u89e3\u9898\u6280\u5de7", text);
        /* 基准换成刚写进来这一份（它就是别的卡也在用的那条） */
        API.tipBase = text;
        barHint(bar, "\u5df2\u586b\u5165");
        if (panel.parentNode) {
          panel.parentNode.removeChild(panel);
        }
      })
    );
    /* 只显示技巧正文 + 共同标签：不再显示题目 */
    var body = el("div", "iq-ed-panel-body");
    body.appendChild(el("div", "iq-ed-panel-text", item.tip || ""));
    if (item.tags && item.tags.length) {
      body.appendChild(el("div", "iq-ed-panel-tags", "\ud83c\udff7 " + item.tags.join(" \u00b7 ")));
    }
    row.appendChild(body);
    panel.appendChild(row);
  }

  /* ---------------- 知识点：标签 -> 链接（逐行配，卡片上点标签跳转） ---------------- */

  /* 点了「📋 读链接」的那一行输入框；插件把剪贴板里的网址推回来时填它 */
  var clipPending = null;

  function trimSpace(text) {
    return String(text === null || text === undefined ? "" : text).replace(
      /^[\s\u00a0]+|[\s\u00a0]+$/g,
      ""
    );
  }

  /* 标签只显示自己那一段：字段里存的是完整路径「父::子」，显示末级名 */
  function lastSegment(label) {
    var full = trimSpace(label);
    var parts = String(full).split("::");
    var last = trimSpace(parts[parts.length - 1]);
    return last || full;
  }

  /* 剪贴板里的真网址：优先 text/html 里的 <a href>，再 text/uri-list，最后纯文本
     （纯文本只有它自己就是网址才算）。跟插件侧 _clipboard_link() 一套顺序。 */
  function linkFromClipboard(clip) {
    if (!clip || typeof clip.getData !== "function") {
      return "";
    }
    var html = "";
    try {
      html = String(clip.getData("text/html") || "");
    } catch (e) {
      html = "";
    }
    if (html) {
      var m = /<a\b([^>]*)>/i.exec(html);
      if (m) {
        var href = trimSpace(decodeEntities(hrefOf(m[1])));
        if (href && isWebTarget(href)) {
          return href;
        }
      }
    }
    var uri = "";
    try {
      uri = String(clip.getData("text/uri-list") || "");
    } catch (e) {
      uri = "";
    }
    var firstUri = trimSpace(String(uri).split(/[\r\n]+/)[0] || "");
    if (firstUri && isWebTarget(firstUri)) {
      return firstUri;
    }
    var plain = "";
    try {
      plain = String(clip.getData("text/plain") || "");
    } catch (e) {
      plain = "";
    }
    plain = trimSpace(plain);
    if (plain && isWebTarget(plain)) {
      return plain;
    }
    return "";
  }

  /* 目标规整：去前后空白（含全角空格），全角冒号只在协议位置归一半角 */
  function normalizeTarget(target) {
    var t = String(target === null || target === undefined ? "" : target).replace(
      /\u3000/g,
      " "
    );
    t = trimSpace(t);
    var m = /^([A-Za-z][A-Za-z0-9+.\-]*)\uff1a/.exec(t);
    if (m) {
      t = m[1] + ":" + t.slice(m[0].length);
    }
    return t;
  }

  /* 像网址吗？跟卡片端、插件侧一套规则（裸域名、www.、//主机 都算） */
  function isWebTarget(target) {
    var t = normalizeTarget(target);
    if (!t) {
      return false;
    }
    var low = t.toLowerCase();
    if (/^(https?|ftp|file|mailto):/.test(low)) {
      return true;
    }
    if (t.indexOf("//") === 0) {
      return true;
    }
    if (low.indexOf("www.") === 0) {
      return true;
    }
    if (/[\s\u3000]/.test(t)) {
      return false;
    }
    if (!/^[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+(:\d+)?([\/?#].*)?$/.test(t)) {
      return false;
    }
    var host = t.split(/[\/?#]/)[0].split(":")[0];
    var parts = host.split(".");
    var last = parts[parts.length - 1];
    return last.length >= 2 && /^[A-Za-z0-9]+$/.test(last);
  }

  /* 网址补协议：www.x.com -> https://www.x.com */
  function webUrl(target) {
    var t = normalizeTarget(target);
    if (/^(https?|ftp|file|mailto):/i.test(t)) {
      return t;
    }
    if (t.indexOf("//") === 0) {
      return "https:" + t;
    }
    return "https://" + t;
  }

  function hrefOf(attrs) {
    var m = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(String(attrs || ""));
    if (!m) {
      return "";
    }
    var raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    return String(raw || "");
  }

  /* 一行里夹着网址（「唐诗 https://…」或「<https://…>」）：前半当标签 */
  function splitEmbeddedTarget(text) {
    var parts = String(text || "").split(/[\s\u3000]+/);
    for (var i = 0; i < parts.length; i++) {
      var token = parts[i].replace(/^[<>「」《》]+|[<>「」《》]+$/g, "");
      if (token && token !== text && isWebTarget(token)) {
        return {
          label: trimSpace(parts.slice(0, i).join(" ")) || token,
          target: token,
          bare: false
        };
      }
    }
    return null;
  }

  /* 一行「标签 -> 链接」；只写链接没有标签的老写法也认（bare = true） */
  function knowledgeLine(text) {
    var first = trimSpace(text);
    if (!first) {
      return null;
    }
    var label = first;
    var target = first;
    var cut = first.indexOf("->");
    var width = 2;
    if (cut < 0) {
      cut = first.indexOf("\u2192");
      width = 1;
    }
    if (cut > 0) {
      label = trimSpace(first.slice(0, cut));
      target = trimSpace(first.slice(cut + width));
      if (target) {
        return { label: label || target, target: target, bare: false };
      }
    }
    var embedded = splitEmbeddedTarget(first);
    if (embedded) {
      return embedded;
    }
    return { label: first, target: first, bare: true };
  }

  /* 字段 HTML 按行切开，但把 <a href="…"> 留在行里（要取 href） */
  function htmlLinesKeepLinks(html) {
    var s = String(html === null || html === undefined ? "" : html);
    s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
    s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, "");
    s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
    s = s.replace(
      /<\s*\/\s*(div|p|li|tr|h[1-6]|section|article|blockquote|pre|ul|ol|table|dd|dt)\s*>/gi,
      "\n"
    );
    s = s.replace(
      /<\s*(div|p|li|tr|h[1-6]|section|article|blockquote|pre|ul|ol|table|dd|dt)\b[^>]*>/gi,
      "\n"
    );
    return s.split(/\r\n|\r|\n/);
  }

  /* 一行 HTML：优先认 <a href="…">锚文字</a>（从浏览器粘链接就是这个形状），
     取 href 当跳转目标、锚文字当标签；没有就退回纯文字写法。 */
  function knowledgeLineFromHtml(line) {
    var text = String(line === null || line === undefined ? "" : line);
    var re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      var href = trimSpace(decodeEntities(hrefOf(m[1])));
      if (!href) {
        continue;
      }
      var label = trimSpace(htmlToText(m[2]));
      return { label: label || href, target: href, bare: !label };
    }
    var plain = knowledgeLine(htmlToText(text));
    if (plain && plain.target) {
      return plain;
    }
    /* 整行就是 <某个网址>（尖括号包着）时，上面的去标签会把整行吃空，这里再认一次 */
    return knowledgeLine(decodeEntities(text));
  }

  /* 字段里所有有效行（标签重复只留第一条），顺序就是卡片上标签的顺序 */
  function knowledgeItems() {
    var lines = htmlLinesKeepLinks(API.rawText("\u77e5\u8bc6\u70b9"));
    var out = [];
    var seen = {};
    for (var i = 0; i < lines.length; i++) {
      var item = knowledgeLineFromHtml(lines[i]);
      if (!item || !item.target) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(seen, item.label)) {
        continue;
      }
      seen[item.label] = true;
      out.push(item);
    }
    return out;
  }

  API.knowledge = function () {
    return knowledgeItems();
  };

  /* 这张卡当前的标签：标签框里那份是新的（可能还没提交），插件给的那份兜底 */
  function tagList() {
    var out = currentTags();
    var saved = (API.cfg && API.cfg.tags) || [];
    for (var i = 0; i < saved.length; i++) {
      var tag = trimSpace(saved[i]);
      if (tag && out.indexOf(tag) < 0) {
        out.push(tag);
      }
    }
    return out;
  }

  /* 面板行 = 标签（前面）+ 字段里的其它行（后面，老内容一律保留） */
  function knowledgeRows() {
    var tags = tagList();
    var items = knowledgeItems();
    var rows = [];
    var used = {};
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      if (used[tag]) {
        continue;
      }
      used[tag] = true;
      var hit = null;
      for (var j = 0; j < items.length; j++) {
        if (items[j].label === tag) {
          hit = items[j];
          break;
        }
      }
      rows.push({
        label: tag,
        target: hit ? hit.target : "",
        bare: hit ? hit.bare : false,
        isTag: true,
      });
    }
    for (var k = 0; k < items.length; k++) {
      if (used[items[k].label]) {
        continue;
      }
      used[items[k].label] = true;
      rows.push({
        label: items[k].label,
        target: items[k].target,
        bare: items[k].bare,
        isTag: false,
      });
    }
    /* 显示用末级名，写回/判重一律用完整路径（label） */
    for (var n = 0; n < rows.length; n++) {
      rows[n].shown = lastSegment(rows[n].label);
    }
    return rows;
  }

  /* 收起来时那一行预览：卡片上会显示哪些标签 */
  function paintKnowledgeHint() {
    var hint = document.getElementById ? document.getElementById("iq-ed-knowhint") : null;
    if (!hint) {
      return false;
    }
    var items = knowledgeItems();
    if (!items.length) {
      hint.textContent = tagList().length
        ? "\u8fd8\u6ca1\u914d\uff1a\u70b9 [\ud83c\udff7 \u914d\u7f6e\u6807\u7b7e\u94fe\u63a5]\uff0c\u7ed9\u6807\u7b7e\u9010\u4e2a\u586b\u94fe\u63a5"
        : "\u8fd8\u6ca1\u914d\uff1a\u5148\u5728\u4e0b\u9762\u7684\u6807\u7b7e\u6846\u52a0\u6807\u7b7e\uff0c\u518d\u70b9 [\ud83c\udff7 \u914d\u7f6e\u6807\u7b7e\u94fe\u63a5]";
      return false;
    }
    var labels = [];
    for (var i = 0; i < items.length; i++) {
      labels.push(lastSegment(items[i].label));
    }
    hint.textContent = "\u5361\u7247\u4e0a\u4f1a\u663e\u793a\uff1a" + labels.join(" \u00b7 ");
    return true;
  }

  /* 面板里当前每行输入框的内容（刷新标签时保留刚打进去、还没提交的） */
  function knowInputs(panel) {
    var out = {};
    if (!panel) {
      return out;
    }
    var rows = panel.querySelectorAll(".iq-ed-knowrow");
    for (var i = 0; i < rows.length; i++) {
      var input = rows[i].querySelector(".iq-ed-knowrow-input");
      /* 标签一律从 data-label 读（完整路径）；行名只显示末级名，不能拿它当标签 */
      var label = rowLabel(rows[i]);
      if (label && input) {
        out[label] = String(input.value === null || input.value === undefined ? "" : input.value);
      }
    }
    return out;
  }

  /* 面板某一行代表的标签（完整路径） */
  function rowLabel(row) {
    if (!row || typeof row.getAttribute !== "function") {
      return "";
    }
    return String(row.getAttribute("data-label") || "");
  }

  function buildKnowledgeRow(panel, bar, row, typed, rowIndex) {
    var node = el("div", "iq-ed-panel-row iq-ed-knowrow");
    node.setAttribute("data-bare", row.bare ? "1" : "0");
    node.setAttribute("data-label", row.label);
    node.setAttribute("data-row", String(rowIndex || 0));
    var nameNode = el("div", "iq-ed-knowrow-name", row.shown || lastSegment(row.label));
    /* 显示的是末级名，悬停能看到完整路径 */
    if (nameNode.setAttribute) {
      nameNode.setAttribute("title", row.label);
    }
    node.appendChild(nameNode);
    var input = el("input", "iq-ed-knowrow-input");
    input.setAttribute("type", "text");
    input.setAttribute("placeholder", "\u7f51\u5740\uff0c\u6216 anki:search:tag:\u2026");
    var value = row.target || "";
    if (typed && Object.prototype.hasOwnProperty.call(typed, row.label)) {
      value = typed[row.label];
    }
    input.value = value;
    input.addEventListener("blur", function () {
      commitKnowledge();
    });
    input.addEventListener("keydown", function (ev) {
      if (ev && (ev.key === "Enter" || ev.keyCode === 13)) {
        if (ev.preventDefault) {
          ev.preventDefault();
        }
        commitKnowledge();
      }
    });
    /* 从浏览器「复制链接」粘进来时，剪贴板的 text/plain 只有锚文字，
       真网址藏在 text/html 的 href 里。这里优先把真网址抠出来。 */
    input.addEventListener("paste", function (ev) {
      var url = linkFromClipboard(ev && ev.clipboardData);
      if (!url) {
        /* 不是网址就什么都不做，照常粘贴 */
        return;
      }
      if (ev && ev.preventDefault) {
        ev.preventDefault();
      }
      input.value = url;
      commitKnowledge();
      barHint(bar, "\u5df2\u8bfb\u5165\uff1a" + url);
    });
    node.appendChild(input);
    node.appendChild(
      miniButton("\u8bd5\u6253\u5f00", function () {
        var target = trimSpace(input.value);
        if (!target) {
          barHint(bar, "\u8fd9\u4e00\u884c\u8fd8\u6ca1\u586b\u94fe\u63a5");
          return;
        }
        if (typeof pycmd === "function") {
          try {
            pycmd("iq:editor:open:" + encodeURIComponent(target));
            return;
          } catch (e) {
            /* 落到下面的兜底 */
          }
        }
        if (typeof window.open === "function" && isWebTarget(target)) {
          try {
            window.open(webUrl(target), "_blank");
          } catch (e) {
            /* 忽略 */
          }
        }
      })
    );
    node.appendChild(
      miniButton("\u00d7", function () {
        input.value = "";
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
        commitKnowledge();
        barHint(bar, "\u5df2\u79fb\u9664\uff1a" + (row.shown || lastSegment(row.label)));
      })
    );
    /* 兜底：已经粘成文字了，点这个从剪贴板重新读一次真网址 */
    node.appendChild(
      miniButton("\ud83d\udccb \u8bfb\u94fe\u63a5", function () {
        clipPending = input;
        if (typeof pycmd !== "function") {
          barHint(bar, "\u6ca1\u6709\u63d2\u4ef6\u901a\u9053\uff0c\u8bfb\u4e0d\u4e86\u526a\u8d34\u677f");
          return;
        }
        barHint(bar, "\u6b63\u5728\u8bfb\u526a\u8d34\u677f\u2026");
        try {
          pycmd("iq:editor:clip:" + String(rowIndex || 0));
        } catch (e) {
          barHint(bar, "\u8bfb\u4e0d\u4e86\u526a\u8d34\u677f");
        }
      })
    );
    panel.appendChild(node);
  }

  /* 重新画面板（默认可选 typed 保留正在输入的内容） */
  function paintKnowledgeRows(typed) {
    var bar = document.getElementById ? document.getElementById("iq-ed-knowbar") : null;
    if (!bar) {
      return null;
    }
    var old = document.getElementById ? document.getElementById("iq-ed-knowpanel") : null;
    if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }
    var panel = el("div", "iq-ed-panel iq-ed-knowpanel");
    panel.setAttribute("id", "iq-ed-knowpanel");
    var rows = knowledgeRows();
    for (var i = 0; i < rows.length; i++) {
      buildKnowledgeRow(panel, bar, rows[i], typed, i);
    }
    if (!rows.length) {
      panel.appendChild(
        el(
          "div",
          "iq-ed-bar-hint",
          "\u8fd9\u5f20\u5361\u8fd8\u6ca1\u6709\u6807\u7b7e\uff1a\u5148\u5728\u4e0b\u9762\u7684\u6807\u7b7e\u6846\u52a0\u4e0a\uff0c\u518d\u70b9\u53f3\u8fb9\u7684\u5237\u65b0"
        )
      );
    }
    var foot = el("div", "iq-ed-panel-row");
    foot.appendChild(
      miniButton("\ud83d\udd04 \u5237\u65b0\u6807\u7b7e", function () {
        paintKnowledgeRows(knowInputs(panel));
      })
    );
    panel.appendChild(foot);
    bar.appendChild(panel);
    return panel;
  }

  /* 把面板里填好的行写回「知识点」字段：一行一条「标签 -> 链接」 */
  function commitKnowledge() {
    var panel = document.getElementById ? document.getElementById("iq-ed-knowpanel") : null;
    if (!panel) {
      return false;
    }
    var rows = panel.querySelectorAll(".iq-ed-knowrow");
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      var input = rows[i].querySelector(".iq-ed-knowrow-input");
      /* 标签从 data-label 读（完整路径）；行名只是末级名的显示，不能当标签 */
      var label = rowLabel(rows[i]);
      var target = input ? trimSpace(input.value) : "";
      if (!target) {
        continue;
      }
      var bare = rows[i].getAttribute("data-bare") === "1";
      lines.push(bare || !label ? target : label + " -> " + target);
    }
    var text = lines.join("\n");
    var saved = commitField("\u77e5\u8bc6\u70b9", text);
    if (saved) {
      /* 宿主马上会把字段推回来；这里先自己同步一份，免得预览还是旧的 */
      API.raw["\u77e5\u8bc6\u70b9"] = text;
      API.native["\u77e5\u8bc6\u70b9"] = text;
    }
    paintKnowledgeHint();
    return saved;
  }

  /* 面板开着就跟着刷新行（保留正在输入的内容），收着只刷新预览行 */
  function paintKnowledge() {
    var hasItems = paintKnowledgeHint();
    var panel = document.getElementById ? document.getElementById("iq-ed-knowpanel") : null;
    if (panel) {
      paintKnowledgeRows(knowInputs(panel));
    }
    return hasItems;
  }

  /* 插件读到了剪贴板里的网址（或空）：填进那一行并写回字段 */
  API.applyClipboard = function (url, index) {
    var panel = document.getElementById ? document.getElementById("iq-ed-knowpanel") : null;
    var bar = document.getElementById ? document.getElementById("iq-ed-knowbar") : null;
    var input = null;
    if (panel && index !== undefined && index !== null) {
      var rows = panel.querySelectorAll(".iq-ed-knowrow");
      var row = rows[Number(index)];
      input = row ? row.querySelector(".iq-ed-knowrow-input") : null;
    }
    if (!input) {
      input = clipPending;
    }
    var text = String(url === null || url === undefined ? "" : url);
    if (!text) {
      if (bar) {
        barHint(
          bar,
          "\u6ca1\u8bfb\u5230\u94fe\u63a5\uff1a\u8bf7\u5bf9\u7740\u7f51\u9875\u4e0a\u7684\u94fe\u63a5\u53f3\u952e \u2192 \u590d\u5236\u94fe\u63a5\u5730\u5740\uff0c\u518d\u70b9\u4e00\u6b21"
        );
      }
      return false;
    }
    if (input) {
      input.value = text;
      commitKnowledge();
    }
    if (bar) {
      barHint(bar, "\u5df2\u8bfb\u5165\uff1a" + text);
    }
    return true;
  };

  function watchField(name, onInput) {
    function editableIn(node) {
      if (!node || typeof node.querySelector !== "function") {
        return null;
      }
      var found = null;
      try {
        found = node.querySelector(".rich-text-editable") || node.querySelector("textarea");
      } catch (e) {
        found = null;
      }
      return found;
    }
    var target = editableIn(blockFor(name));
    if (!target) {
      /* 兜底：读不到字段名的老结构，按顺序找 */
      var index = API.index(name);
      var containers = qsa(".field-container");
      target = index >= 0 && containers[index] ? editableIn(containers[index]) : null;
    }
    if (!target || typeof target.addEventListener !== "function") {
      return null;
    }
    target.addEventListener("input", onInput);
    target.addEventListener("blur", onInput);
    return target;
  }

  function askHostForValues(delay) {
    return function () {
      if (API.refreshTimer || typeof setTimeout !== "function") {
        return;
      }
      API.refreshTimer = setTimeout(function () {
        API.refreshTimer = null;
        if (typeof pycmd === "function") {
          try {
            pycmd("iq:editor:refresh");
          } catch (e) {
            /* 忽略 */
          }
        }
      }, delay);
    };
  }

  function buildKnowledgeBar() {
    var container = blockFor("\u77e5\u8bc6\u70b9");
    if (!container) {
      return;
    }
    if (document.getElementById && document.getElementById("iq-ed-knowbar")) {
      return;
    }
    var bar = barHost(container, "iq-ed-knowbar");
    /* 默认收起：点一下才排出「标签 + 链接」的行 */
    var btn = miniButton("\ud83c\udff7 \u914d\u7f6e\u6807\u7b7e\u94fe\u63a5", function () {
      var panel = document.getElementById ? document.getElementById("iq-ed-knowpanel") : null;
      if (panel) {
        if (panel.parentNode) {
          panel.parentNode.removeChild(panel);
        }
        paintKnowledgeHint();
        return;
      }
      paintKnowledgeRows(null);
    });
    btn.setAttribute("id", "iq-ed-knowtoggle");
    bar.appendChild(btn);
    var hint = el("div", "iq-ed-bar-hint");
    hint.setAttribute("id", "iq-ed-knowhint");
    bar.appendChild(hint);
    watchField("\u77e5\u8bc6\u70b9", askHostForValues(400));
    paintKnowledge();
  }

  function ensureBars() {
    if (!API.cfg || !API.cfg.mode) {
      return;
    }
    /* 隐藏交给按名字重算的 syncHidden()：换题型时不会把上一个题型的隐藏带过来 */
    API.syncHidden();
    if (!document.getElementById || !document.getElementById("iq-ed-tipsbar")) {
      buildTipsBar();
    }
    if (!document.getElementById || !document.getElementById("iq-ed-knowbar")) {
      buildKnowledgeBar();
    }
  }

  /* 插件把最新字段值推过来（例如用户在「题目」里打了字之后） */
  API.setValues = function (values) {
    if (!values || !API.cfg) {
      return false;
    }
    var names = API.cfg.fields || [];
    for (var i = 0; i < names.length; i++) {
      if (values.length > i) {
        API.values[names[i]] = htmlToText(values[i]);
      }
    }
    return true;
  };

  /* ---------------- 组装 ---------------- */

  API.build = function () {
    ensureStyle();
    var old = document.getElementById("iq-ed-host");
    if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }
    API.rows = [];
    API.list = null;
    API.status = null;
    API.built = false;
    API.lastError = null;
    var mode = API.cfg ? API.cfg.mode : "";
    if (mode !== "choice" && mode !== "tf" && mode !== "cloze") {
      /* 不是我们的题型：把控件摘掉、把我们藏过的字段全还原，不在别人的编辑器里留东西 */
      API.teardown();
      return false;
    }
    try {
      /* 先按字段名找到那块（选择题挂「选项」，判断/填空挂「题目」），
         找不到就先不建，等字段渲染好了再来（宁可不建，也不挂到别人的字段上） */
      var anchorName = mode === "choice" ? "\u9009\u9879" : "\u9898\u76ee";
      var block = blockFor(anchorName);
      var area = areaIn(block);
      if (area) {
        if (mode === "choice") {
          buildChoice(area, block);
        } else if (mode === "tf") {
          buildTrueFalse(area, block);
        } else {
          buildCloze(area, block);
        }
        API.built = true;
      }
    } catch (e) {
      /* 出错就当没这回事，绝不挡着编辑；但记下来，方便排查 */
      API.lastError = String((e && e.stack) || e);
      try {
        if (typeof console !== "undefined" && console && console.warn) {
          console.warn("[互动答题卡] 编辑器助手出错:", e);
        }
      } catch (e2) {
        /* 忽略 */
      }
    }
    try {
      ensureBars();
      API.syncHidden();
    } catch (e) {
      API.lastError = API.lastError || String((e && e.stack) || e);
    }
    API.keepAlive();
    return API.built;
  };

  /* 巡检的一轮：先比对，再补隐藏、补控件。

     每一轮先比对「页面上的字段名」和插件给的字段表：
     对不上（换题型的中间态、或者停在别人的题型上）就先收摊、把字段全还原，
     绝不把控件和隐藏挂到别人的字段上；对上了再补。 */
  API.tick = function () {
    if (!API.cfg || !API.cfg.mode) {
      /* 明确不是我们的题型：收摊，别白跑 */
      API.stopAlive();
      return false;
    }
    if (!domMatchesCfg()) {
      /* 中间态：先摘掉控件、把字段全还原。定时器留着 ——
         万一 Anki 没重发注入，切回来对上之后还能自己重建 */
      API.teardown();
      return false;
    }
    API.syncHidden();
    if (!document.getElementById || !document.getElementById("iq-ed-host")) {
      API.build();
      return API.built;
    }
    ensureBars();
    return true;
  };

  /* 编辑器偶尔会重新渲染字段，把我们的隐藏/控件抹掉——每隔一会儿补一次 */
  API.keepAlive = function () {
    if (API.timer || typeof setInterval !== "function") {
      return;
    }
    API.timer = setInterval(API.tick, 900);
  };

  /* 每次编辑器载入另一张笔记 / 换了题型，Anki 会重新注入一次 */
  window.__IQ_EDITOR__ = API;

  /* 注入的时机可能早于字段渲染出来（页面还在加载），所以没找到就过一会儿再试。
     不是我们的题型就直接收摊，别白试 40 次。 */
  API.buildWhenReady = function (tries) {
    tries = tries || 0;
    if (!API.cfg || !API.cfg.mode) {
      API.teardown();
      API.stopAlive();
      return false;
    }
    if (API.build()) {
      return true;
    }
    if (tries < 40 && typeof setTimeout === "function") {
      setTimeout(function () {
        API.buildWhenReady(tries + 1);
      }, 250);
    }
    return false;
  };

  window.__IQ_EDITOR_INSTALL__ = function (cfg) {
    /* 换笔记类型 / 换笔记时 Anki 会重发一次注入：先按新配置收摊，
       把上一轮摘控件、藏字段的痕迹清干净，再从零建一次 */
    API.cfg = cfg || null;
    API.values = {};
    API.native = {};
    API.raw = {};
    API.tfLocal = "";
    API.tipBase = "";
    API.teardown();
    if (API.cfg && API.cfg.values) {
      API.setValues(API.cfg.values);
      API.setNative(API.cfg.values);
    }
    /* 这次打开笔记时「解题技巧」的原始内容：同步时当基准（之后只有
       「用这条」「同步成功」两处会刷新它，刷新字段值不会动它） */
    API.tipBase = API.rawText("\u89e3\u9898\u6280\u5de7");
    return API.buildWhenReady(0);
  };
})();
