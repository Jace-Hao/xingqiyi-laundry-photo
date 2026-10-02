package com.xingqiyi.laundryphoto.ui.overview

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.xingqiyi.laundryphoto.data.model.OverviewDto
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.ui.components.Dimens
import com.xingqiyi.laundryphoto.ui.components.ErrorBar
import com.xingqiyi.laundryphoto.ui.components.LoadingState
import com.xingqiyi.laundryphoto.ui.components.StatCard
import com.xingqiyi.laundryphoto.ui.components.XqyTopBar
import com.xingqiyi.laundryphoto.ui.theme.Brand50
import com.xingqiyi.laundryphoto.ui.theme.Brand500
import com.xingqiyi.laundryphoto.util.DateTimeUtil

/**
 * 数据总览页（系统管理员）。
 *
 * 设计原则同首页：数字要大、要少、要一眼可读。账号分布用一行小标签呈现，
 * 最近存档走横向滑动（与首页一致，避免占用整屏下滚空间）。
 */
@Composable
fun OverviewScreen(
    vm: OverviewViewModel,
    onBack: () -> Unit,
    container: AppContainer? = null,
    onRecord: (String) -> Unit = {}
) {
    val overview by vm.overview.collectAsState()
    val loading by vm.loading.collectAsState()
    val error by vm.error.collectAsState()

    LaunchedEffect(Unit) { vm.toast.collect { } }

    Column(Modifier.fillMaxSize()) {
        XqyTopBar(title = "数据总览", onBack = onBack)
        if (error != null) ErrorBar(error!!, onDismiss = { vm.clearError() })
        if (loading && overview == null) {
            LoadingState()
        } else if (overview == null) {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Text("暂时无法获取总览数据，请检查网络后重试", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            OverviewContent(overview = overview!!, container = container, onRecord = onRecord)
        }
    }
}

@Composable
private fun OverviewContent(
    overview: OverviewDto,
    container: AppContainer?,
    onRecord: (String) -> Unit
) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Dimens.ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(Dimens.CardGap)
    ) {
        // 第一行：今日 / 累计存档
        Row(horizontalArrangement = Arrangement.spacedBy(Dimens.CardGap)) {
            StatCard("今日存档", overview.todayRecordCount.toString(), Modifier.weight(1f))
            StatCard("累计存档", overview.recordCount.toString(), Modifier.weight(1f))
        }
        // 第二行：账号 / 日志
        Row(horizontalArrangement = Arrangement.spacedBy(Dimens.CardGap)) {
            StatCard("活跃账号", "${overview.activeUserCount}/${overview.userCount}", Modifier.weight(1f))
            StatCard("操作日志", overview.logCount.toString(), Modifier.weight(1f))
        }

        // 账号角色分布
        Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(12.dp)) {
                Text("账号角色分布", style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    overview.roleCount.entries.forEach { (role, count) ->
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.weight(1f)
                                .clip(RoundedCornerShape(8.dp))
                                .background(Brand50)
                                .padding(vertical = 8.dp)
                        ) {
                            Text(count.toString(), style = MaterialTheme.typography.titleMedium, color = Brand500)
                            Spacer(Modifier.height(2.dp))
                            Text(role, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (overview.roleCount.isEmpty()) {
                        Text("暂无账号", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }

        // 最近存档
        if (overview.recentRecords.isNotEmpty()) {
            Text("最近存档", style = MaterialTheme.typography.titleSmall)
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(end = 8.dp)
            ) {
                items(overview.recentRecords, key = { it.id }) { rec ->
                    Card(
                        modifier = Modifier.size(width = 120.dp, height = 150.dp).clickable { onRecord(rec.id) },
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
                    ) {
                        AsyncImage(
                            model = container?.recordRepository?.thumbUrl(rec) ?: "",
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxWidth().aspectRatio(1f)
                        )
                        Column(Modifier.padding(8.dp)) {
                            Text(rec.barcode, style = MaterialTheme.typography.bodySmall, maxLines = 1)
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

        // 最近操作
        if (overview.recentLogs.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text("最近操作", style = MaterialTheme.typography.titleSmall)
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(12.dp)) {
                    overview.recentLogs.take(10).forEach { log ->
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(log.action, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                                Text(
                                    "${log.username} · ${DateTimeUtil.formatShort(log.time)}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Text(log.result, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}
