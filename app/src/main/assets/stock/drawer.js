/**
 * 左侧抽屉：搜索 / 自选 / 会话 / 知识库与设置入口。
 *
 * v5.0 的变化：
 *   · 搜索框从顶栏搬到这里 —— 顶栏只留行情，不再和输入框抢位置
 *   · 自选股列表搬进来（由 groups.js 画成分组可折叠的列表）
 *   · 原来底部的两个入口保留，但「设置」的 id 改成 btnSettings（代码与测试都用它）
 *   · 会话列表只显示最近几条，完整的进「全部会话」二级页
 *
 * 删除仍然是两步确认：WebView 里 window.confirm 不一定弹得出来，
 * 所以第一下把按钮变成「?」，第二下才真删，不依赖原生对话框。
 */
(function () {
  'use strict';

  var app = window.__app;
  var el = {};
  var open = false;
  var sessions = [];
  var pendingDel = '';
  var RECENT_N = 5;

  function $(id) {
    if (!el[id]) el[id] = document.getElementById(id);
    return el[id];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    if (sameDay) return hh + ':' + mm;
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hh + ':' + mm;
  }

  function renderSessions() {
    var box = $('drSessions');
    if (!box) return;
    var cur = app.currentCode();

    // 当前股票永远在最前：即使它还没落盘（新股票、没聊过）
    var list = sessions.slice();
    if (cur && !list.some(function (s) { return s.code === cur; })) {
      list.unshift({ code: cur, name: app.currentName(), updatedAt: Date.now(), count: 0, _cur: true });
    }
    list = list.slice(0, RECENT_N);

    if (!list.length) {
      box.innerHTML = '<div class="dr-empty">还没有会话<br>搜一只股票、问一句就开一条</div>';
      return;
    }

    box.innerHTML = list.map(function (s) {
      var on = (s.code === cur) ? ' on' : '';
      var meta = [];
      if (s.count) meta.push(s.count + ' 条');
      if (s.updatedAt) meta.push(fmtTime(s.updatedAt));
      if (!meta.length) meta.push('新会话');
      var del = (s.code === cur || s.count)
        ? '<button class="dr-item-del" data-del="' + esc(s.code) + '" title="删除会话">✕</button>' : '';
      return '<div class="dr-item' + on + '" data-code="' + esc(s.code) + '" data-name="' + esc(s.name || '') + '">'
        + '<div class="dr-item-main">'
        + '<div class="dr-item-name">' + esc(s.name || s.code) + '</div>'
        + '<div class="dr-item-meta">' + esc(s.code) + ' · ' + esc(meta.join(' · ')) + '</div>'
        + '</div>' + del + '</div>';
    }).join('');
  }

  function refresh() {
    // 图表模式下不加载 sessions.js（会话属于 Eta 本体），这里直接返回空。
    if (!window.Sessions) return Promise.resolve([]);
    return window.Sessions.list().then(function (list) {
      sessions = list || [];
      renderSessions();
      updateKbBadge();
      return sessions;
    });
  }

  function updateKbBadge() {
    var b = $('drKbCount');
    if (!b) return;
    Promise.all([
      app.callNative('fsList', 'skills').catch(function () { return '[]'; }),
      app.callNative('fsRead', 'worldbook.json').catch(function () { return '[]'; })
    ]).then(function (r) {
      var sk = [];
      try { sk = JSON.parse(r[0] || '[]'); } catch (e) {}
      var wb = [];
      try { wb = JSON.parse(r[1] || '[]'); } catch (e) {}
      var n = sk.filter(function (x) { return x && /\.md$/i.test(x.name || ''); }).length;
      var m = Array.isArray(wb) ? wb.length : 0;
      b.textContent = 'skill ' + n + ' · 世界书 ' + m;
    });
  }

  function refreshTheme() {
    var t = $('drThemeTxt');
    if (t && app.themeLabel) t.textContent = app.themeLabel();
  }

  function show() {
    if (open) return;
    refreshTheme();
    open = true;
    $('drawerMask').classList.remove('hidden');
    // 先让元素参与布局再加 open，否则 transition 不触发
    $('drawer').classList.add('open');
    try { app.renderWatchlist(); } catch (e) { console.warn('pane', e); }
    refresh();
  }

  function hide() {
    if (!open) return;
    open = false;
    pendingDel = '';
    $('drawerMask').classList.add('hidden');
    $('drawer').classList.remove('open');
  }

  function toggle() { open ? hide() : show(); }

  function onItemClick(e) {
    var del = e.target.closest && e.target.closest('[data-del]');
    var item = e.target.closest && e.target.closest('.dr-item');
    if (!item) return;

    // ---- 删除：两步确认 ----
    if (del) {
      var code = del.getAttribute('data-del');
      if (pendingDel !== code) {
        pendingDel = code;
        del.textContent = '?';
        del.style.color = '#ff8080';
        setTimeout(function () {
          if (pendingDel === code) {
            pendingDel = '';
            if (del.textContent === '?') { del.textContent = '✕'; del.style.color = ''; }
          }
        }, 2600);
        return;
      }
      pendingDel = '';
      window.Sessions.remove(code).then(function () {
        if (code === app.currentCode()) app.clearConversation();
        refresh();
      });
      return;
    }

    // ---- 切换会话 ----
    var c = item.getAttribute('data-code');
    var n = item.getAttribute('data-name') || '';
    if (!c) return;
    if (c === app.currentCode()) { hide(); return; }
    hide();
    app.switchStock(c, n);
  }

  function bind() {
    var btn = $('btnDrawer');
    if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    var close = $('drClose');
    if (close) close.addEventListener('click', hide);
    var mask = $('drawerMask');
    if (mask) mask.addEventListener('click', hide);
    var box = $('drSessions');
    if (box) box.addEventListener('click', onItemClick);

    var all = $('drAllSessions');
    if (all) all.addEventListener('click', function () {
      hide();
      if (app.openPage) app.openPage('pageSessions');
    });

    var kb = $('drKnowledge');
    if (kb) kb.addEventListener('click', function () {
      hide();
      if (window.Knowledge && window.Knowledge.open) window.Knowledge.open();
      else app.setSheetHint('知识库界面还没就绪', 2600);
    });

    // 主题快捷开关：点一下翻转（三选一在设置页的「外观」里）
    var th = $('drTheme');
    if (th) th.addEventListener('click', function () {
      if (app.cycleTheme) app.cycleTheme();
      refreshTheme();
    });
  }

  window.Drawer = {
    init: bind,
    refreshTheme: refreshTheme,
    show: show,
    hide: hide,
    toggle: toggle,
    refresh: refresh,
    isOpen: function () { return open; },
    _render: renderSessions,
    _sessions: function () { return sessions; }
  };
})();
