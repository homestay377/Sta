package io.github.mangi.eta.ui.stock

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * 技术指标（Kotlin 版），口径与 `assets/stock/indicators.js` 严格一致。
 *
 * 为什么要移植而不是等页面算：AI 要多级别对照时必须能在原生侧直接拿到结果，
 * 不能因为面板没展开或正在动画就拿不到数。移植时逐函数对齐，
 * 前置数据不足一律给 Double.NaN（对应 JS 里的 null），不要用 0 代替 —— 
 * 0 会被下游当成「真实值 0」，在均线上就是一根贴着底部的假线。
 */
internal object StockIndicators {

    /** 简单移动平均：前置不足周期处为 NaN。 */
    fun sma(values: DoubleArray, period: Int): DoubleArray {
        val n = values.size
        val out = DoubleArray(n) { Double.NaN }
        if (period <= 0) return out
        var sum = 0.0
        for (i in 0 until n) {
            sum += values[i]
            if (i >= period) sum -= values[i - period]
            out[i] = if (i >= period - 1) sum / period else Double.NaN
        }
        return out
    }

    /** 指数移动平均：与 JS 一致，首值直接以第一根起算。 */
    fun ema(values: DoubleArray, period: Int): DoubleArray {
        val n = values.size
        val out = DoubleArray(n) { Double.NaN }
        if (n == 0 || period <= 0) return out
        val k = 2.0 / (period + 1)
        var prev = values[0]
        out[0] = prev
        for (i in 1 until n) {
            prev = values[i] * k + prev * (1 - k)
            out[i] = prev
        }
        return out
    }

    data class Macd(val dif: DoubleArray, val dea: DoubleArray, val bar: DoubleArray)

    /** MACD(12,26,9)：DIF/DEA/BAR，首根三者均为 0。 */
    fun macd(
        closes: DoubleArray,
        fast: Int = 12,
        slow: Int = 26,
        signal: Int = 9,
    ): Macd {
        val n = closes.size
        val dif = DoubleArray(n)
        val dea = DoubleArray(n)
        val bar = DoubleArray(n)
        if (n == 0) return Macd(dif, dea, bar)
        var e12 = closes[0]
        var e26 = closes[0]
        for (i in 0 until n) {
            if (i == 0) {
                dif[0] = 0.0; dea[0] = 0.0; bar[0] = 0.0
                continue
            }
            val c = closes[i]
            e12 = c * (2.0 / (fast + 1)) + e12 * ((fast - 1).toDouble() / (fast + 1))
            e26 = c * (2.0 / (slow + 1)) + e26 * ((slow - 1).toDouble() / (slow + 1))
            dif[i] = e12 - e26
            dea[i] = dif[i] * (2.0 / (signal + 1)) + dea[i - 1] * ((signal - 1).toDouble() / (signal + 1))
            bar[i] = (dif[i] - dea[i]) * 2
        }
        return Macd(dif, dea, bar)
    }

    data class Boll(val mid: DoubleArray, val up: DoubleArray, val low: DoubleArray)

    /** BOLL(20,2)：用总体标准差（除以 period），与 JS 一致。 */
    fun boll(closes: DoubleArray, period: Int = 20, mult: Double = 2.0): Boll {
        val n = closes.size
        val mid = DoubleArray(n) { Double.NaN }
        val up = DoubleArray(n) { Double.NaN }
        val low = DoubleArray(n) { Double.NaN }
        for (i in 0 until n) {
            if (i < period - 1) continue
            var sum = 0.0
            for (j in i - period + 1..i) sum += closes[j]
            val m = sum / period
            var varSum = 0.0
            for (j in i - period + 1..i) {
                val d = closes[j] - m
                varSum += d * d
            }
            val sd = sqrt(varSum / period)
            mid[i] = m
            up[i] = m + mult * sd
            low[i] = m - mult * sd
        }
        return Boll(mid, up, low)
    }

    data class Kdj(val k: DoubleArray, val d: DoubleArray, val j: DoubleArray)

    /** KDJ(9,3,3)：RSV 起点 50，最高等于最低时按 50 处理（避免除零）。 */
    fun kdj(
        high: DoubleArray,
        low: DoubleArray,
        close: DoubleArray,
        n9: Int = 9,
        k3: Int = 3,
        d3: Int = 3,
    ): Kdj {
        val len = close.size
        val kOut = DoubleArray(len) { Double.NaN }
        val dOut = DoubleArray(len) { Double.NaN }
        val jOut = DoubleArray(len) { Double.NaN }
        var prevK = 50.0
        var prevD = 50.0
        for (i in 0 until len) {
            if (i < n9 - 1) continue
            var hi = Double.NEGATIVE_INFINITY
            var lo = Double.POSITIVE_INFINITY
            for (j in i - n9 + 1..i) {
                if (high[j] > hi) hi = high[j]
                if (low[j] < lo) lo = low[j]
            }
            val rsv = if (hi == lo) 50.0 else (close[i] - lo) / (hi - lo) * 100.0
            prevK = (rsv + (k3 - 1) * prevK) / k3
            prevD = (prevK + (d3 - 1) * prevD) / d3
            kOut[i] = prevK
            dOut[i] = prevD
            jOut[i] = 3 * prevK - 2 * prevD
        }
        return Kdj(kOut, dOut, jOut)
    }

