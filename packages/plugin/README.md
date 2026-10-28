# dsh-session-cloudsync

DSH 会话云同步插件：自部署服务端、端到端加密，同步根会话与子代理闭包。

## 能力

- v2 API：`/v2/*`、opaque changes cursor、幂等 append；
- 事件批次增量推送/拉取；批次哈希、zstd 压缩后 AES-256-GCM 封批次；
- 批量 blob 上传/下载：8 MiB / 64 条分组，Vault blob 复用同一接口；
- 服务端只存密文、manifest、压缩状态与 blob 去重，不持有明文口令；
- **多设备必须使用同一同步口令**；默认盐由 `serverUrl` 派生，所以服务端地址写法也必须一致（不要混用 `localhost` / `127.0.0.1` 或省略 `//`）。设备 token 只用于鉴权，不参与解密；口令、地址或 `salt` 任一不同都会报 `keyId` 不符；
- 开放尾只备份、不直接 apply；拉取带 durable pending journal；
- 根会话选择：**默认不选中任何根会话**，`syncSessionIds` 是白名单；子代理跟随根会话闭包，fork 是独立根；新会话不会自动进入白名单；
- 工作区映射：未映射会话持久化、映射后按 cursor revision 回填；本地工作区自己的 key 自动解析；已有远端会话沿用原 key；设置页/首启显示本机↔远端配对表（已绑定/本机身份/仅本机/待映射）、统计和待映射选择，绑定前二次确认；
- Plugins 页自定义设置页 + 首启向导 + 顶部同步气泡；气泡行显示 `zstd` / `zstd 混合` 压缩状态；
- **使用协议**：首启向导在完成前展示协议并要求勾选同意；已配置用户检测到协议内容 hash 变化时弹出更新提示，接受版本记录在浏览器本地；
- 状态 v2：每个会话只有一行（push/pull 作为两个方向子状态），每行带待上传/待下载事件数、已完成/总数与 `statusVersion`，顶层带全局 `deviceLease`；运行中每上传/下载完一帧就更新完成事件数，气泡按事件比例推进；
- **入口级 open guard**：client 侧包一层 `uiWorkspace.openSession`，覆盖搜索结果、schedule、feedback、workflow-run、subagent 等没有 `data-row-key` 的入口；冷危险会话直接 toast + 不导航，live 会话放行；服务探测/安装失败一律 fail-open，不影响插件加载；
- **按需长连接**：默认只轮询 `/status`；手动同步或接近 `nextRunAt` 时打开 `/api/session-cloudsync/events?until=idle`，空闲/终态后关闭，SSE 失败退避到 1s 轮询；页面隐藏时断开；
- **自调度**：自动同步用绝对 `nextRunAt`（`setTimeout`）取代固定 `setInterval`，手动触发会清掉当前排期并在结束后重排；失败退避时间参与下一次排期；
- 气泡标题优先 durable title，空白会话显示“未命名会话”，不再把 cwd 目录名当标题；新拉取的冷会话在 attach 前会用本地日志预热 DSH 投影缓存，避免列表标题为空；
- **全局单写者租约**：进程存活期间持续持有 `sync` 租约（20s 续租、服务端 TTL 60s）；没有 held 时只拉取、不上传，服务端 append/create/delete 也要求它；进程正常退出主动释放，异常退出靠 TTL；拉取始终不需要租约；
- 冷会话在同步中/开放尾/安全边界落后时，侧栏行会被拦截并显示原因；live 会话允许打开/切换，由 composer 拦截输入；
- “接受远端”只生成停机脚本：检查 DSH 已退出、备份并校验本地、删除 artifact、清理 blocked/ignore 状态，重启后再全量拉取。

## 配置

非敏感字段：

```yaml
serverUrl: ''            # 自部署服务端地址
deviceName: ''           # 设备短标签
syncSessionIds: []        # 显式选中的根会话 id；空数组 = 不同步任何会话
autoSync: true
intervalMs: 60000
includeSubagents: true
batchEvents: 50
batchBytes: 262144
requestTimeoutMs: 10000  # 单次 HTTP 读取超时；避免挂死
debug: false             # 开发控制台：额外发插件日志
devLogUrl: ''            # 例如 http://127.0.0.1:3092/api/log/a
```

token 与同步口令写在 DSH 凭据库，引用名固定：

- `DSH_SESSION_CLOUDSYNC_TOKEN`
- `DSH_SESSION_CLOUDSYNC_PASSPHRASE`

YAML 里的 `token` / `passphrase` 只作为 bootstrap fallback；插件每轮同步前重新解析凭据。

开发控制台（`pnpm dev:panel`）会用以下环境变量覆盖上述配置，优先级高于 YAML 和
DSH 凭据库：`DSH_SESSION_CLOUDSYNC_SERVER_URL`、`..._TOKEN`、`..._PASSPHRASE`、
`..._DEVICE_NAME`。请不要在生产实例里设置这些变量。

## 客户端

浏览器半边在 `client/index.js`，通过 `dsh.client` 清单加载：

- `plugins.bundle.config`：Plugins 页的会话同步设置（连接/凭据/工作区/行为）；
- `shell.overlay`：首启向导、顶部气泡和远端覆盖本地脚本说明；
- `conversation.input.dock`：composer 同步守卫；
- `sidebar.session.row.leading` / `.hover`：同步标记与原因；
- document 捕获阶段拦截 `[data-row-key^="session:"]` 的 click/pointerdown/keydown。

## 开发

```sh
pnpm test
pnpm typecheck
node packages/plugin/scripts/build.mjs
```

协议、设计、安全边界分别见 [`docs/architecture/PROTOCOL.md`](../../docs/architecture/PROTOCOL.md)、[`docs/architecture/DESIGN.md`](../../docs/architecture/DESIGN.md)、[`docs/sync/SYNC-SAFETY.md`](../../docs/sync/SYNC-SAFETY.md)。
