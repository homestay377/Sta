package io.github.mangi.eta.ui.stock

import android.content.Context
import io.github.mangi.eta.chan.Bar
import io.github.mangi.eta.chan.ChanJson
import io.github.mangi.eta.chan.ChanSummary
import io.github.mangi.eta.chan.Chanlun

/**
 * 缠论结果的**原生入口**。这条链路是完整的：
 *
 * ```
 * 取数 StockKlineSource.fetch  →  缠论 Chanlun.analyze  →  ChanJson（与 JS 同构）
 * ```
 *
 * 前端（`assets/stock/`）原来调 `Chan.analyze(bars, CHAN_FORMULA)`，现在可以直接换成
 * 桥上的 `chanCalc(barsJson, viewStart)`，拿到的 JSON 字段与原来一字不差，
 * `chart.js` / `tools.js` / `app.js` 都不需要改结构。
 *
 * ## 两条硬约定（踩过的坑，别改）
 * 1. **必须喂全历史**：`count` 用 [DEFAULT_BARS]（640，腾讯日线上限），不要用 300/500。
 *    窗口太短时 `BARSLAST/SUMBARS/BACKSET` 在序列左端没有历史，会凭空造出中枢。
 *    实测 300274：只喂 270 根会多一个 `绿[1-46]` 伪框，通达信按全历史算没有它。
 * 2. **渲染时用 `viewStart` 过滤**：计算仍在全量上做，只丢掉整体落在可视窗口左侧的框。
 */
object StockChanSource {

    /** 取多少根。腾讯 fqkline 日线上限就是 640，再多也拿不到。 */
    const val DEFAULT_BARS = 640

    private const val FORMULA_ASSET = "stock/chan_formula.txt"

    @Volatile
    private var formulaCache: String? = null

    /** 读 `assets/stock/chan_formula.txt`（与 JS 侧 `window.CHAN_FORMULA` 同一份原文）。 */
    fun formula(context: Context): String {
        formulaCache?.let { return it }
        val text = context.assets.open(FORMULA_ASSET).bufferedReader(Charsets.UTF_8).use { it.readText() }
        formulaCache = text
        return text
    }

    /**
     * 纯计算入口（无网络、可同步调用）：K 线 JSON → 缠论 JSON。
     *
     * 入参 K 线可以是前端原样 `JSON.stringify(S.kl)` 的结果，两种字段名都认：
     * `{t,o,h,l,c,v}`（前端）或 `{time,open,high,low,close,volume}`（原生）。
     *
     * @param viewStart 可视窗口起点；0 表示不裁剪中枢。
     */
    fun analyzeBars(barsJson: String, formulaText: String, viewStart: Int = 0): String {
        val bars = parseBars(barsJson)
        return ChanJson.of(Chanlun.analyze(bars, formulaText, viewStart = viewStart))
    }

    /**
     * 取数 + 计算（网络，别在主线程调）。给 Agent 工具/原生面板用。
     *
     * @param count 默认 640；**不要传 300/500**，见类注释第 1 条。
     */
    fun analyze(
        context: Context,
        code: String,
        period: String,
        count: Int = DEFAULT_BARS,
        viewStart: Int = 0,
    ): String {
        val r = StockKlineSource.fetch(code, period, count)
        if (!r.ok) {
            return "{\"pens\":[],\"boxes\":[],\"bi\":[],\"signals\":[],\"points\":[]," +
                "\"stats\":{\"bars\":0,\"pens\":0,\"boxes\":0,\"errors\":1,\"boxPosition\":null}," +
                "\"errors\":[{\"line\":0,\"text\":\"\",\"err\":" + quote(r.error ?: "取数失败") + "}]}"
        }
        val bars = r.bars.map {
            Bar(o = it.open, h = it.high, l = it.low, c = it.close, v = it.volume, t = it.time)
        }
        return ChanJson.of(Chanlun.analyze(bars, formula(context), viewStart = viewStart))
    }

    /**
     * **原生自主取数**入口：自己拉 K 线、自己算、自己渲染成文本。
     *
     * 与 [analyzeBars] 的区别：这个方法不依赖 WebView、不依赖面板是否展开，
     * 也不依赖前端有没有把 `S.kl` 传过来。AI 想直接问「300274 日线有几个中枢」
     * 时走这条，不需要先把面板切过去。
     *
     * 网络调用，**别在主线程调**。
     *
     * @return 成功时是给模型读的中文摘要；取数失败时返回以「取数失败：」开头的说明。
     */
    fun analyzeText(
        context: Context,
        code: String,
        period: String,
        count: Int = DEFAULT_BARS,
    ): String {
        val normalized = StockKlineSource.validPeriod(period)
            ?: return "取数失败：不支持的级别「$period」（可用 minute/5m/15m/30m/60m/day/week/month）"
        val r = StockKlineSource.fetch(code, normalized, count)
        if (!r.ok) {
            return "取数失败：" + (r.error?.takeIf { it.isNotBlank() } ?: "所有行情源都没返回数据") +
                "。不要凭空推断这只股票的走势。"
        }
        val bars = r.bars.map {
            Bar(o = it.open, h = it.high, l = it.low, c = it.close, v = it.volume, t = it.time)
        }
        val result = Chanlun.analyze(bars, formula(context))
        return ChanSummary.of(result, code.uppercase(), periodLabel(normalized))
    }

    /** 级别中文名，仅用于摘要文本首行。 */
    fun periodLabel(period: String): String = when (period) {
        "minute" -> "分时"
        "5m" -> "5分钟"
        "15m" -> "15分钟"
        "30m" -> "30分钟"
        "60m" -> "60分钟"
        "week" -> "周线"
        "month" -> "月线"
        else -> "日线"
    }

    /** 解析 K 线 JSON（实现放在 [ChanJson.parseBars]，那里不依赖 Android，单测可直接跑）。 */
    fun parseBars(barsJson: String): List<Bar> = ChanJson.parseBars(barsJson)

    private fun quote(s: String): String = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}