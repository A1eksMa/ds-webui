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

// description — заголовок страницы «Таблица» (viewNav, view-common.js), отдельно
// от name (имя файла при скачивании). Нулевой пресет -> пусто, не плейсхолдер.
test('normalizePreset: description по умолчанию — пустая строка', () => {
  assert.equal(App.normalizePreset({}).description, '');
});

test('normalizePreset: description сохраняется как есть, если задан строкой', () => {
  const p = App.normalizePreset({ description: 'Отчёт по клиентам за январь' });
  assert.equal(p.description, 'Отчёт по клиентам за январь');
});

test('normalizePreset: нестроковый description игнорируется -> пустая строка', () => {
  assert.equal(App.normalizePreset({ description: 42 }).description, '');
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

test('reducer: preset/setName задаёт имя пресета', () => {
  const state = Object.assign({}, App.initialState, { preset: App.normalizePreset({}) });
  const next = App.reducer(state, { type: 'preset/setName', value: 'январь-2026' });
  assert.equal(next.preset.name, 'январь-2026');
});

// description — заголовок «Таблицы» (viewNav), независим от name (имя файла) —
// кнопка «Скачать пресет» (view-build.js) задаёт оба по отдельному запросу.
test('reducer: preset/setDescription задаёт описание независимо от name', () => {
  const state = Object.assign({}, App.initialState, {
    preset: Object.assign({}, App.normalizePreset({}), { name: 'jan-2026' }),
  });
  const next = App.reducer(state, { type: 'preset/setDescription', value: 'Отчёт за январь' });
  assert.equal(next.preset.description, 'Отчёт за январь');
  assert.equal(next.preset.name, 'jan-2026');   // не затронуто
});

test('reducer: preset/setDescription с null -> пустая строка', () => {
  const state = Object.assign({}, App.initialState, { preset: App.normalizePreset({}) });
  const next = App.reducer(state, { type: 'preset/setDescription', value: null });
  assert.equal(next.preset.description, '');
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

// --- sort/* -- расширенная панель: многоуровневый редактор state.sortBy,
// тот же список, который быстро дополняют пиктограммы (quick/sort ниже) ---

test('reducer: sort/add добавляет пустой уровень сортировки', () => {
  const next = App.reducer(App.initialState, { type: 'sort/add' });
  assert.deepEqual(next.sortBy, [{ col: '', dir: 'asc' }]);
});

test('reducer: sort/update меняет столбец/направление уровня по индексу', () => {
  const s1 = App.reducer(App.initialState, { type: 'sort/add' });
  const s2 = App.reducer(s1, { type: 'sort/update', index: 0, patch: { col: 'a' } });
  const s3 = App.reducer(s2, { type: 'sort/update', index: 0, patch: { dir: 'desc' } });
  assert.deepEqual(s3.sortBy, [{ col: 'a', dir: 'desc' }]);
});

test('reducer: sort/remove убирает уровень по индексу', () => {
  const s1 = App.reducer(App.initialState, { type: 'sort/add' });
  const s2 = App.reducer(s1, { type: 'sort/add' });
  const s3 = App.reducer(s2, { type: 'sort/remove', index: 0 });
  assert.equal(s3.sortBy.length, 1);
});

test('reducer: sort/move меняет порядок (приоритет) двух уровней', () => {
  const s1 = App.reducer(App.initialState, { type: 'sort/add' });
  const s2 = App.reducer(s1, { type: 'sort/update', index: 0, patch: { col: 'a' } });
  const s3 = App.reducer(s2, { type: 'sort/add' });
  const s4 = App.reducer(s3, { type: 'sort/update', index: 1, patch: { col: 'b' } });
  const s5 = App.reducer(s4, { type: 'sort/move', index: 1, dir: -1 });
  assert.deepEqual(s5.sortBy.map((l) => l.col), ['b', 'a']);
});

// --- quick/* -- пиктограммы в заголовке таблицы: читают/пишут ТО ЖЕ состояние,
// что редактирует расширенная панель (sortBy/adv), плюс своё UI-состояние
// (quickOpen, quickValuesLimit) ---

test('reducer: quick/toggle открывает quick-слот столбца, повторный клик закрывает', () => {
  const opened = App.reducer(App.initialState, { type: 'quick/toggle', column: 'a', mode: 'filter' });
  assert.equal(opened.quickOpen.a, 'filter');
  const closed = App.reducer(opened, { type: 'quick/toggle', column: 'a', mode: 'filter' });
  assert.equal(closed.quickOpen.a, null);
});

test('reducer: quick/toggle переключает режим столбца (search -> filter)', () => {
  const s1 = App.reducer(App.initialState, { type: 'quick/toggle', column: 'a', mode: 'search' });
  const s2 = App.reducer(s1, { type: 'quick/toggle', column: 'a', mode: 'filter' });
  assert.equal(s2.quickOpen.a, 'filter');
});

test('reducer: quick/sort -- цикл по столбцу: нет записи -> asc -> desc -> убрать', () => {
  const s1 = App.reducer(App.initialState, { type: 'quick/sort', column: 'a' });
  assert.deepEqual(s1.sortBy, [{ col: 'a', dir: 'asc' }]);
  const s2 = App.reducer(s1, { type: 'quick/sort', column: 'a' });
  assert.deepEqual(s2.sortBy, [{ col: 'a', dir: 'desc' }]);
  const s3 = App.reducer(s2, { type: 'quick/sort', column: 'a' });
  assert.deepEqual(s3.sortBy, []);
});

test('reducer: quick/sort добавляет столбец в конец -- не трогает уже выставленные уровни', () => {
  const s1 = App.reducer(App.initialState, { type: 'sort/add' });
  const s2 = App.reducer(s1, { type: 'sort/update', index: 0, patch: { col: 'a' } });
  const s3 = App.reducer(s2, { type: 'quick/sort', column: 'b' });
  assert.deepEqual(s3.sortBy, [{ col: 'a', dir: 'asc' }, { col: 'b', dir: 'asc' }]);
});

test('reducer: quick/applyFilter добавляет contains-условие с conj="and" в state.adv', () => {
  const next = App.reducer(App.initialState, { type: 'quick/applyFilter', column: 'a', value: 'foo' });
  assert.deepEqual(next.adv, [{ field: 'a', op: 'contains', value: 'foo', conj: 'and' }]);
});

test('reducer: quick/applyFilter не трогает уже установленные условия расширенного фильтра', () => {
  const s1 = App.reducer(App.initialState, { type: 'adv/add' });
  const s2 = App.reducer(s1, { type: 'adv/update', index: 0, patch: { field: 'x', op: 'eq', value: '1' } });
  const s3 = App.reducer(s2, { type: 'quick/applyFilter', column: 'a', value: 'foo' });
  assert.equal(s3.adv.length, 2);
  assert.deepEqual(s3.adv[0], { field: 'x', op: 'eq', value: '1', conj: 'and' });
});

test('reducer: quick/applyFilter повторно -- обновляет то же условие, не дублирует', () => {
  const s1 = App.reducer(App.initialState, { type: 'quick/applyFilter', column: 'a', value: 'foo' });
  const s2 = App.reducer(s1, { type: 'quick/applyFilter', column: 'a', value: 'bar' });
  assert.equal(s2.adv.length, 1);
  assert.equal(s2.adv[0].value, 'bar');
});

test('reducer: quick/applyFilter с пустым значением убирает условие', () => {
  const s1 = App.reducer(App.initialState, { type: 'quick/applyFilter', column: 'a', value: 'foo' });
  const s2 = App.reducer(s1, { type: 'quick/applyFilter', column: 'a', value: '' });
  assert.deepEqual(s2.adv, []);
});

test('reducer: quick/setValuesLimit сохраняет неотрицательное целое (0 -- валидное значение)', () => {
  const s1 = App.reducer(App.initialState, { type: 'quick/setValuesLimit', value: '5' });
  assert.equal(s1.quickValuesLimit, 5);
  const s2 = App.reducer(s1, { type: 'quick/setValuesLimit', value: '0' });
  assert.equal(s2.quickValuesLimit, 0);
  const s3 = App.reducer(s2, { type: 'quick/setValuesLimit', value: '-3' });
  assert.equal(s3.quickValuesLimit, 0);
});

test('reducer: build/success сбрасывает adv/sortBy/quickOpen, но не quickValuesLimit', () => {
  const withLimit = App.reducer(App.initialState, { type: 'quick/setValuesLimit', value: '3' });
  const withStuff = App.reducer(withLimit, { type: 'sort/add' });
  const next = App.reducer(withStuff, { type: 'build/success', dataset: { columns: [], rows: [] } });
  assert.deepEqual(next.sortBy, []);
  assert.deepEqual(next.adv, []);
  assert.deepEqual(next.quickOpen, {});
  assert.equal(next.quickValuesLimit, 3);
});
