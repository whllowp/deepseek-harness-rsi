---
kind: upgrade-guide
description: "双核 RSI bundle 默认按调度运行循环，且不再自动互换双核：通过门槛的候选等待人类的合入决策，并记录到本地 git 台账。"
---

# 双核 RSI 守护化，所有互换都以人类合入决策为门

[English](guide.md) | 中文

## 变更

在 v0.2.1-rc.2 中，实验性的双核 RSI bundle 只有在人类执行 `/rsi run` 或 `rsi_run` 工具时才运行一次蒸馏循环，且基准分数超过阈值的候选会立即互换进活跃策略。

升级后，启用的 bundle 自行运行循环：每 10 分钟一次 tick，只要有新的会话活动等待就启动调度循环；每次尝试有时限，失败通过记录事件加退避重试自愈。通过门槛不再互换任何东西：候选挂起为待合入提议，`/rsi` 会展示它；最后一个活跃会话退出时，守护核通过 user-questions 界面询问一个"合入还是保留"的问题。只有 `/rsi merge` 或"合入"回答会替换策略；每次合入与每次 `/rsi rollback` 都会提交到 `~/.dsh/dual-core-rsi-ledger`（配置键 `ledgerDir`）下的专用本地 git 仓库。直接组合本包的组合还需要 `subprocess` 服务。新增配置键：`daemonEnabled`（默认 `true`）、`daemonIntervalMs`、`daemonMaxRetries`、`daemonRetryBackoffMs`、`cycleTimeoutMs`、`consultTimeoutMs`、`ledgerDir`。新增 `/rsi` 子命令：`merge`、`decline`、`summary`。

## 迁移

1. 若要保留旧的手动循环行为，在 `cordis.yml` 或 patch overlay 的 `dual-core-rsi` 条目上设置 `daemonEnabled: false`；`/rsi run` 与 `rsi_run` 的行为与之前完全一致。
2. 循环之后留意 `/rsi` 的 `Pending merge:` 行。用 `/rsi merge` 或 `/rsi decline` 决策，或回答退出咨询；`/rsi summary` 可预览提议。已存储的世代、归档与循环记录仍可读取；仅本次升级写入的记录会新增 `pending` 结果与决策字段。
3. 确认台账：首次合入后 `git -C ~/.dsh/dual-core-rsi-ledger log` 应显示一条 `rsi merge:` 提交，`policy/guidance.md` 保存采纳的指引。直接组合必须提供 `subprocess` 服务，否则服务在加载时立即报错。
