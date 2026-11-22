package io.github.mangi.eta.ui.stock

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.json.JSONTokener

/**
 * AI ↔ K 线面板的双向关联。
 *
 * 这个 App 的 AgentRuntimeService 与界面在同一进程，所以工具的调用线程可以直接看到
 * 这里的静态状态和唯一的 WebView 实例 —— 不需要再走一遍跨进程通信。
 *
 * 页面 → Kotlin：link.js 在就绪、换股、切周期、切股完成时调用
 * `NativeBridge.stockEvent(type, payload)`；这里缓存「面板现在是哪只」，
 * 并放行所有等 `ready` 的阻塞调用（工具就是这么等页面加载完的）。
 *
 * Kotlin → 页面：`StockChartIntent.open/fromText` 负责解析名称 → 切股；
 * 页面没打开或还没加载完时，指令先排队，`ready` 到了再补发。
 */
internal object StockChartLink {
    private val main = Handler(Looper.getMainLooper())

    /** 页面首帧 K 线已经出来（JS 主动上报）。 */
    @Volatile
    private var pageReady = false

    // 用 Compose state 而不是 @Volatile：界面要据此决定面板是不是真有标的，
    // 普通字段改动不会触发重组，位置判断会停在旧值。
    var panelCode by mutableStateOf("")
        private set

    var panelName by mutableStateOf("")
        private set

    var panelPeriod by mutableStateOf("")

    /** 面板当前标的的现价 / 涨跌额 / 涨跌幅（%）。紧凑态顶部行情卡隐藏后，折叠条靠它们显示。 */
    var panelPrice by mutableStateOf<Double?>(null)
    var panelChange by mutableStateOf<Double?>(null)
    var panelPct by mutableStateOf<Double?>(null)
        private set

    /** 面板就绪前要补发的 JS（去重靠内容本身，队列很小）。 */
    private val pending = ConcurrentLinkedQueue<String>()

    /** 等页面回传结果的标签 → 等待者。只给 switch 用。 */
    private val latches = ConcurrentHashMap<String, CountDownLatch>()
    private val results = ConcurrentHashMap<String, String>()

    // ---------------------------------------------------------------- 页面侧事件

    fun onBridgeEvent(type: String, payload: String) {
        val obj = runCatching { JSONTokener(payload).nextValue() as? JSONObject }.getOrNull()
        when (type) {
            "brief", "ready" -> {
                obj?.let(::applyBrief)
                if (type == "ready") {
                    pageReady = true
                    stockDebugLog("page ready code=$panelCode name=$panelName period=$panelPeriod")
                    flushPending()
                }
            }

            "result" -> {
                val tag = obj?.optString("tag").orEmpty()
                if (!tag.startsWith(SWITCH_TAG_PREFIX) && !tag.startsWith(PERIOD_TAG_PREFIX)) {
                    stockDebugLog(
                        "intent result tag=$tag ok=${obj?.optBoolean("ok")} " +
                            "code=${obj?.optString("code")} reason=${obj?.optString("reason")}",
                    )
                    return
                }
                results[tag] = payload
                latches.remove(tag)?.countDown()
            }
        }
    }

    private fun applyBrief(obj: JSONObject) {
        val newCode = obj.optString("code")
        val changed = newCode.isNotBlank() && newCode != panelCode
        panelCode = newCode
        panelName = obj.optString("name")
        panelPeriod = obj.optString("period")
        panelPrice = if (obj.has("price")) obj.optDouble("price").takeIf { it.isFinite() } else null
        panelChange = if (obj.has("change")) obj.optDouble("change").takeIf { it.isFinite() } else null
        panelPct = if (obj.has("pct")) obj.optDouble("pct").takeIf { it.isFinite() } else null
        // 换股后顺手把多级别摘要预热好：模型真要分析时通常已经算完，
        // 免得工具一调用就干等几秒行情接口。
        if (changed) {
            runCatching { StockLevels.prefetch(newCode) }
        }
    }

    /** WebView 被销毁后页面状态全部失效。 */
    fun onPageReleased() {
        pageReady = false
        pending.clear()
        panelCode = ""
        panelName = ""
        panelPeriod = ""
    }

    // ---------------------------------------------------------------- 打开与等待

