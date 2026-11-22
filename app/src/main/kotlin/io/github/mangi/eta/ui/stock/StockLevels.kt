package io.github.mangi.eta.ui.stock

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * 多级别走势汇总（原生，不经过 WebView）。
 *
 * 存在的理由：AI 做多级别判断时需要「同一只股票、多个级别、同一时刻」的对照，
 * 而不是让模型把面板一个个切过去读 —— 那样既慢又会闪，面板没展开还完全取不到。
 *
 * 设计要点：
 * 1. **并发拉取、按固定顺序汇总**。各级别并行请求（互不依赖，没必要串行），
 *    但输出永远按大级别到小级别的固定顺序排列，与完成先后无关。
 *    这一点很关键：级别顺序错一位，整个共振判断就反了。
 * 2. **只给摘要，不给全量 K 线**。多级别 × 数百根 OHLCV 会把上下文撑爆，
 *    而且模型真正需要的是「各级别方向是否一致、中枢在哪、力度如何」。
 * 需要精看某一级别时另行调用单级别读取。
 * 3. **缠论不在本层**。背驰与买卖点依赖 `chan.js` 那套调试过的公式解释器，
 *    重写等于重踩已踩过的坑，因此这里只给确定性的指标与结构，
 *    缠论结论仍由页面侧计算。
 */
internal object StockLevels {

    /**
     * 默认级别集合：从大到小。模型可以自己指定顺序与子集。
     *
     * 给五档而不是三档，是因为「一档一档看」会漏掉级别之间的背离：
     * 周线定方向、日线定结构、60 分定波段、30/15 分定入场。
     * 五档并发拉取（4 线程池 + 90s 缓存），比模型反复切面板逐档读更快，也不会让图跳。
     */
    val DEFAULT_LEVELS = listOf("week", "day", "m60", "m30", "m15")

    /** 允许一次请求的最大级别数，避免模型一次要十个级别把上下文塞满。 */
    const val MAX_LEVELS = 6

    private val pool = Executors.newFixedThreadPool(4) { r ->
        Thread(r, "stock-levels").apply { isDaemon = true }
    }

    /**
     * 巡检**专用**池，和 [pool] 隔开。
     *
     * ★ 共用同一个池会死锁：巡检一次性提交 N 个任务（N 可能到 30），把池占满后，
     *   每个任务内部还要再取数、再排队，结果互相等 → 大面积超时。
     *   线上表现就是「批量扫描 5/6 个失败，逐只顺序读反而正常」。
     */
    private val scanPool = Executors.newFixedThreadPool(3) { r ->
        Thread(r, "stock-scan").apply { isDaemon = true }
    }

    private val cache = ConcurrentHashMap<String, Cached>()

    private class Cached(val at: Long, val text: String)

    /** 缓存有效期：级别摘要主要是结构判断，几分钟内不变，避免模型连调几次就重复打接口。 */
    private const val CACHE_TTL_MS = 90_000L

    /** 巡检单只票的超时上限。 */
    private const val PER_ITEM_TIMEOUT_MS = 25_000L

    /**
     * 巡检整体预算。Agent 侧工具通常有 60s 级超时，这里留出余量——
     * 宁可返回部分结果并说明「未完成」，也不要整个工具被上层掐断。
     */
    private const val TOTAL_BUDGET_MS = 45_000L

    data class LevelResult(
        val period: String,
        val bars: Int,
        val lastTime: String,
        val lastClose: Double,
        val ok: Boolean,
        val error: String? = null,
        val digest: String = "",
        /** 结构方向（上涨/下跌/震荡），取自 swingPivots；取不到为空。 */
        val direction: String = "",
        /** 最近是否出现 MACD 金叉/死叉或量能异动，用于巡检时挑出值得关注的票。 */
        val hasSignal: Boolean = false,
        /** 最新一根的涨跌幅（%），由收盘价与前一根收盘价算出；不足两根时为 NaN。 */
        val changeRate: Double = Double.NaN,
    )

    /** A 股代码：sh/sz/bj + 6 位数字。 */
    private fun isAShareCode(code: String): Boolean =
        code.matches(Regex("[a-z]{2}\\d{6}"))

    fun periodLabel(period: String): String = when (period) {
        "week" -> "周线"
        "day" -> "日线"
        "m60" -> "60分钟"
        "m30" -> "30分钟"
        "m15" -> "15分钟"
        "m5" -> "5分钟"
        "m1" -> "1分钟"
        "month" -> "月线"
        "minute" -> "分时"
        else -> period
    }

