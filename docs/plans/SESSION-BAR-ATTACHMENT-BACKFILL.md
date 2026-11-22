# 会话底栏重构与附件补传设计

> 状态：首版已实现（2026-11-22），待 GUI 回归。实现优先级见文末。
> 关联：[ATTACHMENT-SYNC-DESIGN.md](ATTACHMENT-SYNC-DESIGN.md)、[ATTACHMENT-SYNC-SERVER-API.md](ATTACHMENT-SYNC-SERVER-API.md)、[ROADMAP.md](ROADMAP.md)。
>
> 首版完成：底栏本地 seq/tail 改用官方 `eventSource/openTurn`；移除 2 秒
> `/session-status` 定时器；附件面板按需查询；历史索引在下一次真实帧补传；
> 无服务端改动。
>
> 暂未完成：`SyncSessionStatus` 的远端字段扩展（底栏仍在挂载/同步状态变化时
> 请求一次 `/session-status`）；自动补传的会话/附件/时间预算与状态展示；GUI 视觉回归。

## 1. 问题

生产数据里存在附件永久 `no-index`：附件索引只随“推送的新批次帧”写入，
历史帧不可改，之后没有新事件就没有补索引的通道。

同时会话底栏每 2 秒轮询 `/session-status`，而该接口会触发 `planRound('auto')` 的
2 秒规划缓存；底栏收起、页面隐藏时也继续轮询，成本不低。

目标：

1. 底栏不再以 `/session-status` 轮询为主路径；
2. 附件缺失可见，展开附件面板时按需查询；
3. 在**不新增服务器提交**的前提下，把历史缺失附件补到下一次真实事件帧的索引里；
4. 静止会话的彻底补传留给后续服务端索引清单方案。

## 2. 当前实现核实

| 事实 | 位置 |
|---|---|
| 底栏每 2 秒拉 `/session-status` | `packages/plugin/client/index.js:4435` |
| 全局 `/status` 正常走 SSE，仅断线时 1 秒兜底 | `client/index.js:643-736` |
| `/session-status` 调 `planEntry`，共享 2 秒 `planRound` 缓存 | `packages/plugin/src/index.ts:1842-1905` |
| 规划会读本地会话、附件协调与远端摘要 | `index.ts:1709` |
| 附件索引只在推送批次时写入 | `packages/plugin/src/engine.ts:920-978` |
| 帧只能追加或替换尾帧 | `packages/server/src/sessions.ts:361-390` |
| 链要求 `previous.seqTo + 1 === frame.seqFrom` | `packages/shared/src/chain.ts:53-72` |
| 空批次无法通过 `openEventBatch` | `packages/shared/src/batches.ts:292-315` |
| 已追平设备会校验共享前缀的批次哈希 | `packages/plugin/src/engine.ts:1473-1535` |

结论：

- “空批次索引帧”不可行：链连续性、`lastSeq`、空批次解码至少一处会失败；
- “替换尾帧挂索引”也不可行：同一批事件的 `chainHash` 改变，已追平设备会判 `diverged`；
- **把历史附件索引挂到下一次真实事件的新帧**是可行的插件侧方案。

## 3. 底栏数据通道

### 3.1 官方前端已提供

不再由我们的 Host API 提供：

| 字段 | 来源 |
|---|---|
| `localLastSeq` | `ctx.sessions.binding(id).eventSource` 中最后一个 durable `SessionEvent.seq` |
| 事件窗口变化 | 同一 `eventSource` 的 `revision` / `change` |
| `tailOpen` | `ctx.uiConversation.binding(binding).openTurn !== undefined` |
| `live` / `running` | 官方 SessionSnapshot / SessionBinding |
| 会话标题、workspace | 官方 sessions / workspace 服务 |

`eventSource` 里 transient assistant chunk 的 seq 是小数，计算 `localLastSeq` 时必须过滤
`type === 'event'`。

### 3.2 气泡（全局 SSE）已能提供

Bubble 与底栏共享同一个 `model`，其 `state.status` 已经包含：

- `status.sessions[]`：`live`、`tailOpen`、`remoteAhead`、`blocked`、`unmapped`、
  `cwdPending`、`phase`、`stage`、`pending`、任务进度；
- `status.deviceLease`、`status.running`、`status.run.tasks`、`status.configured`、
  `lastError`。

这些不需要新接口，底栏可直接读同一份 store。

### 3.3 需要扩展 `SyncSessionStatus`

首版实现暂未扩展 `SyncSessionStatus`：底栏在挂载、操作后和全局 SSE
`statusVersion` 变化时请求一次 `/session-status`，本地字段由官方接口覆盖。
后续可把下面的字段直接放进聚合状态，彻底去掉这次请求。

气泡当前没有、底栏需要的字段：

```ts
readonly remoteLastSeq?: number
readonly headChainHash?: string
readonly formatVersion?: number
readonly action?: 'none' | 'push' | 'pull' | 'skip'
readonly reason?: string
readonly upload?: boolean
```

由 `planRound` 的规划条目填充到聚合视图；通过现有全局 SSE 推送。
底栏不再为这些字段每 2 秒请求 `/session-status`。

`/session-status` 保留为低频 fallback：SSE 不可用、旧宿主或拿不到 binding 时使用，
不再作为主路径。

### 3.4 目标数据流

```text
官方 eventSource/openTurn ──► localLastSeq / tailOpen / live
全局 SSE status ─────────────► remoteLastSeq / head / action / blocked / lease / tasks
按需 attachments/status ─────► 附件计数与可修复性
```

底栏只订阅前两条；附件面板展开时请求第三条。

## 4. 附件面板

### 4.1 交互

底栏入口：

```text
附件 10/12 ▾    详情 ▸
```

