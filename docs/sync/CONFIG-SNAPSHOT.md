# 插件配置快照与选择模型

> 目标：让设置页、首启向导、顶部气泡、映射页读取**同一份生效配置**，
> 不再各自计算默认值、选中数和映射状态。

## 1. 为什么需要重构（历史背景）

重构前读路径分散在：

- `GET /status`：运行态；
- `GET /setup`：非敏感配置 + 凭据来源；
- `GET /workspaces`：本机会话、远端工作区、绑定、未映射；
- 客户端设置页又拿 DSH form 的 `value` 做本地兜底。

三套数据各有自己的默认值和计数逻辑，导致：

- 设置页显示“已配置”，气泡显示“未配置”；
- 远端工作区计数来自 `controller.unmapped`，没 pull 时全是 0；
- 绑定页能绑到本机自己的派生 key，形成“空气映射”；
- 前端自己算选中数，和引擎实际选择不一致。

## 2. 单一事实源：SyncConfigSnapshot

宿主 `control.config()` 合成一份快照，`GET /api/session-cloudsync/config` 返回（类型见 `packages/plugin/src/status.ts`，组装见 `packages/plugin/src/index.ts` 的 `control.config`）：

```ts
interface SyncConfigSnapshot {
  schemaVersion: 2
  generatedAt: number
  setup: SetupInfo                 // 非敏感配置 + 凭据来源
  status: SyncStatus               // 生成时刻的运行态；schemaVersion 2
  workspaces: SyncWorkspaceList    // 本机/远端工作区、根会话列表、绑定、未映射
  selection: {
    uploadRootIds: readonly string[]              // 上传白名单，即 setup.syncSessionIds
    pull: { readonly mode: 'bound-workspaces' }   // 绑定工作区即允许拉取
  }
}
```

`SetupInfo` 里与“生效值”相关的字段：

- `serverUrl` / `deviceName` 各带 `serverUrlSource` / `deviceNameSource`（`'env' | 'settings'`）；
- `autoSync`、`intervalMs`、`includeSubagents`、`syncSessionIds` 都是当前生效值；
- 凭据只有 `hasToken` / `hasPassphrase`、`tokenSource` / `passphraseSource` 和 `credentialRefs`，不返回值；
- `batchEvents` / `batchBytes` / `requestTimeoutMs` 只在宿主配置里，快照不暴露。

规则：

- 客户端首选 `/config`；请求失败才回退 `/setup` + `/status` + `/workspaces`（`packages/plugin/client/index.js` 的 `refreshConfig`）；
- 选中数、远端会话数、映射可用性全部由 Host 计算；
- `status` 是生成时刻的运行态；实时进度继续走 SSE（`/events`），SSE 只更新 status；
- 旧 `/setup`、`/workspaces` 保留，供旧客户端回退；
- 早期设计里的 `config`（`EffectiveValue`）、`credentials`、`sessions.localRoots/remoteRoots`、`runtime`、`warnings`、`configRevision` **没有实现**；实际快照就是上面这个形状。

## 3. 选择模型（已定 A）

```ts
selection: {
  uploadRootIds: string[]              // 上传白名单，默认 []
  pull: { mode: 'bound-workspaces' }   // 绑定工作区即允许拉取
}
```

- **上传**：只上传白名单里的本地根会话；子代理跟随根；新会话默认不进白名单。
- **拉取**：上传白名单不限制拉取。规划范围是「绑定工作区下的根 + 已选根」
  （`index.ts` 的 `plannedRoots`）；落点仍要求远端 `workspaceKey` 能解析到本机路径
  （bindings 或本机 canonical path → key），未映射则只显示 `unmapped`。
- 远端会话不需要第二次勾选；上传侧已经过滤过。
- **首次成功拉取的根会话会自动补进上传白名单**；用户之后手动取消不会被重新加回（`index.ts` 的 `onFirstPull` → `flushAutoUpload`，只在首次冷拉取时触发）。
- 配置字段暂时仍叫 `syncSessionIds`（兼容已提交的配置），但语义已经收窄为“上传白名单”；快照对外暴露为 `selection.uploadRootIds`。

B 的案例：服务端 `session-bench-shape` 的 `workspaceKey=8hFb...`，
B 绑定 `8hFb...` 后就直接具备拉取资格，不再依赖本地不存在的会话 id 进白名单。

### 拉取写所有权

`ctx.sessions.get(id) === undefined` 只表示“没有已注册的 live Session”，
不能推导“没有写者”。当前拉取顺序：

```text
stat(id)
→ open(id, 'read') 先比较本地/远端
→ 只有确实落后时才 open(id, 'write')
→ SessionAlreadyOwnedError 归类为 write-owned/deferred，不当作错误
```

所有 pull（整轮任务与单会话定向拉取）共用进程内的 `withPullLock`（`index.ts` 中
`pullSessionTask` 的调用点）；旧的映射回填入口（`controller.beginBackfill` /
`recordBackfill`）已无调用方，映射后由下一轮摘要扫描重新规划并拉取（`index.ts` 的 `runSync` 注释）。

## 4. 远端清单

`SyncWorkspaceList.remoteWorkspaces` 来自服务端的会话摘要列表（`index.ts` 的 `readRemoteSummaries`，分页 `GET /v2/sessions?cursor=…&limit=200`）：

