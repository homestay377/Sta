/* =========================================================
 * 股问AI 主应用逻辑
 * 数据流：NativeBridge（原生抓取）→ 解析 → 指标计算 → 图表渲染
 *        → 点击图表 → 提取走势快照 → 组装 Prompt → AI
 *        → 解析 AI 回复里的价位 → 自动回画到图表
 * ========================================================= */
(function () {
  'use strict';

  var NATIVE = window.NativeBridge || null;
  var $ = function (id) { return document.getElementById(id); };

  /**
   * 安全绑定事件：每个绑定独立 try-catch。
   * ★ 之前 bindEvents 是一长串直接的 addEventListener，只要中间任何一处抛错，
   *   后面的绑定（设置/展开/更多等）就全部失效 —— 表现就是"点了没反应"。
   *   改成逐个绑定、逐个容错后，单点失败不再影响其他按钮。
   */
  /** 手指移动超过这个距离就不算点击（手指抖动通常小于 6px） */
  var TAP_SLOP = 10;

  function on(id, evt, handler, opts) {
    try {
      var el = document.getElementById(id);
      if (!el) {
        console.error('[绑定失败] 元素不存在: ' + id);
        return;
      }
      if (evt === 'click') {
        // click 与 touchend 双绑：部分 Android WebView 的 click 事件不可靠
        // （被上层 touch 处理吞掉时完全不派发），touchend 能保证响应。
        //
        // ★ 但 touchend 不能无条件当成点击：手指在列表里滑动（滚动）后抬手，
        //   touchend 照样会触发 —— 那样"滑一下就切股/就触发一次操作"。
        //   所以必须判断这次触摸有没有明显位移，超过阈值只做清理、不触发。
        var guard = 0;
        var startX = 0, startY = 0, moved = false, tracking = false;
        var fire = function (ev) {
          var now = (new Date()).getTime();
          if (now - guard < 350) return;   // 去重：两个事件只处理一次
          guard = now;
          if (el.disabled) return;
          handler.call(el, ev);
        };

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
          // 阻止 touchend 之后再生成 click，避免重复
          if (e && e.cancelable) e.preventDefault();
          var wasMoved = moved;
          tracking = false; moved = false;
          // 滑动过 = 用户在滚动列表，不能当成点击
          if (wasMoved) return;
          fire(e);
        }, { passive: false });
      } else {
        el.addEventListener(evt, handler, opts);
      }
    } catch (e) {
      console.error('[绑定失败] ' + id + '.' + evt + ' -> ' + (e && e.message));
    }
  }

  // ==================== 状态 ====================
  var S = {
    code: 'sh600000',
    name: '浦发银行',
    period: 'day',
    kl: [],
    ind: {},
    quote: null,
    watchlist: [],
    groups: [],          // 自选分组 [{id,name}]，由 groups.js 维护
    group: 'all',        // 当前查看的分组（'all' = 全部）
    cfg: { baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 65536, models: [],
           lastCode: '', lastName: '',
           // ★ 多套配置（不同厂商/不同中转站各存一份）
           //   profiles: [{ id, name, baseUrl, apiKey, model, models: [], temperature, maxTokens }]
           //   activeId: 当前用哪一套。baseUrl/apiKey/model 三个旧字段始终与它保持同步，
           //   这样所有旧的调用点（callNative('aiChat', cfg) 之类）一行都不用改。
           profiles: [], activeId: '' },
    indOn: { MA: true, BOLL: false, MACD: true, KDJ: false, RSI: false, VOLMA: true, AILINE: true, CHAN: true, VOL: true, HOLLOW: false },
    history: [],
    askSeq: 0,          // 分析序号：点「停止」时自增，让在途回调全部失效
    dataSeq: 0,         // 行情序号：换股/换周期时自增，让先发后到的请求失效（v10.25）
    curAiMsg: null,     // 当前正在生成的 AI 消息元素
    sheetPinned: false, // 用户是否手动调过面板高度（调过就不再自动展开）
    busy: false,
    sheetExpanded: false,
    levels: null,        // 各级别 K 线+指标+缠论缓存
    levelsCode: null,    // 缓存对应的股票代码
    aiLevels: [],   // 当前图上 AI 标注
    aiZones: [],
    aiMarks: [],    // 点标注（背驰 / 买卖点 / 模型给的点）
    aiFib: [],      // 黄金分割
    aiShapes: [],   // AI 自由绘图的图元（跟着当前股票+周期）
    chan: null,       // 缠论分析结果
    chanFormula: null // 公式文本缓存
  };

  var chart = null;
  var cbSeq = 0;
  var pending = {};

  // ==================== 原生桥 ====================
  // ★ 看门狗时长必须 ≥ 原生侧的最坏耗时，否则前端会先放弃。
  //
  //   踩过的坑：这里原来写死 200000（200s），而原生 doChat 的重试上限是
  //   「RETRY_TIMES=2 次尝试 × READ_TIMEOUT_AI_MS=100s 读超时 + 1.5s 退避」
  //   ≈ 201.5s。于是「前端比后端先超时」—— 用户永远只看到一句
  //   「分析失败：请求超时」，而真正的原因（HTTP 4xx / 网络错误 / Key 无效）
  //   在它到达之前就被丢掉了。这正是「不知道是超时了还是报错了」的根源。
  //
  //   现在：AI 请求给 230s，把顺序摆正（原生先失败、把真实错误交回来）。
  //   这两个数要和 StockBridge.java 的常量一起改，ai_retry_test 会守住关系。
  var WATCHDOG_AI_MS = 230000;
  var WATCHDOG_MS = 200000;

  function watchdogFor(method) {
    if (method === 'aiChatToolsStream' || method === 'aiChatTools' || method === 'aiChat') {
      return WATCHDOG_AI_MS;
    }
    return WATCHDOG_MS;
  }

  /** 原生层有没有这个方法。用来做「有流式就走流式，没有就退回整段」的特性探测。 */
  function hasNative(method) {
    try {
      return !!(NATIVE && typeof NATIVE[method] === 'function');
    } catch (e) { return false; }
  }

  function callNative(method) {
    return callNativeEx.apply(null, [null, method].concat(Array.prototype.slice.call(arguments, 1)));
  }

  /**
   * 缠论统一入口：优先走原生 Kotlin 引擎（window.NativeBridge.chanCalc），
   * 桥不可用或抛错时回退到 JS 版 Chan.analyze，保证老环境不会白屏。
   *
   * 两边返回结构完全一致（pens/boxes/bi/signals/points/stats），
   * 所以 chart.setChan / tools.js / 快照都不需要改。
   *
   * viewStart 传 0：整段都画。算的是全部已加载 K 线，
   * 与通达信「按全历史算、滚动查看」的口径一致。
   */
  function chanAnalyze(kl, src) {
    var NB = window.NativeBridge;
    if (NB && typeof NB.chanCalc === 'function') {
      try {
        var out = NB.chanCalc(JSON.stringify(kl), 0);
        var parsed = JSON.parse(out);
        if (parsed && parsed.stats && parsed.stats.bars > 0) return parsed;
        console.warn('原生缠论返回空结果，回退 JS');
      } catch (e) {
        console.warn('原生缠论失败，回退 JS', e);
      }
    }
    return Chan.analyze(kl, src);
  }

  /**
   * 通用原生调用。
   *
   * opts.onStream(kind, text) 可选：原生层会以**增量**方式回调它
   * （kind = 'text' | 'reasoning'），不等整段生成完。
   * 这是「真流式」在前端的落点 —— 没有它，用户只能盯着转圈等模型把
   * 几百个字全写完才看到第一句话。
   */
  function callNativeEx(opts, method) {
    var args = Array.prototype.slice.call(arguments, 2);
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (!NATIVE) { reject(new Error('原生桥不可用')); return; }
      if (typeof NATIVE[method] !== 'function') {
        reject(new Error('原生桥没有方法 ' + method));
        return;
      }
      var cbId = 'cb' + (++cbSeq);
      var wd = opts.timeoutMs || watchdogFor(method);
      var timer = null;

      function armWatchdog() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          delete pending[cbId];
          reject(new Error('请求超时：' + method + ' 等待超过 ' + Math.round(wd / 1000) + ' 秒'));
        }, wd);
      }
      armWatchdog();

      pending[cbId] = {
        ok: function (v) { clearTimeout(timer); resolve(v); },
        fail: function (e) { clearTimeout(timer); reject(new Error(e)); },
        // ★ 流式下的看门狗语义要变：从「总时长」改成「静默时长」。
        //   模型连着吐三分钟是正常的（尤其推理模型），但它「两片之间的间隔」
        //   一直是几十毫秒。若还按总时长算，健康的长回答会在 230s 被前端掐断，
        //   用户看到「请求超时」—— 明明一直在正常输出。
        //   所以每收到一片就重新计时：只有真的卡住不动了才算超时。
        //   （真卡住时其实原生侧的读超时 100s 会先报错，这里只是最后的兜底。）
        stream: opts.onStream ? function (kind, text) {
          armWatchdog();
          opts.onStream(kind, text);
        } : null
      };
      try {
        NATIVE[method].apply(NATIVE, args.concat([cbId]));
      } catch (e) {
        clearTimeout(timer);
        delete pending[cbId];
        reject(e);
      }
    });
  }

  window.__nativeResult = function (cbId, ok, payload) {
    var p = pending[cbId];
    if (!p) return;
    delete pending[cbId];
    if (ok) p.ok(payload); else p.fail(payload);
  };

  /**
   * 原生层的增量回调入口：`__nativeStream(cbId, kind, text)`。
   * 只投递给「注册时带了 onStream」的那次调用，其余一律忽略 ——
   * 免得行情/文件那些非流式请求被误伤。
   */
  window.__nativeStream = function (cbId, kind, text) {
    var p = pending[cbId];
    if (!p || typeof p.stream !== 'function') return;
    try {
      p.stream(String(kind || 'text'), String(text == null ? '' : text));
    } catch (e) {}
  };

  // ==================== 行情解析 ====================
  function parseQuote(text) {
    var out = {};
    var re = /v_(\w+)="([^"]*)"/g, m;
    while ((m = re.exec(text)) !== null) {
      var code = m[1], f = m[2].split('~');
      if (f.length < 50) continue;
      out[code] = {
        code: code, name: f[1],
        price: +f[3], prevClose: +f[4], open: +f[5],
        change: +f[31], pct: +f[32],
        high: +f[33], low: +f[34],
        vol: +f[36], amount: +f[37],
        turnover: +f[38], pe: +f[39],
        marketCap: +f[45], upLimit: +f[47], downLimit: +f[48],
        volRatio: +f[49], stamp: f[30]
      };
    }
    return out;
  }

  // ★ parseKline.lastError：解析失败的原因，给上层拼提示用。
  //   为什么需要：原来 catch 里只 console.error，返回空数组，
  //   上层看到的和「真的没数据」一模一样，只能笼统提示「检查网络」。
  //   实际现场是腾讯 WAF 返回了 501 HTML，JSON.parse 直接炸 —— 用户永远猜不到。
  function parseKline(text, code, period) {
    parseKline.lastError = null;
    var out = [];
    var raw = (text == null) ? '' : String(text);

    // 先判「这根本不是 JSON」：WAF 拦截页 / 空响应 / 代理错误页
    var head = raw.slice(0, 200).trim();
    if (!head) {
      parseKline.lastError = '响应为空';
      return out;
    }
    if (head.charAt(0) === '<') {
      parseKline.lastError = /501|waf|访问被拦截|拦截/i.test(raw.slice(0, 2000))
        ? '被数据源拦截（WAF 501）'
        : '数据源返回了网页而不是数据';
      return out;
    }

    var j;
    try {
      j = JSON.parse(raw);
    } catch (e) {
      parseKline.lastError = '返回的不是合法 JSON（前 40 字：' + head.slice(0, 40) + '）';
      return out;
    }

    var node = j.data && j.data[code];
    if (!node) {
      var m = (j && (j.msg || j.message)) || '';
      parseKline.lastError = '返回里没有这只股票的 K 线' + (m ? '（' + m + '）' : '');
      return out;
    }
    var rows;
    if (period.indexOf('m') === 0) {
      rows = node[period] || [];
    } else {
      rows = node['qfq' + period] || node[period] || [];
    }
    if (!rows || !rows.length) {
      parseKline.lastError = '该周期的 K 线为空';
      return out;
    }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || r.length < 6) continue;
      out.push({ t: String(r[0]), o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] });
    }
    if (!out.length) {
      // 有行但一行都读不出来 = 字段格式变了，不是网络问题
      parseKline.lastError = 'K 线字段格式变了（收到 ' + rows.length + ' 行，0 行可用）';
    }
    return out;
  }

  function parseMinute(text, code) {
    parseMinute.lastError = null;
    var out = [];
    var raw = (text == null) ? '' : String(text);
    var head = raw.slice(0, 200).trim();
    if (!head) { parseMinute.lastError = '响应为空'; return out; }
    if (head.charAt(0) === '<') {
      parseMinute.lastError = /501|waf|拦截/i.test(raw.slice(0, 2000))
        ? '被数据源拦截（WAF 501）' : '数据源返回了网页而不是数据';
      return out;
    }
    try {
      var j = JSON.parse(raw);
      var node = j.data && j.data[code] && j.data[code].data;
      if (!node || !node.data) {
        parseMinute.lastError = '返回里没有这只股票的分时';
        return out;
      }
      var rows = node.data;
      var prevVol = 0;
      for (var i = 0; i < rows.length; i++) {
        var parts = String(rows[i]).split(/\s+/);
        if (parts.length < 4) continue;
        var price = +parts[1], cumVol = +parts[2], amt = +parts[3];
        var pv = Math.max(cumVol - prevVol, 0);
        prevVol = cumVol;
        out.push({
          t: parts[0], o: price, c: price, h: price, l: price, v: pv,
          avg: cumVol > 0 ? amt / (cumVol * 100) : price
        });
      }
      if (!out.length) parseMinute.lastError = '分时数据为空';
    } catch (e) {
      parseMinute.lastError = '分时数据解析失败：' + (e && e.message);
    }
    return out;
  }

  function parseSearch(text) {
    var out = [];
    try {
      var m = /v_hint="([^"]*)"/.exec(text);
      if (!m) return out;
      var body = m[1];
      if (!body || body === 'N') return out;
      var items = body.split('^');
      for (var i = 0; i < items.length; i++) {
        var f = items[i].split('~');
        if (f.length < 3) continue;
        var mk = f[0], cd = f[1], nm = f[2];
        if (mk !== 'sh' && mk !== 'sz' && mk !== 'bj') continue;
        out.push({ code: mk + cd, name: decodeUnicode(nm), raw: cd });
      }
    } catch (e) { console.error('search parse', e); }
    return out;
  }

  function decodeUnicode(s) {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
  }

  /** 把周期栏按钮拨回某个周期（取数失败回滚用）。只动 UI 与 S.period，不触发 loadData。 */
  function restorePeriodUI(p) {
    if (!p) return;
    S.period = p;
    try {
      var bar = $('periodBar');
      if (!bar) return;
      var ps = bar.querySelectorAll('button');
      for (var i = 0; i < ps.length; i++) {
        ps[i].classList.toggle('active', ps[i].getAttribute('data-p') === p);
      }
    } catch (e) { console.warn('restorePeriodUI', e); }
  }

  // ==================== 数据加载 ====================
  // ==================== K 线缓存（v10.26）====================
  //
  // 目的：切周期不再每次都转圈。
  //
  // 策略（stale-while-revalidate）：
  //   · 60s 内（分时 15s）      → 直接用缓存，**不发请求**（一定是新的）
  //   · 10 分钟内（分时 60s）   → 秒开缓存 + 后台静默刷新
  //   · 超时                    → 当没有缓存，走原来的转圈逻辑
  //
  // 为什么敢这么做：K 线是历史数据。日/周/月线的历史部分永远不变，
  // 盘中只有**最后一根**在动；分钟线同理。所以缓存只影响「最新价」的秒级新鲜度，
  // 不影响形态、笔、中枢、背驰这些判断。卡片上会写明看到的是哪个时点的数据。
  var KL_CACHE = {};
  var KL_CACHE_MAX = 12;
  var CACHE_FRESH_MS = 60000;      // 日/周/月/分钟线：直接命中窗口
  var CACHE_STALE_MS = 600000;     // 秒开 + 后台刷新窗口
  var MINUTE_FRESH_MS = 15000;     // 分时变化快，窗口收紧
  var MINUTE_STALE_MS = 60000;

  function klCacheGet(code, period) {
    return KL_CACHE[code + '|' + period] || null;
  }

  function klCachePut(code, period, kl) {
    if (!kl || !kl.length) return;
    KL_CACHE[code + '|' + period] = { kl: kl, at: Date.now() };
    var keys = Object.keys(KL_CACHE);
    if (keys.length > KL_CACHE_MAX) {
      keys.sort(function (a, b) { return KL_CACHE[a].at - KL_CACHE[b].at; });
      for (var i = 0; i < keys.length - KL_CACHE_MAX; i++) delete KL_CACHE[keys[i]];
    }
  }

  /** 两次拉到的 K 线是否「实质相同」：长度一样且最后一根的 时间/收/量 都一样 */
  function sameKl(a, b) {
    if (!a || !b || !a.length || !b.length || a.length !== b.length) return false;
    var x = a[a.length - 1], y = b[b.length - 1];
    return x.t === y.t && x.c === y.c && x.v === y.v;
  }

  function clockOf(ts) {
    var d = new Date(ts);
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }

  /**
   * 把一批 K 线画到图上（唯一入口，缓存命中与网络返回都走这里）。
   *
   * opts.keepView = true（后台刷新）：
   *   · 保留缩放 / 起始位置 / 十字与选中
   *   · **不清掉**这只股票这个周期上的 AI 标注与图元
   */
  function applyKl(kl, period, opts) {
    opts = opts || {};
    S.kl = kl;
    // 这批 K 线属于哪只股票：Eta 换股后要等 klCode 和 code 一致，才敢把数据交给模型/画标注，
    // 否则会把上一只的 K 线当成新股票的行情读出去。
    S.klCode = S.code;
    S.klPeriod = period;
    computeIndicators();
    var keep = null;
    if (opts.keepView) {
      keep = { start: chart.start, visible: chart.visible,
               cross: chart.crossIdx, sel: chart.selIdx };
    }
    chart.batch(function () {
      chart.setData(S.kl, S.ind, period === 'minute');
      // 缠论只在 K 线周期算，分时不算
      if (period !== 'minute') {
        runChan();
      } else {
        S.chan = null;
        chart.setChan(null);
        renderChanStatus();
      }
      chart.setAiMarks(S.aiLevels, S.aiZones, S.aiMarks, S.aiFib, S.aiTexts);
      if (opts.keepView) {
        // 后台刷新：用户画的东西不能凭空消失
        if (chart.setShapes && S.aiShapes.length) chart.setShapes(S.aiShapes);
      } else {
        // 换股/换周期：旧的 AI 标注与图元已失效
        S.aiLevels = []; S.aiZones = [];
        chart.clearAiMarks();
        S.aiShapes = [];
        if (chart.clearShapes) chart.clearShapes();
      }
    });
    if (keep) {
      chart.start = Math.max(0, Math.min(keep.start,
        Math.max(0, chart.kl.length - chart.visible)));
      chart.crossIdx = keep.cross;
      chart.selIdx = keep.sel;
      chart.render();
    }
    renderIndicatorValues();
    updateChartSub();
    updateWatchActive();
    // ★ 展开态下把面板高度锁回上限（换周期会让 chaStatus 从无到有、三区比例变化）
    if (S.sheetExpanded) {
      applySheetHeight(sheetMaxHeight(true), true);
    }
  }

  /**
   * 加载当前股票 + 周期的 K 线与行情。
   *
   * force = true：忽略缓存（用户点了当前已选中的那个周期，即「我要最新」）。
   */
  function loadData(force) {
    var seq = ++S.dataSeq;
    var code = S.code, period = S.period;
    // ★ 失败时要能把周期栏拨回去。
    //   切周期是「先改 S.period 再 loadData」，如果新周期取不到数据，
    //   界面会变成「按钮显示日K、图上还是60分」的错位状态。
    var prevPeriod = S.lastOkPeriod || period;
    // 换股后旧的各级别数据失效，清空缓存（多级别按 code 缓存）
    if (S.levelsCode !== code) {
      S.levels = null;
      S.levelsCode = null;
    }

    // ---------- 先看缓存 ----------
    var cached = force ? null : klCacheGet(code, period);
    var now = Date.now();
    var freshMs = period === 'minute' ? MINUTE_FRESH_MS : CACHE_FRESH_MS;
    var staleMs = period === 'minute' ? MINUTE_STALE_MS : CACHE_STALE_MS;
    if (cached && (now - cached.at) > staleMs) cached = null;

    var fromCache = false;
    if (cached) {
      fromCache = true;
      $('chartLoading').classList.add('hidden');   // ★ 有缓存就不转圈
      S.lastOkPeriod = period;
      applyKl(cached.kl, period, { keepView: S.kl.length > 0 });
      var age = now - cached.at;
      if (age < freshMs) {
        setSheetHint('数据 ' + clockOf(cached.at) + ' 更新（'
          + Math.max(1, Math.round(age / 1000)) + ' 秒前，未发新请求）', 2600);
        return Promise.resolve(true);
      }
      setSheetHint('已显示 ' + clockOf(cached.at) + ' 的数据，正在后台刷新…', 2600);
    } else {
      $('chartLoading').classList.remove('hidden');
    }

    var jobs = [];

    jobs.push(callNative('quote', code).then(function (txt) {
      if (seq !== S.dataSeq) return;
      var q = parseQuote(txt);
      if (q[code]) {
        S.quote = q[code];
        S.name = q[code].name;
        renderQuote();
        persistStock();       // 名称也拿到了，这时候存最准
      }
    }).catch(function (e) { console.warn('quote', e); }));

    // ★ 先落临时变量，解析成功才写回 S.kl。
    //   原来直接 `S.kl = parseKline(...)`：一旦解析失败返回 []，
    //   旧数据当场被清空，而 chart 并没有重绘 —— 于是出现
    //   「K 线还画在图上、下面却报未获取到数据」的扭曲状态。
    var klErrText = null;
    var pendingKl = null;
    if (period === 'minute') {
      jobs.push(callNative('minute', code).then(function (txt) {
        if (seq !== S.dataSeq) return;
        var rows = parseMinute(txt, code);
        if (rows.length) pendingKl = rows;
        else klErrText = parseMinute.lastError || '分时数据为空';
      }).catch(function (e) {
        klErrText = '分时请求失败：' + ((e && e.message) || e);
      }));
    } else {
      jobs.push(callNative('kline', code, period, 640).then(function (txt) {
        if (seq !== S.dataSeq) return;
        var rows = parseKline(txt, code, period);
        if (rows.length) pendingKl = rows;
        else klErrText = parseKline.lastError || '返回 0 根 K 线';
      }).catch(function (e) {
        klErrText = 'K 线请求失败：' + ((e && e.message) || e);
      }));
    }

    return Promise.all(jobs).then(function () {
      if (seq !== S.dataSeq) return;      // 已经切到别的股票/周期了
      $('chartLoading').classList.add('hidden');
      if (pendingKl) S.kl = pendingKl;

      // ---------- 没拿到新数据 ----------
      if (!pendingKl) {
        if (fromCache) {
          // 后台刷新失败：缓存还在，不打扰用户，只提示一句
          setSheetHint('刷新失败（' + (klErrText || '返回为空') + '），仍显示 '
            + clockOf(cached.at) + ' 的数据', 5000);
          return;
        }
        try { refreshCtxChip(); } catch (e) { console.warn('ctxChip', e); }
        if (!S.kl.length) {
          // 一条都没有：把真实原因说出来，别让用户以为是自己的网。
          // 周期也要拨回去，否则按钮停在新周期、图还是空的，越点越乱。
          if (period !== prevPeriod && prevPeriod) restorePeriodUI(prevPeriod);
          addMsg('ai', '未获取到 K 线数据：' + (klErrText || '返回为空')
            + '。可点一下周期栏重新加载，或换一只股票。');
          return;
        }
        // 有旧数据可看：提示这次没刷新成功，但界面保持可用。
        // 周期已经切了却没数据 → 把按钮拨回上一个成功的周期，避免「按钮与图不符」。
        if (period !== S.lastOkPeriod && S.lastOkPeriod) {
          restorePeriodUI(S.lastOkPeriod);
        }
        addMsg('err', '这次没取到新数据（' + klErrText + '），下面显示的是上一次成功加载的结果。');
        setSheetHint('数据未刷新 · ' + klErrText, 5200);
        return;
      }

      // ---------- 拿到新数据 ----------
      klCachePut(code, period, pendingKl);
      S.lastOkPeriod = period;

      if (fromCache && sameKl(S.kl, pendingKl)) {
        // 后台刷新回来发现没变化：不重绘（避免打断看图），只更新时间提示
        try { refreshCtxChip(); } catch (e) { console.warn('ctxChip', e); }
        setSheetHint('数据 ' + clockOf(Date.now()) + ' 已是最新', 2200);
        return;
      }

      applyKl(pendingKl, period, { keepView: fromCache });
      if (fromCache) {
        setSheetHint('已刷新（' + clockOf(Date.now()) + '）', 2200);
      } else {
        setSheetHint('点 K 线后再点上方「问 xx-xx」＝针对那根分析 · 空着发送＝全级别分析', 4200);
      }

      // ★ 再加载这只股票这个周期**保存过**的图元 —— 否则"买过存了之后下次想看"这事就做不到
      if (!fromCache) {
        try {
          if (window.ShapesManager) {
            window.ShapesManager.loadShapes().then(function (arr) {
              if (arr && arr.length) {
                S.aiShapes = arr;
                if (chart.setShapes) chart.setShapes(arr);
              }
            }).catch(function () {});
          }
        } catch (e) { console.warn('loadShapes', e); }
      }
    }).catch(function (e) {
      if (seq !== S.dataSeq) return;
      $('chartLoading').classList.add('hidden');
      addMsg('err', '加载失败：' + e.message);
    });
  }


  // ==================== 缠论 ====================
  function loadChanFormula() {
    if (S.chanFormula) return Promise.resolve(S.chanFormula);
    // 优先用内嵌常量：WebView 的 file:// 协议下 fetch 本地文件常被 CORS 拦截，
    // 之前缠论不显示就是卡在这里（fetch 失败 → catch → setChan(null)）。
    if (window.CHAN_FORMULA) {
      S.chanFormula = window.CHAN_FORMULA;
      return Promise.resolve(S.chanFormula);
    }
    // 兜底：内嵌版缺失时才尝试 fetch
    return fetch('chan_formula.txt').then(function (r) {
      if (!r.ok) throw new Error('公式文件读取失败');
      return r.text();
    }).then(function (t) {
      S.chanFormula = t;
      return t;
    });
  }

  function runChan() {
    if (!S.indOn.CHAN) {
      S.chan = null;
      chart.setChan(null);
      renderChanStatus();
      return;
    }
    // 原生引擎可用时不需要 JS 的 Chan/TDX；只有两者都没有才放弃
    var hasNativeChan = !!(window.NativeBridge && typeof window.NativeBridge.chanCalc === 'function');
    if (!hasNativeChan && (typeof Chan === 'undefined' || typeof TDX === 'undefined')) {
      console.warn('缠论模块未加载');
      return;
    }
    loadChanFormula().then(function (src) {
      var t0 = performance.now();
      var r = chanAnalyze(S.kl, src);
      var cost = Math.round(performance.now() - t0);
      S.chan = r;
      chart.setChan(r);
      renderChanStatus(cost);
    }).catch(function (e) {
      console.error('缠论计算失败', e);
      S.chan = null;
      chart.setChan(null);
      renderChanStatus();
      var el = $('chanStatus');
      if (el) {
        el.classList.remove('hidden');
        el.innerHTML = '<span class="cs-item" style="color:#ff8a80">缠论计算失败：'
          + esc(String(e && e.message || e)) + '</span>';
        // 上面是手动改的内容，高度可能变了，补一次同步
        syncChanStatusInset();
      }
    });
  }

  /**
   * 对话区标题 = 「个股名 + 个股分析」。
   * 没有股票名时退回纯「个股分析」，不退化成「undefined 个股分析」。
   */
  function setSheetTitle(name) {
    var el = $('sheetTitle');
    if (!el) return;
    var n = String(name == null ? '' : name).trim();
    var txt = n ? (n + ' 个股分析') : '个股分析';
    if (el.textContent !== txt) el.textContent = txt;
  }

  /** 现价相对中枢的位置：above/below/inside */
  function boxPosition(price, box) {
    if (!box) return 'none';
    if (price > box.zg) return 'above';
    if (price < box.zd) return 'below';
    return 'inside';
  }

  /**
   * 把缠论状态条的高度告诉图表，让价格区从它下面开始。
   *
   * 这个条是 DOM 覆盖层（要彩色 span，画在 canvas 里不划算），
   * 而 K 线在 canvas 里。两边谁也不知道对方占多高 —— 以前条子写死 top:19px
   * 压在蜡烛上，就是因为缺这个"互相报高度"的动作。
   */
  function syncChanStatusInset() {
    var el = $('chanStatus');
    if (!chart) return;
    if (!el || el.classList.contains('hidden')) {
      chart.setTopInset(0);
      return;
    }
    // 先让它按新位置完成布局，再量高度
    var h = el.offsetHeight || 0;
    chart.setTopInset(h ? h + 4 : 0);
  }

  function renderChanStatus(cost) {
    var el = $('chanStatus');
    var c = S.chan;
    if (!c || !c.boxes) {
      el.classList.add('hidden');
      syncChanStatusInset();
      return;
    }
    el.classList.remove('hidden');
    var parts = [];
    parts.push('<span class="cs-item">中枢 <b>' + c.boxes.length + '</b> 个</span>');
    parts.push('<span class="cs-item">笔 <b>' + c.pens.length + '</b></span>');

    // 当前价所处中枢
    if (S.quote && c.boxes.length) {
      var last = c.boxes[c.boxes.length - 1];
      var pos = boxPosition(S.quote.price, last);
      var posTxt = { above: '中枢之上', below: '中枢之下', inside: '中枢之内' }[pos] || '';
      var cls = pos === 'above' ? 'cs-up' : (pos === 'below' ? 'cs-down' : '');
      if (posTxt) {
        parts.push('<span class="cs-item ' + cls + '">现价' + posTxt + '</span>');
      }
      parts.push('<span class="cs-item">ZG <b>' + fx(last.zg, 2) + '</b> ZD <b>' + fx(last.zd, 2) + '</b></span>');
    }

    // ---- 最新买卖点 / 背驰信号 ----
    //
    // 以前只显示背驰（signals），三类买卖点（points）完全没露出来 ——
    // 但它们才是「什么时候动手」的直接依据，只画在图上不写出来太浪费。
    // 这里把两者合起来，取「离当前最近的那一个」，并标出隔了多少根 K 线，
    // 让用户一眼判断这个信号是今天的还是两个月前的。
    var latest = null;
    function consider(item, kind) {
      if (!item || typeof item.idx !== 'number') return;
      if (!latest || item.idx > latest.idx) {
        latest = { idx: item.idx, price: item.price, label: item.label, type: item.type, kind: kind };
      }
    }
    if (c.signals) for (var si = 0; si < c.signals.length; si++) consider(c.signals[si], '背离');
    if (c.points) for (var pi = 0; pi < c.points.length; pi++) consider(c.points[pi], '买卖点');

    if (latest) {
      var isBuy = latest.type === 'buy';
      var lcls = isBuy ? 'cs-buy' : 'cs-sell';
      var back = (S.kl.length - 1) - latest.idx;   // 距最新一根多少根
      var ageTxt = back <= 0 ? '当根' : ('-' + back + '根');
      parts.push(
        '<span class="cs-item ' + lcls + '">' +
        '<b>' + esc(latest.label || latest.kind) + '</b> @' + fx(latest.price, 2) +
        ' <span style="opacity:.6">' + ageTxt + '</span></span>'
      );
      // 最近 3 根内出现的信号额外高亮，避免"刚出的买点"被淹没在一堆数字里
      if (back <= 2) {
        parts.push('<span class="cs-item cs-alert">★ 新信号</span>');
      }
    }

    if (cost !== undefined) {
      parts.push('<span class="cs-item" style="opacity:.5">' + cost + 'ms</span>');
    }
    el.innerHTML = parts.join('');
    // 内容变了高度也会变（换行/少一项），重新量一次
    syncChanStatusInset();
  }

  function computeIndicators() {
    // ★ 分时单独一套参数。
    //
    //   原来的问题：不管什么周期都用 [5,10,20,60,120,250]，
    //   而分时一天只有 240 个点 —— MA250 整个序列都是 null，
    //   图例里那些均线一条都画不出来，用户看到的就是"分时指标不对"。
    //
    //   分时该看的是「价格 vs 当日均价」，不是日线级别的均线：
    //     · 只算 MA5/MA10/MA20（短周期，240 点足够）
    //     · 不算 BOLL/KDJ/RSI（日内噪声太大，没有参考意义）
    //     · 保留 MACD（判断日内动能够用）
    //   均价线由 chart.js 直接用 kl[].avg 画，不走指标通道。
    var isMinute = S.period === 'minute';
    //
    // ★ 分时**不算任何均线**。
    //
    //   分时图只有两根线：分时曲线（现价）和均价线。
    //   之前分时算了 MA5/10/20，但那些线根本没画在分时主图上，
    //   只让图例里多了几行、让副图多了内容 —— 既没用又干扰。
    //   均价线由 chart.js 直接用 kl[].avg 画，不走指标通道，所以这里 MA 关掉。
    //
    //   同理 BOLL/KDJ/RSI 在分时下没有意义（日内噪声），一律不算。
    //   分时只保留 MACD，用于判断日内动能。
    S.ind = Ind.computeAll(S.kl, {
      maPeriods: isMinute ? [] : [5, 10, 20, 60, 120, 250],
      ind: {
        MA: isMinute ? false : S.indOn.MA,
        BOLL: isMinute ? false : S.indOn.BOLL,
        MACD: isMinute ? S.indOn.MACD : S.indOn.MACD,
        KDJ: isMinute ? false : S.indOn.KDJ,
        RSI: isMinute ? false : S.indOn.RSI,
        VOLMA: S.indOn.VOLMA
      }
    });
  }

  function updateChartSub() {
    // ★ 分时：副图（MACD/KDJ/RSI）不显示 —— 分时只有价格折线和均价线两根线，
    //   画副图会多出一整套指标线，和用户要求不符。
    //   分时指标（均线/BOLL/KDJ/RSI）本来也不算，副图自然无从画起。
    var sub = '';
    if (S.period !== 'minute' && S.indOn.MACD) sub = 'MACD';
    else if (S.period !== 'minute' && S.indOn.KDJ) sub = 'KDJ';
    else if (S.period !== 'minute' && S.indOn.RSI) sub = 'RSI';
    // 成交量是独立的一条，和副图无关；两个都关掉时价格区会吃满整块高度
    chart.showVol = (S.indOn.VOL !== false);
    chart.setSub(sub);
  }

  // ==================== 渲染 ====================
  function renderQuote() {
    var q = S.quote;
    if (!q) return;
    $('qName').textContent = q.name;
    // ★ 对话区标题跟着当前股票走：「阳光电源 个股分析」。
    //   原来写死「个股分析」，切了股票也不知道在分析谁 ——
    //   截图里用户特意圈出这块要求改。
    setSheetTitle(q.name);
    $('qCode').textContent = q.code.replace(/^(sh|sz|bj)/, '').toUpperCase();
    $('qPrice').textContent = fmtPrice(q.price);
    var cls = q.pct > 0 ? 'up' : (q.pct < 0 ? 'down' : 'flat');
    $('qPrice').className = cls;
    $('qChg').className = 'q-chg ' + cls;
    var sign = q.pct > 0 ? '+' : '';
    $('qChg').textContent = sign + fx(q.change, 2) + '  ' + sign + fx(q.pct, 2) + '%';
    $('qOpen').textContent = fmtPrice(q.open);
    $('qHigh').textContent = fmtPrice(q.high);
    $('qLow').textContent = fmtPrice(q.low);
    $('qVol').textContent = fmtVol(q.vol);
  }

  function renderIndicatorValues() {
    var el = $('indicatorValues');
    if (!el) return;   // 新版顶部已精简，不再需要这一行
    if (!S.kl.length) { el.innerHTML = ''; return; }
    var i = S.kl.length - 1;
    var parts = [];
    if (S.ind.ma) {
      var colors = { MA5: '#e65100', MA10: '#6a1b9a', MA20: '#f9a825', MA60: '#26c6da' };
      for (var m in S.ind.ma) {
        var v = S.ind.ma[m][i];
        if (v != null) parts.push('<span style="color:' + (colors[m] || '#8b949e') + '">' + m + ' ' + fmtPrice(v) + '</span>');
      }
    }
    if (S.ind.macd) {
      var md = S.ind.macd, bar = md.BAR[i] || 0;
      parts.push('<span>MACD <b style="color:' + (bar >= 0 ? '#ff4d4f' : '#26a65b') + '">' + fx(bar, 3) + '</b></span>');
    }
    if (S.ind.kdj && S.ind.kdj.K[i] != null) {
      var kd = S.ind.kdj;
      parts.push('<span>K' + fx(kd.K[i], 0) + ' D' + fx(kd.D[i], 0) + ' J' + fx(kd.J[i], 0) + '</span>');
    }
    if (S.ind.rsi && S.ind.rsi.RSI[i] != null) {
      parts.push('<span>RSI ' + fx(S.ind.rsi.RSI[i], 1) + '</span>');
    }
    el.innerHTML = parts.join('');
  }

  /**
   * 自选股渲染入口。
   * 自选列表现在住在抽屉里（#watchPane），由 groups.js 画成分组可折叠的列表；
   * 这里只负责把它画出来、再把行情补上价格。
   */
  function renderWatchlist() {
    try {
      if (window.Groups) window.Groups.renderPane();
      else { var bar = $('watchPane'); if (bar) bar.innerHTML = ''; }
      refreshWatchQuotes();
    } catch (e) { console.error('renderWatchlist', e); }
  }

  function refreshWatchQuotes() {
    var codes = S.watchlist.map(function (w) { return w.code; });
    if (codes.indexOf(S.code) < 0) codes.push(S.code);
    if (!codes.length) return;
    callNative('quote', codes.join(',')).then(function (txt) {
      var qs;
      try { qs = parseQuote(txt); } catch (e) { return; }
      // 分组涨幅要用：缓存一份 code -> quote
      window.__watchQuotes = qs;
      if (qs[S.code]) {
        S.quote = qs[S.code];
        try { renderQuote(); } catch (e) { console.error('renderQuote', e); }
      }
      Object.keys(qs).forEach(function (c) {
        var q = qs[c];
        var pe = document.querySelector('[data-px="' + c + '"]');
        var pc = document.querySelector('[data-pc="' + c + '"]');
        try {
          if (pe) { pe.textContent = fmtPrice(q.price); pe.className = 'wp ' + (q.pct > 0 ? 'up' : q.pct < 0 ? 'down' : 'flat'); }
          if (pc) {
            var sg = q.pct > 0 ? '+' : '';
            pc.textContent = sg + fx(q.pct, 2) + '%';
            pc.className = 'wc ' + (q.pct > 0 ? 'up' : q.pct < 0 ? 'down' : 'flat');
          }
        } catch (e) { console.error('watch item', c, e); }
      });
    }).catch(function (e) { console.error('refreshWatchQuotes', e); });
  }

  function updateWatchActive() {
    var items = document.querySelectorAll('.watch-row');
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-code') === S.code) items[i].classList.add('active');
      else items[i].classList.remove('active');
    }
  }

  // ==================== 走势快照 ====================
  // ==================== 多级别分析 ====================
  // 用户勾选的指标，AI 需要把它们在「各个级别」上的状态一起读，再给综合结论。
  var LEVELS = ['day', 'week', 'm60', 'm30', 'm15', 'm5'];

  /** 拉取所有级别的 K 线并算好指标+缠论，缓存到 S.levels */
  function loadLevels() {
    var code = S.code;
    if (S.levelsCode === code && S.levels) return Promise.resolve(S.levels);

    var jobs = LEVELS.map(function (lv) {
      return callNative('kline', code, lv, 640).then(function (txt) {
        var kl = parseKline(txt, code, lv);
        if (!kl.length) return { period: lv, kl: [], ok: false };
        var ind = Ind.computeAll(kl, {
          maPeriods: [5, 10, 20, 60, 120, 250],
          ind: { MA: true, MACD: true, BOLL: true, KDJ: true, RSI: true, VOLMA: true }
        });
        var ch = null;
        if (S.indOn.CHAN && window.CHAN_FORMULA) {
          try { ch = chanAnalyze(kl, window.CHAN_FORMULA); } catch (e) { ch = null; }
        }
        return { period: lv, kl: kl, ind: ind, chan: ch, ok: true };
      }).catch(function () {
        return { period: lv, kl: [], ok: false };
      });
    });

    return Promise.all(jobs).then(function (arr) {
      var out = {};
      arr.forEach(function (x) { if (x.ok) out[x.period] = x; });
      S.levels = out;
      S.levelsCode = code;
      return out;
    });
  }

  /** 单个级别的文字摘要（喂给 AI） */
  function levelDigest(lv) {
    var L = S.levels && S.levels[lv];
    if (!L || !L.kl.length) return null;

    var kl = L.kl, ind = L.ind, ch = L.chan;
    var n = kl.length, li = n - 1;
    var last = kl[li];
    var lines = [];
    lines.push('◆ ' + periodName(lv) + '（' + n + '根，最新 ' + last.t + '）');

    // 均线排列
    if (ind.ma) {
      var maVals = {};
      var arr = [];
      ['MA5', 'MA10', 'MA20', 'MA60'].forEach(function (k) {
        var v = ind.ma[k] ? ind.ma[k][li] : null;
        if (v != null && isFinite(v)) { maVals[k] = v; arr.push(k + '=' + v.toFixed(2)); }
      });
      if (arr.length) lines.push('  均线 ' + arr.join(' '));
      // 排列判定
      if (maVals.MA5 != null && maVals.MA20 != null && maVals.MA60 != null) {
        var align;
        if (maVals.MA5 > maVals.MA20 && maVals.MA20 > maVals.MA60) align = '多头排列';
        else if (maVals.MA5 < maVals.MA20 && maVals.MA20 < maVals.MA60) align = '空头排列';
        else align = '纠缠';
        var vsMa20 = last.c > maVals.MA20 ? '站上MA20' : '跌破MA20';
        lines.push('  排列：' + align + '，' + vsMa20);
      }
    }

    // MACD
    if (ind.macd) {
      var md = ind.macd;
      var dif = num(md.DIF[li]), dea = num(md.DEA[li]), bar = num(md.BAR[li]);
      var barPrev = num(md.BAR[li - 1]);
      var cross = '';
      if (dif > dea && num(md.DIF[li - 1]) <= num(md.DEA[li - 1])) cross = ' 金叉';
      else if (dif < dea && num(md.DIF[li - 1]) >= num(md.DEA[li - 1])) cross = ' 死叉';
      var growing = Math.abs(bar) > Math.abs(barPrev) ? '放大' : '缩小';
      lines.push('  MACD：DIF=' + fx(dif, 3) + ' DEA=' + fx(dea, 3) + ' 柱=' + fx(bar, 3)
        + '（' + (bar >= 0 ? '红柱' : '绿柱') + growing + '）' + cross);
    }

    // KDJ / RSI
    if (ind.kdj && ind.kdj.K[li] != null) {
      var kd = ind.kdj;
      lines.push('  KDJ：K=' + fx(kd.K[li], 1) + ' D=' + fx(kd.D[li], 1) + ' J=' + fx(kd.J[li], 1));
    }
    if (ind.rsi && ind.rsi.RSI[li] != null) {
      lines.push('  RSI=' + fx(ind.rsi.RSI[li], 1));
    }

    // 量价
    if (ind.volma) {
      var v5 = ind.volma.VMA5 ? ind.volma.VMA5[li] : null;
      var v10 = ind.volma.VMA10 ? ind.volma.VMA10[li] : null;
      var vRatio = (v10 && v10 > 0) ? (last.v / v10) : 1;
      var vtxt = vRatio > 1.5 ? '显著放量' : (vRatio > 1.1 ? '温和放量' : (vRatio < 0.7 ? '明显缩量' : '量能平稳'));
      lines.push('  量能：' + vtxt + '（当前量/10均量=' + fx(vRatio, 2) + '）');
    }

    // 缠论
    if (ch && ch.boxes) {
      var boxes = ch.boxes;
      var lb = boxes.length ? boxes[boxes.length - 1] : null;
      if (lb) {
        var pos = last.c > lb.zg ? '中枢上方' : (last.c < lb.zd ? '中枢下方' : '中枢内');
        lines.push('  缠论：' + boxes.length + '个中枢，最新 [' + fx(lb.zg, 2) + ',' + fx(lb.zd, 2) + ']，现价' + pos);
      } else {
        lines.push('  缠论：暂无中枢');
      }
      // 最近笔方向
      var pens = (ch.pens || []).filter(function (x) {
        return x && typeof x.toPrice === 'number' && isFinite(x.toPrice);
      });
      var last3 = pens.slice(-3);
      if (last3.length) {
        var dirs = last3.map(function (p) { return p.dir === 'up' ? '上' : '下'; }).join('→');
        lines.push('  最近笔向：' + dirs);
      }
    }
    return lines.join('\n');
  }

  /** 所有级别的摘要文本 */
  function buildMultiLevelText() {
    if (!S.levels) return '';
    var blocks = [];
    LEVELS.forEach(function (lv) {
      var d = levelDigest(lv);
      if (d) blocks.push(d);
    });
    if (!blocks.length) return '';
    return '【多级别走势（由大到小）】\n' + blocks.join('\n');
  }

  function buildSnapshot(focusIdx) {
    var lines = [];
    var q = S.quote;
    lines.push('【股票】' + S.name + '（' + S.code + '）');
    if (q) {
      var sign = q.pct > 0 ? '+' : '';
      lines.push('【现价】' + fmtPrice(q.price) + '  ' + sign + fx(q.change, 2) + ' (' + sign + fx(q.pct, 2) + '%)');
      lines.push('【今日】开 ' + fmtPrice(q.open) + ' 高 ' + fmtPrice(q.high) + ' 低 ' + fmtPrice(q.low)
        + ' 量 ' + fmtVol(q.vol) + ' 换手 ' + fx((q.turnover || 0), 2) + '% 量比 ' + fx((q.volRatio || 0), 2));
    }
    lines.push('【周期】' + periodName(S.period) + '  共 ' + S.kl.length + ' 根');

    var startI = Math.max(0, S.kl.length - 24);
    lines.push('【最近24根' + periodName(S.period) + '】时间,开,高,低,收,量');
    for (var i = startI; i < S.kl.length; i++) {
      var k = S.kl[i];
      lines.push(k.t + ',' + k.o + ',' + k.h + ',' + k.l + ',' + k.c + ',' + Math.round(k.v));
    }

    var li = S.kl.length - 1;
    lines.push('【最新指标】');
    if (S.ind.ma) {
      var mas = [];
      for (var m in S.ind.ma) {
        var mv = S.ind.ma[m][li];
        if (mv != null) mas.push(m + '=' + fx(mv, 3));
      }
      if (mas.length) lines.push('均线：' + mas.join('  '));
    }
    if (S.ind.macd) {
      var md = S.ind.macd;
      lines.push('MACD：DIF=' + fx((md.DIF[li] || 0), 3) + ' DEA=' + fx((md.DEA[li] || 0), 3) + ' 柱=' + fx((md.BAR[li] || 0), 3));
    }
    if (S.ind.boll && S.ind.boll.UP[li] != null) {
      var bb = S.ind.boll;
      lines.push('BOLL：上=' + fx(bb.UP[li], 3) + ' 中=' + fx(bb.MID[li], 3) + ' 下=' + fx(bb.LOW[li], 3));
    }
    if (S.ind.kdj && S.ind.kdj.K[li] != null) {
      var kk = S.ind.kdj;
      lines.push('KDJ：K=' + fx(kk.K[li], 1) + ' D=' + fx(kk.D[li], 1) + ' J=' + fx(kk.J[li], 1));
    }
    if (S.ind.rsi && S.ind.rsi.RSI[li] != null) {
      lines.push('RSI14=' + fx(S.ind.rsi.RSI[li], 1));
    }

    // 用户点选的那根
    if (focusIdx != null && focusIdx >= 0 && focusIdx < S.kl.length) {
      var fk = S.kl[focusIdx];
      lines.push('【用户点选位置】' + fk.t + ' 开=' + fk.o + ' 高=' + fk.h + ' 低=' + fk.l + ' 收=' + fk.c + ' 量=' + Math.round(fk.v));
      if (S.ind.ma) {
        var cm = [];
        for (var cmk in S.ind.ma) {
          var cv = S.ind.ma[cmk][focusIdx];
          if (cv != null) cm.push(cmk + '=' + fx(cv, 3));
        }
        if (cm.length) lines.push('  该位置均线：' + cm.join(' '));
      }
      if (S.ind.macd) {
        var fmd = S.ind.macd;
        lines.push('  该位置MACD：DIF=' + fx((fmd.DIF[focusIdx] || 0), 3)
          + ' DEA=' + fx((fmd.DEA[focusIdx] || 0), 3)
          + ' 柱=' + fx((fmd.BAR[focusIdx] || 0), 3));
      }
      var pctFromNow = ((fk.c - (S.quote ? S.quote.price : fk.c)) / (S.quote ? S.quote.price : fk.c) * 100);
      lines.push('  该位置收盘价相对现价：' + fx(pctFromNow, 2) + '%');
    }

    // ===== 缠论结构 =====
    if (S.chan && S.chan.boxes) {
      var c = S.chan;
      lines.push('');
      lines.push('【缠论结构】');

      // 中枢
      lines.push('中枢共 ' + c.boxes.length + ' 个：');
      var showBoxes = c.boxes.slice(-5);
      for (var cb = 0; cb < showBoxes.length; cb++) {
        var bx = showBoxes[cb];
        var t1 = S.kl[bx.s] ? S.kl[bx.s].t : '';
        var t2 = S.kl[Math.min(bx.e, S.kl.length - 1)] ? S.kl[Math.min(bx.e, S.kl.length - 1)].t : '';
        var isLast = (cb === showBoxes.length - 1);
        lines.push('  ' + bx.tag + '中枢 ' + t1 + '~' + t2
          + '  ZG=' + fx(bx.zg, 3) + ' ZD=' + fx(bx.zd, 3) + ' 中轴=' + fx(bx.mid, 3)
          + (isLast ? '  ← 当前所在' : ''));
      }

      // 现价与最新中枢关系
      if (S.quote && c.boxes.length) {
        var lb = c.boxes[c.boxes.length - 1];
        var pos = boxPosition(S.quote.price, lb);
        var posMap = {
          above: '中枢之上（三买观察区，回踩不破 ZG=' + fx(lb.zg, 3) + ' 可看多）',
          below: '中枢之下（三卖观察区，反弹不过 ZD=' + fx(lb.zd, 3) + ' 偏空）',
          inside: '中枢之内（震荡，等方向选择；上沿 ' + fx(lb.zg, 3) + ' 下沿 ' + fx(lb.zd, 3) + '）'
        };
        lines.push('现价位置：' + posMap[pos]);
      }

      // 最近几笔
      // ★ 注意：pens 里最后一个转折点是"末笔终点"，它没有 fromPrice/toPrice/dir
      //   （那些字段只挂在"有下一笔"的转折点上）。必须过滤掉，否则 toFixed 崩。
      var allPens = c.pens.filter(function (x) {
        return x && typeof x.fromPrice === 'number' && typeof x.toPrice === 'number'
          && isFinite(x.fromPrice) && isFinite(x.toPrice);
      });
      var pens = allPens.slice(-6);
      lines.push('最近 ' + pens.length + ' 笔：');
      for (var pp = 0; pp < pens.length; pp++) {
        var pn = pens[pp];
        var d = (pn.dir === 'up') ? '向上' : '向下';
        var pt1 = S.kl[pn.from] ? S.kl[pn.from].t : '';
        var pt2 = S.kl[pn.to] ? S.kl[pn.to].t : '';
        var pct = (num(pn.fromPrice) !== 0)
          ? fx((num(pn.toPrice) - num(pn.fromPrice)) / num(pn.fromPrice) * 100, 2)
          : '0.00';
        lines.push('  ' + d + '笔 ' + pt1 + '→' + pt2
          + '  ' + fx(pn.fromPrice, 3) + '→' + fx(pn.toPrice, 3)
          + '  (' + pct + '%) 跨' + pn.len + '根');
      }

      // 买卖点信号
      if (c.signals && c.signals.length) {
        lines.push('缠论信号：');
        var sigs = c.signals.slice(-4);
        for (var ss = 0; ss < sigs.length; ss++) {
          var sg = sigs[ss];
          var st2 = S.kl[sg.idx] ? S.kl[sg.idx].t : '';
          lines.push('  ' + st2 + '  ' + sg.label + '  价位 ' + fx(sg.price, 3)
            + '  力度衰减 ' + sg.strength);
        }
      } else {
        lines.push('缠论信号：当前无背驰买卖点');
      }
    }

    if (S.kl.length >= 6) {
      var last = S.kl[S.kl.length - 1].c;
      var chg5 = (last - S.kl[S.kl.length - 6].c) / S.kl[S.kl.length - 6].c * 100;
      var p20i = Math.max(0, S.kl.length - 21);
      var chg20 = (last - S.kl[p20i].c) / S.kl[p20i].c * 100;
      lines.push('【区间涨跌】近5根 ' + fx(chg5, 2) + '%  近20根 ' + fx(chg20, 2) + '%');
      var hi20 = -Infinity, lo20 = Infinity;
      for (var h2 = Math.max(0, S.kl.length - 20); h2 < S.kl.length; h2++) {
        hi20 = Math.max(hi20, S.kl[h2].h);
        lo20 = Math.min(lo20, S.kl[h2].l);
      }
      var span20 = hi20 - lo20;
      var posPct = (span20 > 0) ? fx((last - lo20) / span20 * 100, 0) : '50';
      lines.push('【近20根区间】高 ' + fx(hi20, 3) + ' 低 ' + fx(lo20, 3)
        + '  当前处于 ' + posPct + '% 分位');
    }

    // ★ 多级别数据（AI 需要跨级别对比后才能评论）
    var ml = buildMultiLevelText();
    if (ml) {
      lines.push('');
      lines.push(ml);
    }

    return lines.join('\n');
  }

  var SYSTEM_PROMPT = [
    '你是一位精通缠论（缠中说禅）与多级别联立分析的 A 股技术分析师。',
    '',
    '【最重要的要求】',
    '用户给你的数据包含**多个级别**（周线 / 日线 / 60分 / 30分 / 15分 / 5分）的完整信息，',
    '每一级都有：均线排列、MACD（含金叉死叉、柱体放大缩小）、KDJ、RSI、量能、缠论中枢与笔。',
    '',
    '你必须**逐个级别读完，再做联立判断**，不能只看某一个级别就下结论。具体做法：',
    '1. 先按「大级别 → 小级别」逐个说明每个级别当前的状态（一句话一个级别）。',
    '2. 判断各级别方向是否一致（共振），还是相互矛盾。',
    '   - 大级别向上 + 小级别回调到位 = 顺势买点',
    '   - 大级别向下 + 小级别反弹 = 反弹减仓',
    '   - 小级别转折但大级别未确认 = 只能短打，不能重仓',
    '3. 明确指出「哪个级别在主导当前走势」，以及「哪个级别的信号最先可能反转」。',
    '4. 如果某一级别数据缺失或信号不明确，直接说明，不要脑补。',
    '',
    '【缠论要点】',
    '- 各个级别分别看：价格在最新中枢的什么位置（之上/之内/之下）、笔的方向、有无背驰',
    '- 大级别中枢决定方向，小级别中枢决定入场点',
    '- 三买三卖：中枢之上回踩不破 ZG = 三买；中枢之下反弹不过 ZD = 三卖',
    '',
    '【均线与指标】',
    '- 排列：多头（MA5>MA10>MA20>MA60）/ 空头 / 纠缠',
    '- MACD：金叉死叉位置、柱体是放大还是缩小（缩小=动能衰减，警惕转折）',
    '- 量能：放量/缩量，与价格是否配合',
    '',
    '请严格按以下格式输出：',
    '',
    '## 结论',
    '一句话：偏多/偏空/震荡，强度（强/中/弱），是否处于买卖点，适合多大仓位。',
    '',
    '## 各别级别状态',
    '从大级别到小级别，每个级别一行，格式：',
    '周线：方向 + 均线排列 + MACD状态 + 缠论位置（一句话）',
    '日线：同上',
    '60分：同上',
    '30分 / 15分 / 5分：同上（数据缺失的写“无数据”）',
    '',
    '## 级别共振与矛盾',
    '说明哪几级一致、哪几级矛盾，哪个级别主导，强度如何。3-4 句。',
    '',
    '## 缠论结构',
    '以当前操作级别为主，说明中枢位置、笔的方向、有无背驰。2-3 句。',
    '',
    '## 关键价位',
    '必须用这个精确格式，每行一个（价格用纯数字，不要单位）：',
    '支撑1: 数字',
    '支撑2: 数字',
    '压力1: 数字',
    '压力2: 数字',
    '止损: 数字',
    '目标: 数字',
    '（优先用各级别中枢的 ZG/ZD，其次用均线位；注明该价位来自哪个级别）',
    '',
    '## 操作建议',
    '明确买/卖/观望，说明触发条件、入场级别、仓位建议。2-3 句。',
    '',
    '## 风险提示',
    '指出当前信号的最大风险（级别矛盾、背驰未确认、量能不足、假突破等）。1-2 句。',
    '',
    '要求：用中文；总长度 800 字以内；宁可说“不确定”也不要硬凑结论。',
    '最后一行固定写：以上为技术分析，不构成投资建议。',
  ].join('\n');

  // ==================== AI 调用 ====================
  // 底部发送按钮：空闲时是「发送」，生成中变成「⏹ 停止」
  // ★ 发送/停止必须是**同一套 DOM**（两枚图标 + 一个 btn-label），
  //   状态只靠 .busy class 切换显示哪一枚（见 style.css 的
  //   .ai-send.busy .icon-send / .icon-stop 规则）。
  //
  //   之前这里只放一枚图标、且不带 icon-send / icon-stop 类名，
  //   于是：
  //     · CSS 里那两条 display 规则永远匹配不到 → 图标不受控
  //     · 而 .btn-label 被 clip 成 1px，看不出文字
  //   结果就是用户看到的"发送按键变成小方块"（裸 SVG 按 17px 撑开，
  //   圆角底色还在，但里面只剩一个小小的方块轮廓）。
  //
  // ★ 必须惰性生成，不能在模块顶层算好常量。
  //   index.html 里 app.js 排在 ui.js **之前**（chart.js 依赖 app 的时序决定的），
  //   顶层执行时 window.StockUI 还不存在 —— 那时生成的 HTML 只有 btn-label，
  //   图标一个都没有。之后每次 `sendBtn.innerHTML = ANALYZE_IDLE` 都会把
  //   ui.js 初始化好的双图标结构覆盖成"只有一个被 clip 掉的文字"，
  //   用户看到的就是圆角按钮里一个小方块。
  //   所以这里改成函数，调用时才取 StockUI。
  function sendBtnHtml() {
    var UI = window.StockUI;
    var lbl = '<span class="btn-label">发送</span>';
    if (!UI || !UI.icon) return lbl;
    return lbl + UI.icon('send', 'icon-send') + UI.icon('stop', 'icon-stop');
  }

  /**
   * 停止进行中的分析。
   * 两层一起停：原生层 abortAi() 直接 disconnect（否则模型会在后台把 token 烧完），
   * 前端再把 askSeq 自增一次，让在途的 then/catch 全部变成空操作。
   */
  function stopAsk() {
    if (!S.busy) return;
    S.askSeq++;
    S.busy = false;
    // 先让 agent 循环停下（它会作废在途回调），再掐断底层连接双保险
    try { if (window.Agent && window.Agent.isRunning()) window.Agent.stop(); } catch (e) {}
    if (NATIVE) { try { NATIVE.abortAi(); } catch (e) {} }
    var btn = $('aiSend');
    if (btn) {
      btn.disabled = false;               // 万一别处把它禁掉了，这里兜一下
      btn.classList.remove('busy');
      btn.innerHTML = sendBtnHtml();
    }
    if (S.curAiMsg) {
      var inner = (S.curAiMsg.textContent || '').trim() ? S.curAiMsg.innerHTML : '';
      S.curAiMsg.innerHTML = inner + '<div class="warn">⏹ 已停止，这次回答不完整</div>';
      S.curAiMsg = null;
    }
    setSheetHint('已停止分析');
  }

  function askAI(userQuestion, focusIdx) {
    if (S.busy) { stopAsk(); return; }   // ★ 分析中再点一次 = 停止
    if (!S.cfg.baseUrl || !S.cfg.apiKey) {
      addMsg('err', '请先在右上角 ⚙ 里配置 AI 的 API 地址和 Key。');
      openSettings();
      return;
    }
    if (!S.cfg.model) {
      addMsg('err', '还没选模型。请在 ⚙ 设置里点「获取」拉取模型列表后选择。');
      openSettings();
      return;
    }
    if (!S.kl.length) {
      addMsg('err', '还没有加载到走势数据。'
        + '点一下上方周期栏（日K / 60分）重新拉一次，'
        + '或换一只股票再回来。');
      return;
    }

    var question = userQuestion || DEFAULT_QUESTION;

    autoExpandSheet();      // 一开始对话就把面板张开（用户手动调过则不动）
    addMsg('user', question);

    // 这一轮 agent 的全部输出放在同一条消息里：工具卡片在上，最终结论在下
    var pending = addMsg('ai', '');
    var stream = makeStream(pending);
    var live = makeLiveView(stream);
    stream.render();

    S.busy = true;
    S.askSeq++;
    S.curAiMsg = pending;
    var sendBtn = $('aiSend');
    sendBtn.classList.add('busy');
    sendBtn.innerHTML = sendBtnHtml();
    setSheetHint('agent 正在分析…');

    // 历史：最近 12 条、逐条截断（Sessions 里统一规则）
    var history = (window.Sessions && window.Sessions.toFullHistory)
        ? window.Sessions.toFullHistory(S.history)
        : (window.Sessions ? window.Sessions.toAgentHistory(S.history) : []);

    if (!window.Agent) {
      pending.className = 'msg err';
      stream.close('agent 模块未加载（agent.js 缺失）');
      S.busy = false;
      sendBtn.classList.remove('busy');
      sendBtn.innerHTML = sendBtnHtml();
      return;
    }

    var askT0 = Date.now();

    // 先把知识库准备好：skill 索引 + 命中关键词的世界书条目
    var kbReady = (window.Knowledge && Knowledge.prepare)
      ? Knowledge.prepare(question)
      : Promise.resolve({ skillsIndex: '', worldbook: '', worldbookHits: [] });

    kbReady.then(function (kb) {
      if (kb.worldbookHits && kb.worldbookHits.length) {
        setSheetHint('已注入 ' + kb.worldbookHits.length + ' 条世界书设定');
      }
      return Agent.run({
        context: buildAgentContext(focusIdx),
        history: history,
        input: question,
        skills: kb.skillsIndex || '',
        worldbook: kb.worldbook || '',
        onStep: function (n, info) { setSheetHint('第 ' + n + ' 步 · ' + info.name); },
        // ★ 真流式的落点：模型每吐一小段就回调一次，边生成边显示，
        //   不再等整段生成完（最后 close 会用最终全文 + 折叠的思考过程覆盖一次）
        onStream: function (kind, t) { live.push(kind, t); },

        onToolCall: function (tc, result, i) {
          stream.addCard(toolCardHtml(tc, result, i));
          live.flush();     // 卡片会重画整块，把当前正文贴回去，否则会被抹掉
          scrollBottom();
        }
      });
    }).then(function (r) {
      if (r.aborted) {
        pending.className = 'msg err';
        stream.close('<div class="warn">⏹ 已停止，这次分析不完整</div>');
        setSheetHint('已停止分析');
        return;
      }

      // ① 真失败：必须说清是哪一类（超时/网络/鉴权/服务端），并给出下一步
      //    以前只会甩一句「分析失败：请求超时」，用户没法判断要不要重试、改配置
      if (r.error) {
        pending.className = 'msg err';
        stream.close('<div class="warn">分析失败（' + esc(Agent._errorKindLabel(r.errorKind)) + '）：'
          + esc(r.error)
          + '<br>' + esc(Agent._errorKindHint(r.errorKind))
          + '<br>已用 ' + fmtSec(r.elapsedMs) + ' · ' + (r.steps || 0) + ' 步 · '
          + (r.toolCalls || 0) + ' 次工具</div>');
        setSheetHint('请求失败 · ' + fmtSec(r.elapsedMs));
        return;
      }

      // ② 时间到：已经拿到的内容照样给用户，但要讲明「为什么不完整、还剩什么办法」
      if (r.timeout) {
        var partial = r.text || r.reasoning || '';
        pending.className = partial ? 'msg' : 'msg err';
        stream.close((partial ? renderMarkdown(partial) : '')
          + '<div class="warn">⏱ 已达单次分析时限（'
          + Math.round((Agent._limits.TOTAL_TIMEOUT_MS || 0) / 1000) + 's），结论不完整。'
          + '已用 ' + fmtSec(r.elapsedMs) + ' · ' + r.steps + ' 步 · ' + r.toolCalls + ' 次工具'
          + (r.timeoutKind === 'tools' ? '（时间花在取数上，通常是行情源慢）'
                                       : '（时间花在等模型上，多半是推理模型太慢）')
          + '。<br>可以：① 把问题问窄一点，例如「只看日线」'
          + '② 换更快的非推理模型 ③ 再发一句「继续」，上下文还在。</div>');
        setSheetHint('已超时 · ' + fmtSec(r.elapsedMs));
        if (partial) {
          S.history.push({ role: 'user', content: question, ts: Date.now() });
          S.history.push({ role: 'assistant', content: partial, ts: Date.now() });
          S.history = window.Sessions ? window.Sessions.trim(S.history)
            : (S.history.length > 12 ? S.history.slice(-12) : S.history);
          saveCurrentSession();
          try { if (window.Drawer) window.Drawer.refresh(); } catch (e) {}
        }
        return;
      }

      var res = { text: r.text, reasoning: r.reasoning, finish: r.finish, maxTokens: S.cfg.maxTokens };
      stream.close(renderAiAnswer(res) + tailNote(r) + agentStatLine(r, askT0));

      S.history.push({ role: 'user', content: question, ts: Date.now() });
      S.history.push({ role: 'assistant', content: r.text || r.reasoning || '', ts: Date.now() });
      // 内存里保留完整对话（上限 200 条），喂给模型时再按 12 条裁剪
      S.history = window.Sessions ? window.Sessions.trim(S.history)
        : (S.history.length > 12 ? S.history.slice(-12) : S.history);
      saveCurrentSession();
      try { if (window.Drawer) window.Drawer.refresh(); } catch (e) {}

      // 兜底：模型可能忘了调 annotate_chart，正文里有价位就替它画上去
      var marks = extractLevels(r.text || '');
      if (marks.length) {
        S.aiLevels = marks;
        chart.setAiMarks(S.aiLevels, S.aiZones, S.aiMarks, S.aiFib, S.aiTexts);
      }
      setSheetHint('完成 · ' + r.steps + ' 步 / ' + r.toolCalls + ' 次工具调用');
      scrollToMsgTop(pending);
    }).then(function () {
      S.busy = false;
      S.curAiMsg = null;
      sendBtn.classList.remove('busy');
      sendBtn.innerHTML = sendBtnHtml();
    });
  }

  var DEFAULT_QUESTION = '请分析当前这只股票：结合各级别走势给出方向判断、关键价位和操作建议。';

  /** 交给 agent 的当前上下文（它可以用工具查别的股票，但不改变用户当前打开的这只） */
  function buildAgentContext(focusIdx) {
    var L = [];
    L.push('用户当前打开的股票：' + (S.name || '(未知)') + '（' + (S.code || '') + '），图表周期 ' + periodName(S.period));
    if (S.kl && S.kl.length) {
      var last = S.kl[S.kl.length - 1];
      L.push('图表已加载 ' + S.kl.length + ' 根，最新一根 ' + last.t + ' 收 ' + fmtPrice(last.c));
    }
    if (focusIdx != null && S.kl && S.kl[focusIdx]) {
      var k = S.kl[focusIdx];
      L.push('用户的光标停在这一根：' + k.t + ' 开' + fmtPrice(k.o) + ' 高' + fmtPrice(k.h)
        + ' 低' + fmtPrice(k.l) + ' 收' + fmtPrice(k.c) + '（用户说的"这根"通常指它）');
    }
    L.push('注意：分析别的股票请用工具传 code，不要改变用户当前打开的股票和图表。');
    return L.join('\n');
  }

  /** 工具调用卡片：一行摘要 + 可展开的完整返回 */
  function toolCardHtml(tc, result, i) {
    var argsTxt = '';
    try {
      argsTxt = JSON.stringify(tc.args || {});
      if (argsTxt.length > 60) argsTxt = argsTxt.slice(0, 60) + '…';
    } catch (e) { argsTxt = ''; }
    var body = String(result == null ? '' : result);
    var long = body.length > 2500;
    return '<details class="toolcall">'
      + '<summary>🔧 ' + esc(tc.name) + ' <span class="tc-args">' + esc(argsTxt) + '</span></summary>'
      + '<div class="tool-body">' + esc(body.slice(0, 2500)) + (long ? '\n…（展开内容已截断）' : '') + '</div>'
      + '</details>';
  }

  /**
   * 每条 agent 回答底部的状态行。
   * 明明白白写出"走了几步、调了几次工具" —— 否则用户根本判断不出
   * agent 到底有没有在工作（这也是之前"看不出跟以前有啥区别"的原因）。
   */
  /** 毫秒 → "12.3s"（统一口径，别到处写 toFixed） */
  function fmtSec(ms) {
    return ((ms || 0) / 1000).toFixed(1) + 's';
  }

  function agentStatLine(r, t0) {
    var sec = (r.elapsedMs != null ? (r.elapsedMs / 1000)
                                   : (Date.now() - (t0 || Date.now())) / 1000).toFixed(1);
    if (!r.toolCalls) {
      return '<div class="agent-stat warn-stat">agent · 本次未调用工具 · ' + sec + 's'
        + '<br>模型没有返回工具调用，已按纯文本回答。若反复如此，多半是模型或中转站不支持 function calling —— 换个支持 tools 的模型（DeepSeek / Qwen / GPT 均可）试试。</div>';
    }
    var parts = ['agent', r.steps + ' 步', r.toolCalls + ' 次工具', sec + 's'];
    if (r.slowestStepMs >= 1000) parts.push('最慢一步 ' + (r.slowestStepMs / 1000).toFixed(1) + 's');
    return '<div class="agent-stat">' + parts.join(' · ') + '</div>';
  }

  /** 步数/时限等收尾提示 */
  function tailNote(r) {
    var t = [];
    if (r.overStep) t.push('已达单次分析步数上限（' + Agent._limits.MAX_STEPS + ' 步）');
    if (r.timeout) t.push('已达单次分析时限');
    // ★ 工具失败以前只写在对话里、不汇总，用户根本注意不到「这条结论缺了数据」
    if (r.toolFailures && r.toolFailures.length) {
      var byName = {};
      // ★ v10.25：工具名来自模型返回，必须转义后再拼 HTML。
      //   同文件其它拼接点（renderMarkdown / toolCardHtml）都过了 esc，唯独这里漏了。
      r.toolFailures.forEach(function (f) {
        var nm = esc(String(f && f.name || '未知'));
        byName[nm] = (byName[nm] || 0) + 1;
      });
      t.push('有 ' + r.toolFailures.length + ' 次工具失败（'
        + Object.keys(byName).map(function (k) { return k + '×' + byName[k]; }).join('、')
        + '），这些数据本次没取到');
    }
    if (!t.length) return '';
    return '<div class="warn">' + t.join('；') + '，结论可能不完整。</div>';
  }

  /** 从 AI 回复里抽出关键价位 */
  /** 关键词 -> 标注类型 */
  function levelType(kind) {
    if (kind.indexOf('压力') === 0 || kind.indexOf('阻力') === 0) return 'resist';
    if (kind.indexOf('止损') === 0) return 'stop';
    if (kind.indexOf('目标') === 0 || kind.indexOf('止盈') === 0) return 'target';
    if (kind.indexOf('卖出') === 0) return 'resist';
    return 'support';   // 支撑 / 买入
  }

  /**
   * 从 AI 回复里抽出关键价位。
   * 兼容多种写法：
   *   支撑1: 10.03   压力位：10.35   止损 9.75
   *   支撑位在 10.03   目标价约 10.80   | 支撑1 | 10.03 |
   */
  function extractLevels(text) {
    if (!text) return [];
    var out = [];
    var seen = {};
    var KW = '支撑位?|压力位?|阻力位?|止损价?|目标价?|止盈价?|买入价?|卖出价?';
    var NUM = '([0-9]+(?:\\.[0-9]+)?)';
    var patterns = [
      // 关键词 + 可选序号 + 冒号/在/是/约/=
      new RegExp('(' + KW + ')\\s*[0-9一二三四五六]?\\s*(?:[:：]|在|是|约|≈|=)\\s*' + NUM, 'g'),
      // markdown 表格：| 支撑1 | 10.03 |
      new RegExp('\\|\\s*(' + KW + ')\\s*[0-9一二三四五六]?\\s*\\|\\s*' + NUM, 'g'),
      // 关键词 + 可选序号 + 空格 + 数字（"支撑1 10.03" / "压力位 10.35"）
      new RegExp('(' + KW + ')\\s*[0-9一二三四五六]?\\s+' + NUM, 'g'),
      // 英文表述（推理内容多为英文）：support at 10.03 / resistance: 10.35
      /\b(support|resistance|stop\s*loss|target)\b[^0-9\n]{0,14}?([0-9]+(?:\.[0-9]+)?)/gi
    ];

    for (var pi = 0; pi < patterns.length; pi++) {
      var re = patterns[pi];
      var m;
      while ((m = re.exec(text)) !== null) {
        var kind = m[1];
        var price = parseFloat(m[2]);
        if (!isFinite(price) || price <= 0) continue;
        var k = String(kind).toLowerCase();
        var type;
        if (k.indexOf('support') === 0) type = 'support';
        else if (k.indexOf('resistance') === 0) type = 'resist';
        else if (k.indexOf('stop') === 0) type = 'stop';
        else if (k.indexOf('target') === 0) type = 'target';
        else type = levelType(kind);
        var key = type + '_' + fx(price, 3);
        if (seen[key]) continue;
        seen[key] = 1;
        // 标签统一：中文去掉「位/价」后缀，英文转成中文
        var zhMap = { support: '支撑', resist: '压力', stop: '止损', target: '目标' };
        var short = String(kind).replace(/位$|价$/, '');
        if (/^[a-z]/i.test(short)) short = zhMap[type] || short;
        out.push({ price: price, label: short + ' ' + fx(price, 2), type: type });
      }
    }
    // 按价格从低到高排序，标注更有序
    out.sort(function (a, b) { return a.price - b.price; });
    return out;
  }

  // ==================== AI 回答的呈现 ====================

  /**
   * 原生桥回来的既可能是结构化 JSON（{text, reasoning, finish, maxTokens}），
   * 也可能是纯文本（老版本原生层 / 异常兜底）。这里统一成对象。
   */
  function parseAiResult(raw) {
    var s = (raw == null) ? '' : String(raw);
    var t = s.trim();
    if (t.charAt(0) === '{') {
      try {
        var o = JSON.parse(t);
        if (o && (typeof o.text === 'string' || typeof o.reasoning === 'string')) {
          return {
            text: o.text || '',
            reasoning: o.reasoning || '',
            finish: o.finish || '',
            maxTokens: o.maxTokens || 0
          };
        }
      } catch (e) { /* 不是 JSON，按纯文本处理 */ }
    }
    return { text: s, reasoning: '', finish: '', maxTokens: 0 };
  }

  /**
   * 组装一条 AI 回答：截断提示 + 正文 + 折叠的思考过程。
   * 思考过程默认收起 —— 推理模型的思考动辄几千字，直接铺开会把正文挤到屏幕外，
   * 用户每次都得先划过一大段"我们需要回答用户…"才能看到结论。
   */
  function renderAiAnswer(res) {
    var html = '';
    var truncated = (res.finish === 'length');

    if (truncated) {
      html += '<div class="warn">⚠️ 这条被 max_tokens 截断了（当前上限 '
            + (res.maxTokens || '?') + ' token）。'
            + '推理模型的思考过程也占用这个配额，建议调到 8192 以上再试。</div>';
    }
    if (res.text) {
      html += renderMarkdown(res.text);
    } else if (res.reasoning) {
      html += '<div class="warn">模型这次只输出了思考过程、没生成正文 —— 配额在「思考」阶段就用完了。'
            + '把「最大 tokens」调大（建议 8192 以上）后重试。</div>';
    }
    if (res.reasoning) {
      html += '<details class="reason"><summary>思考过程 · '
            + res.reasoning.length + ' 字（点开查看）</summary>'
            + '<div class="reason-body">' + renderMarkdown(res.reasoning) + '</div></details>';
    }
    return html || '<span class="typing"></span>';
  }

  /** 把某条消息的顶端对齐到面板顶部 —— 新回答从第一句开始读，而不是停在末尾 */
  function scrollToMsgTop(el) {
    var p = $('aiPanel');
    if (!p || !el) return;
    setTimeout(function () {
      var pr = p.getBoundingClientRect();
      var er = el.getBoundingClientRect();
      var next = p.scrollTop + (er.top - pr.top) - 6;
      p.scrollTop = next < 0 ? 0 : next;
    }, 60);
  }

  // ==================== Markdown 渲染 ====================
  function renderMarkdown(md) {
    if (!md) return '';
    var s = esc(md);
    s = s.replace(/```([\s\S]*?)```/g, function (_, c) { return '<pre><code>' + c + '</code></pre>'; });
    s = s.replace(/^#{1,6}\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
    s = s.replace(/(<li>[\s\S]*?<\/li>)/g, function (m) { return '<ul>' + m + '</ul>'; });
    s = s.replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>');
    // 价位高亮
    s = s.replace(/(支撑\d?|压力\d?|阻力\d?)\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/g,
      function (_, k, v) { return k + '：<span class="lvl lvl-down">' + v + '</span>'; });
    s = s.replace(/(压力\d?|阻力\d?)\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/g,
      function (_, k, v) { return k + '：<span class="lvl lvl-up">' + v + '</span>'; });
    s = s.replace(/(止损|目标)\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)/g,
      function (_, k, v) { return k + '：<span class="lvl lvl-up">' + v + '</span>'; });
    s = s.split(/\n{2,}/).map(function (p) {
      if (/^\s*<(h3|ul|ol|pre|li)/.test(p)) return p;
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    return s;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ==================== 快捷提问（可在设置里编辑） ====================

  /**
   * ==================== 常驻快捷分析 ====================
   *
   * 选这 8 个的理由：覆盖 A 股技术分析里最常见、也最容易被讲错的角度。
   * 刻意**避开**已有快捷提问里的：缠论、均线、多周期共振、风险止损、
   * 关键价位、量价关系 —— 那些留在「＋」菜单里，不重复占位置。
   *
   * 每一条都写死在提示词里的是「必须给什么」，因为模型最容易犯的错
   * 不是不会分析，而是给一堆形容词却落不到数字上。
   */
  var QUICK_ANALYSES = [
    {
      key: 'all',
      label: '全级别分析',
      primary: true,
      q: ''   // 空 = 走默认的全级别分析，与「空着发送」完全同一条路径
    },
    // ★ 缠论是这只 App 的主打（面板副标题就写着「行情 · 指标 · 缠论」），
    //   但快捷条原来八项全是经典技术分析，缠论只藏在「＋」菜单里（那个入口
    //   只把文字填进输入框、不发送），用户找不到 —— 原话：
    //   「现在的八个快捷分析方式，没有缠论判断啊」。
    //
    //   一条按钮同时覆盖两件事：**背驰判断** 与 **三类买卖点判定**。
    //   先定位中枢 → 再判背驰并分强度 → 再判几买几卖 → 最后必须给「能买/不能买」的结论。
    //   四步缺一不可：只写其中一步，模型就会只描述结构、不给操作建议。
    //   对应内置 skill：chan-divergence（背驰强度）+ chan-buysell（三类买卖点）。
    {
      key: 'chan',
      label: '缠论判断',
      q: '请只从缠论角度给出**可操作的判断**，按下面四步来，不要复述结构、不要罗列其他指标。'
        + '【一·定位】当前价在最近一个中枢的什么位置（上方/下方/中枢内），并写清 ZG、ZD 的具体数值。'
        + '【二·背驰】指出最近的顶背驰或底背驰是在比较哪两段走势（时间区间与高低点价位），'
        + '给出力度分档（弱/中/强/极强）与量化依据（MACD 面积或柱子高度、笔的长度与斜率对比），'
        + '然后判断这个背驰**有没有被中枢位置否决** —— 中枢内部的背驰往往只是中继，不能当买卖依据。'
        + '没有背驰就直说没有，不许编一个。'
        + '【三·买卖点】判断现在是几买或几卖（一买/二买/三买/一卖/二卖/三卖），'
        + '逐条列出成立依据，依据必须取自 analyze_chan 的真实字段'
        + '（中枢位置、笔的高低点是否依次抬高或降低、背驰），不许凭印象说。'
        + '【四·结论】一句话说清：现在能买 / 不能买 / 已持仓该怎么办，附对应价位与止损位。'
        + '三步条件都不满足时直接说「缠论层面不给买卖建议」，不要硬凑一个买点。'
    },
    {
      key: 'trend',
      label: '趋势定性',
      q: '请判断当前趋势：用道氏理论给出当前处于上升趋势/下降趋势/无趋势（震荡），'
        + '依据必须是「高点和低点是否依次抬高/降低」，并列出你用来判断的具体高点与低点价位。'
        + '如果高点低点无法确认，直说无法判断，不要硬套。'
    },
    {
      key: 'support',
      label: '支撑压力',
      q: '请给出当前的支撑位与压力位，每种最多 2 个，必须说明每个价位的来源'
        + '（前高/前低、缺口、密集成交区、均线、中枢上下沿、整数关口）。'
        + '按「支撑1: 数字（来源）」的格式输出，价格附近 1% 内的多个依据请合并成一个价位。'
    },
    {
      key: 'pattern',
      label: '形态识别',
      q: '请识别最近 60 根 K 线里是否出现经典形态：三角整理、旗形、头肩顶/底、'
        + '双重顶/底、圆弧、缺口。只有形态清晰且颈线/边界可以画出来时才算成立。'
        + '给形态名称 + 边界价位 + 突破方向 + 量能是否配合。没形态就直说没有，不要凑。'
    },
    {
      key: 'boll',
      label: '布林通道',
      q: '请分析布林带：当前价格在上中下轨的哪个位置、带宽是收窄还是扩张、'
        + '最近有没有触及上下轨、开口方向如何。'
        + '说明「收口后必有方向选择」这个前提，并给出上轨/中轨/下轨的具体数值作为后续判断基准。'
    },
    {
      key: 'kb',
      label: 'K线信号',
      q: '请检查最近 5 根 K 线的单根与组合信号：长上影/长下影、十字星、锤子线、吞没、'
        + '孕线、早晨之星/黄昏之星。逐个说明出现在什么位置（高位/低位/中枢内）、'
        + '成交量是否确认。没有就直说没有。'
    },
    {
      key: 'vol',
      label: '量能背离',
      q: '请做量价背离检查：最近 60 根里价格创新高但量能没有同步放大（顶背离）、'
        + '或价格创新低但量能萎缩（底背离）的情况。'
        + '给出背离发生的时间、价格、成交量对比倍数，并说明背离是否已被后续走势确认或否定。'
    },
    {
      key: 'fib',
      label: '黄金分割',
      q: '请用最近一段明确的上涨或下跌波段做黄金分割：先说明你选的起点和终点（日期+价格），'
        + '再给出 0.382 / 0.5 / 0.618 三个回撤位与 1.272 / 1.618 两个扩展位。'
        + '指出当前价格落在哪个区间，以及这些位与现有支撑压力是否重合。'
    }
  ];

  var DEFAULT_PROMPTS = [
    '请只从缠论角度分析：当前处在哪个中枢的什么位置？最近几笔的方向和力度如何？有没有背驰？现在是三买/三卖还是中枢震荡？给出明确的缠论买卖点判断和对应价位。',
    '请分析均线系统：当前各条均线的排列与斜率说明了什么？有没有金叉/死叉、均线粘合或发散？结合价格位置给出操作建议。',
    '请做多周期共振分析：结合当前周期的走势，判断更大级别趋势是否一致，指出共振点与背离点。',
    '请评估当前风险：如果现在买入，止损位放哪里？最坏情况回撤多少？用「支撑1: 数字」这样的关键价位格式输出。',
    '只输出关键价位，不要分析过程。用「支撑1: 数字」「压力1: 数字」的格式，给 2 个支撑、2 个压力、1 个止损。',
    '请分析最近 20 根 K 线的量价关系：放量的位置是上涨还是下跌？有没有量价背离？接下来量能需要什么条件才能确认方向。'
  ];

  /** 当前生效的快捷提问：用户改过就用改过的，否则用系统自带 */
  function getPrompts() {
    var p = S.cfg.prompts;
    if (Object.prototype.toString.call(p) === '[object Array]' && p.length) return p;
    return DEFAULT_PROMPTS;
  }

  /**
   * 「更多」＝快捷提问。内容渲染成底部面板的 HTML（不再用气泡菜单）。
   * 条目只把文字填进输入框，不直接发送。
   */
  function renderMoreMenu() {
    var list = getPrompts();
    var html = '<div class="act-hint">点条目只填入输入框，可以改完再发。</div>';
    for (var i = 0; i < list.length; i++) {
      html += '<button class="act-btn" data-act="prompt" data-i="' + i + '">'
        + esc(String(list[i])) + '</button>';
    }
    html += '<button class="act-btn" data-act="clear">清空对话</button>';
    return html;
  }

  /**
   * 记住"最后看的是哪只"。
   * 之前每次冷启都回到硬编码的 sh600000 —— 用户明明昨天看的是别的股票。
   * 存在 cfg 里跟 API 配置一起走 SharedPreferences，重装前不需要额外权限。
   */
  function persistStock() {
    try {
      if (!S.code) return;
      if (S.cfg.lastCode === S.code && S.cfg.lastName === S.name) return;  // 值没变就不写盘
      S.cfg.lastCode = S.code;
      S.cfg.lastName = S.name;
      if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg));
    } catch (e) { console.warn('persistStock', e); }
  }

  // ==================== 会话（一只股票一条） ====================

  /** 把当前对话落盘（每轮回答后、切股票前调用） */
  function saveCurrentSession() {
    if (!S.code || !window.Sessions) return Promise.resolve(false);
        var sumPair = (window.Sessions && window.Sessions.summarizeForStorage)
      ? window.Sessions.summarizeForStorage(S.history)
      : { summary: '' };
    S.summary = sumPair.summary;
    var msgs = S.history.map(function (m) {
      return { role: m.role, content: m.content, ts: m.ts || Date.now() };
    });
    return window.Sessions.save(S.code, S.name, msgs);
  }

  /** 把会话消息渲染进对话区（切股票时整体替换） */
  function renderConversation(messages) {
    var box = $('aiMessages');
    if (!box) return;
    var list = (messages || []).filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && m.content;
    });
    if (!list.length) {
      // 空态只有一处来源：ui_content.js 的 welcomeHtml，避免两套文案随版本漂移。
      box.innerHTML = (window.StockUIContent && window.StockUIContent.welcomeHtml)
        ? window.StockUIContent.welcomeHtml(window.__app)
        : '<div class="ai-hint">点 K 线选中位置，就能针对那一根继续问。</div>';
      return;
    }
    box.innerHTML = '';
    list.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
      if (m.role === 'user') div.textContent = m.content;
      else div.innerHTML = renderMarkdown(m.content);
      box.appendChild(div);
    });
    scrollBottom(true);
  }

  /** 载入某只股票的历史 */
  function loadSession(code, name) {
    if (!window.Sessions) return Promise.resolve();
    return window.Sessions.load(code, name).then(function (s) {
      var msgs = s.messages || [];
      S.history = msgs.map(function (m) { return { role: m.role, content: m.content }; });
      renderConversation(msgs);
      return s;
    });
  }

  /** 切换股票（抽屉点会话、或将来别处调用） */
  function switchStock(code, name) {
    if (!code) return Promise.resolve();
    if (code === S.code) return Promise.resolve();
    return saveCurrentSession().then(function () {
      S.code = code;
      S.name = name || '';
      persistStock();
      S.history = [];
      S.aiLevels = []; S.aiZones = []; S.aiMarks = []; S.aiFib = []; S.aiTexts = [];
      if (chart) { try { chart.clearAiMarks(); chart.render(); } catch (e) {} }
      try { touchWatch(code, name); } catch (e) {}
      return loadSession(code, name);
    }).then(function () {
      try { loadData(); } catch (e) { console.error('switch load', e); }
      try { if (window.Drawer) window.Drawer.refresh(); } catch (e) {}
    }).catch(function (e) {
      console.error('switchStock', e);
    });
  }

  /** 清空当前对话（删除会话后） */
  function clearConversation() {
    S.history = [];
    S.aiLevels = []; S.aiZones = []; S.aiMarks = []; S.aiFib = []; S.aiTexts = [];
    if (chart) { try { chart.clearAiMarks(); chart.render(); } catch (e) {} }
    renderConversation([]);
    setSheetHint('会话已删除');
  }

  // ==================== 光标与"问这根" ====================

  /**
   * 输入框随内容长高：两行起步（46px），最多 150px，再多就框内滚动。
   * ★ 必须先把 height 复位成 auto 再读 scrollHeight —— 否则行数变少时
   *   量到的是上一次的固定高度，框只会长不会缩（用户删字后留一大片空白）。
   */
  var INPUT_MIN_H = 46, INPUT_MAX_H = 150;
  function autoGrowInput() {
    var el = $('aiInput');
    if (!el || !el.style) return;
    el.style.height = 'auto';
    var h = el.scrollHeight || INPUT_MIN_H;
    if (h < INPUT_MIN_H) h = INPUT_MIN_H;
    if (h > INPUT_MAX_H) h = INPUT_MAX_H;
    el.style.height = h + 'px';
  }

  /** 发送底部输入框里的问题 */
  /** 渲染常驻快捷分析条。只在启动时调一次，不必每次重画。 */
  function renderQuickRow() {
    var box = $('quickChips');
    if (!box) return;
    var html = '';
    for (var i = 0; i < QUICK_ANALYSES.length; i++) {
      var q = QUICK_ANALYSES[i];
      html += '<button class="quick-chip' + (q.primary ? ' primary' : '') + '"'
        + ' data-qi="' + i + '" type="button">' + esc(q.label) + '</button>';
    }
    box.innerHTML = html;
  }

  /**
   * 点常驻按钮 = 直接发送。
   *
   * 为什么不先填进输入框：
   *   这排按钮的意义就是「一下就到结果」。要改条件的场景由「＋」里的
   *   快捷提问承担（那里是只填不发）。两种交互各有各的用途，别混。
   *
   * ★ 上下文：如果用户在图上选过某根 K 线，就针对那一根问；
   *   否则问整只股票的最新走势（传 null 让 askAI 自己取最新）。
   */
  function runQuickAnalysis(idx) {
    var q = QUICK_ANALYSES[idx];
    if (!q) return;
    if (S.busy) { stopAsk(); return; }        // 与发送按钮一致：忙碌时再点 = 停止
    if (!S.cfg.baseUrl || !S.cfg.apiKey) {
      addMsg('err', '请先在右上角 ⚙ 里配置 AI 的 API 地址和 Key。');
      openSettings();
      return;
    }
    if (!S.cfg.model) {
      addMsg('err', '还没选模型。请在 ⚙ 设置里点「获取」拉取模型列表后选择。');
      openSettings();
      return;
    }
    if (!S.kl.length) {
      addMsg('err', '还没有加载到走势数据。点一下上方周期栏重新拉一次，或换一只股票再回来。');
      return;
    }
    // 清掉输入框里残留的草稿？不清 —— 用户可能正打着字，误点按钮不该毁掉草稿。
    var fi = hasPicked() ? pickFocusIdx() : null;
    autoExpandSheet();
    askAI(q.q || DEFAULT_QUESTION, fi);
  }

  function sendInput() {
    var box = $('aiInput');
    var q = (box.value || '').trim();
    // 空着直接发 = 让 AI 联立所有级别做一次完整判断
    // （原来是上面那个占满一行的「AI 解读缠论走势」按钮干的事）
    if (!q) q = '请联立各个级别的走势，给出方向判断、关键价位和操作建议。';
    box.value = '';
    autoGrowInput();
    try { box.focus(); } catch (e) {}   // 便于连续追问
    var fi = pickFocusIdx();
    askAI(q, fi >= 0 ? fi : null);
  }

  /**
   * 当前盯着的是哪一根：
   *   十字光标（长按出来的）优先 → 其次轻点选中的 → 都没设就取最新一根。
   * 最后这条回退很关键：用户没在图上点过任何地方时，"问这根"应该问最新的行情，
   * 而不是什么都不做。
   */
  function pickFocusIdx() {
    if (chart && chart.crossIdx >= 0 && S.kl[chart.crossIdx]) return chart.crossIdx;
    if (chart && chart.selIdx >= 0 && S.kl[chart.selIdx]) return chart.selIdx;
    return S.kl && S.kl.length ? S.kl.length - 1 : -1;
  }

  /** 是否真的"选"过某根（用于区分"问这根"和"问最新"） */
  function hasPicked() {
    return !!(chart && (chart.crossIdx >= 0 || chart.selIdx >= 0));
  }

  /**
   * 刷新对话区上方的上下文 chip。
   * 只有真的选中过某根 K 线才出现 —— 没选的时候它既是视觉噪声，
   * 又和「空着发送＝全级别分析」重复。
   */
  function refreshCtxChip(explicitIdx) {
    var row = $('ctxRow'), chip = $('ctxChip');
    if (!row || !chip) return;
    // 优先用调用方明确指的那一根（showCursorInfo 传进来），
    // 否则回退到当前光标 —— 两者在真实手势里是同一个索引。
    var idx = (typeof explicitIdx === 'number' && explicitIdx >= 0) ? explicitIdx : pickFocusIdx();
    var k = S.kl && S.kl[idx];
    if (!hasPicked() || !k) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    chip.setAttribute('data-idx', String(idx));
    chip.textContent = '问 ' + shortDate(k.t) + ' ▸';
  }

  /** 取消选中（chip 右侧 ✕）：清掉十字与轻点选中，chip 随之消失 */
  function clearFocus() {
    if (!chart) return;
    chart.crossIdx = -1;
    chart.selIdx = -1;
    try { chart.render(); } catch (e) {}
    var ci = $('crosshairInfo');
    if (ci) ci.classList.add('hidden');
    hideAskCandle();
    refreshCtxChip();
    setSheetHint('已取消选中');
  }

  /** 按钮上的短日期：2026-07-27 → 07-27；分钟线保留到分钟（与图上标签一致） */
  function shortDate(t) {
    var s = String(t == null ? '' : t);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (!m) return s;
    return m[4] ? (m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : (m[2] + '-' + m[3]);
  }

  /**
   * 统一刷新光标信息条 +「问这根」按钮。
   * 轻点、长按出十字、拖动十字都走这里 —— 三者指的是同一根 K 线，
   * 以前只有轻点会更新按钮，长按选中的那根问出去还是旧索引。
   */
  function showCursorInfo(idx) {
    var k = S.kl[idx];
    if (!k) return;
    var el = $('crosshairInfo');
    el.classList.remove('hidden');
    var pct = '';
    if (idx > 0 && S.kl[idx - 1] && S.kl[idx - 1].c) {
      var prev = S.kl[idx - 1].c;
      pct = ' (' + fx((k.c - prev) / prev * 100, 2) + '%)';
    }
    el.textContent = k.t + ' 开' + fmtPrice(k.o) + ' 高' + fmtPrice(k.h)
      + ' 低' + fmtPrice(k.l) + ' 收' + fmtPrice(k.c) + pct;
    refreshCtxChip(idx);
    renderIndicatorValues();
    // 图表模式下没有内嵌 AI 面板，给一个直接问 Eta 的入口
    if (CHART_ONLY) {
      var ab = $('askCandleBtn');
      if (ab) ab.classList.remove('hidden');
    }
  }

  function hideAskCandle() {
    var ab = $('askCandleBtn');
    if (ab) ab.classList.add('hidden');
  }

  /**
   * 图表标注入口：Eta 模型通过原生桥把一段 JSON 传进来。
   * 结构（都可省略）：
   * {
   *   "levels": [{"price":10.5,"label":"支撑","type":"support"}],
   *   "zones":  [{"from":10.2,"to":10.4,"label":"中枢"}],
   *   "marks":  [{"date":"2026-11-12","price":10.2,"label":"一买","type":"buy"}],
   *   "fib":    [{"fromDate":"2026-10-08","fromPrice":12.3,
   *              "toDate":"2026-11-12","toPrice":10.2,"ratios":[0.382,0.5,0.618]}]
   * }
   * 注意：marks 的 date 用 K 线的时间（日线 2026-11-12，分钟 2026-11-12 10:30 也行）。
   */
  function applyAnnotations(obj) {
    if (!chart || !obj) return false;
    var lv = [], zn = [], mk = [], fb = [], tx = [];
    (obj.levels || []).forEach(function (x) {
      if (x && isFinite(+x.price)) lv.push({ price: +x.price, label: x.label || '', type: x.type || '' });
    });
    (obj.zones || []).forEach(function (x) {
      if (x && isFinite(+x.from) && isFinite(+x.to)) {
        zn.push({ from: +x.from, to: +x.to, label: x.label || '' });
      }
    });
    (obj.marks || []).forEach(function (x) {
      if (x && (x.date || x.idx != null)) {
        mk.push({
          date: x.date, idx: x.idx,
          price: isFinite(+x.price) ? +x.price : null,
          label: x.label || '', type: x.type || ''
        });
      }
    });
    (obj.fib || []).forEach(function (x) {
      if (x && isFinite(+x.fromPrice) && isFinite(+x.toPrice)) {
        fb.push({
          fromDate: x.fromDate, toDate: x.toDate,
          fromPrice: +x.fromPrice, toPrice: +x.toPrice,
          ratios: x.ratios || [0.382, 0.5, 0.618]
        });
      }
    });
    (obj.texts || []).forEach(function (x) {
      if (x && x.text && (x.date || x.idx != null)) {
        tx.push({
          date: x.date, idx: x.idx,
          price: isFinite(+x.price) ? +x.price : null,
          text: String(x.text),
          color: x.color || '', size: isFinite(+x.size) ? +x.size : 9,
          align: x.align || 'center'
        });
      }
    });
    // ★ shapes：shapes.js 那套完整图元（trendline/ray/arrow/rect/hline/text/dot）。
    //   技能文档 chart-drawing.md 一直教模型用这个格式，但以前 applyAnnotations 不认它，
    //   模型照着写就什么也画不出来。这里把它接进来。
    var shp = [];
    (obj.shapes || []).forEach(function (x) {
      if (x && x.type) shp.push(x);
    });
    if (!lv.length && !zn.length && !mk.length && !fb.length && !tx.length && !shp.length) return false;
    if (obj.replace === false) {   // 叠加模式：保留上一次的标注
      lv = S.aiLevels.concat(lv);
      zn = S.aiZones.concat(zn);
      mk = S.aiMarks.concat(mk);
      fb = S.aiFib.concat(fb);
      tx = (S.aiTexts || []).concat(tx);
    }
    S.aiLevels = lv; S.aiZones = zn; S.aiMarks = mk; S.aiFib = fb; S.aiTexts = tx;
    chart.setAiVisible(true);
    chart.setAiMarks(S.aiLevels, S.aiZones, S.aiMarks, S.aiFib, S.aiTexts);
    if (shp.length && chart.setShapes) {
      S.aiShapes = (obj.replace === false) ? (S.aiShapes || []).concat(shp) : shp;
      chart.setShapes(S.aiShapes);
      if (chart.setShapesVisible) chart.setShapesVisible(true);
    }
    return true;
  }

  /** 给 Eta 模型读取当前图：最后 N 根 K 线 + 缠论信号/买卖点 + 当前标注 */
  window.StockChartSnapshot = function (limit) {
    if (!chart || !S.kl || !S.kl.length) return null;
    var n = Math.max(20, Math.min(limit || 160, 300));
    var bars = S.kl.slice(-n).map(function (k) {
      return { t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
    });
    var chan = null;
    if (S.chan) {
      chan = {
        signals: (S.chan.signals || []).slice(-40),
        points: (S.chan.points || []).slice(-40),
        boxes: (S.chan.boxes || []).slice(-6).map(function (b) {
          return { s: b.s, e: b.e, zg: +b.zg.toFixed(3), zd: +b.zd.toFixed(3), tag: b.tag };
        })
      };
    }
    return {
      code: S.code, name: S.name, period: S.period,
      totalBars: S.kl.length, bars: bars, chan: chan,
      indOn: S.indOn,
      ai: { levels: S.aiLevels, zones: S.aiZones, marks: S.aiMarks, fib: S.aiFib }
    };
  };

  window.StockAnnotate = {
    apply: function (payload) {
      try {
        var obj = (typeof payload === 'string') ? JSON.parse(payload) : payload;
        return applyAnnotations(obj) ? 'ok' : 'empty';
      } catch (e) {
        return 'bad-json: ' + (e && e.message ? e.message : e);
      }
    },
    clear: function () {
      S.aiLevels = []; S.aiZones = []; S.aiMarks = []; S.aiFib = []; S.aiTexts = [];
      if (chart) { chart.clearAiMarks(); chart.render(); }
      return 'ok';
    }
  };

  // ==================== UI ====================

  /**
   * 一条 agent 消息的渲染器：工具卡片一路追加，最后一次性写上结论。
   *
   * ★ 为什么要把「渲染」和「封口」合起来：
   *   之前用一个 pendingClosed 布尔量来防止后续工具回调改到最终结果，
   *   结果在渲染最终回答**之前**就把标志置了位 —— 结论被自己的守卫吞掉，
   *   界面上只剩一排工具卡片、一个字都没有。
   *   现在 close() 内部保证「先画、再封」，这个顺序错误在结构上无法再现。
   */
  /**
   * 流式回答的「实时视图」。
   *
   * 为什么不每次增量都直接 render：
   *   markdown 解析 + innerHTML 替换是有成本的，模型一秒能吐几十个碎片，
   *   每个碎片都重画会让长回答明显发卡。这里按时间节流（默认 60ms），
   *   既保留「字在往外冒」的观感，又不会把主线程占满。
   *
   * 为什么收到 'step' 要清空：
   *   agent 是多步的，每一轮模型都会输出自己的正文。上一轮的「我先看一下行情」
   *   如果和这一轮的结论拼在一起，读起来就是错乱的。
   *
   * 为什么没有正文时展示思考过程：
   *   推理模型（DeepSeek-R1 / QwQ 等）的等待时间几乎全在 reasoning 阶段，
   *   正文要等它想完才开始。只等正文的话，用户要对着转圈干等几十秒。
   */
  function makeLiveView(stream, opts) {
    var gap = (opts && opts.minGapMs != null) ? opts.minGapMs : 60;
    // 调度器可注入：真实环境用 setTimeout，测试里换成手动触发以便确定性验证
    var schedule = (opts && opts.schedule) || function (fn, ms) { return setTimeout(fn, ms); };
    var text = '', reason = '', last = 0, timer = null;

    function html() {
      if (text) return renderMarkdown(text) + '<span class="typing"></span>';
      if (reason) {
        return '<details class="reason live" open><summary>思考中… ' + reason.length
          + ' 字</summary><div class="reason-body">'
          + renderMarkdown(tailText(reason, 6000)) + '</div></details>';
      }
      return '<span class="typing"></span>';
    }

    function paint(force) {
      if (!stream) return false;
      var now = Date.now();
      var wait = gap - (now - last);
      if (!force && wait > 0) {
        // ★ 尾沿补偿：这一片被节流了，必须安排一次补画。
        //   少了它就会出真 bug —— 模型只吐一片、之后隔很久才吐下一片时，
        //   这一片永远等不到下一次 push 来触发渲染，用户看到的是一片空白。
        //   连续被节流也只排一次（timer 非空就不再排），不会堆出一串定时器。
        if (timer == null) {
          timer = schedule(function () { timer = null; paint(true); }, wait);
        }
        return false;
      }
      last = now;
      var ok = stream.render(html());
      scrollBottom();
      return ok;
    }

    return {
      push: function (kind, t) {
        if (kind === 'step') { text = ''; reason = ''; last = 0; return paint(true); }
        if (kind === 'reasoning') reason += (t || '');
        else text += (t || '');
        return paint(false);
      },
      flush: function () { return paint(true); },
      text: function () { return text; },
      reasoning: function () { return reason; }
    };
  }

  /** 只取尾部 n 个字符：思考过程可能上万字，实时预览没必要全渲染 */
  function tailText(s, n) {
    s = String(s == null ? '' : s);
    return s.length <= n ? s : '…' + s.slice(s.length - n);
  }

  function makeStream(box) {
    var cards = '';
    var closed = false;
    function paint(ansHtml) {
      if (!box) return false;
      box.innerHTML = (cards ? '<div class="agent-tools">' + cards + '</div>' : '')
        + (ansHtml == null ? '<span class="typing"></span>' : ansHtml);
      return true;
    }
    return {
      render: function (ansHtml) { return closed ? false : paint(ansHtml); },
      addCard: function (html) { if (closed) return false; cards += html; return paint(); },
      close: function (ansHtml) {
        if (closed) return false;
        paint(ansHtml);          // ← 先画
        closed = true;           // ← 再封口，顺序不能颠倒
        return true;
      },
      isClosed: function () { return closed; }
    };
  }

  function addMsg(type, text) {
    var box = $('aiMessages');
    var hint = box.querySelector('.ai-hint');
    if (hint) hint.remove();
    var div = document.createElement('div');
    div.className = 'msg ' + type;
    if (type === 'ai') div.innerHTML = renderMarkdown(text);
    else div.textContent = text;
    box.appendChild(div);
    scrollBottom();
    return div;
  }

  function scrollBottom(force) {
    var p = $('aiPanel');
    if (!p) return;
    setTimeout(function () {
      // 用户正在往上翻看历史时不要强制拉回底部，除非 force
      var nearBottom = (p.scrollHeight - p.scrollTop - p.clientHeight) < 120;
      if (force || nearBottom) p.scrollTop = p.scrollHeight;
    }, 40);
  }

  /**
   * 状态提示改为浮层：面板顶部那条标题栏已经删掉，提示不能占布局高度，
   * 显示 2 秒后自动消失（拖拽手柄上方浮一下即可）。
   */
  function setSheetHint(t, ms) {
    var el = $('sheetToast');
    if (!el) return;
    if (!t) { el.classList.add('hidden'); return; }
    el.textContent = t;
    el.classList.remove('hidden');
    if (S.hintTimer) clearTimeout(S.hintTimer);
    S.hintTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2600);
  }

  function fmtVol(v) {
    if (!v && v !== 0) return '--';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return String(Math.round(v));
  }

  /** 安全 toFixed：任何非数值都返回 '--'，杜绝 "Cannot read properties of undefined" */
  function fx(v, d) {
    if (typeof v !== 'number' || !isFinite(v)) return '--';
    return v.toFixed(d);
  }
  /** 安全数值（用于计算前兜底） */
  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : (def || 0);
  }

  // fmtPrice 兜底：chart.js 会挂到 window，但初始化顺序异常时可能还没就绪
  function fmtPrice(v) {
    if (typeof window.fmtPrice === 'function') {
      try { return window.fmtPrice(v); } catch (e) { }
    }
    if (v == null || !isFinite(v)) return '--';
    var a = Math.abs(v);
    if (a >= 100) return fx(v, 2);
    if (a >= 10) return fx(v, 2);
    return fx(v, 3);
  }

  function periodName(p) {
    // m1 已从界面移除（分时足够，1分钟噪声太大、请求量也翻倍），
    // 但映射保留：老会话里存过 m1 的用户恢复时不会显示成裸代码。
    return ({ minute: '分时', m1: '1分钟', m5: '5分钟', m15: '15分钟', m30: '30分钟',
      m60: '60分钟', day: '日K', week: '周K', month: '月K' })[p] || p;
  }

  // ==================== 抽屉：拖拽调节高度 ====================
  var SHEET = {
    h: 300,          // 当前高度 px（初始＝空态高度）
    min: 44,         // 最小（只剩抓手）
    max: 0,          // 最大（运行时算）
    dragging: false,
    startY: 0,
    startH: 0,
    moved: false
  };

  /**
   * 对话区可用高度。
   *
   * 上限要按「当前是不是展开态」分别算，因为展开态会收掉顶部两行：
   *
   *   常规态：视口 - 顶栏 - 行情卡 - 周期栏 - 图表最小高度
   *   展开态：视口 - 周期栏（只留分时/K线切换）- 图表最小高度
   *
   * ★ 旧实现只有一条公式，且固定扣掉顶部三行 —— 于是在 812pt 的机器上，
   *   展开档算出来的上限是 812-174-120 = 518，而 88% 要 715，
   *   被 min() 一刀切回 518。用户点抓手「变大了」，实际只多出一百多像素，
   *   所以才会说「内容框还是小了，看得很累」。
   */
  var SHEET_TOP_ROWS = 174;      // 顶部两行实际占用（含各自 padding）
  var SHEET_MIN_CHART = 120;    // 常规态：图表至少留这么高
  // 展开态只留周期栏，图表可以压得更扁 —— 这一档用户就是要读字
  // ★ 展开态图表下限。原来 96px（"够看趋势方向"），但用户实测后明确说
  //   "K 线图太小看不清" —— 96px 扣掉均线图例 22 + 缠论状态条 14 + 量/副图，
  //   价格区只剩 40px 级别，蜡烛就是一条线。
  //   抬到 150px 后价格区约 80~100px，蜡烛才有实体高度。
  //   代价是对话区少 54px，但对话是滚动的，K 线不是。
  var SHEET_MIN_CHART_FULL = 150;

  /** 当前顶部占了多少像素（展开态只算周期栏） */
  function topRowsHeight(expanded) {
    var period = document.querySelector('.periodbar');
    var periodH = period ? period.offsetHeight : 0;
    if (expanded) return periodH || 46;
    var topbar = document.querySelector('.topbar');
    var quote = document.querySelector('.quote-card');
    var h = (topbar ? topbar.offsetHeight : 0)
          + (quote ? quote.offsetHeight : 0)
          + periodH;
    return h || SHEET_TOP_ROWS;
  }

  /** 面板高度上限（供 applySheetHeight 与拖拽吸附共用） */
  function sheetMaxHeight(expanded) {
    var vh = window.innerHeight || 640;
    var minChart = expanded ? SHEET_MIN_CHART_FULL : SHEET_MIN_CHART;
    return Math.max(160, vh - topRowsHeight(expanded) - minChart);
  }

  /**
   * 展开态：收掉顶栏与行情卡，只留周期栏 + 图表 + 对话区。
   * 用 class 而不是内联 style，方便 CSS 里做过渡，也方便一键还原。
   */
  function setSheetFullMode(on) {
    var app = document.getElementById('app');
    if (!app) return;
    if (on) app.classList.add('sheet-full');
    else app.classList.remove('sheet-full');
    // ★ 展开态同时开图表紧凑模式：图表变矮时若仍用通达信默认比例
    //   （价格 63% / 量 15% / 副图 22%），价格区只剩 100px 出头，蜡烛就是一条细线。
    //   紧凑模式把量/副图压到 10%/14%，价格区抬到 ~76%。
    if (chart && chart.setCompactLayout) {
      try { chart.setCompactLayout(on); } catch (e) {}
    }
    // 收掉顶部会让图表容器变高，画布要立刻按新尺寸重算。
    // 这里还要"下一帧再量一次"：class 刚加上时 DOM 还没完成重排，
    // 立刻量到的可能是布局完成前的旧高度。
    if (chart) {
      try { chart.resize(); } catch (e) {}
      var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      raf(function () { try { chart.resize(); } catch (e) {} });
      setTimeout(function () { try { chart.resize(); } catch (e) {} }, 260);
    }
  }

  /** 应用高度（只改对话区自身高度，顶部两行与图表各让一点） */
  function applySheetHeight(h, noAnim) {
    var expanded = !!S.sheetExpanded;
    var maxH = sheetMaxHeight(expanded);
    h = Math.max(44, Math.min(maxH, h));
    SHEET.h = h;
    var sheet = $('aiSheet');
    if (!sheet) return;
    if (noAnim) sheet.classList.add('dragging');
    // ★ 直接设 height：不用 CSS 变量（变量解析失败会回落 auto，面板就塌了）
    sheet.style.height = h + 'px';
    // 非覆盖式布局：面板高度变化会改变图表容器高度，
    // ResizeObserver 会自动重算；这里同步调一次让拖动更跟手。
    if (chart) chart.resize();
    if (noAnim) {
      setTimeout(function () { sheet.classList.remove('dragging'); }, 0);
    }
  }

  // 空会话只占这么多：一屏三分之一留给一句"点下面开始"太浪费
  var SHEET_EMPTY_H = 300;   // 空态要放得下欢迎卡（标题+说明+主按钮），实测 230 会把主按钮裁掉
  // 真的开始对话后展开到这么多
  var SHEET_DEFAULT_RATIO = 0.42;
  // 抓手两档里的"全屏档"：读长结论时拉到这儿
  var SHEET_FULL_RATIO = 0.88;

  /** 点抓手：在「常规」与「全屏」之间切换 */
  function toggleSheet(force) {
    var expand = (force === undefined) ? !S.sheetExpanded : force;
    S.sheetExpanded = expand;
    S.sheetPinned = true;        // 用户自己动过，就别再被程序改回去
    // ★ 必须先切 full 模式再算高度：上限公式依赖「展开态只留周期栏」
    setSheetFullMode(expand);
    var vh = window.innerHeight || 640;
    if (expand) {
      // 全屏档：直接顶到上限（上限已经按"只留周期栏"算过，不用再打 88% 折扣）
      applySheetHeight(sheetMaxHeight(true));
      setSheetHint('已展开全屏（点抓手收起，露出行情卡）');
    } else {
      applySheetHeight(Math.min(SHEET_EMPTY_H, Math.round(vh * SHEET_DEFAULT_RATIO)));
      setSheetHint('已回到常规高度（点抓手全屏）');
    }
  }

  /** 首次发问时把面板张开；用户手动调过高度就不动 */
  function autoExpandSheet() {
    if (S.sheetPinned) return;
    var vh = window.innerHeight || 640;
    var want = Math.round(vh * SHEET_DEFAULT_RATIO);
    if (SHEET.h < want - 20) applySheetHeight(want);
  }

  /** 绑定拖拽手势 */
  function bindSheetDrag() {
    var grip = $('sheetGrip');
    var bar = $('sheetBar');
    var sheet = $('aiSheet');
    if (!grip || !bar || !sheet) return;

    var startY = 0, startH = 0, dragging = false, moved = false;

    /**
     * ★ 真机上「点抓手没反应」的三个坑，逐个治：
     *
     * 1) 抖动判定太敏感：原来 touchmove 里 Math.abs(dy) > 3 就置 moved=true。
     *    手指按在抓手上一秒钟，几乎必然有 3px 以上抖动，于是 touchend 走的是
     *    「拖动吸附」分支、永远进不了「点击切换」—— 用户看到的就是「点了没变」。
     *    现在把点击判定收紧：位移 < 10px **且** 时长 < 350ms 才算点击。
     *
     * 2) touchend 里没有 preventDefault，部分 WebView 会紧接着补发一个 click，
     *    在「拖完」之后再触发一次切换，把刚拖好的高度又弹回去。
     *
     * 3) mouseup 挂在 document 上，触摸设备会补发模拟 mouse 事件，
     *    一次操作可能走两遍 onEnd（touch 一遍 + mouse 一遍）。
     *    加时间戳去重，250ms 内的第二次直接忽略。
     */
    var lastEndAt = 0;
    var DOWN_SLOP = 10;      // 位移小于这个算「没拖」
    var TAP_MS = 350;        // 且按住时间短于这个

    function onStart(e) {
      if (e.target === grip || (grip.contains && grip.contains(e.target))) {
        // 点在抓手上：一定当点击（抓手本身没有可拖的语义区分）
      }
      var t = e.touches ? e.touches[0] : e;
      startY = t.clientY;
      startH = SHEET.h;
      dragging = true;
      moved = false;
      startAt = Date.now();
      sheet.classList.add('dragging');
      if (e.cancelable) e.preventDefault();
    }

    var startAt = 0;

    function onMove(e) {
      if (!dragging) return;
      var t = e.touches ? e.touches[0] : e;
      var dy = startY - t.clientY;   // 向上拖为正
      if (Math.abs(dy) > DOWN_SLOP) moved = true;
      // 拖过视口 55% 就提前切到「展开态」的上限模型，
      // 否则手指往上走，高度会先撞到常规态上限停住 —— 用户感觉"拖不动了"。
      var vh0 = window.innerHeight || 640;
      var wantFull = (startH + dy) > vh0 * 0.55;
      if (wantFull !== !!S.sheetExpanded) {
        S.sheetExpanded = wantFull;
        setSheetFullMode(wantFull);
      }
      applySheetHeight(startH + dy, true);
      if (e.cancelable) e.preventDefault();
    }

    function onEnd(e) {
      if (!dragging) return;
      // 触摸结束后浏览器会补发 mousedown/mouseup，去重避免一次操作触发两遍
      var now = Date.now();
      if (now - lastEndAt < 250) { dragging = false; return; }
      lastEndAt = now;

      dragging = false;
      sheet.classList.remove('dragging');
      S.sheetPinned = true;      // 用户手动调过高度，之后不再自动展开

      var quick = (now - startAt) < TAP_MS;
      if (!moved && quick) {
        // 视为点击：在常规 / 全屏两档之间切换
        if (e && e.cancelable) e.preventDefault();
        toggleSheet();
        return;
      }

      // 吸附：只有两档 —— 常规 42% 与 全屏（顶到上限），就近取整
      var vh2 = window.innerHeight || 640;
      var fullH = sheetMaxHeight(true);
      var normalH = Math.round(vh2 * SHEET_DEFAULT_RATIO);
      if (SHEET.h < 90) {
        S.sheetExpanded = false;
        setSheetFullMode(false);
        applySheetHeight(SHEET_EMPTY_H);
        setSheetHint('已回到常规高度（点抓手全屏）');
        return;
      }
      var useFull = Math.abs(fullH - SHEET.h) <= Math.abs(normalH - SHEET.h);
      S.sheetExpanded = useFull;
      setSheetFullMode(useFull);
      applySheetHeight(useFull ? fullH : normalH);
      setSheetHint(useFull ? '已展开全屏（点抓手收起）' : '已回到常规高度（点抓手全屏）');
    }

    // 抓手 + 整条标题栏都可拖
    [grip, bar].forEach(function (el) {
      el.addEventListener('touchstart', onStart, { passive: false });
      el.addEventListener('touchmove', onMove, { passive: false });
      el.addEventListener('touchend', onEnd, { passive: false });
      el.addEventListener('touchcancel', onEnd, { passive: true });
      el.addEventListener('mousedown', onStart);
    });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);

    /**
     * ★ 兜底：抓手上再挂一个明确的 click 监听。
     *
     * 上面那套 touch 逻辑在真机 WebView 里仍然可能整条链失效
     * （某些 ROM 的 WebView 在 touch-action:none 的元素上不派发 touchend）。
     * click 是最不可能失灵的通道 —— 它由浏览器合成，不依赖我们的 touch 处理。
     * 用 250ms 去重和上面的 touchend 互斥，点一次只会生效一次。
     */
    grip.addEventListener('click', function (e) {
      var now = Date.now();
      if (now - lastEndAt < 250) return;   // touchend 刚处理过
      lastEndAt = now;
      if (e && e.cancelable) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      S.sheetPinned = true;
      toggleSheet();
    });
  }

  // ==================== 底部面板（指标 / 快捷提问 / ⋯ 共用） ====================

  /**
   * 全应用只有一种弹层：底部面板。
   * 之前是「居中模态 + 底部操作面板 + 气泡菜单 + 可拖抽屉」四套并存，
   * 每种关法都不一样，用户得记四遍。现在统一到这一个。
   */
  function openBottomSheet(title, bodyHtml) {
    var s = $('actSheet'), t = $('actTitle'), b = $('actBody');
    if (!s) return false;
    if (t) t.textContent = title || '';
    if (b) b.innerHTML = bodyHtml || '';
    s.classList.remove('hidden');
    return true;
  }

  function closeBottomSheet() {
    var s = $('actSheet');
    if (s) s.classList.add('hidden');
  }

  function bottomSheetOpen() {
    var s = $('actSheet');
    return !!(s && !s.classList.contains('hidden'));
  }

  /**
   * 底部面板的三条关闭路径：取消按钮、点遮罩、返回键。
   * ★ 这三条以前只接了返回键 —— 「取消」和「点遮罩」压根没绑事件，
   *   用户点了毫无反应，只能靠返回键或再点一次按钮。
   */
  function bindBottomSheet() {
    var sheet = $('actSheet');
    if (!sheet) return;

    // 点遮罩 / 点面板外的空白：关闭
    on('actSheet', 'click', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === 'actCancel') { closeBottomSheet(); return; }
      if (t.classList && t.classList.contains('act-mask')) { closeBottomSheet(); return; }
      // 面板容器本身（不是里面的内容）也算外面
      if (t === sheet) { closeBottomSheet(); return; }
    });

    // 指标行：整行可点
    on('actSheet', 'click', function (e) {
      if (onIndicatorRowTap(e)) e.stopPropagation();
    });
  }

  // 指标清单：键、显示名、一句说明。顺序＝面板里的顺序。
  function indList() {
    // 图表模式下没有 AI 分析通道；量均线并入成交量，不再单独出现
    return IND_LIST.filter(function (it) {
      if (it[0] === 'VOLMA') return false;
      if (CHART_ONLY && it[0] === 'AILINE') return false;
      return true;
    });
  }

  var IND_LIST = [
    ['MA', '均线', '6 条细线（5/10/20/60/120/250）'],
    ['BOLL', '布林带', '上轨 / 中轨 / 下轨'],
    ['MACD', 'MACD', '副图：DIF、DEA、柱'],
    ['KDJ', 'KDJ', '副图'],
    ['RSI', 'RSI', '副图'],
    ['VOLMA', '量均线', '成交量上的 5 / 10 均量'],
    ['CHAN', '缠论', '笔、中枢、背驰（细金黄线）'],
    ['AILINE', 'AI 价位', 'AI 给的支撑 / 压力 / 止损画到图上']
  ];

  // ==================== 指标横条（主图 / 副图） ====================
  var MAIN_IND_KEYS = ['MA', 'BOLL', 'CHAN', 'HOLLOW'];
  var SUB_IND_KEYS = ['VOL', 'MACD', 'KDJ', 'RSI'];

  function indLabel(key) {
    if (key === 'VOL') return '成交量';
    // 空心红K 不是技术指标，是 K 线画法；放在主图条末尾当开关用
    if (key === 'HOLLOW') return S.indOn.HOLLOW ? '空心K' : '实心K';
    var list = indList();
    for (var i = 0; i < list.length; i++) if (list[i][0] === key) return list[i][1];
    return key;
  }

  function indChipHtml(key) {
    var on = !!S.indOn[key];
    return '<button data-ind="' + key + '" class="' + (on ? 'on' : '') + '">'
      + esc(indLabel(key)) + '</button>';
  }

  function renderIndBar() {
    var main = $('indMain'), sub = $('indSub');
    if (!main || !sub) return;
    var m = '', sk = '', i;
    for (i = 0; i < MAIN_IND_KEYS.length; i++) m += indChipHtml(MAIN_IND_KEYS[i]);
    for (i = 0; i < SUB_IND_KEYS.length; i++) sk += indChipHtml(SUB_IND_KEYS[i]);
    main.innerHTML = m;
    sub.innerHTML = sk;
  }

  /** 顶栏第二行右侧那个按钮上的数字：当前开了几个指标 */
  function updateIndCount() {
    var el = $('indCount');
    if (!el) return;
    var n = 0;
    var list = indList();
    for (var i = 0; i < list.length; i++) {
      if (S.indOn[list[i][0]]) n++;
    }
    el.textContent = String(n);
  }

  /**
   * 指标面板的行。
   * ★ 这里刻意不用 <label><input type="checkbox">：
   *   底部面板的触摸处理会在 touchend 上 preventDefault（为了让点击可靠），
   *   而这恰好把 label 激活 checkbox 的原生行为一起取消了 —— 表现就是
   *   "点了没反应、取消也不关"。改成整行可点的 div，点击直接改状态。
   */
  function indicatorSheetHtml() {
    var html = '<div class="act-hint">点一下就生效，和图上显示一致。</div>';
    var list = indList();
    for (var i = 0; i < list.length; i++) {
      var k = list[i][0];
      var on = !!S.indOn[k];
      html += '<div class="ind-row' + (on ? ' on' : '') + '" data-ind="' + k + '" role="switch"'
        + ' aria-checked="' + (on ? 'true' : 'false') + '">'
        + '<span class="ind-name">' + list[i][1] + '</span>'
        + '<span class="ind-desc">' + list[i][2] + '</span>'
        + '<span class="ind-box"></span>'
        + '</div>';
    }
    return html;
  }

  function openIndicatorSheet() {
    lastIndText = '';
    openBottomSheet('显示指标', indicatorSheetHtml());
  }

  var lastIndText = '';

  /**
   * 指标开关的真正落点。
   * ★ 这里修掉一个一直存在的 bug：旧代码把 change 事件绑在一个页面里
   *   从未存在过的容器 id 上（指标 chip 实际挂在级别栏里），所以点
   *   MA/BOLL/MACD 只是勾选框变样，图和指标根本不会重算。
   *   现在面板里的 checkbox 绑在真实存在的 #actSheet 上。
   */
  function applyIndicatorToggle(key, on, rowEl) {
    if (!key || !(key in S.indOn)) return false;
    S.indOn[key] = !!on;
    if (rowEl && rowEl.classList) {
      if (on) rowEl.classList.add('on'); else rowEl.classList.remove('on');
    }
    if (key === 'AILINE') {
      chart.setAiVisible(!!on);
      updateIndCount();
      return true;
    }
    if (key === 'VOL') {
      // 成交量自带 5/10 量均线：关掉成交量，量均线一起消失，不再单列一个开关
      S.indOn.VOL = !!on;
      S.indOn.VOLMA = !!on;
    }
    // 副图只有一个槽位：MACD / KDJ / RSI 互斥；量均线依附成交量
    if (key === 'MACD' || key === 'KDJ' || key === 'RSI') {
      if (on) {
        S.indOn.MACD = false;
        S.indOn.KDJ = false;
        S.indOn.RSI = false;
        S.indOn[key] = true;
      } else {
        S.indOn[key] = false;
      }
    }
    if (chart) chart.showVol = (S.indOn.VOL !== false);
    if (key === 'CHAN') {
      chart.setChanVisible(!!on);
      if (on && !S.chan) runChan(); else renderChanStatus();
      updateIndCount();
      return true;
    }
    if (key === 'HOLLOW') {
      // 只是画法切换：不重算指标，改配置后重画一遍就够
      S.cfg.candleStyle = on ? 'hollow' : 'solid';
      try { if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (e) {}
      if (chart) { try { chart.render(); } catch (e) {} }
      renderIndBar();
      return true;
    }
    computeIndicators();
    chart.setData(S.kl, S.ind, S.period === 'minute');
    chart.setAiMarks(S.aiLevels, S.aiZones, S.aiMarks, S.aiFib, S.aiTexts);
    renderIndicatorValues();
    updateChartSub();
    updateIndCount();
    renderIndBar();
    return true;
  }

  /**
   * 点指标行 = 切换。
   * 不读 e.target.checked：行里已经没有原生 checkbox 了，
   * 状态以 S.indOn 为准（这也是图实际读的那份状态）。
   */
  function onIndicatorRowTap(e) {
    var row = e.target.closest ? e.target.closest('.ind-row') : null;
    if (!row) return false;
    var key = row.getAttribute('data-ind');
    if (!key) return false;
    var next = !S.indOn[key];
    applyIndicatorToggle(key, next, row);
    row.setAttribute('aria-checked', next ? 'true' : 'false');
    return true;
  }

  // ==================== 设置 ====================
  var fetchedModels = [];

  /** 关闭弹层（覆盖层）。✕、点遮罩、返回键三条路都走这里 */
  function closeModal(id) {
    var m = $(id);
    if (m) m.classList.add('hidden');
  }

  /** 打开一个二级页（设置 / 知识库 / 会话），由 pages.js 的路由统一管 */
  function openPage(id) {
    if (window.Page && window.Page.open) return window.Page.open(id);
    var el = $(id);
    if (el) el.classList.remove('hidden');
    return false;
  }

  function closePage(id) {
    if (window.Page && window.Page.close) return window.Page.close(id);
    var el = $(id);
    if (el) el.classList.add('hidden');
    return false;
  }

  /** 设置页「关于」区的三行：版本 / 模型 / 会话数 */
  function fillAbout() {
    var v = $('aboutVer');
    if (v) v.textContent = 'v10.0';
    var m = $('aboutModel');
    if (m) m.textContent = S.cfg.model || '未配置';
    var sec = $('aboutSess');
    if (sec && window.Sessions) {
      window.Sessions.list().then(function (list) {
        var n = (list || []).filter(function (x) { return x.count; }).length;
        sec.textContent = n + ' 只有对话';
      }).catch(function () { sec.textContent = '--'; });
    }
  }

  // ==================== 多配置档 ====================
  //
  // 为什么要这层：用户可能同时有官方 API、公司中转、本地 ollama，
  // 只有一个 baseUrl/key/model 就得每次手抄。做成配置档后一键切换。
  //
  // ★ 关键约束：S.cfg.baseUrl/apiKey/model 是"当前生效值"，必须始终等于
  //   activeProfile 的那三个。所有历史调用点只读这三个字段，
  //   这样加配置档对它们完全透明，不会因为漏改某个调用点而请求到错误的服务。
  //
  // 常用中转/厂商预设：只填 name 与 baseUrl，Key 和模型仍由用户填。
  var PROFILE_PRESETS = [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
    { name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1' },
    { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
    { name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
    { name: '自定义', baseUrl: '' }
  ];

  function newProfileId() {
    return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
  }

  /** 把 S.cfg 上当前生效的三个字段，写回 activeProfile（保持两边一致） */
  function syncActiveProfileFromCfg() {
    var p = getActiveProfile();
    if (!p) return;
    p.baseUrl = S.cfg.baseUrl || '';
    p.apiKey = S.cfg.apiKey || '';
    p.model = S.cfg.model || '';
    p.models = S.cfg.models || [];
    p.temperature = S.cfg.temperature;
    p.maxTokens = S.cfg.maxTokens;
  }

  function getActiveProfile() {
    var list = S.cfg.profiles || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === S.cfg.activeId) return list[i];
    }
    return list.length ? list[0] : null;
  }

  /** 用某个配置档的内容覆盖当前生效字段 */
  function applyProfile(p) {
    if (!p) return;
    S.cfg.activeId = p.id;
    S.cfg.baseUrl = p.baseUrl || '';
    S.cfg.apiKey = p.apiKey || '';
    S.cfg.model = p.model || '';
    S.cfg.models = p.models || [];
    if (typeof p.temperature === 'number') S.cfg.temperature = p.temperature;
    if (typeof p.maxTokens === 'number') S.cfg.maxTokens = p.maxTokens;
  }

  /**
   * 启动时的迁移与兜底。
   *
   * ★ 老用户升级上来时只有 baseUrl/apiKey/model 三个字段，profiles 是空的。
   *   必须把他们现在正在用的配置自动收成一个「默认配置」，
   *   否则一升级设置页就空了 —— 那是绝对不能发生的。
   */
  function ensureProfiles() {
    // 注意别写成 !Object.prototype.toString.call(...) === '[object Array]'，
    // 那是 (false === '[object Array]')，永远为 false，等于没判断。
    if (Object.prototype.toString.call(S.cfg.profiles) !== '[object Array]') {
      S.cfg.profiles = [];
    }
    if (!S.cfg.profiles.length) {
      var p = {
        id: newProfileId(),
        name: '默认配置',
        baseUrl: S.cfg.baseUrl || '',
        apiKey: S.cfg.apiKey || '',
        model: S.cfg.model || '',
        models: S.cfg.models || [],
        temperature: typeof S.cfg.temperature === 'number' ? S.cfg.temperature : 0.7,
        maxTokens: typeof S.cfg.maxTokens === 'number' ? S.cfg.maxTokens : 65536
      };
      S.cfg.profiles = [p];
      S.cfg.activeId = p.id;
      return;
    }
    // 有配置档但没有 activeId（或指向已删除的档）→ 回落到第一个
    var found = false;
    for (var i = 0; i < S.cfg.profiles.length; i++) {
      if (S.cfg.profiles[i].id === S.cfg.activeId) { found = true; break; }
    }
    if (!found) S.cfg.activeId = S.cfg.profiles[0].id;
    applyProfile(getActiveProfile());
  }

  /** 渲染配置档列表 */
  var PROFILE_COLORS = ['ico-blue', 'ico-green', 'ico-orange', 'ico-yellow'];
  var SVG_CLOUD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M7 18h10a4 4 0 0 0 .7-7.9A5.2 5.2 0 0 0 8 8.4 4.3 4.3 0 0 0 7 18Z"/></svg>';

  /** 提供商图标：24dp 单色云，按名字稳定取四色之一（Eta 的 SettingsIconColors） */
  function profileIcon(p) {
    var nm = String(p && p.name || '');
    var h = 0;
    for (var i = 0; i < nm.length; i++) h = (h * 31 + nm.charCodeAt(i)) % 997;
    return '<span class="set-ico ' + PROFILE_COLORS[h % PROFILE_COLORS.length] + '">'
      + SVG_CLOUD + '</span>';
  }

  /** 提供商列表：Eta 那种「行」——图标方块 / 名称 / 模型 · 主机 / 使用中或 › */
  function renderProfiles() {
    var box = $('profileList');
    if (!box) return;
    var list = S.cfg.profiles || [];
    var kwEl = $('provSearch');
    var kw = String(kwEl && kwEl.value || '').trim().toLowerCase();
    var shown = list.filter(function (p) {
      if (!kw) return true;
      return (String(p.name || '') + ' ' + String(p.baseUrl || '')).toLowerCase().indexOf(kw) >= 0;
    });
    var html = '';
    for (var i = 0; i < shown.length; i++) {
      var p = shown[i];
      var on = (p.id === S.cfg.activeId);
      var url = String(p.baseUrl || '').replace(/\/+$/, '');
      var nModels = (p.models || []).length || (p.model ? 1 : 0);
      var kind = p.endpointMode === 'anthropic' ? 'Anthropic Messages'
        : p.endpointMode === 'gemini' ? 'Gemini Interactions' : 'OpenAI-compatible';
      var meta = kind + ' · ' + nModels + ' 个模型 · ' + (p.isBuiltIn ? '内置' : '自定义');
      html += '<div class="set-item profile-item' + (on ? ' active' : '') + '" data-pid="' + p.id + '">'
        + profileIcon(p)
        + '<span class="set-txt"><b>' + esc(p.name || '未命名') + '</b>'
        + '<i>' + esc(url || '未填 Base URL') + '</i>'
        + '<span class="prov-meta">' + esc(meta) + '</span></span>'
        + '<span class="radio' + (on ? ' on' : '') + '"></span>'
        + '</div>';
    }
    if (!shown.length) {
      html = '<div class="set-item disabled"><span class="set-txt"><b>没有匹配的提供商</b></span></div>';
    }
    box.innerHTML = html;
    var cnt = $('provCount');
    if (cnt) cnt.textContent = '已配置提供商（共 ' + list.length + ' 个）';
  }

  /** 切换配置档（立即生效并落盘） */
  function switchProfile(id) {
    var list = S.cfg.profiles || [];
    var target = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) target = list[i];
    if (!target || target.id === S.cfg.activeId) return;
    syncActiveProfileFromCfg();     // 先把当前编辑中的内容存回去
    applyProfile(target);
    persistConfig();
    fillSettingsForm();
    renderProfiles();
    setEditorOpen(true);
    setSheetHint('已切换到「' + (target.name || '未命名') + '」');
  }

  function addProfile(name, baseUrl, endpointMode) {
    syncActiveProfileFromCfg();
    var p = {
      id: newProfileId(),
      name: name || '新配置',
      baseUrl: baseUrl || '',
      apiKey: '',
      model: '',
      models: [],
      temperature: S.cfg.temperature,
      maxTokens: S.cfg.maxTokens,
      endpointMode: endpointMode || 'chat',
      enabled: true,
      systemPrompt: '',
      headersText: ''
    };
    S.cfg.profiles.push(p);
    applyProfile(p);
    persistConfig();
    fillSettingsForm();
    renderProfiles();
    setEditorOpen(true);        // 新建后直接把编辑区拉开，光标落在名称上
    try {
      var nEl = $('cfgProfileName');
      if (nEl) { nEl.focus(); nEl.select(); }
    } catch (e) {}
  }

  function deleteProfile(id) {
    var list = S.cfg.profiles || [];
    if (list.length <= 1) { setSheetHint('至少要保留一套配置'); return; }
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) idx = i;
    if (idx < 0) return;
    var wasActive = (list[idx].id === S.cfg.activeId);
    list.splice(idx, 1);
    if (wasActive) applyProfile(list[0]);
    persistConfig();
    fillSettingsForm();
    renderProfiles();
  }

  /** 配置落盘（与 saveSettings 分开：切档也要立刻存，不能等用户按保存） */
  function persistConfig() {
    try {
      if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg));
    } catch (e) { console.warn('persistConfig', e); }
  }

  /**
   * 把 S.cfg 的当前值填进设置页表单。
   *
   * ★ 这里以前漏了「配置名」——新增配置后名称框不动，
   *   用户点「新增配置」看到列表多了一行、下面表单却没变化，
   *   自然会认为「点了没反应」。所以名称必须一起填。
   */
  function fillSettingsForm() {
    $('cfgBase').value = S.cfg.baseUrl || '';
    $('cfgKey').value = S.cfg.apiKey || '';
    $('cfgModel').value = S.cfg.model || '';
    $('cfgTemp').value = S.cfg.temperature;
    $('cfgMax').value = S.cfg.maxTokens;
    var act = getActiveProfile();
    var nameEl = $('cfgProfileName');
    if (nameEl) nameEl.value = act ? (act.name || '') : '';
    // 标题同步成正在编辑的那套
    var t = $('peTitle');
    if (t) t.textContent = '编辑：' + (act ? (act.name || '未命名') : '未选择');
    var sub = $('peSub');
    if (sub) {
      var host2 = act && act.baseUrl ? String(act.baseUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
      sub.textContent = act ? ((act.model || '未选模型') + ' · ' + (host2 || '未填地址'))
        : '点上方任一提供商开始编辑';
    }
    if ($('cfgEndpoint')) $('cfgEndpoint').value = (act && act.endpointMode) || 'chat';
    if ($('cfgSystemPrompt')) $('cfgSystemPrompt').value = (act && act.systemPrompt) || '';
    if ($('cfgHeaders')) $('cfgHeaders').value = (act && act.headersText) || '';
    paintSwProfile();
    var ml = $('modelList'); if (ml) ml.classList.add('hidden');
    var mt = $('modelTip'); if (mt) mt.classList.add('hidden');
    var pt = $('peTip');
    if (pt) pt.classList.add('hidden');
  }

  /** 展开/收起配置编辑区 */
  function setEditorOpen(open) {
    var ed = $('profileEditor');
    if (!ed) return;
    S.peOpen = !!open;
    ed.classList.toggle('open', !!open);
    var chev = $('peChev');
    if (chev) chev.textContent = open ? '▴' : '▾';
  }

  function openSettings() {
    ensureProfiles();
    fillSettingsForm();
    renderProfiles();
    // 打开设置时保持上次的折叠状态；没有就收起（避免一进来就是一屏表单）
    setEditorOpen(!!S.peOpen);
    var pl = $('presetList');
    if (pl) pl.classList.add('hidden');
    $('cfgPrompts').value = getPrompts().join('\n');
    // 缓存的模型列表不自动铺开：104 个模型一展开，弹窗会长到看不见底部按钮。
    // 只提示一句，想看列表点「获取」。
    var cached = S.cfg.models || [];
    if (cached.length) showTip('ok', '已缓存 ' + cached.length + ' 个模型，点「获取」展开选择');
    openPage('settingsModal');
    setSettingsView('');
    applyFs(S.cfg.fs || 'm', true);
    paintFsOptions();
    fillAbout();
    paintThemeOptions();
    paintSwitches();
    paintAppearance();
    renderTools();
    updateSettingsSummary();
  }

  /** 把表单里的 Provider 字段写回当前套（顶栏保存与「保存并启用」共用） */
  function collectProviderForm(act) {
    if (!act) return;
    act.name = ($('cfgProfileName').value || '').trim() || '未命名';
    act.baseUrl = ($('cfgBase').value || '').trim();
    act.apiKey = ($('cfgKey').value || '').trim();
    act.model = ($('cfgModel').value || '').trim();
    if ($('cfgTemp')) act.temperature = parseFloat($('cfgTemp').value) || 0.7;
    if ($('cfgMax')) act.maxTokens = parseInt($('cfgMax').value, 10) || 65536;
    if ($('cfgEndpoint')) act.endpointMode = $('cfgEndpoint').value || 'chat';
    if ($('cfgSystemPrompt')) act.systemPrompt = $('cfgSystemPrompt').value || '';
    if ($('cfgHeaders')) act.headersText = $('cfgHeaders').value || '';
  }

  /** 「启用此 Provider」开关：写 enabled 并作用于当前生效 */
  function paintSwProfile() {
    var sw = $('swProfile');
    if (!sw) return;
    var act = getActiveProfile();
    var on = !act || act.enabled !== false;
    if (on) sw.classList.add('on'); else sw.classList.remove('on');
    if (sw.setAttribute) sw.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  function saveSettings() {
    ensureProfiles();
    S.cfg.baseUrl = $('cfgBase').value.trim();
    S.cfg.apiKey = $('cfgKey').value.trim();
    S.cfg.model = $('cfgModel').value.trim();
    S.cfg.temperature = parseFloat($('cfgTemp').value) || 0.7;
    S.cfg.maxTokens = parseInt($('cfgMax').value, 10) || 65536;
    // 当前编辑的这套配置：改名 + 把地址/Key/模型写回它
    var act = getActiveProfile();
    if (act) {
      collectProviderForm(act);
      syncActiveProfileFromCfg();
    }
    // 快捷提问：一行一条，全删掉就回到系统自带
    var lines = ($('cfgPrompts').value || '').split('\n')
      .map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; });
    S.cfg.prompts = lines.length ? lines : null;
    if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg));
    closePage('settingsModal');
    setSheetHint('设置已保存');
  }

  function fetchModels() {
    var base = $('cfgBase').value.trim();
    var key = $('cfgKey').value.trim();
    var tip = $('modelTip');
    var btn = $('btnFetchModels');

    if (!base) { showTip('err', '请先填写 API 地址'); return; }
    if (!key) { showTip('err', '请先填写 API Key'); return; }

    btn.disabled = true;
    btn.textContent = '获取中';
    showTip('ok', '正在拉取模型列表…');

    callNative('listModels', base, key).then(function (raw) {
      var res;
      try { res = JSON.parse(raw); } catch (e) { throw new Error('返回解析失败'); }
      var models = res.models || [];
      if (!models.length) throw new Error('没有拿到模型');
      fetchedModels = models;
      // 缓存到配置，下次打开设置直接可切换
      S.cfg.models = models.map(function (m) { return m.id || m; });
      if (NATIVE) { try { NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (e) { } }
      renderModelList(models);
      showTip('ok', '获取到 ' + models.length + ' 个模型，点选一个');
    }).catch(function (e) {
      showTip('err', e.message);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '获取';
    });
  }

  function renderModelList(models) {
    var box = $('modelList');
    var cur = $('cfgModel').value.trim();
    box.innerHTML = models.map(function (m) {
      var id = m.id || m;
      var sel = (id === cur) ? ' sel' : '';
      var owner = m.owner ? '<span class="mtag">' + esc(m.owner) + '</span>' : '';
      return '<div class="mitem' + sel + '" data-id="' + esc(id) + '">'
        + '<span>' + esc(id) + '</span>' + owner + '</div>';
    }).join('');
    box.classList.remove('hidden');
  }

  function showTip(type, msg) {
    var tip = $('modelTip');
    if (!tip) { setSheetHint(msg); return; }
    tip.className = 'model-tip ' + type;
    tip.textContent = msg;
    tip.classList.remove('hidden');
  }

  // ==================== 自选股 ====================
  function saveWatch() {
    if (window.Groups) { window.Groups.save(); return; }
    if (NATIVE) NATIVE.saveWatchlist(JSON.stringify(S.watchlist));
  }

  /**
   * 把一只股票提到自选最前面。
   * 规则：最近搜索/点过的排最前，越久没碰的越靠后 —— 之前是 push 到末尾，
   * 新搜的股票出现在列表最右边，得横着滑半天才能点回来。
   */
  function touchWatch(code, name) {
    var i, hit = null;
    for (i = 0; i < S.watchlist.length; i++) {
      if (S.watchlist[i].code === code) { hit = S.watchlist.splice(i, 1)[0]; break; }
    }
    if (!hit) hit = { code: code, name: name };
    if (name) hit.name = name;
    hit.t = Date.now();
    // 新股票放进当前正在看的分组（在"全部"里则放第一个分组）
    // ★ v7：分组变成数组，一只股票可以同时属于多个分组
    if (!hit.groups) hit.groups = window.Groups ? [window.Groups.groupForNew()] : ['default'];
    S.watchlist.unshift(hit);
    saveWatch();
    renderWatchlist();
  }

  function addWatch(code, name) {
    touchWatch(code, name);
  }

  // ==================== 搜索 ====================
  var searchTimer = null;
  function doSearch(kw) {
    if (!kw) { $('suggest').classList.add('hidden'); return; }
    callNative('search', kw).then(function (txt) {
      var list = parseSearch(txt);
      if (!list.length) { $('suggest').classList.add('hidden'); return; }
      var box = $('suggest');
      box.innerHTML = list.slice(0, 12).map(function (it) {
        return '<div class="item" data-code="' + it.code + '" data-name="' + esc(it.name) + '">'
          + '<span class="nm">' + esc(it.name) + '</span>'
          + '<span class="cd">' + it.raw + '</span></div>';
      }).join('');
      box.classList.remove('hidden');
    }).catch(function () {
      $('suggest').classList.add('hidden');
    });
  }

  // ==================== 事件 ====================
  function bindEvents() {
    // ★ AI 按钮最先绑定：它是核心功能，不能因为后面任何绑定异常而失效
    try {
      // 发送按钮一物两用：空闲=发送，生成中=停止
    on('aiSend', 'click', function () {
      if (S.busy) { stopAsk(); return; }
      sendInput();
    });

    // 常驻快捷分析：事件委托，方便以后增减小按钮不用重新绑定
    try {
      renderQuickRow();
      var qrow = $('quickChips');
      if (qrow) {
        qrow.addEventListener('click', function (e) {
          var btn = e.target.closest ? e.target.closest('.quick-chip') : null;
          if (!btn) return;
          e.preventDefault();
          runQuickAnalysis(+btn.getAttribute('data-qi'));
        });
      }
    } catch (e) { console.warn('quickRow', e); }
    } catch (e) { console.error('AI 按钮绑定失败', e); }

    // 搜索
    var si = $('searchInput') || { value: '', blur: function () { }, focus: function () { } };
    on('searchInput', 'input', function () {
      clearTimeout(searchTimer);
      var kw = si.value.trim();
      if (!kw) { $('suggest').classList.add('hidden'); return; }
      searchTimer = setTimeout(function () { doSearch(kw); }, 350);
    });
    on('suggest', 'click', function (e) {
      var item = e.target.closest('.item');
      if (!item) return;
      var code = item.getAttribute('data-code');
      var name = item.getAttribute('data-name');
      S.code = code; S.name = name;
      persistStock();
      addWatch(code, name);
      si.value = '';
      $('suggest').classList.add('hidden');
      si.blur();
      loadData();
    });

    // 自选切换：列表在抽屉里，点了就切股（连会话一起换）并收起抽屉
    on('watchPane', 'click', function (e) {
      // 批量选择模式下点股票行只做勾选，不能顺手把股票切走
      if (window.Groups && window.Groups.isSelecting()) return;
      // 行尾的 ⋯ 是「更多选项」，交给 groups.js 处理，不当成切换股票
      if (e.target.closest && e.target.closest('.row-more')) return;
      var row = e.target.closest ? e.target.closest('.watch-row') : null;
      if (!row) return;
      var code = row.getAttribute('data-code');
      if (!code) return;
      var w = S.watchlist.filter(function (x) { return x.code === code; })[0];
      touchWatch(code, w ? w.name : '');
      if (window.Drawer) window.Drawer.hide();
      switchStock(code, w ? w.name : '');
    });

    // 周期
    on('periodBar', 'click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      // ★ 切周期前先把输入框的焦点放掉。
      //   问题现象：展开态下点周期，界面会整体上移、盖住 K 线。
      //   原因是 WebView 的 adjustResize —— 只要 aiInput 还持着焦点，
      //   软键盘一弹（或重排触发一次），整页会被顶起来；
      //   而展开态的行高是"顶到上限"算死的，一顶就把图表挤没了。
      //   切周期是"我要看盘"，跟输入无关，先把焦点交还给页面。
      try {
        var ae = document.activeElement;
        if (ae && (ae.id === 'aiInput' || ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
          ae.blur();
        }
      } catch (err) {}
      var ps = $('periodBar').querySelectorAll('button');
      for (var i = 0; i < ps.length; i++) ps[i].classList.remove('active');
      btn.classList.add('active');
      var sameP = (btn.getAttribute('data-p') === S.period);
      S.period = btn.getAttribute('data-p');
      // 点「当前已选中的那个周期」= 我要最新数据 → 绕过缓存强制刷新
      loadData(sameP);
    });

    // 底部面板的关闭路径 + 指标行点击
    bindBottomSheet();

    // 顶栏第二行右侧：打开指标面板
    // 指标横条：点一下切换，主图/副图各自独立
    on('indBar', 'click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-ind]') : null;
      if (!btn) return;
      e.stopPropagation();
      var key = btn.getAttribute('data-ind');
      applyIndicatorToggle(key, !S.indOn[key], null);
    });

    // 主题两色：深色 / 浅色，选了就落盘
    on('themeChoices', 'click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-theme]') : null;
      if (!btn) return;
      e.stopPropagation();
      applyTheme(btn.getAttribute('data-theme'));
      paintThemeChoices();
    });

    // ★ 取消十字光标：和旧项目一致 —— 手指落在图表以外（行情条、周期栏、顶栏、
    //   下面的对话区……）就取消；落在图里则是选中/移动光标。
    document.addEventListener('touchstart', function (e) {
      if (!chart || chart.crossIdx < 0) return;
      var t = e.target;
      if (t && t.closest && t.closest('#chartWrap')) return;
      clearFocus();
    }, { passive: true, capture: true });

    // 轻点选中
    chart.onTap = function (idx) { showCursorInfo(idx); };
    // 长按出十字 / 拖动十字：信息条与按钮实时跟着变
    chart.onCross = function (idx) { if (idx >= 0) showCursorInfo(idx); };

    // 图表模式：把选中那根的日期/OHLC 交给 Eta，问的是具体这根
    on('askCandleBtn', 'click', function (e) {
      e.stopPropagation();
      var idx = pickFocusIdx();
      var k = S.kl && S.kl[idx];
      if (!k) return;
      var txt = '请解读 ' + (S.name || S.code || '') + '(' + (S.code || '') + ') 在 ' + k.t
        + ' 这根' + (periodName ? periodName(S.period) : '') + 'K线：'
        + '开 ' + fmtPrice(k.o) + '，高 ' + fmtPrice(k.h) + '，低 ' + fmtPrice(k.l)
        + '，收 ' + fmtPrice(k.c) + '，量 ' + (isFinite(k.v) ? Math.round(k.v) : '--') + '。'
        + '这个位置的多空含义是什么？后续可能怎么走？';
      if (NATIVE && typeof NATIVE.ask === 'function') {
        try { NATIVE.ask(txt); } catch (err) { console.warn('ask', err); }
      } else {
        try { setSheetHint('当前环境不支持直接提问'); } catch (err2) {}
      }
    });

    // 上下文 chip：直接问选中那一根；✕ 取消选中
    on('ctxChip', 'click', function (e) {
      e.stopPropagation();
      var idx = pickFocusIdx();
      if (idx < 0 || !S.kl[idx]) return;
      askAI('请重点分析 ' + S.kl[idx].t + ' 这根 K 线附近的走势：这个位置的多空含义是什么？后续可能怎么走？', idx);
    });
    on('ctxClear', 'click', function (e) {
      e.stopPropagation();
      clearFocus();
    });

    // 快捷提问：走统一的底部面板
    on('btnMore', 'click', function (e) {
      e.stopPropagation();
      openBottomSheet('快捷提问', renderMoreMenu());
    });
    on('actSheet', 'click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      // groups.js 的 data-move / del-* / rename-* / group-up 等不归这里
      if (act !== 'prompt' && act !== 'clear' && act !== 'toggle-group'
        && act !== 'new-group-here' && act !== 'del-stock-from-all') return;

      if (act === 'toggle-group') {
        var gid = btn.getAttribute('data-g');
        var item = S.watchlist.filter(function (x) { return x.code === S.code; })[0];
        if (!item || !window.Groups) { closeBottomSheet(); return; }
        // 勾上 = 加入这个分组；取消 = 移出（若这是它唯一的分组，会被彻底删除）
        if (window.Groups.inGroup(item, gid)) window.Groups.removeStockFromGroup(S.code, gid);
        else window.Groups.addStockToGroup(S.code, gid);
        openStockGroupSheet();      // 重画一遍，让 ✓ 跟着变
        return;
      }

      if (act === 'new-group-here') {
        var nm = window.prompt ? window.prompt('新分组名') : null;
        if (!nm || !nm.trim()) return;
        var nid = window.Groups.addGroup(nm.trim());
        if (!nid) { setSheetHint('已经有同名分组了'); return; }
        window.Groups.addStockToGroup(S.code, nid);
        openStockGroupSheet();
        return;
      }

      if (act === 'del-stock-from-all') {
        if (btn.textContent.indexOf('确认') !== 0) {
          btn.textContent = '确认删除 ' + (S.name || S.code) + '？';
          return;
        }
        window.Groups.removeStock(S.code);
        closeBottomSheet();
        setSheetHint('已从自选删除 ' + (S.name || S.code));
        return;
      }
      if (act === 'prompt') {
        // ★ 只把文字填进输入框，不直接发送 —— 可以先改条件、加仓位再发
        var pi = parseInt(btn.getAttribute('data-i'), 10);
        var plist = getPrompts();
        if (!isFinite(pi) || !plist[pi]) return;
        var box = $('aiInput');
        box.value = plist[pi];
        autoGrowInput();          // ★ 直接赋 value 不会触发 input 事件，得手动量一次
        try { box.focus(); } catch (err) {}
        setSheetHint('已填入输入框，改好点「发送」');
      } else if (act === 'clear') {
        S.history = [];
        S.aiLevels = []; S.aiZones = [];
        chart.clearAiMarks();
        $('aiMessages').innerHTML = '<div class="ai-hint">对话已清空，图上标注也已清除</div>';
        setSheetHint('下面输入框提问，空着发送＝全级别分析');
      }
    });

    // 设置：图表模式下 applyChartOnly() 已经把 btnSettings 节点删掉了
    // （4263 行先于 bindEvents 执行），这里必须先判存在再绑，
    // 否则每次启动都吐一条 [绑定失败] ERROR，日志被它刷满。
    if (document.getElementById('btnSettings')) {
      on('btnSettings', 'click', function () { openSettings(); });
    }
    // 主题三选一：点完立刻生效
    // 行情行右侧的 ＋：当前这只股票的分组操作
    on('btnGroup', 'click', function (e) {
      e.stopPropagation();
      openStockGroupSheet();
    });

    on('settingsModal', 'click', function (e) {
      var opt = e.target.closest ? e.target.closest('.theme-opt') : null;
      if (!opt) return;
      setThemeOption(opt.getAttribute('data-opt'));
    });
    // max tokens 快捷值
    // 弹窗关闭统一处理：✕ 按钮、点遮罩空白处
    function bindModalClose(id) {
      on(id, 'click', function (e) {
        var t = e.target;
        if (t.closest && t.closest('[data-close]')) { closeModal(id); return; }
        if (t === $(id)) { closeModal(id); return; }   // 点在遮罩上
      });
    }
    bindModalClose('settingsModal');

    on('settingsModal', 'click', function (e) {
      var t = e.target.closest && e.target.closest('.tok');
      if (t) $('cfgMax').value = t.getAttribute('data-tok');
    });
    // 快捷提问：恢复系统自带
    on('btnResetPrompts', 'click', function () {
      $('cfgPrompts').value = DEFAULT_PROMPTS.join('\n');
      setSheetHint('已恢复系统自带的快捷提问，记得点「保存」');
    });
    // ★ 必须走 closePage 把 Page 栈一起弹掉。
    //   只给元素加 hidden 的话栈顶还是 settingsModal，之后 openSettings()
    //   会在 Page.open 里命中 `current() === id` 提前 return，
    //   设置页就再也打不开了（而且返回键会被这一层白吃一次）。
    on('cfgCancel', 'click', function () {
      // 二级页里先退回一级列表，一级列表再关闭整页（符合"返回一层"的直觉）
      if (setViewName) { setSettingsView(''); return; }
      closePage('settingsModal');
    });
    on('cfgSave', 'click', saveSettings);

    // ---- 设置一级列表：点行进入二级（知识库复用已有的 KB 页）----
    on('setRoot', 'click', function (e) {
      var stub = e.target.closest ? e.target.closest('[data-stub]') : null;
      if (stub) { setSheetHint('这个设置项对应 Eta 的能力，问股这边还没接入'); return; }
      var row = e.target.closest ? e.target.closest('.set-row') : null;
      if (!row) return;
      var v = row.getAttribute('data-view');
      if (v === 'kb') {
        if (window.KB && window.KB.open) window.KB.open();
        return;
      }
      setSettingsView(v);
    });

    // ---- 字号四档：点了立即生效 ----
    on('toolList', 'click', function (e) {
      var sw = e.target.closest ? e.target.closest('[data-tool]') : null;
      if (!sw) return;
      e.preventDefault();
      e.stopPropagation();
      toggleTool(sw.getAttribute('data-tool'));
    });

    on('fsRow', 'click', function (e) {
      var b = e.target.closest
        ? (e.target.closest('.seg') || e.target.closest('[data-fs]')) : null;
      if (!b) return;
      e.preventDefault();
      setFsOption(b.getAttribute('data-fs'));
    });

    // ---- 外观与主题 ----
    on('rowThemeMode', 'click', function (e) {
      e.preventDefault();
      var tr = $('themeRow'); if (tr) tr.classList.toggle('hidden');
    });
    on('rowFontSize', 'click', function (e) {
      e.preventDefault();
      var fr = $('fsRow'); if (fr) fr.classList.toggle('hidden');
    });
    on('rowUiStyle', 'click', function (e) {
      e.preventDefault();
      setSheetHint('界面样式目前只有 COUI 一套');
    });
    on('uiScale', 'input', function (e) {
      applyUiScale(e.target && e.target.value);
      try { if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (err) {}
    });
    on('swSwipe', 'click', function (e) {
      e.stopPropagation();
      S.cfg.swipeBack = (S.cfg.swipeBack === false);
      paintAppearance();
      try { if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (err) {}
      setSheetHint(S.cfg.swipeBack ? '已开启横移返回' : '已关闭横移返回');
    });
    on('swPredict', 'click', function (e) {
      e.stopPropagation();
      S.cfg.predictiveBack = (S.cfg.predictiveBack === false);
      paintAppearance();
      try { if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (err) {}
      setSheetHint('预测性返回由系统决定，部分设备不生效');
    });

    // ---- 默认显示缠论（真开关：写配置 + 立即重算）----
    on('swChan', 'click', function (e) {
      e.stopPropagation();
      setChanOn(S.cfg.chanOn === false);
    });
    on('btnFetchModels', 'click', fetchModels);

    // ---- 多配置档 ----
    on('btnDelProfile', 'click', function (e) {
      e.preventDefault();
      var list = S.cfg.profiles || [];
      if (list.length <= 1) { setSheetHint('至少要保留一套配置'); return; }
      var act = getActiveProfile();
      if (!act) return;
      if (!window.confirm || window.confirm('删除提供商「' + (act.name || '未命名') + '」？')) {
        deleteProfile(act.id);
        setSheetHint('已删除');
      }
    });

    on('btnAddProfile', 'click', function (e) {
      e.preventDefault();
      addProfile('配置 ' + ((S.cfg.profiles || []).length + 1), '');
      setSheetHint('已新增一套配置，填好地址和 Key 后点保存');
    });

    // 从预设添加（DeepSeek / OpenAI / 本地 ollama…）
    on('btnPresetProfile', 'click', function (e) {
      e.preventDefault();
      var box = $('presetList');
      if (!box) return;
      if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
      var html = '';
      for (var i = 0; i < PROFILE_PRESETS.length; i++) {
        html += '<button type="button" class="preset-item" data-pi="' + i + '">'
          + esc(PROFILE_PRESETS[i].name) + '</button>';
      }
      box.innerHTML = html;
      box.classList.remove('hidden');
    });

    on('presetList', 'click', function (e) {
      var b = e.target.closest ? e.target.closest('.preset-item') : null;
      if (!b) return;
      var pre = PROFILE_PRESETS[+b.getAttribute('data-pi')];
      if (!pre) return;
      var box = $('presetList');
      if (box) box.classList.add('hidden');
      addProfile(pre.name, pre.baseUrl);
      setSheetHint('已添加「' + pre.name + '」，填 Key 后点保存');
    });

    // 点条目切换 / 点 ✕ 删除
    // ---- 模型提供商页（v10.31）：搜索 / 新增 Anthropic·Gemini / 密钥可见 / 启用开关 ----
    on('provSearch', 'input', function () { renderProfiles(); });

    on('btnAddAnthropic', 'click', function (e) {
      e.preventDefault();
      addProfile('Anthropic ' + ((S.cfg.profiles || []).length + 1), 'https://api.anthropic.com', 'anthropic');
      setSheetHint('已新增 Anthropic 提供商，填好 Key 后保存');
    });
    on('btnAddGemini', 'click', function (e) {
      e.preventDefault();
      addProfile('Gemini ' + ((S.cfg.profiles || []).length + 1), 'https://generativelanguage.googleapis.com', 'gemini');
      setSheetHint('已新增 Gemini 提供商，填好 Key 后保存');
    });

    on('btnEye', 'click', function (e) {
      e.preventDefault();
      var k = $('cfgKey');
      if (!k) return;
      k.type = k.type === 'password' ? 'text' : 'password';
    });

    on('btnAdvToggle', 'click', function (e) {
      e.preventDefault();
      var b = $('advBody');
      if (b) b.classList.toggle('hidden');
    });

    on('swProfile', 'click', function (e) {
      e.stopPropagation();
      var act = getActiveProfile();
      if (!act) return;
      act.enabled = act.enabled === false;
      paintSwProfile();
      persistConfig();
      renderProfiles();
      setSheetHint(act.enabled ? '已启用该提供商' : '已停用该提供商（不会参与请求）');
    });

    on('profileList', 'click', function (e) {
      var sw = e.target.closest ? e.target.closest('.switch') : null;
      if (sw) {
        e.preventDefault();
        e.stopPropagation();
        switchProfile(sw.getAttribute('data-pid'));
        return;
      }
      var del = e.target.closest ? e.target.closest('.profile-del') : null;
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        deleteProfile(del.getAttribute('data-del'));
        return;
      }
      var item = e.target.closest ? e.target.closest('.profile-item') : null;
      if (!item) return;
      switchProfile(item.getAttribute('data-pid'));
    });

    // 折叠头：点一下展开/收起
    on('profileEditorHead', 'click', function (e) {
      e.preventDefault();
      setEditorOpen(!$('profileEditor').classList.contains('open'));
    });

    // 「保存这套并启用」：把表单写回当前档 + 落盘（不关闭页面，方便连续配几套）
    on('btnApplyProfile', 'click', function (e) {
      e.preventDefault();
      ensureProfiles();
      var act = getActiveProfile();
      if (!act) return;
      var nm = ($('cfgProfileName').value || '').trim();
      collectProviderForm(act);
      // 同步成「当前生效」，这样保存后立刻就能用
      applyProfile(act);
      persistConfig();
      renderProfiles();
      fillSettingsForm();
      var tip = $('peTip');
      if (tip) {
        tip.className = 'model-tip ok';
        tip.textContent = '已保存并启用「' + act.name + '」';
      }
      setSheetHint('已保存并启用「' + act.name + '」');
    });

    // 「测试连接」：直接用表单里当前填的值去拉模型列表
    on('btnTestProfile', 'click', function (e) {
      e.preventDefault();
      var base = ($('cfgBase').value || '').trim();
      var key = ($('cfgKey').value || '').trim();
      var tip = $('peTip');
      if (!base) { if (tip) { tip.className = 'model-tip err'; tip.textContent = '先填 API 地址'; } return; }
      if (!key) { if (tip) { tip.className = 'model-tip err'; tip.textContent = '先填 API Key'; } return; }
      if (tip) { tip.className = 'model-tip'; tip.textContent = '测试中…'; }
      // 复用 callNative：它已经封装了 cbId / 超时 / ok-fail 的回调约定，
      // 自己去调 NATIVE.listModels 拼回调签名很容易拼错（第一次就写错了）。
      callNative('listModels', base, key).then(function (raw) {
        var n = 0;
        try {
          var j = JSON.parse(raw);
          n = (j.models || []).length;
        } catch (e2) {}
        if (tip) {
          tip.className = 'model-tip ok';
          tip.textContent = n ? ('连接正常，发现 ' + n + ' 个模型') : '连接正常（未返回模型列表）';
        }
      }).catch(function (err) {
        if (tip) {
          tip.className = 'model-tip err';
          tip.textContent = '连接失败：' + String((err && err.message) || err).slice(0, 140);
        }
      });
    });

    // 改名/改地址时实时同步到列表，避免"看着没变"
    ['cfgProfileName'].forEach(function (id) {
      on(id, 'input', function () {
        var act = getActiveProfile();
        if (!act) return;
        var el = $(id);
        if (el) act.name = el.value.trim() || '未命名';
        renderProfiles();
      });
    });

    // 模型列表点选
    on('modelList', 'click', function (e) {
      var it = e.target.closest('.mitem');
      if (!it) return;
      var id = it.getAttribute('data-id');
      $('cfgModel').value = id;
      S.cfg.model = id;   // 立即写入，避免用户忘了点「保存」
      syncActiveProfileFromCfg();   // 同时写回当前配置档，切档才不丢
      persistConfig();
      var all = $('modelList').querySelectorAll('.mitem');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('sel');
      it.classList.add('sel');
    });

    // 底部输入框：发送 / 回车发送
    on('aiInput', 'input', autoGrowInput);
    on('aiInput', 'keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.preventDefault) e.preventDefault();
        sendInput();
      }
    });

    // 点空白收起
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.searchbox')) $('suggest').classList.add('hidden');
    });

    // 尺寸变化
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        // 旋转/分屏会改变视口高度，展开态的"顶到上限"要按新视口重算，
        // 否则会留一条空白或把图表压没
        if (S.sheetExpanded) applySheetHeight(sheetMaxHeight(true), true);
        chart.resize();
      }, 200);
    });

    // 系统栏安全区：由原生 FrameLayout 的 padding 处理，页面内不再需要任何留白逻辑。
    // （之前这里有两套兜底：原生 padding + CSS --safe-top + JS 探测，
    //   三者叠加导致顶部出现约 60dp 空白。现只保留原生一套。）
    window.__onInsets = function () { /* 原生已处理，留空以兼容旧调用 */ };

    // 返回键：只做委派，顺序写在 back() 里（二级页 → 底部面板 → 抽屉 → 对话全屏）
    window.__onBack = function () {
      return back();
    };

  }

  // ==================== 主题（深 / 浅 / 跟随系统） ====================

  /**
   * 系统当前是不是浅色。WebView 认 prefers-color-scheme。
   * 拿不到就当深色，绝不猜 —— 猜错了配色比不切换更糟。
   */
  function systemIsLight() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    } catch (e) { return false; }
  }

  /** 实际要使用的那一套：auto 时看系统 */
  function resolvedTheme() {
    var t = S.cfg.theme || 'dark';
    if (t === 'auto') t = systemIsLight() ? 'light' : 'dark';
    return t;
  }

  /**
   * 应用主题。
   * 三处一起动：页面变量（CSS）、画布调色板、原生状态栏颜色。
   * silent=true 时只不写盘（启动时按已存配置套主题，不必重复落盘）。
   */
  function applyTheme(name, silent) {
    var t = (name === 'light' || name === 'dark') ? name : resolvedTheme();
    try { document.documentElement.setAttribute('data-theme', t); } catch (e) {}
    if (chart && chart.setTheme) {
      try { chart.setTheme(t); } catch (e) { console.warn('主题切换失败', e); }
    }
    try { if (NATIVE && NATIVE.setBars) NATIVE.setBars(t); } catch (e) {}
    S.cfg.theme = name;
    if (!silent) {
      if (NATIVE) { try { NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (e) {} }
      setSheetHint(t === 'light' ? '已切到浅色主题' : '已切到深色主题');
    }
    try { if (window.Drawer && window.Drawer.refreshTheme) window.Drawer.refreshTheme(); } catch (e) {}
    try { paintThemeChoices(); } catch (e) {}
    return t;
  }

  /** 快捷开关用的文案：说清楚点下去会切到什么，而不是当前是什么 */
  function themeLabel() {
    return resolvedTheme() === 'light' ? '切换到深色' : '切换到浅色';
  }

  /** 点一下就翻转，适合放在抽屉里当快捷开关 */
  function cycleTheme() {
    return applyTheme(resolvedTheme() === 'light' ? 'dark' : 'light');
  }

  /** 设置页里的三选一：点完立刻生效并落盘，不用等点「保存」 */
  function setThemeOption(opt) {
    if (opt !== 'dark' && opt !== 'light' && opt !== 'auto') return;
    applyTheme(opt);
    paintThemeOptions();
    updateSettingsSummary();
  }

  function paintThemeChoices() {
    var box = $('themeChoices');
    if (!box) return;
    var btns = box.querySelectorAll ? box.querySelectorAll('[data-theme]') : [];
    for (var i = 0; i < btns.length; i++) {
      // auto 模式下按实际解析出来的主题高亮，避免两个都不亮/亮错
      var current = (S.cfg.theme === 'light' || S.cfg.theme === 'dark') ? S.cfg.theme : resolvedTheme();
      var on = btns[i].getAttribute('data-theme') === current;
      if (on) btns[i].classList.add('on'); else btns[i].classList.remove('on');
    }
  }

  /** 高亮当前选中的主题项 */
  function paintThemeOptions() {
    var box = $('themeRow');
    if (!box) return;
    var btns = box.querySelectorAll ? box.querySelectorAll('.theme-opt') : [];
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-opt') === (S.cfg.theme || 'dark')) btns[i].classList.add('on');
      else btns[i].classList.remove('on');
    }
  }

  // ==================== 字号档位（v10.27）====================
  var FS_LEVELS = { s: '小', m: '标准', l: '大', xl: '超大' };

  function normalizeFs(v) { return FS_LEVELS[v] ? v : 'm'; }

  /**
   * 应用字号档位。
   * 只改 <html data-fs>，全站字号由 tokens.css 的 --fs-scale 派生 ——
   * 这样"能调字号"才是真的能调，而不是逐个元素改。
   */
  function applyFs(level, silent) {
    var lv = normalizeFs(level);
    try { document.documentElement.setAttribute('data-fs', lv); } catch (e) {}
    S.cfg.fs = lv;
    paintFsOptions();
    if (!silent) {
      // 字号变了，文字块高度会变，补一次重排让画布跟着调整
      try { if (chart && chart.resize) chart.resize(); } catch (e) {}
    }
  }

  function paintFsOptions() {
    var box = $('fsRow');
    if (!box) return;
    var btns = box.querySelectorAll ? box.querySelectorAll('.seg') : [];
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-fs') === (S.cfg.fs || 'm')) btns[i].classList.add('on');
      else btns[i].classList.remove('on');
    }
  }

  function setFsOption(lv) {
    applyFs(lv);
    // 外观类设置不依赖「保存」按钮，改完即生效并立即落盘
    try { if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (e) {}
    updateSettingsSummary();
    setSheetHint('字号：' + FS_LEVELS[normalizeFs(lv)]);
  }

  /** 开关：默认显示缠论 */
  function paintSwitches() {
    var sw = $('swChan');
    if (!sw) return;
    var on = S.cfg.chanOn !== false;
    if (on) sw.classList.add('on'); else sw.classList.remove('on');
    if (sw.setAttribute) sw.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  function setChanOn(on) {
    S.cfg.chanOn = !!on;
    S.indOn.CHAN = !!on;
    try { if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (e) {}
    paintSwitches();
    if (!on) {
      S.chan = null;
      try { chart.setChan(null); } catch (e) {}
      renderChanStatus();
    } else {
      try { runChan(); } catch (e) { console.warn('runChan', e); }
    }
    setSheetHint(on ? '已开启缠论显示' : '已关闭缠论显示');
  }

  // ==================== 外观与主题（v10.32）====================
  var THEME_LABEL = { dark: '深色', light: '浅色', auto: '跟随系统' };

  /** 整体等比缩放（对应 Eta 的 interfaceScale 0.8~1.1） */
  function applyUiScale(pct) {
    var p = Math.max(80, Math.min(110, parseInt(pct, 10) || 100));
    S.cfg.uiScale = p;
    try { document.documentElement.style.zoom = (p / 100); } catch (e) {}
    var v = $('valUiScale');
    if (v) v.textContent = p + '%';
    var sl = $('uiScale');
    if (sl && String(sl.value) !== String(p)) sl.value = p;
  }

  function paintAppearance() {
    var t = $('valThemeMode');
    if (t) t.textContent = THEME_LABEL[S.cfg.theme || 'dark'] || '深色';
    var f = $('valFontSize');
    if (f) f.textContent = FS_LEVELS[normalizeFs(S.cfg.fs)] || '标准';
    var u = $('valUiStyle');
    if (u) u.textContent = 'COUI';
    var sw = $('swSwipe');
    if (sw) {
      var on = S.cfg.swipeBack !== false;
      if (on) sw.classList.add('on'); else sw.classList.remove('on');
    }
    var sp = $('swPredict');
    if (sp) {
      var on2 = S.cfg.predictiveBack !== false;
      if (on2) sp.classList.add('on'); else sp.classList.remove('on');
    }
    applyUiScale(S.cfg.uiScale || 100);
  }

  // 横移返回：屏幕左缘 24px 内向右滑 > 60px 且纵向位移 < 40px
  function installSwipeBack() {
    var sx = 0, sy = 0, tracking = false, fired = false;
    document.addEventListener('touchstart', function (e) {
      if (S.cfg.swipeBack === false) return;
      var t = e.touches && e.touches[0];
      if (!t) return;
      if (t.clientX > 24) { tracking = false; return; }
      sx = t.clientX; sy = t.clientY; tracking = true; fired = false;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!tracking || fired) return;
      var t = e.touches && e.touches[0];
      if (!t) return;
      var dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
      if (dx > 60 && dy < 40) {
        fired = true; tracking = false;
        try { if (window.Page && window.Page.back) window.Page.back(); } catch (err) {}
      }
    }, { passive: true });
    document.addEventListener('touchend', function () { tracking = false; }, { passive: true });
  }

  // ==================== 设置页：一级 / 二级（v10.27）====================
  var SET_VIEWS = {
    appearance: { el: 'setAppearance', title: '外观与主题' },
    model: { el: 'setModel', title: '模型与提供商' },
    analysis: { el: 'setAnalysis', title: '分析与快捷提问' },
    data: { el: 'setData', title: '数据与会话' },
    tools: { el: 'setTools', title: '工具列表' },
    about: { el: 'setAbout', title: '关于' }
  };
  var setViewName = '';

  /** name 为空 = 回到一级列表 */
  function setSettingsView(name) {
    setViewName = name || '';
    var root = $('setRoot');
    var title = $('setTitle');
    for (var key in SET_VIEWS) {
      var el = $(SET_VIEWS[key].el);
      if (el) el.classList.add('hidden');
    }
    // 「保存」只属于有表单的页（模型 / 分析）；一级列表与纯展示页不需要它
    var save = $('cfgSave');
    if (save) save.style.display = (name === 'model' || name === 'analysis') ? '' : 'none';
    if (!name) {
      if (root) root.classList.remove('hidden');
      if (title) title.textContent = '设置';
      updateSettingsSummary();
      return;
    }
    if (root) root.classList.add('hidden');
    var v = SET_VIEWS[name];
    if (v) {
      var node = $(v.el);
      if (node) node.classList.remove('hidden');
      if (title) title.textContent = v.title;
    }
  }

  /** 工具列表：逐项开关（写进 cfg.disabledTools，下一轮请求即生效） */
  var TOOL_LABELS = [
    ['search_symbol', '股票搜索'], ['get_quote', '实时行情'], ['get_kline', 'K 线'],
    ['get_minute', '分时'], ['compute_indicators', '技术指标'], ['analyze_chan', '缠论分析'],
    ['analyze_levels', '多级别联立'], ['get_fundamental', '基本面'], ['compare_fundamental', '基本面对比'],
    ['annotate_chart', '图上标注'], ['draw_on_chart', 'AI 画图'], ['read_skill', '读取技能'], ['notes', '分析笔记']
  ];

  function renderTools() {
    var box = $('toolList');
    if (!box) return;
    var off = S.cfg.disabledTools || [];
    var html = '';
    for (var i = 0; i < TOOL_LABELS.length; i++) {
      var n = TOOL_LABELS[i][0], label = TOOL_LABELS[i][1];
      var on = off.indexOf(n) < 0;
      html += '<div class="set-item">'
        + '<span class="set-txt"><b>' + label + '</b><i>' + n + '</i></span>'
        + '<button class="switch' + (on ? ' on' : '') + '" type="button" data-tool="' + n + '"'
        + ' role="switch" aria-checked="' + (on ? 'true' : 'false') + '"><span></span></button>'
        + '</div>';
    }
    box.innerHTML = html;
  }

  function toggleTool(name) {
    var off = (S.cfg.disabledTools || []).slice();
    var i = off.indexOf(name);
    if (i >= 0) off.splice(i, 1); else off.push(name);
    S.cfg.disabledTools = off;
    try { if (NATIVE) NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (e) {}
    renderTools();
    setSheetHint((i >= 0 ? '已启用 ' : '已关闭 ') + name);
  }

  /** 一级列表每行的「当前值」，让设置页一眼能看出状态 */
  function updateSettingsSummary() {
    var th = ({ dark: '深色', light: '浅色', auto: '跟随系统' })[S.cfg.theme || 'dark'] || '深色';
    var a = $('setVAppearance');
    if (a) a.textContent = th + ' · ' + FS_LEVELS[normalizeFs(S.cfg.fs)] + '字号';
    var m = $('setVModel');
    if (m) {
      m.textContent = S.cfg.model
        ? (S.cfg.model + (S.cfg.baseUrl ? '' : '（缺地址）'))
        : '未配置';
    }
    var an = $('setVAnalysis');
    if (an) an.textContent = (getPrompts() || []).length + ' 条快捷提问';
    var ab = $('setVAbout');
    if (ab) ab.textContent = 'v10.31';
  }

  /**
   * 行情行右侧「＋」的内容：当前这只股票属于哪些分组。
   * 一只股票可以同时属于多个分组，所以这里是"勾选"而不是"选一个"。
   */
  function openStockGroupSheet() {
    if (!window.Groups || !S.code) return;
    window.Groups.ensureInit();
    var w = S.watchlist.filter(function (x) { return x.code === S.code; })[0];
    var body = '<div class="act-hint">' + esc(S.name || S.code) + '　' + esc(S.code) + '</div>'
      + '<div class="act-sec">加入分组</div><div class="act-groups">';
    S.groups.forEach(function (g) {
      var on = w && window.Groups.inGroup(w, g.id);
      body += '<button class="act-pick' + (on ? ' cur' : '') + '" data-act="toggle-group" data-g="'
        + esc(g.id) + '">' + esc(g.name) + (on ? ' ✓' : '') + '</button>';
    });
    body += '</div>';
    body += '<button class="act-btn" data-act="new-group-here">＋ 新建分组并加入</button>';
    body += '<div class="act-note">同一只股票可以同时属于多个分组，点一下就是加入/移出。</div>';
    body += '<button class="act-danger" data-act="del-stock-from-all">从自选删除</button>';
    openBottomSheet('分组操作', body);
  }

  // ==================== 返回键栈 ====================

  /**
   * 返回的唯一落点。顺序固定，不再散落在各模块里各收各的
   * （以前设置弹窗、知识库、抽屉各写一遍，返回键有时一次退两层）。
   */
  function back() {
    if (window.Page && window.Page.isOpen && window.Page.isOpen()) {
      window.Page.back();
      return true;
    }
    if (bottomSheetOpen()) { closeBottomSheet(); return true; }
    if (window.Drawer && window.Drawer.isOpen()) { window.Drawer.hide(); return true; }
    if (S.sheetExpanded) { toggleSheet(false); return true; }
    return false;
  }

  /** 清空全部会话（设置 - 数据里，两步确认） */
  function clearAllSessions() {
    if (!window.Sessions) return Promise.resolve(0);
    return window.Sessions.list().then(function (list) {
      var jobs = (list || []).map(function (s) { return window.Sessions.remove(s.code); });
      return Promise.all(jobs).then(function () { return jobs.length; });
    }).then(function (n) {
      S.history = [];
      S.aiLevels = []; S.aiZones = []; S.aiMarks = []; S.aiFib = []; S.aiTexts = [];
      if (chart) { try { chart.clearAiMarks(); chart.render(); } catch (e) {} }
      renderConversation([]);
      try { if (window.Drawer) window.Drawer.refresh(); } catch (e) {}
      fillAbout();
      return n;
    });
  }

  // ==================== 初始化 ====================
  // 图表模式（Eta 浮窗）：?mode=chart 时只保留行情条 + K 线 + 周期栏
  var CHART_ONLY = /[?&]mode=chart/.test(location.search);

  function applyChartOnly() {
    if (!CHART_ONLY) return;
    document.documentElement.setAttribute('data-mode', 'chart');
    ['aiSheet', 'aiPanel'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('chart-only-hide');
    });
    // 抽屉只留股票分组。模型/知识库/skill/世界书/会话全部属于 Eta 底座，
    // 这个页面不该再有第二套 —— 直接删掉节点，不是隐藏。
    ['drKnowledge', 'btnSettings', 'drTheme'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    ['sessSec', 'drSessions'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    // 图上的 AI 浮标、抽屉里的“股问AI”品牌，都和 Eta 里的定位不符
    var actions = $('chartActions');
    if (actions && actions.parentNode) actions.parentNode.removeChild(actions);
    var drName = document.querySelector('.drawer-app-name');
    if (drName) drName.textContent = '自选与分组';
    var drClass = document.querySelector('.drawer-class');
    if (drClass) drClass.style.display = 'none';
    document.title = 'K线';

  }

  function init() {
    applyChartOnly();
    chart = new StockChart($('chart'));
    // ★ 必须在图表建好之后套主题（setTheme 要调 chart.render 重画）
    try { applyTheme(S.cfg.theme || 'dark', true); } catch (e) { console.warn('主题', e); }
    try { applyFs(S.cfg.fs || 'm', true); } catch (e) { console.warn('字号', e); }
    try { S.indOn.CHAN = (S.cfg.chanOn !== false); } catch (e) {}
    try { applyUiScale(S.cfg.uiScale || 100); } catch (e) { console.warn('界面缩放', e); }
    try { installSwipeBack(); } catch (e) { console.warn('横移返回', e); }
    // 跟随系统时，系统主题变了要跟着换
    try {
      var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
      if (mq) {
        var onSysTheme = function () { if (S.cfg.theme === 'auto') applyTheme('auto', true); };
        if (mq.addEventListener) mq.addEventListener('change', onSysTheme);
        else if (mq.addListener) mq.addListener(onSysTheme);
      }
    } catch (e) {}

    if (NATIVE) {
      try {
        var cfgStr = NATIVE.getConfig();
        if (cfgStr && cfgStr !== '{}') {
          var c = JSON.parse(cfgStr);
          for (var k in c) S.cfg[k] = c[k];
        }
        // 旧的保守默认值一律抬到 65536：配额给足，让服务端去决定真正的上限。
        // 真被服务端顶回来时，原生层会自动减半重试并把可用值写回配置。
        if (!S.cfg.maxTokens || S.cfg.maxTokens < 65536) S.cfg.maxTokens = 65536;
        // ★ 老用户升级进来时只有一组 baseUrl/apiKey/model，
        //   这里把它收成「默认配置」，否则设置页的配置列表是空的 —— 等于配置丢了。
        ensureProfiles();
        if (S.cfg.profiles && S.cfg.profiles.length) {
          // 迁移后落了盘才算真的安全
          if (!S.cfg.activeId) S.cfg.activeId = S.cfg.profiles[0].id;
          try { NATIVE.saveConfig(JSON.stringify(S.cfg)); } catch (e2) {}
        }
        var wl = NATIVE.getWatchlist();
        if (wl && wl !== '[]') {
          if (window.Groups) window.Groups.load(wl);       // 兼容旧的纯数组格式
          else S.watchlist = JSON.parse(wl);
        }
        // 恢复上次看的那只（没有记录才用默认的浦发银行）
        // K 线画法：配置里存的是 candleStyle，指标条读的是 indOn.HOLLOW
        S.indOn.HOLLOW = (S.cfg.candleStyle === 'hollow');
        if (S.cfg.lastCode) {
          S.code = S.cfg.lastCode;
          if (S.cfg.lastName) S.name = S.cfg.lastName;
        }
      } catch (e) { console.warn('config', e); }
    }
    if (!S.watchlist.length) {
      S.watchlist = [
        { code: 'sh600000', name: '浦发银行' },
        { code: 'sz000001', name: '平安银行' },
        { code: 'sh600519', name: '贵州茅台' }
      ];
    }
    if (window.Groups) window.Groups.ensureInit();

    // 顶栏第二行那个按钮上的指标计数
    updateIndCount();

    try { renderIndBar(); } catch (e) { console.error('indbar', e); }
    try { paintThemeChoices(); } catch (e) { console.error('theme choices', e); }
    try { renderWatchlist(); } catch (e) { console.error('watchlist', e); }
   
    try { bindEvents(); } catch (e) { console.error('bindEvents', e); }
    try { bindSheetDrag(); } catch (e) { console.error('bindSheetDrag', e); }
    // 首帧：空会话只占一条引导语的高度（用户一发问就自动展开，见 autoExpandSheet）
    (function initSheet() {
      applySheetHeight(SHEET_EMPTY_H);
    })();
    try { autoGrowInput(); } catch (e) {}
    // 初始布局可能还没完成（WebView 首帧），延迟再校准一次尺寸
    setTimeout(function () { if (chart) chart.resize(); }, 120);
    setTimeout(function () { if (chart) chart.resize(); }, 600);

    // ★ 视口变化（面板拖高矮 / 输入法弹出）必须重排画布。
    //   原来只在首帧校准，拖动面板高度后 canvas 还是旧尺寸，K 线会被裁掉。
    (function () {
      var resizeTimer = null;
      window.addEventListener('resize', function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { if (chart) chart.resize(); }, 120);
      });
    })();

    // ★ 兜底自检：万一 AI 面板被裁掉/塌成 0 高（DOM 层级或高度链出问题），
    //   用 vh 单位强制给一个高度（vh 只依赖视口，不受父容器影响）。
    setTimeout(function () {
      var sheet = $('aiSheet');
      if (!sheet) return;
      var hh = sheet.getBoundingClientRect().height || 0;
      if (hh < 60) {
        console.warn('对话区高度异常(' + hh + 'px)，启用 vh 兜底');
        sheet.style.height = '42vh';
        if (chart) chart.resize();
      }
    }, 900);
    try { if (window.Drawer) window.Drawer.init(); } catch (e) { console.error('drawer', e); }
    try { if (window.Knowledge && Knowledge.init) Knowledge.init(); } catch (e) { console.error('kb', e); }
    // 首次启动把内置 skill 写进沙箱（已存在的不动，避免覆盖用户改过的）
    try {
      if (window.Knowledge && Knowledge.seedBuiltin) {
        Knowledge.seedBuiltin().then(function (r) {
          if (r && r.added) console.log('已预置 ' + r.added + ' 个内置 skill');
        }).catch(function () {});
      }
      // 内置世界书同样预置（合并，不动用户自己的条目）
      if (window.Knowledge && Knowledge.seedWorldbook) {
        Knowledge.seedWorldbook().then(function (r) {
          if (r && r.added) console.log('已预置 ' + r.added + ' 条内置世界书');
        }).catch(function () {});
      }
    } catch (e) { console.warn('seedBuiltin', e); }
    try { if (window.Groups) { window.Groups.init(); window.Groups.renderPane(); } } catch (e) { console.error('groups', e); }
    try { if (window.Page && window.Page.init) window.Page.init(); } catch (e) { console.error('page', e); }
    try { updateIndCount(); fillAbout(); } catch (e) {}
    // 先把该股票的会话读出来，再拉行情 —— 否则历史会把刚渲染的对话覆盖掉
    if (window.Sessions) {
      loadSession(S.code, S.name).then(function () { loadData(); });
    } else {
      loadData();
    }

    // 行情定时刷新
    setInterval(function () {
      if (document.hidden) return;
      try { refreshWatchQuotes(); } catch (e) { console.error('refresh', e); }
    }, 15000);
  }

  // ===== 诊断：把错误完整暴露出来（WebView 对跨域脚本会把 message 脱敏成 "Script error."）=====
  var ERR_COUNT = 0;
  function reportError(kind, detail) {
    ERR_COUNT++;
    if (ERR_COUNT > 6) return;   // 避免刷屏
    try {
      var box = $('aiMessages');
      if (!box) return;
      var hint = box.querySelector('.ai-hint');
      if (hint) hint.remove();
      var d = document.createElement('div');
      d.className = 'msg err';
      d.textContent = '[' + kind + '] ' + detail;
      box.appendChild(d);
      var p = $('aiPanel');
      if (p) setTimeout(function () { p.scrollTop = p.scrollHeight; }, 30);
    } catch (e) { }
  }

  window.addEventListener('error', function (ev) {
    var msg = ev.message || '未知';
    // 脱敏时用 stack 兜底
    if ((msg === 'Script error.' || !msg) && ev.error && ev.error.stack) {
      msg = ev.error.stack.split('\n').slice(0, 3).join(' | ');
    }
    reportError('脚本错误',
      msg + (ev.filename ? ' @' + String(ev.filename).split('/').pop() + ':' + ev.lineno : ''));
  });

  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    var msg = (r && (r.stack || r.message)) || String(r);
    reportError('未处理异常', String(msg).split('\n').slice(0, 3).join(' | '));
  });

  // ==================== Agent 内部句柄 ====================
  // tools.js / agent.js 要用到这里的状态与解析函数。
  // 只开一个明确的出口，不做双向依赖 —— agent 是叠加层，不能反过来绑住主逻辑。
  window.__app = {
    S: S,
    // 测试钩子：多配置档的行为级验证用（切换后生效字段是否真的跟着变）
    __profiles: {
      switchProfile: switchProfile,
      addProfile: addProfile,
      deleteProfile: deleteProfile,
      ensureProfiles: ensureProfiles,
      getActive: getActiveProfile,
      setEditorOpen: setEditorOpen,
      __setProfiles: function (list, activeId) {
        S.cfg.profiles = list;
        S.cfg.activeId = activeId;
        applyProfile(getActiveProfile());
      }
    },
    cfg: function () { return S.cfg; },
    chart: function () { return chart; },
    callNative: callNative,
    callNativeEx: callNativeEx,
    hasNative: hasNative,
    makeLiveView: makeLiveView,
    parseQuote: parseQuote,
    parseKline: parseKline,
    parseMinute: parseMinute,
    parseSearch: parseSearch,
    periodName: periodName,
    fmtPrice: fmtPrice,
    fmtVol: fmtVol,
    fx: fx,
    num: num,
    esc: esc,
    showCursorInfo: showCursorInfo,
    setSheetTitle: setSheetTitle,
    setSheetHint: setSheetHint,
    addMsg: addMsg,
    pickFocusIdx: pickFocusIdx,
    getCurrentPrompts: getPrompts,
    dataReady: function () { return !!(S.kl && S.kl.length); },
    currentCode: function () { return S.code; },
    currentName: function () { return S.name; },
    currentPeriod: function () { return S.period; },
    // 折叠条要显示现价 / 涨跌幅：紧凑态顶部行情卡被隐藏了，
    // 这几个值只能从这里回传 Kotlin，否则信息就丢了。
    currentPrice: function () { return S.quote ? S.quote.price : null; },
    currentChange: function () { return S.quote ? S.quote.change : null; },
    currentPct: function () { return S.quote ? S.quote.pct : null; },
    makeStream: makeStream,
    toggleSheet: toggleSheet,
    applySheetHeight: applySheetHeight,
    sheetMaxHeight: sheetMaxHeight,
    syncChanStatusInset: syncChanStatusInset,
    setSheetFullMode: setSheetFullMode,
    topRowsHeight: topRowsHeight,
    renderWatchlist: renderWatchlist,
    saveWatch: saveWatch,
    switchStock: switchStock,
    clearConversation: clearConversation,
    back: back,
    openPage: openPage,
    closePage: closePage,
    openBottomSheet: openBottomSheet,
    closeBottomSheet: closeBottomSheet,
    bottomSheetOpen: bottomSheetOpen,
    openIndicatorSheet: openIndicatorSheet,
    applyIndicatorToggle: applyIndicatorToggle,
    updateIndCount: updateIndCount,
    refreshCtxChip: refreshCtxChip,
    clearFocus: clearFocus,
    clearAllSessions: clearAllSessions,
    fillAbout: fillAbout,
    applyTheme: applyTheme,
    resolvedTheme: resolvedTheme,
    cycleTheme: cycleTheme,
    setThemeOption: setThemeOption,
    paintThemeOptions: paintThemeOptions,
    themeLabel: themeLabel,
    openStockGroupSheet: openStockGroupSheet,
    saveCurrentSession: saveCurrentSession,
    loadSession: loadSession,
    openSettings: openSettings
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      try { init(); } catch (e) {
        console.error('init 失败', e);
        try {
          var box = $('aiMessages');
          if (box) {
            box.innerHTML = '<div class="msg err">初始化失败：' + (e.message || e) + '</div>';
          }
        } catch (e2) { }
      }
    });
  } else {
    try { init(); } catch (e) { console.error('init 失败', e); }
  }
})();
