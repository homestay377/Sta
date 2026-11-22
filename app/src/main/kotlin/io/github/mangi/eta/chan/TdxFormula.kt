package io.github.mangi.eta.chan

import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.math.truncate

/**
 * 通达信指标公式解释器（Kotlin 移植版）。
 *
 * 口径严格对齐 `chanlun_engine/scripts/tdx.py` 与 JS 版 `tdx.js`：
 * 序列一律等长 DoubleArray，缺失为 NaN；语句先全局剥 `{注释}`，再按括号深度 0 的 `;` 切分。
 *
 * 支持：`:=` 赋值、`:` 输出、四则/比较/逻辑、IF/REF/REFX/BARSLAST/BARSNEXT/COUNT/SUMBARS/
 * FILTERX/BACKSET/CROSS/VALUEWHEN/HHV/LLV/MA/EMA/SMA/SUM/EVERY/NOT/ABS/MAX/MIN/SQRT/
 * CONST/DRAWLINE/DRAWNULL。未实现函数一律返回全 NaN（不中断整条公式），与 JS 的 default 分支一致。
 */
object TdxFormula {

    /** 单条语句的解析/求值错误。 */
    data class FormulaError(val line: Int, val text: String, val message: String)

    /** 公式执行结果。data 为「已清洗」序列：NaN -> 0，±Inf -> ±1e18。 */
    data class Result(
        val data: Map<String, DoubleArray>,
        val errors: List<FormulaError>,
        val bars: Int,
    )

    private const val INF_HUGE = 1e18

    private const val COLOR_MODIFIERS =
        """,\s*(NODRAW|COLOR[0-9A-Fa-f]{6}|COLOR[A-Z]+|LINETHICK\d+|POINTDOT|CROSSDOT|CIRCLEDOT|DOTLINE|NODRAW|VOLSTICK|STICK|LINESTICK)\b"""

    private val MODIFIER_RE = Regex(COLOR_MODIFIERS, setOf(RegexOption.IGNORE_CASE))

    private val DECORATIVE = setOf(
        "STICKLINE", "DRAWTEXT", "DRAWICON", "POLYLINE", "DRAWBAND", "DRAWTEXT_FIX", "DRAWKLINE",
    )

    private val ALIAS = mapOf(
        "CLOSE" to "C", "OPEN" to "O", "HIGH" to "H", "LOW" to "L",
        "VOL" to "V", "VOLUME" to "V", "AMOUNT" to "AMT",
    )

    private val REL_OPS = setOf(">", "<", ">=", "<=", "=", "==", "!=", "<>")

    // ------------------------------------------------------------------ 词法

    private enum class Kind { STR, NUM, IDENT, OP }

    private class Tok(val kind: Kind, val text: String)

    private val OPS2 = listOf("<=", ">=", "<>", "!=", ":=", "==")
    private val OPS1 = "-+*/(),;<>= "

    private fun isIdentStart(c: Char): Boolean = c.isLetter() || c == '_'

    private fun isIdentPart(c: Char): Boolean = c.isLetterOrDigit() || c == '_'

    private fun tokenize(src: String): List<Tok> {
        val out = ArrayList<Tok>()
        var i = 0
        while (i < src.length) {
            val c = src[i]
            when {
                c.isWhitespace() -> i++

                c == '\'' || c == '"' -> {
                    var j = i + 1
                    while (j < src.length && src[j] != c) j++
                    out.add(Tok(Kind.STR, src.substring(i, minOf(j + 1, src.length))))
                    i = j + 1
                }

                c.isDigit() || (c == '.' && i + 1 < src.length && src[i + 1].isDigit()) -> {
                    var j = i
                    while (j < src.length && src[j].isDigit()) j++
                    if (j < src.length && src[j] == '.') {
                        j++
                        while (j < src.length && src[j].isDigit()) j++
                    }
                    out.add(Tok(Kind.NUM, src.substring(i, j)))
                    i = j
                }

                isIdentStart(c) -> {
                    var j = i + 1
                    while (j < src.length && isIdentPart(src[j])) j++
                    out.add(Tok(Kind.IDENT, src.substring(i, j)))
                    i = j
                }

                else -> {
                    val two = if (i + 1 < src.length) src.substring(i, i + 2) else ""
                    if (two.isNotEmpty() && OPS2.contains(two)) {
                        out.add(Tok(Kind.OP, two))
                        i += 2
                    } else if (OPS1.indexOf(c) >= 0) {
                        out.add(Tok(Kind.OP, c.toString()))
                        i++
                    } else {
                        // 与 JS 的正则分词一致：匹配不到的字符（如 %）直接丢弃
                        i++
                    }
                }
            }
        }
        return out
    }

