# 设计

> 状态（2026-11-10）：服务端 0.1.2、插件 0.1.4。服务端 v2-only / protocol 3；插件走 v2、批量 blob 与 zstd；
> 事件批次传输、客户端防护（composer block / 行标记 / 同步气泡 / 底部会话状态条）与 Vault V0–V2.1 均已实现。
> L2/L3 的加密附加数据层与多工作区映射见 [VAULT.md](../sync/VAULT.md)。
> cwd 处理见 [CWD.md](CWD.md)；会话身份与启动对账见 [RECONCILE.md](../sync/RECONCILE.md)；
> 最终决策过程见 [DECISIONS.md](../plans/DECISIONS.md)；术语见 [GLOSSARY.md](../guides/GLOSSARY.md)。

## 目标

把 DSH 的会话数据在自有服务端上做**多设备同步**，默认端到端加密；服务端只保存不透明密文与元数据。

## 数据分三层

| 层 | 内容 | 体量量级 | 冲突性 |
|---|---|---|---|
| L1 会话数据 | 只同步会话事件：`sessions/**` 的事件（每会话只取最高格式代际）→ 封好的 header + 事件批次链。**未实现**：附件（`attachments/v1/**`）、`storages/workspace.json`、`profiles/*/cordis.patch.yml` + `package.json` 都不同步 | 百 MB 级（取决于历史） | 会话要全局写租约 |
| L2 设备台账 | 每设备一条 `device/profile`：设备名、OS、DSH 版本与 profile、Node、会话格式版本、`DSH_HOME`、工作区列表、最后在线；另有每工作区一条 `workspace/profile`。**未实现**：已加载插件清单、工具链版本/路径 | KB 级 | 按 deviceId 分槽，天然无冲突 |
| L3 agent 笔记 | append-only 笔记：设备/会话/工作区/时间/作者/标签 | KB–MB 级 | 只追加，天然无冲突；**未实现**（VAULT.md 的 V4） |

实际写入的台账字段见 `packages/plugin/src/vault-sync.ts:121-146`（`device/profile`、`workspace/profile`）。
代际闸门不在台账上：同步前按会话比较远端 manifest/header 与本地 header 的 `createdAt`/`formatVersion`，
不一致就标 blocked（`packages/plugin/src/sync-plan.ts:234-250`、`engine.ts:1094`）。
工具链的 `auto`/`authored` 双源属于 VAULT.md 的 V3，本仓库没有实现。
L2 的加密存储、工作区 key 与绑定见 [VAULT.md](../sync/VAULT.md)。

## 传输单位：事件批次

DSH 公开的持久化接口是**事件级**的：`SessionHandle.read()` 返回校验过的事件数组，`append(events)` 由 DSH 自己编码落盘；没有读取或追加原始帧字节的入口。物理帧边界（zstd 帧、压缩参数、`compression: 'none'` 的纯文本行）属于存储实现，不能作为同步契约。

因此同步单位是**连续事件批次**：

- 一批 = `[seqFrom, seqTo]` 的连续事件，由写入方在同步时封口，默认上限 **50 个事件或 256 KiB**（可调）；
- 批次上传后**不可变**（唯一例外是链上最后一帧：DSH 崩溃恢复可能重写尾批，服务端允许"替换最后一帧"）；
  新事件只能进新批次；
- 链身份 = 批次规范 JSON（键序稳定）的 sha256；服务端去重 = 封装后密文的 sha256；
- 拉取方**不重新切批**：以服务端 manifest 的批次范围为准，逐批比较哈希。

### 为什么不用帧

一条 160 KB 的 v4 日志实测有 **125 帧、261 个事件**（约 2.1 事件/帧，单帧 82 B–14 KB）。帧级方案的问题：

- 帧边界由 DSH 的落盘策略决定，不是稳定契约；`compression: 'none'` 时甚至没有帧；
- header 帧含 `cwd`；若各设备用本地路径，header 帧哈希不同，两台设备的链从第 0 帧就分叉；
- 一帧可能含多个事件，按帧截断/删除会连带丢掉同帧的好事件；
- 直接读写文件会绕过 DSH 的校验、锁与可见性。

事件级把 header 单独封成链上的第 0 个条目（不含 `cwd`），事件批次从下标 1 开始；同一会话 id 不变，事件里的 `sessionId` 引用自然成立。

### 批次对齐与部分重叠

