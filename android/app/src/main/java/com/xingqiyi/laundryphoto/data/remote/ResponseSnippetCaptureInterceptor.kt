package com.xingqiyi.laundryphoto.data.remote

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/**
 * 响应体片段捕获。
 *
 * ## 为什么需要它
 *
 * 「对方返回的不是本系统的数据」这句话之所以难自查，是因为它**只说了连上了**，
 * 没说**对方到底返回了什么**。现场常见三种返回：路由器后台的 HTML、
 * 某个 Web 服务的 404 页、以及**旧版本服务端那个只含 `{"app":"xingqiyi"}` 的合法 JSON**——
 * 最后一种尤其关键：它在 HTTP 层完全正常，却会让客户端按能力集缺失降级，
 * 用户看到的是「功能悄悄没了」，而不是「你的服务端版本太旧」。
 *
 * Gson 抛出的 [com.google.gson.JsonParseException] 里并不携带响应体原文，
 * 所以只能在网络层把正文截一小段留存下来，供错误文案使用。
 *
 * ## 实现约束
 *
 * - 用 [Response.peekBody] 而不是 `response.body.string()`：
 *   前者只缓冲指定字节数且**不消费**响应体，Gson 之后仍能正常读取；
 * - 只在解析失败时才可能被用到，因此不必全程留全文，限制 512 字节足够判断类型；
 * - 落盘前一律经 [MalformedResponseReporter.sanitize] 脱敏并截断，
 *   **不得**把连接码/会话令牌写进任何用户可见文案或日志。
 */
internal class ResponseSnippetCaptureInterceptor(
    private val secretsProvider: () -> List<String>,
    private val onSnippet: (String?) -> Unit
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        // 先清空：本次响应若读不出正文，不能让上一次的片段残留到本次错误文案里
        onSnippet(null)
        val snippet = try {
            response.peekBody(MAX_SNIPPET_BYTES)
                .let { MalformedResponseReporter.sanitize(it.string(), secretsProvider()) }
        } catch (e: IOException) {
            // 读正文失败不影响主流程：拿不到片段只是少一句诊断信息而已
            null
        }
        onSnippet(snippet)
        return response
    }

    private companion object {
        /** 留存上限。足够判断「HTML / 404 页 / 本系统 JSON」，又不至于把大响应体拽进内存 */
        const val MAX_SNIPPET_BYTES = 512L
    }
}