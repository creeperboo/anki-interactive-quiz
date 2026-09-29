/* 编辑器助手（assets/editor.js）的测试。
   REPL 里这样拼： "var editorFactory = function(document, window){" + editor.js + "};" + 本文件

   字段值的来去：插件注入时给 values（字段初值），脚本改动时通过 pycmd 发
   "iq:editor:set:<序号>:<encodeURIComponent(内容)>" 回去，由插件负责真正写进 Anki。
   DOM 里那个 textarea 只是备份路径（没有宿主时才用）。 */

/* 真实题型里「知识点」排在最后（新字段只能往后追加） */
var CHOICE_FIELDS = ["题目", "选项", "解析", "解题技巧", "来源", "知识点"];
var TF_FIELDS = ["题目", "解析", "解题技巧", "来源", "知识点"];
var CLOZE_FIELDS = ["题目", "解析", "解题技巧", "来源", "知识点"];

/* 假的 pycmd：把插件会收到的消息记下来 */
var iqSent = [];
var pycmd = function (message) {
  iqSent.push(String(message));
};

/* 真实结构（Anki 26 的编辑器就是这样）：
   .fields > .field-container[data-index] > span.label-name + .editor-field > … > textarea
   字段名在 span.label-name 里；换笔记类型时 Anki 按位置复用同一批 .field-container，
   只改 data-index 和这个 span 的文字。 */
function fieldBlockHTML(index, name) {
  return (
    '<div class="field-container" data-index="' + index + '">' +
    '<span class="label-name">' + name + "</span>" +
    '<div class="editor-field"><div class="collapsible"><div class="editing-area">' +
    "<textarea></textarea>" +
    "</div></div></div>" +
    "</div>"
  );
}

function fieldsHTML(names) {
  var html = '<div class="fields">';
  for (var i = 0; i < names.length; i++) {
    html += fieldBlockHTML(i, names[i]);
  }
  return html + "</div>";
}

function makeEditor(values, fields) {
  var dom = makeDOM();
  var win = {};
  fields = fields || CHOICE_FIELDS;
  values = values || [];
  dom.document.body.innerHTML = fieldsHTML(fields);
  editorFactory(dom.document, win);
  var areas = dom.document.querySelectorAll(".fields textarea");
  for (var j = 0; j < areas.length; j++) {
    areas[j].value = values[j];
  }
  var api = win.__IQ_EDITOR__;
  var editor = {
    dom: dom,
    win: win,
    api: api,
    fields: fields,
    areas: areas,
    fire: dom.fire,
    install: function (mode, typeName, extra) {
      iqSent.length = 0;
      var payload = {
        mode: mode,
        fields: fields,
        type: typeName || "",
        values: values
      };
      if (extra) {
        for (var key in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, key)) {
            payload[key] = extra[key];
          }
        }
      }
      win.__IQ_EDITOR_INSTALL__(payload);
      return this;
    },
    sent: function () {
      return iqSent.slice();
    },
    /* 插件收到的这个字段最后一次内容 */
    stored: function (name) {
      var index = fields.indexOf(name);
      for (var i = iqSent.length - 1; i >= 0; i--) {
        var m = iqSent[i].match(/^iq:editor:set:(\d+):([\s\S]*)$/);
        if (m && parseInt(m[1], 10) === index) {
          return decodeURIComponent(m[2]);
        }
      }
      return null;
    },
    host: function () {
      return dom.document.getElementById("iq-ed-host");
    },
    rows: function () {
      return dom.document.querySelectorAll(".iq-ed-row");
    },
    inputs: function () {
      return dom.document.querySelectorAll(".iq-ed-input");
    },
    boxes: function () {
      return dom.document.querySelectorAll(".iq-ed-box");
    },
    status: function () {
      var node = dom.document.querySelector(".iq-ed-status");
      return node ? node.textContent : "";
    },
    addButton: function () {
      return dom.document.querySelector(".iq-ed-add");
    },
    delButtons: function () {
      return dom.document.querySelectorAll(".iq-ed-del");
    },
    optionField: function () {
      return areas[fields.indexOf("\u9009\u9879")];
    },
    answerField: function () {
      return areas[fields.indexOf("\u7b54\u6848")];
    },
    questionField: function () {
      return areas[fields.indexOf("\u9898\u76ee")];
    },
    /* 某个字段那一整块（按名字找，跟真实编辑器一样认 span.label-name） */
    containerOf: function (name) {
      var blocks = dom.document.querySelectorAll(".fields .field-container");
      for (var i = 0; i < blocks.length; i++) {
        var label = blocks[i].querySelector(".label-name");
        if (label && label.textContent === name) {
          return blocks[i];
        }
      }
      return null;
    },
    /* 这块字段当前有没有被插件藏起来 */
    isHidden: function (name) {
      var node = editor.containerOf(name);
      if (!node) {
        return false;
      }
      return !!(
        node.classList.contains("iq-hidden") ||
        (node.style && node.style.display === "none") ||
        node.getAttribute("data-iq-hidden") === "1"
      );
    },
    /* 往某块字段的输入框里塞值（换过题型后 areas 就过期了，得重新查） */
    putField: function (name, text) {
      var node = editor.containerOf(name);
      var box = node ? node.querySelector("textarea") : null;
      if (box) {
        box.value = text;
      }
      return editor;
    },
    /* 换笔记类型：Anki 按位置复用同一批 .field-container，只改 data-index 和字段名 */
    switchNoteType: function (names) {
      var blocks = dom.document.querySelectorAll(".fields .field-container");
      var holder = blocks.length ? blocks[0].parentNode : null;
      var i;
      for (i = 0; i < names.length; i++) {
        if (i < blocks.length) {
          blocks[i].setAttribute("data-index", String(i));
          var label = blocks[i].querySelector(".label-name");
          if (label) {
            label.textContent = names[i];
          }
        } else if (holder) {
          var tmp = dom.document.createElement("div");
          tmp.innerHTML = fieldBlockHTML(i, names[i]);
          var kids = tmp.childNodes.slice();
          for (var k = 0; k < kids.length; k++) {
            holder.appendChild(kids[k]);
          }
        }
      }
      for (i = names.length; i < blocks.length; i++) {
        if (blocks[i].parentNode) {
          blocks[i].parentNode.removeChild(blocks[i]);
        }
      }
      fields = names;
      return editor;
    }
  };
  return editor;
}

var has = function (arr, s) {
  return arr.indexOf(s) >= 0;
};

function key(e, node, spec) {
  e.fire(node, "keydown", {
    key: spec.key,
    keyCode: spec.keyCode || 0,
    altKey: !!spec.altKey,
    shiftKey: !!spec.shiftKey,
    ctrlKey: !!spec.ctrlKey,
    metaKey: false,
    preventDefault: function () {},
    stopPropagation: function () {}
  });
}