    /**
     * 取多个级别的摘要。
     *
     * @param code 归一化后的代码（sz300274）
     * @param periods 级别列表，保留调用方给的顺序
     * @param barCount 每个级别取多少根，默认 640（腾讯日线上限；
     *                 低于这个数时序列左端没有历史，会凭空造出中枢）
     */
    fun digest(
        code: String,
        periods: List<String>,
        barCount: Int = StockKlineSource.CHAN_BARS,
    ): String {
        val normalized = periods
            .mapNotNull { StockKlineSource.validPeriod(it) }
            .distinct()
            .take(MAX_LEVELS)
        if (normalized.isEmpty()) return "级别参数不合法，可用：week/day/m60/m30/m15/m5/month"
        // ★ 境外品种（us.IXIC / XAU / usAAPL）不走 A 股代码校验。
        //   原来这里写死 [a-z]{2}\d{6}，导致多级别工具查纳指、伦敦金一律报"代码不合法"。
        if (!isAShareCode(code) && !StockKlineSource.isGlobalCode(code)) {
            return "股票代码不合法：$code"
        }

        val key = code + "|" + normalized.joinToString(",") + "|" + barCount
        val now = System.currentTimeMillis()
        cache[key]?.let { if (now - it.at < CACHE_TTL_MS) return it.text }

        // 并发拉取，结果按 normalized 的顺序回收
        val futures = normalized.map { p ->
            p to pool.submit<LevelResult> { loadOne(code, p, barCount) }
        }
        val results = ArrayList<LevelResult>(normalized.size)
        for ((period, f) in futures) {
            val r = try {
                f.get(20, TimeUnit.SECONDS)
            } catch (_: Throwable) {
                LevelResult(period, 0, "", Double.NaN, false, "取数超时或被中断")
            }
            results.add(r)
        }

        val text = render(code, results)
        cache[key] = Cached(now, text)
        return text
    }

    /** 预热：面板换股时顺手把默认级别算好，等模型真要时就已经在缓存里了。 */
    fun prefetch(code: String, periods: List<String> = DEFAULT_LEVELS) {
        try {
            pool.execute { digest(code, periods) }
        } catch (_: Throwable) {
        }
    }

    /**
     * **巡检用**：一行摘要，不铺全量 digest。
     *
     * 给自选股批量扫描用——20 只票如果每只都吐完整 digest，上下文直接爆掉。
     * 这里只给：收盘、涨跌幅、结构方向、是否有信号。
     *
     * @param name 股票简称，可为空（空则只出代码）
     */
    /** 巡检单只票的结构化结果。**调用方不要靠解析字符串判断成败**，直接看这里。 */
    data class ScanRow(
        val code: String,
        val name: String,
        val ok: Boolean,
        val error: String? = null,
        val time: String = "",
        val close: Double = Double.NaN,
        val changeRate: Double = Double.NaN,
        val direction: String = "",
        val hasSignal: Boolean = false,
    ) {
        /** 渲染成一行；失败时给明确原因。 */
        fun render(): String {
            if (!ok) return pad(code, 10) + " 取数失败：" + (error ?: "无数据")
            val label = if (name.isNotBlank()) name.take(6) else code
            val chgTxt = if (changeRate.isFinite()) {
                if (changeRate > 0) String.format("+%.2f%%", changeRate)
                else String.format("%.2f%%", changeRate)
            } else "-"
            val dir = if (direction.isNotBlank()) direction else "-"
            // ★ 不能用 String.format("%-8s") 补位：它按**字符数**算，中文按双宽显示，
            //   「阳光电源」4 个字会被当成 4 格补齐，实际占 8 格，整张巡检表会错位。
            // ★ 这里不能用 StockIndicators.fmt：它会把 74.00 输出成 "74"（去掉尾零），
            //   巡检表是定宽对齐的，价格长短不一会整列错位。固定两位小数。
            val priceTxt = if (close.isFinite()) String.format("%.2f", close) else "-"
            return pad(label, 10) + " " + pad(time, 11) + " " +
                pad("收" + priceTxt, 9) + " 结构:" +
                pad(dir, 6) + " " + (if (hasSignal) "有信号" else "无") + "  (" + chgTxt + ")"
        }
    }

