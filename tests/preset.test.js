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

test('normalizePreset: старая связка без type -> left (обратная совместимость)', () => {
  const p = App.normalizePreset({ view: { joins: [{ left: 'CRM', left_field: 'id', right: 'ERP', right_field: 'id' }] } });
  assert.equal(p.view.joins[0].type, 'left');
});

test('normalizePreset: нераспознанный type в связке -> left', () => {
  const p = App.normalizePreset({ view: { joins: [{ left: 'CRM', right: 'ERP', type: 'outer-cross-nonsense' }] } });
  assert.equal(p.view.joins[0].type, 'left');
});

test('normalizePreset: валидный type в связке сохраняется', () => {
  const p = App.normalizePreset({ view: { joins: [{ left: 'CRM', right: 'ERP', type: 'full' }] } });
  assert.equal(p.view.joins[0].type, 'full');
});

test("reducer: preset/addJoin добавляет связку с type 'left' по умолчанию", () => {
  const preset = App.normalizePreset({ query: { sources: { CRM: { labels: ['id'] } } } });
  const state = Object.assign({}, App.initialState, { preset: preset });
  const next = App.reducer(state, { type: 'preset/addJoin' });
  assert.equal(next.preset.view.joins[0].type, 'left');
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

// «Экспорт» и «Расширенный фильтр» — взаимоисключающие области над таблицей
test('export/toggle: открытие экспорта закрывает уже открытый расширенный фильтр', () => {
  const withFilter = App.reducer(App.initialState, { type: 'adv/toggle' });
  assert.equal(withFilter.advOpen, true);
  const next = App.reducer(withFilter, { type: 'export/toggle' });
  assert.equal(next.exportOpen, true);
  assert.equal(next.advOpen, false, 'открытие экспорта должно закрыть фильтр');
});

test('adv/toggle: открытие расширенного фильтра закрывает уже открытый экспорт', () => {
  const withExport = App.reducer(App.initialState, { type: 'export/toggle' });
  assert.equal(withExport.exportOpen, true);
  const next = App.reducer(withExport, { type: 'adv/toggle' });
  assert.equal(next.advOpen, true);
  assert.equal(next.exportOpen, false, 'открытие фильтра должно закрыть экспорт');
});

test('export/toggle: закрытие экспорта не трогает (уже закрытый) фильтр', () => {
  const opened = App.reducer(App.initialState, { type: 'export/toggle' });
  const closed = App.reducer(opened, { type: 'export/toggle' });
  assert.equal(closed.exportOpen, false);
  assert.equal(closed.advOpen, false);
});
