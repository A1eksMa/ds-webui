'use strict';

// Общие DOM-контролы, используемые и «Конструктором», и «Таблицей»: селект
// оператора условия, контрол значения условия (включая вставку списка из
// буфера обмена), шапка навигации (главное меню — Настройки/Расширенный
// фильтр/Экспорт) и обёртка строки состояния внизу окна. DOM-зависимый код —
// не тестируется под node:test. Зависит от util.js (el), effects.js
// (pasteFromClipboard), dataset.js (OP_LIST/OP_NO_VALUE/OPERATORS/parseList).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./util.js'), require('./effects.js'), require('./dataset.js'));
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, factory(root.DS_APP, root.DS_APP, root.DS_APP));
  }
})(typeof window !== 'undefined' ? window : this, function (Util, Effects, Dataset) {

  var el = Util.el;
  var pasteFromClipboard = Effects.pasteFromClipboard;
  var OPERATORS = Dataset.OPERATORS, OP_LIST = Dataset.OP_LIST, OP_NO_VALUE = Dataset.OP_NO_VALUE,
      parseList = Dataset.parseList;

  // --- строка условия: общие контролы для «Конструктора» и расширенного фильтра ---
  var opSelect = function (curOp, onChange) {
    return el('select', { onchange: function (e) { onChange(e.target.value); } },
      OPERATORS.map(function (o) {
        return el('option', { value: o[0], selected: o[0] === curOp }, o[1]);
      }));
  };

  var valueControl = function (op, value, onValue) {
    if (OP_LIST[op]) {
      return el('div', { class: 'cond-list-wrap' },
        el('textarea', {
          class: 'cond-list', rows: 3,
          placeholder: 'значения: по одному в строке или через запятую',
          onchange: function (e) { onValue(e.target.value); }
        }, value || ''),
        el('div', { class: 'cond-list-tools' },
          el('button', {
            class: 'link', type: 'button',
            onclick: function () {
              pasteFromClipboard(function (text) {
                var cur = value || '';
                onValue(cur.trim() ? cur.replace(/\s+$/, '') + '\n' + text : text);
              });
            }
          }, 'Вставить из буфера'),
          el('span', { class: 'muted' }, parseList(value).length + ' знач.')
        )
      );
    }
    return el('input', {
      type: 'text', class: 'cond-value', value: value || '',
      placeholder: OP_NO_VALUE[op] ? '—' : 'значение',
      disabled: !!OP_NO_VALUE[op],
      onchange: function (e) { onValue(e.target.value); }
    });
  };

  // Блок условий отбора — общий для «Настроек» (по сырым полям источников,
  // до расчёта сущностей) и «Индикаторов» (по именам сущностей, после
  // расчёта): один и тот же UI, разные списки полей и разные экшены
  // редьюсера (actions), чтобы каждая страница хранила свой список условий
  // в своей секции пресета. Ничего не рендерит, если fields пуст (нечего
  // фильтровать) — вызывающая сторона сама решает это условие ей не нужно.
  var conditionsBlock = function (opts) {
    if (!opts.fields.length) return null;
    var d = opts.d;
    var row = function (cond, i) {
      var patch = function (p) { d({ type: opts.actions.update, index: i, patch: p }); };
      return el('div', { class: 'condition' + (OP_LIST[cond.op] ? ' has-list' : '') },
        el('select', { onchange: function (e) { patch({ field: e.target.value }); } },
          [el('option', { value: '' }, 'поле…')].concat(opts.fields.map(function (c) {
            return el('option', { value: c, selected: c === cond.field }, c);
          }))),
        opSelect(cond.op, function (v) { patch({ op: v }); }),
        valueControl(cond.op, cond.value, function (v) { patch({ value: v }); }),
        el('button', { class: 'link', onclick: function () { d({ type: opts.actions.remove, index: i }); } }, '✕')
      );
    };
    return el('div', {},
      el('h2', {}, opts.title),
      el('div', { class: 'conditions' }, opts.conditions.map(row)),
      el('button', { class: 'link', onclick: function () { d({ type: opts.actions.add }); } }, '+ условие'),
      el('p', { class: 'muted', style: 'margin:.3rem 0 0' }, opts.hint)
    );
  };

  // Поле ввода под пиктограммами «поиск»/«фильтр» в заголовке столбца
  // (view-table.js): один и тот же визуальный компонент для обоих режимов --
  // различается только applyIcon/applyTitle/placeholder и что делает onApply
  // (поиск -- переход к строке, фильтр -- contains-условие в state.adv), как
  // и попросил пользователь. Выпадающий список первых N уникальных значений
  // столбца (opts.values, уже посчитан вызывающей стороной через
  // Dataset.uniqueValues) + общая настройка "Показать N" под ним.
  var quickValueInput = function (opts) {
    var input = el('input', {
      type: 'text', class: 'quick-input', value: opts.value || '',
      placeholder: opts.placeholder, title: opts.title,
      oninput: function (e) { if (opts.onInput) opts.onInput(e.target.value); },
      onkeydown: function (e) {
        if (e.key === 'Enter') { e.preventDefault(); opts.onApply(e.target.value); }
        else if (e.key === 'Escape' && opts.onEscape) { e.preventDefault(); opts.onEscape(); }
      }
    });
    var field = el('div', { class: 'quick-input-field' + (opts.dirty ? ' dirty' : '') },
      input,
      el('button', {
        type: 'button', class: 'quick-input-apply', html: opts.applyIcon, title: opts.applyTitle,
        onclick: function () { opts.onApply(input.value); }
      })
    );
    var dropdown = (opts.limit > 0 && opts.values && opts.values.length)
      ? el('div', { class: 'quick-values' }, opts.values.map(function (v) {
          return el('button', {
            type: 'button', class: 'quick-values-item', title: v,
            onclick: function () { opts.onApply(v); }
          }, v);
        }))
      : null;
    var limitRow = el('div', { class: 'quick-values-limit' },
      'Показать ',
      el('input', {
        type: 'number', min: '0', step: '1', class: 'quick-values-limit-input',
        value: String(opts.limit),
        onchange: function (e) { opts.onLimitChange(e.target.value); }
      })
    );
    return el('div', { class: 'quick-panel' }, field, dropdown, limitRow);
  };

  // Пиктограмма-воронка — та же самая, что и у кнопки применения быстрого
  // фильтра колонки в view-table.js (переиспользуется оттуда через
  // ViewCommon.FUNNEL_SVG — единый визуальный язык «это про фильтр»).
  var FUNNEL_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">'
    + '<path fill="currentColor" d="M1.7 2h12.6a.5.5 0 0 1 .4.8L10 9.2v3.5a.5.5 0 0 1-.7.46l-2.5-1.1'
    + 'A.5.5 0 0 1 6.3 11.6V9.2L1.3 2.8A.5.5 0 0 1 1.7 2Z"/></svg>';

  // Пиктограмма экспорта (стрелка вниз в лоток) — тем же приёмом, что и
  // воронка (одноцветная, currentColor), чтобы не выбиваться по стилю рядом
  // с ⚙ и воронкой (раньше был цветной эмодзи 📤 — не монохромный).
  var EXPORT_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">'
    + '<path fill="currentColor" d="M8 1.25c.35 0 .63.28.63.63v6.4l1.68-1.68a.63.63 0 1 1 .88.9'
    + 'l-2.75 2.75a.63.63 0 0 1-.88 0L4.8 7.5a.63.63 0 1 1 .88-.9l1.68 1.68v-6.4c0-.35.29-.63.63-.63Z"/>'
    + '<path fill="currentColor" d="M2.5 10a.63.63 0 0 1 .63.63v1.87c0 .35.28.63.62.63h8.5c.34 0 '
    + '.62-.28.62-.63v-1.87a.63.63 0 1 1 1.25 0v1.87A1.88 1.88 0 0 1 12.25 14h-8.5a1.88 1.88 0 0 1-1.87-1.88v-1.87c0-.34.28-.62.62-.62Z"/></svg>';

  // Пиктограмма «Индикаторы» — три столбика по возрастанию (как график
  // показателей), тем же одноцветным приёмом (currentColor).
  var INDICATORS_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">'
    + '<rect x="1" y="9" width="3" height="5" rx=".5" fill="currentColor"/>'
    + '<rect x="6.5" y="5.5" width="3" height="8.5" rx=".5" fill="currentColor"/>'
    + '<rect x="12" y="2" width="3" height="12" rx=".5" fill="currentColor"/></svg>';

  // Пиктограмма «поиск» — лупа, под заголовком столбца (view-table.js), тот же
  // монохромный приём, что у воронки/экспорта/индикаторов.
  var SEARCH_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">'
    + '<circle cx="6.8" cy="6.8" r="4.3" fill="none" stroke="currentColor" stroke-width="1.4"/>'
    + '<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" '
    + 'd="M10.2 10.2 14 14"/></svg>';

  // Пиктограмма «сортировка» — две стрелки (возр./убыв.), под заголовком
  // столбца; индикатор текущего направления (▲/▼) рисуется отдельно рядом
  // (col-name, как и раньше), эта пиктограмма — сама кнопка-переключатель.
  var SORT_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">'
    + '<path fill="currentColor" d="M4.5 1.5 7 5.3H2z"/>'
    + '<path fill="currentColor" d="M11.5 14.5 9 10.7h5z"/></svg>';

  // Главное меню в навбаре. «Настройки» и «Индикаторы» — настоящие страницы
  // (полностью меняют вид экрана, это логично отдельными экранами): на
  // «Настройках» — источники, связки, условия (то, что в SQL идёт после
  // FROM), на «Индикаторах» — сущности, то есть какие столбцы показать и
  // как их считать (то, что после SELECT). «Экспорт» и «Расширенный
  // фильтр» — переключатели скрытой по умолчанию области НАД таблицей
  // (renderExportPanel / renderAdvFilter в view-table.js): данные остаются
  // на виду, пока их фильтруешь или экспортируешь. У каждой кнопки
  // пиктограмма первым элементом, единый стиль (.gear).
  var viewNav = function (state, d) {
    var menu = state.route === 'table'
      ? [
          el('button', {
            class: 'gear', disabled: !state.dataset,
            onclick: function () { d({ type: 'export/toggle' }); }
          }, el('span', { html: EXPORT_SVG }), 'Экспорт ' + (state.exportOpen ? '▾' : '▸')),
          el('button', {
            class: 'gear', disabled: !state.dataset,
            title: 'Расширенный фильтр и сортировка: временные, поверх выборки, не сохраняются',
            onclick: function () { d({ type: 'adv/toggle' }); }
          }, el('span', { html: FUNNEL_SVG }), 'Расширенный фильтр ' + (state.advOpen ? '▾' : '▸')),
          el('button', {
            class: 'gear',
            title: 'Индикаторы: какие столбцы показать и как их считать',
            onclick: function () { d({ type: 'route/set', route: 'entities' }); }
          }, el('span', { html: INDICATORS_SVG }), 'Индикаторы'),
          el('button', {
            class: 'gear', title: 'Настройки: источники, связки, условия',
            onclick: function () { d({ type: 'route/set', route: 'build' }); }
          }, '⚙ Настройки')
        ]
      : state.route === 'build'
      // «Настройки» <-> «Индикаторы» — соседние страницы конструктора
      // (обе одного уровня, между ними логично переключаться напрямую, не
      // заходя каждый раз через «Таблицу»); «Таблица» — вперёд, к результату.
      ? [
          el('button', {
            class: 'gear', onclick: function () { d({ type: 'route/set', route: 'entities' }); }
          }, '← К индикаторам'),
          el('button', {
            class: 'gear', disabled: !state.dataset,
            onclick: function () { d({ type: 'route/set', route: 'table' }); }
          }, 'К таблице →')
        ]
      : [
          el('button', {
            class: 'gear', disabled: !state.dataset,
            onclick: function () { d({ type: 'route/set', route: 'table' }); }
          }, '← К таблице'),
          el('button', {
            class: 'gear', onclick: function () { d({ type: 'route/set', route: 'build' }); }
          }, 'К настройкам →')
        ];
    // Заголовок — описание текущего пресета (preset.description), не название
    // приложения: нулевой пресет (ничего не выбрано) показывает пустую строку,
    // не плейсхолдер — см. store.js::normalizePreset.
    return el('header', { class: 'nav' },
      el('strong', {}, (state.preset && state.preset.description) || ''),
      el('span', { class: 'spacer' }),
      menu
    );
  };

  // содержимое строки состояния внизу окна (как во многих десктоп-приложениях)
  // — сам <footer> создаётся один раз в main.js и не прокручивается вместе со
  // страницей, всегда на виду. Текст целиком собирает main.js (там же, где
  // источники данных и пайплайн фильтров «Таблицы») — здесь только обёртка.
  var viewFooter = function (text, warn) {
    return el('span', { class: 'muted' + (warn ? ' warn' : '') }, text);
  };

  return {
    opSelect: opSelect, valueControl: valueControl, quickValueInput: quickValueInput,
    viewNav: viewNav, viewFooter: viewFooter, conditionsBlock: conditionsBlock,
    FUNNEL_SVG: FUNNEL_SVG, SEARCH_SVG: SEARCH_SVG, SORT_SVG: SORT_SVG
  };
});
