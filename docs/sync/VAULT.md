# 加密附加数据层（Vault）与工作区映射

> 状态：**V2–V3 已完成；V4 工具链与 L3 笔记首版已实现，保留暂缓**（2026-10-22 起草；2026-11-19 校正）。
> 本文件承接 [DESIGN.md](../architecture/DESIGN.md) 的 L2 设备台账 / L3 agent 笔记；M4 的单一
> `workspacePath` 已由本文的工作区绑定替换。M4 的会话同步协议不变；Vault 是独立、可增量演进的旁路存储。
> 会话内部的 cwd 处理另见 [CWD.md](../architecture/CWD.md)（raw 事件 + 接收端修正，不承诺跨平台 resume）；
> 会话身份与启动对账流程见 [RECONCILE.md](RECONCILE.md)，术语见 [GLOSSARY.md](../guides/GLOSSARY.md)。
> 使用协议见 [USAGE-AGREEMENT.md](../guides/USAGE-AGREEMENT.md)：只改 DSH 必需的 cwd 元数据，
> 不改消息与工具调用。
>
> 服务端 0.1.0 起 Vault 路径为 `/v2/vault/*`，旧的 `/v1/vault/*` 已移除。

## 1. 范围

Vault 负责同步**会话事件之外**的加密数据：

- L2 设备台账：设备名、OS、DSH 版本与 profile、会话格式版本、已加载插件与版本、最后在线；
- 工作区身份与「远端工作区 → 本地工作区」绑定；
- L3 agent 笔记（append-only；scope=session/workspace/global × storage=device/vault；首版已实现）；
- 设备级 `plugins` 快照，用于跨设备兼容性提示和「一键匹配版本」（V3 已实现）。

当前实现包含最小 `device/profile`（含 `plugins` 快照）与 `workspace/profile`（见 §3.3）；
V3 的设备级插件匹配已实现；L3 笔记与压缩/保留策略仍是 V4 后续项。

**本机环境（`get_env` 工具、工具链版本/路径、本机路径）不在 Vault 范围内**：它只在本机
读取、只在本机展示，不上行服务端（见 §3.7）。设备台账只保留同步/兼容性需要的身份与版本。

不做：

- 会话事件本身（仍走现有 manifest + 批次 + 租约）；
- 附件正文：已由会话同步通道实现（附件密文走 `kind=attachment` blob，按批次的索引与补齐见
  [ATTACHMENT-SYNC-DESIGN.md](../plans/ATTACHMENT-SYNC-DESIGN.md)），不放进 Vault；
- 工作区项目文件；
- 服务端读取明文。Vault 默认全量 E2E，服务端只做 append 校验、存储与 cursor。

### 已接受的决策

1. **Vault 粒度**：V0/V1 一台服务端实例 = 一个 Vault；公益服的多租户/Vault 路由另开 package 或仓库，只共享插件对接所需的协议边界；
2. **设备与 writer**：一个 DSH profile/安装实例 = 一个 device token = 一条 writer stream；`device/profile` 保留 profile 字段，但 stream 按 deviceId 隔离；同一 token 被多个进程并发使用视为配置错误；
3. **工作区身份**：远端 workspace 的正式可读名由 `workspace/profile` 记录承载；本机
   `workspaceKey → localPath` 绑定只存本机 `vault/bindings.json`，不上行 Vault（`bindings.ts`）；
4. **不改绑**：首次绑定后不提供 workspace/session 迁移或改绑；DSH 本身也不支持工作区/会话迁移，强行走文件搬运破坏性太大；
5. **子代理继承**：子代理跟随根会话的 key；子代理 manifest 不重复 key，拉取前先读根 manifest；
6. **未映射行为**：不 apply、不猜落点，标 `unmapped` 等用户选择；
7. **本机环境不上行**：`get_env` 读到的 OS、工具链、路径只在本机使用；设备台账只上报
   OS/DSH/插件这类展示或兼容性字段，不上报工具链与 `DSH_HOME`。

### V0/V1 范围

- **V0**：只做本地密钥域、记录信封、AES-GCM/AAD、记录链与篡改/重放测试；不接服务端。
- **V1**：服务端 `/v2/vault/append|cursor|stream`、最小设备台账、`workspace/profile` 同步；不做工作区落点改变。
- **V2**：会话 manifest 增加 `workspaceKey`、本机绑定、未映射阻断和映射 UI。
- V3 插件版本匹配、V4 笔记/保留策略不在 V1 范围内。

公益服与自部署的差异（多租户、配额、管理、审计）留在独立 package/仓库；插件只依赖本文定义的 Vault 记录与 HTTP 边界，不把公益服实现塞进自部署包。

### 本稿采用的插件版本策略

- **插件版本**：自动检测差异并提供「匹配版本」操作；任何安装/升降级都必须用户确认，
  不做静默切换。若以后要“自动匹配”，作为显式开关再加，不作为默认。

## 2. 为什么另起一层

会话 manifest 是热路径：

- 只应该出现链、批次范围、开放尾这类同步必需字段；
- append-only，不适合频繁写入设备台账/工具链；
- 工作区路径、插件清单、工具链路径都是敏感信息，不适合放明文 manifest；
- 设备台账/笔记/版本匹配有各自的演进节奏，不应该每加一种数据就改会话协议。

Vault 复用现有 **封帧原语、blob 存储、配额、cursor、错误分类**，但拥有独立的密钥域和记录格式。

## 3. 数据模型

### 3.1 设备 stream

每台设备只写自己的 stream：

```text
device/<deviceId>
  seq 1: device/profile        # 已实现
  seq 2: workspace/profile     # 已实现
  # 设计稿（未实现）：workspace/bind
```

