/* =========================================================
 * 指标计算库
 * 输入统一为 K 线数组 [{t,o,c,h,l,v}, ...]，按时间升序。
 * 所有函数返回与输入等长的数组，前置不足周期处为 null。
 * ========================================================= */
(function (global) {
  'use strict';

  /** 简单移动平均 */
  function sma(values, period) {
    var n = values.length, out = new Array(n), sum = 0;
    for (var i = 0; i < n; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      out[i] = i >= period - 1 ? sum / period : null;
    }
    return out;
  }

  /** 指数移动平均 */
  function ema(values, period) {
    var n = values.length, out = new Array(n);
    if (n === 0) return out;
    var k = 2 / (period + 1), prev = values[0];
    out[0] = prev;
    for (var i = 1; i < n; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /** MA 多周期 */
  function ma(kl, periods) {
    var closes = kl.map(function (k) { return k.c; });
    var res = {};
    periods.forEach(function (p) { res['MA' + p] = sma(closes, p); });
    return res;
  }

  /** 成交量 MA */
  function volMa(kl, periods) {
    var vols = kl.map(function (k) { return k.v; });
    var res = {};
    periods.forEach(function (p) { res['VMA' + p] = sma(vols, p); });
    return res;
  }

  /** MACD(12,26,9) —— 与 stock_panel 的 Get-MACD 完全一致 */
  function macd(kl, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var closes = kl.map(function (k) { return k.c; });
    var n = closes.length;
    var dif = new Array(n), dea = new Array(n), bar = new Array(n);
    if (n === 0) return { DIF: dif, DEA: dea, BAR: bar };
    var e12 = closes[0], e26 = closes[0];
    for (var i = 0; i < n; i++) {
      var c = closes[i];
      if (i === 0) {
        dif[0] = 0; dea[0] = 0; bar[0] = 0;
        continue;
      }
      e12 = c * (2 / (fast + 1)) + e12 * ((fast - 1) / (fast + 1));
      e26 = c * (2 / (slow + 1)) + e26 * ((slow - 1) / (slow + 1));
      dif[i] = e12 - e26;
      dea[i] = dif[i] * (2 / (signal + 1)) + dea[i - 1] * ((signal - 1) / (signal + 1));
      bar[i] = (dif[i] - dea[i]) * 2;
    }
    return { DIF: dif, DEA: dea, BAR: bar };
  }

  /** BOLL(20,2) */
  function boll(kl, period, mult) {
    period = period || 20; mult = mult || 2;
    var closes = kl.map(function (k) { return k.c; });
    var n = closes.length;
    var mid = new Array(n), up = new Array(n), low = new Array(n);
    for (var i = 0; i < n; i++) {
      if (i < period - 1) { mid[i] = null; up[i] = null; low[i] = null; continue; }
      var sum = 0, j;
      for (j = i - period + 1; j <= i; j++) sum += closes[j];
      var m = sum / period;
      var varSum = 0;
      for (j = i - period + 1; j <= i; j++) varSum += Math.pow(closes[j] - m, 2);
      var sd = Math.sqrt(varSum / period);
      mid[i] = m; up[i] = m + mult * sd; low[i] = m - mult * sd;
    }
    return { MID: mid, UP: up, LOW: low };
  }

  /** KDJ(9,3,3) */
  function kdj(kl, n9, k3, d3) {
    n9 = n9 || 9; k3 = k3 || 3; d3 = d3 || 3;
    var len = kl.length;
    var K = new Array(len), D = new Array(len), J = new Array(len);
    var prevK = 50, prevD = 50;
    for (var i = 0; i < len; i++) {
      if (i < n9 - 1) { K[i] = null; D[i] = null; J[i] = null; continue; }
      var hi = -Infinity, lo = Infinity;
      for (var j = i - n9 + 1; j <= i; j++) {
        if (kl[j].h > hi) hi = kl[j].h;
        if (kl[j].l < lo) lo = kl[j].l;
      }
      var rsv = hi === lo ? 50 : (kl[i].c - lo) / (hi - lo) * 100;
      prevK = (rsv + (k3 - 1) * prevK) / k3;
      prevD = (prevK + (d3 - 1) * prevD) / d3;
      K[i] = prevK; D[i] = prevD; J[i] = 3 * prevK - 2 * prevD;
    }
    return { K: K, D: D, J: J };
  }

  /** RSI(period)，Wilder 平滑 */
  function rsi(kl, period) {
    period = period || 14;
    var n = kl.length, out = new Array(n);
    var avgGain = 0, avgLoss = 0;
    for (var i = 0; i < n; i++) {
      if (i === 0) { out[0] = null; continue; }
      var diff = kl[i].c - kl[i - 1].c;
      var gain = diff > 0 ? diff : 0;
      var loss = diff < 0 ? -diff : 0;
      if (i < period) {
        avgGain += gain; avgLoss += loss;
        if (i === period - 1) {
          avgGain /= period; avgLoss /= period;
          out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        } else {
          out[i] = null;
        }
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    return { RSI: out };
  }

  /**
   * 一次算出所有指标
   * @param {Array} kl K线数组
   * @param {Object} opts {maPeriods:[5,10,20,60], ind:{MA,BOLL,MACD,KDJ,RSI,VOLMA}}
   */
  function computeAll(kl, opts) {
    opts = opts || {};
    var ind = opts.ind || {};
    var res = {};
    if (ind.MA !== false) res.ma = ma(kl, opts.maPeriods || [5, 10, 20, 60]);
    if (ind.VOLMA) res.volma = volMa(kl, [5, 10]);
    if (ind.BOLL) res.boll = boll(kl, 20, 2);
    if (ind.MACD) res.macd = macd(kl, 12, 26, 9);
    if (ind.KDJ) res.kdj = kdj(kl, 9, 3, 3);
    if (ind.RSI) res.rsi = rsi(kl, 14);
    return res;
  }

  global.Ind = {
    sma: sma, ema: ema, ma: ma, volMa: volMa,
    macd: macd, boll: boll, kdj: kdj, rsi: rsi,
    computeAll: computeAll
  };
})(window);
