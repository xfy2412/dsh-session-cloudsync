# 里程碑与当前状态

> 当前真值，2026-10-22。以本文件为准。

```
M0 免重启 ingest → M1 shared 基础 → M2 自部署服务端 → M3 插件同步 → M4 自动化/故障/客户端防护
                                                              → Vault V0–V2（先行）
```

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** | 免重启 ingest 实验：外部写入会话 + `attachSession`，运行中的客户端能看到 | ✅ 已完成；结论见 [tests/m0/README.md](../tests/m0/README.md) |
| **M1** | 骨架 + `shared`：帧工具、封帧/加密、协议类型、真实会话夹具、官方校验器 | ✅ 基础完成；帧工具保留给本地导出/兼容，**同步链已改为事件批次** |
| **M2** | 自部署服务端 MVP：设备 token、blob、manifest、租约、append、墓碑、cursor、配额、管理台、首次初始化 | ✅ 已完成；`/v1` 规范字段已改为批次（`batches` / `batchCount`），旧 `frames` 字段保留兼容 |
| **M3** | 插件 MVP：枚举会话、事件批次哈希、推送/拉取、免重启 ingest、手动触发/状态、断网降级、安全边界（`tailOpen`/`safeThroughSeq`）与 apply journal | ✅ 推送/拉取/安全边界/双 home E2E/durable journal/错误退避已通过；手动入口与状态通道由 M4 A3/A4 补齐 |
| **M4** | 自动同步、设置页、故障演练（5xx/超时/分叉/代际 skew/口令错误）、客户端防误操作（composer block、列表拦截、同步标记） | 🚧 A1–A5、B1–B5、C1–C4/C6、E1 已完成；C5 GUI 回归、D5 UI 文案演练与 E3 文档收口顺延到 Vault V0–V2 之后 |
| **Vault V0–V2** | 密钥域/记录链 → 服务端 append/cursor + 最小设备台账 → `workspaceKey` + 一次性绑定 + 未映射阻断 | 🚧 V0/V1 已完成（本地记录链、服务端 Vault、writer 租约、设备台账/workspace profile，129 tests）；V2 待实现；见 [VAULT.md](VAULT.md) |
| **M5** | 公共多租户公益服 | ❌ 不在当前范围；独立 package/仓库，只共享插件对接协议 |

> **当前优先级**：先做 Vault V0 → V1 → V2；`workspaceKey` 是多工作区落点的正式方案，
> 完成后替换 M4 的单一 `workspacePath`。M5 公益服不塞进自部署包。

## 当前阶段的验收

- **M3**：本机 → 本地假服务 → 第二临时 home 拉取，同一来源链的**事件前缀**一致；断网只降级不报错；开放尾只备份，远端只 apply 到 `safeThroughSeq`；强杀后靠 apply journal 在启动时补完。跨设备“历史是否同源”的 raw 前缀校验仍见 [RECONCILE.md](RECONCILE.md)，尚未实现。
- **M4**：每个故障有确定性行为与 UI 文案；分叉双侧内容都保留；同步中的会话不能被误 resume 或误分叉。

## 文档地图

- [DESIGN.md](DESIGN.md)：范围、数据分层、传输单位、并发、加密、兼容边界。
- [VAULT.md](VAULT.md)：L2/L3 加密附加数据层、多工作区映射、设备台账与插件版本匹配（V0/V1 已实现，V2+ 设计稿）。
- [CWD.md](CWD.md)：header canonical、事件 raw、接收端 cwd 修正。
- [DECISIONS.md](DECISIONS.md)：cwd/Canonical 反复讨论后的最终决策记录。
- [PROMPT-GUIDANCE.md](PROMPT-GUIDANCE.md)：agent 提示词规划：尽量不把会话 cwd 切到工作区外。
- [RECONCILE.md](RECONCILE.md)：会话身份、raw 前缀校验、默认自动同步与冲突/忽略流程。
- [GLOSSARY.md](GLOSSARY.md)：术语表（Canonical、生命周期、workspaceKey、对账等）。
- [USAGE-AGREEMENT.md](USAGE-AGREEMENT.md)：使用协议草案（修改边界、加密边界、风险告知）。
- [PROTOCOL.md](PROTOCOL.md)：`/v1` 端点、错误码、M3 目标语义。
- [SYNC-SAFETY.md](SYNC-SAFETY.md)：开放尾/安全边界、拉取原子性、手动中断 vs 强杀、客户端防护。
- [SEALED-FRAME.md](SEALED-FRAME.md)：封帧字节布局、密钥层次、AAD 与版本规则。
- [tests/m0/README.md](../tests/m0/README.md)：M0 全链路实验与结论。
- [tests/m3/README.md](../tests/m3/README.md)：M3 持久化边界探针与批次模型。
