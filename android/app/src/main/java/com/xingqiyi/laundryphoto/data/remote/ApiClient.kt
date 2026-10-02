package com.xingqiyi.laundryphoto.data.remote

import com.google.gson.Gson
import com.google.gson.JsonIOException
import com.google.gson.JsonParseException
import com.xingqiyi.laundryphoto.data.model.ApiEnvelope
import com.xingqiyi.laundryphoto.util.ServerUrlNormalizer
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.io.IOException
import java.net.ConnectException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

/**
 * 服务端接口客户端。
 *
 * 负责三件事：
 * 1. 组装 OkHttp/Retrofit（含令牌注入、超时、日志）；
 * 2. 把各种失败翻译成 [ApiError] 的具体子类，让界面能区分「离线」「连接码失效」「被顶下线」；
 * 3. 提供照片 URL 的拼装（桌面端的 xqy-photo:// 协议在移动端不存在，必须自己拼 HTTP 地址）。
 */
class ApiClient(
    private val sessionHolder: SessionHolder,
    private val debug: Boolean = false,
    private val onSessionRevoked: (String) -> Unit = { SessionMonitor.report(it) }
) {
    @Volatile
    private var service: ApiService? = null

    @Volatile
    var baseUrl: String = ""
        private set

    /** 最近一次拿到的服务端能力集；用于判断能否走原始上传等新通道 */
    @Volatile
    var capabilities: com.xingqiyi.laundryphoto.data.model.CapabilitiesDto? = null
        private set

    /**
     * 最近一次响应的正文片段（已脱敏截断）。
     *
     * 仅用于生成「对方返回的不是本系统的数据」这句排障提示：
     * Gson 的解析异常里没有正文，而用户要判断「对方到底是 HTML 还是旧版 JSON」
     * 必须看到原文。由 [ResponseSnippetCaptureInterceptor] 在网络层抓取。
     */
    @Volatile
    private var lastResponseSnippet: String? = null

    val isConfigured: Boolean get() = service != null

    /**
     * 配置（或切换）服务器地址。
     *
     * 传入的原始串会先经 [normalizeBaseUrl] 规范化。
     *
     * 注意：早前这里描述的场景是「`http://192.168.110.1717521` 漏写冒号 →
     * 被当成主机名 + 80 端口 → 打到不相干的服务上返回 HTML」。
     * 该问题现在由 [com.xingqiyi.laundryphoto.util.ServerUrlNormalizer] 在**发请求之前**
     * 就补全端口解决了，**不会再有以 80 端口发出的请求**，
     * 因此若仍看到「实际访问的是 80 端口」的提示，那一定是地址真的没写端口。
     *
     * @return 规范化后的 baseUrl；地址非法时返回 null，调用方提示用户即可。
     */
    fun configure(rawBaseUrl: String): Boolean {
        val base = normalizeBaseUrl(rawBaseUrl)
        if (base.isNullOrBlank()) {
            service = null
            baseUrl = ""
            return true
        }
        return try {
            // Retrofit 对 baseUrl 要求必须以 / 结尾且能被解析，非法地址在此直接抛异常
            Retrofit.Builder().baseUrl(base).build()
            service = buildService(base.removeSuffix("/"))
            baseUrl = base.removeSuffix("/")
            true
        } catch (e: IllegalArgumentException) {
            service = null
            baseUrl = ""
            false
        }
    }

    /**
     * 把用户输入规整成 `scheme://host:port/`。
     * 规则见 [ServerUrlNormalizer]；这里只做一层薄封装，便于单测与复用。
     */
    fun normalizeBaseUrl(raw: String): String? =
        when (val r = ServerUrlNormalizer.normalize(raw)) {
            is ServerUrlNormalizer.Result.Ok -> r.baseUrl
            is ServerUrlNormalizer.Result.Invalid -> null
        }

    fun rememberCapabilities(caps: com.xingqiyi.laundryphoto.data.model.CapabilitiesDto?) {
        capabilities = caps
    }

    private fun buildService(base: String): ApiService {
        val builder = OkHttpClient.Builder()
            // 连接超时刻意设短（8s）：局域网内服务端要么秒连要么不通，
            // 长超时只会让用户在弱网下干等，而离线模式本来就能继续拍照。
            .connectTimeout(8, TimeUnit.SECONDS)
            // 读写超时放长：上传一张 3~8MB 的照片在弱网下可能需要几十秒
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .addInterceptor(AuthInterceptor(sessionHolder))
            // 抓取响应正文片段供错误文案使用。放在鉴权之后：
            // 片段里可能含敏感字段，交给脱敏器处理，同时避免在鉴权失败时也去读正文。
            .addInterceptor(
                ResponseSnippetCaptureInterceptor(
                    secretsProvider = { listOf(sessionHolder.apiToken, sessionHolder.sessionToken) },
                    onSnippet = { lastResponseSnippet = it }
                )
            )
        if (debug) {
            // 仅在 debug 包开启，且只到 BODY 级别；发布包不注入，避免日志里出现连接码
            builder.addInterceptor(
                HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC }
            )
        }
        return Retrofit.Builder()
            .baseUrl("$base/")
            .client(builder.build())
            .addConverterFactory(GsonConverterFactory.create(Gson()))
            .build()
            .create(ApiService::class.java)
    }

    private fun requireService(): ApiService =
        service ?: throw ApiError.Network("尚未配置服务器地址，请先在登录页填写")

    /** 需要返回数据的请求 */
    suspend fun <T> request(block: suspend (ApiService) -> ApiEnvelope<T>): T {
        val svc = requireService()
        val env = try {
            block(svc)
        } catch (e: Exception) {
            throw translate(e)
        }
        checkEnvelope(env)
        return env.data ?: throw ApiError.Business("服务端未返回数据")
    }

    /** 不关心返回数据的请求（删除、退出登录等，服务端只回 ok/data:true） */
    suspend fun requestUnit(block: suspend (ApiService) -> ApiEnvelope<*>) {
        val svc = requireService()
        val env = try {
            block(svc)
        } catch (e: Exception) {
            throw translate(e)
        }
        checkEnvelope(env)
    }

    private fun checkEnvelope(env: ApiEnvelope<*>) {
        if (env.revoked == true) {
            val msg = env.message ?: "账号已在其他设备登录，当前会话已失效，请重新登录"
            onSessionRevoked(msg)
            throw ApiError.SessionRevoked(msg)
        }
        if (!env.ok) {
            val msg = env.message ?: "请求失败"
            // 老版本服务端没有移动端新增接口时会回「接口不存在」，
            // 单独成类是为了让调用方能静默降级（例如回退到 base64 上传）而不是弹错误。
            if (msg.contains("接口不存在")) throw ApiError.Unsupported(msg)
            throw ApiError.Business(msg)
        }
    }

    private fun translate(e: Throwable): Throwable = when (e) {
        is ApiError -> e
        is HttpException -> when (e.code()) {
            401 -> ApiError.Auth("连接码无效或已被重置，请重新配置服务器连接码")
            403 -> ApiError.Auth("无权限访问该接口，请检查连接码与账号权限")
            // 服务端 404/500 也可能只是「地址指错了服务」，把状态码与地址一并带出
            else -> ApiError.Network("服务端响应异常（HTTP ${e.code()}），请确认地址与端口指向本系统服务端")
        }
        // 以下顺序不可调换：UnknownHostException / SocketTimeoutException / ConnectException
        // 都是 IOException 的子类，必须先匹配具体类型，否则会退化成笼统的「网络异常」，
        // 界面就无法区分「地址写错」和「服务器没开」这两种最常见的现场问题。
        is UnknownHostException ->
            ApiError.Network("域名无法解析：$baseUrl。若目标是局域网电脑，请改用内网 IP（如 192.168.1.10:${ServerUrlNormalizer.DEFAULT_PORT}）")
        is SocketTimeoutException -> ApiError.Network("连接服务器超时，请检查网络或服务端是否在线")
        is ConnectException -> ApiError.Network("无法连接服务器，请确认服务端已启动且端口可达")
        is SocketException -> ApiError.Network("网络连接中断，请稍后重试")
        is JsonIOException -> ApiError.Network(clientSideDefectMessage(e))
        is JsonParseException -> ApiError.Network(malformedResponseMessage())
        is IOException -> ApiError.Network("网络异常：${e.message ?: "未知错误"}")
        else -> ApiError.Network(e.message ?: "请求失败")
    }

    /**
     * 「App 自己的 Gson 映射被混淆破坏」的提示。
     *
     * ## 为什么要把它和 [malformedResponseMessage] 分开
     *
     * [JsonIOException] 是 [JsonParseException] 的子类，而后者对应的是
     * 「服务端返回了本系统不认识的非 JSON 内容」——责任在服务端或地址填错。
     * 但 R8 剥离 DTO 字段时抛的也是 [JsonIOException]，责任在**发布包本身**。
     *
     * 两者混为一谈的后果非常具体：v1.3.0 就因为混淆规则漏了 `data.model.**`，
     * release 包里 `ApiEnvelope`/`CapabilitiesDto` 被剥成零字段空壳，
     * 于是每次 ping 都抛 JsonIOException，被翻译成
     * 「已连接到 xxx，但对方返回的不是本系统的数据」——
     * 而服务端返回的 JSON 明明完全合法（`app`/`apiVersion`/`features` 一应俱全）。
     * 用户于是去查地址、查端口、查桌面端版本，三条线索全是错的。
     *
     * 所以这里必须原样带上 Gson 的原始信息：它会直接点名
     * 「Adjust the R8 configuration」，这才是真正该做的事。
     */
    private fun clientSideDefectMessage(e: JsonIOException): String {
        val detail = e.message?.takeIf { it.isNotBlank() } ?: "Gson 无法完成对象映射"
        return "本 App 的安装包存在缺陷（数据映射被代码压缩破坏），并非服务器或地址问题。\n" +
            "请安装最新版本；若已是最新，请把下面这行反馈给开发：\n$detail"
    }

    /**
     * 响应体不是本系统 JSON 时的提示。
     *
     * 走到这里说明 TCP 连接是通的，但对方返回的内容 Gson 解析不了——
     * 绝大多数情况是**地址或端口指错了服务**（打到了路由器后台、别的程序、
     * 或 80 端口上的 Web 页面），而不是本系统服务端真的坏了。
     *
     * 文案组装已抽到 [MalformedResponseReporter]：它只依赖 baseUrl 与已脱敏的响应体片段，
     * 是纯函数，能被单元测试直接断言。留在本类里私有实现的历史教训是
     * 「有没有填端口都提示 80 端口」这种自相矛盾逻辑没人能测出来。
     */
    private fun malformedResponseMessage(): String =
        MalformedResponseReporter.build(baseUrl, lastResponseSnippet)

    /**
     * 拼照片访问地址。
     *
     * 桌面端用自定义协议 xqy-photo:// 交给 Electron 协议处理器，移动端没有这层，
     * 因此直接访问服务端的 /photo：连接码走查询参数（服务端兼容该方式），
     * 这样 Coil 可以直接加载，无需为图片请求单独加请求头。
     *
     * @param width 缩略图宽度；为 null 时取原图（详情查看用）
     */
    fun photoUrl(photoFile: String, width: Int? = null): String {
        if (photoFile.isBlank()) return ""
        val encoded = URLEncoder.encode(photoFile, "UTF-8").replace("+", "%20")
        val token = URLEncoder.encode(sessionHolder.apiToken, "UTF-8").replace("+", "%20")
        return buildString {
            append(baseUrl).append("/photo?f=").append(encoded)
            append("&token=").append(token)
            if (width != null && width > 0) append("&w=").append(width)
        }
    }
}

/**
 * 令牌注入拦截器。
 * 连接码（x-api-token）与会话令牌（x-session-token）对所有接口都是必需的，
 * 统一在此注入可避免每个接口方法重复声明 @Header。
 */
private class AuthInterceptor(private val holder: SessionHolder) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request().newBuilder()
            .addHeader("x-api-token", holder.apiToken)
            .addHeader("x-session-token", holder.sessionToken)
            .build()
        return chain.proceed(req)
    }
}
