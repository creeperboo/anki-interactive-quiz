"""
互动答题卡 —— Anki 插件

在复习界面直接作答：

* 选择题（单选 / 多选）
* 判断题
* 填空题

答错或点「不知道」一律记为 **重来**；答对后才能自己选 困难 / 良好 / 简单。
工具菜单里的「互动答题卡：设置与统计…」可以改设置、看统计。
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

from aqt import gui_hooks, mw
from aqt.qt import QAction, QTimer
from aqt.utils import askUser, showInfo, tooltip

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------

ADDON_DIR = Path(__file__).resolve().parent
ASSETS_DIR = ADDON_DIR / "assets"
USER_FILES_DIR = ADDON_DIR / "user_files"
STATS_DB_PATH = USER_FILES_DIR / "stats.db"

# --------------------------------------------------------------------------
# 版本 & 从 GitHub 检查更新
# --------------------------------------------------------------------------

__version__ = "1.0.0"

# 更新检查从这里拉：https://github.com/creeperboo/anki-interactive-quiz
UPDATE_REPO = "creeperboo/anki-interactive-quiz"
UPDATE_BRANCH = "main"
VERSION_URL = f"https://raw.githubusercontent.com/{UPDATE_REPO}/{UPDATE_BRANCH}/version.txt"
PACKAGE_URL = (
    f"https://raw.githubusercontent.com/{UPDATE_REPO}/{UPDATE_BRANCH}/interactive_quiz.ankiaddon"
)
UPDATE_STATE_PATH = USER_FILES_DIR / "update.json"
UPDATE_INTERVAL_SECONDS = 86400  # 启动时最多一天查一次

NOTE_TYPE_NAME = "互动答题卡"
CARD_NAME = "答题"
# 注意：新加的字段一律排在最后（Anki 的 add_field 只能往后追加），
# 这样新老用户的字段顺序一致，不会因为重排字段而打乱已有笔记的数据。
# 「类型」字段已废弃（每个题型各自独立，不再靠字段猜题型）；老用户的这个字段会被自动删掉
FIELD_NAMES = ["题目", "选项", "答案", "解析", "来源", "解题技巧"]
SAMPLE_DECK = "答题卡示例"
CONFIG_MARKER = "/*ANKI_QUIZ_CONFIG_MARKER*/"

# 每个题型各自独立，字段也各自独立
CHOICE_NOTE_TYPE_NAME = "互动答题卡·选择题"
CHOICE_CARD_NAME = "选择"
# 选择题的正误直接标在「选项」行里，不需要「答案」字段
CHOICE_FIELD_NAMES = ["题目", "选项", "解析", "解题技巧", "来源"]

TF_NOTE_TYPE_NAME = "互动答题卡·判断题"
TF_CARD_NAME = "判断"
# 判断题的「答案」字段还在（勾选框要往里写 对/错），只是编辑器里被藏起来
TF_FIELD_NAMES = ["题目", "答案", "解析", "解题技巧", "来源"]

# 原生填空（cloze）题型：跟 Anki 自带的「填空题」一样，题目里写 {{c1::答案}}，
# 一个 c 号出一张卡；编辑器里也能直接用挖空按钮 / Ctrl+Shift+C。
CLOZE_NOTE_TYPE_NAME = "互动答题卡·填空"
CLOZE_CARD_NAME = "填空"
CLOZE_FIELD_NAMES = ["题目", "解析", "解题技巧", "来源"]
CLOZE_MARKER = "/*ANKI_QUIZ_CLOZE_MARKER*/"

MODE_ORDER = ["single", "multi", "tf", "fill"]
MODE_LABELS = {
    "single": "单选",
    "multi": "多选",
    "tf": "判断",
    "fill": "填空",
    "unknown": "未知",
}

DEFAULTS: dict[str, Any] = {
    "wrong_action": "reveal",
    "auto_continue_seconds": 0,
    "shuffle_options": False,
    "auto_submit_single_choice": True,
    "fill_ignore_case": True,
    "fill_ignore_punctuation": True,
    "reveal_explanation_on_correct": True,
    "show_source": True,
    "auto_create_note_type": True,
    # 下面四项能在「设置与统计」窗口里改
    "stats_enabled": True,
    "stats_retention_days": 0,
    "show_timer": False,
    "multi_partial_credit": False,
    "update_check": True,
}

# 已经在答题界面作答、但还没被评级的卡片：卡片 id -> 允许的最高评级
_forced_ease: dict[int, int] = {}
# 卡片端报上来的本题结果
_pending_result: dict[int, dict[str, Any]] = {}
# 防止一次点击被重复评级
_recent_grade: dict[int, float] = {}

_menu_installed = False
_asset_cache: dict[str, str] = {}
_config_cache: Optional[dict[str, Any]] = None
_config_cached_at = 0.0
_CONFIG_TTL = 1.0


# --------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------


def get_config() -> dict[str, Any]:
    global _config_cache, _config_cached_at
    now = time.monotonic()
    if _config_cache is not None and (now - _config_cached_at) < _CONFIG_TTL:
        return _config_cache

    cfg: dict[str, Any] = dict(DEFAULTS)
    stored: Any = None
    try:
        stored = mw.addonManager.getConfig(__name__)
    except Exception:
        stored = None
    if not isinstance(stored, dict):
        # 有些情况下 __name__ 和插件文件夹名不一致，再试一次
        try:
            stored = mw.addonManager.getConfig(ADDON_DIR.name)
        except Exception:
            stored = None
    if isinstance(stored, dict):
        cfg.update(stored)

    _config_cache = cfg
    _config_cached_at = now
    return cfg


def save_config(cfg: dict[str, Any]) -> bool:
    global _config_cache, _config_cached_at
    try:
        mw.addonManager.writeConfig(__name__, cfg)
    except Exception:
        try:
            mw.addonManager.writeConfig(ADDON_DIR.name, cfg)
        except Exception as exc:
            showInfo(f"互动答题卡：保存设置失败\n{exc}")
            return False
    _config_cache = None
    _config_cached_at = 0.0
    return True


# --------------------------------------------------------------------------
# 卡片模板
# --------------------------------------------------------------------------


def _read_asset(name: str) -> str:
    if name not in _asset_cache:
        try:
            _asset_cache[name] = (ASSETS_DIR / name).read_text(encoding="utf-8")
        except Exception as exc:  # pragma: no cover
            print(f"[互动答题卡] 读取 {name} 失败: {exc}")
            _asset_cache[name] = ""
    return _asset_cache[name]


# 字段名 -> 隐藏区里的 id，卡片端脚本按这些 id 读原始内容
_RAW_IDS = {
    "选项": "iq-raw-options",
    "答案": "iq-raw-answer",
    "解析": "iq-raw-explanation",
    "解题技巧": "iq-raw-tips",
    "来源": "iq-raw-source",
    "类型": "iq-raw-type",
}


def _raw_block(field_names: list[str]) -> str:
    """把字段原样塞进一个隐藏 div，卡片端脚本从里面读内容。"""
    lines = ['<div id="iq-raw" hidden="hidden">']
    for name in field_names:
        raw_id = _RAW_IDS.get(name)
        if raw_id:
            lines.append('  <div id="%s">{{%s}}</div>' % (raw_id, name))
    lines.append("</div>")
    return "\n".join(lines)


def _card_bodies(field_names: list[str], cloze: bool = False) -> tuple[str, str]:
    """正面 / 背面模板。所有题型共用同一套结构，只是字段和「题目」的渲染方式不同。

    原生填空用 Anki 自己的 {{cloze:题目}}：当前空位渲染成
    <span class="cloze" data-cloze="答案" data-ordinal="1">[...]</span>，
    其它空位渲染成 <span class="cloze-inactive">正文</span>。
    """
    question = "{{cloze:题目}}" if cloze else "{{题目}}"
    attrs = ' data-iq-cloze="1"' if cloze else ""
    cloze_script = ("<script>%s</script>" % CLOZE_MARKER) if cloze else ""
    raw = _raw_block(field_names)
    front = (
        '<div class="iq-card" id="iq-card" data-side="front"%s>\n'
        '  <div class="iq-question" id="iq-question">%s</div>\n'
        '  <div class="iq-options" id="iq-options"></div>\n'
        '  <div class="iq-controls" id="iq-controls"></div>\n'
        '  <div class="iq-feedback" id="iq-feedback" hidden="hidden"></div>\n'
        '  <div class="iq-actions" id="iq-actions"></div>\n'
        "</div>\n"
        "%s\n"
        "<script>%s</script>\n"
        "%s\n"
        "<script>\n{{__IQ_JS__}}\n</script>\n"
    ) % (attrs, question, raw, CONFIG_MARKER, cloze_script)
    back = (
        '<div class="iq-card" id="iq-card" data-side="back"%s>\n'
        '  <div class="iq-question" id="iq-question">%s</div>\n'
        '  <div class="iq-options" id="iq-options"></div>\n'
        '  <div id="iq-answer-block"><div class="iq-block-title">答案</div>'
        '<div id="iq-answer-list"></div></div>\n'
        '  <div class="iq-explain" id="iq-explanation"></div>\n'
        '  <div class="iq-explain iq-tips" id="iq-tips"></div>\n'
        '  <div class="iq-explain" id="iq-source"></div>\n'
        "</div>\n"
        "%s\n"
        "<script>%s</script>\n"
        "%s\n"
        "<script>\n{{__IQ_JS__}}\n</script>\n"
    ) % (attrs, question, raw, CONFIG_MARKER, cloze_script)
    return front, back


def build_templates(field_names: Optional[list[str]] = None, cloze: bool = False) -> tuple[str, str, str]:
    js = _read_asset("quiz.js")
    css = _read_asset("quiz.css")
    front, back = _card_bodies(list(field_names or FIELD_NAMES), cloze)
    return (
        front.replace("{{__IQ_JS__}}", js),
        back.replace("{{__IQ_JS__}}", js),
        css,
    )


# --------------------------------------------------------------------------
# 题型
# --------------------------------------------------------------------------


def _save_model(models: Any, nt: Any) -> None:
    for name in ("save", "update_dict", "flush"):
        fn = getattr(models, name, None)
        if not callable(fn):
            continue
        try:
            fn(nt)
            return
        except TypeError:
            try:
                fn(nt, True)
                return
            except Exception:
                continue
        except Exception:
            continue


def _ensure_note_type(
    name: str,
    field_names: list[str],
    card_name: str,
    cloze: bool = False,
    drop_extra_fields: bool = False,
) -> bool:
    """创建或更新一个题型（四个题型共用这一条逻辑）。"""
    col = getattr(mw, "col", None)
    if col is None:
        return False
    models = getattr(col, "models", None)
    if models is None:
        return False

    front, back, css = build_templates(field_names, cloze)
    nt = models.by_name(name)
    created = nt is None
    if created:
        if cloze:
            nt = _new_cloze_notetype(models, col, name)
            if nt is None:
                return False
        else:
            nt = models.new(name)

    base_field = None
    try:
        base_field = nt["flds"][0]
    except Exception:
        base_field = None

    if cloze:
        try:
            nt["type"] = 1
        except Exception:
            pass

    if created and cloze:
        # 内置填空题型自带两个字段，直接换成我们自己的
        nt["flds"] = _build_fields(models, field_names, base_field)
    else:
        existing = {f["name"] for f in nt["flds"]}
        for field in field_names:
            if field not in existing:
                models.add_field(nt, models.new_field(field))

    if drop_extra_fields and not created:
        _drop_unused_fields(models, col, nt, field_names)

    tmpl = None
    for candidate in nt.get("tmpls", []):
        if candidate.get("name") == card_name:
            tmpl = candidate
            break
    if tmpl is None:
        try:
            tmpl = models.new_template(card_name)
        except Exception:
            tmpl = {"name": card_name}
    tmpl["name"] = card_name
    tmpl["qfmt"] = front
    tmpl["afmt"] = back
    nt["tmpls"] = [tmpl]
    nt["css"] = css

    if created:
        models.add(nt)
    else:
        _save_model(models, nt)
    return True


def _field_has_values(col: Any, nt: Any, field: str) -> bool:
    """这个字段里还有没有内容（查不出来就当有，宁可不删）。"""
    try:
        return bool(col.find_notes('note:"%s" %s:_*' % (nt["name"], field)))
    except Exception:
        return True


def _drop_unused_fields(models: Any, col: Any, nt: Any, keep: list[str]) -> None:
    """删掉不再需要的字段（目前只有废弃的「类型」）。字段里还有内容就留着。"""
    for field in list(nt.get("flds", [])):
        name = field.get("name")
        if name in keep:
            continue
        if _field_has_values(col, nt, name):
            print(f"[互动答题卡] 「{name}」字段还有内容，先不删")
            continue
        try:
            models.remove_field(nt, field)
        except Exception as exc:
            print(f"[互动答题卡] 删除字段「{name}」失败: {exc}")


_SAMPLE_TAG = "互动答题卡示例"


def _legacy_type_only_has_samples(col: Any, nt: Any) -> bool:
    """通用题型里是不是只剩示例卡片（或者干脆是空的）。"""
    try:
        nids = col.find_notes('note:"%s"' % nt["name"])
    except Exception:
        return False
    if not nids:
        return True
    try:
        return all(_SAMPLE_TAG in col.get_note(nid).tags for nid in nids)
    except Exception:
        return False


def cleanup_legacy_note_type() -> bool:
    """删掉已经不再使用的通用题型「互动答题卡」。

    只在这个题型里**全是示例卡片（或空的）**时才删——万一你往里写过真题，
    它会原样留着，并在调试日志里提示。
    """
    col = getattr(mw, "col", None)
    models = getattr(col, "models", None) if col is not None else None
    if col is None or models is None:
        return False
    nt = models.by_name(NOTE_TYPE_NAME)
    if nt is None:
        return False
    if not _legacy_type_only_has_samples(col, nt):
        print(f"[互动答题卡] 「{NOTE_TYPE_NAME}」里还有非示例笔记，保留不删")
        return False
    try:
        models.remove(nt["id"])
        print(f"[互动答题卡] 已删除不再使用的通用题型「{NOTE_TYPE_NAME}」")
        return True
    except Exception as exc:
        print(f"[互动答题卡] 删除通用题型失败: {exc}")
        return False


def _new_cloze_notetype(models: Any, col: Any, name: str) -> Any:
    """造一个「原生 cloze 类型」的题型壳：优先参考 Anki 自带的填空题题型。"""
    try:
        from anki import stdmodels  # type: ignore

        kind = getattr(stdmodels, "StockNotetypeKind", None)
        getter = getattr(stdmodels, "_get_stock_notetype", None)
        if kind is not None and getter is not None:
            stock = getter(col, kind.KIND_CLOZE)
            if isinstance(stock, dict):
                nt = dict(stock)
                nt["id"] = 0
                nt["name"] = name
                nt["type"] = 1  # 关键：1 = cloze 题型
                return nt
    except Exception as exc:
        print(f"[互动答题卡] 取内置填空题题型失败，改用兜底方案: {exc}")

    nt = models.new(name)
    try:
        nt["type"] = 1
        nt["req"] = [[0, "any", [0]]]
    except Exception:
        pass
    return nt


def _build_fields(models: Any, names: list[str], base: Any) -> list[Any]:
    """按 names 造字段，字段外形照抄 base（Anki 自带填空题的第一个字段）。"""
    fields = []
    for index, name in enumerate(names):
        try:
            field = models.new_field(name)
        except Exception:
            field = {"name": name}
        try:
            field["ord"] = index
            if isinstance(base, dict):
                for key, value in base.items():
                    if key not in ("name", "ord", "id"):
                        field.setdefault(key, value)
            field["preventDeletion"] = index == 0
        except Exception:
            pass
        fields.append(field)
    return fields


def ensure_cloze_note_type() -> bool:
    """创建 / 更新「互动答题卡·填空」（原生 cloze 题型），成功返回 True。"""
    return _ensure_note_type(
        CLOZE_NOTE_TYPE_NAME, CLOZE_FIELD_NAMES, CLOZE_CARD_NAME, cloze=True
    )


def ensure_choice_note_type() -> bool:
    """创建 / 更新「互动答题卡·选择题」（多余的「答案」字段会被清掉）。"""
    return _ensure_note_type(
        CHOICE_NOTE_TYPE_NAME,
        CHOICE_FIELD_NAMES,
        CHOICE_CARD_NAME,
        drop_extra_fields=True,
    )


def ensure_tf_note_type() -> bool:
    """创建 / 更新「互动答题卡·判断题」。"""
    return _ensure_note_type(TF_NOTE_TYPE_NAME, TF_FIELD_NAMES, TF_CARD_NAME)


def ensure_all_note_types() -> dict[str, bool]:
    """三个题型一起建 / 更新（通用题型已经废弃，不再创建）。"""
    return {
        CHOICE_NOTE_TYPE_NAME: ensure_choice_note_type(),
        TF_NOTE_TYPE_NAME: ensure_tf_note_type(),
        CLOZE_NOTE_TYPE_NAME: ensure_cloze_note_type(),
    }


_SAMPLE_CHOICE: dict[str, str] = {
    "题目": "《静夜思》的作者是谁？",
    "选项": "*A. 李白<br>B. 杜甫<br>C. 白居易<br>D. 王维",
    "解析": "《静夜思》是唐代诗人李白的作品。",
    "解题技巧": "看到「作者是谁」这类题，先想朝代：盛唐诗人里李白、杜甫出现得最多，再回忆课本插图。",
    "来源": "示例卡片",
}

_SAMPLE_TF: dict[str, str] = {
    "题目": "太阳从西边升起。",
    "答案": "错",
    "解析": "太阳从东边升起，西边落下。",
    "解题技巧": "判断题里出现与常识相反的描述，先按常识把它反过来读一遍，再判断。",
    "来源": "示例卡片",
}

def create_samples() -> int:
    """每个题型各写一张示例卡片。"""
    col = mw.col
    deck_id = col.decks.id(SAMPLE_DECK)
    added = 0
    plan = [
        (CHOICE_NOTE_TYPE_NAME, CHOICE_FIELD_NAMES, _SAMPLE_CHOICE, ensure_choice_note_type),
        (TF_NOTE_TYPE_NAME, TF_FIELD_NAMES, _SAMPLE_TF, ensure_tf_note_type),
        (CLOZE_NOTE_TYPE_NAME, CLOZE_FIELD_NAMES, _CLOZE_SAMPLE, ensure_cloze_note_type),
    ]
    for type_name, fields, sample, ensure in plan:
        if not ensure():
            continue
        nt = col.models.by_name(type_name)
        if nt is None:
            continue
        note = col.new_note(nt)
        for field in fields:
            note[field] = sample.get(field, "")
        note.tags = [_SAMPLE_TAG]
        col.add_note(note, deck_id)
        added += 1
    return added


_CLOZE_SAMPLE: dict[str, str] = {
    "题目": (
        "《静夜思》的作者是{{c1::李白}}，他是{{c2::唐}}代人。"
        "<br>「举头望明月，{{c3::低头思故乡}}。」"
    ),
    "解析": "原生填空题：题目里写 {{c1::答案}}，一个 c 号出一张卡，可到卡片浏览器对照。",
    "解题技巧": "挖空最好一次只挖一类信息（人名、朝代、名句），复习时思路更清楚。",
    "来源": "示例卡片",
}


def _create_cloze_sample(col: Any, deck_id: Any) -> int:
    """加一张原生填空示例（三个空 = 三张卡）。"""
    if not ensure_cloze_note_type():
        return 0
    nt = col.models.by_name(CLOZE_NOTE_TYPE_NAME)
    if nt is None:
        return 0
    note = col.new_note(nt)
    for field in CLOZE_FIELD_NAMES:
        note[field] = _CLOZE_SAMPLE.get(field, "")
    note.tags = ["互动答题卡示例"]
    col.add_note(note, deck_id)
    return 1


def rebuild_note_type() -> None:
    results = ensure_all_note_types()
    failed = [name for name, ok in results.items() if not ok]
    if not failed:
        tooltip("互动答题卡：四个题型模板都已创建 / 更新")
    elif len(failed) < len(results):
        showInfo("互动答题卡：这些题型没建成，请重试 —— %s" % "、".join(failed))
    else:
        showInfo("互动答题卡：更新失败，请确认已经打开某个用户配置（不是配置选择界面）。")


def make_samples() -> None:
    count = create_samples()
    if count:
        tooltip(f"互动答题卡：已生成 {count} 张示例卡片，去「{SAMPLE_DECK}」卡组看看吧")
    else:
        showInfo("互动答题卡：生成示例失败，请确认已经打开某个用户配置。")


# --------------------------------------------------------------------------
# 把配置注入卡片
# --------------------------------------------------------------------------


def on_card_will_show(text: str, card: Any, kind: str) -> str:
    if CONFIG_MARKER not in text:
        return text
    try:
        payload = json.dumps(get_config(), ensure_ascii=False)
        payload = payload.replace("<", "\\u003c").replace(">", "\\u003e")
    except Exception:
        payload = "{}"
    text = text.replace(CONFIG_MARKER, f"window.__ANKI_QUIZ_CONFIG__ = {payload};")
    if CLOZE_MARKER in text:
        text = text.replace(CLOZE_MARKER, _cloze_script(card))
    return text


_CLOZE_RE = re.compile(r"\{\{c(\d+)::(.*?)\}\}", re.S)


def _cloze_answers(note: Any) -> dict[str, list[str]]:
    """从题目里把 {{c1::答案}} 抠出来，做成「空号 -> 答案列表」。"""
    try:
        raw = note["题目"]
    except Exception:
        try:
            raw = note.fields[0]
        except Exception:
            return {}
    answers: dict[str, list[str]] = {}
    for number, body in _CLOZE_RE.findall(raw or ""):
        text = _plain_text(body.split("::")[0])
        if text:
            answers.setdefault(str(number), []).append(text)
    return answers


def _cloze_script(card: Any) -> str:
    """卡片端读不到 data-cloze 时的兜底数据（正常情况下用不上）。"""
    data: dict[str, Any] = {"texts": {}}
    if card is not None:
        try:
            data["texts"] = _cloze_answers(card.note())
        except Exception:
            pass
        try:
            data["ord"] = int(getattr(card, "ord", 0) or 0)
        except Exception:
            pass
    try:
        payload = json.dumps(data, ensure_ascii=False)
        payload = payload.replace("<", "\\u003c").replace(">", "\\u003e").replace("</", "<\\/")
    except Exception:
        payload = '{"texts": {}}'
    return f"window.__ANKI_QUIZ_CLOZE__ = {payload};"


# --------------------------------------------------------------------------
# 统计：存储
# --------------------------------------------------------------------------

_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _plain_text(html: str) -> str:
    text = _HTML_TAG_RE.sub("", html or "")
    text = (
        text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&amp;", "&")
    )
    return re.sub(r"\s+", " ", text).strip()


def _profile_name() -> str:
    try:
        return str(mw.pm.name or "")
    except Exception:
        return ""


def _open_stats_db() -> sqlite3.Connection:
    USER_FILES_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(STATS_DB_PATH), timeout=5)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS answers (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        INTEGER NOT NULL,
            cid       INTEGER NOT NULL,
            nid       INTEGER NOT NULL,
            did       INTEGER NOT NULL,
            mode      TEXT    NOT NULL DEFAULT 'unknown',
            correct   INTEGER NOT NULL DEFAULT 0,
            dontknow  INTEGER NOT NULL DEFAULT 0,
            partial   INTEGER NOT NULL DEFAULT 0,
            ms        INTEGER NOT NULL DEFAULT 0,
            ease      INTEGER NOT NULL DEFAULT 0,
            profile   TEXT    NOT NULL DEFAULT '',
            deck      TEXT    NOT NULL DEFAULT '',
            q         TEXT    NOT NULL DEFAULT ''
        )
        """
    )
    existing = {row[1] for row in conn.execute("PRAGMA table_info(answers)")}
    for name, decl in (
        ("partial", "INTEGER NOT NULL DEFAULT 0"),
        ("deck", "TEXT NOT NULL DEFAULT ''"),
        ("q", "TEXT NOT NULL DEFAULT ''"),
    ):
        if name not in existing:
            conn.execute(f"ALTER TABLE answers ADD COLUMN {name} {decl}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_answers_profile ON answers(profile, ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_answers_cid ON answers(cid)")
    return conn


