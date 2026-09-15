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

  // Главное меню в навбаре. «Настройки» — единственная настоящая страница
  // (полностью меняет вид, это логично отдельным экраном). «Экспорт» и
  // «Расширенный фильтр» — переключатели скрытой по умолчанию области НАД
  // таблицей (renderExportPanel / renderAdvFilter в view-table.js): данные
  // остаются на виду, пока их фильтруешь или экспортируешь — так удобнее,
  // чем на отдельной странице, где таблицы не видно вообще. У каждой кнопки
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
            class: 'gear', title: 'Настройки: изменить пресет по умолчанию',
            onclick: function () { d({ type: 'route/set', route: 'build' }); }
          }, '⚙ Настройки')
        ]
      : el('button', {
          class: 'gear', disabled: !state.dataset,
          onclick: function () { d({ type: 'route/set', route: 'table' }); }
        }, '← К таблице');
    return el('header', { class: 'nav' },
      el('strong', {}, 'Data Sources — Web UI'),
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
    opSelect: opSelect, valueControl: valueControl, viewNav: viewNav, viewFooter: viewFooter,
    FUNNEL_SVG: FUNNEL_SVG
  };
});
