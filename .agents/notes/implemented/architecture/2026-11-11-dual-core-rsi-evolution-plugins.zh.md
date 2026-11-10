# Agent Note: 承载论文机制的双核 RSI 演进插件

Status: implemented

[English](2026-11-11-dual-core-rsi-evolution-plugins.md) | 中文

## Problem

双核 RSI 模式只有一种蒸馏器策略和一个标量基准，二者都内建在 [`dual-core-rsi`](2026-11-04-dual-core-rsi-knowledge-base.zh.md) 里。当前自进化文献中的两种机制缺失：Dream-RSI（arXiv 2609.14858，§3）通过重放积累的发现历史来离线评估探索策略，而不为新 rollout 付费；Harmony Harness（arXiv 2610.15150）把多目标门控压力保持在达成最差的目标上，而不让单目标优化悄悄牺牲其余目标。把任一机制加进双核 RSI 源码，都会把一个研究机制与该模式的核心耦合，并与模式已公开的接缝（“替代提供者无需配置分支即可替换”）相矛盾。

## Decision

`dual-core-rsi-evolution` 是纯插件包：三个运行在既有接缝上的提供者，零改双核 RSI 源码。

- `DomainReplayLedger`（新接缝 `ctx.rsiEvolutionLedger`，自有 `rsi_evolution` 存储域）以产物集的结构指纹为键记录每条蒸馏提案，并把每个基准得分连接到对应行——这就是回放世界。写入是受控的：故障只记日志，循环照常落地。
- `ReplayRsiDistiller` 提供 `ctx.rsiDistiller`：委托前先做梦——从已连接的结果中派生至多 `maxLessons` 条有界教训（重复的相同内容、最强与最弱已记录提案及其得分差、一条前沿综述），追加到任务提示的知识行之后；子代理回答后记录该提案。样本不足的世界不注入任何内容，因此早期周期等于随附提供者。
- `HarmonyRsiBenchmark` 提供 `ctx.rsiBenchmark`：把用例计分委托给在分离 context 上启动的随附 fixture 评估器，把用例划分为配置的目标族，并以 `1 − max_j λ_j·(1 − 达成度_j)` 对报告重新计分——针对乌托点的加权 Tchebycheff 标量化；由于达成度是 [0, 1] 上的比率，它确定且无状态。只优化单一族无法通过门控。

挂载形态：每个装饰器就是所在行的类，与随附行完全同构；内部提供者无法在同一服务名下与装饰器并列挂载，因此构造在分离的 context 上——其对树的唯一依赖（蒸馏子代理的 `subagents` 接缝）被转发进去，其 fiber 随装饰器释放。[演进 bundle](../../../../packages/experimental/dual-core-rsi-evolution-bundle/README.zh.md) 把三行组合为双核 RSI bundle 的替代。

## Alternatives considered

在同一 context 上以再提供方式装饰：被否决，cordis 对同名的第二次 `provide` 直接抛错，而且经装饰器自身 fiber 读取内部服务会解析到装饰器自己（同名的 fiber store 条目是末写者获胜，且在注入驱动的 reload 时被清空）。`ctx.isolate(name)` 作用域：实测后被否决——隔离作用域的条目对外部的向上解析不可见，根上的消费者永远看不到装饰器。修改随附行的 `name`：被否决，补丁中的 name 是断言而非替换。把机制加进双核 RSI 源码：被否决，这会把研究性变动耦合进模式本身，并违反模式文档化的插件接缝。

## Consequences

这些机制保持为可替换的研究插件：替换任一接缝都不需要改双核 RSI，部署可组合演进 bundle 或裸行。Tchebycheff 门控直接回应了真实模型 A/B 中观察到的失败模式——蒸馏子代理为了简洁用例而牺牲其余用例。回放教训每次蒸馏子代理至多 `maxLessons` 条有界行，用户核心零成本。论文中未能迁移的部分：Dream-RSI 的在线 rollout、并行工作者与回放目标（质量-成本超体积减并行惩罚）需要每轮多次候选尝试的发现循环——双核 RSI 循环每轮只结算一个提案；Harmony 的 general/环境特化因子化作用域与组合代理在此接缝没有对应物。账本按插入 FIFO 逐出，因此一个后来变对的被拒方向只会因年龄被遗忘，而不会因相关性。