/* ---------- 选择题：选项行 ---------- */
(function () {
  var e = makeEditor(["\u9759\u591c\u601d", "A. \u7532\nB. \u4e59\nC. \u4e19", "", "", "", ""]);
  e.install("choice");
  ok("F1 生成了选项控件", !!e.host());
  eq("F2 每个选项一行", e.rows().length, 3);
  eq("F3 每行有输入框", e.inputs().length, 3);
  eq("F4 每行有勾选框", e.boxes().length, 3);
  eq("F5 标签已去掉（只留内容）", e.inputs()[0].value, "\u7532");
  eq("F6 整个「选项」字段块被藏起来", e.containerOf("\u9009\u9879").style.display, "none");
  ok(
    "F6b 块里的输入框没被动过（不再往 textarea 上打隐藏）",
    !e.optionField().style || e.optionField().style.display !== "none"
  );
  ok("F7 没勾选时提示", e.status().indexOf("\u8fd8\u6ca1\u52fe\u9009") >= 0, e.status());
})();

(function () {
  var e = makeEditor(["Q", "A. \u7532\nB. \u4e59", "", "", "", ""]);
  e.install("choice");
  e.boxes()[0].checked = true;
  e.fire(e.boxes()[0], "change");
  eq("F8 勾选后写回字段", e.stored("\u9009\u9879"), "*\u7532\n\u4e59");
  ok("F9 勾一个 = 单选", e.status().indexOf("\u5355\u9009") >= 0, e.status());
  e.boxes()[1].checked = true;
  e.fire(e.boxes()[1], "change");
  eq("F10 勾两个写回两个星号", e.stored("\u9009\u9879"), "*\u7532\n*\u4e59");
  ok("F11 勾两个 = 多选", e.status().indexOf("\u591a\u9009") >= 0, e.status());
  e.boxes()[0].checked = false;
  e.fire(e.boxes()[0], "change");
  eq("F12 取消勾选会去掉星号", e.stored("\u9009\u9879"), "\u7532\n*\u4e59");
})();

(function () {
  var e = makeEditor(["Q", "\u7532\n\u4e59", "", "", "", ""]);
  e.install("choice");
  e.fire(e.inputs()[0], "input");
  eq("F13 改内容直接写回字段", e.stored("\u9009\u9879"), "\u7532\n\u4e59");
  e.inputs()[1].value = "\u4e59\u4e59";
  e.fire(e.inputs()[1], "input");
  eq("F14 改第二行", e.stored("\u9009\u9879"), "\u7532\n\u4e59\u4e59");
})();

(function () {
  var e = makeEditor(["Q", "\u7532", "", "", "", ""]);
  e.install("choice");
  eq("F15 只有一行", e.rows().length, 1);
  e.fire(e.addButton(), "click");
  eq("F16 点 ＋ 加一行", e.rows().length, 2);
  key(e, e.inputs()[0], { key: "Enter", keyCode: 13 });
  eq("F17 按 Enter 加一行", e.rows().length, 3);
  eq("F18 新行插在中间", e.inputs()[1].value, "");

  key(e, e.inputs()[1], { key: "Backspace", keyCode: 8 });
  eq("F19 空行按 Backspace 删掉", e.rows().length, 2);
  e.inputs()[0].value = "\u7532";
  key(e, e.inputs()[0], { key: "Backspace", keyCode: 8 });
  eq("F20 有内容的行不会被 Backspace 删掉", e.rows().length, 2);

  e.fire(e.delButtons()[1], "click");
  eq("F21 点 × 删行", e.rows().length, 1);
})();

(function () {
  var e = makeEditor(["Q", "\u7532\n\u4e59\n\u4e19", "", "", "", ""]);
  e.install("choice");
  key(e, e.inputs()[0], { key: "2", altKey: true });
  eq("F22 Alt+2 勾选第二行", e.boxes()[1].checked, true);
  eq("F23 写回字段", e.stored("\u9009\u9879"), "\u7532\n*\u4e59\n\u4e19");
  key(e, e.inputs()[0], { key: "2", altKey: true });
  eq("F24 再按一次取消", e.boxes()[1].checked, false);

  key(e, e.inputs()[0], { key: "ArrowDown", altKey: true, keyCode: 40 });
  eq("F25 Alt+↓ 把第一行下移", e.inputs()[0].value, "\u4e59");
  key(e, e.inputs()[1], { key: "ArrowUp", altKey: true, keyCode: 38 });
  eq("F26 Alt+↑ 再移回来", e.inputs()[0].value, "\u7532");
  eq("F27 移动后字段同步", e.stored("\u9009\u9879"), "\u7532\n\u4e59\n\u4e19");
})();

(function () {
  var e = makeEditor(["Q", "", "", "", "", ""]);
  e.install("choice");
  eq("F28 空选项字段也给一行空框", e.rows().length, 1);
  ok("F29 提示去加选项", e.status().indexOf("\u8fd8\u6ca1\u6709\u9009\u9879") >= 0, e.status());
})();

(function () {
  var e = makeEditor(["Q", "", "", "", "", ""]);
  e.install("choice");
  e.boxes()[0].checked = true;
  e.fire(e.boxes()[0], "change");
  eq("F29a 空行勾了也不写进字段", e.stored("\u9009\u9879"), "");
  e.inputs()[0].value = "\u7532";
  e.fire(e.inputs()[0], "input");
  eq("F29b 填了内容才写，且带着星号", e.stored("\u9009\u9879"), "*\u7532");
})();

/* ---------- 判断题：一个勾选框 ---------- */
(function () {
  var e = makeEditor(["\u592a\u9633\u4ece\u897f\u8fb9\u5347\u8d77\u3002", "", "", "", ""], TF_FIELDS);
  e.install("tf");
  ok("F30 生成了勾选框", !!e.host());
  var qStyle = e.containerOf("\u9898\u76ee").style;
  ok("F31 题目没有被藏起来（真值改存在题目标记里）", !qStyle || qStyle.display !== "none");
  ok("F31b 题型里已经没有「答案」字段", e.fields.indexOf("\u7b54\u6848") < 0);
  eq("F32 初始不勾选", e.boxes()[0].checked, false);
  ok("F33 提示没设置", e.host().textContent.indexOf("\u8fd8\u6ca1\u8bbe\u7f6e") >= 0, e.host().textContent);

  e.boxes()[0].checked = true;
  e.fire(e.boxes()[0], "change");
  eq(
    "F34 勾上 = 对（写成题目标记）",
    e.sent()[0],
    "iq:editor:tf:" + encodeURIComponent("\u5bf9")
  );
  ok("F35 显示当前是对的", e.host().textContent.indexOf("\u5f53\u524d\uff1a\u5bf9") >= 0, e.host().textContent);

  e.boxes()[0].checked = false;
  e.fire(e.boxes()[0], "change");
  eq(
    "F36 不勾 = 错",
    e.sent()[1],
    "iq:editor:tf:" + encodeURIComponent("\u9519")
  );
  ok("F37 显示当前是错的", e.host().textContent.indexOf("\u5f53\u524d\uff1a\u9519") >= 0, e.host().textContent);
})();

