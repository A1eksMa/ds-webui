'use strict';

// Тесты formula.js: токенайзер/парсер/вычислитель формул для kind === 'formula' на
// странице «Индикаторы». Запуск: node --test.

const test = require('node:test');
const assert = require('node:assert/strict');
const Formula = require('../formula.js');

var evalStr = function (text, letters, lookupRaw) {
  const r = Formula.parse(text, Object.keys(letters || {}));
  assert.ok(r.ok, 'ожидался успешный разбор: ' + (r.error || ''));
  return Formula.evaluate(r.ast, { letters: letters || {}, lookupRaw: lookupRaw });
};

// --- letterFor ----------------------------------------------------------

test('letterFor: 0..25 -> A..Z', () => {
  assert.equal(Formula.letterFor(0), 'A');
  assert.equal(Formula.letterFor(25), 'Z');
});

test('letterFor: 26 -> AA, переход через границу', () => {
  assert.equal(Formula.letterFor(26), 'AA');
  assert.equal(Formula.letterFor(27), 'AB');
});

test('letterFor: 51 -> AZ, 52 -> BA', () => {
  assert.equal(Formula.letterFor(51), 'AZ');
  assert.equal(Formula.letterFor(52), 'BA');
});

// --- арифметика и приоритет операций -------------------------------------

test('арифметика: приоритет * выше +', () => {
  assert.equal(evalStr('A + B*C', { A: '1', B: '2', C: '3' }), '7');
});

test('арифметика: скобки меняют порядок', () => {
  assert.equal(evalStr('(A + B)*C', { A: '1', B: '2', C: '3' }), '9');
});

test('арифметика: унарный минус', () => {
  assert.equal(evalStr('-A + B', { A: '5', B: '1' }), '-4');
});

test('арифметика: деление на ноль -> undefined', () => {
  assert.equal(evalStr('A / B', { A: '1', B: '0' }), undefined);
});

test('арифметика: отсутствующий операнд -> вся формула undefined (не 0)', () => {
  assert.equal(evalStr('A + B', { A: '1', B: undefined }), undefined);
});

// --- строки, сравнение, тернарный оператор, IF ---------------------------

test('тернарный оператор: cond ? a : b', () => {
  assert.equal(evalStr('A > 10 ? "много" : "мало"', { A: '20' }), 'много');
  assert.equal(evalStr('A > 10 ? "много" : "мало"', { A: '5' }), 'мало');
});

test('IF как функция -- то же самое, что тернарный оператор', () => {
  assert.equal(evalStr('IF(A > 10, "много", "мало")', { A: '20' }), 'много');
});

test('IF требует ровно 3 аргумента', () => {
  const r = Formula.parse('IF(A > 10, "x")', ['A']);
  assert.equal(r.ok, false);
  assert.match(r.error, /3 аргумента/);
});

test('сравнение: числовое, когда обе стороны похожи на числа', () => {
  assert.equal(evalStr('A == B', { A: '5', B: '5.0' }), 'true');
  assert.equal(evalStr('A >= B', { A: '3', B: '10' }), 'false');
});

test('сравнение: сравнение с отсутствующим значением -> false (IF берёт else)', () => {
  assert.equal(evalStr('IF(A > 10, "да", "нет")', { A: undefined }), 'нет');
});

// --- агрегирующие функции -------------------------------------------------

test('SUM/AVG/MIN/MAX: пропускают нечисловые/отсутствующие аргументы', () => {
  assert.equal(evalStr('SUM(A, B, C)', { A: '1', B: undefined, C: '3' }), '4');
  assert.equal(evalStr('AVG(A, B)', { A: '2', B: '4' }), '3');
  assert.equal(evalStr('MIN(A, B)', { A: '2', B: '4' }), '2');
  assert.equal(evalStr('MAX(A, B)', { A: '2', B: '4' }), '4');
});

test('SUM: все аргументы нечисловые -> undefined, не 0', () => {
  assert.equal(evalStr('SUM(A)', { A: undefined }), undefined);
});

test('CONCAT: склеивает непустые значения без разделителя', () => {
  assert.equal(evalStr('CONCAT(A, B)', { A: 'x', B: 'y' }), 'xy');
});

test('FIRST_NONEMPTY: первое непустое значение', () => {
  assert.equal(evalStr('FIRST_NONEMPTY(A, B)', { A: '', B: 'y' }), 'y');
});

test('COUNT_NONEMPTY: считает непустые', () => {
  assert.equal(evalStr('COUNT_NONEMPTY(A, B, C)', { A: '1', B: '', C: '3' }), '2');
});

test('функции комбинируются с арифметикой: A + MAX(B, C)', () => {
  assert.equal(evalStr('A + MAX(B, C)', { A: '1', B: '2', C: '5' }), '6');
});

// --- [Источник.Показатель] -- прямая ссылка на сырое поле ------------------

test('[Источник.Показатель]: читает значение через lookupRaw, минуя буквы', () => {
  const lookup = function (path) { return path === 'ERP.price' ? '99' : undefined; };
  assert.equal(evalStr('A + [ERP.price]', { A: '1' }, lookup), '100');
});

// --- ошибки разбора ---------------------------------------------------------

test('parse: неизвестная буква -> понятная ошибка', () => {
  const r = Formula.parse('A + B', ['A']);
  assert.equal(r.ok, false);
  assert.match(r.error, /неизвестная переменная: B/);
});

test('parse: неизвестная функция -> понятная ошибка', () => {
  const r = Formula.parse('NOPE(A)', ['A']);
  assert.equal(r.ok, false);
  assert.match(r.error, /неизвестная функция/);
});

test('parse: незакрытая скобка -> ошибка', () => {
  const r = Formula.parse('(A + B', ['A', 'B']);
  assert.equal(r.ok, false);
});

test('parse: незакрытая [ -> ошибка', () => {
  const r = Formula.parse('A + [ERP.price', ['A']);
  assert.equal(r.ok, false);
  assert.match(r.error, /\[/);
});

test('parse: незакрытая строка -> ошибка', () => {
  const r = Formula.parse('IF(A > 1, "x, "y")', ['A']);
  assert.equal(r.ok, false);
});

test('parse: пустая формула -> ошибка', () => {
  assert.equal(Formula.parse('', ['A']).ok, false);
  assert.equal(Formula.parse('   ', ['A']).ok, false);
});

test('parse: лишние символы после конца выражения -> ошибка', () => {
  const r = Formula.parse('A + B)', ['A', 'B']);
  assert.equal(r.ok, false);
});
