# 深圳语音中转

这套部署为同一个澳门 WebSpeak / TeamSpeak 服务提供深圳入口，不转码音频。网页仍使用 HTTPS/WSS，TeamSpeak 原生客户端仍使用其 UDP 协议；人头麦的 Opus Music 双声道保持不变。

| 用途 | 澳门直连 | 深圳中转 |
| --- | --- | --- |
| 网页 | `https://1.narcissu1.top:5555` | `https://2.narcissu1.top:5555` |
| TeamSpeak 语音 | `1.narcissu1.top:9987` | `2.narcissu1.top:9988` |

深圳为 IPv4 入口。该域名的 A 记录继续由现有 DDNS 更新；新增 AAAA 前必须另外配置和验证 IPv6 监听、防火墙及公网端口。DNS 刷新不能迁移已经建立的 WSS 或 UDP 会话，公网 IP 变化后客户端需要重连。

## 结构与边界

深圳 ASUS 路由器将公网 TCP 5555 转发到 iStoreOS `192.168.50.227:15555`，公网 UDP 9988 转发到 `192.168.50.227:19987`。新增规则保留已有端口转发，尤其原 9987 和 VPN 的 5555。

iStoreOS 的独立 nginx 容器把网页代理到澳门 `1.narcissu1.top:5555`，把 UDP 语音代理到澳门 `1.narcissu1.top:9987`。两级网页代理都保留含端口的 Host 和原始 Origin，上游 TLS 使用澳门域名校验证书。只绑定 iStoreOS 的局域网 IPv4 地址，不开启额外的公网管理接口。

HTTP 和 UDP 都定期解析澳门 DDNS。TeamSpeak 的每个来源 UDP 会话使用独立上游 socket，允许异步语音回复，空闲超时十分钟。转发不使用 TeamSpeak PROXY protocol，不会改变音频编码。

澳门看到中转用户共用深圳出口 IP。因此服务器按 IP 的连接数量限制、封禁及网关的访问限流可能共同影响这些用户；新增大量听众前需复查。此入口只中转 TS 语音 UDP，未转发原生客户端的 TCP 文件传输或 ServerQuery。

网页存储按域名隔离。首次使用深圳网页时，可能需要重新允许麦克风、选择“daw麦克风”、开启人头麦双声道，或导入原有 TeamSpeak 身份。两个域名进入的是同一个服务器；网页上的用户身份和设备选择不会由浏览器自动跨域复制。

## 版本与部署

所有源配置位于 `scripts/shenzhen-relay/`，从维护分支提交后再部署。运行目录为 iStoreOS `/opt/webspeak-relay`，内容分离如下：

- `releases/<完整提交>/`：从该提交的 `git archive` 解出的配置和脚本，附带 `COMMIT` 文件与源码校验记录。
- `runtime.env`：非秘密运行参数和固定 digest 的镜像引用。
- `credentials/cloudflare.ini`：现有该域名 DNS 凭据，仅 root 可读，不进入 Git。
- `acme/`、`acme-work/`、`acme-logs/`：证书、ACME 账号和续期状态，不进入 Git。
- `current-commit`：通过容器健康检查的部署提交。还需记录公网和真实音频验证。

`runtime.env` 示例：

```sh
RELAY_HOST=2.narcissu1.top
UPSTREAM_HOST=1.narcissu1.top
BIND_IP=192.168.50.227
NGINX_IMAGE=nginx@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
CERTBOT_IMAGE=certbot/dns-cloudflare@sha256:c45edb002b883da1a1235abb205dff474a7a1a459d878e8d5fdc7f9d83073aea
```

先由 `issue-cert.sh` 使用 DNS-01 签发仅含 `2.narcissu1.top` 的证书，无需额外开放公网 80 或 443。再运行 `release.sh <完整提交>`。脚本先检查准确镜像和候选 nginx 配置，再替换本任务的 relay 和续期容器；不通过健康检查时恢复已有容器。旧容器停止并保留，便于回退。

两个容器使用 `unless-stopped` 重启策略、只读根文件系统、有界日志，不挂载 Docker socket。证书凭据仅挂载给 Certbot；nginx 只读挂载证书 live/archive，不读取 DNS 凭据和 ACME 账号。

Certbot 每十二小时检查续期。nginx 每五分钟检查证书变化，在临时目录复制完整证书和私钥，先 `nginx -t`，再切换并平滑 reload，确认新 worker 启动后记录成功；不完整更新会保留现有证书并继续重试。续期脚本和镜像随每次 relay 提交部署更新。

路由器的两条转发规则既加入即时防火墙，也追加到原有 NVRAM 端口转发列表并提交，以便路由器下次正常生成防火墙时恢复。安装工具应先备份原列表、检查端口冲突，并只修改本任务的精确规则；不重启路由器、VPN 或整个防火墙。回退时只删除新增两条规则和对应即时 DNAT / FORWARD 规则。

部分固件或插件重新生成 NAT 时会遗漏较长列表中追加的规则。可将已提交的 `router-reconcile.sh` 保存为 `/jffs/scripts/webspeak-sz-forward.sh`，在原有 `nat-start` 末尾追加一次调用，并通过该启动钩子注册每五分钟执行的 `WebSpeakSZForward` cron。保留原钩子和备份；脚本只在 NVRAM 仍有本项目的精确启用配置时补回 TCP 5555 / UDP 9988，遇到不同目标的现有转发则停止，不更改 NVRAM 或其他规则。回退时同时删除这一调用和命名 cron。

## 验证与线路选择

健康响应不证明语音。上线需分别检查：合法证书、网页及资源、保留 Origin 的 join-ticket 和管理登录、WSS 握手、两个以上原生 TS UDP 客户端连接、真实 Opus 双声道包通过中转、长时间空闲和通话保持、旧入口及既有服务。

深圳到澳门的低延迟只说明其中一段可用，不能替代嘉兴等听众网络的测量。内地用户可先试深圳，海外用户可比较澳门直连；高峰时分别测延迟、丢包和听感。两条入口都不保证全球所有网络始终无卡顿。

## 语音 P2P 的适用范围

本 fork 已新增可选的网页语音 P2P，与原版已有的 P2P 屏幕共享分别控制。同一网关、同一 TeamSpeak 服务器和频道内的 2～5 位网页用户可在音频设置中分别开启直连；默认关闭，人数超过五位或连接失败时恢复服务器路径。原生 TeamSpeak、未开启的网页用户及私语仍通过服务器。

直连音频使用保留左右声道的 PCM DataChannel，并实现按频道鉴权的信令、去重及接收租约回退。原有 WSS 上行仍保留，每位直连听众会增加约 0.8 Mbps 单声道或 1.6 Mbps 双声道上行。实际可达性取决于双方网络及 ICE / TURN 配置；深圳入口不能保证所有网络都可直连。

直接通话不经过 TeamSpeak 的发言权过滤，依赖服务端发言审批的频道应关闭 P2P。不要用原有单声道 WebRTC 网关混音器替代这个开关。具体配置、网络地址暴露、带宽和回退限制见 [双向降噪与网页 P2P](./PEER_VOICE_AND_DENOISING.zh-CN.md)。
