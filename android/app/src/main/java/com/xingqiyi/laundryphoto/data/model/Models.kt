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

/** 服务端能力集：移动端据此降级；老服务端没有该接口时按最低能力集处理 */
data class CapabilitiesDto(
    val app: String = "",
    val apiVersion: Int = 1,
    val serverVersion: String = "",
    val features: FeaturesDto? = null
) {
    val uploadRaw: Boolean get() = features?.uploadRaw == true
    val setNote: Boolean get() = features?.setNote == true
    val thumb: Boolean get() = features?.thumb == true
    val photoTokenQuery: Boolean get() = features?.photoTokenQuery == true
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
