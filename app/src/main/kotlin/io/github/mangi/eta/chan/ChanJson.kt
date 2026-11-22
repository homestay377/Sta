package io.github.mangi.eta.chan

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * 把 [ChanResult] 序列化成**与 JS 版 `Chan.analyze()` 完全同构**的 JSON。
 *
 * 为什么要手写而不是用 kotlinx.serialization：
 * 现有前端（`assets/stock/{chart.js,tools.js,app.js}`）是直接读这些字段的，
 * 字段名必须一字不差，手写能保证「顺序稳定 + 缺字段时不写出 null」，
 * 也避免给数据类加 @Serializable 影响其它模块。
 *
 * 字段对照（前端实际消费的）：
 *  - pens:    idx / price / type / dir / from / to / fromPrice / toPrice / len
 *  - boxes:   tag / s / e / zg / zd / mid
 *  - signals: idx / type / label / price / strength     ← type ∈ buy|sell
 *  - points:  idx / type / label / price / reason
 *  - stats:   bars / pens / boxes / errors / boxPosition / lastBox
 */
object ChanJson {

    fun of(r: ChanResult, withData: Boolean = false): String {
        val sb = StringBuilder(4096)
        sb.append('{')

        sb.append("\"pens\":[")
        r.pens.forEachIndexed { i, p ->
            if (i > 0) sb.append(',')
            sb.append('{')
            sb.append("\"idx\":").append(p.idx).append(',')
            sb.append("\"price\":").append(num(p.price)).append(',')
            sb.append("\"type\":\"").append(esc(p.type)).append('"')
            p.dir?.let { sb.append(",\"dir\":\"").append(esc(it)).append('"') }
            p.from?.let { sb.append(",\"from\":").append(it) }
            p.to?.let { sb.append(",\"to\":").append(it) }
            p.fromPrice?.let { sb.append(",\"fromPrice\":").append(num(it)) }
            p.toPrice?.let { sb.append(",\"toPrice\":").append(num(it)) }
            p.len?.let { sb.append(",\"len\":").append(it) }
            p.fromType?.let { sb.append(",\"fromType\":\"").append(esc(it)).append('"') }
            p.toType?.let { sb.append(",\"toType\":\"").append(esc(it)).append('"') }
            sb.append('}')
        }
        sb.append("],")

        sb.append("\"boxes\":[")
        r.boxes.forEachIndexed { i, b ->
            if (i > 0) sb.append(',')
            sb.append("{\"tag\":\"").append(esc(b.tag)).append("\",")
                .append("\"s\":").append(b.s).append(',')
                .append("\"e\":").append(b.e).append(',')
                .append("\"zg\":").append(num(b.zg)).append(',')
                .append("\"zd\":").append(num(b.zd)).append(',')
                .append("\"mid\":").append(num(b.mid)).append('}')
        }
        sb.append("],")

        sb.append("\"bi\":[")
        r.bi.forEachIndexed { i, s ->
            if (i > 0) sb.append(',')
            sb.append("{\"from\":").append(s.from)
                .append(",\"to\":").append(s.to)
                .append(",\"fromPrice\":").append(num(s.fromPrice))
                .append(",\"toPrice\":").append(num(s.toPrice))
                .append(",\"dir\":\"").append(esc(s.dir)).append('"')
                .append(",\"fromType\":\"").append(esc(s.fromType)).append('"')
                .append(",\"toType\":\"").append(esc(s.toType)).append('"')
                .append(",\"len\":").append(s.len).append('}')
        }
        sb.append("],")

        sb.append("\"signals\":[")
        r.signals.forEachIndexed { i, s ->
            if (i > 0) sb.append(',')
            sb.append("{\"idx\":").append(s.idx)
                .append(",\"type\":\"").append(esc(s.type)).append('"')
                .append(",\"label\":\"").append(esc(s.label)).append('"')
                .append(",\"level\":\"").append(esc(s.level)).append('"')
                .append(",\"price\":").append(num(s.price))
                .append(",\"strength\":\"").append(esc(s.strength)).append('"').append('}')
        }
        sb.append("],")

        sb.append("\"points\":[")
        r.points.forEachIndexed { i, p ->
            if (i > 0) sb.append(',')
            sb.append("{\"idx\":").append(p.idx)
                .append(",\"type\":\"").append(esc(p.type)).append('"')
                .append(",\"label\":\"").append(esc(p.label)).append('"')
                .append(",\"price\":").append(num(p.price))
                .append(",\"reason\":\"").append(esc(p.reason)).append('"').append('}')
        }
        sb.append("],")

        val st = r.stats
        sb.append("\"stats\":{")
            .append("\"bars\":").append(st.bars)
            .append(",\"pens\":").append(st.pens)
            .append(",\"boxes\":").append(st.boxes)
            .append(",\"errors\":").append(st.errors)
            .append(",\"boxPosition\":").append(if (st.boxPosition == null) "null" else "\"" + esc(st.boxPosition) + "\"")
        st.lastBox?.let {
            sb.append(",\"lastBox\":{\"tag\":\"").append(esc(it.tag)).append('"')
                .append(",\"s\":").append(it.s)
                .append(",\"e\":").append(it.e)
                .append(",\"zg\":").append(num(it.zg))
                .append(",\"zd\":").append(num(it.zd))
                .append(",\"mid\":").append(num(it.mid)).append('}')
        }
        sb.append('}')

        sb.append(",\"errors\":[")
        r.errors.forEachIndexed { i, e ->
            if (i > 0) sb.append(',')
            sb.append("{\"line\":").append(e.line)
                .append(",\"text\":\"").append(esc(e.text)).append('"')
                .append(",\"err\":\"").append(esc(e.message)).append('"').append('}')
        }
        sb.append(']')

        // data 是全部公式变量，体积大（200+ × N），默认不吐；调参时才打开
        if (withData) {
            sb.append(",\"data\":{")
            var first = true
            for ((k, arr) in r.data) {
                if (!first) sb.append(',')
                first = false
                sb.append('"').append(esc(k)).append("\":[")
                for (i in arr.indices) {
                    if (i > 0) sb.append(',')
                    sb.append(num(arr[i]))
                }
                sb.append(']')
            }
            sb.append('}')
        }
        sb.append('}')
        return sb.toString()
    }

