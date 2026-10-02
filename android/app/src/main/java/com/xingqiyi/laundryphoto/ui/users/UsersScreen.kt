package com.xingqiyi.laundryphoto.ui.users

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.xingqiyi.laundryphoto.data.model.Role
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.ui.components.ConfirmDialog
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.EmptyState
import com.xingqiyi.laundryphoto.ui.components.ErrorBar
import com.xingqiyi.laundryphoto.ui.components.LoadingState
import com.xingqiyi.laundryphoto.ui.components.TagChip
import com.xingqiyi.laundryphoto.ui.components.XqyTopBar
import com.xingqiyi.laundryphoto.ui.theme.Brand500
import com.xingqiyi.laundryphoto.ui.theme.TagBlue
import com.xingqiyi.laundryphoto.util.DateTimeUtil

/**
 * 用户管理页。
 *
 * 与桌面端权限一致：本页只有系统管理员能进入（底部导航与首页入口均已裁剪）。
 * 列表行提供「改 / 删」两个操作；新建与编辑复用同一个对话框，
 * 编辑时密码留空表示「不改密码」，其余字段「留空/未选」表示「保持原值」。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsersScreen(
    vm: UsersViewModel,
    onBack: () -> Unit
) {
    val snackbar = remember { SnackbarHostState() }
    val users by vm.users.collectAsState()
    val loading by vm.loading.collectAsState()
    val error by vm.error.collectAsState()
    val busy by vm.busy.collectAsState()

    var showEditor by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<UserDto?>(null) }
    var pendingDelete by remember { mutableStateOf<UserDto?>(null) }

    LaunchedEffect(Unit) { vm.toast.collect { snackbar.showSnackbar(it) } }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            XqyTopBar(title = "用户管理", onBack = onBack)
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { editing = null; showEditor = true },
                containerColor = Brand500
            ) {
                Icon(Icons.Default.PersonAdd, contentDescription = "新建账号", tint = androidx.compose.ui.graphics.Color.White)
            }
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (error != null) ErrorBar(error!!, onDismiss = { vm.clearError() })
            when {
                loading && users.isEmpty() -> LoadingState()
                users.isEmpty() -> EmptyState(
                    text = "还没有其他账号",
                    hint = "点右下角按钮新建一个店员账号"
                )
                else -> LazyColumn(
                    contentPadding = PaddingValues(Dimens.ScreenPadding),
                    verticalArrangement = Arrangement.spacedBy(Dimens.CardGap)
                ) {
                    items(users, key = { it.id }) { user ->
                        UserRow(
                            user = user,
                            onEdit = { editing = user; showEditor = true },
                            onDelete = { pendingDelete = user }
                        )
                    }
                    item { Spacer(Modifier.height(72.dp)) }
                }
            }
        }
    }

    if (showEditor) {
        UserEditorDialog(
            initial = editing,
            busy = busy,
            onDismiss = { showEditor = false },
            onSave = { username, name, role, password, store, active ->
                if (editing == null) {
                    vm.create(username, name, role, password, store)
                } else {
                    vm.update(
                        id = editing!!.id,
                        name = name,
                        role = role,
                        active = active,
                        newPassword = password,
                        store = store
                    )
                }
                showEditor = false
            }
        )
    }

    if (pendingDelete != null) {
        ConfirmDialog(
            title = "删除账号？",
            message = "将删除「${pendingDelete!!.displayName}」(${pendingDelete!!.username})，该账号下的操作日志保留但账号不可再登录。",
            confirmText = "删除",
            danger = true,
            onConfirm = { vm.delete(pendingDelete!!.id); pendingDelete = null },
            onDismiss = { pendingDelete = null }
        )
    }
}

@Composable
private fun UserRow(
    user: UserDto,
    onEdit: () -> Unit,
    onDelete: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(user.displayName, style = MaterialTheme.typography.bodyLarge)
                    Spacer(Modifier.size(8.dp))
                    TagChip(user.roleEnum.label, TagBlue, Brand500)
                    if (!user.active) {
                        Spacer(Modifier.size(6.dp))
                        Text("已停用", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.height(2.dp))
                Text(
                    "${user.username}${if (user.store.isNotBlank()) " · ${user.store}" else ""}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (!user.lastLoginAt.isNullOrBlank()) {
                    Text(
                        "最近登录 ${DateTimeUtil.formatRelative(user.lastLoginAt)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            IconButton(onClick = onEdit) { Icon(Icons.Default.Edit, contentDescription = "编辑", tint = Brand500) }
            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, contentDescription = "删除", tint = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun UserEditorDialog(
    initial: UserDto?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (username: String, name: String, role: Role, password: String, store: String, active: Boolean) -> Unit
) {
    var username by remember { mutableStateOf(initial?.username ?: "") }
    var name by remember { mutableStateOf(initial?.name ?: "") }
    var role by remember { mutableStateOf(initial?.roleEnum ?: Role.CAPTURE) }
    var password by remember { mutableStateOf("") }
    var store by remember { mutableStateOf(initial?.store ?: "") }
    var active by remember { mutableStateOf(initial?.active ?: true) }

    var roleExpanded by remember { mutableStateOf(false) }

    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "新建账号" else "编辑账号") },
        text = {
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it },
                    label = { Text("账号（登录名）") },
                    singleLine = true,
                    enabled = initial == null,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("姓名（可选）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                ExposedDropdownMenuBox(
                    expanded = roleExpanded,
                    onExpandedChange = { roleExpanded = it }
                ) {
                    OutlinedTextField(
                        value = role.label,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("角色") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = roleExpanded) },
                        modifier = Modifier.menuAnchor().fillMaxWidth()
                    )
                    ExposedDropdownMenu(
                        expanded = roleExpanded,
                        onDismissRequest = { roleExpanded = false }
                    ) {
                        Role.entries.forEach { r ->
                            DropdownMenuItem(
                                text = { Text(r.label) },
                                onClick = { role = r; roleExpanded = false }
                            )
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text(if (initial == null) "密码" else "密码（留空=不改）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = store,
                    onValueChange = { store = it },
                    label = { Text("门店（门店管理员必填）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                if (initial != null) {
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("账号启用", style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.weight(1f))
                        Switch(checked = active, onCheckedChange = { active = it })
                    }
                }
                if (initial == null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "新账号默认具有所分配角色对应的权限，创建后请告知对方连接码与密码。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    if (initial == null && (username.isBlank() || password.isBlank())) return@TextButton
                    onSave(username, name, role, password, store, active)
                }
            ) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}
