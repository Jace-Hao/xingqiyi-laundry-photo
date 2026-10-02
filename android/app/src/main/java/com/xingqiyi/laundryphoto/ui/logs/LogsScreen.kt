package com.xingqiyi.laundryphoto.ui.logs

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import com.xingqiyi.laundryphoto.data.model.LogEntryDto
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.EmptyState
import com.xingqiyi.laundryphoto.ui.components.ErrorBar
import com.xingqiyi.laundryphoto.ui.components.ListFooter
import com.xingqiyi.laundryphoto.ui.components.LoadingState
import com.xingqiyi.laundryphoto.ui.components.XqyTopBar
import com.xingqiyi.laundryphoto.ui.theme.Success
import com.xingqiyi.laundryphoto.util.DateTimeUtil
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.rememberDatePickerState

/**
 * 操作日志页。
 *
 * 顶部把过滤条件（账号/操作/时间）收进一个可展开的筛选区：
 * 日志是低频查阅场景，默认收起保持列表清爽；高频的只有关键词搜索，因此关键词框常驻。
 * 时间用日期选择器而不是手输（更易错），但同时允许手填 YYYY-MM-DD 兜底。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LogsScreen(
    vm: LogsViewModel,
    onBack: () -> Unit
) {
    val snackbar = remember { SnackbarHostState() }
    val items by vm.items.collectAsState()
    val total by vm.total.collectAsState()
    val loading by vm.loading.collectAsState()
    val loadingMore by vm.loadingMore.collectAsState()
    val error by vm.error.collectAsState()
    val filterVisible by vm.filterVisible

    LaunchedEffect(Unit) { vm.toast.collect { snackbar.showSnackbar(it) } }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text("操作日志") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            androidx.compose.material.icons.Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回"
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { vm.filterVisible.value = !filterVisible }) {
                        Icon(Icons.Default.FilterList, contentDescription = "筛选")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface)
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (error != null) ErrorBar(error!!, onDismiss = { vm.clearError() })

            OutlinedTextField(
                value = vm.keyword.value,
                onValueChange = { vm.keyword.value = it; vm.refresh() },
                placeholder = { Text("搜索账号 / 操作 / 详情") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Dimens.ScreenPadding, vertical = 8.dp),
                leadingIcon = { Icon(Icons.Default.FilterList, contentDescription = null) },
                keyboardOptions = KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search)
            )

            if (filterVisible) {
                FilterPanel(vm = vm)
            }

            if (loading && items.isEmpty()) {
                LoadingState()
            } else if (items.isEmpty()) {
                EmptyState(text = "没有符合条件的操作记录")
            } else {
                Text(
                    "共 $total 条",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Dimens.ScreenPadding, vertical = 6.dp)
                )
                LazyColumn(
                    contentPadding = PaddingValues(start = Dimens.ScreenPadding, end = Dimens.ScreenPadding, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(items, key = { it.id }) { entry ->
                        LogRow(entry = entry)
                    }
                    item {
                        ListFooter(loading = loadingMore, hasMore = vm.hasMore, onLoadMore = { vm.loadMore() })
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilterPanel(vm: LogsViewModel) {
    Surface(
        tonalElevation = 2.dp,
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(Dimens.ScreenPadding)) {
            // 操作类型
            var actionExpanded by remember { mutableStateOf(false) }
            ExposedDropdownMenuBox(
                expanded = actionExpanded,
                onExpandedChange = { actionExpanded = it }
            ) {
                OutlinedTextField(
                    value = vm.action.value.ifBlank { "全部操作" },
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("操作类型") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = actionExpanded) },
                    modifier = Modifier.menuAnchor().fillMaxWidth()
                )
                ExposedDropdownMenu(expanded = actionExpanded, onDismissRequest = { actionExpanded = false }) {
                    DropdownMenuItem(text = { Text("全部操作") }, onClick = {
                        vm.action.value = ""; actionExpanded = false; vm.refresh()
                    })
                    vm.actionOptions.value.forEach { opt ->
                        DropdownMenuItem(text = { Text(opt) }, onClick = {
                            vm.action.value = opt; actionExpanded = false; vm.refresh()
                        })
                    }
                }
            }
            Spacer(Modifier.height(8.dp))

            // 账号
            var userExpanded by remember { mutableStateOf(false) }
            ExposedDropdownMenuBox(
                expanded = userExpanded,
                onExpandedChange = { userExpanded = it }
            ) {
                OutlinedTextField(
                    value = vm.filterUsers.value.firstOrNull { it.id == vm.userId.value }?.displayName
                        ?: if (vm.userId.value.isBlank()) "全部账号" else vm.userId.value,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("账号") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = userExpanded) },
                    modifier = Modifier.menuAnchor().fillMaxWidth()
                )
                ExposedDropdownMenu(expanded = userExpanded, onDismissRequest = { userExpanded = false }) {
                    DropdownMenuItem(text = { Text("全部账号") }, onClick = {
                        vm.userId.value = ""; userExpanded = false; vm.refresh()
                    })
                    vm.filterUsers.value.forEach { u ->
                        DropdownMenuItem(text = { Text(u.displayName) }, onClick = {
                            vm.userId.value = u.id; userExpanded = false; vm.refresh()
                        })
                    }
                }
            }
            Spacer(Modifier.height(8.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DateField(
                    label = "起始日期",
                    value = vm.dateFrom.value,
                    onValueChange = { vm.dateFrom.value = it },
                    modifier = Modifier.weight(1f)
                )
                DateField(
                    label = "结束日期",
                    value = vm.dateTo.value,
                    onValueChange = { vm.dateTo.value = it },
                    modifier = Modifier.weight(1f)
                )
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { vm.clearFilter() }, modifier = Modifier.weight(1f)) { Text("清除筛选") }
                OutlinedButton(
                    onClick = { vm.applyFilter() },
                    modifier = Modifier.weight(1f)
                ) { Text("应用") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var showPicker by remember { mutableStateOf(false) }
    val state = rememberDatePickerState(
        initialSelectedDateMillis = value.takeIf { it.isNotBlank() }
            ?.let { runCatching { LocalDate.parse(it, DateTimeFormatter.ISO_LOCAL_DATE).toEpochDay() * 86400000L }.getOrNull() }
    )
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = { Text("YYYY-MM-DD") },
        singleLine = true,
        modifier = modifier,
        trailingIcon = {
            IconButton(onClick = { showPicker = true }) { Icon(Icons.Default.DateRange, contentDescription = "选择日期") }
        },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text)
    )
    if (showPicker) {
        DatePickerDialog(
            onDismissRequest = { showPicker = false },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    state.selectedDateMillis?.let { ms ->
                        val d = LocalDate.ofEpochDay(ms / 86400000).format(DateTimeFormatter.ISO_LOCAL_DATE)
                        onValueChange(d)
                    }
                    showPicker = false
                }) { Text("确定") }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { showPicker = false }) { Text("取消") }
            }
        ) {
            DatePicker(state = state)
        }
    }
}

@Composable
private fun LogRow(entry: LogEntryDto) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = entry.action,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary
                )
                Text(
                    DateTimeUtil.formatFull(entry.time),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "${entry.username}${if (entry.store.isNotBlank()) " · ${entry.store}" else ""} · ${entry.module}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (entry.detail.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(entry.detail, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(4.dp))
            val ok = entry.result == "成功" || entry.result == "ok" || entry.result == "success"
            val color = if (ok) Success else MaterialTheme.colorScheme.error
            Text(
                "结果：${entry.result}",
                style = MaterialTheme.typography.labelSmall,
                color = color
            )
        }
    }
}
