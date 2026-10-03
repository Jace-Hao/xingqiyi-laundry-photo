# 拍照扫码（扫码 → 全屏连拍）

面向门店最高频的操作：把衣物吊牌上的条码/二维码扫出来，然后全屏连拍若干张存档照片。
本文说明**涉及的类、页面调用流程与关键实现逻辑**，并交代那些「不写下来就会被后来人改坏」的决策。

---

## 一、涉及的类

### 新增

| 类 | 位置 | 职责 |
|---|---|---|
| `BarcodeDecoder` | `camera/BarcodeDecoder.kt` | 纯 Java 的灰度图解码：旋转、裁剪、ZXing 解码。**不依赖 Android，可单测** |
| `BarcodeAnalyzer` | `camera/BarcodeAnalyzer.kt` | `ImageAnalysis.Analyzer`：取 Y 平面 → 交给 Decoder → 命中回调 |
| `CameraSession` | `camera/CameraSession.kt` | 一次相机绑定会话，**只解绑自己创建的 UseCase** |
| `CameraHost` | `camera/CameraHost.kt` | Compose 侧的相机基建：`PreviewView` 创建、生命周期绑定、点按对焦、4:3 选择器 |
| `ScanViewModel` | `ui/scan/ScanViewModel.kt` | 扫码状态机：命中 / 超时 / 重试轮次 |
| `ScannerOverlay` | `ui/scan/ScannerOverlay.kt` | 取景框绘制：遮罩 + 四角标记 + 扫描线 |
| `ScanScreen` | `ui/scan/ScanScreen.kt` | 扫码页：预览 + 提示 + 重试 + 手动输入兜底 |
| `BurstCaptureViewModel` | `ui/burst/BurstCaptureViewModel.kt` | 连拍：拍一张存一张、相册写入、失败重试、完成入队 |
| `BurstCaptureScreen` | `ui/burst/BurstCaptureScreen.kt` | 全屏连拍页 |
| `BurstPhotoStore` | `util/BurstPhotoStore.kt` | 存储路径、命名、系统相册写入（含版本分支）、路径安全化 |
| `CameraPermissionGate` | `ui/camera/CameraPermissionGate.kt` | 相机权限三段式状态与兜底引导（扫码页/连拍页/旧拍照页共用） |

### 修改

| 文件 | 改动 |
|---|---|
| `ui/MainActivity.kt` | 新增 `scan`、`burst/{barcode}` 两条路由；首页入参增加 `onScanCapture` |
| `ui/home/HomeScreen.kt` | 快捷入口改为按角色拼装后两两分行，拍照角色新增「扫码拍照」 |
| `ui/capture/CameraPreview.kt` | `unbindAll()` → `CameraSession`（修掉多相机页互踢的隐患） |
| `app/build.gradle.kts` | 新增 `com.google.zxing:core:3.5.3` |
| `app/proguard-rules.pro` | 新增 ZXing 全包 keep |
| `AndroidManifest.xml` | 新增 `WRITE_EXTERNAL_STORAGE`（`maxSdkVersion=28`，仅老版本写相册用） |

---

## 二、页面调用流程

```
首页「扫码拍照」
      │  navController.navigate("scan")
      ▼
ScanScreen ──权限不足──► CameraPermissionGate
      │                    ├─ 阶段二：再申请一次
      │                    └─ 阶段三（不再询问）：跳系统设置 + 「我已开启，重新检查」
      │
      │  CameraX: Preview + ImageAnalysis(BarcodeAnalyzer)
      │      每帧 → 取 Y 平面 → 旋转转正 → 居中裁剪 → ZXing 解码
      │
      ├─ 超过 12s 无结果 ──► 提示「还没识别到条码」+「重新识别」+「手动输入条码」
      │
      └─ 命中 ──► ScanViewModel.onDetected() ──► 停留 350ms 展示码值
                        │  navigate("burst/<urlEncoded barcode>")
                        ▼
              BurstCaptureScreen（全屏，仅保留返回 / 条码 / 已拍张数 / 快门 / 完成）
                        │
                        │  每次快门：takePhoto() → ImageUtil.processCapture（压缩+水印）
                        │            → 写入 files/photos/<条码>/ → shotCount++
                        │            → （可选）MediaStore 写入系统相册
                        │
                        └─ 「完成」/「上传并退出」
                                  → offlineRepository.enqueue(...) 逐张入队
                                  → SyncManager.enqueueImmediate() 触发补传
                                  → 回首页（首页显示待同步角标）
```

---

## 三、关键实现逻辑

### 1. 为什么用 ZXing 而不是 ML Kit

ML Kit 的 barcode-scanning 走 Google Play Services 动态下发模型，
而门店设备（国产平板、收银一体机）**普遍没有 GMS**。
装上去的表现不是报错，而是「扫任何码都没反应」——故障完全不可见，排查成本极高。
ZXing 是纯 Java，随 APK 打包离线可用，代价约 600KB，与 minSdk 26 的兼容面完全一致。

### 2. 只取 YUV 的 Y 平面

条码识别只需亮度，YUV_420_888 的 Y 平面就是全分辨率灰度图。
走 Y 平面省掉整帧 YUV→RGB 转换（1080p 每帧约 6MB 写入），这是千元机能否流畅的关键。
**注意必须按 `rowStride` 压实**：不同厂商的 stride 通常与 width 不等，
直接把 buffer 当数组读会得到错位图像，表现为「某些机型扫不出、某些能扫出」。

### 3. 旋转方向：为什么搞反也不要紧