    // ------------------------------------------------------------------ 语法

    private enum class NK { NUM, VAR, CALL, BIN, UN }

    private class Node(
        val kind: NK,
        val value: Double = 0.0,
        val text: String = "",
        val args: List<Node> = emptyList(),
    )

    private class ParseException(message: String) : Exception(message)

    private class Parser(private val toks: List<Tok>) {
        var p = 0

        fun peek(): Tok? = if (p < toks.size) toks[p] else null

        fun eat(expected: String? = null): Tok {
            val tk = peek()
            if (expected != null && tk?.text != expected) {
                throw ParseException("期望 $expected 实际 ${tk?.text ?: "<结束>"}")
            }
            p++
            return tk ?: Tok(Kind.OP, "")
        }

        fun isOp(v: String): Boolean {
            val tk = peek() ?: return false
            return tk.kind == Kind.OP && tk.text == v
        }

        fun isKw(v: String): Boolean {
            val tk = peek() ?: return false
            return tk.kind == Kind.IDENT && tk.text.uppercase() == v
        }

        fun parse(): Node = pOr()

        private fun pOr(): Node {
            var a = pAnd()
            while (isKw("OR")) {
                eat()
                a = Node(NK.BIN, text = "OR", args = listOf(a, pAnd()))
            }
            return a
        }

        private fun pAnd(): Node {
            var a = pCmp()
            while (isKw("AND")) {
                eat()
                a = Node(NK.BIN, text = "AND", args = listOf(a, pCmp()))
            }
            return a
        }

        private fun pCmp(): Node {
            var a = pAdd()
            while (true) {
                val tk = peek()
                if (tk != null && tk.kind == Kind.OP && REL_OPS.contains(tk.text)) {
                    eat()
                    val op = when (tk.text) {
                        "==" -> "="
                        "<>" -> "!="
                        else -> tk.text
                    }
                    a = Node(NK.BIN, text = op, args = listOf(a, pAdd()))
                } else {
                    break
                }
            }
            return a
        }

        private fun pAdd(): Node {
            var a = pMul()
            while (true) {
                val tk = peek()
                if (tk != null && tk.kind == Kind.OP && (tk.text == "+" || tk.text == "-")) {
                    eat()
                    a = Node(NK.BIN, text = tk.text, args = listOf(a, pMul()))
                } else {
                    break
                }
            }
            return a
        }

        private fun pMul(): Node {
            var a = pUnary()
            while (true) {
                val tk = peek()
                if (tk != null && tk.kind == Kind.OP && (tk.text == "*" || tk.text == "/")) {
                    eat()
                    a = Node(NK.BIN, text = tk.text, args = listOf(a, pUnary()))
                } else {
                    break
                }
            }
            return a
        }

        private fun pUnary(): Node {
            val tk = peek()
            if (tk != null && tk.kind == Kind.OP && (tk.text == "-" || tk.text == "+")) {
                eat()
                return Node(NK.UN, text = tk.text, args = listOf(pUnary()))
            }
            if (isKw("NOT")) {
                eat()
                return Node(NK.UN, text = "NOT", args = listOf(pUnary()))
            }
            return pPrimary()
        }