- 每条摘要带 sessionId、`lastSeq`、`workspaceKey`、`deletedAt`，以及 `parentSession` / `origin` / `delegationDepth`；
- 按 workspaceKey 聚合 sessionId 列表与数量（`remoteWorkspaces[].sessionIds` / `.sessions`）；
- 结果按 `serverUrl + token` 做 15s TTL 缓存（`index.ts` 的 `readRemoteSummaries`）；推送/拉取后主动失效，避免设置页刷新反复全量拉取。

这样映射页的会话数来自真实远端摘要；Vault 里只有 `workspace/profile`、还没有会话的
远端工作区仍会出现在待映射列表（供首启预绑定），计数为 0。

本机 canonical path 派生出的 key 在映射页显示为“本机身份”，不进入待映射（unmapped）列表。

## 5. 保存交互

**当前实现**（P3 未完成自动保存）：设置页顶部是 sticky 保存条，显示
`正在保存… / 有未保存修改 / 非敏感配置已保存`；字段改动只置 dirty，需点
「保存配置」。保存走 DSH settings 表单的 `mutate`，成功后 `refreshAll`
（`client/index.js` 的 `persistFields` / `save`）。token / passphrase 与普通字段
同一次保存，但有值才写。

**设计目标（未实现）**：

- 字段修改后 debounce 自动保存；勾选会话、开关立即保存；
- 页面底部不再放唯一保存按钮。

env 覆盖字段只读并显示来源：这部分已实现。

写入协议（设计稿）：

```text
POST /api/session-cloudsync/config
{
  expectedRevision: number,
  patch: { ...非敏感字段... }
}
```

- revision 不匹配 → 409，保留草稿并提示；
- 写入成功返回完整新 snapshot，前端不做本地乐观合并。

`POST /api/session-cloudsync/config` 目前不存在：`host-api.ts` 只注册了 `GET /config`。

## 6. 一轮同步的任务顺序

正常轮次走**任务模式**（`packages/plugin/src/controller.ts` 的 `runTaskMode`；宿主始终注入
`tasks`，见 `index.ts` 的 `controller` 构造）：

1. `scan`：只读规划（`planRound`：本地快照 + 远端摘要 + receipt + 绑定），不做传输；
2. 手动同步把候选会话全部置为 `checking`，校验后移除 up-to-date 行；自动同步只把
   需要动作或 `blocked` 的行放进任务表（`index.ts` 的 `taskRunner.scan`）；
3. 按任务表逐个执行**一个方向**：push 或 pull，每个会话最多一项
   （`controller.ts` 的 `executeTaskList`）。

所以不存在“先全推、再全拉”。旧 `run()` 里“先 push 再 pull”的整轮路径仍保留
（`controller.ts` 的 `run`），但注入 tasks 后正常轮次不会走到。

历史设计理由（同一个会话上 push 必须早于 pull）仍然成立：

1. 会话是 append-only 事件链，共享前缀必须逐帧一致（唯一例外是同一 seq 的两条
   `session/end-seed` 空标记，见 `shared/src/chain.ts` 的 `markerEquivalent`）；
2. 分叉不能 merge/rebase，只能硬停并人工选择；
3. push 先做一次 preflight：远端缺失→首次上传；落后→快进；领先→remote-ahead；前缀不一致→diverged；
4. 只有持有全局单写者租约的设备才 push；pull 始终允许；
5. live/开放尾会话可以先备份，pull 延后，等关闭后再应用。

旧的 push-first 是“先发布本机权威写入，再吸收远端”；现在的任务模式把“顺序”收敛为
“每个会话只有一个方向”。pull-first 仍需要合并能力，当前没有这个需求，也不应伪装成 git。

## 7. 实施阶段

- **P0**：SyncConfigSnapshot 类型、`GET /config`、客户端 model 单请求；
- **P1**：`uploadSessionIds` 迁移；pull 改为 bound-workspaces；修 B 死锁；
- **P2**：远端 cursor/manifest 清单、真实计数、本机身份排除；
- **P3**：`POST /config` + revision；非敏感自动保存；env 来源展示；
- **P4**：快照一致性/远端拉取/保存冲突测试；
- **P5**：`planEventBatches` 移出 host 事件循环，修 69k 会话 40s 阻塞。

当前落地情况：

- P0 已完成：`SyncConfigSnapshot`、`GET /config`、客户端 `/config` 单请求（旧端点回退兼容）；
- P1 已完成：上传白名单仍用 `syncSessionIds`，拉取不以它为限制，绑定 workspace 即可拉取；字段重命名留到下一次配置迁移；
- P2 部分完成：`workspaces()` 读取远端 cursor/manifest 统计真实会话数，并过滤本机身份候选；
- P3 部分完成：设置页改为顶部 sticky 保存条 + dirty 状态，保存仍走 DSH settings 表单；`POST /config` 与自动保存尚未落地；
- P4 部分完成：类型检查/现有测试通过；远端-only 拉取有引擎测试；
- P5 部分完成：推送改用 `iterateEventBatches` 增量分批，并在 8ms 间隔让出事件循环
  （`engine.ts` 的 push 循环）；拉取按 500 事件切片 append（`appendPulledEvents`）。
  剩余是整段日志读取/解压仍在宿主进程内完成，未核实还能拆到什么程度。

## 8. 验收

- 设置页、向导、气泡对同一时刻的配置/计数一致；
- env 覆盖字段有明确来源且不可静默覆盖；
- B 绑定 A 的 workspaceKey 后能自动拉取 `session-bench-shape`；
- 远端工作区显示真实会话数，本机身份不出现为待映射；
- 非敏感修改无需找底部按钮即可保存（目标；当前仍需点顶部「保存配置」）；
- 测试覆盖上述路径。
