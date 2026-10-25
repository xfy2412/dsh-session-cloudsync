# 同步列表与气泡状态聚合

> 状态：设计稿。本文只描述目标模型，不改变传输协议。
>
> 前端和 host 使用同一个插件版本，不需要为旧气泡保留兼容字段；状态 schema
> 可以直接随插件一起升级，安装后两侧同时生效。
>
> 目标：会话列表在同步开始前就是完整的；一条会话在同步过程中只更新状态，
> 不在列表中间突然出现/消失；气泡用明确的 stage 和持续动效表达“正在做什么”，
> 而不是只显示一个静止的黄点和“等待”。

## 1. 当前问题

1. 气泡直接使用 `status.sessions`，而 controller 每轮结束会整体替换报告数组。
   本轮没有出现的方向报告会让会话从列表消失。
2. `syncSessionIds=[]` 时，本地会话的 push 报告是“根会话未选中”，旧的聚合把
   它翻译成 `skipped`，于是列表只剩一个“已跳过”的本地会话。
3. 远端未拉取会话没有进入列表；只有 pull 真正把它拉下来时才出现。
4. 会话出现顺序来自本轮报告/map 遍历，而不是稳定的列表序号，所以用户正在看
   列表底部时，新会话可能插到上方。
5. 进度条满了以后仍可能进入“等待官方写入 / 预热 / 挂载”等阶段，没有持续动效，
   看起来像卡住。

## 2. 完整列表不变量

气泡的同步列表**在同步开始前**由 Host 计算完整，任何时刻都应包含：

1. 已选中的本地根会话（`uploadSelected === true`）；
2. 远端存在、但本机尚未拉取的根会话（包括待映射）；
3. 正在传输、等待、失败或需要处理的会话，即使它暂时不满足 1/2。

明确排除：

- 本地未选中、且远端也没有对应会话的根会话；
- 已删除/墓碑会话；
- 子代理会话（跟随根会话，不单独占行）。

判定伪代码：

```text
include(root):
  if root.tombstoned: false
  if root.remotePresent and not root.localPresent: true   // 远端未拉取
  if root.selectedForUpload: true                         // 选中同步
  if root.active or root.attention: true                  // 正在处理/需要处理
  false
```

“未选中的本地会话”不再进入气泡列表，也不再计作 skipped。  
用户需要在设置页选择它；列表不应把它伪装成同步完成。

## 3. 稳定顺序

每个 Host 进程维护：

```ts
interface ListOrder {
  ordinal: number        // 首次进入列表时分配，单调递增，不回收
  sessionId: string
}
```

规则：

- 首次观察到会话时分配 `ordinal`；
- 之后状态、阶段、进度变化只更新行内容，不改变 `ordinal`；
- 排序只按 `(ordinal, sessionId)`，绝不按 `phase / progress / updatedAt` 重排；
- 新会话总是追加到列表末尾；
- 进程重启后没有 ordinal 时，按 `(createdAt, sessionId)` 生成确定顺序。

这样不会出现“用户在看最后一个会话，中间突然插入一个新会话”的现象。

列表集合和分段进度条在一次同步轮开始前固定：已选中的本地会话 + 远端未拉取会话
一起成为分段槽位；会话进入传输阶段只更新自己的比例，不新增/重排分段槽位。
因此不会再出现“第一个会话进度满了，又突然冒出第二个会话，进度条倒回去”。

如果同步过程中服务端确实出现了新的远端会话，它只能作为新的尾部行追加；
不能插到已有行中间，也不能进入本轮的分段进度条（下一轮规划时才分配分段）。

## 4. 稳定 per-session 状态

每个会话维护一份状态，不能只保留最近一轮的方向报告：

```ts
interface SyncSessionState {
  sessionId: string
  ordinal: number

  local: {
    present: boolean
    attached: boolean
    live: boolean
    writeOwned: boolean
    cwdPending: boolean
  }

  remote: {
    present: boolean
    workspaceKey?: string
    lastSeq?: number
    deleted: boolean
  }

  selection: {
    uploadSelected: boolean
    pullEligible: boolean
  }

  upload: SyncLaneState
  download: SyncLaneState

  transaction: {
    pending?: { targetSeq: number }
    applying: boolean
    attachPending: boolean
  }

  attention?: {
    kind: 'blocked' | 'failed' | 'unmapped' | 'cwd' | 'write-owned' | 'local-ahead'
    message?: string
  }

  lastSeenRunId: number
}
```

