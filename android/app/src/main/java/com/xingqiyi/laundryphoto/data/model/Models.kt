package com.xingqiyi.laundryphoto.data.model

/**
 * 服务端数据模型。
 *
 * 字段名与桌面端 store.js 返回的 JSON 键名严格一致，Gson 直接按字段名映射，
 * 因此不需要 @SerializedName。所有字段都给默认值：服务端偶发缺字段时
 * 反序列化不会得到 null，界面不会出现 NPE（与桌面端的宽松解析风格保持一致）。
 */

/** 统一响应信封：服务端无论成功失败都返回 HTTP 200，业务成败看 ok */
data class ApiEnvelope<T>(
    val ok: Boolean = false,
    val data: T? = null,
    val message: String? = null,
    /** 唯一登录被顶下线标记：true 时必须强制退回登录页 */
    val revoked: Boolean? = null
)

/** 分页结果 */
data class Paged<T>(
    val items: List<T> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20
)

data class LoginResult(
    val user: UserDto = UserDto(),
    val sessionToken: String = ""
)

data class PermissionsDto(
    val capture: Boolean = false,
    val query: Boolean = true
)

data class UserDto(
    val id: String = "",
    val username: String = "",
    val name: String = "",
    val role: String = Role.QUERY.key,
    val store: String = "",
    val active: Boolean = true,
    val createdAt: String = "",
    val lastLoginAt: String? = null,
    val createdBy: String = "",
    val roleLabel: String = "",
    val permissions: PermissionsDto? = null
) {
    /** 角色枚举视图；界面一律用它判断权限，避免散落的字符串比较 */
    val roleEnum: Role get() = Role.of(role)
    /** 显示名：姓名为空时回退用户名（与桌面端 user-chip 一致） */
    val displayName: String get() = name.ifBlank { username }
}

/**
 * 衣物照片存档。
 * photoUrl/thumbUrl 是桌面端协议地址（xqy-photo://…），移动端不可用，
 * 统一改用 [photoFile] 自行拼 HTTP 地址（见 util/PhotoUrl.kt）。
 */
data class RecordDto(
    val id: String = "",
    val barcode: String = "",
    /** 同一条码下的第几张 */
    val seq: Int = 0,
    val userId: String = "",
    val username: String = "",
    val storeName: String = "",
    val note: String = "",
    /** 相对照片根目录的路径，形如「条码目录/202601011230.jpg」 */
    val photoFile: String = "",
    val createdAt: String = "",
    /** 离线暂存未同步标记（本机离线队列中的记录） */
    val pendingSync: Boolean = false
) {
    /** 是否本人存档：删除/改码按钮的可见性判断 */
    fun isOwn(userIdNow: String): Boolean = userId == userIdNow
}

data class LogEntryDto(
    val id: String = "",
    val time: String = "",
    val ip: String = "",
    val userId: String = "",
    val username: String = "",
    val role: String = "",
    val store: String = "",
    val module: String = "",
    val action: String = "",
    val detail: String = "",
    val result: String = ""
)

data class OverviewDto(
    val userCount: Int = 0,
    val activeUserCount: Int = 0,
    val adminCount: Int = 0,
    val roleCount: Map<String, Int> = emptyMap(),
    val recordCount: Int = 0,
    val todayRecordCount: Int = 0,
    val logCount: Int = 0,
    val recentRecords: List<RecordDto> = emptyList(),
    val recentLogs: List<LogEntryDto> = emptyList()
)

data class SystemInfoDto(
    val mode: String = "",
    val port: Int = 0,
    val token: String = "",
    val photoDir: String = "",
    val serverUrl: String = "",
    val updateSourceUrl: String = "",
    val remoteClient: Boolean = false,
    /** 服务端标记：系统设置为本机专用，移动端只读 */
    val localOnly: Boolean = true
)

/**
 * 服务端能力集：移动端据此降级；老服务端没有该接口时按最低能力集处理。
 *
 * ## 为什么这里全部是可空类型
 *
 * 现场实测踩过的坑：用户桌面端是旧构建，`/ping` 只返回
 * `{"ok":true,"data":{"app":"xingqiyi"}}`，**没有** `apiVersion` /
 * `serverVersion` / `features`。
 *
 * Gson 反序列化**不走 Kotlin 主构造函数，也不会执行这里的默认值兜底**——
 * 它用 Unsafe 直接分配对象并只填充 JSON 里存在的 key，缺失字段一律为 `null`。
 * 所以若把 `serverVersion` 声明成非空 `String`，编译器不报错（默认值给了 ""），
 * 运行时却拿到 `null`，调用方一句 `.isBlank()` 就是 NPE，
 * 最终被翻译成一句「对方返回的不是本系统的数据」，把新旧版本不兼容
 * 伪装成了「你地址填错了」，用户白查防火墙和 IP。
 *
 * 因此：**凡是要接收服务端可能缺字段的 DTO，字段一律可空**，
 * 对外语义通过下面的计算属性兜底，调用方拿到的始终是非空值。
 */
data class CapabilitiesDto(
    val app: String? = null,
    val apiVersion: Int? = null,
    val serverVersion: String? = null,
    val features: FeaturesDto? = null
) {
    /** 兜底后的服务标识，调用方无需判空 */
    val appName: String get() = app.orEmpty()

    /** 兜底后的服务端版本号，老服务端缺字段时为空串 */
    val serverVersionText: String get() = serverVersion.orEmpty()

    /**
     * 能力集 API 版本。老服务端无此字段时按 1 处理（仅基础能力）。
     * 客户端 v1.3.0 引入的能力（原始上传、改备注）依赖 apiVersion >= 2。
     */
    val apiVersionValue: Int get() = apiVersion ?: 1

    /** 服务端是否为支持 v1.3.0 增量接口的新版 */
    val supportsMobileAddons: Boolean get() = apiVersionValue >= MIN_API_VERSION

    val uploadRaw: Boolean get() = features?.uploadRaw == true
    val setNote: Boolean get() = features?.setNote == true
    val thumb: Boolean get() = features?.thumb == true
    val photoTokenQuery: Boolean get() = features?.photoTokenQuery == true

    companion object {
        /**
         * 首个支持 v1.3.0 增量接口的协议版本号。
         * 低于此值（含缺失）即视为旧版服务端：原始上传与「改备注」不可用，走 base64 兼容通道。
         */
        const val MIN_API_VERSION = 2

        /** 建议用户升级到的桌面端版本号，供升级指引文案使用 */
        const val MIN_SERVER_VERSION = "1.3.0"
    }
}

data class FeaturesDto(
    val uploadRaw: Boolean = false,
    val setNote: Boolean = false,
    val thumb: Boolean = false,
    val photoTokenQuery: Boolean = false
)

data class UploadResult(
    val photoFile: String = ""
)

data class DeleteBatchResult(
    val deleted: Int = 0,
    val skipped: Int = 0
)

data class RenameBatchResult(
    val renamed: Int = 0,
    val denied: Int = 0,
    val newBarcode: String = "",
    val records: List<RecordDto> = emptyList()
)

data class ForceUpdateDto(
    val enabled: Boolean = false,
    val version: String = "",
    val fileName: String = "",
    val at: String = "",
    val by: String = ""
)

data class UpdateInfoDto(
    val latestVersion: String = "",
    val hasUpdate: Boolean = false,
    val url: String = "",
    val notes: String = ""
)

/** 会话快照：登录成功后持久化，冷启动免登录 */
data class SessionSnapshot(
    val token: String = "",
    val user: UserDto = UserDto()
)
