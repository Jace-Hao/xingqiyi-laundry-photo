package com.xingqiyi.laundryphoto.ui.capture

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageCapture
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import coil.compose.AsyncImage
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.ErrorBar
import com.xingqiyi.laundryphoto.ui.components.PrimaryButton
import com.xingqiyi.laundryphoto.ui.components.SecondaryButton
import com.xingqiyi.laundryphoto.ui.theme.Brand500
import com.xingqiyi.laundryphoto.ui.theme.TagOrangeBg
import com.xingqiyi.laundryphoto.ui.theme.Warning
import java.io.File

/**
 * 拍照录入页。
 *
 * 权限处理的三段式（申请 → 被拒 → 被永久拒绝）在这里显式区分：
 * 只写「申请一次，失败就显示没权限」是最常见的糟糕体验——
 * 用户点了「不再询问」后就再也进不去，也不知道要去设置里改。
 */
@Composable
fun CaptureScreen(
    vm: CaptureViewModel,
    onBack: () -> Unit,
    onSaved: () -> Unit
) {
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    val error by vm.error.collectAsState()
    val busy by vm.busy.collectAsState()
    val cameraError by vm.cameraError.collectAsState()

    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    // 用户勾选「不再询问」后，系统不会再弹框，此时必须引导去设置页
    var permanentlyDenied by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasCameraPermission = granted
        if (!granted) permanentlyDenied = true
    }

    LaunchedEffect(Unit) {
        vm.toast.collect { snackbar.showSnackbar(it) }
    }
    LaunchedEffect(Unit) {
        // 保存成功（在线或离线入队）后回到首页：首页会展示待同步角标
        vm.saved.collect { onSaved() }
    }
    LaunchedEffect(Unit) {
        vm.cameraError.collect { }
    }
    DisposableEffect(Unit) { onDispose { vm.retake() } }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        if (!hasCameraPermission) {
            PermissionGate(
                permanentlyDenied = permanentlyDenied,
                onRequest = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                onBack = onBack,
                modifier = Modifier.padding(padding)
            )
            return@Scaffold
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .navigationBarsPadding()
                .imePadding()
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("衣物拍照", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).padding(start = 8.dp))
                IconButton(onClick = onBack) {
                    Icon(Icons.Default.Close, contentDescription = "关闭")
                }
            }
            if (error != null) {
                ErrorBar(error!!, onDismiss = { vm.clearError() })
            }
            if (cameraError != null) {
                ErrorBar(cameraError!!, onDismiss = { vm.clearCameraError() })
            }

            if (vm.previewPath.value == null) {
                CameraStep(vm = vm, busy = busy)
            } else {
                ConfirmStep(vm = vm, busy = busy)
            }
        }
    }
}

@Composable
private fun PermissionGate(
    permanentlyDenied: Boolean,
    onRequest: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Default.CameraAlt, contentDescription = null, modifier = Modifier.size(56.dp), tint = Brand500)
            Spacer(Modifier.height(12.dp))
            Text("需要相机权限", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(6.dp))
            Text(
                if (permanentlyDenied) {
                    "相机权限已被永久拒绝。请到「系统设置 → 应用 → 星期衣衣物照片 → 权限」中开启相机。"
                } else {
                    "拍照录入需要相机权限。拒绝后仍可查询订单，但无法拍摄存档照片。"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(16.dp))
            if (!permanentlyDenied) {
                PrimaryButton("授予相机权限", onClick = onRequest)
            }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onBack) { Text("返回") }
        }
    }
}

