package com.xingqiyi.laundryphoto.util

import com.google.common.truth.Truth.assertThat
import org.junit.Test

/**
 * 地址规范化是本次线上问题的核心修复，必须锁死行为。
 *
 * 真实案例（用户截图）：想填 `http://192.168.110.17:17521`，
 * 实际填成 `http://192.168.110.1717521`（漏了冒号），
 * 结果请求打到 80 端口的另一个服务，客户端只报「服务端返回数据异常」。
 */
class ServerUrlNormalizerTest {

    private fun ok(raw: String): ServerUrlNormalizer.Result.Ok {
        val r = ServerUrlNormalizer.normalize(raw)
        assertThat(r).isInstanceOf(ServerUrlNormalizer.Result.Ok::class.java)
        return r as ServerUrlNormalizer.Result.Ok
    }

    // ---------- 正常写法：不应被改动 ----------

    @Test
    fun keepsWellFormedAddress() {
        val r = ok("http://192.168.110.17:17521")
        assertThat(r.baseUrl).isEqualTo("http://192.168.110.17:17521/")
        assertThat(r.adjusted).isFalse()
    }

    @Test
    fun keepsHttpsAndCustomPort() {
        assertThat(ok("https://192.168.1.10:8443").baseUrl).isEqualTo("https://192.168.1.10:8443/")
    }

    @Test
    fun trimsTrailingSlashes() {
        assertThat(ok("http://192.168.1.10:17521///").baseUrl).isEqualTo("http://192.168.1.10:17521/")
    }

    @Test
    fun acceptsIpv4WithoutPortAndAddsDefault() {
        val r = ok("192.168.1.10")
        assertThat(r.baseUrl).isEqualTo("http://192.168.1.10:17521/")
        assertThat(r.adjusted).isTrue()
    }

    @Test
    fun addsSchemeWhenMissing() {
        assertThat(ok("192.168.1.10:17521").baseUrl).isEqualTo("http://192.168.1.10:17521/")
    }

    // ---------- 现场真实场景：漏写冒号 ----------

    @Test
    fun repairsMissingColonIpAndPortGlued() {
        // 截图原样：192.168.110.17 + 17521 粘成 192.168.110.1717521
        val r = ok("http://192.168.110.1717521")
        assertThat(r.baseUrl).isEqualTo("http://192.168.110.17:17521/")
        assertThat(r.adjusted).isTrue()
    }

    @Test
    fun repairsMissingColonWithoutScheme() {
        assertThat(ok("192.168.110.1717521").baseUrl).isEqualTo("http://192.168.110.17:17521/")
    }

    @Test
    fun repairsThreeDigitIpGluedWithPort() {
        // 192.168.1.5 + 17521 -> 192.168.1.517521
        assertThat(ok("http://192.168.1.517521").baseUrl).isEqualTo("http://192.168.1.5:17521/")
    }

    // ---------- 非法输入：必须给出可执行的原因 ----------

    @Test
    fun rejectsBlankAddress() {
        val r = ServerUrlNormalizer.normalize("   ")
        assertThat(r).isInstanceOf(ServerUrlNormalizer.Result.Invalid::class.java)
    }

    @Test
    fun rejectsNonNumericPort() {
        val r = ServerUrlNormalizer.normalize("http://192.168.1.10:abc")
        assertThat(r).isInstanceOf(ServerUrlNormalizer.Result.Invalid::class.java)
        assertThat((r as ServerUrlNormalizer.Result.Invalid).reason).contains("端口")
    }

    @Test
    fun rejectsOutOfRangePort() {
        val r = ServerUrlNormalizer.normalize("http://192.168.1.10:70000")
        assertThat(r).isInstanceOf(ServerUrlNormalizer.Result.Invalid::class.java)
    }

    @Test
    fun rejectsTooLongNumericHost() {
        // 末段仍 > 255 且无法再切分时应判非法，而不是悄悄连到错误主机
        val r = ServerUrlNormalizer.normalize("http://192.168.999999")
        assertThat(r).isInstanceOf(ServerUrlNormalizer.Result.Invalid::class.java)
    }

    // ---------- 主机名（非 IP）不应被误判 ----------

    @Test
    fun supportsHostName() {
        val r = ok("http://laundry-server.local:17521")
        assertThat(r.baseUrl).isEqualTo("http://laundry-server.local:17521/")
    }

    @Test
    fun hostWithoutPortGetsDefault() {
        assertThat(ok("http://laundry-server.local").baseUrl)
            .isEqualTo("http://laundry-server.local:17521/")
    }

    // ---------- IPv4 判定 ----------

    @Test
    fun isValidIpv4() {
        assertThat(ServerUrlNormalizer.isValidIpv4("192.168.1.10")).isTrue()
        assertThat(ServerUrlNormalizer.isValidIpv4("0.0.0.0")).isTrue()
        assertThat(ServerUrlNormalizer.isValidIpv4("255.255.255.255")).isTrue()
        assertThat(ServerUrlNormalizer.isValidIpv4("192.168.1")).isFalse()
        assertThat(ServerUrlNormalizer.isValidIpv4("192.168.1.256")).isFalse()
        assertThat(ServerUrlNormalizer.isValidIpv4("192.168.01.1")).isFalse() // 前导零
        assertThat(ServerUrlNormalizer.isValidIpv4("laundry")).isFalse()
    }

    @Test
    fun detectsHostNameOnlyAddress() {
        assertThat(ServerUrlNormalizer.looksLikeHostOnly("http://192.168.1.10:17521/")).isFalse()
        assertThat(ServerUrlNormalizer.looksLikeHostOnly("http://laundry.local:17521/")).isTrue()
    }
}
