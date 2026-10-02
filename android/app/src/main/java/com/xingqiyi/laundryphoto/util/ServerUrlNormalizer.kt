package com.xingqiyi.laundryphoto.util

/**
 * 服务器地址规范化。
 *
 * ## 为什么要专门做这件事
 *
 * 现场最常见、也最难自查的一类填错方式，是**漏写端口分隔符冒号**：
 *
 * ```
 * 想填： http://192.168.110.17:17521
 * 实际填：http://192.168.110.1717521   ← 少了冒号
 * ```
 *
 * 这时 `java.net.URL` 会把整串数字当成主机名，端口回退到 80：
 * `host=192.168.110.1717521, port=-1(默认 80)`。
 * 于是请求打到了**完全不相干的服务**（路由器后台、连错端口的别的程序、
 * 甚至某些设备上的 Web 页面），对方返回的是 HTML 而不是本系统的 JSON，
 * 客户端 Gson 解析失败，最终只抛出一句
 * 「服务端返回数据异常，请确认地址指向的是本系统服务端」。
 *
 * 这个提示本身没错，但把「少了个冒号」这种一眼可修的问题，
 * 包装成了「地址指向了错误的服务」这种难以自查的问题——
 * 用户会去检查防火墙、IP 是否正确，却永远查不到那根缺失的冒号。
 *
 * ## 处理策略
 *
 * 1. 明显缺少冒号（主机名是一串纯数字且不是合法 IPv4）时，**自动补上默认端口**；
 * 2. 主机名末段超过 255 时，按「IP 末段 + 端口」拆分补全（如上例）；
 * 3. 无论如何都保证结果是 `scheme://host:port` 这一完整形式，
 *    避免再出现"少一个冒号就静默换端口"的静默失败。
 *
 * ## 单一数据源
 *
 * 地址的**写入**（[normalize]）与**读出**（[parseEndpoint]）都收口在本文件内。
 * 报错文案、指纹校验、实际发请求用的都是同一个 [Endpoint]，
 * 不允许任何地方再拿 `baseUrl` 自己 `substringAfter("://")` 拆一遍——
 * 那类重复解析正是「明明填了 17521，提示却说访问的是 80 端口」这类自相矛盾文案的来源。
 */
object ServerUrlNormalizer {

    /** 桌面端服务端默认 HTTP 端口，与 main/store.js 的 `port: 17521` 保持一致 */
    const val DEFAULT_PORT = 17521

    /** 合法 IPv4 的单段上限 */
    private const val MAX_OCTET = 255

    /**
     * 拆解后的服务端地址。
     *
     * @param port 为 null 表示原始地址里没写端口（由调用方决定回退到 [DEFAULT_PORT] 还是报错）
     */
    data class Endpoint(
        val scheme: String,
        val host: String,
        val port: Int?
    ) {
        /** 实际会访问的端口 */
        val effectivePort: Int get() = port ?: DEFAULT_PORT

        /** 供界面展示与日志使用的 `host:port` */
        val authority: String get() = if (port == null) host else "$host:$port"
    }

    sealed class Result {
        /** 规范化成功，可直接用于 Retrofit */
        data class Ok(
            val baseUrl: String,
            val adjusted: Boolean,
            /** 与 [baseUrl] 等价的结构化地址，避免调用方二次解析字符串 */
            val endpoint: Endpoint
        ) : Result()

        /** 地址无法解析，需提示用户 */
        data class Invalid(val reason: String) : Result()
    }