(function () {
  var e = makeEditor(["Q", "", "", "", ""], TF_FIELDS);
  e.install("tf");
  eq("F38 题目里没有标记时不勾选", e.boxes()[0].checked, false);
  var e2 = makeEditor(["Q<!--iq-tf:\u5bf9-->", "", "", "", ""], TF_FIELDS);
  e2.install("tf");
  eq("F39 题目标记是「对」时勾上", e2.boxes()[0].checked, true);
  ok("F39b 旁边写着当前是对", e2.host().textContent.indexOf("\u5f53\u524d\uff1a\u5bf9") >= 0, e2.host().textContent);
  var e3 = makeEditor(["\u9898\u5e72<!--iq-tf:\u9519-->", "", "", "", ""], TF_FIELDS);
  e3.install("tf");
  eq("F39c 标记是「错」时不勾", e3.boxes()[0].checked, false);
  ok("F39d 旁边写着当前是错", e3.host().textContent.indexOf("\u5f53\u524d\uff1a\u9519") >= 0, e3.host().textContent);
})();

/* ---------- 填空题：状态行 ---------- */
(function () {
  var e = makeEditor(["\u4f5c\u8005\u662f{{c1::\u674e\u767d}}\uff0c{{c2::\u5510}}\u4ee3\u3002", "", "", ""], CLOZE_FIELDS);
  e.install("cloze");
  ok("F40 数出 2 个空", e.host().textContent.indexOf("2 \u4e2a\u7a7a") >= 0, e.host().textContent);
})();

(function () {
  var e = makeEditor(["\u6ca1\u6709\u6316\u7a7a\u7684\u9898\u76ee", "", "", ""], CLOZE_FIELDS);
  e.install("cloze");
  ok("F41 没挖空时提示", e.host().textContent.indexOf("\u8fd8\u6ca1\u6709") >= 0, e.host().textContent);
})();

/* ---------- 别的题型不插手 ---------- */
(function () {
  var e = makeEditor(["A", "B"], ["正面", "背面"]);
  e.install("");
  eq("F42 别的题型什么都不做", e.host(), null);
  eq("F43 addOption 也不动", e.api.addOption(), false);
})();

/* ---------- 字段块整块藏起来 ---------- */
(function () {
  var e = makeEditor(["Q", "A. \u7532", "", "", "", ""]);
  e.install("choice");
  eq("F49 整个「选项」字段块都藏起来", e.containerOf("\u9009\u9879").style.display, "none");
})();

(function () {
  var e = makeEditor(["Q", "", "", "", "", ""]);
  e.install("choice");
  eq("F50 「选项」字段名也一起藏住了（整块）", e.containerOf("\u9009\u9879").style.display, "none");
})();

/* ---------- 读写接口 ---------- */
(function () {
  var e = makeEditor(["Q", "\u7532\n\u4e59", "", "", "", ""]);
  e.install("choice");
  var dumped = JSON.parse(e.api.dump());
  eq("F44 dump 出题目", dumped["\u9898\u76ee"], "Q");
  eq("F45 dump 出选项", dumped["\u9009\u9879"], "\u7532\n\u4e59");

  e.api.apply({ "\u9009\u9879": "*\u7532\n\u4e59", "\u9898\u76ee": "Q2" });
  eq("F46 apply 写回选项", e.stored("\u9009\u9879"), "*\u7532\n\u4e59");
  eq("F47 apply 后控件重建", e.boxes()[0].checked, true);
  eq("F48 apply 状态同步", e.status().indexOf("\u5355\u9009") >= 0, true);
})();

/* ---------- 字段值的来去（2026-09-23 修：DOM 里的 textarea 不是真源头） ---------- */
(function () {
  var e = makeEditor(["Q", "\u7532", "", "", "", ""]);
  e.install("choice");
  e.boxes()[0].checked = true;
  e.fire(e.boxes()[0], "change");
  var sent = e.sent();
  eq("G1 改动会发给插件", sent.length, 1);
  eq("G2 消息格式：字段序号 + 编码后的内容", sent[0], "iq:editor:set:1:" + encodeURIComponent("*\u7532"));
})();

(function () {
  /* 插件注入的字段值是 HTML，要能还原成按行文本 */
  var e = makeEditor(
    ["Q", "<div>\u7532</div><div>*\u4e59 &amp; \u4e19</div>", "", "", "", ""]
  );
  e.install("choice");
  eq("G3 HTML 里的选项行数", e.rows().length, 2);
  eq("G4 HTML 标签被去掉", e.inputs()[1].value, "\u4e59 & \u4e19");
  eq("G5 星号还能认出来", e.boxes()[1].checked, true);
  eq("G6 还原后是单选", e.status().indexOf("\u5355\u9009") >= 0, true);
})();

(function () {
  /* 没有宿主（老版本 Anki）时退回直接写 textarea */
  var saved = pycmd;
  pycmd = undefined;
  try {
    var e = makeEditor(["Q", "\u7532", "", "", "", ""]);
    e.install("choice");
    e.boxes()[0].checked = true;
    e.fire(e.boxes()[0], "change");
    eq("G7 没宿主时写 textarea", e.optionField().value, "*\u7532");
    eq("G8 没宿主时不发消息", e.sent().length, 0);
  } finally {
    pycmd = saved;
  }
})();

(function () {
  /* 判断题：勾选框写「对 / 错」 */
  var e = makeEditor(["Q", "", "", "", ""], TF_FIELDS);
  e.install("tf");
  e.boxes()[0].checked = true;
  e.fire(e.boxes()[0], "change");
  eq("G9 判断勾选发的是判断题消息", e.sent()[0].split(":")[2], "tf");
  eq("G10 消息里带「对」", decodeURIComponent(e.sent()[0].split(":")[3]), "\u5bf9");
})();

(function () {
  /* 插件推进来的新值要能刷新状态行（用户在「题目」里补了挖空） */
  var e = makeEditor(["", "", "", ""], CLOZE_FIELDS);
  e.install("cloze");
  ok("G11 一开始说没有空", e.host().textContent.indexOf("\u8fd8\u6ca1\u6709") >= 0, e.host().textContent);
  e.api.applyNativeValues([
    "<div>\u4f5c\u8005\u662f{{c1::\u674e\u767d}}\uff0c{{c2::\u5510}}\u4ee3\u3002</div>",
    "",
    "",
    ""
  ]);
  ok("G12 推来新值后数出 2 个空", e.host().textContent.indexOf("2 \u4e2a\u7a7a") >= 0, e.host().textContent);
  e.api.applyNativeValues(["\u5e72\u51c0\u7684\u9898\u76ee", "", "", ""]);
  ok("G12b 没挖空又变回提示", e.host().textContent.indexOf("\u8fd8\u6ca1\u6709") >= 0, e.host().textContent);
})();

