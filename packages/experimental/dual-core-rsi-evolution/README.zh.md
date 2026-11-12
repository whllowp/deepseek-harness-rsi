---
description: "双核 RSI 演进插件：Dream-RSI 式回放蒸馏器在记录的提案/得分结果上做梦，Harmony-Harness 式多目标基准以 Tchebycheff 门控把压力压在最差目标上，外加共享回放账本、按预测可靠性门控做梦的世界模型（arXiv 2610.13912），以及把每轮落为 JSONL 日志与拓扑图的轨迹运行器——全部经由既有双核 RSI 接缝挂载，不改双核 RSI 源码。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-dual-core-rsi-evolution

[English](README.md) | 中文

## 概述

`dual-core-rsi-evolution` 经由[双核 RSI 模式](../dual-core-rsi/README.zh.md)的提供者接缝（而非其源码）演进该模式：Dream-RSI 式（arXiv 2609.14858）回放蒸馏器把每条已记录提案与其后续基准得分当作回放世界，在每次蒸馏前于该历史上做梦，并把实际结果作为教训注入；Harmony 式（arXiv 2610.15150）Harmony 基准把用例族按目标计分并以加权 Tchebycheff 标量化，门控的压力始终压在达成最差的目标上。RSI-Anything 式（arXiv 2610.13912）世界模型审判回放模型自身——每次蒸馏记录一条预测，每个连接的得分即其观测，预测-观测对的滑动窗口分类可靠性并把做梦置于条件适配之后；轨迹运行器驱动组合循环的有界轮次，把每轮落为持久行、JSONL 日志与拓扑图。全部挂载在既有提供者的确切位置；[演进 bundle](../dual-core-rsi-evolution-bundle/README.zh.md) 负责组合。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在插件中启用 [双核 RSI 演进 bundle](../dual-core-rsi-evolution-bundle/README.zh.md) 以替代双核 RSI bundle（二者只挂其一），或直接组合本包：先挂 `./evolution-ledger`，再以 `./harmony-benchmark` 替代 fixture 基准行、以 `./replay-distiller` 替代 distiller-subagent 行，再在账本旁挂 `./world-model`，最后挂双核 RSI 服务；`./trajectory` 可选，驱动自己的轮次而非守护进程。账本与世界模型依赖 `storageDomain` 服务；各提供者依赖账本。其余——会话、投影、存储、作业——与双核 RSI 模式已需要的组合完全一致。

### 回放账本

回放蒸馏器执行的每次蒸馏都记录一行提案，以产物集的结构指纹为键：理由、第一行指引、产物形状、内容是否与当时活跃策略相同、以及当时活跃策略的已记录得分。Harmony 基准执行的每次评估都把得分连接到被评估内容的那一行。相同内容的重复 upsert 同一行，超过 `maxProposals` 逐出最旧行，账本落在自己的 `rsi_evolution` 存储域里——从不加入循环提交。

### 蒸馏前做梦

每次蒸馏前，回放蒸馏器重放世界：得分已连接的行成为结果，并从中派生至多 `maxLessons` 条教训，追加在控制器自有知识行之后——当活跃策略的完全相同内容被反复重提时注入一条拒绝教训；一条洞察点名最强已记录提案及其相对活跃策略的得分；一条拒绝点名最弱已记录方向；一条前沿综述统计有多少提案高于同代活跃策略。样本不足的世界不注入任何内容，因此最初几个周期与随附提供者的行为完全一致。子代理回答之后，提案进入账本，等待随后的得分。

### 轨迹记录

`./trajectory` 挂载 `ctx.rsiEvolutionTrajectory`：每轮 `runRounds` 经组合控制器启动一个守护循环，快照活跃策略的目标达成度与最大加权缺口（Tchebycheff 压力方向），并结算一行持久记录加一行 JSONL。失败的一轮照常记录，其余轮次继续，因此十轮留下可回放的日志和一幅晋升与保留的拓扑图。

### 世界模型门控

`./world-model` 挂载 `ctx.rsiWorldModel`：归属当前策略版本的预测-观测对滑动窗口被分类为 `reliable`、`unreliable` 或 `insufficient`——少于 `minPairs` 的窗口是不足的，且绝不当作可靠性的证据；充足窗口的平均绝对误差超过 `errorThreshold` 即不可靠。不可靠窗口触发条件适配：做梦转入保守准入，压制其方向性教训、改为注入一条世界模型警告，直到稍后的可靠窗口结束该适配。

### Tchebycheff 门控

Harmony 基准把用例计分委托给随附 fixture 评估器，然后对报告重新计分：配置的 `objectives` 把用例集划分为命名族，每族达成度为其通过权重除以总权重，得分为 `1 − max_j λ_j · (1 − 达成度_j)`——针对乌托点的加权 Tchebycheff 标量化。达成度是 [0, 1] 上的比率，因此无需状态、得分保持确定。一个单目标强、另一目标弱的提案得分低于均衡者：门控无法靠只优化单一族通过，这正是本插件借鉴的 Harmony 结论。未配置 `objectives` 时，一个 `general` 族覆盖所有用例，得分等于 fixture 自身。每个目标还会以合成用例形式出现在报告中，携带其达成度，`/rsi` 输出与任何基准消费者都能看到各族。