    /**
     * 规范化用户输入的服务器地址。
     *
     * 容错范围（现场真实填法）：
     * - 漏写 `http://` → 自动补；
     * - 漏写端口冒号（`192.168.110.1717521`）→ 按 [splitMissingColon] 的规则纠正或明确报错；
     * - 漏写端口（`192.168.110.10`）→ 补 [DEFAULT_PORT]；
     * - 混有空格（复制粘贴与手机输入法最容易带）→ 去掉；
     * - 结尾多个斜杠 → 收敛成一个；
     * - scheme 大小写混杂 → 统一小写，避免同一个地址在日志里出现两种写法。
     *
     * @param raw 用户原始输入
     * @return [Result.Ok]（adjusted=true 表示本次自动纠正过地址）或 [Result.Invalid]
     */
    fun normalize(raw: String): Result {
        // 去掉全部空白：冒号或斜杠两侧的空格会让 Retrofit 判为非法地址，
        // 而 trim() 只处理首尾，中间的空格留到后面必然变成一条看不懂的报错。
        val text = raw.filterNot { it.isWhitespace() }
        if (text.isBlank()) return Result.Invalid("请填写服务器地址")

        // 补 scheme：用户常只填 192.168.1.10:17521
        val lower = text.lowercase()
        val withScheme = if (lower.startsWith("http://") || lower.startsWith("https://")) {
            text
        } else {
            "http://$text"
        }

        val schemeEnd = withScheme.indexOf("://") + 3
        val scheme = withScheme.substring(0, schemeEnd).lowercase()
        // authority = host[:port]，不含路径部分（本项目只用根路径）
        val authority = withScheme.substring(schemeEnd).substringBefore('/')

        if (authority.isBlank()) return Result.Invalid("服务器地址缺少主机名")

        val host: String
        val port: Int
        var adjusted = false

        if (authority.contains(':')) {
            // 正常写法：拆 host 与 port
            val idx = authority.lastIndexOf(':')
            val h = authority.substring(0, idx)
            val p = authority.substring(idx + 1)
            val parsedPort = p.toIntOrNull()
            if (p.isNotEmpty() && (parsedPort == null || parsedPort !in 1..65535)) {
                return Result.Invalid("端口号「$p」无效，应为 1~65535 的数字")
            }
            host = h.lowercase()
            port = parsedPort ?: DEFAULT_PORT
            if (parsedPort == null) adjusted = true
        } else {
            // 没有冒号：这里就是漏写端口分隔符的高发点
            val fixed = splitMissingColon(authority.lowercase())
                ?: return Result.Invalid(
                    "无法判断「$authority」是 IP 还是「IP:端口」。" +
                        "请按 http://内网IP:$DEFAULT_PORT 的格式填写（IP 与端口之间必须有冒号）"
                )
            host = fixed.first
            port = fixed.second
            adjusted = fixed.third
        }

        if (host.isBlank()) return Result.Invalid("服务器地址缺少主机名")
        if (isAllDigits(host) && !isValidIpv4(host)) {
            return Result.Invalid("主机名「$host」不是有效的 IP 地址，请检查是否漏写了端口冒号")
        }

        return Result.Ok(
            baseUrl = "$scheme$host:$port/",
            adjusted = adjusted,
            endpoint = Endpoint(scheme = scheme, host = host, port = port)
        )
    }

    /**
     * 拆解一个 `scheme://host[:port]` 形态的地址（[normalize] 的产物，或用户原样输入）。
     *
     * 存在的意义：报错文案需要准确回答「我到底连到了哪台机器的哪个端口」。
     * 过去 ApiClient 是拿 `baseUrl.substringAfter("://")` 得到 authority 之后，
     * 又对**同一个已被截断过的字符串**再调用一次 `substringAfter("://", "")`，
     * 第二次必然取不到分隔符而返回空串，`contains(':')` 恒为 false，
     * 于是**无论用户填没填端口**都会断言「未指定端口，实际访问 80 端口」——
     * 这正是用户截图里「已连接到 192.168.110.10:17521，却说访问的是 80 端口」这句自相矛盾的来源。
     *
     * @return 拆解结果；完全无法解析时返回 null
     */
    fun parseEndpoint(baseUrl: String): Endpoint? {
        val text = baseUrl.trim()
        if (text.isBlank()) return null

        val schemeEnd = text.indexOf("://")
        val scheme: String
        val authority: String
        if (schemeEnd >= 0) {
            scheme = text.substring(0, schemeEnd).lowercase()
            authority = text.substring(schemeEnd + 3).substringBefore('/')
        } else {
            // 允许直接传 "192.168.1.10:17521" 这种缺 scheme 的形态
            scheme = "http"
            authority = text.substringBefore('/')
        }
        if (authority.isBlank()) return null

        val host: String
        val port: Int?
        if (authority.contains(':')) {
            val idx = authority.lastIndexOf(':')
            host = authority.substring(0, idx).lowercase()
            // 端口非法时按「未指定」处理，交由调用方回退默认端口：
            // 读地址的路径本身不该成为新的错误来源。
            port = authority.substring(idx + 1).toIntOrNull()?.takeIf { it in 1..65535 }
        } else {
            host = authority.lowercase()
            port = null
        }
        if (host.isBlank()) return null
        return Endpoint(scheme = scheme, host = host, port = port)
    }

