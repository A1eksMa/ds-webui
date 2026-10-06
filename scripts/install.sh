#!/usr/bin/env bash
#
# Устанавливает макросы AlterOffice (common.py, export_full.py, export_diff.py)
# в папку пользовательских Python-скриптов AlterOffice 5:
#   ~/.config/alteroffice/5/user/Scripts/python
#
# Создаёт папку, если её ещё нет. Идемпотентно — можно запускать повторно
# (например, после обновления export_full.py/export_diff.py); перед
# перезаписью уже установленного файла делает .bak-копию, чтобы не потерять
# локальную правку INBOX_DIR/LOG_DIR в common.py (см. scripts/README.md
# «Установка»).
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/.config/alteroffice/5/user/Scripts/python"

echo "источник : $SCRIPTS_DIR"
echo "назначение: $DEST_DIR"

mkdir -p "$DEST_DIR"

for name in common.py export_full.py export_diff.py; do
  src="$SCRIPTS_DIR/$name"
  dst="$DEST_DIR/$name"
  [ -f "$src" ] || { echo "!! не найден $src" >&2; exit 1; }

  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then
    cp "$dst" "$dst.bak"
    echo "  $name: обновлён (прежняя версия сохранена как $name.bak)"
  elif [ -f "$dst" ]; then
    echo "  $name: без изменений"
  else
    echo "  $name: установлен"
  fi
  cp "$src" "$dst"
done

echo "Готово. В AlterOffice: Сервис → Макросы → Организовать макросы → Python →"
echo "  export_full / export_diff. Не забудь задать INBOX_DIR (и, при необходимости,"
echo "  LOG_DIR) в $DEST_DIR/common.py — install.sh их не трогает автоматически."
