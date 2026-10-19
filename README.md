# dsh-session-sync

给 DeepSeek Harness（DSH）做的**会话云同步**：自部署服务端、端到端加密，同步会话、附件、设备台账与 agent 笔记。

> **状态：脚手架**。`packages/shared` 的帧工具与加密原语、`packages/server` 的健康检查与设备 token、`packages/plugin` 的加载骨架已经可跑；同步引擎与 M0 实验尚未开始。

## 支持版本

DSH `>=0.2.1-rc.1 <0.2.2-0`。0.2.1 之前缺少本插件依赖的能力（如 `appendPluginRecord`），不做兼容。

## 目录

```
packages/shared/   帧处理（多帧 zstd）、端到端加密、线上类型；插件与服务端共用
packages/plugin/   DSH 宿主插件（install_bundle 的目标目录）
packages/server/   自部署服务端：node:http + node:sqlite + blob 目录，零运行时依赖
tests/             临时 DSH home 的硬约束与夹具（见 tests/README.md）
docs/              设计、协议
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

**首次启动服务端**：控制台会打印一次性初始化密钥，并提示打开 <http://127.0.0.1:8787/admin>；按向导设置管理密码、存储配额，可选创建第一台设备。之后管理台用密码登录；忘记密码执行 `node packages/server/src/index.ts admin reset`（重启后重新打印初始化密钥）。

### 隔离的 DSH 开发实例

`pnpm dev:dsh` 会：

- 把 `DSH_HOME` 指到 `.tmp/dev-dsh/home`；
- 用 `--patch` 覆盖 `workspace-controller` 的 `documentsDirectory`，让**默认工作区**落在 `.tmp/dev-dsh/documents/`（否则 DSH 会建到系统 Documents 下）；
- 清掉从当前会话继承的 `DSH_*` 变量，避免新实例误以为自己在嵌套运行。

需要保留已登录状态时：`node scripts/dev-dsh.mjs --credentials <旧 home 的 .credentials.yaml>`。脚本拒绝在 `.tmp/` 之外创建实例目录。

## 两条硬约定

- **测试绝不碰真实 `~/.dsh`**：所有临时 home 经 `tests/helpers/tmp-home.mjs` 创建，位于 `.tmp/` 且被 git 忽略；规则与断言清单见 [tests/README.md](tests/README.md)。
- **仓库文档写我们的选择与中性事实**，不评价其他项目。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md)：范围、数据分层、并发与加密的取舍。
- [docs/PROTOCOL.md](docs/PROTOCOL.md)：服务端端点与不变量。
- [tests/README.md](tests/README.md)：临时 home 与夹具约定。
