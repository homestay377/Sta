package io.github.mangi.eta.ui.stock

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset
import java.util.zip.GZIPInputStream

/**
 * 非 A 股品种的行情：美股 / 港美股指数 / 伦敦金。
 *
 * ## 为什么单独一个类
 * [StockKlineSource] 的 `normalizeCode` 只认 A 股 6 位码，把 `usAAPL` 当非法输入。
 * 与其在一个已经稳定的取数链路里到处加分支，不如把「境外品种」隔离出来，
 * 由 [MarketSymbols] 统一分发——A 股那条路一行不改。
 *
 * ## 各品种的接口与口径（均已实测）
 *
 * | 品种 | 代码示例 | 数据源 | 备注 |
 * |---|---|---|---|
 * | 美股个股 | `usAAPL`、`usTSLA` | 腾讯 `fqkline` | 带成交量，前复权 |
 * | 美股指数 | `us.IXIC`（纳指）、`us.NDX`（纳指100）、`us.DJI`（道指） | 腾讯 `fqkline` | 带成交量 |
 * | 伦敦金 | `XAU` | 新浪外盘 `GlobalFuturesService` | **成交量为 0**（现货报价无成交量） |
 *
 * ## 两点与 A 股不同的实情
 * 1. **交易时段不同**：美股北京时间夜间，伦敦金近乎 24 小时。同一时刻「最后一根 K 线」
 *    可能还没走完，中枢右边界会随收盘变化。这与 A 股盘中情形同理，只是更明显。
 * 2. **伦敦金没有成交量**：VOL 指标、量价关系对它不适用，算出来是 0。
 *    缠论本身只用价格，不受影响。
 */
internal object StockGlobalSource {

    private const val UA =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Mobile Safari/537.36"
    private const val CONNECT_MS = 8000
    private const val READ_MS = 15000

    private const val TX_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
    private const val SINA_KLINE =
        "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_x=/" +
            "GlobalFuturesService.getGlobalFuturesDailyKLine"

    /** 境外品种的别名表：用户怎么说 → 标准代码。 */
    private val ALIASES: Map<String, String> = buildMap {
        // 纳指
        put("纳指", "us.IXIC")
        put("纳斯达克", "us.IXIC")
        put("纳斯达克指数", "us.IXIC")
        put("nasdaq", "us.IXIC")
        put("ixic", "us.IXIC")
        put("纳指100", "us.NDX")
        put("纳斯达克100", "us.NDX")
        put("ndx", "us.NDX")
        // 美股其他指数
        put("道指", "us.DJI")
        put("道琼斯", "us.DJI")
        put("dji", "us.DJI")
        put("标普", "us.INX")
        put("标普500", "us.INX")
        put("s&p", "us.INX")
        put("inx", "us.INX")
        // 贵金属
        put("伦敦金", "XAU")
        put("现货黄金", "XAU")
        // ★ 不收「黄金」「白银」这种短别名：A股有山东黄金/中金黄金/白银有色，
        //   用户说「黄金」大概率是想查黄金股。要商品就说明确的「伦敦金/现货黄金」。
        put("xau", "XAU")
        put("gold", "XAU")
        put("伦敦银", "XAG")
        put("现货白银", "XAG")
        put("xag", "XAG")
    }

    /** 中文显示名，用于输出。 */
    fun displayName(code: String): String = when (code.uppercase()) {
        "US.IXIC" -> "纳斯达克综合指数"
        "US.NDX" -> "纳斯达克100"
        "US.DJI" -> "道琼斯工业指数"
        "US.INX" -> "标普500"
        "XAU" -> "伦敦金（美元/盎司）"
        "XAG" -> "伦敦银（美元/盎司）"
        else -> {
            val up = code.uppercase()
            when {
                up.startsWith("US.") -> up.removePrefix("US.")
                // usAAPL -> AAPL（美股代码）；个股不硬编码中文名，避免维护一大堆映射
                up.startsWith("US") -> up.removePrefix("US")
                else -> up
            }
        }
    }