- 一台 DSH profile/安装实例对应一个 device token 与一条 stream；同一 token 不允许被多个进程当作两个 writer 并发使用；
- 每台设备一条单调递增的链，天然无跨设备写冲突；
- 记录不可变，更新语义由客户端折叠（同一实体取最新，删除写 tombstone）；
- 服务端只看到设备、seq、prevHash、密文 blob、大小、时间；
- 其他设备可以读取这些 stream，但**不能替它改本地绑定**；绑定是否复用由本机决定。

### 3.2 记录信封

服务端可见的索引：

```jsonc
{
  "v": 1,
  "writer": "device-id",
  "seq": 12,
  "prevHash": "sha256-of-previous-record",
  "blobSha256": "…",
  "bytes": 2048,
  "createdAt": 1790000000000,
  "sealed": { "formatVersion": 1, "keyId": "…" }
}
```

加密载荷（服务端不可见）：

```jsonc
{
  "schema": "dsh-session-cloudsync/vault/1",
  "kind": "device/profile",
  "entity": "device-id",
  "at": 1790000000000,
  "data": { /* 按 kind 定 */ }
}
```

- `schema` 放在密文里，未知 schema fail-closed；
- `kind` / `entity` 也不明文暴露，避免服务端按类型统计敏感信息；
- 链哈希用记录索引 + 密文 blob 的规范 JSON sha256，`prevHash` 串成链；
- 服务端校验 `seq` 连续、`prevHash` 与上一记录一致；完整性最终由客户端验链。

### 3.3 L2 设备台账

`kind: "device/profile"`，每台设备一条最新快照（旧记录保留作历史）：

```jsonc
{
  "deviceId": "…",
  "deviceName": "workstation",
  "os": { "platform": "win32", "arch": "x64", "release": "10.0.26100" },
  "dsh": {
    "version": "0.2.2-rc.1",
    "profile": "web",
    "sessionFormatVersion": 4
  },
  "plugins": [ { "name": "dsh-session-cloudsync", "version": "0.1.5" } ],
  "lastSeenAt": 1790000000000
}
```

当前代码写上述字段（`vault-sync.ts`）：`plugins` 已接入设备级插件快照；
`os` 供设备列表展示。`workspaces`、`dshHome`、Node 版本、工具链版本/路径**不写入**
`device/profile`——工作区列表由每工作区一条 `workspace/profile` 承载（见 §3.4），
工具链只由本机环境工具读取（见 §3.7）。

设计约束：

- **版本来源要标**：`ctx.loader.entries()` = 加载了什么；`package.json` = 装了什么；
  `spawn` = 实际工具链是什么。三者可能不一致，不能合并成一个“版本”；
- 设备台账只记录 DSH 运行时版本/会话格式和已加载插件；工具链属于本机环境，不进台账；
- 本地状态是 `<DSH_HOME>/session-cloudsync/vault/state.json`（writer/seq/prevHash/digest），
  随 Vault 上行的是加密记录本身；`ledger/<deviceId>.json` / `DEVICES.md` 未实现；
- `device/profile` 只在内容 digest 变化时 append，不是每轮都写；
  `lastSeenAt` 只在写新记录时带一次，没有按小时刷新的实现；
- agent 写入走工具白名单字段，不允许改 `deviceId`/`deviceName` 这类身份字段；
- 不采集用户名、环境变量值、密钥路径、token、工具链与 `DSH_HOME`；
- 设备台账本身是兼容性闸门：`sessionFormatVersion` + DSH 版本决定能否安全推送。

### 3.4 工作区身份与绑定

工作区身份由路径派生：

```text
canonicalWorkspacePath = DSH Workspace.path（或 realpath）
pathKey = base64url(HMAC-SHA256(vaultKey, "workspace|" + canonicalWorkspacePath))[0..24]
```

- 同一 canonical workspace path 在不同设备上得到同一个 `pathKey`；
- key 不可逆，服务端看不到路径；
- 路径搬家、跨平台不同根目录需要人工映射，映射后写入本机绑定。

远端工作区的正式可读名由一条独立记录承载：

```jsonc
{
  "schema": "dsh-session-cloudsync/vault/1",
  "kind": "workspace/profile",
  "entity": "opaque-key",
  "data": {
    "key": "opaque-key",
    "label": "project",
    "createdAt": 1790000000000,
    "lastSeenAt": 1790000000000
  }
}
```

- 任何从该 workspace 推送会话的设备都应自动写一条 `workspace/profile`；它描述的是**远端逻辑工作区**，不是某台机器的本地路径；
- `label` 是远端工作区的显示名；多台设备写不同 label 时按记录时间取最新，UI 可标注来源设备；
- `workspace/profile` 只负责“远端工作区是什么”，本机绑定只负责“本机把它放到哪里”，
  两者不能混用。

绑定记录：设计稿里是 Vault 的 `workspace/bind`；当前实现不上行 Vault，绑定只写本机
`<DSH_HOME>/session-cloudsync/vault/bindings.json`（`bindings.ts`）：

```jsonc
{
  "version": 1,
  "bindings": {
    "opaque-key": {
      "key": "opaque-key",
      "localPath": "D:\\work\\project",
      "label": "project",
      "createdAt": 1790000000000
    }
  }
}
```

- 绑定是**每台设备自己的**；A 的绑定不会自动改 B 的路径；
- 其他设备的绑定不参与同步，也不作为建议展示（没有 `workspace/bind` 记录）；
- 同一 `localPath` 不能绑定多个远端 key：`bindWorkspace` 直接拒绝；同一远端 key 只能
  绑定一个本地路径；**首次绑定后不提供改绑或工作区迁移**；DSH 本身也不支持工作区/
  会话迁移，强行走文件搬运破坏性太大；
