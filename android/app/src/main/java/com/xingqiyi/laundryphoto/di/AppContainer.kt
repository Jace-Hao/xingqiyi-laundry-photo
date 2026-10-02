package com.xingqiyi.laundryphoto.di

import android.content.Context
import androidx.room.Room
import com.xingqiyi.laundryphoto.BuildConfig
import com.xingqiyi.laundryphoto.data.local.AppDatabase
import com.xingqiyi.laundryphoto.data.pref.SettingsStore
import com.xingqiyi.laundryphoto.data.remote.ApiClient
import com.xingqiyi.laundryphoto.data.remote.PingResultReporter
import com.xingqiyi.laundryphoto.data.remote.SessionHolder
import com.xingqiyi.laundryphoto.data.repository.AuthRepository
import com.xingqiyi.laundryphoto.data.repository.LogRepository
import com.xingqiyi.laundryphoto.data.repository.OfflineRepository
import com.xingqiyi.laundryphoto.data.repository.RecordRepository
import com.xingqiyi.laundryphoto.data.repository.SystemRepository
import com.xingqiyi.laundryphoto.data.repository.UserRepository
import java.io.File

/**
 * 极简依赖容器。
 *
 * 没有引入 Hilt/Dagger：本项目只有十余个页面、依赖图是单层的（仓库 → ApiClient/DB），
 * 手写容器比接一套注解处理器更容易读，也省掉 kapt 之外的第二套编译插件。
 * 若后续页面规模翻倍，再换 Hilt 也不迟——替换点只有本文件与各 ViewModel 的构造。
 */
class AppContainer(private val context: Context) {

    /** 供需要 Context 的能力使用（WorkManager 入队、文件目录等）；不要拿它做 UI 相关的事 */
    val appContext: Context get() = context

    val settings: SettingsStore = SettingsStore(context)
    val sessionHolder: SessionHolder = SessionHolder()
    val api: ApiClient = ApiClient(sessionHolder = sessionHolder, debug = BuildConfig.DEBUG)

    val database: AppDatabase = Room.databaseBuilder(
        context,
        AppDatabase::class.java,
        "xqy_laundry.db"
    ).build()

    val authRepository = AuthRepository(api, settings, sessionHolder)
    val recordRepository = RecordRepository(api)
    val userRepository = UserRepository(api)
    val logRepository = LogRepository(api)
    val systemRepository = SystemRepository(api)
    val offlineRepository = OfflineRepository(database, File(context.filesDir, "offline"))

    /** 上传/离线处理用的临时目录 */
    val workDir: File = File(context.cacheDir, "capture").apply { mkdirs() }

    /**
     * 恢复连接配置。
     *
     * 必须做这件事的场景有两个：冷启动（进程全新）与 WorkManager 在后台进程执行补传。
     * 二者都没有内存中的令牌，如果不从 DataStore 恢复，请求会以空连接码发出去，
     * 服务端返回 401，而界面只会看到「连接码无效」——一个完全误导的提示。
     */
    suspend fun ensureConfigured() {
        val conn = settings.connectionOnce()
        sessionHolder.setApiToken(conn.apiToken)
        if (conn.serverUrl.isNotBlank() && api.baseUrl != conn.serverUrl) {
            api.configure(conn.serverUrl)
        }
        if (sessionHolder.sessionToken.isBlank()) {
            sessionHolder.setSession(settings.sessionOnce().token)
        }
    }

    /**
     * 登录后拉取服务端能力集。
     * 失败不影响登录（老服务端没有该接口），保持 null 即按最低能力集运行。
     */
    suspend fun refreshCapabilities() {
        val caps = runCatching { systemRepository.capabilitiesOrNull() }.getOrNull()
        api.rememberCapabilities(caps)
    }

    /** 应用连接配置（登录页保存服务器地址与连接码后调用） */
    fun applyConnection(serverUrl: String, apiToken: String) {
        sessionHolder.setApiToken(apiToken.trim())
        api.configure(serverUrl)
    }

    /**
     * 探测服务器是否可达（登录页「测试连接」）。
     *
     * 现场故障复盘：这里曾直接对 `caps.serverVersion` 调 `.isBlank()`，
     * 而旧版本桌面端返回的 `/ping` 响应体里根本没有 `serverVersion` 字段，
     * Gson 反序列化不走 Kotlin 主构造函数、也不会执行默认值，
     * 一律填 `null`（非空类型声明挡不住）→ NPE。
     *
     * 现在所有字段读取都走 [com.xingqiyi.laundryphoto.data.model.CapabilitiesDto]
     * 的兜底计算属性，缺字段不再崩；文案组装交给
     * [com.xingqiyi.laundryphoto.data.remote.PingResultReporter]，
     * 之所以要抽出去，是因为本类依赖 Android `Context`，单元测试构造不出来，
     * 放在这里就等于「降级提示对不对」永远没人能验证。
     */
    suspend fun ping(): String {
        ensureConfigured()
        return PingResultReporter.success(systemRepository.ping())
    }
}
