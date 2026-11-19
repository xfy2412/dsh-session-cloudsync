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

- 服务端为 v0.1.0 v2-only；控制台用 `/health` 探活，并在服务端面板显示
  protocol 与 `batch-upload` / `batch-download` / `zstd-frame` 能力；
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
- 插件默认不勾选任何会话，导入后需要在 DSH 的同步设置里显式勾选它才会上传；
- 两边都勾选会得到两份相同会话 id 的本地副本，**不会制造 A→B 的同步差异**；
  测 A 推 B 拉时只勾 A；
- 轨迹可用 `pnpm bench:trace -- <真实日志> --out <trace>` 重新提取，或用
  `DEV_CONSOLE_TRACE=<trace>` 指向另一份轨迹。

导入后可以在 DSH 侧栏打开 `Benchmark 69k`，这就是形状基准会话。

## 本地假模型

面板默认在 `127.0.0.1:8790` 起一个**假模型服务**（`DEV_CONSOLE_FAKE_AI_PORT` 可改），并把
A/B 的模型指向它：

```text
DEEPSEEK_BASE_URL=http://127.0.0.1:8790
DEEPSEEK_API_KEY=sk-local-dev-fake
```

这样在 DSH 里发消息不会调用真实模型、不花额度，适合调 UI、同步和工具调用。想用真实模型：

```sh
DEV_CONSOLE_FAKE_AI=off pnpm dev:panel
```

假模型模式还会给 A/B 加一个 dev overlay：禁用 `llm-deepseek-account`（账号路由），把
`agent-default-model` 钉到 `deepseek-official / deepseek-flash`。原因：账号路由不保证走
`DEEPSEEK_BASE_URL`，且它的 reasoning effort 能力在未登录/未取到目录时可能直接报
`does not support reasoning effort`。因此假模型下请在模型选择里用 `deepseek-official`；
之前保存过账号路由选择的老会话需要重新选模型或新开会话。

假服务实现的是 DSH `dsh-llm-deepseek` 使用的 **Anthropic Messages** 协议
（`POST /v1/messages` 的 SSE 事件）；`/v1/models` 返回固定的 `deepseek-flash`，
`/v1/files` 返回 400，图片请求会由 DSH 自动退回 inline。会话标题请求（系统提示是
“Create a concise title…”）固定回 `Dev 会话`；不做 thinking / 图片 / 压缩语义。

顶部 **假模型** 按钮打开面板：

- 显示服务地址、已处理请求数；
- 最近请求列表：模型、最后一条用户文本、是否带 `<device-change>`、是否带 `tool_result`、
  调用到的工具、以及假服务给出的回复；
- 规则编辑框（JSON，按顺序匹配，第一条命中生效），可应用、恢复默认、清空记录。

`when` 支持：`contains`（任意用户文本包含）、`systemContains`（system 提示包含）、
`lastUserContains`（最后一条用户文本包含）、`hasToolResult`（历史里出现过工具结果）、
`lastMessageIsToolResult`（最后一条消息本身就是工具续跑）。默认规则用
`lastMessageIsToolResult`，避免历史里带过工具结果后每条新消息都被当成工具续跑。

规则格式：

```jsonc
[
  {
    "name": "env-tool",
    "when": { "lastUserContains": "/env" },   // 还可 contains、hasToolResult
    "reply": { "tool": { "name": "get_env", "input": {} } }
  },
  {
    "name": "device-change",
    "when": { "contains": "<device-change" },
    "reply": { "text": "已收到设备切换提示。" }
  }
]
```

`reply.text` 支持 `{{user}}`、`{{tool}}`、`{{count}}` 占位；没有规则命中时回显
`收到：<最后一条用户文本>`。默认规则见 `dev/console/fake-ai.mjs` 的 `defaultRules()`。

用它验证插件行为：

- 在 DSH 里发 `/env` → 模型发起 `get_env` 工具调用 → 工具结果回来后再发一轮；
- 面板的请求列表里 `含 device-change` 为 true，说明插件的 `<device-change>` 提示确实进入了模型请求；
- 规则改成 `tool: {"name": "get_env"}` 之类可以手动驱动任意工具调用。

### 不打开浏览器，直接发消息

`dev/console/send-message.mjs` 走 Web 客户端同一套 Remote API：

```sh
node dev/console/send-message.mjs --side a --text "/env"
node dev/console/send-message.mjs --side a --text "你好" --session "Benchmark 69k"
```

流程：从面板状态取 A/B 的入口 URL → `GET /connect?token=…` 换 API Cookie →
`session/list` 找会话 → `session/selectModel` 选 `deepseek-official/deepseek-flash` →
`session/prompt` 投递。默认等假模型新增请求并打印；`--no-wait` 只投递，
`--timeout` 改等待上限。显式选 `official` 是为了绕过老会话里保存的
`deepseek-account` 选择（假模式下该路由已被 dev overlay 禁用）。

## 测试跨设备插件版本

A/B 可以在准备时额外安装 registry bundle，用来制造版本差异：

```powershell
$env:DEV_CONSOLE_EXTRA_A='dsh-plugin-release-probe@0.0.2'
$env:DEV_CONSOLE_EXTRA_B='dsh-plugin-release-probe@0.0.8'
pnpm dev:panel
```

- 变量按侧读取：`DEV_CONSOLE_EXTRA_A` / `DEV_CONSOLE_EXTRA_B`，逗号分隔多个 `pkg@version`；
- `dsh-plugin-release-probe` 是发布在 npm 上的空壳 bundle（`0.0.2`–`0.0.8`），
  只插入一条空插件，适合做版本对齐测试；
- 准备完成后 A/B 的插件列表会不同；打开同步设置里的「跨设备插件」即可看到差异。

## 服务端初始化密钥

顶部“同步服务端”徽标可点击，打开服务端面板：

- 未初始化时显示本地 `http://127.0.0.1:8787/admin` 的初始化密钥，可复制；
- 密钥 10 分钟有效；过期后点“重启服务端”重新生成（保留同步数据）；
- 初始化完成后面板隐藏密钥，直接打开管理台用密码登录；
- 密钥同时写在 `.tmp/dev-console/sync-data/onboarding-code.json`（0600），
  初始化完成会删除。

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
