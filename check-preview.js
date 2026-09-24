/* 端到端核对预览页里那 7 张卡：用 dom-test.js 的伪 DOM 跑真实的 quiz.js，
   再执行预览页给每张卡配的「演示动作」，把结果打出来看看是不是想要的状态。
   用法：node check-preview.js [预览 HTML 路径] [源码目录]
         （不写参数就用本脚本旁边的 答题反馈预览-1.1.6.html 和 源码\） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const htmlPath = process.argv[2] || path.join(__dirname, "答题反馈预览-1.1.6.html");
const srcRoot = process.argv[3] || path.join(__dirname, "源码");

const html = fs.readFileSync(htmlPath, "utf8");
const payloadJson = html.split('<script id="payload" type="application/json">')[1]
  .split("</script>")[0];
const payload = JSON.parse(payloadJson);
const quiz = fs.readFileSync(path.join(srcRoot, "assets", "quiz.js"), "utf8");

const domAll = fs.readFileSync(path.join(srcRoot, "tests", "dom-test.js"), "utf8");
const domLines = domAll.split(/\r?\n/);
const markerIdx = domLines.findIndex((line) => line.indexOf("用例开始") >= 0);
const helpers = domLines.slice(0, markerIdx).join("\n");

const head =
  "var quizFactory = function(document, window, pycmd, console, setTimeout, setInterval, clearInterval) {" +
  quiz +
  "\n};\n" +
  helpers +
  "\n";

const body = `
var results = [];
payload.cards.forEach(function (card) {
  var dom = makeDOM();
  var win = {};
  win.__ANKI_QUIZ_CONFIG__ = {};
  dom.document.body.innerHTML = card.html;
  quizFactory(dom.document, win, function () {}, { error: function () {}, log: function () {} },
              function () { return 0; }, function () { return 0; }, function () {});
  var document = dom.document;
  var window = win;
  /* 伪 DOM 没有 element.click()，用它的 fire() 顶上（真浏览器里 click() 本来就有） */
  (function patch(node) {
    if (node.nodeType === 1) {
      node.click = function () { dom.fire(node, "click"); };
    }
    for (var i = 0; i < (node.childNodes || []).length; i++) {
      patch(node.childNodes[i]);
    }
  })(dom.document.body);
  var action = (card.demo.match(/try\\{([\\s\\S]*?)\\}catch\\(e\\)\\{\\}/) || [])[1] || "";
  if (action) { eval(action); }
  function texts(sel) {
    return Array.prototype.map.call(document.querySelectorAll(sel), function (n) { return n.textContent; });
  }
  var verdictNode = document.querySelector("#iq-feedback .iq-verdict");
  results.push({
    title: card.title,
    verdict: verdictNode ? verdictNode.textContent : "(无)",
    crossed: texts("#iq-question .iq-fill-typed"),
    filled: texts("#iq-question .iq-blank-filled"),
    greenOptions: document.querySelectorAll("#iq-options .iq-correct").length,
    options: document.querySelectorAll("#iq-options .iq-opt").length,
    feedbackHasAnswerLine: (document.getElementById("iq-feedback") || { textContent: "" })
      .textContent.indexOf("\\u6b63\\u786e\\u7b54\\u6848") >= 0,
    answerBlock: document.getElementById("iq-answer-block") !== null,
    /* 相关知识点：现在是一排可点的标签（答完的反馈区 + 答案面） */
    knowledgeChips: texts("#iq-feedback .iq-know-btn").concat(texts("#iq-knowledge .iq-know-btn")),
    knowledgeHrefs: Array.prototype.map.call(document.querySelectorAll(".iq-know-btn"), function (n) {
      return n.getAttribute("href");
    })
  });
});
JSON.stringify(results, null, 2);
`;

const out = vm.runInNewContext(head + "var payload = " + JSON.stringify(payload) + ";\n" + body, {
  console: console,
});
process.stdout.write(out + "\n");
