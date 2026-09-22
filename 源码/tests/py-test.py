"""用假的 aqt 模块加载插件，验证 Python 侧逻辑（含统计）。"""

import collections
import importlib.util
import json
import os
import shutil
import sys
import time
import types

ADDON_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

results = []


def ok(name, cond, extra=""):
    results.append(("PASS " if cond else "FAIL ") + name + ("" if cond else "  :: " + str(extra)))


def eq(name, got, want):
    ok(name, got == want, "got %r want %r" % (got, want))


# ------------------------------------------------------------------ 钩子桩
class NotifyHook:
    def __init__(self):
        self.fns = []

    def append(self, fn):
        self.fns.append(fn)

    def remove(self, fn):
        self.fns.remove(fn)

    def run(self, *args):
        return [fn(*args) for fn in list(self.fns)]


class FilterHook:
    def __init__(self):
        self.fns = []

    def append(self, fn):
        self.fns.append(fn)

    def remove(self, fn):
        self.fns.remove(fn)

    def run(self, value, *args):
        for fn in list(self.fns):
            value = fn(value, *args)
        return value


FILTER_HOOKS = {
    "webview_did_receive_js_message",
    "card_will_show",
    "reviewer_will_answer_card",
}
NOTIFY_HOOKS = [
    "reviewer_did_answer_card",
    "reviewer_did_show_question",
    "profile_did_open",
    "main_window_did_init",
    "editor_did_load_note",
    "editor_did_init_buttons",
]
HOOK_NAMES = sorted(FILTER_HOOKS | set(NOTIFY_HOOKS))

gui_hooks = types.ModuleType("aqt.gui_hooks")
for _name in HOOK_NAMES:
    setattr(gui_hooks, _name, FilterHook() if _name in FILTER_HOOKS else NotifyHook())


class FakeTrigger:
    def __init__(self):
        self.cbs = []

    def connect(self, fn):
        self.cbs.append(fn)

    def emit(self):
        for fn in self.cbs:
            fn(False)


class FakeAction:
    def __init__(self, text, parent=None):
        self.text = text
        self.triggered = FakeTrigger()


class FakeQTimer:
    @staticmethod
    def singleShot(_ms, fn):
        fn()


qt = types.ModuleType("aqt.qt")
qt.QAction = FakeAction
qt.QTimer = FakeQTimer

utils = types.ModuleType("aqt.utils")
utils.messages = []
utils.showInfo = lambda *a, **k: utils.messages.append(("info", a))
utils.tooltip = lambda *a, **k: utils.messages.append(("tip", a))
utils.askUser = lambda *a, **k: True


# ---------------------------------------------------------------- 假数据库
class FakeModel(dict):
    def __init__(self, name):
        super().__init__()
        self["name"] = name
        self["flds"] = []
        self["tmpls"] = []
        self["css"] = ""


class FakeModels:
    def __init__(self):
        self.store = {}

    def new(self, name):
        return FakeModel(name)

    def new_field(self, name):
        return {"name": name}

    def add_field(self, model, field):
        model["flds"].append(field)

    def new_template(self, name):
        return {"name": name, "qfmt": "", "afmt": ""}

    def add_template(self, model, template):
        model["tmpls"].append(template)

    def by_name(self, name):
        return self.store.get(name)

    def add(self, model):
        self.store[model["name"]] = model

    def save(self, model):
        self.store[model["name"]] = model


DeckNameId = collections.namedtuple("DeckNameId", "name id")


class FakeDecks:
    def __init__(self):
        self.names = {1: "默认", 2: "默认::子牌组", 3: "历史"}
        self.parents = {2: 1}
        self.by_name = {}

    def name(self, did):
        return self.names.get(did, "?")

    def children(self, did):
        return [k for k, v in self.parents.items() if v == did]

    def id(self, name):
        if name not in self.by_name:
            new_id = max(self.names) + 1
            self.by_name[name] = new_id
            self.names[new_id] = name
        return self.by_name[name]

    def all_names_and_ids(self):
        return [DeckNameId(n, i) for i, n in self.names.items()]

    def all_ids(self):
        return list(self.names)


class FakeTags:
    def all(self):
        return ["历史", "语文"]


