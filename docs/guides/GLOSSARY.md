# 术语表

> 状态：约定文档（2026-10-21）。
> 本文只解释词义，不是协议规范；冲突时以 [RECONCILE.md](../sync/RECONCILE.md)、
> [CWD.md](../architecture/CWD.md)、[VAULT.md](../sync/VAULT.md)、[PROTOCOL.md](../architecture/PROTOCOL.md) 为准。

## 1. 先说最重要的几个

### Canonical / Canonical header（规范头）

本仓库里的 **Canonical** 只用于会话头，不是文件系统 `realpath`，也不是 cwd 的同步表示。

> 一种去掉了本机差异、供跨设备比较会话**身份**的 header 表示。

具体只做一件事：

- header 去掉 `cwd`；
- 其他可移植字段保留；
- **不处理 `working-directory/change` 事件**；
- 消息、工具调用、附件全部原样。

**Canonical 不是本地文件 checksum。** 本地 session 文件保留本机 header cwd 和 raw 事件；
跨设备从不做字节比较。canonical header 不承诺整个会话跨平台可用。

### Local view（本地表示）

本机 DSH 日志里的真实内容，例如：

```text
header.cwd = D:\git-repo
working-directory/change.cwd = D:\git-repo\sub
```

DSH 实际用它恢复工作目录、执行工具。**事件不 canonical 化，保持 raw。**

### Lifecycle（生命周期）

```text
sessionId + createdAt + formatVersion
```

三者相同才是同一个会话生命周期。  
仅仅 `sessionId` 相同，`createdAt` 不同，视为重建/复用 ID，不是同一会话。

### Prefix（前缀）

两个会话共享的事件区间。同步时通常取远端批次中 `seqTo <= localLast` 的部分。

### Shared prefix（共享前缀）

本地和远端都有、且应当逐批一致的那段事件。

### Diverged（已分叉）

生命周期相同、但以下任一不一致：

- canonical header；
- 共享前缀的批次哈希。

分叉不等于“两个不同会话”；它是**同一会话的两份不同历史**，不能自动合并。

## 2. 会话与内容

| 术语 | 说明 |
|---|---|
| **session / 会话** | DSH 的一次持久化对话，有 `sessionId`、header、事件日志 |
| **event / 事件** | 会话日志中的一条记录，有 `seq`；不等于“一轮对话” |
| **turn / 轮** | `turn/start` 到 `turn/end` 的一段；UI 概念，协议判定不用“轮数” |
| **header / 会话头** | 不可变的会话元数据：格式代际、创建时间、cwd、父会话等 |
| **working_directory** | DSH 工具；带 `cd` 时调用 workingDirectory.set，是 change 事件的常见来源 |
| **working-directory/change** | 记录 DSH 当前工作目录变化的必需事件；shell 内部的 `cd` 不触发 |
| **ensure()** | 检查 projection 当前/最后 cwd；目录不可用则回退到 header cwd/default，并可能 append 本地 change |
| **manifest / 清单** | 服务端保存的会话索引：header 引用、批次引用、最后 seq、安全边界、墓碑 |
| **batch / 批次** | 一段连续事件，默认上限 50 个事件或 256 KiB；同步的传输单位 |
| **seq** | 事件序号，从 0 开始连续 |
| **lastSeq** | 会话最后一条事件的 seq；同步比较的基础 |
| **chainHash** | 一个批次 **raw** 事件的稳定 JSON sha256；判断两边批次是否相同 |
| **sealed header** | 加密后的会话头 |
| **sealed batch** | 加密后的事件批次 |
| **blob** | 服务端保存的密文对象，按 `blobSha256` 寻址 |
| **blobSha256** | 密文字节的 sha256；用于上传去重与下载校验 |
| **tombstone / 墓碑** | 会话已删除的标记；不是物理删除所有 blob |

## 3. 会话身份与比较

| 术语 | 说明 |
|---|---|
| **identity / 身份** | `lifecycle + canonical header + raw 共享前缀` 的整体判定 |
| **canonical header** | 去掉 cwd/设备字段后的 header 元数据 |
| **raw event** | 未经 cwd 投影的事件；本地和远端按原值计算批次哈希 |
| **up-to-date / same** | 生命周期、header、raw 共享前缀都一致，且 lastSeq 相同 |
| **remote-ahead** | 前缀一致，远端事件更多；可考虑拉取 |
| **local-ahead** | 前缀一致，本地事件更多；可考虑推送 |
| **local-active** | 本地会话正在运行，暂不拉取 |
| **unmapped** | 远端有工作区 key，但本机没有对应的本地绑定 |
| **ignored** | 用户明确选择不再自动提示的会话 |
| **force write / 强行写入** | 冲突时用户勾选风险确认后只解除本地写入，不自动推送/合并 |
| **default auto / 默认自动** | 普通同步不逐会话确认，只有冲突/未映射/强行写入才提示 |
| **round / 轮数** | 只用于 UI 展示；不能替代 `lastSeq` 做同步判断 |

## 4. 工作区与路径

