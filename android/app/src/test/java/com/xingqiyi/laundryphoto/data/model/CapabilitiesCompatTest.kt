package com.xingqiyi.laundryphoto.data.model

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CapabilitiesDto 对**旧版本服务端**的兼容性回归测试。
 *
 * ## 为什么要专门测这个
 *
 * 现场故障：用户桌面端是 v1.3.0 之前的旧构建，`GET /ping` 只返回
 * ```json
 * {"ok":true,"data":{"app":"xingqiyi"}}
 * ```
 * 缺 `apiVersion` / `serverVersion` / `features`。
 *
 * 而 DTO 当时把这几个字段声明成**非空 String 并给了默认值**——编译器完全放行，
 * 但 Gson 反序列化**不走主构造函数、不执行默认值**，缺失字段一律填 null。
 * 于是 `ping()` 里一句 `.isBlank()` 直接 NPE，异常被兜底翻译成
 * 「对方返回的不是本系统的数据（…别漏了冒号）」，
 * 把一个**版本不兼容**问题伪装成了**用户地址填错**，用户白查防火墙和 IP。
 *
 * 这些用例锁死「缺字段不崩 + 正确降级」这一行为，防止将来又有人把字段改回非空。
 */
class CapabilitiesCompatTest {

    private val gson = Gson()

    /** 现场旧版本桌面端的真实响应体，一个字段都不多 */
    private val legacyPingJson = """{"ok":true,"data":{"app":"xingqiyi"}}"""

    /** v1.3.0 桌面端的完整响应体 */
    private val modernPingJson = """
        {"ok":true,"data":{"app":"xingqiyi-laundry-photo","apiVersion":2,
        "serverVersion":"1.3.0","features":{"uploadRaw":true,"setNote":true,
        "thumb":true,"photoTokenQuery":true}}}
    """.trimIndent()

    /**
     * 按真实链路解析：Retrofit 用 GsonConverterFactory 把整个响应体读成
     * `ApiEnvelope<CapabilitiesDto>`，data 才是能力集本体。
     * 直接把信封当 CapabilitiesDto 解析会让所有字段为 null——
     * 这本身就说明字段可空化是必要的（Gson 缺失即 null，不报错）。
     */
    private fun parsePing(json: String): CapabilitiesDto {
        val type = object : TypeToken<ApiEnvelope<CapabilitiesDto>>() {}.type
        val env = gson.fromJson<ApiEnvelope<CapabilitiesDto>>(json, type)
        assertTrue("响应信封 ok 应为 true", env.ok)
        return env.data!!
    }

    @Test
    fun `旧服务端响应体不抛异常且能降级`() {
        val caps = parsePing(legacyPingJson)

        // 关键断言：曾经就是这里 NPE
        assertEquals("xingqiyi", caps.appName)
        assertEquals("", caps.serverVersionText)
        assertEquals(1, caps.apiVersionValue)
        assertFalse(caps.supportsMobileAddons)

        // 能力全部按「不支持」降级，而不是崩掉或误判
        assertFalse(caps.uploadRaw)
        assertFalse(caps.setNote)
        assertFalse(caps.thumb)
        assertFalse(caps.photoTokenQuery)
    }

    @Test
    fun `旧服务端响应体经 ping 校验不抛 NPE`() {
        val caps = parsePing(legacyPingJson)

        // 复现 SystemRepository.ping() 的判定：
        // 旧代码直接 caps.app.isNotBlank()，这里必须换成 appName
        val app = caps.appName
        assertTrue("旧服务端应返回 app 标识", app.isNotBlank())
        assertTrue("旧服务端应被认作本系统，而不是被拒", app.startsWith("xingqiyi"))
    }

    @Test
    fun `app 字段完全缺失时也不崩`() {
        val caps = parsePing("""{"ok":true,"data":{}}""")

        assertEquals("", caps.appName)
        assertEquals("", caps.serverVersionText)
        assertEquals(1, caps.apiVersionValue)
        assertFalse(caps.supportsMobileAddons)
    }

    @Test
    fun `data 整体为 null 时不崩`() {
        val type = object : TypeToken<ApiEnvelope<CapabilitiesDto>>() {}.type
        val env = gson.fromJson<ApiEnvelope<CapabilitiesDto>>("""{"ok":true}""", type)
        val caps = env.data ?: CapabilitiesDto()

        assertEquals("", caps.appName)
        assertFalse(caps.supportsMobileAddons)
    }

    @Test
    fun `新版服务端能力集完整可用`() {
        val caps = parsePing(modernPingJson)

        assertEquals("xingqiyi-laundry-photo", caps.appName)
        assertEquals("1.3.0", caps.serverVersionText)
        assertEquals(2, caps.apiVersionValue)
        assertTrue(caps.supportsMobileAddons)
        assertTrue(caps.uploadRaw)
        assertTrue(caps.setNote)
        assertTrue(caps.thumb)
        assertTrue(caps.photoTokenQuery)
    }

    @Test
    fun `字段为 null 时兜底属性仍返回非空值`() {
        // 直接构造全 null 实例，模拟 Gson 填充失败的最坏情况
        val caps = CapabilitiesDto(app = null, apiVersion = null, serverVersion = null, features = null)

        assertEquals("", caps.appName)
        assertEquals("", caps.serverVersionText)
        assertEquals(1, caps.apiVersionValue)
        assertFalse(caps.uploadRaw)
        assertFalse(caps.setNote)
        assertFalse(caps.thumb)
        assertFalse(caps.photoTokenQuery)
    }
}
