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
  /* 被我们整块藏起来的字段容器（选项、以及删不掉的「答案」） */
  API.hiddenAreas = API.hiddenAreas || [];

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

  API.index = function (name) {
    if (!API.cfg || !API.cfg.fields) {
      return -1;
    }
    return API.cfg.fields.indexOf(name);
  };

  API.area = function (name) {
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

  function hide(node) {
    if (!node) {
      return;
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
  function hostAfter(area) {
    var old = document.getElementById("iq-ed-host");
    if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }
    var host = el("div", "iq-ed-host");
    host.setAttribute("id", "iq-ed-host");
    var anchor = fieldContainer(area) || area;
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

  /* 把整个字段容器（连同它上面的字段名）藏起来，只留我们的控件 */
  function hideFieldContainer(area) {
    if (!area) {
      return null;
    }
    hide(area);
    var node = fieldContainer(area);
    if (node) {
      hide(node);
      if (API.hiddenAreas.indexOf(node) < 0) {
        API.hiddenAreas.push(node);
      }
    }
    return node;
  }

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

  function buildChoice(area) {
    hideFieldContainer(area);
    var host = hostAfter(area);
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

  function buildTrueFalse(area) {
    var host = hostAfter(area);
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

  function buildCloze(area) {
    var host = hostAfter(area);
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
    var index = API.index("\u9898\u76ee");
    if (index < 0) {
      return;
    }
    API.clozeWatch = watchField(index, askHostForValues(500));
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
    var area = API.area("\u89e3\u9898\u6280\u5de7");
    var container = area ? fieldContainer(area) : null;
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
    barHint(bar, "");
  }

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
        commitField("\u89e3\u9898\u6280\u5de7", item.tip);
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

  function trimSpace(text) {
    return String(text === null || text === undefined ? "" : text).replace(
      /^[\s\u00a0]+|[\s\u00a0]+$/g,
      ""
    );
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
    return { label: first, target: first, bare: true };
  }

  /* 字段里所有有效行（标签重复只留第一条），顺序就是卡片上标签的顺序 */
  function knowledgeItems() {
    var lines = String(API.nativeText("\u77e5\u8bc6\u70b9") || "").split(/\r\n|\r|\n/);
    var out = [];
    var seen = {};
    for (var i = 0; i < lines.length; i++) {
      var item = knowledgeLine(lines[i]);
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
      labels.push(items[i].label);
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
      var name = rows[i].querySelector(".iq-ed-knowrow-name");
      var input = rows[i].querySelector(".iq-ed-knowrow-input");
      if (name && input) {
        out[String(name.textContent || "")] = String(input.value === null || input.value === undefined ? "" : input.value);
      }
    }
    return out;
  }

  function buildKnowledgeRow(panel, bar, row, typed) {
    var node = el("div", "iq-ed-panel-row iq-ed-knowrow");
    node.setAttribute("data-bare", row.bare ? "1" : "0");
    node.appendChild(el("div", "iq-ed-knowrow-name", row.label));
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
        if (typeof window.open === "function" && /^(https?|mailto):/i.test(target)) {
          try {
            window.open(target, "_blank");
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
        barHint(bar, "\u5df2\u79fb\u9664\uff1a" + row.label);
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
      buildKnowledgeRow(panel, bar, rows[i], typed);
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
      var name = rows[i].querySelector(".iq-ed-knowrow-name");
      var input = rows[i].querySelector(".iq-ed-knowrow-input");
      var label = name ? String(name.textContent || "") : "";
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

  function watchField(index, onInput) {
    if (typeof document.querySelectorAll !== "function") {
      return null;
    }
    var containers = qsa('.field-container[data-index="' + index + '"]');
    if (!containers.length) {
      var all = qsa(".field-container");
      containers = all[index] ? [all[index]] : [];
    }
    var target = containers.length
      ? containers[0].querySelector(".rich-text-editable") || containers[0].querySelector("textarea")
      : null;
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
    var area = API.area("\u77e5\u8bc6\u70b9");
    var container = area ? fieldContainer(area) : null;
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
    watchField(API.index("\u77e5\u8bc6\u70b9"), askHostForValues(400));
    paintKnowledge();
  }

  function ensureBars() {
    if (!API.cfg || !API.cfg.mode) {
      return;
    }
    hideLeftoverAnswerField();
    if (!document.getElementById || !document.getElementById("iq-ed-tipsbar")) {
      buildTipsBar();
    }
    if (!document.getElementById || !document.getElementById("iq-ed-knowbar")) {
      buildKnowledgeBar();
    }
  }

  /* 1.1.4：题型里万一还残留着「答案」字段（Anki 接口不肯删时），在编辑器里整块藏起来，
     保证「添加卡片」窗口里看不到它。字段已经删掉时这里是空转。 */
  function hideLeftoverAnswerField() {
    var mode = API.cfg ? API.cfg.mode : "";
    if (mode !== "choice" && mode !== "tf" && mode !== "cloze") {
      return;
    }
    if (API.index("\u7b54\u6848") < 0) {
      return;
    }
    var area = API.area("\u7b54\u6848");
    var node = area ? fieldContainer(area) : null;
    if (node && API.hiddenAreas.indexOf(node) < 0) {
      hideFieldContainer(area);
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
    API.hiddenAreas = [];
    API.rows = [];
    API.list = null;
    API.status = null;
    API.built = false;
    API.lastError = null;
    var mode = API.cfg ? API.cfg.mode : "";
    try {
      if (mode === "choice") {
        var optionsArea = API.area("\u9009\u9879");
        if (optionsArea) {
          buildChoice(optionsArea);
          API.built = true;
        }
      } else if (mode === "tf") {
        var questionArea = API.area("\u9898\u76ee");
        if (questionArea) {
          buildTrueFalse(questionArea);
          API.built = true;
        }
      } else if (mode === "cloze") {
        var clozeArea = API.area("\u9898\u76ee");
        if (clozeArea) {
          buildCloze(clozeArea);
          API.built = true;
        }
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
    } catch (e) {
      API.lastError = API.lastError || String((e && e.stack) || e);
    }
    API.keepAlive();
    return API.built;
  };

  /* 编辑器偶尔会重新渲染字段，把我们的隐藏/控件抹掉——每隔一会儿补一次 */
  API.keepAlive = function () {
    if (API.timer || typeof setInterval !== "function") {
      return;
    }
    API.timer = setInterval(function () {
      if (!API.cfg || !API.cfg.mode) {
        return;
      }
      for (var h = 0; h < API.hiddenAreas.length; h++) {
        var hidden = API.hiddenAreas[h];
        var stillHidden =
          hidden &&
          hidden.parentNode &&
          ((hidden.style && hidden.style.display === "none") ||
            (hidden.classList &&
              hidden.classList.contains &&
              hidden.classList.contains("iq-hidden")));
        if (hidden && hidden.parentNode && !stillHidden) {
          hide(hidden);
        }
      }
      if (!document.getElementById("iq-ed-host")) {
        API.build();
      } else {
        ensureBars();
      }
    }, 900);
  };

  /* 每次编辑器载入另一张笔记 / 换了题型，Anki 会重新注入一次 */
  window.__IQ_EDITOR__ = API;

  /* 注入的时机可能早于字段渲染出来（页面还在加载），所以没找到就过一会儿再试 */
  API.buildWhenReady = function (tries) {
    tries = tries || 0;
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
    API.cfg = cfg || null;
    API.values = {};
    API.native = {};
    API.raw = {};
    API.tfLocal = "";
    if (API.cfg && API.cfg.values) {
      API.setValues(API.cfg.values);
      API.setNative(API.cfg.values);
    }
    return API.buildWhenReady(0);
  };
})();
