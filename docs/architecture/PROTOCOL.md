# 协议（v2-only）

> 状态（2026-11-10）：服务端 **0.1.2** v2-only；插件 **0.1.4** 走 v2 路径、changes cursor、
> 幂等 append、批量 blob 与 zstd 写入。
> `PROTOCOL_VERSION = 3`，设备 API 只有 `/v2/*`，旧的 `/v1/*` 已全部移除。
> 旧插件请求任何 `/v1/*` 都会得到 404；这是 0.1.0 的破坏性变更。
>
> 管理台（`/admin/*`）和初始化向导（`/setup/*`）不属于设备 API，仍然保留。

## 认证

### 设备 API（`/v2/*`）

- `Authorization: Bearer <token>`。
- 两种角色：**setup token**（初始化阶段管理设备）与**设备 token**（代表一台设备）。
- 设备身份以 token 对应的 `deviceId` 为准；`X-Device-Id` 若携带必须与 token 一致。
- 会话/租约写路径还需要 `X-Client-Id`（16–64 位小写十六进制，`http.ts:257-264`），用于租约 owner 和冲突检测；
  具体是 append、delete、`/v2/sync/lease`、`/v2/vault/lease`、`/v2/vault/append`（blob 上传不需要）。

### 管理台（`/admin/*`）

- 首次启动通过 `/setup` 向导设置管理密码；服务端控制台打印一次性初始化密钥。
- 之后浏览器用密码登录：`POST /admin/login { password }` → HttpOnly、SameSite=Strict cookie。
- 管理台不接受 bearer token，设备 API 不接受 cookie，两套认证互不复用。

## 健康与能力

```http
GET /health
```

这是未版本化端点，返回（`server.version` 直接读 `packages/server/package.json`，见 `packages/server/src/http.ts:59-69`）：

```json
{
  "ok": true,
  "server": {
    "version": "0.1.2",
    "apiVersions": [2],
    "protocols": [3],
    "schemaVersion": 4,
    "capabilities": [
      "session-summary",
      "changes-cursor",
      "conditional-get",
      "idempotent-append",
      "manifest-digest",
      "batches",
      "batch-upload",
      "batch-download",
      "zstd-frame"
    ],
    "limits": {
      "batchBytes": 8388608,
      "batchBlobs": 64,
      "blobBytes": 33554432
    }
  },
  "now": 1790000000000
}
```

不再有 `/v1/health`，也没有 `/v2/health`。

**响应包络**：除 `/health` 与二进制 blob 下载外，设备 API 的 JSON 响应统一是
`{ "ok": true, "value": … }`（`packages/server/src/http.ts` 的 `json()` 调用点）；
失败统一是下文「错误码」里的 `{ "ok": false, "error": … }`。本节及之后的示例只写 `value` 的内容，
实际 HTTP body 外面还有一层包络。

