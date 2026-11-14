# 附件同步：服务端 API 改动

> 状态：**已实现，待发布**（2026-11-14，目标版本服务端 0.1.5）。只列服务端与共享协议的改动；
> 加密与插件侧流程见 `ATTACHMENT-SYNC-DESIGN.md`。本轮只改服务端，不改插件行为。
> 实施记录见 §11。

## 1. 结论

- 附件密文和附件索引密文都走现有 blob 通道，只新增一个 blob kind；
- 索引按**批次（封帧）**绑定，写在 `SealedFrameRef` 上；不新增端点，不改数据库 schema；
- 不升 `PROTOCOL_VERSION`，用 `/health` 的 capability 做功能门控；
- 服务端要清理「某个会话的附件」，就必须知道哪些密文属于该会话，因此 append 额外带一份**密文 sha 清单**（只带密文 sha，不带明文 `attachmentId`）。

## 2. 数据流（服务端视角）

```text
POST /v2/blobs?kind=attachment          （每个附件密文一次，可批量）
POST /v2/blobs?kind=attachment-index    （每个批次一份索引密文）
POST /v2/sessions/:id/append            （batch ref 里带索引 sha + 附件密文 sha 清单）
GET  /v2/sessions/:id/manifest|batches  （读回同样的引用）
GET  /v2/blobs/:sha256                  （拉密文）
```

服务端始终不解析索引内容，只做「blob 存在 + kind 匹配」的校验。

## 3. 协议改动

### 3.1 新 blob kind：`attachment-index`

| 位置 | 当前 | 改动 |
| --- | --- | --- |
| `packages/shared/src/blob-batch.ts` `BlobKind` | `frame \| attachment \| vault` | 增加 `attachment-index`，wire code `3` |
| `POST /v2/blobs?kind=` 白名单（http.ts） | frame/attachment/vault | 增加 `attachment-index` |
| `POST /v2/blobs/batch` 条目 kind | 同上 | 同上（`KIND_TO_CODE` / `CODE_TO_KIND` 成对增加） |
| `POST /v2/blobs/batch/read` 允许的 kind | frame/attachment/vault | 增加 `attachment-index` |
| 单条 `GET/HEAD /v2/blobs/:sha256` | 任意已登记 blob | 不变 |

### 3.2 `SealedFrameRef` 增加两个可选字段

```ts
/** 该批次附件索引密文的 sha256（小写十六进制）；无附件时省略。 */
readonly attachmentIndexSha256?: string
/** 该批次引用的附件密文 sha256 列表（去重，最多 256 条）；无附件时省略。 */
readonly attachmentBlobs?: readonly string[]
```

理由：

- manifest 是服务端唯一事实源，`/manifest`、`/batches`、`/summary` 不需要改结构；
- 修复场景不需要新端点，插件读 manifest 就能拿到该会话全部索引；
- 尾帧替换（append 时 `baseIndex+1 == 链长-1`）随 ref 一起替换，语义自然；
- 只放密文 sha，服务端看到的归属关系与现在的「帧 blob 属于哪个会话」同一级别。

### 3.3 append 校验

`assertRef` 校验形状、`appendFrames` 校验 blob 是否存在与类别（`parseAppend` 只做类型转换）：

- 两个字段都可选；出现时：`attachmentIndexSha256` 必须是 64 位小写十六进制；`attachmentBlobs` 必须是 1–256 条、元素都是 64 位小写十六进制的数组，且数组内不重复；
- 索引 blob 必须已上传，且 `blobs.kind = 'attachment-index'`；
- 每个附件 blob 必须已上传，且 `blobs.kind = 'attachment'`；
- 任何一个不满足 → `bad-request`（沿用「帧 X 的 blob 尚未上传」的既有语义），整个 append 不落库；
- 索引内容不解析、不校验、不计数。

幂等：`appendRequestHash` 已经覆盖 `frames`，新字段自动进入哈希，无需额外改动。

### 3.4 能力与版本

- `/health` 的 `capabilities` 增加 `attachment-index`；
- `PROTOCOL_VERSION` 保持 `3`：新增字段都是可选的，旧客户端/旧服务端都不会误读；
- 插件必须按 capability 门控附件功能：旧服务端（0.1.4）会把 `kind=attachment-index` 判为 400，不能靠试错。

## 4. 生命周期

| 动作 | 行为 |
| --- | --- |
| 存档（archive） | 保留全部附件 |
| 移除（remove）/ 重置（reset） | purge 时把 `attachmentIndexSha256`、`attachmentBlobs` 与帧 `blobSha256` 合并清理；被其它会话或 Vault 引用的 blob 保留（沿用现有引用检查） |
| 设备删除（delete） | 仍然只打墓碑，不清理（与帧一致） |
| 尾帧替换 | 被替换批次的旧附件密文成为孤儿，等 GC（本轮不做） |
| manifest 损坏 | 保守处理：不据此删除任何 blob（沿用现有策略） |

`purgeSessionBlobs` 从 `manifest.frames` 收集三个来源的 sha，重复的合并，其余逻辑不变。

## 5. 配额与管理台

- 配额自动生效：`blobs` 表与 `usedBlobBytes` 已经覆盖附件密文，单 blob 32 MiB 上限同样适用；
- 批量上传仍受 8 MiB / 64 条限制 → 8–32 MiB 的单附件只能走单条接口；
- 管理台会话 `storedBytes` 仍只统计封帧字节；附件占用体现在总占用里，分项展示待定（不动 schema）；
- remove/reset 的历史事件里 `purgedBytes` 会自动包含附件字节，无需额外改动。

