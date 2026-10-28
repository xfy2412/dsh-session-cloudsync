# 协议（v2-only）

> 状态：服务端 **0.1.0** 已实现 v2-only；插件 0.1.0 已迁移 v2 路径、changes cursor、
> 幂等 append、批量 blob 与 zstd 写入，发布待收口。
> `PROTOCOL_VERSION = 3`，设备 API 只有 `/v2/*`，旧的 `/v1/*` 已全部移除。
> 旧插件请求任何 `/v1/*` 都会得到 404；这是 0.1.0 的破坏性变更。
>
> 管理台（`/admin/*`）和初始化向导（`/setup/*`）不属于设备 API，仍然保留。

## 认证

### 设备 API（`/v2/*`）

- `Authorization: Bearer <token>`。
- 两种角色：**setup token**（初始化阶段管理设备）与**设备 token**（代表一台设备）。
- 设备身份以 token 对应的 `deviceId` 为准；`X-Device-Id` 若携带必须与 token 一致。
- 写路径还需要 `X-Client-Id`（16–64 位小写十六进制），用于租约 owner 和冲突检测。

### 管理台（`/admin/*`）

- 首次启动通过 `/setup` 向导设置管理密码；服务端控制台打印一次性初始化密钥。
- 之后浏览器用密码登录：`POST /admin/login { password }` → HttpOnly、SameSite=Strict cookie。
- 管理台不接受 bearer token，设备 API 不接受 cookie，两套认证互不复用。

## 健康与能力

```http
GET /health
```

这是未版本化端点，返回：

```json
{
  "ok": true,
  "server": {
    "version": "0.1.0",
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

## 设备端点

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v2/devices` | setup token 签发设备 token（明文只返回一次） |
| GET | `/v2/devices` | setup token 列出未吊销设备 |
| DELETE | `/v2/devices/:id` | setup token 吊销设备 |
| GET | `/v2/me` | 当前 token 的角色与设备信息 |
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
| POST | `/v2/sessions/:id/delete` | 会话墓碑 |
| POST/DELETE | `/v2/vault/lease` | Vault writer 租约 |
| POST | `/v2/vault/append` | 追加 Vault 记录索引 |
| GET | `/v2/vault/cursor` | Vault 记录 cursor |
| GET | `/v2/vault/stream/:writer` | 某 writer 的 Vault 记录索引 |

## 会话快照与变更流

### 全量快照

```http
GET /v2/sessions?cursor=<opaque>&limit=200
```

返回未删除会话：

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
    "updatedAt": 1790000000000,
    "deletedAt": null,
    "compression": "zstd",
    "storedBytes": 56101098
  }],
  "nextCursor": "opaque-or-null"
}
```

- `cursor` 是不透明字符串；第一页不传，最后一页 `nextCursor` 为 `null`。
- 快照按 `sessionId` keyset 分页，不再用全局 revision 当页游标。
- `compression`：`none` / `zstd` / `mixed`。
- `storedBytes`：本会话所有封帧的密文字节总和。

### 变更流

```http
GET /v2/changes?cursor=<opaque>&limit=200
```

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

返回摘要，且带 `ETag: "<manifestDigest>"`；摘要内容与快照条目一致，包括
`compression` / `storedBytes`。命中 `If-None-Match` 返回 `304`。

### manifest 与批次

```http
GET /v2/sessions/:id/manifest
GET /v2/sessions/:id/batches?from=<index>&limit=<n>&expectedManifestDigest=<digest>
```

- manifest 包含完整 `batches`（协议字段不再用 `frames`）。
- `batches` 响应包含 `manifestDigest`、`revision`、`batchCount` 与去重后的 `batches`。
- 若传入 `expectedManifestDigest` 且与当前 manifest 不符，返回 `409 conflict`，不要拼接不同 revision 的页。

## 租约与 append

- 租约 TTL **60 秒**；owner 为 `(deviceId, clientInstanceId)`。
- 全局单写者资源为 `sync`；Vault 使用 `vault-writer:<writer>`。
- 拉取（manifest/summary/changes/batches/blob 读取）不需要租约。
- append 请求体只带新增/替换的批次：

```json
{
  "baseIndex": 9999,
  "baseChainHash": "…",
  "createdAt": 1790000000000,
  "formatVersion": 4,
  "workspaceKey": "…",
  "tailOpen": false,
  "safeThroughSeq": 69586,
  "batches": [ /* SealedFrameRef */ ]
}
```

- 首次创建：`baseIndex=-1, baseChainHash=null`，批次从 index 0 开始。
- 尾批替换：`baseIndex = 倒数第二批`，新批次从该下标 +1 开始。
- 服务端校验链的前缀延续，不解析明文；请求体上限 8 MiB。
- append 必须带：

```http
Idempotency-Key: <clientId:sessionId:groupIndex>
```

- 同一个 key + 同一请求内容：返回第一次成功的摘要，**不要求租约仍有效**；
- 同一个 key + 不同内容：返回 `409 conflict`；
- 幂等记录按 `deviceId + sessionId + key` 隔离；
- append / delete 返回的摘要也带 `compression` 与 `storedBytes`，插件可立即更新 UI。

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
- 上限：整个请求 **8 MiB**，最多 **64 条**；
- 上传条目的 `sha256` 是客户端声明的期望值，服务端必须重算并校验；
- 响应按请求顺序返回 `{sha256, bytes, dedup}`；
- 重复内容返回 `dedup: true`，配额只计算新 blob；
- 单 blob 超过 8 MiB 时走 `/v2/blobs` 单条接口。

### 下载

```http
POST /v2/blobs/batch/read
Content-Type: application/json

{ "sha256": ["…", "…"] }
```

响应同样是 `application/x-dsh-blob-batch`。任一 hash 缺失时，在发送二进制响应前
返回 JSON `404`。下载按请求顺序返回；客户端应校验每个条目的内容哈希。

## Vault

Vault 的设备台账、工作区 profile 与笔记使用 `/v2/vault/*`；blob 上传/下载复用
`/v2/blobs` 或 `/v2/blobs/batch*`，`kind=vault`。记录格式、writer 租约与 cursor
语义见 [VAULT.md](../sync/VAULT.md)。

## 数据库与兼容

- SQLite `user_version = 4`。
- v3 → v4：新增 `append_requests`、`sessions.compression`、`sessions.stored_bytes`；
  迁移前生成 `db.sqlite.bak-v3-*` 备份，不删除会话/墓碑/设备/Vault。
- v2 → v4 也保留会话/墓碑等数据；旧租约视为瞬时状态重建。
- 服务端不保存明文；没有 rewrite/重压缩接口。
- 0.0.1 的数据库可以原地迁移，但 **0.0.x 插件不能继续用**：它只请求 `/v1/*`，
  会得到 404。升级服务端必须同时升级到插件 0.1.0。
- 若从 0.1.0 降级到 0.0.1，旧服务端会拒绝 schema 4；需恢复迁移前备份。

## 不变量

1. append 只接受前缀延续；`baseIndex + baseChainHash` 不匹配返回 `409 diverged`。
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

失败响应统一为：

```json
{ "ok": false, "error": { "code": "…", "message": "…" } }
```

## 管理台端点

`/admin`、`/admin/login`、`/admin/logout`、`/admin/overview`、`/admin/quota`、
`/admin/devices`、`/admin/sessions` 保持不变；管理台不接受设备 bearer token。
