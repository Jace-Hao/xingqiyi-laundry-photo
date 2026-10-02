package com.xingqiyi.laundryphoto.data.repository

import com.xingqiyi.laundryphoto.data.model.CapabilitiesDto
import com.xingqiyi.laundryphoto.data.model.ForceUpdateDto
import com.xingqiyi.laundryphoto.data.model.SystemInfoDto
import com.xingqiyi.laundryphoto.data.model.UpdateInfoDto
import com.xingqiyi.laundryphoto.data.remote.ApiClient
import com.xingqiyi.laundryphoto.data.remote.ApiError
import com.xingqiyi.laundryphoto.util.ServerUrlNormalizer

/**
 * 系统信息仓库。
 *
 * 移动端只保留「只读信息 + 强制更新查询」：
 * 端口、照片保存路径、开机自启、强制推送安装包、订单保留期这些都是**服务端本机**的设置，
 * 在手机上改它们既无意义（改的是服务器那台机器的磁盘路径）又危险（改错会让全店数据不可写），
 * 因此这些能力在移动端不做入口，仅展示当前值供核对。
 */
class SystemRepository(private val api: ApiClient) {

    suspend fun info(): SystemInfoDto = api.request { it.systemInfo(emptyMap()) }

    suspend fun forceUpdate(): ForceUpdateDto? = api.request { it.forceUpdate(emptyMap()) }

    suspend fun checkUpdate(): UpdateInfoDto = api.request { it.checkUpdate(emptyMap()) }

    /**
     * 拉取服务端能力集。
     * 老服务端没有该接口时返回 null（不抛错），调用方按「最低能力集」处理——
     * 这样新 App 连老服务端仍能完成拍照与查询，只是不走原始上传通道。
     */
    suspend fun capabilitiesOrNull(): CapabilitiesDto? {
        return try {
            api.request { it.capabilities(emptyMap()) }
        } catch (e: ApiError.Unsupported) {
            null
        }
    }

    /**
     * 免鉴权探活：校验地址是否指向本系统服务端。
     * 用于「登录页填写服务器地址」时的即时校验，比等到登录失败再报错体验好得多。
     *
     * 除了网络可达性，还要确认**对方确实是本系统服务端**：
     * 仅凭 HTTP 200 与 `ok:true` 都不够——连到路由器后台或其他 Web 服务同样会通，
     * 甚至别的后端也会回一个语法合法的 `{"ok":true,"data":{...}}`。
     * 唯一的判据是本系统特有的 **app 标识**。
     *
     * ## 判定条件为什么是「app 必须以 xingqiyi 开头」而不是「app 不为空」
     *
     * 早前写成 `if (app.isNotBlank() && !app.startsWith("xingqiyi"))`，
     * 看起来兼顾了新旧服务端，实际却**放行了最危险的一种情况**：
     * `app` 缺失时 `isNotBlank()` 为 false，整个条件短路为 false，
     * 于是「响应体里根本没有本系统标识」这种最该拒绝的情况反而被当作通过。
     * 用户于是在别的后端上看到了「连接成功」，直到登录/上传才真正失败。
     *
     * 正确做法是取反：**只要不是本系统的 app，一律拒绝**。
     * 旧版本服务端返回的 `xingqiyi` 同样以该前缀开头（见 CapabilitiesCompatTest），
     * 因此这个收紧不会误伤旧服务端。
     */
    suspend fun ping(): CapabilitiesDto {
        val caps = api.request { it.ping() }
        // 用 appName（可空兜底）而非 app 本身：旧版本服务端只返回 {app:"xingqiyi"}，
        // 若把 app 声明为非空 String，Gson 遇到缺字段会填 null，
        // 这里一句 isNotBlank() 就是 NPE——现场「新旧版本不兼容」就是这样
        // 被伪装成「对方返回的不是本系统的数据」，误导用户去查地址和端口。
        val app = caps.appName
        if (!app.startsWith(APP_ID_PREFIX, ignoreCase = true)) {
            throw ApiError.Network(
                if (app.isBlank()) {
                    "该地址返回的数据里没有本系统的标识字段（app），" +
                        "说明这个端口上运行的不是本系统服务端。" +
                        "请确认端口是否为 ${ServerUrlNormalizer.DEFAULT_PORT}"
                } else {
                    "该地址返回的不是本系统服务端（app=$app）。" +
                        "请确认端口是否为 ${ServerUrlNormalizer.DEFAULT_PORT}"
                }
            )
        }
        return caps
    }

    /**
     * 本系统服务端 app 标识的前缀。
     *
     * 服务端实际返回 `xingqiyi-laundry-photo`（见 main/store.js 的 CAPABILITIES），
     * 旧版本返回 `xingqiyi`，两者都以此前缀开头——用前缀而非全等，
     * 是为了让新旧服务端都能通过校验。大小写不敏感：app 只是标识，不是路由。
     */
    private companion object {
        const val APP_ID_PREFIX = "xingqiyi"
    }
}