- 当 `key !== pathKey` 时，这是**别名绑定**：本机以后从该 `localPath` 推送会话时，
  应使用绑定的 `key`，而不是本机派生的 `pathKey`，这样两台设备的会话才会汇入同一个
  remote workspace；
- 推送时先按 `localPath` 查绑定：有绑定用 `binding.key`，无绑定用 `pathKey`
  （`index.ts` 的 `workspaceKeyForCwd`）；
- UI 以“本机一个路径只能有一个推送身份”为约束。

会话 manifest 增加可选的明文 `workspaceKey`（opaque，不含路径）；子代理继承根会话的 key。
当前只支持带 key 的新 manifest；缺失 key 的根直接视为 `unmapped`，不猜落点。

### 3.5 写者租约

租约统一为**资源写锁**，不再只按会话：

```text
resource = sync
         | vault-writer:<writer/deviceId>
owner    = (deviceId, clientInstanceId)
TTL      = 60s
```

- `clientInstanceId` 每次 DSH 进程启动时随机生成，不持久化；通过 `X-Client-Id` 随 lease/append 请求发送；
- 同一 `(deviceId, clientInstanceId)` 的再次 acquire 视为续租，顺延 TTL；
- 不同 client 在过期前 acquire 同一资源返回 `409 lease-held`；
- 会话 append/create/delete 必须匹配全局 `sync` 租约；Vault append 必须匹配
  `vault-writer` 租约；两者都校验 token 派生的 deviceId 与 clientInstanceId；
- release 只允许当前 owner；进程崩溃由 TTL 释放；
- 读操作（manifest/cursor/stream/blob 读取）不加租约；会话拉取不需要 `sync`；
- 全局 `sync` 租约让同一时间只有一台设备上传会话；Vault writer 租约独立，两者互不阻塞；
- V0/V1 先不做租约续租接口；单次 append 远小于 60 秒，后续确有长写入再加；
- 服务端租约是权威，本地再加 `$DSH_HOME/session-cloudsync/vault/writer.lock`
  （`{pid, clientId, at}`）做快速失败；发现锁的持有 PID 已死或 clientId 不同就清掉
  stale lock（`vault-sync.ts` 的 `withWriterLock`）。

加入 `clientInstanceId` 后，同一 token 的第二个进程会被服务端以 `lease-held` 拒绝；
会话侧现在使用全局 `sync` 租约，Vault 侧使用 `vault-writer` 租约，互不阻塞。

Vault 写入流程：

1. acquire `vault-writer:<deviceId>`；
2. 读取当前 stream head；
3. 生成 record（seq / prevHash）；
4. append；
5. release。

租约冲突只影响对应资源：Vault writer 冲突不阻塞会话同步；全局会话 `sync` 冲突不阻塞 Vault。

append 幂等规则：同一 `writer/seq/prevHash/blobSha256` 的重试返回已有记录，不生成
第二条同 seq 记录；租约已释放也允许幂等重放。

### 3.6 L3 agent 笔记（V4，首版已实现，未发布）

目标：用加密、跨设备的个人笔记，**部分替代工作区里的 `ENVIRONMENT.md` / `AGENTS.md`**：

- `ENVIRONMENT.md` 里机器/工具链/路径相关的事实 → `storage=device` 或 `scope=workspace`；
- `AGENTS.md` 里项目约定、构建方式、工作习惯 → `scope=workspace`，默认同步；
- 不替代 git 仓库里的团队文档：笔记属于个人 Vault，不随仓库提交，也不改工作区文件。

#### 记录

`kind: "note/append"`，只追加：

```jsonc
{
  "id": "note-…",
  "at": 1790000000000,
  "scope": "workspace",        // session | workspace | global
  "scopeKey": "workspace-key", // sessionId / workspaceKey / ""
  "storage": "vault",          // device | vault
  "deviceId": "…",
  "authorKind": "agent",       // agent | user
  "author": {
    "sessionId": "session-…",  // 可选，只作来源
    "agentPreset": "standard"  // 可选
  },
  "title": "构建约定",
  "summary": "pnpm 构建；测试先 node --test。",
  "text": "markdown…",
  "tags": ["build", "pnpm"],
  "pinned": false,
  "threadId": "note-…",        // 同一主题的笔记共用；首条 = 自己 id
  "replyTo": "note-…"          // 可选：直接上一条
}
```

`title` ≤ 80 字符；`summary` ≤ 200 字符，是自动注入用的短文本；`text` ≤ 8 KB。

#### 两个正交维度

`scope` 决定“属于哪个上下文”，`storage` 决定“存哪里、是否同步”：

| storage | scope | scopeKey | 存储 | 可见范围 |
|---|---|---|---|---|
| `device` | `session` | sessionId | 本机 `notes/device.json` | 本机 + 本会话 |
| `device` | `workspace` | workspaceKey | 本机 | 本机 + 本工作区 |
| `device` | `global` | `""` | 本机 | 本机全部工作区 |
| `vault` | `session` | sessionId | Vault | 同一会话，跨设备 |
| `vault` | `workspace` | workspaceKey | Vault | 同一工作区，跨设备（agent 默认） |
| `vault` | `global` | `""` | Vault | 全部同步工作区；只允许用户写 |

- 不再有第四个 `device` scope；“仅本机”是一个 storage 开关；
- thread 绑定 `(storage, scope, scopeKey)`，回复必须同组，不能跨 scope 串 thread；
- 笔记本身不可变；**编辑/修正 = 在同一 `threadId` 追加一条新笔记**；
- 删除 = 用户发 tombstone；
- 会话删除/存档后 `session` 笔记保留并标 orphan，UI 可清理；
- 单条 ≤ 8 KB；每工作区 ≤ 200 条、每会话 ≤ 50 条、每 Vault ≤ 100 条、每本机 ≤ 100 条；
- `storage=device` 的笔记只写本机，0600 权限，不进 Vault；若被注入，会进入本机会话日志，
  但不上传服务端。

