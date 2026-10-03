package com.xingqiyi.laundryphoto.ui.camera

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.PrimaryButton
import com.xingqiyi.laundryphoto.ui.components.SecondaryButton
import com.xingqiyi.laundryphoto.ui.theme.Brand500

/**
 * 相机权限状态：**三段式**（未授予 → 被拒可再申请 → 被永久拒绝）。
 *
 * 只写「申请一次，失败就显示没权限」是最常见的糟糕体验：
 * 用户点了「不再询问」后就再也进不去，界面还不停地弹没用的申请框。
 * 因此这里显式区分第二阶段和第三阶段，第三阶段必须给出去系统设置的入口。
 *
 * 另一个容易漏的点：**从系统设置页返回后要重新检查**。
 * 用户按引导去设置里开了权限，回到 App 时进程通常还在、
 * 权限状态还是旧的 false，不重新检查的话他会以为「开了也没用」。
 */
@Composable
fun rememberCameraPermissionState(): CameraPermissionState {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val activity = remember(context) { context.findActivity() }
    var granted by remember {
        mutableStateOf(isCameraGranted(context))
    }
    // 是否至少申请过一次：用于区分「还没问过」和「问过且被永久拒绝」
    var requested by remember { mutableStateOf(false) }

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { result ->
        requested = true
        granted = result
    }

    val state = remember(context, activity, granted, requested, launcher) {
        CameraPermissionState(
            context = context,
            activity = activity,
            granted = granted,
            requested = requested,
            launcher = launcher
        )
    }

    // 从系统设置页返回、或切后台再回来时刷新一次真实授权状态
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                val now = isCameraGranted(context)
                if (now != granted) granted = now
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    return state
}

class CameraPermissionState internal constructor(
    private val context: Context,
    private val activity: Activity?,
    granted: Boolean,
    requested: Boolean,
    private val launcher: ActivityResultLauncher<String>
) {
    var granted: Boolean = granted
        private set

    var requested: Boolean = requested
        private set

    /**
     * 已被「不再询问」永久拒绝：系统不会再弹申请框，只能引导去设置页。
     *
     * 判定口径：`shouldShowRequestPermissionRationale` 在「从未申请」和
     * 「已永久拒绝」时都返回 false，所以必须先确认至少申请过一次。
     */
    val permanentlyDenied: Boolean
        get() {
            if (granted || !requested) return false
            val a = activity ?: return false
            return !a.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
        }

    fun request() {
        launcher.launch(Manifest.permission.CAMERA)
    }

    fun refresh() {
        granted = isCameraGranted(context)
    }

    /** 跳到本应用的系统设置页（权限开关在那里） */
    fun openAppSettings() {
        runCatching {
            val intent = Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", context.packageName, null)
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }
}

private fun isCameraGranted(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED

/** 从 Compose 的 Context 一路往上找 Activity（shouldShowRequestPermissionRationale 需要它） */
private fun Context.findActivity(): Activity? {
    var ctx: Context? = this
    while (ctx is ContextWrapper) {
        if (ctx is Activity) return ctx
        ctx = ctx.baseContext
    }
    return null
}

/**
 * 无权限时的兜底界面。
 *
 * 文案刻意写清「点了不再询问之后要去哪里改」，
 * 而不是只说「需要相机权限」——后者等于把用户丢在死胡同里。
 */
@Composable
fun CameraPermissionGate(
    state: CameraPermissionState,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    title: String = "需要相机权限",
    usage: String = "扫码与拍照都需要相机权限。拒绝后仍可查询订单，但无法录入衣物照片。"
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(Dimens.ScreenPadding),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            Icons.Default.CameraAlt,
            contentDescription = null,
            modifier = Modifier.size(56.dp),
            tint = Brand500
        )
        Spacer(Modifier.height(12.dp))
        Text(title, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(6.dp))
        Text(
            if (state.permanentlyDenied) {
                "相机权限已被永久拒绝，系统不会再弹出申请框。请到「系统设置 → 应用 → " +
                    "星期衣衣物照片 → 权限」中手动开启相机。"
            } else {
                usage
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(16.dp))
        if (state.permanentlyDenied) {
            PrimaryButton("去系统设置开启", onClick = { state.openAppSettings() })
            Spacer(Modifier.height(8.dp))
            SecondaryButton("我已开启，重新检查", onClick = { state.refresh() })
        } else {
            PrimaryButton("授予相机权限", onClick = { state.request() })
        }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = onBack) { Text("返回") }
    }
}
