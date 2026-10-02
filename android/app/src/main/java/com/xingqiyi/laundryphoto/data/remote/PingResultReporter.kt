package com.xingqiyi.laundryphoto.data.remote

import com.xingqiyi.laundryphoto.data.model.CapabilitiesDto

/**
 * 「测试连接」结果文案。
 *
 * ## 为什么要独立成对象
 *
 * 这段文案原先写在 [com.xingqiyi.laundryphoto.di.AppContainer.ping] 里，
 * 而 AppContainer 依赖 Android `Context`，单元测试根本构造不出来——
 * 于是「旧服务端缺字段时会不会崩」「降级提示给不给」这两件事无人能验证，
 * NPE 就这样发布到了用户手里。
 *
 * 现在把纯文案组装抽到这里：无 Android 依赖，可直接断言。
 *
 * ## 文案要区分的三种情况
 *
 * | 情况 | 判定依据 | 该说什么 |
 * |---|---|---|
 * | 新版服务端 | `apiVersion >= 2` 且带版本号 | 连接成功 + 版本号 |
 * | 新版服务端但未声明版本号 | `apiVersion >= 2`，版本号为空 | 连接成功（不提版本） |
 * | 旧版服务端 | 缺 `apiVersion` 或 `< 2` | 连接成功 + **明确的升级指引** |
 *
 * 旧服务端这一档最关键：它 HTTP 层完全正常，只是能力集字段缺失。
 * 若只回一句「连接成功」，用户随后会发现「原始上传」「改备注」两个功能
 * 悄悄消失，误以为 App 坏了。必须当场告诉他「连上了，但桌面端太旧」。
 */
object PingResultReporter {

    /**
     * 生成探活成功后的提示文案。
     *
     * @param caps 服务端能力集；字段缺失（旧服务端）时同样能安全处理
     */
    fun success(caps: CapabilitiesDto): String {
        val version = caps.serverVersionText
        val base = if (version.isBlank()) "连接成功" else "连接成功，服务端版本 v$version"

        if (caps.supportsMobileAddons) return base

        // 旧服务端：不返回能力集，v1.3.0 新增的原始上传与「改备注」不可用。
        // 说清「连上了、只是服务端偏旧」，避免功能静默消失后被当成 App 的 bug。
        return "$base；服务端版本较旧，原始上传与「改备注」不可用，" +
            "建议将桌面端升级到 v${CapabilitiesDto.MIN_SERVER_VERSION}"
    }
}