/** 取景步骤：条码 + 备注 + 取景器 + 快门 */
@Composable
private fun CameraStep(vm: CaptureViewModel, busy: Boolean) {
    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }
    val context = LocalContext.current
    val warning = vm.warning.value

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Dimens.ScreenPadding)
    ) {
        OutlinedTextField(
            value = vm.barcode.value,
            onValueChange = vm::onBarcodeChange,
            label = { Text("衣物条形码") },
            placeholder = { Text("扫码枪输入或手动填写") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Next)
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = vm.note.value,
            onValueChange = { vm.note.value = it },
            label = { Text("备注（可选）") },
            placeholder = { Text("如：羽绒服 · 袖口污渍") },
            maxLines = 2,
            modifier = Modifier.fillMaxWidth()
        )

        // ---------- 条码预警 ----------
        if (warning != null && (warning.suspicious || warning.similar.isNotEmpty() || warning.suggestion != null)) {
            Spacer(Modifier.height(8.dp))
            Surface(
                color = TagOrangeBg,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(12.dp)) {
                    if (warning.suspicious) {
                        Text(
                            "条码含可疑字符，请确认是否扫码误读",
                            style = MaterialTheme.typography.bodySmall,
                            color = Warning
                        )
                    }
                    if (warning.similar.isNotEmpty()) {
                        Text(
                            "库中有相似条码：${warning.similar.joinToString("、")}",
                            style = MaterialTheme.typography.bodySmall,
                            color = Warning
                        )
                        Text(
                            "确认是新衣物再保存，避免同一件衣物被拆成两个档案",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    if (warning.suggestion != null) {
                        Spacer(Modifier.height(4.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "建议改为 ${warning.suggestion}",
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(1f)
                            )
                            TextButton(onClick = { vm.applySuggestion(warning.suggestion) }) {
                                Text("采用")
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))

        // ---------- 取景器 ----------
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(3f / 4f),
            shape = RoundedCornerShape(12.dp)
        ) {
            Box(Modifier.fillMaxSize()) {
                CameraPreview(
                    modifier = Modifier.fillMaxSize(),
                    onReady = { imageCapture = it },
                    onError = { vm.onCameraError(it) }
                )
                Text(
                    "轻点画面可对焦",
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(8.dp)
                        .background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(4.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                    color = Color.White,
                    style = MaterialTheme.typography.labelSmall
                )
            }
        }

        Spacer(Modifier.height(16.dp))

        // ---------- 快门 ----------
        Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Surface(
                onClick = {
                    val capture = imageCapture
                    if (capture == null) {
                        vm.onCameraError("相机尚未就绪，请稍候")
                    } else {
                        val tmp = File(context.cacheDir, "raw_${System.currentTimeMillis()}.jpg")
                        takePhoto(
                            context = context,
                            imageCapture = capture,
                            outputFile = tmp,
                            onSaved = { vm.processPhoto(it) },
                            onError = { vm.onCameraError(it) }
                        )
                    }
                },
                enabled = !busy,
                shape = CircleShape,
                color = if (busy) MaterialTheme.colorScheme.surfaceVariant else Brand500,
                modifier = Modifier.size(72.dp)
            ) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.CameraAlt, contentDescription = "拍照", tint = Color.White, modifier = Modifier.size(32.dp))
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** 确认步骤：展示处理后的照片（含水印），确认后上传或入队 */
@Composable
private fun ConfirmStep(vm: CaptureViewModel, busy: Boolean) {
    val path = vm.previewPath.value ?: return
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Dimens.ScreenPadding)
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            AsyncImage(
                model = File(path),
                contentDescription = "待保存的照片",
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(3f / 4f)
            )
        }
        Spacer(Modifier.height(12.dp))
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(Modifier.padding(12.dp)) {
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text("条码", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(vm.barcode.value, style = MaterialTheme.typography.bodyMedium)
                }
                if (vm.note.value.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                        Text("备注", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(vm.note.value, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(Dimens.CardGap)) {
            SecondaryButton("重拍", onClick = { vm.retake() }, enabled = !busy, modifier = Modifier.weight(1f))
            PrimaryButton(if (busy) "保存中…" else "保存", onClick = { vm.confirm() }, enabled = !busy, modifier = Modifier.weight(1f))
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "保存前请确认水印时间正确。服务器不可达时照片会先存本机并自动补传。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(24.dp))
    }
}
