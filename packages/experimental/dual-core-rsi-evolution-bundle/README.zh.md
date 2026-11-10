---
description: "双核 RSI 演进 profile：双核 RSI 服务与 Dream-RSI 式回放蒸馏器、Harmony-Harness 式多目标基准组合，外加自进化侧边栏面板与像素英雄伴件。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-dual-core-rsi-evolution-bundle

[English](README.md) | 中文

## 概述

以演进后的组合添加双核 RSI 模式：与双核 RSI bundle 相同的默认开启守护核、侧边栏面板与像素英雄伴件，但蒸馏器与基准两行被[演进插件](../dual-core-rsi-evolution/README.zh.md)替换——回放蒸馏器在每次蒸馏前于已记录的提案/得分结果上做梦，多目标基准的 Tchebycheff 门控把压力压在达成最差的目标族上。作为双核 RSI bundle 的替代：二者只挂其一。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 或 Desktop 中打开插件，启用 **Dual-core RSI Evolution** 以替代 **Dual-core RSI**（二者只挂其一）。关闭即移除其 profile 层。

启用该 bundle 会挂载回放账本、随附 fixture 用例评估器之上的 Harmony 基准、随附子代理蒸馏器之上的回放蒸馏器、带工具与 `/rsi` 命令的双核 RSI 服务、自进化侧边栏面板以及像素英雄伴件。定时守护核依据新鲜会话活动自行循环并采纳过门候选。随附的目标划分奖励在 1200 字符预算内携带 `npm test`、`git status` 与 `CHANGELOG` 指引的策略，权重为 0.75 验证对 0.25 简洁，门控展示的是均衡的多目标采纳而非端到任务质量。

<a id="understand-the-implementation"></a>
## 理解实现

补丁在基础组合之上插入五行：`dual-core-rsi-evolution-ledger`、`dual-core-rsi-benchmark`（Harmony 提供者）、`dual-core-rsi-distiller`（回放提供者）、`dual-core-rsi`（服务）与两个客户端行。提供者选择是组合而非配置分支；换 bundle 即换策略。`cordis.patch.yml` 中的用例集与目标权重是部署选择，可像任何行配置一样编辑。

<a id="further-exploration"></a>
## 进一步探索

- [`dual-core-rsi-evolution`](../dual-core-rsi-evolution/README.zh.md) — 能力实现。
- [`dual-core-rsi-bundle`](../dual-core-rsi-bundle/README.zh.md) — 本 bundle 所替代的普通组合。

<a id="model-experience"></a>
## 模型体验

间接地，经由[能力实现](../dual-core-rsi-evolution/README.zh.md)，由其拥有模型上下文与结果。

#### KV Cache effect

该层不直接添加请求内容；缓存效应由能力实现的工具、提示与结果拥有。切换 bundle 会改变活跃 Session 的工具列表，使其缓存请求前缀失效一次。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 该模式为实验性，其基准度量策略一致性而非端到任务质量；完整限制清单由能力实现拥有。

-----

<a id="dev-note"></a>
### 开发备注

bundle 本身不携带源码：`src/index.ts` 是标记模块，运行时行在 [`cordis.patch.yml`](cordis.patch.yml) 中。
