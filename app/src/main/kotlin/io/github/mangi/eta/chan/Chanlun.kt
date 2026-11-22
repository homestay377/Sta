package io.github.mangi.eta.chan

import java.util.Locale
import kotlin.math.min

/** 单根 K 线。 */
data class Bar(
    val o: Double,
    val h: Double,
    val l: Double,
    val c: Double,
    val v: Double = 0.0,
    val t: String = "",
)

/** 笔转折点。dir/from/to/... 在 [Chanlun.analyze] 里回填（下游直接遍历 pens 读这些字段）。 */
data class PenPoint(
    val idx: Int,
    val price: Double,
    val type: String,
    var dir: String? = null,
    var from: Int? = null,
    var to: Int? = null,
    var fromPrice: Double? = null,
    var toPrice: Double? = null,
    var len: Int? = null,
    var fromType: String? = null,
    var toType: String? = null,
)

/** 中枢框。 */
data class ChanBox(
    val tag: String,
    val s: Int,
    val e: Int,
    val zg: Double,
    val zd: Double,
    val mid: Double,
)

/** 相邻笔连成的段。 */
data class Bi(
    val from: Int,
    val to: Int,
    val fromPrice: Double,
    val toPrice: Double,
    val dir: String,
    val fromType: String,
    val toType: String,
    val len: Int,
)

/** 背驰信号。 */
data class ChanSignal(
    val idx: Int,
    val type: String,
    val label: String,
    val level: String,
    val price: Double,
    val strength: String,
)

/** 三类买卖点。 */
data class ChanPoint(
    val idx: Int,
    val type: String,
    val label: String,
    val price: Double,
    val reason: String,
    val box: BoxRef?,
)

/** 买卖点引用的中枢摘要（价格保留 2 位）。 */
data class BoxRef(val s: Int, val e: Int, val zg: Double, val zd: Double)

/** 统计摘要。 */
data class ChanStats(
    val bars: Int,
    val pens: Int,
    val boxes: Int,
    val errors: Int,
    val lastPen: PenPoint?,
    val lastBox: ChanBox?,
    /** 现价相对最后一个中枢：中枢上方 / 中枢下方 / 中枢内。 */
    val boxPosition: String?,
)

/** 缠论分析结果。 */
data class ChanResult(
    val pens: List<PenPoint>,
    val boxes: List<ChanBox>,
    val bi: List<Bi>,
    val stats: ChanStats,
    val signals: List<ChanSignal>,
    val points: List<ChanPoint>,
    val data: Map<String, DoubleArray>,
    val errors: List<TdxFormula.FormulaError>,
    val bars: List<Bar>,
)

/**
 * 缠论核心算法（Kotlin 移植版），口径对齐 `chanlun_engine/scripts/chan_core.py` + `analyze.py`
 * 与 JS 版 `chan.js`（后者已与 Python 在 210/211 个序列上逐值一致，是最终基准）。
 */
object Chanlun {

    /** 零面积守卫：低于此视为该段无同向动能。 */
    private const val EPS_AREA = 1e-6

    /** 面积缩到前段 85% 以下才算力度衰竭。 */
    private const val DIV_RATIO = 0.85

    private fun fmt2(v: Double): String = String.format(Locale.ROOT, "%.2f", v)

    /** 从 s 起、值保持不变的连续段终点。 */
    private fun runEnd(v: DoubleArray, s: Int): Int {
        val base = v[s]
        var e = s
        while (e + 1 < v.size && v[e + 1] == base) e++
        return e
    }

    /**
     * 红/绿两族常对同一段给出同一个中枢：时间+价格都重叠就合并，留跨度长的那个。
     * 不合并会画出两个几乎重合的框。
     */
    fun mergeBoxes(boxes: List<ChanBox>): List<ChanBox> {
        val bs = boxes.sortedWith(Comparator { x, y ->
            if (x.s != y.s) x.s - y.s else (y.e - y.s) - (x.e - x.s)
        })
        val out = ArrayList<ChanBox>()
        for (b in bs) {
            var hit = -1
            for (j in out.indices) {
                val u = out[j]
                if (min(u.e, b.e) - maxOf(u.s, b.s) <= 0) continue
                val ov = min(u.zg, b.zg) - maxOf(u.zd, b.zd)
                val span = min(u.zg - u.zd, b.zg - b.zd)
                if (span > 0 && ov > 0.6 * span) {
                    hit = j
                    break
                }
            }
            if (hit < 0) {
                out.add(b)
            } else if ((b.e - b.s) > (out[hit].e - out[hit].s)) {
                out[hit] = b
            }
        }
        return out.sortedBy { it.s }
    }

