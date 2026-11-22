package io.github.mangi.eta.ui.stock

import org.json.JSONArray
import org.json.JSONObject

/**
 * 交易决策留痕（本地，纯逻辑，不依赖 Android）。
 *
 * 分两类记录：
 *  - **建议**：模型给出的可执行判断（价位、止损、方向、置信度）。
 *  - **成交**：用户实际买卖（代码、方向、价格、数量、时间）。
 *
 * 只有配对上「建议 + 成交」，才能算真实盈亏；单独的建议只能算"事后价格是否触及目标/止损"。
 *
 * ## 为什么存结构化字段而不是整段对话
 * 一条建议约 286 字节，1000 条 279 KB。存对话会膨胀几十倍，而且没法做统计。
 *
 * ## 为什么这个类不碰 SharedPreferences
 * 把它做成纯逻辑（输入 JSON 字符串、输出 JSON 字符串），就能在 JVM 单测里
 * 完整验证增删改查与统计，Android 的 Context 只在工具层用。
 */
internal object TradeJournal {

    /** 记录类型。 */
    enum class Kind { DECISION, TRADE }

    /**
     * 追加一条记录，返回**新的库 JSON**（不是原库，也不是条数）。
     * 调用方负责把返回值写回存储——这样纯逻辑和 Android 存储彻底分离，单测好做。
     */
    fun append(storeJson: String, kind: Kind, entry: JSONObject): String {
        val root = parseStore(storeJson)
        val key = if (kind == Kind.DECISION) "decisions" else "trades"
        val arr = root.optJSONArray(key) ?: JSONArray()
        // 补上序号，便于引用"第几条"
        val obj = JSONObject(entry.toString())
        if (!obj.has("id")) obj.put("id", arr.length() + 1)
        arr.put(obj)
        root.put(key, arr)
        return root.toString()
    }

    /** 查询记录，可按 code 过滤；kind=null 表示两类都要。 */
    fun query(storeJson: String, kind: Kind?, code: String?, limit: Int): String {
        val root = parseStore(storeJson)
        val out = JSONArray()
        fun collect(key: String) {
            val arr = root.optJSONArray(key) ?: return
            // 从后往前取最近 limit 条
            val from = maxOf(0, arr.length() - limit)
            for (i in arr.length() - 1 downTo from) {
                val o = arr.optJSONObject(i) ?: continue
                if (!code.isNullOrBlank() && !o.optString("code").contains(code, ignoreCase = true)) continue
                out.put(o)
            }
        }
        if (kind == null || kind == Kind.DECISION) collect("decisions")
        if (kind == null || kind == Kind.TRADE) collect("trades")
        return out.toString()
    }

    /**
     * 复盘统计：把成交按代码聚合，算已平仓的盈亏。
     *
     * 简化口径：按 (code, 数量) 先进先出配对买卖，买入为成本、卖出为收入。
     * 不处理手续费、税费、分红——在输出里说明，避免用户误以为是精确收益。
     */
    fun review(storeJson: String, code: String?): String {
        val root = parseStore(storeJson)
        val trades = root.optJSONArray("trades") ?: JSONArray()
        // 按代码分组，按时间排序
        val groups = LinkedHashMap<String, MutableList<JSONObject>>()
        for (i in 0 until trades.length()) {
            val o = trades.optJSONObject(i) ?: continue
            val c = o.optString("code").uppercase()
            if (c.isBlank()) continue
            if (!code.isNullOrBlank() && !c.contains(code.uppercase())) continue
            groups.getOrPut(c) { ArrayList() }.add(o)
        }
        if (groups.isEmpty()) {
            return "没有成交记录可复盘。先告诉我你实际买卖了什么（代码、方向、价格、数量）。"
        }

        val sb = StringBuilder("交易复盘（口径：先进先出配对，未计手续费/税费/分红）：\n")
        for ((c, list) in groups) {
            // 时间升序（同时间按入库顺序，id 稳定）
            val sorted = list.sortedWith(
                compareBy<JSONObject> { it.optString("time") }.thenBy { it.optInt("id") },
            )
            // ★ 真正的 FIFO：买入进队尾，卖出从队头配对。
            //   原实现用移动加权平均（costSum/qtySum），和 FIFO 在部分平仓时结果不同：
            //   买1000@10 + 买1000@12，卖1000@15 → FIFO 赚5000，加权平均只算4000。
            //   A股默认 FIFO 口径，这里按 FIFO 算。
            val lots = ArrayDeque<Pair<Double, Double>>() // (price, qty)
            var realized = 0.0
            var closed = 0
            for (o in sorted) {
                val side = o.optString("side").lowercase()
                val price = o.optDouble("price", 0.0)
                var qty = o.optDouble("qty", 0.0)
                if (price <= 0 || qty <= 0) continue
                when (side) {
                    "buy" -> lots.addLast(price to qty)
                    "sell" -> {
                        while (qty > 0 && lots.isNotEmpty()) {
                            val (bp, bq) = lots.first()
                            val matched = minOf(qty, bq)
                            realized += (price - bp) * matched
                            qty -= matched
                            closed++
                            if (matched >= bq) lots.removeFirst()
                            else lots[0] = bp to (bq - matched)
                        }
                    }
                }
            }
            sb.append("  $c：平仓 $closed 次，已实现盈亏 ")
            sb.append(String.format("%.2f", realized)).append(" 元")
            val remain = lots.sumOf { it.second }
            if (remain > 0) {
                val cost = lots.sumOf { it.first * it.second } / remain
                sb.append("；当前持仓 ").append(String.format("%.0f", remain))
                    .append(" 股，成本 ").append(String.format("%.2f", cost))
            }
            sb.append('\n')
        }
        return sb.toString()
    }

    /** 清空记录。 */
    fun clear(storeJson: String): String =
        JSONObject().put("decisions", JSONArray()).put("trades", JSONArray()).toString()

    /** 当前总条数。 */
    fun total(storeJson: String): Int {
        val root = parseStore(storeJson)
        return (root.optJSONArray("decisions")?.length() ?: 0) +
            (root.optJSONArray("trades")?.length() ?: 0)
    }

    /** 容错解析：任何异常都当空库，不让一条坏数据毁掉整个账本。 */
    private fun parseStore(s: String): JSONObject {
        if (s.isBlank()) return JSONObject().put("decisions", JSONArray()).put("trades", JSONArray())
        return try {
            val o = JSONObject(s)
            if (!o.has("decisions")) o.put("decisions", JSONArray())
            if (!o.has("trades")) o.put("trades", JSONArray())
            o
        } catch (_: Throwable) {
            JSONObject().put("decisions", JSONArray()).put("trades", JSONArray())
        }
    }
}
