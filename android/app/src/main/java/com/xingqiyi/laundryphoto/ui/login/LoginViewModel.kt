package com.xingqiyi.laundryphoto.ui.login

import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.data.remote.ApiError
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import com.xingqiyi.laundryphoto.util.ServerUrlNormalizer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * 登录页状态。
 *
 * 与桌面端登录页的能力对齐：记住账号、记住密码、一键测试服务器连通性。
 * 差异在于移动端每位使用者都要自己填一次服务器地址与连接码——
 * 桌面端客户端可以由管理员预置，手机做不到（除非 MDM 下发），
 * 所以这两项做成常驻字段而不是藏在「高级设置」里。
 */
class LoginViewModel(private val container: AppContainer) : BaseViewModel() {

    val serverUrl = mutableStateOf("")
    val apiToken = mutableStateOf("")
    val username = mutableStateOf("")
    val password = mutableStateOf("")
    val remember = mutableStateOf(false)
    val serverExpanded = mutableStateOf(true)
    val passwordVisible = mutableStateOf(false)

    private val _testResult = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val testResult: SharedFlow<String> = _testResult.asSharedFlow()

    private val _loggedIn = MutableSharedFlow<UserDto>(extraBufferCapacity = 1)
    val loggedIn: SharedFlow<UserDto> = _loggedIn.asSharedFlow()

    init {
        viewModelScope.launch {
            runCatching {
                val conn = container.settings.connectionOnce()
                serverUrl.value = conn.serverUrl
                apiToken.value = conn.apiToken
                // 地址为空说明是首次使用，直接展开服务器配置；已配置过则收起，减少首屏噪音
                serverExpanded.value = conn.serverUrl.isBlank()
                val (savedUser, savedPwd) = container.settings.savedCredential()
                remember.value = container.settings.rememberPassword.first()
                val lastUser = container.settings.lastUsername.first()
                username.value = savedUser.ifBlank { lastUser }
                password.value = savedPwd
            }
        }
    }

    /** 测试服务器连通性：登录前先验地址，比登录失败后看到「无法连接」友好得多 */
    fun testConnection() {
        launchSafe {
            val url = serverUrl.value.trim()
            val token = apiToken.value.trim()
            if (url.isBlank()) {
                _testResult.tryEmit("请先填写服务器地址")
                return@launchSafe
            }

            // 先规范化地址：漏写端口冒号是现场最高频的错误，
            // 若不在这里补全，请求会打到 80 端口并得到一句难以自查的「数据返回异常」。
            val normalized = when (val r = ServerUrlNormalizer.normalize(url)) {
                is ServerUrlNormalizer.Result.Invalid -> {
                    _testResult.tryEmit(r.reason)
                    return@launchSafe
                }
                is ServerUrlNormalizer.Result.Ok -> {
                    if (r.adjusted) {
                        // 回填输入框，让用户看到系统实际用的是哪个地址
                        serverUrl.value = r.baseUrl
                    }
                    r.baseUrl
                }
            }

            container.settings.saveConnection(normalized, token)
            container.applyConnection(normalized, token)
            try {
                val msg = container.ping()
                _testResult.tryEmit(msg)
            } catch (e: ApiError.Auth) {
                _testResult.tryEmit("服务器可达，但连接码无效：${e.message}")
            } catch (e: ApiError) {
                // 带上实际使用的地址，用户才能核对端口是否填对
                val used = container.api.baseUrl.ifBlank { normalized }
                _testResult.tryEmit("${e.message ?: "连接失败"}\n（实际连接：$used）")
            }
        }
    }

    fun login() {
        if (busy.value) return
        val url = serverUrl.value.trim()
        val token = apiToken.value.trim()
        val user = username.value.trim()
        val pwd = password.value

        when {
            url.isBlank() -> emitToast("请填写服务器地址")
            token.isBlank() -> emitToast("请填写连接码")
            user.isBlank() -> emitToast("请填写账号")
            pwd.isBlank() -> emitToast("请填写密码")
            else -> Unit
        }
        if (url.isBlank() || token.isBlank() || user.isBlank() || pwd.isBlank()) return

        // 登录同样走规范化地址：漏写冒号时若不补全，会连到 80 端口的别的服务，
        // 报出来的却是「账号或密码错误」，把人引到错误的方向上。
        val normalized = when (val r = ServerUrlNormalizer.normalize(url)) {
            is ServerUrlNormalizer.Result.Invalid -> {
                emitToast(r.reason)
                return
            }
            is ServerUrlNormalizer.Result.Ok -> {
                if (r.adjusted) serverUrl.value = r.baseUrl
                r.baseUrl
            }
        }

        launchSafe {
            container.settings.saveConnection(normalized, token)
            container.applyConnection(normalized, token)
            try {
                val logged = container.authRepository.login(user, pwd, remember.value)
                container.refreshCapabilities()
                _loggedIn.tryEmit(logged)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                handleError(e)
            }
        }
    }
}
