---
description: "双核心递归自我改进：守护核把用户核的会话蒸馏成有界的策略产物，经基准评估后按配置的提升阈值互换双核并归档可回滚，面向评估自改进 harness 模式的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-dual-core-rsi

[English](README.md) | 中文

## 概述

`dual-core-rsi` 让 harness 以双核心运行。用户核是普通的交互 agent 面；守护核是一个从不与人类对话的后台蒸馏循环。每个循环摘要最新的用户核会话，通过一个全新子代理蒸馏出一套有界产物（指引行加技能文档），对两个核心做基准评估，超过配置阈值（默认 +5%）时互换双核：蒸馏出的面成为用户核的策略，被替换的面完整归档，守护核从晋升副本重新开始。每个归档都是一个回滚目标，且回滚会把被替换的面再次归档，因此晋升与回滚都可逆。该模式是实验性的：内置 fixture 基准度量策略符合度而非端到端任务质量，内置蒸馏器需要可用的模型。

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

在 Plugins 中启用[双核 RSI bundle](../dual-core-rsi-bundle/README.zh.md)（默认关闭），或在挂载一个 `ctx.rsiDistiller` 提供者与一个 `ctx.rsiBenchmark` 提供者之后直接组合本包。任一提供者缺失时，服务在加载时立即报错。

### 驱动守护核

循环只在人类明确要求时运行。`/rsi run` 启动一次循环并等待它（上限 `runWaitMs`），直接报告结果——采纳、保留、失败或仍在后台；超过等待预算后循环继续在后台运行，稍后用 `/rsi` 查看结果。模型的 `rsi_run` 工具（指引限定为仅在人类明确请求时使用）把同一次循环作为后台作业启动，可通过 job 工具读取。每次循环都会运行一个全新模型子代理并消耗 token。`/rsi` 或 `rsi_status` 以一句平实说明开头，并给出下一步指引（存在归档时包含回滚提示）；`/rsi history` 或 `rsi_history` 列出循环与归档并附恢复命令；`/rsi rollback [<归档 id>]` 或 `rsi_rollback` 恢复一个归档面，并把被替换面再次归档。省略归档 id 时回滚到最新归档。

### 一次循环做什么

守护核为最新的活跃会话组装有界摘要，并在组合了 `ctx.sessionQuery` 时用最近的已关闭会话补满剩余名额——你早已关闭的会话中的知识仍能到达蒸馏器。单会话预算内摘要优先保留最新的文本（会话后期的修正比前期闲谈更有价值），且每次已结算循环（无论晋升或保留）都会刷新知识截止时间。随后要求蒸馏器产出一套完整的下一版产物及其理由，按配置预算解码，对候选与活跃核心做基准评估，并记录结果。提升超过阈值时互换双核并归档被替换面；否则守护核在自己的谱系与候选之间保留更优者进入下一轮。失败或被取消的循环不改变任何状态：持久化写入在评估之后落盘，最后的状态指针写入是提交点。

### 策略何时过期

`/rsi` 与 `rsi_status` 展示知识截止时间（`Knowledge current as of: …`），并统计活动晚于该截止时间的活跃会话数。计数非零时，状态会提示"这些活动尚未进入当前策略"并指向 `/rsi run`，让老化的策略依据证据刷新，而不是无声漂移。

### 配置

