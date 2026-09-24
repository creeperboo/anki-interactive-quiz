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

function makeEditor(values, fields) {
  var dom = makeDOM();
  var win = {};
  fields = fields || CHOICE_FIELDS;
  values = values || [];
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
  var qStyle = e.questionField().style;
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
  eq("F49 整个「选项」字段块都藏起来", e.optionField().parentNode.style.display, "none");
})();

(function () {
  var e = makeEditor(["Q", "", "", "", "", ""]);
  e.install("choice");
  eq("F50 「选项」字段名也一起藏住了（整块）", e.optionField().parentNode.style.display, "none");
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
    e.answerField().parentNode.style.display,
    "none"
  );
  eq("H34 选项块也藏得好好的", e.optionField().parentNode.style.display, "none");
})();

(function () {
  var OLD_CLOZE = ["\u9898\u76ee", "\u89e3\u6790", "\u89e3\u9898\u6280\u5de7", "\u6765\u6e90", "\u7b54\u6848"];
  var c = makeEditor(["\u9898\u5e72", "", "", "", ""], OLD_CLOZE);
  c.install("cloze");
  eq("H35 填空题残留的「答案」也藏起来", c.answerField().parentNode.style.display, "none");
})();

(function () {
  var OLD_TF = ["\u9898\u76ee", "\u7b54\u6848", "\u89e3\u6790", "\u89e3\u9898\u6280\u5de7", "\u6765\u6e90"];
  var t = makeEditor(["\u9898\u5e72<!--iq-tf:\u5bf9-->", "", "", "", ""], OLD_TF);
  t.install("tf");
  eq("H36 判断题残留的「答案」也藏起来", t.answerField().parentNode.style.display, "none");
  ok("H37 判断题勾选框照常能用", t.dom.document.querySelectorAll(".iq-ed-box").length >= 1);
})();

(function () {
  /* 出错时不挡编辑，但要留下记录 */
  var e = makeEditor(["Q", "\u7532", "", "", "", ""]);
  e.install("choice");
  eq("G13 正常情况下没有错误", e.api.lastError, null);
})();

log.join("\n") + "\n----\nPASS=" + pass + " FAIL=" + fail;
