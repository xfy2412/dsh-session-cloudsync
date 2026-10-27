# dscs-server

DSH Session CloudSync 的自部署服务端。

当前版本：**0.1.0，v2-only**（`PROTOCOL_VERSION = 3`）。设备 API 只有 `/v2/*`，
旧的 `/v1/*` 已移除；0.0.x 插件不兼容，需要配套的 0.1.0 插件。

## 能力

- `/v2/sessions` 全量快照、`/v2/changes` 增量流；
- 会话摘要、ETag、批次条件分页；
- 带 `Idempotency-Key` 的 append；
- `POST /v2/blobs/batch` / `POST /v2/blobs/batch/read` 批量 blob（8 MiB / 64 条）；
- zstd 封帧（加密前压缩）与服务端压缩状态聚合；
- Vault 租约、append、cursor、stream。

## 安装

```sh
npm i -g dscs-server
dscs-server serve --data-dir /var/lib/dscs --host 127.0.0.1 --port 8787
```

首次启动会在控制台打印一次性初始化密钥，同时写入数据目录的 `onboarding-code.json`。打开 `http://127.0.0.1:8787/admin` 完成管理密码、配额和设备初始化。

Linux/macOS 也可以使用仓库的 `scripts/install.sh`；Windows 使用 `scripts/install.ps1`。安装脚本会把版本装到独立目录，并可选注册 systemd 或计划任务。

## 要求

- Node.js >= 24；
- 默认只监听 `127.0.0.1`，公网部署请放在 TLS 反代后；
- 数据目录包含 SQLite 与 blob 文件，升级前请备份；
- 服务端不持有明文会话内容，只存不透明密文；
- 0.0.1 数据目录升级到 0.1.0 会迁移到 schema 4，但旧插件仍会 404；
- 已有未压缩会话不会自动压缩；需要清空数据目录后由 0.1.0 插件全量重传；
- 协议说明见仓库 `docs/architecture/PROTOCOL.md`。

## 许可证

AGPL-3.0-only。