    /**
     * 按关键词搜境外品种，给搜索框补 A 股以外的结果。
     *
     * smartbox 只认 A 股，用户输「伦敦金」「纳指」什么都搜不到，
     * 面板也就切不过去。这里在 smartbox 结果前面插上匹配的境外品种。
     *
     * 返回 `code~name` 的列表（code 是标准代码，name 是中文显示名）。
     */
    fun search(keyword: String): List<Pair<String, String>> {
        val kw = keyword.trim().lowercase()
        if (kw.isEmpty()) return emptyList()
        val hits = LinkedHashMap<String, String>()   // code -> 显示名，去重且保序
        // 1) 别名命中（含前缀匹配：「伦」也能搜到伦敦金）
        for ((alias, code) in ALIASES) {
            if (alias.contains(kw) || kw.contains(alias)) {
                hits.putIfAbsent(code, displayName(code))
            }
        }
        // 2) 标准代码本身命中（xau / us.ixic / aapl）
        resolve(keyword)?.let { hits.putIfAbsent(it, displayName(it)) }
        return hits.entries.map { it.key to it.value }
    }

    /**
     * 判断一个输入是否属于境外品种，并返回标准代码。
     *
     * 认三种写法：
     *  - 别名：`纳指`、`伦敦金`、`道指`、`标普`
     *  - 带 us 前缀：`usAAPL`、`us.IXIC`
     *  - 裸美股代码：`AAPL`（长度 1~5 个字母且全大写时）
     */
    fun resolve(token: String): String? {
        val t = token.trim()
        if (t.isEmpty()) return null

        ALIASES[t.lowercase()]?.let { return it }

        // usAAPL / us.IXIC / usNDX
        // ★ 原实现剥掉点号后再判断「有没有点」，导致 us.TSLA 被当成 usTSLA。
        //   正确做法：先记住有没有点，再决定后缀怎么拼。
        val low = t.lowercase()
        if (low.startsWith("us")) {
            val hadDot = low.removePrefix("us").startsWith(".")
            val body = low.removePrefix("us").removePrefix(".")
            if (body.isNotEmpty() && body.matches(Regex("[a-z.]+"))) {
                return if (hadDot || body.contains('.')) "us." + body.uppercase() else "us" + body.uppercase()
            }
        }

        // 裸美股代码：纯字母、1~5 位。A 股代码是数字，不会误判。
        if (t.matches(Regex("[A-Za-z]{1,5}"))) {
            return "us" + t.uppercase()
        }
        return null
    }

    /**
     * 取境外品种的 K 线。
     *
     * @param code [resolve] 返回的标准代码
     * @param period 只支持 day / week / month；分钟级境外源不稳定，暂不支持
     */
    fun fetch(code: String, period: String, count: Int): StockKlineSource.Result {
        val n = count.coerceIn(1, 2000)
        return if (code.uppercase() == "XAU" || code.uppercase() == "XAG") {
            sinaGlobal(code.uppercase(), n)
        } else {
            tencentUs(code, period, n)
        }
    }

    // ------------------------------------------------------------------ 腾讯美股

    private fun tencentUs(code: String, period: String, n: Int): StockKlineSource.Result {
        // 腾讯美股 K 线只有日/周/月，分钟级没有稳定接口
        val p = when (period) {
            "week", "month" -> period
            else -> "day"
        }
        val url = "$TX_KLINE?param=$code,$p,,,$n,qfq"
        val body = get(url, Charsets.UTF_8, "https://gu.qq.com/")
            ?: return StockKlineSource.Result(emptyList(), "腾讯美股接口无响应")
        val root = runCatching { JSONObject(body) }.getOrNull()
            ?: return StockKlineSource.Result(emptyList(), "腾讯美股返回非 JSON")
        val node = root.optJSONObject("data")?.optJSONObject(code)
            ?: return StockKlineSource.Result(emptyList(), "腾讯美股无此代码：$code")

        val arr = node.optJSONArray(p)
            ?: node.optJSONArray("qfq$p")
            ?: return StockKlineSource.Result(emptyList(), "腾讯美股无 K 线数据")
        val out = parseTencentRows(arr)
        return if (out.isEmpty()) {
            StockKlineSource.Result(emptyList(), "腾讯美股 K 线为空")
        } else {
            StockKlineSource.Result(out.takeLast(n))
        }
    }

