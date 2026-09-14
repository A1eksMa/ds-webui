'use strict';

// Тесты нормализации пресета и редьюсера store. Запуск: node --test.

const test = require('node:test');
const assert = require('node:assert/strict');
const App = require('../store.js');

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

test('reducer: route/set меняет текущий маршрут', () => {
  const next = App.reducer(App.initialState, { type: 'route/set', route: 'table' });
  assert.equal(next.route, 'table');
});

test('reducer: неизвестный тип действия не меняет состояние', () => {
  const next = App.reducer(App.initialState, { type: 'unknown/whatever' });
  assert.equal(next, App.initialState);
});

// preset/setAsOf: принимает то же, что parseDate('auto') — дата, дата-время
// (с секундами и без), unix-время; миллисекунды усекаются (as_of секундной точности)
function withPreset() {
  return Object.assign({}, App.initialState, { preset: App.normalizePreset({}) });
}

test('preset/setAsOf: дата без времени', () => {
  const next = App.reducer(withPreset(), { type: 'preset/setAsOf', value: '2024-02-01' });
  assert.equal(next.preset.query.as_of, 1706745600);
});

test('preset/setAsOf: дата-время без секунд', () => {
  const next = App.reducer(withPreset(), { type: 'preset/setAsOf', value: '2024-02-01 14:30' });
  assert.equal(next.preset.query.as_of, 1706797800);
});

test('preset/setAsOf: дата-время с миллисекундами — усекается до секунд', () => {
  const next = App.reducer(withPreset(), { type: 'preset/setAsOf', value: '2024-02-01T14:30:45.123' });
  assert.equal(next.preset.query.as_of, 1706797845);
});

test('preset/setAsOf: голое unix-время по-прежнему принимается', () => {
  const next = App.reducer(withPreset(), { type: 'preset/setAsOf', value: '1706745600' });
  assert.equal(next.preset.query.as_of, 1706745600);
});

test('preset/setAsOf: пусто -> as_of сброшен в null (текущий момент)', () => {
  const withValue = App.reducer(withPreset(), { type: 'preset/setAsOf', value: '2024-02-01' });
  const next = App.reducer(withValue, { type: 'preset/setAsOf', value: '' });
  assert.equal(next.preset.query.as_of, null);
});

test('preset/setAsOf: нераспознанный ввод не меняет прежнее значение', () => {
  const withValue = App.reducer(withPreset(), { type: 'preset/setAsOf', value: '2024-02-01' });
  const next = App.reducer(withValue, { type: 'preset/setAsOf', value: 'не дата' });
  assert.equal(next.preset.query.as_of, 1706745600);
});
