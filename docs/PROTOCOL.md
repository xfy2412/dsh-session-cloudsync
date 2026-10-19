# 协议

> 状态：M2 服务端已实现 `/v1/health`、设备 token、`/v1/blobs`、租约、append、墓碑、cursor、manifest/帧引用读取。
> 管理台 API 见文末（未实现）。

## 认证

### 设备 API（`/v1/*`）

- `Authorization: Bearer <token>`。
- 两种角色：**setup token**（首次启动生成，管理设备）与**设备 token**（代表一台设备）。
- 设备身份以 token 派生的 `deviceId` 为准；`X-Device-Id` 若携带必须与 token 一致，否则拒绝（防止混淆）。

### 管理台（`/admin/*`）

- 浏览器用 setup token 登录：`POST /admin/login { setupToken }` → 服务端下发 **HttpOnly、SameSite=Strict** 的会话 cookie；
- `POST /admin/logout` 注销；会话只存在内存/服务端表，带过期时间；
- 管理台 API 不接受 bearer token，设备 API 不接受 cookie，两套认证互不复用。

## 设备端点

| 方法 | 路径 | 角色 | 作用 |
|---|---|---|---|
| GET | `/v1/health` | 公开 | 版本、协议号、当前时间 |
| POST | `/v1/devices` | setup | 签发设备 token（明文只返回一次） |
| GET | `/v1/devices` | setup | 列出未吊销设备 |
| DELETE | `/v1/devices/:id` | setup | 吊销设备 token |
| GET | `/v1/me` | 任意 | 当前 token 的角色 |
| POST | `/v1/blobs?kind=frame\|attachment` | 设备 | 上传密文；返回 `{sha256, bytes, dedup}`；同内容重复上传返回 200 + `dedup: true` |
| HEAD | `/v1/blobs/:sha256` | 设备 | 判断密文是否存在（上传去重） |
| GET | `/v1/blobs/:sha256` | 设备 | 下载密文 |
| GET | `/v1/cursor?since=<revision>` | 设备 | 自某 revision 以来的变更**摘要** |
| GET | `/v1/sessions/:id/manifest` | 设备 | 完整 manifest（大会话只在需要时拉） |
| GET | `/v1/sessions/:id/frames?from=<index>&limit=<n>` | 设备 | 帧引用分页（默认 500/页） |
| POST | `/v1/sessions/:id/lease` | 设备 | 申请/续租租约 |
| POST | `/v1/sessions/:id/append` | 设备 | 提交新帧（`baseIndex + baseChainHash` + 封帧条目） |
| POST | `/v1/sessions/:id/delete` | 设备 | 墓碑（绑定 `sessionId + createdAt + formatVersion`） |

### lease 与 append

- 租约 TTL **60 秒**；同一设备续租会顺延，其他设备在过期前拿到 `409 lease-held`，过期后可抢占。
- `DELETE /v1/sessions/:id/lease` 主动释放。
- append 请求体只带**新增/替换的帧**，不重复整份 manifest：

```json
{
  "baseIndex": 9999,
  "baseChainHash": "…",
  "createdAt": 1790000000000,
  "formatVersion": 4,
  "frames": [ /* SealedFrameRef */ ]
}
```

- 首次创建用 `baseIndex: -1, baseChainHash: null`，`frames` 从 index 0 开始；
- 尾帧替换用 `baseIndex = 倒数第二帧`，`frames` 从该下标 +1 开始；
- 服务端把这些帧拼到存储的链上，校验连续性后整体替换 manifest；请求体上限 8 MiB。

### cursor 与帧引用分页

`GET /v1/cursor` 只返回摘要，**不返回整份 manifest**（万帧会话的 manifest 约 1.2–1.6 MB）：

```json
{
  "revision": 42,
  "sessions": [{
    "sessionId": "session-…",
    "revision": 40,
    "formatVersion": 4,
    "createdAt": 1790000000000,
    "frameCount": 10000,
    "headChainHash": "…",
    "manifestDigest": "…",
    "updatedAt": 1790000000000,
    "deletedAt": null
  }],
  "tombstones": [{ "sessionId": "…", "createdAt": 1790000000000, "deletedAt": 1790000000000 }]
}
```

客户端先比 `frameCount + headChainHash`，一致就跳过；不一致再按页拉 `frames` 找公共前缀。

## 不变量

1. `append` 只接受**前缀延续**：`baseIndex` 必须是当前链的最后一个下标，且 `baseChainHash` 与该帧的明文哈希一致；否则 `409`。
2. 服务端**无法验证 `chainHash`**（没有明文），只校验 `blobSha256`（存储字节）与 `bytes`；链的完整性由客户端负责。
3. 墓碑优先于帧：已删会话的 `append` 返回 `410`；同一 `sessionId` 的新生命周期（`createdAt` 不同）不受旧墓碑影响。
4. 帧与 blob 不可变：同一 `blobSha256` 只存一份字节；尾帧被重写时由 `append` 替换，旧 blob 成为孤儿交给后续 GC。
5. `lastSeq` 单调；回退视为客户端缺陷。
6. 服务端不解析内容；只校验哈希、序号区间与大小。
7. 配额按唯一 blob 字节总和计算；超限返回 `507`。

## 管理台端点（`/admin/*`）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/admin/login` | `{ setupToken }` → 会话 cookie |
| POST | `/admin/logout` | 注销当前会话 |
| GET | `/admin/overview` | 设备数、会话数、用量/配额、revision |
| GET | `/admin/devices` | 设备列表（最后在线、用量） |
| POST | `/admin/devices` | 签发设备 token |
| DELETE | `/admin/devices/:id` | 吊销设备 token |
| GET | `/admin/sessions` | 会话元数据列表（id/代际/帧数/最后更新/租约/墓碑） |

首版管理台不提供内容读取；会话预览（需要“允许服务器解密”）是 P2。

## 错误码

`unauthorized` · `bad-request` · `not-found` · `conflict` · `diverged` · `lease-held` · `gone` · `quota`

HTTP 映射固定为：`401 · 400 · 404 · 409 · 409 · 409 · 410 · 507`（`packages/shared/src/wire.ts`）。

失败响应统一为 `{ "ok": false, "error": { "code": ..., "message": ... } }`。
