package com.xingqiyi.laundryphoto.ui.detail

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DriveFileRenameOutline
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.xingqiyi.laundryphoto.ui.components.ConfirmDialog
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.ErrorBar
import com.xingqiyi.laundryphoto.ui.components.InfoRow
import com.xingqiyi.laundryphoto.util.DateTimeUtil
import com.xingqiyi.laundryphoto.util.PhotoSaver
import kotlinx.coroutines.launch

/**
 * 存档详情：大图 + 属性 + 操作。
 *
 * 缩放用手势（双指捏合、双击复位）而不是「+-」按钮：
 * 桌面端是鼠标滚轮缩放，手机上是捏合，交互习惯不同但目的一致——
 * 看清衣物细节（尤其是污渍位置与条码标签）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordDetailScreen(
    vm: RecordDetailViewModel,
    recordId: String,
    currentUserId: String,
    onBack: () -> Unit
) {
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    val record by vm.record.collectAsState()
    val error by vm.error.collectAsState()
    val busy by vm.busy.collectAsState()
    val scope = rememberCoroutineScope()

    var showDelete by remember { mutableStateOf(false) }
    var showRename by remember { mutableStateOf(false) }
    var renameValue by remember { mutableStateOf("") }
    var showNote by remember { mutableStateOf(false) }
    var noteValue by remember { mutableStateOf("") }

    LaunchedEffect(recordId) { vm.load(recordId) }
    LaunchedEffect(Unit) {
        vm.toast.collect { snackbar.showSnackbar(it) }
    }
    LaunchedEffect(Unit) {
        vm.changed.collect { snackbar.showSnackbar(it) }
    }
    LaunchedEffect(Unit) {
        vm.deleted.collect { onBack() }
    }

    val rec = record
    val canEdit = rec != null && (rec.userId == currentUserId)

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(rec?.barcode ?: "存档详情") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            androidx.compose.material.icons.Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回"
                        )
                    }
                },
                actions = {
                    IconButton(onClick = {
                        scope.launch {
                            val url = vm.photoUrl()
                            val r = record
                            if (r == null || url.isBlank()) {
                                snackbar.showSnackbar("照片地址无效")
                                return@launch
                            }
                            val file = PhotoSaver.fetch(
                                context,
                                url,
                                PhotoSaver.fileNameOf(r.barcode, r.seq, r.createdAt)
                            )
                            if (file == null) snackbar.showSnackbar("下载失败，请检查网络")
                            else PhotoSaver.share(context, file)
                        }
                    }) {
                        Icon(Icons.Default.Share, contentDescription = "保存/分享")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface)
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        if (rec == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                if (error == null) CircularProgressIndicator() else Text(error!!)
            }
            return@Scaffold
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
        ) {
            if (error != null) ErrorBar(error!!, onDismiss = { vm.clearError() })

            ZoomableImage(
                model = vm.photoUrl(),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(360.dp)
            )

            Column(Modifier.padding(Dimens.ScreenPadding)) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
                ) {
                    Column(Modifier.padding(12.dp)) {
                        InfoRow("条码", rec.barcode)
                        InfoRow("序号", "第 ${rec.seq} 张")
                        InfoRow("拍摄时间", DateTimeUtil.formatFull(rec.createdAt))
                        InfoRow("所属账号", rec.username)
                        if (rec.storeName.isNotBlank()) InfoRow("门店", rec.storeName)
                        InfoRow("备注", rec.note.ifBlank { "（无）" })
                    }
                }

                Spacer(Modifier.height(Dimens.CardGap))

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(
                        onClick = { noteValue = rec.note; showNote = true },
                        enabled = canEdit && !busy,
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Default.EditNote, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(4.dp))
                        Text("改备注")
                    }
                    TextButton(
                        onClick = { renameValue = rec.barcode; showRename = true },
                        enabled = canEdit && !busy,
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Default.DriveFileRenameOutline, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(4.dp))
                        Text("改条码")
                    }
                    TextButton(
                        onClick = { showDelete = true },
                        enabled = canEdit && !busy,
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Default.Delete, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(4.dp))
                        Text("删除")
                    }
                }

                if (!canEdit) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "该存档不属于当前账号，只能查看与分享。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }

    if (showDelete) {
        ConfirmDialog(
            title = "删除这张照片？",
            message = "条码「${rec?.barcode}」第 ${rec?.seq} 张，删除后无法恢复。",
            confirmText = "删除",
            danger = true,
            onConfirm = { showDelete = false; vm.delete() },
            onDismiss = { showDelete = false }
        )
    }
    if (showRename) {
        SingleInputDialog(
            title = "修改条码",
            label = "新条码",
            value = renameValue,
            hint = "改码后照片会迁移到新条码目录，编号自动重排",
            onValueChange = { renameValue = it },
            onConfirm = { showRename = false; vm.rename(renameValue) },
            onDismiss = { showRename = false }
        )
    }
    if (showNote) {
        SingleInputDialog(
            title = "修改备注",
            label = "备注",
            value = noteValue,
            hint = "最多 200 字",
            onValueChange = { noteValue = it },
            onConfirm = { showNote = false; vm.setNote(noteValue) },
            onDismiss = { showNote = false }
        )
    }
}

@Composable
private fun SingleInputDialog(
    title: String,
    label: String,
    value: String,
    hint: String,
    onValueChange: (String) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                OutlinedTextField(
                    value = value,
                    onValueChange = onValueChange,
                    label = { Text(label) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    hint,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("确定") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

/** 双指缩放 + 双击复位的大图查看 */
@Composable
private fun ZoomableImage(model: String, modifier: Modifier = Modifier) {
    var scale by remember { mutableStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Box(
        modifier = modifier
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f)
                    // 回到 1 倍时把位移归零，避免图片被拖出可视区后回不来
                    offset = if (scale > 1f) offset + pan else Offset.Zero
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = {
                    scale = 1f
                    offset = Offset.Zero
                })
            },
        contentAlignment = Alignment.Center
    ) {
        AsyncImage(
            model = model,
            contentDescription = "存档照片",
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(
                    scaleX = scale,
                    scaleY = scale,
                    translationX = offset.x,
                    translationY = offset.y
                )
        )
    }
}
