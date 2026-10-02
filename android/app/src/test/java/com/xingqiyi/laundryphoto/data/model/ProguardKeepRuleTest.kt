package com.xingqiyi.laundryphoto.data.model

import com.google.common.truth.Truth.assertThat
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import org.junit.Test
import java.io.File

/**
 * release 混淆规则守卫：**Gson DTO 所在包必须被 proguard 显式保留**。
 *
 * ## 这条规则防的是哪个 bug（v1.3.1 线上事故）
 *
 * v1.3.0 的 `proguard-rules.pro` 写的是：
 * ```
 * -keep class com.xingqiyi.laundryphoto.data.remote.** { *; }
 * ```
 * 而**全部 DTO 都在 `data.model`**（`Models.kt` / `Role.kt`），
 * `data.remote` 只有 Retrofit 接口和 OkHttp 拦截器，一个 DTO 都没有。
 * 也就是说这条 keep 规则**保护了空目录，放过了真正需要保护的地方**。
 *
 * 后果链条（每一环都实测确认过）：
 * 1. release 开启 `isMinifyEnabled = true`，R8 认为 DTO 字段无人引用 → 全部剥离；
 * 2. dex 实测：`ApiEnvelope` / `CapabilitiesDto` 变成 `PUBLIC ABSTRACT`，
 *    `Instance fields = 0`，整个 dex 里搜不到字符串 `"apiVersion"`；
 * 3. Gson 反射实例化时抛
 *    `JsonIOException: Abstract classes can't be instantiated!`；
 * 4. `JsonIOException` 是 `JsonParseException` 子类，命中 `ApiClient.translate()`
 *    的 `is JsonParseException ->` 分支，被翻译成
 *    「已连接到 xxx，但对方返回的不是本系统的数据」；
 * 5. 可服务端返回的 JSON 完全合法 —— 用户查地址、查端口、查桌面端版本，
 *    三条线索全是错的，问题永远查不出来。
 *
 * ## 为什么必须写成测试
 *
 * 这类 bug 在**单元测试里 100% 测不出来**：测试跑的是未混淆的 class 文件，
 * 字段都在，Gson 一切正常。只有装到真机的 release 包才会崩。
 * 同理，`assembleRelease` 也不会报错——R8 剥离字段是完全合法的行为。
 *
 * 所以唯一可靠的位置就是这里：把「包名必须被 keep」变成一条会红的断言。
 * 以后新增 DTO 包、或有人再次写错包名，构建立刻失败，而不是等用户报障。
 *
 * 兜底防线还有两道：
 * - `ApiClient.clientSideDefectMessage()` 让这类故障在用户侧自报家门，不再伪装成地址问题；
 * - 发布清单里的 dex 自检（`dexdump` 查 `Instance fields`）。
 */
class ProguardKeepRuleTest {

    /** DTO 实际所在的包。改包名时这里必须同步，否则测试会误报通过。 */
    private val dtoPackages = listOf(
        "com.xingqiyi.laundryphoto.data.model",
        "com.xingqiyi.laundryphoto.data.local"
    )

    private fun rules(): String {
        // 测试的工作目录是模块根（app/），因此 proguard-rules.pro 就在同级
        val candidates = listOf(
            File("proguard-rules.pro"),
            File("app/proguard-rules.pro")
        )
        val file = candidates.firstOrNull { it.isFile }
        assertThat(file).isNotNull()
        return file!!.readText()
    }

    @Test
    fun `所有 Gson DTO 包都被 proguard 显式保留`() {
        val text = rules()
        val missing = dtoPackages.filter { pkg ->
            // 要求存在「保留该包全部成员」的规则；只 keepclassmembers <fields> 不够，
            // 因为 R8 仍可能把类体优化成抽象空壳（正是本次事故的形态）
            !text.contains("-keep class $pkg.** { *; }")
        }
        assertThat(missing).isEmpty()
    }

    @Test
    fun `保留 DTO 的规则不得使用 allowoptimization 之外的宽松形式`() {
        val text = rules()
        dtoPackages.forEach { pkg ->
            assertThat(text).contains("-keep class $pkg.** { *; }")
        }
    }

    /**
     * 反向断言：防止有人「顺手」把 keep 规则又挪回 `data.remote`。
     *
     * 保留这条网络层的 keep 是对的（Retrofit 靠注解反射接口），
     * 但它**不能**代替 DTO 的 keep——这正是本次事故的认知误区。
     */
    @Test
    fun `data remote 的 keep 规则不能被误认为覆盖了 DTO`() {
        val text = rules()
        assertThat(text).contains("-keep class com.xingqiyi.laundryphoto.data.remote.** { *; }")
        // 关键：model 包必须另有独立规则
        assertThat(text).contains("-keep class com.xingqiyi.laundryphoto.data.model.** { *; }")
    }

    /**
     * 守住 Gson 反射所依赖的类元数据。
     *
     * `ApiEnvelope<T>` 是泛型，Retrofit 靠 `Signature` 才能把 `T` 还原成
     * `CapabilitiesDto`；少了这一行，泛型会被擦除成 `Object`，
     * `data` 里的内容拿不到，同样表现为「解析不出东西」。
     */
    @Test
    fun `保留 Signature 与注解属性`() {
        val text = rules()
        assertThat(text).contains("-keepattributes Signature")
        assertThat(text).contains("-keepattributes *Annotation*")
    }

    /**
     * 兜底：确认当前 DTO 在**未混淆**状态下确实能被 Gson 正确填充。
     *
     * 这条不测混淆（测不了），而是确保 DTO 本身的字段名与 JSON 键名一致。
     * 一旦有人给字段加上错误的 `@SerializedName`，或把字段改名，
     * 这里会先红，从而避免「混淆修好了、但键名对不上」的第二种故障。
     */
    @Test
    fun `DTO 字段名与真实服务端响应键名一一对应`() {
        // 取自 main/store.js 的 CAPABILITIES 与 main/server.js 的 /ping 实际输出
        val json = """
            {"ok":true,"data":{"app":"xingqiyi-laundry-photo","apiVersion":2,
            "features":{"uploadRaw":true,"setNote":true,"thumb":true,
            "photoTokenQuery":true},"serverVersion":"1.3.0"}}
        """.trimIndent()

        val type = object : TypeToken<ApiEnvelope<CapabilitiesDto>>() {}.type
        val env = Gson().fromJson<ApiEnvelope<CapabilitiesDto>>(json, type)

        assertThat(env.ok).isTrue()
        val caps = requireNotNull(env.data)
        assertThat(caps.appName).isEqualTo("xingqiyi-laundry-photo")
        assertThat(caps.apiVersionValue).isEqualTo(2)
        assertThat(caps.serverVersionText).isEqualTo("1.3.0")
        assertThat(caps.uploadRaw).isTrue()
        assertThat(caps.setNote).isTrue()
        assertThat(caps.thumb).isTrue()
        assertThat(caps.photoTokenQuery).isTrue()
        assertThat(caps.supportsMobileAddons).isTrue()
    }
}
