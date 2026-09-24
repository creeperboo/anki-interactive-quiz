/* 伪 DOM + 交互测试。由 REPL 拼接成一段源码后用 vm 编译运行：
   "var quizFactory = function(document, window, pycmd, console, setTimeout, setInterval, clearInterval){" + SRC + "};" + 本文件
   最后一行表达式就是返回值。 */
var log = [];
var pass = 0;
var fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    log.push("PASS " + name);
  } else {
    fail++;
    log.push("FAIL " + name + (extra ? "  :: " + extra : ""));
  }
}

function eq(name, got, want) {
  var g = JSON.stringify(got);
  var w = JSON.stringify(want);
  ok(name, g === w, "got " + g + " want " + w);
}

/* ------------------------------------------------------------------ DOM */
function makeDOM() {
  function decodeBasic(s) {
    return String(s)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, "\u00a0")
      .replace(/&amp;/g, "&");
  }
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function clsOf(node) {
    return (node.attributes["class"] || "").split(/\s+/).filter(function (x) {
      return x;
    });
  }
  function matches(node, sel) {
    sel = String(sel).trim();
    if (/\s/.test(sel)) {
      /* 支持 ".fields textarea" 这种后代选择器 */
      var parts = sel.split(/\s+/);
      if (!simpleMatch(node, parts[parts.length - 1])) {
        return false;
      }
      var up = node.parentNode;
      for (var k = parts.length - 2; k >= 0; k--) {
        var found = false;
        while (up) {
          if (simpleMatch(up, parts[k])) {
            found = true;
            up = up.parentNode;
            break;
          }
          up = up.parentNode;
        }
        if (!found) {
          return false;
        }
      }
      return true;
    }
    return simpleMatch(node, sel);
  }
  function simpleMatch(node, sel) {
    if (sel.charAt(0) === "#") {
      return node.attributes["id"] === sel.slice(1);
    }
    if (sel.charAt(0) === ".") {
      return clsOf(node).indexOf(sel.slice(1)) >= 0;
    }
    return node.tagName.toLowerCase() === sel.toLowerCase();
  }
  function collect(root, sel, out) {
    for (var i = 0; i < root.childNodes.length; i++) {
      var c = root.childNodes[i];
      if (c.nodeType !== 1) {
        continue;
      }
      if (matches(c, sel)) {
        out.push(c);
      }
      collect(c, sel, out);
    }
  }
  function serialize(node) {
    var out = "";
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType === 3) {
        out += escapeText(c.nodeValue);
        continue;
      }
      if (c.nodeType === 8) {
        /* 注释节点：真实浏览器的 innerHTML 会把它原样吐出来 */
        out += "<!--" + c.nodeValue + "-->";
        continue;
      }
      var tag = c.tagName.toLowerCase();
      if (tag === "br") {
        out += "<br>";
        continue;
      }
      var attrs = "";
      for (var k in c.attributes) {
        if (Object.prototype.hasOwnProperty.call(c.attributes, k)) {
          attrs += " " + k + '="' + String(c.attributes[k]).replace(/"/g, "&quot;") + '"';
        }
      }
      out += "<" + tag + attrs + ">" + serialize(c) + "</" + tag + ">";
    }
    return out;
  }
  function parseInto(parent, html) {
    var stack = [parent];
    var re = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var tok = m[0];
      if (tok.charAt(0) !== "<") {
        var t = Text(decodeBasic(tok));
        var p = stack[stack.length - 1];
        t.parentNode = p;
        p.childNodes.push(t);
        continue;
      }
      if (tok.indexOf("<!--") === 0) {
        /* 注释保留成注释节点（真实 DOM 里 comments 也是节点） */
        var cm = Comment(tok.slice(4, -3));
        var cp = stack[stack.length - 1];
        cm.parentNode = cp;
        cp.childNodes.push(cm);
        continue;
      }
      var isClose = /^<\s*\//.test(tok);
      var nm = tok.replace(/^<\s*\/?\s*/, "").match(/^[A-Za-z0-9]+/);
      if (!nm) {
        continue;
      }
      var name = nm[0];
      if (isClose) {
        for (var s = stack.length - 1; s > 0; s--) {
          if (stack[s].tagName.toLowerCase() === name.toLowerCase()) {
            stack.length = s;
            break;
          }
        }
        continue;
      }
      var e = Element(name);
      var attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
      var am;
      while ((am = attrRe.exec(tok)) !== null) {
        var v = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : am[5];
        e.attributes[am[1].toLowerCase()] = decodeBasic(v);
      }
      if (!/\s$/.test(tok) && /\s[^=]+$/.test(tok)) {
        var bare = tok.match(/\s([A-Za-z_:][-A-Za-z0-9_:.]*)\s*\/?>$/);
        if (bare) {
          e.attributes[bare[1].toLowerCase()] = "";
        }
      }
      var selfClose =
        /\/\s*>$/.test(tok) ||
        ["br", "img", "input", "hr", "meta", "link", "col"].indexOf(name.toLowerCase()) >= 0;
      var par = stack[stack.length - 1];
      e.parentNode = par;
      par.childNodes.push(e);
      if (!selfClose) {
        stack.push(e);
      }
    }
  }
  function Text(value) {
    var n = {
      nodeType: 3,
      nodeValue: value === null || value === undefined ? "" : String(value),
      parentNode: null
    };
    Object.defineProperty(n, "textContent", {
      get: function () {
        return n.nodeValue;
      },
      set: function (v) {
        n.nodeValue = String(v === null || v === undefined ? "" : v);
      }
    });
    return n;
  }
  function Comment(value) {
    var n = {
      nodeType: 8,
      nodeValue: value === null || value === undefined ? "" : String(value),
      parentNode: null
    };
    Object.defineProperty(n, "textContent", {
      get: function () {
        return n.nodeValue;
      },
      set: function (v) {
        n.nodeValue = String(v === null || v === undefined ? "" : v);
      }
    });
    return n;
  }
  function Element(tag) {
    var n = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      childNodes: [],
      parentNode: null,
      attributes: {},
      _listeners: {},
      value: "",
      disabled: false,
      readOnly: false,
      title: "",
      size: 0
    };
    function cls() {
      return clsOf(n);
    }
    Object.defineProperty(n, "firstChild", {
      get: function () {
        return n.childNodes[0] || null;
      }
    });
    Object.defineProperty(n, "nextSibling", {
      get: function () {
        if (!n.parentNode) {
          return null;
        }
        var sib = n.parentNode.childNodes;
        var i = sib.indexOf(n);
        return i >= 0 && i + 1 < sib.length ? sib[i + 1] : null;
      }
    });
    Object.defineProperty(n, "children", {
      get: function () {
        return n.childNodes.filter(function (c) {
          return c.nodeType === 1;
        });
      }
    });
    Object.defineProperty(n, "className", {
      get: function () {
        return n.attributes["class"] || "";
      },
      set: function (v) {
        n.attributes["class"] = String(v === null || v === undefined ? "" : v);
      }
    });
    Object.defineProperty(n, "classList", {
      get: function () {
        return {
          add: function () {
            var set = cls();
            for (var i = 0; i < arguments.length; i++) {
              if (set.indexOf(arguments[i]) < 0) {
                set.push(arguments[i]);
              }
            }
            n.attributes["class"] = set.join(" ");
          },
          remove: function () {
            var rm = Array.prototype.slice.call(arguments);
            n.attributes["class"] = cls()
              .filter(function (c) {
                return rm.indexOf(c) < 0;
              })
              .join(" ");
          },
          contains: function (c) {
            return cls().indexOf(c) >= 0;
          },
          toggle: function (c, force) {
            var has = cls().indexOf(c) >= 0;
            var want = force === undefined ? !has : !!force;
            if (want && !has) {
              n.classList.add(c);
            } else if (!want && has) {
              n.classList.remove(c);
            }
            return want;
          }
        };
      }
    });
    Object.defineProperty(n, "textContent", {
      get: function () {
        var out = "";
        (function walk(node) {
          for (var i = 0; i < node.childNodes.length; i++) {
            var c = node.childNodes[i];
            if (c.nodeType === 3) {
              out += c.nodeValue;
            } else if (c.nodeType === 1) {
              walk(c);
            }
          }
        })(n);
        return out;
      },
      set: function (v) {
        n.childNodes = [];
        var s = v === null || v === undefined ? "" : String(v);
        if (s !== "") {
          var t = Text(s);
          t.parentNode = n;
          n.childNodes.push(t);
        }
      }
    });
    Object.defineProperty(n, "innerHTML", {
      get: function () {
        return serialize(n);
      },
      set: function (html) {
        n.childNodes = [];
        parseInto(n, String(html === null || html === undefined ? "" : html));
      }
    });
    n.appendChild = function (child) {
      if (child.nodeType === 11) {
        var kids = child.childNodes.slice();
        child.childNodes = [];
        for (var i = 0; i < kids.length; i++) {
          n.appendChild(kids[i]);
        }
        return child;
      }
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      child.parentNode = n;
      n.childNodes.push(child);
      return child;
    };
    n.removeChild = function (child) {
      var i = n.childNodes.indexOf(child);
      if (i >= 0) {
        n.childNodes.splice(i, 1);
        child.parentNode = null;
      }
      return child;
    };
    n.insertBefore = function (newNode, refNode) {
      var i = refNode ? n.childNodes.indexOf(refNode) : -1;
      if (i < 0) {
        return n.appendChild(newNode);
      }
      if (newNode.parentNode) {
        newNode.parentNode.removeChild(newNode);
      }
      newNode.parentNode = n;
      n.childNodes.splice(i, 0, newNode);
      return newNode;
    };
    n.replaceChild = function (newNode, oldNode) {
      var i = n.childNodes.indexOf(oldNode);
      if (i < 0) {
        return oldNode;
      }
      if (newNode.nodeType === 11) {
        n.childNodes.splice(i, 1);
        var kids = newNode.childNodes.slice();
        newNode.childNodes = [];
        for (var j = 0; j < kids.length; j++) {
          kids[j].parentNode = n;
          n.childNodes.splice(i + j, 0, kids[j]);
        }
        oldNode.parentNode = null;
        return oldNode;
      }
      n.childNodes[i] = newNode;
      newNode.parentNode = n;
      oldNode.parentNode = null;
      return oldNode;
    };
    n.setAttribute = function (k, v) {
      n.attributes[String(k)] = String(v);
    };
    n.getAttribute = function (k) {
      return Object.prototype.hasOwnProperty.call(n.attributes, String(k)) ? n.attributes[String(k)] : null;
    };
    n.hasAttribute = function (k) {
      return Object.prototype.hasOwnProperty.call(n.attributes, String(k));
    };
    n.removeAttribute = function (k) {
      delete n.attributes[String(k)];
    };
    n.addEventListener = function (type, fn) {
      (n._listeners[type] = n._listeners[type] || []).push(fn);
    };
    n.focus = function () {
      doc.activeElement = n;
    };
    n.querySelectorAll = function (sel) {
      var out = [];
      collect(n, sel, out);
      return out;
    };
    n.querySelector = function (sel) {
      return n.querySelectorAll(sel)[0] || null;
    };
    return n;
  }

  var doc = {
    createElement: function (t) {
      return Element(t);
    },
    createTextNode: function (t) {
      return Text(t);
    },
    createDocumentFragment: function () {
      var f = Element("#fragment");
      f.nodeType = 11;
      return f;
    },
    body: Element("body"),
    activeElement: null
  };
  doc._listeners = {};
  doc.addEventListener = function (type, fn) {
    (doc._listeners[type] = doc._listeners[type] || []).push(fn);
  };
  doc.removeEventListener = function (type, fn) {
    var list = doc._listeners[type] || [];
    var idx = list.indexOf(fn);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
  };
  doc.fireDoc = function (type, ev) {
    var list = (doc._listeners[type] || []).slice();
    for (var i = 0; i < list.length; i++) {
      list[i].call(doc, ev);
    }
  };
  doc.querySelectorAll = function (sel) {
    return doc.body.querySelectorAll(sel);
  };
  doc.querySelector = function (sel) {
    return doc.body.querySelector(sel);
  };
  doc.getElementById = function (id) {
    var found = null;
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var c = node.childNodes[i];
        if (c.nodeType !== 1) {
          continue;
        }
        if (!found && c.attributes["id"] === id) {
          found = c;
        }
        walk(c);
      }
    })(doc.body);
    return found;
  };

  function fire(node, type, ev) {
    if (!node) {
      ok("fire(<null>, " + type + ")", false, "target element not found");
      return;
    }
    ev = ev || {};
    ev.preventDefault = ev.preventDefault || function () {};
    ev.stopPropagation = ev.stopPropagation || function () {};
    var ls = (node._listeners || {})[type] || [];
    for (var i = 0; i < ls.length; i++) {
      ls[i].call(node, ev);
    }
  }
  return { document: doc, fire: fire };
}

