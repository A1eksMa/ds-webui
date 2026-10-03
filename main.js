'use strict';

// Точка сборки: buildDataset (грузит источники, джойнит, резолвит сущности),
// триггеры экспорта, создание store и цикл рендера, bootstrap. Только
// браузер — использует document/window напрямую, в Node не требуется и не
// экспортируется. Должен грузиться последним (после всех остальных <script>).
//
// window.DS_APP.store / .buildDataset / .exportXls / .exportCsv публикуются
// явно — на них есть обратные (ленивые) ссылки из view-build.js/view-table.js,
// которые сами загружаются раньше main.js.
(function () {

  var App = window.DS_APP;
  var el = App.el, clear = App.clear, fmtDate = App.fmtDate;
  var selectedNames = App.selectedNames, manifestSource = App.manifestSource,
      createStore = App.createStore, reducer = App.reducer, initialState = App.initialState,
      basePreset = App.basePreset;
  var loadSourceScript = App.loadSourceScript, download = App.download, storage = App.storage;
  var joinSources = App.joinSources, applyConditions = App.applyConditions,
      visibleColumns = App.visibleColumns, applyAdvanced = App.applyAdvanced,
      applyFilters = App.applyFilters, applySort = App.applySort;
  var implicitEntities = App.implicitEntities, resolveEntities = App.resolveEntities,
      parseTypes = App.parseTypes, colWidthPx = App.colWidthPx, columnTypesFor = App.columnTypesFor;
  var toCsv = App.toCsv, toXlsWorkbook = App.toXlsWorkbook, exportFilename = App.exportFilename;
  var viewNav = App.viewNav, viewFooter = App.viewFooter, viewBuild = App.viewBuild,
      viewEntities = App.viewEntities, viewTableShell = App.viewTableShell,
      renderAdvFilter = App.renderAdvFilter, renderExportPanel = App.renderExportPanel,
      renderGrid = App.renderGrid;

  // ---------------------------------------------------------------------------
  // Эффект построения датасета (грузит источники, джойнит)
  // ---------------------------------------------------------------------------

  var buildDataset = function (store) {
    var state = store.getState();
    var names = selectedNames(state.preset);
    if (!names.length) {
      store.dispatch({ type: 'build/error', message: 'Не выбрано ни одного источника' });
      return;
    }
    if (!state.dataDir) {
      store.dispatch({ type: 'build/error', message: 'Нет каталога данных (data/ или sample-data/)' });
      return;
    }
    store.dispatch({ type: 'build/start' });

    Promise.allSettled(names.map(function (n) {
      var ms = manifestSource(state, n);
      return ms ? loadSourceScript(state.dataDir, ms.file, n) : Promise.reject(new Error(n));
    })).then(function (results) {
      var failed = results
        .map(function (r, i) { return r.status === 'rejected' ? names[i] : null; })
        .filter(Boolean);
      if (failed.length) {
        store.dispatch({ type: 'build/error', message: 'Не загрузились источники: ' + failed.join(', ') });
        return;
      }
      var selected = names.map(function (n) {
        var box = window.DS.sources[n];
        var key = box.meta.key || 'id';
        var allow = [key].concat(box.meta.labels);           // ключ — тоже выбираемое поле
        var wanted = state.preset.query.sources[n].labels || allow;
        return {
          name: n,
          key: key,
          labels: wanted.filter(function (l) { return allow.indexOf(l) !== -1; }),
          data: box.data
        };
      });
      var joined = joinSources(selected, state.preset.view.joins || []);
      if (!joined.columns.length) {
        store.dispatch({ type: 'build/error', message: 'Не выбрано ни одного поля для отображения' });
        return;
      }
      // первый проход: условия «Настроек» — по сырым полям источников, сразу после
      // JOIN, до расчёта индикаторов (см. view-build.js)
      var sliced = applyConditions(joined, state.preset.view.conditions || []);
      var sourceLabels = {};
      selected.forEach(function (s) { sourceLabels[s.name] = s.labels; });
      var columnTypes = columnTypesFor(sourceLabels, state.manifest.sources);
      var ents = state.preset.view.entities.length
        ? state.preset.view.entities
        : implicitEntities(sliced.columns, columnTypes);
      var re = resolveEntities(sliced, ents);
      var typed = parseTypes(re, ents, re.columns);
      // второй проход: условия «Индикаторов» — по именам индикаторов, после расчёта
      // (см. view-entities.js); индикаторы, скрытые из таблицы, тут всё ещё видны
      var dataset = applyConditions(typed, state.preset.view.entityConditions || []);
      // сущности с итоговыми (дедуплицированными) именами — для renderGrid / applySort
      dataset.entities = ents.map(function (e, i) { return Object.assign({}, e, { name: re.columns[i] }); });
      // скрытые индикаторы — считаются и доступны условиям выше, но не выводятся
      // в таблицу/экспорт (см. visibleColumns в dataset.js)
      dataset.hiddenColumns = dataset.entities.filter(function (e) { return e.hidden; })
        .map(function (e) { return e.name; });
      // срез, с которым сделана ИМЕННО эта сборка — не state.preset.query.as_of напрямую:
      // его можно поменять в «Конструкторе» и вернуться на «Таблицу» без пересборки
      dataset.as_of = state.preset.query.as_of;
      store.dispatch({ type: 'build/success', dataset: dataset });
      store.dispatch({ type: 'route/set', route: 'table' });
    });
  };

  // ---------------------------------------------------------------------------
  // Экспорт в CSV/Excel — учитывает все слои фильтрации и сортировку
  // ---------------------------------------------------------------------------

  var exportDataset = function (state) {
    var cols = visibleColumns(state.dataset, state.hideEmpty);
    var afterAdv = applyAdvanced(state.dataset, state.adv);
    var afterQuick = applyFilters(afterAdv, state.tableFilters);
    return {
      dataset: { columns: afterQuick.columns, rows: applySort(afterQuick.rows, state.sort) },
      columns: cols
    };
  };

  var exportXls = function (state) {
    if (!state.dataset) return;
    var e = exportDataset(state);
    var W = colWidthPx(state);
    // px → пункты (1px @96dpi = 0.75pt): пропорции сохраняются, значения в разумных рамках
    var widthsPt = e.columns.map(function (c) {
      return Math.max(24, Math.min(720, Math.round(W(c) * 0.75)));
    });
    download(exportFilename(null, 'xls'),
      toXlsWorkbook(e.dataset, e.columns, widthsPt), 'application/vnd.ms-excel');
  };

  var exportCsv = function (state) {
    if (!state.dataset) return;
    var e = exportDataset(state);
    download(exportFilename(null, 'csv'), toCsv(e.dataset, e.columns), 'text/csv');
  };

  // ---------------------------------------------------------------------------
  // Монтаж и рендер
  // ---------------------------------------------------------------------------

  var store = createStore(reducer, initialState);
  var root = document.getElementById('app');
  var footerNode = document.body.appendChild(el('footer', { class: 'statusbar' }));
  var lastRoute = null;
  var lastDataset = null;   // ссылка, не сигнатура — build/success всегда создаёт новый объект
  var lastAdvOpen = null;
  var lastExportOpen = null;

  // единая информационная строка внизу окна: источник данных + (на «Таблице»,
  // когда датасет уже построен) пресет/срез/строки-после-фильтров/колонки —
  // раньше это были две отдельные строки в разных местах страницы
  var footerText = function (state) {
    var parts = [state.dataDir ? ('Путь: ' + state.dataDir) : 'Путь: не найден (нет ни data, ни sample-data)'];
    if (state.route === 'table' && state.dataset) {
      var cols = visibleColumns(state.dataset, state.hideEmpty);
      var afterAdv = applyAdvanced(state.dataset, state.adv);
      var shownRows = applyFilters(afterAdv, state.tableFilters).rows.length;
      parts.push(
        'Пресет: ' + state.preset.name,
        'Источники: ' + selectedNames(state.preset).join(' + '),
        'Срез: ' + (state.dataset.as_of != null ? fmtDate(state.dataset.as_of) : 'текущий момент'),
        'Строк: ' + shownRows + ' из ' + state.dataset.rows.length,
        'Столбцов: ' + cols.length
      );
    }
    return parts.join(' · ');
  };

  var render = function (state) {
    var d = store.dispatch;

    // только «Таблица» зажата в 100vh (см. body.route-table в styles.css) —
    // .scroll внутри нужно реально сжимать, чтобы включился его внутренний
    // скролл (и с ним — sticky-шапка). Другим страницам это не нужно, они
    // растут естественно и скроллят всю страницу, когда контента много.
    document.body.classList.toggle('route-table', state.route === 'table');

    clear(footerNode).appendChild(viewFooter(footerText(state), !state.dataDir));

    if (!state.manifest || !state.preset) {
      clear(root).appendChild(el('p', { class: 'muted', style: 'padding:1rem' }, 'Инициализация…'));
      return;
    }

    // первое построение (пресет по умолчанию) — без мелькания конструктора
    if (state.building && !state.dataset) {
      clear(root);
      root.appendChild(viewNav(state, d));
      root.appendChild(el('section', { class: 'page' },
        el('p', { class: 'muted' }, 'Открываю таблицу по пресету по умолчанию…')));
      lastRoute = null;
      lastDataset = null;
      return;
    }

    // Пересоздать шапку/тело страницы, только когда действительно нужно: сменился
    // маршрут, случилась НОВАЯ сборка (build/success — всегда новая ссылка на
    // dataset, даже если её форма совпала с предыдущей: например, изменился только
    // as_of или имя пресета, а колонки/число строк те же) или открылась/закрылась
    // область экспорта/расширенного фильтра над таблицей (от этого зависит и
    // индикатор ▸/▾ в самом навбаре, не только тело страницы). Раньше вместо
    // ссылки сравнивалась сигнатура "columns+rows.length" — она совпадала для
    // двух РАЗНЫХ сборок с одинаковой формой, и шапка (там же — имя пресета и
    // срез as_of) оставалась от старой сборки.
    var shellChanged = state.route !== lastRoute || state.dataset !== lastDataset
      || state.advOpen !== lastAdvOpen || state.exportOpen !== lastExportOpen;

    if (shellChanged || root.children.length < 2) {
      clear(root);
      root.appendChild(viewNav(state, d));
      root.appendChild(
        state.route === 'build' ? viewBuild(state, d)
          : state.route === 'entities' ? viewEntities(state, d)
          : viewTableShell(state, d)
      );
      lastRoute = state.route;
      lastDataset = state.dataset;
      lastAdvOpen = state.advOpen;
      lastExportOpen = state.exportOpen;
    } else if (state.route === 'build') {
      // build-страница: переть целиком (инпуты — на onchange, фокус не теряется)
      root.replaceChild(viewBuild(state, d), root.children[1]);
    } else if (state.route === 'entities') {
      root.replaceChild(viewEntities(state, d), root.children[1]);
    }

    if (state.route === 'table') {
      renderExportPanel(state, d);
      renderAdvFilter(state, d);
      renderGrid(state, d);
    }
    if (state.preset) storage.set('preset', state.preset);
  };

  store.subscribe(render);

  // публикуются для ленивых ссылок из view-build.js / view-table.js (onclick)
  App.store = store;
  App.buildDataset = buildDataset;
  App.exportXls = exportXls;
  App.exportCsv = exportCsv;

  window.__ds.ready.then(function (boot) {
    // читаем сохранённое ДО первого полноценного render — иначе он перезапишет
    // ключи текущим (ещё дефолтным) состоянием
    var saved = storage.get('preset');
    var manifest = (boot && boot.manifest) || { sources: [] };

    store.dispatch({
      type: 'manifest/loaded',
      manifest: manifest,
      dataDir: boot ? boot.dataDir : null
    });
    // localStorage общий на весь file://-источник и не привязан к конкретному
    // data/ каталогу: сохранённый пресет может быть от другого набора данных
    // (сменили демку/каталог) и ссылаться на источники, которых тут нет —
    // тогда вместо ошибки "не загрузились источники" при первой сборке молча
    // откатываемся к пресету каталога (data/base.js) или пустому.
    var savedFitsManifest = saved && Object.keys((saved.query && saved.query.sources) || {})
      .every(function (n) { return manifestSource({ manifest: manifest }, n); });
    store.dispatch({ type: 'preset/set', preset: savedFitsManifest ? saved : basePreset() });
    // применить пресет по умолчанию и сразу открыть таблицу; при ошибке
    // (нет данных / нет источника) buildDataset оставит пользователя в конструкторе
    buildDataset(store);
  });

})();
