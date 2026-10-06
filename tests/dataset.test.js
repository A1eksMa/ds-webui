'use strict';

// Тесты слоя «датасета»: LEFT JOIN источников, условия выборки, расширенный
// фильтр, сортировка. Запуск: node --test (или ./run_tests.sh).

const test = require('node:test');
const assert = require('node:assert/strict');
const App = require('../dataset.js');

test('joinSources: LEFT JOIN двух источников по ключу, колонки квалифицированы', () => {
  const crm = { name: 'CRM', key: 'id', labels: ['id', 'email'], data: [{ id: '1', email: 'a@x' }] };
  const erp = { name: 'ERP', key: 'id', labels: ['id', 'price'], data: [{ id: '1', price: '10' }] };
  const joins = [{ left: 'CRM', left_field: 'id', right: 'ERP', right_field: 'id' }];

  const out = App.joinSources([crm, erp], joins);

  assert.deepEqual(out.columns, ['CRM.id', 'CRM.email', 'ERP.id', 'ERP.price']);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0]['CRM.email'], 'a@x');
  assert.equal(out.rows[0]['ERP.price'], '10');
});

test('joinSources: несовпавший LEFT JOIN оставляет undefined, не роняет запись', () => {
  const crm = { name: 'CRM', key: 'id', labels: ['id'], data: [{ id: '1' }] };
  const erp = { name: 'ERP', key: 'id', labels: ['price'], data: [{ id: '2', price: '10' }] };
  const out = App.joinSources([crm, erp], [{ left: 'CRM', left_field: 'id', right: 'ERP', right_field: 'id' }]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0]['ERP.price'], undefined);
});

test('joinSources: без type в связке — поведение как раньше (LEFT по умолчанию)', () => {
  const crm = { name: 'CRM', key: 'id', labels: ['id'], data: [{ id: '1' }, { id: '2' }] };
  const erp = { name: 'ERP', key: 'id', labels: ['price'], data: [{ id: '1', price: '10' }] };
  const out = App.joinSources([crm, erp], [{ left: 'CRM', left_field: 'id', right: 'ERP', right_field: 'id' }]);
  assert.equal(out.rows.length, 2);
});

test('joinSources: INNER — только совпавшие строки', () => {
  const crm = { name: 'CRM', key: 'id', labels: ['id'], data: [{ id: '1' }, { id: '2' }] };
  const erp = { name: 'ERP', key: 'id', labels: ['price'], data: [{ id: '1', price: '10' }] };
  const joins = [{ left: 'CRM', left_field: 'id', right: 'ERP', right_field: 'id', type: 'inner' }];
  const out = App.joinSources([crm, erp], joins);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0]['CRM.id'], '1');
});

test('joinSources: RIGHT — все строки правого источника, неспарившиеся строки левого выброшены', () => {
  const crm = { name: 'CRM', key: 'id', labels: ['id'], data: [{ id: '1' }] };
  const erp = { name: 'ERP', key: 'id', labels: ['id', 'price'], data: [{ id: '1', price: '10' }, { id: '2', price: '20' }] };
  const joins = [{ left: 'CRM', left_field: 'id', right: 'ERP', right_field: 'id', type: 'right' }];
  const out = App.joinSources([crm, erp], joins);
  assert.equal(out.rows.length, 2);
  const unmatched = out.rows.find((r) => r['ERP.id'] === '2');
  assert.ok(unmatched, 'строка ERP.id=2 должна присутствовать');
  assert.equal(unmatched['CRM.id'], undefined);
});

test('joinSources: FULL — объединение (совпавшие + обе стороны без пары)', () => {
  const crm = { name: 'CRM', key: 'id', labels: ['id'], data: [{ id: '1' }, { id: '2' }] };
  const erp = { name: 'ERP', key: 'id', labels: ['id', 'price'], data: [{ id: '1', price: '10' }, { id: '3', price: '30' }] };
  const joins = [{ left: 'CRM', left_field: 'id', right: 'ERP', right_field: 'id', type: 'full' }];
  const out = App.joinSources([crm, erp], joins);
  assert.equal(out.rows.length, 3);   // (1,1) + (2,∅) + (∅,3)
  assert.ok(out.rows.some((r) => r['CRM.id'] === '2' && r['ERP.id'] === undefined));
  assert.ok(out.rows.some((r) => r['ERP.id'] === '3' && r['CRM.id'] === undefined));
});

test('joinSources: FULL — правая строка, уже спарившаяся хоть с одной левой, не дублируется', () => {
  const crm = { name: 'CRM', key: 'fk', labels: ['id', 'fk'], data: [{ id: 'a', fk: '1' }, { id: 'b', fk: '1' }] };
  const erp = { name: 'ERP', key: 'id', labels: ['id'], data: [{ id: '1' }] };
  const joins = [{ left: 'CRM', left_field: 'fk', right: 'ERP', right_field: 'id', type: 'full' }];
  const out = App.joinSources([crm, erp], joins);
  assert.equal(out.rows.length, 2);   // обе строки CRM совпали с единственной ERP-строкой, лишней копии нет
});

test('matchCondition: contains регистронезависимо', () => {
  assert.equal(App.matchCondition('Hello World', { op: 'contains', value: 'WOR' }), true);
});

test('matchCondition: empty/not_empty', () => {
  assert.equal(App.matchCondition('', { op: 'empty' }), true);
  assert.equal(App.matchCondition(null, { op: 'empty' }), true);
  assert.equal(App.matchCondition('x', { op: 'not_empty' }), true);
});

