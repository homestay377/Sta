package io.github.mangi.eta.ui.stock

import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.nio.charset.Charset
import java.net.HttpURLConnection
import java.net.URL

/**
 * 基本面 / 估值 / 资金面数据源（P1）。
 *
 * 全部走**东方财富公开接口，免登录、免 Token**。这些接口我在实现前逐个 curl 验证过，
 * 返回真实数据（300274 阳光电源 2026-09-30 报告期）：
 *
 * | 用途 | 接口 | 已验证字段 |
 * |---|---|---|
 * | 估值 | `push2/api/qt/stock/get` | f162 市盈率、f163 市净率、f116 总市值、f117 流通市值 |
 * | 资产负债表 | `datacenter RPT_DMSK_FN_BALANCE` | 总资产、净资产、总负债 |
 * | 利润表 | `datacenter RPT_DMSK_FN_INCOME` | 营业总收入、营业成本、归母净利润、扣非 |
 * | 龙虎榜 | `datacenter RPT_DAILYBILLBOARD_DETAILSNEW` | 机构席位、成交额、D1/D5 涨跌幅 |
 *
 * ## 口径提醒（务必写进输出）
 * - 财报是**报告期累计值**。三季报的 ROE 是前三季度净利润 ÷ 期末净资产，**不是年化**，
 *   和年报 ROE 不可直接比较。输出时必须标明报告期。
 * - 毛利率/净利率/资产负债率是我方**从报表字段算出来的**，不是东财直接给的指标，
 *   与第三方口径可能有细微差异。
 * - **没有**营收增速、一致预期、股东明细、公告原文的数据源，遇到这类问题必须明说拿不到。
 */
object StockFundamentalSource {

    /**
     * 行情走**腾讯**，不走东财 push2。
     *
     * ★ 实测：东财 push2.eastmoney.com 对 Java 客户端会直接断开连接
     *   （`SocketException: Unexpected end of file`），且随后对 curl 也开始限流返回空。
     *   腾讯 qt.gtimg.cn 稳定、字段齐全（现价/涨跌幅/总市值/流通市值/PE/PB 一次拿齐），
     *   而且 App 的 NativeBridge 本来就在用，等于已有验证过的通道。
     */
    private const val TX_QUOTE = "https://qt.gtimg.cn/q="
    private const val EM_DATA = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    private const val UA =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Mobile Safari/537.36"

    private const val CONNECT_MS = 8000
    private const val READ_MS = 12000
    private const val RETRY_TIMES = 2
    private const val RETRY_BACKOFF_MS = 300L

    /** 最近一次取数失败的原因。**静默返回 null 是排查的死路**，这里留痕。 */
    @Volatile
    var lastError: String? = null

    /** 单只票的估值快照。 */
    data class Valuation(
        val price: Double,
        val pe: Double,
        val pb: Double,
        val totalCap: Double,
        val floatCap: Double,
        val changeRate: Double,
    )

    /** 一期报表的关键项。金额单位：元。 */
    data class Statement(
        val reportDate: String,
        val revenue: Double,
        val cost: Double,
        val parentNetProfit: Double,
        val deductNetProfit: Double,
        val totalAssets: Double,
        val totalEquity: Double,
        val totalLiabilities: Double,
        /**
         * 营业总收入同比（%）。东财 `TOI_RATIO` 字段，**按去年同报告期对齐**，
         * 已手工核对：2026-09-30 营收 488.63 亿 vs 2025-09-30 664.02 亿 = -26.41%，
         * 与接口返回值一致。取不到时为 NaN。
         */
        val revenueYoy: Double = Double.NaN,
        /** 归母净利润同比（%），东财 `PARENT_NETPROFIT_RATIO`。 */
        val profitYoy: Double = Double.NaN,
        /** 扣非净利润同比（%），东财 `DPN_RATIO`。 */
        val deductYoy: Double = Double.NaN,
    ) {
        /** 毛利率：(营收 - 营业成本) / 营收 */
        val grossMargin: Double
            get() = if (revenue > 0) (revenue - cost) / revenue else 0.0

        /** 净利率：归母净利润 / 营收 */
        val netMargin: Double
            get() = if (revenue > 0) parentNetProfit / revenue else 0.0

        /** 资产负债率：总负债 / 总资产 */
        val debtRatio: Double
            get() = if (totalAssets > 0) totalLiabilities / totalAssets else 0.0

        /**
         * 报告期累计 ROE：归母净利润 ÷ 期末净资产。
         * **不是年化值**，三季报的结果是前三季度口径，别拿去和年报比。
         */
        val roe: Double
            get() = if (totalEquity > 0) parentNetProfit / totalEquity else 0.0
    }

