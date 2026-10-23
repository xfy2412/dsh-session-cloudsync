# 协议

> 状态：M2 服务端已实现 `/v1/health`、设备 token、`/v1/blobs`、租约、append、墓碑、cursor、manifest/批次引用读取；
> 管理台（cookie 会话 + 只读页面）已实现。M4 只保留 `batches` / `batchCount`，旧 `frames` / `frameCount` 已删除。
>
> 2026-10-22：租约已扩展为 `session:<id>` / `vault-writer:<writer>`，owner 增加
> `clientInstanceId`；Vault V1 的 append/cursor/stream 与 writer 租约已实现，见 [VAULT.md](VAULT.md)。
> 2026-10-23：会话租约升级为全局单写者 `sync` 租约；上传/创建/删除需要它，拉取不需要。
>
> **M3/M4 语义**：同步单位是**连续事件批次**；差异见文末「M3/M4 语义」。

## 认证

### 设备 API（`/v1/*`）

- `Authorization: Bearer <token>`。
- 两种角色：**setup token**（首次启动生成，管理设备）与**设备 token**（代表一台设备）。
- 设备身份以 token 派生的 `deviceId` 为准；`X-Device-Id` 若携带必须与 token 一致，否则拒绝（防止混淆）。

### 管理台（`/admin/*`）

- 首次启动通过 `/setup` 向导设置管理密码（服务端控制台打印 8 位初始化密钥，10 分钟有效、单次使用）；
- 之后浏览器用密码登录：`POST /admin/login { password }` → 服务端下发 **HttpOnly、SameSite=Strict** 会话 cookie；
- `POST /admin/logout` 注销；会话存在服务端内存，带过期时间；
- 管理台 API 不接受 bearer token，设备 API 不接受 cookie，两套认证互不复用。

### 初始化向导（`/setup/*`，仅未初始化时可用）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/setup` | 初始化向导页面 |
| GET | `/setup/state` | `{initialized, hasPassword, hasQuota, devices}` |
| POST | `/setup/verify` | `{code}` → 15 分钟 setup cookie；错误次数受限（10 次/10 分钟） |
| POST | `/setup/password` | 设置管理密码（≥6 位，字母/数字/特殊字符至少两类） |
| POST | `/setup/quota` | 设置配额（字节，16 MiB–1 TiB） |
| POST | `/setup/device` | 可选：创建第一台设备 |
| POST | `/setup/complete` | 完成初始化，升级为管理台会话 |

初始化完成后 `/setup` 跳转 `/admin`，向导接口返回 `409`。

## 设备端点

| 方法 | 路径 | 角色 | 作用 |
|---|---|---|---|
| GET | `/v1/health` | 公开 | 版本、协议号、当前时间 |
| POST | `/v1/devices` | setup | 签发设备 token（明文只返回一次） |
| GET | `/v1/devices` | setup | 列出未吊销设备 |
| DELETE | `/v1/devices/:id` | setup | 吊销设备 token |
| GET | `/v1/me` | 任意 | 当前 token 的角色 |
| POST | `/v1/blobs?kind=frame\|attachment\|vault` | 设备 | 上传密文；返回 `{sha256, bytes, dedup}`；同内容重复上传返回 200 + `dedup: true` |
| HEAD | `/v1/blobs/:sha256` | 设备 | 判断密文是否存在（上传去重） |
| GET | `/v1/blobs/:sha256` | 设备 | 下载密文 |
| GET | `/v1/cursor?since=<revision>` | 设备 | 自某 revision 以来的变更**摘要** |
| GET | `/v1/sessions/:id/manifest` | 设备 | 完整 manifest（大会话只在需要时拉） |
| GET | `/v1/sessions/:id/batches?from=<index>&limit=<n>` | 设备 | 批次引用分页（默认 500/页） |
| POST | `/v1/sync/lease` | 设备 | 申请/续租全局单写者租约（带 `X-Client-Id`） |
| DELETE | `/v1/sync/lease` | 设备 | 释放全局单写者租约 |
| POST | `/v1/sessions/:id/append` | 设备 | 提交新批次（需要全局租约） |
| POST | `/v1/sessions/:id/delete` | 设备 | 墓碑（绑定 `sessionId + createdAt + formatVersion`） |
| POST | `/v1/vault/lease` | 设备 | Vault writer 租约 |
| DELETE | `/v1/vault/lease` | 设备 | 释放 Vault writer 租约 |
| POST | `/v1/vault/append` | 设备 | 追加 Vault 记录索引 |
| GET | `/v1/vault/cursor?since=<revision>` | 设备 | Vault 记录 cursor |
| GET | `/v1/vault/stream/:writer?from=<seq>&limit=<n>` | 设备 | 某 writer 的 Vault 记录索引 |

### lease 与 append

- 租约 TTL **60 秒**；owner 为 `(deviceId, clientInstanceId)`，同一 owner 续租会顺延；
  其他 client 在过期前拿到 `409 lease-held`，过期后可抢占。
- **全局单写者租约资源为 `sync`**；Vault 租约资源为 `vault-writer:<writer>`。
- 所有 lease/append 请求带 `X-Client-Id`；append/create/delete 必须匹配全局租约 owner。
- `DELETE /v1/sync/lease` / `DELETE /v1/vault/lease` 主动释放；只允许当前 owner。
- 插件在进程存活期间持续续租（20s）形成设备独占；进程正常退出主动释放，异常退出靠 TTL。
- **拉取不需要租约**：manifest/cursor/blob/批次读取不加锁；没有全局租约时宿主跳过上传，只拉取。
- append 请求体只带**新增/替换的批次**，不重复整份 manifest：

