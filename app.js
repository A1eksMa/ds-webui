'use strict';

/*
 * ds-webui — статическое приложение (file://, без сервера, без fetch).
 *
 * Стиль: функциональный. Чистые функции для трансформации данных и построения
 * представления; крошечный store (reducer + dispatch + subscribe); эффекты
 * (инъекция <script>, скачивание файлов) вынесены в отдельные функции.
 *
 * Терминология — как в ядре `ds`: source / label / id / val / key (ключевой
 * показатель) / as_of / preset / query / view / join / gen_max_cnt / db_max_cnt.
 */
(function () {

  // ---------------------------------------------------------------------------
  // Мелкие функциональные утилиты
  // ---------------------------------------------------------------------------

  var pipe = function () {
    var fns = [].slice.call(arguments);
    return function (x) { return fns.reduce(function (v, f) { return f(v); }, x); };
  };

  var uniq = function (xs) { return Array.from(new Set(xs)); };

  var groupBy = function (keyFn) {
    return function (xs) {
      return xs.reduce(function (acc, x) {
        var k = keyFn(x);
        (acc[k] = acc[k] || []).push(x);
        return acc;
      }, Object.create(null));
    };
  };

  // неглубокое обновление по пути: setIn({a:{b:1}}, ['a','b'], 2)
  var setIn = function (obj, path, value) {
    if (!path.length) return value;
    var k = path[0];
    var next = obj && typeof obj === 'object' ? obj[k] : undefined;
    var patch = {};
    patch[k] = setIn(next === undefined ? {} : next, path.slice(1), value);
    return Object.assign({}, obj, patch);
  };

  var omit = function (obj, key) {
    var out = Object.assign({}, obj);
    delete out[key];
    return out;
  };

  var fmtDate = function (ts) {
    if (ts == null) return '—';
    var d = new Date(ts * 1000);
    return isNaN(d) ? String(ts) : d.toISOString().slice(0, 16).replace('T', ' ');
  };

  // hyperscript: el('div', {class:'x', onclick:fn}, child, [children])
  var el = function (tag, attrs) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    });
    [].slice.call(arguments, 2).forEach(function append(kid) {
      if (kid == null || kid === false) return;
      if (Array.isArray(kid)) return kid.forEach(append);
      node.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
    });
    return node;
  };

  var clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  // ---------------------------------------------------------------------------
  // Эффекты: загрузка файла источника, скачивание, localStorage
  // ---------------------------------------------------------------------------

  // Инъекция <script src="<dir>/<file>">; резолвится, когда window.DS.sources[name] появился.
  var loadSourceScript = function (dir, file, name) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = dir + '/' + file;
      s.onload = function () {
        window.DS.sources[name] ? resolve(name) : reject(new Error(name));
      };
      s.onerror = function () { reject(new Error(name)); };
      document.head.appendChild(s);
    });
  };

  var download = function (filename, text, mime) {
    var blob = new Blob(['﻿', text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  var readFile = function (file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsText(file);
    });
  };

  var storage = {
    get: function (key) {
      try { return JSON.parse(localStorage.getItem('ds-webui:' + key)); }
      catch (e) { return null; }
    },
    set: function (key, value) {
      try { localStorage.setItem('ds-webui:' + key, JSON.stringify(value)); }
      catch (e) { /* приватное окно / отключено — best-effort */ }
    }
  };

  // ---------------------------------------------------------------------------
  // Чистые трансформации данных
  // ---------------------------------------------------------------------------

  var isStale = function (ms) { return ms.db_max_cnt > ms.gen_max_cnt; };

  var manifestSource = function (state, name) {
    return (state.manifest.sources || []).find(function (s) { return s.name === name; });
  };

  var selectedNames = function (preset) { return Object.keys(preset.query.sources); };

  // LEFT JOIN нескольких источников. selected: [{name, key, labels, data}].
  // joins: [{left, left_field, right, right_field}]. База — первый источник.
  // Колонки при >1 источнике квалифицируются как "<Source>.<label>".
  // Ключевой показатель источника — обычное выбираемое поле: он попадает в
  // колонки, только если присутствует в s.labels (иначе используется лишь для
  // сопоставления при JOIN).
  var joinSources = function (selected, joins) {
    if (!selected.length) return { columns: [], rows: [] };
    var qualify = selected.length > 1;
    var col = function (src, label) { return qualify ? src + '.' + label : label; };

    var base = selected[0];
    var rest = selected.slice(1);

    var columns = base.labels.map(function (l) { return col(base.name, l); })
      .concat(rest.reduce(function (acc, s) {
        return acc.concat(s.labels.map(function (l) { return col(s.name, l); }));
      }, []));

    var rows = base.data.map(function (r) {
      var o = { __match: {} };
      o.__match[base.name] = r;
      base.labels.forEach(function (l) { o[col(base.name, l)] = l in r ? r[l] : undefined; });
      return o;
    });

    rest.forEach(function (s) {
      var j = joins.find(function (x) { return x.right === s.name; })
        || { left: base.name, left_field: base.key, right: s.name, right_field: s.key };
      var idx = new Map();
      s.data.forEach(function (r) {
        var k = r[j.right_field];
        if (k != null) idx.set(String(k), r);
      });
      rows = rows.map(function (o) {
        var leftRow = o.__match[j.left];
        var key = leftRow ? leftRow[j.left_field] : undefined;
        var m = key != null ? idx.get(String(key)) : undefined;
        s.labels.forEach(function (l) { o[col(s.name, l)] = m && l in m ? m[l] : undefined; });
        var match = Object.assign({}, o.__match);
        match[s.name] = m;
        return Object.assign({}, o, { __match: match });
      });
    });

    return { columns: columns, rows: rows.map(function (r) { return omit(r, '__match'); }) };
  };

  var matchesFilter = function (value, needle) {
    return String(value == null ? '' : value).toLowerCase().indexOf(needle.trim().toLowerCase()) !== -1;
  };

  var applyFilters = function (dataset, filters) {
    var active = Object.keys(filters || {}).filter(function (c) { return filters[c] && filters[c].trim(); });
    if (!active.length) return dataset;
    var rows = dataset.rows.filter(function (r) {
      return active.every(function (c) { return matchesFilter(r[c], filters[c]); });
    });
    return { columns: dataset.columns, rows: rows };
  };

  var visibleColumns = function (dataset, hideEmpty) {
    if (!hideEmpty) return dataset.columns;
    return dataset.columns.filter(function (c) {
      return dataset.rows.some(function (r) { return r[c] != null && r[c] !== ''; });
    });
  };

  var toCsv = function (dataset, columns) {
    var cell = function (v) {
      var s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [columns.map(cell).join(',')]
      .concat(dataset.rows.map(function (r) {
        return columns.map(function (c) { return cell(r[c]); }).join(',');
      }))
      .join('\r\n');
  };

  var xmlEsc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var xlsTable = function (id, dataset, columns) {
    var head = '<tr>' + columns.map(function (c) {
      return '<th>' + xmlEsc(c) + '</th>';
    }).join('') + '</tr>';
    var body = dataset.rows.map(function (r) {
      return '<tr>' + columns.map(function (c) {
        return '<td>' + xmlEsc(r[c]) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<table id="' + id + '" border="1">' + head + body + '</table>';
  };

  // Одна запись <x:ExcelWorksheet> в MSO-острове. opts: {selected, hidden, protect}
  var xlsSheetMeta = function (name, opts) {
    var o = [];
    if (opts.selected) { o.push('    <x:Selected/>'); }
    if (opts.hidden) { o.push('    <x:Visible>SheetHidden</x:Visible>'); }
    if (opts.protect) {
      // Пустой пароль: защита включена, снимается без пароля.
      o.push('    <x:ProtectContents>True</x:ProtectContents>');
      o.push('    <x:ProtectObjects>True</x:ProtectObjects>');
      o.push('    <x:ProtectScenarios>True</x:ProtectScenarios>');
    }
    return [
      '   <x:ExcelWorksheet>',
      '    <x:Name>' + xmlEsc(name) + '</x:Name>',
      '    <x:WorksheetOptions>',
      o.join('\n'),
      '    </x:WorksheetOptions>',
      '   </x:ExcelWorksheet>'
    ].join('\n');
  };

  // Книга Excel из двух листов ("user" видимый, "system" — скрытый и защищённый).
  // Формат — legacy Excel-HTML с MSO-островом: имена листов / скрытие / защиту
  // читает настольный Microsoft Excel. LibreOffice / Google Sheets остров
  // игнорируют — там будут два обычных листа с теми же данными.
  var toXlsWorkbook = function (dataset, columns) {
    return [
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"',
      '      xmlns:x="urn:schemas-microsoft-com:office:excel"',
      '      xmlns="http://www.w3.org/TR/REC-html40">',
      '<head><meta charset="utf-8">',
      '<!--[if gte mso 9]><xml>',
      ' <x:ExcelWorkbook>',
      '  <x:ExcelWorksheets>',
      xlsSheetMeta('user', { selected: true }),
      xlsSheetMeta('system', { hidden: true, protect: true }),
      '  </x:ExcelWorksheets>',
      '  <x:ActiveSheet>0</x:ActiveSheet>',
      ' </x:ExcelWorkbook>',
      '</xml><![endif]-->',
      '</head>',
      '<body>',
      xlsTable('user', dataset, columns),
      xlsTable('system', dataset, columns),
      '</body></html>'
    ].join('\n');
  };

  // Имя выгружаемого файла — по тому же неймингу, что и файлы, которые мониторит
  // ds-loader: <source>_YYYY-MM-DD_HH-MM-SS_<micros>.<ext>. В роли <source> —
  // имя пользователя (браузер системное имя не отдаёт, поэтому берётся из поля
  // «автор» на панели таблицы; пусто -> "user"). Время — локальное, как у
  // продьюсера (datetime.now()); микросекунды = миллисекунды, дополненные нулями.
  var pad = function (n, width) {
    var s = String(n);
    while (s.length < (width || 2)) { s = '0' + s; }
    return s;
  };

  var sanitizeAuthor = function (name) {
    var s = String(name == null ? '' : name).trim()
      .replace(/[_\s\/\\:*?"<>|]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'user';
  };

  var exportFilename = function (author, ext, when) {
    var d = when || new Date();
    var ts = pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
      + '_' + pad(d.getMilliseconds() * 1000, 6);
    return sanitizeAuthor(author) + '_' + ts + '.' + ext;
  };

  // ---------------------------------------------------------------------------
  // Store
  // ---------------------------------------------------------------------------

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

  var basePreset = function () {
    return JSON.parse(JSON.stringify((window.DS_PRESETS && window.DS_PRESETS[0]) || {
      name: 'base', query: { as_of: null, sources: {} }, view: { joins: [], column_filters: {} }
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
            right: j.right || '', right_field: j.right_field || ''
          };
        }) : [],
        column_filters: (view.column_filters && typeof view.column_filters === 'object')
          ? Object.assign({}, view.column_filters) : {}
      }
    };
  };

  var initialState = {
    route: 'build',
    manifest: null,
    dataDir: null,
    preset: null,
    author: '',              // «источник» в имени выгружаемого файла
    building: false,
    buildError: null,
    dataset: null,
    tableFilters: {},
    groupBy: '',
    hideEmpty: false,
    expanded: {}
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

      case 'ui/setAuthor':
        return Object.assign({}, state, { author: String(a.value == null ? '' : a.value) });

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

      case 'preset/toggleLabel': {
        var ms2 = manifestSource(state, a.source);
        var all = ms2 ? [ms2.key].concat(ms2.labels) : [];
        var cur = state.preset.query.sources[a.source].labels || all.slice();
        var labels = cur.indexOf(a.label) === -1
          ? all.filter(function (l) { return cur.indexOf(l) !== -1 || l === a.label; })
          : cur.filter(function (l) { return l !== a.label; });
        return setIn(state, ['preset', 'query', 'sources', a.source, 'labels'], labels);
      }

      case 'preset/setAsOf': {
        var raw = String(a.value).trim();
        var value = raw === '' ? null : Number(raw);
        if (value != null && isNaN(value)) return state;
        return setIn(state, ['preset', 'query', 'as_of'], value);
      }

      case 'preset/addJoin': {
        var sel = selectedNames(state.preset);
        var j = { left: sel[0] || '', left_field: '', right: '', right_field: '' };
        return setIn(state, ['preset', 'view', 'joins'], state.preset.view.joins.concat([j]));
      }

      case 'preset/updateJoin':
        return setIn(state, ['preset', 'view', 'joins'], state.preset.view.joins.map(function (j, i) {
          return i === a.index ? Object.assign({}, j, a.patch) : j;
        }));

      case 'preset/removeJoin':
        return setIn(state, ['preset', 'view', 'joins'],
          state.preset.view.joins.filter(function (_, i) { return i !== a.index; }));

      case 'preset/setColumnFilter': {
        var cf = Object.assign({}, state.preset.view.column_filters);
        if (a.value && a.value.trim()) cf[a.column] = a.value;
        else delete cf[a.column];
        return setIn(state, ['preset', 'view', 'column_filters'], cf);
      }

      case 'build/start':
        return Object.assign({}, state, { building: true, buildError: null });

      case 'build/error':
        return Object.assign({}, state, { building: false, buildError: a.message });

      case 'build/success':
        return Object.assign({}, state, {
          building: false, buildError: null, dataset: a.dataset,
          tableFilters: {}, groupBy: '', hideEmpty: false, expanded: {}
        });

      case 'table/setFilter': {
        var tf = Object.assign({}, state.tableFilters);
        if (a.value) tf[a.column] = a.value; else delete tf[a.column];
        return Object.assign({}, state, { tableFilters: tf });
      }

      case 'table/setGroupBy':
        return Object.assign({}, state, { groupBy: a.column, expanded: {} });

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

      default:
        return state;
    }
  };

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
      var dataset = applyFilters(
        joined,
        state.preset.view.column_filters || {}
      );
      store.dispatch({ type: 'build/success', dataset: dataset });
      store.dispatch({ type: 'route/set', route: 'table' });
    });
  };

  // ---------------------------------------------------------------------------
  // Представление
  // ---------------------------------------------------------------------------

  var cellNode = function (v) {
    if (v === null) return el('td', { class: 'del', title: 'удалено (DELETE)' }, '∅');
    if (v === undefined || v === '') return el('td', { class: 'empty' }, '');
    return el('td', {}, String(v));
  };

  var badge = function (ms) {
    return isStale(ms)
      ? el('span', { class: 'badge stale', title: 'db_max_cnt ' + ms.db_max_cnt + ' > gen_max_cnt ' + ms.gen_max_cnt },
          'пересобрать')
      : el('span', { class: 'badge fresh' }, 'свежий');
  };

  var viewNav = function (state, d) {
    var ctl = state.route === 'table'
      ? el('button', {
          class: 'gear', title: 'Настройки: изменить пресет по умолчанию',
          onclick: function () { d({ type: 'route/set', route: 'build' }); }
        }, '⚙ Настройки')
      : el('button', {
          class: 'gear', disabled: !state.dataset,
          onclick: function () { d({ type: 'route/set', route: 'table' }); }
        }, '← К таблице');
    return el('header', { class: 'nav' },
      el('strong', {}, 'ds-webui'),
      el('span', { class: 'spacer' }),
      state.dataDir
        ? el('span', { class: 'muted src-dir' }, 'данные: ' + state.dataDir + '/')
        : el('span', { class: 'muted src-dir warn' }, 'нет data/ и sample-data/'),
      ctl
    );
  };

  // ---- Конструктор ---------------------------------------------------------

  var viewBuild = function (state, d) {
    var preset = state.preset;
    var mSources = (state.manifest && state.manifest.sources) || [];
    var chosen = selectedNames(preset);

    var sourceRow = function (ms) {
      var picked = !!preset.query.sources[ms.name];
      var fields = [ms.key].concat(ms.labels);            // ключ — обычное выбираемое поле
      var wanted = picked ? (preset.query.sources[ms.name].labels || fields) : [];
      var fieldBox = function (name, isKey) {
        return el('label', { class: 'field-item' + (isKey ? ' key' : '') },
          el('input', {
            type: 'checkbox', checked: wanted.indexOf(name) !== -1,
            onchange: function () { d({ type: 'preset/toggleLabel', source: ms.name, label: name }); }
          }),
          el('span', { class: 'field-name' }, name),
          isKey ? el('span', { class: 'tag' }, 'ключ') : null
        );
      };
      return el('div', { class: 'src' + (picked ? ' picked' : '') },
        el('label', { class: 'src-head' },
          el('input', {
            type: 'checkbox', checked: picked,
            onchange: function () { d({ type: 'preset/toggleSource', name: ms.name }); }
          }),
          el('span', { class: 'src-name' }, ms.name),
          el('span', { class: 'muted' }, ms.rows + ' строк · срез ' + fmtDate(ms.as_of)),
          badge(ms)
        ),
        picked ? el('div', { class: 'field-list' },
          fieldBox(ms.key, true),
          ms.labels.map(function (lb) { return fieldBox(lb, false); })
        ) : null
      );
    };

    // поля, доступные для join у источника: ключ + все его показатели
    var fieldsOf = function (name) {
      var ms = mSources.find(function (s) { return s.name === name; });
      return ms ? uniq([ms.key].concat(ms.labels)) : [];
    };

    var joinRow = function (j, i) {
      var pick = function (value, options, onchange) {
        return el('select', { onchange: function (e) { onchange(e.target.value); } },
          [el('option', { value: '' }, '—')].concat(options.map(function (o) {
            return el('option', { value: o, selected: o === value }, o);
          })));
      };
      return el('div', { class: 'join' },
        pick(j.left, chosen, function (v) { d({ type: 'preset/updateJoin', index: i, patch: { left: v, left_field: '' } }); }),
        el('span', { class: 'dot' }, '.'),
        pick(j.left_field, fieldsOf(j.left), function (v) { d({ type: 'preset/updateJoin', index: i, patch: { left_field: v } }); }),
        el('span', { class: 'eq' }, '='),
        pick(j.right, chosen, function (v) { d({ type: 'preset/updateJoin', index: i, patch: { right: v, right_field: '' } }); }),
        el('span', { class: 'dot' }, '.'),
        pick(j.right_field, fieldsOf(j.right), function (v) { d({ type: 'preset/updateJoin', index: i, patch: { right_field: v } }); }),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/removeJoin', index: i }); } }, '✕')
      );
    };

    // все выбранные (source, label) для базовых фильтров
    var pickedColumns = chosen.reduce(function (acc, name) {
      var ms = mSources.find(function (s) { return s.name === name; });
      if (!ms) return acc;
      var labels = preset.query.sources[name].labels || [ms.key].concat(ms.labels);
      return acc.concat(labels.map(function (l) { return chosen.length > 1 ? name + '.' + l : l; }));
    }, []);

    return el('section', { class: 'page build' },
      el('h1', {}, 'Конструктор выборки'),

      el('div', { class: 'row' },
        el('label', { class: 'field' }, 'Срез (as_of, unix-время; пусто = текущий момент)',
          el('input', {
            type: 'text', value: preset.query.as_of == null ? '' : String(preset.query.as_of),
            placeholder: 'сейчас',
            onchange: function (e) { d({ type: 'preset/setAsOf', value: e.target.value }); }
          })
        ),
        preset.query.as_of != null
          ? el('span', { class: 'muted' }, '= ' + fmtDate(preset.query.as_of))
          : null
      ),

      el('h2', {}, 'Источники и показатели'),
      mSources.length
        ? el('div', { class: 'src-list' }, mSources.map(sourceRow))
        : el('p', { class: 'muted' }, 'Манифест пуст — сгенерируй данные (ds get / tools/gen_sample.py).'),

      chosen.length > 1 ? el('div', {},
        el('h2', {}, 'Связки между источниками (LEFT JOIN)'),
        el('div', { class: 'joins' }, preset.view.joins.map(joinRow)),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/addJoin' }); } }, '+ связка')
      ) : null,

      pickedColumns.length ? el('div', {},
        el('h2', {}, 'Базовые фильтры (подстрока, применяются при построении)'),
        el('div', { class: 'filters' }, pickedColumns.map(function (c) {
          return el('label', { class: 'field small' }, c,
            el('input', {
              type: 'text', value: preset.view.column_filters[c] || '',
              onchange: function (e) { d({ type: 'preset/setColumnFilter', column: c, value: e.target.value }); }
            })
          );
        }))
      ) : null,

      state.buildError ? el('p', { class: 'error' }, state.buildError) : null,

      el('div', { class: 'row' },
        el('label', { class: 'field small' }, 'Имя пресета',
          el('input', {
            type: 'text', value: preset.name || '',
            onchange: function (e) { d({ type: 'preset/setName', value: e.target.value }); }
          })
        ),
        el('span', { class: 'muted' },
          'изменения сохраняются автоматически как пресет по умолчанию (localStorage); '
          + '«Скачать пресет» — отдельный файл')
      ),

      el('div', { class: 'actions' },
        el('button', {
          class: 'primary', disabled: state.building || !chosen.length,
          onclick: function () { buildDataset(store); }
        }, state.building ? 'Строю…' : 'Применить и открыть таблицу'),
        el('button', { onclick: function () { savePreset(state.preset); } }, 'Скачать пресет'),
        el('label', { class: 'file-btn' }, 'Загрузить пресет',
          el('input', {
            type: 'file', accept: '.json,application/json',
            onchange: function (e) { loadPresetFile(e.target.files[0], d); e.target.value = ''; }
          })
        ),
        el('button', { onclick: function () { d({ type: 'preset/set', preset: basePreset() }); } }, 'Сбросить к базовому')
      )
    );
  };

  // ---- Таблица ----------------------------------------------------------

  var viewTableShell = function (state, d) {
    var cols = state.dataset ? state.dataset.columns : [];
    var toolbar = el('div', { class: 'toolbar' },
      el('label', { class: 'field small' }, 'Группировать по',
        el('select', { onchange: function (e) { d({ type: 'table/setGroupBy', column: e.target.value }); } },
          [el('option', { value: '' }, '—')].concat(cols.map(function (c) {
            return el('option', { value: c, selected: c === state.groupBy }, c);
          })))
      ),
      el('label', { class: 'chk' },
        el('input', {
          type: 'checkbox', checked: state.hideEmpty,
          onchange: function () { d({ type: 'table/toggleHideEmpty' }); }
        }),
        'скрыть пустые колонки'
      ),
      el('span', { class: 'spacer' }),
      el('label', { class: 'field small', title: 'подставляется в имя выгружаемого файла как «источник»' },
        'Автор',
        el('input', {
          type: 'text', value: state.author, placeholder: 'user',
          onchange: function (e) { d({ type: 'ui/setAuthor', value: e.target.value }); }
        })
      ),
      el('button', { onclick: function () { exportXls(store.getState()); } }, 'Выгрузить в Excel'),
      el('button', { onclick: function () { exportCsv(store.getState()); } }, 'CSV')
    );

    return el('section', { class: 'page table' },
      el('h1', {}, 'Таблица'),
      state.dataset
        ? el('p', { class: 'muted' }, 'Пресет «' + state.preset.name + '», источники: '
            + selectedNames(state.preset).join(' + '))
        : null,
      state.dataset ? toolbar : null,
      el('div', { class: 'grid-wrap', id: 'grid' })
    );
  };

  var renderGrid = function (state, d) {
    var node = document.getElementById('grid');
    if (!node) return;
    clear(node);

    if (!state.dataset) {
      node.appendChild(el('p', { class: 'muted' }, 'Сначала постройте таблицу в «Конструкторе выборки».'));
      return;
    }

    var cols = visibleColumns(state.dataset, state.hideEmpty);
    var filtered = applyFilters(state.dataset, state.tableFilters);

    var head = el('tr', {}, cols.map(function (c) {
      return el('th', {},
        el('div', { class: 'col-name' }, c),
        el('input', {
          type: 'text', class: 'col-filter', value: state.tableFilters[c] || '', placeholder: 'фильтр…',
          oninput: function (e) { d({ type: 'table/setFilter', column: c, value: e.target.value }); }
        })
      );
    }));

    var bodyRows = [];
    if (state.groupBy && cols.indexOf(state.groupBy) !== -1) {
      var groups = groupBy(function (r) { return String(r[state.groupBy] == null ? '∅' : r[state.groupBy]); })(filtered.rows);
      var keys = Object.keys(groups).sort();
      keys.forEach(function (k) {
        var open = !!state.expanded[k];
        bodyRows.push(el('tr', { class: 'grp' + (open ? ' open' : '') },
          el('td', { colspan: cols.length, onclick: function () { d({ type: 'table/toggleGroup', key: k }); } },
            el('span', { class: 'caret' }, open ? '▾' : '▸'),
            ' ', state.groupBy, ' = ', el('strong', {}, k),
            el('span', { class: 'muted' }, '  (' + groups[k].length + ')')
          )
        ));
        if (open) groups[k].forEach(function (r) {
          bodyRows.push(el('tr', { class: 'member' }, cols.map(function (c) { return cellNode(r[c]); })));
        });
      });

      node.appendChild(el('div', { class: 'grp-actions' },
        el('button', { class: 'link', onclick: function () { d({ type: 'table/expandAll', keys: keys }); } }, 'развернуть все'),
        el('button', { class: 'link', onclick: function () { d({ type: 'table/collapseAll' }); } }, 'свернуть все')
      ));
    } else {
      filtered.rows.forEach(function (r) {
        bodyRows.push(el('tr', {}, cols.map(function (c) { return cellNode(r[c]); })));
      });
    }

    node.appendChild(el('div', { class: 'count muted' },
      'строк: ' + filtered.rows.length + ' из ' + state.dataset.rows.length
      + ' · колонок: ' + cols.length));
    node.appendChild(el('div', { class: 'scroll' },
      el('table', { class: 'data' }, el('thead', {}, head), el('tbody', {}, bodyRows))
    ));
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

  var exportDataset = function (state) {
    var cols = visibleColumns(state.dataset, state.hideEmpty);
    return { dataset: applyFilters(state.dataset, state.tableFilters), columns: cols };
  };

  var exportXls = function (state) {
    if (!state.dataset) return;
    var e = exportDataset(state);
    download(exportFilename(state.author, 'xls'),
      toXlsWorkbook(e.dataset, e.columns), 'application/vnd.ms-excel');
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
    var shellChanged = state.route !== lastRoute || datasetSig !== lastDatasetSig;

    if (shellChanged || root.children.length < 2) {
      clear(root);
      root.appendChild(viewNav(state, d));
      root.appendChild(state.route === 'build' ? viewBuild(state, d) : viewTableShell(state, d));
      lastRoute = state.route;
      lastDatasetSig = datasetSig;
    } else if (state.route === 'build') {
      // build-страница: переть целиком (инпуты — на onchange, фокус не теряется)
      root.replaceChild(viewBuild(state, d), root.children[1]);
    }

    if (state.route === 'table') renderGrid(state, d);
    if (state.preset) storage.set('preset', state.preset);
    storage.set('author', state.author);
  };

  store.subscribe(render);

  window.__ds.ready.then(function (boot) {
    store.dispatch({
      type: 'manifest/loaded',
      manifest: (boot && boot.manifest) || { sources: [] },
      dataDir: boot ? boot.dataDir : null
    });
    var saved = storage.get('preset');
    store.dispatch({ type: 'preset/set', preset: saved || basePreset() });
    var savedAuthor = storage.get('author');
    if (typeof savedAuthor === 'string') {
      store.dispatch({ type: 'ui/setAuthor', value: savedAuthor });
    }
    // применить пресет по умолчанию и сразу открыть таблицу; при ошибке
    // (нет данных / нет источника) buildDataset оставит пользователя в конструкторе
    buildDataset(store);
  });

})();
