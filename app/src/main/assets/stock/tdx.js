/* =========================================================
 * TDX-Lite JS 版 —— 通达信指标公式解释器
 * 从 chanlun_engine/scripts/tdx.py 1:1 移植，语义严格对齐。
 *
 * 序列语义：每个变量都是与 K 线等长的 Float64Array/普通数组，缺失为 NaN。
 * 支持：:= 赋值、: 输出、四则/比较/逻辑、IF/REF/REFX/BARSLAST/BARSNEXT/
 *      COUNT/SUMBARS/FILTERX/BACKSET/CROSS/VALUEWHEN/HHV/LLV/MA/EMA/SMA/
 *      SUM/EVERY/NOT/ABS/MAX/MIN/CONST/DRAWNULL
 * ========================================================= */
(function (global) {
  'use strict';

  var NAN = NaN;

  // ---------------------------------------------------------------- 词法
  var TOKEN_RE = new RegExp(
    "(?<str>'[^']*'|\"[^\"]*\")" +
    "|(?<num>\\d+\\.\\d*|\\.\\d+|\\d+)" +
    "|(?<ident>[A-Za-z_\\u4e00-\\u9fa5][A-Za-z0-9_\\u4e00-\\u9fa5]*)" +
    "|(?<op><=|>=|<>|!=|:=|==|[-+*/(),;<>=])" +
    "|(?<ws>\\s+)", "g");

  function tokenize(s) {
    var out = [], m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(s)) !== null) {
      if (m.groups.ws) continue;
      var kind = m.groups.str ? 'str'
        : m.groups.num ? 'num'
          : m.groups.ident ? 'ident'
            : 'op';
      out.push({ kind: kind, val: m[0] });
    }
    return out;
  }

  // ---------------------------------------------------------------- 语法
  function Node(kind, val, args) {
    this.kind = kind;
    this.val = val;
    this.args = args || [];
  }

  function Parser(toks) {
    this.t = toks;
    this.p = 0;
  }
  Parser.prototype.peek = function () {
    return this.p < this.t.length ? this.t[this.p] : { kind: null, val: null };
  };
  Parser.prototype.eat = function (v) {
    var tk = this.peek();
    if (v !== undefined && tk.val !== v) {
      throw new SyntaxError('期望 ' + v + ' 实际 ' + tk.val);
    }
    this.p++;
    return tk;
  };
  Parser.prototype.isOp = function (v) {
    var tk = this.peek();
    return tk.kind === 'op' && tk.val === v;
  };
  Parser.prototype.isKw = function (v) {
    var tk = this.peek();
    return tk.kind === 'ident' && String(tk.val).toUpperCase() === v;
  };

  Parser.prototype.parse = function () {
    return this.p_or();
  };
  Parser.prototype.p_or = function () {
    var a = this.p_and();
    while (this.isKw('OR')) {
      this.eat();
      a = new Node('bin', 'OR', [a, this.p_and()]);
    }
    return a;
  };
  Parser.prototype.p_and = function () {
    var a = this.p_cmp();
    while (this.isKw('AND')) {
      this.eat();
      a = new Node('bin', 'AND', [a, this.p_cmp()]);
    }
    return a;
  };
  Parser.prototype.p_cmp = function () {
    var a = this.p_add();
    for (; ;) {
      var tk = this.peek();
      if (tk.kind === 'op' && ['>', '<', '>=', '<=', '=', '==', '!=', '<>'].indexOf(tk.val) >= 0) {
        this.eat();
        var op = tk.val === '==' ? '=' : (tk.val === '<>' ? '!=' : tk.val);
        a = new Node('bin', op, [a, this.p_add()]);
      } else {
        break;
      }
    }
    return a;
  };
  Parser.prototype.p_add = function () {
    var a = this.p_mul();
    for (; ;) {
      var tk = this.peek();
      if (tk.kind === 'op' && (tk.val === '+' || tk.val === '-')) {
        this.eat();
        a = new Node('bin', tk.val, [a, this.p_mul()]);
      } else {
        break;
      }
    }
    return a;
  };
  Parser.prototype.p_mul = function () {
    var a = this.p_unary();
    for (; ;) {
      var tk = this.peek();
      if (tk.kind === 'op' && (tk.val === '*' || tk.val === '/')) {
        this.eat();
        a = new Node('bin', tk.val, [a, this.p_unary()]);
      } else {
        break;
      }
    }
    return a;
  };
  Parser.prototype.p_unary = function () {
    var tk = this.peek();
    if (tk.kind === 'op' && (tk.val === '-' || tk.val === '+')) {
      this.eat();
      var a = this.p_unary();
      return new Node('un', tk.val, [a]);
    }
    if (this.isKw('NOT')) {
      this.eat();
      return new Node('un', 'NOT', [this.p_unary()]);
    }
    return this.p_primary();
  };
  Parser.prototype.p_primary = function () {
    var tk = this.peek();
    if (tk.kind === 'num') {
      this.eat();
      return new Node('num', parseFloat(tk.val));
    }
    if (tk.kind === 'op' && tk.val === '(') {
      this.eat('(');
      var e = this.parse();
      this.eat(')');
      return e;
    }
    if (tk.kind === 'ident') {
      this.eat();
      var name = tk.val;
      if (this.isOp('(')) {
        this.eat('(');
        var args = [];
        if (!this.isOp(')')) {
          args.push(this.parse());
          while (this.isOp(',')) {
            this.eat(',');
            args.push(this.parse());
          }
        }
        this.eat(')');
        return new Node('call', String(name).toUpperCase(), args);
      }
      return new Node('var', String(name).toUpperCase());
    }
    if (tk.kind === 'str') {
      this.eat();
      return new Node('num', 0);
    }
    // 兜底：吞掉避免死循环
    this.eat();
    return new Node('num', 0);
  };

  // ---------------------------------------------------------------- 序列函数
  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }

  function _truth(x) {
    var n = x.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var v = x[i];
      out[i] = (!isFiniteNum(v) || v === 0) ? 0 : 1;
    }
    return out;
  }

  /** REF(X,N)：N 可为序列 */
  function ref(x, n) {
    var L = x.length, out = new Float64Array(L);
    out.fill(NAN);
    var scalar = (typeof n === 'number');
    for (var i = 0; i < L; i++) {
      var k = scalar ? n : n[i];
      if (!isFiniteNum(k)) continue;
      k = Math.trunc(k);
      if (k <= 0) out[i] = x[i];
      else if (i >= k) out[i] = x[i - k];
    }
    return out;
  }

  /** REFX(X,N)：向未来取 */
  function refx(x, n) {
    var L = x.length, out = new Float64Array(L);
    out.fill(NAN);
    var scalar = (typeof n === 'number');
    for (var i = 0; i < L; i++) {
      var k = scalar ? n : n[i];
      if (!isFiniteNum(k)) continue;
      k = Math.trunc(k);
      if (k <= 0) out[i] = x[i];
      else if (i + k < L) out[i] = x[i + k];
    }
    return out;
  }

  /** HHV(X,N) */
  function hhv(x, n) {
    var L = x.length, out = new Float64Array(L);
    out.fill(NAN);
    var scalar = (typeof n === 'number');
    for (var i = 0; i < L; i++) {
      var k = scalar ? n : n[i];
      if (!isFiniteNum(k)) k = 1;
      k = Math.max(1, Math.trunc(k));
      var s = Math.max(0, i - k + 1), mx = -Infinity, found = false;
      for (var j = s; j <= i; j++) {
        var v = x[j];
        if (isFiniteNum(v)) { if (v > mx) mx = v; found = true; }
      }
      out[i] = found ? mx : NAN;
    }
    return out;
  }

  /** LLV(X,N) */
  function llv(x, n) {
    var L = x.length, out = new Float64Array(L);
    out.fill(NAN);
    var scalar = (typeof n === 'number');
    for (var i = 0; i < L; i++) {
      var k = scalar ? n : n[i];
      if (!isFiniteNum(k)) k = 1;
      k = Math.max(1, Math.trunc(k));
      var s = Math.max(0, i - k + 1), mn = Infinity, found = false;
      for (var j = s; j <= i; j++) {
        var v = x[j];
        if (isFiniteNum(v)) { if (v < mn) mn = v; found = true; }
      }
      out[i] = found ? mn : NAN;
    }
    return out;
  }

  /** BARSLAST(COND)：距上次条件成立的周期数 */
  function barslast(cond) {
    var L = cond.length, out = new Float64Array(L);
    var last = -1;
    for (var i = 0; i < L; i++) {
      if (cond[i]) { last = i; out[i] = 0; }
      else out[i] = last < 0 ? i : i - last;
    }
    return out;
  }

  /** BARSNEXT(COND)：距下次条件成立的周期数 */
  function barsnext(cond) {
    var L = cond.length, out = new Float64Array(L);
    var nxt = -1;
    for (var i = L - 1; i >= 0; i--) {
      if (cond[i]) { nxt = i; out[i] = 0; }
      else out[i] = nxt < 0 ? 0 : nxt - i;
    }
    return out;
  }

  /** COUNT(COND,N) */
  function count(cond, n) {
    var L = cond.length;
    var cs = new Float64Array(L + 1);
    for (var i = 0; i < L; i++) cs[i + 1] = cs[i] + (cond[i] ? 1 : 0);
    var out = new Float64Array(L);
    var scalar = (typeof n === 'number');
    for (var i2 = 0; i2 < L; i2++) {
      var k = scalar ? n : n[i2];
      if (!isFiniteNum(k)) k = 0;
      k = Math.trunc(k);
      out[i2] = cs[i2 + 1] - cs[Math.max(0, i2 - k + 1)];
    }
    return out;
  }

  /** SUMBARS(COND,N)：向前累加到第 N 个成立所经历的周期数（含当前） */
  function sumbars(cond, n) {
    var L = cond.length, out = new Float64Array(L);
    n = Math.max(1, Math.trunc(n));
    for (var i = 0; i < L; i++) {
      var c = 0, j = i;
      while (j >= 0) {
        if (cond[j]) { c++; if (c >= n) break; }
        j--;
      }
      out[i] = (c >= n) ? (i - j + 1) : i;
    }
    return out;
  }

  /** FILTERX(X,N)：X 成立时清除其之前 N 周期内的信号 */
  function filterx(cond, n) {
    var L = cond.length, out = new Uint8Array(L);
    var scalar = (typeof n === 'number');
    for (var i = 0; i < L; i++) {
      if (!cond[i]) continue;
      var k = scalar ? n : n[i];
      k = isFiniteNum(k) ? Math.trunc(k) : 0;
      var s = Math.max(0, i - k);
      for (var j = s; j < i; j++) out[j] = 0;
      out[i] = 1;
    }
    return out;
  }

  /** BACKSET(COND,N) */
  function backset(cond, n) {
    var L = cond.length, out = new Float64Array(L);
    var scalar = (typeof n === 'number');
    for (var i = 0; i < L; i++) {
      if (!cond[i]) continue;
      var k = scalar ? n : n[i];
      k = isFiniteNum(k) ? Math.trunc(k) : 0;
      var s = Math.max(0, i - k);
      for (var j = s; j <= i; j++) out[j] = 1;
    }
    return out;
  }

  /** CROSS(A,B) */
  function cross(a, b) {
    var L = a.length, out = new Float64Array(L);
    var ra = ref(a, 1), rb = ref(b, 1);
    for (var i = 0; i < L; i++) {
      out[i] = (a[i] > b[i] && ra[i] <= rb[i]) ? 1 : 0;
    }
    return out;
  }

  /** VALUEWHEN(COND,X) */
  function valuewhen(cond, x) {
    var L = x.length, out = new Float64Array(L);
    out.fill(NAN);
    var cur = NAN;
    for (var i = 0; i < L; i++) {
      if (cond[i]) cur = x[i];
      out[i] = cur;
    }
    return out;
  }

  /** EMA(X,N) */
  function ema(x, n) {
    var L = x.length, out = new Float64Array(L);
    out.fill(NAN);
    var a = 2.0 / (n + 1), prev = NAN;
    for (var i = 0; i < L; i++) {
      var v = x[i];
      if (!isFiniteNum(v)) { out[i] = prev; continue; }
      prev = !isFiniteNum(prev) ? v : a * v + (1 - a) * prev;
      out[i] = prev;
    }
    return out;
  }

  /** SMA(X,N,M) */
  function sma(x, n, m) {
    var L = x.length, out = new Float64Array(L);
    out.fill(NAN);
    var prev = NAN;
    for (var i = 0; i < L; i++) {
      var v = x[i];
      if (!isFiniteNum(v)) { out[i] = prev; continue; }
      prev = !isFiniteNum(prev) ? v : (m * v + (n - m) * prev) / n;
      out[i] = prev;
    }
    return out;
  }

  /** MA(X,N) */
  function ma(x, n) {
    n = Math.max(1, Math.trunc(n));
    var L = x.length, out = new Float64Array(L);
    out.fill(NAN);
    for (var i = 0; i < L; i++) {
      var s = Math.max(0, i - n + 1), sum = 0, c = 0;
      for (var j = s; j <= i; j++) {
        if (isFiniteNum(x[j])) { sum += x[j]; c++; }
      }
      out[i] = c ? sum / c : NAN;
    }
    return out;
  }

  /** SUM(X,N) */
  function rsum(x, n) {
    var L = x.length, out = new Float64Array(L);
    var cs = new Float64Array(L + 1);
    for (var i = 0; i < L; i++) {
      cs[i + 1] = cs[i] + (isFiniteNum(x[i]) ? x[i] : 0);
    }
    var scalar = (typeof n === 'number');
    for (var i2 = 0; i2 < L; i2++) {
      var k = scalar ? n : n[i2];
      if (!isFiniteNum(k)) k = i2 + 1;
      k = Math.max(1, Math.trunc(k));
      out[i2] = cs[i2 + 1] - cs[Math.max(0, i2 - k + 1)];
    }
    return out;
  }

  // ---------------------------------------------------------------- 执行器
  function Series(ohlcv) {
    this.n = ohlcv.c.length;
    this.data = {};
    for (var k in ohlcv) {
      this.data[k.toUpperCase()] = ohlcv[k];
    }
    this.plots = [];
    this.errors = [];
  }

  var ALIAS = {
    CLOSE: 'C', OPEN: 'O', HIGH: 'H', LOW: 'L',
    VOL: 'V', VOLUME: 'V', AMOUNT: 'AMT'
  };

  Series.prototype.get = function (name) {
    if (this.data[name] !== undefined) return this.data[name];
    var base = name;
    if (base.charAt(base.length - 1) === '_') base = base.slice(0, -1);
    if (this.data[base] !== undefined) return this.data[base];
    if (ALIAS[base] && this.data[ALIAS[base]] !== undefined) return this.data[ALIAS[base]];
    return null;
  };

  function nanArr(n) {
    var a = new Float64Array(n);
    a.fill(NAN);
    return a;
  }

  function evalNode(nd, st) {
    var n = st.n;
    var k = nd.kind;
    if (k === 'num') {
      var a = new Float64Array(n);
      a.fill(nd.val);
      return a;
    }
    if (k === 'var') {
      var v = st.get(nd.val);
      return v === null ? nanArr(n) : v;
    }
    if (k === 'un') {
      var x = evalNode(nd.args[0], st);
      if (nd.val === '-') {
        var o1 = new Float64Array(n);
        for (var i = 0; i < n; i++) o1[i] = -x[i];
        return o1;
      }
      if (nd.val === '+') return x;
      // NOT
      var t = _truth(x), o2 = new Float64Array(n);
      for (var j = 0; j < n; j++) o2[j] = t[j] ? 0 : 1;
      return o2;
    }
    if (k === 'bin') {
      var A = evalNode(nd.args[0], st);
      var B = evalNode(nd.args[1], st);
      var op = nd.val, out = new Float64Array(n), ii;
      if (op === '+') { for (ii = 0; ii < n; ii++) out[ii] = A[ii] + B[ii]; return out; }
      if (op === '-') { for (ii = 0; ii < n; ii++) out[ii] = A[ii] - B[ii]; return out; }
      if (op === '*') { for (ii = 0; ii < n; ii++) out[ii] = A[ii] * B[ii]; return out; }
      if (op === '/') {
        for (ii = 0; ii < n; ii++) out[ii] = (B[ii] === 0) ? NAN : A[ii] / B[ii];
        return out;
      }
      if (op === '>') { for (ii = 0; ii < n; ii++) out[ii] = (A[ii] > B[ii]) ? 1 : 0; return out; }
      if (op === '<') { for (ii = 0; ii < n; ii++) out[ii] = (A[ii] < B[ii]) ? 1 : 0; return out; }
      if (op === '>=') { for (ii = 0; ii < n; ii++) out[ii] = (A[ii] >= B[ii]) ? 1 : 0; return out; }
      if (op === '<=') { for (ii = 0; ii < n; ii++) out[ii] = (A[ii] <= B[ii]) ? 1 : 0; return out; }
      if (op === '=') {
        var aAllNaN = true, bAllNaN = true;
        for (ii = 0; ii < n; ii++) { if (!isNaN(A[ii])) aAllNaN = false; if (!isNaN(B[ii])) bAllNaN = false; }
        if (bAllNaN) { for (ii = 0; ii < n; ii++) out[ii] = isNaN(A[ii]) ? 1 : 0; return out; }
        if (aAllNaN) { for (ii = 0; ii < n; ii++) out[ii] = isNaN(B[ii]) ? 1 : 0; return out; }
        for (ii = 0; ii < n; ii++) out[ii] = (A[ii] === B[ii]) ? 1 : 0;
        return out;
      }
      if (op === '!=') {
        var aN = true, bN = true;
        for (ii = 0; ii < n; ii++) { if (!isNaN(A[ii])) aN = false; if (!isNaN(B[ii])) bN = false; }
        if (bN) { for (ii = 0; ii < n; ii++) out[ii] = isNaN(A[ii]) ? 0 : 1; return out; }
        if (aN) { for (ii = 0; ii < n; ii++) out[ii] = isNaN(B[ii]) ? 0 : 1; return out; }
        for (ii = 0; ii < n; ii++) out[ii] = (A[ii] !== B[ii]) ? 1 : 0;
        return out;
      }
      if (op === 'AND') {
        var ta = _truth(A), tb = _truth(B);
        for (ii = 0; ii < n; ii++) out[ii] = (ta[ii] && tb[ii]) ? 1 : 0;
        return out;
      }
      if (op === 'OR') {
        var oa = _truth(A), ob = _truth(B);
        for (ii = 0; ii < n; ii++) out[ii] = (oa[ii] || ob[ii]) ? 1 : 0;
        return out;
      }
      throw new Error('未知运算符 ' + op);
    }
    if (k === 'call') {
      return callFn(nd.val, nd.args, st);
    }
    throw new Error('未知节点 ' + k);
  }

  function numArg(a) {
    for (var i = a.length - 1; i >= 0; i--) {
      if (isFiniteNum(a[i])) return a[i];
    }
    return 0;
  }

  function callFn(name, args, st) {
    var n = st.n;
    var A = args.map(function (x) { return evalNode(x, st); });
    var A0 = A.length > 0 ? A[0] : nanArr(n);
    var A1 = A.length > 1 ? A[1] : null;
    var A2 = A.length > 2 ? A[2] : null;

    switch (name) {
      case 'IF': {
        var c = _truth(A0), out = new Float64Array(n);
        for (var i = 0; i < n; i++) out[i] = c[i] ? A[1][i] : A[2][i];
        return out;
      }
      case 'REF': return ref(A0, A1 === null ? 0 : (A1.length ? A1 : A1));
      case 'REFX': return refx(A0, A1 === null ? 0 : A1);
      case 'BARSLAST': return barslast(_truth(A0));
      case 'BARSNEXT': return barsnext(_truth(A0));
      case 'COUNT': return count(_truth(A0), A1 === null ? n : A1);
      case 'SUMBARS': return sumbars(_truth(A0), numArg(A1 === null ? new Float64Array([n]) : A1));
      case 'FILTERX': {
        var fx = filterx(_truth(A0), A1 === null ? 0 : A1);
        var o = new Float64Array(n);
        for (var j = 0; j < n; j++) o[j] = fx[j];
        return o;
      }
      case 'BACKSET': return backset(_truth(A0), A1 === null ? 0 : A1);
      case 'CROSS': return cross(A0, A1);
      case 'VALUEWHEN': return valuewhen(_truth(A0), A1);
      case 'HHV': return hhv(A0, A1 === null ? n : A1);
      case 'LLV': return llv(A0, A1 === null ? n : A1);
      case 'MA': return ma(A0, numArg(A1));
      case 'EMA': return ema(A0, numArg(A1));
      case 'SMA': return sma(A0, numArg(A1), numArg(A2));
      case 'SUM':
        if (A1 !== null) return rsum(A0, A1);
        return rsum(A0, new Float64Array([n]));
      case 'EVERY': {
        var k2 = Math.trunc(numArg(A1));
        // ★ 原实现传 new Float64Array([k2])：count 按「长度 L 的逐根数组」取 n[i]，
        //   长度 1 的数组在 i>0 处越界变 0 → EVERY 恒为 0。必须传标量。
        var cnt = count(_truth(A0), k2);
        var oe = new Float64Array(n);
        for (var m = 0; m < n; m++) oe[m] = cnt[m] >= k2 ? 1 : 0;
        return oe;
      }
      case 'NOT': {
        var t = _truth(A0), on = new Float64Array(n);
        for (var q = 0; q < n; q++) on[q] = t[q] ? 0 : 1;
        return on;
      }
      case 'ABS': {
        var oa = new Float64Array(n);
        for (var r = 0; r < n; r++) oa[r] = Math.abs(A0[r]);
        return oa;
      }
      case 'MAX': {
        var om = new Float64Array(n);
        for (var s = 0; s < n; s++) om[s] = Math.max(A0[s], A1[s]);
        return om;
      }
      case 'MIN': {
        var on2 = new Float64Array(n);
        for (var u = 0; u < n; u++) on2[u] = Math.min(A0[u], A1[u]);
        return on2;
      }
      case 'SQRT': {
        var os = new Float64Array(n);
        for (var v = 0; v < n; v++) os[v] = Math.sqrt(Math.abs(A0[v]));
        return os;
      }
      case 'CONST': {
        var cv = numArg(A0), oc = new Float64Array(n);
        oc.fill(cv);
        return oc;
      }
      case 'DRAWLINE': {
        // DRAWLINE(COND1,PRICE1,COND2,PRICE2,EXPAND)
        // 通达信语义：每当 COND1 成立就开启一段，连到其后的 COND2 成立处；
        // 全部段都画，返回「所有段覆盖位置的取值」，未覆盖处为 DRAWNULL。
        var out = nanArr(n);
        if (A.length < 4) return out;
        var c1 = _truth(A[0]), p1 = A[1], c2 = _truth(A[2]), p2 = A[3];
        var di = 0;
        while (di < n) {
          // 找下一个起点
          while (di < n && !c1[di]) di++;
          if (di >= n) break;
          var i1 = di;
          // 找终点：从 i1+1 起第一个 c2
          var i2 = -1;
          for (var dj = i1 + 1; dj < n; dj++) {
            if (c2[dj]) { i2 = dj; break; }
          }
          if (i2 < 0) break;
          var v1 = p1[i1], v2 = p2[i2];
          if (isFiniteNum(v1) && isFiniteNum(v2)) {
            for (var dk = i1; dk <= i2; dk++) {
              var ratio = (i2 === i1) ? 0 : (dk - i1) / (i2 - i1);
              out[dk] = v1 + (v2 - v1) * ratio;
            }
          }
          // 继续找下一段（从 i2 之后开始，允许 i2 同时是下段起点）
          di = i2 + 1;
        }
        return out;
      }
      case 'STICKLINE':
      case 'DRAWTEXT':
      case 'DRAWICON':
      case 'POLYLINE':
      case 'DRAWBAND':
      case 'DRAWTEXT_FIX':
      case 'DRAWKLINE':
        // 这些是纯绘图，返回全 NaN（后续 (X=DRAWNULL) 判定为无效）
        return nanArr(n);
      case 'DRAWNULL':
        return nanArr(n);
      default:
        // 未实现函数：静默 NaN，不中断整条公式
        return nanArr(n);
    }
  }

  // ---------------------------------------------------------------- 公式执行
  /**
   * 执行整段公式，返回 { data: {变量名: Float64Array}, errors: [] }
   * @param {string} text 公式文本
   * @param {Object} ohlcv {o:[],h:[],l:[],c:[],v:[]}
   */
  /** 按 ';' 切语句，尊重括号深度（通达信语句分隔符是 ';'，不是换行） */
  function splitStatements(src) {
    var out = [], buf = '', depth = 0;
    for (var i = 0; i < src.length; i++) {
      var ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ';' && depth === 0) { out.push(buf); buf = ''; continue; }
      buf += ch;
    }
    out.push(buf);
    return out;
  }

  function runFormula(text, ohlcv) {
    var st = new Series(ohlcv);
    // ★ 先剥掉 {注释}（可跨行），再按 ';' 切句。
    //   原实现按换行切，公式末行挤了 4 条语句时只解析第一条，
    //   且「保险」正则会把真表达式从下一条的 ':=' 处截断 → 值静默变常量。
    var _src = text.replace(/\{[\s\S]*?\}/g, '');
    var lines = splitStatements(_src);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line) continue;

      // 判定语句类型：:= 内部赋值 / : 输出
      var isAssign = line.indexOf(':=') >= 0;
      var sep = isAssign ? ':=' : ':';
      var idx = findSep(line, sep);
      if (idx < 0) continue;

      var name = line.slice(0, idx).trim();
      var exprPart = line.slice(idx + sep.length);

      // 去掉 NODRAW / COLORxxx / LINETHICKx 等修饰（逗号后允许空格）
      exprPart = exprPart.replace(/,\s*(NODRAW|COLOR[0-9A-Fa-f]{6}|COLOR[A-Z]+|LINETHICK\d+|POINTDOT|CROSSDOT|CIRCLEDOT|DOTLINE|NODRAW|VOLSTICK|STICK|LINESTICK)\b/gi, '');
      // ★ 原「保险」正则 /^\s*[^,]*?:(?!:)/ 会误伤：真表达式含后续语句的 ':=' 时被截断。
      //   拆分修好后每句只有一个名字分隔符，这里不再需要，删掉。
      // 绘图函数：通达信里 DRAWLINE/STICKLINE 等本身返回一条序列（线上取值，线外为 DRAWNULL）。
      // 公式会拿它做 (上线=DRAWNULL)=0 这种判断，所以不能整句丢弃，
      // 要照常求值并登记变量名，只是不参与渲染。
      var isDraw = /^\s*(DRAWLINE|STICKLINE|DRAWTEXT|DRAWICON|POLYLINE|DRAWBAND|DRAWTEXT_FIX|DRAWKLINE)\s*\(/i.test(exprPart);

      try {
        var toks = tokenize(exprPart);
        var parser = new Parser(toks);
        var ast = parser.parse();
        // ★ 原实现不检查 token 是否耗尽：表达式被截断时静默返回前半段的值。
        //   现在把剩余 token 显式暴露出来（末尾多余的逗号/括号属绘图修饰，放行）。
        var rest = [];
        for (var rt = parser.p; rt < toks.length; rt++) rest.push(toks[rt].val);
        var stray = rest.filter(function (v) { return v !== ',' && v !== ')'; });
        if (stray.length) {
          st.errors.push({
            line: li + 1, text: line.slice(0, 80),
            err: '语句未完整消费，剩余 token: ' + stray.slice(0, 8).join(' ')
          });
        }
        var val = evalNode(ast, st);
        st.data[name.toUpperCase()] = val;
        if (!isAssign) st.plots.push(name.toUpperCase());
      } catch (e) {
        st.errors.push({ line: li + 1, text: line.slice(0, 80), err: String(e.message || e) });
      }
    }
    // ★ 与 Python 侧 np.nan_to_num 对齐：NaN -> 0，Inf -> 大数
    // chan_core.load() 返回前会做这一步，笔/中枢判定都基于「0 表示缺失」，
    // 不转换会导致 IF(X>0) 之类判断出现分歧。
    var clean = {};
    for (var key in st.data) {
      var src = st.data[key];
      if (!src || typeof src.length !== 'number') { clean[key] = src; continue; }
      var dst = new Float64Array(src.length);
      for (var ci = 0; ci < src.length; ci++) {
        var cv = src[ci];
        dst[ci] = isFiniteNum(cv) ? cv : 0;
      }
      clean[key] = dst;
    }
    return { data: clean, errors: st.errors, n: st.n };
  }

  /** 找到不在括号/引号内的赋值分隔符位置 */
  function findSep(line, sep) {
    var depth = 0, inStr = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inStr) {
        if (ch === "'" || ch === '"') inStr = false;
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = true; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && line.substr(i, sep.length) === sep) {
        // 排除 <=  >=  != 这类
        var prev = line[i - 1];
        if (sep === ':' && (prev === '<' || prev === '>' || prev === '!')) continue;
        return i;
      }
    }
    return -1;
  }

  global.TDX = {
    runFormula: runFormula,
    tokenize: tokenize,
    // 导出内部函数便于测试
    _ref: ref, _hhv: hhv, _llv: llv, _barslast: barslast,
    _count: count, _sumbars: sumbars, _filterx: filterx, _backset: backset,
    _cross: cross, _valuewhen: valuewhen, _ema: ema, _sma: sma, _ma: ma,
    _truth: _truth
  };
})(typeof window !== 'undefined' ? window : globalThis);
