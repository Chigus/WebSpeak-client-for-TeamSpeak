# 网页频道音乐播放器

[返回项目首页](../README.md) · [本 fork 的新增内容](./FORK_ADDITIONS.zh-CN.md)

`0.2.6-stereo.6` 在 WebSpeak 语音频道中新增音乐播放器，连接 [NeteaseTSBot](https://github.com/yichen11818/NeteaseTSBot) 的外部 API。机器人向 TeamSpeak 频道发声，网页和原生客户端都能收听。TSBot 为独立项目，本 fork 新增的是网页交互、服务端集成与部署模板；本轮部署基于官方稳定版 `v0.7.0`（提交 `59025f1762e9c23f69aa828ea2fed090591a8e0d`）。

## 使用

进入机器人所在的语音频道，点击音乐图标展开播放器。选择网易云或 QQ 音乐，搜索歌曲后点击「立即播放」或「加入队列」，无需输入聊天命令。支持暂停、上一首 / 下一首、音量、随机、循环及队列播放 / 移除。所有控制改变当前频道的共同播放。

「我的歌单」接受两平台公开歌单的完整链接或数字 ID，也支持粘贴网易云 `https://163cn.tv/…` 短链接及包含链接的分享文字。QQ 的短分享链接需先在平台打开并复制完整歌单地址。歌单按每页 100 个平台曲目 ID 加载，实际显示数量可能因下架或无效条目减少；「播放歌单」和「歌单加入队列」处理当前页，下一页需再操作。添加期间显示成功 / 失败数量，可以停止后续添加。

保存的歌单只含平台、ID、名称，留在当前浏览器，不自动同步账号歌单或其他设备。播放器不会向普通网页用户提供音乐账号 Cookie、管理员密码、外部 API Token 或签名播放地址。账号授权在独立的 TSBot 管理页完成。

平台账号、会员、歌曲版权和地区限制仍适用；扫码授权成功不保证所有歌曲都有可播放音源。仅提供试听片段时显示试听提示，取不到播放地址时提示检查账号 / 平台授权。队列最多显示前 200 首；歌单批量添加不替换已有队列。超时后先检查队列，避免重复点歌。

## 部署独立音乐服务

WebSpeak 镜像包含播放器和服务端接口。音乐机器人、网易云 API、平台登录和 TeamSpeak 连接需要另行配置，单独更新 WebSpeak 镜像不会自动安装这些服务。

示例使用官方 TSBot 三个固定镜像摘要及 `NeteaseCloudMusicApi@4.32.0`。在干净源码 checkout 中执行：

```sh
docker build -f scripts/music/Dockerfile.netease -t webspeak-netease-api:4.32.0 scripts/music
mkdir -p /srv/webspeak-music/data /srv/webspeak-music/logs /srv/webspeak-music/tmp
cp scripts/music/compose.example.yml /srv/webspeak-music/compose.yaml
```

在 `/srv/webspeak-music/tsbot.env` 中配置以下变量，并将该文件权限设为 `600`。Token、加密密钥、初始密码应各自生成独立随机值；保留加密密钥和数据目录，才能读取已保存的授权。

```dotenv
TSBOT_HOST=0.0.0.0
TSBOT_PORT=8009
TSBOT_COOKIE_KEY=REPLACE_WITH_PERSISTENT_RANDOM_KEY
TSBOT_API_TOKENS=REPLACE_WITH_RANDOM_API_TOKEN
TSBOT_INITIAL_ADMIN_PASSWORD=REPLACE_WITH_RANDOM_INITIAL_PASSWORD
TSBOT_TS3_HOST=YOUR_TEAMSPEAK_HOST
TSBOT_TS3_PORT=9987
TSBOT_TS3_NICKNAME=频道音乐 · TSBot
TSBOT_TS3_CHANNEL_ID=YOUR_CHANNEL_ID
TSBOT_VOICE_CONFIG_FILE=./logs/voice-service.json
TSBOT_VOICE_STATE_FILE=./logs/voice_state.json
```

```sh
docker compose --project-name webspeak-music --project-directory /srv/webspeak-music -f /srv/webspeak-music/compose.yaml up -d
```

示例只将管理网页 `18080`、后端 `18009`、网易云 API `18030` 绑定到宿主机的回环地址；语音服务的 gRPC 不发布到公网。通过 SSH 隧道访问管理页，在「系统配置 → 音乐会员登录」分别完成两平台后台授权，并更改管理员初始密码。TSBot 的旧安装数据请先备份，迁移格式按上游文档处理，不应直接覆盖不同版本的数据库。

## 接入 WebSpeak

默认 WebSpeak Compose 使用宿主机网络，因此可以访问上述回环端口。在源码目录之外创建 `music-config.json`：

```json
{
  "url": "http://127.0.0.1:18009",
  "neteaseUrl": "http://127.0.0.1:18030",
  "token": "SAME_API_TOKEN_AS_TSBOT_API_TOKENS",
  "target": "YOUR_TEAMSPEAK_HOST:9987",
  "botUid": "BOT_TEAMSPEAK_UNIQUE_ID",
  "botName": "频道音乐 · TSBot"
}
```

`target` 必须匹配 WebSpeak 的 TeamSpeak 目标；`botUid` 是机器人在 TeamSpeak 中的永久唯一 ID，不是昵称或临时客户端 ID。可通过管理员 ServerQuery 的 `clientlist -uid` 获取。给 WebSpeak 运行用户读取此文件的权限，勿提交文件、运行数据库或日志到 Git。

在 WebSpeak Compose 的 `webspeak` 服务中增加环境变量和只读挂载：

```yaml
environment:
  WEBSPEAK_MUSIC_CONFIG_FILE: /run/webspeak/music-config.json
volumes:
  - /srv/webspeak-music/music-config.json:/run/webspeak/music-config.json:ro
```

保留原有环境变量和数据挂载，再重新创建 WebSpeak 服务。使用桥接网络时，两个服务需要加入同一私有 Docker 网络；将 `url` / `neteaseUrl` 改为该网络的后端 / 网易云服务别名，不能使用容器自身的 `127.0.0.1`。澳门 NAS 使用 `webspeak` 网络及 `webspeak-tsbot-backend` / `webspeak-netease-api` 别名，私有配置位于 checkout 外。

网关根据真实 TeamSpeak 会话和机器人 UID 检查同频道资格；只有在机器人所在频道的已连接成员可搜索或控制。离开频道、重连或机器人移动后，旧请求取消或拒绝。服务端限制请求频率、并发、固定 API 路由与返回体大小；网易云短链仅解析官方域名跳转，不允许任意网址代理。

## 更新与验证

WebSpeak 继续从 `nas/macau` 的干净提交构建或使用本 fork 的 GHCR 镜像。GitHub Actions 验证通过后才发布 `latest`，已有部署仍须执行拉取 / 构建和容器更新，详见 [部署与更新](./FORK_DEPLOYMENT.zh-CN.md)。固定 TSBot 镜像不会跟随 WebSpeak 自动升级，需另行核对上游版本并更新镜像摘要。

平台 Cookie、加密密钥、机器人身份和私有配置通过运行目录持久保存。源码归档只包含代码和部署模板。验证音乐部署时，需要实际检查搜索、歌单导入、入队、暂停，以及 TeamSpeak → 公网 WSS 的可解码非静音音频；HTTP 健康检查只能证明应用存活。
