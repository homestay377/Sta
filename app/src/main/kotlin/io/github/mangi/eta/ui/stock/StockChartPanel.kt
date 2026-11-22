package io.github.mangi.eta.ui.stock

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color as AndroidColor
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.widget.EditText
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONTokener
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import org.json.JSONObject

/**
 * K 线面板的全局开关：胶囊和面板一个在 Shell、一个在聊天内容区，
 * 用同一个 Compose 状态串起来，避免把回调一层层穿过 AgentAppRoot。
 */
object StockChartUiState {
    /**
     * 面板是否显示。
     *
     * 现在面板是常驻布局的一段，默认 true，界面里已经没有收起入口了。
     * 保留这个状态是因为工具与上下文投影还靠它判断「面板在不在」，以及没有标的时不显示。
     */
    var expanded by mutableStateOf(true)

    /**
     * 面板是否折叠成顶部一条细横条。
     *
     * ★ 与 expanded 的区别（很重要，别混用）：
     *   expanded  = 用户要不要这个面板（false 会触发 WebView 销毁，见 onRelease）
     *   collapsed = 面板还留着、只是收成一条（WebView **不销毁**，展开瞬间恢复）
     *
     * 折叠是纯视觉行为，WebView 和 K 线数据都还在，避免反复重建 500 根 K 线、
     * 也避免流式期间页面重载。用户主动点收起时才置 true。
     */
    // 默认折叠：面板以一条的形式挂在输入框上方，不遮挡对话；用户点开才展开。
    var collapsed by mutableStateOf(true)

    /**
     * 面板占内容区高度的比例（0.30 ~ 0.92）。
     *
     * 提升到全局状态是为了让聊天消息区能据此让出位置：
     * 面板从顶部往下长，消息如果铺满整块就会一直钻到面板底下被挡住，
     * 所以消息区的底部内边距要等于这块高度，让正文正好止于拖拽条。
     */
    // 初始就是最大高度（屏幕 1/3）：只能往下拖变小，不能把图再拉大。
    var heightFraction by mutableFloatStateOf(1f / 3f)

    /** 拖拽条内部累计的“真实手指位移”，带死区，不对外暴露。 */
    internal var dragAccum = 0f

    /*
     * 高度上限按「这条拖拽条在屏幕上的位置」算，不按屏幕占比拍脑袋。
     *
     * 用户要的是：拖拽条最多顶到屏幕 1/3 处，再往上 K 线区域就被压扁了；
     * 往下最松也只到屏幕 2/3 处，下面还得留够对话。
     *
     * 注意 heightFraction 是「面板 + 下方留白」占内容区的比例 ——
     * 面板外边挂着 topInset 的 padding，WebView 只拿到面板高度减去 topInset 的那部分，
     * 所以「拖拽条在屏幕 1/3」等于 fraction ≈ 1/3 + topInset/内容区高。这个修正
     * 放在布局里做（见 AgentChatBody），这里只给屏幕占比的上下限。
     */

    /** 面板能占内容区的最大比例 = 初始高度，往上拖不动（图不会再变大）。 */
    internal val barTopFraction = 1f / 3f

    /** 面板能缩到的最小比例：留够 K 线可读的高度，再小就没意义了。 */
    internal val barBottomFraction = 0.12f

    /** 初始位置：等于上限，打开就是最大。 */
    internal val defaultPanelFraction = barTopFraction

    /** 1px 手指位移 → 多少 px 面板高度（<1 表示减速，手感更稳）。 */
    internal val dragGain = 0.28f

    /** 起步死区：手指移动不足这么多像素时不动面板。 */
    internal val dragDeadZonePx = 12f

    /**
     * 面板此刻是否真的占着屏幕。
     *
     * 与 [expanded] 的区别：expanded 是「用户想不想要」，现在恒为 true；
     * 这个值是「实际画出来没有」—— 没有选中标的时面板是空的，不该拦手势。
     */
    val isPanelShowing: Boolean
        get() = expanded && StockChartLink.panelCode.isNotBlank()

    /** 图表把「选中这根 K 线」的问题交给宿主（Eta）去发送；未注册时忽略。 */
    var onAskCandle: ((String) -> Unit)? = null

    /** 页面里的 prompt/confirm 需要一个 Activity 才能弹窗（WebView 用的是 applicationContext）。 */
    var hostActivity: WeakReference<Activity>? = null

    /** Eta 工具 stock_chart_annotate 的落点：把一段标注 JSON 交给页面绘制。 */
    var onAnnotate: ((String) -> Boolean)? = null

    /** Eta 工具 stock_chart_read 的落点：同步读一段当前图的快照 JSON。 */
    var onSnapshot: ((Int) -> String?)? = null
}

/**
 * 面板的调试日志：写到 /sdcard/Download/eta_stock_debug.log。
 * WebView 内部状态（挂载/卸载、展开/收起、页面 console 报错）在这台机器上
 * 没有别的观察手段，只能落盘；用户反馈“又不行了”时按时间点对一下就知道卡在哪。
 */
