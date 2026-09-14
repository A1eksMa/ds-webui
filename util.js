'use strict';

// Мелкие функциональные утилиты + hyperscript. Не зависит от других модулей —
// самый нижний слой. См. docs/contract.md и README «Разработка» про сборку
// модулей в браузере (<script> по порядку → общий window.DS_APP) и в Node
// (node:test → require(), см. tests/).
(function (root) {

  var pipe = function () {
    var fns = [].slice.call(arguments);
    return function (x) { return fns.reduce(function (v, f) { return f(v); }, x); };
  };

  var uniq = function (xs) { return Array.from(new Set(xs)); };

  var groupBy = function (keyFn) {
    return function (xs) {
      return xs.reduce(function (acc, x) {
        var k = keyFn(x);
        (acc[k] = acc[k] || []).push(x);
        return acc;
      }, Object.create(null));
    };
  };

  // неглубокое обновление по пути: setIn({a:{b:1}}, ['a','b'], 2)
  var setIn = function (obj, path, value) {
    if (!path.length) return value;
    var k = path[0];
    var next = obj && typeof obj === 'object' ? obj[k] : undefined;
    var patch = {};
    patch[k] = setIn(next === undefined ? {} : next, path.slice(1), value);
    return Object.assign({}, obj, patch);
  };

  var omit = function (obj, key) {
    var out = Object.assign({}, obj);
    delete out[key];
    return out;
  };

  var fmtDate = function (ts) {
    if (ts == null) return '—';
    var d = new Date(ts * 1000);
    return isNaN(d) ? String(ts) : d.toISOString().slice(0, 16).replace('T', ' ');
  };

  // неглубокая перестановка двух элементов массива (иммутабельно)
  var _swap = function (arr, i, j) {
    if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return arr;
    var out = arr.slice(); var t = out[i]; out[i] = out[j]; out[j] = t; return out;
  };

  // hyperscript: el('div', {class:'x', onclick:fn}, child, [children])
  var el = function (tag, attrs) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    });
    [].slice.call(arguments, 2).forEach(function append(kid) {
      if (kid == null || kid === false) return;
      if (Array.isArray(kid)) return kid.forEach(append);
      node.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
    });
    return node;
  };

  var clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  var api = {
    pipe: pipe, uniq: uniq, groupBy: groupBy, setIn: setIn, omit: omit, fmtDate: fmtDate,
    _swap: _swap, el: el, clear: clear
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, api);
  }
})(typeof window !== 'undefined' ? window : this);
