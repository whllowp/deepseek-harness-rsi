---
description: "双核 RSI 的左侧边栏“自进化”面板：守护核在后台进化出的每一版策略，以及它记录的每一次自我修复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-rsi

[English](README.md) | 中文

## 概述

`dsh-experimental-client-ui-rsi` 在左侧边栏添加“自进化”入口。其面板列出双核 RSI 守护核在无人要求时于后台完成的工作：每一次进化（采纳的指引与技能、基准提升、理由与落地时间），以及每一次自我修复（哪里坏了、第几次尝试、守护核如何恢复）。面板打开期间按固定节奏重新读取 Host，新的后台工作无需手动刷新即可出现。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[双核 RSI bundle](../dual-core-rsi-bundle/README.zh.md) 会把本插件与 Host 服务一同挂载；在 Plugins 中启用该 bundle 会在侧边栏的全局面板列表中加入星芒图标，停用则两者一并移除。选中该入口会在主区域打开面板。

### 面板展示什么

页头说明守护核是否按计划运行，以及达标候选如何被采纳（后台自动，或在 `consult` 策略下等待合入）。“进化”区按时间倒序列出已采纳的策略；每行给出蒸馏器理由、采纳时间、基准提升、触发方式（计划、手动或工具），以及采纳的指引行与技能名。“修复”区按时间倒序列出自我修复事件；每行给出失败种类（超时或错误）、尝试次数、恢复方式（退避后重试，或顺延到下一间隔）以及失败详情。Host 尚无活动时显示一行说明，读取失败时显示报告与“重试”按钮，首次读取时显示加载提示。

### 配置

| Field | Default | Meaning |
|---|---|---|
| `refreshIntervalMs` | `15000` | 面板打开期间两次活动读取之间的毫秒数；至少 1000。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

浏览器入口自行挂载生成的 `dualCoreRsi` Remote 贡献，因为默认 Remote 装配从不携带实验性命名空间；随后以同一 id 注册字典、keyed `main` 面板与 `sidebar.panellist` 入口；卸载时先撤下面板，再撤下它所读取的 Remote。一个共享的活动数据源持有全部传输：首次订阅时读取 `dualCoreRsi.activity`，订阅期间每隔 `refreshIntervalMs` 以及每次 `connection/reset` 之后重新读取，重叠的触发共享同一次进行中的读取，最后一个订阅者离开时停止所有触发。面板通过 `useSyncExternalStore` 读取数据源，不持有其他状态。

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 绑定生成的 Remote 贡献的浏览器入口 |
| [`src/client/mount.ts`](src/client/mount.ts) | Remote 挂载、面板与侧边栏注册、Config |
| [`src/client/activity-source.ts`](src/client/activity-source.ts) | 面板共享的定时活动读取 |
| [`src/client/RsiPanel.tsx`](src/client/RsiPanel.tsx) | 进化与修复面板 |
| [`src/client/RsiPanelIcon.tsx`](src/client/RsiPanelIcon.tsx) | 装饰性侧边栏图标 |
| [`src/client/locales.ts`](src/client/locales.ts) | `rsi.panel` 命名空间文案（以 zh 为准） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-experimental-dual-core-rsi`](../dual-core-rsi/README.zh.md) — 守护核、它的后台进化与自我修复，以及本面板读取的 `activity` Remote。
- [`dsh-client-ui-sidebar`](../../client/ui-sidebar/README.zh.md) — `sidebar.panellist` 插槽与主面板契约。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只为人类渲染 Host 记录的守护核活动，不触及任何提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；本包从不组装或发送提供商请求。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了当前的包约束，不是任务清单。

- **更新按节奏到达而非推送** — 面板打开期间，后台活动在 `refreshIntervalMs` 内出现；Host 的变更事件不会转发给客户端，因为默认的转发事件白名单排除实验性包。
- **历史有界** — 面板展示 Host 投影的最新 20 次进化与 20 次修复；完整记录保留在 `/rsi history`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