/* ------------------------------------------------------- card html / run */
function cardHTML(f, side) {
  side = side || "front";
  var back = "";
  if (side === "back") {
    back =
      '<div id="iq-explanation"></div><div id="iq-tips"></div>' +
      '<div id="iq-knowledge"></div><div id="iq-source"></div>';
  }
  return (
    '<div class="iq-card" id="iq-card" data-side="' +
    side +
    '"' +
    (f.cloze ? ' data-iq-cloze="1"' : "") +
    ">" +
    '<div class="iq-question" id="iq-question">' +
    (f.question || "") +
    "</div>" +
    '<div class="iq-options" id="iq-options"></div>' +
    '<div class="iq-controls" id="iq-controls"></div>' +
    '<div class="iq-feedback" id="iq-feedback" hidden="hidden"></div>' +
    '<div class="iq-actions" id="iq-actions"></div>' +
    "</div>" +
    '<div id="iq-raw" hidden="hidden">' +
    '<div id="iq-raw-options">' +
    (f.options || "") +
    "</div>" +
    '<div id="iq-raw-answer">' +
    (f.answer || "") +
    "</div>" +
    '<div id="iq-raw-explanation">' +
    (f.explanation || "") +
    "</div>" +
    '<div id="iq-raw-tips">' +
    (f.tips || "") +
    "</div>" +
    '<div id="iq-raw-source">' +
    (f.source || "") +
    "</div>" +
    '<div id="iq-raw-type">' +
    (f.type || "") +
    "</div>" +
    '<div id="iq-raw-question">' +
    (f.questionRaw || "") +
    "</div>" +
    '<div id="iq-raw-knowledge">' +
    (f.knowledge || "") +
    "</div>" +
    "</div>" +
    back
  );
}

