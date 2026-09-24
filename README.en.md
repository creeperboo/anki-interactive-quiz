# Interactive Quiz Cards · Anki add-on

Answer **multiple-choice / true-false / cloze** questions directly on Anki's review screen — no "look at the front, flip the back" reading.

- Wrong answer or "I don't know" → **forced Again** (keyboard `3` and the bottom bar are overridden too)
- Correct → you pick **Hard / Good / Easy**
- Works on your phone too (the card detects there is no desktop add-on and switches to *self-test + rate yourself*)

Current version: **1.0.1** · Desktop only for the full experience (Windows / macOS / Linux) · [中文说明 (README.md)](README.md)

---

## Note types

The add-on creates and maintains three **independent** note types — each has its own fields, so you never have to "guess the type from which fields are filled":

| Note type | Purpose | In the editor |
| --- | --- | --- |
| **互动答题卡·选择题** (choice) | single / multiple choice | one input box per option + a "correct" checkbox |
| **互动答题卡·判断题** (true-false) | right / wrong | a single "this statement is correct" checkbox |
| **互动答题卡·填空** (cloze) | native cloze | Anki's own cloze button / `Ctrl+Shift+C`, `{{c1::answer}}` |

> Older versions had a single "guess the type" note type. It is deprecated and cleaned up automatically on startup (notes you wrote in it are kept).

---

## Install

**From the package (recommended)**