        private fun pPrimary(): Node {
            val tk = peek()
            if (tk == null) {
                eat()
                return Node(NK.NUM, value = 0.0)
            }
            if (tk.kind == Kind.NUM) {
                eat()
                return Node(NK.NUM, value = tk.text.toDoubleOrNull() ?: 0.0)
            }
            if (tk.kind == Kind.OP && tk.text == "(") {
                eat("(")
                val e = parse()
                eat(")")
                return e
            }
            if (tk.kind == Kind.IDENT) {
                eat()
                val name = tk.text.uppercase()
                if (isOp("(")) {
                    eat("(")
                    val args = ArrayList<Node>()
                    if (!isOp(")")) {
                        args.add(parse())
                        while (isOp(",")) {
                            eat(",")
                            args.add(parse())
                        }
                    }
                    eat(")")
                    return Node(NK.CALL, text = name, args = args)
                }
                return Node(NK.VAR, text = name)
            }
            if (tk.kind == Kind.STR) {
                eat()
                return Node(NK.NUM, value = 0.0)
            }
            // 兜底：吞掉避免死循环
            eat()
            return Node(NK.NUM, value = 0.0)
        }
    }

    // ------------------------------------------------------------ 序列函数

    private fun isFiniteNum(v: Double): Boolean = v.isFinite()

    private fun nanArr(n: Int): DoubleArray = DoubleArray(n) { Double.NaN }

    private fun truth(x: DoubleArray): BooleanArray =
        BooleanArray(x.size) { val v = x[it]; v.isFinite() && v != 0.0 }

    /** NUMARG：取序列里最后一个有限值；没有则 0。 */
    private fun numArg(a: DoubleArray?): Double {
        if (a == null) return 0.0
        for (i in a.indices.reversed()) if (a[i].isFinite()) return a[i]
        return 0.0
    }

    /** REF(X,N)：N 为逐根序列（null 视为常数 0）。 */
    private fun ref(x: DoubleArray, n: DoubleArray?): DoubleArray {
        val len = x.size
        val out = nanArr(len)
        for (i in 0 until len) {
            val kv = if (n == null) 0.0 else n[i]
            if (!isFiniteNum(kv)) continue
            val k = truncate(kv)
            if (k <= 0) out[i] = x[i]
            else if (k <= i) out[i] = x[i - k.toInt()]
        }
        return out
    }

    /** REF(X,k)：标量位移版本（内部用，语义同系数序列）。 */
    private fun ref(x: DoubleArray, k: Int): DoubleArray {
        val len = x.size
        val out = nanArr(len)
        val kk = maxOf(0, k)
        for (i in 0 until len) {
            if (kk <= 0) out[i] = x[i] else if (i >= kk) out[i] = x[i - kk]
        }
        return out
    }

    /** REFX(X,N)：向未来取（未来函数）。i+k<L 才有值，否则 NaN。 */
    private fun refx(x: DoubleArray, n: DoubleArray?): DoubleArray {
        val len = x.size
        val out = nanArr(len)
        for (i in 0 until len) {
            val kv = if (n == null) 0.0 else n[i]
            if (!isFiniteNum(kv)) continue
            val k = truncate(kv)
            if (k <= 0) out[i] = x[i]
            else if (i + k < len) out[i] = x[i + k.toInt()]
        }
        return out
    }

    /** BARSLAST：距上次成立；无历史时返回 i（不是 i+1）。 */
    private fun barsLast(cond: BooleanArray): DoubleArray {
        val len = cond.size
        val out = DoubleArray(len)
        var last = -1
        for (i in 0 until len) {
            if (cond[i]) {
                last = i
                out[i] = 0.0
            } else {
                out[i] = if (last < 0) i.toDouble() else (i - last).toDouble()
            }
        }
        return out
    }

    /** BARSNEXT：距下次成立；无未来时返回 0。 */
    private fun barsNext(cond: BooleanArray): DoubleArray {
        val len = cond.size
        val out = DoubleArray(len)
        var nxt = -1
        for (i in len - 1 downTo 0) {
            if (cond[i]) {
                nxt = i
                out[i] = 0.0
            } else {
                out[i] = if (nxt < 0) 0.0 else (nxt - i).toDouble()
            }
        }
        return out
    }

