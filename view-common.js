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

  // <select> с первой опцией-плейсхолдером ("поле…", "—", ...) — общий вид для
  // всех select'ов выбора поля/столбца на «Настройках», «Индикаторах»,
  // расширенном фильтре (условия/группировка/сортировка/агрегаты).
  var fieldSelect = function (value, options, onChange, placeholderLabel) {
    return el('select', { onchange: function (e) { onChange(e.target.value); } },
      [el('option', { value: '' }, placeholderLabel)].concat(options.map(function (c) {
        return el('option', { value: c, selected: c === value }, c);
      })));
  };

  // Три кнопки ↑/↓/✕ для строки в редактируемом списке (условия, уровни
  // группировки/сортировки, входы/список сущностей) — disabled+title на
  // границах списка у ↑/↓ одинаково везде (раньше было по-разному: где-то
  // есть, где-то нет — путало, выглядело как будто кнопка не работает).
  // opts: {onUp, onDown, onRemove, upDisabled, downDisabled, upTitle, downTitle,
  // removeTitle} — upTitle/downTitle/removeTitle опциональны (не у каждого
  // списка кнопка ✕ нуждается в поясняющем title).
  var moveRemoveButtons = function (opts) {
    var upAttrs = { class: 'link', disabled: !!opts.upDisabled, onclick: opts.onUp };
    if (opts.upTitle) upAttrs.title = opts.upTitle;
    var downAttrs = { class: 'link', disabled: !!opts.downDisabled, onclick: opts.onDown };
    if (opts.downTitle) downAttrs.title = opts.downTitle;
    var removeAttrs = { class: 'link', onclick: opts.onRemove };
    if (opts.removeTitle) removeAttrs.title = opts.removeTitle;
    return [el('button', upAttrs, '↑'), el('button', downAttrs, '↓'), el('button', removeAttrs, '✕')];
  };

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

  // Строка условия отбора: [опциональный leading-узел] + поле + оператор +
  // значение + ✕. Используется и в conditionsBlock (без leading — «Настройки»/
  // «Индикаторы»), и напрямую в renderAdvFilter::advRow (view-table.js,
  // leading — селектор И/ИЛИ между строками) — раньше advRow был почти точной
  // копией этой функции, с одним этим отличием.
  var conditionRow = function (cond, fields, onPatch, onRemove, leading) {
    var patch = function (p) { onPatch(p); };
    return el('div', { class: 'condition' + (OP_LIST[cond.op] ? ' has-list' : '') },
      leading || null,
      fieldSelect(cond.field, fields, function (v) { patch({ field: v }); }, 'поле…'),
      opSelect(cond.op, function (v) { patch({ op: v }); }),
      valueControl(cond.op, cond.value, function (v) { patch({ value: v }); }),
      el('button', { class: 'link', onclick: onRemove }, '✕')
    );
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
      return conditionRow(cond, opts.fields,
        function (p) { d({ type: opts.actions.update, index: i, patch: p }); },
        function () { d({ type: opts.actions.remove, index: i }); });
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
  // (поиск -- переход к строке, фильтр -- contains-условие в state.adv).
  // Два разных действия, обе должны быть одинаковы для поиска и фильтра:
  //  - клик по значению из выпадающего списка -- только ПОДСТАВЛЯЕТ текст в
  //    поле (прямая мутация DOM-инпута, без dispatch) и ставит курсор в конец
  //    подставленного значения; панель НЕ закрывается и ничего не
  //    применяется -- пользователь может дописать/изменить текст дальше.
  //    Раньше клик по списку шёл через onApply (применял и закрывал сразу),
  //    из-за чего в режиме поиска "ничего не происходило" на вид, а в режиме
  //    фильтра — немедленно закрывало область, не давая поправить текст.
  //  - Enter (в поле) или клик по кнопке справа -- opts.onApply: целевое
  //    действие (поиск/фильтр) + закрытие панели (view-table.js::quickPanel).
  // opts.autofocus -- панель только что открыта (view-table.js::toggleQuick)
  // -- поставить фокус и курсор в конец текущего значения; требует живого
  // DOM-узла, поэтому через requestAnimationFrame (сразу после открытия
  // инпут ещё не вставлен в document синхронно). Выпадающий список первых N
  // уникальных значений столбца (opts.values, Dataset.uniqueValues) + общая
  // настройка "Показать N" под ним. Появляется по клику на пиктограмму;
  // закрывается по Enter, клику вне панели (document click, см.
  // view-table.js::attachDocCloseListener) или повторному клику на пиктограмму.
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
    if (opts.autofocus && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        input.focus();
        var end = input.value.length;
        if (input.setSelectionRange) input.setSelectionRange(end, end);
      });
    }
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
            onclick: function () {
              input.value = v;
              if (opts.onInput) opts.onInput(v);
              input.focus();
              if (input.setSelectionRange) input.setSelectionRange(v.length, v.length);
            }
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

  // Пиктограмма «сортировка» — привычная воронка (тот же визуальный язык,
  // что и у фильтра, FUNNEL_SVG выше), по запросу пользователя: без
  // сортировки — три полоски разной ширины (лестница), левый край у всех
  // одной высоты -- прямоугольный треугольник, не воронка (раньше была
  // воронка-контур, визуально путалась с залитой воронкой фильтра рядом).
  // По возрастанию -- широкая внизу, узкая вверху (треугольник остриём
  // вверх); по убыванию -- зеркально, широкая вверху. Несортированное
  // состояние -- тот же стиль "три полоски", но все одной ширины (гамбургер),
  // чтобы не вводить третью непохожую метафору. Один и тот же viewBox у всех
  // трёх -- пиктограмма не "прыгает" при переключении состояния.
  var SORT_SVG =
    '<svg viewBox="0 0 16 14" width="13" height="12" aria-hidden="true" focusable="false">'
    + '<rect x="0" y="0" width="16" height="3" rx="1" fill="currentColor"/>'
    + '<rect x="0" y="5.5" width="16" height="3" rx="1" fill="currentColor"/>'
    + '<rect x="0" y="11" width="16" height="3" rx="1" fill="currentColor"/></svg>';
  var SORT_ASC_SVG =
    '<svg viewBox="0 0 16 14" width="13" height="12" aria-hidden="true" focusable="false">'
    + '<rect x="0" y="0" width="5" height="3" rx="1" fill="currentColor"/>'
    + '<rect x="0" y="5.5" width="10" height="3" rx="1" fill="currentColor"/>'
    + '<rect x="0" y="11" width="16" height="3" rx="1" fill="currentColor"/></svg>';
  var SORT_DESC_SVG =
    '<svg viewBox="0 0 16 14" width="13" height="12" aria-hidden="true" focusable="false">'
    + '<rect x="0" y="0" width="16" height="3" rx="1" fill="currentColor"/>'
    + '<rect x="0" y="5.5" width="10" height="3" rx="1" fill="currentColor"/>'
    + '<rect x="0" y="11" width="5" height="3" rx="1" fill="currentColor"/></svg>';

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
    fieldSelect: fieldSelect, moveRemoveButtons: moveRemoveButtons,
    viewNav: viewNav, viewFooter: viewFooter, conditionsBlock: conditionsBlock, conditionRow: conditionRow,
    FUNNEL_SVG: FUNNEL_SVG, SEARCH_SVG: SEARCH_SVG,
    SORT_SVG: SORT_SVG, SORT_ASC_SVG: SORT_ASC_SVG, SORT_DESC_SVG: SORT_DESC_SVG
  };
});
