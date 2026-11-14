<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="dsh-session-cloudsync" width="96">
  </picture>
</p>

<p align="center">
  <a href="LICENSES/AGPL-3.0-only.txt"><img src="https://img.shields.io/badge/server-AGPL--3.0-blue.svg" alt="server: AGPL-3.0"></a>
  <a href="LICENSES/MIT.txt"><img src="https://img.shields.io/badge/plugin%20%2F%20shared-MIT-green.svg" alt="plugin/shared: MIT"></a>
  <a href="https://www.npmjs.com/package/dsh-session-cloudsync"><img src="https://img.shields.io/npm/v/dsh-session-cloudsync.svg" alt="npm"></a>
</p>

# dsh-session-cloudsync

给 DeepSeek Harness（DSH）的**会话云同步**：自部署服务端、端到端加密，多台设备共用同一份会话。

> **状态：可用（0.1.4）。** 整轮同步、单会话推送、底部会话状态条、上传范围开关、Vault
> 设备台账与工作区映射均可使用；附件同步已在 0.1.5 实现（需服务端 0.1.5+，单附件上限 32 MiB），
> 见 [ROADMAP](docs/plans/ROADMAP.md)。

## 它能做什么

- **多设备同一份会话**：一台机器写，另一台接着继续，不用手动搬文件；
- **端到端加密**：服务端只存密文、清单与去重后的 blob，不持有明文口令；
- **按会话增量**：只传新增事件；上传范围可选，默认可只同步你在意的会话；
- **单会话推送**：底栏一键把当前会话推上去，不必等整轮；
- **看得见的状态**：顶部气泡看整轮进度，底部状态条看当前会话与远端的差；
- **工作区映射**：不同机器的路径可以映射到同一份远端工作区（Vault）；
- **全局单写者**：同一时间只允许一台设备写，其余设备只拉取，避免互相覆盖。

## 安装

### 插件

```sh
dsh plugin --profile web add dsh-session-cloudsync
```

要求 DSH `>=0.2.1-rc.1 <0.3.0-0`（`0.2.2-rc.1` 已实测）。

### 服务端（自部署）

要求 Node.js >= 24。服务端是零运行时依赖的 `node:http` + `node:sqlite` 单进程，数据放在一个目录里。

**方式一：全局安装**

```sh
npm i -g dscs-server
dscs-server serve --data-dir /var/lib/dscs --host 127.0.0.1 --port 8787
```

**方式二：安装脚本**（装进独立目录并软链`current`路径，可选注册 systemd / 计划任务）

```sh
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/xfy2412/dsh-session-cloudsync/main/scripts/install.sh | bash -s --
# 带参数示例：--host 0.0.0.0 --port 8787 --user dscs
```

```powershell
# Windows
irm https://raw.githubusercontent.com/xfy2412/dsh-session-cloudsync/main/scripts/install.ps1 -OutFile install.ps1
.\install.ps1
```

脚本支持 `--version`、`--upgrade`、`--uninstall`、`--purge` 等，详见 `scripts/install.sh --help`。

**首次启动**会打印一次性初始化密钥，并提示打开 <http://127.0.0.1:8787/admin>；同时写入数据目录的
`onboarding-code.json`（0600，初始化完成即删除）。按向导设置管理密码、存储配额，可选创建第一台设备。
之后管理台用密码登录；忘记密码执行 `dscs-server admin reset-password`
默认生成随机新密码并只打印一次，也支持 `--stdin` 从标准输入读取自定义密码；
重置后需重启 server 让旧管理会话失效。

默认只监听 `127.0.0.1`，公网部署请放在 TLS 反代后；数据目录含 SQLite 与 blob，升级前先备份。
服务端细节见 [packages/server/README.md](packages/server/README.md)。开发用 `pnpm dev:server` 起在
`.tmp/dev-data`，见下文「开发」。

## 快速开始

1. 部署服务端，按控制台提示完成初始化，记下设备 token；
2. DSH → 设置 → **会话云同步**：填服务端地址、设备 token、同步口令；
3. 勾选要同步的会话（默认一个都不选），保存；
4. 顶部气泡点「立即同步」，之后随时在底部状态条看当前会话与远端差多少。

所有设备必须使用**同一个同步口令**，服务端地址写法也要一致（没显式配置 `salt` 时，
盐由 `serverUrl` 派生，混用 `localhost` / `127.0.0.1` 或省略 `//` 会派生出不同的密钥）。
口令、地址或 `salt` 任一不同，拉取都会报 `封帧的 keyId 与当前密钥不符`。

界面细节与常见状态处理见 [docs/guides/OPERATIONS.md](docs/guides/OPERATIONS.md)。

## 目录结构