    /** COUNT(COND,N)：前缀和 cs[i+1]-cs[max(0,i-k+1)]。 */
    private fun countImpl(cond: BooleanArray, kAt: (Int) -> Double): DoubleArray {
        val len = cond.size
        val cs = DoubleArray(len + 1)
        for (i in 0 until len) cs[i + 1] = cs[i] + if (cond[i]) 1.0 else 0.0
        val out = DoubleArray(len)
        for (i in 0 until len) {
            var k = kAt(i)
            if (!isFiniteNum(k)) k = 0.0
            k = truncate(k)
            val idx = i - k + 1.0
            out[i] = when {
                idx <= 0.0 -> cs[i + 1] - cs[0]
                idx > len -> Double.NaN
                else -> cs[i + 1] - cs[idx.toInt()]
            }
        }
        return out
    }

    /** SUMBARS(COND,N)：向前累加到第 N 个成立所经历的周期数（含当前）。 */
    private fun sumBars(cond: BooleanArray, nRaw: Double): DoubleArray {
        val len = cond.size
        val out = DoubleArray(len)
        val n = maxOf(1.0, truncate(nRaw))
        for (i in 0 until len) {
            var c = 0
            var j = i
            while (j >= 0) {
                if (cond[j]) {
                    c++
                    if (c >= n) break
                }
                j--
            }
            out[i] = if (c >= n) (i - j + 1).toDouble() else i.toDouble()
        }
        return out
    }

    /** FILTERX(C,N)：C 成立时把 [i-k,i-1] 清零并置 out[i]=1。 */
    private fun filterX(cond: BooleanArray, n: DoubleArray?): DoubleArray {
        val len = cond.size
        val out = DoubleArray(len)
        for (i in 0 until len) {
            if (!cond[i]) continue
            val kv = if (n == null) 0.0 else n[i]
            val k = if (isFiniteNum(kv)) truncate(kv) else 0.0
            val s = if (k >= i) 0 else (i - k).toInt()
            for (j in s until i) out[j] = 0.0
            out[i] = 1.0
        }
        return out
    }

    /** BACKSET(C,N)：C 成立且 k 时，把 [max(0,i-k),i] 置 1。 */
    private fun backset(cond: BooleanArray, n: DoubleArray?): DoubleArray {
        val len = cond.size
        val out = DoubleArray(len)
        for (i in 0 until len) {
            if (!cond[i]) continue
            val kv = if (n == null) 0.0 else n[i]
            val k = if (isFiniteNum(kv)) truncate(kv) else 0.0
            val s = if (k >= i) 0 else (i - k).toInt()
            for (j in s..i) out[j] = 1.0
        }
        return out
    }

    /** CROSS(A,B)：a>b && ref(a,1)<=ref(b,1)。 */
    private fun cross(a: DoubleArray, b: DoubleArray): DoubleArray {
        val len = a.size
        val ra = ref(a, 1)
        val rb = ref(b, 1)
        return DoubleArray(len) {
            if (a[it] > b[it] && ra[it] <= rb[it]) 1.0 else 0.0
        }
    }

    /** VALUEWHEN(C,X)：C 成立则刷新 cur，输出 cur。 */
    private fun valueWhen(cond: BooleanArray, x: DoubleArray): DoubleArray {
        val len = x.size
        val out = nanArr(len)
        var cur = Double.NaN
        for (i in 0 until len) {
            if (cond[i]) cur = x[i]
            out[i] = cur
        }
        return out
    }

    /** EMA(X,N)：a=2/(n+1)，首根取 X[0]，遇 NaN 沿用 prev。 */
    private fun ema(x: DoubleArray, nRaw: Double): DoubleArray {
        val len = x.size
        val out = nanArr(len)
        val a = 2.0 / (nRaw + 1.0)
        var prev = Double.NaN
        for (i in 0 until len) {
            val v = x[i]
            if (!isFiniteNum(v)) {
                out[i] = prev
                continue
            }
            prev = if (!isFiniteNum(prev)) v else a * v + (1 - a) * prev
            out[i] = prev
        }
        return out
    }