class FakeDB:
    """只支持插件用到的那条查询。"""

    def __init__(self):
        self.note_tags = {11: ["历史"], 12: ["语文"], 13: ["历史", "语文"]}

    def list(self, sql, *args):
        if "FROM tags" in sql and args:
            tag = args[0]
            return [nid for nid, tags in self.note_tags.items() if tag in tags]
        return []


class FakeNoteData:
    def __init__(self, question):
        self.fields = [question]

    def __getitem__(self, key):
        if key == "题目":
            return self.fields[0]
        raise KeyError(key)


class FakeCard:
    def __init__(self, cid, nid=None, did=1, factor=2500):
        self.id = cid
        self.nid = cid if nid is None else nid
        self.did = did
        self.factor = factor
        self._question = "第 %s 题" % cid

    def note(self):
        return FakeNoteData(self._question)


class FakeNote:
    def __init__(self):
        self.fields = {}
        self.tags = []

    def __setitem__(self, key, value):
        self.fields[key] = value


class FakeCol:
    def __init__(self):
        self.models = FakeModels()
        self.decks = FakeDecks()
        self.tags = FakeTags()
        self.db = FakeDB()
        self.added = []
        self.cards = {}

    def new_note(self, nt):
        return FakeNote()

    def add_note(self, note, deck_id):
        self.added.append((note, deck_id))

    def get_card(self, cid):
        if cid not in self.cards:
            self.cards[cid] = FakeCard(cid)
        return self.cards[cid]


class FakeAddonManager:
    def __init__(self):
        self.cfg = {}
        self.written = []

    def getConfig(self, _name):
        return dict(self.cfg)

    def writeConfig(self, _name, cfg):
        self.cfg = dict(cfg)
        self.written.append(dict(cfg))


class FakeProfileManager:
    name = "测试配置"


class FakeReviewer:
    def __init__(self, card):
        self.card = card
        self.answered = []
        self.bottom = types.SimpleNamespace(bottomWeb=None)

    def _answerCard(self, ease):
        self.answered.append(ease)


class FakeMenu:
    def __init__(self):
        self.actions = []

    def addAction(self, action):
        self.actions.append(action)


class FakeForm:
    def __init__(self):
        self.menuTools = FakeMenu()


class FakeMW:
    def __init__(self):
        self.addonManager = FakeAddonManager()
        self.col = FakeCol()
        self.pm = FakeProfileManager()
        self.reviewer = None
        self.form = FakeForm()


mw = FakeMW()

aqt = types.ModuleType("aqt")
aqt.gui_hooks = gui_hooks
aqt.mw = mw
aqt.qt = qt
aqt.utils = utils
sys.modules["aqt"] = aqt
sys.modules["aqt.gui_hooks"] = gui_hooks
sys.modules["aqt.qt"] = qt
sys.modules["aqt.utils"] = utils


# ------------------------------------------------------------------ 加载
spec = importlib.util.spec_from_file_location("interactive_quiz", os.path.join(ADDON_DIR, "__init__.py"))
mod = importlib.util.module_from_spec(spec)
sys.modules["interactive_quiz"] = mod
spec.loader.exec_module(mod)

if os.path.isdir(mod.USER_FILES_DIR):
    shutil.rmtree(mod.USER_FILES_DIR)

hooks = {name: getattr(gui_hooks, name) for name in HOOK_NAMES}
hooks["main_window_did_init"].run()
hooks["profile_did_open"].run(None)

# 测试里绝不许联网：把更新仓库改成占位符，启动时那次「悄悄检查更新」就会直接返回
mod.UPDATE_REPO = "TODO/no-network-in-tests"


