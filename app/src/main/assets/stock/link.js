/* Eta 问股 × K 线面板：把「用户问了哪只股票」变成面板动作，并把面板状态回传给 Kotlin。
 *
 * 只依赖 app.js 暴露的 window.__app（switchStock / currentCode / parseSearch / callNative），
 * 不改动主逻辑，也不依赖 tools.js / agent.js（chart-only 模式下那些根本不加载）。
 *
 * 两个方向：
 *   Kotlin → 页面：StockChartIntent.open(token, tag) / fromText(text, tag)
 *   页面 → Kotlin：NativeBridge.stockEvent('ready'|'brief'|'result', json)
 */
(function () {
  var NATIVE = window.NativeBridge || null;

  function api() { return window.__app || null; }

  function push(type, payload) {
    try {
      if (NATIVE && typeof NATIVE.stockEvent === 'function') {
        NATIVE.stockEvent(type, JSON.stringify(payload || {}));
      }
    } catch (e) { }
  }

  function brief() {
    var a = api();
    if (!a) return null;
    var b = {
      code: a.currentCode() || '',
      name: a.currentName() || '',
      period: a.currentPeriod() || ''
    };
    push('brief', b);
    return b;
  }

  /* ---------- 就绪信号：首帧 K 线出来后再报，Kotlin 的 ensureReady 等这个 ---------- */
  var readySent = false;
  function pollReady(tries) {
    var a = api();
    if (a && a.dataReady && a.dataReady()) {
      if (!readySent) {
        readySent = true;
        push('ready', brief() || {});
      }
      return;
    }
    if ((tries || 0) > 140) {          // 最多等 ~17 秒，取不到数据也要放行（例如停牌/断网）
      readySent = true;
      push('ready', brief() || {});
      return;
    }
    setTimeout(function () { pollReady((tries || 0) + 1); }, 120);
  }
  pollReady(0);

  /* ---------- 状态回传：股票/周期一变就推一次 ---------- */
  var lastKey = '';
  setInterval(function () {
    var a = api();
    if (!a) return;
    var key = (a.currentCode() || '') + '|' + (a.currentPeriod() || '') + '|' + (a.currentName() || '');
    if (key !== lastKey) {
      lastKey = key;
      brief();
    }
  }, 800);

  /* ---------- 名称/代码解析 ---------- */
  function norm(tok) {
    return String(tok || '').replace(/\s+/g, '').replace(/^(sh|sz|bj)/i, '').toLowerCase();
  }

  function pick(list, tok) {
    if (!list || !list.length) return null;
    var i, it;
    var t = norm(tok);
    var raw = String(tok || '').trim();
    // 1) 代码完全一致（600519 / sh600519）
    for (i = 0; i < list.length; i++) {
      it = list[i];
      if (norm(it.raw) === t || norm(it.code) === t) return it;
    }
    // 2) 名称完全一致
    for (i = 0; i < list.length; i++) {
      if (list[i].name === raw) return list[i];
    }
    // 3) 名称包含关键字，且候选唯一
    var contains = [];
    for (i = 0; i < list.length; i++) {
      it = list[i];
      if (raw.length >= 2 && it.name && it.name.indexOf(raw) >= 0) contains.push(it);
    }
    if (contains.length === 1) return contains[0];
    // 4) 只有一个搜索结果，且关键字够长（>=3 字）才敢认，避免「大盘」「科技」这类误伤
    if (contains.length === 0 && list.length === 1 && raw.length >= 3) return list[0];
    return null;
  }

  function searchOne(tok) {
    var a = api();
    if (!a) return Promise.resolve(null);
    return a.callNative('search', tok).then(function (txt) {
      return pick(a.parseSearch(txt), tok);
    }).catch(function () { return null; });
  }

  /* ---------- 从整句话里猜股票 ---------- */
  var NOISE = [
    '帮我', '我看', '你看', '分析', '一下', '看看', '现在', '当前', '走势', '怎么', '如何',
    '这只', '那只', '股票', '个股', '能不', '可以', '值得', '买入', '卖出', '建议', '我想',
    '问一', '你说', '最近', '后面', '还会', '为什', '什么', '多少', '今天', '明天', '下周',
    '近期', '行情', '盘面', '技术', '分时', '日线', '周线', '月线', '如果', '但是', '这个',
    '那个', '我们', '他们', '还是', '就是', '已经', '没有', '支撑', '压力', '仓位', '止盈',
    '止损', '价格', '股价', '帮忙', '它', '吗', '呢', '吧', '啊', '的', '了'
  ];

  function noisy(tok) {
    for (var i = 0; i < NOISE.length; i++) {
      if (tok.indexOf(NOISE[i]) >= 0) return true;
    }
    return false;
  }

  function candidates(text) {
    var t = String(text || '');
    var out = [];
    var m = t.match(/(?:sh|sz|bj)?\d{6}/i);
    if (m) out.push(m[0]);
    // 中文连续段里取 4 / 3 字窗口（股票名基本都在 2–6 字，4 字命中率最高）
    var runs = t.match(/[\u4e00-\u9fa5]+/g) || [];
    var sizes = [4, 3, 2];
    for (var s = 0; s < sizes.length; s++) {
      var n = sizes[s];
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r];
        for (var i = 0; i + n <= run.length; i++) {
          var w = run.substr(i, n);
          if (noisy(w)) continue;
          if (out.indexOf(w) < 0) out.push(w);
        }
      }
    }
    return out.slice(0, 8);
  }

  /* 自选里有名字就先本地命中，不花网络请求 */
  function fromWatchlist(text) {
    var a = api();
    if (!a || !a.S || !a.S.watchlist) return null;
    var list = a.S.watchlist || [];
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w && w.name && w.name.length >= 2 && String(text).indexOf(w.name) >= 0) {
        if (hit && hit.code !== w.code) return null;   // 一句话点了两只，交给显式写法
        hit = w;
      }
    }
    return hit;
  }

  /* 等「新股票的 K 线真的落到图上」再回结果：
     只看 dataReady() 不够 —— 换股瞬间 S.kl 还是上一只的柱子，读出去就是错数据。 */
  function waitDataFor(code, deadline) {
    var a = api();
    if (!a) return Promise.resolve(false);
    return new Promise(function (resolve) {
      (function tick() {
        var klCode = a.S && a.S.klCode;
        if (a.currentCode() === code && klCode === code && a.dataReady && a.dataReady()) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) { resolve(false); return; }
        setTimeout(tick, 100);
      })();
    });
  }

  /* ---------- 级别（周期）---------- */
  function waitPeriod(p, code, deadline) {
    var a = api();
    if (!a) return Promise.resolve(false);
    return new Promise(function (resolve) {
      (function tick() {
        var klP = a.S && a.S.klPeriod;
        if (a.currentPeriod() === p && klP === p && (!code || a.currentCode() === code)) {
          resolve(true);
          return;
        }
        if (Date.now() > deadline) { resolve(false); return; }
        setTimeout(tick, 100);
      })();
    });
  }

  /* 点周期栏按钮，走的是页面本来那套逻辑（换 S.period、清缓存、重绘） */
  function applyPeriod(p, tag) {
    var a = api();
    if (!a) { push('result', { tag: tag, ok: false, reason: 'no-app' }); return; }
    var code = a.currentCode();
    if (a.currentPeriod() === p && a.S && a.S.klPeriod === p) {
      push('result', { tag: tag, ok: true, period: p, code: code, switched: false });
      return;
    }
    var btns = document.querySelectorAll('#periodBar button');
    var target = null;
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-p') === p) { target = btns[i]; break; }
    }
    if (!target) { push('result', { tag: tag, ok: false, reason: 'no-period-button:' + p }); return; }
    try { target.click(); } catch (e) {
      push('result', { tag: tag, ok: false, reason: 'click-failed' });
      return;
    }
    waitPeriod(p, code, Date.now() + 7000).then(function (ok) {
      brief();
      push('result', { tag: tag, ok: ok, period: p, code: code, reason: ok ? '' : 'timeout' });
    });
  }

  var PERIODS = [
    { p: 'm5', words: ['5分钟', '5分', '五分钟', 'm5', '5m'] },
    { p: 'm15', words: ['15分钟', '15分', '十五分钟', 'm15', '15m'] },
    { p: 'm30', words: ['30分钟', '30分', '半小时', 'm30', '30m'] },
    { p: 'm60', words: ['60分钟', '60分', '1小时', '一小时', 'm60', '60m'] },
    { p: 'day', words: ['日线', '日k', '日K', '每天'] },
    { p: 'week', words: ['周线', '周k', '周K', '每周'] },
    { p: 'month', words: ['月线', '月k', '月K'] },
    { p: 'minute', words: ['分时', '日内'] }
  ];

  function periodFromText(text) {
    var t = String(text || '').toLowerCase();
    for (var i = 0; i < PERIODS.length; i++) {
      var ws = PERIODS[i].words;
      for (var j = 0; j < ws.length; j++) {
        if (t.indexOf(String(ws[j]).toLowerCase()) >= 0) return PERIODS[i].p;
      }
    }
    return null;
  }

  function apply(hit, tag, token) {
    var a = api();
    if (!a) { push('result', { tag: tag, ok: false, reason: 'no-app' }); return; }
    if (a.currentCode() === hit.code) {
      brief();
      push('result', { tag: tag, ok: true, code: hit.code, name: hit.name, token: token, switched: false });
      return;
    }
    var done = function () {
      brief();
      push('result', { tag: tag, ok: true, code: hit.code, name: hit.name, token: token, switched: true });
    };
    var fail = function (e) {
      push('result', { tag: tag, ok: false, reason: 'switch-failed: ' + ((e && e.message) || e), token: token });
    };
    try {
      Promise.resolve(a.switchStock(hit.code, hit.name))
        .then(function () { return waitDataFor(hit.code, Date.now() + 6000); })
        .then(done)
        .catch(fail);
    } catch (e) { fail(e); }
  }

  /* ---------- 对外入口 ---------- */
  window.StockChartIntent = {
    /** 用名称/代码切到某只股票；完成后回传 result。 */
    open: function (token, tag) {
      if (!token) { push('result', { tag: tag, ok: false, reason: 'empty-token' }); return false; }
      searchOne(String(token).trim()).then(function (hit) {
        if (!hit) { push('result', { tag: tag, ok: false, reason: 'not-found', token: token }); return; }
        apply(hit, tag, token);
      });
      return true;
    },

    /**
     * 从用户原话里猜股票。
     *   aggressive=false：只认自选里已有的名字，绝不联网搜索（避免「帮我看看日历」这种话也去查行情）。
     *   aggressive=true ：再加上 6 位代码和字窗搜索（用户明确在问股票时才这么干）。
     */
    fromText: function (text, tag, aggressive) {
      var text2 = String(text || '');
      var w = fromWatchlist(text2);
      if (w) { apply({ code: w.code, name: w.name }, tag, w.name); return true; }
      if (!aggressive) { push('result', { tag: tag, ok: false, reason: 'watchlist-only' }); return false; }
      var cands = candidates(text2);
      if (!cands.length) { push('result', { tag: tag, ok: false, reason: 'no-candidate' }); return false; }
      var i = 0;
      (function next() {
        if (i >= cands.length) { push('result', { tag: tag, ok: false, reason: 'not-found' }); return; }
        var cand = cands[i++];
        searchOne(cand).then(function (hit) {
          if (hit) apply(hit, tag, cand);
          else next();
        });
      })();
      return true;
    },

    /** 切到指定级别：m5 / m15 / m30 / m60 / day / week / month / minute。 */
    period: function (p, tag) {
      if (!p) { push('result', { tag: tag, ok: false, reason: 'empty-period' }); return false; }
      applyPeriod(String(p), tag);
      return true;
    },

    /** 从原话里认级别（「看看 30 分钟」「切到日线」）。没认出来就不动。 */
    periodFromText: function (text, tag) {
      var p = periodFromText(text);
      if (!p) { push('result', { tag: tag, ok: false, reason: 'no-period' }); return false; }
      applyPeriod(p, tag);
      return true;
    },

    /** 当前面板状态（调试/Kotlin 兜底用）。 */
    current: function () {
      var a = api();
      if (!a) return null;
      return { code: a.currentCode(), name: a.currentName(), period: a.currentPeriod(), ready: !!(a.dataReady && a.dataReady()) };
    }
  };
})();