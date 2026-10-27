# 封帧格式（Sealed Frame）v1/v2

> 状态：v1（未压缩）与 v2（zstd 压缩）均已实现于
> `packages/shared/src/sealed-frame.ts`；服务端只存密文，不参与压缩或解压。
>
> 同步层把每个 sealed frame 视为一个**事件批次**（event batch）；对外字段只有
> `batches` / `batchCount`。

## 1. 目标

- 端到端：服务端只见密文与元数据；
- 逐帧：任意一帧可独立解密，支持增量同步与随机访问；
- 可演进：封帧版本独立于 DSH 会话格式与 API 代际；
- 可轮换：口令更换后旧帧仍可读（keyId/keyring）；
- v2 在加密前压缩明文，降低传输与存储字节；
- 旧未压缩帧和新压缩帧可以同时存在于一条会话链中。

## 2. 明文是什么

同步层传入 `sealFrame` 的明文是：

```text
serializeEventBatch(events) 的规范 JSON
```

不是 DSH 日志文件里的原始 zstd 帧。物理帧边界、压缩参数属于 DSH 存储实现，
不是同步契约；`v1` 文档早期“原样切 zstd 帧”的描述已被实现修正。

`chainHash` 始终是这段**未压缩规范 JSON** 的 sha256。

## 3. 密钥层次

```text
口令
  └─ scrypt(passphrase, salt, N=2^15, r=8, p=1)        → masterKey(32B)
      └─ HKDF-SHA256(masterKey, "v1|session:"+sessionId) → sessionKey(32B)
          ├─ v1: HKDF(sessionKey, "v1|frame:"+chainHash) → frameKey(32B)
          └─ v2: HKDF(sessionKey, "v2|frame:zstd:"+compressedHash+":"+chainHash)
                                                            → frameKey(32B)
```

- `keyId = HKDF(sessionKey, "v1|key-id")[:8]`，每帧记录；
- nonce 固定为 0；安全性依赖每帧唯一密钥；
- v2 的帧密钥绑定 `compressedHash`，所以即使同一明文在不同环境压缩出不同字节，
  也不会复用 key + nonce。

## 4. 线上字节布局

v1 与 v2 共用相同的 26 字节固定头：

```text
偏移  长度  字段
0     4     magic = "DSHF"
4     1     sealedVersion（1=未压缩，2=zstd）
5     1     flags（保留）
6     8     keyId
14    12    nonce（全 0）
26    N     密文 = AES-256-GCM(payload, AAD) + 16B tag
```

- v1 的 `payload` 是未压缩规范 JSON；
- v2 的 `payload` 是先做 zstd、再 AES-GCM 的密文；
- `blobSha256 = sha256(整个封帧字节)`，用于寻址、去重和 HEAD；
- 单帧固定开销仍为 26 字节头 + 16 字节 tag；压缩收益来自 payload。

## 5. AAD

AAD 沿用固定字段序：

```text
magic | sealedVersion | flags | keyId | nonce
sessionIdLen | sessionId
frameIndex(u64) | seqFrom(u32) | seqTo(u32)
chainHash(32B)
```

`sealedVersion` 因此绑定压缩/未压缩语义；换版本、换会话、重排、截断都会认证失败。

## 6. 清单条目

v1：

```json
{
  "index": 0,
  "chainHash": "<未压缩明文 sha256>",
  "blobSha256": "<密文 sha256>",
  "bytes": 1234,
  "sealedVersion": 1,
  "keyId": "<hex8>",
  "seqFrom": 0,
  "seqTo": 0
}
```

v2 额外带：

```json
{
  "sealedVersion": 2,
  "compression": "zstd",
  "compressedHash": "<压缩后明文 sha256>"
}
```

`manifestDigest` 只在 v2 条目上纳入 `compression` / `compressedHash`，因此旧 v1
manifest 的摘要与之前保持一致。

服务端无法验证 `chainHash` 或 `compressedHash` 是否对应真实明文；它只校验字段形状、
`blobSha256`、字节数与 blob 是否存在。完整性由客户端在打开封帧时验证。

## 7. 压缩与去重

- zstd 是可选的：不传时仍生成 v1 未压缩帧；
- v2 的压缩发生在加密前，服务端无法也不应尝试压缩密文；
- 相同明文在同一 zstd 实现/参数下可得到相同密文，从而继续跨设备去重；
- 若不同 Node/zstd 版本产生不同压缩结果，`compressedHash` 不同，密文也不同；
  这只会降低去重率，不会导致 key 复用；
- 旧客户端只能读 v1；v2 帧需要新客户端。

## 8. 版本与兼容

- `PROTOCOL_VERSION = 3`；设备 API 为 `/v2/*`；
- 新服务端/新客户端支持 v1 + v2 封帧；
- 旧客户端读 v2 帧会得到“不支持的封帧版本”或认证失败；
- 服务端允许一条链混有 v1 和 v2 条目，压缩状态以 `none/zstd/mixed` 聚合；
- 已有未压缩会话不会自动重压缩；要迁移需清空远端后全量重传。

## 9. 已实现与验证

- `sealFrame` / `openSealedFrame` / `parseSealedHeader`；
- `frameKeyOf` 支持 v1 与 v2 两种派生；
- 单测覆盖：v1 覆盖夹具全部往返、确定性密文、AAD 坐标、keyId、未知版本；
  v2 zstd 往返、压缩哈希、缺少元数据拒绝、篡改拒绝；
- 服务端测试覆盖：zstd 帧 append、manifest 保留压缩元数据、聚合状态。