internal fun stockDebugLog(message: String) {
    // 异步写盘：同步 appendText 在 console 回调密集时会卡住主线程。
    io.github.mangi.eta.core.DebugFileLog.write("[chart] " + message)
}

/**
 * WebView 缓存：Eta 发第一条消息时会话 id 从 draft 变成真实 id，
 * `key(conversationKey)` 一变整棵聊天子树就被销毁重建。面板若跟着重建，
 * 页面会重新 loadUrl —— 表现为「问完 AI 后十字光标消失、K 线重新刷新」。
 * 所以把 WebView 提到组合之外复用，重组只是换父容器，不重载页面。
 */
private object StockChartWebViewCache {
    var webView: WebView? = null
    var bridge: StockNativeBridge? = null
}

/** 面板当前那个 WebView（未创建时为 null）；工具的读图/画图都从这里取。 */
internal fun stockChartWebView(): WebView? = StockChartWebViewCache.webView

/** Activity 销毁时调用，避免缓存住的 WebView 泄漏。 */
fun releaseStockChartWebView() {
    StockChartWebViewCache.bridge?.destroy()
    StockChartWebViewCache.bridge = null
    StockChartWebViewCache.webView?.let { wv ->
        (wv.parent as? ViewGroup)?.removeView(wv)
        try {
            wv.destroy()
        } catch (_: Throwable) {
        }
    }
    StockChartWebViewCache.webView = null
}

/**
 * 聊天内容区里的 K 线面板（常驻，不折叠）。
 *
 * 布局：由外层 Column 直接分配高度，面板自己**不计算**尺寸，也不做浮层覆盖。
 * 这样面板和聊天区是同一行里真实分割的两块，不存在谁盖住谁的问题。
 *
 * 为什么取消折叠与浮层：浮层方案下聊天内容会被压到面板底下，
 * 试过用「收窄消息列表高度」补偿，但收窄后可视区域变小、正文被挤走，
 * 反而更难看。直接分栏是最简单也不会错的形态。
 *
 * 底边保留拖拽条（0.25 ~ 0.85），不同机型、字号下“合适的分界”不一样，
 * 让用户自己拉一次，比写死一个比例稳。
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun StockChartInlinePanel(
    modifier: Modifier = Modifier,
    onHeightFractionChange: (Float) -> Unit = {},
) {
    LaunchedEffect(Unit) { stockDebugLog("panel composed") }

    DisposableEffect(Unit) {
        StockChartUiState.onAnnotate = { json -> pushAnnotation(json) }
        StockChartUiState.onSnapshot = { limit -> pullSnapshot(limit) }
        onDispose {
            StockChartUiState.onAnnotate = null
            StockChartUiState.onSnapshot = null
        }
    }

    // 面板是常驻的，返回键不再承担「收起」语义（否则退出应用会失效）。
    val density = LocalDensity.current
    var availablePx by remember { mutableFloatStateOf(1f) }

    Column(
        modifier = modifier
            .onSizeChanged { availablePx = it.height.toFloat().coerceAtLeast(1f) }
            .clip(RoundedCornerShape(18.dp)),
    ) {
        // 顶边拖拽条：面板挂在输入框上方，拖**顶边**调整高度。
        // 面板从底部往上长：往上拖（dragAmount<0）= 变高，所以取负号。
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(18.dp)
                .pointerInput(Unit) {
                    detectVerticalDragGestures(
                        onDragStart = { StockChartUiState.dragAccum = 0f },
                    ) { _, dragAmount ->
                        StockChartUiState.dragAccum += dragAmount * StockChartUiState.dragGain
                        if (kotlin.math.abs(StockChartUiState.dragAccum) < StockChartUiState.dragDeadZonePx) return@detectVerticalDragGestures
                        val deltaFraction = -with(density) { StockChartUiState.dragAccum / availablePx }
                        StockChartUiState.dragAccum = 0f
                        // barBottomFraction < barTopFraction（面板越小占比越低），
                        // coerceIn 要求 min <= max，所以顺序是 下界→上界。
                        val next = (StockChartUiState.heightFraction + deltaFraction)
                            .coerceIn(StockChartUiState.barBottomFraction, StockChartUiState.barTopFraction)
                        StockChartUiState.heightFraction = next
                        onHeightFractionChange(next)
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(width = 36.dp, height = 4.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(Color(0x668B949E)),
            )
        }

        StockChartWebView(modifier = Modifier.fillMaxWidth().weight(1f))
    }
}

/**
 * 同步读取页面快照（最后 N 根 K 线 + 缠论信号）。
 * 工具执行在 agent 线程，这里阻塞等 evaluateJavascript 的回调，最多 3 秒。
 */
private fun pullSnapshot(limit: Int): String? = StockChartLink.snapshot(limit)