(function () {
  /* 其它题型也能收到原生值，只是不画填空状态行 */
  var e = makeEditor(["Q", "*\u7532", "", "", "", ""]);
  e.install("choice");
  ok("G12c 选择题也接受原生值", e.api.applyNativeValues(["\u5e8a\u524d", "\u7532", "", "", "", ""]) === true);
  ok("G12d 选择题状态行不受影响", e.status().indexOf("\u5355\u9009") >= 0, e.status());
})();

/* ---------- 解题技巧：一键用同标签卡片的技巧（新增） ---------- */
(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", "", ""]);
  e.install("choice");
  var bar = e.dom.document.getElementById("iq-ed-tipsbar");
  ok("H1 解题技巧下面有按钮", !!bar);
  var btn = bar ? bar.querySelector(".iq-ed-mini") : null;
  ok("H2 按钮文案能看出来是干什么的", btn && btn.textContent.indexOf("\u540c\u6807\u7b7e") >= 0, btn && btn.textContent);
  e.fire(btn, "click");
  ok("H3 点它会向插件要同标签技巧", e.sent().length === 1 && e.sent()[0].indexOf("iq:editor:tips:") === 0, e.sent()[0]);
})();

(function () {
  /* 标签框里的标签还在页面里，得一起带过去 */
  var e = makeEditor(["Q", "*\u7532", "", "", "", "", ""]);
  var tagEditor = e.dom.document.createElement("div");
  tagEditor.setAttribute("class", "tag-editor");
  var chip = e.dom.document.createElement("span");
  chip.setAttribute("class", "tag");
  chip.textContent = "\u5510\u8bd7";
  tagEditor.appendChild(chip);
  e.dom.document.body.appendChild(tagEditor);
  e.install("choice");
  e.fire(e.dom.document.getElementById("iq-ed-tipsbar").querySelector(".iq-ed-mini"), "click");
  var msg = e.sent()[0] || "";
  ok("H3a 消息里带着标签框里的标签", msg.indexOf(encodeURIComponent('["\u5510\u8bd7"]')) >= 0, msg);
})();

(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", "", ""]);
  e.install("choice");
  ok(
    "H4 只有一条也弹候选面板",
    e.api.showTips({ tags: ["\u5510\u8bd7"], items: [{ nid: 1, title: "\u9898\u4e00", tip: "\u5148\u60f3\u671d\u4ee3", tags: ["\u5510\u8bd7"] }] }) === true
  );
  var panel = e.dom.document.getElementById("iq-ed-tipspanel");
  ok("H5 一条时候选面板也在", !!panel && panel.querySelectorAll(".iq-ed-panel-row").length === 1);
  eq("H6 还没点「用这条」就没写字段", e.stored("\u89e3\u9898\u6280\u5de7"), null);
  e.fire(panel.querySelector(".iq-ed-mini"), "click");
  eq("H6a 点了才写进技巧字段", e.stored("\u89e3\u9898\u6280\u5de7"), "\u5148\u60f3\u671d\u4ee3");
  ok(
    "H6b 填完的提示里不再带题目",
    e.dom.document.getElementById("iq-ed-tipsbar").textContent.indexOf("\u9898\u4e00") < 0,
    e.dom.document.getElementById("iq-ed-tipsbar").textContent
  );
})();

(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", "", ""]);
  e.install("choice");
  e.api.showTips({
    tags: ["\u5510\u8bd7"],
    total: 2,
    items: [
      { nid: 2, tip: "\u6280\u5de7\u4e8c", tags: ["\u5510\u8bd7", "\u5b8b\u8bcd"] },
      { nid: 1, tip: "\u6280\u5de7\u4e00", tags: ["\u5510\u8bd7"] }
    ]
  });
  var panel = e.dom.document.getElementById("iq-ed-tipspanel");
  ok("H7 多条时候选面板出来了", !!panel);
  eq("H8 面板里两行", panel.querySelectorAll(".iq-ed-panel-row").length, 2);
  ok("H9 行里带标签", panel.textContent.indexOf("\u5510\u8bd7") >= 0);
  eq(
    "H9a 行里只显示技巧正文",
    panel.querySelectorAll(".iq-ed-panel-text")[0].textContent,
    "\u6280\u5de7\u4e8c"
  );
  ok("H9b 行里不再显示题目", !panel.querySelector(".iq-ed-panel-title"), panel.textContent);
  e.fire(panel.querySelectorAll(".iq-ed-mini")[1], "click");
  eq("H10 点「用这条」填的是那一条", e.stored("\u89e3\u9898\u6280\u5de7"), "\u6280\u5de7\u4e00");
  eq("H11 用完面板收起", e.dom.document.getElementById("iq-ed-tipspanel"), null);
})();

(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", "", ""]);
  e.install("choice");
  e.api.showTips({ tags: [], items: [], reason: "no-tags" });
  ok(
    "H12 没标签时提示先加标签",
    e.dom.document.getElementById("iq-ed-tipsbar").textContent.indexOf("\u8fd8\u6ca1\u6709\u6807\u7b7e") >= 0
  );
  e.api.showTips({ tags: ["\u5510\u8bd7"], items: [], total: 0 });
  ok(
    "H13 同标签卡片里没技巧时也提示",
    e.dom.document.getElementById("iq-ed-tipsbar").textContent.indexOf("\u8fd8\u6ca1\u6709") >= 0
  );
})();

(function () {
  /* 判断题、填空题下面也该有按钮 */
  var t = makeEditor(["Q", "\u5bf9", "", "", "", ""], TF_FIELDS);
  t.install("tf");
  ok("H14 判断题也有技巧按钮", !!t.dom.document.getElementById("iq-ed-tipsbar"));
  var c = makeEditor(["", "", "", "", ""], CLOZE_FIELDS);
  c.install("cloze");
  ok("H15 填空题也有技巧按钮", !!c.dom.document.getElementById("iq-ed-tipsbar"));
})();

/* ---------- 知识点：标签逐行配链接（1.1.6） ---------- */

/* 往「标签框」里塞一个标签（模拟 Anki 编辑器里的标签 chip） */
function addTag(dom, name) {
  var box = dom.document.querySelector(".tag-editor");
  if (!box) {
    box = dom.document.createElement("div");
    box.setAttribute("class", "tag-editor");
    dom.document.body.appendChild(box);
  }
  var chip = dom.document.createElement("span");
  chip.setAttribute("class", "tag");
  chip.textContent = name;
  box.appendChild(chip);
  return chip;
}