# ------------------------------------------------------------------ 题型
ok("P1 ensure_choice_note_type 成功", mod.ensure_choice_note_type() is True)
nt = mw.col.models.by_name(mod.CHOICE_NOTE_TYPE_NAME)
ok("P2 题型已建", nt is not None)
eq("P3 字段齐全", [f["name"] for f in nt["flds"]], mod.CHOICE_FIELD_NAMES)
eq("P4 只有一张卡片模板", len(nt["tmpls"]), 1)
qfmt = nt["tmpls"][0]["qfmt"]
afmt = nt["tmpls"][0]["afmt"]
ok("P5 正面含询问区", 'id="iq-question"' in qfmt)
ok(
    "P6 正面引用字段",
    all(("{{%s}}" % name) in qfmt for name in mod.CHOICE_FIELD_NAMES),
)
ok("P7 JS 已内联", "__IQ_CORE" in qfmt and "__IQ_CORE" in afmt)
ok("P8 占位符已替换", "{{__IQ_JS__}}" not in qfmt and "{{__IQ_JS__}}" not in afmt)
ok("P9 配置注入点存在", mod.CONFIG_MARKER in qfmt)
ok("P10 背面有答案区", 'id="iq-answer-list"' in afmt)
ok("P11 样式已写入", "iq-card" in nt["css"] and len(nt["css"]) > 500)
mod.ensure_choice_note_type()
eq("P12 字段不重复", len(nt["flds"]), len(mod.CHOICE_FIELD_NAMES))
eq("P13 模板不重复", len(nt["tmpls"]), 1)

# ------------------------------------------------------------------ 配置注入
text = "hello " + mod.CONFIG_MARKER + " world"
out = mod.on_card_will_show(text, None, "reviewQuestion")
ok("P14 注入脚本", "window.__ANKI_QUIZ_CONFIG__" in out)
ok("P15 标记已消失", mod.CONFIG_MARKER not in out)
raw = out.split("window.__ANKI_QUIZ_CONFIG__ = ", 1)[1].split(";", 1)[0]
payload = json.loads(raw)
ok("P16 注入的是合法 JSON", isinstance(payload, dict))
eq("P17 新配置项也在里面", sorted(k for k in payload if k in mod.DEFAULTS), sorted(mod.DEFAULTS))
eq("P18 没有标记就原样返回", mod.on_card_will_show("no marker", None, "reviewQuestion"), "no marker")

# ------------------------------------------------------------------ 评级
mw.reviewer = FakeReviewer(FakeCard(101))
handled = hooks["webview_did_receive_js_message"].run((False, None), "iq:reset", mw.reviewer)
eq("P19 reset 被接管", handled, (True, None))
eq("P20 别的消息不接管", hooks["webview_did_receive_js_message"].run((False, None), "zzz", mw.reviewer), (False, None))

hooks["webview_did_receive_js_message"].run((False, None), "iq:grade:3", mw.reviewer)
eq("P21 答对用良好", mw.reviewer.answered, [3])

mw.reviewer = FakeReviewer(FakeCard(102))
hooks["webview_did_receive_js_message"].run((False, None), "iq:wrong", mw.reviewer)
eq("P22 答错标记为只能重来", mod._forced_ease.get(102), 1)
eq("P23 过滤器把良好压成重来", hooks["reviewer_will_answer_card"].run((True, 3), mw.reviewer, mw.reviewer.card), (True, 1))
hooks["webview_did_receive_js_message"].run((False, None), "iq:grade:3", mw.reviewer)
eq("P24 答错后按良好也变重来", mw.reviewer.answered, [1])
hooks["reviewer_did_answer_card"].run(mw.reviewer, mw.reviewer.card, 1)
eq("P25 答完后清空标记", 102 in mod._forced_ease, False)

# 漏选：最多只能困难
mw.reviewer = FakeReviewer(FakeCard(103))
hooks["webview_did_receive_js_message"].run((False, None), "iq:partial", mw.reviewer)
eq("P26 漏选上限是困难", mod._forced_ease.get(103), 2)
eq("P27 漏选按简单被压成困难", hooks["reviewer_will_answer_card"].run((True, 4), mw.reviewer, mw.reviewer.card), (True, 2))
eq("P28 漏选按重来仍然允许", hooks["reviewer_will_answer_card"].run((True, 1), mw.reviewer, mw.reviewer.card), (True, 1))
mw.reviewer = FakeReviewer(FakeCard(104))
hooks["webview_did_receive_js_message"].run((False, None), "iq:wrong", mw.reviewer)
hooks["webview_did_receive_js_message"].run((False, None), "iq:partial", mw.reviewer)
eq("P29 答错优先于漏选", mod._forced_ease.get(104), 1)

