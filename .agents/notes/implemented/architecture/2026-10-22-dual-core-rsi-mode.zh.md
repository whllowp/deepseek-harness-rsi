# Agent Note: 基于可改进面世代的双核 RSI 模式

Status: implemented

[English](2026-10-22-dual-core-rsi-mode.md) | 中文

## Problem

仓库的 `RSi/` 研究笔记（Harness² 的 Propose–Probe–Compose 总结与 RSI 阅读清单）描述了在固定模型周围优化 harness 的递归自我改进：证据来自执行对比，采纳以可度量的提升为门控。harness 此前没有任何模式能把自身的实时行为蒸馏成策略产物、以基准增量门控采纳，或为回滚归档被替换的策略。所请求的设计还提出了两个核心 —— 服务用户的核心与不交互的守护核心 —— 并在基准提升超过阈值时互换。

## Decision

一个核心是可改进面的一代产物，而不是操作系统进程。`@deepseek-ai/dsh-experimental-dual-core-rsi` 把世代、归档与循环记录保存在 `dual_core_rsi` 存储域；用户核是通过 `agent/created` 上的 `ctx.systemPrompt.section` 与 `ctx.skills.register` 作用域注册应用到每个活跃 agent 作用域的产物集，并在每次互换与回滚时重新应用。守护核是下一次循环所蒸馏的产物集，以每次循环一个无主 `ctx.jobs` 后台作业驱动，模型工作通过 `ctx.subagents` 接缝委托给一个全新结构化输出子代理；因此选用进程外子代理提供者即可把守护核的模型工作移入独立进程而无需新增管道。

蒸馏输入是最新活跃会话的有界摘要（事件类型计数加截断的 `extractSessionEventText` 文本）。蒸馏输出跨模型 JSON 边界，按配置预算防御性解码；违反预算使循环失败而非截断。两个服务接缝承载可插拔角色，各随一个以独立 loader 入口挂载的内置提供者：`ctx.rsiDistiller`（`./distiller-subagent`）与 `ctx.rsiBenchmark`（`./benchmark-fixture`）。fixture 基准以通过权重占总权重之比为配置的策略符合度用例计分；它演示的是门控机制，明确不度量端到端任务质量。

一次循环对活跃代与候选代做基准评估，仅当提升严格超过阈值（默认 0.05）时晋升；晋升时完整归档被替换代（产物加基准证据），推进状态指针，从晋升副本播种下一代守护核，并向活跃 agent 重新应用产物。保留时守护核保留得分更高的谱系。单个操作内所有持久化写入先于最终状态指针写入，因此被中断的互换或回滚只会让先前的核心继续生效，至多留下孤儿记录。回滚恢复一个归档代，并以 `rollback` 原因归档被替换代，因此晋升与回滚皆可逆。交付形式是默认关闭的可选 bundle `@deepseek-ai/dsh-experimental-dual-core-rsi-bundle`（[准入](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)）；循环仅通过 `/rsi run` 或 `rsi_run` 由人类显式请求触发。

## Alternatives considered

**两个 harness 进程交换改进。** 请求措辞提到两个进程，但 harness 用户可见行为的单位是同一组合上的作用域 agent 面；第二个操作系统进程只会增加传输与身份机制而不改变可改进的对象。蒸馏子代理接缝已在关键处提供进程外执行，README 明确陈述了这一映射。

**通过 plugin manager 持久自修改。** 编辑 profile 行或 preset 修订让晋升跨重启持久，却把实验性循环耦合到安装状态，并把回滚变成配置迁移。提示词作用域的产物使每次互换即时可逆，同时保持模型可见，因而以 `system/message` 历史被会话日志记录。

**用 LLM 裁判为候选打分。** 门控需要可复现的证据；模型评分基准不确定且依赖密钥。基准接缝把这一点留给未来基于确定性会话回放的提供者。

## Consequences

该模式是实验性的且默认关闭，因此默认组合不变；启用后只增加一个提示段落与四个模型工具。端到端评估质量是被接受的缺口：内置基准只检查策略符合度，README 的限制清单将这一点列在首位。蒸馏器、基准与摘要都是接缝，后续工作可以在不触碰控制器的情况下新增端到端基准提供者或调度循环。模型可见的策略变更只经作用域提示与技能注册生效，因此每份晋升产物都能从会话历史重建，且不改动任何持久配置。
