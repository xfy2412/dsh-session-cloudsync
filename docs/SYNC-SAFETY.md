# 同步安全边界与客户端防误操作

> 状态：设计已定；M3 的安全边界（`tailOpen` / `safeThroughSeq`）与拉取已经落地，客户端防误操作（composer block / 列表拦截）留在 M4。文中的源码结论来自 DSH `0.2.1-rc.2`；客户端部分已在临时 GUI 上验证 DOM，尚未提交 UI 改动。

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

## 2.1 同步范围：工作区白名单与子代理闭包

- `workspaceAllowlist` 是**工作区路径**列表。**空列表 = 暂不同步任何会话**；插件仍加载并注册设置/状态 API，`status.configured=false`，原因是 `workspaceAllowlist 未配置`。
- 首启/设置页的同步列表由 `GET /api/session-sync/workspaces` 提供：每个工作区带 `title`、根会话数、子代理数、是否选中；「全选」就是把全部 `path` 写进白名单。
- 推送按根会话的 `cwd` 判定白名单；子代理后代跟随根，不单独判定。只有 `origin === 'subagent'` 算后代；fork 虽然也有 `parentSession`，但它是独立根。
- 推送顺序是**后代深到浅、根最后**；拉取按远端封好的 `delegationDepth` 从深到浅创建，子代理先建、根后建。找不到父会话或父链成环的子代理进入 `skipped`，不会静默丢进同步链。
- 拉取要求 `workspacePath` 也在白名单里（拉取目标必须是已选工作区之一）。远端会话头不携带 `cwd`（跨设备路径不稳定），所以当前所有远端会话都落到 `workspacePath`；多工作区各自回填属于后续工作。

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
| 用户手动中断 | 补 aborted 的 `tool/result`、`step/end`、`turn/end {kind:'aborted', reason:{kind:'user'}}`，最后写 `session/end-seed`；尾巴闭合，可安全同步/远端 resume |
| 进程强杀/断电 | 停在最后一个已提交事件；不会补 closers；正在流式的思考/输出丢失 |
| 强杀后 resume | 才 append `interruptedTurnClosers`：缺失工具结果（`ToolOutcomeUnknownError` / `ToolNotStartedError`）、`step/end`、`turn/end {kind:'interrupted'}` |
| 强杀后只读查看 | `readColdSessionLog` 只在内存补 closers，不写回 |

实测某会话手动中断尾部（2946 个事件）：

```
tool/call      pwsh#call_00_raWA
tool/result    isError=true, code=ABORTED
step/end       turn 27 / step 5
turn/end       {kind:'aborted', reason:{kind:'user'}}
session/end-seed
```

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

**建议拦截状态**：`applying/pulling`，以及远端有开放尾、本地只 apply 到 `safeThroughSeq` 的会话。发消息才会触发 resume 和补 closers，所以这是防误 resume/分叉的关键一层。

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
2. **运行中的会话**（最需要防误 resume）：左侧图标拿不到，用捕获阶段拦截：
   ```ts
   document.addEventListener('click', handler, true)
   // target.closest('[data-row-key^="session:"]')
   // 命中 blocked 集合：preventDefault + stopImmediatePropagation
   ```
   再补 `pointerdown`/`keydown`，防止拖拽和键盘打开；
3. **视觉蒙版**：临时在页面上给行注入过 `position:absolute; inset:0` 的覆盖层，精确覆盖 256×32 的行；可用，但需要自己维护行定位/滚动，作为增强而不是唯一防线；
4. **最终兜底**：拉取完成前不 `attachSession`，让会话尽量不出现在工作区列表；已经可见/已选中的会话仍靠捕获拦截 + composer block。

### 5.3 状态从哪里来

客户端需要知道哪些会话处于 `applying` / `openTail`。M4 的实现顺序：

- **A3/A4 已落地宿主 API**：`GET /api/session-sync/status` 提供运行中/上次结果/退避/pending/逐会话 `tailOpen`，`POST /api/session-sync/sync` 手动触发；客户端轮询即可驱动首版气泡；
- 逐会话的精确状态最终仍建议写一个 **session projection**（如 `syncState: { state, safeThroughSeq, tailOpen }`），供 `useSessions` / 列表行使用；
- 不用“写一条事件”表达临时同步状态，避免污染日志；
- 如果列表行拿不到任意 projection，再考虑 `sessions.provide` 或轻量远程服务（C1 验证）。

## 6. 已知限制与待验证

- 客户端 projection 在列表行里的可见性还没端到端验证；
- **durable revision + pending journal 已实现**：拉取前落盘 `{sessionId,targetSeq}`，成功后清除；启动先补 pending。若崩溃到 reconcile 前用户 resume，仍可能写入 closers 造成冲突，这条竞态仍需 UI/守卫兜底；
- **pending 只有一条**：一个会话失败后 `pullOnce` 立即停止，不再开始下一个会话，避免覆盖前一个未完成的恢复记录；代价是失败会话解决前，本轮后续会话暂不拉取。逐会话 journal 条目留到后续按需再拆；
- `data-row-key` 是应用内部属性，不是公开 API；捕获拦截依赖它，升级时要回归；
- 用户可能在 reconcile 完成前通过深链/其他入口打开会话；composer block 仍能阻止继续，但“打开”本身是否触发 agent resume 还没端到端验证；
- 官方没有“禁用会话行”的插槽；可向上游提需求，M4 先用拦截方案；
- 视觉蒙版需要 DOM 定位，跨滚动/折叠/重排要维护，先不做成默认。

## 7. M4 客户端检查清单

- [ ] `syncState` projection（或等价状态通道）落地；
- [ ] `ctx.conversation.blocks.set` 对 `applying` / `openTail` / safe 落后三种状态生效；
- [ ] 捕获阶段拦截 `[data-row-key]`，覆盖 click / pointerdown / keydown；
- [ ] 空闲行 `sidebar.session.row.leading` 的同步标记（`id: 'sync-mark'`）；
- [ ] 运行中行的 hover 卡片状态说明；
- [ ] 可选视觉蒙版；
- [ ] GUI 回归：下拉、拖拽、键盘操作、深链打开都不误 resume；
- [ ] 强杀拉取 + 启动 reconcile 的端到端测试。
