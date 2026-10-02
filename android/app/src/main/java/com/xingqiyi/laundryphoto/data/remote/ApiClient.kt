package com.xingqiyi.laundryphoto.data.remote

import com.google.gson.Gson
import com.google.gson.JsonParseException
import com.xingqiyi.laundryphoto.data.model.ApiEnvelope
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

    val isConfigured: Boolean get() = service != null

    /**
     * 配置（或切换）服务器地址。返回 false 表示地址非法，调用方提示用户即可。
     * 地址变更后旧的 Retrofit 实例整体重建——baseUrl 是 Retrofit 不可变属性，
     * 且令牌可能同时变更，重建比局部替换更不容易出错。
     */
    fun configure(rawBaseUrl: String): Boolean {
        val base = rawBaseUrl.trim().trimEnd('/')
        if (base.isBlank()) {
            service = null
            baseUrl = ""
            return true
        }
        return try {
            // Retrofit 对 baseUrl 要求必须以 / 结尾且能被解析，非法地址在此直接抛异常
            Retrofit.Builder().baseUrl("$base/").build()
            service = buildService(base)
            baseUrl = base
            true
        } catch (e: IllegalArgumentException) {
            false
        }
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
            else -> ApiError.Network("服务端响应异常（HTTP ${e.code()}）")
        }
        // 以下顺序不可调换：UnknownHostException / SocketTimeoutException / ConnectException
        // 都是 IOException 的子类，必须先匹配具体类型，否则会退化成笼统的「网络异常」，
        // 界面就无法区分「地址写错」和「服务器没开」这两种最常见的现场问题。
        is UnknownHostException -> ApiError.Network("无法连接服务器，请检查服务器地址是否正确")
        is SocketTimeoutException -> ApiError.Network("连接服务器超时，请检查网络或服务端是否在线")
        is ConnectException -> ApiError.Network("无法连接服务器，请确认服务端已启动且端口可达")
        is SocketException -> ApiError.Network("网络连接中断，请稍后重试")
        is JsonParseException -> ApiError.Network("服务端返回数据异常，请确认地址指向的是本系统服务端")
        is IOException -> ApiError.Network("网络异常：${e.message ?: "未知错误"}")
        else -> ApiError.Network(e.message ?: "请求失败")
    }

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
