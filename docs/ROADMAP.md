# 里程碑与当前状态

> 当前真值，2026-10-20。以本文件为准。

```
M0 免重启 ingest → M1 shared 基础 → M2 自部署服务端 → M3 插件同步 → M4 自动化/故障/客户端防护
```

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** | 免重启 ingest 实验：外部写入会话 + `attachSession`，运行中的客户端能看到 | ✅ 已完成；结论见 [tests/m0/README.md](../tests/m0/README.md) |
| **M1** | 骨架 + `shared`：帧工具、封帧/加密、协议类型、真实会话夹具、官方校验器 | ✅ 基础完成；帧工具保留给本地导出/兼容，**同步链已改为事件批次** |
| **M2** | 自部署服务端 MVP：设备 token、blob、manifest、租约、append、墓碑、cursor、配额、管理台、首次初始化 | ✅ 已完成；`/v1` 当前仍按帧命名，M3 统一改名 |
| **M3** | 插件 MVP：枚举会话、事件批次哈希、推送/拉取、免重启 ingest、手动触发/状态、断网降级、安全边界（`tailOpen`/`safeThroughSeq`）与 apply journal | 🚧 推送/拉取/安全边界/双 home E2E 已通过；apply journal、手动按钮/状态、断网自动重试待补 |
| **M4** | 自动同步、设置页、故障演练（5xx/超时/分叉/代际 skew/口令错误）、客户端防误操作（composer block、列表拦截、同步标记） | ⏳ 未开始 |
| **M5** | 公共多租户公益服 | ❌ 不在当前范围；只保留 `dataset` / `token.label` 两个薄接缝 |

## 当前阶段的验收

- **M3**：本机 → 本地假服务 → 第二临时 home 拉取，两边**事件前缀**一致；断网只降级不报错；开放尾只备份，远端只 apply 到 `safeThroughSeq`；强杀后靠 apply journal 在启动时补完。
- **M4**：每个故障有确定性行为与 UI 文案；分叉双侧内容都保留；同步中的会话不能被误 resume 或误分叉。

## 文档地图

- [DESIGN.md](DESIGN.md)：范围、数据分层、传输单位、并发、加密、兼容边界。
- [PROTOCOL.md](PROTOCOL.md)：`/v1` 端点、错误码、M3 目标语义。
- [SYNC-SAFETY.md](SYNC-SAFETY.md)：开放尾/安全边界、拉取原子性、手动中断 vs 强杀、客户端防护。
- [SEALED-FRAME.md](SEALED-FRAME.md)：封帧字节布局、密钥层次、AAD 与版本规则。
- [tests/m0/README.md](../tests/m0/README.md)：M0 全链路实验与结论。
- [tests/m3/README.md](../tests/m3/README.md)：M3 持久化边界探针与批次模型。
