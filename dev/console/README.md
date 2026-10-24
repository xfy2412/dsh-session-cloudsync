# DSH 双实例开发控制台

一个零依赖的本地开发面板：

```text
┌─────────────────────────────┬─────────────────────────────┐
│ iframe A：DSH 实例 A        │ iframe B：DSH 实例 B        │
├─────────────────────────────┼─────────────────────────────┤
│ 控制台 A：stdout + dev sink │ 控制台 B：stdout + dev sink │
└─────────────────────────────┴─────────────────────────────┘
```

- A/B 各自使用独立的 `DSH_HOME`（`.tmp/dev-console/a|b/home`）和端口（3090/3091）；
- 启动时自动构建并安装本仓库的 `packages/plugin` 到两个临时 profile；
- 两个实例的 `stdout/stderr` 直接进入下方面板；
- 插件在 `debug` / `devLogUrl`（或环境变量 `DSH_SESSION_CLOUDSYNC_DEV_LOG`）下
  把 `ctx.logger` 的结构化日志 POST 到对应面板。

## 预配置同步服务端

默认由控制台一并启动一个**本地同步服务端**，A/B 启动时自动配置：

```text
URL          http://127.0.0.1:8787
数据目录     .tmp/dev-console/sync-data
凭据文件     .tmp/dev-console/sync-credentials.json（0600）
```

- 首次准备时用服务端 CLI 给 A/B 各签发一个设备 token；
- 生成一个 A/B 共享的随机同步口令；
- 在启动 A/B 时通过环境变量注入：

```text
DSH_SESSION_CLOUDSYNC_SERVER_URL
DSH_SESSION_CLOUDSYNC_TOKEN
DSH_SESSION_CLOUDSYNC_PASSPHRASE
DSH_SESSION_CLOUDSYNC_DEVICE_NAME
```

这些覆盖值优先于 profile 配置/凭据库，所以不需要手工改 `cordis.patch.yml`，
也不会把 token/passphrase 写进 DSH profile。

覆盖默认值：

```sh
DEV_CONSOLE_SYNC_PORT=8787 pnpm dev:panel
```

指向一个已有服务端（不启动本地 server）：

```sh
DEV_CONSOLE_SYNC_SERVER=https://sync.example.com \
DEV_CONSOLE_SYNC_TOKEN_A=... \
DEV_CONSOLE_SYNC_TOKEN_B=... \
DEV_CONSOLE_SYNC_PASSPHRASE=... \
pnpm dev:panel
```

关闭自动配置（A/B 保持插件的原有配置）：

```sh
DEV_CONSOLE_SYNC=off pnpm dev:panel
```

外部模式必须同时提供 A/B token 和 passphrase；缺少时控制台会在状态里报错，不会启动实例。

## 导入大会话

面板顶部有 **导入大会话**：

- 默认勾选 **DSH A**，把 `tests/fixtures/shapes/b0e-69587.trace.json` 生成的
  约 69,587 事件 / 52 MB 合成会话导入 A 的默认工作区；
- 导入会停止正在运行的实例、写会话 artifact 和 `workspace.json`，然后重启；
- 会话正文是合成占位文本，不含真实内容；导入后侧栏显示 `Benchmark 69k`，可正常加载历史；
- 两边都勾选会得到两份相同会话 id 的本地副本，**不会制造 A→B 的同步差异**；
  测 A 推 B 拉时只勾 A；
- 轨迹可用 `pnpm bench:trace -- <真实日志> --out <trace>` 重新提取，或用
  `DEV_CONSOLE_TRACE=<trace>` 指向另一份轨迹。

导入后可以在 DSH 侧栏打开 `Benchmark 69k`，这就是形状基准会话。

## 恢复预配置 / 清理数据

- **恢复预配置**：重新确认同步服务端与凭据，并重启当前正在运行的 A/B，让环境值重新注入。
  未运行的实例会在下次启动时生效。
- **清理数据**：打开勾选窗口，可分别清理：
  - DSH A / DSH B：删除对应 `.tmp/dev-console/a|b`（home、文档、会话、插件安装状态）；
  - 同步服务端：停止本地 server，删除 `sync-data` 与 `sync-credentials.json`；
    A/B 会先停止，下次准备时重新签发 token/passphrase。
  清理只允许发生在 `.tmp/dev-console/` 内。

注意：清理服务端会丢失本地开发服务端里的会话数据；如果只想重置客户端配置，
不要勾选服务端。

## 启动

```sh
pnpm dev:panel
# 打开 http://127.0.0.1:3092/
```

登录态默认不会复制。两套实例需要登录时：

```sh
DEV_CONSOLE_CREDENTIALS="$HOME/.dsh/.credentials.yaml" pnpm dev:panel
```

Windows PowerShell：

```powershell
$env:DEV_CONSOLE_CREDENTIALS="$HOME\.dsh\.credentials.yaml"
pnpm dev:panel
```

端口可用 `DEV_CONSOLE_PORT` 覆盖（只影响控制台本身；A/B 默认 3090/3091，
也可用 `DEV_CONSOLE_A_PORT` / `DEV_CONSOLE_B_PORT` 覆盖）。

## 使用顺序

1. 打开页面，点 **准备两套**：首次会启动本地同步服务端、签发 A/B token/passphrase，
   并构建安装 `dsh-session-cloudsync`；输出会进入对应控制台。
2. 点 **启动两套**：左侧 iframe 显示 A，右侧显示 B；URL 带 host token，由启动日志解析。
3. A/B 已预配置为连同一个同步服务端，不需要在 DSH 里手填；左下/右下显示宿主和插件日志。
4. **停止两套** 同时停掉两个进程树；页面上的 iframe 会回到等待状态。
5. 如果改过设置/环境，点 **恢复预配置** 重新注入并重启正在运行的实例。

单侧按钮可以只准备/启动/停止一侧；“刷新页面”只重载对应 iframe。

## 插件 dev sink

插件的配置项：

```yaml
debug: true
devLogUrl: http://127.0.0.1:3092/api/log/a
```

控制台启动 A/B 时会通过环境变量自动注入对应地址：

```text
DSH_SESSION_CLOUDSYNC_DEV_LOG=http://127.0.0.1:3092/api/log/a
DSH_SESSION_CLOUDSYNC_DEV_LOG=http://127.0.0.1:3092/api/log/b
```

所以临时实例不需要手写 `cordis.patch.yml`。插件日志是异步、有界、失败静默的；
控制台没开时不会拖慢同步。

## 日志接收 API

任意插件或脚本都可以向控制台写日志：

```sh
curl -X POST http://127.0.0.1:3092/api/log/a \
  -H 'content-type: application/json' \
  -d '{"source":"my-plugin","level":"info","message":"hello"}'
```

也支持批量：

```json
{ "entries": [
  { "level": "info", "source": "my-plugin", "message": "one" },
  { "level": "warn", "source": "my-plugin", "message": "two" }
] }
```

## 限制

- 只绑定 `127.0.0.1`，没有鉴权；不要暴露到局域网/公网。
- 启动/安装会执行本仓库固定路径的脚本，不接受任意命令。
- 两套实例共用同一份登录态文件（如果显式传入），但 DSH_HOME、会话和工作区各自独立。
- 插件安装使用当前 PATH 上的 `dsh` 与 `pnpm`；找不到时控制台会显示失败原因。