    /** SMA(X,N,M)：prev=(M*v+(N-M)*prev)/N，首根取 v。 */
    private fun sma(x: DoubleArray, nRaw: Double, mRaw: Double): DoubleArray {
        val len = x.size
        val out = nanArr(len)
        var prev = Double.NaN
        for (i in 0 until len) {
            val v = x[i]
            if (!isFiniteNum(v)) {
                out[i] = prev
                continue
            }
            prev = if (!isFiniteNum(prev)) v else (mRaw * v + (nRaw - mRaw) * prev) / nRaw
            out[i] = prev
        }
        return out
    }

    /** MA(X,N)：窗口内有限值求平均（不足 N 也用已有根数）。 */
    private fun ma(x: DoubleArray, nRaw: Double): DoubleArray {
        val n = maxOf(1.0, truncate(nRaw))
        val len = x.size
        val out = nanArr(len)
        for (i in 0 until len) {
            val s = if (n >= i + 1) 0 else (i - n + 1).toInt()
            var sum = 0.0
            var c = 0
            for (j in s..i) {
                val v = x[j]
                if (isFiniteNum(v)) {
                    sum += v
                    c++
                }
            }
            out[i] = if (c != 0) sum / c else Double.NaN
        }
        return out
    }

    /** HHV/LLV(X,N)：窗口忽略 NaN；全 NaN -> NaN。 */
    private fun extreme(x: DoubleArray, n: DoubleArray?, wantMax: Boolean): DoubleArray {
        val len = x.size
        val out = nanArr(len)
        for (i in 0 until len) {
            var k = if (n == null) len.toDouble() else n[i]
            if (!isFiniteNum(k)) k = 1.0
            k = maxOf(1.0, truncate(k))
            val s = if (k >= i + 1) 0 else (i - k + 1).toInt()
            var best = if (wantMax) Double.NEGATIVE_INFINITY else Double.POSITIVE_INFINITY
            var found = false
            for (j in s..i) {
                val v = x[j]
                if (isFiniteNum(v)) {
                    if (wantMax) {
                        if (v > best) best = v
                    } else {
                        if (v < best) best = v
                    }
                    found = true
                }
            }
            out[i] = if (found) best else Double.NaN
        }
        return out
    }

    /** SUM(X,N)：前缀和窗口求和，忽略 NaN。 */
    private fun sumImpl(x: DoubleArray, kAt: (Int) -> Double): DoubleArray {
        val len = x.size
        val cs = DoubleArray(len + 1)
        for (i in 0 until len) cs[i + 1] = cs[i] + (if (isFiniteNum(x[i])) x[i] else 0.0)
        val out = DoubleArray(len)
        for (i in 0 until len) {
            var k = kAt(i)
            if (!isFiniteNum(k)) k = (i + 1).toDouble()
            k = maxOf(1.0, truncate(k))
            val s = if (k >= i + 1) 0 else (i - k + 1).toInt()
            out[i] = cs[i + 1] - cs[s]
        }
        return out
    }

    // -------------------------------------------------------------- 执行器

    private class Ctx(val n: Int, val data: MutableMap<String, DoubleArray>) {
        fun get(name: String): DoubleArray? {
            data[name]?.let { return it }
            var base = name
            if (base.endsWith("_")) base = base.dropLast(1)
            data[base]?.let { return it }
            val alias = ALIAS[base]
            if (alias != null) data[alias]?.let { return it }
            return null
        }
    }

    private fun evalNode(nd: Node, ctx: Ctx): DoubleArray {
        val n = ctx.n
        when (nd.kind) {
            NK.NUM -> {
                val v = nd.value
                return DoubleArray(n) { v }
            }

            NK.VAR -> {
                val v = ctx.get(nd.text) ?: return nanArr(n)
                return if (v.size == n) v else DoubleArray(n) { i -> if (i < v.size) v[i] else Double.NaN }
            }

            NK.UN -> {
                val x = evalNode(nd.args[0], ctx)
                return when (nd.text) {
                    "-" -> DoubleArray(n) { -x[it] }
                    "+" -> x
                    else -> {
                        val t = truth(x)
                        DoubleArray(n) { if (t[it]) 0.0 else 1.0 }
                    }
                }
            }

            NK.BIN -> return evalBin(nd, ctx)

            NK.CALL -> return callFn(nd.text, nd.args, ctx)
        }
    }

