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
  assert.deepEqual(p.view.entityConditions, []);
  assert.deepEqual(p.view.joins, []);
});

// entityConditions — второй проход фильтрации (по индикаторам, после расчёта),
// независимый список от conditions (по сырым полям, до расчёта) — см. view-build.js/
// view-entities.js
test('normalizePreset: entityConditions нормализуется независимо от conditions', () => {
  const p = App.normalizePreset({ view: {
    conditions: [{ field: 'CRM.status', op: 'eq', value: 'active' }],
    entityConditions: [{ field: 'Выручка', op: 'gt', value: '0' }]
  } });
  assert.deepEqual(p.view.conditions, [{ field: 'CRM.status', op: 'eq', value: 'active' }]);
  assert.deepEqual(p.view.entityConditions, [{ field: 'Выручка', op: 'gt', value: '0' }]);
});

test('normalizePreset: мигрирует старое view.column_filters в view.conditions', () => {
  const p = App.normalizePreset({ view: { column_filters: { Foo: 'bar' } } });
  assert.deepEqual(p.view.conditions, [{ field: 'Foo', op: 'contains', value: 'bar' }]);
});

// query.sources задаёт и порядок накопления (CRM — база, ERP — второй): связка
// на ERP сохраняется, только если её left входит в уже накопленное (тут — CRM)
const twoSources = { query: { sources: { CRM: { labels: ['id'] }, ERP: { labels: ['id'] } } } };

test('normalizePreset: старая связка без type -> left (обратная совместимость)', () => {
  const p = App.normalizePreset(Object.assign({}, twoSources,
    { view: { joins: [{ left: 'CRM', left_field: 'id', right: 'ERP', right_field: 'id' }] } }));
  assert.equal(p.view.joins[0].type, 'left');
});

test('normalizePreset: нераспознанный type в связке -> left', () => {
  const p = App.normalizePreset(Object.assign({}, twoSources,
    { view: { joins: [{ left: 'CRM', right: 'ERP', type: 'outer-cross-nonsense' }] } }));
  assert.equal(p.view.joins[0].type, 'left');
});

test('normalizePreset: валидный type в связке сохраняется', () => {
  const p = App.normalizePreset(Object.assign({}, twoSources,
    { view: { joins: [{ left: 'CRM', right: 'ERP', type: 'full' }] } }));
  assert.equal(p.view.joins[0].type, 'full');
});

test('normalizePreset: связка без источников в query.sources -> нет связок', () => {
  const p = App.normalizePreset({ view: { joins: [{ left: 'CRM', right: 'ERP', type: 'full' }] } });
  assert.deepEqual(p.view.joins, []);
});

test('normalizePreset: связка, чей left не входит в накопленное на этот момент, сбрасывается', () => {
  // ERP.left='XYZ' — такого источника вообще нет в выборке -> сброс на дефолт
  const p = App.normalizePreset({ query: { sources: { CRM: {}, ERP: {} } },
    view: { joins: [{ left: 'XYZ', right: 'ERP', type: 'full' }] } });
  assert.equal(p.view.joins[0].left, 'CRM');    // единственный доступный на этом шаге источник
  assert.equal(p.view.joins[0].type, 'full');   // тип связки — независимое поле, сохраняется
});

test('reducer: preset/toggleSource на втором источнике создаёт связку на базовый', () => {
  const state = Object.assign({}, App.initialState, {
    manifest: { sources: [{ name: 'CRM', key: 'id', labels: [] }, { name: 'ERP', key: 'id', labels: [] }] },
    preset: App.normalizePreset({ query: { sources: { CRM: { labels: ['id'] } } } })
  });
  const next = App.reducer(state, { type: 'preset/toggleSource', name: 'ERP' });
  assert.equal(next.preset.view.joins.length, 1);
  assert.equal(next.preset.view.joins[0].left, 'CRM');
  assert.equal(next.preset.view.joins[0].right, 'ERP');
  assert.equal(next.preset.view.joins[0].type, 'left');
});

test('reducer: preset/toggleSource на третьем источнике не выбирает left сам (нужно выбрать вручную)', () => {
  const state = Object.assign({}, App.initialState, {
    manifest: { sources: [
      { name: 'CRM', key: 'id', labels: [] }, { name: 'ERP', key: 'id', labels: [] }, { name: 'HR', key: 'id', labels: [] }
    ] },
    preset: App.normalizePreset({ query: { sources: { CRM: { labels: ['id'] }, ERP: { labels: ['id'] } } } })
  });
  const next = App.reducer(state, { type: 'preset/toggleSource', name: 'HR' });
  assert.equal(next.preset.view.joins.length, 2);
  assert.equal(next.preset.view.joins[1].right, 'HR');
  assert.equal(next.preset.view.joins[1].left, '');   // выбор из {CRM, ERP} — неоднозначно, оставляем пустым
});