/** 主线程把标注 JSON 注入页面；面板没开就先自己打开（AI 不再需要用户点胶囊）。 */
private fun pushAnnotation(json: String): Boolean {
    val result = StockChartLink.annotate(json)
    stockDebugLog("annotate chars=${json.length} result=$result")
    return result != null && result.startsWith("ok")
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun StockChartWebView(modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            val cached = StockChartWebViewCache.webView
            if (cached != null) {
                (cached.parent as? ViewGroup)?.removeView(cached)
                stockDebugLog("attach cached webview")
                cached
            } else WebView(ctx.applicationContext).apply {
                stockDebugLog("create new webview")
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                setBackgroundColor(AndroidColor.TRANSPARENT)
                // 必须可聚焦，否则页面里的搜索框点不出输入法。
                // 只在用户点输入框时才会弹键盘（页面没有 autofocus），不会平白抢 Eta 的输入焦点。
                isFocusable = true
                isFocusableInTouchMode = true
                // 关掉 WebView 自带长按（选词/上下文菜单），但**不注册监听器**：
                // 注册后系统会把这次长按当成「已处理」，WebView 进入一种等 ACTION_UP 的
                // 中间态，后续手势全部被吞掉 —— 用户看到的就是「一出十字就死机」。
                isLongClickable = false
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.databaseEnabled = true
                settings.allowFileAccess = true
                settings.allowContentAccess = true
                @Suppress("DEPRECATION")
                settings.allowFileAccessFromFileURLs = true
                @Suppress("DEPRECATION")
                settings.allowUniversalAccessFromFileURLs = false
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = true
                settings.textZoom = 100
                // Canvas 绘制交给 GPU：手势期间每帧都要全量重绘 100 根 K 线 + 指标，
                // 软件渲染撑不住 60fps，表现就是拖动/缩放「拖不动」。
                setLayerType(View.LAYER_TYPE_HARDWARE, null)
                webViewClient = WebViewClient()
                webChromeClient = object : WebChromeClient() {
                    override fun onJsPrompt(
                        view: WebView?,
                        url: String?,
                        message: String?,
                        defaultValue: String?,
                        result: JsPromptResult?,
                    ): Boolean {
                        val activity = StockChartUiState.hostActivity?.get() ?: return false
                        if (result == null) return false
                        val input = EditText(activity).apply {
                            setText(defaultValue ?: "")
                            setSelection(text?.length ?: 0)
                            setSingleLine()
                        }
                        AlertDialog.Builder(activity)
                            .setTitle(message ?: "")
                            .setView(input)
                            .setPositiveButton(android.R.string.ok) { _, _ ->
                                result.confirm(input.text?.toString().orEmpty())
                            }
                            .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                            .setOnCancelListener { result.cancel() }
                            .show()
                        return true
                    }

                    override fun onJsConfirm(
                        view: WebView?,
                        url: String?,
                        message: String?,
                        result: JsResult?,
                    ): Boolean {
                        val activity = StockChartUiState.hostActivity?.get() ?: return false
                        if (result == null) return false
                        AlertDialog.Builder(activity)
                            .setMessage(message ?: "")
                            .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                            .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                            .setOnCancelListener { result.cancel() }
                            .show()
                        return true
                    }

                    override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                        Log.i(
                            "StockChart",
                            "${m.messageLevel()} ${m.message()} @${m.sourceId()}:${m.lineNumber()}",
                        )
                        if (m.messageLevel() != ConsoleMessage.MessageLevel.LOG) {
                            stockDebugLog("console ${m.messageLevel()} ${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                        }
                        return true
                    }
                }
                val b = StockNativeBridge(ctx.applicationContext, this)
                addJavascriptInterface(b, "NativeBridge")
                StockChartWebViewCache.bridge = b
                StockChartWebViewCache.webView = this
                loadUrl("file:///android_asset/stock/index.html?mode=chart")
            }
        },
        onRelease = { wv ->
            (wv.parent as? ViewGroup)?.removeView(wv)
            if (StockChartUiState.expanded) {
                // 面板还展开着却离开组合（聊天子树重建、流式消息刷新等）：
                // 保留实例，下次 factory 直接复用 —— 页面、K 线、标注都还在，
                // 也不会出现「每两秒重载一次页面、标注刚排队就被销毁」的情况。
                stockDebugLog("detach webview keep-for-reuse")
            } else {
                // 收起就销毁：常驻一个 800 根 K 线 + 硬件图层的 WebView 会持续吃内存，
                // 主线程一被拖住，连 AgentRuntimeService 的消息都处理不了。
                stockDebugLog("release webview")
                StockChartLink.onPageReleased()
                StockChartWebViewCache.bridge?.destroy()
                StockChartWebViewCache.bridge = null
                StockChartWebViewCache.webView = null
                try {
                    wv.destroy()
                } catch (_: Throwable) {
                }
            }
        },
        update = { _ -> },
    )
}