## 设备端点

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v2/devices` | setup token 签发设备 token（明文只返回一次） |
| GET | `/v2/devices` | setup token 列出未吊销设备 |
| DELETE | `/v2/devices/:id` | setup token 吊销设备 |
| GET | `/v2/me` | 当前 token 的角色；设备 token 另带服务端版本/配额/远端统计 |
| PATCH | `/v2/me` | 设备 token 给自己改名（`{label}`，1–64 字符） |
| POST | `/v2/blobs?kind=frame\|attachment\|vault` | 上传单个密文 blob |
| HEAD | `/v2/blobs/:sha256` | 判断 blob 是否存在 |
| GET | `/v2/blobs/:sha256` | 下载单个密文 blob |
| POST | `/v2/blobs/batch` | 批量上传密文 blob |
| POST | `/v2/blobs/batch/read` | 批量下载密文 blob |
| POST | `/v2/sync/lease` | 申请/续租全局单写者租约 |
| DELETE | `/v2/sync/lease` | 释放全局租约 |
| GET | `/v2/sessions` | 全量会话快照（keyset 分页） |
| GET | `/v2/changes` | 会话变更 + 墓碑增量流 |
| GET | `/v2/sessions/:id/summary` | 会话摘要（ETag） |
| GET | `/v2/sessions/:id/manifest` | 完整 manifest |
| GET | `/v2/sessions/:id/batches` | 批次引用分页 |
| POST | `/v2/sessions/:id/append` | 提交新批次（需要全局租约） |
| POST | `/v2/sessions/:id/delete` | 会话墓碑（body `{createdAt}`，需要全局租约） |
| POST/DELETE | `/v2/vault/lease` | Vault writer 租约 |
| POST | `/v2/vault/append` | 追加 Vault 记录索引 |
| GET | `/v2/vault/cursor` | Vault 记录 cursor |
| GET | `/v2/vault/stream/:writer` | 某 writer 的 Vault 记录索引 |

## 会话快照与变更流

### 全量快照

```http
GET /v2/sessions?cursor=<opaque>&limit=200
```

返回未删除会话（下面是 `value` 的内容，外层还有 `{"ok":true,...}`）：

```json
{
  "sessions": [{
    "sessionId": "session-…",
    "revision": 40,
    "formatVersion": 4,
    "createdAt": 1790000000000,
    "batchCount": 1509,
    "lastSeq": 69586,
    "headChainHash": "…",
    "manifestDigest": "…",
    "workspaceKey": "…",
    "safeThroughSeq": 69586,
    "tailOpen": false,
    "parentSession": null,
    "origin": null,
    "delegationDepth": null,
    "updatedAt": 1790000000000,
    "deletedAt": null,
    "compression": "zstd",
    "storedBytes": 56101098
  }],
  "nextCursor": "opaque-or-null"
}
```

- `cursor` 是不透明字符串；第一页不传，最后一页 `nextCursor` 为 `null`。
- 快照按 `sessionId` keyset 分页，不再用全局 revision 当页游标；`limit` 默认 200、上限 1000。
- 摘要字段来自 `V2SessionSummary`（`packages/server/src/sessions.ts:429-455`）：`workspaceKey`、`parentSession`、`origin`、
  `delegationDepth` 在缺失时为 `null`（不是省略）。
- `compression`：`none` / `zstd` / `mixed`。
- `storedBytes`：本会话所有封帧的密文字节总和。

### 变更流

```http
GET /v2/changes?cursor=<opaque>&limit=200
```

`value` 内容：

```json
{
  "sessions": [ /* 同快照摘要，只含未删除会话 */ ],
  "tombstones": [
    { "sessionId": "…", "createdAt": 1790000000000, "deletedAt": 1790000000000 }
  ],
  "nextCursor": "opaque",
  "hasMore": false
}
```

- 会话和墓碑各自推进游标；墓碑使用 `(deletedAt, sessionId, createdAt)` 处理同毫秒删除。
- 第一页不传 `cursor`；后续必须原样带回 `nextCursor`。
- 已删除会话通过 `tombstones` 传达，不再出现在 `sessions`。

### 摘要与条件请求

```http
GET /v2/sessions/:id/summary
If-None-Match: "<manifestDigest>"
```

返回摘要（`value` 内容），且带 `ETag: "<manifestDigest>"`；摘要内容与快照条目一致，包括
`compression` / `storedBytes`。命中 `If-None-Match` 返回 `304`（无 body）。

### manifest 与批次

```http
GET /v2/sessions/:id/manifest
GET /v2/sessions/:id/batches?from=<index>&limit=<n>&expectedManifestDigest=<digest>
```

- manifest 响应是 `value: { manifest, revision }`，`manifest.batches` 是完整批次链（协议字段不再用 `frames`；
  服务端内部仍叫 `frames`，响应时由 `withBatchFields` 改名）。
- `batches` 响应包含 `manifestDigest`、`revision`、`batchCount` 与本页的 `batches`；`from` 默认 0、`limit` 默认 500（上限 1000）。
- 若传入 `expectedManifestDigest` 且与当前 manifest 不符，返回 `409 conflict`，不要拼接不同 revision 的页。

## 租约与 append

- 租约 TTL **60 秒**；owner 为 `(deviceId, clientInstanceId)`；被别的 owner 持有时申请/续租返回 `409 lease-held`
  （`packages/server/src/leases.ts:13-16,53-82`）。
- 全局单写者资源为 `sync`（创建/append/删会话都要它）；Vault 使用 `vault-writer:<writer>`。
- 拉取（manifest/summary/changes/batches/blob 读取）不需要租约。
- append 请求体只带新增/替换的批次（规范字段是 `batches`，服务端不再接受旧的 `frames`，见 `http.ts:425-427`）：

```json
{
  "baseIndex": 9999,
  "baseChainHash": "…",
  "createdAt": 1790000000000,
  "formatVersion": 4,
  "workspaceKey": "…",
  "parentSession": "session-…",
  "origin": "subagent",
  "delegationDepth": 1,
  "tailOpen": false,
  "safeThroughSeq": 69586,
  "batches": [ /* SealedFrameRef */ ]
}
```

- 首次创建：`baseIndex=-1, baseChainHash=null`；链从 index 0（封好的会话头）开始，事件批次从 index 1 开始。
- 尾批替换：`baseIndex = 当前批次链倒数第二个下标`（`batches.length-2`），新批次从该下标 +1 开始。
- 服务端校验链的前缀延续，不解析明文；请求体上限 8 MiB（`MAX_APPEND_BODY_BYTES`，`packages/server/src/sessions.ts:21`）。
- `workspaceKey`/`parentSession`/`origin`/`delegationDepth` 可选；一旦写过就不能在后续 append 里改（`sessions.ts:272-292`）。
- append 必须带（形状 `[A-Za-z0-9._:-]{1,255}`；插件实际填 `${clientId}:${sessionId}:${baseIndex + 1}`，
  即新批次的起始下标，见 `packages/plugin/src/engine.ts:785`）：

```http
Idempotency-Key: <clientId:sessionId:groupIndex>
```

- 同一个 key + 同一请求内容：返回第一次成功的摘要，**不要求租约仍有效**（幂等重放在租约检查之前）；
- 同一个 key + 不同内容：返回 `409 conflict`；
- 幂等记录按 `deviceId + sessionId + key` 隔离；
- append / delete 返回的摘要也带 `compression` 与 `storedBytes`，插件可立即更新 UI。
- `POST /v2/sessions/:id/delete` 同样要求持有 `sync` 租约（`sessions.ts:374-379`）。

## 压缩

封帧有两种版本：

```text
sealedVersion 1：未压缩
sealedVersion 2：zstd 压缩（压缩在 AES-GCM 之前）
```

v2 帧的 manifest 条目额外带：

```json
{
  "sealedVersion": 2,
  "compression": "zstd",
  "compressedHash": "压缩后明文的 sha256"
}
```

- `chainHash` 始终是**未压缩规范 JSON** 的 sha256；
- 帧密钥由 `compressedHash + chainHash` 派生，避免不同压缩结果复用 key + nonce；
- AAD 绑定封帧版本；
- 服务端只存密文，不解压、不重新压缩；
- 旧未压缩帧仍可读；旧客户端读不了 v2 压缩帧。

已有未压缩会话不会自动迁移；要压缩只能清空远端后从本地全量重传。没有
`rewrite` 接口。

## 批量 blob

### 上传

```http
POST /v2/blobs/batch
Content-Type: application/x-dsh-blob-batch
```

```text
"DSHB" | version(1) | flags(1) | reserved(2) | count(u32 BE)
count × [ kind(1) | reserved(3) | bytes(u32 BE) | sha256(32) | data ]
```

- `kind`：1=frame，2=attachment，3=vault；
- 上限：整个请求 **8 MiB**、最多 **64 条**；单条 blob 的编解码上限是 **32 MiB**（`shared/src/blob-batch.ts:28-34`）；
- 上传条目的 `sha256` 是客户端声明的期望值，服务端必须重算并校验；
- 响应按请求顺序放在 `value.blobs` 里，每条 `{sha256, bytes, dedup}`；
- 重复内容返回 `dedup: true`，配额只计算新 blob；
- 批量请求体装不下（接近 8 MiB）或需要更大单 blob 时走 `/v2/blobs` 单条接口（默认单 blob 上限 32 MiB）。

### 下载

```http
POST /v2/blobs/batch/read
Content-Type: application/json

