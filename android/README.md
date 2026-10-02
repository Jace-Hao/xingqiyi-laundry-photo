# 星期衣精致洗衣 · 衣物照片系统（Android 移动端）

桌面端（Electron + Vue 3）的移动伴侣 App。把店员的**拍照录入、订单查询、日志/用户管理、离线补传**
搬到手机上，复用同一套后端 HTTP 接口与权限模型，店员拿手机即可在店内移动作业。

> 仓库根目录下的 `README.md` 是桌面端文档；本文件专指 `android/` 下的移动端工程。

---

## 1. 技术栈

| 关注点 | 选型 | 说明 |
|---|---|---|
| 语言 / UI | Kotlin + Jetpack Compose (Material3) | 声明式、触控优先，与桌面端 Vue 组件化思路一致 |
| 架构 | 单 Activity + NavHost + 手写 DI 容器 | 无 Hilt，依赖图单层，便于阅读 |
| 网络 | Retrofit2 + OkHttp | 令牌拦截器统一注入连接码/会话令牌 |
| 本地存储 | Room（离线队列）+ DataStore（偏好/会话） | 离线照片落本机，联网后 WorkManager 补传 |
| 相机 | CameraX | 点击对焦 + 水印，兼容各厂商机型 |
| 图片 | Coil + ExifInterface | 网格缩略图、详情大图缩放 |
| 后台 | WorkManager | 离线照片补传（一次性 + 15 分钟周期兜底） |
| 安全 | AndroidKeyStore AES-GCM | 记住的密码仅以密文落本机 |

- **最低版本**：`minSdk 26`（Android 8.0）——覆盖绝大多数在用收银/拍照设备，且通知渠道、DataStore 等原生可用。
- **目标/编译版本**：`compileSdk / targetSdk 34`。
- **版本号**：`versionCode 10300 / versionName 1.3.0`（与桌面端新增接口版本对齐）。

---

## 2. 环境要求

| 工具 | 版本 |
|---|---|
| Android Studio | Hedgehog (2023.1) 或更高 |
| JDK | 17（Gradle 8.7 要求；Android Studio 自带） |
| Gradle | 8.7（已随 `gradle-wrapper.jar` 锁定，无需单独安装） |
| 设备/模拟器 | Android 8.0+，需摄像头（拍照角色）；联网访问桌面端服务器 |

本工程已包含 `gradle-wrapper.jar`，直接用 `./gradlew` 即可，无需本机安装 Gradle。
（若 `gradle-wrapper.jar` 缺失，在已装 Gradle 的环境执行 `gradle wrapper --gradle-version 8.7` 重新生成。）

---

## 3. 构建与运行

### 方式一：Android Studio（推荐）
1. `File → Open` 选择本 `android/` 目录。
2. 等待 Gradle Sync 完成（首次会下载依赖，耗时取决于网络）。
3. 连接手机（开启 USB 调试）或启动模拟器。
4. `Run → Run 'app'`（或 Shift+F10）。Debug 包 `applicationId` 带 `.debug` 后缀，可与正式版/桌面端共存安装。

### 方式二：命令行
```bash
# 调试包
./gradlew assembleDebug
# 安装到已连接设备
./gradlew installDebug
# 跑单元测试
./gradlew testDebugUnitTest
# 跑插桩测试（需连接设备或模拟器）
./gradlew connectedAndroidTest
```

### 打包发布
```bash
./gradlew assembleRelease
```
Release 开启 R8 混淆（ProGuard 规则已在 `proguard-rules.pro` 备好，保留 Gson/Room/OkHttp/Worker）。
签名信息请在 `local.properties` 配置（**不要写进版本库**）：
```properties
RELEASE_STORE_FILE=/path/to/keystore.jks
RELEASE_STORE_PASSWORD=***
RELEASE_KEY_ALIAS=***
RELEASE_KEY_PASSWORD=***
```
并在 `app/build.gradle.kts` 的 `signingConfigs` 中读取（当前为占位，按需启用）。

---

## 4. 连接到桌面端服务器

移动端与桌面端是**同一后端**的两个前端。首次打开 App 需填写：

- **服务器地址**：桌面端电脑的局域网地址，形如 `http://192.168.1.10:17521`
  （端口为桌面端设置中的 HTTP 端口，默认 17521）。
- **连接码（api-token）**：桌面端「系统设置」中查看的连接码。
- **账号 / 密码**：桌面端已有的账号，权限由角色决定。

