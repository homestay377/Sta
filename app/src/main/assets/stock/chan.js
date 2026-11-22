/* =========================================================
 * 缠论核心算法（JS 版）
 * 从 chanlun_engine/scripts/chan_core.py 移植，口径严格对齐。
 *
 * 依赖：tdx.js（通达信公式解释器）+ formula.txt（缠论公式原文）
 *
 * 对外接口：
 *   Chan.analyze(bars, formulaText) -> {
 *     pens:   [{idx, price, type}]        主级笔转折点
 *     boxes:  [{tag, s, e, zg, zd, mid}]  中枢框
 *     bi:     [{from, to, dir, hi, lo}]   笔的连线
 *     stats:  {...}                       统计摘要
 *   }
 * ========================================================= */
(function (global) {
  'use strict';

  var NAN = NaN;

  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }

  /** 布尔序列 -> 连续段 [(start, end)] */
  function runs(mask) {
    var out = [], s = -1;
    for (var i = 0; i < mask.length; i++) {
      var v = mask[i];
      if (v && s < 0) s = i;
      else if (!v && s >= 0) { out.push([s, i - 1]); s = -1; }
    }
    if (s >= 0) out.push([s, mask.length - 1]);
    return out;
  }

  /** 从 s 起，值保持不变的连续段终点 */
  function runEnd(v, s) {
    var base = v[s], e = s;
    while (e + 1 < v.length && v[e + 1] === base) e++;
    return e;
  }

  /**
   * 红/绿两族常对同一段给出同一个中枢：时间+价格都重叠就合并，留跨度长的那个。
   * 不合并会画出两个几乎重合的框。
   */
  function mergeBoxes(boxes) {
    var bs = boxes.slice().sort(function (a, b) {
      if (a.s !== b.s) return a.s - b.s;
      return (b.e - b.s) - (a.e - a.s);
    });
    var out = [];
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var hit = -1;
      for (var j = 0; j < out.length; j++) {
        var u = out[j];
        if (Math.min(u.e, b.e) - Math.max(u.s, b.s) <= 0) continue;
        var ov = Math.min(u.zg, b.zg) - Math.max(u.zd, b.zd);
        var span = Math.min(u.zg - u.zd, b.zg - b.zd);
        if (span > 0 && ov > 0.6 * span) { hit = j; break; }
      }
      if (hit < 0) out.push(b);
      else if ((b.e - b.s) > (out[hit].e - out[hit].s)) out[hit] = b;
    }
    out.sort(function (a, b) { return a.s - b.s; });
    return out;
  }

  /**
   * 按通达信规则算每个中枢框的 [起点, 终点]
   * 右边界 = min(顶值不变终点, 下一同类起点-1, 断点-1, 该族轨上线延伸段末根)
   */
  function boxSpans(D, S) {
    var res = [];
    var defs = [
      { tag: '红', st: '红起', tp: '红顶_锁定', bt: '红底_锁定', md: '红中_锁定' },
      { tag: '绿', st: '绿起', tp: '绿顶_锁定', bt: '绿底_锁定', md: '绿中_锁定' }
    ];
    for (var d = 0; d < defs.length; d++) {
      var def = defs[d];
      if (!D[def.st] || !D[def.tp] || !D[def.bt]) continue;

      var starts = [];
      for (var i = 0; i < D[def.st].length; i++) {
        if (D[def.st][i] > 0) starts.push(i);
      }
      var brkKey = def.tag + '断点';
      var brk = [];
      if (D[brkKey]) {
        for (var j = 0; j < D[brkKey].length; j++) if (D[brkKey][j] > 0) brk.push(j);
      }
      var trKey = def.tag + '轨上线';
      var ok = [];
      if (D[trKey]) {
        for (var k = 0; k < D[trKey].length; k++) {
          if (isFiniteNum(D[trKey][k]) && D[trKey][k] > 0) ok.push(k);
        }
      }

      for (var n = 0; n < starts.length; n++) {
        var s = starts[n];
        if (s < S) continue;
        var end = runEnd(D[def.tp], s);
        if (n + 1 < starts.length) end = Math.min(end, starts[n + 1] - 1);
        // 下一个断点
        for (var b1 = 0; b1 < brk.length; b1++) {
          if (brk[b1] >= s) { end = Math.min(end, brk[b1] - 1); break; }
        }
        // 轨上线最后一个有效位置
        var lastOk = -1;
        for (var o1 = 0; o1 < ok.length; o1++) if (ok[o1] >= s) lastOk = ok[o1];
        if (lastOk >= 0) end = Math.min(end, lastOk);

        res.push({
          tag: def.tag, s: s, e: end,
          zg: D[def.tp][s], zd: D[def.bt][s],
          mid: D[def.md] ? D[def.md][s] : (D[def.tp][s] + D[def.bt][s]) / 2
        });
      }
    }
    return res;
  }

  /** 主级笔转折点：X_70>0 取底，X_71>0 取顶，按索引排序 */
  /**
   * 同向连续转折点只保留更极端的一个，保证顶底交替。
   * ★ v10.25：对齐 Python 引擎的 clean_pens。原来 JS 侧没有这一步，
   *   笔可能"顶接顶/底接底"，后面的背驰比较（依赖方向交替）就会失准。
   */
  function cleanPens(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var last = out[out.length - 1];
      if (last && last.type === p.type) {
        if (p.type === '顶') {
          if (p.price >= last.price) out[out.length - 1] = p;
        } else {
          if (p.price <= last.price) out[out.length - 1] = p;
        }
      } else {
        out.push(p);
      }
    }
    return out;
  }

  function penPoints(D, S, N) {
    var pts = [];
    var a70 = D['X_70'], a71 = D['X_71'];
    for (var i = S; i < N; i++) {
      if (a70 && a70[i] > 0) pts.push({ idx: i - S, price: a70[i], type: '底' });
      if (a71 && a71[i] > 0) pts.push({ idx: i - S, price: a71[i], type: '顶' });
    }
    pts.sort(function (a, b) { return a.idx - b.idx; });
    return pts;
  }

  /**
   * 主流程：给定 K 线，算出笔与中枢
   * @param {Array} bars [{t,o,h,l,c,v}]
   * @param {string} formulaText formula.txt 内容
   * @param {Object} opts {load: 只用最后 N 根算}
   */
  function analyze(bars, formulaText, opts) {
    opts = opts || {};
    var b = bars;
    // ★ 与 Python 的 CHANLUN_LOAD 对齐：只保留最后 N 根再算
    if (opts.load > 0 && b.length > opts.load) b = b.slice(-opts.load);
    var n = b.length;
    if (!n) {
      return { pens: [], boxes: [], bi: [], stats: { bars: 0 }, data: {} };
    }

    var ohlcv = {
      o: new Float64Array(n), h: new Float64Array(n),
      l: new Float64Array(n), c: new Float64Array(n),
      v: new Float64Array(n)
    };
    for (var i = 0; i < n; i++) {
      ohlcv.o[i] = b[i].o; ohlcv.h[i] = b[i].h;
      ohlcv.l[i] = b[i].l; ohlcv.c[i] = b[i].c;
      ohlcv.v[i] = b[i].v;
    }

    var res = TDX.runFormula(formulaText, ohlcv);
    var D = res.data;

    var S = 0;
    var pens = cleanPens(penPoints(D, S, n));
    var boxes = mergeBoxes(boxSpans(D, S));

    // 笔连线：相邻转折点成一段
    // ★ app.js 直接遍历 chan.pens 读 dir/from/to/len，这些字段必须合并进 pens 本身，
    //   只放在 bi 里会导致 AI 收到空的笔信息。
    var bi = [];
    for (var p = 0; p + 1 < pens.length; p++) {
      var a = pens[p], c = pens[p + 1];
      var seg = {
        from: a.idx, to: c.idx,
        fromPrice: a.price, toPrice: c.price,
        dir: c.price > a.price ? 'up' : 'down',
        fromType: a.type, toType: c.type,
        len: c.idx - a.idx
      };
      bi.push(seg);
      pens[p].dir = seg.dir;
      pens[p].from = seg.from;
      pens[p].to = seg.to;
      pens[p].fromPrice = seg.fromPrice;
      pens[p].toPrice = seg.toPrice;
      pens[p].len = seg.len;
      pens[p].fromType = seg.fromType;
      pens[p].toType = seg.toType;
    }

    // 统计
    var lastBox = boxes.length ? boxes[boxes.length - 1] : null;
    var stats = {
      bars: n,
      pens: pens.length,
      boxes: boxes.length,
      errors: res.errors.length,
      lastPen: pens.length ? pens[pens.length - 1] : null,
      lastBox: lastBox,
      // 当前价相对最后一个中枢的位置
      boxPosition: null
    };
    if (lastBox && b.length) {
      var cur = b[n - 1].c;
      stats.boxPosition = cur > lastBox.zg ? '中枢上方'
        : (cur < lastBox.zd ? '中枢下方' : '中枢内');
    }

    // ---- 背驰：同向两段的 MACD 力度对比（缠论口径）----
    //
    // ★ v10.25 修的真 bug：原来是「相邻两笔」比 |DIF| 绝对值和，而笔是顶底交替的
    //   （up/down/up…），相邻两笔方向几乎总相反 → `if (cur.dir !== prev.dir) continue`
    //   恒为真 → 背驰永远不触发。现在对齐 Python 引擎 analyze.py 的 find_signals：
    //     · 基准是「同向的上一段」（bi[k] 对 bi[k-2]），不是相邻段
    //     · 力度 = 该段**同向** MACD 柱面积（上涨只算红柱、下跌只算绿柱），不是 |DIF|
    //     · 必须创新极值（新高/新低），否则只是盘整，不算背驰
    //     · 分母为零跳过（避免 1e9 级假比值）；分子归零 = 极强背驰
    var signals = [];
    var dif = D['DIF'];
    if (!dif) {
      // 公式没直接给 DIF 时用收盘价算 MACD 的 DIF
      dif = new Float64Array(n);
      var e12 = b[0].c, e26 = b[0].c;
      for (var q = 0; q < n; q++) {
        var cq = b[q].c;
        if (q === 0) { dif[0] = 0; continue; }
        e12 = cq * (2 / 13) + e12 * (11 / 13);
        e26 = cq * (2 / 27) + e26 * (25 / 27);
        dif[q] = e12 - e26;
      }
    }
    var dea = D['DEA'];
    if (!dea) {
      dea = new Float64Array(n);
      for (var di = 1; di < n; di++) dea[di] = dif[di] * (2 / 10) + dea[di - 1] * (8 / 10);
    }
    var hist = new Float64Array(n);
    for (var hi = 0; hi < n; hi++) hist[hi] = (dif[hi] - dea[hi]) * 2;

    var EPS_AREA = 1e-6;    // 零面积守卫：低于此视为该段无同向动能
    var DIV_RATIO = 0.85;   // 面积缩到前段 85% 以下才算力度衰竭
    function segArea(a, z, up) {
      var s2 = 0;
      for (var i2 = Math.max(0, a); i2 <= z && i2 < hist.length; i2++) {
        if (!isFinite(hist[i2])) continue;
        if (up) { if (hist[i2] > 0) s2 += hist[i2]; }
        else if (hist[i2] < 0) s2 += -hist[i2];
      }
      return s2;
    }
    for (var k = 2; k < bi.length; k++) {
      var cur = bi[k], prev = bi[k - 2];
      if (cur.dir !== prev.dir) continue;
      var up = cur.dir === 'up';
      // 必须创新极值：趋势背驰的定义是「新高/新低但力度不足」
      if (up ? !(cur.toPrice > prev.toPrice) : !(cur.toPrice < prev.toPrice)) continue;
      var a1 = segArea(prev.from, prev.to, up);
      var a2 = segArea(cur.from, cur.to, up);
      if (a1 <= EPS_AREA) continue;
      var lv = boxes.length >= 2 ? '趋势' : '笔';
      if (a2 <= EPS_AREA) {
        // 分子归零 = 这一段完全没出现同向柱，价格却创新极值 → 极强背驰
        signals.push({
          idx: cur.to,
          type: up ? 'sell' : 'buy',
          label: (up ? '顶' : '底') + '背驰(极强)',
          level: '极强',
          price: cur.toPrice,
          strength: '1.00'
        });
        continue;
      }
      if (a2 < a1 * DIV_RATIO) {
        signals.push({
          idx: cur.to,
          type: up ? 'sell' : 'buy',
          label: (up ? '顶' : '底') + '背驰(' + lv + ')',
          level: lv,
          price: cur.toPrice,
          strength: (1 - a2 / a1).toFixed(2)
        });
      }
    }

    // ---- 三类买卖点（缠论定义，不是"背驰"的同义词）----
    //
    // ★ 原来的 signals 只标了「底背驰 / 顶背驰」，那是**背驰**，不是买卖点。
    //   背驰只说明力度衰减，还不能下单；要变成可操作的买点必须再满足
    //   「离开中枢 → 回抽不破」这个结构条件。混为一谈的后果是：
    //   模型看到"底背驰"就喊买，而那时价格可能还在中枢里磨。
    //
    //   判定用的是 bi（笔段）与 boxes（中枢）：
    //     一买：下跌趋势中，最后一个中枢**下方**出现底背驰，
    //           且随后的反弹回到中枢区间内（回到 ZD 之上）
    //     二买：一买之后第一次回调，低点**不破**一买的低点
    //     三买：价格在最后一个中枢**上方**，回调的低点不跌回 ZG
    //     卖点对称
    //
    //   每个点都带上"成立的依据"，让模型能核对，而不是只给一个标签。
    var points = [];
    function penAt(idx) {
      for (var pi = 0; pi < bi.length; pi++) {
        if (bi[pi].to === idx) return bi[pi];
      }
      return null;
    }
    function boxContaining(idx) {
      for (var bx = boxes.length - 1; bx >= 0; bx--) {
        if (boxes[bx].s <= idx && idx <= boxes[bx].e) return boxes[bx];
      }
      return null;
    }
    function pushPoint(idx, kind, price, why, box) {
      points.push({
        idx: idx,
        type: kind.indexOf('买') >= 0 ? 'buy' : 'sell',
        label: kind,
        price: price,
        reason: why,
        box: box ? { s: box.s, e: box.e, zg: +box.zg.toFixed(2), zd: +box.zd.toFixed(2) } : null
      });
    }

    for (var si = 0; si < signals.length; si++) {
      var sg = signals[si];
      var atBox = boxContaining(sg.idx);
      var lastBoxAt = null;
      for (var bi2 = 0; bi2 < boxes.length; bi2++) {
        if (boxes[bi2].e <= sg.idx) lastBoxAt = boxes[bi2];
      }
      var curBi = penAt(sg.idx);

      if (sg.type === 'buy' && lastBoxAt && sg.price < lastBoxAt.zd) {
        // 一买：中枢下方的底背驰
        pushPoint(sg.idx, '一买', sg.price,
          '下跌笔在中枢下方底背驰，力度衰减 ' + sg.strength
          + '（中枢 ZD=' + lastBoxAt.zd.toFixed(2) + '）', lastBoxAt);

        // 二买：一买之后的下一次回调低点不破一买低点
        var afterIdx = sg.idx;
        var firstLow = sg.price;
        for (var bj = 0; bj < bi.length; bj++) {
          var seg2 = bi[bj];
          if (seg2.from < afterIdx) continue;
          if (seg2.dir === 'down' && seg2.toPrice > firstLow) {
            pushPoint(seg2.to, '二买', seg2.toPrice,
              '回调低点 ' + seg2.toPrice.toFixed(2) + ' 未破一买低点 '
              + firstLow.toFixed(2), lastBoxAt);
            break;
          }
          if (seg2.dir === 'down' && seg2.toPrice <= firstLow) break;  // 破了就不是二买
        }
      }

      // 三买：价格在最后一个中枢上方，回调不跌回 ZG
      if (sg.type === 'buy' && lastBoxAt && sg.price > lastBoxAt.zg) {
        pushPoint(sg.idx, '三买', sg.price,
          '中枢上方回抽不破 ZG=' + lastBoxAt.zg.toFixed(2)
          + '，底背驰力度 ' + sg.strength, lastBoxAt);
      }

      if (sg.type === 'sell' && lastBoxAt && sg.price > lastBoxAt.zg) {
        pushPoint(sg.idx, '一卖', sg.price,
          '上涨笔在中枢上方顶背驰，力度衰减 ' + sg.strength
          + '（中枢 ZG=' + lastBoxAt.zg.toFixed(2) + '）', lastBoxAt);

        var afterIdx2 = sg.idx;
        var firstHigh = sg.price;
        for (var bk = 0; bk < bi.length; bk++) {
          var seg3 = bi[bk];
          if (seg3.from < afterIdx2) continue;
          if (seg3.dir === 'up' && seg3.toPrice < firstHigh) {
            pushPoint(seg3.to, '二卖', seg3.toPrice,
              '反弹高点 ' + seg3.toPrice.toFixed(2) + ' 未破一卖高点 '
              + firstHigh.toFixed(2), lastBoxAt);
            break;
          }
          if (seg3.dir === 'up' && seg3.toPrice >= firstHigh) break;
        }
      }

      if (sg.type === 'sell' && lastBoxAt && sg.price < lastBoxAt.zd) {
        pushPoint(sg.idx, '三卖', sg.price,
          '中枢下方反抽不上 ZD=' + lastBoxAt.zd.toFixed(2)
          + '，顶背驰力度 ' + sg.strength, lastBoxAt);
      }
    }

    // 按时间排序、去重（同 idx 同 label 只留一个）
    var seenPt = {};
    points = points.filter(function (pt) {
      var key = pt.idx + '|' + pt.label;
      if (seenPt[key]) return false;
      seenPt[key] = 1;
      return true;
    }).sort(function (x, y) { return x.idx - y.idx; });

    return {
      pens: pens, boxes: boxes, bi: bi, stats: stats,
      signals: signals,
      points: points,
      data: D, errors: res.errors, bars: b
    };
  }

  global.Chan = {
    analyze: analyze,
    mergeBoxes: mergeBoxes,
    boxSpans: boxSpans,
    penPoints: penPoints,
    runs: runs,
    runEnd: runEnd
  };
})(typeof window !== 'undefined' ? window : globalThis);
