# 会话删除设计：存档 / 移除 / 重置

> 状态：设计稿（2026-11-11），尚未实现。目标是把"删除"拆成三种明确语义，
> 既支持"停止同步、以后还能恢复"，也支持"删掉后从某台设备全量重推"。

## 1. 三种模式

| 模式 | 数据 | 墓碑 | 可恢复 | 释放空间 | 客户端表现 |
|---|---|---|---|---|---|
| **存档**（archive） | 保留帧/blob/manifest | 有 | 可 `restore` | 否 | 快照里标记"已存档"，不推不拉 |
| **移除**（remove） | 删帧/blob，清 manifest | 有 | 否 | 是 | 快照里标记"已移除"，不推不拉 |
| **重置**（reset） | 删行 + 删墓碑 + 删 blob | **无** | — | 是 | 会话消失；指定设备按"远端没有"全量重推 |

关键区别：

- 存档和移除都保留墓碑，因此**同一生命周期**的推送仍返回 `gone`，防止旧设备复活；
- 重置删除墓碑，允许**同一个 `sessionId + createdAt`** 重新创建；这是"删除后全量重推"的唯一入口。

## 2. 数据模型

### 2.1 `sessions` 增加

```sql
ALTER TABLE sessions ADD COLUMN purged_at INTEGER;
```

- `deleted_at`：存档/移除的时间；
- `purged_at`：帧/blob 被清理的时间；`NULL` 表示数据还在（可恢复），非 `NULL` 表示已移除、不可恢复。

### 2.2 `tombstones`

沿用现有表，`deleted_by` 取值：

- `device:<deviceId>`：设备主动删除（现有语义）；
- `admin:archive`：管理台存档；
- `admin:remove`：管理台移除。

存档/移除只对目标生命周期（`sessionId + createdAt`）生效；重置会删除该 session 的**全部**墓碑。

### 2.3 新表 `session_resets`

```sql
CREATE TABLE session_resets (
  dataset    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reset_at   INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  device_id  TEXT,                -- 可选：只允许这台设备重建
  PRIMARY KEY (dataset, session_id)
);
```

- `device_id IS NULL`：重置后第一台推送的设备获胜；
- `device_id` 指定：只有该设备可以 append，其它设备返回 `conflict`；
- `expires_at`（默认 24h）：过期后可清除记录，回到"先到先得"。

### 2.4 `append_requests`

重置时必须删除该 session 的所有 `append_requests` 行。

原因：插件的幂等键是 `${clientId}:${sessionId}:${baseIndex+1}`，重置后 `baseIndex` 回到 -1，
键会与首次上传相同；旧请求记录会让服务端走幂等回放/冲突，导致重推失败。

## 3. 管理端 API

所有接口使用管理台 cookie，body 带 `createdAt` 防止误操作新生命周期。

```text
POST /admin/sessions/:id/archive   { createdAt }
POST /admin/sessions/:id/remove    { createdAt }
POST /admin/sessions/:id/reset     { createdAt, deviceId? }
POST /admin/sessions/:id/restore   { createdAt }
```

语义：

- `archive`：`deleted_at=now`，写墓碑 `deleted_by='admin:archive'`，不动 blob；
- `remove`：同 archive，加 `purged_at=now`，删帧/blob，清空 manifest 的 frames，`stored_bytes=0`；
- `reset`：清 blob/帧、删除 sessions 行、删除该 session 全部 tombstones、清 append_requests、写 `session_resets`；
- `restore`：仅当 `deleted_at IS NOT NULL AND purged_at IS NULL`；清 `deleted_at`、删对应墓碑、`updated_at=now`、`bumpRevision`。

管理端 `GET /admin/sessions` 增加字段：

- `deletedAt`、`deletedBy`、`purgedAt`、`resetPending`（是否有 reset 记录）。

## 4. 设备端 API

### 4.1 快照可带已删除会话

```text
GET /v2/sessions?includeDeleted=1&cursor=...&limit=...
```

- 默认行为不变（只返回未删除）；
- `includeDeleted=1` 时，已删除/已移除会话以摘要形式返回：
  - `deletedAt`、`deletedBy`、`purgedAt`；
  - `frames` 不返回（快照本来就是摘要，不涉及 manifest 内容）。
- 插件在规划时请求 `includeDeleted=1`，把本地仍存在的会话标记为 `blocked`（"远端已存档/已移除"），
  不再每轮尝试 push 然后吃 `gone`。

### 4.2 append 时的重置闸门

`appendFrames` 在创建/追加前检查 `session_resets`：

- 存在记录且 `device_id` 非空且不等于当前设备 → `409 conflict`："该会话正在等待指定设备重建"；
- 存在记录且 `device_id` 为空：允许当前设备，成功后删除 reset 记录；
- 记录已过期：删除记录，按正常流程处理。