    /** 龙虎榜一条记录。 */
    data class DragonEntry(
        val tradeDate: String,
        val close: Double,
        val changeRate: Double,
        val billAmount: Double,
        val ratio: Double,
        val explain: String,
    )

    /** 取估值快照；取不到时返回 null。 */
    fun valuation(code: String): Valuation? {
        // ★ 腾讯行情要带市场前缀（sz300274 / sh600519），裸代码查不到，会静默返回空
        val f = txQuote(txSym(code)) ?: return null
        return Valuation(
            price = num(f, 3),
            pe = num(f, 52),
            pb = num(f, 53),
            totalCap = num(f, 45),
            floatCap = num(f, 44),
            changeRate = num(f, 32),
        )
    }

    /** 取最近 [periods] 期财报，利润表与资产负债表按报告期对齐。 */
    fun statements(code: String, periods: Int = 4): List<Statement> {
        val income = rows(code, "RPT_DMSK_FN_INCOME", periods)
        val balance = balanceRows(code, periods)
        val map = balance.associateBy { it.reportDate }
        val out = ArrayList<Statement>(income.size)
        for (i in income) {
            val b = map[i.reportDate] ?: continue
            out.add(
                Statement(
                    reportDate = i.reportDate,
                    revenue = i.revenue,
                    cost = i.cost,
                    parentNetProfit = i.parentNetProfit,
                    deductNetProfit = i.deductNetProfit,
                    totalAssets = b.totalAssets,
                    totalEquity = b.totalEquity,
                    totalLiabilities = b.totalLiabilities,
                    revenueYoy = i.revenueYoy,
                    profitYoy = i.profitYoy,
                    deductYoy = i.deductYoy,
                ),
            )
        }
        return out.sortedByDescending { it.reportDate }
    }

