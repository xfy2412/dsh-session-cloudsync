# 同步性能重构计划

> 状态：草案，供 review；本文档不改代码。P0 已有真实基线，官方 Discussions 已核对（§4.7）。  
> 实施进度：P1（线性规划 + 预序列化封帧）、P2（异步 scrypt + masterKey 缓存）与 P3（读取后流水线）已落地；P4 及之后未开始。
> 基线：`229a3df`。当前工作树还有 URL 校验/会话标题的未提交改动，与本计划分开。  
> 官方 API：已按 DSH `0.2.1-rc.2` / `0.2.1-rc.3` 源码核对；官方前端首屏行为与真实大会话实测见 §4.5、§4.6。  
> 范围：本机同步阻塞、首次同步、本地/远端差量校验、请求数、后续协议优化，以及公益服需要的服务端背压。  
> 不包含：服务端解密、加密格式重写、WAF 规则本身。

## 0. 结论摘要

1. 官方前端是 **wire/渲染分段 + Host 冷读全量**：首屏只传 264 个事件 / 1.05MB，但 Host 仍会完整读一次日志；`read(offset, length)` 不是流式读。
2. 我们的冻结主因不是“读了 69k 事件”，而是读后的 **`planEventBatches` 42.4 秒**（O(n²) 重复序列化）+ **封帧 5.7 秒** + **267MB 未压缩 payload**。
3. “被 DSH 掐死”的机制已确认：Gateway 默认 2s 心跳，连续 2 次无活动即 `terminate()`；42 秒主线程停顿必然让 WebSocket 1006，不是同步任务被取消（见 §4.7 / #9603）。
4. 先做 P1：线性规划 42.4s → 1.0s，规划+封帧约 3.2s，不改 wire；这是收益最大、风险最低的一步（P0 只保留最小埋点，不展开全量观测）。
5. P3 负责把“读取后的 3 秒”切成有界流水线并尽早发总数；首次完整读取仍无法靠官方 API 消除，不能承诺首同步总耗时 <5s。
6. P7.0 把 267MB 压到约 56MB（4.77x），再谈请求合并；否则公益服仍会被单会话 267MB 放大。

## 1. 问题与实测基线

真实大会话 `b0e0981d-7936-467f-a28c-30152c37d6f8`（v4 日志）：

```text
事件数              69,587
maxSeq              69,586
DSH 压缩日志        50,429,382 B
DSH 解压大小        267,344,490 B
默认批次            50 事件 / 256 KiB
实测批次数          1,509
当前 sealed 明文字节 267,409,139 B（规范 JSON，未压缩）
```

同一份日志的分阶段实测（Node 24，主线程，临时脚本，不入库）：

```text
解压 + 拆行                       719 ms
JSON.parse                        871 ms
planEventBatches               42,395 ms   ← 主要卡点
1,509 批封帧                    5,728 ms
读取后合计                      ≈49,000 ms
峰值 RSS                        ≈1.5 GB
```

说明：

- 前两项使用公开的 zstd 解码 + JSON.parse 路径近似读取阶段；DSH 后端还会额外做校验/冻结，真实读取时间略高。
- `planEventBatches` 与封帧两项调用的是仓库里的**真实实现**，不是合成估算。
- 以上不含网络、SSE 或服务端耗时；因此 ≈49s 是**纯主线程 CPU 阻塞**，不是“网络慢”。
- 临时基准脚本未入库；P0 会把它固化成可重复基准（只使用事件形状/计数，不把真实会话内容带进仓库）。
- 早先 20k/69k **合成事件**基准（1.4s / 4.6s）严重低估了真实 payload；后续一律以本表为准。

目标路径的量级验证（同样数据，尚未实现）：

```text
线性规划（不重复序列化候选批次）       1,020 ms
线性规划 + 封帧                       3,159 ms
线性规划 + zstd 压缩 + 封帧           4,667 ms（密文 56 MB）
```

这些数据显示，首次同步不是单点慢，而是：

1. 同步流程在 DSH 宿主主线程里做同步 CPU 工作；
2. `planEventBatches()` 对每个事件复制候选批次并重新序列化，真实大会话上是 **O(n²)**，单独就占 42 秒；
3. 封帧阶段又把每批规范 JSON 序列化一次，且 1,509 个 sealed frame 全部常驻后才开始上传；
4. 气泡第一次拿到 `totalEvents` 要等规划 + 封帧全部结束，接近 50 秒；
5. 当前 sealed 明文是未压缩的规范 JSON，267 MB，比 DSH 自己的压缩日志大 **5.3 倍**；
6. 大会话产生 1,509 次 blob 上传请求，公益服会被请求频率和总字节同时放大。

补充“被掐死”的机制：这 42 秒是单次同步调用内连续的 CPU，中间没有 `await`/yield；Gateway 默认每 2s 发一次心跳，连续 2 次没有活动就 `socket.terminate()`（约 4s）。因此 42 秒停顿必然导致 WebSocket 1006、页面重连；看起来像“DSH 把同步掐死”，实际是**同步阻塞了宿主，心跳把连接杀掉**。这不是 WAF 问题，也不是同步任务被主动取消。

## 2. 目标与非目标

### 目标

- 大会话同步期间，DSH 的 `/api`、SSE 和 Web 静态资源保持可响应；
- 事件循环最大停顿有上限，不再出现需要刷新 3080 的程度；
- 气泡在读取完成后 500ms 内给出精确总数和阶段，而不是封完才显示；
- 首次同步可分块、可观察、可中断恢复；
- 后续同步利用本地日志只追加的特性，只计算新增部分；
- 显著降低每会话请求数；
- 服务端和公益服能对请求量做背压，而不是靠 WAF 502/468 兜底；
- 保持现有链哈希、append 前缀、租约、游标和安全边界语义不变。

### 非目标

- 不改变端到端加密方案；
- 不实现“允许服务器解密”；
- 不把服务端改成明文存储；
- 不通过关闭 TLS/WAF 校验来绕过问题；
- 不重写 DSH 会话格式；
- **不承诺首次同步总耗时 <5s**：首次仍要完整读取一次，并至少传输约 56MB（P7.0 后）；目标是消除 42s 冻结和 5.3 倍 payload 放大，而不是把首次全量传输变成首屏加载。

## 3. 必须保持的正确性约束