test('matchCondition: числовые операторы, пустая ячейка не подходит', () => {
  assert.equal(App.matchCondition('10', { op: 'gt', value: '5' }), true);
  assert.equal(App.matchCondition('', { op: 'gt', value: '5' }), false);
});

test('applyConditions: сужает выборку (AND)', () => {
  const ds = { columns: ['a'], rows: [{ a: 'foo' }, { a: 'bar' }] };
  const out = App.applyConditions(ds, [{ field: 'a', op: 'eq', value: 'foo' }]);
  assert.equal(out.rows.length, 1);
});

test('applyConditions: условие на несуществующий столбец не обнуляет выборку', () => {
  const ds = { columns: ['a'], rows: [{ a: 'foo' }, { a: 'bar' }] };
  const out = App.applyConditions(ds, [{ field: 'missing', op: 'eq', value: 'x' }]);
  assert.equal(out.rows.length, 2);
});

test('applySort: числа сравниваются как числа, пустые — в конце', () => {
  const rows = [{ v: '10' }, { v: '2' }, { v: '' }];
  const out = App.applySort(rows, [{ col: 'v', dir: 'asc' }]);
  assert.deepEqual(out.map((r) => r.v), ['2', '10', '']);
});

test('applySort: без уровней -- строки не трогает (тот же порядок)', () => {
  const rows = [{ v: '10' }, { v: '2' }];
  assert.deepEqual(App.applySort(rows, []), rows);
  assert.deepEqual(App.applySort(rows, null), rows);
});

test('applySort: многоуровневая -- второй уровень решает при равенстве первого', () => {
  const rows = [
    { a: 'x', b: '2' }, { a: 'y', b: '1' }, { a: 'x', b: '1' }
  ];
  const out = App.applySort(rows, [{ col: 'a', dir: 'asc' }, { col: 'b', dir: 'asc' }]);
  assert.deepEqual(out, [{ a: 'x', b: '1' }, { a: 'x', b: '2' }, { a: 'y', b: '1' }]);
});

test('applySort: второй уровень может сортировать по убыванию независимо от первого', () => {
  const rows = [
    { a: 'x', b: '1' }, { a: 'x', b: '3' }, { a: 'x', b: '2' }
  ];
  const out = App.applySort(rows, [{ col: 'a', dir: 'asc' }, { col: 'b', dir: 'desc' }]);
  assert.deepEqual(out.map((r) => r.b), ['3', '2', '1']);
});

test('findNextMatch: находит следующую строку ниже курсора', () => {
  const rows = [{ v: 'foo' }, { v: 'bar' }, { v: 'foobar' }];
  assert.equal(App.findNextMatch(rows, 'v', 'foo', -1), 0);
  assert.equal(App.findNextMatch(rows, 'v', 'foo', 0), 2);
});

test('findNextMatch: оборачивается в начало, если дальше ничего не нашлось', () => {
  const rows = [{ v: 'foo' }, { v: 'bar' }];
  assert.equal(App.findNextMatch(rows, 'v', 'foo', 0), 0);
});

test('findNextMatch: совпадений нет вовсе -> -1', () => {
  const rows = [{ v: 'foo' }, { v: 'bar' }];
  assert.equal(App.findNextMatch(rows, 'v', 'zzz', -1), -1);
});

test('uniqueValues: первые N уникальных значений в порядке строк (не по частоте)', () => {
  const rows = [{ v: 'b' }, { v: 'a' }, { v: 'b' }, { v: 'a' }, { v: 'a' }, { v: 'c' }];
  assert.deepEqual(App.uniqueValues(rows, 'v', 2), ['b', 'a']);
});

test('uniqueValues: limit<=0 -> пустой список без сканирования', () => {
  const rows = [{ v: 'a' }];
  assert.deepEqual(App.uniqueValues(rows, 'v', 0), []);
  assert.deepEqual(App.uniqueValues(rows, 'v', -5), []);
});

test('uniqueValues: пустые/null значения пропускаются', () => {
  const rows = [{ v: '' }, { v: null }, { v: 'a' }];
  assert.deepEqual(App.uniqueValues(rows, 'v', 10), ['a']);
});

// visibleColumns: скрытые индикаторы (dataset.hiddenColumns, см. main.js/view-entities.js
// «скрыть в таблице») не выводятся ни в таблицу, ни в экспорт — независимо от hideEmpty
test('visibleColumns: без hiddenColumns отдаёт все столбцы как есть', () => {
  const ds = { columns: ['a', 'b'], rows: [{ a: '1', b: '2' }] };
  assert.deepEqual(App.visibleColumns(ds, false), ['a', 'b']);
});

test('visibleColumns: столбцы из hiddenColumns исключаются', () => {
  const ds = { columns: ['a', 'b', 'c'], rows: [{ a: '1', b: '2', c: '3' }], hiddenColumns: ['b'] };
  assert.deepEqual(App.visibleColumns(ds, false), ['a', 'c']);
});

test('visibleColumns: hiddenColumns и hideEmpty применяются вместе', () => {
  const ds = { columns: ['a', 'b', 'c'], rows: [{ a: '', b: '2', c: '' }], hiddenColumns: ['b'] };
  // b скрыт явно, a и c скрыты как пустые -> ничего не остаётся
  assert.deepEqual(App.visibleColumns(ds, true), []);
});
