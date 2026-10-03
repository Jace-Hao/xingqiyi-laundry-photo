package com.xingqiyi.laundryphoto.ui.scan

import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xingqiyi.laundryphoto.camera.BarcodeAnalyzer
import com.xingqiyi.laundryphoto.camera.BindCameraToLifecycle
import com.xingqiyi.laundryphoto.camera.CameraSession
import com.xingqiyi.laundryphoto.camera.attachTapToFocus
import com.xingqiyi.laundryphoto.camera.fourByThreeSelector
import com.xingqiyi.laundryphoto.camera.rememberCameraPreviewView
import com.xingqiyi.laundryphoto.ui.camera.CameraPermissionGate
import com.xingqiyi.laundryphoto.ui.camera.rememberCameraPermissionState
import com.xingqiyi.laundryphoto.ui.components.ErrorBar
import kotlinx.coroutines.delay
import java.util.concurrent.Executors

/**
 * 扫码录入第一步：扫衣物吊牌上的条码 / 二维码。
 *
 * 识别成功后把码值交给调用方（导航到全屏连拍页），本页不产生任何服务端请求。
 *
 * ## 相机在这里是怎么「不打架」的
 * 扫码页与连拍页各持有自己的 [CameraSession]。
 * 导航切换时两页会短暂同时存在，如果沿用旧的 `provider.unbindAll()`，
 * 旧页面 dispose 时会把新页面刚绑好的相机一起解绑 → 跳过去就是黑屏。
 * 因此统一走 [CameraSession]，每个会话只 unbind 自己创建的那几个用例。
 */
