'use strict';

// Страница «Таблица»: тулбар, расширенный фильтр, грид (быстрые фильтры,
// сортировка, группировка, ручная ширина столбцов). DOM-зависимый код — не
// тестируется под node:test. Зависит от util.js, dataset.js, entities.js
// (colWidthPx/MIN_COL_W), view-common.js. Ссылки на main.js
// (store/exportXls/exportCsv) разрешаются лениво через window.DS_APP в момент
// клика — main.js грузится последним, но к моменту клика все скрипты уже
// выполнены.
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
      applyFilters = Dataset.applyFilters, applySort = Dataset.applySort, OP_LIST = Dataset.OP_LIST;
  var colWidthPx = Entities.colWidthPx, MIN_COL_W = Entities.MIN_COL_W;
  var opSelect = ViewCommon.opSelect, valueControl = ViewCommon.valueControl;

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
    var cols = state.dataset ? state.dataset.columns : [];
    var toolbar = el('div', { class: 'toolbar' },
      el('label', { class: 'chk' },
        el('input', {
          type: 'checkbox', checked: state.hideEmpty,
          onchange: function () { d({ type: 'table/toggleHideEmpty' }); }
        }),
        'скрыть пустые колонки'
      ),
      el('label', { class: 'chk', title: 'вынести таблицу за пределы колонки контента — во всю ширину окна браузера' },
        el('input', {
          type: 'checkbox', checked: state.wideTable,
          onchange: function (e) { d({ type: 'ui/setWideTable', value: e.target.checked }); }
        }),
        'во всю ширину окна'
      ),
      el('span', { class: 'spacer' }),
      el('label', { class: 'field small', title: 'подставляется в имя выгружаемого файла как «источник»' },
        'Пользователь',
        el('input', {
          type: 'text', value: state.author, placeholder: 'user',
          onchange: function (e) { d({ type: 'ui/setAuthor', value: e.target.value }); }
        })
      ),
      el('button', { onclick: function () { window.DS_APP.exportXls(window.DS_APP.store.getState()); } }, 'Выгрузить в Excel'),
      el('button', { onclick: function () { window.DS_APP.exportCsv(window.DS_APP.store.getState()); } }, 'CSV')
    );

    return el('section', { class: 'page table' },
      el('div', { class: 'table-headbar' },
        state.dataset ? toolbar : null,
        el('div', { class: 'advfilter', id: 'advfilter' })
      ),
      el('div', { class: 'grid-wrap', id: 'grid' })
    );
  };

  // ---- Расширенный фильтр (панель над таблицей; не сохраняется) ----------

  var renderAdvFilter = function (state, d) {
    var node = document.getElementById('advfilter');
    if (!node) return;
    clear(node);
    if (!state.advOpen || !state.dataset) return;

    var cols = state.dataset.columns;
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

    var shown = applyAdvanced(state.dataset, state.adv).rows.length;

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

    node.appendChild(el('div', { class: 'advfilter-panel' },
      el('div', { class: 'advfilter-head' },
        el('strong', {}, 'Расширенный фильтр'),
        el('span', { class: 'muted' }, ' — поверх настроек, до быстрых; не входит в пресет'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'link', onclick: function () { d({ type: 'adv/toggle' }); } }, 'Скрыть')
      ),
      el('h2', { style: 'margin:.6rem 0 .3rem' }, 'Условия'),
      state.adv.length
        ? el('div', { class: 'conditions' }, state.adv.map(advRow))
        : el('p', { class: 'muted', style: 'margin:.2rem 0' }, 'условий нет — выборка как из «Конструктора»'),
      el('div', { class: 'advfilter-foot' },
        el('button', { class: 'link', onclick: function () { d({ type: 'adv/add' }); } }, '+ условие'),
        el('button', {
          class: 'link', disabled: !state.adv.length,
          onclick: function () { d({ type: 'adv/reset' }); }
        }, 'сбросить условия'),
        el('span', { class: 'muted' }, 'показано ' + shown + ' из ' + state.dataset.rows.length)
      ),
      el('h2', { style: 'margin:.8rem 0 .3rem' }, 'Группировка'),
      el('p', { class: 'muted', style: 'margin:.2rem 0' },
        'уровни применяются по порядку сверху вниз (вложенно): сначала группируем по первому полю, внутри каждой группы — по второму, и так далее'),
      state.groupBy.length
        ? el('div', { class: 'conditions' }, state.groupBy.map(groupRow))
        : el('p', { class: 'muted', style: 'margin:.2rem 0' }, 'группировки нет — строки таблицы плоским списком'),
      el('div', { class: 'advfilter-foot' },
        el('button', { class: 'link', onclick: function () { d({ type: 'group/add' }); } }, '+ уровень группировки')
      )
    ));
  };

  // --- быстрые фильтры столбцов: ввод — черновик, применение — Enter / кнопка ---
  var colFilterDraft = {};   // столбец -> введённый, но ещё не применённый текст
  var FUNNEL_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">'
    + '<path fill="currentColor" d="M1.7 2h12.6a.5.5 0 0 1 .4.8L10 9.2v3.5a.5.5 0 0 1-.7.46l-2.5-1.1'
    + 'A.5.5 0 0 1 6.3 11.6V9.2L1.3 2.8A.5.5 0 0 1 1.7 2Z"/></svg>';

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
    // конвейер: built dataset -> расширенный фильтр -> быстрые фильтры -> сортировка
    var afterAdv = applyAdvanced(state.dataset, state.adv);
    var afterQuick = applyFilters(afterAdv, state.tableFilters);
    var filtered = { columns: afterQuick.columns, rows: applySort(afterQuick.rows, state.sort) };

    // черновики для исчезнувших столбцов не держим
    Object.keys(colFilterDraft).forEach(function (k) {
      if (state.dataset.columns.indexOf(k) === -1) delete colFilterDraft[k];
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

    var applyColFilter = function (c, value) {
      delete colFilterDraft[c];
      d({ type: 'table/setFilter', column: c, value: value });
      // грид перерисован синхронно — вернуть фокус в то же поле
      var g = document.getElementById('grid');
      if (g) [].some.call(g.querySelectorAll('.col-filter'), function (n) {
        if (n.dataset.col !== c) return false;
        n.focus();
        n.setSelectionRange(n.value.length, n.value.length);
        return true;
      });
    };

    var head = el('tr', {}, cols.map(function (c, idx) {
      var applied = state.tableFilters[c] || '';
      var draft = colFilterDraft[c] !== undefined ? colFilterDraft[c] : applied;
      var field;
      var input = el('input', {
        type: 'text', class: 'col-filter', value: draft, placeholder: 'фильтр…',
        title: 'Текст + Enter (или кнопка справа) — применить; Esc — отменить ввод',
        dataset: { col: c },
        oninput: function (e) {
          colFilterDraft[c] = e.target.value;
          field.classList.toggle('dirty', e.target.value !== (state.tableFilters[c] || ''));
        },
        onkeydown: function (e) {
          if (e.key === 'Enter') { e.preventDefault(); applyColFilter(c, e.target.value); }
          else if (e.key === 'Escape') {
            e.preventDefault();
            delete colFilterDraft[c];
            e.target.value = state.tableFilters[c] || '';
            field.classList.remove('dirty');
          }
        }
      });
      field = el('div', { class: 'col-filter-field' + (draft !== applied ? ' dirty' : '') },
        input,
        el('button', {
          type: 'button', class: 'col-filter-apply', html: FUNNEL_SVG,
          title: 'Применить фильтр',
          onclick: function () { applyColFilter(c, input.value); }
        })
      );
      var sortDir = state.sort && state.sort.col === c ? state.sort.dir : null;
      return el('th', {},
        el('div', {
          class: 'col-name' + (sortDir ? ' sorted' : ''),
          title: 'Клик — сортировка по столбцу (по возр. / по убыв. / без)',
          onclick: function () { d({ type: 'table/sort', column: c }); }
        },
          el('span', { class: 'col-name-txt' }, c),
          sortDir ? el('span', { class: 'sort-ind' }, sortDir === 'asc' ? ' ▲' : ' ▼') : null),
        field,
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
            bodyRows.push(el('tr', { class: 'member' }, cols.map(function (c, i) {
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
      filtered.rows.forEach(function (r) {
        bodyRows.push(el('tr', {}, cols.map(function (c) {
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

    // реальная высота поля быстрого фильтра — под неё резервируется место в
    // .col-name (padding-bottom: var(--filter-h)), чтобы прижатый ко дну
    // ячейки (position:absolute) фильтр не перекрывал текст заголовка и не
    // "гулял" по высоте между столбцами с разной длиной заголовка
    var oneFilter = node.querySelector('.col-filter-field');
    var docEl = document.documentElement;
    if (oneFilter && docEl && docEl.style && typeof docEl.style.setProperty === 'function') {
      docEl.style.setProperty('--filter-h', oneFilter.offsetHeight + 'px');
    }
  };

  return { cellNode: cellNode, viewTableShell: viewTableShell, renderAdvFilter: renderAdvFilter, renderGrid: renderGrid };
});
