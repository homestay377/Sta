package io.github.mangi.eta.chan

import kotlin.math.abs

/**
 * 把 [ChanResult] 渲染成**给模型读的文本**（不是 JSON）。
 *
 * 从 `assets/stock/tools.js` 的 `summarizeChan` 移植，文风与字段顺序保持一致，
 * 这样模型看到的东西和换引擎之前完全一样，不需要重新学怎么读。
 *
 * 为什么要有它：JSON 塞给模型既费 token 又容易读错字段（比如把 `type=buy`
 * 当成买点标签）。这里只输出结论性事实。
 */
object ChanSummary {

    fun of(r: ChanResult, code: String, periodName: String): String {
        val bars = r.bars
        val n = bars.size
        if (n == 0) return "缠论：没有数据（$code $periodName）"

        val last = bars[n - 1]
        val sb = StringBuilder(768)
        sb.append("代码 ").append(code).append(" 周期 ").append(periodName)
            .append("，缠论基于最近 ").append(n).append(" 根（最新 ")
            .append(last.t).append(" 收 ").append(f(last.c)).append("）")

        if (r.errors.isNotEmpty()) {
            sb.append("\n公式告警 ").append(r.errors.size).append(" 条")
        }

        sb.append("\n笔：共 ").append(r.pens.size).append(" 个转折点，")
            .append(r.bi.size).append(" 段")

        if (r.bi.isNotEmpty()) {
            sb.append("\n最近笔向：")
            sb.append(r.bi.takeLast(5).joinToString(" ") { b ->
                (if (b.dir == "up") "↑" else "↓") + f(b.fromPrice) + "→" + f(b.toPrice) + "(" + b.len + "根)"
            })
        }

        if (r.boxes.isNotEmpty()) {
            sb.append("\n中枢：共 ").append(r.boxes.size).append(" 个")
            for (b in r.boxes.takeLast(3)) {
                val sT = if (b.s in 0 until n) bars[b.s].t else "?"
                val eT = if (b.e.coerceAtMost(n - 1) in 0 until n) bars[b.e.coerceAtMost(n - 1)].t else "?"
                val pos = when {
                    last.c > b.zg -> "当前价在中枢上方"
                    last.c < b.zd -> "当前价在中枢下方"
                    else -> "当前价在中枢内"
                }
                sb.append("\n  [").append(sT).append(" ~ ").append(eT).append("] ZG=")
                    .append(f(b.zg)).append(" ZD=").append(f(b.zd))
                    .append(" 中轴=").append(f(b.mid)).append(" — ").append(pos)
            }
        } else {
            sb.append("\n中枢：无")
        }

        r.stats.boxPosition?.let { pos ->
            sb.append("\n位置：当前价在最近中枢的「").append(pos).append("」")
            r.stats.lastBox?.let {
                sb.append("（ZG=").append(f(it.zg)).append(" ZD=").append(f(it.zd)).append("）")
            }
        }

        if (r.signals.isNotEmpty()) {
            sb.append("\n背驰：共 ").append(r.signals.size).append(" 个（注意：背驰 ≠ 买卖点，需结合中枢位置）")
            for (s in r.signals.takeLast(4)) {
                val t = if (s.idx in 0 until n) bars[s.idx].t else "?"
                sb.append("\n  ").append(t).append(' ').append(s.label)
                    .append("（").append(if (s.type == "buy") "买" else "卖").append("）")
                    .append("价位 ").append(f(s.price))
                    .append(" 力度 ").append(s.strength)
            }
        } else {
            sb.append("\n背驰：无")
        }

        if (r.points.isNotEmpty()) {
            sb.append("\n三类买卖点：共 ").append(r.points.size).append(" 个，最近 ")
                .append(minOf(5, r.points.size)).append(" 个：")
            for (p in r.points.takeLast(5)) {
                val t = if (p.idx in 0 until n) bars[p.idx].t else "?"
                sb.append("\n  ").append(t).append(' ').append(p.label)
                    .append(" 价位 ").append(f(p.price)).append(" —— ").append(p.reason)
            }
        } else {
            sb.append("\n三类买卖点：无（这是常见结果，不代表数据有问题）")
        }

        return sb.toString()
    }

    /** 与 `tools.js` 的 `f()` 同口径：两位小数。 */
    private fun f(v: Double): String {
        if (v.isNaN() || v.isInfinite()) return "—"
        val r = Math.round(v * 100.0) / 100.0
        return if (abs(r - r.toLong()) < 1e-9) r.toLong().toString() else r.toString()
    }
}