    /**
     * 按通达信规则算每个中枢框的 [起点, 终点]。
     * 右边界 = min(顶值不变终点, 下一同类起点-1, 断点-1, 该族轨上线延伸段末根)
     */
    fun boxSpans(D: Map<String, DoubleArray>, s0: Int): List<ChanBox> {
        val res = ArrayList<ChanBox>()
        for (tag in listOf("红", "绿")) {
            val startSeq = D.get(tag + "起") ?: continue
            val topSeq = D.get(tag + "顶_锁定") ?: continue
            val botSeq = D.get(tag + "底_锁定") ?: continue
            val midSeq = D.get(tag + "中_锁定")

            val starts = ArrayList<Int>()
            for (i in startSeq.indices) if (startSeq[i] > 0) starts.add(i)

            val brkSeq = D.get(tag + "断点")
            val brk = ArrayList<Int>()
            if (brkSeq != null) for (i in brkSeq.indices) if (brkSeq[i] > 0) brk.add(i)

            val trackSeq = D.get(tag + "轨上线")
            val ok = ArrayList<Int>()
            if (trackSeq != null) {
                for (i in trackSeq.indices) {
                    if (trackSeq[i].isFinite() && trackSeq[i] > 0) ok.add(i)
                }
            }

            for ((index, s) in starts.withIndex()) {
                if (s < s0) continue
                var end = runEnd(topSeq, s)
                if (index + 1 < starts.size) end = min(end, starts[index + 1] - 1)
                for (bv in brk) {
                    if (bv >= s) {
                        end = min(end, bv - 1)
                        break
                    }
                }
                var lastOk = -1
                for (ov in ok) if (ov >= s) lastOk = ov
                if (lastOk >= 0) end = min(end, lastOk)

                val zg = topSeq[s]
                val zd = botSeq[s]
                res.add(
                    ChanBox(
                        tag = tag,
                        s = s,
                        e = end,
                        zg = zg,
                        zd = zd,
                        mid = if (midSeq != null) midSeq[s] else (zg + zd) / 2,
                    ),
                )
            }
        }
        return res
    }

    /** 主级笔转折点：X_70>0 取底，X_71>0 取顶，按索引排序。 */
    fun penPoints(D: Map<String, DoubleArray>, s0: Int, n: Int): List<PenPoint> {
        val pts = ArrayList<PenPoint>()
        val a70 = D["X_70"]
        val a71 = D["X_71"]
        for (i in s0 until n) {
            if (a70 != null && a70[i] > 0) pts.add(PenPoint(i - s0, a70[i], "底"))
            if (a71 != null && a71[i] > 0) pts.add(PenPoint(i - s0, a71[i], "顶"))
        }
        return pts.sortedBy { it.idx }
    }

    /** 同向连续转折点只保留更极端的一个，保证顶底交替。 */
    fun cleanPens(pts: List<PenPoint>): List<PenPoint> {
        val out = ArrayList<PenPoint>()
        for (p in pts) {
            val last = if (out.isEmpty()) null else out[out.size - 1]
            if (last != null && last.type == p.type) {
                if (p.type == "顶") {
                    if (p.price >= last.price) out[out.size - 1] = p
                } else {
                    if (p.price <= last.price) out[out.size - 1] = p
                }
            } else {
                out.add(p)
            }
        }
        return out
    }

    /** 公式没直接给 DIF 时用收盘价算 MACD 的 DIF（口径同 JS 参考实现）。 */
    private fun difFromClose(b: List<Bar>, n: Int): DoubleArray {
        val arr = DoubleArray(n)
        var e12 = b[0].c
        var e26 = b[0].c
        for (q in 1 until n) {
            val cq = b[q].c
            e12 = cq * (2.0 / 13.0) + e12 * (11.0 / 13.0)
            e26 = cq * (2.0 / 27.0) + e26 * (25.0 / 27.0)
            arr[q] = e12 - e26
        }
        return arr
    }

    private fun deaFromDif(dif: DoubleArray, n: Int): DoubleArray {
        val arr = DoubleArray(n)
        for (i in 1 until n) arr[i] = dif[i] * (2.0 / 10.0) + arr[i - 1] * (8.0 / 10.0)
        return arr
    }

