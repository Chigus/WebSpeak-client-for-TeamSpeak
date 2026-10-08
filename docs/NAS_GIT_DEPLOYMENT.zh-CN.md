# 从 Git 发布到澳门 NAS

所有应用和发布脚本的修改都保存在用户 fork 的 Git 分支中，先提交，再构建。
`origin` 指向用户 fork，`upstream` 指向原项目；脚本读取实际 remote，不固定账户名。
维护分支目前为 `nas/macau`。双声道的历史起点是
`24304f2d8ec4ecaa2962042dcd7b39a4bbab6851`，发布和更新都要求保留这一提交。

## NAS 目录与依赖

默认应用目录为 `/share/CACHEDEV1_DATA/DockerData/webspeak`：

```text
webspeak/
  repo/                 # 真实 Git checkout；这里只保存源码和无秘密的维护文件
  compose.yaml          # 实际运行配置，不提交到 Git
  current-release      # 最近一次成功发布目录的路径
  data/                 # 数据库和加密密钥
  tls/                  # HTTPS 证书与私钥
  tls-sync/             # 证书同步状态与密钥
  config/               # nginx 等实际配置
  docker-config/        # Docker 配置与 registry 凭据
  releases/             # 每次发布的源码、镜像记录、配置备份和日志
  tools/git             # 可选的 NAS Git 包装程序，保留在仓库外
  bin/docker-compose    # 现有 Compose v2
```

NAS 需要 POSIX `sh`、Git、Docker、Compose v2（支持 `config --format json`），以及
`tar`、`gzip`、`sha256sum`、`awk`、`grep`、`cmp`、`readlink -f` 等常规系统工具。NAS 不需要安装
Node.js、npm、Python 或编译器；这些依赖由项目 Dockerfile 在 Linux 构建阶段提供。

默认优先使用 `APP/tools/git`，不存在时使用 PATH 中的 `git`。也可以通过环境变量
`GIT`、`DOCKER`、`COMPOSE` 指定可执行文件或包装程序的路径。每个变量只接受一个
可执行文件路径，不接受带空格分隔参数的命令字符串。Git 包装程序必须保留 `-C`、
`-c` 等 Git 参数和二进制标准输出，不能分配 TTY，尤其不能破坏 `git archive`。
包装程序、登录凭据及注册表配置不复制进项目仓库或源码下载包。
发布预检只解析证书目录的实际路径，不进入目录或读取私钥；无需放宽现有证书权限。

## 初次接入已有部署

先在开发 checkout 提交双声道、页面和部署流程的全部修改并完成验证，再正常推送
到 fork 的维护分支。在 NAS 的干净 clone 中拉取该分支并设置同名 tracking branch；
不要使用 `reset --hard` 覆盖本地改动。例如，分支尚未建立时：

```sh
APP=/share/CACHEDEV1_DATA/DockerData/webspeak
GIT="$APP/tools/git"
"$GIT" -C "$APP/repo" fetch origin nas/macau
"$GIT" -C "$APP/repo" switch --create nas/macau --track origin/nas/macau
```

已有同名本地分支时先检查它的状态和历史，再切换；不要重复创建或强制重置。
`data`、`tls`、`config`、`docker-config` 与现有 `compose.yaml` 应保持原位置。
发布器要求现有 WebSpeak 容器正在运行，以便保存其实际镜像并执行可验证的回退。

## 发布一个明确的 commit

```sh
APP=/share/CACHEDEV1_DATA/DockerData/webspeak
COMMIT=$("$APP/tools/git" -C "$APP/repo" rev-parse HEAD)
sh "$APP/repo/scripts/nas/release.sh" --commit "$COMMIT"
```

`--commit` 必须是完整的小写 SHA，且等于干净 `APP/repo` 的 HEAD。暂存、未暂存或
未跟踪改动都会让发布停止；被 Git 忽略的依赖和本地构建产物不会进入归档。
可用 `--app` 指定另一个已有应用目录，用 `--health-timeout 180` 调整健康等待时间
（3 至 600 秒，以实际时间计；单次 Docker 调用本身仍由 Docker 返回）。为避免路径在 shell/Docker 中产生歧义，自定义应用目录只接受
ASCII 字母、数字、空格、点、斜线、下划线和连字符。

发布器依次执行：

1. 取得独占发布锁，检查 HEAD、工作区和双声道历史；拒绝归档中的符号链接、
   submodule、运行目录、常见凭据文件与编译产物。
2. 用一次 `git archive` 导出选定 commit。构建目录和 AGPL 源码下载由这个相同的
   tar 生成；之后构建不会读取仍可能被编辑的开发工作区。
3. 使用原项目 Dockerfile 完整构建 Linux 镜像。构建阶段运行 `npm run verify`
   （测试、后端 tsc、前端 vue-tsc/Vite），通过后才 prune 开发依赖。