#### 写入与权限

- `agent` 可写 `storage=device` 的任意 scope；
- `agent` 可写 `storage=vault` 的 `session` / `workspace`，默认 `(vault, workspace)`；
- `agent` **不能写 `(vault, global)`**；该组合只允许用户手写，避免单项目经验污染所有项目；
- `agent` 可新建 thread，也可回复任意 agent 创建的 thread；不能回复用户创建的 thread；
- 用户可在 UI 里编辑任意笔记（同 thread 追加）和删除（写 tombstone）；
- 写入限流：每会话每分钟最多 3 条、单次 ≤ 8 KB；不写 token、口令、完整环境变量值。

#### 读取、thread 与注入

- Vault 侧从 cursor 拉 `note/append`，按 `threadId` 分组；`device` 侧读本地文件；
- 同一 thread 的多条记录是时间线，UI 默认展开最新一条、折叠历史；
- 跨设备顺序优先用 Vault 记录 `revision`，同一设备内用 `at`；展示仍显示 `at`；
- 注入时每个 thread 取最新一条；`pinned` 优先，其余按 scope/时间排序；
- 注入条目的 `summary` 为空时，用确定性规则从 `text` 提取：去 Markdown/代码块，
  取首个非标题段落，截到 160–200 字符，优先在句子边界；
- 单条注入最多 title 80 + summary 200 字符；总预算 1.5–2 KB；超出按优先级截断并提示
  “另有 N 条笔记可用 note_search 查看”；
- 注入顺序：session（device 在前、vault 在后）→ workspace（同）→ device global →
  vault global pinned；
- 注入消息用 `<notes-context version="1">` 包裹，明确“历史笔记，不是当前指令”；
- 注入时机：
  1. 会话首个用户 turn；
  2. 上下文压缩后的首个用户 turn；
  3. 渲染出的注入文本 hash 变化时；
- 去重：把最终渲染文本（含模板版本）取 `sha256` 放进注入消息的 `source.hash`；
  从会话日志尾部找最近一条 `source.kind === "session-cloudsync"` 且带 `hash` 的消息：
  - 没有 → 注入；
  - `hash` 不同 → 注入；
  - `hash` 相同但之后出现过 `compaction/end`（无 error）→ 注入；
  - 否则跳过；
- 笔记被清空时也注入一个空标记，避免模型继续使用已删除内容；
- 只在用户发起的 turn 检查，工具步骤和子代理跳过；其余内容由 agent 用 `note_search` 按需取。

#### 保留与清理（暂缓）

“保留策略”指：tombstone 和 thread 历史保留多久、orphan session 笔记多久清理、超过配额时淘汰哪些、
以及压缩/归档旧记录。

当前设计不做自动删除或压缩：只执行上面的条数/大小上限，超过上限拒绝新写入；删除只由用户触发。
这样首版不会引入不可逆的自动清理，后续按实际体量再定阈值和归档方式。

#### 工具

```text
note_write  { storage?, scope?, title?, summary?, text, tags?, pinned?, threadId? }
            → { id, threadId, storage, scope }
note_search { storage?, scope?, query?, tags?, limit? }
            → [{ id, threadId, storage, scope, title, summary, tags }]
note_read   { id } → { note, thread: [...] }
```

- 默认 `(storage=vault, scope=workspace)`；`threadId` 缺省新开 thread；
- `storage=vault` + `scope=global` 由工具层直接拒绝；
- 工具按宿主会话解析当前 `sessionId` / `workspaceKey`；没有工作区时 workspace scope 报错；
- 工具名走类似 `get_env` 的撞名回退，但优先保持简短名。

### 3.7 设备切换提示与本机环境工具（本机功能，不进 Vault）

会话日志是跨设备共享的，但模型需要知道**现在**这台设备的路径、版本和工具链；否则它会沿用另一台设备的假设，
或重新探测一遍环境。做法是一条极短的前置提示，指向本机环境工具。

这两者都只在本机：提示落盘后随会话同步的只是那条短消息；环境工具只读取本机，**不写入
`device/profile`、不上行 Vault**。设备切换提示用的 `deviceId`/`deviceName` 来自 `/v2/me`
的服务端身份，不是环境采集结果。

**注入通道：`agent/pre-step`，不用 `agent.inject`。**

- `agent.inject()` 在调用那一刻就 `session.append('agent/inbox/spliced')`（`agent-loop/src/inbox.ts:223`），
  即使用户没有继续会话也会落盘并被同步；对我们不合适；
- `agent/pre-step` 的 listener 把消息放进 `decision.messages`，loop 只在**这一步被准入时**才写成
  `user/message`（`agent-loop/src/agent.ts:463-473`）。在那之前它只在插件内存里：用户不发消息就不写日志、
  不产生新的同步事件；
- 只在 `payload.messages` 含 `source.kind === 'user'`（用户发起的 turn）时检查，工具步骤不触发；
- 从 `agent.session.snapshotEvents()` 尾部反向扫最近一条 `user/message` 且 `source.kind === 'session-cloudsync'`
  的提示，读其 `source.deviceId`：等于本机设备 id 就跳过，否则（或从未注入过）把新提示插到
  `decision.messages` 最前面；子代理会话跳过；
- `snapshotEvents()` 是内存数组（打开会话时日志已载入），实测 10,000 事件全量反向扫约 0.1 ms、
  100,000 事件约 0.6 ms；通常第一条就命中，不需要额外状态文件。

**消息格式**（`source.kind` 不能是 `user`，否则会被当成人工提问、影响列表排序和排队）：

