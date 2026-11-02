---
description: "双核 RSI 的像素勇者桌宠：原创像素小人行走于 Web 客户端，守护核蒸馏时低鸣、记录修复时闪红、采纳进化时举心。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-zelda-pet

[English](README.md) | 中文

## 概述

`dsh-experimental-client-ui-zelda-pet` 在 Web 客户端右下角添加一位像素勇者。勇者是守护核活动的纯投影：空闲时行走，蒸馏循环运行时低鸣，记录自我修复时闪红，采纳进化时举心并在气泡中给出理由。它的按钮打开“自进化”侧边栏面板。

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

[双核 RSI bundle](../dual-core-rsi-bundle/README.zh.md) 会把本插件与“自进化”面板一同挂载；启用 bundle 即加入勇者，停用则两者一并移除。勇者等待面板插件挂载的 `dualCoreRsi` Remote 命名空间，因此两行同进退。

### 勇者展示什么

勇者对相邻两次活动读取之间的差异做出反应：新事件（最新修复 id 变化）让精灵闪红 2.5 秒并在气泡中给出修复详情；新进化（最新循环 id 变化）让精灵发光举心并给出蒸馏器理由；否则运行中的循环让精灵低鸣，空闲时行走。守护核停用时精灵变灰且不再反应。

### 配置

| Field | Default | Meaning |
|---|---|---|
| `refreshIntervalMs` | `15000` | 挂载期间两次活动读取之间的毫秒数；至少 1000。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

挂载把舞台元素同步插入文档（存在性永不与 React 首次提交竞速），并通过 [`client-ui-rsi`](../client-ui-rsi/README.zh.md) 的共享活动数据源做出反应——在 `dsh.client.external` 中声明为被认可的跨插件导线层。连接重置分发随插件上下文急切注册；迟到的 React 提交永远不会触碰已退出的上下文。姿态折叠是对相邻视图的纯函数，瞬态反应由定时器回到 idle，任何更新的快照都会取消该定时器。

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 绑定挂载的浏览器入口 |
| [`src/client/mount.tsx`](src/client/mount.tsx) | 舞台生命周期、Remote 命名空间等待、Config |
| [`src/client/pet-state.ts`](src/client/pet-state.ts) | 对活动视图的纯姿态-气泡折叠 |
| [`src/client/ZeldaPet.tsx`](src/client/ZeldaPet.tsx) | 勇者组件与像素画精灵 |
| [`src/client/locales.ts`](src/client/locales.ts) | `zeldaPet` 命名空间文案（以 zh 为准） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-experimental-dual-core-rsi`](../dual-core-rsi/README.zh.md) — 勇者映照其进化与修复的守护核。
- [`dsh-experimental-client-ui-rsi`](../client-ui-rsi/README.zh.md) — 共享活动数据源与勇者打开的面板。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只为人类渲染 Host 记录的守护核活动，不触及任何提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；本包从不组装或发送提供商请求。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了当前的包约束，不是任务清单。

- **精灵是原创致敬** — 手绘的冒险 RPG 传统像素勇者，并非任何受商标保护的角色素材。
- **反应来自节奏读取** — 后台活动在 `refreshIntervalMs` 内出现；面板的推送限制同样适用于此处。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
