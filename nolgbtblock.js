/*
 * Lampa: вимикає регіональний блок «Контент ограничен» (ЛГБТ-фільтр).
 *
 * З 10.11.2026 Lampa блокує картки, якщо регіон визначено як ru/by.
 * Регіон береться з geo.<cub-домен>; якщо домен не відповідає,
 * за замовчуванням ставиться 'ru' — тож блок спрацьовує й в Україні.
 * Обидві перевірки (ключові слова + список) потребують
 * window.lampa_settings.lgbt — плагін не дає його заповнити.
 */
(function () {
  'use strict';

  function patch() {
    var s = window.lampa_settings || (window.lampa_settings = {});
    try {
      var d = Object.getOwnPropertyDescriptor(s, 'lgbt');
      if (!d || !d.get || !d.get.__nolgbt) {
        var getter = function () { return undefined; };
        getter.__nolgbt = true;
        Object.defineProperty(s, 'lgbt', {
          get: getter,
          set: function () {},
          configurable: true
        });
      }
    } catch (e) {
      try { s.lgbt = undefined; } catch (e2) {}
    }
    try { if (window.Lampa && Lampa.Storage) Lampa.Storage.set('lgbt_content_block', false); } catch (e) {}
  }

  patch();

  if (window.Lampa && Lampa.Listener) {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') patch();
    });
  }
})();
