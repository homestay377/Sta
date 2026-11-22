package io.github.mangi.eta.ui.stock

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.theme.MiuixTheme

/**
 * 常驻快捷分析条：点了**直接发送**，不填输入框。
 *
 * 这套按钮和提示词都来自你原来的问股项目（`app.js` 的 QUICK_ANALYSES），
 * 9 条一条没删 —— 那些提示词是反复调出来的，模型最容易犯的错不是不会分析，
 * 而是给一堆形容词却落不到数字上，所以每条都写死了「必须给什么」。
 *
 * 交互上刻意与「＋」里的快捷提问区分开：这里一下就到结果，
 * 需要改条件的走快捷提问（只填不发）。
 *
 * 只在 K 线面板展开时显示，收起时不占位。
 */
internal object StockQuickAnalyses {

    data class Item(
        val key: String,
        val label: String,
        val primary: Boolean = false,
        val prompt: String,
    )

    private const val CHAN = "请只从缠论角度给出**可操作的判断**，按下面四步来，不要复述结构、不要罗列其他指标。" +
        "【一·定位】当前价在最近一个中枢的什么位置（上方/下方/中枢内），并写清 ZG、ZD 的具体数值。" +
        "【二·背驰】指出最近的顶背驰或底背驰是在比较哪两段走势（时间区间与高低点价位），" +
        "给出力度分档（弱/中/强/极强）与量化依据（MACD 面积或柱子高度、笔的长度与斜率对比），" +
        "然后判断这个背驰**有没有被中枢位置否决** —— 中枢内部的背驰往往只是中继，不能当买卖依据。" +
        "没有背驰就直说没有，不许编一个。" +
        "【三·买卖点】判断现在是几买或几卖（一买/二买/三买/一卖/二卖/三卖），" +
        "逐条列出成立依据，依据必须取自真实字段（中枢位置、笔的高低点是否依次抬高或降低、背驰），不许凭印象说。" +
        "【四·结论】一句话说清：现在能买 / 不能买 / 已持仓该怎么办，附对应价位与止损位。" +
        "三步条件都不满足时直接说「缠论层面不给买卖建议」，不要硬凑一个买点。"

    val all: List<Item> = listOf(
        // 空 prompt = 走默认的全级别分析，与「空着发送」完全同一条路径
        Item("all", "全级别分析", primary = true, prompt = ""),
        Item("chan", "缠论判断", prompt = CHAN),
        Item(
            "trend", "趋势定性",
            prompt = "请判断当前趋势：用道氏理论给出当前处于上升趋势/下降趋势/无趋势（震荡），" +
                "依据必须是「高点和低点是否依次抬高/降低」，并列出你用来判断的具体高点与低点价位。" +
                "如果高点低点无法确认，直说无法判断，不要硬套。",
        ),
        Item(
            "support", "支撑压力",
            prompt = "请给出当前的支撑位与压力位，每种最多 2 个，必须说明每个价位的来源" +
                "（前高/前低、缺口、密集成交区、均线、中枢上下沿、整数关口）。" +
                "按「支撑1: 数字（来源）」的格式输出，价格附近 1% 内的多个依据请合并成一个价位。",
        ),
        Item(
            "pattern", "形态识别",
            prompt = "请识别最近 60 根 K 线里是否出现经典形态：三角整理、旗形、头肩顶/底、" +
                "双重顶/底、圆弧、缺口。只有形态清晰且颈线/边界可以画出来时才算成立。" +
                "给形态名称 + 边界价位 + 突破方向 + 量能是否配合。没形态就直说没有，不要凑。",
        ),
        Item(
            "boll", "布林通道",
            prompt = "请分析布林带：当前价格在上中下轨的哪个位置、带宽是收窄还是扩张、" +
                "最近有没有触及上下轨、开口方向如何。" +
                "说明「收口后必有方向选择」这个前提，并给出上轨/中轨/下轨的具体数值作为后续判断基准。",
        ),
        Item(
            "kb", "K线信号",
            prompt = "请检查最近 5 根 K 线的单根与组合信号：长上影/长下影、十字星、锤子线、吞没、" +
                "孕线、早晨之星/黄昏之星。逐个说明出现在什么位置（高位/低位/中枢内）、" +
                "成交量是否确认。没有就直说没有。",
        ),
        Item(
            "vol", "量能背离",
            prompt = "请做量价背离检查：最近 60 根里价格创新高但量能没有同步放大（顶背离）、" +
                "或价格创新低但量能萎缩（底背离）的情况。" +
                "给出背离发生的时间、价格、成交量对比倍数，并说明背离是否已被后续走势确认或否定。",
        ),
        Item(
            "fib", "黄金分割",
            prompt = "请用最近一段明确的上涨或下跌波段做黄金分割：先说明你选的起点和终点（日期+价格），" +
                "再给出 0.382 / 0.5 / 0.618 三个回撤位与 1.272 / 1.618 两个扩展位。" +
                "指出当前价格落在哪个区间，以及这些位与现有支撑压力是否重合。",
        ),
    )
}

@Composable
internal fun StockQuickAnalysisRow(
    analyses: List<StockQuickAnalyses.Item>,
    onPick: (StockQuickAnalyses.Item) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(horizontal = 2.dp),
    ) {
        items(analyses, key = { it.key }) { item ->
            val primary = item.primary
            val bg = if (primary) {
                MiuixTheme.colorScheme.primary
            } else {
                MiuixTheme.colorScheme.surfaceContainerHigh
            }
            val fg = if (primary) {
                MiuixTheme.colorScheme.onPrimary
            } else {
                MiuixTheme.colorScheme.onSurface
            }
            Text(
                text = item.label,
                color = fg,
                fontSize = 13.sp,
                fontWeight = if (primary) FontWeight.Medium else FontWeight.Normal,
                maxLines = 1,
                modifier = Modifier
                    .clip(RoundedCornerShape(16.dp))
                    .background(bg)
                    .clickable { onPick(item) }
                    .padding(horizontal = 14.dp, vertical = 7.dp),
            )
        }
    }
}