- **第一个推送者定义边界**；manifest 中的 `[seqFrom, seqTo]` 是权威，其他设备只按它验证/补齐；
- 本地已有完整前缀批次：只算哈希，不下载；
- 批次跨过本地末尾：下载该批，校验重叠段与本地一致，只追加缺的后半段；
- 例：A 到 150、B 在 65 时是副本；A 先推 `B0 0..49`、`B1 50..99`、`B2 100..149`。B 校验 `B0`，下载 `B1` 校验 `50..64` 后追加 `65..99`，再下载 `B2`。最坏浪费 ≤ 一个批次；
- 若 B 先推，边界是 `0..49`、`50..64`；A 之后追加 `65..114`、`115..149`，B 无重叠；
- 复制点落在哪不影响正确性，只影响首次多下载多少（≤ 一个批次）。

### 两种哈希

- **链身份**用批次规范 JSON 的 sha256（比对/分叉判定）；
- **服务端去重**用封装后密文的 sha256（服务端只看到密文，按存储字节寻址）。

manifest 同时记录两种标识：明文 `chainHash` 与密文 `blobSha256`。

## 一轮同步：任务模式

一轮同步不是"先全推再全拉"，而是**先 scan 出任务表，再逐任务跑单一方向**（`packages/plugin/src/controller.ts:846-897`）：

- 自动模式：规划后直接建 `queued` 任务，scan 阶段只做计数；
- 手动模式：先把全部选中会话列成 `checking`，边校验边推进 `scan.checked/total`，校验完再一次性移除 up-to-date 行
  （`packages/plugin/src/index.ts:1250-1275`）；
- scan resolve 后才进入 `transferring`，执行器按任务表逐条 push 或 pull；单会话定向同步也复用同一执行器
  （`controller.ts:716`、`index.ts:1136-1153`）。
- 1 个会话在一轮里只有一个方向（`SyncTaskView.direction`），不是"同一会话先推后拉"。

## 并发：全局单写者租约

DSH 的单写者锁只在一台机器内生效，跨机器不拦。服务端只有一把**全局**写租约（资源名 `sync`，TTL 60 秒，
owner 为 `(deviceId, clientId)`）：只有持有者才能创建/append/删会话，其他设备或进程申请时收到 `409 lease-held`
（`packages/server/src/leases.ts:13-16,53-106`）。拉取（manifest/summary/changes/batches/blob 读取）不需要租约。

**分叉不自动合并**：`seq`/`surfaceOp`/`sourceEventSeqs` 是格式拥有的关系，重排它们会产出 DSH 读不了的日志。分叉时保留双方，供人工取回。

## 拉取后如何生效

优先走 DSH 原生接缝——`ctx.sessionPersistence.create` / `open(id, 'write')` + `append(events)` 写入，`ctx.workspaceRegistry.resolveByPath` + `Workspace.attachSession` 挂回工作区，避免重启宿主。M0 已验证写入后宿主能发现新会话；**客户端插件**在同步轮结束后（以及回填状态变化时）调用 `ctx.sessions.refresh()`（`packages/plugin/client/index.js:3737`），让已打开的窗口重新拉 `session/list`，更新冷会话、标题和工作区分组，不需要用户手动刷新页面。新拉取的冷会话还会先用 `sessionProjectionCache.coldSnapshot` 预热 title 投影再 attach（`packages/plugin/src/index.ts:802-821`）。

会话头（`formatVersion`/`createdAt`/`isSeeded`/`delegationDepth`/`agentPreset`，可选的 `parentSession`/`origin`，以及 seeded 会话的 `inheritedEventCount`，见 `packages/shared/src/batches.ts:30-47`）单独封成链上下标 0 的 **sealed header**，manifest 只记哈希；`cwd` 不进入 manifest 明文。拉取端按 `workspaceKey` 的工作区绑定决定落到哪个本地工作区；绑定/映射的加密存储见 [VAULT.md](../sync/VAULT.md)。这样同一会话在不同设备上的链身份不受本地路径影响。

开放尾（`tailOpen`/`safeThroughSeq`）、拉取崩溃恢复（apply journal / 启动 reconcile）与客户端防误操作（composer block / 列表拦截）见 [SYNC-SAFETY.md](../sync/SYNC-SAFETY.md)。

## 删除、修复与分叉

会话日志是 append-only，同步协议**没有删除单个事件**的语义：

