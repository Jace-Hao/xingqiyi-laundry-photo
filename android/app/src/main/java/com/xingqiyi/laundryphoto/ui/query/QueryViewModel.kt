package com.xingqiyi.laundryphoto.ui.query

import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.data.model.RecordDto
import com.xingqiyi.laundryphoto.data.repository.RecordRepository
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 订单查询。
 *
 * 分页方式用「追加」而不是「翻页」：手机上是上下滑动的场景，
 * 底部「加载更多」比页码更符合直觉（桌面端用页码是因为鼠标点页码成本低）。
 *
 * 搜索输入做了 300ms 防抖：每输入一个字就打一次服务端会把操作日志刷爆，
 * 服务端每查一次都会写一条「查询记录」日志——这一点和桌面端一致，必须谨慎。
 */
class QueryViewModel(private val container: AppContainer) : BaseViewModel() {

    private companion object {
        const val PAGE_SIZE = 20
        const val DEBOUNCE_MS = 300L
    }

    val keyword = mutableStateOf("")
    val dateFrom = mutableStateOf("")
    val dateTo = mutableStateOf("")
    val filterVisible = mutableStateOf(false)

    /** 多选：批量删除 / 批量改码 */
    val selected = mutableStateListOf<String>()
    val selectMode get() = selected.isNotEmpty()

    private val _items = MutableStateFlow<List<RecordDto>>(emptyList())
    val items: StateFlow<List<RecordDto>> = _items.asStateFlow()

    private val _total = MutableStateFlow(0)
    val total: StateFlow<Int> = _total.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _loadingMore = MutableStateFlow(false)
    val loadingMore: StateFlow<Boolean> = _loadingMore.asStateFlow()

    private var page = 1
    private var searchJob: Job? = null

    /** 是否还有下一页 */
    val hasMore: Boolean get() = _items.value.size < _total.value

    init {
        load(reset = true)
    }

    fun onKeywordChange(value: String) {
        keyword.value = value
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(DEBOUNCE_MS)
            load(reset = true)
        }
    }

    fun applyDateFilter(from: String, to: String) {
        dateFrom.value = from
        dateTo.value = to
        filterVisible.value = false
        load(reset = true)
    }

    fun clearFilter() {
        dateFrom.value = ""
        dateTo.value = ""
        load(reset = true)
    }

    fun refresh() = load(reset = true)

    fun loadMore() {
        if (_loadingMore.value || _loading.value || !hasMore) return
        load(reset = false)
    }

    private fun load(reset: Boolean) {
        if (reset) page = 1
        viewModelScope.launch {
            if (reset) {
                _loading.value = true
            } else {
                _loadingMore.value = true
            }
            try {
                val result = container.recordRepository.list(
                    RecordRepository.Query(
                        keyword = keyword.value.trim(),
                        dateFrom = dateFrom.value,
                        dateTo = dateTo.value,
                        page = page,
                        pageSize = PAGE_SIZE
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

    fun toggleSelect(id: String) {
        if (selected.contains(id)) selected.remove(id) else selected.add(id)
    }

    fun selectAll() {
        selected.clear()
        selected.addAll(_items.value.map { it.id })
    }

    fun clearSelection() = selected.clear()

    fun deleteSelected(onDone: (Int) -> Unit) {
        val ids = selected.toList()
        if (ids.isEmpty()) return
        launchSafe {
            val r = container.recordRepository.deleteBatch(ids)
            selected.clear()
            onDone(r.deleted)
            load(reset = true)
        }
    }

    fun renameSelected(newBarcode: String, onDone: (Int) -> Unit) {
        val ids = selected.toList()
        if (ids.isEmpty()) return
        if (newBarcode.isBlank()) {
            emitToast("请填写新条码")
            return
        }
        launchSafe {
            val r = container.recordRepository.renameBarcodeBatch(ids, newBarcode.trim())
            selected.clear()
            onDone(r.renamed)
            load(reset = true)
        }
    }
}