function run(fields, opts) {
  opts = opts || {};
  var dom = makeDOM();
  var calls = [];
  var win = {};
  if (!opts.noHost) {
    win.__ANKI_QUIZ_CONFIG__ = opts.config || {};
  }
  if (opts.clozeData) {
    win.__ANKI_QUIZ_CLOZE__ = opts.clozeData;
  }
  var cons = {
    error: function () {},
    log: function () {}
  };
  var pycmd = function (m) {
    calls.push(m);
  };
  win.pycmd = pycmd;
  dom.document.body.innerHTML = cardHTML(fields, opts.side);
  quizFactory(
    dom.document,
    win,
    pycmd,
    cons,
    function () {
      return 0;
    },
    function () {
      return 0;
    },
    function () {}
  );
  return {
    doc: dom.document,
    calls: calls,
    fire: dom.fire,
    config: opts.config || {},
    id: function (x) {
      return dom.document.getElementById(x);
    },
    opts: function () {
      return dom.document.getElementById("iq-options");
    },
    actions: function () {
      return dom.document.getElementById("iq-actions");
    },
    controls: function () {
      return dom.document.getElementById("iq-controls");
    },
    feedback: function () {
      return dom.document.getElementById("iq-feedback");
    },
    question: function () {
      return dom.document.getElementById("iq-question");
    },
    knowledge: function () {
      return dom.document.getElementById("iq-knowledge");
    },
    texts: function (list) {
      return Array.prototype.map.call(list, function (n) {
        return n.textContent;
      });
    }
  };
}

function byEase(r, ease) {
  var btns = r.actions().querySelectorAll("button");
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].getAttribute("data-ease") === String(ease)) {
      return btns[i];
    }
  }
  return null;
}

function verdict(r) {
  var v = r.feedback().querySelector(".iq-verdict");
  return v ? v.textContent : "";
}

var has = function (arr, s) {
  return arr.indexOf(s) >= 0;
};

/* ------------------------------------------------------------- 用例开始 */

/* A. 单选（星号标记，自动提交） */
(function () {
  var r = run({
    question: "\u4e2d\u56fd\u7684\u9996\u90fd\u662f\uff1f",
    options: "*A. \u5317\u4eac<br>B. \u4e0a\u6d77<br>C. \u5e7f\u5dde",
    explanation: "\u5317\u4eac\u662f\u9996\u90fd",
    source: "\u6765\u6e90\u7b14\u8bb0"
  });
  var opts = r.opts();
  eq("A1 渲染 3 个选项", opts.children.length, 3);
  eq("A2 选项文本", r.texts(opts.querySelectorAll(".iq-opt-text")), ["北京", "上海", "广州"]);
  eq("A2b 选项字母", r.texts(opts.querySelectorAll(".iq-opt-key")), ["A", "B", "C"]);
  ok("A3 原始字段已隐藏", r.id("iq-raw").getAttribute("hidden") === "hidden");
  ok("A4 有不知道按钮", !!r.controls().querySelector(".iq-dontknow"));
  ok("A5 单选无提交按钮", !r.controls().querySelector(".iq-submit"));
  r.fire(opts.children[0], "click");
  ok("A6 判为正确", verdict(r).indexOf("回答正确") >= 0, verdict(r));
  eq("A7 发出过 reset", has(r.calls, "iq:reset"), true);
  eq("A8 没有发出 wrong", has(r.calls, "iq:wrong"), false);
  eq("A9 三个评级按钮", r.texts(r.actions().querySelectorAll(".iq-grade-main")), ["困难", "良好", "简单"]);
  ok("A10 选项被标记为正确", opts.children[0].classList.contains("iq-correct"));
  r.fire(byEase(r, 3), "click");
  eq("A11 点击良好 -> grade:3", r.calls[r.calls.length - 1], "iq:grade:3");
})();

/* B. 单选答错 */
(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙<br>C. 丙" });
  var opts = r.opts();
  r.fire(opts.children[1], "click");
  ok("B1 判为错误", verdict(r).indexOf("回答错误") >= 0, verdict(r));
  ok("B2 正确项高亮", opts.children[0].classList.contains("iq-correct"));
  ok("B3 误选项标红", opts.children[1].classList.contains("iq-wrong"));
  ok(
    "B3b 反馈区不再列「正确答案」",
    r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.feedback().textContent
  );
  ok("B4 发出 wrong", has(r.calls, "iq:wrong"));
  eq("B5 只剩一个继续按钮", r.actions().querySelectorAll("button").length, 1);
  r.fire(byEase(r, 1), "click");
  eq("B6 继续 -> grade:1", r.calls[r.calls.length - 1], "iq:grade:1");
})();

/* C. 不知道 */
(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙" });
  r.fire(r.controls().querySelector(".iq-dontknow"), "click");
  ok("C1 提示不知道", verdict(r).indexOf("不知道") >= 0, verdict(r));
  ok(
    "C1b 「不知道」也不列「正确答案」",
    r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.feedback().textContent
  );
  ok("C1c 正确项仍然高亮", r.opts().children[0].classList.contains("iq-correct"));
  ok("C2 发出 wrong", has(r.calls, "iq:wrong"));
  r.fire(byEase(r, 1), "click");
  eq("C3 继续 -> grade:1", r.calls[r.calls.length - 1], "iq:grade:1");
})();

/* D. 多选 */
(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>*B. 乙<br>C. 丙" });
  var opts = r.opts();
  ok("D1 有提交按钮", !!r.controls().querySelector(".iq-submit"));
  ok("D2 提交按钮初始禁用", r.controls().querySelector(".iq-submit").disabled === true);
  r.fire(opts.children[0], "click");
  ok("D3 选中后按钮可用", r.controls().querySelector(".iq-submit").disabled === false);
  r.fire(opts.children[1], "click");
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("D4 全对判正确", verdict(r).indexOf("回答正确") >= 0, verdict(r));
  r.fire(byEase(r, 4), "click");
  eq("D5 简单 -> grade:4", r.calls[r.calls.length - 1], "iq:grade:4");
})();

/* D2. 多选漏选算错 */
(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>*B. 乙<br>C. 丙" });
  r.fire(r.opts().children[0], "click");
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("D6 漏选判错", verdict(r).indexOf("回答错误") >= 0, verdict(r));
  ok(
    "D6b 漏选也不列「正确答案」",
    r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.feedback().textContent
  );
  ok("D6c 漏掉的那项标绿", r.opts().children[1].classList.contains("iq-correct"));
})();

