# M3 前置探针：持久化接口的边界

> 实测日期：2026-10-19；DSH `0.2.1-rc.2`（源码 HEAD `dsh-v0.2.1-rc.2`）。探针：`tests/m3/probe/`。

## 源码结论：公开接口是事件级，不是帧级

- `SessionHandle` 只有 `read()` / `append(events)` / `flush()` / `close()`，没有读取或追加原始帧字节的方法；
- `session-persistence/README.md`：*"Every log read and write flows through the returned `SessionHandle`; there are no id-addressed append or load methods."*
- 同 README：*"It serves the current logical `SessionEvent` stream through persistence handles, so format migration, compression, historical decoding, and crash recovery remain storage-internal details."*
- 设计笔记 `2026-06-14-session-persistence.md`：持久化单位**就是** `SessionEvent`，没有转换类型；
- 设计笔记 `2026-08-15-packed-session-history-transport.md` 明确拒绝“按物理行分页”，理由是保持 API 与 JSONL/SQLite/未来布局无关；
- JSONL 后端支持 `compression: 'none'`（纯文本行日志）——**帧边界甚至不是必然存在的**。

结论：上游没有任何“给插件开放原始帧”的意向；插件应走事件级。

## 实测：同 id、跨 home 的事件 round-trip

1. 从 source home 读一条 **261 事件**的非 seeded 会话 → 写 `{header, events}`（461,351 字节）；
2. 在第二个空 home 里用**相同 session id** `create` + 分批 `append(events)` + `flush`；
3. 重新 `open(id,'read')` 读回，逐事件做键序稳定的 JSON 比较；
4. 再用 `sessionQuery.readSession(id)` 冷读一次。

结果：

```
[m3-probe] import id=<source-id> events=261 copied=261 equal=true
[m3-probe] query.events=261 queryEqual=true firstDiff=none
```

## 实测：改 id 直接复制会坏

把同一批事件 `append` 到一个**新 session id** 下，写入能成功，但读回时报：

```
SessionPersistenceCorruptionError: current-generation delivery marker names the wrong Session
```

原因：部分事件（如 `session-log-deepseek/delivery-accepted`）的 `data` 里嵌了**源会话 id**。结论：

- 同步必须**保留 session id**（真实拉取正是同 id）；
- 改名/分叉只能走 DSH 自己的 fork 机制，不能直接复制事件。

## 其他观察

- `stat()` 的 `eventCount` 可能是 `undefined`；选会话/判断进度用 `sizeBytes` 或实际读回的事件数更可靠；
- 同 id 重建后 `query.readSession` 与直接读 handle 都正常，说明事件级写入是 DSH 认可的路径；
- 头信息（`createdAt`/`cwd`/`isSeeded` 等）不在事件流里，拉取方需要单独拿到并本地重建——**cwd 允许按设备映射**。

## 对 M3 的含义

- 传输单位改为**连续事件批次**（批次哈希 = 规范 JSON 的 sha256），不再依赖原始帧；
- `sealed-frame` 继续可用（封批次字节）；`chain.ts` 的公共前缀/分叉算法继续可用，把帧换成批次；
- 服务端无需改（本来就不解析内容），字段语义从 frame 改为 batch；
- manifest 需要携带或另存**头信息**（至少 `formatVersion`、`createdAt`、`isSeeded`、`cwd` 映射），这是下一步要定的点。

## 批次模型（M3 设计已定）

- 一批 = `[seqFrom, seqTo]` 的连续事件，写入方在同步时封口，默认上限 **50 个事件或 256 KiB**；
- 批次**上传后不可变**，新事件只能进新批次；只有尚未上传的开放尾批可以继续追加/替换；
- 拉取方**不重新切批**，以服务端 manifest 的 `[seqFrom, seqTo]` 为权威；
- 本地已有完整前缀批次：只算哈希，不下载；
- 批次跨过本地末尾：下载该批、校验重叠段、只追加缺的后半段；
- 复制点示例（A=150，B=65 副本，A 先推 `0..49`、`50..99`、`100..149`）：B 下载 `50..99` 校验 `50..64` 后追加 `65..99`，再下载 `100..149`；最坏浪费 ≤ 一个批次；
- 若 B 先推，边界为 `0..49`、`50..64`，A 之后追加 `65..114`、`115..149`，无重叠；
- **服务器无法确定本地已有多少事件**，所以跨界批次必须由客户端下载后对比重叠段——这是设计的一部分，不是缺陷；
- header（`formatVersion/createdAt/isSeeded/delegationDepth/agentPreset/inheritedEventCount`）走带外 sealed header；`cwd` 由设备本地映射，不进入 manifest 明文；
- 删除/修复：协议不删除单个事件；未同步的脏尾不上传或走独立修复；已同步的脏内容走 **fork + 墓碑**；
- 帧级读写（原始日志导出/恢复）是独立的后续功能，不参与同步链。

## M3 实现状态

- 推送：枚举 → flush → 读事件 → 远端 manifest → 增量批次 → 上传 → 租约/append；
- 拉取：`/v2/changes` → manifest → 下载 header/批次 → 只 apply 到 `safeThroughSeq`；
- 安全字段：append 请求已携带 `tailOpen` / `safeThroughSeq`，服务端存进 manifest；
- 真实双 home 验收：临时服务端 + 两个临时 DSH home，合成会话 **11 个事件**在 A/B 逐事件一致（header 的 `cwd` 按设备映射，符合设计）；
- 开放尾验收：120 个闭合事件 + 1 个开放事件推送后，新设备只 apply 到 `safeThroughSeq=119`；闭合事件到达后才补到 121；
- 断网验收：服务端停止后宿主继续运行，推送只记错误（引擎离线单测覆盖）；
- 可靠性：durable revision + pending journal（`state.json` 原子写入），启动先补 pending；错误分类与退避已落到 host；
- M4 A3/A4：`GET /api/session-cloudsync/status`、`GET /api/session-cloudsync/setup`、`GET /api/session-cloudsync/workspaces`、`POST /api/session-cloudsync/test`、`POST /api/session-cloudsync/sync`（`ctx.connection.fetch`，owner-only）；状态含逐会话视图与 `tailOpen`，手动触发跳过退避；
- M4 A5：子代理闭包默认开启（根 + `origin=subagent` 后代；fork 独立根），推送子先父后，拉取子先建、根后建；工作区白名单为空时暂不同步，同步列表提供全选；
- M4 B1/B2/B4 host：token/passphrase 走 `ctx.credentials`（YAML 仅 bootstrap fallback），非敏感配置字段 volatile，连接测试用 `/test` 验服务端与 token；
- 尚未实现：图形化手动按钮/状态气泡（C6）、设置页/首启（B3/B5）、`frames → batches` 重命名。
