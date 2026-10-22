# 加密附加数据层（Vault）与工作区映射

> 状态：**V0 已完成，V1 待实现**（2026-10-22）。
> 本文件承接 [DESIGN.md](DESIGN.md) 的 L2 设备台账 / L3 agent 笔记，并替换 M4 的单一
> `workspacePath` 落点方案。M4 的会话同步协议不变；Vault 是独立、可增量演进的旁路存储。
> 会话内部的 cwd 处理另见 [CWD.md](CWD.md)（raw 事件 + 接收端修正，不承诺跨平台 resume）；
> 会话身份与启动对账流程见 [RECONCILE.md](RECONCILE.md)，术语见 [GLOSSARY.md](GLOSSARY.md)。
> 使用协议见 [USAGE-AGREEMENT.md](USAGE-AGREEMENT.md)：只改 DSH 必需的 cwd 元数据，
> 不改消息与工具调用。

## 1. 范围

Vault 负责同步**会话事件之外**的加密数据：

- L2 设备台账：OS、DSH 版本与 profile、已加载插件与版本、会话格式版本、工具链版本与路径、
  `DSH_HOME`、工作区、最后在线；
- 工作区身份与「远端工作区 → 本地工作区」绑定；
- L3 agent 笔记（append-only）；
- 会话生产者的插件/版本戳，用于跨设备兼容性提示和「一键匹配版本」。

不做：

- 会话事件本身（仍走现有 manifest + 批次 + 租约）；
- 工作区项目文件、附件正文（附件仍走会话同步的 blob 路径）；
- 服务端读取明文。Vault 默认全量 E2E，服务端只做 append 校验、存储与 cursor。

### 已接受的决策

1. **Vault 粒度**：V0/V1 一台服务端实例 = 一个 Vault；公益服的多租户/Vault 路由另开 package 或仓库，只共享插件对接所需的协议边界；
2. **设备与 writer**：一个 DSH profile/安装实例 = 一个 device token = 一条 writer stream；`device/profile` 保留 profile 字段，但 stream 按 deviceId 隔离；同一 token 被多个进程并发使用视为配置错误；
3. **工作区身份**：远端 workspace 的正式可读名由 `workspace/profile` 记录承载；`workspace/bind` 只表示本机 `workspaceKey → localPath` 绑定；
4. **不改绑**：首次绑定后不提供 workspace/session 迁移或改绑；DSH 本身也不支持工作区/会话迁移，强行走文件搬运破坏性太大；
5. **子代理继承**：子代理跟随根会话的 key；子代理 manifest 不重复 key，拉取前先读根 manifest；
6. **未映射行为**：不 apply、不猜落点，标 `unmapped` 等用户选择；
7. **工具链**：沿用 L2 的 `auto` / `authored` 双源，自动采集不覆盖人工/agent 维护。

### V0/V1 范围