- **未同步的脏尾**：不上传即可；本地若要彻底干净，用独立的维护操作（备份 → 只保留干净前缀 → 校验 → 原子替换），或走 DSH 的 fork；
- **已同步的脏内容**：不能原地删除；用 **fork 新会话 + 墓碑旧会话**，让两端转向新会话；
- 帧级“复制前缀帧覆盖原文件”是历史方案（未实现），也只适用于脏内容恰好占满尾帧的情况；一帧可能含多个事件，按帧截断会连带丢掉好事件；
- 已实现的维护脚本是"远端覆盖本地"：`POST /api/session-cloudsync/replace` 生成停机脚本，备份本地会话后删除，
  重启 DSH 再全量重拉（`packages/plugin/src/replace.ts:1-84`）；它不做帧级覆盖；
- 修复/导出属于独立维护功能，不参与正常同步链，避免把“可删除”语义带进 append-only 协议。

## 换设备与设备标记（历史设计，未实现）

早期设计是：在会话日志里写一条 `plugin:dsh-session-cloudsync/device` 记录（`ignorable`），用 Session projection
折叠出"最后设备"，判定换设备时在 `agent/pre-step` 追加 `<system-reminder>` 提醒模型。

**当前代码里没有这条链路**：插件不写 device 记录、不折叠最后设备、也不注入 system-reminder；
`agent/pre-step` 现在只用于拒绝已标记分叉的会话（`packages/plugin/src/index.ts:776-795`）。
要恢复换设备提示，需要作为独立功能重新设计。

## 加密

默认端到端：口令经 scrypt（N=2^15, r=8, p=1）派生主密钥，经 HKDF 按会话/批次派生密钥，AES-256-GCM 封装每个事件批次
（`packages/shared/src/crypto.ts:24`、`packages/shared/src/sealed-frame.ts:104-141`）。服务端只知道设备、加密后的批次、大小与时间。
"允许服务器解密"（上传包裹后的主密钥）**未实现**：服务端没有任何 keybox 或解密路径，只有 `none/zstd` 封帧。

封装的字节布局、密钥层次、AAD 与版本规则见 [SEALED-FRAME.md](SEALED-FRAME.md)（v1/v2 均已实现，事件批次与封好的会话头都用它封装）。

## 服务器形态

本期只做**个人自部署**：单租户、无账号/邮箱，认证是 setup token + 每设备 token。为将来可能的公共部署只保留两个薄接缝：存储的 `dataset` 字段、token 表的 `label`。

## 网页管理台（首版）

自部署服务附带管理台：浏览器用**管理密码**登录（`POST /admin/login`），换取 **HttpOnly、SameSite=Strict** 的 cookie 会话（12 小时）；
设备 API 仍用 bearer token，两套认证互不复用。管理台不依赖服务器解密（也没有该能力），首版只做元数据管理：

- 设备：签发 / 吊销 / 最后在线（`GET/POST /admin/devices`、`DELETE /admin/devices/:id`）；
- 存储：总用量、配额（默认 10 GiB，`--max-bytes` 可配，管理台可在 16 MiB–1 TiB 内改）；
- 会话：id、格式代际、批次数、`lastSeq`、最后更新、`workspaceKey`、墓碑（`deletedAt`）；不显示租约持有者；
- 系统：版本、协议版本、revision、设备数、会话数与已删除数、已用/配额字节（`GET /admin/overview`）。

会话内容预览（网页读消息/工具/推理）是 **P2**，依赖"允许服务器解密"这一能力——**当前未实现**（服务端没有 keybox 或解密路径）。
若将来实现：开启后服务端能解**所有历史批次内容**；删除 keybox 不等于收回历史，必须轮换密钥，UI 必须明确警告。

同步 API（`/v2/*`，设备 token）与管理台 API（`/admin/*`，cookie 会话）分开，互不复用认证。

## 首次启动与初始化

服务端首次启动（尚未设置管理密码）时，在控制台打印一次性初始化密钥，并提示打开 `/admin`；浏览器跳到 `/setup` 向导：

1. 输入初始化密钥（8 位、形如 `ABCD-EFGH`、10 分钟有效；未完成初始化时每次启动重新生成，`/setup/complete` 后删除）；
2. 设置管理密码（≥6 位，字母/数字/特殊字符至少两类；scrypt 加盐哈希，不存明文）；
3. 设置存储配额（默认 10 GiB，之后可在管理台修改）；
4. 可选创建第一台设备（token 只显示一次，可跳过）。