> 手机与桌面端必须在**同一局域网**（或通过组网/VPN 互通）。服务端是纯 HTTP，
> 因此 App 的 `AndroidManifest` 已声明 `usesCleartextTraffic="true"`。
> 若生产环境要求 HTTPS，请在服务端前置反代并将该值改回 `false`。

**桌面端版本要求**：移动端 v1.3.0 新增了三个接口（`POST /upload` 原始二进制上传、
`records/addByFile`、`records/setNote`、`system/capabilities`）。
- 服务端 ≥ v1.3.0：走原始上传通道，弱网更省流量；支持移动端改备注。
- 老服务端：移动端**自动降级**为 base64 上传、隐藏「改备注」入口，其余功能不受影响。

---

## 5. 功能与角色映射

| 角色 | 拍照录入 | 订单查询 | 本店/全部日志 | 用户管理 | 系统设置 |
|---|:---:|:---:|:---:|:---:|:---:|
| 系统管理员 sysadmin | ✅ | ✅ | 全部 | ✅ | 只读展示 |
| 门店管理员 storeadmin | ❌ | ✅ | 本店 | ❌ | 只读展示 |
| 拍照账号 capture | ✅ | ✅ | ❌ | ❌ | 只读展示 |
| 查询账号 query | ❌ | ✅ | ❌ | ❌ | 只读展示 |

- 首页按角色裁剪快捷入口；底部导航同样按角色显示「拍照/日志」等项。
- **唯一登录**：同一账号不能同时在线多台设备，在其他设备登录会把本机顶下线，
  此时 App 会强制退回登录页并弹通知（与服务端 `revoked` 机制一致）。

---

## 6. 移动端特有问题处理

- **离线 / 弱网**：服务器不可达时，拍照结果先落本机（Room 离线队列），
  并立即/周期性（15 分钟）由 WorkManager 补传；失败分类处理——
  网络错误重试、业务错误（条码非法等）标记失败等人处理、被顶下线则停整轮并通知。
- **权限**：相机、通知按需申请，被永久拒绝时引导去系统设置；查询角色不触发相机申请。
- **深色模式**：跟随系统 / 浅色 / 深色 三档，Android 12+ 启用 Material You 动态取色。
- **文件分享**：照片经 `FileProvider` 以 `content://` 分享给微信/相册，**不申请任何存储权限**。
- **缩略图/画质**：设置页可下调缩略图宽度与上传质量以适配弱网。

---

## 7. 测试

### 单元测试（纯 JVM，无需设备）
覆盖与桌面端判定口径严格一致的纯逻辑模块：
- `BarcodeUtilTest`：条码误读预警、相似条码、格式画像、近形修复。
- `RoleTest`：角色权限矩阵、未知角色降级。
- `SessionMonitorTest`：被顶下线的全局广播语义。

运行：`./gradlew testDebugUnitTest`（或 Android Studio 右键 `app/src/test` → Run）。

### 手动验证清单
1. 同一局域网填写服务器地址 + 连接码 + 账号密码，登录成功。
2. 拍照账号：扫码/手输条码 → 拍摄 → 确认保存；断网时保存提示「已存本机，联网后自动上传」。
3. 查询账号：搜索/筛选条码、日期，点开查看大图、改备注、批量改码/删除。
4. 系统管理员：用户管理增删改、操作日志按账号/操作/日期筛选、数据总览。
5. 杀掉 App 或重启手机后，离线队列仍能补传成功。
6. 在另一台设备登录同一账号，本机被顶下线并收到通知。
7. 设置页切换深色模式、调小缩略图宽度后网格明显变省流量。

---

## 8. 工程结构速览

```
android/
├── build.gradle.kts / settings.gradle.kts / gradle.properties   # 工程与依赖
├── gradle/wrapper/                                              # Gradle 8.7 包装
└── app/
    ├── build.gradle.kts                                         # 模块依赖、签名、混淆
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml
        │   ├── java/com/xingqiyi/laundryphoto/
        │   │   ├── LaundryApp.kt            # Application 入口（持有 DI 容器、建通知渠道）
        │   │   ├── ui/MainActivity.kt       # 导航中枢：启动图、会话恢复、被顶下线、底部导航
        │   │   ├── ui/(login|home|capture|query|detail|logs|users|overview|settings)/
        │   │   ├── ui/theme|components|base # 主题、通用组件、ViewModel 基类
        │   │   ├── data/(model|remote|local|pref|repository)  # 模型/接口/缓存/偏好/仓库
        │   │   ├── sync/                  # WorkManager 补传 + 通知
        │   │   ├── di/AppContainer.kt      # 手写依赖容器
        │   │   └── util/                  # 条码纠错、图片水印、时间、加密、分享
        │   └── res/                       # 图标、字符串、主题、FileProvider 路径
        └── test/                          # 单元测试
```

