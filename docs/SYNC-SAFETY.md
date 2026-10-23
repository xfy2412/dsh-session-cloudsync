# 同步安全边界与客户端防误操作

> 状态：设计已定；M3 的安全边界（`tailOpen` / `safeThroughSeq`）与拉取已经落地，M4 客户端防误操作已实现（composer block / 列表拦截 / leading 标记），剩真实 GUI 的 C5 回归。文中的源码结论来自 DSH `0.2.1-rc.2`。
> 2026-10-23 按源码校正：`session/end-seed` 是 seed 边界（不是 turn/session 结束），只在 resume/fork 的构造路径补；拦截矩阵改为“冷会话硬拦、live 只拦输入”。本机 83 个会话的只读统计由维护者工作区记录（不随仓库分发）。

## 1. 为什么开放尾只能备份，不能直接给远端 resume

当前 v4 的 agent loop 里，助手流是**进程内状态**：

- `AssistantStreamAttempt.push()` 只发出瞬时帧，不落盘；
- 直到 `settle()` 才 append 一条 `assistant/message` 或 `assistant/attempt`，带完整 stream；
- 工具调用先 append `tool/call`，完成时才 append 一条完整 `tool/result`；
- `sessions.flush()` 只把**已 append** 的事件刷到持久化，不会结算正在流式进行的 attempt，也不会补工具结果。

因此一次导出/同步只能拿到**已提交的事件前缀**：

- 正在生成的思考链、输出了一半的助手消息：不在日志里；
- 命令返回了一半：日志里只有 `tool/call`，没有半截输出；
- 最后一个事件可能是 `turn/start`、`step/start`、`tool/call` 这种开放块。

判断尾巴是否闭合用官方函数：

```ts
interruptedTurnClosers(events) // 空 = 闭合；非空 = 开放尾
```

如果远端拿到开放尾并 resume，agent loop 会把 synthetic closers 真正 append 进本地日志；之后源设备再同步真实的后半段，就会撞上已写入的 `tool/result` / `turn/end` → 分叉。

同一路径还会补 `session/end-seed`。**它不是“会话结束”标记，而是“种子结束”边界**：按 DSH 0.2.1-rc.2 源码，只有 `Session` 构造器和 `buildForkSeed` 会创建它；正常 turn 结束、手动中断、强杀都不写。resume 时 stored log 成为 seed，只有尾部不是 marker 时才补一个普通 `{}`；打开冷会话会走 `history.follow` → `promote` → `resume`，所以“打开”本身就可能写日志。已有 marker 的尾部不会重复补，但仍会因 resume 变成 live，堵住后续 pull。

## 2. `tailOpen` 与 `safeThroughSeq`

manifest 记录两个非敏感字段（服务端不验证，和 `chainHash` 一样是客户端可信）：

```ts
interface SessionSummary {
  batchCount: number      // 已上传的全部批次（含开放尾）
  safeThroughSeq: number  // 最后一个闭合事件的 seq
  tailOpen: boolean       // safeThroughSeq 之后是否还有未闭合的 turn
}
```

写入方：

- `tailOpen = interruptedTurnClosers(events).length > 0`；
- `safeThroughSeq`：尾巴闭合时是最后一个事件 seq；开放时是**最后一个 `turn/end` 的 seq**；
- 封批时在 `safeThroughSeq` 处强制对齐，保证安全边界落在批次边界上。

读取方：

- 只 apply `seqTo <= safeThroughSeq` 的批次；
- 开放尾批次默认不下载、不写入本地 DSH 会话，只留在服务端当备份；
- `safeThroughSeq` 前进后才补拉并 append 新变为安全的批次。

这样长任务也能持续备份，但远端始终拿不到“半截可 resume”的会话。开放尾的 adopt/ignore 需要显式操作，不自动决定。

## 2.1 同步范围：根会话选择与子代理闭包

