'use strict';

// Тесты слоя «сущностей» (browser-level 2): парсинг чисел/дат/bool, типизация,
// резолюция коллизий. Это самая рискованная логика приложения — граничные случаи
// (серийная дата Excel, неоднозначные разделители) легче всего сломать правкой
// «на глаз». Запуск: node --test (или ./run_tests.sh).

const test = require('node:test');
const assert = require('node:assert/strict');
const App = require('../entities.js');

test('parseNum: точка как десятичный разделитель', () => {
  assert.deepEqual(App.parseNum('99.00'), { ok: true, value: 99 });
});

test('parseNum: пробел — разделитель тысяч, запятая — десятичный', () => {
  assert.deepEqual(App.parseNum('1 234,56'), { ok: true, value: 1234.56 });
});

test('parseNum: нечисловая строка', () => {
  assert.equal(App.parseNum('n/a').ok, false);
});

test('parseDate: ISO дата', () => {
  const r = App.parseDate('2024-02-25');
  assert.equal(r.ok, true);
  assert.equal(App.formatDate(r.ms), '2024-02-25');
});

test('parseDate: DD.MM.YYYY', () => {
  const r = App.parseDate('25.02.2024');
  assert.equal(r.ok, true);
  assert.equal(App.formatDate(r.ms), '2024-02-25');
});

test('parseDate: серийная дата Excel — константа эпохи (25569 = 1970-01-01)', () => {
  const r = App.parseDate('25569', 'excel');
  assert.equal(r.ok, true);
  assert.equal(App.formatDate(r.ms), '1970-01-01');
});

test('parseDate: auto распознаёт 5-значную серийную дату Excel', () => {
  assert.equal(App.parseDate('44927').ok, true);
});

test('parseDate: auto не путает unix-время (10 цифр) с серийной датой', () => {
  const r = App.parseDate('1706745600'); // 2024-02-01T00:00:00Z
  assert.equal(r.ok, true);
  assert.equal(App.formatDate(r.ms), '2024-02-01');
});

test('parseBool: русские и латинские токены истины/лжи', () => {
  assert.equal(App.parseBool('да').value, true);
  assert.equal(App.parseBool('нет').value, false);
  assert.equal(App.parseBool('true').value, true);
  assert.equal(App.parseBool('мимо').ok, false);
});

test('typeCell: промах парсинга -> сырой текст, ok:false', () => {
  const t = App.typeCell('не число', { type: 'number' });
  assert.equal(t.ok, false);
  assert.equal(t.display, 'не число');
});

test('resolveCell: kind=resolve — побеждает больший вес среди присутствующих', () => {
  const from = {
    kind: 'resolve',
    inputs: [{ column: 'a', weight: 0.4 }, { column: 'b', weight: 0.9 }]
  };
  assert.equal(App.resolveCell(from, { a: 'from-a', b: 'from-b' }), 'from-b');
});

test('resolveCell: kind=resolve — при равных весах побеждает порядок входов', () => {
  const from = {
    kind: 'resolve',
    inputs: [{ column: 'a', weight: 0.5 }, { column: 'b', weight: 0.5 }]
  };
  assert.equal(App.resolveCell(from, { a: 'from-a', b: 'from-b' }), 'from-a');
});

test('resolveCell: kind=derived — sum по числовым входам', () => {
  const from = { kind: 'derived', op: 'sum', inputs: [{ column: 'a' }, { column: 'b' }] };
  assert.equal(App.resolveCell(from, { a: '2', b: '3' }), '5');
});

test('normalizeEntities: отбрасывает сущность без источника значения', () => {
  const view = { entities: [{ name: 'x', from: { kind: 'field', column: '' } }] };
  assert.deepEqual(App.normalizeEntities(view), []);
});
