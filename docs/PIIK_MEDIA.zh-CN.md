# Piik 媒体方案接入

研究基线：[TNTcraftHIM/Piik](https://github.com/TNTcraftHIM/Piik/tree/390e637d4e9090e6258ccc3d3a0a3f877d81b25c)，2026-10-10 获取。Piik 使用 MIT，移植模块保留原版权并附 `licenses/Piik-MIT.txt`；WebSpeak 保持 AGPL-3.0-only 与对应源码发布。

## 已接入的浏览器实现

| Piik 实现 | WebSpeak 接入 | 作用 |
|---|---|---|
| `video-codec-preflight.ts` 与 `video-codec.ts` | `screen-share-codec-probe.ts`、`screen-share-codec.ts` | 每次共享通过独立合成动态图和真实 PeerConnection 测量 H.264；4 秒总预算含协商、ICE、统计，500 ms 预热后测量 1 秒；满足目标帧率才优先 H.264，失败/不确定保持 VP8。H.264 不等于已证明硬件加速。 |
| `sender-video-track.ts` | `screen-share-track.ts` | 每个观看端拥有发送轨道；支持 raw-frame API 的显示采集用单帧输入缓冲的 Processor/Generator 管道，不缩放、不重编码，防止某个发送端的软像素目标压缩共享采集源，影响其他观看端及画质恢复；不支持时退回普通 clone。 |
| framework-owned quality | `screen-share-bitrate.ts` | 自动模式设置分辨率、帧率、码率上限和降级偏好，网络适应交给 WebRTC。不再通过定时统计反复下调应用上限，保留浏览器自身恢复空间。手动上限仍可实时修改，参数写入串行并读取浏览器接受值。 |
| bounded publisher ICE recovery | `screen-share.ts` | 已建立的纯 P2P 路径断连，由发布端最多发起一次 ICE restart；接收端等候并应答，保留采集与视频，不产生无限重试。自动线路保留原有 TURN 分组回退。此为 Piik 第一步恢复的接入，不声称复现其完整重建/拓扑控制器。 |
| Firefox orphan SDP fix | `screen-share-codec.ts` | 仅移除本地 offer 中被排除 codec 的 fmtp/rtcp-fb，保留有效属性及音频 SDP。 |

原生 TeamSpeak 观看路径继续优先 VP8，不根据浏览器 H.264 探测推断 TS6 编码支持。屏幕音频每个发送端也使用独立 clone。麦克风、双声道 Opus Music 和语音传输没有改动。

## Piik 优化的边界

Piik 的 Windows App 有独立的原生采集、硬件编码枚举/实际输出探测与编码后扇出，这些不能仅靠浏览器网页接入。它的混合网络拓扑与 LiveKit SFU 是一套服务器和客户端共同协议；WebSpeak 已有不同的频道授权与 TURN 线路，不能直接混用其信令或未经授权开放新媒体端口。

Piik 可选 NAT 预测需要精确的三目的 STUN 观测，同一连接、同一公网地址的算术端口序列才生成最多八个候选；其文档明确不保证受限网络成功。现有部署未凭空增加 STUN 端口或候选预测，普通 P2P 与 TURN 保持原授权边界。

多人直连仍需按观看人数承担上传和编码成本；轨道隔离并不等于编码后共享扇出。两端运营商、NAT、设备与朋友使用 Piik App 还是网页均会影响结果，不能仅由朋友的主观画质推断同样体验。

## 验证

`npm run verify` 包含媒体单元/生命周期回归、后端构建、vue-tsc 与前端构建。新增测试检查真实编码进度判定、H.264/VP8/修复 codec 协商、Firefox SDP、轨道独立释放、上限读取以及有界 ICE 重启与退出后的过期信令。

`node scripts/piik-media/browser-check.mjs` 提供本机合成画面验收：真实 WebSpeak 控制器、两个浏览器 PeerConnection 观看端、编码/解码、原始帧隔离、实时调整码率、退出一个观看端后另一个继续收流。不采集实际桌面和麦克风，也不作为跨公网网络的证据。

发布遵循 `nas/macau` 与 NAS release.sh：明确 Git commit、CI、Linux Docker 构建、双声道编码检查、对应源码归档、仅替换 webspeak 服务及健康失败回滚。实际两台设备的跨网画质/延迟仍需要另行实测，不能把 HTTP 健康或本机合成验证写成真实麦克风/公网 P2P 的验收。