- 同步范围按**根会话**选择，不再有工作区白名单。默认全部根会话参与；本地 `excludedSessionIds` 记录取消勾选的根。
- 首启/设置页的同步列表由 `GET /api/session-cloudsync/workspaces` 提供：每个根会话带 `sessionId`、工作区路径、创建时间、事件数、子代理数与被排除状态；「全选/清空会话」直接更新这份本地排除表。
- 子代理后代跟随根，不单独勾选。只有 `origin === 'subagent'` 算后代；fork 虽然也有 `parentSession`，但它是独立根。
- 推送顺序是**后代深到浅、根最后**；拉取按远端封好的 `delegationDepth` 从深到浅创建，子代理先建、根后建。找不到父会话或父链成环的子代理进入 `skipped`，不会静默丢进同步链。
- 被排除的根及其整棵子代理在推送/拉取两侧都跳过；选择只在本设备生效，不会删除远端历史。
- 拉取按远端 `workspaceKey` 查本机绑定；未找到绑定时标记 `unmapped`，不创建本地会话，也不猜落点。

## 3. 拉取原子性

DSH 的 `append` 不是多事件事务：崩溃可能留下半个 turn；持久化只保证读出来是合法前缀。官方**没有启动时全量语义修复**：

- `interruptedTurnClosers` 只在 resume / fork / cold-read（内存）里用；
- resume 才会把 closers 写进磁盘；
- 冷读只在内存补，不写回。

所以拉取必须自带恢复日志：

1. 下载、解密、校验目标 turn 的全部事件；
2. 原子写 apply journal（`sessionId / targetSeq / nextSeq / phase`）；
3. `open(id,'write')` 或 `create(header)`；
4. 尽量一次 `append` 整个 turn；太大才分批，journal 记 `nextSeq`；
5. `flush()`；
6. 清除 pending（事件已耐久）；
7. **整轮 apply 完成后统一 `attachSession`**：子代理先、根最后；这样前端列表不会在闭包只同步一半时刷新；
8. 挂载失败时 revision 不前进，下一轮会因本地已是最新而重试挂载。

启动时对未完成 journal 做 reconcile：

- 读本地日志，校验前缀与服务端 manifest 一致；
- 补齐 `nextSeq..targetSeq` 的缺失事件；
- `flush` 后再 attach；
- 如果发现本地已有 synthetic closers 或前缀哈希不一致，**停止追加**，标记 `diverged`，要求 fork/人工处理。

服务器侧：先传 blob，再 append manifest；崩溃留下的孤儿 blob 由 GC 处理，append 重试按 `baseIndex + baseChainHash` 幂等。

## 4. 手动中断 vs 进程强杀

| 场景 | 日志结果 |
|---|---|
| 用户手动中断 | 补 aborted 的 `tool/result`、`step/end`、`turn/end {kind:'aborted', reason:{kind:'user'}}`；**不写 `session/end-seed`**。当前源码的直接中断路径没有 append 点；日志里若看到 end-seed，通常是之后 resume/冷打开补的 |
| 进程强杀/断电 | 停在最后一个已提交事件；不会补 closers；正在流式的思考/输出丢失 |
| 强杀后 resume | 才 append `interruptedTurnClosers`：缺失工具结果（`ToolOutcomeUnknownError` / `ToolNotStartedError`）、`step/end`、`turn/end {kind:'interrupted'}`；随后构造器补 `session/end-seed` |
| 强杀后只读查看 | `readColdSessionLog` 只在内存补 closers，不写回，也不写 end-seed |

实测某会话手动中断尾部（2946 个事件）：

```
tool/call      pwsh#call_00_raWA
tool/result    isError=true, code=ABORTED
step/end       turn 27 / step 5
turn/end       {kind:'aborted', reason:{kind:'user'}}
session/end-seed
```

按 0.2.1-rc.2 源码，手动中断路径本身没有 append `session/end-seed` 的点；这段日志末尾的 marker 只能来自构造器（之后的 resume/冷打开）或 fork。实测复现时要同时记录“中断后是否又打开/恢复了会话”，不能把 marker 归因给中断本身。当前本机 83 个会话的只读统计里，56 个结尾是 `turn/end`、2 个是非终态（其中一个就是扫描时正在运行的会话）、25 个结尾是 `session/end-seed`；这与“marker 只在 seed 构造时写”一致（统计证据见工作区文档，不进仓库）。

## 5. 客户端防误操作

