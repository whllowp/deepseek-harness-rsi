# Agent Note: 默认后台自我进化与侧边栏活动面板

Status: implemented

[English](2026-11-02-dual-core-rsi-background-evolution-panel.md) | 中文

## Problem

[咨询制合入的设计](2026-10-28-dual-core-rsi-daemon-consult-merge.zh.md)让守护核按自身调度运行，但任何通过门槛的候选在替换策略前仍需要人类回答或 `/rsi merge`，而守护核工作的唯一可见途径是 `/rsi` 命令与模型工具。请求的行为要求完全无需用户输入的自我进化——在后台进化与修复——并要求每一次进化与每一次修复都在 Web 客户端左侧边栏中可见。

## Decision

`mergePolicy` 选择采纳方式。默认 `auto` 在产生候选的循环内直接采纳通过门槛的候选：一个共享的采纳核心归档被替换策略、翻转活跃指针、保留更优的守护谱系，并向活跃 agent 重新应用产物；循环记录被标为 `promoted` 且决策为 `merged`，git 台账提交采纳的世代。`consult` 保留挂起候选流程、退出咨询以及 `/rsi merge` 与 `/rsi decline` 决策；`auto` 下从不运行退出咨询。每次采纳、拒绝、回滚与记录的事件都在其持久提交之后发出 `dual-core-rsi/changed`。

服务变为 Typert Remote 服务，暴露一个读取接口 `activity`：最新 20 次已采纳的进化（理由、分数、触发方式、采纳时间、指引行、技能名）与最新 20 条自我修复事件。实验性客户端包 `@deepseek-ai/dsh-experimental-client-ui-rsi` 自行挂载该生成的 Remote，并注册一个 `sidebar.panellist` 入口与一个 keyed `main` 面板来列出这两类内容。bundle 在 Host 行旁插入该客户端行，因此启用 bundle 会添加面板，停用则两者一并移除。

## Consequences

启用的 bundle 现在会在基准门槛通过时未经审阅地替换工作策略；归档、`/rsi rollback` 与 git 台账是恢复路径，`mergePolicy: consult` 可恢复人工门控。由于默认 Remote 装配及其转发事件白名单不得引用实验性包（`verify-default-product-isolation`），客户端从自身入口挂载 Remote，并按配置的节奏（`refreshIntervalMs`，默认 15 秒）以及在 `connection/reset` 时刷新，而不是依赖 Host 变更事件；因此面板打开期间，后台工作会在一个节奏周期内出现。

## Alternatives considered

通过默认白名单转发 `dual-core-rsi/changed` 以推送更新：被否决，因为默认产品不得包含实验性包，而白名单属于该产品。用侧边栏切换按钮上的通知徽标代替面板：被否决，因为请求要求展示每次进化与修复的内容，这需要列表而非计数。保持 `consult` 为默认：被否决，因为它要求采纳前的人工操作，而请求正是要去掉这一步；它仍可作为配置使用。
