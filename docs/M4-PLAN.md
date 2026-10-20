# M4 计划：设置、可靠性与客户端防护

> 状态：M3 核心链路已完成（推送/拉取/安全边界/断网降级/双 home 验收）；M4 未开始。本文件是 M4 的唯一清单，ROADMAP 只保留状态摘要。

## 1. M4 验收

- 自动同步可配置、可手动触发、状态可见；
- `token` / `passphrase` 不再明文放在 profile YAML；
- 每个故障有确定性行为与 UI 文案：5xx、超时、租约、分叉、格式代际 skew、口令错误、配额；
- 同步中/开放尾的会话不能被误 resume 或误分叉；
- 分叉时双侧内容都保留。

## 2. 工作项

### A. Host 可靠性（M4 第一优先）

| ID | 内容 | 依赖 |
|---|---|---|
| A1 | durable sync state + apply journal：记录 pending 会话、targetSeq、阶段；启动先 reconcile 再暴露 | 无 |
| A2 | 错误分类与退避：401/403、404、409（lease/diverged）、410、429、507、5xx、超时、解密/格式错误 | A1 |
| A3 | 手动触发（`sync now`）与状态快照：lastAttempt/lastSuccess、每会话状态、pending、openTail、下次重试 | A1 |
| A4 | 客户端可读的状态通道（session projection 或 host service） | A3 |
| A5 | 子代理闭包：根会话 + 全部后代；推送按后序（子先父后），拉取先建子再挂根；默认开启 | A3 |

> 进度：**A1/A2 已完成**（durable revision + pending journal、错误分类/退避/内部状态快照）。A3/A4 还未暴露手动入口与客户端状态通道。

### B. 配置与凭据

| ID | 内容 | 依赖 |
|---|---|---|
| B1 | `token` / `passphrase` 迁到 DSH `ctx.credentials`；支持环境变量/配置作为 bootstrap fallback | A3 |
| B2 | 非敏感配置：serverUrl、workspaceAllowlist、workspacePath、autoSync、interval、batch 上限 | A3 |
| B3 | 设置页：Plugins 页的 `plugins.bundle.config` / `plugins.row.config` + `SettingsForm`；`settings.plugins.tab` 只用于 Built-in inventory，不是第三方插件配置位 | A4、B1、B2 |
| B4 | Host↔Client 控制通道（测试连接、立即同步、读取状态） | A3 |
| B5 | 首启引导：连接 → 凭据 → 工作区白名单 → 测试/首次同步；未配置时显示 | B3、B4 |

**官方前端接口（已确认，来自本地 DSH 源码/类型）：**

- `ctx.settings`（`SettingsForms`）可按插件 Config schema **自动生成**设置页；`configure({ auto: false })` 关闭自动页，由自定义页接管；
- Plugins 页提供 `plugins.item`（官方插件）、`plugins.bundle.config`（按 bundle 包名）、`plugins.row.config`（按 `<package>#<row id>`）三个配置槽；
- `ctx.remote.settings` 提供 `describe / update / replace / mutate`，带 revision 冲突检测；
- `ctx.remote.credentials` 提供 `describe / set`，用于 token/passphrase 这类 secret；
- `ui-primitives` 提供 `SettingsForm` / `SettingsFormModel` 等表单原语，客户端可用 `useWorkspaces` 列工作区；
- **没有现成的“插件首启向导”组件**；向导要在上述配置槽里自己组合。

### C. 客户端防误操作

| ID | 内容 | 依赖 |
|---|---|---|
| C1 | `syncState` projection：`applying` / `openTail` / safe 落后 | A4 |
| C2 | `ctx.conversation.blocks.set` 拦输入（官方 API） | C1 |
| C3 | 列表行捕获拦截：click / pointerdown / keydown（运行中/同步中的行） | C1 |
| C4 | 空闲行 `sidebar.session.row.leading` 同步标记 + hover 说明 | C1 |
| C5 | GUI 回归：下拉、拖拽、键盘、深链打开都不误 resume | C2–C4 |

### D. 故障演练

| ID | 内容 | 依赖 |
|---|---|---|
| D1 | 5xx / 超时：退避、不阻塞 agent、状态可读 | A2 |
| D2 | 租约冲突 / 分叉：跳过或报错，不自动合并 | A2 |
| D3 | 格式代际 skew：拒收并给出设备/版本原因 | A2 |
| D4 | 口令错误 / 解密失败 / 配额 507：停止对应方向，保留本地数据 | A2 |
| D5 | 每个故障的确定性测试与 UI 文案 | B3、C5 |

### E. 收口

| ID | 内容 |
|---|---|
| E1 | `frames → batches` 协议/字段/文档重命名 |
| E2 | 采集白名单（按工作区路径）；空配置 = 全部非子代理根会话；子代理跟随根会话闭包 |
| E3 | 更新 ROADMAP/PROTOCOL/SYNC-SAFETY/tests 文档 |

## 3. 待拍板

1. **凭据存储**：推荐 DSH `ctx.credentials`；profile YAML 只留非敏感项。环境变量作为首次配置 fallback。
2. **设置页范围**：推荐自定义首启向导（连接 + 凭据 + 工作区白名单 + 测试/立即同步），非敏感项仍走 `ctx.settings`；纯自动生成页只作为兜底。
3. **手动触发入口**：推荐 host 侧先提供命令/服务，客户端设置页再加按钮。
4. **状态通道**：推荐 per-session `syncState` projection + host 全局状态快照；不写临时事件。
5. **子代理策略**：推荐“根 + 后代闭包”默认开启；不做“只同步根、子代理各设备各自产生”的默认模式。
6. **白名单**：推荐可选的工作区路径 allowlist；空 = 当前“全部非子代理根会话 + 其子代理闭包”行为。
7. **apply journal 粒度**：推荐“每 turn 一次 append + journal 记录 session/targetSeq/阶段”，revision 仍作为游标。
8. **重命名时机**：建议 M4 Host 稳定后、D5 之前统一做，避免边改协议边写故障测试。

## 4. 执行顺序

```
A1 → A2 → A3/A4 → A5
        ↓
B1/B2 → B4 → B3
        ↓
C1 → C2/C3/C4 → C5
        ↓
D1–D4 → D5
        ↓
E1/E2 → E3
```

先做 **A（Host 可靠性）**：它是设置页、客户端拦截和故障演练的共同数据源；A 完成后再动 UI，返工最少。

## 5. 不在 M4

- 附件同步、工作区项目文件同步；
- 服务器端解密浏览（P2）；
- 密钥轮换、设备台账 UI、公共多租户；
- 视觉蒙版（默认不做，只保留捕获拦截 + 标记）。
