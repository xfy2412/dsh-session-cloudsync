# 决策记录：cwd、Canonical 与接收端修正

> 状态：**已定**（2026-10-21）。
> 本文记录为 cwd 可移植性反复讨论后锁定的结论，避免后续重新纠结。
> 相关：[CWD.md](../architecture/CWD.md)、[RECONCILE.md](../sync/RECONCILE.md)、[USAGE-AGREEMENT.md](../guides/USAGE-AGREEMENT.md)。

## 1. 问题背景

跨设备会话里有两个不同的 cwd：

- **header cwd**：会话创建时的项目目录，不可变，DSH 要求它是本机绝对路径；
- **current cwd**：`working-directory/change` 记录的运行时目录，可以变到子目录或工作区外。

早期设计为了让不同设备/不同路径的 cwd 能比较，提出：

1. header cwd 从同步哈希中剥离；
2. `working-directory/change.cwd` 在同步表示里 canonical 化成 `@workspace/...`；
3. 工作区外路径用 `@external` 掩码；
4. 拉取时本地化成目标设备绝对路径。

## 2. 讨论中出现的关键事实

- 本地 session 文件的 header cwd 必然是平台相关的；
- 我们同步 header 时已经剥离 cwd，所以**本地文件本来就不可能跨设备字节一致**；
- 追求本地文件 checksum 一致是错误目标；
- DSH 的 `workingDirectory.ensure()` 只检查 projection 的**最后/当前 cwd**，
  不会逐条检查历史 cwd 事件；
- 历史 cwd 事件仍参与事件链/批次哈希；
- 工作区外路径最终无法可靠相对化；
- canonical 化不等于跨平台支持；消息/工具调用里的路径本来就不处理；
- canonical cwd 投影会引入 raw/canonical 两个表示，增加校验、修复和心理负担。
- `working-directory/change.cwd` 在实际会话中几乎不被使用

## 3. 最终决策

### 3.1 保留 header canonical

- 同步 header 只包含可移植字段；
- `cwd` 永远不进入 manifest / canonical header；
- 拉取时用本机 workspace canonical path 重建 local header；
- 这是为了跨设备身份，不是为了让本地文件 checksum 一致。

### 3.2 `working-directory/change` 保持 raw

- **不做** cwd canonical 投影；
- **不引入** `@workspace` / `@external`；
- 批次哈希直接对 raw 事件计算；
- 本地日志不因同步被改写；
- 消息、工具调用、附件完全不处理。

### 3.3 会话身份

- lifecycle：`sessionId + createdAt + formatVersion`；
- canonical header：不含 cwd；
- 内容前缀：raw 事件的批次哈希。

因此：

- 相同路径、相同 raw 历史 → 同一会话链；
- 路径不同 → 就是不同历史，不做自动等价；
- 除非有人刻意构造相同 raw 内容，否则不把“内容像但路径不同”的会话当成同一会话；
- 不再尝试用 canonical cwd 修复跨路径历史。

### 3.4 `nonPortable` 只是本地警告

- 依据 projection 的**当前/最后 cwd**，不逐条检查历史；
- 当前 cwd 在工作区外 → 本地提示“跨设备可能无法正确恢复”；
- 不影响批次哈希，不是同步身份，不是永久会话标签；
- 工作区外路径保留原值，不映射到工作区根；
- 不修改消息/工具调用。

### 3.5 修正在接收端

- 修正在**接收端**发生，因为 `ensure()` 也在这里工作；
- 在官方 `ensure()` 兜底之前，先向用户确认；
- 用户确认后，在会话末尾追加一条 `working-directory/change`，
  把当前 cwd 切到本地 workspace canonical root；
- 追加后立即申请租约并推送到服务端，避免本地事件与远端后续事件抢同一个 seq；
- 推送失败时按 pending/重试处理，不能假装成功；
- 这条修正事件是普通 raw 事件，会进入会话历史并同步到其他设备。

### 3.6 已知成本，接受

- 远端最后 cwd 会变成最后接收设备的路径；
- 多设备来回打开可能产生多次 cwd 修正；
- 原始设备再开时，若路径不匹配，可能再次修正；
- 不同路径的历史不会被自动认成同一会话；
- 不承诺整个会话跨平台可用；
- 本地验证和远端验证只比较 raw 批次哈希/header，不比较本地文件 checksum。

## 4. 明确否决的方案

| 方案 | 否决原因 |
|---|---|
| 追求本地文件 checksum 跨设备一致 | header cwd 平台相关，根本做不到 |
| cwd canonical 投影 + 拉取本地化 | 引入 raw/canonical 双表示，复杂且心理负担大 |
| 上传端追加修正 | 目标设备仍可能没有源路径；不能解决接收端 |
| 接收端只本地追加、不同步 | 本地/远端从该 seq 开始分叉 |
| 接收端自动追加、不确认 | 未经用户同意改变 cwd |
| 把工作区外路径映射到工作区根 | 路径越界、语义错误 |
| 改写历史 cwd 事件 | 违反 append-only，且会破坏链 |

## 5. 对文档的影响

- [CWD.md](../architecture/CWD.md)：删除 cwd canonical/localize 方案，改为 raw + 接收端修正；
- [RECONCILE.md](../sync/RECONCILE.md)：身份前缀使用 raw 事件哈希；`nonPortable` 改为本地警告；
- [GLOSSARY.md](../guides/GLOSSARY.md)：移除 `@workspace` / `@external` 的 active 定义；
- [USAGE-AGREEMENT.md](../guides/USAGE-AGREEMENT.md)：2.1 只声明 header 本地化和接收端追加修正；
- [PROMPT-GUIDANCE.md](../guides/PROMPT-GUIDANCE.md)：保留“尽量别把 cwd 切到工作区外”的提示。

## 6. 复活条件

只有出现新的、可验证的需求才重新讨论 canonical cwd，例如：

- 必须自动识别“不同设备路径不同但内容相同”的同一会话；
- 必须在不追加事件的情况下跨设备恢复当前 cwd；
- 收到实际用户数据证明 raw 路径差异是主要痛点。

在这些条件出现前，不再把 canonical cwd 投影作为主路线。