- **V0**：只做本地密钥域、记录信封、AES-GCM/AAD、记录链与篡改/重放测试；不接服务端。
- **V1**：服务端 `/v1/vault/append|cursor|stream`、最小设备台账、`workspace/profile` 同步；不做工作区落点改变。
- **V2**：会话 manifest 增加 `workspaceKey`、本机绑定、未映射阻断和映射 UI。
- V3 工具链/版本匹配、V4 笔记/保留策略不在 V1 范围内。

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
  seq 1: device/profile
  seq 2: workspace/profile
  seq 3: workspace/bind
  seq 4: session/producer
  seq 5: note/append
  ...
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
  "deviceName": "X2411",
  "os": { "platform": "win32", "arch": "x64", "release": "10.0.26100" },
  "dsh": {
    "version": "0.2.1-rc.2",
    "source": "global-package-json",
    "profile": "web",
    "node": "v24.20.0",
    "sessionFormatVersion": 4
  },
  "plugins": [
    { "id": "session-cloudsync", "name": "dsh-session-cloudsync", "version": "0.0.0",
      "disabled": false, "state": "active", "source": "loaded" }
  ],
  "toolchain": {
    "auto": [
      { "name": "pnpm", "version": "12.4.1", "path": "C:\\…\\pnpm.exe",
        "source": "spawn", "at": 1790000000000 }
    ],
    "authored": [
      { "name": "uv", "version": "0.5.2", "path": "D:\\tools\\uv.exe",
        "source": "agent", "sessionId": "session-…", "at": 1790000000000,
        "note": "用 winget 装到 D:\\tools" }
    ]
  },
  "workspaces": [
    { "key": "opaque-key", "path": "D:\\work\\project", "exists": true }
  ],
  "dshHome": "C:\\Users\\…\\.dsh",
  "lastSeenAt": 1790000000000
}
```

约束：

- **版本来源要标**：`ctx.loader.entries()` = 加载了什么；`package.json` = 装了什么；
  `spawn` = 实际工具链是什么。三者可能不一致，不能合并成一个“版本”；
- 工具链分 `auto` / `authored` 两源，自动采集只刷新 `auto`；同名渲染时 `authored` 优先；
- 台账写插件自己的目录（如 `<DSH_HOME>/session-cloudsync/vault/ledger/<deviceId>.json`），
  随 Vault 上行；本地可渲染人类可读的 `DEVICES.md`；
- `device/profile` 只在内容 digest 变化时 append；`lastSeenAt` 最多每小时更新一次，不能每次同步都写一条；
- 工具链自动采集只在启动或手动刷新时执行，不能每轮同步都跑；
- agent 写入走工具白名单字段，不允许改 `deviceId`/`dshHome` 这类身份字段；
- 不采集用户名、环境变量值、密钥路径、token；
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
- `workspace/profile` 只负责“远端工作区是什么”，`workspace/bind` 只负责“本机把它放到哪里”，两者不能混用。

绑定记录：

```jsonc
{
  "schema": "dsh-session-cloudsync/vault/1",
  "kind": "workspace/bind",
  "entity": "opaque-key",
  "data": {
    "key": "opaque-key",          // 远端/逻辑工作区 key
    "pathKey": "derived-key",     // 本机路径派生的 key，可用于反向索引
    "localPath": "D:\\work\\project",
    "label": "project",
    "mode": "manual",             // manual | auto-suggested
    "updatedAt": 1790000000000
  }
}
```

- 绑定是**每台设备自己的**；A 的绑定不会自动改 B 的路径；
- 其他设备的绑定可以作为建议展示，但不能静默采用；
- 同一 `localPath` 可以接收多个远端工作区（UI 警告可能混放），但只能有一个绑定作为
  该路径的**推送身份**（否则从该路径上传的会话归属不确定）；
- 同一远端 key 只能绑定一个本地路径；**首次绑定后不提供改绑或工作区迁移**；
  DSH 本身也不支持工作区/会话迁移，强行走文件搬运破坏性太大；
- 当 `key !== pathKey` 时，这是**别名绑定**：本机以后从该 `localPath` 推送会话时，
  应使用绑定的 `key`，而不是本机派生的 `pathKey`，这样两台设备的会话才会汇入同一个
  remote workspace；
- 推送时先按 `localPath` 查绑定：有绑定用 `binding.key`，无绑定用 `pathKey`；
- UI 必须阻止为同一 `localPath` 建立两个“推送身份”的绑定。

会话 manifest 增加可选的明文 `workspaceKey`（opaque，不含路径）；子代理继承根会话的 key。
未发布阶段只支持带 key 的新 manifest；缺失 key 直接视为 `unmapped`，不猜落点。

### 3.5 写者租约

租约统一为**资源写锁**，不再只按会话：

```text
resource = session:<sessionId>
         | vault-writer:<writer/deviceId>
