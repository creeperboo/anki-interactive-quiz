/* 把 assets/quiz.js（或 editor.js）包成工厂函数，再拼上测试文件，用 vm 跑一遍。
   用法：node run-js-tests.js [源码目录] [quiz|editor]
         （不写参数就用本脚本旁边的 源码\，默认跑卡片端 quiz） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = process.argv[2] || path.join(__dirname, "源码");
const which = process.argv[3] || "quiz";
const src = fs.readFileSync(path.join(root, "assets", which + ".js"), "utf8");
const domAll = fs.readFileSync(path.join(root, "tests", "dom-test.js"), "utf8");
const domLines = domAll.split(/\r?\n/);
const markerIdx = domLines.findIndex((line) => line.indexOf("用例开始") >= 0);
if (markerIdx < 0) {
  throw new Error("dom-test.js 里找不到「用例开始」标记");
}
/* 用例开始之前的那一段是伪 DOM + 小工具，编辑器测试也要复用 */
const helpers = domLines.slice(0, markerIdx).join("\n");

let head;
let testFile;
if (which === "quiz") {
  head = "var quizFactory = function(document, window, pycmd, console, setTimeout, setInterval, clearInterval) {" +
    src + "\n};\n";
  testFile = "dom-test.js";
} else {
  head = "var editorFactory = function(document, window) {" + src + "\n};\n" + helpers + "\n";
  testFile = "editor-test.js";
}

const body = fs.readFileSync(path.join(root, "tests", testFile), "utf8");
const out = vm.runInNewContext(head + body, { console: console });
process.stdout.write(String(out) + "\n");
