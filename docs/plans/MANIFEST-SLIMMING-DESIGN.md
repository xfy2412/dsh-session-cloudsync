# manifest 瘦身与变更流 v3（0.2.0）

> 状态：设计稿（2026-11-15，待实施）。把 0.2.0 的三件事写在一起：
> **A. 增量前缀校验**、**B. 变更流 v3**、**C. manifest 默认只回头**。
> 三者是同一个目标的三块：不再每轮为每个会话拉全量 refs + 重算全前缀。

## 1. 问题与实测

2026-11-14 取真实 manifest（`session-0fa59145…`，467 帧）：

| 指标 | 值 |
| --- | --- |
| manifest 体积 | 170,662 B，约 365 B/帧 |
| 哈希字段占比 | 208 hex 字符 ≈ 57% |
| 密文总量 | 10.46 MB（manifest 占 1.6%） |
| 帧粒度 | 44 事件/帧，全部 zstd |
| 全库 | 74 会话，manifest 合计 2.28 MB，最大 554 KB |

当前每次 push/pull（远端存在时）：

1. `GET /manifest` 拿全部帧的 `seqFrom/seqTo/chainHash`；
2. `verifySharedPrefix` 遍历**全部**远端帧，对每帧把本地事件按远端边界重新哈希；
3. 只有哈希不等或末尾跨批时才下载那一个批次。

代价是 O(帧数) 流量 + O(事件数) 本地哈希，每轮重复。1510 帧的会话每次推送都要重算 6.9 万事件。

## 2. 已拍板

- **A：增量前缀校验**，本地会话只增不改是常态，receipt 作为信任锚点；
- **B：0.2.0 复活变更流，按 v3 重新设计**，快照仅作 bootstrap / 游标过期兜底；
- **C：`/manifest` 默认只回头**，refs 走 `/batches`；
- 变更日志保留策略：**设备游标 + 30 天兜底**；
- **吊销长期不上线的设备时，删除它的游标行**（或从水位计算中排除），水位才能前进；
- bootstrap 仍用 `/v2/sessions` 快照，响应补 `revision` 字段；
- P2（帧表）**后置**，不随 0.2.0 做（不影响 wire）。

## 3. A：增量前缀校验

### 3.1 信任锚点

receipt 已带 `remoteLastSeq`、`remoteHeadChainHash`、`localSizeBytes`、`localRevision`、`formatVersion`。
新增：

```json
{
  "receiptVersion": 2,
  "verifiedThroughSeq": 69586,
  "remoteBatchCount": 1510,
  "verifiedAt": 1794728311532
}
```

- `verifiedThroughSeq`：本机曾完整校验到的本地末序号；
- `remoteBatchCount`：当时远端帧数，用于和 `/summary` 的 `batchCount` 直接比对。

### 3.2 稳态路径（每轮）

1. 从变更流拿到该会话的新 `lastSeq / headChainHash / batchCount`；
2. `headChainHash` 与 receipt 相同 → 远端没变，**不校验、不拉 manifest**；
3. 变了 → 只取 `from = verifiedThroughSeq` 所在帧到头的帧引用（`/batches?from=…`），校验与本地重叠的那一帧和新增帧；
4. 校验通过后更新 receipt（`verifiedThroughSeq` = 新末序号）。

### 3.3 全量校验的触发条件

- 没有 receipt（新机、旧状态、手工拷入的会话）；
- `formatVersion` / `createdAt` / `workspaceKey` 与远端不一致；
- 本地文件变小，或 `localLastSeq < receipt.verifiedThroughSeq`（被截断/重写）；
- `replace` 之后（回执会被作废）；
- 游标过期退回快照时，对本地存在但没有可信 receipt 的会话做一次；
- 用户显式点「校验完整性」（未来入口）。

全量校验**不需要 manifest**：服务端提供

```text
GET /v2/sessions/:id/chain?from=<index>&limit=<n>
→ [{ "index": 1, "seqFrom": 0, "seqTo": 43 }, …]
```

