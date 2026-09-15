'use strict';

// Страница «Конструктор выборки». DOM-зависимый код — не тестируется под
// node:test. Зависит от util.js, store.js, entities.js, dataset.js (OP_LIST),
// view-common.js. Две ссылки на main.js (buildDataset/store) разрешаются
// лениво через window.DS_APP в момент клика — main.js грузится последним,
// но к моменту, когда пользователь может кликнуть, все скрипты уже выполнены.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./util.js'), require('./store.js'), require('./entities.js'),
      require('./dataset.js'), require('./view-common.js')
    );
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, factory(root.DS_APP, root.DS_APP, root.DS_APP, root.DS_APP, root.DS_APP));
  }
})(typeof window !== 'undefined' ? window : this, function (Util, Store, Entities, Dataset, ViewCommon) {

  var el = Util.el, uniq = Util.uniq, fmtDate = Util.fmtDate;
  var selectedNames = Store.selectedNames, isStale = Store.isStale, basePreset = Store.basePreset,
      savePreset = Store.savePreset, loadPresetFile = Store.loadPresetFile;
  var entityOutNames = Entities.entityOutNames, ENTITY_KINDS = Entities.ENTITY_KINDS,
      ENTITY_TYPES = Entities.ENTITY_TYPES, DERIVED_OPS = Entities.DERIVED_OPS;
  var OP_LIST = Dataset.OP_LIST, JOIN_TYPES = Dataset.JOIN_TYPES;
  var opSelect = ViewCommon.opSelect, valueControl = ViewCommon.valueControl;

  var badge = function (ms) {
    return isStale(ms)
      ? el('span', { class: 'badge stale', title: 'db_max_cnt ' + ms.db_max_cnt + ' > gen_max_cnt ' + ms.gen_max_cnt },
          'пересобрать')
      : el('span', { class: 'badge fresh' }, 'свежий');
  };

  var viewBuild = function (state, d) {
    var preset = state.preset;
    var mSources = (state.manifest && state.manifest.sources) || [];
    var chosen = selectedNames(preset);

    var sourceRow = function (ms) {
      var picked = !!preset.query.sources[ms.name];
      var fields = [ms.key].concat(ms.labels);            // ключ — обычное выбираемое поле
      var wanted = picked ? (preset.query.sources[ms.name].labels || fields) : [];
      var open = picked && !!state.srcOpen[ms.name];      // список показателей развёрнут
      var fieldBox = function (name, isKey) {
        return el('label', { class: 'field-item' + (isKey ? ' key' : '') },
          el('input', {
            type: 'checkbox', checked: wanted.indexOf(name) !== -1,
            onchange: function () { d({ type: 'preset/toggleLabel', source: ms.name, label: name }); }
          }),
          el('span', { class: 'field-name' }, name),
          isKey ? el('span', { class: 'tag' }, 'ключ') : null
        );
      };
      return el('div', { class: 'src' + (picked ? ' picked' : '') },
        el('div', { class: 'src-head' },
          el('button', {
            type: 'button', class: 'src-fold', disabled: !picked,
            title: !picked ? 'сначала отметьте источник'
                 : (open ? 'свернуть показатели' : 'развернуть показатели'),
            onclick: function () { if (picked) d({ type: 'ui/toggleSrc', name: ms.name }); }
          }, open ? '−' : '+'),
          el('label', { class: 'src-pick' },
            el('input', {
              type: 'checkbox', checked: picked,
              onchange: function () { d({ type: 'preset/toggleSource', name: ms.name }); }
            }),
            el('span', { class: 'src-name' }, ms.name)
          ),
          el('span', { class: 'muted' }, ms.rows + ' строк · срез ' + fmtDate(ms.as_of)),
          picked ? el('span', { class: 'muted src-fields-n' },
            '· показателей: ' + wanted.length + ' из ' + fields.length) : null,
          badge(ms)
        ),
        open ? el('div', { class: 'field-list' },
          fieldBox(ms.key, true),
          ms.labels.map(function (lb) { return fieldBox(lb, false); })
        ) : null
      );
    };

    // поля, доступные для join у источника: ключ + все его показатели
    var fieldsOf = function (name) {
      var ms = mSources.find(function (s) { return s.name === name; });
      return ms ? uniq([ms.key].concat(ms.labels)) : [];
    };

    var joinRow = function (j, i) {
      var pick = function (value, options, onchange) {
        return el('select', { onchange: function (e) { onchange(e.target.value); } },
          [el('option', { value: '' }, '—')].concat(options.map(function (o) {
            return el('option', { value: o, selected: o === value }, o);
          })));
      };
      var typeSelect = el('select', {
        class: 'join-type', title: 'тип связки',
        onchange: function (e) { d({ type: 'preset/updateJoin', index: i, patch: { type: e.target.value } }); }
      }, JOIN_TYPES.map(function (t) {
        return el('option', { value: t[0], selected: t[0] === (j.type || 'left') }, t[1]);
      }));
      return el('div', { class: 'join' },
        typeSelect,
        pick(j.left, chosen, function (v) { d({ type: 'preset/updateJoin', index: i, patch: { left: v, left_field: '' } }); }),
        el('span', { class: 'dot' }, '.'),
        pick(j.left_field, fieldsOf(j.left), function (v) { d({ type: 'preset/updateJoin', index: i, patch: { left_field: v } }); }),
        el('span', { class: 'eq' }, '='),
        pick(j.right, chosen, function (v) { d({ type: 'preset/updateJoin', index: i, patch: { right: v, right_field: '' } }); }),
        el('span', { class: 'dot' }, '.'),
        pick(j.right_field, fieldsOf(j.right), function (v) { d({ type: 'preset/updateJoin', index: i, patch: { right_field: v } }); }),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/removeJoin', index: i }); } }, '✕')
      );
    };

    // все выбранные (source, label) для базовых фильтров
    var pickedColumns = chosen.reduce(function (acc, name) {
      var ms = mSources.find(function (s) { return s.name === name; });
      if (!ms) return acc;
      var labels = preset.query.sources[name].labels || [ms.key].concat(ms.labels);
      return acc.concat(labels.map(function (l) { return chosen.length > 1 ? name + '.' + l : l; }));
    }, []);

    // поля для условий = ровно те столбцы, что будут в таблице после построения:
    // при заданных сущностях — их итоговые имена; иначе — выбранные сырые столбцы
    // (неявные 1:1-сущности). Сырые столбцы при наличии сущностей НЕ предлагаем —
    // после резолва их в строках нет, условие по ним обнуляло бы выборку.
    var condFields = preset.view.entities.length
      ? entityOutNames(preset.view.entities)
      : pickedColumns;

    var conditionRow = function (cond, i) {
      var patch = function (p) { d({ type: 'preset/updateCondition', index: i, patch: p }); };
      return el('div', { class: 'condition' + (OP_LIST[cond.op] ? ' has-list' : '') },
        el('select', { onchange: function (e) { patch({ field: e.target.value }); } },
          [el('option', { value: '' }, 'поле…')].concat(condFields.map(function (c) {
            return el('option', { value: c, selected: c === cond.field }, c);
          }))),
        opSelect(cond.op, function (v) { patch({ op: v }); }),
        valueControl(cond.op, cond.value, function (v) { patch({ value: v }); }),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/removeCondition', index: i }); } }, '✕')
      );
    };

    // ---- сущности (столбцы таблицы) ----
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
        body = el('div',{},
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

    return el('section', { class: 'page build' },
      el('h1', {}, 'Конструктор выборки'),

      el('div', { class: 'row' },
        el('label', { class: 'field' }, 'Срез (as_of; дата или дата-время, пусто = текущий момент)',
          el('input', {
            type: 'text', value: preset.query.as_of == null ? '' : String(preset.query.as_of),
            placeholder: 'например: 2024-02-01 14:30',
            onchange: function (e) { d({ type: 'preset/setAsOf', value: e.target.value }); }
          })
        ),
        preset.query.as_of != null
          ? el('span', { class: 'muted' }, '= ' + fmtDate(preset.query.as_of))
          : null
      ),

      el('h2', {}, 'Источники и показатели'),
      mSources.length
        ? el('div', { class: 'src-list' }, mSources.map(sourceRow))
        : el('p', { class: 'muted' }, 'Манифест пуст — сгенерируй данные (ds get / tools/gen_sample.py).'),

      chosen.length > 1 ? el('div', {},
        el('h2', {}, 'Связки между источниками'),
        el('div', { class: 'joins' }, preset.view.joins.map(joinRow)),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/addJoin' }); } }, '+ связка'),
        el('p', { class: 'muted', style: 'margin:.3rem 0 0' },
          'тип связки определяет, какие строки остаются без пары: левое — все строки левого '
          + 'источника, правое — все строки правого, внутреннее — только совпавшие, полное — все')
      ) : null,

      pickedColumns.length ? el('div', {},
        el('div', { class: 'sec-head' },
          el('button', {
            type: 'button', class: 'sec-fold',
            title: state.entOpen ? 'свернуть блок' : 'развернуть блок',
            onclick: function () { d({ type: 'ui/toggleEnt' }); }
          }, state.entOpen ? '−' : '+'),
          el('h2', {}, 'Сущности (столбцы таблицы)'),
          state.entOpen ? null
            : el('span', { class: 'muted' }, '· столбцов: ' + preset.view.entities.length)
        ),
        state.entOpen ? el('div', {},
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
        ) : null
      ) : null,

      pickedColumns.length ? el('div', {},
        el('h2', {}, 'Условия (сужают выборку при построении)'),
        el('div', { class: 'conditions' }, preset.view.conditions.map(conditionRow)),
        el('button', { class: 'link', onclick: function () { d({ type: 'preset/addCondition' }); } }, '+ условие'),
        el('p', { class: 'muted', style: 'margin:.3rem 0 0' },
          'применяются по порядку (И) при построении — на «Таблице» останутся только подходящие строки')
      ) : null,

      state.buildError ? el('p', { class: 'error' }, state.buildError) : null,

      el('div', { class: 'row' },
        el('label', { class: 'field small' }, 'Имя пресета',
          el('input', {
            type: 'text', value: preset.name || '',
            onchange: function (e) { d({ type: 'preset/setName', value: e.target.value }); }
          })
        ),
        el('span', { class: 'muted' },
          'изменения сохраняются автоматически как пресет по умолчанию (localStorage); '
          + '«Скачать пресет» — отдельный файл')
      ),

      el('div', { class: 'actions' },
        el('button', {
          class: 'primary', disabled: state.building || !chosen.length,
          onclick: function () { window.DS_APP.buildDataset(window.DS_APP.store); }
        }, state.building ? 'Строю…' : 'Применить и открыть таблицу'),
        el('button', { onclick: function () { savePreset(state.preset); } }, 'Скачать пресет'),
        el('label', { class: 'file-btn' }, 'Загрузить пресет',
          el('input', {
            type: 'file', accept: '.json,application/json',
            onchange: function (e) { loadPresetFile(e.target.files[0], d); e.target.value = ''; }
          })
        ),
        el('button', { onclick: function () { d({ type: 'preset/set', preset: basePreset() }); } }, 'Сбросить к базовому')
      )
    );
  };

  return { viewBuild: viewBuild };
});
