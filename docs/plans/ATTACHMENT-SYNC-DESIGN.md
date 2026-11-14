# 附件同步设计

> 状态：设计稿（2026-11-14）。附件同步涉及插件与服务端双端，先定协议，不进入实现。开工前已按 DSH 0.2.2-rc.1 复核 API，结论见 §15。

## 1. 目标

- 让图片/文件附件随会话跨设备同步；
- 服务端仍然**只能看到不透明密文和必要元数据**，不能读取附件内容；
- 拉取会话时，附件必须和事件一起可用，避免 DSH 读到缺失附件时报内部 `TRANSPORT` 错误；
- 提供一个“指定会话附件自检/修复”能力：扫描本地缺失，从服务器补齐。

## 2. 已定原则

1. **不做明文附件**：公益服/自部署都不能让服务端读附件；
2. **附件密钥会话派生**：从现有会话密钥经 HKDF 派生 attachment 子密钥；
3. **不追求跨会话去重**：生产数据里会话 blob 去重率为 0，附件几乎都是一次性截图，为去重牺牲密钥边界不值得；
4. **服务端不解析附件索引**：索引加密后作为不透明 blob 存储；
5. 本轮不处理 keybox。

## 3. keybox 背景（暂不实现）

原设计是：主密钥用自定义口令包裹后与会话数据一起上传，服务端可持有包裹后的密钥；
更换口令只需重新包裹，不必全量重加密会话。

当前代码没有实现 keybox，也没有服务端解密路径。附件同步不依赖 keybox：
附件密钥直接从会话密钥派生。keybox 以后单独设计，只需保证它能恢复同一主密钥，
从而派生出相同会话/附件密钥即可。

## 4. 数据模型

### 4.1 附件对象

DSH 本地附件是内容寻址对象（`<xx>` 是 digest 前两位）：

- 图片：`attachments/v1/objects/<xx>/<sha256>`，`attachmentId = sha256:<digest>`，digest 是归一化后字节的摘要；
- 文件：规范化对象在 `attachments/v1/file-objects/<xx>/<sha256>`，按文件名建立的只读硬链接在 `attachments/v1/files/<xx>/<sha256>/<name>`；`attachmentId = sha256:<digest>` 是原样字节的摘要；
- 文件引用里的 `name` 必须是净化后的叶子名（否则 `INVALID_ATTACHMENT_REF`），恢复时要沿用引用里的名字。

上传时附件正文先用会话派生的附件密钥加密，得到密文 blob。
服务端按密文内容寻址，因此远端 blob sha 不等于明文 `attachmentId`。

### 4.2 附件索引

每个 append 批次携带一个**加密附件索引**，内容类似：

```json
{
  "sessionId": "session-…",
  "entries": {
    "sha256:<attachmentId>": {
      "blobSha256": "<ciphertext sha256>",
      "bytes": 12345
    }
  }
}
```

- 索引用会话派生密钥加密；
- 服务端只存索引 blob，不解析 `entries`；
- 文件名、媒体类型、尺寸等元数据已经在加密事件里，索引只负责 `attachmentId → 密文地址`；
- 不存明文文件名，避免泄露。

### 4.3 批次关联

**不新增表、不加端点**：索引地址与附件密文清单作为批次条目的可选字段随 manifest 走。

```json
{
  "index": 1509,
  "attachmentIndexSha256": "<索引密文 blob sha256>",
  "attachmentBlobs": ["<附件密文 blob sha256>", "…"]
}
```

服务端校验：

- 对应 blob 已上传（索引 `kind=attachment-index`，附件 `kind=attachment`），否则整次 append `400`；
- 一个批次最多一个索引，附件清单 1–256 条且不重复；
- 不读取索引内容；只记密文地址，不记明文 `attachmentId`。

`/manifest` 与 `/batches` 天然带出这两个字段，修复场景直接读 manifest 即可，不需要
`/v2/sessions/:id/attachment-indexes`。**过渡说明**：0.2.0 计划把批次引用从 manifest
搬进帧表并做紧凑编码，届时这两个字段随批次一起落列，字段名保持不变。

实现细节、校验与测试清单见 `ATTACHMENT-SYNC-SERVER-API.md`。

## 5. 上传流程

1. 从待上传事件批次中收集附件引用（收集口径同 §7 第 2 步的载体清单）；
2. 读取本地附件对象；
3. 用会话派生的附件密钥加密；
4. 上传密文 blob（`kind=attachment`）；
5. 构造并加密附件索引，上传（`kind=attachment-index`）；
6. 最后 append 事件批次，并在该批次条目上带上 `attachmentIndexSha256` 与 `attachmentBlobs`。

顺序要求：**先附件、再索引、最后事件**。这样远端不会出现“事件引用了尚未上传的附件”。

