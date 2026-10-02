package com.xingqiyi.laundryphoto.ui.query

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DriveFileRenameOutline
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SelectAll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import coil.compose.AsyncImage
import com.xingqiyi.laundryphoto.data.model.RecordDto
import com.xingqiyi.laundryphoto.ui.components.ConfirmDialog
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.EmptyState
import com.xingqiyi.laundryphoto.ui.components.ErrorBar
import com.xingqiyi.laundryphoto.ui.components.ListFooter
import com.xingqiyi.laundryphoto.ui.components.LoadingState
import com.xingqiyi.laundryphoto.ui.theme.Brand500
import com.xingqiyi.laundryphoto.util.DateTimeUtil
import kotlinx.coroutines.launch

/**
 * 订单查询页。
 *
 * 网格列数自适应：用 Adaptive 而非固定 3 列，这样在平板与折叠屏展开态下会自动多排一列，
 * 不会出现「一张图占半屏」的浪费（桌面端 v1.1.0 修的就是「不随窗口大小变化」这个反馈）。
 */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun QueryScreen(
    vm: QueryViewModel,
    canDelete: (RecordDto) -> Boolean,
    thumbUrlOf: (RecordDto) -> String,
    onOpenRecord: (String) -> Unit
) {
    val snackbar = remember { SnackbarHostState() }
    // 删除/改码是异步回调，showSnackbar 是 suspend，必须借协程作用域调用
    val scope = rememberCoroutineScope()
    val items by vm.items.collectAsState()
    val loading by vm.loading.collectAsState()
    val loadingMore by vm.loadingMore.collectAsState()
    val error by vm.error.collectAsState()
    val total by vm.total.collectAsState()

    var showDeleteConfirm by remember { mutableStateOf(false) }
    var showRenameDialog by remember { mutableStateOf(false) }
    var renameValue by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        vm.toast.collect { snackbar.showSnackbar(it) }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        if (vm.selectMode) Text("已选择 ${vm.selected.size} 项")
                        else Text("订单查询")
                    },
                    actions = {
                        if (vm.selectMode) {
                            IconButton(onClick = { vm.selectAll() }) {
                                Icon(Icons.Default.SelectAll, contentDescription = "全选")
                            }
                            IconButton(onClick = { showRenameDialog = true }) {
                                Icon(Icons.Default.DriveFileRenameOutline, contentDescription = "批量改码")
                            }
                            IconButton(onClick = { showDeleteConfirm = true }) {
                                Icon(Icons.Default.Delete, contentDescription = "批量删除")
                            }
                            IconButton(onClick = { vm.clearSelection() }) {
                                Icon(Icons.Default.Close, contentDescription = "退出多选")
                            }
                        } else {
                            IconButton(onClick = { vm.filterVisible.value = !vm.filterVisible.value }) {
                                Icon(Icons.Default.FilterList, contentDescription = "筛选")
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface)
                )
                // 搜索框常驻顶栏下方：查询是高频操作，藏进菜单里每次都要多点两下
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surface)
                        .padding(horizontal = Dimens.ScreenPadding, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedTextField(
                        value = vm.keyword.value,
                        onValueChange = vm::onKeywordChange,
                        placeholder = { Text("搜索条码 / 备注 / 账号 / 门店") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search)
                    )
                    if (vm.dateFrom.value.isNotBlank() || vm.dateTo.value.isNotBlank()) {
                        Spacer(Modifier.width(8.dp))
                        AssistChip(
                            onClick = { vm.clearFilter() },
                            label = { Text("已筛选") }
                        )
                    }
                }
            }
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (error != null) ErrorBar(error!!, onDismiss = { vm.clearError() })

            if (loading && items.isEmpty()) {
                LoadingState()
                return@Column
            }
            if (items.isEmpty()) {
                EmptyState(
                    text = "没有找到存档照片",
                    hint = if (vm.keyword.value.isBlank() && vm.dateFrom.value.isBlank()) {
                        "还没有任何衣物照片，去「拍照」录入第一张吧"
                    } else {
                        "换个关键词，或清除日期筛选再试试"
                    }
                )
                return@Column
            }

            Text(
                "共 $total 条",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Dimens.ScreenPadding, vertical = 6.dp)
            )

            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 150.dp),
                contentPadding = PaddingValues(
                    start = Dimens.ScreenPadding,
                    end = Dimens.ScreenPadding,
                    bottom = 24.dp
                ),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.weight(1f)
            ) {
                items(items, key = { it.id }) { rec ->
                    RecordCard(
                        record = rec,
                        thumbUrl = thumbUrlOf(rec),
                        selected = vm.selected.contains(rec.id),
                        selectMode = vm.selectMode,
                        onClick = {
                            if (vm.selectMode) vm.toggleSelect(rec.id) else onOpenRecord(rec.id)
                        },
                        onLongClick = { vm.toggleSelect(rec.id) }
                    )
                }
                item {
                    ListFooter(
                        loading = loadingMore,
                        hasMore = vm.hasMore,
                        onLoadMore = { vm.loadMore() },
                        contentPadding = PaddingValues(top = 8.dp)
                    )
                }
            }
        }
    }

    if (showDeleteConfirm) {
        ConfirmDialog(
            title = "删除 ${vm.selected.size} 条存档？",
            message = "删除后照片与记录都无法恢复。只有本人或系统管理员可删除他人的存档，无权限的会被跳过。",
            confirmText = "删除",
            danger = true,
            onConfirm = {
                showDeleteConfirm = false
                vm.deleteSelected { count ->
                    scope.launch { snackbar.showSnackbar("已删除 $count 条") }
                }
            },
            onDismiss = { showDeleteConfirm = false }
        )
    }

    if (showRenameDialog) {
        RenameDialog(
            value = renameValue,
            onValueChange = { renameValue = it },
            onConfirm = {
                showRenameDialog = false
                vm.renameSelected(renameValue) { count ->
                    scope.launch { snackbar.showSnackbar("已改码 $count 条") }
                }
                renameValue = ""
            },
            onDismiss = { showRenameDialog = false }
        )
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun RecordCard(
    record: RecordDto,
    thumbUrl: String,
    selected: Boolean,
    selectMode: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .then(
                if (selected) Modifier.border(2.dp, Brand500, RoundedCornerShape(12.dp)) else Modifier
            ),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Box {
            AsyncImage(
                model = thumbUrl,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f)
            )
            if (selectMode) {
                Box(
                    modifier = Modifier
                        .padding(6.dp)
                        .align(Alignment.TopStart)
                        .size(24.dp)
                        .background(
                            if (selected) Brand500 else Color.Black.copy(alpha = 0.35f),
                            RoundedCornerShape(12.dp)
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    if (selected) {
                        Icon(
                            Icons.Default.CheckCircle,
                            contentDescription = null,
                            tint = Color.White,
                            modifier = Modifier.size(18.dp)
                        )
                    }
                }
            }
            if (record.pendingSync) {
                Text(
                    "待同步",
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(6.dp)
                        .background(Color(0xFFFF7D00), RoundedCornerShape(4.dp))
                        .padding(horizontal = 5.dp, vertical = 1.dp),
                    color = Color.White,
                    style = MaterialTheme.typography.labelSmall
                )
            }
        }
        Column(Modifier.padding(8.dp)) {
            Text(
                record.barcode,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                "第${record.seq}张 · ${DateTimeUtil.formatShort(record.createdAt)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1
            )
            if (record.note.isNotBlank()) {
                Text(
                    record.note,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
private fun RenameDialog(
    value: String,
    onValueChange: (String) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("批量修改条码") },
        text = {
            Column {
                Text("选中的存档会统一改成同一个新条码，照片随之迁移，编号自动重排。")
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = value,
                    onValueChange = onValueChange,
                    label = { Text("新条码") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("确定") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}
