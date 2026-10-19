# 协议

> 状态：端点草案。已实现：`/v1/health`、设备 token 管理。会话/帧端点随同步引擎落地。

## 认证

- `Authorization: Bearer <token>`。
- 两种角色：**setup token**（首次启动生成，管理设备）与**设备 token**（代表一台设备）。
- 设备请求另带 `X-Device-Id`，用于租约与台账；`deviceId` 由插件生成并保存在本体状态文件里。

## 端点

| 方法 | 路径 | 角色 | 作用 |
|---|---|---|---|
| GET | `/v1/health` | 公开 | 版本、协议号、当前时间 |
| POST | `/v1/devices` | setup | 签发设备 token（明文只返回一次） |
| GET | `/v1/devices` | setup | 列出未吊销设备 |
| DELETE | `/v1/devices/:id` | setup | 吊销设备 token |
| GET | `/v1/me` | 任意 | 当前 token 的角色 |

以下为同步引擎需要的端点草案（未实现）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/v1/cursor?since=<n>` | 自游标以来的变更：会话元数据、墓碑、缺失帧、台账版本 |
| HEAD | `/v1/blobs/:sha256` | 判断密文是否已存在（上传去重） |
| GET | `/v1/blobs/:sha256` | 下载密文 |
| POST | `/v1/blobs` | 上传密文 |
| POST | `/v1/sessions/:id/lease` | 申请/续租会话租约 |
| POST | `/v1/sessions/:id/append` | 提交新帧（携带 `baseIndex + baseChainHash` 与封帧条目） |
| POST | `/v1/sessions/:id/delete` | 墓碑（软删，绑定 `sessionId + createdAt + formatVersion`） |
| PUT | `/v1/manifest` | 提交工作区归属（带 `if-version` 乐观并发） |

## 不变量

1. `append` 只接受**前缀延续**：`baseIndex` 必须是当前链的最后一个下标，且 `baseChainHash` 与该帧的明文哈希一致；否则 `409`。
2. 服务端**无法验证 `chainHash`**（没有明文），只校验 `blobSha256`（存储字节）与 `bytes`；链的完整性由客户端负责。
3. 墓碑优先于帧：已删会话的 `append` 返回 `410`；同一 `sessionId` 的新生命周期（`createdAt` 不同）不受旧墓碑影响。
4. 帧与 blob 不可变：同一 `blobSha256` 只存一份字节；尾帧被重写时由 `append` 替换，旧 blob 成为孤儿交给后续 GC。
5. `lastSeq` 单调；回退视为客户端缺陷。
6. 服务端不解析内容；只校验哈希、序号区间与大小。

## 错误码

`unauthorized` · `bad-request` · `not-found` · `conflict` · `diverged` · `lease-held` · `gone` · `quota`

失败响应统一为 `{ "ok": false, "error": { "code": ..., "message": ... } }`。
