package com.xingqiyi.laundryphoto.ui

import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.xingqiyi.laundryphoto.BuildConfig
import com.xingqiyi.laundryphoto.LaundryApp
import com.xingqiyi.laundryphoto.data.model.SessionSnapshot
import com.xingqiyi.laundryphoto.data.model.UserDto
import com.xingqiyi.laundryphoto.data.remote.SessionMonitor
import com.xingqiyi.laundryphoto.di.AppContainer
import com.xingqiyi.laundryphoto.sync.Notifier
import com.xingqiyi.laundryphoto.sync.SyncManager
import com.xingqiyi.laundryphoto.ui.capture.CaptureScreen
import com.xingqiyi.laundryphoto.ui.capture.CaptureViewModel
import com.xingqiyi.laundryphoto.ui.detail.RecordDetailScreen
import com.xingqiyi.laundryphoto.ui.detail.RecordDetailViewModel
import com.xingqiyi.laundryphoto.ui.home.HomeScreen
import com.xingqiyi.laundryphoto.ui.home.HomeViewModel
import com.xingqiyi.laundryphoto.ui.login.LoginScreen
import com.xingqiyi.laundryphoto.ui.login.LoginViewModel
import com.xingqiyi.laundryphoto.ui.logs.LogsScreen
import com.xingqiyi.laundryphoto.ui.logs.LogsViewModel
import com.xingqiyi.laundryphoto.ui.overview.OverviewScreen
import com.xingqiyi.laundryphoto.ui.overview.OverviewViewModel
import com.xingqiyi.laundryphoto.ui.query.QueryScreen
import com.xingqiyi.laundryphoto.ui.query.QueryViewModel
import com.xingqiyi.laundryphoto.ui.settings.SettingsScreen
import com.xingqiyi.laundryphoto.ui.settings.SettingsViewModel
import com.xingqiyi.laundryphoto.ui.theme.ThemeMode
import com.xingqiyi.laundryphoto.ui.theme.XqyTheme
import com.xingqiyi.laundryphoto.ui.users.UsersScreen
import com.xingqiyi.laundryphoto.ui.users.UsersViewModel

/**
 * 应用主入口与导航中枢。
 *
 * 这里集中处理「全局性、与单个页面无关」的事：
 * 1. 启动画面（Splash）：在会话校验（网络请求）完成前保持系统启动图，避免白屏；
 * 2. 冷启动会话恢复：有本地令牌就验一次当前账号，有效则免登录进首页；
 * 3. 底部导航：按角色裁剪可见页（拍照账号看得见拍照、门店管理员看得见日志…）；
 * 4. 被顶下线广播：任何页面请求返回 revoked 都在此强制退回登录页（见 SessionMonitor）；
 * 5. 周期补传：进应用就注册 15 分钟兜底扫描，保证离线照片最终能上传。
 */
class MainActivity : ComponentActivity() {

    private val container by lazy { (application as LaundryApp).container }

    override fun onCreate(savedInstanceState: Bundle?) {
        // 必须在 setContent 之前安装，且 keep 条件要在 setContent 内修改
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)

        // 用普通 MutableState 持有「是否还需停留启动图」：它只是一个跨协程的标记，
        // 启动校验完成后置为 false，系统启动图随即消失。
        val keepSplash = mutableStateOf(true)
        splash.setKeepOnScreenCondition { keepSplash.value }

        setContent {
            val themeMode by container.settings.themeMode.collectAsState(initial = ThemeMode.SYSTEM)
            XqyTheme(
                themeMode = themeMode,
                // 动态取色仅 Android 12+ 支持，低版本回退到固定品牌色
                dynamicColor = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ) {
                AppRoot(container = container, keepSplash = keepSplash)
            }
        }
    }
}

/**
 * 导航路由常量：集中定义，避免散落的字符串字面量拼错
 */
