# ---------- 混淆规则 ----------
# 说明：Gson 依赖反射按字段名序列化/反序列化，Room 依赖生成的 DAO 实现类，
# OkHttp/Retrofit 有各自的反射入口，这几类一旦被重命名或移除就会在 release 包崩溃，
# 因此必须显式保留。业务代码其余部分正常混淆。

# Gson 数据模型：字段名即 JSON 键名，不能重命名也不能裁剪
#
# 【v1.3.1 修复】原先这里只 keep 了 data.remote.**，而**全部 DTO 都在 data.model.**
# （Models.kt / Role.kt）。data.remote 只是 Retrofit/OkHttp 的网络层，一个 DTO 都没有。
# 后果：release 包（isMinifyEnabled = true）里 R8 把 CapabilitiesDto / ApiEnvelope 的
# 字段全部剥离，类体只剩一个 PUBLIC ABSTRACT 空壳（dex 实测 Instance fields = 0），
# Gson 反射时抛
#     JsonIOException: Abstract classes can't be instantiated!
#     Adjust the R8 configuration ...
# 而 JsonIOException 是 JsonParseException 的子类，正好命中 ApiClient.translate() 的
# `is JsonParseException ->` 分支，于是被翻译成「已连接到 xxx，但对方返回的不是本系统的数据」。
# 服务端返回的 JSON 完全合法（app/apiVersion/features 一应俱全），
# 用户却被引导去查地址、查端口、查桌面端版本——三重误导，问题还永远查不出来。
#
# 关键教训：Gson DTO 的包名必须与实际存放位置一致。
# 校验方式见 docs 里的 release 自检清单（dexdump 查 Instance fields 是否为 0）。
-keepclassmembers,allowoptimization class com.xingqiyi.laundryphoto.data.model.** { <fields>; }
-keep class com.xingqiyi.laundryphoto.data.model.** { *; }

# Room 实体（本地离线队列）同样按字段名序列化，一并保留
-keep class com.xingqiyi.laundryphoto.data.local.** { *; }

# 网络层：Retrofit 接口靠注解反射、OkHttp 拦截器同理
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

# ---------- ZXing（扫码） ----------
# 与上面的 Gson DTO 是同一类问题，务必一起理解：
# ZXing 的 MultiFormatReader 在运行时按 BarcodeFormat 枚举挑选具体 Reader，
# 且 Result 的元数据（ResultMetadataType）通过反射查表转成字符串。
# R8 一旦把枚举常量或 Reader 实现类判为「无人引用」而删掉，
# 表现不是崩溃，而是**扫什么都不出结果**——比崩溃更难查，因为日志里没有任何异常。
# 因此这里保留整个 com.google.zxing 包（体积代价约 500KB，换离线扫码的确定性）。
-keep class com.google.zxing.** { *; }
-keep enum com.google.zxing.BarcodeFormat { *; }
-keep enum com.google.zxing.ResultMetadataType { *; }
-keep enum com.google.zxing.DecodeHintType { *; }
-dontwarn com.google.zxing.**

# Crash 时保留行号，便于定位（release 也保留，体积代价很小）
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