### 5.1 输入框：官方 block 机制

`ui-conversation` 提供了专门给其他插件用的注册表：

```ts
ctx.conversation.blocks.set(sessionId, { reason: '正在同步，暂不可继续' })
```

- `IConversation.blocks` 的文档明确：这是“the composer cannot import 的插件让某会话输入失效”的唯一方式（`service.ts`）；
- 设置后 composer 变 inert，placeholder 显示 reason；输入框被禁用、发送被阻止（队列等外围控件是否仍可操作待验证）；模型选择仍可用；
- 清除用 `blocks.set(sessionId, undefined)`；
- 这比在输入框上盖 div 可靠：键盘、粘贴、快捷方式都绕不过去。

**拦截状态**：`applying/pulling`、远端有开放尾且本地只 apply 到 `safeThroughSeq`、以及
本地/远端都存在但尚未同步或 `diverged` 的会话。**冷打开和发消息都会触发 resume**：冷打开走
`history.follow` → `promote` → `resume`，发消息走 `resolveAgent` → `resume`；两者都可能补
closers/end-seed。所以 composer block 与列表拦截是防误 resume/分叉的两层，不能互相替代。

`diverged`/未同步会话的输入拦截带风险说明；用户勾选“理解强行写入会产生分叉”后才解除
本地写入。强行写入只允许本地继续，不自动推送、不自动合并。

### 5.2 会话列表：没有官方 disable，需要自己拦

实际 DOM：

```html
<div data-row-key="session:session-..." role="treeitem">...</div>
```

- 行点击是普通 `onClick`（`Rows.tsx`），行没有 disabled/blocked 属性；
- `sidebar.session.row.leading` 只在**主状态为 idle**时渲染；运行中、等待审批、子代理活动、已完成都会用状态点/spinner 顶掉它；
- `ui-schedule` 的时钟图标正是用这个槽位（`id: 'schedule-mark'`），所以“空闲行左侧图标”是可行的先例；
- 该槽位固定 16px，多插件图标会挤；定时任务时钟是 14px，再加一个同步图标要控制在 8–12px，或只用一个小点；
- `sidebar.workspaces.session.row.action` 只在 hover 操作条里；`sidebar.session.row.hover` 是悬浮卡片，不是行覆盖层。

**方案**：

1. **空闲会话**：注册 `sidebar.session.row.leading`，`id: 'sync-mark'`，画小锁/同步点；完整状态放 hover 卡片；
2. **冷会话 + 危险状态**（最需要防误 resume）：左侧图标拿不到，用捕获阶段拦截：
   ```ts
   document.addEventListener('click', handler, true)
   // target.closest('[data-row-key^="session:"]')
   // 命中“冷 + dangerous”集合：preventDefault + stopImmediatePropagation
   ```
   再补 `pointerdown`/`keydown`，防止拖拽和键盘打开。
   **已 live 的会话例外**：打开只是切换视图，不会 promote/resume；按 2026-10-23 决策，
   live 会话允许打开/切换，只由 composer block 拦输入。
   当前捕获只覆盖侧栏行；搜索结果（`SearchResultItem` 没有 `data-row-key`）以及
   `ui-schedule` / `ui-message-feedback` / `ui-workflow-run` / `ui-subagent` 等直接调用
   `uiWorkspace.openSession` 的入口由 **client 侧 `uiWorkspace.openSession` 包装**覆盖：
   探测服务失败、方法不可写、状态未加载时一律 fail-open，回退到 DOM 捕获。该包装是可选
   的兼容层，DSH 升级后方法形状变化不应影响插件加载。
   不能把“侧栏拦住了”当成“所有复活路径都拦住了”。
3. **视觉蒙版**：临时在页面上给行注入过 `position:absolute; inset:0` 的覆盖层，精确覆盖 256×32 的行；可用，但需要自己维护行定位/滚动，作为增强而不是唯一防线；
4. **最终兜底**：拉取完成前不 `attachSession`，让会话尽量不出现在工作区列表；已经可见/已选中的会话仍靠捕获拦截 + composer block。

### 5.3 状态从哪里来

客户端需要知道哪些会话处于 `applying` / `openTail` / safe 落后 / `diverged`。M4 已落地：