(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", "", ""]);
  e.install("choice");
  var bar = e.dom.document.getElementById("iq-ed-knowbar");
  ok("H16 知识点下面有配置按钮", !!bar && !!e.dom.document.getElementById("iq-ed-knowtoggle"));
  eq("H17 默认收起（不排出一堆行）", e.dom.document.getElementById("iq-ed-knowpanel"), null);
  ok("H18 空着时提示怎么填", bar.textContent.indexOf("\u8fd8\u6ca1\u914d") >= 0, bar.textContent);
})();

(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", "", ""]);
  addTag(e.dom, "\u5510\u8bd7");
  e.install("choice", "", { tags: ["\u5510\u8bd7", "\u5b8b\u8bcd"] });
  e.fire(e.dom.document.getElementById("iq-ed-knowtoggle"), "click");
  var panel = e.dom.document.getElementById("iq-ed-knowpanel");
  ok("H19 点按钮才弹出面板", !!panel);
  eq("H20 每个标签一行", panel.querySelectorAll(".iq-ed-knowrow").length, 2);
  eq(
    "H21 行名就是标签（标签框里的排前面）",
    panel.querySelectorAll(".iq-ed-knowrow-name")[0].textContent,
    "\u5510\u8bd7"
  );
  eq("H22 还没配过链接时输入框是空的", panel.querySelectorAll(".iq-ed-knowrow-input")[0].value, "");
  ok("H23 面板里有「刷新标签」", panel.textContent.indexOf("\u5237\u65b0\u6807\u7b7e") >= 0);
})();

(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", "", ""]);
  addTag(e.dom, "\u5510\u8bd7");
  e.install("choice", "", { tags: ["\u5510\u8bd7", "\u5b8b\u8bcd"] });
  e.fire(e.dom.document.getElementById("iq-ed-knowtoggle"), "click");
  var panel = e.dom.document.getElementById("iq-ed-knowpanel");
  var inputs = panel.querySelectorAll(".iq-ed-knowrow-input");
  inputs[0].value = "https://a.example/tang";
  e.fire(inputs[0], "blur");
  eq(
    "H24 填完写回「知识点」字段",
    e.stored("\u77e5\u8bc6\u70b9"),
    "\u5510\u8bd7 -> https://a.example/tang"
  );
  var hint = e.dom.document.getElementById("iq-ed-knowhint");
  ok("H25 预览行跟着更新", hint.textContent.indexOf("\u5510\u8bd7") >= 0, hint.textContent);

  inputs[1].value = "anki:search:tag:\u5b8b\u8bcd";
  e.fire(inputs[1], "blur");
  eq(
    "H26 两行都写进去（一行一条）",
    e.stored("\u77e5\u8bc6\u70b9"),
    "\u5510\u8bd7 -> https://a.example/tang\n\u5b8b\u8bcd -> anki:search:tag:\u5b8b\u8bcd"
  );

  e.fire(panel.querySelectorAll(".iq-ed-mini")[0], "click");
  eq(
    "H27 每行的「试打开」发的是自己那条链接",
    e.sent()[e.sent().length - 1],
    "iq:editor:open:" + encodeURIComponent("https://a.example/tang")
  );

  e.fire(panel.querySelectorAll(".iq-ed-mini")[1], "click");
  eq("H28 点「×」把这行去掉", panel.querySelectorAll(".iq-ed-knowrow").length, 1);
  eq(
    "H29 字段里也跟着少一行",
    e.stored("\u77e5\u8bc6\u70b9"),
    "\u5b8b\u8bcd -> anki:search:tag:\u5b8b\u8bcd"
  );
})();

(function () {
  /* 老内容一律保留：不是这张卡标签的行、只有链接没有标签的老写法 */
  var e = makeEditor(["Q", "*\u7532", "", "", "", ""]);
  addTag(e.dom, "\u5510\u8bd7");
  e.install("choice", "", { tags: ["\u5510\u8bd7"] });
  e.api.applyNativeValues([
    "Q",
    "*\u7532",
    "",
    "",
    "",
    "\u9759\u591c\u601d\u5168\u6587 -> https://a.example/old\nhttps://a.example/bare"
  ]);
  var hint = e.dom.document.getElementById("iq-ed-knowhint");
  ok("H30 预览里列出会显示的标签", hint.textContent.indexOf("\u9759\u591c\u601d\u5168\u6587") >= 0, hint.textContent);
  e.fire(e.dom.document.getElementById("iq-ed-knowtoggle"), "click");
  var panel = e.dom.document.getElementById("iq-ed-knowpanel");
  eq("H31 标签行 + 老内容行都排出来", panel.querySelectorAll(".iq-ed-knowrow").length, 3);
  eq(
    "H32 没有标签的老行行名就是原文",
    panel.querySelectorAll(".iq-ed-knowrow-name")[2].textContent,
    "https://a.example/bare"
  );

  panel.querySelectorAll(".iq-ed-knowrow-input")[0].value = "https://a.example/typed";
  addTag(e.dom, "\u5b8b\u8bcd");
  var minis = panel.querySelectorAll(".iq-ed-mini");
  e.fire(minis[minis.length - 1], "click");
  var panel2 = e.dom.document.getElementById("iq-ed-knowpanel");
  eq("H33 刷新后带上新标签", panel2.querySelectorAll(".iq-ed-knowrow").length, 4);
  eq(
    "H34 刷新不丢刚打进去、还没提交的内容",
    panel2.querySelectorAll(".iq-ed-knowrow-input")[0].value,
    "https://a.example/typed"
  );
  e.fire(panel2.querySelectorAll(".iq-ed-knowrow-input")[0], "blur");
  eq(
    "H35 老的单行链接写回去时还是只有链接",
    e.stored("\u77e5\u8bc6\u70b9"),
    "\u5510\u8bd7 -> https://a.example/typed\n\u9759\u591c\u601d\u5168\u6587 -> https://a.example/old\nhttps://a.example/bare"
  );
})();

(function () {
  var t = makeEditor(["Q", "\u5bf9", "", "", "", ""], TF_FIELDS);
  t.install("tf");
  ok("H36 判断题也有知识点配置", !!t.dom.document.getElementById("iq-ed-knowtoggle"));
  var c = makeEditor(["", "", "", "", ""], CLOZE_FIELDS);
  c.install("cloze");
  ok("H37 填空题也有知识点配置", !!c.dom.document.getElementById("iq-ed-knowtoggle"));
})();

/* ---------- 1.1.3 起三个题型都没有「答案」字段，相关的说明行也撤了 ---------- */
(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", ""]);
  e.install("choice");
  eq("H27 选择题没有「答案」说明行了", e.dom.document.getElementById("iq-ed-answerhint"), null);
})();

(function () {
  var c = makeEditor(["", "", "", "", ""], CLOZE_FIELDS);
  c.install("cloze");
  eq("H28 填空题也没有说明行了", c.dom.document.getElementById("iq-ed-answerhint"), null);
})();

