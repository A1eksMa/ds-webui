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
      uniqueValues = Dataset.uniqueValues, OP_LIST = Dataset.OP_LIST;
  var colWidthPx = Entities.colWidthPx, MIN_COL_W = Entities.MIN_COL_W;
  var opSelect = ViewCommon.opSelect, valueControl = ViewCommon.valueControl,
      quickValueInput = ViewCommon.quickValueInput;
  var FUNNEL_SVG = ViewCommon.FUNNEL_SVG, SEARCH_SVG = ViewCommon.SEARCH_SVG, SORT_SVG = ViewCommon.SORT_SVG;

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
      var patch = function (p) { d({ type: 'adv/update', index: i, patch: p }); };
      return el('div', { class: 'condition' + (OP_LIST[row.op] ? ' has-list' : '') },
        i === 0
          ? el('span', { class: 'adv-conj-spacer' })
          : el('select', { class: 'adv-conj', onchange: function (e) { patch({ conj: e.target.value }); } },
              el('option', { value: 'and', selected: row.conj !== 'or' }, 'И'),
              el('option', { value: 'or', selected: row.conj === 'or' }, 'ИЛИ')),
        el('select', { onchange: function (e) { patch({ field: e.target.value }); } },
          [el('option', { value: '' }, 'поле…')].concat(cols.map(function (c) {
            return el('option', { value: c, selected: c === row.field }, c);
          }))),
        opSelect(row.op, function (v) { patch({ op: v }); }),
        valueControl(row.op, row.value, function (v) { patch({ value: v }); }),
        el('button', { class: 'link', onclick: function () { d({ type: 'adv/remove', index: i }); } }, '✕')
      );
    };

    var groupRow = function (col, i) {
      return el('div', { class: 'condition' },
        el('select', { onchange: function (e) { d({ type: 'group/update', index: i, column: e.target.value }); } },
          [el('option', { value: '' }, 'поле…')].concat(cols.map(function (c) {
            return el('option', { value: c, selected: c === col }, c);
          }))),
        el('button', {
          class: 'link', title: 'выше', disabled: i === 0,
          onclick: function () { d({ type: 'group/move', index: i, dir: -1 }); }
        }, '↑'),
        el('button', {
          class: 'link', title: 'ниже', disabled: i === state.groupBy.length - 1,
          onclick: function () { d({ type: 'group/move', index: i, dir: 1 }); }
        }, '↓'),
        el('button', { class: 'link', onclick: function () { d({ type: 'group/remove', index: i }); } }, '✕')
      );
    };

    // Сортировка -- то же состояние (state.sortBy), что читают/пишут пиктограммы
    // в заголовке таблицы (view-table.js::renderGrid, quick/sort): эта секция —
    // полноценный многоуровневый редактор, порядок строк = приоритет (col1,
    // потом col2, ...). По образцу groupRow выше.
    var sortRow = function (lvl, i) {
      var patch = function (p) { d({ type: 'sort/update', index: i, patch: p }); };
      return el('div', { class: 'condition' },
        el('select', { onchange: function (e) { patch({ col: e.target.value }); } },
          [el('option', { value: '' }, 'поле…')].concat(cols.map(function (c) {
            return el('option', { value: c, selected: c === lvl.col }, c);
          }))),
        el('select', { onchange: function (e) { patch({ dir: e.target.value }); } },
          el('option', { value: 'asc', selected: lvl.dir !== 'desc' }, 'по возрастанию'),
          el('option', { value: 'desc', selected: lvl.dir === 'desc' }, 'по убыванию')
        ),
        el('button', {
          class: 'link', title: 'выше', disabled: i === 0,
          onclick: function () { d({ type: 'sort/move', index: i, dir: -1 }); }
        }, '↑'),
        el('button', {
          class: 'link', title: 'ниже', disabled: i === state.sortBy.length - 1,
          onclick: function () { d({ type: 'sort/move', index: i, dir: 1 }); }
        }, '↓'),
        el('button', { class: 'link', onclick: function () { d({ type: 'sort/remove', index: i }); } }, '✕')
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

  var renderGrid = function (state, d) {
    var node = document.getElementById('grid');
    if (!node) return;
    clear(node);

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
      var g = document.getElementById('grid');
      var tr = g && g.querySelector('tr[data-ridx="' + idx + '"]');
      if (!tr) return;
      tr.scrollIntoView({ block: 'center' });
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

    // Единая quick-панель под пиктограммами: поиск и фильтр — один и тот же
    // визуальный компонент (ViewCommon.quickValueInput), различается только то,
    // что делает Enter/клик по значению из списка (onApply).
    var quickPanel = function (c) {
      var mode = state.quickOpen[c];
      if (!mode) return null;
      var advIdx = state.adv.findIndex(function (cond) { return cond.field === c && cond.op === 'contains'; });
      var appliedValue = advIdx !== -1 ? String(state.adv[advIdx].value || '') : '';
      var draftKey = c + ':' + mode;
      var draft = quickDraft[draftKey] !== undefined ? quickDraft[draftKey] : (mode === 'filter' ? appliedValue : '');
      var close = function () { delete quickDraft[draftKey]; d({ type: 'quick/toggle', column: c, mode: mode }); };
      return quickValueInput({
        value: draft,
        dirty: mode === 'filter' && draft !== appliedValue,
        placeholder: mode === 'search' ? 'поиск…' : 'фильтр…',
        title: mode === 'search'
          ? 'Текст + Enter — перейти к следующей строке ниже; Esc — закрыть'
          : 'Текст + Enter (или кнопка справа) — применить; Esc — отменить ввод',
        applyIcon: mode === 'search' ? SEARCH_SVG : FUNNEL_SVG,
        applyTitle: mode === 'search' ? 'Найти следующую' : 'Применить фильтр',
        values: uniqueValues(state.dataset.rows, c, state.quickValuesLimit),
        limit: state.quickValuesLimit,
        onInput: function (v) { quickDraft[draftKey] = v; },
        onApply: function (v) {
          delete quickDraft[draftKey];
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
          onclick: function () { d({ type: 'quick/toggle', column: c, mode: 'search' }); }
        }),
        el('button', {
          type: 'button', class: 'col-icon' + (state.quickOpen[c] === 'filter' ? ' active' : '') + (hasFilter ? ' set' : ''),
          title: 'Быстрый фильтр (содержит)', html: FUNNEL_SVG,
          onclick: function () { d({ type: 'quick/toggle', column: c, mode: 'filter' }); }
        }),
        el('button', {
          type: 'button', class: 'col-icon' + (sortEntry ? ' set' : ''),
          title: 'Сортировка: по возр. / по убыв. / без', html: SORT_SVG,
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

    // многоуровневая группировка — уровни (state.groupBy) применяются вложенно,
    // по порядку; поле, которого больше нет среди колонок (устаревший выбор
    // после смены пресета), пропускается, как и пустое (ещё не выбранное)
    var activeGroups = (state.groupBy || []).filter(function (c) { return c && cols.indexOf(c) !== -1; });
    var bodyRows = [];

    if (activeGroups.length) {
      var memberIndent = (.5 + activeGroups.length * 1.2) + 'rem';
      var allKeys = [];

      // ключ узла — путь от корня (JSON, а не просто значение): на разных
      // уровнях/ветках значения могут совпадать текстуально
      var collectDeepKeys = function (rows, path) {
        var lvl = activeGroups[path.length];
        if (lvl === undefined) return;
        var gs = groupBy(function (r) { return String(r[lvl] == null ? '∅' : r[lvl]); })(rows);
        Object.keys(gs).forEach(function (k) {
          var subPath = path.concat([k]);
          allKeys.push(JSON.stringify(subPath));
          collectDeepKeys(gs[k], subPath);
        });
      };

      var renderLevel = function (rows, path) {
        var lvl = activeGroups[path.length];
        if (lvl === undefined) {
          rows.forEach(function (r) {
            bodyRows.push(el('tr', { class: 'member', dataset: { ridx: String(rowIndex.get(r)) } }, cols.map(function (c, i) {
              var cell = cellNode(r[c], entMap[c], r.__u && r.__u[c]);
              if (i === 0) cell.style.paddingLeft = memberIndent;
              return cell;
            })));
          });
          return;
        }
        var groups = groupBy(function (r) { return String(r[lvl] == null ? '∅' : r[lvl]); })(rows);
        var keys = Object.keys(groups).sort();
        keys.forEach(function (k) {
          var subPath = path.concat([k]);
          var pathKey = JSON.stringify(subPath);
          allKeys.push(pathKey);
          var open = !!state.expanded[pathKey];
          bodyRows.push(el('tr', { class: 'grp' + (open ? ' open' : '') },
            el('td', {
              colspan: cols.length, style: 'padding-left:' + (.5 + path.length * 1.2) + 'rem',
              onclick: function () { d({ type: 'table/toggleGroup', key: pathKey }); }
            },
              el('span', { class: 'caret' }, open ? '▾' : '▸'),
              ' ', lvl, ' = ', el('strong', {}, k),
              el('span', { class: 'muted' }, '  (' + groups[k].length + ')')
            )
          ));
          if (open) renderLevel(groups[k], subPath);
          else collectDeepKeys(groups[k], subPath);
        });
      };

      renderLevel(filtered.rows, []);

      node.appendChild(el('div', { class: 'grp-actions' },
        el('button', { class: 'link', onclick: function () { d({ type: 'table/expandAll', keys: allKeys }); } }, 'развернуть все'),
        el('button', { class: 'link', onclick: function () { d({ type: 'table/collapseAll' }); } }, 'свернуть все')
      ));
    } else {
      filtered.rows.forEach(function (r, i) {
        bodyRows.push(el('tr', { dataset: { ridx: String(i) } }, cols.map(function (c) {
          return cellNode(r[c], entMap[c], r.__u && r.__u[c]);
        })));
      });
    }

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
    node.appendChild(el('div', { class: 'scroll' },
      el('table', { class: 'data', style: 'width:' + totalW + 'px' },
        colgroup, el('thead', {}, head), el('tbody', {}, bodyRows))
    ));

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
    cellNode: cellNode, viewTableShell: viewTableShell, renderAdvFilter: renderAdvFilter,
    renderExportPanel: renderExportPanel, renderGrid: renderGrid
  };
});
