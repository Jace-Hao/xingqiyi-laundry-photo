package com.xingqiyi.laundryphoto.data.remote

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * [MalformedResponseReporter] 的回归测试。
 *
 * ## 这个文件要防住的具体事故
 *
 * 用户在安卓 App 填 `http://192.168.110.10:17521`（端口填对了），
 * 点「测试连接」却收到：
 *
 * > 已连接到 192.168.110.10:17521，但对方返回的不是本系统的数据
 * > （当前未指定端口，实际访问的是 80 端口……）
 *
 * 提示自己就自相矛盾。根因是端口判断写错了——把已经剥掉 scheme 的字符串
 * 又做了一次 `substringAfter("://")`，必然取空，于是**永远**走「未指定端口」分支。
 * 用户据此去查防火墙、查 IP，全都白查。
 *
 * 所以本文件锁死两件事：
 * 1. **带端口时不得出现「80 端口」字样**；
 * 2. 响应体片段要能被展示，且**不得泄露连接码/令牌**。
 */
class MalformedResponseReporterTest {

    private val defaultPort = com.xingqiyi.laundryphoto.util.ServerUrlNormalizer.DEFAULT_PORT

    // ---------- 缺陷二：端口误报 ----------

    @Test
    fun `带端口时不得提示 80 端口`() {
        // 用户截图里的原样地址：端口填对了
        val msg = MalformedResponseReporter.build("http://192.168.110.10:17521")

        assertThat(msg).doesNotContain("80 端口")
        assertThat(msg).doesNotContain("未指定端口")
        // 但仍要明确说出连到了哪台机器的哪个端口，供用户核对
        assertThat(msg).contains("192.168.110.10:17521")
    }

    @Test
    fun `带自定义非默认端口时同样不得提示 80 端口`() {
        val msg = MalformedResponseReporter.build("http://192.168.110.10:8080")

        assertThat(msg).doesNotContain("80 端口")
        assertThat(msg).doesNotContain("未指定端口")
        assertThat(msg).contains("192.168.110.10:8080")
    }

    @Test
    fun `带域名与端口时不得提示 80 端口`() {
        val msg = MalformedResponseReporter.build("http://laundry-server.local:17521")

        assertThat(msg).doesNotContain("80 端口")
        assertThat(msg).contains("laundry-server.local:17521")
    }

    @Test
    fun `确实未指定端口时必须提示 80 端口与默认端口`() {
        // 这条提示本身是对的：没写端口时 HTTP 确实回退到 80，
        // 而现场最容易踩的坑就是把请求打到了 80 端口上的别的服务。
        val msg = MalformedResponseReporter.build("http://192.168.110.10")

        assertThat(msg).contains("未指定端口")
        assertThat(msg).contains("80 端口")
        assertThat(msg).contains("本系统默认端口为 $defaultPort")
    }

    // ---------- 缺陷二附带项：响应体片段可展示 ----------

    @Test
    fun `响应体片段进入文案便于用户自查`() {
        // 旧版服务端返回的就是这个：HTTP 层完全正常，但缺能力集字段
        val msg = MalformedResponseReporter.build(
            baseUrl = "http://192.168.110.10:17521",
            bodySnippet = """{"ok":true,"data":{"app":"xingqiyi"}}"""
        )

        assertThat(msg).contains("xingqiyi")
        // 既然对方回的就是本系统的 JSON，必须把「升级桌面端」这条指引给出来
        assertThat(msg).contains("1.3.0")
    }

    @Test
    fun `片段为空白时不输出多余文案`() {
        val msg = MalformedResponseReporter.build("http://192.168.110.10:17521", bodySnippet = "   ")

        assertThat(msg).doesNotContain("对方实际返回")
    }

    @Test
    fun `无法解析的地址也能给出提示而不抛异常`() {
        val msg = MalformedResponseReporter.build("")

        assertThat(msg).contains("不是本系统的数据")
    }

    // ---------- 脱敏：绝不能把连接码/令牌写进用户可见文案 ----------

    @Test
    fun `脱敏会抹掉 token 字段的值`() {
        val raw = """{"ok":false,"message":"invalid","token":"SECRET-TOKEN-VALUE"}"""

        val safe = MalformedResponseReporter.sanitize(raw)

        assertThat(safe).doesNotContain("SECRET-TOKEN-VALUE")
        assertThat(safe).contains("***")
    }

    @Test
    fun `脱敏会抹掉查询串形式的连接码`() {
        val raw = "GET /photo?f=a.jpg&token=ABC123SECRET&w=360 404"

        val safe = MalformedResponseReporter.sanitize(raw)

        assertThat(safe).doesNotContain("ABC123SECRET")
        // 非敏感部分必须保留，否则用户看不出是哪个接口出的问题
        assertThat(safe).contains("/photo")
    }

    @Test
    fun `脱敏会抹掉已知机密字面量即使用户没把它当敏感字段`() {
        // 兜底：连接码裸串出现在正文任何位置都必须被替换
        val raw = """{"message":"令牌 X-CONNECT-9F2A 不匹配"}"""

        val safe = MalformedResponseReporter.sanitize(raw, secrets = listOf("X-CONNECT-9F2A"))

        assertThat(safe).doesNotContain("X-CONNECT-9F2A")
    }

    @Test
    fun `脱敏后超长片段被截断`() {
        val raw = "A".repeat(500)

        val safe = MalformedResponseReporter.sanitize(raw)

        assertThat(safe!!.length).isAtMost(MalformedResponseReporter.SNIPPET_LIMIT + 1)
        assertThat(safe).endsWith("…")
    }

    @Test
    fun `脱敏把多行 HTML 压成单行`() {
        val raw = "<html>\n  <head>\n    <title>404</title>\n  </head>\n</html>"

        val safe = MalformedResponseReporter.sanitize(raw)

        assertThat(safe).doesNotContain("\n")
        assertThat(safe).contains("404")
    }

    @Test
    fun `空响应体返回 null`() {
        assertThat(MalformedResponseReporter.sanitize(null)).isNull()
        assertThat(MalformedResponseReporter.sanitize("")).isNull()
        assertThat(MalformedResponseReporter.sanitize("  \n ")).isNull()
    }
}