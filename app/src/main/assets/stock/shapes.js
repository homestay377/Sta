/**
 * AI 自由绘图图层（v8.0）。
 *
 * 设计要点（这几条决定了画上去的东西会不会"飘"）：
 *
 * 1. **存「时间 + 价格」，不存像素**
 *    AI 用日期（或 K 线序号）和价格下笔，绘制时再用当前的 xOf/yOf 换算。
 *    这样缩放、平移、切周期之后，画的线依然贴在正确的位置上。
 *
 * 2. **坐标必须校验**
 *    模型给的日期可能不存在、价格可能离谱。越界不是"画歪"，而是直接拒绝
 *    并把可选的日期/价格范围回给模型，让它自己改 —— 否则图上会出现一堆乱线。
 *
 * 3. **时间可以是日期，也可以是序号**
 *    日期便于模型理解（它看的是「2026-07-27」这种）；序号便于"第 N 根"这种说法。
 *    两者都支持，内部统一成"索引"再转时间。
 *
 * 4. **不改变用户看到的股票与周期**
 *    和现有工具一致：只往当前图上画，不切股、不切周期。
 */
(function (global) {
  'use strict';

  /**
   * 图元类型。
   * 每种都写清"它要什么参数"，这份说明同时给渲染和工具描述用 —— 两边不会写歪。
   */
  var SHAPES = {
    // 水平线：只有一个价格
    hline: { need: ['price'], desc: '水平线（一个价位，横贯全图）' },
    // 两点连线：起点终点都必填
    trendline: { need: ['x1', 'y1', 'x2', 'y2'], desc: '两点连线（趋势线）' },
    // 射线：从起点出发，沿方向一直延伸到右边界
    ray: { need: ['x1', 'y1', 'x2', 'y2'], desc: '射线（从起点穿过第二点，延伸到图右边界）' },
    // 矩形/区间框：左上角与右下角
    rect: { need: ['x1', 'y1', 'x2', 'y2'], desc: '矩形框（区间/中枢/箱体）' },
    // 文字：一个锚点
    text: { need: ['x', 'y', 'text'], desc: '文字标注' },
    // 箭头：从起点指向终点
    arrow: { need: ['x1', 'y1', 'x2', 'y2'], desc: '箭头（标明方向）' },
    // 圆点：一个锚点
    dot: { need: ['x', 'y'], desc: '圆点标记（标记某个位置）' }
  };

  /** 允许的颜色名 → 取当前主题的实际色值 */
  var COLOR_KEYS = ['up', 'down', 'resist', 'support', 'stop', 'target', 'accent', 'text', 'warn'];

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /**
   * 把模型给的 x 归一成「K 线索引」。
   * 支持三种写法：
   *   · 数字        → 直接当索引（也接受负数：-1 = 最后一根）
   *   · 日期字符串   → 在 kl 里找最接近的一根（如 2026-07-27、07-27）
   *   · 相对词      → 'last' / 'first' / 'latest'
   * 返回 {idx, err}：err 非空表示无法定位（要把可选范围回给模型）。
   */
  function resolveX(v, kl) {
    if (!kl || !kl.length) return { idx: null, err: '图表还没有 K 线数据' };

    if (typeof v === 'number' && isFinite(v)) {
      var i = Math.round(v);
      if (i < 0) i = kl.length + i;          // -1 = 最后一根
      if (i < 0 || i >= kl.length) {
        return { idx: null, err: '索引 ' + v + ' 超出范围（当前 0 ~ ' + (kl.length - 1) + '，可用 -1 表示最后一根）' };
      }
      return { idx: i, err: null };
    }

    var s = String(v == null ? '' : v).trim();
    if (!s) return { idx: null, err: '缺少时间参数' };
    var low = s.toLowerCase();
    if (low === 'last' || low === 'latest') return { idx: kl.length - 1, err: null };
    if (low === 'first') return { idx: 0, err: null };

    // 日期匹配：从最新往前找第一根以该字符串开头的（容错：07-27 能匹配 2026-07-27）
    var want = s.replace(/[\/.]/g, '-');
    for (var j = kl.length - 1; j >= 0; j--) {
      var t = String(kl[j].t || '').replace(/[\/.]/g, '-');
      if (t.indexOf(want) === 0 || t.indexOf(want) >= 0) return { idx: j, err: null };
    }
    // 找不到就给出可选的日期范围，让模型自己改
    var first = kl[0] ? kl[0].t : '?';
    var last = kl[kl.length - 1] ? kl[kl.length - 1].t : '?';
    return {
      idx: null,
      err: '找不到时间为「' + s + '」的 K 线。可用范围：' + first + ' ~ ' + last
        + '（也可以直接传索引 0 ~ ' + (kl.length - 1) + '，或 -1 表示最后一根）'
    };
  }

  /**
   * 校验并归一化一条图元。
   * 返回 {shape, err}。err 非空时整条丢弃，并把原因回给模型。
   */
  function normalize(raw, kl) {
    if (!raw || typeof raw !== 'object') return { shape: null, err: '图元不是对象' };
    var type = String(raw.type || '').trim().toLowerCase();
    var def = SHAPES[type];
    if (!def) {
      return { shape: null, err: '不支持的图元类型「' + raw.type + '」，可用：' + Object.keys(SHAPES).join(' / ') };
    }

    var out = {
      type: type,
      color: COLOR_KEYS.indexOf(String(raw.color || '').trim()) >= 0 ? String(raw.color).trim() : '',
      width: num(raw.width),
      dash: !!raw.dash,
      fill: !!raw.fill,
      label: raw.label == null ? '' : String(raw.label).slice(0, 40),
      size: num(raw.size)
    };

    // 取一个 x 坐标（可能是 x1/x2/x）
    function takeX(key) {
      if (!(key in raw)) return { ok: false, err: '缺少 ' + key };
      var r = resolveX(raw[key], kl);
      return r.err ? { ok: false, err: key + '：' + r.err } : { ok: true, val: r.idx };
    }
    function takeY(key) {
      if (!(key in raw)) return { ok: false, err: '缺少 ' + key };
      var y = num(raw[key]);
      if (y === null) return { ok: false, err: key + ' 不是有效数字' };
      if (y <= 0) return { ok: false, err: key + ' 必须是正数（收到 ' + raw[key] + '）' };
      return { ok: true, val: y };
    }

    // 逐项检查必需参数
    if (type === 'hline') {
      var p = takeY('price');
      if (!p.ok) return { shape: null, err: def.desc + '：' + p.err };
      out.price = p.val;
      return { shape: out, err: null };
    }

    if (type === 'text' || type === 'dot') {
      var tx = takeX('x'), ty = takeY('y');
      if (!tx.ok) return { shape: null, err: def.desc + '：' + tx.err };
      if (!ty.ok) return { shape: null, err: def.desc + '：' + ty.err };
      out.x = tx.val; out.y = ty.val;
      if (type === 'text') {
        var txt = String(raw.text == null ? '' : raw.text).trim();
        if (!txt) return { shape: null, err: 'text 图元必须给 text 内容' };
        out.text = txt.slice(0, 40);
      }
      return { shape: out, err: null };
    }

    // 其余都是两点图元
    var ax = takeX('x1'), ay = takeY('y1'), bx = takeX('x2'), by = takeY('y2');
    if (!ax.ok) return { shape: null, err: def.desc + '：' + ax.err };
    if (!ay.ok) return { shape: null, err: def.desc + '：' + ay.err };
    if (!bx.ok) return { shape: null, err: def.desc + '：' + bx.err };
    if (!by.ok) return { shape: null, err: def.desc + '：' + by.err };
    out.x1 = ax.val; out.y1 = ay.val; out.x2 = bx.val; out.y2 = by.val;
    return { shape: out, err: null };
  }

  /** 批量归一化：返回 {shapes, errors} */
  function normalizeAll(list, kl) {
    var shapes = [], errors = [];
    (list || []).forEach(function (raw, i) {
      var r = normalize(raw, kl);
      if (r.shape) shapes.push(r.shape);
      else errors.push('第 ' + (i + 1) + ' 条：' + r.err);
    });
    return { shapes: shapes, errors: errors };
  }

  global.ChartShapes = {
    SHAPES: SHAPES,
    COLOR_KEYS: COLOR_KEYS,
    normalize: normalize,
    normalizeAll: normalizeAll,
    resolveX: resolveX
  };
})(window);
