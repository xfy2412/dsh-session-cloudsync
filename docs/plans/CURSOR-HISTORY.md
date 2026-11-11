# 游标设计存档（v1 / v2，已废弃）

> 状态：**历史存档**（2026-11-11 整理）。服务端的 `/v2/changes` 变更流与相关游标逻辑已移除；
> 插件的 `pullOnce` / `readCursor` 自 0.1.1 起已无调用方，计划在下个插件版本删除。
> 本文只记录"当时为什么这么做、后来怎么坏、为什么放弃"，不是现行协议文档。

## 1. 背景与目标

最初的设计目标（2026-10-19 设计讨论）：

- 服务端只做"内容寻址 blob + 每设备游标 + 租约 + 墓碑"，合并在客户端；
- 客户端需要一种低成本方式回答"自上次同步以来，云端哪些会话变了"，避免每轮拉全量摘要；
- 面向的是"大量会话、频繁增量"的场景，期望用一条全局 revision 流驱动所有设备。

因此引入 `GET /v1/cursor?since=<revision>`：返回自某个 revision 以来的会话摘要与墓碑。
后续在 v2 中演化为 `GET /v2/changes?cursor=<opaque>`。

## 2. v1 设计

### 2.1 端点与游标

```http
GET /v1/cursor?since=<revision>&limit=200
```

`listChanges(db, since, limit)` 返回：

```json
{
  "revision": 250,
  "sessions": [
    { "sessionId": "…", "revision": 101, "formatVersion": 4, "batchCount": 12,
      "headChainHash": "…", "manifestDigest": "…", "updatedAt": 1790000000000,
      "deletedAt": null }
  ],
  "tombstones": [
    { "sessionId": "…", "createdAt": 1790000000000, "deletedAt": 1790000000000 }
  ],
  "hasMore": true
}
```

- 会话查询：`revision > since ORDER BY revision LIMIT limit+1`；
- 墓碑查询：`deleted_at > since ORDER BY deleted_at LIMIT limit+1`；
- **返回的 `revision` 是查询时的当前全局 revision**，不是"这一页最后一条的 revision"。

### 2.2 客户端

`pullOnce(deps, state)`：

1. `GET /v1/cursor?since=state.revision`；
2. 对返回的每个会话：
   - 有 `deletedAt` → `tombstone`，跳过；
   - 本地没有 → 拉完整帧链；
   - 本地有 → 读远端 manifest/header，先比 `createdAt` / `formatVersion` / `workspaceKey`，
     再比会话头 `headChainHash`，然后 `verifySharedPrefix`（逐批校验本地事件与远端帧链的共享前缀）；
   - 比较 `lastSeq` / `safeThroughSeq`：本地落后就只拉缺的事件，本地领先就 `local-ahead`，
     相等就 `up-to-date`，会话 live / 写句柄被占就 `local-active` / `write-owned`；
3. 成功后 `state.revision = value.revision`，`state.cursor = value.nextCursor`。

推送侧不走游标，只比较本地末序号与远端 `lastSeq`，再补 `end-seed`、上传缺失帧。

## 3. v1 为什么会漏

### 3.1 服务器把游标推到了"现在"

第一页返回 `revision = readRevision(db)`（当前全局 revision）。客户端把它当作下一页的 `since`：

```text
全局 revision = 250，远端 300 个会话
since=0    → 第一页 200 条，revision=250，hasMore=true
since=250  → 第二页：revision > 250 的条目不存在 → 空
```

剩下 100 个会话永远不会出现在列表里。表现就是"会话明明有更新，本地不发现"。

### 3.2 会话与墓碑共用一个 limit / 游标

- 两路查询共用 `since`，但 `since` 是 revision，墓碑用 `deleted_at`（毫秒时间戳）比较，量纲不同；
- 墓碑会反复满足 `deleted_at > since`，占用每页名额；
- 任一路溢出时 `hasMore` 都为 true，但返回的 revision 已经推到当前值。

### 3.3 对比逻辑本身没问题

漏的不是"对比"，而是"发现"：游标把会话整个跳过了，后面的 `lastSeq` / `headChainHash` /
共享前缀校验再正确也没有机会执行。

## 4. v2 重设计（2026-10-27）