失败语义：

- 附件上传失败 → 不 append；
- 索引上传失败 → 不 append；
- append 失败 → 附件/索引可能成为孤儿，后续靠 GC 清理；
- 重试使用同一密文和索引内容，避免重复对象。

## 6. 拉取流程

推荐 **A：apply 前把本批附件拉齐**，而不是 apply 后扫本地缺失。

```text
拉取批次
  → 取该批 attachmentIndex
  → 下载并解密索引
  → 对每个缺失 attachmentId：
      下载密文 → 解密 → 校验 → 按 §7 第 6 步的口径写入本地附件存储
  → 所有附件可用后 apply 事件
```

如果任何附件：

- 索引里没有；
- 远端 blob 不存在；
- 解密或 digest 校验失败；
- 本地写入失败；

则该批次/会话标为 `blocked`，提示“附件未同步完成”，不继续 apply。

原因：DSH 在读取事件时同步读取附件；缺文件会抛内部 transport 错误，事后很难区分是内容损坏还是附件未到。

apply 后可以再做一次本地引用扫描作为兜底，但**不能把“apply 后补附件”作为主流程**。

## 7. 指定会话附件自检/修复

插件提供本地接口：

```text
POST /api/session-cloudsync/attachments/repair
{ "sessionId": "session-…" }
```

返回：

```json
{
  "scanned": 12,
  "missing": 3,
  "downloaded": 3,
  "failed": []
}
```

流程：

1. 确保该会话事件已在本地；没有则先拉会话；
2. 从解密后的事件里收集引用，载体与 DSH 导出实现一致（对照 `packages/session-query/session-log-export/src/archive.ts`）：
   - `user/message`、`tool/ptc-dispatch`：`data.content`；
   - `system/message`、`developer/message`、`tool/result`、`team/message/queued`：`data.message.content`；
   - `agent/inbox/spliced`：`data.inserted[].content`；
   - `compaction/summary`：`data.summary` 与 `data.rawOutput`；
   - `assistant/message`：`data.message.content`，以及 `data.stream` 里 `block-end` 的 `block`；
   - `assistant/attempt` 刻意不收。
   图片按 `attachmentId` 去重，文件按 `(attachmentId, name)` 去重。
3. 检查本地对象是否存在：图片看 `attachments/v1/objects/<xx>/<sha256>`，文件看 `file-objects/<xx>/<sha256>`；需要确认完整性时再走 `readImage` / `readFileStream`；
4. 对缺失/损坏的附件，取该会话全部批次索引，解密合并成 map；
5. 下载、解密、校验；
6. 恢复：文件用 `saveFile`，`name` 必须用引用里已净化的名字；图片先 `saveImage`，再比对返回的 `attachmentId`，与引用不符即视为恢复失败（目的端归一化策略更严时会发生）；
7. 再扫一遍确认缺失归零。

失败项要区分：

- `no-index`：索引没有该 attachmentId；
- `blob-missing`：索引指向的密文不存在；
- `decrypt-failed`；
- `digest-mismatch`；
- `policy-mismatch`：目的端归一化策略比源端严，图片无法还原成同一 `attachmentId`；
- `local-write-failed`。

UI 放在会话详情或上传范围附近：「检查附件」「补齐缺失附件」。
第一版只做指定会话；之后可扩展为扫描全部同步范围。

## 8. 密钥

- 附件子密钥：`HKDF(sessionKey, "attachment")`；
- 图片/文件可以共用同一子密钥，密文 nonce 随机；
- 更换主密钥/口令时需要重新派生并重加密附件，或保留旧密钥代际；
- 因为不做跨会话去重，同一图片出现在两个会话会各存一份密文，这是接受的成本。

## 9. 大小与分片

当前服务端限制：

- 单 blob 32 MiB；
- 批量请求 8 MiB / 64 条；因此 8–32 MiB 的单附件必须走单 blob 接口，不能塞进批量请求。

第一版建议：

- 只支持单 blob 上限以内的附件；
- 超过上限的文件明确提示“附件过大，暂不支持”；
- 后续再设计分片格式（chunk index + blob 列表 + 总 digest）。

是否第一版就做分片，待定。

## 10. 生命周期

- 会话存档/移除/重置时，必须同时处理附件：
  - 存档保留；
  - 移除/重置按索引清理密文；
- 不做跨会话去重后，一个附件只属于一个会话，引用关系简单；
- 但同一会话内多个事件可能引用同一附件，按 `attachmentId` 去重；
- 索引 blob、附件 blob 和事件一样计入配额；
- 孤儿对象（上传成功但 append 失败）需要 GC。

## 11. 协议变更

已按最小改动实现（服务端 0.1.5）：