任何优化都不能破坏以下不变量：

1. 批次规范 JSON 字节必须和现有 `serializeEventBatch()` 完全一致；
2. 批次 `chainHash = sha256(规范 JSON)` 必须稳定；
3. header frame 必须保持 index 0、seq -1；
4. append 必须从远端链尾继续，`baseIndex/baseChainHash` 匹配；
5. 本地事件必须连续、seq 不能重复；
6. pull 只 apply 到 `safeThroughSeq`，失败不推进主 cursor；
7. 全局 `sync` 租约决定 push 权限，pull 不受影响；
8. 本地 live 会话、开放尾、未映射工作区、分叉仍按现有安全边界处理；
9. 缓存只能是派生数据，损坏或失效时必须能回退到全量校验；
10. 任何网络失败/429/502 不能把已经成功的会话永久改成错误状态。

## 4. 现状流程与瓶颈

### 4.1 Push

```text
syncOnce
  → scryptSync(口令, salt)
  → sessionPersistence.list()
  → 构建会话闭包
  → 对每个会话：
      读取整个会话
      → GET manifest
      → 校验 header/身份/共享前缀
      → planEventBatches        （真实大会话 42.4s）
      → 同步封所有批次          （真实大会话 5.7s）
      → 第一次带总数的进度
      → 逐批上传 blob
      → 一次 append
```

### 4.2 Pull

```text
GET /v1/cursor
  → 每个变更会话：
      GET manifest
      → 校验共享前缀
      → 下载 blob、解密、校验
      → 只 apply 到安全边界
      → pending journal
  → 全部会话无错误才推进 cursor
```

### 4.3 具体浪费点

- `planEventBatches()` 每加入一个事件都 `[...current, event]` 并重新序列化当前批次；真实 69,587 事件上 **42.4s**，是当前第一卡点；这 42 秒是**一次同步调用内连续的 CPU**，中间没有 `await`/yield，DSH 宿主无法处理 `/api`/SSE；
- `sealEventBatch()` 又序列化一次；1,509 批合计 **5.7s**；
- `sealFrame()` 再对明文做一次 SHA-256；
- 所有 sealed frame 都保存在 `uploadSteps` 数组里，才开始上传；峰值 RSS ≈1.5GB；
- 首次上传前没有总数，气泡只能显示很粗的阶段，真实大会话近 50 秒没有事件数；
- 每个批次一个 blob 请求，1,509 个批次就是 1,509 次上传请求，没有请求合并；
- 当前 sealed 明文是**未压缩规范 JSON**，267MB；DSH 自己的 zstd 日志只有 50MB，传输量被放大 5.3 倍；
- `verifySharedPrefix()` 每轮重新序列化并哈希本地历史前缀；
- 新拉会话的 `sessionProjectionCache.coldSnapshot()` 也是同步折叠。

补充：`SEALED-FRAME.md` 目前描述“明文是从会话日志原样切出的 zstd 帧字节”，但实际 `sealEventBatch()` 传入的是 `serializeEventBatch()` 的规范 JSON。这是**文档与实现不一致**，也是 267MB 膨胀的直接原因；修协议时必须先把这一点定清楚（见 P7.0）。

### 4.5 官方 API 调查结论（2026-10-24）

核对对象：本机安装的 DSH `0.2.1-rc.2`，以及本地源码 checkout 的 `0.2.1-rc.3`。两者在本次涉及的 `session.follow` / `session.page` / `SessionHandle.read` / JSONL 冷读路径上一致；版本差异不影响下列结论。

### `SessionHandle.read(offset, length)` 不是流式 I/O

`@deepseek-ai/dsh-session-persistence` 的接口规定：

- `offset` 是第一个逻辑事件的 **seq**，不是字节偏移；
- `length` 是最多返回多少个**事件**，不是字节数；
- 返回的是完整事件数组的 slice。

JSONL 后端的 `JsonlSessionHandle.readCurrent()` 实际是：

```text
readStoredLog()  // 完整读取、解压、解析、校验、冻结
→ source.events.slice(offset, offset + length)
```

因此：

- `read(offset, length)` 不能减少首次完整读取、解压、校验和冻结的成本；
- 它只能避免把切片之外的事件数组交给调用方；
- 首次同步不能依赖 range read 变成真正的流式读取；
- `readStoredLog()` 的完整解压结果会短暂保存在 `coldLogMemo`，最多 2 个会话；大会话会带来明显内存峰值。

### 现有读取路径的实际 yield

JSONL 后端的 zstd 解码循环每约 **500ms** 调用一次 `scheduler.yield()`，所以解压阶段不是完全不 yield。

但解析完成后还有：

```text
validateStoredEvents()
freezeStoredEvents()
```

这两个阶段同步遍历全部事件，没有 yield。69,587 个事件的会话在这里仍可能产生长任务。

### 可用的轻量元数据

`SessionPersistenceSnapshot` 提供：

```text
revision       // opaque change token；相等时可认为日志未变化
eventCount?    // 后端能廉价提供时
sizeBytes?     // 物理日志大小
location?      // 当前 artifact 路径；诊断用，不应作为稳定解析入口
```

用途：

- 读取前显示日志大小/可选事件数；JSONL 当前只稳定提供 `sizeBytes`，不要假设 `eventCount` 一定存在；
- 用 `revision` 判断同一会话是否变化，未变化时跳过完整读取；
- 作为帧缓存的生命周期身份；
- 作为进度和诊断字段。

### 现有 observation 不是替代方案

`@deepseek-ai/dsh-session-query` 的 `SessionObservationReader`：

- cold observation 仍然完整读取日志；
- prepared cache 默认只保留 5 个会话；
- 没有提供底层 streaming/history pagination。

因此不能用它绕开首次全量读取。

### 官方已有的调度与 worker 先例

- JSONL migration 使用 `node:timers/promises` 的 `scheduler.yield()` 做 CPU 分片；
- `@deepseek-ai/dsh-session-persistence-jsonl` 使用 `node:worker_threads` 做 generation 校验；
- 插件可以沿用这两个模式，但 worker 只能做纯 CPU，不能访问 DSH 的 `sessions` / `sessionPersistence` 服务。

### 对 P3 的修正

原计划中“用 range read 分块读取”的假设不成立。P3 改为：

