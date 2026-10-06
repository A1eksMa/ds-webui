'use strict';

// Смоук-тест бутстрапа приложения: реально выполняет последовательность
// <script> из index.html в минимальном самодельном DOM-стабе (без jsdom,
// без npm-зависимостей), с настоящим sample-data/. Ловит ошибки склейки
// модулей (забытый экспорт, не тот порядок <script>, сломанная ленивая
// ссылка на window.DS_APP), которые тесты в tests/*.test.js не видят —
// те проверяют только чистые функции без document/window.
//
// Не запускается автоматически через `node --test` / ./run_tests.sh —
// файл лежит в tests/smoke/ и не подпадает под автообнаружение (проверено:
// оно ищет *.test.js / *-test.js / *_test.js, а не "любой файл в tests/").
// Запуск вручную: node tests/smoke/dom-smoke.js
//
// Стаб покрывает только то, что нужно для одного прохода бутстрапа —
// не считать это заменой настоящего браузера. Если добавляешь функциональность,
// которая трогает DOM API, которого здесь нет (querySelector с реальной
// выборкой, CSSOM, getBoundingClientRect и т.п.), этот тест её не проверит.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');

function makeNode(tag) {
  const node = {
    tagName: tag,
    attrs: {},
    children: [],
    parentNode: null,
    dataset: {},
    nodeType: 1,
    _listeners: {},
    className: '',
    innerHTML: '',
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'id') idRegistry[v] = this;
    },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(evt, fn) { this._listeners[evt] = fn; },
    removeEventListener() {},
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
      return child;
    },
    replaceChild(newChild, oldChild) {
      const i = this.children.indexOf(oldChild);
      if (i !== -1) { this.children[i] = newChild; newChild.parentNode = this; }
      return oldChild;
    },
    get firstChild() { return this.children[0] || null; },
    querySelector() { return null; },   // не нужен вне drag-resize / applyColFilter (не вызываются здесь)
    querySelectorAll() { return []; },
    classList: null
  };
  node.classList = {
    _set: new Set(),
    add(c) { this._set.add(c); },
    remove(c) { this._set.delete(c); },
    toggle(c, force) {
      const on = force === undefined ? !this._set.has(c) : !!force;
      if (on) this._set.add(c); else this._set.delete(c);
      return on;
    },
    contains(c) { return this._set.has(c); }
  };
  return node;
}

const idRegistry = {};

