# 会话变更历史与工作热力设计

> 状态：会话历史、回填、全局工作强度热力图、设备 Gantt、单会话小热力图与点击日期筛会话均已实现（schema v6）。目标：在**不触碰会话内容**的前提下，用服务端可见的元数据
> 展示单会话的变更时间线、设备切换，以及全局的工作强度热力图。

## 0. 实现状态

- ✅ `session_events` 表（schema v6）、append/设备删除/管理台四档写入；
- ✅ 从 `append_requests` 一次性回填；
- ✅ `devices.color` 持久化设备颜色，旧设备启动时自动补色；
- ✅ `GET /admin/sessions/:id/history`；
- ✅ 管理台会话详情抽屉（摘要 + 时间线 + 连续同设备运行段 + 设备色点/图例）；
- ✅ 全局工作强度热力图与 `/admin/activity` 聚合 API（默认 90 天，可展开选择起止日期）。
- ✅ 设备 Gantt、单会话 90 天小热力图、点击日期筛会话；
- ✅ 热力图宽屏默认 365 天、窄屏默认 90 天，可展开选择起止日期。

## 1. 范围与原则

- 只记录**元数据**：时间、设备、批次、事件增量、字节、seq 区间、动作；
- 不记录会话内容、token、口令；E2EE 保持不变；
- 设备名始终显示**当前名称**（来自 `devices.label`），不保存历史名；
- 设备颜色持久化在 `devices.color`，历史、热力图和后续统计共用同一份颜色，不靠前端临时哈希：
  - 改名后历史条目跟着改显示；
  - 已吊销设备的行仍保留，按 deviceId 查当前 label；
- 这是一条"活动账本"，不是备份：删除/重置会话后历史仍保留，用于审计与回顾。

## 2. 数据模型

### 2.1 `session_events`

```sql
CREATE TABLE IF NOT EXISTS session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,        -- 服务端时间
  kind        TEXT NOT NULL,           -- create | append | archive | remove | reset | restore
  device_id   TEXT,                    -- 设备动作时的 deviceId；admin 动作为 NULL
  actor_kind  TEXT NOT NULL,           -- device | admin | system
  events      INTEGER NOT NULL DEFAULT 0,  -- 本次新增事件数（seq 增量）
  bytes       INTEGER NOT NULL DEFAULT 0,  -- 本次新增密文字节
  seq_from    INTEGER,                 -- 本次覆盖的 seq 区间
  seq_to      INTEGER,
  batch_count INTEGER NOT NULL DEFAULT 0,
  last_seq    INTEGER,                 -- 动作后的会话 lastSeq
  stored_bytes INTEGER,                -- 动作后的会话总字节
  detail      TEXT                     -- 脱敏 JSON：tailReplaced、reason、createdAt 等
);
CREATE INDEX IF NOT EXISTS session_events_by_session ON session_events (dataset, session_id, at);
CREATE INDEX IF NOT EXISTS session_events_by_time ON session_events (dataset, at);
```

写入点：

| 动作 | kind | events / bytes | 说明 |
|---|---|---|---|
| 首次 append（会话不存在） | `create` | 本次批次事件数 / 新增字节 | 同时表示"初次上传" |
| 后续 append | `append` | `lastSeq` 增量 / `stored_bytes` 增量 | 尾部替换时 `events=0`，`detail.tailReplaced=true` |
| 设备删除（现有 `deleteSession`） | `archive` 或独立 `device-delete` | 0 | 保留现有语义 |
| 管理台存档 | `archive` | 0 | |
| 管理台移除 | `remove` | 0 | |
| 管理台重置 | `reset` | 0 | `detail.deviceId` 记录指定上传方 |
| 管理台恢复 | `restore` | 0 | |

> `bytes` 用 `stored_bytes` 差值；压缩/尾部替换可能为 0 或负值，负值按 0 记，原始差值放 `detail`。

### 2.2 事件增量怎么算

- append 前读取旧 summary（`last_seq`、`stored_bytes`）；
- `events = max(0, newLastSeq - oldLastSeq)`；
- `bytes = max(0, newStoredBytes - oldStoredBytes)`；
- `seq_from/seq_to` 从本次 append 的批次范围推导（manifest 新帧的 `seqFrom/seqTo`）；
- 尾部替换（`baseIndex` 小于旧帧数 - 1）时 `events=0`，`detail.tailReplaced=true`。

### 2.3 `daily_activity`（可选，后续）

初期直接查 `session_events` 聚合；真实数据只有几百条，足够。
当事件行数超过约 10 万时，再加按天聚合表：

```sql
daily_activity(day TEXT, events INTEGER, bytes INTEGER, appends INTEGER, sessions INTEGER, devices INTEGER)
```

聚合按**浏览器时区**的日界在后端计算（API 接收 `tz` 偏移），避免客户端重复拉全量。

## 3. 历史回填

现有 `append_requests` 已有 `session_id`、`device_id`、`created_at`、`result_json`，可一次性回填：

1. 按 `session_id, created_at` 排序；
2. 首次记录 → `create`；
3. 相邻 `lastSeq` 差值 → `events`；
4. `storedBytes` 差值 → `bytes`；
5. `detail.backfilled = true`，时间使用请求的 `created_at`。

回填是幂等的：`session_events` 增加 `detail.backfillRun` 或在迁移 meta 里记标记，只跑一次。

## 4. 单会话时间线

### 4.1 展示

