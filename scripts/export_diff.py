# -*- coding: utf-8 -*-
"""Выгрузка ТОЛЬКО изменений, внесённых пользователем во вкладке `user`
Excel-файла, выгруженного веб-мордой ds-webui.

Файл ds-webui содержит две вкладки с одинаковыми данными:
  * `user`   — пользователь правит здесь;
  * `system` — эталонная копия, не меняется.

Что попадает в выгрузку:
  ┌─────────────────────────────────────────────┬──────────────────────────────┐
  │ действие пользователя                        │ в выгрузке                   │
  ├─────────────────────────────────────────────┼──────────────────────────────┤
  │ изменил значение существующей ячейки         │ да                           │
  │ добавил новый заголовок / показатель (label) │ да — весь столбец            │
  │ добавил строку с новым id (нет в `system`)   │ НЕТ — строка игнорируется    │
  │ удалил строку / ничего не менял              │ нет                          │
  └─────────────────────────────────────────────┴──────────────────────────────┘
Ничего не изменилось -> файл не создаётся.

Строки сопоставляются по ключевому столбцу (позиция 0 листа `user`, либо
`KEY_COLUMN`). Прочий разбор листа — как в `export_full` (пустой/дублирующийся
заголовок пропускается, значения -> строки).

Вкладки ищутся по именам `user`/`system`; если имена не сохранились
(LibreOffice/AlterOffice не читают лист-метаданные из MSO-HTML `.xls` веб-морды)
— берутся листы с индексами 0 и 1.

Ограничение колоночного формата: для оставленной строки в выгрузку попадают все
её изменённые/новые столбцы целиком; неизменённая ячейка в такой строке уедет в
`ds` повторной записью того же значения — формат `ds` не умеет «эту ячейку не
трогать». Оверхед ограничен (изменённые id × изменённые label).
"""
import logging

import common

USER_SHEET = "user"
SYSTEM_SHEET = "system"
KEY_COLUMN = ""  # имя ключевого столбца; пусто -> первый столбец листа `user`

g_exportedScripts = ()  # переопределяется ниже


def _same(a: str, b: str) -> bool:
    """Равенство значений с числовой терпимостью: '10' == '10.00'.
    Защищает от коэрсии офиса ('99.00' -> 99.0) при сравнении вкладок."""
    if a == b:
        return True
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return False


def diff_columns(user_headers, user_cols, sys_cols, key_header):
    """Чистая функция: два разобранных листа -> columnar-словарь только с изменённым."""
    sys_keys = [common.cell_str(k) for k in sys_cols.get(key_header, [])]
    sys_row = {k: i for i, k in enumerate(sys_keys)}
    data_headers = [h for h in user_headers if h != key_header]

    def changed(h, ui):
        u = user_cols[h][ui]
        if h not in sys_cols:                 # новый показатель
            return u != ""                   # пустая ячейка нового столбца — не изменение
        si = sys_row[common.cell_str(user_cols[key_header][ui])]
        return not _same(u, sys_cols[h][si])

    kept = []  # индексы строк листа `user`, которые оставляем
    for ui, raw_key in enumerate(user_cols[key_header]):
        k = common.cell_str(raw_key)
        if k == "":
            continue
        if k not in sys_row:
            logging.info("новый идентификатор %r — пропущен", k)
            continue
        if any(changed(h, ui) for h in data_headers):
            kept.append(ui)

    if not kept:
        return {}

    out = {key_header: [common.cell_str(user_cols[key_header][ui]) for ui in kept]}
    for h in data_headers:
        if any(changed(h, ui) for ui in kept):
            out[h] = [user_cols[h][ui] for ui in kept]
    return out


def export_diff(*_args):
    common.setup_logging()
    logging.info("export_diff: старт")
    try:
        doc = XSCRIPTCONTEXT.getDocument()  # noqa: F821
        sheets = doc.getSheets()
        if sheets.Count < 2:
            logging.error("нужны обе вкладки (user и system) — выгрузка отменена")
            return

        user_headers, user_cols = common.sheet_columns(common.get_sheet(sheets, USER_SHEET, 0))
        _sys_headers, sys_cols = common.sheet_columns(common.get_sheet(sheets, SYSTEM_SHEET, 1))

        if not user_headers:
            logging.warning("вкладка user пуста — ничего не выгружено")
            return

        key_header = KEY_COLUMN or user_headers[0]
        if key_header not in user_cols:
            logging.error("ключевой столбец %r не найден на вкладке user", key_header)
            return
        if key_header not in sys_cols:
            logging.error("ключевой столбец %r не найден на вкладке system", key_header)
            return

        result = diff_columns(user_headers, user_cols, sys_cols, key_header)
        if not result:
            logging.info("изменений не найдено — файл не создан")
            return

        common.write_json(result)
        logging.info(
            "выгружено: %d строк, столбцы %s",
            len(result[key_header]),
            [h for h in result if h != key_header],
        )
    except Exception:
        logging.exception("export_diff: сбой")
        raise


g_exportedScripts = (export_diff,)
