'use strict';

// Store: фабрика createStore (reducer + dispatch + subscribe), селекторы
// состояния, нормализация пресета, редьюсер, (де)сериализация пресета в файл.
// Зависит от util.js (omit/setIn/_swap), dataset.js (OP_IDS/JOIN_TYPE_IDS),
// entities.js (normalizeEntities/mergeEntity/_entityColumns),
// effects.js (download/readFile).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./util.js'), require('./dataset.js'), require('./entities.js'), require('./effects.js')
    );
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, factory(root.DS_APP, root.DS_APP, root.DS_APP, root.DS_APP));
  }
})(typeof window !== 'undefined' ? window : this, function (Util, Dataset, Entities, Effects) {

  var omit = Util.omit, setIn = Util.setIn, _swap = Util._swap;
  var OP_IDS = Dataset.OP_IDS, JOIN_TYPE_IDS = Dataset.JOIN_TYPE_IDS;
  var normalizeEntities = Entities.normalizeEntities, mergeEntity = Entities.mergeEntity,
      _entityColumns = Entities._entityColumns, columnType = Entities.columnType;
  var download = Effects.download, readFile = Effects.readFile, storage = Effects.storage;

  var isStale = function (ms) { return ms.db_max_cnt > ms.gen_max_cnt; };

  var manifestSource = function (state, name) {
    return (state.manifest.sources || []).find(function (s) { return s.name === name; });
  };

  var selectedNames = function (preset) { return Object.keys(preset.query.sources); };

  var createStore = function (reducer, initial) {
    var state = initial;
    var listeners = new Set();
    return {
      getState: function () { return state; },
      dispatch: function (action) {
        state = reducer(state, action);
        listeners.forEach(function (l) { l(state, action); });
      },
      subscribe: function (l) { listeners.add(l); return function () { listeners.delete(l); }; }
    };
  };

  // Данные, не код: window.DS_BASE_PRESET грузится инъекцией <script> из
  // sample-data/base.js или data/base.js (см. index.html) — не хардкод в
  // presets.js, как раньше. Нет ни того, ни другого -> пустой пресет.
  var basePreset = function () {
    return JSON.parse(JSON.stringify(window.DS_BASE_PRESET || {
      name: 'base', query: { as_of: null, sources: {} },
      view: { joins: [], conditions: [], entities: [], column_widths: {} }
    }));
  };

  // Связки — не свободный список, а по одной на каждый выбранный источник,
  // кроме первого (базового): источник входит в выборку в порядке выбора
  // (порядок ключей query.sources), и каждый следующий присоединяется к уже
  // накопленному множеству (как SQL: table JOIN t2 JOIN t3 ...), а не к
  // случайной паре. order — имена источников в порядке выбора; для order[i]
  // (i>=1) допустимое "слева" — только то, что уже накоплено к этому шагу,
  // т.е. order[0..i-1]. Существующая связка сохраняется, только если её left
  // всё ещё входит в этот набор (иначе источник, на который она ссылалась,
  // убрали/переставили — сбрасываем на выбор заново).
  var reconcileJoins = function (order, joins) {
    var byRight = {};
    (joins || []).forEach(function (j) { if (j && j.right) byRight[j.right] = j; });
    return order.slice(1).map(function (name, i) {
      var earlier = order.slice(0, i + 1);
      var existing = byRight[name];
      var validLeft = existing && earlier.indexOf(existing.left) !== -1;
      return {
        left: validLeft ? existing.left : (earlier.length === 1 ? earlier[0] : ''),
        left_field: validLeft ? (existing.left_field || '') : '',
        right: name,
        right_field: (existing && existing.right_field) || '',
        // старые пресеты без type — раньше был всегда LEFT JOIN
        type: existing && JOIN_TYPE_IDS.indexOf(existing.type) !== -1 ? existing.type : 'left'
      };
    });
  };

  // Пресет из произвольного объекта → нормализованная форма
  var normalizePreset = function (raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var query = raw.query || {};
    var view = raw.view || {};
    var sources = query.sources || {};
    var normSources = {};
    Object.keys(sources).forEach(function (name) {
      var spec = sources[name];
      normSources[name] = { labels: Array.isArray(spec && spec.labels) ? spec.labels.slice() : null };
    });
    return {
      name: typeof raw.name === 'string' ? raw.name : 'preset',
      // Человекочитаемый заголовок страницы «Таблица» (viewNav, view-common.js).
      // Отдельно от `name` (который уходит в имя файла при скачивании) — можно
      // поправить прямо в сохранённом .json текстовым редактором, не трогая имя
      // файла. По умолчанию пусто (не "preset" и не имя файла) -- нулевой
      // пресет без единого выбранного источника не должен показывать никакой
      // заголовок.
      description: typeof raw.description === 'string' ? raw.description : '',
      query: {
        as_of: query.as_of == null ? null : Number(query.as_of),
        sources: normSources
      },
      view: {
        joins: reconcileJoins(Object.keys(normSources), Array.isArray(view.joins) ? view.joins : []),
        conditions: normalizeConditions(view, 'conditions'),
        entityConditions: normalizeConditions(view, 'entityConditions'),
        entities: normalizeEntities(view),
        column_widths: normalizeColWidths(view)
      }
    };
  };

  // view.column_widths { "<столбец>": px } — ручная ширина столбцов «Таблицы»
  var normalizeColWidths = function (view) {
    var cw = view && typeof view.column_widths === 'object' && view.column_widths ? view.column_widths : {};
    var out = {};
    Object.keys(cw).forEach(function (k) {
      var n = Number(cw[k]);
      if (isFinite(n) && n > 0) out[k] = Math.round(n);
    });
    return out;
  };

  // view[key] [{field, op, value}] — список условий; для key='conditions' (условия
  // «Настроек», по сырым полям источников) ещё мигрирует старый view.column_filters
  // ({column: substring} -> оператор contains). key='entityConditions' — условия
  // «Индикаторов», по именам сущностей, считаются вторым проходом после резолва.
  var normalizeConditions = function (view, key) {
    key = key || 'conditions';
    var raw = Array.isArray(view[key]) ? view[key] : [];
    var out = raw.map(function (c) {
      c = c && typeof c === 'object' ? c : {};
      return {
        field: typeof c.field === 'string' ? c.field : '',
        op: OP_IDS.indexOf(c.op) !== -1 ? c.op : 'contains',
        value: c.value == null ? '' : String(c.value)
      };
    }).filter(function (c) { return c.field !== '' || c.value !== ''; });
    if (key === 'conditions' && view.column_filters && typeof view.column_filters === 'object') {
      Object.keys(view.column_filters).forEach(function (col) {
        var v = view.column_filters[col];
        if (v != null && String(v).trim() !== '') {
          out.push({ field: col, op: 'contains', value: String(v) });
        }
      });
    }
    return out;
  };

  var initialState = {
    route: 'build',
    manifest: null,
    dataDir: null,
    preset: null,
    building: false,
    buildError: null,
    dataset: null,
    groupBy: [],             // список полей группировки — применяются последовательно (вложенно)
    hideEmpty: false,
    expanded: {},
    srcOpen: {},              // конструктор: у каких источников развёрнут список показателей
    // расширенный фильтр и быстрые пиктограммы в заголовке таблицы читают/пишут
    // ОДНО и то же состояние (adv/sortBy) — пиктограммы лишь быстро дополняют то,
    // что полноценно редактируется в панели "Расширенный фильтр"; не в пресете.
    adv: [],                 // условия отбора: {field, op, value, conj} -- И/ИЛИ между строками
    advOpen: false,          // область расширенного фильтра над таблицей развёрнута
    sortBy: [],              // [{ col, dir: 'asc'|'desc' }] -- порядок уровней = приоритет
    quickOpen: {},           // { [column]: 'search'|'filter'|null } -- какой quick-слот открыт
    // "Показать N" в выпадающем списке уникальных значений; 0 -- валидное значение
    // (выключает список), поэтому не "|| 10", а явная проверка на число.
    quickValuesLimit: (function () {
      var saved = storage.get('quickValuesLimit');
      return typeof saved === 'number' && isFinite(saved) && saved >= 0 ? saved : 10;
    })(),
    exportFormat: 'xls',     // выбор формата в области экспорта ('xls' | 'csv')
    exportOpen: false        // область экспорта над таблицей развёрнута
  };

  var reducer = function (state, a) {
    switch (a.type) {

      case 'manifest/loaded':
        return Object.assign({}, state, { manifest: a.manifest, dataDir: a.dataDir });

      case 'route/set':
        return Object.assign({}, state, { route: a.route });

      case 'preset/set':
        return Object.assign({}, state, { preset: normalizePreset(a.preset), buildError: null });

      case 'preset/setName':
        return setIn(state, ['preset', 'name'], String(a.value == null ? '' : a.value));

      case 'preset/setDescription':
        return setIn(state, ['preset', 'description'], String(a.value == null ? '' : a.value));

      case 'preset/toggleSource': {
        var sources = state.preset.query.sources;
        var next;
        if (sources[a.name]) {
          next = omit(sources, a.name);
        } else {
          var ms = manifestSource(state, a.name);
          next = Object.assign({}, sources);
          // по умолчанию: только ключ (участвует в срезе для JOIN между источниками) —
          // у источников бывает по сотне показателей, включать все сразу и заставлять
          // пользователя вручную снимать лишние неудобно
          next[a.name] = { labels: ms ? [ms.key] : null };
        }
        var withSources = setIn(state, ['preset', 'query', 'sources'], next);
        return setIn(withSources, ['preset', 'view', 'joins'],
          reconcileJoins(Object.keys(next), state.preset.view.joins));
      }

      case 'ui/toggleSrc': {
        var so = Object.assign({}, state.srcOpen);
        so[a.name] = !so[a.name];
        return Object.assign({}, state, { srcOpen: so });
      }

      case 'preset/toggleLabel': {
        var ms2 = manifestSource(state, a.source);
        var all = ms2 ? [ms2.key].concat(ms2.labels) : [];
        var cur = state.preset.query.sources[a.source].labels || all.slice();
        var labels = cur.indexOf(a.label) === -1
          ? all.filter(function (l) { return cur.indexOf(l) !== -1 || l === a.label; })
          : cur.filter(function (l) { return l !== a.label; });
        return setIn(state, ['preset', 'query', 'sources', a.source, 'labels'], labels);
      }

      case 'preset/setColWidth': {
        var cw = Object.assign({}, state.preset.view.column_widths || {});
        var wv = Number(a.width);
        if (a.width == null || !isFinite(wv) || wv <= 0) delete cw[a.column];
        else cw[a.column] = Math.round(wv);
        return setIn(state, ['preset', 'view', 'column_widths'], cw);
      }

      // связка привязана к источнику позиционно (см. reconcileJoins) — добавляется/
      // убирается автоматически вместе с preset/toggleSource, вручную можно только
      // поправить её поля (left/left_field/right_field/type)
      case 'preset/updateJoin':
        return setIn(state, ['preset', 'view', 'joins'], state.preset.view.joins.map(function (j, i) {
          return i === a.index ? Object.assign({}, j, a.patch) : j;
        }));

      case 'preset/addCondition':
        return setIn(state, ['preset', 'view', 'conditions'],
          state.preset.view.conditions.concat([{ field: '', op: 'contains', value: '' }]));

      case 'preset/updateCondition':
        return setIn(state, ['preset', 'view', 'conditions'],
          state.preset.view.conditions.map(function (c, i) {
            return i === a.index ? Object.assign({}, c, a.patch) : c;
          }));

      case 'preset/removeCondition':
        return setIn(state, ['preset', 'view', 'conditions'],
          state.preset.view.conditions.filter(function (_, i) { return i !== a.index; }));

      // условия «Индикаторов» — второй проход фильтрации, после расчёта сущностей
      // (см. buildDataset в main.js); поле — имя сущности, а не сырого столбца
      case 'preset/addEntityCondition':
        return setIn(state, ['preset', 'view', 'entityConditions'],
          state.preset.view.entityConditions.concat([{ field: '', op: 'contains', value: '' }]));

      case 'preset/updateEntityCondition':
        return setIn(state, ['preset', 'view', 'entityConditions'],
          state.preset.view.entityConditions.map(function (c, i) {
            return i === a.index ? Object.assign({}, c, a.patch) : c;
          }));

      case 'preset/removeEntityCondition':
        return setIn(state, ['preset', 'view', 'entityConditions'],
          state.preset.view.entityConditions.filter(function (_, i) { return i !== a.index; }));

      case 'preset/addEntity': {
        var ec = _entityColumns(state.preset);
        var free = ec.all.filter(function (c) { return !ec.used[c]; })[0] || '';
        var freeType = free ? columnType(state.preset, state.manifest && state.manifest.sources, free) : 'text';
        return setIn(state, ['preset', 'view', 'entities'], state.preset.view.entities.concat([
          { name: free, type: freeType, hidden: false, from: { kind: 'field', column: free } }
        ]));
      }

      // «+ показатель источника» на «Индикаторах»: добавить поле как есть (без
      // переименования, но с типом по умолчанию из манифеста — label_types, см.
      // entities.js::columnType). Нарочно без проверки на «уже занято» — можно
      // добавить одно и то же поле повторно или рядом с индикатором на его основе
      // (например: сырое поле для вида + производный индикатор для фильтра/расчёта)
      case 'preset/addFieldEntity': {
        var fieldType = columnType(state.preset, state.manifest && state.manifest.sources, a.column);
        return setIn(state, ['preset', 'view', 'entities'], state.preset.view.entities.concat([
          { name: a.column, type: fieldType, hidden: false, from: { kind: 'field', column: a.column } }
        ]));
      }

      case 'preset/updateEntity':
        return setIn(state, ['preset', 'view', 'entities'],
          state.preset.view.entities.map(function (e, i) { return i === a.index ? mergeEntity(e, a.patch) : e; }));

      case 'preset/removeEntity':
        return setIn(state, ['preset', 'view', 'entities'],
          state.preset.view.entities.filter(function (_, i) { return i !== a.index; }));

      case 'preset/moveEntity':
        return setIn(state, ['preset', 'view', 'entities'],
          _swap(state.preset.view.entities, a.index, a.index + a.dir));

      case 'preset/addEntityInput':
        return setIn(state, ['preset', 'view', 'entities'], state.preset.view.entities.map(function (e, i) {
          return i === a.index ? mergeEntity(e, { from: { inputs: (e.from.inputs || []).concat([{ column: '', weight: 0.5 }]) } }) : e;
        }));

      case 'preset/updateEntityInput':
        return setIn(state, ['preset', 'view', 'entities'], state.preset.view.entities.map(function (e, i) {
          if (i !== a.index) return e;
          var ins = (e.from.inputs || []).map(function (inp, ii) {
            return ii === a.ii ? Object.assign({}, inp, a.patch) : inp;
          });
          return mergeEntity(e, { from: { inputs: ins } });
        }));

      case 'preset/removeEntityInput':
        return setIn(state, ['preset', 'view', 'entities'], state.preset.view.entities.map(function (e, i) {
          return i === a.index
            ? mergeEntity(e, { from: { inputs: (e.from.inputs || []).filter(function (_, ii) { return ii !== a.ii; }) } })
            : e;
        }));

      case 'preset/moveEntityInput':
        return setIn(state, ['preset', 'view', 'entities'], state.preset.view.entities.map(function (e, i) {
          return i === a.index
            ? mergeEntity(e, { from: { inputs: _swap(e.from.inputs || [], a.ii, a.ii + a.dir) } })
            : e;
        }));

      case 'build/start':
        return Object.assign({}, state, { building: true, buildError: null });

      case 'build/error':
        return Object.assign({}, state, { building: false, buildError: a.message });

      case 'build/success':
        return Object.assign({}, state, {
          building: false, buildError: null, dataset: a.dataset,
          groupBy: [], hideEmpty: false, expanded: {}, quickOpen: {},
          adv: [], sortBy: []             // транзиентные слои сбрасываются при пересборке
          // quickValuesLimit НЕ сбрасывается -- это настройка UI, не датасета
        });

      case 'group/add':
        return Object.assign({}, state, { groupBy: state.groupBy.concat(['']) });

      case 'group/update':
        return Object.assign({}, state, {
          groupBy: state.groupBy.map(function (c, i) { return i === a.index ? a.column : c; }),
          expanded: {}
        });

      case 'group/remove':
        return Object.assign({}, state, {
          groupBy: state.groupBy.filter(function (_, i) { return i !== a.index; }),
          expanded: {}
        });

      case 'group/move':
        return Object.assign({}, state, {
          groupBy: _swap(state.groupBy, a.index, a.index + a.dir),
          expanded: {}
        });

      case 'table/toggleHideEmpty':
        return Object.assign({}, state, { hideEmpty: !state.hideEmpty });

      case 'table/toggleGroup': {
        var ex = Object.assign({}, state.expanded);
        if (ex[a.key]) delete ex[a.key]; else ex[a.key] = true;
        return Object.assign({}, state, { expanded: ex });
      }

      case 'table/expandAll': {
        var all2 = {};
        (a.keys || []).forEach(function (k) { all2[k] = true; });
        return Object.assign({}, state, { expanded: all2 });
      }

      case 'table/collapseAll':
        return Object.assign({}, state, { expanded: {} });

      // --- сортировка: расширенная панель (многоуровневый редактор) ---
      // по образцу group/add|update|remove|move выше.
      case 'sort/add':
        return Object.assign({}, state, { sortBy: state.sortBy.concat([{ col: '', dir: 'asc' }]) });

      case 'sort/update':
        return Object.assign({}, state, {
          sortBy: state.sortBy.map(function (s, i) { return i === a.index ? Object.assign({}, s, a.patch) : s; })
        });

      case 'sort/remove':
        return Object.assign({}, state, {
          sortBy: state.sortBy.filter(function (_, i) { return i !== a.index; })
        });

      case 'sort/move':
        return Object.assign({}, state, { sortBy: _swap(state.sortBy, a.index, a.index + a.dir) });

      // --- пиктограммы в заголовке таблицы: быстрый доступ к ОДНОМУ и тому же
      // состоянию, что редактирует расширенная панель (adv/sortBy), плюс
      // открытие/закрытие своего quick-слота ввода (поиск/фильтр). ---
      case 'quick/toggle': {
        var qo = Object.assign({}, state.quickOpen);
        qo[a.column] = qo[a.column] === a.mode ? null : a.mode;
        return Object.assign({}, state, { quickOpen: qo });
      }

      // Клик вне любой открытой quick-панели (или повторный клик по
      // пиктограмме, который уже обрабатывает quick/toggle выше) — закрыть
      // все открытые слоты сразу (на столбце может быть открыт только один,
      // но проще закрыть все, чем искать, какой). См. view-table.js — общий
      // обработчик клика по document.
      case 'quick/closeAll':
        return Object.assign({}, state, { quickOpen: {} });

      case 'quick/sort': {
        var idx = state.sortBy.findIndex(function (s) { return s.col === a.column; });
        var sb;
        if (idx === -1) sb = state.sortBy.concat([{ col: a.column, dir: 'asc' }]);
        else if (state.sortBy[idx].dir === 'asc') {
          sb = state.sortBy.map(function (s, i) { return i === idx ? Object.assign({}, s, { dir: 'desc' }) : s; });
        } else {
          sb = state.sortBy.filter(function (_, i) { return i !== idx; });
        }
        return Object.assign({}, state, { sortBy: sb });
      }

      case 'quick/applyFilter': {
        var i2 = state.adv.findIndex(function (c) { return c.field === a.column && c.op === 'contains'; });
        var value = a.value == null ? '' : String(a.value);
        var adv;
        if (!value.trim()) {
          adv = i2 === -1 ? state.adv : state.adv.filter(function (_, i) { return i !== i2; });
        } else if (i2 === -1) {
          adv = state.adv.concat([{ field: a.column, op: 'contains', value: value, conj: 'and' }]);
        } else {
          adv = state.adv.map(function (c, i) { return i === i2 ? Object.assign({}, c, { value: value }) : c; });
        }
        return Object.assign({}, state, { adv: adv });
      }

      case 'quick/setValuesLimit': {
        var limit = Math.max(0, Math.floor(Number(a.value) || 0));
        storage.set('quickValuesLimit', limit);
        return Object.assign({}, state, { quickValuesLimit: limit });
      }

      case 'ui/setExportFormat':
        return Object.assign({}, state, { exportFormat: a.value });

      // «Экспорт» и «Расширенный фильтр» — взаимоисключающие области над
      // таблицей: открытие одной закрывает другую (закрытие — само по себе,
      // вторую область не трогает, она и так уже закрыта по инварианту).
      case 'export/toggle': {
        var openingExport = !state.exportOpen;
        return Object.assign({}, state, {
          exportOpen: openingExport,
          advOpen: openingExport ? false : state.advOpen
        });
      }

      case 'adv/toggle': {
        var openingAdv = !state.advOpen;
        return Object.assign({}, state, {
          advOpen: openingAdv,
          exportOpen: openingAdv ? false : state.exportOpen
        });
      }

      case 'adv/add':
        return Object.assign({}, state, {
          adv: state.adv.concat([{ field: '', op: 'contains', value: '', conj: 'and' }])
        });

      case 'adv/update':
        return Object.assign({}, state, {
          adv: state.adv.map(function (c, i) { return i === a.index ? Object.assign({}, c, a.patch) : c; })
        });

      case 'adv/remove':
        return Object.assign({}, state, {
          adv: state.adv.filter(function (_, i) { return i !== a.index; })
        });

      case 'adv/reset':
        return Object.assign({}, state, { adv: [] });

      default:
        return state;
    }
  };

  // ---------------------------------------------------------------------------
  // Пресеты: скачивание / загрузка
  // ---------------------------------------------------------------------------

  var savePreset = function (preset) {
    var name = (preset.name || 'preset').replace(/[^\w.-]+/g, '_');
    download('ds-preset-' + name + '.json', JSON.stringify(preset, null, 2), 'application/json');
  };

  var loadPresetFile = function (file, d) {
    if (!file) return;
    readFile(file).then(function (text) {
      var raw = JSON.parse(text);
      d({ type: 'preset/set', preset: raw });
    }).catch(function () {
      d({ type: 'build/error', message: 'Не удалось прочитать пресет: ' + file.name });
    });
  };

  return {
    isStale: isStale, manifestSource: manifestSource, selectedNames: selectedNames,
    createStore: createStore, basePreset: basePreset, normalizePreset: normalizePreset,
    normalizeColWidths: normalizeColWidths, normalizeConditions: normalizeConditions,
    initialState: initialState, reducer: reducer,
    savePreset: savePreset, loadPresetFile: loadPresetFile
  };
});
