package com.xingqiyi.laundryphoto.data.remote

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 会话令牌持有者。
 *
 * 令牌放在这里而不是每个接口当参数传，是为了让 OkHttp 拦截器统一注入：
 * 新增接口时不可能忘记带令牌，也不会出现某个调用点漏传导致的「本机一切正常、真机 401」。
 * 用 @Volatile 是因为令牌可能在任意线程被替换（登录/退出/被顶下线），拦截器在 OkHttp 的调度线程读取。
 */
class SessionHolder {
    @Volatile
    var apiToken: String = ""
        private set

    @Volatile
    var sessionToken: String = ""
        private set

    fun setApiToken(value: String) {
        apiToken = value
    }

    fun setSession(value: String) {
        sessionToken = value
    }

    fun clearSession() {
        sessionToken = ""
    }
}

/**
 * 会话失效广播（唯一登录被顶下线）。
 *
 * 与桌面端 preload.js 的 onSessionRevoked 订阅机制同样的考虑：
 * 「被顶下线」可能在任意页面的任意请求上发生，靠每个页面各自判断必然漏掉某个入口。
 * 因此在最外层统一广播，由 MainActivity 收集后强制退回登录页。
 */
object SessionMonitor {
    private val _revoked = MutableStateFlow<String?>(null)
    val revoked: StateFlow<String?> = _revoked.asStateFlow()

    fun report(message: String) {
        // 多个并发请求会同时返回 revoked，只保留第一条提示即可（StateFlow 天然去重后续同值，
        // 但文案可能不同，这里显式判空保证不被后到的覆盖）
        if (_revoked.value == null) _revoked.value = message
    }

    /** 界面展示完毕后调用，避免配置变更/重建时重复弹窗 */
    fun consume() {
        _revoked.value = null
    }
}
