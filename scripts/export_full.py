# -*- coding: utf-8 -*-
"""Выгрузка ВСЕГО активного листа в колоночный JSON для ds-loader.

Исправленная версия исходного `export_json.py`:
  * баг формата времени `%m` -> `%M` (были месяцы вместо минут);
  * время в UTC (у ds-loader `filename_tz="utc"` по умолчанию);
  * имя пользователя санитизируется (без `_`);
  * файл кладётся в `common.INBOX_DIR` (папка ds-loader), а не рядом со скриптом;
  * атомарная запись (tmp + rename);
  * данные считаются ДО открытия файла; пустой лист -> файл не создаётся;
  * ошибки логируются (`logging.exception`).

Назначение: первичная загрузка источника из свежей таблицы. Для round-trip
правок из веб-морды используется `export_diff.py`.

Лист: активный (индекс 0) либо заданный в `SHEET`.
"""
import inspect
import logging
import os
import sys

# Провайдер офисного пакета exec()-ит каждый скрипт в свежий модуль, не добавляя
# его папку в sys.path (в отличие от обычного запуска `python script.py`) —
# без этого `import common` падает с ModuleNotFoundError, даже когда common.py
# лежит рядом. __file__ в этом exec-механизме не гарантирован — берём путь через
# inspect.currentframe(): traceback показывает, что реальный путь файла в
# compile() всё же попадает.
_SCRIPT_DIR = os.path.dirname(inspect.getfile(inspect.currentframe()))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import common

SHEET = ""  # имя листа; пусто -> активный (индекс 0)


def export_full(*_args):
    common.setup_logging()
    logging.info("export_full: старт")
    try:
        doc = XSCRIPTCONTEXT.getDocument()  # noqa: F821 — внедряется офисным пакетом
        sheets = doc.getSheets()
        sheet = common.get_sheet(sheets, SHEET, 0)

        _headers, columns = common.sheet_columns(sheet)
        if not columns:
            logging.warning("лист пуст или без валидных заголовков — ничего не выгружено")
            return

        common.write_json(columns)
    except Exception:
        logging.exception("export_full: сбой")
        raise


g_exportedScripts = (export_full,)
