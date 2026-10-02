package com.xingqiyi.laundryphoto.ui.login

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.PrimaryButton
import com.xingqiyi.laundryphoto.ui.components.SecondaryButton
import com.xingqiyi.laundryphoto.ui.theme.Brand500

/**
 * 登录页。
 *
 * 触控优先的几个具体取舍：
 * - 单列纵向布局 + 可滚动，避免在小屏上被输入法顶掉输入框（imePadding + adjustResize 配合）；
 * - 所有输入区高度足够，按钮统一 48dp；
 * - 服务器配置默认展开：首次使用必然要填，藏起来只会让人找不到。
 */
@Composable
fun LoginScreen(
    vm: LoginViewModel,
    versionName: String,
    onLoggedIn: (com.xingqiyi.laundryphoto.data.model.UserDto) -> Unit
) {
    val snackbar = remember { SnackbarHostState() }
    val busy by vm.busy.collectAsState()

    LaunchedEffect(Unit) {
        vm.toast.collect { snackbar.showSnackbar(it) }
    }
    LaunchedEffect(Unit) {
        vm.testResult.collect { snackbar.showSnackbar(it) }
    }
    LaunchedEffect(Unit) {
        // 把登录成功的用户回传给 MainActivity：底部导航与首页都要按角色裁剪，
        // 必须在导航层就知道当前是谁。
        vm.loggedIn.collect { onLoggedIn(it) }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .statusBarsPadding()
                .navigationBarsPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Dimens.ScreenPadding, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // ---------- 品牌区 ----------
            Surface(
                shape = MaterialTheme.shapes.large,
                color = Brand500,
                modifier = Modifier.size(64.dp)
            ) {
                Column(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text("星期衣", color = androidx.compose.ui.graphics.Color.White, style = MaterialTheme.typography.titleMedium)
                }
            }
            Spacer(Modifier.height(12.dp))
            Text("星期衣精致洗衣 · 衣物照片系统", style = MaterialTheme.typography.titleMedium)
            Text(
                "移动端 v$versionName",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(24.dp))

            // ---------- 服务器配置 ----------
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
            ) {
                Column(Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("服务器连接", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                        TextButton(onClick = { vm.serverExpanded.value = !vm.serverExpanded.value }) {
                            Text(if (vm.serverExpanded.value) "收起" else "展开")
                            Icon(
                                if (vm.serverExpanded.value) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp)
                            )
                        }
                    }
                    AnimatedVisibility(visible = vm.serverExpanded.value) {
                        Column {
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = vm.serverUrl.value,
                                onValueChange = { vm.serverUrl.value = it },
                                label = { Text("服务器地址") },
                                placeholder = { Text("http://192.168.1.10:17521") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                                keyboardOptions = KeyboardOptions(
                                    keyboardType = KeyboardType.Uri,
                                    imeAction = ImeAction.Next
                                )
                            )
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = vm.apiToken.value,
                                onValueChange = { vm.apiToken.value = it },
                                label = { Text("连接码") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next)
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "地址与连接码在服务端电脑的「系统设置」中查看。同一局域网（或通过组网工具）才能连通。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(Modifier.height(8.dp))
                            SecondaryButton(
                                text = "测试连接",
                                onClick = { vm.testConnection() },
                                enabled = !busy,
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(Dimens.CardGap))

            // ---------- 账号 ----------
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
            ) {
                Column(Modifier.padding(16.dp)) {
                    Text("账号登录", style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = vm.username.value,
                        onValueChange = { vm.username.value = it },
                        label = { Text("账号") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next)
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = vm.password.value,
                        onValueChange = { vm.password.value = it },
                        label = { Text("密码") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        visualTransformation = if (vm.passwordVisible.value) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = {
                            IconButton(onClick = { vm.passwordVisible.value = !vm.passwordVisible.value }) {
                                Icon(
                                    if (vm.passwordVisible.value) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                    contentDescription = if (vm.passwordVisible.value) "隐藏密码" else "显示密码"
                                )
                            }
                        },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Done
                        )
                    )
                    Spacer(Modifier.height(4.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = vm.remember.value,
                            onCheckedChange = { vm.remember.value = it }
                        )
                        Text("记住密码（加密保存在本机）", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            Spacer(Modifier.height(20.dp))

            PrimaryButton(
                text = if (busy) "登录中…" else "登录",
                onClick = { vm.login() },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(Modifier.height(16.dp))
            Text(
                "一个账号同时只能在一台设备登录；在其他设备登录会把本机挤下线。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}
