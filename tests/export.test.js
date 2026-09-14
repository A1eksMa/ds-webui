'use strict';

// Тесты выгрузки в CSV/Excel и построения имени файла. Запуск: node --test.

const test = require('node:test');
const assert = require('node:assert/strict');
const App = require('../export.js');

test('toCsv: экранирует запятую и кавычки', () => {
  const dataset = { rows: [{ a: 'x,y', b: 'z' }] };
  assert.equal(App.toCsv(dataset, ['a', 'b']), 'a,b\r\n"x,y",z');
});

test('xmlEsc: экранирует спецсимволы XML', () => {
  assert.equal(App.xmlEsc('A&B <tag> "q"'), 'A&amp;B &lt;tag&gt; &quot;q&quot;');
});

test('sanitizeAuthor: заменяет запрещённые символы, пустое -> user', () => {
  assert.equal(App.sanitizeAuthor('  John Doe/Corp '), 'John-Doe-Corp');
  assert.equal(App.sanitizeAuthor(''), 'user');
  assert.equal(App.sanitizeAuthor(null), 'user');
});

test('exportFilename: детерминированное имя по неймингу ds-loader', () => {
  const when = new Date(2024, 1, 5, 3, 4, 5, 6); // 2024-02-05 03:04:05.006 (локальное)
  assert.equal(App.exportFilename('Alice', 'csv', when), 'Alice_2024-02-05_03-04-05_006000.csv');
});
