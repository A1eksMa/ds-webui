'use strict';

// Выгрузка в CSV / SpreadsheetML (Excel .xls) и построение имени файла.
// Не зависит от других модулей — только строковые преобразования.
(function (root) {

  var toCsv = function (dataset, columns) {
    var cell = function (v) {
      var s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [columns.map(cell).join(',')]
      .concat(dataset.rows.map(function (r) {
        return columns.map(function (c) { return cell(r[c]); }).join(',');
      }))
      .join('\r\n');
  };

  var xmlEsc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // Одна строка <Row> SpreadsheetML. Пустая ячейка — <Cell/> (позицию столбца
  // держит сама, ss:Index не нужен). Тип всегда String: office-пакет не приведёт
  // "007" / "99.00" к числу при открытии. styleId — общий стиль ячеек строки
  // (перенос по словам, выравнивание по верху; для шапки ещё и жирный).
  var xlsRow = function (values, styleId) {
    var sid = styleId ? ' ss:StyleID="' + styleId + '"' : '';
    return '    <Row>' + values.map(function (v) {
      return (v == null || v === '')
        ? '<Cell' + sid + '/>'
        : '<Cell' + sid + '><Data ss:Type="String">' + xmlEsc(v) + '</Data></Cell>';
    }).join('') + '</Row>';
  };

  // Один настоящий лист SpreadsheetML: имя вкладки = name, шапка + строки данных.
  // opts: {selected, hidden, protect}. widthsPt — ширины столбцов в пунктах
  // (пропорции — как на странице «Таблица»); AutoFitWidth=0 → Excel их не пересчитает.
  var xlsWorksheet = function (name, dataset, columns, opts, widthsPt) {
    var cols = (widthsPt || []).map(function (w) {
      return '    <Column ss:AutoFitWidth="0" ss:Width="' + Number(w) + '"/>';
    });
    var rows = [xlsRow(columns, 'hdr')].concat(dataset.rows.map(function (r) {
      return xlsRow(columns.map(function (c) { return r[c]; }), 'cell');
    }));
    var wo = [];
    if (opts.selected) { wo.push('     <Selected/>'); }
    if (opts.hidden) { wo.push('     <Visible>SheetHidden</Visible>'); }
    if (opts.protect) {
      // Пустой пароль: защита включена, снимается без пароля.
      wo.push('     <ProtectContents>True</ProtectContents>');
      wo.push('     <ProtectObjects>True</ProtectObjects>');
      wo.push('     <ProtectScenarios>True</ProtectScenarios>');
    }
    var table = ['   <Table>']
      .concat(cols.length ? cols : [])
      .concat([rows.join('\n'), '   </Table>']);
    return [
      '  <Worksheet ss:Name="' + xmlEsc(name) + '"' + (opts.protect ? ' ss:Protected="1"' : '') + '>'
    ].concat(table).concat([
      '   <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">',
      wo.join('\n'),
      '   </WorksheetOptions>',
      '  </Worksheet>'
    ]).join('\n');
  };

  // Книга SpreadsheetML 2003 (Excel XML, расширение .xls) — два настоящих листа
  // с одинаковыми данными: "user" (видимый, активный) и "system" (скрытый и
  // защищённый от изменений, пустой пароль). Именованные вкладки открывают и
  // настольный Microsoft Excel, и LibreOffice / AlterOffice; скрытие и защиту
  // листа последние могут не применять — тогда это два обычных листа
  // "user" / "system". Без библиотек.
  // widthsPt — ширины столбцов в пунктах (пропорции — как на «Таблице»).
  var toXlsWorkbook = function (dataset, columns, widthsPt) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?mso-application progid="Excel.Sheet"?>',
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
      '          xmlns:o="urn:schemas-microsoft-com:office:office"',
      '          xmlns:x="urn:schemas-microsoft-com:office:excel"',
      '          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
      ' <Styles>',
      '  <Style ss:ID="cell"><Alignment ss:Vertical="Top" ss:WrapText="1"/></Style>',
      '  <Style ss:ID="hdr"><Alignment ss:Vertical="Top" ss:WrapText="1"/><Font ss:Bold="1"/></Style>',
      ' </Styles>',
      xlsWorksheet('user', dataset, columns, { selected: true }, widthsPt),
      xlsWorksheet('system', dataset, columns, { hidden: true, protect: true }, widthsPt),
      '</Workbook>'
    ].join('\n');
  };

  // Имя выгружаемого файла — по тому же неймингу, что и файлы, которые мониторит
  // ds-loader: <source>_YYYY-MM-DD_HH-MM-SS_<micros>.<ext>. В роли <source> —
  // нейтральное "export" (поле для кастомного имени было в UI, убрано — браузер
  // всё равно не может отдать имя пользователя ОС). Время — локальное, как у
  // продьюсера (datetime.now()); микросекунды = миллисекунды, дополненные нулями.
  var pad = function (n, width) {
    var s = String(n);
    while (s.length < (width || 2)) { s = '0' + s; }
    return s;
  };

  var sanitizeAuthor = function (name) {
    var s = String(name == null ? '' : name).trim()
      .replace(/[_\s\/\\:*?"<>|]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'export';
  };

  var exportFilename = function (author, ext, when) {
    var d = when || new Date();
    var ts = pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
      + '_' + pad(d.getMilliseconds() * 1000, 6);
    return sanitizeAuthor(author) + '_' + ts + '.' + ext;
  };

  var api = {
    toCsv: toCsv, xmlEsc: xmlEsc, xlsRow: xlsRow, xlsWorksheet: xlsWorksheet,
    toXlsWorkbook: toXlsWorkbook, pad: pad, sanitizeAuthor: sanitizeAuthor,
    exportFilename: exportFilename
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.DS_APP = root.DS_APP || {};
    Object.assign(root.DS_APP, api);
  }
})(typeof window !== 'undefined' ? window : this);