    /** 龙虎榜最近 [limit] 条，按日期倒序。 */
    fun dragonList(code: String, limit: Int = 3): List<DragonEntry> {
        val raw = getJson(
            EM_DATA + "?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL" +
                "&filter=(SECURITY_CODE%3D%22" + code + "%22)" +
                "&pageSize=$limit&sortColumns=TRADE_DATE&sortTypes=-1",
        )
        val arr = raw?.optJSONObject("result")?.optJSONArray("data") ?: return emptyList()
        val out = ArrayList<DragonEntry>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.add(
                DragonEntry(
                    tradeDate = o.optString("TRADE_DATE", "").substringBefore(' ').take(10),
                    close = o.optDouble("CLOSE_PRICE", 0.0),
                    changeRate = o.optDouble("CHANGE_RATE", 0.0),
                    billAmount = o.optDouble("BILLBOARD_DEAL_AMT", 0.0),
                    ratio = o.optDouble("DEAL_AMOUNT_RATIO", 0.0),
                    explain = o.optString("EXPLAIN", ""),
                ),
            )
        }
        return out
    }

    /**
     * 单只票的基本面摘要（给模型读的文本）。
     * 只输出**能查到的事实**；查不到的字段直接不写，绝不用"无"或估计值糊弄。
     */
    fun summary(code: String, name: String, periods: Int = 4): String {
        val sb = StringBuilder()
        val head = if (name.isNotBlank()) "$name（${code.uppercase()}）" else code.uppercase()
        sb.append("标的：").append(head).append('\n')

        val v = valuation(code)
        if (v != null) {
            sb.append("估值：现价 ").append(fv(v.price))
                .append("，PE ").append(fv(v.pe))
                .append("，PB ").append(fv(v.pb))
                .append("，总市值 ").append(fYi(v.totalCap))
                .append("，流通市值 ").append(fYi(v.floatCap)).append('\n')
        }

        val sts = statements(code, periods)
        if (sts.isEmpty()) {
            sb.append("财报：未取到数据（接口未返回）。**不要凭印象编财务数字**。\n")
        } else {
            sb.append("财报（最近 ").append(sts.size).append(" 期，金额为报告期累计值）：\n")
            for (s in sts) {
                sb.append("  ").append(s.reportDate).append("：营收 ").append(fCap(s.revenue))
                    .append("，营业成本 ").append(fCap(s.cost))
                    .append("，归母净利 ").append(fCap(s.parentNetProfit))
                    .append("，扣非 ").append(fCap(s.deductNetProfit)).append('\n')
                // ★ 同比增速直接用接口给的字段，不要让模型自己拿两期相减——
                //   它得手工对齐"去年同报告期"，错了就是精确的错误数字。
                sb.append("      同比：营收 ").append(pctOrDash(s.revenueYoy))
                    .append("，归母净利 ").append(pctOrDash(s.profitYoy))
                    .append("，扣非 ").append(pctOrDash(s.deductYoy))
                    .append("（均对去年同报告期）\n")
                sb.append("      毛利率 ").append(pct(s.grossMargin))
                    .append("，净利率 ").append(pct(s.netMargin))
                    .append("，资产负债率 ").append(pct(s.debtRatio))
                    .append("，ROE(累计，非年化) ").append(pct(s.roe))
                    .append("，总资产 ").append(fCap(s.totalAssets))
                    .append("，净资产 ").append(fCap(s.totalEquity)).append('\n')
            }
        }

        val dragons = dragonList(code)
        if (dragons.isNotEmpty()) {
            sb.append("龙虎榜（最近 ").append(dragons.size).append(" 条）：\n")
            for (d in dragons) {
                sb.append("  ").append(d.tradeDate)
                    .append(" 涨跌 ").append(pct(d.changeRate / 100.0))
                    .append("，成交 ").append(fCap(d.billAmount))
                    .append("，占成交额 ").append(f(d.ratio)).append("%")
                    if (d.explain.isNotBlank()) sb.append("，").append(d.explain)
                sb.append('\n')
            }
        }

        sb.append("口径提醒：财报为报告期累计值，ROE 未经年化；同比增速为对去年同报告期，")
            .append("直接取接口值，不要自己拿两期相减；")
            .append("毛利率/净利率/资产负债率为本工具由报表字段算出。")
        return sb.toString()
    }

    /** 多只票横向对比，只比**同一报告期**那一行，避免拿不同期的数相减。 */
    fun compare(codes: List<String>, nameMap: Map<String, String>): String {
        val sb = StringBuilder()
        sb.append("多标的基本面对比：\n")
        val data = codes.mapNotNull { code ->
            val sts = statements(code, 2)
            val v = valuation(code)
            if (sts.isEmpty() && v == null) return@mapNotNull null
            Triple(code, v, sts)
        }.toList()
        if (data.isEmpty()) {
            sb.append("所有标的都没取到数据，**不要凭印象编造**。\n")
            return sb.toString()
        }

        // 取各标的最早（最新）的共同报告期，保证同口径
        val latestDates = data.mapNotNull { (_, _, sts) -> sts.firstOrNull()?.reportDate }.toSet()
        if (latestDates.isEmpty()) {
            return "多标的基本面对比：\n所有标的都没取到财报数据，**不要凭印象编造**。\n"
        }
        val date = latestDates.min()

        sb.append("标的  PE / PB / 毛利率 / 净利率 / ROE / 营收 / 营收同比 / 净利同比\n")
        for ((code, v, sts) in data) {
            val st = sts.firstOrNull { it.reportDate == date }
            val label = nameMap[code]?.take(6)?.plus("($code") ?: code.uppercase()
            sb.append("  ").append(label)
                .append("  PE ").append(v?.let { f(it.pe) } ?: "-")
                .append(" / PB ").append(v?.let { f(it.pb) } ?: "-")
                .append(" / 毛利 ").append(st?.let { pct(it.grossMargin) } ?: "-")
                .append(" / 净利率 ").append(st?.let { pct(it.netMargin) } ?: "-")
                .append(" / ROE ").append(st?.let { pct(it.roe) } ?: "-")
                .append(" / 营收 ").append(st?.let { fCap(it.revenue) } ?: "-")
                .append(" / 营收同比 ").append(st?.let { pctOrDash(it.revenueYoy) } ?: "-")
                .append(" / 净利同比 ").append(st?.let { pctOrDash(it.profitYoy) } ?: "-")
                .append('\n')
        }
        sb.append("\n对比口径：财报均为 $date 报告期，ROE 为累计值未经年化；同比为对去年同报告期。")
        return sb.toString()
    }

    /**
     * 大盘概览（P2）：主要指数 + 市场状态。
     *
     * 用 `ulist.np` 一次拉五档指数，免登录。**已实测**返回真实点位。
     *
     * 未实现的部分（接口在当前网络下不可用或未验证，如实说明，不做编造）：
     * 板块涨跌幅排行、全市场涨跌家数（市场宽度）。这两个接口我在实现前 curl 过，
     * 返回为空，因此**不写进输出**，避免模型拿到假数据。
     */
    fun marketOverview(): String {
        val items = listOf(
            "sh000001" to "上证指数", "sz399001" to "深证成指", "sh000300" to "沪深300",
            "sz399006" to "创业板指", "sh000016" to "上证50",
        )
        val sb = StringBuilder("大盘指数：\n")
        var shRate = Double.NaN
        var any = false
        for ((sym, label) in items) {
            val fields = txQuote(sym) ?: continue
            any = true
            val price = num(fields, 3)
            val rate = num(fields, 32)
            // 顺带留住上证涨跌幅，不再为「市场状态」多打一次接口
            if (sym == "sh000001") shRate = rate
            sb.append("  ").append(label)
                .append(" ").append(if (price > 0) String.format("%.2f", price) else "-")
                .append("  涨跌幅 ").append(signedOrDash(fields, 32))
                .append("（").append(sym.removePrefix("sh").removePrefix("sz")).append("）\n")
        }
        if (!any) {
            return "大盘：行情接口未返回数据，**不要凭印象描述大盘**。"
        }
        sb.append("\n市场状态：上证 ")
        // ★ 拿不到就说拿不到，绝不显示 0.00%——那是一个看起来合理的假值
        sb.append(if (shRate.isFinite()) signed(shRate) else "涨跌幅未取到").append("\n")
        sb.append("说明：仅提供指数点位与涨跌幅。板块涨跌幅排行与市场宽度（涨跌家数）当前无可用数据源，")
            .append("需要时请说明该数据拿不到，不要推测。")
        return sb.toString()
    }

    /** 字段缺失时返回「-」，不要退化成 0.00%，否则看起来像真实数据。 */
    private fun signedOrDash(f: List<String>, i: Int): String {
        if (i >= f.size) return "-"
        val v = f[i].trim().toDoubleOrNull() ?: return "-"
        return signed(v)
    }

    /** 6/5 开头是沪市，0/3 开头是深市，4/8 开头是北交所。 */
    private fun txSym(code: String): String {
        val c = code.lowercase().replace(Regex("^[a-z]+"), "")
        return when (c.firstOrNull()) {
            '6', '5' -> "sh$c"
            '4', '8' -> "bj$c"
            else -> "sz$c"
        }
    }

    /** 腾讯行情返回的是 GBK，按 ~ 分隔；索引取不到返回 0。 */
    private fun txQuote(sym: String): List<String>? {
        val body = get(TX_QUOTE + sym, Charsets.ISO_8859_1) ?: return null
        // qt.gtimg.cn 是 GBK；先按 ISO-8859-1 读字节再转 GBK，避免中文名乱码
        val gbk = String(body.toByteArray(Charsets.ISO_8859_1), Charset.forName("GBK"))
        for (line in gbk.split("\n")) {
            val t = line.trim()
            if (!t.startsWith("v_")) continue
            return t.drop(2).removeSuffix("\"").split("~").toList()
        }
        return null
    }

    /** 字段取值，缺失或非数字返回 0。 */
    private fun num(f: List<String>, i: Int): Double =
        if (i < f.size) f[i].trim().toDoubleOrNull() ?: 0.0 else 0.0

    /** 带符号的涨跌幅，正数加 +。 */
    private fun signed(v: Double): String {
        if (v != v || !v.isFinite()) return "-"
        return if (v > 0) String.format("+%.2f%%", v) else String.format("%.2f%%", v)
    }

    // ------------------------------------------------------------------ 内部

    private data class BalanceRow(
        val reportDate: String,
        val totalAssets: Double,
        val totalEquity: Double,
        val totalLiabilities: Double,
    )

    private data class IncomeRow(
        val reportDate: String,
        val revenue: Double,
        val cost: Double,
        val parentNetProfit: Double,
        val deductNetProfit: Double,
        val revenueYoy: Double,
        val profitYoy: Double,
        val deductYoy: Double,
    )

    private fun rows(code: String, reportName: String, periods: Int): List<IncomeRow> {
        val arr = getJson(
            EM_DATA + "?reportName=" + reportName + "&columns=ALL" +
                "&filter=(SECURITY_CODE%3D%22" + code + "%22)" +
                "&pageSize=$periods&sortColumns=REPORT_DATE&sortTypes=-1",
        )?.optJSONObject("result")?.optJSONArray("data") ?: return emptyList()
        val out = ArrayList<IncomeRow>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.add(
                IncomeRow(
                    reportDate = o.optString("REPORT_DATE", "").substringBefore(' ').take(10),
                    revenue = o.optDouble("TOTAL_OPERATE_INCOME", 0.0),
                    cost = o.optDouble("OPERATE_COST", 0.0),
                    parentNetProfit = o.optDouble("PARENT_NETPROFIT", 0.0),
                    deductNetProfit = o.optDouble("DEDUCT_PARENT_NETPROFIT", 0.0),
                    // optDouble 取不到会给 NaN，正好用它表示"没有这个数"
                    revenueYoy = o.optDouble("TOI_RATIO", Double.NaN),
                    profitYoy = o.optDouble("PARENT_NETPROFIT_RATIO", Double.NaN),
                    deductYoy = o.optDouble("DPN_RATIO", Double.NaN),
                ),
            )
        }
        return out
    }

    /** 资产负债表单独取，按报告期对齐利润表。 */
    private fun balanceRows(code: String, periods: Int): List<BalanceRow> {
        val arr = getJson(
            EM_DATA + "?reportName=RPT_DMSK_FN_BALANCE&columns=ALL" +
                "&filter=(SECURITY_CODE%3D%22" + code + "%22)" +
                "&pageSize=$periods&sortColumns=REPORT_DATE&sortTypes=-1",
        )?.optJSONObject("result")?.optJSONArray("data") ?: return emptyList()
        val out = ArrayList<BalanceRow>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.add(
                BalanceRow(
                    reportDate = o.optString("REPORT_DATE", "").substringBefore(' ').take(10),
                    totalAssets = o.optDouble("TOTAL_ASSETS", 0.0),
                    totalEquity = o.optDouble("TOTAL_EQUITY", 0.0),
                    totalLiabilities = o.optDouble("TOTAL_LIABILITIES", 0.0),
                ),
            )
        }
        return out
    }

    /** 东财 secid：SH=1.xxx，SZ/BJ=0.xxx。 */
    private fun secid(code: String): String {
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

    /** datacenter 接口返回 UTF-8 JSON；解析失败返回 null。 */
    private fun getJson(url: String): JSONObject? {
        val body = get(url, Charsets.UTF_8) ?: return null
        return try {
            JSONObject(body)
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * 带退避重试的取数。
     *
     * ★ 实测东财 datacenter 会**间歇性**出现 TLS 握手失败
     *   （`SSLHandshakeException: handshake_failure`），一次失败就静默返回 null，
     *   整条基本面链路会莫名消失。退避重试 2 次，失败原因留痕到 [lastError]。
     */
    private fun get(url: String, cs: Charset): String? {
        var lastErr: Throwable? = null
        for (attempt in 0..RETRY_TIMES) {
            val r = try {
                attemptOnce(url, cs)
            } catch (t: Throwable) {
                lastErr = t
                null
            }
            if (r != null) return r
            if (attempt < RETRY_TIMES) {
                try {
                    Thread.sleep(RETRY_BACKOFF_MS * (attempt + 1))
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
        }
        lastErr?.let { lastError = it.javaClass.simpleName + ": " + (it.message?.take(80) ?: "") }
        return null
    }

    private fun attemptOnce(url: String, cs: Charset): String? {
        var conn: HttpURLConnection? = null
        var stream: java.io.InputStream? = null
        try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = CONNECT_MS
            conn.readTimeout = READ_MS
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", UA)
            conn.setRequestProperty("Accept", "*/*")
            conn.setRequestProperty("Referer", "https://quote.eastmoney.com/")
            // ★ 必须声明并处理 gzip：Java 的 HttpURLConnection 不会自动解压，
            //   服务端一旦返回 gzip，拿到的就是二进制，JSON/文本解析全部失败且静默返回 null
            //   （实测踩过：估值链路整条消失，原因极难定位）。
            conn.setRequestProperty("Accept-Encoding", "gzip")
            if (conn.responseCode !in 200..299) {
                lastError = "HTTP " + conn.responseCode
                return null
            }
            val raw = conn.inputStream
            stream = raw
            val enc = conn.contentEncoding
            if (enc != null && enc.contains("gzip", ignoreCase = true)) {
                stream = java.util.zip.GZIPInputStream(raw, 8192)
            }
            val body = stream!!.bufferedReader(cs).use { it.readText() }
            return body
        } catch (t: Throwable) {
            throw t
        } finally {
            try { stream?.close() } catch (_: Throwable) { }
            try { conn?.disconnect() } catch (_: Throwable) { }
        }
    }

    /** 两位小数。 */
    fun f(v: Double): String = if (v != v || !v.isFinite()) "-" else String.format("%.2f", v)

    /** 金额转「亿」，读起来直观。 */
    fun fCap(v: Double): String {
        if (v != v || !v.isFinite()) return "-"
        val yi = v / 1e8
        return if (Math.abs(yi) >= 10000) String.format("%.2f亿", yi)
        else String.format("%.2f亿", yi)
    }

    /**
     * 估值类字段格式化：**0 和缺失都显示 -**。
     *
     * ★ 不能显示 0.00：亏损股的 PE 在接口里是空值，若输出「PE 0.00」，
     *   会被读成「市盈率极低、极便宜」，是会误导决策的假值。
     */
    fun fv(v: Double): String = if (v <= 0.0 || !v.isFinite()) "-" else String.format("%.2f", v)

    /** 已是「亿」单位的数值直接格式化；缺失显示 -，绝不显示 0.00 这种假值。 */
    fun fYi(v: Double): String = if (v <= 0.0 || !v.isFinite()) "-" else String.format("%.2f亿", v)

    /**
     * 同比增速格式化。接口给的**已经是百分数**（-26.41 表示 -26.41%），
     * 不要再乘 100。缺失显示「-」，绝不显示 0.00%。
     */
    fun pctOrDash(v: Double): String =
        if (v.isNaN() || !v.isFinite()) "-" else String.format("%.2f%%", v)

    /** 比率转百分比（0.335 -> 33.50%）。 */
    fun pct(v: Double): String = if (v != v || !v.isFinite()) "-" else String.format("%.2f%%", v * 100.0)

}
