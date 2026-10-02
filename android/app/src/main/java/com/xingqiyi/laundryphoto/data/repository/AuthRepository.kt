package com.xingqiyi.laundryphoto.data.repository

import com.xingqiyi.laundryphoto.data.model.LoginResult
import com.xingqiyi.laundryphoto.data.model.SessionSnapshot
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.data.pref.SettingsStore
import com.xingqiyi.laundryphoto.data.remote.ApiClient
import com.xingqiyi.laundryphoto.data.remote.ApiError
import com.xingqiyi.laundryphoto.data.remote.SessionHolder
import kotlinx.coroutines.flow.Flow

/**
 * 认证仓库。
 *
 * 与桌面端一致的两条约束：
 * 1. 唯一登录：服务端会在签发新会话时把旧会话标记为失效，后续请求返回 revoked，
 *    由 ApiClient 统一广播，界面强制退回登录页（这里不吞掉该异常）；
 * 2. 凭据不外发：账号密码只发到服务端做校验，「记住密码」的密文只落在本机 Keystore。
 */
class AuthRepository(
    private val api: ApiClient,
    private val settings: SettingsStore,
    private val sessionHolder: SessionHolder
) {

    /** 本地持久化的登录态（用于冷启动恢复） */
    val session: Flow<SessionSnapshot> = settings.session

    suspend fun sessionOnce(): SessionSnapshot = settings.sessionOnce()

    /**
     * 登录。
     * @param remember 是否记住密码（密文存本机，见 SettingsStore.saveCredential）
     */
    suspend fun login(username: String, password: String, remember: Boolean): UserDto {
        val result: LoginResult = api.request { svc ->
            svc.login(mapOf("username" to username, "password" to password))
        }
        val user = result.user
        sessionHolder.setSession(result.sessionToken)
        settings.saveSession(result.sessionToken, user)
        if (remember) {
            settings.saveCredential(username, password)
        } else {
            // 未勾选时也要记住用户名（桌面端同样保留最后一次登录账号），
            // 但密码密文必须清掉，否则「取消记住」在下一次登录后就失效了。
            settings.saveCredential(username, "")
        }
        settings.setRememberPassword(remember)
        return user
    }

    /** 退出登录：先通知服务端销毁会话，再清本机令牌（服务端不可达时也要清，否则永远退不出去） */
    suspend fun logout() {
        runCatching { api.requestUnit { it.logout(emptyMap()) } }
        sessionHolder.clearSession()
        settings.clearSession()
    }

    /**
     * 校验本地令牌是否仍然有效。
     * 冷启动、以及被顶下线后重新进入时调用；失效（含被顶下线）返回 null，
     * 但 SessionRevoked 会继续向外抛，交给界面决定「强制退登录」而非普通重新登录。
     */
    suspend fun currentOrNull(): UserDto? {
        return try {
            api.request { it.current(emptyMap()) }
        } catch (e: ApiError.SessionRevoked) {
            throw e
        } catch (e: ApiError) {
            null
        }
    }

    suspend fun changePassword(oldPassword: String, newPassword: String) {
        api.requestUnit {
            it.changePassword(mapOf("oldPassword" to oldPassword, "newPassword" to newPassword))
        }
    }
}
