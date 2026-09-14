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
  var el = App.el, clear = App.clear;
  var selectedNames = App.selectedNames, manifestSource = App.manifestSource,
      createStore = App.createStore, reducer = App.reducer, initialState = App.initialState,
      basePreset = App.basePreset;
  var loadSourceScript = App.loadSourceScript, download = App.download, storage = App.storage;
  var joinSources = App.joinSources, applyConditions = App.applyConditions,
      visibleColumns = App.visibleColumns, applyAdvanced = App.applyAdvanced,
      applyFilters = App.applyFilters, applySort = App.applySort;
  var implicitEntities = App.implicitEntities, resolveEntities = App.resolveEntities,
      parseTypes = App.parseTypes, colWidthPx = App.colWidthPx;
  var toCsv = App.toCsv, toXlsWorkbook = App.toXlsWorkbook, exportFilename = App.exportFilename;
  var viewNav = App.viewNav, viewBuild = App.viewBuild,
      viewTableShell = App.viewTableShell, renderAdvFilter = App.renderAdvFilter, renderGrid = App.renderGrid;

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
      var ents = state.preset.view.entities.length
        ? state.preset.view.entities
        : implicitEntities(joined.columns);
      var re = resolveEntities(joined, ents);
      var typed = parseTypes(re, ents, re.columns);
      var dataset = applyConditions(typed, state.preset.view.conditions || []);
      // сущности с итоговыми (дедуплицированными) именами — для renderGrid / applySort
      dataset.entities = ents.map(function (e, i) { return Object.assign({}, e, { name: re.columns[i] }); });
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
    download(exportFilename(state.author, 'xls'),
      toXlsWorkbook(e.dataset, e.columns, widthsPt), 'application/vnd.ms-excel');
  };

  var exportCsv = function (state) {
    if (!state.dataset) return;
    var e = exportDataset(state);
    download(exportFilename(state.author, 'csv'), toCsv(e.dataset, e.columns), 'text/csv');
  };

  // ---------------------------------------------------------------------------
  // Монтаж и рендер
  // ---------------------------------------------------------------------------

  var store = createStore(reducer, initialState);
  var root = document.getElementById('app');
  var lastRoute = null;
  var lastDatasetSig = null;
  var lastAdvOpen = null;

  var render = function (state) {
    var d = store.dispatch;

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
      lastDatasetSig = null;
      return;
    }

    var datasetSig = state.dataset ? state.dataset.columns.join('|') + ':' + state.dataset.rows.length : null;
    var shellChanged = state.route !== lastRoute || datasetSig !== lastDatasetSig
      || state.advOpen !== lastAdvOpen;

    if (shellChanged || root.children.length < 2) {
      clear(root);
      root.appendChild(viewNav(state, d));
      root.appendChild(state.route === 'build' ? viewBuild(state, d) : viewTableShell(state, d));
      lastRoute = state.route;
      lastDatasetSig = datasetSig;
      lastAdvOpen = state.advOpen;
    } else if (state.route === 'build') {
      // build-страница: переть целиком (инпуты — на onchange, фокус не теряется)
      root.replaceChild(viewBuild(state, d), root.children[1]);
    }

    document.body.classList.toggle('grid-wide', !!state.wideTable && state.route === 'table');

    if (state.route === 'table') {
      renderAdvFilter(state, d);
      renderGrid(state, d);
    }
    if (state.preset) storage.set('preset', state.preset);
    storage.set('author', state.author);
    storage.set('wideTable', state.wideTable);
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
    var savedAuthor = storage.get('author');
    var savedWide = storage.get('wideTable') === true;

    store.dispatch({
      type: 'manifest/loaded',
      manifest: (boot && boot.manifest) || { sources: [] },
      dataDir: boot ? boot.dataDir : null
    });
    store.dispatch({ type: 'preset/set', preset: saved || basePreset() });
    if (typeof savedAuthor === 'string') {
      store.dispatch({ type: 'ui/setAuthor', value: savedAuthor });
    }
    store.dispatch({ type: 'ui/setWideTable', value: savedWide });
    // применить пресет по умолчанию и сразу открыть таблицу; при ошибке
    // (нет данных / нет источника) buildDataset оставит пользователя в конструкторе
    buildDataset(store);
  });

})();
