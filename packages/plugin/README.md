# dsh-session-cloudsync

DSH 会话云同步插件：自部署服务端、端到端加密，同步根会话与子代理闭包。

## 能力

- 事件批次增量推送/拉取；批次哈希、AES-256-GCM 封批次；
- 服务端只存密文、manifest 与 blob 去重，不持有明文口令；
- 开放尾只备份、不直接 apply；拉取带 durable pending journal；
- 根会话选择：默认同步全部根会话；本地排除的根及其子代理跳过；子代理跟随根会话闭包，fork 是独立根；
- 工作区映射：未映射会话持久化、映射后按 cursor revision 回填；本地工作区自己的 key 自动解析；已有远端会话沿用原 key；绑定前二次确认；
- Plugins 页自定义设置页 + 首启向导 + 顶部同步气泡；
- 状态 v2：每个会话只有一行（push/pull 作为两个方向子状态），每行带待上传/待下载事件数、已完成/总数与 `statusVersion`；
- 气泡标题优先 durable title，空白会话显示“未命名会话”，不再把 cwd 目录名当标题；
- **设备独占租约**：本机已经 live 的会话持续续租（20s 续租、服务端 TTL 60s），其他设备 append 得到 `lease-held`；进程正常退出主动释放，异常退出靠 TTL；
- 冷会话在同步中/开放尾/安全边界落后时，侧栏行会被拦截并显示原因；live 会话允许打开/切换，由 composer 拦截输入；
- “接受远端”只生成停机脚本：检查 DSH 已退出、备份并校验本地、删除 artifact、清理 blocked/ignore 状态，重启后再全量拉取。

## 配置

非敏感字段：

```yaml
serverUrl: ''            # 自部署服务端地址
deviceName: ''           # 设备短标签
excludedSessionIds: []   # 本地排除的根会话 id；子代理跟随根
autoSync: true
intervalMs: 60000
includeSubagents: true
batchEvents: 50
batchBytes: 262144
requestTimeoutMs: 10000  # 单次 HTTP 读取超时；避免挂死
```

token 与同步口令写在 DSH 凭据库，引用名固定：

- `DSH_SESSION_CLOUDSYNC_TOKEN`
- `DSH_SESSION_CLOUDSYNC_PASSPHRASE`

YAML 里的 `token` / `passphrase` 只作为 bootstrap fallback；插件每轮同步前重新解析凭据。

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

协议、设计、安全边界分别见 `docs/PROTOCOL.md`、`docs/DESIGN.md`、`docs/SYNC-SAFETY.md`。
