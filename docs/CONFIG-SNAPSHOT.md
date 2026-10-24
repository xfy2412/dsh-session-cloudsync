# 插件配置快照与选择模型

> 目标：让设置页、首启向导、顶部气泡、映射页读取**同一份生效配置**，
> 不再各自计算默认值、选中数和映射状态。

## 1. 为什么需要重构

当前读路径分散在：

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

Host 新增 `configSnapshot()`，`GET /api/session-cloudsync/config` 返回：

```ts
interface SyncConfigSnapshot {
  schemaVersion: 2
  generatedAt: number
  configRevision: number

  config: {
    serverUrl: EffectiveValue<string>
    deviceName: EffectiveValue<string>
    autoSync: EffectiveValue<boolean>
    intervalMs: EffectiveValue<number>
    includeSubagents: EffectiveValue<boolean>
    batchEvents: EffectiveValue<number>
    batchBytes: EffectiveValue<number>
    requestTimeoutMs: EffectiveValue<number>
    uploadSessionIds: string[]
  }

  credentials: {
    token: { configured: boolean; source: CredentialSource; ref: string }
    passphrase: { configured: boolean; source: CredentialSource; ref: string }
  }

  selection: {
    uploadRootIds: string[]
    pull: { mode: 'bound-workspaces' }
  }

  sessions: {
    localRoots: Array<{
      sessionId: string
      workspacePath: string
      eventCount: number
      uploadSelected: boolean
    }>
    remoteRoots: Array<{
      sessionId: string
      workspaceKey: string
      lastSeq: number
      pullEligible: boolean
    }>
  }

  workspaces: {
    locals: Array<{ path: string; title: string; workspaceKey?: string }>
    remotes: Array<{
      workspaceKey: string
      label?: string
      sessionIds: string[]
      sessionCount: number
      localPath?: string
    }>
    bindings: Array<{ workspaceKey: string; localPath: string; label: string }>
    unmapped: Array<{ workspaceKey: string; label?: string; sessionCount: number }>
  }

  runtime: SyncStatus
  warnings: Array<{
    code: string
    severity: 'info' | 'warn' | 'error'
    message: string
    field?: string
    sessionId?: string
  }>
}
```

规则：

- 只返回**生效值**；`EffectiveValue` 带 `source: 'env' | 'settings' | 'default'` 和 `overridden`；
- 凭据只返回存在性、来源和引用名，不返回值；
- 选中数、远端会话数、映射可用性全部由 Host 计算；
- `runtime` 是生成时刻的运行态；实时进度继续走 SSE，但 SSE 只更新 runtime；
- 旧 `/setup`、`/workspaces` 保留兼容，内部从同一批数据派生。

## 3. 选择模型（已定 A）

```ts
selection: {
  uploadRootIds: string[]              // 上传白名单，默认 []
  pull: { mode: 'bound-workspaces' }   // 绑定工作区即允许拉取
}
```

- **上传**：只上传白名单里的本地根会话；子代理跟随根；新会话默认不进白名单。
- **拉取**：不读上传白名单。远端根会话的 `workspaceKey` 能解析到本机路径
  （bindings 或本机 canonical path → key）就拉；未映射则只显示 `unmapped`。
- 远端会话不需要第二次勾选；上传侧已经过滤过。
- 配置字段暂时仍叫 `syncSessionIds`（兼容已提交的配置），但语义已经收窄为“上传白名单”；快照对外暴露为 `selection.uploadRootIds`。

B 的案例：服务端 `session-bench-shape` 的 `workspaceKey=8hFb...`，
B 绑定 `8hFb...` 后就直接具备拉取资格，不再依赖本地不存在的会话 id 进白名单。

## 4. 远端清单

`workspaces.remotes` 必须来自服务端 cursor + manifest：

- 读取 cursor 得到 sessionId/revision；
- 读 manifest 得到 `workspaceKey`、`lastSeq`、`deletedAt`；
- 按 workspaceKey 聚合 sessionIds/sessionCount；
- 结果按服务端 revision 缓存，避免设置页刷新反复全量拉取。

这样映射页不会再把 0 会话的占位 workspace 当成可绑目标。

本机 canonical path 派生出的 key 标记为“本机身份”，不进入待映射候选。

## 5. 保存交互

非敏感配置：

- 字段修改后 debounce 自动保存；
- 勾选会话、开关立即保存；
- 顶部常驻状态条：`正在保存 / 已保存 / 保存失败 / 有未保存修改`；
- 页面底部不再放唯一保存按钮。

凭据：

- token / passphrase 仍显式保存，避免半输入口令入库；
- 保存后刷新 snapshot。

写入协议：

```text
POST /api/session-cloudsync/config
{
  expectedRevision: number,
  patch: { ...非敏感字段... }
}
```

- revision 不匹配 → 409，保留草稿并提示；
- 环境变量覆盖字段只读，显示来源；
- 写入成功返回完整新 snapshot，前端不做本地乐观合并。

## 6. 推送/拉取顺序

当前 `push` 先于 `pull`，不是随意定的：

1. 会话是 append-only 事件链，共享前缀必须逐帧一致；
2. 分叉不能 merge/rebase，只能硬停并人工选择；
3. push 先做一次 preflight：远端缺失→首次上传；落后→快进；领先→remote-ahead；前缀不一致→diverged；
4. 只有持有全局单写者租约的设备才 push；pull 始终允许；
5. live/开放尾会话可以先备份，pull 延后，等关闭后再应用。

所以 push-first 是“先发布本机权威写入，再吸收远端”；pull-first 需要合并能力，当前没有这个需求，也不应伪装成 git。

## 7. 实施阶段

- **P0**：SyncConfigSnapshot 类型、`GET /config`、客户端 model 单请求；
- **P1**：`uploadSessionIds` 迁移；pull 改为 bound-workspaces；修 B 死锁；
- **P2**：远端 cursor/manifest 清单、真实计数、本机身份排除；
- **P3**：`POST /config` + revision；非敏感自动保存；env 来源展示；
- **P4**：快照一致性/远端拉取/保存冲突测试；
- **P5**：`planEventBatches` 移出 host 事件循环，修 69k 会话 40s 阻塞。

当前落地情况：

- P0 已完成：`SyncConfigSnapshot`、`GET /config`、客户端 `/config` 单请求（旧端点回退兼容）；
- P1 已完成：上传白名单仍用 `syncSessionIds`，拉取不再读它，绑定 workspace 即可拉取；字段重命名留到下一次配置迁移；
- P2 部分完成：`workspaces()` 读取远端 cursor/manifest 统计真实会话数，并过滤本机身份候选；
- P3 部分完成：设置页改为顶部 sticky 保存条 + dirty 状态，保存仍走 DSH settings 表单；`POST /config` 与自动保存尚未落地；
- P4 部分完成：类型检查/现有测试通过；远端-only 拉取有引擎测试；
- P5 未开始。

## 8. 验收

- 设置页、向导、气泡对同一时刻的配置/计数一致；
- env 覆盖字段有明确来源且不可静默覆盖；
- B 绑定 A 的 workspaceKey 后能自动拉取 `session-bench-shape`；
- 远端工作区显示真实会话数，本机身份不出现为待映射；
- 非敏感修改无需找底部按钮即可保存；
- 测试覆盖上述路径。