(function () {
  var t = makeEditor(["Q<!--iq-tf:\u5bf9-->", "", "", "", ""], TF_FIELDS);
  t.install("tf");
  eq("H29 判断题也没有说明行", t.dom.document.getElementById("iq-ed-answerhint"), null);
  ok("H30 判断题勾选框照样有", !!t.dom.document.querySelector(".iq-ed-box"));
})();

/* ---------- 1.1.4：题型里万一还残留「答案」字段（Anki 不肯删），编辑器里整块藏起来 ---------- */
(function () {
  var OLD_CHOICE = ["\u9898\u76ee", "\u9009\u9879", "\u7b54\u6848", "\u89e3\u6790", "\u89e3\u9898\u6280\u5de7", "\u6765\u6e90"];
  var e = makeEditor(["Q", "*\u7532", "", "", "", ""], OLD_CHOICE);
  e.install("choice");
  eq(
    "H33 选择题残留的「答案」整块藏起来",
    e.containerOf("\u7b54\u6848").style.display,
    "none"
  );
  eq("H34 选项块也藏得好好的", e.containerOf("\u9009\u9879").style.display, "none");
})();

(function () {
  var OLD_CLOZE = ["\u9898\u76ee", "\u89e3\u6790", "\u89e3\u9898\u6280\u5de7", "\u6765\u6e90", "\u7b54\u6848"];
  var c = makeEditor(["\u9898\u5e72", "", "", "", ""], OLD_CLOZE);
  c.install("cloze");
  eq("H35 填空题残留的「答案」也藏起来", c.containerOf("\u7b54\u6848").style.display, "none");
})();

(function () {
  var OLD_TF = ["\u9898\u76ee", "\u7b54\u6848", "\u89e3\u6790", "\u89e3\u9898\u6280\u5de7", "\u6765\u6e90"];
  var t = makeEditor(["\u9898\u5e72<!--iq-tf:\u5bf9-->", "", "", "", ""], OLD_TF);
  t.install("tf");
  eq("H36 判断题残留的「答案」也藏起来", t.containerOf("\u7b54\u6848").style.display, "none");
  ok("H37 判断题勾选框照常能用", t.dom.document.querySelectorAll(".iq-ed-box").length >= 1);
})();

/* ---------- 1.1.9：切题型字段消失（根因：按节点记隐藏 → 改成按名字重算） ---------- */

/* 现在藏着哪些块（按字段名报） */
function hiddenList(e) {
  var out = [];
  var blocks = e.dom.document.querySelectorAll(".fields .field-container");
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.classList.contains("iq-hidden") || (b.style && b.style.display === "none")) {
      var label = b.querySelector(".label-name");
      out.push(label ? label.textContent : "#" + i);
    }
  }
  return out;
}

/* 还带着我们标记的块有几块 */
function taggedCount(e) {
  var out = 0;
  var blocks = e.dom.document.querySelectorAll(".fields .field-container");
  for (var i = 0; i < blocks.length; i++) {
    if (
      blocks[i].getAttribute("data-iq-hidden") === "1" ||
      blocks[i].classList.contains("iq-hidden")
    ) {
      out++;
    }
  }
  return out;
}

/* 场景①（复现脚本场景 1）：选择题藏了「选项」→ 切判断题，「解析」不能跟着没 */
(function () {
  var e = makeEditor(["Q", "*\u7532\n\u4e59", "", "", "", ""]);
  e.install("choice");
  ok(
    "K1 选择题里只有「选项」被藏",
    e.isHidden("\u9009\u9879") && !e.isHidden("\u9898\u76ee") && !e.isHidden("\u89e3\u6790")
  );

  e.switchNoteType(TF_FIELDS); /* 同一批节点被复用，只改字段名 */
  e.api.tick(); /* 巡检那一轮：对不上就先收摊 */
  eq("K2 切到判断题后没有字段被藏", hiddenList(e), []);
  ok("K2b 对不上时控件也摘掉了", e.host() === null);
  ok("K3 判断题的「解析」还在（没被上一轮的隐藏带累）", !e.isHidden("\u89e3\u6790"));

  e.install("tf"); /* Anki 重发注入：按判断题重建 */
  ok("K4 判断题控件重建好了", !!e.host());
  eq("K5 重建后依然没有字段被藏", hiddenList(e), []);
})();

/* 场景②：选择题 →「正面/背面」这种别的笔记类型，「背面」不能没 */
(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", ""]);
  e.install("choice");
  e.switchNoteType(["\u6b63\u9762", "\u80cc\u9762"]);
  e.api.tick();
  ok("K6 别的笔记类型里「背面」可见", !e.isHidden("\u80cc\u9762"));
  eq("K7 一个字段都没被藏", hiddenList(e), []);
  eq("K8 我们的标记也清干净了", taggedCount(e), 0);
})();

/* 场景③：老判断题（还残留「答案」字段）→ 别的笔记类型 */
(function () {
  var OLD_TF = ["\u9898\u76ee", "\u7b54\u6848", "\u89e3\u6790", "\u89e3\u9898\u6280\u5de7", "\u6765\u6e90"];
  var e = makeEditor(["\u9898\u5e72<!--iq-tf:\u5bf9-->", "", "", "", ""], OLD_TF);
  e.install("tf");
  ok("K9 老判断题里残留的「答案」被藏", e.isHidden("\u7b54\u6848"));
  e.switchNoteType(["\u6b63\u9762", "\u80cc\u9762"]);
  e.api.tick();
  ok("K10 切走后「背面」可见", !e.isHidden("\u80cc\u9762"));
  eq("K11 没有字段被藏", hiddenList(e), []);
})();

/* 场景④：页面上的字段名变了（换题型的中间态），绝不能还照着位置去藏 */
(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", ""]);
  e.install("choice");
  ok("K12 起始：选择题里「选项」被藏", e.isHidden("\u9009\u9879"));
  var blocks = e.dom.document.querySelectorAll(".fields .field-container");
  blocks[1].querySelector(".label-name").textContent = "\u89e3\u6790"; /* 1 号位改名 */
  e.api.syncHidden();
  eq("K13 名字对不上时不藏任何块（宁可不藏，也不藏错）", hiddenList(e), []);
  ok("K13b 上一轮的标记也清干净了", blocks[1].getAttribute("data-iq-hidden") === null);
})();

/* 场景⑤：插件拿到的字段表和页面对不上（换了笔记类型但没重发注入） */
(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", ""]);
  e.install("choice");
  var opt = e.containerOf("\u9009\u9879");
  ok("K14 起始：选项块被藏、控件在", e.isHidden("\u9009\u9879") && !!e.host());
  e.switchNoteType(["\u6b63\u9762", "\u80cc\u9762"]);
  e.api.tick();
  ok("K15 对不上时控件摘掉", e.host() === null);
  eq("K16 字段还原（内联 display 清空）", opt.style.display, "");
  eq("K17 没有任何块还带着我们的标记", taggedCount(e), 0);
})();

