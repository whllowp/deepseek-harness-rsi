# Harness² 项目总结

> Recursive Agent Harnessing for an Open World
> (Google, arXiv 2610.14224, Apache 2.0)

**Harness²** 是一个"递归智能体线束优化"框架:**模型权重固定不动,被优化的是模型周围的系统**——系统提示词、护栏、记忆、技能、脚本、子代理、插件等八类组件(统称 harness)。

它在开放世界(设计时未见过的任务)上,让模型自己:

1. 提出对 harness 的修改(Propose);
2. 在同一任务上真实试跑每个候选(Probe);
3. 从执行行为的**对比**中合成改进版 harness(Compose)——全程**不需要评分器或 ground-truth 反馈**。

实测收益(README):WorkBench 最高 **+11.5**、JobBench **+4.5**、LAB 部分通过率 **+11.8pp**(GLM-5 / Gemini 3.5 Flash,单步递归)。

---

## 目录

- [一、架构:三轴严格分离](#一架构三轴严格分离)
- [二、原理:Propose–Probe–Compose 对比学习](#二原理proposeprobecompose-对比学习)
- [三、RSI 关键设计(两级递归)](#三rsi-关键设计两级递归)
- [四、系统提示词](#四系统提示词)
- [五、运行方式速览](#五运行方式速览)
- [六、一句话总评](#六一句话总评)

---

## 一、架构:三轴严格分离

`harness2/core/spec.py:15` 点明设计哲学:"**benchmark 只供给接缝,不多给一样**"。三轴各自是纯数据/协议,互不依赖:

| 轴 | 目录 | 职责 |
|---|---|---|
| **方法 (method)** | `harness2/core/` | 递归调度、提示词、证据打包、盲选、经验库——完全不感知具体基准 |
| **基底 (substrate)** | `harness2/substrate/` | agent 执行框架适配:OpenCode(默认 `oc`)与 Codex(`cx`),各实现 `Substrate` 协议(`surface / materialise / execute / read_trajectory / preflight`) |
| **基准 (benchmark)** | `harness2/benchmarks/` | JobBench(jb)、LAB(lab,法律)、WorkBuddy-Bench(wb),各实现 `BenchmarkAdapter` 协议(任务列表、执行、轨迹渲染、交付物提取、评分) |

### 1.1 关键机制

- **`BenchSpec` / `BenchPrompts` 是值,不是代码路径**(`spec.py:133`)
  基准差异全部以数据槽位(`work`、`inv_levers` / `dom_levers`、`yardstick`、`deliverable_word`、`domain_guidance`)注入共享提示词——阶段提示词在所有基准上**逐字节相同**。构造期校验拒绝任何含 `rubric / grader / score / evaluation / benchmark` 字样的基准描述("描述工作本身,不是它的度量")。

- **`SurfaceSpec`**(`tree.py:41`)
  把两个 agent 框架的可编辑面差异参数化:
  - OpenCode:4 个 always-on 文件(`systemprompt.md` / `guardrails.md` / `LongTermMEMORY.md` / `tool_descriptions/tool_guidance.md`)+ `skills/` + `sub_agents/` + `scripts/` + `plugin/*.ts`
  - Codex:唯一 always-on 文件 `AGENTS.md` + `.agents/skills/` + `sub_agents/` + `scripts/` + `.codex/hooks.json`

  读、写、校验、diff 逻辑只写一份。

- **Proposer**(`proposer.py`)
  "改进器"agent 会话跑在隔离临时工作区;双通道——`claude_cli`(Anthropic 模型走 Vertex)与 `opencode`(bun 直跑 OpenCode 源码);带**内容寻址缓存**(label + mission + system + 整个 context 目录的 SHA-256 指纹)、审计落盘(mission / system / response / meta / workspace)、信号量限并发、剥离可疑环境变量。

- **证据即文件**(`context.py`)
  证据以文件树形式提供给模型,提示词只是一个短指针——**没有任何内容为凑 prompt 预算而被截断**:

  ```
  context/task.md                  任务原文(已剥除评分标准)
  context/source/                  任务源材料
  context/rollouts/<label>.md      完整轨迹(共享 [ACTION]/[OBSERVATION]/[ERROR] 语法)
  context/deliverables/<label>/    每个 rollout 实际产出
  context/harness/                 正在被编辑的 harness 树
  context/pool/<label>/            候选 harness + 其 rollout(仅组合/选择阶段)
  context/library/                 本领域更早任务采纳的 harness(浏览 INDEX.md)
  context/decisions/               更早编辑器的决策笔记
  ```

- **CLI 分层**:`harness2`(精炼)→ `harness2-judge`(评分,只在选择提交后才调用)→ `harness2-report`;另有 `harness2-setup` / `harness2-check` / `harness2-demo`。run 目录按 `<bench>-<substrate>-<mode><k>[-s<seed>][-tag]/<task>/<label>` 命名,幂等、可断点续跑(fingerprint 校验后才允许 resume)。

- **`RunView` 永不携带分数**(`spec.py:177`):方法层只知道 rollout 是否 ok / 是否交付了制品;分数只存在于 judge 阶段。

---

## 二、原理:Propose–Probe–Compose 对比学习

单任务流水线(`schedule.py:566` `run_task`):

```
k 次 base 执行(共享,两种模式复用)
        │
        ▼
┌───────────────────── 任务级递归(recursion.py)─────────────────────┐
│  Propose: 2k 个编辑器会话 = k 个 INV(不变式) + k 个 DOM(领域)      │
│           各自读同一证据树,直接改 context/harness/ 里的文件          │
│  Probe:   每个候选 harness 在同一任务上真实执行一次                  │
│           无效提案 → 错误逐字回灌,重试 1 次,再败则继承当前 harness  │
│  Compose: k 个聚合器读全部证据(harness+轨迹+产出+决策笔记)          │
│           按轨迹中可命名的时刻裁决每条 edit → 合成最终 harness        │
└──────────────────────────────────────────────────────────────────┘
        │
        ▼
盲选(selection.py):k 个最终产出匿名化(A/B/C…),选择器只看交付物
        │
        ▼
采纳 → reflect_adoption 反思 → 经验写入领域库(library.py)
```

### 2.1 两个正交维度

- **INV(不变式)**:管 agent *怎么工作*——工具使用、流程、完成判定、预算纪律。不写领域事实。
- **DOM(领域)**:管*从业者知道什么*——交付物契约、决策规则、领域检查。不碰命令、重试、脚本、hooks。

两维各自提案、各自探针,组合阶段再合并——职责切割让每类失败匹配最廉价的有效组件。

### 2.2 信号 = 执行对比,不是分数

提示词明确教编辑器读证据的方法:

- **复制体之间的方差才是信号**:所有 rollout 都做对的事,harness 已经在决定行为,不用管;rollout 之间**分叉**的地方(一个写了文件另一个没写、一个把预算烧在重试上)才是 harness 把决策留给运气的地方。
- 跨 base **重复出现的失败**是 base harness 的真实属性,是最强证据;**1/k 出现的缺陷是噪声**,针对它改就是过拟合单样本。
- 每条 edit 必须能**点名轨迹中的具体时刻**;点名不了的 edit 是投机,"花上下文买不来任何东西"。
- 修复优先序:**分叉 > 重复的具体失败 > 轨迹里可见但未实现的风险**;已做对的事不要修,harness 已说清的话不要复述("重复指令稀释其余指令")。

---

## 三、RSI 关键设计(两级递归)

### 3.1 任务级递归:宽度 vs 深度

两种模式都消耗 4k 次 rollout + 3k 个改进阶段(含共享 base 执行):

| 模式 | 机制 | 特性 |
|---|---|---|
| **Parallel**(`--mode parallel`,磁盘令牌 `agg`) | 2k 个 iid 候选并行探针 → k 个**独立**组合器各产出一个 final(`agg1..aggk`) | **探索更宽** |
| **Sequential**(`--mode sequential`,磁盘令牌 `seq`) | k 轮 Propose–Probe–Compose;第 t 轮组合出 checkpoint `c_t`,下一轮在 `c_t` 上继续,证据池携带全部历史轮次 | **挖得更深** |

串行模式的组合器额外被允许:跨轮合并(包括复活早前被拒的候选)、**逐字复现任一更优的早期 checkpoint**、KEEP_BASE(保持*当前* checkpoint,而非回滚原始 harness)。

### 3.2 Harnessing 级递归:跨任务经验库

采纳之后,`reflect_adoption`(`selection.py:402`)触发一次反思会话,读取完整记录(所有候选 harness 对 base 的 diff、全部轨迹、选择理由),产出两份结构化记录:

**`<edits>` 表**——每个被改组件一行:

```
component: <组件名>
candidates: <携带此 edit 的候选标签>
change: <edit 实际改了什么>
observed: <执行上观察到的差异,以及在哪里看到>
verdict: helped | hurt | no observed effect | confounded
```

判定纪律:**confounded 优先**——候选同时改了多个组件而无执行能隔离归因、或只有单条 rollout 支撑时,宁写 confounded 也不编造归因。"编造的归因会毒化之后每个任务的库。"

**`<experience>`**——至多**一条**可迁移 lesson:

```
cue:        适用情境的"形状"(不是本任务的事实)
lesson:     对 harness 的可执行操作,必须点名组件
evidence:   引用 edits 行,及执行对比
confidence: high | medium | low,及原因
```

- 只靠 confounded 行支撑的 lesson 必须收窄或拒绝(写 `NO_ENTRY`);**"被采纳"本身永远不能证明一条 edit 有效或可迁移**。
- 泛化刻度:太泛无用("be thorough"),太特化不会再触发("fee rose to 250 on Jan 1");目标在中间——"当文书包含多个连续行为且其中一个终止授权时,把终止行为排在最后"。

**入库与检索**(`library.py`):

```
<runs>/<run-tag>/<mode>/<domain>/INDEX.md
<...>/<domain>/harnesses/<task>/harness/<rel>    完整采纳的 harness 树(整体携带,不是摘要)
<...>/<domain>/harnesses/<task>/EXPERIENCE.md    为何被采纳 + lesson
```

- 检索即构造:域目录只含同域条目,不做向量检索;`INDEX.md` 从磁盘状态重建。
- 下个同域任务的编辑器把**整个库**当作证据的一部分;提示词要求:复用组件必须**复制**进 `context/harness/`,且**重新验证其工作区事实**——"在那里是事实,在这里是假设"。
- 库按 benchmark / substrate / mode / k / seed 隔离,每个 sweep 从空库开始——保证 continual-learning 顺序可复现(种子洗牌只依赖 (seed, domain, task set),与 dict 顺序、PYTHONHASHSEED 无关)。

### 3.3 盲选(采纳的裁判)

- 候选池 = **恰好 k 个 final**(`agg1..aggk` / `c1..ck`);base 不在池中——"不可弃权由构造保证"。
- 匿名 id 由 canonical 排序 + seeded shuffle 生成,重跑稳定;**选择器只看交付物**,看不到 harness、看不到运行过程。
- 匿名块直说:"id 是任意的、乱序的;有的运行用了未修改 harness,有的用了改过的,不告诉你哪个是哪个——**选未修改 harness 的产出是完全合法且预期的结果**;没有 credit 给更精巧的候选。"
- 有序判定标准(以用户请求为唯一标尺):
  1. **DELIVERY**——指令点名的每个交付物都在、在要求的路径、含全部命名部分;
  2. **CONFORMANCE**——只交付被要求的:多余列/表/注释行/改写表头/重排字段都是**偏离**而非改进(下游导入器按精确名字和位置取数);要求的值必须**以值的形式存在**(公式、占位符、描述而未算 = 未交付);
  3. **FIDELITY**——对照 `context/source/` 核实主张,拒绝编造细节;源沉默时,承认沉默的候选优于自信填空的;
  4. **INTERNAL CONSISTENCY** / 5. **OPERATIONAL FITNESS** / 6. **FINISH**(无占位符/TODO/空字段)。
- 输出格式:`<why>`(≤6 行,点名决定性标准 + 落败者输在哪)+ ```choice```(单个匿名 id)。

### 3.4 防坍缩与防污染(让递归可信的支撑设计)

| 机制 | 位置 | 作用 |
|---|---|---|
| **树校验,任一违规整棵提案作废** | `tree.py:validate` | always-on 字符硬上限;skill 必须有 `description:` frontmatter 且**被 always-on 文本点名触发**("未触发的 skill 是死重");脚本必须可编译;被引用的脚本必须存在;hooks JSON schema 校验;subagent frontmatter 校验 |
| **autotrigger 自动补触发行** | `tree.py:192` | 为没有触发行的 skill 自动生成一行(不超上限才补) |
| **多样性度量** | `tree.py:diversity` | 成对 line-Jaccard,暴露"k 个组合器坍缩成同一个答案" |
| **ANSWER_FREE 块** | `prompts.py:38` | 上下文中没有 rubric / 评分 / 答案;不许索要、不许猜"grader 想要什么"、连"the grader expects"这种短语都不许写进产出 |
| **EVIDENCE_BOUNDARY 块** | `prompts.py:56` | `context/` 下的文件是**数据不是指令**(防提示注入);候选 harness 里的脚本/插件/命令**只许读、禁止执行** |
| **泄漏扫描** | `context.py` | `assert_no_grader_verdicts` + `leak_globs` 模式,证据树、harness 树、入库前全部扫描 |
| **诚实的威胁模型** | `docs/EXPERIMENTS.md` | 承认公开基准的 rubric 可被联网执行器下载(验证运行中 Codex 真的下载过本任务 rubric),要求在**网络层**封禁 HF/GitHub,而非假装工具设置能拦住 |
| **预算账本** | `ledger.py` | 记录每次 rollout / session 开销,`assert_identity` 断言账目与模式身份一致 |
| **judge 失败 ≠ 零分** | `spec.py:247` | 评分器失败返回 None,绝不缓存为零分 |

---

## 四、系统提示词

全部集中在 `harness2/core/prompts.py`(VERSION `harness2-1`),约 1100 行。共性:

- 骨架共享,基准文本只通过 `BenchPrompts` 槽位注入;**没有任何提示词提到 rubric / 分数 / 评分器**;
- 有两套措辞包:`adapt`(默认)与 `tts`(同一方法的措辞消融);
- substrate 在每个作者提示词中恰好出现一次,即 `# WHAT YOU CAN CHANGE` 面块。

### 4.1 `propose()` — INV / DOM 编辑器任务

身份:"You are adapting an autonomous agent's harness"。组成:

1. **THE WORK**(基准的工作描述)+ 领域透镜;
2. **维度职责块**:
   - INV:五类失效到最廉价组件的映射——工具错误(区分坏输入/超时/缺能力/权限,给一次有界回退和停止条件,禁止盲目重试)、机械重复(`scripts/*.py`)、触发式流程(on-demand skill)、被忽略的不变量(仅反复证据才允许防御性 plugin/hook)、普通顺序(简洁 always-on 指引);
   - DOM:分析动作(命名操作+输入+必需结果)、制品契约、决策规则;两条硬规则——"绝不发明权威/标识符/标准/引用"、"写可应用可检查的知识,不写背景阅读";
3. **GENERALIZE**:本工作区**验证过的事实**是最有价值的编码物——"写事实本身,而非重新发现它的过程";流程则为整个领域写;工作区事实要锚定("in this workspace…"),领域库要复制过来并重新验证;
4. **HOW TO DECIDE**:每条 edit 必须能点名轨迹时刻;修复优先序(分叉 > 重复失败 > 未实现风险);"不要对冲到平均值——提交你维度上最可辩护的那一版,后一阶段会比较与合并";
5. **ANSWER_FREE + EVIDENCE_BOUNDARY + Surface 块**。

### 4.2 Surface 块(`_SURFACE_OPENCODE` / `_SURFACE_CODEX`)— 工程含金量最高

- 八组件按"**何时进上下文**"定价的表格(always-on = 每次 run 都在、每个 token 都在与产出预算竞争;skill = 按需加载,调用前零成本;plugin/hook = 在 tool loop 内生效)。
- 核心经济律:"**always-on 文字是最贵的选项**——这类工作最贵的失败是模型把预算烧在推理上而零产出,加散文让这*更*可能";优先序 **SKILL > SCRIPT > SUBAGENT > PLUGIN/HOOK > ALWAYS-ON**(加 always-on 必须删别的来付账)。
- "plugin/hook 是唯一在 tool loop 里、模型跳不过去的组件——**散文可以不读,hook 不行**";四个典型形态:裁剪噪声工具输出、错误签名后追加针对性提示、封顶失控工具、写后立即验证。
- 三条一票否决(校验在任何 rollout 之前跑,失败整棵作废):①每个 skill 必须有触发行("最常被违反的规则,大幅领先");②always-on 文本禁止 Jinja 模板花括号(StrictUndefined 渲染,`{{` 会杀掉整个任务);③引用的每个脚本必须随提案附带。
- "**交付物的形状属于请求,不属于你**":不得加解释性列、重命名表头、在制品里展示推导——那是改了*交付什么*而不是*怎么干活*。
- **编辑即提案**:"磁盘上的编辑就是提案,没有别的格式要在回复里复现;回复里写的任何东西都不改 harness。"

### 4.3 `aggregate()` — 组合器

"你是集成法官与合成器,**你产出的就是被采纳的**……合并一条 edit 不能给它洗白。"要点:

- 候选被独立采样但共享任务、证据、可能有同样的模型偏置——"一致是支持,不是独立证明;矛盾是去查轨迹的理由,不是投票";
- **每个候选只有一条 rollout,单次好坏都是弱证据**;edit 赚得席位靠轨迹中"具体的机制时刻";
- "把下行风险看得和上行收益一样重:最贵失败是零产出;帮了一条 rollout 却在别处赌上空输出的 edit 是坏 edit";
- **任何关联 rollout 零产出 → 该 edit 显式标注且默认 UNSAFE**;
- 合法结果:跨候选 MERGE(解决重叠而非拼接)/ 整体采纳单一候选 / KEEP_BASE;
- `<notes>` 每行固定格式:`kept|revised|dropped -> <哪条 edit> -> <证据:轨迹时刻或 base 集合模式,含计数>`——"没有证据 attached 的决策是下一个读者无法审计的决策。"

### 4.4 `compose_round()` — 串行每轮

组合 checkpoint `c_t`;可跨轮合并(包括复活早前被拒候选)、逐字复现更优早期 checkpoint、采纳本轮最佳、KEEP_BASE(=保持当前 checkpoint)。

### 4.5 `select()` — 盲选

见上文 3.3。匿名块 + 七条有序标准 + `<why>`/```choice``` 输出格式;"长度和精致本身不是优点;更短、正确、完整、形状精确的答案胜过更长、有缺口或有画蛇添足的答案。"

### 4.6 `experience()` — 反思

"**被采纳的候选不是唯一证据**:选择比的是交付物且 harness 对选择器隐藏,所以裁决说明哪个产出读起来最好——不说明哪条 edit 有效。把每个候选都当证据;读轨迹,别读裁决。"输出 `<edits>`(四判定)与 `<experience>`(cue/lesson/evidence/confidence),无可靠对比则 `NO_ENTRY`。

---

## 五、运行方式速览

```bash
# 安装(Linux + Python 3.12 + uv)
uv pip install -e '.[render]'
harness2-demo --output runs/demo --k 2      # 无需模型凭证的本地演示

# 模型基准
harness2-setup lab && harness2-check --bench lab
harness2 --bench lab --k 1 --mode parallel \
  --only-domains antitrust-competition --max-tasks 1
harness2-judge --bench lab --k 1 --mode parallel
harness2-report --bench lab --k 1 --mode parallel

# 参数
--k K --mode parallel     # 探针 K 个 INV + K 个 DOM 候选,K 个组合
--k K --mode sequential   # K 轮连续精炼
--substrate cx            # Codex 执行器(默认 OpenCode)
--workers N               # N 个域并发(域内任务保序)
```

结果落在 `runs/<bench>/`,含任务摘要、交付物、采纳的 harness、反思笔记、评分;重复同一命令即续跑;judge/report 必须与精炼用完全相同的 bench/executor/subset/k/mode/seed。

---

## 六、一句话总评

Harness² 把"自我改进"从常见的"改代码 / 改权重"换成了**改线束**:用一个固定骨架(八组件树 + 校验器)把改进空间约束成可验证的文件编辑,用**同任务真实执行的对比信号**替代评分器,用**匿名盲选 + confounded 归因纪律 + 无 rubric 约束**压制 reward hacking 与经验库污染,再用**领域经验库**把单任务收益滚动成跨任务复利。

其 RSI 设计的三个关键决策:

1. **信号来自执行对比,而非分数**——Propose–Probe–Compose 在同一任务上做受控 A/B,方差与重复失败是证据,单样本是噪声;
2. **改进对象是受校验约束的声明式树**——省略即继承、一票否决校验、always-on 定价,让"提案"永远可机械验证、可 diff、可复现;
3. **经验的入库门槛是证据支持的归因,而非"被选中"**——confounded 优先、至多一条 lesson、cue 描述情境形状,毒化库的条目在源头就被拒之门外。
