'use strict';

/*
 * Базовые пресеты, поставляемые с приложением (коммитятся).
 * Пользовательские пресеты — отдельные .json, скачиваются / загружаются.
 *
 * Форма (см. docs/contract.md):
 *   { name, query: { as_of, sources: { <src>: { labels: [...] } } },
 *            view:  { joins: [ { left, left_field, right, right_field } ],
 *                     column_filters: { <column>: <substring> } } }
 *
 * `query` — то, что понимает `ds get` (срез данных). `view` — только для UI
 * (межисточниковый LEFT JOIN, базовые фильтры).
 */
window.DS_PRESETS = [
  {
    name: 'base',
    query: {
      as_of: null,
      // ключевой показатель источника — обычное поле в списке; здесь он выбран
      sources: {
        CRM: { labels: ['customer_id', 'email', 'phone', 'status'] },
        ERP: { labels: ['price', 'stock'] }
      }
    },
    view: {
      joins: [
        { left: 'CRM', left_field: 'customer_id', right: 'ERP', right_field: 'client_ref' }
      ],
      column_filters: {}
    }
  }
];
