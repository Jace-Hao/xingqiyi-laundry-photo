package com.xingqiyi.laundryphoto.ui.home

import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.data.local.PendingUploadEntity
import com.xingqiyi.laundryphoto.data.model.OverviewDto
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.data.remote.ApiError
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.sync.SyncManager
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * 首页：角色化的快捷入口 + 待同步状态。
 *
 * 首页刻意不做成信息墙：店员拿起手机通常只做一件事（拍照或查单），
 * 按钮要大、要少。管理员才额外展示统计卡片——他们确实需要「今天拍了多少」这种数字。
 */
class HomeViewModel(private val container: AppContainer) : BaseViewModel() {

    private val _user = MutableStateFlow<UserDto?>(null)
    val user: StateFlow<UserDto?> = _user.asStateFlow()

    private val _overview = MutableStateFlow<OverviewDto?>(null)
    val overview: StateFlow<OverviewDto?> = _overview.asStateFlow()

    private val _online = MutableStateFlow(true)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing.asStateFlow()

    /** 离线队列：Room 直接推流，拍照入队后首页角标立即变化，无需手动刷新 */
    val pending: StateFlow<List<PendingUploadEntity>> =
        container.offlineRepository.observe()
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun bind(user: UserDto) {
        _user.value = user
    }

    fun refresh(user: UserDto) {
        _user.value = user
        launchSafe(setBusyState = false) {
            // 总览仅系统管理员可见（服务端也会拒绝），先判角色省掉一次必然失败的请求
            if (user.roleEnum.manageUsers) {
                runCatching { container.logRepository.overview() }
                    .onSuccess { _overview.value = it; _online.value = true }
                    .onFailure { if (it is ApiError.Network) setOffline(true) }
            }
        }
        probeOnline()
        // 有待同步照片且在线时，进首页就顺手补传一次，不用等周期任务
        viewModelScope.launch {
            if (container.offlineRepository.countWaiting() > 0) syncNow()
        }
    }

    /** 轻量探活：只判断服务端是否可达，不写操作日志（silent） */
    private fun probeOnline() {
        launchSafe(setBusyState = false) {
            runCatching { container.recordRepository.list(RecordQueryProbe) }
                .onSuccess { setOffline(false); _online.value = true }
                .onFailure { _online.value = false; setOffline(true) }
        }
    }

    fun syncNow() {
        if (_syncing.value) return
        _syncing.value = true
        SyncManager.enqueueImmediate(container.appContext)
        // WorkManager 是异步的，这里给一个较短的等待窗口后刷新队列状态；
        // 队列变化本身由 Room 流驱动，因此无需轮询结果。
        viewModelScope.launch {
            kotlinx.coroutines.delay(1500)
            _syncing.value = false
        }
    }

    private val RecordQueryProbe =
        com.xingqiyi.laundryphoto.data.repository.RecordRepository.Query(
            pageSize = 1,
            silent = true
        )
}