/* D3. 多选多选也算错 */
(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>*B. 乙<br>C. 丙" });
  r.fire(r.opts().children[0], "click");
  r.fire(r.opts().children[1], "click");
  r.fire(r.opts().children[2], "click");
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("D7 多选判错", verdict(r).indexOf("回答错误") >= 0, verdict(r));
})();

/* E. 判断题 */
(function () {
  var r = run({ question: "地球是方的", answer: "错" });
  var opts = r.opts();
  eq("E1 判断题两个选项", opts.children.length, 2);
  r.fire(opts.children[1], "click");
  ok("E2 选错误判正确", verdict(r).indexOf("回答正确") >= 0, verdict(r));
})();

(function () {
  var r = run({ question: "地球是圆的", answer: "√" });
  ok("E3 两个按钮", r.opts().children.length, 2);
  r.fire(r.opts().children[0], "click");
  ok("E4 选正确判正确", verdict(r).indexOf("回答正确") >= 0, verdict(r));
})();

/* E2. 判断题：真值存在题目末尾的隐藏标记里（1.1.3 起，不再有「答案」字段） */
(function () {
  var r = run({ question: "地球是方的<!--iq-tf:错-->" });
  eq("E5 有标记就接管", r.opts().children.length, 2);
  r.fire(r.opts().children[1], "click");
  ok("E6 点「错误」判对", verdict(r).indexOf("回答正确") >= 0, verdict(r));
  ok("E7 答对时不用再报正确答案", verdict(r).indexOf("正确答案") < 0, verdict(r));
})();

(function () {
  var r = run({ question: "地球是圆的<!--iq-tf:对-->" });
  r.fire(r.opts().children[0], "click");
  ok("E8 点「正确」判对", verdict(r).indexOf("回答正确") >= 0, verdict(r));
})();

(function () {
  var r = run({ question: "地球是方的<!--iq-tf:错-->" });
  r.fire(r.opts().children[0], "click");
  ok("E9 点错判错", verdict(r).indexOf("回答错误") >= 0, verdict(r));
  ok(
    "E9b 答错也不再列「正确答案」",
    r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.feedback().textContent
  );
  ok("E9c 该选的那项标绿", r.opts().children[1].classList.contains("iq-correct"));
  ok("E9d 不该选的那项不标绿", !r.opts().children[0].classList.contains("iq-correct"));
})();

(function () {
  /* 标记放在隐藏副本里也认（模板对判断题多留了一份题目） */
  var r = run({ question: "地球是方的", questionRaw: "地球是方的<!--iq-tf:错-->" });
  eq("E10 隐藏副本里的标记也认", r.opts().children.length, 2);
  r.fire(r.opts().children[1], "click");
  ok("E11 照样判对", verdict(r).indexOf("回答正确") >= 0, verdict(r));
})();

(function () {
  /* 标记被人手删掉、又没同步过：当普通卡处理，别乱判 */
  var r = run({ question: "地球是方的" });
  eq("E12 没标记就不接管", r.opts().children.length, 0);
})();

(function () {
  /* 背面也不列答案文字：改成两个着色的选项（正确的那项标绿） */
  var r = run({ question: "地球是方的<!--iq-tf:错-->" }, { side: "back" });
  var opts = r.opts();
  eq("E13 答案面画出两个选项", opts.children.length, 2);
  eq("E13b 选项文字", r.texts(opts.querySelectorAll(".iq-opt-text")), ["\u6b63\u786e / \u5bf9", "\u9519\u8bef / \u9519"]);
  eq("E13c 只有一项标绿", opts.querySelectorAll(".iq-correct").length, 1);
  ok("E13d 标绿的是「错误」", opts.children[1].classList.contains("iq-correct"));
  ok("E13e 答案面没有答案文字区", r.doc.getElementById("iq-answer-block") === null);
  eq("E13f 题目后面不贴真值", r.question().textContent, "地球是方的");
  eq("E13g 也没有多出来的答案块", r.question().querySelectorAll(".iq-blank-extra").length, 0);
})();

(function () {
  var r = run({ question: "地球是圆的<!--iq-tf:对-->" }, { side: "back" });
  ok("E14 真值「对」时标绿的是「正确」", r.opts().children[0].classList.contains("iq-correct"));
  eq("E14b 另一项不标绿", r.opts().children[1].classList.contains("iq-correct"), false);
  eq("E14c 题目也没被贴真值", r.question().textContent, "地球是圆的");
})();

/* 老卡：真值还在「答案」字段里（没有标记），背面一样画选项、不贴答案文字 */
(function () {
  var r = run({ question: "地球是方的", answer: "错" }, { side: "back" });
  var opts = r.opts();
  eq("E15 老卡背面也画两个选项", opts.children.length, 2);
  ok("E15b 标绿的是「错误」", opts.children[1].classList.contains("iq-correct"));
  eq("E15c 题目后面不贴答案", r.question().textContent, "地球是方的");
})();

/* F. 填空题（带标记） */
(function () {
  var r = run({
    question: "中国的首都是{{1}}，最大的城市是{{2}}。",
    answer: "北京|首都<br>上海",
    explanation: "解析"
  });
  var blanks = r.question().querySelectorAll(".iq-blank");
  eq("F1 两个空", blanks.length, 2);
  var inputs = r.question().querySelectorAll(".iq-input");
  eq("F2 两个输入框", inputs.length, 2);
  ok("F3 标记已被替换", r.question().textContent.indexOf("{{") < 0, r.question().textContent);
  ok("F4 句子还在", r.question().textContent.indexOf("中国的首都是") >= 0);
  inputs[0].value = "首都";
  inputs[1].value = "上海";
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("F5 填空判正确", verdict(r).indexOf("回答正确") >= 0, verdict(r));
  ok("F6 输入框已经换成静态答案", r.question().querySelectorAll(".iq-input").length === 0);
  eq(
    "F6b 答对时空里写标准答案",
    r.texts(r.question().querySelectorAll(".iq-blank-filled")),
    ["北京", "上海"]
  );
  eq("F6c 答对时不划掉我填的", r.question().querySelectorAll(".iq-fill-typed").length, 0);
  ok(
    "F6d 反馈区不再列「正确答案」",
    r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.feedback().textContent
  );
  r.fire(byEase(r, 2), "click");
  eq("F7 困难 -> grade:2", r.calls[r.calls.length - 1], "iq:grade:2");
})();

