package com.xingqiyi.laundryphoto.ui.base

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.data.remote.ApiError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 页面状态公共基类。
 *
 * 三个统一出口：
 * - [busy]：按钮禁用与加载态，避免重复提交（服务端没有幂等保护的地方尤其重要）；
 * - [error]：可关闭的错误条；
 * - [toast]：轻提示。
 *
 * 关键约定：**会话被顶下线（[ApiError.SessionRevoked]）在这里被吞掉**。
 * 因为它已经由 ApiClient 广播给全局（SessionMonitor），界面只需负责退回登录页；
 * 如果每个页面再弹一次错误，用户会看到一堆重复的「已在其他设备登录」提示，
 * 反而不知道该干什么。
 */
abstract class BaseViewModel : ViewModel() {

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _toast = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val toast: SharedFlow<String> = _toast.asSharedFlow()

    /** 是否处于离线（服务端不可达）状态：由子类在网络错误时置位，用于显示离线条 */
    private val _offline = MutableStateFlow(false)
    val offline: StateFlow<Boolean> = _offline.asStateFlow()

    protected fun setBusy(v: Boolean) {
        _busy.value = v
    }

    protected fun setOffline(v: Boolean) {
        _offline.value = v
    }

    fun emitToast(message: String) {
        _toast.tryEmit(message)
    }

    fun clearError() {
        _error.value = null
    }

    /**
     * 统一异常出口。
     * @param onNetwork 网络类错误的额外处理（如进入离线模式）
     */
    protected fun handleError(e: Throwable, onNetwork: (() -> Unit)? = null) {
        when (e) {
            is ApiError.SessionRevoked -> { /* 全局已处理，此处静默 */ }
            is ApiError.Network -> {
                _offline.value = true
                _error.value = e.message
                onNetwork?.invoke()
            }
            is ApiError -> _error.value = e.message ?: "操作失败"
            else -> _error.value = e.message ?: "未知错误"
        }
    }

    /**
     * 安全启动协程。
     * 必须显式重新抛出 CancellationException：把它吃掉会破坏结构化并发，
     * 导致页面销毁后协程仍挂在工作（进而出现「已退出登录却还在请求」的幽灵行为）。
     */
    protected fun launchSafe(
        setBusyState: Boolean = true,
        onNetworkError: (() -> Unit)? = null,
        block: suspend () -> Unit
    ) {
        viewModelScope.launch {
            if (setBusyState) setBusy(true)
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                handleError(e, onNetworkError)
            } finally {
                if (setBusyState) setBusy(false)
            }
        }
    }
}
