# 互动答题卡 · Anki 插件

在 Anki 复习界面**直接做题**的插件：**选择题 / 判断题 / 原生填空**。

- 点「不知道」或答错 → **强制记为「重来」**（连键盘 `3` 和底部工具栏的「良好」也压得住）
- 答对 → 自己挑 **困难 / 良好 / 简单**
- 手机端也能刷（自动降级成「自测 + 自己按 1-4 评级」）

当前版本：**1.0.0**

---

## English (short version)

> Full English documentation: **[README.en.md](README.en.md)**

**Interactive Quiz Cards for Anki (desktop add-on)** — answer multiple-choice / true-false / cloze questions directly on the review screen.

- Three independent note types: **choice** (single & multi), **true→false**, **cloze** (`{{c1::...}}`, one card per deletion)
- Authoring is checkbox-based: each option is its own input box with a "correct" checkbox (`Enter` adds a row, `Backspace` on an empty row removes it, `Alt+↑/↓` reorders, `Alt+<n>` toggles the n-th option). No `*` syntax to remember.
- Grading: wrong or "I don't know" → forced **Again** (keyboard `3` and the bottom bar are overridden too); correct → you choose Hard / Good / Easy
- Per-card answer statistics with deck / type / tag / time / keyword filters, sortable by difficulty
- Mobile (AnkiDroid / AnkiMobile / AnkiWeb): the card detects that no desktop add-on is present and switches to *self-test + rate yourself with 1-4* mode — no dead buttons
- Checks GitHub for updates (Tools → 互动答题卡：设置与统计… → 检查更新)

**Install**: download `interactive_quiz.ankiaddon` → Anki → *Tools → Add-ons → Install from file* → restart Anki. Three note types are created automatically.

Slides and docs below are in Chinese (this is a personal study tool).

---

## 三个题型（各自独立，字段也各自独立）

| 题型 | 用途 | 编辑器里长什么样 |
| --- | --- | --- |
| **互动答题卡·选择题** | 单选 / 多选 | 选项是**一行一个输入框**，右侧一个「正确」勾选框 |
| **互动答题卡·判断题** | 对 / 错 | 只有一个「这题是正确的」**勾选框** |
| **互动答题卡·填空** | 原生 cloze | 用 Anki 原生的挖空按钮写 `{{c1::答案}}`，一个空一张卡 |

> 以前那个靠「类型」字段猜题型的通用题型已经废弃，插件启动时会自动清理（里面要是有你自己写的笔记会保留）。

---

## 安装

**方式一（推荐）**：下载本仓库里的 `interactive_quiz.ankiaddon`

1. Anki → **工具 → 插件** → 右上角 **从文件安装** → 选中它
2. 重启 Anki（插件只在启动时加载）
3. 插件会自动创建三个题型，可以用了

**方式二（从源码）**

```powershell
# 把 源码/ 复制进 Anki 的 addons21/interactive_quiz/，或直接跑：
python 安装到Anki.py          # 会自动找到 addons21、复制、并重新打包 .ankiaddon
```

---

## 快速上手

1. **工具 → 互动答题卡：设置与统计…** → 「设置」页底部点 **[生成示例卡片]**
2. 去「答题卡示例」卡组复习一次，看看答对/答错分别是什么体验
3. 之后加卡：**[添加]** → 右上角选题型 → 直接在编辑器里勾选

---

## 制卡怎么写

### 选择题

编辑器里点 **[＋ 添加选项]** 加行，每行填一个选项，右侧勾上就是正确答案：

```
选项（一行一个，右侧勾选正确答案）
[ 李白            ] [✓ 正确] [×]
[ 杜甫            ] [ 正确] [×]
[ 白居易          ] [ 正确] [×]
[＋ 添加选项]
Enter 加下一行 · 空行按 Backspace 删行 · Alt+↑↓ 上下移 · Alt+数字 勾选第 N 行
✅ 识别为【单选】
```

- 勾 **1 个** = 单选（点一下选项立刻判分）
- 勾 **2 个以上** = 多选（选完点「提交答案」，全对才算对）
- 存到字段里就是 `*李白` 这种格式（行首 `*` = 正确答案），所以手机上直接写 `*` 也等效

### 判断题

只需要写题干，答案用勾选框给：

```
[✓] 这题是正确的        当前：对
```

勾 = 对，不勾 = 错。（`答案` 字段仍然存在但被藏起来了，勾选框会往里写「对 / 错」。）

### 填空题

用 Anki 原生的挖空按钮或 `Ctrl+Shift+C`：

```
中国的首都是{{c1::北京}}，最大的城市是{{c2::上海}}。
```

→ 生成 **2 张卡**。同一个 `c` 号算一张卡，可以写提示 `{{c1::北京::中国首都}}`。

### 解题技巧：一键用同标签卡片的技巧

「解题技巧」字段下面有一个 **[⚡ 用同标签卡片的技巧]** 按钮。先给卡片加上标签（比如 `唐诗`），
点一下就会去翻**同标签、已经写过技巧**的卡片：

- 只找到一条 → 直接填进「解题技巧」
- 找到多条 → 列出候选（按共同标签数、新近排序），点 **[用这条]** 选一条
- 这张卡还没标签 → 提示你先加标签