/* 场景⑥：反复收敛不叠加，且不误伤 Anki 自己的 .hide（图片遮挡） */
(function () {
  var e = makeEditor(["Q", "*\u7532", "", "", "", ""]);
  var jiexi = e.containerOf("\u89e3\u6790");
  jiexi.classList.add("hide");
  e.install("choice");
  var first = hiddenList(e);
  e.api.syncHidden();
  e.api.syncHidden();
  e.api.tick();
  eq("K18 反复 syncHidden 结果不变", hiddenList(e), first);
  eq("K19 只藏了「选项」", first, ["\u9009\u9879"]);
  ok(
    "K20 Anki 自己的 .hide 没被动过",
    jiexi.classList.contains("hide") && jiexi.getAttribute("data-iq-hidden") === null
  );
  ok("K20b .hide 那块也没被写上内联 display", !jiexi.style || jiexi.style.display !== "none");
})();

/* 场景⑦：字段重排 / 数量变化后，area() 仍按名字取到对的那块 */
(function () {
  var e = makeEditor(["Q", "A\u7532", "\u89e3\u6790X", "", "", ""]);
  e.install("choice");
  e.switchNoteType([
    "\u9898\u76ee",
    "\u89e3\u6790",
    "\u9009\u9879",
    "\u89e3\u9898\u6280\u5de7",
    "\u6765\u6e90",
    "\u77e5\u8bc6\u70b9",
  ]);
  e.putField("\u9898\u76ee", "Q9")
    .putField("\u89e3\u6790", "J9")
    .putField("\u9009\u9879", "*\u75329");
  eq("K21 重排后 area(选项) 取到「选项」那一块", e.api.area("\u9009\u9879").value, "*\u75329");
  eq("K21b area(题目) 也是按名字", e.api.area("\u9898\u76ee").value, "Q9");
  e.switchNoteType(TF_FIELDS); /* 页面上没有「选项」这一块了 */
  eq("K22 页面上没有「选项」时宁可不给，也不乱指一个", e.api.area("\u9009\u9879"), null);
  eq("K23 判断题的「题目」照样取得到", e.api.area("\u9898\u76ee").value, "Q9");
})();

(function () {
  /* 出错时不挡编辑，但要留下记录 */
  var e = makeEditor(["Q", "\u7532", "", "", "", ""]);
  e.install("choice");
  eq("G13 正常情况下没有错误", e.api.lastError, null);
})();

/* ---------- 1.1.10：粘过来的富文本链接 / 裸网址 / 技巧连格式搬 + 同步 ---------- */
(function () {
  /* 从浏览器复制链接粘进「知识点」：字段里是 <a href="…">，以前会被当成搜索式、网址还会丢 */
  var e = makeEditor([
    "Q",
    "*甲",
    "",
    "",
    "",
    '<a href="https://baike.baidu.com/item/tang">唐诗</a>'
  ]);
  e.install("choice", "", { tags: ["唐诗"] });
  var hint = e.dom.document.getElementById("iq-ed-knowhint");
  ok("N1 富文本链接预览里照样有标签", hint.textContent.indexOf("唐诗") >= 0, hint.textContent);
  e.fire(e.dom.document.getElementById("iq-ed-knowtoggle"), "click");
  var panel = e.dom.document.getElementById("iq-ed-knowpanel");
  var input = panel.querySelectorAll(".iq-ed-knowrow-input")[0];
  eq("N2 面板里显示的是网址（不是锚文字）", input.value, "https://baike.baidu.com/item/tang");
  e.fire(input, "blur");
  eq(
    "N3 提交后写成「标签 -> 网址」，网址没丢",
    e.stored("知识点"),
    "唐诗 -> https://baike.baidu.com/item/tang"
  );
})();

(function () {
  var e = makeEditor(["Q", "*甲", "", "", "", "www.baidu.com"]);
  e.install("choice");
  e.fire(e.dom.document.getElementById("iq-ed-knowtoggle"), "click");
  var panel = e.dom.document.getElementById("iq-ed-knowpanel");
  var input = panel.querySelectorAll(".iq-ed-knowrow-input")[0];
  eq("N4 裸域名在面板里就是那一行", input.value, "www.baidu.com");
  e.fire(panel.querySelectorAll(".iq-ed-mini")[0], "click");
  eq(
    "N5 「试打开」把裸域名交给插件补协议",
    e.sent()[e.sent().length - 1],
    "iq:editor:open:" + encodeURIComponent("www.baidu.com")
  );
})();

(function () {
  var e = makeEditor(["Q", "*甲", "", "", "", ""]);
  e.install("choice");
  e.api.showTips({
    tags: ["唐诗"],
    total: 1,
    items: [
      { nid: 9, tip: "先看选项再想朝代", tip_html: "<b>先看选项</b><br>再想朝代&nbsp;", tags: ["唐诗"] }
    ]
  });
  var panel = e.dom.document.getElementById("iq-ed-tipspanel");
  e.fire(panel.querySelector(".iq-ed-mini"), "click");
  eq(
    "N6 「用这条」搬的是原始 HTML（换行/空格都在）",
    e.stored("解题技巧"),
    "<b>先看选项</b><br>再想朝代&nbsp;"
  );
  ok(
    "N7 填完提示「已填入」",
    e.dom.document.getElementById("iq-ed-tipsbar").textContent.indexOf("已填入") >= 0
  );
})();

(function () {
  var e = makeEditor(["Q", "*甲", "", "先看选项再想朝代", "", ""]);
  e.install("choice");
  var bar = e.dom.document.getElementById("iq-ed-tipsbar");
  var sync = bar.querySelectorAll(".iq-ed-mini")[1];
  ok(
    "N8 技巧栏有「同步到同技巧卡片」按钮",
    !!sync && sync.textContent.indexOf("同步") >= 0,
    sync && sync.textContent
  );
  e.fire(sync, "click");
  eq(
    "N9 点同步带上打开时的技巧基准",
    e.sent()[e.sent().length - 1],
    "iq:editor:sync-tip:" + encodeURIComponent("先看选项再想朝代")
  );
})();