private object Routes {
    const val LOGIN = "login"
    const val HOME = "home"
    const val CAPTURE = "capture"
    const val QUERY = "query"
    const val LOGS = "logs"
    const val USERS = "users"
    const val SETTINGS = "settings"
    const val OVERVIEW = "overview"
    const val DETAIL = "detail/{id}"
    val BOTTOM = setOf(HOME, CAPTURE, QUERY, LOGS, SETTINGS)
}

@Composable
private fun AppRoot(
    container: AppContainer,
    keepSplash: androidx.compose.runtime.MutableState<Boolean>
) {
    val navController = rememberNavController()
    var currentUser by remember { mutableStateOf<UserDto?>(null) }
    var bootstrapped by remember { mutableStateOf(false) }

    val revoked by SessionMonitor.revoked.collectAsState()

    // ---------- 冷启动会话恢复 ----------
    LaunchedEffect(Unit) {
        container.ensureConfigured()
        // 进应用就注册周期补传兜底，App 整个离线期间也会在 15 分钟后被唤醒重试
        SyncManager.enqueuePeriodic(container.appContext)
        val snap = runCatching { container.authRepository.sessionOnce() }.getOrElse { SessionSnapshot() }
        var user: UserDto? = null
        if (snap.token.isNotBlank()) {
            // 令牌可能已过期/被顶，验一次；失败（含被顶）返回 null，回到登录页
            user = runCatching { container.authRepository.currentOrNull() }.getOrNull()
        }
        currentUser = user
        bootstrapped = true
        keepSplash.value = false
    }

    // ---------- 被顶下线：全局强制退登录 ----------
    LaunchedEffect(revoked) {
        if (revoked != null) {
            runCatching { container.authRepository.logout() }
            SyncManager.cancelAll(container.appContext)
            currentUser = null
            navController.navigate(Routes.LOGIN) {
                popUpTo(navController.graph.startDestinationId) { inclusive = true }
            }
            Toast.makeText(container.appContext, revoked, Toast.LENGTH_LONG).show()
            SessionMonitor.consume()
        }
    }

    // ---------- 登录后检查服务端是否强制要求更新 ----------
    LaunchedEffect(currentUser) {
        if (currentUser != null) {
            runCatching {
                val fu = container.systemRepository.forceUpdate()
                if (fu?.enabled == true) Notifier.notifyForceUpdate(container.appContext, fu.version)
            }
        }
    }

    if (!bootstrapped) {
        // 启动校验进行中：系统启动图仍在显示，这里给一个同色的占位即可
        Box(
            Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
            contentAlignment = Alignment.Center
        ) { /* splash 由系统层承担 */ }
        return
    }

    val startDestination = if (currentUser != null) Routes.HOME else Routes.LOGIN
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route
    val showBottomBar = currentUser != null && Routes.BOTTOM.contains(currentRoute)

    Scaffold(
        bottomBar = {
            if (showBottomBar) {
                val role = currentUser?.roleEnum
                val items = buildList {
                    add(BottomItem(Routes.HOME, "首页", Icons.Filled.Home))
                    if (role?.capture == true) add(BottomItem(Routes.CAPTURE, "拍照", Icons.Filled.PhotoCamera))
                    add(BottomItem(Routes.QUERY, "查询", Icons.Filled.Search))
                    if (role?.viewStoreLogs == true) add(BottomItem(Routes.LOGS, "日志", Icons.Filled.History))
                    add(BottomItem(Routes.SETTINGS, "设置", Icons.Filled.Settings))
                }
                NavigationBar {
                    val selectedRoute = navBackStackEntry?.destination?.hierarchy?.first()?.route
                    items.forEach { item ->
                        NavigationBarItem(
                            selected = selectedRoute == item.route,
                            onClick = {
                                navController.navigate(item.route) {
                                    popUpTo(navController.graph.findStartDestination().id) {
                                        saveState = true
                                    }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = { Icon(item.icon, contentDescription = item.label) },
                            label = { Text(item.label) }
                        )
                    }
                }
            }
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = startDestination,
            modifier = Modifier.fillMaxSize().padding(padding)
        ) {
            // ---------- 登录 ----------
            composable(Routes.LOGIN) {
                val vm = viewModel { LoginViewModel(container) }
                LoginScreen(
                    vm = vm,
                    versionName = BuildConfig.VERSION_NAME,
                    onLoggedIn = { user ->
                        currentUser = user
                        navController.navigate(Routes.HOME) {
                            popUpTo(Routes.LOGIN) { inclusive = true }
                        }
                    }
                )
            }

            // ---------- 首页 ----------
            composable(Routes.HOME) {
                val vm = viewModel { HomeViewModel(container) }
                LaunchedEffect(currentUser) { currentUser?.let { vm.refresh(it) } }
                HomeScreen(
                    vm = vm,
                    user = currentUser!!,
                    thumbUrlOf = { rec -> container.recordRepository.thumbUrl(rec) },
                    onCapture = { navController.navigate(Routes.CAPTURE) },
                    onQuery = { navController.navigate(Routes.QUERY) },
                    onLogs = { navController.navigate(Routes.LOGS) },
                    onUsers = { navController.navigate(Routes.USERS) },
                    onOverview = { navController.navigate(Routes.OVERVIEW) },
                    onRecord = { id -> navController.navigate("detail/$id") }
                )
            }

            // ---------- 拍照 ----------
            composable(Routes.CAPTURE) {
                val vm = viewModel { CaptureViewModel(container) }
                CaptureScreen(
                    vm = vm,
                    onBack = { navController.popBackStack() },
                    onSaved = {
                        // 保存成功（无论在线还是离线入队）统一回到首页，首页会显示待同步角标
                        navController.navigate(Routes.HOME) {
                            popUpTo(navController.graph.findStartDestination().id) {
                                saveState = true
                            }
                            launchSingleTop = true
                            restoreState = true
                        }
                    }
                )
            }

            // ---------- 查询 ----------
            composable(Routes.QUERY) {
                val vm = viewModel { QueryViewModel(container) }
                QueryScreen(
                    vm = vm,
                    canDelete = { rec -> rec.isOwn(currentUser?.id ?: "") || (currentUser?.roleEnum?.manageUsers == true) },
                    thumbUrlOf = { rec -> container.recordRepository.thumbUrl(rec) },
                    onOpenRecord = { id -> navController.navigate("detail/$id") }
                )
            }

            // ---------- 日志 ----------
            composable(Routes.LOGS) {
                val vm = viewModel { LogsViewModel(container) }
                LogsScreen(vm = vm, onBack = { navController.popBackStack() })
            }

            // ---------- 用户管理 ----------
            composable(Routes.USERS) {
                val vm = viewModel { UsersViewModel(container) }
                UsersScreen(vm = vm, onBack = { navController.popBackStack() })
            }

            // ---------- 总览 ----------
            composable(Routes.OVERVIEW) {
                val vm = viewModel { OverviewViewModel(container) }
                OverviewScreen(
                    vm = vm,
                    onBack = { navController.popBackStack() },
                    container = container,
                    onRecord = { id -> navController.navigate("detail/$id") }
                )
            }

            // ---------- 设置 ----------
            composable(Routes.SETTINGS) {
                val vm = viewModel { SettingsViewModel(container) }
                SettingsScreen(
                    vm = vm,
                    onBack = { navController.popBackStack() },
                    onLogout = {
                        currentUser = null
                        navController.navigate(Routes.LOGIN) {
                            popUpTo(navController.graph.startDestinationId) { inclusive = true }
                        }
                    }
                )
            }

            // ---------- 详情 ----------
            composable(
                Routes.DETAIL,
                arguments = listOf(navArgument("id") { type = NavType.StringType })
            ) { backStack ->
                val id = backStack.arguments?.getString("id") ?: ""
                val vm = viewModel { RecordDetailViewModel(container) }
                RecordDetailScreen(
                    vm = vm,
                    recordId = id,
                    currentUserId = currentUser?.id ?: "",
                    onBack = { navController.popBackStack() }
                )
            }
        }
    }
}

private data class BottomItem(
    val route: String,
    val label: String,
    val icon: androidx.compose.ui.graphics.vector.ImageVector
)