test('reducer: preset/toggleSource выключает средний источник — снимает его связку и сбрасывает связки, ссылавшиеся на него', () => {
  const state = Object.assign({}, App.initialState, {
    manifest: { sources: [
      { name: 'CRM', key: 'id', labels: [] }, { name: 'ERP', key: 'id', labels: [] }, { name: 'HR', key: 'id', labels: [] }
    ] },
    preset: App.normalizePreset({
      query: { sources: { CRM: { labels: ['id'] }, ERP: { labels: ['id'] }, HR: { labels: ['id'] } } },
      view: { joins: [{ left: 'CRM', right: 'ERP', type: 'left' }, { left: 'ERP', right: 'HR', type: 'inner' }] }
    })
  });
  const next = App.reducer(state, { type: 'preset/toggleSource', name: 'ERP' });
  assert.deepEqual(Object.keys(next.preset.query.sources), ['CRM', 'HR']);
  assert.equal(next.preset.view.joins.length, 1);
  assert.equal(next.preset.view.joins[0].right, 'HR');
  assert.equal(next.preset.view.joins[0].left, 'CRM');   // ссылка на убранный ERP сброшена на единственный доступный
  assert.equal(next.preset.view.joins[0].type, 'inner'); // тип связки — независимое поле, сохраняется
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

// «+ показатель источника» (view-entities.js): добавляет поле как есть, без
// проверки «уже занято» — то же поле допустимо добавить повторно
test('reducer: preset/addFieldEntity добавляет поле как есть', () => {
  const preset = App.normalizePreset({ query: { sources: { CRM: { labels: ['id'] } } } });
  const state = Object.assign({}, App.initialState, { preset: preset });
  const next = App.reducer(state, { type: 'preset/addFieldEntity', column: 'CRM.id' });
  assert.deepEqual(next.preset.view.entities[0],
    { name: 'CRM.id', type: 'text', hidden: false, from: { kind: 'field', column: 'CRM.id' } });
});

test('reducer: preset/addFieldEntity не блокирует повторное добавление того же поля', () => {
  const preset = App.normalizePreset({ query: { sources: { CRM: { labels: ['id'] } } } });
  var state = Object.assign({}, App.initialState, { preset: preset });
  state = Object.assign({}, state, { preset: App.reducer(state, { type: 'preset/addFieldEntity', column: 'CRM.id' }).preset });
  const next = App.reducer(state, { type: 'preset/addFieldEntity', column: 'CRM.id' });
  assert.equal(next.preset.view.entities.length, 2);
  assert.equal(next.preset.view.entities[1].from.column, 'CRM.id');
});

// label_types из манифеста -> дефолтный тип нового индикатора (вместо жёсткого
// "text"), сразу в обеих точках создания — см. entities.js::columnType.
test('reducer: preset/addFieldEntity берёт тип показателя из манифеста', () => {
  const preset = App.normalizePreset({ query: { sources: { CRM: { labels: ['revenue'] } } } });
  const state = Object.assign({}, App.initialState, {
    preset: preset,
    manifest: { sources: [{ name: 'CRM', key: 'id', labels: ['revenue'], label_types: { revenue: 'number' } }] }
  });
  const next = App.reducer(state, { type: 'preset/addFieldEntity', column: 'revenue' });
  assert.equal(next.preset.view.entities[0].type, 'number');
});

test('reducer: preset/addEntity берёт тип первого свободного показателя из манифеста', () => {
  const preset = App.normalizePreset({ query: { sources: { CRM: { labels: ['signed_at'] } } } });
  const state = Object.assign({}, App.initialState, {
    preset: preset,
    manifest: { sources: [{ name: 'CRM', key: 'id', labels: ['signed_at'], label_types: { signed_at: 'date' } }] }
  });
  const next = App.reducer(state, { type: 'preset/addEntity' });
  assert.equal(next.preset.view.entities[0].from.column, 'signed_at');
  assert.equal(next.preset.view.entities[0].type, 'date');
});

test('reducer: preset/addEntity без манифеста по-прежнему "text" (не падает)', () => {
  const preset = App.normalizePreset({ query: { sources: { CRM: { labels: ['revenue'] } } } });
  const state = Object.assign({}, App.initialState, { preset: preset });   // manifest: null
  const next = App.reducer(state, { type: 'preset/addEntity' });
  assert.equal(next.preset.view.entities[0].type, 'text');
});

// условия «Индикаторов» — свой независимый список, свои экшены
test('reducer: preset/addEntityCondition / updateEntityCondition / removeEntityCondition', () => {
  const preset = App.normalizePreset({});
  var state = Object.assign({}, App.initialState, { preset: preset });
  state = Object.assign({}, state, { preset: App.reducer(state, { type: 'preset/addEntityCondition' }).preset });
  assert.deepEqual(state.preset.view.entityConditions, [{ field: '', op: 'contains', value: '' }]);
  assert.deepEqual(state.preset.view.conditions, []);   // независимо от conditions «Настроек»

  state = Object.assign({}, state, {
    preset: App.reducer(state, { type: 'preset/updateEntityCondition', index: 0, patch: { field: 'Выручка', value: '100' } }).preset
  });
  assert.deepEqual(state.preset.view.entityConditions[0], { field: 'Выручка', op: 'contains', value: '100' });

  const next = App.reducer(state, { type: 'preset/removeEntityCondition', index: 0 });
  assert.deepEqual(next.preset.view.entityConditions, []);
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