    /** 单只票巡检（不渲染）。网络调用，别在主线程调。 */
    fun scanOne(code: String, period: String, name: String): ScanRow {
        val r = loadOne(code, period, StockKlineSource.CHAN_BARS)
        if (!r.ok) return ScanRow(code, name, false, r.error ?: "无数据")
        return ScanRow(
            code = code, name = name, ok = true,
            time = r.lastTime, close = r.lastClose, changeRate = r.changeRate,
            direction = r.direction, hasSignal = r.hasSignal,
        )
    }

    /**
     * 批量巡检，**并发**执行。
     *
     * 串行的话 20 只自选要 20~40 秒，很容易撞上 Agent 的工具超时。
     * 复用本类已有的 4 线程池，整体耗时约等于最慢的那一只。
     *
     * @param maxItems 上限保护：自选可能有几百只，全跑会把工具耗时和上下文都撑爆。
     */
    fun scanMany(
        items: List<Triple<String, String, String>>,
        period: String,
        maxItems: Int = 12,
    ): List<ScanRow> {
        val list = items.take(maxItems)
        val futures = list.map { (code, name, _) ->
            scanPool.submit<ScanRow> { scanOne(code, period, name) }
        }
        // ★ 必须有**整体**截止时间：单只 25s 只管自己，7 只各超 25s 就是 175s，
        //   远超 Agent 的工具超时。这里按「剩余预算」算每只还能等多久。
        val deadline = System.currentTimeMillis() + TOTAL_BUDGET_MS
        return futures.mapIndexed { i, f ->
            val remain = deadline - System.currentTimeMillis()
            if (remain <= 0) {
                try { f.cancel(true) } catch (_: Throwable) { }
                return@mapIndexed ScanRow(list[i].first, list[i].second, false, "超过总时长预算，未完成")
            }
            try {
                f.get(minOf(remain, PER_ITEM_TIMEOUT_MS), java.util.concurrent.TimeUnit.MILLISECONDS)
            } catch (_: Throwable) {
                try { f.cancel(true) } catch (_: Throwable) { }
                ScanRow(list[i].first, list[i].second, false, "超时或被中断")
            }
        }
    }

    /** 按显示宽度左对齐补空格：CJK 字符记 2 格，其余记 1 格。 */
    private fun pad(s: String, width: Int): String {
        var w = 0
        for (c in s) w += if (c.code > 0x2E7F) 2 else 1
        val need = width - w
        return if (need <= 0) s else s + " ".repeat(need)
    }

    fun clearCache() = cache.clear()

    // ==================== 单级别计算 ====================

