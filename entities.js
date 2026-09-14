'use strict';

// Сущности: формирование столбцов таблицы из выбранных полей (браузерный
// Level 2) — типизация, парсинг чисел/дат/bool, резолюция коллизий,
// производные показатели. Самая рискованная логика в приложении — граничные
// случаи (серийная дата Excel, неоднозначные разделители) легче всего
// сломать правкой «на глаз», см. tests/entities.test.js. Не зависит от
// других модулей.
(function (root) {

  // ручная ширина столбцов «Таблицы» (px); та же шкала уходит в выгрузку Excel
  var DEFAULT_COL_W = 150;   // px, если для столбца ничего не задано
  var MIN_COL_W = 48;        // px, ниже не ужимаем перетаскиванием

  // выбранная/дефолтная ширина столбца c в px: пользовательская → формат сущности → дефолт
  var colWidthPx = function (state) {
    var cw = (state.preset && state.preset.view && state.preset.view.column_widths) || {};
    var em = {};
    ((state.dataset && state.dataset.entities) || []).forEach(function (e) { em[e.name] = e; });
    return function (c) {
      return cw[c] || (em[c] && em[c].format && em[c].format.width) || DEFAULT_COL_W;
    };
  };

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

  // "1 234,56" / "1,234.56" / "99.00" -> число. Разделитель тысяч отбрасывается,
  // десятичный — последний из . или , (или явный opts.decimal).
  var parseNum = function (raw, opts) {
    if (raw == null) return { ok: false, value: null };
    var s = String(raw).replace(/[\s  ]/g, '').replace(/[^0-9.,eE+-]/g, '');
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

  // Серийная дата Excel/1900 (число дней от 1899-12-30, с исторической ошибкой
  // «1900 — високосный»). Константа 25569 = дней от этой эпохи до 1970-01-01.
  // Дробная часть — доля суток. Диапазон 1..2958465 = 1900-01-01 .. 9999-12-31.
  var _excelSerialToMs = function (n) {
    if (!isFinite(n) || n < 1 || n > 2958465) return null;
    return Math.round((n - 25569) * 86400000);
  };

  // fmt === 'auto' — пробуем распространённые формы (в т.ч. серийную дату Excel
  // 5–7 цифр); 'excel' / 'serial' — только серийная дата; иначе токенный шаблон
  // (YYYY MM DD HH mm ss с любыми разделителями). Всё в UTC — детерминировано.
  var parseDate = function (raw, fmt) {
    if (raw == null) return { ok: false, ms: null };
    var s = String(raw).trim();
    if (s === '') return { ok: false, ms: null };
    fmt = fmt || 'auto';
    if (fmt === 'excel' || fmt === 'serial') {
      var ems = _excelSerialToMs(Number(s.replace(',', '.')));
      return ems == null ? { ok: false, ms: null } : { ok: true, ms: ems };
    }
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
    // серийная дата Excel: 5–7 цифр (≈ 1927…), опц. дробная часть суток.
    // Короче unix-таймстемпа (9+ цифр) — не пересекается.
    if (/^\d{5,7}(?:[.,]\d+)?$/.test(s)) {
      var esm = _excelSerialToMs(Number(s.replace(',', '.')));
      if (esm != null) return { ok: true, ms: esm };
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

  // итоговые (дедуплицированные) имена столбцов для набора сущностей —
  // ровно то, чем будут ключи строк после resolveEntities/parseTypes
  var entityOutNames = function (entities) {
    var taken = {};
    return (entities || []).map(function (e, i) { return _uniqName(e.name, taken, i); });
  };

  // joined {columns, rows} + [entity] -> {columns: имена сущностей, rows}
  var resolveEntities = function (joined, entities) {
    var names = entityOutNames(entities);
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

  var api = {
    DEFAULT_COL_W: DEFAULT_COL_W, MIN_COL_W: MIN_COL_W, colWidthPx: colWidthPx,
    ENTITY_TYPES: ENTITY_TYPES, ENTITY_KINDS: ENTITY_KINDS, DERIVED_OPS: DERIVED_OPS,
    parseNum: parseNum, parseDate: parseDate, formatDate: formatDate, parseBool: parseBool,
    typeCell: typeCell, resolveCell: resolveCell, implicitEntities: implicitEntities,
    entityOutNames: entityOutNames, resolveEntities: resolveEntities, parseTypes: parseTypes,
    presetColumns: presetColumns, _entityColumns: _entityColumns, mergeEntity: mergeEntity,
    normalizeEntities: normalizeEntities
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, api);
  }
})(typeof window !== 'undefined' ? window : this);