    private fun evalBin(nd: Node, ctx: Ctx): DoubleArray {
        val n = ctx.n
        val a = evalNode(nd.args[0], ctx)
        val b = evalNode(nd.args[1], ctx)
        val op = nd.text
        val out = DoubleArray(n)
        when (op) {
            "+" -> for (i in 0 until n) out[i] = a[i] + b[i]
            "-" -> for (i in 0 until n) out[i] = a[i] - b[i]
            "*" -> for (i in 0 until n) out[i] = a[i] * b[i]
            "/" -> for (i in 0 until n) out[i] = if (b[i] == 0.0) Double.NaN else a[i] / b[i]
            ">" -> for (i in 0 until n) out[i] = if (a[i] > b[i]) 1.0 else 0.0
            "<" -> for (i in 0 until n) out[i] = if (a[i] < b[i]) 1.0 else 0.0
            ">=" -> for (i in 0 until n) out[i] = if (a[i] >= b[i]) 1.0 else 0.0
            "<=" -> for (i in 0 until n) out[i] = if (a[i] <= b[i]) 1.0 else 0.0
            "=" -> {
                // 一侧全是 NaN（DRAWNULL）时退化为 isnan 判断
                var aAllNaN = true
                var bAllNaN = true
                for (i in 0 until n) {
                    if (!a[i].isNaN()) aAllNaN = false
                    if (!b[i].isNaN()) bAllNaN = false
                }
                if (bAllNaN) {
                    for (i in 0 until n) out[i] = if (a[i].isNaN()) 1.0 else 0.0
                } else if (aAllNaN) {
                    for (i in 0 until n) out[i] = if (b[i].isNaN()) 1.0 else 0.0
                } else {
                    for (i in 0 until n) {
                        val av = a[i]
                        val bv = b[i]
                        out[i] = if (av.isNaN() || bv.isNaN()) 0.0 else if (av == bv) 1.0 else 0.0
                    }
                }
            }

            "!=" -> {
                var aAllNaN = true
                var bAllNaN = true
                for (i in 0 until n) {
                    if (!a[i].isNaN()) aAllNaN = false
                    if (!b[i].isNaN()) bAllNaN = false
                }
                if (bAllNaN) {
                    for (i in 0 until n) out[i] = if (a[i].isNaN()) 0.0 else 1.0
                } else if (aAllNaN) {
                    for (i in 0 until n) out[i] = if (b[i].isNaN()) 0.0 else 1.0
                } else {
                    for (i in 0 until n) {
                        val av = a[i]
                        val bv = b[i]
                        out[i] = if (av.isNaN() || bv.isNaN()) 1.0 else if (av != bv) 1.0 else 0.0
                    }
                }
            }

            "AND" -> {
                val ta = truth(a)
                val tb = truth(b)
                for (i in 0 until n) out[i] = if (ta[i] && tb[i]) 1.0 else 0.0
            }

            "OR" -> {
                val ta = truth(a)
                val tb = truth(b)
                for (i in 0 until n) out[i] = if (ta[i] || tb[i]) 1.0 else 0.0
            }

            else -> throw ParseException("未知运算符 $op")
        }
        return out
    }

