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

  // Прочитать текст из буфера обмена (нужен жест пользователя + разрешение).
  // При отказе/недоступности — уведомить и дать вставить вручную (Ctrl+V).
  var pasteFromClipboard = function (cb) {
    var fail = function () {
      alert('Не удалось прочитать буфер обмена. Вставьте список вручную (Ctrl+V) в поле.');
    };
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) { if (t && t.trim()) cb(t); }, fail);
    } else {
      fail();
    }
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

  // --- условия выборки (задаются в конструкторе, сужают датасет при построении) ---
  // Оператор -> подпись; порядок = порядок в выпадающем списке.
  var OPERATORS = [
    ['contains', 'содержит'],
    ['not_contains', 'не содержит'],
    ['eq', 'равно'],
    ['ne', 'не равно'],
    ['in', 'в списке'],
    ['not_in', 'не в списке'],
    ['starts', 'начинается с'],
    ['ends', 'заканчивается на'],
    ['gt', '> (число)'],
    ['gte', '≥ (число)'],
    ['lt', '< (число)'],
    ['lte', '≤ (число)'],
    ['empty', 'пусто'],
    ['not_empty', 'не пусто']
  ];
  var OP_IDS = OPERATORS.map(function (o) { return o[0]; });
  var OP_NO_VALUE = { empty: 1, not_empty: 1 };
  var OP_LIST = { in: 1, not_in: 1 };            // значение — список (одно на строку / через запятую)

  // "id1, id2\n id3 ; id4" -> ["id1","id2","id3","id4"] (trim, lower, без пустых)
  var parseList = function (raw) {
    return String(raw == null ? '' : raw)
      .split(/[\n,;\t]+/)
      .map(function (x) { return x.trim().toLowerCase(); })
      .filter(Boolean);
  };

  var matchCondition = function (cell, cond) {
    var op = cond.op;
    var isEmpty = cell == null || cell === '';
    if (op === 'empty') return isEmpty;
    if (op === 'not_empty') return !isEmpty;
    var s = String(cell == null ? '' : cell).toLowerCase();
    var n = String(cond.value == null ? '' : cond.value).trim().toLowerCase();
    switch (op) {
      case 'contains': return s.indexOf(n) !== -1;
      case 'not_contains': return s.indexOf(n) === -1;
      case 'eq': return s === n;
      case 'ne': return s !== n;
      case 'in': case 'not_in': {
        var list = parseList(cond.value);
        if (!list.length) return op === 'not_in';       // пустой список: in — ничего, not_in — всё
        var hit = list.indexOf(s) !== -1;
        return op === 'in' ? hit : !hit;
      }
      case 'starts': return s.indexOf(n) === 0;
      case 'ends': return n === '' || s.slice(-n.length) === n;
      case 'gt': case 'gte': case 'lt': case 'lte': {
        if (isEmpty) return false;                 // пустая ячейка — не число
        var a = Number(cell), b = Number(cond.value);
        if (isNaN(a) || isNaN(b)) return false;
        return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      }
      default: return true;
    }
  };

  var conditionActive = function (c) {
    if (!c || !c.field) return false;
    if (OP_NO_VALUE[c.op]) return true;
    if (OP_LIST[c.op]) return parseList(c.value).length > 0;
    return String(c.value == null ? '' : c.value).trim() !== '';
  };

  // Условия применяются последовательно (AND): строка проходит, если удовлетворяет всем.
  var applyConditions = function (dataset, conditions) {
    var active = (conditions || []).filter(conditionActive);
    if (!active.length) return dataset;
    var rows = dataset.rows.filter(function (r) {
      return active.every(function (c) { return matchCondition(r[c.field], c); });
    });
    return { columns: dataset.columns, rows: rows };
  };

  // --- расширенный фильтр (транзиентный слой на «Таблице», не в пресете) ---
  // Строки: { field, op, value, conj }. conj ('and'|'or') — связка с предыдущей активной
  // строкой; у первой активной игнорируется. И приоритетнее ИЛИ: активные строки бьются на
  // OR-группы по conj==='or', внутри группы — И, между группами — ИЛИ.
  var evalRowGroups = function (activeRows, row) {
    var groups = [[]];
    activeRows.forEach(function (c, i) {
      if (i > 0 && c.conj === 'or') groups.push([]);
      groups[groups.length - 1].push(c);
    });
    return groups.some(function (g) {
      return g.every(function (c) { return matchCondition(row[c.field], c); });
    });
  };

  var applyAdvanced = function (dataset, rows) {
    var active = (rows || []).filter(conditionActive);
    if (!active.length) return dataset;
    return {
      columns: dataset.columns,
      rows: dataset.rows.filter(function (r) { return evalRowGroups(active, r); })
    };
  };

  // --- сортировка по столбцу (транзиентная) ---
  var compareValues = function (a, b) {
    var na = Number(a), nb = Number(b);
    if (a !== '' && b !== '' && isFinite(na) && isFinite(nb)) {
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  };

  var applySort = function (rows, sort) {
    if (!sort || !sort.col) return rows;
    var dir = sort.dir === 'desc' ? -1 : 1;
    return rows.map(function (r, i) { return [r, i]; }).sort(function (x, y) {
      // ключ сортировки: типизированный (row.__k) — число для number/date, строка для text
      var kx = x[0].__k ? x[0].__k[sort.col] : undefined;
      var ky = y[0].__k ? y[0].__k[sort.col] : undefined;
      var av = kx !== undefined ? kx : x[0][sort.col];
      var bv = ky !== undefined ? ky : y[0][sort.col];
      var ae = av == null || av === '', be = bv == null || bv === '';
      if (ae || be) return ae && be ? x[1] - y[1] : (ae ? 1 : -1);   // пустые/непарсибельные — в конец
      var c = (typeof av === 'number' && typeof bv === 'number')
        ? (av < bv ? -1 : av > bv ? 1 : 0) : compareValues(av, bv);
      return c !== 0 ? c * dir : x[1] - y[1];                        // стабильность
    }).map(function (p) { return p[0]; });
  };

  // =========================================================================
  // Сущности: формирование столбцов таблицы из выбранных полей (браузерный Level 2)
  // =========================================================================

  var ENTITY_TYPES = [['text', 'текст'], ['number', 'число'], ['date', 'дата'], ['bool', 'логич.']];
  var ENTITY_KINDS = [['field', 'поле'], ['resolve', 'коллизия'], ['derived', 'производная']];
  var DERIVED_OPS = [
    ['sum', 'сумма'], ['avg', 'среднее'], ['min', 'минимум'], ['max', 'максимум'],
    ['concat', 'склейка'], ['first_nonempty', 'первое непустое'], ['count_nonempty', 'кол-во непустых']
  ];
  var _ENT_TYPE = { text: 1, number: 1, date: 1, bool: 1 };
  var _ENT_KIND = { field: 1, resolve: 1, derived: 1 };
  var _DERIVED_OP = { sum: 1, avg: 1, min: 1, max: 1, concat: 1, first_nonempty: 1, count_nonempty: 1 };
  var _DATE_TOKENS = /YYYY|MM|DD|HH|mm|ss/g;

  var _pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  var _swap = function (arr, i, j) {
    if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return arr;
    var out = arr.slice(); var t = out[i]; out[i] = out[j]; out[j] = t; return out;
  };

  // "1 234,56" / "1,234.56" / "99.00" -> число. Разделитель тысяч отбрасывается,
  // десятичный — последний из . или , (или явный opts.decimal).
  var parseNum = function (raw, opts) {
    if (raw == null) return { ok: false, value: null };
    var s = String(raw).replace(/[\s  ]/g, '').replace(/[^0-9.,eE+-]/g, '');
    if (!/\d/.test(s)) return { ok: false, value: null };
    var dec = (opts && opts.decimal) || 'auto';
    var lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    var sep = dec === ',' ? ',' : dec === '.' ? '.' : (lc > ld ? ',' : (ld > -1 ? '.' : ''));
    var i = sep ? s.lastIndexOf(sep) : -1;
    if (i !== -1) {
      s = s.slice(0, i).replace(/[.,]/g, '') + '.' + s.slice(i + 1).replace(/[.,]/g, '');
    } else {
      s = s.replace(/[.,]/g, '');
    }
    var n = Number(s);
    return isFinite(n) ? { ok: true, value: n } : { ok: false, value: null };
  };

  var _mkDate = function (Y, M, D, h, m, s) {
    Y = +Y; M = +M; D = +D;
    var ms = Date.UTC(Y, M - 1, D, +(h || 0), +(m || 0), +(s || 0));
    var d = new Date(ms);
    if (isNaN(ms) || d.getUTCFullYear() !== Y || d.getUTCMonth() !== M - 1 || d.getUTCDate() !== D) {
      return { ok: false, ms: null };
    }
    return { ok: true, ms: ms };
  };

  // fmt === 'auto' — пробуем распространённые формы; иначе токенный шаблон
  // (YYYY MM DD HH mm ss с любыми разделителями). Всё в UTC — детерминировано.
  var parseDate = function (raw, fmt) {
    if (raw == null) return { ok: false, ms: null };
    var s = String(raw).trim();
    if (s === '') return { ok: false, ms: null };
    fmt = fmt || 'auto';
    if (fmt !== 'auto') {
      var toks = [];
      var reStr = fmt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(_DATE_TOKENS, function (t) {
        toks.push(t); return t === 'YYYY' ? '(\\d{4})' : '(\\d{1,2})';
      });
      var mm = s.match(new RegExp('^' + reStr));
      if (!mm) return { ok: false, ms: null };
      var v = { YYYY: 1970, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0 };
      toks.forEach(function (t, i) { v[t] = +mm[i + 1]; });
      return _mkDate(v.YYYY, v.MM, v.DD, v.HH, v.mm, v.ss);
    }
    if (/^\d{9,13}$/.test(s)) {
      var num = Number(s);
      return isFinite(num) ? { ok: true, ms: s.length <= 10 ? num * 1000 : num } : { ok: false, ms: null };
    }
    var m;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return _mkDate(m[1], m[2], m[3], m[4], m[5], m[6]);
    m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return _mkDate(m[3], m[2], m[1], m[4], m[5], m[6]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      var a = +m[1], b = +m[2];
      return _mkDate(m[3], a > 12 ? b : a, a > 12 ? a : b, m[4], m[5], m[6]);
    }
    var p = Date.parse(s);
    return isFinite(p) ? { ok: true, ms: p } : { ok: false, ms: null };
  };

  var formatDate = function (ms, out) {
    if (ms == null) return '';
    var d = new Date(ms);
    var map = {
      YYYY: d.getUTCFullYear(), MM: _pad2(d.getUTCMonth() + 1), DD: _pad2(d.getUTCDate()),
      HH: _pad2(d.getUTCHours()), mm: _pad2(d.getUTCMinutes()), ss: _pad2(d.getUTCSeconds())
    };
    return String(out || 'YYYY-MM-DD').replace(_DATE_TOKENS, function (t) { return map[t]; });
  };

  var parseBool = function (raw, trueTokens) {
    if (raw == null) return { ok: false, value: null };
    var s = String(raw).trim().toLowerCase();
    if (s === '') return { ok: false, value: null };
    var T = String(trueTokens || 'да,true,1,yes,y,+,истина').toLowerCase().split(/[,\s]+/).filter(Boolean);
    var F = ['нет', 'false', '0', 'no', 'n', '-', 'ложь'];
    if (T.indexOf(s) !== -1) return { ok: true, value: true };
    if (F.indexOf(s) !== -1) return { ok: true, value: false };
    return { ok: false, value: null };
  };

  var _numStr = function (n) {
    if (!isFinite(n)) return String(n);
    return (Math.abs(n) >= 1e15 || (n !== 0 && Math.abs(n) < 1e-6))
      ? String(n) : String(Number(n.toPrecision(15)));
  };

  // строка-значение -> {display, key, ok}; промах парсинга -> ok:false, key:null, сырой текст
  var typeCell = function (raw, entity) {
    var t = (entity && entity.type) || 'text';
    if (raw == null) return { display: null, key: null, ok: true };
    var p = (entity && entity.parse) || {};
    if (t === 'number') {
      var rn = parseNum(raw, p);
      return rn.ok ? { display: _numStr(rn.value), key: rn.value, ok: true }
                   : { display: String(raw), key: null, ok: false };
    }
    if (t === 'date') {
      var rd = parseDate(raw, p.date_in);
      return rd.ok ? { display: formatDate(rd.ms, p.date_out || 'YYYY-MM-DD'), key: rd.ms, ok: true }
                   : { display: String(raw), key: null, ok: false };
    }
    if (t === 'bool') {
      var rb = parseBool(raw, p['true']);
      return rb.ok ? { display: rb.value ? 'да' : 'нет', key: rb.value ? 1 : 0, ok: true }
                   : { display: String(raw), key: null, ok: false };
    }
    return { display: String(raw), key: String(raw).toLowerCase(), ok: true };
  };

  var _present = function (v, nullWins) {
    if (v === undefined || v === '') return false;
    if (v === null) return !!nullWins;
    return true;
  };

  // одна ячейка сущности из строки join'а -> строка | null | undefined
  var resolveCell = function (from, jrow) {
    from = from || {};
    if (from.kind === 'resolve') {
      var ins = (from.inputs || [])
        .map(function (x, i) { return { c: x.column, w: Number(x.weight) || 0, i: i }; })
        .filter(function (x) { return x.c; });
      ins.sort(function (a, b) { return b.w - a.w || a.i - b.i; });   // вес desc, затем порядок
      for (var k = 0; k < ins.length; k++) {
        if (_present(jrow[ins[k].c], from.null_wins)) return jrow[ins[k].c];
      }
      return undefined;
    }
    if (from.kind === 'derived') {
      var cols = (from.inputs || []).map(function (x) { return x.column; }).filter(Boolean);
      var vals = cols.map(function (c) { return jrow[c]; })
        .filter(function (v) { return v !== undefined && v !== null && v !== ''; });
      var op = from.op || 'first_nonempty';
      if (!vals.length) return op === 'count_nonempty' ? '0' : undefined;
      if (op === 'first_nonempty') return vals[0];
      if (op === 'count_nonempty') return String(vals.length);
      if (op === 'concat') return vals.join(from.sep == null ? ' ' : String(from.sep));
      var nums = vals.map(function (v) { return parseNum(v, null); });
      if (op === 'sum' || op === 'avg') {
        var got = nums.filter(function (r) { return r.ok; }).map(function (r) { return r.value; });
        if (!got.length) return undefined;
        var acc = got.reduce(function (a, b) { return a + b; }, 0);
        return _numStr(op === 'avg' ? acc / got.length : acc);
      }
      if (op === 'min' || op === 'max') {
        if (nums.every(function (r) { return r.ok; })) {
          var xs = nums.map(function (r) { return r.value; });
          return _numStr(op === 'min' ? Math.min.apply(null, xs) : Math.max.apply(null, xs));
        }
        var srt = vals.slice().sort(function (a, b) {
          return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
        });
        return op === 'min' ? srt[0] : srt[srt.length - 1];
      }
      return vals[0];
    }
    return jrow[from.column];   // kind === 'field'
  };

  var implicitEntities = function (columns) {
    return columns.map(function (c) {
      return { name: c, type: 'text', from: { kind: 'field', column: c } };
    });
  };

  var _uniqName = function (want, taken, idx) {
    var base = (want == null || String(want).trim() === '') ? 'столбец ' + (idx + 1) : String(want);
    var n = base, k = 2;
    while (taken[n] !== undefined) { n = base + ' (' + k + ')'; k++; }
    taken[n] = true;
    return n;
  };

  // joined {columns, rows} + [entity] -> {columns: имена сущностей, rows}
  var resolveEntities = function (joined, entities) {
    var taken = {};
    var names = entities.map(function (e, i) { return _uniqName(e.name, taken, i); });
    var rows = joined.rows.map(function (jr) {
      var out = {};
      entities.forEach(function (e, i) { out[names[i]] = resolveCell(e.from, jr); });
      return out;
    });
    return { columns: names, rows: rows };
  };

  // типизация: row[name] -> display; row.__k[name] -> ключ сортировки; row.__u[name] -> промах
  var parseTypes = function (ds, entities, names) {
    var rows = ds.rows.map(function (r) {
      var out = { __k: {}, __u: {} };
      entities.forEach(function (e, i) {
        var nm = names[i];
        var tc = typeCell(r[nm], e);
        out[nm] = tc.display;
        out.__k[nm] = tc.key;
        if (!tc.ok) out.__u[nm] = true;
      });
      return out;
    });
    return { columns: ds.columns, rows: rows };
  };

  // список столбцов из пресета (без манифеста — для дефолтов в редьюсере)
  var presetColumns = function (preset) {
    var names = Object.keys(preset.query.sources);
    var multi = names.length > 1;
    var out = [];
    names.forEach(function (n) {
      (preset.query.sources[n].labels || []).forEach(function (l) {
        out.push(multi ? n + '.' + l : l);
      });
    });
    return out;
  };

  var _entityColumns = function (preset) {
    var used = {};
    preset.view.entities.forEach(function (e) {
      if (e.from && e.from.kind === 'field' && e.from.column) used[e.from.column] = 1;
    });
    return { all: presetColumns(preset), used: used };
  };

  var mergeEntity = function (cur, patch) {
    var out = Object.assign({}, cur, patch);
    if (patch.from) out.from = Object.assign({}, cur.from || {}, patch.from);
    if (patch.parse) out.parse = Object.assign({}, cur.parse || {}, patch.parse);
    if (patch.format) out.format = Object.assign({}, cur.format || {}, patch.format);
    return out;
  };

  // --- строка условия: общие контролы для «Конструктора» и расширенного фильтра ---
  var opSelect = function (curOp, onChange) {
    return el('select', { onchange: function (e) { onChange(e.target.value); } },
      OPERATORS.map(function (o) {
        return el('option', { value: o[0], selected: o[0] === curOp }, o[1]);
      }));
  };

  var valueControl = function (op, value, onValue) {
    if (OP_LIST[op]) {
      return el('div', { class: 'cond-list-wrap' },
        el('textarea', {
          class: 'cond-list', rows: 3,
          placeholder: 'значения: по одному в строке или через запятую',
          onchange: function (e) { onValue(e.target.value); }
        }, value || ''),
        el('div', { class: 'cond-list-tools' },
          el('button', {
            class: 'link', type: 'button',
            onclick: function () {
              pasteFromClipboard(function (text) {
                var cur = value || '';
                onValue(cur.trim() ? cur.replace(/\s+$/, '') + '\n' + text : text);
              });
            }
          }, 'Вставить из буфера'),
          el('span', { class: 'muted' }, parseList(value).length + ' знач.')
        )
      );
    }
    return el('input', {
      type: 'text', class: 'cond-value', value: value || '',
      placeholder: OP_NO_VALUE[op] ? '—' : 'значение',
      disabled: !!OP_NO_VALUE[op],
      onchange: function (e) { onValue(e.target.value); }
    });
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

  // Одна строка <Row> SpreadsheetML. Пустая ячейка — <Cell/> (позицию столбца
  // держит сама, ss:Index не нужен). Тип всегда String: office-пакет не приведёт
  // "007" / "99.00" к числу при открытии.
  var xlsRow = function (values) {
    return '    <Row>' + values.map(function (v) {
      return (v == null || v === '')
        ? '<Cell/>'
        : '<Cell><Data ss:Type="String">' + xmlEsc(v) + '</Data></Cell>';
    }).join('') + '</Row>';
  };

  // Один настоящий лист SpreadsheetML: имя вкладки = name, шапка + строки данных.
  // opts: {selected, hidden, protect}
  var xlsWorksheet = function (name, dataset, columns, opts) {
    var rows = [xlsRow(columns)].concat(dataset.rows.map(function (r) {
      return xlsRow(columns.map(function (c) { return r[c]; }));
    }));
    var wo = [];
    if (opts.selected) { wo.push('     <Selected/>'); }
    if (opts.hidden) { wo.push('     <Visible>SheetHidden</Visible>'); }
    if (opts.protect) {
      // Пустой пароль: защита включена, снимается без пароля.
      wo.push('     <ProtectContents>True</ProtectContents>');
      wo.push('     <ProtectObjects>True</ProtectObjects>');
      wo.push('     <ProtectScenarios>True</ProtectScenarios>');
    }
    return [
      '  <Worksheet ss:Name="' + xmlEsc(name) + '"' + (opts.protect ? ' ss:Protected="1"' : '') + '>',
      '   <Table>',
      rows.join('\n'),
      '   </Table>',
      '   <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">',
      wo.join('\n'),
      '   </WorksheetOptions>',
      '  </Worksheet>'
    ].join('\n');
  };

  // Книга SpreadsheetML 2003 (Excel XML, расширение .xls) — два настоящих листа
  // с одинаковыми данными: "user" (видимый, активный) и "system" (скрытый и
  // защищённый от изменений, пустой пароль). Именованные вкладки открывают и
  // настольный Microsoft Excel, и LibreOffice / AlterOffice; скрытие и защиту
  // листа последние могут не применять — тогда это два обычных листа
  // "user" / "system". Без библиотек.
  var toXlsWorkbook = function (dataset, columns) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?mso-application progid="Excel.Sheet"?>',
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
      '          xmlns:o="urn:schemas-microsoft-com:office:office"',
      '          xmlns:x="urn:schemas-microsoft-com:office:excel"',
      '          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
      xlsWorksheet('user', dataset, columns, { selected: true }),
      xlsWorksheet('system', dataset, columns, { hidden: true, protect: true }),
      '</Workbook>'
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
      name: 'base', query: { as_of: null, sources: {} }, view: { joins: [], conditions: [], entities: [] }
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
        conditions: normalizeConditions(view),
        entities: normalizeEntities(view)
      }
    };
  };

  // view.entities [{name, type, parse, format, from}] -> чистая форма
  var normalizeEntities = function (view) {
    var raw = Array.isArray(view.entities) ? view.entities : [];
    return raw.map(function (e) {
      e = e && typeof e === 'object' ? e : {};
      var f = e.from && typeof e.from === 'object' ? e.from : {};
      var kind = _ENT_KIND[f.kind] ? f.kind : 'field';
      var inputs = (Array.isArray(f.inputs) ? f.inputs : []).map(function (x) {
        x = x && typeof x === 'object' ? x : {};
        return {
          column: typeof x.column === 'string' ? x.column : '',
          weight: x.weight == null || x.weight === '' ? 0.5 : Number(x.weight)
        };
      }).filter(function (x) { return x.column; });
      var from = { kind: kind };
      if (kind === 'field') {
        from.column = typeof f.column === 'string' ? f.column : '';
      } else if (kind === 'resolve') {
        from.inputs = inputs;
        from.null_wins = f.null_wins !== false;
      } else {
        from.inputs = inputs;
        from.op = _DERIVED_OP[f.op] ? f.op : 'first_nonempty';
        if (from.op === 'concat') from.sep = f.sep == null ? ' ' : String(f.sep);
      }
      var out = {
        name: typeof e.name === 'string' ? e.name : '',
        type: _ENT_TYPE[e.type] ? e.type : 'text',
        from: from
      };
      var p = e.parse && typeof e.parse === 'object' ? e.parse : null;
      if (p) {
        out.parse = {};
        if (p.date_in != null) out.parse.date_in = String(p.date_in);
        if (p.date_out != null) out.parse.date_out = String(p.date_out);
        if (p['true'] != null) out.parse['true'] = String(p['true']);
        if (p.decimal != null) out.parse.decimal = String(p.decimal);
      }
      var fm = e.format && typeof e.format === 'object' ? e.format : null;
      if (fm) {
        out.format = {};
        if (fm.width != null && fm.width !== '') out.format.width = Number(fm.width);
        if (['left', 'center', 'right'].indexOf(fm.align) !== -1) out.format.align = fm.align;
        if (fm.font_size != null && fm.font_size !== '') out.format.font_size = Number(fm.font_size);
      }
      return out;
    }).filter(function (e) {
      return e.from.kind === 'field' ? e.from.column !== '' : e.from.inputs.length > 0;
    });
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
    author: '',              // «источник» в имени выгружаемого файла
    building: false,
    buildError: null,
    dataset: null,
    tableFilters: {},
    groupBy: '',
    hideEmpty: false,
    expanded: {},
    srcOpen: {},              // конструктор: у каких источников развёрнут список показателей
    adv: [],                 // расширенный фильтр (транзиентный, не в пресете)
    advOpen: false,          // панель расширенного фильтра развёрнута
    sort: null               // { col, dir: 'asc'|'desc' } | null — сортировка столбца
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
          tableFilters: {}, groupBy: '', hideEmpty: false, expanded: {},
          adv: [], sort: null            // транзиентные слои сбрасываются при пересборке
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

      case 'table/sort': {
        var s = state.sort;
        var next = (!s || s.col !== a.column) ? { col: a.column, dir: 'asc' }
          : s.dir === 'asc' ? { col: a.column, dir: 'desc' }
          : null;
        return Object.assign({}, state, { sort: next });
      }

      case 'adv/toggle':
        return Object.assign({}, state, { advOpen: !state.advOpen });

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
  // Представление
  // ---------------------------------------------------------------------------

  var cellNode = function (v, entity, unparsed) {
    var st = '';
    var fmt = entity && entity.format;
    if (fmt) {
      if (fmt.align) st += 'text-align:' + fmt.align + ';';
      if (fmt.font_size) st += 'font-size:' + Number(fmt.font_size) + 'px;';
    }
    var attrs = st ? { style: st } : {};
    if (v === null) { attrs.class = 'del'; attrs.title = 'удалено (DELETE)'; return el('td', attrs, '∅'); }
    if (v === undefined || v === '') { attrs.class = 'empty'; return el('td', attrs, ''); }
    if (unparsed) {
      attrs.class = 'unparsed';
      attrs.title = 'не распознано как «' + ((entity && entity.type) || 'text') + '»';
    }
    return el('td', attrs, String(v));
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
    var advBtn = state.route === 'table'
      ? el('button', {
          class: 'gear' + (state.advOpen ? ' on' : ''),
          title: 'Расширенный фильтр: временные условия поверх выборки (не сохраняются)',
          onclick: function () { d({ type: 'adv/toggle' }); }
        }, 'Расширенный фильтр ' + (state.advOpen ? '▾' : '▸'))
      : null;
    return el('header', { class: 'nav' },
      el('strong', {}, 'ds-webui'),
      el('span', { class: 'spacer' }),
      state.dataDir
        ? el('span', { class: 'muted src-dir' }, 'данные: ' + state.dataDir + '/')
        : el('span', { class: 'muted src-dir warn' }, 'нет data/ и sample-data/'),
      advBtn,
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
      var open = picked && !!state.srcOpen[ms.name];      // список показателей развёрнут
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
        el('div', { class: 'src-head' },
          el('button', {
            type: 'button', class: 'src-fold', disabled: !picked,
            title: !picked ? 'сначала отметьте источник'
                 : (open ? 'свернуть показатели' : 'развернуть показатели'),
            onclick: function () { if (picked) d({ type: 'ui/toggleSrc', name: ms.name }); }
          }, open ? '−' : '+'),
          el('label', { class: 'src-pick' },
            el('input', {
              type: 'checkbox', checked: picked,
              onchange: function () { d({ type: 'preset/toggleSource', name: ms.name }); }
            }),
            el('span', { class: 'src-name' }, ms.name)
          ),
          el('span', { class: 'muted' }, ms.rows + ' строк · срез ' + fmtDate(ms.as_of)),
          picked ? el('span', { class: 'muted src-fields-n' },
            '· показателей: ' + wanted.length + ' из ' + fields.length) : null,
          badge(ms)
        ),
        open ? el('div', { class: 'field-list' },
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

    // поля для условий: имена сущностей (итоговые столбцы) + на всякий случай сырые столбцы
    var entityNames = preset.view.entities.map(function (e, i) {
      return (e.name == null || String(e.name).trim() === '') ? 'столбец ' + (i + 1) : String(e.name);
    });
    var condFields = entityNames.length
      ? entityNames.concat(pickedColumns.filter(function (c) { return entityNames.indexOf(c) === -1; }))
      : pickedColumns;

    var conditionRow = function (cond, i) {
      var patch = function (p) { d({ type: 'preset/updateCondition', index: i, patch: p }); };
      return el('div', { class: 'condition' + (OP_LIST[cond.op] ? ' has-list' : '') },
        el('select', { onchange: function (e) { patch({ field: e.target.value }); } },
          [el('option', { value: '' }, 'поле…')].concat(condFields.map(function (c) {
            return el('option', { value: c, selected: c === cond.field }, c);
          }))),
        opSelect(cond.op, function (v) { patch({ op: v }); }),
        valueControl(cond.op, cond.value, function (v) { patch({ value: v }); }),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/removeCondition', index: i }); } }, '✕')
      );
    };

    // ---- сущности (столбцы таблицы) ----
    var colSelect = function (cur, onChange) {
      return el('select', { onchange: function (e) { onChange(e.target.value); } },
        [el('option', { value: '' }, 'поле…')].concat(pickedColumns.map(function (c) {
          return el('option', { value: c, selected: c === cur }, c);
        })));
    };

    var entityInputs = function (e, i, withWeight) {
      return el('div', { class: 'entity-inputs' },
        (e.from.inputs || []).map(function (inp, ii) {
          return el('div', { class: 'entity-input' },
            colSelect(inp.column, function (v) {
              d({ type: 'preset/updateEntityInput', index: i, ii: ii, patch: { column: v } });
            }),
            withWeight ? el('input', {
              type: 'number', class: 'ent-weight', step: '0.05', min: '0', max: '1',
              value: inp.weight == null ? '' : String(inp.weight), placeholder: 'вес',
              onchange: function (ev) {
                d({ type: 'preset/updateEntityInput', index: i, ii: ii,
                    patch: { weight: ev.target.value === '' ? 0 : Number(ev.target.value) } });
              }
            }) : null,
            el('button', { class: 'link', onclick: function () { d({ type: 'preset/moveEntityInput', index: i, ii: ii, dir: -1 }); } }, '↑'),
            el('button', { class: 'link', onclick: function () { d({ type: 'preset/moveEntityInput', index: i, ii: ii, dir: 1 }); } }, '↓'),
            el('button', { class: 'link', onclick: function () { d({ type: 'preset/removeEntityInput', index: i, ii: ii }); } }, '✕')
          );
        }),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/addEntityInput', index: i }); } }, '+ вход')
      );
    };

    var entityRow = function (e, i) {
      var up = function (patch) { d({ type: 'preset/updateEntity', index: i, patch: patch }); };
      var kind = (e.from && e.from.kind) || 'field';
      var fmt = e.format || {};
      var pp = e.parse || {};

      var body;
      if (kind === 'resolve') {
        body = el('div', {},
          entityInputs(e, i, true),
          el('label', { class: 'chk' },
            el('input', {
              type: 'checkbox', checked: e.from.null_wins !== false,
              onchange: function (ev) { up({ from: { null_wins: ev.target.checked } }); }
            }),
            'null (DELETE) из весомого источника побеждает'),
          el('p', { class: 'muted', style: 'margin:.2rem 0 0' }, 'при равных весах — по порядку сверху вниз')
        );
      } else if (kind === 'derived') {
        body = el('div',{},
          el('select', { onchange: function (ev) { up({ from: { op: ev.target.value } }); } },
            DERIVED_OPS.map(function (o) {
              return el('option', { value: o[0], selected: o[0] === (e.from.op || 'first_nonempty') }, o[1]);
            })),
          e.from.op === 'concat' ? el('input', {
            type: 'text', class: 'ent-sep', value: e.from.sep == null ? ' ' : e.from.sep, placeholder: 'разделитель',
            onchange: function (ev) { up({ from: { sep: ev.target.value } }); }
          }) : null,
          entityInputs(e, i, false)
        );
      } else {
        body = colSelect(e.from.column, function (v) { up({ from: { column: v } }); });
      }

      var typeExtra = null;
      if (e.type === 'date') {
        typeExtra = el('div', { class: 'entity-format' },
          el('label', { class: 'field small' }, 'формат входа',
            el('input', { type: 'text', value: pp.date_in || 'auto', placeholder: 'auto | DD.MM.YYYY',
              onchange: function (ev) { up({ parse: { date_in: ev.target.value } }); } })),
          el('label', { class: 'field small' }, 'формат вывода',
            el('input', { type: 'text', value: pp.date_out || 'YYYY-MM-DD',
              onchange: function (ev) { up({ parse: { date_out: ev.target.value } }); } }))
        );
      } else if (e.type === 'bool') {
        typeExtra = el('div', { class: 'entity-format' },
          el('label', { class: 'field small' }, 'токены истины (через запятую)',
            el('input', { type: 'text', value: pp['true'] || 'да,true,1,yes,y,+',
              onchange: function (ev) { up({ parse: { 'true': ev.target.value } }); } })));
      } else if (e.type === 'number') {
        typeExtra = el('div', { class: 'entity-format' },
          el('label', { class: 'field small' }, 'десятичный разделитель',
            el('select', { onchange: function (ev) { up({ parse: { decimal: ev.target.value } }); } },
              [['auto', 'авто'], ['.', 'точка'], [',', 'запятая']].map(function (o) {
                return el('option', { value: o[0], selected: o[0] === (pp.decimal || 'auto') }, o[1]);
              }))));
      }

      return el('div', { class: 'entity' },
        el('div', { class: 'entity-head' },
          el('button', { class: 'link', onclick: function () { d({ type: 'preset/moveEntity', index: i, dir: -1 }); } }, '↑'),
          el('button', { class: 'link', onclick: function () { d({ type: 'preset/moveEntity', index: i, dir: 1 }); } }, '↓'),
          el('input', {
            type: 'text', class: 'ent-alias', value: e.name || '', placeholder: 'название столбца',
            onchange: function (ev) { up({ name: ev.target.value }); }
          }),
          el('select', { onchange: function (ev) { up({ type: ev.target.value }); } },
            ENTITY_TYPES.map(function (o) { return el('option', { value: o[0], selected: o[0] === (e.type || 'text') }, o[1]); })),
          el('select', { onchange: function (ev) { up({ from: { kind: ev.target.value } }); } },
            ENTITY_KINDS.map(function (o) { return el('option', { value: o[0], selected: o[0] === kind }, o[1]); })),
          el('button', { class: 'link', onclick: function () { d({ type: 'preset/removeEntity', index: i }); } }, '✕')
        ),
        el('div', { class: 'entity-body' }, body),
        typeExtra,
        el('div', { class: 'entity-format' },
          el('label', { class: 'field small' }, 'ширина, px',
            el('input', {
              type: 'number', min: '20', step: '10', value: fmt.width == null ? '' : String(fmt.width),
              onchange: function (ev) { up({ format: { width: ev.target.value === '' ? null : Number(ev.target.value) } }); }
            })),
          el('label', { class: 'field small' }, 'выравнивание',
            el('select', { onchange: function (ev) { up({ format: { align: ev.target.value } }); } },
              [['', '—'], ['left', 'влево'], ['center', 'по центру'], ['right', 'вправо']].map(function (o) {
                return el('option', { value: o[0], selected: o[0] === (fmt.align || '') }, o[1]);
              }))),
          el('label', { class: 'field small' }, 'кегль, px',
            el('input', {
              type: 'number', min: '8', step: '1', value: fmt.font_size == null ? '' : String(fmt.font_size),
              onchange: function (ev) { up({ format: { font_size: ev.target.value === '' ? null : Number(ev.target.value) } }); }
            }))
        )
      );
    };

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
        el('h2', {}, 'Сущности (столбцы таблицы)'),
        preset.view.entities.length
          ? el('div', { class: 'entities' }, preset.view.entities.map(entityRow))
          : el('p', { class: 'muted' }, 'сущностей нет — таблица покажет выбранные поля как есть'),
        el('div', { class: 'row', style: 'gap:.5rem;margin:.4rem 0 0' },
          el('button', { class: 'link', onclick: function () { d({ type: 'preset/addEntity' }); } }, '+ сущность'),
          el('button', { class: 'link', onclick: function () { d({ type: 'preset/addAllFieldsAsEntities' }); } },
            '+ все выбранные поля (1:1)')
        ),
        el('p', { class: 'muted', style: 'margin:.3rem 0 0' },
          'сущность = один столбец: поле как есть, разрешение коллизии по весам, либо производная. '
          + 'Порядок строк = порядок столбцов. Тип задаёт парсинг (даты/числа), непарсибельное подсвечивается.')
      ) : null,

      pickedColumns.length ? el('div', {},
        el('h2', {}, 'Условия (сужают выборку при построении)'),
        el('div', { class: 'conditions' }, preset.view.conditions.map(conditionRow)),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/addCondition' }); } }, '+ условие'),
        el('p', { class: 'muted', style: 'margin:.3rem 0 0' },
          'применяются по порядку (И) при построении — на «Таблице» останутся только подходящие строки')
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
      el('div', { class: 'advfilter', id: 'advfilter' }),
      el('div', { class: 'grid-wrap', id: 'grid' })
    );
  };

  // ---- Расширенный фильтр (панель над таблицей; не сохраняется) ----------

  var renderAdvFilter = function (state, d) {
    var node = document.getElementById('advfilter');
    if (!node) return;
    clear(node);
    if (!state.advOpen || !state.dataset) return;

    var cols = state.dataset.columns;
    var advRow = function (row, i) {
      var patch = function (p) { d({ type: 'adv/update', index: i, patch: p }); };
      return el('div', { class: 'condition' + (OP_LIST[row.op] ? ' has-list' : '') },
        i === 0
          ? el('span', { class: 'adv-conj-spacer' })
          : el('select', { class: 'adv-conj', onchange: function (e) { patch({ conj: e.target.value }); } },
              el('option', { value: 'and', selected: row.conj !== 'or' }, 'И'),
              el('option', { value: 'or', selected: row.conj === 'or' }, 'ИЛИ')),
        el('select', { onchange: function (e) { patch({ field: e.target.value }); } },
          [el('option', { value: '' }, 'поле…')].concat(cols.map(function (c) {
            return el('option', { value: c, selected: c === row.field }, c);
          }))),
        opSelect(row.op, function (v) { patch({ op: v }); }),
        valueControl(row.op, row.value, function (v) { patch({ value: v }); }),
        el('button', { class: 'link', onclick: function () { d({ type: 'adv/remove', index: i }); } }, '✕')
      );
    };

    var shown = applyAdvanced(state.dataset, state.adv).rows.length;

    node.appendChild(el('div', { class: 'advfilter-panel' },
      el('div', { class: 'advfilter-head' },
        el('strong', {}, 'Расширенный фильтр'),
        el('span', { class: 'muted' }, ' — поверх настроек, до быстрых; не входит в пресет'),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'link', disabled: !state.adv.length,
          onclick: function () { d({ type: 'adv/reset' }); }
        }, 'Сбросить всё'),
        el('button', { class: 'link', onclick: function () { d({ type: 'adv/toggle' }); } }, 'Скрыть')
      ),
      state.adv.length
        ? el('div', { class: 'conditions' }, state.adv.map(advRow))
        : el('p', { class: 'muted', style: 'margin:.2rem 0' }, 'условий нет — выборка как из «Конструктора»'),
      el('div', { class: 'advfilter-foot' },
        el('button', { class: 'link', onclick: function () { d({ type: 'adv/add' }); } }, '+ условие'),
        el('span', { class: 'muted' }, 'показано ' + shown + ' из ' + state.dataset.rows.length)
      )
    ));
  };

  // --- быстрые фильтры столбцов: ввод — черновик, применение — Enter / кнопка ---
  var colFilterDraft = {};   // столбец -> введённый, но ещё не применённый текст
  var FUNNEL_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">'
    + '<path fill="currentColor" d="M1.7 2h12.6a.5.5 0 0 1 .4.8L10 9.2v3.5a.5.5 0 0 1-.7.46l-2.5-1.1'
    + 'A.5.5 0 0 1 6.3 11.6V9.2L1.3 2.8A.5.5 0 0 1 1.7 2Z"/></svg>';

  var renderGrid = function (state, d) {
    var node = document.getElementById('grid');
    if (!node) return;
    clear(node);

    if (!state.dataset) {
      node.appendChild(el('p', { class: 'muted' }, 'Сначала постройте таблицу в «Конструкторе выборки».'));
      return;
    }

    var cols = visibleColumns(state.dataset, state.hideEmpty);
    var entMap = {};
    (state.dataset.entities || []).forEach(function (e) { entMap[e.name] = e; });
    // конвейер: built dataset -> расширенный фильтр -> быстрые фильтры -> сортировка
    var afterAdv = applyAdvanced(state.dataset, state.adv);
    var afterQuick = applyFilters(afterAdv, state.tableFilters);
    var filtered = { columns: afterQuick.columns, rows: applySort(afterQuick.rows, state.sort) };

    // черновики для исчезнувших столбцов не держим
    Object.keys(colFilterDraft).forEach(function (k) {
      if (state.dataset.columns.indexOf(k) === -1) delete colFilterDraft[k];
    });

    var applyColFilter = function (c, value) {
      delete colFilterDraft[c];
      d({ type: 'table/setFilter', column: c, value: value });
      // грид перерисован синхронно — вернуть фокус в то же поле
      var g = document.getElementById('grid');
      if (g) [].some.call(g.querySelectorAll('.col-filter'), function (n) {
        if (n.dataset.col !== c) return false;
        n.focus();
        n.setSelectionRange(n.value.length, n.value.length);
        return true;
      });
    };

    var head = el('tr', {}, cols.map(function (c) {
      var applied = state.tableFilters[c] || '';
      var draft = colFilterDraft[c] !== undefined ? colFilterDraft[c] : applied;
      var field;
      var input = el('input', {
        type: 'text', class: 'col-filter', value: draft, placeholder: 'фильтр…',
        title: 'Текст + Enter (или кнопка справа) — применить; Esc — отменить ввод',
        dataset: { col: c },
        oninput: function (e) {
          colFilterDraft[c] = e.target.value;
          field.classList.toggle('dirty', e.target.value !== (state.tableFilters[c] || ''));
        },
        onkeydown: function (e) {
          if (e.key === 'Enter') { e.preventDefault(); applyColFilter(c, e.target.value); }
          else if (e.key === 'Escape') {
            e.preventDefault();
            delete colFilterDraft[c];
            e.target.value = state.tableFilters[c] || '';
            field.classList.remove('dirty');
          }
        }
      });
      field = el('div', { class: 'col-filter-field' + (draft !== applied ? ' dirty' : '') },
        input,
        el('button', {
          type: 'button', class: 'col-filter-apply', html: FUNNEL_SVG,
          title: 'Применить фильтр',
          onclick: function () { applyColFilter(c, input.value); }
        })
      );
      var sortDir = state.sort && state.sort.col === c ? state.sort.dir : null;
      return el('th', {},
        el('div', {
          class: 'col-name' + (sortDir ? ' sorted' : ''),
          title: 'Клик — сортировка по столбцу (по возр. / по убыв. / без)',
          onclick: function () { d({ type: 'table/sort', column: c }); }
        }, c, sortDir ? el('span', { class: 'sort-ind' }, sortDir === 'asc' ? ' ▲' : ' ▼') : null),
        field
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
          bodyRows.push(el('tr', { class: 'member' }, cols.map(function (c) {
            return cellNode(r[c], entMap[c], r.__u && r.__u[c]);
          })));
        });
      });

      node.appendChild(el('div', { class: 'grp-actions' },
        el('button', { class: 'link', onclick: function () { d({ type: 'table/expandAll', keys: keys }); } }, 'развернуть все'),
        el('button', { class: 'link', onclick: function () { d({ type: 'table/collapseAll' }); } }, 'свернуть все')
      ));
    } else {
      filtered.rows.forEach(function (r) {
        bodyRows.push(el('tr', {}, cols.map(function (c) {
          return cellNode(r[c], entMap[c], r.__u && r.__u[c]);
        })));
      });
    }

    node.appendChild(el('div', { class: 'count muted' },
      'строк: ' + filtered.rows.length + ' из ' + state.dataset.rows.length
      + ' · колонок: ' + cols.length));
    var colgroup = el('colgroup', {}, cols.map(function (c) {
      var w = entMap[c] && entMap[c].format && entMap[c].format.width;
      return el('col', w ? { style: 'width:' + Number(w) + 'px' } : {});
    }));
    node.appendChild(el('div', { class: 'scroll' },
      el('table', { class: 'data' }, colgroup, el('thead', {}, head), el('tbody', {}, bodyRows))
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

    if (state.route === 'table') {
      renderAdvFilter(state, d);
      renderGrid(state, d);
    }
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
