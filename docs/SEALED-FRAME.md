# 封帧格式（Sealed Frame）v1

> 状态：**v1 已实现**（`packages/shared/src/sealed-frame.ts`，`packages/shared/tests/sealed-frame.test.ts`）。
> 三个待定项已拍板：确定性 nonce、清单不带 cwd、keyId 每帧记录。
>
> M4 协议层把每个 sealed frame 视为一个**事件批次**（event batch）；对外字段只有
> `batches` / `batchCount`。格式名与内部类型名保留 "sealed frame" 历史，不改变密文字节布局。

## 1. 目标

- 端到端：服务端只见密文与元数据；
- 逐帧：任意一帧可独立解密，支持增量同步与随机访问；
- 确定性：同一明文帧在任意设备上封出**相同密文字节**，服务端按密文哈希去重；
- 可演进：封帧格式独立版本号，读端对未知版本 fail-closed；
- 可轮换：口令更换后旧帧仍可读（keyId/keyring）。

## 2. 密钥层次

```text
口令
  └─ scrypt(passphrase, salt, N=2^15, r=8, p=1)        → masterKey(32B)
      └─ HKDF-SHA256(masterKey, "dsh-sync/session/"+sessionId)  → sessionKey(32B)
          └─ HKDF-SHA256(sessionKey, "dsh-sync/frame/v1"+chainHash) → frameKey(32B)
```

- `chainHash = sha256(明文帧字节)`；
- `frameKey` 每帧唯一 ⇒ **nonce 固定为 0**（v1），安全性由"每帧唯一密钥"保证；
- 确定性加密的代价：相同明文帧产生相同密文（可接受：链哈希本来就用于公开比对）。

## 3. 线上字节布局

```text
偏移  长度  字段
0     4     magic = "DSHF"
4     1     sealedVersion = 1
5     1     flags（bit0 保留：服务器可解密）
6     8     keyId = HKDF(sessionKey, "dsh-sync/key-id")[:8]
14    12    nonce（v1 全 0，保留给后续版本）
26    N     密文 = AES-256-GCM(frameKey, nonce, 明文帧, AAD) + 16B tag
```

- 明文 = 从日志里原样切出的 zstd 帧字节，**不解码、不重编码**；
- `blobSha256 = sha256(整个封帧字节)`，用于服务端寻址 / 去重 / HEAD 探测。

## 4. AAD

AAD 用固定字段序的二进制拼接（长度前缀字符串 + 大端整数），避免 JSON 键序问题：

```text
magic | sealedVersion | flags | keyId | nonce
sessionIdLen | sessionId
frameIndex(u64) | seqFrom(u32) | seqTo(u32)
chainHash(32B)
```

作用：把密文绑定到"哪个会话、第几帧、覆盖哪段序号、明文是什么"。换会话、重排、截断都会解密失败。

## 5. 清单条目

```json
{
  "index": 0,
  "chainHash": "<hex>",
  "blobSha256": "<hex>",
  "bytes": 1234,
  "sealedVersion": 1,
  "keyId": "<hex8>",
  "seqFrom": 0,
  "seqTo": 0
}
```

会话 manifest 另含：`sessionId`、`sessionFormatVersion`、`createdAt`、`lastSeq`、`frames[]`、`deletedAt?`。

**服务端无法验证 `chainHash`**（它没有明文），只校验 `blobSha256` 与字节数；链的完整性由客户端负责。

## 6. 版本与轮换

- `sealedVersion` 独立于 DSH 会话格式版本（v4）与协议版本（`PROTOCOL_VERSION`）；
- 读端遇到未知 `sealedVersion` **拒绝**，不猜；
- 新字段不改 AAD；破坏性改动递增版本并写新布局；
- 口令轮换：生成新 `keyId` 的新帧；客户端保留 keyring，旧帧按 `keyId` 选旧密钥；
- "允许服务端解密"（二期）：`flags.bit0 + keybox`，keybox 用服务端公钥封装 masterKey；v1 不实现。

## 7. 与帧链的关系

- 链比较只用 `chainHash`：逐帧比明文哈希，公共前缀之后的帧才需要传输；
- 服务端只看到 `blobSha256`：上传去重、HEAD 探测、按内容寻址；
- 尾帧可能被 DSH 崩溃恢复重写 ⇒ 同一 `index` 的新 `chainHash` 需要替换旧条目：
  `append` 请求携带 `baseIndex + baseChainHash + 新帧列表`，服务端仅在基座匹配时替换尾帧；
  旧 blob 成为孤儿，交给后续 GC。

## 8. 已定决策

1. **确定性 nonce**：每帧唯一派生密钥 + 零 nonce；同一明文帧在任何设备上密文相同，服务端可跨设备去重。
2. **清单不带 cwd**：manifest 只带 `sessionFormatVersion`、`createdAt`、`lastSeq`、`frames[]`；`cwd` 由客户端解密 header 帧后取得，减少路径泄露。
3. **keyId 每帧记录**：每帧多 8 字节；口令轮换后旧帧无需重加密，客户端按 keyId 选旧密钥。

## 9. 实现与验证

- `sealFrame / openSealedFrame / parseSealedHeader / sessionKeyOf / frameKeyOf / keyIdOf` 已实现；
- 单测覆盖：覆盖夹具全部 134 帧往返、确定性密文、清单字段、换密钥必败、改一字节必败、AAD 坐标（下标/seq/会话/哈希）不一致必败、未知版本拒绝、scrypt 盐一致性与会话密钥派生；
- 真实会话验证：125 帧全部往返一致，原始 160,550 字节 → 封帧后 165,800 字节（每帧固定开销 42 字节：26 头 + 16 tag）。