1. 接受首次通过官方 API 完整读取一次；
2. 用 snapshot 的 `revision` / `sizeBytes` 做跳过和读取前估算；`eventCount` 只有后端提供时才用（JSONL 当前不提供）；
3. 读取完成后按批次进行“规划 → 封帧 → 上传”的有界流水线；
4. 在规划/封帧/上传之间主动 yield；
5. 若必须消除读取阶段的长任务，只能：
   - 向上游 DSH 提出 streaming/worker read 或让 `validateStoredEvents`/`freezeStoredEvents` 可 yield；
   - 或使用非公开的原始日志解析路径（不建议，格式版本耦合，且需要自行承担校验）；
6. 首次同步的验收指标区分“读取阶段”和“后处理阶段”，不能用 range read 声称消除了前者。

### 4.6 官方前端为什么看起来是“分段加载”

先给结论：官方是 **wire / 渲染分段 + Host 冷读全量**，不是磁盘流式读。两者必须分开看，否则会把“首屏只传 1MB”误当成“只读了 1/69k 事件”。

#### 客户端只请求一个尾部窗口

`@deepseek-ai/dsh-api-session-controller` 的 `src/client/sessions/session.ts`：

```text
HISTORY_PAGE_OPTIONS = {
  maxMessages: 500,
  turnWindow: { minMessages: 50, minTurns: 2 },
}
```

`Session.open()` 调用 `events.open(HISTORY_PAGE_OPTIONS)`，只取尾部一页；之后的 `loadOlder()` / `loadThrough(seq)` 才按页向更早历史加载，`maxMessages` 只是上界，真正的切点由 `turnWindow` 的“至少 50 条消息 + 至少 2 个 turn 起点”决定。

#### Host 只回一个按 turn 对齐的窗口

`src/history.ts` 的 `paginate()` 从 `throughSeq` 向前扫描：

- 只统计 append-origin 的 `user/message` / `assistant/message`；
- 在满足 `minMessages` / `minTurns` 的下一个 `turn/start` 处停止；
- 返回 `events.slice(cut, end)`，并带 `hasMore`；
- `maxMessages` 上限是 500，但通常远没到上限就按 turn 切断了。

按官方规则对同一份 `b0e0981d` 日志复算：

```text
初始页事件数        264
其中 user/message   14
其中 assistant/message 36
turn/start          14
初始页字节          1,050,013 B
起始 seq            69,323
结束 seq            69,586
hasMore             true
分页本身耗时        5 ms
```

也就是说，浏览器首屏拿到的是最后 **264 / 69,587** 个事件，约 **1.05MB**；不是整段 267MB，也不是 69k 个事件对象。`ChatView.tsx` 只渲染当前窗口，底部有 `hasMore` 时显示“加载更早”，没有把全量 transcript 塞进首屏。

对比：当前同步要传 267MB，约是官方首屏的 **254 倍**；这是“前端很快、我们的气泡很慢”的最直观差异。

#### 统计也不是浏览器全量折叠

`StatsPills.tsx` 通过 `useProjection('sessionStats')` 读的是 **Host 侧投影**；`session-stats` 的 `projection.ts` 在 Host 上随事件增量折叠，并由 `session-projection-cache` 持久化检查点。只有没有投影值时才回退到 `deriveStats()`，而它只折叠**当前窗口**的节点。因此官方统计不会在浏览器里遍历 69k 事件。

注意：projection cache 只跳过“已折叠前缀”，不减少事件数组的完整读取；首次无缓存时 Host 仍会全量折叠一次。它优化的是统计，不是读取。

#### 但 Host 仍然完整冷读

`@deepseek-ai/dsh-session-query` 的 `cold-read.ts`：

```text
readColdSessionLog()
  → handle.read(0, undefined)
  → JSONL readCurrent()
      → readStoredLog()   // 完整读取、解压、解析、校验、冻结
      → source.events.slice(offset, offset + length)
```

所以：

- 官方首屏的“分段”是 **wire/渲染分段**，不是 `SessionHandle.read()` 的流式读；
- `read(offset, length)` 仍然先完整解码，再 slice；
- `coldLogMemo` 只保留 2 个完整解码日志，`SessionObservationReader` 的 prepared cache 默认 5 个；
- 官方冷读也可能有一次完整读取/校验/冻结长任务，只是读取后的工作是线性的。

注意：官方启动/侧栏列表本身是 **header-only**，不会为每张卡片全量读日志；全量冷读发生在打开会话、搜索 reconcile、投影等路径（#10182 维护者已纠正）。不要把“列表能显示”误认为“日志已全部读入”。

用公开解码路径对同一份日志实测：解压 + 拆行 719ms，JSON.parse 871ms，合计约 **1.6s**；DSH 还会做 `validateStoredEvents()` / `freezeStoredEvents()` 和 projection，因此实际首屏仍在数秒级，和“通常小于 5 秒”的观察一致。

#### 对同步的真正启示

- **不要**把官方首屏 `<5s` 当成“同步也可以只读一部分日志”；首次同步要拿全量事件，Host 仍得完整冷读一次。
- **要**照搬“有界工作集 + 先给可见结果”的思路：官方先给 264 个事件和投影，再按需加载；同步应先给阶段/总数，再按批规划、封帧、上传，而不是规划 42 秒、封帧 5.7 秒后才出现第一个事件数。
- 我们的真正异常不是“读了 69k 事件”，而是**读完之后的 42 秒规划 + 5.7 秒封帧 + 267MB 上传**。这三项才是要优先拆掉的。

### 4.7 官方 Discussions 现状（2026-10-24）

官方仓库没有开放 Issues，也没有公开 PR：

```text
has_issues       false
open_issues      0
pulls API        404
Discussions      enabled
```

`CONTRIBUTING.md` 明确说明**暂不接受外部 PR**，问题应通过 Discussions 报告/投票。因此本计划不包含“向上游提补丁”这一步；最多在 Discussions 补一份案例/投票。

已存在且与本次直接相关的讨论：