## 6. 明确不改的部分

- 不新增 `/v2/sessions/:id/attachment-indexes` 端点（manifest 已经够用）；
- 不解析、不索引、不去重附件内容；
- 不加服务端附件表，`SERVER_SCHEMA_VERSION` 保持 6（0.1.5 升级不迁移数据库）；
- 帧、blob、Vault 的既有语义不变。

## 7. 要改的文件

- `packages/shared/src/blob-batch.ts`：`BlobKind` 与 code 映射；
- `packages/shared/src/sealed-frame.ts`：`SealedFrameRef` 两个可选字段（`sealFrame` 不填）；
- `packages/server/src/http.ts`：kind 白名单两处、health capabilities；
- `packages/server/src/sessions.ts`：`assertRef`、`appendFrames` 的 blob/kind 校验、`MAX_FRAME_ATTACHMENT_BLOBS`；
- `packages/server/src/session-admin.ts`：`purgeSessionBlobs` 合并收集帧、索引与附件密文；
- 测试：`packages/shared/tests/blob-batch.test.ts`、`packages/server/tests/v2-attachments.test.mjs`；
- 文档：`docs/architecture/PROTOCOL.md`（blob kind、批次字段、能力列表、「附件索引」一节）；
- `packages/server/README.md` 留到发版提交时改（README 描述的是已发布能力）。

## 8. 测试清单

- 上传 `attachment`、`attachment-index` 后 append 成功，manifest/batches 能读回两个新字段；
- 缺索引 blob、缺附件 blob、kind 不符（把附件当索引）、sha 非法、超过 256 条、数组内重复 → 400 且不落库；
- 旧客户端不带新字段 → 行为与现在完全一致；
- 同一附件被同一批次多次引用 → 正常（插件去重，服务端只校验）；
- 索引里塞任意字节（不可解密）也能 append（服务端不解析）；
- remove/reset 后附件与索引 blob 被删，`usedBlobBytes` 下降；被其它会话引用的 blob 保留；
- 存档后 blob 仍在；
- 批量下载 `attachment-index` 成功；
- 配额：附件字节计入上限，超额返回 `quota`；
- 幂等：同一 `Idempotency-Key` 带相同新字段重放返回同一结果，带不同字段返回 `conflict`。

## 9. 设计初稿的待定点（已收敛，结论见 §11）

1. 密文 sha 清单放 `SealedFrameRef`（当前方案，无 schema 变更）还是单开服务端表（多一版 schema）；
2. 每批附件引用上限 256 是否够（单条消息最多 20 张图，一帧可能合并多个事件）；
3. 尾帧替换留下的孤儿附件：接受等 GC，还是 append 时就地清理不再被引用的附件密文；
4. 管理台是否分项展示附件占用（需要 schema 或按 manifest 统计）。

## 10. 兼容矩阵

| 组合 | 结果 |
| --- | --- |
| 新插件 + 新服务端 | 附件同步可用（capability 命中） |
| 新插件 + 旧服务端（0.1.4） | capability 缺失，附件功能关闭，事件同步照旧 |
| 旧插件（0.1.x）+ 新服务端 | 不带新字段，行为与现在一致 |
| 服务端 0.1.4 → 0.1.5 | 不迁移数据库，可直接回滚 |

## 11. 实施记录（2026-11-14）

已落地，全部为服务端与共享类型改动：

- `packages/shared/src/blob-batch.ts`：`BlobKind` 增加 `attachment-index`（wire code 4；1/2/3 未动）；
- `packages/shared/src/sealed-frame.ts`：`SealedFrameRef` 增加 `attachmentIndexSha256?`、`attachmentBlobs?`；`sealFrame` 不填；
- `packages/server/src/sessions.ts`：`assertRef` 校验两个字段的形状（1–256、去重、十六进制）；`appendFrames` 在链校验后检查 blob 存在与类别；新增导出常量 `MAX_FRAME_ATTACHMENT_BLOBS = 256`；
- `packages/server/src/http.ts`：单条上传与批量下载的 kind 白名单加 `attachment-index`；`/health` capabilities 加 `attachment-index`；
- `packages/server/src/session-admin.ts`：`purgeSessionBlobs` 用 `manifestBlobRefs` 统一收集帧、索引、附件三类 sha，目标会话与其它会话两侧都走同一函数；
- 测试：`packages/server/tests/v2-attachments.test.mjs`（5 个用例：回读与批量下载、9 类非法引用、旧式 append、幂等冲突、共享 blob 的 purge）；`packages/shared/tests/blob-batch.test.ts` 增加 roundtrip 与 code 4 断言；
- 文档：`docs/architecture/PROTOCOL.md` 增加「附件索引」一节并更新 kind/能力表。

验证：`pnpm run typecheck:server` 通过；`pnpm run test:server` 107 项全通过（含新用例）。

收敛后的决定：

1. 密文 sha 清单放 `SealedFrameRef`（无 schema 变更）；0.2.0 搬帧表时随批次落列，字段名不变；
2. 每批附件引用上限取 256；
3. 尾帧替换产生的孤儿附件本轮接受，等 GC；
4. 管理台分项展示附件占用不做。

遗留（不属于 0.1.5）：

- 插件侧实现（加密、索引生成、上传顺序、拉取前置、修复接口）另行推进；
- 孤儿附件 GC；
- 0.2.0 的 manifest 瘦身与帧表迁移（协议讨论单开）。
