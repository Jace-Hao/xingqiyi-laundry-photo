package com.xingqiyi.laundryphoto.data.remote

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * SessionMonitor 是被顶下线的全局广播中枢：任意页面请求返回 revoked 都汇入此处，
 * 由 MainActivity 收集后强制退登录。这里验证「只保留第一条」与「消费后可复位」的语义，
 * 避免多个并发请求把同一条提示刷成多条。
 */
class SessionMonitorTest {

    @Test
    fun report_keepsFirstMessage() {
        SessionMonitor.report("第一台设备")
        SessionMonitor.report("第二台设备")
        assertThat(SessionMonitor.revoked.value).isEqualTo("第一台设备")
    }

    @Test
    fun consume_resets() {
        SessionMonitor.report("被顶下线了")
        assertThat(SessionMonitor.revoked.value).isNotNull()
        SessionMonitor.consume()
        assertThat(SessionMonitor.revoked.value).isNull()
    }
}
