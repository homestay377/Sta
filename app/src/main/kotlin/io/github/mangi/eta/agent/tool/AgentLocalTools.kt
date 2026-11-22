package io.github.mangi.eta.agent.tool

import android.content.Context
import android.graphics.Rect
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import android.view.Display
import io.github.mangi.eta.EtaApp
import io.github.mangi.eta.agent.accessibility.AgentAccessibilityService
import io.github.mangi.eta.agent.browser.AgentBrowserSession
import io.github.mangi.eta.agent.device.DeviceControlUnavailableException
import io.github.mangi.eta.agent.device.RootAccess
import io.github.mangi.eta.agent.device.RootShellDeviceController
import io.github.mangi.eta.agent.device.BoundedRootCommandExecutor
import io.github.mangi.eta.agent.model.AgentModelClient
import io.github.mangi.eta.agent.model.AgentHttpClient
import io.github.mangi.eta.agent.device.LocalNetworkPermission
import io.github.mangi.eta.agent.web.AgentWebTools
import io.github.mangi.eta.agent.web.WebHttpTransport
import io.github.mangi.eta.agent.model.AgentScreenObservationContract
import io.github.mangi.eta.agent.model.AgentSensitiveToolPolicy
import io.github.mangi.eta.agent.model.AgentTerminalToolCatalog
import io.github.mangi.eta.agent.model.AgentFileToolCatalog
import io.github.mangi.eta.agent.overlay.AgentHapticFeedback
import io.github.mangi.eta.agent.overlay.AgentOverlayClearance
import io.github.mangi.eta.agent.overlay.GestureIndicator
import io.github.mangi.eta.agent.runtime.AgentAppContext
import io.github.mangi.eta.agent.runtime.AgentRunCancelledException
import io.github.mangi.eta.agent.runtime.GuiControlCoordinator
import io.github.mangi.eta.agent.virtualdisplay.CanvasRoutingPolicy
import io.github.mangi.eta.agent.virtualdisplay.VirtualDisplayController
import io.github.mangi.eta.agent.skill.SkillCompatibilityChecker
import io.github.mangi.eta.agent.skill.SkillIndexService
import io.github.mangi.eta.agent.skill.SkillInstallErrorCode
import io.github.mangi.eta.agent.skill.SkillInstallResult
import io.github.mangi.eta.agent.skill.SkillLoader
import io.github.mangi.eta.agent.skill.SkillPackageInstaller
import io.github.mangi.eta.agent.skill.SkillParser
import io.github.mangi.eta.agent.skill.SkillResourceReader
import io.github.mangi.eta.agent.skill.SkillResourceReadResult
import io.github.mangi.eta.agent.skill.GitHubSkillRepositoryParser
import io.github.mangi.eta.agent.skill.GitHubSkillInspection
import io.github.mangi.eta.agent.skill.GitHubSkillRepository
import io.github.mangi.eta.agent.skill.GitHubSkillSourceException
import io.github.mangi.eta.agent.skill.PublicGitHubSkillSource
import io.github.mangi.eta.agent.terminal.TerminalExecutionContext
import io.github.mangi.eta.agent.terminal.DetachedTaskSupervisor
import io.github.mangi.eta.agent.terminal.LinuxEnvironmentPaths
import io.github.mangi.eta.agent.terminal.terminalEnvironment
import io.github.mangi.eta.agent.terminal.RootShellTerminalController
import io.github.mangi.eta.agent.terminal.SharedFolderMounts
import io.github.mangi.eta.config.Prefs
import io.github.mangi.eta.core.AgentLogger
import io.github.mangi.eta.core.HookSupport
import io.github.mangi.eta.data.repository.AgentMemoryException
import io.github.mangi.eta.data.repository.AgentMemoryMutation
import io.github.mangi.eta.data.repository.AgentMemoryRepository
import io.github.mangi.eta.data.repository.AgentMemoryWriteResult
import io.github.mangi.eta.data.repository.LinuxEnvironmentSettingsRepository
import io.github.mangi.eta.data.repository.WebToolsSettingsRepository
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.runBlocking