    /**
     * 确保面板处于展开且页面已就绪。
     *
     * 工具（stock_chart_read / stock_chart_annotate）和本地意图识别都从这里进，
     * 所以「AI 自己要开面板」不需要用户再点胶囊。
     */
    fun ensureReady(timeoutMs: Long = READY_TIMEOUT_MS): Boolean {
        if (stockChartWebView() == null || !StockChartUiState.expanded || StockChartUiState.collapsed) {
            // 折叠态下 AI 要读图/标注时自动展开，让用户看得到那张图；
            // WebView 实例没变，只是从折叠条恢复成完整面板。
            main.post {
                StockChartUiState.expanded = true
                StockChartUiState.collapsed = false
            }
        }
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (pageReady && stockChartWebView() != null) return true
            runCatching { Thread.sleep(70) }
        }
        stockDebugLog("ensureReady timeout ready=$pageReady webview=${stockChartWebView() != null}")
        return false
    }

    // ---------------------------------------------------------------- 读图 / 画图

    /** 读当前图（最后 N 根 + 缠论信号）。面板没打开会先自己打开。 */
    fun snapshot(limit: Int): String? {
        if (!ensureReady()) return null
        val js = "(function(){try{var s=window.StockChartSnapshot&&StockChartSnapshot($limit);" +
            "return s?JSON.stringify(s):null}catch(e){return null}})()"
        val raw = evalSync(js, 4_000) ?: return null
        return runCatching {
            if (raw == "null") null else JSONTokener(raw).nextValue() as? String
        }.getOrNull()
    }

    /** 把标注画上去，返回页面给出的结果字符串（ok / empty / bad-json: …）。 */
    fun annotate(json: String): String? {
        if (!ensureReady()) return null
        val js = "(function(){try{var r=window.StockAnnotate?StockAnnotate.apply(" +
            JSONObject.quote(json) + "):'nopage';return String(r)}catch(e){return 'error:'+(e&&e.message)}})()"
        val raw = evalSync(js, 5_000) ?: return null
        return runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull()
    }

    // ---------------------------------------------------------------- 换股

    /**
     * 用户一发消息就调：从原话里猜股票并切过去，异步、不阻塞。
     *
     * 只在「这句话像在问股票」时才动面板（有 6 位代码，或者有走势/分析/买卖之类的词），
     * 否则连面板都不打开 —— 免得问一句「帮我看看日历」就把 K 线图弹出来。
     * 面板本来就开着时，只用自选名单本地匹配，不联网。
     */
    fun autoSwitchFromText(text: String) {
        if (text.isBlank()) return
        val open = StockChartUiState.expanded
        val stockish = looksLikeStockQuestion(text)
        // 面板没开、这句话也不像在问股票 —— 完全不要动面板，也別让页面去联网找股票。
        // 原来条件是 `open || stockish`，面板开着时任何提问都会触发一次搜索，
        // 日志里那些 reason=not-found 就是「你好」「继续」这类话打出去的。
        if (!open && !stockish) return
        val aggressive = stockish
        if (!open) main.post { StockChartUiState.expanded = true }
        val tag = "auto-" + System.nanoTime()
        postJs(
            "window.StockChartIntent&&StockChartIntent.fromText(" +
                JSONObject.quote(text) + "," + JSONObject.quote(tag) + "," + aggressive + ")",
        )
        // 「看看 30 分钟」「切到日线」这类话，顺便把级别也拨过去
        postJs(
            "window.StockChartIntent&&StockChartIntent.periodFromText(" +
                JSONObject.quote(text) + "," + JSONObject.quote("$tag-p") + ")",
        )
    }

    private fun looksLikeStockQuestion(text: String): Boolean =
        CODE_PATTERN.containsMatchIn(text) || STOCK_HINTS.any { text.contains(it) }

    /** 阻塞版：工具要「先切到这只再读数」，就等页面回传结果。 */
    fun switchTo(token: String, timeoutMs: Long = SWITCH_TIMEOUT_MS): SwitchResult? {
        if (!ensureReady()) return null
        val tag = SWITCH_TAG_PREFIX + System.nanoTime()
        val latch = CountDownLatch(1)
        latches[tag] = latch
        val posted = postJs(
            "window.StockChartIntent&&StockChartIntent.open(" +
                JSONObject.quote(token) + "," + JSONObject.quote(tag) + ")",
            requireReady = false,
        )
        if (!posted) {
            latches.remove(tag)
            return null
        }
        runCatching { latch.await(timeoutMs, TimeUnit.MILLISECONDS) }
        val raw = results.remove(tag)
        latches.remove(tag)
        if (raw == null) {
            stockDebugLog("switch timeout token=$token")
            return null
        }
        val obj = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        return SwitchResult(
            ok = obj.optBoolean("ok"),
            code = obj.optString("code"),
            name = obj.optString("name"),
            reason = obj.optString("reason"),
            switched = obj.optBoolean("switched"),
        )
    }

    data class SwitchResult(
        val ok: Boolean,
        val code: String,
        val name: String,
        val reason: String,
        val switched: Boolean,
    )

    /** 切级别：m5 / m15 / m30 / m60 / day / week / month / minute。 */
    fun switchPeriod(period: String, timeoutMs: Long = SWITCH_TIMEOUT_MS): Boolean {
        val wire = normalizePeriod(period) ?: return false
        if (!ensureReady()) return false
        val tag = PERIOD_TAG_PREFIX + System.nanoTime()
        val latch = CountDownLatch(1)
        latches[tag] = latch
        val posted = postJs(
            "window.StockChartIntent&&StockChartIntent.period(" +
                JSONObject.quote(wire) + "," + JSONObject.quote(tag) + ")",
            requireReady = false,
        )
        if (!posted) {
            latches.remove(tag)
            return false
        }
        runCatching { latch.await(timeoutMs, TimeUnit.MILLISECONDS) }
        val raw = results.remove(tag)
        latches.remove(tag)
        val obj = raw?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return false
        if (obj.optBoolean("ok")) panelPeriod = obj.optString("period", wire)
        stockDebugLog("period $wire ok=${obj.optBoolean("ok")} reason=${obj.optString("reason")}")
        return obj.optBoolean("ok")
    }

    /** 模型可能写成 30分钟 / 30m / m30 / 30min，统一成页面认的 wire 值。 */
    /**
     * 超紧凑模式开关。
     *
     * 面板被拖到很矮、只剩主图那么高时，顶部那几行（行情卡 / 周期条 / 指标条）
     * 会把本来就不多的图高再吃掉一截。打开后由 chart-lite.js 把它们隐藏，
     * 股票名称 / 周期 / 涨跌幅仍在 Kotlin 侧的折叠条上，信息不丢。
     */
    fun setCompact(on: Boolean) {
        postJs("(function(){try{window.__setChartCompact&&window.__setChartCompact($on);}catch(e){}})()")
    }

    fun normalizePeriod(raw: String): String? {
        val t = raw.trim().lowercase().replace(" ", "")
        if (t.isEmpty()) return null
        PERIOD_ALIASES[t]?.let { return it }
        // 「30分钟K线」这类带后缀的写法：取出前导数字再判一次
        val digits = t.takeWhile { it.isDigit() }
        if (digits.isNotEmpty()) return PERIOD_ALIASES["${digits}m"] ?: PERIOD_ALIASES["${digits}分"]
        return null
    }

    // ---------------------------------------------------------------- 对话框上下文

    /**
     * 每一轮送给模型的「面板状态」。
     *
     * 只挂在当前用户消息的元数据上（投影到 Provider 请求），不落会话、不进食屏，
     * 也不进系统提示 —— 系统提示一变，整段历史缓存就废了。
     */
    fun contextLine(): String {
        val code = panelCode
        val state = if (code.isBlank()) {
            "当前没有可用的股票图（面板还没加载出数据）。"
        } else {
            "当前面板是 ${panelName.ifBlank { "未命名" }}（$code），周期${periodLabel(panelPeriod)}。"
        }
        return buildString {
            append("[K线面板] ").append(state)
            append("规则：用户问某只股票的走势、能不能买、让我分析时，先调用 stock_chart_read 读图，它会自动把面板打开。")
            append("用户原话点名了股票，就用参数 symbol 传名称或代码，它会先切到那只股票再返回数据；")
            append("用户没点名、只说“它/这只/现在怎么走”时，默认就是面板当前这只，不要自己另猜代码。")
            append("要看别的级别就在 stock_chart_read 里传 period（5m/15m/30m/60m/day/week/month），它会切过去再读；")
            append("做多级别共振时按顺序读几个级别（例如 30m → 60m → day），别只看一个级别就下结论；")
            append("回答里如果给了价位、支撑压力、背驰或买卖点，最后用 stock_chart_annotate 画到图上；")
            append("没画成功就说没画成，不要声称“已标注”。")
        }
    }

    private fun periodLabel(period: String): String = when (period) {
        "day" -> "日线"
        "week" -> "周线"
        "month" -> "月线"
        "minute" -> "分时"
        "m5" -> "5分钟"
        "m15" -> "15分钟"
        "m30" -> "30分钟"
        "m60" -> "60分钟"
        else -> period.ifBlank { "日线" }
    }

    // ---------------------------------------------------------------- 底层执行

    private fun postJs(js: String, requireReady: Boolean = true): Boolean {
        if (requireReady && !pageReady) {
            pending.add(js)
            return true
        }
        val wv = stockChartWebView()
        if (wv == null) {
            pending.add(js)
            return false
        }
        main.post {
            runCatching { wv.evaluateJavascript(js, null) }
                .onFailure { stockDebugLog("eval failed: ${it.message}") }
        }
        return true
    }

    private fun flushPending() {
        while (true) {
            val js = pending.poll() ?: break
            val wv = stockChartWebView() ?: run { pending.add(js); break }
            main.post {
                runCatching { wv.evaluateJavascript(js, null) }
                    .onFailure { stockDebugLog("flush eval failed: ${it.message}") }
            }
        }
    }

    private fun evalSync(js: String, timeoutMs: Long): String? {
        val wv = stockChartWebView() ?: return null
        val latch = CountDownLatch(1)
        var out: String? = null
        wv.post {
            try {
                wv.evaluateJavascript(js) { raw ->
                    out = raw
                    latch.countDown()
                }
            } catch (t: Throwable) {
                stockDebugLog("eval sync failed: ${t.message}")
                latch.countDown()
            }
        }
        runCatching { latch.await(timeoutMs, TimeUnit.MILLISECONDS) }
        return out
    }

    private const val SWITCH_TAG_PREFIX = "sw-"
    private const val PERIOD_TAG_PREFIX = "pd-"
    private const val READY_TIMEOUT_MS = 9_000L
    private const val SWITCH_TIMEOUT_MS = 9_000L

    /** 页面周期按钮的 data-p 值 → 各种常见叫法。 */
    private val PERIOD_ALIASES: Map<String, String> = buildMap {
        listOf("m5", "5m", "5min", "5分", "5分钟", "五分钟").forEach { put(it, "m5") }
        listOf("m15", "15m", "15min", "15分", "15分钟", "十五分钟").forEach { put(it, "m15") }
        listOf("m30", "30m", "30min", "30分", "30分钟", "半小时").forEach { put(it, "m30") }
        listOf("m60", "60m", "60min", "60分", "60分钟", "1h", "1小时", "一小时").forEach { put(it, "m60") }
        listOf("day", "d", "1d", "日", "日线", "日k", "daily").forEach { put(it, "day") }
        listOf("week", "w", "周", "周线", "周k", "weekly").forEach { put(it, "week") }
        listOf("month", "mo", "月", "月线", "月k", "monthly").forEach { put(it, "month") }
        listOf("minute", "min", "分时", "日内", "time").forEach { put(it, "minute") }
    }

    private val CODE_PATTERN = Regex("(?<!\\d)\\d{6}(?!\\d)")

    /** 出现这些词就认为用户在问股票，值得联网解析一次名称。 */
    private val STOCK_HINTS = listOf(
        "股票", "个股", "股价", "走势", "行情", "大盘", "分时", "日线", "周线", "月线",
        "涨停", "跌停", "收盘", "开盘", "加仓", "减仓", "持仓", "被套", "止盈", "止损",
        "买点", "卖点", "支撑", "压力", "背驰", "缠论", "分析一下", "帮我分析", "能不能买", "该买",
    )
}