package com.xingqiyi.laundryphoto.data.repository

import com.xingqiyi.laundryphoto.data.model.Role
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.data.remote.ApiClient

/**
 * 用户与权限仓库（仅系统管理员可用）。
 *
 * 与桌面端一致的两条服务端约束在这里体现为客户端校验，减少一次无效往返：
 * - 门店管理员必须分配门店（否则其日志/订单范围失去依据）；
 * - 权限由角色派生，不接受外部传入——因此本仓库不提供单独改权限的方法，
 *   避免出现「门店管理员可拍照」这类与角色矛盾的账号。
 */
class UserRepository(private val api: ApiClient) {

    suspend fun list(): List<UserDto> = api.request { it.listUsers(emptyMap()) }

    suspend fun create(
        username: String,
        name: String,
        role: Role,
        password: String,
        store: String
    ): UserDto {
        require(role != Role.STORE_ADMIN || store.isNotBlank()) { "门店管理员必须分配门店" }
        return api.request { svc ->
            svc.createUser(
                mapOf(
                    "username" to username.trim(),
                    "name" to name.trim(),
                    "role" to role.key,
                    "password" to password,
                    "store" to store.trim()
                )
            )
        }
    }

    /**
     * 修改账号。
     * 所有参数均为「不传则不改」语义（null 表示本次不动该字段），
     * 与服务端 updateUser 的 `!== undefined` 判断保持一致。
     */
    suspend fun update(
        id: String,
        name: String? = null,
        role: Role? = null,
        active: Boolean? = null,
        newPassword: String? = null,
        store: String? = null
    ): UserDto {
        if (role == Role.STORE_ADMIN && store != null && store.isBlank()) {
            throw IllegalArgumentException("门店管理员必须分配门店")
        }
        val body = mutableMapOf<String, Any?>("id" to id)
        if (name != null) body["name"] = name
        if (role != null) body["role"] = role.key
        if (active != null) body["active"] = active
        if (!newPassword.isNullOrBlank()) body["newPassword"] = newPassword
        if (store != null) body["store"] = store
        return api.request { svc -> svc.updateUser(body) }
    }

    suspend fun delete(id: String) {
        api.requestUnit { it.deleteUser(mapOf("id" to id)) }
    }
}