客户端按边界本地重算帧哈希，再与服务端的分块摘要比对：

```text
GET /v2/sessions/:id/chain-digests?block=64&fromBlock=0
→ [{ "first": 1, "last": 64, "digest": "…" }, …]
```

- `digest = sha256(stableStringify([[seqFrom, seqTo, chainHash], …]))`，块内按帧序；
- 摘要一致 = 整段一致；不一致再取那一块的 `chain` 明细和批次密文逐事件比对；
- 467 帧时：bounds ≈ 5 KB + 摘要 ≈ 0.3 KB（对比 manifest 170 KB）。

实现顺序上允许先只落 `/chain`（紧凑链，约 60 B/帧），再补分块摘要；两者语义一致，客户端不用改判定逻辑。

### 3.4 receipt 作废

`replace`、生命周期变化（`createdAt` 变）、本地文件缩小、`formatVersion` 变化、游标过期时的全量校验，
都要清掉或重写 receipt，避免用旧锚点跳过校验。

## 4. 变更流 v3

### 4.1 数据

```sql
CREATE TABLE session_changes (
  revision INTEGER PRIMARY KEY,   -- 全局单调（复用 meta.revision）
  dataset TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,    -- 会话生命周期 createdAt
  at INTEGER NOT NULL,            -- 变更墙钟时间
  kind TEXT NOT NULL,             -- append|delete|archive|restore|remove|reset
  last_seq INTEGER,
  head_chain_hash TEXT,
  batch_count INTEGER,
  format_version INTEGER,
  safe_through_seq INTEGER,
  tail_open INTEGER,
  workspace_key TEXT,
  parent_session TEXT,
  origin TEXT,
  delegation_depth INTEGER
);

CREATE TABLE device_cursors (
  device_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- 每次会话变更在**同一事务**里写一行（append / 删除 / 存档 / 恢复 / 移除 / 重置）；
- `reset` 目前会删 `sessions` 行，必须靠变更日志让其它设备知道“该会话被重置”；
- 设备每次拉 changes 时更新自己的 `device_cursors`。

### 4.2 API

```text
GET /v2/changes?cursor=<opaque>&limit=200
```

```json
{
  "changes": [
    {
      "sessionId": "session-…",
      "revision": 1234,
      "kind": "append",
      "createdAt": 1794048068541,
      "formatVersion": 4,
      "lastSeq": 69590,
      "headChainHash": "…",
      "batchCount": 1510,
      "safeThroughSeq": 69590,
      "tailOpen": false,
      "workspaceKey": "…"
    },
    { "sessionId": "session-…", "revision": 1235, "kind": "reset", "workspaceKey": "…" }
  ],
  "nextCursor": "opaque-or-null",
  "hasMore": false,
  "highWater": 1240,
  "stale": false
}
```

- 游标不透明；`nextCursor` 只基于**本页最后一条**，不返回“当前水位”；
- 按 `revision` 升序；`stale: true` 表示游标早于保留水位，客户端退回快照；
- 首次同步：`GET /v2/sessions` 快照（响应补 `revision`），之后只用 changes；
- 旧插件继续走快照，互不影响。

### 4.3 保留与水位

- 水位 = `min(所有存活设备游标的最小 revision, 30 天前对应的 revision)`；
- 清理 `revision < 水位` 的变更行；
- **吊销设备时删除其 `device_cursors` 行**（或在计算时排除已吊销设备），否则一台长期离线的设备会把水位钉死；
- 设备被吊销后重新上线属于新设备，游标从空开始 → 快照 bootstrap；
- 清理任务：启动后每天一次 + 管理台/CLI 手动触发（与 GC 共用触发点即可）；
- 删除记录写 `audit_events`（只留计数与水位，不留内容）。

### 4.4 客户端行为

- 新增状态 `changesCursor`（按 server+token 隔离），每轮成功消费后持久化；
- `stale: true` → 丢游标，走一次快照，再按快照里的 `revision` 继续；
- `kind: 'delete' | 'remove'` → 现有墓碑/阻塞逻辑；`'reset'` → 现有重置闸门与重建流程；
- changes 只提供“发现”，不提供 refs；refs 仍按会话从 `/batches?from=…` 取。

## 5. manifest 瘦身（C）

```text
GET /v2/sessions/:id/manifest           → 头信息（默认，不含 batches）
GET /v2/sessions/:id/manifest?batches=1 → 旧形状（兼容 0.1.x 插件）
GET /v2/sessions/:id/batches?from=&limit=
GET /v2/sessions/:id/chain?from=&limit=
GET /v2/sessions/:id/chain-digests?block=64
```

默认 manifest 只返回：

```json
{
  "sessionId": "session-…",
  "formatVersion": 4,
  "createdAt": 1794048068541,
  "lastSeq": 69590,
  "batchCount": 1510,
  "headChainHash": "…",
  "manifestDigest": "…",
  "safeThroughSeq": 69590,
  "tailOpen": false,
  "workspaceKey": "…",
  "parentSession": null,
  "origin": null,
  "delegationDepth": null,
  "updatedAt": 1794729684274
}
```

`/batches` 保持现有形状（含 `attachmentIndexSha256` / `attachmentBlobs`）。
`/manifest?batches=1` 保留一个版本周期，之后移除。

## 6. 版本与兼容

- `PROTOCOL_VERSION` 升 **4**（manifest 默认形状变化是破坏性的）；
- `/health` 新增 capability：`changes-v3`、`manifest-head`、`chain-digests`；
- 服务端过渡期同时宣告 `protocols: [4, 3]`，旧插件（内置协议 3）继续可用；
- 数据库 schema 升 **7**（`session_changes`、`device_cursors`），迁移前自动备份；
- 新插件 + 旧服务端：capability 缺失 → 回退快照 + `?batches=1`，行为同 0.1.5；
- 旧插件 + 新服务端：走兼容路径，manifest 仍可拿全量。

## 7. 成本对比（稳态一轮，1 个会话变化）

| 项 | 现在 | 0.2.0 |
| --- | --- | --- |
| 发现 | `/v2/sessions` 快照 20–35 KB | `/v2/changes` 几百字节 |
| refs | 每会话 `/manifest` 30–170 KB | 变更会话 `/batches?from` 一页 |
| 校验 | 全前缀 O(事件数) 重哈希 | 增量：重叠帧 + 新帧 |
| 全量校验 | 就是上面的路径 | 只在触发条件下做，材料约 5 KB |

## 8. 测试

- changes：分页不漏项、墓碑/存档/恢复/移除/重置各自出现、`nextCursor` 只推进到本页末；
- 保留：水位计算、30 天兜底、吊销设备后水位前进、游标过期返回 `stale`；
- 快照 bootstrap 带 `revision`，与 changes 衔接无重不漏；
- A：锚点命中跳过校验；只新增帧时只验新帧；本地被改写/截断时全量校验并 blocked；
- `replace` 后回执作废；
- manifest `?batches=1` 与默认形状；旧插件兼容路径；
- chain/chain-digests 与本地重算一致，块边界正确；
- schema 7 迁移与回滚（迁移前备份存在）。

## 9. 实施顺序

1. 服务端：`session_changes` + `device_cursors` + `/v2/changes` + 水位清理；
2. 服务端：manifest 默认只回头 + `/chain`（先紧凑链，再分块摘要）+ 兼容参数；
3. 插件：A 增量校验（receipt v2、锚点、全量触发条件）；
4. 插件：changes 消费与 `changesCursor`，快照回退；
5. 测试与文档；P2（帧表）另开。

## 10. 待定

- 分块摘要的块大小（暂定 64）与哈希输入是否包含 `index`；
- 是否在 0.2.0 就删 `/v2/sessions` 快照的稳态用途（建议保留给 admin/设置页，不删端点）；
- 管理台是否展示 changes 水位与保留窗口；
- 多 dataset 场景下 revision 是否全局单调（当前单 dataset，暂按全局）。
