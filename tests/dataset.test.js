'use strict';

// Тесты слоя «датасета»: LEFT JOIN источников, условия выборки, расширенный
// фильтр, сортировка. Запуск: node --test (или ./run_tests.sh).

const test = require('node:test');
const assert = require('node:assert/strict');
const App = require('../app.js');

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
  const out = App.applySort(rows, { col: 'v', dir: 'asc' });
  assert.deepEqual(out.map((r) => r.v), ['2', '10', '']);
});
