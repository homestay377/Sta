package io.github.mangi.eta.core

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * 问股 fork 的临时诊断日志。
 *
 * 这台机器上没法读别的 App 的 logcat，所以把关键节点落到
 * `/sdcard/Download/eta_stock_debug.log`，用户复现后可以直接看。
 *
 * 写入是**异步**的：页面 console、工具调用、模型请求都会打日志，
 * 同步写文件会卡 UI 线程（曾导致键盘动画一卡一卡）。
 */
object DebugFileLog {
    private const val PATH = "/sdcard/Download/eta_stock_debug.log"
    private const val MAX_BYTES = 1_500_000L
    private const val MAX_PENDING = 400

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "eta-debug-log").apply { isDaemon = true }
    }
    private val pending = AtomicInteger(0)
    private val timeFormat = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

    fun write(message: String) {
        if (pending.get() >= MAX_PENDING) return
        pending.incrementAndGet()
        val line = try {
            timeFormat.format(Date()) + " " + message
        } catch (_: Throwable) {
            message
        }
        try {
            executor.execute {
                try {
                    val file = File(PATH)
                    if (file.exists() && file.length() > MAX_BYTES) file.delete()
                    file.appendText(line + "\n")
                } catch (_: Throwable) {
                } finally {
                    pending.decrementAndGet()
                }
            }
        } catch (_: Throwable) {
            pending.decrementAndGet()
        }
    }
}