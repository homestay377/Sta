plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// 签名：优先用环境变量（自己的正式证书），否则回退到仓库内的固定证书。
//
// ★ 为什么必须固定：CI runner 每次都是全新机器，Gradle 会自动生成一份新的
//   debug.keystore，指纹每次都不同 —— 打出来的包签名不一致，装新包时必须先卸载旧包。
//   仓库里的 keystore/sta-release.jks 让每次构建都用同一个证书。
val envStoreFile = System.getenv("ETA_RELEASE_STORE_FILE")
val envStorePassword = System.getenv("ETA_RELEASE_STORE_PASSWORD")
val envKeyAlias = System.getenv("ETA_RELEASE_KEY_ALIAS")
val envKeyPassword = System.getenv("ETA_RELEASE_KEY_PASSWORD")
val hasEnvSigning = listOf(envStoreFile, envStorePassword, envKeyAlias, envKeyPassword)
    .all { !it.isNullOrBlank() }

val bundledKeystore = rootProject.file("keystore/sta-release.jks")
val hasBundledSigning = bundledKeystore.exists()

val releaseStoreFile: String? = if (hasEnvSigning) envStoreFile else bundledKeystore.absolutePath
val releaseStorePassword: String? = if (hasEnvSigning) envStorePassword else "sta2026release"
val releaseKeyAlias: String? = if (hasEnvSigning) envKeyAlias else "sta"
val releaseKeyPassword: String? = if (hasEnvSigning) envKeyPassword else "sta2026release"
val hasReleaseSigning = hasEnvSigning || hasBundledSigning

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

// CI 对非发版构建传入提交号，按 SemVer 构建元数据追加为 +<sha>，不影响版本先后；本地与发版构建不传
val buildMetadata = providers.gradleProperty("eta.buildMetadata").orNull?.takeIf { it.isNotBlank() }
require(buildMetadata == null || buildMetadata.matches(Regex("[0-9A-Za-z.-]+"))) {
    "eta.buildMetadata 只能包含字母、数字、点和连字符"
}
val buildMetadataSuffix = buildMetadata?.let { "+$it" }.orEmpty()

