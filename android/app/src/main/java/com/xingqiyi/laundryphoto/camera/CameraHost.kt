package com.xingqiyi.laundryphoto.camera

import android.view.MotionEvent
import androidx.camera.core.Camera
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.TimeUnit

/**
 * 创建取景器视图。
 *
 * 两个设置都直接关系到「预览不能变形 / 不能黑屏」，说明如下：
 *
 * - `FILL_CENTER`：等比放大到铺满容器后居中裁剪。
 *   预览变形的唯一成因就是拉伸，而 PreviewView 一旦用 FILL_* / FIT_* 之外的模式
 *   （或父容器给了与预览比例不一致的尺寸却不裁剪）就会拉伸。
 *   用 `FIT_CENTER` 不拉伸但会留黑边，不符合「铺满屏幕」的要求，故选 FILL_CENTER。
 *
 * - `COMPATIBLE`（TextureView 而非 SurfaceView）：
 *   这是 Compose 场景的稳妥选择。PERFORMANCE 模式底层是 SurfaceView，
 *   它不在普通 View 层级里合成，导航过渡期间会「穿透」盖在上层 UI 之上，
 *   且无法被裁剪。TextureView 多耗一点 GPU，但换来的是与 Compose 完全一致的层级行为。
 *   必须在 setSurfaceProvider 之前设置——放在 remember 里创建正好满足。
 */
@Composable
fun rememberCameraPreviewView(): PreviewView {
    val context = LocalContext.current
    return remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
    }
}

/**
 * 统一的 4:3 分辨率选择器。
 *
 * 三处（预览 / 图像分析 / 拍照）必须用**同一个**比例策略：
 * CameraX 在多个用例比例不一致时会各自挑分辨率，
 * 结果是「预览里看到的构图」和「拍出来的照片」不是同一块画面。
 *
 * 用 `ResolutionSelector` 而不是已废弃的 `setTargetAspectRatio()`：
 * 后者在 CameraX 1.3 起被标记废弃，且不带 fallback 策略，
 * 在部分不支持 4:3 的机型上会直接绑定失败。
 * `RATIO_4_3_FALLBACK_AUTO_STRATEGY` 的意思是「优先 4:3，做不到就自动退让」，
 * 这正是对兼容性要求高的门店设备所需要的。
 */
fun fourByThreeSelector(): ResolutionSelector =
    ResolutionSelector.Builder()
        .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
        .build()

/**
 * 轻点对焦。
 *
 * 扫码场景下这个不是锦上添花：吊牌条码普遍只有 2~3cm 宽，
 * 自动对焦在近距离经常锁到布料纹理上，画面看着清晰但条码是糊的，
 * 表现为「明明对准了却死活扫不出来」。让店员点一下条码位置是最可靠的补救。
 */
fun attachTapToFocus(previewView: PreviewView, camera: Camera?) {
    val c = camera ?: return
    runCatching {
        previewView.setOnTouchListener { _, event ->
            if (event.action != MotionEvent.ACTION_UP) return@setOnTouchListener true
            val point = previewView.meteringPointFactory.createPoint(event.x, event.y)
            val action = FocusMeteringAction.Builder(point)
                .setAutoCancelDuration(3, TimeUnit.SECONDS)
                .build()
            c.cameraControl.startFocusAndMetering(action)
            true
        }
    }
}

/**
 * 把相机绑定挂到页面生命周期上。
 *
 * 处理的三种情况：
 * 1. **首次进入**：页面已处于 RESUMED 时 addObserver 会同步补发 ON_RESUME，
 *    此时由观察者直接完成绑定；若生命周期还没到 RESUMED（例如从锁屏直接回来），
 *    由下面的兜底 bind() 补上，避免「进了页面却是黑屏」；
 * 2. **息屏 / 切后台**：ON_STOP 主动释放，而不是等系统杀进程。
 *    相机是独占硬件，不释放会让别的 App（微信扫码）也打不开；
 * 3. **息屏再点亮**：ON_RESUME 重新绑定。
 *    这一步不能省：部分机型息屏后 CameraX 的 surface 不会自动恢复，
 *    只靠 bindToLifecycle 会停在「预览黑屏但仍在分析」的状态。
 */
@Composable
fun BindCameraToLifecycle(
    session: CameraSession,
    bind: () -> Unit,
    release: () -> Unit,
    lifecycleOwner: LifecycleOwner = LocalLifecycleOwner.current
) {
    // bind/release 每次重组都是新 lambda，但 DisposableEffect 只以 lifecycleOwner 为 key，
    // 不 rememberUpdatedState 的话会一直持有首次的旧闭包（绑定的还是旧参数）
    val currentBind by rememberUpdatedState(bind)
    val currentRelease by rememberUpdatedState(release)
    val currentSession by rememberUpdatedState(session)

    DisposableEffect(lifecycleOwner) {
        var active = false
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> {
                    active = true
                    currentBind()
                }
                Lifecycle.Event.ON_STOP -> {
                    active = false
                    currentRelease()
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (!active) currentBind()

        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            currentSession.release()
        }
    }
}