```jsonc
{
  "role": "user",
  "content": [{
    "type": "text",
    "text": "<device-change device=\"workstation\" deviceId=\"…\">\n用户的工作设备已切换到 workstation，如需了解本机环境事实请使用工具 get_env。\n</device-change>"
  }],
  "source": {
    "kind": "session-cloudsync",
    "form": "notice",
    "summary": "设备已切换到 workstation",
    "deviceId": "…",
    "deviceName": "workstation"
  }
}
```

- 去重读 `source.deviceId`，不解析文本；`<device-change>` 包裹只给模型看；
- `form: 'notice'` 让 Trajectory 显示成提示行（`ui-trajectory` 已知 form 列表），`source.kind !== 'user'`
  不影响 `sessionListMetadata.lastPromptAt`；
- `deviceName` 优先取插件配置的 `deviceName`，为空时取 `/v2/me` 的 `device.label`；`deviceId` 取
  `/v2/me` 的 `device.deviceId`（服务端创建设备时分配，见 `packages/server/src/http.ts:236-245`）。
  插件缓存这对身份（token/配置变化时失效）；取不到时这一轮跳过，下一轮再试，绝不阻塞 pre-step；
- 提示落盘后会随会话正常同步：这是"模型可见必须入日志"的必然结果，消息本身足够短，且同一设备连续会话
  不会重复注入。

**本机环境工具**（V4）：名字按 `get_env` → `this_env` → `dscs_env` 的顺序取第一个未被占用的
（`ctx.tools.get()` 探测 + 注册 try/catch）；全部被占用时只告警，不注册工具、也不注入切换提示，
提示文案里的工具名始终取实际注册成功的那个。代价是占用 `get_env` 这类通用名会让后加载的同名插件注册
失败——这是选名顺序的已知取舍。插件配置 `envTool`（默认开）关闭工具与提示；`toolchainCommands`
覆盖探测白名单（默认 node/npm/pnpm/git/python/uv）。

工具只读本机、不发网络请求（工具链探测走宿主 `ctx.shell`，受执行器超时/沙箱约束），输出：设备名/设备 id、
OS/arch/release、DSH 版本与 profile、Node、会话格式版本、工具链版本与路径、本机工作区映射。

工具链分两源：

- `auto`：按 `toolchainCommands` 白名单（默认 node/npm/pnpm/git/python/uv）从 PATH 探测；
- `authored`：本机 config 的 `toolchainAuthored` 手工条目，用于不在 PATH 里的工具，形如
  `{ name, path, version? }`。同名时 `authored` 优先，自动探测跳过该名字；`path` 不执行，
  `version` 手填，缺失时显示 `unknown`。

`authored` 条目只在本机 config 里，不写 Vault、不随设备台账上传；换设备后路径本来也不通用。
它和插件版本匹配（V3）无关：插件清单走设备台账，工具链走本机环境工具。


## 4. 密钥与加密

```text
masterKey = scrypt(passphrase, salt)
masterKey ──HKDF("dsh-sync/vault/v1")──▶ vaultKey
vaultKey  ──HMAC("workspace|"+path)────▶ workspaceKey
```

- **所有设备必须使用同一个同步口令**；没有显式配置 `salt` 时，盐由规范化后的 `serverUrl`
  派生（`sha256("dsh-session-cloudsync/v1|" + base)` 的前 16 字节），因此各设备的
  服务端地址写法也必须一致。规范化会统一去掉首尾空白与尾斜杠、把 scheme/host 转小写、
  去掉默认端口（`:80` / `:443`）；`localhost` 与 `127.0.0.1` 仍视为不同地址。设备 token
  只用于鉴权，不参与密钥派生；
- 口令、默认盐或显式 `salt` 任一不一致，会话密钥的 `keyId` 就会不同，拉取会报
  `封帧的 keyId 与当前密钥不符`，无法解密远端封帧；
- 每个 Vault 记录单独封帧，AAD 至少绑定 `writer + seq + prevHash + schema`；
  防止把记录挪到另一台设备/另一个 seq；
- `keyId` 随记录保存，支持未来口令轮换；
- 服务端没有 vaultKey，无法读设备台账、工具链、路径或笔记；
- 服务端仍能观察写入频率、大小、设备在线时间，这是本设计的隐私边界。

## 5. 工作区映射与拉取

### 5.1 拉取决策

```text
session manifest
  └─ workspaceKey ──▶ 查本机 bindings.json ──▶ 有：落到 localPath
                                          └─ 无：unmapped，不 apply
```

- 不走任何“旧路径 fallback”；没有 key 或没有映射都标 `unmapped`；
- **绝不**把未映射的远端会话塞进第一个工作区；
- 未映射会话持久化在宿主状态文件的 `unmapped` 列表里（`state.ts` 的 `PullJournal.unmapped`，旧 `pullOnce` 路径写入）；任务模式下映射页展示的未映射工作区主要来自 `workspace/profile` label 与远端摘要清单（`index.ts` 的 `workspaces()`），不依赖逐会话回放；已持久化的条目在游标越过或进程重启后仍然保留，直到映射成功或会话消失；
- 映射页合并来源：controller 的未映射会话、Vault 里已有 `workspace/profile` 但本机未绑定的远端工作区、以及远端摘要清单里的 workspaceKey。后两者保证首启映射步骤在第一次同步之前也能看到远端工作区；
- 状态/气泡显示 `unmapped` 数量和原因；
- 用户完成映射后，不需要重放游标：下一轮 `planRound` 会把该工作区下的远端-only 会话规划成 `local-missing` 并拉取（`index.ts` 的 `pullRoots` / `planSync` 的 `boundWorkspaceKeys`）；旧的 cursor 回填入口（`controller.beginBackfill` / `recordBackfill`）已无调用方；
- 本机已注册工作区自己的 key（路径派生 key 或已绑定 key）直接解析到该路径，不需要“自己映射自己”；映射列表也会排除它；
- 已有远端 manifest 的会话沿用远端 `workspaceKey`；映射只改变新会话的推送身份。这样把远端 key 绑到已有本地会话的路径时，旧会话不会因为 key 变化被判成 `diverged`；
- 映射目标是本机注册工作区；不再要求它们在某个同步白名单内。已绑定到别的 key 的本地路径不再出现在候选里；
- 远端 label 从 `workspace/profile` 解密后显示在映射列表；失败时退回 opaque key + 会话数；
- 绑定是一次性操作；点击后在 UI 内再显示一次“确认绑定（不可改绑）”，二次确认后才提交。

