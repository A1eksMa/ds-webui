'use strict';

/*
 * Базовые пресеты, поставляемые с приложением (коммитятся).
 * Пользовательские пресеты — отдельные файлы, скачиваются/загружаются.
 * Формат — см. docs/contract.md (черновой).
 */
window.DS_PRESETS = [
  {
    name: 'base',
    as_of: null,
    sources: {
      CRM: { labels: ['email', 'phone', 'status'], filters: {} },
      ERP: { labels: ['price', 'stock'], filters: {} }
    },
    joins: [
      { left: 'CRM', left_field: 'customer_id', right: 'ERP', right_field: 'client_ref' }
    ]
  }
];
