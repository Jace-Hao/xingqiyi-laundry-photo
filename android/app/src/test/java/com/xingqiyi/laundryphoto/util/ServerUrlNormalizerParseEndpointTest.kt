package com.xingqiyi.laundryphoto.util

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * [ServerUrlNormalizer.parseEndpoint] 的回归测试。
 *
 * ## 为什么单独测「读地址」这件事
 *
 * 地址的**写入**（[normalize] 补冒号、补端口）从一开始就是对的，
 * 上一版也确实修好了漏冒号的场景。但真正让用户困惑的却是**读地址**的代码：
 * 报错文案需要回答「我到底连到了哪台机器的哪个端口」，
 * 而那段代码把同一个字符串拆了两遍，第二遍必然失败，
 * 于是无论用户填没填端口都断言「实际访问的是 80 端口」。
 *
 * 「读」与「写」必须收口到同一套规则，否则文案就会和实际行为对不上。
 */
class ServerUrlNormalizerParseEndpointTest {

    private fun endpointOf(url: String): ServerUrlNormalizer.Endpoint {
        val e = ServerUrlNormalizer.parseEndpoint(url)
        assertThat(e).isNotNull()
        return e!!
    }

    // ---------- 带端口：必须能读出来 ----------

    @Test
    fun `解析带端口的 IP 地址`() {
        val e = endpointOf("http://192.168.110.10:17521")

        assertThat(e.scheme).isEqualTo("http")
        assertThat(e.host).isEqualTo("192.168.110.10")
        assertThat(e.port).isEqualTo(17521)
        assertThat(e.effectivePort).isEqualTo(17521)
    }

    @Test
    fun `解析带端口的域名地址`() {
        val e = endpointOf("https://laundry-server.local:8443/")

        assertThat(e.scheme).isEqualTo("https")
        assertThat(e.host).isEqualTo("laundry-server.local")
        assertThat(e.port).isEqualTo(8443)
    }

    @Test
    fun `authority 输出 host 冒号 port`() {
        assertThat(endpointOf("http://192.168.110.10:17521").authority)
            .isEqualTo("192.168.110.10:17521")
    }

    @Test
    fun `normalize 产物可直接被 parseEndpoint 读回`() {
        // 写入与读取必须是同一套规则的往返，否则文案必然与实际连接不符
        val normalized = ServerUrlNormalizer.normalize("http://192.168.110.1717521")
        val ok = normalized as ServerUrlNormalizer.Result.Ok
        val parsed = endpointOf(ok.baseUrl)

        assertThat(parsed.host).isEqualTo("192.168.110.17")
        assertThat(parsed.port).isEqualTo(17521)
        assertThat(parsed.authority).isEqualTo(ok.endpoint.authority)
    }

    // ---------- 不带端口：port 必须为 null，交由调用方决定如何提示 ----------

    @Test
    fun `未指定端口时 port 为 null`() {
        val e = endpointOf("http://192.168.110.10")

        assertThat(e.port).isNull()
        assertThat(e.host).isEqualTo("192.168.110.10")
        // effectivePort 仍给出可用端口，方便需要「实际端口」的场合
        assertThat(e.effectivePort).isEqualTo(ServerUrlNormalizer.DEFAULT_PORT)
        assertThat(e.authority).isEqualTo("192.168.110.10")
    }

    @Test
    fun `端口非法时按未指定处理而不是抛异常`() {
        // 读地址的路径本身不该成为新的错误来源：宁可回退默认端口，也不能崩
        val e = endpointOf("http://192.168.110.10:notaport")

        assertThat(e.port).isNull()
        assertThat(e.host).isEqualTo("192.168.110.10")
    }

    // ---------- 容错形态 ----------

    @Test
    fun `缺 scheme 时按 http 解析`() {
        val e = endpointOf("192.168.1.10:17521")

        assertThat(e.scheme).isEqualTo("http")
        assertThat(e.host).isEqualTo("192.168.1.10")
        assertThat(e.port).isEqualTo(17521)
    }

    @Test
    fun `主机名大小写被统一为小写`() {
        // 同一个地址在日志里出现两种写法会让用户以为「我填的怎么变了」
        assertThat(endpointOf("HTTP://Laundry-Server.Local:17521").host)
            .isEqualTo("laundry-server.local")
    }

    @Test
    fun `空地址返回 null`() {
        assertThat(ServerUrlNormalizer.parseEndpoint("")).isNull()
        assertThat(ServerUrlNormalizer.parseEndpoint("   ")).isNull()
        assertThat(ServerUrlNormalizer.parseEndpoint("http://")).isNull()
    }
}