package com.xingqiyi.laundryphoto.data.repository

import com.xingqiyi.laundryphoto.data.model.CapabilitiesDto
import com.xingqiyi.laundryphoto.data.model.ForceUpdateDto
import com.xingqiyi.laundryphoto.data.model.SystemInfoDto
import com.xingqiyi.laundryphoto.data.model.UpdateInfoDto
import com.xingqiyi.laundryphoto.data.remote.ApiClient
import com.xingqiyi.laundryphoto.data.remote.ApiError

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
     * 仅凭 HTTP 200 不够——连到路由器后台或其他 Web 服务同样会通，
     * 但它们的返回体没有本系统的特征字段。因此这里显式校验 app 标识。
     */
    suspend fun ping(): CapabilitiesDto {
        val caps = api.request { it.ping() }
        if (caps.app.isNotBlank() && !caps.app.startsWith("xingqiyi")) {
            throw ApiError.Network(
                "该地址返回的不是本系统服务端（app=${caps.app}）。" +
                    "请确认端口是否为 ${com.xingqiyi.laundryphoto.util.ServerUrlNormalizer.DEFAULT_PORT}"
            )
        }
        return caps
    }
}
