# 自动连接与个人语音质量

默认使用自动模式。手动屏幕线路与码率位于高级网络设置中；语音设置只改变当前用户的上行和下行，不修改 TeamSpeak 频道或其他用户的音质。

## 语音

- 普通麦克风在支持 WebCodecs AudioEncoder 的浏览器中编码为 20 ms 单声道 Opus。48 kbps 仅需每帧 120 字节音频载荷，替代原来的 1920 字节 PCM；另有协议开销。可选 16、24、32、48、64、96、128、192 kbps。
- 服务器根据客户端反馈的往返时间、发送队列及播放丢帧调整个人质量。持续拥塞时降码率，连续稳定且有媒体流量后逐步恢复；不会把 TCP 重传隐藏的丢包称为实测网络丢包。
- 在 WSS 保持可用的同时，后台依次探测直连及已配置的澳门、深圳、阿里云、Cloudflare 通道。至少五次探测、明显优于当前路径且探测丢失比例低才由网关批准切换。后台每 25 秒考虑下一候选，避免频繁跳线。通道心跳失效后回退 WSS；WSS 恢复且连续三次明显更快时也会回切。发送限流和质量反馈依据当前媒体通道，控制通道拥塞不会阻止健康的 TURN 通道发送语音。
- WebRTC 数据通道使用无序、零重传音频包，保留说话者 ID 和原始音频格式。原生 TS 用户发来的语音也可通过该网关通道到达浏览器；没有启用旧的单声道 WebRTC 混音器。
- 立体声输入仍传输独立左右声道 PCM，网关输出 Opus Music codec 5、192 kbps CBR、每 20 ms 480 字节。接收者可以单独降低下行码率，左右声道仍独立。无 WebCodecs 编码支持时自动保留 PCM 上行，设置中显示相应的上行带宽。
- TURN 不是 TeamSpeak 原生 UDP 协议的代理。原生桌面/手机 TS 客户端仍连接 TS 服务；这套自动选择作用于 WebSpeak 浏览器与网关之间。Android 内置网关预览暂不启用新增语音调优与数据通道。

## 屏幕共享

自动模式为共享者和已加入的浏览器观看者提供直连和可用 TURN 候选，由 ICE 检查可达性；每个观看者建立自己的媒体连接。观看者网络封锁 UDP 时也可尝试 TURN TCP/TLS，凭据不进入公开共享列表。自动模式失败后使用 ICE restart，先尝试所有 TURN 候选，再按顺序对每组候选各尝试一次；最多 8 组，加上首次合并尝试共最多 9 次。重试期间保留捕获画面；耗尽后停止该失败的对端连接并报告错误。手动指定的节点强制共享者使用该中转，不悄悄切换节点。

视频码率继续依据实际发送反馈自动调整，手动数值是上限。ICE 可达性不代表全球最优带宽；服务器位置也不能保证校园网体验，验收必须记录用户端路径和媒体数据。

## 统一网站入口

管理员将指向同一网关/同一 TS 实例的 HTTPS 网站地址写入 `WEBSPEAK_GATEWAY_ORIGINS`，格式为 JSON 字符串数组。连接前每条线路最多探测三次，对抖动和失败加权；新线路明显更好才选用。页面留在原网站，IndexedDB 身份、频道选择和个人设置留在原位置，只调整加入请求和 WSS 连接地址。异常断线时冷却失败节点并最多重试三次。未勾选记住身份时，临时身份仅保留在本次页面会话用于重连，不写入持久存储。

只对明确列出的来源开放健康检查和加入接口的 CORS；管理接口不开放。配置最多列出 4 个入口的完整 origin，包括端口。网关返回 502/504 或加入请求超时，也会冷却失败入口供自动重试选择其他线路。首次网站本身完全无法加载时，需要另一个可访问入口；浏览器代码无法修复 DNS 或整个入口的停机。

## 私有配置

`WEBSPEAK_SCREEN_SHARE_RELAYS_FILE` 保存静态 TURN REST 节点，保留现有澳门/深圳配置后可增加 `aliyun`。包含 Cloudflare 在内最多 4 个唯一节点。自动凭据先保留各节点的一组候选，再填充额外协议组，总计最多 8 组，避免多组 Cloudflare 候选挤掉其他节点。

阿里云入口转发到同一个深圳 coturn 时，可以为语音网关配置单独的接入地址：

```json
{
  "id": "aliyun",
  "urls": ["turn:aliyun.example:33478?transport=udp", "turn:aliyun.example:33478?transport=tcp", "turns:aliyun.example:5349?transport=tcp"],
  "serverUrls": ["turn:shenzhen.example:33478?transport=udp"],
  "secret": "REPLACE_WITH_THE_EXISTING_SHENZHEN_TURN_REST_SECRET"
}
```

将这条记录追加到私有 JSON 数组，并替换示例地址和密钥。`urls` 发给浏览器，`serverUrls` 只供网关的语音 WebRTC 连接使用；二者共享同一份有期限的凭据，必须通向同一个 TURN 服务及 REST 密钥。这样澳门网关可直接进入深圳 TURN，避免先绕到阿里云；浏览器仍从阿里云入口接入深圳。`serverUrls` 最多 4 个 TURN URL，仅静态节点可用，不改变屏幕共享浏览器之间的 ICE 配置。是否实际经过深圳，仍须用真实媒体和中转记录验收。

`WEBSPEAK_CLOUDFLARE_TURN_FILE` 指向仓库外的私有 JSON：

```json
{"id":"cloudflare","provider":"cloudflare","keyId":"YOUR_TURN_KEY_ID","apiToken":"YOUR_TURN_API_TOKEN"}
```

浏览器只获得有期限的 TURN 凭据，永久 API Token 和 REST 密钥留在网关。自动模式下 Cloudflare 签发失败不阻断已有节点。部署时保留原有配置备份；增加阿里云节点或第 4 个节点后，回滚旧镜像必须同时恢复其支持的节点文件及环境配置。

## 验证

`npm run verify` 包含个人码率、反馈防抖、真实原生 Opus、异步资源回收、入口校验、屏幕线路授权和自动重试测试。

`scripts/automatic-network/browser-server.mjs` 用真实浏览器 WebCodecs、真实 Cloudflare TURN 和网关数据通道验收合成音频；不采集物理麦克风。`scripts/screen-relay/` 验收合成画布和音频。设置 `NETWORK_CHECK_GATEWAY` 和 `NETWORK_CHECK_ROOM` 可通过生产网关与原生 TeamSpeak 在受密码保护的测试频道进行两端音频往返；`#tcp` / `#tls` 强制浏览器到 TURN 的相应协议。测试中的模拟拥塞/评分与真实媒体往返必须分别记录。合成音频成功不等同于物理麦克风或特定校园网现场验收。