    private fun isAllDigits(s: String): Boolean = s.isNotEmpty() && s.all { it.isDigit() }

    /**
     * 处理「漏写冒号」的情况。
     *
     * 只有当整串是**合法 IPv4**（4 段、每段 0~255）时，才把末段之后的内容当作端口。
     * 如果末段本身就 > 255（说明 IP 的最后一段和端口粘在了一起，如 `192.168.110.1717521`
     * 是 `17` + `17521`），则在**末段内部**寻找切分点，并要求切分后能得到合法 IPv4。
     *
     * 切分点可能不唯一（`1717521` 还能切成 `171|7521`），因此有明确的优先级：
     * 1. 优先选择端口恰好等于 [DEFAULT_PORT] 的切分——这是文档中告知用户的端口，命中率最高；
     * 2. 只有唯一一种合法切分时才采纳；
     * 3. 多种切分且都不是默认端口 → **不猜**，返回 null 让用户自己补冒号。
     *    猜错的后果是连到一台毫不相干的机器上，比报错更难排查。
     */
    private fun splitMissingColon(authority: String): Triple<String, Int, Boolean>? {
        // 情况一：本身是合法 IPv4，无需拆分，补默认端口即可
        if (isValidIpv4(authority)) {
            return Triple(authority, DEFAULT_PORT, true)
        }

        val parts = authority.split('.')
        val last = parts.lastOrNull() ?: return null
        if (!isAllDigits(last)) {
            // 非纯数字末段：视作域名，主机保持原样
            return Triple(authority, DEFAULT_PORT, true)
        }
        if (last.toIntOrNull()?.let { it <= MAX_OCTET } == true) {
            // 末段本身合法但整串不是合法 IPv4（段数不对），无从修复
            return null
        }

        // 情况二：末段 > 255，在末段内部寻找「IP 末段 + 端口」的切分点
        val head = parts.dropLast(1)
        val candidates = mutableListOf<Pair<String, Int>>()
        for (i in 1 until last.length) {
            val prefix = last.substring(0, i)
            val suffix = last.substring(i)
            if (!isValidOctet(prefix)) continue
            val port = suffix.toIntOrNull() ?: continue
            if (port !in 1..65535) continue
            if (suffix.length > 1 && suffix.startsWith("0")) continue // 端口前导零视为笔误
            val host = (head + prefix).joinToString(".")
            if (!isValidIpv4(host)) continue
            candidates += host to port
        }

        if (candidates.isEmpty()) return null

        val preferred = candidates.firstOrNull { it.second == DEFAULT_PORT }
        if (preferred != null) return Triple(preferred.first, preferred.second, true)

        // 唯一候选可以安全采纳；多个候选说明无法判断用户意图，拒绝猜测
        if (candidates.size == 1) {
            val (h, p) = candidates.first()
            return Triple(h, p, true)
        }
        return null
    }

    /** 单段是否为合法 IPv4 段：0~255 且无前导零 */
    private fun isValidOctet(s: String): Boolean {
        val n = s.toIntOrNull() ?: return false
        return n in 0..MAX_OCTET && s == n.toString()
    }

    /** 判断点分十进制串是否是合法 IPv4（4 段、每段 0~255、无前导零） */
    fun isValidIpv4(s: String): Boolean {
        val parts = s.split('.')
        if (parts.size != 4) return false
        return parts.all { isValidOctet(it) }
    }

    /**
     * 判断「这串东西压根不是 IP」，用于地址正确但连不上时给出更准的提示。
     * 例如用户填了公网域名或本机名。
     *
     * 复用 [parseEndpoint] 而不是自己再拆一遍字符串：host 的取法必须全项目一致。
     */
    fun looksLikeHostOnly(baseUrl: String): Boolean {
        val host = parseEndpoint(baseUrl)?.host ?: return false
        return !isAllDigits(host) && !isValidIpv4(host)
    }
}