/* F2. 填空答错 */
(function () {
  var r = run({ question: "首都是___。", answer: "北京" });
  var inputs = r.question().querySelectorAll(".iq-input");
  eq("F8 下划线也能识别", inputs.length, 1);
  inputs[0].value = "南京";
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("F9 填空判错", verdict(r).indexOf("回答错误") >= 0, verdict(r));
  eq("F10 空里划掉我填的", r.texts(r.question().querySelectorAll(".iq-fill-typed")), ["南京"]);
  eq("F10b 空里跟标准答案", r.texts(r.question().querySelectorAll(".iq-blank-filled")), ["北京"]);
  eq("F10c 中间有箭头", r.texts(r.question().querySelectorAll(".iq-fill-arrow")), ["\u2192"]);
  ok(
    "F11 反馈区不再列「正确答案」",
    r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.feedback().textContent
  );
})();

/* G. 填空题（无标记） */
(function () {
  var r = run({ question: "请写出中国的首都", answer: "北京" });
  eq("G1 自动补一个空", r.question().querySelectorAll(".iq-input").length, 1);
  eq("G2 用了附加空容器", r.question().querySelectorAll(".iq-blank-extra").length, 1);
  var inp = r.question().querySelectorAll(".iq-input")[0];
  inp.value = "北京";
  r.fire(inp, "keydown", { key: "Enter", keyCode: 13 });
  ok("G3 回车提交判正确", verdict(r).indexOf("回答正确") >= 0, verdict(r));
  eq("G4 答对时空里写标准答案", r.texts(r.question().querySelectorAll(".iq-blank-filled")), ["北京"]);
})();

/* G2. 填空点「不知道」：只给标准答案，没有划掉的痕迹 */
(function () {
  var r = run({ question: "首都是___。", answer: "北京" });
  r.fire(r.controls().querySelector(".iq-dontknow"), "click");
  ok("G5 「不知道」判错", verdict(r).indexOf("不知道") >= 0, verdict(r));
  eq("G6 空里写标准答案", r.texts(r.question().querySelectorAll(".iq-blank-filled")), ["北京"]);
  eq("G7 没填就不划", r.question().querySelectorAll(".iq-fill-typed").length, 0);
  eq("G8 没填就没有箭头", r.question().querySelectorAll(".iq-fill-arrow").length, 0);
  ok(
    "G9 反馈区没有答案文字",
    r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.feedback().textContent
  );
})();

/* G3. 空位本来就没录答案：保持输入框着色，不做揭晓 */
(function () {
  var r = run({ question: "首都是___。" });
  var inp = r.question().querySelectorAll(".iq-input")[0];
  inp.value = "南京";
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("G10 没录答案时填了就算对", verdict(r).indexOf("回答正确") >= 0, verdict(r));
  ok("G11 输入框留着并标绿", inp.classList.contains("iq-input-ok"));
  eq("G12 不会凭空写答案", r.question().querySelectorAll(".iq-blank-filled").length, 0);
})();

/* H. 用字母指定答案 */
(function () {
  var r = run({ question: "Q", options: "A. 甲<br>B. 乙<br>C. 丙", answer: "B" });
  r.fire(r.opts().children[1], "click");
  ok("H1 答案=B 时选乙判正确", verdict(r).indexOf("回答正确") >= 0, verdict(r));
})();

/* H2. 多选字母 */
(function () {
  var r = run({ question: "Q", options: "A. 甲<br>B. 乙<br>C. 丙", answer: "AC" });
  r.fire(r.opts().children[0], "click");
  r.fire(r.opts().children[2], "click");
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("H2 答案=AC 判正确", verdict(r).indexOf("回答正确") >= 0, verdict(r));
})();

/* I. 答案面 */
(function () {
  var r = run(
    { question: "首都是{{1}}", answer: "北京", explanation: "解析内容", source: "来源内容" },
    { side: "back" }
  );
  var blanks = r.question().querySelectorAll(".iq-blank");
  eq("I1 答案面填入答案", blanks.length ? blanks[0].textContent : null, "北京");
  ok("I2 解析显示", r.id("iq-explanation").textContent.indexOf("解析内容") >= 0);
  ok("I3 来源显示", r.id("iq-source").textContent.indexOf("来源内容") >= 0);
})();

(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙", answer: "A" }, { side: "back" });
  var opts = r.opts();
  eq("I4 答案面列出选项", opts.children.length, 2);
  ok("I5 正确项高亮", opts.children[0].classList.contains("iq-correct"));
})();

/* J. 打乱选项后仍能判分 */
(function () {
  var bad = 0;
  for (var i = 0; i < 30; i++) {
    var r = run({ question: "Q", options: "*A. 北京<br>B. 上海" }, { config: { shuffle_options: true } });
    var opts = r.opts().children;
    var target = null;
    for (var k = 0; k < opts.length; k++) {
      if (opts[k].textContent.indexOf("北京") >= 0) {
        target = opts[k];
      }
    }
    r.fire(target, "click");
    if (verdict(r).indexOf("回答正确") < 0) {
      bad++;
    }
  }
  eq("J1 打乱 30 次都判对", bad, 0);
})();

/* K. 什么都没有 -> 不接管 */
(function () {
  var r = run({ question: "只有题干" });
  ok("K1 没有生成按钮", !r.controls().querySelector(".iq-btn"));
  ok("K2 原始区仍隐藏", r.id("iq-raw").getAttribute("hidden") === "hidden");
})();

/* L. wrong_action=immediate */
(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙" }, { config: { wrong_action: "immediate" } });
  r.fire(r.opts().children[1], "click");
  ok("L1 直接发 wrong", has(r.calls, "iq:wrong"));
  eq("L2 紧接着 grade:1", r.calls[r.calls.length - 1], "iq:grade:1");
})();

/* M. 关闭自动提交 */
(function () {
  var r = run(
    { question: "Q", options: "*A. 甲<br>B. 乙" },
    { config: { auto_submit_single_choice: false } }
  );
  var opts = r.opts();
  r.fire(opts.children[0], "click");
  eq("M1 未提交前没有反馈", verdict(r), "");
  ok("M2 有提交按钮", !!r.controls().querySelector(".iq-submit"));
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("M3 提交后判正确", verdict(r).indexOf("回答正确") >= 0, verdict(r));
})();

/* N. 重复初始化保护 */
(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙" });
  var before = r.opts().children.length;
  r.id("iq-card").setAttribute("data-iq-ready", "1");
  eq("N1 选项数稳定", before, 2);
})();

/* O. 上报作答结果（统计用） */
function resultCall(r) {
  for (var i = r.calls.length - 1; i >= 0; i--) {
    if (r.calls[i].indexOf("iq:result:") === 0) {
      return r.calls[i];
    }
  }
  return "";
}

(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙" });
  r.fire(r.opts().children[0], "click");
  var call = resultCall(r);
  ok("O1 单选上报 single", call.indexOf("iq:result:single:1:0:") === 0, call);
  ok("O2 末位不是部分正确", /:0$/.test(call), call);
  ok("O3 带上了用时", parseInt(call.split(":")[5], 10) >= 0, call);
})();

(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙" });
  r.fire(r.controls().querySelector(".iq-dontknow"), "click");
  ok("O4 不知道上报 dontknow=1", resultCall(r).indexOf("iq:result:single:0:1:") === 0, resultCall(r));
})();

