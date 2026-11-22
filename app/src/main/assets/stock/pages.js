/**
 * 二级页路由 + 会话页 + 设置页里跟数据有关的部分。
 *
 * 设计依据（参考应用的做法）：
 *   · 全屏页面，而不是弹窗 —— 弹窗要用户记住"点哪里关"，页面只要一个 ← 和返回手势
 *   · 页面任意位置横移即可返回上一页
 *   · 危险操作写明后果，并给 5 秒撤销
 *   · 列表按时间分组（今天 / 昨天 / 更早），空态直接说下一步该干什么
 *
 * 返回键统一走 __app.back() → Page.back()，顺序由 app.js 里的 back() 定。
 */
(function () {
  'use strict';

  var app = window.__app;
  var stack = [];              // 已打开的页面 id，栈顶在最前
  var pendingDel = '';         // 会话页里等待二次确认的 code
  var lastDeleted = null;      // {code, name, data} 用于撤销
  var undoTimer = null;
  var kw = '';                 // 会话搜索关键词

  function $(id) { return document.getElementById(id); }
  function esc(s) { return app.esc(s); }
  function el(id) { return document.getElementById(id); }

  // ==================== 路由 ====================

  function isOpen() { return stack.length > 0; }
  function current() { return stack.length ? stack[stack.length - 1] : null; }

  function open(id) {
    var e = el(id);
    if (!e) return false;
    if (current() === id) return true;
    stack.push(id);
    e.classList.remove('hidden');
    try { e.style.transform = ''; } catch (err) {}
    if (id === 'pageSessions') renderSessions();
    if (id === 'settingsModal') { try { app.fillAbout(); fillDataNote(); } catch (err) {} }
    return true;
  }

  function close(id) {
    var i = (id === undefined) ? stack.length - 1 : stack.indexOf(id);
    if (i < 0) return false;
    var pid = stack[i];
    stack.splice(i, 1);
    var e = el(pid);
    if (e) e.classList.add('hidden');
    return true;
  }

  function back() {
    if (!stack.length) return false;
    close();
    return true;
  }

  // ==================== 会话页 ====================

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var hh = ('0' + d.getHours()).slice(-2);
    var mm = ('0' + d.getMinutes()).slice(-2);
    return hh + ':' + mm;
  }

  /** 今天 / 昨天 / 更早：会话一多，一长串等权列表很难扫 */
  function bucket(ts) {
    if (!ts) return '更早';
    var d = new Date(ts);
    var now = new Date();
    var d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= d0) return '今天';
    if (ts >= d0 - 86400000) return '昨天';
    return '更早';
  }

  function renderSessions() {
    var box = $('sessBody');
    if (!box || !window.Sessions) return;
    box.innerHTML = '<div class="kb-loading">读取中…</div>';

    window.Sessions.list().then(function (list) {
      var cur = app.currentCode();
      var all = (list || []).slice();
      if (cur && !all.some(function (s) { return s.code === cur; })) {
        all.unshift({ code: cur, name: app.currentName(), updatedAt: Date.now(), count: 0 });
      }

      var q = kw.trim().toLowerCase();
      window.Page._cache = all;      // 给「更多选项」面板取条数用
      var shown = all.filter(function (s) {
        if (!q) return true;
        return String(s.name || '').toLowerCase().indexOf(q) >= 0
          || String(s.code || '').toLowerCase().indexOf(q) >= 0;
      });

      if (!shown.length) {
        box.innerHTML = '<div class="kb-empty"><div class="kb-empty-t">'
          + (q ? '没有匹配的会话' : '还没有会话')
          + '</div><div class="kb-empty-d">'
          + (q ? '换个股票名或代码再试。' : '在行情页问一句，就会为那只股票建一条会话；一只股票一条，翻回来就能看到上次聊到哪。')
          + '</div></div>';
        return;
      }

      var html = '';
      var lastBucket = '';
      shown.forEach(function (s) {
        var b = bucket(s.updatedAt);
        if (b !== lastBucket) {
          html += '<div class="dr-sec"><span>' + b + '</span></div>';
          lastBucket = b;
        }
        var on = (s.code === cur) ? ' on' : '';
        var meta = [s.code];
        if (s.count) meta.push(s.count + ' 条');
        if (s.updatedAt) meta.push(fmtTime(s.updatedAt));
        html += '<div class="dr-item' + on + '" data-code="' + esc(s.code) + '" data-name="' + esc(s.name || '') + '">'
          + '<div class="dr-item-main">'
          + '<div class="dr-item-name">' + esc(s.name || s.code) + '</div>'
          + '<div class="dr-item-meta">' + esc(meta.join(' · ')) + '</div>'
          + '</div>'
          + '<button class="row-more" data-rename="' + esc(s.code) + '" data-name="'
          + esc(s.name || '') + '" title="更多选项">⋯</button>'
          + '</div>';
      });
      box.innerHTML = html;
    }).catch(function () {
      box.innerHTML = '<div class="kb-empty"><div class="kb-empty-t">读取会话失败</div>'
        + '<div class="kb-empty-d">下拉重开这个页面再试一次。</div></div>';
    });
  }

  /** 重命名：写进会话文件，切回来时显示你自己起的名字 */
  function renameSession(code, name) {
    if (!window.Sessions || !window.Sessions.rename) return;
    window.Sessions.rename(code, name).then(function (ok) {
      app.setSheetHint(ok ? '已重命名为「' + name + '」' : '重命名失败');
      renderSessions();
      if (window.Drawer) window.Drawer.refresh();
    });
  }

  /**
   * 删除会话。
   * 先读一份原始内容留在内存里，删完给 5 秒撤销窗口 ——
   * 会话是用户攒下来的东西，删错了没法找回来。
   */
  function deleteSession(code, name) {
    if (!window.Sessions) return;
    app.callNative('fsRead', window.Sessions._path(code)).then(function (raw) {
      lastDeleted = { code: code, name: name, data: raw };
    }).catch(function () {
      lastDeleted = null;
    }).then(function () {
      return window.Sessions.remove(code);
    }).then(function () {
      if (code === app.currentCode()) app.clearConversation();
      renderSessions();
      if (window.Drawer) window.Drawer.refresh();
      offerUndo(name);
    });
  }

  function offerUndo(name) {
    if (!lastDeleted || !app.openBottomSheet) return;
    app.openBottomSheet('已删除', '<div class="act-hint">「' + esc(name || lastDeleted.code)
      + '」的会话已删除。5 秒内可以撤销。</div>'
      + '<button class="act-btn" data-act="undo-del">撤销删除</button>');
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(function () {
      lastDeleted = null;
      app.closeBottomSheet();
    }, 5000);
  }

  function undoDelete() {
    if (!lastDeleted) return false;
    var d = lastDeleted;
    lastDeleted = null;
    if (undoTimer) clearTimeout(undoTimer);
    var obj;
    try { obj = JSON.parse(d.data); } catch (e) { obj = null; }
    if (!obj) return Promise.resolve(false);
    return window.Sessions.restore(d.code, obj).then(function (ok) {
      if (ok) {
        app.setSheetHint('已恢复「' + (d.name || d.code) + '」的会话');
        renderSessions();
        if (window.Drawer) window.Drawer.refresh();
      }
      return ok;
    });
  }

  // ==================== 设置页里的数据区 ====================

  function fillDataNote() {
    var n = $('dataNote');
    if (!n) return;
    if (!window.Sessions) { n.textContent = '会话保存在本机，一只股票一份。'; return; }
    window.Sessions.list().then(function (list) {
      var arr = list || [];
      var msgs = arr.reduce(function (s, x) { return s + (x.count || 0); }, 0);
      n.textContent = '本机共 ' + arr.length + ' 只股票的会话、' + msgs + ' 条消息，一只股票一份。';
    }).catch(function () {
      n.textContent = '会话保存在本机，一只股票一份。';
    });
  }

  function clearAllSessions(btn) {
    if (btn.textContent.indexOf('确认') !== 0) {
      btn.textContent = '确认清空全部会话？';
      return;
    }
    btn.textContent = '清空全部会话';
    app.clearAllSessions().then(function (n) {
      app.setSheetHint('已清空 ' + n + ' 条会话');
      fillDataNote();
      renderSessions();
    });
  }

  // ==================== 手势与绑定 ====================

  /** 页面任意位置横移返回（参考应用的做法），拖动时跟手，松手过线就返回 */
  function bindSwipe() {
    var startX = 0, startY = 0, dx = 0, tracking = false, node = null;

    function onStart(e) {
      var id = current();
      if (!id) return;
      node = el(id);
      if (!node) return;
      var t = e.touches ? e.touches[0] : e;
      startX = t.clientX; startY = t.clientY;
      dx = 0; tracking = true;
    }

    function onMove(e) {
      if (!tracking || !node) return;
      var t = e.touches ? e.touches[0] : e;
      var mx = t.clientX - startX;
      var my = t.clientY - startY;
      if (Math.abs(my) > 46 && Math.abs(my) > Math.abs(mx)) { tracking = false; node.style.transform = ''; return; }
      if (mx > 0) {
        dx = mx;
        node.style.transform = 'translateX(' + Math.round(mx * 0.9) + 'px)';
      }
    }

    function onEnd() {
      if (!tracking || !node) { tracking = false; return; }
      tracking = false;
      var n = node;
      node = null;
      n.style.transform = '';
      if (dx > 72) back();
    }

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
  }

  function onDocClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;

    // ← 返回
    if (t.closest('[data-back]')) { back(); return; }

    // 会话页：行尾 ⋯ → 底部面板（重命名 / 删除）
    var m = t.closest('[data-rename]');
    if (m) { openSessionSheet(m.getAttribute('data-rename'), m.getAttribute('data-name') || ''); return; }

    // 会话页：点行 = 切到那只股票并退出
    var item = t.closest('#sessBody .dr-item');
    if (item) {
      var c = item.getAttribute('data-code');
      var n = item.getAttribute('data-name') || '';
      if (!c) return;
      if (c === app.currentCode()) { back(); return; }
      back();
      app.switchStock(c, n);
      return;
    }

    // 设置页：数据区两个按钮
    if (t.closest('#btnOpenSessions')) { open('pageSessions'); return; }
    var clr = t.closest('#btnClearSessions');
    if (clr) { clearAllSessions(clr); return; }
  }

  /**
   * 会话的「更多选项」。
   * 删除这里必须写明后果 —— 光一个红色按钮，用户不知道会丢多少东西。
   */
  function openSessionSheet(code, name) {
    if (!app.openBottomSheet) return;
    var n = 0;
    var list = (window.Page._cache || []).filter(function (x) { return x.code === code; })[0];
    if (list) n = list.count || 0;
    var body = '<div class="act-hint">' + esc(name || code) + '　' + esc(code) + '</div>'
      + '<button class="act-btn" data-act="rename-sess" data-code="' + esc(code)
      + '" data-name="' + esc(name) + '">重命名</button>'
      + '<div class="act-hint">删除后该会话的 ' + n + ' 条消息会被永久删除，5 秒内可以撤销。</div>'
      + '<button class="act-danger" data-act="del-sess" data-code="' + esc(code)
      + '" data-name="' + esc(name) + '">删除会话</button>';
    app.openBottomSheet('会话', body);
  }

  function onSheetClick(e) {
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    var act = b.getAttribute('data-act');
    var code = b.getAttribute('data-code') || '';
    var name = b.getAttribute('data-name') || '';

    if (act === 'undo-del') { undoDelete(); return; }

    if (act === 'rename-sess') {
      var nn = window.prompt ? window.prompt('会话名称', name) : null;
      app.closeBottomSheet();
      if (nn && nn.trim()) renameSession(code, nn.trim());
      return;
    }

    if (act === 'del-sess') {
      // 两步确认：第一下把按钮文字换成后果说明
      if (b.textContent.indexOf('确认') !== 0) {
        b.textContent = '确认删除「' + (name || code) + '」？';
        return;
      }
      app.closeBottomSheet();
      deleteSession(code, name);
      return;
    }
  }

  // 三个二级页的 id：点击事件绑在页面元素上，而不是 document。
  // 绑 document 的话，页内点击会被"页面上的监听器 + 冒泡到 document 的监听器"处理两次
  // （返回键会连退两层），绑在元素上就不会。
  var PAGE_IDS = ['pageSessions', 'kbModal', 'settingsModal'];

  function init() {
    PAGE_IDS.forEach(function (id) {
      var e = el(id);
      if (e && e.addEventListener) e.addEventListener('click', onDocClick);
    });
    var sheet = el('actSheet');
    if (sheet && sheet.addEventListener) sheet.addEventListener('click', onSheetClick);
    bindSwipe();

    var ss = $('sessSearch');
    if (ss) {
      ss.addEventListener('input', function () {
        kw = ss.value || '';
        renderSessions();
      });
    }
  }

  window.Page = {
    init: init,
    open: open,
    close: close,
    back: back,
    isOpen: isOpen,
    current: current,
    _stack: function () { return stack.slice(); },
    _renderSessions: renderSessions,
    _setKw: function (v) { kw = v || ''; },
    _undoDelete: undoDelete
  };
})();
