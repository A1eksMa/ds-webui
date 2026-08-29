'use strict';

/*
 * ds-webui — каркас.
 *
 * Архитектура (см. README.md и docs/contract.md):
 *   - Без сервера. Всё клиентски, поверх снапшота, загруженного в window.DS.
 *   - manifest.js грузится всегда (маленький): список источников + их колонки + свежесть.
 *   - Файлы источников (data/<Source>.js) подгружаются динамической инъекцией <script>
 *     по активному пресету — из file:// это работает, fetch() — нет.
 *   - Связь с ядром ds — только через формат файлов, не через схему БД.
 *
 * Что предстоит реализовать:
 *   1. Конструктор: выбор источников/показателей из манифеста, связки (LEFT JOIN),
 *      фильтры, дата среза; сериализация в пресет; скачивание/загрузка пресета.
 *   2. Загрузка выбранных источников (injectSource), LEFT JOIN в памяти по ключу.
 *   3. Страница таблицы: рендер, зона фильтров, сворачивание, экспорт в Excel
 *      (xlsx = zip из XML, либо HTML-таблица с расширением .xls — без внешних библиотек).
 *   4. Бейдж устаревания: manifest.db_max_cnt vs source.gen_max_cnt.
 */

const DATA_DIR = 'data';

function injectSource(fileName) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${DATA_DIR}/${fileName}`;
    s.onload = () => resolve(fileName);
    s.onerror = () => reject(new Error(`не загружен: ${fileName}`));
    document.head.appendChild(s);
  });
}

function currentPage() {
  return (location.hash === '#table') ? 'table' : 'build';
}

function render() {
  const page = currentPage();
  document.getElementById('page-build').classList.toggle('active', page === 'build');
  document.getElementById('page-table').classList.toggle('active', page === 'table');

  const manifest = window.DS_MANIFEST || null;
  const mv = document.getElementById('manifest-view');
  if (!manifest) {
    mv.innerHTML = '<p class="muted">data/manifest.js не найден — запусти <code>ds get</code>.</p>';
    return;
  }
  mv.innerHTML = '<h2>Доступные источники</h2><ul>' + manifest.sources.map(s =>
    `<li><strong>${s.name}</strong> — ${s.rows} строк, срез на ${new Date(s.as_of * 1000).toISOString().slice(0, 10)}, ` +
    `колонки: ${s.labels.join(', ')}</li>`
  ).join('') + '</ul>';
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);