def record_answer(card: Any, info: dict[str, Any], ease: int) -> None:
    if not get_config().get("stats_enabled", True):
        return

    deck_name = ""
    question = ""
    try:
        deck_name = mw.col.decks.name(card.did)
    except Exception:
        pass
    try:
        note = card.note()
        try:
            question = note["题目"]
        except Exception:
            question = note.fields[0] if getattr(note, "fields", None) else ""
    except Exception:
        pass
    question = _plain_text(question)[:160]

    try:
        conn = _open_stats_db()
        try:
            conn.execute(
                """
                INSERT INTO answers
                    (ts, cid, nid, did, mode, correct, dontknow, partial, ms,
                     ease, profile, deck, q)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(time.time()),
                    int(getattr(card, "id", 0) or 0),
                    int(getattr(card, "nid", 0) or 0),
                    int(getattr(card, "did", 0) or 0),
                    str(info.get("mode") or "unknown"),
                    1 if info.get("correct") else 0,
                    1 if info.get("dontknow") else 0,
                    1 if info.get("partial") else 0,
                    int(info.get("ms") or 0),
                    int(ease or 0),
                    _profile_name(),
                    str(deck_name or ""),
                    question,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        print(f"[互动答题卡] 写统计失败: {exc}")


def purge_old_stats() -> None:
    days = int(get_config().get("stats_retention_days", 0) or 0)
    if days <= 0:
        return
    cutoff = int(time.time()) - days * 86400
    try:
        conn = _open_stats_db()
        try:
            conn.execute("DELETE FROM answers WHERE ts < ?", (cutoff,))
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        print(f"[互动答题卡] 清理旧统计失败: {exc}")


def count_answers() -> int:
    try:
        conn = _open_stats_db()
        try:
            row = conn.execute("SELECT COUNT(*) FROM answers").fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
    except Exception:
        return 0


def clear_stats() -> int:
    profile = _profile_name()
    try:
        conn = _open_stats_db()
        try:
            cur = conn.execute("DELETE FROM answers WHERE profile = ?", (profile,))
            conn.commit()
            return int(cur.rowcount or 0)
        finally:
            conn.close()
    except Exception as exc:
        print(f"[互动答题卡] 清空统计失败: {exc}")
        return 0


# --------------------------------------------------------------------------
# 统计：查询
# --------------------------------------------------------------------------


def _deck_ids_with_children(did: int) -> set[int]:
    ids = {did}
    try:
        stack = [did]
        while stack:
            for child in mw.col.decks.children(stack.pop()):
                if child not in ids:
                    ids.add(child)
                    stack.append(child)
    except Exception:
        pass
    return ids


def _note_ids_for_tag(tag: str) -> set[int]:
    try:
        return {int(x) for x in mw.col.db.list("SELECT nid FROM tags WHERE tag = ?", tag)}
    except Exception:
        return set()


def query_stats(
    profile: str,
    since_ts: int,
    mode: Optional[str] = None,
    deck_ids: Optional[set[int]] = None,
    note_ids: Optional[set[int]] = None,
    keyword: str = "",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """按条件取卡片级统计，默认按难度从高到低排序（截断之前先排好）。"""
    sql = """
        SELECT cid,
               MIN(nid)                                     AS nid,
               MIN(did)                                     AS did,
               MIN(deck)                                    AS deck,
               MIN(q)                                       AS q,
               MIN(mode)                                    AS mode,
               COUNT(*)                                     AS attempts,
               SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END)  AS rights,
               SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END)  AS wrongs,
               SUM(dontknow)                                 AS dontknows,
               SUM(partial)                                  AS partials,
               AVG(ms)                                       AS avg_ms,
               MAX(ts)                                       AS last_ts
        FROM answers
        WHERE profile = ? AND ts >= ?
    """
    args: list[Any] = [profile, int(since_ts)]
    if mode:
        sql += " AND mode = ?"
        args.append(mode)
    sql += " GROUP BY cid"

    try:
        conn = _open_stats_db()
        try:
            raw = conn.execute(sql, args).fetchall()
        finally:
            conn.close()
    except Exception as exc:
        print(f"[互动答题卡] 查询统计失败: {exc}")
        return [], {"cards": 0, "attempts": 0, "rights": 0, "avg_ms": 0, "total_cards": 0}

    rows: list[dict[str, Any]] = []
    for r in raw:
        (cid, nid, did, deck, q, row_mode, attempts, rights, wrongs, dontknows, partials, avg_ms, last_ts) = r
        attempts = int(attempts or 0)
        rights = int(rights or 0)
        errors = max(0, attempts - rights)
        rows.append(
            {
                "cid": int(cid),
                "nid": int(nid or 0),
                "did": int(did or 0),
                "deck": deck or "",
                "q": q or "",
                "mode": row_mode or "unknown",
                "attempts": attempts,
                "rights": rights,
                "errors": errors,
                "wrongs": int(wrongs or 0),
                "dontknows": int(dontknows or 0),
                "partials": int(partials or 0),
                "avg_ms": int(avg_ms or 0),
                "last_ts": int(last_ts or 0),
                # 平滑后的错误率，避免"做一次错一次"就直接排第一
                "difficulty": (errors + 0.5) / (attempts + 1.0),
            }
        )

    visible = rows
    if deck_ids is not None:
        visible = [r for r in visible if r["did"] in deck_ids]
    if note_ids is not None:
        visible = [r for r in visible if r["nid"] in note_ids]
    if keyword:
        needle = keyword.lower()
        visible = [r for r in visible if needle in (r["q"] or "").lower()]

    visible.sort(key=lambda r: (-r["difficulty"], -r["attempts"]))

    attempts_total = sum(r["attempts"] for r in visible)
    rights_total = sum(r["rights"] for r in visible)
    ms_total = sum(r["avg_ms"] * r["attempts"] for r in visible)
    summary = {
        "cards": len(visible),
        "attempts": attempts_total,
        "rights": rights_total,
        "avg_ms": int(ms_total / attempts_total) if attempts_total else 0,
        "total_cards": len(rows),
    }
    return visible, summary


def annotate_anki_ease(rows: list[dict[str, Any]]) -> None:
    """补一列 Anki 自己的难易度（ease factor）；失败就算了。"""
    for row in rows:
        row.setdefault("factor", None)
        if row.get("factor"):
            continue
        try:
            card = mw.col.get_card(row["cid"])
            factor = int(getattr(card, "factor", 0) or 0)
            if factor > 0:
                row["factor"] = factor / 10.0
        except Exception:
            continue


def collect_tags() -> list[str]:
    try:
        tags = list(mw.col.tags.all())
    except Exception:
        return []
    tags.sort()
    return tags[:800]


def _fmt_duration(ms: int) -> str:
    if not ms:
        return "—"
    if ms < 1000:
        return f"{ms} ms"
    return f"{ms / 1000:.1f} s"


def _fmt_time(ts: int) -> str:
    if not ts:
        return "—"
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))
    except Exception:
        return "—"


# --------------------------------------------------------------------------
# 卡片端 -> Anki
# --------------------------------------------------------------------------


def _current_card_id() -> Optional[int]:
    reviewer = getattr(mw, "reviewer", None)
    card = getattr(reviewer, "card", None)
    return getattr(card, "id", None)


def _bottom_webview(reviewer: Any) -> Any:
    for holder_name, web_name in (("bottom", "bottomWeb"), ("bottom", "web"), ("", "bottomWeb")):
        holder = reviewer if not holder_name else getattr(reviewer, holder_name, None)
        if holder is None:
            continue
        web = getattr(holder, web_name, None)
        if web is not None and hasattr(web, "eval"):
            return web
    return None


def _grade(reviewer: Any, card_id: Optional[int], ease: int) -> None:
    """真正给卡片打分。优先用 Anki 自己的入口，失败则退回点击底部评分按钮。"""

    def run() -> None:
        current = getattr(mw, "reviewer", None)
        if current is None:
            return
        card = getattr(current, "card", None)
        if card is None or (card_id is not None and card.id != card_id):
            return
        answer = getattr(current, "_answerCard", None)
        if callable(answer):
            try:
                answer(ease)
                return
            except Exception as exc:
                print(f"[互动答题卡] _answerCard 失败: {exc}")
        web = _bottom_webview(current)
        if web is not None:
            try:
                web.eval(f"pycmd('ease{ease}')")
                return
            except Exception as exc:
                print(f"[互动答题卡] 底部按钮回退失败: {exc}")
        print(f"[互动答题卡] 无法评级：找不到可用的评分入口（ease={ease}）")

    QTimer.singleShot(0, run)


def _parse_result(parts: list[str]) -> dict[str, Any]:
    def num(index: int) -> int:
        try:
            return int(parts[index])
        except Exception:
            return 0

    return {
        "mode": parts[2] if len(parts) > 2 and parts[2] else "unknown",
        "correct": bool(num(3)),
        "dontknow": bool(num(4)),
        "ms": num(5),
        "partial": bool(num(6)),
    }


def _handle_message(message: str) -> Any:
    reviewer = getattr(mw, "reviewer", None)
    card_id = _current_card_id()
    parts = message.split(":")
    action = parts[1] if len(parts) > 1 else ""

    if action == "config":
        return get_config()

    if reviewer is None or card_id is None:
        return None

    if action == "reset":
        _forced_ease.pop(card_id, None)
        _pending_result.pop(card_id, None)
    elif action == "wrong":
        _forced_ease[card_id] = 1
    elif action == "partial":
        # 漏选：最多记「困难」；已经被要求记重来的话不动
        current = _forced_ease.get(card_id)
        if current is None or current > 2:
            _forced_ease[card_id] = 2
    elif action == "result":
        _pending_result[card_id] = _parse_result(parts)
    elif action == "grade" and len(parts) > 2:
        try:
            ease = int(parts[2])
        except (TypeError, ValueError):
            return None
        if ease not in (1, 2, 3, 4):
            return None
        forced = _forced_ease.get(card_id)
        if forced is not None:
            # 答错的题只能重来；漏选的题最多只能困难
            ease = min(ease, forced)
        elif ease == 1:
            _forced_ease[card_id] = 1
        now = time.monotonic()
        if now - _recent_grade.get(card_id, 0.0) < 0.4:
            return None
        _recent_grade[card_id] = now
        if len(_recent_grade) > 500:
            _recent_grade.clear()
        _grade(reviewer, card_id, ease)
    return None


def on_js_message(handled: Any, message: str, context: Any) -> Any:
    if not isinstance(message, str) or not message.startswith("iq:"):
        return handled
    try:
        result = _handle_message(message)
    except Exception as exc:
        print(f"[互动答题卡] 处理 {message!r} 出错: {exc}")
        result = None
    return (True, result)


def on_will_answer_card(ease: Any, reviewer: Any, card: Any) -> Any:
    card_id = getattr(card, "id", None)
    forced = _forced_ease.get(card_id) if card_id is not None else None
    if forced is None:
        return ease
    if isinstance(ease, tuple):
        try:
            incoming = int(ease[1])
        except Exception:
            return (True, forced)
        return (True, min(incoming, forced))
    try:
        incoming = int(ease)
    except Exception:
        return forced
    return min(incoming, forced)


def on_did_answer_card(reviewer: Any, card: Any, ease: Any) -> None:
    card_id = getattr(card, "id", None)
    if card_id is None:
        return
    _forced_ease.pop(card_id, None)
    _recent_grade.pop(card_id, None)
    info = _pending_result.pop(card_id, None)
    if info is None:
        return
    try:
        ease_int = int(ease[1]) if isinstance(ease, tuple) else int(ease)
    except Exception:
        ease_int = 0
    record_answer(card, info, ease_int)


def on_did_show_question(card: Any) -> None:
    card_id = getattr(card, "id", None)
    if card_id is not None:
        _forced_ease.pop(card_id, None)
        _pending_result.pop(card_id, None)


# --------------------------------------------------------------------------
# 「设置与统计」窗口
# --------------------------------------------------------------------------


def open_quiz_dialog() -> None:
    try:
        _run_quiz_dialog()
    except Exception as exc:  # 打不开也不能影响复习
        import traceback

        traceback.print_exc()
        showInfo(f"互动答题卡：打开窗口失败\n{exc}")


def _run_quiz_dialog() -> None:
    from aqt.qt import (
        QAbstractItemView,
        QCheckBox,
        QComboBox,
        QDialog,
        QGroupBox,
        QHBoxLayout,
        QHeaderView,
        QLabel,
        QLineEdit,
        QPushButton,
        QSpinBox,
        QTableWidget,
        QTableWidgetItem,
        QTabWidget,
        QVBoxLayout,
        QWidget,
        Qt,
    )
    from aqt.utils import askUser

    # PyQt5 / PyQt6 枚举写法不同，两套都兼容
    try:
        no_edit = QAbstractItemView.EditTrigger.NoEditTriggers
        select_rows = QAbstractItemView.SelectionBehavior.SelectRows
        single_sel = QAbstractItemView.SelectionMode.SingleSelection
        stretch = QHeaderView.ResizeMode.Stretch
        resize_contents = QHeaderView.ResizeMode.ResizeToContents
        align_right = Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        user_role = Qt.ItemDataRole.UserRole
    except AttributeError:
        no_edit = QAbstractItemView.NoEditTriggers
        select_rows = QAbstractItemView.SelectRows
        single_sel = QAbstractItemView.SingleSelection
        stretch = QHeaderView.Stretch
        resize_contents = QHeaderView.ResizeToContents
        align_right = Qt.AlignRight | Qt.AlignVCenter
        user_role = Qt.UserRole

    cfg = get_config()
    profile = _profile_name()

    dlg = QDialog(mw)
    dlg.setWindowTitle("互动答题卡 · 设置与统计")
    dlg.resize(1040, 660)
    root = QVBoxLayout(dlg)
    tabs = QTabWidget(dlg)
    root.addWidget(tabs)

    def hint(text: str) -> Any:
        label = QLabel(text)
        label.setWordWrap(True)
        return label

    # ------------------------------------------------------------ 设置页
    page_settings = QWidget()
    sv = QVBoxLayout(page_settings)

    box_stats = QGroupBox("统计记录")
    bs = QVBoxLayout(box_stats)
    cb_enabled = QCheckBox("记录作答明细（关掉后不再收集新数据，已有记录保留）")
    cb_enabled.setChecked(bool(cfg.get("stats_enabled", True)))
    bs.addWidget(cb_enabled)
    row_retention = QHBoxLayout()
    row_retention.addWidget(QLabel("明细保留天数"))
    sp_retention = QSpinBox()
    sp_retention.setRange(0, 3650)
    sp_retention.setValue(int(cfg.get("stats_retention_days", 0) or 0))
    row_retention.addWidget(sp_retention)
    row_retention.addWidget(QLabel("（0 = 永久保留）"))
    row_retention.addStretch(1)
    bs.addLayout(row_retention)
    sv.addWidget(box_stats)

    box_answer = QGroupBox("答题行为")
    ba = QVBoxLayout(box_answer)
    cb_timer = QCheckBox("答题时在卡片右上角显示本题计时")
    cb_timer.setChecked(bool(cfg.get("show_timer", False)))
    ba.addWidget(cb_timer)
    cb_partial = QCheckBox("多选题漏选（但没选错）时，允许记为「困难」")
    cb_partial.setChecked(bool(cfg.get("multi_partial_credit", False)))
    ba.addWidget(cb_partial)
    cb_update = QCheckBox("启动时自动检查更新（从 GitHub）")
    cb_update.setChecked(bool(cfg.get("update_check", True)))
    ba.addWidget(cb_update)
    ba.addWidget(
        hint(
            "原规则：只有全对才能自己选 困难 / 良好 / 简单，答错或点「不知道」一律记为「重来」。"
            "勾上这一项后，多选漏选可以记为「困难」，但仍然不能记 良好 / 简单。"
        )
    )
    sv.addWidget(box_answer)

    box_maint = QGroupBox("维护")
    bm = QHBoxLayout(box_maint)
    btn_template = QPushButton("创建 / 更新题型模板")
    btn_samples = QPushButton("生成示例卡片")
    btn_update = QPushButton("检查更新")
    bm.addWidget(btn_template)
    bm.addWidget(btn_samples)
    bm.addWidget(btn_update)
    bm.addStretch(1)
    sv.addWidget(box_maint)
    sv.addWidget(
        hint(
            "题型模板在每次启动 Anki 时会自动更新，上面的按钮只是手动兜底。"
            "「生成示例卡片」会往「%s」卡组各写一张：选择题、判断题、"
            "原生填空题（3 个空 = 3 张卡）。" % SAMPLE_DECK
        )
    )
    sv.addWidget(
        hint(
            "其余选项（答错后是否先显示答案、打乱选项、填空忽略标点等）在"
            "「工具 → 插件 → 互动答题卡 → 配置」里。"
        )
    )
    sv.addStretch(1)

    row_btns = QHBoxLayout()
    btn_defaults = QPushButton("恢复默认")
    btn_close = QPushButton("关闭")
    btn_save = QPushButton("保存设置")
    row_btns.addWidget(btn_defaults)
    row_btns.addStretch(1)
    row_btns.addWidget(btn_close)
    row_btns.addWidget(btn_save)
    sv.addLayout(row_btns)
    tabs.addTab(page_settings, "设置")

    # ------------------------------------------------------------ 统计页
    page_stats = QWidget()
    pv = QVBoxLayout(page_stats)

    filters = QHBoxLayout()
    combo_deck = QComboBox()
    combo_deck.setMinimumWidth(150)
    combo_mode = QComboBox()
    combo_mode.setMinimumWidth(96)
    combo_tag = QComboBox()
    combo_tag.setMinimumWidth(130)
    combo_tag.setEditable(True)
    combo_range = QComboBox()
    combo_range.setMinimumWidth(104)
    combo_sort = QComboBox()
    combo_sort.setMinimumWidth(150)
    edit_keyword = QLineEdit()
    edit_keyword.setPlaceholderText("题目包含…")
    edit_keyword.setMinimumWidth(130)

    for label_text, widget in (
        ("牌组", combo_deck),
        ("题型", combo_mode),
        ("标签", combo_tag),
        ("时间", combo_range),
        ("排序", combo_sort),
    ):
        filters.addWidget(QLabel(label_text))
        filters.addWidget(widget)
    filters.addWidget(edit_keyword)
    btn_refresh = QPushButton("查询")
    filters.addWidget(btn_refresh)
    filters.addStretch(1)
    pv.addLayout(filters)

    label_summary = QLabel("…")
    label_summary.setWordWrap(True)
    pv.addWidget(label_summary)

    columns = [
        "题目",
        "牌组",
        "题型",
        "作答",
        "答错",
        "正确率",
        "难度",
        "Anki难易度",
        "平均用时",
        "最后作答",
    ]
    table = QTableWidget(0, len(columns))
    table.setHorizontalHeaderLabels(columns)
    table.setEditTriggers(no_edit)
    table.setSelectionBehavior(select_rows)
    table.setSelectionMode(single_sel)
    table.verticalHeader().setVisible(False)
    table.setWordWrap(False)
    header = table.horizontalHeader()
    header.setSectionResizeMode(0, stretch)
    for index in range(1, len(columns)):
        header.setSectionResizeMode(index, resize_contents)
    pv.addWidget(table)

    row_stats_btns = QHBoxLayout()
    btn_clear = QPushButton("清空统计")
    label_db = QLabel("")
    row_stats_btns.addWidget(btn_clear)
    row_stats_btns.addWidget(label_db)
    row_stats_btns.addStretch(1)
    pv.addLayout(row_stats_btns)
    tabs.addTab(page_stats, "统计")

    # ------------------------------------------------------------ 填充筛选
    def fill_filters() -> None:
        combo_deck.clear()
        combo_deck.addItem("全部牌组", None)
        decks: list[tuple[str, Any]] = []
        try:
            decks = [(d.name, d.id) for d in mw.col.decks.all_names_and_ids()]
        except Exception:
            try:
                decks = [(mw.col.decks.name(did), did) for did in mw.col.decks.all_ids()]
            except Exception:
                decks = []
        for name, did in sorted(decks):
            combo_deck.addItem(name, did)

        combo_mode.clear()
        combo_mode.addItem("全部题型", None)
        for key in MODE_ORDER:
            combo_mode.addItem(MODE_LABELS[key], key)

        combo_tag.clear()
        combo_tag.addItem("全部标签", None)
        for tag in collect_tags():
            combo_tag.addItem(tag, tag)
        combo_tag.setCurrentIndex(0)

        combo_range.clear()
        for text, days in (("全部时间", 0), ("近 7 天", 7), ("近 30 天", 30), ("近 90 天", 90)):
            combo_range.addItem(text, days)

        combo_sort.clear()
        combo_sort.addItem("难度 高 → 低", "diff_desc")
        combo_sort.addItem("难度 低 → 高", "diff_asc")
        combo_sort.addItem("Anki 难易度 低 → 高", "factor_asc")

    def current_tag() -> Optional[str]:
        data = combo_tag.currentData()
        if data:
            return str(data)
        text = combo_tag.currentText().strip()
        if text and text != "全部标签":
            return text
        return None

    # ------------------------------------------------------------ 查询
    def refresh() -> None:
        days = combo_range.currentData() or 0
        since = 0 if not days else int(time.time()) - int(days) * 86400
        mode = combo_mode.currentData()
        deck_id = combo_deck.currentData()
        tag = current_tag()
        keyword = edit_keyword.text().strip()

        deck_ids = _deck_ids_with_children(int(deck_id)) if deck_id else None
        note_ids = _note_ids_for_tag(tag) if tag else None

        rows, summary = query_stats(
            profile=profile,
            since_ts=since,
            mode=mode,
            deck_ids=deck_ids,
            note_ids=note_ids,
            keyword=keyword,
        )

        sort_key = combo_sort.currentData() or "diff_desc"
        if sort_key == "diff_asc":
            rows.sort(key=lambda r: (r["difficulty"], -r["attempts"]))
            displayed = rows[:500]
            annotate_anki_ease(displayed)
        elif sort_key == "factor_asc":
            # 先取最难的若干张，再按 Anki 自己的难易度排
            pool = rows[:800]
            annotate_anki_ease(pool)
            pool.sort(
                key=lambda r: (
                    r.get("factor") if r.get("factor") is not None else 1e9,
                    -r["attempts"],
                )
            )
            displayed = pool[:500]
        else:
            rows.sort(key=lambda r: (-r["difficulty"], -r["attempts"]))
            displayed = rows[:500]
            annotate_anki_ease(displayed)

        table.setSortingEnabled(False)
        table.setRowCount(0)
        for row in displayed:
            r = table.rowCount()
            table.insertRow(r)
            attempts = row["attempts"] or 0
            factor = row.get("factor")
            values = [
                row["q"] or "—",
                row["deck"] or "—",
                MODE_LABELS.get(row["mode"], row["mode"]),
                str(attempts),
                str(row["errors"]),
                f"{row['rights'] / attempts * 100:.0f}%" if attempts else "—",
                f"{row['difficulty'] * 100:.0f}%",
                f"{factor:.0f}%" if factor else "—",
                _fmt_duration(row["avg_ms"]),
                _fmt_time(row["last_ts"]),
            ]
            for index, text in enumerate(values):
                item = QTableWidgetItem(text)
                if index == 0:
                    item.setData(user_role, row["cid"])
                if index >= 3:
                    item.setTextAlignment(align_right)
                table.setItem(r, index, item)

        attempts_total = summary["attempts"]
        rate = f"{summary['rights'] / attempts_total * 100:.0f}%" if attempts_total else "—"
        suffix = f" · 只显示前 {len(displayed)} 张" if summary["cards"] > len(displayed) else ""
        label_summary.setText(
            f"符合条件：{summary['cards']} 张卡片（库里共 {summary['total_cards']} 张有记录）"
            f" · 作答 {attempts_total} 次 · 正确率 {rate}"
            f" · 平均用时 {_fmt_duration(summary['avg_ms'])}{suffix}"
        )
        label_db.setText(f"统计库：{STATS_DB_PATH}（共 {count_answers()} 条记录）")

    # ------------------------------------------------------------ 事件
    def do_save() -> None:
        new_cfg = get_config()
        new_cfg["stats_enabled"] = bool(cb_enabled.isChecked())
        new_cfg["stats_retention_days"] = int(sp_retention.value())
        new_cfg["show_timer"] = bool(cb_timer.isChecked())
        new_cfg["multi_partial_credit"] = bool(cb_partial.isChecked())
        new_cfg["update_check"] = bool(cb_update.isChecked())
        if save_config(new_cfg):
            tooltip("互动答题卡：设置已保存")
            purge_old_stats()

    def do_defaults() -> None:
        cb_enabled.setChecked(bool(DEFAULTS["stats_enabled"]))
        sp_retention.setValue(int(DEFAULTS["stats_retention_days"]))
        cb_timer.setChecked(bool(DEFAULTS["show_timer"]))
        cb_partial.setChecked(bool(DEFAULTS["multi_partial_credit"]))
        cb_update.setChecked(bool(DEFAULTS["update_check"]))

    def do_clear() -> None:
        if not askUser(f"确定要清空用户配置「{profile}」下的全部作答记录吗？\n此操作不可撤销。"):
            return
        removed = clear_stats()
        tooltip(f"互动答题卡：已清空 {removed} 条记录")
        refresh()

    def on_tab_changed(_index: int) -> None:
        if tabs.currentWidget() is page_stats:
            refresh()

    btn_save.clicked.connect(do_save)
    btn_defaults.clicked.connect(do_defaults)
    btn_close.clicked.connect(dlg.reject)
    btn_clear.clicked.connect(do_clear)
    btn_refresh.clicked.connect(refresh)
    combo_deck.currentIndexChanged.connect(lambda _i: refresh())
    combo_mode.currentIndexChanged.connect(lambda _i: refresh())
    combo_range.currentIndexChanged.connect(lambda _i: refresh())
    combo_sort.currentIndexChanged.connect(lambda _i: refresh())
    combo_tag.activated.connect(lambda _i: refresh())
    edit_keyword.returnPressed.connect(refresh)
    tabs.currentChanged.connect(on_tab_changed)

    btn_template.clicked.connect(lambda: rebuild_note_type())
    btn_samples.clicked.connect(lambda: make_samples())
    btn_update.clicked.connect(lambda: check_for_update(silent=False))

    fill_filters()
    refresh()

    run = getattr(dlg, "exec", None) or getattr(dlg, "exec_", None)
    run()


# --------------------------------------------------------------------------
# 编辑器助手：方案 A（实时体检 + Alt+数字）与方案 B（制卡助手面板）
# --------------------------------------------------------------------------

# 题型 -> 编辑器里的模式
EDITOR_MODES = {
    CHOICE_NOTE_TYPE_NAME: "choice",
    TF_NOTE_TYPE_NAME: "tf",
    CLOZE_NOTE_TYPE_NAME: "cloze",
    NOTE_TYPE_NAME: "legacy",
}

_OPTION_MARK_RE = re.compile(r"^\s*[*+\u221a\u2713\u2714]\s?")
_OPTION_LABEL_RE = re.compile(r"^\s*[A-Za-z]\s*[.\u3001)\uFF09\uFF0E:\uFF1A]\s*")
_CLOZE_IN_EDITOR_RE = re.compile(r"\{\{c(\d+)::")


def _editor_note_type_name(editor: Any) -> str:
    try:
        return str(editor.note.model()["name"])
    except Exception:
        return ""


def _editor_field_names(editor: Any) -> list[str]:
    try:
        return [f["name"] for f in editor.note.model()["flds"]]
    except Exception:
        return []


def _editor_mode(editor: Any) -> str:
    return EDITOR_MODES.get(_editor_note_type_name(editor), "")


def _editor_config(editor: Any) -> dict[str, Any]:
    return {
        "type": _editor_note_type_name(editor),
        "mode": _editor_mode(editor),
        "fields": _editor_field_names(editor),
    }


def on_editor_did_load_note(editor: Any) -> None:
    """每张笔记载入编辑器时，把「编辑器助手」脚本装进去（会自己判断是不是我们的题型）。"""
    cfg = _editor_config(editor)
    try:
        js = _read_asset("editor.js")
        payload = json.dumps(cfg, ensure_ascii=False)
        editor.web.eval(f"{js}\nwindow.__IQ_EDITOR_INSTALL__({payload});")
    except Exception as exc:
        print(f"[互动答题卡] 编辑器助手注入失败: {exc}")


# --------------------------------------------------------------------------
# 从 GitHub 检查 / 安装更新
# --------------------------------------------------------------------------


def _version_tuple(text: str) -> tuple:
    """把 "1.2.3" 这种版本号变成可比较的元组；认不出就当 0。"""
    numbers = re.findall(r"\d+", text or "")
    if not numbers:
        return (0,)
    return tuple(int(n) for n in numbers[:4])


def is_newer(remote: str, local: str) -> bool:
    """远端版本是不是比本地新。"""
    return _version_tuple(remote) > _version_tuple(local)


def _repo_ready() -> bool:
    return bool(UPDATE_REPO) and "TODO" not in UPDATE_REPO


def _fetch(url: str, timeout: int = 10) -> bytes:
    import urllib.request

    request = urllib.request.Request(
        url, headers={"User-Agent": f"anki-interactive-quiz/{__version__}"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_latest_version() -> str:
    if not _repo_ready():
        return ""
    return _fetch(VERSION_URL, timeout=8).decode("utf-8", "replace").strip()


def _update_state() -> dict[str, Any]:
    try:
        data = json.loads(UPDATE_STATE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_update_state(state: dict[str, Any]) -> None:
    try:
        USER_FILES_DIR.mkdir(parents=True, exist_ok=True)
        UPDATE_STATE_PATH.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        print(f"[互动答题卡] 记录更新状态失败: {exc}")


def download_and_install_update() -> bool:
    """下载最新的 .ankiaddon 并让 Anki 装上。"""
    import tempfile

    data = _fetch(PACKAGE_URL, timeout=60)
    target = Path(tempfile.gettempdir()) / "interactive_quiz_update.ankiaddon"
    target.write_bytes(data)

    manager = getattr(mw, "addonManager", None)
    for name in ("installFromFile", "install_from_file"):
        fn = getattr(manager, name, None) if manager is not None else None
        if not callable(fn):
            continue
        try:
            fn(str(target))
            return True
        except Exception as exc:
            print(f"[互动答题卡] 调用 {name} 安装失败: {exc}")

    showInfo(
        "互动答题卡：新版已经下载好了，但自动安装没成功。\n\n"
        f"文件在：{target}\n"
        "请用「工具 → 插件 → 从文件安装」选它，然后重启 Anki。"
    )
    return False


def check_for_update(silent: bool = False) -> None:
    """检查 GitHub 上的最新版本；silent=True 时只在有新版本时提示。"""
    if not _repo_ready():
        if not silent:
            showInfo("互动答题卡：还没配置更新地址（插件是从源码直接跑的？）。")
        return

    def work() -> str:
        return fetch_latest_version()

    def done(future: Any) -> None:
        try:
            latest = future.result()
        except Exception as exc:
            if not silent:
                showInfo(f"互动答题卡：检查更新失败\n{exc}")
            return
        state = _update_state()
        state["checked_at"] = int(time.time())
        _save_update_state(state)
        if not latest or not is_newer(latest, __version__):
            if not silent:
                tooltip(f"互动答题卡：已经是最新版本（{__version__}）")
            return
        if not askUser(
            f"互动答题卡有新版本：{latest}（当前 {__version__}）\n\n"
            "现在下载并安装吗？装完要重启 Anki 才生效。"
        ):
            return
        try:
            if download_and_install_update():
                tooltip(f"互动答题卡：已更新到 {latest}，请重启 Anki")
        except Exception as exc:
            showInfo(f"互动答题卡：下载更新失败\n{exc}")

    taskman = getattr(mw, "taskman", None)
    if taskman is not None and hasattr(taskman, "run_in_background"):
        taskman.run_in_background(work, done)
    else:  # 兜底：没有 taskman 就直接跑（会卡一下，但能用）
        class _Done:
            def __init__(self, value: Any) -> None:
                self._value = value

            def result(self) -> Any:
                return self._value

        done(_Done(work()))


def maybe_check_update_on_start() -> None:
    """启动时悄悄查一次（默认一天最多一次）。"""
    if not get_config().get("update_check", True) or not _repo_ready():
        return
    state = _update_state()
    try:
        last = float(state.get("checked_at") or 0)
    except Exception:
        last = 0.0
    if time.time() - last < UPDATE_INTERVAL_SECONDS:
        return
    check_for_update(silent=True)


# --------------------------------------------------------------------------
# 菜单
# --------------------------------------------------------------------------


def install_menu(*_args: Any, **_kwargs: Any) -> None:
    global _menu_installed
    if _menu_installed:
        return
    form = getattr(mw, "form", None)
    if form is None or not hasattr(form, "menuTools"):
        return
    try:
        action = QAction("互动答题卡：设置与统计…", mw)
        action.triggered.connect(lambda _checked=False: open_quiz_dialog())
        form.menuTools.addAction(action)
        _menu_installed = True
    except Exception as exc:
        print(f"[互动答题卡] 菜单创建失败: {exc}")


def on_profile_did_open(profile: Any = None) -> None:
    install_menu()
    if get_config().get("auto_create_note_type", True):
        for ensure, label in (
            (ensure_choice_note_type, "选择题"),
            (ensure_tf_note_type, "判断题"),
            (ensure_cloze_note_type, "填空题"),
        ):
            try:
                ensure()
            except Exception as exc:
                print(f"[互动答题卡] 创建{label}题型失败: {exc}")
        try:
            cleanup_legacy_note_type()
        except Exception as exc:
            print(f"[互动答题卡] 清理通用题型失败: {exc}")
        # 启动后过几秒再悄悄查更新，别拖慢打开速度
        try:
            QTimer.singleShot(8000, maybe_check_update_on_start)
        except Exception as exc:
            print(f"[互动答题卡] 安排更新检查失败: {exc}")
    try:
        purge_old_stats()
    except Exception as exc:
        print(f"[互动答题卡] 清理旧统计失败: {exc}")


# --------------------------------------------------------------------------
# 注册钩子
# --------------------------------------------------------------------------


def _add_hook(name: str, fn: Any) -> None:
    hook = getattr(gui_hooks, name, None)
    if hook is None:
        return
    try:
        hook.append(fn)
    except Exception as exc:
        print(f"[互动答题卡] 注册钩子 {name} 失败: {exc}")


_add_hook("webview_did_receive_js_message", on_js_message)
_add_hook("card_will_show", on_card_will_show)
_add_hook("editor_did_load_note", on_editor_did_load_note)
_add_hook("reviewer_will_answer_card", on_will_answer_card)
_add_hook("reviewer_did_answer_card", on_did_answer_card)
_add_hook("reviewer_did_show_question", on_did_show_question)
_add_hook("profile_did_open", on_profile_did_open)
_add_hook("main_window_did_init", install_menu)
