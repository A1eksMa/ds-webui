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
      basePreset = App.basePreset, normalizePreset = App.normalizePreset,
      mergeManifests = App.mergeManifests;
  var loadSourceScript = App.loadSourceScript, download = App.download, storage = App.storage,
      loadGlobal = App.loadGlobal, loadManifest = App.loadManifest,
      loadManifestFragments = App.loadManifestFragments;
  var joinSources = App.joinSources, applyConditions = App.applyConditions,
      visibleColumns = App.visibleColumns, applyAdvanced = App.applyAdvanced,
      applySort = App.applySort;
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
    // Крах-watchdog: выставляется здесь, до любой тяжёлой работы (загрузка
    // источников, JOIN/resolveEntities/parseTypes на потенциально огромном
    // датасете — память может не хватить ещё до всякого рендера DOM) и до
    // первого dispatch, поэтому армирует даже путь "ничего не выбрано"
    // (снимается чуть ниже самим render(), см. там). Снимается только после
    // подтверждённой отрисовки «Таблицы» (render(), ниже) или после явной
    // ошибки сборки — обе ветки terminal для этой попытки.
    storage.set('renderWatchdog', true);
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
      // Ленивый columnar-формат (ds-webui/docs/contract.md): box.columns[label] —
      // функция, возвращающая массив значений по всем строкам (позиционно, по
      // индексу). Вызываем ТОЛЬКО геттеры реально нужных колонок (ключ + выбранные
      // показатели) — остальные V8 не материализует (ленивая компиляция функций),
      // ради этого формат и существует. Явный undefined на позиции строки —
      // показателя у неё не было (как отсутствующий ключ в старом построчном
      // формате); null — показатель явно удалён (DELETE). Собираем ту же построчную
      // форму { [label]: value, ... }, что ожидает весь остальной конвейер
      // (joinSources/applyConditions/...) — он не знает про columns вообще.
      var selected = names.map(function (n) {
        var box = window.DS.sources[n];
        var key = box.meta.key || 'id';
        var allow = [key].concat(box.meta.labels);           // ключ — тоже выбираемое поле
        var wanted = state.preset.query.sources[n].labels || allow;
        var labels = wanted.filter(function (l) { return allow.indexOf(l) !== -1; });
        var cols = [key].concat(labels.filter(function (l) { return l !== key; }));
        var colValues = {};
        cols.forEach(function (c) { colValues[c] = box.columns[c] ? box.columns[c]() : []; });
        var rowCount = colValues[key] ? colValues[key].length : 0;
        var data = [];
        for (var i = 0; i < rowCount; i++) {
          var row = {};
          cols.forEach(function (c) {
            if (colValues[c][i] !== undefined) row[c] = colValues[c][i];
          });
          data.push(row);
        }
        return { name: n, key: key, labels: labels, data: data };
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
    return {
      dataset: { columns: afterAdv.columns, rows: applySort(afterAdv.rows, state.sortBy) },
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
      var shownRows = applyAdvanced(state.dataset, state.adv).rows.length;
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
      // Крах-watchdog (взводится и в buildDataset выше): столбец/фильтр/
      // сортировка/группировка тоже перестраивают DOM таблицы целиком на
      // каждый вызов (см. комментарий renderGrid в view-table.js) — тот же
      // риск нехватки памяти, что и при первой сборке, поэтому взводим здесь
      // заново при каждом заходе на «Таблицу», не только один раз при старте.
      storage.set('renderWatchdog', true);
      renderExportPanel(state, d);
      renderAdvFilter(state, d);
      renderGrid(state, d);
      // Снимается только после подтверждённого прохода браузера по
      // layout/paint (двойной requestAnimationFrame — сам крах от нехватки
      // памяти обычно случается не в момент выполнения этого JS, а при
      // последующей раскладке/отрисовке огромного DOM уже после возврата из
      // render()). Если флаг найден выставленным при следующей загрузке этой
      // же вкладки (см. bootstrap ниже) — прошлая попытка не досчиталась до
      // подтверждённого кадра.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { storage.set('renderWatchdog', false); });
      });
    } else if (state.buildError) {
      // Явная (не связанная с нехваткой памяти) ошибка сборки — тяжёлого
      // рендера не будет, попытка завершена, снимаем watchdog сразу.
      storage.set('renderWatchdog', false);
    }
    if (state.preset) storage.set('preset', state.preset);
  };

  store.subscribe(render);

  // ---------------------------------------------------------------------------
  // Загрузка манифеста: manifest.js (сегодня -- пишет ds-loader) + произвольное
  // число фрагментов из manifest.imports.js (зарезервировано под отдельный
  // конвертер -- см. docs/contract.md "Кто читает и кто пишет манифест").
  // Слияние -- только на чтении, здесь. bootstrapManifest сама не решает, нужен
  // ли фоллбэк на sample-data (это только для самого первого старта, см.
  // initialBoot) -- просто резолвит то, что нашла по конкретному dir, плюс
  // rawManifest (null, если именно manifest.js не загрузился) для вызывающих,
  // которым это важно знать.
  // ---------------------------------------------------------------------------

  var bootstrapManifest = function (dir) {
    return Promise.all([loadManifest(dir), loadManifestFragments(dir)]).then(function (res) {
      var merged = mergeManifests(res[0], res[1]);
      return { manifest: merged.manifest, dataDir: dir, conflicts: merged.conflicts, rawManifest: res[0] };
    });
  };

  // Кнопка «Обновить манифест» / смена пути на «Настройках» (view-build.js).
  // Никакого фоллбэка на sample-data здесь -- это осознанный путь пользователя,
  // а не автозапуск; если по указанному пути ничего не нашлось, источники
  // просто окажутся пустым списком (viewBuild уже показывает это как есть,
  // не нужно отдельной ошибки) -- см. docs/contract.md.
  var refreshManifest = function (store, dir) {
    bootstrapManifest(dir).then(function (r) {
      store.dispatch({ type: 'manifest/loaded', manifest: r.manifest, dataDir: r.dataDir, conflicts: r.conflicts });
    });
  };

  // Самый первый, автоматический запуск страницы: data/ -> sample-data/ (фоллбэк,
  // только если именно "data/manifest.js" не нашёлся вовсе -- rawManifest===null,
  // не "сторона нашлась, но пуста" -- это не ошибка, не нужно подменять реальные,
  // но пока пустые данные демкой), затем data/base.js (пресет по умолчанию, тоже
  // опциональный файл, см. index.html -- комментарий про "Пресет по умолчанию").
  var initialBoot = function () {
    return bootstrapManifest('data').then(function (r) {
      if (r.rawManifest !== null) return r;
      return bootstrapManifest('sample-data').then(function (r2) {
        return r2.rawManifest !== null ? r2 : Object.assign({}, r2, { dataDir: null });
      });
    }).then(function (r) {
      if (!r.dataDir) return r;
      return loadGlobal(r.dataDir, 'base.js', 'DS_BASE_PRESET').then(function () { return r; });
    });
  };

  // публикуются для ленивых ссылок из view-build.js / view-table.js (onclick)
  App.store = store;
  App.buildDataset = buildDataset;
  App.exportXls = exportXls;
  App.exportCsv = exportCsv;
  App.refreshManifest = refreshManifest;

  initialBoot().then(function (boot) {
    // читаем сохранённое ДО первого полноценного render — иначе он перезапишет
    // ключи текущим (ещё дефолтным) состоянием
    var saved = storage.get('preset');
    var manifest = boot.manifest;

    store.dispatch({
      type: 'manifest/loaded',
      manifest: manifest,
      dataDir: boot.dataDir,
      conflicts: boot.conflicts
    });

    // Крах-watchdog (см. render() выше): если флаг ещё выставлен на старте
    // этой же вкладки — прошлый render() этой вкладки не дошёл до
    // подтверждённого кадра (типичная причина — браузеру не хватило памяти на
    // большой датасет, и вкладка перезапустилась). Без этой проверки
    // сохранённый пресет применился бы заново и мог вызвать тот же крах —
    // цикл без возможности выйти. Вместо него — гарантированно пустой пресет
    // (не basePreset(): data/base.js может сам оказаться тем же большим
    // набором), сохранённый пресет остаётся в sessionStorage нетронутым, его
    // можно открыть вручную через «Конструктор».
    if (storage.get('renderWatchdog')) {
      storage.set('renderWatchdog', false);
      store.dispatch({ type: 'preset/set', preset: normalizePreset({}) });
      store.dispatch({
        type: 'build/error',
        message: 'Прошлая попытка построить таблицу на этой вкладке не завершилась — похоже, '
          + 'браузеру не хватило памяти на выбранный пресет, и вкладка перезапустилась. Чтобы не '
          + 'уйти в цикл, применён пустой пресет. Сохранённый пресет не тронут — его можно открыть '
          + 'вручную через «Конструктор» (например, чтобы сузить выбор источников/показателей '
          + 'перед повторной попыткой).'
      });
      // render(), вызванный обоими dispatch выше, безусловно пере-сохраняет
      // state.preset (см. "if (state.preset) storage.set('preset', ...)" в
      // самом render()) -- то есть только что затёр сохранённый пресет пустым.
      // Восстанавливаем исходный: решение "не применять автоматически" не
      // должно означать "забыть", иначе пропадает весь смысл "можно открыть
      // вручную через «Конструктор»".
      if (saved) storage.set('preset', saved);
      return;
    }

    // sessionStorage привязан к этой вкладке, не ко всему file://-источнику —
    // но сохранённый пресет всё ещё может быть от другого набора данных в
    // ЭТОЙ же вкладке (сменили демку/каталог за время её жизни) и ссылаться на
    // источники, которых тут нет — тогда вместо ошибки "не загрузились
    // источники" при первой сборке молча откатываемся к пресету каталога
    // (data/base.js) или пустому.
    var savedFitsManifest = saved && Object.keys((saved.query && saved.query.sources) || {})
      .every(function (n) { return manifestSource({ manifest: manifest }, n); });
    store.dispatch({ type: 'preset/set', preset: savedFitsManifest ? saved : basePreset() });
    // применить пресет по умолчанию и сразу открыть таблицу; при ошибке
    // (нет данных / нет источника) buildDataset оставит пользователя в конструкторе
    buildDataset(store);
  });

})();