    private fun loadOne(code: String, period: String, barCount: Int): LevelResult {
        var direction = ""
        var hasSignal = false
        val r = StockKlineSource.fetch(code, period, barCount)
        if (!r.ok) {
            return LevelResult(period, 0, "", Double.NaN, false, r.error ?: "无数据")
        }
        val bars = r.bars
        val n = bars.size
        // 涨跌幅：用最后一根与前一根收盘价，避免为了一行摘要再打一次行情接口
        val chg = if (n >= 2 && bars[n - 2].close > 0) {
            (bars[n - 1].close - bars[n - 2].close) / bars[n - 2].close * 100.0
        } else {
            Double.NaN
        }
        val closes = DoubleArray(n) { bars[it].close }
        val highs = DoubleArray(n) { bars[it].high }
        val lows = DoubleArray(n) { bars[it].low }
        val vols = DoubleArray(n) { bars[it].volume }

        val maPeriods = listOf(5, 10, 20, 60)
        val maLast: List<Pair<String, Double>> = maPeriods.map { p ->
            val v = StockIndicators.sma(closes, p).lastOrNull() ?: Double.NaN
            Pair("MA$p", v)
        }
        val macd = StockIndicators.macd(closes)
        val kdj = StockIndicators.kdj(highs, lows, closes)
        val rsi = StockIndicators.rsi(closes)
        val boll = StockIndicators.boll(closes)
        val li = n - 1
        val last = bars[li]

        val sb = StringBuilder(512)
        sb.append("◆ ").append(periodLabel(period))
            .append("（").append(n).append("根，最新 ").append(last.time).append("）\n")

        // 涨跌与区间
        val first = bars[0]
        val rangePct = StockIndicators.pctChange(first.close, last.close)
        sb.append("  收盘 ").append(StockIndicators.fmt(last.close, 3))
            .append("  区间涨跌 ").append(signed(rangePct, 2)).append("%")
            .append("  区间高/低 ").append(StockIndicators.fmt(barHigh(highs), 3))
            .append("/").append(StockIndicators.fmt(barLow(lows), 3)).append("\n")

        // 均线
        val maText = maLast.joinToString("  ") {
            it.first + "=" + StockIndicators.fmt(it.second, 3)
        }
        sb.append("  均线：").append(maText)
            .append("  → ").append(StockIndicators.maAlignment(maLast)).append("\n")

        // MACD
        val dif = macd.dif[li]
        val dea = macd.dea[li]
        val bar = macd.bar[li]
        sb.append("  MACD：DIF=").append(StockIndicators.fmt(dif, 3))
            .append(" DEA=").append(StockIndicators.fmt(dea, 3))
            .append(" 柱=").append(StockIndicators.fmt(bar, 3))
        StockIndicators.lastCross(macd.dif, macd.dea)?.let {
            sb.append("，").append(it.kind).append("后第 ").append(it.barsAgo).append(" 根")
            // 巡检时「近 3 根内出了 MACD 金叉/死叉」算值得关注
            if (it.barsAgo <= 3) hasSignal = true
        }
        // 柱状体是在放大还是缩小：这是判断力度衰竭的直接依据
        if (li >= 4) {
            val prevAbs = DoubleArray(4) { Math.abs(macd.bar[li - 3 + it]) }
            val shrinking = prevAbs[3] < prevAbs[2] && prevAbs[2] < prevAbs[1]
            val expanding = prevAbs[3] > prevAbs[2] && prevAbs[2] > prevAbs[1]
            if (shrinking) {
                sb.append("，柱体连续收缩")
                // 力度衰竭是背驰的前置信号，巡检时要标出来
                hasSignal = true
            } else if (expanding) sb.append("，柱体连续放大")
        }
        sb.append("\n")

        // KDJ / RSI
        sb.append("  KDJ：K=").append(StockIndicators.fmt(kdj.k[li], 1))
            .append(" D=").append(StockIndicators.fmt(kdj.d[li], 1))
            .append(" J=").append(StockIndicators.fmt(kdj.j[li], 1))
            .append("   RSI14=").append(StockIndicators.fmt(rsi[li], 1)).append("\n")

        // 布林
        val mid = boll.mid[li]
        val up = boll.up[li]
        val low = boll.low[li]
        if (mid.isFinite()) {
            val pos = when {
                last.close > up -> "上轨之上"
                last.close < low -> "下轨之下"
                last.close > mid -> "中轨与上轨之间"
                else -> "中轨与下轨之间"
            }
            sb.append("  BOLL：上=").append(StockIndicators.fmt(up, 3))
                .append(" 中=").append(StockIndicators.fmt(mid, 3))
                .append(" 下=").append(StockIndicators.fmt(low, 3))
                .append("，当前价在").append(pos)
            // 带宽变化说明是收口还是扩张
            if (li >= 20) {
                val wNow = up - low
                val wPrev = boll.up[li - 20] - boll.low[li - 20]
                if (wNow.isFinite() && wPrev.isFinite() && wPrev > 0) {
                    val chg = (wNow - wPrev) / wPrev * 100
                    sb.append(if (chg > 5) "，带宽扩张 " else if (chg < -5) "，带宽收窄 " else "，带宽平稳 ")
                    sb.append(StockIndicators.fmt(Math.abs(chg), 1)).append("%")
                }
            }
            sb.append("\n")
        }

        // 量能
        val vma5 = StockIndicators.sma(vols, 5).lastOrNull() ?: Double.NaN
        if (vma5.isFinite() && vma5 > 0) {
            val ratio = last.volume / vma5
            sb.append("  量能：最新量/5日均量 = ").append(StockIndicators.fmt(ratio, 2)).append(" 倍")
            if (ratio > 1.5) sb.append("（明显放量）")
            else if (ratio < 0.6) sb.append("（明显缩量）")
            sb.append("\n")
        } else if (vols.all { it == 0.0 }) {
            // 伦敦金等现货品种没有成交量字段；说明原因比留空更清楚
            sb.append("  量能：该品种无成交量数据（现货报价），量价指标不适用\n")
        }

        // 结构：最近若干个摆动高低点
        val pivots = swingPivots(highs, lows, 5)
        if (pivots.size >= 4) {
            val dir = StockIndicators.structureDirection(pivots.takeLast(6).map { it })
            sb.append("  结构：最近高低点 ")
            sb.append(pivots.takeLast(6).joinToString(" → ") { StockIndicators.fmt(it, 3) })
            sb.append("  → ").append(dir).append("\n")
            direction = dir
        }

        // 最近 5 根摘要（让模型能看到当下形态，又不至于刷屏）
        sb.append("  最近5根（时间/开/高/低/收/量）：\n")
        for (i in maxOf(0, n - 5) until n) {
            val b = bars[i]
            sb.append("    ").append(b.time)
                .append(" ").append(StockIndicators.fmt(b.open, 2))
                .append("/").append(StockIndicators.fmt(b.high, 2))
                .append("/").append(StockIndicators.fmt(b.low, 2))
                .append("/").append(StockIndicators.fmt(b.close, 2))
                .append("/").append(StockIndicators.fmt(b.volume, 0)).append("\n")
        }

        return LevelResult(period, n, last.time, last.close, true, null, sb.toString(), direction, hasSignal, chg)
    }

