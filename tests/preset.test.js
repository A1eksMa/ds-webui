'use strict';

// Тесты нормализации пресета и редьюсера store. Запуск: node --test.

const test = require('node:test');
const assert = require('node:assert/strict');
const App = require('../app.js');

test('normalizePreset: пустой объект -> валидная дефолтная форма', () => {
  const p = App.normalizePreset({});
  assert.deepEqual(p.query.sources, {});
  assert.deepEqual(p.view.entities, []);
  assert.deepEqual(p.view.conditions, []);
  assert.deepEqual(p.view.joins, []);
});

test('normalizePreset: мигрирует старое view.column_filters в view.conditions', () => {
  const p = App.normalizePreset({ view: { column_filters: { Foo: 'bar' } } });
  assert.deepEqual(p.view.conditions, [{ field: 'Foo', op: 'contains', value: 'bar' }]);
});

test('normalizeEntities: отбрасывает сущность без источника значения', () => {
  const view = { entities: [{ name: 'x', from: { kind: 'field', column: '' } }] };
  assert.deepEqual(App.normalizeEntities(view), []);
});

test('reducer: route/set меняет текущий маршрут', () => {
  const next = App.reducer(App.initialState, { type: 'route/set', route: 'table' });
  assert.equal(next.route, 'table');
});

test('reducer: неизвестный тип действия не меняет состояние', () => {
  const next = App.reducer(App.initialState, { type: 'unknown/whatever' });
  assert.equal(next, App.initialState);
});