owner    = (deviceId, clientInstanceId)
TTL      = 60s
```

- `clientInstanceId` 每次 DSH 进程启动时随机生成，不持久化；通过 `X-Client-Id` 随 lease/append 请求发送；
- 同一 `(deviceId, clientInstanceId)` 的再次 acquire 视为续租，顺延 TTL；
- 不同 client 在过期前 acquire 同一资源返回 `409 lease-held`；
- append 必须同时匹配 token 派生的 deviceId、租约里的 deviceId 和 clientInstanceId；
- release 只允许当前 owner；进程崩溃由 TTL 释放；
- 读操作（manifest/cursor/stream）不加租约；
- 不同 session、不同 device writer 之间不互斥；
- V0/V1 先不做租约续租接口；单次 append 远小于 60 秒，后续确有长写入再加；
- 服务端租约是权威，本地再加 `$DSH_HOME/session-cloudsync/vault/writer.lock`
  （`{pid, clientInstanceId, acquiredAt}`）做快速失败；启动时 PID 已死则清掉 stale lock。

这条规则同时修掉现有会话租约的漏洞：同一 token 的两个进程此前都能 acquire 同一把
session lease；加入 clientInstanceId 后，第二个进程会被前端拿到 `lease-held`。

Vault 写入流程：

1. acquire `vault-writer:<deviceId>`；
2. 读取当前 stream head；
3. 生成 record（seq / prevHash）；
4. append；
5. release。

租约冲突只影响 Vault，不阻塞会话同步；会话租约冲突也不阻塞 Vault。

append 幂等规则：同一 `writer/seq/prevHash/blobSha256` 的重试返回已有记录，不生成
第二条同 seq 记录；租约已释放也允许幂等重放。

### 3.6 L3 agent 笔记

`kind: "note/append"`，只追加：

```jsonc
{
  "id": "note-…",
  "at": 1790000000000,
  "deviceId": "…",
  "sessionId": "session-…",   // 可选
  "workspaceKey": "opaque-key", // 可选；缺省 = 全局
  "authorKind": "agent",      // agent | user
  "tags": ["environment", "pnpm"],
  "text": "…",
  "supersedes": "note-…"       // 可选
}
```

- 没有编辑语义；修改用 `supersedes` 追加；
- 单条 ≤ 8 KB，每用户 ≤ 20 MB，单工作区默认 200 条；
- agent/用户可写，服务端永不写；
- 默认不注入模型上下文，换设备时只取该工作区 1–3 条摘要。

## 4. 密钥与加密

```text
masterKey ──HKDF("dsh-sync/vault/v1")──▶ vaultKey
vaultKey  ──HMAC("workspace|"+path)────▶ workspaceKey
```

- 每个 Vault 记录单独封帧，AAD 至少绑定 `writer + seq + prevHash + schema`；
  防止把记录挪到另一台设备/另一个 seq；
- `keyId` 随记录保存，支持未来口令轮换；
- 服务端没有 vaultKey，无法读设备台账、工具链、路径或笔记；
- 服务端仍能观察写入频率、大小、设备在线时间，这是本设计的隐私边界。

## 5. 工作区映射与拉取

### 5.1 拉取决策

```text
session manifest
  └─ workspaceKey ──▶ 查本机 workspace/bind ──▶ 有：落到 localPath
                                          └─ 无：unmapped，不 apply
