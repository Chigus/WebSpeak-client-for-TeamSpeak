# 部署本 fork 的最新版本

仓库：`Chigus/WebSpeak-client-for-TeamSpeak`。维护分支：`nas/macau`。
本分支包含双声道原音、输入/接收独立三档 RNNoise 降噪、网页 P2P 及 NAS/中转部署改动。
上游的镜像、旧的 `master` 分支及上游 Release 不包含这些改动。

## 从源码构建 Docker（推荐）

默认 `docker-compose.yml` 构建当前 checkout，不依赖 GHCR 登录或镜像可见性。
需要 Linux Docker Engine 和 Compose v2；原生依赖在 Linux 镜像中编译。

```sh
git clone --branch nas/macau --single-branch https://github.com/Chigus/WebSpeak-client-for-TeamSpeak.git
cd WebSpeak-client-for-TeamSpeak
export WEBSPEAK_REVISION=$(git rev-parse HEAD)
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3040/health
```

版本检查：镜像 `org.opencontainers.image.revision` 必须等于 checkout 的完整 SHA，
健康接口版本必须等于该提交的 `package.json`。只看版本号不足以区分未改版本号的提交。
没有设置 `WEBSPEAK_REVISION` 时标签显示 `unknown`，源码仍来自当前目录。

```sh
git rev-parse HEAD
docker inspect "$(docker compose ps -q webspeak)" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

更新已有实例时先保存/提交自己的修改，再执行；快进失败时处理分叉，不强制覆盖：

```sh
git pull --ff-only origin nas/macau
export WEBSPEAK_REVISION=$(git rev-parse HEAD)
docker compose up -d --build --no-deps webspeak
```

Compose 使用 `webspeak-data` 保存数据库和密钥。不要用 `down -v` 删除数据。
已有自定义 Compose、HTTPS 反代和 NAS 实例应保留原有挂载、项目名和配置。
澳门 NAS 使用 [专用更新器](./NAS_GIT_DEPLOYMENT.zh-CN.md)，不要套用这里的新实例命令。

## 拉取本 fork 的预构建镜像

维护分支每次推送触发测试、构建和 Docker 健康检查；通过后发布
`ghcr.io/chigus/webspeak:latest`、`nas-macau` 和 `sha-<完整提交SHA>`。
`latest` 指向最新成功构建，构建失败或还在排队时仍是上一成功版本。
按完整 SHA 拉取可以确认某一次修改已经发布，不会悄悄使用旧镜像。
镜像提供 Linux amd64/arm64。

```sh
export WEBSPEAK_IMAGE=ghcr.io/chigus/webspeak:sha-$(git rev-parse HEAD)
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d --no-deps webspeak
```

持续跟随最新成功镜像时使用 `ghcr.io/chigus/webspeak:latest`，更新时也要重新 `pull` 和 `up`。
固定 SHA/digest 的实例会保持那个版本，除非主动更改。
GHCR 包首次发布可能需要账户拥有者将包设为 Public，或者在部署端通过
`docker login ghcr.io` 登录有下载权限的账号；无需等待这些配置也可使用源码构建。
不能用 `ghcr.io/echosixhiya/webspeak` 代替本 fork。

## 不使用 Docker

```sh
git clone --branch nas/macau --single-branch https://github.com/Chigus/WebSpeak-client-for-TeamSpeak.git
cd WebSpeak-client-for-TeamSpeak
npm ci --ignore-scripts --no-audit --no-fund
npm run prepare:sdk
npm rebuild @discordjs/opus --foreground-scripts --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
npm run verify
npm start
```

Node.js 使用 22.5+，建议 22.22.2；原生 Opus 编译需要 Python、Make 和 C/C++ 工具链。
更新时停止/重启自己管理的服务，快进 `nas/macau`，重新安装锁定依赖并运行 `verify`。
单独 `git pull` 不会更新已生成的 `dist` 或正在运行的 Node.js 进程。

Release 仅是特定提交的 Windows/Linux/Android 快照，不随普通推送自动更新。
需要最新代码时使用上面的源码/镜像路线。手动发布包必须从维护分支或明确 tag
启动 `Build release assets`，版本输入须匹配该提交的 `package.json`，查看 Actions 的
`head_sha` 后再下载对应产物。历史上游发布记录保留作归属和变更参考。

## 功能配置与源码

部署后配置自己的 TeamSpeak 目标、HTTPS、网络可达性和 ICE 服务。
网页 P2P 由参与者分别开启；输入双声道原音绕过输入降噪，接收降噪默认关闭。
与澳门 NAS 一样要求独立立体声时，保持可选的网关 WebRTC 单声道混音关闭。
详见 [功能与限制](./PEER_VOICE_AND_DENOISING.zh-CN.md)。

Docker 构建在验证后 prune 开发依赖；镜像在
`/source/webspeak-stereo-source.tar.gz` 提供对应源码。CI 镜像使用同一 SHA 的 Git archive，
本地镜像使用实际 Docker build context 的源码快照；不能将含私密文件的目录作为 context。
NAS 发布器继续使用完整 Git archive、40 包真实双声道编码检查和可回退切换。

GitHub 推送、成功发布镜像、更新某个运行实例是三个步骤。
本仓库不自动连接部署者机器、不配置定时更新；每次修改提交并推送维护分支后，
部署者执行相应更新命令并核对 SHA，才能确认运行的是这一版。
