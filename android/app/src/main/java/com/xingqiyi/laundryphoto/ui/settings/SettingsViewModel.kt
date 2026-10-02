package com.xingqiyi.laundryphoto.ui.settings

import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.BuildConfig
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.sync.SyncManager
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * 设置页。
 *
 * 移动端只暴露与体验相关、且不会威胁服务端数据的项：
 * - 主题（跟随系统/浅色/深色）、缩略图宽度（弱网省流量）、上传质量；
 * - 连接信息只读展示（连接码不可在此泄露/修改）；
 * - 改密码、退出登录、离线队列管理。
 *
 * 端口/照片路径/强制推送安装包等服务端本机设置**不在这里提供入口**（见 SystemRepository 注释）。
 */
class SettingsViewModel(private val container: AppContainer) : BaseViewModel() {

    private val _themeMode = MutableStateFlow("system")
    val themeMode: StateFlow<String> = _themeMode.asStateFlow()

    private val _thumbWidth = MutableStateFlow(360)
    val thumbWidth: StateFlow<Int> = _thumbWidth.asStateFlow()

    private val _photoQuality = MutableStateFlow(82)
    val photoQuality: StateFlow<Int> = _photoQuality.asStateFlow()

    private val _pendingCount = MutableStateFlow(0)
    val pendingCount: StateFlow<Int> = _pendingCount.asStateFlow()

    private val _serverUrl = MutableStateFlow("")
    val serverUrl: StateFlow<String> = _serverUrl.asStateFlow()

    private val _apiToken = MutableStateFlow("")
    val apiToken: StateFlow<String> = _apiToken.asStateFlow()

    val versionName: String get() = BuildConfig.VERSION_NAME

    init {
        viewModelScope.launch {
            runCatching { container.settings.themeMode.first() }.onSuccess { _themeMode.value = it }
            runCatching { container.settings.thumbWidth.first() }.onSuccess { _thumbWidth.value = it }
            runCatching { container.settings.photoQuality.first() }.onSuccess { _photoQuality.value = it }
            runCatching {
                val conn = container.settings.connectionOnce()
                _serverUrl.value = conn.serverUrl
                _apiToken.value = conn.apiToken
            }
            // 离线队列是 Room 流，直接映射成计数
            runCatching {
                container.offlineRepository.observe().collect { _pendingCount.value = it.size }
            }
        }
    }

    fun setTheme(mode: String) {
        _themeMode.value = mode
        viewModelScope.launch { runCatching { container.settings.setThemeMode(mode) } }
    }

    fun setThumbWidth(value: Int) {
        val v = value.coerceIn(120, 720)
        _thumbWidth.value = v
        viewModelScope.launch { runCatching { container.settings.setThumbWidth(v) } }
    }

    fun setPhotoQuality(value: Int) {
        val v = value.coerceIn(30, 100)
        _photoQuality.value = v
        viewModelScope.launch { runCatching { container.settings.setPhotoQuality(v) } }
    }

    fun changePassword(oldPassword: String, newPassword: String) {
        if (oldPassword.isBlank() || newPassword.isBlank()) {
            emitToast("原密码与新密码均不能为空")
            return
        }
        viewModelScope.launch {
            setBusy(true)
            try {
                container.authRepository.changePassword(oldPassword, newPassword)
                emitToast("密码已更新")
            } catch (e: Throwable) {
                handleError(e)
            } finally {
                setBusy(false)
            }
        }
    }

    fun retryFailed() {
        viewModelScope.launch {
            container.offlineRepository.retryFailed()
            SyncManager.enqueueImmediate(container.appContext)
            emitToast("已重新加入补传队列")
        }
    }

    fun clearOffline() {
        viewModelScope.launch {
            container.offlineRepository.clearAll()
            emitToast("已清空未同步照片（不可恢复）")
        }
    }

    fun logout(onDone: () -> Unit) {
        viewModelScope.launch {
            setBusy(true)
            runCatching { container.authRepository.logout() }
            SyncManager.cancelAll(container.appContext)
            setBusy(false)
            onDone()
        }
    }
}
