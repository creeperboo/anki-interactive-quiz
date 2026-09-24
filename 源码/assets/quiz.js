/* =====================================================================
 * 互动答题卡 (Interactive Quiz) — 卡片端脚本
 * 支持：选择题（单选 / 多选）、判断题、填空题
 * 判分全部在本地完成，只有「评级」这一个动作需要和 Anki 通信。
 * ===================================================================== */
(function () {
  "use strict";

  var G = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this);

  var DEFAULT_CFG = {
    wrong_action: "reveal",
    auto_continue_seconds: 0,
    shuffle_options: false,
    auto_submit_single_choice: true,
    fill_ignore_case: true,
    fill_ignore_punctuation: true,
    reveal_explanation_on_correct: true,
    show_source: true
  };

  /* =====================================================================
   * 纯逻辑部分：不依赖 DOM，方便单独测试
   * ===================================================================== */

  var BLANK_RE = /\{\{\s*(\d*)\s*\}\}|_{3,}|\uFF3F{3,}|\u3010\s*\u3011|\[\s*\]/g;
  var CORRECT_MARK_RE = /^\s*([*+\u221a\u2713\u2714])\s*/;
  var OPTION_LABEL_RE = /^\s*([A-Za-z])\s*[.\u3001)\uFF09\uFF0E:\uFF1A]\s*/;

  function trim(s) {
    return String(s === null || s === undefined ? "" : s).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
  }

  function safeChar(code) {
    try {
      return String.fromCodePoint(code);
    } catch (e) {
      return "";
    }
  }

  function decodeEntities(s) {
    var t = String(s === null || s === undefined ? "" : s);
    t = t.replace(/&#x([0-9a-fA-F]+);/g, function (m, h) {
      return safeChar(parseInt(h, 16));
    });
    t = t.replace(/&#(\d+);/g, function (m, d) {
      return safeChar(parseInt(d, 10));
    });
    return t
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  /* 把一段 HTML 转成纯文本，块级标签和 <br> 变成换行 */
  function htmlToText(html) {
    var s = String(html === null || html === undefined ? "" : html);
    s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
    s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, "");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\s*\/\s*(div|p|li|tr|h[1-6]|section|article|blockquote|pre|ul|ol|table|dd|dt)\s*>/gi, "\n");
    s = s.replace(/<\s*(div|p|li|tr|h[1-6]|section|article|blockquote|pre|ul|ol|table|dd|dt)\b[^>]*>/gi, "\n");
    s = s.replace(/<[^>]*>/g, "");
    return decodeEntities(s);
  }

  /* 按行拆分字段内容，自动丢掉空行 */
  function splitLines(html) {
    var parts = htmlToText(html).split(/\r\n|\r|\n/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var line = trim(parts[i]);
      if (line) {
        out.push(line);
      }
    }
    return out;
  }

  /* 每行一个选项；行首的 * + √ ✓ ✔ 表示这项是正确的 */
  function parseOptions(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var correct = false;
      var label = "";
      for (var pass = 0; pass < 2; pass++) {
        var mark = line.match(CORRECT_MARK_RE);
        if (mark) {
          correct = true;
          line = trim(line.slice(mark[0].length));
          continue;
        }
        var lab = line.match(OPTION_LABEL_RE);
        if (lab && trim(line.slice(lab[0].length))) {
          label = lab[1];
          line = trim(line.slice(lab[0].length));
        }
      }
      if (!line) {
        continue;
      }
      out.push({ text: line, correct: correct, label: label, index: out.length });
    }
    return out;
  }

  /* 每行一个空；同一行里用 | 分隔的多个写法都算对 */
  function parseAnswerGroups(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split(/[|\uFF5C]/);
      var alts = [];
      for (var j = 0; j < parts.length; j++) {
        var a = trim(parts[j]);
        if (a) {
          alts.push(a);
        }
      }
      if (alts.length) {
        out.push(alts);
      }
    }
    return out;
  }

  function normalizeAnswer(s, cfg) {
    var t = String(s === null || s === undefined ? "" : s);
    t = t.replace(/\u3000/g, " ");
    /* 全角转半角 */
    t = t.replace(/[\uFF01-\uFF5E]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
    t = t
      .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
      .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
      .replace(/[\u2013\u2014\u2212]/g, "-");
    if (cfg && cfg.fill_ignore_punctuation) {
      t = t.replace(/[\s\u3001\u3002.,;:!?'"`~()\[\]{}<>\/\\|@#$%^&*+=_-]/g, "");
    } else {
      t = trim(t.replace(/\s+/g, " "));
    }
    if (cfg && cfg.fill_ignore_case) {
      t = t.toLowerCase();
    }
    return t;
  }

  /* 某个空的作答是否正确；没有配置答案时，只要填了就算对 */
  function isBlankCorrect(input, group, cfg) {
    var raw = trim(input);
    if (!group || !group.length) {
      return raw.length > 0;
    }
    var user = normalizeAnswer(raw, cfg);
    if (!user) {
      return false;
    }
    for (var i = 0; i < group.length; i++) {
      if (normalizeAnswer(group[i], cfg) === user) {
        return true;
      }
    }
    return false;
  }

  var TF_TRUE = ["\u5bf9", "\u6b63\u786e", "\u662f", "\u771f", "\u221a", "\u2713", "\u2714", "t", "true", "yes", "y"];
  var TF_FALSE = ["\u9519", "\u9519\u8bef", "\u5426", "\u5047", "\u00d7", "\u2717", "\u2718", "f", "false", "no", "n"];

  function tfValue(group) {
    if (!group || !group.length) {
      return null;
    }
    var v = normalizeAnswer(group[0], { fill_ignore_punctuation: false, fill_ignore_case: true });
    if (TF_TRUE.indexOf(v) >= 0) {
      return true;
    }
    if (TF_FALSE.indexOf(v) >= 0) {
      return false;
    }
    return null;
  }

  function normalizeTypeHint(s) {
    var t = trim(s).toLowerCase();
    if (!t || t === "auto" || t === "\u81ea\u52a8") {
      return "";
    }
    if (/\u591a\u9009|multiple|multi/.test(t)) {
      return "choice";
    }
    if (/\u9009\u62e9|\u5355\u9009|choice|mcq/.test(t)) {
      return "choice";
    }
    if (/\u5224\u65ad|\u662f\u975e|true.?false|^tf$/.test(t)) {
      return "tf";
    }
    if (/\u586b\u7a7a|\u5b8c\u5f62|cloze|fill|blank/.test(t)) {
      return "fill";
    }
    return "";
  }

  function detectMode(hint, options, answers, blankCount) {
    var h = normalizeTypeHint(hint);
    if (h === "tf") {
      return "tf";
    }
    if (h === "fill") {
      return "fill";
    }
    if (h === "choice" && options.length >= 2) {
      return "choice";
    }
    if (options.length >= 2) {
      return "choice";
    }
    if (blankCount > 0) {
      return "fill";
    }
    if (answers.length && tfValue(answers[0]) !== null) {
      return "tf";
    }
    if (answers.length) {
      return "fill";
    }
    return "plain";
  }

  /* 「答案」里写 A / B / AB 时，把选项的正确标记改过来 */
  function applyLetterAnswers(options, groups) {
    if (!groups.length) {
      return false;
    }
    var letters = [];
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].length; j++) {
        var part = normalizeAnswer(groups[i][j], { fill_ignore_punctuation: true, fill_ignore_case: true });
        var m = part.match(/^\(?([a-z])\)?$/);
        if (m) {
          letters.push(m[1]);
          continue;
        }
        if (/^[a-z]{2,8}$/.test(part)) {
          for (var k = 0; k < part.length; k++) {
            letters.push(part.charAt(k));
          }
        }
      }
    }
    if (!letters.length) {
      return false;
    }
    var hits = [];
    var matched = 0;
    for (var o = 0; o < options.length; o++) {
      var lab = options[o].label ? options[o].label.toLowerCase() : "";
      var isHit = lab && letters.indexOf(lab) >= 0;
      hits.push(!!isHit);
      if (isHit) {
        matched++;
      }
    }
    if (!matched) {
      return false;
    }
    for (var p = 0; p < options.length; p++) {
      options[p].correct = hits[p];
    }
    return true;
  }

  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function letterFor(i) {
    return String.fromCharCode(65 + (i % 26));
  }

  G.__IQ_CORE = {
    DEFAULT_CFG: DEFAULT_CFG,
    trim: trim,
    htmlToText: htmlToText,
    splitLines: splitLines,
    parseOptions: parseOptions,
    parseAnswerGroups: parseAnswerGroups,
    normalizeAnswer: normalizeAnswer,
    isBlankCorrect: isBlankCorrect,
    tfValue: tfValue,
    detectMode: detectMode,
    normalizeTypeHint: normalizeTypeHint,
    applyLetterAnswers: applyLetterAnswers
  };

  if (typeof document === "undefined") {
    return;
  }

  /* =====================================================================
   * 与 Anki 通信
   * ===================================================================== */

  function send(message) {
    /* 手机 / AnkiWeb 上没有插件通道：什么都别发，免得点了没反应还把按钮变灰 */
    if (!hostPresent()) {
      return false;
    }
    try {
      if (typeof pycmd === "function") {
        pycmd(message);
        return true;
      }
      if (typeof bridgeCommand === "function") {
        bridgeCommand(message);
        return true;
      }
    } catch (e) {
      /* 忽略，下面的返回值告诉调用方没发出去 */
    }
    return false;
  }

  /* 桌面插件会往卡片里注入 window.__ANKI_QUIZ_CONFIG__；
     手机上这个注入不会发生，所以"有没有注入"就是"能不能自动评级"的判据。 */
  function hostPresent() {
    var injected = G.__ANKI_QUIZ_CONFIG__;
    return !!(injected && typeof injected === "object");
  }

  function currentConfig() {
    var cfg = {};
    var key;
    for (key in DEFAULT_CFG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, key)) {
        cfg[key] = DEFAULT_CFG[key];
      }
    }
    var injected = G.__ANKI_QUIZ_CONFIG__;
    if (injected && typeof injected === "object") {
      for (key in injected) {
        if (Object.prototype.hasOwnProperty.call(injected, key)) {
          cfg[key] = injected[key];
        }
      }
    }
    return cfg;
  }

  /* =====================================================================
   * DOM 小工具
   * ===================================================================== */

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function show(node, on) {
    if (!node) {
      return;
    }
    if (on) {
      node.removeAttribute("hidden");
    } else {
      node.setAttribute("hidden", "hidden");
    }
  }

  /* =====================================================================
   * 读字段
   * ===================================================================== */

  function rawHTML(id) {
    var node = $(id);
    return node ? node.innerHTML : "";
  }

  /* 判断题的真值存在题目末尾的隐藏标记里：正文<!--iq-tf:对-->（1.1.3 起） */
  var TF_MARKER_RE = /<!--\s*iq-tf\s*[:：]\s*([^\s>\-]*)\s*-->/i;

  function tfMarkerFlag(html) {
    var match = TF_MARKER_RE.exec(String(html === null || html === undefined ? "" : html));
    if (!match) {
      return "";
    }
    var flag = trim(match[1]);
    return flag === "\u5bf9" || flag === "\u9519" ? flag : "";
  }

  /* 先看隐藏副本，再看渲染出来的题目（两处都能拿到标记） */
  function readTfFlag() {
    var flag = tfMarkerFlag(rawHTML("iq-raw-question"));
    if (flag) {
      return flag;
    }
    var qEl = $("iq-question");
    return qEl ? tfMarkerFlag(qEl.innerHTML) : "";
  }

  function readData() {
    var options = parseOptions(splitLines(rawHTML("iq-raw-options")));
    var answers = parseAnswerGroups(splitLines(rawHTML("iq-raw-answer")));
    var hint = splitLines(rawHTML("iq-raw-type")).join(" ");
    /* 判断题：真值来自标记；老卡（还有「答案」字段的）走下面的 answers 兜底 */
    var tfFlag = readTfFlag();
    if (tfFlag) {
      answers = [[tfFlag]];
    }
    return {
      options: options,
      answers: answers,
      hint: hint,
      explanation: rawHTML("iq-raw-explanation"),
      explanationText: splitLines(rawHTML("iq-raw-explanation")).join("\n"),
      tips: rawHTML("iq-raw-tips"),
      tipsText: splitLines(rawHTML("iq-raw-tips")).join("\n"),
      source: rawHTML("iq-raw-source"),
      sourceText: splitLines(rawHTML("iq-raw-source")).join("\n"),
      knowledge: parseKnowledge(rawHTML("iq-raw-knowledge"))
    };
  }

  /* 「知识点」：制卡时一行写一条「标签 -> 链接」（只写链接也认），
     卡片上每个标签一个可点的标签，点谁跳谁；标签重复只留第一条。 */
  function parseKnowledgeLine(line) {
    var first = trim(line);
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
      label = trim(first.slice(0, cut));
      target = trim(first.slice(cut + width));
    }
    if (!target) {
      return null;
    }
    return { label: label || target, target: target };
  }

  function parseKnowledge(html) {
    var lines = splitLines(html);
    var out = [];
    var seen = {};
    for (var i = 0; i < lines.length; i++) {
      var item = parseKnowledgeLine(lines[i]);
      if (!item) {
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

  function isWebLink(target) {
    return /^(https?|mailto|file|ftp):/i.test(String(target || ""));
  }

  /* 答完题后点「相关知识点」：桌面端交给插件（网址开浏览器 / 其它当 Anki 搜索式） */
  function openKnowledge(target) {
    return send("iq:open:" + encodeURIComponent(target));
  }

  function buildKnowledgeNode(data) {
    var items = data && data.knowledge;
    if (!items || !items.length) {
      return null;
    }
    var wrap = el("div", "iq-know");
    wrap.appendChild(el("div", "iq-know-label", "\ud83d\udcda \u76f8\u5173\u77e5\u8bc6\u70b9"));
    var box = el("div", "iq-know-tags");
    var searches = [];
    for (var i = 0; i < items.length; i++) {
      buildKnowledgeChip(box, items[i], searches);
    }
    wrap.appendChild(box);
    if (searches.length) {
      var hint = el("div", "iq-know-hint", "\u5728 Anki \u91cc\u641c\uff1a" + searches.join("\uff1b"));
      if (hostPresent()) {
        show(hint, false);
      }
      wrap.appendChild(hint);
    }
    return wrap;
  }

  /* 一个标签一个可点的标签：网址在桌面端交给插件开浏览器（手机上就是普通链接），
     非网址交给插件在卡片浏览器里搜。 */
  function buildKnowledgeChip(box, item, searches) {
    if (isWebLink(item.target)) {
      var link = document.createElement("a");
      link.setAttribute("class", "iq-know-btn");
      link.setAttribute("href", item.target);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener");
      link.appendChild(el("span", "iq-know-text", item.label));
      link.addEventListener("click", function (ev) {
        /* 桌面插件能处理就拦下来，交给系统浏览器；手机上让它自己跳 */
        if (openKnowledge(item.target) && ev && ev.preventDefault) {
          ev.preventDefault();
        }
      });
      box.appendChild(link);
      return;
    }
    var btn = el("button", "iq-know-btn", item.label);
    btn.setAttribute("type", "button");
    btn.addEventListener("click", function () {
      openKnowledge(item.target);
    });
    box.appendChild(btn);
    searches.push(item.target);
  }

  /* =====================================================================
   * 填空题：把题干里的空位标记换成输入框
   * 支持 双大括号（可带序号）、三个以上下划线、空方括号、空中文方括号
   * ===================================================================== */

  function replaceBlanks(root) {
    if (!root) {
      return 0;
    }
    var used = {};
    var maxIdx = 0;

    function register(numStr) {
      var idx = 0;
      if (numStr) {
        idx = parseInt(numStr, 10);
        if (!idx || idx < 1 || used[idx]) {
          idx = 0;
        }
      }
      if (!idx) {
        idx = 1;
        while (used[idx]) {
          idx++;
        }
      }
      used[idx] = true;
      if (idx > maxIdx) {
        maxIdx = idx;
      }
      return idx;
    }

    var textNodes = [];
    (function walk(node) {
      var child = node.firstChild;
      while (child) {
        var next = child.nextSibling;
        if (child.nodeType === 3) {
          textNodes.push(child);
        } else if (child.nodeType === 1) {
          walk(child);
        }
        child = next;
      }
    })(root);

    for (var i = 0; i < textNodes.length; i++) {
      var node = textNodes[i];
      var text = node.nodeValue || "";
      if (!text || (!/[{_\uFF3F\u3010\[]/.test(text))) {
        continue;
      }
      BLANK_RE.lastIndex = 0;
      var frag = document.createDocumentFragment();
      var last = 0;
      var found = false;
      var m;
      while ((m = BLANK_RE.exec(text)) !== null) {
        found = true;
        if (m.index > last) {
          frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        }
        var span = el("span", "iq-blank");
        span.setAttribute("data-blank", String(register(m[1])));
        frag.appendChild(span);
        last = m.index + m[0].length;
        if (m[0].length === 0) {
          BLANK_RE.lastIndex++;
        }
      }
      if (!found) {
        continue;
      }
      if (last < text.length) {
        frag.appendChild(document.createTextNode(text.slice(last)));
      }
      node.parentNode.replaceChild(frag, node);
    }
    return maxIdx;
  }

  /* =====================================================================
   * 原生填空（cloze）题型
   * Anki 渲染出来的当前空位长这样：
   *   <span class="cloze" data-cloze="李白" data-ordinal="1">[...]</span>
   * 其它空位是 class="cloze-inactive"。把当前空位换成输入框，
   * 答案优先读 data-cloze（新版本 Anki 都带），读不到就用插件注入的兜底数据。
   * ===================================================================== */

  function clozeNodes(root) {
    var out = [];
    var all = root.querySelectorAll(".cloze");
    for (var i = 0; i < all.length; i++) {
      if (!all[i].classList.contains("cloze-inactive")) {
        out.push(all[i]);
      }
    }
    return out;
  }

  function injectedClozeTexts() {
    var data = G.__ANKI_QUIZ_CLOZE__;
    if (data && typeof data === "object" && data.texts && typeof data.texts === "object") {
      return data.texts;
    }
    return {};
  }

  /* 把当前空位换成填空用的 span，返回每个空对应的可接受答案 */
  function prepareCloze(root) {
    var nodes = clozeNodes(root);
    if (!nodes.length) {
      return null;
    }
    var fallback = injectedClozeTexts();
    var groups = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var answer = trim(node.getAttribute("data-cloze") || "");
      if (!answer) {
        var ordinal = node.getAttribute("data-ordinal");
        var list = ordinal && fallback[ordinal] ? fallback[ordinal] : null;
        if (list && list.length) {
          answer = trim(list[0]);
        }
      }
      var blank = el("span", "iq-blank");
      blank.setAttribute("data-blank", String(groups.length + 1));
      while (node.firstChild) {
        node.removeChild(node.firstChild);
      }
      node.parentNode.replaceChild(blank, node);
      groups.push(answer ? [answer] : []);
    }
    return groups;
  }

  /* =====================================================================
   * 主流程
   * ===================================================================== */

  var SCORE_KIND = { right: null, wrong: null };

  function boot() {
    var card = $("iq-card");
    if (!card || card.getAttribute("data-iq-ready") === "1") {
      return;
    }
    card.setAttribute("data-iq-ready", "1");
    G.__IQ_BOOTED__ = true;

    var cfg = currentConfig();
    var data = readData();
    var isBack = card.getAttribute("data-side") === "back";

    if (isBack) {
      renderBack(card, data, cfg);
    } else {
      renderFront(card, data, cfg);
    }
    show($("iq-raw"), false);
  }

  function renderFront(card, data, cfg) {
    var qEl = $("iq-question");
    var optionsBox = $("iq-options");
    var controlsBox = $("iq-controls");
    var feedbackBox = $("iq-feedback");
    var actionsBox = $("iq-actions");
    if (!qEl || !optionsBox || !controlsBox || !feedbackBox || !actionsBox) {
      return;
    }

    var blankMax = replaceBlanks(qEl);
    /* 原生填空题型：当前空位已经被 Anki 渲染成 .cloze，换成输入框 */
    var clozeGroups = card.getAttribute("data-iq-cloze") === "1" ? prepareCloze(qEl) : null;
    if (clozeGroups) {
      data.answers = clozeGroups;
      blankMax = clozeGroups.length;
    }
    if (data.options.length >= 2) {
      /* 只有选择题才把「答案 = A / AB」当成选项字母 */
      applyLetterAnswers(data.options, data.answers);
    }
    var mode = clozeGroups ? "fill" : detectMode(data.hint, data.options, data.answers, blankMax);
    if (mode === "plain") {
      show(controlsBox, false);
      return;
    }

    var state = {
      answered: false,
      selection: {},
      multi: false,
      selectedCount: 0,
      partial: false,
      graded: false
    };

    var api = {
      card: card,
      data: data,
      cfg: cfg,
      qEl: qEl,
      optionsBox: optionsBox,
      controlsBox: controlsBox,
      feedbackBox: feedbackBox,
      actionsBox: actionsBox,
      state: state,
      blankMax: blankMax,
      cloze: !!clozeGroups,
      hosted: hostPresent(),
      startedAt: Date.now(),
      modeName: "unknown",
      stopTimer: null
    };

    send("iq:reset");

    if (mode === "choice") {
      renderChoice(api);
    } else if (mode === "tf") {
      renderTrueFalse(api);
    } else {
      renderFill(api);
    }
    startTimer(api);
  }

  /* 只在 show_timer 打开时显示；计时一直走，用于统计平均用时 */
  function startTimer(api) {
    if (!api.cfg.show_timer) {
      return;
    }
    var node = el("div", "iq-timer", "0.0 s");
    api.card.appendChild(node);
    var timer = setInterval(function () {
      if (api.state.answered) {
        clearInterval(timer);
        return;
      }
      node.textContent = ((Date.now() - api.startedAt) / 1000).toFixed(1) + " s";
    }, 200);
    api.stopTimer = function () {
      clearInterval(timer);
      node.textContent = ((Date.now() - api.startedAt) / 1000).toFixed(1) + " s";
    };
  }

  /* ---------------- 选项列表（选择 / 判断共用） ---------------- */

  function buildOptionList(api, items, multi) {
    api.state.multi = !!multi;
    var box = api.optionsBox;
    clear(box);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var node = el("div", "iq-opt");
      node.setAttribute("data-i", String(i));
      node.setAttribute("role", multi ? "checkbox" : "radio");
      node.setAttribute("tabindex", "0");
      node.setAttribute("aria-checked", "false");
      if (!multi) {
        node.appendChild(el("span", "iq-opt-key", letterFor(i)));
      } else {
        node.appendChild(el("span", "iq-opt-key iq-opt-check", ""));
      }
      node.appendChild(el("span", "iq-opt-text", item.text));
      node.addEventListener("click", function (ev) {
        ev.preventDefault();
        toggleOption(api, parseInt(this.getAttribute("data-i"), 10));
      });
      node.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " " || ev.keyCode === 13 || ev.keyCode === 32) {
          ev.preventDefault();
          ev.stopPropagation();
          toggleOption(api, parseInt(this.getAttribute("data-i"), 10));
        }
      });
      box.appendChild(node);
    }
    box.setAttribute("data-count", String(items.length));
    box.setAttribute("data-multi", multi ? "1" : "0");
  }

  function toggleOption(api, index) {
    if (api.state.answered || isNaN(index)) {
      return;
    }
    var nodes = api.optionsBox.children;
    if (!api.state.multi) {
      api.state.selection = {};
      api.state.selection[index] = true;
      for (var i = 0; i < nodes.length; i++) {
        var on = i === index;
        nodes[i].classList.toggle("iq-sel", on);
        nodes[i].setAttribute("aria-checked", on ? "true" : "false");
      }
      updateSubmitState(api);
      if (api.cfg.auto_submit_single_choice) {
        submitChoice(api);
      }
      return;
    }
    var now = !api.state.selection[index];
    api.state.selection[index] = now;
    nodes[index].classList.toggle("iq-sel", now);
    nodes[index].setAttribute("aria-checked", now ? "true" : "false");
    updateSubmitState(api);
  }

  function selectedIndexes(api) {
    var out = [];
    for (var key in api.state.selection) {
      if (Object.prototype.hasOwnProperty.call(api.state.selection, key) && api.state.selection[key]) {
        out.push(parseInt(key, 10));
      }
    }
    out.sort(function (a, b) {
      return a - b;
    });
    return out;
  }

  function updateSubmitState(api) {
    var btn = api.controlsBox.querySelector(".iq-submit");
    if (btn) {
      btn.disabled = selectedIndexes(api).length === 0;
    }
  }

  function renderChoice(api) {
    var items = api.cfg.shuffle_options ? shuffle(api.data.options) : api.data.options.slice();
    var correctCount = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].correct) {
        correctCount++;
      }
    }
    api.items = items;
    api.correctCount = correctCount;
    api.modeName = correctCount > 1 ? "multi" : "single";

    var multi = correctCount > 1;
    buildOptionList(api, items, multi);
    buildControls(api, multi || !api.cfg.auto_submit_single_choice);
  }

  function renderTrueFalse(api) {
    var truth = tfValue(api.data.answers[0]);
    var items = [
      { text: "\u6b63\u786e / \u5bf9", correct: truth === true },
      { text: "\u9519\u8bef / \u9519", correct: truth === false }
    ];
    api.items = items;
    api.correctCount = 1;
    api.modeName = "tf";
    buildOptionList(api, items, false);
    buildControls(api, false);
  }

  function buildControls(api, needSubmit) {
    var box = api.controlsBox;
    clear(box);
    if (needSubmit) {
      var submit = el("button", "iq-btn iq-submit", "\u63d0\u4ea4\u7b54\u6848");
      submit.setAttribute("type", "button");
      submit.disabled = true;
      submit.addEventListener("click", function () {
        submitChoice(api);
      });
      box.appendChild(submit);
    }
    var dontKnow = el("button", "iq-btn iq-dontknow", "\u4e0d\u77e5\u9053");
    dontKnow.setAttribute("type", "button");
    dontKnow.addEventListener("click", function () {
      giveUp(api);
    });
    box.appendChild(dontKnow);
  }

  function submitChoice(api) {
    if (api.state.answered) {
      return;
    }
    var picked = selectedIndexes(api);
    if (!picked.length) {
      return;
    }
    var allCorrect = true;
    var missed = false;
    var mispicked = false;
    for (var i = 0; i < api.items.length; i++) {
      var isRight = !!api.items[i].correct;
      var isPicked = picked.indexOf(i) >= 0;
      if (isRight && !isPicked) {
        allCorrect = false;
        missed = true;
      }
      if (!isRight && isPicked) {
        allCorrect = false;
        mispicked = true;
      }
    }
    /* 漏选但没选错 —— 只有在设置里开启时才允许记「困难」 */
    var partial = !allCorrect && missed && !mispicked && !!api.cfg.multi_partial_credit;
    finish(api, allCorrect, picked, { partial: partial });
  }

  /* ---------------- 填空题 ---------------- */

  function renderFill(api) {
    api.modeName = "fill";
    var total = Math.max(api.blankMax, api.data.answers.length);
    if (total < 1) {
      return;
    }
    var holder = null;
    if (api.blankMax < total) {
      holder = el("div", "iq-blank-extra");
      api.qEl.appendChild(holder);
    }

    var spans = {};
    var existing = api.qEl.querySelectorAll(".iq-blank");
    for (var s = 0; s < existing.length; s++) {
      spans[parseInt(existing[s].getAttribute("data-blank"), 10)] = existing[s];
    }

    for (var idx = 1; idx <= total; idx++) {
      var span = spans[idx];
      if (!span) {
        if (!holder) {
          holder = el("div", "iq-blank-extra");
          api.qEl.appendChild(holder);
        }
        span = el("span", "iq-blank");
        span.setAttribute("data-blank", String(idx));
        holder.appendChild(span);
      }
      var group = api.data.answers[idx - 1] || [];
      var longest = 4;
      for (var g = 0; g < group.length; g++) {
        longest = Math.max(longest, String(group[g]).length);
      }
      /* 原生填空不按答案长度给宽度，免得宽度把答案长短透出来 */
      var size = api.cloze ? 12 : Math.min(22, Math.max(4, Math.round(longest * 1.3)));
      var input = el("input", "iq-input");
      input.setAttribute("type", "text");
      input.setAttribute("data-blank", String(idx));
      input.setAttribute("autocomplete", "off");
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("spellcheck", "false");
      input.setAttribute("size", String(size));
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.keyCode === 13) {
          ev.preventDefault();
          ev.stopPropagation();
          submitFill(api);
        }
      });
      span.appendChild(input);
    }

    fillControls(api);

    var first = api.qEl.querySelector(".iq-input");
    if (first) {
      try {
        first.focus();
      } catch (e) {
        /* 某些环境不允许自动聚焦，忽略 */
      }
    }
  }

  function fillControls(api) {
    var box = api.controlsBox;
    clear(box);
    var submit = el("button", "iq-btn iq-submit", "\u63d0\u4ea4\u7b54\u6848");
    submit.setAttribute("type", "button");
    submit.addEventListener("click", function () {
      submitFill(api);
    });
    box.appendChild(submit);
    var dontKnow = el("button", "iq-btn iq-dontknow", "\u4e0d\u77e5\u9053");
    dontKnow.setAttribute("type", "button");
    dontKnow.addEventListener("click", function () {
      giveUp(api);
    });
    box.appendChild(dontKnow);
  }

  function collectInputs(api) {
    var nodes = api.qEl.querySelectorAll(".iq-input");
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      out.push(nodes[i]);
    }
    out.sort(function (a, b) {
      return parseInt(a.getAttribute("data-blank"), 10) - parseInt(b.getAttribute("data-blank"), 10);
    });
    return out;
  }

  function submitFill(api) {
    if (api.state.answered) {
      return;
    }
    var inputs = collectInputs(api);
    if (!inputs.length) {
      return;
    }
    var allCorrect = true;
    for (var i = 0; i < inputs.length; i++) {
      var idx = parseInt(inputs[i].getAttribute("data-blank"), 10);
      var ok = isBlankCorrect(inputs[i].value, api.data.answers[idx - 1], api.cfg);
      if (!ok) {
        allCorrect = false;
      }
    }
    finish(api, allCorrect, null, {});
  }

  /* ---------------- 判分之后的流程 ---------------- */

  function giveUp(api) {
    if (api.state.answered) {
      return;
    }
    finish(api, false, null, { dontknow: true });
  }

  function finish(api, correct, picked, opts) {
    opts = opts || {};
    var fromDontKnow = !!opts.dontknow;
    var partial = !!opts.partial;
    var state = api.state;
    state.answered = true;
    state.partial = partial;
    api.card.setAttribute("data-iq-answered", "1");
    if (api.stopTimer) {
      api.stopTimer();
    }

    /* 把这一题的作答结果告诉插件，用于统计 */
    var elapsed = Math.max(0, Date.now() - api.startedAt);
    send(
      "iq:result:" +
        (api.modeName || "unknown") +
        ":" +
        (correct ? 1 : 0) +
        ":" +
        (fromDontKnow ? 1 : 0) +
        ":" +
        elapsed +
        ":" +
        (partial ? 1 : 0)
    );

    var mode = api.optionsBox.getAttribute("data-count") ? "choice" : "fill";
    if (mode === "choice") {
      lockOptions(api, correct, picked);
    } else {
      revealFillBlanks(api);
    }
    show(api.controlsBox, false);

    var hosted = !!api.hosted;
    var title;
    if (fromDontKnow) {
      title = "\ud83e\udd14 \u4e0d\u77e5\u9053" + (hosted ? " \u2014\u2014 \u8fd9\u9898\u8bb0\u4e3a\u300c\u91cd\u6765\u300d" : "");
    } else if (correct) {
      title = "\u2705 \u56de\u7b54\u6b63\u786e";
    } else if (partial) {
      title =
        "\u26a0\ufe0f \u6f0f\u9009" + (hosted ? " \u2014\u2014 \u8fd9\u9898\u53ea\u80fd\u8bb0\u4e3a\u300c\u56f0\u96be\u300d" : "");
    } else {
      title = "\u274c \u56de\u7b54\u9519\u8bef" + (hosted ? " \u2014\u2014 \u8fd9\u9898\u8bb0\u4e3a\u300c\u91cd\u6765\u300d" : "");
    }

    var feedback = api.feedbackBox;
    clear(feedback);
    feedback.className = "iq-feedback " + (correct ? "iq-ok" : partial ? "iq-warn" : "iq-no");
    feedback.appendChild(el("div", "iq-verdict", title));

    var showExplain = !correct || api.cfg.reveal_explanation_on_correct;
    if (showExplain && api.data.explanationText) {
      var exp = el("div", "iq-explain");
      exp.appendChild(el("div", "iq-block-title", "\u89e3\u6790"));
      var expBody = el("div", "iq-richtext");
      expBody.innerHTML = api.data.explanation;
      exp.appendChild(expBody);
      feedback.appendChild(exp);
    }
    /* 解题技巧：跟「解析」一起出现（答对时是否显示同样看 reveal_explanation_on_correct） */
    if (showExplain && api.data.tipsText) {
      var tip = el("div", "iq-explain iq-tips");
      tip.appendChild(el("div", "iq-block-title", "\u89e3\u9898\u6280\u5de7"));
      var tipBody = el("div", "iq-richtext");
      tipBody.innerHTML = api.data.tips;
      tip.appendChild(tipBody);
      feedback.appendChild(tip);
    }
    if (api.cfg.show_source && api.data.sourceText) {
      var src = el("div", "iq-explain iq-source");
      src.appendChild(el("div", "iq-block-title", "\u6765\u6e90"));
      var srcBody = el("div", "iq-richtext");
      srcBody.innerHTML = api.data.source;
      src.appendChild(srcBody);
      feedback.appendChild(src);
    }
    /* 相关知识点：制卡时设的链接，答完题后一键跳过去 */
    var knowNode = buildKnowledgeNode(api.data);
    if (knowNode) {
      feedback.appendChild(knowNode);
    }
    show(feedback, true);

    if (hosted) {
      if (correct) {
        buildGradeButtons(api);
      } else if (partial) {
        buildPartialButtons(api);
      } else {
        buildAgainButton(api, fromDontKnow);
      }
    } else {
      buildManualGradeHint(api);
    }
  }

  /* 手机 / AnkiWeb：没有插件通道，等级交给你自己按（屏幕下面本来就有 1/2/3/4） */
  function buildManualGradeHint(api) {
    var box = api.actionsBox;
    clear(box);
    var tip = el("div", "iq-manual");
    tip.appendChild(el("div", "iq-manual-main", "\ud83d\udcf1 \u624b\u673a\u6a21\u5f0f\uff1a\u81ea\u5df1\u6765\u8bc4\u7ea7"));
    tip.appendChild(
      el(
        "div",
        "iq-manual-sub",
        "\u70b9\u4e0b\u9762\u7684\u300c\u663e\u793a\u7b54\u6848\u300d\uff0c\u518d\u6309 1 \u91cd\u6765 / 2 \u56f0\u96be / 3 \u826f\u597d / 4 \u7b80\u5355"
      )
    );
    box.appendChild(tip);
    show(box, true);
  }

  function lockOptions(api, correct, picked) {
    var nodes = api.optionsBox.children;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      node.classList.add("iq-locked");
      node.removeAttribute("tabindex");
      var isRight = !!api.items[i].correct;
      var isPicked = picked && picked.indexOf(i) >= 0;
      if (isRight) {
        node.classList.add("iq-correct");
      }
      if (isPicked && !isRight) {
        node.classList.add("iq-wrong");
      }
    }
  }

  /* 判完之后把答案写进空位本身（1.1.5 起不再在反馈区列「正确答案」）：
     答对 -> 卡片里的标准答案；答错 / 不知道 -> 划掉的你填的 + 箭头 + 标准答案。
     这个空本来就没录答案时，保持输入框本来的对错着色。 */
  function revealFillBlanks(api) {
    var inputs = collectInputs(api);
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var idx = parseInt(input.getAttribute("data-blank"), 10);
      var group = api.data.answers[idx - 1];
      var ok = isBlankCorrect(input.value, group, api.cfg);
      var typed = trim(input.value);
      var right = group && group.length ? String(group[0]) : "";
      var blank = input.parentNode;
      if (!right || !blank) {
        /* 没录答案的空：没得揭晓，保持输入框本来的对错着色 */
        input.readOnly = true;
        input.classList.add(ok ? "iq-input-ok" : "iq-input-no");
        continue;
      }
      clear(blank);
      if (!ok && typed) {
        blank.appendChild(el("s", "iq-fill-typed", typed));
        blank.appendChild(el("span", "iq-fill-arrow", "\u2192"));
      }
      blank.appendChild(el("span", "iq-blank-filled", right));
    }
  }

  function buildGradeButtons(api) {
    var box = api.actionsBox;
    clear(box);
    var defs = [
      { ease: 2, cls: "iq-hard", label: "\u56f0\u96be", sub: "Hard" },
      { ease: 3, cls: "iq-good", label: "\u826f\u597d", sub: "Good" },
      { ease: 4, cls: "iq-easy", label: "\u7b80\u5355", sub: "Easy" }
    ];
    for (var i = 0; i < defs.length; i++) {
      (function (def) {
        var btn = el("button", "iq-grade " + def.cls);
        btn.setAttribute("type", "button");
        btn.setAttribute("data-ease", String(def.ease));
        btn.appendChild(el("span", "iq-grade-main", def.label));
        btn.appendChild(el("span", "iq-grade-sub", def.sub));
        btn.addEventListener("click", function () {
          grade(api, def.ease);
        });
        box.appendChild(btn);
      })(defs[i]);
    }
    show(box, true);
  }

  function buildAgainButton(api, fromDontKnow) {
    var box = api.actionsBox;
    clear(box);
    var btn = el("button", "iq-grade iq-again");
    btn.setAttribute("type", "button");
    btn.setAttribute("data-ease", "1");
    btn.appendChild(el("span", "iq-grade-main", "\u7ee7\u7eed"));
    btn.appendChild(el("span", "iq-grade-sub", "\u8bb0\u4e3a\u91cd\u6765"));
    btn.addEventListener("click", function () {
      grade(api, 1);
    });
    box.appendChild(btn);
    show(box, true);

    send("iq:wrong");

    if (api.cfg.wrong_action === "immediate") {
      grade(api, 1);
      return;
    }
    var seconds = Number(api.cfg.auto_continue_seconds) || 0;
    if (seconds > 0) {
      var left = Math.round(seconds);
      var sub = btn.querySelector(".iq-grade-sub");
      if (sub) {
        sub.textContent = left + " \u79d2\u540e\u81ea\u52a8\u7ee7\u7eed";
      }
      var timer = setInterval(function () {
        left -= 1;
        if (api.state.graded) {
          clearInterval(timer);
          return;
        }
        if (left <= 0) {
          clearInterval(timer);
          grade(api, 1);
          return;
        }
        if (sub) {
          sub.textContent = left + " \u79d2\u540e\u81ea\u52a8\u7ee7\u7eed";
        }
      }, 1000);
    }
    if (fromDontKnow) {
      btn.focus();
    }
  }

  /* 漏选：只给「困难」，另外留一个「还是重来」的退路 */
  function buildPartialButtons(api) {
    var box = api.actionsBox;
    clear(box);

    var hard = el("button", "iq-grade iq-hard");
    hard.setAttribute("type", "button");
    hard.setAttribute("data-ease", "2");
    hard.appendChild(el("span", "iq-grade-main", "\u56f0\u96be"));
    hard.appendChild(el("span", "iq-grade-sub", "\u6f0f\u9009"));
    hard.addEventListener("click", function () {
      grade(api, 2);
    });
    box.appendChild(hard);

    var again = el("button", "iq-grade iq-again");
    again.setAttribute("type", "button");
    again.setAttribute("data-ease", "1");
    again.appendChild(el("span", "iq-grade-main", "\u8fd8\u662f\u91cd\u6765"));
    again.appendChild(el("span", "iq-grade-sub", "Again"));
    again.addEventListener("click", function () {
      grade(api, 1);
    });
    box.appendChild(again);

    show(box, true);
    send("iq:partial");
  }

  function grade(api, ease) {
    if (api.state.graded) {
      return;
    }
    api.state.graded = true;
    api.card.setAttribute("data-iq-graded", String(ease));
    var box = api.actionsBox;
    var buttons = box.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].disabled = true;
      if (parseInt(buttons[i].getAttribute("data-ease"), 10) === ease) {
        buttons[i].classList.add("iq-chosen");
      }
    }
    send("iq:grade:" + ease);
  }

  /* ---------------- 答案面 ---------------- */

  function renderBack(card, data, cfg) {
    var qEl = $("iq-question");
    /* 判断题的真值来自题目标记，不是空位答案：背面画两个着色选项，别把它当「多出来的答案」贴在题目后面 */
    var isTfCard = data.options.length < 2 && tfValue(data.answers[0]) !== null;
    var blankMax = qEl && !isTfCard ? replaceBlanks(qEl) : 0;
    if (qEl && !isTfCard) {
      var spans = qEl.querySelectorAll(".iq-blank");
      for (var i = 0; i < spans.length; i++) {
        var idx = parseInt(spans[i].getAttribute("data-blank"), 10);
        var group = data.answers[idx - 1];
        spans[i].textContent = group && group.length ? group[0] : "\uff1f";
        spans[i].classList.add("iq-blank-filled");
      }
      if (blankMax < data.answers.length) {
        /* 有额外答案却没有空位时，直接列在后面 */
        var extra = el("div", "iq-blank-extra");
        for (var j = blankMax; j < data.answers.length; j++) {
          extra.appendChild(el("span", "iq-blank iq-blank-filled", data.answers[j].join(" / ")));
        }
        qEl.appendChild(extra);
      }
    }

    if (data.options.length >= 2) {
      applyLetterAnswers(data.options, data.answers);
      var box = $("iq-options");
      if (box) {
        clear(box);
        for (var k = 0; k < data.options.length; k++) {
          var node = el("div", "iq-opt iq-locked" + (data.options[k].correct ? " iq-correct" : ""));
          node.appendChild(el("span", "iq-opt-key", letterFor(k)));
          node.appendChild(el("span", "iq-opt-text", data.options[k].text));
          box.appendChild(node);
        }
      }
    } else {
      /* 判断题没有「选项」字段：背面现画出「正确 / 错误」两项，靠颜色说明对错 */
      var tfBox = $("iq-options");
      if (isTfCard && tfBox) {
        var truth = tfValue(data.answers[0]);
        clear(tfBox);
        var tfItems = [
          { text: "\u6b63\u786e / \u5bf9", correct: truth === true },
          { text: "\u9519\u8bef / \u9519", correct: truth === false }
        ];
        for (var t = 0; t < tfItems.length; t++) {
          var tfNode = el("div", "iq-opt iq-locked" + (tfItems[t].correct ? " iq-correct" : ""));
          tfNode.appendChild(el("span", "iq-opt-key", letterFor(t)));
          tfNode.appendChild(el("span", "iq-opt-text", tfItems[t].text));
          tfBox.appendChild(tfNode);
        }
      }
    }

    if (cfg.reveal_explanation_on_correct !== false && data.explanationText) {
      var exp = $("iq-explanation");
      if (exp) {
        exp.appendChild(el("div", "iq-block-title", "\u89e3\u6790"));
        var body = el("div", "iq-richtext");
        body.innerHTML = data.explanation;
        exp.appendChild(body);
      }
    }
    if (data.tipsText) {
      var tips = $("iq-tips");
      if (tips) {
        tips.appendChild(el("div", "iq-block-title", "\u89e3\u9898\u6280\u5de7"));
        var tipsBody = el("div", "iq-richtext");
        tipsBody.innerHTML = data.tips;
        tips.appendChild(tipsBody);
      }
    }
    if (cfg.show_source && data.sourceText) {
      var src = $("iq-source");
      if (src) {
        src.appendChild(el("div", "iq-block-title", "\u6765\u6e90"));
        var sbody = el("div", "iq-richtext");
        sbody.innerHTML = data.source;
        src.appendChild(sbody);
      }
    }
    /* 相关知识点：答案面也放一个，手机上（没有插件）点网址链接一样能用 */
    var knowBox = $("iq-knowledge");
    var knowNode = buildKnowledgeNode(data);
    if (knowBox && knowNode) {
      knowBox.appendChild(knowNode);
    }
  }

  function reportError(err) {
    try {
      if (typeof console !== "undefined" && console.error) {
        console.error("[InteractiveQuiz]", err);
      }
    } catch (e) {
      /* 忽略 */
    }
    var card = $("iq-card");
    if (card && !card.querySelector(".iq-error")) {
      card.appendChild(el("div", "iq-error", "\u7b54\u9898\u5361\u811a\u672c\u52a0\u8f7d\u5931\u8d25\uff1a" + err));
    }
  }

  try {
    boot();
  } catch (err) {
    reportError(err);
  }

  return SCORE_KIND;
})();