- `BlobKind` 增加 `attachment-index`（wire code 4；frame=1、attachment=2、vault=3 不变）；
- 批次条目（`SealedFrameRef`）增加可选的 `attachmentIndexSha256` 与 `attachmentBlobs`，
  append 与 manifest/batches 共用同一形状；
- 不新增端点、不改数据库结构（`SERVER_SCHEMA_VERSION` 保持 6）；
- `PROTOCOL_VERSION` 保持 3：新增字段全可选，旧客户端/旧服务端都不会误读；
- 功能以 `/health` 的 `attachment-index` capability 门控（旧服务端会拒绝该 kind）。

0.2.0 计划把批次引用从 manifest 搬进帧表并紧凑编码，这两个字段届时随批次落列，名字不变。

## 12. 测试

- 图片、文件各一条完整上传→另一设备拉取→本地可读；
- 同一附件被多条事件引用，只上传/下载一次；
- 缺索引、缺 blob、坏密文、digest 不符分别报明确错误，且不 apply；
- 修复接口能补齐指定会话的附件，重复调用幂等；
- 删除/移除会话后附件被清理，不影响其它会话；
- 大文件超过上限时返回明确错误；
- 索引本身被篡改或解密失败时阻止 apply。

## 13. 待定

1. 索引按 append 批次 vs 会话级：当前倾向批次级；
2. 第一版是否支持分片/大于 32 MiB 的文件；
3. 图片和文件是否共用同一附件子密钥；
4. keybox 与附件密钥轮换的关系（本轮不做，但未来要兼容）；
5. 是否需要服务端管理台展示附件数量/占用（当前只统计总字节）；
6. 图片恢复走 `saveImage` + 校验 `attachmentId`，还是直接按 digest 写 `objects/<xx>/<digest>`（后者字节精确，但依赖 DSH 内部布局）。

## 14. 实施顺序

1. 服务端：新增 blob kind、append 索引字段、批次/索引读取 API、清理逻辑；
2. 插件：附件加密、索引生成、上传队列；
3. 插件：拉取任务中加入“索引 → 附件 → apply”依赖；
4. 插件：指定会话自检/修复接口与 UI；
5. 测试与文档；
6. 再评估分片、GC 和 keybox。

## 15. 版本核实（DSH 0.2.2-rc.1，2026-11-14）

本稿最初按 0.2.1-rc.2 写。开工前用工作区源码复核：`deepseek-harness`，`dsh-v0.2.2-rc.1`，提交 `fcc0ad4621`。

### 15.1 未变

- `ctx.attachments` 的 `saveImage` / `readImage` / `saveFile` / `saveFileStream` / `readFileStream` / `imageHostPath` / `fileHostPath` / `imageLimits` 签名与语义一致；`readImage` 仍校验 digest、格式、字节数、宽高，读取失败仍是 `ATTACHMENT_NOT_FOUND` / `ATTACHMENT_CORRUPT`；
- 本地附件布局与 `attachmentId` 格式（路径前缀已在 §4.1 修正）；
- 会话格式仍是 v4（`SESSION_FORMAT_VERSION = 4`），`session-format` 包在 rc.2 → rc.1 只改了版本号；
- 事件里承载附件引用的字段集合没变：`session-log-export/src/archive.ts` 的 `collectEventAttachmentRefs` 在 rc.2 → rc.1 无 diff。

### 15.2 rc.1 新增但不影响本设计

- `AttachmentAdmissionPart` 增加“已存图片”`{ type: 'image', attachment, encodedBytes }`，配合浏览器分阶段上传的 `ImageUploadValue`；属上传准入路径，不改变持久引用；
- `llm` 的 `GenerateOptions.purpose` 改为可扩展映射、模型目录增加徽标字段，与附件无关；
- `core/tools` 拆成 pipeline/executor，`spill` 只有测试和类型导入改动；事件类型不受影响。

### 15.3 按 rc.1 落实的口径

1. 图片对象带两位 digest 前缀目录；文件另有 `file-objects` 规范化对象。
2. 图片恢复不能无条件 `saveImage`：它会按**目的端**归一化策略重算，只有 `canPassThroughNormalization` 成立才字节不变（默认策略下成立）；策略更严时得到不同 `attachmentId`。恢复后必须比对返回的 id，不符即 `policy-mismatch`，不 apply。
3. 文件恢复用引用里的 `name`（已净化）；返回 id 应等于引用 id，否则 `digest-mismatch`。
4. 收集引用照 DSH 自己的载体清单（§7 第 2 步），不做泛化递归扫描。
5. 图片 `bytes` 是归一化后长度（默认策略上限 4 MiB）；文件没有准入上限，服务端 32 MiB 限制实际主要卡文件。