# 其它分支
mw.reviewer = FakeReviewer(FakeCard(105))
hooks["webview_did_receive_js_message"].run((False, None), "iq:grade:9", mw.reviewer)
eq("P30 非法评级被忽略", mw.reviewer.answered, [])
hooks["webview_did_receive_js_message"].run((False, None), "iq:grade:2", mw.reviewer)
hooks["webview_did_receive_js_message"].run((False, None), "iq:grade:2", mw.reviewer)
eq("P31 重复点击只评一次", mw.reviewer.answered, [2])
mw.reviewer = FakeReviewer(FakeCard(106))
hooks["webview_did_receive_js_message"].run((False, None), "iq:grade:4", mw.reviewer)
eq("P32 新卡片正常评级", mw.reviewer.answered, [4])
mw.reviewer = None
eq("P33 无复习界面也安全", hooks["webview_did_receive_js_message"].run((False, None), "iq:grade:3", None), (True, None))


class NoAnswerReviewer(FakeReviewer):
    def __init__(self, card):
        super().__init__(card)
        self._answerCard = None
        self.bottom = types.SimpleNamespace(bottomWeb=types.SimpleNamespace(evals=[], eval=lambda js: self.bottom.bottomWeb.evals.append(js)))


mw.reviewer = NoAnswerReviewer(FakeCard(107))
hooks["webview_did_receive_js_message"].run((False, None), "iq:grade:3", mw.reviewer)
eq("P34 _answerCard 缺失时回退底部按钮", mw.reviewer.bottom.bottomWeb.evals, ["pycmd('ease3')"])

# ------------------------------------------------------------------ 统计
eq("P35 初始没有任何记录", mod.count_answers(), 0)


def answer(cid, nid, did, mode, correct, dontknow, ms, ease, partial=0):
    card = mw.col.get_card(cid)
    card.nid = nid
    card.did = did
    mw.reviewer = FakeReviewer(card)
    hooks["webview_did_receive_js_message"].run((False, None), "iq:reset", mw.reviewer)
    hooks["webview_did_receive_js_message"].run(
        (False, None),
        "iq:result:%s:%d:%d:%d:%d" % (mode, correct, dontknow, ms, partial),
        mw.reviewer,
    )
    hooks["reviewer_did_answer_card"].run(mw.reviewer, card, ease)


answer(201, 11, 1, "single", 1, 0, 3000, 3)          # 对 1 次
answer(202, 12, 1, "single", 0, 0, 8000, 1)          # 错 1 次
answer(202, 12, 1, "single", 0, 0, 6000, 1)          # 错 2 次
answer(203, 13, 2, "multi", 1, 0, 12000, 3)          # 多选对
answer(203, 13, 2, "multi", 0, 1, 4000, 1)           # 不知道
answer(204, 11, 3, "fill", 1, 0, 5000, 2)            # 填空对

eq("P36 记录条数", mod.count_answers(), 6)

rows, summary = mod.query_stats("测试配置", 0)
eq("P37 覆盖 4 张卡片", len(rows), 4)
eq("P38 总作答 6 次", summary["attempts"], 6)
eq("P39 正确 3 次", summary["rights"], 3)
eq("P40 平均用时", summary["avg_ms"], int((3000 + 8000 + 6000 + 12000 + 4000 + 5000) / 6))
eq("P41 按难度排序，最难的排第一", rows[0]["cid"], 202)
ok("P42 难度单调不增", all(rows[i]["difficulty"] >= rows[i + 1]["difficulty"] for i in range(len(rows) - 1)))
eq("P43 有记录的卡片总数", summary["total_cards"], 4)

row202 = [r for r in rows if r["cid"] == 202][0]
eq("P44 作答/答错次数", (row202["attempts"], row202["errors"], row202["rights"]), (2, 2, 0))
ok("P45 记录里带了题干", row202["q"].startswith("第 202 题"), row202["q"])
eq("P46 记录里带了牌组名", row202["deck"], "默认")

# 题型筛选
rows, summary = mod.query_stats("测试配置", 0, mode="multi")
eq("P47 只筛多选", sorted(r["cid"] for r in rows), [203])
eq("P48 多选作答次数", summary["attempts"], 2)

# 牌组筛选（含子牌组）
deck_ids = mod._deck_ids_with_children(1)
eq("P49 子牌组被包含", sorted(deck_ids), [1, 2])
rows, summary = mod.query_stats("测试配置", 0, deck_ids=deck_ids)
eq("P50 牌组筛选", sorted(r["cid"] for r in rows), [201, 202, 203])