```json
{
  "baseIndex": 9999,
  "baseChainHash": "…",
  "createdAt": 1790000000000,
  "formatVersion": 4,
  "batches": [ /* SealedBatchRef */ ]
}
```

- 唯一字段是 `batches`，服务端不再接受 `frames`；
- 首次创建用 `baseIndex: -1, baseChainHash: null`，`batches` 从 index 0 开始；
- 尾批替换用 `baseIndex = 倒数第二批`，`batches` 从该下标 +1 开始；
- 服务端把这些批次拼到存储的链上，校验连续性后整体替换 manifest；请求体上限 8 MiB。

### cursor 与批次引用分页

`GET /v1/cursor` 只返回摘要，**不返回整份 manifest**（万批会话的 manifest 约 1.2–1.6 MB）：

```json
{
  "revision": 42,
  "sessions": [{
    "sessionId": "session-…",
    "revision": 40,
    "formatVersion": 4,
    "createdAt": 1790000000000,
    "batchCount": 10000,
    "headChainHash": "…",
    "manifestDigest": "…",
    "updatedAt": 1790000000000,
    "deletedAt": null
  }],
  "tombstones": [{ "sessionId": "…", "createdAt": 1790000000000, "deletedAt": 1790000000000 }]
}
```

客户端先比 `batchCount + headChainHash`，一致就跳过；不一致再按页拉 `batches` 找公共前缀。响应里仍带 `frameCount` / `frames` 作为旧字段别名。

> Vault（设备台账 / 工作区映射 / 笔记）的 `/v1/vault/*` 已在 V1 实现，
> 设计见 [VAULT.md](VAULT.md)；记录封帧、cursor、writer 租约和配额以该文为准。

## 不变量

1. `append` 只接受**前缀延续**：`baseIndex` 必须是当前链的最后一个下标，且 `baseChainHash` 与该帧的明文哈希一致；否则 `409`。
2. 服务端**无法验证 `chainHash`**（没有明文），只校验 `blobSha256`（存储字节）与 `bytes`；链的完整性由客户端负责。
3. 墓碑优先于帧：已删会话的 `append` 返回 `410`；同一 `sessionId` 的新生命周期（`createdAt` 不同）不受旧墓碑影响。
4. 帧与 blob 不可变：同一 `blobSha256` 只存一份字节；尾帧被重写时由 `append` 替换，旧 blob 成为孤儿交给后续 GC。
5. `lastSeq` 单调；回退视为客户端缺陷。
6. 服务端不解析内容；只校验哈希、序号区间与大小。
7. 配额按唯一 blob 字节总和计算；超限返回 `507`。

## 管理台端点（`/admin/*`，已实现）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/admin` | 管理台单页（登录后使用） |
| POST | `/admin/login` | `{ password }` → HttpOnly、SameSite=Strict cookie |
| POST | `/admin/logout` | 注销当前会话 |
| GET | `/admin/overview` | 设备数、会话数、用量/配额、revision、版本 |
| POST | `/admin/quota` | `{ maxBytes }` 修改存储配额 |
| GET | `/admin/devices` | 设备列表（最后在线） |
| POST | `/admin/devices` | 签发设备 token（只返回一次） |
| DELETE | `/admin/devices/:id` | 吊销设备 token |
| GET | `/admin/sessions` | 会话元数据列表（id/代际/批次数/最后更新/墓碑） |

首版管理台不提供内容读取；会话预览（需要“允许服务器解密”）是 P2。根路径 `/` 会重定向到 `/admin`。

## M3/M4 语义（事件批次）

协议单位是**事件批次**；服务端只提供 `batches` / `batchCount` 规范字段：

- `SealedFrameRef` 的内部类型名仍保留（`index / seqFrom / seqTo / chainHash / blobSha256`），协议字段用 `SealedBatchRef`；
- `chainHash` = 批次内事件的**规范 JSON**（键序稳定）sha256，不再依赖物理帧字节；
- 分页路径是 `batches?from&limit`；`/frames` 已删除；
- append：`baseIndex + baseChainHash` 语义不变，提交的是“新增/替换的批次”；
- manifest 摘要只用 `batchCount`；header 元数据单独 sealed 上传（`formatVersion/createdAt/isSeeded/delegationDepth/agentPreset/inheritedEventCount`），`cwd` 不进 manifest；
- manifest 可带 opaque `workspaceKey`；根会话写入，子代理继承，拉取时按本机绑定解析落点，未映射不 apply；
- **已实现** `tailOpen: boolean` 与 `safeThroughSeq: number`：`tailOpen` 表示尾巴是否开放；`safeThroughSeq` 是最后一个闭合事件的 seq。读者只 apply `seqTo <= safeThroughSeq` 的批次，开放尾仅作备份，不写入本地可 resume 的会话；
- 客户端对齐：manifest 的 `[seqFrom, seqTo]` 为权威；本地已有完整前缀不下载；跨界批次下载后校验重叠段，只追加缺的后半段；
- 删除：协议不支持删除单个事件；已同步的脏内容用 fork + 墓碑。

## 错误码

`unauthorized` · `bad-request` · `not-found` · `conflict` · `diverged` · `lease-held` · `gone` · `quota` · `rate-limited`

HTTP 映射固定为：`401 · 400 · 404 · 409 · 409 · 409 · 410 · 507 · 429`（`packages/shared/src/wire.ts`）。

失败响应统一为 `{ "ok": false, "error": { "code": ..., "message": ... } }`。