- **宿主 API**：`GET /api/session-cloudsync/status`（schema v2）提供运行中/上次结果/退避/pending，以及每个会话一行的聚合视图：`phase`、`push`/`pull` 方向、`pending.upload/download`、`tailOpen`、`remoteAhead`、`lease`；`GET /api/session-cloudsync/events?until=idle` 提供同一快照的 SSE 增量流（心跳、合并、abort 清理、空闲关闭）；`POST /api/session-cloudsync/sync` 手动触发；自动同步由 `nextRunAt` 自调度；
- **设备独占租约**：`/status.sessions[].lease` 投影每个 live 会话的租约状态；本机 live 期间 20s 续租，服务端 TTL 60s；其他设备 append 得到 `lease-held`；`foreign`/`lost` 时 composer 停止写入，live 行仍允许打开/切换；cold 会话不持有租约；
- **apply 中**：`pending.sessionId` 命中时 composer 与列表行都拦；
- **开放尾**：冷会话 `tailOpen: true` 时拦列表打开与 composer；live 会话允许打开，只拦输入；
- **safe 落后**：冷会话 `remote-ahead` 按 safe 落后处理，拦列表打开与输入；live 会话允许打开，只拦输入。`lag` 必须来自当前聚合状态，不能只用上一轮 push 的 `remote-ahead`；同轮 pull 已补齐时应清掉；
- **diverged/未同步**：由 [RECONCILE.md](RECONCILE.md) 的状态机提供给前端；冷会话拦打开，live 允许打开；两者都拦输入并展示风险确认；
- **冷打开会写日志**：DSH 的 `history.follow` 对冷会话会 `promote` → `resume`，可能补 synthetic closers 和 `session/end-seed`；所以“拦打开”不是 UI 偏好，而是同步安全边界。已有 marker 的尾部不会重复补 marker，但仍会变 live、堵住 pull；
- 不写临时同步事件，避免污染会话日志；逐会话 projection 仍可作为后续优化，但当前等价状态已由 `/status` 提供。

### 5.4 接受远端丢弃本地

`diverged` 会话选择“接受远端”时，不能在不停止 DSH 的情况下删文件再重建：DSH 仍持有 session 对象、写句柄和投影缓存。客户端只生成一次性停机脚本，不直接执行：

1. 脚本检查生成它的 DSH PID 是否已退出；
2. 扫描 `$DSH_HOME/sessions/*/<sessionId>`，找到唯一本地 artifact；
3. 复制到 `$DSH_HOME/session-cloudsync/replace-backups/`，逐文件 SHA-256 校验并写 manifest；
4. 备份通过后删除本地 session 目录、projection cache 和 workspace 记账；
5. 清除该 session 的 blocked / blockedDecisions / cwdPending / pending，并把拉取 revision 重置为 0；
6. 提示用户启动 DSH 后手动“立即同步”或等待自动同步。

脚本路径和备份目录由宿主 API `POST /api/session-cloudsync/replace` 返回，前端展示完整步骤和可复制命令。用户必须自己退出 DSH、运行脚本、再启动 DSH；插件不会重启应用。

远端必须仍在同一 `sessionId / createdAt / formatVersion` 下；如果远端已经变成新生命周期，拉取会按新会话处理。脚本只保证本地被安全移除和备份，不保证远端一定还能重建：执行前要确认远端仍有该会话，且其工作区在同步白名单内。

## 6. 已知限制与待验证

