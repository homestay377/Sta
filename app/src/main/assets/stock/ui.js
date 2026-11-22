/* 股问AI 离线 SVG 图标。忙碌状态由 app.js 的 syncUI() 驱动，避免覆盖旧发送按钮文字。 */
(function () {
  'use strict';
  var paths = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
    back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h9M17 18h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
    sliders: '<path d="M7 4v5m0 4v7M17 4v9m0 4v3"/><rect x="4" y="9" width="6" height="4" rx="2"/><rect x="14" y="13" width="6" height="4" rx="2"/>',
    send: '<path d="m4 4 17 8-17 8 3-8-3-8Z"/><path d="M7 12h14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="3"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v14H7a3 3 0 0 1-3-3V5a1 1 0 0 1 1-1Z"/><path d="M7 16h12M9 8h6M9 11h4"/>',
    chat: '<path d="M19 15a3 3 0 0 1-3 3H9l-5 3V7a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3v8Z"/><path d="M8 9h8M8 13h5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    up: '<path d="m5 14 7-7 7 7"/>',
    down: '<path d="m5 10 7 7 7-7"/>',
    history: '<path d="M4 5v6h6M4 11a8 8 0 1 1 2 7M12 6v6l4 2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z"/>',
    spark: '<path d="m12 3 2 7 7 2-7 2-2 7-2-7-7-2 7-2 2-7Z"/>',
    chart: '<path d="M4 4v16h16M7 16l4-6 3 3 5-7M17 6h2v2"/>',
    check: '<path d="m5 12 4 4 10-10"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'
  };
  function icon(name, cls) {
    return '<svg class="ui-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.info) + '</svg>';
  }
  function outer(el) {
    try {
      var wrap = document.createElement('div');
      wrap.innerHTML = icon(el.getAttribute('data-icon'));
      var svg = wrap.firstChild;
      if (!svg) return;
      var extra = el.getAttribute('data-extra');
      if (extra) svg.insertAdjacentHTML('beforeend', '<span class="icon-txt">' + extra + '</span>');
      // 占位 span 可能是空的（例如搜索框），此时 firstChild 为 null，
      // replaceChild 会抛错并中断整个图标初始化 —— 必须单独判空。
      if (el.firstChild) el.replaceChild(svg, el.firstChild);
      else el.appendChild(svg);
    } catch (e) { console.warn('图标替换失败', el && el.getAttribute('data-icon'), e); }
  }
  function init() {
    try {
      var es = document.querySelectorAll('[data-icon]');
      for (var i = 0; i < es.length; i++) outer(es[i]);   // 每个元素内部各自容错
      // 只在主题栏刚被更新时补图标；原 drawer.js 负责事件，不重复绑定。
      syncTheme();
      var send = document.getElementById('aiSend');
      if (send && !send.querySelector('.ui-icon')) {
        // 两枚图标都在 DOM 里，由 .busy class 决定显示哪一枚；
        // 这样状态切换不需要重写 innerHTML，也不会和旧文字兜底打架。
        send.innerHTML = '<span class="btn-label">发送</span>'
          + icon('send', 'icon-send') + icon('stop', 'icon-stop');
      }
    } catch (e) { console.error('UI 图标初始化失败', e); }
  }
  function syncTheme() {
    try {
      if (!window.__app || !window.StockUI) return;
      var row = document.querySelector('#drTheme .drawer-entry');
      if (!row) return;
      var light = window.__app.resolvedTheme() === 'light';
      var old = row.querySelectorAll('svg.iconify-helper');
      for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
      var svg = window.StockUI.icon(light ? 'sun' : 'moon', 'iconify-helper');
      row.insertAdjacentHTML('afterbegin', svg);
      var txt = document.getElementById('drThemeTxt');
      if (txt) txt.textContent = light ? '切换到深色' : '切换到浅色';
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
  window.StockUI = { icon: icon, syncTheme: syncTheme };
})();