android {
    namespace = "io.github.mangi.eta"
    compileSdk {
        version = release(37) {
            minorApiLevel = 2
        }
    }
    ndkVersion = libs.versions.ndk.get()

    defaultConfig {
        applicationId = "io.github.sta"
        minSdk = 34
        targetSdk = 37
        // versionCode / versionName 都由构建时刻生成，不再手写。
        //
        // 以前是手写 2026112201，出包时忘了改就会出现
        // 「文件名叫 v1.0.7、装上去还是 1.0.0」，也分不清哪个包更新。
        //
        // versionCode 必须 < 2100000000（Android 上限）。
        // 直接拼 yyyyMMddHHmm 是 12 位（2.0e11），会构建失败，
        // 所以用「距 1970 的天数 × 100000 + 当日分钟数」：
        //   2026-11 ≈ 20779 × 100000 + 537 = 2,077,900,537 ✓
        // 随时间单调递增，覆盖安装不会倒挂。
        //
        // versionName 用 1.0.<MMddHHmm>，和文件名的构建时间对得上。
        val now = java.util.Date()
        val daysSinceEpoch = (now.time / 86_400_000L).toInt()
        val minuteOfDay = ((now.time % 86_400_000L) / 60_000L).toInt()
        versionCode = daysSinceEpoch * 100_000 + minuteOfDay
        val buildStamp = java.text.SimpleDateFormat("MMddHHmm", java.util.Locale.US)
            .apply { timeZone = java.util.TimeZone.getTimeZone("Asia/Shanghai") }
            .format(now)
        versionName = "1.0.$buildStamp"

        ndk {
            // 同时过滤本地与依赖 AAR 的原生库，确保 APK 仅包含 ARM64。
            abiFilters += "arm64-v8a"
        }
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(requireNotNull(releaseStoreFile))
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            // 版本名带构建类型标记，设置页与 APK 文件名据此区分 Debug 包
            versionNameSuffix = "-debug" + buildMetadataSuffix
            isMinifyEnabled = false
            isPseudoLocalesEnabled = true
            // debug 也用固定证书：否则 CI 每次自动生成的 debug.keystore 指纹不同，
            // debug 与 release 两种包互相覆盖都会失败。
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
        release {
            versionNameSuffix = buildMetadataSuffix
            // 没配正式证书时回退 debug 证书：否则 release 包无签名，装不上。
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_25
        targetCompatibility = JavaVersion.VERSION_25
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    androidResources {
        localeFilters += listOf("en", "b+zh+Hans", "b+zh+Hant")
    }

    packaging {
        dex {
            useLegacyPackaging = true
        }
        jniLibs {
            useLegacyPackaging = true
            keepDebugSymbols += setOf("**/libproot_exec.so", "**/libproot_loader.so", "**/libeta_pty.so")
        }
        resources {
            // 合并 Xposed 模块声明，避免 release 裁剪后模块入口失效
            merges += "META-INF/xposed/*"
            // 仅排除会引发打包冲突的签名/版本元数据，避免误伤 Compose 资源
            excludes += "META-INF/*.kotlin_module"
            excludes += "META-INF/INDEX.LIST"
            excludes += "META-INF/io.netty.versions.properties"
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = false
        // versionCode 采用日期编码，已发布值只能递增；上限 2100000000 足够覆盖到 2099 年。
        disable += "HighAppVersionCode"
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        // Robolectric 在高版本 JDK 下需要访问内部 API，参数只作用于测试 JVM。
        unitTests.all {
            it.jvmArgs(
                "--add-opens=java.base/java.lang=ALL-UNNAMED",
                "--add-opens=java.base/java.util=ALL-UNNAMED",
                "--add-opens=java.base/java.io=ALL-UNNAMED",
                "--add-opens=java.base/java.net=ALL-UNNAMED",
                "--add-opens=java.base/java.security=ALL-UNNAMED",
                "--add-opens=java.base/java.text=ALL-UNNAMED",
                "--add-opens=java.base/jdk.internal.access=ALL-UNNAMED",
                "--add-opens=java.desktop/java.awt.font=ALL-UNNAMED",
                "--add-opens=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED",
                "--enable-native-access=ALL-UNNAMED",
            )
        }
    }
}

androidComponents {
    onVariants { variant ->
        // 文件名只取 versionName：构建类型标记与 CI 构建元数据都由 versionNameSuffix 带出
        variant.outputs.forEach { output ->
            output.outputFileName.set(output.versionName.map { "Sta-v$it.apk" })
        }
    }
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs.nio)
    implementation(libs.jsoup)
    implementation(libs.commons.compress)
    implementation(libs.xz)
    compileOnly(libs.libxposed.api)
    // UI 侧 RemotePreferences 写入桥：通过 XposedService 将配置提交到 LSPosed 数据库；
    // Hook 侧用 XposedInterface.getRemotePreferences 读取当前进程持有的配置缓存。
    implementation(libs.libxposed.service)
    implementation(libs.dexkit)
    constraints {
        // 延续旧依赖图中两套 UI 共用的窗口尺寸和 Android 兼容组件版本。
        implementation(libs.androidx.compose.window.size)
        implementation(libs.androidx.core.ktx)
    }
    implementation(libs.coui.ui)
    implementation(libs.coui.preference)
    implementation(libs.coui.icons)
    implementation(libs.coui.blur)
    implementation(libs.coui.squircle)
    implementation(libs.miuix.ui)
    implementation(libs.miuix.blur)
    implementation(libs.miuix.glass)
    implementation(libs.miuix.glass.icons)
    implementation(libs.miuix.material)
    implementation(libs.miuix.nav)
    implementation(libs.miuix.preference)
    implementation(libs.material.icons.extended)
    implementation(libs.androidx.navigationevent)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.activity.compose)
    // 只使用 GFM 解析器；聊天渲染层由 ui/markdown 自建，按块冻结并接入逐字显现。
    implementation(libs.intellij.markdown)
    implementation(libs.ratex.android)
    implementation(libs.hidden.api.bypass)

    // DataStore：Provider / Model 结构化 JSON 与当前选中 ID 等键值
    implementation(libs.datastore.preferences)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    // OkHttp：替代 HttpURLConnection，支持 SSE
    implementation(libs.okhttp)
    implementation(libs.nimbus.jose.jwt)
    implementation(libs.okhttp.sse)

    // Kotlinx Serialization：Provider 设置与运行时配置 JSON
    implementation(libs.kotlinx.serialization.json)

    // Coroutines：显式引入，避免依赖传递版本不确定
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.json)
    testImplementation(libs.room.testing)
    testImplementation(libs.robolectric)
}
