# 同步对账：会话身份与自动同步流程

> 状态：**设计稿，未实现**（2026-10-21）。
> 插件未公开发布，不考虑历史数据迁移。相关文档：
> [CWD.md](CWD.md)（cwd 可移植性）、[VAULT.md](VAULT.md)（工作区 key 与本地绑定）、
> [USAGE-AGREEMENT.md](USAGE-AGREEMENT.md)（修改边界）、[GLOSSARY.md](GLOSSARY.md)（术语）、
> [PROMPT-GUIDANCE.md](PROMPT-GUIDANCE.md)（agent cwd 提示词）。
>
> 本文定两件事：
> 1. 怎样判断本地会话和远端会话是不是**同一个会话**；
> 2. 启动/同步前怎样判断安全项、冲突项；安全项默认自动，冲突/未映射才要求确认或忽略。

## 1. 不变量

1. **只处理 DSH 必需的 cwd 元数据**：不改消息、工具调用、附件或其他事件；历史 cwd 不改写，允许接收端在用户确认后追加一条修正；
2. **sessionId 不是身份**：必须同时比较生命周期、canonical header 和 **raw 事件前缀**；
3. **本地和远端事件都按 raw 计算哈希**；不对 `working-directory/change.cwd` 做投影；
4. **前缀不一致就是分叉**，不自动合并、不自动选一边；
5. **服务端没有“会话 cwd”**；工作区落点由 opaque `workspaceKey` + 本机绑定决定；
6. 被忽略的会话不再自动提示，但必须提供显式“重置忽略”。

## 2. 三个视图

| 视图 | 用途 | 包含 cwd？ |
|---|---|---|
| **Local view** | 本机 DSH 日志、恢复、工具调用 | 是，本机绝对路径 |
| **Remote raw events** | 批次哈希、封帧、跨设备比较 | 是，远端 raw 路径 |
| **Canonical header** | 会话头身份 | 否 |

**不做 cwd canonical 投影。** 本地和远端事件都保持 raw；批次哈希对 raw 事件计算。
本地 session 文件保留本机 header cwd，跨设备不比较本地文件字节，也不要求文件一致。
canonical header 不承诺整个会话跨平台可用。

### 2.1 Local view

本机 `SessionHandle.read()` 返回的原始事件，以及本机 header：

```ts
header.cwd = 'D:\git-repo'
working-directory/change.data.cwd = 'D:\git-repo\sub'
```

这是 DSH 实际执行用的数据。

### 2.2 Raw event view

`working-directory/change` 及其他事件原样传输；不转换 `cwd`，不引入
`@workspace` / `@external`。

当前 cwd 在工作区外时，只在本地给 `nonPortable` 警告；它不影响批次哈希，也不是同步身份。
不同路径的 raw 历史不同，不自动认成同一会话。

### 2.3 Canonical header

header 哈希只覆盖可移植字段：

```ts
{
  formatVersion, createdAt, isSeeded, delegationDepth,
  agentPreset?, parentSession?, origin?, inheritedEventCount?
}
```

**不包含**：

- `cwd`；
- 设备 ID、主机名、本机路径；
- `workspaceKey`（放 manifest 或 sealed sidecar，不进 header 哈希）。

因此“本地 `D:\git-repo`、远端也是同一工作区”不会导致 header 哈希不同；如果 header 哈希不同，应视为真实字段不一致或分叉。

## 3. 会话身份

### 3.1 生命周期

```ts
Lifecycle = {
  sessionId: string,
  createdAt: number,
  formatVersion: number,
}
```

三者任一不同，就不是同一生命周期。同 id 但 `createdAt` 不同，是重建/复用 id，不能合并。

### 3.2 头一致

```ts
canonicalHeaderHash(localHeader) === remote.headerRef.chainHash
```

### 3.3 内容前缀一致

远端 manifest 的批次是权威边界：

```text
for each remote frame (events, not header):
  if frame.seqTo <= localLast:
    localSlice = localEvents[frame.seqFrom .. frame.seqTo]
    sha256(stableStringify(localSlice)) === frame.chainHash
```

任一不等 => 内容前缀不一致，标记 `diverged`。

### 3.4 关系判定

