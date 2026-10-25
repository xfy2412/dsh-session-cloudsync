<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="dsh-session-cloudsync" width="96">
  </picture>
</p>

<p align="center">
  <a href="LICENSES/AGPL-3.0-only.txt"><img src="https://img.shields.io/badge/server-AGPL--3.0-blue.svg" alt="server: AGPL-3.0"></a>
  <a href="LICENSES/MIT.txt"><img src="https://img.shields.io/badge/plugin%20%2F%20shared-MIT-green.svg" alt="plugin/shared: MIT"></a>
</p>

# dsh-session-cloudsync

给 DeepSeek Harness（DSH）做的**会话云同步**：自部署服务端、端到端加密，同步会话与附件；设备台账、agent 笔记与多工作区映射见 [docs/sync/VAULT.md](docs/sync/VAULT.md)（V0–V2.1 已实现）。

> **状态：M1/M2 已完成，M3 已完成，M4 进行中。** 帧工具/加密、服务端（含管理台与初始化）、M0 免重启 ingest 已经可跑；M3 的推送/拉取、安全边界、双 home E2E、durable journal 与错误退避已通过。M4 已完成 A1–A5、B1–B5（凭据、设置页、首启向导）、C1–C4/C6（composer block、列表拦截、行标记、同步气泡、入口守卫、全局单写者租约）与 E1（`batches` 规范字段）；C5 GUI 回归、D5 故障文案演练与 E3 文档收口顺延到 Vault 之后。Vault V0–V2.1 已完成（本地记录链、服务端 Vault、writer 租约、设备台账、workspaceKey 一次性映射、根会话级同步选择与 label 映射），V3/V4 见 [docs/sync/VAULT.md](docs/sync/VAULT.md)。

## 支持版本

DSH `>=0.2.1-rc.1 <0.2.2-0`。0.2.1 之前缺少本插件依赖的能力（如 `appendPluginRecord`），不做兼容。

## 安装

npm 包名：`dsh-session-cloudsync`。

```sh
dsh plugin --profile web add dsh-session-cloudsync
```

## 多设备密钥

所有设备必须使用**同一个同步口令**。主密钥由 `scrypt(口令, salt)` 派生；没有显式配置 `salt` 时，盐由 `serverUrl` 派生，所以各设备的服务端地址写法也要一致（建议统一使用 `http://host:port`，不要混用 `localhost` / `127.0.0.1` 或省略 `//`）。设备 token 只用于服务端鉴权，不参与解密。

口令、默认盐或显式 `salt` 任一不一致，拉取都会报：

```text
封帧的 keyId 与当前密钥不符
```

这意味着该设备派生出的会话密钥与远端封帧不一致，当前无法解密；需要先统一口令/地址/salt。

## 目录

```
packages/shared/   帧处理（多帧 zstd）、端到端加密、线上类型；插件与服务端共用
packages/plugin/   DSH 宿主插件（install_bundle 的目标目录）
packages/server/   自部署服务端：node:http + node:sqlite + blob 目录，零运行时依赖
tests/             临时 DSH home 的硬约束与夹具（见 tests/README.md）
docs/
  architecture/    协议、封帧、cwd 与整体设计
  sync/            Vault、安全、对账、性能与配置快照
  ui/              界面约定与同步列表状态
  plans/           里程碑与决策记录
  guides/          术语、提示与使用协议
```

## 开发

```sh
pnpm install
pnpm test           # node --test（.ts 由 Node 24 直接运行）
pnpm typecheck
pnpm check          # typecheck + test
pnpm fixtures       # 重新生成夹具的 .zstd 兄弟文件
pnpm dev:server     # 在 .tmp/dev-data 起服务端（127.0.0.1:8787）
pnpm dev:dsh        # 起隔离的 DSH 开发实例（默认端口 3090）
pnpm dev:console    # 起 M0 控制台（127.0.0.1:3091，见 tests/m0/README.md）
```

夹具由官方 `@deepseek-ai/dsh-session` 校验器验证（`packages/shared` 的 devDependencies，版本与 DSH 对齐）。

**首次启动服务端**：控制台会打印一次性初始化密钥，并提示打开 <http://127.0.0.1:8787/admin>；开发控制台顶部“同步服务端”徽标也会显示/复制这个密钥（同时写入数据目录的 `onboarding-code.json`，0600，初始化完成即删除）。按向导设置管理密码、存储配额，可选创建第一台设备。之后管理台用密码登录；忘记密码执行 `node packages/server/src/index.ts admin reset`（重启后重新打印初始化密钥）。

### 隔离的 DSH 开发实例

`pnpm dev:dsh` 会：

- 把 `DSH_HOME` 指到 `.tmp/dev-dsh/home`；
- 用 `--patch` 覆盖 `workspace-controller` 的 `documentsDirectory`，让**默认工作区**落在 `.tmp/dev-dsh/documents/`（否则 DSH 会建到系统 Documents 下）；
- 清掉从当前会话继承的 `DSH_*` 变量，避免新实例误以为自己在嵌套运行。

需要保留已登录状态时：`node scripts/dev-dsh.mjs --credentials <旧 home 的 .credentials.yaml>`。脚本拒绝在 `.tmp/` 之外创建实例目录。

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

- [docs/README.md](docs/README.md)：完整文档索引（架构 / 同步 / 界面 / 计划 / 参考）。
- [docs/sync/SYNC-PERF-PLAN.md](docs/sync/SYNC-PERF-PLAN.md)：同步性能重构计划与实施记录。
- [docs/ui/SYNC-STATE.md](docs/ui/SYNC-STATE.md)：同步列表稳定性、stage、气泡动效与自动滚动。
- [dev/ui/README.md](dev/ui/README.md)：设置页 / 首启 / 同步气泡的静态原型。
- [dev/console/README.md](dev/console/README.md)：双实例 DSH 控制台（双 iframe + 双日志 + 插件 dev sink）。
- [tests/README.md](tests/README.md)：临时 home 与夹具约定。

## 许可证

本仓库按目录拆分许可：

- **`packages/server/**`：AGPL-3.0-only**（[全文](LICENSES/AGPL-3.0-only.txt)）。对外提供修改后的服务端时，需按 AGPL §13 向使用者提供对应源码；个人自部署、仅自己使用不受影响。
- **`packages/plugin/**`、`packages/shared/**` 及其余部分：MIT**（[全文](LICENSES/MIT.txt)）。

根目录的 [LICENSE](LICENSE) 是拆分范围的简短说明；各 package 目录下也各有一份对应全文。
