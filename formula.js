'use strict';

// Формула для kind === 'formula' на странице «Индикаторы» (entities.js::resolveCell).
// Собственный токенайзер/парсер/вычислитель -- НЕ eval/new Function: пресеты -- обычный
// JSON/JS-файл, который можно скачать и передать другому человеку; формула как настоящий
// исполняемый JS-код была бы вектором выполнения чужого кода при открытии чужого пресета.
//
// Буквы-переменные (A, B, ..., Z, AA, AB, ...) -- позиционные имена входов (letterFor), их
// значения на момент вычисления строки передаёт вызывающий (entities.js). [Источник.
// Показатель] -- прямая ссылка на сырое поле join'а, минуя буквы. Функции -- в FUNCTIONS
// ниже, отдельная таблица, легко расширяемая (сейчас только арифметика).
//
// Не зависит ни от entities.js, ни от dataset.js (только от самого себя) -- entities.js
// будет зависеть от этого модуля, зависимость в обратную сторону создала бы цикл. Поэтому
// здесь свой минимальный toNumber/compare, не делится с entities.js::parseNum/
// dataset.js::compareValues -- другой уровень строгости тут не нужен.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, factory());
  }
})(typeof window !== 'undefined' ? window : this, function () {

  // 0-based индекс -> "A".."Z","AA".."AZ","BA"... (как нумерация столбцов в таблицах).
  var letterFor = function (index) {
    var n = index + 1;
    var s = '';
    while (n > 0) {
      var rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };

  var toNumber = function (v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  };

  var compare = function (a, b, op) {
    if (a === undefined || b === undefined) return false;
    var na = toNumber(a), nb = toNumber(b);
    var cmp;
    if (na !== null && nb !== null) {
      cmp = na < nb ? -1 : na > nb ? 1 : 0;
    } else {
      var sa = String(a).toLowerCase(), sb = String(b).toLowerCase();
      cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    if (op === '==') return cmp === 0;
    if (op === '!=') return cmp !== 0;
    if (op === '<') return cmp < 0;
    if (op === '<=') return cmp <= 0;
    if (op === '>') return cmp > 0;
    if (op === '>=') return cmp >= 0;
    return false;
  };

  // Агрегирующие функции пропускают нечисловые/отсутствующие аргументы (кроме CONCAT/
  // FIRST_NONEMPTY/COUNT_NONEMPTY, которым это не нужно) -- как и старые sum/avg в derived.
  var numericArgs = function (args) {
    return args.map(toNumber).filter(function (v) { return v !== null; });
  };
  var present = function (v) { return v !== undefined && v !== null && v !== ''; };

  var FUNCTIONS = {
    SUM: function (args) {
      var ns = numericArgs(args);
      return ns.length ? ns.reduce(function (a, b) { return a + b; }, 0) : undefined;
    },
    AVG: function (args) {
      var ns = numericArgs(args);
      return ns.length ? ns.reduce(function (a, b) { return a + b; }, 0) / ns.length : undefined;
    },
    MIN: function (args) {
      var ns = numericArgs(args);
      return ns.length ? Math.min.apply(null, ns) : undefined;
    },
    MAX: function (args) {
      var ns = numericArgs(args);
      return ns.length ? Math.max.apply(null, ns) : undefined;
    },
    CONCAT: function (args) {
      return args.filter(present).map(String).join('');
    },
    FIRST_NONEMPTY: function (args) {
      for (var i = 0; i < args.length; i++) { if (present(args[i])) return args[i]; }
      return undefined;
    },
    COUNT_NONEMPTY: function (args) {
      return String(args.filter(present).length);
    }
  };

  // --- токенайзер ------------------------------------------------------------

  var isDigit = function (c) { return c >= '0' && c <= '9'; };
  var isUpper = function (c) { return c >= 'A' && c <= 'Z'; };

  var tokenize = function (text) {
    var tokens = [];
    var i = 0;
    var n = text.length;
    while (i < n) {
      var c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      var start = i;

      if (c === '"' || c === "'") {
        var quote = c; i++;
        var buf = '';
        while (i < n && text[i] !== quote) {
          if (text[i] === '\\' && i + 1 < n) { buf += text[i + 1]; i += 2; }
          else { buf += text[i]; i++; }
        }
        if (i >= n) return { error: 'незакрытая строка', pos: start };
        i++;
        tokens.push({ type: 'string', value: buf, pos: start });
        continue;
      }

      if (c === '[') {
        i++;
        var b = '';
        while (i < n && text[i] !== ']') { b += text[i]; i++; }
        if (i >= n) return { error: 'незакрытая квадратная скобка "["', pos: start };
        i++;
        tokens.push({ type: 'bracket', value: b, pos: start });
        continue;
      }

      if (isDigit(c)) {
        var num = '';
        while (i < n && (isDigit(text[i]) || text[i] === '.')) { num += text[i]; i++; }
        tokens.push({ type: 'number', value: Number(num), pos: start });
        continue;
      }

      if (isUpper(c)) {
        var id = '';
        // "_" допустим внутри идентификатора (имена функций вроде FIRST_NONEMPTY),
        // но не как первый символ -- сюда попадаем только с isUpper(c) истинным.
        while (i < n && (isUpper(text[i]) || text[i] === '_')) { id += text[i]; i++; }
        tokens.push({ type: 'ident', value: id, pos: start });
        continue;
      }

      var two = text.slice(i, i + 2);
      if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
        tokens.push({ type: 'op', value: two, pos: start });
        i += 2;
        continue;
      }
      if ('+-*/(),?:<>'.indexOf(c) !== -1) {
        tokens.push({ type: 'op', value: c, pos: start });
        i++;
        continue;
      }

      return { error: 'неожиданный символ ' + JSON.stringify(c), pos: start };
    }
    return { tokens: tokens };
  };

  // --- парсер (рекурсивный спуск по приоритету операций) ---------------------

  var CMP_OPS = { '==': 1, '!=': 1, '<': 1, '<=': 1, '>': 1, '>=': 1 };

  var makeParser = function (tokens, knownLetters) {
    var pos = 0;
    var peek = function () { return tokens[pos]; };
    var fail = function (msg, tok) {
      var p = tok ? tok.pos : (tokens.length ? tokens[tokens.length - 1].pos : 0);
      throw new Error(msg + ' (позиция ' + p + ')');
    };
    var expectOp = function (op) {
      var t = peek();
      if (!t || t.type !== 'op' || t.value !== op) fail('ожидался "' + op + '"', t);
      pos++;
    };

    var parseArgs = function () {
      var args = [];
      var t = peek();
      if (t && t.type === 'op' && t.value === ')') return args;
      args.push(parseTernary());
      while (true) {
        t = peek();
        if (t && t.type === 'op' && t.value === ',') { pos++; args.push(parseTernary()); }
        else break;
      }
      return args;
    };

    var parsePrimary = function () {
      var t = peek();
      if (!t) fail('неожиданный конец формулы', null);
      if (t.type === 'number') { pos++; return { type: 'num', value: t.value }; }
      if (t.type === 'string') { pos++; return { type: 'str', value: t.value }; }
      if (t.type === 'bracket') { pos++; return { type: 'raw', path: t.value }; }
      if (t.type === 'ident') {
        pos++;
        var nextT = peek();
        if (nextT && nextT.type === 'op' && nextT.value === '(') {
          pos++;
          var args = parseArgs();
          expectOp(')');
          if (t.value === 'IF') {
            if (args.length !== 3) fail('IF ожидает ровно 3 аргумента: условие, "если да", "если нет"', t);
            return { type: 'if', cond: args[0], then: args[1], else: args[2] };
          }
          if (!FUNCTIONS[t.value]) fail('неизвестная функция: ' + t.value, t);
          return { type: 'call', name: t.value, args: args };
        }
        if (knownLetters.indexOf(t.value) === -1) fail('неизвестная переменная: ' + t.value, t);
        return { type: 'var', name: t.value };
      }
      if (t.type === 'op' && t.value === '(') {
        pos++;
        var inner = parseTernary();
        expectOp(')');
        return inner;
      }
      fail('неожиданный токен', t);
    };

    var parseUnary = function () {
      var t = peek();
      if (t && t.type === 'op' && t.value === '-') { pos++; return { type: 'neg', arg: parseUnary() }; }
      return parsePrimary();
    };

    var parseMultiplicative = function () {
      var left = parseUnary();
      while (true) {
        var t = peek();
        if (t && t.type === 'op' && (t.value === '*' || t.value === '/')) {
          pos++;
          left = { type: 'binop', op: t.value, left: left, right: parseUnary() };
        } else break;
      }
      return left;
    };

    var parseAdditive = function () {
      var left = parseMultiplicative();
      while (true) {
        var t = peek();
        if (t && t.type === 'op' && (t.value === '+' || t.value === '-')) {
          pos++;
          left = { type: 'binop', op: t.value, left: left, right: parseMultiplicative() };
        } else break;
      }
      return left;
    };

    var parseComparison = function () {
      var left = parseAdditive();
      var t = peek();
      if (t && t.type === 'op' && CMP_OPS[t.value]) {
        pos++;
        return { type: 'cmp', op: t.value, left: left, right: parseAdditive() };
      }
      return left;
    };

    function parseTernary() {
      var cond = parseComparison();
      var t = peek();
      if (t && t.type === 'op' && t.value === '?') {
        pos++;
        var a = parseTernary();
        expectOp(':');
        var b = parseTernary();
        return { type: 'if', cond: cond, then: a, else: b };
      }
      return cond;
    }

    return {
      parse: function () {
        var ast = parseTernary();
        if (pos < tokens.length) fail('лишние символы после конца выражения', peek());
        return ast;
      }
    };
  };

  // text: строка формулы. knownLetters: массив букв, доступных как переменные (входы
  // сущности, в порядке letterFor). Результат -- {ok:true, ast} | {ok:false, error}.
  var parse = function (text, knownLetters) {
    text = text == null ? '' : String(text);
    if (!text.trim()) return { ok: false, error: 'пустая формула' };
    var scan = tokenize(text);
    if (scan.error) return { ok: false, error: scan.error + ' (позиция ' + scan.pos + ')' };
    try {
      var ast = makeParser(scan.tokens, knownLetters || []).parse();
      return { ok: true, ast: ast };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // --- вычислитель -------------------------------------------------------------

  // ast: из parse(...).ast. ctx.letters: {[буква]: значение-строка}. ctx.lookupRaw(path):
  // значение сырого поля для [path]-ссылок. Результат -- строка | undefined (контракт
  // ds-webui: "значения -- строки"; undefined -- промах вычисления, не тихий 0/"").
  var evaluate = function (ast, ctx) {
    var letters = (ctx && ctx.letters) || {};
    var lookupRaw = (ctx && ctx.lookupRaw) || function () { return undefined; };

    var evalNode = function (node) {
      switch (node.type) {
        case 'num': return node.value;
        case 'str': return node.value;
        case 'raw': return lookupRaw(node.path);
        case 'var': return letters[node.name];
        case 'neg': {
          var v = toNumber(evalNode(node.arg));
          return v === null ? undefined : -v;
        }
        case 'binop': {
          var a = toNumber(evalNode(node.left));
          var b = toNumber(evalNode(node.right));
          if (a === null || b === null) return undefined;
          if (node.op === '+') return a + b;
          if (node.op === '-') return a - b;
          if (node.op === '*') return a * b;
          return b === 0 ? undefined : a / b;   // '/'
        }
        case 'cmp':
          return compare(evalNode(node.left), evalNode(node.right), node.op);
        case 'if':
          return evalNode(node.cond) === true ? evalNode(node.then) : evalNode(node.else);
        case 'call':
          return FUNCTIONS[node.name](node.args.map(evalNode));
        default: return undefined;
      }
    };

    var result = evalNode(ast);
    return result === undefined || result === null ? undefined : String(result);
  };

  return {
    letterFor: letterFor,
    FUNCTIONS: FUNCTIONS,
    parse: parse,
    evaluate: evaluate
  };
});