| 条件 | 判定 |
|---|---|
| `!sameLifecycle` | 不同生命周期 |
| `sameLifecycle && !sameHeader` | 同 id 但头不一致：`diverged` |
| `sameHeader && !sharedPrefix` | 同生命周期、同头、内容已分叉：`diverged` |
| `sameHeader && sharedPrefix && remoteLast > localLast` | `remote-ahead`，可拉取 |
| `sameHeader && sharedPrefix && localLast > remoteLast` | `local-ahead`，可推送 |
| 全部一致且 `lastSeq` 相同 | `same` |

**UI 措辞**：

- 前缀不一致：显示“同一会话的两份历史已分叉”，不是“两个不同会话”；
- 不同生命周期：显示“同 ID 的不同会话代际”。

## 4. 比较算法

```ts
function compareLocalRemote(local, remote) {
  if (!sameLifecycle(local, remote)) return 'different-lifecycle'
  if (canonicalHeaderHash(local.header) !== remote.headerHash) return 'diverged'

  const localLast = local.lastSeq
  for (const frame of remote.eventFrames) {
    if (frame.seqTo > localLast) break
    const localSlice = local.events.slice(frame.seqFrom, frame.seqTo + 1)
    if (sha256(stableStringify(localSlice)) !== frame.chainHash) return 'diverged'
  }

  if (remote.lastSeq > localLast) return 'remote-ahead'
  if (localLast > remote.lastSeq) return 'local-ahead'
  return 'same'
}
```

补充规则：

- 本地会话正在运行（live）=> `local-active`，不拉取；
- 远端墓碑 => `tombstone`；
- 本地/远端事件序列不连续 => `error`，不写；
- **不下载远端 suffix 来做前缀判断**：共享前缀只需要比较远端已知批次；
- 不存在“轮数”协议字段；UI 可显示事件数/批次数，或解密后统计 turn，但不能用“500 轮”替代 `lastSeq`。

### 4.1 A/B 500 → 560 示例

前提：

- A/B 手工复制过同一会话，`sessionId/createdAt/formatVersion` 相同；
- 本地和远端 cwd 都是 `D:\git-repo`；
- 本地 500 个事件，远端 560 个事件；
- 远端批次边界为 `0..49, 50..99, …, 500..559`。

判断：

1. lifecycle 相同；
2. canonical header 相同；
3. 对远端每个 `seqTo <= 499` 的批次，用本地前 500 个 **raw** 事件算哈希：
   - 全部等于远端 `chainHash` → `remote-ahead`，默认自动进入拉取；
   - 任一不等 → `diverged`，绝不 append 501..559。
4. 默认自动执行；若进入冲突流程，用户确认后才允许写入，并再次校验。

如果两边 cwd 不同（例如 A 是 `D:\git-repo`、B 是 `E:\repo`），raw 批次哈希不同，
不自动认成同一历史；这不是 canonical 要修复的场景。

## 5. 工作区落点

### 5.1 服务端没有 cwd

manifest 不存 cwd。不能问“服务器上存的是哪台设备的 cwd”；同一会话可能被多台设备追加，最后写入设备不等于会话归属。

### 5.2 逻辑工作区

使用 opaque `workspaceKey`：

- 本机 workspace 的 canonical path（DSH 的 `Workspace.path`）派生
  `pathKey = HMAC(vaultKey, "workspace|" + canonicalWorkspacePath)`；
- 远端会话携带 `workspaceKey`；
- 本机维护 `workspaceKey → localPath` 绑定；
- A/B 都是 `D:\git-repo` 时 key 相同；
- 不同路径则是别名绑定，不能“自动选一台设备的 cwd”；
- 已挂载会话的 header cwd 在 realpath 后必须等于 workspace path；它不单独作为工作区身份。

### 5.3 当前实现

V2 已落地 `workspaceKey` manifest 扩展、本机一次性绑定和未映射阻断：

- 推送时根会话写 key，子代理继承；
- 拉取时按绑定解析本地落点，未映射不 apply；
- 单一 `workspacePath` 已删除，不做旧配置迁移。

### 5.4 同路径

