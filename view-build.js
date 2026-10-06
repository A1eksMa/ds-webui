'use strict';

// Страница «Настройки» (бывший «Конструктор выборки»): источники, связки
// между ними, условия по сырым полям источников — то, что в SQL идёт после
// FROM/WHERE (откуда берём данные и как их отбираем ДО расчёта индикаторов).
// Столбцы результата и второй проход условий (по индикаторам) — отдельная
// страница «Индикаторы», см. view-entities.js. DOM-зависимый код — не
// тестируется под node:test. Зависит от util.js, store.js, dataset.js
// (JOIN_TYPES), view-common.js (conditionsBlock). Ссылки на main.js
// (buildDataset/store) разрешаются лениво через window.DS_APP в момент
// клика — main.js грузится последним, но к моменту, когда пользователь
// может кликнуть, все скрипты уже выполнены.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./util.js'), require('./store.js'), require('./dataset.js'), require('./view-common.js')
    );
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, factory(root.DS_APP, root.DS_APP, root.DS_APP, root.DS_APP));
  }
})(typeof window !== 'undefined' ? window : this, function (Util, Store, Dataset, ViewCommon) {

  var el = Util.el, uniq = Util.uniq, fmtDate = Util.fmtDate;
  var selectedNames = Store.selectedNames, isStale = Store.isStale, basePreset = Store.basePreset,
      savePreset = Store.savePreset, loadPresetFile = Store.loadPresetFile;
  var JOIN_TYPES = Dataset.JOIN_TYPES;
  var conditionsBlock = ViewCommon.conditionsBlock;

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
        ms.description ? el('div', { class: 'src-description' }, ms.description) : null,
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

    // Связка на источник chosen[i+1] (i — его индекс в preset.view.joins) — как SQL:
    // "слева" может быть только источник, уже накопленный к этому шагу (earlier),
    // "справа" — сам этот источник, фиксирован (не выбирается, поэтому не select).
    // Строка появляется/исчезает сама при отметке/снятии источника (см.
    // preset/toggleSource -> reconcileJoins), вручную тут правятся только поля.
    var joinRow = function (j, rightName, i, earlier) {
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
        pick(j.left, earlier, function (v) { d({ type: 'preset/updateJoin', index: i, patch: { left: v, left_field: '' } }); }),
        el('span', { class: 'dot' }, '.'),
        pick(j.left_field, fieldsOf(j.left), function (v) { d({ type: 'preset/updateJoin', index: i, patch: { left_field: v } }); }),
        el('span', { class: 'eq' }, '='),
        el('span', { class: 'src-name' }, rightName),
        el('span', { class: 'dot' }, '.'),
        pick(j.right_field, fieldsOf(rightName), function (v) { d({ type: 'preset/updateJoin', index: i, patch: { right_field: v } }); })
      );
    };

    // все выбранные (source, label) для базовых фильтров
    var pickedColumns = chosen.reduce(function (acc, name) {
      var ms = mSources.find(function (s) { return s.name === name; });
      if (!ms) return acc;
      var labels = preset.query.sources[name].labels || [ms.key].concat(ms.labels);
      return acc.concat(labels.map(function (l) { return chosen.length > 1 ? name + '.' + l : l; }));
    }, []);

    // условия «Настроек» — первый проход фильтрации, сразу после JOIN, по сырым
    // полям источников (до расчёта индикаторов — они на «Настройках» ещё не
    // посчитаны). Второй проход, по именам индикаторов — на странице «Индикаторы»
    // (view.entityConditions, применяется после resolveEntities в main.js).
    var settingsConditions = conditionsBlock({
      d: d,
      title: 'Условия (сужают выборку при построении)',
      hint: 'применяются по порядку (И) при построении, сразу после связок — до расчёта индикаторов; '
        + 'фильтр по индикаторам — на странице «Индикаторы»',
      fields: pickedColumns,
      conditions: preset.view.conditions,
      actions: { add: 'preset/addCondition', update: 'preset/updateCondition', remove: 'preset/removeCondition' }
    });

    return el('section', { class: 'page build' },
      el('h1', {}, 'Конструктор выборки'),

      el('h2', {}, 'Источники и показатели'),
      mSources.length
        ? el('div', { class: 'src-list' }, mSources.map(sourceRow))
        : el('p', { class: 'muted' }, 'Манифест пуст — сгенерируй данные (ds get / tools/gen_sample.py).'),

      chosen.length > 1 ? el('div', {},
        el('h2', {}, 'Связки между источниками'),
        el('div', { class: 'joins' }, chosen.slice(1).map(function (name, i) {
          return joinRow(preset.view.joins[i], name, i, chosen.slice(0, i + 1));
        })),
        el('p', { class: 'muted', style: 'margin:.3rem 0 0' },
          'каждый следующий источник присоединяется к уже накопленному множеству (как в SQL) — '
          + 'слева выбирается любой из ранее включённых источников; тип связки определяет, какие '
          + 'строки остаются без пары: левое — все строки левого источника, правое — все строки '
          + 'правого, внутреннее — только совпавшие, полное — все')
      ) : null,

      settingsConditions,

      state.buildError ? el('p', { class: 'error' }, state.buildError) : null,

      el('div', { class: 'row' },
        el('label', { class: 'field small' }, 'Имя пресета',
          el('input', {
            type: 'text', value: preset.name || '',
            onchange: function (e) { d({ type: 'preset/setName', value: e.target.value }); }
          })
        ),
        el('span', { class: 'muted' },
          'изменения сохраняются автоматически как пресет по умолчанию для этой вкладки '
          + '(sessionStorage); «Скачать пресет» — отдельный файл')
      ),

      el('div', { class: 'actions' },
        el('button', {
          class: 'primary', disabled: state.building || !chosen.length,
          onclick: function () { window.DS_APP.buildDataset(window.DS_APP.store); }
        }, state.building ? 'Строю…' : 'Применить и открыть таблицу'),
        el('button', {
          onclick: function () {
            // «Save As»: имя файла -> описание (по умолчанию — только что введённое
            // имя; открыть сохранённый .json текстовым редактором и поправить —
            // штатный способ задать более развёрнутое описание отдельно от имени).
            // Отмена первого запроса — не сохраняем вовсе; отмена второго — описание
            // остаётся равным имени, сохранение всё равно происходит.
            var defaultName = preset.name || 'preset';
            var name = window.prompt('Имя файла пресета:', defaultName);
            if (name == null) return;
            name = name.trim() || defaultName;
            var description = window.prompt(
              'Описание пресета (показывается заголовком на странице «Таблица»):', name
            );
            if (description == null) description = name;
            d({ type: 'preset/setName', value: name });
            d({ type: 'preset/setDescription', value: description });
            savePreset(Object.assign({}, preset, { name: name, description: description }));
          }
        }, 'Скачать пресет'),
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