- 客户端 projection 在列表行里的可见性还没端到端验证；
- **durable revision + pending journal 已实现**：拉取前落盘 `{sessionId,targetSeq}`，成功后清除；启动先补 pending。若崩溃到 reconcile 前用户 resume，仍可能写入 closers 造成冲突，这条竞态仍需 UI/守卫兜底；
- **pending 只有一条**：一个会话失败后 `pullOnce` 立即停止，不再开始下一个会话，避免覆盖前一个未完成的恢复记录；代价是失败会话解决前，本轮后续会话暂不拉取。逐会话 journal 条目留到后续按需再拆；
- `data-row-key` 是应用内部属性，不是公开 API；捕获拦截依赖它，升级时要回归；捕获层只覆盖侧栏会话行；
- 搜索结果（`SearchResultItem` 没有 `data-row-key`）以及 `ui-schedule` / `ui-message-feedback` / `ui-workflow-run` / `ui-subagent` 等直接调用 `uiWorkspace.openSession` 的入口由 client 侧包装覆盖；服务探测失败、`openSession` 不可写、状态未加载时 fail-open。不能把该包装当成稳定 API，DSH 升级后要跑一次 capability 回归；
- 即使 open 被 guard 拦住，其他直接调用 `replaceMain`/私有导航的路径、提前解构缓存 `openSession` 的消费者、以及 `openWorkspace` 复用已有会话的路径仍可能绕过；composer block 只能阻止继续输入，不能撤回已经发生的 resume/end-seed 写入；
- 按 0.2.1-rc.2 源码确认：冷打开会 `history.follow` → `promote` → `agents.resume`，并可能补 closers/end-seed；因此“打开”本身已是写操作，不是只在发消息时写；
- **live 会话没有公开的 close/dispose 方法**：`AgentHandle.dispose()` 存在，但 session-controller 只保留 `.agent`；`archiveSession({stopActivity:true})` 只取消 running turn，不会 dispose Agent。一个会话一旦在本进程里 live，pull 会一直 `local-active`，只能重启 DSH 后才可 apply；期间另一设备写入会让本地停在 `remote-ahead`。
- **设备独占租约已实现**：仅对 live 会话持有；cold 不持有。租约在“会话变 live 后”的下一次扫描（最多 20s）拿到；没有 pre-open 租约，冷打开仍可能与另一台设备形成短暂窗口。进程正常退出会主动释放，异常退出靠 60s TTL；没有 close API 时交接仍只能重启。
- 设备独占的代价：会话被“钉”在当前 DSH 进程；没有 close API 就没有干净交接，进程崩溃后要等 60s TTL。交接只能重启 DSH，或等上游提供 close/dispose idle session 的 API；在那之前不要把“另一台设备可写”当成默认能力。
- 官方没有“禁用会话行”的插槽；可向上游提需求，M4 先用拦截方案；
- 视觉蒙版需要 DOM 定位，跨滚动/折叠/重排要维护，先不做成默认。

## 7. M4 客户端检查清单

- [x] 等价 `syncState` 状态通道（`/status` v2 的 `sessions[].phase` / `pending` / `tailOpen` / `remoteAhead`）落地；
- [x] 自调度 `nextRunAt` + `/events` SSE（合并/心跳/abort/空闲关闭），客户端按需长连接、失败退避轮询；
- [x] `ctx.conversation.blocks.set` 对 `applying` / `openTail` / safe 落后三种状态生效；
- [x] 捕获阶段拦截 `[data-row-key]`，覆盖 click / pointerdown / keydown（**仅侧栏会话行**）；
- [x] 空闲行 `sidebar.session.row.leading` 的同步标记（`id: 'session-cloudsync-mark'`）；
- [x] 运行中行的 hover 卡片状态说明（`sidebar.session.row.hover` 的 `session-cloudsync-hover`）；
- [x] 冷/live 拦截矩阵落地：冷 `remote-ahead`（含尾部已是 end-seed 的会话）硬拦，live 放宽为只拦输入；
- [x] 设备独占租约：live 会话 20s 续租、push 不误释放 presence lease、客户端 foreign/lost 拦输入；
- [x] client `uiWorkspace.openSession` 包装：覆盖搜索结果/ schedule / feedback 等入口，探测/安装失败 fail-open；
- [ ] pre-open 租约：冷会话打开前拿租约（当前仍是 live 后扫描，存在短暂窗口）；
- [ ] `diverged`/未同步会话的输入拦截、风险说明与“强行写入分叉”确认；
- [ ] `nonPortable` 会话的本地警告、确认后接收端追加修正与租约推送；
- [ ] 可选视觉蒙版；
- [ ] GUI 回归：下拉、拖拽、键盘操作、深链打开都不误 resume；
- [ ] 强杀拉取 + 启动 reconcile 的端到端测试。