同步报告只做 upsert：

```text
push report   → state.upload
pull report   → state.download
backfill pull → state.download
beginApply    → state.transaction
endApply      → state.transaction
attach        → state.local.attached
tombstone     → state.remote.deleted
```

本轮没有报告的会话保留；只有本地删除 + 远端 tombstone 才从列表移除。

## 5. 方向与 stage

每个方向有独立的 lane：

```ts
interface SyncLaneState {
  phase: 'idle' | 'planned' | 'active' | 'waiting' | 'done' | 'failed' | 'not-selected'
  stage: SyncStage
  doneEvents: number
  totalEvents: number
  error?: string
}
```

推送 stage：

```text
reading      读取会话
planning     计算批次
sealing      加密封帧
uploading    上传中
committing   提交清单
done         已完成
```

拉取 stage：

```text
reading      读取远端清单
downloading  下载中
verifying    校验中
applying     写入中
flushing     落盘中
projecting   预热标题
attaching    挂载中
done         已完成
```

等待 stage：

```text
waiting-write   等待官方写入
waiting-live    等待会话关闭
waiting-cwd     等待 cwd 处理
waiting-retry   等待重试
```

stage 必须来自引擎真实阶段，不在前端用定时器伪造。stage 只在变化时上报，
继续走现有 SSE 合并窗口，不能每个事件都 bump 状态。

## 6. 聚合 summary

不把全部事实硬压成一个 `skipped`。Host 派生 summary：

```text
blocked
failed
applying / attach-pending
write-owned / live / local-ahead   (deferred)
unmapped / cwd
transferring
planned
not-selected（仅本地、未选上传）
pull-only（已拉取、未选上传）
synced
idle
```

顺序：

```text
blocked > failed > write-owned > unmapped > cwd
> applying/attach > transferring > planned
> not-selected > pull-only > synced > idle
```

“未选上传”和“仅拉取”不是失败，也不是完成；它们只是选择状态。

## 7. 气泡计数

计数必须来自完整、稳定的列表：

```text
total      完整列表行数
active     正在传输/写入/挂载的行数
attention  blocked/failed/cwd/unmapped/write-owned 行数
synced     已一致且已选上传的行数
not-selected  仅本地未选上传的行数
pull-only  已拉取但未选上传的行数
```

头部不再使用：

```text
done + skipped / total
```

改为：

```text
同步中 N
待处理 N
已同步 N/M
```

未选上传和仅拉取显示为低亮行，不计入 `synced`。

## 8. 动效

进度条不改；它只表达事件/批次进度。

### 工作态

适用：

```text
reading / planning / sealing / uploading / committing
downloading / verifying / applying / flushing / projecting / attaching
```

圆点表现：

- 中心黄点保留；
- 外圈细弧线旋转（约 1.1–1.4s）；
- 低频呼吸光晕。

所有动画使用 CSS `transform` / `opacity` / `box-shadow`，不启动 JS 定时器。

### 等待态

适用：

```text
waiting-write / waiting-live / waiting-cwd / waiting-retry
```

表现：

- 不旋转；
- 慢速涟漪（约 2.4s）；
- 颜色略偏橙；
- 副标题显示具体原因。

“等待官方写入”必须持续可见，不能看起来像停止。

### 失败/完成

- failed：红色点 + 首次出现轻微闪烁；
- done：绿色静态点；
- not-selected：灰色静态点。

`prefers-reduced-motion: reduce` 时关闭旋转/涟漪，只保留静态环和颜色。

## 9. 自动滚动：跟随当前同步会话

自动滚动的焦点不是“列表底部”或“新追加的行”，而是**当前正在进行的同步行**。

`ongoing` 定义为：

```text
active stage: reading / planning / sealing / uploading / committing
             / downloading / verifying / applying / flushing
             / projecting / attaching
waiting stage: waiting-write / waiting-live / waiting-cwd
```

