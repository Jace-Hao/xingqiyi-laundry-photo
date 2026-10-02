package com.xingqiyi.laundryphoto.data.repository

import com.xingqiyi.laundryphoto.data.model.LogEntryDto
import com.xingqiyi.laundryphoto.data.model.OverviewDto
import com.xingqiyi.laundryphoto.data.model.Paged
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.data.remote.ApiClient

/**
 * 操作日志与数据总览仓库。
 *
 * 可见范围由服务端按角色收窄（系统管理员=全部，门店管理员=本店），
 * 客户端不自己做裁剪——否则一份在手机上被裁剪过的日志列表会让人误以为「没人操作过」。
 */
class LogRepository(private val api: ApiClient) {

    data class Query(
        val keyword: String = "",
        val userId: String = "",
        val action: String = "",
        val dateFrom: String = "",
        val dateTo: String = "",
        val page: Int = 1,
        val pageSize: Int = 30,
        val silent: Boolean = false
    )

    suspend fun list(query: Query): Paged<LogEntryDto> {
        // 服务端的日期参数是「YYYY-MM-DD」纯日期串（内部再拼 T00:00:00 按本地时区解析），
        // 不是 ISO 时间戳——传 ISO 会被当成非法日期，过滤结果为空且没有任何报错，
        // 这是一个极易踩且很难排查的坑，因此这里刻意不做任何转换。
        return api.request { svc ->
            svc.listLogs(
                mapOf(
                    "keyword" to query.keyword.ifBlank { null },
                    "userId" to query.userId.ifBlank { null },
                    "action" to query.action.ifBlank { null },
                    "dateFrom" to query.dateFrom.ifBlank { null },
                    "dateTo" to query.dateTo.ifBlank { null },
                    "page" to query.page,
                    "pageSize" to query.pageSize,
                    "silent" to query.silent
                )
            )
        }
    }

    /** 可选操作类型（服务端登记清单 ∪ 历史数据中出现过的类型） */
    suspend fun actionOptions(): List<String> = api.request { it.logActionOptions(emptyMap()) }

    /** 可选账号（按角色收窄，门店管理员只见本店账号） */
    suspend fun filterUsers(): List<UserDto> = api.request { it.logFilterUsers(emptyMap()) }

    suspend fun overview(): OverviewDto = api.request { it.overview(emptyMap()) }
}