### 5.2 同路径（本机身份）

本机对每个已注册工作区算 `pathKey`，与远端 key 比较：

- 完全匹配：这是**本机身份**，会话自动落到该路径，不需要也不允许再绑定；
- 之所以不允许改绑：同一个 `workspaceKey` 由路径派生，绑到另一条本地路径会让两条路径争夺同一个远端身份，推送冲突；
- 不同路径：展示远端 `workspace/profile` 的 label/会话样例，让用户选本地落点；
- 选择不同路径后建立别名绑定，之后本机从该路径推送时复用远端 key。

### 5.3 会话级例外

首版不提供 `sessionId → localPath` 覆盖表：

- 工作区绑定是一次性的，DSH 也不支持会话迁移；
- 个别会话换落点只能通过明确的破坏性删除/重建，不进入 V2；
- 子代理跟随根会话，不单独覆盖。

### 5.4 工作区路径配置

- 单一 `workspacePath` 已删除，不再有“所有远端会话落到同一工作区”的路径；
- 每个远端会话按自己的 `workspaceKey` 查绑定；
- 不保留旧 manifest 的 cwd fallback。

### 5.5 已绑定后不改绑

- 同一 `workspaceKey` 的绑定一旦确认，UI 不再提供改绑入口；
- 同一 `localPath` 的推送身份也不能改；
- 错误映射的恢复方式是显式重置本地同步状态并重新拉取，属于破坏性操作，不在自动流程里；
- 不实现工作区/会话文件迁移，也不改写已有会话 header cwd。

## 6. Vault 协议（V1 已实现，服务端路径为 `/v2/vault/*`）

复用 `/v2/blobs?kind=vault` 或 `/v2/blobs/batch`（`kind=3`）上传密文，然后：

```text
POST   /v2/vault/lease
DELETE /v2/vault/lease
POST   /v2/vault/append
GET    /v2/vault/cursor?since=<revision>
GET    /v2/vault/stream/:writer?from=<seq>&limit=<n>
```

`POST/DELETE /v2/vault/lease` 需要 `X-Client-Id`；资源固定为
`vault-writer:<token 的 deviceId>`。append 也带同一个 header，服务端校验租约 owner。

`append` 请求：

```jsonc
{
  "writer": "device-id",
  "seq": 12,
  "prevHash": "…",
  "blobSha256": "…",
  "bytes": 2048,
  "createdAt": 1790000000000,
  "sealed": { "formatVersion": 1, "keyId": "…" }
}
```

- `writer` 必须等于 token 派生的 deviceId，不能替别的设备写；
- append 必须携带匹配 `vault-writer:<writer>` 租约的 `X-Client-Id`；
- 服务端校验 seq 连续、prevHash 与存储链一致、blob 已上传且大小匹配；
- cursor 返回记录索引，不返回载荷；
- 每记录上限 1 MiB，stream 总上限按配额；超限 `507`；
- 删除用 tombstone 记录，旧记录不物理删除；GC 需要单独设计；
- 服务端升级是增量的；插件已发布 0.1.4，但 0.x 不做历史数据迁移，不需要为旧客户端保留 Vault 兼容分支。

### 6.1 V0 记录封帧与链

为避免重试产生不同密文，Vault 记录使用**确定性封帧**，不复用会话帧的随机 nonce：

```text
vaultKey  = deriveSubkey(masterKey, "dsh-sync/vault/v1")
recordKey = deriveSubkey(vaultKey, "v1|vault-record:" + writer + ":" + seq)
nonce     = 12 个 0 字节
keyId     = deriveSubkey(vaultKey, "v1|key-id")[0..8] 的十六进制
```

- 同一 `writer + seq` 的记录在任何时刻重封，密文字节必须完全一致；
- 明文载荷是 `{schema, kind, entity, at, data}` 的规范 JSON；
- AAD = `stableStringify({ v, writer, seq, prevHash, schema })` 的 UTF-8 字节；
- `prevHash` 在 `seq=1` 时为 `null`；之后等于上一条记录的 `recordHash`；
- `recordHash = sha256(stableStringify({ v, writer, seq, prevHash, blobSha256, bytes, createdAt, sealed }))`；
- `blobSha256` 是密文字节的 SHA-256，`bytes` 是密文字节长度；
- `sealed` 是 `{ formatVersion, keyId }`，其中 `keyId` 为 16 位小写十六进制；
- 服务端 append 收到相同的 writer/seq/prevHash/blobSha256 时视为幂等重试，返回已有记录；
  同 seq 但记录内容不同返回 `409 conflict`，不能静默覆盖；
- cursor 按全局 `revision` 升序返回记录索引；stream 按 `writer + seq` 升序返回；
  两者都不返回明文载荷。

`workspaceKey` 的计算固定为：

```text
base64url(HMAC-SHA256(vaultKey, "workspace|" + canonicalWorkspacePath)).slice(0, 24)
```

