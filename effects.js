'use strict';

// Эффекты: загрузка файла источника, скачивание, чтение файла/буфера обмена,
// localStorage. Не зависит от других модулей. Не тестируется под node:test —
// все функции здесь требуют браузерных API (document/Blob/FileReader/...).
(function (root) {

  // Инъекция <script src="<dir>/<file>">; резолвится, когда window.DS.sources[name] появился.
  var loadSourceScript = function (dir, file, name) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = dir + '/' + file;
      s.onload = function () {
        window.DS.sources[name] ? resolve(name) : reject(new Error(name));
      };
      s.onerror = function () { reject(new Error(name)); };
      document.head.appendChild(s);
    });
  };

  // Инъекция <script src="<dir>/<file>">, резолвится значением window[globalName] после
  // загрузки (сначала сбрасывает его в undefined -- чтобы отсутствие файла не унаследовало
  // значение от предыдущего успешного вызова с тем же именем глобала). Отсутствие файла
  // (onerror) -- не ошибка, резолвится в null; вызывающий сам решает, что это значит.
  var loadGlobal = function (dir, file, globalName) {
    return new Promise(function (resolve) {
      window[globalName] = undefined;
      var s = document.createElement('script');
      s.src = dir + '/' + file;
      s.onload = function () { resolve(window[globalName] !== undefined ? window[globalName] : null); };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
  };

  // data/manifest.js -- см. docs/contract.md. null, если файла нет/не загрузился (вызывающий
  // решает, что дальше: фоллбэк на sample-data при первом старте, явная ошибка при смене
  // каталога пользователем).
  var loadManifest = function (dir) { return loadGlobal(dir, 'manifest.js', 'DS_MANIFEST'); };

  // data/manifest.imports.js -- индекс имён доп. файлов-фрагментов манифеста (зарезервировано
  // под отдельные источники вне основного manifest.js -- см. docs/contract.md "Кто читает и
  // кто пишет манифест"; сегодня никто такие файлы не производит, но ds-webui их уже умеет
  // читать). Каждый файл из списка грузится ПО ОЧЕРЕДИ, не параллельно -- все они пишут в
  // один и тот же временный window.DS_MANIFEST_FRAGMENT, параллельные загрузки гонялись бы
  // друг с другом за него. Отсутствующий индекс или отдельный фрагмент -- не ошибка, просто
  // пропускается.
  var loadManifestFragments = function (dir) {
    return loadGlobal(dir, 'manifest.imports.js', 'DS_MANIFEST_IMPORTS').then(function (files) {
      return (files || []).reduce(function (chain, file) {
        return chain.then(function (acc) {
          return loadGlobal(dir, file, 'DS_MANIFEST_FRAGMENT').then(function (frag) {
            if (frag) acc.push(frag);
            return acc;
          });
        });
      }, Promise.resolve([]));
    });
  };

  var download = function (filename, text, mime) {
    var blob = new Blob(['﻿', text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  var readFile = function (file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsText(file);
    });
  };

  // Прочитать текст из буфера обмена (нужен жест пользователя + разрешение).
  // При отказе/недоступности — уведомить и дать вставить вручную (Ctrl+V).
  var pasteFromClipboard = function (cb) {
    var fail = function () {
      alert('Не удалось прочитать буфер обмена. Вставьте список вручную (Ctrl+V) в поле.');
    };
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) { if (t && t.trim()) cb(t); }, fail);
    } else {
      fail();
    }
  };

  // sessionStorage, НЕ localStorage -- намеренно: до этого сохранённый
  // пресет/настройки были общими на весь file://-источник, то есть вторая
  // открытая вкладка подхватывала то же самое (нельзя было держать два разных
  // пресета в двух вкладках одновременно), а если сохранённый пресет на
  // большом датасете вызывал у браузера нехватку памяти и перезапуск вкладки
  // -- тот же пресет применялся заново на каждой попытке, цикл перезапуска
  // без возможности выйти. sessionStorage привязан к конкретной вкладке
  // (рестор той же вкладки после краха его переживает -- см. main.js::render
  // про watchdog, который ловит именно этот случай отдельно; но НОВАЯ вкладка
  // начинает с чистого sessionStorage, то есть с дефолтного пресета).
  var storage = {
    get: function (key) {
      try { return JSON.parse(sessionStorage.getItem('ds-webui:' + key)); }
      catch (e) { return null; }
    },
    set: function (key, value) {
      try { sessionStorage.setItem('ds-webui:' + key, JSON.stringify(value)); }
      catch (e) { /* приватное окно / отключено — best-effort */ }
    }
  };

  var api = {
    loadSourceScript: loadSourceScript, download: download, readFile: readFile,
    pasteFromClipboard: pasteFromClipboard, storage: storage,
    loadGlobal: loadGlobal, loadManifest: loadManifest, loadManifestFragments: loadManifestFragments
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, api);
  }
})(typeof window !== 'undefined' ? window : this);