# 标签筛选
note_ids = mod._note_ids_for_tag("语文")
eq("P51 标签 → 笔记", sorted(note_ids), [12, 13])
rows, _ = mod.query_stats("测试配置", 0, note_ids=note_ids)
eq("P52 标签筛选", sorted(r["cid"] for r in rows), [202, 203])

# 关键词
rows, _ = mod.query_stats("测试配置", 0, keyword="第 204")
eq("P53 关键词筛选", [r["cid"] for r in rows], [204])

# 组合
rows, _ = mod.query_stats("测试配置", 0, mode="single", deck_ids={1}, note_ids={12})
eq("P54 组合筛选", [r["cid"] for r in rows], [202])

# 时间范围
rows, _ = mod.query_stats("测试配置", int(time.time()) + 3600)
eq("P55 未来时间没有数据", len(rows), 0)

# 其它配置隔离
rows, _ = mod.query_stats("别的配置", 0)
eq("P56 配置之间互不影响", len(rows), 0)

# Anki 难易度
mod.annotate_anki_ease(rows=[])
sample = mod.query_stats("测试配置", 0)[0]
mod.annotate_anki_ease(sample)
ok("P57 Anki 难易度读出来了", any(r.get("factor") is not None for r in sample))

# 关闭记录
cw = mw.addonManager.cfg
mw.addonManager.cfg = dict(cw, stats_enabled=False)
mod._config_cache = None
answer(205, 13, 3, "tf", 1, 0, 1000, 3)
eq("P58 关掉后不再记录", mod.count_answers(), 6)
mw.addonManager.cfg = cw
mod._config_cache = None

# 保留天数
mw.addonManager.cfg = dict(cw, stats_retention_days=1)
mod._config_cache = None
conn = mod._open_stats_db()
conn.execute("UPDATE answers SET ts = ts - 86400 * 30")
conn.commit()
conn.close()
mod.purge_old_stats()
eq("P59 过期记录被清理", mod.count_answers(), 0)
mw.addonManager.cfg = cw
mod._config_cache = None

# 清空
answer(206, 11, 1, "single", 1, 0, 1000, 3)
eq("P60 清空前有记录", mod.count_answers(), 1)
removed = mod.clear_stats()
eq("P61 清空返回删除条数", removed, 1)
eq("P62 清空后为 0", mod.count_answers(), 0)

# ------------------------------------------------------------------ 其它
count = mod.create_samples()
eq("P63 生成 3 张示例（选择 / 判断 / 原生填空）", count, 3)
eq("P64 写入了卡组", len(mw.col.added), 3)
ok("P65 示例填了内容", len(mw.col.added[0][0].fields.get("题目", "")) > 0)

eq("P66 工具菜单只有一项", len(mw.form.menuTools.actions), 1)
ok("P67 菜单项名字", "设置与统计" in mw.form.menuTools.actions[0].text, mw.form.menuTools.actions[0].text)

# 保存设置
before = len(mw.addonManager.written)
cfg = mod.get_config()
cfg["show_timer"] = True
ok("P68 保存设置成功", mod.save_config(cfg))
ok("P69 writeConfig 被调用", len(mw.addonManager.written) > before)
eq("P70 保存后能读回", mod.get_config()["show_timer"], True)

# ------------------------------------------------------------------ 解题技巧字段
ok("P71 字段表里有解题技巧", "解题技巧" in [f["name"] for f in nt["flds"]])
ok("P72 正面隐藏区带解题技巧", 'id="iq-raw-tips"' in qfmt and "{{解题技巧}}" in qfmt)
ok("P73 背面有解题技巧区块", 'id="iq-tips"' in afmt and "{{解题技巧}}" in afmt)
ok(
    "P74 示例都填了解题技巧",
    all(
        s.get("解题技巧")
        for s in (mod._SAMPLE_CHOICE, mod._SAMPLE_TF, mod._CLOZE_SAMPLE)
    ),
)
ok(
    "P75 技巧字段名不会和别的字段撞",
    len({f["name"] for f in nt["flds"]}) == len(nt["flds"]),
)