`canonicalWorkspacePath` 使用 DSH `Workspace.path` / `realpath` 的原值；Windows 比较时
统一小写、`\` 归一为 `/`，但 HMAC 输入保留一份确定的平台规范形式。跨平台不同根目录不做
自动换算，走别名绑定。

## 7. 插件版本匹配与一键切换（V3 已实现，设备级）

### 7.1 版本来源

- 设备台账的 `plugins` 快照记录本机 **profile 已安装**的 bundle：`{name, version, source, enabled}`；
  来源是 `pluginManager.listBundles()`，不按会话记录；
- 插件是 profile 全局安装，没有“会话专用插件”；会话日志不写插件版本戳，
  历史会话需要时另行设计，不在本期范围；
- 快照按内容 digest 去重，安装/升级/启用变化时才 append；
- `source` 保留原始 profile spec，用于判断 registry / git / file / link；
- 当前插件自身（`dsh-session-cloudsync`）不上报，避免运行中替换自己。

### 7.2 检测与提示

打开「跨设备插件」面板时比较本机与 Vault 里其他设备的 `plugins` 快照：

- 空 `plugins` 的设备档案不渲染成空列，只在表头汇总数量；
- 当前读端无法区分“设备已删除”和“设备只是没有插件记录”，因为服务端还没有
  面向设备 token 的设备列表 API；下个服务端版本补 `GET /v2/devices`（只返回未吊销设备）
  后，再按该列表过滤空档案；
- 本地缺包：显示待安装；
- 本地版本低：显示可升级；
- 本地版本高：显示「本地较新」，不自动降级；
- `file:`/`link:` 或 git 来源：标为不可自动匹配；
- profile / DSH 版本不同：同等对待为提示，不自动执行。

### 7.3 一键匹配

- UI 是「本机 + 各设备 + registry 最新」的版本矩阵，行是插件、列是设备；
  registry 列按 `name@latest` 查询并缓存；失败显示 `—`，不影响其他列；
  点其他设备列头可全部采用该设备版本，也可以把单张版本卡拖到本机列；
- 顶部「应用变更」逐项执行；**不能静默执行**；
- 安装顺序、build script 审批、版本豁免、DSH 引擎不兼容都沿用 Plugins 页现有规则；
- 本地缺包用 `installBundle(pkg@version)`；本地版本低用 `updateBundle`；
  当前 DSH 的 `installBundle` 不能替换已安装包，`updateBundle` 只升不降，
  所以降级不在一键匹配范围，只给出手工命令；
- 一次一个包，逐项汇报进度，不另造安装器；
- 切换是 profile 级操作，会影响该 profile 所有会话；UI 必须写明；
- 安装可能需要重启后端，结果按包逐个汇报；
- 不自动切换 DSH 本体，只提示兼容版本。

### 7.4 “自动”的边界

自动只做**检测、预选、排序**：

- 自动填好建议版本；
- 自动标记“可直接匹配”的包；
- 用户点一次执行；
- 默认不自动安装、不自动降级、不自动批准 build script；后续若要自动，必须是显式开关 + 白名单。

### 7.5 设备颜色与能力门控（客户端已预留）

- 本机颜色来自 `/v2/me` 的 `device.color`；其他设备颜色/名称来自
  `GET /v2/peers`（设备 token 可见，返回 `deviceId/label/color/lastSeenAt`）；
- 客户端只在 `/health` 的 `capabilities` 包含 `plugin-version-sync` 时才请求
  `/v2/peers`；旧服务端不会收到未知请求；
- 没有颜色时 UI 按 `deviceId` 哈希从调色板回退；
- 图标：本机已安装插件用 `pluginManager.listBundles()` 的 `meta.icon`（data URL）；
  其他设备/registry 列按 registry 的 `icon` 字段从 CDN 读取并缓存，取不到时回退首字母；
- 服务端改动不写进插件发版 tag：插件先发版并带着门控，服务端后续声明能力即可生效。

## 8. 工具链识别（V4，工具链与笔记首版已实现；保留未实现）

沿用既有 L2 设计：

- `auto`：按配置的允许列表采集（node、npm、pnpm、git、python、uv 等），
  只执行带超时的 `--version` / `which` 类调用，不拼 shell，不读环境变量值；
- `authored`：本机 config 的 `toolchainAuthored: [{name, path, version?}]`，用于不在 PATH 里的工具；
  `path` 不执行、`version` 手填，自动探测跳过同名命令；
- 自动刷新不得覆盖 `authored`；同名渲染时 `authored` 优先并标 `[authored]`；
- 记录 `path`、`version`、`source`（`auto`/`authored`），不落 Vault；
- 工具链路径用于换设备提示和排障，不自动改 PATH、不自动执行安装；
- 采集命令、超时、并发上限应在配置里可调，默认保守；
- Windows 上 workspace 包含临时目录时，ACL restricted-token runner 可能拒绝启动；
  此时只对固定白名单的版本/路径查询命令按错误提示降级为 `danger-full-access`
  重试一次，仍不执行自定义路径或安装命令。
- Agent 工具 `toolchain_manage`（后备名 `dscs_toolchain`）：`list` 查看探测结果，
  `add` 登记用户让它下载/安装的工具，`remove` 删除登记，`set-commands` 改自动探测命令；
  只写本机配置，不执行 `path`，不代替 shell 安装。

## 9. UI 形态

设置页新增（或拆子页）：

- **本机环境**：展示工具链探测结果（名称、版本、路径、`auto`/`authored`），
  可配置自动探测命令和自定义工具链；自定义路径只展示、不执行；保存后重新探测生效；
- **远端工作区**：本机↔远端配对表，显示本机工作区、关系（已绑定/本机身份/仅本机/待映射）、远端 label 与未映射会话数；待映射行选择本机工作区后二次确认；已绑定项只读；
- **设备台账**：设备列表、最后在线、DSH/插件摘要（本机工具链不在台账里）；
- **跨设备插件**：表格形式，行是插件，列是本机/其他设备/registry 最新；版本显示为卡片，可拖到本机列，点设备列头全部采用该设备版本；顶部「应用变更」「清空暂存」；有变更的行用琥珀色，不可执行用红色；
- **笔记**：挂在会话右侧栏的 tab（并注册 right sidebar guide 卡片），按当前会话自动定位 session/workspace；顶部三个 scope 分段 `本会话 / 本工作区 / 全局`，加“仅本机 / 同步”开关；列表显示 title/summary、作者、设备、pinned，详情显示全文与 thread 时间线；编辑=同 thread 追加，删除仅用户可做；`全局 + 同步` 只允许用户新建。

当前设置页已有连接、凭据、上传范围、工作区映射、跨设备插件、同步行为、本机环境与性能面板
（`client/index.js`）；设备台账面板仍属于后续设计；笔记面板挂在会话右侧栏。

首启和设置页都可以设置工作区映射：

- 首启选完同步工作区后，展示可用的远端工作区映射步骤；可跳过，稍后在设置页处理；
- 设置页有常驻的「远端工作区」入口，可首次建立绑定；已建立的绑定不再提供改绑；
- 同路径由「本机身份」自动处理，不生成绑定；手动映射只在待映射行选择本机工作区，确认后不可改绑；
- 没有匹配的远端工作区进入“待映射”，不阻止其他会话同步；
- 「只推送」= 不建立任何映射，而不是把路径留空。

## 10. 兼容性（0.x 不做迁移）

- 插件已发布 0.1.4，但仍不考虑 0.x 历史数据迁移；没有旧客户端或旧 manifest 的兼容层；
- 不保留旧 manifest 的 cwd 兼容层或迁移提示；
- V2 开发数据可以清空重拉；
- 仍保留 Vault 记录 schema / `workspaceKey` 的**协议版本字段**，用于后续正常演进，
  这不是迁移负担；
- Vault 记录/协议版本独立，失败时不影响会话同步。

## 11. 里程碑建议

| 阶段 | 内容 | 验收 |
|---|---|---|
| V0 | Vault 密钥域、记录信封、加密/链测试 | 篡改/重放/跨设备挪记录被拒 |
| V1 | Vault 服务端 append/cursor + 最小设备台账 + `workspace/profile` | 两台设备各自写 stream，互不覆盖 |
| V2 | `workspaceKey` manifest 扩展 + 一次性绑定 + 未映射阻断 | 多工作区各自落地；未映射不 apply；绑定不可改 |
| V3 | 设备级插件快照 + 插件版本检测 + 一键匹配 | 精确 spec、用户确认、失败可回退（已实现；降级/移除手工） |
| V4 | 工具链采集 + L3 笔记 + 压缩/保留策略 | 自动不覆盖 authored；笔记只追加（工具链与笔记首版已实现；保留暂缓） |

V2 已完成工作区落点替换，不需要迁移分支。

> V3 已完成（2026-11-19）：设备级 `plugins` 快照、Vault 对端读取、跨设备版本矩阵、
> registry 最新版本/图标、安装与升级；降级/移除仍只给手工命令，不做 session producer。

> V0 已完成（2026-10-22）：`shared/vault.ts` 的 vaultKey/workspaceKey 派生、确定性
> AES-GCM 封帧、AAD、recordHash、链校验与 5 组篡改/重放测试。
> V2 已完成：会话 manifest 的 `workspaceKey`、根 key/子代理继承、一次性本机绑定、
> 未映射 `unmapped` 阻断、设置页映射入口。
> V2.1 已完成：本地根会话级白名单（默认不选、新会话不自动加入、子代理继承）、
> `workspace/profile` label 读取与映射 UI、映射候选为本机全部注册工作区、
> 未映射会话持久化、本地 key 自动解析、映射二次确认；映射后由下一轮扫描自动补拉。
> 2026-10-22 记录的是 133 个测试通过；当前仓库有 121 个插件用例与 26 个服务端用例
> （按 `test(` 计数），本轮未运行。

## 12. 已定

1. **路径规范化**：优先使用 DSH workspace 的 canonical path（`Workspace.path` / `realpath`）；
   没有 workspace 记录时才退回绝对路径归一化。这样同一工作区的符号链接别名不会被拆成
   两个 key，也与 `attachSession()` 的 cwd/workspace 校验一致；
2. **远端工作区可读名**：由 `workspace/profile` 记录承载，label 在加密载荷里同步，UI 解密后显示；默认不显示完整路径；
3. **绑定共享**：绑定是每设备自己的；其他设备的绑定不参与同步，也不自动采用；
4. **一次性绑定**：首次确认后不改绑；不实现工作区/会话迁移，也不改写已有会话 header cwd；
5. **插件版本**：默认“检测差异 + 一键切换精确版本”；自动匹配作为后续显式开关；
6. **Vault 保留**：V0 先保留全量；压缩/归档等体量上来后按实际阈值再做，不进入首版；
7. **工具链采集**：默认保守白名单 + 超时 + 不拼 shell；具体命令集在实现时定；
8. **同路径**：作为「本机身份」自动对应，不需要绑定，也不允许改绑到其它路径。

## 13. 与当前 M4 的关系

- 2026-10-22 起先做 Vault V0 → V1 → V2；M4 的 C5/D5/E3 顺延；
- V2 已删除单一 `workspacePath`，不保留兼容文案或迁移路径；
- 本设计的 Vault 失败不阻塞会话同步；
- 会话内部的 cwd 处理见 [CWD.md](../architecture/CWD.md)（raw 事件 + 接收端修正）。
