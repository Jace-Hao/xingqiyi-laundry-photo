# ---------- 混淆规则 ----------
# 说明：Gson 依赖反射按字段名序列化/反序列化，Room 依赖生成的 DAO 实现类，
# OkHttp/Retrofit 有各自的反射入口，这几类一旦被重命名或移除就会在 release 包崩溃，
# 因此必须显式保留。业务代码其余部分正常混淆。

# Gson 数据模型：字段名即 JSON 键名，不能重命名也不能裁剪
-keepclassmembers,allowoptimization class com.xingqiyi.laundryphoto.data.remote.** { <fields>; }
-keep class com.xingqiyi.laundryphoto.data.remote.** { *; }

# Gson 自身的类型适配器与注解
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes InnerClasses
-keepattributes EnclosingMethod
-dontwarn sun.misc.**
-keep class com.google.gson.** { *; }
-keep class * implements com.google.gson.TypeAdapterFactory
-keep class * implements com.google.gson.JsonSerializer
-keep class * implements com.google.gson.JsonDeserializer

# Room：数据库类名、Entity 字段与 DAO 实现类都需要保留
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class * { *; }
-dontwarn androidx.room.paging.**

# OkHttp / Retrofit
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn retrofit2.**
-keepclasseswithmembers class * { @retrofit2.http.* <methods>; }
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# CameraX：供应商实现通过反射加载
-keepclassmembers class * {
    @androidx.camera.core.** <methods>;
}
-dontwarn androidx.camera.camera2.internal.compat.**

# WorkManager：Worker 由系统按类名反射实例化
-keep class * extends androidx.work.Worker
-keep class * extends androidx.work.ListenableWorker

# 协程与 Flow 的内部类
-keepclassmembers class **$WhenMappings { <fields>; }
-dontwarn kotlinx.coroutines.**

# Crash 时保留行号，便于定位（release 也保留，体积代价很小）
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