---

## 9. 常见问题

- **连接失败 / 连接码无效**：确认地址带 `http://` 与端口、手机与电脑同一网段；
  连接码与桌面端「系统设置」中显示的一致。
- **登录后被立刻踢出**：账号已在别的设备登录（唯一登录）。先退出其他设备再登录。
- **拍照黑屏**：退出页面再进（相机已释放）；或检查相机权限。
- **同步一直失败**：查看「设置 → 离线照片队列」中的失败项，多半是条码非法/无权限，
  需联网后在桌面端核对；必要时「放弃未同步」清理本机副本。

完整能力集由 `system/capabilities` 返回，App 据此决定走原始上传还是 base64 降级。

---

## 10. 已验证的构建环境（2026-10-02 实测通过）

本项目已在下列环境**实际编译并签名出包**，`assembleDebug` / `assembleRelease` / `testDebugUnitTest` 均通过：

| 组件 | 版本 | 说明 |
|---|---|---|
| JDK | Microsoft Build of OpenJDK 17.0.20.1 | AGP 8.5 要求 JDK 17+ |
| Gradle | 8.7（binary） | 与 `gradle-wrapper.properties` 一致 |
| Android SDK Platform | android-34 | compileSdk / targetSdk 34 |
| Build Tools | 34.0.0 | |
| AGP / Kotlin / Compose 编译器 | 8.5.2 / 1.9.24 / 1.5.14 | |

### 中文路径编译（重要）

项目根目录含中文（`星期衣精致洗衣衣物照片系统`），AGP 默认拒绝在非 ASCII 路径下构建。
已在 `gradle.properties` 中加入：

```properties
android.overridePathCheck=true
```

若在纯英文路径下构建，可去掉该行。

> **注意：`testDebugUnitTest` 仍必须在纯英文路径下运行。**
> `android.overridePathCheck=true` 只解决 AGP 的路径校验，**不解决 Gradle 测试 JVM 的类加载问题**：
> 在中文路径下测试类能编译通过（`compileDebugUnitTestKotlin` 成功），
> 但 `testDebugUnitTest` 会报 `ClassNotFoundException: ...Test`——测试类已生成却加载不到。
> 这是 Gradle/Windows 上已知的非 ASCII 路径缺陷，与代码质量无关。
>
> 验证方式：把工程复制到纯英文路径再跑测试即可。
>
> ```bash
> # 例如复制到 C:\build\xqy-android 后
> gradle testDebugUnitTest      # 14 个用例全部通过
> ```
>
> `assembleDebug` / `assembleRelease` / `lint` 在中文路径下均正常，无需额外处理。

### 发布签名

密钥库**不入仓库**（`*.jks` 已被 `.gitignore` 排除）。构建 release 包时通过环境变量或
`local.properties` 提供以下四项，未配置时自动退回调试签名（保证任何机器都能出包）：

```bash
export RELEASE_STORE_FILE=/path/to/release.jks
export RELEASE_STORE_PASSWORD=***
export RELEASE_KEY_ALIAS=***
export RELEASE_KEY_PASSWORD=***
./gradlew assembleRelease
```

生成密钥库示例：

```bash
keytool -genkeypair -v -keystore release.jks -storetype PKCS12 \
  -alias xingqiyi -keyalg RSA -keysize 2048 -validity 10000
```

### 产物

| 构建类型 | 体积 | 说明 |
|---|---|---|
| `assembleDebug` | ~20 MB | 包名带 `.debug` 后缀，可与正式版共存；用 Android 调试证书签名 |
| `assembleRelease` | ~2.8 MB | 开启 R8 混淆 + 资源压缩，已用正式密钥签名，可直接分发安装 |

### 已知编译告警（不影响构建）

- `CaptureViewModel`：`smart cast` 相关的可空性提示；
- `QueryScreen`：`canDelete` 参数暂未在 UI 中使用（删除走多选批量的服务端权限校验）；
- `SettingsScreen`：`Icons.Default.Logout` 已废弃，建议改用 AutoMirrored 版本；
- `ImageUtil`：一处多余的 Elvis 运算符。