```text
● 11-01 12:00  创建        v4 · workspaceKey QEzr…
● 12:01       初次上传      laptop · 2 批 · 140 事件 · 1.2 MiB
● 12:07       更新          laptop · +40 事件 · 220 KiB
● 13:20       设备切换      laptop → desktop
● 13:21       更新          desktop · +12 事件 · 80 KiB
● 11-08 09:00  存档         admin
● 11-09 10:00  恢复         admin
● 11-10 11:00  重置         admin → 指定 desktop 重建
```

- 连续同一设备的 append 合并为"运行段"（例如"12:07–12:40 · laptop · 8 次 · +320 事件"）；
- 设备切换单独成行；
- 删除/存档/重置/恢复用不同颜色；
- 时间显示相对时间，`title` 保留绝对时间；
- `createdAt`（客户端时钟）与首次 append（服务端时钟）都展示，差值超过阈值时标注"时钟偏差"。

### 4.2 摘要统计

```text
总事件 1,240 · 总批次 26 · 5.2 MiB · 设备 2 · 活跃 4 天
首次 11-01 · 最后 11-03 · 最大单批 50 事件
laptop 78% / desktop 22%（按事件）
```

全部从 `session_events` 聚合，不额外存储。

### 4.3 设备 Gantt

- 横轴时间，每个设备一条色带；
- 只显示有事件的设备；
- 悬停显示该段的事件/字节；
- 设备名用当前 label。

## 5. 工作强度热力图

### 5.1 形式

- 365 天（可选 30 / 90 天）格子；
- 每格颜色按**当前范围内活跃天的分位数**动态分档（25/50/75%），最大值固定最深色；
  这样日常 1k–7k 事件也能拉开层次，不会全被首日 20 万压成同一档；
- 悬停：日期、事件、字节、批次数、会话数、设备；
- 点击某天：筛选当天有活动的会话；
- 过滤：设备、会话；
- 单会话详情里也可放一个 90 天小热力图。

### 5.2 口径

- 默认用**事件增量**；提供"字节"切换；
- 这是"同步活动"，不是打字量：一次积压 5000 事件会呈现为一个尖峰；
- 时区：按**查看者浏览器**的日界聚合；后端 API 接收 `tzOffset`（分钟），返回该时区下的日桶；
- 不展示会话内容，不按内容推断工作类型。

## 6. API

```text
GET /admin/sessions/:id/history?limit=200&before=<id>
  -> { events: [...], summary: { events, bytes, batches, devices, firstAt, lastAt } }

GET /admin/activity?from=<ms>&to=<ms>&deviceId=&sessionId=&tzOffset=<min>
  -> { days: [{ day: '2026-11-01', events, bytes, appends, sessions, devices }] }

GET /admin/activity/sessions?day=2026-11-01&tzOffset=<min>
  -> [{ sessionId, workspaceKey, events, bytes, devices }]
```

- 历史分页按 `id` 倒序游标；
- 热力图接口只返回聚合，不返回逐条事件；
- 设备过滤按 `device_id`，显示名由 `devices` 当前 label 决定。

## 7. 管理台 UI

### 7.1 会话详情抽屉

- 从会话表点击行或「详情」打开；
- 顶部：sessionId、workspaceKey（别名）、格式、当前大小、状态；
- 中部：摘要统计 + 时间线 / 设备 Gantt / 小热力图切换；
- 底部：复制 session id、关闭；
- 未来的删除/存档/重置动作也放在这里。

### 7.2 概览页

- 新增一张「工作强度」卡片：365 天热力图 + 设备图例；
- 点击日期跳到当天会话列表；
- 数据为空时显示"还没有同步活动"。

### 7.3 审计页

- 与工作强度分开：审计记录**管理动作**（登录、设备、配额、密码、删除），
  会话历史记录**数据变化**（append/delete/reset）；
- 两者共享设备显示名规则。

## 8. 隐私与保留

- 仅元数据；不存内容、token、口令；
- 设备名始终为当前名：改名会影响历史显示，这是有意的简化；
- 会话历史默认**永久保留**（体积很小：每 append 一行，真实数据仅数百行）；
- 若未来需要清理，按 `at` 保留最近 N 天，或按 session 删除；不自动删破坏性动作。

## 9. 边界

1. **时钟偏差**：`createdAt` 是客户端时钟，首次 append 是服务端时钟，分别展示；
2. **尾部替换**：`events=0`，时间线仍显示 append，并标注"替换尾部"；
3. **设备改名/吊销**：历史显示当前 label；吊销设备仍可查 label；
4. **会话被移除/重置**：历史保留，时间线显示对应动作；
5. **回填数据**：`detail.backfilled=true`，UI 可加"回填"标记；
6. **附件**：目前不参与，未来附件同步后单独统计。

## 10. 测试

- append 写入 `create` / `append` 事件，events/bytes 正确；
- 尾部替换事件 `events=0` 且标记；
- 存档/移除/重置/恢复各写一条事件（随删除设计实现）；
- 历史 API 分页、倒序、summary 聚合；
- 热力图按 `tzOffset` 分日，跨日边界正确；
- 已吊销设备的 label 仍能显示；
- 回填脚本幂等（重复运行不重复插入）。

## 11. 实施顺序

1. `session_events` 表 + append/delete 写入 + 回填；
2. 历史 API + 会话详情抽屉；
3. 活动 API + 概览热力图；
4. 设备 Gantt / 单会话小热力图；
5. 数据量上来后再加 `daily_activity` 聚合。

## 12. 已定 / 待定

已定：

- 设备名显示**当前名称**，不保存历史名；
- 强度默认按**事件增量**；
- 会话历史默认**永久保留**；
- 时间线中的日期按浏览器本地时区展示。

待定：

- 是否在概览默认展示 365 天还是 90 天；
- 热力图点击后的会话列表是否复用主表筛选；
- 是否需要"导出会话历史 CSV"。
