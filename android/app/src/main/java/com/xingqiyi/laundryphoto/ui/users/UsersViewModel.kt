package com.xingqiyi.laundryphoto.ui.users

import androidx.lifecycle.viewModelScope
import com.xingqiyi.laundryphoto.data.model.Role
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.ui.base.BaseViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * 用户管理（仅系统管理员可见）。
 *
 * 与桌面端一致的两个服务端约束在此以客户端校验前置，减少一次无效往返：
 * - 门店管理员必须分配门店；
 * - 角色由服务端按权限派生，不在移动端做越权操作（仓库层已保证）。
 */
class UsersViewModel(private val container: AppContainer) : BaseViewModel() {

    private val _users = MutableStateFlow<List<UserDto>>(emptyList())
    val users: StateFlow<List<UserDto>> = _users.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    init { load() }

    fun load() {
        if (_loading.value) return
        _loading.value = true
        viewModelScope.launch {
            try {
                _users.value = container.userRepository.list()
            } catch (e: Throwable) {
                handleError(e)
            } finally {
                _loading.value = false
            }
        }
    }

    fun create(
        username: String,
        name: String,
        role: Role,
        password: String,
        store: String
    ) {
        if (username.isBlank() || password.isBlank()) {
            emitToast("用户名与密码不能为空")
            return
        }
        if (role == Role.STORE_ADMIN && store.isBlank()) {
            emitToast("门店管理员必须分配门店")
            return
        }
        viewModelScope.launch {
            setBusy(true)
            try {
                container.userRepository.create(
                    username = username.trim(),
                    name = name.trim(),
                    role = role,
                    password = password,
                    store = store.trim()
                )
                emitToast("已创建账号")
                load()
            } catch (e: Throwable) {
                handleError(e)
            } finally {
                setBusy(false)
            }
        }
    }

    fun update(
        id: String,
        name: String?,
        role: Role?,
        active: Boolean?,
        newPassword: String,
        store: String?
    ) {
        if (role == Role.STORE_ADMIN && store != null && store.isBlank()) {
            emitToast("门店管理员必须分配门店")
            return
        }
        if (newPassword.isBlank() && name == null && role == null && active == null && store == null) {
            emitToast("没有要修改的内容")
            return
        }
        viewModelScope.launch {
            setBusy(true)
            try {
                container.userRepository.update(
                    id = id,
                    name = name?.trim(),
                    role = role,
                    active = active,
                    newPassword = newPassword.ifBlank { null },
                    store = store?.trim()
                )
                emitToast("已保存修改")
                load()
            } catch (e: Throwable) {
                handleError(e)
            } finally {
                setBusy(false)
            }
        }
    }

    fun delete(id: String) {
        viewModelScope.launch {
            setBusy(true)
            try {
                container.userRepository.delete(id)
                emitToast("已删除账号")
                load()
            } catch (e: Throwable) {
                handleError(e)
            } finally {
                setBusy(false)
            }
        }
    }
}
