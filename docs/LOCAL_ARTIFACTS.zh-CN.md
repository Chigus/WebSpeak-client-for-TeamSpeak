# WebSpeak 本地产物与源码边界

源码、依赖锁文件、构建脚本、Android 原生工程和必要的皮肤资源纳入版本管理。运行数据和可再生成的产物留在本地，按以下规则处理；本次整理没有删除、移动或覆盖既有发布包与参考素材。

| 路径 | 用途 | 处理方式 |
| --- | --- | --- |
| `src/`、`web/src/`、`mobile/` 中的入口及打包脚本 | 服务端、网页和 Android 实现 | 跟踪源码；各自依赖和锁文件明确保留 |
| `web/android/` | Android 原生工程 | 跟踪原生源码、Gradle 配置与 wrapper；忽略缓存、生成资产和本机 SDK 路径；整个目录不进入服务端 Docker 构建上下文 |
| 各级 `node_modules/`、`dist/` | 安装依赖和构建输出 | 忽略 Git；Docker 重新安装并构建；Android 资产由 `npm run android:sync` 生成 |
| `release-artifacts/` | 历史 Windows、Linux 发布包及校验和 | 本地保留，忽略 Git 和 Docker；正式发布使用发布工作流的产物 |
| 根目录 `webspeak-deploy*.tar.gz`、`webspeak-update*.tar.gz` | 历史部署与更新包 | 本地保留，按项目专用名称忽略，不使用忽略全部压缩包的 Git 规则 |
| 根目录 `teamspeak6-server-linux-amd64.tar.xz` | 下载的 TeamSpeak 服务端归档 | 本地保留，忽略 Git 和 Docker |
| `界面参考/stitch_teamspeak_web_interface.zip` | 界面参考归档 | 本地保留并忽略 Git；参考素材不进入服务端 Docker 上下文 |
| `.local-opus-hook.cjs` | 用原样缓冲区替代编解码的实验脚本 | 本地保留，忽略 Git 和 Docker；不接入正式启动、构建及媒体验收 |
| `data/`、`config.json`、`.env`、日志 | 运行数据和本机设置 | 按部署备份策略保管，不能当作可删除的构建缓存；Docker 上下文显式排除 `.env` 及 `.env.*`，避免本地环境文件进入构建阶段 |

检查规则时，用 `git check-ignore` 确认构建产物被忽略，同时确认 `src/shared/`、平台启动源码、Android Java 文件、Gradle wrapper 和皮肤资源仍可跟踪。新增文件若是构建必需输入，应随源码声明；构建不得依赖上述历史发布包或实验脚本。

未来需要清理磁盘时，先核对产物的来源、是否可重新生成及保留位置，再选择具体文件。未跟踪或已忽略状态本身不是删除依据。

## 2026-10-01 干净构建记录（09-A）

构建输入为提交 `662dad36fc4d8cf9f35268a99b8221851f6fc52c`，应用版本 `0.2.5-preview`。本轮没有创建版本标签或发布正式 Release。

[手动发布构建 36857782727](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/actions/runs/36857782727) 的测试、Docker、Windows x64、Linux x64 四个作业全部成功；正式发布步骤按分支条件跳过。服务器构建使用工作流指定的 Node.js 22.22.2，Docker 使用 Dockerfile 声明的 Node.js 22 镜像。各平台重新检出源码、安装依赖、构建锁定的 SDK，再编译和打包；Windows 和 Linux 包均包含 Node.js 运行时，并在独立临时目录通过 HTTP 健康状态及版本检查。Docker 镜像也通过 HTTP 健康检查。这些结果不证明真实语音和屏幕共享可用，也不表示产物逐字节可重现。

| Actions 产物 | 归档字节数 | Actions 报告的 SHA-256 |
| --- | ---: | --- |
| windows-x64 | 52,431,874 | `790e2d712060b1254498641590c9aed05c065eec416797c4280140531e78ee05` |
| linux-x64 | 59,322,525 | `892aaa190f8d138917ef5775dbf05b620abc2033fbc5089821eb8bda15c99e9c` |

上表摘要属于 Actions 外层产物归档，不是其中部署包的摘要；当前证据来自 Actions API，不能写成已在本机复算。对应部署包由工作流生成，版本和启动结果已由平台作业检查。

Android 使用同一提交的 `git archive` 源码归档，在新目录安装根、web、mobile 三套锁定依赖并重建 SDK，没有复制当前工作区的 node_modules 或历史发布包。构建主机为 Windows x64，Node.js 24.12.0、Android Studio JDK 25.0.2、Gradle 9.5.0、Android SDK 36；依次执行依赖安装、`prepare:sdk`、`android:sync`、`assembleDebug --no-daemon`。短路径目录 `<USER_HOME>/.codex/tmp/ws09a-662dad3` 构建成功，134 个 Gradle 任务全部执行。

| Android 调试产物 | 字节数 | 本机复算 SHA-256 |
| --- | ---: | --- |
| app-arm64-v8a-debug.apk | 76,289,469 | `7bd977906397ab467655862e1182b1021d6d0b2f255aebcae644eaf5db201006` |
| app-armeabi-v7a-debug.apk | 72,062,619 | `a28471b248e944d01c1e72d1066711aafe7dda6524ad1736becfb4d436a064a8` |
| app-x86_64-debug.apk | 80,901,292 | `853a82786d1733686329568661954642c60482fd9ad3e7b910856b050d157532` |

APK 位于上述目录的 `web/android/app/build/outputs/apk/debug`。逐包检查了移动网关入口、TeamSpeak SDK、Opus WASM、网页和匹配 ABI 的 Node.js 原生库；未发现项目私有配置或实验 Opus 脚本。arm64 包的清单版本为 `0.2.5-preview` / code `25`，最低 SDK 24、目标 SDK 36。构建当日尚未安装新包；后续 x86_64 安装与启动结果见下节，Android 布局和真机媒体仍待验收。

本轮发现并处理两处构建边界问题：`.dockerignore` 补充排除本地 `.env` 与 `.env.*`；Android 深层临时目录触发 CMake 250 字符对象路径警告及 Ninja 建目录失败，同源码在短路径重建通过，已将该主机构建约束补入移动文档。没有为此更改应用或原生插件逻辑。Windows 首次 npm ci 约耗时三分钟，随后构建、打包和启动均正常。

## 2026-10-02 Android 安装与冷启动（09-A）

安装对象为上表同一 `662dad3` 的 x86_64 APK，安装前复算 SHA-256 与记录一致。使用已有 `ws` AVD 的只读 Android 15 / x86_64 实例，启动参数包含 `-read-only -no-snapshot-save -no-window -no-audio -port 5580`，没有修改原 AVD 数据或保存新快照。

`adb -s emulator-5580 install -r <APK>` 返回 `Success`；包管理器报告 `versionName=0.2.5-preview`、`versionCode=25`、最低 SDK 24、目标 SDK 36。强制停止后启动 `io.webspeak.client/.MainActivity` 返回 `Status: ok`、`LaunchState: COLD`，启动耗时 1,822 毫秒。

通过临时 ADB 转发 `tcp:53040` → 设备 `tcp:3040`，实际内嵌网关 `/health` 返回 `status: ok`、`engine: webspeak-android`；`/api/public-config` 返回 `version: 0.2.5-preview`、`mobile: true`、`initialized: true`。这补齐该干净构建产物的安装、冷启动及 HTTP 网关证据；没有交互式检查 Android WebView 布局、触屏或真实媒体，不能据此关闭这些待办。验收后移除端口转发并关闭该只读模拟器。
