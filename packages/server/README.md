# dscs-server

DSH Session CloudSync 的自部署服务端。

当前发布版本：**0.1.5**（协议版本 3，设备 API 只有 `/v2/*`；数据库结构版本 6）。

## 能做什么

- **多设备接续**：把 DSH 会话同步到自己的服务器，在另一台设备继续；
- **私有部署**：数据留在自己的机器或 NAS，不经过第三方；
- **端到端加密**：服务端只保存不透明密文和同步所需的基本信息，看不到会话内容；
- **弱网可用**：断点续传、批量传输、加密前压缩，网络恢复后继续；
- **附件通道**：加密附件（图片/文件）与按批次的附件索引有独立的 blob 类型，会话移除时一并释放；插件侧接入后生效；
- **不会互相覆盖**：同一时间只允许一台设备上传，避免多端同时写乱；
- **设备管理**：签发/改名/吊销设备，查看最后在线时间，为设备设置颜色；
- **会话管理**：存档、移除并释放空间、重置后重新上传、恢复存档；
- **审计**：记录登录、设备、配额、密码和会话管理动作，不记录内容或密钥；
- **历史与活动**：查看单个会话的变更时间线，以及全局的每日同步强度热力图。

## 安装

### 一键安装（推荐）

Linux / macOS：

```sh
curl -fsSL https://raw.githubusercontent.com/xfy2412/dsh-session-cloudsync/main/scripts/install.sh -o install.sh
less install.sh   # 建议先看一眼脚本
sh install.sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/xfy2412/dsh-session-cloudsync/main/scripts/install.ps1 -OutFile install.ps1
notepad install.ps1   # 建议先看一眼脚本
.\install.ps1
```

安装脚本会把版本装到独立目录，并可选注册 systemd 或计划任务；支持
`--version`、`--upgrade`、`--uninstall`、`--purge` 等参数。

### 手动安装

```sh
npm i -g dscs-server
dscs-server serve --data-dir /var/lib/dscs --host 127.0.0.1 --port 8787
```

首次启动会在控制台打印一次性初始化密钥，同时写入数据目录的 `onboarding-code.json`。
打开 `http://127.0.0.1:8787/admin` 完成管理密码、配额和设备初始化。

## CLI

```sh
dscs-server serve --data-dir /var/lib/dscs --host 127.0.0.1 --port 8787
dscs-server token add laptop
dscs-server token list
dscs-server token revoke <deviceId>
dscs-server admin status
dscs-server admin reset-password --data-dir /var/lib/dscs
printf '%s' "$NEW_PASSWORD" | dscs-server admin reset-password --data-dir /var/lib/dscs --stdin
```

`admin reset-password` 默认生成并打印一次随机密码；`--stdin` 读取自定义密码。
重置后需重启 server 让旧管理会话失效；在管理台修改密码会立即失效其它会话。

## 要求与迁移

- Node.js >= 24；
- 默认只监听 `127.0.0.1`，公网部署请放在 TLS 反代后；
- 数据目录包含 SQLite、blob 文件与迁移备份，升级前请先备份；
- 数据库结构版本 6，支持从旧版本自动迁移，迁移前会写本地备份；
- 0.1.5 不迁移数据库，可直接回滚；旧插件不受影响（附件功能按 `/health` 的 `attachment-index` capability 门控）；
- 旧的变更流接口已移除；0.1.0 插件不兼容，需要插件 >= 0.1.1；
- 服务端不持有明文会话内容，只存不透明密文和同步元数据；
- 已有未压缩会话不会自动压缩；需要清空数据目录后由插件全量重传；
- 协议说明见 `docs/architecture/PROTOCOL.md`，错误分类见 `docs/architecture/ERRORS.md`。

## 许可证

AGPL-3.0-only。