- 本机对已选工作区计算 `pathKey`，命中远端 `workspaceKey` 时预选；
- 默认仍需用户确认后才建立绑定；
- 用户可在设置页显式开启“同路径自动绑定”；
- 不同路径由用户选择本地工作区，建立别名绑定。

## 6. 对账计划（只读）

同步前先生成 plan，不写任何会话：

```ts
interface PlanItem {
  sessionId: string
  createdAt: number
  formatVersion: number
  direction: 'push' | 'pull' | 'conflict' | 'none'
  state: 'local-only' | 'remote-only' | 'remote-ahead' | 'local-ahead'
       | 'same' | 'diverged' | 'local-active' | 'unmapped' | 'tombstone'
  localLast: number | null
  remoteLast: number | null
  workspaceKey: string | null
  reason?: string
}
```

### 6.1 状态处理

| 状态 | 含义 | 默认行为 |
|---|---|---|
| `same` | 两边一致 | 标记完成 |
| `local-only` | 本机有、远端无 | 工作区已选时自动推送 |
| `remote-only` | 远端有、本机无 | 工作区已映射时自动拉取；未映射提示 |
| `remote-ahead` | 前缀一致，远端更多 | 自动拉取 |
| `local-ahead` | 前缀一致，本机更多 | 自动推送 |
| `diverged` | 头/前缀不一致 | **停止，提示冲突** |
| `nonPortable` | 当前/最后 cwd 在工作区外 | 本地警告；用户确认后接收端追加修正 |
| `local-active` | 本机正在运行 | 暂不处理 |
| `unmapped` | 远端工作区没有本地绑定 | 提示映射 |
| `tombstone` | 远端已删 | 不拉取，提示 |

### 6.2 默认不弹清单

默认同步模式是**自动**：

- 安全项（local-only / remote-only 且有映射 / remote-ahead / local-ahead）直接执行；
- 不逐会话勾选，不做启动 review gate；
- 冲突、未映射、需要强行写入分叉时才提示；
- 气泡只显示进度/结果；设置页提供手工查看/忽略/重置列表。

用户主动打开“手工对账”或出现冲突时，才显示会话列表；列表里未勾选 = 忽略。

## 7. 默认自动、冲突拦截与忽略

### 7.1 默认自动

目标体验是“**主即走、从即用**”：

- 普通同步不要求逐会话确认；
- 安全项按第 6 节自动执行；
- `remote-only` 只有在工作区已映射时才自动拉取；`unmapped` 不猜落点；
- `nonPortable` 仍可按普通会话同步/备份；接收端在 apply 后、attach 前提示，用户确认后追加修正。

### 7.2 冲突与强行写入

当本地和远端都存在同一会话、但尚未同步或已 `diverged` 时：

- 打开该会话时启用既有的 composer/列表行拦截；
- 提示“会话尚未同步/已分叉”，说明继续写入会产生本地分叉；
- 提供明确的复选框，例如“我理解强行写入会产生分叉”，勾选后才允许本地 resume/写入；
- 强行写入只解除本地输入拦截，不自动推送、不自动合并、不把远端内容覆盖到本地；
- 会话保持 `diverged`，后续由用户 fork 或人工处理；
- 如果远端根本没有这个会话（`local-only`），忽略后不再产生额外提示，也不弹强行写入确认。

### 7.3 忽略

- 在出现列表/冲突提示时，未勾选并确认 = **忽略**；
- 忽略按 `(sessionId, createdAt, formatVersion)` 持久化，不写会话事件；
- 被忽略的会话后续不再自动提示，包括远端继续更新；用户可在设置页“已忽略”中重置；
- 新会话不继承其他会话的忽略状态；
- 设置页必须提供“重置忽略”，否则用户无法恢复。

### 7.4 执行时重新校验

- 用户在 plan 和 execute 之间可能产生新事件；
- 执行前重新验证 lifecycle/header/prefix；
- 不一致则放弃该项，重新生成 plan；不盲目 append。

### 7.5 接收端 cwd 修正

当远端最后 cwd 在工作区外时：

1. 先完成 apply，但暂不 attach；
2. 本地显示 `nonPortable` 警告；
3. 用户确认后，目标为本地 workspace canonical root；
4. 申请租约并确认远端 lastSeq 未推进；
5. 在本地 append 一条 `working-directory/change`；
6. 立即用租约推送到服务端；
7. 成功后再 attach；失败按 pending/重试，不假装成功；
8. 租约冲突或远端已推进 → 放弃本次修正并重新对账。