(function () {
  var e = makeEditor(["Q", "*甲", "", "先看选项再想朝代", "", ""]);
  e.install("choice");
  var bar = e.dom.document.getElementById("iq-ed-tipsbar");
  e.api.showSyncResult({ ok: true, total: 3, synced: 2, tip_html: "<b>新技巧</b>" });
  ok("N10 同步成功提示张数", bar.textContent.indexOf("3") >= 0, bar.textContent);
  eq("N10a 同步成功后基准换成刚写出去那份", e.api.tipBase, "<b>新技巧</b>");
  e.api.showSyncResult({ ok: false, reason: "empty" });
  ok("N11 空内容提示先填", bar.textContent.indexOf("填上内容") >= 0, bar.textContent);
  e.api.showSyncResult({ ok: false, reason: "unchanged" });
  ok("N12 没改动有提示", bar.textContent.indexOf("没改动") >= 0, bar.textContent);
  e.api.showSyncResult({ ok: false, reason: "only-self" });
  ok("N13 只有本卡时有提示", bar.textContent.indexOf("没有别的卡片") >= 0, bar.textContent);
  e.api.showSyncResult({ ok: false, reason: "declined" });
  ok("N14 取消后也有提示", bar.textContent.indexOf("已取消") >= 0, bar.textContent);
})();

/* ---------- 1.1.11：从浏览器粘链接（真网址在 text/html 里）/ 📋 兜底 / 子标签显示 ---------- */
function knowInput(e) {
  var panel = e.dom.document.getElementById("iq-ed-knowpanel");
  return panel ? panel.querySelectorAll(".iq-ed-knowrow-input")[0] : null;
}

function openKnow(e) {
  e.fire(e.dom.document.getElementById("iq-ed-knowtoggle"), "click");
  return e.dom.document.getElementById("iq-ed-knowpanel");
}

(function () {
  /* 浏览器「复制链接」：text/plain 只有锚文字，真网址在 text/html 的 href 里 */
  var e = makeEditor(["Q", "*甲", "", "", "", ""]);
  e.install("choice", "", { tags: ["唐诗"] });
  openKnow(e);
  var input = knowInput(e);
  var prevented = 0;
  e.fire(input, "paste", {
    preventDefault: function () {
      prevented++;
    },
    clipboardData: {
      getData: function (type) {
        if (type === "text/html") {
          return '<a href="https://baike.baidu.com/item/tang">唐诗</a>';
        }
        if (type === "text/plain") {
          return "唐诗";
        }
        return "";
      }
    }
  });
  eq("N15 粘链接时输入框换成真网址", input.value, "https://baike.baidu.com/item/tang");
  eq("N16 拦下这次粘贴", prevented, 1);
  eq(
    "N17 写回字段是「标签 -> 网址」",
    e.stored("知识点"),
    "唐诗 -> https://baike.baidu.com/item/tang"
  );
})();

(function () {
  /* 粘的是普通文字（不是链接）：别抢，照常粘 */
  var e = makeEditor(["Q", "*甲", "", "", "", ""]);
  e.install("choice", "", { tags: ["唐诗"] });
  openKnow(e);
  var input = knowInput(e);
  var prevented = 0;
  e.fire(input, "paste", {
    preventDefault: function () {
      prevented++;
    },
    clipboardData: {
      getData: function () {
        return "唐诗";
      }
    }
  });
  eq("N18 普通文字不拦", prevented, 0);
  eq("N19 输入框也没被改", input.value, "");
})();

(function () {
  /* 已经粘成文字了：点每行的「📋 读链接」，插件读剪贴板再推回来 */
  var e = makeEditor(["Q", "*甲", "", "", "", ""]);
  e.install("choice", "", { tags: ["唐诗"] });
  var panel = openKnow(e);
  var minis = panel.querySelectorAll(".iq-ed-mini");
  var clipBtn = null;
  for (var i = 0; i < minis.length; i++) {
    if (minis[i].textContent.indexOf("读链接") >= 0) {
      clipBtn = minis[i];
    }
  }
  ok("N20 每行有「📋 读链接」按钮", !!clipBtn, panel.textContent);
  e.fire(clipBtn, "click");
  eq("N21 点它请插件去读剪贴板", e.sent()[e.sent().length - 1], "iq:editor:clip:0");
  var done = e.api.applyClipboard("https://a.example/x", 0);
  eq("N22 推回来的网址填进那一行", knowInput(e).value, "https://a.example/x");
  eq("N23 也写回了字段", e.stored("知识点"), "唐诗 -> https://a.example/x");
  eq("N24 读到链接返回 true", done, true);
  var bar = e.dom.document.getElementById("iq-ed-knowbar");
  ok("N24a 提示已读入", bar.textContent.indexOf("已读入") >= 0, bar.textContent);
  var none = e.api.applyClipboard("", 0);
  eq("N25 读不到返回 false", none, false);
  ok("N25a 读不到时教怎么操作", bar.textContent.indexOf("没读到链接") >= 0, bar.textContent);
})();

(function () {
  /* 子标签：字段里是完整路径，行名只显示末级名，写回仍旧是全路径 */
  var e = makeEditor([
    "Q",
    "*甲",
    "",
    "",
    "",
    "刑事诉讼法::刑事诉讼法概述 -> https://a.example/x"
  ]);
  e.install("choice");
  var hint = e.dom.document.getElementById("iq-ed-knowhint");
  ok(
    "N26 收起时预览只显示末级名",
    hint.textContent.indexOf("刑事诉讼法概述") >= 0 && hint.textContent.indexOf("::") < 0,
    hint.textContent
  );
  var panel = openKnow(e);
  var row = panel.querySelectorAll(".iq-ed-knowrow")[0];
  eq("N27 行名只显示末级名", row.querySelectorAll(".iq-ed-knowrow-name")[0].textContent, "刑事诉讼法概述");
  eq("N28 完整路径留在 data-label 里", row.getAttribute("data-label"), "刑事诉讼法::刑事诉讼法概述");
  ok("N28a 悬停能看到完整路径", row.querySelectorAll(".iq-ed-knowrow-name")[0].getAttribute("title") === "刑事诉讼法::刑事诉讼法概述");
  e.fire(row.querySelectorAll(".iq-ed-knowrow-input")[0], "blur");
  eq(
    "N29 写回字段仍用完整路径",
    e.stored("知识点"),
    "刑事诉讼法::刑事诉讼法概述 -> https://a.example/x"
  );
})();

(function () {
  /* 打开时记住的「原技巧」是原始 HTML（不是去标签文字），后面只改格式才比得出来 */
  var e = makeEditor(["Q", "*甲", "", "先看选项<br>再想朝代", "", ""]);
  e.install("choice");
  eq("N30 同步基准留着原始 HTML", e.api.tipBase, "先看选项<br>再想朝代");
  var bar = e.dom.document.getElementById("iq-ed-tipsbar");
  var sync = bar.querySelectorAll(".iq-ed-mini")[1];
  e.fire(sync, "click");
  eq(
    "N31 点同步仍带上打开时那份原始 HTML",
    e.sent()[e.sent().length - 1],
    "iq:editor:sync-tip:" + encodeURIComponent("先看选项<br>再想朝代")
  );
})();

log.join("\n") + "\n----\nPASS=" + pass + " FAIL=" + fail;
