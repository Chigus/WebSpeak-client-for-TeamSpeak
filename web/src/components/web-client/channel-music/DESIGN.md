---
name: WebSpeak 频道播放器（局部）
description: 既有语音工作台中的共享音乐面板；本文件仅约束 ChannelMusicPanel。
colors:
  light-accent: "#006a64"
  light-surface-1: "#fff"
  light-surface-2: "#f1f6f4"
  light-text: "#192120"
  light-border: "#e4ece9"
  light-danger: "#c95a54"
  dark-accent: "#69d2c7"
  dark-surface-1: "#172321"
  dark-surface-2: "#202f2c"
  dark-text: "#e8f3f0"
  dark-border: "#30413d"
  dark-danger: "#ee8a82"
typography:
  title:
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
  track:
    fontSize: "13px"
    fontWeight: 600
  label:
    fontSize: "12px"
  metadata:
    fontSize: "11px"
rounded:
  panel: "12px"
  control: "7px"
  cover: "8px"
spacing:
  compact: "8px"
  control-gap: "6px"
  summary-gap: "12px"
  section: "14px"
  inset: "16px"
components:
  button:
    rounded: "{rounded.control}"
    padding: "7px 9px"
  search-input:
    rounded: "{rounded.control}"
    padding: "9px"
  panel:
    rounded: "{rounded.panel}"
  play:
    rounded: "{rounded.control}"
    width: "40px"
    height: "40px"
---

# Design System: WebSpeak 频道播放器（局部）

## Overview

**Creative North Star: "沿用语音工作台"**

这是已实现局部扩展的记录，不设立新的产品世界或全局设计契约。面板在既有语音工作台中连续呈现当前曲目、共享播放操作与歌曲浏览，使用现有字体、主题变量和 Icon 组件。上方摘要可独立阅读，下方浏览区按需展开。

证据：`../ChannelMusicPanel.vue`、`../../../composables/useWebClientMusic.ts`、`../../../views/WebClient.vue`、客户端样式与内置 light/dark 皮肤。finish 结论为 `ship`；报告为 `D:/Codex/2026-10-09/codex-threads-01a11d4f-9397-7bd2-9fd1-2/work/music-finish-review.md`。四张截图为 `music-desktop.jpg`、`music-mobile.jpg`、`music-playlist-mobile.jpg`、`music-dark.jpg`（同任务 `outputs/`）。截图中的语音会话与播放状态为 UI fixture，不代表实际音频测试成功；未声称 Illusia 已通过截图验收。

**Key Characteristics:**

- 继承当前皮肤的语义变量，强调色用于播放、选中与焦点。
- 紧凑文字层级与可滚动曲目列表，曲名优先于次要元数据。
- 同频道控制条件、加载、错误、空状态与批量进度可见。
- 手机控件换行，保留原生输入与键盘焦点。

## Colors

### Primary

浅色深青绿与深色浅青绿来自内置皮肤。实际界面始终读取 `--accent`，用于播放按钮、进度、选中页签、提示文字与焦点；frontmatter 的 light/dark 值只是已提取的皮肤快照。

### Neutral

`--surface-1` 承载面板和输入；`--surface-2` 区分封面底、播放按钮与悬停；`--text-primary` 承载正文；`--border` 分隔控件、页签和曲目。局部 `--music-muted` 将当前主文字与主表面按 82% 主文字混合，用于辅助信息，跟随皮肤。

错误文字读取 `--danger`。自定义皮肤继续通过同名语义变量提供颜色，本文件不固定其色值。

**The 皮肤继承 Rule.** 局部面板以当前皮肤变量为颜色源，不将内置皮肤快照替代为运行时硬编码。

## Typography

字体继承客户端 Inter 与系统无衬线后备栈，不引入展示字体。当前曲名与歌单标题使用 title；列表曲名使用 track；作者、控件说明使用 label；序号、时长与统计使用 metadata。来源标记更小，只承担辅助信息，不作为主要操作标签。

曲名与作者单行省略；完整曲名由 title 属性和曲目按钮的可访问名称补足。时间与序号使用等宽数字。移动搜索输入增至 16px，保持输入可读性。

## Layout

面板占据宿主可用宽度，不设置独立全页容器。摘要依次排列封面、当前曲目、上一首/播放或暂停/下一首、展开入口；进度位于其下。浏览区依次呈现共享频道说明、三个页签、播放选项、搜索或歌单输入、结果与状态。

桌面搜索表单为来源 / 关键词 / 提交三列；结果列表最高 320px，内部滚动。歌单标题与批量动作允许换行。

在 600px 及以下，来源选择独占一行，关键词与提交保留同一行；内部边距收至 12px；控件最小高度 44px；时长隐藏；音量单独占行；结果列表最高 300px。摘要曲名可收缩，展开按钮收为带可访问名称的图标。

**The 曲名优先 Rule.** 狭窄布局先省略曲目文字、隐藏时长并换行表单，保留曲目与播放操作的对应关系。

## Elevation & Depth

局部面板以薄边界与两层表面区分层次，不增加悬浮阴影。选中页签的底部强调线由 box-shadow 实现，属于选中状态标记，不是卡片提升。面板之外的宿主阴影不纳入此局部记录。

## Shapes

面板采用 panel 圆角并裁切内容；输入与普通按钮共用 control 圆角；封面使用 cover 圆角，图像填充裁切。列表以横向细边界分隔，页签平直，以底部强调线识别当前项。

## Components

- **摘要与共享控制：** 当前曲目、作者、进度与上一首/播放或暂停/下一首持续可见。图标按钮具备 aria-label 与 title；没有同频道控制条件或正在提交时禁用。
- **浏览页签：** 搜索、队列、歌单使用 tablist/tab/tabpanel 关系；仅选中页签进入 Tab 顺序。左右方向键循环切换，Home/End 到首尾，并移动焦点。
- **搜索与输入：** 原生 select、search input 和提交按钮；空关键词、加载或提交期间禁用提交。搜索来源包括网易云、QQ 音乐与 Bilibili。
- **歌单入口：** 网易云与 QQ 歌单 URL 或 ID 载入；保存入口带来源和移除操作；歌单标题展示当前页数量 / 总数；播放歌单与加入队列分开，批量进度可停止。
- **曲目行：** 序号、曲名、作者/来源、时长与两项图标动作。搜索与歌单行为为立即播放 / 加入；队列行为为立即播放 / 移除。动作的可访问名称包含曲名。
- **状态与键盘：** 控件以强调色轮廓显示 focus-visible（2px、偏移 3px），禁用状态降低透明度。加载与反馈使用 status，错误使用 alert 并提供刷新；未配置或不同频道时说明限制并按条件提供加入频道入口。

sidecar 中的 HTML/CSS 是局部样式预览，不替代 Vue 组件、频道权限或真实请求行为。色阶为依据已提取颜色生成的 OKLCH 预览元数据，不是新增运行时 token 或皮肤规则；源码未声明的动画与提升阴影不补写。

## Do's and Don'ts

### Do:

- **Do** 使用已有语义颜色变量与客户端字体，局部变化限于此面板。
- **Do** 保持曲名、所属动作与同频道共享提示的可读关系。
- **Do** 保留原生控件、焦点轮廓、页签键盘操作和异步状态反馈。

### Don't:

- **Don't** 将这个局部布局推广为全局产品或品牌规则。
- **Don't** 将来源标记的小字号用于主要曲名或操作标签。
- **Don't** 将 UI fixture 的语音或播放状态写成真实音频验证，也不声称未提供的 Illusia 截图已经验收。
