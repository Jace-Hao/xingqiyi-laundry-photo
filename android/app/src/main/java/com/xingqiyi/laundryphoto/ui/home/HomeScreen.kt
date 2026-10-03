package com.xingqiyi.laundryphoto.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.xingqiyi.laundryphoto.data.model.RecordDto
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.EmptyState
import com.xingqiyi.laundryphoto.ui.components.OfflineBar
import com.xingqiyi.laundryphoto.ui.components.StatCard
import com.xingqiyi.laundryphoto.ui.components.TagChip
import com.xingqiyi.laundryphoto.ui.theme.Brand50
import com.xingqiyi.laundryphoto.ui.theme.Brand500
import com.xingqiyi.laundryphoto.ui.theme.Success
import com.xingqiyi.laundryphoto.ui.theme.TagBlue
import com.xingqiyi.laundryphoto.ui.theme.TagGreenBg
import com.xingqiyi.laundryphoto.util.DateTimeUtil

@Composable
fun HomeScreen(
    vm: HomeViewModel,
    user: com.xingqiyi.laundryphoto.data.model.UserDto,
    thumbUrlOf: (RecordDto) -> String,
    onCapture: () -> Unit,
    onScanCapture: () -> Unit,
    onQuery: () -> Unit,
    onLogs: () -> Unit,
    onUsers: () -> Unit,
    onOverview: () -> Unit,
    onRecord: (String) -> Unit
) {
    val overview by vm.overview.collectAsState()
    val pending by vm.pending.collectAsState()
    val online by vm.online.collectAsState()
    val syncing by vm.syncing.collectAsState()
    val role = user.roleEnum

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
    ) {
        OfflineBar(
            offline = !online,
            pending = pending.size,
            syncing = syncing,
            onSync = { vm.syncNow() }
        )

        Column(Modifier.padding(Dimens.ScreenPadding)) {
            // ---------- 当前账号 ----------
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
            ) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(48.dp)
                            .clip(RoundedCornerShape(24.dp))
                            .background(Brand500),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            user.displayName.take(1),
                            color = androidx.compose.ui.graphics.Color.White,
                            style = MaterialTheme.typography.titleMedium
                        )
                    }
                    Spacer(Modifier.size(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(user.displayName, style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(4.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            TagChip(user.roleEnum.label, TagBlue, Brand500)
                            if (user.store.isNotBlank()) {
                                Spacer(Modifier.size(6.dp))
                                Text(
                                    user.store,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                    }
                }
            }

            Spacer(Modifier.height(Dimens.CardGap))

            // ---------- 统计（仅系统管理员） ----------
            if (role.manageUsers && overview != null) {
                val ov = overview!!
                Row(horizontalArrangement = Arrangement.spacedBy(Dimens.CardGap)) {
                    StatCard("今日存档", ov.todayRecordCount.toString(), Modifier.weight(1f))
                    StatCard("累计存档", ov.recordCount.toString(), Modifier.weight(1f))
                }
                Spacer(Modifier.height(Dimens.CardGap))
                Row(horizontalArrangement = Arrangement.spacedBy(Dimens.CardGap)) {
                    StatCard("账号数", "${ov.activeUserCount}/${ov.userCount}", Modifier.weight(1f))
                    StatCard("操作日志", ov.logCount.toString(), Modifier.weight(1f))
                }
                Spacer(Modifier.height(Dimens.CardGap))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onOverview) { Text("查看完整总览 ›") }
                }
            }

            // ---------- 快捷入口 ----------
            // 按角色拼出可见功能再两两分行：拍照角色有 4 个入口、查询角色只有 1 个，
            // 写死两行会在角色不同时出现半行的空位或孤零零一个卡片
            Text("常用功能", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(8.dp))
            val actions = buildList {
                if (role.capture) {
                    // 扫码拍照放在第一位：扫码连拍是门店最高频的操作
                    add(QuickItem("扫码拍照", Icons.Default.QrCodeScanner, onScanCapture))
                    add(QuickItem("衣物拍照", Icons.Default.PhotoCamera, onCapture))
                }
                add(QuickItem("订单查询", Icons.Default.Search, onQuery))
                if (role.viewStoreLogs) {
                    add(
                        QuickItem(
                            if (role.manageUsers) "操作日志" else "本店日志",
                            Icons.Default.History,
                            onLogs
                        )
                    )
                }
                if (role.manageUsers) {
                    add(QuickItem("用户管理", Icons.Default.Groups, onUsers))
                }
            }
            actions.chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(Dimens.CardGap)) {
                    row.forEach { item ->
                        QuickAction(item.label, item.icon, Modifier.weight(1f), item.onClick)
                    }
                    if (row.size == 1) Spacer(Modifier.weight(1f))
                }
                Spacer(Modifier.height(Dimens.CardGap))
            }

            // ---------- 最近存档（仅系统管理员） ----------
            if (role.manageUsers && overview != null && overview!!.recentRecords.isNotEmpty()) {
                Spacer(Modifier.height(20.dp))
                Text("最近存档", style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(8.dp))
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(end = 8.dp)
                ) {
                    items(overview!!.recentRecords) { rec ->
                        Card(
                            modifier = Modifier
                                .size(width = 120.dp, height = 148.dp)
                                .clickable { onRecord(rec.id) },
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
                        ) {
                            AsyncImage(
                                model = thumbUrlOf(rec),
                                contentDescription = null,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .aspectRatio(1f)
                            )
                            Column(Modifier.padding(8.dp)) {
                                Text(
                                    rec.barcode,
                                    style = MaterialTheme.typography.bodySmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                                Text(
                                    "第${rec.seq}张 · ${DateTimeUtil.formatShort(rec.createdAt)}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1
                                )
                            }
                        }
                    }
                }
            }

            if (!role.capture) {
                Spacer(Modifier.height(16.dp))
                Text(
                    "当前角色为${role.label}，只能查询订单，不能拍照录入。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(Modifier.height(24.dp))
        }
    }
}

private data class QuickItem(
    val label: String,
    val icon: ImageVector,
    val onClick: () -> Unit
)

@Composable
private fun QuickAction(
    label: String,
    icon: ImageVector,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Card(
        modifier = modifier.clickable { onClick() },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(Brand50),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = null, tint = Brand500)
            }
            Spacer(Modifier.height(8.dp))
            Text(label, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
