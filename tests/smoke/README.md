# tests/smoke/

Ручная проверка, отдельно от `node --test` / `./run_tests.sh`.

`dom-smoke.js` реально выполняет последовательность `<script>` из `index.html` —
включая настоящий bootstrap (`window.DS` / `window.__ds`, fallback `data/` →
`sample-data/`) и настоящий `sample-data/` — в минимальном самодельном DOM-стабе
(без jsdom, без npm-зависимостей: `document`/`window`/`localStorage` на десяток
методов, ровно то, что использует код). Ловит то, что тесты на чистые функции
не видят: забытый экспорт в `window.DS_APP`, неправильный порядок `<script>` в
`index.html`, сломанную ленивую ссылку (`view-build.js`/`view-table.js` →
`window.DS_APP.store`/`buildDataset`/`exportXls`/`exportCsv` из `main.js`).

Не запускается автоматически — файл не подпадает под автообнаружение
`node --test` (оно ищет `*.test.js`/`*-test.js`/`*_test.js`, а не любой файл в
`tests/`). Запуск:

```bash
node tests/smoke/dom-smoke.js
```

Стаб покрывает ровно то, что нужно для одного прохода бутстрапа (загрузка
манифеста и источников, JOIN, переход на «Таблицу», рендер грида) — не замена
настоящего браузера. Если функциональность трогает DOM API, которого здесь нет
(реальный `querySelector`, CSSOM, `getBoundingClientRect`, пользовательские клики
на кнопках экспорта/резайза столбцов), этот тест её не проверит.
