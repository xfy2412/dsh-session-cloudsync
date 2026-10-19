# M0：外部写入会话 + attachSession 的可见性实验

结论（2026-10-19，DSH 0.2.1-rc.2，隔离 web 实例）：

1. **宿主无需重启就能发现外部写入的会话**：`sessionPersistence.create` 写入后，
   `sessionQuery.listSessions()` 立刻返回它（`persisted: true`），`workspace.attachSession(id)`
   把它挂进工作区，`/api/session/list` 也包含它。
2. **客户端不会实时刷新**：页面开着时，新工作区/新会话不会出现在侧栏；**刷新页面**后才出现。
   （列表是拉取式的，不是推送式的。）
3. **冷会话没有投影，列表显示「未命名」**：`sessionQuery.readSession` 不会写入投影缓存；
   只有会话被**复活**（`sessionController.resolveAgent`，即 resolve-or-resume）后，
   `/api/session/list` 才有 `title` / `stats` 等投影。
4. **复活前必须先关掉写句柄**：`sessionPersistence.create` 的 `handle.close()` 之前调用
   `resolveAgent` 会得到 `session/writer-held`。关闭后复活成功；会话之后被释放时，
   投影缓存会留下 `cached` 记录（标题仍在）。
5. `resolveAgent` 的返回值里可能有 Cordis 服务代理，**不要 `JSON.stringify` 整个结果**（读
   `toJSON` 会抛 `cannot get property "toJSON" without inject`）。
6. **前端可以触发列表刷新，不需要整页刷新**：客户端服务 `ctx.get('sessions')` 暴露
   `refresh()`（`ClientSessions.refresh`，重拉 Host 的会话基线）。实测：页面开着时，
   冷写入的 `session-m0-live8` 在调用 `refresh()` 前**不在** `sessions.list`，调用后立即出现。
   工作区列表走自己的 follow 流，会自行推送（实测新工作区不刷新就出现）；`IWorkspaces`
   没有公开的 refresh 方法。
7. 客户端模块的接法：`package.json` 里声明 `dsh.client`（`platform: web`、`immediately`），
   `client.js` 用 `window.__ModuleLoader__.load({ id, factory })`，`factory` 返回
   `{ inject: ['sessions'], apply(ctx) }`。最小示例见 `tests/m0/client-plugin/`。

对同步插件的含义：

```text
拉取一帧链 → 写入目标会话 → handle.close()
  → workspaceRegistry.resolveByPath(cwd) ?? create(cwd)
  → workspace.attachSession(id)
  → （可选）逐会话 sessionController.resolveAgent(id) 预热投影
  → 客户端刷新后可见（标题正常）
```

不做预热也能用（刷新后是「未命名」，点开即恢复标题）；预热让列表在刷新后就正确。
预热是否要立刻释放 agent、以及批量预热的成本，留给 M1 验证。

复现：

```sh
# 1) 把本目录的插件装进隔离 profile（临时 home，仓库内 .tmp）
DSH_HOME=.tmp/dev-dsh/home dsh plugin --profile web add tests/m0/plugin
# 2) 用附加 patch 插入插件行（见 .tmp/dev-dsh/m0.yml）
node scripts/dev-dsh.mjs --port 3090 --patch .tmp/dev-dsh/m0.yml
# 3) 触发一次 ingest（可带 id/dir/title/warm 参数）
curl "http://127.0.0.1:3090/m0/ingest?id=session-m0-live&dir=m0-live-workspace&title=M0%20live&warm=1"
```

`warm=1` 时返回 `warm: "resolved"` 即复活成功。验证列表投影可直接复用页面里的
`POST /api/session/list`（见本文件第 3 条）。