    /** RSI(14)，Wilder 平滑。 */
    fun rsi(closes: DoubleArray, period: Int = 14): DoubleArray {
        val n = closes.size
        val out = DoubleArray(n) { Double.NaN }
        var avgGain = 0.0
        var avgLoss = 0.0
        for (i in 0 until n) {
            if (i == 0) {
                out[0] = Double.NaN
                continue
            }
            val diff = closes[i] - closes[i - 1]
            val gain = if (diff > 0) diff else 0.0
            val loss = if (diff < 0) -diff else 0.0
            if (i < period) {
                avgGain += gain
                avgLoss += loss
                if (i == period - 1) {
                    avgGain /= period
                    avgLoss /= period
                    out[i] = if (avgLoss == 0.0) 100.0 else 100 - 100 / (1 + avgGain / avgLoss)
                }
            } else {
                avgGain = (avgGain * (period - 1) + gain) / period
                avgLoss = (avgLoss * (period - 1) + loss) / period
                out[i] = if (avgLoss == 0.0) 100.0 else 100 - 100 / (1 + avgGain / avgLoss)
            }
        }
        return out
    }

    /**
     * 最近一次金叉 / 死叉的方向与距离。
     *
     * 只看「快线上穿慢线」这一件事，但必须带「多少根之前」——
     * 只报“金叉”不报发生在第几根，模型会当成刚刚发生，从而过度解读。
     */
    data class Cross(val kind: String, val barsAgo: Int)

    fun lastCross(fast: DoubleArray, slow: DoubleArray): Cross? {
        val n = minOf(fast.size, slow.size)
        if (n < 2) return null
        for (i in n - 1 downTo 1) {
            val f = fast[i]
            val s = slow[i]
            val fp = fast[i - 1]
            val sp = slow[i - 1]
            if (!f.isFinite() || !s.isFinite() || !fp.isFinite() || !sp.isFinite()) continue
            if (fp <= sp && f > s) return Cross("金叉", n - 1 - i)
            if (fp >= sp && f < s) return Cross("死叉", n - 1 - i)
        }
        return null
    }

    /**
     * 均线排列判定。
     *
     * 只比较有值的那几条（新股或小级别前段数据不足是常态），
     * 有 NaN 就跳过比较而不是判成“排列混乱”。
     */
    fun maAlignment(maValues: List<Pair<String, Double>>): String {
        val valid = maValues.filter { it.second.isFinite() }
        if (valid.size < 2) return "数据不足"
        var rising = true
        var falling = true
        for (i in 0 until valid.size - 1) {
            if (valid[i].second < valid[i + 1].second) rising = false
            if (valid[i].second > valid[i + 1].second) falling = false
        }
        return when {
            rising -> "多头排列（短期在上）"
            falling -> "空头排列（短期在下）"
            else -> "交织"
        }
    }

    /** 区间涨跌幅（%）。 */
    fun pctChange(from: Double, to: Double): Double =
        if (!from.isFinite() || !to.isFinite() || from == 0.0) Double.NaN else (to - from) / from * 100.0

    /**
     * 结构方向：用「顶是否递进 + 底是否递进」判定，不是数涨跌根数。
     *
     * 这条口径沿用你 v10.26 的教训：原来用「最近 3 笔里 up 的个数」判方向，
     * 结果一个从 14 跌到 6 的周线被判成上涨 —— 因为下跌趋势里的反弹笔
     * 同样会让 up 计数占多数（笔本来就是顶底交替的）。
     */
    fun structureDirection(pivots: List<Double>): String {
        val tops = ArrayList<Double>()
        val bots = ArrayList<Double>()
        // pivots 交替存放，偶数位当顶、奇数位当底；
        // 起始可能是底，因此按数值关系粗判不可靠，这里按索引奇偶交给调用方保证。
        for (i in pivots.indices) {
            if (i % 2 == 0) tops.add(pivots[i]) else bots.add(pivots[i])
        }
        if (tops.size < 2 || bots.size < 1) return "震荡"
        val topUp = tops[tops.size - 1] > tops[tops.size - 2]
        val botUp = if (bots.size >= 2) {
            bots[bots.size - 1] > bots[bots.size - 2]
        } else {
            topUp
        }
        return when {
            topUp && botUp -> "上涨"
            !topUp && !botUp -> "下跌"
            else -> "震荡"
        }
    }

    /** 数值格式化：与 JS 的 fx 接近，去掉多余的 0。 */
    fun fmt(v: Double, digits: Int = 2): String {
        if (!v.isFinite()) return "—"
        val scale = Math.pow(10.0, digits.toDouble())
        val rounded = Math.round(v * scale) / scale
        return if (abs(rounded - rounded.toLong()) < 1e-9) rounded.toLong().toString()
        else rounded.toString()
    }
}