- 默认关闭；
- 展开时查询一次 `/attachments/status?sessionId=...`；
- 同步完成、检查附件完成后失效并允许重新查询；
- 收起不轮询。

### 4.2 计数

| 字段 | 含义 |
|---|---|
| `localReferenced` | 本机事件引用的唯一 attachmentId 数 |
| `localPresent` | 本机实际存在的唯一附件数 |
| `serverIndexed` | 服务器索引中登记的唯一 attachmentId 数 |
| `serverTooLarge` | 索引中标记 tooLarge 的数量 |
| `localMissing` | `localReferenced - localPresent` |
| `serverMissing` | `localReferenced - serverIndexed` |
| `pendingBackfill` | 本机有原件、服务器尚未登记的附件数 |

附件 ID 必须去重；索引数量不是“附件数量”。

### 4.3 状态色

```text
红：有当前设备可执行的动作
    localMissing > 0
    或 serverMissing > 0 且本机有原件、会话在上传范围

琥珀：有缺口但当前设备不可执行
    tooLarge、服务端无 attachment-index、本机无原件

灰：未纳入上传/未配置
```

服务端能力不足时显示“服务端版本过低，附件不会上传”，不显示“可补传”。

### 4.4 文案

“本机多于服务器”时的准确提示：

```text
本机有 N 个附件尚未登记到服务器。
下次由本机推送时补齐（发送任意消息可触发）。
```

不能承诺“发送消息一定会补齐”：只有下次推送由本机发起、服务端支持
`attachment-index`、且本机持有原件时才成立。

## 5. 附件补传

### 5.1 方案：下一次真实事件帧顺带索引

在 `pushSessionTask` 推送前：

1. 收集本会话全部附件引用；
2. 读取远端已有附件索引，得到缺失集合；
3. 第一个真实新批次帧挂 `attachmentIndexSha256`；
4. 先上传附件密文与索引 blob，再 append 帧。

索引条目可以包含历史帧的附件；`AttachmentIndex.frameIndex/seqFrom/seqTo` 只绑定
**当前索引帧**的坐标，读取端按 `attachmentId` 合并所有索引，不要求条目属于当前帧。

```jsonc
{
  "attachmentIndexSha256": "<本次索引密文>",
  "attachmentBlobs": ["<本次附件密文>", "…"]
}
```

- `attachmentBlobs` 最多 256 条；超过则跨后续真实帧分批；
- 老客户端正常解帧事件，忽略新字段；
- 不改历史帧、不伪造空批次、不改尾帧，因此不会破坏链和前缀校验；
- 服务器不需要新端点。

### 5.2 限制

- 会话必须有新事件；没有新事件的静止会话无法用这个通道；
- 推送设备必须持有附件原件；设备A有原件而设备B没有时，必须由设备A推送；
- 全局单写者租约下，下一帧可能由另一台设备推；
- 服务端必须有 `attachment-index` 能力。

静止会话的最终方案仍是服务端“不透明索引清单”：

```text
POST /v2/sessions/:id/attachment-indexes   { sha256 }
GET  /v2/sessions/:id/attachment-indexes   → [sha256]
```

该方案与其他服务器提交一起进入 0.2.0，不混进插件 tag。

### 5.3 自动执行

首版在每次真实推送前检测缺失并在该会话的下一次真实帧补传；尚未实现跨会话
的自动扫描预算与状态展示。后续计划：

- 手动同步/启动首轮检测；
- 每轮预算 ≤8 会话 / ≤64 附件 / ≤3 秒；
- 只处理上传范围内会话；
- 本机无原件记 `local-missing`，永久跳过，面板显示“不可修复”；
- 失败隔离，不影响主同步；
- 状态可返回 `attachmentBackfill { state, sessions, done, blobs, uploaded }`。

## 6. Host API

新增：

```text
GET /api/session-cloudsync/attachments/status?sessionId=...
```

返回第 4.2 节计数与能力状态；按 `headChainHash` 缓存。

保留：

```text
POST /api/session-cloudsync/attachments/repair   # 只下载本机缺失
POST /api/session-cloudsync/sync                 # 触发推送/拉取
GET  /api/session-cloudsync/events               # 全局 SSE
```

`repairAttachments` 的返回扩展为包含 `localReferenced`、`localPresent`、
`serverIndexed`、`tooLarge`、`pendingBackfill`，面板和检查按钮共用。

## 7. 决策

1. 不实现空批次索引帧：协议不可行；
2. 不替换尾帧：会改变共享前缀哈希，已追平设备会分叉；
3. 插件 tag 不混服务器提交；补传先走“下一次真实帧”；
4. 附件面板默认关闭，展开时查询一次，不做定时轮询；
5. 底栏本地状态改用官方 `eventSource/openTurn`，远端字段扩展 `SyncSessionStatus`；
6. 附件统计单独按需接口，不并进 2 秒状态。

## 8. 开放问题

1. 自动补传只在手动同步触发，还是首次启动也检测一次？
2. 3 秒/64 附件预算是否合适，低端机是否再降？
3. 上传范围外的会话：只检测不补传，还是完全不碰？
4. 本机与服务端都没有的附件：只在面板显示“不可修复”，还是需要单独清理入口？
5. 附件面板红点是否只对已纳入上传的会话显示？

## 9. 验收

- 底栏收起/隐藏时没有 `/session-status` 周期请求；
- 官方本地事件增长能实时反映到 `localLastSeq`；
- 展开附件面板请求一次并展示四类计数；
- 历史无索引会话在产生新事件后，下一次推送的帧携带历史索引；
- 另一设备用 `repairAttachments` 成功补齐；
- 老客户端拉取新帧正常，链不变；
- 无服务器代码进入插件发布 tag。