- 全量列表改用独立快照 `GET /v2/sessions?cursor=<opaque>&limit=200`（按 `session_id` keyset 分页）；
- 变更流改为 `GET /v2/changes?cursor=<opaque>`：
  - 会话与墓碑**各自推进**：`revision` 用全局 revision，墓碑用 `(deletedAt, sessionId, createdAt)`；
  - 服务器返回**基于本页内容**的 `nextCursor`：会话 `nextRevision = 本页还有更多 ? 最后一条 revision : highWater`；
  - 客户端只回传 opaque cursor，不再自己拼 `since`；
- 新增 `manifestDigest`、ETag/304、批次分页等配套。

v2 修复了 v1 的"翻页漏会话"，但仍保留了一个前提：客户端必须持续消费变更流。

## 5. 后续演进与放弃

| 时间 | 事件 |
|---|---|
| 2026-10-19 | 设计讨论：端点表加入 `/v1/cursor`；"水位三选一"推荐服务端 per-device 游标 |
| 2026-10-19 09:25–10:25 | 实现 `/v1/cursor`、`listChanges`、游标测试 |
| 2026-10-20 04:47–04:50 | 实现 `pullOnce`：`/v1/cursor?since=state.revision` |
| 2026-10-21 | 记录 `pullOnce` 的问题："扫到 cursor 里的会话就全部 apply，一个错误就停整轮" |
| 2026-10-27 04:09–04:19 | 发现 v1 分页缺陷：记录"超过 200 个远端会话只看到第一页" |
| 2026-10-27 09:52 | v2 改为双游标 + 真 `nextCursor`；测试"分开推进会话与墓碑游标，且不漏项" |
| 2026-10-28 | **插件 0.1.0** 发布（v2 协议；pull 仍走 `pullOnce` + cursor） |
| 2026-11-07 | **插件 0.1.1**（`5b02646` 重构同步事务）：任务模式 + 快照摘要规划，`pullOnce` 不再被调用 |
| 2026-11-09/10 | 0.1.4 前后引入 `/v2/sessions` 快照 + receipt + 字节数判断 |
| 2026-11-11 | 从服务端移除 `/v2/changes`、`listV2Changes`、`changes-cursor` capability 与相关测试 |

放弃的直接原因：

- 当前场景同时推送的会话通常 **< 10 个**，全量快照 + receipt 已经足够；
- 两套真相（快照 / 变更流）增加理解和维护成本；
- 任务模式后游标没有任何调用方，服务端却为它保留了数个版本。

## 6. 现行做法

- 发现：`GET /v2/sessions` 分页快照（客户端 15s 缓存）+ 本地快照 + receipts；
- 规划：`planSync` 比较 `remoteLastSeq` / `remoteHeadChainHash` / 本地大小或 revision / receipt；
- 执行：按会话直接 `pullSessionTask` / `pushSessionTask`，不再经过变更流；
- 删除：墓碑仍在数据库中（`deleteSession` / `tombstones`），但不通过变更流推送；已删除会话从快照列表过滤。

## 7. 移除记录

服务端（2026-11-11）：

- 删除 `GET /v2/changes` 路由与 `listV2Changes`、`V2Tombstone`、`V2TombstoneCursor`；
- 删除 `decodeChangesCursor` 与 `V2_CHANGES_PATH`；
- `/health.capabilities` 移除 `changes-cursor`；
- 删除/改写相关测试（`sync.test.mjs`、`v2-read.test.mjs`、`v2-compression.test.mjs`）。

插件（待下个版本）：

- 删除 `pullOnce`（250 行）、`readCursor`（30 行）、cursor 相关类型与测试；
- `state.revision` / `PullState.cursor` 降级为兼容字段，随后移除；
- `PullReport` / `PullState` 仅保留任务模式实际使用的部分。
- 本版本先把依赖 `pullOnce` 的 9 个集成用例标记为 `test.skip`（服务端 `/v2/changes` 已移除），
  下个插件版本迁移到 `pullSessionTask` 后恢复。

## 8. 经验

1. **游标必须按"本页最后一条"推进**，不能用"服务器当前值"；分页的正确性优先于"省一次请求"。
2. **两路数据不要共用一个游标/limit**，量纲不同时尤其危险。
3. **只有一套真相**：既然规划已经需要全量快照，就不要额外维护一条变更流；否则迟早出现"两套账对不上"。
4. 发现（哪些会话变了）和对比（缺哪些事件）必须分开验证；"漏更新"往往发生在发现阶段，而不是对比阶段。

## 参考

- 现行协议：`docs/architecture/PROTOCOL.md`
- 结论：游标只作为历史方案保留在本文，不再进入实现。