| Field | Default | Meaning |
|---|---|---|
| `threshold` | `0.05` | 触发双核互换的基准提升比例。 |
| `maxGuidanceLines` | `16` | 一套产物中指引行的最大数量。 |
| `maxGuidanceLineChars` | `400` | 单条指引行的最大字符数。 |
| `maxGuidanceChars` | `4000` | 指引的总字符上限。 |
| `maxSkills` | `8` | 一套产物中蒸馏技能的最大数量。 |
| `maxSkillDescriptionChars` | `300` | 技能描述的最大字符数。 |
| `maxSkillContentChars` | `8000` | 技能正文的最大字符数。 |
| `digestMaxSessions` | `8` | 一次蒸馏摘要包含的最大会话数。 |
| `digestMaxCharsPerSession` | `4000` | 每个会话摘要文本的最大字符数。 |
| `runWaitMs` | `120000` | `/rsi run` 报告后台继续前等待的毫秒数。 |
| `digestIncludeStoredSessions` | `true` | 是否通过 `ctx.sessionQuery` 让最近已关闭会话加入摘要。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-dual-core-rsi)是所有接受字段的唯一来源。违反任一预算的蒸馏提案会让该循环失败，而不是被截断。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本节解释双核模型、接缝与持久化规则；可观察行为见 [Use this package](#use-this-package)。

### Two cores over one harness

一个核心是可改进面的一代产物，而不是一个操作系统进程：用户核是应用到每个活跃 agent 作用域的产物集，守护核是下一次蒸馏所基于的产物集。守护核的工作以每次循环一个无主后台作业的形式运行在 `ctx.jobs` 上，其模型工作通过每次蒸馏一个全新结构化输出子代理完成，因此选用进程外子代理提供者即可让守护核的模型工作成为独立进程而无需改动本包。服务从不触碰 `agent-loop`；产物通过 `agent/created` 上的 `ctx.systemPrompt.section` 与 `ctx.skills.register` 作用域注册生效，并在每次互换与回滚时重新应用。

### Seams

`ctx.rsiDistiller`（本包内的服务定义）把两代产物加摘要转换成一套完整的下一版产物；内置的 `SubagentRsiDistiller` 提供者按配置路由到一个全新结构化输出子代理提供者，并按预算防御性解码子代理的 JSON。`ctx.rsiBenchmark` 为一套产物打分；内置的 `FixtureRsiBenchmark` 提供者按配置的用例（指引关键词、技能存在性、技能正文、指引简洁度）以通过权重占总权重之比计分。两个提供者各自作为独立 loader 入口（`./distiller-subagent`、`./benchmark-fixture`）挂载，组合层选择提供者，替代实现无需配置分支即可替换。

### Durability and rollback

全部状态保存在 `dual_core_rsi` 存储域：一条单例指针记录、每一代产物、每条归档（被替换代的完整快照含基准证据）、每条循环记录。单个操作内指针写入在最后，因此被中断的互换或回滚只会让先前的核心继续生效，至多留下孤儿记录。回滚把归档代重新发布为活跃核心，并把被替换代以 `rollback` 原因归档，使每次回滚都可以再次回滚撤销。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、循环/互换/回滚控制器、工具、`/rsi` 命令 |
| [`src/types.ts`](src/types.ts) | 各角色共享的领域类型 |
| [`src/branding.ts`](src/branding.ts) | 带品牌的一代、归档、循环 id |
| [`src/domain.ts`](src/domain.ts) | Zod schema 与 `dual_core_rsi` 存储域 |
| [`src/policy.ts`](src/policy.ts) | 产物解码、预算、段落渲染、作用域应用 |
| [`src/digest.ts`](src/digest.ts) | 有界的活跃会话摘要组装 |
| [`src/distiller.ts`](src/distiller.ts) | 蒸馏接缝与子代理提供者 |
| [`src/benchmark.ts`](src/benchmark.ts) | 基准接缝与 fixture 提供者 |
| [`src/render.ts`](src/render.ts) | 工具与命令的纯文本渲染 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。它们从交付层走向控制器消费的接缝，以及该模式背后的研究脉络。

- [Dual-core RSI bundle](../dual-core-rsi-bundle/README.zh.md) — 默认关闭的交付层及其默认 fixture 基准。
- [Storage domain](../../storage/storage-domain/README.zh.md) — 产物、归档与循环所在的持久化形式。
- [Jobs seam](../../jobs/jobs/README.zh.md) — 守护核循环运行所在的后台作业注册表。
- [subagent seam](../../subagent/subagent/README.zh.md) — 内置蒸馏器背后的全新子代理提供者契约。
- [Skill registry](../../skill/skill/README.zh.md) — 蒸馏技能落入的运行时注册表。
- [Harness² 项目总结](../../../RSi/HARNESS2_SUMMARY.md) — 本模式循环所遵循的 Propose–Probe–Compose 框架。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

活跃代作用域内的 agent 只有在晋升产物集有内容时，才收到一个 `rsi:distilled-policy` 段落：指引行列表加每个蒸馏技能一行路由信息。空产物集不添加任何段落。

##### Distilled policy section (example)

```markdown
Distilled working policy for this workspace, extracted by the RSI daemon core from recent sessions.

Guidance:
- verify each edit with focused tests

Distilled skills (load by name through the skill tool):
- verify-before-done: Habit of verifying work before reporting completion
```

#### Token 影响

该段落按其渲染字符数计入每次请求的成本，仅在存在晋升指引时生效；预算将其限制在 `maxGuidanceChars` 加每技能一行。

#### KV Cache 影响

两次互换之间前缀稳定。每次晋升、回滚或产物变化都会重新渲染该段落一次，并使缓存请求前缀自该段落起失效。

### 工具 schema

#### 模型看到什么

生成的 [`rsi_status`、`rsi_run`、`rsi_history`、`rsi_rollback` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-dual-core-rsi) 暴露只读状态、显式请求的循环触发、有界历史与按可选归档 id 的回滚。互换阈值、预算、提供者与存储属于部署层，不出现在 schema 中。

#### Token 影响

工具可见的每次请求有固定的小 schema 成本。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

### 守护核请求

#### 模型看到什么

每个蒸馏子代理只看到其任务提示：两代产物、预算、蒸馏纪律与会话摘要。它从不接收用户对话，其结构化提案是唯一回传的值。本版本的基准评估是确定性的，不发送任何模型请求。

#### Token 影响

每循环一个全新子代理上下文，受摘要与产物预算约束；循环仅在人类明确请求时运行。

#### KV Cache 影响

每个守护子代理拥有独立请求缓存；不影响任何用户核缓存。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了该模式尚未支持的内容。它们是当前约束，不是任务清单。

- **内置基准度量策略符合度而非端到端任务质量** — fixture 提供者检查蒸馏面是否携带配置的策略；基于录制会话按交付物评分的端到端基准通道被推迟，是该模式最大的评估缺口。
- **循环由人类触发** — 没有调度、空闲触发或验收策略自动启动循环。
- **已关闭会话补充依赖 `ctx.sessionQuery`** — 缺少该服务时摘要只覆盖活跃会话；随附的 base 组合提供此接缝。
- **每循环一个蒸馏子代理** — 没有候选并行、探针隔离或本模式所借鉴的 Harness² 方法中的盲选。
- **模型可见的策略变更仅限提示词作用域** — 产物以提示段落与运行时技能生效；该模式从不修改 profile 行、插件配置或文件。
- **互换是代际指针晋升** — 两个核心是同一个 harness 进程上的产物世代，不是两个操作系统进程；只有蒸馏子代理可通过其提供者运行在进程外。
- **蒸馏器需要活跃锚定 agent** — 没有活跃 agent 锚定子代理时，循环以可操作的报告立即失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本 Dev Note 是维护者的工作上下文：尚未决定的方向。它明确不具权威性 — 已交付的行为、限制与被接受的理由存在于上文各节、包代码与链接的 Agent Notes 中。

待定方向：基于确定性会话回放的端到端基准提供者；带验收策略的调度或空闲触发循环；候选并行加探针隔离与盲选；通过 `ctx.sessionQuery` 摘要持久化历史；以及通过 plugin manager 把产物晋升为持久 preset 行。

</details>
