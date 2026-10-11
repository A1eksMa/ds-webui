'use strict';

// Страница «Таблица»: viewTableShell (грид: быстрые фильтры, сортировка по
// клику, группировка, ручная ширина столбцов) + две скрытые по умолчанию
// области над ним, каждая открывается/закрывается своей кнопкой в навбаре
// (данные таблицы остаются на виду, пока с ними работаешь): renderAdvFilter
// (условия + сортировка/группировка — временные, не в пресете) и
// renderExportPanel (выбор формата + запуск выгрузки). Обе — императивные,
// как renderGrid: клирят и перестраивают свой персистентный div на каждый
// render(), независимо от того, пересобиралась ли вся оболочка страницы.
// DOM-зависимый код — не тестируется под node:test. Зависит от util.js,
// dataset.js, entities.js (colWidthPx/MIN_COL_W), view-common.js. Ссылки на
// main.js (store/exportXls/exportCsv) разрешаются лениво через window.DS_APP
// в момент клика — main.js грузится последним, но к моменту клика все
// скрипты уже выполнены.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./util.js'), require('./dataset.js'), require('./entities.js'),
      require('./view-common.js')
    );
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, factory(root.DS_APP, root.DS_APP, root.DS_APP, root.DS_APP));
  }
})(typeof window !== 'undefined' ? window : this, function (Util, Dataset, Entities, ViewCommon) {

  var el = Util.el, clear = Util.clear, groupBy = Util.groupBy;
  var visibleColumns = Dataset.visibleColumns, applyAdvanced = Dataset.applyAdvanced,
      applySort = Dataset.applySort, findNextMatch = Dataset.findNextMatch,
      uniqueValues = Dataset.uniqueValues;
  var colWidthPx = Entities.colWidthPx, MIN_COL_W = Entities.MIN_COL_W;
  var AGG_FUNCS_BY_TYPE = Entities.AGG_FUNCS_BY_TYPE, AGG_FUNC_LABELS = Entities.AGG_FUNC_LABELS,
      aggregateGroup = Entities.aggregateGroup;
  var quickValueInput = ViewCommon.quickValueInput, fieldSelect = ViewCommon.fieldSelect,
      moveRemoveButtons = ViewCommon.moveRemoveButtons, conditionRow = ViewCommon.conditionRow;
  var FUNNEL_SVG = ViewCommon.FUNNEL_SVG, SEARCH_SVG = ViewCommon.SEARCH_SVG, SORT_SVG = ViewCommon.SORT_SVG,
      SORT_ASC_SVG = ViewCommon.SORT_ASC_SVG, SORT_DESC_SVG = ViewCommon.SORT_DESC_SVG;

  var cellNode = function (v, entity, unparsed) {
    var st = '';
    var fmt = entity && entity.format;
    if (fmt) {
      if (fmt.align) st += 'text-align:' + fmt.align + ';';
      if (fmt.font_size) st += 'font-size:' + Number(fmt.font_size) + 'px;';
    }
    var attrs = st ? { style: st } : {};
    if (v === null) { attrs.class = 'del'; attrs.title = 'удалено (DELETE)'; return el('td', attrs, '∅'); }
    if (v === undefined || v === '') { attrs.class = 'empty'; return el('td', attrs, ''); }
    if (unparsed) {
      attrs.class = 'unparsed';
      attrs.title = 'не распознано как «' + ((entity && entity.type) || 'text') + '»';
    }
    if (!attrs.title) attrs.title = String(v);   // столбцы фикс. ширины — полное значение по ховеру
    return el('td', attrs, String(v));
  };

  var viewTableShell = function (state, d) {
    return el('section', { class: 'page table' },
      el('div', { class: 'table-headbar' },
        el('div', { class: 'advfilter', id: 'export-panel' }),
        el('div', { class: 'advfilter', id: 'advfilter' })
      ),
      el('div', { class: 'grid-wrap', id: 'grid' })
    );
  };

  // ---- «Расширенный фильтр» — скрытая по умолчанию область НАД таблицей
  // (условия + сортировка), открывается/закрывается кнопкой в навбаре;
  // временные, поверх пресета, не сохраняются (не в пресете, не в
  // localStorage). Данные таблицы остаются на виду, пока их фильтруешь —
  // в отличие от отдельной страницы, где таблицы не видно вообще.

  var renderAdvFilter = function (state, d) {
    var node = document.getElementById('advfilter');
    if (!node) return;
    clear(node);
    if (!state.advOpen || !state.dataset) return;

    var cols = visibleColumns(state.dataset, false);   // скрытые индикаторы тут не предлагаем
    var advRow = function (row, i) {
      var leading = i === 0
        ? el('span', { class: 'adv-conj-spacer' })
        : el('select', {
            class: 'adv-conj',
            onchange: function (e) { d({ type: 'adv/update', index: i, patch: { conj: e.target.value } }); }
          },
            el('option', { value: 'and', selected: row.conj !== 'or' }, 'И'),
            el('option', { value: 'or', selected: row.conj === 'or' }, 'ИЛИ'));
      return conditionRow(row, cols,
        function (p) { d({ type: 'adv/update', index: i, patch: p }); },
        function () { d({ type: 'adv/remove', index: i }); },
        leading);
    };

    var entMapForAgg = {};
    (state.dataset.entities || []).forEach(function (e) { entMapForAgg[e.name] = e; });
    var groupedColumns = state.groupBy.map(function (g) { return g.column; }).filter(Boolean);

    // Столбцы, уже занятые агрегатором НА ЛЮБОМ уровне, кроме самого редактируемого
    // выбора (exceptLevel/exceptAggIdx) -- один столбец не агрегируем по-разному сразу
    // в нескольких местах (store.js::groupAgg/* не валидирует это, UI не даёт выбрать).
    var usedAggColumns = function (exceptLevel, exceptAggIdx) {
      var out = [];
      state.groupBy.forEach(function (g, gi) {
        (g.agg || []).forEach(function (a, ai) {
          if (gi === exceptLevel && ai === exceptAggIdx) return;
          if (a.column) out.push(a.column);
        });
      });
      return out;
    };

    // Столбцы, для которых вообще есть хоть один агрегатор (число/дата/булево --
    // AGG_FUNCS_BY_TYPE), минус уже занятые группировкой или другим агрегатором;
    // curColumn -- всегда остаётся в списке, даже если "занят" (это его собственное
    // текущее значение).
    var aggColumnOptions = function (exceptLevel, exceptAggIdx, curColumn) {
      var used = groupedColumns.concat(usedAggColumns(exceptLevel, exceptAggIdx));
      return cols.filter(function (c) {
        if (c === curColumn) return true;
        if (used.indexOf(c) !== -1) return false;
        var t = (entMapForAgg[c] && entMapForAgg[c].type) || 'text';
        return (AGG_FUNCS_BY_TYPE[t] || []).length > 0;
      });
    };

    var aggRow = function (levelIdx, agg, ai) {
      var patch = function (p) { d({ type: 'groupAgg/update', index: levelIdx, aggIndex: ai, patch: p }); };
      var options = aggColumnOptions(levelIdx, ai, agg.column);
      var type = (entMapForAgg[agg.column] && entMapForAgg[agg.column].type) || 'text';
      var fns = AGG_FUNCS_BY_TYPE[type] || [];
      return el('div', { class: 'condition agg-row' },
        fieldSelect(agg.column, options, function (newCol) {
          var newType = (entMapForAgg[newCol] && entMapForAgg[newCol].type) || 'text';
          var newFns = AGG_FUNCS_BY_TYPE[newType] || [];
          patch({ column: newCol, fn: newFns.indexOf(agg.fn) !== -1 ? agg.fn : (newFns[0] || '') });
        }, 'поле…'),
        el('select', { disabled: !fns.length, onchange: function (e) { patch({ fn: e.target.value }); } },
          fns.map(function (f) {
            return el('option', { value: f, selected: f === agg.fn }, AGG_FUNC_LABELS[f] || f);
          })),
        el('button', { class: 'link', onclick: function () { d({ type: 'groupAgg/remove', index: levelIdx, aggIndex: ai }); } }, '✕')
      );
    };

    // Уровень группировки + (ниже) его агрегаторы для итоговой строки -- см.
    // docs/contract.md и store.js (groupBy теперь [{column, agg}], не просто строка).
    var groupRow = function (g, i) {
      var colOptions = cols.filter(function (c) { return c === g.column || groupedColumns.indexOf(c) === -1; });
      var addDisabled = !aggColumnOptions(i, -1, '').length;
      return el('div', { class: 'condition-block' },
        el('div', { class: 'condition' },
          fieldSelect(g.column, colOptions, function (v) { d({ type: 'group/update', index: i, patch: { column: v } }); }, 'поле…'),
          moveRemoveButtons({
            upTitle: 'выше', downTitle: 'ниже',
            upDisabled: i === 0, downDisabled: i === state.groupBy.length - 1,
            onUp: function () { d({ type: 'group/move', index: i, dir: -1 }); },
            onDown: function () { d({ type: 'group/move', index: i, dir: 1 }); },
            onRemove: function () { d({ type: 'group/remove', index: i }); }
          })
        ),
        (g.agg || []).length
          ? el('div', { class: 'agg-list' }, g.agg.map(function (a, ai) { return aggRow(i, a, ai); }))
          : null,
        el('div', { class: 'advfilter-foot agg-foot' },
          el('button', {
            class: 'link', disabled: addDisabled,
            title: addDisabled ? 'нет свободных числовых/дата/булевых полей для агрегации' : '',
            onclick: function () {
              var opts = aggColumnOptions(i, -1, '');
              if (!opts.length) return;
              var c0 = opts[0];
              var t0 = (entMapForAgg[c0] && entMapForAgg[c0].type) || 'text';
              var fns0 = AGG_FUNCS_BY_TYPE[t0] || [];
              d({ type: 'groupAgg/add', index: i, column: c0, fn: fns0[0] || '' });
            }
          }, '+ агрегат в итоге')
        )
      );
    };

    // Сортировка -- то же состояние (state.sortBy), что читают/пишут пиктограммы
    // в заголовке таблицы (view-table.js::renderGrid, quick/sort): эта секция —
    // полноценный многоуровневый редактор, порядок строк = приоритет (col1,
    // потом col2, ...). По образцу groupRow выше.
    var sortRow = function (lvl, i) {
      var patch = function (p) { d({ type: 'sort/update', index: i, patch: p }); };
      return el('div', { class: 'condition' },
        fieldSelect(lvl.col, cols, function (v) { patch({ col: v }); }, 'поле…'),
        el('select', { onchange: function (e) { patch({ dir: e.target.value }); } },
          el('option', { value: 'asc', selected: lvl.dir !== 'desc' }, 'по возрастанию'),
          el('option', { value: 'desc', selected: lvl.dir === 'desc' }, 'по убыванию')
        ),
        moveRemoveButtons({
          upTitle: 'выше', downTitle: 'ниже',
          upDisabled: i === 0, downDisabled: i === state.sortBy.length - 1,
          onUp: function () { d({ type: 'sort/move', index: i, dir: -1 }); },
          onDown: function () { d({ type: 'sort/move', index: i, dir: 1 }); },
          onRemove: function () { d({ type: 'sort/remove', index: i }); }
        })
      );
    };

    node.appendChild(el('div', { class: 'advfilter-panel' },
      el('h2', { style: 'margin-top:0' }, 'Установить фильтр'),
      state.adv.length ? el('div', { class: 'conditions' }, state.adv.map(advRow)) : null,
      el('div', { class: 'advfilter-foot' },
        el('button', { class: 'link', onclick: function () { d({ type: 'adv/add' }); } }, '+ условие')
      ),

      el('div', { class: 'divider' }),

      el('h2', {}, 'Сгруппировать'),
      state.groupBy.length ? el('div', { class: 'conditions' }, state.groupBy.map(groupRow)) : null,
      el('div', { class: 'advfilter-foot' },
        el('button', { class: 'link', onclick: function () { d({ type: 'group/add' }); } }, '+ уровень группировки')
      ),

      el('div', { class: 'divider' }),

      el('h2', {}, 'Отсортировать'),
      state.sortBy.length ? el('div', { class: 'conditions' }, state.sortBy.map(sortRow)) : null,
      el('div', { class: 'advfilter-foot' },
        el('button', { class: 'link', onclick: function () { d({ type: 'sort/add' }); } }, '+ уровень сортировки')
      ),

      el('div', { class: 'divider' }),

      el('label', { class: 'chk' },
        el('input', {
          type: 'checkbox', checked: state.hideEmpty,
          onchange: function () { d({ type: 'table/toggleHideEmpty' }); }
        }),
        'скрыть пустые колонки'
      ),

      el('div', { class: 'divider' }),

      el('div', { class: 'actions' },
        el('button', {
          class: 'primary', disabled: !state.adv.length,
          onclick: function () { d({ type: 'adv/reset' }); }
        }, 'Показать все')
      )
    ));
  };

  // ---- «Экспорт» — скрытая по умолчанию область над таблицей: выбор
  // формата + действие; та же схема, что и у расширенного фильтра.

  var renderExportPanel = function (state, d) {
    var node = document.getElementById('export-panel');
    if (!node) return;
    clear(node);
    if (!state.exportOpen || !state.dataset) return;

    node.appendChild(el('div', { class: 'advfilter-panel' },
      el('div', { class: 'row' },
        el('label', { class: 'chk' },
          el('input', {
            type: 'radio', name: 'export-format', checked: state.exportFormat !== 'csv',
            onchange: function () { d({ type: 'ui/setExportFormat', value: 'xls' }); }
          }),
          'Excel'
        ),
        el('label', { class: 'chk' },
          el('input', {
            type: 'radio', name: 'export-format', checked: state.exportFormat === 'csv',
            onchange: function () { d({ type: 'ui/setExportFormat', value: 'csv' }); }
          }),
          'CSV'
        )
      ),
      el('div', { class: 'actions' },
        el('button', {
          class: 'primary', onclick: function () {
            var st = window.DS_APP.store.getState();
            if (st.exportFormat === 'csv') window.DS_APP.exportCsv(st); else window.DS_APP.exportXls(st);
          }
        }, 'Экспортировать')
      )
    ));
  };

  // --- quick-пиктограммы столбцов (поиск/фильтр): ввод — черновик, применение —
  // Enter / кнопка. Ключ черновика "столбец:режим" — у одного столбца поиск и
  // фильтр редактируются независимо друг от друга.
  var quickDraft = {};
  // Курсор поиска "найти следующую" на столбец — чисто навигационное, не в сторе
  // (как и quickDraft, эфемерно, живёт только пока открыта страница).
  var searchCursor = {};
  // Сколько строк материализуется в DOM сразу, остальное — по скроллу (см.
  // renderGrid: rowDescriptors/materializeRow/renderMore). На таблицах от
  // нескольких тысяч строк именно создание DOM-узлов — дорогая часть; порог
  // принят пользователем без замера как приемлемый компромисс.
  var ROW_RENDER_BATCH = 1000;
  // "столбец:режим" панели, которой нужно вернуть фокус+курсор сразу после
  // ОТКРЫТИЯ (не на каждый ререндер — иначе фокус выдёргивало бы из-под
  // пользователя при любом не связанном с этой панелью dispatch, например
  // при правке "Показать N"). Выставляется в toggleQuick прямо перед
  // dispatch'ем, который открывает панель; считывается и сбрасывается один
  // раз в quickPanel на следующем render() (см. ViewCommon.quickValueInput
  // opts.autofocus).
  var pendingFocus = null;

  // Клик куда угодно вне открытой quick-панели (и не по одной из трёх
  // пиктограмм — у них свой onclick, не должен гаситься этим же кликом)
  // закрывает все открытые quick-слоты, как и попросил пользователь. Слушатель
  // навешивается на document один раз (node #grid переживает каждый render —
  // clear() чистит только его содержимое), currentState/currentDispatch
  // обновляются при каждом renderGrid.
  var docCloseListenerAttached = false;
  var currentState = null, currentDispatch = null;
  // Материализовать (при необходимости) строки до той, что ищет поиск (см.
  // ROW_RENDER_BATCH выше, renderMore/currentEnsureMemberRendered в renderGrid)
  // -- найденная строка может быть за пределами уже отрендеренного окна.
  // Тот же приём "currentX, обновляется на каждый renderGrid", что currentState/
  // currentDispatch чуть выше.
  var currentEnsureMemberRendered = null;
  var attachDocCloseListener = function () {
    if (docCloseListenerAttached) return;
    docCloseListenerAttached = true;
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.closest && (t.closest('.quick-panel') || t.closest('.col-icon'))) return;
      var qo = currentState && currentState.quickOpen;
      if (!qo || !Object.keys(qo).some(function (k) { return qo[k]; })) return;
      if (currentDispatch) currentDispatch({ type: 'quick/closeAll' });
    }, true);
  };

  var renderGrid = function (state, d) {
    var node = document.getElementById('grid');
    if (!node) return;
    clear(node);
    currentState = state;
    currentDispatch = d;
    attachDocCloseListener();

    if (!state.dataset) {
      node.appendChild(el('p', { class: 'muted' }, 'Сначала постройте таблицу в «Конструкторе выборки».'));
      return;
    }

    var cols = visibleColumns(state.dataset, state.hideEmpty);
    var entMap = {};
    (state.dataset.entities || []).forEach(function (e) { entMap[e.name] = e; });
    // конвейер: built dataset -> расширенный фильтр (условия + то, что добавили
    // пиктограммой "фильтр" -- это одно и то же состояние, state.adv) -> сортировка
    // (условия + то, что переключили пиктограммой "сортировка" -- тоже одно и то
    // же состояние, state.sortBy)
    var afterAdv = applyAdvanced(state.dataset, state.adv);
    var filtered = { columns: afterAdv.columns, rows: applySort(afterAdv.rows, state.sortBy) };

    // индекс строки в filtered.rows по ссылке -- нужен, чтобы после поиска найти
    // соответствующий <tr> в DOM (тегируется data-ridx ниже), в т.ч. после
    // раскрытия свёрнутых групп на пути к строке
    var rowIndex = new Map();
    filtered.rows.forEach(function (r, i) { rowIndex.set(r, i); });

    // черновики для исчезнувших столбцов не держим
    Object.keys(quickDraft).forEach(function (k) {
      var col = k.split(':')[0];
      if (state.dataset.columns.indexOf(col) === -1) delete quickDraft[k];
    });

    // перетаскивание правой границы заголовка -> ширина столбца (в пресет по mouseup)
    var startResize = function (ev, idx, c) {
      ev.preventDefault();
      ev.stopPropagation();
      var g = document.getElementById('grid');
      var tableEl = g && g.querySelector('table.data');
      var cg = tableEl && tableEl.querySelector('colgroup');
      var colEl = cg && cg.children[idx];
      var th = ev.target.parentNode;
      if (!colEl || !th) return;
      var startX = ev.clientX;
      var w0 = th.getBoundingClientRect().width;
      var total0 = tableEl.getBoundingClientRect().width;
      var widthAt = function (e) { return Math.max(MIN_COL_W, Math.round(w0 + (e.clientX - startX))); };
      var onMove = function (e) {
        var w = widthAt(e);
        colEl.style.width = w + 'px';
        tableEl.style.width = (total0 - w0 + w) + 'px';   // тянем и таблицу — иначе остальные столбцы сжимаются
      };
      var onUp = function (e) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('col-resizing');
        if (Math.abs(e.clientX - startX) >= 3) d({ type: 'preset/setColWidth', column: c, width: widthAt(e) });
      };
      document.body.classList.add('col-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    // Прокрутить и подсветить найденную поиском строку; раскрыть по дороге все
    // свёрнутые группы-предки (вычисляются из activeGroups тем же способом, что
    // и в renderLevel ниже). Выполняется ПОСЛЕ построения activeGroups —
    // объявлена здесь, вызывается из quick-панели поиска.
    var revealRow = function (idx) {
      if (currentEnsureMemberRendered) currentEnsureMemberRendered(idx);
      var g = document.getElementById('grid');
      var tr = g && g.querySelector('tr[data-ridx="' + idx + '"]');
      if (!tr) return;
      tr.scrollIntoView({ block: 'start' });
      tr.classList.add('found');
      setTimeout(function () { tr.classList.remove('found'); }, 1200);
    };

    var runSearch = function (c, needle) {
      var from = searchCursor[c] !== undefined ? searchCursor[c] : -1;
      var idx = findNextMatch(filtered.rows, c, needle, from);
      if (idx === -1) return;
      searchCursor[c] = idx;
      var row = filtered.rows[idx];
      var missing = [];
      if (activeGroups.length) {
        var path = [];
        activeGroups.forEach(function (lvl) {
          path.push(String(row[lvl] == null ? '∅' : row[lvl]));
          var key = JSON.stringify(path.slice());
          if (!state.expanded[key]) missing.push(key);
        });
      }
      if (missing.length) {
        missing.forEach(function (key) { d({ type: 'table/toggleGroup', key: key }); });
        // toggleGroup перерисовал грид синхронно — искать <tr> уже в новом DOM
      }
      revealRow(idx);
    };

    // Открыть/переключить quick-панель столбца. Если это ОТКРЫТИЕ (а не
    // повторный клик на ту же пиктограмму, который её закроет) — запомнить,
    // какому инпуту нужно отдать фокус на следующем render() (см.
    // pendingFocus выше и ViewCommon.quickValueInput opts.autofocus).
    var toggleQuick = function (c, mode) {
      if (state.quickOpen[c] !== mode) pendingFocus = c + ':' + mode;
      d({ type: 'quick/toggle', column: c, mode: mode });
    };

    // Единая quick-панель под пиктограммами: поиск и фильтр — один и тот же
    // визуальный компонент (ViewCommon.quickValueInput), различается только то,
    // что делает Enter/кнопка (onApply, см. комментарий внутри).
    var quickPanel = function (c) {
      var mode = state.quickOpen[c];
      if (!mode) return null;
      var advIdx = state.adv.findIndex(function (cond) { return cond.field === c && cond.op === 'contains'; });
      var appliedValue = advIdx !== -1 ? String(state.adv[advIdx].value || '') : '';
      var draftKey = c + ':' + mode;
      var draft = quickDraft[draftKey] !== undefined ? quickDraft[draftKey] : (mode === 'filter' ? appliedValue : '');
      var autofocus = pendingFocus === draftKey;
      if (autofocus) pendingFocus = null;
      var close = function () { delete quickDraft[draftKey]; d({ type: 'quick/toggle', column: c, mode: mode }); };
      return quickValueInput({
        value: draft,
        dirty: mode === 'filter' && draft !== appliedValue,
        autofocus: autofocus,
        placeholder: mode === 'search' ? 'поиск…' : 'фильтр…',
        title: mode === 'search'
          ? 'Текст + Enter — перейти к следующей строке ниже и закрыть; Esc — закрыть без поиска'
          : 'Текст + Enter (или кнопка справа) — применить и закрыть; Esc — отменить ввод и закрыть',
        applyIcon: mode === 'search' ? SEARCH_SVG : FUNNEL_SVG,
        applyTitle: mode === 'search' ? 'Найти следующую' : 'Применить фильтр',
        values: uniqueValues(state.dataset.rows, c, state.quickValuesLimit),
        limit: state.quickValuesLimit,
        onInput: function (v) { quickDraft[draftKey] = v; },
        // Enter / кнопка справа -- целевое действие + закрытие. Закрываем
        // ПЕРВЫМ dispatch'ом (рендерит грид с уже закрытой панелью), а
        // runSearch -- вторым шагом: revealRow ищет <tr> уже в этом новом
        // DOM и подсвечивает его там. Если бы порядок был обратным — подсветка
        // попадала бы на узел, который тем же тиком снесёт закрывающий
        // ререндер, и эффект не был бы виден вовсе (это и была причина
        // "ничего не происходит" при поиске). Для фильтра порядок не важен
        // функционально -- оставлен тот же, ради единой механики обоих режимов.
        onApply: function (v) {
          quickDraft[draftKey] = v;
          d({ type: 'quick/toggle', column: c, mode: mode });
          if (mode === 'search') runSearch(c, v); else d({ type: 'quick/applyFilter', column: c, value: v });
        },
        onEscape: close,
        onLimitChange: function (v) { d({ type: 'quick/setValuesLimit', value: v }); }
      });
    };

    var head = el('tr', {}, cols.map(function (c, idx) {
      var hasFilter = state.adv.some(function (cond) {
        return cond.field === c && cond.op === 'contains' && String(cond.value == null ? '' : cond.value).trim();
      });
      var sortEntry = state.sortBy.filter(function (s) { return s.col === c; })[0];
      var icons = el('div', { class: 'col-icons' },
        el('button', {
          type: 'button', class: 'col-icon' + (state.quickOpen[c] === 'search' ? ' active' : ''),
          title: 'Поиск по столбцу', html: SEARCH_SVG,
          onclick: function () { toggleQuick(c, 'search'); }
        }),
        el('button', {
          type: 'button', class: 'col-icon' + (state.quickOpen[c] === 'filter' ? ' active' : '') + (hasFilter ? ' set' : ''),
          title: 'Быстрый фильтр (содержит)', html: FUNNEL_SVG,
          onclick: function () { toggleQuick(c, 'filter'); }
        }),
        el('button', {
          type: 'button', class: 'col-icon' + (sortEntry ? ' set' : ''),
          title: 'Сортировка: по возр. / по убыв. / без',
          html: !sortEntry ? SORT_SVG : (sortEntry.dir === 'asc' ? SORT_ASC_SVG : SORT_DESC_SVG),
          onclick: function () { d({ type: 'quick/sort', column: c }); }
        })
      );
      return el('th', {},
        el('div', { class: 'col-name' + (sortEntry ? ' sorted' : '') },
          el('span', { class: 'col-name-txt' }, c),
          sortEntry ? el('span', { class: 'sort-ind' }, sortEntry.dir === 'asc' ? ' ▲' : ' ▼') : null),
        icons,
        quickPanel(c),
        el('div', {
          class: 'col-resizer',
          title: 'Потяните — ширина столбца; двойной клик — сброс',
          onmousedown: function (ev) { startResize(ev, idx, c); },
          ondblclick: function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            d({ type: 'preset/setColWidth', column: c, width: null });
          }
        })
      );
    }));

    // многоуровневая группировка — уровни (state.groupBy, [{column, agg}]) применяются
    // вложенно, по порядку; уровень, чьё поле больше не среди колонок (устаревший выбор
    // после смены пресета), пропускается, как и уровень с пустым полем (ещё не выбрано)
    var activeGroups = (state.groupBy || []).filter(function (g) { return g.column && cols.indexOf(g.column) !== -1; });

    // Построение строк разбито на два шага: сначала -- ТОЛЬКО данные
    // (rowDescriptors, без единого DOM-узла), потом -- материализация в <tr>
    // (materializeRow ниже), и только для видимого окна + догрузки по скроллу
    // (см. после сборки таблицы). На таблице от нескольких тысяч строк дорогая
    // часть -- именно создание DOM; сам обход/группировка данных дёшев и для
    // rowDescriptors делается целиком, без батчинга.
    var rowDescriptors = [];

    if (activeGroups.length) {
      var memberIndent = (.5 + activeGroups.length * 1.2) + 'rem';
      var allKeys = [];

      // ключ узла — путь от корня (JSON, а не просто значение): на разных
      // уровнях/ветках значения могут совпадать текстуально
      var collectDeepKeys = function (rows, path) {
        var lvl = activeGroups[path.length];
        if (lvl === undefined) return;
        var gs = groupBy(function (r) { return String(r[lvl.column] == null ? '∅' : r[lvl.column]); })(rows);
        Object.keys(gs).forEach(function (k) {
          var subPath = path.concat([k]);
          allKeys.push(JSON.stringify(subPath));
          collectDeepKeys(gs[k], subPath);
        });
      };

      var collectLevel = function (rows, path) {
        var lvl = activeGroups[path.length];
        if (lvl === undefined) {
          rows.forEach(function (r) {
            rowDescriptors.push({ kind: 'member', row: r, ridx: rowIndex.get(r), indent: memberIndent });
          });
          return;
        }
        var groups = groupBy(function (r) { return String(r[lvl.column] == null ? '∅' : r[lvl.column]); })(rows);
        var keys = Object.keys(groups).sort();
        // Агрегаторы, видимые в итоговой строке ЭТОГО уровня: свои + со ВСЕХ более
        // глубоких уровней (path.length и глубже) -- агрегатор нижнего слоя всплывает
        // во все строки-предки, агрегатор верхнего слоя остаётся только там (как
        // попросил пользователь). Пересчитываем по ПОЛНОМУ набору строк узла
        // (groups[k]), а не суммируем уже готовые подытоги более глубоких узлов --
        // иначе AVG/MIN/MAX были бы не "средним/минимумом по узлу", а "средним
        // средних" и т.п.
        var aggByColumn = {};
        for (var li = path.length; li < activeGroups.length; li++) {
          (activeGroups[li].agg || []).forEach(function (a) { if (a.column) aggByColumn[a.column] = a; });
        }
        keys.forEach(function (k) {
          var subPath = path.concat([k]);
          var pathKey = JSON.stringify(subPath);
          allKeys.push(pathKey);
          var open = !!state.expanded[pathKey];
          var groupRows = groups[k];
          rowDescriptors.push({
            kind: 'grp', path: subPath, pathKey: pathKey, open: open, k: k,
            groupRows: groupRows, lvl: lvl, aggByColumn: aggByColumn
          });
          if (open) collectLevel(groupRows, subPath);
          else collectDeepKeys(groupRows, subPath);
        });
      };

      collectLevel(filtered.rows, []);

      node.appendChild(el('div', { class: 'grp-actions' },
        el('button', { class: 'link', onclick: function () { d({ type: 'table/expandAll', keys: allKeys }); } }, 'развернуть все'),
        el('button', { class: 'link', onclick: function () { d({ type: 'table/collapseAll' }); } }, 'свернуть все')
      ));
    } else {
      filtered.rows.forEach(function (r, i) {
        rowDescriptors.push({ kind: 'member', row: r, ridx: i });
      });
    }

    // Единственное место, создающее DOM-узел строки из descriptor -- вызывается
    // только для текущего окна (ниже), не для rowDescriptors целиком.
    var materializeRow = function (rd) {
      if (rd.kind === 'member') {
        var r = rd.row;
        var attrs = { dataset: { ridx: String(rd.ridx) } };
        if (rd.indent) attrs.class = 'member';
        return el('tr', attrs, cols.map(function (c, i) {
          var cell = cellNode(r[c], entMap[c], r.__u && r.__u[c]);
          if (rd.indent && i === 0) cell.style.paddingLeft = rd.indent;
          return cell;
        }));
      }
      var open = rd.open, pathKey = rd.pathKey, groupRows = rd.groupRows, lvl = rd.lvl,
          aggByColumn = rd.aggByColumn, k = rd.k, path = rd.path;
      return el('tr', {
        class: 'grp' + (open ? ' open' : ''),
        onclick: function () { d({ type: 'table/toggleGroup', key: pathKey }); }
      }, cols.map(function (c) {
        if (c === lvl.column) {
          return el('td', { style: 'padding-left:' + (.5 + path.length * 1.2) + 'rem' },
            el('span', { class: 'caret' }, open ? '▾' : '▸'),
            ' ', el('strong', {}, k),
            el('span', { class: 'muted' }, '  (' + groupRows.length + ')')
          );
        }
        var a = aggByColumn[c];
        if (!a) return el('td', {}, '');
        var val = aggregateGroup(groupRows, c, entMap[c], a.fn);
        return el('td', { class: 'agg-cell', title: AGG_FUNC_LABELS[a.fn] || a.fn }, val == null ? '' : val);
      }));
    };

    // сводка (пресет/срез/строки/колонки) переехала в строку состояния внизу
    // окна (main.js, .statusbar) — единое место для всей информационной строки
    var gridColW = colWidthPx(state);
    var widths = cols.map(function (c) { return Number(gridColW(c)); });
    var colgroup = el('colgroup', {}, widths.map(function (w) {
      return el('col', { style: 'width:' + w + 'px' });
    }));
    // Явная ширина = сумма столбцов. Без неё table-layout:fixed при width:max-content
    // всё равно меряет контент → столбец не ужать уже текста заголовка.
    var totalW = widths.reduce(function (a, b) { return a + b; }, 0);

    // Первый проход материализует только ROW_RENDER_BATCH строк (а не все
    // rowDescriptors) -- остальное догружается по скроллу (renderMore), минуя
    // store.dispatch: иначе каждый тик скролла заново гонял бы весь конвейер
    // (applyAdvanced/applySort/группировку + полную пересборку DOM) и
    // обесценивал саму идею батчинга.
    var renderedCount = Math.min(ROW_RENDER_BATCH, rowDescriptors.length);
    var bodyRows = [];
    for (var ri = 0; ri < renderedCount; ri++) bodyRows.push(materializeRow(rowDescriptors[ri]));

    node.appendChild(el('div', { class: 'scroll' },
      el('table', { class: 'data', style: 'width:' + totalW + 'px' },
        colgroup, el('thead', {}, head), el('tbody', {}, bodyRows))
    ));

    var scrollEl = node.querySelector('.scroll');
    var tbodyEl = scrollEl && scrollEl.querySelector('tbody');
    var renderMore = function (targetCount) {
      var target = Math.min(rowDescriptors.length, targetCount);
      if (target <= renderedCount || !tbodyEl) return;
      var frag = document.createDocumentFragment();
      for (var i = renderedCount; i < target; i++) frag.appendChild(materializeRow(rowDescriptors[i]));
      tbodyEl.appendChild(frag);
      renderedCount = target;
    };
    if (scrollEl && renderedCount < rowDescriptors.length) {
      // Порог "один экран до низа" -- догружаем заранее, чтобы пользователь не
      // увидел пустоту даже на резком скролле колесом/перетаскиванием полосы.
      scrollEl.addEventListener('scroll', function () {
        if (renderedCount >= rowDescriptors.length) return;
        var remaining = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        if (remaining < scrollEl.clientHeight) renderMore(renderedCount + ROW_RENDER_BATCH);
      });
    }
    // currentEnsureMemberRendered -- найденная поиском строка (revealRow) может
    // лежать за пределами уже отрендеренного окна; досрочно догружаем до неё.
    currentEnsureMemberRendered = function (ridx) {
      for (var i = renderedCount; i < rowDescriptors.length; i++) {
        if (rowDescriptors[i].kind === 'member' && rowDescriptors[i].ridx === ridx) { renderMore(i + 1); return; }
      }
    };

    // реальная высота строки пиктограмм — под неё резервируется место в
    // .col-name (padding-bottom: var(--filter-h)), чтобы прижатая ко дну
    // ячейки (position:absolute) строка не перекрывала текст заголовка и не
    // "гуляла" по высоте между столбцами с разной длиной заголовка. Открытая
    // quick-панель (поиск/фильтр) в этот расчёт не входит — она плавает
    // отдельным оверлеем над строками таблицы, а не раздвигает заголовок
    // (см. .quick-panel в styles.css).
    var oneIcons = node.querySelector('.col-icons');
    var docEl = document.documentElement;
    if (oneIcons && docEl && docEl.style && typeof docEl.style.setProperty === 'function') {
      docEl.style.setProperty('--filter-h', oneIcons.offsetHeight + 'px');
    }
  };

  return {
    viewTableShell: viewTableShell, renderAdvFilter: renderAdvFilter,
    renderExportPanel: renderExportPanel, renderGrid: renderGrid
  };
});
