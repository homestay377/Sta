package io.github.mangi.eta.ui.stock

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset
import java.util.zip.GZIPInputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * 原生 K 线取数（不经过 WebView）。
 *
 * 为什么单独抽出来：AI 要看多个级别时，如果只能走「把面板切到某级别 → 从页面读回来」，
 * 就会既慢又闪，而且面板没开就完全取不到数。行情本来就是 App 自己的接口，
 * 与「当前显示哪个级别」毫无关系，所以这里独立成一份，工具和面板共用同一条路径。
 *
 * 数据源顺序与你原来的问股一致（腾讯双域名 → 东财 → 新浪），逐级降级，
 * 解析口径也照搬，避免出现两套行为不同的实现。
 *
 * 只用原生 HTTP，不需要 Context，因此可以在任意线程调用。
 */
internal object StockKlineSource {

    private const val CONNECT_TIMEOUT_MS = 8000
    private const val READ_TIMEOUT_MS = 12000
    private const val RETRY_TIMES = 2
    private const val RETRY_BACKOFF_MS = 300L
    /**
     * 缠论等「需要往前有历史」的公式应取的根数。
     *
     * 别用 300/500：BARSLAST/SUMBARS/BACKSET 在序列左端没有历史时，
     * 会算出并不存在的「起中枢」，图上表现为窗口最左沿凭空多一个框。
     * 腾讯 fqkline 日线上限就是 640，再多也拿不到。
     */
    const val CHAN_BARS = 640
    private const val BUFFER_SIZE = 8192

    private val UTF8: Charset = Charsets.UTF_8

    private val TENCENT_HOSTS = arrayOf(
        "https://web.ifzq.gtimg.cn",
        "https://ifzq.gtimg.cn",
    )

    private val PERIODS = arrayOf("minute", "m1", "m5", "m15", "m30", "m60", "day", "week", "month")

    /** 一根 K 线。time 保留各数据源的原始时间字符串（日线 2026-11-12，分钟 2026-11-12 10:30）。 */
    data class Bar(
        val time: String,
        val open: Double,
        val high: Double,
        val low: Double,
        val close: Double,
        val volume: Double,
    )

    data class Result(
        val bars: List<Bar>,
        val error: String? = null,
    ) {
        val ok: Boolean get() = bars.isNotEmpty()
    }

    fun validPeriod(p: String?): String? {
        val t = p?.trim()?.lowercase() ?: return null
        return PERIODS.firstOrNull { it == t }
    }

    fun isMinutePeriod(period: String?): Boolean = period?.startsWith("m") == true

    /**
     * 是否属于境外品种（美股个股 / 美股指数 / 伦敦金）。
     *
     * 判定只看**形态**，不查表：A 股代码一定是纯数字或 sh/sz/bj + 数字，
     * 所以「us 前缀」或「纯字母」可以安全地判为境外品种，不会误伤 A 股。
     */
    fun isGlobalCode(code: String?): Boolean {
        val t = code?.trim()?.lowercase() ?: return false
        if (t.isEmpty()) return false
        if (t == "xau" || t == "xag") return true
        if (t.startsWith("us")) return true
        // 纯字母（1~5 位）按美股代码处理
        if (t.matches(Regex("[a-z]{1,5}"))) return true
        // ★ 中文别名（纳指 / 伦敦金 / 道指 / 标普）必须也认，
        //   否则用户说「看看纳指」会被当成非法 A 股代码直接拒掉。
        return StockGlobalSource.resolve(t) != null
    }

    /**
     * 归一化代码：6 位纯数字补 A 股前缀；境外品种（usAAPL / us.IXIC / XAU）原样保留。
     * 失败返回 null。
     */
    fun normalizeCode(raw: String?): String? {
        val t = raw?.trim()?.lowercase() ?: return null
        if (t.isEmpty()) return null
        // 境外品种先判：us 开头或贵金属代码，交给 StockGlobalSource
        if (isGlobalCode(t)) return StockGlobalSource.resolve(t) ?: t
        if (t.matches(Regex("[a-z]{2}\\d{6}"))) return t
        if (t.matches(Regex("\\d{6}"))) {
            // 6 开头沪市，5 开头沪市基金/ETF，其余深市
            return if (t.startsWith("6") || t.startsWith("5") || t.startsWith("9")) "sh$t" else "sz$t"
        }
        return null
    }

    data class Symbol(val code: String, val name: String)

