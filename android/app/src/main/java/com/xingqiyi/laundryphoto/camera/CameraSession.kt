package com.xingqiyi.laundryphoto.camera

import android.content.Context
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.UseCase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner

/**
 * 一次相机绑定会话：**只解绑自己创建的 UseCase**。
 *
 * ## 为什么不能用 provider.unbindAll()
 *
 * 导航切换（扫码页 → 全屏连拍页）时，Compose 会让新页面先完成组合、
 * 旧页面的 onDispose 后执行。若两侧都用 unbindAll()：
 * 新页面刚绑好相机，旧页面 dispose 时一记 unbindAll 把它一起解绑，
 * 结果就是「扫码成功后跳到拍照页，画面全黑」——
 * 而且这个 bug 只在真机导航时出现，单页调试永远复现不了。
 *
 * 因此每个会话记住自己创建的 UseCase，release() 时只 unbind 这几个。
 *
 * ## 生命周期
 *
 * bindToLifecycle 已经把相机与 LifecycleOwner 绑定：ON_STOP 自动关闭、
 * ON_START 自动重开，这是前后台切换与息屏的主路径。
 * 但息屏再点亮时个别机型会出现「预览黑屏但仍在分析」的状态，
 * 因此界面层额外在 ON_RESUME 时若发现相机已失效就重新绑定（见 [bindWhenResumed]）。
 */
class CameraSession {

    private val lock = Any()

    private var provider: ProcessCameraProvider? = null
    private var bound: List<UseCase> = emptyList()

    @Volatile
    var camera: Camera? = null
        private set

    /**
     * 异步绑定相机。重复调用会先释放上一次绑定，因此可安全用于「重新绑定」。
     *
     * @param onReady 绑定成功，回传 Camera（用于闪光灯、对焦等控制）
     * @param onError 失败原因，已做本地化文案，可直接展示给用户
     */
    fun bind(
        context: Context,
        owner: LifecycleOwner,
        useCases: List<UseCase>,
        selector: CameraSelector = CameraSelector.DEFAULT_BACK_CAMERA,
        onReady: (Camera) -> Unit,
        onError: (String) -> Unit
    ) {
        if (useCases.isEmpty()) {
            onError("相机用例为空")
            return
        }
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            runCatching {
                val p = future.get()
                // 先释放本会话上一次的绑定：旋转、重建、息屏恢复都会走到这里，
                // 不释放会导致 bindToLifecycle 抛「用例已绑定」异常
                releaseInternal()
                val c = p.bindToLifecycle(owner, selector, *useCases.toTypedArray())
                synchronized(lock) {
                    provider = p
                    bound = useCases.toList()
                    camera = c
                }
                c
            }.onSuccess { onReady(it) }
                .onFailure { onError(cameraErrorMessage(it)) }
        }, ContextCompat.getMainExecutor(context))
    }

    /** 释放本会话占用的相机资源。可重复调用。 */
    fun release() {
        synchronized(lock) { releaseInternal() }
    }

    private fun releaseInternal() {
        val p = provider
        val cases = bound
        if (p != null && cases.isNotEmpty()) {
            // unbind 只影响传入的用例，不会波及其它页面正在用的相机
            runCatching { p.unbind(*cases.toTypedArray()) }
        }
        bound = emptyList()
        camera = null
    }

    private fun cameraErrorMessage(t: Throwable): String {
        val raw = t.message.orEmpty()
        return when {
            raw.contains("Camera", ignoreCase = true) && raw.contains("not", ignoreCase = true) ->
                "设备没有可用相机"
            raw.contains("Permission", ignoreCase = true) -> "相机权限未授予"
            else -> "相机初始化失败：${t.message ?: "未知原因"}"
        }
    }
}
