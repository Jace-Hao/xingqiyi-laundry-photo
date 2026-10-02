package com.xingqiyi.laundryphoto.data.remote

import com.google.common.truth.Truth.assertThat
import com.google.gson.Gson
import com.xingqiyi.laundryphoto.data.model.CapabilitiesDto
import org.junit.Test

/**
 * [PingResultReporter] 的回归测试。
 *
 * 现场事故：用户桌面端是 v1.3.0 之前的旧构建，`/ping` 只返回
 * `{"ok":true,"data":{"app":"xingqiyi"}}`。
 *
 * 旧代码在这里对 `caps.serverVersion` 调 `.isBlank()`，而该字段被 Gson 填成了
 * `null`（非空声明挡不住，因为反序列化不走 Kotlin 主构造函数）→ NPE →
 * 用户看到的是「对方返回的不是本系统的数据（别漏了冒号）」，
 * 于是去查一个本来完全正确的端口配置。
 *
 * 这些用例锁死两件事：**旧服务端不崩**，且**必须给出可操作的升级指引**。
 */
class PingResultReporterTest {

    private val gson = Gson()

    /** 现场旧版本桌面端的真实响应体，一个字段都不多 */
    private val legacyCaps = gson.fromJson(
        """{"app":"xingqiyi"}""",
        CapabilitiesDto::class.java
    )

    @Test
    fun `旧服务端不抛异常且提示升级`() {
        // 关键断言：曾经就是这里 NPE
        val msg = PingResultReporter.success(legacyCaps)

        assertThat(msg).contains("连接成功")
        assertThat(msg).contains("版本较旧")
        assertThat(msg).contains("v${CapabilitiesDto.MIN_SERVER_VERSION}")
        // 必须点名是哪些功能不可用，否则用户只知道「旧」却不知道少了什么
        assertThat(msg).contains("原始上传")
    }

    @Test
    fun `旧服务端缺字段时不得出现 NullPointerException`() {
        // 全 null：模拟 Gson 填充失败的最坏情况
        val worst = CapabilitiesDto(app = null, apiVersion = null, serverVersion = null, features = null)

        val msg = PingResultReporter.success(worst)

        assertThat(msg).contains("连接成功")
        assertThat(msg).doesNotContain("null")
    }

    @Test
    fun `新版服务端展示版本号且不提旧`() {
        val caps = gson.fromJson(
            """{"app":"xingqiyi-laundry-photo","apiVersion":2,"serverVersion":"1.3.0","features":{"uploadRaw":true,"setNote":true,"thumb":true,"photoTokenQuery":true}}""",
            CapabilitiesDto::class.java
        )

        val msg = PingResultReporter.success(caps)

        assertThat(msg).isEqualTo("连接成功，服务端版本 v1.3.0")
        assertThat(msg).doesNotContain("版本较旧")
    }

    @Test
    fun `apiVersion 低于 2 视为旧版`() {
        val caps = CapabilitiesDto(app = "xingqiyi", apiVersion = 1, serverVersion = "1.2.2")

        val msg = PingResultReporter.success(caps)

        assertThat(msg).contains("服务端版本 v1.2.2")
        assertThat(msg).contains("版本较旧")
    }

    @Test
    fun `新版服务端未声明版本号时只说连接成功`() {
        // apiVersion 够新但没有 serverVersion：不该编造版本号，也不该误报「旧」
        val caps = CapabilitiesDto(app = "xingqiyi", apiVersion = 2, serverVersion = null)

        val msg = PingResultReporter.success(caps)

        assertThat(msg).isEqualTo("连接成功")
    }
}