完成后管理台改用密码登录；setup token 只保留给设备 CLI 和 break-glass。忘记密码时执行 `admin reset` 清除密码，重启后重新打印初始化密钥。

## 版本策略

只支持 DSH `>=0.2.1-rc.1 <0.3.0-0`。用**特性探测**而非版本比较；缺必需 API 时装载期报错并给出所需版本。不维护旧版本兼容分支。

`0.2.2-rc.1` 已于 2026-11-07 重验（该版把 cordis 从 4.0.5 升到 4.1.0）：插件用到的宿主 API 逐个在 DSH 源码里核对仍在，`pnpm run check` 用 `0.2.2-rc.1` 的包跑通 212 条用例。详见下一节的插件 API 条目。

## 兼容性边界

同步层只把事件当作不透明 JSON 搬运、不解释事件语义，但**依赖 DSH 能读出并写入这些事件**——未知/不合法事件由 DSH 自己 fail-closed。因此：

- **同一代际**（如 v4）：事件由 DSH 校验；我们按规范 JSON 计算批次哈希，不依赖事件 schema；
- **跨代际**（v4 → v5）：旧 DSH 直接拒读（`sessionFormatVersionRefusal`），同步必须按 `formatVersion` 闸门，不把新代际会话推给旧设备；manifest 记录每个会话的代际，设备台账只记录本机 DSH 的 `sessionFormatVersion`；
- **同代际但 DSH 版本不同**：新补丁若引入旧版不认识的必需事件，旧版读/写会失败；**未实现**：当前不读其他设备的台账版本、也没有"只向不低于自己的设备推送"的过滤，闸门只有会话级 `formatVersion` 与本地 DSH 读写的 fail-closed；
- **物理格式无关**：压缩参数、JSONL/zstd/未来后端都不影响同步；`cwd` 不进链（header 单独封存且不含 cwd）；
- **空标记对撞自动收敛**：`session/end-seed` 是 DSH 打开/复活会话时补写的就绪标记（`core/session/src/index.ts` 只在尾部不是该类型时才补），两台设备在同一已同步前缀之上、离线期间各自打开同一会话，会在同一个 seq 上各写一条，唯一差异是 `time`。链校验把「同 seq、两侧都是 `session/end-seed` 且 `data` 完全相同」视为等价（`shared/src/chain.ts` 的 `markerEquivalent`，消费点见 `plugin/src/engine.ts` 的 `verifySharedPrefix`）：本机那条 marker 位于远端 `lastSeq` 之内、不会被推上去，同步照常按「本地领先」继续，不再报警为分叉。`data` 不同（例如一侧是 fork 继承标记）或同一 seq 一侧是真实事件时仍按分叉处理；本地日志与远端链在该 marker 的 `time` 上保持各自原值（官方不依赖时间戳顺序）。
- **插件 API**：`sessionPersistence` 等会话/持久化 seam 只在 `>=0.2.1-rc.1 <0.3.0-0` 内验证，越过这个小版本要重新验证；官方校验器随 DSH 升级同步升版本并重跑夹具。`0.2.2-rc.1` 的核对结论（2026-11-07，源码级）：`sessionPersistence.{list,stat,open,create}`、`SessionHandle.{read,append,flush,close}` 与 `header`/`inheritedEventCount`、`ctx.sessions.{get,flush}`、`sessionProjectionCache.{coldSnapshot,cachedSnapshot}`、`connection.fetch.register`（`ConnectionFetchRoute` 仍是 `path/methods/requestBody/fetch`）、`credentials.resolve`（仍返回 `{value,source}`）、`workspaceRegistry.{resolveByPath,create,attachSession}`、`settings.{describe,mutate}`、`ctx.get('dshHomePath')`、`interruptedTurnClosers`、`working-directory/change`、`agent/pre-step` 全部仍在；`validateStoredEvents` 仍拒读**未知且未标 `ignorable`**的事件类型，代际闸门仍由 `sessionFormatVersionRefusal` 承担；`SESSION_FORMAT_VERSION` 仍是 4。

## 非目标

- 不做事件级合并（不重排 `seq`/`surfaceOp`）。
- 不做服务端合并（端到端加密下服务端看不到明文）。
- 不做帧级同步；原始日志导出/恢复（同版本、整文件）是独立的后续功能，不参与同步链。
- 不做原地删除/重写事件；修复走 fork + 墓碑或独立维护操作。
- 不自动重启宿主。
- 第一版不同步工作区项目文件。
