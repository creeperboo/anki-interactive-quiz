/* 编辑器助手（assets/editor.js）的测试。
   REPL 里这样拼： "var editorFactory = function(document, window){" + editor.js + "};" + 本文件 */

var CHOICE_FIELDS = ["题目", "选项", "答案", "解析", "解题技巧", "来源"];
var TF_FIELDS = ["题目", "答案", "解析", "解题技巧", "来源"];
var CLOZE_FIELDS = ["题目", "解析", "解题技巧", "来源"];

function makeEditor(values, fields) {
  var dom = makeDOM();
  var win = {};
  fields = fields || CHOICE_FIELDS;
  var html = '<div class="fields">';
  for (var i = 0; i < fields.length; i++) {
    html += '<div class="field-container"><div class="field-label">' + fields[i] + '</div><textarea></textarea></div>';
  }
  html += "</div>";
  dom.document.body.innerHTML = html;
  editorFactory(dom.document, win);
  var areas = dom.document.querySelectorAll(".fields textarea");
  for (var j = 0; j < areas.length; j++) {
    areas[j].value = values[j];
  }
  var api = win.__IQ_EDITOR__;
  return {
    dom: dom,
    win: win,
    api: api,
    fields: fields,
    areas: areas,
    fire: dom.fire,
    install: function (mode, typeName) {
      win.__IQ_EDITOR_INSTALL__({ mode: mode, fields: fields, type: typeName || "" });
      return this;
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
    }
  };
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
  eq("F6 原来的选项文本框被藏起来", e.optionField().style.display, "none");
  ok("F7 没勾选时提示", e.status().indexOf("\u8fd8\u6ca1\u52fe\u9009") >= 0, e.status());
})();

(function () {
  var e = makeEditor(["Q", "A. \u7532\nB. \u4e59", "", "", "", ""]);
  e.install("choice");
  e.boxes()[0].checked = true;
  e.fire(e.boxes()[0], "change");
  eq("F8 勾选后写回字段", e.optionField().value, "*\u7532\n\u4e59");
  ok("F9 勾一个 = 单选", e.status().indexOf("\u5355\u9009") >= 0, e.status());
  e.boxes()[1].checked = true;
  e.fire(e.boxes()[1], "change");
  eq("F10 勾两个写回两个星号", e.optionField().value, "*\u7532\n*\u4e59");
  ok("F11 勾两个 = 多选", e.status().indexOf("\u591a\u9009") >= 0, e.status());
  e.boxes()[0].checked = false;
  e.fire(e.boxes()[0], "change");
  eq("F12 取消勾选会去掉星号", e.optionField().value, "\u7532\n*\u4e59");
})();

(function () {
  var e = makeEditor(["Q", "\u7532\n\u4e59", "", "", "", ""]);
  e.install("choice");
  e.fire(e.inputs()[0], "input");
  eq("F13 改内容直接写回字段", e.optionField().value, "\u7532\n\u4e59");
  e.inputs()[1].value = "\u4e59\u4e59";
  e.fire(e.inputs()[1], "input");
  eq("F14 改第二行", e.optionField().value, "\u7532\n\u4e59\u4e59");
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
  eq("F23 写回字段", e.optionField().value, "\u7532\n*\u4e59\n\u4e19");
  key(e, e.inputs()[0], { key: "2", altKey: true });
  eq("F24 再按一次取消", e.boxes()[1].checked, false);

  key(e, e.inputs()[0], { key: "ArrowDown", altKey: true, keyCode: 40 });
  eq("F25 Alt+↓ 把第一行下移", e.inputs()[0].value, "\u4e59");
  key(e, e.inputs()[1], { key: "ArrowUp", altKey: true, keyCode: 38 });
  eq("F26 Alt+↑ 再移回来", e.inputs()[0].value, "\u7532");
  eq("F27 移动后字段同步", e.optionField().value, "\u7532\n\u4e59\n\u4e19");
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
  eq("F29a 空行勾了也不写进字段", e.optionField().value, "");
  e.inputs()[0].value = "\u7532";
  e.fire(e.inputs()[0], "input");
  eq("F29b 填了内容才写，且带着星号", e.optionField().value, "*\u7532");
})();

/* ---------- 判断题：一个勾选框 ---------- */
(function () {
  var e = makeEditor(["\u592a\u9633\u4ece\u897f\u8fb9\u5347\u8d77\u3002", "", "", "", ""], TF_FIELDS);
  e.install("tf");
  ok("F30 生成了勾选框", !!e.host());
  eq("F31 藏起了答案文本框", e.answerField().style.display, "none");
  eq("F32 初始不勾选", e.boxes()[0].checked, false);
  ok("F33 提示没设置", e.host().textContent.indexOf("\u8fd8\u6ca1\u8bbe\u7f6e") >= 0, e.host().textContent);

  e.boxes()[0].checked = true;
  e.fire(e.boxes()[0], "change");
  eq("F34 勾上 = 对", e.answerField().value, "\u5bf9");
  ok("F35 显示当前是对的", e.host().textContent.indexOf("\u5f53\u524d\uff1a\u5bf9") >= 0, e.host().textContent);

  e.boxes()[0].checked = false;
  e.fire(e.boxes()[0], "change");
  eq("F36 不勾 = 错", e.answerField().value, "\u9519");
  ok("F37 显示当前是错的", e.host().textContent.indexOf("\u5f53\u524d\uff1a\u9519") >= 0, e.host().textContent);
})();

(function () {
  var e = makeEditor(["Q", "\u9519", "", "", ""], TF_FIELDS);
  e.install("tf");
  eq("F38 打开时按已有答案勾选", e.boxes()[0].checked, false);
  var e2 = makeEditor(["Q", "\u5bf9", "", "", ""], TF_FIELDS);
  e2.install("tf");
  eq("F39 「对」时是勾上的", e2.boxes()[0].checked, true);
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
  eq("F49 整个「选项」字段块都藏起来", e.optionField().parentNode.style.display, "none");
})();

(function () {
  var e = makeEditor(["Q", "", "", "", ""], TF_FIELDS);
  e.install("tf");
  eq("F50 整个「答案」字段块都藏起来", e.answerField().parentNode.style.display, "none");
})();

/* ---------- 读写接口 ---------- */
(function () {
  var e = makeEditor(["Q", "\u7532\n\u4e59", "", "", "", ""]);
  e.install("choice");
  var dumped = JSON.parse(e.api.dump());
  eq("F44 dump 出题目", dumped["\u9898\u76ee"], "Q");
  eq("F45 dump 出选项", dumped["\u9009\u9879"], "\u7532\n\u4e59");

  e.api.apply({ "\u9009\u9879": "*\u7532\n\u4e59", "\u9898\u76ee": "Q2" });
  eq("F46 apply 写回选项", e.optionField().value, "*\u7532\n\u4e59");
  eq("F47 apply 后控件重建", e.boxes()[0].checked, true);
  eq("F48 apply 状态同步", e.status().indexOf("\u5355\u9009") >= 0, true);
})();

log.join("\n") + "\n----\nPASS=" + pass + " FAIL=" + fail;
