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
| HEAD | `/v1/blobs/:sha256` | 判断内容是否已存在（上传去重） |
| GET | `/v1/blobs/:sha256` | 下载内容 |
| POST | `/v1/blobs` | 上传内容（密文） |
| POST | `/v1/sessions/:id/lease` | 申请/续租会话租约 |
| POST | `/v1/sessions/:id/append` | 提交新帧（携带 `baseLastSeq` 与帧哈希列表） |
| POST | `/v1/sessions/:id/delete` | 墓碑（软删） |
| PUT | `/v1/manifest` | 提交工作区归属（带 `if-version` 乐观并发） |

## 不变量

1. `append` 只接受**前缀延续**：`baseLastSeq` 必须是当前链的末端，否则 `409`。
2. 墓碑优先于帧：已删会话的 `append` 返回 `410`。
3. 帧与 blob 不可变：同一 `sha256` 只存一份字节。
4. `lastSeq` 单调；回退视为客户端缺陷。
5. 服务端不解析内容；只校验 `sha256`、序号区间与大小。

## 错误码

`unauthorized` · `bad-request` · `not-found` · `conflict` · `diverged` · `lease-held` · `gone` · `quota`

失败响应统一为 `{ "ok": false, "error": { "code": ..., "message": ... } }`。