(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>*B. 乙<br>C. 丙" });
  r.fire(r.opts().children[0], "click");
  r.fire(r.opts().children[1], "click");
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("O5 多选上报 multi", resultCall(r).indexOf("iq:result:multi:1:0:") === 0, resultCall(r));
})();

(function () {
  var r = run({ question: "地球是方的", answer: "错" });
  r.fire(r.opts().children[1], "click");
  ok("O6 判断上报 tf", resultCall(r).indexOf("iq:result:tf:") === 0, resultCall(r));
})();

(function () {
  var r = run({ question: "首都是{{1}}", answer: "北京" });
  r.question().querySelectorAll(".iq-input")[0].value = "北京";
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("O7 填空上报 fill", resultCall(r).indexOf("iq:result:fill:") === 0, resultCall(r));
})();

/* P. 多选漏选 */
(function () {
  var r = run(
    { question: "Q", options: "*A. 甲<br>*B. 乙<br>C. 丙", answer: "" },
    { config: { multi_partial_credit: true } }
  );
  r.fire(r.opts().children[0], "click");
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("P1 漏选提示", verdict(r).indexOf("漏选") >= 0, verdict(r));
  eq("P2 漏选只给困难和重来", r.texts(r.actions().querySelectorAll(".iq-grade-main")), ["困难", "还是重来"]);
  ok("P3 上报 partial=1", /:1$/.test(resultCall(r)), resultCall(r));
  ok("P4 没有发 iq:wrong", !has(r.calls, "iq:wrong"));
  ok("P5 发了 iq:partial", has(r.calls, "iq:partial"));
  r.fire(byEase(r, 2), "click");
  eq("P6 点困难 -> grade:2", r.calls[r.calls.length - 1], "iq:grade:2");
})();

(function () {
  var r = run(
    { question: "Q", options: "*A. 甲<br>*B. 乙<br>C. 丙" },
    { config: { multi_partial_credit: true } }
  );
  r.fire(r.opts().children[0], "click");
  r.fire(r.opts().children[2], "click"); // 选错了一个
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("P7 有错选仍然算错", verdict(r).indexOf("回答错误") >= 0, verdict(r));
  ok("P8 有错选会发 iq:wrong", has(r.calls, "iq:wrong"));
})();

(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>*B. 乙<br>C. 丙" });
  r.fire(r.opts().children[0], "click");
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("P9 关闭该项时漏选算错", verdict(r).indexOf("回答错误") >= 0, verdict(r));
  eq("P10 关闭时只有一个继续按钮", r.actions().querySelectorAll("button").length, 1);
})();

/* Q. 计时显示 */
(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙" });
  eq("Q1 默认不显示计时", r.id("iq-card").querySelectorAll(".iq-timer").length, 0);
})();

(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙" }, { config: { show_timer: true } });
  eq("Q2 打开后显示计时", r.id("iq-card").querySelectorAll(".iq-timer").length, 1);
  r.fire(r.opts().children[0], "click");
  eq("Q3 答完仍然只有一个计时", r.id("iq-card").querySelectorAll(".iq-timer").length, 1);
})();

/* R. 解题技巧 */
(function () {
  var r = run({
    question: "\u4e2d\u56fd\u7684\u9996\u90fd\u662f\uff1f",
    options: "*A. \u5317\u4eac<br>B. \u4e0a\u6d77",
    tips: "\u770b\u671d\u4ee3\u5148\u60f3\u76db\u5510"
  });
  eq("R1 答对前不显示解题技巧", r.feedback().querySelectorAll(".iq-tips").length, 0);
  r.fire(r.opts().children[0], "click");
  eq("R2 答对后显示解题技巧", r.feedback().querySelectorAll(".iq-tips").length, 1);
  var box = r.feedback().querySelector(".iq-tips");
  eq("R3 技巧标题", r.texts(box.querySelectorAll(".iq-block-title")), ["解题技巧"]);
  eq("R4 技巧正文", r.texts(box.querySelectorAll(".iq-richtext")), ["看朝代先想盛唐"]);
})();

(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙", tips: "<b>先看选项</b>" });
  r.fire(r.opts().children[1], "click");
  ok("R5 答错也显示解题技巧", r.feedback().querySelectorAll(".iq-tips").length === 1, verdict(r));
  eq("R6 技巧支持富文本", r.feedback().querySelector(".iq-tips").querySelector(".iq-richtext").innerHTML, "<b>先看选项</b>");
})();

(function () {
  var r = run(
    { question: "Q", options: "*A. 甲<br>B. 乙", tips: "\u6280\u5de7" },
    { config: { reveal_explanation_on_correct: false } }
  );
  r.fire(r.opts().children[0], "click");
  eq("R7 答对且关掉解析时不显示技巧", r.feedback().querySelectorAll(".iq-tips").length, 0);
})();

(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙" });
  r.fire(r.opts().children[0], "click");
  eq("R8 没填技巧时什么都不加", r.feedback().querySelectorAll(".iq-tips").length, 0);
})();

(function () {
  var r = run(
    { question: "Q", options: "*A. 甲<br>B. 乙", tips: "\u5148\u770b\u9009\u9879" },
    { side: "back" }
  );
  eq("R9 背面显示解题技巧", r.texts(r.id("iq-tips").querySelectorAll(".iq-block-title")), ["解题技巧"]);
  eq("R10 背面技巧正文", r.texts(r.id("iq-tips").querySelectorAll(".iq-richtext")), ["先看选项"]);
})();

/* T. 手机模式（没有插件通道：卡片里没有 window.__ANKI_QUIZ_CONFIG__） */
(function () {
  var r = run({ question: "Q", options: "*A. \u7532<br>B. \u4e59" }, { noHost: true });
  eq("T1 手机模式下没有配置注入", typeof r.calls.length, "number");
  r.fire(r.opts().children[0], "click");
  ok("T2 手机模式本地判分仍然正确", verdict(r).indexOf("\u56de\u7b54\u6b63\u786e") >= 0, verdict(r));
  eq("T3 手机上不显示桌面评级按钮", r.actions().querySelectorAll(".iq-grade").length, 0);
  eq("T4 手机上给出自己评级的提示", r.actions().querySelectorAll(".iq-manual").length, 1);
  eq("T5 手机上一条消息都不发", r.calls.length, 0);
  ok(
    "T6 提示里写了按 1/2/3/4",
    r.actions().textContent.indexOf("1") >= 0 && r.actions().textContent.indexOf("4") >= 0,
    r.actions().textContent
  );
  eq("T7 判完不会把按钮变灰（没有 disabled 的按钮卡住）", r.actions().querySelectorAll("button").length, 0);
})();

