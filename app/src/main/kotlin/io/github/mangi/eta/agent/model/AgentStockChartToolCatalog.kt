package io.github.mangi.eta.agent.model

import org.json.JSONArray
import org.json.JSONObject

/**
 * 问股 K 线面板的标注工具。
 *
 * 模型分析完一只股票后，可以把结论画到图上：水平价位、区间、具体某根 K 线的
 * 背驰/买卖点、黄金分割。只负责“画”，不改动数据，也不下单。
 */
internal object AgentStockChartToolCatalog {
    fun appendTo(tools: JSONArray) {
        tools.put(
            AgentToolSchema.function(
                "stock_chart_read",
                "读取用户 K 线面板：代码、名称、周期、最近 N 根 K 线的 OHLCV，以及本地缠论引擎算出的" +
                    "背驰信号与三类买卖点。面板没打开时本工具会自动打开它；" +
                    "用户点名了 A 股就把名称或 6 位代码放进 symbol，会先切到那只股票再返回数据。" +
                    "分析 A 股个股、判断走势、准备画标注前都先调用它。" +
                    "**注意：本工具只支持 A 股（K 线面板的限制）。" +
                    "纳指、美股、伦敦金等境外品种请用 analyze_chan——它原生取数，不依赖面板。**",
                JSONObject()
                    .put("type", "object")
                    .put(
                        "properties",
                        JSONObject()
                            .put(
                                "symbol",
                                JSONObject()
                                    .put("type", "string")
                                    .put(
                                        "description",
                                        "要分析的股票：名称（阳光电源）或 6 位代码（300274 / sz300274）。" +
                                            "用户明确说了某只股票就填；用户只说“它/这只/现在怎么走”就不要填，" +
                                            "默认就是面板当前那只。",
                                    ),
                            )
                            .put(
                                "period",
                                JSONObject()
                                    .put("type", "string")
                                    .put(
                                        "description",
                                        "要看哪个级别：minute（分时）/ 5m / 15m / 30m / 60m / day（日线）/ " +
                                            "week（周线）/ month（月线）。" +
                                            "什么时候该传、什么时候别传：\n" +
                                            "· 该传——用户要「看图」「画线」「在某个级别上标东西」，或你自己需要看清某个级别的细节、准备在它上面标注。\n" +
                                            "· 别传——只是想比较多级别走势做判断，那用 stock_levels 一次拿齐更快更稳，" +
                                            "反复切本工具会让用户的图来回跳。\n" +
                                            "不传就按面板当前级别。",
                                    ),
                            )
                            .put(
                                "limit",
                                JSONObject()
                                    .put("type", "integer")
                                    .put("description", "取最近多少根 K 线，默认 160，范围 20–300")
                                    .put("minimum", 20)
                                    .put("maximum", 300),
                            ),
                    ),
            ),
        )

        val properties = JSONObject()
            .put(
                "period",
                JSONObject()
                    .put("type", "string")
                    .put(
                        "description",
                        "要把标注画在哪个级别：minute / 5m / 15m / 30m / 60m / day / week / month。" +
                            "不传就画在当前显示的级别上；传了会先切过去再画，" +
                            "此时 marks 的 date 必须是那个级别的时间格式。",
                    ),
            )
            .put(
                "annotation_json",
                JSONObject()
                    .put("type", "string")
                    .put(
                        "description",
                        "一段 JSON 字符串。可包含以下字段（都可省略）：" +
                            "levels:[{price,label,type}] 水平价位；" +
                            "zones:[{from,to,label}] 价格区间；" +
                            "marks:[{date,price,label,type}] 某根 K 线的点标注，" +
                            "type 用 buy/sell，label 用“一买/二买/三买/一卖/底背驰/顶背驰”；" +
                            "fib:[{fromDate,fromPrice,toDate,toPrice,ratios}] 黄金分割，" +
                            "ratios 默认 [0.382,0.5,0.618]；" +
                            "**texts:[{date,price,text,color,size,align}] 直接在图上写字**——" +
                            "想写“压力位”“这里放量”“三买确认”这类说明就用它，不要只画横线。" +
                            "color 取 up/down/target/stop，size 默认 9（7–20），align 取 center/left/right；" +
                            "不传 price 就贴在收盘价上。" +
                            "shapes:[{type,x1,y1,x2,y2,...}] 自由图元，type 取 trendline/ray/arrow/rect/hline/text/dot，" +
                            "**这是能力最全的一路，画趋势线、箭头、文字都用它**（详见 chart-drawing 技能文档）；" +
                            "date 用 K 线时间（日线 2026-11-12，分钟 2026-11-12 10:30）。",
                    ),
            )
            .put(
                "note",
                JSONObject()
                    .put("type", "string")
                    .put("description", "给用户看的一句话说明，例如“画了 2 条支撑和 1 个二买，并标了压力位”。"),
            )
            .put(
                "replace",
                JSONObject()
                    .put("type", "boolean")
                    .put("description", "默认 true：先清掉上一次的标注再画；false 表示叠加。"),
            )

        tools.put(
            AgentToolSchema.function(
                "stock_chart_annotate",
                "把技术分析的结论画到 Eta 的 K 线面板上：水平价位、价格区间、某根 K 线的背驰/一买二买三买等" +
                    "买卖点，以及黄金分割线。面板没打开会自动打开，不需要用户点。只画不改数据。" +
                    "只要回答里给出了具体价位、支撑压力、背驰或买卖点，就必须调用本工具把它们画上去；" +
                    "价格必须来自你实际读到的行情或 K 线，不要编造。",
                JSONObject()
                    .put("type", "object")
                    .put("properties", properties)
                    .put("required", JSONArray().put("annotation_json")),
            ),
        )
        // ---- 多级别走势：原生取数，不经过 K 线面板 ----
        //
        // 为什么不复用 stock_chart_read 一个级别一个级别地切：那会让面板来回跳，
        // 面板没展开时还根本读不到。多级别判断要的是「同一时刻各档位的对照」，
        // 所以这里一次取齐、按固定顺序给出。
        tools.put(
            AgentToolSchema.function(
                "stock_levels",
                "一次拿到同一只股票多个级别的走势摘要（收盘、均线排列、MACD 力度与柱体变化、KDJ/RSI、" +
                    "布林位置与带宽、量能比、结构方向、最近 5 根 K 线），并在末尾给出级别对照表。" +
                    "用户提到多级别、共振、大级别小级别，或你判断需要跨周期确认时，**首选本工具**：" +
                    "它内部并发直取各周期行情，不切换、不影响用户眼前的 K 线图，也避免切图间隙读串级别。" +
                    "（例外：用户就是要看某个级别的图、或在上面画线，那才用 stock_chart_read 切过去。）" +
                    "级别由你按需要选，不要求固定组合：只想看日线就只传 day；" +
                    "要做完整判断就多传几档（week+day+m60+m30+m15），一档一档看会漏掉级别之间的背离。",
                JSONObject()
                    .put("type", "object")
                    .put(
                        "properties",
                        JSONObject()
                            .put(
                                "symbol",
                                JSONObject()
                                    .put("type", "string")
                                    .put(
                                        "description",
                                        "A股：（阳光电源 / 300274 / sz300274）；美股：（usAAPL / AAPL）；" +
                                            "美股指数：（纳指 / 道指 / 标普500）；贵金属：（伦敦金 / XAU）。" +
                                            "用户明确点名了就填；只说「它/这只/现在」就不要填，默认用面板当前那只。",
                                    ),
                            )
                            .put(
                                "periods",
                                JSONObject()
                                    .put("type", "array")
                                    .put("items", JSONObject().put("type", "string"))
                                    .put(
                                        "description",
                                        "要看的级别列表，最多 6 个，从大到小写：week / day / m60 / m30 / m15 / m5 / month。" +
                                            "不传默认 [week, day, m60]。列表由你根据问题决定 —— " +
                                            "问长期趋势用 week+month，问短线用 day+m60+m30。",
                                    ),
                            ),
                    ),
            ),
        )
        // ---- 缠论（原生自主取数，完全不碰面板）----
        //
        // 和 stock_chart_read 的分工：
        //   stock_chart_read  读「用户眼前正在看的那张图」，要先切股/切级别，面板必须能打开
        //   analyze_chan      直接问某个标的某个级别，自己取数、自己算，面板开不开都行
        // 所以「帮我看看 300274 周线的中枢」这类点名问题走这里更快也更稳。
        tools.put(
            AgentToolSchema.function(
                "analyze_chan",
                "对指定股票的指定级别做一次完整缠论分析（笔、中枢、背驰、三类买卖点），返回可直接引用的摘要。" +
                    "**自己取行情数据，不需要打开或切换 K 线面板**，也不受面板当前显示的是哪只股票影响。" +
                    "问「这只票现在有几个中枢」「周线有没有背驰」这类结构问题时用它；" +
                    "需要多级别对照时用 stock_levels。" +
                    "**境外品种（纳指/美股/伦敦金）用它就对了——原生取数，不走 K 线面板。**",
                JSONObject()
                    .put("type", "object")
                    .put(
                        "properties",
                        JSONObject()
                            .put(
                                "symbol",
                                JSONObject()
                                    .put("type", "string")
                                    .put(
                                        "description",
                                        "要分析的标的。支持：" +
                                            "A股 6 位代码或简称（300274 / 阳光电源）；" +
                                            "美股代码（usAAPL / AAPL / usTSLA）；" +
                                            "美股指数（纳指 / 纳斯达克 / 道指 / 标普500 / us.IXIC）；" +
                                            "贵金属（伦敦金 / 现货黄金 / 伦敦银 / XAU）。注意「黄金」「白银」有歧义，" +
                                            "A股有山东黄金、中金黄金、白银有色，用户只说「黄金」时先问清是黄金股还是金价。" +
                                            "用户点名了就填；只说「它/这只」就不填，默认用面板当前那只。",
                                    ),
                            )
                            .put(
                                "period",
                                JSONObject()
                                    .put("type", "string")
                                    .put(
                                        "description",
                                        "级别：minute / 5m / 15m / 30m / 60m / day / week / month。" +
                                            "不传默认 day。",
                                    ),
                            ),
                    ),
            ),
        )
        // ---- 基本面（P1）：估值 + 财报 + 龙虎榜，东方财富公开接口，免登录 ----
        tools.put(
            AgentToolSchema.function(
                "get_fundamental",
                "取一只股票的基本面快照：估值（市盈率/市净率/市值）、最近几期财报（营收、营业成本、" +
                    "归母净利润、扣非、**营收/净利/扣非同比增速**、毛利率、净利率、资产负债率、ROE）、最近龙虎榜。" +
                    "同比增速已按去年同报告期对齐，**直接引用即可，不要自己拿两期数据相减**。" +
                    "**全部来自真实接口，不要凭印象编造财务数字。**" +
                    "回答「这公司值不值这个价」「财务怎么样」「有没有机构资金进出」时用它。" +
                    "注意：没有研发投入、分红、股东明细、一致预期、公告原文这些数据，遇到这类问题要明说拿不到。",
                JSONObject()
                    .put("type", "object")
                    .put(
                        "properties",
                        JSONObject()
                            .put(
                                "symbol",
                                JSONObject()
                                    .put("type", "string")
                                    .put("description", "6 位代码或简称。用户点名就填；只说「它/这只」就不填，默认面板当前那只。"),
                            )
                            .put(
                                "periods",
                                JSONObject()
                                    .put("type", "integer")
                                    .put("description", "取最近几期财报，默认 4，范围 1-8。")
                                    .put("minimum", 1)
                                    .put("maximum", 8),
                            ),
                    )
                    // ★ 不设 required：实现支持不传 symbol（回落到面板当前那只）。
                    //   schema 强制要求会导致「看看这只票的基本面」这种指代场景走不通。
            ),
        )
        tools.put(
            AgentToolSchema.function(
                "compare_fundamental",
                "对 2~4 只股票做基本面横向对比，输出同一报告期的估值与盈利指标对照表。" +
                    "回答「这几只里选哪只」「哪个更便宜/更稳」时用它。" +
                    "**必须传同一报告期的数据，不同期的数相减没有意义**，工具已自动对齐报告期。",
                JSONObject()
                    .put("type", "object")
                    .put(
                        "properties",
                        JSONObject()
                            .put(
                                "symbols",
                                JSONObject()
                                    .put("type", "string")
                                    .put("description", "2~4 个 6 位代码，用逗号分隔，如 300274,600519。"),
                            ),
                    )
                    .put("required", JSONArray().put("symbols")),
            ),
        )
        // ---- 大盘概览（P2）----
        tools.put(
            AgentToolSchema.function(
                "market_overview",
                "取当前大盘概览：上证、深证、沪深300、创业板、上证50 的点位与涨跌幅。" +
                    "回答「今天大盘怎么样」「市场情绪如何」「大环境如何」时**先调用它**，不要凭印象描述大盘。" +
                    "注意：板块涨跌幅排行与全市场涨跌家数当前没有可用数据源，工具会明确说明，" +
                    "此时不要自行推断板块强弱。",
                JSONObject().put("type", "object")
                    .put("properties", JSONObject()),
            ),
        )
        // ---- 自选股巡检（P3）----
        tools.put(
            AgentToolSchema.function(
                "scan_watchlist",
                "对用户自选股列表做一次批量巡检，输出紧凑表格：每只的收盘、涨跌幅、结构方向、是否有信号。" +
                    "用户说「看看我的自选」「帮我扫一遍自选」「哪些值得关注」时用它，" +
                    "**不要一只一只地去问**，那样既慢又会把上下文塞满。" +
                    "巡检完对「有信号」的标的，再分别用 get_fundamental / analyze_chan 深入。",
                JSONObject()
                    .put("type", "object")
                    .put(
                        "properties",
                        JSONObject()
                            .put(
                                "period",
                                JSONObject()
                                    .put("type", "string")
                                    .put("description", "巡检用哪个级别：minute / 5m / 15m / 30m / 60m / day / week / month。不传默认 day。"),
                            ),
                    ),
            ),
        )
        // ---- 决策留痕：记录建议 / 实际成交 / 复盘 ----
        tools.put(
            AgentToolSchema.function(
                "save_decision",
                "给完可执行建议后，把这次判断记进账本，供以后复盘。只在真的给了价位/止损/方向时调用，" +
                    "闲聊或纯结构描述不要调用。存的是结构化字段，不存整段对话，几乎不占空间。",
                JSONObject()
                    .put("type", "object")
                    .put(
                        "properties",
                        JSONObject()
                            .put("code", JSONObject().put("type", "string").put("description", "标的代码，如 sz300274 / usAAPL / XAU"))
                            .put("name", JSONObject().put("type", "string").put("description", "名称，可空"))
                            .put("action", JSONObject().put("type", "string").put("description", "buy / sell / watch（观望）"))
                            .put("price", JSONObject().put("type", "number").put("description", "建议价位"))
                            .put("stop", JSONObject().put("type", "number").put("description", "止损位，可空"))
                            .put("level", JSONObject().put("type", "string").put("description", "级别：day / week / m60 等，可空"))
                            .put("confidence", JSONObject().put("type", "string").put("description", "high / medium / low，可空"))
                            .put("reason", JSONObject().put("type", "string").put("description", "一句话理由摘要"))
                            .put("box_position", JSONObject().put("type", "string").put("description", "中枢上方/下方/内，可空")),
                    )
                    .put("required", JSONArray().put("code").put("action").put("price")),
            ),
        )
        tools.put(
            AgentToolSchema.function(
                "record_trade",
                "用户告诉你他实际买卖了什么时记录成交。**只用用户明确说出的真实数据**，" +
                    "代码/方向/价格/数量不确定就不要记，不要替用户编。有了成交记录才能算真实盈亏。",
                JSONObject()
                    .put("type", "object")
                    .put(
                        "properties",
                        JSONObject()
                            .put("code", JSONObject().put("type", "string").put("description", "标的代码"))
                            .put("name", JSONObject().put("type", "string").put("description", "名称，可空"))
                            .put("side", JSONObject().put("type", "string").put("description", "buy / sell"))
                            .put("price", JSONObject().put("type", "number").put("description", "用户说的实际成交价"))
                            .put("qty", JSONObject().put("type", "number").put("description", "用户说的实际股数"))
                            .put("time", JSONObject().put("type", "string").put("description", "成交时间，可空，默认当前")),
                    )
                    .put("required", JSONArray().put("code").put("side").put("price").put("qty")),
            ),
        )
        tools.put(
            AgentToolSchema.function(
                "review_trades",
                "复盘账本：用户问「我上次为什么买XX」「我的交易赚没赚」「复盘一下」时调用。" +
                    "平时不要主动调用——账本默认不进上下文，只有复盘时才按需读取。" +
                    "可传 code 只看某只，不传则汇总全部。",
                JSONObject()
                    .put("type", "object")
                    .put(
                        "properties",
                        JSONObject()
                            .put("code", JSONObject().put("type", "string").put("description", "标的，可空；空则复盘全部"))
                            .put("limit", JSONObject().put("type", "integer").put("description", "最多看几条历史，默认 20")),
                    ),
            ),
        )
    }
}