```

- 不走任何“旧路径 fallback”；没有 key 或没有映射都标 `unmapped`；
- **绝不**把未映射的远端会话塞进第一个工作区；
- 状态/气泡显示 `unmapped` 数量和原因；
- 用户完成映射后，下一轮自动 apply；子代理跟随根会话（子代理 manifest 不重复 key，
  闭包内找不到根 key 时同样标 `unmapped`）；
- 映射目标必须在本次同步允许的工作区白名单内。

### 5.2 同路径自动建议

本机对每个已选工作区算 `pathKey`，与远端 key 比较：

- 完全匹配：在映射 UI 中预选，默认仍需用户确认；
- 用户可打开「同路径自动绑定」；打开后匹配即绑定，不再逐次询问；自动绑定同样是**一次性**的，之后不可改绑；
- 不同路径：展示远端 `workspace/profile` 的 label/会话样例，让用户选本地落点；
- 选择不同路径后建立别名绑定，之后本机从该路径推送时复用远端 key。

### 5.3 会话级例外

首版不提供 `sessionId → localPath` 覆盖表：

- 工作区绑定是一次性的，DSH 也不支持会话迁移；
- 个别会话换落点只能通过明确的破坏性删除/重建，不进入 V2；
- 子代理跟随根会话，不单独覆盖。

### 5.4 M4 开发期的 `workspacePath`

- 当前 M4 的 `workspacePath` 只是**未发布版本的临时代码**，不是需要保留的兼容协议；
- V2 直接替换为工作区绑定；不迁移旧配置、不保留旧 manifest fallback；
- 开发数据可以清空重拉；不为此写升级路径。

### 5.5 已绑定后不改绑

- 同一 `workspaceKey` 的绑定一旦确认，UI 不再提供改绑入口；
- 同一 `localPath` 的推送身份也不能改；
- 错误映射的恢复方式是显式重置本地同步状态并重新拉取，属于破坏性操作，不在自动流程里；
- 不实现工作区/会话文件迁移，也不改写已有会话 header cwd。

## 6. Vault 协议（提议）

复用现有 `/v1/blobs?kind=vault` 上传密文，然后：

```text
POST   /v1/vault/lease
DELETE /v1/vault/lease
POST   /v1/vault/append
GET    /v1/vault/cursor?since=<revision>
GET    /v1/vault/stream/:writer?from=<seq>&limit=<n>
```

`POST/DELETE /v1/vault/lease` 需要 `X-Client-Id`；资源固定为
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
- 服务端升级是增量的；插件未发布，不需要为旧客户端保留 Vault 兼容分支。

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

## 7. 插件版本匹配与一键切换

### 7.1 版本来源

- 设备台账记录**加载中**（loader entries）、**已安装**（package.json）、**实际**（spawn/version）
  三种来源；
- 会话额外记录 `kind:"session/producer"` 的版本戳：
  - DSH 版本、sessionFormatVersion；
  - 插件 `{name, version, source}`；
  - agent preset；
- 放 Vault 而不是 session header：不改变会话链，历史会话也能补记录。

### 7.2 检测与提示

拉取/打开远端会话时比较：

- sessionFormatVersion 不同：**阻断**，提示先升级/降级 DSH；
- DSH 版本不同：警告，说明可能读到未知事件；
- 插件版本不同：列出 `当前 → 远端`；
- 缺少插件：列出需安装项。

### 7.3 一键匹配

- UI 提供「匹配插件版本」按钮，逐项展示将执行的精确 spec（`pkg@version`）；
- 用户确认后，宿主调用 `pluginManager` 的安装/移除接口；**不能静默执行**；
- 安装顺序、build script 审批、版本豁免、DSH 引擎不兼容都沿用 Plugins 页现有规则；
- 当前 DSH 的 `pluginManager.installBundle` 接受精确 `pkg@version`，已安装包会先移除/替换；
  我们的编排是**一次一个包**，逐项汇报进度，不另造一套安装器；
- 切换是 profile 级操作，会影响该 profile 所有会话；UI 必须写明；
- 安装可能需要重启/HMR，结果按包逐个汇报；
- 不自动切换 DSH 本体，只提示兼容版本。

### 7.4 “自动”的边界

自动只做**检测、预选、排序**：

- 自动填好建议版本；
- 自动标记“可直接匹配”的包；
- 用户点一次执行；
- 默认不自动安装、不自动降级、不自动批准 build script；后续若要自动，必须是显式开关 + 白名单。

## 8. 工具链识别

沿用既有 L2 设计：

- `auto`：按配置的允许列表采集（node、npm、pnpm、git、python、uv 等），
  只执行带超时的 `--version` / `which` 类调用，不拼 shell，不读环境变量值；
- `authored`：agent/用户通过工具维护，可带 `sessionId`、note、来源；
- 自动刷新不得覆盖 `authored`；同名渲染时 `authored` 优先并标来源；
- 记录 `path`、`version`、`source`、`at`；
- 工具链路径用于换设备提示和排障，不自动改 PATH、不自动执行安装；
- 采集命令、超时、并发上限应在配置里可调，默认保守。

## 9. UI 形态

设置页新增（或拆子页）：

- **远端工作区**：列表显示 `workspace/profile` 的 label、会话数、映射状态；未映射项高亮；
  本地工作区下拉；「同路径自动绑定」开关；已绑定项只读；
- **设备台账**：设备列表、最后在线、DSH/插件/工具链摘要；
- **版本匹配**：差异列表 + 「匹配插件版本」；
- **笔记**：按工作区/设备分组，agent 写入入口在后续里程碑。

首启和设置页都可以设置工作区映射：

- 首启选完同步工作区后，展示可用的远端工作区映射步骤；可跳过，稍后在设置页处理；
- 设置页有常驻的「远端工作区」入口，可首次建立绑定；已建立的绑定不再提供改绑；
- 同路径匹配可以预选，默认需确认后才绑定；用户可在设置页开启自动绑定，自动绑定同样不可改；
- 没有匹配的远端工作区进入“待映射”，不阻止其他会话同步；
- 「只推送」= 不建立任何映射，而不是把路径留空。

## 10. 兼容性（未发布，无需迁移）

- 插件尚未公开发布，没有已发布的历史数据、旧客户端或旧 manifest 需要兼容；
- 不保留 `workspacePath` fallback、旧 manifest 的 cwd 兼容层或迁移提示；
- 当前 M4 的实现是开发期行为，可以在 V2 直接替换；开发数据可清空重拉；
- 仍保留 Vault 记录 schema / `workspaceKey` 的**协议版本字段**，用于发布后的正常演进，
  这不是迁移负担；
- Vault 记录/协议版本独立，失败时不影响会话同步。

## 11. 里程碑建议

| 阶段 | 内容 | 验收 |
|---|---|---|
| V0 | Vault 密钥域、记录信封、加密/链测试 | 篡改/重放/跨设备挪记录被拒 |
| V1 | Vault 服务端 append/cursor + 最小设备台账 + `workspace/profile` | 两台设备各自写 stream，互不覆盖 |
| V2 | `workspaceKey` manifest 扩展 + 一次性绑定 + 未映射阻断 | 多工作区各自落地；未映射不 apply；绑定不可改 |
| V3 | 会话生产者戳 + 插件版本检测 + 一键匹配 | 精确 spec、用户确认、失败可回退 |
| V4 | 工具链采集 + L3 笔记 + 压缩/保留策略 | 自动不覆盖 authored；笔记只追加 |

V0–V2 期间可直接替换 M4 的 `workspacePath`，不需要迁移分支。

> V0 已完成（2026-10-22）：`shared/vault.ts` 的 vaultKey/workspaceKey 派生、确定性
> AES-GCM 封帧、AAD、recordHash、链校验与 5 组篡改/重放测试；当前共享测试 126 通过。
> V1 从服务端 append/cursor 与最小设备台账开始。

## 12. 已定

1. **路径规范化**：优先使用 DSH workspace 的 canonical path（`Workspace.path` / `realpath`）；
   没有 workspace 记录时才退回绝对路径归一化。这样同一工作区的符号链接别名不会被拆成
   两个 key，也与 `attachSession()` 的 cwd/workspace 校验一致；
2. **远端工作区可读名**：由 `workspace/profile` 记录承载，label 在加密载荷里同步，UI 解密后显示；默认不显示完整路径；
3. **绑定共享**：绑定是每设备自己的；其他设备的绑定只作为 UI 建议，不自动采用；
4. **一次性绑定**：首次确认后不改绑；不实现工作区/会话迁移，也不改写已有会话 header cwd；
5. **插件版本**：默认“检测差异 + 一键切换精确版本”；自动匹配作为后续显式开关；
6. **Vault 保留**：V0 先保留全量；压缩/归档等体量上来后按实际阈值再做，不进入首版；
7. **工具链采集**：默认保守白名单 + 超时 + 不拼 shell；具体命令集在实现时定；
8. **同路径自动绑定**：默认只做同路径**预选**，首次仍需用户确认；用户可在设置页显式开启
   “同路径自动绑定”，开启后匹配即绑定，同样不可改。

## 13. 与当前 M4 的关系

- 2026-10-22 起先做 Vault V0 → V1 → V2；M4 的 C5/D5/E3 顺延；
- M4 的 `workspacePath` 是开发期单落点实现，V2 直接替换，不保留兼容文案或迁移路径；
- 本设计的 Vault 失败不阻塞会话同步；V2 未完成前，单一 `workspacePath` 仍是过渡行为；
- 会话内部的 cwd 处理见 [CWD.md](CWD.md)（raw 事件 + 接收端修正）。
