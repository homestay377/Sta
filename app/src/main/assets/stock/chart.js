/* =========================================================
 * 图表渲染引擎（Canvas 2D）
 * 三段式布局：价格区 / 成交量区 / 副图指标区
 * 支持：K线、分时线、均线、BOLL、MACD/KDJ/RSI 副图、量能MA、十字光标、触摸拖动
 * ========================================================= */
(function (global) {
  'use strict';

  // ★ 通达信配色：纯黑底 + 高饱和亮色。
  //   之前用深灰底(#0e1117)+暗橙/暗紫(#e65100/#6a1b9a)，在手机上对比度不足显得"糊"。
  //   通达信之所以清晰，核心是：纯黑底 + 亮色线条 + 线条够粗。
  //   ★ v6.0 浅色主题：配色整体拆成两套。所有绘制代码都只读 COL.xxx，
  //     切换主题时把这个引用换成另一套再 render() 一次即可，不用动绘制逻辑。
  //     浅色那套特意避开了"在白底上看不见"的颜色（金黄 #ffe600、天蓝 #4fc3f7、
  //     浅绿 #69db7c 这类在白底上几乎为空白的色值）。
  var THEMES = {
    dark: {
      bg: '#141519',            // 与新 UI 一致的深空灰
      grid: '#24252d',         // 网格压暗，不抢主线
      axis: '#34353d',
      text: '#c8c8c8', textBold: '#ffffff',
      up: '#ff3232',            // 亮红（涨）
      down: '#00e0c0',         // 亮青绿（跌），通达信用青
      // 均线：通达信用高饱和色，一眼可辨
      ma5: '#ffd700', ma10: '#ff44ff', ma20: '#00ffff', ma60: '#00ff00',
      ma120: '#ff8800', ma250: '#ffffff',
      bollUp: '#ff8800', bollMid: '#ffff00', bollLow: '#00ffff',
      dif: '#ffff00', dea: '#00ffff',
      k: '#ffff00', d: '#00ffff', j: '#ff44ff',
      rsi: '#ff44ff',
      cross: '#ffffff', vma5: '#ffd700', vma10: '#ff44ff',
      // 图上的色块与文字：都不是亮到在白底上会消失的值
      volUp: 'rgba(255,77,79,.75)', volDown: 'rgba(38,166,91,.75)',
      subUp: 'rgba(255,77,79,.8)', subDown: 'rgba(38,166,91,.8)',
      areaTop: 'rgba(249,168,37,.25)', areaBot: 'rgba(249,168,37,0)',
      chipBg: 'rgba(0,0,0,0.78)', chipLine: 'rgba(255,230,0,0.55)', chipText: '#ffe600',
      axisText: '#0e1117', labelInk: '#000000',
      // 当前界面最高/最低价标注：比网格亮一点，但明显弱于 K 线本身
      rangeMark: '#8d93a6', rangeMarkBg: 'rgba(10,11,16,.72)',
      // 分时：价格线用亮青蓝、均价线用黄，两者一眼能分开
      minuteLine: '#4fc3f7', minuteAvg: '#ffd700',
      ai: {
        resist: '#ff9f43', support: '#4fc3f7', stop: '#ff6b9d', target: '#b388ff',
        zone: 'rgba(124,92,255,0.10)'
      },
      chan: {
        pen: '#ffe600', penUp: '#ffe600', penDown: '#ffe600',
        boxRed: '#ffe600', boxGreen: '#ffe600',
        boxMid: 'rgba(255,230,0,0.30)',
        zgText: '#ffe600', buy: '#ffe600', sell: '#ffe600'
      }
    },
    light: {
      bg: '#ffffff',
      grid: '#eef1f4',
      axis: '#c9d1d9',
      text: '#4b5563', textBold: '#1f2329',
      up: '#e03131',            // 涨：红，白底上要压深才看得清
      down: '#12a150',          // 跌：绿
      ma5: '#e8890c', ma10: '#c026d3', ma20: '#0b7285', ma60: '#2f9e44',
      ma120: '#d9480f', ma250: '#495057',
      bollUp: '#e8590c', bollMid: '#b08900', bollLow: '#0b7285',
      dif: '#b08900', dea: '#0b7285',
      k: '#b08900', d: '#0b7285', j: '#c026d3',
      rsi: '#c026d3',
      cross: '#333333', vma5: '#e8890c', vma10: '#c026d3',
      volUp: 'rgba(224,49,49,.5)', volDown: 'rgba(18,161,80,.5)',
      subUp: 'rgba(224,49,49,.65)', subDown: 'rgba(18,161,80,.65)',
      areaTop: 'rgba(240,140,0,.14)', areaBot: 'rgba(240,140,0,0)',
      chipBg: 'rgba(255,255,255,0.92)', chipLine: 'rgba(176,137,0,0.55)', chipText: '#8a6100',
      axisText: '#ffffff', labelInk: '#ffffff',
      rangeMark: '#5a6472', rangeMarkBg: 'rgba(255,255,255,.82)',
      minuteLine: '#0b7285', minuteAvg: '#b08900',
      ai: {
        resist: '#b26a00', support: '#0b6bcb', stop: '#c2185b', target: '#6a1b9a',
        zone: 'rgba(106,27,154,0.08)'
      },
      chan: {
        pen: '#b58900', penUp: '#b58900', penDown: '#b58900',
        boxRed: '#b58900', boxGreen: '#b58900',
        boxMid: 'rgba(181,137,0,0.35)',
        zgText: '#8a6100', buy: '#b58900', sell: '#b58900'
      }
    }
  };

  var COL = THEMES.dark;

  /**
   * 切换画布配色。
   * 直接换 COL 引用即可 —— 绘制函数都是在 render 时读 COL.xxx。
   * 已有实例要再 render() 一次，否则只是换了引用、图还是旧颜色。
   */
  function setPalette(name) {
    COL = THEMES[name] || THEMES.dark;
    AI_COLORS = COL.ai;
    CHAN_COL = COL.chan;
    return COL;
  }

  function Chart(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    var _d = global.devicePixelRatio || 1;
    this.dpr = _d < 2 ? 2 : _d;   // 下限 2 倍，保证清晰
    this.kl = [];
    this.ind = {};
    this.isMinute = false;
    this.start = 0;          // 可视区起始索引
    this.visible = 100;      // 可视 K 线数（8 ~ 全部可缩放）
    this.crossIdx = -1;      // 十字光标索引（仅长按激活时才有值）
    this.selIdx = -1;        // 轻点选中的 K 线（用于「问这根」按钮，不画十字线）
    this.padL = 4;
    this.padR = 46;
    // 图表顶部被"DOM 覆盖层"（缠论状态条）占掉的高度。
    // 由 app.js 量好之后通过 setTopInset() 告知，价格区从这里往下开始画，
    // 保证 K 线永远不和状态条叠在一起。
    this.topInset = 0;
    this._legendH = 0;
    this.hPrice = 0.62;      // 价格区高度占比
    this.hVol = 0.14;
    this.showSub = false;
    this.showVol = true;      // 成交量副条：可单独关掉，全关就只剩主图
    /** 紧凑模式：图表很矮时（展开态）压缩量与副图，把高度让给 K 线本身 */
    this.compactLayout = false;
    this.subType = '';
    this.aiLevels = [];      // AI 给出的价位标注 [{price,label,type}]
    this.aiZones = [];       // AI 关注区 [{from,to,label}]
    this.aiMarks = [];       // 点标注 [{date,price,label,type}]
    this.aiTexts = [];       // 文字标注 [{date,price,text,color,size,align}]
    this.aiFib = [];         // 黄金分割 [{fromDate,fromPrice,toDate,toPrice,ratios}]
    this.shapes = [];        // AI 自由绘图图元（坐标存「索引 + 价格」，不存像素）
    this.showShapes = true;  // 图元图层开关
    this.showAi = true;      // AI 标注总开关
    this.chan = null;        // 缠论分析结果 {pens, boxes, bi}
    this.showChan = true;    // 缠论图层开关（指标栏默认勾选）
    this.showChanBi = true;  // 笔连线
    this.showChanBox = true; // 中枢框
    this.showChanPen = false; // 转折点小圆点（默认关，笔的端点已由连线表达）
    this.resize();
    this.observeResize();   // 容器尺寸变化时自动重算（拖 AI 面板/旋转屏幕）
    this.bindTouch();
  }

  /** 成交量副条显隐（副图全部关掉时，价格图会自动吃满高度） */
  Chart.prototype.setVolVisible = function (on) {
    var v = on !== false;
    if (this.showVol === v) return;
    this.showVol = v;
    this.render();
  };

  Chart.prototype.resize = function () {
    // ★ 尺寸完全由「容器实际大小」决定，不再用 innerHeight 硬减。
    //   之前用 vh-190 估高度、rect.width||320 估宽度，一旦容器还没布局完成
    //   就会拿到 0/320，导致 canvas 比容器窄 → K 线只画在左侧一小块。
    var host = this.cv && (this.cv.parentNode || this.cv.parentElement);
    var w = host ? (host.clientWidth || 0) : 0;
    var h = host ? (host.clientHeight || 0) : 0;

    // 容器没就绪时退回视口估算，但绝不小于合理值
    if (!w || w < 40) w = this._lastW || (global.innerWidth || 360);
    if (!h || h < 40) h = this._lastH || Math.max(200, (global.innerHeight || 640) - 200);

    w = Math.max(180, Math.round(w));
    h = Math.max(140, Math.round(h));

    // 尺寸没变就不重绘（避免 ResizeObserver 抖动时反复 render）
    if (w === this.w && h === this.h && this._sized) return;
    this._lastW = w; this._lastH = h;

    var dpr = global.devicePixelRatio || 1;
    if (dpr < 2) dpr = 2;
    this.dpr = dpr;

    this.w = w; this.h = h;
    this.cv.style.width = w + 'px';
    this.cv.style.height = h + 'px';
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);

    var ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    this._sized = true;
    this.render();
  };

  /** 监听容器尺寸变化，自动重算（拖 AI 面板、旋转屏幕都会触发） */
  Chart.prototype.observeResize = function () {
    var self = this;
    var host = this.cv.parentNode || this.cv.parentElement;
    if (!host) return;

    if (global.ResizeObserver) {
      try {
        if (this._ro) this._ro.disconnect();
        this._ro = new ResizeObserver(function () {
          if (self._raf) return;
          self._raf = (global.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(
            function () { self._raf = null; self.resize(); }
          );
        });
        this._ro.observe(host);
        return;
      } catch (e) { /* 落到轮询方案 */ }
    }

    // 兜底：定时检查容器尺寸（老 WebView 无 ResizeObserver）
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(function () {
      if (document.hidden) return;
      var hh = self.cv.parentNode || self.cv.parentElement;
      if (!hh) return;
      if (hh.clientWidth !== self.w || hh.clientHeight !== self.h) self.resize();
    }, 400);
  };

  // ==================== 渲染批处理（v10.25）====================
  //
  // 问题：setData / setChan / setAiMarks / clearAiMarks / setShapes 每个 setter 内部
  // 都直接 render()，而 app.js 一次切周期会连着调 5~6 个 —— 等于把同一张图
  // 全量重画 5~6 遍，中间几次还是「白画」。
  //
  // 做法：setter 只标脏；不批处理时立刻画（保持原有同步语义，测试与旧代码不受影响），
  // 处于 batch() 内则攒到出批处理再画一次。
  Chart.prototype.invalidate = function () {
    this._dirty = true;
    if (this._batchDepth > 0) return;
    this._dirty = false;
    this.render();
  };

  /** 把一组 setter 合并成一次重绘。同步执行，出错也会保证出批处理。 */
  Chart.prototype.batch = function (fn) {
    this._batchDepth = (this._batchDepth || 0) + 1;
    try {
      return fn();
    } finally {
      this._batchDepth--;
      if (!this._batchDepth && this._dirty) {
        this._dirty = false;
        this.render();
      }
    }
  };

  Chart.prototype.setData = function (kl, ind, isMinute) {
    this.kl = kl || [];
    this.ind = ind || {};
    this.isMinute = !!isMinute;
    // ★ 分时的副图（MACD/KDJ/RSI）整体不显示：用户明确要求分时只有
    //   价格折线和均价线两根线。副图会额外画一张指标图例（MACD(12,26,9)…），
    //   画出来就成了三根线，和预期不符。
    //   这里直接把 subType 清空 + showSub 关掉，不依赖 app.js 的调用顺序。
    this.subType = '';
    this.showSub = false;
    var n = this.kl.length;

    // ★ 分时 = 一整个交易日（或 N 个交易日）的完整图，**永远全量显示**。
    //
    //   原来这里统一走 `visible = min(visible, n)`，而 visible 的默认值是 100，
    //   于是分时有 240 个点时只画最后 100 根 —— 用户看到的是一段局部曲线，
    //   还要"缩放/拖动"才能看全，这跟分时的语义完全相反。
    //   分时没有"看多少根"的概念：一天就是一天，开盘到收盘必须一屏画完。
    //   所以分时下直接 visible = n、start = 0（全量），且不允许被手势改。
    if (this.isMinute) {
      this.visible = Math.max(1, n);
      this.start = 0;
    } else {
      this.visible = Math.min(this.visible, Math.max(8, n));
      this.start = Math.max(0, n - this.visible);
    }
    this.crossIdx = -1;
    this.selIdx = -1;
    this.invalidate();
  };

  /**
   * 紧凑模式开关。
   * 展开态（对话区占大头）时打开：量/副图比例压低，价格区抬到 ~76%。
   * 常规态关掉，保持通达信原比例。
   */
  Chart.prototype.setCompactLayout = function (on) {
    var v = !!on;
    if (v === this.compactLayout) return this;
    this.compactLayout = v;
    this.invalidate();
    return this;
  };

  Chart.prototype.setSub = function (type) {
    this.subType = type || '';
    this.showSub = !!type;
    this.invalidate();
  };

  /** 切换主题配色并重画（深/浅两套调色板在 THEMES 里，切换是换引用） */
  Chart.prototype.setTheme = function (name) {
    this.paletteName = setPalette(name) === THEMES.light ? 'light' : 'dark';
    this.col = COL;
    this.render();
    return this;
  };

  /** 当前调色板（供调试与测试读取，避免依赖模块内私有变量） */
  Chart.prototype.palette = function () {
    return COL;
  };

  // ==================== 触摸交互 ====================
  Chart.prototype.bindTouch = function () {
    var self = this;
    var dragging = false, moved = false;
    var startX = 0, startStart = 0, startY = 0;
    var startVisible = 0;          // 按下时的可视根数（垂直缩放用）
    var axis = null;               // 锁定的手势方向：'x' 平移 / 'y' 缩放
    var pinchDist = 0, pinchVisible = 0;
    var longPressTimer = null;
    var crossActive = false;      // 只有长按才激活十字光标
    var LONG_PRESS_MS = 300;
    var AXIS_LOCK_PX = 14;         // 超过这个位移才锁定方向（8px 太小，长按时手指微抖就被当成拖动）
    var ZOOM_K = 150;              // 垂直缩放灵敏度（越小越快；320 太钝，手指要拖很远）

    function getPos(e) {
      var r = self.cv.getBoundingClientRect();
      var t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }

    function idxAt(x) {
      var plotW = self.w - self.padL - self.padR;
      var bw = plotW / self.visible;
      var i = Math.floor((x - self.padL) / bw) + self.start;
      return Math.max(self.start, Math.min(self.start + self.visible - 1, i));
    }

    function dist(e) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    /**
   * 通用按帧节流重绘。
   *
   * 手势每动一下就是几十个 touchmove，直接 render() 会在 WebView 的软件渲染下
   * 把主线程塞满 —— 表现就是横向拖动、双指缩放、十字光标移动都「拖不动」。
   * 这里把同一帧内的多次重绘合并成一次。
   */
  var renderRaf = 0;
  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = (global.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
      renderRaf = 0;
      self.render();
    });
  }

  /** 十字光标当前画在哪一列（px，相对画布左沿） */
    function crossX() {
      if (self.crossIdx < 0) return -1;
      var plotW = self.w - self.padL - self.padR;
      var bw = plotW / self.visible;
      return self.padL + (self.crossIdx - self.start + 0.5) * bw;
    }

    /**
     * 把十字光标移到某个 x 位置。
     * ★ 按帧节流：手指一动就是几十个 touchmove，每次都全量重绘（800 根 K 线 + 指标 + 缠论）
     *   会把 WebView 的 JS 线程塞满，表现就是拖一下就“卡死”。现在每帧最多画一次。
     */
    var crossRaf = 0, crossPendingX = null;
    function setCrossAt(x) {
      crossPendingX = x;
      if (crossRaf) return;
      crossRaf = (global.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () {
        crossRaf = 0;
        var px = crossPendingX;
        crossPendingX = null;
        if (px == null) return;
        var idx = idxAt(px);
        if (idx === self.crossIdx && idx === self.selIdx) return;
        self.crossIdx = idx;
        self.selIdx = idx;
        self.render();
        if (self.onCross) self.onCross(idx);
      });
    }

    function cancelLongPress() {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }

    function onDown(e) {
      if (e.touches && e.touches.length === 2) {
        cancelLongPress();
        // 分时全量显示，不需要缩放：双指一律忽略
        if (self.isMinute) return;
        pinchDist = dist(e);
        pinchVisible = self.visible;
        crossActive = false;
        // 双指时清掉十字光标，专心缩放
        if (self.crossIdx >= 0) { self.crossIdx = -1; self.render(); }
        return;
      }
      dragging = true; moved = false; crossActive = false; axis = null;
      var p = getPos(e);

      startX = p.x; startY = p.y;
      startStart = self.start;
      startVisible = self.visible;

      // ★ 关键：按下时不立即出十字线，等长按 350ms 才激活。
      //   这样轻点/滑动都不会误触，只有"按住不动"才进入十字光标模式。
      cancelLongPress();
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        crossActive = true;
        moved = false;
        var i0 = idxAt(startX);
        self.crossIdx = i0;
        self.selIdx = i0;
        self.render();
        // ★ 长按进入十字模式不会走 onTap，必须在这里通知外部，
        //   否则「问这根」拿到的还是上一次轻点的旧索引（就是问错根的原因）
        if (self.onCross) self.onCross(i0);
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { } }
      }, LONG_PRESS_MS);

      if (e.cancelable) e.preventDefault();
    }

    function onMove(e) {
      if (e.touches && e.touches.length === 2) {
        cancelLongPress();
        if (self.isMinute) return;   // 分时不做双指缩放
        var d = dist(e);
        if (pinchDist > 0) {
          var ratio = pinchDist / d;
          var nv = Math.round(pinchVisible * ratio);
          nv = Math.max(8, Math.min(self.kl.length, nv));
          if (nv !== self.visible) {
            self.visible = nv;
            self.start = Math.max(0, Math.min(self.kl.length - nv, self.start));
            scheduleRender();
          }
        }
        e.preventDefault();
        return;
      }
      if (!dragging) return;
      var p = getPos(e);
      var plotW = self.w - self.padL - self.padR;
      var bw = plotW / self.visible;

      if (crossActive) {
        // 十字模式：手指横向移动 → 光标跟着走（同样走按帧节流）
        setCrossAt(p.x);
        if (e.cancelable) e.preventDefault();
        return;
      }

      var dx = p.x - startX;
      var dy = p.y - startY;

      // ★ 分时：整张图就是一天（或 N 天）的全部，没有"看哪一段"的概念。
      //   所以平移和缩放全部禁掉 —— 只保留长按十字光标（看某一分钟的数值）。
      //   之前只禁了纵向缩放、保留了横移，用户仍然能把图拖成局部，与预期不符。
      if (self.isMinute) {
        if (Math.abs(dx) > AXIS_LOCK_PX || Math.abs(dy) > AXIS_LOCK_PX) {
          moved = true;
          cancelLongPress();
        }
        if (e.cancelable) e.preventDefault();
        return;
      }

      // ★ 方向锁定：第一次移动超过阈值时判定主方向，之后不再切换。
      //   横向 → 平移；纵向 → 缩放。这样两种单指手势不会互相干扰。
      if (!axis) {
        if (Math.abs(dx) > AXIS_LOCK_PX || Math.abs(dy) > AXIS_LOCK_PX) {
          axis = (Math.abs(dx) >= Math.abs(dy)) ? 'x' : 'y';
          moved = true;
          cancelLongPress();     // 一旦滑动，取消长按
        }
      }

      var n = self.kl.length;

      if (axis === 'x') {
        // ---- 横向：平移 ----
        var shift = Math.round((startX - p.x) / bw);
        self.start = Math.max(0, Math.min(n - self.visible, startStart + shift));
        self.crossIdx = -1;
        scheduleRender();

      } else if (axis === 'y') {
        // ---- 纵向：缩放 ----
        // （分时在上面就已经 return 了，不会走到这里）
        // dy = p.y - startY：向上滑 dy<0，向下滑 dy>0。
        // 要求「上滑=放大」（K线变宽、根数变少），所以用 exp(dy/K)：
        //   上滑 dy<0 → 系数<1 → visible 变小 → 放大 ✓
        //   下滑 dy>0 → 系数>1 → visible 变大 → 缩小 ✓
        var nv = Math.round(startVisible * Math.exp(dy / ZOOM_K));
        nv = Math.max(8, Math.min(n, nv));
        if (nv !== self.visible) {
          // 以按下时的可视区中心为锚点，缩放时视图不跳动
          var center = startStart + startVisible / 2;
          self.visible = nv;
          self.start = Math.max(0, Math.min(n - nv, Math.round(center - nv / 2)));
          self.crossIdx = -1;
          // 缩放反馈（放大/缩小 + 当前根数），1.2 秒后自动消失
          self.gestureHint = (nv < startVisible ? '放大  ' : '缩小  ') + nv + ' 根';
          if (self._hintTimer) clearTimeout(self._hintTimer);
          self._hintTimer = setTimeout(function () {
            self.gestureHint = null;
            scheduleRender();
          }, 1200);
          scheduleRender();
        }
      }
      if (e.cancelable) e.preventDefault();
    }

    function onUp(e) {
      cancelLongPress();
      dragging = false;
      axis = null;
      if (!moved && !crossActive) {
        // 轻点：记录选中的 K 线；如果十字光标已经存在，就把它挪到这一根。
        // 轻点本身永远不会“新建”十字（避免翻看时误触），但“挪过去”用轻点最稳：
        // 不需要按住竖线，也不会和拖动/缩放手势打架。
        var pt = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : e;
        var r2 = self.cv.getBoundingClientRect();
        var idx = idxAt(pt.clientX - r2.left);
        self.selIdx = idx;
        if (self.crossIdx >= 0) {
          self.crossIdx = idx;
          self.render();
          if (self.onCross) self.onCross(idx);
        }
        if (self.onTap) self.onTap(idx);
      }
      crossActive = false;
    }

    function onCancel() {
      cancelLongPress();
      dragging = false;
      crossActive = false;
      axis = null;
    }

    this.cv.addEventListener('touchstart', onDown, { passive: false });
    this.cv.addEventListener('touchmove', onMove, { passive: false });
    this.cv.addEventListener('touchend', onUp, { passive: true });
    this.cv.addEventListener('touchcancel', onCancel, { passive: true });
  };

  // ==================== 均线图例排版 ====================

  var LEGEND_LINE_H = 9;       // 图例单行高（8px 字号 + 1px 呼吸）
  var LEGEND_GAP = 2;          // 图例与价格区之间的空隙
  var MA_ORDER = ['MA5', 'MA10', 'MA20', 'MA60', 'MA120', 'MA250'];

  function maColor(key) {
    return { MA5: COL.ma5, MA10: COL.ma10, MA20: COL.ma20,
             MA60: COL.ma60, MA120: COL.ma120, MA250: COL.ma250 }[key] || COL.ma20;
  }

  /**
   * 先把「均线图例」排成若干行，再决定价格区从哪儿开始。
   *
   * ★ 以前是「先定 priceTop，再在图内画图例」——
   *   6 条均线在窄屏放不下会自动换行，第二行直接压在蜡烛上，
   *   和 K 线、价格轴标签糊成一片（用户截图里那两行就是这么来的）。
   *   现在图例改成独立的顶部条带：它占多高，价格区就让多少。
   */
  Chart.prototype._layoutLegend = function (ctx, plotW) {
    var rows = [];
    if (!this.kl.length) return { rows: rows, height: 0 };
    ctx.font = '7.5px -apple-system,sans-serif';
    var lastI = this.kl.length - 1;
    var maxX = this.padL + plotW - 2;
    var cur = [];
    var x = this.padL + 2;

    // ★ 分时的图例只有「价」「均」两枚 —— 分时图就是这两条线，
    //   没有均线、也没有 BOLL/KDJ/RSI。
    if (this.isMinute) {
      var lastBar = this.kl[lastI];
      var priceTxt = '价:' + (lastBar.c != null ? lastBar.c.toFixed(2) : '--');
      var avgTxt = '均:' + (lastBar.avg != null && isFinite(lastBar.avg)
        ? lastBar.avg.toFixed(2) : '--');
      var pt1 = ctx.measureText(priceTxt).width;
      cur.push({ text: priceTxt, color: COL.minuteLine || COL.ma20, x: x });
      x += pt1 + 7;
      cur.push({ text: avgTxt, color: COL.minuteAvg || COL.dif, x: x });
      x += ctx.measureText(avgTxt).width + 7;
      if (cur.length) rows.push(cur);
      // ★ 分时到此为止，不再追加 MA 系列（分时没有均线）
      return { rows: rows, height: rows.length ? rows.length * LEGEND_LINE_H : 0 };
    }

    if (!this.ind.ma) {
      if (cur.length) rows.push(cur);
      return { rows: rows, height: rows.length ? rows.length * LEGEND_LINE_H : 0 };
    }
    for (var i = 0; i < MA_ORDER.length; i++) {
      var k = MA_ORDER[i];
      var arr = this.ind.ma[k];
      if (!arr) continue;
      var v = arr[lastI];
      if (v == null || !isFinite(v)) continue;
      var txt = k + ':' + v.toFixed(2);
      var tw = ctx.measureText(txt).width;
      if (cur.length && x + tw > maxX) {
        rows.push(cur);
        cur = [];
        x = this.padL + 2;
      }
      cur.push({ text: txt, color: maColor(k), x: x });
      x += tw + 7;
    }
    if (cur.length) rows.push(cur);
    return { rows: rows, height: rows.length ? rows.length * LEGEND_LINE_H : 0 };
  };

  /**
   * 告知「图表顶部还有多高的 DOM 覆盖层」（缠论状态条）。
   * 只有值真的变了才重画，避免拖动十字时反复 render。
   */
  Chart.prototype.setTopInset = function (px) {
    var v = Math.max(0, Math.round(px || 0));
    if (v === this.topInset) return;
    this.topInset = v;
    this.render();
  };

  // ==================== 绘制 ====================
  Chart.prototype.render = function () {
    var ctx = this.ctx, w = this.w, h = this.h;
    var kl = this.kl;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, w, h);

    if (!kl || kl.length === 0) {
      ctx.fillStyle = COL.text;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据', w / 2, h / 2);
      return;
    }

    var plotW = w - this.padL - this.padR;
    var padT = 6, padB = 4;
    var totalH = h - padT - padB;

    // ---- 顶部条带：均线图例（canvas 内） + 缠论状态条（DOM 覆盖层）----
    //
    // ★ 这里只能用 contentTop 一个来源，绝不能再叠加 topInset。
    //   缠论状态条是 DOM 覆盖层，它的 top 由 --chart-legend-b 决定，
    //   而 --chart-legend-b 的值就是下面的 contentTop —— 也就是说
    //   状态条天然贴在「图例下沿 + 1px」的位置。
    //   以前再把 topInset(=状态条高度+4) 加到 priceTop 上，
    //   等于把同一段高度躲了两次：状态条移到图例下沿，价格区却按
    //   「图例 + 状态条」两段往下推，中间空出一条什么也不画的带子，
    //   而状态条自己的文字又因为价格区上移被人误认为"压住 K 线"。
    //   现在价格区严格从状态条下沿开始，状态条不会再和 K 线、均线糊在一起。
    var legend = this._layoutLegend(ctx, plotW);
    this._legendH = legend.height;
    var legendTop = padT;
    var contentTop = legendTop + legend.height + (legend.height ? LEGEND_GAP : 0);

    // topInset 仅作为「极端窄屏兜底」参与，不参与常规排版（见下）
    var inset = this.topInset || 0;

    var priceTop = contentTop;
    // 极端窄屏（图例 3 行 + 状态条）也要给价格区留下至少 120px。
    // 这时状态条会临时压到顶部一小段 —— 总比 K 线被压成一条缝强。
    if (h - priceTop - padB < 120 + inset) {
      priceTop = Math.max(contentTop, h - padB - 120 - inset);
    }
    totalH = h - priceTop - padB;

    // 三段高度
    //
    // ★ 比例按「紧凑模式」分两套。这不是审美问题，是"看不看得清"的问题：
    //   通达信默认 价格 63% / 量 15% / 副图 22% 是给**全屏**图表定的。
    //   展开态图表总高只有 ~200px 时，扣掉均线图例(22)和缠论状态条(14)，
    //   totalH ≈ 165，价格区 = 165*0.63 ≈ 104px —— 蜡烛被压成一条细线，
    //   用户看到的就是截图里"比例还是没变"。
    //   紧凑模式把量压到 10%、副图压到 14%，把价格区抬到 ~76%：
    //   165*0.76 ≈ 125px，同样高度下蜡烛高度多出 20%。
    var compact = !!this.compactLayout;
    var showSub = !!this.showSub;
    var showVol = this.showVol !== false;
    var bands = (showSub ? 1 : 0) + (showVol ? 1 : 0);
    var gap = bands ? (compact ? 5 : 8) : 0;
    var subRatio = compact ? 0.14 : 0.22;
    var volRatio = compact ? 0.10 : 0.15;
    var subH = showSub ? (totalH - gap * bands) * subRatio : 0;
    var volH = showVol ? (totalH - gap * bands) * volRatio : 0;
    var priceH = totalH - volH - subH - gap * bands;
    if (priceH < 60) priceH = Math.max(40, totalH * (compact ? 0.72 : 0.6));

    var priceBot = priceTop + priceH;
    var volTop = priceBot + (showVol ? gap : 0);
    var volBot = volTop + volH;
    var subTop = volBot + (showSub ? (showVol ? 4 : gap) : 0);
    var subBot = subTop + subH;

    this._layout = {
      legendRows: legend.rows, legendTop: legendTop,
      contentTop: contentTop, legendBottom: contentTop,
      plotW: plotW, priceTop: priceTop, priceBot: priceBot,
      volTop: volTop, volBot: volBot, subTop: subTop, subBot: subBot
    };

    var end = Math.min(this.start + this.visible, kl.length);
    var vis = kl.slice(this.start, end);
    var n = vis.length;
    if (n === 0) return;
    var bw = plotW / this.visible;
    var bodyW = Math.max(1, bw * 0.78);

    // ---- 价格区间 ----
    var hi = -Infinity, lo = Infinity;
    for (var i = 0; i < n; i++) {
      var k = vis[i];
      if (k.h > hi) hi = k.h;
      if (k.l < lo) lo = k.l;
    }
    // ★ 主图指标（均线 / BOLL）不参与 Y 轴范围。
    //   之前把它们也纳入：长期下跌股上 MA120/MA250 远高于现价（如现价 78、
    //   MA250 136），Y 轴被撑到 57~147，K 线被压成中间一条细线，形态完全看不清。
    //   现在 Y 轴只由可视区的 K 线最高/最低决定，指标线超出部分自然画到画面外。
    var self = this;

    if (hi === lo) { hi += 0.01; lo -= 0.01; }
    // ★ 先把「可视区真实最高/最低」留一份，加完 padding 就找不回来了。
    //   用户要在图上直接看到当前界面的价格区间，这是画标注的依据。
    this._visHigh = hi;
    this._visLow = lo;
    var padY = (hi - lo) * 0.06;
    hi += padY; lo -= padY;
    var spanY = hi - lo;

    function yOf(price) {
      return priceBot - (price - lo) / spanY * priceH;
    }
    function xOf(i) {
      return self.padL + (i + 0.5) * bw;
    }
    this._yOf = yOf; this._xOf = xOf; this._bw = bw;

    // ---- 网格 ----
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var g = 0; g <= 4; g++) {
      var gy = priceTop + priceH * g / 4;
      ctx.moveTo(this.padL, Math.round(gy) + 0.5);
      ctx.lineTo(this.padL + plotW, Math.round(gy) + 0.5);
    }
    ctx.stroke();

    // ---- 价格轴标签 ----
    ctx.fillStyle = COL.text;
    ctx.font = '9px -apple-system,sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (var g2 = 0; g2 <= 4; g2++) {
      var pv = hi - spanY * g2 / 4;
      var py = priceTop + priceH * g2 / 4;
      ctx.fillText(fmtPrice(pv), this.padL + plotW + 4, py);
    }

    // ---- 均线图例（顶部独立条带，不压 K 线）----
    // 行位置与换行在 _layoutLegend() 里已经算好，这里只负责画。
    if (legend.rows.length) {
      ctx.font = '7.5px -apple-system,sans-serif';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      for (var lr = 0; lr < legend.rows.length; lr++) {
        var row = legend.rows[lr];
        var ry = legendTop + lr * LEGEND_LINE_H + 1;
        for (var li = 0; li < row.length; li++) {
          ctx.fillStyle = row[li].color;
          ctx.fillText(row[li].text, row[li].x, ry);
        }
      }
    }

    // ---- BOLL ----
    if (this.ind.boll) {
      this.drawLine(this.ind.boll.UP, COL.bollUp, 0.7);
      this.drawLine(this.ind.boll.MID, COL.bollMid, 0.7);
      this.drawLine(this.ind.boll.LOW, COL.bollLow, 0.7);
    }

    // ---- K 线 或 分时线 ----
    if (this.isMinute) {
      // 分时：价格折线 + 填充 + **当日均价线**
      //
      // ★ 均价线之前完全没画。parseMinute 早就把 avg 算出来了
      //   （累计成交额 / 累计成交量），但绘制这边只用了 c，avg 一直闲置。
      //   分时图上"现价 vs 均价"是最基本的判读依据（价格在均价上方=日内偏强），
      //   少了它这条线等于没画完。
      var pts = [];
      for (var mi = 0; mi < n; mi++) {
        pts.push({ x: xOf(mi), y: yOf(vis[mi].c) });
      }
      // 1) 价格折线 + 面积填充
      ctx.beginPath();
      pts.forEach(function (p, i3) {
        if (i3 === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = COL.minuteLine || COL.ma20;
      ctx.lineWidth = 1.3;
      ctx.stroke();

      ctx.lineTo(pts[pts.length - 1].x, priceBot);
      ctx.lineTo(pts[0].x, priceBot);
      ctx.closePath();
      var grad = ctx.createLinearGradient(0, priceTop, 0, priceBot);
      grad.addColorStop(0, COL.areaTop);
      grad.addColorStop(1, COL.areaBot);
      ctx.fillStyle = grad;
      ctx.fill();

      // 2) 均价线：黄色细线，穿在价格线里
      var apts = [];
      for (var ai = 0; ai < n; ai++) {
        var av = vis[ai].avg;
        if (av != null && isFinite(av)) {
          apts.push({ x: xOf(ai), y: yOf(av) });
        }
      }
      if (apts.length > 1) {
        ctx.beginPath();
        apts.forEach(function (p, i4) {
          if (i4 === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.strokeStyle = COL.minuteAvg || COL.dif;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    } else {
      // ★ 通达信风格 K 线：全部用 fillRect 绘制（不用 stroke）。
      //   stroke 的 1px 线在 canvas 上会被抗锯齿糊成 2px 灰边，这是"糊"的主因。
      //   fillRect 是硬边填充，像素级锐利。
      var halfW = Math.max(0.5, bodyW / 2);
      // 红K 是否空心：由 S.cfg.candleStyle 控制（hollow = 空心红K，solid = 实心）
      // window.__app 首帧可能还没挂上，再兜一层 S 直读，避免开局总是实心
      var hollowUp = false;
      try {
        var cfgObj = (window.__app && window.__app.cfg) ? window.__app.cfg()
          : (window.__app && window.__app.S ? window.__app.S.cfg : null);
        hollowUp = !!(cfgObj && cfgObj.candleStyle === 'hollow');
      } catch (e) { hollowUp = false; }
      for (var ki = 0; ki < n; ki++) {
        var kk = vis[ki];
        var isUp = kk.c >= kk.o;
        ctx.fillStyle = isUp ? COL.up : COL.down;

        var xc = Math.round(xOf(ki));
        var yH = Math.round(yOf(kk.h));
        var yL = Math.round(yOf(kk.l));
        var yO = Math.round(yOf(kk.o));
        var yC = Math.round(yOf(kk.c));

        // 影线：1px 宽（K 线稀疏时 2px）的实心矩形
        var shadowW = (bw >= 6) ? 2 : 1;
        var sx = Math.round(xc - shadowW / 2);
        var topShadow = Math.min(yH, yL);
        var hShadow = Math.max(1, Math.abs(yL - yH));
        ctx.fillRect(sx, topShadow, shadowW, hShadow);

        // 实体：实心矩形
        var topBody = Math.min(yO, yC);
        var hBody = Math.max(1, Math.abs(yC - yO));
        var bx = Math.round(xc - halfW);
        var bwd = Math.max(1, Math.round(halfW * 2));
        // 阳线空心 / 阴线实心（可切换，见 S.cfg.candleStyle）——
        // 通达信、同花顺的经典口径。
        //
        // ★ 空心的正确画法：先填满整个实体，再用 clearRect 挖掉内部。
        //   绝不能用「4 条 fillRect 拼边框」：实体宽度只有 1~2px 时，
        //   左右两条边会落在同一列像素上，看起来就是"空心 K 线中间多了一条竖线"。
        //   也不用 ctx.strokeRect：1px stroke 会被抗锯齿糊成 2px 灰边。
        //   挖空后边框恒为 1px，宽高再小也不会出现多余竖线；
        //   内框尺寸 <=0 时自动退化成实心，不需要额外判断。
        ctx.fillRect(bx, topBody, bwd, hBody);
        if (isUp && hollowUp) {
          var iw = bwd - 2, ih = hBody - 2;
          if (iw > 0 && ih > 0) ctx.clearRect(bx + 1, topBody + 1, iw, ih);
        }
      }
    }

    // ---- 均线 ----
    if (this.ind.ma) {
      var maColors = { MA5: COL.ma5, MA10: COL.ma10, MA20: COL.ma20, MA60: COL.ma60, MA120: COL.ma120, MA250: COL.ma250 };
      for (var mname in this.ind.ma) {
        this.drawLine(this.ind.ma[mname], maColors[mname] || COL.ma20, 0.8);
      }
    }

    // ---- 成交量（开关关掉时整块跳过） ----
    if (this.showVol !== false) {
    var maxV = 0;
    for (var vi = 0; vi < n; vi++) if (vis[vi].v > maxV) maxV = vis[vi].v;
    if (this.ind.volma) {
      for (var vm in this.ind.volma) {
        var arr2 = this.ind.volma[vm];
        for (var vj = 0; vj < n; vj++) {
          var vv = arr2[this.start + vj];
          if (vv != null && isFinite(vv) && vv > maxV) maxV = vv;
        }
      }
    }
    if (maxV <= 0) maxV = 1;
    var volHgt = volBot - volTop;
    for (var b = 0; b < n; b++) {
      var kb = vis[b];
      var xb = xOf(b);
      var vh = kb.v / maxV * (volHgt - 2);
      ctx.fillStyle = kb.c >= kb.o ? COL.volUp : COL.volDown;
      ctx.fillRect(xb - bodyW / 2, volBot - vh, bodyW, vh);
    }
    // 量能均线
    if (this.ind.volma) {
      var self2 = this;
      var vcols = { VMA5: COL.vma5, VMA10: COL.vma10 };
      for (var vn in this.ind.volma) {
        var varr = this.ind.volma[vn];
        ctx.strokeStyle = vcols[vn] || COL.ma20;
        ctx.lineWidth = 1;
        ctx.beginPath();
        var started = false;
        for (var vp = 0; vp < n; vp++) {
          var val = varr[self2.start + vp];
          if (val == null || !isFinite(val)) continue;
          var xx = xOf(vp);
          var yy = volBot - (val / maxV) * (volHgt - 2);
          if (!started) { ctx.moveTo(xx, yy); started = true; }
          else ctx.lineTo(xx, yy);
        }
        ctx.stroke();
      }
    }
    // 成交量标签
    ctx.fillStyle = COL.text;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('成交量', this.padL + 2, volTop + 1);
    }

    // ---- 副图指标 ----
    if (this.showSub && this.subType) {
      this.drawSub(vis, n, subTop, subBot, xOf, bw);
    }

    // ---- 缠论图层（笔 / 中枢）----
    if (this.showChan && this.chan) {
      this.drawChan(yOf, priceTop, priceBot, xOf, bw);
    }

    // ---- 当前界面最高 / 最低价标注 ----
    this.drawRangeMarks(vis, priceTop, priceBot, xOf, yOf);

    // ---- AI 标注（价位线 / 关注区）----
    if (this.showAi && (this.aiLevels.length || this.aiZones.length || this.aiMarks.length
        || this.aiFib.length || (this.aiTexts && this.aiTexts.length))) {
      this.drawAiMarks(yOf, priceTop, priceBot);
    }

    // ★ 自由绘图图层：盖在 K 线与缠论之上，但压在十字光标之下
    if (this.showShapes && this.shapes.length) {
      this.drawShapes(yOf, priceTop, priceBot, xOf, bw);
    }

    // ---- 手势提示（缩放时短暂显示）----
    if (this.gestureHint) {
      ctx.font = 'bold 11px -apple-system,sans-serif';
      var gtw = ctx.measureText(this.gestureHint).width;
      var gbx = (this.w - gtw) / 2 - 9;
      var gby = priceTop + 34;
      ctx.fillStyle = COL.chipBg;
      ctx.fillRect(gbx, gby, gtw + 18, 24);
      ctx.strokeStyle = COL.chipLine;
      ctx.lineWidth = 1;
      ctx.strokeRect(gbx + 0.5, gby + 0.5, gtw + 17, 23);
      ctx.fillStyle = COL.chipText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.gestureHint, this.w / 2, gby + 12);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }

    // ---- 十字光标 ----
    if (this.crossIdx >= this.start && this.crossIdx < end) {
      this.drawCrosshair(this.crossIdx, vis, xOf, yOf, priceTop, priceBot);
    }

    // 把「图例条带的下沿」告诉宿主容器，DOM 覆盖层（缠论状态条）据此定位。
    // 之前状态条写死 top:19px，图例换行后两边都不知道对方占多高，必然叠。
    var host = this.cv && this.cv.parentNode;
    if (host && host.style && host.style.setProperty) {
      host.style.setProperty('--chart-legend-b', contentTop + 'px');
    }
  };

  /**
   * 画出「当前界面」的最高价与最低价。
   *
   * 为什么要单独画：右侧价格轴是等分刻度（含 padding），用户看不出
   * 「这段区间到底从多少到多少」。AI 分析里说的压力/支撑又不一定在刻度上，
   * 看图时脑子里得先有这个区间 —— 所以直接把 hi/lo 标在图上。
   *
   * 画法：横线 + 右侧标签，不压 K 线主体（贴价格区上下沿，向内 1px）。
   * 只有区间够高（≥ 24px）才画，否则两条线会和十字光标签糊成一片。
   */
  Chart.prototype.drawRangeMarks = function (vis, priceTop, priceBot, xOf, yOf) {
    var hi = this._visHigh, lo = this._visLow;
    if (hi == null || lo == null || !isFinite(hi) || !isFinite(lo)) return;
    if (priceBot - priceTop < 24 || vis.length < 2) return;

    var ctx = this.ctx;
    var x0 = this.padL;
    var x1 = this.w - this.padR;
    var col = COL.rangeMark || COL.axis || '#4a4f5c';

    // ★ 标签必须放进右侧价格轴那一栏（x > x1），不能压在 K 线里。
    //   第一版把标签画在 x1 - tw（绘图区右端），结果正好盖住最新几根蜡烛 ——
    //   用户截图里"高/低"两个胶囊横在 K 线上，就是这里。
    //   而右侧 padR=52 的轴区本来就有大片空白，放那儿两全其美：
    //   线还在图上指位置，数字在轴上看数值，互不遮挡。
    var axisX = x1 + 2;                 // 轴区起点
    var axisW = this.w - axisX;         // 可用宽度（= padR - 2）

    function mark(price, isHigh) {
      var y = Math.round(yOf(price)) + 0.5;
      if (y < priceTop + 1 || y > priceBot - 1) return;

      // 1) 横线只画到绘图区右端，不进轴
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // 2) 标签放到轴区里
      //
      // 轴区只有 52px（padR），"高415.69" 这种长度放不下 ——
      // 实测 9px 字号要 45px 文字宽 + 6px 内边距 = 51px，几乎顶满，
      // 而价格是三位数（400+）时还会更长。
      // 所以：标签只写数字（高/低用颜色区分：高档用亮色、低档用暗色），
      // 字号降到 8.5px，内边距压到 4px。
      // 语义靠位置区分已经够了 —— 高在价格区上方、低在下方，不会看错。
      var txt = price.toFixed(2);
      ctx.font = '7.5px -apple-system,sans-serif';
      var tw = Math.min(ctx.measureText(txt).width + 5, axisW);
      // 垂直方向：高标在线上方，低标在线下方，避免两条贴太近时叠住
      var by = isHigh ? (y - 12) : (y + 1);
      if (by < priceTop) by = priceTop;
      if (by + 11 > priceBot) by = priceBot - 11;

      ctx.fillStyle = COL.rangeMarkBg || 'rgba(0,0,0,.55)';
      ctx.fillRect(axisX, by, tw, 11);
      // 一条细引线把标签和它指的价格连起来（轴区里只有 1~6px，够看）
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(axisX, by + 5.5);
      ctx.stroke();

      ctx.fillStyle = COL.rangeMark || COL.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, axisX + 2.5, by + 5.5);
      ctx.restore();
    }

    mark(hi, true);
    mark(lo, false);
  };

  Chart.prototype.drawLine = function (arr, color, lw) {
    if (!arr) return;
    var ctx = this.ctx, n = this.kl.length;
    var end = Math.min(this.start + this.visible, n);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw || 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    var started = false;
    for (var i = this.start; i < end; i++) {
      var v = arr[i];
      if (v == null || !isFinite(v)) { started = false; continue; }
      var x = this._xOf(i - this.start);
      var y = this._yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  Chart.prototype.drawSub = function (vis, n, top, bot, xOf, bw) {
    var ctx = this.ctx, self = this;
    var H = bot - top;
    var t = this.subType;

    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.padL, Math.round(top) + 0.5);
    ctx.lineTo(this.padL + (this.w - this.padL - this.padR), Math.round(top) + 0.5);
    ctx.moveTo(this.padL, Math.round(bot) + 0.5);
    ctx.lineTo(this.padL + (this.w - this.padL - this.padR), Math.round(bot) + 0.5);
    ctx.stroke();

    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    if (t === 'MACD' && this.ind.macd) {
      var m = this.ind.macd;
      var mx = 0;
      for (var i = this.start; i < this.start + n; i++) {
        mx = Math.max(mx, Math.abs(m.DIF[i] || 0), Math.abs(m.DEA[i] || 0), Math.abs(m.BAR[i] || 0));
      }
      if (mx <= 0) mx = 1;
      var midY = top + H / 2;
      var scale = (H / 2 - 2) / mx;
      // 零轴
      ctx.strokeStyle = COL.axis;
      ctx.beginPath();
      ctx.moveTo(this.padL, Math.round(midY) + 0.5);
      ctx.lineTo(this.padL + (this.w - this.padL - this.padR), Math.round(midY) + 0.5);
      ctx.stroke();
      // 柱
      var bodyW = Math.max(1, bw * 0.7);
      for (var j = 0; j < n; j++) {
        var idx = this.start + j;
        var bv = m.BAR[idx] || 0;
        var bh2 = bv * scale;
        ctx.fillStyle = bv >= 0 ? COL.subUp : COL.subDown;
        var xx = xOf(j);
        if (bh2 >= 0) ctx.fillRect(xx - bodyW / 2, midY - bh2, bodyW, Math.max(1, bh2));
        else ctx.fillRect(xx - bodyW / 2, midY, bodyW, Math.max(1, -bh2));
      }
      // DIF/DEA 线
      function drawM(arr, col) {
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath();
        var st = false;
        for (var k = 0; k < n; k++) {
          var v = arr[self.start + k];
          if (v == null || !isFinite(v)) { st = false; continue; }
          var x2 = xOf(k), y2 = midY - v * scale;
          if (!st) { ctx.moveTo(x2, y2); st = true; } else ctx.lineTo(x2, y2);
        }
        ctx.stroke();
      }
      drawM(m.DIF, COL.dif);
      drawM(m.DEA, COL.dea);
      ctx.fillStyle = COL.text;
      ctx.fillText('MACD(12,26,9)', this.padL + 2, top + 1);
    }

    if (t === 'KDJ' && this.ind.kdj) {
      var kd = this.ind.kdj;
      function drawK(arr, col) {
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath();
        var st = false;
        for (var k = 0; k < n; k++) {
          var v = arr[self.start + k];
          if (v == null || !isFinite(v)) { st = false; continue; }
          var x2 = xOf(k), y2 = bot - (v / 100) * H;
          if (!st) { ctx.moveTo(x2, y2); st = true; } else ctx.lineTo(x2, y2);
        }
        ctx.stroke();
      }
      drawK(kd.K, COL.k); drawK(kd.D, COL.d); drawK(kd.J, COL.j);
      ctx.fillStyle = COL.text;
      ctx.fillText('KDJ(9,3,3)', this.padL + 2, top + 1);
    }

    if (t === 'RSI' && this.ind.rsi) {
      var rs = this.ind.rsi;
      ctx.strokeStyle = COL.rsi; ctx.lineWidth = 1; ctx.beginPath();
      var st2 = false;
      for (var r = 0; r < n; r++) {
        var v2 = rs.RSI[this.start + r];
        if (v2 == null || !isFinite(v2)) { st2 = false; continue; }
        var x3 = xOf(r), y3 = bot - (v2 / 100) * H;
        if (!st2) { ctx.moveTo(x3, y3); st2 = true; } else ctx.lineTo(x3, y3);
      }
      ctx.stroke();
      ctx.fillStyle = COL.text;
      ctx.fillText('RSI(14)', this.padL + 2, top + 1);
    }
  };

  Chart.prototype.drawCrosshair = function (idx, vis, xOf, yOf, priceTop, priceBot) {
    var ctx = this.ctx;
    var i = idx - this.start;
    if (i < 0 || i >= vis.length) return;
    var x = xOf(i);
    var k = vis[i];

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = COL.cross;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, priceTop);
    ctx.lineTo(Math.round(x) + 0.5, this.h - 4);
    ctx.stroke();
    ctx.setLineDash([]);

    // 收盘价横线
    var y = yOf(k.c);
    if (y >= priceTop && y <= priceBot) {
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(this.padL, Math.round(y) + 0.5);
      ctx.lineTo(this.w - this.padR, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      // 价格标签
      var label = fmtPrice(k.c);
      ctx.font = '9px sans-serif';
      var tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = COL.cross;
      ctx.fillRect(this.w - this.padR + 2, y - 8, tw, 16);
      ctx.fillStyle = COL.axisText;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, this.w - this.padR + 6, y);
    }
    // ★ 底部日期标签：跟着竖线走，明确告诉用户"现在锁的是哪一天"
    if (k.t) {
      var dtxt = crossDateText(k.t);
      ctx.font = 'bold 9px -apple-system,sans-serif';
      ctx.textBaseline = 'middle';
      var dw = ctx.measureText(dtxt).width + 10;
      var dx = x - dw / 2;
      if (dx < this.padL) dx = this.padL;
      if (dx + dw > this.w - this.padR) dx = this.w - this.padR - dw;
      var dy = priceBot - 17;
      ctx.fillStyle = COL.cross;
      ctx.fillRect(dx, dy, dw, 15);
      ctx.fillStyle = COL.axisText;
      ctx.textAlign = 'center';
      ctx.fillText(dtxt, dx + dw / 2, dy + 7.5);
      ctx.textAlign = 'left';
    }

    ctx.restore();
  };

  /** 十字光标上的日期文字：'2026-07-27' / '20260727' / '2026-07-27 14:00:00' 都能认 */
  function crossDateText(t) {
    var s = String(t == null ? '' : t);
    if (!s) return '';
    if (/^\d{8}$/.test(s)) {
      return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    }
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (m) {
      return m[4] ? (m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5])
                  : (m[1] + '-' + m[2] + '-' + m[3]);
    }
    return s;
  }

  /** 导出十字光标位置的信息（供 AI 与提示条使用） */
  Chart.prototype.getCursorInfo = function () {
    // 优先十字光标；没有十字时用轻点选中的那根
    var ci = (this.crossIdx >= 0) ? this.crossIdx
      : ((this.selIdx >= 0) ? this.selIdx : -1);
    if (ci < 0 || !this.kl[ci]) return null;
    var k = this.kl[ci];
    var info = {
      index: ci,
      time: k.t, open: k.o, close: k.c, high: k.h, low: k.l, vol: k.v,
      ma: {}, volma: {}
    };
    var i = ci;
    if (this.ind.ma) for (var m in this.ind.ma) info.ma[m] = this.ind.ma[m][i];
    if (this.ind.volma) for (var v in this.ind.volma) info.volma[v] = this.ind.volma[v][i];
    if (this.ind.macd) {
      info.macd = {
        DIF: this.ind.macd.DIF[i],
        DEA: this.ind.macd.DEA[i],
        BAR: this.ind.macd.BAR[i]
      };
    }
    if (this.ind.boll) {
      info.boll = {
        UP: this.ind.boll.UP[i], MID: this.ind.boll.MID[i], LOW: this.ind.boll.LOW[i]
      };
    }
    if (this.ind.kdj) {
      info.kdj = { K: this.ind.kdj.K[i], D: this.ind.kdj.D[i], J: this.ind.kdj.J[i] };
    }
    if (this.ind.rsi) info.rsi = this.ind.rsi.RSI[i];
    return info;
  };

  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return '--';
    var a = Math.abs(v);
    if (a >= 1000) return v.toFixed(1);
    if (a >= 100) return v.toFixed(2);
    if (a >= 10) return v.toFixed(2);
    return v.toFixed(3);
  }


  // ==================== AI 标注 ====================
  // ★ 与 K 线的红/绿刻意错开：K 线是实心柱，AI 价位是细点划线，
  //   配色也换成橙/青/玫红/紫这组"工具色"，扫一眼就能分清哪条是 AI 画的。
  var AI_COLORS = THEMES.dark.ai;

  /** 设置 AI 标注。levels: [{price,label,type}] type 取 resist/support/stop/target */
  Chart.prototype.setAiMarks = function (levels, zones, marks, fibs, texts) {
    this.aiLevels = (levels || []).filter(function (x) {
      return x && isFinite(x.price) && x.price > 0;
    });
    this.aiZones = (zones || []).filter(function (z) {
      return z && isFinite(z.from) && isFinite(z.to);
    });
    // ★ 这三行原来错放在 clearAiMarks 里（那边 marks/fibs 是未定义变量，
    //   永远得到空数组）→ 点标注和黄金分割从来没画出来过，只有横线和框能显示。
    this.aiMarks = (marks || []).filter(function (m) { return m && (m.date || m.idx != null); });
    this.aiFib = (fibs || []).filter(function (f) {
      return f && isFinite(f.fromPrice) && isFinite(f.toPrice);
    });
    this.aiTexts = (texts || []).filter(function (t) {
      return t && t.text && (t.date || t.idx != null);
    });
    this.invalidate();
  };

  Chart.prototype.clearAiMarks = function () {
    this.aiLevels = [];
    this.aiZones = [];
    this.aiMarks = [];
    this.aiFib = [];
    this.aiTexts = [];
    this.invalidate();
  };

  Chart.prototype.setAiVisible = function (on) {
    this.showAi = !!on;
    this.invalidate();
  };

  /** '2026-11-10' / '202611101030' 都能对上 kl 里的时间戳 */
  Chart.prototype.dateIdx = function (t) {
    if (t == null) return -1;
    var key = String(t).replace(/[^0-9]/g, '');
    if (!key) return -1;
    var kl = this.kl || [];
    for (var i = 0; i < kl.length; i++) {
      var k = String(kl[i].t || '').replace(/[^0-9]/g, '');
      if (k === key) return i;
      if (k.length >= 8 && key.length >= 8 && k.slice(0, 8) === key.slice(0, 8) && k.length === key.length) return i;
    }
    // 只有日期（8 位）时按前缀匹配第一根
    if (key.length === 8) {
      for (var j = 0; j < kl.length; j++) {
        if (String(kl[j].t || '').replace(/[^0-9]/g, '').slice(0, 8) === key) return j;
      }
    }
    return -1;
  };

  Chart.prototype.drawAiMarks = function (yOf, priceTop, priceBot) {
    var ctx = this.ctx;
    var x0 = this.padL;
    var x1 = this.w - this.padR;

    // 关注区（半透明色带）
    for (var z = 0; z < this.aiZones.length; z++) {
      var zone = this.aiZones[z];
      var ya = yOf(Math.max(zone.from, zone.to));
      var yb = yOf(Math.min(zone.from, zone.to));
      if (yb < priceTop || ya > priceBot) continue;
      ya = Math.max(ya, priceTop);
      yb = Math.min(yb, priceBot);
      ctx.fillStyle = AI_COLORS.zone;
      ctx.fillRect(x0, ya, x1 - x0, yb - ya);
    }

    // 价位线（AI 给出的关键价位：支撑/压力/止损/目标）
    // ★ 文字标签一律放右侧价格轴里：画在 K 线图上会互相压住、也挡 K 线。
    // ★ 字号 9px / 色块高 12px：框小了，同样高度能排下更多价位，不容易叠。
    ctx.font = 'bold 8px -apple-system,sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    var vis = [];
    for (var i = 0; i < this.aiLevels.length; i++) {
      var lv = this.aiLevels[i];
      var y = yOf(lv.price);
      if (y < priceTop - 2 || y > priceBot + 2) continue;
      vis.push({ lv: lv, y: y, col: AI_COLORS[lv.type] || AI_COLORS.resist, txt: lv.label || '' });
    }

    var LH = 12, GAP = 2;
    // 自上而下推挤，保证相邻标签至少隔开「框高 + 1px」；溢出底边再整体回推
    function layoutAxis(items, top, bottom) {
      var list = items.slice().sort(function (a, b) { return a.y - b.y; });
      var minY = top + 1, maxY = bottom - LH - 1, k, t;
      for (k = 0; k < list.length; k++) {
        t = list[k].y - LH / 2;
        if (t < minY) t = minY;
        if (t > maxY) t = maxY;
        if (k > 0 && t < list[k - 1].ly + LH + GAP) t = list[k - 1].ly + LH + GAP;
        if (k > 0 && t > maxY) t = maxY;
        list[k].ly = t;
      }
      var over = list.length ? (list[list.length - 1].ly + LH) - (bottom - 1) : 0;
      for (k = list.length - 1; k >= 0 && over > 0; k--) {
        list[k].ly -= over;
        if (k === 0) {
          if (list[0].ly < minY) list[0].ly = minY;
          var push = minY;
          for (var m2 = 1; m2 < list.length; m2++) {
            if (list[m2].ly < push + LH + GAP) list[m2].ly = push + LH + GAP;
            push = list[m2].ly;
          }
          break;
        }
        var need = list[k - 1].ly + LH + GAP;
        over = (list[k].ly < need) ? (need - list[k].ly) : 0;
      }
    }
    layoutAxis(vis, priceTop, priceBot);

    var axisW = this.padR - 3;
    var boxX = this.w - this.padR + 1;

    for (var m = 0; m < vis.length; m++) {
      var it = vis[m];

      // 水平点划线：细、疏，和 K 线的实心柱子一眼能分开
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = it.col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(it.y) + 0.5);
      ctx.lineTo(x1, Math.round(it.y) + 0.5);
      ctx.stroke();
      ctx.restore();

      if (axisW < 22) continue;

      // 标签：类型 + 价格（去掉空格省宽度）；轴太窄时退化成只显示价格
      var txt = String(it.txt || '').replace(/\s+/g, '');
      var tw = ctx.measureText(txt).width + 6;
      if (!txt || tw > axisW) {
        txt = it.lv.price.toFixed(2);
        tw = ctx.measureText(txt).width + 6;
      }
      if (tw > axisW) tw = axisW;
      var by = it.ly;

      // 线位与标签错开时补一根引线，指向真实价位
      if (Math.abs(by + LH / 2 - it.y) > 2.5) {
        ctx.save();
        ctx.strokeStyle = it.col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(boxX, by + LH / 2);
        ctx.lineTo(boxX, it.y);
        ctx.stroke();
        ctx.restore();
      }

      ctx.fillStyle = it.col;
      ctx.fillRect(boxX, by, tw, LH);
      // 细黑边：同色标签挨着时也能看出是两块
      ctx.strokeStyle = COL.labelInk;
      ctx.lineWidth = 1;
      ctx.strokeRect(boxX + 0.5, by + 0.5, tw - 1, LH - 1);
      ctx.fillStyle = COL.labelInk;
      ctx.font = 'bold 8px -apple-system,sans-serif';
      ctx.fillText(txt, boxX + 3, by + LH / 2 + 0.5);
    }


    // ---- 点标注（背驰 / 买卖点 / 模型给的点位）----
    if (this.aiMarks && this.aiMarks.length) {
      var self3 = this;
      var start3 = this.start, end3 = Math.min(this.start + this.visible, this.kl.length);
      var plotW3 = this.w - this.padL - this.padR;
      var bw3 = plotW3 / this.visible;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '7.5px -apple-system,sans-serif';
      for (var mi = 0; mi < this.aiMarks.length; mi++) {
        var mk = this.aiMarks[mi];
        var real = (mk.idx != null) ? mk.idx : self3.dateIdx(mk.date);
        if (real < 0 || real < start3 || real >= end3) continue;
        var xm = this.padL + (real - start3 + 0.5) * bw3;
        var kbar = this.kl[real];
        var py = isFinite(mk.price) ? yOf(+mk.price) : null;
        var isBuy = (mk.type === 'buy' || /买|底/.test(mk.label || ''));
        if (py == null || py < priceTop || py > priceBot) {
          py = isBuy ? yOf(kbar.l) : yOf(kbar.h);
        }
        var ty = isBuy ? py + 9 : py - 9;
        ty = Math.max(priceTop + 6, Math.min(priceBot - 6, ty));
        ctx.fillStyle = isBuy ? COL.up : COL.down;
        ctx.beginPath();
        if (isBuy) { ctx.moveTo(xm, ty - 4); ctx.lineTo(xm - 3, ty + 1); ctx.lineTo(xm + 3, ty + 1); }
        else { ctx.moveTo(xm, ty + 4); ctx.lineTo(xm - 3, ty - 1); ctx.lineTo(xm + 3, ty - 1); }
        ctx.closePath();
        ctx.fill();
        if (mk.label) {
          ctx.fillText(String(mk.label).replace(/背驰.*/, '背驰'), xm, isBuy ? ty + 9 : ty - 9);
        }
      }
    }

    // ---- 文字标注（AI 直接写在图上）----
    //
    // 和 marks 的区别：marks 是「三角箭头 + 小标签」，用来标买卖点；
    // texts 是纯粹的写字，字号可调、可左中右对齐，用来标"压力位""这里放量"这类说明。
    if (this.aiTexts && this.aiTexts.length) {
      var selfT = this;
      var plotWT = this.w - this.padL - this.padR;
      var bwT = plotWT / this.visible;
      var startT = this.start, endT = Math.min(this.start + this.visible, this.kl.length);
      for (var ti = 0; ti < this.aiTexts.length; ti++) {
        var tx = this.aiTexts[ti];
        var ri2 = (tx.idx != null) ? tx.idx : selfT.dateIdx(tx.date);
        if (ri2 < 0 || ri2 < startT || ri2 >= endT) continue;
        var xx = this.padL + (ri2 - startT + 0.5) * bwT;
        var kb = this.kl[ri2];
        var yy = isFinite(tx.price) ? yOf(+tx.price) : yOf(kb.c);
        if (!isFinite(yy)) continue;
        // 允许轻微超出可视区，但别写到坐标轴外面
        yy = Math.max(priceTop + 6, Math.min(priceBot - 6, yy));
        var fs = isFinite(tx.size) ? Math.max(7, Math.min(20, +tx.size)) : 9;
        ctx.font = 'bold ' + fs + 'px -apple-system,sans-serif';
        ctx.textAlign = (tx.align === 'left' || tx.align === 'right') ? tx.align : 'center';
        ctx.textBaseline = 'middle';
        var color = (tx.color === 'up') ? COL.up
          : (tx.color === 'down') ? COL.down
          : (tx.color === 'target') ? (CHAN_COL ? CHAN_COL.zone : COL.text)
          : (tx.color === 'stop') ? COL.down
          : COL.text;
        // 先描一圈背景色描边，避免压在 K 线/网格上读不清
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.72)';
        ctx.lineJoin = 'round';
        ctx.strokeText(String(tx.text), xx, yy);
        ctx.fillStyle = color;
        ctx.fillText(String(tx.text), xx, yy);
      }
    }

    // ---- 黄金分割 ----
    if (this.aiFib && this.aiFib.length) {
      var self4 = this;
      var plotW4 = this.w - this.padL - this.padR;
      var bw4 = plotW4 / this.visible;
      var start4 = this.start;
      ctx.font = '7.5px -apple-system,sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (var fi = 0; fi < this.aiFib.length; fi++) {
        var fb = this.aiFib[fi];
        var i0 = self4.dateIdx(fb.fromDate), i1 = self4.dateIdx(fb.toDate);
        if (i0 < 0 && isFinite(fb.fromIdx)) i0 = +fb.fromIdx;
        if (i1 < 0 && isFinite(fb.toIdx)) i1 = +fb.toIdx;
        var x0 = (i0 >= 0) ? this.padL + (i0 - start4 + 0.5) * bw4 : this.padL;
        var x1 = (i1 >= 0) ? this.padL + (i1 - start4 + 0.5) * bw4 : this.w - this.padR;
        if (x1 < x0) { var tmp = x0; x0 = x1; x1 = tmp; }
        x0 = Math.max(this.padL, x0);
        x1 = Math.min(this.w - this.padR, x1);
        var ratios = fb.ratios && fb.ratios.length ? fb.ratios : [0.382, 0.5, 0.618];
        var span = fb.fromPrice - fb.toPrice;
        for (var ri = 0; ri < ratios.length; ri++) {
          var r = +ratios[ri];
          var price = fb.fromPrice - span * r;
          var yf = yOf(price);
          if (yf < priceTop || yf > priceBot) continue;
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = 'rgba(124,92,255,0.75)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(x0, Math.round(yf) + 0.5);
          ctx.lineTo(x1, Math.round(yf) + 0.5);
          ctx.stroke();
          ctx.restore();
          ctx.fillStyle = 'rgba(124,92,255,0.95)';
          ctx.fillText(r.toFixed(3) + '  ' + fmtPrice(price), x1 + 3, yf);
        }
      }
    }
  };

  global.AI_COLORS = AI_COLORS;


  // ==================== 自由绘图图层（AI 画图） ====================

  /** 整体替换图元（AI 每次画图会带上完整列表，或先 clear 再 add） */
  Chart.prototype.setShapes = function (shapes) {
    this.shapes = Array.isArray(shapes) ? shapes.slice() : [];
    this.invalidate();
  };

  /** 追加图元（不覆盖已有的） */
  Chart.prototype.addShapes = function (shapes) {
    if (!Array.isArray(shapes)) return;
    this.shapes = this.shapes.concat(shapes);
    this.invalidate();
  };

  Chart.prototype.clearShapes = function () {
    this.shapes = [];
    this.invalidate();
  };

  Chart.prototype.setShapesVisible = function (on) {
    this.showShapes = !!on;
    this.invalidate();
  };

  /** 取某个颜色键对应的实际色值（跟随深浅主题） */
  function shapeColor(key) {
    if (!key) return COL.text;
    if (key === 'up') return COL.up;
    if (key === 'down') return COL.down;
    if (key === 'accent') return '#3d8bfd';
    if (key === 'text') return COL.textBold;
    if (key === 'warn') return COL.text;
    // AI 标注的四种类型沿用同一套语义色
    if (AI_COLORS[key]) return AI_COLORS[key];
    return COL.text;
  }

  /**
   * 画一条图元。
   * 坐标全部用「索引 + 价格」→ 现场换算成像素，所以缩放/平移后位置自动正确。
   */
  Chart.prototype.drawShapes = function (yOf, priceTop, priceBot, xOf, bw) {
    var ctx = this.ctx;
    var start = this.start;
    var end = Math.min(this.start + this.visible, this.kl.length);
    var left = this.padL;
    var right = this.w - this.padR;
    var self = this;

    /**
     * 索引 → 屏幕 x。索引可能落在可视区外（连线要画到边界外也算正常）。
     *
     * ★ 必须认日期字符串：技能文档让模型写 {"x":"2026-07-28"}，
     *   而这里原来直接把 x 当数字索引做减法 —— "2026-07-28" - 0 = NaN，
     *   于是整个图元被画在 NaN 坐标上，屏幕上什么也看不到（标注"写入成功"但没字）。
     *   现在：number 当索引；字符串先按 K 线日期查索引，查不到再退回 NaN。
     */
    function px(idx) {
      var i0 = idx;
      if (typeof i0 === 'string') {
        var hit = self.dateIdx(i0);
        i0 = (hit >= 0) ? hit : NaN;
      } else if (typeof i0 === 'number' && !isFinite(i0)) {
        i0 = NaN;
      }
      if (i0 !== i0) return NaN;
      return xOf(i0 - start);
    }
    /** 价格 → 屏幕 y，并夹在价格区内 */
    function py(price) {
      var y = yOf(price);
      return Math.max(priceTop, Math.min(priceBot, y));
    }

    for (var i = 0; i < this.shapes.length; i++) {
      var sp = this.shapes[i];
      if (!sp || !sp.type) continue;
      var color = shapeColor(sp.color);
      var lw = (sp.width && isFinite(sp.width)) ? Math.max(0.5, Math.min(6, sp.width)) : 1.2;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lw;
      if (sp.dash) ctx.setLineDash([5, 4]);

      if (sp.type === 'hline') {
        // 水平线：横贯整个价格区
        var hy = py(sp.price);
        ctx.beginPath();
        ctx.moveTo(left, Math.round(hy) + 0.5);
        ctx.lineTo(right, Math.round(hy) + 0.5);
        ctx.stroke();
        // 右侧价格轴上的小标签
        if (sp.label) {
          ctx.setLineDash([]);
          ctx.font = 'bold 8px -apple-system,sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          var tw = ctx.measureText(sp.label).width + 6;
          var bx = right + 1;
          if (bx + tw > this.w) { bx = this.w - tw; }
          ctx.fillRect(bx, hy - 8, tw, 16);
          ctx.fillStyle = COL.labelInk;
          ctx.fillText(sp.label, bx + 3, hy);
        }

      } else if (sp.type === 'trendline' || sp.type === 'ray' || sp.type === 'arrow') {
        var x1 = px(sp.x1), y1 = py(sp.y1);
        var x2 = px(sp.x2), y2 = py(sp.y2);

        if (sp.type === 'ray') {
          // 射线：沿 (x1,y1)→(x2,y2) 方向延伸到右边界（或下边界）
          var dx = x2 - x1, dy = y2 - y1;
          if (Math.abs(dx) < 0.001) {
            // 垂直线：直接画到上下边界
            ctx.beginPath();
            ctx.moveTo(x1, priceTop);
            ctx.lineTo(x1, priceBot);
            ctx.stroke();
          } else {
            var k = (right - x1) / dx;
            var ex = right, ey = y1 + dy * k;
            // 纵向越界时改为截到上下边界
            if (ey < priceTop || ey > priceBot) {
              var targetY = ey < priceTop ? priceTop : priceBot;
              var k2 = (targetY - y1) / dy;
              ex = x1 + dx * k2;
              ey = targetY;
            }
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(ex, ey);
            ctx.stroke();
          }
        } else {
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          if (sp.type === 'arrow') {
            // 箭头头部
            var ang = Math.atan2(y2 - y1, x2 - x1);
            var head = Math.max(6, lw * 4);
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - head * Math.cos(ang - 0.4), y2 - head * Math.sin(ang - 0.4));
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - head * Math.cos(ang + 0.4), y2 - head * Math.sin(ang + 0.4));
            ctx.stroke();
          }
        }

        // 两端小圆点：让"这条线从哪连到哪"一眼可见
        if (sp.type !== 'ray') {
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(x1, y1, 2.2, 0, Math.PI * 2);
          ctx.arc(x2, y2, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        if (sp.label) {
          ctx.setLineDash([]);
          ctx.font = '7.5px -apple-system,sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(sp.label, Math.min(x1, x2) + 2, Math.min(y1, y2) - 3);
        }

      } else if (sp.type === 'rect') {
        var rx1 = Math.min(px(sp.x1), px(sp.x2));
        var rx2 = Math.max(px(sp.x1), px(sp.x2));
        var ry1 = Math.min(py(sp.y1), py(sp.y2));
        var ry2 = Math.max(py(sp.y1), py(sp.y2));
        // 完全在视野外就跳过（但跨视野的照画）
        if (rx2 < left || rx1 > right) { ctx.restore(); continue; }
        rx1 = Math.max(rx1, left); rx2 = Math.min(rx2, right);
        if (sp.fill) {
          ctx.save();
          ctx.globalAlpha = 0.14;
          ctx.fillRect(rx1, ry1, rx2 - rx1, ry2 - ry1);
          ctx.restore();
        }
        ctx.strokeRect(Math.round(rx1) + 0.5, Math.round(ry1) + 0.5,
          Math.max(1, rx2 - rx1), Math.max(1, ry2 - ry1));
        if (sp.label) {
          ctx.setLineDash([]);
          ctx.font = '7.5px -apple-system,sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(sp.label, rx1 + 3, ry1 + 2);
        }

      } else if (sp.type === 'text') {
        var tx = px(sp.x), ty = py(sp.y);
        // ★ 加 !isFinite 判空：NaN 参与比较恒为 false，原来这道边界检查拦不住 NaN，
        //   结果"画了"但看不见（坐标是 NaN）。
        if (!isFinite(tx) || !isFinite(ty)) { ctx.restore(); continue; }
        if (tx < left - 40 || tx > right + 40) { ctx.restore(); continue; }
        var size = (sp.size && isFinite(sp.size)) ? Math.max(8, Math.min(18, sp.size)) : 11;
        ctx.font = 'bold ' + size + 'px -apple-system,sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        // 先铺一层底，保证文字在任何背景上都读得清
        var w2 = ctx.measureText(sp.text || '').width + 8;
        ctx.save();
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = COL.bg;
        ctx.fillRect(tx - 3, ty - size * 0.75, w2, size * 1.5);
        ctx.restore();
        ctx.fillStyle = color;
        ctx.fillText(sp.text || '', tx + 1, ty);

      } else if (sp.type === 'dot') {
        var dxp = px(sp.x), dyp = py(sp.y);
        if (dxp < left || dxp > right) { ctx.restore(); continue; }
        ctx.beginPath();
        ctx.arc(dxp, dyp, (sp.size && isFinite(sp.size)) ? Math.max(2, Math.min(8, sp.size)) : 3.5, 0, Math.PI * 2);
        ctx.fill();
        if (sp.label) {
          ctx.setLineDash([]);
          ctx.font = '7.5px -apple-system,sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(sp.label, dxp + 5, dyp - 4);
        }
      }

      ctx.restore();
    }
  };

  // ==================== 缠论图层 ====================
  // ★ 缠论统一为「细黄线」：不区分红绿，和通达信缠论指标一致
  var CHAN_COL = THEMES.dark.chan;

  /** 设置缠论分析结果 */
  Chart.prototype.setChan = function (chanResult) {
    this.chan = chanResult || null;
    this.invalidate();
  };

  Chart.prototype.setChanVisible = function (on) {
    this.showChan = !!on;
    this.invalidate();
  };

  Chart.prototype.drawChan = function (yOf, priceTop, priceBot, xOf, bw) {
    var ctx = this.ctx;
    var c = this.chan;
    var self = this;
    var start = this.start, end = Math.min(this.start + this.visible, this.kl.length);

    // 坐标换算：缠论索引是「分析窗口内」的下标。
    // analyze 时可能用了 load 截断，这里用 chan.bars.length 对齐到当前 kl 尾部。
    var chanLen = (c.bars && c.bars.length) ? c.bars.length : this.kl.length;
    var offset = this.kl.length - chanLen;
    function cx(idx) {
      var real = idx + offset;
      return xOf(real - start);
    }
    function inView(idx) {
      var real = idx + offset;
      return real >= start && real < end;
    }

    // ---- 中枢框 ----
    if (this.showChanBox && c.boxes) {
      for (var i = 0; i < c.boxes.length; i++) {
        var b = c.boxes[i];
        if (!inView(b.s) && !inView(b.e)) {
          // 整段都在视野外则跳过（但跨视野的要画）
          if (b.e + offset < start || b.s + offset >= end) continue;
        }
        var x0 = Math.max(this.padL, cx(b.s));
        var x1 = Math.min(this.w - this.padR, cx(b.e));
        if (x1 <= x0) continue;
        var yTop = yOf(b.zg), yBot = yOf(b.zd);
        if (yBot < priceTop || yTop > priceBot) continue;
        yTop = Math.max(yTop, priceTop);
        yBot = Math.min(yBot, priceBot);

        // ★ 空心框：不填充，避免挡住 K 线（之前实心填充导致 K 线完全看不见）
        var boxColor = (b.tag === '红') ? CHAN_COL.boxRed : CHAN_COL.boxGreen;

        // 上下两条横线（ZG / ZD 边界）
        ctx.strokeStyle = boxColor;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(yTop) + 0.5);
        ctx.lineTo(x1, Math.round(yTop) + 0.5);
        ctx.moveTo(x0, Math.round(yBot) + 0.5);
        ctx.lineTo(x1, Math.round(yBot) + 0.5);
        ctx.stroke();

        // 左右竖线：实线。
        // ★ 原来是虚线（setLineDash([3,3])），断断续续的竖线和旁边的
        //   均线/笔连线混在一起，中枢范围的左右边界反而看不清。
        //   纵深方向靠"空心不填充"已经足够弱化了，不需要再打虚线。
        //   线宽比横线略细（0.5 vs 0.7），保留一点视觉层级但不牺牲可读性。
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = boxColor;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(Math.round(x0) + 0.5, yTop);
        ctx.lineTo(Math.round(x0) + 0.5, yBot);
        if (b.e + offset < end) {
          ctx.moveTo(Math.round(x1) - 0.5, yTop);
          ctx.lineTo(Math.round(x1) - 0.5, yBot);
        }
        ctx.stroke();
        ctx.restore();

        // 中线（细虚线）
        var yMid = yOf(b.mid);
        if (yMid >= priceTop && yMid <= priceBot) {
          ctx.save();
          ctx.setLineDash([2, 4]);
          ctx.strokeStyle = CHAN_COL.boxMid || 'rgba(255,230,0,0.35)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(x0, Math.round(yMid) + 0.5);
          ctx.lineTo(x1, Math.round(yMid) + 0.5);
          ctx.stroke();
          ctx.restore();
        }

        // ZG/ZD 文字标签已按用户要求去掉，只保留空心框本身（更干净，不挡 K 线）
      }
    }

    // ---- 笔连线 ----
    if (this.showChanBi && c.pens && c.pens.length > 1) {
      ctx.strokeStyle = CHAN_COL.pen;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      var started = false;
      for (var p = 0; p < c.pens.length; p++) {
        var pen = c.pens[p];
        if (!inView(pen.idx)) {
          // 视野外的点打断连线，避免跨越视窗画出长线
          if (pen.idx + offset < start) { started = false; continue; }
          if (pen.idx + offset >= end) break;
          continue;
        }
        var px = cx(pen.idx), py = yOf(pen.price);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // ---- 转折点 ----
    // ★ 不再画三角形（用户反馈太扎眼、挡住 K 线）。
    //   笔的拐点靠金黄连线本身已经足够清楚，这里只留一个 1.5px 的小圆点做锚定。
    if (this.showChanPen && c.pens) {
      ctx.fillStyle = CHAN_COL.pen;
      for (var q = 0; q < c.pens.length; q++) {
        var pn = c.pens[q];
        if (!inView(pn.idx)) continue;
        var x = cx(pn.idx), y = yOf(pn.price);
        if (y < priceTop - 2 || y > priceBot + 2) continue;
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // ---- 背驰点 / 三类买卖点（引擎已经算出来了，之前只写在文字里）----
    var tags = [];
    if (c.signals && c.signals.length) {
      for (var sg = 0; sg < c.signals.length; sg++) {
        var s1 = c.signals[sg];
        tags.push({
          idx: s1.idx, price: s1.price,
          buy: s1.type === 'buy',
          label: String(s1.label || '').replace(/[（(].*$/, '')
        });
      }
    }
    if (c.points && c.points.length) {
      for (var pt = 0; pt < c.points.length; pt++) {
        var p1 = c.points[pt];
        tags.push({
          idx: p1.idx, price: p1.price,
          buy: p1.type === 'buy',
          label: String(p1.label || '')
        });
      }
    }
    if (tags.length) {
      ctx.font = '7.5px -apple-system,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var tg = 0; tg < tags.length; tg++) {
        var t1 = tags[tg];
        if (!inView(t1.idx)) continue;
        var tx = cx(t1.idx), tyy = yOf(t1.price);
        if (tyy < priceTop - 4 || tyy > priceBot + 4) continue;
        var above = !t1.buy;           // 买点标在下方，卖点标在上方
        var oy = above ? tyy - 10 : tyy + 10;
        oy = Math.max(priceTop + 7, Math.min(priceBot - 7, oy));
        ctx.fillStyle = t1.buy ? COL.up : COL.down;
        ctx.beginPath();
        if (t1.buy) { ctx.moveTo(tx, oy - 4); ctx.lineTo(tx - 3, oy + 1); ctx.lineTo(tx + 3, oy + 1); }
        else { ctx.moveTo(tx, oy + 4); ctx.lineTo(tx - 3, oy - 1); ctx.lineTo(tx + 3, oy - 1); }
        ctx.closePath();
        ctx.fill();
        if (t1.label) ctx.fillText(t1.label, tx, above ? oy - 8 : oy + 8);
      }
    }
  };

  global.CHAN_COL = CHAN_COL;

  global.StockChart = Chart;
  global.ChartThemes = THEMES;      // 供回归用例核对两套调色板的字段是否齐全
  global.fmtPrice = fmtPrice;
})(window);
