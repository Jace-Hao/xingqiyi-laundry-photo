package com.xingqiyi.laundryphoto.ui.capture

import android.content.Context
import androidx.camera.core.ImageCapture
import androidx.camera.core.Preview
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xingqiyi.laundryphoto.camera.BindCameraToLifecycle
import com.xingqiyi.laundryphoto.camera.CameraSession
import com.xingqiyi.laundryphoto.camera.attachTapToFocus
import com.xingqiyi.laundryphoto.camera.rememberCameraPreviewView

/**
 * CameraX 取景器。
 *
 * 用 CameraX 而不是直接调 Camera2：不同厂商的 Camera2 行为差异很大
 * （对焦、预览比例、旋转），CameraX 的兼容性层已经处理掉绝大多数，
 * 本项目的诉求只是「拍一张清楚的照片」，不值得自己踩这些坑。
 *
 * 点击对焦是必需的：手机自动对焦在近距离拍衣物标签时常常拉不准
 * （桌面端早期版本就有「偶发失焦」的反馈），让店员点一下衣物是关键补救手段。
 *
 * 【改动】原实现在 onDispose 里调 `provider.unbindAll()`。
 * 新增扫码页后两个相机页会在导航过渡期短暂共存，
 * unbindAll 会把另一页刚绑好的相机一并解绑（表现为跳过去黑屏）。
 * 现统一改用 [CameraSession]，只解绑本页自己创建的用例。
 */
@Composable
fun CameraPreview(
    modifier: Modifier = Modifier,
    lifecycleOwner: LifecycleOwner = LocalLifecycleOwner.current,
    onReady: (ImageCapture) -> Unit,
    onError: (String) -> Unit
) {
    // LocalContext.current 是 @Composable，不能写在 remember 的计算 lambda 里，
    // 因此先取出 context 再 remember。
    val context = LocalContext.current
    val previewView = rememberCameraPreviewView()
    val session = remember { CameraSession() }

    val preview = remember { Preview.Builder().build() }
    val imageCapture = remember {
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .build()
    }

    BindCameraToLifecycle(
        session = session,
        lifecycleOwner = lifecycleOwner,
        bind = {
            preview.setSurfaceProvider(previewView.surfaceProvider)
            session.bind(
                context = context,
                owner = lifecycleOwner,
                useCases = listOf(preview, imageCapture),
                onReady = { camera ->
                    attachTapToFocus(previewView, camera)
                    onReady(imageCapture)
                },
                onError = onError
            )
        },
        release = { session.release() }
    )

    AndroidView(factory = { previewView }, modifier = modifier)
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