internal class AgentLocalTools(
    private val context: Context,
    private val logger: AgentLogger,
    private val browserRunId: String = "",
    private val browserToolsEnabled: () -> Boolean = {
        Prefs.isEnabled(Prefs.Keys.AGENT_BROWSER_TOOLS)
    },
    private val terminalToolsEnabled: () -> Boolean = {
        Prefs.isEnabled(Prefs.Keys.AGENT_TERMINAL_TOOLS)
    },
    private val deviceDirectToolsEnabled: () -> Boolean = {
        Prefs.isEnabled(Prefs.Keys.AGENT_DEVICE_DIRECT_TOOLS)
    },
    private val deviceSensitiveReadToolsEnabled: () -> Boolean = {
        Prefs.isEnabled(Prefs.Keys.AGENT_DEVICE_SENSITIVE_READ_TOOLS)
    },
    private val deviceSensitiveActionToolsEnabled: () -> Boolean = {
        Prefs.isEnabled(Prefs.Keys.AGENT_DEVICE_SENSITIVE_ACTION_TOOLS)
    },
    private val memoryToolsEnabled: () -> Boolean = {
        runBlocking { AgentMemoryRepository.isEnabled() }
    },
    private val memoryWritable: Boolean = true,
    private val screenshotExcludedPackages: () -> Set<String> = { emptySet() },
    private val screenObservationProvider: (
        (AgentScreenObservationContract.Options) -> RootShellDeviceController.Observation
    )? = null,
    private val beforeToolExecution: (String) -> ToolExecutionDecision = {
        ToolExecutionDecision.Allow
    },
    private val skillIndexService: SkillIndexService? = null,
    private val skillLoader: SkillLoader? = null,
    private val skillResourceReader: SkillResourceReader? = null,
    private val githubSkillSource: PublicGitHubSkillSource? = null,
    private val skillPackageInstaller: SkillPackageInstaller? = null,
    runAvailableSkillIds: Set<String> = emptySet(),
    pendingSkillConflict: PendingSkillConflictCapability? = null,
    private val rootAvailable: () -> Boolean = { RootAccess.isGranted },
    private val virtualDisplayEnabled: () -> Boolean = {
        Prefs.isEnabled(Prefs.Keys.AGENT_VIRTUAL_DISPLAY_ENABLED)
    },
    private val isToolEnabled: (String) -> Boolean = {
        Prefs.isToolEnabled(it)
    },
    private val lsposedAvailable: () -> Boolean = { EtaApp.serviceInstance != null },
    private val guiControl: GuiControlCoordinator.RunControl? = null,
    private val imageBudgetProvider: () -> io.github.mangi.eta.agent.media.ModelImageBudget = {
        io.github.mangi.eta.agent.media.ModelImageBudget.DEFAULT
    },
    browserSession: AgentBrowserSession? = null,
) : AgentModelClient.ToolExecutor, AutoCloseable {

    private val closed = AtomicBoolean(false)
    @Volatile
    private var activeDisplayId: Int = Display.DEFAULT_DISPLAY
    private val browserSessionRef = lazy { browserSession ?: AgentBrowserSession() }
    private val deviceController = RootShellDeviceController(logger, screenshotExcludedPackages, rootAvailable)
    private val rootCommandExecutor = BoundedRootCommandExecutor(logger, rootAvailable = rootAvailable)
    private val structuredDeviceTools = AgentStructuredDeviceTools(
        context = context,
        logger = logger,
        root = rootCommandExecutor,
        rootAvailable = rootAvailable,
        foregroundAction = ::executeForegroundIntent,
    )
    private val imageTools = AgentImageTools(context, rootCommandExecutor, rootAvailable, imageBudgetProvider)
    private val webTools = AgentWebTools(
        transport = WebHttpTransport(AgentHttpClient.client),
        localNetworkAccess = { LocalNetworkPermission.accessState(context).name.lowercase(Locale.ROOT) },
        runtimeConfig = { runBlocking { WebToolsSettingsRepository.resolveRuntimeConfig(context) } },
    )
    val terminalExecutionContext = LinuxEnvironmentSettingsRepository.current(context).terminalEnvironment.let { environment ->
        TerminalExecutionContext(
            linuxEnvironment = environment,
            linuxRootfsPath = LinuxEnvironmentPaths.rootfsDir(context, checkNotNull(environment.linuxDistribution)).absolutePath,
            sharedMounts = SharedFolderMounts.current(),
        )
    }
    private val terminalController = RootShellTerminalController(
        logger = logger,
        rootAvailable = rootAvailable,
        executionContext = terminalExecutionContext,
        backgroundJobs = io.github.mangi.eta.agent.terminal.TerminalRuntime.backgroundJobs(context),
        detachedSupervisor = DetachedTaskSupervisor(
            logger = logger,
            recordsFile = DetachedTaskSupervisor.defaultRecordsFile(context),
            linuxRootfsPath = terminalExecutionContext.linuxRootfsPath,
            linuxSharedMountsProvider = { SharedFolderMounts.current() },
            rootAvailable = rootAvailable,
        ),
        linuxSharedMountsProvider = { SharedFolderMounts.current() },
    )

    private val publishedObservation = AtomicReference(PublishedObservation())
    private val runAvailableSkillIds = runAvailableSkillIds
        .mapTo(mutableSetOf(), SkillParser::normalizeSkillLookup)
    private val mutatedSkillIds = ConcurrentHashMap.newKeySet<String>()
    private val skillTreeMutationUncertain = AtomicBoolean(false)
    private val pendingSkillConflict = AtomicReference(pendingSkillConflict)
    private val inspectedGitHubSnapshots =
        ConcurrentHashMap<String, GitHubInspectionSnapshot>()

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        publishedObservation.set(PublishedObservation())
        if (browserSessionRef.isInitialized()) browserSessionRef.value.interruptAgentAction(browserRunId)
        webTools.close()
        terminalController.interruptAll()
        deviceController.close()
        rootCommandExecutor.close()
        githubSkillSource?.close()
        inspectedGitHubSnapshots.clear()
        guiControl?.close()
    }

    override fun execute(toolCall: AgentModelClient.ToolCall): AgentModelClient.ToolResult {
        if (closed.get()) throw AgentRunCancelledException()
        val control = guiControl
        return if (control != null && AgentToolRequirements.requiresGuiControl(toolCall.name)) {
            control.withAction { generation -> executeLocal(toolCall, generation) }
        } else {
            executeLocal(toolCall, null)
        }
    }

    private fun executeLocal(
        toolCall: AgentModelClient.ToolCall,
        guiGeneration: Long?,
    ): AgentModelClient.ToolResult =
        runCatching {
            if (closed.get()) throw AgentRunCancelledException()
            val args = JSONObject(toolCall.argumentsJson.ifBlank { "{}" })
            if (AgentToolRequirements.find(toolCall.name) != null &&
                AgentToolRequirements.rootDenied(toolCall.name, args, rootAvailable())
            ) {
                return@runCatching textResult(errorResult("ROOT_REQUIRED", "此操作需要 Root 授权，本次未执行"))
            }
            if (!isToolEnabled(toolCall.name)) {
                return@runCatching AgentModelClient.ToolResult(
                    content = errorResult("TOOL_DISABLED", "工具 ${toolCall.name} 已在工具列表中关闭，本次未执行"),
                    sensitive = AgentSensitiveToolPolicy.isSensitive(toolCall.name),
                )
            }
            deviceToolPermissionError(toolCall.name)?.let { return@runCatching it }
            memoryToolPermissionError(toolCall.name)?.let { return@runCatching it }
            if (guiGeneration != null && publishedObservation.get().generation != guiGeneration) {
                publishedObservation.set(PublishedObservation())
                if (AgentToolRequirements.requiresFreshObservation(toolCall.name)) {
                    return@runCatching textResult(errorResult(
                        "NO_OBSERVATION", "手机操作权已变化，请先调用 observe_screen 重新观察，再操作当前页面",
                    ))
                }
            }
            val preparation = if (AgentToolRequirements.hasForegroundIntentFallback(toolCall.name)) {
                ToolExecutionDecision.Allow
            } else {
                beforeToolExecution(toolCall.name)
            }
            when (val decision = preparation) {
                ToolExecutionDecision.Allow -> Unit
                is ToolExecutionDecision.Reject -> {
                    if (decision.code.startsWith("ACCESSIBILITY_")) publishedObservation.set(PublishedObservation())
                    return@runCatching textResult(
                        errorResult(
                            code = decision.code,
                            message = decision.message,
                        ),
                    )
                }
            }
            when (toolCall.name) {
                "stock_chart_annotate" -> textResult(annotateStockChart(args))
                "stock_chart_read" -> textResult(readStockChart(args))
                "stock_levels" -> textResult(stockLevels(args))
                "analyze_chan" -> textResult(analyzeChan(args))
                "get_fundamental" -> textResult(getFundamental(args))
                "compare_fundamental" -> textResult(compareFundamental(args))
                "market_overview" -> textResult(marketOverview(args))
                "scan_watchlist" -> textResult(scanWatchlist(args))
                "save_decision" -> textResult(saveDecision(args))
                "record_trade" -> textResult(recordTrade(args))
                "review_trades" -> textResult(reviewTrades(args))
                "get_current_context" -> textResult(DeviceContextTool.current(context))
                "search_apps" -> textResult(searchApps(args))
                "launch_app" -> {
                    publishedObservation.set(PublishedObservation())
                    textResult(launchApp(args))
                }
                "present_to_user" -> {
                    publishedObservation.set(PublishedObservation())
                    textResult(presentToUser(args))
                }
                "open_uri" -> {
                    publishedObservation.set(PublishedObservation())
                    textResult(openUri(args))
                }
                "browser_use" -> browserUse(args, toolCall.id)
                "web_search", "fetch_url" -> {
                    if (!browserToolsEnabled()) textResult(errorResult("BROWSER_TOOLS_DISABLED", "请先启用网页搜索、读取与浏览器工具"))
                    else textResult(webTools.execute(toolCall.name, args))
                }
                "observe_screen" -> observeScreen(args, guiGeneration)
                "release_gui" -> {
                    publishedObservation.set(PublishedObservation())
                    guiControl?.release()
                    textResult(JSONObject().put("ok", true).put("tool", "release_gui").toString())
                }
                "tap" -> afterAction(tap(args))
                "tap_area" -> afterAction(tapArea(args))
                "tap_element" -> afterAction(tapElement(args))
                "long_press" -> afterAction(longPress(args))
                "long_press_element" -> afterAction(longPressElement(args))
                "swipe" -> afterAction(swipe(args))
                "scroll" -> afterAction(deviceController.scroll(args.optString("direction"), args.optString("amount"), currentActiveDisplayId()))
                "scroll_element" -> afterAction(scrollElement(args))
                "type_text" -> afterAction(typeText(args))
                // 旧会话或旧入口仍可能请求这些工具名；保留执行路径，但不再出现在模型目录里。
                "input_text" -> afterAction(inputText(args))
                "replace_text" -> afterAction(replaceText(args))
                "clear_text" -> afterAction(clearText(args))
                "set_clipboard" -> textResult(setClipboard(args))
                "get_clipboard" -> textResult(getClipboard())
                "paste_text" -> afterAction(pasteText(args))
                "press_key" -> afterAction(deviceController.pressKey(args.optString("button"), currentActiveDisplayId()))
                "wait" -> textResult(deviceController.waitMs(args.optInt("duration_ms", 1_000)))
                "wait_for_text" -> textResult(waitForText(args))
                "wait_for_package" -> textResult(waitForPackage(args))
                "open_system_panel" -> {
                    publishedObservation.set(PublishedObservation())
                    activeDisplayId = Display.DEFAULT_DISPLAY
                    textResult(deviceController.openSystemPanel(args.optString("panel")))
                }
                in DEVICE_TOOL_NAMES ->
                    structuredDeviceTools.execute(toolCall.name, args)
                        ?: textResult(errorResult("UNKNOWN_TOOL", "未知设备工具"))
                "read_image" -> fileVisionTool { imageTools.readImage(args) }
                in AgentTerminalToolCatalog.names -> textResult(terminalTool {
                    if (toolCall.name == "terminal" && args.optString("action").equals("check_root", ignoreCase = true)) checkRoot()
                    else terminalController.executeTool(toolCall.name, args)
                })
                in AgentFileToolCatalog.names -> textResult(terminalTool { terminalController.fileTool(toolCall.name, args) })
                "memory_get" -> textResult(memoryGet(args))
                "memory_write" -> textResult(memoryWrite(args))
                "skills_list" -> textResult(skillsList(args))
                "skills_read" -> textResult(skillsRead(args))
                "skills_read_resource" -> textResult(skillsReadResource(args))
                "skills_list_curated" -> textResult(skillsListCurated())
                "skills_inspect_github" -> textResult(skillsInspectGitHub(args))
                "skills_install_from_github" -> textResult(skillsInstallFromGitHub(args))
                else -> textResult(
                    errorResult(
                        code = "UNKNOWN_TOOL",
                        message = "未知工具：${toolCall.name}"
                    )
                )
            }
        }.getOrElse { throwable ->
            if (throwable is AgentRunCancelledException) throw throwable
            textResult(
                errorResult(
                    code = when (throwable) {
                        is InvalidToolArgumentException, is org.json.JSONException -> "INVALID_ARGUMENT"
                        is DeviceControlUnavailableException -> "ACCESSIBILITY_UNAVAILABLE"
                        is ActiveDisplayUnavailableException -> "DISPLAY_UNAVAILABLE"
                        else -> "TOOL_ERROR"
                    },
                    message = throwable.message ?: throwable.javaClass.simpleName
                )
            )
        }.let { result ->
            if (result.sensitive || !AgentSensitiveToolPolicy.isSensitive(toolCall.name)) {
                result
            } else {
                result.copy(sensitive = true)
            }
        }

    private fun executeForegroundIntent(toolName: String, action: () -> JSONObject): JSONObject {
        fun execute(): JSONObject {
            if (closed.get()) throw AgentRunCancelledException()
            if (!isToolEnabled(toolName)) {
                return JSONObject(errorResult("TOOL_DISABLED", "工具 $toolName 已在工具列表中关闭，本次未执行"))
            }
            deviceToolPermissionError(toolName)?.let { return JSONObject(it.content) }
            return when (val decision = beforeToolExecution(toolName)) {
                ToolExecutionDecision.Allow -> {
                    publishedObservation.set(PublishedObservation())
                    action()
                }
                is ToolExecutionDecision.Reject -> JSONObject(errorResult(decision.code, decision.message))
            }
        }
        return guiControl?.withAction { execute() } ?: execute()
    }

    private fun deviceToolPermissionError(
        toolName: String,
    ): AgentModelClient.ToolResult? {
        val error = when {
            toolName in DEVICE_DIRECT_TOOL_NAMES && !deviceDirectToolsEnabled() ->
                "DEVICE_DIRECT_TOOLS_DISABLED" to "请先启用设备直达工具"
            toolName in DEVICE_SENSITIVE_READ_TOOL_NAMES && !deviceSensitiveReadToolsEnabled() ->
                "DEVICE_SENSITIVE_READ_TOOLS_DISABLED" to "请先允许读取敏感设备信息"
            toolName in DEVICE_SENSITIVE_ACTION_TOOL_NAMES && !deviceSensitiveActionToolsEnabled() ->
                "DEVICE_SENSITIVE_ACTION_TOOLS_DISABLED" to "请先允许敏感设备操作"
            else -> null
        } ?: return null
        return AgentModelClient.ToolResult(
            content = errorResult(error.first, error.second),
            sensitive = toolName in DEVICE_SENSITIVE_READ_TOOL_NAMES ||
                toolName in DEVICE_SENSITIVE_ACTION_TOOL_NAMES,
        )
    }

    private fun terminalTool(block: () -> String): String {
        if (!terminalToolsEnabled()) {
            return errorResult("TERMINAL_TOOLS_DISABLED", "请先启用终端/文件工具")
        }
        return block()
    }

    private fun fileVisionTool(block: () -> AgentModelClient.ToolResult): AgentModelClient.ToolResult {
        if (!terminalToolsEnabled()) {
            return textResult(errorResult("TERMINAL_TOOLS_DISABLED", "请先启用终端/文件工具"))
        }
        return block()
    }

    private fun memoryToolPermissionError(toolName: String): AgentModelClient.ToolResult? {
        if (toolName == "memory_write" && !memoryWritable) {
            return AgentModelClient.ToolResult(
                content = errorResult("REAL_MEMORY_READ_ONLY", "角色会话的现实记忆只读；剧情请使用角色记忆工具"),
                sensitive = true,
            )
        }
        if (toolName !in MEMORY_TOOL_NAMES || memoryToolsEnabled()) return null
        return AgentModelClient.ToolResult(
            content = errorResult("MEMORY_DISABLED", "记忆已在设置中关闭"),
            sensitive = true,
        )
    }

    private fun memoryGet(args: JSONObject): String = try {
        val result = AgentMemoryRepository.read(
            query = args.optString("query").takeIf(String::isNotBlank),
            startLine = args.optInt("start_line", 1),
            maxChars = args.optInt("max_chars", 12_000),
        )
        JSONObject()
            .put("ok", true)
            .put("revision", result.snapshot.revision)
            .put("bytes", result.snapshot.byteSize)
            .put("line_count", result.snapshot.lineCount)
            .put("start_line", result.startLine ?: JSONObject.NULL)
            .put("end_line", result.endLine ?: JSONObject.NULL)
            .put("matched_lines", result.matchedLines)
            .put("has_more", result.hasMore)
            .put("content", result.content)
            .toString()
    } catch (failure: AgentMemoryException) {
        errorResult(failure.code, failure.message ?: "记忆读取失败")
    }

    private fun memoryWrite(args: JSONObject): String = try {
        val revision = args.getString("revision")
        val mutation = when (args.getString("mode")) {
            "replace_range" -> AgentMemoryMutation.ReplaceRange(
                revision = revision,
                startLine = args.getInt("start_line"),
                endLine = args.getInt("end_line"),
                content = args.requiredText("content"),
            )
            "append" -> AgentMemoryMutation.Append(
                revision = revision,
                content = args.requiredText("content"),
            )
            "clear" -> AgentMemoryMutation.Clear(revision)
            else -> error("不支持的记忆写入模式")
        }
        when (val result = AgentMemoryRepository.mutate(mutation)) {
            is AgentMemoryWriteResult.Success -> JSONObject()
                .put("ok", true)
                .put("revision", result.snapshot.revision)
                .put("bytes", result.snapshot.byteSize)
                .put("line_count", result.snapshot.lineCount)
                .toString()
            is AgentMemoryWriteResult.Conflict -> JSONObject()
                .put("ok", false)
                .put("code", "MEMORY_CONFLICT")
                .put("message", "记忆已发生变化，请先调用 memory_get 获取最新内容")
                .put("revision", result.snapshot.revision)
                .put("bytes", result.snapshot.byteSize)
                .put("line_count", result.snapshot.lineCount)
                .toString()
        }
    } catch (failure: AgentMemoryException) {
        errorResult(failure.code, failure.message ?: "记忆写入失败")
    }

    private fun browserUse(args: JSONObject, toolCallId: String): AgentModelClient.ToolResult {
        if (!browserToolsEnabled()) {
            return textResult(errorResult("BROWSER_TOOLS_DISABLED", "请先启用网页浏览工具"))
        }
        val result = browserSessionRef.value.execute(
            context = context,
            args = args,
            runId = browserRunId,
            toolCallId = toolCallId,
            checkCancellation = { if (closed.get()) throw AgentRunCancelledException() },
        )
        return AgentModelClient.ToolResult(
            content = result.content,
            images = result.images.map { image ->
                AgentModelClient.ModelImage(
                    reference = image.dataUrl,
                    mimeType = image.mimeType,
                    bytes = image.bytes,
                    width = image.width,
                    height = image.height,
                    source = "agent_browser",
                    preserveOriginal = true,
                )
            },
        )
    }

    private fun currentActiveDisplayId(): Int {
        val id = activeDisplayId
        if (!CanvasRoutingPolicy.isVirtualDisplay(id)) return Display.DEFAULT_DISPLAY
        val vd = VirtualDisplayController.snapshots.value
        return if (vd.active && vd.displayId == id) {
            id
        } else {
            publishedObservation.set(PublishedObservation())
            throw ActiveDisplayUnavailableException()
        }
    }

    private fun checkCancellation() {
        if (closed.get() || Thread.currentThread().isInterrupted) throw AgentRunCancelledException()
    }

    private fun publishObservation(observation: PublishedObservation) {
        checkCancellation()
        publishedObservation.set(observation)
        if (closed.get() || Thread.currentThread().isInterrupted) {
            publishedObservation.compareAndSet(observation, PublishedObservation())
            throw AgentRunCancelledException()
        }
    }

    private fun observeScreen(args: JSONObject, generation: Long?): AgentModelClient.ToolResult {
        publishedObservation.set(PublishedObservation())
        val startedAt = SystemClock.elapsedRealtime()
        val options = AgentScreenObservationContract.resolve(args)
        val displayId = currentActiveDisplayId()
        val observation = screenObservationProvider?.invoke(options)
            ?: deviceController.observe(
                includeScreenshot = options.includeScreenshot,
                includeUiTree = options.includeUiTree,
                maxNodes = options.maxNodes,
                displayId = displayId,
            )
        publishObservation(
            PublishedObservation(
                elements = observation.elementObservation,
                coordinateSpace = observation.coordinateSpace,
                generation = generation.takeIf { JSONObject(observation.content).optBoolean("ok") },
            ),
        )
        logger.debug {
            "Agent local tool action=observe_screen outcome=completed " +
                "display=$displayId observation=${observation.elementObservation?.id} " +
                "nodes=${observation.elementObservation?.nodes?.size ?: 0} " +
                "image=${observation.image?.bytes ?: 0} elapsed_ms=${SystemClock.elapsedRealtime() - startedAt} " +
                "coordinate=${observation.coordinateSpace?.summary()}"
        }
        return AgentModelClient.ToolResult(
            content = observation.content,
            images = listOfNotNull(observation.image)
        )
    }

    /**
     * 成功的 GUI 动作附带一次轻量观察：只读 UI 树、不截图，节点数减半。
     * 模型据此确认动作生效并直接用新的 observation_id 继续操作，不必再单独 observe_screen；
     * 失败或结果未知的动作不附带，保持"先重新观察"的既有约束。
     */
    private fun afterAction(raw: String): AgentModelClient.ToolResult {
        checkCancellation()
        val result = runCatching { JSONObject(raw) }.getOrNull()
        if (result == null || !result.optBoolean("ok")) return textResult(raw)
        val before = publishedObservation.get().elements
        val after = runCatching {
            val displayId = currentActiveDisplayId()
            screenObservationProvider?.invoke(AFTER_ACTION_OPTIONS)
                ?: deviceController.observe(
                    includeScreenshot = false,
                    includeUiTree = true,
                    maxNodes = AFTER_ACTION_OPTIONS.maxNodes,
                    displayId = displayId,
                )
        }.getOrElse { throwable ->
            publishedObservation.set(PublishedObservation())
            checkCancellation()
            if (throwable is AgentRunCancelledException) throw throwable
            logger.debug { "Agent local tool after-action observation failed: type=${throwable.javaClass.simpleName}" }
            RootShellDeviceController.Observation(
                content = JSONObject()
                    .put("ok", false)
                    .put("ui_tree_status", "query_failed")
                    .put("code", if (throwable is ActiveDisplayUnavailableException) "DISPLAY_UNAVAILABLE" else "OBSERVATION_FAILED")
                    .put("ui_tree_note", "动作已执行，但后续观察失败；旧节点与坐标已失效，请先重新观察，不要重复动作")
                    .toString(),
                image = null,
                coordinateSpace = null,
                elementObservation = null,
            )
        }
        // 新快照取代动作前的快照：旧 index 在界面变化后本就不可靠，继续保留只会让模型误用。
        publishObservation(
            if (after.elementObservation == null) PublishedObservation()
            else publishedObservation.get().copy(elements = after.elementObservation, coordinateSpace = after.coordinateSpace),
        )
        result.put("after", AgentAfterActionSummary.build(before, after))
        return textResult(result.toString())
    }

    private fun tap(args: JSONObject): String {
        val displayId = currentActiveDisplayId()
        val point = convertPoint(
            x = args.getInt("x"),
            y = args.getInt("y"),
            coordinateSpace = args.optString("coordinate_space"),
            displayId = displayId,
        )
        return clearOverlay(displayId, point) {
            if (!CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
                AgentHapticFeedback.perform(context, AgentHapticFeedback.Type.TAP)
            }
            showTap(point.x, point.y, displayId)
            deviceController.tap(point.x, point.y, displayId)
        }
    }

    private fun tapArea(args: JSONObject): String {
        val displayId = currentActiveDisplayId()
        val x1 = args.getInt("x1")
        val y1 = args.getInt("y1")
        val x2 = args.getInt("x2")
        val y2 = args.getInt("y2")
        val coordinateSpace = args.optString("coordinate_space")
        val first = convertPoint(x1, y1, coordinateSpace, displayId)
        val second = convertPoint(x2, y2, coordinateSpace, displayId)
        val point = ScreenPoint(
            x = ((first.x.toLong() + second.x.toLong()) / 2L).toInt(),
            y = ((first.y.toLong() + second.y.toLong()) / 2L).toInt(),
        )
        return clearOverlay(displayId, point) {
            if (!CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
                AgentHapticFeedback.perform(context, AgentHapticFeedback.Type.TAP)
            }
            showTap(point.x, point.y, displayId)
            deviceController.tap(point.x, point.y, displayId)
        }
    }

    private fun tapElement(args: JSONObject): String {
        val displayId = currentActiveDisplayId()
        val index = args.optInt("index", -1)
        val observation = requireElementObservation(args) ?: return observationError(args)
        val node = observation.nodes.firstOrNull { it.index == index }
        if (node == null) {
            return errorResult("INVALID_NODE_INDEX", "观察快照中不存在节点 index=$index")
        }
        val result = clearOverlay(displayId, ScreenPoint(node.centerX, node.centerY)) {
            deviceController.tapElement(observation, index)
        }
        if (result.isOkJson()) {
            if (!CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
                AgentHapticFeedback.perform(context, AgentHapticFeedback.Type.TAP)
            }
            showTap(node.centerX, node.centerY, displayId)
        }
        return result
    }

    private fun longPressElement(args: JSONObject): String {
        val displayId = currentActiveDisplayId()
        val index = args.optInt("index", -1)
        val observation = requireElementObservation(args) ?: return observationError(args)
        val node = observation.nodes.firstOrNull { it.index == index }
        val durationMs = args.optInt("duration_ms", 800)
        if (node == null) {
            return errorResult("INVALID_NODE_INDEX", "观察快照中不存在节点 index=$index")
        }
        val result = clearOverlay(displayId, ScreenPoint(node.centerX, node.centerY)) {
            deviceController.longPressElement(observation, index, durationMs)
        }
        if (result.isOkJson()) {
            if (!CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
                AgentHapticFeedback.perform(context, AgentHapticFeedback.Type.LONG_PRESS)
            }
            showLongPress(node.centerX, node.centerY, durationMs, displayId)
        }
        return result
    }

    private fun longPress(args: JSONObject): String {
        val displayId = currentActiveDisplayId()
        val point = convertPoint(
            x = args.getInt("x"),
            y = args.getInt("y"),
            coordinateSpace = args.optString("coordinate_space"),
            displayId = displayId,
        )
        val durationMs = args.optInt("duration_ms", 800)
        return clearOverlay(displayId, point) {
            if (!CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
                AgentHapticFeedback.perform(context, AgentHapticFeedback.Type.LONG_PRESS)
            }
            showLongPress(point.x, point.y, durationMs, displayId)
            deviceController.longPress(point.x, point.y, durationMs, displayId)
        }
    }

    private fun swipe(args: JSONObject): String {
        val displayId = currentActiveDisplayId()
        val start = convertPoint(
            x = args.getInt("x1"),
            y = args.getInt("y1"),
            coordinateSpace = args.optString("coordinate_space"),
            displayId = displayId,
        )
        val end = convertPoint(
            x = args.getInt("x2"),
            y = args.getInt("y2"),
            coordinateSpace = args.optString("coordinate_space"),
            displayId = displayId,
        )
        val durationMs = args.optInt("duration_ms", 500)
        return clearOverlay(displayId, start, end) {
            if (!CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
                AgentHapticFeedback.perform(context, AgentHapticFeedback.Type.SWIPE)
            }
            showSwipe(start.x, start.y, end.x, end.y, durationMs, displayId)
            deviceController.swipe(
                start.x,
                start.y,
                end.x,
                end.y,
                durationMs,
                displayId,
            )
        }
    }

    private fun scrollElement(args: JSONObject): String {
        val observation = requireElementObservation(args) ?: return observationError(args)
        return deviceController.scrollElement(
            observation = observation,
            index = args.optInt("index", -1),
            direction = args.optString("direction"),
            amount = args.optString("amount"),
        )
    }

    /**
     * 统一的文本输入：replace（默认）整体替换为 text，text 为空即清空；append 在光标处插入。
     * 指定 index 时先确认节点来自最近一次观察；不指定时作用于当前输入焦点。
     * submit=true 在写入成功后按输入法回车，用于搜索、发送等提交动作。
     */
    private fun typeText(args: JSONObject): String {
        val displayId = currentActiveDisplayId()
        val text = args.requiredText("text")
        val mode = args.optString("mode", "replace").trim().lowercase(Locale.ROOT).ifBlank { "replace" }
        val written = when (mode) {
            "replace" -> replaceText(args)
            "append" -> {
                if (text.isEmpty()) return errorResult("INVALID_ARGUMENT", "append 模式的 text 不能为空")
                if (args.optNullableInt("index") != null) {
                    return errorResult("INVALID_ARGUMENT", "append 只作用于当前输入焦点；要写入指定输入框请用 mode=replace")
                }
                // 长文本走选区插入加粘贴回退，比逐字键入更稳定。
                if (text.length > TYPE_TEXT_INCREMENTAL_CHARS) pasteText(args) else deviceController.inputText(text, displayId)
            }
            else -> return errorResult("INVALID_ARGUMENT", "mode 只能是 replace 或 append")
        }
        val json = runCatching { JSONObject(written) }.getOrNull() ?: return written
        json.put("tool", "type_text").put("mode", mode)
        if (!json.optBoolean("ok") || !args.optBoolean("submit")) return json.toString()
        val submitted = runCatching { JSONObject(deviceController.pressKey("ENTER", displayId)) }.getOrNull()
        json.put("submitted", submitted?.optBoolean("ok") == true)
        if (submitted?.optBoolean("ok") != true) {
            // 文本已写入但提交失败：整体仍算成功，避免模型重复输入；由 submitted=false 提示单独补按回车或点按钮。
            json.put("submit_error", submitted?.optString("code").orEmpty().ifBlank { "SUBMIT_FAILED" })
        }
        return json.toString()
    }

    private fun inputText(args: JSONObject): String {
        val text = args.requiredText("text")
        if (text.length > 1_000) {
            return errorResult("TEXT_TOO_LONG", "input_text 最多支持 1000 个字符")
        }
        return when (args.optString("mode", "append").lowercase(Locale.ROOT)) {
            "replace" -> replaceText(args)
            "paste" -> pasteText(args)
            else -> deviceController.inputText(text, currentActiveDisplayId())
        }
    }

    private fun replaceText(args: JSONObject): String {
        val index = args.optNullableInt("index")
        val observation = if (index != null) {
            requireElementObservation(args) ?: return observationError(args)
        } else {
            null
        }
        return deviceController.replaceText(
            text = args.requiredText("text"),
            index = index,
            observation = observation,
            displayId = currentActiveDisplayId(),
        )
    }

    private fun clearText(args: JSONObject): String {
        val index = args.optNullableInt("index")
        val observation = if (index != null) {
            requireElementObservation(args) ?: return observationError(args)
        } else {
            null
        }
        return deviceController.clearText(index = index, observation = observation, displayId = currentActiveDisplayId())
    }

    private fun setClipboard(args: JSONObject): String =
        deviceController.clipboardSet(requireContext(), args.requiredText("text"))

    private fun getClipboard(): String =
        deviceController.clipboardGet(requireContext())

    private fun pasteText(args: JSONObject): String =
        deviceController.pasteText(args.requiredText("text"), currentActiveDisplayId())

    private fun waitForText(args: JSONObject): String =
        deviceController.waitForText(
            text = args.requiredText("text"),
            timeoutMs = args.optInt("timeout_ms", 10_000),
            includeDesc = args.optBoolean("include_desc", true),
            matchMode = args.optString("match", "contains"),
            displayId = currentActiveDisplayId(),
        )

    private fun waitForPackage(args: JSONObject): String =
        deviceController.waitForPackage(
            packageName = args.optString("package_name"),
            timeoutMs = args.optInt("timeout_ms", 10_000),
            displayId = currentActiveDisplayId(),
        )

    /**
     * 坐标系必须显式声明。旧版按"上一次观察是否带截图"隐式切换默认值，模型无从得知，
     * 经常把截图像素当成屏幕像素；缺省时直接报参数错误，让模型在下一步改正。
     */
    private fun convertPoint(
        x: Int,
        y: Int,
        coordinateSpace: String,
        displayId: Int = Display.DEFAULT_DISPLAY,
    ): ScreenPoint {
        val space = publishedObservation.get().coordinateSpace
        val requestedSpace = coordinateSpace.trim().lowercase(Locale.ROOT)
        if (requestedSpace.isBlank()) {
            throw InvalidToolArgumentException(
                "缺少 coordinate_space：看截图定位用 normalized（0–999），坐标来自 ui_nodes 用 screen",
            )
        }
        if (requestedSpace == "normalized") {
            if (x !in 0..NORMALIZED_MAX || y !in 0..NORMALIZED_MAX) {
                throw InvalidToolArgumentException("normalized 坐标必须在 0–$NORMALIZED_MAX 之间：($x,$y)")
            }
            val (width, height) = space?.let { it.screenWidth to it.screenHeight }
                ?: deviceController.screenDimensions(displayId)
            return ScreenPoint(
                x = (x.toLong() * (width - 1) / NORMALIZED_MAX).toInt(),
                y = (y.toLong() * (height - 1) / NORMALIZED_MAX).toInt(),
            )
        }
        if (requestedSpace == "screen") {
            val (width, height) = space?.let { it.screenWidth to it.screenHeight }
                ?: deviceController.screenDimensions(displayId)
            if (x !in 0 until width || y !in 0 until height) {
                throw InvalidToolArgumentException(
                    "屏幕坐标超出范围：($x,$y) not in ${width}x$height",
                )
            }
            return ScreenPoint(x, y)
        }
        if (requestedSpace != "screenshot") {
            throw InvalidToolArgumentException("coordinate_space 只能是 normalized、screen 或 screenshot")
        }
        if (space == null) {
            throw InvalidToolArgumentException(
                "最近一次观察没有附图，没有 screenshot 坐标系；看截图定位请用 normalized，或先带截图重新观察",
            )
        }
        val point = runCatching { space.fromScreenshot(x, y) }
            .getOrElse { throwable ->
                throw InvalidToolArgumentException(
                    throwable.message ?: "截图坐标超出范围",
                )
            }
        return ScreenPoint(point.x, point.y)
    }

    private fun searchApps(args: JSONObject): String {
        val query = args.optString("query").trim()
        if (query.isBlank()) {
            return errorResult("INVALID_ARGUMENT", "query 不能为空")
        }
        val includeSystem = args.optBoolean("include_system", false)
        val limit = args.optInt("limit", 10).coerceIn(1, 20)
        val apps = findAppsByName(query, includeSystem).take(limit)
        return JSONObject()
            .put("ok", true)
            .put("tool", "search_apps")
            .put("query", query)
            .put("apps", apps.toJsonArray())
            .toString()
    }

    private fun launchApp(args: JSONObject): String {
        val packageName = args.optString("package_name").trim().ifBlank { null }
        val appName = args.optString("app_name").trim().ifBlank { null }
        val requestedDisplay = CanvasRoutingPolicy.RequestedDisplay.parse(
            args.optString("display", "auto"),
        ) ?: return errorResult("INVALID_ARGUMENT", "display 仅支持 auto、virtual 或 main")

        val app = if (packageName != null) {
            findAppByPackage(packageName) ?: AppInfo(packageName = packageName, appName = appName ?: packageName)
        } else {
            if (appName == null) {
                return errorResult("INVALID_ARGUMENT", "package_name 和 app_name 至少提供一个")
            }
            val matches = findAppsByName(appName, includeSystem = false)
            val exactMatches = matches.filter { it.appName.equals(appName, ignoreCase = true) }
            when {
                exactMatches.size == 1 -> exactMatches.single()
                matches.size == 1 -> matches.single()
                matches.isEmpty() -> return errorResult(
                    code = "APP_NOT_FOUND",
                    message = "未找到应用：$appName"
                )
                else -> return JSONObject()
                    .put("ok", false)
                    .put("code", "AMBIGUOUS_APP")
                    .put("message", "匹配到多个应用，请指定 package_name")
                    .put("candidates", matches.take(10).toJsonArray())
                    .toString()
            }
        }

        val context = requireContext()
        val launchIntent = context.packageManager.getLaunchIntentForPackage(app.packageName)
        if (launchIntent == null) {
            return errorResult(
                code = "APP_NOT_LAUNCHABLE",
                message = "应用不可启动或未安装：${app.packageName}"
            )
        }
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)

        if (virtualDisplayEnabled() && requestedDisplay != CanvasRoutingPolicy.RequestedDisplay.MAIN && !rootAvailable()) {
            io.github.mangi.eta.agent.device.RootAccess.awaitOrRetryIfPreviouslyGranted(context)
        }
        val mainForegroundPkg = AgentAccessibilityService.current()?.currentPackageName(Display.DEFAULT_DISPLAY)
        val launchPlan = CanvasRoutingPolicy.decideLaunchPlan(
            virtualDisplayEnabled = virtualDisplayEnabled(),
            backendAvailable = VirtualDisplayController.isBackendAvailable(rootAvailable(), lsposedAvailable()),
            requested = requestedDisplay,
            targetPackage = app.packageName,
            foregroundPackageOnMainDisplay = mainForegroundPkg,
            ownPackage = context.packageName,
        )

        val launchedVirtualId = if (launchPlan.target == CanvasRoutingPolicy.CanvasTarget.VIRTUAL_DISPLAY) {
            VirtualDisplayController.launchAppOnVirtualDisplay(
                context = context,
                packageName = app.packageName,
                appName = app.appName,
                launchIntent = launchIntent,
                rootAvailable = rootAvailable,
                checkCancellation = ::checkCancellation,
            )
        } else {
            null
        }

        val finalDisplayId = if (launchedVirtualId != null && CanvasRoutingPolicy.isVirtualDisplay(launchedVirtualId)) {
            activeDisplayId = launchedVirtualId
            launchedVirtualId
        } else {
            checkCancellation()
            activeDisplayId = Display.DEFAULT_DISPLAY
            context.startActivity(launchIntent)
            Display.DEFAULT_DISPLAY
        }
        val finalCanvas = if (CanvasRoutingPolicy.isVirtualDisplay(finalDisplayId)) {
            CanvasRoutingPolicy.CanvasTarget.VIRTUAL_DISPLAY.wireName
        } else {
            CanvasRoutingPolicy.CanvasTarget.MAIN_DISPLAY.wireName
        }
        val canvasReason = if (finalCanvas == CanvasRoutingPolicy.CanvasTarget.VIRTUAL_DISPLAY.wireName) {
            launchPlan.reason
        } else if (launchPlan.target == CanvasRoutingPolicy.CanvasTarget.VIRTUAL_DISPLAY) {
            "virtual_create_failed"
        } else {
            launchPlan.reason
        }

        val verification = AppLaunchVerification.awaitWindow(
            packageName = app.packageName,
            displayId = finalDisplayId,
            query = { remainingMillis ->
                AgentAccessibilityService.current()?.observeNodeSnapshot(
                    maxNodes = 1,
                    displayId = finalDisplayId,
                    includeNodes = false,
                    timeoutMillis = remainingMillis,
                ) ?: AgentAccessibilityService.NodeSnapshotObservation(
                    status = AgentAccessibilityService.NodeSnapshotStatus.SERVICE_UNAVAILABLE,
                    snapshot = null,
                    window = null,
                )
            },
            checkCancellation = ::checkCancellation,
        )
        logger.info(
            "Agent local tool action=launch_app outcome=${verification.launchStatus} " +
                "canvas=$finalCanvas reason=$canvasReason display=$finalDisplayId " +
                "root=${io.github.mangi.eta.agent.device.RootAccess.state.value.status.name.lowercase()} " +
                "lsposed=${lsposedAvailable()}",
        )
        return JSONObject()
            .put("ok", true)
            .put("tool", "launch_app")
            .put("app_name", app.appName)
            .put("package_name", app.packageName)
            .put("canvas", finalCanvas)
            .put("canvas_reason", canvasReason)
            .put("display_id", finalDisplayId)
            .put("launch_status", verification.launchStatus)
            .put("window_observation", verification.toJson())
            .apply {
                if (!verification.confirmed) {
                    put("note", "启动请求已提交，但尚未确认目标窗口；请先观察当前画布，不要直接重放启动或点击")
                }
            }
            .toString()
    }

    private fun presentToUser(args: JSONObject): String {
        val context = requireContext()
        val reason = args.optString("reason").trim()
        val vdSnapshot = VirtualDisplayController.snapshots.value
        val wasVirtual = vdSnapshot.active || CanvasRoutingPolicy.isVirtualDisplay(activeDisplayId)
        val presented = if (wasVirtual) {
            VirtualDisplayController.handoffToMainDisplay(context, rootAvailable)
        } else {
            true
        }
        activeDisplayId = Display.DEFAULT_DISPLAY
        return JSONObject()
            .put("ok", true)
            .put("tool", "present_to_user")
            .put("canvas", CanvasRoutingPolicy.CanvasTarget.MAIN_DISPLAY.wireName)
            .put("display_id", Display.DEFAULT_DISPLAY)
            .put("presented", presented)
            .apply {
                if (vdSnapshot.appName.isNotBlank()) put("app_name", vdSnapshot.appName)
                if (vdSnapshot.packageName.isNotBlank()) put("package_name", vdSnapshot.packageName)
                if (reason.isNotBlank()) put("reason", reason)
            }
            .toString()
    }

    private fun openUri(args: JSONObject): String {
        val uriText = args.optString("uri").trim()
        if (uriText.isBlank()) {
            return errorResult("INVALID_ARGUMENT", "uri 不能为空")
        }
        val uri = Uri.parse(uriText)
        if (uri.scheme.isNullOrBlank()) {
            return errorResult("INVALID_ARGUMENT", "uri 缺少 scheme")
        }
        val context = requireContext()
        val intent = Intent(Intent.ACTION_VIEW, uri)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (!HookSupport.resolvesActivity(context, intent)) {
            return errorResult("NO_ACTIVITY", "没有应用可以处理该 URI")
        }
        if (virtualDisplayEnabled() && !rootAvailable()) {
            io.github.mangi.eta.agent.device.RootAccess.awaitOrRetryIfPreviouslyGranted(context)
        }
        val resolvedPkg = context.packageManager.resolveActivity(intent, 0)?.activityInfo?.packageName
        val mainForegroundPkg = AgentAccessibilityService.current()?.currentPackageName(Display.DEFAULT_DISPLAY)
        val launchPlan = CanvasRoutingPolicy.decideLaunchPlan(
            virtualDisplayEnabled = virtualDisplayEnabled(),
            backendAvailable = VirtualDisplayController.isBackendAvailable(rootAvailable(), lsposedAvailable()),
            requested = CanvasRoutingPolicy.RequestedDisplay.AUTO,
            targetPackage = resolvedPkg,
            foregroundPackageOnMainDisplay = mainForegroundPkg,
            ownPackage = context.packageName,
        )
        val virtualId = if (launchPlan.target == CanvasRoutingPolicy.CanvasTarget.VIRTUAL_DISPLAY) {
            VirtualDisplayController.openUriOnVirtualDisplay(
                context = context,
                intent = intent,
                targetLabel = uri.host ?: uri.scheme.orEmpty(),
                rootAvailable = rootAvailable,
                checkCancellation = ::checkCancellation,
            )
        } else {
            null
        }
        val finalDisplayId = if (virtualId != null && CanvasRoutingPolicy.isVirtualDisplay(virtualId)) {
            activeDisplayId = virtualId
            virtualId
        } else {
            checkCancellation()
            activeDisplayId = Display.DEFAULT_DISPLAY
            context.startActivity(intent)
            Display.DEFAULT_DISPLAY
        }
        val finalCanvas = if (CanvasRoutingPolicy.isVirtualDisplay(finalDisplayId)) {
            CanvasRoutingPolicy.CanvasTarget.VIRTUAL_DISPLAY.wireName
        } else {
            CanvasRoutingPolicy.CanvasTarget.MAIN_DISPLAY.wireName
        }
        val canvasReason = if (finalCanvas == CanvasRoutingPolicy.CanvasTarget.VIRTUAL_DISPLAY.wireName) {
            launchPlan.reason
        } else if (launchPlan.target == CanvasRoutingPolicy.CanvasTarget.VIRTUAL_DISPLAY) {
            "virtual_create_failed"
        } else {
            launchPlan.reason
        }
        logger.info("Agent local tool action=open_uri outcome=started canvas=$finalCanvas reason=$canvasReason")
        return JSONObject()
            .put("ok", true)
            .put("tool", "open_uri")
            .put("scheme", uri.scheme?.lowercase(Locale.ROOT))
            .put("canvas", finalCanvas)
            .put("canvas_reason", canvasReason)
            .put("display_id", finalDisplayId)
            .also { result ->
                if (uri.scheme.equals("https", true)) {
                    result.put("display_uri", uriText)
                }
            }
            .toString()
    }

    private fun checkRoot(): String {
        val probe = RootAccess.request(requireContext())
        kotlinx.coroutines.runBlocking {
            while (probe.isActive && !closed.get()) kotlinx.coroutines.delay(100)
        }
        if (closed.get()) return errorResult("CANCELLED", "已取消等待 Root 检测")
        val state = RootAccess.state.value
        return JSONObject().put("ok", true).put("tool", "terminal").put("action", "check_root")
            .put("root_available", state.isGranted).put("status", state.status.name.lowercase(Locale.ROOT))
            .put("checking", state.isChecking).put("su_present", state.suPresent)
            .put("uid", if (state.isGranted) 0 else JSONObject.NULL)
            .put("message", if (state.isGranted) "已确认 Root 授权；后续新命令默认使用 Root" else
                "尚未确认 Root 授权；请根据 status 检查授权或检测结果，默认 user 不表示终端不支持 Root")
            .toString()
    }

    private fun findAppByPackage(packageName: String): AppInfo? =
        installedLauncherApps().firstOrNull { it.packageName == packageName }

    private fun findAppsByName(query: String, includeSystem: Boolean): List<AppInfo> {
        val normalizedQuery = query.normalized()
        return installedLauncherApps()
            .asSequence()
            .filter { includeSystem || !it.isSystemApp }
            .mapNotNull { app ->
                val score = app.matchScore(query, normalizedQuery)
                if (score == Int.MAX_VALUE) null else score to app
            }
            .sortedWith(compareBy<Pair<Int, AppInfo>> { it.first }.thenBy { it.second.appName })
            .map { it.second }
            .toList()
    }

    private fun AppInfo.matchScore(rawQuery: String, normalizedQuery: String): Int {
        val normalizedName = appName.normalized()
        val normalizedPackage = packageName.normalized()
        return when {
            packageName.equals(rawQuery, ignoreCase = true) -> 0
            appName.equals(rawQuery, ignoreCase = true) -> 1
            normalizedName == normalizedQuery -> 2
            normalizedPackage.contains(normalizedQuery) -> 3
            normalizedName.contains(normalizedQuery) -> 4
            else -> Int.MAX_VALUE
        }
    }

    private fun installedLauncherApps(): List<AppInfo> {
        val context = requireContext()
        val packageManager = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolveInfos = packageManager.queryIntentActivities(
            intent,
            PackageManager.ResolveInfoFlags.of(0L)
        )
        val apps = linkedMapOf<String, AppInfo>()
        resolveInfos.forEach { resolveInfo ->
            val activityInfo = resolveInfo.activityInfo ?: return@forEach
            val applicationInfo = activityInfo.applicationInfo ?: return@forEach
            val packageName = applicationInfo.packageName ?: return@forEach
            val appName = resolveInfo.loadLabel(packageManager).toString().trim()
                .takeIf { it.isNotBlank() }
                ?: packageName
            apps.putIfAbsent(
                packageName,
                AppInfo(
                    packageName = packageName,
                    appName = appName,
                    isSystemApp = applicationInfo.flags and ApplicationInfo.FLAG_SYSTEM != 0
                )
            )
        }
        return apps.values.toList()
    }

    private fun requireContext(): Context =
        AgentAppContext.resolve()
            ?: error("无法获取 Android 进程 Context")

    private fun List<AppInfo>.toJsonArray(): JSONArray =
        JSONArray().also { array ->
            forEach { app ->
                array.put(
                    JSONObject()
                        .put("app_name", app.appName)
                        .put("package_name", app.packageName)
                        .put("is_system_app", app.isSystemApp)
                )
            }
        }

    private fun String.normalized(): String =
        trim().lowercase(Locale.ROOT)

    private fun String.isOkJson(): Boolean =
        runCatching { JSONObject(this).optBoolean("ok", false) }.getOrDefault(false)

    private fun JSONObject.optNullableInt(name: String): Int? =
        if (has(name) && !isNull(name)) optInt(name) else null

    private fun requireElementObservation(
        args: JSONObject,
    ): RootShellDeviceController.ElementObservation? {
        val current = publishedObservation.get().elements ?: return null
        val requestedId = args.optString("observation_id").trim()
        return current.takeIf {
            ObservationReferencePolicy.validate(current.id, requestedId) ==
                ObservationReferencePolicy.Status.MATCH
        }
    }

    private fun observationError(args: JSONObject): String {
        val current = publishedObservation.get().elements
        val requestedId = args.optString("observation_id").trim()
        return when (ObservationReferencePolicy.validate(current?.id, requestedId)) {
            ObservationReferencePolicy.Status.NO_OBSERVATION ->
                errorResult("NO_OBSERVATION", "请先调用 observe_screen 获取 UI 节点")
            ObservationReferencePolicy.Status.ID_REQUIRED -> errorResult(
                "OBSERVATION_ID_REQUIRED",
                "节点动作必须携带同一次 observe_screen 返回的 observation_id",
            )
            ObservationReferencePolicy.Status.STALE -> errorResult(
                "STALE_OBSERVATION",
                "observation_id=$requestedId 已过期；当前为 ${current?.id}，请重新观察屏幕",
            )
            ObservationReferencePolicy.Status.MATCH -> errorResult(
                "OBSERVATION_ERROR",
                "观察快照状态异常，请重新观察屏幕",
            )
        }
    }

    // ==================== Skills tools ====================

    private fun skillsList(args: JSONObject): String {
        if (skillTreeMutationUncertain.get()) return nextTurnRequired("Skill 树")
        val indexService = skillIndexService
            ?: return errorResult("SKILLS_UNAVAILABLE", "技能服务未初始化")
        val query = args.optString("query").trim().lowercase()
        val limit = args.optInt("limit", 50).coerceIn(1, 200)
        val entries = indexService.listInstalledSkills()
            .filter { entry -> SkillCompatibilityChecker.evaluate(entry).available }
            .filter { entry -> isVisibleInCurrentRun(entry.id) }
            .filter { entry ->
                if (query.isBlank()) true
                else listOf(entry.id, entry.name, entry.description, entry.skillFilePath, entry.rootPath)
                    .any { it.lowercase().contains(query) }
            }
            .take(limit)
        val items = JSONArray()
        entries.forEach { entry ->
            val capabilities = JSONArray()
            if (entry.hasScripts) capabilities.put("scripts")
            if (entry.hasReferences) capabilities.put("references")
            if (entry.hasAssets) capabilities.put("assets")
            if (entry.hasEvals) capabilities.put("evals")
            items.put(
                JSONObject()
                    .put("id", entry.id)
                    .put("name", entry.name)
                    .put("description", entry.description)
                    .put("enabled", entry.enabled)
                    .put("source", entry.source)
                    .put("rootPath", entry.rootPath)
                    .put("skillFilePath", entry.skillFilePath)
                    .put("capabilities", capabilities)
            )
        }
        return JSONObject()
            .put("ok", true)
            .put("query", query)
            .put("count", entries.size)
            .put("items", items)
            .toString()
    }

    private fun skillsRead(args: JSONObject): String {
        if (skillTreeMutationUncertain.get()) return nextTurnRequired("Skill 树")
        val indexService = skillIndexService
            ?: return errorResult("SKILLS_UNAVAILABLE", "技能服务未初始化")
        val loader = skillLoader
            ?: return errorResult("SKILLS_UNAVAILABLE", "技能加载器未初始化")
        val skillId = args.optString("skillId").trim()
        if (skillId.isBlank()) return errorResult("MISSING_PARAM", "缺少 skillId")
        val maxChars = args.optInt("maxChars", 16_000).coerceIn(512, 64_000)
        val entry = indexService.findInstalledSkill(skillId)
            ?: return errorResult("NOT_FOUND", "未找到 skill：$skillId")
        if (!isVisibleInCurrentRun(entry.id)) return nextTurnRequired(entry.id)
        val compat = SkillCompatibilityChecker.evaluate(entry)
        if (!compat.available) return errorResult("INCOMPATIBLE", compat.reason ?: "当前环境不可用")
        val resolved = loader.load(entry, "agent 主动读取 skill")
            ?: return errorResult("READ_FAILED", "读取 SKILL.md 失败：${entry.skillFilePath}")
        val body = if (resolved.bodyMarkdown.length <= maxChars) {
            resolved.bodyMarkdown
        } else {
            resolved.bodyMarkdown.take(maxChars) + "\n..."
        }
        val references = JSONArray()
        resolved.loadedReferences.forEach { references.put(it) }
        val frontmatter = JSONObject()
        resolved.frontmatter.forEach { (k, v) -> frontmatter.put(k, v) }
        return JSONObject()
            .put("ok", true)
            .put("id", entry.id)
            .put("name", entry.name)
            .put("description", entry.description)
            .put("rootPath", entry.rootPath)
            .put("skillFilePath", entry.skillFilePath)
            .put("scriptsDir", resolved.scriptsDir ?: JSONObject.NULL)
            .put("assetsDir", resolved.assetsDir ?: JSONObject.NULL)
            .put("references", references)
            .put("frontmatter", frontmatter)
            .put("bodyMarkdown", body)
            .toString()
    }

    private fun skillsReadResource(args: JSONObject): String {
        if (skillTreeMutationUncertain.get()) return nextTurnRequired("Skill 树")
        val indexService = skillIndexService
            ?: return errorResult("SKILLS_UNAVAILABLE", "技能服务未初始化")
        val reader = skillResourceReader
            ?: return errorResult("SKILLS_UNAVAILABLE", "Skill 资源读取器未初始化")
        val skillId = args.getString("skillId").trim()
        val relativePath = args.getString("relativePath").trim()
        val maxChars = args.optInt("maxChars", 16_000).coerceIn(512, 64_000)
        val entry = indexService.findInstalledSkill(skillId)
            ?: return errorResult("NOT_FOUND", "未找到已启用 Skill：$skillId")
        if (!isVisibleInCurrentRun(entry.id)) return nextTurnRequired(entry.id)
        val compatibility = SkillCompatibilityChecker.evaluate(entry)
        if (!compatibility.available) {
            return errorResult(
                "INCOMPATIBLE",
                compatibility.reason ?: "当前环境不可用",
            )
        }
        return when (val result = reader.readText(entry, relativePath)) {
            is SkillResourceReadResult.Success -> {
                val truncated = result.text.length > maxChars
                val visibleText = if (truncated) {
                    result.text.take(maxChars).let { prefix ->
                        if (prefix.lastOrNull()?.isHighSurrogate() == true) {
                            prefix.dropLast(1)
                        } else {
                            prefix
                        }
                    }
                } else {
                    result.text
                }
                JSONObject()
                    .put("ok", true)
                    .put("skillId", entry.id)
                    .put("relativePath", result.relativePath)
                    .put("text", visibleText)
                    .put("truncated", truncated)
                    .put("totalChars", result.text.length)
                    .toString()
            }
            is SkillResourceReadResult.Failure -> errorResult(
                code = result.error.code.name,
                message = result.error.message,
            )
        }
    }

    private fun skillsListCurated(): String {
        val source = githubSkillSource
            ?: return errorResult("SKILL_INSTALLER_UNAVAILABLE", "GitHub Skill 服务未初始化")
        return skillSourceResult {
            val inspection = source.listCurated()
            rememberInspection(
                repository = GitHubSkillRepositoryParser.parse(inspection.repository),
                inspection = inspection,
                rememberDefault = true,
            )
            inspectionResult(inspection)
        }
    }

    private fun skillsInspectGitHub(args: JSONObject): String {
        val source = githubSkillSource
            ?: return errorResult("SKILL_INSTALLER_UNAVAILABLE", "GitHub Skill 服务未初始化")
        return skillSourceResult {
            val repository = GitHubSkillRepositoryParser.resolve(
                repository = args.getString("repository"),
                explicitRef = args.optString("ref").takeIf { args.has("ref") },
                explicitPath = args.optString("path").takeIf { args.has("path") },
            )
            val inspection = source.inspect(repository)
            rememberInspection(
                repository = repository,
                inspection = inspection,
                rememberDefault = repository.ref == null,
            )
            inspectionResult(inspection)
        }
    }

    private fun skillsInstallFromGitHub(args: JSONObject): String {
        val replaceExisting = args.optBoolean("replaceExisting", false)
        return skillSourceResult {
            val requestedRepository = GitHubSkillRepositoryParser.resolve(
                repository = args.getString("repository"),
                explicitRef = args.optString("ref").takeIf { args.has("ref") },
                explicitPath = null,
            )
            val pathsJson = args.getJSONArray("paths")
            val selectedPaths = (0 until pathsJson.length()).map { index ->
                GitHubSkillRepositoryParser.normalizeRelativePath(pathsJson.getString(index))
            }
            if (replaceExisting && selectedPaths.size != 1) {
                return@skillSourceResult errorResult(
                    "SKILL_REPLACE_SCOPE_TOO_BROAD",
                    "一次只能替换一个 Skill 路径；请逐个重试",
                )
            }
            val expectedReplacementId = args.optString("expectedReplacementId").trim()
            val repository = if (replaceExisting) {
                validateReplacementReplay(
                    requestedRepository = requestedRepository,
                    selectedPaths = selectedPaths,
                    expectedReplacementId = expectedReplacementId,
                )?.let { return@skillSourceResult it }
                requestedRepository.copy(ref = pendingSkillConflict.get()!!.commitSha)
            } else {
                val snapshot = inspectedGitHubSnapshots[
                    inspectionKey(requestedRepository.slug, requestedRepository.ref)
                ] ?: return@skillSourceResult errorResult(
                    "SKILL_INSPECTION_REQUIRED",
                    "安装前必须在本轮先检查同一仓库与 ref 的 Skill 候选",
                )
                val invalidSelection = selectedPaths.firstOrNull {
                    it !in snapshot.candidatesByPath
                }
                if (invalidSelection != null) {
                    return@skillSourceResult errorResult(
                        "INVALID_SKILL_SELECTION",
                        "所选路径不在本轮检查返回的候选中：$invalidSelection",
                    )
                }
                val snapshotPrefix = snapshot.prefix
                if (
                    snapshotPrefix != null &&
                    selectedPaths.any {
                        it != snapshotPrefix && !it.startsWith("$snapshotPrefix/")
                    }
                ) {
                    return@skillSourceResult errorResult(
                        "INVALID_SKILL_SELECTION",
                        "所选路径不在本轮检查的目录范围内",
                    )
                }
                requestedRepository.copy(ref = snapshot.commitSha)
            }
            val prefix = requestedRepository.path?.takeUnless { it == "." }
            if (
                prefix != null &&
                selectedPaths.any { it != prefix && !it.startsWith("$prefix/") }
            ) {
                return@skillSourceResult errorResult(
                    "INVALID_SKILL_SELECTION",
                    "所选路径不在 GitHub URL 指定目录内",
                )
            }
            val source = githubSkillSource
                ?: return@skillSourceResult errorResult(
                    "SKILL_INSTALLER_UNAVAILABLE",
                    "GitHub Skill 服务未初始化",
                )
            val installer = skillPackageInstaller
                ?: return@skillSourceResult errorResult(
                    "SKILL_INSTALLER_UNAVAILABLE",
                    "Skill 安装器未初始化",
                )
            source.downloadArchive(repository).use { archive ->
                if (closed.get()) {
                    return@skillSourceResult errorResult(
                        "SKILL_INSTALL_CANCELLED",
                        "Skill 安装已取消，未提交文件",
                    )
                }
                val result = installer.installRepositoryZip(
                    openStream = { archive.file.inputStream() },
                    selectedPaths = selectedPaths,
                    replaceUserSkills = replaceExisting,
                    expectedReplacementIds = if (replaceExisting) {
                        setOf(expectedReplacementId)
                    } else {
                        emptySet()
                    },
                    isCancelled = closed::get,
                )
                installResult(
                    result = result,
                    repository = archive.repository,
                    ref = archive.ref,
                    commitSha = archive.commitSha,
                    selectedPaths = selectedPaths,
                )
            }
        }
    }

    private fun inspectionResult(
        inspection: io.github.mangi.eta.agent.skill.GitHubSkillInspection,
    ): String {
        val installedIds = skillIndexService
            ?.listSkillsForManagement()
            .orEmpty()
            .filter { it.installed }
            .mapTo(mutableSetOf()) { SkillParser.normalizeSkillLookup(it.id) }
        val items = JSONArray()
        inspection.candidates.forEach { candidate ->
            items.put(
                JSONObject()
                    .put("name", candidate.name)
                    .put("path", candidate.path)
                    .put(
                        "installed",
                        SkillParser.normalizeSkillLookup(candidate.name) in installedIds,
                    ),
            )
        }
        return JSONObject()
            .put("ok", true)
            .put("repository", inspection.repository)
            .put("ref", inspection.ref)
            .put("commitSha", inspection.commitSha)
            .put("prefix", inspection.prefix ?: JSONObject.NULL)
            .put("count", inspection.candidates.size)
            .put("items", items)
            .toString()
    }

    private fun rememberInspection(
        repository: GitHubSkillRepository,
        inspection: GitHubSkillInspection,
        rememberDefault: Boolean,
    ) {
        val snapshot = GitHubInspectionSnapshot(
            commitSha = inspection.commitSha,
            prefix = inspection.prefix,
            candidatesByPath = inspection.candidates.associate { it.path to it.name },
        )
        inspectedGitHubSnapshots[inspectionKey(repository.slug, repository.ref)] = snapshot
        inspectedGitHubSnapshots[inspectionKey(repository.slug, inspection.ref)] = snapshot
        inspectedGitHubSnapshots[inspectionKey(repository.slug, inspection.commitSha)] = snapshot
        if (rememberDefault) {
            inspectedGitHubSnapshots[inspectionKey(repository.slug, null)] = snapshot
        }
    }

    private fun inspectionKey(repository: String, ref: String?): String =
        "${repository.lowercase(Locale.ROOT)}@${ref.orEmpty()}"

    private fun validateReplacementReplay(
        requestedRepository: GitHubSkillRepository,
        selectedPaths: List<String>,
        expectedReplacementId: String,
    ): String? {
        val pending = pendingSkillConflict.get() ?: return errorResult(
            "SKILL_REPLACE_CAPABILITY_REQUIRED",
            "没有可供精确重放的 Skill 冲突",
        )
        if (
            !requestedRepository.slug.equals(pending.repository, ignoreCase = true) ||
            requestedRepository.ref != pending.commitSha ||
            selectedPaths.singleOrNull() != pending.selectedPath ||
            expectedReplacementId != pending.expectedReplacementId
        ) {
            return errorResult(
                "SKILL_REPLACE_CAPABILITY_MISMATCH",
                "覆盖参数必须精确重放冲突结果中的仓库、commitSha、路径与 Skill ID",
            )
        }
        return null
    }

    private fun isVisibleInCurrentRun(skillId: String): Boolean {
        val normalized = SkillParser.normalizeSkillLookup(skillId)
        return normalized in runAvailableSkillIds && normalized !in mutatedSkillIds
    }

    private fun nextTurnRequired(skillId: String): String = errorResult(
        "NEXT_TURN_REQUIRED",
        "Skill $skillId 在本轮已安装或变更，将从下一轮对话开始可用",
    )

    private fun installResult(
        result: SkillInstallResult,
        repository: String,
        ref: String,
        commitSha: String,
        selectedPaths: List<String>,
    ): String = when (result) {
        is SkillInstallResult.Success -> {
            pendingSkillConflict.set(null)
            val installed = JSONArray()
            result.installed.forEach { skill ->
                mutatedSkillIds += SkillParser.normalizeSkillLookup(skill.id)
                installed.put(
                    JSONObject()
                        .put("id", skill.id)
                        .put("name", skill.name),
                )
            }
            JSONObject()
                .put("ok", true)
                .put("repository", repository)
                .put("ref", ref)
                .put("commitSha", commitSha)
                .put("selectedPaths", JSONArray(selectedPaths))
                .put("installed", installed)
                .put("available", "next_turn")
                .put("scriptsExecuted", false)
                .put("message", "Skill 已安装并启用，将从下一轮对话开始可用；安装过程未执行脚本")
                .toString()
        }
        is SkillInstallResult.Conflict -> {
            val conflicts = JSONArray()
            result.conflicts.forEach { conflict ->
                conflicts.put(
                    JSONObject()
                        .put("id", conflict.id)
                        .put("name", conflict.name)
                        .put("replaceAllowed", conflict.replaceAllowed),
                )
            }
            pendingSkillConflict.set(
                result.conflicts.singleOrNull()
                    ?.takeIf { it.replaceAllowed && selectedPaths.size == 1 }
                    ?.let { conflict ->
                        PendingSkillConflictCapability(
                            repository = repository,
                            commitSha = commitSha,
                            selectedPath = selectedPaths.single(),
                            expectedReplacementId = conflict.id,
                            expectedReplacementName = conflict.name,
                        )
                    },
            )
            JSONObject()
                .put("ok", false)
                .put("code", "SKILL_CONFLICT")
                .put("message", "Skill 已存在；可替换的单个用户 Skill 可按返回参数直接重试，内置 Skill 不可覆盖")
                .put("repository", repository)
                .put("ref", ref)
                .put("commitSha", commitSha)
                .put("selectedPaths", JSONArray(selectedPaths))
                .put("conflicts", conflicts)
                .toString()
        }
        is SkillInstallResult.Failure -> {
            if (result.error.code == SkillInstallErrorCode.COMMIT_FAILED) {
                skillTreeMutationUncertain.set(true)
            }
            errorResult(
                code = result.error.code.name,
                message = result.error.message,
            )
        }
    }

    private inline fun skillSourceResult(block: () -> String): String = try {
        block()
    } catch (failure: GitHubSkillSourceException) {
        errorResult(failure.code, failure.message ?: "GitHub Skill 请求失败")
    }

    private fun errorResult(code: String, message: String): String =
        JSONObject()
            .put("ok", false)
            .put("code", code)
            .put("message", message)
            .toString()

    private fun readStockChart(args: JSONObject): String {
        val limit = if (args.has("limit")) args.optInt("limit", 160) else 160
        val symbol = args.optString("symbol").trim()
        val link = io.github.mangi.eta.ui.stock.StockChartLink
        if (symbol.isNotEmpty()) {
            // ★ 境外品种（纳指/伦敦金/美股）走不了面板：前端 smartbox 和 K 线请求只认 A 股。
            //   早识别早报错，并明确指引到能用的工具，而不是让用户"换成6位代码"——
            //   伦敦金根本没有 6 位代码，那句话会把用户带进死胡同。
            if (io.github.mangi.eta.ui.stock.StockKlineSource.isGlobalCode(symbol)) {
                val std = io.github.mangi.eta.ui.stock.StockGlobalSource.resolve(symbol)
                    ?: symbol
                return errorResult(
                    "USE_ANALYZE_CHAN",
                    "「$symbol」是境外品种（${io.github.mangi.eta.ui.stock.StockGlobalSource.displayName(std)}），" +
                        "K 线面板只支持 A 股，无法切换。请改用 analyze_chan（symbol 填 $std）分析——" +
                        "它原生取数，不需要面板，同样能给笔/中枢/背驰。",
                )
            }
            val switched = link.switchTo(symbol)
            if (switched == null) {
                return errorResult(
                    "SWITCH_FAILED",
                    "没能把 K 线面板切到「$symbol」：可能搜不到这只，或面板还在加载。" +
                        "换 6 位代码（如 300274）再调用一次。",
                )
            }
            if (!switched.ok) {
                return errorResult(
                    "SYMBOL_NOT_FOUND",
                    "搜不到「$symbol」对应的股票（${switched.reason.ifBlank { "no-match" }}）。" +
                        "请换成 6 位代码或准确简称再试。",
                )
            }
        } else if (!link.ensureReady()) {
            return errorResult(
                "NO_CHART",
                "K 线面板没能加载出数据（可能断网或行情接口失败），先让用户稍后再试，不要凭空编造行情。",
            )
        }
        val periodArg = args.optString("period").trim()
        if (periodArg.isNotEmpty()) {
            val normalized = link.normalizePeriod(periodArg) ?: return errorResult(
                "BAD_PERIOD",
                "period 只支持 分时/minute、5m、15m、30m、60m、日线/day、周线/week、月线/month。",
            )
            if (!link.switchPeriod(normalized)) {
                return errorResult(
                    "PERIOD_FAILED",
                    "K 线面板没能切到 $normalized 级别（可能行情接口超时）。稍等再调用一次，或先用当前级别分析。" +
                        "不要假装看过那个级别。",
                )
            }
        }
        val snapshot = link.snapshot(limit)
        if (snapshot.isNullOrBlank()) {
            return errorResult(
                "NO_DATA",
                "面板已经打开，但当前还没有 K 线数据可读：稍等一两秒再调用一次。",
            )
        }
        return snapshot
    }

    /**
     * 多级别走势：原生取数，完全不碰 WebView。
     *
     * 面板是否展开、当前停在哪个级别，都与本工具无关 —— 这是它和 stock_chart_read 的
     * 根本区别。stock_chart_read 是「看用户眼前这张图」，本工具是「自己把数拉出来算」。
     */
    /**
     * 缠论分析（原生自主取数）。
     *
     * 与 [readStockChart] 的区别：**完全不碰 K 线面板**——自己调行情接口取数、
     * 自己跑 Kotlin 引擎、自己渲染摘要。面板没开、面板上是别的票、甚至面板正在加载，
     * 都不影响结果。所以 AI 问「300274 周线现在有几个中枢」时不需要先切面板。
     *
     * 根数固定 640（腾讯日线上限）：喂得太少时 BARSLAST/SUMBARS 在序列左端没有历史，
     * 会凭空造出中枢，这是图上「最左边多一个框」的根因。
     */
    private fun analyzeChan(args: JSONObject): String {
        val symbolArg = args.optString("symbol").trim()
        val code: String
        val name: String
        if (symbolArg.isNotEmpty()) {
            val resolved = io.github.mangi.eta.ui.stock.StockKlineSource.resolve(symbolArg)
                ?: return errorResult(
                    "SYMBOL_NOT_FOUND",
                    "搜不到「$symbolArg」。请换成 6 位代码（如 300274）或准确的股票简称再调用一次，" +
                        "不要拿别的股票的数据代替。",
                )
            code = resolved.code
            name = resolved.name
        } else {
            // 没点名就用面板当前那只；面板也没选就报错，不瞎猜
            val cur = io.github.mangi.eta.ui.stock.StockChartLink.panelCode
            if (cur.isBlank()) {
                return errorResult(
                    "NO_TARGET",
                    "用户没有指定股票，K 线面板也没有选中标的。请先问清是哪只股票再调用。",
                )
            }
            code = cur
            name = io.github.mangi.eta.ui.stock.StockChartLink.panelName
        }

        val periodArg = args.optString("period").trim()
        val period = if (periodArg.isEmpty()) {
            "day"
        } else {
            io.github.mangi.eta.ui.stock.StockKlineSource.validPeriod(periodArg)
                ?: return errorResult(
                    "BAD_PERIOD",
                    "period 只支持 minute / 5m / 15m / 30m / 60m / day / week / month。",
                )
        }

        val text = io.github.mangi.eta.ui.stock.StockChanSource.analyzeText(
            context,
            code,
            period,
            io.github.mangi.eta.ui.stock.StockChanSource.DEFAULT_BARS,
        )
        val head = if (name.isNotBlank()) "$name（${code.uppercase()}）" else code.uppercase()
        return "标的：$head\n$text"
    }

    // ==================== 决策留痕 ====================

    private fun journalPrefs() =
        context.getSharedPreferences("stock_trade_journal", Context.MODE_PRIVATE)

    private fun readJournal(): String =
        journalPrefs().getString("data", "{}") ?: "{}"

    private fun writeJournal(s: String) {
        journalPrefs().edit().putString("data", s).apply()
    }

    /** 模型给出可执行建议时存一条。只在字段齐全时记录，避免存一堆废话。 */
    private fun saveDecision(args: JSONObject): String {
        val code = args.optString("code").trim()
        val action = args.optString("action").trim().lowercase()
        val price = args.optDouble("price", 0.0)
        if (code.isBlank() || action.isBlank() || price <= 0) {
            return errorResult(
                "BAD_ARGS",
                "记录建议需要 code（代码）、action（buy/sell/watch）、price（价位）。" +
                    "只在给出可执行建议时才记录，闲聊不用调用。",
            )
        }
        val entry = JSONObject()
            .put("time", args.optString("time").ifBlank { nowText() })
            .put("code", code.uppercase())
            .put("name", args.optString("name").trim())
            .put("action", action)
            .put("price", price)
            .put("stop", args.optDouble("stop", Double.NaN).let { if (it.isFinite()) it else null })
            .put("level", args.optString("level").trim())
            .put("confidence", args.optString("confidence").trim())
            .put("reason", args.optString("reason").trim())
            .put("boxPosition", args.optString("box_position").trim())
        val store = readJournal()
        val updated = io.github.mangi.eta.ui.stock.TradeJournal.append(
            store, io.github.mangi.eta.ui.stock.TradeJournal.Kind.DECISION, entry,
        )
        writeJournal(updated)
        val n = io.github.mangi.eta.ui.stock.TradeJournal.total(updated)
        return "已记录账本第 $n 条（建议）：$code $action @$price。以后可以让我复盘。"
    }

    /** 用户实际成交时记一条——这是算真实盈亏的前提。 */
    private fun recordTrade(args: JSONObject): String {
        val code = args.optString("code").trim()
        val side = args.optString("side").trim().lowercase()
        val price = args.optDouble("price", 0.0)
        val qty = args.optDouble("qty", 0.0)
        if (code.isBlank() || (side != "buy" && side != "sell") || price <= 0 || qty <= 0) {
            return errorResult(
                "BAD_ARGS",
                "记录成交需要 code（代码）、side（buy/sell）、price（成交价）、qty（股数）。" +
                    "这些都是用户告诉你的真实数据——不确定就不要记，不要替用户编。",
            )
        }
        val entry = JSONObject()
            .put("time", args.optString("time").ifBlank { nowText() })
            .put("code", code.uppercase())
            .put("name", args.optString("name").trim())
            .put("side", side)
            .put("price", price)
            .put("qty", qty)
        val store = readJournal()
        val updated = io.github.mangi.eta.ui.stock.TradeJournal.append(
            store, io.github.mangi.eta.ui.stock.TradeJournal.Kind.TRADE, entry,
        )
        writeJournal(updated)
        val n = io.github.mangi.eta.ui.stock.TradeJournal.total(updated)
        return "已记录成交：$code $side ${qty.toLong()} 股 @$price。当前账本共 $n 条。"
    }

    /** 复盘：查建议 + 算真实盈亏。默认不进上下文，只有用户问才调。 */
    private fun reviewTrades(args: JSONObject): String {
        val code = args.optString("code").trim()
        val store = readJournal()
        if (io.github.mangi.eta.ui.stock.TradeJournal.total(store) == 0) {
            return "账本还是空的。模型给建议时用 save_decision 记，用户成交时用 record_trade 记。"
        }
        val sb = StringBuilder()
        if (code.isNotBlank()) {
            val history = io.github.mangi.eta.ui.stock.TradeJournal.query(
                store, null, code, args.optInt("limit", 20).coerceIn(1, 100),
            )
            sb.append("【$code 历史记录】\n").append(history).append("\n\n")
        }
        sb.append(io.github.mangi.eta.ui.stock.TradeJournal.review(store, code.ifBlank { null }))
        return sb.toString()
    }

    private fun nowText(): String =
        java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.getDefault())
            .format(java.util.Date())

    /**
     * 基本面快照（P1）。估值 + 最近几期财报 + 龙虎榜，全部来自东方财富公开接口，免登录。
     *
     * 覆盖技能文档 fundamental-analysis 要求的 `get_fundamental`。
     * **没有**营收增速、一致预期、股东明细、公告原文的数据源——这些字段不会出现在输出里。
     */
    private fun getFundamental(args: JSONObject): String {
        val symbolArg = args.optString("symbol").trim()
        val code: String
        val name: String
        if (symbolArg.isNotEmpty()) {
            val resolved = io.github.mangi.eta.ui.stock.StockKlineSource.resolve(symbolArg)
                ?: return errorResult(
                    "SYMBOL_NOT_FOUND",
                    "搜不到「$symbolArg」。请换成 6 位代码（如 300274）或准确的股票简称再调用一次。",
                )
            code = resolved.code
            name = resolved.name
        } else {
            val cur = io.github.mangi.eta.ui.stock.StockChartLink.panelCode
            if (cur.isBlank()) {
                return errorResult("NO_TARGET", "用户没有指定股票，K 线面板也没有选中标的。请先问清是哪只股票。")
            }
            code = cur
            name = io.github.mangi.eta.ui.stock.StockChartLink.panelName
        }
        val periods = args.optInt("periods", 4).coerceIn(1, 8)
        val text = io.github.mangi.eta.ui.stock.StockFundamentalSource.summary(code, name, periods)
        return "标的：$code\n$text"
    }

    /**
     * 解析自选股存储，兼容三种历史格式：
     *   v1 裸数组 `[{code,name}]`
     *   v2/v3 对象 `{v,groups,list,group}` —— 自选在 **list** 字段
     *
     * 解析不出来返回 null（调用方据此报错），而不是静默返回空列表——
     * 静默返回空会让用户以为"自选是空的"，其实是读错了字段。
     */
    private fun parseWatchlist(raw: String): org.json.JSONArray? {
        val t = raw.trim()
        if (t.isEmpty()) return org.json.JSONArray()
        return try {
            if (t.startsWith("[")) {
                org.json.JSONArray(t)
            } else {
                val o = org.json.JSONObject(t)
                val list = o.optJSONArray("list")
                if (list != null) {
                    list
                } else {
                    // v2 可能把自选放在别的键上，兜底扫一遍找第一个数组
                    var found: org.json.JSONArray? = null
                    for (k in o.keys()) {
                        val v = o.optJSONArray(k)
                        if (v != null && (v.length() == 0 || v.optJSONObject(0)?.has("code") == true)) {
                            found = v
                            break
                        }
                    }
                    found
                }
            }
        } catch (_: Throwable) {
            null
        }
    }

    /** 多标的基本面横向对比，只比同一报告期（P1）。 */
    private fun compareFundamental(args: JSONObject): String {
        val raw = args.optString("symbols").trim()
        val codes = if (raw.isEmpty()) {
            val arr = args.optJSONArray("symbols")
            (0 until (arr?.length() ?: 0)).map { arr.optString(it).trim() }
                .filter { it.isNotEmpty() }
        } else {
            raw.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        }
        if (codes.isEmpty()) {
            return errorResult("BAD_ARGS", "symbols 不能为空。传 2~4 个 6 位代码，用逗号分隔。")
        }
        if (codes.size > 4) {
            return errorResult("BAD_ARGS", "一次最多对比 4 只，避免输出过长。当前给了 ${codes.size} 只。")
        }
        val resolved = codes.mapNotNull { sym ->
            io.github.mangi.eta.ui.stock.StockKlineSource.resolve(sym)
        }
        if (resolved.isEmpty()) {
            return errorResult("SYMBOL_NOT_FOUND", "这些代码都没搜到，请换成准确的 6 位代码。")
        }
        val nameMap = resolved.associate { it.code to it.name }
        val text = io.github.mangi.eta.ui.stock.StockFundamentalSource.compare(
            resolved.map { it.code }, nameMap,
        )
        return text
    }

    /** 大盘概览（P2）：主要指数点位与涨跌幅。板块排行与市场宽度暂无可用数据源。 */
    private fun marketOverview(args: JSONObject): String =
        io.github.mangi.eta.ui.stock.StockFundamentalSource.marketOverview()

    /**
     * 自选股批量巡检（P3）。逐只取行情与结构，输出紧凑表格。
     *
     * 只取「收盘 + 涨跌幅 + 结构方向 + 是否有信号」，不铺全量分析，
     * 这样 20 只票也能在上下文里装得下，模型再对有信号的几只深入。
     */
    private fun scanWatchlist(args: JSONObject): String {
        val periodArg = args.optString("period").trim()
        val period = if (periodArg.isEmpty()) "day" else {
            io.github.mangi.eta.ui.stock.StockKlineSource.validPeriod(periodArg)
                ?: return errorResult(
                    "BAD_PERIOD",
                    "period 只支持 minute / 5m / 15m / 30m / 60m / day / week / month。",
                )
        }

        val raw = context.getSharedPreferences("stock_ai_prefs", Context.MODE_PRIVATE)
            .getString("watchlist", "[]") ?: "[]"
        // ★ 落盘格式必须按 groups.js 的 load() 来解析，不能只当数组读。
        //   前端 save() 存的是 {v:3, groups:[], list:[], group:"all"}，
        //   真正的自选在 **list** 字段里；v1 时代才是裸数组。原来只读顶层数组，
        //   于是永远是空数组 → 稳定返回 NO_WATCHLIST（线上踩过）。
        val arr = parseWatchlist(raw)
            ?: return errorResult(
                "NO_WATCHLIST",
                "自选股列表读不出来（存储格式异常）。请让用户先在自选里加股票。",
            )
        if (arr.length() == 0) {
            return errorResult("NO_WATCHLIST", "自选股列表是空的。请让用户先添加股票再巡检。")
        }

        // 先收集 (code, name)，再并发跑；不要边读边串行请求
        val items = ArrayList<Triple<String, String, String>>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val rawCode = o.optString("code").trim().lowercase()
            val num = rawCode.replace(Regex("^[a-z]+"), "")
            if (!num.matches(Regex("\\d{6}"))) continue
            // ★ 必须保留市场前缀（sz000001 / sh000001）。
            //   剥成裸 000001 会撞车：平安银行是 sz000001，上证指数是 sh000001，
            //   下游按首位数字推断会把 000001 当成上证指数。
            val withMarket = if (rawCode.matches(Regex("[a-z]{2}\\d{6}"))) rawCode else num
            items.add(Triple(withMarket, o.optString("name").trim(), rawCode))
        }
        if (items.isEmpty()) {
            return errorResult("NO_WATCHLIST", "自选股里没有可识别的 6 位代码。请让用户重新添加股票。")
        }

        val rows = io.github.mangi.eta.ui.stock.StockLevels.scanMany(items, period)
        val sb = StringBuilder()
        sb.append("自选股巡检（").append(items.size).append(" 只，级别 ").append(period).append("）：\n")
        for (row in rows) {
            sb.append("  ").append(row.render()).append('\n')
        }
        // ★ 成败直接看结构化字段，不要去解析渲染后的字符串（旧实现用 contains("取数失败")
        //   判断，只要股票简称里带这几个字就会误判）。
        val failed = rows.filter { !it.ok }.map { it.code }
        val okCount = rows.count { it.ok }
        sb.append("\n成功 ").append(okCount).append(" 只")
        if (failed.isNotEmpty()) {
            sb.append("，取数失败：").append(failed.joinToString("、"))
            sb.append("（这些不要凭空推断）")
        }
        if (items.size > rows.size) {
            sb.append("\n注意：自选共 ").append(items.size)
                .append(" 只，本次只巡检前 ").append(rows.size).append(" 只。")
        }
        sb.append("\n提示：对「有信号」的标的，再用 get_fundamental / analyze_chan 深入。")
        return sb.toString()
    }

    private fun stockLevels(args: JSONObject): String {
        val link = io.github.mangi.eta.ui.stock.StockChartLink

        // 1) 确定标的：用户点名了就查名字，没点名就用面板当前那只
        val symbolArg = args.optString("symbol").trim()
        val code: String
        val name: String
        if (symbolArg.isNotEmpty()) {
            val resolved = io.github.mangi.eta.ui.stock.StockKlineSource.resolve(symbolArg)
                ?: return errorResult(
                    "SYMBOL_NOT_FOUND",
                    "搜不到「$symbolArg」。请换成 6 位代码（如 300274）或准确的股票简称再调用一次，" +
                        "不要用别的股票的数据代替。",
                )
            code = resolved.code
            name = resolved.name
        } else {
            val cur = link.panelCode
            if (cur.isBlank()) {
                return errorResult(
                    "NO_TARGET",
                    "用户没有指定股票，K 线面板也没有选中标的。请先问清是哪只股票，" +
                        "或让用户打开 K 线面板选一只。",
                )
            }
            code = cur
            name = link.panelName
        }

        // 2) 级别：模型给什么就用什么，不传才用默认三档
        val rawPeriods = mutableListOf<String>()
        val arr = args.optJSONArray("periods")
        if (arr != null) {
            for (i in 0 until arr.length()) {
                val p = arr.optString(i).trim()
                if (p.isNotEmpty()) rawPeriods.add(p)
            }
        }
        val periods = if (rawPeriods.isEmpty()) {
            io.github.mangi.eta.ui.stock.StockLevels.DEFAULT_LEVELS
        } else {
            rawPeriods
        }
        val normalized = periods.mapNotNull { io.github.mangi.eta.ui.stock.StockKlineSource.validPeriod(it) }
        if (normalized.isEmpty()) {
            return errorResult(
                "BAD_PERIOD",
                "periods 里没有一个合法级别。可用：week / day / m60 / m30 / m15 / m5 / month。",
            )
        }

        // 3) 取数并汇总
        val text = io.github.mangi.eta.ui.stock.StockLevels.digest(code, normalized)
        if (text.isBlank()) {
            return errorResult("NO_DATA", "所有级别都没取到数据，可能是行情接口不可用；不要凭空推断。")
        }
        val head = if (name.isNotBlank()) "$name（${code.uppercase()}）" else code.uppercase()
        return "标的：$head\n" + text
    }

    /** 把模型给的标注 JSON 画到 K 线面板上；面板没打开会先自己打开。 */    private fun annotateStockChart(args: JSONObject): String {
        val json = args.optString("annotation_json").trim()
        if (json.isEmpty()) return errorResult("BAD_ARGS", "annotation_json 不能为空")
        if (!json.startsWith("{")) return errorResult("BAD_ARGS", "annotation_json 必须是 JSON 对象")
        val periodArg = args.optString("period").trim()
        if (periodArg.isNotEmpty()) {
            val normalized = io.github.mangi.eta.ui.stock.StockChartLink.normalizePeriod(periodArg)
            if (normalized == null) {
                return errorResult("BAD_PERIOD", "period 只支持 分时/minute、5m、15m、30m、60m、日线/day、周线/week、月线/month。")
            }
            if (!io.github.mangi.eta.ui.stock.StockChartLink.switchPeriod(normalized)) {
                return errorResult("PERIOD_FAILED", "面板没能切到 $normalized 级别，标注没有画。")
            }
        }
        val result = io.github.mangi.eta.ui.stock.StockChartLink.annotate(json)
        if (result == null) {
            return errorResult(
                "NO_CHART",
                "K 线面板没能加载出来，标注没有画上；告诉用户这次没画成，不要声称已标注。",
            )
        }
        if (!result.startsWith("ok")) {
            return errorResult(
                "ANNOTATE_REJECTED",
                "页面拒绝了这段标注（$result）：检查 price 是否在可见区间、date 是否与 K 线时间格式一致" +
                    "（日线 2026-11-12，分钟 2026-11-12 10:30），marks 的 price 要落在该根 K 线的最高最低之间。",
            )
        }
        val note = args.optString("note").trim()
        return if (note.isEmpty()) "已把标注画到当前 K 线面板上。" else "已画到图上：$note"
    }
    private fun textResult(content: String): AgentModelClient.ToolResult =
        AgentModelClient.ToolResult(content)

    private data class ScreenPoint(val x: Int, val y: Int)

    private class InvalidToolArgumentException(message: String) : IllegalArgumentException(message)

    private class ActiveDisplayUnavailableException : IllegalStateException(
        "当前虚拟屏已关闭，旧观察已失效；请重新启动目标应用后再观察和操作",
    )

    private data class PublishedObservation(
        val elements: RootShellDeviceController.ElementObservation? = null,
        val coordinateSpace: RootShellDeviceController.CoordinateSpace? = null,
        val generation: Long? = null,
    )

    private data class GitHubInspectionSnapshot(
        val commitSha: String,
        val prefix: String?,
        val candidatesByPath: Map<String, String>,
    )

    /** 手势经过状态胶囊时让它暂时穿透并淡出；在虚拟屏内操作时不干扰物理屏胶囊。 */
    private fun <T> clearOverlay(displayId: Int, vararg points: ScreenPoint, gesture: () -> T): T {
        if (CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
            return gesture()
        }
        val area = Rect(
            points.minOf { it.x },
            points.minOf { it.y },
            points.maxOf { it.x } + 1,
            points.maxOf { it.y } + 1,
        )
        return AgentOverlayClearance.around(area, gesture)
    }

    private fun showTap(x: Int, y: Int, displayId: Int = Display.DEFAULT_DISPLAY) {
        if (CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
            VirtualDisplayController.emitTapEffect(x, y, longPress = false)
        } else {
            GestureIndicator.showTap(context, x, y)
        }
    }

    private fun showLongPress(
        x: Int,
        y: Int,
        durationMs: Int,
        displayId: Int = Display.DEFAULT_DISPLAY,
    ) {
        if (CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
            VirtualDisplayController.emitTapEffect(x, y, longPress = true)
        } else {
            GestureIndicator.showLongPress(context, x, y, durationMs)
        }
    }

    private fun showSwipe(
        x1: Int,
        y1: Int,
        x2: Int,
        y2: Int,
        durationMs: Int,
        displayId: Int = Display.DEFAULT_DISPLAY,
    ) {
        if (CanvasRoutingPolicy.isVirtualDisplay(displayId)) {
            VirtualDisplayController.emitSwipeEffect(x1, y1, x2, y2, durationMs)
        } else {
            GestureIndicator.showSwipe(context, x1, y1, x2, y2, durationMs)
        }
    }

    private data class AppInfo(
        val packageName: String,
        val appName: String,
        val isSystemApp: Boolean = false
    )

    private companion object {
        val DEVICE_DIRECT_TOOL_NAMES = io.github.mangi.eta.agent.model.AgentPhoneToolCatalog.direct + setOf(
            "set_alarm",
            "set_timer",
            "device_status",
            "inspect_app",
            "network_info",
            "top_memory_apps",
            "top_storage_apps",
            "media_control",
            "set_volume",
        )
        val DEVICE_SENSITIVE_READ_TOOL_NAMES = io.github.mangi.eta.agent.context.PersonalSearchTools.names + io.github.mangi.eta.agent.model.AgentPhoneToolCatalog.reads + setOf(
            "search_notes", "search_system_memories",
            "get_setting",
            "wifi_credentials",
            "recent_notifications",
            "search_notification_history",
            "recent_app_activity",
            "app_usage_summary",
            "get_current_location",
            "get_device_environment",
            "list_alarms",
            "list_active_timers",
            "search_clipboard_history",
            "get_health_summary",
            "read_sms_code",
            "get_logcat",
            "search_media",
            "search_audio",
            "search_recordings",
            "search_files",
            "search_calendar_events",
            "search_contacts",
            "search_call_history",
            "search_messages",
            "search_downloads",
            "search_coloros_notes",
            "search_coloros_recordings",
            "search_recording_summaries",
            "search_coloros_memories",
            "search_saved_places",
            "search_personal_orders",
            "search_qq_chat_images",
            "search_wechat_chat_images",
        )
        val DEVICE_SENSITIVE_ACTION_TOOL_NAMES = io.github.mangi.eta.agent.model.AgentPhoneToolCatalog.writes + setOf(
            "set_setting",
            "set_device_state",
            "app_state_control",
        )
        val DEVICE_TOOL_NAMES =
            DEVICE_DIRECT_TOOL_NAMES + DEVICE_SENSITIVE_READ_TOOL_NAMES +
                DEVICE_SENSITIVE_ACTION_TOOL_NAMES
        val MEMORY_TOOL_NAMES = setOf("memory_get", "memory_write")
    }
}

private val AFTER_ACTION_OPTIONS = AgentScreenObservationContract.Options(
    includeScreenshot = false,
    includeUiTree = true,
    maxNodes = 30,
)

/** append 超过该长度改走粘贴路径；逐字键入的增量重建对长文本既慢又容易被输入法打断。 */
private const val TYPE_TEXT_INCREMENTAL_CHARS = 200

/** 归一化坐标上界：0–999，与主流 GUI 模型的输出习惯一致。 */
private const val NORMALIZED_MAX = 999