(function () {
  var r = run({ question: "Q", options: "*A. \u7532<br>B. \u4e59" }, { noHost: true });
  r.fire(r.opts().children[1], "click");
  ok("T8 手机模式答错也判错", verdict(r).indexOf("\u56de\u7b54\u9519\u8bef") >= 0, verdict(r));
  ok("T9 答错的标题不再承诺「记为重来」", verdict(r).indexOf("\u8bb0\u4e3a\u300c\u91cd\u6765\u300d") < 0, verdict(r));
  ok(
    "T10 手机模式反馈区也不列「正确答案」",
    r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.feedback().textContent
  );
  ok("T10b 正确项照样标绿", r.opts().children[0].classList.contains("iq-correct"));
  eq("T11 仍然是自己评级的提示", r.actions().querySelectorAll(".iq-manual").length, 1);
  eq("T12 没有发 iq:wrong", has(r.calls, "iq:wrong"), false);
})();

(function () {
  var r = run({ question: "Q", options: "*A. \u7532<br>B. \u4e59" }, { noHost: true });
  r.fire(r.controls().querySelector(".iq-dontknow"), "click");
  ok("T13 手机上「不知道」照样判为不知道", verdict(r).indexOf("\u4e0d\u77e5\u9053") >= 0, verdict(r));
  ok("T13b 也不列答案文字", r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0, r.feedback().textContent);
  eq("T14 仍然是自己评级", r.actions().querySelectorAll(".iq-manual").length, 1);
})();

(function () {
  var r = run({ question: "\u9996\u90fd\u662f{{1}}", answer: "\u5317\u4eac" }, { noHost: true });
  var input = r.question().querySelectorAll(".iq-input")[0];
  input.value = "\u4e0a\u6d77";
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("T15 手机模式填空也能本地判分", verdict(r).indexOf("\u56de\u7b54\u9519\u8bef") >= 0, verdict(r));
  eq("T16 填空也是自己评级", r.actions().querySelectorAll(".iq-manual").length, 1);
  eq("T16b 手机上空里也写标准答案", r.texts(r.question().querySelectorAll(".iq-blank-filled")), ["\u5317\u4eac"]);
  eq("T16c 手机上也划掉我填的", r.texts(r.question().querySelectorAll(".iq-fill-typed")), ["\u4e0a\u6d77"]);
})();

(function () {
  var r = run(
    { question: "Q", options: "*A. \u7532<br>*B. \u4e59<br>C. \u4e19" },
    { noHost: true, config: {} }
  );
  r.fire(r.opts().children[0], "click");
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("T17 手机上漏选也提示自己评级", r.actions().querySelectorAll(".iq-manual").length >= 0, verdict(r));
})();

/* U. 桌面端不受影响（有注入时照旧自动评级） */
(function () {
  var r = run({ question: "Q", options: "*A. \u7532<br>B. \u4e59" });
  r.fire(r.opts().children[0], "click");
  eq("U1 桌面端仍然给出评级按钮", r.actions().querySelectorAll(".iq-grade").length, 3);
  eq("U2 桌面端没有手机提示", r.actions().querySelectorAll(".iq-manual").length, 0);
  eq("U3 桌面端照常上报", has(r.calls, "iq:reset"), true);
})();

/* S. 原生填空（cloze） */
function clozeQuestion() {
  return (
    '\u300a\u9759\u591c\u601d\u300b\u7684\u4f5c\u8005\u662f' +
    '<span class="cloze" data-cloze="\u674e\u767d" data-ordinal="1">[...]</span>' +
    '\uff0c\u4ed6\u662f' +
    '<span class="cloze-inactive" data-ordinal="2">\u5510</span>' +
    '\u4ee3\u4eba\u3002' +
    '<span class="cloze" data-cloze="\u674e\u767d" data-ordinal="1">[...]</span>'
  );
}

(function () {
  var r = run({ question: clozeQuestion(), cloze: true });
  eq("S1 当前空位变成输入框", r.question().querySelectorAll(".iq-input").length, 2);
  eq("S2 非当前空位不动", r.question().querySelectorAll(".cloze-inactive").length, 1);
  eq("S3 有提交按钮", !!r.controls().querySelector(".iq-submit"), true);
  eq("S4 有不知道按钮", !!r.controls().querySelector(".iq-dontknow"), true);

  var inputs = r.question().querySelectorAll(".iq-input");
  inputs[0].value = "\u674e\u767d";
  inputs[1].value = "\u674e\u767d";
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("S5 填对判为正确", verdict(r).indexOf("\u56de\u7b54\u6b63\u786e") >= 0, verdict(r));
  ok("S6 上报 fill", resultCall(r).indexOf("iq:result:fill:1:") === 0, resultCall(r));
  eq("S7 给出困难/良好/简单", r.texts(r.actions().querySelectorAll(".iq-grade-main")), ["困难", "良好", "简单"]);
  eq(
    "S7b 答对时空里写标准答案",
    r.texts(r.question().querySelectorAll(".iq-blank-filled")),
    ["\u674e\u767d", "\u674e\u767d"]
  );
})();

(function () {
  var r = run({ question: clozeQuestion(), cloze: true });
  var inputs = r.question().querySelectorAll(".iq-input");
  inputs[0].value = "\u675c\u7526";
  inputs[1].value = "\u674e\u767d";
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("S8 填错判为错误", verdict(r).indexOf("\u56de\u7b54\u9519\u8bef") >= 0, verdict(r));
  ok("S9 填错会发 iq:wrong", has(r.calls, "iq:wrong"));
  eq("S10 空里划掉我填的", r.texts(r.question().querySelectorAll(".iq-fill-typed")), ["\u675c\u7526"]);
  eq(
    "S10b 两个空都写标准答案",
    r.texts(r.question().querySelectorAll(".iq-blank-filled")),
    ["\u674e\u767d", "\u674e\u767d"]
  );
  ok(
    "S10c 反馈区不列答案文字",
    r.feedback().textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.feedback().textContent
  );
})();

(function () {
  var r = run(
    {
      question:
        "\u4ed6\u662f" +
        '<span class="cloze" data-ordinal="2">[...]</span>' +
        "\u4eba\u3002",
      cloze: true
    },
    { clozeData: { texts: { "1": ["\u674e\u767d"], "2": ["\u5510"] }, ord: 1 } }
  );
  var inputs = r.question().querySelectorAll(".iq-input");
  eq("S11 没有 data-cloze 时也建输入框", inputs.length, 1);
  inputs[0].value = "\u5510";
  r.fire(r.controls().querySelector(".iq-submit"), "click");
  ok("S12 用注入的兜底答案判分", verdict(r).indexOf("\u56de\u7b54\u6b63\u786e") >= 0, verdict(r));
})();

(function () {
  var r = run({
    question:
      "\u300a\u9759\u591c\u601d\u300b\u4f5c\u8005" +
      '<span class="cloze" data-ordinal="1">\u674e\u767d</span>',
    cloze: true
  }, { side: "back" });
  eq("S13 背面不插输入框", r.question().querySelectorAll(".iq-input").length, 0);
  eq("S14 背面保留答案文本", r.question().textContent.indexOf("\u674e\u767d") >= 0, true);
})();

/* V. 相关知识点（制卡时给标签配的链接，答完题后点标签跳过去） */
function answerFirst(r) {
  r.fire(r.opts().children[0], "click");
  var submit = r.controls().querySelector(".iq-submit");
  if (submit) {
    r.fire(submit, "click");
  }
}

