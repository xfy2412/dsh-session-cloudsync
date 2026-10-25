# 文档索引

> 先看这里。文档按“架构 / 同步 / 界面 / 计划 / 参考”分组；
> 根目录 [README](../README.md) 只保留入口与开发控制台说明。

## 架构

- [DESIGN](architecture/DESIGN.md)：整体设计、拉取落地、写入路径与分叉处理。
- [PROTOCOL](architecture/PROTOCOL.md)：客户端/服务端 wire 协议。
- [SEALED-FRAME](architecture/SEALED-FRAME.md)：封帧、哈希与认证字段。
- [CWD](architecture/CWD.md)：工作区/cwd 的可移植性规则。

## 同步

- [SYNC-SAFETY](sync/SYNC-SAFETY.md)：开放尾、apply journal、阻塞与恢复。
- [RECONCILE](sync/RECONCILE.md)：本地/远端对账、冲突与未映射。
- [VAULT](sync/VAULT.md)：Vault 设备台账、workspace/profile 与一次性映射。
- [CONFIG-SNAPSHOT](sync/CONFIG-SNAPSHOT.md)：配置快照、选择模型与保存语义。
- [SYNC-PERF-PLAN](sync/SYNC-PERF-PLAN.md)：同步性能基线、阶段与实施记录。

## 界面

- [UI-GUIDELINES](ui/UI-GUIDELINES.md)：视觉与交互约束。
- [SYNC-STATE](ui/SYNC-STATE.md)：同步状态列表、圆点动效、滚动。

## 计划

- [M4-PLAN](plans/M4-PLAN.md)：M4 里程碑与已完成项。
- [ROADMAP](plans/ROADMAP.md)：后续阶段。
- [DECISIONS](plans/DECISIONS.md)：已拍板的取舍记录。

## 参考

- [GLOSSARY](guides/GLOSSARY.md)：术语。
- [PROMPT-GUIDANCE](guides/PROMPT-GUIDANCE.md)：提示/文案约定。
- [USAGE-AGREEMENT](guides/USAGE-AGREEMENT.md)：使用协议。