| 讨论 | 已确认的事实 | 对本计划的约束 |
|---|---|---|
| [#9947](https://github.com/deepseek-ai/deepseek-harness/discussions/9947) | JSONL 每次 append 后都重解码全量日志（9MB/12k 事件约 286ms）；只解新增行会触发 `seq gap`，不可行；常驻 decoder 可到 11.8ms | 官方读路径短期不会变成“跳过前缀”；我们不能依赖它，P5 只缓存 sealed frame，不缓存 decoded events |
| [#10182](https://github.com/deepseek-ai/deepseek-harness/discussions/10182) | cold projection/search reconcile 会 `readColdSessionLog` 全量读；维护者纠正：启动列表本身只读 header，真正全读在 search reconcile；建议按字节/会话数限制单次 reconcile | 确认“冷读全量”是官方已知成本；我们的 P3 仍要接受一次完整读取 |
| [#10181](https://github.com/deepseek-ai/deepseek-harness/discussions/10181) | 初始窗口由 `turnWindow` 主导，实测 450 records / 1.09MB；作者后来因 `dsh-cost-meter` 另一根因而撤回该提案，但分页数据仍成立 | 与我们复算的 264 records / 1.05MB 同向；不要把“改小 maxMessages”当成已验证的官方修复 |
| [#9603](https://github.com/deepseek-ai/deepseek-harness/discussions/9603) | Gateway 默认 2s 心跳，连续 2 次无活动即 `terminate()`；事件循环停顿约 4s 就会 1006 | **这就是“被掐死”的机制**：42s 连续 CPU 必然断连；P3 的延迟目标同时也是连接存活目标 |
| [#10814](https://github.com/deepseek-ai/deepseek-harness/discussions/10814) | 第三方客户端订阅约 23 个 open session，首连要解码/校验约 18MB 历史；同步解码饿死 pong，4–6s 后 1006；增量解码 + yield 可缓解 | 我们的同步同样不能用同步长任务；P3 的 yield 不是 UI 优化，是协议连接存活条件 |
| [#10218](https://github.com/deepseek-ai/deepseek-harness/discussions/10218) | 桌面端同时恢复 5–6 个大会话，首轮 `step/start` 可延迟 60–360s；官方大会话冷恢复并非总是 <5s | 用户观察到的“官方 <5s”是特定窗口/缓存条件；不能把 <5s 当成同步验收上限 |
| [#8277](https://github.com/deepseek-ai/deepseek-harness/discussions/8277) / [#7434](https://github.com/deepseek-ai/deepseek-harness/discussions/7434) | `sessionQuery.readEvent` 会深拷贝整段日志；单次看似 bounded，批量调用可阻塞主线程数十秒到数分钟 | 不要用 `readEvent` / `readSession` 做批量同步扫描；继续走 persistence 的完整 read |
| [#6511](https://github.com/deepseek-ai/deepseek-harness/discussions/6511) | 反复打开/重连会保留解码副本，30–90s 内可 OOM；`coldLogMemo` 只有 2 项，保留在下游 | 我们的缓存不能保留 decoded event 数组；只保留 sealed ref/journal |
| [#9660](https://github.com/deepseek-ai/deepseek-harness/discussions/9660) | 迁移后的 v4 日志可能只有 3 个 frame，单帧 118MB，打开时一次大分配 | 读取成本可能比“6,760 帧”更差；用 `sizeBytes` 做读取前提示，不能假设小帧 |
| [#8879](https://github.com/deepseek-ai/deepseek-harness/discussions/8879) / [#2654](https://github.com/deepseek-ai/deepseek-harness/discussions/2654) | 历史 payload 里 `assistant/message.stream` 占约 80%，50 条消息可能对应 64MB | 官方首屏之所以小，是窗口 + 投影；同步必须保留完整日志，不能照搬“只传窗口” |
| [#10693](https://github.com/deepseek-ai/deepseek-harness/discussions/10693) | `request/header` 每轮重写完整 tool catalog，占会话文件 31–44% | P7.0 压缩对真实日志收益更大；也是跨设备同步的主要体积来源之一 |
| [#10373](https://github.com/deepseek-ai/deepseek-harness/discussions/10373) | `stat.revision` 相同不代表读到的逻辑体相同；父会话的 subagent catalog 可出现 A→B→A | **P5 不能只用 revision 判定“日志未变”**；必须绑定 header/lifecycle，必要时回退全量校验 |
| [#10222](https://github.com/deepseek-ai/deepseek-harness/discussions/10222) | nginx 413 会被归类成 `INVALID_REQUEST`；请求体没有 preflight 字节诊断 | 267MB 上传在公网反代上可能直接 413；P7.0 是公益服前置条件 |
| [#10499](https://github.com/deepseek-ai/deepseek-harness/discussions/10499) | 官方 Chat UI 没有正文虚拟化，长会话加载更多页仍会卡 | 官方首屏快不等于“可以加载全量”；更说明同步不能把全量塞进一次 UI/状态更新 |

对计划的五条硬约束：

1. **不等待上游**：没有公开 PR 可等；本地先做 P1/P3/P7.0。
2. **不依赖常驻 decoder / revision 跳过**：官方明确说这是格式决策；我们的缓存只能是派生数据，失效就回退完整读取。
3. **必须消除 >4s 的主线程停顿**：否则 Gateway 心跳会断连；这不是“UI 卡一下”，而是整个 Web 控制面失联。
4. **不能把官方首屏窗口当成同步协议**：官方只传 264 个事件；同步要保留完整日志，但可以分批传、压缩传、断点续传。
5. **“官方 <5s”不是普适事实**：官方大会话恢复也有 60–360s 的报告（#10218）；我们的验收应以“无 >100ms 长任务 + 可观察进度”为准，而不是拿官方某次首屏时间当上限。

补充：官方目前没有 session 云同步 API；[#2276](https://github.com/deepseek-ai/deepseek-harness/discussions/2276) 的 account-anchored sync 仍是 RFC，不能把同步做进核心。本插件继续走 `sessionPersistence` + 自有协议，是当前可行路径。

## 5. 目标架构

```text
┌─────────────────────────────────────────────┐
│ DSH 主线程                                   │
│  - persistence 完整读取一次                   │
│  - 批次规划/序列化分块                        │
│  - 有界队列调度                              │
│  - 进度/状态                                 │
│  - HTTP 上传/append                          │
└──────────────┬──────────────────────────────┘
               │ canonical JSON buffer / sealed bytes
┌──────────────▼──────────────────────────────┐
│ worker 池（1–2 个）                          │
│  - 可选：规范 JSON 序列化                    │
│  - SHA-256                                  │
│  - AES-256-GCM                              │
│  - 返回 sealed frame + ref                   │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│ 本地帧缓存 / 首同步 journal                   │
│  - 已完成批次的 chainHash/blobSha256/seq     │
│  - 原子写，损坏回退                          │
└─────────────────────────────────────────────┘
```

原则：

- DSH 服务只在主线程调用，worker 不直接碰 `sessions` / `sessionPersistence`；
- 读取、封帧、上传三个队列都有上限；
- 所有跨线程数据只传字符串/二进制，避免对 7 万个事件对象做 structured clone；
- 主线程按 CPU 预算 yield，而不是每批固定 `setImmediate`；
- **不再预建 `uploadSteps` 全数组**：同一时刻只允许 1–2 个待上传批次的 sealed 数据常驻；
- 先发布“可读结果”（阶段、总数、首批进度），再继续 CPU/网络工作；
- 压缩（P7.0）发生在封帧之前，`chainHash` 仍绑定未压缩规范 JSON；传输字节和链身份分开。

## 6. 分阶段实施

### P0：观测与基准（已完成大半）

现有实测已经覆盖了最关键的阶段：读取、`planEventBatches`、封帧、sealed 字节、批次数、峰值 RSS。**不再要求从零加一套全量观测，也不把 P0 当作 P1 的前置阻塞项。**

已经具备：

- 真实 69,587 事件日志的分阶段计时（§1）；
- `plan` / `seal` / 首次带总数进度 / sealed 字节 / 峰值 RSS；
- 1,509 批次与 267MB payload 的基线；
- 与官方首屏 264 事件 / 1.05MB 的对照。

只需补齐：

- 事件循环延迟采样（`monitorEventLoopDelay` 或等价）；
- Gateway WebSocket 断连次数/时间戳（用于验证 4s 心跳规则，而不是猜“被掐死”）；
- 每轮请求数、字节数、批次数的持久化诊断；
- 把临时脚本固化成可重复基准（只使用事件形状/计数，不把真实会话内容带进仓库）。

验收：

- 能明确回答“卡在读取、规划、封帧还是网络”；
- 有一份 1 万、7 万事件的**真实 payload**可重复基线报告；
- 当前基线应能复现：`planEventBatches` ≈42s、封帧 ≈5.7s、首次总数 ≈50s、sealed ≈267MB；不能复现就说明测的不是同一条路径；
- P0 只补“事件循环/断连”两项即可开始 P1，不要求先完成长期观测平台。

### P1：批次规划与封帧单遍化

目标：不改变协议，只消掉重复 CPU。**这是当前收益最大的一步，应排在 P0 之后立即做。**

真实数据已经证明 `planEventBatches()` 是 O(n²)：

```text
当前实现（每个事件 [...current, event] + serialize 候选）  42,395 ms
线性实现（每个事件序列化一次 + 增量字节计数）               1,020 ms
```

- 重写 `planEventBatches()`：
  - 每个事件只做一次 `stableStringify(event)`；
  - 用“当前批次文本长度 + 逗号 + 方括号”做**精确**字节计数，不估算；
  - 候选批次超 `maxEvents` 或 `maxBytes` 时关闭当前批；
  - 不再对每个事件复制数组、不再重复序列化候选批次；
  - 保留 50 事件 / 256 KiB 的边界语义。
- 新增接受已序列化明文的 sealing 接口：
  ```text
  plan → canonical JSON Buffer（或等价的 batch text）
       → sha256 一次
       → AES-GCM
       → sealed frame + ref
  ```
  `sealEventBatch()` 不再自己 `serializeEventBatch()`，避免同一批 JSON 第三次序列化。
- 规划与封帧可以共享“每事件规范文本”的临时结果；只在当前批次内保留，不常驻全量。
- 保证旧/新 `planEventBatches` 对同一事件序列得到完全相同的批次边界、`bytes` 和 chainHash；
- 增加属性/对照测试：真实日志 + 随机事件 + 单事件超过 256 KiB + 空批次边界。

验收：

- 真实 69,587 事件：规划 ≤1.5s；规划 + 封帧 ≤4s；
- 所有链哈希/帧边界测试通过；
- 无 wire 变更；
- 不再出现“封帧前先构造 1,509 个 sealed entry”的峰值内存；
- P1 只消掉 O(n²) 和重复序列化，**不承诺**把 1s 规划变成无长任务；分片由 P3 负责。

实施记录（形状轨迹生成会话，69,587 事件 / 267MB canonical）：

```text
planEventBatches        1.5–1.7s（旧实现 42.4s）
实际 push 规划+封帧     2.7s
批次                    1,509
sealed 明文             267MB（P7.0 前不变）
```

仍未消除 `uploadSteps` 全数组常驻和封帧后的上传阶段停顿，归 P3。

### P2：异步 scrypt 与 masterKey 缓存

- 同步 `scryptSync` 改成异步 `crypto.scrypt`；
- 进程内按 `(passphrase, salt, kdf 参数)` 缓存 masterKey；
- 配置/凭据变化时失效；
- pull、push、status/测试连接共用。

验收：

- scrypt 不再出现在事件循环长任务里；
- 同一配置连续同步不会重复派生；
- 失败/凭据变化后能正确重算。

实施记录：push / pull / 接收端 cwd 修正已改为异步 `deriveMasterKeyAsync` + 进程内缓存；
Vault 的 `vaultKeyForConfig` 仍走同步派生，后续单独处理。

### P3：读取后流水线

目标：首次同步仍然做全量工作，但不让“规划 + 封帧 + 上传”继续冻结主线程。

**前提修正**：官方 `SessionHandle.read(offset, length)` 仍是完整读取后 slice，不是 streaming I/O；首次完整读取/解压/校验无法靠它消除（见 §4.5 / §4.6）。

- 用 snapshot 的 `eventCount` / `sizeBytes` 在读取前给出进度估算；JSONL 当前通常只有 `sizeBytes`，`eventCount` 缺失时不要伪造事件百分比。
- 读取完成后立刻用 `events.length` / `localLast + 1` 发布**精确总数**和 `planning` 阶段，再开始规划；不要等封完才发 `totalEvents`。
- 用 `stat.revision` 判断会话是否变化；未变化的会话跳过读取。
- 首次读取完成后，规划、封帧、上传形成有界流水线：
  ```text
  read once
    → publish total
    → for each batch:
         plan text → seal → enqueue upload → progress
  ```
- 同一时刻最多 2–3 个批次在队列中；`uploadSteps` 全数组不再存在。
- **P1 的线性 `planEventBatches()` 仍会一次性返回全部批次（约 1s）**；P3 必须再把它改成可暂停的 batch iterator / async generator，按 10–20ms 预算产出下一批，不能直接在主线程一次性调用 1s。
- 每处理 10–20ms 主动 yield；P1 之后单批规划/封帧应远小于预算，不能再次出现 42 秒同步段。
- 进度阶段明确区分：
  ```text
  reading / planning / sealing / uploading / appending
  ```
- 在 `validateStoredEvents` / `freezeStoredEvents` 无法 yield 的前提下，明确记录“读取阶段仍可能有一次较长停顿”，不要把它伪装成已解决；该阶段的峰值内存也单独报告。
- 如果业务要求彻底消除读取停顿，单独立项“上游 API 增强”，不要把非公开文件解析塞进 P3。
- P3 不做压缩；267MB → 56MB 的压缩属于 P7.0，需要协议标记，避免和流水线改造混在一起。

验收：

- 真实 69,587 事件：读取后规划 + 封帧不再出现 >100ms 的主线程长任务；
- 42 秒长任务消除后，Gateway 2s×2 心跳期间连接保持存活，不再出现同步中 1006/重连；
- 气泡在读取完成后 500ms 内显示精确总数和 `planning/sealing/uploading` 阶段；
- DSH 本地 `/api` p95 < 100ms；
- 内存峰值不随整个 sealed 数组增长；同一时刻只有有界队列；
- 中断后不会把已封/已传的批次全部丢掉（见 P5/P6）；
- 单独报告读取/校验阶段的停顿和峰值；不把 range read 作为该阶段的解决方案。

实施记录（2026-10-26）：

- push 不再预建 `uploadSteps` 全数组；header/批次封好后立即上传，只保留 `SealedFrameRef[]` 用于最终 append。
- 读取完成后先发布精确 `totalEvents`，再进入规划/封帧/上传；
- `reading` 发出后 yield 一次；`planning`、`sealing` 各 yield；批次之间按 8ms CPU 预算 yield；
- SSE 对 `stage` 变化立即发送，逐批进度仍走 200ms 合并窗口；
- 阶段顺序测试覆盖：`reading → planning → sealing → uploading → committing → done`。

本机合成 69,587 事件 / 1,509 批（内存事件、假服务端，不含真实冷读和解密网络）：

```text
总耗时                 6.45s
上传请求               1,510（header + 1,509 批）
事件循环最大阻塞采样   56ms
阶段                    全部 6 个均被观测
```

该结果只验证 P3 的读取后流水线；真实 `read()` / `validate` / `freeze` 仍不在 P3 范围内，
真实 UI、Gateway 断连、`/api` p95 还需在 69k 真实会话上补测。

### P4：worker 池封帧

前置：先做完 P1 + P3；如果主线程规划/封帧已经满足延迟预算，worker 不是必需项。只有实测仍超预算时才上 worker。

- 增加 1–2 个 CPU worker；
- 输入建议为 canonical JSON 字符串/Buffer，而不是事件对象数组；
- worker 负责 SHA-256 + AES-GCM，返回 sealed bytes + ref；
- 主线程只做队列/网络/状态；
- worker 失败时回退主线程 sealing，不能丢会话；
- 构建脚本把 worker 产物打进 `lib/`，npm 包 `files` 覆盖；
- 不在 worker 中调用 DSH 服务；
- 参考 DSH JSONL verifier 的 `worker_threads` 结构；发布产物是 JS，不要让 worker 依赖 tsx bootstrap。

验收：

- 主线程事件循环 p99 延迟有上限；
- worker 崩溃、超时、队列满都有明确回退；
- 包安装后 worker 文件存在且能启动。

### P5：本地帧缓存

利用 DSH 日志只追加、不改写的事实。

缓存位置建议：

```text
<DSH_HOME>/session-cloudsync/frame-cache/v1/<sessionId>.json
```

缓存记录：

```text
sessionId
createdAt
formatVersion
inheritedEventCount
headerChainHash
persistenceRevision
bodyBinding（header/lifecycle + 必要的 subagent catalog 事实；不能只靠 revision）
keyId（密文 blob 相关）
localLastSeq
frames:
  index
  seqFrom
  seqTo
  chainHash
  blobSha256
  bytes
  sealedVersion
  compression
```

复用条件：

- `stat.revision` 与缓存记录一致只能作为“**可能未变**”的提示，不能单独当作会话体身份；官方 #10373 已证明相同 revision 可以跨过一次 transient 逻辑变化（父会话的 subagent catalog 可 A→B→A）；
- 本地 header/lifecycle 未变；
- `localLastSeq` 没有回退；
- 缓存覆盖远端 manifest 的对应帧；
- 本地日志仍满足 append-only 假设；
- 对带 subagent catalog / 外部依赖的父会话，revision 命中但缓存未覆盖该依赖时，回退完整读取或至少重新校验 catalog 事实。

`revision` 还包含 `size`/`mtimeNs`/`ctimeNs`，任何 append 或外部 touch 都会失效（#9947）；因此缓存命中率不能按“文件没动”假设，必须接受频繁回退。

缓存只保存 **sealed ref / journal / hash**，不保存 decoded event 数组；反复打开时保留解码副本会导致 OOM（#6511）。

失效条件：

- `stat.revision` 变化但缓存没有覆盖新增事件；
- header 变化；
- 本地 seq 回退或缺失；
- 会话被替换/重建；
- 格式代际变化；
- 缓存记录里的 `compression` 与当前协议配置不一致；
- 缓存损坏；
- keyId/密钥配置变化导致 blob 不可复用；
- subagent catalog / 外部依赖变化但 revision 未变（#10373）。

需要区分：

- `chainHash` 是明文哈希，换密钥仍可复用；
- `blobSha256` 是密文哈希，换密钥后不能复用上传结果。

验收：

- 首次同步写入缓存；
- 第二次同步只处理新增事件；
- 共享前缀校验可直接用缓存比对；
- 缓存损坏自动回退全量校验；
- 不影响 pull 的 cursor 完整性。

### P6：首次同步 journal 与断点恢复

首次同步可能持续数分钟，必须可恢复。

- 每完成一个批次组，记录：
  ```text
  sessionId
  groupIndex
  sealedRefs[]
  cache 更新位置
  ```
- 本地 journal 原子写；
- 重启后从最后一个完整组继续；
- 远端 append 可分组进行，或最后统一 append；
- 分组 append 的取舍：
  - 更可恢复，但请求更多；
  - 最后统一 append，请求更少，但崩溃后要靠本地 journal 重放。
- 若远端 blob 已上传但 manifest 未 append，服务端 blob 可被去重复用；
- 不推进 pull cursor，直到本地应用完整。

验收：

- 同步中强杀进程后，重启能从最近组继续；
- 不重复上传已完成 blob；
- 不会生成断裂链；
- 远端 append 的 base 始终连续。

### P7：协议 v3（压缩 + 请求合并）

目标：先消掉 5.3 倍 payload 膨胀，再把首次同步从“每批一请求”降到可接受数量。

#### P7.0：压缩 sealed 明文（建议与 v3 一起做）

当前 `sealEventBatch()` 的明文是 `serializeEventBatch()` 的规范 JSON：

```text
当前 sealed 明文       267,409,139 B
DSH 压缩日志            50,429,382 B
膨胀倍数                5.30x
```

同一份日志按 1,509 批做“线性规划 + 每批 zstd + 封帧”的量级验证：

```text
明文                 267,345,761 B
zstd 后               56,037,678 B（4.77x）
封帧后密文            56,101,056 B
规划+压缩+封帧耗时     4,667 ms
```

建议：

- 在**加密前**压缩规范 JSON；密文不可再压缩；
- `chainHash` 继续绑定**未压缩**规范 JSON，保持现有链语义；
- sealed frame 增加明确的 `compression: 'none' | 'zstd'`（或 flags 位）；
- AAD 同时绑定 `chainHash`（未压缩明文哈希）和 `compression`，防止降级/混淆；
- **frameKey 的派生必须把 `compression` 纳入 KDF**（或另存压缩后明文哈希），不能继续只用未压缩 `chainHash`；否则同一批次在“压缩/未压缩”两版下会复用同一 AES-GCM key + nonce，属于灾难性 nonce 复用；
- 服务端仍然只存密文，不需要理解压缩；
- 旧 v2 客户端/服务端继续走未压缩路径；v3 协商后启用；
- 不要用“每批再包一层 HTTP 压缩”代替：服务端存的是密文，HTTP 压缩对随机密文无效；
- 请求体必须低于部署反代的 body cap；否则 nginx 413 会被上游归类为 `INVALID_REQUEST`（#10222），表现为会话卡死而不是可恢复错误。

验收：

- 同一批事件压缩前后 `chainHash` 完全一致；
- 同一批事件在 `none` / `zstd` 两版下的 frameKey / 密文必须不同，禁止 key+nonce 复用；
- 解封后解压得到与 `serializeEventBatch()` 字节一致的内容；
- 真实大会话 sealed 总字节 ≤60MB（当前 267MB）；
- 关闭压缩时行为与 v2 完全一致；
- 压缩失败/解压失败有明确错误分类，不能静默降级成错误明文；
- v3 的单请求体有上限，超过反代 cap 时返回可读错误而不是 nginx 413 卡死（#10222）。

#### 方案 A：append 内联帧

新增一个请求，携带：

```text
baseIndex
baseChainHash
frames:
  ref
  sealedBytes（base64 或二进制）
workspaceKey
tailOpen
safeThroughSeq
```

服务端在同一个请求里：

1. 校验所有 frame ref；
2. 存储 blob；
3. 一次 append manifest。

优点：

- 不改 manifest 的帧 ref 结构；
- 请求数从“每批一次 blob + 一次 append”降为“组一次”；
- 兼容性改动相对小。

缺点：

- 请求体变大，需要 base64 或 multipart/二进制协议；
- 服务端要先写 blob 再 append，失败可能留下孤儿 blob，需要 GC。

#### 方案 B：多帧打包 blob

把 N 个 sealed frame 拼成一个 blob，manifest ref 增加：

```text
blobSha256
offset
length
```

优点：

- 请求数最少；
- 服务端只需存一个 blob。

缺点：

- manifest schema 变更；
- 服务端要校验每个 slice；
- 旧客户端/旧服务端兼容复杂；
- 需要协议版本升级和迁移测试。

建议：

1. **先做 P7.0**，把 267MB 降到约 56MB；这是公益服带宽/请求体最直接的收益；
2. **再做 A**，把请求数从 1,509 次降到按组请求；风险低；
3. 稳定后再评估 B；
4. 所有协议变更通过 `PROTOCOL_VERSION`/health 协商，旧服务端回退 v2；
5. 服务端同时支持 v2 和 v3，旧客户端不受影响；
6. P7.0 与 A 可以共用同一个 v3 版本，避免两次协议迁移。

## 7. 进度与状态

新增阶段：

```text
queued
reading
planning
sealing
uploading
appending
done
```

进度规则：

- 开始后先进入 `reading`；读取阶段只显示已读字节/大小（来自 `sizeBytes`），不伪造事件百分比；
- 读取完成后立刻用 `events.length` 发布**精确总数**，进入 `planning`；
- 规划/封帧/上传按批更新 `processedEvents / totalEvents`；不承诺在完成前给出 `totalBatches`；
- 首批上传成功后立即给 `uploading`，不等待全部封帧；
- SSE 合并窗口保持 80–250ms；
- 失败时保留上一个成功状态，区分 `transient` 与 `failed`；
- 429/502 只影响当前请求/会话，不把已完成会话全量刷红。

当前“近 50 秒没有事件数”的直接修正：`notifyProgress(start)` 之后不要等 `planEventBatches` + 全部 `sealEventBatch` 结束；读取一完成就发 `totalEvents`，随后每批发一次进度。

## 8. 服务端与公益服优化

协议合并之外，服务端需要：

- blob 上传流式写临时文件/边读边 hash，避免 32MiB 全缓冲；
- 单设备/IP 并发和 QPS 限制；
- 超限返回 `429 Retry-After`，不要让 WAF 返回 502；
- SSE 连接数上限；
- SQLite 单写队列或 worker，避免同步 DB 操作阻塞事件循环；
- 请求体、manifest 大小、超时限制；
- API 和 `/admin` 分离；
- API 不能被 HTML challenge WAF 保护；管理台可以；
- 服务端指标：请求数、队列深度、事件循环延迟、blob 写入耗时；
- 客户端/宿主部署若在 P1/P3 前仍可能出现 >4s 停顿，可临时调大 Gateway `websocketHeartbeatIntervalMs`（默认 2s，两个周期即断）；这是缓解，不是修复，不能替代消除长任务。

## 9. 兼容与发布策略

- 先做 P0–P3：无 wire 变更，可直接进 `0.0.x`；
- P4–P6：行为优化，默认开启前用实验配置验证；
- P7：协议版本升级（P7.0 压缩 + 方案 A），服务端先发，客户端再发；
- 旧服务端：自动回退 v2；
- 旧客户端：服务端继续接受 v2；
- 缓存格式带版本，升级后不兼容直接丢弃；
- 首次同步优化不能改变已有会话的链哈希；
- 发布前跑真实 69,587 事件基准和中断恢复测试。

## 10. 验收基准

至少覆盖：

1. 真实 `b0e0981d` 的 69,587 事件日志（不是只跑合成数据）；
2. 10k / 70k / 100k 合成会话；
3. 单进程多会话；
4. 两个 DSH 实例并发；
5. 服务端 429/502/超时；
6. 进程在读取、封帧、上传、append 四个阶段被强杀；
7. 缓存损坏、header 变化、seq 回退；
8. 旧服务端/旧客户端兼容。

硬指标建议：

```text
DSH 本地 /api p95 < 100ms
读取后事件循环最大停顿 < 100ms
同步期间 Gateway 1006 / 重连次数 0（当前 42s 停顿必然触发）
读取完成到气泡显示精确总数 < 500ms
69,587 事件 planEventBatches ≤ 1.5s（当前 42.4s）
69,587 事件 plan + seal ≤ 4s（当前约 48s）
69,587 事件不把整段 sealed 数组常驻内存（当前峰值 RSS ≈1.5GB）
P7.0 后 sealed 总字节 ≤ 60MB（当前 267MB；DSH 压缩日志 50MB）
请求数相对当前下降 ≥ 50%（方案 A；当前 1,509 次 blob）
缓存命中后历史前缀无重复哈希
```

对照基线（不是同步目标，只用于说明差异）：

```text
官方首屏窗口      264 / 69,587 事件，1.05MB，hasMore=true
官方分页耗时      5ms（纯 paginate，不含冷读）
官方冷读近似      解压+parse ≈1.6s；再加 validate/freeze/projection
```

## 11. 待拍板

1. 是否把 **P1（线性规划 + 预序列化封帧）** 作为下一个实现批次；P0 已有真实基线，只补事件循环/断连两项即可，不再阻塞 P1；当前 42.4s → 1.0s 的收益已经可复现；
2. worker 池默认 1 个还是 2 个；
3. 帧缓存放 `session-cloudsync/frame-cache/v1/` 还是合并进 state；
4. 首同步默认后台自动跑，还是需要用户确认；
5. 协议优化先做 **append 内联帧**，还是直接做 **多帧 blob**；
6. P7.0 压缩是否与方案 A 共用同一个 v3，还是先单独发一个压缩版本；
7. 实验配置项是否暴露到设置页，还是只留内部常量；
8. 是否向上游 DSH 提 streaming/worker read 需求；如果提，优先“可 yield 的 validate/freeze”还是“真正的流式事件读取”；
9. 在 P7.0 落地前，是否允许公益服继续接收 267MB/会话的首同步，还是先限制大会话自动同步；
10. 是否把本次实测整理成一份官方 Discussions 案例/投票（只报告，不提外部 PR）；
11. 是否把“事件循环可能超过 4s 时调大 `websocketHeartbeatIntervalMs`”写进部署文档，作为 P1/P3 落地前的临时缓解。

## 12. 参考

- [SEALED-FRAME.md](../architecture/SEALED-FRAME.md)
- [DESIGN.md](../architecture/DESIGN.md)
- [SYNC-SAFETY.md](SYNC-SAFETY.md)
- [PROTOCOL.md](../architecture/PROTOCOL.md)
- 代码：`packages/plugin/src/engine.ts`、`packages/shared/src/batches.ts`、`packages/shared/src/sealed-frame.ts`、`packages/server/src/http.ts`
- DSH `0.2.1-rc.2` / `0.2.1-rc.3` 官方 API：`@deepseek-ai/dsh-session-persistence` 的 `handle.ts` / `storage-contract.ts`，`dsh-session-persistence-jsonl` 的 `storage.ts` / `index.ts` / `migration-verifier.ts`，`dsh-session-query` 的 `observation.ts`
- DSH 官方前端：`@deepseek-ai/dsh-api-session-controller` 的 `src/client/sessions/session.ts`（初始页参数/loadOlder）、`src/history.ts`（paginate）、`src/client/transport.ts`（follow 首帧）
- DSH 官方统计：`@deepseek-ai/dsh-session-stats` 的 `src/projection.ts`，`@deepseek-ai/dsh-client-ui-chat` 的 `src/client/chat/StatsPills.tsx`
- DSH 官方冷读：`@deepseek-ai/dsh-session-query` 的 `src/cold-read.ts`，`@deepseek-ai/dsh-session-persistence-jsonl` 的 `src/storage.ts`
- DSH 官方贡献规则：`CONTRIBUTING.md`（暂不接受外部 PR；问题走 Discussions）
- DSH 相关 Discussions：[#9947](https://github.com/deepseek-ai/deepseek-harness/discussions/9947)（append 后全量重解码）、[#10182](https://github.com/deepseek-ai/deepseek-harness/discussions/10182)（cold read 全量）、[#9603](https://github.com/deepseek-ai/deepseek-harness/discussions/9603)（2s×2 心跳断连）、[#10373](https://github.com/deepseek-ai/deepseek-harness/discussions/10373)（revision 不绑定 body）、[#10693](https://github.com/deepseek-ai/deepseek-harness/discussions/10693)（request/header 体积）、[#10222](https://github.com/deepseek-ai/deepseek-harness/discussions/10222)（413 请求体）