@Composable
fun ScanScreen(
    vm: ScanViewModel,
    onResult: (String) -> Unit,
    onBack: () -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val permission = rememberCameraPermissionState()

    val detected by vm.detected.collectAsState()
    val noResult by vm.noResult.collectAsState()
    val cameraError by vm.cameraError.collectAsState()
    val attempt by vm.attempt.collectAsState()

    // ---------- 无权限：直接走兜底引导，页面其余部分不再组合 ----------
    if (!permission.granted) {
        Surface(color = MaterialTheme.colorScheme.background) {
            CameraPermissionGate(
                state = permission,
                onBack = onBack,
                title = "需要相机权限才能扫码",
                usage = "扫码识别衣物条码需要相机权限。拒绝后仍可查询订单，但无法录入衣物照片。"
            )
        }
        return
    }

    // ---------- 相机资源 ----------
    val previewView = rememberCameraPreviewView()
    val session = remember { CameraSession() }
    // 解码在专用单线程上跑：放主线程会卡住预览，放 CameraX 默认的共用线程会拖慢取帧
    val analyzerExecutor = remember { Executors.newSingleThreadExecutor() }
    val analyzer = remember { BarcodeAnalyzer(onResult = vm::onDetected) }

    val preview = remember {
        Preview.Builder().setResolutionSelector(fourByThreeSelector()).build()
    }
    val analysis = remember {
        ImageAnalysis.Builder()
            .setResolutionSelector(fourByThreeSelector())
            // 只保留最新一帧：识别是「尽力而为」的，丢旧帧比排队等旧帧更有意义
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
    }

    DisposableEffect(Unit) { onDispose { analyzerExecutor.shutdown() } }

    // 新一轮识别：复位分析器的一次性命中标记，并重启「长时间无结果」倒计时
    LaunchedEffect(attempt) {
        analyzer.reset()
        delay(ScanViewModel.NO_RESULT_TIMEOUT_MS)
        vm.onNoResultTimeout()
    }

    // 命中后停留片刻再跳：让用户看清扫到的是哪个码，避免「莫名其妙就跳页了」
    LaunchedEffect(detected) {
        val value = detected ?: return@LaunchedEffect
        delay(350)
        onResult(value)
    }

    BindCameraToLifecycle(
        session = session,
        bind = {
            preview.setSurfaceProvider(previewView.surfaceProvider)
            analysis.setAnalyzer(analyzerExecutor, analyzer)
            session.bind(
                context = context,
                owner = lifecycleOwner,
                useCases = listOf(preview, analysis),
                onReady = { camera ->
                    vm.clearCameraError()
                    attachTapToFocus(previewView, camera)
                },
                onError = { vm.onCameraError(it) }
            )
        },
        release = { session.release() }
    )

    // ---------- 界面 ----------
    var manualInput by remember { mutableStateOf(false) }

    BoxWithConstraints(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        // 与 ScannerOverlay 保持同一套几何常量，提示文字才能紧贴取景框下沿
        val frameW = maxWidth * DEFAULT_FRAME_WIDTH_RATIO
        val frameH = frameW * DEFAULT_FRAME_ASPECT
        val frameTop = (maxHeight - frameH) * 0.42f

        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())

        ScannerOverlay(
            running = detected == null && cameraError == null,
            accent = if (detected == null) DEFAULT_ACCENT else SUCCESS_ACCENT
        )

        // ---------- 顶部返回 ----------
        Row(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = Color.White)
            }
            Text(
                "扫描衣物条码",
                color = Color.White,
                style = MaterialTheme.typography.titleMedium
            )
        }

        // ---------- 取景框正下方：对准提示 / 无结果提示 ----------
        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(top = frameTop + frameH + 18.dp)
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            when {
                detected != null -> {
                    Text(
                        "已识别：$detected",
                        color = SUCCESS_ACCENT,
                        style = MaterialTheme.typography.titleSmall,
                        textAlign = TextAlign.Center
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "正在进入拍照…",
                        color = Color.White.copy(alpha = 0.75f),
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                noResult -> {
                    Text(
                        "还没识别到条码",
                        color = Color(0xFFFFC46B),
                        style = MaterialTheme.typography.titleSmall,
                        textAlign = TextAlign.Center
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "把条码移到取景框中央，离远一点或换个角度再试；" +
                            "光线太暗可轻点画面对焦。仍不行就用手动输入。",
                        color = Color.White.copy(alpha = 0.75f),
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center
                    )
                }
                else -> {
                    Text(
                        "将条码或二维码对准取景框内",
                        color = Color.White,
                        style = MaterialTheme.typography.titleSmall,
                        textAlign = TextAlign.Center
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "轻点画面对焦",
                        color = Color.White.copy(alpha = 0.7f),
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        }

        // ---------- 底部操作 ----------
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            if (cameraError != null || noResult) {
                RetryButton(onClick = { vm.retry() })
                Spacer(Modifier.height(8.dp))
            }
            TextButton(onClick = { manualInput = true }) {
                Text("扫不出来？手动输入条码", color = Color.White)
            }
        }

        // ---------- 相机错误 ----------
        if (cameraError != null) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(top = 56.dp)
                    .fillMaxWidth()
            ) {
                ErrorBar(cameraError!!, onDismiss = { vm.clearCameraError() })
            }
        }
    }

    if (manualInput) {
        ManualBarcodeDialog(
            onDismiss = { manualInput = false },
            onConfirm = { value -> manualInput = false; onResult(value) }
        )
    }
}

@Composable
private fun RetryButton(onClick: () -> Unit) {
    Button(
        onClick = onClick,
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.White.copy(alpha = 0.18f),
            contentColor = Color.White
        ),
        shape = RoundedCornerShape(24.dp),
        modifier = Modifier.height(44.dp)
    ) { Text("重新识别") }
}

/**
 * 手动输入兜底。
 *
 * 这不是可选项：吊牌被洗褪色、条码被熨斗烫皱、二维码打印模糊，
 * 这些情况在洗衣门店是常态，扫码一定会有扫不出来的时候。
 * 没有手动入口，店员就只能放弃这一单。
 */
@Composable
private fun ManualBarcodeDialog(
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit
) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("手动输入条码") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text("衣物条码") },
                placeholder = { Text("照着吊牌上的编号填写") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
        },
        confirmButton = {
            TextButton(onClick = {
                val v = text.trim()
                if (v.isNotEmpty()) onConfirm(v)
            }) { Text("确定") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

private val SUCCESS_ACCENT = Color(0xFF3DDC84)
