package com.xingqiyi.laundryphoto.ui.burst

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageCapture
import androidx.camera.core.Preview
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xingqiyi.laundryphoto.camera.BindCameraToLifecycle
import com.xingqiyi.laundryphoto.camera.CameraSession
import com.xingqiyi.laundryphoto.camera.attachTapToFocus
import com.xingqiyi.laundryphoto.camera.fourByThreeSelector
import com.xingqiyi.laundryphoto.camera.rememberCameraPreviewView
import com.xingqiyi.laundryphoto.ui.camera.CameraPermissionGate
import com.xingqiyi.laundryphoto.ui.camera.rememberCameraPermissionState
import com.xingqiyi.laundryphoto.ui.capture.takePhoto
import com.xingqiyi.laundryphoto.ui.theme.Brand500
import java.io.File

/**
 * 扫码之后的**全屏连拍**页。
 *
 * 设计原则只有一条：**画面上除照片本身外，什么都不该抢注意力**。
 * 店员要在半米距离内看清衣物细节来决定按下快门，
 * 因此顶部只留一条半透明的返回 + 条码 + 张数，底部只留快门、张数与完成，
 * 其余（备注、条码编辑、预览缩略图）一概不出现——那些在扫码页已经做过了。
 */
@Composable
fun BurstCaptureScreen(
    vm: BurstCaptureViewModel,
    onBack: () -> Unit,
    onFinish: (Int) -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val permission = rememberCameraPermissionState()

    val shotCount by vm.shotCount.collectAsState()
    val busy by vm.busy.collectAsState()
    val saveError by vm.saveError.collectAsState()
    val galleryHint by vm.galleryHint.collectAsState()
    val writeGallery by vm.writeGallery.collectAsState()

    var confirmLeave by remember { mutableStateOf(false) }

    // 完成（入队补传）后回到首页
    LaunchedEffect(Unit) {
        vm.finished.collect { onFinish(it) }
    }

    if (!permission.granted) {
        Surface(color = MaterialTheme.colorScheme.background) {
            CameraPermissionGate(
                state = permission,
                onBack = onBack,
                title = "需要相机权限才能拍照",
                usage = "连拍存档需要相机权限。拒绝后仍可查询订单，但无法录入衣物照片。"
            )
        }
        return
    }

    // ---------- 相机 ----------
    val previewView = rememberCameraPreviewView()
    val session = remember { CameraSession() }
    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }

    val preview = remember {
        Preview.Builder().setResolutionSelector(fourByThreeSelector()).build()
    }
    // 与预览同为 4:3：三个用例比例一致时 CameraX 才不会在内部做二次裁剪，
    // 也就不会出现「预览里看到的」和「拍出来的」构图不一样
    val capture = remember {
        ImageCapture.Builder()
            .setResolutionSelector(fourByThreeSelector())
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .build()
    }

    BindCameraToLifecycle(
        session = session,
        bind = {
            preview.setSurfaceProvider(previewView.surfaceProvider)
            session.bind(
                context = context,
                owner = lifecycleOwner,
                useCases = listOf(preview, capture),
                onReady = {
                    imageCapture = capture
                    attachTapToFocus(previewView, it)
                },
                onError = { }
            )
        },
        release = { session.release() }
    )

    // Android 9 及以下写相册需要存储权限，按需申请，不在进页面时就要
    val storageLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        vm.setWriteGallery(granted)
        if (!granted) vm.clearGalleryHint()
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {

        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())

        // ---------- 顶部：返回 + 条码 + 已拍张数 ----------
        Row(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .statusBarsPadding()
                .background(Color.Black.copy(alpha = 0.35f))
                .padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = {
                if (shotCount > 0) confirmLeave = true else onBack()
            }) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = Color.White)
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    vm.barcode,
                    color = Color.White,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    "已拍 $shotCount 张",
                    color = Color.White.copy(alpha = 0.75f),
                    style = MaterialTheme.typography.labelSmall
                )
            }
        }

        // ---------- 保存失败：可重试 ----------
        if (saveError != null) {
            Surface(
                color = MaterialTheme.colorScheme.errorContainer,
                contentColor = MaterialTheme.colorScheme.onErrorContainer,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(top = 68.dp, start = 16.dp, end = 16.dp)
                    .fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(saveError!!, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { vm.retrySave() }, enabled = !busy) { Text("重试") }
                    TextButton(onClick = { vm.clearSaveError() }) { Text("关闭") }
                }
            }
        } else if (galleryHint != null) {
            Surface(
                color = Color(0xFF7A5B00),
                contentColor = Color.White,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(top = 68.dp, start = 16.dp, end = 16.dp)
                    .fillMaxWidth()
            ) {
                Text(
                    galleryHint!!,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }

        // ---------- 底部：相册开关 + 快门 + 完成 + 存储路径 ----------
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(20.dp))
                    .padding(horizontal = 12.dp, vertical = 2.dp)
            ) {
                Text("同时存入系统相册", color = Color.White, fontSize = 12.sp)
                Spacer(Modifier.width(6.dp))
                Switch(
                    checked = writeGallery,
                    onCheckedChange = { want ->
                        if (!want) {
                            vm.setWriteGallery(false)
                            return@Switch
                        }
                        // Android 9 及以下写公共相册要 WRITE_EXTERNAL_STORAGE（Manifest 已限制 maxSdk 28）
                        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
                            ContextCompat.checkSelfPermission(
                                context, Manifest.permission.WRITE_EXTERNAL_STORAGE
                            ) != PackageManager.PERMISSION_GRANTED
                        ) {
                            storageLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        } else {
                            vm.setWriteGallery(true)
                        }
                    }
                )
            }

            Spacer(Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // 左侧占位，保证快门始终在正中（返回在顶部，不占这里）
                Spacer(Modifier.size(56.dp))

                // ---------- 快门 ----------
                Surface(
                    onClick = {
                        val ic = imageCapture
                        if (ic == null || busy) return@Surface
                        val tmp = File(context.cacheDir, "burst_${System.currentTimeMillis()}.jpg")
                        takePhoto(
                            context = context,
                            imageCapture = ic,
                            outputFile = tmp,
                            onSaved = { vm.onPhotoCaptured(it) },
                            onError = { vm.onCaptureError(it) }
                        )
                    },
                    enabled = !busy,
                    shape = CircleShape,
                    color = if (busy) Color.White.copy(alpha = 0.3f) else Brand500,
                    modifier = Modifier.size(76.dp)
                ) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Icon(
                            Icons.Default.CameraAlt,
                            contentDescription = "拍照",
                            tint = Color.White,
                            modifier = Modifier.size(34.dp)
                        )
                    }
                }

                // ---------- 完成 ----------
                if (shotCount > 0) {
                    TextButton(
                        onClick = { if (!busy) vm.finish() },
                        enabled = !busy,
                        modifier = Modifier.size(width = 56.dp, height = 56.dp)
                    ) {
                        Text("完成", color = Color.White, fontSize = 13.sp)
                    }
                } else {
                    Spacer(Modifier.size(56.dp))
                }
            }

            Spacer(Modifier.height(6.dp))

            // 明确存储路径：售后排查时店员能直接报出来
            Text(
                "存入 ${vm.saveDir}",
                color = Color.White.copy(alpha = 0.5f),
                fontSize = 10.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }

    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("结束拍摄？") },
            text = { Text("已拍 $shotCount 张。上传并退出会把它们传到服务端；继续拍摄则先留在手机上。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLeave = false
                    vm.finish()
                }) { Text("上传并退出") }
            },
            dismissButton = {
                TextButton(onClick = { confirmLeave = false }) { Text("继续拍摄") }
            }
        )
    }
}
