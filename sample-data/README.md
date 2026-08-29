# sample-data/

Фиктивный, но **настоящий** набор для разработки UI: сгенерирован реальным `ds get` из
двух источников, затем обёрнут в `.js` и снабжён манифестом — ровно как это будет делать
поллер. Формат — [`../docs/contract.md`](../docs/contract.md).

| Файл | Что |
|---|---|
| `CRM.js` | `window.DS.sources["CRM"]` — 4 объекта, показатели `email` / `phone` / `status` |
| `ERP.js` | `window.DS.sources["ERP"]` — 3 объекта, показатели `price` / `stock`, ключ `client_ref` |
| `manifest.js` | `window.DS_MANIFEST` — индекс + свежесть по каждому источнику |

## Что этот набор демонстрирует

- **POST** — `CRM/102.email` = `bob.new@example.com` (перезапись из второго батча), `status` = `vip`.
- **DELETE → null** — `CRM/103.phone` и `ERP/102.stock` равны `null` (значение удалено в источнике).
- **Отсутствие ключа ≠ null** — у `CRM/104` нет ключа `phone` (транзакции не было).
- **LEFT JOIN с непопаданием** — `ERP/999` (`client_ref`) не имеет пары в CRM; `CRM/103`, `104`
  не имеют пары в ERP. Джойн `CRM.customer_id ↔ ERP.client_ref` (см. `../presets.js`).
- **Устаревание** — в `manifest.js` у `CRM` `db_max_cnt` (21) > `gen_max_cnt` (13): после
  генерации файла в базу пришла ещё одна CRM-транзакция → источник помечается «пересобрать».
  У `ERP` они равны — свежий.

## Регенерация

```bash
python tools/gen_sample.py            # рядом должен лежать чекаут A1eksMa/ds  (../ds)
DS_REPO=/path/to/ds python tools/gen_sample.py
```

Скрипт детерминирован (`generated_at` запинён), так что осмысленный diff = только реальное
изменение данных/формата.

## Использование в приложении

Пока страница грузит `data/manifest.js`. Для работы с примером:

```bash
cp sample-data/* data/    # затем открыть index.html
```

(в дальнейшем предполагается dev-режим, подхватывающий `sample-data/` напрямую).
