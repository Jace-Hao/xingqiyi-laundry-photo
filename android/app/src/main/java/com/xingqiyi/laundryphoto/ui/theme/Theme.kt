package com.xingqiyi.laundryphoto.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography as Material3Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

/**
 * 应用主题。
 *
 * 深色模式三档：跟随系统 / 强制浅色 / 强制深色。
 * 「跟随系统」是默认值——门店场景里设备可能长期处于深色省电模式，
 * 让用户每次都手动切一次是不现实的。
 *
 * Android 12+ 启用动态取色（Material You）：系统会从壁纸提取主色，
 * 但如果主色与品牌蓝差异过大，界面会失去品牌辨识度，
 * 因此仅在动态色可用时采用，其余情况回退到固定的品牌配色。
 */

private val LightColors = lightColorScheme(
    primary = Brand500,
    onPrimary = androidx.compose.ui.graphics.Color.White,
    primaryContainer = Brand50,
    onPrimaryContainer = Brand800,
    secondary = AccentCyan,
    tertiary = AccentOrange,
    background = androidx.compose.ui.graphics.Color(0xFFF7F8FA),
    surface = androidx.compose.ui.graphics.Color.White,
    error = Danger
)

private val DarkColors = darkColorScheme(
    // 深色下不能用 Brand500 作 primary：深底蓝字对比度不足 4.5:1，
    // 提到 Brand300 才能在深色背景上保证可读（无障碍最低对比度要求）
    primary = Brand300,
    onPrimary = Brand900,
    primaryContainer = Brand800,
    onPrimaryContainer = Brand100,
    secondary = AccentCyan,
    tertiary = AccentOrange,
    background = androidx.compose.ui.graphics.Color(0xFF121212),
    surface = androidx.compose.ui.graphics.Color(0xFF1C1C1E),
    error = Danger
)

object ThemeMode {
    const val SYSTEM = "system"
    const val LIGHT = "light"
    const val DARK = "dark"
}

@Composable
fun XqyTheme(
    themeMode: String = ThemeMode.SYSTEM,
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val darkTheme = when (themeMode) {
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
        else -> isSystemInDarkTheme()
    }
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(
        colorScheme = colorScheme,
        // 用别名导入：kotlin.text 里也有 Typography，直接写 Typography 会被解析成后者
        typography = Material3Typography(),
        content = content
    )
}
