# M0：外部写入会话 + attachSession 的可见性实验（含全链路）

结论（2026-10-19，DSH 0.2.1-rc.2，隔离 web 实例）：

1. **宿主无需重启就能发现外部写入的会话**：`sessionPersistence.create` 写入后，
   `sessionQuery.listSessions()` 立刻返回它（`persisted: true`），`workspace.attachSession(id)`
   把它挂进工作区，`/api/session/list` 也包含它。
2. **单纯写入 + attach 不会通知已打开的客户端**：侧栏不会自己更新；需要
   （a）宿主侧**预热**（`sessionController.resolveAgent`，会把 live 会话推给客户端），或
   （b）客户端调 `ctx.get('sessions').refresh()` 重拉基线。
3. **冷会话没有投影，列表显示「未命名」**：`sessionQuery.readSession` 不会写入投影缓存；
   只有会话被**复活**（`resolveAgent`）后，`/api/session/list` 才有 `title` / `stats` 等投影。
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
   `{ inject: ['sessions'], apply(ctx) }`。

## 全链路验证

`tests/m0/e2e/` 是**单包双端**的实验：宿主半提供 `/m0/ingest`（写入 → `handle.close()` →
`attachSession` → `resolveAgent` 预热）和 `/m0/state`；客户端半每秒轮询 `/m0/state`，
发现 revision 变化就 `sessions.refresh()`。

实测（页面保持打开、不刷新）：

- 触发 ingest 后约 1–3 秒，侧栏自动出现新工作区 **M0 E2E**；
- 会话 **M0 E2E probe** 带正确标题出现；
- 点开会话，内容正常渲染（1 轮 1 步、2 tok）。

对同步插件的含义：

```text
拉取一帧链 → 写入目标会话 → handle.close()
  → workspaceRegistry.resolveByPath(cwd) ?? create(cwd)
  → workspace.attachSession(id)
  → （可选）逐会话 sessionController.resolveAgent(id) 预热投影
  → 客户端轮询/被通知后 sessions.refresh()
```

批量拉取时建议：先批量写入 + attach，再按需预热，最后客户端 `refresh()` 一次，
避免每个会话都触发一次基线重拉。

## 复现

```sh
# 1) 安装（临时 home 在仓库 .tmp 下；bundle 会自己注册）
DSH_HOME=.tmp/dev-dsh/home dsh plugin --profile web add tests/m0/e2e
# 2) 起隔离实例
node scripts/dev-dsh.mjs --port 3090
# 3) 打开页面（token 见启动日志），然后触发一次 ingest
curl "http://127.0.0.1:3090/m0/ingest?id=session-m0-e2e&dir=m0-e2e-workspace&title=M0%20E2E%20probe&warm=1"
```

返回 `warm: "resolved"` 即复活成功；客户端日志里会出现 `[m0-e2e] 已刷新列表`。

## 控制台

`pnpm dev:console` 起一个本地控制台（<http://127.0.0.1:3091/>，零依赖、只绑 127.0.0.1）：

- **状态**：宿主是否在跑、工作区与会话目录、实验 bundle、最近一次测试结果；
- **启动 / 停止**隔离宿主；
- **启动后自动打开宿主页面**（勾选后等宿主启动完成、拿到 token 再打开；被浏览器拦截时，日志里给可点链接兜底）；
- **触发 ingest**（自动带 `warm=1`）；
- **运行测试**（`pnpm check`，结果显示通过/失败与输出尾部）；
- **清理遗留**：只清 `m0-*` 工作区、`m0-*` 会话目录与 `m0-*` 工作区目录，默认工作区不动。