    /** 腾讯行格式：[日期, 开, 收, 高, 低, 量]。注意顺序是**开收高低**，不是开高低收。 */
    private fun parseTencentRows(arr: JSONArray): List<StockKlineSource.Bar> {
        val out = ArrayList<StockKlineSource.Bar>(arr.length())
        for (i in 0 until arr.length()) {
            val r = arr.optJSONArray(i) ?: continue
            if (r.length() < 5) continue
            val d = r.optString(0)
            fun v(k: Int): Double = r.optString(k).toDoubleOrNull() ?: Double.NaN
            val o = v(1); val c = v(2); val h = v(3); val l = v(4)
            if (o.isNaN() || c.isNaN() || h.isNaN() || l.isNaN()) continue
            val vol = if (r.length() > 5) (r.optString(5).toDoubleOrNull() ?: 0.0) else 0.0
            out.add(StockKlineSource.Bar(d, o, h, l, c, vol))
        }
        return out
    }

    // ------------------------------------------------------------------ 新浪外盘

    private fun sinaGlobal(code: String, n: Int): StockKlineSource.Result {
        // ★ 用动态时间戳：那个 `_` 参数是防缓存用的，写死日期将来可能被 CDN 缓存住，
        //   导致金价停在某个历史时点。用当前时间毫秒保证每次拿最新报价。
        val url = "$SINA_KLINE?symbol=$code&_=${System.currentTimeMillis()}"
        val body = get(url, Charsets.UTF_8, "https://finance.sina.com.cn/")
            ?: return StockKlineSource.Result(emptyList(), "新浪外盘接口无响应")
        // 返回形如：var _x=([{...},{...}]);
        val start = body.indexOf('(')
        val end = body.lastIndexOf(')')
        if (start < 0 || end <= start) {
            return StockKlineSource.Result(emptyList(), "新浪外盘返回格式异常")
        }
        val arr = runCatching { JSONArray(body.substring(start + 1, end)) }.getOrNull()
            ?: return StockKlineSource.Result(emptyList(), "新浪外盘 JSON 解析失败")
        val out = ArrayList<StockKlineSource.Bar>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val d = o.optString("date")
            val op = o.optString("open").toDoubleOrNull() ?: continue
            val hi = o.optString("high").toDoubleOrNull() ?: continue
            val lo = o.optString("low").toDoubleOrNull() ?: continue
            val cl = o.optString("close").toDoubleOrNull() ?: continue
            // 现货报价的 volume 恒为 0，这是数据本身如此，不是解析问题
            val vol = o.optString("volume").toDoubleOrNull() ?: 0.0
            out.add(StockKlineSource.Bar(d, op, hi, lo, cl, vol))
        }
        return if (out.isEmpty()) {
            StockKlineSource.Result(emptyList(), "新浪外盘 K 线为空")
        } else {
            StockKlineSource.Result(out.takeLast(n))
        }
    }

    // ------------------------------------------------------------------ HTTP

    private fun get(url: String, cs: Charset, referer: String?): String? {
        var conn: HttpURLConnection? = null
        var stream: InputStream? = null
        return try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = CONNECT_MS
            conn.readTimeout = READ_MS
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", UA)
            conn.setRequestProperty("Accept", "*/*")
            conn.setRequestProperty("Accept-Encoding", "gzip")
            if (referer != null) conn.setRequestProperty("Referer", referer)
            if (conn.responseCode !in 200..299) return null
            val raw = conn.inputStream
            stream = raw
            val enc = conn.contentEncoding
            if (enc != null && enc.contains("gzip", ignoreCase = true)) {
                stream = GZIPInputStream(raw, 8192)
            }
            val bo = ByteArrayOutputStream(8192)
            val buf = ByteArray(8192)
            while (true) {
                val len = stream!!.read(buf)
                if (len <= 0) break
                bo.write(buf, 0, len)
            }
            String(bo.toByteArray(), cs)
        } catch (_: Throwable) {
            null
        } finally {
            try { stream?.close() } catch (_: Throwable) { }
            try { conn?.disconnect() } catch (_: Throwable) { }
        }
    }
}