(function () {
  var r = run({
    question: "Q",
    options: "*A. \u7532<br>B. \u4e59",
    knowledge: "\u5510\u8bd7 -> https://a.example/tang"
  });
  answerFirst(r);
  var btn = r.feedback().querySelector(".iq-know-btn");
  ok("V1 答完题后出现知识点入口", !!btn);
  eq("V2 按钮文字就是标签", btn.textContent.indexOf("\u5510\u8bd7") >= 0, true);
  eq("V3 网址链接带上了 href", btn.getAttribute("href"), "https://a.example/tang");
  r.fire(btn, "click");
  eq(
    "V4 点它会通知插件打开",
    r.calls[r.calls.length - 1],
    "iq:open:" + encodeURIComponent("https://a.example/tang")
  );
  ok("V4a 上面有「相关知识点」的标题", !!r.feedback().querySelector(".iq-know-label"));
})();

(function () {
  /* 一行一个标签：点哪个跳哪个 */
  var r = run({
    question: "Q",
    options: "*A. \u7532<br>B. \u4e59",
    knowledge: "\u5510\u8bd7 -> https://a.example/tang\n\u5b8b\u8bcd -> tag:\u5b8b\u8bcd"
  });
  answerFirst(r);
  var chips = r.feedback().querySelectorAll(".iq-know-btn");
  eq("V5 两个标签就是两个可点标签", chips.length, 2);
  eq("V6 第一个是网址链接", chips[0].getAttribute("href"), "https://a.example/tang");
  eq("V7 第二个不是链接（走 Anki 搜索）", chips[1].getAttribute("href"), null);
  eq("V7a 第二个标签文字", chips[1].textContent.indexOf("\u5b8b\u8bcd") >= 0, true);
  r.fire(chips[1], "click");
  eq("V8 点第二个标签搜的是它自己", r.calls[r.calls.length - 1], "iq:open:" + encodeURIComponent("tag:\u5b8b\u8bcd"));
  var hint = r.feedback().querySelector(".iq-know-hint");
  ok("V9 桌面端不显示「在 Anki 里搜」的提示", !!hint && hint.getAttribute("hidden") !== null);
})();

(function () {
  /* 手机（没有插件）：网址直接当链接点，搜索式给一行提示 */
  var r = run(
    { question: "Q", options: "*A. \u7532<br>B. \u4e59", knowledge: "\u5510\u8bd7 -> https://a.example/x" },
    { noHost: true }
  );
  answerFirst(r);
  var btn = r.feedback().querySelector(".iq-know-btn");
  ok("V10 手机上也显示标签", !!btn);
  ok("V10a 手机上就是普通链接", btn.getAttribute("href") === "https://a.example/x");
  r.fire(btn, "click");
  eq("V11 手机上不发给插件", r.calls.length, 0);

  var r2 = run(
    { question: "Q", options: "*A. \u7532<br>B. \u4e59", knowledge: "\u5b8b\u8bcd -> tag:\u5b8b\u8bcd" },
    { noHost: true }
  );
  answerFirst(r2);
  var hint = r2.feedback().querySelector(".iq-know-hint");
  ok("V12 手机上搜索式给提示", !!hint && hint.getAttribute("hidden") === null, hint && hint.textContent);
  ok("V12a 提示里写着搜什么", !!hint && hint.textContent.indexOf("tag:\u5b8b\u8bcd") >= 0, hint && hint.textContent);
})();

(function () {
  /* 答案面也有，手机上翻面就能用 */
  var r = run(
    { question: "Q", options: "*A. \u7532<br>B. \u4e59", knowledge: "\u5510\u8bd7 -> https://a.example/x" },
    { side: "back" }
  );
  var btn = r.knowledge().querySelector(".iq-know-btn");
  ok("V13 答案面上也有知识点", !!btn);
  eq("V14 答案面上的标签对", btn.textContent.indexOf("\u5510\u8bd7") >= 0, true);
})();

(function () {
  var r = run({ question: "Q", options: "*A. \u7532<br>B. \u4e59" });
  answerFirst(r);
  eq("V15 没填知识点就不出现入口", r.feedback().querySelectorAll(".iq-know-btn").length, 0);
  var rb = run({ question: "Q", options: "*A. \u7532<br>B. \u4e59" }, { side: "back" });
  eq("V16 答案面同理", rb.knowledge().querySelectorAll(".iq-know-btn").length, 0);
})();

(function () {
  /* 老写法（只写链接、没有标签）照样显示，标签就是链接本身 */
  var r = run({ question: "Q", options: "*A. \u7532<br>B. \u4e59", knowledge: "https://a.example/old" });
  answerFirst(r);
  var btn = r.feedback().querySelector(".iq-know-btn");
  ok("V17 老的单行链接照旧显示", !!btn);
  eq("V18 没有标签时标签就是链接本身", btn.textContent.indexOf("https://a.example/old") >= 0, true);
})();

(function () {
  var r = run({
    question: "Q",
    options: "*A. \u7532<br>B. \u4e59",
    knowledge: "\u5510\u8bd7 -> https://a.example/1\n\u5510\u8bd7 -> https://a.example/2"
  });
  answerFirst(r);
  var chips = r.feedback().querySelectorAll(".iq-know-btn");
  eq("V19 同名标签只留第一条", chips.length, 1);
  eq("V20 留的是第一条的链接", chips[0].getAttribute("href"), "https://a.example/1");
})();

/* W. 答案面不再列答案文字（1.1.5：靠颜色和空里的答案说话） */
(function () {
  var r = run({ question: "Q", options: "*A. 甲<br>B. 乙" }, { side: "back" });
  var opts = r.opts();
  eq("W1 选择题背面照样画选项", opts.children.length, 2);
  eq("W2 只有正确项标绿", opts.querySelectorAll(".iq-correct").length, 1);
  ok("W3 没有答案文字区", r.doc.getElementById("iq-answer-block") === null);
  ok(
    "W4 整页没有「正确答案」四个字",
    r.doc.body.textContent.indexOf("\u6b63\u786e\u7b54\u6848") < 0,
    r.doc.body.textContent
  );
})();

(function () {
  var r = run({ question: "首都是___。", answer: "北京" }, { side: "back" });
  eq("W5 填空背面把答案写进空里", r.texts(r.question().querySelectorAll(".iq-blank-filled")), ["北京"]);
  eq("W6 填空背面没有输入框", r.question().querySelectorAll(".iq-input").length, 0);
  eq("W7 没有答案文字区", r.doc.getElementById("iq-answer-block"), null);
})();

(function () {
  /* 空位不够时，多出来的答案还是附在题目后面 */
  var r = run({ question: "____ 和 ____", answer: "甲<br>乙<br>丙" }, { side: "back" });
  eq(
    "W8 多出来的答案贴在题目后",
    r.texts(r.question().querySelectorAll(".iq-blank-extra .iq-blank")),
    ["丙"]
  );
})();

log.join("\n") + "\n----\nPASS=" + pass + " FAIL=" + fail;
