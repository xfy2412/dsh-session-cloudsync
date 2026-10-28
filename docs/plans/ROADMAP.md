# 里程碑与当前状态

> 当前真值，2026-10-27。以本文件为准。

```
M0 免重启 ingest → M1 shared 基础 → M2 自部署服务端 → M3 插件同步 → M4 自动化/故障/客户端防护
                                                              → Vault V0–V2（先行）
```

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** | 免重启 ingest 实验：外部写入会话 + `attachSession`，运行中的客户端能看到 | ✅ 已完成；结论见 [tests/m0/README.md](../../tests/m0/README.md) |
| **M1** | 骨架 + `shared`：帧工具、封帧/加密、协议类型、真实会话夹具、官方校验器 | ✅ 基础完成；帧工具保留给本地导出/兼容，**同步链已改为事件批次** |
| **M2** | 自部署服务端：设备 token、blob、manifest、租约、append、墓碑、会话快照/变更流、批量 blob、zstd 封帧、配额、管理台、首次初始化 | 🚧 服务端 0.1.0 已实现 v2-only（`PROTOCOL_VERSION=3`）；插件已迁移 v2 路径、cursor、幂等 append、批量 blob 与 zstd，0.0.x 插件不再兼容 |
| **M3** | 插件 MVP：枚举会话、事件批次哈希、推送/拉取、免重启 ingest、手动触发/状态、断网降级、安全边界（`tailOpen`/`safeThroughSeq`）与 apply journal | ✅ v1 链路已通过；0.1.0 已完成 v2、批量 blob、zstd 与 opaque cursor 迁移；发布收口待定 |
| **M4** | 自动同步、设置页、故障演练（5xx/超时/分叉/代际 skew/口令错误）、客户端防误操作（composer block、列表拦截、同步标记） | 🚧 A1–A5、B1–B5、C1–C4/C6、E1 已完成；C5 GUI 回归、D5 UI 文案演练与 E3 文档收口顺延到 Vault V0–V2 之后 |
| **Vault V0–V2.1** | 密钥域/记录链 → 服务端 append/cursor + 最小设备台账 → `workspaceKey` + 一次性绑定 + 未映射阻断 → 根会话级同步选择 + label 映射 | ✅ V0–V2.1 已完成（133 tests）；V3/V4 设计稿；见 [VAULT.md](../sync/VAULT.md) |
| **M5** | 公共多租户公益服 | ❌ 不在当前范围；独立 package/仓库，只共享插件对接协议 |

> **当前优先级**：服务端 0.1.0 与插件 0.1.0 的 v2-only、opaque cursor、批量 I/O、zstd
> 与压缩状态均已落地；下一步做发布收口、真实大会话验证与 WAF 观测。M5 公益服不塞进自部署包。

## 当前阶段的验收

- **M3**：本机 → 本地假服务 → 第二临时 home 拉取，同一来源链的**事件前缀**一致；断网只降级不报错；开放尾只备份，远端只 apply 到 `safeThroughSeq`；强杀后靠 apply journal 在启动时补完。跨设备“历史是否同源”的 raw 前缀校验已实现（push/pull 的 `verifySharedPrefix`）；对账 UX 仍见 [RECONCILE.md](../sync/RECONCILE.md)。
- **M4**：每个故障有确定性行为与 UI 文案；分叉双侧内容都保留；同步中的会话不能被误 resume 或误分叉。

## 文档地图

- [DESIGN.md](../architecture/DESIGN.md)：范围、数据分层、传输单位、并发、加密、兼容边界。
- [VAULT.md](../sync/VAULT.md)：L2/L3 加密附加数据层、多工作区映射、设备台账与插件版本匹配（V0–V2.1 已实现，V3+ 设计稿）。
- [CWD.md](../architecture/CWD.md)：header canonical、事件 raw、接收端 cwd 修正。
- [DECISIONS.md](DECISIONS.md)：cwd/Canonical 反复讨论后的最终决策记录。
- [PROMPT-GUIDANCE.md](../guides/PROMPT-GUIDANCE.md)：agent 提示词规划：尽量不把会话 cwd 切到工作区外。
- [RECONCILE.md](../sync/RECONCILE.md)：会话身份、raw 前缀校验、默认不选的根会话白名单与冲突/忽略流程。
- [GLOSSARY.md](../guides/GLOSSARY.md)：术语表（Canonical、生命周期、workspaceKey、对账等）。
- [USAGE-AGREEMENT.md](../guides/USAGE-AGREEMENT.md)：使用协议（修改边界、加密边界、风险告知）。
- [PROTOCOL.md](../architecture/PROTOCOL.md)：`/v2` 端点、批量传输、压缩、错误码与兼容边界。
- [SYNC-SAFETY.md](../sync/SYNC-SAFETY.md)：开放尾/安全边界、拉取原子性、手动中断 vs 强杀、客户端防护。
- [SEALED-FRAME.md](../architecture/SEALED-FRAME.md)：封帧字节布局、密钥层次、AAD 与版本规则。
- [tests/m0/README.md](../../tests/m0/README.md)：M0 全链路实验与结论。
- [tests/m3/README.md](../../tests/m3/README.md)：M3 持久化边界探针与批次模型。
