'use strict';

// Датасет: JOIN источников (left/right/inner/full), условия выборки,
// расширенный фильтр, быстрые фильтры, сортировка. Единственная зависимость —
// util.js (omit).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./util.js'));
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, factory(root.DS_APP));
  }
})(typeof window !== 'undefined' ? window : this, function (Util) {

  var omit = Util.omit;

  // Виды связки между источниками; порядок = порядок в выпадающем списке.
  var JOIN_TYPES = [
    ['left', 'левое (LEFT)'],
    ['right', 'правое (RIGHT)'],
    ['inner', 'внутреннее (INNER)'],
    ['full', 'полное (FULL)']
  ];
  var JOIN_TYPE_IDS = JOIN_TYPES.map(function (t) { return t[0]; });

  // JOIN нескольких источников (LEFT/RIGHT/INNER/FULL — j.type, по умолчанию
  // 'left', для обратной совместимости с пресетами без этого поля).
  // selected: [{name, key, labels, data}]. joins: [{left, left_field, right,
  // right_field, type}]. База (selected[0]) входит целиком первым шагом; каждый
  // следующий источник присоединяется к УЖЕ накопленным строкам — j.left может
  // называть любой источник, вошедший в выборку раньше (не обязательно
  // непосредственно предыдущий). Колонки при >1 источнике квалифицируются как
  // "<Source>.<label>". Ключевой показатель источника — обычное выбираемое
  // поле: он попадает в колонки, только если присутствует в s.labels (иначе
  // используется лишь для сопоставления при JOIN).
  //
  // Из-за key-based сопоставления (Map по строковому значению поля, без учёта
  // повторов) это не полный реляционный JOIN с декартовым произведением при
  // дублирующихся ключах справа — как и раньше, побеждает последняя строка с
  // таким ключом. RIGHT/FULL добавляют «неспарившиеся» строки правого
  // источника отдельным проходом — с undefined во всех остальных колонках
  // (кроме собственных полей источника).
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
      var type = JOIN_TYPE_IDS.indexOf(j.type) !== -1 ? j.type : 'left';
      var idx = new Map();
      s.data.forEach(function (r) {
        var k = r[j.right_field];
        if (k != null) idx.set(String(k), r);
      });
      var usedKeys = new Set();

      var merged = [];
      rows.forEach(function (o) {
        var leftRow = o.__match[j.left];
        var key = leftRow ? leftRow[j.left_field] : undefined;
        var m = key != null ? idx.get(String(key)) : undefined;
        if (m) usedKeys.add(String(key));
        if (!m && (type === 'inner' || type === 'right')) return;   // без пары справа — выбросить
        var next = Object.assign({}, o);
        s.labels.forEach(function (l) { next[col(s.name, l)] = m && l in m ? m[l] : undefined; });
        next.__match = Object.assign({}, o.__match);
        next.__match[s.name] = m;
        merged.push(next);
      });

      if (type === 'right' || type === 'full') {
        s.data.forEach(function (r) {
          var k = r[j.right_field];
          if (k != null && usedKeys.has(String(k))) return;   // уже отдана хоть одной строке слева
          var o = { __match: {} };
          o.__match[s.name] = r;
          s.labels.forEach(function (l) { o[col(s.name, l)] = l in r ? r[l] : undefined; });
          merged.push(o);
        });
      }

      rows = merged;
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
  // Условие на несуществующий столбец (устаревший пресет / переименованная сущность)
  // пропускается — иначе оно молча обнуляло бы всю выборку.
  var applyConditions = function (dataset, conditions) {
    var have = {};
    dataset.columns.forEach(function (c) { have[c] = 1; });
    var active = (conditions || []).filter(function (c) {
      return conditionActive(c) && have[c.field];
    });
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

  var visibleColumns = function (dataset, hideEmpty) {
    if (!hideEmpty) return dataset.columns;
    return dataset.columns.filter(function (c) {
      return dataset.rows.some(function (r) { return r[c] != null && r[c] !== ''; });
    });
  };

  return {
    joinSources: joinSources, JOIN_TYPES: JOIN_TYPES, JOIN_TYPE_IDS: JOIN_TYPE_IDS,
    matchesFilter: matchesFilter, applyFilters: applyFilters,
    OPERATORS: OPERATORS, OP_IDS: OP_IDS, OP_NO_VALUE: OP_NO_VALUE, OP_LIST: OP_LIST,
    parseList: parseList, matchCondition: matchCondition, conditionActive: conditionActive,
    applyConditions: applyConditions, evalRowGroups: evalRowGroups, applyAdvanced: applyAdvanced,
    compareValues: compareValues, applySort: applySort, visibleColumns: visibleColumns
  };
});