1. Download `interactive_quiz.ankiaddon` (repo root or the [latest release](https://github.com/creeperboo/anki-interactive-quiz/releases))
2. Anki → **Tools → Add-ons → Install from file…** → pick it
3. Restart Anki — the three note types are created automatically

**From source**

```powershell
# copy 源码/ into addons21/interactive_quiz/ , or simply run:
python 安装到Anki.py          # finds addons21, copies the files, rebuilds the .ankiaddon
```

---

## Quick start

1. **Tools → 互动答题卡：设置与统计…** → on the *设置* tab click **[生成示例卡片]**
2. Review the "答题卡示例" deck once to see what a right/wrong answer feels like
3. Add your own: **[Add]** → pick a note type → fill it in with the checkboxes

---

## Authoring

### Choice questions

Click **[＋ 添加选项]** to add a row; each row is one option, tick the checkbox on the right to mark it correct:

```
选项（一行一个，右侧勾选正确答案）
[ 李白            ] [✓ 正确] [×]
[ 杜甫            ] [ 正确] [×]
[ 白居易          ] [ 正确] [×]
[＋ 添加选项]
Enter 加下一行 · 空行按 Backspace 删行 · Alt+↑↓ 上下移 · Alt+数字 勾选第 N 行
✅ 识别为【单选】
```

- exactly **one** ticked → single choice (clicking an option grades immediately)
- **two or more** ticked → multiple choice (submit, must be fully correct)
- Stored in the field as `*李白` (a leading `*` marks the correct option) — so writing `*` by hand works too, e.g. on mobile

Shortcuts (cursor in the options area):

| Key | Action |
| --- | --- |
| `Enter` | insert a new option below the current row |
| `Backspace` on an empty row | delete that row |
| `Alt+↑` / `Alt+↓` | move the current option up / down |
| `Alt+1` … `Alt+9` | tick / untick the n-th option as correct |
| paste multi-line text | split into one option per line automatically |

### True-false questions

Type the statement, then use the checkbox:

```
[✓] 这题是正确的        当前：对
```

Ticked = true, unticked = false — nothing to type by hand.

### About the `答案` field

**Since 1.1.3 none of the three note types has a `答案` field** (an earlier build added one back by
mistake; it is gone again):

- **choice**: grading only looks at the `*` marks in `选项`.
- **true-false**: the checkbox writes the truth into a hidden marker at the end of `题目`
  (`太阳从西边升起。<!--iq-tf:错-->`) — invisible on the card, and it is restored automatically
  if it ever gets lost.
- **cloze**: the answers live in `{{c1::…}}` inside the question.

### Cloze questions

Use Anki's own cloze button or `Ctrl+Shift+C`:

```
中国的首都是{{c1::北京}}，最大的城市是{{c2::上海}}。
```

→ **two cards**. The same `c` number counts as one card; hints are supported: `{{c1::北京::中国首都}}`.

### 解题技巧: reuse the tip from cards with the same tag

Under the `解题技巧` field there is a **[⚡ 用同标签卡片的技巧]** button. Tag the card (e.g. `唐诗`),
click it, and the add-on looks for other cards that share a tag **and** already have a tip:

- a candidate list pops up (sorted by shared tags / recency) — pick one with **[用这条]**
- the list shows **only the tip text + the shared tags** (no question text), and
  **identical tips (whitespace/newlines ignored) appear once**, keeping the top-ranked card
- no tags on this card yet → it tells you to add one first

Tags you just typed in the tag box count too. Write the tip once per topic and reuse it on every card.

### 知识点: click a tag to jump to a related page after answering

The new `知识点` field takes **one line per tag**: `tag -> target`. After you answer, the card shows
a row of clickable tags (under `📚 相关知识点`) and **each tag jumps to its own target**:

```
唐诗 -> https://en.wikipedia.org/wiki/Quiet_Night_Thoughts   # click 唐诗 → browser
格律 -> anki:search:tag:唐诗                                  # click 格律 → browser search
```

Every line counts (not just the first); a repeated tag keeps its first line. The old "target only"
form still works. Web addresses open in your browser; anything else is treated as an **Anki search**
(`anki:search:…`, `anki:tag:…`, `anki:deck:…`, `anki:note:…`, or a bare `tag:唐诗`)
and opens in Anki's card browser. The tag row also appears on the answer side, and on
the phone web links stay clickable.

While authoring you don't have to type the format: under `知识点` there is a
**[🏷 配置标签链接]** button (collapsed by default). It lists the card's tags, one link box per
tag, each with **[试打开]** to test the link on the spot; **[🔄 刷新标签]** picks up tags you just
added to the tag box.

---

## Reviewing & grading rules

| Your answer | Result |
| --- | --- |
| wrong | **forced Again** — even if you press `3` or click "Good" in the bottom bar |
| "I don't know" | **forced Again** |
| correct | you choose **Hard / Good / Easy** |
| multiple choice, missed one but nothing wrong | optional: **Hard** only (setting `multi_partial_credit`) |

There is no separate "correct answer" line (since 1.1.5). Multiple choice / true-false cards rely on option
colours — green marks the option you should have picked, red marks the one you got wrong. Fill-in-the-blank
cards write the standard answer straight into the blank you typed in; when you were wrong, your own answer is
struck through in front of it (`Nanjing → Beijing`). The explanation (and the "解题技巧" field) still shows
before you continue, and that behaviour is configurable (`wrong_action`).

Blank answers are graded ignoring case, punctuation, spaces and full/half-width differences.

---

## On your phone

Cards sync as usual and **you can still self-test on the phone**:

1. Options are tappable, cloze blanks are fillable, and you get instant "✅ correct / ❌ wrong + explanation" — correctness is shown by the option colours and by the answer written into the blank
2. Tap **Show Answer** below, then rate with **1 Again / 2 Hard / 3 Good / 4 Easy**

How it knows: the desktop add-on injects `window.__ANKI_QUIZ_CONFIG__` into the card. On mobile / AnkiWeb that never happens, so the card switches to "phone mode" — it stops sending add-on messages, which also removes the old "buttons go grey and the card gets stuck" behaviour.

Authoring on the phone also works: fields are plain text — a leading `*` marks the correct option, and for
true-false cards you can type `<!--iq-tf:对-->` / `<!--iq-tf:错-->` at the end of the question.

---

## Settings & statistics

**Tools → 互动答题卡：设置与统计…**

| Setting | Default | Meaning |
| --- | --- | --- |
| 记录作答明细 | on | master switch for statistics |
| 明细保留天数 | 0 | 0 = keep forever |
| 答题时显示计时 | off | show a per-question timer in the corner |
| 多选漏选记「困难」 | off | allow "Hard" when you missed an option (nothing wrong) |
| 启动时自动检查更新 | on | check GitHub for a new version once a day |

Maintenance buttons: **[创建 / 更新题型模板]**, **[生成示例卡片]**, **[检查更新]**.
Everything else (reveal-on-wrong behaviour, option shuffling, punctuation handling, …) lives in **Tools → Add-ons → 互动答题卡 → Config**.

**Statistics tab**: a per-card table filterable by deck (children included) / note type / tag / time range / keyword, sortable by our "difficulty" (smoothed error rate `(wrong + 0.5) / (attempts + 1)`) or by Anki's own ease factor.

---

## Updates

- The add-on checks `version.txt` in this repo (once a day, and on demand from the settings window) and offers to download + install the new `.ankiaddon` for you.
- Turn it off with the `update_check` config option; then it never touches the network.
- Release notes live in [Releases](https://github.com/creeperboo/anki-interactive-quiz/releases).

Releasing (maintainer): edit the code → bump `version.txt` → `python 安装到Anki.py` → `git add -A && git commit -m "…" && git push` → create a release with the new package.

---

## Repository layout

```
源码/__init__.py            all Python logic (single file on purpose)
源码/assets/quiz.js         card-side script (grading, interaction, phone mode)
源码/assets/quiz.css        card-side styles
源码/assets/editor.js       editor widgets (option rows / true-false checkbox)
源码/tests/py-test.py       Python tests (fake aqt module)
源码/tests/dom-test.js      card-side tests (minimal DOM simulation)
源码/tests/editor-test.js   editor widget tests
源码/{manifest,config}.json add-on manifest and default config
源码/README.md              add-on documentation (Chinese, most detailed)
安装到Anki.py               one-click install + repackage
互动答题卡-操作指南.txt        plain-text manual for end users (Chinese)
项目说明.md / 对话记录.md     design decisions and gotchas (Chinese)
interactive_quiz.ankiaddon  ready-to-install package
version.txt                 version source for the update check
```

---

## Tests

```powershell
python 源码\tests\py-test.py       # Python side (~140 checks)

# The two JS suites need a JS runtime; wrap quiz.js / editor.js into a factory
# function and concatenate them with the test file (see 项目说明.md §7.1).
```

Current: Python 140 checks, card side 126, editor widgets 52 — all green.

---

## Known limitations

- Automatic grading only works on desktop; on mobile you rate yourself (scheduling still works normally)
- "Create / update note types" **overwrites** templates and styles of the three note types — back up your own edits first
- Statistics are stored in `user_files/stats.db` and do **not** sync through AnkiWeb

## License

No license file yet — if you want to reuse or redistribute this, open an issue and I'll add one.
