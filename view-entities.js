'use strict';

// Страница «Индикаторы»: сущности — столбцы итоговой таблицы. То, что в SQL
// идёт после SELECT (какие поля показать и как их посчитать), в отличие от
// «Настроек» (источники/связки/условия — то, что после FROM). Из выбранных
// на «Настройках» полей строишь итоговые столбцы: поле как есть, разрешение
// коллизии по весам, либо производная. DOM-зависимый код — не тестируется
// под node:test. Зависит от util.js, store.js (selectedNames), entities.js
// (ENTITY_KINDS/ENTITY_TYPES/DERIVED_OPS). Ссылка на main.js
// (buildDataset/store) разрешается лениво через window.DS_APP в момент
// клика — main.js грузится последним.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./util.js'), require('./store.js'), require('./entities.js'));
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, factory(root.DS_APP, root.DS_APP, root.DS_APP));
  }
})(typeof window !== 'undefined' ? window : this, function (Util, Store, Entities) {

  var el = Util.el;
  var selectedNames = Store.selectedNames;
  var ENTITY_KINDS = Entities.ENTITY_KINDS, ENTITY_TYPES = Entities.ENTITY_TYPES,
      DERIVED_OPS = Entities.DERIVED_OPS;

  var viewEntities = function (state, d) {
    var preset = state.preset;
    var mSources = (state.manifest && state.manifest.sources) || [];
    var chosen = selectedNames(preset);

    // те же поля, что можно выбрать на «Настройках» для условий — источник
    // сущностей: любое выбранное поле любого выбранного источника
    var pickedColumns = chosen.reduce(function (acc, name) {
      var ms = mSources.find(function (s) { return s.name === name; });
      if (!ms) return acc;
      var labels = preset.query.sources[name].labels || [ms.key].concat(ms.labels);
      return acc.concat(labels.map(function (l) { return chosen.length > 1 ? name + '.' + l : l; }));
    }, []);

    var colSelect = function (cur, onChange) {
      return el('select', { onchange: function (e) { onChange(e.target.value); } },
        [el('option', { value: '' }, 'поле…')].concat(pickedColumns.map(function (c) {
          return el('option', { value: c, selected: c === cur }, c);
        })));
    };

    // строка сущности «подпись · контрол»; block — для многострочного контрола
    var entField = function (lbl, control, block) {
      return el('div', { class: 'entity-field' + (block ? ' block' : '') },
        el('span', { class: 'entity-field-lbl' }, lbl),
        el('div', { class: 'entity-field-ctl' }, control)
      );
    };

    var entityInputs = function (e, i, withWeight) {
      return el('div', { class: 'entity-inputs' },
        (e.from.inputs || []).map(function (inp, ii) {
          return el('div', { class: 'entity-input' },
            colSelect(inp.column, function (v) {
              d({ type: 'preset/updateEntityInput', index: i, ii: ii, patch: { column: v } });
            }),
            withWeight ? el('input', {
              type: 'number', class: 'ent-weight', step: '0.05', min: '0', max: '1',
              value: inp.weight == null ? '' : String(inp.weight), placeholder: 'вес',
              onchange: function (ev) {
                d({ type: 'preset/updateEntityInput', index: i, ii: ii,
                    patch: { weight: ev.target.value === '' ? 0 : Number(ev.target.value) } });
              }
            }) : null,
            el('button', { class: 'link', onclick: function () { d({ type: 'preset/moveEntityInput', index: i, ii: ii, dir: -1 }); } }, '↑'),
            el('button', { class: 'link', onclick: function () { d({ type: 'preset/moveEntityInput', index: i, ii: ii, dir: 1 }); } }, '↓'),
            el('button', { class: 'link', onclick: function () { d({ type: 'preset/removeEntityInput', index: i, ii: ii }); } }, '✕')
          );
        }),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/addEntityInput', index: i }); } }, '+ вход')
      );
    };

    var entityRow = function (e, i) {
      var up = function (patch) { d({ type: 'preset/updateEntity', index: i, patch: patch }); };
      var kind = (e.from && e.from.kind) || 'field';
      var pp = e.parse || {};

      var body;
      if (kind === 'resolve') {
        body = el('div', {},
          entityInputs(e, i, true),
          el('label', { class: 'chk' },
            el('input', {
              type: 'checkbox', checked: e.from.null_wins !== false,
              onchange: function (ev) { up({ from: { null_wins: ev.target.checked } }); }
            }),
            'null (DELETE) из весомого источника побеждает'),
          el('p', { class: 'muted', style: 'margin:.2rem 0 0' }, 'при равных весах — по порядку сверху вниз')
        );
      } else if (kind === 'derived') {
        body = el('div', {},
          el('select', { onchange: function (ev) { up({ from: { op: ev.target.value } }); } },
            DERIVED_OPS.map(function (o) {
              return el('option', { value: o[0], selected: o[0] === (e.from.op || 'first_nonempty') }, o[1]);
            })),
          e.from.op === 'concat' ? el('input', {
            type: 'text', class: 'ent-sep', value: e.from.sep == null ? ' ' : e.from.sep, placeholder: 'разделитель',
            onchange: function (ev) { up({ from: { sep: ev.target.value } }); }
          }) : null,
          entityInputs(e, i, false)
        );
      } else {
        body = colSelect(e.from.column, function (v) { up({ from: { column: v } }); });
      }

      var typeExtra = null;
      if (e.type === 'date') {
        typeExtra = el('div', {},
          el('div', { class: 'entity-format' },
            el('label', { class: 'field small' }, 'формат входа',
              el('input', { type: 'text', value: pp.date_in || 'auto',
                placeholder: 'auto | excel | DD.MM.YYYY',
                onchange: function (ev) { up({ parse: { date_in: ev.target.value } }); } })),
            el('label', { class: 'field small' }, 'формат вывода',
              el('input', { type: 'text', value: pp.date_out || 'YYYY-MM-DD',
                onchange: function (ev) { up({ parse: { date_out: ev.target.value } }); } }))),
          el('p', { class: 'muted', style: 'margin:.2rem 0 0' },
            '«auto» понимает ISO, DD.MM.YYYY, unix-время и серийную дату Excel '
            + '(5–7 цифр); «excel» — только серийную; иначе токены '
            + 'YYYY MM DD HH mm ss с любыми разделителями')
        );
      } else if (e.type === 'bool') {
        typeExtra = el('div', { class: 'entity-format' },
          el('label', { class: 'field small' }, 'токены истины (через запятую)',
            el('input', { type: 'text', value: pp['true'] || 'да,true,1,yes,y,+',
              onchange: function (ev) { up({ parse: { 'true': ev.target.value } }); } })));
      } else if (e.type === 'number') {
        typeExtra = el('div', { class: 'entity-format' },
          el('label', { class: 'field small' }, 'десятичный разделитель',
            el('select', { onchange: function (ev) { up({ parse: { decimal: ev.target.value } }); } },
              [['auto', 'авто'], ['.', 'точка'], [',', 'запятая']].map(function (o) {
                return el('option', { value: o[0], selected: o[0] === (pp.decimal || 'auto') }, o[1]);
              }))));
      }

      var kindSelect = el('select', { onchange: function (ev) { up({ from: { kind: ev.target.value } }); } },
        ENTITY_KINDS.map(function (o) { return el('option', { value: o[0], selected: o[0] === kind }, o[1]); }));
      var typeSelect = el('select', { onchange: function (ev) { up({ type: ev.target.value }); } },
        ENTITY_TYPES.map(function (o) { return el('option', { value: o[0], selected: o[0] === (e.type || 'text') }, o[1]); }));

      return el('div', { class: 'entity' },
        el('div', { class: 'entity-head' },
          entField('Наименование', el('input', {
            type: 'text', class: 'ent-alias', value: e.name || '', placeholder: 'название столбца',
            onchange: function (ev) { up({ name: ev.target.value }); }
          })),
          el('div', { class: 'entity-tools' },
            el('button', { class: 'link', title: 'переместить выше',
              onclick: function () { d({ type: 'preset/moveEntity', index: i, dir: -1 }); } }, '↑'),
            el('button', { class: 'link', title: 'переместить ниже',
              onclick: function () { d({ type: 'preset/moveEntity', index: i, dir: 1 }); } }, '↓'),
            el('button', { class: 'link', title: 'удалить сущность',
              onclick: function () { d({ type: 'preset/removeEntity', index: i }); } }, '✕')
          )
        ),
        el('div', { class: 'entity-rows' },
          entField('Способ расчёта', kindSelect),
          entField('Тип данных', typeSelect),
          entField('Источник расчёта', body, kind !== 'field')
        ),
        typeExtra
      );
    };

    return el('section', { class: 'page entities' },
      el('h1', {}, 'Индикаторы'),

      pickedColumns.length
        ? el('div', {},
            preset.view.entities.length
              ? el('div', { class: 'entities' }, preset.view.entities.map(entityRow))
              : el('p', { class: 'muted' }, 'сущностей нет — таблица покажет выбранные поля как есть'),
            el('div', { class: 'row', style: 'gap:.5rem;margin:.4rem 0 0' },
              el('button', { class: 'link', onclick: function () { d({ type: 'preset/addEntity' }); } }, '+ сущность'),
              el('button', { class: 'link', onclick: function () { d({ type: 'preset/addAllFieldsAsEntities' }); } },
                '+ все выбранные поля (1:1)')
            ),
            el('p', { class: 'muted', style: 'margin:.3rem 0 0' },
              'сущность = один столбец: поле как есть, разрешение коллизии по весам, либо производная. '
              + 'Порядок строк = порядок столбцов. Тип задаёт парсинг (даты/числа), непарсибельное подсвечивается.')
          )
        : el('p', { class: 'muted' }, 'Сначала выбери источники и поля на странице «Настройки».'),

      state.buildError ? el('p', { class: 'error' }, state.buildError) : null,

      el('div', { class: 'actions' },
        el('button', {
          class: 'primary', disabled: state.building || !chosen.length,
          onclick: function () { window.DS_APP.buildDataset(window.DS_APP.store); }
        }, state.building ? 'Строю…' : 'Применить и открыть таблицу')
      )
    );
  };

  return { viewEntities: viewEntities };
});
