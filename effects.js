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

  var storage = {
    get: function (key) {
      try { return JSON.parse(localStorage.getItem('ds-webui:' + key)); }
      catch (e) { return null; }
    },
    set: function (key, value) {
      try { localStorage.setItem('ds-webui:' + key, JSON.stringify(value)); }
      catch (e) { /* приватное окно / отключено — best-effort */ }
    }
  };

  var api = {
    loadSourceScript: loadSourceScript, download: download, readFile: readFile,
    pasteFromClipboard: pasteFromClipboard, storage: storage
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, api);
  }
})(typeof window !== 'undefined' ? window : this);