`waiting-retry` 不抢焦点，避免后台退避把用户视线拉走。

### 焦点选择

客户端维护一个 `focusSessionId`：

1. 当前没有焦点时，选择稳定顺序中最靠前的 `ongoing` 行；
2. 当前焦点仍处于 `ongoing` 时，不切换到其他行，避免多点并发时来回跳；
3. 当前焦点离开 `ongoing` 后，按稳定顺序选择下一条 `ongoing`；
4. 没有 `ongoing` 时，`focusSessionId = null`，停止自动滚动。

### 滚动规则

- 焦点变化时，只把该行滚动到**可见范围内**（`block: 'nearest'`），不强制居中/到底；
- 焦点行已经在可视范围内时，不产生滚动；
- 只更新行内 stage/进度时，不改变 `scrollTop`；
- 用户主动滚动后暂停跟随，保持当前位置，并显示“回到当前同步”按钮；
- 点击按钮后重新启用跟随并滚动到 `focusSessionId`；
- 用户手动滚回焦点行后，可以恢复跟随（阈值判断）；
- 新行追加只改变列表长度，不自动滚到底，也不自动切焦点；
- 只有新行成为 `ongoing` 时，才可能成为新的焦点。

实现上使用列表容器的 `scrollTop` / `scrollHeight` / `scrollIntoView({ block: 'nearest' })`，
不要使用全局 window 滚动。

状态给客户端的字段：

```text
focusSessionId
focusState: 'following' | 'paused' | 'idle'
offscreenChanges: number   // 暂停期间焦点/阶段变化的提示计数
```

暂停状态下的按钮文案优先使用“回到当前同步”，不要只说“回到底部”。

## 10. 状态接口

前端和 host 同版本，不需要旧气泡兼容层；直接替换为新 schema，并同步更新两端。

```ts
interface SyncSessionStatus {
  sessionId: string
  ordinal: number
  summary: SyncSessionSummary
  upload: SyncLaneStatus
  download: SyncLaneStatus
  local: { present: boolean; attached: boolean; live: boolean; writeOwned: boolean }
  remote: { present: boolean; workspaceKey?: string; deleted: boolean }
  selection: { uploadSelected: boolean; pullEligible: boolean }
  transaction: { applying: boolean; attachPending: boolean }
  attention?: { kind: string; message?: string }
}
```

`phase/push/pull/pending` 这类旧投影字段不再保留兼容；前端只读新的
`summary + upload/download lane + local/remote/selection`，host 和 client
随插件版本一起升级。

## 11. 客户端 selector

新增一个纯选择器，气泡不再自己 `.filter` / 拼 tag：

```js
selectBubbleView(status) => {
  rows: stableRows,
  total, active, attention, synced, notSelected, pullOnly,
  headerStage, headerSummary,
  focusSessionId, focusState, offscreenChanges,
}
```

行标签由 `summary + stage + attention` 统一映射；计数和头部文案只读 selector 结果。

## 12. 测试

必须覆盖：

- 未选中的本地会话不进入列表；
- 远端未拉取会话在同步前就存在；
- 选中本地会话在同步前存在；
- 新会话只追加到末尾，不插入中间；
- 同步完成后行仍在，显示“仅拉取/已同步”；
- 回填更新已有行，不重复；
- `write-owned` 为 waiting，不 failed；
- attach 失败保留“等待挂载”；
- tombstone 才移除；
- 计数不把未选上传算作 done；
- 自动滚动：焦点跟随当前 ongoing 行、上滚暂停、回到当前同步；
- 无 ongoing 时不抢焦点、不滚到底；
- reduced-motion 下无旋转/涟漪。

## 13. 实施顺序

1. Host 稳定状态表 + 完整列表谓词 + ordinal；
2. 引擎 stage 上报 + controller lane 更新；
3. 气泡 selector / 计数 / 标签；
4. 自动滚动与 ongoing 焦点跟随；
5. CSS 圆点动效；
6. 测试与可访问性收口。

传输引擎、进度条和加密协议不在本次改动范围内。