{ "sha256": ["…", "…"] }
```

响应同样是 `application/x-dsh-blob-batch`。任一 hash 缺失时，在发送二进制响应前
返回 JSON `404`。下载按请求顺序返回；客户端应校验每个条目的内容哈希。

### 单条 blob

```http
POST /v2/blobs?kind=frame|attachment|vault
HEAD /v2/blobs/:sha256
GET  /v2/blobs/:sha256
```

- 上传：新写入返回 `201`、内容已存在返回 `200`（`dedup: true`），`value` 为 `{sha256, bytes, dedup}`；
- `kind` 缺省 `frame`，其他值返回 `400`；空 body 返回 `400`；
- `HEAD` 只回状态码（存在 `200` / 不存在 `404` / 鉴权失败 `401`，无 body）；
- `GET` 返回 `application/octet-stream` 密文（`packages/server/src/http.ts:1044-1075`）。

## Vault

Vault 的设备台账与工作区 profile（L3 笔记尚未实现）使用 `/v2/vault/*`；blob 上传/下载复用
`/v2/blobs` 或 `/v2/blobs/batch*`，`kind=vault`。记录格式、writer 租约与 cursor
语义见 [VAULT.md](../sync/VAULT.md)。

- append 的 `writer` 必须等于当前 token 的 `deviceId`（`http.ts:1121-1122`）；
- writer 租约资源是 `vault-writer:<deviceId>`，append 前必须持有；
- 同一条记录的幂等重放发生在租约检查之前（`packages/server/src/vault.ts:180`）。

## 数据库与兼容

- SQLite `user_version = 4`（`SERVER_SCHEMA_VERSION`，`packages/server/src/db.ts:22`）。
- v2 → v3：新增 `vault_records`；租约是 60 秒瞬时状态，按需重建。
- v3 → v4：新增 `append_requests`、`sessions.compression`、`sessions.stored_bytes`；
  迁移前生成 `db.sqlite.bak-v<旧版本>-*` 备份，不删除会话/墓碑/设备/Vault。
- v2 → v4 也保留会话/墓碑等数据；旧租约视为瞬时状态重建。
- 服务端不保存明文；没有 rewrite/重压缩接口。
- 0.0.1 的数据库可以原地迁移，但 **0.0.x 插件不能继续用**：它只请求 `/v1/*`，
  会得到 404。升级服务端必须同时升级插件（当前 0.1.4）。
- （历史）若从 0.1.0 降级到 0.0.1，旧服务端会拒绝 schema 4；需恢复迁移前备份。

## 不变量

1. append 只接受「追加」或「替换最后一帧」：`start = baseIndex+1` 必须满足 `start >= 批次链长度-1`；
   `baseIndex`/`baseChainHash` 不匹配返回 `409 diverged`（`packages/server/src/sessions.ts:293-301`）。
2. 服务端无法验证 `chainHash`；它只校验封帧条目形状、`blobSha256`、字节数与 blob 是否存在。
3. 墓碑优先于帧：已删生命周期 append 返回 `410`；新 `createdAt` 是另一个生命周期。
4. blob 不可变、按内容寻址；尾帧被替换后旧 blob 成为孤儿。
5. `lastSeq` 单调；回退视为客户端缺陷。
6. 配额按唯一 blob 字节总和计算；超限返回 `507`。
7. 压缩帧的 `chainHash` 不变，但 `blobSha256`、`bytes` 会因压缩而不同。

## 错误码

`unauthorized` · `bad-request` · `not-found` · `conflict` · `diverged` ·
`lease-held` · `gone` · `quota` · `rate-limited`

HTTP 映射：

```text
401 · 400 · 404 · 409 · 409 · 409 · 410 · 507 · 429
```

`rate-limited` 目前只用于管理台登录与初始化密钥校验（同一来源 10 次/10 分钟，`http.ts:726-736`）。

失败响应统一为：

```json
{ "ok": false, "error": { "code": "…", "message": "…" } }
```

## 管理台端点

`/admin`、`/admin/login`、`/admin/logout`、`/admin/overview`、`/admin/quota`、
`/admin/devices`、`/admin/sessions` 保持不变，另增 `PATCH /admin/devices/:id`（`{label}`）改名；管理台不接受设备 bearer token。

初始化向导的 cookie 会话接口是 `/setup/state`、`/setup/verify`、`/setup/password`、`/setup/quota`、
`/setup/device`、`/setup/complete`（`packages/server/src/http.ts:1198-1292`；向导会话 15 分钟，
初始化密钥 10 分钟且只在未完成初始化时每次启动重新生成）。

## 插件本地接口（DSH ↔ 浏览器）

这些接口由插件在 DSH 的 `connection.fetch` 上注册，继承 DSH Web 的 owner 鉴权，
不属于设备 API，也不出现在自部署服务端上。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/session-cloudsync/status` | 整轮同步状态快照（含 `run.tasks`、`deviceLease`、`lastSuccess`） |
| `GET /api/session-cloudsync/session-status?id=` | 单会话只读规划视图（`SessionSyncView`：`sessionId`/`rootId`/`depth`/`action`/`reason`/`localLastSeq`/`remoteLastSeq`/`headChainHash`/`formatVersion`/`blocked`/`upload`/`live`/`tailOpen`）；复用同一份规划并缓存 2 秒（`packages/plugin/src/index.ts:1107-1126`）；缺 `id` 返回 `400` |
| `POST /api/session-cloudsync/sync` | 无 body 或 `{}` 时跑整轮；`{sessionId, direction:"push"\|"pull"}` 时只跑一个会话（推送需全局写租约，未持有时返回 `code:"lease-held"`；不在同步范围返回 `not-in-scope`；上一轮未结束返回 `already-running`、退避中返回 `backoff`） |
| `POST /api/session-cloudsync/session-scope` | `{sessionId, enabled, choice?}` 改上传白名单（等价于设置页 `syncSessionIds`）；工作区未绑定时返回 `{status:"needs-binding", key, path, candidates, willCreateNew}`，带 `choice:"create"` 或远端 `workspaceKey` 再调一次才写入；另可能返回 `done`/`unmapped`/`error` |
| `GET /api/session-cloudsync/events` | 状态 SSE；首帧全量快照，之后按状态版本合并 |
| `POST /api/session-cloudsync/cwd` | `{sessionId, action:"fix"\|"skip"}`：`fix` 在持全局租约时追加修正并推送（否则 `status:"lease-held"`），`skip` 直接按远端 cwd 挂载并清 pending |
| `POST /api/session-cloudsync/blocked` | `{sessionId, action:"ignore"\|"force"\|"restore", createdAt, formatVersion}`：分叉会话的人工决定，缺生命周期字段返回 `400` |
| `POST /api/session-cloudsync/replace` | 生成"远端覆盖本地"的停机脚本（只生成不执行） |
| `POST /api/session-cloudsync/workspaces/bind` | 一次性 `workspaceKey → localPath` 绑定 |
| `GET /api/session-cloudsync/workspaces` | 同步列表：工作区、会话计数、绑定与未映射远端工作区（`SyncWorkspaceList`） |
| `GET /api/session-cloudsync/config` | 设置页/首启共用的单一快照：`setup` + `status` + `workspaces` + `selection`（`schemaVersion: 2`） |
| `GET /api/session-cloudsync/setup` | 非敏感配置（服务端地址、设备名、白名单、自动同步开关、凭据来源），不回传 token/口令 |
| `GET /api/session-cloudsync/agreement` | 使用协议正文、sha256 与生效日期 |
| `GET /api/session-cloudsync/perf` | 进程内最近若干次性能采集快照 |
| `POST /api/session-cloudsync/test` | `{serverUrl}` 探活；不读配置、不带 token |

- 响应同样是 `{ok:true,value}` / `{ok:false,error}`；`session-status` 在会话不在同步范围时 `value` 缺省（只有 `{"ok":true}`）。
- 路由只经 `ctx.connection.fetch` 注册、继承 DSH Web 的 owner 鉴权，不额外发 token（`packages/plugin/src/host-api.ts:1-8,126-408`）。
