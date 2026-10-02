package com.xingqiyi.laundryphoto.ui.logs

import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.data.model.LogEntryDto
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.data.repository.LogRepository
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 操作日志。
 *
 * 与查询订单页一致的分页/防抖思路；差异点：
 * - 列表加载统一走 silent=true，避免「看日志」这件事本身又被记成一条日志，刷爆日志表；
 * - 时间范围是**纯日期** YYYY-MM-DD（服务端内部按本地时区拼 T00:00:00），
 *   不是 ISO 时间戳——这点已在 LogRepository 注释里强调，这里不转换、只透传。
 */
class LogsViewModel(private val container: AppContainer) : BaseViewModel() {

    private companion object {
        const val PAGE_SIZE = 30
    }

    val keyword = mutableStateOf("")
    val userId = mutableStateOf("")
    val action = mutableStateOf("")
    val dateFrom = mutableStateOf("")
    val dateTo = mutableStateOf("")
    val filterVisible = mutableStateOf(false)

    /** 下拉可选项（服务端登记类型 ∪ 历史出现过的类型） */
    val actionOptions = mutableStateOf<List<String>>(emptyList())
    val filterUsers = mutableStateOf<List<UserDto>>(emptyList())

    private val _items = MutableStateFlow<List<LogEntryDto>>(emptyList())
    val items: StateFlow<List<LogEntryDto>> = _items.asStateFlow()

    private val _total = MutableStateFlow(0)
    val total: StateFlow<Int> = _total.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _loadingMore = MutableStateFlow(false)
    val loadingMore: StateFlow<Boolean> = _loadingMore.asStateFlow()

    private var page = 1

    val hasMore: Boolean get() = _items.value.size < _total.value

    init {
        viewModelScope.launch {
            runCatching { container.logRepository.actionOptions() }.onSuccess { actionOptions.value = it }
            runCatching { container.logRepository.filterUsers() }.onSuccess { filterUsers.value = it }
        }
        load(reset = true)
    }

    fun applyFilter(
        keyword: String = this.keyword.value,
        userId: String = this.userId.value,
        action: String = this.action.value,
        dateFrom: String = this.dateFrom.value,
        dateTo: String = this.dateTo.value
    ) {
        this.keyword.value = keyword
        this.userId.value = userId
        this.action.value = action
        this.dateFrom.value = dateFrom
        this.dateTo.value = dateTo
        filterVisible.value = false
        load(reset = true)
    }

    fun clearFilter() = applyFilter("", "", "", "", "")

    fun refresh() = load(reset = true)

    fun loadMore() {
        if (_loadingMore.value || _loading.value || !hasMore) return
        load(reset = false)
    }

    private fun load(reset: Boolean) {
        if (reset) page = 1
        viewModelScope.launch {
            if (reset) _loading.value = true else _loadingMore.value = true
            try {
                val result = container.logRepository.list(
                    LogRepository.Query(
                        keyword = keyword.value.trim(),
                        userId = userId.value,
                        action = action.value,
                        dateFrom = dateFrom.value,
                        dateTo = dateTo.value,
                        page = page,
                        pageSize = PAGE_SIZE,
                        silent = true
                    )
                )
                _total.value = result.total
                _items.value = if (reset) result.items else _items.value + result.items
                if (result.items.isNotEmpty()) page += 1
            } catch (e: Throwable) {
                handleError(e)
            } finally {
                if (reset) _loading.value = false else _loadingMore.value = false
            }
        }
    }
}
