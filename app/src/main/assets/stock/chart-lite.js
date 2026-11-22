/* Eta 问股 · 图表模式精简。
 *
 * 目标：面板只占屏幕 1/3，顶栏 + 行情卡 + 周期条 + 指标条不能吃掉一半图高。
 * 这里做四件事：
 *
 *   1. 顶栏整块删除，☰ 挪到行情卡行首 —— 顶栏是 Grid 里的一个 item，
 *      只搬走里面的节点仍然占一行高度，必须整块拿掉。
 *   2. 行情卡并进周期条那一行（缩小成行内胶囊）。
 *   3. 搜索框做成按钮弹出的浮层：行情卡右侧一个放大镜，点了才出现输入框，
 *      平时不占任何高度。复用原有的 #searchInput / #suggest，事件不用重绑。
 *   4. 指标条压成一行高度。
 *
 * 所有改动都限定在 ?mode=chart（只有 Eta 面板会带这个参数），
 * 完整页面的形态不受影响。
 */
(function () {
  if (!/[?&]mode=chart/.test(location.search)) return;

  // 脚本放在 body 末尾、且模板里已有 inline script 调过 document.write，
  // 依赖 DOMContentLoaded 可能永远不触发（readystatechange 早已结束）。
  // 这里直接跑：此刻 index.html 的节点已全部解析完毕。
  (function () {
    var root = document.documentElement;
    root.setAttribute('data-mode', 'chart');

    var topbar = document.querySelector('.topbar');
    var quote = document.querySelector('.quote-card');
    var searchBox = document.querySelector('.topbar .searchbox');
    var drawerBtn = document.getElementById('btnDrawer');

    /* ---------- 1. ☰ 并进行情卡，整条顶栏移除 ---------- */
    if (topbar && quote) {
      var qLine = quote.querySelector('.q-line') || quote;
      if (drawerBtn) {
        drawerBtn.classList.add('menu-inline');
        // firstChild 可能为 null（空行），那时 insertBefore 会退化成 append，
        // ☰ 就会跑到行尾。所以显式取第一个元素节点，没有就 prepend。
        var first = qLine.firstElementChild || qLine.firstChild;
        if (first) qLine.insertBefore(drawerBtn, first);
        else if (qLine.prepend) qLine.prepend(drawerBtn);
        else qLine.appendChild(drawerBtn);
      }
      if (topbar.parentNode) topbar.parentNode.removeChild(topbar);
    }

    /* ---------- 2. 搜索按钮 + 浮层 ---------- */
    var btnSearch = document.getElementById('btnSearch');
    if (btnSearch && searchBox) {
      searchBox.classList.add('chart-search-inner');
      searchBox.style.display = 'block';

      var overlay = document.createElement('div');
      overlay.className = 'chart-search-overlay hidden';
      var maskEl = document.createElement('div');
      maskEl.className = 'chart-search-mask';
      var boxEl = document.createElement('div');
      boxEl.className = 'chart-search-box';
      overlay.appendChild(maskEl);
      overlay.appendChild(boxEl);
      document.body.appendChild(overlay);

      boxEl.appendChild(searchBox);

      var input = document.getElementById('searchInput');
      var suggest = document.getElementById('suggest');

      function openSearch() {
        overlay.classList.remove('hidden');
        if (input) {
          input.value = '';
          setTimeout(function () { input.focus(); }, 30);
        }
      }

      function closeSearch() {
        overlay.classList.add('hidden');
        if (input) input.blur();
        if (suggest) suggest.classList.add('hidden');
      }

      // 直接绑 + 委托双保险：按钮可能被容器重建、也可能被别的脚本接管点击，
      // 两条路都能开搜索层，不会出现“点了没反应”。
      btnSearch.addEventListener('click', function (e) {
        e.preventDefault();
        openSearch();
      });
      document.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.closest && t.closest('#btnSearch')) {
          e.preventDefault();
          openSearch();
        }
      }, true);
      maskEl.addEventListener('click', closeSearch);
      // 从候选里点中一只股票后自动收起（页面自己的 click 先跑，这里只负责收尾）
      if (suggest) {
        suggest.addEventListener('click', function () {
          if (input) input.blur();
          setTimeout(closeSearch, 80);
        });
      }
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeSearch();
      });
    } else if (searchBox) {
      // 没有按钮就先藏起来，绝不留下占位
      searchBox.style.display = 'none';
    }

    /* ---------- 3. 行情卡并进周期条那一行 ---------- */
    var periodBar = document.getElementById('periodBar');
    if (quote && periodBar && periodBar.parentNode) {
      quote.classList.add('quote-inline');
      periodBar.parentNode.insertBefore(quote, periodBar);
    }

    /* ---------- 4. 指标条压成一行 ---------- */
    var indbar = document.getElementById('indBar');
    if (indbar) {
      var divider = indbar.querySelector('.indbar-divider');
      if (divider) divider.style.display = 'none';
    }

    /* ---------- 5. 超紧凑模式：面板被拖到很矮时，只留 K 线 ---------- *
     *
     * 面板只剩「主图」这么大的时候，顶部那几行（行情卡 / 周期条 / 指标条）
     * 会把本来就不多的图高再吃掉一截，主图就真的没法看了。
     *
     * 这里对外暴露一个开关：Kotlin 那边按面板高度决定要不要进入 compact，
     * 进入后把这些栏隐藏；股票名称、周期、涨跌幅已经在折叠条上了，信息不丢。
     */
    function setCompact(on) {
      var v = !!on;
      if (root.getAttribute('data-compact') === (v ? '1' : '0')) return;
      root.setAttribute('data-compact', v ? '1' : '0');
      // 会让图表可用高度变化，重算一次
      setTimeout(function () {
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        try {
          if (window.__app && window.__app.chart) {
            var c = window.__app.chart();
            if (c && c.render) c.render();
          }
        } catch (e) {}
      }, 30);
    }
    window.__setChartCompact = setCompact;

    /* ---------- 6. 布局变矮了，重算图表尺寸 ---------- */
    setTimeout(function () {
      try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      try {
        if (window.__app && window.__app.chart) {
          var c = window.__app.chart();
          if (c && c.render) c.render();
        }
      } catch (e) {}
    }, 60);
  })();
})();