'use strict';

// Страница «Настройки» (бывший «Конструктор выборки»): источники, связки
// между ними, условия — то, что в SQL идёт после FROM (откуда берём данные
// и как их отбираем). Столбцы результата (сущности) — отдельная страница
// «Индикаторы», см. view-entities.js. DOM-зависимый код — не тестируется под
// node:test. Зависит от util.js, store.js, entities.js (entityOutNames),
// dataset.js (OP_LIST/JOIN_TYPES), view-common.js. Ссылки на main.js
// (buildDataset/store) разрешаются лениво через window.DS_APP в момент
// клика — main.js грузится последним, но к моменту, когда пользователь
// может кликнуть, все скрипты уже выполнены.
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
  var entityOutNames = Entities.entityOutNames;
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