function loadFileSync(relPath) {
  const p = path.join(ROOT, relPath);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

const context = {};
context.window = context;
context.console = console;
context.Set = Set; context.Map = Map; context.Promise = Promise;
context.Blob = function (parts, opts) { this.parts = parts; this.opts = opts; };
context.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
context.FileReader = function () {};
context.alert = (msg) => { console.log('[alert]', msg); };
context.setTimeout = setTimeout;
context.navigator = {};

const localStorageStore = {};
context.localStorage = {
  getItem: (k) => (k in localStorageStore ? localStorageStore[k] : null),
  setItem: (k, v) => { localStorageStore[k] = String(v); },
  removeItem: (k) => { delete localStorageStore[k]; }
};

// sessionStorage -- effects.js::storage читает/пишет именно его (с 0.25.0a1,
// per-tab вместо localStorage). Отдельное хранилище, тот же интерфейс.
const sessionStorageStore = {};
context.sessionStorage = {
  getItem: (k) => (k in sessionStorageStore ? sessionStorageStore[k] : null),
  setItem: (k, v) => { sessionStorageStore[k] = String(v); },
  removeItem: (k) => { delete sessionStorageStore[k]; }
};

// --simulate-crash: имитирует вкладку, у которой прошлый render() не
// досчитал до подтверждённого кадра (renderWatchdog остался true) -- тот же
// сценарий, что настоящий краш браузера на нехватке памяти с последующим
// перезапуском вкладки. Предсёдим и "сохранённый пресет" прошлой попытки,
// чтобы отдельно проверить, что он не затирается при восстановлении.
const SIMULATE_CRASH = process.argv.includes('--simulate-crash');
const POISONED_PRESET = { name: 'big', query: { as_of: null, sources: { CRM: { labels: null } } },
  view: { joins: [], conditions: [], entities: [], column_widths: {} } };
if (SIMULATE_CRASH) {
  sessionStorageStore['ds-webui:renderWatchdog'] = 'true';
  sessionStorageStore['ds-webui:preset'] = JSON.stringify(POISONED_PRESET);
}

// main.js::render вызывает requestAnimationFrame (дважды, вложенно) вокруг
// watchdog-флага крах-защиты -- тут нет реального layout/paint, поэтому
// просто сразу выполняем callback синхронно.
context.requestAnimationFrame = (cb) => { cb(); return 0; };

const appDiv = makeNode('div');
appDiv.setAttribute('id', 'app');
const bodyEl = makeNode('body');
const headEl = makeNode('head');
bodyEl.appendChild(appDiv);

context.document = {
  createElement(tag) { return makeNode(tag); },
  createTextNode(text) { return { nodeType: 3, text: text }; },
  getElementById(id) { return idRegistry[id] || null; },
  head: headEl,
  body: bodyEl
};

// appendChild на <script> с .src (IDL-свойство — так его ставит реальный код,
// НЕ через setAttribute) синхронно "качает" и выполняет файл в том же
// контексте, потом зовёт onload/onerror. Так index.html грузит manifest/источники,
// включая настоящий fallback data/ -> sample-data/ (просто через ENOENT).
function wireScriptLoading(node) {
  const origAppend = node.appendChild.bind(node);
  node.appendChild = function (child) {
    const r = origAppend(child);
    if (child.tagName === 'script' && child.src) {
      const src = loadFileSync(child.src);
      if (src == null) {
        if (child.onerror) child.onerror();
      } else {
        vm.runInContext(src, vmContext, { filename: child.src });
        if (child.onload) child.onload();
      }
    }
    return r;
  };
}

process.on('unhandledRejection', (err) => {
  console.error('FAIL: unhandled rejection во время bootstrap:', err);
  process.exitCode = 1;
});

const vmContext = vm.createContext(context);
wireScriptLoading(context.document.head);
wireScriptLoading(context.document.body);

function run(relPath) {
  const src = loadFileSync(relPath);
  if (src == null) throw new Error('missing ' + relPath);
  vm.runInContext(src, vmContext, { filename: relPath });
}

// 1) инлайновый bootstrap-скрипт из index.html (window.DS / window.__ds),
//    извлечён из самого файла — чтобы не разъезжаться с реальным index.html.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const scriptTags = [...html.matchAll(/<script(?:\s+src="([^"]+)")?>([\s\S]*?)<\/script>/g)];
const inlineScript = scriptTags.find((m) => !m[1] && m[2].trim());
assert.ok(inlineScript, 'inline bootstrap <script> не найден в index.html');
vm.runInContext(inlineScript[2], vmContext, { filename: 'index.html#inline' });

// 2) внешние <script src>, в порядке из index.html — порядок и есть то, что проверяем
const srcScripts = scriptTags.filter((m) => m[1]).map((m) => m[1]);
console.log('script order:', srcScripts.join(', '));
srcScripts.forEach(run);

// 3) дать микротаскам (Promise-цепочки бутстрапа: manifest -> preset -> buildDataset) дойти до конца
setTimeout(() => {
  try {
    const DS_APP = context.DS_APP;
    const expectedExports = [
      'pipe', 'el', 'joinSources', 'matchCondition', 'parseNum', 'parseDate', 'toCsv',
      'createStore', 'reducer', 'normalizePreset', 'opSelect', 'viewNav', 'viewBuild',
      'viewTableShell', 'renderGrid', 'store', 'buildDataset', 'exportXls', 'exportCsv'
    ];
    const missing = expectedExports.filter((k) => typeof DS_APP[k] === 'undefined');
    assert.deepEqual(missing, [], 'отсутствуют экспорты в window.DS_APP: ' + missing.join(', '));

    const state = DS_APP.store.getState();

    if (SIMULATE_CRASH) {
      assert.equal(state.route, 'build', 'после восстановления после краха ожидался «Конструктор»');
      assert.ok(state.buildError && /не хватило памяти/.test(state.buildError),
        'ожидалось пояснение про крах, получено: ' + state.buildError);
      // не assert.deepEqual(..., {}) -- state.preset создан внутри vm-контекста,
      // его Object.prototype -- из другого "реалма", чем {} в этом файле;
      // deepStrictEqual (node:assert/strict) сравнивает и прототип, cross-realm
      // литерал не совпадёт структурно, даже будучи таким же по форме
      assert.equal(Object.keys(state.preset.query.sources).length, 0,
        'после краха ожидался пустой пресет, а не сохранённый: ' + JSON.stringify(state.preset.query.sources));
      assert.equal(sessionStorageStore['ds-webui:renderWatchdog'], 'false', 'watchdog должен быть снят');
      assert.deepEqual(JSON.parse(sessionStorageStore['ds-webui:preset']), POISONED_PRESET,
        'сохранённый (проблемный) пресет не должен затираться при восстановлении');
      console.log('OK: watchdog нашёл незавершённый render -> пустой пресет, сохранённый не тронут');
      console.log('SMOKE TEST (--simulate-crash) PASSED');
    } else {
      assert.equal(state.buildError, null, 'buildError после автосборки пресета по умолчанию: ' + state.buildError);
      assert.equal(state.route, 'table', 'после boot ожидался переход на «Таблицу»');
      assert.ok(state.dataset && state.dataset.rows.length > 0, 'датасет после boot пуст');

      const gridNode = idRegistry['grid'];
      assert.ok(gridNode && gridNode.children.length > 0, 'грид не отрендерился в #grid');

      console.log('OK: bootstrap -> manifest -> preset -> join(CRM,ERP) -> route=table -> renderGrid');
      console.log('    dataset:', state.dataset.rows.length, 'строк,', state.dataset.columns.length, 'колонок');
      console.log('SMOKE TEST PASSED');
    }
  } catch (err) {
    console.error('SMOKE TEST FAILED:', err.message);
    process.exitCode = 1;
  }
}, 50);