4. 使用独立的最小 Docker context 增加源码下载文件，输出
   `webspeak-local:git-<完整SHA>`。该层只复制源码包；不会复制 NAS 运行配置。
5. 在新镜像中执行真实 Opus 编解码检查：600 Hz 左声道、1200 Hz 右声道，40 个
   20 ms 包，要求双声道标志和两侧大于 25 dB 的分离度。此检查不调用麦克风，
   不播放声音，也不向真实 TeamSpeak 频道发送测试音。
6. 保存当前 Compose 原件、解析后的配置及实际旧 image ID，为旧 image ID 建立
   本次专用 rollback tag；验证候选配置和回退配置都只改变 `webspeak.image`。
7. 原子替换运行配置，执行
   `up -d --no-deps --no-build --pull never webspeak`。核对新容器的实际 image ID
   和健康状态；失败、HUP、INT 或 TERM 会尝试恢复旧镜像并再次核对健康。

项目名固定为 `webspeak`，所有 Compose 操作都保留 `--project-directory APP`，
因此放在 `releases` 中的备份不会改变相对挂载路径的基准。运行配置会由 Compose
规范化为 YAML；实际参数可能被展开，所以这些文件和日志以私有权限保存在仓库外。
原始 Compose 文本另有备份。现有数据挂载、HTTPS 容器和原生 TeamSpeak 不随应用
更新重启。发布期间不清理旧镜像、回退 tag 或旧发布目录。

每个发布目录保存 `status`、`release.json`、`image-id`、`previous-image-id`、
`source.sha256`、构建/部署日志、`stereo-check.json`、`compose-check.json` 和配置备份。
镜像标签说明源码 commit，发布记录中的 image ID 标识实际构建结果；原 Dockerfile
的基础镜像 tag 和依赖下载过程仍可能变化，不宣称不同日期的构建逐字节相同。

## 从 fork 更新

```sh
sh /share/CACHEDEV1_DATA/DockerData/webspeak/repo/scripts/nas/update.sh
```

更新器只接受干净且跟踪 `origin/<同名分支>` 的 checkout。它 fetch 该分支，检查
本地 HEAD 能快进到新 commit、双声道历史仍在，然后 `merge --ff-only`，最后执行
新 commit 中的发布脚本。分叉、脏工作区、错误的 tracking remote 或被改写的历史
都会停止更新，线上容器保持当前版本。它不会自动提交、推送或合并 upstream。

构建失败时 checkout 可能已前进到待发布 commit；线上版本仍以容器 image ID 和
`current-release` 为准。修正问题并提交后重新发布，不通过 reset 丢弃失败现场。

上游更新应在开发 checkout 的候选分支处理：从维护分支建立集成分支，fetch
`upstream` 后合并需要的 commit/分支，解决冲突并运行完整验证，特别是双声道
采集、编码和播放测试；审核后正常合入并推送维护分支，再让 NAS 更新。

## 长任务、回退与公网验收

长构建可通过已有 SSH 保活会话运行，也可在 NAS 使用 `nohup` 并把输出重定向到
仓库外的日志。先完成 Git 认证配置；后台任务不能回答交互式密码问题。
保活只维持连接，发布是否完成以日志和 `status` 为准。

锁目录是 `APP/.git-release-lock`，其中记录 PID。脚本只释放自己创建的锁。
断电或 `kill -9` 无法运行 shell 的清理逻辑；重试前核对记录的进程、当前容器和
发布状态，再人工清理确实已失效的锁，不能盲目删除仍在使用的锁。

自动回退会恢复 `compose.rollback.yaml`，其中的专用 tag 固定指向发布前的实际
image ID。手动回退也应使用这份配置，而不是依赖可能漂移的原 tag；始终保留
`--project-directory APP` 并只更新 `webspeak`。回退失败时 `status` 会明确记录
`rollback-failed`，保留所有配置和镜像供处理。
自动回退的范围是应用镜像与 Compose 配置，不回滚 SQLite 数据或 `APP/config`
文件；涉及数据迁移的更新需要单独安排兼容性验证和数据备份。

容器 healthy 只证明本地 HTTP 健康端点通过。成功发布后还要从外部验证：

- `https://1.narcissu1.top:5555` 的页面、HTTPS 和 WSS。
- `/source/webspeak-stereo-source.tar.gz` 可下载，其 SHA256 与发布记录一致。
- 实际 TeamSpeak 连接和左右独立音频；物理人头麦/DAW 跳线的验证另行记录。

源码包包含修改后的应用、测试、锁文件、许可证和发布脚本。它不包含运行数据、
私钥或 `node_modules`；构建仍需按锁文件和固定 SDK commit 获取第三方依赖。
保持该下载对应当前线上 commit，不用上游原版源码代替本 fork 的对应源码。
