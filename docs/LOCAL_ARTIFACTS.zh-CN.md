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
| `data/`、`config.json`、`.env`、日志 | 运行数据和本机设置 | 延续既有忽略规则；按部署备份策略保管，不能当作可删除的构建缓存 |

检查规则时，用 `git check-ignore` 确认构建产物被忽略，同时确认 `src/shared/`、平台启动源码、Android Java 文件、Gradle wrapper 和皮肤资源仍可跟踪。新增文件若是构建必需输入，应随源码声明；构建不得依赖上述历史发布包或实验脚本。

未来需要清理磁盘时，先核对产物的来源、是否可重新生成及保留位置，再选择具体文件。未跟踪或已忽略状态本身不是删除依据。
