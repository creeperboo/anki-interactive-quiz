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
 * 所有改动都会写回隐藏的原生文本框，Anki 自己的保存流程照常工作。
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

  API.dump = function () {
    var out = {};
    var areas = allAreas();
    var names = (API.cfg && API.cfg.fields) || [];
    for (var i = 0; i < names.length && i < areas.length; i++) {
      out[names[i]] = areas[i].value;
    }
    return JSON.stringify(out);
  };

  API.apply = function (values) {
    var ok = 0;
    for (var key in values) {
      if (Object.prototype.hasOwnProperty.call(values, key) && API.setValue(API.area(key), values[key])) {
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
      API.hiddenArea = node;
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
    var area = API.area("\u9009\u9879");
    if (!area) {
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
    API.setValue(area, lines.join("\n"));
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
    var parsed = parseOptions(area.value);
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

  function buildTrueFalse(area) {
    hideFieldContainer(area);
    var host = hostAfter(area);
    var truth = tfValue(area.value);
    var wrapper = el("label", "iq-ed-tf");
    var box = el("input", "iq-ed-box");
    box.setAttribute("type", "checkbox");
    box.checked = truth === true;
    wrapper.appendChild(box);
    wrapper.appendChild(el("span", "iq-ed-tf-text", "\u8fd9\u9898\u662f\u6b63\u786e\u7684"));
    host.appendChild(wrapper);
    var hint = el("div", "iq-ed-tip");
    host.appendChild(hint);

    function paint() {
      var value = tfValue(area.value);
      box.checked = value === true;
      hint.textContent =
        value === true
          ? "\u5f53\u524d\uff1a\u5bf9"
          : value === false
          ? "\u5f53\u524d\uff1a\u9519"
          : "\u8fd8\u6ca1\u8bbe\u7f6e\uff1a\u52fe\u4e0a = \u5bf9\uff0c\u4e0d\u52fe = \u9519";
    }

    box.addEventListener("change", function () {
      API.setValue(area, box.checked ? "\u5bf9" : "\u9519");
      paint();
    });
    paint();
  }

  /* ---------------- 填空题：只报状态 ---------------- */

  function buildCloze(area) {
    var host = hostAfter(area);
    var numbers = clozeNumbers(area.value);
    var status = el(
      "div",
      numbers.length ? "iq-ed-status iq-ed-ok" : "iq-ed-status iq-ed-warn",
      numbers.length
        ? "\u5171 " + numbers.length + " \u4e2a\u7a7a \u2192 " + numbers.length + " \u5f20\u5361"
        : "\u26a0 \u9898\u76ee\u91cc\u8fd8\u6ca1\u6709 {{c1::\u7b54\u6848}}"
    );
    host.appendChild(status);
    var tip = el(
      "div",
      "iq-ed-tip",
      "\u7528\u5de5\u5177\u680f\u7684\u6316\u7a7a\u6309\u94ae\u6216 Ctrl+Shift+C \u65b0\u5efa\u7a7a"
    );
    host.appendChild(tip);
  }

  /* ---------------- 组装 ---------------- */

  API.build = function () {
    ensureStyle();
    var old = document.getElementById("iq-ed-host");
    if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }
    API.hiddenArea = null;
    API.rows = [];
    API.list = null;
    API.status = null;
    API.built = false;
    var mode = API.cfg ? API.cfg.mode : "";
    try {
      if (mode === "choice") {
        var optionsArea = API.area("\u9009\u9879");
        if (optionsArea) {
          buildChoice(optionsArea);
          API.built = true;
        }
      } else if (mode === "tf") {
        var answerArea = API.area("\u7b54\u6848");
        if (answerArea) {
          buildTrueFalse(answerArea);
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
      /* 出错就当没这回事，绝不挡着编辑 */
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
      var hidden = API.hiddenArea;
      var stillHidden =
        hidden &&
        hidden.parentNode &&
        ((hidden.style && hidden.style.display === "none") ||
          (hidden.classList && hidden.classList.contains && hidden.classList.contains("iq-hidden")));
      if (hidden && hidden.parentNode && !stillHidden) {
        hide(hidden);
      }
      if (!document.getElementById("iq-ed-host")) {
        API.build();
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
    return API.buildWhenReady(0);
  };
})();
