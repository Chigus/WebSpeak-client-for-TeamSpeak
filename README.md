<div align="center">
  <a id="readme-top"></a>

  <img src="./image.png" alt="WebSpeak 项目横幅" width="100%" />

  <h1>WebSpeak</h1>

  <p><strong>让 TeamSpeak 自然地进入浏览器。</strong></p>
  <p>A self-hosted browser voice client for TeamSpeak 3 and TeamSpeak 6.</p>

  [![Maintained branch](https://img.shields.io/badge/branch-nas%2Fmacau-0f766e?style=flat-square)](https://github.com/Chigus/WebSpeak-client-for-TeamSpeak/tree/nas/macau)
  [![Docker Image](https://github.com/Chigus/WebSpeak-client-for-TeamSpeak/actions/workflows/docker-publish.yml/badge.svg?branch=nas%2Fmacau)](https://github.com/Chigus/WebSpeak-client-for-TeamSpeak/actions/workflows/docker-publish.yml)
  [![License](https://img.shields.io/badge/license-AGPL--3.0--only-0f766e?style=flat-square)](./LICENSE)
  [![GitHub Stars](https://img.shields.io/github/stars/Chigus/WebSpeak-client-for-TeamSpeak?style=flat-square&logo=github&color=0f766e)](https://github.com/Chigus/WebSpeak-client-for-TeamSpeak/stargazers)
  <br />
  [![TeamSpeak](https://img.shields.io/badge/TeamSpeak-3%20%7C%206-2580C3?style=flat-square)](https://www.teamspeak.com/)
  [![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
  [![Vue](https://img.shields.io/badge/Vue-3-42B883?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![Docker](https://img.shields.io/badge/Docker-GHCR-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/Chigus/packages/container/package/webspeak)

  <p>
    <a href="./docs/README.zh-CN.md">简体中文文档</a> ·
    <a href="./docs/README.en.md">English documentation</a> ·
    <a href="./docs/README.de.md">Deutsche Dokumentation</a> ·
    <a href="./docs/README.ru.md">Русская документация</a> ·
    <a href="./docs/README.ja.md">日本語ドキュメント</a>
  </p>
</div>

## 相对原版新增的内容

本仓库由 [EchoSixHIYA/WebSpeak-client-for-TeamSpeak](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak) 的 **WebSpeak 0.2.6** 派生，维护分支为 `nas/macau`，当前功能版本为 `0.2.6-stereo.7`。以下是本 fork 在原版基础上新增或扩展的内容；TeamSpeak 3/6 兼容、聊天、身份管理、皮肤、多语言和跨端 P2P 屏幕共享等能力沿用原项目。

| 新增 / 扩展 | 本 fork 提供的变化 |
| --- | --- |
| 人头麦 / 立体声原音 | 独立采集、传输和播放左右声道，显示左右电平；TeamSpeak 路径使用双声道 Opus Music、192 kbps 固定码率。 |
| 双向三档 RNNoise 降噪 | 自己的麦克风与自己听到的成员分别设置开关及轻 / 中 / 重档位；接收处理保留左右声道，模型失败回退原音。 |
| 屏幕共享线路 | 共享前选择 P2P、澳门或深圳服务器；观看者跟随共享者，服务器失败不自动回退直连。 [部署与限制](./scripts/screen-relay/README.md) |
| 网页语音 P2P | 同网关、同服务器、同频道的 2～5 位网页用户主动开启后直连；失败回退服务器，原生 TeamSpeak 与私语仍走服务器。 |
| 语音稳定性改进 | 固定立体声 Opus 包大小，改善 WSS 抖动下的连续播放，并限制播放与发送缓存。 |
| 网页频道音乐播放器 | 接入独立 TSBot，支持网易云 / QQ 搜索、按钮点歌、分享歌单导入、分页和共同播放控制，无需输入传统指令。 |
| 深圳 / 澳门中转工具 | 提供 HTTPS/WSS 与原生 TS UDP 中转配置、证书续期及可撤销路由器转发脚本；需部署自己的网络与域名。 |
| fork 部署与发布 | 默认 Compose 构建本分支；本仓库 GHCR 提供 amd64/arm64 镜像及提交 SHA 标签，另有 NAS Git 发布、回退和对应源码下载。 |

查看 [完整新增内容、使用入口与限制](./docs/FORK_ADDITIONS.zh-CN.md)。立体声原音绕过输入降噪；原有网关 WebRTC 混音器仍为单声道。网页语音 P2P 默认关闭，有额外上行开销，也不经过 TeamSpeak 的发言权过滤，具体适用条件见详细文档。

## 本 fork 的部署与更新

所有最新改动以 `nas/macau` 分支的提交为准。

[部署与更新指南](./docs/FORK_DEPLOYMENT.zh-CN.md) · [双向降噪与 P2P](./docs/PEER_VOICE_AND_DENOISING.zh-CN.md) · [NAS 发布流程](./docs/NAS_GIT_DEPLOYMENT.zh-CN.md)

音乐播放器需另行部署 TSBot 并配置平台授权、机器人 UID 和私有服务连接，见 [频道音乐使用与部署](./docs/CHANNEL_MUSIC.zh-CN.md)。

默认 Docker Compose 从当前源码构建。每次推送维护分支后，GitHub Actions 验证成功才更新 `ghcr.io/chigus/webspeak:latest`；已有部署需要重新构建/拉取并重建容器。Release 下载包只对应发布时的提交。

```sh
git clone --branch nas/macau --single-branch https://github.com/Chigus/WebSpeak-client-for-TeamSpeak.git
cd WebSpeak-client-for-TeamSpeak
docker compose up -d --build
```

## 项目简介 · Overview

| 逻辑 | 中文 | English |
| --- | --- | --- |
| **WHAT** | WebSpeak 是一个可自行部署的 TeamSpeak 3 / TeamSpeak 6 网页客户端与语音网关。 | WebSpeak is a self-hosted browser client and voice gateway for TeamSpeak 3 and TeamSpeak 6. |
| **WHY** | 无需安装桌面客户端，用户打开网页即可加入频道；部署者仍然掌控目标服务器、访问策略和数据。 | Users can join a voice channel from a browser without installing a desktop client, while the operator keeps control of servers, access, and data. |
| **HOW** | 部署后在管理员控制台配置 TeamSpeak 目标和访问方式，浏览器负责交互与音频，WebSpeak 负责网关连接。 | Configure the TeamSpeak target and access policy in the administration console. The browser handles interaction and audio; WebSpeak provides the gateway connection. |

## 文档 · Documentation

- [本 fork 相对原版的新增内容](./docs/FORK_ADDITIONS.zh-CN.md)
- [简体中文](./docs/README.zh-CN.md)
- [English](./docs/README.en.md)
- [Deutsch](./docs/README.de.md)
- [Русский](./docs/README.ru.md)
- [日本語](./docs/README.ja.md)
- [皮肤开发规范 / Skin Development Guide](./docs/SKIN_DEVELOPMENT.md)
- [皮肤开发 Agent Skill / Skin Development Agent Skill](./.agents/skills/webspeak-skin-development/SKILL.md)

## 社区 · Community

<div align="center">

<a href="http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=yhumUMDD9PmyYFWdXWUb_x7hM5trFQY8&authKey=Pw3HBGT7GwMinTQnuFGfnpf0aRSzXOJKcAiujVP1%2BXMpjheAKrncTRivicBJxpjV&noverify=0&group_code=869500475">
  <img src="./web/public/qq-group-qr.jpg" alt="WebSpeak QQ 群二维码" width="290" />
</a>

**QQ群 / QQ group：`869500475`**

[通过群聊链接直接加入 / Join directly](http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=yhumUMDD9PmyYFWdXWUb_x7hM5trFQY8&authKey=Pw3HBGT7GwMinTQnuFGfnpf0aRSzXOJKcAiujVP1%2BXMpjheAKrncTRivicBJxpjV&noverify=0&group_code=869500475)

[Telegram 群组 / Telegram group](https://t.me/+8qShpTcuN9A3MWY9)

</div>

## 友链项目 · Friend projects

### [NeteaseTSBot](https://github.com/yichen11818/NeteaseTSBot)

面向 TeamSpeak 3/6 的多平台音乐点播机器人，支持网易云音乐、QQ 音乐和 Bilibili 音频播放，并提供 Web 控制台。<br />
A multi-platform music bot for TeamSpeak 3/6 with Netease Cloud Music, QQ Music, and Bilibili playback, plus a web console.<br />
Ein plattformübergreifender Musikbot für TeamSpeak 3/6 mit Netease Cloud Music, QQ Music und Bilibili sowie Webkonsole.

## Contributors · 贡献者

感谢原项目作者和通过 PR 改进 WebSpeak 的贡献者。以下按原项目的 GitHub 合并记录列出；本 fork 的新增内容单独列在上方和详细文档中。

- [LainHE](https://github.com/LainHE) — [PR #2](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/pull/2) 改进浏览器端报错翻译；[PR #8](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/pull/8) 修正缩放、浮动布局和首页脚注。
- [TimmySheep](https://github.com/TimmySheep) — [已合并 PR #13、#15–#24](https://github.com/EchoSixHIYA/WebSpeak-client-for-TeamSpeak/pulls?q=is%3Apr+is%3Amerged+author%3ATimmySheep)，涉及 TS6 既有屏幕共享发现、屏幕比例、移动端语音/常亮/皮肤菜单、身份频道选项、PWA/主题、聊天历史、成员音频状态和麦克风权限等改进。

## 许可证 · License · Lizenz · Лицензия · ライセンス

WebSpeak 使用 [GNU Affero General Public License v3.0 only](./LICENSE) 发布。你可以使用、研究、修改和再分发本项目；如果修改后的版本通过网络向用户提供服务，需要按照 AGPL-3.0 向这些用户提供对应源代码。

WebSpeak is released under the [GNU Affero General Public License v3.0 only](./LICENSE). If a modified version is offered to users over a network, its corresponding source code must be offered under AGPL-3.0.

WebSpeak wird unter der [GNU Affero General Public License v3.0 only](./LICENSE) veröffentlicht. Bei Bereitstellung einer veränderten Version über ein Netzwerk muss der entsprechende Quellcode unter AGPL-3.0 angeboten werden.

WebSpeak распространяется по лицензии [GNU Affero General Public License v3.0 only](./LICENSE). Если изменённая версия предоставляется пользователям через сеть, соответствующий исходный код должен быть доступен этим пользователям на условиях AGPL-3.0.

WebSpeak は [GNU Affero General Public License v3.0 only](./LICENSE) の下で公開されています。変更版をネットワーク経由でユーザーに提供する場合は、対応するソースコードを AGPL-3.0 に従ってユーザーに提供する必要があります。

## Star History

<a href="https://star-history.com/#EchoSixHIYA/WebSpeak-client-for-TeamSpeak&Date">
  <img src="https://api.star-history.com/svg?repos=EchoSixHIYA/WebSpeak-client-for-TeamSpeak&type=Date" alt="WebSpeak Star History" width="100%" />
</a>

<div align="right"><a href="#readme-top">返回顶部 · Back to top ↑</a></div>