    /**
     * 按名称或代码解析股票。先当代码处理，不行再走腾讯搜索接口。
     *
     * 返回 null 表示确实找不到 —— 调用方应当明确告诉模型「搜不到」，
     * 而不是退回面板当前股票，否则模型会把别的股票的数据当这只讲。
     */
    fun resolve(token: String): Symbol? {
        val t = token.trim()
        if (t.isEmpty()) return null
        // 境外品种（纳指 / 伦敦金 / usAAPL）优先：这些名称走 A 股搜索接口找不到
        StockGlobalSource.resolve(t)?.let { return Symbol(it, StockGlobalSource.displayName(it)) }
        normalizeCode(t)?.let { return Symbol(it, "") }
        // 名称搜索
        val r = try {
            httpGet(
                "https://smartbox.gtimg.cn/s3/?v=2&q=" +
                    java.net.URLEncoder.encode(t, "UTF-8") + "&t=all",
                Charset.forName("GBK"),
                "https://gu.qq.com/",
            )
        } catch (_: Throwable) {
            null
        }
        val body = r?.body ?: return null
        // 形如 v_hint="sz~300274~阳光电源~ygdy~GP-A^sh~600519~贵州茅台~..."
        val m = Regex("v_hint=\"(.*)\"").find(body) ?: return null
        val first = m.groupValues[1].split("^").firstOrNull() ?: return null
        val f = first.split("~")
        if (f.size < 3) return null
        val market = f[0].lowercase()
        val num = f[1]
        val name = f[2]
        if (!num.matches(Regex("\\d{6}"))) return null
        return Symbol(market + num, name)
    }

    /**
     * 拉取一只股票某个级别的 K 线。
     *
     * 逐源降级：腾讯1 → 腾讯2 → 东财 → 新浪。任一家返回可解析的非空数据就立刻返回，
     * 全部失败时把每一家的失败原因拼进 error，方便日志定位（不要只报「失败了」）。
     */
    fun fetch(code: String, period: String, count: Int): Result {
        val c = code.lowercase()
        // ★ 境外品种（美股 / 纳指等指数 / 伦敦金）走独立取数链路。
        //   放在最前面判断，A 股那条路一行不动，避免影响已经验证过的行情逻辑。
        if (isGlobalCode(c)) {
            return StockGlobalSource.fetch(c, period, count)
        }
        val n = count.coerceIn(1, 3000)
        val errs = StringBuilder()

        for ((i, host) in TENCENT_HOSTS.withIndex()) {
            val path = if (isMinutePeriod(period)) {
                "/appstock/app/kline/mkline?param=$c,$period,,$n"
            } else {
                "/appstock/app/fqkline/get?param=$c,$period,,,$n,qfq"
            }
            val r = httpGet(host + path, UTF8, "https://gu.qq.com/")
            val body = r.body
            if (r.err == null && body != null && body.trim().startsWith("{")) {
                val bars = tencentBars(body, c, period)
                if (bars.isNotEmpty()) return Result(bars)
            }
            errs.append("腾讯").append(i + 1).append("(").append(r.err ?: "非K线").append(") ")
        }

        try {
            val url = "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
                "?secid=" + emSecid(c) +
                "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56" +
                "&klt=" + emKlt(period) + "&fqt=1&end=20500101&lmt=$n"
            val r = httpGet(url, UTF8, "https://quote.eastmoney.com/")
            val body = r.body
            if (r.err == null && body != null && body.trim().startsWith("{")) {
                val bars = eastmoneyBars(body, period)
                if (bars.isNotEmpty()) return Result(bars)
            }
            errs.append("东财(").append(r.err ?: "空").append(") ")
        } catch (_: Throwable) {
            errs.append("东财(异常) ")
        }

        try {
            val url = "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/" +
                "CN_MarketData.getKLineData?symbol=" + c +
                "&scale=" + sinaScale(period) + "&ma=5&datalen=$n"
            val r = httpGet(url, UTF8, "https://finance.sina.com.cn/")
            val body = r.body
            if (r.err == null && body != null && body.trim().startsWith("[")) {
                val bars = sinaBars(body, period)
                if (bars.isNotEmpty()) return Result(bars)
            }
            errs.append("新浪(").append(r.err ?: "空").append(") ")
        } catch (_: Throwable) {
            errs.append("新浪(异常) ")
        }

        return Result(emptyList(), errs.toString().trim().ifEmpty { "所有数据源都没有返回数据" })
    }

    // ==================== 各源解析 ====================

    private fun tencentBars(body: String, code: String, period: String): List<Bar> {
        val out = ArrayList<Bar>()
        try {
            val data = JSONObject(body).optJSONObject("data") ?: return out
            val node = data.optJSONObject(code) ?: return out
            var rows = if (isMinutePeriod(period)) node.optJSONArray(period) else node.optJSONArray("qfq$period")
            if (rows == null) rows = node.optJSONArray(period)
            if (rows == null) return out
            for (i in 0 until rows.length()) {
                val r = rows.optJSONArray(i) ?: continue
                if (r.length() < 6) continue
                out.add(
                    Bar(
                        time = r.optString(0),
                        open = r.optDouble(1, Double.NaN),
                        close = r.optDouble(2, Double.NaN),
                        high = r.optDouble(3, Double.NaN),
                        low = r.optDouble(4, Double.NaN),
                        volume = r.optDouble(5, 0.0),
                    ),
                )
            }
        } catch (_: Throwable) {
        }
        return out.filter { it.open.isFinite() && it.close.isFinite() }
    }