# ------------------------------------------------------------------ 原生填空（cloze）题型
ok("P76 填空题型已建立", mw.col.models.by_name(mod.CLOZE_NOTE_TYPE_NAME) is not None)
ntc = mw.col.models.by_name(mod.CLOZE_NOTE_TYPE_NAME)
eq("P77 填空题型是 cloze 类型", int(ntc.get("type", -1)), 1)
eq("P78 填空字段", [f["name"] for f in ntc["flds"]], mod.CLOZE_FIELD_NAMES)
eq("P79 填空只有一个模板", len(ntc["tmpls"]), 1)
cfmt = ntc["tmpls"][0]["qfmt"]
cafmt = ntc["tmpls"][0]["afmt"]
ok("P80 正面用 cloze 过滤器", "{{cloze:题目}}" in cfmt)
ok("P81 背面用 cloze 过滤器", "{{cloze:题目}}" in cafmt)
ok("P82 正面带 cloze 标记", 'data-iq-cloze="1"' in cfmt and mod.CLOZE_MARKER in cfmt)
ok("P83 背面有解题技巧区", 'id="iq-tips"' in cafmt and "{{解题技巧}}" in cafmt)
ok("P84 填空模板内联了 JS", "__IQ_CORE" in cfmt and "{{__IQ_JS__}}" not in cfmt)
ok("P85 填空模板带配置注入点", mod.CONFIG_MARKER in cfmt)
mod.ensure_cloze_note_type()
eq("P86 重跑不重复建字段", len(ntc["flds"]), len(mod.CLOZE_FIELD_NAMES))
eq("P87 重跑不重复建模板", len(ntc["tmpls"]), 1)


class FakeClozeNote:
    def __init__(self, text):
        self.text = text

    def __getitem__(self, key):
        if key == "题目":
            return self.text
        raise KeyError(key)


class FakeCardWithNote:
    def __init__(self, note, ord_=0):
        self._note = note
        self.ord = ord_

    def note(self):
        return self._note


eq(
    "P88 解析挖空答案",
    mod._cloze_answers(FakeClozeNote("作者{{c1::李白}}，{{c2::唐}}代。{{c1::李白}}")),
    {"1": ["李白", "李白"], "2": ["唐"]},
)
eq(
    "P89 挖空带提示时只取答案",
    mod._cloze_answers(FakeClozeNote("{{c1::北京::提示}}是首都")),
    {"1": ["北京"]},
)
eq(
    "P90 没有挖空就是空表",
    mod._cloze_answers(FakeClozeNote("普通题目")),
    {},
)

out = mod.on_card_will_show("a " + mod.CONFIG_MARKER + " b " + mod.CLOZE_MARKER + " c", None, "reviewQuestion")
ok("P91 注入 cloze 兜底数据", "window.__ANKI_QUIZ_CLOZE__" in out and mod.CLOZE_MARKER not in out)
ok(
    "P92 兜底数据是合法 JSON",
    isinstance(json.loads(out.split("window.__ANKI_QUIZ_CLOZE__ = ", 1)[1].split(";", 1)[0]), dict),
)
out2 = mod.on_card_will_show(
    "x " + mod.CONFIG_MARKER + " y " + mod.CLOZE_MARKER,
    FakeCardWithNote(FakeClozeNote("作者{{c1::李白}}，{{c2::唐}}代。"), 1),
    "reviewQuestion",
)
payload2 = json.loads(out2.split("window.__ANKI_QUIZ_CLOZE__ = ", 1)[1].split(";", 1)[0])
eq("P93 兜底数据带答案表", payload2.get("texts"), {"1": ["李白"], "2": ["唐"]})
eq("P94 兜底数据带卡片序号", payload2.get("ord"), 1)
ok(
    "P95 没有 cloze 标记就不注入",
    "window.__ANKI_QUIZ_CLOZE__" not in mod.on_card_will_show(mod.CONFIG_MARKER, None, "x"),
)

# ------------------------------------------------------------------ 选择题 / 判断题题型
ok("P96 选择题题型已建立", mw.col.models.by_name(mod.CHOICE_NOTE_TYPE_NAME) is not None)
nt_choice = mw.col.models.by_name(mod.CHOICE_NOTE_TYPE_NAME)
eq("P97 选择题字段", [f["name"] for f in nt_choice["flds"]], mod.CHOICE_FIELD_NAMES)
ok("P98 选择题没有「类型」字段", "类型" not in [f["name"] for f in nt_choice["flds"]])
eq("P99 选择题模板名", nt_choice["tmpls"][0]["name"], mod.CHOICE_CARD_NAME)
ok("P100 选择题模板引用字段", "{{选项}}" in nt_choice["tmpls"][0]["qfmt"])