按 `ImageProxy.imageInfo.rotationDegrees` 做顺时针转正。
好消息是 90° 与 270° 之间恰好相差 180°，而 180° 对解码是等价的：

- 一维码：逐行横向扫描，上下翻转不改变任何一行的横向内容；
  左右镜像已被 OneDReader 的 reversed 分支覆盖。
- 二维码：靠三个定位图案定方向，旋转无关。

真正**必须**处理的是 0/180 与 90/270 的区分：
该转 90 度时没转，条码在缓冲区里是竖直的，一维码彻底扫不出来。
这两条结论都有对应的单元测试背书（见 `BarcodeDecoderTest`）。

### 4. 相机为什么不能再用 `unbindAll()`

扫码页与连拍页共存于导航过渡期。若两侧都用 `provider.unbindAll()`，
旧页面 `onDispose` 时会把新页面刚绑好的相机一起解绑 → **跳过去黑屏**，
而这个 bug 只在真机导航时出现，单页调试永远复现不了。
因此每个 `CameraSession` 只 `unbind` 自己创建的那几个 UseCase。

### 5. 预览不变形

`PreviewView` 用 `FILL_CENTER`：等比放大到铺满后居中裁剪。
预览变形的唯一成因就是拉伸；`FIT_CENTER` 不拉伸但会留黑边，不符合「铺满屏幕」。
实现模式用 `COMPATIBLE`（TextureView）而非默认的 `PERFORMANCE`（SurfaceView）——
SurfaceView 不在普通 View 层级里合成，导航过渡期会穿透盖住上层 UI。

三个用例（Preview / ImageAnalysis / ImageCapture）统一使用
`AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY`，
避免比例不一致导致「预览里看到的」和「拍出来的」构图不同。
（不用已废弃的 `setTargetAspectRatio()`：它不带 fallback，不支持 4:3 的机型会直接绑定失败。）

### 6. 生命周期

| 场景 | 处理 |
|---|---|
| 切后台 / 息屏 | `ON_STOP` → `CameraSession.release()`，主动释放独占硬件 |
| 回到前台 / 点亮 | `ON_RESUME` → 重新绑定。不能只靠 `bindToLifecycle`：部分机型息屏后 surface 不自动恢复，会停在「预览黑屏但仍在分析」 |
| 页面退出 | `DisposableEffect.onDispose` → release |

### 7. 连拍为什么「拍一张立刻存一张」

现场是一手拎湿衣服、一手举手机连按快门，中途随时可能来客人、没电、被系统回收。
攒在内存里最后统一写盘，一旦出事就是**整批全丢**，而衣服已经进洗衣机没法重拍。
即时落盘把丢失半径压到「最多丢一张」。

上传则放在「完成」时统一入队——上传在弱网下单张要几秒，
每张都传会让快门变成「点一下卡三秒」，连拍体验彻底崩掉。

### 8. 存储路径与命名

```
存储路径：/data/data/<包名>/files/photos/<安全条码>/
命名规则：条码_第N张_YYYY-MM-DD_HHmmss.jpg
```

用的是**应用私有目录**，不需要任何存储权限，卸载即清除。
N 从该目录已有张数继续编号，同一件衣物分两批拍不会撞车也不会跳号。
命名与下载共用 `PhotoSaver.fileNameOf`，避免两处口径不一。

**是否写入系统相册**：默认否（开关在连拍页底部）。
照片是衣物存档凭证而非店员个人照片，散落到个人相册既无必要也有隐私风险。
开启后走 MediaStore，Android 10+ 用 `RELATIVE_PATH`（免权限），
Android 9 及以下用旧 `insertImage`（需 `WRITE_EXTERNAL_STORAGE`，Manifest 已限 `maxSdkVersion=28`）。

条码来自扫码识别，属于外部输入，拼目录名前必须过 `BurstPhotoStore.safeName()`，
否则一个内容为 `../../xxx` 的畸形二维码就能把照片写到私有目录之外。

### 9. 保存失败的异常处理

`persist()` 分别捕获 `OutOfMemoryError`、`SecurityException`、`IOException` 与其它 `Throwable`，
给出**可据此行动**的文案（如「存储空间不足」而不是「保存失败」），
并保留原图路径供「重试」按钮使用。
写入相册失败属于**可降级失败**：照片本身已安全落盘，只提示一次，不阻断连拍。

### 10. 为什么「保存失败」不能被静默

照片是唯一凭证。任何静默失败都会让店员以为拍好了，
等客户来取衣服时才发现没有照片——那时已经无法补救。

---

## 四、测试

`BarcodeDecoderTest`（12 例）：用 ZXing 的 Writer 先画出条码，
再走完整「旋转 → 裁剪 → 解码」闭环；含 180° 等价性、90/270 可逆性、
一维码旋转 90° 必然解不出（证明必须转正）、空画面返回 null 不抛异常。

`BurstPhotoStoreTest`（6 例）：路径穿越字符被替换、空条码兜底、超长截断。

`ProguardKeepRuleTest`：新增 ZXing keep 规则断言。

---

## 五、发布前自检（release 包必做）

参照 v1.3.1 的 R8 事故教训：**混淆包才暴露的问题，单测和 `assembleRelease` 都不会报错**。
ZXing 被剥离的表现不是崩溃，而是「扫任何码都没反应、日志里一条异常都没有」。

```bash
# 1. mapping 里应能看到 ZXing 的类（被整体删除则一条都搜不到）
grep -c "com.google.zxing" app/build/outputs/mapping/release/mapping.txt

# 2. dex 里应能看到解码器核心类
dexdump -d classes.dex | grep -c "MultiFormatReader\|BarcodeFormat"
```
