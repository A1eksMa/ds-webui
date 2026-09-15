'use strict';

// Store: фабрика createStore (reducer + dispatch + subscribe), селекторы
// состояния, нормализация пресета, редьюсер, (де)сериализация пресета в файл.
// Зависит от util.js (omit/setIn/_swap), dataset.js (OP_IDS/JOIN_TYPE_IDS),
// entities.js (normalizeEntities/mergeEntity/_entityColumns/parseDate),
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
      _entityColumns = Entities._entityColumns, parseDate = Entities.parseDate;
  var download = Effects.download, readFile = Effects.readFile;

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
      query: {
        as_of: query.as_of == null ? null : Number(query.as_of),
        sources: normSources
      },
      view: {
        joins: Array.isArray(view.joins) ? view.joins.map(function (j) {
          return {
            left: j.left || '', left_field: j.left_field || '',
            right: j.right || '', right_field: j.right_field || '',
            // старые пресеты без type — раньше был всегда LEFT JOIN
            type: JOIN_TYPE_IDS.indexOf(j.type) !== -1 ? j.type : 'left'
          };
        }) : [],
        conditions: normalizeConditions(view),
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

  // view.conditions [{field, op, value}] + миграция старого view.column_filters
  // ({column: substring} -> оператор contains).
  var normalizeConditions = function (view) {
    var raw = Array.isArray(view.conditions) ? view.conditions : [];
    var out = raw.map(function (c) {
      c = c && typeof c === 'object' ? c : {};
      return {
        field: typeof c.field === 'string' ? c.field : '',
        op: OP_IDS.indexOf(c.op) !== -1 ? c.op : 'contains',
        value: c.value == null ? '' : String(c.value)
      };
    }).filter(function (c) { return c.field !== '' || c.value !== ''; });
    if (view.column_filters && typeof view.column_filters === 'object') {
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
    tableFilters: {},
    groupBy: [],             // список полей группировки — применяются последовательно (вложенно)
    hideEmpty: false,
    expanded: {},
    srcOpen: {},              // конструктор: у каких источников развёрнут список показателей
    entOpen: true,            // конструктор: развёрнут ли блок «Сущности»
    adv: [],                 // расширенный фильтр (транзиентный, не в пресете)
    sort: null,              // { col, dir: 'asc'|'desc' } | null — сортировка столбца
    exportFormat: 'xls'      // выбор формата на странице «Экспорт» ('xls' | 'csv')
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

      case 'preset/toggleSource': {
        var sources = state.preset.query.sources;
        var next;
        if (sources[a.name]) {
          next = omit(sources, a.name);
        } else {
          var ms = manifestSource(state, a.name);
          next = Object.assign({}, sources);
          // по умолчанию: ключ + все показатели
          next[a.name] = { labels: ms ? [ms.key].concat(ms.labels) : null };
        }
        return setIn(state, ['preset', 'query', 'sources'], next);
      }

      case 'ui/toggleSrc': {
        var so = Object.assign({}, state.srcOpen);
        so[a.name] = !so[a.name];
        return Object.assign({}, state, { srcOpen: so });
      }

      case 'ui/toggleEnt':
        return Object.assign({}, state, { entOpen: !state.entOpen });

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

      case 'preset/setAsOf': {
        // Принимает то же, что parseDate('auto'): дату, дату-время (с секундами
        // или без), unix-время; миллисекунды в дате/unix — усекаются (as_of у ds
        // секундной точности). Нераспознанный ввод — не трогаем прежнее значение.
        var raw = String(a.value == null ? '' : a.value).trim();
        if (raw === '') return setIn(state, ['preset', 'query', 'as_of'], null);
        var parsed = parseDate(raw, 'auto');
        if (!parsed.ok) return state;
        return setIn(state, ['preset', 'query', 'as_of'], Math.round(parsed.ms / 1000));
      }

      case 'preset/addJoin': {
        var sel = selectedNames(state.preset);
        var j = { left: sel[0] || '', left_field: '', right: '', right_field: '', type: 'left' };
        return setIn(state, ['preset', 'view', 'joins'], state.preset.view.joins.concat([j]));
      }

      case 'preset/updateJoin':
        return setIn(state, ['preset', 'view', 'joins'], state.preset.view.joins.map(function (j, i) {
          return i === a.index ? Object.assign({}, j, a.patch) : j;
        }));

      case 'preset/removeJoin':
        return setIn(state, ['preset', 'view', 'joins'],
          state.preset.view.joins.filter(function (_, i) { return i !== a.index; }));

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

      case 'preset/addEntity': {
        var ec = _entityColumns(state.preset);
        var free = ec.all.filter(function (c) { return !ec.used[c]; })[0] || '';
        return setIn(state, ['preset', 'view', 'entities'], state.preset.view.entities.concat([
          { name: free, type: 'text', from: { kind: 'field', column: free } }
        ]));
      }

      case 'preset/addAllFieldsAsEntities': {
        var ec2 = _entityColumns(state.preset);
        var add = ec2.all.filter(function (c) { return !ec2.used[c]; }).map(function (c) {
          return { name: c, type: 'text', from: { kind: 'field', column: c } };
        });
        return setIn(state, ['preset', 'view', 'entities'], state.preset.view.entities.concat(add));
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
          tableFilters: {}, groupBy: [], hideEmpty: false, expanded: {},
          adv: [], sort: null            // транзиентные слои сбрасываются при пересборке
        });

      case 'table/setFilter': {
        var tf = Object.assign({}, state.tableFilters);
        if (a.value) tf[a.column] = a.value; else delete tf[a.column];
        return Object.assign({}, state, { tableFilters: tf });
      }

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

      case 'table/sort': {
        var s = state.sort;
        var next = (!s || s.col !== a.column) ? { col: a.column, dir: 'asc' }
          : s.dir === 'asc' ? { col: a.column, dir: 'desc' }
          : null;
        return Object.assign({}, state, { sort: next });
      }

      case 'ui/setExportFormat':
        return Object.assign({}, state, { exportFormat: a.value });

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
