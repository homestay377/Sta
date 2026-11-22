/**
 * 自选股分组。
 *
 * ★ v7.0 起：**一只股票可以同时属于多个分组**。
 *   数据模型从 `w.g = 'g1'` 变成 `w.groups = ['g1','g2']`；
 *   落盘格式 v2（单分组）→ v3（多分组），读到旧数据自动迁移。
 *
 *   分组本身也补齐了基本操作：上移 / 下移 / 重命名 / 删除；
 *   组内股票支持批量选择后批量移动 / 移出 / 删除。
 *
 * 交互：分组行可折叠，行内右侧 ⋯ 是菜单（不再依赖长按）；
 *       每个分组有「选择」入口进入批量模式，组内出现勾选框。
 *
 * ★ v6.0 修掉的一个交互 bug：这里原来只绑 click，而 app.js 在 touchend 上
 *   preventDefault 会抑制 Android WebView 合成 click —— 结果就是
 *   "分组的 ⋯ 点不开"。现在统一用 bindTap（click + touchend 双绑），
 *   两个模块都能拿到事件，不会再互相吃掉。
 */
(function () {
  'use strict';

  var app = window.__app;
  var DEFAULT_ID = 'default';

  var seq = 0;             // 分组 id 的自增序号（见 newGroupId）
  var TAP_SLOP = 10;       // 手指移动超过这个距离就不算点击
  var openId = null;       // 展开中的分组 id
  var selectId = null;     // 处于批量选择模式的分组 id
  var selected = {};       // {code: 1} 选中的股票
  var sheetFor = null;     // {type, key, group}

  function $(id) { return document.getElementById(id); }
  function S() { return app.S; }
  function esc(s) { return app.esc(s); }

  // ==================== 触摸绑定 ====================
  /**
   * 与 app.js 的 on() 同一套策略：click + touchend 双绑。
   * ★ 必须双绑：app.js 在 #watchPane / #actSheet 上的 touchend 会 preventDefault，
   *   只绑 click 的一方在 Android WebView 上拿不到事件（表现为"点了没反应"）。
   */
  function bindTap(el, fn) {
    if (!el || !el.addEventListener) return;
    var guard = 0;
    var startX = 0, startY = 0, moved = false, tracking = false;
    var fire = function (e) {
      var now = Date.now();
      if (now - guard < 350) return;
      guard = now;
      try { fn(e); } catch (err) { console.error('[Groups] 处理失败', err); }
    };

    // ★ 滑动不能当点击：在自选列表里上下滚动后抬手，touchend 照样触发，
    //   不判断位移的话"滑一下就切股/就勾上一个"。
    el.addEventListener('touchstart', function (e) {
      var t = e.touches && e.touches[0];
      if (!t) { tracking = false; return; }
      startX = t.clientX; startY = t.clientY;
      moved = false; tracking = true;
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      if (!tracking) return;
      var t = e.touches && e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - startX) > TAP_SLOP ||
          Math.abs(t.clientY - startY) > TAP_SLOP) moved = true;
    }, { passive: true });

    el.addEventListener('touchcancel', function () { tracking = false; moved = false; }, { passive: true });

    el.addEventListener('click', fire);
    el.addEventListener('touchend', function (e) {
      if (e && e.cancelable) e.preventDefault();
      var wasMoved = moved;
      tracking = false; moved = false;
      if (wasMoved) return;      // 滑过了，不算点击
      fire(e);
    }, { passive: false });
  }

  // ==================== 数据层 ====================

  /** 取出一只股票的分组归属（兼容旧的单字段 g） */
  function toGroups(w) {
    if (!w) return [];
    if (Array.isArray(w.groups)) {
      return w.groups.filter(function (x) { return !!x; });
    }
    if (w.g) return [w.g];
    return [];
  }

  function ensureInit() {
    var st = S();
    if (!Array.isArray(st.groups) || !st.groups.length) {
      st.groups = [{ id: DEFAULT_ID, name: '自选' }];
    }
    // 去重 id、空名字
    var seen = {};
    st.groups = st.groups.filter(function (g) {
      if (!g || !g.id || seen[g.id]) return false;
      seen[g.id] = 1;
      g.name = String(g.name || '未命名').slice(0, 16);
      return true;
    });
    if (!st.groups.length) st.groups = [{ id: DEFAULT_ID, name: '自选' }];

    // 归一化每只股票：groups 去重、剔除已不存在的分组；
    // 空数组归入第一个分组（自选里不该存在"无归属"的股票）
    st.watchlist = (st.watchlist || []).map(function (w) {
      var out = {
        code: w.code, name: w.name, t: w.t || 0,
        groups: toGroups(w).filter(function (x) { return seen[x]; })
      };
      if (!out.groups.length) out.groups = [st.groups[0].id];
      return out;
    });

    if (!st.group) st.group = 'all';
    if (st.group !== 'all' && !seen[st.group]) st.group = 'all';

    if (!openId || !seen[openId]) {
      openId = (st.group !== 'all' && seen[st.group]) ? st.group : st.groups[0].id;
    }
    return st;
  }

  function groupName(id) {
    var g = S().groups.filter(function (x) { return x.id === id; })[0];
    return g ? g.name : '未分组';
  }

  function inGroup(w, id) {
    return !!w && toGroups(w).indexOf(id) >= 0;
  }

  function countOf(id) {
    return S().watchlist.filter(function (w) { return inGroup(w, id); }).length;
  }

  function countSelected() {
    return Object.keys(selected).length;
  }

  /** 当前分组下要显示的股票（一只股票属于多个分组时，会出现在每个分组里） */
  function visibleList() {
    var st = S();
    if (st.group === 'all') return st.watchlist;
    return st.watchlist.filter(function (w) { return inGroup(w, st.group); });
  }

  function expandedId() {
    ensureInit();
    return openId || S().groups[0].id;
  }

  function groupForNew() {
    var st = ensureInit();
    if (st.group && st.group !== 'all') return st.group;
    return st.groups[0].id;
  }

  // ==================== 持久化 ====================

  function save() {
    ensureInit();
    try {
      if (window.NativeBridge && NativeBridge.saveWatchlist) {
        NativeBridge.saveWatchlist(JSON.stringify({
          v: 3, groups: S().groups, list: S().watchlist, group: S().group
        }));
      }
    } catch (e) { console.warn('saveGroups', e); }
  }

  /** 兼容三代：v1 纯数组、v2（g 字段）、v3（groups）。迁移只影响内存，落盘都是 v3。 */
  function load(raw) {
    var st = S();
    if (!raw || raw === '[]') { ensureInit(); return; }
    var o;
    try { o = JSON.parse(raw); } catch (e) { ensureInit(); return; }
    if (Array.isArray(o)) {
      st.groups = [{ id: DEFAULT_ID, name: '自选' }];
      st.watchlist = o.map(function (w) {
        return { code: w.code, name: w.name, t: w.t || 0, groups: [DEFAULT_ID] };
      });
    } else if (o && typeof o === 'object') {
      if (Array.isArray(o.groups)) st.groups = o.groups;
      if (Array.isArray(o.list)) st.watchlist = o.list;
      if (o.group) st.group = o.group;
    }
    ensureInit();
  }

  // ==================== 操作 ====================

  /**
   * 分组 id。
   * ★ 不能只用 Date.now()：同一毫秒内连续建两个分组会撞 id，
   *   而 ensureInit 会按 id 去重 —— 第二个分组会静默消失。
   *   加上自增序号就不可能重复了。
   */
  function newGroupId() {
    seq++;
    return 'g' + Date.now().toString(36) + seq.toString(36);
  }

  function addGroup(name) {
    var st = S();
    name = String(name || '').trim().slice(0, 16);
    if (!name) return null;
    if (st.groups.some(function (g) { return g.name === name; })) return null;
    var id = newGroupId();
    st.groups.push({ id: id, name: name });
    st.group = id;
    openId = id;
    save(); renderPane(); app.renderWatchlist();
    return id;
  }

  function renameGroup(id, name) {
    var st = S();
    name = String(name || '').trim().slice(0, 16);
    if (!name) return false;
    var g = st.groups.filter(function (x) { return x.id === id; })[0];
    if (!g) return false;
    g.name = name;
    save(); renderPane(); app.renderWatchlist();
    return true;
  }

  /** 上下移动分组：'up' 与上一个交换，'down' 与下一个交换 */
  function moveGroup(id, dir) {
    var st = S();
    var i = -1;
    for (var k = 0; k < st.groups.length; k++) {
      if (st.groups[k].id === id) { i = k; break; }
    }
    if (i < 0) return false;
    var j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= st.groups.length) return false;
    var tmp = st.groups[i];
    st.groups[i] = st.groups[j];
    st.groups[j] = tmp;
    save(); renderPane(); app.renderWatchlist();
    return true;
  }

  /**
   * 删除分组：把该归属从所有股票里去掉；
   * 若某只股票因此没有任何分组了，它会从自选里消失（没归属的股票留在列表里只会让人困惑）。
   */
  function removeGroup(id) {
    var st = S();
    if (st.groups.length <= 1) return false;
    var affected = 0;
    st.watchlist = st.watchlist.filter(function (w) {
      var gs = toGroups(w).filter(function (x) { return x !== id; });
      if (!gs.length) { affected++; return false; }
      w.groups = gs;
      return true;
    });
    st.groups = st.groups.filter(function (g) { return g.id !== id; });
    if (st.group === id) st.group = 'all';
    if (openId === id) openId = null;
    if (selectId === id) selectId = null;
    ensureInit();
    save(); renderPane(); app.renderWatchlist();
    return affected;
  }

  /** 加入一个分组（保留它已有的其它分组） */
  function addStockToGroup(code, groupId) {
    var w = S().watchlist.filter(function (x) { return x.code === code; })[0];
    if (!w) return false;
    if (!S().groups.some(function (g) { return g.id === groupId; })) return false;
    if (inGroup(w, groupId)) return false;
    w.groups = toGroups(w);
    w.groups.push(groupId);
    save(); renderPane(); app.renderWatchlist();
    return true;
  }

  /** 移出某个分组：若这是它唯一的分组，就顺手从自选删除。返回 true 表示股票本身被删了 */
  function removeStockFromGroup(code, groupId) {
    var w = S().watchlist.filter(function (x) { return x.code === code; })[0];
    if (!w) return false;
    var gs = toGroups(w).filter(function (x) { return x !== groupId; });
    if (gs.length === toGroups(w).length) return false;
    if (!gs.length) {
      return removeStock(code);
    }
    w.groups = gs;
    save(); renderPane(); app.renderWatchlist();
    return false;
  }

  function removeStock(code) {
    var st = S();
    var before = st.watchlist.length;
    st.watchlist = st.watchlist.filter(function (w) { return w.code !== code; });
    if (st.watchlist.length === before) return false;
    delete selected[code];
    save(); renderPane(); app.renderWatchlist();
    return true;
  }

  function isSelecting() { return !!selectId; }
  function selectingGroup() { return selectId; }

  // ==================== 渲染 ====================

  function stockRow(w, groupId) {
    var chk = '';
    if (selectId === groupId) {
      chk = '<span class="chk' + (selected[w.code] ? ' on' : '') + '" data-check="' + esc(w.code)
        + '" title="选择">' + (selected[w.code] ? '✓' : '') + '</span>';
    }
    return '<div class="watch-row' + (w.code === S().code ? ' active' : '') + '"'
      + ' data-code="' + esc(w.code) + '" data-name="' + esc(w.name || '') + '">'
      + chk
      + '<span class="wn">' + esc(w.name || w.code) + '</span>'
      + '<span class="wp" data-px="' + esc(w.code) + '">--</span>'
      + '<span class="wc" data-pc="' + esc(w.code) + '">--</span>'
      + '<button class="row-more" data-stock="' + esc(w.code) + '" data-in-group="' + esc(groupId)
      + '" title="更多选项">⋯</button>'
      + '</div>';
  }

  function selectedAll(groupId) {
    var kids = S().watchlist.filter(function (w) { return inGroup(w, groupId); });
    return kids.length > 0 && kids.every(function (w) { return selected[w.code]; });
  }

  /** 分组内所有股票的平均涨跌幅（按已拿到的行情算，取不到的跳过） */
  function groupAvg(gid) {
    var wq = window.__watchQuotes || {};
    var kids = S().watchlist.filter(function (w) { return inGroup(w, gid); });
    var sum = 0, n = 0;
    kids.forEach(function (w) {
      var q = wq[w.code];
      if (q && isFinite(q.pct)) { sum += q.pct; n++; }
    });
    return n ? { val: sum / n, n: n } : null;
  }

  function pctHtml(gid) {
    var a = groupAvg(gid);
    if (!a) return '<span class="gpct flat">--</span>';
    var cls = a.val > 0 ? 'up' : (a.val < 0 ? 'down' : 'flat');
    var sign = a.val > 0 ? '+' : '';
    return '<span class="gpct ' + cls + '">' + sign + a.val.toFixed(2) + '%</span>';
  }

  /** 行情回来后原地刷新分组涨幅，不重建整列（否则价格会闪回 --） */
  function refreshPcts() {
    var blocks = document.querySelectorAll('.grp-block');
    for (var i = 0; i < blocks.length; i++) {
      var gid = blocks[i].getAttribute('data-block');
      var el = blocks[i].querySelector('.gpct');
      if (gid && el) el.outerHTML = pctHtml(gid);
    }
  }

  function groupBlock(g, open) {
    var kids = S().watchlist.filter(function (w) { return inGroup(w, g.id); });
    var html = '<div class="grp-block" data-block="' + esc(g.id) + '">'
      + '<div class="grp-row' + (open ? ' open' : '') + '" data-g="' + esc(g.id) + '">'
      + '<span class="caret">' + (open ? '▾' : '▸') + '</span>'
      + '<span class="gname">' + esc(g.name) + '</span>'
      + '<span class="gcount">' + kids.length + '</span>'
      + pctHtml(g.id);

    if (open && !selectId) {
      html += '<button class="sel-btn" data-select="' + esc(g.id) + '" title="批量选择">选择</button>';
    } else if (open && selectId === g.id) {
      html += '<button class="sel-btn" data-all="' + esc(g.id) + '" title="全选本组">'
        + (selectedAll(g.id) ? '清空' : '全选') + '</button>';
    }

    html += '<button class="row-more" data-group="' + esc(g.id) + '" title="更多选项">⋯</button>'
      + '</div>';
    if (!open) return html + '</div>';

    html += '<div class="grp-kids">';
    if (!kids.length) {
      html += '<div class="pane-empty">这个分组还是空的 —— 用股票行右侧的 ⋯ 把别的股票加进来</div>';
    } else {
      kids.forEach(function (w) { html += stockRow(w, g.id); });
    }
    html += '</div></div>';
    return html;
  }

  function batchBar() {
    return '<div class="batchbar">'
      + '<span class="batch-n">已选 ' + countSelected() + ' 只</span>'
      + '<button class="act-pick" data-act="batch-move">移动</button>'
      + '<button class="act-pick" data-act="batch-remove">移出</button>'
      + '<button class="act-pick danger" data-act="batch-delete">删除</button>'
      + '<button class="act-pick" data-act="batch-cancel">取消</button>'
      + '</div>';
  }

  function renderPane() {
    var pane = $('watchPane');
    if (!pane) return;
    var st = ensureInit();
    var open = expandedId();
    var html = '';
    st.groups.forEach(function (g) { html += groupBlock(g, g.id === open); });
    if (!st.watchlist.length) {
      html = '<div class="pane-empty">还没有自选股 —— 用顶部的搜索框找一只，点结果就加进来了</div>';
    }
    pane.innerHTML = html + (selectId ? batchBar() : '');
  }

  // 兼容旧调用名（外部/测试还用 renderBar）
  var renderBar = renderPane;

  // ==================== 底部面板 ====================

  function openSheet(type, key, group) {
    ensureInit();
    var st = S();
    sheetFor = { type: type, key: key, group: group || '' };
    var title, body;

    if (type === 'stock') {
      var w = st.watchlist.filter(function (x) { return x.code === key; })[0];
      if (!w) { sheetFor = null; return; }
      var inG = group || (w.groups[0] || '');
      title = (w.name || '') + '  ' + w.code;
      body = '<div class="act-hint">当前在「' + esc(groupName(inG)) + '」</div>'
        + '<div class="act-sec">加入其它分组</div><div class="act-groups">';
      st.groups.forEach(function (g) {
        if (g.id === inG) return;
        body += '<button class="act-pick' + (inGroup(w, g.id) ? ' cur' : '') + '" data-move="' + esc(g.id) + '">'
          + esc(g.name) + (inGroup(w, g.id) ? ' ✓' : '') + '</button>';
      });
      body += '</div>';
      body += '<button class="act-btn" data-act="remove-from-group">移出本组（' + esc(groupName(inG)) + '）</button>';
      body += '<div class="act-note">移出后若没有其它分组，这只股票会从自选删除。</div>';
      body += '<button class="act-danger" data-act="del-stock">从自选删除</button>';
    } else if (type === 'batch') {
      var gid = key;
      var n = countSelected();
      title = '批量移动（已选 ' + n + ' 只）';
      body = '<div class="act-hint">从「' + esc(groupName(gid)) + '」移出，再加入下面选中的分组。'
        + '一只股票可以同时属于多个分组，所以这是"改变归属"，不是"只能留一个"。</div>';
      body += '<div class="act-groups">';
      st.groups.forEach(function (g) {
        var cur = g.id === gid;
        body += '<button class="act-pick' + (cur ? ' cur' : '') + '" data-move="' + esc(g.id) + '"'
          + ' data-cur="' + (cur ? '1' : '0') + '">' + esc(g.name)
          + (cur ? ' ← 当前组' : '') + '</button>';
      });
      body += '</div>';
      body += '<button class="act-danger" data-act="batch-cancel">取消</button>';
    } else {
      var g2 = st.groups.filter(function (x) { return x.id === key; })[0];
      if (!g2) { sheetFor = null; return; }
      title = '分组：' + g2.name + '（' + countOf(g2.id) + ' 只）';
      body = '<button class="act-btn" data-act="group-up">↑ 上移</button>'
        + '<button class="act-btn" data-act="group-down">↓ 下移</button>'
        + '<button class="act-btn" data-act="rename-group">重命名</button>';
      if (st.groups.length > 1) {
        body += '<button class="act-danger" data-act="del-group">删除分组（连带 '
          + countOf(g2.id) + ' 只股票）</button>';
      } else {
        body += '<div class="act-note">至少要保留一个分组</div>';
      }
    }

    if (app.openBottomSheet) app.openBottomSheet(title, body);
  }

  function closeSheet() {
    sheetFor = null;
    if (app.closeBottomSheet) app.closeBottomSheet();
  }

  function isSheetOpen() {
    return !!(app.bottomSheetOpen && app.bottomSheetOpen());
  }

  // ==================== 事件 ====================

  function selectedCodes() {
    return Object.keys(selected);
  }

  function onSheetClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act],[data-move]') : null;
    if (!t) return;
    var move = t.getAttribute('data-move');

    // ---- 加入 / 移动到某个分组 ----
    if (move && sheetFor) {
      if (sheetFor.type === 'stock') {
        addStockToGroup(sheetFor.key, move);
        closeSheet();
        app.setSheetHint('已加入「' + groupName(move) + '」');
        return;
      }
      if (sheetFor.type === 'batch' && sheetFor.key) {
        if (t.getAttribute('data-cur') === '1') { closeSheet(); return; }
        var codes = selectedCodes();
        var from = sheetFor.key;
        codes.forEach(function (c) {
          removeStockFromGroup(c, from);
          addStockToGroup(c, move);
        });
        Object.keys(selected).forEach(function (c) { delete selected[c]; });
        save(); renderPane(); app.renderWatchlist();
        closeSheet();
        app.setSheetHint('已把 ' + codes.length + ' 只移到「' + groupName(move) + '」');
        return;
      }
    }

    var act = t.getAttribute('data-act');

    if (act === 'del-stock' && sheetFor && sheetFor.type === 'stock') {
      var code = sheetFor.key;
      var name = '';
      S().watchlist.forEach(function (w) { if (w.code === code) name = w.name; });
      // 两步确认：第一下把按钮文字换成后果说明，第二下才真删
      if (t.textContent.indexOf('确认') !== 0) {
        t.textContent = '确认删除 ' + name + '？';
        return;
      }
      removeStock(code);
      closeSheet();
      app.setSheetHint('已从自选删除 ' + name);
      return;
    }

    if (act === 'remove-from-group' && sheetFor && sheetFor.type === 'stock') {
      // ★ closeSheet() 会把 sheetFor 置空，提示文案要在关之前先取出来
      var rc = sheetFor.key;
      var fromName = groupName(sheetFor.group);
      var removed = removeStockFromGroup(rc, sheetFor.group);
      closeSheet();
      app.setSheetHint(removed ? '这只股票没有其它分组，已从自选删除'
        : '已移出「' + fromName + '」');
      return;
    }

    if (act === 'group-up' && sheetFor) {
      if (moveGroup(sheetFor.key, 'up')) { closeSheet(); app.setSheetHint('已上移'); }
      return;
    }
    if (act === 'group-down' && sheetFor) {
      if (moveGroup(sheetFor.key, 'down')) { closeSheet(); app.setSheetHint('已下移'); }
      return;
    }

    if (act === 'rename-group' && sheetFor) {
      var id = sheetFor.key;
      var nn = window.prompt ? window.prompt('分组名', groupName(id)) : null;
      if (nn && nn.trim()) { renameGroup(id, nn.trim()); app.setSheetHint('已改名'); }
      closeSheet();
      return;
    }

    if (act === 'del-group' && sheetFor) {
      if (t.textContent.indexOf('确认') !== 0) {
        t.textContent = '确认删除该分组及其股票？';
        return;
      }
      var n = removeGroup(sheetFor.key);
      closeSheet();
      app.setSheetHint('已删除分组，同时移除 ' + n + ' 只股票');
      return;
    }
  }

  function onPaneClick(e) {
    var t = e.target;

    // 1) 行尾 ⋯：股票 → 单个操作；分组 → 组操作
    var m = t.closest ? t.closest('.row-more') : null;
    if (m) {
      e.stopPropagation();
      if (m.getAttribute('data-stock')) {
        openSheet('stock', m.getAttribute('data-stock'), m.getAttribute('data-in-group'));
      } else if (m.getAttribute('data-group')) {
        openSheet('group', m.getAttribute('data-group'));
      }
      return;
    }

    // 2) 进入 / 退出批量选择
    var sel = t.closest ? t.closest('[data-select]') : null;
    if (sel) {
      selectId = sel.getAttribute('data-select');
      selected = {};
      renderPane();
      return;
    }
    var all = t.closest ? t.closest('[data-all]') : null;
    if (all) {
      var gid = all.getAttribute('data-all');
      if (selectedAll(gid)) {
        selected = {};
      } else {
        S().watchlist.forEach(function (w) {
          if (inGroup(w, gid)) selected[w.code] = 1;
        });
      }
      renderPane();
      return;
    }

    // 3) 批量条上的动作
    var actBtn = t.closest ? t.closest('[data-act]') : null;
    if (actBtn && selectId) {
      var act = actBtn.getAttribute('data-act');
      if (act === 'batch-move') {
        if (!countSelected()) { app.setSheetHint('先勾选要操作的股票'); return; }
        openSheet('batch', selectId);
      } else if (act === 'batch-remove') {
        var rs = selectedCodes();
        rs.forEach(function (c) { removeStockFromGroup(c, selectId); });
        selected = {};
        save(); renderPane(); app.renderWatchlist();
        app.setSheetHint('已移出 ' + rs.length + ' 只');
      } else if (act === 'batch-delete') {
        if (actBtn.textContent.indexOf('确认') !== 0) {
          actBtn.textContent = '确认删除选中的 ' + countSelected() + ' 只？';
          return;
        }
        var ds = selectedCodes();
        ds.forEach(function (c) { removeStock(c); });
        selected = {};
        save(); renderPane(); app.renderWatchlist();
        app.setSheetHint('已删除 ' + ds.length + ' 只');
      } else if (act === 'batch-cancel') {
        selectId = null;
        selected = {};
        renderPane();
      }
      return;
    }

    // 4) 勾选框：切换这只股票（选择模式下点股票行不再切股，由 app.js 守卫）
    var chk = t.closest ? t.closest('[data-check]') : null;
    if (chk) {
      toggleSelect(chk.getAttribute('data-check'));
      renderPane();
      return;
    }

    // 5) 分组行：展开 / 收起 / 退出选择模式（⋯ 已在上面拦掉）
    var g = t.closest ? t.closest('.grp-row') : null;
    if (g) {
      var id2 = g.getAttribute('data-g');
      if (selectId === id2) {
        selectId = null;
        selected = {};
      } else {
        openId = (expandedId() === id2) ? null : id2;
        if (openId) { S().group = openId; save(); }
      }
      renderPane();
    }
  }

  function toggleSelect(code) {
    if (selected[code]) delete selected[code];
    else selected[code] = 1;
  }

  function newGroup() {
    var name = window.prompt ? window.prompt('新分组名') : null;
    if (!name || !name.trim()) return;
    var id = addGroup(name.trim());
    if (id) app.setSheetHint('已新建分组「' + name.trim() + '」');
    else app.setSheetHint('已经有同名分组了');
  }

  function bind() {
    bindTap($('watchPane'), onPaneClick);
    bindTap($('actSheet'), onSheetClick);

    var ng = $('btnNewGroup');
    if (ng) bindTap(ng, function () { newGroup(); });
  }

  window.Groups = {
    init: bind,
    save: save,
    load: load,
    ensureInit: ensureInit,
    renderPane: renderPane,
    refreshPcts: refreshPcts,
    renderBar: renderBar,
    visibleList: visibleList,
    groupForNew: groupForNew,
    addGroup: addGroup,
    renameGroup: renameGroup,
    moveGroup: moveGroup,
    removeGroup: removeGroup,
    addStockToGroup: addStockToGroup,
    removeStockFromGroup: removeStockFromGroup,
    removeStock: removeStock,
    countOf: countOf,
    countSelected: countSelected,
    inGroup: inGroup,
    groupName: groupName,
    expandedId: expandedId,
    isSelecting: isSelecting,
    selectingGroup: selectingGroup,
    _setOpen: function (id) { openId = id; },
    _setSelecting: function (id) { selectId = id; selected = {}; },
    _selected: function () { return Object.keys(selected); },
    openSheet: openSheet,
    closeSheet: closeSheet,
    isSheetOpen: isSheetOpen,
    _DEFAULT_ID: DEFAULT_ID
  };
})();