标签框里刚敲还没提交的标签也算数。批量做题时，同一个知识点的技巧写一次就够了。

### 知识点：答完题一键跳过去

新字段 **`知识点`**（三个题型都有）。制卡时在里写一行，答完题后卡片上就会出现
**[📚 相关知识点：…]** 按钮，点一下跳过去。两种写法：

```
https://zh.wikipedia.org/wiki/静夜思                  ← 网址，交给系统浏览器
唐诗格律 -> anki:search:tag:唐诗                       ← 「标题 -> 目标」
```

目标是网址就用浏览器打开；其它一律当 **Anki 搜索式**，在卡片浏览器里搜出来。支持这些前缀：

| 写法 | 打开 |
| --- | --- |
| `anki:search:tag:唐诗`（或直接写 `tag:唐诗`） | 在卡片浏览器搜索 |
| `anki:tag:唐诗` | 同上（按标签搜） |
| `anki:deck:复习::唐诗` | 搜这个牌组里的卡 |
| `anki:note:1699999999999` | 直接定位这张笔记 |
| `https://…` | 系统浏览器 |

「知识点」字段下面有预览行（写着按钮会显示成什么）和 **[试打开]**，制卡时点一下就能确认链接对不对。
手机上（没有插件）网页链接照样能点开；Anki 搜索式的会显示成「在 Anki 里搜：xxx」的提示。

---

## 手机上怎么用

卡片会正常同步到手机，**手机上照样能自测**，只是评级要自己按一下：

1. 选项照样点、填空照样填，当场显示「✅ 回答正确 / ❌ 回答错误 + 正确答案 + 解析」
2. 点手机下方的「显示答案」，再按 **1 重来 / 2 困难 / 3 良好 / 4 简单**

判断依据是「卡片里有没有桌面插件注入的配置」：桌面有 → 自动评级；手机 / AnkiWeb 没有 → 手机模式，不假装能评级，也不会出现「点了按钮变灰、卡片卡住」。

手机上制卡也照常：字段是纯文本，选项行首写 `*`、判断题在「答案」字段填 `对/错`。

---

## 设置与统计

**工具 → 互动答题卡：设置与统计…**

**设置页**

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 记录作答明细 | 开 | 统计总开关 |
| 明细保留天数 | 0 | 0 = 永久保留 |
| 答题时显示计时 | 关 | 卡片右上角显示本题用时 |
| 多选漏选记「困难」 | 关 | 开启后漏选（没选错）可以记困难 |
| 启动时自动检查更新 | 开 | 每天最多查一次 GitHub 上的新版本 |

维护区：**[创建 / 更新题型模板]**、**[生成示例卡片]**、**[检查更新]**。
其余选项（答错后是否先显示答案、填空是否忽略标点等）在 **工具 → 插件 → 互动答题卡 → 配置** 里。

**统计页**：卡片级表格，可按 牌组（含子牌组）/ 题型 / 标签 / 时间 / 关键词 组合筛选，支持按「难度」或「Anki 难易度」排序。「难度」= 平滑错误率 `(答错次数+0.5) / (作答次数+1)`。

---

## 更新

- 插件里：设置窗口的 **[检查更新]**（或启动时自动，`update_check` 关掉就不联网查）
- 发现新版本会问你要不要下载安装，装完重启 Anki 即可
- 发版流程（维护者）：改代码 → 改 `version.txt` → `python 安装到Anki.py` → 提交推送

---

## 目录结构

```
源码/__init__.py            插件全部 Python 逻辑（单文件）
源码/assets/quiz.js         卡片端脚本（判分、交互、手机模式）
源码/assets/quiz.css        卡片端样式
源码/assets/editor.js       编辑器控件（选项行 / 判断题勾选框）
源码/tests/py-test.py       Python 侧测试
源码/tests/dom-test.js      卡片端交互测试（含最小 DOM 仿真）
源码/tests/editor-test.js   编辑器控件测试
源码/{manifest,config}.json 插件清单与默认配置
源码/README.md              插件自带说明（更详细）
安装到Anki.py               一键安装 + 重新打包
互动答题卡-操作指南.txt        给使用者的纯文本手册
项目说明.md / 对话记录.md      开发过程的决策与踩坑记录
interactive_quiz.ankiaddon  分发包
version.txt                 版本号（插件据此检查更新）
```

---

## 测试

```powershell
# Python 侧（用假的 aqt 模块导入插件）
python 源码\tests\py-test.py

# 卡片端 + 编辑器控件需要 JS 运行时（本机没 node 时用 Anki 内置/任意 JS 环境）
# 思路：把 quiz.js / editor.js 包成工厂函数，拼上测试文件执行
```

当前：Python 135 项、卡片端 126 项、编辑器控件 52 项，全绿。

---

## 已知限制

- **自动评级只在桌面版有效**（手机用手机模式，见上）
- 「创建 / 更新题型模板」会**覆盖**三个题型的模板与样式，自己改过模板的话先备份
- 手机端「答错强制重来」不生效，得自己按 1
- 统计存在插件目录的 `user_files/stats.db`，**不跟随 AnkiWeb 同步**

## 许可

暂未附许可证文件；想直接复用/分发的话开个 issue 说一声即可。