ok("P101 判断题题型已建立", mw.col.models.by_name(mod.TF_NOTE_TYPE_NAME) is not None)
nt_tf = mw.col.models.by_name(mod.TF_NOTE_TYPE_NAME)
eq("P102 判断题字段", [f["name"] for f in nt_tf["flds"]], mod.TF_FIELD_NAMES)
ok("P103 判断题没有选项字段", "选项" not in [f["name"] for f in nt_tf["flds"]])
ok("P104 判断题模板引用答案", "{{答案}}" in nt_tf["tmpls"][0]["qfmt"])

eq("P105 选择题里没有「类型」字段", "类型" in [f["name"] for f in nt["flds"]], False)
eq("P106 选择题字段表", [f["name"] for f in nt["flds"]], mod.CHOICE_FIELD_NAMES)

# ------------------------------------------------------------------ 通用题型已废弃
ok("P106a 不再创建通用题型", mod.NOTE_TYPE_NAME not in mod.ensure_all_note_types())
eq("P106b 管理的题型只有 3 个", len(mod.ensure_all_note_types()), 3)


class FakeNoteWithTags:
    def __init__(self, tags):
        self.tags = tags


class FakeLegacyCol:
    """只给 cleanup_legacy_note_type 用：能查笔记、能删题型。"""

    def __init__(self, note_tags, has_type=True):
        self.note_tags = note_tags
        self.removed = []
        self.models = self
        self._has_type = has_type

    def by_name(self, name):
        return {"id": 999, "name": name} if (self._has_type and name == mod.NOTE_TYPE_NAME) else None

    def find_notes(self, query):
        return list(self.note_tags.keys())

    def get_note(self, nid):
        return FakeNoteWithTags(self.note_tags[nid])

    def remove(self, ntid):
        self.removed.append(ntid)


fake_col = FakeLegacyCol({1: ["互动答题卡示例"], 2: ["互动答题卡示例", "别的"]})
saved_col = mw.col
mw.col = fake_col
eq("P106c 只含示例时会删掉通用题型", mod.cleanup_legacy_note_type(), True)
eq("P106d 删的是那个题型", fake_col.removed, [999])

fake_col2 = FakeLegacyCol({1: ["互动答题卡示例"], 2: ["自己写的笔记"]})
mw.col = fake_col2
eq("P106e 有非示例笔记就不删", mod.cleanup_legacy_note_type(), False)
eq("P106f 没动任何题型", fake_col2.removed, [])
mw.col = saved_col

# ------------------------------------------------------------------ 编辑器助手
class FakeWeb:
    def __init__(self):
        self.evals = []
        self.callbacks = []

    def eval(self, js):
        self.evals.append(js)

    def evalWithCallback(self, js, cb):
        self.evals.append(js)
        self.callbacks.append(cb)
        cb('{"题目": "Q"}')


class FakeEditorNote:
    def __init__(self, name, fields):
        self.model_data = {"name": name, "flds": [{"name": f} for f in fields]}
        self.values = {f: "" for f in fields}

    def model(self):
        return self.model_data

    def __getitem__(self, key):
        return self.values.get(key, "")

    def __setitem__(self, key, value):
        self.values[key] = value


class FakeEditor:
    def __init__(self, name=None, fields=None):
        self.note = FakeEditorNote(name or mod.CHOICE_NOTE_TYPE_NAME, fields or mod.CHOICE_FIELD_NAMES)
        self.web = FakeWeb()
        self.parentWindow = None


ed_choice = FakeEditor()
eq("P113 选择题编辑器模式", mod._editor_mode(ed_choice), "choice")
eq("P114 判断题编辑器模式", mod._editor_mode(FakeEditor(mod.TF_NOTE_TYPE_NAME, mod.TF_FIELD_NAMES)), "tf")
eq("P115 别的题型不插手", mod._editor_mode(FakeEditor("Lapis", ["A", "B"])), "")

mod.on_editor_did_load_note(ed_choice)
ok("P116 注入了编辑器助手脚本", len(ed_choice.web.evals) == 1)
ok("P117 注入内容带安装调用", "__IQ_EDITOR_INSTALL__" in ed_choice.web.evals[0])
ok("P118 注入内容带字段表", "\\u9009\\u9879" in ed_choice.web.evals[0] or "选项" in ed_choice.web.evals[0])

