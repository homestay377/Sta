package io.github.mangi.eta.ui.stock

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.Charset
import java.util.concurrent.Executors
import java.util.zip.GZIPInputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * 问股 H5 的最小原生桥（`window.NativeBridge`）。
 *
 * 问股页面（`assets/stock/`）原本跑在自己的 WebView 壳里，行情/K线/配置都靠
 * `NativeBridge` 注入。Eta 内嵌时必须提供同名对象，否则 `callNative` 全部
 * reject，页面只剩一张空 K 线。
 *
 * 这一版只搬 P1 浮窗真正用到的部分：
 *   · 配置 / 自选：SharedPreferences（沿用问股的 `stock_ai_prefs`）
 *   · 行情：腾讯 → 东财 两级
 *   · K 线：腾讯双域名 → 东财 → 新浪
 *   · 分时 / 搜索
 *   · agent 文件沙箱（读写列表删除，限制在 filesDir/stock_agent 下）
 * AI 对话、模型列表、导出文件暂未搬 —— 浮窗里没有入口。
 *
 * 约定与问股一致：回调 `__nativeResult(cbId, ok, payload)`，必须在主线程
 * evaluateJavascript。
 */
class StockNativeBridge(
    private val appContext: Context,
    private val webView: WebView,
) {
    private val ui = Handler(Looper.getMainLooper())
    private val pool = Executors.newFixedThreadPool(4)

    @Volatile
    private var destroyed = false

    fun destroy() {
        destroyed = true
        try {
            ui.removeCallbacksAndMessages(null)
        } catch (_: Throwable) {
        }
        try {
            pool.shutdownNow()
        } catch (_: Throwable) {
        }
    }

    // ==================== 回调 ====================

    /**
     * 页面 → Kotlin 的单向事件通道（link.js 用）。
     *
     * type = ready / brief / result；payload 是 JSON 字符串。
     * 这是「AI 知道面板是哪只、AI 自己开面板」的数据来源，不写盘、不阻塞。
     */
    @JavascriptInterface
    fun stockEvent(type: String?, payload: String?) {
        if (destroyed) return
        StockChartLink.onBridgeEvent(type.orEmpty(), payload.orEmpty())
    }

    private fun deliver(cbId: String?, ok: Boolean, payload: String?) {
        if (destroyed) return
        ui.post {
            if (destroyed) return@post
            val js = "__nativeResult(" + JSONObject.quote(cbId ?: "") + "," + ok + "," +
                JSONObject.quote(payload ?: "") + ")"
            try {
                webView.evaluateJavascript(js, null)
            } catch (_: Throwable) {
            }
        }
    }

    private fun onWorker(block: () -> Unit) {
        if (destroyed) return
        try {
            pool.execute { if (!destroyed) block() }
        } catch (_: Throwable) {
        }
    }

    // ==================== 配置 / 自选 ====================

    @JavascriptInterface
    fun getConfig(): String = prefs().getString("config", "{}") ?: "{}"

    @JavascriptInterface
    fun saveConfig(json: String?) {
        prefs().edit().putString("config", json ?: "{}").apply()
    }

    @JavascriptInterface
    fun getWatchlist(): String = prefs().getString("watchlist", "[]") ?: "[]"

    @JavascriptInterface
    fun saveWatchlist(json: String?) {
        prefs().edit().putString("watchlist", json ?: "[]").apply()
    }

    private fun prefs() = appContext.getSharedPreferences("stock_ai_prefs", Context.MODE_PRIVATE)

    /** 前端切外观后同步系统栏；Eta 自己管主题，这里空实现，方法存在即可。 */
    @JavascriptInterface
    fun setBars(theme: String?) = Unit

    /**
     * 图表里的「问 Eta」：把选中那根 K 线的日期/OHLC 文字交给宿主。
     * 宿主（AgentAppRoot）注册了 StockChartUiState.onAskCandle 就会直接发出去；
     * 独立 Activity 里没有宿主，忽略即可，不影响图表本身。
     */
    @JavascriptInterface
    fun ask(text: String?) {
        val t = text?.trim().orEmpty()
        if (t.isEmpty() || destroyed) return
        ui.post {
            if (destroyed) return@post
            try {
                StockChartUiState.onAskCandle?.invoke(t)
            } catch (t2: Throwable) {
                Log.w("StockChart", "ask failed", t2)
            }
        }
    }

    /** 前端「停止分析」；AI 通道未搬，空实现。 */
    @JavascriptInterface
    fun abortAi() = Unit

    /** 与问股同名的外观缩放，未搬。 */
    @JavascriptInterface
    fun setUiScale(scale: String?) = Unit

    // ==================== 行情 ====================

    @JavascriptInterface
    fun quote(codes: String?, cbId: String?) {
        onWorker {
            val c = codes ?: ""
            val r = httpGet("https://qt.gtimg.cn/q=$c", GBK, "https://gu.qq.com/")
            val quoteBody = r.body
            if (r.err == null && quoteBody != null && quoteBody.contains("v_")) {
                deliver(cbId, true, quoteBody)
                return@onWorker
            }
            val sb = StringBuilder()
            c.split(",").forEach { one ->
                val code = one.trim()
                if (code.isNotEmpty()) {
                    emQuoteOne(code)?.let { sb.append(it) }
                }
            }
            if (sb.isNotEmpty()) deliver(cbId, true, sb.toString())
            else deliver(cbId, false, "行情源都失败：" + (r.err ?: "腾讯返回非行情"))
        }
    }

    private fun emQuoteOne(code: String): String? {
        return try {
            val url = "https://push2.eastmoney.com/api/qt/stock/get?secid=" + emSecid(code) +
                "&fields=f57,f58,f43,f60,f46,f44,f45,f47,f48,f168,f162,f116,f169,f170,f171"
            val r = httpGet(url, UTF8, "https://quote.eastmoney.com/")
            if (r.err != null || r.body == null) return null
            val d = JSONObject(r.body).optJSONObject("data") ?: return null
            val dec = d.optInt("f152", 2)
            var base = 1.0
            repeat(dec) { base *= 10 }
            val f = arrayOfNulls<String>(52)
            for (i in f.indices) f[i] = ""
            f[1] = d.optString("f58")
            f[2] = d.optString("f57")
            f[3] = fmt(d.optDouble("f43", 0.0) / base)
            f[4] = fmt(d.optDouble("f60", 0.0) / base)
            f[5] = fmt(d.optDouble("f46", 0.0) / base)
            f[31] = fmt(d.optDouble("f169", 0.0) / base)
            f[32] = fmt(d.optDouble("f170", 0.0) / 100.0)
            f[33] = fmt(d.optDouble("f44", 0.0) / base)
            f[34] = fmt(d.optDouble("f45", 0.0) / base)
            f[36] = fmt(d.optDouble("f47", 0.0) / 100.0)
            f[37] = fmt(d.optDouble("f48", 0.0))
            f[38] = fmt(d.optDouble("f168", 0.0) / 100.0)
            f[39] = fmt(d.optDouble("f162", 0.0) / 100.0)
            f[45] = fmt(d.optDouble("f116", 0.0) / 100000000.0)
            f[49] = fmt(d.optDouble("f171", 0.0) / 100.0)
            "v_" + code + "=\"" + f.joinToString("~") + "\";\n"
        } catch (_: Throwable) {
            null
        }
    }

    // ==================== K 线 ====================

    @JavascriptInterface
    fun kline(rawCode: String?, rawPeriod: String?, rawCount: Int, cbId: String?) {
        val count = rawCount.coerceIn(1, 3000)
        val code = rawCode?.lowercase()?.takeIf { it.matches(Regex("[a-zA-Z]{2}\\d{6}")) } ?: ""
        val period = validPeriod(rawPeriod)
        if (code.isEmpty()) {
            deliver(cbId, false, "股票代码非法")
            return
        }
        if (period == null) {
            deliver(cbId, false, "周期非法: $rawPeriod")
            return
        }
        onWorker {
            val err = arrayOfNulls<String>(1)
            val body = fetchKline(code, period, count, err)
            if (body != null) deliver(cbId, true, body)
            else deliver(cbId, false, "所有 K 线源都失败：" + (err[0] ?: ""))
        }
    }

    private fun fetchKline(code: String, period: String, count: Int, errOut: Array<String?>): String? {
        val errs = StringBuilder()
        for ((i, host) in TENCENT_HOSTS.withIndex()) {
            val path = if (isMinutePeriod(period)) {
                "/appstock/app/kline/mkline?param=$code,$period,,$count"
            } else {
                "/appstock/app/fqkline/get?param=$code,$period,,,$count,qfq"
            }
            val r = httpGet(host + path, UTF8, "https://gu.qq.com/")
            val tencentBody = r.body
            if (r.err == null && tencentBody != null && tencentBody.trim().startsWith("{")) {
                val rows = tencentRows(tencentBody, code, period)
                if (rows.isNotEmpty()) return packKline(code, period, rows)
            }
            errs.append("腾讯").append(i + 1).append("(").append(r.err ?: "非K线").append(") ")
        }

        try {
            val url = "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
                "?secid=" + emSecid(code) +
                "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56" +
                "&klt=" + emKlt(period) + "&fqt=1&end=20500101&lmt=$count"
            val r = httpGet(url, UTF8, "https://quote.eastmoney.com/")
            val emBody = r.body
            if (r.err == null && emBody != null && emBody.trim().startsWith("{")) {
                val rows = eastmoneyRows(emBody, period)
                if (rows.isNotEmpty()) return packKline(code, period, rows)
            }
            errs.append("东财(").append(r.err ?: "空").append(") ")
        } catch (_: Throwable) {
            errs.append("东财(异常) ")
        }

        try {
            val url = "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/" +
                "CN_MarketData.getKLineData?symbol=" + code +
                "&scale=" + sinaScale(period) + "&ma=5&datalen=$count"
            val r = httpGet(url, UTF8, "https://finance.sina.com.cn/")
            val sinaBody = r.body
            if (r.err == null && sinaBody != null && sinaBody.trim().startsWith("[")) {
                val rows = sinaRows(sinaBody, period)
                if (rows.isNotEmpty()) return packKline(code, period, rows)
            }
            errs.append("新浪(").append(r.err ?: "空").append(") ")
        } catch (_: Throwable) {
            errs.append("新浪(异常) ")
        }

        errOut[0] = errs.toString().trim()
        return null
    }

    @JavascriptInterface
    fun minute(code: String?, cbId: String?) {
        val c = code ?: ""
        onWorker {
            val errs = StringBuilder()
            for ((i, host) in TENCENT_HOSTS.withIndex()) {
                val r = httpGet(host + "/appstock/app/minute/query?code=" + c, UTF8, "https://gu.qq.com/")
                if (looksLikeKlineJson(r)) {
                    deliver(cbId, true, r.body)
                    return@onWorker
                }
                errs.append("腾讯").append(i + 1).append(" ").append(r.err ?: "非分时").append("; ")
            }
            deliver(cbId, false, "分时源都失败：" + errs.toString().trim())
        }
    }

    @JavascriptInterface
    fun search(keyword: String?, cbId: String?) {
        onWorker {
            try {
                val url = "https://smartbox.gtimg.cn/s3/?v=2&q=" +
                    URLEncoder.encode(keyword ?: "", "UTF-8") + "&t=all"
                val r = httpGet(url, UTF8, "https://gu.qq.com/")
                if (r.err != null) deliver(cbId, false, r.err) else deliver(cbId, true, r.body)
            } catch (t: Throwable) {
                deliver(cbId, false, t.message ?: t.toString())
            }
        }
    }

    private fun packKline(code: String, period: String, rows: List<Array<String>>): String {
        val sb = StringBuilder(256 + rows.size * 96)
        sb.append("{\"code\":0,\"msg\":\"\",\"data\":{\"").append(code).append("\":{\"")
        sb.append(if (isMinutePeriod(period)) period else "qfq$period").append("\":[")
        rows.forEachIndexed { i, r ->
            if (i > 0) sb.append(',')
            sb.append('[')
            for (j in 0 until 6) {
                if (j > 0) sb.append(',')
                if (j == 0) sb.append('"').append(r[0]).append('"')
                else sb.append(r.getOrNull(j) ?: "0")
            }
            sb.append(']')
        }
        sb.append("]}}}")
        return sb.toString()
    }

    private fun tencentRows(body: String, code: String, period: String): List<Array<String>> {
        val out = ArrayList<Array<String>>()
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
                    arrayOf(
                        r.optString(0), r.optString(1), r.optString(2),
                        r.optString(3), r.optString(4), r.optString(5),
                    ),
                )
            }
        } catch (_: Throwable) {
        }
        return out
    }

    private fun eastmoneyRows(body: String, period: String): List<Array<String>> {
        val out = ArrayList<Array<String>>()
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
                out.add(arrayOf(time, f[1], f[2], f[3], f[4], f[5]))
            }
        } catch (_: Throwable) {
        }
        return out
    }

    private fun sinaRows(body: String, period: String): List<Array<String>> {
        val out = ArrayList<Array<String>>()
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
                val vol = o.optDouble("volume", 0.0)
                out.add(
                    arrayOf(
                        time, o.optString("open"), o.optString("close"),
                        o.optString("high"), o.optString("low"),
                        Math.round(vol / 100.0).toString(),
                    ),
                )
            }
        } catch (_: Throwable) {
        }
        return out
    }

    // ==================== 文件沙箱 ====================

    @JavascriptInterface
    fun fsRead(rel: String?, cbId: String?) {
        onWorker {
            try {
                val f = safeResolve(rel)
                if (!f.exists() || !f.isFile) {
                    deliver(cbId, false, "文件不存在: $rel")
                    return@onWorker
                }
                if (f.length() > FS_MAX_READ) {
                    deliver(cbId, false, "文件过大（${f.length()} 字节）")
                    return@onWorker
                }
                FileInputStream(f).use { input ->
                    val bos = ByteArrayOutputStream()
                    val buf = ByteArray(BUFFER_SIZE)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        bos.write(buf, 0, n)
                    }
                    deliver(cbId, true, String(bos.toByteArray(), UTF8))
                }
            } catch (t: Throwable) {
                deliver(cbId, false, t.message ?: t.toString())
            }
        }
    }

    @JavascriptInterface
    fun fsWrite(rel: String?, content: String?, cbId: String?) {
        onWorker {
            try {
                val f = safeResolve(rel)
                val bytes = (content ?: "").toByteArray(UTF8)
                if (bytes.size > FS_MAX_WRITE) {
                    deliver(cbId, false, "内容过大（${bytes.size} 字节）")
                    return@onWorker
                }
                val parent = f.parentFile
                if (parent != null && !parent.exists()) parent.mkdirs()
                val tmp = File(parent, f.name + ".tmp." + System.nanoTime())
                FileOutputStream(tmp).use { out ->
                    out.write(bytes)
                    out.flush()
                    out.fd.sync()
                }
                if (f.exists() && !f.delete()) {
                    deliver(cbId, false, "无法覆盖: $rel")
                    return@onWorker
                }
                if (!tmp.renameTo(f)) {
                    deliver(cbId, false, "写入失败: $rel")
                    return@onWorker
                }
                val o = JSONObject()
                o.put("path", rel)
                o.put("bytes", bytes.size)
                deliver(cbId, true, o.toString())
            } catch (t: Throwable) {
                deliver(cbId, false, t.message ?: t.toString())
            }
        }
    }

    @JavascriptInterface
    fun fsList(rel: String?, cbId: String?) {
        onWorker {
            try {
                val f = safeResolve(if (rel.isNullOrBlank()) "." else rel, allowRoot = true)
                if (!f.exists()) {
                    deliver(cbId, true, "[]")
                    return@onWorker
                }
                if (!f.isDirectory) {
                    deliver(cbId, false, "不是目录: $rel")
                    return@onWorker
                }
                val out = JSONArray()
                f.listFiles()?.forEach { one ->
                    if (one.name.endsWith(".tmp")) return@forEach
                    val o = JSONObject()
                    o.put("name", one.name)
                    o.put("dir", one.isDirectory)
                    o.put("size", if (one.isFile) one.length() else 0L)
                    o.put("mtime", one.lastModified())
                    out.put(o)
                }
                deliver(cbId, true, out.toString())
            } catch (t: Throwable) {
                deliver(cbId, false, t.message ?: t.toString())
            }
        }
    }

    @JavascriptInterface
    fun fsDelete(rel: String?, cbId: String?) {
        onWorker {
            try {
                val f = safeResolve(rel)
                if (!f.exists()) {
                    deliver(cbId, false, "文件不存在: $rel")
                    return@onWorker
                }
                if (!f.delete()) {
                    deliver(cbId, false, "删除失败: $rel")
                    return@onWorker
                }
                deliver(cbId, true, "ok")
            } catch (t: Throwable) {
                deliver(cbId, false, t.message ?: t.toString())
            }
        }
    }

    private fun agentRoot(): File = File(appContext.filesDir, "stock_agent")

    private fun safeResolve(rel: String?, allowRoot: Boolean = false): File {
        if (rel == null) throw IllegalArgumentException("路径为空")
        var p = rel.trim().replace('\\', '/')
        while (p.startsWith("/")) p = p.substring(1)
        if (p.isEmpty()) throw IllegalArgumentException("路径为空")
        if (".." in p) throw IllegalArgumentException("路径不允许包含 ..")
        val root = agentRoot()
        if (!root.exists()) root.mkdirs()
        val f = File(root, p)
        val rootPath = root.canonicalPath
        val targetPath = f.canonicalPath
        if (targetPath != rootPath && !targetPath.startsWith(rootPath + File.separator)) {
            throw IllegalArgumentException("路径越界: $rel")
        }
        if (!allowRoot && targetPath == rootPath) {
            throw IllegalArgumentException("不允许直接操作沙箱根目录: $rel")
        }
        return f
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
            c.setRequestProperty("User-Agent", UA)
            c.setRequestProperty("Accept", "*/*")
            c.setRequestProperty("Accept-Encoding", "gzip, identity")
            if (referer != null) c.setRequestProperty("Referer", referer)
            r.code = c.responseCode
            input = if (r.code in 200..399) c.inputStream else c.errorStream
            if (input == null) {
                r.err = "HTTP ${r.code} 无响应体"
                return r
            }
            val enc = c.contentEncoding
            if (enc != null && enc.lowercase().contains("gzip")) input = GZIPInputStream(input)
            val bos = ByteArrayOutputStream()
            val buf = ByteArray(BUFFER_SIZE)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                bos.write(buf, 0, n)
            }
            r.body = String(bos.toByteArray(), respCharset)
        } catch (t: Throwable) {
            r.err = describeNetError(t)
        } finally {
            try {
                input?.close()
            } catch (_: Throwable) {
            }
            if (c != null && r.err != null) {
                try {
                    c.disconnect()
                } catch (_: Throwable) {
                }
            }
        }
        return r
    }

    private fun describeNetError(t: Throwable): String {
        val cls = t.javaClass.simpleName
        val msg = t.message ?: ""
        return when {
            cls.contains("SocketTimeout") -> "请求超时（${READ_TIMEOUT_MS / 1000} 秒），请检查网络"
            cls.contains("UnknownHost") -> "域名解析失败，请检查网络（$msg）"
            cls.contains("SSL") || cls.contains("Cert") -> "HTTPS 证书校验失败（$msg）"
            cls.contains("Connect") -> "连接服务器失败（$msg）"
            else -> "请求失败：$cls" + if (msg.isEmpty()) "" else "（$msg）"
        }
    }

    private fun looksLikeKlineJson(r: Resp): Boolean {
        val b = r.body?.trim() ?: return false
        if (r.err != null) return false
        if (b.length < 2 || b[0] != '{') return false
        return b.contains("\"data\"")
    }

    private companion object {
        val GBK: Charset = Charset.forName("GBK")
        val UTF8: Charset = Charset.forName("UTF-8")
        const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        const val CONNECT_TIMEOUT_MS = 8000
        const val READ_TIMEOUT_MS = 15000
        const val RETRY_TIMES = 2
        const val RETRY_BACKOFF_MS = 300L
        const val BUFFER_SIZE = 8192
        const val FS_MAX_READ = 524288
        const val FS_MAX_WRITE = 4194304
        const val PERIOD_MINUTE = "minute"

        val TENCENT_HOSTS = arrayOf(
            "https://web.ifzq.gtimg.cn",
            "https://ifzq.gtimg.cn",
        )

        val PERIODS = arrayOf("minute", "m1", "m5", "m15", "m30", "m60", "day", "week", "month")

        fun validPeriod(p: String?): String? {
            val t = p?.trim()?.lowercase() ?: return null
            return PERIODS.firstOrNull { it == t }
        }

        fun isMinutePeriod(period: String?): Boolean = period?.startsWith("m") == true

        fun emSecid(code: String): String {
            val c = code.lowercase()
            val num = c.replace(Regex("^[a-z]+"), "")
            if (c.startsWith("sh")) return "1.$num"
            if (c.startsWith("sz")) return "0.$num"
            if (c.startsWith("bj")) return "0.$num"
            if (num.startsWith("6") || num.startsWith("5")) return "1.$num"
            return "0.$num"
        }

        fun emKlt(period: String): String = when {
            period == "week" -> "102"
            period == "month" -> "103"
            isMinutePeriod(period) -> period.substring(1)
            else -> "101"
        }

        fun sinaScale(period: String): String = when {
            period == "week" -> "1200"
            period == "month" -> "7200"
            isMinutePeriod(period) -> period.substring(1)
            else -> "240"
        }

        fun fmt(v: Double): String {
            if (v.isNaN() || v.isInfinite()) return "0"
            return (Math.round(v * 1000.0) / 1000.0).toString()
        }
    }

    // ==================== 缠论（Kotlin 引擎） ====================

    /**
     * K 线 JSON → 缠论 JSON（字段与 JS 版 `Chan.analyze()` 同构）。
     *
     * 这是「JS 层换成 Kotlin」的第一个落点：前端原来调
     * `Chan.analyze(S.kl, window.CHAN_FORMULA)`，改成
     * `NativeBridge.chanCalc(JSON.stringify(S.kl), 0)` 即可，返回结构不变。
     *
     * 纯计算、不走网络，可以同步调用（640 根 × 255 行约 0.3s）。
     * @param viewStart 可视窗口起点，用来丢掉落在窗口左侧的中枢；0 = 不裁。
     */
    @JavascriptInterface
    fun chanCalc(barsJson: String?, viewStart: Int): String {
        if (destroyed) return chanEmptyJson
        val text = barsJson ?: return chanEmptyJson
        return runCatching {
            StockChanSource.analyzeBars(text, StockChanSource.formula(appContext), viewStart)
        }.getOrElse { e ->
            Log.w("StockChart", "chanCalc failed", e)
            chanEmptyJson
        }
    }

    private val chanEmptyJson: String =
        "{\"pens\":[],\"boxes\":[],\"bi\":[],\"signals\":[],\"points\":[]," +
            "\"stats\":{\"bars\":0,\"pens\":0,\"boxes\":0,\"errors\":1," +
            "\"boxPosition\":null},\"errors\":[]}"
}
