package com.xingqiyi.laundryphoto.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.xingqiyi.laundryphoto.ui.components.ConfirmDialog
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.InfoRow
import com.xingqiyi.laundryphoto.ui.components.PrimaryButton
import com.xingqiyi.laundryphoto.ui.theme.Danger
import com.xingqiyi.laundryphoto.ui.theme.ThemeMode

/**
 * 设置页。
 *
 * 刻意做成「只读展示服务端连接 + 本地体验开关 + 账号操作」三段：
 * 移动端不该承担服务端本机设置（那些改的是服务器那台机器的磁盘/端口，手机上改既无意义又危险）。
 */
@Composable
fun SettingsScreen(
    vm: SettingsViewModel,
    onBack: () -> Unit,
    onLogout: () -> Unit
) {
    val snackbar = remember { SnackbarHostState() }
    val themeMode by vm.themeMode.collectAsState()
    val thumbWidth by vm.thumbWidth.collectAsState()
    val photoQuality by vm.photoQuality.collectAsState()
    val pendingCount by vm.pendingCount.collectAsState()
    val serverUrl by vm.serverUrl.collectAsState()
    val apiToken by vm.apiToken.collectAsState()
    val busy by vm.busy.collectAsState()

    var showPwd by remember { mutableStateOf(false) }
    var showLogout by remember { mutableStateOf(false) }
    var showClear by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.toast.collect { snackbar.showSnackbar(it) } }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { com.xingqiyi.laundryphoto.ui.components.XqyTopBar(title = "设置", onBack = onBack) },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(Dimens.ScreenPadding),
            verticalArrangement = Arrangement.spacedBy(Dimens.CardGap)
        ) {
            // ---------- 主题 ----------
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(12.dp)) {
                    Text("深色模式", style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(4.dp))
                    Column(Modifier.selectableGroup()) {
                        listOf(
                            ThemeMode.SYSTEM to "跟随系统",
                            ThemeMode.LIGHT to "浅色",
                            ThemeMode.DARK to "深色"
                        ).forEach { (mode, label) ->
                            Row(
                                Modifier.fillMaxWidth().height(48.dp).selectable(
                                    selected = themeMode == mode,
                                    onClick = { vm.setTheme(mode) },
                                    role = androidx.compose.ui.semantics.Role.RadioButton
                                ),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                RadioButton(selected = themeMode == mode, onClick = { vm.setTheme(mode) })
                                Spacer(Modifier.padding(start = 8.dp))
                                Text(label, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }

            // ---------- 省流量 / 画质 ----------
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("缩略图宽度", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.weight(1f))
                        Text("${thumbWidth}px", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                    }
                    SliderRow(value = thumbWidth.toFloat(), min = 120f, max = 720f, steps = 11, onValueChange = { vm.setThumbWidth(it.toInt()) })
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("上传画质", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.weight(1f))
                        Text("$photoQuality%", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                    }
                    SliderRow(value = photoQuality.toFloat(), min = 30f, max = 100f, steps = 14, onValueChange = { vm.setPhotoQuality(it.toInt()) })
                    Text(
                        "弱网环境可同时调小两项以加快加载与上传。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // ---------- 连接信息（只读） ----------
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(12.dp)) {
                    Text("服务器连接", style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(4.dp))
                    InfoRow("服务器地址", serverUrl.ifBlank { "（未配置）" })
                    InfoRow("连接码", if (apiToken.isNotBlank()) "••••••" else "（未配置）")
                }
            }

            // ---------- 离线队列管理 ----------
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(12.dp)) {
                    Text("离线照片队列", style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(4.dp))
                    InfoRow("待补传", if (pendingCount > 0) "$pendingCount 张" else "无")
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = { vm.retryFailed() },
                            enabled = pendingCount > 0,
                            modifier = Modifier.weight(1f)
                        ) { Text("重试失败项") }
                        OutlinedButton(
                            onClick = { showClear = true },
                            enabled = pendingCount > 0,
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = Danger)
                        ) { Text("放弃未同步") }
                    }
                }
            }

            // ---------- 账号 ----------
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(12.dp)) {
                    Text("账号", style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(4.dp))
                    PrimaryButton("修改密码", onClick = { showPwd = true }, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = { showLogout = true },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Danger)
                    ) {
                        Icon(Icons.Default.Logout, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("退出登录")
                    }
                }
            }

            // ---------- 关于 ----------
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(12.dp)) {
                    InfoRow("应用版本", "v${vm.versionName}")
                    InfoRow("服务端类型", "桌面端 HTTP 服务（局域网）")
                }
            }

            Spacer(Modifier.height(16.dp))
        }
    }

    if (showPwd) {
        ChangePasswordDialog(
            busy = busy,
            onDismiss = { showPwd = false },
            onConfirm = { oldP, newP -> vm.changePassword(oldP, newP); showPwd = false }
        )
    }
    if (showLogout) {
        ConfirmDialog(
            title = "退出登录？",
            message = "退出后需重新输入密码登录；本机离线照片会继续保留并在联网后补传。",
            confirmText = "退出",
            danger = true,
            onConfirm = { showLogout = false; onLogout() },
            onDismiss = { showLogout = false }
        )
    }
    if (showClear) {
        ConfirmDialog(
            title = "放弃未同步照片？",
            message = "队列中的 $pendingCount 张离线照片将被永久删除且不会上传到服务器，操作不可恢复。",
            confirmText = "放弃",
            danger = true,
            onConfirm = { showClear = false; vm.clearOffline() },
            onDismiss = { showClear = false }
        )
    }
}

@Composable
private fun SliderRow(
    value: Float,
    min: Float,
    max: Float,
    steps: Int,
    onValueChange: (Float) -> Unit
) {
    androidx.compose.material3.Slider(
        value = value,
        onValueChange = onValueChange,
        valueRange = min..max,
        steps = steps,
        modifier = Modifier.fillMaxWidth()
    )
}

@Composable
private fun ChangePasswordDialog(
    busy: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (oldP: String, newP: String) -> Unit
) {
    var oldP by remember { mutableStateOf("") }
    var newP by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("修改密码") },
        text = {
            Column(Modifier.fillMaxWidth()) {
                OutlinedTextField(value = oldP, onValueChange = { oldP = it }, label = { Text("原密码") }, singleLine = true, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = newP, onValueChange = { newP = it }, label = { Text("新密码") }, singleLine = true, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = confirm, onValueChange = { confirm = it }, label = { Text("确认新密码") }, singleLine = true, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation())
                if (newP.isNotBlank() && confirm.isNotBlank() && newP != confirm) {
                    Spacer(Modifier.height(4.dp))
                    Text("两次输入的新密码不一致", style = MaterialTheme.typography.bodySmall, color = Danger)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && oldP.isNotBlank() && newP.isNotBlank() && newP == confirm,
                onClick = { onConfirm(oldP, newP) }
            ) { Text("确定") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}
