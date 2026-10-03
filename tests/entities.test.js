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

// hidden: скрытый индикатор считается и фильтруется, но не выводится в таблицу
// (см. dataset.js::visibleColumns) — по умолчанию false, если не задан явно
test('normalizeEntities: hidden сохраняется, если задан true', () => {
  const view = { entities: [{ name: 'x', hidden: true, from: { kind: 'field', column: 'a' } }] };
  assert.equal(App.normalizeEntities(view)[0].hidden, true);
});

test('normalizeEntities: hidden по умолчанию false', () => {
  const view = { entities: [{ name: 'x', from: { kind: 'field', column: 'a' } }] };
  assert.equal(App.normalizeEntities(view)[0].hidden, false);
});

// одно и то же сырое поле можно добавить как сущность несколько раз (как есть
// + как вход производной, или просто дважды) — normalizeEntities не блокирует
test('normalizeEntities: одно поле в нескольких сущностях допустимо', () => {
  const view = { entities: [
    { name: 'a raw', from: { kind: 'field', column: 'a' } },
    { name: 'a again', from: { kind: 'field', column: 'a' } }
  ] };
  const out = App.normalizeEntities(view);
  assert.equal(out.length, 2);
  assert.equal(out[0].from.column, 'a');
  assert.equal(out[1].from.column, 'a');
});

test('entityOutNames: дедуплицирует одинаковые имена (a, a (2))', () => {
  const entities = [{ name: 'a' }, { name: 'a' }, { name: 'a' }];
  assert.deepEqual(App.entityOutNames(entities), ['a', 'a (2)', 'a (3)']);
});

// implicitEntities: дефолтные индикаторы при пустом пресете (main.js::buildDataset).
// Тип берётся из манифеста (label_types), не всегда "text" — см.
// ds-loader/docs/reference/config.md#manifest.
test('implicitEntities: без columnTypes всё "text" (обратная совместимость)', () => {
  assert.deepEqual(App.implicitEntities(['a', 'b']), [
    { name: 'a', type: 'text', from: { kind: 'field', column: 'a' } },
    { name: 'b', type: 'text', from: { kind: 'field', column: 'b' } }
  ]);
});

test('implicitEntities: берёт тип из columnTypes, неизвестная колонка -> "text"', () => {
  const ents = App.implicitEntities(['revenue', 'note'], { revenue: 'number' });
  assert.equal(ents[0].type, 'number');
  assert.equal(ents[1].type, 'text');
});

// columnTypesFor: {источник: [показатель]} + manifest.sources -> {колонка: type}.
// Квалификация имён ("Источник.показатель") должна совпасть с joinSources/presetColumns.
test('columnTypesFor: один источник -> голые имена колонок', () => {
  const types = App.columnTypesFor(
    { CRM: ['revenue', 'signed_at'] },
    [{ name: 'CRM', label_types: { revenue: 'number', signed_at: 'date' } }]
  );
  assert.deepEqual(types, { revenue: 'number', signed_at: 'date' });
});

test('columnTypesFor: несколько источников -> "Источник.показатель"', () => {
  const types = App.columnTypesFor(
    { CRM: ['revenue'], ERP: ['price'] },
    [
      { name: 'CRM', label_types: { revenue: 'number' } },
      { name: 'ERP', label_types: { price: 'number' } }
    ]
  );
  assert.deepEqual(types, { 'CRM.revenue': 'number', 'ERP.price': 'number' });
});

test('columnTypesFor: показатель без записи в манифесте (ключ, не опубликован) -> "text"', () => {
  const types = App.columnTypesFor(
    { CRM: ['customer_id', 'revenue'] },
    [{ name: 'CRM', label_types: { revenue: 'number' } }]
  );
  assert.deepEqual(types, { customer_id: 'text', revenue: 'number' });
});

test('columnTypesFor: манифест ещё не загружен (null/undefined) -> всё "text"', () => {
  assert.deepEqual(App.columnTypesFor({ CRM: ['revenue'] }, null), { revenue: 'text' });
});

// columnType: та же логика, но по пресету напрямую (store.js'а редьюсеры «+
// индикатор» / «+ показатель источника» ещё не прогнали JOIN).
test('columnType: находит тип по preset.query.sources + manifest.sources', () => {
  const preset = { query: { sources: { CRM: { labels: ['revenue'] } } } };
  const type = App.columnType(preset, [{ name: 'CRM', label_types: { revenue: 'number' } }], 'revenue');
  assert.equal(type, 'number');
});