    /**
     * 主流程：给定 K 线，算出笔与中枢。
     *
     * @param bars        K 线（时间正序）。**必须喂全部可用历史，不要只喂可视窗口**——
     *                    窗口太短时左沿会凭空多出中枢（实测 300274 只喂 270 根会多一个
     *                    `绿[1-46]`，通达信按全历史算没有这个框）。
     * @param formulaText 缠论公式原文
     * @param load        只用最后 N 根算（0 = 全部；**除对账外不要用**）
     * @param viewStart   可视窗口起点（相对 bars 的索引）。计算仍在全历史上做，
     *                    只把「完全落在窗口左侧」的中枢丢掉，避免画到看不见的地方。
     *                    0 表示不过滤。
     */
    fun analyze(
        bars: List<Bar>,
        formulaText: String,
        load: Int = 0,
        viewStart: Int = 0,
    ): ChanResult {
        val b = if (load > 0 && bars.size > load) bars.subList(bars.size - load, bars.size).toList() else bars
        val n = b.size
        if (n == 0) {
            return ChanResult(
                pens = emptyList(),
                boxes = emptyList(),
                bi = emptyList(),
                stats = ChanStats(0, 0, 0, 0, null, null, null),
                signals = emptyList(),
                points = emptyList(),
                data = emptyMap(),
                errors = emptyList(),
                bars = emptyList(),
            )
        }

        val ohlcv = mapOf(
            "o" to DoubleArray(n) { i -> b[i].o },
            "h" to DoubleArray(n) { i -> b[i].h },
            "l" to DoubleArray(n) { i -> b[i].l },
            "c" to DoubleArray(n) { i -> b[i].c },
            "v" to DoubleArray(n) { i -> b[i].v },
        )
        val res = TdxFormula.run(formulaText, ohlcv)
        val D = res.data

        val s0 = 0
        val pens = cleanPens(penPoints(D, s0, n))
        // ★ 先在全历史上合并（去重口径依赖完整序列），再只丢掉整体落在可视窗口左侧的框。
        val boxes = mergeBoxes(boxSpans(D, s0))
            .filter { viewStart <= 0 || it.e >= viewStart }

        // 笔连线；★ 这些字段必须回填到 pens 本身，下游（AI 提示、标注）直接遍历 pens 读
        val bi = ArrayList<Bi>(maxOf(0, pens.size - 1))
        for (p in 0 until pens.size - 1) {
            val a = pens[p]
            val c = pens[p + 1]
            val seg = Bi(
                from = a.idx,
                to = c.idx,
                fromPrice = a.price,
                toPrice = c.price,
                dir = if (c.price > a.price) "up" else "down",
                fromType = a.type,
                toType = c.type,
                len = c.idx - a.idx,
            )
            bi.add(seg)
            a.dir = seg.dir
            a.from = seg.from
            a.to = seg.to
            a.fromPrice = seg.fromPrice
            a.toPrice = seg.toPrice
            a.len = seg.len
            a.fromType = seg.fromType
            a.toType = seg.toType
        }

        // ---- 背驰：同向两段的 MACD 力度对比 ----
        val dif = D["DIF"] ?: difFromClose(b, n)
        val dea = D["DEA"] ?: deaFromDif(dif, n)
        val hist = DoubleArray(n) { (dif[it] - dea[it]) * 2 }

        fun segArea(a: Int, z: Int, up: Boolean): Double {
            var sum = 0.0
            var i = maxOf(0, a)
            while (i <= z && i < hist.size) {
                val h = hist[i]
                if (h.isFinite()) {
                    if (up) {
                        if (h > 0) sum += h
                    } else if (h < 0) {
                        sum += -h
                    }
                }
                i++
            }
            return sum
        }

        val signals = ArrayList<ChanSignal>()
        for (k in 2 until bi.size) {
            val cur = bi[k]
            val prev = bi[k - 2]
            if (cur.dir != prev.dir) continue
            val up = cur.dir == "up"
            // 必须创新极值：趋势背驰的定义是「新高/新低但力度不足」
            if (if (up) !(cur.toPrice > prev.toPrice) else !(cur.toPrice < prev.toPrice)) continue
            val a1 = segArea(prev.from, prev.to, up)
            val a2 = segArea(cur.from, cur.to, up)
            if (a1 <= EPS_AREA) continue
            val lv = if (boxes.size >= 2) "趋势" else "笔"
            if (a2 <= EPS_AREA) {
                // 分子归零 = 这一段完全没出现同向柱，价格却创新极值 → 极强背驰
                signals.add(
                    ChanSignal(
                        idx = cur.to,
                        type = if (up) "sell" else "buy",
                        label = (if (up) "顶" else "底") + "背驰(极强)",
                        level = "极强",
                        price = cur.toPrice,
                        strength = "1.00",
                    ),
                )
                continue
            }
            if (a2 < a1 * DIV_RATIO) {
                signals.add(
                    ChanSignal(
                        idx = cur.to,
                        type = if (up) "sell" else "buy",
                        label = (if (up) "顶" else "底") + "背驰(" + lv + ")",
                        level = lv,
                        price = cur.toPrice,
                        strength = fmt2(1 - a2 / a1),
                    ),
                )
            }
        }

        // ---- 三类买卖点（缠论定义，不是「背驰」的同义词）----
        //   判定只用 bi（笔段）与 boxes（中枢）：
        //     一买：下跌趋势中，最后一个中枢**下方**出现底背驰，且随后的反弹回到中枢区间内
        //     二买：一买之后第一次回调，低点**不破**一买的低点
        //     三买：价格在最后一个中枢**上方**，回调的低点不跌回 ZG
        //     卖点对称
        val points = ArrayList<ChanPoint>()

        fun pushPoint(idx: Int, kind: String, price: Double, why: String, box: ChanBox?) {
            points.add(
                ChanPoint(
                    idx = idx,
                    type = if (kind.contains("买")) "buy" else "sell",
                    label = kind,
                    price = price,
                    reason = why,
                    box = box?.let { BoxRef(it.s, it.e, fmt2(it.zg).toDouble(), fmt2(it.zd).toDouble()) },
                ),
            )
        }

        for (sg in signals) {
            var lastBoxAt: ChanBox? = null
            for (bx in boxes) if (bx.e <= sg.idx) lastBoxAt = bx

            if (sg.type == "buy" && lastBoxAt != null && sg.price < lastBoxAt.zd) {
                // 一买：中枢下方的底背驰
                pushPoint(
                    sg.idx, "一买", sg.price,
                    "下跌笔在中枢下方底背驰，力度衰减 " + sg.strength + "（中枢 ZD=" + fmt2(lastBoxAt.zd) + "）",
                    lastBoxAt,
                )

                // 二买：一买之后的下一次回调低点不破一买低点
                val afterIdx = sg.idx
                val firstLow = sg.price
                for (seg2 in bi) {
                    if (seg2.from < afterIdx) continue
                    if (seg2.dir == "down" && seg2.toPrice > firstLow) {
                        pushPoint(
                            seg2.to, "二买", seg2.toPrice,
                            "回调低点 " + fmt2(seg2.toPrice) + " 未破一买低点 " + fmt2(firstLow),
                            lastBoxAt,
                        )
                        break
                    }
                    if (seg2.dir == "down" && seg2.toPrice <= firstLow) break // 破了就不是二买
                }
            }

            // 三买：价格在最后一个中枢上方，回调不跌回 ZG
            if (sg.type == "buy" && lastBoxAt != null && sg.price > lastBoxAt.zg) {
                pushPoint(
                    sg.idx, "三买", sg.price,
                    "中枢上方回抽不破 ZG=" + fmt2(lastBoxAt.zg) + "，底背驰力度 " + sg.strength,
                    lastBoxAt,
                )
            }

            if (sg.type == "sell" && lastBoxAt != null && sg.price > lastBoxAt.zg) {
                pushPoint(
                    sg.idx, "一卖", sg.price,
                    "上涨笔在中枢上方顶背驰，力度衰减 " + sg.strength + "（中枢 ZG=" + fmt2(lastBoxAt.zg) + "）",
                    lastBoxAt,
                )

                val afterIdx2 = sg.idx
                val firstHigh = sg.price
                for (seg3 in bi) {
                    if (seg3.from < afterIdx2) continue
                    if (seg3.dir == "up" && seg3.toPrice < firstHigh) {
                        pushPoint(
                            seg3.to, "二卖", seg3.toPrice,
                            "反弹高点 " + fmt2(seg3.toPrice) + " 未破一卖高点 " + fmt2(firstHigh),
                            lastBoxAt,
                        )
                        break
                    }
                    if (seg3.dir == "up" && seg3.toPrice >= firstHigh) break
                }
            }

            if (sg.type == "sell" && lastBoxAt != null && sg.price < lastBoxAt.zd) {
                pushPoint(
                    sg.idx, "三卖", sg.price,
                    "中枢下方反抽不上 ZD=" + fmt2(lastBoxAt.zd) + "，顶背驰力度 " + sg.strength,
                    lastBoxAt,
                )
            }
        }

        // 按时间排序、去重（同 idx 同 label 只留一个）
        val seen = HashSet<String>()
        val deduped = points.filter { seen.add(it.idx.toString() + "|" + it.label) }.sortedBy { it.idx }

        val lastBox = boxes.lastOrNull()
        var boxPosition: String? = null
        if (lastBox != null) {
            val cur = b[n - 1].c
            boxPosition = when {
                cur > lastBox.zg -> "中枢上方"
                cur < lastBox.zd -> "中枢下方"
                else -> "中枢内"
            }
        }
        val stats = ChanStats(
            bars = n,
            pens = pens.size,
            boxes = boxes.size,
            errors = res.errors.size,
            lastPen = pens.lastOrNull(),
            lastBox = lastBox,
            boxPosition = boxPosition,
        )

        return ChanResult(
            pens = pens,
            boxes = boxes,
            bi = bi,
            stats = stats,
            signals = signals,
            points = deduped,
            data = D,
            errors = res.errors,
            bars = b,
        )
    }
}