    private fun callFn(name: String, args: List<Node>, ctx: Ctx): DoubleArray {
        val n = ctx.n
        val a = args.map { evalNode(it, ctx) }
        val a0 = if (a.isNotEmpty()) a[0] else nanArr(n)
        val a1 = if (a.size > 1) a[1] else null
        val a2 = if (a.size > 2) a[2] else null

        return when (name) {
            "IF" -> {
                if (a.size < 3) return nanArr(n)
                val c = truth(a[0])
                DoubleArray(n) { if (c[it]) a[1][it] else a[2][it] }
            }

            "REF" -> ref(a0, a1)
            "REFX" -> refx(a0, a1)
            "BARSLAST" -> barsLast(truth(a0))
            "BARSNEXT" -> barsNext(truth(a0))
            "COUNT" -> countImpl(truth(a0)) { i -> if (a1 == null) n.toDouble() else a1[i] }
            "SUMBARS" -> sumBars(truth(a0), numArg(a1))
            "FILTERX" -> filterX(truth(a0), a1)
            "BACKSET" -> backset(truth(a0), a1)
            "CROSS" -> if (a.size < 2) nanArr(n) else cross(a0, a1!!)
            "VALUEWHEN" -> if (a.size < 2) nanArr(n) else valueWhen(truth(a0), a1!!)
            "HHV" -> extreme(a0, a1, true)
            "LLV" -> extreme(a0, a1, false)
            "MA" -> if (a.size < 2) nanArr(n) else ma(a0, numArg(a1))
            "EMA" -> if (a.size < 2) nanArr(n) else ema(a0, numArg(a1))
            "SMA" -> if (a.size < 3) nanArr(n) else sma(a0, numArg(a1), numArg(a2))
            "SUM" -> sumImpl(a0) { i -> if (a1 == null) n.toDouble() else a1[i] }

            "EVERY" -> {
                // ★ N 必须按标量传：包成逐根数组时 count 会取到越界 0，EVERY 恒为 0。
                val k = truncate(numArg(a1))
                val cnt = countImpl(truth(a0)) { k }
                DoubleArray(n) { if (cnt[it] >= k) 1.0 else 0.0 }
            }

            "NOT" -> {
                val t = truth(a0)
                DoubleArray(n) { if (t[it]) 0.0 else 1.0 }
            }

            "ABS" -> DoubleArray(n) { abs(a0[it]) }
            "MAX" -> if (a.size < 2) nanArr(n) else DoubleArray(n) {
                val x = a0[it]
                val y = a[1][it]
                if (x.isNaN() || y.isNaN()) Double.NaN else if (x >= y) x else y
            }

            "MIN" -> if (a.size < 2) nanArr(n) else DoubleArray(n) {
                val x = a0[it]
                val y = a[1][it]
                if (x.isNaN() || y.isNaN()) Double.NaN else if (x <= y) x else y
            }

            "SQRT" -> DoubleArray(n) { sqrt(abs(a0[it])) }

            "CONST" -> {
                val v = numArg(a0)
                DoubleArray(n) { v }
            }

            "DRAWLINE" -> drawLine(a, n)

            in DECORATIVE -> nanArr(n)
            "DRAWNULL" -> nanArr(n)
            // 未实现函数（NAMELIKE/CODELIKE/ZTPRICE/DATE/...）：静默 NaN，不中断整条公式
            else -> nanArr(n)
        }
    }

    /** DRAWLINE(C1,P1,C2,P2)：每段从 C1 成立处线性连到其后首个 C2 成立处，后段覆盖前段。 */
    private fun drawLine(a: List<DoubleArray>, n: Int): DoubleArray {
        val out = nanArr(n)
        if (a.size < 4) return out
        val c1 = truth(a[0])
        val p1 = a[1]
        val c2 = truth(a[2])
        val p2 = a[3]
        var di = 0
        while (di < n) {
            while (di < n && !c1[di]) di++
            if (di >= n) break
            val i1 = di
            var i2 = -1
            var dj = i1 + 1
            while (dj < n) {
                if (c2[dj]) {
                    i2 = dj
                    break
                }
                dj++
            }
            if (i2 < 0) {
                // 找不到终点：跳过这个起点，继续找下一段（与 JS 的 break 等价）
                di = i1 + 1
                continue
            }
            val v1 = p1[i1]
            val v2 = p2[i2]
            if (isFiniteNum(v1) && isFiniteNum(v2)) {
                for (dk in i1..i2) {
                    val ratio = if (i2 == i1) 0.0 else (dk - i1).toDouble() / (i2 - i1).toDouble()
                    out[dk] = v1 + (v2 - v1) * ratio
                }
            }
            di = i2 + 1
        }
        return out
    }

    // ---------------------------------------------------------- 公式执行

