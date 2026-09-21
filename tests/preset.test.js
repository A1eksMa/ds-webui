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

// preset/toggleSource: включение источника выбирает по умолчанию только ключ
// (не все показатели) — их бывает по сотне, снимать вручную лишние неудобно
test('reducer: preset/toggleSource включает только ключ источника по умолчанию', () => {
  const state = Object.assign({}, App.initialState, {
    manifest: { sources: [{ name: 'CRM', key: 'id', labels: ['name', 'email', 'phone'] }] },
    preset: App.normalizePreset({})
  });
  const next = App.reducer(state, { type: 'preset/toggleSource', name: 'CRM' });
  assert.deepEqual(next.preset.query.sources.CRM.labels, ['id']);
});

test('reducer: preset/toggleSource выключает источник обратно', () => {
  const state = Object.assign({}, App.initialState, {
    manifest: { sources: [{ name: 'CRM', key: 'id', labels: ['name'] }] },
    preset: App.normalizePreset({ query: { sources: { CRM: { labels: ['id'] } } } })
  });
  const next = App.reducer(state, { type: 'preset/toggleSource', name: 'CRM' });
  assert.equal(next.preset.query.sources.CRM, undefined);
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
