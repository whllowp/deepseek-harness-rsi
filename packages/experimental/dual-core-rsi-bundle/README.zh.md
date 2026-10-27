---
description: "双核 RSI 模式：默认运行的守护核蒸馏用户核，基准评估候选，通过门槛的候选交由人类合入决策并记录到本地 git 台账。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-dual-core-rsi-bundle

[English](README.md) | 中文

## 概述

以默认关闭的可选层形式为 harness 添加实验性双核 RSI 模式。启用后，守护核按自身调度把用户核的活跃会话蒸馏成有界策略产物，经基准评估，优化超过 5% 阈值时把候选挂起为待合入提议；人类合入会替换策略、归档被替换面，并把变更记录到本地 git 台账。

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

在 Web 或 Desktop 中打开 Plugins，在 Official 中启用 **Dual-core RSI**。关闭即可移除其 profile 层。

启用该 bundle 会在运行中的 Host 挂载子代理蒸馏器、fixture 基准，以及带工具与 `/rsi` 命令的双核 RSI 服务。调度守护核在有新会话活动时自行循环——`/rsi run` 只是立即强制一次；内置 fixture 基准检查蒸馏策略是否携带验证指引并保持在指引预算内，因此它演示的是合入门控而非端到端质量。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入子代理蒸馏器（`spawn` 提供者）、带默认用例的 fixture 基准，以及默认 5% 阈值的双核 RSI 服务。之后的 profile patch 可按行 id 替换任一行的配置或禁用它；单独的覆盖并不会选择该 bundle。[Profile composer](../../boot/app-boot/README.zh.md) 负责 patch 顺序与错误。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[能力实现](../dual-core-rsi/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接通过[能力实现](../dual-core-rsi/README.zh.md)生效，模型上下文与结果由其负责。

#### KV Cache 影响

该层不直接添加请求内容；工具、提示词与结果的缓存影响由能力实现负责。切换该 bundle 会改变活跃会话的工具列表，使其缓存请求前缀失效一次。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 该模式是实验性的，且内置基准度量策略符合度而非端到端任务质量；完整限制清单由能力实现持有。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