ed_other = FakeEditor("Lapis", ["A", "B"])
mod.on_editor_did_load_note(ed_other)
ok("P119 别的题型也注入但模式为空", '"mode": ""' in ed_other.web.evals[0])

buttons = []
eq("P120 不再往工具栏塞按钮", mod.__dict__.get("on_editor_did_init_buttons"), None)
before_evals = len(ed_choice.web.evals)
hooks["webview_did_receive_js_message"].run((False, None), "iq:editor:add-option", ed_choice)
eq("P121 没人处理的编辑器消息不会产生动作", len(ed_choice.web.evals), before_evals)
ok("P122 选择题字段里没有「答案」", "答案" not in mod.CHOICE_FIELD_NAMES)
ok("P123 判断题仍然有「答案」字段（存对/错）", "答案" in mod.TF_FIELD_NAMES)

# ------------------------------------------------------------------ 从 GitHub 检查更新
ok("P128 版本号能解析", mod._version_tuple("1.2.3") == (1, 2, 3))
ok("P129 认不出的版本号当 0", mod._version_tuple("") == (0,))
ok("P130 新版本判定", mod.is_newer("1.0.1", "1.0.0") is True)
ok("P131 同版本不算新", mod.is_newer("1.0.0", "1.0.0") is False)
ok("P132 旧版本不算新", mod.is_newer("0.9.9", "1.0.0") is False)
ok("P133 2.0 比 1.9 新", mod.is_newer("2.0", "1.9.9") is True)
ok("P134 本地版本号存在", isinstance(mod.__version__, str) and mod.__version__)
ok("P135 默认开启启动检查", mod.DEFAULTS.get("update_check") is True)

_saved_repo = mod.UPDATE_REPO
mod.UPDATE_REPO = "TODO/anki-interactive-quiz"
eq("P136 没配置仓库时不联网", mod.fetch_latest_version(), "")
mod.UPDATE_REPO = "someone/some-repo"
ok("P137 配置好之后才认为可用", mod._repo_ready() is True)
mod.UPDATE_REPO = _saved_repo

_saved_newer = mod.check_for_update
mod.UPDATE_REPO = "someone/some-repo"
try:
    mod.UPDATE_STATE_PATH.unlink()  # 清掉「一天只查一次」的计时，保证这一项可复现
except Exception:
    pass
mw.addonManager.cfg = {"update_check": False}
mod._config_cache = None
_called = {"n": 0}
mod.check_for_update = lambda silent=False: _called.__setitem__("n", _called["n"] + 1)
mod.maybe_check_update_on_start()
eq("P138 关掉开关就不查", _called["n"], 0)
mw.addonManager.cfg = {"update_check": True}
mod._config_cache = None
mod.maybe_check_update_on_start()
eq("P139 开着开关会查一次", _called["n"], 1)
mw.addonManager.cfg = cw
mod._config_cache = None
mod.check_for_update = _saved_newer
mod.UPDATE_REPO = _saved_repo

# ------------------------------------------------------------------ 更新提示里的 Release 链接
mod.UPDATE_REPO = "someone/some-repo"
eq(
    "P140 Release 链接自动补 v 前缀",
    mod.update_release_url("1.0.2"),
    "https://github.com/someone/some-repo/releases/tag/v1.0.2",
)
ok("P141 已经是 v 前缀就不重复加", mod.update_release_url("v1.2.0").endswith("/tag/v1.2.0"))
_prompt = mod.update_prompt_text("9.9.9")
ok("P142 提示里有新版本号", "9.9.9" in _prompt, _prompt)
ok("P143 提示里有当前版本号", mod.__version__ in _prompt, _prompt)
ok("P144 提示里有 Release 链接", "/releases/tag/v9.9.9" in _prompt, _prompt)
ok("P145 提示里问要不要装", "现在下载并安装吗" in _prompt, _prompt)
mod.UPDATE_REPO = _saved_repo

print("\n".join(results))
print("----")
print(
    "PASS=%d FAIL=%d"
    % (sum(1 for r in results if r.startswith("PASS")), sum(1 for r in results if r.startswith("FAIL")))
)
