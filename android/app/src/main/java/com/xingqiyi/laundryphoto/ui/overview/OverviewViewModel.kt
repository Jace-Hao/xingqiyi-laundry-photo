package com.xingqiyi.laundryphoto.ui.overview

import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.data.model.OverviewDto
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 数据总览（系统管理员）。
 *
 * 与首页的统计卡片是同一份数据，但这里是「完整版」：首页只给 4 个数字，
 * 这里展示账号分布、今日/累计存档、操作日志量，并附最近存档与最近操作，
 * 方便管理员一眼判断门店是否异常（例如今天突然零存档）。
 */
class OverviewViewModel(private val container: AppContainer) : BaseViewModel() {

    private val _overview = MutableStateFlow<OverviewDto?>(null)
    val overview: StateFlow<OverviewDto?> = _overview.asStateFlow()

    private val _loading = MutableStateFlow(true)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    init { load() }

    fun load() {
        _loading.value = true
        viewModelScope.launch {
            try {
                _overview.value = container.logRepository.overview()
            } catch (e: Throwable) {
                handleError(e)
            } finally {
                _loading.value = false
            }
        }
    }
}
