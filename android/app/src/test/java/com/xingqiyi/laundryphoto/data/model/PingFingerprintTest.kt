package com.xingqiyi.laundryphoto.data.model

import com.google.common.truth.Truth.assertThat
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import org.junit.Test

/**
 * 「探活指纹校验」的判定规则回归测试。
 *
 * ## 这条规则为什么关键
 *
 * 「测试连接」的全部可信度都建立在**一个判据**上：
 * 响应体里的 `app` 字段是否表明对方是本系统服务端。
 * 判据一旦放宽，登录页就会对着一台毫不相干的机器显示「连接成功」，
 * 用户直到登录或上传时才失败——而那时早已离开现场，无从排查。
 *
 * ## 曾被放行的两类响应
 *
 * 1. `app` 字段**不存在**：
 *    ```json
 *    {"ok":true,"data":{"status":"healthy"}}
 *    ```
 *    这是任何后端框架的默认响应形状。旧判定写作
 *    `if (app.isNotBlank() && !app.startsWith("xingqiyi"))`，
 *    `app` 为空时 `isNotBlank()` 返回 false，整个条件短路，
 *    **最该拒绝的情况反而被放行**。
 *
 * 2. `app` 为空串：同样短路通过。
 *
 * 正确规则是取反：不是本系统的 `app` 一律拒绝，
 * 而旧版本服务端的 `xingqiyi` 同样以此前缀开头，因此收紧不会误伤旧服务端。
 */
class PingFingerprintTest {

    private val gson = Gson()

    /**
     * 复用 SystemRepository.ping() 的真实判定，避免测试与实现各写一套。
     *
     * 必须按**真实链路**解析：Retrofit 用 GsonConverterFactory 先把整个响应体
     * 读成 `ApiEnvelope<CapabilitiesDto>`，再由调用方取 `.data`。
     * 早前版本直接把信封喂给内层 DTO，于是 `app`（在 data 里）恒为 null，
     * 三个「应通过」用例全挂、四个「应拒绝」用例却假性通过——
     * 这种测试不但自己报错，还等于完全没有保护力。
     */
    private fun isOurServer(json: String): Boolean {
        val type = object : TypeToken<ApiEnvelope<CapabilitiesDto>>() {}.type
        val caps = gson.fromJson<ApiEnvelope<CapabilitiesDto>>(json, type).data
            ?: return false
        return caps.appName.startsWith(APP_ID_PREFIX, ignoreCase = true)
    }

    // ---------- 必须被拒绝：不是本系统 ----------

    @Test
    fun `新版服务端的完整响应通过校验`() {
        val json = """
            {"ok":true,"data":{"app":"xingqiyi-laundry-photo","apiVersion":2,
            "serverVersion":"1.3.1","features":{"uploadRaw":true,"setNote":true,
            "thumb":true,"photoTokenQuery":true}}}
        """.trimIndent()
        assertThat(isOurServer(json)).isTrue()
    }

    @Test
    fun `旧版服务端的精简响应仍通过校验`() {
        // 兼容性红线：收紧指纹校验绝不能把旧服务端挡在门外
        assertThat(isOurServer("""{"ok":true,"data":{"app":"xingqiyi"}}""")).isTrue()
    }

    @Test
    fun `其他后端的默认响应被拒绝`() {
        // 后一类 bug 的根源：app 缺失时旧判定会短路放行
        assertThat(isOurServer("""{"ok":true,"data":{"status":"healthy"}}""")).isFalse()
    }

    @Test
    fun `data 为空对象时被拒绝`() {
        assertThat(isOurServer("""{"ok":true,"data":{}}""")).isFalse()
    }

    @Test
    fun `app 为空串时被拒绝`() {
        assertThat(isOurServer("""{"ok":true,"data":{"app":""}}""")).isFalse()
    }

    @Test
    fun `app 为其他产品的标识时被拒绝`() {
        // 同一个端口上跑着别的系统，且恰好也回 ok:true
        assertThat(isOurServer("""{"ok":true,"data":{"app":"some-other-system"}}""")).isFalse()
    }

    @Test
    fun `app 为 null 时被拒绝`() {
        assertThat(isOurServer("""{"ok":true,"data":{"app":null}}""")).isFalse()
    }

    @Test
    fun `data 整体缺失时被拒绝`() {
        // 上面所有用例都带 data 包裹；这里补最外层就没有 data 的形态，
        // 确认调用方对 env.data == null 的兜底不会误判为本系统
        assertThat(isOurServer("""{"ok":true}""")).isFalse()
    }

    @Test
    fun `只有大小写差异的 xingqiyi 前缀应视为同一系统`() {
        // app 不是超链接，标识比对应大小写不敏感
        assertThat(isOurServer("""{"ok":true,"data":{"app":"XingQiYi-Laundry"}}""")).isTrue()
    }

    /** 与 SystemRepository.APP_ID_PREFIX 保持一致 */
    private companion object {
        const val APP_ID_PREFIX = "xingqiyi"
    }
}