    /** 按 ';' 切语句，尊重括号深度（通达信用 ';' 分隔，不是换行）。 */
    private fun splitStatements(src: String): List<String> {
        val out = ArrayList<String>()
        val buf = StringBuilder()
        var depth = 0
        for (ch in src) {
            when (ch) {
                '(' -> depth++
                ')' -> depth = maxOf(0, depth - 1)
            }
            if (ch == ';' && depth == 0) {
                out.add(buf.toString())
                buf.clear()
                continue
            }
            buf.append(ch)
        }
        out.add(buf.toString())
        return out
    }

    /** 找不在括号/引号内的赋值分隔符位置。 */
    private fun findSep(line: String, sep: String): Int {
        var depth = 0
        var inStr = false
        var i = 0
        while (i < line.length) {
            val ch = line[i]
            if (inStr) {
                if (ch == '\'' || ch == '"') inStr = false
                i++
                continue
            }
            if (ch == '\'' || ch == '"') {
                inStr = true
                i++
                continue
            }
            if (ch == '(') {
                depth++
            } else if (ch == ')') {
                depth--
            } else if (depth == 0 && line.startsWith(sep, i)) {
                val prev = if (i > 0) line[i - 1] else '\u0000'
                if (sep == ":" && (prev == '<' || prev == '>' || prev == '!')) {
                    i++
                    continue
                }
                return i
            }
            i++
        }
        return -1
    }

    /**
     * 执行整段公式。
     *
     * @param text   公式文本
     * @param ohlcv  行情序列（键可用 o/h/l/c/v 或 OPEN/HIGH/LOW/CLOSE/VOL）
     */
    fun run(text: String, ohlcv: Map<String, DoubleArray>): Result {
        val close = ohlcv["c"] ?: ohlcv["CLOSE"] ?: ohlcv["C"]
            ?: return Result(emptyMap(), listOf(FormulaError(0, "", "缺少收盘价序列")), 0)
        val n = close.size
        val data = HashMap<String, DoubleArray>()
        for ((k, v) in ohlcv) data[k.uppercase()] = v
        val ctx = Ctx(n, data)
        val errors = ArrayList<FormulaError>()

        // ★ 先全局剥掉 {注释}（可跨行），再按 ';' 切句
        val src = Regex("""\{[\s\S]*?}""").replace(text, "")
        val statements = splitStatements(src)
        for ((li, raw) in statements.withIndex()) {
            val line = raw.trim()
            if (line.isEmpty()) continue

            val isAssign = line.contains(":=")
            val sep = if (isAssign) ":=" else ":"
            val idx = findSep(line, sep)
            if (idx < 0) continue

            val name = line.substring(0, idx).trim()
            var exprPart = line.substring(idx + sep.length)

            // 去掉 NODRAW / COLORxxxxxx / LINETHICKx 等绘图修饰
            exprPart = MODIFIER_RE.replace(exprPart, "")

            try {
                val toks = tokenize(exprPart)
                val parser = Parser(toks)
                val ast = parser.parse()
                val stray = ArrayList<String>()
                for (rt in parser.p until toks.size) {
                    val v = toks[rt].text
                    if (v != "," && v != ")") stray.add(v)
                }
                if (stray.isNotEmpty()) {
                    errors.add(
                        FormulaError(
                            li + 1,
                            line.take(80),
                            "语句未完整消费，剩余 token: " + stray.take(8).joinToString(" "),
                        ),
                    )
                }
                data[name.uppercase()] = evalNode(ast, ctx)
            } catch (e: Exception) {
                errors.add(FormulaError(li + 1, line.take(80), e.message ?: e::class.java.simpleName))
            }
        }

        // 与引擎侧 np.nan_to_num 口径对齐：NaN -> 0，±Inf -> ±1e18
        val clean = HashMap<String, DoubleArray>(data.size)
        for ((key, s) in data) {
            val dst = DoubleArray(s.size)
            for (ci in s.indices) {
                val v = s[ci]
                dst[ci] = when {
                    v.isFinite() -> v
                    v == Double.POSITIVE_INFINITY -> INF_HUGE
                    v == Double.NEGATIVE_INFINITY -> -INF_HUGE
                    else -> 0.0
                }
            }
            clean[key] = dst
        }
        return Result(clean, errors, n)
    }
}