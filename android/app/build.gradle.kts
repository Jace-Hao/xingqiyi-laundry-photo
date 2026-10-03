plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.kapt")
}

android {
    namespace = "com.xingqiyi.laundryphoto"
    // compileSdk 34：Material3 1.2 与 CameraX 1.3 均要求 33+，34 为当前稳定基线
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xingqiyi.laundryphoto"
        // minSdk 26（Android 8.0）：
        // - CameraX 1.3 要求 21+，WorkManager 要求 14+，ROOM 要求 16+；
        // - 26 起原生支持 DataStore/字体资源与自适应图标，且覆盖绝大多数在用收银/拍照设备；
        // - 通知渠道（8.0 引入）是离线补传与强制更新提示的基础，低于 26 需额外兼容分支。
        minSdk = 26
        targetSdk = 34
        // v1.4.0：新增「拍照扫码」（扫码 → 全屏连拍）
        versionCode = 10400
        versionName = "1.4.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        // 发布签名：密钥库路径与口令从 local.properties / 环境变量读取，
        // 仓库内不保存任何密钥（*.jks 已被 .gitignore 排除）。
        // 未配置时 release 会退回调试签名，保证 `./gradlew assembleRelease` 在任何机器上都能出包。
        val storeFilePath = (project.findProperty("RELEASE_STORE_FILE") as String?)
            ?: System.getenv("RELEASE_STORE_FILE")
        val storePwd = (project.findProperty("RELEASE_STORE_PASSWORD") as String?)
            ?: System.getenv("RELEASE_STORE_PASSWORD")
        val aliasName = (project.findProperty("RELEASE_KEY_ALIAS") as String?)
            ?: System.getenv("RELEASE_KEY_ALIAS")
        val keyPwd = (project.findProperty("RELEASE_KEY_PASSWORD") as String?)
            ?: System.getenv("RELEASE_KEY_PASSWORD")

        if (storeFilePath != null && storePwd != null && aliasName != null && keyPwd != null) {
            create("release") {
                storeFile = file(storeFilePath)
                storePassword = storePwd
                keyAlias = aliasName
                keyPassword = keyPwd
            }
        }
    }

    buildTypes {
        debug {
            // 包名后缀便于与桌面端/正式版共存安装测试
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        // Compose 编译器需要开启的部分
        freeCompilerArgs += listOf(
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
            "-opt-in=androidx.compose.foundation.ExperimentalFoundationApi"
        )
    }

    buildFeatures {
        compose = true
        // AGP 8 起 BuildConfig 默认不再生成：项目在 AppContainer（ApiClient debug 开关）、
        // MainActivity 与 SettingsScreen 里读取 VERSION_NAME / DEBUG，必须显式开启。
        buildConfig = true
    }

    composeOptions {
        // 与 Kotlin 1.9.24 配套的 Compose 编译器版本
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            // okhttp/retrofit 与部分 androidx 库携带重复的许可证文件，排除避免打包冲突
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "/META-INF/LICENSE.txt"
            excludes += "/META-INF/NOTICE.txt"
        }
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    // ---------- AndroidX 基础 ----------
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.3")
    // 提供 LocalLifecycleOwner / collectAsStateWithLifecycle：CameraPreview 用它把相机生命周期
    // 绑定到页面，避免旋转或退出时相机被占用（黑屏）。lifecycle-runtime-ktx 不含该 composable。
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.3")
    implementation("androidx.lifecycle:lifecycle-process:2.8.3")
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // ---------- Compose / Material3 ----------
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material3:material3-window-size-class")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // ---------- 相机（CameraX） ----------
    implementation("androidx.camera:camera-core:1.3.3")
    implementation("androidx.camera:camera-camera2:1.3.3")
    implementation("androidx.camera:camera-lifecycle:1.3.3")
    implementation("androidx.camera:camera-view:1.3.3")

    // ---------- 网络 ----------
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.google.code.gson:gson:2.11.0")

    // ---------- 扫码 ----------
    // 选 ZXing 而非 ML Kit 的理由（关键，改动前请先读 BarcodeDecoder 的类注释）：
    // ML Kit 的 barcode-scanning 依赖 Google Play Services 动态下发模型，
    // 而本系统的门店设备大量是无 GMS 的国产平板/收银机，装上去识别直接不可用且不报错。
    // ZXing 是纯 Java，随 APK 打包离线可用，代价仅约 600KB。
    implementation("com.google.zxing:core:3.5.3")

    // ---------- 图片加载 / EXIF ----------
    implementation("io.coil-kt:coil-compose:2.6.0")
    implementation("androidx.exifinterface:exifinterface:1.3.7")

    // ---------- 本地存储 ----------
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // ---------- 后台任务 ----------
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // ---------- 协程 ----------
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")

    // ---------- 测试 ----------
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("androidx.arch.core:core-testing:2.2.0")
    testImplementation("com.google.truth:truth:1.4.4")
    testImplementation("org.mockito.kotlin:mockito-kotlin:5.3.1")
    testImplementation("org.robolectric:robolectric:4.12.2")

    androidTestImplementation(platform("androidx.compose:compose-bom:2024.06.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.1.6")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