    private fun eastmoneyBars(body: String, period: String): List<Bar> {
        val out = ArrayList<Bar>()
        try {
            val data = JSONObject(body).optJSONObject("data") ?: return out
            val kl = data.optJSONArray("klines") ?: return out
            for (i in 0 until kl.length()) {
                val line = kl.optString(i)
                if (line.isEmpty()) continue
                val f = line.split(",")
                if (f.size < 6) continue
                var time = f[0]
                if (isMinutePeriod(period)) {
                    time = time.replace("-", "").replace(" ", "").replace(":", "")
                }
                val open = f[1].toDoubleOrNull() ?: continue
                val close = f[2].toDoubleOrNull() ?: continue
                val high = f[3].toDoubleOrNull() ?: continue
                val low = f[4].toDoubleOrNull() ?: continue
                val vol = f[5].toDoubleOrNull() ?: 0.0
                out.add(Bar(time, open, high, low, close, vol))
            }
        } catch (_: Throwable) {
        }
        return out
    }

    private fun sinaBars(body: String, period: String): List<Bar> {
        val out = ArrayList<Bar>()
        try {
            val b = body.trim()
            if (b.startsWith("{")) return out
            val arr = JSONArray(b)
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val day = o.optString("day")
                val time = if (isMinutePeriod(period)) {
                    day.replace("-", "").replace(" ", "").replace(":", "")
                } else {
                    if (day.length > 10) day.substring(0, 10) else day
                }
                val open = o.optDouble("open", Double.NaN)
                val close = o.optDouble("close", Double.NaN)
                val high = o.optDouble("high", Double.NaN)
                val low = o.optDouble("low", Double.NaN)
                if (!open.isFinite() || !close.isFinite()) continue
                // 新浪给的是股数，与腾讯的「手」对齐
                val vol = o.optDouble("volume", 0.0) / 100.0
                out.add(Bar(time, open, high, low, close, vol))
            }
        } catch (_: Throwable) {
        }
        return out
    }

    // ==================== 各源参数换算 ====================

    private fun emSecid(code: String): String {
        val c = code.lowercase()
        val num = c.replace(Regex("^[a-z]+"), "")
        return when {
            c.startsWith("sh") -> "1.$num"
            c.startsWith("sz") -> "0.$num"
            c.startsWith("bj") -> "0.$num"
            num.startsWith("6") || num.startsWith("5") -> "1.$num"
            else -> "0.$num"
        }
    }

    private fun emKlt(period: String): String = when {
        period == "week" -> "102"
        period == "month" -> "103"
        isMinutePeriod(period) -> period.substring(1)
        else -> "101"
    }

    private fun sinaScale(period: String): String = when {
        period == "week" -> "1200"
        period == "month" -> "7200"
        isMinutePeriod(period) -> period.substring(1)
        else -> "240"
    }

    // ==================== HTTP ====================

    private class Resp {
        var code: Int = 0
        var body: String? = null
        var err: String? = null
    }

    private fun httpGet(url: String, cs: Charset, referer: String?): Resp {
        var r: Resp? = null
        var attempt = 0
        while (attempt <= RETRY_TIMES) {
            r = request(url, cs, referer)
            if (r.err == null) return r
            if (attempt < RETRY_TIMES) {
                try {
                    Thread.sleep(RETRY_BACKOFF_MS * (attempt + 1))
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
            attempt++
        }
        return r!!
    }

    private fun request(urlStr: String, respCharset: Charset, referer: String?): Resp {
        val r = Resp()
        var c: HttpURLConnection? = null
        var input: InputStream? = null
        try {
            c = URL(urlStr).openConnection() as HttpURLConnection
            c.requestMethod = "GET"
            c.connectTimeout = CONNECT_TIMEOUT_MS
            c.readTimeout = READ_TIMEOUT_MS
            c.instanceFollowRedirects = true
            c.setRequestProperty(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/120.0.0.0 Mobile Safari/537.36",
            )
            c.setRequestProperty("Accept", "*/*")
            c.setRequestProperty("Accept-Encoding", "gzip")
            if (referer != null) c.setRequestProperty("Referer", referer)
            r.code = c.responseCode
            if (r.code !in 200..299) {
                r.err = "HTTP " + r.code
                return r
            }
            input = c.inputStream
            val enc = c.contentEncoding
            if (enc != null && enc.contains("gzip", ignoreCase = true)) {
                input = GZIPInputStream(input, BUFFER_SIZE)
            }
            val bo = ByteArrayOutputStream(BUFFER_SIZE)
            val buf = ByteArray(BUFFER_SIZE)
            while (true) {
                val len = input.read(buf)
                if (len <= 0) break
                bo.write(buf, 0, len)
            }
            r.body = String(bo.toByteArray(), respCharset)
        } catch (t: Throwable) {
            r.err = t.javaClass.simpleName + (t.message?.let { ": " + it.take(80) } ?: "")
        } finally {
            try {
                input?.close()
            } catch (_: Throwable) {
            }
            try {
                c?.disconnect()
            } catch (_: Throwable) {
            }
        }
        return r
    }
}
