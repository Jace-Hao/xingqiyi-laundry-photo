package com.xingqiyi.laundryphoto.data.remote

import com.xingqiyi.laundryphoto.data.model.CapabilitiesDto
import com.xingqiyi.laundryphoto.util.ServerUrlNormalizer

/**
 * 「连上了但对方不是本系统服务端」这类错误的文案生成器。
 *
 * ## 抽成独立对象的原因
 *
 * 这段文案是**现场排障的唯一线索**，必须能被单元测试直接断言：
 * 上一版把它写成 [ApiClient] 的私有方法，于是没人能测，
 * 结果它带着「无论有没有填端口都提示『实际访问的是 80 端口』」的 bug
 * 一路发布到用户手里，还把根因（服务端版本过旧）指错了方向（用户地址填错）。
 *
 * 所以这里只做纯函数：输入 baseUrl 与（可选的）响应体片段，输出最终文案。
 * 无 Android 依赖、无网络调用，单测直接跑。
 *
 * ## 文案必须包含的三件事
 *
 * 1. **实际连到哪台机器的哪个端口**——来自 [ServerUrlNormalizer.parseEndpoint]，不自己拆字符串；
 * 2. **对方实际返回了什么**——截断脱敏后的响应体片段，用户一眼就能判断是 HTML 还是旧版 JSON；
 * 3. **下一步该做什么**——核对地址端口 / 确认不是别的程序 / 升级桌面端。
 */
object MalformedResponseReporter {

    /** 响应体片段进入文案前的最大长度 */
    const val SNIPPET_LIMIT = 120

    /**
     * 匹配需要脱敏的敏感键值对。
     *
     * 覆盖 JSON 形式（`"token":"xxx"`）与查询串形式（`token=xxx`）。
     * 只脱敏**键名命中**的字段，不做「长串一律打码」——那会把正常的
     * 错误页文本也搅乱，反而看不出问题。
     */
    private val SENSITIVE_FIELD = Regex(
        """(?i)("?\b(?:api[-_]?token|session[-_]?token|token|password|passwd|secret|authorization)\b"?)(\s*[:=]\s*)("?)([^"',&\s}]+)("?)"""
    )

    private val WHITESPACE = Regex("""\s+""")

    /**
     * 脱敏并截断响应体片段。
     *
     * @param raw 响应体原文，可为 null
     * @param secrets 已知机密字面量（当前连接码/会话令牌），出现即整体替换
     * @return 可安全展示的片段；原文为空时返回 null
     */
    fun sanitize(raw: String?, secrets: List<String> = emptyList()): String? {
        if (raw.isNullOrBlank()) return null

        // 第一步：替换已知机密字面量。
        // 即使连接码裸串出现在一个「键名不敏感」的位置（如错误文案里提到它），也不会泄露。
        var text: String = raw
        secrets.filter { it.isNotBlank() }.forEach { secret -> text = text.replace(secret, MASK) }

        // 第二步：按敏感键名打码。
        // 替换结果存进独立 val 而不继续写 text：text 已被上面的 forEach 闭包捕获，
        // Kotlin 对被闭包捕获的 var 不做智能转换，后续 isEmpty()/take() 会编译失败。
        val masked = SENSITIVE_FIELD.replace(text) { m ->
            m.groupValues[1] + m.groupValues[2] + m.groupValues[3] + MASK + m.groupValues[5]
        }

        // 第三步：压成单行。HTML 与 JSON 都可能带大量换行，直接拼进提示会撑破排版
        val oneLine = masked.replace(WHITESPACE, " ").trim()
        if (oneLine.isEmpty()) return null

        return if (oneLine.length > SNIPPET_LIMIT) oneLine.take(SNIPPET_LIMIT) + "…" else oneLine
    }

    /**
     * 生成「连上了但返回的不是本系统数据」的完整提示。
     *
     * @param baseUrl 实际使用的 baseUrl（已规范化，含 scheme 与端口）
     * @param bodySnippet 已脱敏截断的响应体片段，可为 null
     */
    fun build(baseUrl: String, bodySnippet: String? = null): String {
        val endpoint = ServerUrlNormalizer.parseEndpoint(baseUrl)
        val host = endpoint?.authority ?: baseUrl.ifBlank { "未知地址" }
        val defaultPort = ServerUrlNormalizer.DEFAULT_PORT

        // 端口提示只在**确实没写端口**时出现。
        // 端口已指定却仍提示「实际访问的是 80 端口」，是上一版最令人困惑的缺陷：
        // 用户明明填了 17521，却被告知漏了冒号，于是去反复检查一个本来没错的地方。
        val portHint = if (endpoint == null || endpoint.port == null) {
            "（当前未指定端口，实际访问的是 80 端口；本系统默认端口为 $defaultPort）"
        } else {
            ""
        }

        val bodyHint = bodySnippet?.takeIf { it.isNotBlank() }
            ?.let { "对方实际返回：$it。" }
            ?: ""

        return buildString {
            append("已连接到 $host$portHint，但对方返回的不是本系统的数据。")
            if (bodyHint.isNotEmpty()) append(bodyHint)
            append("请核对：")
            append("① 地址格式应为 http://内网IP:$defaultPort（IP 与端口之间的冒号不能漏）；")
            append("② 该端口确实是本系统服务端，而非路由器后台或其他程序；")
            append("③ 若上面返回的是本系统的精简 JSON，说明桌面端版本过旧，建议升级到 v")
            append(CapabilitiesDto.MIN_SERVER_VERSION)
            append(" 及以上。")
        }
    }

    private const val MASK = "***"
}