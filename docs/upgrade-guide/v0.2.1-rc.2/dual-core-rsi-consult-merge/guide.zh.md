---
kind: upgrade-guide
description: "双核 RSI bundle 现在无需用户输入即在后台自我进化，每次采纳都记录到本地 git 台账，并在左侧边栏展示每次进化与修复。"
---

# 双核 RSI 在后台自我进化，并在侧边栏展示工作过程

[English](guide.md) | 中文

## 变更

在 v0.2.1-rc.2 中，实验性的双核 RSI bundle 只有在人类执行 `/rsi run` 或 `rsi_run` 工具时才运行一次蒸馏循环，且基准分数超过阈值的候选会立即互换进活跃策略。

升级后，启用的 bundle 无需用户输入即自我进化：每 10 分钟一次 tick，只要有新的会话活动等待就启动调度循环；每次尝试有时限，失败通过记录事件加退避重试自愈；通过门槛的候选在后台直接被采纳——被替换面归档、产物向活跃 agent 重新应用，并提交到 `~/.dsh/dual-core-rsi-ledger`（配置键 `ledgerDir`）下的专用本地 git 仓库。每次进化与修复还会出现在 bundle 为 Web 客户端左侧边栏新增的“自进化”面板中。直接组合本包的组合还需要 `subprocess` 服务。新增配置键：`daemonEnabled`（默认 `true`）、`mergePolicy`（默认 `auto`；`consult` 恢复退出时的合入询问）、`daemonIntervalMs`、`daemonMaxRetries`、`daemonRetryBackoffMs`、`cycleTimeoutMs`、`consultTimeoutMs`、`ledgerDir`。新增 `/rsi` 子命令：`merge`、`decline`、`summary`。

## 迁移

1. 无需任何启用：升级后只要 bundle 开启，守护核就会自行循环、修复与采纳。若希望采纳前有人工门控，在 `cordis.yml` 或 patch overlay 的 `dual-core-rsi` 条目上设置 `mergePolicy: consult`；若希望完全手动循环，设置 `daemonEnabled: false`——`/rsi run` 与 `rsi_run` 的行为与之前完全一致。
2. 在 Web 客户端左侧边栏的“自进化”面板中查看每次进化与修复，或用 `/rsi history` 查看完整记录。`/rsi rollback` 可恢复任何归档策略。已存储的世代、归档与循环记录仍可读取；仅本次升级写入的记录会新增 `pending` 结果与决策字段。
3. 确认台账：首次自动采纳后 `git -C ~/.dsh/dual-core-rsi-ledger log` 应显示一条 `rsi merge:` 提交，`policy/guidance.md` 保存采纳的指引。直接组合必须提供 `subprocess` 服务，否则服务在加载时立即报错。