    /** 摆动高低点：左右各 k 根的局部极值，按时间顺序合并。 */
    private fun swingPivots(highs: DoubleArray, lows: DoubleArray, k: Int): List<Double> {
        val n = highs.size
        if (n < k * 2 + 1) return emptyList()
        val points = ArrayList<Triple<Int, Double, Boolean>>() // idx, price, isTop
        for (i in k until n - k) {
            var isTop = true
            var isBot = true
            for (j in i - k..i + k) {
                if (j == i) continue
                if (highs[j] >= highs[i]) isTop = false
                if (lows[j] <= lows[i]) isBot = false
            }
            if (isTop) points.add(Triple(i, highs[i], true))
            if (isBot) points.add(Triple(i, lows[i], false))
        }
        if (points.isEmpty()) return emptyList()
        // 相邻同类型只保留更极端的那个
        val merged = ArrayList<Triple<Int, Double, Boolean>>()
        for (p in points.sortedBy { it.first }) {
            val lastP = merged.lastOrNull()
            if (lastP != null && lastP.third == p.third) {
                val better = if (p.third) p.second > lastP.second else p.second < lastP.second
                if (better) merged[merged.size - 1] = p
            } else {
                merged.add(p)
            }
        }
        return merged.map { it.second }
    }

    private fun barHigh(highs: DoubleArray): Double = highs.maxOrNull() ?: Double.NaN
    private fun barLow(lows: DoubleArray): Double = lows.minOrNull() ?: Double.NaN

    private fun signed(v: Double, digits: Int): String {
        if (!v.isFinite()) return "—"
        val s = StockIndicators.fmt(v, digits)
        return if (v > 0) "+$s" else s
    }

    // ==================== 汇总渲染 ====================

    private fun render(code: String, results: List<LevelResult>): String {
        val ok = results.filter { it.ok }
        val bad = results.filter { !it.ok }
        val sb = StringBuilder(1024)
        sb.append("【多级别走势】").append(code.uppercase())
            .append("  级别 ").append(ok.joinToString("/") { periodLabel(it.period) }).append("\n\n")

        if (ok.isEmpty()) {
            sb.append("所有级别都没取到数据：")
            sb.append(bad.joinToString("；") { periodLabel(it.period) + " " + (it.error ?: "") })
            return sb.toString()
        }

        ok.forEach { sb.append(it.digest).append("\n") }

        // 一句话对照表：模型最容易先看这一行
        sb.append("【级别对照】\n")
        ok.forEach { r ->
            sb.append("  ").append(periodLabel(r.period))
                .append("：收 ").append(StockIndicators.fmt(r.lastClose, 3))
                .append("，共 ").append(r.bars).append(" 根\n")
        }

        if (bad.isNotEmpty()) {
            sb.append("【取数失败】")
            sb.append(bad.joinToString("；") { periodLabel(it.period) + " " + (it.error ?: "无数据") })
            sb.append("（这些级别不要凭空推断）\n")
        }
        // ★ 复权口径提醒：日线/周线是前复权，分钟线数据源本身没有复权价（不复权）。
        //   两者末根价一致（都是当前价），但历史价位不连续，跨级别比「中枢上下沿」会失真。
        sb.append("【口径提醒】日线/周线为前复权，分钟线为不复权：末根价一致，")
        sb.append("但两者历史价位不可直接相减，跨级别比较中枢上下沿/均线价位时只作方向参考。\n")
        return sb.toString()
    }
}
