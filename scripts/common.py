# -*- coding: utf-8 -*-
"""Общий код макросов ds-webui.

Кладётся рядом с `export_full.py` / `export_diff.py` в
`~/.config/<office>/<ver>/user/Scripts/python/` и импортируется ими как `import common`.

Producer-конец цепочки: пользователь правит таблицу в офисном пакете, макрос
выгружает колоночный JSON `<username>_<timestamp>.json` в папку, которую мониторит
`ds-loader` (`upload/`/`load/` источника `<username>`, либо один из его
`watch_dirs`) -> `ds upload`/`ds load sources/<username> <file> --dt <ts>`.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

g_exportedScripts = ()  # не показывать common в списке макросов

# ─── НАСТРОЙКА НА КОНКРЕТНОЙ МАШИНЕ ───────────────────────────────────────────
# Папка, которую мониторит ds-loader (его upload/ или load/ источника, либо
# один из его watch_dirs). Сюда кладутся выгрузки.
#
# Если указать свою (не ds-inbox) и она на этой машине не существует —
# write_json() НЕ создаёт её сама (в отличие от прежнего поведения): это,
# скорее всего, опечатка или ещё не подготовленная установка, и тихо писать
# в только что созданную "правильную" папку, которую ds-loader не мониторит,
# хуже, чем явно откатиться на ds-inbox (с предупреждением в лог) — его можно
# позже найти и перенести руками, а молча утерянные файлы в несуществующем
# until-just-now каталоге — нет. ds-inbox сама по себе всегда создаётся, если
# её ещё нет (как и раньше) — INBOX_DIR по умолчанию ею и является.
INBOX_DIR = Path.home() / "ds-inbox"

# Резервная папка — та же ds-inbox. Используется, если INBOX_DIR выше указана
# на что-то другое, а то "другое" не существует (см. _resolve_inbox_dir).
_FALLBACK_INBOX_DIR = Path.home() / "ds-inbox"

# Куда писать лог макросов.
LOG_DIR = Path.home() / ".config" / "alteroffice" / "5" / "user" / "Scripts" / "python"
LOG_FILE = "ds_export.log"
# ─────────────────────────────────────────────────────────────────────────────

# ВНИМАНИЕ: %M — минуты. В исходном export_json.py был баг %m (месяц).
_TS_FMT = "%Y-%m-%d_%H-%M-%S_%f"

_UNSAFE = re.compile(r'[_\s/\\:*?"<>|]+')


def setup_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=str(LOG_DIR / LOG_FILE),
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )


def username() -> str:
    """Системное имя пользователя как <source> для ds-loader.

    ds-loader берёт за источник всё до первого '_', поэтому '_' (и прочие
    неудобные символы) заменяем на '-'.
    """
    name = _UNSAFE.sub("-", (Path.home().name or "").strip()).strip("-")
    return name or "user"


def export_filename(when: "datetime | None" = None) -> str:
    d = when or datetime.now(timezone.utc)  # UTC: у ds-loader filename_tz="utc" по умолчанию
    return "{user}_{ts}.json".format(user=username(), ts=d.strftime(_TS_FMT))


def cell_str(value: object) -> str:
    """Ячейка из getDataArray() -> строка.

    Офисный пакет отдаёт числа как float. Целочисленные ('101.0') -> '101',
    чтобы ключи/значения не уезжали в ds в форме '101.0'.
    """
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    return str(value).strip()


def sheet_columns(sheet):
    """Использованная область листа -> (headers, {header: [строки данных]}).

    Правила (как в исходном export_json.py):
      * первая строка использованной области — заголовки;
      * столбец с ПУСТЫМ заголовком пропускается;
      * если заголовок повторяется — пропускаются ВСЕ одноимённые столбцы;
      * значения приводятся к строке (`cell_str`).
    Пустой лист -> ([], {}).
    """
    cursor = sheet.createCursor()
    cursor.gotoStartOfUsedArea(False)
    cursor.gotoEndOfUsedArea(True)
    ra = cursor.RangeAddress
    raw = sheet.getCellRangeByPosition(
        ra.StartColumn, ra.StartRow, ra.EndColumn, ra.EndRow
    ).getDataArray()

    if not raw or (len(raw) == 1 and not any(str(c).strip() for c in raw[0])):
        return [], {}

    columns = list(zip(*raw))
    headers = [cell_str(col[0]) if col else "" for col in columns]

    data: dict = {}
    kept_headers: list = []
    for idx, col in enumerate(columns):
        h = headers[idx]
        if h == "":
            logging.warning("столбец #%d пропущен: пустой заголовок", idx + 1)
            continue
        if headers.count(h) > 1:
            logging.warning("столбец #%d пропущен: дублирующийся заголовок %r", idx + 1, h)
            continue
        data[h] = [cell_str(v) for v in col[1:]]
        kept_headers.append(h)
    return kept_headers, data


def get_sheet(sheets, name: str, index: int):
    """Лист по имени; если имени нет — по индексу (фолбэк для старых сборок
    ds-webui / нестандартной конвертации; SpreadsheetML-экспорт имена сохраняет)."""
    if name and sheets.hasByName(name):
        return sheets.getByName(name)
    return sheets.getByIndex(index)


def _resolve_inbox_dir() -> Path:
    """INBOX_DIR, если она существует; иначе — ds-inbox (создаётся при необходимости).

    INBOX_DIR, настроенная на что-то, кроме ds-inbox, НЕ создаётся автоматически —
    отсутствие именно её означает "ещё не готово/опечатка", и правильнее откатиться
    на известную ds-inbox (с предупреждением в лог), чем молча писать в только что
    созданную папку, которую ds-loader, возможно, не мониторит.
    """
    if INBOX_DIR.is_dir():
        return INBOX_DIR
    if INBOX_DIR != _FALLBACK_INBOX_DIR:
        logging.warning(
            "INBOX_DIR %s не существует — использую резервную %s",
            INBOX_DIR, _FALLBACK_INBOX_DIR,
        )
    _FALLBACK_INBOX_DIR.mkdir(parents=True, exist_ok=True)
    return _FALLBACK_INBOX_DIR


def write_json(data: dict) -> "Path | None":
    """Атомарно записать columnar-JSON в INBOX_DIR (или резервную ds-inbox, см.
    _resolve_inbox_dir). Пустой data -> ничего не пишем."""
    if not data:
        logging.warning("нечего выгружать — файл не создан")
        return None
    inbox_dir = _resolve_inbox_dir()
    target = inbox_dir / export_filename()
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=4), encoding="utf-8")
    os.replace(str(tmp), str(target))  # .json появляется атомарно и целиком
    logging.info("записано: %s", target)
    return target