    private fun num(v: Double): String = when {
        v.isNaN() || v.isInfinite() -> "null"      // JS 的 JSON.stringify(NaN/Infinity) 也是 null
        v == v.toLong().toDouble() -> v.toLong().toString()
        else -> v.toString()
    }

    private fun esc(s: String): String {
        val sb = StringBuilder(s.length + 8)
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append("\\u").append(String.format("%04x", c.code)) else sb.append(c)
            }
        }
        return sb.toString()
    }

    /**
     * 解析前端传进来的 K 线 JSON。两种字段名都认：
     * `{t,o,h,l,c,v}`（`assets/stock` 的口径）或 `{time,open,high,low,close,volume}`（原生）。
     */
    fun parseBars(barsJson: String): List<Bar> {
        val root = runCatching { Json.parseToJsonElement(barsJson) }.getOrNull() ?: return emptyList()
        val arr = root as? JsonArray ?: return emptyList()
        val out = ArrayList<Bar>(arr.size)
        for (el in arr) {
            val o = el as? JsonObject ?: continue
            fun f(vararg keys: String): Double {
                for (k in keys) {
                    val v = o[k]?.jsonPrimitive?.doubleOrNull
                    if (v != null) return v
                }
                return 0.0
            }
            fun s(vararg keys: String): String {
                for (k in keys) {
                    val v = o[k]?.jsonPrimitive?.content
                    if (!v.isNullOrEmpty()) return v
                }
                return ""
            }
            out.add(
                Bar(
                    o = f("o", "open"), h = f("h", "high"), l = f("l", "low"),
                    c = f("c", "close"), v = f("v", "volume"), t = s("t", "time", "dt"),
                ),
            )
        }
        return out
    }
}
