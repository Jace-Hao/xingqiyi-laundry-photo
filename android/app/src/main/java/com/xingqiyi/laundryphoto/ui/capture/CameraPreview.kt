package com.xingqiyi.laundryphoto.ui.capture

import android.content.Context
import android.view.MotionEvent
import androidx.camera.core.Camera
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.TimeUnit

/**
 * CameraX 取景器。
 *
 * 用 CameraX 而不是直接调 Camera2：不同厂商的 Camera2 行为差异很大
 * （对焦、预览比例、旋转），CameraX 的兼容性层已经处理掉绝大多数，
 * 本项目的诉求只是「拍一张清楚的照片」，不值得自己踩这些坑。
 *
 * 点击对焦是必需的：手机自动对焦在近距离拍衣物标签时常常拉不准
 * （桌面端早期版本就有「偶发失焦」的反馈），让店员点一下衣物是关键补救手段。
 */
@Composable
fun CameraPreview(
    modifier: Modifier = Modifier,
    lifecycleOwner: LifecycleOwner = LocalLifecycleOwner.current,
    onReady: (ImageCapture) -> Unit,
    onError: (String) -> Unit
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    // LocalContext.current 是 @Composable，不能写在 remember 的计算 lambda 里，
    // 因此先取出 context 再 remember。
    val previewView = remember { PreviewView(context) }
    var cameraProvider by remember { mutableStateOf<ProcessCameraProvider?>(null) }
    var camera by remember { mutableStateOf<Camera?>(null) }

    DisposableEffect(lifecycleOwner) {
        val future = ProcessCameraProvider.getInstance(context)
        val executor = ContextCompat.getMainExecutor(context)
        future.addListener({
            runCatching {
                val provider = future.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val imageCapture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                    .build()
                provider.unbindAll()
                val bound = provider.bindToLifecycle(
                    lifecycleOwner,
                    androidx.camera.core.CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageCapture
                )
                cameraProvider = provider
                camera = bound
                setupTapToFocus(previewView, bound)
                onReady(imageCapture)
            }.onFailure { onError(it.message ?: "相机初始化失败") }
        }, executor)

        onDispose {
            // 不及时解绑会导致下次进入拍照页相机被占用（表现为黑屏）
            runCatching { cameraProvider?.unbindAll() }
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier)
}

/** 点击（或轻触）对焦到该点 */
private fun setupTapToFocus(previewView: PreviewView, camera: Camera) {
    runCatching {
        previewView.setOnTouchListener { _, event ->
            if (event.action != MotionEvent.ACTION_UP) return@setOnTouchListener true
            val factory = previewView.meteringPointFactory
            val point = factory.createPoint(event.x, event.y)
            val action = FocusMeteringAction.Builder(point)
                .setAutoCancelDuration(3, TimeUnit.SECONDS)
                .build()
            camera.cameraControl.startFocusAndMetering(action)
            true
        }
    }
}

/** 拍照：输出到临时文件，回调只回传路径，具体压缩/水印交给上层处理 */
fun takePhoto(
    context: Context,
    imageCapture: ImageCapture,
    outputFile: java.io.File,
    onSaved: (String) -> Unit,
    onError: (String) -> Unit
) {
    outputFile.parentFile?.mkdirs()
    val options = ImageCapture.OutputFileOptions.Builder(outputFile).build()
    imageCapture.takePicture(
        options,
        ContextCompat.getMainExecutor(context),
        object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                onSaved(outputFile.absolutePath)
            }

            override fun onError(exception: androidx.camera.core.ImageCaptureException) {
                onError("拍照失败：${exception.message ?: "未知原因"}")
            }
        }
    )
}