修正事件是普通 raw 事件，会同步到其他设备；cwd 来回修正是已知成本。

## 8. 执行顺序

1. **扫描**：本地 snapshots + remote cursor/manifest（只读）；
2. **校验**：canonical header + 共享前缀；
3. **生成 plan**：本地/远端/冲突/未映射；
4. **默认自动执行安全项**；只有冲突/未映射/强行写入分叉才提示用户；
5. **执行**：
   - 拉取：校验、pending、download、append raw、flush；
   - nonPortable：用户确认后租约内追加修正并推送，再 attach；
   - 推送：校验、lease、seal raw、upload、append；
6. **持久化状态**：自动执行结果、忽略、最后看到的远端边界；
7. **后续自动同步**：只处理安全且未被忽略的项目。

## 9. 持久化状态

插件自己的本地状态，不写会话日志：

```ts
interface SyncDecision {
  sessionId: string
  createdAt: number
  formatVersion: number
  action: 'sync' | 'ignore'
  lastApprovedRemoteLastSeq?: number
  workspaceKey?: string
  updatedAt: number
}
```

- 忽略可重置；
- 远端新增事件不改变 `action: 'ignore'`；
- 生命周期变化视为新项。

## 10. 当前实现差距

| 能力 | 当前 | 目标 |
|---|---|---|
| header cwd 剥离 | 已有 | 保持 |
| `working-directory/change` 投影 | 无 | **不做**，保持 raw |
| 共享前缀校验 | 无 | 逐远端批次比较 raw |
| 工作区 key/绑定 | 已实现 `workspaceKey` + 一次性绑定 | 保持 |
| 启动对账/勾选/忽略 | 无 | 本文第 6–9 节 |
| 自动拉取所有远端会话 | 有 | 改为 plan 后执行 |

**在 raw 前缀校验 + workspaceKey + 接收端修正完成前，不能把“默认自动同步”当作安全能力上线。**

## 11. 测试清单

- 同一会话：两边 raw cwd 相同，前缀哈希一致；
- 本地 500 / 远端 560 且前缀一致 → `remote-ahead`；
- 本地 500 / 远端 560 且第 300 批不同 → `diverged`，不 append；
- 本地 600 / 远端 560 且远端前缀一致 → `local-ahead`；
- 头哈希不同 → `diverged`；
- 两边 cwd 路径不同 → raw 哈希不同，不自动认成同一历史；
- 工作区外 cwd → 本地 `nonPortable` 警告；
- 用户确认修正 → 追加 raw cwd 事件并租约推送；
- 用户取消修正 → 不写事件；
- 修正推送失败 → pending/重试，不假装成功；
- 本地 live 会话 → `local-active`；
- 远端-only + 已映射工作区 → 提示拉取；
- 远端-only + 未映射 → `unmapped`；
- 忽略后再次扫描不再提示；
- 生命周期不同 → 不合并；
- 本地+远端都存在但未同步 → 打开时被拦截，风险确认后才允许本地写入；
- 风险确认只解除本地写入，不自动推送/合并；
- 默认自动同步不弹逐会话勾选，只在冲突/未映射时提示；
- 执行前远端变化 → 重新 plan，不写半截。

## 12. 已定

- `working-directory/change` 保持 raw；不做 `@workspace` / `@external` 投影；
- 前缀哈希对 raw 事件计算；不同路径不自动认成同一历史；
- `nonPortable` 是本地警告，基于当前/最后 cwd；
- 接收端修正：用户确认后 append 一条 cwd 事件，租约内立即推送；
- 工作区外路径不映射到工作区根，不改写历史；
- 未勾选即忽略；列表/冲突提示中才出现勾选；
- 忽略后远端更新不再自动提示，设置页可重置；
- 默认自动同步，只有冲突/未映射/强行写入分叉才提示用户；
- 首启向导和设置页都可以设置工作区映射；
- 同路径默认只预选，首次确认后才绑定；用户可在设置页显式开启自动绑定。
