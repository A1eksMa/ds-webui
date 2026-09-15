'use strict';

// Общие DOM-контролы, используемые и «Конструктором», и «Таблицей»: селект
// оператора условия, контрол значения условия (включая вставку списка из
// буфера обмена), шапка навигации. DOM-зависимый код — не тестируется под
// node:test. Зависит от util.js (el), effects.js (pasteFromClipboard),
// dataset.js (OP_LIST/OP_NO_VALUE/OPERATORS/parseList).
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

  var viewNav = function (state, d) {
    var ctl = state.route === 'table'
      ? el('button', {
          class: 'gear', title: 'Настройки: изменить пресет по умолчанию',
          onclick: function () { d({ type: 'route/set', route: 'build' }); }
        }, '⚙ Настройки')
      : el('button', {
          class: 'gear', disabled: !state.dataset,
          onclick: function () { d({ type: 'route/set', route: 'table' }); }
        }, '← К таблице');
    var advBtn = state.route === 'table'
      ? el('button', {
          class: 'gear' + (state.advOpen ? ' on' : ''),
          title: 'Расширенный фильтр: временные условия поверх выборки (не сохраняются)',
          onclick: function () { d({ type: 'adv/toggle' }); }
        }, 'Расширенный фильтр ' + (state.advOpen ? '▾' : '▸'))
      : null;
    return el('header', { class: 'nav' },
      el('strong', {}, 'Data Sources — Web UI'),
      el('span', { class: 'spacer' }),
      state.dataDir
        ? el('span', { class: 'muted src-dir' }, 'данные: ' + state.dataDir + '/')
        : el('span', { class: 'muted src-dir warn' }, 'нет data/ и sample-data/'),
      advBtn,
      ctl
    );
  };

  return { opSelect: opSelect, valueControl: valueControl, viewNav: viewNav };
});