### Config

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxProposals` | `200` | 回放账本保留的最大行数（逐出最旧）。 |
| `subagentProvider` | `spawn` | 守护子代理的新鲜结构化输出提供者（转发给随附蒸馏器）。 |
| `maxLessons` | `3` | 一次蒸馏注入的回放教训上限。 |
| `minSamples` | `2` | 注入任何教训前所需的最小已连接结果行数。 |
| `cases` | — | 转发给随附 fixture 评估器的用例定义（与 fixture 基准同形）。 |
| `objectives` | `[]` | 用例集上的目标族：唯一名称、正权重、划分用例子集的用例列表。为空表示单一 `general` 目标。 |
| `rounds` | `10` | 轨迹运行器的默认轮数。 |
| `window` | `5` | 世界模型评估窗口内的预测-观测对数。 |
| `minPairs` | `3` | 非不足可靠性判定所需的最小连接对数。 |
| `errorThreshold` | `0.2` | 充足窗口被判不可靠的平均绝对误差阈值。 |

### Model Experience 审计说明

回放教训与蒸馏策略按设计是模型可见的；见 [Model Experience](#model-experience)。

<a id="understand-the-implementation"></a>
## 理解实现

| 路径 | 职责 |
|---|---|
| [`src/ledger.ts`](src/ledger.ts) | `ctx.rsiEvolutionLedger` 接缝与按内容的提案/得分持久连接 |
| [`src/replay-distiller.ts`](src/replay-distiller.ts) | `ctx.rsiDistiller` 提供者：做梦、委托、记录 |
| [`src/harmony-benchmark.ts`](src/harmony-benchmark.ts) | `ctx.rsiBenchmark` 提供者：族达成度与 Tchebycheff 得分 |
| [`src/world-model.ts`](src/world-model.ts) | `ctx.rsiWorldModel` 接缝：预测可靠性与条件适配 |
| [`src/trajectory.ts`](src/trajectory.ts) | `ctx.rsiEvolutionTrajectory` 接缝：有界轮次、JSONL 日志与拓扑图 |
| [`src/domain.ts`](src/domain.ts) | `rsi_evolution` 存储域 |

装饰器无法在同一服务名下与随附提供者并列挂载，因此各自在分离的 context 上启动内部提供者：fixture 评估器不触碰任何树服务，子代理蒸馏器则把树的 `subagents` 接缝转发到其分离 context 上。两个内部生命周期都随装饰器释放。提供者的账本写入是受控的：故障只记日志，裁决或提案照常落地。

<a id="further-exploration"></a>
## 进一步探索

- [`dual-core-rsi`](../dual-core-rsi/README.zh.md) — 这些插件所演进的模式。
- [`dual-core-rsi-evolution-bundle`](../dual-core-rsi-evolution-bundle/README.zh.md) — 组合好的 profile 层。
- Dream-RSI：[arXiv 2609.14858](https://arxiv.org/abs/2609.14858) — 发现历史作为回放模拟器。
- Harmony Harness：[arXiv 2610.15150](https://arxiv.org/abs/2610.15150) — 多目标、可组合的 harness 演进。
- RSI-Anything：[arXiv 2610.13912](https://arxiv.org/abs/2610.13912) — 以预测可靠性门控递归自我改进的世界模型。

<a id="model-experience"></a>
## 模型体验

### 系统提示

#### 模型看到什么

回放蒸馏器不向系统提示添加任何内容。它的教训作为额外 `knowledge` 行随蒸馏子代理的任务提示 travel——在控制器自有行之后；子代理是只接收任务提示的全新子代理。Harmony 基准不添加任何模型可见内容：计分只供给互换门控，不进入提示。

##### Replay lessons（仅出现在蒸馏子代理的任务提示中）

```markdown
- [rejection] replay: proposing the active policy's exact content was recorded 1× and settled without improvement; distill structurally different guidance or skills.
- [insight] replay: the strongest recorded proposal scored 0.900 against active 0.200; its opening guidance was: "run npm test before declaring done"
- [rejection] world model: replay predictions are unreliable over the current window (mean error 0.400); treat replay-derived guidance as weak evidence and require fresh benchmark outcomes before trusting a direction.
```

#### Token 效应

每次蒸馏至多 `maxLessons` 条有界行（每条 240 字符），仅存在于子代理任务提示中；用户核心的请求永远看不到它们。

#### KV Cache 效应

对用户核心无影响。每个蒸馏子代理都是全新上下文，教训只按其字符数花费一次。

### 工具 schema

#### 模型看到什么

无新增 schema。本包不注册任何工具；[双核 RSI 工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-dual-core-rsi)不变，其展示的基准得分现在是 Tchebycheff 得分。

#### Token 效应

与双核 RSI 模式一致。

#### KV Cache 效应

与双核 RSI 模式一致。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- **得分度量的是部署基准，而非端到任务质量**——回放教训优化的是与所组合基准的一致性，与随附模式完全相同。
- **无候选并行与预算扫描**——Dream-RSI 的在线 rollout、并行工作者与回放目标（质量-成本超体积减并行惩罚）需要每轮多次候选尝试的发现循环；双核 RSI 循环每轮只结算一个提案，因此今日只有该框架的离线回放教训这一半适用。
- **未建模因子化演进**——Harmony 的 general/环境特化组件作用域与其组合代理在此没有对应物；迁移到本接缝的是目标轴。
- **账本不会遗忘后来变对的被拒方向**——逐出按插入 FIFO 而非相关性；在某个工作负载显出需求之前，相关性排序的世界被推迟。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

待定方向：每轮多次候选尝试、带回放目标的候选并行（Dream-RSI 中需要发现循环的那一半）；相关性排序的回放世界；Harmony 式的作用域因子化演进与组合代理；以及从结果中学习基准族权重而非手工配置。
</details>
