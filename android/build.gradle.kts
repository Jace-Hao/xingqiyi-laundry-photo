// 根工程构建脚本：只声明插件版本，具体插件在 app 模块内 apply。
// 这样新增模块时无需在此重复应用插件，避免根工程被无意间打进产物。
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    // Room 注解处理器（kapt 与 Kotlin 1.9.x 组合最稳定，KSP 需额外对齐版本）
    id("org.jetbrains.kotlin.kapt") version "1.9.24" apply false
}