| 术语 | 说明 |
|---|---|
| **workspace path / 工作区路径** | DSH workspace 实体的 canonical 目录；创建时 `realpath` 后不重写 |
| **header cwd** | 会话 header 里的来源项目目录；不可变；已挂载会话 realpath 后应等于 workspace path |
| **current cwd** | `working-directory/change` 记录的当前运行目录；可以切到工作区子目录或工作区外 |
| **cwd** | 单独说时容易歧义；本仓库尽量写“header cwd”或“current cwd” |
| **tool path** | 工具参数/结果、消息文本里的路径；同步层不处理、不改写 |
| **workspace / 工作区** | DSH 中承载会话的项目目录实体 |
| **pathKey** | `HMAC(vaultKey, "workspace|" + canonicalWorkspacePath)`；本机工作区派生的 opaque key |
| **workspaceKey** | 逻辑工作区 key；远端会话携带，用于找本地落点 |
| **workspace/profile** | 远端逻辑工作区的加密可读名记录（label 等）；不等于本机绑定 |
| **binding / 绑定** | 本机的 `workspaceKey → localPath` 映射；首次确认后不可改绑 |
| **alias binding / 别名绑定** | `workspaceKey != pathKey` 的绑定；以后从该本机路径推送时复用远端 key |
| **nonPortable** | 当前/最后 cwd 在工作区外；本地警告，保留原值，不映射到根 |
| **syncSessionIds / 会话白名单** | 本机显式选中参与同步的根会话 id；空数组 = 不选任何会话，子代理跟随根；新会话不会自动进入白名单 |
| **pull target / 拉取落点** | 远端会话最终写入哪个本地工作区；由工作区绑定解析 |

## 5. 对账流程

| 术语 | 说明 |
|---|---|
| **reconcile / 对账** | 只读比较本地与远端，生成候选列表；不写会话 |
| **plan / 同步计划** | 对账结果：每个会话的方向、状态、原因 |
| **review / 确认** | 冲突/未映射时用户查看并选择；普通同步默认自动 |
| **apply / 应用** | 真正拉取或推送；写入本地或服务端 |
| **decision / 决策** | 用户对某会话选择 `sync` 或 `ignore`，按生命周期持久化 |
| **review gate / 确认门** | 发生冲突/未映射/强行写入时才出现的用户确认步骤 |
| **remote-only** | 远端有、本机没有的会话 |
| **local-only** | 本机有、远端没有的会话 |

## 6. 同步方向与安全边界

| 术语 | 说明 |
|---|---|
| **push / 推送** | 本机 → 服务端 |
| **pull / 拉取** | 服务端 → 本机 |
| **lease / 租约** | 服务端资源写锁；会话上传使用全局 `sync`，Vault 使用 `vault-writer:<writer>`，owner 为 `(deviceId, clientInstanceId)` |
| **clientInstanceId** | 每次 DSH 进程启动生成的随机标识，用于区分同一 token 的两个 writer |
| **append** | 向会话末尾追加批次；只接受前缀延续 |
| **tailOpen** | 会话尾部是否还有未闭合的 turn |
| **safeThroughSeq** | 最后一个闭合事件的 seq；读者只 apply 到这个边界 |
| **pending** | 拉取前落盘的恢复记录；崩溃后用于补完 |
| **fork** | DSH 的会话分叉；同步层不自动合并 |
| **diff / 分叉** | 同一生命周期但内容历史不同；需要用户处理 |

## 7. 加密与协议

| 术语 | 说明 |
|---|---|
| **E2E / 端到端加密** | 服务端只看到密文，不持有明文和口令 |
| **masterKey** | 口令经 scrypt/HKDF 派生的主密钥 |
| **sessionKey** | 每个会话派生的子密钥 |
| **vaultKey** | Vault（设备台账/工作区/笔记）独立派生的密钥域 |
| **AAD** | AES-GCM 的附加认证数据；绑定会话/批次/记录上下文 |
| **keyId** | 密钥标识，支持轮换 |
| **HKDF** | 从主密钥派生用途分离的子密钥 |
| **sealed envelope** | 密文封装格式；包含版本、keyId、nonce、密文等 |
| **revision** | 服务端 cursor 的单调版本号 |
| **protocol version** | `/v1` 协议版本；与 DSH 会话格式代际不同 |

## 8. 设备与层级

| 术语 | 说明 |
|---|---|
| **deviceId** | 设备 token 派生的设备标识 |
| **device token** | 设备 API 的 Bearer token |
| **L1** | 会话数据（sessions/attachments 等） |
| **L2** | 设备台账（OS、DSH/插件版本、工具链、工作区） |
| **L3** | agent 笔记（append-only） |
| **Vault** | L2/L3 的加密旁路存储，与会话同步分开 |
| **DSH** | DeepSeek Harness，本插件运行的宿主 |

## 9. 容易混淆的三组词

1. **“轮” vs “事件”**：轮是 UI 的对话回合；同步比较用事件 `seq`。
2. **“路径规范化” vs “canonical header”**：前者是字符串/文件系统归一化；后者只是去掉
   header cwd 的同步头表示，不处理事件 cwd。
3. **“同一个 sessionId” vs “同一个会话”**：前者只是 ID；后者还要求生命周期、canonical
   header 和 raw 共享前缀一致。