插件的错误分类把该 `conflict` 标成不可重试的 `blocked`，避免 UI 每轮报错。

## 5. 存储释放算法

输入：`sessionId + createdAt` 对应的 manifest。

```text
hashes = manifest.frames[].blobSha256
for h in hashes:
  if h 被其它 sessions.manifest_json 引用: continue
  if h 在 vault_records.blob_sha256 中出现: continue
  删除 blobs 行
  删除 blobs/<前两位>/<hash> 文件
```

- 真实数据（2026-11-11）实测：74 个会话、6,133 个 blob，
  **0 个 blob 被多个会话共用**，会话帧与 Vault blob 也 0 重叠；
- 因此按会话直接删在实践中安全，但保留上面的引用检查以支持未来的附件同步/并发上传；
- 26 个非会话 blob 实际是 Vault 记录，不能删；
- `usedBlobBytes` 自动下降。

## 6. 并发与租约

- `archive/remove`：在事务中写 `deleted_at`；设备并发 append 会因 `deleted_at` 检查得到 `gone`，安全；
- `reset`：必须清理正在被设备 append 的窗口。建议：
  - 事务内删除行/墓碑/blob 引用；
  - 同时删除 `leases` 中 `resource='sync'` 的行（强制当前设备下轮重新申请）；
  - 管理台确认框写明"会中断正在进行的同步"；
- 指定设备重建：重建成功（append 创建新生命周期）后删除 reset 记录；失败/超时保留，管理台可"清除重置状态"。

## 7. 客户端行为

### 7.1 存档/移除

`planSync` 的 `remote.deletedAt` 分支已经存在：直接 `blocked`，不再 push/pull。
需要做的只是让 `readRemoteSummaries(includeDeleted=1)` 把已删除摘要带回来。

本地副本保留；UI 提示"远端已存档/移除，本机副本不再同步"。
用户可自行在 DSH 里删除本地会话；插件不自动删。

### 7.2 重置

- 目标设备：快照里没有该会话 → `remote-missing` → `push` → 服务端允许（若指定了设备）→ 全量上传；
- 其它设备：同样会尝试 push，但服务端返回 `409`（指定设备时）或推送后因生命周期/链校验失败变 `diverged`；
- 插件把 `409 reset-pending` 记为 `blocked`，显示"等待指定设备重建"。

## 8. 管理台 UI

会话行状态：

- 正常；
- 已存档（灰）；
- 已移除（灰，标注"空间已释放"）；
- 重置中（等待重建）。

行内「更多」菜单：

- 存档（确认：停止同步，数据保留，可恢复）；
- 移除并释放空间（红色确认：不可恢复）；
- 重置远端（弹层：可选"只允许指定设备重建"下拉列表；警告会中断同步）；
- 恢复（仅存档行可见）。

## 9. 边界情况

1. **同一 sessionId 的多个生命周期**：archive/remove 按 `createdAt` 定位；reset 清该 id 的所有墓碑和行；
2. **存档后恢复**：只允许 `purged_at IS NULL`；恢复后设备可能 push/pull，需提示分叉风险；
3. **重置后错误设备先推**：指定设备场景由服务端 409 拦住；未指定场景由"先到先得"决定，UI 需提示；
4. **孤儿 blob**：重置/移除后若出现未被引用的 blob（并发上传），后续 GC 清理，不影响正确性；
5. **Vault blob**：purge 永不删除 `vault_records.blob_sha256` 引用的 blob；
6. **幂等键**：重置必须清 `append_requests`，否则重推会撞旧幂等记录。

## 10. 测试

- archive：快照不含该会话；`includeDeleted=1` 含 `deletedAt`；blob 仍在；设备 push → `gone`；
- remove：`purgedAt` 写入；blob 行/文件删除；`usedBytes` 下降；墓碑仍在；
- reset：sessions/tombstones/append_requests/blob 都清；指定设备 append 成功；其它设备 409；
- restore：存档后恢复，快照重新出现，blob 完整；
- 并发：reset 与 append 同时发生（事务/租约）；
- Vault 引用保护：构造 vault blob 与会话 blob 相同 hash，purge 不删；
- 共享 blob 保护：构造两个会话引用同一 blob，purge 不删。

## 11. 发布顺序

1. 服务端：schema 迁移（`purged_at`、`session_resets`）、三种 admin API、快照 `includeDeleted`、append 闸门、测试；
2. 管理台：状态与四个动作、确认弹层、设备选择；
3. 插件（下个版本）：`readRemoteSummaries` 请求 `includeDeleted=1`，把 deleted 摘要并入 plan；
4. 协议版本：`includeDeleted` 是向后兼容的查询参数，`PROTOCOL_VERSION` 不变；服务端版本升 0.1.4。