```
packages/shared/   帧处理（多帧 zstd）、端到端加密、线上类型；插件与服务端共用
packages/plugin/   DSH 宿主插件（npm 包 dsh-session-cloudsync）
packages/server/   自部署服务端：node:http + node:sqlite + blob 目录，零运行时依赖
tests/             临时 DSH home 的硬约束与夹具（见 tests/README.md）
dev/               开发控制台与界面原型
docs/
  architecture/    协议、封帧、cwd 与整体设计
  sync/            Vault、安全、对账、性能与配置快照
  ui/              界面约定与状态模型
  guides/          操作指引、术语、提示与使用协议
  plans/           里程碑与决策记录
```

## 开发

```sh
pnpm install
pnpm test                 # 全部测试（含跨包集成）
pnpm typecheck
pnpm check                # 全部 typecheck + test
pnpm run check:server     # 服务端/shared：服务端发布门禁
pnpm run check:plugin     # 插件/shared：插件发布门禁（不含跨包集成）
pnpm run test:integration # 插件↔服务端跨包集成；不阻塞任一发布
pnpm fixtures             # 重新生成夹具的 .zstd 兄弟文件
pnpm dev:server           # 在 .tmp/dev-data 起服务端（127.0.0.1:8787）
pnpm dev:server admin status             # 透传服务端 CLI（默认同一数据目录）
pnpm dev:server reset-password [--stdin] # 重置开发管理密码
pnpm dev:dsh              # 起隔离的 DSH 开发实例（默认端口 3090）
pnpm dev:panel            # 双实例开发面板（默认 http://127.0.0.1:3092）
pnpm dev:console          # 起 M0 控制台（127.0.0.1:3091，见 tests/m0/README.md）
```

夹具由官方 `@deepseek-ai/dsh-session` 校验器验证（`packages/shared` 的 devDependencies，
版本与 DSH 对齐）。

### 隔离的 DSH 开发实例

`pnpm dev:dsh` 在 `.tmp/` 下创建临时 home，不碰真实 `~/.dsh`；需要保留已登录状态时：
`node scripts/dev-dsh.mjs --credentials <旧 home 的 .credentials.yaml>`。
脚本拒绝在 `.tmp/` 之外创建实例目录。

双实例调试用 `pnpm dev:panel`：起一个本地控制台（默认 <http://127.0.0.1:3092/>），
上方左右两个 iframe 分别是独立的 DSH A/B，下方左右两个控制台显示各自 host stdout
与插件 dev sink。首次启动会自动构建并安装本插件、带起本地同步服务端并给 A/B
预配置 token/口令；面板还提供 **导入大会话**（形状轨迹生成，约 69k 事件）、
**恢复预配置** 和勾选式 **清理数据**。配置快照与选择模型见
[docs/sync/CONFIG-SNAPSHOT.md](docs/sync/CONFIG-SNAPSHOT.md)，详见
[dev/console/README.md](dev/console/README.md)。

## 两条硬约定

- **测试绝不碰真实 `~/.dsh`**：所有临时 home 经 `tests/helpers/tmp-home.mjs` 创建，位于 `.tmp/` 且被 git 忽略；规则与断言清单见 [tests/README.md](tests/README.md)。
- **仓库文档写我们的选择与中性事实**，不评价其他项目。

## 文档

- [docs/README.md](docs/README.md)：完整文档索引（架构 / 同步 / 界面 / 计划 / 指南）。
- [docs/guides/OPERATIONS.md](docs/guides/OPERATIONS.md)：界面与操作指引（四块界面、状态语义、常见处理）。
- [docs/architecture/DESIGN.md](docs/architecture/DESIGN.md)：整体设计、拉取落地、写入路径与分叉处理。
- [docs/architecture/PROTOCOL.md](docs/architecture/PROTOCOL.md)：设备 API 与插件本地接口。
- [docs/sync/VAULT.md](docs/sync/VAULT.md)：设备台账、workspace/profile 与一次性映射。
- [docs/sync/SYNC-SAFETY.md](docs/sync/SYNC-SAFETY.md)：开放尾、apply journal、阻塞与恢复。
- [dev/ui/README.md](dev/ui/README.md)：设置页 / 首启 / 同步气泡的静态原型。
- [tests/README.md](tests/README.md)：临时 home 与夹具约定。

## 支持版本

DSH `>=0.2.1-rc.1 <0.3.0-0`（`0.2.2-rc.1` 已实测）。0.2.1 之前缺少本插件依赖的能力
（如 `appendPluginRecord`），不做兼容。服务端与插件按各自版本独立发布，配套关系见
[ROADMAP](docs/plans/ROADMAP.md)。

## 许可证

本仓库按目录拆分许可：

- **`packages/server/**`：AGPL-3.0-only**（[全文](LICENSES/AGPL-3.0-only.txt)）。对外提供修改后的服务端时，需按 AGPL §13 向使用者提供对应源码；个人自部署、仅自己使用不受影响。
- **`packages/plugin/**`、`packages/shared/**` 及其余部分：MIT**（[全文](LICENSES/MIT.txt)）。

根目录的 [LICENSE](LICENSE) 是拆分范围的简短说明；各 package 目录下也各有一份对应全文。
